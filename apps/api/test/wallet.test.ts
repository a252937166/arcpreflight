import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValidationDigest, transactionPlanDigest, quoteDigest } from "@arcpreflight/schema";
import { ORDER_PAID_TOPIC } from "@arcpreflight/runner";
import { fromBundle } from "@arcpreflight/passport";
import { openDb, run, type Db } from "../src/db.js";
import { syntheticRun, PAYER, MERCHANT, ORDER_ID, USDC } from "../../../packages/passport/test/fixture.js";

// Wallet execution (design v3.3 §3, AP33-07/08/09/10): durable attempts, after-the-fact plan comparison and reconciliation from the
// hash, the order state and the OrderPaid event — against a fake chain. The decision and the final validation themselves are the
// policy and runner packages' concern (tested there); here they are stubbed so the attempt life cycle is what is under test.
const mocks = vi.hoisted(() => ({ decide: vi.fn(), fv: vi.fn(), head: vi.fn(), receipt: vi.fn() }));
vi.mock("../src/config.js", () => ({ cfg: {
  root: "/offline/wallet", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", rpc: "http://offline.invalid", port: 4040, releaseSha: "test-release", profile: "SUBMISSION_RESTRICTED", publicExecution: true,
  usdc: "0x3600000000000000000000000000000000000000", priceTokenAtomic: "10000", merchant: { address: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0" }, principals: new Map(), supportedTargets: [],
  relay: { scanChunkBlocks: 9000, scanChunksPerCall: 3 },
} }));
vi.mock("../src/report.js", () => ({ client: { getBlockNumber: mocks.head, getTransactionReceipt: mocks.receipt, getTransaction: async () => null } }));
vi.mock("../src/demo.js", () => ({ feeParams: async () => ({ maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }) }));
vi.mock("../src/payments.js", () => ({ openJson: async (s: string) => JSON.parse(s), sealJson: async (o: unknown) => JSON.stringify(o) }));
vi.mock("@arcpreflight/policy", async () => ({ ...(await vi.importActual<any>("@arcpreflight/policy")), decide: mocks.decide }));
vi.mock("@arcpreflight/runner", async () => ({ ...(await vi.importActual<any>("@arcpreflight/runner")), finalValidate: mocks.fv }));
import { createWalletAttempt, markSent, abandonAttempt, observeAttempt, recoverAttempt, reconcileWalletAttempts, compareWithPlan, executionReceiptOf, getAttemptRow, listAttempts, buildWalletPassport, type WalletRpc } from "../src/wallet.js";

const F = syntheticRun("APPROVED"); const R = F.source.result!;
const FV = { ...R.finalValidation!, expiresAt: new Date(Date.now() + 60_000).toISOString() }; // the fixture's window is static; the attempt's window must be open while these tests run
const OWNER = "visitor:a"; const REQ = "11111111-1111-4111-8111-111111111111"; const HASH = ("0x" + "77".repeat(32)) as `0x${string}`; const OTHER = ("0x" + "88".repeat(32)) as `0x${string}`;
let db: Db;
const seed = (d: Db, o: { orderState?: string; payState?: string; owner?: string } = {}) => {
  const ts = new Date().toISOString();
  run(d, "INSERT INTO requests (request_id, principal, client_request_id, intent_json, intent_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", REQ, o.owner ?? OWNER, "c1", JSON.stringify(R.intent), R.intentDigest, "DELIVERED", ts, ts);
  run(d, "INSERT INTO quotes (request_id, quote_json, quote_digest, report_digest, expires_at, created_at) VALUES (?,?,?,?,?,?)", REQ, JSON.stringify(R.quote), quoteDigest(R.quote), R.reportDigest, ts, ts);
  run(d, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend, tx_hash, settlement_evidence_json, settle_payload_encrypted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    REQ, `ap_${REQ}`, "eip155:5042002", USDC.toLowerCase(), PAYER, R.feeAuthorization!.nonce, o.payState ?? "COMPLETED", ts, ts, "relay", F.hashes.FEE_TX, JSON.stringify(F.source.settlement!.evidence), JSON.stringify({ paymentPayload: { payload: { authorization: { ...R.feeAuthorization, signature: "0x" + "99".repeat(65) } } } }));
  run(d, "INSERT OR IGNORE INTO reports (report_digest, request_id, subject, mode, report_json, evidence_json, is_public, created_at) VALUES (?,?,?,?,?,?,?,?)", R.reportDigest, REQ, MERCHANT.toLowerCase(), "SUPPORTED_INTENT", JSON.stringify(R.report), JSON.stringify({ evidence: F.source.reportEvidence, simulation: { ok: true, error: null } }), 0, ts);
  run(d, "INSERT OR IGNORE INTO baselines (baseline_digest, subject, baseline_json, revoked, created_at) VALUES (?,?,?,?,?)", F.digests.baseline, F.source.baseline!.subject, JSON.stringify(F.source.baseline), 0, ts);
  run(d, "INSERT INTO orders (order_id, owner, client_key, source, payer, merchant, proxy, amount_atomic, reference, state, tx_hash, block, from_addr, gas_used, effective_gas_price, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ORDER_ID.toLowerCase(), o.owner ?? OWNER, "c1", "developer", PAYER.toLowerCase(), MERCHANT.toLowerCase(), "MAIN", (R.intent.businessExpectation as any).amountNativeAtomic, "invoice #42", o.orderState ?? "CONFIRMED", F.hashes.CREATE_TX, "65993420", "0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b".toLowerCase(), "98107", "21000000000", ts, ts);
};
const passing = () => ({ finalValidation: FV, finalValidationDigest: finalValidationDigest(FV), plan: R.plan, planDigest: transactionPlanDigest(R.plan!), evidence: R.finalValidationEvidence ?? [], approvalStatusAtValidation: R.approvalStatusAtValidation ?? null, fees: { maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, gasLimit: 60000n, nonce: 9, snapshot: FV.snapshot, reasons: [] });
const body = () => ({ requestId: REQ, orderId: ORDER_ID, policy: R.policy });
/** A fake chain: the reported transaction (when visible), its receipt (when mined), the order's paid flag, the payer's nonce and OrderPaid logs. */
/** `consumed`: the payer's transaction at `nonce` was included in `block` (drives eth_getTransactionCount at a block and the block scan); `hiddenReceipts`: hashes a lagging node does not serve a receipt for */
function fakeRpc(o: { tx?: any; txs?: Record<string, any>; receipt?: any; receipts?: Record<string, any>; paid?: boolean; nonce?: number; logs?: { transactionHash: string; blockNumber: string }[]; head?: bigint; consumed?: { nonce: number; block: bigint; hash: string }; hiddenReceipts?: Set<string> } = {}): WalletRpc & { calls: string[] } {
  const calls: string[] = []; const head = o.head ?? 66_000_000n;
  const countAt = (b: bigint) => (o.consumed && o.consumed.block <= b ? o.consumed.nonce + 1 : o.consumed ? o.consumed.nonce : (o.nonce ?? 9));
  return { calls,
    getTransaction: async ({ hash }) => { calls.push("tx"); return o.txs?.[hash.toLowerCase()] ?? (hash.toLowerCase() === HASH.toLowerCase() ? (o.tx ?? null) : null); },
    getTransactionReceipt: async ({ hash }) => { calls.push(`receipt:${hash}`); if (o.hiddenReceipts?.has(hash.toLowerCase())) throw new Error("not found"); const r = o.receipts?.[hash.toLowerCase()] ?? (o.receipt && (o.receipt.transactionHash ?? hash).toLowerCase() === hash.toLowerCase() ? o.receipt : null); if (r) return r; throw new Error("not found"); },
    getTransactionCount: async (a) => { calls.push("nonce"); return a.blockNumber !== undefined ? countAt(a.blockNumber) : o.consumed ? o.consumed.nonce + 1 : (o.nonce ?? 9); },
    readContract: async () => { calls.push("order"); return [PAYER, BigInt((R.intent.businessExpectation as any).amountNativeAtomic), !!o.paid, 1n, 0n]; },
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }) => { calls.push(`block:${blockNumber}`); return { number: blockNumber, transactions: o.consumed && o.consumed.block === blockNumber ? [{ hash: o.consumed.hash, from: PAYER, nonce: o.consumed.nonce }] : [] }; },
    getLogs: async (f) => { calls.push(`logs:${f.fromBlock}-${f.toBlock}`); expect(f.topics[0]).toBe(ORDER_PAID_TOPIC); expect(f.topics[1]?.toLowerCase()).toBe(ORDER_ID.toLowerCase()); return o.logs ?? []; },
  };
}
const planTx = (over: Record<string, unknown> = {}) => ({ hash: HASH, from: PAYER, to: MERCHANT, input: R.plan!.data, value: BigInt(R.plan!.valueNativeAtomic), nonce: Number(R.plan!.nonce), gas: BigInt(R.plan!.gasLimit), maxFeePerGas: BigInt(R.plan!.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(R.plan!.maxPriorityFeePerGasNativeAtomic), chainId: 5042002, type: "eip1559", ...over });
const minedReceipt = (hash = HASH, status = "success") => ({ transactionHash: hash, status, blockNumber: 66_000_010n, from: PAYER, to: MERCHANT, gasUsed: 55_000n, effectiveGasPrice: 21_000_000_000n, logs: [] });
async function validated(): Promise<string> {
  const r = await createWalletAttempt(db, OWNER, "c1", body());
  expect(r.ok).toBe(true); if (!r.ok) throw new Error("not validated");
  return (r.attempt as any).attemptId as string;
}
beforeEach(() => {
  db = openDb(":memory:"); seed(db);
  mocks.decide.mockReset().mockReturnValue({ decision: "NO_POLICY_VIOLATION", checks: [], reasons: [] });
  mocks.fv.mockReset().mockResolvedValue(passing());
  mocks.head.mockReset().mockResolvedValue(66_000_000n); mocks.receipt.mockReset().mockRejectedValue(new Error("not found"));
});
afterEach(() => db.close());

describe("after-the-fact comparison with the validated plan (AP33-08)", () => {
  it("accepts an identical transaction, records wallet-set gas/fees/nonce as deviations, and flags to/data/value/chainId/type as mismatches", () => {
    expect(compareWithPlan(planTx(), R.plan!)).toEqual({ mismatch: [], deviations: {} });
    const d = compareWithPlan(planTx({ gas: 70_000n, nonce: 12, maxFeePerGas: 22_000_000_000n }), R.plan!);
    expect(d.mismatch).toEqual([]); expect(Object.keys(d.deviations).sort()).toEqual(["gasLimit", "maxFeePerGas", "nonce"]); expect(d.deviations.nonce).toEqual({ plan: R.plan!.nonce, actual: "12" });
    expect(compareWithPlan(planTx({ input: "0x12345678", value: 1n }), R.plan!).mismatch).toEqual(["data", "value"]);
    expect(compareWithPlan(planTx({ to: USDC, chainId: 5042, type: "legacy" }), R.plan!).mismatch).toEqual(["to", "chainId", "type"]);
  });
});

describe("attempt admission and durability (AP33-07)", () => {
  it("validates input and ownership before anything is read from the chain", async () => {
    expect(await createWalletAttempt(db, OWNER, "c1", { ...body(), requestId: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(await createWalletAttempt(db, OWNER, "c1", { ...body(), policy: undefined })).toMatchObject({ ok: false, status: 400, reason: expect.stringContaining("policy") });
    expect(await createWalletAttempt(db, OWNER, "c1", { ...body(), policy: { ...R.policy, maxFinalValidationAgeSeconds: 7 } })).toMatchObject({ ok: false, status: 400, reason: expect.stringContaining("digest") });
    expect(await createWalletAttempt(db, "visitor:b", "c2", body())).toMatchObject({ ok: false, status: 404 }); // another session: no existence leak
    db.prepare("UPDATE orders SET state = 'SENT'").run();
    expect(await createWalletAttempt(db, OWNER, "c1", body())).toMatchObject({ ok: false, status: 409, error: "ORDER_NOT_CONFIRMED" });
    db.prepare("UPDATE orders SET state = 'CONFIRMED'").run(); db.prepare("UPDATE payments SET state = 'PENDING'").run();
    expect(await createWalletAttempt(db, OWNER, "c1", body())).toMatchObject({ ok: false, status: 409, error: "CHECK_NOT_DELIVERED" });
    expect(mocks.fv).not.toHaveBeenCalled(); expect(db.prepare("SELECT COUNT(*) AS c FROM wallet_attempts").get()).toMatchObject({ c: 0 });
  });
  it("a decision other than NO_POLICY_VIOLATION is recorded REFUSED and nothing is validated against the chain", async () => {
    mocks.decide.mockReturnValue({ decision: "REVIEW_REQUIRED", checks: [], reasons: ["resolved implementation differs from approved baseline"] });
    const r = await createWalletAttempt(db, OWNER, "c1", body());
    expect(r).toMatchObject({ ok: false, status: 409, error: "VALIDATION_FAILED", reasons: ["resolved implementation differs from approved baseline"] });
    const a = getAttemptRow(db, (r as any).attemptId)!;
    expect(a).toMatchObject({ state: "REFUSED", plan_json: null }); expect(JSON.parse(a.refusal_json!)).toMatchObject({ stage: "decision", decision: "REVIEW_REQUIRED" });
    expect(mocks.fv).not.toHaveBeenCalled();
    expect(executionReceiptOf(a)).toMatchObject({ chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", signedTransactionHash: null });
  });
  it("a failed final validation is recorded REFUSED with its reasons; a passing one is persisted VALIDATED with the plan before the response", async () => {
    mocks.fv.mockResolvedValueOnce({ ...passing(), finalValidation: { ...FV, result: "REVIEW_REQUIRED", reasons: ["balance < value + gas reserve"] }, reasons: ["balance < value + gas reserve"] });
    const refused = await createWalletAttempt(db, OWNER, "c1", body());
    expect(refused).toMatchObject({ ok: false, status: 409, error: "VALIDATION_FAILED", reasons: ["balance < value + gas reserve"] });
    expect(getAttemptRow(db, (refused as any).attemptId)).toMatchObject({ state: "REFUSED" });
    const ok = await createWalletAttempt(db, OWNER, "c1", body());
    expect(ok.ok).toBe(true); if (!ok.ok) return;
    expect(ok.attempt).toMatchObject({ executionMode: "wallet", state: "VALIDATED", decision: "NO_POLICY_VIOLATION", validUntil: FV.expiresAt, plan: R.plan, passportAvailable: false });
    expect(ok.attempt.nextAction).toContain("wallet");
    const row = getAttemptRow(db, (ok.attempt as any).attemptId)!;
    expect(row).toMatchObject({ state: "VALIDATED", owner: OWNER, request_id: REQ, order_id: ORDER_ID.toLowerCase(), plan_digest: transactionPlanDigest(R.plan!), final_validation_digest: finalValidationDigest(FV) });
    expect(JSON.parse(row.plan_json!)).toEqual(R.plan);
    // the validation was asked for the WALLET payer, not a local key, after the fee confirmation and the order creation
    const call = mocks.fv.mock.calls[1][0];
    expect(call.signer).toEqual({ address: PAYER, type: "wallet", requireLocal: false }); expect(call.feeBlock).toBe(BigInt(F.source.settlement!.evidence!.blockNumber)); expect(call.orderBlock).toBe(65993420n);
    expect(await createWalletAttempt(db, OWNER, "c1", body())).toMatchObject({ ok: false, status: 409, error: "ATTEMPT_OPEN" });
  });
  it("abandon closes a validated attempt as NOT_SENT; sent and abandon refuse any other state", async () => {
    const id = await validated();
    expect(abandonAttempt(db, "visitor:b", id)).toMatchObject({ ok: false, status: 404 });
    expect(abandonAttempt(db, OWNER, id)).toMatchObject({ ok: true, attempt: { state: "NOT_SENT", businessStatus: "NOT_EXECUTED" } });
    expect(abandonAttempt(db, OWNER, id)).toMatchObject({ ok: false, status: 409, error: "ATTEMPT_NOT_OPEN" });
    expect(await markSent(db, OWNER, id, HASH, fakeRpc())).toMatchObject({ ok: false, status: 409, error: "ATTEMPT_NOT_OPEN" });
    expect(listAttempts(db, OWNER)).toHaveLength(1); expect(listAttempts(db, "visitor:b")).toHaveLength(0);
  });
});

describe("reported hash → outcome from the receipt, the order and the OrderPaid event (AP33-08/09)", () => {
  it("a matching mined transaction that pays the order closes CONFIRMED/SUCCESS on the normal path, with no recovery entry", async () => {
    const id = await validated();
    const rpc = fakeRpc({ tx: planTx(), receipt: minedReceipt(), paid: true });
    const r0 = await markSent(db, OWNER, id, HASH, rpc);
    expect(r0.ok).toBe(true); if (!r0.ok) return; const r = { attempt: r0.attempt as any };
    expect(r.attempt).toMatchObject({ state: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: HASH, txHash: HASH, nonce: Number(R.plan!.nonce), block: "66000010", deviations: { mismatch: [], deviations: {} }, passportAvailable: true });
    expect(r.attempt.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", signedTransactionHash: null, businessTxHash: HASH });
    expect(r.attempt.recovery).toMatchObject({ interrupted: false, originalTransaction: { hash: HASH, status: "confirmed" }, reconciliation: [] });
    expect(r.attempt.costStatement.buyer.businessPrincipal.usdc).toBe("0.05");
    expect(r.attempt.costStatement).toMatchObject({ costStatementVersion: "1.1", buyer: { role: "visitor-wallet", complete: true }, operator: { complete: false } }); // no fee receipt served by this fake
    expect(r.attempt.nextAction).toContain("Passport");
    const withFee = fakeRpc({ receipts: { [F.hashes.FEE_TX.toLowerCase()]: { transactionHash: F.hashes.FEE_TX, status: "success", blockNumber: 65_993_438n, from: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0", gasUsed: 87_141n, effectiveGasPrice: 25_000_000_000n } } });
    const id2 = await (async () => { db.prepare("UPDATE wallet_attempts SET state = 'BROADCAST_ATTEMPTED', fee_receipt_json = NULL WHERE attempt_id = ?").run(id); return id; })();
    await reconcileWalletAttempts(db, withFee, { attemptId: id2, source: "worker" }); // the fee receipt is read once; the attempt itself stays as the fake leaves it
    const again = await observeAttempt(db, OWNER, id2, fakeRpc({ tx: planTx(), receipt: minedReceipt(), paid: true }));
    expect(again.ok && (again.attempt as any).costStatement.operator).toMatchObject({ complete: true, feeRelay: { gasUsed: "87141" } });
  });
  it("a transaction that deviates in data is recorded MISMATCH; the order state decides the business outcome", async () => {
    const id = await validated();
    const rpc = fakeRpc({ tx: planTx({ input: "0xdeadbeef", gas: 70_000n }), receipt: minedReceipt(), paid: false });
    const r = await markSent(db, OWNER, id, HASH, rpc);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.attempt).toMatchObject({ state: "MISMATCH", businessStatus: "FAILED", deviations: { mismatch: ["data"], deviations: { gasLimit: { plan: R.plan!.gasLimit, actual: "70000" } } } });
    expect(r.attempt.note).toContain("deviates from the validated plan in data");
  });
  it("no receipt for the reported hash but the order is paid: the paying transaction is recovered through OrderPaid and recorded as such", async () => {
    const id = await validated();
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: null, paid: false, nonce: 9 })); // not visible yet
    expect(getAttemptRow(db, id)).toMatchObject({ state: "BROADCAST_ATTEMPTED", broadcast_block: "66000000" });
    // the event alone concludes nothing: without the paying transaction's body and receipt the attempt stays open (review round 2)
    const eventOnly = fakeRpc({ paid: true, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    expect(await reconcileWalletAttempts(db, eventOnly, { attemptId: id, source: "recover" })).toEqual({ resolved: 0, pending: 1 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "BROADCAST_ATTEMPTED", note: expect.stringContaining("not visible on this node yet") });
    const rpc = fakeRpc({ paid: true, receipt: minedReceipt(OTHER), txs: { [OTHER.toLowerCase()]: planTx({ hash: OTHER, nonce: 10 }) }, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    const r0 = await recoverAttempt(db, OWNER, id, rpc);
    expect(r0.ok).toBe(true); if (!r0.ok) return; const r = { attempt: r0.attempt as any };
    expect(r.attempt).toMatchObject({ state: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: OTHER, txHash: HASH, nonce: 10 });
    expect(r.attempt.note).toContain("fields agree with the validated plan");
    expect(r.attempt.note).toContain("OrderPaid"); expect(r.attempt.reconciliation).toHaveLength(1);
    expect(r.attempt.recovery).toMatchObject({ interrupted: true, originalTransaction: { status: "recovered-from-event" } });
    expect(rpc.calls.some((c) => c.startsWith("logs:65999998-"))).toBe(true); // the search starts two blocks before the recorded broadcast block
  });
  it("the order unpaid and the wallet's nonce consumed: NOT_MINED only once the consuming transaction is identified and does not pay; unidentified → pending", async () => {
    const id = await validated(); const n = Number(R.plan!.nonce);
    const pending = await markSent(db, OWNER, id, HASH, fakeRpc({ tx: planTx(), nonce: n }));
    expect(pending.ok && pending.attempt.state).toBe("BROADCAST_ATTEMPTED"); expect(pending.ok && pending.attempt.note).toContain("no receipt yet");
    const immediate = fakeRpc({ tx: planTx(), nonce: n + 1 });
    await observeAttempt(db, OWNER, id, immediate); expect(immediate.calls).toEqual([]); // a polling browser does not make the chain re-read within 1.5 s of the last observation
    const backdate = () => db.prepare("UPDATE wallet_attempts SET updated_at = ? WHERE attempt_id = ?").run(new Date(Date.now() - 5000).toISOString(), id);
    backdate();
    const unidentified = await observeAttempt(db, OWNER, id, fakeRpc({ tx: planTx(), nonce: n + 1 })); // the count says consumed, no block names a consumer
    expect(unidentified.ok && unidentified.attempt).toMatchObject({ state: "BROADCAST_ATTEMPTED", note: expect.stringContaining("could not be identified") });
    backdate();
    const r = await observeAttempt(db, OWNER, id, fakeRpc({ tx: planTx(), consumed: { nonce: n, block: 65_999_999n, hash: OTHER }, receipts: { [OTHER.toLowerCase()]: { transactionHash: OTHER, status: "success", blockNumber: 65_999_999n, logs: [] } } }));
    expect(r.ok && r.attempt).toMatchObject({ state: "NOT_MINED", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: expect.stringContaining(OTHER) });
    expect(r.ok && (r.attempt as any).execution).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED" });
  });
  it("a lagging node (testnet 2026-10-08): the nonce reads consumed and the receipt is hidden, but the block scan finds the reported hash → wait, then CONFIRMED when the receipt appears", async () => {
    const id = await validated(); const n = Number(R.plan!.nonce);
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: null }));
    const lagging = fakeRpc({ tx: planTx(), consumed: { nonce: n, block: 66_000_005n, hash: HASH }, hiddenReceipts: new Set([HASH.toLowerCase()]), head: 66_000_010n });
    expect(await reconcileWalletAttempts(db, lagging, { source: "worker" })).toEqual({ resolved: 0, pending: 1 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "BROADCAST_ATTEMPTED", note: expect.stringContaining("receipt is not visible") });
    const caughtUp = fakeRpc({ tx: planTx(), consumed: { nonce: n, block: 66_000_005n, hash: HASH }, receipt: minedReceipt(), paid: true, head: 66_000_010n });
    expect(await reconcileWalletAttempts(db, caughtUp, { source: "worker" })).toEqual({ resolved: 1, pending: 0 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "CONFIRMED", business_status: "SUCCESS", business_tx_hash: HASH });
  });
  it("the worker records a reconciliation entry where the browser's own observation would not", async () => {
    const id = await validated();
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: null }));
    expect(await reconcileWalletAttempts(db, fakeRpc({ tx: planTx(), receipt: minedReceipt(), paid: true }), { source: "worker" })).toEqual({ resolved: 1, pending: 0 });
    const a = getAttemptRow(db, id)!;
    expect(a.state).toBe("CONFIRMED"); expect(JSON.parse(a.reconciliation_json)).toHaveLength(1);
  });
});

describe("validated but never reported (the browser went away) — AP33-09", () => {
  it("inside the window nothing is concluded; after it the order is read; a paid order is recovered through OrderPaid; an unpaid one closes NOT_SENT after 24 h", async () => {
    const id = await validated();
    const until = new Date(FV.expiresAt).getTime();
    expect(await reconcileWalletAttempts(db, fakeRpc({ paid: true }), { source: "worker", now: new Date(until - 1000) })).toEqual({ resolved: 0, pending: 1 });
    const unpaid = fakeRpc({ paid: false });
    expect(await reconcileWalletAttempts(db, unpaid, { source: "worker", now: new Date(until + 60_000) })).toEqual({ resolved: 0, pending: 1 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "VALIDATED", note: expect.stringContaining("closed without a reported hash") });
    expect(executionReceiptOf(getAttemptRow(db, id)!, new Date(until + 60_000).toISOString())).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "UNKNOWN" });
    const paid = fakeRpc({ paid: true, receipt: minedReceipt(OTHER), txs: { [OTHER.toLowerCase()]: planTx({ hash: OTHER }) }, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    expect(await reconcileWalletAttempts(db, paid, { source: "observe", now: new Date(until + 60_000) })).toEqual({ resolved: 1, pending: 0 });
    const a = getAttemptRow(db, id)!;
    expect(a).toMatchObject({ state: "CONFIRMED", business_status: "SUCCESS", business_tx_hash: OTHER, tx_hash: OTHER });
    expect(JSON.parse(a.reconciliation_json)).toHaveLength(1); // recovered from the event: always recorded, whoever asked
    expect(paid.calls.some((c) => c.startsWith("logs:65993420-"))).toBe(true); // the search starts at the order's creation block
    // a second attempt on another order would be needed for a NOT_SENT close; here: unpaid and past 24 h
    db.prepare("UPDATE wallet_attempts SET state = 'VALIDATED', business_status = NULL, business_tx_hash = NULL, tx_hash = NULL, reconciliation_json = '[]'").run();
    expect(await reconcileWalletAttempts(db, fakeRpc({ paid: false }), { source: "worker", now: new Date(until + 25 * 3600_000) })).toEqual({ resolved: 1, pending: 0 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "NOT_SENT", business_status: "NOT_EXECUTED" });
  });
});

describe("wallet-run passport (AP33-10)", () => {
  it("exports a private wallet-mode passport with no signature and the attempt's execution receipt; an open attempt is not exported", async () => {
    const id = await validated();
    expect(await buildWalletPassport(db, id, OWNER)).toMatchObject({ ok: false, status: 409, error: "PASSPORT_NOT_READY" });
    expect(await buildWalletPassport(db, id, "visitor:b")).toMatchObject({ ok: false, status: 404 });
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: planTx(), receipt: minedReceipt(), paid: true }));
    const out = await buildWalletPassport(db, id, OWNER);
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.manifest).toMatchObject({ disclosure: "private", subject: { kind: "wallet-run", executionMode: "wallet", attemptId: id, runId: null, orderId: ORDER_ID, payer: PAYER } });
    expect(out.manifest.stageCoverage).toMatchObject({ order: true, intent: true, report: true, decision: true, finalValidation: true, transactionPlan: true, signed: false, broadcast: true });
    const text = JSON.stringify(out.bundle);
    expect(text).not.toContain("99".repeat(65)); expect(text).not.toContain("settle_payload");
    const files = fromBundle(text);
    expect(JSON.parse(files["payment.json"]).authorization).toMatchObject({ from: R.feeAuthorization!.from, nonce: R.feeAuthorization!.nonce });
    expect(JSON.parse(files["execution.json"])).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", signedTransactionHash: null, businessTxHash: HASH });
    expect(JSON.parse(files["order-summary.json"])).toMatchObject({ executionMode: "wallet", orderResult: "paid" });
    expect(JSON.parse(files["recovery.json"]).counters.businessSignatures).toBe(0); // the service never signed anything
  });
});

describe("review round 2 — recovery needs the receipt and the plan, reconcile-first inside the window, one open attempt per order", () => {
  it("a transaction found through OrderPaid that deviates from the plan closes MISMATCH, never CONFIRMED", async () => {
    const id = await validated();
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: null }));
    const rpc = fakeRpc({ paid: true, receipt: minedReceipt(OTHER), txs: { [OTHER.toLowerCase()]: planTx({ hash: OTHER, input: "0xdeadbeef" }) }, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    expect(await reconcileWalletAttempts(db, rpc, { attemptId: id, source: "worker" })).toEqual({ resolved: 1, pending: 0 });
    const a = getAttemptRow(db, id)!;
    expect(a.state).toBe("MISMATCH"); expect(JSON.parse(a.deviations_json!).mismatch).toEqual(["data"]); expect(a.note).toContain("deviates from the validated plan in data");
  });
  it("recover on a VALIDATED attempt inside its window reads the chain at once (the wallet returned an ambiguous error), while the worker still waits", async () => {
    const id = await validated();
    expect(await reconcileWalletAttempts(db, fakeRpc({ paid: false }), { attemptId: id, source: "worker" })).toEqual({ resolved: 0, pending: 1 });
    expect(getAttemptRow(db, id)!.note).toBeNull();
    const r = await recoverAttempt(db, OWNER, id, fakeRpc({ paid: false }));
    expect(r.ok && r.attempt).toMatchObject({ state: "VALIDATED", note: expect.stringContaining("recovery found no payment for this order yet") });
    const paidNow = fakeRpc({ paid: true, receipt: minedReceipt(OTHER), txs: { [OTHER.toLowerCase()]: planTx({ hash: OTHER }) }, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    const r2 = await recoverAttempt(db, OWNER, id, paidNow);
    expect(r2.ok && r2.attempt).toMatchObject({ state: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: OTHER });
  });
  it("the database refuses a second open attempt for the same order even when two requests validated concurrently", async () => {
    const id = await validated();
    const a = getAttemptRow(db, id)!;
    const dup = () => db.prepare("INSERT INTO wallet_attempts (attempt_id, owner, request_id, order_id, merchant, payer, amount_atomic, intent_digest, report_digest, decision_digest, baseline_digest, policy_digest, policy_json, decision_json, labels_json, state, reconciliation_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("dup-attempt", a.owner, a.request_id, a.order_id, a.merchant, a.payer, a.amount_atomic, a.intent_digest, a.report_digest, a.decision_digest, a.baseline_digest, a.policy_digest, a.policy_json, a.decision_json, a.labels_json, "VALIDATED", "[]", a.created_at, a.updated_at);
    expect(dup).toThrow(/UNIQUE constraint failed/);
    expect(abandonAttempt(db, OWNER, id).ok).toBe(true);
    expect(dup).not.toThrow(); // once the first is closed, a new open attempt may exist
  });
});

describe("review round 3 — durable prompt uncertainty, no closing without the transaction body, late fee receipts", () => {
  it("a prompt marker makes a VALIDATED attempt uncertain: observe reads the chain inside the window, the next action says recover first, and a refresh keeps it", async () => {
    const id = await validated();
    const { markPrompted } = await import("../src/wallet.js");
    expect(markPrompted(db, OWNER, id, { event: "nonsense" })).toMatchObject({ ok: false, status: 400 });
    expect(markPrompted(db, "visitor:b", id, { event: "prompted" })).toMatchObject({ ok: false, status: 404 });
    const prompted = markPrompted(db, OWNER, id, { event: "prompted" });
    expect(prompted.ok && (prompted.attempt as any)).toMatchObject({ state: "VALIDATED", prompt: { state: "PROMPTED" }, nextAction: expect.stringContaining("may have been submitted — recover first") });
    const unknown = markPrompted(db, OWNER, id, { event: "unknown-submission", detail: "timeout after 30s" });
    expect(unknown.ok && (unknown.attempt as any).prompt).toMatchObject({ state: "UNKNOWN_SUBMISSION", detail: "timeout after 30s" });
    expect(markPrompted(db, OWNER, id, { event: "prompted" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED" }); expect(getAttemptRow(db, id)!.prompt_json).toContain("UNKNOWN_SUBMISSION"); // a later "prompted" is refused and never downgrades the uncertainty
    // inside the window the worker still waits, but an observe read (the page after a refresh) reconciles from the chain at once
    const paid = fakeRpc({ paid: true, receipt: minedReceipt(OTHER), txs: { [OTHER.toLowerCase()]: planTx({ hash: OTHER }) }, logs: [{ transactionHash: OTHER, blockNumber: "0x3ef1a0a" }] });
    expect(await reconcileWalletAttempts(db, fakeRpc({ paid: false }), { attemptId: id, source: "worker" })).toEqual({ resolved: 0, pending: 1 });
    db.prepare("UPDATE wallet_attempts SET updated_at = ? WHERE attempt_id = ?").run(new Date(Date.now() - 5000).toISOString(), id);
    const seen = await observeAttempt(db, OWNER, id, paid);
    expect(seen.ok && (seen.attempt as any)).toMatchObject({ state: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: OTHER, prompt: { state: "UNKNOWN_SUBMISSION" } });
    expect(markPrompted(db, OWNER, id, { event: "prompted" })).toMatchObject({ ok: false, status: 409 }); // closed attempts take no prompt
  });
  it("review of 0c0d406 (P1-1): the prompt claim is exclusive — one grant, 409 PROMPT_CLAIMED with the attempt for everyone else; only the holder hands an untouched claim back", async () => {
    const id = await validated();
    const { markPrompted } = await import("../src/wallet.js");
    const first = markPrompted(db, OWNER, id, { event: "prompted", claimId: "tab-a-claim-0001" });
    expect(first.ok && (first.attempt as any).prompt).toEqual({ state: "PROMPTED", at: expect.any(String), detail: null }); // the claim id never shows in the view
    expect(getAttemptRow(db, id)!.prompt_json).toContain("tab-a-claim-0001");
    const second = markPrompted(db, OWNER, id, { event: "prompted", claimId: "tab-b-claim-0002" });
    expect(second).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED", reason: expect.stringContaining("reconcile instead of prompting again"), attempt: { attemptId: id, state: "VALIDATED", prompt: { state: "PROMPTED" } } });
    expect(getAttemptRow(db, id)!.prompt_json).toContain("tab-a-claim-0001"); // the first claim stands
    // a stranger cannot hand it back; the holder can — and the attempt is a plain VALIDATED attempt again (nothing was prompted)
    expect(markPrompted(db, OWNER, id, { event: "not-prompted", claimId: "tab-b-claim-0002" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED" });
    const released = markPrompted(db, OWNER, id, { event: "not-prompted", claimId: "tab-a-claim-0001" });
    expect(released.ok && (released.attempt as any)).toMatchObject({ state: "VALIDATED", prompt: null, note: expect.stringContaining("nothing was prompted") });
    expect(markPrompted(db, OWNER, id, { event: "not-prompted", claimId: "tab-a-claim-0001" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_NOT_CLAIMED" });
    // tab B may claim now; its ambiguous answer upgrades ITS claim; a stale "prompted" or a stranger's "unknown-submission" is refused; an UNKNOWN_SUBMISSION is never handed back
    expect(markPrompted(db, OWNER, id, { event: "prompted", claimId: "tab-b-claim-0002" }).ok).toBe(true);
    expect(markPrompted(db, OWNER, id, { event: "unknown-submission", detail: "timeout", claimId: "tab-a-claim-0001" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED" });
    const unknown = markPrompted(db, OWNER, id, { event: "unknown-submission", detail: "timeout", claimId: "tab-b-claim-0002" });
    expect(unknown.ok && (unknown.attempt as any).prompt).toMatchObject({ state: "UNKNOWN_SUBMISSION", detail: "timeout" });
    expect(markPrompted(db, OWNER, id, { event: "prompted", claimId: "tab-a-claim-0001" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED" });
    expect(markPrompted(db, OWNER, id, { event: "not-prompted", claimId: "tab-b-claim-0002" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_NOT_RELEASABLE" });
    // many interleaved claims on a fresh attempt: exactly one grant (the statement itself is the lock)
    expect(abandonAttempt(db, OWNER, id).ok).toBe(true);
    const id2 = await validated();
    const grants = Array.from({ length: 50 }, (_, k) => markPrompted(db, OWNER, id2, { event: "prompted", claimId: `claim-${String(k).padStart(4, "0")}` })).filter((r) => r.ok);
    expect(grants).toHaveLength(1);
    // a claim id outside the accepted shape is replaced by a server-generated one; the holder then cannot hand it back (it never learns the id) — reconciliation decides
    expect(abandonAttempt(db, OWNER, id2).ok).toBe(true);
    const id3 = await validated();
    expect(markPrompted(db, OWNER, id3, { event: "prompted", claimId: "x" }).ok).toBe(true);
    expect(markPrompted(db, OWNER, id3, { event: "not-prompted", claimId: "x" })).toMatchObject({ ok: false, status: 409, error: "PROMPT_CLAIMED" });
  });
  it("a receipt without the transaction body leaves the attempt open until the plan comparison can be made", async () => {
    const id = await validated();
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: null }));
    const receiptOnly = fakeRpc({ tx: null, receipt: minedReceipt(), paid: true });
    expect(await reconcileWalletAttempts(db, receiptOnly, { attemptId: id, source: "worker" })).toEqual({ resolved: 0, pending: 1 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "BROADCAST_ATTEMPTED", note: expect.stringContaining("comparison with the validated plan is outstanding") });
    const withBody = fakeRpc({ tx: planTx({ input: "0xdeadbeef" }), receipt: minedReceipt(), paid: false });
    expect(await reconcileWalletAttempts(db, withBody, { attemptId: id, source: "worker" })).toEqual({ resolved: 1, pending: 0 });
    expect(getAttemptRow(db, id)).toMatchObject({ state: "MISMATCH" }); // the comparison was made before closing — it caught the deviation
  });
  it("a closed attempt still receives its fee relay receipt later (observe and the worker backfill)", async () => {
    const id = await validated();
    await markSent(db, OWNER, id, HASH, fakeRpc({ tx: planTx(), receipt: minedReceipt(), paid: true })); // closes without a fee receipt (the fake serves none)
    expect(getAttemptRow(db, id)).toMatchObject({ state: "CONFIRMED", fee_receipt_json: null });
    const feeRpc = fakeRpc({ receipts: { [F.hashes.FEE_TX.toLowerCase()]: { transactionHash: F.hashes.FEE_TX, status: "success", blockNumber: 65_993_438n, from: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0", gasUsed: 87_141n, effectiveGasPrice: 25_000_000_000n } } });
    const seen = await observeAttempt(db, OWNER, id, feeRpc);
    expect(seen.ok && (seen.attempt as any).costStatement.operator).toMatchObject({ complete: true, feeRelay: { gasUsed: "87141" } });
    db.prepare("UPDATE wallet_attempts SET fee_receipt_json = NULL WHERE attempt_id = ?").run(id);
    const { backfillFeeReceipts } = await import("../src/wallet.js");
    expect(await backfillFeeReceipts(db, feeRpc)).toBe(1);
    expect(getAttemptRow(db, id)!.fee_receipt_json).toContain("87141");
  });
});
