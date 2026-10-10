import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, pad, toHex, type Hex } from "viem";
import { IntentCore, PolicyCore, ReportCore, BaselineCore, baselineDigest as computeBaselineDigest, policyDigest } from "@arcpreflight/schema";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { finalValidate } from "../src/validate.js";

// audit 2026-10-10 (VF-05): the report-age policy holds at the moment of signing, not only at the initial decision — a report that was 50 s old
// when the decision was made and aged to 90 s during the fee / block waits is refused under a 60 s policy; the receipt's expiry never outlives it.
const MERCHANT = "0x0000000000000000000000000000000000000a11" as Hex, RUNNER = "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE" as Hex, IMPL = "0x342ab0e9f7951e4112e698ff69ac00ac18c009f9" as Hex;
const ORDER = ("0x" + "ab".repeat(32)) as Hex, AMOUNT = "50000000000000000", D = ("0x" + "11".repeat(32)) as Hex;
const T0 = new Date("2026-10-10T12:00:00Z");
const H = (n: number | bigint) => keccak256(toHex(`block-${n}`));
function fixture(observedAgoSeconds: number) {
  const observedAt = new Date(T0.getTime() - observedAgoSeconds * 1000).toISOString();
  const refSnap = { chainId: 5042002 as const, blockNumber: "50", blockHash: H(50), observedAt: "2026-10-01T00:00:00.000Z", providerId: "rpc.testnet", pinningMode: "BLOCK_HASH" as const };
  const deps = [{ address: MERCHANT, role: "TARGET" as const, codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" as const }, { address: IMPL, role: "IMPLEMENTATION" as const, codeHash: D, adapterDigest: null, resolution: "VERIFIED_TEMPLATE" as const }];
  const baseline = BaselineCore.parse({ schemaVersion: "1.0", chainId: 5042002, subject: MERCHANT, approvedBy: "dev", approvedAt: "2026-10-01T00:00:00Z", validUntil: null, previousBaselineDigest: null, referenceSnapshot: refSnap, dependencies: deps, allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [D], approvedState: [] });
  const B = computeBaselineDigest(baseline);
  const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "dev", allowedSenders: [RUNNER], allowedTargets: [MERCHANT], allowedSelectors: [PAY_SELECTOR], maxNativePaymentAtomic: "100000000000000000", maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "5000000000000000",
    maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 30, requiredSignalIds: [], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
  const P = policyDigest(policy);
  const data = encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [ORDER] });
  const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "r1", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: RUNNER, operation: "CALL", to: MERCHANT, data, valueNativeAtomic: AMOUNT,
    businessExpectation: { sourceId: "order-ab", sourceDigest: D, action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT, orderId: ORDER }, baselineDigest: B, policyDigest: P, expiresAt: new Date(T0.getTime() + 300_000).toISOString() });
  const report = ReportCore.parse({ schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: D, decisionEligible: true, observation: { chainId: 5042002, blockNumber: "80", blockHash: H(80), observedAt, providerId: "rpc.testnet", pinningMode: "BLOCK_HASH" },
    methodologyDigest: D, adapterManifestDigests: [D], baselineDigest: B, baselineResult: "MATCH", dependencies: deps, signals: [], rawEvidenceDigests: [], exclusions: [], expiresAt: new Date(T0.getTime() + 300_000).toISOString() });
  return { intent, report, policy, baseline, B, P, data };
}
/** a fake Arc node: head 100, every block served, the merchant on IMPL and unpaused, the exact call succeeding, the signer a plain EOA */
function client(data: Hex) {
  return {
    getChainId: async () => 5042002, getBlockNumber: async () => 100n,
    getBlock: async (a: { blockNumber?: bigint; blockHash?: Hex }) => { const n = a.blockNumber ?? 92n; return { number: n, hash: a.blockHash ?? H(n) }; },
    getStorageAt: async () => pad(IMPL, { size: 32 }), getCode: async () => undefined,
    call: async (a: { data: Hex }) => ({ data: a.data === data ? "0x" : ("0x" + "00".repeat(32)) }),
    getBalance: async () => 10n ** 18n, estimateGas: async () => 50_000n, getTransactionCount: async () => 7,
  } as any;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

async function validate(observedAgoSeconds: number, waitSeconds: number) {
  const f = fixture(observedAgoSeconds);
  return finalValidate({ publicClient: client(f.data), net: "testnet", chainId: 5042002, merchant: MERCHANT, intent: f.intent, report: f.report, policy: f.policy, attemptId: "a1", intentDigest: D, reportDigest: D, decisionDigest: D, policyDigest: f.P, baselineDigest: f.B,
    approval: async () => ({ baseline: f.baseline, baselineDigest: f.B, baselineRevoked: false }), signer: { address: RUNNER, type: "local", requireLocal: true }, feeBlock: 85n, orderBlock: 60n,
    feeParams: async () => ({ maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    waitForBlock: async () => { vi.setSystemTime(Date.now() + waitSeconds * 1000); } }); // the fee / block wait takes this long
}
describe("final validation and the report-age policy", () => {
  it("a 50 s old report that aged to 90 s during a 40 s wait is refused under a 60 s policy, without a plan being signed", async () => {
    const v = await validate(50, 40);
    expect(v.finalValidation.result).toBe("REVIEW_REQUIRED");
    expect(v.reasons).toEqual([expect.stringMatching(/report aged past policy\.maxReportAgeSeconds \(60 s\) during validation: .* 90 s ago/)]);
  });
  it("a fresh report passes and the receipt's expiry is no later than observedAt + maxReportAgeSeconds, even when the API's report TTL is longer", async () => {
    const v = await validate(50, 1);
    expect(v.finalValidation.result).toBe("PASS"); expect(v.reasons).toEqual([]);
    expect(Date.parse(v.finalValidation.expiresAt)).toBeLessThanOrEqual(T0.getTime() - 50_000 + 60_000); // the 60 s report deadline, not the 300 s TTL
    expect(Date.parse(v.finalValidation.expiresAt)).toBeGreaterThan(Date.now());
  });
});
