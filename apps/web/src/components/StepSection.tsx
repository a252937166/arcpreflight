// One step of the Developer workflow: a header line (number, title, status, one-line summary with its hash links) that toggles the
// body. A completed step collapses to that line; the current step is open. The body stays in the DOM (hidden) so nothing is lost.
import type { ReactNode } from "react";
import type { StageStatus } from "../lib/outcome";

const GLYPH: Record<StageStatus, string | null> = { done: "✓", stop: "✕", review: "!", warn: "!", skipped: "–", active: null, todo: null };
export function StepSection({ n, id, title, status, summary, open, onToggle, children, aside }: { n: number; id: string; title: string; status: StageStatus; summary?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`wstep ${status} ${open ? "open" : ""}`} id={id} aria-current={status === "active" ? "step" : undefined}>
      <div className="wstep-head">
        <button type="button" className="wstep-toggle" onClick={onToggle} aria-expanded={open} aria-controls={`${id}-body`}>
          <span className="wstep-n" aria-hidden="true">{GLYPH[status] ?? n}</span>
          <span className="wstep-title">{n} · {title}</span>
          <span className="wstep-caret" aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
        {(summary || aside) && <div className="wstep-summary">{summary}{aside}</div>}
      </div>
      <div className="wstep-body" id={`${id}-body`} hidden={!open}>{children}</div>
    </section>
  );
}
