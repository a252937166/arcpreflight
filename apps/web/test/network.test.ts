import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverInstances, readChoice, selectInstance, toggleVisible, withNet, landingFor, networkNotice, availableNetworks, netParam, persistChoice, type Instance } from "../src/lib/network";
import { api, apiPath, getApiBase, passportUrl, setApiBase } from "../src/lib/api";
import { scopedKey } from "../src/lib/storage";
import { rememberRunKey, runKeyFor } from "../src/lib/runKeys";
import { rememberCheck, rememberedChecks } from "../src/lib/checks";

// The dual-network switch (design v3.2 §4.7): labels come from what an instance reports, never from the path.
const root: Instance = { base: "", network: "mainnet", chainId: 5042, caip2: "eip155:5042", release: "r1" };
const test: Instance = { base: "/testnet", network: "testnet", chainId: 5042002, caip2: "eip155:5042002", release: "r2" };
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  setApiBase("");
});
afterEach(() => { vi.unstubAllGlobals(); setApiBase(""); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("instance discovery", () => {
  it("keeps every instance that answers with a recognisable network and drops the ones that fail, 404 or answer nonsense", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "/v1/network") return json({ network: "mainnet", chainId: 5042, caip2: "eip155:5042", release: "r1" });
      if (url === "/testnet/v1/network") throw new TypeError("Failed to fetch");
      return json({ error: "NOT_FOUND" }, 404);
    });
    expect(await discoverInstances(fetch as any)).toEqual([root]);
    const nonsense = vi.fn(async (url: string) => (url === "/v1/network" ? json({ network: "devnet", chainId: 1 }) : json({ network: "testnet", chainId: 5042002, caip2: "eip155:5042002", release: "r2" })));
    expect(await discoverInstances(nonsense as any)).toEqual([test]);
    const none = vi.fn(async () => json("<html>", 502));
    expect(await discoverInstances(none as any)).toEqual([]);
  });
  it("resolves ?net= first, then the remembered choice, then mainnet", () => {
    expect(readChoice("")).toBe("mainnet");
    persistChoice("testnet"); expect(storage.get("arcpreflight.net")).toBe("testnet");
    expect(readChoice("")).toBe("testnet");
    expect(readChoice("?net=mainnet&fixture=X")).toBe("mainnet");
    expect(readChoice("?net=devnet")).toBe("testnet"); // an unknown value is ignored, not trusted
    expect(netParam("?net=testnet")).toBe("testnet"); expect(netParam("?x=1")).toBeNull();
  });
  it("selects the instance that REPORTS the chosen network, prefers the root on a tie, and falls back to the root with its real network", () => {
    expect(selectInstance([root, test], "testnet")).toBe(test);
    expect(selectInstance([root, test], "mainnet")).toBe(root);
    const preview: Instance = { ...root, network: "testnet", chainId: 5042002, caip2: "eip155:5042002" }; // the root before the cutover
    expect(selectInstance([preview, test], "testnet")).toBe(preview);
    expect(selectInstance([preview, test], "mainnet")).toBe(preview); // nobody serves mainnet: the root, shown as what it is
    expect(selectInstance([test], "mainnet")).toBe(test);
    expect(selectInstance([], "mainnet")).toBeNull();
  });
  it("shows the toggle only when two different networks answer", () => {
    expect(toggleVisible([root, test])).toBe(true);
    expect(toggleVisible([root])).toBe(false);
    expect(toggleVisible([{ ...root, network: "testnet" }, test])).toBe(false); // both testnet: the pill alone
    expect(availableNetworks([test, root])).toEqual(["mainnet", "testnet"]);
  });
  it("tells the selected instance's story from what it reports", () => {
    const testnetNet: any = { network: "testnet", capabilities: [] };
    expect(networkNotice(testnetNet, [root, test])!.text).toMatch(/zero-cost demos .* mainnet proof lives on the mainnet side/);
    expect(networkNotice(testnetNet, [{ ...root, network: "testnet" }])!.text).toMatch(/testnet preview — mainnet is the release target/);
    expect(networkNotice({ network: "mainnet", capabilities: [{ id: "x", label: "", status: "IMPLEMENTED_TESTNET" }] } as any, [root, test])!.text).toMatch(/acceptance evidence pending/);
    expect(networkNotice({ network: "mainnet", capabilities: [{ id: "x", label: "", status: "MAINNET_VERIFIED" }] } as any, [root, test])).toBeNull();
    expect(networkNotice(null, [root])).toBeNull();
  });
});

describe("links and API base", () => {
  it("withNet appends ?net=<reported network> only off the root, preserving existing query strings", () => {
    expect(withNet("/runs/abc", root)).toBe("/runs/abc");
    expect(withNet("/runs/abc", null)).toBe("/runs/abc");
    expect(withNet("/runs/abc", test)).toBe("/runs/abc?net=testnet");
    expect(withNet("/demo?fixture=APPROVED_PAYMENT", test)).toBe("/demo?fixture=APPROVED_PAYMENT&net=testnet");
    expect(landingFor("/runs/abc")).toBe("/demo"); expect(landingFor("/subjects/0x1")).toBe("/inspect"); expect(landingFor("/verify")).toBe("/verify");
  });
  it("prefixes every API call with the selected base, including passport links", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return json({ runs: [], total: 0 }); }));
    await api.runs(12, 0); await api.network();
    setApiBase("/testnet");
    await api.runs(12, 0); await api.run("r1"); await api.requests("t"); await api.health();
    expect(calls).toEqual(["/v1/demo/runs?limit=12&offset=0", "/v1/network", "/testnet/v1/demo/runs?limit=12&offset=0", "/testnet/v1/demo/runs/r1", "/testnet/v1/requests", "/testnet/health/ready"]);
    expect(apiPath("/openapi.json")).toBe("/testnet/openapi.json"); expect(passportUrl("r1")).toBe("/testnet/v1/demo/runs/r1/passport"); expect(getApiBase()).toBe("/testnet");
  });
});

describe("per-instance storage", () => {
  it("scopes keys by base and migrates a pre-P2 value once into the root scope", () => {
    storage.set("arcpreflight.runKeys", JSON.stringify({ old: "k-old" }));
    expect(scopedKey("arcpreflight.runKeys")).toBe("arcpreflight.runKeys:root");
    expect(storage.get("arcpreflight.runKeys:root")).toBe(JSON.stringify({ old: "k-old" })); expect(storage.has("arcpreflight.runKeys")).toBe(false);
    expect(runKeyFor("old")).toBe("k-old");
    setApiBase("/testnet");
    expect(scopedKey("arcpreflight.runKeys")).toBe("arcpreflight.runKeys:/testnet");
    expect(runKeyFor("old")).toBeNull(); // another instance's records never leak across
    rememberRunKey("new", "k-new");
    expect(JSON.parse(storage.get("arcpreflight.runKeys:/testnet")!)).toEqual({ new: "k-new" });
    expect(storage.get("arcpreflight.runKeys:root")).toBe(JSON.stringify({ old: "k-old" }));
  });
  it("remembered checks move from the pre-P2 name into the root scope and stay per instance", () => {
    storage.set("arcpreflight.myChecks", JSON.stringify({ r1: { requestId: "r1", createdAt: "2026-10-08T00:00:00.000Z", subject: null, valueNativeAtomic: null } }));
    expect(rememberedChecks().map((c) => c.requestId)).toEqual(["r1"]);
    expect(storage.has("arcpreflight.myChecks")).toBe(false); expect(storage.has("arcpreflight.checks:root")).toBe(true);
    setApiBase("/testnet");
    expect(rememberedChecks()).toEqual([]);
    rememberCheck({ requestId: "r2", createdAt: "2026-10-08T00:00:01.000Z", subject: null, valueNativeAtomic: null });
    expect(rememberedChecks().map((c) => c.requestId)).toEqual(["r2"]);
  });
  it("tokens are scoped by network with the legacy token moved to the first scope read", () => {
    storage.set("arcpreflight.trialToken", "tok-legacy");
    expect(scopedKey("arcpreflight.trialToken", "testnet", { migrateTo: "testnet" })).toBe("arcpreflight.trialToken:testnet");
    expect(storage.get("arcpreflight.trialToken:testnet")).toBe("tok-legacy"); expect(storage.has("arcpreflight.trialToken")).toBe(false);
    expect(storage.get("arcpreflight.trialToken:mainnet")).toBeUndefined();
  });
});

describe("project funds (operator decision 2026-10-09)", async () => {
  const { fundsSummary, fundsWarning } = await import("../src/lib/funds");
  it("summarises the worker's reading, names the low keys, and says nothing before the first reading", () => {
    const net: any = { network: "testnet", funds: { checkedAt: "2026-10-09T10:00:00.000Z", intervalMs: 300000, low: true, note: "reads only", keys: [
      { role: "demo-runner", address: "0x00000000000000000000000000000000000000a1", balanceNativeAtomic: "16885600000000000000", warnBelowNativeAtomic: "1000000000000000000", low: false, note: "runs" },
      { role: "order-creator", address: "0x00000000000000000000000000000000000000a2", balanceNativeAtomic: "1500000000000000000", warnBelowNativeAtomic: "2000000000000000000", low: true, note: "orders + faucet" },
      { role: "merchant-payto", address: "0x00000000000000000000000000000000000000a3", balanceNativeAtomic: null, warnBelowNativeAtomic: "500000000000000000", low: false, note: "fee relay" } ] } };
    const s = fundsSummary(net);
    expect(s).toMatchObject({ available: true, low: true, lowRoles: ["order-creator"], checkedAt: "2026-10-09T10:00:00.000Z", note: "reads only" });
    expect(s.rows.map((r) => `${r.role}:${r.status}:${r.balance}:${r.threshold}`)).toEqual(["demo-runner:ok:16.8856 USDC:1.00 USDC", "order-creator:low:1.5000 USDC:2.00 USDC", "merchant-payto:unread:not read:0.50 USDC"]);
    expect(fundsWarning(s, "Arc testnet")).toBe("Project funds are low on Arc testnet (order-creator): live runs or faucet claims may be refused until the operator tops them up. Recorded runs, checks and passports stay available.");
    expect(fundsWarning(fundsSummary({ ...net, funds: { ...net.funds, low: false, keys: net.funds.keys.map((k: any) => ({ ...k, low: false })) } }), "Arc testnet")).toBeNull();
    expect(fundsSummary({ network: "testnet", funds: { checkedAt: null, intervalMs: 300000, low: false, keys: [], note: "not read yet" } } as any)).toMatchObject({ available: false, low: false, rows: [], note: "not read yet" });
    expect(fundsSummary(null)).toMatchObject({ available: false, low: false });
  });
});
