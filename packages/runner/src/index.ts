// The controlled demo runner as a library: one fixture -> (admin creates order) -> intent -> 402 quote -> EIP-3009 pay ->
// report -> local deterministic decision -> final validation at a new block -> sign exact plan -> decode & compare ->
// broadcast raw -> business postcondition. Used by the CLI example and by the API's public demo endpoint.
import { randomUUID, randomBytes } from "node:crypto";
import { encodeFunctionData, keccak256, parseTransaction, getAddress, toHex, type Hex, type PublicClient, type WalletClient, type Transport, type Chain, type Account, type PrivateKeyAccount } from "viem";
import { IntentCore, PolicyCore, intentDigest, policyDigest, DecisionReceipt, decisionDigest, TransactionPlan, transactionPlanDigest, FinalValidationReceipt, finalValidationDigest, ExecutionReceipt, executionDigest, ReportCore, reportDigest } from "@arcpreflight/schema";
import { decide, DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization, type ArcNet } from "@arcpreflight/client";
import { captureSnapshot, readCall, readSlot, SLOTS, slotToAddress, PIN_LAG } from "@arcpreflight/observer";

export type Fixture = "APPROVED_PAYMENT" | "CHANGED_IMPLEMENTATION" | "AMOUNT_UNIT_MISMATCH";
export type Step = { step: string; atMs: number; [k: string]: unknown };
export type RunOptions = {
  fixture: Fixture; net: ArcNet; chain: Chain; publicClient: PublicClient; admin: WalletClient<Transport, Chain, Account>; runner: PrivateKeyAccount;
  merchant: Hex; baselineDigest: Hex; apiUrl: string; token: string; amountNativeAtomic?: bigint; feeParams: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  onStep?: (s: Step) => void; labels?: ("LIVE_REQUEST" | "DEMO_ON_MAINNET" | "RECORDED_SAMPLE")[];
  /** serialises admin transactions when several callers share the admin key (nonce safety) */
  adminLock?: <T>(fn: () => Promise<T>) => Promise<T>;
};
const CREATE_ORDER_ABI = [{ type: "function", name: "createOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "payer", type: "address" }, { name: "amountNativeAtomic", type: "uint256" }], outputs: [] }] as const;
const GET_ORDER_ABI = [{ type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }] }] as const;
const PAUSED_ABI = [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
const bigJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Admin creates an order for `payer` (management transaction; budgeted by the caller). */
export async function createOrder(o: Pick<RunOptions, "publicClient" | "admin" | "merchant" | "feeParams">, payer: Hex, amount: bigint): Promise<{ orderId: Hex; tx: Hex; block: string }> {
  const orderId = toHex(randomBytes(32)) as Hex;
  const fees = await o.feeParams();
  const h = await o.admin.writeContract({ address: o.merchant, abi: CREATE_ORDER_ABI, functionName: "createOrder", args: [orderId, payer, amount], ...fees });
  const r = await o.publicClient.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`createOrder failed: ${h}`);
  return { orderId, tx: h, block: r.blockNumber.toString() };
}

export async function runFixture(o: RunOptions) {
  const AMOUNT = o.amountNativeAtomic ?? 50_000_000_000_000_000n;
  const attemptId = randomUUID(); const steps: Step[] = []; const t0 = Date.now();
  const log = (step: string, data: Record<string, unknown>) => { const s: Step = { step, atMs: Date.now() - t0, ...bigJson(data) }; steps.push(s); o.onStep?.(s); };
  const runnerAcct = o.runner; const merchant = getAddress(o.merchant) as Hex;
  // 0. order (admin)
  const order = await (o.adminLock ?? ((fn) => fn()))(() => createOrder(o, runnerAcct.address, AMOUNT));
  log("createOrder", { tx: order.tx, orderId: order.orderId, block: order.block, who: "deployer-admin", why: "the business expectation must come from an independently approved order, never from the calldata" });
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
  log("intent", { intentDigest: iDigest, valueNativeAtomic: value, approvedAmountNativeAtomic: AMOUNT.toString(), who: "demo-runner", why: o.fixture === "AMOUNT_UNIT_MISMATCH" ? "this fixture deliberately encodes 0.05 USDC in 6-decimal units on the 18-decimal native path" : "exact candidate call bound to the approved order" });
  // 2. quote -> pay -> report. The service pins PIN_LAG blocks behind its RPC head, so the order must be older than that
  //    before the pinned observation can see it; a stale pin is detected from the free 402 and re-requested at no cost.
  const hdr = { "content-type": "application/json", authorization: `Bearer ${o.token}` };
  const orderBlock = BigInt(order.block);
  for (let i = 0; i < 40; i++) { const head = await o.publicClient.getBlockNumber(); if (head >= orderBlock + PIN_LAG + 1n) break; await new Promise((s) => setTimeout(s, 1000)); }
  let r!: Response; let j: any; let attempt = 0;
  while (true) {
    r = await fetch(`${o.apiUrl}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent }) });
    j = await r.json();
    if (r.status !== 402) throw new Error(`expected 402 quote, got ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const pinned = j.pinnedBlock ? BigInt(j.pinnedBlock) : null;
    if (pinned !== null && pinned < orderBlock && attempt++ < 5) {
      log("staleObservation", { pinnedBlock: j.pinnedBlock, orderBlock: order.block, why: "the free quote shows the report is pinned before the order existed; nothing was paid - re-request under a new clientRequestId" });
      intent.clientRequestId = `${intent.clientRequestId}-r${attempt}`; await new Promise((s) => setTimeout(s, 1500)); continue;
    }
    break;
  }
  log("quote", { http: 402, requestId: j.requestId, priceTokenAtomic: j.quote.amountTokenAtomic, payTo: j.quote.payTo, pinnedBlock: j.pinnedBlock ?? null, expiresAt: j.quote.expiresAt, why: "the report is prepared and pinned before any charge; the quote binds intent, report, price and payTo" });
  const quote = j.quote; const requestId = j.requestId as string;
  if (BigInt(quote.amountTokenAtomic) > BigInt(policy.maxServiceFeeTokenAtomic)) throw new Error("quote exceeds policy.maxServiceFeeTokenAtomic");
  const { signature, authorization } = await signTransferAuthorization(runnerAcct, o.net, { payTo: quote.payTo, valueTokenAtomic: BigInt(quote.amountTokenAtomic) });
  log("signServiceFee", { eip3009: { to: authorization.to, value: authorization.value, nonce: authorization.nonce }, who: "demo-runner", why: "one authorization = one quote; the service fee (0.01 USDC, 6-dec) is separate from the business payment" });
  r = await fetch(`${o.apiUrl}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent, payment: { signature, authorization } }) });
  j = await r.json();
  let tries = 0;
  while (r.status === 202 && tries++ < 20) { log("settlementPending", { paymentId: j.payment?.paymentId }); await new Promise((s) => setTimeout(s, 1500)); r = await fetch(`${o.apiUrl}/v1/requests/${requestId}`, { headers: hdr }); j = await r.json(); }
  if (r.status !== 200 || j.delivery !== "DELIVERED") throw new Error(`report not delivered: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  const report = ReportCore.parse(j.report);
  if (reportDigest(report) !== j.reportDigest) throw new Error("report digest mismatch");
  if (report.intentDigest !== iDigest) throw new Error("report bound to a different intent");
  const serviceFeeTx = j.payment?.transaction as string;
  log("reportDelivered", { serviceFeeTx, reportDigest: j.reportDigest, pinnedBlock: report.observation.blockNumber, baselineResult: report.baselineResult, decisionEligible: report.decisionEligible, signals: report.signals.filter((s) => s.basis !== "network_advisory").map((s) => `${s.id}=${s.state}`), why: "service fee settled on Arc through Circle Facilitator; the runner re-hashes the report and checks it is bound to its own intent" });
  // 3. local decision
  const dec = decide({ intent, policy, policyDigest: pDigest, baseline: null, baselineDigest: null, baselineRevoked: false, report, reportDigest: j.reportDigest, now: new Date(), simulation: j.simulation });
  const baselineBound = report.baselineDigest?.toLowerCase() === o.baselineDigest.toLowerCase();
  const checks = dec.checks.filter((c) => c.id !== "BASELINE_STATUS"); const reasons = dec.reasons.filter((x) => !x.startsWith("BASELINE_STATUS"));
  if (!baselineBound) reasons.push("BASELINE_STATUS: report.baselineDigest != intent.baselineDigest");
  const decision = checks.some((c) => c.outcome === "BLOCKED") ? "BLOCKED" : (checks.some((c) => c.outcome === "REVIEW_REQUIRED") || !baselineBound) ? "REVIEW_REQUIRED" : "NO_POLICY_VIOLATION";
  const decisionReceipt = DecisionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest, decision, reasons, decidedAt: new Date().toISOString() });
  const dDigest = decisionDigest(decisionReceipt);
  log("decision", { decision, checks: checks.map((c) => `${c.id}:${c.outcome}`), reasons: reasons.slice(0, 8), who: "demo-runner (deterministic policy, no LLM)", why: "hard violations block; unapproved change or unknowns require review; otherwise 'no configured check fired'" });
  const execution: any = { schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest,
    finalValidationDigest: null, transactionPlanDigest: null, signedTransactionHash: null, businessTxHash: null, chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", postconditionEvidenceDigests: [], labels: o.labels ?? ["LIVE_REQUEST", "DEMO_ON_MAINNET"], recordedAt: new Date().toISOString() };
  let finalValidation: any = null, plan: any = null, postcondition: any = null;
  if (decision === "NO_POLICY_VIOLATION") {
    const s2 = await captureSnapshot(o.publicClient, { providerId: `rpc.${o.net}` });
    const impl = await readSlot(o.publicClient, merchant, SLOTS.erc1967Impl, s2);
    const implNow = slotToAddress(impl.value);
    const approvedImpl = report.dependencies.find((d) => d.role === "IMPLEMENTATION")?.address;
    const paused = await readCall(o.publicClient, merchant, encodeFunctionData({ abi: PAUSED_ABI, functionName: "paused" }), s2);
    const sim2 = await readCall(o.publicClient, merchant, intent.data as Hex, s2, intent.from as Hex, BigInt(intent.valueNativeAtomic));
    const balance = await o.publicClient.getBalance({ address: runnerAcct.address, blockNumber: BigInt(s2.blockNumber) });
    const fees = await o.feeParams();
    const gasLimit = await o.publicClient.estimateGas({ account: runnerAcct.address, to: merchant, data: intent.data as Hex, value: BigInt(intent.valueNativeAtomic) });
    const gasReserve = gasLimit * fees.maxFeePerGas;
    const nonce = await o.publicClient.getTransactionCount({ address: runnerAcct.address, blockTag: "pending" });
    const fvReasons: string[] = [];
    if (!implNow || implNow.toLowerCase() !== approvedImpl?.toLowerCase()) fvReasons.push("implementation changed since report");
    if (!(paused.value.ok && BigInt(paused.value.data ?? "0x1") === 0n)) fvReasons.push("paused or unreadable");
    if (!sim2.value.ok) fvReasons.push(`re-simulation reverted: ${sim2.value.error}`);
    if (balance < BigInt(intent.valueNativeAtomic) + gasReserve) fvReasons.push("balance < value + gas reserve");
    if (gasReserve > BigInt(policy.maxGasCostNativeAtomic)) fvReasons.push("gas reserve exceeds policy.maxGasCostNativeAtomic");
    plan = TransactionPlan.parse({ chainId: o.chain.id, from: runnerAcct.address, type: 2, to: merchant, data: intent.data, valueNativeAtomic: intent.valueNativeAtomic, nonce: nonce.toString(), gasLimit: gasLimit.toString(), maxFeePerGasNativeAtomic: fees.maxFeePerGas.toString(), maxPriorityFeePerGasNativeAtomic: fees.maxPriorityFeePerGas.toString(), accessList: [], authorizationList: [] });
    const planDigest = transactionPlanDigest(plan);
    finalValidation = FinalValidationReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: o.baselineDigest, policyDigest: pDigest, snapshot: s2, transactionPlan: plan, transactionPlanDigest: planDigest,
      walletEvidenceDigest: keccak256(toHex(`eoa:${runnerAcct.address}:code=0x`)), criticalStateEvidenceDigests: [impl.evidenceDigest, paused.evidenceDigest], simulationEvidenceDigest: sim2.evidenceDigest, balanceNativeAtomic: balance.toString(), reservedGasNativeAtomic: gasReserve.toString(), reservedOtherNativeAtomic: "0",
      feeEvidenceDigest: keccak256(toHex(JSON.stringify({ maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), gasLimit: gasLimit.toString() }))),
      result: fvReasons.length ? "REVIEW_REQUIRED" : "PASS", reasons: fvReasons, validatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + policy.maxFinalValidationAgeSeconds * 1000).toISOString() });
    execution.finalValidationDigest = finalValidationDigest(finalValidation); execution.transactionPlanDigest = planDigest;
    log("finalValidation", { result: finalValidation.result, reasons: fvReasons, newPinnedBlock: s2.blockNumber, balanceNativeAtomic: balance.toString(), gasLimit: gasLimit.toString(), maxFeePerGasGwei: Number(fees.maxFeePerGas) / 1e9, who: "demo-runner", why: "service fee changed the balance and time passed: re-read implementation, paused, order, balance and fees at a NEW pinned block before signing" });
    if (finalValidation.result === "PASS") {
      const raw = await runnerAcct.signTransaction({ chainId: o.chain.id, type: "eip1559", to: merchant, data: intent.data as Hex, value: BigInt(plan.valueNativeAtomic), nonce: Number(plan.nonce), gas: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGasNativeAtomic), accessList: [] });
      const parsed = parseTransaction(raw);
      const mismatch = [parsed.type !== "eip1559" && "type", parsed.chainId !== o.chain.id && "chainId", getAddress(parsed.to!) !== merchant && "to", parsed.data?.toLowerCase() !== intent.data.toLowerCase() && "data", parsed.value !== BigInt(plan.valueNativeAtomic) && "value", parsed.nonce !== Number(plan.nonce) && "nonce", parsed.gas !== BigInt(plan.gasLimit) && "gas", ((parsed as any).authorizationList?.length ?? 0) !== 0 && "authorizationList"].filter(Boolean);
      if (mismatch.length) throw new Error(`signed tx deviates from plan: ${mismatch.join(",")}`);
      if (new Date(finalValidation.expiresAt) < new Date()) throw new Error("final validation expired before broadcast");
      execution.signedTransactionHash = keccak256(raw); execution.chainStatus = "SIGNED_NOT_BROADCAST";
      log("signed", { signedTransactionHash: execution.signedTransactionHash, who: "demo-runner", why: "the signed raw transaction is decoded and compared field by field with the validated plan before any broadcast" });
      const txHash = await o.publicClient.sendRawTransaction({ serializedTransaction: raw });
      execution.businessTxHash = txHash; execution.chainStatus = "PENDING"; execution.businessStatus = "PENDING";
      log("broadcast", { businessTxHash: txHash });
      const rcpt = await o.publicClient.waitForTransactionReceipt({ hash: txHash });
      execution.chainStatus = rcpt.status === "success" ? "CONFIRMED" : "REVERTED";
      const ord = await o.publicClient.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [order.orderId], blockNumber: rcpt.blockNumber });
      const paidOk = rcpt.status === "success" && ord[2] === true && ord[0].toLowerCase() === runnerAcct.address.toLowerCase() && ord[1] === AMOUNT;
      execution.businessStatus = paidOk ? "SUCCESS" : "FAILED";
      postcondition = { orderId: order.orderId, paid: ord[2], payer: ord[0], amountNativeAtomic: ord[1].toString(), block: rcpt.blockNumber.toString(), receiptStatus: rcpt.status };
      execution.postconditionEvidenceDigests = [keccak256(toHex(JSON.stringify(postcondition)))];
      log("postcondition", { ...postcondition, why: "chain receipt success is not business success: the order itself must read as paid, by this payer, for the exact amount" });
    } else { log("notSigned", { why: "final validation did not pass; no business transaction was signed" }); }
  } else { log("notSigned", { decision, why: decision === "BLOCKED" ? "hard violation: the business transaction is never signed or broadcast (the service fee was still a delivered negative result)" : "review required: a human must re-approve the baseline; nothing is signed" }); }
  execution.recordedAt = new Date().toISOString();
  const exec = ExecutionReceipt.parse(execution);
  return bigJson({ fixture: o.fixture, network: o.net, chainId: o.chain.id, attemptId, orderId: order.orderId, merchant, intent, intentDigest: iDigest, policy, policyDigest: pDigest, requestId, serviceFeeTx, report, reportDigest: j.reportDigest, simulation: j.simulation,
    decision: decisionReceipt, decisionDigest: dDigest, finalValidation, plan, execution: exec, executionDigest: executionDigest(exec), postcondition, steps, durationMs: Date.now() - t0 });
}
