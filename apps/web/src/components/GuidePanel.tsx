// The persistent "next step" panel of the Live Demo (review of 2026-10-09, item 2): phase, what happened, what to do next, what to
// inspect, and the walkthrough checklist — all from `guideFor`, i.e. from the recorded run. The next target is highlighted on the page
// by the parent (data-guide-hot); "live testnet execution" and "recorded example" are told apart here (item 4).
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { Chip, Spinner } from "./Badges";
import { PHASES, type CheckpointId, type Guide } from "../lib/guide";

export type Origin = "live" | "history" | "sample";
export const ORIGIN_LABEL: Record<Origin, string> = { live: "live testnet execution", history: "recorded example", sample: "recorded example" };
const MARK: Record<string, string> = { done: "✓", na: "–", current: "☞", todo: "○", pending: "…" };

export function GuidePanel({ guide, origin, reason, network, onGo, link = (to) => to, underStrip }: { guide: Guide; origin: Origin | null; reason?: string | null; network?: string | null; onGo?: (checkpoint: CheckpointId | null, target: string) => void; link?: (to: string) => string; /** the sticky run strip is shown above it while a run is in progress */ underStrip?: boolean }) {
  const p = PHASES[guide.phase]; const n = guide.next;
  const go = (e: MouseEvent, id: CheckpointId | null, target: string, external?: boolean) => {
    onGo?.(id, target);
    if (external || typeof document === "undefined") return;
    const el = document.getElementById(target);
    if (el) { e.preventDefault(); el.scrollIntoView?.({ behavior: "smooth", block: "center" }); if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement) el.focus?.(); }
  };
  return (
    <aside className={`guide ${underStrip ? "under-strip" : ""}`} aria-label="next step" aria-live="polite" data-testid="guide" data-phase={guide.phase}>
      <div className="guide-head">
        <Chip tone={p.tone}>{p.live && <Spinner />}{p.label}</Chip>
        {origin && <span className={`origin ${origin === "live" ? "live" : "rec"}`} data-testid="origin">{ORIGIN_LABEL[origin]}{network ? ` · ${network}` : ""}</span>}
        {origin && origin !== "live" && reason && <span className="tiny dim">{reason} · no new transaction was initiated</span>}
      </div>
      <div className="guide-grid">
        <span className="k">happened</span><span data-testid="guide-happened">{guide.happened}</span>
        <span className="k">next</span>
        <span className="row" style={{ gap: 8 }}>
          {n.route
            ? <Link to={link(n.target)} className="btn sm primary" data-testid="guide-next">{n.label} →</Link>
            : <a href={n.external ? n.target : `#${n.target}`} target={n.external ? "_blank" : undefined} rel={n.external ? "noreferrer" : undefined} className="btn sm primary" data-testid="guide-next" onClick={(e) => go(e, n.checkpoint, n.target, n.external)}>{n.label} {n.external ? "↗" : "→"}</a>}
          {n.hint && <span className="tiny dim">{n.hint}</span>}
        </span>
        {guide.inspect && <><span className="k">inspect</span><span data-testid="guide-inspect">{guide.inspect}</span></>}
        {guide.blocked && <><span className="k">why</span><span className="guide-why" data-testid="guide-why">{guide.blocked}</span></>}
      </div>
      <ol className="guide-steps" aria-label="walkthrough">
        {guide.checkpoints.map((c) => (
          <li key={c.id} className={c.status} title={c.hint} data-testid={`cp-${c.id}`}>
            {c.status === "na" || c.status === "pending"
              ? <span><span className="mark" aria-hidden="true">{MARK[c.status]}</span>{c.label}</span>
              : <a href={c.external ? c.target : `#${c.target}`} target={c.external ? "_blank" : undefined} rel={c.external ? "noreferrer" : undefined} onClick={(e) => go(e, c.id, c.target, c.external)}><span className="mark" aria-hidden="true">{MARK[c.status]}</span>{c.label}</a>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
