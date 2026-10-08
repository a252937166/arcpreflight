// A wallet attempt (docs/LIFECYCLE.md §3, §9): the recorded state, the hash the wallet returned, the after-the-fact comparison with the
// validated plan (mismatch = red, wallet-set gas/fees/nonce = amber, recorded), the outcome from the receipt and the order state, the
// cost disclosure, and the actions that are allowed from the current state — recover (reads only), abandon (VALIDATED), continue in
// the wallet (VALIDATED inside its window). After an ambiguous wallet error (no hash, not a rejection) nothing offers a second prompt:
// the panel reconciles and then asks the visitor explicitly ("I rejected it — abandon"). Nothing here signs or sends by itself.
import { Chip, Hex, Spinner } from "./Badges";
import { CostTable } from "./CostTable";
import { explorerAddr, explorerTx, type AttemptView, type NetworkInfo } from "../lib/api";
import { attemptMessage, deviationRows, insideWindow, isOpen, stateTone, type ExecutePhase, type Refusal } from "../lib/attempts";
import { nativeAtomicToUsdcText } from "../lib/orders";
import { utc } from "../lib/format";
import type { Described } from "../lib/errors";

export type AttemptActions = { onRecover?: (id: string) => void; onAbandon?: (id: string) => void; onResume?: (a: AttemptView) => void; onRefresh?: (id: string) => void };
export function AttemptPanel({ attempt, phase = "idle", txHash, refusal, err, net, busy, now = Date.now(), actions = {}, compact }: { attempt: AttemptView | null; phase?: ExecutePhase; txHash?: string | null; refusal?: Refusal | null; err?: Described | null; net: NetworkInfo | null; busy?: boolean; now?: number; actions?: AttemptActions; compact?: boolean }) {
  const a = attempt;
  const ambiguous = phase === "unknown-submission";
  const reconciling = ambiguous && !!busy;
  const message = attemptMessage(a, phase, { reconciling });
  const rows = deviationRows(a?.deviations);
  const hash = a?.businessTxHash ?? a?.txHash ?? txHash ?? null;
  const open = a ? isOpen(a.state) : false;
  const inWindow = a ? insideWindow(a, now) : false;
  const secondsLeft = a?.validUntil ? Math.max(0, Math.round((new Date(a.validUntil).getTime() - now) / 1000)) : null;
  const unresolved = phase === "unresolved" || (a?.state === "BROADCAST_ATTEMPTED" && phase !== "polling");
  // the wallet may be prompted (again) only when nothing suggests a transaction already left: never after an ambiguous error
  const mayResume = !!a && !!actions.onResume && a.state === "VALIDATED" && inWindow && !!a.plan && !ambiguous;
  return (
    <div className="stack" style={{ gap: 12 }} data-testid="attempt-panel" data-phase={phase}>
      <div className={`banner ${message.tone === "ok" || message.tone === "info" ? "info" : message.tone === "bad" ? "bad" : ""}`} role="status">{reconciling && <><Spinner /> </>}{message.text}</div>
      {ambiguous && err && <p className="tiny dim">the wallet's answer was: <code>{err.text}</code>{err.code ? ` (${err.code})` : ""}</p>}
      {refusal && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}><Chip tone="bad">REFUSED · {refusal.stage === "finalValidation" ? "final validation" : refusal.stage}</Chip>{refusal.attemptId && <span className="tiny dim">attempt <code>{refusal.attemptId.slice(0, 8)}</code> recorded REFUSED — nothing was sent</span>}</div>
          {refusal.reasons.length > 0 && <ul className="list small">{refusal.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </div>
      )}
      {err && !ambiguous && <div className="banner bad" role="alert">{err.text}</div>}
      {a && (
        <div className="kv w150">
          <span className="k">attempt</span><span><code>{a.attemptId.slice(0, 8)}</code> <Chip tone={stateTone(a.state)}>{a.state.replace(/_/g, " ").toLowerCase()}</Chip>{a.businessStatus && <Chip tone={a.businessStatus === "SUCCESS" ? "ok" : a.businessStatus === "FAILED" ? "bad" : "warn"}>order {a.businessStatus === "SUCCESS" ? "paid" : a.businessStatus.toLowerCase().replace(/_/g, " ")}</Chip>}{(phase === "validating" || phase === "prompting" || phase === "reporting" || phase === "polling") && <Spinner />}</span>
          <span className="k">transaction</span><span>{hash ? <><Hex value={hash} n={6} link={explorerTx(net, hash)} />{a.block && <> · mined #{a.block}</>}{a.broadcastBlock && <span className="tiny dim"> · reported at head #{a.broadcastBlock}</span>}{a.recovery?.originalTransaction.status === "recovered-from-event" || /OrderPaid/.test(a.note ?? "") ? <span className="tiny dim"> · recovered through the merchant's OrderPaid event</span> : null}</> : <span className="dim">none reported</span>}</span>
          {(a.nonce !== null && a.nonce !== undefined) || a.from ? <><span className="k">from · nonce</span><span>{a.from ? <Hex value={a.from} n={4} link={explorerAddr(net, a.from)} /> : "—"} · {a.nonce ?? "—"} <span className="tiny dim">read from the visible transaction</span></span></> : null}
          <span className="k">amount</span><span>{nativeAtomicToUsdcText(a.amountNativeAtomic)} USDC → <Hex value={a.merchant} n={4} link={explorerAddr(net, a.merchant)} /></span>
          {a.validUntil && (open || a.state === "VALIDATED") && <><span className="k">validation window</span><span>{inWindow ? <><Chip tone="info">{secondsLeft}s left</Chip> until {utc(a.validUntil)}</> : <><Chip tone="warn">closed</Chip> at {utc(a.validUntil)}</>}</span></>}
          <span className="k">plan comparison</span>
          <span>{rows.length === 0 ? (a.state === "VALIDATED" || a.state === "REFUSED" || a.state === "NOT_SENT" ? <span className="dim">{ambiguous ? "no transaction identified yet" : "nothing sent yet"}</span> : hash ? <Chip tone="ok">to · data · value · chainId · type as planned{a.deviations ? " · gas, fees, nonce as planned" : ""}</Chip> : <span className="dim">—</span>)
            : <span className="stack" style={{ gap: 4 }}>{rows.map((r) => <span key={`${r.kind}-${r.field}`} className="row" style={{ gap: 6 }}><Chip tone={r.kind === "mismatch" ? "bad" : "warn"}>{r.kind === "mismatch" ? `MISMATCH · ${r.field}` : `deviation · ${r.field}`}</Chip>{r.kind === "deviation" ? <span className="tiny dim">plan {r.plan} · wallet set {r.actual} — recorded, not silently accepted</span> : <span className="tiny dim">the call itself differs from the validated plan</span>}</span>)}</span>}
          </span>
          {a.note && <><span className="k">note</span><span className="small muted">{a.note}</span></>}
          <span className="k">next action</span><span className="small">{ambiguous && a.state === "VALIDATED" ? (reconciling ? "reconciling — wait for the result" : "decide: abandon only if you know the prompt was rejected; otherwise recover again") : a.nextAction}</span>
        </div>
      )}
      {(a || unresolved) && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {mayResume && <button className="btn primary" disabled={busy} onClick={() => actions.onResume!(a!)}>Continue in wallet (sign the validated plan)</button>}
          {a && actions.onAbandon && a.state === "VALIDATED" && <button className="btn" disabled={busy} onClick={() => actions.onAbandon!(a.attemptId)} title={ambiguous ? "records NOT_SENT: only if you know the wallet never signed or broadcast anything" : "records that the prompt was rejected; nothing was sent"}>{ambiguous ? "I rejected it — abandon" : "Abandon (nothing sent)"}</button>}
          {a && actions.onRecover && (open || unresolved) && <button className="btn" disabled={busy} onClick={() => actions.onRecover!(a.attemptId)} title="bounded reconciliation of this attempt now: the hash, the order state, the OrderPaid event">{busy ? <><Spinner /> reconciling…</> : "Recover"}</button>}
          {a && actions.onRefresh && <button className="btn sm ghost" disabled={busy} onClick={() => actions.onRefresh!(a.attemptId)}>refresh (observe)</button>}
          {unresolved && <span className="tiny dim">still unresolved after the wait: recovery reads the hash, the order state and the OrderPaid event; it never re-signs or re-sends</span>}
          {ambiguous && !reconciling && a?.state === "VALIDATED" && <span className="tiny dim">no second prompt is offered while the first answer is unexplained — a transaction may already be on its way</span>}
        </div>
      )}
      {a?.recovery && !compact && (
        <p className="tiny dim">recovery: new orders created <b>{a.recovery.addedByRecovery?.ordersCreated ?? 0}</b> · new check-fee authorizations <b>{a.recovery.addedByRecovery?.checkFeeAuthorizations ?? 0}</b> · new business signatures <b>{a.recovery.addedByRecovery?.businessSignatures ?? 0}</b> · original transaction <b>{a.recovery.originalTransaction.status.replace(/-/g, " ")}</b>{a.recovery.reconciliation.length > 0 && <> · last reconciliation {utc(a.recovery.reconciliation.at(-1)!.at)}</>}</p>
      )}
      {a && !compact && <CostTable statement={a.costStatement ?? null} net={net} title="Cost disclosure" context={{ executionMode: "wallet", subjectKind: "wallet-run" }} />}
    </div>
  );
}
