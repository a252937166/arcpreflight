// Deterministic policy evaluation (spec v1.4 §5.2): hard violations → BLOCKED; unknowns / unapproved change →
// REVIEW_REQUIRED; otherwise NO_POLICY_VIOLATION ("no configured check fired", not "safe").
import { getAddress } from "viem";
import type { IntentCore, PolicyCore, ReportCore, Decision, BaselineCore } from "@arcpreflight/schema";
import { checkIntentBinding, type CheckResult } from "./intent-binding.js";
import { checkBaselineStatus } from "./baseline-status.js";

export type DecisionInput = {
  intent: IntentCore;
  policy: PolicyCore;
  policyDigest: `0x${string}`;
  baseline: BaselineCore | null;
  baselineDigest: `0x${string}` | null;
  baselineRevoked: boolean;
  report: ReportCore;
  reportDigest: `0x${string}`;
  now: Date;
  simulation?: { ok: boolean; error: string | null } | null;
};

export type DecisionOutput = { decision: Decision; checks: CheckResult[]; reasons: string[] };

const sel = (data: string) => data.slice(0, 10).toLowerCase();

export function decide(i: DecisionInput): DecisionOutput {
  const checks: CheckResult[] = [];
  // 1. INTENT_BINDING + AMOUNT_SEMANTICS
  checks.push(checkIntentBinding(i.intent));
  // 2. Policy allowlists
  const pr: string[] = [];
  if (!i.policy.allowedSenders.some((a) => getAddress(a) === getAddress(i.intent.from))) pr.push("sender not in policy.allowedSenders");
  if (!i.policy.allowedTargets.some((a) => getAddress(a) === getAddress(i.intent.to))) pr.push("target not in policy.allowedTargets");
  if (!i.policy.allowedSelectors.map((s) => s.toLowerCase()).includes(sel(i.intent.data))) pr.push(`selector ${sel(i.intent.data)} not in policy.allowedSelectors`);
  if (BigInt(i.intent.valueNativeAtomic) > BigInt(i.policy.maxNativePaymentAtomic)) pr.push("native value exceeds policy.maxNativePaymentAtomic");
  if (i.intent.walletMode !== "EOA_DIRECT_NON_DELEGATED") pr.push("wallet mode not supported");
  checks.push({ id: "POLICY_ALLOWLISTS", outcome: pr.length ? "BLOCKED" : "PASS", reasons: pr });
  // 3. BASELINE_STATUS
  const baselineStatus = checkBaselineStatus(i);
  if (i.report.baselineDigest !== i.intent.baselineDigest) {
    baselineStatus.reasons.push("report.baselineDigest != intent.baselineDigest");
    baselineStatus.outcome = "REVIEW_REQUIRED";
  }
  checks.push(baselineStatus);
  // 4. EXECUTION_IDENTITY (implementation / code hash vs baseline) — from report.baselineResult
  const er: string[] = [];
  if (i.report.baselineResult === "IMPLEMENTATION_CHANGED") er.push("resolved implementation differs from approved baseline (unapproved change)");
  else if (i.report.baselineResult === "STATE_CHANGED") er.push("approved critical state changed");
  else if (i.report.baselineResult === "ADAPTER_CHANGED") er.push("adapter/template version changed since approval");
  else if (i.report.baselineResult === "NO_BASELINE" || i.report.baselineResult === "UNKNOWN") er.push(`baselineResult=${i.report.baselineResult}`);
  if (!i.report.decisionEligible) er.push("report is not decision-eligible (object observation or unsupported path)");
  checks.push({ id: "EXECUTION_IDENTITY", outcome: er.length ? "REVIEW_REQUIRED" : "PASS", reasons: er });
  // 5. CALL_SIMULATION
  const sr: string[] = [];
  let simOutcome: CheckResult["outcome"] = "PASS";
  if (i.simulation == null) { sr.push("no simulation evidence"); simOutcome = "REVIEW_REQUIRED"; }
  else if (!i.simulation.ok) { sr.push(`simulation reverted: ${i.simulation.error}`); simOutcome = "BLOCKED"; }
  checks.push({ id: "CALL_SIMULATION", outcome: simOutcome, reasons: sr });
  // 6. EVIDENCE_FRESHNESS
  const fr: string[] = [];
  const obsAge = (i.now.getTime() - new Date(i.report.observation.observedAt).getTime()) / 1000;
  if (obsAge > i.policy.maxReportAgeSeconds) fr.push(`report age ${obsAge.toFixed(0)}s > policy.maxReportAgeSeconds ${i.policy.maxReportAgeSeconds}`);
  if (new Date(i.report.expiresAt) < i.now) fr.push("report expired");
  if (new Date(i.intent.expiresAt) < i.now) fr.push("intent expired");
  if (i.report.intentDigest == null) fr.push("report not bound to an intent");
  for (const id of i.policy.requiredSignalIds) {
    const s = i.report.signals.find((x) => x.id === id);
    if (!s) fr.push(`required signal ${id} missing`);
    else if (s.state === "unknown") fr.push(`required signal ${id} is unknown`);
  }
  checks.push({ id: "EVIDENCE_FRESHNESS", outcome: fr.length ? "REVIEW_REQUIRED" : "PASS", reasons: fr });

  const blocked = checks.filter((c) => c.outcome === "BLOCKED");
  const review = checks.filter((c) => c.outcome === "REVIEW_REQUIRED");
  const reasons = checks.flatMap((c) => c.reasons.map((r) => `${c.id}: ${r}`));
  const decision: Decision = blocked.length ? "BLOCKED" : review.length ? "REVIEW_REQUIRED" : "NO_POLICY_VIOLATION";
  return { decision, checks, reasons };
}
