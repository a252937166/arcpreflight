// The complete lifecycle as one diagram (docs/LIFECYCLE.md): seven nodes — create order → review & approve → preflight check →
// execute → recover → export passport → verify independently — with the current stage highlighted. CSS, not SVG, so it stays
// legible at phone width (it stacks vertically) and the labels are real text.
import type { LifecycleId, LifecycleStage, StageStatus } from "../lib/outcome";

const GLYPH: Record<StageStatus, string | null> = { done: "✓", stop: "✕", review: "!", warn: "!", skipped: "–", active: null, todo: null };
export function Lifecycle({ stages, compact, onPick, caption }: { stages: LifecycleStage[]; compact?: boolean; onPick?: (id: LifecycleId) => void; caption?: string }) {
  return (
    <div className={`lifecycle-wrap ${compact ? "compact" : ""}`}>
      <ol className="lifecycle" aria-label="lifecycle: create order, review and approve, preflight check, execute payment, recover, export passport, verify independently">
        {stages.map((s, i) => {
          const glyph = GLYPH[s.status] ?? String(i + 1);
          const node = <span className="lc-dot" aria-hidden="true">{glyph}</span>;
          return (
            <li key={s.id} className={`lc ${s.status}`} aria-current={s.status === "active" ? "step" : undefined} title={s.note ?? undefined}>
              {onPick ? <button type="button" className="lc-node" onClick={() => onPick(s.id)} aria-label={`${s.label}: ${s.status}${s.note ? ` — ${s.note}` : ""}`}>{node}</button> : <span className="lc-node">{node}</span>}
              <span className="lc-text"><span className="lc-label">{s.label}</span>{s.note && !compact && <span className="lc-note">{s.note}</span>}</span>
            </li>
          );
        })}
      </ol>
      {caption && <p className="tiny dim lc-caption">{caption}</p>}
    </div>
  );
}
