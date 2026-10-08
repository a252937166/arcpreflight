import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setApiBase } from "../src/lib/api";
import { forgetSession, getSession, resetSessions, sessionKey, storedSession, withSession } from "../src/lib/session";

// The anonymous browser session against a fake API: created lazily, once, per instance; replaced once after a 401.
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let store: Map<string, string>; let posts: string[];
function fakeApi(opts: { fail?: boolean } = {}) {
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/v1/session") && init?.method === "POST") { posts.push(path); if (opts.fail) return response({ error: "RATE_LIMITED", reason: "at most 10 new sessions per client per day" }, 429); return response({ principal: `visitor:${++n}`, token: `vs_${n}` }, 201); }
    throw new Error(`Unexpected URL: ${path}`);
  }));
}
beforeEach(() => {
  store = new Map(); posts = [];
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  resetSessions(); setApiBase("");
});
afterEach(() => { vi.unstubAllGlobals(); resetSessions(); setApiBase(""); });

describe("anonymous session", () => {
  it("creates one session on first use — even for concurrent callers — stores it per instance and reuses it", async () => {
    fakeApi();
    expect(storedSession()).toBeNull();
    const [a, b] = await Promise.all([getSession(), getSession()]);
    expect(a).toEqual({ principal: "visitor:1", token: "vs_1" }); expect(b).toEqual(a); expect(posts).toEqual(["/v1/session"]);
    expect(JSON.parse(store.get("arcpreflight.session:root")!)).toEqual(a);
    expect(await withSession(async (t) => t)).toBe("vs_1"); expect(posts).toHaveLength(1);
    resetSessions(); // a new page load: the stored session is picked up, nothing is created
    expect(await getSession()).toEqual(a); expect(posts).toHaveLength(1);
  });
  it("replaces the session once after a 401 and retries the call; a second 401 or any other error passes through", async () => {
    fakeApi(); store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:old", token: "vs_old" }));
    const seen: string[] = [];
    const result = await withSession(async (t) => { seen.push(t); if (t === "vs_old") throw new ApiError(401, { error: "UNAUTHENTICATED" }); return `ok:${t}`; });
    expect(result).toBe("ok:vs_1"); expect(seen).toEqual(["vs_old", "vs_1"]); expect(posts).toHaveLength(1);
    expect(JSON.parse(store.get("arcpreflight.session:root")!).token).toBe("vs_1");
    await expect(withSession(async () => { throw new ApiError(401, { error: "UNAUTHENTICATED" }); })).rejects.toMatchObject({ status: 401 });
    expect(posts).toHaveLength(2); // replaced once more, then the second 401 surfaced
    await expect(withSession(async () => { throw new ApiError(429, { error: "RATE_LIMITED" }); })).rejects.toMatchObject({ status: 429 });
    expect(posts).toHaveLength(2); // other errors never touch the session
  });
  it("is scoped per API instance: the testnet instance gets its own session under its own key, through its own path", async () => {
    fakeApi();
    const root = await getSession(); setApiBase("/testnet");
    expect(storedSession()).toBeNull(); expect(sessionKey()).toBe("arcpreflight.session:/testnet");
    const testnet = await getSession();
    expect(testnet.token).not.toBe(root.token); expect(posts).toEqual(["/v1/session", "/testnet/v1/session"]);
    expect(JSON.parse(store.get("arcpreflight.session:/testnet")!)).toEqual(testnet); expect(JSON.parse(store.get("arcpreflight.session:root")!)).toEqual(root);
    forgetSession(); expect(storedSession()).toBeNull(); setApiBase(""); expect(storedSession()).toEqual(root);
  });
  it("lives in memory for this page when storage is unavailable, and surfaces the API's refusal to issue one", async () => {
    fakeApi(); vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    const s = await getSession(); expect(await getSession()).toEqual(s); expect(posts).toHaveLength(1);
    resetSessions(); fakeApi({ fail: true });
    await expect(getSession()).rejects.toMatchObject({ status: 429 });
  });
});
