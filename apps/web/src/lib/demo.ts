import { api, ApiError, type Fixture, type Run } from "./api";

export type DemoStart = { mode: "live"; runId: string } | { mode: "sample"; run: Run; reason: string };

/** Budget/cooldown/dependency failures carry a recorded run even though their HTTP status is an error. */
export async function startDemo(fixture: Fixture): Promise<DemoStart> {
  let response;
  try { response = await api.startRun(fixture); }
  catch (error) {
    if (!(error instanceof ApiError) || ![429, 503].includes(error.status) || !error.body?.sampleRunId) throw error;
    response = error.body;
  }
  if (response.runId) return { mode: "live", runId: response.runId };
  const reason = [response.error, response.reason].filter(Boolean).join(": ") || "Live run unavailable";
  if (!response.sampleRunId) throw new Error(reason);
  return { mode: "sample", run: await api.run(response.sampleRunId), reason };
}
