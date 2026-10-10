import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFor, setApiBase } from "../src/lib/api";
import { startDemo } from "../src/lib/demo";
import { runKeyFor, takePendingKey } from "../src/lib/runKeys";

// Review of 0d1088e (P1): the admission-key storage of a Demo start — the pending key taken, set, remembered and cleared — belongs to the
// instance captured at the click. A late answer must never clear ANOTHER instance's pending key: that key is what makes the next click there
// return the original run instead of starting a second one.
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const RUN = { runId: "run-t", fixture: "APPROVED_PAYMENT", state: "RUNNING", labels: [], steps: [], result: null, recovery: null };
let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  store = new Map(); vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  setApiBase("");
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setApiBase(""); });
const pending = (scope: string) => JSON.parse(store.get(`arcpreflight.pendingRunKeys:${scope}`) ?? "{}");

describe("admission keys are bound to the instance captured at the click", () => {
  it("reproduction: a testnet start whose answer lands after the visitor switched to root keeps root's pending key, remembers the run under testnet, and the next root click re-uses root's pending key (the original run, never a second one)", async () => {
    store.set("arcpreflight.pendingRunKeys:root", JSON.stringify({ APPROVED_PAYMENT: { key: "root-pending", at: Date.now() } })); // a root start whose answer was lost earlier
    const posts: { path: string; key: string }[] = []; let release!: (r: Response) => void; let testnetPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/v1/demo/run") && init?.method === "POST") {
        const key = JSON.parse(init.body as string).clientRunRequestId; posts.push({ path, key });
        if (path.startsWith("/testnet")) { if (++testnetPosts === 1) throw new TypeError("network dropped after the request left"); return new Promise<Response>((r) => { release = r; }); }
        return response({ runId: "run-root", poll: "/v1/demo/runs/run-root", admission: "existing" }, 200);
      }
      throw new Error(`unexpected ${path}`);
    }));
    setApiBase("/testnet");
    const started = startDemo("APPROVED_PAYMENT", undefined, {}, apiFor("/testnet")); // the click on testnet: new key, pending on TESTNET
    await vi.advanceTimersByTimeAsync(0);
    expect(pending("/testnet").APPROVED_PAYMENT?.key).toBe(posts[0].key); expect(pending("root").APPROVED_PAYMENT?.key).toBe("root-pending");
    setApiBase(""); // the visitor switched to root while the retry was pending
    release(response({ runId: "run-t", poll: "/testnet/v1/demo/runs/run-t", admission: "existing" }, 200));
    expect(await started).toMatchObject({ mode: "live", runId: "run-t", key: posts[0].key });
    expect(posts.map((p) => p.path)).toEqual(["/testnet/v1/demo/run", "/testnet/v1/demo/run"]); expect(posts[1].key).toBe(posts[0].key);
    expect(pending("/testnet").APPROVED_PAYMENT).toBeUndefined(); // testnet's pending key is cleared (that operation finished) …
    expect(pending("root").APPROVED_PAYMENT?.key).toBe("root-pending"); // … root's is untouched (the old code cleared the key of the instance selected at that moment)
    expect(runKeyFor("run-t", "/testnet")).toBe(posts[0].key); expect(runKeyFor("run-t", "")).toBeNull(); // remembered under the instance that admitted it
    const root = await startDemo("APPROVED_PAYMENT", undefined, {}, apiFor("")); // the next click on root: the lost start's key is re-sent, so root returns ITS original run
    expect(posts.at(-1)).toEqual({ path: "/v1/demo/run", key: "root-pending" }); expect(root).toMatchObject({ runId: "run-root", admission: "existing" });
    expect(takePendingKey("APPROVED_PAYMENT", "")).toBeNull();
  });
  it("control and concurrent variant: two instances started at once each keep their own key; a newer start on an instance is never cleared by an older start's late answer", async () => {
    const posts: { path: string; key: string }[] = []; const held: Record<string, ((r: Response) => void)[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const key = JSON.parse(init!.body as string).clientRunRequestId; posts.push({ path, key });
      return new Promise<Response>((r) => { (held[path + ":" + key] ??= []).push(r); });
    }));
    const answer = (id: string, body: unknown, status: number) => { for (const r of held[id] ?? []) r(response(body, status)); };
    const a = startDemo("APPROVED_PAYMENT", undefined, {}, apiFor("/testnet")); const b = startDemo("APPROVED_PAYMENT", undefined, {}, apiFor("")); await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(2); expect(posts[0].key).not.toBe(posts[1].key);
    expect(pending("/testnet").APPROVED_PAYMENT?.key).toBe(posts[0].key); expect(pending("root").APPROVED_PAYMENT?.key).toBe(posts[1].key);
    // a NEWER testnet click (the first one's answer is still pending, so it re-uses the same pending key — one key per unfinished start)
    const a2 = startDemo("APPROVED_PAYMENT", undefined, {}, apiFor("/testnet")); await vi.advanceTimersByTimeAsync(0);
    expect(posts[2]).toEqual({ path: "/testnet/v1/demo/run", key: posts[0].key });
    answer("/v1/demo/run:" + posts[1].key, { runId: "run-root", admission: "new" }, 202); expect(await b).toMatchObject({ runId: "run-root" });
    expect(pending("root").APPROVED_PAYMENT).toBeUndefined(); expect(pending("/testnet").APPROVED_PAYMENT?.key).toBe(posts[0].key); // root done, testnet still pending
    answer("/testnet/v1/demo/run:" + posts[0].key, { runId: "run-t", admission: "new" }, 202);
    expect(await a).toMatchObject({ runId: "run-t" }); expect(await a2).toMatchObject({ runId: "run-t" });
    expect(runKeyFor("run-t", "/testnet")).toBe(posts[0].key); expect(runKeyFor("run-root", "")).toBe(posts[1].key);
  });
});
