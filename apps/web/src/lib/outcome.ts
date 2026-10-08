// The headline of a run follows `run.outcome` (the execution store, docs/LIFECYCLE.md §8, AP33-06): a run whose last step is
// `signed` but whose store says BROADCAST_ATTEMPTED reads "a broadcast was attempted", never "nothing sent". Runs recorded before
// v3.3 carry no `outcome` and fall back to the receipt-based mapping the caller supplies. Also here: the 7-stage lifecycle of a run.
import type { OutcomeKind, Run } from "./api";
import type { Tone } from "./format";

export type Headline = { text: string; decision: string | null; tone: Tone; message: string; source: "store" | "decision" | "state" | "legacy" };
const KINDS: Record<OutcomeKind, { text: string; decision: string | null; tone: Tone; message: string }> = {
  RUNNING: { text: "RUNNING", decision: null, tone: "info", message: "Run in progress." },
  PAID: { text: "CONFIRMED", decision: "CONFIRMED", tone: "ok", message: "Order payment confirmed." },
  BROADCAST_UNRESOLVED: { text: "BROADCAST ATTEMPTED · OUTCOME NOT ESTABLISHED", decision: "PENDING", tone: "warn", message: "A broadcast was attempted; the outcome is not yet established. Reconciliation works from the recorded hash and the order state." },
  SIGNED_NOT_BROADCAST: { text: "NOT SENT", decision: "FAILED", tone: "warn", message: "Signed but never broadcast: nothing reached the network; the order stays unpaid." },
  NOT_MINED: { text: "NOT MINED", decision: "FAILED", tone: "warn", message: "The original hash can never be mined (its nonce was consumed by something else); the order reads as unpaid; nothing was re-signed." },
  SUPERSEDED: { text: "SUPERSEDED", decision: "PENDING", tone: "warn", message: "The order was paid by a same-nonce replacement; nothing was re-signed by this runner." },
  REVERTED: { text: "REVERTED", decision: "FAILED", tone: "bad", message: "The transaction reverted; the order stays unpaid." },
  CONFIRMED_UNPAID: { text: "CONFIRMED · ORDER UNPAID", decision: "FAILED", tone: "bad", message: "The transaction confirmed but the order does not read as paid for this payer and amount." },
  REVIEW_REQUIRED: { text: "REVIEW REQUIRED", decision: "REVIEW_REQUIRED", tone: "warn", message: "This payment is outside the referenced approval." },
  BLOCKED: { text: "BLOCKED", decision: "BLOCKED", tone: "bad", message: "This payment is outside the referenced approval." },
  NOT_SIGNED: { text: "NOT SIGNED", decision: "FAILED", tone: "warn", message: "No business transaction was signed." },
  FAILED: { text: "RUN FAILED", decision: "FAILED", tone: "bad", message: "The run stopped before any business transaction was signed; nothing reached the network." },
};
/** `run.outcome` → the badge word, the decision badge key, the tone and the one-sentence message; `null` when the run carries no outcome */
export function outcomeHeadline(run: Pick<Run, "outcome">): Headline | null {
  const o = run.outcome; if (!o || !(o.kind in KINDS)) return null;
  const k = KINDS[o.kind];
  return { ...k, source: o.source };
}

// ---- the lifecycle (7 stages) of a run
export type LifecycleId = "order" | "approve" | "check" | "execute" | "recover" | "passport" | "verify";
export type StageStatus = "todo" | "active" | "done" | "stop" | "review" | "skipped" | "warn";
export type LifecycleStage = { id: LifecycleId; label: string; status: StageStatus; note?: string | null };
export const LIFECYCLE_LABELS: Record<LifecycleId, string> = { order: "create order", approve: "review & approve", check: "preflight check", execute: "execute payment", recover: "recover", passport: "export passport", verify: "verify independently" };
export const LIFECYCLE_ORDER: LifecycleId[] = ["order", "approve", "check", "execute", "recover", "passport", "verify"];
export const idleLifecycle = (): LifecycleStage[] => LIFECYCLE_ORDER.map((id) => ({ id, label: LIFECYCLE_LABELS[id], status: "todo" }));
export const stageDone = (stages: LifecycleStage[], id: LifecycleId) => stages.find((s) => s.id === id)?.status === "done";

/** what this browser did with the passport: `verified` is the verification STATE (docs/LIFECYCLE.md §9): only "passed" earns the check mark;
 *  "failed" is a stop, "partial" a warning. A plain `true` (older callers) counts as passed. */
export type LocalPassport = { exported?: boolean; verified?: boolean | "passed" | "failed" | "partial" | null };
export const verifyStage = (v: LocalPassport["verified"]): { status: StageStatus; note: string | null } => (v === true || v === "passed" ? { status: "done", note: "verified in this browser: passed" } : v === "failed" ? { status: "stop", note: "verification FAILED in this browser" } : v === "partial" ? { status: "warn", note: "partially verified (unverified findings)" } : { status: "todo", note: null });
/** A runner run's lifecycle from its steps, outcome and state (plus what this browser did with the passport). */
export function lifecycleFromRun(run: Run, local: LocalPassport = {}): LifecycleStage[] {
  const seen = new Set(run.steps.map((s) => s.step));
  const running = run.state === "RUNNING";
  const decision = run.result?.decision?.decision ?? (run.steps.find((s) => s.step === "decision")?.decision as string | undefined) ?? null;
  const kind = run.outcome?.kind ?? null;
  const be = run.businessExecution ?? null;
  const st = (id: LifecycleId, status: StageStatus, note?: string | null): LifecycleStage => ({ id, label: LIFECYCLE_LABELS[id], status, note: note ?? null });
  const order = seen.has("createOrder") || !!run.order?.tx ? st("order", "done", run.order?.reference ? `“${run.order.reference}”` : null) : st("order", seen.has("orderPlanned") ? "active" : running ? "active" : "todo", seen.has("orderPlanned") ? "identity recorded, creation pending" : null);
  const approve = seen.has("intent") ? st("approve", "done", "approval referenced by the intent") : st("approve", order.status === "done" && running ? "active" : "todo");
  let check: LifecycleStage;
  if (seen.has("decision")) check = st("check", decision === "BLOCKED" ? "stop" : decision === "REVIEW_REQUIRED" ? "review" : "done", decision ? decision.replace(/_/g, " ").toLowerCase() : null);
  else check = st("check", approve.status === "done" && running ? "active" : seen.has("error") ? "stop" : "todo", seen.has("reportDelivered") ? "report delivered" : seen.has("signServiceFee") ? "fee signed" : null);
  const stopped = check.status === "stop" || check.status === "review";
  let execute: LifecycleStage;
  if (stopped) execute = st("execute", "skipped", "nothing signed");
  else if (kind === "PAID") execute = st("execute", "done", "paid");
  else if (kind === "BROADCAST_UNRESOLVED" || be?.state === "BROADCAST_ATTEMPTED") execute = st("execute", "warn", "broadcast attempted");
  else if (kind === "REVERTED" || kind === "CONFIRMED_UNPAID") execute = st("execute", "stop", kind.toLowerCase().replace(/_/g, " "));
  else if (kind === "NOT_MINED" || kind === "SIGNED_NOT_BROADCAST" || kind === "NOT_SIGNED" || kind === "SUPERSEDED") execute = st("execute", "warn", kind.toLowerCase().replace(/_/g, " "));
  else if (seen.has("broadcast") || seen.has("signed") || seen.has("finalValidation")) execute = st("execute", running ? "active" : "warn", seen.has("broadcast") ? "broadcast" : seen.has("signed") ? "signed" : "final validation");
  else if (kind === "FAILED" || run.state === "FAILED") execute = st("execute", "stop", "run failed");
  else execute = st("execute", check.status === "done" && running ? "active" : "todo");
  const interrupted = seen.has("interruptedAfterBroadcast") || seen.has("outcomeUnknown") || seen.has("interruptedBeforeBroadcast") || seen.has("interrupted");
  let recover: LifecycleStage;
  if (run.state === "RECONCILE_REQUIRED") recover = st("recover", "active", "reconciliation pending");
  else if (seen.has("reconciled")) recover = st("recover", "done", seen.has("interruptedAfterBroadcast") ? "reconciled after a simulated interruption" : "reconciled");
  else if (interrupted) recover = st("recover", "warn", "interrupted; not yet reconciled");
  else recover = st("recover", stopped || running ? "skipped" : "skipped", stopped ? "not needed" : "not needed: no interruption");
  const finished = !running && run.state !== "RECONCILE_REQUIRED";
  const passport = st("passport", local.exported ? "done" : finished ? "todo" : "todo", local.exported ? "downloaded" : finished ? "ready to export" : null);
  const v = verifyStage(local.verified);
  const verify = st("verify", v.status, v.note ?? (finished ? "after the export" : null));
  return [order, approve, check, execute, recover, passport, verify];
}
