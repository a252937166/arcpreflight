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

describe("review of bf0c800 · one immutable client per operation (P1); renewals reuse another tab's replacement (P2); a session that owns records is never replaced (W10)", () => {
  const PAYER = "0x0000000000000000000000000000000000000a11";
  it("P1: an operation finishes on the instance it started on — the testnet session resolving after the visitor switched to the root instance sends its order to /testnet, never to the new instance; a 401 met after the switch is renewed and retried on /testnet", async () => {
    const paths: string[] = []; let release!: (r: Response) => void; let testnetSessions = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      paths.push(path);
      if (path === "/testnet/v1/session" && init?.method === "POST") { testnetSessions++; return testnetSessions === 1 ? new Promise<Response>((r) => { release = r; }) : response({ principal: "visitor:t2", token: "t2" }, 201); }
      if (path === "/v1/session") return response({ principal: "visitor:main", token: "main-token" }, 201);
      if (path === "/testnet/v1/demo/orders") return response({ orderId: "0x01", state: "CONFIRMED" }, 201);
      if (path === "/testnet/v1/demo/runs?limit=20&offset=0") return response({ runs: [] });
      throw new Error(`reached the wrong instance: ${path}`);
    }));
    setApiBase("/testnet");
    const pending = withSession((t, c) => c.createOrder({ payer: PAYER, proxy: "MAIN" }, t));
    await new Promise((r) => setTimeout(r, 0));
    setApiBase(""); // the visitor switched to the mainnet instance while the testnet session was still being created
    release(response({ principal: "visitor:test", token: "test-token" }, 201));
    await expect(pending).resolves.toMatchObject({ orderId: "0x01" });
    expect(paths).toEqual(["/testnet/v1/session", "/testnet/v1/demo/orders"]); // the order went where the operation started; nothing reached the new instance
    // a 401 arriving after a switch: renewed on the SAME instance and the call retried there, with the stored session replaced there
    setApiBase("/testnet"); store.set("arcpreflight.session:/testnet", JSON.stringify({ principal: "visitor:old", token: "old" })); paths.length = 0;
    const late = withSession(async (t, c) => { if (t === "old") { setApiBase(""); throw new ApiError(401, { error: "UNAUTHENTICATED" }); } return c.runs(); });
    await expect(late).resolves.toMatchObject({ runs: [] });
    expect(paths).toEqual(["/testnet/v1/session", "/testnet/v1/demo/runs?limit=20&offset=0"]);
    expect(JSON.parse(store.get("arcpreflight.session:/testnet")!).token).toBe("t2"); expect(storedSession("")).toBeNull(); // nothing was created on the new instance
  });
  it("P1 reproduction: two operations on different instances at once each keep their own client — the shared pin stack used to send the earlier operation's request to the later operation's instance", async () => {
    const paths: string[] = []; let releaseA!: (r: Response) => void; let releaseB!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      paths.push(path);
      if (path === "/v1/session" && init?.method === "POST") return new Promise<Response>((r) => { releaseA = r; });
      if (path === "/testnet/v1/session" && init?.method === "POST") return new Promise<Response>((r) => { releaseB = r; });
      if (path === "/v1/demo/orders") return response({ orderId: "0xA", state: "CONFIRMED" }, 201);
      if (path === "/testnet/v1/demo/orders") return response({ orderId: "0xB", state: "CONFIRMED" }, 201);
      throw new Error(`unexpected ${path}`);
    }));
    setApiBase(""); const a = withSession((t, c) => c.createOrder({ payer: PAYER, proxy: "MAIN" }, t)); await new Promise((r) => setTimeout(r, 0)); // A starts on the root instance (its session is slow)
    setApiBase("/testnet"); const b = withSession((t, c) => c.createOrder({ payer: PAYER, proxy: "MAIN" }, t)); await new Promise((r) => setTimeout(r, 0)); // the visitor switched; B starts on testnet (slow too)
    releaseA(response({ principal: "visitor:a", token: "a" }, 201)); // A's session lands while B is in flight on the other instance
    await expect(a).resolves.toMatchObject({ orderId: "0xA" }); // A's order went to A's instance …
    releaseB(response({ principal: "visitor:b", token: "b" }, 201));
    await expect(b).resolves.toMatchObject({ orderId: "0xB" }); // … and B's to B's
    expect(paths.filter((p) => p.endsWith("/demo/orders"))).toEqual(["/v1/demo/orders", "/testnet/v1/demo/orders"]);
    expect(JSON.parse(store.get("arcpreflight.session:root")!).token).toBe("a"); expect(JSON.parse(store.get("arcpreflight.session:/testnet")!).token).toBe("b");
  });
  it("P1 reproduction (the reviewer's scenario): an operation past its session boundary keeps its instance for its later requests even after another operation pinned the newly selected instance", async () => {
    const paths: string[] = []; let gateB!: () => void; const gate = new Promise<void>((r) => { gateB = r; });
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      paths.push(path);
      if (path.endsWith("/v1/session") && init?.method === "POST") return response({ principal: `visitor:${path}`, token: `tok:${path}` }, 201);
      if (path.endsWith("/v1/wallet/attempts")) return response({ attempts: [] });
      if (path.endsWith("/v1/demo/runs?limit=20&offset=0")) return response({ runs: [] });
      throw new Error(`unexpected ${path}`);
    }));
    setApiBase("/testnet");
    const b = withSession(async (t, c) => { await c.attempts(t); await gate; await c.attempts(t); return "b"; }); // B: two requests on testnet with a pause between them
    await new Promise((r) => setTimeout(r, 0));
    setApiBase(""); const a = withSession(async (t, c) => c.runs()); await new Promise((r) => setTimeout(r, 0)); // the visitor switched to root and started A there
    gateB(); await expect(b).resolves.toBe("b"); await a;
    expect(paths.filter((p) => p.endsWith("/v1/wallet/attempts"))).toEqual(["/testnet/v1/wallet/attempts", "/testnet/v1/wallet/attempts"]); // B's second request stayed on B's instance (the shared pin stack used to send it to root)
    expect(paths.filter((p) => p.endsWith("offset=0"))).toEqual(["/v1/demo/runs?limit=20&offset=0"]);
  });
  it("P2: a delayed 401 for the OLD token after another tab already stored a replacement reuses that replacement — no second renewal, the valid session is never overwritten; without a replacement exactly one renewal; concurrent 401s in one tab share it", async () => {
    fakeApi(); store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:old", token: "vs_old" }));
    const seen: string[] = [];
    // this tab's request with the old token comes back 401 AFTER another tab renewed and stored vs_B
    const result = await withSession(async (t) => { seen.push(t); if (t === "vs_old") { store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:B", token: "vs_B" })); throw new ApiError(401, { error: "UNAUTHENTICATED" }); } return `ok:${t}`; });
    expect(result).toBe("ok:vs_B"); expect(seen).toEqual(["vs_old", "vs_B"]); expect(posts).toEqual([]); // reused, not renewed
    expect(JSON.parse(store.get("arcpreflight.session:root")!).token).toBe("vs_B");
    // control: no replacement anywhere → one renewal
    store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:old2", token: "vs_old2" })); resetSessions();
    expect(await withSession(async (t) => { if (t === "vs_old2") throw new ApiError(401, { error: "UNAUTHENTICATED" }); return t; })).toBe("vs_1"); expect(posts).toHaveLength(1);
    // concurrent variant: three calls of this tab meet the dead token at once → ONE renewal, all three retried with it
    store.set("arcpreflight.session:root", JSON.stringify({ principal: "visitor:old3", token: "vs_old3" })); resetSessions();
    const three = await Promise.all([1, 2, 3].map(() => withSession(async (t) => { if (t === "vs_old3") throw new ApiError(401, { error: "UNAUTHENTICATED" }); return t; })));
    expect(three).toEqual(["vs_2", "vs_2", "vs_2"]); expect(posts).toHaveLength(2);
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
