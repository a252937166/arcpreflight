// A schema-valid synthetic run (Arc Testnet 5042002) with consistent digests, plus the chain captures a verifier would see and a
// fake VerifierRpc that serves them. Shared by the passport and verifier tests. Nothing here touches a network.
// Variants: APPROVED (runner executes), REVIEW_REQUIRED (nothing signed), WALLET (the payer's wallet executes the same plan and sets
// its own gas, fees and nonce — docs/LIFECYCLE.md §1; the plan still says nonce 9, gas 60000, maxFee 21 gwei).
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, toHex, getAddress, type Hex } from "viem";
import { IntentCore, PolicyCore, BaselineCore, ReportCore, DecisionReceipt, TransactionPlan, FinalValidationReceipt, ExecutionReceipt, QuoteCore, intentDigest, policyDigest, baselineDigest, reportDigest, decisionDigest, transactionPlanDigest, finalValidationDigest, executionDigest, digest, type Snapshot } from "@arcpreflight/schema";
import { AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC, addressTopic, encodeTransferWithAuthorization } from "@arcpreflight/client";
import type { PassportSource, RunResultLike, EvidenceEntry, RpcEvidenceLike, Step } from "../src/index.js";

export const H = (s: string): Hex => keccak256(toHex(s));
export const CHAIN = 5042002 as const;
export const CAIP2 = "eip155:5042002";
export const USDC = "0x3600000000000000000000000000000000000000" as Hex;
export const PAYER = "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE" as Hex;
export const MERCHANT = "0xA8eB51EF994567B84215981E8d1Fe17cb8e42252" as Hex;
export const RELAYER = "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0" as Hex;
export const ORDER_CREATOR = "0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b" as Hex;
export const IMPL_A = "0x342ab0e9f7951e4112e698ff69ac00ac18c009f9" as Hex;
export const IMPL_B = "0x4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a" as Hex;
export const ORDER_ID = ("0x" + "aa".repeat(32)) as Hex;
export const AMOUNT = 50_000_000_000_000_000n;
export const FEE = 10_000n;
export const FEE_TX = H("fee-tx"), BIZ_TX = H("business-tx"), CREATE_TX = H("create-order-tx");
export const ORDER_PAID_TOPIC = keccak256(toHex("OrderPaid(bytes32,address,uint256)"));
export const ORDER_CREATED_TOPIC = keccak256(toHex("OrderCreated(bytes32,address,uint256)"));
const PAY_ABI = [{ type: "function", name: "pay", stateMutability: "payable", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [] }] as const;
const CREATE_ABI = [{ type: "function", name: "createOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "payer", type: "address" }, { name: "amountNativeAtomic", type: "uint256" }], outputs: [] }] as const;
export const PAY_DATA = encodeFunctionData({ abi: PAY_ABI, functionName: "pay", args: [ORDER_ID] });
export const PAY_SELECTOR = PAY_DATA.slice(0, 10) as Hex;
const FAKE_SIG = ("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b") as Hex; // only ever inside the fee calldata, which the exporter redacts
const T0 = "2026-10-08T10:00:00.000Z";
const snap = (n: string, tag: string): Snapshot => ({ chainId: CHAIN, blockNumber: n, blockHash: H(`block-${tag}`), observedAt: T0, providerId: "rpc.testnet", pinningMode: "BLOCK_HASH" });
const ev = (method: string, params: unknown[], s: Snapshot, result: string | null): EvidenceEntry => {
  const evidence: RpcEvidenceLike = { kind: "rpc", method, params: params.map((p) => JSON.stringify(p)), result, error: null, snapshot: s, capturedAt: T0 };
  return { evidence, digest: digest("evidence", "1.0", evidence) };
};
const word = (v: bigint) => pad(toHex(v), { size: 32 });

export type Variant = "APPROVED" | "REVIEW_REQUIRED" | "WALLET";
export type Fixture = ReturnType<typeof syntheticRun>;

export function syntheticRun(variant: Variant = "APPROVED") {
  const approved = variant !== "REVIEW_REQUIRED"; const wallet = variant === "WALLET";
  const s0 = snap("65993400", "baseline"), s1 = snap("65993430", "report"), s2 = snap("65993443", "final");
  const implNow = approved ? IMPL_A : IMPL_B;
  const deps = (impl: Hex) => [
    { address: MERCHANT, role: "TARGET" as const, codeHash: H("proxy-code"), adapterDigest: H("adapter"), resolution: "VERIFIED_TEMPLATE" as const },
    { address: impl, role: "IMPLEMENTATION" as const, codeHash: H(`impl-code-${impl}`), adapterDigest: null, resolution: "VERIFIED_TEMPLATE" as const },
  ];
  const baseline = BaselineCore.parse({ schemaVersion: "1.0", chainId: CHAIN, subject: MERCHANT, approvedBy: "operator:admin", approvedAt: T0, validUntil: null, previousBaselineDigest: null, referenceSnapshot: s0, dependencies: deps(IMPL_A), allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [H("adapter")], approvedState: [] });
  const bDigest = baselineDigest(baseline);
  const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "demo-runner", allowedSenders: [PAYER], allowedTargets: [MERCHANT], allowedSelectors: [PAY_SELECTOR], maxNativePaymentAtomic: AMOUNT.toString(), maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED"], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
  const pDigest = policyDigest(policy);
  const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `demo-${variant}-fixture`, chainId: CHAIN, walletMode: "EOA_DIRECT_NON_DELEGATED", from: PAYER, operation: "CALL", to: MERCHANT, data: PAY_DATA, valueNativeAtomic: AMOUNT.toString(),
    businessExpectation: { sourceId: `order:${ORDER_ID}`, sourceDigest: H(`order:${ORDER_ID}:${PAYER}:${AMOUNT}`), action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT.toString(), orderId: ORDER_ID }, baselineDigest: bDigest, policyDigest: pDigest, expiresAt: "2026-10-08T10:10:00.000Z" });
  const iDigest = intentDigest(intent);
  const reportEvidence = [ev("eth_getCode", [MERCHANT, { blockHash: s1.blockHash }], s1, "0x6080"), ev("eth_getStorageAt", [MERCHANT, "0x3608…bbc", { blockHash: s1.blockHash }], s1, pad(implNow, { size: 32 }))];
  const report = ReportCore.parse({ schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: iDigest, decisionEligible: true, observation: s1, methodologyDigest: H("methodology"), adapterManifestDigests: [H("adapter")], baselineDigest: bDigest, baselineResult: approved ? "MATCH" : "IMPLEMENTATION_CHANGED", dependencies: deps(implNow),
    signals: [{ id: "PROXY_TEMPLATE_VERIFIED", state: "observed", basis: "chain_read", scope: "proxy runtime code hash matches oz-erc1967proxy-uups@5.4.0", evidenceDigests: [reportEvidence[0].digest], limitations: [], sourceIds: [] }], rawEvidenceDigests: reportEvidence.map((e) => e.digest), exclusions: [], expiresAt: "2026-10-08T10:01:00.000Z" });
  const rDigest = reportDigest(report);
  const attemptId = "22222222-2222-4222-8222-222222222222", requestId = "11111111-1111-4111-8111-111111111111";
  const decision = DecisionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: rDigest, baselineDigest: bDigest, policyDigest: pDigest, decision: approved ? "NO_POLICY_VIOLATION" : "REVIEW_REQUIRED", reasons: approved ? [] : ["BASELINE_STATUS: implementation changed since approval"], decidedAt: T0 });
  const dDigest = decisionDigest(decision);
  const quote = QuoteCore.parse({ schemaVersion: "1.0", requestId, buyerPrincipal: "demo-runner", payer: PAYER, intentDigest: iDigest, reportDigest: rDigest, coverageDigest: rDigest, network: CAIP2, asset: USDC, amountTokenAtomic: FEE.toString(), payTo: RELAYER, preparedAt: T0, expiresAt: "2026-10-08T10:00:30.000Z", retentionUntil: "2026-11-07T10:00:00.000Z" });
  const feeAuthorization = { from: PAYER, to: RELAYER, value: FEE.toString(), validAfter: "0", validBefore: "9999999999", nonce: H("auth-nonce") };
  const steps: Step[] = [
    { step: "createOrder", atMs: 10, tx: CREATE_TX, orderId: ORDER_ID, block: "65993420", who: "order-creator", why: "the business expectation must come from an independently approved order" },
    { step: "intent", atMs: 20, intentDigest: iDigest }, { step: "quote", atMs: 30, http: 402, requestId }, { step: "signServiceFee", atMs: 40, eip3009: { to: RELAYER, value: FEE.toString(), nonce: feeAuthorization.nonce } },
    { step: "reportDelivered", atMs: 50, serviceFeeTx: FEE_TX, reportDigest: rDigest }, { step: "decision", atMs: 60, decision: decision.decision },
  ];
  let plan: TransactionPlan | null = null, fv: FinalValidationReceipt | null = null, fvEvidence: EvidenceEntry[] = [], postcondition: RunResultLike["postcondition"] = null;
  const execution: any = { schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: rDigest, decisionDigest: dDigest, baselineDigest: bDigest, policyDigest: pDigest, finalValidationDigest: null, transactionPlanDigest: null, signedTransactionHash: null, businessTxHash: null, chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", postconditionEvidenceDigests: [], labels: ["LIVE_REQUEST"], recordedAt: T0 };
  if (approved) {
    plan = TransactionPlan.parse({ chainId: CHAIN, from: PAYER, type: 2, to: MERCHANT, data: PAY_DATA, valueNativeAtomic: AMOUNT.toString(), nonce: "9", gasLimit: "60000", maxFeePerGasNativeAtomic: "21000000000", maxPriorityFeePerGasNativeAtomic: "1000000000", accessList: [], authorizationList: [] });
    const planDigest = transactionPlanDigest(plan);
    const evImpl = ev("eth_getStorageAt", [MERCHANT, "0x3608…bbc", { blockHash: s2.blockHash }], s2, pad(IMPL_A, { size: 32 })), evPaused = ev("eth_call", [{ to: MERCHANT, data: "0x5c975abb" }, { blockHash: s2.blockHash }], s2, word(0n)), evSim = ev("eth_call", [{ to: MERCHANT, data: PAY_DATA, from: PAYER, value: AMOUNT.toString() }, { blockHash: s2.blockHash }], s2, "0x"), evCode = ev("eth_getCode", [PAYER, { blockHash: s2.blockHash }], s2, "0x");
    fvEvidence = [evImpl, evPaused, evSim, evCode];
    fv = FinalValidationReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: rDigest, decisionDigest: dDigest, baselineDigest: bDigest, policyDigest: pDigest, snapshot: s2, transactionPlan: plan, transactionPlanDigest: planDigest, walletEvidenceDigest: evCode.digest, criticalStateEvidenceDigests: [evImpl.digest, evPaused.digest], simulationEvidenceDigest: evSim.digest, balanceNativeAtomic: "4900000000000000000", reservedGasNativeAtomic: "1260000000000000", reservedOtherNativeAtomic: "0", feeEvidenceDigest: H("fees"), result: "PASS", reasons: [], validatedAt: T0, expiresAt: "2026-10-08T10:00:05.000Z" });
    postcondition = { orderId: ORDER_ID, paid: true, payer: getAddress(PAYER), amountNativeAtomic: AMOUNT.toString(), block: "65993462", receiptStatus: "success" };
    Object.assign(execution, { finalValidationDigest: finalValidationDigest(fv), transactionPlanDigest: planDigest, signedTransactionHash: BIZ_TX, businessTxHash: BIZ_TX, chainStatus: "CONFIRMED", businessStatus: "SUCCESS", postconditionEvidenceDigests: [keccak256(toHex(JSON.stringify(postcondition)))] });
    steps.push({ step: "finalValidation", atMs: 70, result: "PASS", newPinnedBlock: s2.blockNumber, feeConfirmedBlock: "65993438" }, { step: "signed", atMs: 80, signedTransactionHash: BIZ_TX }, { step: "broadcast", atMs: 90, businessTxHash: BIZ_TX, accepted: true }, { step: "postcondition", atMs: 100, ...postcondition });
  } else steps.push({ step: "notSigned", atMs: 70, decision: decision.decision });
  const exec = ExecutionReceipt.parse(execution);
  const result: RunResultLike = { fixture: approved ? "APPROVED_PAYMENT" : "CHANGED_IMPLEMENTATION", network: "testnet", chainId: CHAIN, attemptId, orderId: ORDER_ID, merchant: MERCHANT, intent, intentDigest: iDigest, policy, policyDigest: pDigest, requestId, serviceFeeTx: FEE_TX, report, reportDigest: rDigest, simulation: { ok: true, error: null }, decision, decisionDigest: dDigest, finalValidation: fv, plan, execution: exec, executionDigest: executionDigest(exec), postcondition, steps, durationMs: 31_000,
    quote, quoteDigest: null, feeAuthorization, finalValidationEvidence: fvEvidence, approvalStatusAtValidation: approved ? { revoked: false, validUntil: null, fetchedAt: T0 } : null };
  // ---- what the chain shows (captures + fake RPC)
  const feeLogs = [
    { address: USDC, topics: [AUTHORIZATION_USED_TOPIC, addressTopic(PAYER), feeAuthorization.nonce], data: "0x", logIndex: 17, transactionHash: FEE_TX, blockNumber: "65993438" },
    { address: "0xfffffffffffffffffffffffffffffffffffffffe", topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(RELAYER)], data: word(FEE * 10n ** 12n), logIndex: 18, transactionHash: FEE_TX, blockNumber: "65993438" }, // EIP-7708 system log: ignored
    { address: USDC, topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(RELAYER)], data: word(FEE), logIndex: 19, transactionHash: FEE_TX, blockNumber: "65993438" },
  ];
  const txs: Record<string, Record<string, unknown>> = {
    [FEE_TX.toLowerCase()]: { hash: FEE_TX, from: RELAYER, to: USDC, input: encodeTransferWithAuthorization(feeAuthorization, FAKE_SIG), value: "0", nonce: 3, type: "eip1559", chainId: CHAIN, gas: "104569", maxFeePerGas: "25000000000", maxPriorityFeePerGas: "1000000000", accessList: [] },
    [CREATE_TX.toLowerCase()]: { hash: CREATE_TX, from: ORDER_CREATOR, to: MERCHANT, input: encodeFunctionData({ abi: CREATE_ABI, functionName: "createOrder", args: [ORDER_ID, PAYER, AMOUNT] }), value: "0", nonce: 1, type: "eip1559", chainId: CHAIN, gas: "150000", maxFeePerGas: "21000000000", maxPriorityFeePerGas: "1000000000", accessList: [] },
  };
  const receipts: Record<string, Record<string, unknown>> = {
    [FEE_TX.toLowerCase()]: { transactionHash: FEE_TX, status: "success", blockNumber: "65993438", blockHash: H("block-fee"), from: RELAYER, to: USDC, gasUsed: "87141", effectiveGasPrice: "25000000000", logs: feeLogs },
    [CREATE_TX.toLowerCase()]: { transactionHash: CREATE_TX, status: "success", blockNumber: "65993420", blockHash: H("block-create"), from: ORDER_CREATOR, to: MERCHANT, gasUsed: "98107", effectiveGasPrice: "21000000000", logs: [{ address: MERCHANT, topics: [ORDER_CREATED_TOPIC, ORDER_ID, addressTopic(PAYER)], data: word(AMOUNT), logIndex: 0, transactionHash: CREATE_TX, blockNumber: "65993420" }] },
  };
  if (approved) {
    // wallet mode: the wallet chose its own nonce, gas limit and fees; to/data/value/chainId/type are the plan's
    txs[BIZ_TX.toLowerCase()] = { hash: BIZ_TX, from: PAYER, to: MERCHANT, input: PAY_DATA, value: AMOUNT.toString(), nonce: wallet ? 10 : 9, type: "eip1559", chainId: CHAIN, gas: wallet ? "70000" : "60000", maxFeePerGas: wallet ? "22000000000" : "21000000000", maxPriorityFeePerGas: wallet ? "1500000000" : "1000000000", accessList: [] };
    receipts[BIZ_TX.toLowerCase()] = { transactionHash: BIZ_TX, status: "success", blockNumber: "65993462", blockHash: H("block-business"), from: PAYER, to: MERCHANT, gasUsed: "40364", effectiveGasPrice: "21000000000", logs: [{ address: MERCHANT, topics: [ORDER_PAID_TOPIC, ORDER_ID, addressTopic(PAYER)], data: word(AMOUNT), logIndex: 0, transactionHash: BIZ_TX, blockNumber: "65993462" }] };
  }
  const source: PassportSource = {
    generator: { release: "fixture", component: "api" }, disclosure: "public", chain: { chainId: CHAIN, caip2: CAIP2, usdc: USDC },
    subject: wallet ? { kind: "wallet-run", runId: null, attemptId, fixture: result.fixture, executionMode: "wallet" } : { kind: "demo-run", runId: "33333333-3333-4333-8333-333333333333", attemptId, fixture: result.fixture },
    template: { id: "oz-erc1967proxy-uups@5.4.0", merchant: "DemoMerchantV1", method: "pay(bytes32)", selector: PAY_SELECTOR },
    result, baseline, reportEvidence,
    settlement: { backend: "relay", state: "COMPLETED", transactionHash: FEE_TX, relayer: RELAYER, evidence: { transactionHash: FEE_TX, blockNumber: "65993438", authorizationUsedLogIndex: 17, transferLogIndex: 19, from: PAYER, to: RELAYER, value: FEE.toString(), nonce: feeAuthorization.nonce } },
    payment: { requestId, quote, authorization: feeAuthorization },
    chainCaptures: { feeTx: { tx: txs[FEE_TX.toLowerCase()], receipt: receipts[FEE_TX.toLowerCase()] }, createOrderTx: { tx: txs[CREATE_TX.toLowerCase()], receipt: receipts[CREATE_TX.toLowerCase()] }, ...(approved ? { businessTx: { tx: txs[BIZ_TX.toLowerCase()], receipt: receipts[BIZ_TX.toLowerCase()] } } : {}) },
    createdAt: "2026-10-08T10:05:00.000Z",
  };
  const anchors = { baselineDigests: [bDigest], policyDigests: [pDigest] };
  const orderState = { payer: PAYER, amount: AMOUNT, paid: approved };
  /** A VerifierRpc over the captures. `overrides` let tests break the world (other chain, other order state). */
  const rpc = (overrides: { chainId?: number; orderState?: Partial<typeof orderState>; drop?: string[] } = {}) => ({
    getChainId: async () => overrides.chainId ?? CHAIN,
    getTransaction: async (h: Hex) => (overrides.drop?.includes(h.toLowerCase()) ? null : txs[h.toLowerCase()] ?? null),
    getTransactionReceipt: async (h: Hex) => (overrides.drop?.includes(h.toLowerCase()) ? null : receipts[h.toLowerCase()] ?? null),
    getBlock: async (bh: Hex) => { const r = Object.values(receipts).find((x) => String(x.blockHash).toLowerCase() === bh.toLowerCase()); return r ? { number: r.blockNumber, hash: r.blockHash } : null; },
    call: async (a: { to: Hex; data: Hex; blockHash: Hex }) => {
      if (a.to.toLowerCase() !== MERCHANT.toLowerCase() || !a.data.startsWith("0x") || !a.blockHash) throw new Error("unexpected call");
      const st = { ...orderState, ...overrides.orderState };
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }], [st.payer, st.amount, st.paid, 0n, 0n]);
    },
  });
  return { source, anchors, rpc, digests: { baseline: bDigest, policy: pDigest, intent: iDigest, report: rDigest, decision: dDigest }, hashes: { FEE_TX, BIZ_TX, CREATE_TX }, txs, receipts };
}
