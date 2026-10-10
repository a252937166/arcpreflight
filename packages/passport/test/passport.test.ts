import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToBytes } from "viem";
import { executionDigest } from "@arcpreflight/schema";
import { buildPassport, toBundle, bundleToString, fromBundle, validatePaths, validateFiles, costStatement, recoverySummary, formatAtomic, sha256File, utf8Length, PassportFormatError, type Manifest } from "../src/index.js";
import { readPassportDirectory, writePassportDirectory } from "../src/node.js";
import { syntheticRun, RELAYER, ORDER_CREATOR, PAYER, FEE_TX, BIZ_TX, CREATE_TX } from "./fixture.js";

const SIG65 = /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/;
const FORBIDDEN = /"(privateKey|private_key|relay_raw_tx[A-Za-z_]*|settle_payload[A-Za-z_]*|raw_tx_encrypted)"\s*:/;
const json = (files: Record<string, string>, p: string) => JSON.parse(files[p]);

describe("buildPassport — approved run", () => {
  const f = syntheticRun("APPROVED");
  const { files, manifest } = buildPassport(f.source);
  const paths = Object.keys(files).sort();
  it("produces every file of the layout", () => {
    for (const p of ["manifest.json", "order-summary.json", "intent.json", "baseline.json", "policy.json", "report.json", "decision.json", "transaction-plan.json", "final-validation.json", "execution.json", "payment.json", "cost-statement.json", "recovery.json", "evidence/postcondition.json", "evidence/chain/fee-tx.json", "evidence/chain/business-tx.json", "evidence/chain/create-order-tx.json", "verification-profile.json", "verify.md"]) expect(paths).toContain(p);
    expect(paths.filter((p) => p.startsWith("evidence/report/"))).toHaveLength(2);
    expect(paths.filter((p) => p.startsWith("evidence/final-validation/"))).toHaveLength(4);
    expect(manifest.omissions).toEqual([]);
    expect(manifest.stageCoverage).toEqual({ order: true, intent: true, quote: true, feeSettlement: true, report: true, decision: true, finalValidation: true, transactionPlan: true, signed: true, broadcast: true, postcondition: true, reconciliation: false });
    expect(manifest.subject).toMatchObject({ kind: "demo-run", fixture: "APPROVED_PAYMENT", payer: PAYER });
  });
  it("lists every file except itself with matching sha256 and size, never hashing itself", () => {
    const listed = manifest.files.map((e) => e.path).sort();
    expect(listed).toEqual(paths.filter((p) => p !== "manifest.json"));
    for (const e of manifest.files) { expect(e.sha256).toBe(sha256File(files[e.path])); expect(e.bytes).toBe(utf8Length(files[e.path])); }
    expect(manifest.files.find((e) => e.path === "manifest.json")).toBeUndefined();
  });
  it("records object digests that equal what the receipts reference", () => {
    const obj = (p: string) => manifest.files.find((e) => e.path === p)!.object!;
    const r = f.source.result!;
    expect(obj("intent.json")).toMatchObject({ kind: "intent", schemaVersion: "1.0", digestProfile: "arcpreflight-jcs-keccak-1.0", digest: f.digests.intent });
    expect(obj("baseline.json").digest).toBe(f.digests.baseline);
    expect(obj("execution.json").digest).toBe(r.executionDigest);
    expect(obj("final-validation.json").digest).toBe(r.execution.finalValidationDigest);
    expect(obj("transaction-plan.json").digest).toBe(r.execution.transactionPlanDigest);
    expect(obj("decision.json").digest).toBe(f.digests.decision);
    for (const e of f.source.reportEvidence) expect(obj(`evidence/report/${e.digest}.json`).digest).toBe(e.digest);
    expect(manifest.files.find((e) => e.path === "verify.md")!.object).toBeNull();
  });
  it("stores the post-condition record as the byte-exact preimage of its legacy digest", () => {
    const r = f.source.result!;
    expect(files["evidence/postcondition.json"]).toBe(JSON.stringify(r.postcondition));
    const entry = manifest.files.find((e) => e.path === "evidence/postcondition.json")!.object!;
    expect(entry).toMatchObject({ kind: "postcondition", schemaVersion: null, digestProfile: "legacy-json-stringify-keccak-1.0" });
    expect(entry.digest).toBe(keccak256(stringToBytes(files["evidence/postcondition.json"])));
    expect(r.execution.postconditionEvidenceDigests).toContain(entry.digest);
  });
  it("redacts the fee transaction's calldata and keeps the business calldata", () => {
    const fee = json(files, "evidence/chain/fee-tx.json"), biz = json(files, "evidence/chain/business-tx.json");
    expect(fee.tx.input).toBeNull(); expect(fee.tx.inputKeccak256).toMatch(/^0x[0-9a-f]{64}$/); expect(fee.note).toMatch(/calldata redacted/);
    expect(biz.tx.input).toBe(f.source.result!.intent.data);
    expect(manifest.notes.join(" ")).toMatch(/labelled captures/);
  });
  it("never discloses signatures, keys or encrypted payloads — even when the exporter is handed a signed authorization", () => {
    const leaky = structuredClone(f.source);
    (leaky.payment!.authorization as any).signature = "0x" + "ee".repeat(65);
    const out = buildPassport(leaky).files;
    for (const [p, content] of Object.entries(out)) { expect(content, p).not.toMatch(SIG65); expect(content, p).not.toMatch(FORBIDDEN); }
    expect(json(out, "payment.json").authorization).not.toHaveProperty("signature");
    expect(json(out, "payment.json")).toMatchObject({ scheme: "x402/exact", assetTransferMethod: "eip3009", settlement: { backend: "relay", state: "COMPLETED", relayer: RELAYER, transactionHash: FEE_TX, blockNumber: "65993438", authorizationUsedLogIndex: 17, transferLogIndex: 19 } });
  });
  it("derives the order summary, cost statement and recovery counters from the records", () => {
    expect(json(files, "order-summary.json")).toMatchObject({ orderResult: "paid", serviceOutcome: "NOT_EVALUATED", amountUsdc: "0.05", decision: "NO_POLICY_VIOLATION", chainResult: "CONFIRMED", createOrder: { tx: CREATE_TX, block: "65993420", signer: "order-creator" }, checkFee: { tokenAtomic: "10000", usdc: "0.01", tx: FEE_TX }, businessTx: BIZ_TX, referencedApproval: { baselineDigest: f.digests.baseline, baselineResult: "MATCH", statusAtFinalValidation: { revoked: false } } });
    const cost = json(files, "cost-statement.json");
    expect(cost.buyer.businessGas).toMatchObject({ gasUsed: "40364", effectiveGasPriceNativeAtomic: "21000000000", nativeAtomic: "847644000000000", usdc: "0.000847644", tx: BIZ_TX });
    expect(cost.operator.feeRelay).toMatchObject({ address: RELAYER, nativeAtomic: "2178525000000000", usdc: "0.002178525", tx: FEE_TX });
    expect(cost.operator.orderCreation).toMatchObject({ address: ORDER_CREATOR, nativeAtomic: "2060247000000000", usdc: "0.002060247" });
    expect(cost.buyer).toMatchObject({ totalNativeAtomic: "60847644000000000", totalUsdc: "0.060847644", businessPrincipal: { nativeAtomic: "50000000000000000", usdc: "0.05" }, checkFee: { tokenAtomic: "10000", nativeAtomicEquivalent: "10000000000000000", usdc: "0.01" } });
    expect(cost.operator).toMatchObject({ totalNativeAtomic: "4238772000000000", totalUsdc: "0.004238772" });
    expect(cost.authorizedMaximum).toEqual({ businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: "1260000000000000" });
    expect(json(files, "recovery.json")).toMatchObject({ interrupted: false, counters: { ordersCreated: 1, checkFeeAuthorizations: 1, businessSignatures: 1, broadcastsOfOriginalBytes: 1, replacementSignatures: 0 }, originalTransaction: { hash: BIZ_TX, status: "confirmed" }, reconciliation: [] });
    expect(json(files, "verification-profile.json")).toMatchObject({ acceptedDigestProfiles: ["arcpreflight-jcs-keccak-1.0", "legacy-json-stringify-keccak-1.0", "sha256-file-1.0"], neverEvaluated: ["CURRENT_ELIGIBILITY"], rpc: { chainId: 5042002 } });
  });
  it("round-trips through the bundle form byte for byte", () => {
    const text = bundleToString(files);
    expect(fromBundle(text)).toEqual(files);
    expect(toBundle(files).passportBundleVersion).toBe("1.0");
    expect(Object.keys(toBundle(files).files)).toEqual(paths);
  });
});

describe("buildPassport — other shapes and refusals", () => {
  it("a REVIEW_REQUIRED run has no plan, validation, post-condition or business capture and counts nothing as paid", () => {
    const f = syntheticRun("REVIEW_REQUIRED");
    const { files, manifest } = buildPassport(f.source);
    for (const p of ["transaction-plan.json", "final-validation.json", "evidence/postcondition.json", "evidence/chain/business-tx.json"]) expect(files[p]).toBeUndefined();
    expect(manifest.stageCoverage).toMatchObject({ finalValidation: false, transactionPlan: false, signed: false, broadcast: false, postcondition: false, feeSettlement: true });
    expect(json(files, "order-summary.json")).toMatchObject({ orderResult: "unpaid", decision: "REVIEW_REQUIRED", chainResult: "NOT_SIGNED", businessTx: null, referencedApproval: { baselineResult: "IMPLEMENTATION_CHANGED", statusAtFinalValidation: null } });
    const cost = json(files, "cost-statement.json");
    expect(cost.buyer.businessPrincipal).toEqual({ nativeAtomic: "0", usdc: "0" }); expect(cost.buyer.businessGas).toBeNull(); expect(cost.authorizedMaximum.businessGasNativeAtomic).toBeNull();
    expect(cost.buyer.totalNativeAtomic).toBe("10000000000000000");
    expect(json(files, "recovery.json")).toMatchObject({ counters: { businessSignatures: 0, broadcastsOfOriginalBytes: 0 }, originalTransaction: { hash: null, status: "none" } });
  });
  it("lists an omitted baseline instead of inventing one", () => {
    const f = syntheticRun(); const { files, manifest } = buildPassport({ ...f.source, baseline: null });
    expect(files["baseline.json"]).toBeUndefined();
    expect(manifest.omissions).toEqual([{ path: "baseline.json", reason: expect.stringMatching(/did not return the referenced baseline/) }]);
  });
  it("refuses a baseline that is not the approval the intent references", () => {
    const f = syntheticRun();
    expect(() => buildPassport({ ...f.source, baseline: { ...f.source.baseline!, approvedBy: "someone-else" } })).toThrow(/not the approval the intent references/);
  });
  it("refuses evidence whose digest does not match its content, and a report bound to another intent", () => {
    const f = syntheticRun();
    const bad = structuredClone(f.source); bad.reportEvidence[0].digest = ("0x" + "00".repeat(32)) as `0x${string}`;
    expect(() => buildPassport(bad)).toThrow(/does not match its content/);
    const other = structuredClone(f.source); other.result!.report.intentDigest = ("0x" + "11".repeat(32)) as `0x${string}`;
    expect(() => buildPassport(other)).toThrow(/different intent/);
  });
  it("refuses a post-condition record the execution receipt does not reference, and an execution digest that does not match", () => {
    const f = syntheticRun();
    const detached = structuredClone(f.source); detached.result!.execution.postconditionEvidenceDigests = []; detached.result!.executionDigest = ("0x" + "22".repeat(32)) as `0x${string}`;
    expect(() => buildPassport(detached)).toThrow(/execution receipt digest does not match/);
    detached.result!.executionDigest = executionDigest(detached.result!.execution) as `0x${string}`;
    expect(() => buildPassport(detached)).toThrow(/not referenced by the execution receipt/);
  });
  it("records the execution mode: demo-run defaults to runner, wallet-run to wallet, in the manifest subject, the order summary and verify.md; inconsistent pairs are refused", () => {
    const runner = buildPassport(syntheticRun("APPROVED").source);
    expect(runner.manifest.subject).toMatchObject({ kind: "demo-run", executionMode: "runner" });
    expect(json(runner.files, "order-summary.json").executionMode).toBe("runner");
    const w = syntheticRun("WALLET"); const { files, manifest } = buildPassport(w.source);
    expect(manifest.subject).toMatchObject({ kind: "wallet-run", executionMode: "wallet", runId: null, payer: PAYER });
    expect(json(files, "order-summary.json")).toMatchObject({ executionMode: "wallet", orderResult: "paid", businessTx: BIZ_TX });
    expect(files["verify.md"]).toMatch(/Execution mode: wallet/); expect(files["verify.md"]).toMatch(/wallet-set gas, fees and nonce as recorded deviations/);
    expect(json(files, "transaction-plan.json")).toMatchObject({ nonce: "9", gasLimit: "60000" }); // the plan is the service's; the wallet's choices live only on chain
    expect(json(files, "cost-statement.json").authorizedMaximum.businessGasNativeAtomic).toBe("1260000000000000");
    const base = syntheticRun("APPROVED").source;
    expect(() => buildPassport({ ...base, subject: { ...base.subject, executionMode: "wallet" } })).toThrow(/inconsistent with executionMode wallet/);
    expect(() => buildPassport({ ...base, subject: { ...base.subject, kind: "wallet-run", executionMode: "runner" } })).toThrow(/inconsistent with executionMode runner/);
    expect(() => buildPassport({ ...base, subject: { kind: "wallet-run", runId: null, attemptId: null }, result: null, check: { intent: base.result!.intent, report: base.result!.report } })).toThrow(/wallet-run passport needs the execution result/);
  });
  it("maps a reconciliation that found the payment through the OrderPaid event to recovered-from-event (recovery.ts table)", () => {
    const f = syntheticRun("WALLET"); const r = f.source.result!;
    const viaEvent = [{ at: "2026-10-08T10:06:00.000Z", chainStatus: "CONFIRMED", businessStatus: "SUCCESS", note: "recovered from the merchant's OrderPaid(orderId) log: hash never reported by the wallet" }];
    expect(recoverySummary(r.attemptId, r.steps, r.execution, viaEvent).originalTransaction).toEqual({ hash: BIZ_TX, status: "recovered-from-event" });
    expect(recoverySummary(r.attemptId, r.steps, r.execution, [{ ...viaEvent[0], note: "receipt found at block 65993462" }]).originalTransaction.status).toBe("recovered-confirmed");
    expect(recoverySummary(r.attemptId, r.steps, r.execution, []).originalTransaction.status).toBe("confirmed");
    const { files, manifest } = buildPassport({ ...f.source, reconciliation: viaEvent });
    expect(json(files, "recovery.json")).toMatchObject({ interrupted: true, originalTransaction: { status: "recovered-from-event" }, reconciliation: viaEvent });
    expect(manifest.stageCoverage.reconciliation).toBe(true);
  });
  it("builds the private paid-check variant without decision or execution", () => {
    const f = syntheticRun(); const r = f.source.result!;
    const { files, manifest } = buildPassport({ ...f.source, disclosure: "private", subject: { kind: "paid-check", runId: null, attemptId: null }, result: null, check: { intent: r.intent, report: r.report }, chainCaptures: {} });
    expect(Object.keys(files).sort()).toEqual(["baseline.json", ...f.source.reportEvidence.map((e) => `evidence/report/${e.digest}.json`), "intent.json", "manifest.json", "payment.json", "report.json", "verification-profile.json", "verify.md"].sort());
    expect(manifest).toMatchObject({ disclosure: "private", subject: { kind: "paid-check" }, stageCoverage: { decision: false, finalValidation: false, order: false } });
  });
});
describe("path and size rules", () => {
  it("accepts the layout and rejects every forbidden shape", () => {
    expect(validatePaths(["manifest.json", "evidence/report/0xab.json", "verify.md"]).ok).toBe(true);
    for (const bad of ["/abs.json", "../up.json", "a/../b.json", "a/./b.json", "a//b.json", "back\\slash.json", "spa ce.json", "ünicode.json", "x".repeat(201)]) expect(validatePaths([bad]).ok, bad).toBe(false);
    expect(validatePaths(["A.json", "a.json"]).problems.join()).toMatch(/duplicate/);
    expect(validatePaths(Array.from({ length: 201 }, (_, i) => `f${i}.json`)).problems.join()).toMatch(/exceed/);
  });
  it("validateFiles requires the manifest and bounds the total size", () => {
    expect(validateFiles({ "a.json": "{}" }).problems.join()).toMatch(/manifest\.json is missing/);
    expect(validateFiles({ "manifest.json": "{}", "big.json": "x".repeat(4 * 1024 * 1024 + 1) }).problems.join()).toMatch(/total size/);
  });
  it("fromBundle refuses wrong versions, traversal, duplicates, non-string content and oversized sets", () => {
    const f = syntheticRun(); const { files } = buildPassport(f.source);
    expect(() => fromBundle(JSON.stringify({ passportBundleVersion: "2.0", files }))).toThrow(PassportFormatError);
    expect(() => fromBundle({ passportBundleVersion: "1.0", files: { ...files, "../evil.json": "{}" } })).toThrow(/'\.' and '\.\.'/);
    expect(() => fromBundle({ passportBundleVersion: "1.0", files: { ...files, "/etc/passwd": "x" } })).toThrow(/absolute/);
    expect(() => fromBundle({ passportBundleVersion: "1.0", files: { ...files, "INTENT.json": "{}" } })).toThrow(/duplicate/);
    expect(() => fromBundle({ passportBundleVersion: "1.0", files: { ...files, "n.json": 42 } })).toThrow(/must be a string/);
    expect(() => fromBundle({ passportBundleVersion: "1.0", files: Object.fromEntries([["manifest.json", "{}"], ...Array.from({ length: 200 }, (_, i) => [`f${i}.json`, "{}"])]) })).toThrow(/exceed/);
    expect(() => fromBundle("not json")).toThrow(/not valid JSON/);
  });
});

describe("cost statement and recovery helpers", () => {
  it("uses exact BigInt arithmetic and exact decimal strings", () => {
    expect(formatAtomic(2178525000000000n, 18)).toBe("0.002178525"); expect(formatAtomic("50000000000000000", 18)).toBe("0.05"); expect(formatAtomic(10000n, 6)).toBe("0.01"); expect(formatAtomic(0n, 18)).toBe("0"); expect(formatAtomic(1n, 18)).toBe("0.000000000000000001"); expect(formatAtomic(10n ** 18n, 18)).toBe("1");
    const c = costStatement({ buyer: PAYER, relayer: RELAYER, orderCreator: ORDER_CREATOR, businessPrincipalNativeAtomic: "50000000000000000", businessPaid: true, checkFeeTokenAtomic: "10000", plan: { gasLimit: "60000", maxFeePerGasNativeAtomic: "21000000000" }, policy: { maxNativePaymentAtomic: "50000000000000000", maxServiceFeeTokenAtomic: "10000" },
      receipts: { feeTx: { gasUsed: 87141n, effectiveGasPrice: "25000000000" }, businessTx: { gasUsed: "40364", effectiveGasPrice: 21000000000n }, createOrderTx: null }, txs: { feeTx: FEE_TX, businessTx: BIZ_TX, createOrderTx: CREATE_TX }, capturedAt: "2026-10-08T10:05:00.000Z" });
    expect(c.operator.feeRelay!.usdc).toBe("0.002178525"); expect(c.buyer.businessGas!.usdc).toBe("0.000847644"); expect(c.operator.orderCreation).toBeNull();
    expect(c.notes).toContain("order-creation receipt unavailable at export: operator.orderCreation is null, not estimated");
    expect(c.actual).toEqual({ businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: "847644000000000" });
    expect(c.unresolvedReservation).toEqual({ nativeAtomic: "0", note: "reservations released only after reconciliation" });
  });
  it("maps execution outcomes to recovery statuses and counts steps", () => {
    const base = syntheticRun().source.result!;
    const exec = (chainStatus: string, businessStatus: string) => ({ ...base.execution, chainStatus, businessStatus } as any);
    expect(recoverySummary("a", base.steps, exec("CONFIRMED", "SUCCESS")).originalTransaction.status).toBe("confirmed");
    expect(recoverySummary("a", base.steps, exec("CONFIRMED", "SUCCESS"), [{ at: "t", chainStatus: "CONFIRMED", businessStatus: "SUCCESS", note: "reconciled from the original transaction hash and the order state" }])).toMatchObject({ interrupted: true, originalTransaction: { status: "recovered-confirmed" } });
    expect(recoverySummary("a", base.steps, exec("SIGNED_NOT_BROADCAST", "NOT_EXECUTED")).originalTransaction.status).toBe("not-sent");
    expect(recoverySummary("a", base.steps, exec("UNKNOWN", "NOT_EXECUTED")).originalTransaction.status).toBe("not-mined");
    expect(recoverySummary("a", base.steps, exec("UNKNOWN", "UNKNOWN")).originalTransaction.status).toBe("unresolved");
    expect(recoverySummary("a", base.steps, exec("REVERTED", "FAILED")).originalTransaction.status).toBe("reverted");
    expect(recoverySummary("a", base.steps, exec("NOT_SIGNED", "NOT_EXECUTED")).originalTransaction.status).toBe("none");
    const steps = [...base.steps, { step: "rebroadcast", atMs: 1 }, { step: "reconciled", atMs: 2, at: "2026-10-08T11:00:00.000Z", chainStatus: "CONFIRMED", businessStatus: "SUCCESS", why: "from receipt" }];
    const s = recoverySummary("a", steps, exec("CONFIRMED", "SUCCESS"));
    expect(s.counters.broadcastsOfOriginalBytes).toBe(2); expect(s.reconciliation).toEqual([{ at: "2026-10-08T11:00:00.000Z", chainStatus: "CONFIRMED", businessStatus: "SUCCESS", note: "from receipt" }]); expect(s.originalTransaction.status).toBe("recovered-confirmed");
    expect(recoverySummary("a", [...base.steps, { step: "signed", atMs: 3 }], exec("CONFIRMED", "SUCCESS")).counters.replacementSignatures).toBe(1);
  });
});

describe("directory form (node)", () => {
  it("writes once, reads back identically, refuses overwrites and symlinks", () => {
    const f = syntheticRun(); const { files } = buildPassport(f.source);
    const dir = join(mkdtempSync(join(tmpdir(), "passport-")), "payment-passport");
    const written = writePassportDirectory(dir, files);
    expect(written.sort()).toEqual(Object.keys(files).sort());
    expect(readPassportDirectory(dir)).toEqual(files);
    expect(() => writePassportDirectory(dir, files)).toThrow(/already exists/);
    const other = mkdtempSync(join(tmpdir(), "passport-link-"));
    writePassportDirectory(other, files);
    writeFileSync(join(other, "..", "outside.json"), "{}");
    symlinkSync(join(other, "..", "outside.json"), join(other, "linked.json"));
    expect(() => readPassportDirectory(other)).toThrow(/symlinks are refused/);
    const m: Manifest = JSON.parse(files["manifest.json"]); expect(m.passportVersion).toBe("1.0");
  });
});

describe("cost statement 1.1 — completeness and role", () => {
  it("flags a missing business-gas receipt as incomplete instead of counting it as zero, and names the buyer's role", async () => {
    const { costStatement } = await import("../src/cost.js");
    const base = { buyer: "0x00000000000000000000000000000000000000aa" as const, relayer: null, orderCreator: null, businessPrincipalNativeAtomic: "50000000000000000", businessPaid: true, checkFeeTokenAtomic: "10000", plan: null, policy: null, receipts: {}, txs: { businessTx: ("0x" + "44".repeat(32)) as `0x${string}` } };
    const incomplete = costStatement({ ...base, buyerRole: "visitor-wallet" });
    expect(incomplete.costStatementVersion).toBe("1.1");
    expect(incomplete.buyer).toMatchObject({ role: "visitor-wallet", complete: false, businessGas: null, totalUsdc: "0.06" });
    expect(incomplete.notes).toContain("buyer total is incomplete: business gas not available");
    expect(incomplete.operator.complete).toBe(false); // a counted check fee whose settlement transaction is not recorded is missing evidence (review of bf0c800, P2)
    expect(incomplete.notes).toContain("fee relay evidence missing: no settlement transaction hash is recorded for the settled check fee; operator.feeRelay is null, not estimated");
    expect(costStatement({ ...base, buyerRole: "visitor-wallet", expected: { feeTx: false } }).operator.complete).toBe(true); // unless the caller says the fee's settlement is not expected here
    const complete = costStatement({ ...base, receipts: { businessTx: { gasUsed: 40364n, effectiveGasPrice: 25_000_000_000n } } });
    expect(complete.buyer).toMatchObject({ role: "buyer", complete: true, totalUsdc: "0.0610091" });
    const operatorIncomplete = costStatement({ ...base, txs: { ...base.txs, feeTx: ("0x" + "55".repeat(32)) as `0x${string}` }, receipts: { businessTx: { gasUsed: 1n, effectiveGasPrice: 1n } } });
    expect(operatorIncomplete.operator.complete).toBe(false); expect(operatorIncomplete.buyer.complete).toBe(true);
  });
  it("review of bf0c800 (P2): a source the statement must account for but that is not recorded at all is missing evidence — the total is incomplete; a source that does not apply leaves it complete", async () => {
    const { costStatement } = await import("../src/cost.js");
    const base = { buyer: "0x00000000000000000000000000000000000000aa" as const, relayer: null, orderCreator: null, businessPrincipalNativeAtomic: "50000000000000000", businessPaid: true, checkFeeTokenAtomic: "10000", plan: null, policy: null, receipts: {}, txs: {} };
    // a run that paid: the order creation, the fee settlement and the business payment are required, none is recorded
    const missing = costStatement({ ...base, expected: { createOrderTx: true, feeTx: true, businessTx: true } });
    expect(missing.operator.complete).toBe(false); expect(missing.buyer.complete).toBe(false);
    expect(missing.notes).toContain("order-creation evidence missing: no creation transaction is recorded for this order; operator.orderCreation is null, not estimated");
    expect(missing.notes).toContain("fee relay evidence missing: no settlement transaction hash is recorded for the settled check fee; operator.feeRelay is null, not estimated");
    expect(missing.notes).toContain("business transaction evidence missing: no transaction hash is recorded for the business payment; businessGas is null, not estimated");
    expect(missing.notes).toContain("operator total is incomplete: a relay or order-creation receipt is not available"); expect(missing.notes).toContain("buyer total is incomplete: business gas not available");
    // the same records where nothing is required of the business side (no payment was made) and no order creation applies (a check-only statement): complete
    const notApplicable = costStatement({ ...base, businessPaid: false, checkFeeTokenAtomic: null, expected: { createOrderTx: false, feeTx: false, businessTx: false } });
    expect(notApplicable.operator.complete).toBe(true); expect(notApplicable.buyer.complete).toBe(true); expect(notApplicable.notes.some((n) => /evidence missing/.test(n))).toBe(false);
    // defaults for callers that do not say: a paid payment and a settled fee are required, an unrecorded creation is not presumed
    const defaults = costStatement({ ...base });
    expect(defaults.buyer.complete).toBe(false); expect(defaults.operator.complete).toBe(false); expect(defaults.notes.some((n) => n.startsWith("order-creation evidence missing"))).toBe(false);
    // the honest exporter's statement with the receipts present is complete and carries no such note
    const full = costStatement({ ...base, orderCreator: "0x00000000000000000000000000000000000000cc", relayer: "0x00000000000000000000000000000000000000dd", txs: { feeTx: ("0x" + "55".repeat(32)) as `0x${string}`, businessTx: ("0x" + "44".repeat(32)) as `0x${string}`, createOrderTx: ("0x" + "66".repeat(32)) as `0x${string}` },
      receipts: { feeTx: { gasUsed: 87141n, effectiveGasPrice: 25_000_000_000n }, businessTx: { gasUsed: 40364n, effectiveGasPrice: 21_000_000_000n }, createOrderTx: { gasUsed: 98107n, effectiveGasPrice: 21_000_000_000n } }, expected: { createOrderTx: true, feeTx: true, businessTx: true } });
    expect(full.buyer.complete).toBe(true); expect(full.operator.complete).toBe(true); expect(full.notes.some((n) => /evidence missing|incomplete/.test(n))).toBe(false);
  });
});
