import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { openDb, run, type Db } from "../src/db.js";
import { syntheticRun, RELAYER, USDC } from "../../../packages/passport/test/fixture.js";
import { fromBundle } from "@arcpreflight/passport";
import { verifyPassport } from "../../../packages/verifier/src/index.js";

// The API's passport assembly against a schema-valid synthetic run (the exporter/verifier packages test the format itself).
const fixture = syntheticRun("APPROVED");
const review = syntheticRun("REVIEW_REQUIRED");
vi.mock("../src/config.js", () => ({ cfg: {
  root: "/offline/passport", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", rpc: "http://offline.invalid", port: 4040, releaseSha: "test-release", profile: "SUBMISSION_RESTRICTED", publicExecution: true,
  usdc: "0x3600000000000000000000000000000000000000", priceTokenAtomic: "10000", merchant: { address: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0" }, principals: new Map(), supportedTargets: [],
} }));
vi.mock("../src/report.js", () => ({ client: {
  getTransaction: async ({ hash }: { hash: string }) => fixture.txs[hash.toLowerCase()] ?? review.txs[hash.toLowerCase()] ?? null,
  getTransactionReceipt: async ({ hash }: { hash: string }) => fixture.receipts[hash.toLowerCase()] ?? review.receipts[hash.toLowerCase()] ?? null,
} }));
vi.mock("../src/payments.js", () => ({ openJson: async (s: string) => JSON.parse(s), sealJson: async (o: unknown) => JSON.stringify(o) }));
import { buildRunPassport, buildCheckPassport, runRecovery, runCostStatement } from "../src/passport.js";

let db: Db;
const RUN = "33333333-3333-4333-8333-333333333333";
function seed(d: Db, f: ReturnType<typeof syntheticRun>, runId: string, state = "DONE") {
  const r = f.source.result!; const ts = new Date().toISOString();
  run(d, "INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)", runId, r.fixture, state, JSON.stringify(r.steps), '["LIVE_REQUEST"]', ts, ts, "client-x", JSON.stringify(r));
  run(d, "INSERT OR IGNORE INTO baselines (baseline_digest, subject, baseline_json, revoked, created_at) VALUES (?,?,?,?,?)", f.digests.baseline, f.source.baseline!.subject, JSON.stringify(f.source.baseline), 0, ts);
  run(d, "INSERT OR IGNORE INTO reports (report_digest, request_id, subject, mode, report_json, evidence_json, is_public, created_at) VALUES (?,?,?,?,?,?,?,?)", f.digests.report, r.requestId, r.merchant.toLowerCase(), "SUPPORTED_INTENT", JSON.stringify(r.report), JSON.stringify({ evidence: f.source.reportEvidence, simulation: { ok: true, error: null } }), 0, ts);
  run(d, "INSERT OR IGNORE INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, backend, tx_hash, settlement_evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    r.requestId, `ap_${r.requestId}`, "eip155:5042002", USDC.toLowerCase(), r.intent.from, r.feeAuthorization!.nonce, "COMPLETED", ts, ts, "relay", f.hashes.FEE_TX, JSON.stringify(f.source.settlement!.evidence));
}
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => db.close());

describe("passport export from the API's records (design v3.2 §13)", () => {
  it("exports a bundle that the independent verifier accepts offline and online, with no FAIL and no secrets", async () => {
    seed(db, fixture, RUN);
    const out = await buildRunPassport(db, RUN);
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.manifest).toMatchObject({ passportVersion: "1.0", disclosure: "public", subject: { kind: "demo-run", runId: RUN }, generator: { release: "test-release", component: "api" } });
    expect(out.manifest.stageCoverage).toMatchObject({ finalValidation: true, signed: true, broadcast: true, postcondition: true });
    const text = JSON.stringify(out.bundle);
    expect(text).not.toContain("privateKey"); expect(text).not.toContain("raw_tx"); expect(text).not.toContain("settle_payload");
    const files = fromBundle(text);
    const feeCapture = JSON.parse(files["evidence/chain/fee-tx.json"]);
    expect(feeCapture.tx.input).toBeNull(); expect(feeCapture.tx.inputKeccak256).toMatch(/^0x[0-9a-f]{64}$/); // the calldata carries the buyer's signature: redacted
    expect(JSON.parse(files["payment.json"]).authorization.signature).toBeUndefined();
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "intent.json", "baseline.json", "report.json", "decision.json", "transaction-plan.json", "final-validation.json", "execution.json", "payment.json", "cost-statement.json", "recovery.json", "evidence/postcondition.json", "evidence/chain/fee-tx.json", "evidence/chain/business-tx.json", "verify.md"]));
    const v = await verifyPassport(files, { rpc: fixture.rpc(), anchors: fixture.anchors });
    expect(v.counts.fail).toBe(0);
    const by = Object.fromEntries(v.findings.map((f) => [f.id, f.status]));
    expect(by).toMatchObject({ FILE_INTEGRITY: "PASS", DIGEST_INTEGRITY: "PASS", DISCLOSURE: "PASS", APPROVAL_SOURCE: "PASS", NETWORK_IDENTITY: "PASS", FEE_ATTRIBUTION: "PASS", TRANSACTION_PLAN_AGREEMENT: "PASS", ORDER_OUTCOME: "PASS", CURRENT_ELIGIBILITY: "NOT_EVALUATED" });
    const cost = JSON.parse(files["cost-statement.json"]);
    expect(cost.operator.feeRelay.address.toLowerCase()).toBe(RELAYER.toLowerCase());
    expect(cost.buyer.businessPrincipal.usdc).toBe("0.05");
  });
  it("a REVIEW_REQUIRED run exports without plan or execution files and the verifier leaves the transaction checks unverified", async () => {
    seed(db, review, RUN);
    const out = await buildRunPassport(db, RUN); expect(out.ok).toBe(true); if (!out.ok) return;
    const files = fromBundle(JSON.stringify(out.bundle));
    expect(files["transaction-plan.json"]).toBeUndefined(); expect(files["final-validation.json"]).toBeUndefined();
    expect(out.manifest.stageCoverage).toMatchObject({ signed: false, broadcast: false });
    const v = await verifyPassport(files, { rpc: review.rpc(), anchors: review.anchors });
    expect(v.counts.fail).toBe(0);
    expect(v.findings.find((f) => f.id === "TRANSACTION_PLAN_AGREEMENT")?.status).not.toBe("PASS");
  });
  it("refuses while the run is in progress, when nothing is recorded, and for unknown runs", async () => {
    expect(await buildRunPassport(db, RUN)).toMatchObject({ ok: false, status: 404 });
    seed(db, fixture, RUN, "RUNNING");
    expect(await buildRunPassport(db, RUN)).toMatchObject({ ok: false, status: 409, error: "PASSPORT_NOT_READY" });
    run(db, "UPDATE demo_runs SET state = 'FAILED', result_json = NULL WHERE run_id = ?", RUN);
    expect(await buildRunPassport(db, RUN)).toMatchObject({ ok: false, status: 409, error: "PASSPORT_NOT_READY" });
  });
  it("the run JSON's recovery summary and cost statement come from the same functions as the passport files", () => {
    const r = fixture.source.result!;
    const rec = runRecovery(r, r.steps)!;
    expect(rec).toMatchObject({ recoveryVersion: "1.0", attemptId: r.attemptId, counters: { ordersCreated: 1, checkFeeAuthorizations: 1, businessSignatures: 1, broadcastsOfOriginalBytes: 1, replacementSignatures: 0 }, originalTransaction: { status: "confirmed" } });
    const withReceipts = { ...r, feeReceipt: { from: RELAYER, gasUsed: "87141", effectiveGasPriceNativeAtomic: "25000000000", blockNumber: "65993438" }, businessReceipt: { from: r.intent.from, gasUsed: "40364", effectiveGasPriceNativeAtomic: "21000000000", blockNumber: "65993462", status: "success" }, orderCreation: { tx: fixture.hashes.CREATE_TX, block: "65993420", from: "0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b", gasUsed: "98107", effectiveGasPriceNativeAtomic: "21000000000", signer: "order-creator" } };
    const cost = runCostStatement(withReceipts)!;
    expect(cost.buyer.businessGas).toMatchObject({ usdc: "0.000847644", gasUsed: "40364" });
    expect(cost.operator.feeRelay).toMatchObject({ usdc: "0.002178525" });
    expect(cost.operator.orderCreation).toMatchObject({ usdc: "0.002060247" });
    expect(cost.buyer.checkFee).toMatchObject({ tokenAtomic: "10000", usdc: "0.01" });
    expect(runCostStatement({ ...r, feeReceipt: null, businessReceipt: null, orderCreation: undefined })!.buyer.businessGas).toBeNull(); // nothing estimated as if measured
  });
  it("a paid-check passport is private, carries the quote and the signature-less authorization, and never the decision", async () => {
    const r = fixture.source.result!; const ts = new Date().toISOString();
    run(db, "INSERT INTO requests (request_id, principal, client_request_id, intent_json, intent_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", r.requestId, "buyer", r.intent.clientRequestId, JSON.stringify(r.intent), r.intentDigest, "DELIVERED", ts, ts);
    run(db, "INSERT INTO quotes (request_id, quote_json, quote_digest, report_digest, expires_at, created_at) VALUES (?,?,?,?,?,?)", r.requestId, JSON.stringify(r.quote), "0x" + "77".repeat(32), r.reportDigest, ts, ts);
    seed(db, fixture, RUN);
    const payload = JSON.stringify({ paymentPayload: { payload: { signature: "0x" + "42".repeat(65), authorization: { ...r.feeAuthorization } } }, paymentRequirements: {} });
    run(db, "UPDATE payments SET settle_payload_encrypted = ? WHERE request_id = ?", payload, r.requestId);
    expect(await buildCheckPassport(db, r.requestId, "someone-else")).toMatchObject({ ok: false, status: 404 });
    const out = await buildCheckPassport(db, r.requestId, "buyer"); expect(out.ok).toBe(true); if (!out.ok) return;
    const text = JSON.stringify(out.bundle); expect(text).not.toContain("42".repeat(65));
    const files = fromBundle(text);
    expect(out.manifest.disclosure).toBe("private"); expect(out.manifest.subject.kind).toBe("paid-check");
    expect(files["decision.json"]).toBeUndefined(); expect(files["execution.json"]).toBeUndefined();
    const payment = JSON.parse(files["payment.json"]);
    expect(payment.authorization).toMatchObject({ from: r.feeAuthorization!.from, nonce: r.feeAuthorization!.nonce }); expect(payment.authorization.signature).toBeUndefined();
    expect(payment.settlement).toMatchObject({ backend: "relay", state: "COMPLETED", transactionHash: fixture.hashes.FEE_TX });
    const v = await verifyPassport(files, { rpc: fixture.rpc(), anchors: fixture.anchors });
    expect(v.counts.fail).toBe(0);
  });
});
