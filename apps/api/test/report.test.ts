import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { BaselineCore, IntentCore, baselineDigest, intentDigest } from "@arcpreflight/schema";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { buildIntentReport } from "../src/report.js";

const D = (`0x${"11".repeat(32)}`) as Hex;
const MERCHANT = "0x0000000000000000000000000000000000000a11" as Hex;
const IMPL = "0x0000000000000000000000000000000000000b22" as Hex;
const SENDER = "0x0000000000000000000000000000000000000c33" as Hex;
const ORDER = (`0x${"ab".repeat(32)}`) as Hex;
const AMOUNT = "50000000000000000";
const abi = parseAbi([
  "function pay(bytes32 orderId) payable", "function paused() view returns (bool)", "function owner() view returns (address)",
  "function getOrder(bytes32 orderId) view returns (address payer, uint256 amountNativeAtomic, bool paid, uint64 createdAtBlock, uint64 paidAtBlock)",
]);
const snapshot = () => ({ chainId: 5042002 as const, blockNumber: "150", blockHash: D, observedAt: new Date().toISOString(), providerId: "mock-rpc", pinningMode: "BLOCK_HASH" as const });
const state = vi.hoisted(() => ({ paused: false, malformedPaused: false, malformedOrder: false, implChanged: false }));

vi.mock("../src/config.js", () => ({ cfg: { rpc: "http://mock-rpc.invalid", reportTtlSeconds: 60 } }));
vi.mock("../src/manifests.js", async () => {
  const { parseAbi } = await import("viem");
  const d = `0x${"11".repeat(32)}`;
  return { adapterManifests: [], adapterManifestDigests: [d], methodologyDigest: d, arcAdvisorySignals: [], DEMO_MERCHANT_TEMPLATE_ABI: parseAbi([
    "function pay(bytes32 orderId) payable", "function paused() view returns (bool)", "function owner() view returns (address)",
    "function getOrder(bytes32 orderId) view returns (address payer, uint256 amountNativeAtomic, bool paid, uint64 createdAtBlock, uint64 paidAtBlock)",
  ]) };
});
vi.mock("@arcpreflight/observer", () => ({
  captureSnapshot: vi.fn(async () => snapshot()),
  observeProxy: vi.fn(async () => ({
    resolution: "VERIFIED_TEMPLATE", evidence: [], limitations: [],
    dependencies: [
      { address: MERCHANT, role: "TARGET", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
      { address: state.implChanged ? SENDER : IMPL, role: "IMPLEMENTATION", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
    ],
    signals: [{ id: "PROXY_TEMPLATE_VERIFIED", state: "observed", basis: "chain_read", scope: "test", evidenceDigests: [D], limitations: [], sourceIds: [] }],
  })),
  readCall: vi.fn(async (_client: unknown, _subject: unknown, data: Hex) => {
    let result: Hex = "0x";
    if (data === "0x5c975abb") result = state.malformedPaused ? "0x" : encodeFunctionResult({ abi, functionName: "paused", result: state.paused });
    else if (data === "0x8da5cb5b") result = encodeFunctionResult({ abi, functionName: "owner", result: SENDER });
    else if (data.slice(0, 10) === encodeFunctionData({ abi, functionName: "getOrder", args: [ORDER] }).slice(0, 10)) result = state.malformedOrder ? "0x" : encodeFunctionResult({ abi, functionName: "getOrder", result: [SENDER, BigInt(AMOUNT), false, 100n, 0n] });
    return { value: { ok: true, data: result, error: null, revertData: null }, evidence: { kind: "rpc", method: "eth_call", params: [], result, error: null, snapshot: snapshot(), capturedAt: new Date().toISOString() }, evidenceDigest: D };
  }),
}));

function inputs(patch: Partial<BaselineCore> = {}) {
  const baseline = BaselineCore.parse({
    schemaVersion: "1.0", chainId: 5042002, subject: MERCHANT, approvedBy: "test-admin", approvedAt: new Date().toISOString(), validUntil: null, previousBaselineDigest: null,
    referenceSnapshot: snapshot(), dependencies: [
      { address: MERCHANT, role: "TARGET", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
      { address: IMPL, role: "IMPLEMENTATION", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
    ], allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [D], approvedState: [{ key: "paused", canonicalValue: "false" }], ...patch,
  });
  const bDigest = baselineDigest(baseline);
  const intent = IntentCore.parse({
    schemaVersion: "1.0", clientRequestId: "report-test", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: SENDER, operation: "CALL", to: MERCHANT,
    data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [ORDER] }), valueNativeAtomic: AMOUNT,
    businessExpectation: { sourceId: "approved-order", sourceDigest: D, action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT, orderId: ORDER },
    baselineDigest: bDigest, policyDigest: D, expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
  return { baseline, bDigest, intent };
}
async function build(patch: Partial<BaselineCore> = {}) {
  const { baseline, bDigest, intent } = inputs(patch);
  return buildIntentReport(intent, intentDigest(intent), baseline, bDigest);
}
beforeEach(() => { Object.assign(state, { paused: false, malformedPaused: false, malformedOrder: false, implChanged: false }); });

describe("report approval scope and supported state", () => {
  it("matches an active approval and preserves the unapproved implementation outcome", async () => {
    expect((await build()).report.baselineResult).toBe("MATCH");
    state.implChanged = true;
    expect((await build()).report.baselineResult).toBe("IMPLEMENTATION_CHANGED");
  });
  it.each([
    ["expired", { validUntil: "2020-01-01T00:00:00Z" }],
    ["wrong subject", { subject: SENDER }],
    ["wrong chain", { chainId: 5042 }],
    ["unapproved selector", { allowedSelectors: [] }],
  ] as const)("does not publish MATCH for a %s baseline", async (_label, patch) => {
    const built = await build(patch as Partial<BaselineCore>);
    expect(built.report.baselineResult).toBe("UNKNOWN");
    expect(built.report.exclusions.join()).toContain("BASELINE_STATUS:");
  });
  it("detects changed approved paused and owner state at the pinned block", async () => {
    state.paused = true;
    expect((await build()).report.baselineResult).toBe("STATE_CHANGED");
    state.paused = false;
    expect((await build({ approvedState: [{ key: "owner", canonicalValue: JSON.stringify(MERCHANT) }] })).report.baselineResult).toBe("STATE_CHANGED");
    expect((await build({ approvedState: [{ key: "owner", canonicalValue: JSON.stringify(SENDER) }] })).report.baselineResult).toBe("MATCH");
  });
  it("keeps unreadable or unsupported approved state unknown", async () => {
    state.malformedPaused = true;
    const built = await build();
    expect(built.report.baselineResult).toBe("UNKNOWN");
    expect(built.report.signals.find((s) => s.id === "SUPPORTED_STATE_PAUSED")?.state).toBe("unknown");
    expect((await build({ approvedState: [{ key: "unadapted-state", canonicalValue: "false" }] })).report.baselineResult).toBe("UNKNOWN");
  });
  it("records malformed order return data as unknown instead of failing preparation", async () => {
    state.malformedOrder = true;
    const built = await build();
    expect(built.report.signals.find((s) => s.id === "SUPPORTED_STATE_ORDER_PAYABLE")?.state).toBe("unknown");
  });
});
