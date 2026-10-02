// The demo runner: one intent -> purchase a preflight (x402) -> local deterministic decision -> final validation ->
// sign & broadcast the SAME call -> verify the order state. Three fixtures: APPROVED_PAYMENT | CHANGED_IMPLEMENTATION | AMOUNT_UNIT_MISMATCH.
// Usage: ARC_NET=testnet API_URL=http://127.0.0.1:4040 RUNNER_TOKEN=... tsx examples/merchant-agent/src/run.ts APPROVED_PAYMENT
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { encodeFunctionData, decodeFunctionResult, keccak256, parseTransaction, getAddress, toHex, type Hex } from "viem";
import { IntentCore, PolicyCore, intentDigest, policyDigest, DecisionReceipt, decisionDigest, TransactionPlan, transactionPlanDigest, FinalValidationReceipt, finalValidationDigest, ExecutionReceipt, executionDigest, ReportCore, reportDigest } from "@arcpreflight/schema";
import { decide, DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization } from "@arcpreflight/client";
import { captureSnapshot, readCall, readSlot, SLOTS, slotToAddress } from "@arcpreflight/observer";
import { net, chain, publicClient, walletFor, account, readDeployments, writeJson, evidenceDir, feeParams } from "../../../scripts/demo/common.js";

const fixture = (process.argv[2] ?? "APPROVED_PAYMENT") as "APPROVED_PAYMENT" | "CHANGED_IMPLEMENTATION" | "AMOUNT_UNIT_MISMATCH";
const API = process.env.API_URL ?? "http://127.0.0.1:4040";
const TOKEN = process.env.RUNNER_TOKEN ?? ""; if (!TOKEN) throw new Error("RUNNER_TOKEN required");
const dep = readDeployments(); if (!dep) throw new Error("no deployments");
const which = fixture === "CHANGED_IMPLEMENTATION" ? "CHANGED" : "MAIN";
const merchant = getAddress(dep.proxies[which].address) as Hex;
const baselineDigestArg = process.env[`BASELINE_DIGEST_${which}`] as Hex | undefined; if (!baselineDigestArg) throw new Error(`BASELINE_DIGEST_${which} required`);
const admin = walletFor("deployer-admin"); const runner = walletFor("demo-runner"); const runnerAcct = account("demo-runner");
const AMOUNT = 50_000_000_000_000_000n; // 0.05 native USDC
const attemptId = randomUUID(); const steps: any[] = []; const t0 = Date.now();
const log = (step: string, data: unknown) => { steps.push({ step, atMs: Date.now() - t0, ...(typeof data === "object" ? data : { data }) }); console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${step}`, typeof data === "string" ? data : JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 300)); };

// 0. Admin creates a fresh order for the runner (management transaction; separate from the business payment)
const orderId = toHex(randomBytes(32)) as Hex;
{ const fees = await feeParams(); const h = await admin.writeContract({ address: merchant, abi: [...DEMO_MERCHANT_ABI, { type: "function", name: "createOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "payer", type: "address" }, { name: "amountNativeAtomic", type: "uint256" }], outputs: [] }], functionName: "createOrder", args: [orderId, runnerAcct.address, AMOUNT], ...fees });
  const r = await publicClient.waitForTransactionReceipt({ hash: h }); log("createOrder", { tx: h, status: r.status, orderId }); if (r.status !== "success") throw new Error("createOrder failed"); }

// 1. Policy (caller-defined, content-addressed) and intent (the exact candidate call)
const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "demo-runner", allowedSenders: [runnerAcct.address], allowedTargets: [merchant], allowedSelectors: [PAY_SELECTOR],
  maxNativePaymentAtomic: AMOUNT.toString(), maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000",
  maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"],
  unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
const pDigest = policyDigest(policy);
const value = fixture === "AMOUNT_UNIT_MISMATCH" ? (AMOUNT / 10n ** 12n).toString() : AMOUNT.toString(); // the bug: 6-dec units on the native path
const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `demo-${fixture}-${attemptId.slice(0, 8)}`, chainId: chain.id, walletMode: "EOA_DIRECT_NON_DELEGATED", from: runnerAcct.address, operation: "CALL",
  to: merchant, data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [orderId] }), valueNativeAtomic: value,
  businessExpectation: { sourceId: `order:${orderId}`, sourceDigest: keccak256(toHex(`order:${orderId}:${runnerAcct.address}:${AMOUNT}`)), action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: AMOUNT.toString(), orderId },
  baselineDigest: baselineDigestArg, policyDigest: pDigest, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
const iDigest = intentDigest(intent); log("intent", { intentDigest: iDigest, value, fixture });

// 2. Quote (402) -> pay with EIP-3009 (service fee, separate from the business payment) -> report
const hdr = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
let r = await fetch(`${API}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent }) });
let j: any = await r.json(); log("quote", { http: r.status, requestId: j.requestId, price: j.quote?.amountTokenAtomic, payTo: j.quote?.payTo, expiresAt: j.quote?.expiresAt });
if (r.status !== 402) throw new Error(`expected 402 quote, got ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
const quote = j.quote; const requestId = j.requestId as string;
if (BigInt(quote.amountTokenAtomic) > BigInt(policy.maxServiceFeeTokenAtomic)) throw new Error("quote exceeds policy.maxServiceFeeTokenAtomic");
const { signature, authorization } = await signTransferAuthorization(runnerAcct, net, { payTo: quote.payTo, valueTokenAtomic: BigInt(quote.amountTokenAtomic) });
r = await fetch(`${API}/v1/preflight`, { method: "POST", headers: hdr, body: JSON.stringify({ intent, payment: { signature, authorization } }) });
j = await r.json(); log("pay+deliver", { http: r.status, delivery: j.delivery, payment: j.payment, reportDigest: j.reportDigest });
let tries = 0;
while (r.status === 202 && tries++ < 20) { await new Promise((s) => setTimeout(s, 1500)); r = await fetch(`${API}/v1/requests/${requestId}`, { headers: hdr }); j = await r.json(); log("recover", { http: r.status, payment: j.payment }); }
if (r.status !== 200 || j.delivery !== "DELIVERED") throw new Error(`report not delivered: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
const report = ReportCore.parse(j.report); if (reportDigest(report) !== j.reportDigest) throw new Error("report digest mismatch (server lied or transport corrupted)");
if (report.intentDigest !== iDigest) throw new Error("report bound to a different intent");
const serviceFeeTx = j.payment?.transaction as string;

// 3. Local deterministic decision (LLM-free): the policy decides, the report only supplies facts
const dec = decide({ intent, policy, policyDigest: pDigest, baseline: null as any, baselineDigest: baselineDigestArg, baselineRevoked: false, report, reportDigest: j.reportDigest, now: new Date(), simulation: j.simulation });
// baseline object is held by the API in this demo; the digest binding is what the runner verifies (report.baselineDigest == intent.baselineDigest)
const baselineBound = report.baselineDigest?.toLowerCase() === baselineDigestArg.toLowerCase();
const checks = dec.checks.filter((c) => c.id !== "BASELINE_STATUS"); const reasons = dec.reasons.filter((x) => !x.startsWith("BASELINE_STATUS"));
if (!baselineBound) reasons.push("BASELINE_STATUS: report.baselineDigest != intent.baselineDigest");
const decision = checks.some((c) => c.outcome === "BLOCKED") ? "BLOCKED" : (checks.some((c) => c.outcome === "REVIEW_REQUIRED") || !baselineBound) ? "REVIEW_REQUIRED" : "NO_POLICY_VIOLATION";
const decisionReceipt = DecisionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, baselineDigest: baselineDigestArg, policyDigest: pDigest, decision, reasons, decidedAt: new Date().toISOString() });
const dDigest = decisionDigest(decisionReceipt); log("decision", { decision, reasons: reasons.slice(0, 6) });

let execution: any = { schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: baselineDigestArg, policyDigest: pDigest,
  finalValidationDigest: null, transactionPlanDigest: null, signedTransactionHash: null, businessTxHash: null, chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", postconditionEvidenceDigests: [], labels: ["LIVE_REQUEST", "DEMO_ON_MAINNET"], recordedAt: new Date().toISOString() };

if (decision === "NO_POLICY_VIOLATION") {
  // 4. Final validation at a NEW pinned block: implementation unchanged, not paused, order payable, balance covers value+gas, fees sane
  const s2 = await captureSnapshot(publicClient as any, { providerId: `rpc.${net}` });
  const impl = await readSlot(publicClient as any, merchant, SLOTS.erc1967Impl, s2);
  const implNow = slotToAddress(impl.value);
  const approvedImpl = report.dependencies.find((d) => d.role === "IMPLEMENTATION")?.address;
  const paused = await readCall(publicClient as any, merchant, encodeFunctionData({ abi: [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "paused" }), s2);
  const sim2 = await readCall(publicClient as any, merchant, intent.data as Hex, s2, intent.from as Hex, BigInt(intent.valueNativeAtomic));
  const balance = await publicClient.getBalance({ address: runnerAcct.address, blockNumber: BigInt(s2.blockNumber) });
  const fees = await feeParams(); const gasLimit = await publicClient.estimateGas({ account: runnerAcct.address, to: merchant, data: intent.data as Hex, value: BigInt(intent.valueNativeAtomic) });
  const gasReserve = gasLimit * fees.maxFeePerGas; const nonce = await publicClient.getTransactionCount({ address: runnerAcct.address, blockTag: "pending" });
  const fvReasons: string[] = [];
  if (!implNow || implNow.toLowerCase() !== approvedImpl?.toLowerCase()) fvReasons.push("implementation changed since report");
  if (!(paused.value.ok && paused.value.data?.endsWith("0"))) fvReasons.push("paused or unreadable");
  if (!sim2.value.ok) fvReasons.push(`re-simulation reverted: ${sim2.value.error}`);
  if (balance < BigInt(intent.valueNativeAtomic) + gasReserve) fvReasons.push("balance < value + gas reserve");
  if (gasReserve > BigInt(policy.maxGasCostNativeAtomic)) fvReasons.push("gas reserve exceeds policy.maxGasCostNativeAtomic");
  const plan = TransactionPlan.parse({ chainId: chain.id, from: runnerAcct.address, type: 2, to: merchant, data: intent.data, valueNativeAtomic: intent.valueNativeAtomic, nonce: nonce.toString(), gasLimit: gasLimit.toString(), maxFeePerGasNativeAtomic: fees.maxFeePerGas.toString(), maxPriorityFeePerGasNativeAtomic: fees.maxPriorityFeePerGas.toString(), accessList: [], authorizationList: [] });
  const planDigest = transactionPlanDigest(plan);
  const fv = FinalValidationReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: iDigest, reportDigest: j.reportDigest, decisionDigest: dDigest, baselineDigest: baselineDigestArg, policyDigest: pDigest, snapshot: s2, transactionPlan: plan, transactionPlanDigest: planDigest,
    walletEvidenceDigest: keccak256(toHex(`eoa:${runnerAcct.address}:code=0x`)), criticalStateEvidenceDigests: [impl.evidenceDigest, paused.evidenceDigest], simulationEvidenceDigest: sim2.evidenceDigest, balanceNativeAtomic: balance.toString(), reservedGasNativeAtomic: gasReserve.toString(), reservedOtherNativeAtomic: "0",
    feeEvidenceDigest: keccak256(toHex(JSON.stringify({ maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), gasLimit: gasLimit.toString() }))),
    result: fvReasons.length ? "REVIEW_REQUIRED" : "PASS", reasons: fvReasons, validatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + policy.maxFinalValidationAgeSeconds * 1000).toISOString() });
  const fvDigest = finalValidationDigest(fv); log("finalValidation", { result: fv.result, reasons: fvReasons, block: s2.blockNumber, gasLimit: gasLimit.toString() });
  execution.finalValidationDigest = fvDigest; execution.transactionPlanDigest = planDigest;
  if (fv.result === "PASS") {
    // 5. Sign the exact plan, decode the raw transaction and compare field by field, then broadcast that raw transaction
    const raw = await runnerAcct.signTransaction({ chainId: chain.id, type: "eip1559", to: merchant, data: intent.data as Hex, value: BigInt(plan.valueNativeAtomic), nonce: Number(plan.nonce), gas: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGasNativeAtomic), accessList: [] });
    const parsed = parseTransaction(raw);
    const mismatch = [parsed.type !== "eip1559" && "type", parsed.chainId !== chain.id && "chainId", getAddress(parsed.to!) !== merchant && "to", parsed.data?.toLowerCase() !== intent.data.toLowerCase() && "data", parsed.value !== BigInt(plan.valueNativeAtomic) && "value", parsed.nonce !== Number(plan.nonce) && "nonce", parsed.gas !== BigInt(plan.gasLimit) && "gas", parsed.maxFeePerGas !== BigInt(plan.maxFeePerGasNativeAtomic) && "maxFee", ((parsed as any).authorizationList?.length ?? 0) !== 0 && "authorizationList"].filter(Boolean);
    if (mismatch.length) throw new Error(`signed tx deviates from plan: ${mismatch.join(",")}`);
    if (new Date(fv.expiresAt) < new Date()) throw new Error("final validation expired before broadcast");
    execution.signedTransactionHash = keccak256(raw); execution.chainStatus = "SIGNED_NOT_BROADCAST";
    writeJson(`${evidenceDir}/private/execution-${attemptId}.pre-broadcast.json`, { attemptId, planDigest, signedTransactionHash: execution.signedTransactionHash }); // raw tx itself is not written to disk
    const txHash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
    execution.businessTxHash = txHash; execution.chainStatus = "PENDING"; execution.businessStatus = "PENDING"; log("broadcast", { txHash });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    execution.chainStatus = rcpt.status === "success" ? "CONFIRMED" : "REVERTED";
    // 6. Business postcondition: order is paid, by the runner, for the exact amount
    const order = await publicClient.readContract({ address: merchant, abi: [{ type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }] }], functionName: "getOrder", args: [orderId], blockNumber: rcpt.blockNumber }) as readonly [Hex, bigint, boolean, bigint, bigint];
    const paidOk = rcpt.status === "success" && order[2] === true && order[0].toLowerCase() === runnerAcct.address.toLowerCase() && order[1] === AMOUNT;
    execution.businessStatus = paidOk ? "SUCCESS" : "FAILED"; execution.postconditionEvidenceDigests = [keccak256(toHex(JSON.stringify({ orderId, paid: order[2], payer: order[0], amount: order[1].toString(), block: rcpt.blockNumber.toString() })))];
    log("postcondition", { status: rcpt.status, orderPaid: order[2], block: rcpt.blockNumber.toString() });
  } else { execution.chainStatus = "NOT_SIGNED"; execution.businessStatus = "NOT_EXECUTED"; }
}
execution.recordedAt = new Date().toISOString();
const exec = ExecutionReceipt.parse(execution); const eDigest = executionDigest(exec);
const out = { fixture, network: net, attemptId, orderId, merchant, intent, intentDigest: iDigest, policy, policyDigest: pDigest, requestId, serviceFeeTx, reportDigest: j.reportDigest, decision: decisionReceipt, decisionDigest: dDigest, execution: exec, executionDigest: eDigest, steps, durationMs: Date.now() - t0 };
writeJson(`${evidenceDir}/runs/${net}-${fixture}-${attemptId}.json`, out);
console.log(`\nRESULT fixture=${fixture} decision=${decision} businessTx=${exec.businessTxHash ?? "none"} businessStatus=${exec.businessStatus} serviceFeeTx=${serviceFeeTx ?? "?"} -> evidence/runs/${net}-${fixture}-${attemptId}.json`);
