import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportDigest } from "@arcpreflight/schema";
import { ACCOUNT, D, MERCHANT, NOW, REQUEST, baseline, baselineHash, order, quoteFor, reportFor, response } from "./fixtures";

// No DOM dependency: execute the actual component handlers and effects while controlling hook storage.
// Requests, schemas, quote preparation and policy evaluation remain the production implementations.
const h = vi.hoisted(() => ({ cursor: 0, state: [] as any[], memo: [] as any[], effects: [] as any[], pending: [] as (() => void)[], params: {} as any, net: {} as any, wallet: {} as any,
  refresh: vi.fn(), navigate: vi.fn(), sign: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = typeof initial === "function" ? initial() : initial; return [h.state[i], (value: any) => { h.state[i] = typeof value === "function" ? value(h.state[i]) : value; }]; },
  useMemo: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn() }; return h.memo[i].value; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = { current: initial }; return h.state[i]; },
  useCallback: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn }; return h.memo[i].value; },
  useEffect: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.effects[i]; if (!old || !deps || deps.some((d, j) => d !== old.deps[j])) h.pending.push(() => { old?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() }; }); },
}));
vi.mock("../src/App", () => ({ useNet: () => ({ net: h.net, testWallet: false, refresh: h.refresh }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => h.wallet, nativeBalance: async () => 1n, erc20Balance: async () => 1n, signTypedDataV4: (...args: unknown[]) => h.sign(...args) }));
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useParams: () => h.params, useNavigate: () => h.navigate, useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
import Developer from "../src/pages/Developer";
import Inspect from "../src/pages/Inspect";
import Demo from "../src/pages/Demo";

function render(Page: () => any) { h.cursor = 0; const tree = Page(); for (const effect of h.pending.splice(0)) effect(); return tree; }
function nodes(tree: any): any[] { const all: any[] = []; const walk = (x: any) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { all.push(x); walk(x.props?.children); } }; walk(tree); return all; }
function content(tree: any): string { return nodes(tree).map((n) => JSON.stringify(n.props?.children, (_k, v) => typeof v === "bigint" ? v.toString() : v)).join(" "); }
function button(tree: any, label: string) { const b = nodes(tree).find((n) => n.type === "button" && content(n).includes(label)); if (!b) throw new Error(`button missing: ${label}`); return b; }
function checkbox(tree: any) { return nodes(tree).find((n) => n.type === "input" && n.props.type === "checkbox"); }
function badge(tree: any) { return nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "DecisionBadge"); }
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  h.cursor = 0; h.state = []; h.memo = []; h.effects = []; h.pending = []; h.params = {};
  h.net = { network: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", rpc: "http://offline.invalid", explorer: "http://offline.invalid", fixtures: [], accounts: {}, budget: { maxRunsPerDay: 10, usedToday: 0, clientCooldownSeconds: 60 } };
  h.wallet = { provider: { request: vi.fn() }, account: ACCOUNT, chainId: 5042002, connect: vi.fn(), disconnect: vi.fn() };
  h.sign.mockReset().mockResolvedValue(`0x${"01".repeat(65)}`);
  vi.stubGlobal("localStorage", { getItem: () => "offline-token", setItem: vi.fn() });
  vi.stubGlobal("location", { origin: "http://offline.invalid" });
  vi.stubGlobal("window", { setInterval, clearInterval });
});
afterEach(() => { for (const e of h.effects) e?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function developerApi(firstPin = "100") {
  const sent: any[] = []; let revoked = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/v1/demo/orders") return response(order, 201);
    if (path.startsWith("/v1/baselines/")) return response({ baselineDigest: baselineHash, baseline, revoked });
    if (path === "/v1/preflight") {
      const body = JSON.parse(init!.body as string); sent.push(body);
      if (!body.payment) return response(quoteFor(body.intent, sent.length === 1 ? firstPin : "100"), 402);
      const report = reportFor(body.intent);
      return response({ delivery: "DELIVERED", report, reportDigest: reportDigest(report), simulation: { ok: true, error: null }, payment: { transaction: D } });
    }
    throw new Error(`Unexpected URL: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch, revoke: () => { revoked = true; } };
}
async function createDeveloperOrder() {
  render(Developer); await button(render(Developer), "Create order").props.onClick();
  render(Developer); await flush(); return render(Developer);
}

describe("Developer interactions", () => {
  it("keeps buying disabled during stale-pin retry, then pays with the exact accepted intent", async () => {
    const api = developerApi("99"); let tree = await createDeveloperOrder();
    const pending = button(tree, "Get quote").props.onClick();
    await flush(); tree = render(Developer);
    expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(true);
    expect(h.sign).not.toHaveBeenCalled(); expect(api.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500); await pending; tree = render(Developer);
    expect(api.sent).toHaveLength(2); expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(false);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(api.sent[2].intent)).toBe(JSON.stringify(api.sent[1].intent));
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
    expect(content(tree)).toContain("BASELINE_STATUS");
    api.revoke(); await vi.advanceTimersByTimeAsync(5000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("REVIEW_REQUIRED"); expect(content(tree)).toContain("baseline revoked");
  });
  it("allows normal → wrong units → normal quotes without request conflicts", async () => {
    const api = developerApi(); let tree = await createDeveloperOrder();
    for (const units of [false, true, false]) {
      if (checkbox(tree).props.checked !== units) { checkbox(tree).props.onChange({ target: { checked: units } }); render(Developer); tree = render(Developer); }
      await button(tree, "Get quote").props.onClick(); tree = render(Developer);
      expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(false);
    }
    expect(new Set(api.sent.map((b) => b.intent.clientRequestId)).size).toBe(3);
    expect(api.sent.map((b) => b.intent.valueNativeAtomic)).toEqual([order.amountNativeAtomic, "50000", order.amountNativeAtomic]);
  });
  it("expires the displayed decision and quote as time passes", async () => {
    developerApi(); let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
    await vi.advanceTimersByTimeAsync(61_000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("REVIEW_REQUIRED");
    expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(true);
    expect(content(tree)).toContain("report expired");
  });
  it("requires a new quote after delivery and gives the refreshed report a new request ID", async () => {
    const api = developerApi(); let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(true);
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(false);
    expect(api.sent[2].intent.clientRequestId).not.toBe(api.sent[0].intent.clientRequestId);
  });
});

it("Inspect ignores a late previous subject response even if the transport ignores abort", async () => {
  const a = "0x0000000000000000000000000000000000000001", b = "0x0000000000000000000000000000000000000002";
  const waiting = new Map<string, { signal: AbortSignal; resolve: (r: Response) => void }>();
  vi.stubGlobal("fetch", vi.fn((path, init) => new Promise<Response>((resolve) => waiting.set(path, { resolve, signal: init.signal }))));
  h.params = { address: a }; render(Inspect);
  h.params = { address: b }; let tree = render(Inspect);
  expect(waiting.get(`/v1/subjects/${a}`)!.signal.aborted).toBe(true);
  expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "ReportView")).toBeUndefined();
  const observed = (address: string) => response({ reportDigest: D, report: { dependencies: [{ role: "TARGET", address }], baselineResult: "NO_BASELINE" }, supported: false, evidenceCount: 1 });
  waiting.get(`/v1/subjects/${b}`)!.resolve(observed(b)); await flush(); render(Inspect);
  waiting.get(`/v1/subjects/${a}`)!.resolve(observed(a)); await flush(); tree = render(Inspect);
  expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "ReportView").props.report.dependencies[0].address).toBe(b);
  expect(nodes(tree).some((n) => n.props?.value === b)).toBe(true);
});

it("Demo displays a labelled recorded run when the API rejects a live run with a sample", async () => {
  h.net.fixtures = [{ id: "CHANGED_IMPLEMENTATION", merchant: MERCHANT, title: "changed", headline: "REVIEW_REQUIRED", proxy: "CHANGED" }];
  const run = { runId: REQUEST, fixture: "CHANGED_IMPLEMENTATION", state: "DONE", labels: ["LIVE_REQUEST"], steps: [], result: null };
  vi.stubGlobal("fetch", vi.fn(async (path) => {
    if (path === "/v1/demo/run") return response({ error: "DEMO_BUDGET_EXHAUSTED", reason: "daily budget", sampleRunId: REQUEST }, 429);
    if (path === `/v1/demo/runs/${REQUEST}`) return response(run);
    return response({ runs: [] });
  }));
  render(Demo); await flush(); await button(render(Demo), "live").props.onClick(); const tree = render(Demo);
  const panel = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "RunPanel");
  expect(panel.props.run).toMatchObject(run); expect(panel.props.sample).toBe(true); expect(content(tree)).toContain("RECORDED_SAMPLE");
});
