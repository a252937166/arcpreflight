// The sense -> decide -> act -> verify loop as a pipeline. Driven by the step names emitted by the runner.
export const STAGES = [
  { id: "createOrder", n: "1", label: "Approved order", steps: ["createOrder"] },
  { id: "intent", n: "2", label: "Exact intent", steps: ["intent"] },
  { id: "report", n: "3", label: "Pinned report (x402)", steps: ["quote", "staleObservation", "signServiceFee", "settlementPending", "reportDelivered"] },
  { id: "decision", n: "4", label: "Deterministic decision", steps: ["decision"] },
  { id: "finalValidation", n: "5", label: "Final validation", steps: ["finalValidation"] },
  { id: "sign", n: "6", label: "Sign exact plan", steps: ["signed"] },
  { id: "broadcast", n: "7", label: "Broadcast", steps: ["broadcast"] },
  { id: "verify", n: "8", label: "Verify outcome", steps: ["postcondition"] },
] as const;

export function Pipeline({ steps, decision, running, idle }: { steps?: { step: string }[]; decision?: string | null; running?: boolean; idle?: boolean }) {
  const seen = new Set((steps ?? []).map((s) => s.step));
  const stopped = seen.has("notSigned") || seen.has("error");
  let lastIdx = -1;
  STAGES.forEach((st, i) => { if (st.steps.some((x) => seen.has(x))) lastIdx = i; });
  return (
    <div className="pipeline">
      {idle && <div className="beam" />}
      {STAGES.map((st, i) => {
        let cls = "";
        if (!idle) {
          if (i < lastIdx || (i === lastIdx && !running)) cls = "done";
          if (i === lastIdx && running) cls = "active";
          if (st.id === "decision" && seen.has("decision")) cls = decision === "BLOCKED" ? "stop" : decision === "REVIEW_REQUIRED" ? "review" : "ok";
          if (st.id === "verify" && seen.has("postcondition")) cls = "ok";
          if (stopped && i > lastIdx) cls = "skipped";
          if (st.id === "finalValidation" && seen.has("finalValidation") && seen.has("notSigned")) cls = "review";
        }
        return (
          <div key={st.id} className={`pnode ${cls}`}>
            <div className="ring">{cls === "stop" ? "✕" : cls === "review" ? "⚠" : cls === "ok" || cls === "done" ? "✓" : st.n}</div>
            <div className="label">{st.label}</div>
          </div>
        );
      })}
    </div>
  );
}
