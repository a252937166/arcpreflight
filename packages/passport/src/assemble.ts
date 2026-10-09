// A complete run record rebuilt from the artefacts the runner persisted while it ran (design v3.3 §4; review round 3 for the CLI):
// what `runFixture` would have returned had the process not stopped. Null until intent, report, decision and an execution receipt
// exist. Shared by the API service and the reference CLI, so both export the same passport from the same evidence.
import { ExecutionReceipt, executionDigest } from "@arcpreflight/schema";
import type { RunResultLike, Step } from "./types.js";

export type AssembleMeta = { fixture: string; network: string; chainId: number; orderId?: string | null; merchant?: string | null };
export function assembleRunResultFromArtifacts(a: Record<string, any>, steps: Step[], x: AssembleMeta): (RunResultLike & { executionMode: "runner"; reconstructedFromArtifacts: true }) | null {
  if (!a?.intent?.intent || !a?.report?.report || !a?.decision?.decision || !a?.execution) return null;
  let execution: ExecutionReceipt; try { execution = ExecutionReceipt.parse(a.execution); } catch { return null; }
  const last = steps.length ? Math.max(...steps.map((s) => (typeof s.atMs === "number" && s.atMs >= 0 ? s.atMs : 0))) : 0;
  return { executionMode: "runner", fixture: x.fixture, network: x.network, chainId: x.chainId, attemptId: execution.executionAttemptId, orderId: a.order?.orderId ?? x.orderId ?? a.intent.intent.businessExpectation?.orderId ?? null, merchant: x.merchant ?? a.order?.merchant ?? a.intent.intent.to,
    intent: a.intent.intent, intentDigest: a.intent.intentDigest, policy: a.intent.policy, policyDigest: a.intent.policyDigest, requestId: a.quote?.requestId ?? null, serviceFeeTx: a.report.serviceFeeTx ?? null,
    report: a.report.report, reportDigest: a.report.reportDigest, simulation: a.report.simulation ?? null, decision: a.decision.decision, decisionDigest: a.decision.decisionDigest,
    finalValidation: a.finalValidation?.finalValidation ?? null, plan: a.finalValidation?.plan ?? null, execution, executionDigest: executionDigest(execution), postcondition: a.postcondition?.postcondition ?? null, steps, durationMs: last,
    quote: a.quote?.quote ?? null, quoteDigest: a.quote?.quoteDigest ?? null, feeAuthorization: a.feeAuthorization ?? null,
    orderCreation: a.order ? { tx: a.order.tx, block: a.order.block, from: a.order.from ?? null, gasUsed: a.order.gasUsed ?? null, effectiveGasPriceNativeAtomic: a.order.effectiveGasPriceNativeAtomic ?? null, signer: a.order.signer ?? "order creator", reference: a.order.reference ?? null } : null,
    feeReceipt: a.finalValidation?.feeReceipt ?? null, businessReceipt: a.postcondition?.businessReceipt ?? null, finalValidationEvidence: a.finalValidation?.finalValidationEvidence ?? [], approvalStatusAtValidation: a.finalValidation?.approvalStatusAtValidation ?? null,
    reconstructedFromArtifacts: true } as any;
}
