import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, keccak256, toHex, type Hex } from "viem";
import { GET_ORDER_ABI, ORDER_PAID_TOPIC, reconcileExecution, findNonceConsumer, type ReconcileRpc, type StoredExecution } from "../src/index.js";

const PAYER = "0x00000000000000000000000000000000000000aa" as Hex;
const MERCHANT = "0x0000000000000000000000000000000000000a11" as Hex;
const ORDER = (`0x${"33".repeat(32)}`) as Hex;
const OURS = (`0x${"44".repeat(32)}`) as Hex;
const OTHER = (`0x${"55".repeat(32)}`) as Hex;
const AMOUNT = 50_000_000_000_000_000n;
const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

type Chain = {
  receipts?: Record<string, any>; pool?: Set<string>; order?: { payer: string; amount: bigint; paid: boolean } | "unreadable";
  /** hashes whose receipt this (lagging) node does not serve although the block scan finds the transaction */
  receiptHidden?: Set<string>;
  /** the order state by block: `undefined` = latest (a lagging node may answer unpaid there while the read at the receipt's block says paid) */
  orderAt?: (blockNumber: bigint | undefined) => { payer: string; amount: bigint; paid: boolean };
  /** nonce → block in which the payer's transaction with that nonce was included (drives eth_getTransactionCount at a block) */
  consumed?: Record<number, { block: bigint; hash: Hex; to: Hex; paysOrder: boolean }>; head?: bigint; historyDepth?: bigint | null;
};
function fakeRpc(c: Chain) {
  const head = c.head ?? 1000n;
  // eth_getTransactionCount semantics: the payer's nonce AFTER block b — 7 before anything here is included, max(nonce)+1 afterwards
  const countAt = (b: bigint) => { const incl = Object.entries(c.consumed ?? {}).filter(([, t]) => t.block <= b).map(([n]) => Number(n)); return incl.length ? Math.max(...incl) + 1 : 7; };
  const sent: Hex[] = [];
  const rpc: ReconcileRpc = {
    getTransactionReceipt: vi.fn(async ({ hash }) => { if (c.receiptHidden?.has(hash.toLowerCase())) throw new Error("not found"); const r = c.receipts?.[hash.toLowerCase()]; if (r) return r; const t = Object.values(c.consumed ?? {}).find((x) => x.hash.toLowerCase() === hash.toLowerCase()); if (t) return { status: "success", blockNumber: t.block, logs: t.paysOrder ? [{ address: MERCHANT, topics: [ORDER_PAID_TOPIC, ORDER, topic(PAYER)], data: toHex(AMOUNT, { size: 32 }) }] : [] }; throw new Error("not found"); }),
    getTransaction: vi.fn(async ({ hash }) => (c.pool?.has(hash) ? { hash } : null)),
    getTransactionCount: vi.fn(async (a) => { if (a.blockNumber !== undefined) { if (c.historyDepth !== undefined && c.historyDepth !== null && a.blockNumber < head - c.historyDepth) throw new Error("missing trie node"); return countAt(a.blockNumber); } return countAt(head); }),
    readContract: vi.fn(async (a: any) => { if (c.order === "unreadable") throw new Error("rpc down"); const o = c.orderAt ? c.orderAt(a.blockNumber) : (c.order ?? { payer: PAYER, amount: AMOUNT, paid: false }); return [o.payer, o.amount, o.paid, 0n, 0n]; }),
    getBlock: vi.fn(async ({ blockNumber }) => ({ number: blockNumber, transactions: Object.entries(c.consumed ?? {}).filter(([, t]) => t.block === blockNumber).map(([n, t]) => ({ hash: t.hash, from: PAYER, to: t.to, nonce: Number(n) })) })),
    getBlockNumber: vi.fn(async () => head),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }) => { sent.push(serializedTransaction); return keccak256(serializedTransaction); }),
  };
  return { rpc, sent };
}
const stored = (over: Partial<StoredExecution> = {}): StoredExecution => ({ attemptId: "a1", state: "BROADCAST_ATTEMPTED", txHash: OURS, nonce: 7, payer: PAYER, merchant: MERCHANT, orderId: ORDER, amountNativeAtomic: AMOUNT.toString(),
  validUntil: new Date(Date.now() + 60_000).toISOString(), broadcastBlock: "900", openRaw: async () => "0x02f8aa" as Hex, ...over });
// unused import guard for the ABI re-export
void encodeFunctionResult; void GET_ORDER_ABI;

describe("shared business-transaction reconciliation (spec D07, design v3.2 §11)", () => {
  it("closes a transaction signed but never marked for broadcast as never sent", async () => {
    const { rpc, sent } = fakeRpc({});
    const r = await reconcileExecution(rpc, stored({ state: "SIGNED" }), { allowSend: true });
    expect(r).toMatchObject({ kind: "closed", storeState: "INTERRUPTED", outcome: { chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED" } });
    expect(sent).toHaveLength(0); expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("a receipt plus the order state at that block decides CONFIRMED/SUCCESS; receipt success alone is not business success", async () => {
    const ok = fakeRpc({ receipts: { [OURS]: { status: "success", blockNumber: 950n, logs: [] } }, order: { payer: PAYER, amount: AMOUNT, paid: true } });
    expect(await reconcileExecution(ok.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "closed", storeState: "CONFIRMED", outcome: { chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: OURS, block: "950", postcondition: { paid: true, block: "950", receiptStatus: "success" } } });
    const unpaid = fakeRpc({ receipts: { [OURS]: { status: "success", blockNumber: 950n, logs: [] } }, order: { payer: PAYER, amount: AMOUNT, paid: false } });
    expect(await reconcileExecution(unpaid.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "closed", storeState: "CONFIRMED", outcome: { chainStatus: "CONFIRMED", businessStatus: "FAILED" } });
    const reverted = fakeRpc({ receipts: { [OURS]: { status: "reverted", blockNumber: 950n, logs: [] } } });
    expect(await reconcileExecution(reverted.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "closed", storeState: "REVERTED", outcome: { chainStatus: "REVERTED", businessStatus: "FAILED" } });
  });
  it("an unreadable order state concludes nothing", async () => {
    const { rpc, sent } = fakeRpc({ order: "unreadable", consumed: { 7: { block: 910n, hash: OTHER, to: MERCHANT, paysOrder: false } } });
    expect(await reconcileExecution(rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", reason: expect.stringContaining("unreadable") });
    expect(sent).toHaveLength(0);
  });
  it("identifies the transaction that consumed the nonce by binary search over eth_getTransactionCount", async () => {
    const { rpc } = fakeRpc({ consumed: { 7: { block: 933n, hash: OTHER, to: MERCHANT, paysOrder: false } } });
    expect(await findNonceConsumer(rpc, stored())).toEqual({ hash: OTHER, block: 933n });
    expect(vi.mocked(rpc.getTransactionCount).mock.calls.length).toBeLessThan(16);
  });
  it("nonce consumed by a transaction that does not pay the order → NOT_MINED, order unpaid, consumer named, nothing re-signed", async () => {
    const { rpc, sent } = fakeRpc({ consumed: { 7: { block: 933n, hash: OTHER, to: "0x00000000000000000000000000000000000000ee" as Hex, paysOrder: false } } });
    const r = await reconcileExecution(rpc, stored(), { allowSend: true });
    expect(r).toMatchObject({ kind: "closed", storeState: "NOT_MINED", consumedBy: OTHER, outcome: { chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED", businessTxHash: null } });
    expect((r as any).outcome.note).toContain(OTHER); expect(sent).toHaveLength(0);
  });
  it("nonce consumed by an unidentifiable transaction (no history) → pending, never NOT_MINED on a guess", async () => {
    const { rpc, sent } = fakeRpc({ consumed: { 7: { block: 933n, hash: OTHER, to: MERCHANT, paysOrder: false } }, historyDepth: 10n });
    const r = await reconcileExecution(rpc, stored(), { allowSend: true });
    expect(r).toMatchObject({ kind: "pending", reason: expect.stringContaining("could not be identified") }); expect(sent).toHaveLength(0);
  });
  it("a lagging node: the nonce reads consumed and the receipt is hidden, but the block scan finds OUR hash → re-fetch or wait, never NOT_MINED (testnet 2026-10-08)", async () => {
    const lagging = fakeRpc({ consumed: { 7: { block: 933n, hash: OURS, to: MERCHANT, paysOrder: true } }, receiptHidden: new Set([OURS.toLowerCase()]) });
    expect(await reconcileExecution(lagging.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", reason: expect.stringContaining("receipt is not visible") });
    expect(lagging.sent).toHaveLength(0);
    const caughtUp = fakeRpc({ consumed: { 7: { block: 933n, hash: OURS, to: MERCHANT, paysOrder: true } }, order: { payer: PAYER, amount: AMOUNT, paid: true } });
    // the first receipt read misses, the re-fetch after the block scan succeeds
    const real = caughtUp.rpc.getTransactionReceipt; let calls = 0;
    (caughtUp.rpc as any).getTransactionReceipt = vi.fn(async (a: any) => { if (calls++ === 0) throw new Error("not found"); return real(a); });
    expect(await reconcileExecution(caughtUp.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "closed", storeState: "CONFIRMED", outcome: { chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: OURS } });
  });
  it("the latest order read lags but the consuming replacement pays this order (paid at its block) → SUPERSEDED, not NOT_MINED; an inconsistent node → pending", async () => {
    const lagging = fakeRpc({ consumed: { 7: { block: 940n, hash: OTHER, to: MERCHANT, paysOrder: true } }, orderAt: (b) => ({ payer: PAYER, amount: AMOUNT, paid: b !== undefined && b >= 940n }) });
    expect(await reconcileExecution(lagging.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "closed", storeState: "SUPERSEDED", consumedBy: OTHER, outcome: { businessStatus: "SUCCESS", businessTxHash: OTHER } });
    const inconsistent = fakeRpc({ consumed: { 7: { block: 940n, hash: OTHER, to: MERCHANT, paysOrder: true } } }); // OrderPaid in the receipt, yet the order reads unpaid at that block
    expect(await reconcileExecution(inconsistent.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", reason: expect.stringContaining("inconsistent") });
  });
  it("order paid by a same-nonce replacement → SUPERSEDED: business SUCCESS attributed to the replacement, our hash UNKNOWN", async () => {
    const { rpc, sent } = fakeRpc({ order: { payer: PAYER, amount: AMOUNT, paid: true }, consumed: { 7: { block: 940n, hash: OTHER, to: MERCHANT, paysOrder: true } } });
    const r = await reconcileExecution(rpc, stored(), { allowSend: true });
    expect(r).toMatchObject({ kind: "closed", storeState: "SUPERSEDED", consumedBy: OTHER, outcome: { chainStatus: "UNKNOWN", businessStatus: "SUCCESS", businessTxHash: OTHER, block: "940" } });
    expect(sent).toHaveLength(0);
  });
  it("order paid, our receipt invisible, nonce not yet consumed on this node → wait (a lagging node)", async () => {
    const { rpc } = fakeRpc({ order: { payer: PAYER, amount: AMOUNT, paid: true } });
    expect(await reconcileExecution(rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", reason: expect.stringContaining("not visible") });
  });
  it("order paid but the consuming transaction does not pay it → manual reconciliation, no automatic repayment", async () => {
    const { rpc, sent } = fakeRpc({ order: { payer: PAYER, amount: AMOUNT, paid: true }, consumed: { 7: { block: 940n, hash: OTHER, to: MERCHANT, paysOrder: false } } });
    const r = await reconcileExecution(rpc, stored(), { allowSend: true });
    expect(r).toMatchObject({ kind: "pending", reason: expect.stringContaining("manual reconciliation") }); expect(sent).toHaveLength(0);
  });
  it("still in the pool → pending without sending", async () => {
    const { rpc, sent } = fakeRpc({ pool: new Set([OURS]) });
    expect(await reconcileExecution(rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", reason: "still in the transaction pool", rebroadcast: false });
    expect(sent).toHaveLength(0);
  });
  it("dropped inside the window: an observer never sends; the authorized worker rebroadcasts the identical bytes", async () => {
    const observer = fakeRpc({});
    expect(await reconcileExecution(observer.rpc, stored(), { allowSend: false })).toMatchObject({ kind: "pending", rebroadcast: false, reason: expect.stringContaining("recovery worker") });
    expect(observer.sent).toHaveLength(0);
    const worker = fakeRpc({});
    expect(await reconcileExecution(worker.rpc, stored(), { allowSend: true })).toMatchObject({ kind: "pending", rebroadcast: true });
    expect(worker.sent).toEqual(["0x02f8aa"]);
  });
  it("dropped after the window: no rebroadcast, waits for the nonce to be consumed", async () => {
    const { rpc, sent } = fakeRpc({});
    expect(await reconcileExecution(rpc, stored({ validUntil: new Date(Date.now() - 1000).toISOString() }), { allowSend: true })).toMatchObject({ kind: "pending", rebroadcast: false, reason: expect.stringContaining("after its validation window") });
    expect(sent).toHaveLength(0);
  });
});

describe("review of 0c0d406, P1-3 — the clock is read again immediately before any rebroadcast", () => {
  it("a window that closes during the reads or the decryption → nothing is sent; inside the window the identical bytes go out", async () => {
    let t = Date.now(); const clock = () => new Date(t);
    const slowReceipt = fakeRpc({});
    (slowReceipt.rpc.getTransactionReceipt as any).mockImplementation(async () => { t += 6000; return null; }); // the first RPC read takes the whole window
    const r = await reconcileExecution(slowReceipt.rpc, stored({ validUntil: new Date(t + 5000).toISOString() }), { allowSend: true, clock });
    expect(r).toMatchObject({ kind: "pending", rebroadcast: false, reason: expect.stringContaining("after its validation window") }); expect(slowReceipt.sent).toHaveLength(0);
    t = Date.now(); const slowOpen = fakeRpc({}); // the decryption is the last await before the send
    const r2 = await reconcileExecution(slowOpen.rpc, stored({ validUntil: new Date(t + 5000).toISOString(), openRaw: async () => { t += 6000; return "0x02f8aa" as Hex; } }), { allowSend: true, clock });
    expect(r2).toMatchObject({ kind: "pending", rebroadcast: false, reason: expect.stringContaining("closed during the reads or the decryption") }); expect(slowOpen.sent).toHaveLength(0);
    t = Date.now(); const fine = fakeRpc({});
    const r3 = await reconcileExecution(fine.rpc, stored({ validUntil: new Date(t + 5000).toISOString() }), { allowSend: true, clock });
    expect(r3).toMatchObject({ kind: "pending", rebroadcast: true }); expect(fine.sent).toEqual(["0x02f8aa"]);
  });
  it("without an injected clock the wall clock is read fresh: a receipt read that outlasts the window (fake timers) → no rebroadcast", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, sent } = fakeRpc({});
      const validUntil = new Date(Date.now() + 5000).toISOString();
      (rpc.getTransactionReceipt as any).mockImplementation(async () => { vi.advanceTimersByTime(6000); return null; });
      expect(await reconcileExecution(rpc, stored({ validUntil }), { allowSend: true })).toMatchObject({ kind: "pending", rebroadcast: false, reason: expect.stringContaining("after its validation window") });
      expect(sent).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
