import { api, ApiError, type Fixture, type Run } from "./api";
import { clearPendingKey, newRunKey, rememberRunKey, setPendingKey, takePendingKey } from "./runKeys";

export type DemoStart = { mode: "live"; runId: string; admission: "new" | "existing"; key: string } | { mode: "sample"; run: Run; reason: string; body: any };

/** Idempotent start (design §10.1): one admission key per click, re-sent verbatim on retry. A transport failure after the
 *  request left means the run MAY have been admitted, so the retry carries the same key and can only get that run back.
 *  Budget/cooldown/dependency refusals carry a recorded run even though their HTTP status is an error. */
export type DemoOptions = { interruptAfterBroadcast?: boolean };
/** `interruptAfterBroadcast` (v3.3 §4): the runner persists, marks and sends as always, then stops waiting — the labelled interruption the
 *  recovery worker resolves from the recorded hash and the order state. Effective for APPROVED_PAYMENT only; the admission key rules are unchanged. */
export async function startDemo(fixture: Fixture, key: string = takePendingKey(fixture) ?? newRunKey(), opts: DemoOptions = {}): Promise<DemoStart> {
  setPendingKey(fixture, key);
  let response;
  try { response = await api.startRun(fixture, key, opts); }
  catch (error) {
    if (error instanceof ApiError) {
      if (![429, 503].includes(error.status) || !error.body?.sampleRunId) throw error;
      response = error.body;
    } else {
      response = await api.startRun(fixture, key, opts); // lost response: same key, never a new one
    }
  }
  if (response.runId) {
    rememberRunKey(response.runId, key); clearPendingKey(fixture);
    return { mode: "live", runId: response.runId, admission: response.admission === "existing" ? "existing" : "new", key };
  }
  clearPendingKey(fixture);
  const reason = [response.error, response.reason].filter(Boolean).join(": ") || "Live run unavailable";
  if (!response.sampleRunId) throw new Error(reason);
  return { mode: "sample", run: await api.run(response.sampleRunId), reason, body: response };
}
