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

describe("audit 2026-10-10 · an operation stays on its instance (W01); a session that owns records is never replaced (W10)", () => {
  it("W01: the testnet session resolving after the selected instance changed does not send the pending order to the new instance, and a 401 is never retried across instances", async () => {
    const { api } = await import("../src/lib/api");
    const paths: string[] = []; let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      paths.push(path);
      if (path === "/testnet/v1/session") return new Promise<Response>((r) => { release = r; });
      if (path === "/v1/session") return response({ principal: "visitor:main", token: "main-token" }, 201);
      if (path.endsWith("/v1/demo/orders")) return response({ orderId: "0x01", state: "CONFIRMED" }, 201);
      throw new Error(`unexpected ${path}`);
    }));
    setApiBase("/testnet");
    const pending = withSession((t) => api.createOrder({ payer: "0x0000000000000000000000000000000000000a11", proxy: "MAIN" }, t));
    await new Promise((r) => setTimeout(r, 0));
    setApiBase(""); // the visitor switched to the mainnet instance while the testnet session was still being created
    release(response({ principal: "visitor:test", token: "test-token" }, 201));
    await expect(pending).rejects.toMatchObject({ name: "InstanceChangedError" });
    expect(paths).toEqual(["/testnet/v1/session"]); // nothing was sent anywhere else: no order on the new instance, no new-instance session
    // the same for a 401 arriving after a switch: the retry never goes to the new instance
    setApiBase("/testnet"); store.set("arcpreflight.session:/testnet", JSON.stringify({ principal: "visitor:old", token: "old" })); paths.length = 0;
    const late = withSession(async (t) => { setApiBase(""); throw new ApiError(401, { error: "UNAUTHENTICATED", token: t }); });
    await expect(late).rejects.toMatchObject({ name: "InstanceChangedError" });
    expect(paths).toEqual([]);
  });
  it("W01: a request issued while an operation is pinned goes to the pinned base even if the global base moved, or is refused — never silently redirected", async () => {
    const { api, pinBase } = await import("../src/lib/api");
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => { paths.push(path); return response({ runs: [] }); }));
    setApiBase("/testnet"); const unpin = pinBase("/testnet");
    await api.runs(); expect(paths).toEqual(["/testnet/v1/demo/runs?limit=20&offset=0"]);
    setApiBase("");
    await expect(api.runs()).rejects.toMatchObject({ name: "InstanceChangedError" }); unpin();
    await api.runs(); expect(paths.at(-1)).toBe("/v1/demo/runs?limit=20&offset=0"); // unpinned: the current instance again
  });
  it("W10: two fresh tabs creating a session at once end with ONE stored principal; the later writer adopts the stored session instead of overwriting it", async () => {
    let n = 0; let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/v1/session") && init?.method === "POST") { n++; return n === 1 ? new Promise<Response>((r) => { release = r; }) : response({ principal: `visitor:${n}`, token: `vs_${n}` }, 201); }
      throw new Error(`unexpected ${path}`);
    }));
    const a = getSession(); // tab A: its creation is slow
    await new Promise((r) => setTimeout(r, 0));
    store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:B", token: "vs_B" })); // tab B created and stored its session meanwhile
    release(response({ principal: "visitor:A", token: "vs_A" }, 201));
    expect(await a).toEqual({ principal: "visitor:B", token: "vs_B" }); // A adopts B's: one principal for both tabs
    expect(JSON.parse(store.get("arcpreflight.session:root")!)).toEqual({ principal: "visitor:B", token: "vs_B" });
    expect(await withSession(async (t) => t)).toBe("vs_B");
  });
});
