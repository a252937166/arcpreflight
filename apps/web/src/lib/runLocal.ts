// What this browser did with a run's passport (export, verification state), kept by the page for the guide — and guarded: a callback that
// arrives for a run that is no longer on screen (a download that resolved after the visitor switched runs) is dropped, never written over
// the current run's state (review 2026-10-09). The panel itself drops results after it unmounted; this is the parent's side of the same rule.
import { useCallback, useRef, useState } from "react";

export type RunLocal = { runId: string; exported: boolean; verified: "passed" | "failed" | "partial" | null };
export function useRunLocal(currentRunId: string | null) {
  const [local, setLocal] = useState<RunLocal | null>(null);
  const current = useRef(currentRunId); current.current = currentRunId;
  const onLocal = useCallback((runId: string, l: { exported: boolean; verified: RunLocal["verified"] }) => { if (runId !== current.current) return; setLocal({ runId, ...l }); }, []);
  const reset = useCallback(() => setLocal(null), []);
  return { local: local && local.runId === currentRunId ? local : null, onLocal, reset };
}
