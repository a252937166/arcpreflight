import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { BaselineCore, ReportCore, baselineDigest, intentDigest, reportDigest, type IntentCore } from "@arcpreflight/schema";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization } from "@arcpreflight/client";
import { runFixture, type Fixture, type RunOptions } from "../src/index.js";

const D = (`0x${"11".repeat(32)}`) as Hex;
const MERCHANT = "0x0000000000000000000000000000000000000a11" as Hex;
const IMPL = "0x0000000000000000000000000000000000000b22" as Hex;
const AMOUNT = 50_000_000_000_000_000n;
const pausedAbi = parseAbi(["function paused() view returns (bool)"]);
const snapshot = () => ({ chainId: 5042002 as const, blockNumber: "150", blockHash: D, observedAt: new Date().toISOString(), providerId: "mock-rpc", pinningMode: "BLOCK_HASH" as const });

vi.mock("@arcpreflight/client", () => ({
  signTransferAuthorization: vi.fn(async () => ({ signature: "0x1234", authorization: { from: "mock", to: "mock", value: "10000", nonce: "mock" } })),
}));
vi.mock("@arcpreflight/observer", () => ({
  PIN_LAG: 8n,
  SLOTS: { erc1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" },
  slotToAddress: (value: Hex) => `0x${value.slice(-40)}`,
  captureSnapshot: vi.fn(async () => snapshot()),
  readSlot: vi.fn(async () => ({ value: `0x${IMPL.slice(2).padStart(64, "0")}`, evidenceDigest: D })),
  readCall: vi.fn(async (_client: unknown, _merchant: unknown, data: string) => ({ value: { ok: true, data: data === "0x5c975abb" ? encodeFunctionResult({ abi: pausedAbi, functionName: "paused", result: false }) : "0x", error: null }, evidenceDigest: D })),
}));

type Scenario = { fixture: Fixture; staleQuote?: boolean; alwaysStale?: boolean; missingPinnedBlock?: boolean; revokeBeforeSigning?: boolean; baselinePatch?: Partial<BaselineCore> };
function harness(s: Scenario) {
  // Synthetic test account; all sends, RPC reads and payment requests are local mocks.
  const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const signTransaction = vi.spyOn(account, "signTransaction");
  const baseline = BaselineCore.parse({
    schemaVersion: "1.0", chainId: 5042002, subject: MERCHANT, approvedBy: "test-admin", approvedAt: new Date().toISOString(), validUntil: null, previousBaselineDigest: null,
    referenceSnapshot: snapshot(), dependencies: [
      { role: "TARGET", address: MERCHANT, codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
      { role: "IMPLEMENTATION", address: IMPL, codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" },
    ], allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [D], approvedState: [{ key: "paused", canonicalValue: "false" }], ...s.baselinePatch,
  });
  const bDigest = baselineDigest(baseline);
  let lastIntent: IntentCore;
  let quoteRequests = 0;
  let baselineReads = 0;
  const quoteIds: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/v1/baselines/")) {
      baselineReads++;
      return Response.json({ baseline, baselineDigest: bDigest, revoked: !!s.revokeBeforeSigning && baselineReads >= 2 });
    }
    const body = JSON.parse(String(init?.body));
    lastIntent = body.intent;
    if (!body.payment) {
      quoteRequests++;
      quoteIds.push(lastIntent.clientRequestId);
      return Response.json({ requestId: "test-request", pinnedBlock: s.missingPinnedBlock ? undefined : s.alwaysStale || s.staleQuote && quoteRequests === 1 ? "99" : "150", quote: { amountTokenAtomic: "10000", payTo: MERCHANT, expiresAt: new Date(Date.now() + 30_000).toISOString() } }, { status: 402 });
    }
    const report = ReportCore.parse({
      schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: intentDigest(lastIntent), decisionEligible: true, observation: snapshot(), methodologyDigest: D,
      adapterManifestDigests: [D], baselineDigest: bDigest, baselineResult: s.fixture === "CHANGED_IMPLEMENTATION" ? "IMPLEMENTATION_CHANGED" : "MATCH", dependencies: baseline.dependencies,
      signals: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"].map((id) => ({ id, state: "observed", basis: "chain_read", scope: "test", evidenceDigests: [D], limitations: [], sourceIds: [] })),
      rawEvidenceDigests: [D], exclusions: [], expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return Response.json({ delivery: "DELIVERED", report, reportDigest: reportDigest(report), simulation: { ok: s.fixture !== "AMOUNT_UNIT_MISMATCH", error: s.fixture === "AMOUNT_UNIT_MISMATCH" ? "WrongAmount" : null }, payment: { transaction: D } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const sendRawTransaction = vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction));
  const publicClient = {
    getBlockNumber: vi.fn(async () => 200n), waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 100n })),
    getBalance: vi.fn(async () => 10n ** 18n), estimateGas: vi.fn(async () => 50_000n), getTransactionCount: vi.fn(async () => 1), sendRawTransaction,
    readContract: vi.fn(async () => [account.address, AMOUNT, true, 100n, 151n]),
  };
  const options = { fixture: s.fixture, net: "testnet", chain: arcTestnet, publicClient, admin: { writeContract: vi.fn(async () => D) }, runner: account,
    merchant: MERCHANT, baselineDigest: bDigest, apiUrl: "http://mock-api.invalid", token: "test-token", feeParams: async () => ({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }), labels: ["LIVE_REQUEST"] } as unknown as RunOptions;
  return { options, signTransaction, sendRawTransaction, quoteIds, getIntent: () => lastIntent };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function run(s: Scenario) {
  const h = harness(s);
  const running = runFixture(h.options);
  await vi.runAllTimersAsync();
  return { h, result: await running };
}

describe("runner approvals and retry binding", () => {
  it.each([
    ["APPROVED_PAYMENT", "NO_POLICY_VIOLATION", "SUCCESS"],
    ["CHANGED_IMPLEMENTATION", "REVIEW_REQUIRED", "NOT_EXECUTED"],
    ["AMOUNT_UNIT_MISMATCH", "BLOCKED", "NOT_EXECUTED"],
  ] as const)("keeps %s on its intended path", async (fixture, decision, businessStatus) => {
    const { h, result } = await run({ fixture });
    expect(result.decision.decision).toBe(decision);
    expect(result.execution.businessStatus).toBe(businessStatus);
    expect(h.signTransaction).toHaveBeenCalledTimes(fixture === "APPROVED_PAYMENT" ? 1 : 0);
    expect(h.sendRawTransaction).toHaveBeenCalledTimes(fixture === "APPROVED_PAYMENT" ? 1 : 0);
    expect(result.steps.find((step: { step: string }) => step.step === "decision").checks).toContain("BASELINE_STATUS:PASS");
  });
  it("rehashes a replacement intent after a stale free quote and completes one purchase", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", staleQuote: true });
    expect(h.quoteIds).toHaveLength(2);
    expect(h.quoteIds[1]).toBe(`${h.quoteIds[0]}-r1`);
    expect(result.intentDigest).toBe(intentDigest(h.getIntent()));
    expect(result.report.intentDigest).toBe(result.intentDigest);
    expect(result.execution.businessStatus).toBe("SUCCESS");
    expect(h.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["exhausted stale retries", { alwaysStale: true }, "bounded retries", 6],
    ["missing pinned block", { missingPinnedBlock: true }, "valid pinned block", 1],
  ] as const)("does not authorize a service fee after %s", async (_label, scenario, error, quoteCount) => {
    const h = harness({ fixture: "APPROVED_PAYMENT", ...scenario });
    const running = runFixture(h.options);
    const failure = expect(running).rejects.toThrow(error);
    await vi.runAllTimersAsync();
    await failure;
    expect(h.quoteIds).toHaveLength(quoteCount);
    expect(signTransferAuthorization).not.toHaveBeenCalled();
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each([
    ["expired", { validUntil: "2020-01-01T00:00:00Z" }],
    ["wrong subject", { subject: "0x0000000000000000000000000000000000000c33" }],
    ["wrong chain", { chainId: 5042 }],
    ["unapproved selector", { allowedSelectors: [] }],
  ] as const)("does not sign with a %s baseline even if the report says MATCH", async (_label, baselinePatch) => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", baselinePatch: baselinePatch as Partial<BaselineCore> });
    expect(result.decision.decision).toBe("REVIEW_REQUIRED");
    expect(result.execution.chainStatus).toBe("NOT_SIGNED");
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rechecks revocation immediately before final validation and signing", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", revokeBeforeSigning: true });
    expect(result.decision.decision).toBe("NO_POLICY_VIOLATION");
    expect(result.finalValidation.result).toBe("REVIEW_REQUIRED");
    expect(result.finalValidation.reasons.join()).toContain("baseline revoked");
    expect(result.execution.chainStatus).toBe("NOT_SIGNED");
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.sendRawTransaction).not.toHaveBeenCalled();
  });
});
