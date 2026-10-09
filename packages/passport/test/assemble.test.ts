import { describe, expect, it } from "vitest";
import { assembleRunResultFromArtifacts, buildPassport } from "../src/index.js";
import { syntheticRun } from "./fixture.js";

// The shared assembler (API and reference CLI): the artefacts the runner persists while it runs rebuild the run record a passport needs.
describe("assembleRunResultFromArtifacts", () => {
  const f = syntheticRun("APPROVED"); const r = f.source.result!;
  const artifacts = {
    order: { orderId: r.orderId, tx: r.steps.find((s) => s.step === "createOrder")!.tx, block: "65993420", from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null, signer: "order-creator", reference: null },
    intent: { intent: r.intent, intentDigest: r.intentDigest, policy: r.policy, policyDigest: r.policyDigest },
    quote: { quote: r.quote, quoteDigest: r.quoteDigest, requestId: r.requestId },
    feeAuthorization: r.feeAuthorization,
    report: { report: r.report, reportDigest: r.reportDigest, serviceFeeTx: r.serviceFeeTx, simulation: r.simulation, evidence: f.source.reportEvidence },
    approval: { baseline: f.source.baseline, baselineDigest: f.digests.baseline, revoked: false },
    decision: { decision: r.decision, decisionDigest: r.decisionDigest },
    finalValidation: { finalValidation: r.finalValidation, finalValidationEvidence: r.finalValidationEvidence, plan: r.plan, approvalStatusAtValidation: r.approvalStatusAtValidation, feeReceipt: null },
    execution: r.execution,
    postcondition: { postcondition: r.postcondition, businessReceipt: null },
  };
  it("is null until intent, report, decision and execution exist; then reproduces the run's digests and builds a complete passport", () => {
    expect(assembleRunResultFromArtifacts({ intent: artifacts.intent, report: artifacts.report }, [], { fixture: "APPROVED_PAYMENT", network: "testnet", chainId: 5042002 })).toBeNull();
    const assembled = assembleRunResultFromArtifacts(artifacts, r.steps, { fixture: "APPROVED_PAYMENT", network: "testnet", chainId: 5042002 })!;
    expect(assembled).toMatchObject({ executionMode: "runner", reconstructedFromArtifacts: true, attemptId: r.attemptId, intentDigest: r.intentDigest, reportDigest: r.reportDigest, decisionDigest: r.decisionDigest, executionDigest: r.executionDigest, orderId: r.orderId, serviceFeeTx: r.serviceFeeTx });
    const built = buildPassport({ ...f.source, result: assembled, baseline: artifacts.approval.baseline, reportEvidence: artifacts.report.evidence });
    expect(built.manifest.stageCoverage).toMatchObject({ order: true, intent: true, quote: true, feeSettlement: true, report: true, decision: true, finalValidation: true, transactionPlan: true, signed: true, broadcast: true, postcondition: true });
    expect(built.files["baseline.json"]).toBeDefined();
  });
});
