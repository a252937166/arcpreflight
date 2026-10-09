import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { Chip, DecisionBadge, Hex, Labels, Spinner } from "./Badges";
import { Pipeline } from "./Pipeline";
import { StepLog } from "./StepLog";
import { ReportView } from "./Report";
import { Typewriter, narrate } from "./Typewriter";
import { FlowCanvas } from "./FlowCanvas";
import { RecoveryStrip, type RecoveryMoment } from "./RecoveryStrip";
import { CostTable } from "./CostTable";
import { VerifyInBrowser } from "./VerifyInBrowser";
import { api, explorerAddr, explorerTx, type NetworkInfo, type PassportBundle, type Run, type RunResult } from "../lib/api";
import { describeError } from "../lib/errors";
import { runKeyFor } from "../lib/runKeys";
import { saveJson } from "../lib/download";
import { lifecycleFromRun, outcomeHeadline, type LifecycleId } from "../lib/outcome";
import { ago, ms, usdc6, usdcNative, usdcToken6, utc, type Tone } from "../lib/format";

const FIXTURE_TITLES: Record<string, string> = { APPROVED_PAYMENT: "approved payment", CHANGED_IMPLEMENTATION: "unapproved implementation change", AMOUNT_UNIT_MISMATCH: "6-dec amount on the 18-dec path" };
const decisionOf = (run: Run) => run.result?.decision?.decision ?? (run.steps.find((s) => s.step === "decision")?.decision as string | undefined) ?? null;
const errText = (e: any) => describeError(e).text;

/** The short outcome word for the badge. Runs recorded before v3.3 (no `outcome`) are mapped from their receipts here; newer runs use `outcomeHeadline`. */
export function headlineOf(run: Run): { text: string; decision: string | null } {
  const o = outcomeHeadline(run);
  if (o) return { text: o.text, decision: o.decision === "PENDING" ? null : o.decision };
  const d = decisionOf(run); const ex = run.result?.execution;
  if (run.state === "FAILED") return { text: ex?.chainStatus === "SIGNED_NOT_BROADCAST" ? "NOT SENT" : "RUN FAILED", decision: "FAILED" };
  if (run.state === "RECONCILE_REQUIRED" || (ex?.chainStatus === "UNKNOWN" && ex?.businessStatus === "UNKNOWN")) return { text: "OUTCOME PENDING RECONCILIATION", decision: null };
  if (!d) return { text: "RUNNING", decision: null };
  if (d === "NO_POLICY_VIOLATION") {
    const bs = ex?.businessStatus, cs = ex?.chainStatus;
    if (bs === "SUCCESS") return { text: "CONFIRMED", decision: "CONFIRMED" };
    if (cs === "REVERTED") return { text: "REVERTED", decision: "FAILED" };
    if (bs === "FAILED") return { text: "EXECUTION FAILED", decision: "FAILED" };
    if (cs === "UNKNOWN" && bs === "NOT_EXECUTED") return { text: "NOT MINED", decision: "FAILED" };
    return { text: "NO POLICY VIOLATION", decision: d };
  }
  return { text: d.replace(/_/g, " "), decision: d };
}

/** The primary user message (design §7): one sentence keyed on the RECORDED state — the execution store first (AP33-06), never preset success copy. */
export function messageOf(run: Run): { text: string; tone: Tone } {
  const o = outcomeHeadline(run);
  if (o && !(o.source === "state" && run.state === "RUNNING")) return { text: o.message, tone: o.tone };
  const ex = run.result?.execution; const d = decisionOf(run); const last = run.steps.at(-1)?.step;
  if (run.state === "RUNNING") return last === "settlementPending" ? { text: "Check fee awaiting reconciliation.", tone: "warn" } : { text: "Run in progress.", tone: "info" };
  if (run.state === "RECONCILE_REQUIRED") return { text: "Payment result not yet established.", tone: "warn" };
  if (ex?.chainStatus === "SIGNED_NOT_BROADCAST") return { text: "This attempt was not sent by this runner.", tone: "warn" };
  if (run.state === "FAILED") return last === "settlementPending" ? { text: "Check fee awaiting reconciliation.", tone: "warn" } : { text: "The workflow stopped before any business transaction was signed.", tone: "bad" };
  if (d === "BLOCKED" || d === "REVIEW_REQUIRED") return { text: "This payment is outside the referenced approval.", tone: d === "BLOCKED" ? "bad" : "warn" };
  if (!ex) return { text: "No recorded outcome.", tone: "neutral" };
  if (ex.chainStatus === "CONFIRMED" && ex.businessStatus === "SUCCESS") return { text: "Order payment confirmed.", tone: "ok" };
  if (ex.chainStatus === "CONFIRMED") return { text: "Transaction confirmed; expected order outcome not verified.", tone: "bad" };
  if (ex.chainStatus === "REVERTED") return { text: "Transaction reverted; this attempt did not pay the order.", tone: "bad" };
  if (ex.chainStatus === "UNKNOWN" && ex.businessStatus === "NOT_EXECUTED") return { text: "This attempt was never mined; the order reads as unpaid and no replacement was signed.", tone: "warn" };
  if (ex.chainStatus === "UNKNOWN" || ex.chainStatus === "PENDING" || ex.businessStatus === "UNKNOWN" || ex.businessStatus === "PENDING") return { text: "Payment result not yet established.", tone: "warn" };
  return { text: "No configured check fired at the pinned block.", tone: "neutral" };
}

/** paid / unpaid / unknown — from the post-condition or reconciliation, never from the receipt alone. */
export function orderResultOf(r: RunResult | null): "paid" | "unpaid" | "unknown" {
  if (!r) return "unknown";
  if (r.postcondition && typeof r.postcondition.paid === "boolean") return r.postcondition.paid ? "paid" : "unpaid";
  const ex = r.execution;
  if (ex.businessStatus === "SUCCESS") return "paid";
  if (ex.chainStatus === "NOT_SIGNED" || ex.chainStatus === "SIGNED_NOT_BROADCAST") return "unpaid"; // nothing was executed by this attempt
  if (ex.chainStatus === "UNKNOWN" && ex.businessStatus === "NOT_EXECUTED") return "unpaid"; // reconciliation read the order and closed the attempt as never mined
  return "unknown";
}

/** Recovery desk (design §6): last known facts and the authorized reconciliation command for THIS attempt. No "pay again". */
export function RecoveryDesk({ run, net, onUpdate }: { run: Run; net: NetworkInfo | null; onUpdate?: (run: Run) => void }) {
  const [state, setState] = useState<{ busy: boolean; err: string | null; done: string | null }>({ busy: false, err: null, done: null });
  const key = runKeyFor(run.runId);
  const r = run.result; const ex = r?.execution; const be = run.businessExecution ?? null;
  const hash = be?.txHash ?? ex?.businessTxHash ?? ex?.signedTransactionHash ?? null;
  const broadcast = run.steps.find((s) => s.step === "broadcast");
  const notes = run.recovery?.reconciliation ?? [];
  const recover = async () => {
    if (!key) return;
    setState({ busy: true, err: null, done: null });
    try { const updated = await api.recoverRun(run.runId, key); onUpdate?.(updated); setState({ busy: false, err: null, done: `reconciliation ran from the original context; run state is now ${updated.state}` }); }
    catch (e: any) { setState({ busy: false, err: errText(e), done: null }); }
  };
  return (
    <div className="panel stack" style={{ gap: 10 }} id="sec-recovery">
      <div className="card-title"><h3>Recovery desk</h3><Chip tone="warn">original attempt only</Chip></div>
      <p className="small muted">Recovery re-reads the original transaction by its hash and the order state. It never signs a replacement, never creates an order, never buys another check. The worker runs every 30 s; reading this run observes too.</p>
      <div className="kv w190">
        <span className="k">original transaction</span><span>{hash ? <Hex value={hash} link={explorerTx(net, hash)} /> : <span className="dim">none signed</span>}</span>
        <span className="k">nonce</span><span>{be?.nonce ?? r?.plan?.nonce ?? "—"}</span>
        <span className="k">validity window ends</span><span>{be?.validUntil ? utc(be.validUntil) : r?.finalValidation?.expiresAt ? utc(r.finalValidation.expiresAt) : "—"}</span>
        <span className="k">broadcast marker</span><span>{broadcast || be?.broadcastBlock ? `written${be?.broadcastBlock ? ` at head #${be.broadcastBlock}` : ""} · node ${broadcast?.accepted === false ? "did not acknowledge the send" : "acknowledged the send"}` : "not written — nothing reached the network from this runner"}</span>
        <span className="k">last known</span><span>{be ? `${be.state}${be.businessStatus ? ` / ${be.businessStatus}` : ""}` : ex ? `${ex.chainStatus} / ${ex.businessStatus}` : "—"}</span>
        <span className="k">reconciliation notes</span><span>{notes.length ? <ul className="list">{notes.map((x, i) => <li key={i}>{utc(x.at)} · {x.chainStatus} / {x.businessStatus}{x.note ? ` — ${x.note}` : ""}</li>)}</ul> : "none yet"}</span>
      </div>
      {key
        ? <div className="row" style={{ gap: 10, alignItems: "center" }}><button className="btn primary" disabled={state.busy} onClick={recover}>{state.busy ? <><Spinner /> reconciling…</> : "Recover this attempt"}</button><span className="tiny dim">authorized with the admission key this browser used to start the run</span></div>
        : <p className="small dim">Recovery is available to the session that started this run; this page shows the recorded facts only.</p>}
      {state.err && <div className="banner bad">{state.err}</div>}
      {state.done && <div className="banner info">{state.done}</div>}
    </div>
  );
}

/** `origin` (review of 2026-10-09, item 4): "live" = started in this session, "history" = opened from the records, "sample" = the API's fallback when
 *  execution was unavailable (`reason` says why); `onLocal` reports what this browser did with the passport (export, verification state). */
export type RunOrigin = "live" | "history" | "sample";
export function RunPanel({ run, net, sample, onUpdate, origin = null, reason = null, onLocal }: { run: Run; net: NetworkInfo | null; sample?: boolean; onUpdate?: (run: Run) => void; origin?: RunOrigin | null; reason?: string | null; onLocal?: (runId: string, local: { exported: boolean; verified: "passed" | "failed" | "partial" | null }) => void }) {
  const { link = (to: string) => to } = useNet(); // permanent links carry ?net= when the selected instance is not the root (P2)
  const r = run.result;
  const running = run.state === "RUNNING";
  const reconciling = run.state === "RECONCILE_REQUIRED";
  const head = headlineOf(run); const message = messageOf(run); const outcome = run.outcome ?? null;
  const labels = sample ? [...run.labels.filter((l) => l !== "LIVE_REQUEST"), "RECORDED_SAMPLE"] : run.labels;
  const decisionStep = run.steps.find((s) => s.step === "decision");
  const reasons = (r?.decision?.reasons ?? (decisionStep?.reasons as string[] | undefined) ?? []) as string[];
  const narration = useMemo(() => run.steps.map(narrate).filter((x): x is string => !!x), [run.steps]);
  // the passport state belongs to ONE run (review 2026-10-09): a different run shown by the same panel starts clean, and a download or
  // verification that resolves after the switch is dropped rather than attributed to the run now on screen
  const [dl, setDl] = useState<{ runId: string | null; busy: boolean; err: string | null; bundle: PassportBundle | null; name: string | null }>({ runId: null, busy: false, err: null, bundle: null, name: null });
  const [verified, setVerified] = useState<{ runId: string; kind: "passed" | "failed" | "partial" } | null>(null);
  const current = useRef(run.runId); current.current = run.runId;
  const mine = dl.runId === run.runId;
  const bundle = mine ? dl.bundle : null, bundleName = mine ? dl.name : null, dlBusy = mine && dl.busy, dlErr = mine ? dl.err : null;
  const verifiedKind = verified?.runId === run.runId ? verified.kind : null;
  const download = async () => {
    const id = run.runId;
    setDl((d) => (d.runId === id ? { ...d, busy: true, err: null } : { runId: id, busy: true, err: null, bundle: null, name: null }));
    try {
      const { __status: _s, ...b } = (await api.passport(id)) as any;
      if (current.current !== id) { setDl((d) => (d.runId === id ? { ...d, busy: false } : d)); return; } // another run is shown now: this is not its passport — dropped, not stored
      const name = `arcpreflight-passport-${id.slice(0, 8)}.json`; saveJson(name, b); setDl({ runId: id, busy: false, err: null, bundle: b, name }); setVerified(null); onLocal?.(id, { exported: true, verified: null });
    } catch (e: any) { if (current.current !== id) { setDl((d) => (d.runId === id ? { ...d, busy: false } : d)); return; } setDl({ runId: id, busy: false, err: errText(e), bundle: null, name: null }); }
  };
  const ex = r?.execution; const cost = r?.costStatement ?? null; const rec = run.recovery ?? null; const be = run.businessExecution ?? null;
  const ord = orderResultOf(r);
  const observedImpl = r?.report?.dependencies?.find((d) => d.role === "IMPLEMENTATION")?.address ?? null;
  const approvedImpl = net?.fixtures?.find((f) => f.id === run.fixture)?.approvedImplementation ?? null;
  // the execution store settles an attempt in one of these states; a result that still says UNKNOWN then belongs to the interrupted process, not to the outcome (AP33-06)
  const storeSettled = !!be && ["CONFIRMED", "REVERTED", "NOT_MINED", "SUPERSEDED", "NOT_BROADCAST", "INTERRUPTED"].includes(be.state);
  const needsDesk = reconciling || (!!ex && (["UNKNOWN", "PENDING"].includes(ex.chainStatus) || ["UNKNOWN", "PENDING"].includes(ex.businessStatus)) && !storeSettled);
  const unresolved = reconciling || (!!ex && (ex.chainStatus === "UNKNOWN" || ex.businessStatus === "UNKNOWN") && !storeSettled);
  const feeAtomic = r?.quote?.amountTokenAtomic ?? net?.priceTokenAtomic ?? null;
  const amount = r?.intent?.businessExpectation?.amountNativeAtomic ?? run.order?.amountNativeAtomic ?? null;
  const candidate = r?.intent?.valueNativeAtomic ?? null;
  const network = (r?.network ?? net?.network) === "mainnet" ? "Arc mainnet" : "Arc testnet";
  const interrupted = run.steps.some((s) => s.step === "interruptedAfterBroadcast");
  const reconciledStep = [...run.steps].reverse().find((s) => s.step === "reconciled") ?? null;
  const lastRec = rec?.reconciliation?.at(-1) ?? null;
  const added = rec?.addedByRecovery ?? null;
  const stages = useMemo(() => lifecycleFromRun(run, { exported: !!bundle, verified: verifiedKind }), [run, bundle, verifiedKind]);
  const anchors = useMemo(() => ({ baselineDigests: Array.from(new Set((net?.fixtures ?? []).map((f) => f.baselineDigest).filter((x): x is string => !!x))), policyDigests: r?.policyDigest ? [r.policyDigest] : [] }), [net, r?.policyDigest]);
  const beTone: Tone = be?.state === "CONFIRMED" ? "ok" : be?.state === "REVERTED" || be?.state === "NOT_MINED" ? "bad" : be?.state === "BROADCAST_ATTEMPTED" ? "warn" : "neutral";
  // the lifecycle diagram jumps to the section that holds the stage's result (review of 2026-10-09, item 5)
  const SECTION: Record<LifecycleId, string> = { order: "sec-order", approve: "sec-order", check: "sec-check", execute: "sec-payment", recover: needsDesk ? "sec-recovery" : "sec-payment", passport: "btn-passport", verify: "sec-verify" };
  const pick = (id: LifecycleId) => { if (typeof document === "undefined") return; document.getElementById(SECTION[id])?.scrollIntoView?.({ behavior: "smooth", block: "center" }); };
  const recoveryBusiness = (reconciledStep?.businessStatus as string | undefined) ?? lastRec?.businessStatus ?? be?.businessStatus ?? null;
  const recoveryMoment: RecoveryMoment = reconciling ? "recovering" : reconciledStep || lastRec || storeSettled ? (be?.state === "CONFIRMED" || recoveryBusiness === "SUCCESS" ? "resolved" : "failed") : "interrupted";
  const recoveryOutcome = `${((reconciledStep?.chainStatus as string | undefined) ?? lastRec?.chainStatus ?? be?.state ?? "unknown")} / ${recoveryBusiness ?? "unknown"}`.toLowerCase().replace(/_/g, " ");
  return (
    <div className="stack fade" style={{ gap: 24 }}>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
          <span className="serif" style={{ fontSize: "1.5rem" }}>{FIXTURE_TITLES[run.fixture] ?? run.fixture}</span>
          <Labels labels={labels} network={r?.network ?? net?.network} />
          {origin && <Chip tone={origin === "live" ? "ok" : "neutral"} title={origin === "live" ? "started in this session: real transactions on the chain named here" : "opened from the records; no new transaction was initiated"}>{origin === "live" ? "live testnet execution" : "recorded example"}</Chip>}
          {run.partial && <Chip tone="warn" title={`artefacts present: ${(run.artifactsPresent ?? []).join(", ")}`}>assembled from persisted artefacts</Chip>}
          {interrupted && <Chip tone="warn">simulated interruption</Chip>}
        </div>
        <div className="row" style={{ gap: 10 }}>
          {running || reconciling ? <><Spinner /> <span className="small muted">{reconciling ? "reconciliation pending" : "live"} · {run.steps.length} steps</span></> : <span className="small dim">{run.result ? ms(run.result.durationMs) : ""} · {ago(run.updatedAt)}</span>}
          <Link to={link(`/runs/${run.runId}`)} className="tiny dim" title="permanent link">#{run.runId.slice(0, 8)}</Link>
        </div>
      </div>
      <FlowCanvas stages={stages} onPick={pick} />

      {/* the primary screen (design §5): one order, its referenced approval, its money, its recovery facts */}
      <div className="panel outcome stack" style={{ gap: 14 }}>
        <div className="card-title" style={{ flexWrap: "wrap" }}>
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <span className="serif" style={{ fontSize: "1.25rem" }}>Order {r ? <Hex value={r.orderId} n={5} /> : run.order ? <Hex value={run.order.orderId} n={5} /> : <span className="dim">…</span>}</span>
            <Chip tone={network === "Arc mainnet" ? "violet" : "neutral"}>{network}</Chip>
            <span className="tiny dim">release {net?.release ?? "…"}</span>
          </div>
          <div className={`banner ${message.tone === "ok" || message.tone === "info" ? "info" : message.tone === "bad" ? "bad" : ""}`} style={{ margin: 0 }} role="status">{message.text}</div>
        </div>
        {interrupted && (
          <div className="interruption stack" role="status" data-testid="interruption" style={{ gap: 8 }}>
            <RecoveryStrip moment={recoveryMoment} hash={be?.txHash ?? ex?.businessTxHash ?? null} net={net} outcome={recoveryOutcome} />
            <span className="small"><b>Simulated interruption</b>: the runner stopped waiting right after the send.{recoveryMoment === "resolved" || recoveryMoment === "failed" ? <> Recovery resolved it from the recorded hash and the order state{lastRec?.at ? ` at ${utc(lastRec.at)}` : ""}.</> : <> Recovery resolves it from the recorded hash and the order state.</>} Added by recovery — orders: <b>{added?.ordersCreated ?? 0}</b>, signatures: <b>{added?.businessSignatures ?? 0}</b>.</span>
          </div>
        )}
        <div className="two" style={{ gap: 28 }}>
          <div className="kv w190" id="sec-order">
            <span className="k">approved implementation</span><span>{approvedImpl ? <Hex value={approvedImpl} n={5} link={explorerAddr(net, approvedImpl)} /> : "—"}{observedImpl && approvedImpl && observedImpl.toLowerCase() !== approvedImpl.toLowerCase() && <> · observed <Hex value={observedImpl} n={5} link={explorerAddr(net, observedImpl)} /></>}</span>
            <span className="k">referenced approval</span><span>{r ? <><Hex value={r.intent.baselineDigest} n={6} /> <Chip tone={r.report.baselineResult === "MATCH" ? "ok" : r.report.baselineResult === "NO_BASELINE" ? "bad" : "warn"}>{r.report.baselineResult === "MATCH" ? "unchanged" : r.report.baselineResult.toLowerCase().replace(/_/g, " ")}</Chip>{r.approvalStatusAtValidation && <span className="tiny dim"> · at final validation: {r.approvalStatusAtValidation.revoked ? "REVOKED" : "valid"}{r.approvalStatusAtValidation.validUntil ? ` until ${utc(r.approvalStatusAtValidation.validUntil)}` : ""}</span>}</> : "—"}</span>
            <span className="k">business amount</span><span>{amount ? usdc6(amount) : "—"}{candidate && amount && candidate !== amount && <> <Chip tone="bad">candidate value {candidate} atomic</Chip></>}{run.order?.reference && <span className="tiny dim"> · “{run.order.reference}”</span>}</span>
            <span className="k">check fee</span><span>{feeAtomic ? usdcToken6(feeAtomic) : "—"}{r?.serviceFeeTx && <> · <Hex value={r.serviceFeeTx} link={explorerTx(net, r.serviceFeeTx)} /></>}</span>
            <span className="k">order creation</span><span>{run.order?.tx ? <><Hex value={run.order.tx} n={5} link={explorerTx(net, run.order.tx)} />{run.order.block && <> @ #{run.order.block}</>} <Chip tone={run.order.state === "CONFIRMED" ? "ok" : "warn"}>{run.order.state.toLowerCase().replace(/_/g, " ")}</Chip></> : r ? <span className="dim">recorded in the step log</span> : "—"}</span>
          </div>
          <div className="kv w190" id="sec-payment">
            <span className="k">outcome</span><span><Chip tone={head.decision === "CONFIRMED" ? "ok" : head.decision === "BLOCKED" || head.decision === "FAILED" ? "bad" : head.decision ? "warn" : "info"}>{head.text.toLowerCase()}</Chip>{outcome && <span className="tiny dim"> · from the {outcome.source === "store" ? "execution store" : outcome.source}</span>}</span>
            <span className="k">business execution</span>
            <span>{be ? <span className="stack" style={{ gap: 2 }}>
              <span><Chip tone={beTone}>{be.state.toLowerCase().replace(/_/g, " ")}</Chip>{be.businessStatus && <Chip tone={be.businessStatus === "SUCCESS" ? "ok" : be.businessStatus === "FAILED" ? "bad" : "warn"}>order {be.businessStatus === "SUCCESS" ? "paid" : be.businessStatus.toLowerCase().replace(/_/g, " ")}</Chip>}</span>
              <span className="small">{be.txHash ? <Hex value={be.txHash} n={6} link={explorerTx(net, be.txHash)} /> : <span className="dim">no hash</span>}{be.broadcastBlock && <span className="tiny dim"> · broadcast at head #{be.broadcastBlock}</span>}{be.block && <span className="tiny dim"> · mined #{be.block}</span>}{be.nonce !== null && be.nonce !== undefined && <span className="tiny dim"> · nonce {be.nonce}</span>}</span>
              {be.note && <span className="tiny dim">{be.note}</span>}
            </span> : ex ? <Chip tone={ex.chainStatus === "CONFIRMED" ? "ok" : ex.chainStatus === "REVERTED" ? "bad" : ex.chainStatus === "NOT_SIGNED" || ex.chainStatus === "SIGNED_NOT_BROADCAST" ? "neutral" : "warn"}>{ex.chainStatus.toLowerCase().replace(/_/g, " ")} · {ex.businessStatus.toLowerCase().replace(/_/g, " ")}</Chip> : running ? <Spinner /> : "—"}</span>
            <span className="k">order result</span><span>{r || run.order ? <Chip tone={ord === "paid" || run.order?.paid === true ? "ok" : ord === "unknown" && run.order?.paid !== false ? "warn" : "neutral"}>{run.order?.paid === true ? "paid" : ord}</Chip> : "—"}{r && ord === "unpaid" && (ex?.chainStatus === "NOT_SIGNED" || ex?.chainStatus === "SIGNED_NOT_BROADCAST") && <span className="tiny dim"> · nothing executed</span>}</span>
            <span className="k">service outcome</span><span><Chip tone="neutral">not evaluated</Chip> <span className="tiny dim">a paid order is not proof of offchain delivery</span></span>
            <span className="k">recovery of this attempt</span>
            <span className="stack" style={{ gap: 2 }}>
              <span>new orders created: <b>{rec ? (rec.addedByRecovery?.ordersCreated ?? Math.max(0, rec.counters.ordersCreated - 1)) : "—"}</b> · new check-fee authorizations: <b>{rec ? (rec.addedByRecovery?.checkFeeAuthorizations ?? Math.max(0, rec.counters.checkFeeAuthorizations - 1)) : "—"}</b> · new business signatures: <b>{rec ? (rec.addedByRecovery?.businessSignatures ?? rec.counters.replacementSignatures) : "—"}</b></span>
              <span>original transaction: <b>{rec ? rec.originalTransaction.status.replace(/-/g, " ") : "—"}</b>{rec && rec.counters.broadcastsOfOriginalBytes > 1 ? <span className="tiny dim"> · the original bytes were broadcast {rec.counters.broadcastsOfOriginalBytes} times (same hash, no replacement)</span> : null}</span>
              <span className="tiny dim">{rec ? `counted from the recorded steps — in total ${rec.counters.ordersCreated} order, ${rec.counters.checkFeeAuthorizations} check-fee authorization, ${rec.counters.businessSignatures} business signature${rec.counters.businessSignatures === 1 ? "" : "s"}` : "not recorded for this run"}</span>
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" id="btn-passport" disabled={running || dlBusy} title={running ? "available once the run has ended" : unresolved ? "the outcome of this attempt is not established yet; the passport records it as unresolved" : "the passport's files as one JSON document"} onClick={download}>{dlBusy ? <><Spinner /> exporting…</> : unresolved ? "Download Payment Passport (outcome unresolved)" : bundle ? "Download Payment Passport again" : "Download Payment Passport"}</button>
          <a href="#sec-verify" className="btn">Verify in browser</a>
          <Link to={link(`/verify?run=${run.runId}`)} className="btn ghost">Verify elsewhere</Link>
          <a href="#receipt-chain" className="btn ghost">Technical evidence</a>
          {sample && <span className="tiny dim">recorded sample — the counters and costs are that run's, not today's</span>}
        </div>
        {dlErr && <div className="banner bad">{dlErr}</div>}
        <CostTable statement={cost} net={net} title="Cost disclosure" context={{ executionMode: run.executionMode ?? "runner", subjectKind: run.executionMode === "wallet" ? "wallet-run" : "demo-run" }} />
        <div className="stack" style={{ gap: 6 }} id="sec-verify">
          <h3>Verify independently</h3>
          {bundle ? <VerifyInBrowser bundle={bundle} name={bundleName} net={net} anchors={anchors} anchorsSource="site" onVerified={(_r, s) => { const id = run.runId; if (current.current !== id) return; setVerified({ runId: id, kind: s.kind }); onLocal?.(id, { exported: true, verified: s.kind }); }} compact />
            : <p className="small dim">download the passport first; the verifier then runs here against {net?.rpc ?? "the Arc RPC"}, with this site's digests as anchors (not independent)</p>}
        </div>
      </div>

      {needsDesk && <RecoveryDesk run={run} net={net} onUpdate={onUpdate} />}

      <div className="two" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 14 }}>
          <p className="caption">the agent, thinking out loud — narration is generated from the receipts; the decision is code</p>
          <Typewriter lines={narration} speed={running ? 12 : 3} pause={running ? 350 : 90} className="monologue small" />
        </div>
        <div className="stack" style={{ gap: 12 }} id="sec-check">
          <DecisionBadge decision={head.text === "RUNNING" ? null : head.decision === "CONFIRMED" ? "CONFIRMED" : head.decision} />
          {run.expected && !running && r && <p className="small muted">expected <code>{run.expected}</code>, got <code>{r.decision.decision}</code> {r.decision.decision === run.expected ? <Chip tone="ok">as expected</Chip> : <Chip tone="bad">unexpected</Chip>}</p>}
          {reasons.length > 0 && <ul className="list">{reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {r && (
            <div className="kv w120" style={{ marginTop: 6 }}>
              <span className="k">order</span><span><Hex value={r.orderId} /> · {usdcNative(r.intent.businessExpectation.amountNativeAtomic, 2)}</span>
              <span className="k">merchant</span><span><Hex value={r.merchant} n={5} link={explorerAddr(net, r.merchant)} /></span>
              <span className="k">service fee</span><span>{r.serviceFeeTx ? <><Hex value={r.serviceFeeTx} link={explorerTx(net, r.serviceFeeTx)} /> <span className="tiny dim">{feeAtomic ? usdcToken6(feeAtomic) : "0.01 USDC"} · relayed by the project's merchant account</span></> : "—"}</span>
              <span className="k">business tx</span><span>{r.execution.businessTxHash ? <><Hex value={r.execution.businessTxHash} link={explorerTx(net, r.execution.businessTxHash)} /> <Chip tone={r.execution.businessStatus === "SUCCESS" ? "ok" : r.execution.businessStatus === "UNKNOWN" || r.execution.businessStatus === "PENDING" ? "warn" : "bad"}>{r.execution.chainStatus} / {r.execution.businessStatus}</Chip></> : <Chip tone={head.decision === "BLOCKED" ? "bad" : "warn"}>{r.execution.chainStatus} · {r.execution.businessStatus}</Chip>}</span>
              {r.postcondition && <><span className="k">postcondition</span><span><Chip tone={r.postcondition.paid ? "ok" : "bad"}>paid={String(r.postcondition.paid)}</Chip> payer <Hex value={r.postcondition.payer} n={4} /> amount {usdcNative(r.postcondition.amountNativeAtomic, 2)} @ #{r.postcondition.block}</span></>}
            </div>
          )}
        </div>
      </div>

      <div className="two stack-wide" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 6 }} id="sec-steps">
          <h3>Step by step</h3>
          <p className="tiny dim">who did what, and why — from the runner's own log; open a step for its recorded facts</p>
          <Pipeline steps={run.steps} decision={head.decision === "CONFIRMED" ? "NO_POLICY_VIOLATION" : head.decision} running={running} />
          <StepLog steps={run.steps} net={net} />
        </div>
        <div className="stack" style={{ gap: 26 }} id="receipt-chain">
          {r && (
            <details open>
              <summary><b>Receipt chain</b> <span className="tiny dim">— every digest is keccak256 over canonical JSON, schema 1.0; the same bytes the passport carries</span></summary>
              <div className="kv w150" style={{ marginTop: 10 }}>
                <span className="k">intent</span><span><Hex value={r.intentDigest} n={8} /></span>
                <span className="k">policy</span><span><Hex value={r.policyDigest} n={8} /></span>
                <span className="k">report</span><span><Hex value={r.reportDigest} n={8} /></span>
                <span className="k">baseline</span><span><Hex value={r.report.baselineDigest} n={8} /> <Chip tone={r.report.baselineResult === "MATCH" ? "ok" : "warn"}>{r.report.baselineResult}</Chip></span>
                <span className="k">decision</span><span><Hex value={r.decisionDigest} n={8} /></span>
                {r.finalValidation && <><span className="k">final validation</span><span><Chip tone={r.finalValidation.result === "PASS" ? "ok" : "warn"}>{r.finalValidation.result}</Chip> @ #{r.finalValidation.snapshot.blockNumber} · balance {usdcNative(r.finalValidation.balanceNativeAtomic, 3)} · gas reserve {usdcNative(r.finalValidation.reservedGasNativeAtomic, 6)}</span></>}
                {r.plan && <><span className="k">plan</span><span><Hex value={r.execution.transactionPlanDigest as string} n={8} /> · type {r.plan.type} · nonce {r.plan.nonce} · gas {r.plan.gasLimit} · {(Number(r.plan.maxFeePerGasNativeAtomic) / 1e9).toFixed(1)} gwei</span></>}
                {r.execution.signedTransactionHash && <><span className="k">signed tx</span><span><Hex value={r.execution.signedTransactionHash} n={8} /></span></>}
                <span className="k">execution</span><span><Hex value={r.executionDigest} n={8} /></span>
                <span className="k">recorded</span><span>{utc(r.execution.recordedAt as string)}</span>
              </div>
            </details>
          )}
          {r && (
            <details>
              <summary><b>The pinned report</b> <span className="tiny dim">— bought over x402 · delivered after settlement</span></summary>
              <div style={{ marginTop: 10 }}><ReportView report={r.report} digest={r.reportDigest} net={net} compact /></div>
            </details>
          )}
          {r && <details><summary>raw run JSON (intent, policy, report, receipts, cost statement)</summary><pre className="json" style={{ marginTop: 10 }}>{JSON.stringify(r, null, 2)}</pre></details>}
        </div>
      </div>
    </div>
  );
}
