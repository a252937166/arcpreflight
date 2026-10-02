// The sense -> decide -> act -> verify loop drawn as a wandering path. Driven by the step names the runner emits.
export const STAGES = [
  { id: "createOrder", label: "approved order", steps: ["createOrder"] },
  { id: "intent", label: "exact intent", steps: ["intent"] },
  { id: "report", label: "pinned report · x402", steps: ["quote", "staleObservation", "signServiceFee", "settlementPending", "reportDelivered"] },
  { id: "decision", label: "deterministic decision", steps: ["decision"] },
  { id: "finalValidation", label: "final validation", steps: ["finalValidation"] },
  { id: "sign", label: "sign the exact plan", steps: ["signed"] },
  { id: "broadcast", label: "broadcast", steps: ["broadcast"] },
  { id: "verify", label: "verify the outcome", steps: ["postcondition"] },
] as const;

// node positions along a hand-drawn path (viewBox 1000 x 200)
const PTS = [[60, 120], [190, 70], [320, 130], [450, 60], [580, 125], [710, 70], [840, 120], [950, 70]] as const;
const PATH = "M60 120 C 110 90, 140 70, 190 70 S 280 130, 320 130 S 410 60, 450 60 S 540 125, 580 125 S 670 70, 710 70 S 800 120, 840 120 S 920 70, 950 70";

export function Pipeline({ steps, decision, running, idle }: { steps?: { step: string }[]; decision?: string | null; running?: boolean; idle?: boolean }) {
  const seen = new Set((steps ?? []).map((s) => s.step));
  const stopped = seen.has("notSigned") || seen.has("error");
  let lastIdx = -1;
  STAGES.forEach((st, i) => { if (st.steps.some((x) => seen.has(x))) lastIdx = i; });
  return (
    <svg className="loop" viewBox="0 0 1000 200" role="img" aria-label="Pipeline: approved order, exact intent, pinned report, decision, final validation, sign, broadcast, verify">
      <path d={PATH} className="path" />
      {idle && (
        <circle r="6" className="runner"><animateMotion dur="9s" repeatCount="indefinite" path={PATH} /></circle>
      )}
      {STAGES.map((st, i) => {
        let cls = "";
        if (!idle) {
          if (i < lastIdx || (i === lastIdx && !running)) cls = "done";
          if (i === lastIdx && running) cls = "active";
          if (st.id === "decision" && seen.has("decision")) cls = decision === "BLOCKED" ? "stop" : decision === "REVIEW_REQUIRED" ? "review" : "ok";
          if (st.id === "verify" && seen.has("postcondition")) cls = "ok";
          if (st.id === "finalValidation" && seen.has("finalValidation") && seen.has("notSigned")) cls = "review";
          if (stopped && i > lastIdx) cls = "skipped";
        }
        const [x, y] = PTS[i];
        const glyph = cls === "stop" ? "✕" : cls === "review" ? "!" : cls === "ok" || cls === "done" ? "✓" : String(i + 1);
        const numCls = cls === "active" ? "on" : cls === "ok" ? "ok" : cls === "stop" ? "stop" : cls === "done" ? "done" : cls === "review" ? "on" : "";
        return (
          <g key={st.id}>
            <circle cx={x} cy={y} r="17" className={`node ${cls}`} />
            <text x={x} y={y} className={`nnum ${numCls}`}>{glyph}</text>
            <text x={x} y={y + (y > 100 ? 40 : -30)} className={`nlabel ${cls === "skipped" ? "skipped" : ""}`}>{st.label}</text>
          </g>
        );
      })}
      {stopped && lastIdx >= 3 && <text x={PTS[3][0] + 30} y={PTS[3][1] + 50} className="note">stops here — nothing is signed</text>}
    </svg>
  );
}
