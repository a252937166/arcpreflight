// The guided walkthrough of a Live Demo run (review of 2026-10-09, items 2–5): everything here is derived from the RECORDED run —
// its state, its steps and its outcome from the execution store — never from preset copy. `phaseOf` names the moment (waiting,
// checking, broadcasting, recovering, confirmed, stopped, failed); `guideFor` says what just happened, what to do next and which
// result to inspect, as a checklist the visitor walks: order → check → payment → explorer → passport → verify.
import { explorerTx, type NetworkInfo, type Run } from "./api";
import type { LocalPassport } from "./outcome";
import type { Tone } from "./format";

export type Phase = "idle" | "waiting" | "checking" | "broadcasting" | "recovering" | "confirmed" | "stopped" | "failed";
export const PHASES: Record<Phase, { label: string; tone: Tone; live: boolean; detail: string }> = {
  idle: { label: "ready", tone: "neutral", live: false, detail: "nothing is running" },
  waiting: { label: "waiting", tone: "info", live: true, detail: "admitted; waiting for the next recorded step" },
  checking: { label: "checking", tone: "info", live: true, detail: "order, pinned report, decision, final validation" },
  broadcasting: { label: "broadcasting", tone: "warn", live: true, detail: "signed and sent; waiting for the receipt" },
  recovering: { label: "recovering", tone: "warn", live: true, detail: "the outcome is read from the original hash and the order state" },
  confirmed: { label: "confirmed", tone: "ok", live: false, detail: "the order reads as paid" },
  stopped: { label: "stopped by the check", tone: "warn", live: false, detail: "nothing was signed" },
  failed: { label: "failed", tone: "bad", live: false, detail: "no payment was established" },
};
const has = (run: Run, ...steps: string[]) => run.steps.some((s) => steps.includes(s.step));
const decisionOf = (run: Run): string | null => run.result?.decision?.decision ?? (run.steps.find((s) => s.step === "decision")?.decision as string | undefined) ?? null;
const EXECUTED_KINDS = new Set(["PAID", "BROADCAST_UNRESOLVED", "NOT_MINED", "SUPERSEDED", "REVERTED", "CONFIRMED_UNPAID"]);

/** the moment a run is in, from its state, steps and store-derived outcome */
export function phaseOf(run: Run | null | undefined): Phase {
  if (!run) return "idle";
  if (run.state === "RECONCILE_REQUIRED") return "recovering";
  if (run.state === "RUNNING") {
    if (run.steps.at(-1)?.step === "settlementPending") return "waiting";
    if (has(run, "signed", "broadcastAttempted", "broadcast", "interruptedAfterBroadcast", "outcomeUnknown")) return "broadcasting";
    if (has(run, "orderPlanned", "createOrder", "intent", "quote", "signServiceFee", "reportDelivered", "decision", "finalValidation")) return "checking";
    return "waiting";
  }
  const kind = run.outcome?.kind ?? null;
  if (kind === "PAID" || kind === "SUPERSEDED") return "confirmed";
  if (kind === "BROADCAST_UNRESOLVED") return "recovering";
  if (kind === "REVIEW_REQUIRED" || kind === "BLOCKED") return "stopped";
  if (kind) return "failed";
  // runs recorded before v3.3 carry no outcome: the decision and the receipts decide
  const d = decisionOf(run);
  if (d === "BLOCKED" || d === "REVIEW_REQUIRED") return "stopped";
  const ex = run.result?.execution;
  if (ex?.businessStatus === "SUCCESS") return "confirmed";
  if (ex && (ex.chainStatus === "UNKNOWN" || ex.chainStatus === "PENDING") && ex.businessStatus !== "NOT_EXECUTED") return "recovering";
  return "failed";
}

const HAPPENED: Record<string, string> = {
  orderPlanned: "Order identity recorded before its creation was sent", createOrder: "Order created on the DemoMerchant", intent: "Exact intent built against the order",
  quote: "Report quoted over HTTP 402", staleObservation: "Pinned block predates the order — quoting again", signServiceFee: "Check fee signed (one EIP-3009 authorization)",
  settlementPending: "Check fee settlement pending on Arc", reportDelivered: "Pinned report delivered after the fee settled", finalValidation: "Final validation at a fresh pinned block",
  signed: "Transaction signed and compared with the plan, field by field", broadcastAttempted: "Durable broadcast marker written", broadcast: "Transaction broadcast to Arc",
  interruptedAfterBroadcast: "Runner stopped waiting right after the send — simulated interruption", outcomeUnknown: "No receipt within the wait; the outcome is not established",
  notSigned: "Nothing was signed", notBroadcast: "Signed but not sent: the validation window closed", intentRetried: "Re-requested under a new client request id",
  rebroadcast: "Identical signed bytes re-broadcast inside the window", interrupted: "Process interrupted before any business signature", interruptedBeforeBroadcast: "Process interrupted after signing, before any broadcast",
  error: "The run hit an error", readyToExecute: "Check decided — execution continues in the Developer workflow",
};
const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").toLowerCase();
/** one short sentence for the last recorded step */
export function happenedOf(run: Run | null | undefined): string {
  if (!run) return "Pick a situation. The project runner pays from project funds; your wallet is not charged.";
  const last = run.steps.at(-1);
  if (!last) return run.state === "RUNNING" ? "Run admitted; the first step is being recorded" : "No steps were recorded";
  if (last.step === "decision") return `Decision: ${words(String(last.decision ?? decisionOf(run) ?? ""))}`;
  if (last.step === "postcondition") return `Order read back from the chain: ${last.paid === true ? "paid" : "not paid"}`;
  if (last.step === "reconciled") return `Recovered from the original hash and the order state: ${words(String(last.chainStatus ?? ""))} / ${words(String(last.businessStatus ?? ""))}`;
  return HAPPENED[last.step] ?? `Step ${last.step}`;
}

export type CheckpointId = "order" | "check" | "payment" | "explorer" | "passport" | "verify";
export type CheckpointStatus = "todo" | "current" | "done" | "na" | "pending";
export type Checkpoint = { id: CheckpointId; label: string; action: string; hint: string; status: CheckpointStatus; target: string; external?: boolean };
const DEF: Record<CheckpointId, { label: string; action: string; hint: string; target: string }> = {
  order: { label: "order", action: "Inspect the created order", hint: "id, creation transaction, payer and amount — from the records", target: "sec-order" },
  check: { label: "check", action: "Review the check result", hint: "the decision, its reasons and the pinned report", target: "sec-check" },
  payment: { label: "payment", action: "Inspect the payment outcome", hint: "the execution state from the store and the order read back as paid or not", target: "sec-payment" },
  explorer: { label: "explorer", action: "Open the transaction in the explorer", hint: "the business transaction as Arc's explorer shows it", target: "sec-payment" },
  passport: { label: "passport", action: "Download the Payment Passport", hint: "every receipt, the cost statement and the evidence, as files you keep", target: "btn-passport" },
  verify: { label: "verify", action: "Verify the passport here", hint: "the verifier recomputes the digests and reads the chain — findings, never a bare PASS", target: "sec-verify" },
};
export type GuideLocal = LocalPassport & { visited?: Iterable<CheckpointId> };
export type Guide = {
  phase: Phase; happened: string; inspect: string | null; blocked: string | null;
  next: { label: string; target: string; external?: boolean; route?: boolean; hint: string | null; checkpoint: CheckpointId | null };
  checkpoints: Checkpoint[];
  interrupted: { hash: string | null; status: "pending" | "recovering" | "resolved" } | null;
};
const businessHash = (run: Run): string | null => run.businessExecution?.txHash ?? run.result?.execution?.businessTxHash ?? run.result?.execution?.signedTransactionHash ?? null;
const shortReason = (r: string) => (r.length > 140 ? `${r.slice(0, 137)}…` : r);

/** the walkthrough for THIS run, right now */
export function guideFor(run: Run | null | undefined, net: NetworkInfo | null, local: GuideLocal = {}): Guide {
  const phase = phaseOf(run);
  const visited = new Set<CheckpointId>(local.visited ?? []);
  const live = !!run && (run.state === "RUNNING" || run.state === "RECONCILE_REQUIRED");
  const finished = !!run && !live;
  const hash = run ? businessHash(run) : null;
  const executed = !!run && (EXECUTED_KINDS.has(run.outcome?.kind ?? "") || !!run.businessExecution || !!run.result?.execution?.businessTxHash || !!run.result?.execution?.signedTransactionHash);
  const d = run ? decisionOf(run) : null;
  const mk = (id: CheckpointId, status: CheckpointStatus, over: Partial<Checkpoint> = {}): Checkpoint => ({ id, ...DEF[id], status, ...over });
  const cps: Checkpoint[] = [];
  if (!run) { for (const id of Object.keys(DEF) as CheckpointId[]) cps.push(mk(id, "todo")); }
  else {
    const hasOrder = !!run.order || has(run, "createOrder");
    cps.push(mk("order", hasOrder ? (visited.has("order") ? "done" : "todo") : finished ? "na" : "pending", hasOrder ? {} : { hint: finished ? "no order was created" : "the order is being created" }));
    const decided = !!d || has(run, "decision");
    cps.push(mk("check", decided ? (visited.has("check") ? "done" : "todo") : finished ? "na" : "pending", decided ? {} : { hint: finished ? "no decision was recorded" : "the report is being bought and read" }));
    const stopped = phase === "stopped";
    cps.push(mk("payment", stopped ? "na" : !finished ? "pending" : executed ? (visited.has("payment") ? "done" : "todo") : "na",
      stopped ? { hint: "nothing was signed: the check stopped the payment" } : !finished ? { hint: phase === "recovering" ? "being established by recovery" : "being executed" } : executed ? {} : { hint: "no business transaction was signed" }));
    cps.push(mk("explorer", hash && finished ? (visited.has("explorer") ? "done" : "todo") : hash ? "pending" : "na", hash ? { target: explorerTx(net, hash), external: true } : { hint: "no business transaction to open" }));
    cps.push(mk("passport", !finished ? "pending" : local.exported ? "done" : "todo", !finished ? { hint: "available once the run has ended" } : {}));
    const v = local.verified;
    cps.push(mk("verify", !local.exported ? "pending" : v === true || v === "passed" ? "done" : "todo", !local.exported ? { hint: "after the download" } : v === "failed" ? { hint: "verification failed — read the findings" } : v === "partial" ? { hint: "some findings could not be verified — read them" } : {}));
  }
  const current = cps.find((c) => c.status === "todo") ?? null;
  if (current) current.status = "current";
  const reasons = (run?.result?.decision?.reasons ?? (run?.steps.find((s) => s.step === "decision")?.reasons as string[] | undefined) ?? []) as string[];
  const blocked = phase === "stopped" ? `The check stopped the payment: ${reasons.length ? shortReason(reasons[0]) : words(d) || "see the finding"}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}` : null;
  let next: Guide["next"];
  if (!run) next = { label: "Run the project-funded demo", target: "run-start", hint: "real Arc testnet transactions, paid by the project", checkpoint: null };
  else if (phase === "recovering") next = { label: "Recover this attempt", target: "sec-recovery", hint: "or wait: the recovery worker runs every 30 s, and reading this run observes too", checkpoint: null };
  else if (current) next = { label: current.action, target: current.target, external: current.external, hint: live ? "the run continues meanwhile" : null, checkpoint: current.id };
  else if (live) next = { label: "Watch the steps", target: "sec-steps", hint: "no action needed — every step is recorded as it happens", checkpoint: null };
  else next = { label: "Try it with your wallet", target: "/developer", route: true, hint: "the same seven steps; your wallet pays on Arc testnet", checkpoint: null };
  const inspect = current ? current.hint : phase === "recovering" ? "the original transaction hash and the order state, in the recovery desk" : live ? PHASES[phase].detail : null;
  const interrupted = run && has(run, "interruptedAfterBroadcast") ? { hash, status: (run.state === "RECONCILE_REQUIRED" ? "recovering" : has(run, "reconciled") || phase === "confirmed" ? "resolved" : "pending") as "pending" | "recovering" | "resolved" } : null;
  return { phase, happened: happenedOf(run), inspect, blocked, next, checkpoints: cps, interrupted };
}
