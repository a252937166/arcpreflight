// Final validation at a fresh block (spec v1.4 §6.4, design v3.2 §9), shared by the project runner and the wallet-execution path
// (design v3.3, docs/LIFECYCLE.md §3). The snapshot must not precede the fee confirmation or the order creation; the referenced
// approval is re-read (validity + revocation) — never "the latest"; the signer account must have no code at that snapshot; the
// exact call is re-simulated; balance, fees, gas and nonce are read; the plan is built from exactly those values.
import { encodeFunctionData, getAddress, keccak256, toHex, type Hex, type PublicClient } from "viem";
import { type IntentCore, type PolicyCore, type ReportCore, type BaselineCore, type FinalValidationReceipt, type TransactionPlan, type Snapshot, FinalValidationReceipt as FinalValidationSchema, TransactionPlan as TransactionPlanSchema, finalValidationDigest, transactionPlanDigest } from "@arcpreflight/schema";
import { checkBaselineStatus } from "@arcpreflight/policy";
import { captureSnapshot, readCall, readSlot, readCode, SLOTS, slotToAddress, PIN_LAG, type RpcEvidence } from "@arcpreflight/observer";
import type { ArcNet } from "@arcpreflight/client";
import { PAUSED_ABI } from "./abi.js";

export type ApprovalLookup = () => Promise<{ baseline: BaselineCore | null; baselineDigest: Hex | null; baselineRevoked: boolean }>;
export type FinalValidationInput = {
  publicClient: PublicClient; net: ArcNet; chainId: number; merchant: Hex;
  intent: IntentCore; report: ReportCore; policy: PolicyCore;
  attemptId: string; intentDigest: Hex; reportDigest: Hex; decisionDigest: Hex; policyDigest: Hex; baselineDigest: Hex;
  /** the approval the intent references, re-read now (validity + revocation); the lookup must refuse any other digest */
  approval: ApprovalLookup;
  /** who will sign: the runner's local key adapter (`requireLocal`) or an external wallet; in both cases the account must be `intent.from` and carry no code */
  signer: { address: Hex; type: string; requireLocal: boolean };
  /** the blocks the snapshot must follow: the service-fee confirmation (null = unknown → refused) and the order creation */
  feeBlock: bigint | null; orderBlock: bigint;
  feeParams: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** validation window; defaults to policy.maxFinalValidationAgeSeconds (the runner signs within seconds; a wallet prompt is human-paced) */
  maxFinalValidationAgeSeconds?: number;
  /** bounded wait until the pinned block can follow `requiredBlock` (default: poll the head up to 40 s) */
  waitForBlock?: (requiredBlock: bigint) => Promise<void>;
  providerId?: string;
};
export type FinalValidationOutput = {
  finalValidation: FinalValidationReceipt; finalValidationDigest: Hex; plan: TransactionPlan; planDigest: Hex;
  evidence: { evidence: RpcEvidence; digest: Hex }[]; approvalStatusAtValidation: { revoked: boolean; validUntil: string | null; fetchedAt: string } | null;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; gasLimit: bigint; nonce: number; snapshot: Snapshot; reasons: string[];
};
const sleep = (ms: number) => new Promise<void>((s) => setTimeout(s, ms));

export async function finalValidate(i: FinalValidationInput): Promise<FinalValidationOutput> {
  const { publicClient, intent, report, policy } = i;
  const merchant = getAddress(i.merchant) as Hex;
  // the final-validation snapshot must not precede the fee confirmation or the order creation: a fresh fetch of an old block is not fresh
  const requiredBlock = i.feeBlock !== null && i.feeBlock > i.orderBlock ? i.feeBlock : i.orderBlock;
  if (i.waitForBlock) await i.waitForBlock(requiredBlock);
  else for (let n = 0; n < 40; n++) { const head = await publicClient.getBlockNumber(); if (head >= requiredBlock + PIN_LAG) break; await sleep(1000); }
  const s2 = await captureSnapshot(publicClient, { providerId: i.providerId ?? `rpc.${i.net}` });
  const impl = await readSlot(publicClient, merchant, SLOTS.erc1967Impl, s2);
  const implNow = slotToAddress(impl.value);
  const approvedImpl = report.dependencies.find((d) => d.role === "IMPLEMENTATION")?.address;
  const paused = await readCall(publicClient, merchant, encodeFunctionData({ abi: PAUSED_ABI, functionName: "paused" }), s2);
  const sim2 = await readCall(publicClient, merchant, intent.data as Hex, s2, intent.from as Hex, BigInt(intent.valueNativeAtomic));
  const evidence: FinalValidationOutput["evidence"] = [{ evidence: impl.evidence, digest: impl.evidenceDigest }, { evidence: paused.evidence, digest: paused.evidenceDigest }, { evidence: sim2.evidence, digest: sim2.evidenceDigest }];
  const balance = await publicClient.getBalance({ address: i.signer.address, blockNumber: BigInt(s2.blockNumber) });
  const fees = await i.feeParams();
  const gasLimit = await publicClient.estimateGas({ account: i.signer.address, to: merchant, data: intent.data as Hex, value: BigInt(intent.valueNativeAtomic) });
  const gasReserve = gasLimit * fees.maxFeePerGas;
  const nonce = await publicClient.getTransactionCount({ address: i.signer.address, blockTag: "pending" });
  const reasons: string[] = [];
  if (i.feeBlock === null) reasons.push("service-fee confirmation block unknown; the final-validation snapshot cannot be ordered after the fee");
  else if (BigInt(s2.blockNumber) < requiredBlock) reasons.push(`final-validation snapshot #${s2.blockNumber} predates the service-fee confirmation (#${i.feeBlock}) or the order creation (#${i.orderBlock})`);
  // signer account path (spec §6.4): the account that will sign, with NO code at the validation snapshot; inconclusive reads stop the run
  let walletEvidenceDigest: Hex = keccak256(toHex(`signer:${i.signer.address}:code=INCONCLUSIVE`));
  if (i.signer.requireLocal && i.signer.type !== "local") reasons.push("signer is not a local key adapter");
  if (getAddress(i.signer.address) !== getAddress(intent.from)) reasons.push("signer address != intent.from");
  try {
    const code = await readCode(publicClient, i.signer.address, s2);
    walletEvidenceDigest = code.evidenceDigest; evidence.push({ evidence: code.evidence, digest: code.evidenceDigest });
    if (code.value.code !== null) reasons.push(`signer account has code at #${s2.blockNumber} (delegated or contract account); only a non-delegated EOA is supported`);
  } catch (e: any) { reasons.push(`signer account state inconclusive (eth_getCode failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)})`); }
  // the approval referenced by the intent, re-read now (validity + revocation); never the latest approval
  const finalApproval = await i.approval();
  const approvalStatusAtValidation = finalApproval.baselineDigest ? { revoked: finalApproval.baselineRevoked, validUntil: finalApproval.baseline?.validUntil ?? null, fetchedAt: new Date().toISOString() } : null;
  reasons.push(...checkBaselineStatus({ intent, ...finalApproval, now: new Date() }).reasons.map((reason) => `BASELINE_STATUS: ${reason}`));
  if (new Date(intent.expiresAt) <= new Date()) reasons.push("intent expired before final validation");
  if (new Date(report.expiresAt) <= new Date()) reasons.push("report expired before final validation");
  if (s2.chainId !== intent.chainId) reasons.push("final validation chain != intent chain");
  if (!implNow || implNow.toLowerCase() !== approvedImpl?.toLowerCase()) reasons.push("implementation changed since report");
  if (!(paused.value.ok && BigInt(paused.value.data ?? "0x1") === 0n)) reasons.push("paused or unreadable");
  if (!sim2.value.ok) reasons.push(sim2.value.unavailable ? `re-simulation unavailable (the RPC could not run the call; not a revert): ${sim2.value.error}` : `re-simulation reverted: ${sim2.value.error}`);
  if (balance < BigInt(intent.valueNativeAtomic) + gasReserve) reasons.push("balance < value + gas reserve");
  if (gasReserve > BigInt(policy.maxGasCostNativeAtomic)) reasons.push("gas reserve exceeds policy.maxGasCostNativeAtomic");
  // the validation window counts from the pinned observation, not from the end of the reads: a slow validation cannot buy itself time
  const ageSeconds = i.maxFinalValidationAgeSeconds ?? policy.maxFinalValidationAgeSeconds;
  const observedAtMs = Date.parse(s2.observedAt);
  if (Date.now() - observedAtMs > ageSeconds * 1000) reasons.push(`final validation exceeded its own window: snapshot observed at ${s2.observedAt}, ${Math.round((Date.now() - observedAtMs) / 1000)} s ago, window ${ageSeconds} s`);
  // audit 2026-10-10 (VF-05): the buyer's report-age policy is re-checked AFTER the awaited work (fee receipt, block wait, reads) — a report
  // that was fresh at the decision can age out during a slow validation; and the receipt's expiry never outlives that deadline
  const reportObservedMs = Date.parse(report.observation.observedAt);
  const reportDeadlineMs = reportObservedMs + policy.maxReportAgeSeconds * 1000;
  if (Date.now() > reportDeadlineMs) reasons.push(`report aged past policy.maxReportAgeSeconds (${policy.maxReportAgeSeconds} s) during validation: observed at ${report.observation.observedAt}, ${Math.round((Date.now() - reportObservedMs) / 1000)} s ago`);
  const plan = TransactionPlanSchema.parse({ chainId: i.chainId, from: i.signer.address, type: 2, to: merchant, data: intent.data, valueNativeAtomic: intent.valueNativeAtomic, nonce: nonce.toString(), gasLimit: gasLimit.toString(), maxFeePerGasNativeAtomic: fees.maxFeePerGas.toString(), maxPriorityFeePerGasNativeAtomic: fees.maxPriorityFeePerGas.toString(), accessList: [], authorizationList: [] });
  const planDigest = transactionPlanDigest(plan);
  const finalValidation = FinalValidationSchema.parse({ schemaVersion: "1.0", executionAttemptId: i.attemptId, intentDigest: i.intentDigest, reportDigest: i.reportDigest, decisionDigest: i.decisionDigest, baselineDigest: i.baselineDigest, policyDigest: i.policyDigest, snapshot: s2, transactionPlan: plan, transactionPlanDigest: planDigest,
    walletEvidenceDigest, criticalStateEvidenceDigests: [impl.evidenceDigest, paused.evidenceDigest], simulationEvidenceDigest: sim2.evidenceDigest, balanceNativeAtomic: balance.toString(), reservedGasNativeAtomic: gasReserve.toString(), reservedOtherNativeAtomic: "0",
    feeEvidenceDigest: keccak256(toHex(JSON.stringify({ maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), gasLimit: gasLimit.toString() }))),
    result: reasons.length ? "REVIEW_REQUIRED" : "PASS", reasons, validatedAt: new Date().toISOString(),
    expiresAt: new Date(Math.min(observedAtMs + ageSeconds * 1000, reportDeadlineMs, Date.parse(intent.expiresAt), Date.parse(report.expiresAt), finalApproval.baseline?.validUntil ? Date.parse(finalApproval.baseline.validUntil) : Infinity)).toISOString() });
  return { finalValidation, finalValidationDigest: finalValidationDigest(finalValidation), plan, planDigest, evidence, approvalStatusAtValidation, fees, gasLimit, nonce, snapshot: s2, reasons };
}
