import { describe, it, expect } from "vitest";
import { IntentCore, PolicyCore, UIntString, Address } from "../src/types.js";
import { intentDigest } from "../src/digests.js";

const D = "0x" + "11".repeat(32);
const base = {
  schemaVersion: "1.0", clientRequestId: "req-1", chainId: 5042, walletMode: "EOA_DIRECT_NON_DELEGATED",
  from: "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE", operation: "CALL",
  to: "0x0000000000000000000000000000000000000001", data: "0x",
  valueNativeAtomic: "50000000000000000",
  businessExpectation: { sourceId: "order-1", sourceDigest: D, action: "MERCHANT_PAY",
    recipient: "0x0000000000000000000000000000000000000001", asset: "ARC_NATIVE_USDC",
    amountNativeAtomic: "50000000000000000", orderId: D },
  baselineDigest: D, policyDigest: D, expiresAt: "2026-10-02T12:00:00Z",
};

describe("IntentCore validation", () => {
  it("accepts a well-formed intent and lowercases addresses before hashing", () => {
    const parsed = IntentCore.parse(base);
    expect(parsed.from).toBe("0xc6182d363d7c3da6db491f703c430dc91d0e2ace");
    expect(intentDigest(base)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("same intent with different address casing yields the same digest", () => {
    const lower = { ...base, from: base.from.toLowerCase() };
    expect(intentDigest(lower)).toBe(intentDigest(base));
  });
  it("rejects floats, negatives, leading zeros, scientific notation in amounts", () => {
    for (const bad of ["0.05", "-1", "007", "5e16", "", " 1"]) expect(UIntString.safeParse(bad).success).toBe(false);
    expect(UIntString.safeParse("0").success).toBe(true);
  });
  it("rejects wrong chain, extra fields, bad address length", () => {
    expect(IntentCore.safeParse({ ...base, chainId: 1 }).success).toBe(false);
    expect(IntentCore.safeParse({ ...base, hidden: true }).success).toBe(false);
    expect(Address.safeParse("0x1234").success).toBe(false);
  });
  it("changing any semantic field changes the digest", () => {
    const d0 = intentDigest(base);
    expect(intentDigest({ ...base, valueNativeAtomic: "50000" })).not.toBe(d0);
    expect(intentDigest({ ...base, to: "0x0000000000000000000000000000000000000002" })).not.toBe(d0);
    expect(intentDigest({ ...base, baselineDigest: "0x" + "22".repeat(32) })).not.toBe(d0);
  });
  it("PolicyCore enforces type-2 only and no authorization list", () => {
    const p = { schemaVersion: "1.0", ownerPrincipal: "dev", allowedSenders: [], allowedTargets: [], allowedSelectors: [],
      maxNativePaymentAtomic: "0", maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "0", maxGasCostNativeAtomic: "0",
      maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5, requiredSignalIds: [], unknownAction: "REVIEW_REQUIRED",
      implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false };
    expect(PolicyCore.safeParse(p).success).toBe(true);
    expect(PolicyCore.safeParse({ ...p, allowAuthorizationList: true }).success).toBe(false);
    expect(PolicyCore.safeParse({ ...p, allowedTransactionTypes: [4] }).success).toBe(false);
  });
});
