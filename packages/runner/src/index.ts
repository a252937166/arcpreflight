// The controlled demo runner as a library: one fixture -> (order creator creates order) -> intent -> 402 quote -> EIP-3009 pay ->
// report -> local deterministic decision -> final validation at a new block (after the fee confirmation; signer account verified) ->
// sign exact plan -> decode & compare -> PERSIST signed bytes -> record "broadcast may be attempted" -> broadcast -> business
// postcondition. A crash or timeout after the broadcast marker leaves the attempt UNKNOWN for reconciliation, never "failed".
// Used by the CLI example and by the API's public demo endpoint.
import { randomUUID, randomBytes } from "node:crypto";
import { encodeFunctionData, keccak256, parseTransaction, getAddress, toHex, type Hex, type PublicClient, type WalletClient, type Transport, type Chain, type Account, type PrivateKeyAccount } from "viem";
import { IntentCore, PolicyCore, BaselineCore, Digest, UIntString, intentDigest, policyDigest, DecisionReceipt, decisionDigest, TransactionPlan, FinalValidationReceipt, ExecutionReceipt, executionDigest, ReportCore, reportDigest } from "@arcpreflight/schema";
import { decide, DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization, type ArcNet } from "@arcpreflight/client";
import { PIN_LAG, type RpcEvidence } from "@arcpreflight/observer";
import { CREATE_ORDER_ABI, GET_ORDER_ABI } from "./abi.js";
import { finalValidate } from "./validate.js";
export { GET_ORDER_ABI, CREATE_ORDER_ABI, PAUSED_ABI, ORDER_PAID_TOPIC, ORDER_CREATED_TOPIC } from "./abi.js";
export * from "./reconcile.js";
export * from "./store.js";
export * from "./validate.js";
export * from "./orders.js";

export type Fixture = "APPROVED_PAYMENT" | "CHANGED_IMPLEMENTATION" | "AMOUNT_UNIT_MISMATCH";
export type Step = { step: string; atMs: number; [k: string]: unknown };
/** Everything a later process needs to reconcile a business transaction from its ORIGINAL context: no re-signing, no new order. */
export type SignedExecution = {
  attemptId: string; fixture: Fixture; orderId: Hex; merchant: Hex; payer: Hex; amountNativeAtomic: string;
  intentDigest: Hex; reportDigest: Hex; decisionDigest: Hex; baselineDigest: Hex; policyDigest: Hex; finalValidationDigest: Hex; transactionPlanDigest: Hex;
  txHash: Hex; nonce: number; raw: Hex; validUntil: string; labels: string[];
};
export type ExecutionOutcome = {
  chainStatus: "SIGNED_NOT_BROADCAST" | "PENDING" | "CONFIRMED" | "REVERTED" | "UNKNOWN"; businessStatus: "NOT_EXECUTED" | "PENDING" | "SUCCESS" | "FAILED" | "UNKNOWN";
  businessTxHash: Hex | null; block?: string | null; postcondition?: unknown; note?: string;
  /** receipt facts of the transaction the outcome rests on (gas for the cost statement): never estimated, null when no receipt was read */
  receiptFacts?: { from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; blockNumber: string | null; status: string | null } | null;
};
/** Durable store the API implements (spec D07). Calls are awaited in this order: persistSigned → markBroadcastAttempted → persistOutcome. */
export type ExecutionStore = {
  persistSigned(e: SignedExecution): Promise<void> | void;
  markBroadcastAttempted(attemptId: string, info?: { headBlock: string | null }): Promise<void> | void;
  persistOutcome(attemptId: string, o: ExecutionOutcome): Promise<void> | void;
};
export type RunOptions = {
  fixture: Fixture; net: ArcNet; chain: Chain; publicClient: PublicClient; admin: WalletClient<Transport, Chain, Account>; runner: PrivateKeyAccount;
  merchant: Hex; baselineDigest: Hex; apiUrl: string; token: string; amountNativeAtomic?: bigint; feeParams: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  onStep?: (s: Step) => void; labels?: ("LIVE_REQUEST" | "DEMO_ON_MAINNET" | "RECORDED_SAMPLE")[];
  /** serialises order-creation transactions when several callers share that key (nonce safety) */
  adminLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** who signs createOrder, for the step log (the API passes the configured role) */
  orderSignerLabel?: string;
  /** durable persistence of the signed business transaction before any broadcast (D07) */
  executionStore?: ExecutionStore;
  /** bounded wait for the business receipt; afterwards the attempt is UNKNOWN and left to reconciliation */
  receiptTimeoutMs?: number;
  /** every artefact as soon as it exists (design v3.3 §4): a run that stops after the broadcast still exports a complete passport */
  onArtifact?: (name: ArtifactName, value: unknown) => void | Promise<void>;
  /** order identity persisted BEFORE the creation transaction is sent (design v3.3 §2) */
  orderStore?: OrderStore;
  /** free-text order reference, stored off-chain only */
  orderReference?: string | null;
  /** labelled interruption (design v3.3 §4): persist, mark and send, then stop waiting — the attempt is left to reconciliation */
  interruptAfterBroadcast?: boolean;
  /** per-transaction cap on the order creation's worst-case gas cost, gasLimit × maxFeePerGas (Gate D); default {@link DEFAULT_ORDER_GAS_COST_CAP} */
  maxOrderGasCostNativeAtomic?: bigint;
};
/** createOrder ≤ 150k gas at ≤ 40 gwei = 0.006 USDC: the order creation refuses to send above this unless the caller passes another cap */
export const DEFAULT_ORDER_GAS_COST_CAP = 150_000n * 40_000_000_000n;
export type ArtifactName = "order" | "intent" | "quote" | "feeAuthorization" | "report" | "approval" | "decision" | "finalValidation" | "execution" | "postcondition";
export type OrderStore = {
  planned(o: { orderId: Hex; payer: Hex; amountNativeAtomic: string; merchant: Hex }): Promise<void> | void;
  sent(o: { orderId: Hex; tx: Hex }): Promise<void> | void;
  confirmed(o: OrderCreation): Promise<void> | void;
};
const bigJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const sleep = (ms: number) => new Promise<void>((s) => setTimeout(s, ms));
/** digest of a business postcondition record; reconciliation recomputes it the same way */
export const postconditionDigest = (p: unknown): Hex => keccak256(toHex(JSON.stringify(p)));

/** The approval referenced by the intent — never "the latest approval": a new approval is a new digest and a new intent. */
async function currentBaseline(o: Pick<RunOptions, "apiUrl" | "token" | "baselineDigest">): Promise<{ baseline: BaselineCore | null; baselineDigest: Hex | null; baselineRevoked: boolean }> {
  const unavailable = { baseline: null, baselineDigest: null, baselineRevoked: false };
  try {
    const r = await fetch(`${o.apiUrl}/v1/baselines/${o.baselineDigest}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return unavailable;
    const body = await r.json();
    const parsed = BaselineCore.safeParse(body.baseline);
    const digest = Digest.safeParse(body.baselineDigest);
    if (!parsed.success || !digest.success || typeof body.revoked !== "boolean") return unavailable;
    if (digest.data.toLowerCase() !== o.baselineDigest.toLowerCase()) return unavailable; // the server must return the digest that was asked for
    return { baseline: parsed.data, baselineDigest: digest.data as Hex, baselineRevoked: body.revoked };
  } catch { return unavailable; }
}

/** The order creator creates an order for `payer` (management transaction; budgeted by the caller). The gas is estimated first and sent as an
 *  explicit limit (estimate × 1.2); if that limit at the current maxFeePerGas exceeds the per-transaction cap the creation is refused before
 *  anything is persisted or sent (Gate D) — no order row claims a creation that never left. */
export type OrderCreation = { orderId: Hex; tx: Hex; block: string; from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null };
const receiptFacts = (r: any) => ({ from: (r?.from as Hex | undefined) ?? null, gasUsed: r?.gasUsed !== undefined && r?.gasUsed !== null ? String(r.gasUsed) : null, effectiveGasPriceNativeAtomic: r?.effectiveGasPrice !== undefined && r?.effectiveGasPrice !== null ? String(r.effectiveGasPrice) : null });
/** Hands the same signed bytes to the node up to `maxAttempts` times while `inWindow()` holds (checked with a fresh clock before every
 *  retry). Returns whether a node acknowledged them. "already known" counts as acknowledged; definitive rejections end the attempts. */
export const SEND_ATTEMPTS = 3;
const DEFINITIVE_SEND_ERROR = /nonce too low|insufficient funds|underpriced|intrinsic gas|exceeds block gas limit|invalid sender|chain ?id/i;
export async function sendIdentical(client: { sendRawTransaction(a: { serializedTransaction: Hex }): Promise<unknown> }, raw: Hex, inWindow: () => boolean, maxAttempts = SEND_ATTEMPTS, pauseMs = 400): Promise<{ accepted: boolean; sendError: string | null; attempts: number }> {
  let sendError: string | null = null, attempts = 0;
  while (attempts < maxAttempts) {
    if (attempts > 0) { await new Promise((r) => setTimeout(r, pauseMs)); if (!inWindow()) break; } // never after the window
    attempts++;
    try { await client.sendRawTransaction({ serializedTransaction: raw }); return { accepted: true, sendError: null, attempts }; }
    catch (e: any) {
      sendError = String(e?.shortMessage ?? e?.message ?? e).slice(0, 160);
      if (/already known|known transaction|already imported/i.test(sendError)) return { accepted: true, sendError, attempts };
      if (DEFINITIVE_SEND_ERROR.test(sendError)) break;
    }
  }
  return { accepted: false, sendError, attempts };
}
export async function createOrder(o: Pick<RunOptions, "publicClient" | "admin" | "merchant" | "feeParams" | "maxOrderGasCostNativeAtomic">, payer: Hex, amount: bigint, store?: OrderStore): Promise<OrderCreation> {
  const orderId = toHex(randomBytes(32)) as Hex;
  const args = [orderId, payer, amount] as const;
  const fees = await o.feeParams();
  // transaction-level cap (Gate D): estimate, add 20 %, and refuse before anything is persisted or sent when the worst case is above the cap
  const estimate = await o.publicClient.estimateGas({ account: o.admin.account?.address, to: o.merchant, data: encodeFunctionData({ abi: CREATE_ORDER_ABI, functionName: "createOrder", args }) } as any);
  const gasLimit = (BigInt(estimate) * 12n + 9n) / 10n;
  const cap = o.maxOrderGasCostNativeAtomic ?? DEFAULT_ORDER_GAS_COST_CAP;
  const worst = gasLimit * fees.maxFeePerGas;
  if (worst > cap) throw new Error(`createOrder refused: worst-case gas cost ${worst} (gas limit ${gasLimit} × maxFeePerGas ${fees.maxFeePerGas}) exceeds the per-transaction cap ${cap}; nothing was persisted or sent`);
  await store?.planned({ orderId, payer, amountNativeAtomic: amount.toString(), merchant: getAddress(o.merchant) as Hex }); // durable before anything is sent
  const h = await o.admin.writeContract({ address: o.merchant, abi: CREATE_ORDER_ABI, functionName: "createOrder", args, gas: gasLimit, ...fees });
  await store?.sent({ orderId, tx: h });
  const r = await o.publicClient.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`createOrder failed: ${h}`);
  const created = { orderId, tx: h, block: r.blockNumber.toString(), ...receiptFacts(r) };
  await store?.confirmed(created);
  return created;
}

export async function runFixture(o: RunOptions) {
  const AMOUNT = o.amountNativeAtomic ?? 50_000_000_000_000_000n;
  const attemptId = randomUUID(); const steps: Step[] = []; const t0 = Date.now();
  const log = (step: string, data: Record<string, unknown>) => { const s: Step = { step, atMs: Date.now() - t0, ...bigJson(data) }; steps.push(s); o.onStep?.(s); };
  // Artefacts are the evidence a passport is made of: until the broadcast marker is written, a failure to persist one stops the run
  // before anything can reach the network (review round 2); after the send the transaction may be out, so failures are only logged.
  let broadcastStarted = false;
  const artifact = async (name: ArtifactName, value: unknown) => {
    try { await o.onArtifact?.(name, bigJson(value)); }
    catch (e: any) {
      if (!broadcastStarted) throw new Error(`artefact ${name} could not be persisted before the broadcast: ${String(e?.message ?? e).slice(0, 120)}; nothing was sent`);
      log("artifactNotPersisted", { artifact: name, error: String(e?.message ?? e).slice(0, 160), why: "the transaction may already be on the network; the record is reconstructed from the store and the chain" });
    }
  };
  const runnerAcct = o.runner; const merchant = getAddress(o.merchant) as Hex;
  // 0. order (order creator): its identity is persisted before the creation transaction leaves (design v3.3 §2)
  const orderStore: OrderStore | undefined = o.orderStore ? {
    planned: async (x) => { log("orderPlanned", { orderId: x.orderId, payer: x.payer, amountNativeAtomic: x.amountNativeAtomic, merchant: x.merchant, who: o.orderSignerLabel ?? "order creator", why: "the order's identity is recorded before its creation transaction is sent, so an interruption can be reconciled from the chain" }); await o.orderStore!.planned(x); },
    sent: (x) => o.orderStore!.sent(x), confirmed: (x) => o.orderStore!.confirmed(x),
  } : undefined;
  const order = await (o.adminLock ?? ((fn) => fn()))(() => createOrder(o, runnerAcct.address, AMOUNT, orderStore));
  log("createOrder", { tx: order.tx, orderId: order.orderId, block: order.block, who: o.orderSignerLabel ?? "order creator", why: "the business expectation must come from an independently approved order, never from the calldata" });
  await artifact("order", { ...order, reference: o.orderReference ?? null, signer: o.orderSignerLabel ?? "order creator" });
  // 1. policy + intent
  const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "demo-runner", allowedSenders: [runnerAcct.address], allowedTargets: [merchant], allowedSelectors: [PAY_SELECTOR],
    maxNativePaymentAtomic: AMOUNT.toString(), maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000",
    maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"],
    unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
  const pDigest = policyDigest(policy);
  const value = o.fixture === "AMOUNT_UNIT_MISMATCH" ? (AMOUNT / 10n ** 12n).toString() : AMOUNT.toString();
  const intent: IntentCore = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `demo-${o.fixture}-${attemptId.slice(0, 8)}`, chainId: o.chain.id, walletMode: "EOA_DIRECT_NON_DELEGATED", from: runnerAcct.address, operation: "CALL",
    to: merchant, data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [order.orderId] }), valueNativeAtomic: value,
    businessExpectation: { sourceId: `order:${order.orderId}`, sourceDigest: keccak256(toHex(`order:${order.orderId}:${runnerAcct.address}:${AMOUNT}`)), action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT.toString(), orderId: order.orderId },
    baselineDigest: o.baselineDigest, policyDigest: pDigest, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  let iDigest = intentDigest(intent);
  await artifact("intent", { intent, intentDigest: iDigest, policy, policyDigest: pDigest });
  log("intent", { intentDigest: iDigest, valueNativeAtomic: value, approvedAmountNativeAtomic: AMOUNT.toString(), who: "demo-runner", why: o.fixture === "AMOUNT_UNIT_MISMATCH" ? "this fixture deliberately sets the native value to 0.05 USDC expressed in 6-decimal units" : "exact candidate call bound to the approved order" });
  // 2. quote -> pay -> report. The service pins PIN_LAG blocks behind its RPC head, so the order must be older than that
  //    before the pinned observation can see it; a stale pin is detected from the free 402 and re-requested at no cost.
  const hdr = { "content-type": "application/json", authorization: `Bearer ${o.token}` };
  const orderBlock = BigInt(order.block);
  for (let i = 0; i < 40; i++) { const head = await o.publicClient.getBlockNumber(); if (head >= orderBlock + PIN_LAG + 1n) break; await sleep(1000); }
  let r!: Response; let j: any; let attempt = 0;
  while (true) {
    r = await fetch(`${o.apiUrl}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent }) });
    j = await r.json();
    if (r.status !== 402) throw new Error(`expected 402 quote, got ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const pinnedInput = UIntString.safeParse(j.pinnedBlock);
    if (!pinnedInput.success) throw new Error("quote does not identify a valid pinned block; refusing to pay");
    const pinned = BigInt(pinnedInput.data);
    if (pinned < orderBlock) {
      if (attempt >= 5) throw new Error("quote remains pinned before the order after bounded retries; refusing to pay");
      attempt++;
      log("staleObservation", { pinnedBlock: j.pinnedBlock, orderBlock: order.block, why: "the free quote shows the report is pinned before the order existed; nothing was paid - re-request under a new clientRequestId" });
      intent.clientRequestId = `${intent.clientRequestId}-r${attempt}`;
      iDigest = intentDigest(intent);
      await artifact("intent", { intent, intentDigest: iDigest, policy, policyDigest: pDigest });
      log("intentRetried", { intentDigest: iDigest, clientRequestId: intent.clientRequestId, why: "the replacement request has its own content digest; the stale quote was never paid" });
      await sleep(1500); continue;
    }
    break;
  }
  log("quote", { http: 402, requestId: j.requestId, priceTokenAtomic: j.quote.amountTokenAtomic, payTo: j.quote.payTo, pinnedBlock: j.pinnedBlock ?? null, expiresAt: j.quote.expiresAt, why: "the report is prepared and pinned before any charge; the quote binds intent, report, price and payTo" });
  const quote = j.quote; const quoteDigest = j.quoteDigest as string | null ?? null; const requestId = j.requestId as string;
  await artifact("quote", { quote, quoteDigest, requestId });
  if (BigInt(quote.amountTokenAtomic) > BigInt(policy.maxServiceFeeTokenAtomic)) throw new Error("quote exceeds policy.maxServiceFeeTokenAtomic");
  const { signature, authorization } = await signTransferAuthorization(runnerAcct, o.net, { payTo: quote.payTo, valueTokenAtomic: BigInt(quote.amountTokenAtomic) });
  log("signServiceFee", { eip3009: { to: authorization.to, value: authorization.value, nonce: authorization.nonce }, who: "demo-runner", why: "one authorization = one quote; the service fee (0.01 USDC, 6-dec) is separate from the business payment" });
  await artifact("feeAuthorization", { from: authorization.from, to: authorization.to, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore), nonce: authorization.nonce }); // never the signature
  r = await fetch(`${o.apiUrl}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent, payment: { signature, authorization } }) });
  j = await r.json();
  let tries = 0;
  while (r.status === 202 && tries++ < 20) { log("settlementPending", { paymentId: j.payment?.paymentId }); await sleep(1500); r = await fetch(`${o.apiUrl}/v1/requests/${requestId}`, { headers: hdr }); j = await r.json(); }
  if (r.status !== 200 || j.delivery !== "DELIVERED") throw new Error(`report not delivered: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  const report = ReportCore.parse(j.report);
  if (reportDigest(report) !== j.reportDigest) throw new Error("report digest mismatch");
  if (report.intentDigest !== iDigest) throw new Error("report bound to a different intent");
  const serviceFeeTx = j.payment?.transaction as string;
  const feeAuthorization = { from: authorization.from, to: authorization.to, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore), nonce: authorization.nonce }; // never the signature
  let feeReceipt: { from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; blockNumber: string | null } | null = null;
  const finalValidationEvidence: { evidence: RpcEvidence; digest: Hex }[] = [];
  let approvalStatusAtValidation: { revoked: boolean; validUntil: string | null; fetchedAt: string } | null = null;
  await artifact("report", { report, reportDigest: j.reportDigest, serviceFeeTx, simulation: j.simulation ?? null, evidence: Array.isArray(j.evidence) ? j.evidence : [],
    settlement: j.payment ? { backend: j.payment.backend === "relay" ? "relay" : "circle", state: j.payment.state ?? "COMPLETED", transactionHash: j.payment.transaction ?? serviceFeeTx ?? null, evidence: j.payment.evidence ?? null } : null });
  log("reportDelivered", { serviceFeeTx, reportDigest: j.reportDigest, pinnedBlock: report.observation.blockNumber, baselineResult: report.baselineResult, decisionEligible: report.decisionEligible, signals: report.signals.filter((s) => s.basis !== "network_advisory").map((s) => `${s.id}=${s.state}`), why: "service fee settled on Arc by ArcPreflight's relayer (the merchant account submitted my EIP-3009 authorization and paid the gas in USDC); the runner re-hashes the report and checks it is bound to its own intent" });
  // 3. local decision
  const approval = await currentBaseline(o);
  await artifact("approval", { baseline: approval.baseline, baselineDigest: approval.baselineDigest, revoked: approval.baselineRevoked }); // the referenced approval as read now: the passport's baseline.json
  const { decision, checks, reasons } = decide({ intent, policy, policyDigest: pDigest, ...approval, report, reportDigest: j.reportDigest, now: new Date(), simulation: j.simulation });
  const decisionReceipt = DecisionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest, decision, reasons, decidedAt: new Date().toISOString() });
  const dDigest = decisionDigest(decisionReceipt);
  log("decision", { decision, checks: checks.map((c) => `${c.id}:${c.outcome}`), reasons: reasons.slice(0, 8), who: "demo-runner (deterministic policy, no LLM)", why: "hard violations block; unapproved change or unknowns require review; otherwise 'no configured check fired'" });
  await artifact("decision", { decision: decisionReceipt, decisionDigest: dDigest });
  const execution: any = { schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest,
    finalValidationDigest: null, transactionPlanDigest: null, signedTransactionHash: null, businessTxHash: null, chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", postconditionEvidenceDigests: [], labels: o.labels ?? ["LIVE_REQUEST", "DEMO_ON_MAINNET"], recordedAt: new Date().toISOString() };
  let finalValidation: any = null, plan: any = null, postcondition: any = null;
  let businessReceipt: { from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; blockNumber: string | null; status: string } | null = null;
  await artifact("execution", execution);
  if (decision === "NO_POLICY_VIOLATION") {
    // 4. final validation at a NEW pinned block that follows the fee confirmation and the order creation; signer account verified (shared validator)
    let feeBlock: bigint | null = null;
    for (let i = 0; i < 15 && feeBlock === null; i++) {
      try { const rc = await o.publicClient.getTransactionReceipt({ hash: serviceFeeTx as Hex }); if (rc?.blockNumber !== undefined && rc.blockNumber !== null) { feeBlock = BigInt(rc.blockNumber); feeReceipt = { ...receiptFacts(rc), blockNumber: feeBlock.toString() }; } } catch { /* not visible on this node yet */ }
      if (feeBlock === null) await sleep(1000);
    }
    const v = await finalValidate({ publicClient: o.publicClient, net: o.net, chainId: o.chain.id, merchant, intent, report, policy, attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, policyDigest: pDigest, baselineDigest: o.baselineDigest,
      approval: () => currentBaseline(o), signer: { address: runnerAcct.address, type: runnerAcct.type, requireLocal: true }, feeBlock, orderBlock, feeParams: o.feeParams });
    finalValidation = v.finalValidation; plan = v.plan; const planDigest = v.planDigest; const fvReasons = v.reasons; const fees = v.fees; const s2 = v.snapshot;
    finalValidationEvidence.push(...v.evidence); approvalStatusAtValidation = v.approvalStatusAtValidation;
    execution.finalValidationDigest = v.finalValidationDigest; execution.transactionPlanDigest = planDigest;
    log("finalValidation", { result: finalValidation.result, reasons: fvReasons, newPinnedBlock: s2.blockNumber, feeConfirmedBlock: feeBlock?.toString() ?? null, balanceNativeAtomic: finalValidation.balanceNativeAtomic, gasLimit: v.gasLimit.toString(), maxFeePerGasGwei: Number(fees.maxFeePerGas) / 1e9, who: "demo-runner", why: "service fee changed the balance and time passed: re-read implementation, paused, order, balance, fees AND the signer account at a NEW pinned block that follows the fee confirmation, before signing" });
    await artifact("finalValidation", { finalValidation, finalValidationEvidence, plan, approvalStatusAtValidation, feeReceipt });
    if (finalValidation.result === "PASS") {
      if (new Date(finalValidation.expiresAt) <= new Date()) throw new Error("final validation expired before signing");
      const raw = await runnerAcct.signTransaction({ chainId: o.chain.id, type: "eip1559", to: merchant, data: intent.data as Hex, value: BigInt(plan.valueNativeAtomic), nonce: Number(plan.nonce), gas: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGasNativeAtomic), accessList: [] });
      const parsed = parseTransaction(raw);
      const mismatch = [parsed.type !== "eip1559" && "type", parsed.chainId !== o.chain.id && "chainId", getAddress(parsed.to!) !== merchant && "to", parsed.data?.toLowerCase() !== intent.data.toLowerCase() && "data", parsed.value !== BigInt(plan.valueNativeAtomic) && "value", parsed.nonce !== Number(plan.nonce) && "nonce", parsed.gas !== BigInt(plan.gasLimit) && "gas",
        parsed.maxFeePerGas !== BigInt(plan.maxFeePerGasNativeAtomic) && "maxFeePerGas", parsed.maxPriorityFeePerGas !== BigInt(plan.maxPriorityFeePerGasNativeAtomic) && "maxPriorityFeePerGas", (parsed.accessList?.length ?? 0) !== 0 && "accessList", ((parsed as any).authorizationList?.length ?? 0) !== 0 && "authorizationList"].filter(Boolean);
      if (mismatch.length) throw new Error(`signed tx deviates from plan: ${mismatch.join(",")}`);
      const txHash = keccak256(raw);
      // D07: the signed bytes and their full context are durable BEFORE anything can reach the network
      await o.executionStore?.persistSigned({ attemptId, fixture: o.fixture, orderId: order.orderId, merchant, payer: runnerAcct.address, amountNativeAtomic: AMOUNT.toString(), intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest,
        finalValidationDigest: execution.finalValidationDigest, transactionPlanDigest: planDigest, txHash, nonce: Number(plan.nonce), raw, validUntil: finalValidation.expiresAt, labels: execution.labels });
      execution.signedTransactionHash = txHash; execution.chainStatus = "SIGNED_NOT_BROADCAST";
      log("signed", { signedTransactionHash: txHash, who: "demo-runner", why: "the signed raw transaction is decoded and compared field by field with the validated plan, then persisted with its context before any broadcast" });
      await artifact("execution", execution);
      if (new Date(finalValidation.expiresAt) <= new Date()) {
        await o.executionStore?.persistOutcome(attemptId, { chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "final validation expired before broadcast; nothing was sent" });
        log("notBroadcast", { why: "final validation expired before broadcast; the signed transaction is discarded and nothing reached the network" });
      } else {
        const headBlock = await o.publicClient.getBlockNumber().then((b) => b.toString()).catch(() => null);
        if (new Date(finalValidation.expiresAt) <= new Date()) { // re-checked after the last await before the send (review round 3): the head read may have taken the rest of the window
          await o.executionStore?.persistOutcome(attemptId, { chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "final validation expired while reading the head block, before the broadcast marker; nothing was sent" });
          log("notBroadcast", { why: "final validation expired after the head-block read and before the broadcast marker; the signed transaction is discarded and nothing reached the network" });
          execution.chainStatus = "SIGNED_NOT_BROADCAST"; execution.businessStatus = "NOT_EXECUTED";
        } else {
        await o.executionStore?.markBroadcastAttempted(attemptId, { headBlock }); // durable: from here on the transaction MAY be on the network
        broadcastStarted = true;
        log("broadcastAttempted", { businessTxHash: txHash, headBlock, why: "the durable marker is written before the send: from here on the transaction may be on the network, whatever happens to this process" });
        if (new Date(finalValidation.expiresAt) <= new Date()) { // review of 0c0d406 (P1-3): the marker write was the last await before the send — the clock is read once more; a transaction this process knows it never sent is closed as never sent
          await o.executionStore?.persistOutcome(attemptId, { chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "final validation expired while the broadcast marker was being written, before the send; nothing was sent" });
          log("notBroadcast", { why: "final validation expired after the broadcast marker and before the send; the signed transaction is discarded and nothing reached the network" });
          execution.chainStatus = "SIGNED_NOT_BROADCAST"; execution.businessStatus = "NOT_EXECUTED";
        } else {
          // The IDENTICAL signed bytes may be handed to the node again while the validation window is open (Gate D, 2026-10-09): a
          // load-balanced RPC answered one call from a node that does not accept transactions ("eth_sendRawTransaction does not exist /
          // is not available"). A fresh clock is read before every retry; "already known" means a node has it; a definitive rejection
          // (nonce too low, insufficient funds, underpriced, intrinsic gas) is not retried. Never a different transaction.
          const { accepted, sendError, attempts } = await sendIdentical(o.publicClient, raw, () => new Date(finalValidation.expiresAt) > new Date());
          execution.businessTxHash = txHash; execution.chainStatus = "PENDING"; execution.businessStatus = "PENDING";
          log("broadcast", { businessTxHash: txHash, accepted, error: sendError, attempts, why: accepted ? "raw transaction handed to the node" : "the node did not acknowledge the broadcast; it may still have propagated, so the outcome is reconciled from this hash and the order state — never by signing a replacement" });
          await artifact("execution", execution);
          if (o.interruptAfterBroadcast) {
            // labelled interruption (design v3.3 §4): the process stops waiting here, exactly like a crash after the send would
            execution.chainStatus = "UNKNOWN"; execution.businessStatus = "UNKNOWN";
            await o.executionStore?.persistOutcome(attemptId, { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: txHash, note: "simulated interruption after the broadcast: no receipt was awaited; the outcome is established by reconciliation from the original hash and the order state" });
            log("interruptedAfterBroadcast", { businessTxHash: txHash, why: "SIMULATED interruption: this run stopped waiting right after the send, as a crashed process would; recovery works from the recorded hash and the order state, never by signing a replacement" });
          } else {
            try {
              const rcpt = await o.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: o.receiptTimeoutMs ?? 90_000 });
              execution.chainStatus = rcpt.status === "success" ? "CONFIRMED" : "REVERTED";
              businessReceipt = { ...receiptFacts(rcpt), blockNumber: rcpt.blockNumber.toString(), status: String(rcpt.status) };
              const ord = await o.publicClient.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [order.orderId], blockNumber: rcpt.blockNumber });
              const paidOk = rcpt.status === "success" && ord[2] === true && ord[0].toLowerCase() === runnerAcct.address.toLowerCase() && ord[1] === AMOUNT;
              execution.businessStatus = paidOk ? "SUCCESS" : "FAILED";
              postcondition = { orderId: order.orderId, paid: ord[2], payer: ord[0], amountNativeAtomic: ord[1].toString(), block: rcpt.blockNumber.toString(), receiptStatus: rcpt.status };
              execution.postconditionEvidenceDigests = [postconditionDigest(postcondition)];
              await o.executionStore?.persistOutcome(attemptId, { chainStatus: execution.chainStatus, businessStatus: execution.businessStatus, businessTxHash: txHash, block: rcpt.blockNumber.toString(), postcondition });
              log("postcondition", { ...postcondition, why: "chain receipt success is not business success: the order itself must read as paid, by this payer, for the exact amount" });
              await artifact("postcondition", { postcondition, businessReceipt });
            } catch (e: any) {
              execution.chainStatus = "UNKNOWN"; execution.businessStatus = "UNKNOWN";
              await o.executionStore?.persistOutcome(attemptId, { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: txHash, note: `receipt not obtained: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}` });
              log("outcomeUnknown", { businessTxHash: txHash, why: "no receipt within the bounded wait; the transaction may have reached the network, so this attempt stays unresolved until reconciliation establishes the outcome from the original hash and the order state" });
            }
          }
        }
        }
      }
    } else { log("notSigned", { why: "final validation did not pass; no business transaction was signed" }); }
  } else { log("notSigned", { decision, why: decision === "BLOCKED" ? "hard violation: no business transaction is signed or broadcast (the separately authorized service fee was still a delivered negative result)" : "review required: a human must re-approve the baseline; no business transaction is signed or broadcast" }); }
  execution.recordedAt = new Date().toISOString();
  const exec = ExecutionReceipt.parse(execution);
  await artifact("execution", exec);
  if (feeReceipt === null) { try { const rc = await o.publicClient.getTransactionReceipt({ hash: serviceFeeTx as Hex }); if (rc) feeReceipt = { ...receiptFacts(rc), blockNumber: rc.blockNumber !== undefined && rc.blockNumber !== null ? String(rc.blockNumber) : null }; } catch { /* the API captures it at finalisation */ } }
  return bigJson({ fixture: o.fixture, network: o.net, chainId: o.chain.id, attemptId, orderId: order.orderId, merchant, intent, intentDigest: iDigest, policy, policyDigest: pDigest, requestId, serviceFeeTx, report, reportDigest: j.reportDigest, simulation: j.simulation,
    decision: decisionReceipt, decisionDigest: dDigest, finalValidation, plan, execution: exec, executionDigest: executionDigest(exec), postcondition, steps, durationMs: Date.now() - t0,
    // passport inputs (design v3.2 §13): the quote and the signature-less fee authorization, order-creation and receipt gas facts, the
    // final-validation evidence objects behind the digests, and the referenced approval's status as re-read before signing
    quote, quoteDigest, feeAuthorization, orderCreation: { tx: order.tx, block: order.block, from: order.from, gasUsed: order.gasUsed, effectiveGasPriceNativeAtomic: order.effectiveGasPriceNativeAtomic, signer: o.orderSignerLabel ?? "order creator", reference: o.orderReference ?? null },
    feeReceipt, businessReceipt, finalValidationEvidence, approvalStatusAtValidation }) as RunOutput;
}
/** Everything one run produced; the passport exporter and the API persist exactly this object. */
export type RunOutput = {
  fixture: Fixture; network: ArcNet; chainId: number; attemptId: string; orderId: Hex; merchant: Hex; intent: IntentCore; intentDigest: Hex; policy: PolicyCore; policyDigest: Hex; requestId: string; serviceFeeTx: string | null;
  report: ReportCore; reportDigest: Hex; simulation: { ok: boolean; error: string | null } | null; decision: DecisionReceipt; decisionDigest: Hex; finalValidation: FinalValidationReceipt | null; plan: TransactionPlan | null;
  execution: ExecutionReceipt; executionDigest: Hex; postcondition: { orderId: Hex; paid: boolean; payer: string; amountNativeAtomic: string; block: string; receiptStatus: string } | null; steps: Step[]; durationMs: number;
  quote: unknown; quoteDigest: string | null; feeAuthorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  orderCreation: { tx: Hex; block: string; from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; signer: string; reference: string | null };
  feeReceipt: { from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; blockNumber: string | null } | null;
  businessReceipt: { from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; blockNumber: string | null; status: string } | null;
  finalValidationEvidence: { evidence: RpcEvidence; digest: Hex }[]; approvalStatusAtValidation: { revoked: boolean; validUntil: string | null; fetchedAt: string } | null;
};
