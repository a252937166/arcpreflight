import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import { decide } from "../src/decide.js";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR, checkIntentBinding } from "../src/intent-binding.js";
import { IntentCore, PolicyCore, ReportCore, BaselineCore, baselineDigest as computeBaselineDigest } from "@arcpreflight/schema";

const D = ("0x" + "11".repeat(32)) as `0x${string}`;
const MERCHANT = "0x0000000000000000000000000000000000000a11";
const RUNNER = "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE";
const ORDER = ("0x" + "ab".repeat(32)) as `0x${string}`;
const AMOUNT = "50000000000000000"; // 0.05 USDC, 18-dec native
const now = new Date("2026-10-02T12:00:00Z");
const snapshot = { chainId: 5042, blockNumber: "100", blockHash: D, observedAt: "2026-10-02T11:59:50Z", providerId: "rpc", pinningMode: "BLOCK_HASH" as const };

function intent(over: Partial<any> = {}) {
  return IntentCore.parse({
    schemaVersion: "1.0", clientRequestId: "r1", chainId: 5042, walletMode: "EOA_DIRECT_NON_DELEGATED", from: RUNNER, operation: "CALL",
    to: MERCHANT, data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [ORDER] }), valueNativeAtomic: AMOUNT,
    businessExpectation: { sourceId: "order-ab", sourceDigest: D, action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT, orderId: ORDER },
    baselineDigest: B, policyDigest: D, expiresAt: "2026-10-02T12:05:00Z", ...over,
  });
}
const policy = PolicyCore.parse({
  schemaVersion: "1.0", ownerPrincipal: "dev", allowedSenders: [RUNNER], allowedTargets: [MERCHANT], allowedSelectors: [PAY_SELECTOR],
  maxNativePaymentAtomic: "100000000000000000", maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "1000000000000000",
  maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED"], unknownAction: "REVIEW_REQUIRED",
  implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false,
});
const baseline = BaselineCore.parse({
  schemaVersion: "1.0", chainId: 5042, subject: MERCHANT, approvedBy: "dev", approvedAt: "2026-10-01T00:00:00Z", validUntil: null, previousBaselineDigest: null,
  referenceSnapshot: snapshot, dependencies: [], allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [], approvedState: [],
});
const B = computeBaselineDigest(baseline);
function report(over: Partial<any> = {}) {
  return ReportCore.parse({
    schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: D, decisionEligible: true, observation: snapshot, methodologyDigest: D,
    adapterManifestDigests: [], baselineDigest: B, baselineResult: "MATCH", dependencies: [],
    signals: [{ id: "PROXY_TEMPLATE_VERIFIED", state: "observed", basis: "chain_read", scope: "", evidenceDigests: [], limitations: [], sourceIds: [] }],
    rawEvidenceDigests: [], exclusions: [], expiresAt: "2026-10-02T12:01:00Z", ...over,
  });
}
const base = () => ({ intent: intent(), policy, policyDigest: D, baseline, baselineDigest: B, baselineRevoked: false, report: report(), reportDigest: D, now, simulation: { ok: true, error: null } });

describe("decide()", () => {
  it("clean path → NO_POLICY_VIOLATION", () => {
    expect(decide(base()).decision).toBe("NO_POLICY_VIOLATION");
  });
  it("A→B implementation change → REVIEW_REQUIRED (not BLOCKED)", () => {
    const r = decide({ ...base(), report: report({ baselineResult: "IMPLEMENTATION_CHANGED" }) });
    expect(r.decision).toBe("REVIEW_REQUIRED");
    expect(r.reasons.join()).toMatch(/unapproved change/);
  });
  it("6-decimal value on native path → BLOCKED with AMOUNT_UNIT_MISMATCH", () => {
    const r = decide({ ...base(), intent: intent({ valueNativeAtomic: "50000" }) });
    expect(r.decision).toBe("BLOCKED");
    expect(r.reasons.join()).toMatch(/AMOUNT_UNIT_MISMATCH/);
  });
  it("wrong orderId in calldata → BLOCKED", () => {
    const other = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const r = decide({ ...base(), intent: intent({ data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [other] }) }) });
    expect(r.decision).toBe("BLOCKED");
  });
  it("business expectation is never derived from calldata: recipient mismatch blocks", () => {
    const r = checkIntentBinding(intent({ to: "0x0000000000000000000000000000000000000b22", businessExpectation: { sourceId: "o", sourceDigest: D, action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT, orderId: ORDER } }));
    expect(r.outcome).toBe("BLOCKED");
  });
  it("revoked or missing baseline → REVIEW_REQUIRED; first observation never auto-approves", () => {
    expect(decide({ ...base(), baselineRevoked: true }).decision).toBe("REVIEW_REQUIRED");
    expect(decide({ ...base(), baseline: null, baselineDigest: null, report: report({ baselineResult: "NO_BASELINE" }) }).decision).toBe("REVIEW_REQUIRED");
  });
  it.each([
    ["expired", { validUntil: now.toISOString() }],
    ["wrong subject", { subject: "0x0000000000000000000000000000000000000b22" }],
    ["wrong chain", { chainId: 5042002 }],
    ["wrong snapshot chain", { referenceSnapshot: { ...snapshot, chainId: 5042002 } }],
    ["unapproved selector", { allowedSelectors: [] }],
  ])("%s baseline cannot authorize a payment even when the report says MATCH", (_label, patch) => {
    const changed = BaselineCore.parse({ ...baseline, ...patch });
    const d = computeBaselineDigest(changed);
    const result = decide({ ...base(), intent: intent({ baselineDigest: d }), baseline: changed, baselineDigest: d, report: report({ baselineDigest: d }) });
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.checks.find((c) => c.id === "BASELINE_STATUS")?.outcome).toBe("REVIEW_REQUIRED");
  });
  it("rejects baseline content changed under an old digest and a report bound to another baseline", () => {
    expect(decide({ ...base(), baseline: { ...baseline, approvedBy: "other-admin" } }).decision).toBe("REVIEW_REQUIRED");
    expect(decide({ ...base(), report: report({ baselineDigest: D }) }).decision).toBe("REVIEW_REQUIRED");
  });
  it("simulation revert → BLOCKED; missing simulation → REVIEW_REQUIRED", () => {
    expect(decide({ ...base(), simulation: { ok: false, error: "OrderAlreadyPaid" } }).decision).toBe("BLOCKED");
    expect(decide({ ...base(), simulation: null }).decision).toBe("REVIEW_REQUIRED");
    // audit 2026-10-10 (VF-04): an RPC that could not run the call is missing evidence, never a revert — REVIEW_REQUIRED, not BLOCKED
    const unavailable = decide({ ...base(), simulation: { ok: false, error: "HTTP request failed. Status: 503 Service Unavailable", unavailable: true } });
    expect(unavailable.decision).toBe("REVIEW_REQUIRED");
    expect(unavailable.checks.find((c) => c.id === "CALL_SIMULATION")).toMatchObject({ outcome: "REVIEW_REQUIRED", reasons: [expect.stringContaining("simulation unavailable")] });
    expect(decide({ ...base(), simulation: { ok: false, error: "OrderAlreadyPaid", unavailable: false } }).decision).toBe("BLOCKED");
  });
  it("stale report / expired intent / unknown required signal → REVIEW_REQUIRED", () => {
    expect(decide({ ...base(), now: new Date("2026-10-02T12:03:00Z") }).decision).toBe("REVIEW_REQUIRED");
    expect(decide({ ...base(), report: report({ signals: [{ id: "PROXY_TEMPLATE_VERIFIED", state: "unknown", basis: "chain_read", scope: "", evidenceDigests: [], limitations: [], sourceIds: [] }] }) }).decision).toBe("REVIEW_REQUIRED");
  });
  it("object-observation report cannot authorize execution", () => {
    expect(decide({ ...base(), report: report({ mode: "OBJECT_OBSERVATION", decisionEligible: false, intentDigest: null }) }).decision).toBe("REVIEW_REQUIRED");
  });
  it("hard violation wins over review conditions", () => {
    const r = decide({ ...base(), intent: intent({ valueNativeAtomic: "1" }), report: report({ baselineResult: "IMPLEMENTATION_CHANGED" }) });
    expect(r.decision).toBe("BLOCKED");
  });
});
