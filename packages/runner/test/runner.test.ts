import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { BaselineCore, ReportCore, baselineDigest, intentDigest, reportDigest, type IntentCore } from "@arcpreflight/schema";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization } from "@arcpreflight/client";
import { captureSnapshot, readCode } from "@arcpreflight/observer";
import { runFixture, createOrder, DEFAULT_ORDER_GAS_COST_CAP, type Fixture, type RunOptions, type SignedExecution, type ExecutionOutcome, type OrderStore } from "../src/index.js";

const D = (`0x${"11".repeat(32)}`) as Hex;
const T = (`0x${"22".repeat(32)}`) as Hex;
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
  readCode: vi.fn(async () => ({ value: { code: null, codeHash: null, bytes: 0 }, evidence: {}, evidenceDigest: D })),
}));

type Scenario = { fixture: Fixture; staleQuote?: boolean; alwaysStale?: boolean; missingPinnedBlock?: boolean; revokeBeforeSigning?: boolean; baselinePatch?: Partial<BaselineCore>;
  /** fault injection and account-path cases */
  wrongBaselineDigest?: boolean; signerHasCode?: boolean; codeReadFails?: boolean; feeReceiptMissing?: boolean; snapshotBlock?: string; broadcastThrows?: boolean; receiptTimeout?: boolean;
  /** review round 2: artefact persistence failing for one artefact name; a snapshot that is already older than the validation window */
  artifactFails?: string; staleSnapshotSeconds?: number;
  /** review of 0c0d406 (P1-3): the broadcast-marker write takes this long (the clock jumps while it is awaited) */
  markerTakesMs?: number };
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
      // a server answering with a different (newer) approval than the one referenced must be ignored
      return Response.json({ baseline, baselineDigest: s.wrongBaselineDigest ? T : bDigest, revoked: !!s.revokeBeforeSigning && baselineReads >= 2 });
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
    return Response.json({ delivery: "DELIVERED", report, reportDigest: reportDigest(report), simulation: { ok: s.fixture !== "AMOUNT_UNIT_MISMATCH", error: s.fixture === "AMOUNT_UNIT_MISMATCH" ? "WrongAmount" : null }, payment: { transaction: T } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(readCode).mockImplementation(async () => {
    if (s.codeReadFails) throw new Error("rpc down");
    return { value: s.signerHasCode ? { code: `0xef0100${"11".repeat(20)}` as Hex, codeHash: D, bytes: 23 } : { code: null, codeHash: null, bytes: 0 }, evidence: {} as any, evidenceDigest: D };
  });
  vi.mocked(captureSnapshot).mockImplementation(async () => ({ ...snapshot(), blockNumber: s.snapshotBlock ?? "150", observedAt: new Date(Date.now() - (s.staleSnapshotSeconds ?? 0) * 1000).toISOString() }));
  const artifacts: string[] = [];
  const onArtifact = vi.fn(async (name: string) => { if (s.artifactFails === name) throw new Error("disk full"); artifacts.push(name); });
  const calls: string[] = []; let signed: SignedExecution | null = null; const outcomes: ExecutionOutcome[] = [];
  const store = {
    persistSigned: vi.fn(async (e: SignedExecution) => { calls.push("persistSigned"); signed = e; }),
    markBroadcastAttempted: vi.fn(async () => {
      calls.push("markBroadcastAttempted");
      if (s.markerTakesMs) { // the clock jumps while the marker write is awaited (Date is not among the faked timers: shim it)
        const shift = s.markerTakesMs; const RealDate = Date;
        vi.stubGlobal("Date", class extends RealDate { constructor(...a: any[]) { super(...((a.length ? a : [RealDate.now() + shift]) as [number])); } static now() { return RealDate.now() + shift; } });
      }
    }),
    persistOutcome: vi.fn(async (_id: string, o: ExecutionOutcome) => { calls.push(`persistOutcome:${o.chainStatus}`); outcomes.push(o); }),
  };
  const sendRawTransaction = vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => { calls.push("send"); if (s.broadcastThrows) throw new Error("socket hang up"); return keccak256(serializedTransaction); });
  const publicClient = {
    getBlockNumber: vi.fn(async () => 200n),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => { if (s.receiptTimeout && hash !== D) throw new Error("Timed out while waiting for transaction"); return { status: "success", blockNumber: 100n, transactionHash: hash }; }),
    getTransactionReceipt: vi.fn(async () => { if (s.feeReceiptMissing) throw new Error("not found"); return { status: "success", blockNumber: 100n }; }), // the service-fee confirmation
    getBalance: vi.fn(async () => 10n ** 18n), estimateGas: vi.fn(async () => 50_000n), getTransactionCount: vi.fn(async () => 1), sendRawTransaction,
    readContract: vi.fn(async () => [account.address, AMOUNT, true, 100n, 151n]),
  };
  const options = { fixture: s.fixture, net: "testnet", chain: arcTestnet, publicClient, admin: { writeContract: vi.fn(async () => D) }, runner: account,
    merchant: MERCHANT, baselineDigest: bDigest, apiUrl: "http://mock-api.invalid", token: "test-token", feeParams: async () => ({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }), labels: ["LIVE_REQUEST"],
    executionStore: store, receiptTimeoutMs: 1000, onArtifact } as unknown as RunOptions;
  return { options, signTransaction, sendRawTransaction, quoteIds, getIntent: () => lastIntent, calls, store, getSigned: () => signed, outcomes, artifacts, onArtifact };
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
    if (fixture === "APPROVED_PAYMENT") expect(result.finalValidation.walletEvidenceDigest).toBe(D); // the real eth_getCode evidence, not a declaration
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
  it("uses the approval referenced by the intent and ignores a server that answers with another one", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", wrongBaselineDigest: true });
    expect(result.decision.decision).toBe("REVIEW_REQUIRED");
    expect(h.signTransaction).not.toHaveBeenCalled();
  });
});

describe("signer account path and snapshot ordering (final validation)", () => {
  it.each([
    ["the signer account has code (delegated or contract account)", { signerHasCode: true }, "signer account has code"],
    ["the account-code read is inconclusive", { codeReadFails: true }, "inconclusive"],
    ["the service-fee confirmation block is unknown", { feeReceiptMissing: true }, "confirmation block unknown"],
    ["the snapshot predates the fee confirmation or the order", { snapshotBlock: "95" }, "predates"],
  ] as const)("does not sign when %s", async (_label, scenario, reason) => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", ...scenario });
    expect(result.decision.decision).toBe("NO_POLICY_VIOLATION");
    expect(result.finalValidation.result).toBe("REVIEW_REQUIRED");
    expect(result.finalValidation.reasons.join("; ")).toContain(reason);
    expect(result.execution.chainStatus).toBe("NOT_SIGNED");
    expect(h.signTransaction).not.toHaveBeenCalled();
    expect(h.store.persistSigned).not.toHaveBeenCalled();
  });
});

describe("business-transaction persistence and recovery (spec D07)", () => {
  it("persists the signed transaction, then the broadcast marker, before sending, and records the confirmed outcome", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT" });
    expect(h.calls).toEqual(["persistSigned", "markBroadcastAttempted", "send", "persistOutcome:CONFIRMED"]);
    const signed = h.getSigned()!;
    const sentRaw = h.sendRawTransaction.mock.calls[0][0].serializedTransaction;
    expect(signed.raw).toBe(sentRaw); expect(signed.txHash).toBe(keccak256(sentRaw)); expect(signed.nonce).toBe(1);
    expect(signed).toMatchObject({ orderId: result.orderId, intentDigest: result.intentDigest, reportDigest: result.reportDigest, decisionDigest: result.decisionDigest, finalValidationDigest: result.execution.finalValidationDigest, transactionPlanDigest: result.execution.transactionPlanDigest });
    expect(new Date(signed.validUntil).getTime()).toBeGreaterThan(0);
    expect(result.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: signed.txHash, signedTransactionHash: signed.txHash });
    expect(h.outcomes[0]).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: signed.txHash, block: "100" });
  });
  it("still confirms from the receipt when the broadcast call throws but the transaction propagated anyway", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", broadcastThrows: true });
    expect(h.calls).toEqual(["persistSigned", "markBroadcastAttempted", "send", "send", "send", "persistOutcome:CONFIRMED"]); // the identical bytes, three times inside the window
    expect(result.steps.find((s: { step: string }) => s.step === "broadcast")).toMatchObject({ accepted: false, attempts: 3, error: expect.stringContaining("socket hang up") });
    expect(result.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: h.getSigned()!.txHash });
    expect(h.signTransaction).toHaveBeenCalledTimes(1); // no replacement is signed
  });
  it("records UNKNOWN, not a business failure, when the broadcast call throws and no receipt can be obtained", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", broadcastThrows: true, receiptTimeout: true });
    expect(h.calls).toEqual(["persistSigned", "markBroadcastAttempted", "send", "send", "send", "persistOutcome:UNKNOWN"]); // the identical bytes, three times inside the window
    expect(result.execution).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: h.getSigned()!.txHash });
    expect(h.signTransaction).toHaveBeenCalledTimes(1);
    expect(result.steps.map((s: { step: string }) => s.step)).toContain("outcomeUnknown");
  });
  it("records UNKNOWN when no receipt arrives within the bounded wait", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", receiptTimeout: true });
    expect(h.calls).toEqual(["persistSigned", "markBroadcastAttempted", "send", "persistOutcome:UNKNOWN"]);
    expect(result.execution).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "UNKNOWN" });
    expect(h.outcomes[0].note).toContain("receipt not obtained");
    expect(h.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("review round 2 — evidence before the broadcast, the real snapshot age", () => {
  it("persists every artefact up to the signed execution record, and a persistence failure before the broadcast stops the run with nothing sent", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT" });
    expect(h.artifacts.slice(0, 8)).toEqual(["order", "intent", "quote", "feeAuthorization", "report", "approval", "decision", "execution"]);
    expect(h.artifacts).toContain("finalValidation"); expect(h.artifacts.filter((a) => a === "execution").length).toBeGreaterThanOrEqual(3);
    expect(result.execution.chainStatus).toBe("CONFIRMED");
    const h2 = harness({ fixture: "APPROVED_PAYMENT", artifactFails: "finalValidation" });
    const expectation = expect(runFixture(h2.options)).rejects.toThrow(/artefact finalValidation could not be persisted before the broadcast.*nothing was sent/); // attached before the timers run: no unhandled rejection
    await vi.runAllTimersAsync(); await expectation;
    expect(h2.sendRawTransaction).not.toHaveBeenCalled(); expect(h2.store.markBroadcastAttempted).not.toHaveBeenCalled(); expect(h2.signTransaction).not.toHaveBeenCalled();
  });
  it("a persistence failure after the broadcast is logged, never fatal: the outcome is still established", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", artifactFails: "postcondition" });
    expect(h.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS" });
    expect(result.steps.find((s: { step: string }) => s.step === "artifactNotPersisted")).toMatchObject({ artifact: "postcondition" });
  });
  it("review of 0c0d406 (P1-3): the window closes while the broadcast marker is written → the send is skipped and the attempt is closed as never broadcast", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", markerTakesMs: 6000 }); // the runner policy allows 5 s
    expect(h.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.calls).toEqual(["persistSigned", "markBroadcastAttempted", "persistOutcome:SIGNED_NOT_BROADCAST"]);
    expect(result.execution).toMatchObject({ chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED", businessTxHash: null });
    expect(result.steps.find((s: { step: string }) => s.step === "notBroadcast").why).toMatch(/after the broadcast marker and before the send/);
    expect(result.steps.map((s: { step: string }) => s.step)).not.toContain("broadcast");
  });
  it("the validation window counts from the pinned observation: a snapshot already older than the window is refused and nothing is signed", async () => {
    const { h, result } = await run({ fixture: "APPROVED_PAYMENT", staleSnapshotSeconds: 30 }); // the runner policy allows 5 s
    expect(result.finalValidation.result).toBe("REVIEW_REQUIRED");
    expect(result.finalValidation.reasons.join("; ")).toMatch(/exceeded its own window/);
    expect(h.signTransaction).not.toHaveBeenCalled();
    const fresh = await run({ fixture: "APPROVED_PAYMENT" });
    const fv = fresh.result.finalValidation;
    expect(new Date(fv.expiresAt).getTime() - new Date(fv.snapshot.observedAt).getTime()).toBeLessThanOrEqual(5000); // expiry = observedAt + window, not "now + window"
  });
});

describe("Gate D: the order creation's per-transaction gas cap", () => {
  const PAYER = "0x00000000000000000000000000000000000000aa" as Hex;
  const parts = (maxFeePerGas: bigint, estimate = 50_000n) => {
    const order: string[] = [];
    const writeContract = vi.fn(async (_a: any) => { order.push("send"); return D; });
    const store: OrderStore = { planned: vi.fn(() => { order.push("planned"); }), sent: vi.fn(() => { order.push("sent"); }), confirmed: vi.fn(() => { order.push("confirmed"); }) };
    const publicClient = { estimateGas: vi.fn(async () => { order.push("estimate"); return estimate; }), waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 100n, gasUsed: 41_000n, effectiveGasPrice: maxFeePerGas, from: PAYER })) };
    const o = { publicClient, admin: { account: { address: PAYER }, writeContract }, merchant: MERCHANT, feeParams: async () => ({ maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n }) } as any;
    return { o, writeContract, store, publicClient, order };
  };
  it("estimates first and sends with an explicit gas limit of estimate × 1.2; the identity is durable before the send", async () => {
    const { o, writeContract, store, publicClient, order } = parts(20_000_000_000n);
    const created = await createOrder(o, PAYER, AMOUNT, store);
    expect(created.tx).toBe(D);
    expect(publicClient.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ account: PAYER, to: MERCHANT, data: expect.stringMatching(/^0x/) }));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0][0]).toMatchObject({ address: MERCHANT, functionName: "createOrder", gas: 60_000n, maxFeePerGas: 20_000_000_000n });
    expect(order).toEqual(["estimate", "planned", "send", "sent", "confirmed"]);
    expect(DEFAULT_ORDER_GAS_COST_CAP).toBe(6_000_000_000_000_000n); // 150k gas × 40 gwei = 0.006 USDC
  });
  it("a fee spike that puts gas limit × maxFeePerGas above the cap refuses before anything is persisted or sent", async () => {
    const { o, writeContract, store, order } = parts(200_000_000_000n); // 60k × 200 gwei = 0.012 USDC > 0.006
    await expect(createOrder(o, PAYER, AMOUNT, store)).rejects.toThrow(/^createOrder refused: worst-case gas cost 12000000000000000 \(gas limit 60000 × maxFeePerGas 200000000000\) exceeds the per-transaction cap 6000000000000000; nothing was persisted or sent$/);
    expect(writeContract).not.toHaveBeenCalled(); expect(store.planned).not.toHaveBeenCalled(); expect(order).toEqual(["estimate"]);
  });
  it("the caller's cap is used when given: a tighter cap refuses at normal fees, an estimate above the default ceiling refuses too", async () => {
    const tight = parts(20_000_000_000n);
    await expect(createOrder({ ...tight.o, maxOrderGasCostNativeAtomic: 1_000_000_000_000_000n }, PAYER, AMOUNT, tight.store)).rejects.toThrow(/^createOrder refused:/); // 0.0012 > 0.001
    expect(tight.writeContract).not.toHaveBeenCalled();
    const heavy = parts(30_000_000_000n, 200_000n); // 240k × 30 gwei = 0.0072 > 0.006
    await expect(createOrder(heavy.o, PAYER, AMOUNT, heavy.store)).rejects.toThrow(/^createOrder refused:/); expect(heavy.writeContract).not.toHaveBeenCalled();
  });
  it("the run path refuses the same way: runFixture stops before the order exists and nothing is signed or sent", async () => {
    const h = harness({ fixture: "APPROVED_PAYMENT" });
    const opts = { ...h.options, feeParams: async () => ({ maxFeePerGas: 200_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }) } as RunOptions;
    const expectation = expect(runFixture(opts)).rejects.toThrow(/^createOrder refused:/);
    await vi.runAllTimersAsync(); await expectation;
    expect((opts.admin as any).writeContract).not.toHaveBeenCalled(); expect(h.signTransaction).not.toHaveBeenCalled(); expect(h.sendRawTransaction).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });
});

describe("sendIdentical — the identical signed bytes, again only inside the window (Gate D, 2026-10-09)", async () => {
  const { sendIdentical } = await import("../src/index.js");
  const RAW = "0x02f8aa" as Hex;
  const client = (answers: (string | null)[]) => { const sent: string[] = []; return { sent, sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => { sent.push(serializedTransaction); const a = answers.shift(); if (a) throw new Error(a); return keccak256(serializedTransaction); }) }; };
  it("retries a node that does not accept transactions, then stops at the first acknowledgement", async () => {
    vi.useRealTimers();
    const c = client(['The method "eth_sendRawTransaction" does not exist / is not available.', null]);
    expect(await sendIdentical(c, RAW, () => true, 3, 0)).toEqual({ accepted: true, sendError: null, attempts: 2 });
    expect(c.sent).toEqual([RAW, RAW]); // the same bytes every time
  });
  it("never retries after the window, never retries a definitive rejection, and treats 'already known' as acknowledged", async () => {
    vi.useRealTimers();
    let open = true; const c1 = client(["socket hang up", "socket hang up"]);
    const r1 = sendIdentical(c1, RAW, () => open, 3, 0); open = false;
    expect(await r1).toMatchObject({ accepted: false, attempts: 1 }); expect(c1.sent).toHaveLength(1); // the clock moved past the window before the retry
    const c2 = client(["nonce too low: next nonce 45, tx nonce 44"]);
    expect(await sendIdentical(c2, RAW, () => true, 3, 0)).toMatchObject({ accepted: false, attempts: 1, sendError: expect.stringMatching(/nonce too low/) });
    const c3 = client(["already known"]);
    expect(await sendIdentical(c3, RAW, () => true, 3, 0)).toMatchObject({ accepted: true, attempts: 1 });
  });
});
