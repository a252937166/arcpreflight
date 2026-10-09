import { describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { SqliteExecutionStore, makeSealer, openStoreDb, reconcilePlannedOrder } from "../src/index.js";

// Reference-CLI parity (review round 2 §4): the same order identity before the send and the same chain reconciliation as the API.
const ID = ("0x" + "ab".repeat(32)) as `0x${string}`; const TX = ("0x" + "bc".repeat(32)) as `0x${string}`;
const PAYER = "0x3333333333333333333333333333333333333333" as const; const MERCHANT = "0x2222222222222222222222222222222222222222" as const;
describe("CLI store: orders PLANNED → SENT → CONFIRMED and reconciliation from the chain", () => {
  it("records the identity before any hash exists, then the hash, then the receipt facts", async () => {
    const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    const os = store.orderStore();
    await os.planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    expect(store.listOpenOrders()).toEqual([{ orderId: ID, merchant: MERCHANT, txHash: null, createdAt: expect.any(String), raw: null, nonce: null, from: null }]);
    await os.sent({ orderId: ID, tx: TX }); expect(store.listOpenOrders()[0].txHash).toBe(TX);
    await os.confirmed({ orderId: ID, tx: TX, block: "100", from: PAYER, gasUsed: "90000", effectiveGasPriceNativeAtomic: "21000000000" });
    expect(store.listOpenOrders()).toHaveLength(0); expect(store.listOrders()[0]).toMatchObject({ state: "CONFIRMED", block: "100", gas_used: "90000" });
  });
  it("an order left SENT by an interrupted process is confirmed from its receipt, or from the chain's order state, or closed UNKNOWN_CREATION after the window", async () => {
    const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    const os = store.orderStore();
    await os.planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT }); await os.sent({ orderId: ID, tx: TX });
    const withReceipt = { getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, from: PAYER, gasUsed: 1n, effectiveGasPrice: 2n }), readContract: async () => ["0x0000000000000000000000000000000000000000", 0n, false, 0n, 0n] };
    const r = await reconcilePlannedOrder(withReceipt as any, store.listOpenOrders()[0]);
    expect(r).toMatchObject({ kind: "confirmed", tx: TX, block: "5", gasUsed: "1" });
    store.applyOrderReconciliation(ID, r); expect(store.listOrders()[0]).toMatchObject({ state: "CONFIRMED", block: "5" });
    const store2 = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    await store2.orderStore().planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    const noReceiptButOnChain = { getTransactionReceipt: async () => { throw new Error("not found"); }, readContract: async () => [PAYER, 1n, false, 1n, 0n] };
    const r2 = await reconcilePlannedOrder(noReceiptButOnChain as any, store2.listOpenOrders()[0]);
    expect(r2).toMatchObject({ kind: "confirmed", tx: null, note: expect.stringContaining("exists on chain although no creation hash was recorded") });
    const store3 = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    await store3.orderStore().planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    const nothing = { getTransactionReceipt: async () => { throw new Error("not found"); }, readContract: async () => ["0x0000000000000000000000000000000000000000", 0n, false, 0n, 0n] };
    expect((await reconcilePlannedOrder(nothing as any, store3.listOpenOrders()[0])).kind).toBe("pending");
    const r3 = await reconcilePlannedOrder(nothing as any, store3.listOpenOrders()[0], { now: new Date(Date.now() + 11 * 60_000) });
    expect(r3.kind).toBe("unknown"); store3.applyOrderReconciliation(ID, r3); expect(store3.listOrders()[0].state).toBe("UNKNOWN_CREATION");
  });
});

// 2026-10-09 13:57:49Z: the node refused eth_sendRawTransaction for an order creation that was signed and sent in one call, so no hash
// was recorded. The creation is now signed locally and recorded (hash, bytes, nonce, signer) before its broadcast; reconciliation
// re-sends the IDENTICAL bytes while the window is open (only where sending is allowed) and settles a consumed nonce by its consumer.
const RAW = (`0x02${"de".repeat(90)}`) as Hex; const RTX = keccak256(RAW);
const SIGNER = "0x4444444444444444444444444444444444444444" as const; const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER = ("0x" + "ef".repeat(32)) as Hex;
const LATER = () => new Date(Date.now() + 11 * 60_000);
async function sentOrder() {
  const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
  const os = store.orderStore();
  await os.planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
  await os.sent({ orderId: ID, tx: RTX, raw: RAW, nonce: 7, from: SIGNER });
  return { store, o: store.listOpenOrders()[0] };
}
/** a chain where the signer's nonce 7 is free (latest 7) or was consumed at block 150 by `consumer` (latest 8) */
function chain(c: { latest?: number; inPool?: boolean; consumer?: Hex | null; exists?: () => boolean; sendError?: string }) {
  const sent: Hex[] = [];
  const rpc = {
    getTransactionReceipt: async () => { throw new Error("not found"); },
    readContract: async () => (c.exists?.() ? [PAYER, 1n, false, 1n, 0n] : [ZERO, 0n, false, 0n, 0n]),
    getTransactionCount: async ({ blockNumber }: { blockNumber?: bigint }) => blockNumber === undefined ? (c.latest ?? 7) : (c.latest ?? 7) > 7 && blockNumber >= 150n ? 8 : 7,
    getTransaction: async () => { if (c.inPool) return { hash: RTX }; throw new Error("not found"); },
    getBlockNumber: async () => 200n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, transactions: blockNumber === 150n && c.consumer ? [{ hash: c.consumer, from: SIGNER, nonce: 7 }] : [] }),
  };
  const send = { sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => { sent.push(serializedTransaction); if (c.sendError) throw new Error(c.sendError); return keccak256(serializedTransaction); }) };
  return { rpc, send, sent };
}
describe("order creation: identical-bytes re-send and the creation nonce (2026-10-09)", () => {
  it("records the signed creation (hash, bytes, nonce, signer) at SENT and hands it back to reconciliation", async () => {
    const { store, o } = await sentOrder();
    expect(o).toEqual({ orderId: ID, merchant: MERCHANT, txHash: RTX, createdAt: expect.any(String), raw: RAW, nonce: 7, from: SIGNER });
    expect(store.listOrders()[0]).toMatchObject({ state: "SENT", tx_hash: RTX, raw_tx: RAW, tx_nonce: 7 });
  });
  it("a creation that was never sent is closed FAILED by notSent, and its signed bytes are dropped so nothing re-sends them", async () => {
    const { store } = await sentOrder();
    await store.orderStore().notSent!({ orderId: ID, reason: "the creation transaction was not signed or not recorded (disk full); nothing was sent" });
    expect(store.listOpenOrders()).toHaveLength(0);
    expect(store.listOrders()[0]).toMatchObject({ state: "FAILED", raw_tx: null, note: expect.stringContaining("nothing was sent") });
  });
  it("the identical bytes are re-sent only where sending is allowed, only inside the window, and never when the node already holds them", async () => {
    const { store, o } = await sentOrder();
    const c = chain({});
    expect(await reconcilePlannedOrder(c.rpc as any, o)).toMatchObject({ kind: "pending" }); // a read never sends
    expect(c.sent).toEqual([]);
    expect(await reconcilePlannedOrder(c.rpc as any, o, { send: c.send })).toMatchObject({ kind: "pending", resent: true, note: expect.stringContaining("identical signed creation") });
    expect(c.sent).toEqual([RAW]); // the same bytes: one hash, one nonce, one order
    const late = await reconcilePlannedOrder(c.rpc as any, o, { send: c.send, now: LATER() });
    expect(late.kind).toBe("unknown"); expect(c.sent).toEqual([RAW]);
    store.applyOrderReconciliation(ID, late); expect(store.listOrders()[0].state).toBe("UNKNOWN_CREATION");
    const pooled = chain({ inPool: true });
    expect(await reconcilePlannedOrder(pooled.rpc as any, o, { send: pooled.send })).toMatchObject({ kind: "pending", note: expect.stringContaining("known to the node") });
    expect(await reconcilePlannedOrder(pooled.rpc as any, o, { send: pooled.send, now: LATER() })).toMatchObject({ kind: "pending" }); // it can still be mined
    expect(pooled.sent).toEqual([]);
    const refusing = chain({ sendError: "insufficient funds for gas * price + value" });
    expect(await reconcilePlannedOrder(refusing.rpc as any, o, { send: refusing.send })).toMatchObject({ kind: "pending", resent: false, note: expect.stringContaining("insufficient funds") });
  });
  it("a creation nonce consumed by another, identified transaction is FAILED (nothing is re-signed); CONFIRMED only if the order exists anyway", async () => {
    const { store, o } = await sentOrder();
    const c = chain({ latest: 8, consumer: OTHER });
    const r = await reconcilePlannedOrder(c.rpc as any, o, { send: c.send });
    expect(r).toEqual({ kind: "failed", note: `the creation nonce was consumed by another transaction (${OTHER}); this order was never created — nothing is re-signed; a new order is a new row` });
    expect(c.sent).toEqual([]);
    store.applyOrderReconciliation(ID, r); expect(store.listOrders()[0].state).toBe("FAILED");
    let reads = 0; const visibleLater = chain({ latest: 8, consumer: OTHER, exists: () => ++reads > 1 });
    expect(await reconcilePlannedOrder(visibleLater.rpc as any, o)).toMatchObject({ kind: "confirmed", tx: null, note: `the order exists on chain; the recorded creation nonce was consumed by transaction ${OTHER}` });
  });
  it("a nonce consumed by the creation itself, or by a transaction that cannot be identified, concludes nothing inside the window", async () => {
    const { o } = await sentOrder();
    const own = chain({ latest: 8, consumer: RTX });
    expect(await reconcilePlannedOrder(own.rpc as any, o, { send: own.send })).toMatchObject({ kind: "pending", note: expect.stringContaining("block 150 contains this creation transaction") });
    const unseen = chain({ latest: 8, consumer: null });
    expect(await reconcilePlannedOrder(unseen.rpc as any, o, { send: unseen.send })).toMatchObject({ kind: "pending", note: expect.stringContaining("could not identify") });
    expect(await reconcilePlannedOrder(unseen.rpc as any, o, { now: LATER() })).toMatchObject({ kind: "unknown", note: expect.stringContaining("could not identify") });
    expect(own.sent).toEqual([]); expect(unseen.sent).toEqual([]);
  });
});

describe("CLI store: progressive artefacts and steps per run (review round 3 §8)", () => {
  it("records artefacts as they come, learns the attempt id from the execution artefact, and serves them back for a passport", () => {
    const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    const ev = store.beginRun("run-1", "APPROVED_PAYMENT");
    ev.onArtifact("intent", { intent: { a: 1 } }); ev.onStep({ step: "createOrder", atMs: 5 }); ev.onArtifact("execution", { executionAttemptId: "att-9", chainStatus: "PENDING" }); ev.onArtifact("execution", { executionAttemptId: "att-9", chainStatus: "CONFIRMED" });
    expect(store.runByAttempt("att-9")).toMatchObject({ run_key: "run-1", fixture: "APPROVED_PAYMENT", attempt_id: "att-9" });
    expect(store.runByAttempt("run-1")?.run_key).toBe("run-1");
    expect(store.artifactsOf("run-1")).toEqual({ intent: { intent: { a: 1 } }, execution: { executionAttemptId: "att-9", chainStatus: "CONFIRMED" } });
    expect(store.stepsOf("run-1")).toEqual([{ step: "createOrder", atMs: 5 }]);
    expect(store.listRuns()[0]).toMatchObject({ run_key: "run-1", artifacts: 2 });
  });
});
