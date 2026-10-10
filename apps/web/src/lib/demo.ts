import { api, ApiError, type ApiClient, type Fixture, type Run } from "./api";
import { clearPendingKey, newRunKey, rememberRunKey, setPendingKey, takePendingKey } from "./runKeys";

export type DemoStart = { mode: "live"; runId: string; admission: "new" | "existing"; key: string } | { mode: "sample"; run: Run; reason: string; body: any };

/** Idempotent start (design §10.1): one admission key per click, re-sent verbatim on retry. A transport failure after the
 *  request left means the run MAY have been admitted, so the retry carries the same key and can only get that run back.
 *  Budget/cooldown/dependency refusals carry a recorded run even though their HTTP status is an error. */
export type DemoOptions = { interruptAfterBroadcast?: boolean };
/** `interruptAfterBroadcast` (v3.3 §4): the runner persists, marks and sends as always, then stops waiting — the labelled interruption the
 *  recovery worker resolves from the recorded hash and the order state. Effective for APPROVED_PAYMENT only; the admission key rules are unchanged. */
export async function startDemo(fixture: Fixture, explicitKey?: string, opts: DemoOptions = {}, client: ApiClient = api): Promise<DemoStart> {
  // review of bf0c800 (P1): the whole operation — the request, the retry after a lost answer and the sample read — uses the client it was
  // handed at the click, bound to the instance selected then; a switch meanwhile never redirects the retry (the same key on another instance
  // would start a second run there). Review of 0d1088e (P1): the key storage follows the same instance — the pending key is taken from, set
  // on, remembered for and cleared on `base`, so an answer landing after a switch never deletes ANOTHER instance's pending key (which would let
  // the next click there start a second run instead of returning the original one).
  const base = client.base;
  const key = explicitKey ?? takePendingKey(fixture, base) ?? newRunKey();
  setPendingKey(fixture, key, base);
  let response;
  try { response = await client.startRun(fixture, key, opts); }
  catch (error) {
    if (error instanceof ApiError) {
      if (![429, 503].includes(error.status) || !error.body?.sampleRunId) throw error;
      response = error.body;
    } else {
      response = await client.startRun(fixture, key, opts); // lost response: same key, never a new one, same instance
    }
  }
  if (response.runId) {
    rememberRunKey(response.runId, key, base); clearPendingKey(fixture, base, key);
    return { mode: "live", runId: response.runId, admission: response.admission === "existing" ? "existing" : "new", key };
  }
  clearPendingKey(fixture, base, key);
  const reason = [response.error, response.reason].filter(Boolean).join(": ") || "Live run unavailable";
  if (!response.sampleRunId) throw new Error(reason);
  return { mode: "sample", run: await client.run(response.sampleRunId), reason, body: response };
}
