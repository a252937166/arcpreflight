import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportDigest } from "@arcpreflight/schema";
import { ACCOUNT, D, IMPL, MERCHANT, NOW, REQUEST, baseline, baselineHash, order, quoteFor, reportFor, response } from "./fixtures";

// No DOM dependency: execute the actual component handlers and effects while controlling hook storage.
// Requests, schemas, quote preparation and policy evaluation remain the production implementations.
const h = vi.hoisted(() => ({ cursor: 0, state: [] as any[], memo: [] as any[], effects: [] as any[], pending: [] as (() => void)[], params: {} as any, net: {} as any, wallet: {} as any, ctx: {} as any, balance: 10n ** 18n as bigint,
  refresh: vi.fn(), navigate: vi.fn(), sign: vi.fn(), saveJson: vi.fn(), verifyResult: null as any }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = typeof initial === "function" ? initial() : initial; return [h.state[i], (value: any) => { h.state[i] = typeof value === "function" ? value(h.state[i]) : value; }]; },
  useMemo: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn() }; return h.memo[i].value; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = { current: initial }; return h.state[i]; },
  useCallback: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn }; return h.memo[i].value; },
  useEffect: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.effects[i]; if (!old || !deps || deps.some((d, j) => d !== old.deps[j])) h.pending.push(() => { old?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() }; }); },
}));
vi.mock("../src/App", () => ({ useNet: () => ({ net: h.net, testWallet: false, refresh: h.refresh, ...h.ctx }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => h.wallet, friendlyName: (i: any) => i.name, nativeBalance: async () => h.balance, erc20Balance: async () => 1n, signTypedDataV4: (...args: unknown[]) => h.sign(...args), setTargetNetwork: vi.fn(), ensureChain: vi.fn() }));
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useParams: () => h.params, useNavigate: () => h.navigate, useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock("../src/lib/download", () => ({ saveJson: (...args: unknown[]) => h.saveJson(...args) }));
vi.mock("../src/lib/verifyInBrowser", async (original) => ({ ...await original<typeof import("../src/lib/verifyInBrowser")>(), verifyBundleInBrowser: async () => { if (!h.verifyResult) throw new Error("no verifier result staged"); return h.verifyResult; } }));
import { createHash } from "node:crypto";
import { IntentCore, intentDigest, policyDigest } from "@arcpreflight/schema";
import Developer from "../src/pages/Developer";
import Inspect from "../src/pages/Inspect";
import Demo from "../src/pages/Demo";
import Verify from "../src/pages/Verify";
import Home from "../src/pages/Home";
import { AMBIGUOUS_TEXT, UNCERTAIN_OPEN_TEXT, UNCERTAIN_TEXT, resetExecutionGuard } from "../src/lib/attempts";
import { RunPanel, RecoveryDesk, messageOf, headlineOf, orderResultOf } from "../src/components/RunPanel";
import { WalletChip } from "../src/components/WalletChip";
import { Hex } from "../src/components/Badges";
import { WalletRunPanel } from "../src/components/WalletRunPanel";
import { FaucetCard } from "../src/components/FaucetCard";
import { faucetOffered } from "../src/lib/faucet";
import { describeError, describeBody } from "../src/lib/errors";
import { ApiError, setApiBase } from "../src/lib/api";
import { resetSessions, storedSession } from "../src/lib/session";
import { previewBundle } from "../src/lib/passportPreview";
import { BALANCE_SIGNAL_KEY, balancesOf, resetBalanceStore } from "../src/lib/balances";

function render(Page: () => any) { h.cursor = 0; const tree = Page(); for (const effect of h.pending.splice(0)) effect(); return tree; }
function nodes(tree: any): any[] { const all: any[] = []; const walk = (x: any) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { all.push(x); walk(x.props?.children); } }; walk(tree); return all; }
function content(tree: any): string { return nodes(tree).map((n) => JSON.stringify(n.props?.children, (_k, v) => typeof v === "bigint" ? v.toString() : v)).join(" "); }
function button(tree: any, label: string) { const b = nodes(tree).find((n) => n.type === "button" && content(n).includes(label)); if (!b) throw new Error(`button missing: ${label}`); return b; }
function checkbox(tree: any) { return nodes(tree).find((n) => n.type === "input" && n.props.type === "checkbox"); }
function badge(tree: any) { return nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "DecisionBadge"); }
/** the lifecycle strip's stages by id (status + note), as the page handed them to <Lifecycle> */
function lifecycleOf(tree: any): Record<string, { status: string; note?: string | null }> { const l = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "Lifecycle"); return Object.fromEntries(l.props.stages.map((s: any) => [s.id, s])); }
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  h.cursor = 0; h.state = []; h.memo = []; h.effects = []; h.pending = []; h.params = {}; h.ctx = {}; h.balance = 10n ** 18n; resetSessions(); setApiBase(""); resetBalanceStore();
  h.net = { network: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", rpc: "http://offline.invalid", explorer: "http://offline.invalid", priceTokenAtomic: "10000", fixtures: [], accounts: {}, budget: { maxRunsPerDay: 10, usedToday: 0, clientCooldownSeconds: 60, amountNativeAtomic: "50000000000000000" } };
  h.verifyResult = null;
  // a wallet that answers the pre-send reads (account, chain) like an extension; eth_sendTransaction is what each test decides
  h.wallet = { provider: { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_accounts" ? [ACCOUNT] : method === "eth_chainId" ? "0x4cef52" : "0x1")) }, info: null, account: ACCOUNT, chainId: 5042002, connecting: false, error: null, isTest: false, candidates: [], picker: false, connect: vi.fn(), choose: vi.fn(), closePicker: vi.fn(), disconnect: vi.fn(), switchChain: vi.fn(), refresh: vi.fn() };
  h.sign.mockReset().mockResolvedValue(`0x${"01".repeat(65)}`);
  vi.stubGlobal("localStorage", { getItem: () => "offline-token", setItem: vi.fn() });
  vi.stubGlobal("location", { origin: "http://offline.invalid" });
  vi.stubGlobal("window", { setInterval, clearInterval });
});
afterEach(() => { for (const e of h.effects) e?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); setApiBase(""); resetExecutionGuard(); });

const SESSION = (n = 1) => ({ principal: `visitor:${n}`, token: `sess-${n}` });
// v3.3 shapes (docs/LIFECYCLE.md §8): the creation response, the listed order, a validated attempt with its plan
const CREATED: any = { ...order, proxy: "MAIN", payer: ACCOUNT, reference: null, state: "CONFIRMED", owner: "visitor:1" };
const ORDER_VIEW: any = { orderId: order.orderId, owner: "visitor:1", source: "developer", runId: null, payer: ACCOUNT, merchant: MERCHANT, proxy: "MAIN", amountNativeAtomic: order.amountNativeAtomic, reference: null, state: "CONFIRMED", tx: D, block: "100", creation: { from: null, gasUsed: "100292", effectiveGasPriceNativeAtomic: "25000000000" }, paid: false, paidCheckedAt: null, note: null, checks: [], attempts: [], nextAction: "run the preflight check for this order", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
const ATTEMPT_ID = "11111111-2222-4333-8444-555555555555";
const PLAN = { chainId: 5042002, from: ACCOUNT, type: 2, to: MERCHANT, data: "0x8609cad1" + "ab".repeat(32), valueNativeAtomic: order.amountNativeAtomic, nonce: "7", gasLimit: "40735", maxFeePerGasNativeAtomic: "29000000000", maxPriorityFeePerGasNativeAtomic: "5000000000", accessList: [], authorizationList: [] };
const VALIDATED: any = { attemptId: ATTEMPT_ID, executionMode: "wallet", state: "VALIDATED", requestId: REQUEST, orderId: order.orderId, merchant: MERCHANT, payer: ACCOUNT, amountNativeAtomic: order.amountNativeAtomic, labels: ["LIVE_REQUEST"], decision: "NO_POLICY_VIOLATION", decisionReasons: [], refusal: null, validUntil: new Date(NOW.getTime() + 60_000).toISOString(), txHash: null, nonce: null, from: null, broadcastBlock: null, businessStatus: null, businessTxHash: null, block: null, note: null, deviations: null, nextAction: "confirm in your wallet", passportAvailable: false, businessExecution: { state: "VALIDATED", txHash: null, nonce: null, broadcastBlock: null, consumedBy: null, note: null, validUntil: null }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), plan: PLAN, costStatement: null, recovery: null };
function developerApi(firstPin = "100") {
  const sent: any[] = []; const attempts: any[] = []; const prompts: any[] = []; let revoked = false; let sessions = 0;
  // the referenced approval's read can be held (a slow API) and released later, or made to answer an error or a 404
  let baselineHold: ((r: Response) => void)[] | null = null; let baselineAnswer: () => Response = () => response({ baselineDigest: baselineHash, baseline, revoked });
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/v1/session") return response(SESSION(++sessions), 201);
    // §10 item 1: the prompt marker route answers the view with `prompt` set
    if (path === `/v1/wallet/attempts/${ATTEMPT_ID}/prompt`) { const b = JSON.parse(init!.body as string); prompts.push(b); return response({ ...VALIDATED, prompt: b.event === "not-prompted" ? null : { state: b.event === "prompted" ? "PROMPTED" : "UNKNOWN_SUBMISSION", at: NOW.toISOString(), detail: b.detail ?? null } }); }
    if (path === "/v1/demo/orders" && method === "POST") return response(CREATED, 201);
    if (path === "/v1/demo/orders") return response({ orders: [ORDER_VIEW] });
    if (path.startsWith("/v1/demo/orders/")) return response(ORDER_VIEW);
    if (path === "/v1/wallet/attempts" && method === "POST") { attempts.push(JSON.parse(init!.body as string)); return response(VALIDATED, 201); }
    if (path === "/v1/wallet/attempts") return response({ attempts: [] });
    if (path === `/v1/wallet/attempts/${ATTEMPT_ID}/sent`) return response({ ...VALIDATED, state: "BROADCAST_ATTEMPTED", txHash: D, broadcastBlock: "150" });
    if (path === `/v1/wallet/attempts/${ATTEMPT_ID}`) return response({ ...VALIDATED, state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", block: "200", passportAvailable: true, deviations: { mismatch: [], deviations: {} } });
    if (path === "/v1/requests") return response({ requests: [] });
    if (path.startsWith("/v1/baselines/")) { if (baselineHold) return new Promise<Response>((resolve) => baselineHold!.push(resolve)); return baselineAnswer(); }
    if (path === "/v1/preflight") {
      const body = JSON.parse(init!.body as string); sent.push(body);
      if (!body.payment) return response(quoteFor(body.intent, sent.length === 1 ? firstPin : "100"), 402);
      const report = reportFor(body.intent);
      return response({ delivery: "DELIVERED", report, reportDigest: reportDigest(report), simulation: { ok: true, error: null }, payment: { transaction: D } });
    }
    throw new Error(`Unexpected URL: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  const baselines = { hold: () => { baselineHold = []; }, release: () => { const waiting = baselineHold ?? []; baselineHold = null; for (const r of waiting) r(baselineAnswer()); },
    fail: (status: number, body: unknown) => { baselineAnswer = () => response(body, status); }, restore: () => { baselineAnswer = () => response({ baselineDigest: baselineHash, baseline, revoked }); },
    reads: () => fetch.mock.calls.filter((c) => String(c[0]).startsWith("/v1/baselines/")).length };
  return { sent, attempts, prompts, fetch, revoke: () => { revoked = true; }, sessions: () => sessions, baselines };
}
const dialogNode = (tree: any) => nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "OrderDialog");
/** step 1 through the dialog (the dialog's own form is exercised in isolation below), then step 2 "Approve & continue" */
async function createDeveloperOrder(body: any = { payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: "50000000000000000" }) {
  render(Developer); await flush(); let tree = render(Developer);
  button(tree, "Create order").props.onClick(); tree = render(Developer);
  const dlg = dialogNode(tree); expect(dlg).toBeDefined();
  const created = await dlg.props.create(body); // POST /v1/demo/orders under this browser's session
  dlg.props.onCreated(created); render(Developer); await flush(); tree = render(Developer);
  expect(dialogNode(tree)).toBeUndefined(); // the dialog closed; the order card shows
  button(tree, "Approve & continue").props.onClick(); render(Developer); await flush(); return render(Developer);
}

describe("Developer interactions", () => {
  it("keeps buying disabled during stale-pin retry, then pays with the exact accepted intent", async () => {
    const api = developerApi("99"); let tree = await createDeveloperOrder();
    expect(content(tree)).toContain("x402 price quote, not an error"); // step 3 is open once the policy is approved
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

describe("presentation review 2026-10-09 · the decision waits for the referenced approval; one balance for every view", () => {
  it("buying a report never shows a transient 'review required': the approval read once is kept while it is re-read, and the decision lands with the report", async () => {
    const api = developerApi(); let tree = await createDeveloperOrder();
    expect(api.baselines.reads()).toBe(1); // read once when the order was created
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    api.baselines.hold(); // the re-read that follows the purchase hangs (a slow API)
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(api.baselines.reads()).toBe(2); // the re-read was asked for …
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION"); // … and the decision neither waited for it nor regressed
    let lc = lifecycleOf(tree); expect(lc.check.status).toBe("done"); expect(lc.execute.status).toBe("active"); expect(lc.passport.status).toBe("todo");
    expect(content(tree)).not.toContain("review required"); expect(content(tree)).not.toContain("nothing executed");
    expect(button(tree, "Execute with your wallet").props.disabled).toBe(false);
    api.baselines.release(); await flush(); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION"); lc = lifecycleOf(tree); expect(lc.check.status).toBe("done"); expect(lc.execute.status).toBe("active");
  });
  it("while the referenced approval is still being read after a purchase nothing is decided: a loading note on the check stage, execution and export closed; the decision, the stages and the button update together when the read lands", async () => {
    const api = developerApi(); api.baselines.hold(); // the approval was never read before the report is delivered
    let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(badge(tree)).toBeUndefined(); // no decision badge of any kind — not "review required", not "pending"
    expect(content(byTestId(tree, "decision-pending"))).toContain("reading the referenced approval");
    let lc = lifecycleOf(tree); expect(lc.check.status).toBe("active"); expect(lc.check.note).toContain("reading the referenced approval"); expect(lc.execute.status).toBe("todo"); expect(lc.passport.status).toBe("todo");
    expect(content(tree)).not.toContain("review required"); expect(content(tree)).not.toContain("nothing executed");
    const exec = button(tree, "Execute with your wallet"); expect(exec.props.disabled).toBe(true); expect(exec.props.title).toContain("referenced approval is being read");
    expect(nodes(tree).find((n) => n.props?.id === "step-6").props.status).toBe("todo"); // the export step is not the current one
    api.baselines.release(); await flush(); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION"); expect(byTestId(tree, "decision-pending")).toBeUndefined();
    lc = lifecycleOf(tree); expect(lc.check.status).toBe("done"); expect(lc.execute.status).toBe("active"); expect(lc.passport.status).toBe("todo");
    expect(button(tree, "Execute with your wallet").props.disabled).toBe(false);
  });
  it("a failed re-read keeps the decision from the last read and says so; a 404 is an answer — no approved baseline → review required", async () => {
    const api = developerApi(); let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
    api.baselines.fail(503, { error: "UPSTREAM_UNAVAILABLE", reason: "node unavailable" }); await vi.advanceTimersByTimeAsync(5000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION"); expect(content(byTestId(tree, "baseline-reread-failed"))).toContain("could not be re-read");
    expect(lifecycleOf(tree).execute.status).toBe("active");
    api.baselines.fail(404, { error: "NOT_FOUND", reason: "no such baseline" }); await vi.advanceTimersByTimeAsync(5000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("REVIEW_REQUIRED"); expect(byTestId(tree, "baseline-reread-failed")).toBeUndefined(); expect(byTestId(tree, "decision-pending")).toBeUndefined();
    // P3 (2026-10-10): a transient error after the 404 keeps "no approved baseline → review required"; it never turns back into loading
    api.baselines.fail(503, { error: "UPSTREAM_UNAVAILABLE", reason: "node unavailable" }); await vi.advanceTimersByTimeAsync(5000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("REVIEW_REQUIRED"); expect(byTestId(tree, "decision-pending")).toBeUndefined();
    expect(content(byTestId(tree, "baseline-reread-failed"))).toContain("no approved baseline"); expect(lifecycleOf(tree).check.status).toBe("review");
    api.baselines.restore(); await vi.advanceTimersByTimeAsync(5000); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION"); expect(byTestId(tree, "baseline-reread-failed")).toBeUndefined(); // the approval is back: decided from it
  });
  it("the Developer page refreshes the SHARED balance after the fee settles and after the payment confirms, and tells other tabs", async () => {
    const api = developerApi(); const store = memStorage();
    h.wallet.provider.request.mockImplementation(async ({ method }: { method: string }) => (method === "eth_sendTransaction" ? D : method === "eth_accounts" ? [ACCOUNT] : method === "eth_chainId" ? "0x4cef52" : "0x1"));
    let tree = await createDeveloperOrder();
    expect(balancesOf(h.wallet.provider, ACCOUNT).native).toBe(10n ** 18n); // the store every view (the nav chip included) reads
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    h.balance = 990_000_000_000_000_000n; // the node reports the fee gone
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(balancesOf(h.wallet.provider, ACCOUNT).native).toBe(990_000_000_000_000_000n); expect(content(tree)).toContain("0.9900");
    expect(JSON.parse(store.get(BALANCE_SIGNAL_KEY)!)).toMatchObject({ account: ACCOUNT.toLowerCase(), native: "990000000000000000" });
    h.balance = 939_000_000_000_000_000n; // the payment and its gas
    await button(tree, "Execute with your wallet").props.onClick(); render(Developer); await flush(); tree = render(Developer); await flush(); tree = render(Developer);
    expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "AttemptPanel").props.attempt.state).toBe("CONFIRMED");
    expect(balancesOf(h.wallet.provider, ACCOUNT).native).toBe(939_000_000_000_000_000n); expect(content(tree)).toContain("0.9390");
    expect(JSON.parse(store.get(BALANCE_SIGNAL_KEY)!)).toMatchObject({ native: "939000000000000000" });
    expect(api.attempts).toHaveLength(1);
  });
});

describe("audit 2026-10-10 · results stay bound to their inputs, their workflow and their run", () => {
  const BUNDLE_A = { passportBundleVersion: "1.0", files: { a: "1" } }, BUNDLE_B = { passportBundleVersion: "1.0", files: { b: "2" } };
  it("W02: a verification of A that lands after B was loaded is dropped (no PASS under B, no callback); removing the anchors after a PASS clears the result", async () => {
    const { VerifyInBrowser } = await import("../src/components/VerifyInBrowser");
    let release!: (r: any) => void; h.verifyResult = new Promise((r) => { release = r; }); freshHooks();
    const onVerified = vi.fn();
    let props: any = { bundle: BUNDLE_A, name: "A.json", net: h.net, anchors: { baselineDigests: [D], policyDigests: [] }, anchorsSource: "user", onVerified };
    let tree = render(() => VerifyInBrowser(props)); const pending = button(tree, "Verify in browser").props.onClick(); tree = render(() => VerifyInBrowser(props));
    props = { ...props, bundle: BUNDLE_B, name: "B.json" }; tree = render(() => VerifyInBrowser(props)); tree = render(() => VerifyInBrowser(props));
    release(verifierResult(ALL_PASS)); await pending; tree = render(() => VerifyInBrowser(props));
    expect(tree.props["data-verification"]).toBe(""); expect(content(tree)).not.toContain("Passed"); expect(onVerified).not.toHaveBeenCalled(); // A's result is nobody's
    // a result stands only for the inputs it was computed with: anchors removed → no result shown
    h.verifyResult = verifierResult(ALL_PASS); freshHooks();
    props = { bundle: BUNDLE_A, name: "A.json", net: h.net, anchors: { baselineDigests: [D], policyDigests: [] }, anchorsSource: "user", onVerified: vi.fn() };
    tree = render(() => VerifyInBrowser(props)); await button(tree, "Verify in browser").props.onClick(); tree = render(() => VerifyInBrowser(props));
    expect(tree.props["data-verification"]).toBe("passed");
    props = { ...props, anchors: { baselineDigests: [], policyDigests: [] }, anchorsSource: "none" }; tree = render(() => VerifyInBrowser(props)); tree = render(() => VerifyInBrowser(props));
    expect(content(tree)).toContain("none — APPROVAL_SOURCE stays UNVERIFIED"); expect(tree.props["data-verification"]).toBe("");
  });
  it("W03: account A's execution confirming after the connected account became B never repopulates B's workflow; an export released after start over saves nothing and marks nothing done", async () => {
    const api = developerApi(); memStorage(); let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    let release!: (h: string) => void;
    h.wallet.provider.request.mockImplementation(async ({ method }: any) => (method === "eth_sendTransaction" ? new Promise((r) => { release = r; }) : method === "eth_accounts" ? [ACCOUNT] : method === "eth_chainId" ? "0x4cef52" : "0x1"));
    const pending = button(tree, "Execute with your wallet").props.onClick(); await flush(); tree = render(Developer);
    const OTHER = "0x0000000000000000000000000000000000000B11"; h.wallet = { ...h.wallet, account: OTHER }; render(Developer); await flush(); tree = render(Developer);
    expect(lifecycleOf(tree).order.status).toBe("active"); // B starts at step 1
    release(D); await pending; render(Developer); await flush(); tree = render(Developer);
    expect(h.wallet.account).toBe(OTHER);
    expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "OrderCard")).toBeUndefined(); // A's order did not come back
    expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "AttemptPanel")).toBeUndefined(); // nor A's confirmed attempt
    expect(lifecycleOf(tree).order.status).toBe("active");
    expect(api.attempts).toHaveLength(1); // A's attempt was recorded on the server under A — reconciled there, not here
    // export, then start over, then the export lands
    h.wallet = { ...h.wallet, account: ACCOUNT }; freshHooks(); developerApi(); memStorage(); h.saveJson.mockClear();
    tree = await createDeveloperOrder(); await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    let releaseExport!: (r: Response) => void; const orig = (vi.mocked(fetch) as any).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path: any, init?: any) => (String(path).endsWith("/passport") ? new Promise<Response>((r) => { releaseExport = r; }) : orig(path, init)));
    const exporting = button(tree, "Download Payment Passport").props.onClick(); await flush(); tree = render(Developer);
    button(tree, "start over").props.onClick(); tree = render(Developer);
    expect(lifecycleOf(tree).order.status).toBe("active"); expect(lifecycleOf(tree).passport.status).toBe("todo");
    releaseExport(response(BUNDLE_A)); await exporting; tree = render(Developer);
    expect(lifecycleOf(tree).passport.status).toBe("todo"); expect(h.saveJson).not.toHaveBeenCalled(); expect(content(tree)).not.toContain("saved as");
  });
  it("W05: a purchase whose answer is lost after the fee authorization left reads as UNCERTAIN and names the remembered request — never 'nothing was sent'", async () => {
    const api = developerApi(); memStorage(); let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    const orig = api.fetch.getMockImplementation()!; let accepted = false;
    api.fetch.mockImplementation(async (path: string, init?: RequestInit) => { if (path === "/v1/preflight" && JSON.parse(String(init?.body)).payment) { accepted = true; throw new TypeError("Failed to fetch"); } return orig(path, init); });
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); tree = render(Developer);
    expect(accepted).toBe(true);
    const text = nodes(tree).filter((n) => typeof n.type === "function" && n.type.name === "ErrorBanner").map((n) => n.props?.err?.text ?? "").join(" ") + " " + content(tree);
    expect(text).toContain("may have reached the service"); expect(text).toContain(REQUEST.slice(0, 10)); expect(text).toContain("recover it from there before buying again");
    expect(text).not.toContain("Nothing was sent");
  });
  it("W06: a BROADCAST_ATTEMPTED attempt with a hash but no comparison yet shows 'comparison pending', never the green 'as planned'", async () => {
    const { AttemptPanel } = await import("../src/components/AttemptPanel");
    const pendingCompare: any = { ...VALIDATED, state: "BROADCAST_ATTEMPTED", txHash: D, deviations: null };
    expect(content(AttemptPanel({ attempt: pendingCompare, net: h.net, phase: "polling" }))).toContain("comparison pending");
    expect(content(AttemptPanel({ attempt: pendingCompare, net: h.net, phase: "polling" }))).not.toContain("as planned");
    const compared: any = { ...pendingCompare, state: "CONFIRMED", deviations: { mismatch: [], deviations: {} } };
    expect(content(AttemptPanel({ attempt: compared, net: h.net, phase: "done" }))).toContain("to · data · value · chainId · type as planned");
  });
  it("W07: the Demo quick check never turns a 503 on the approval read into a review decision — the paid report is kept and handed to the Developer workflow; a 404 still decides", async () => {
    const { useWalletRun } = await import("../src/lib/walletRun");
    const api = developerApi(); const store = memStorage(); api.baselines.fail(503, { error: "UPSTREAM_UNAVAILABLE", reason: "node unavailable" });
    let hook = render(() => useWalletRun(h.net, h.wallet));
    await hook.start({ id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MERCHANT } as any); hook = render(() => useWalletRun(h.net, h.wallet));
    expect(hook.run.delivered).not.toBeNull(); expect(hook.run.decision).toBeNull(); expect(hook.run.handoff).toBe(false);
    expect(hook.run.phase).toBe("error"); expect(hook.run.err?.text).toContain("could not be read"); expect(hook.run.err?.text).toContain("no new fee");
    expect(JSON.parse(store.get("arcpreflight.workflow:root")!)[ACCOUNT.toLowerCase()]).toMatchObject({ requestId: REQUEST, approved: true, handoff: "demo" }); // the paid report is kept for the Developer workflow
    freshHooks(); api.baselines.fail(404, { error: "NOT_FOUND", reason: "no such baseline" });
    hook = render(() => useWalletRun(h.net, h.wallet)); await hook.start({ id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MERCHANT } as any); hook = render(() => useWalletRun(h.net, h.wallet));
    expect(hook.run.phase).toBe("done"); expect(hook.run.decision?.decision).toBe("REVIEW_REQUIRED"); // a definitive answer decides
  });
  it("W08: a live run's poll that lands after the visitor opened a recorded run from history is dropped — the selected run stays on screen", async () => {
    memStorage();
    const mk = (id: string, state: string): any => ({ runId: id, state, fixture: "APPROVED_PAYMENT", labels: [], steps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, recovery: null });
    const A = mk("run-A", "RUNNING"), B = mk("run-B", "DONE"); let readsA = 0; let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.startsWith("/v1/demo/runs?")) return response({ runs: [], total: 0 });
      if (path === "/v1/demo/runs/run-A") { if (++readsA === 1) return response(A); return new Promise<Response>((r) => { release = r; }); }
      if (path === "/v1/demo/runs/run-B") return response(B); throw new Error(path);
    }));
    let tree = render(Demo); await flush(); tree = render(Demo);
    let history = fnNode(tree, "RunsTable"); await history.props.onView("run-A"); await flush(); tree = render(Demo); // live A, polling (its next poll is held)
    await vi.advanceTimersByTimeAsync(2000); tree = render(Demo);
    history = fnNode(tree, "RunsTable"); await history.props.onView("run-B"); tree = render(Demo);
    expect(fnNode(tree, "RunPanel").props.run.runId).toBe("run-B");
    release(response({ ...A, state: "RUNNING" })); await flush(); tree = render(Demo);
    expect(fnNode(tree, "RunPanel").props.run.runId).toBe("run-B"); // A's late poll changed nothing
    await vi.advanceTimersByTimeAsync(10_000); expect(readsA).toBe(2); // and A's loop is over: no further polls
  });
});

it("Developer step 4 executes through the attempt API: validated plan → eth_sendTransaction without a nonce → hash reported → polled to CONFIRMED (AP33-07)", async () => {
  const api = developerApi(); const store = memStorage();
  let txRequest: any = null; let rememberedAtPrompt: string | null = null;
  h.wallet.provider.request.mockImplementation(async ({ method, params }: { method: string; params?: any[] }) => { if (method === "eth_sendTransaction") { txRequest = params![0]; rememberedAtPrompt = store.get("arcpreflight.attempts:root") ?? null; return D; } if (method === "eth_accounts") return [ACCOUNT]; if (method === "eth_chainId") return "0x4cef52"; return "0x1"; });
  let tree = await createDeveloperOrder();
  expect(button(tree, "Execute with your wallet").props.disabled).toBe(true); // nothing to execute before a delivered NO_POLICY_VIOLATION check
  await button(tree, "Get quote").props.onClick(); tree = render(Developer);
  await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
  expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
  const exec = button(tree, "Execute with your wallet"); expect(exec.props.disabled).toBe(false);
  await exec.props.onClick(); render(Developer); await flush(); tree = render(Developer);
  expect(api.attempts).toHaveLength(1); expect(api.attempts[0]).toMatchObject({ requestId: REQUEST, orderId: order.orderId });
  expect(policyDigest(api.attempts[0].policy)).toBe(api.sent[1].intent.policyDigest); // the buyer's policy is the one the intent references
  expect(api.attempts[0].policy.maxFinalValidationAgeSeconds).toBe(60); // the human-paced window
  expect(txRequest).toMatchObject({ from: ACCOUNT, to: MERCHANT, data: PLAN.data, type: "0x2", gas: "0x9f1f", chainId: "0x4cef52" }); expect(txRequest.nonce).toBeUndefined();
  expect(JSON.parse(rememberedAtPrompt!)[ATTEMPT_ID]).toMatchObject({ attemptId: ATTEMPT_ID, orderId: order.orderId, state: "VALIDATED", promptState: "PROMPTED" }); // remembered, with the §10 marker, BEFORE the wallet was asked
  expect(api.prompts).toEqual([{ event: "prompted", claimId: expect.any(String) }]); // one exclusive claim, with this call's id; // §10 item 1: the marker is durable on the server before the prompt; a hash afterwards is never an unknown submission
  const methods = h.wallet.provider.request.mock.calls.map((c: any[]) => c[0].method);
  expect(methods.filter((m: string) => m === "eth_sendTransaction")).toHaveLength(1);
  expect(methods.lastIndexOf("eth_accounts")).toBeLessThan(methods.indexOf("eth_sendTransaction")); expect(methods.lastIndexOf("eth_chainId")).toBeLessThan(methods.indexOf("eth_sendTransaction")); // re-read right before the prompt
  for (const forbidden of ["eth_sendRawTransaction", "eth_signTransaction", "wallet_sendCalls"]) expect(methods).not.toContain(forbidden);
  const paths = api.fetch.mock.calls.map((c) => c[0]);
  expect(paths.indexOf("/v1/wallet/attempts")).toBeLessThan(paths.indexOf(`/v1/wallet/attempts/${ATTEMPT_ID}/prompt`)); expect(paths.indexOf(`/v1/wallet/attempts/${ATTEMPT_ID}/prompt`)).toBeLessThan(paths.indexOf(`/v1/wallet/attempts/${ATTEMPT_ID}/sent`));
  expect(JSON.parse((api.fetch.mock.calls.find((c) => c[0] === `/v1/wallet/attempts/${ATTEMPT_ID}/sent`)![1] as RequestInit).body as string)).toEqual({ txHash: D });
  const panel = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "AttemptPanel");
  expect(panel.props.attempt.state).toBe("CONFIRMED"); expect(panel.props.phase).toBe("done");
  expect(JSON.parse(store.get("arcpreflight.workflow:root")!)[ACCOUNT.toLowerCase()]).toMatchObject({ payer: ACCOUNT, orderId: order.orderId, approved: true, requestId: REQUEST, attemptId: ATTEMPT_ID }); // the workflow identity survives a refresh, keyed by payer
  expect(content(tree)).toContain("confirmed");
  expect(button(tree, "Download Payment Passport").props.disabled).toBe(false);
});

it("OrderDialog: autofill fills valid, editable values; validation is inline; the review step shows the exact body; a 400 lands on its field", async () => {
  const { OrderDialog } = await import("../src/components/OrderDialog");
  const created: any[] = []; let answer: () => any = () => CREATED;
  const create = vi.fn(async (body: any) => { created.push(body); const a = answer(); if (a instanceof Error) throw a; return a; });
  const onCreated = vi.fn(); const onClose = vi.fn();
  const limits = { minNativeAtomic: 10n ** 15n, maxNativeAtomic: 10n ** 18n, stepNativeAtomic: 10n ** 12n, defaultNativeAtomic: 5n * 10n ** 16n, maxReferenceLength: 64 };
  const net: any = { ...h.net, fixtures: [{ id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MERCHANT, implementation: IMPL, approvedImplementation: IMPL, baselineDigest: baselineHash, expected: "NO_POLICY_VIOLATION" }, { id: "CHANGED_IMPLEMENTATION", proxy: "CHANGED", merchant: MERCHANT, implementation: "0x0000000000000000000000000000000000000c33", approvedImplementation: IMPL, baselineDigest: D, expected: "REVIEW_REQUIRED" }] };
  const dlg = () => render(() => OrderDialog({ payer: ACCOUNT, net, limits, create, onCreated, onClose }));
  const input = (tree: any, id: string) => nodes(tree).find((n) => n.type === "input" && n.props.id === id);
  const form = (tree: any) => nodes(tree).find((n) => n.type === "form");
  freshHooks(); let tree = dlg();
  expect(input(tree, "of-payer").props.readOnly).toBe(true); expect(input(tree, "of-payer").props.value).toBe(ACCOUNT);
  expect(content(tree)).toContain("implementation as approved"); expect(content(tree)).toContain("implementation changed since approval");
  expect(content(tree)).toContain("demonstration order on the project's DemoMerchant contract — no goods or services are delivered"); // what is bought, before any field
  expect(content(tree)).toContain("a pinned preflight report, the payment outcome read from the chain, and a verifiable Payment Passport");
  const tech = nodes(tree).filter((n) => n.type === "details" && n.props["data-testid"] === "technical-details"); expect(tech).toHaveLength(1); expect(tech[0].props.open).toBeUndefined(); // collapsed
  expect(content(tech[0])).toContain("MAIN"); expect(content(tech[0])).toContain("18-decimal native units"); // proxy code names and atomic units live there
  expect(nodes(tree).filter((n) => n.type !== "details" && !nodes(tech[0]).includes(n)).some((n) => typeof n.props?.children === "string" && /^(MAIN|CHANGED)$/.test(n.props.children))).toBe(false); // …and nowhere else
  button(tree, "Autofill sample order").props.onClick(); tree = dlg();
  expect(input(tree, "of-amount").props.value).toBe("0.05"); expect(input(tree, "of-ref").props.value).toBe("sample order 2026-10-03");
  input(tree, "of-amount").props.onChange({ target: { value: "0.005" } }); tree = dlg(); // autofilled values stay editable
  expect(content(tree)).toContain("5000000000000000");
  input(tree, "of-amount").props.onChange({ target: { value: "0.0000001" } }); tree = dlg();
  expect(content(tree)).toContain("at most 6 decimals"); // inline validation mirrors the server
  form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
  expect(content(tree)).not.toContain("Review the order"); // invalid: the review step is not reached
  input(tree, "of-amount").props.onChange({ target: { value: "0.005" } }); tree = dlg();
  form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
  expect(content(tree)).toContain("Review the order"); expect(content(tree)).toContain("amountNativeAtomic"); expect(content(tree)).toContain("5000000000000000"); expect(content(tree)).toContain("0.005"); expect(content(tree)).toContain("sample order 2026-10-03");
  const review = nodes(tree).find((n) => n.props?.["data-testid"] === "order-review"); expect(content(review)).toContain("as approved"); expect(content(review)).toContain("0.005"); expect(content(review)).toContain("no goods or services"); expect(content(review)).not.toContain("5000000000000000"); // human-readable; atomic units under technical details
  const techReview = nodes(tree).find((n) => n.type === "details" && n.props["data-testid"] === "technical-details"); expect(techReview.props.open).toBeUndefined(); expect(nodes(techReview).some((n) => n.type === "pre")).toBe(true); // the raw JSON body is collapsed
  expect(create).not.toHaveBeenCalled(); // nothing left before "Create order"
  answer = () => Object.assign(new ApiError(400, { error: "INVALID_INPUT", field: "reference", reason: "reference must be at most 64 characters" }), {});
  await form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
  expect(created[0]).toEqual({ payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: "5000000000000000", reference: "sample order 2026-10-03" });
  expect(content(tree)).toContain("reference must be at most 64 characters"); expect(content(tree)).toContain("Create a demonstration order"); // back on the form, the server's reason on its field
  expect(onCreated).not.toHaveBeenCalled();
  answer = () => CREATED;
  form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg(); await form(tree).props.onSubmit({ preventDefault() {} });
  expect(onCreated).toHaveBeenCalledWith(CREATED);
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

it("Inspect shows the server's refusal for a non-curated subject and offers the curated samples instead of a free-text box", async () => {
  const curated = [{ address: "0x3600000000000000000000000000000000000000", label: "USDC (ERC-20 face of native USDC)", kind: "external" }];
  h.net.observableSubjects = curated;
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "UNSUPPORTED_SUBJECT", reason: "this release observes a curated list of public samples only", curated }, 422)));
  h.params = { address: "0x0000000000000000000000000000000000000009" }; render(Inspect); await flush(); const tree = render(Inspect);
  expect(content(tree)).toContain("curated list of public samples only");
  button(tree, "USDC (ERC-20 face of native USDC)").props.onClick();
  expect(h.navigate).toHaveBeenCalledWith("/subjects/0x3600000000000000000000000000000000000000");
  expect(nodes(tree).find((n) => n.type === "input")).toBeUndefined();
});

// ---- v3.2 workbench: admission keys, recovery desk, passport export, verifier preview, §7 messages ----
const memStorage = (seed: Record<string, string> = {}) => { const store = new Map(Object.entries(seed)); vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } }); return store; };
const freshHooks = () => { h.cursor = 0; h.state = []; h.memo = []; h.effects = []; h.pending = []; resetBalanceStore(); }; // a fresh component tree never keeps the old tree's balance listeners
const DONE_RUN: any = { runId: REQUEST, fixture: "AMOUNT_UNIT_MISMATCH", state: "DONE", labels: ["LIVE_REQUEST"], steps: [{ step: "createOrder", atMs: 1 }, { step: "signServiceFee", atMs: 2 }, { step: "decision", atMs: 3, decision: "BLOCKED" }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: "BLOCKED", headline: "BLOCKED",
  recovery: { recoveryVersion: "1.0", attemptId: "a", interrupted: false, counters: { ordersCreated: 1, checkFeeAuthorizations: 1, businessSignatures: 0, broadcastsOfOriginalBytes: 0, replacementSignatures: 0 }, originalTransaction: { hash: null, status: "none" }, reconciliation: [] },
  result: { fixture: "AMOUNT_UNIT_MISMATCH", network: "testnet", chainId: 5042002, attemptId: "a", orderId: D, merchant: MERCHANT, intent: { baselineDigest: D, valueNativeAtomic: "50000", businessExpectation: { amountNativeAtomic: "50000000000000000" } }, intentDigest: D, policy: {}, policyDigest: D, requestId: REQUEST, serviceFeeTx: D,
    report: { baselineDigest: D, baselineResult: "MATCH", dependencies: [], signals: [], observation: { blockNumber: "1" } }, reportDigest: D, simulation: null, decision: { decision: "BLOCKED", reasons: ["AMOUNT_SEMANTICS: value is in 6-decimal units"], decidedAt: NOW.toISOString() }, decisionDigest: D, finalValidation: null, plan: null,
    execution: { chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", businessTxHash: null, signedTransactionHash: null, labels: ["LIVE_REQUEST"], recordedAt: NOW.toISOString() }, executionDigest: D, postcondition: null, steps: [], durationMs: 1200, costStatement: null } };

it("Demo sends one admission key per click and re-sends the same key when the response is lost", async () => {
  h.net.fixtures = [{ id: "CHANGED_IMPLEMENTATION", merchant: MERCHANT, title: "changed", headline: "REVIEW_REQUIRED", proxy: "CHANGED" }];
  const store = memStorage();
  const posts: any[] = []; let attempt = 0;
  const run = { runId: REQUEST, fixture: "CHANGED_IMPLEMENTATION", state: "RUNNING", labels: ["LIVE_REQUEST"], steps: [], result: null, recovery: null };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/v1/demo/run") { posts.push(JSON.parse(init!.body as string)); if (attempt++ === 0) throw new TypeError("network dropped after the request left"); return response({ runId: REQUEST, poll: `/v1/demo/runs/${REQUEST}`, admission: "existing" }, 200); }
    if (path === `/v1/demo/runs/${REQUEST}`) return response(run);
    return response({ runs: [] });
  }));
  render(Demo); await flush(); await button(render(Demo), "live").props.onClick(); const tree = render(Demo);
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({ fixture: "CHANGED_IMPLEMENTATION" });
  expect(posts[0].clientRunRequestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[1].clientRunRequestId).toBe(posts[0].clientRunRequestId);
  expect(JSON.parse(store.get("arcpreflight.runKeys:root")!)).toEqual({ [REQUEST]: posts[0].clientRunRequestId }); // scoped to the root instance (P2)
  expect(content(tree)).toContain("no second order was created");
});

it("RecoveryDesk offers 'Recover this attempt' only to the browser holding the admission key, and posts to /recover", async () => {
  const run: any = { runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "RECONCILE_REQUIRED", labels: ["LIVE_REQUEST"], steps: [{ step: "broadcast", atMs: 1, businessTxHash: D, accepted: true }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: "NO_POLICY_VIOLATION", headline: "CONFIRMED", recovery: null,
    result: { execution: { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: D, signedTransactionHash: D, labels: [] }, plan: { nonce: "7" }, finalValidation: { expiresAt: "2026-10-03T12:05:00Z" } } };
  memStorage();
  let tree = render(() => RecoveryDesk({ run, net: h.net, onUpdate: vi.fn() }));
  expect(nodes(tree).find((n) => n.type === "button")).toBeUndefined();
  expect(content(tree)).toContain("Recovery is available to the session that started this run");
  memStorage({ "arcpreflight.runKeys": JSON.stringify({ [REQUEST]: "key-123" }) });
  const fetch = vi.fn(async (path: string, init?: RequestInit) => { expect(path).toBe(`/v1/demo/runs/${REQUEST}/recover`); expect(init?.method).toBe("POST"); expect(JSON.parse(init!.body as string)).toEqual({ clientRunRequestId: "key-123" }); return response({ ...run, state: "DONE" }); });
  vi.stubGlobal("fetch", fetch);
  const onUpdate = vi.fn(); freshHooks();
  tree = render(() => RecoveryDesk({ run, net: h.net, onUpdate }));
  expect(nodes(tree).filter((n) => n.type === "button").map((b) => content(b).toLowerCase()).some((t) => t.includes("pay again"))).toBe(false);
  await button(tree, "Recover this attempt").props.onClick();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ state: "DONE" }));
  tree = render(() => RecoveryDesk({ run, net: h.net, onUpdate }));
  expect(content(tree)).toContain("run state is now DONE");
});

it("RunPanel downloads the passport through the API route, refuses while RUNNING and surfaces a 409", async () => {
  memStorage();
  const bundle = { passportBundleVersion: "1.0", files: { "manifest.json": "{}" } };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { expect(path).toBe(`/v1/demo/runs/${REQUEST}/passport`); return response(bundle); }));
  let tree = render(() => RunPanel({ run: DONE_RUN, net: h.net }));
  expect(content(tree)).toContain("This payment is outside the referenced approval.");
  expect(content(tree)).toContain("orders created: ");
  await button(tree, "Download Payment Passport").props.onClick();
  expect(h.saveJson).toHaveBeenCalledWith(`arcpreflight-passport-${REQUEST.slice(0, 8)}.json`, bundle);
  freshHooks();
  tree = render(() => RunPanel({ run: { ...DONE_RUN, state: "RUNNING", result: null, recovery: null }, net: h.net }));
  expect(button(tree, "Download Payment Passport").props.disabled).toBe(true);
  expect(content(tree)).toContain("Run in progress.");
  expect(content(tree)).toContain("\"—\""); // counters show — when recovery is not recorded
  freshHooks();
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "PASSPORT_NOT_READY", reason: "the run is still in progress" }, 409)));
  tree = render(() => RunPanel({ run: DONE_RUN, net: h.net }));
  await button(tree, "Download Payment Passport").props.onClick();
  tree = render(() => RunPanel({ run: DONE_RUN, net: h.net }));
  expect(content(tree)).toContain("the run is still in progress");
  expect(h.saveJson).toHaveBeenCalledTimes(1);
});

it("the passport state belongs to one run: another run shown by the same panel starts clean, and a download that resolves after the switch is dropped (review 2026-10-09)", async () => {
  memStorage();
  const bundle = { passportBundleVersion: "1.0", files: { "manifest.json": "{}" } };
  let release: (() => void) | null = null;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { if (path.endsWith("/passport")) await new Promise<void>((r) => { release = r; }); return response(bundle); }));
  const onLocal = vi.fn(); const saved = h.saveJson.mock.calls.length;
  let tree = render(() => RunPanel({ run: DONE_RUN, net: h.net, onLocal }));
  const inflight = button(tree, "Download Payment Passport").props.onClick(); // run A's download is in flight…
  const B = { ...DONE_RUN, runId: "22222222-2222-4222-8222-222222222222" };
  tree = render(() => RunPanel({ run: B, net: h.net, onLocal })); // …when the same panel is handed run B
  expect(content(button(tree, "Download Payment Passport"))).not.toContain("exporting"); expect(content(tree)).not.toContain("Download Payment Passport again");
  release!(); await inflight; await flush();
  tree = render(() => RunPanel({ run: B, net: h.net, onLocal }));
  expect(h.saveJson.mock.calls.length).toBe(saved); expect(onLocal).not.toHaveBeenCalled(); // A's late result is dropped, not attributed to B
  expect(nodes(tree).some((n) => typeof n.type === "function" && n.type.name === "VerifyInBrowser")).toBe(false);
  expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FlowCanvas")?.props.stages[5].status).toBe("todo"); // the diagram does not say "export done"
  // a fresh download for A is stored under A, and B still starts clean
  vi.stubGlobal("fetch", vi.fn(async () => response(bundle)));
  tree = render(() => RunPanel({ run: DONE_RUN, net: h.net, onLocal }));
  await button(tree, "Download Payment Passport").props.onClick(); await flush();
  tree = render(() => RunPanel({ run: DONE_RUN, net: h.net, onLocal }));
  expect(onLocal).toHaveBeenCalledWith(REQUEST, { exported: true, verified: null }); expect(content(tree)).toContain("Download Payment Passport again");
  expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FlowCanvas")?.props.stages[5].status).toBe("done");
  tree = render(() => RunPanel({ run: B, net: h.net, onLocal }));
  expect(content(tree)).not.toContain("Download Payment Passport again");
  expect(nodes(tree).some((n) => typeof n.type === "function" && n.type.name === "VerifyInBrowser")).toBe(false);
  expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FlowCanvas")?.props.stages[5].status).toBe("todo");
});

it("the run strip, the guide and the diagram keep execution active at step 4/7 while the runner waits for the receipt (review 2026-10-09)", async () => {
  memStorage(); h.net.fixtures = [CHANGED_FIXTURE];
  const run = { runId: REQUEST, fixture: "CHANGED_IMPLEMENTATION", state: "RUNNING", labels: ["LIVE_REQUEST"], steps: ["orderPlanned", "createOrder", "intent", "quote", "signServiceFee", "reportDelivered", "decision", "finalValidation", "signed", "broadcastAttempted", "broadcast"].map((step, i) => ({ step, atMs: i })),
    result: null, order: { orderId: D, state: "CONFIRMED", tx: D, block: "1", payer: ACCOUNT, merchant: MERCHANT, amountNativeAtomic: "50000000000000000", reference: null, paid: null },
    businessExecution: { state: "BROADCAST_ATTEMPTED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null }, outcome: { kind: "RUNNING", text: "", source: "state" } };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/v1/demo/run") return response({ runId: REQUEST, poll: `/v1/demo/runs/${REQUEST}`, admission: "new" }, 202);
    if (path === `/v1/demo/runs/${REQUEST}`) return response(run);
    return response({ runs: [], total: 0 });
  }));
  render(Demo); await flush(); await button(render(Demo), "live").props.onClick(); await flush(); const tree = render(Demo);
  const strip = nodes(tree).find((n) => n.props?.className === "runstrip");
  expect(content(strip)).toContain("execute payment (step 4/7)"); expect(content(strip)).not.toContain("starting");
  const guide = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "GuidePanel")?.props.guide; // child components are elements here: assert on what the panel is handed
  expect(guide.label).toBe("execute payment"); expect(guide.now).toMatchObject({ stage: "execute", detail: "broadcast · waiting for the receipt" });
  expect(guide.stages.map((s: any) => s.status)).toEqual(["done", "done", "done", "active", "skipped", "todo", "todo"]);
});

it("amounts, balances and funding are told apart on the Demo (review 2026-10-09): order amount per demo, who pays, the runner's balance from the funds watch, the visitor's balance, the faucet and Circle's faucet", async () => {
  memStorage(); h.net.fixtures = [APPROVED_FIXTURE];
  h.net.funds = { checkedAt: NOW.toISOString(), intervalMs: 300000, low: false, note: "reads only", keys: [{ role: "demo-runner", address: "0x00000000000000000000000000000000000000a1", balanceNativeAtomic: "16885600000000000000", warnBelowNativeAtomic: "1000000000000000000", low: false, note: "runs" }] };
  vi.stubGlobal("fetch", vi.fn(async () => response({ runs: [], total: 0 })));
  render(Demo); await flush(); const tree = render(Demo); const text = content(tree);
  expect(text).toContain("order amount per demo"); expect(text).not.toContain("business payment");
  const runner = content(byTestId(tree, "runner-funding"));
  expect(runner).toContain("16.8856"); expect(runner).toContain("project funds"); expect(runner).toContain("funding your own wallet does not add to it"); expect(runner).toContain("gas ≈ 0.001 USDC");
  expect(content(byTestId(tree, "entry-try"))).toContain("Your wallet pays");
  const help = content(byTestId(tree, "faucet-help"));
  expect(help).toContain("Your wallet balance"); expect(help).toContain("faucet.circle.com"); expect(help).toContain("does not replenish the project runner");
  expect(nodes(byTestId(tree, "faucet-help")).some((n) => n.type === "a" && n.props.href === "https://faucet.circle.com/" && n.props.target === "_blank")).toBe(true);
});

it("Gate D: on a gated instance the Demo's quick check (it creates an order) is disabled with the reason; the gate and gas-cap refusals read as sentences", async () => {
  memStorage(); h.net.fixtures = [APPROVED_FIXTURE]; h.net.access = { selfService: true, session: "/v1/session", publicExecution: false, walletExecution: false, executionReady: true, operatorAcceptance: true };
  vi.stubGlobal("fetch", vi.fn(async () => response({ runs: [], total: 0 })));
  render(Demo); await flush(); const tree = render(Demo);
  const quick = button(tree, "with your wallet");
  expect(quick.props.disabled).toBe(true); expect(quick.props.title).toContain("order creation is gated on this instance until the mainnet acceptance is recorded");
  expect(content(byTestId(tree, "quick-check-note"))).toContain("the quick check creates an order, so it opens with execution");
  expect(button(tree, "live · project runner").props.disabled).toBe(true); // the runner is gated too
  const gate = describeBody({ error: "EXECUTION_GATED", reason: "order creation on this instance is gated until the operator records the mainnet acceptance; checks, recovery and passports stay available" }, 503);
  expect(gate.text).toContain("Execution is gated on this instance: order creation on this instance is gated"); expect(gate.text).toContain("Nothing was started or created"); expect(gate.text).not.toContain("orders, recovery");
  const cap = describeBody({ error: "GAS_CAP_EXCEEDED", reason: "createOrder refused: worst-case gas cost 12000000000000000 exceeds the per-transaction cap 6000000000000000; nothing was persisted or sent" }, 503);
  expect(cap.text).toMatch(/^The order was not created: createOrder refused/); expect(cap.text).toContain("Nothing was sent");
});

it("Verify's offline preview reproduces digests, flags a tampered file and an unsafe path, and shows counts instead of a verdict", async () => {
  const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "demo", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: ACCOUNT, operation: "CALL", to: MERCHANT, data: "0x12345678", valueNativeAtomic: "50000000000000000", businessExpectation: { sourceId: "order", sourceDigest: D, action: "MERCHANT_PAY", recipient: MERCHANT, asset: "ARC_NATIVE_USDC", amountNativeAtomic: "50000000000000000", orderId: D }, baselineDigest: D, policyDigest: D, expiresAt: "2026-10-03T12:10:00Z" });
  const sha = (s: string) => "0x" + createHash("sha256").update(s, "utf8").digest("hex");
  const files: Record<string, string> = { "intent.json": JSON.stringify(intent), "verify.md": "read me" };
  files["manifest.json"] = JSON.stringify({ passportVersion: "1.0", generator: { name: "arcpreflight", release: "test", component: "api" }, disclosure: "public", chain: { chainId: 5042002, caip2: "eip155:5042002" }, subject: { kind: "demo-run", orderId: D }, stageCoverage: { intent: true },
    files: [{ path: "intent.json", bytes: files["intent.json"].length, sha256: sha(files["intent.json"]), object: { kind: "intent", schemaVersion: "1.0", digestProfile: "arcpreflight-jcs-keccak-1.0", digest: intentDigest(intent) } }, { path: "verify.md", bytes: 7, sha256: sha(files["verify.md"]), object: null }] });
  const good = await previewBundle({ passportBundleVersion: "1.0", files });
  expect(good.problems).toEqual([]); expect(good.counts).toEqual({ PASS: 3, FAIL: 0, SKIPPED: 0 });
  const tampered = await previewBundle({ passportBundleVersion: "1.0", files: { ...files, "verify.md": "read me, edited", "../evil.json": "{}" } });
  expect(tampered.findings).toContainEqual(expect.objectContaining({ path: "verify.md", check: "sha256", status: "FAIL" }));
  expect(tampered.findings).toContainEqual(expect.objectContaining({ path: "../evil.json", check: "path", status: "FAIL" }));
  expect(tampered.findings.find((f) => f.path === "intent.json" && f.check === "object")?.status).toBe("PASS");
  expect((await previewBundle({ passportBundleVersion: "1.0", files: { ...files, "manifest.json": files["manifest.json"].replace("arcpreflight-jcs-keccak-1.0", "sha1-anything") } })).findings).toContainEqual(expect.objectContaining({ path: "intent.json", check: "object", status: "FAIL" }));
  let tree = render(Verify); const text = content(tree);
  expect(text).toContain("packages/verifier/src/cli.ts");
  expect(text).toContain("This preview runs the same code as the site; for independence run the CLI in a clean process.");
  const input = nodes(tree).find((n) => n.type === "input" && n.props.type === "file");
  await input.props.onChange({ target: { files: [{ name: "p.json", text: async () => JSON.stringify({ passportBundleVersion: "1.0", files: { ...files, "verify.md": "edited" } }) }] } });
  tree = render(Verify);
  expect(nodes(tree).some((n) => Array.isArray(n.props?.children) && n.props.children[0] === 1 && n.props.children[1] === " fail")).toBe(true);
  expect(content(tree)).not.toMatch(/\bVERIFIED\b|all checks passed/);
});

it("maps recorded states to the §7 primary messages and badge words", () => {
  const base = (over: any): any => ({ runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: [], steps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, ...over });
  const ex = (chainStatus: string, businessStatus: string, decision = "NO_POLICY_VIOLATION") => ({ result: { decision: { decision, reasons: [] }, execution: { chainStatus, businessStatus, businessTxHash: null, signedTransactionHash: null, labels: [] } } });
  expect(messageOf(base(ex("CONFIRMED", "SUCCESS"))).text).toBe("Order payment confirmed.");
  expect(messageOf(base(ex("CONFIRMED", "FAILED"))).text).toBe("Transaction confirmed; expected order outcome not verified.");
  expect(messageOf(base(ex("NOT_SIGNED", "NOT_EXECUTED", "REVIEW_REQUIRED"))).text).toBe("This payment is outside the referenced approval.");
  expect(messageOf(base(ex("NOT_SIGNED", "NOT_EXECUTED", "BLOCKED"))).text).toBe("This payment is outside the referenced approval.");
  expect(messageOf(base({ state: "RECONCILE_REQUIRED", ...ex("UNKNOWN", "UNKNOWN") })).text).toBe("Payment result not yet established.");
  expect(messageOf(base({ state: "FAILED", ...ex("SIGNED_NOT_BROADCAST", "NOT_EXECUTED") })).text).toBe("This attempt was not sent by this runner.");
  expect(messageOf(base({ state: "RUNNING", steps: [{ step: "settlementPending", atMs: 1 }] })).text).toBe("Check fee awaiting reconciliation.");
  expect(headlineOf(base({ state: "RECONCILE_REQUIRED", ...ex("UNKNOWN", "UNKNOWN") })).text).toBe("OUTCOME PENDING RECONCILIATION");
  expect(headlineOf(base({ state: "FAILED", ...ex("SIGNED_NOT_BROADCAST", "NOT_EXECUTED") })).text).toBe("NOT SENT");
  expect(headlineOf(base(ex("CONFIRMED", "SUCCESS"))).text).toBe("CONFIRMED");
  expect(orderResultOf(ex("CONFIRMED", "SUCCESS").result as any)).toBe("paid");
  expect(orderResultOf(ex("UNKNOWN", "UNKNOWN").result as any)).toBe("unknown");
  expect(orderResultOf(ex("NOT_SIGNED", "NOT_EXECUTED", "BLOCKED").result as any)).toBe("unpaid");
});

// ---- P0/P1: readable errors, history tables, role copy, wallet chip, my checks, unresolved passport label ----
describe("readable errors", () => {
  it("maps API codes to sentences and keeps the raw body", () => {
    expect(describeError(new ApiError(402, { error: "PAYMENT_FAILED", payment: { state: "FAILED", reason: "payer balance below the authorized amount" } })).text).toBe("The check fee was not settled: payer balance below the authorized amount. Nothing was charged and no report was delivered.");
    expect(describeError(new ApiError(409, { error: "QUOTE_EXPIRED" })).text).toBe("The quote expired before signing; request a new quote.");
    expect(describeError(new ApiError(503, { error: "SETTLEMENT_PAUSED", retryAfterSeconds: 60 })).text).toContain("paused on the relayer side");
    expect(describeBody({ error: "DEMO_UNAVAILABLE", reason: "a previous business transaction is unresolved" })).toMatchObject({ code: "DEMO_UNAVAILABLE", text: "The live demo is unavailable right now: a previous business transaction is unresolved. Nothing was started." });
    expect(describeError(new ApiError(409, { error: "RUN_CONFLICT" })).text).toContain("already bound to a different scenario");
    expect(describeError(new ApiError(409, { error: "PASSPORT_NOT_READY", reason: "the run is still in progress" })).text).toBe("The passport is not available yet: the run is still in progress.");
    expect(describeError(new TypeError("Failed to fetch")).text).toContain("could not be reached");
    expect(describeError(new ApiError(418, { error: "SOMETHING_NEW", reason: "teapot" })).text).toBe("teapot.");
    expect(describeError(new Error("plain")).code).toBeNull();
  });
});

const ROW: any = { runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: ["LIVE_REQUEST"], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), network: "testnet", chainId: 5042002, decision: "NO_POLICY_VIOLATION", businessTxHash: D, businessStatus: "SUCCESS", chainStatus: "CONFIRMED", serviceFeeTx: D, durationMs: 31000, feeTokenAtomic: "10000", orderAmountNativeAtomic: "50000000000000000", businessPaidNativeAtomic: "50000000000000000", passportAvailable: true };

it("Demo's history table shows UTC time, network, money and a passport link, and pages with show more", async () => {
  memStorage();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { calls.push(path); if (path.startsWith("/v1/demo/runs?")) return response({ runs: [ROW], total: 2, limit: 12, offset: Number(new URL(path, "http://x").searchParams.get("offset")) }); return response({ runs: [] }); }));
  render(Demo); await flush(); let tree = render(Demo);
  const tableNode = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "RunsTable");
  expect(tableNode.props.runs).toEqual([ROW]); expect(tableNode.props.total).toBe(2);
  const table = render(() => tableNode.type(tableNode.props)); const text = content(table);
  expect(text).toContain("2026-10-03 12:00:00Z"); expect(text).toContain("0.01 USDC"); expect(text).toContain("0.05 USDC"); expect(text).toContain(" of 2");
  expect(nodes(table).some((n) => typeof n.type === "function" && n.type.name === "NetworkChip" && n.props.network === "testnet")).toBe(true);
  expect(nodes(table).some((n) => n.type === "a" && n.props.href === `/v1/demo/runs/${REQUEST}/passport` && typeof n.props.download === "string")).toBe(true);
  await button(table, "show more").props.onClick(); await flush(); tree = render(Demo);
  expect(calls.at(-1)).toBe("/v1/demo/runs?limit=12&offset=1");
});

it("RunPanel labels the passport of an unresolved attempt", () => {
  memStorage();
  const run: any = { ...DONE_RUN, state: "RECONCILE_REQUIRED", result: { ...DONE_RUN.result, execution: { ...DONE_RUN.result.execution, chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: D } } };
  const tree = render(() => RunPanel({ run, net: h.net }));
  expect(content(button(tree, "Download Payment Passport"))).toContain("outcome unresolved");
  expect(content(tree)).toContain("Payment result not yet established.");
});

describe("Developer: order-creator copy, readable refusals, my checks", () => {
  it("describes the order-creation role from /v1/network, warns when the admin key is in the process, and degrades on an instance without fixtures or with gated execution", async () => {
    developerApi();
    h.net.accounts = { orderSignerRole: "order-creator", adminKeyInProcess: false }; h.net.fixtures = [{ id: "APPROVED_PAYMENT", merchant: MERCHANT, proxy: "MAIN", baselineDigest: baselineHash, approvedImplementation: IMPL, implementation: IMPL }];
    let tree = render(Developer);
    expect(content(tree)).toContain("order-creator"); expect(content(tree)).toContain("a key that can only create orders");
    expect(button(tree, "Create order").props.disabled).toBe(false);
    freshHooks(); h.net.accounts = { orderSignerRole: "deployer-admin", adminKeyInProcess: true };
    tree = render(Developer);
    expect(content(tree)).toContain("admin key in process"); expect(content(tree)).toContain("deployer-admin");
    // the mainnet root instance: no fixtures → orders cannot be created here, the testnet switch is offered; the page renders without a wallet gate error
    freshHooks(); h.net = { ...h.net, network: "mainnet", chainId: 5042, deployments: null, fixtures: [{ id: "APPROVED_PAYMENT", merchant: null, proxy: "MAIN" }], access: { selfService: true, session: "/v1/session", publicExecution: false, walletExecution: false } };
    h.ctx = { instances: [ROOT_MAIN, SECOND_TEST], selected: ROOT_MAIN, choice: "mainnet", base: "", select: vi.fn(), link: (to: string) => to }; h.wallet.chainId = 5042;
    tree = render(Developer); await flush(); tree = render(Developer);
    expect(button(tree, "Create order").props.disabled).toBe(true); expect(content(tree)).toContain("fixtures are not deployed on");
    button(tree, "switch to Arc testnet").props.onClick(); expect(h.ctx.select).toHaveBeenCalledWith("testnet");
    // gated with fixtures (a mainnet instance before the acceptance): step 4 says so instead of attempting
    freshHooks(); h.net = { ...h.net, fixtures: [{ id: "APPROVED_PAYMENT", merchant: MERCHANT, proxy: "MAIN", baselineDigest: baselineHash }] };
    tree = render(Developer); await flush(); tree = render(Developer);
    expect(content(tree)).toContain("Execution is gated on this instance"); expect(content(tree)).toContain("Gated on this instance");
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("Execute with your wallet"))).toBe(false);
    // Gate D: an order is a project-paid transaction — "Create order…" is disabled on a gated instance and says why (the wallet is on the API's chain here)
    const create = button(tree, "Create order"); expect(create.props.disabled).toBe(true); expect(create.props.title).toBe("order creation is gated on this instance until the mainnet acceptance is recorded");
    expect(content(byTestId(tree, "order-gated"))).toContain("order creation is gated on this instance until the mainnet acceptance is recorded");
  });
  it("turns a refused fee settlement into a sentence (never raw JSON) and remembers the request", async () => {
    const api = developerApi(); const store = memStorage();
    const base = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/preflight") { const body = JSON.parse(init!.body as string); api.sent.push(body); if (!body.payment) return response(quoteFor(body.intent), 402); return response({ requestId: REQUEST, error: "PAYMENT_FAILED", payment: { state: "FAILED", reason: "payer balance below the authorized amount", backend: "relay", transaction: null } }, 402); }
      return base(path, init);
    });
    let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    const text = content(tree);
    expect(text).toContain("The check fee was not settled: payer balance below the authorized amount. Nothing was charged and no report was delivered.");
    expect(text).not.toContain("not delivered: {");
    expect(JSON.parse(store.get("arcpreflight.checks:root")!)[REQUEST]).toMatchObject({ requestId: REQUEST, subject: MERCHANT }); // scoped to the root instance (P2)
  });
  it("lists my checks from GET /v1/requests, runs recovery for an unsettled fee and fetches the private passport with the session's bearer token", async () => {
    memStorage({ "arcpreflight.session:root": JSON.stringify({ principal: "visitor:0", token: "offline-token" }) });
    const pendingRow = { requestId: REQUEST, clientRequestId: "dev-1", state: "WAITING_PAYMENT", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), intentDigest: D, subject: MERCHANT, orderId: D, valueNativeAtomic: "50000000000000000", reportDigest: D, payment: { state: "PENDING", backend: "relay", transaction: D }, passportAvailable: false };
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/v1/requests") return response({ requests: [pendingRow] });
      if (path === `/v1/requests/${REQUEST}/recover`) return response({ requestId: REQUEST, delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: D, backend: "relay" }, reportDigest: D, report: {} });
      if (path === `/v1/requests/${REQUEST}/passport`) return response({ passportBundleVersion: "1.0", files: { "manifest.json": "{}" } });
      return response({ requests: [] });
    }));
    render(Developer); await flush(); let tree = render(Developer);
    expect(content(tree)).toContain(REQUEST.slice(0, 8)); expect(content(tree)).toContain("\"pending\""); expect(content(tree)).toContain("\"relay\"");
    expect(button(tree, "Passport").props.disabled).toBe(true);
    await button(tree, "Run recovery").props.onClick(); tree = render(Developer);
    expect(calls.find((c) => c.path === `/v1/requests/${REQUEST}/recover`)?.init?.method).toBe("POST");
    expect(content(tree)).toContain("delivered"); expect(button(tree, "Passport").props.disabled).toBe(false);
    await button(tree, "Passport").props.onClick(); tree = render(Developer);
    const pp = calls.find((c) => c.path === `/v1/requests/${REQUEST}/passport`);
    expect((pp?.init?.headers as any)?.authorization).toBe("Bearer offline-token");
    expect(h.saveJson).toHaveBeenCalledWith(`arcpreflight-check-passport-${REQUEST.slice(0, 8)}.json`, { passportBundleVersion: "1.0", files: { "manifest.json": "{}" } });
  });
});

describe("WalletChip", () => {
  it("connected: shows the short address, opens the menu with copy / explorer / disconnect, and disconnects through the store", async () => {
    let tree = render(() => WalletChip({ net: h.net }));
    expect(content(tree)).toContain("0x0000…0a11");
    await button(tree, "0x0000…0a11").props.onClick(); tree = render(() => WalletChip({ net: h.net }));
    const text = content(tree);
    expect(text).toContain("copy"); expect(text).toContain("View on explorer"); expect(text).toContain("Disconnect"); expect(text).toContain(ACCOUNT); // the full address stays in the panel (visually hidden until "show full")
    expect(nodes(tree).some((n) => n.type === "a" && String(n.props.href).endsWith(`/address/${ACCOUNT}`))).toBe(true);
    expect(text).not.toContain("Switch to Arc"); // already on the API's chain
    await button(tree, "Disconnect").props.onClick();
    expect(h.wallet.disconnect).toHaveBeenCalledTimes(1);
  });
  it("on another chain offers the switch; disconnected it connects, and with several wallets it renders the picker", async () => {
    h.wallet.chainId = 1;
    let tree = render(() => WalletChip({ net: h.net }));
    await button(tree, "0x0000…0a11").props.onClick(); tree = render(() => WalletChip({ net: h.net }));
    expect(content(tree)).toContain("Switch to Arc");
    await button(tree, "Switch to Arc").props.onClick(); expect(h.wallet.switchChain).toHaveBeenCalledWith(h.net);
    freshHooks(); h.wallet.account = null; h.wallet.chainId = null;
    tree = render(() => WalletChip({ net: h.net }));
    await button(tree, "Connect wallet").props.onClick(); expect(h.wallet.connect).toHaveBeenCalledTimes(1);
    freshHooks(); h.wallet.picker = true; h.wallet.candidates = [{ info: { uuid: "a", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: {} }, { info: { uuid: "b", name: "OKX Wallet", icon: "", rdns: "com.okex.wallet" }, provider: {} }];
    tree = render(() => WalletChip({ net: h.net }));
    expect(content(tree)).toContain("MetaMask"); expect(content(tree)).toContain("OKX Wallet");
    await button(tree, "OKX Wallet").props.onClick(); expect(h.wallet.choose).toHaveBeenCalledWith("b");
  });
});

// ---- P2: dual network — links carry the backend, pages degrade on an instance without fixtures, per-network storage ----
import { RunsTable } from "../src/components/RunsTable";
const ROOT_MAIN = { base: "", network: "mainnet", chainId: 5042, caip2: "eip155:5042", release: "r" };
const SECOND_TEST = { base: "/testnet", network: "testnet", chainId: 5042002, caip2: "eip155:5042002", release: "t" };
describe("dual network (P2)", () => {
  it("Demo on an instance without deployed fixtures explains itself, keeps the run button disabled and offers the testnet switch", async () => {
    memStorage();
    h.net = { ...h.net, network: "mainnet", chainId: 5042, caip2: "eip155:5042", deployments: null, fixtures: [{ id: "APPROVED_PAYMENT", merchant: null, title: "approved", headline: "CONFIRMED", proxy: "MAIN" }], budget: { maxRunsPerDay: 0, usedToday: 0, clientCooldownSeconds: 45 } };
    h.ctx = { instances: [ROOT_MAIN, SECOND_TEST], selected: ROOT_MAIN, choice: "mainnet", base: "", select: vi.fn(), link: (to: string) => to };
    vi.stubGlobal("fetch", vi.fn(async () => response({ runs: [], total: 0 })));
    render(Demo); await flush(); const tree = render(Demo);
    expect(content(tree)).toContain("No fixtures are deployed on"); expect(content(tree)).toContain("Arc mainnet"); // JSX splits the sentence into children
    expect(button(tree, "live").props.disabled).toBe(true);
    button(tree, "switch to Arc testnet").props.onClick(); expect(h.ctx.select).toHaveBeenCalledWith("testnet");
    expect(content(tree)).not.toContain("testnet preview"); // the page-level banner moved to the shared notice under the nav
  });
  it("run links carry ?net= from the context when the selected instance is not the root", () => {
    memStorage();
    h.ctx = { link: (to: string) => `${to}${to.includes("?") ? "&" : "?"}net=testnet`, selected: SECOND_TEST };
    const table = render(() => RunsTable({ runs: [ROW], net: h.net, total: 1 }));
    const open = nodes(table).find((n) => n.props?.className === "btn sm ghost" && content(n).includes("open"));
    expect(open.props.to).toBe(`/runs/${REQUEST}?net=testnet`);
  });
  it("My checks shows why a payment failed, and the session is the selected instance's own (testnet session never reaches the root)", async () => {
    memStorage({ "arcpreflight.session:/testnet": JSON.stringify({ principal: "visitor:t", token: "tok-testnet" }), "arcpreflight.session:root": JSON.stringify({ principal: "visitor:m", token: "tok-mainnet" }) });
    h.net = { ...h.net, network: "testnet" }; setApiBase("/testnet");
    h.ctx = { instances: [ROOT_MAIN, SECOND_TEST], selected: SECOND_TEST, choice: "testnet", base: "/testnet", select: vi.fn(), link: (to: string) => `${to}?net=testnet` };
    const row = { requestId: REQUEST, clientRequestId: "c", state: "WAITING_PAYMENT", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), intentDigest: D, subject: MERCHANT, orderId: D, valueNativeAtomic: "50000000000000000", reportDigest: null, payment: { state: "FAILED", backend: "relay", transaction: null, reason: "payer balance below the authorized amount" }, passportAvailable: false };
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { if (path === "/testnet/v1/requests") { expect((init!.headers as any).authorization).toBe("Bearer tok-testnet"); return response({ requests: [row] }); } throw new Error(`Unexpected URL: ${path}`); }));
    render(Developer); await flush(); const tree = render(Developer);
    expect(content(tree)).toContain("visitor:t"); expect(content(tree)).not.toContain("visitor:m");
    expect(content(tree)).toContain("payer balance below the authorized amount");
    expect(content(tree)).toContain("\"failed\""); expect(content(tree)).toContain("\"relay\"");
  });
});

// ---- P3: hands-on feedback — faucet, public trial token, wallet mode, direct hash links, run strip ----
const FAUCET = { enabled: true, amountNativeAtomic: "200000000000000000", perDay: 30, usedToday: 1, perAddressPer24h: 1, sender: null };
const CHANGED_FIXTURE = { id: "CHANGED_IMPLEMENTATION", merchant: MERCHANT, title: "changed", headline: "REVIEW_REQUIRED", proxy: "CHANGED", baselineDigest: baselineHash, approvedImplementation: IMPL, blurb: "" };
const APPROVED_FIXTURE = { id: "APPROVED_PAYMENT", merchant: MERCHANT, title: "approved", headline: "CONFIRMED", proxy: "MAIN", baselineDigest: baselineHash, approvedImplementation: IMPL, blurb: "" };
/** the API as the wallet mode sees it: order on the requested proxy, 402 quote, delivered report (baselineResult per fixture), approved baseline */
function walletApi(baselineResult = "MATCH") {
  const sent: any[] = []; const orders: any[] = []; const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    paths.push(path);
    if (path === "/v1/session") return response(SESSION(paths.filter((x) => x === "/v1/session").length), 201);
    if (path === "/v1/demo/orders") { const body = JSON.parse(init!.body as string); orders.push(body); return response({ ...order, proxy: body.proxy }, 201); }
    if (path === "/v1/requests") return response({ requests: [] });
    if (path.startsWith("/v1/baselines/")) return response({ baselineDigest: baselineHash, baseline, revoked: false });
    if (path === "/v1/preflight") {
      const body = JSON.parse(init!.body as string); sent.push(body);
      if (!body.payment) return response(quoteFor(body.intent), 402);
      const report = { ...reportFor(body.intent), baselineResult };
      return response({ delivery: "DELIVERED", report, reportDigest: reportDigest(report as any), simulation: { ok: true, error: null }, payment: { transaction: D } });
    }
    if (path === "/v1/faucet") return response({ ok: true, txHash: D, amountNativeAtomic: FAUCET.amountNativeAtomic, address: JSON.parse(init!.body as string).address });
    if (path.startsWith("/v1/demo/runs")) return response({ runs: [], total: 0 });
    throw new Error(`Unexpected URL: ${path}`);
  }));
  return { sent, orders, paths };
}
const walletPanel = (tree: any) => nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "WalletRunPanel");

describe("P3 · faucet", () => {
  it("maps the five faucet refusals to sentences that say nothing was sent", () => {
    expect(describeError(new ApiError(404, { error: "FAUCET_DISABLED" })).text).toBe("The faucet exists on Arc testnet only; nothing was sent.");
    expect(describeError(new ApiError(429, { error: "FAUCET_COOLDOWN", reason: "this wallet already claimed testnet USDC in the last 24 hours" })).text).toBe("this wallet already claimed testnet USDC in the last 24 hours. Nothing was sent.");
    expect(describeError(new ApiError(429, { error: "FAUCET_BUDGET_EXHAUSTED", reason: "the faucet's daily budget (30 claims) is used; try again tomorrow" })).text).toContain("daily budget (30 claims) is used");
    expect(describeError(new ApiError(503, { error: "FAUCET_EMPTY" })).text).toContain("below its floor");
    expect(describeError(new ApiError(503, { error: "FAUCET_FAILED", reason: "the faucet transaction reverted (0xabc)" })).text).toBe("The faucet transaction did not go through: the faucet transaction reverted (0xabc). Check your balance before claiming again.");
    for (const code of ["FAUCET_DISABLED", "FAUCET_COOLDOWN", "FAUCET_BUDGET_EXHAUSTED", "FAUCET_EMPTY"]) expect(describeError(new ApiError(429, { error: code })).text.toLowerCase()).toContain("nothing was sent");
  });
  it("Demo mounts the faucet card with the wallet's balance and disables the wallet run while the fee cannot be paid; the card claims with one POST", async () => {
    memStorage(); h.net.fixtures = [CHANGED_FIXTURE]; h.net.faucet = FAUCET; h.balance = 0n;
    const api = walletApi();
    render(Demo); await flush(); let tree = render(Demo);
    const card = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FaucetCard");
    expect(card.props).toMatchObject({ net: h.net, balance: 0n, required: 10_000_000_000_000_000n }); expect(card.props.wallet.account).toBe(ACCOUNT); // the quick check needs the fee only
    expect(button(tree, "with your wallet").props.disabled).toBe(true); // cannot pay the 0.01 USDC fee yet
    expect(faucetOffered(h.net, h.wallet, 0n, 10_000_000_000_000_000n)).toBe(true);
    // the card on its own: text, one POST with the address, the transaction link afterwards
    freshHooks();
    let rendered = render(() => FaucetCard({ net: h.net, wallet: h.wallet, balance: 0n, required: 63_000_000_000_000_000n, step: "buying the report" }));
    expect(content(rendered)).toContain("Claim testnet USDC"); expect(content(rendered)).toContain("buying the report"); expect(content(rendered)).toContain("0.063"); expect(content(rendered)).toContain("check fee + order amount + gas reserve"); expect(content(rendered)).not.toContain("0.05 USDC order");
    await button(rendered, "Claim testnet USDC").props.onClick(); rendered = render(() => FaucetCard({ net: h.net, wallet: h.wallet, balance: 0n, required: 63_000_000_000_000_000n }));
    expect(api.paths.filter((p) => p === "/v1/faucet")).toHaveLength(1);
    expect(JSON.parse((vi.mocked(fetch).mock.calls.find((c) => c[0] === "/v1/faucet")![1] as RequestInit).body as string)).toEqual({ address: ACCOUNT });
    expect(content(rendered)).toContain("Sent 0.20 USDC"); expect(content(button(rendered, "Claimed"))).toContain("Claimed ✓");
    freshHooks(); expect(render(() => FaucetCard({ net: h.net, wallet: h.wallet, balance: 10n ** 18n, required: 63_000_000_000_000_000n }))).toBeNull(); // funded for the step (and no claim in this card): nothing offered
    // never on a mainnet instance, never when funded, never on another chain
    expect(faucetOffered({ ...h.net, network: "mainnet", chainId: 5042 }, { account: ACCOUNT, chainId: 5042 }, 0n, 1n)).toBe(false);
    expect(faucetOffered(h.net, { account: ACCOUNT, chainId: 5042002 }, 10n ** 18n, 63_000_000_000_000_000n)).toBe(false);
    expect(faucetOffered(h.net, { account: ACCOUNT, chainId: 1 }, 0n, 1n)).toBe(false);
    expect(faucetOffered({ ...h.net, faucet: { enabled: false } }, { account: ACCOUNT, chainId: 5042002 }, 0n, 1n)).toBe(false);
    freshHooks(); h.balance = 10n ** 18n;
    render(Demo); await flush(); tree = render(Demo); expect(button(tree, "with your wallet").props.disabled).toBe(false);
    freshHooks(); h.balance = 0n; h.wallet.chainId = 1;
    render(Demo); await flush(); tree = render(Demo); expect(content(tree)).toContain("Switch to Arc testnet first");
  });
  it("WalletChip offers 'Claim testnet USDC' in the menu on the testnet instance only", async () => {
    h.net.faucet = FAUCET;
    let tree = render(() => WalletChip({ net: h.net }));
    await button(tree, "0x0000…0a11").props.onClick(); tree = render(() => WalletChip({ net: h.net }));
    expect(content(tree)).toContain("Claim testnet USDC");
    freshHooks(); h.net = { ...h.net, network: "mainnet", chainId: 5042 }; h.wallet.chainId = 5042;
    tree = render(() => WalletChip({ net: h.net }));
    await button(tree, "0x0000…0a11").props.onClick(); tree = render(() => WalletChip({ net: h.net }));
    expect(content(tree)).not.toContain("Claim testnet USDC");
  });
});

describe("P3 · run with your wallet", () => {
  it("Demo shows two run buttons when a wallet is connected on the API's chain, and the wallet flow for CHANGED orders on the CHANGED proxy and ends REVIEW_REQUIRED without executing", async () => {
    memStorage(); h.net.fixtures = [CHANGED_FIXTURE];
    const api = walletApi("IMPLEMENTATION_CHANGED");
    render(Demo); await flush(); let tree = render(Demo);
    const wallet = button(tree, "with your wallet"), project = button(tree, "live · project runner");
    expect(wallet.props.disabled).toBe(false); expect(project.props.disabled).toBe(false);
    expect(content(tree)).not.toContain("WALLET_MODE");
    await wallet.props.onClick(); await flush(); tree = render(Demo);
    expect(api.orders).toEqual([{ payer: ACCOUNT, proxy: "CHANGED" }]);
    expect(api.paths.filter((x) => x === "/v1/session")).toHaveLength(1); // one anonymous session, created lazily by the first paid action and reused
    expect(api.paths.indexOf("/v1/session")).toBeGreaterThan(api.paths.indexOf("/v1/demo/runs?limit=12&offset=0")); // listing runs never created it
    expect(storedSession("")).toEqual(SESSION(1));
    expect(api.sent).toHaveLength(2); expect(api.sent[1].payment.authorization).toMatchObject({ from: ACCOUNT, to: MERCHANT, value: "10000" });
    expect(h.sign).toHaveBeenCalledTimes(1);
    const panel = walletPanel(tree);
    expect(panel.props.run.phase).toBe("done"); expect(panel.props.run.decision.decision).toBe("REVIEW_REQUIRED");
    expect(panel.props.run.steps.map((s: any) => s.step)).toEqual(["createOrder", "intent", "quote", "signServiceFee", "reportDelivered", "decision", "notSigned"]);
    expect(panel.props.run.handoff).toBe(false); // a REVIEW_REQUIRED check is not handed over for execution
    const methods = h.wallet.provider.request.mock.calls.map((c: any[]) => c[0].method);
    for (const forbidden of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_signTransaction"]) expect(methods).not.toContain(forbidden);
    expect(nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "RunPanel")).toBeUndefined(); // the project-runner panel is not shown for a wallet run
    expect(nodes(tree).some((n) => n.props?.className === "pick-row")).toBe(true); // the fixture cards collapsed while a run shows
    freshHooks();
    const rendered = render(() => WalletRunPanel({ run: panel.props.run, net: h.net, account: ACCOUNT, fixture: CHANGED_FIXTURE as any }));
    const text = content(rendered);
    expect(text).toContain("This payment is outside the referenced approval."); expect(text).toContain("the check decided REVIEW_REQUIRED; nothing is executed");
    expect(text).not.toMatch(/wallet execution is off/);
    expect(text).toContain("WALLET_CHECK"); expect(text).toContain("implementation changed");
    expect(nodes(rendered).filter((n) => typeof n.type === "function" && n.type.name === "DecisionBadge").map((n) => n.props.decision)).toContain("REVIEW_REQUIRED");
  });
  it("the wallet check for APPROVED ends NO_POLICY_VIOLATION, executes nothing itself and hands the order and check over to the Developer workflow", async () => {
    const store = memStorage(); h.net.fixtures = [CHANGED_FIXTURE, APPROVED_FIXTURE];
    const api = walletApi("MATCH");
    render(Demo); await flush(); let tree = render(Demo);
    expect(nodes(tree).find((n) => n.type === "button" && n.props["data-fixture"] === "APPROVED_PAYMENT").props["aria-pressed"]).toBe(true); // the approved payment is the default situation
    nodes(tree).find((n) => n.type === "button" && n.props["data-fixture"] === "CHANGED_IMPLEMENTATION").props.onClick(); tree = render(Demo);
    expect(content(button(tree, "with your wallet"))).toContain("review required");
    nodes(tree).find((n) => n.type === "button" && n.props["data-fixture"] === "APPROVED_PAYMENT").props.onClick(); tree = render(Demo);
    expect(content(button(tree, "with your wallet"))).toContain("confirmed");
    await button(tree, "with your wallet").props.onClick(); await flush(); tree = render(Demo);
    expect(api.orders).toEqual([{ payer: ACCOUNT, proxy: "MAIN" }]);
    const run = walletPanel(tree).props.run;
    expect(run.phase).toBe("done"); expect(run.decision.decision).toBe("NO_POLICY_VIOLATION"); expect(run.handoff).toBe(true);
    expect(run.steps.at(-1).step).toBe("readyToExecute"); expect(run.steps.at(-1).why).toContain("execute from the Developer workflow with your wallet");
    const saved = JSON.parse(store.get("arcpreflight.workflow:root")!)[ACCOUNT.toLowerCase()];
    expect(saved).toMatchObject({ payer: ACCOUNT, orderId: order.orderId, proxy: "MAIN", approved: true, requestId: REQUEST, handoff: "demo" }); expect(saved.intent.clientRequestId).toBe(api.sent[1].intent.clientRequestId); // the exact quoted intent travels with the handoff
    const methods = h.wallet.provider.request.mock.calls.map((c: any[]) => c[0].method);
    expect(methods).not.toContain("eth_sendTransaction"); expect(methods).not.toContain("eth_sendRawTransaction"); expect(methods).not.toContain("eth_estimateGas"); // the check builds no client-side plan: the server's validated plan is the only plan
    freshHooks();
    const rendered = render(() => WalletRunPanel({ run, net: h.net, account: ACCOUNT, fixture: APPROVED_FIXTURE as any }));
    expect(content(rendered)).toContain("Execute from the Developer workflow with your wallet"); expect(content(rendered)).toContain("not executed here");
    expect(nodes(rendered).some((n) => n.props?.to === "/developer#step-4")).toBe(true);
  });
  it("disconnected, only the project runner button shows with a hint; connected on another chain the wallet button becomes the switch", async () => {
    memStorage(); h.net.fixtures = [CHANGED_FIXTURE]; walletApi();
    h.wallet.account = null; h.wallet.chainId = null;
    render(Demo); await flush(); let tree = render(Demo);
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("with your wallet"))).toBe(false);
    expect(button(tree, "live · project runner").props.disabled).toBe(false); expect(content(tree)).toContain("connect a wallet in the header");
    freshHooks(); h.wallet.account = ACCOUNT; h.wallet.chainId = 1;
    render(Demo); await flush(); tree = render(Demo);
    await button(tree, "Switch to Arc testnet first").props.onClick(); expect(h.wallet.switchChain).toHaveBeenCalledWith(h.net);
  });
});

describe("P3 · anonymous session (open self-service)", () => {
  it("Developer creates the session on the first paid action only, reuses it for quote and purchase, and lists My checks under it", async () => {
    const store = memStorage(); const api = developerApi();
    render(Developer); await flush(); let tree = render(Developer);
    expect(api.sessions()).toBe(0); // rendering and listing never create a session
    expect(content(tree)).toContain("no session yet"); expect(content(tree)).toContain("your browser holds an anonymous session");
    button(tree, "Create order").props.onClick(); tree = render(Developer);
    expect(api.sessions()).toBe(0); // opening the dialog creates nothing
    const dlg = dialogNode(tree); const created = await dlg.props.create({ payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: "50000000000000000" });
    dlg.props.onCreated(created); render(Developer); await flush(); tree = render(Developer);
    expect(api.sessions()).toBe(1); expect(JSON.parse(store.get("arcpreflight.session:root")!)).toEqual(SESSION(1));
    expect(content(tree)).toContain("visitor:1");
    button(tree, "Approve & continue").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick(); render(Developer); await flush(); tree = render(Developer);
    expect(api.sessions()).toBe(1);
    const auths = api.fetch.mock.calls.filter((c) => c[0] !== "/v1/session").map((c) => (c[1] as RequestInit | undefined)?.headers as any).map((hd) => hd?.authorization).filter(Boolean);
    expect(new Set(auths)).toEqual(new Set(["Bearer sess-1"]));
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
  });
  it("a 401 from a stored session replaces it once and retries the call; the sentence explains if even that fails", async () => {
    const store = memStorage({ "arcpreflight.session:root": JSON.stringify({ principal: "visitor:old", token: "sess-old" }) });
    const api = developerApi();
    const seen: string[] = []; let sessions = 0;
    api.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const auth = (init?.headers as any)?.authorization; const method = init?.method ?? "GET";
      if (path === "/v1/session") { sessions++; return response(SESSION(9), 201); }
      if (auth === "Bearer sess-old") { seen.push(`${path}:old`); return response({ error: "UNAUTHENTICATED" }, 401); }
      seen.push(`${path}:${auth}`);
      if (path === "/v1/requests") return response({ requests: [] });
      if (path === "/v1/demo/orders" && method === "POST") return response(CREATED, 201);
      if (path === "/v1/demo/orders") return response({ orders: [] });
      if (path.startsWith("/v1/demo/orders/")) return response(ORDER_VIEW);
      if (path === "/v1/wallet/attempts") return response({ attempts: [] });
      throw new Error(`Unexpected URL: ${path}`);
    });
    render(Developer); await flush(); let tree = render(Developer);
    // the three listings (checks, orders, attempts) all met the dead token: ONE replacement, every call retried with the new session
    expect(sessions).toBe(1);
    expect(seen.filter((x) => x.endsWith(":old")).sort()).toEqual(["/v1/demo/orders:old", "/v1/requests:old", "/v1/wallet/attempts:old"]);
    expect(seen.filter((x) => !x.endsWith(":old")).sort()).toEqual(["/v1/demo/orders:Bearer sess-9", "/v1/requests:Bearer sess-9", "/v1/wallet/attempts:Bearer sess-9"]);
    expect(JSON.parse(store.get("arcpreflight.session:root")!)).toEqual(SESSION(9));
    button(tree, "Create order").props.onClick(); tree = render(Developer);
    const dlg = dialogNode(tree); dlg.props.onCreated(await dlg.props.create({ payer: ACCOUNT, proxy: "MAIN" })); render(Developer); await flush(); tree = render(Developer);
    expect(seen).toContain("/v1/demo/orders:Bearer sess-9"); expect(sessions).toBe(1); expect(content(tree)).toContain(order.orderId.slice(0, 10));
    expect(describeError(new ApiError(401, { error: "UNAUTHENTICATED" })).text).toBe("This browser's session is no longer valid; a new one was created — try again.");
  });
});

describe("P3 · hashes, run strip", () => {
  it("Hex renders the hash itself as the explorer link (new tab, no copy handler); without a link it is plain text", () => {
    const linked = render(() => Hex({ value: D, n: 4, link: "http://offline.invalid/tx/x" }));
    expect(linked.type).toBe("a"); expect(linked.props.href).toBe("http://offline.invalid/tx/x"); expect(linked.props.target).toBe("_blank"); expect(linked.props.rel).toBe("noreferrer");
    expect(content(linked)).toContain("0x1111…1111"); expect(linked.props.onClick).toBeUndefined();
    const plain = render(() => Hex({ value: D }));
    expect(plain.type).toBe("span"); expect(plain.props.onClick).toBeUndefined(); expect(plain.props.title).toBe(D);
    expect(render(() => Hex({ value: null })).props.className).toBe("dim");
  });
  it("Demo shows the sticky run strip with the stage count while a project run is RUNNING, and hides it once done", async () => {
    memStorage(); h.net.fixtures = [CHANGED_FIXTURE];
    let state = "RUNNING";
    const run = () => ({ runId: REQUEST, fixture: "CHANGED_IMPLEMENTATION", state, labels: ["LIVE_REQUEST"], steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "quote", atMs: 3 }, { step: "signServiceFee", atMs: 4 }], result: null, recovery: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/v1/demo/run") return response({ runId: REQUEST, poll: `/v1/demo/runs/${REQUEST}`, admission: "new" }, 202);
      if (path === `/v1/demo/runs/${REQUEST}`) return response(run());
      return response({ runs: [], total: 0 });
    }));
    render(Demo); await flush(); await button(render(Demo), "live").props.onClick(); await flush(); let tree = render(Demo);
    const strip = nodes(tree).find((n) => n.props?.className === "runstrip");
    expect(strip).toBeDefined(); expect(content(strip)).toContain("project runner"); expect(content(strip)).toContain("preflight check (step 3/7)"); expect(button(strip, "view")).toBeDefined();
    expect(nodes(tree).some((n) => n.props?.className === "pick-row")).toBe(true);
    state = "DONE"; await vi.advanceTimersByTimeAsync(1500); tree = render(Demo);
    expect(nodes(tree).find((n) => n.props?.className === "runstrip")).toBeUndefined();
  });
});

// ---- review round 2 (docs/LIFECYCLE.md §9): per-payer workflow, budget before paying, demo entry points, ambiguous submission, cost labels, verification state ----
const OTHER_ACCOUNT = "0x0000000000000000000000000000000000000B11";
const UNIT_FIXTURE = { id: "AMOUNT_UNIT_MISMATCH", merchant: MERCHANT, title: "units", headline: "BLOCKED", proxy: "MAIN", baselineDigest: baselineHash, approvedImplementation: IMPL, blurb: "" };
const FEE_TX = `0x${"aa".repeat(32)}`, CREATE_TX = `0x${"bb".repeat(32)}`, BIZ_TX = `0x${"cc".repeat(32)}`;
/** a 1.0 cost statement whose business receipt was missing at export */
const STATEMENT_10: any = { costStatementVersion: "1.0", unit: "USDC", nativeDecimals: 18, tokenDecimals: 6, capturedAt: NOW.toISOString(),
  buyer: { address: "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE", businessPrincipal: { nativeAtomic: "50000000000000000", usdc: "0.05" }, checkFee: { tokenAtomic: "10000", nativeAtomicEquivalent: "10000000000000000", usdc: "0.01" }, businessGas: null, totalNativeAtomic: "60000000000000000", totalUsdc: "0.06" },
  operator: { feeRelay: { nativeAtomic: "2178625000000000", usdc: "0.002178625", gasUsed: "87145", effectiveGasPriceNativeAtomic: "25000000000", tx: FEE_TX, address: null }, orderCreation: { nativeAtomic: "2507300000000000", usdc: "0.0025073", gasUsed: "100292", effectiveGasPriceNativeAtomic: "25000000000", tx: CREATE_TX, address: null }, totalNativeAtomic: "4685925000000000", totalUsdc: "0.004685925" },
  authorizedMaximum: { businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: "1181315000000000" }, actual: { businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: null },
  unresolvedReservation: { nativeAtomic: "0", note: "reservations released only after reconciliation" }, sources: { feeTx: FEE_TX, createOrderTx: CREATE_TX, businessTx: BIZ_TX }, notes: [] };
const verifierResult = (statuses: Record<string, string>): any => {
  const findings = Object.entries(statuses).map(([id, status]) => ({ id, status, detail: `${id} detail` }));
  const counts = { pass: 0, fail: 0, unverified: 0, notEvaluated: 0 };
  for (const f of findings) { if (f.status === "PASS") counts.pass++; else if (f.status === "FAIL") counts.fail++; else if (f.status === "UNVERIFIED") counts.unverified++; else counts.notEvaluated++; }
  return { passportVersion: "1.0", subject: { kind: "wallet-run", executionMode: "wallet" }, chain: { chainId: 5042002, caip2: "eip155:5042002" }, findings, counts };
};
const ALL_PASS: Record<string, string> = { FILE_INTEGRITY: "PASS", DIGEST_INTEGRITY: "PASS", DISCLOSURE: "PASS", APPROVAL_SOURCE: "PASS", APPROVAL_COVERAGE: "PASS", NETWORK_IDENTITY: "PASS", FEE_ATTRIBUTION: "PASS", TRANSACTION_PLAN_AGREEMENT: "PASS", ORDER_OUTCOME: "PASS", COST_STATEMENT: "PASS", CURRENT_ELIGIBILITY: "NOT_EVALUATED" };
const byTestId = (tree: any, id: string) => nodes(tree).find((n) => n.props?.["data-testid"] === id);
const fnNode = (tree: any, name: string) => nodes(tree).find((n) => typeof n.type === "function" && n.type.name === name);

describe("round 2 · the workflow identity is per payer", () => {
  it("a different connected account starts at step 1, never inherits the first account's order, and sees it read-only under 'other wallets in this browser'; switching back restores it", async () => {
    const store = memStorage(); developerApi(); h.net.fixtures = [APPROVED_FIXTURE];
    let tree = await createDeveloperOrder();
    expect(fnNode(tree, "OrderCard").props.order.orderId).toBe(order.orderId); expect(content(button(tree, "Approved"))).toContain("Approved ✓");
    expect(Object.keys(JSON.parse(store.get("arcpreflight.workflow:root")!))).toEqual([ACCOUNT.toLowerCase()]);
    // the wallet switches to another account
    h.wallet.account = OTHER_ACCOUNT; render(Developer); await flush(); tree = render(Developer);
    expect(fnNode(tree, "OrderCard")).toBeUndefined(); // step 1 again: the first account's order is not shown as this account's
    expect(button(tree, "Create order").props.disabled).toBe(false);
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("Approved ✓"))).toBe(false);
    const others = byTestId(tree, "other-wallets"); expect(others).toBeDefined();
    expect(content(others)).toContain(order.orderId); expect(content(others)).toContain(ACCOUNT); // listed with its wallet, read-only
    expect(nodes(others).some((n) => n.type === "button" && content(n).includes("use"))).toBe(false); // no "use" — that would relabel it
    expect(byTestId(tree, "my-orders")).toBeUndefined();
    expect(Object.keys(JSON.parse(store.get("arcpreflight.workflow:root")!))).toEqual([ACCOUNT.toLowerCase()]); // nothing was saved under the new account
    // …and back: the first account's saved workflow is read again from the server
    h.wallet.account = ACCOUNT; render(Developer); await flush(); tree = render(Developer); await flush(); tree = render(Developer);
    expect(fnNode(tree, "OrderCard")?.props.order.orderId).toBe(order.orderId); expect(content(button(tree, "Approved"))).toContain("Approved ✓");
    expect(byTestId(tree, "other-wallets")).toBeUndefined();
  });
  it("a test build banner never appears in a non-test build, and the production copy never mentions the test wallet switch", async () => {
    developerApi(); h.ctx = { testWallet: true };
    const tree = render(Developer);
    expect(content(tree).toLowerCase()).not.toContain("testwallet");
  });
});

describe("round 2 · the budget before a paid step", () => {
  it("an unfunded wallet cannot buy the report: the button is disabled with the exact sentence and the faucet card asks for the same amount", async () => {
    h.balance = 0n; h.net.faucet = FAUCET; developerApi();
    let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    expect(button(tree, "Sign TransferWithAuthorization").props.disabled).toBe(true);
    const sentence = "your wallet holds 0 USDC; this step needs ≥ 0.063 USDC (fee + order + gas)"; // 0.01 fee + 0.05 order + 0.003 gas reserve
    expect(content(byTestId(tree, "budget-buy"))).toContain(sentence); expect(button(tree, "Sign TransferWithAuthorization").props.title).toBe(sentence);
    const card = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FaucetCard" && n.props.step === "buying the report");
    expect(card.props.required).toBe(63_000_000_000_000_000n); expect(card.props.balance).toBe(0n);
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("a wallet that paid the fee but cannot cover order + gas cannot execute: disabled with the sentence; the faucet card follows", async () => {
    h.balance = 10n ** 18n; h.net.faucet = FAUCET; developerApi();
    let tree = await createDeveloperOrder();
    await button(tree, "Get quote").props.onClick(); tree = render(Developer);
    await button(tree, "Sign TransferWithAuthorization").props.onClick();
    h.balance = 20_000_000_000_000_000n; // 0.02 USDC left after the fee: less than the 0.053 the execution needs (order + default gas reserve; the fee is paid)
    render(Developer); await flush(); tree = render(Developer);
    expect(badge(tree).props.decision).toBe("NO_POLICY_VIOLATION");
    const exec = button(tree, "Execute with your wallet");
    expect(exec.props.disabled).toBe(true); expect(exec.props.title).toBe("your wallet holds 0.02 USDC; this step needs ≥ 0.053 USDC (order + gas; the check fee is already paid)");
    expect(content(byTestId(tree, "budget-exec"))).toContain("this step needs ≥ 0.053 USDC");
    const card = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "FaucetCard" && n.props.step === "executing the payment");
    expect(card.props.required).toBe(53_000_000_000_000_000n); expect(card.props.needs).toContain("the check fee is already paid");
    expect(h.wallet.provider.request.mock.calls.some((c: any[]) => c[0].method === "eth_sendTransaction")).toBe(false);
  });
});

describe("round 2 · Demo entry points and scenario order", () => {
  it("two explicit entry points; the approved payment first and selected by default; situations are buttons with aria-pressed; the wallet check sits under 'Try with my wallet'", async () => {
    memStorage(); h.net.fixtures = [CHANGED_FIXTURE, UNIT_FIXTURE, APPROVED_FIXTURE]; // the API's order is not the page's
    vi.stubGlobal("fetch", vi.fn(async () => response({ runs: [], total: 0 })));
    render(Demo); await flush(); let tree = render(Demo);
    const text = content(tree);
    expect(text).toContain("Watch a project-funded demo"); expect(text).toContain("Try with my wallet"); expect(text).toContain("project funds"); expect(text).toContain("Your wallet is not involved");
    const cards = () => nodes(tree).filter((n) => n.type === "button" && n.props["data-fixture"]);
    expect(cards().map((c) => c.props["data-fixture"])).toEqual(["APPROVED_PAYMENT", "AMOUNT_UNIT_MISMATCH", "CHANGED_IMPLEMENTATION"]);
    expect(cards().map((c) => c.props["aria-pressed"])).toEqual([true, false, false]); expect(cards().every((c) => c.props.type === "button")).toBe(true);
    expect(button(tree, "Run live · project runner")).toBeDefined(); expect(button(tree, "simulated interruption")).toBeDefined();
    cards()[1].props.onClick(); tree = render(Demo);
    expect(cards().map((c) => c.props["aria-pressed"])).toEqual([false, true, false]);
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("simulated interruption"))).toBe(false); // only the approved payment has the interruption
    expect(content(button(tree, "live · project runner"))).toContain("blocked");
    const tryEntry = byTestId(tree, "entry-try");
    expect(nodes(tryEntry).some((n) => n.type === "button" && content(n).includes("with your wallet"))).toBe(true); // the check lives under "Try with my wallet"
    expect(content(tryEntry)).toContain("that fee is yours"); expect(content(tryEntry)).toContain("execution continues in the Developer workflow");
    expect(nodes(tryEntry).some((n) => n.props?.to === "/developer")).toBe(true);
    // Home's hero and guide use the same two labels
    freshHooks(); const home = render(Home); const ht = content(home);
    expect(ht).toContain("Watch a project-funded demo"); expect(ht).toContain("Try with my wallet"); expect(ht).not.toContain("Run it live on");
    expect(nodes(home).filter((n) => n.props?.to === "/demo" && content(n).includes("Watch a project-funded demo")).length).toBeGreaterThan(0);
    expect(nodes(home).filter((n) => n.props?.to === "/developer" && content(n).includes("Try with my wallet")).length).toBeGreaterThan(0);
  });
});

describe("round 2 · ambiguous submission in the panel", () => {
  it("while reconciling: the wallet-did-not-return-a-hash copy; afterwards the explicit 'I rejected it — abandon'; never 'Continue in wallet', never 'nothing was sent'", async () => {
    const { AttemptPanel } = await import("../src/components/AttemptPanel");
    const err = { text: "Request timed out.", code: null, raw: null };
    const actions = { onAbandon: vi.fn(), onResume: vi.fn(), onRecover: vi.fn() };
    let tree = render(() => AttemptPanel({ attempt: VALIDATED, phase: "unknown-submission", err, net: h.net, busy: true, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain(AMBIGUOUS_TEXT);
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("Continue in wallet"))).toBe(false);
    expect(content(tree).toLowerCase()).not.toContain("nothing was sent");
    freshHooks();
    tree = render(() => AttemptPanel({ attempt: VALIDATED, phase: "unknown-submission", err, net: h.net, busy: false, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain("reconciliation found no payment for this order yet");
    expect(button(tree, "I rejected it — abandon")).toBeDefined(); expect(button(tree, "Recover")).toBeDefined();
    expect(nodes(tree).some((n) => n.type === "button" && content(n).includes("Continue in wallet"))).toBe(false);
    expect(nodes(tree).some((n) => n.type === "button" && /execute again/i.test(content(n)))).toBe(false);
    expect(content(tree).toLowerCase()).not.toContain("nothing was sent");
    button(tree, "I rejected it — abandon").props.onClick(); expect(actions.onAbandon).toHaveBeenCalledWith(ATTEMPT_ID);
    // a plainly validated attempt (no ambiguity) still offers the wallet
    freshHooks(); tree = render(() => AttemptPanel({ attempt: VALIDATED, phase: "idle", net: h.net, now: NOW.getTime(), actions }));
    expect(button(tree, "Continue in wallet")).toBeDefined(); expect(button(tree, "Abandon (nothing sent)")).toBeDefined();
  });
});

describe("round 2 · one cost statement, labelled by role, never a bare incomplete total", () => {
  it("a project-funded run reads 'project demo-runner — project-funded' and a missing gas receipt reads 'incomplete'; the run panel and the attempt panel pass their context", async () => {
    const { CostTable } = await import("../src/components/CostTable");
    let tree = render(() => CostTable({ statement: STATEMENT_10, net: h.net, context: { executionMode: "runner" } }));
    expect(content(byTestId(tree, "buyer-role"))).toContain("project demo-runner — project-funded, not your wallet");
    expect(content(byTestId(tree, "buyer-total"))).toContain("incomplete: business gas not available"); expect(content(byTestId(tree, "buyer-total"))).not.toContain("0.06 USDC");
    expect(content(byTestId(tree, "operator-total"))).toContain("0.004685925 USDC");
    expect(byTestId(tree, "unresolved-line")).toBeDefined(); expect(content(byTestId(tree, "unresolved-line"))).toContain("0 USDC");
    expect(nodes(tree).some((n) => typeof n.props?.className === "string" && n.props.className.includes("hide-narrow"))).toBe(false); // the unresolved column is never hidden
    expect(nodes(tree).filter((n) => n.type === "th").map((n) => content(n))).toEqual(['"line"', '"authorized maximum"', '"actual"', '"unresolved"']);
    // the run panel passes the run's execution mode
    freshHooks(); memStorage();
    tree = render(() => RunPanel({ run: { ...DONE_RUN, executionMode: "runner", result: { ...DONE_RUN.result, costStatement: STATEMENT_10 } }, net: h.net }));
    expect(fnNode(tree, "CostTable").props.context).toMatchObject({ executionMode: "runner", subjectKind: "demo-run" });
    // the attempt panel: the visitor's wallet, from the statement's own role when it carries one (1.1)
    freshHooks(); const { AttemptPanel } = await import("../src/components/AttemptPanel");
    const gas = { nativeAtomic: "1018375000000000", usdc: "0.001018375", gasUsed: "40735", effectiveGasPriceNativeAtomic: "25000000000", tx: BIZ_TX };
    tree = render(() => AttemptPanel({ attempt: { ...VALIDATED, state: "CONFIRMED", businessStatus: "SUCCESS", costStatement: { ...STATEMENT_10, costStatementVersion: "1.1", buyer: { ...STATEMENT_10.buyer, role: "visitor-wallet", businessGas: gas, totalUsdc: "0.061018375", complete: true }, operator: { ...STATEMENT_10.operator, complete: true } } }, net: h.net, now: NOW.getTime() }));
    const ct = fnNode(tree, "CostTable"); expect(ct.props.context).toMatchObject({ executionMode: "wallet", subjectKind: "wallet-run" });
    freshHooks(); const rendered = render(() => ct.type(ct.props));
    expect(content(byTestId(rendered, "buyer-role"))).toContain("your wallet"); expect(content(byTestId(rendered, "buyer-total"))).toContain("0.061018375 USDC");
  });
});

describe("round 2 · verification state in the browser", () => {
  const bundle = { passportBundleVersion: "1.0", files: {} };
  const run = async (result: any, onVerified = vi.fn()) => {
    h.verifyResult = result; freshHooks();
    const { VerifyInBrowser } = await import("../src/components/VerifyInBrowser");
    const props = { bundle, name: "p.json", net: h.net, anchors: null, anchorsSource: "none" as const, onVerified };
    let tree = render(() => VerifyInBrowser(props));
    await button(tree, "Verify in browser").props.onClick(); tree = render(() => VerifyInBrowser(props));
    return { tree, state: byTestId(tree, "verification-state"), onVerified };
  };
  it("a FAIL is a red stop state naming the failing findings; the PASS chip is not green; the callback reports 'failed'", async () => {
    const { tree, state, onVerified } = await run(verifierResult({ ...ALL_PASS, FILE_INTEGRITY: "FAIL", COST_STATEMENT: "FAIL" }));
    expect(state.props.className).toContain("bad"); expect(content(state)).toContain("Verification FAILED — FILE_INTEGRITY, COST_STATEMENT");
    expect(content(state)).not.toMatch(/Passed/);
    expect(tree.props["data-verification"]).toBe("failed");
    const passChip = nodes(tree).find((n) => typeof n.type === "function" && n.type.name === "Chip" && Array.isArray(n.props.children) && n.props.children[1] === " PASS");
    expect(passChip.props.tone).toBe("neutral");
    expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ counts: expect.objectContaining({ fail: 2 }) }), expect.objectContaining({ kind: "failed", failing: ["FILE_INTEGRITY", "COST_STATEMENT"] }));
  });
  it("UNVERIFIED without a FAIL is an amber partial state, never green; all evaluated PASS is 'passed'", async () => {
    const partial = await run(verifierResult({ ...ALL_PASS, APPROVAL_SOURCE: "UNVERIFIED" }));
    expect(partial.state.props.className).not.toContain("bad"); expect(partial.state.props.className).not.toContain("ok");
    expect(content(partial.state)).toContain("Partially verified (1 unverified: APPROVAL_SOURCE)"); expect(partial.tree.props["data-verification"]).toBe("partial");
    expect(partial.onVerified).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "partial" }));
    const passed = await run(verifierResult(ALL_PASS));
    expect(passed.state.props.className).toContain("ok"); expect(content(passed.state)).toContain("Passed: every evaluated finding is PASS (10 PASS · 1 NOT_EVALUATED");
    expect(passed.onVerified).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "passed" }));
  });
  it("the Developer page's verify stage shows the check mark only for a pass (the rail's note says FAILED otherwise)", async () => {
    developerApi();
    let tree = render(Developer); await flush(); tree = render(Developer);
    const verify = fnNode(tree, "VerifyInBrowser");
    verify.props.onVerified(verifierResult({ ...ALL_PASS, ORDER_OUTCOME: "FAIL" }), { kind: "failed", tone: "bad", failing: ["ORDER_OUTCOME"], unverified: [], counts: { pass: 9, fail: 1, unverified: 0, notEvaluated: 1 }, text: "x" }); tree = render(Developer);
    let rail = fnNode(tree, "Lifecycle").props.stages.find((s: any) => s.id === "verify");
    expect(rail).toMatchObject({ status: "stop", note: "verification FAILED in this browser" });
    verify.props.onVerified(verifierResult(ALL_PASS), { kind: "passed", tone: "ok", failing: [], unverified: [], counts: { pass: 10, fail: 0, unverified: 0, notEvaluated: 1 }, text: "x" }); tree = render(Developer);
    rail = fnNode(tree, "Lifecycle").props.stages.find((s: any) => s.id === "verify");
    expect(rail).toMatchObject({ status: "done", note: "verified in this browser: passed" });
  });
});

// ---- review round 3 (docs/LIFECYCLE.md §10): durable submission uncertainty (item 1), the order dialog when the wallet leaves mid-review (item 5) ----
const PROMPTED = { state: "PROMPTED", at: NOW.toISOString(), detail: null };
/** the view the API serves once POST …/prompt recorded the marker: still VALIDATED, `prompt` set, `nextAction` saying recover first */
const UNCERTAIN: any = { ...VALIDATED, prompt: PROMPTED, nextAction: "the wallet was asked to sign this plan: the transaction may have been submitted — recover first; abandon only if you know you rejected the prompt", note: "the wallet was asked to sign this plan; until a hash is reported or the visitor states a rejection, the transaction may have been submitted" };
const buttonTexts = (tree: any) => nodes(tree).filter((n) => n.type === "button").map((b) => content(b));
const OTHER_LOWER = "0x0000000000000000000000000000000000000b11";

describe("round 3 · an attempt whose wallet prompt was opened is uncertain, across a refresh", () => {
  it("AttemptPanel: with a prompt marker a VALIDATED attempt never offers 'Continue in wallet' or 'Abandon (nothing sent)'; it reads the uncertainty sentence while reconciling, then offers Recover and 'I rejected it — abandon'", async () => {
    const { AttemptPanel } = await import("../src/components/AttemptPanel");
    const actions = { onAbandon: vi.fn(), onResume: vi.fn(), onRecover: vi.fn(), onRefresh: vi.fn() };
    // restored, reconciliation about to run (the page is busy with it)
    let tree = render(() => AttemptPanel({ attempt: UNCERTAIN, phase: "idle", net: h.net, busy: true, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain(UNCERTAIN_TEXT); expect(tree.props["data-uncertain"]).toBe(true);
    expect(buttonTexts(tree).some((t) => t.includes("Continue in wallet"))).toBe(false); expect(buttonTexts(tree).some((t) => t.includes("Abandon (nothing sent)"))).toBe(false);
    expect(content(tree).toLowerCase()).not.toContain("nothing was sent"); expect(content(tree)).not.toContain("waits for your wallet");
    // the loop runs
    freshHooks(); tree = render(() => AttemptPanel({ attempt: UNCERTAIN, phase: "uncertain", net: h.net, busy: true, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain(UNCERTAIN_TEXT); expect(content(tree)).toContain("reconciling — wait for the result");
    expect(buttonTexts(tree).some((t) => t.includes("Continue in wallet"))).toBe(false);
    // …and found nothing yet: the visitor decides — recover again, or the explicit statement
    freshHooks(); tree = render(() => AttemptPanel({ attempt: UNCERTAIN, phase: "uncertain", net: h.net, busy: false, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain(UNCERTAIN_OPEN_TEXT);
    expect(button(tree, "I rejected it — abandon")).toBeDefined(); expect(button(tree, "Recover")).toBeDefined();
    expect(buttonTexts(tree).some((t) => t.includes("Continue in wallet"))).toBe(false); expect(buttonTexts(tree).some((t) => t.includes("Abandon (nothing sent)"))).toBe(false);
    expect(content(tree)).toContain("this plan was already handed to a wallet"); expect(content(tree)).toContain("abandon only if you know the prompt was rejected; otherwise recover again"); // the panel's own next action, not the server's idle one
    button(tree, "I rejected it — abandon").props.onClick(); expect(actions.onAbandon).toHaveBeenCalledWith(ATTEMPT_ID);
    button(tree, "Recover").props.onClick(); expect(actions.onRecover).toHaveBeenCalledWith(ATTEMPT_ID);
    // the marker known to this browser only (a view without the key): the same
    memStorage({ "arcpreflight.attempts:root": JSON.stringify({ [ATTEMPT_ID]: { attemptId: ATTEMPT_ID, orderId: order.orderId, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" } }) });
    freshHooks(); tree = render(() => AttemptPanel({ attempt: VALIDATED, phase: "idle", net: h.net, busy: false, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain(UNCERTAIN_OPEN_TEXT); expect(buttonTexts(tree).some((t) => t.includes("Continue in wallet"))).toBe(false); expect(button(tree, "I rejected it — abandon")).toBeDefined();
    // a closed result after recovery renders as usual
    freshHooks(); tree = render(() => AttemptPanel({ attempt: { ...UNCERTAIN, state: "NOT_SENT", businessStatus: "NOT_EXECUTED" }, phase: "done", net: h.net, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain("Nothing was sent: the wallet prompt was rejected or abandoned."); expect(tree.props["data-uncertain"]).toBeUndefined();
    freshHooks(); tree = render(() => AttemptPanel({ attempt: { ...UNCERTAIN, state: "CONFIRMED", businessStatus: "SUCCESS", txHash: D, businessTxHash: D }, phase: "done", net: h.net, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain("Order payment confirmed");
    // while THIS page is prompting with it (the marker is written right before its own prompt) the panel is not "uncertain"
    freshHooks(); tree = render(() => AttemptPanel({ attempt: UNCERTAIN, phase: "prompting", net: h.net, busy: true, now: NOW.getTime(), actions }));
    expect(content(tree)).toContain("Confirm the transaction in your wallet"); expect(tree.props["data-uncertain"]).toBeUndefined();
  });
  it("Developer: a refresh with a VALIDATED attempt that carries the marker restores the uncertainty, not an idle attempt — recover once, then observe; no 'Continue in wallet' anywhere; 'I rejected it — abandon' closes it as NOT_SENT and renders as usual", async () => {
    memStorage({
      "arcpreflight.session:root": JSON.stringify({ principal: "visitor:1", token: "sess-1" }),
      "arcpreflight.workflow:root": JSON.stringify({ [ACCOUNT.toLowerCase()]: { payer: ACCOUNT, orderId: order.orderId, proxy: "MAIN", baselineDigest: baselineHash, approved: true, requestId: REQUEST, intent: null, attemptId: ATTEMPT_ID, updatedAt: NOW.toISOString() } }),
    });
    const calls: { path: string; method: string }[] = []; let closed: any = null;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"; calls.push({ path, method });
      if (path === "/v1/demo/orders") return response({ orders: [ORDER_VIEW] });
      if (path.startsWith("/v1/demo/orders/")) return response(ORDER_VIEW);
      if (path === "/v1/wallet/attempts") return response({ attempts: [closed ?? { ...UNCERTAIN, plan: undefined }] });
      if (path === `/v1/wallet/attempts/${ATTEMPT_ID}/recover`) return response(closed ?? { ...UNCERTAIN, note: "the wallet was asked to sign this plan and reconciliation found no payment for this order yet; the transaction may still appear — recover again, or abandon only if you know you rejected the prompt" });
      if (path === `/v1/wallet/attempts/${ATTEMPT_ID}/abandon`) { closed = { ...UNCERTAIN, state: "NOT_SENT", businessStatus: "NOT_EXECUTED", nextAction: "nothing was sent; the order stays unpaid", passportAvailable: true }; return response(closed); }
      if (path === `/v1/wallet/attempts/${ATTEMPT_ID}`) return response(closed ?? UNCERTAIN);
      if (path === "/v1/requests") return response({ requests: [] });
      if (path.startsWith("/v1/baselines/")) return response({ baselineDigest: baselineHash, baseline, revoked: false });
      throw new Error(`Unexpected URL: ${path}`);
    }));
    render(Developer); await flush(); let tree = render(Developer); await flush(); tree = render(Developer);
    // restored as uncertain: the sentence, one recover, observing — and not a single wallet call
    let panel = fnNode(tree, "AttemptPanel"); expect(panel.props.attempt.attemptId).toBe(ATTEMPT_ID); expect(panel.props.phase).toBe("uncertain"); expect(panel.props.busy).toBe(true);
    let rendered = panel.type(panel.props);
    expect(content(rendered)).toContain(UNCERTAIN_TEXT);
    expect(buttonTexts(rendered).some((t) => t.includes("Continue in wallet"))).toBe(false); expect(buttonTexts(rendered).some((t) => t.includes("Abandon (nothing sent)"))).toBe(false);
    expect(content(rendered).toLowerCase()).not.toContain("nothing was sent");
    expect(calls.filter((c) => c.path === `/v1/wallet/attempts/${ATTEMPT_ID}/recover`)).toHaveLength(1);
    expect(h.wallet.provider.request.mock.calls.some((c: any[]) => c[0].method === "eth_sendTransaction")).toBe(false);
    expect(content(tree)).toContain("submission uncertain"); expect(content(tree)).toContain("wallet was asked to sign — submission uncertain"); // step 4's summary chip and the rail's note
    const execBtn = nodes(tree).find((n) => n.type === "button" && n.props.className === "btn primary" && content(n).includes("reconciling")); // step 4's primary button reads "reconciling…" and is disabled: no execution starts
    expect(execBtn?.props.disabled).toBe(true); expect(buttonTexts(tree).some((t) => t.includes("Execute with your wallet"))).toBe(false);
    const rows = byTestId(tree, "my-attempts"); expect(rows).toBeDefined();
    expect(buttonTexts(rows).some((t) => t.includes("Continue in wallet"))).toBe(false); expect(button(rows, "I rejected it — abandon")).toBeDefined(); expect(buttonTexts(rows).some((t) => t === '"Abandon"')).toBe(false);
    // the loop observes every 2 s (the server reads the chain for such attempts); recover is not repeated by itself
    const getsBefore = calls.filter((c) => c.path === `/v1/wallet/attempts/${ATTEMPT_ID}` && c.method === "GET").length;
    await vi.advanceTimersByTimeAsync(4100); tree = render(Developer);
    expect(calls.filter((c) => c.path === `/v1/wallet/attempts/${ATTEMPT_ID}` && c.method === "GET").length).toBe(getsBefore + 2);
    expect(calls.filter((c) => c.path.endsWith("/recover"))).toHaveLength(1);
    expect(fnNode(tree, "AttemptPanel").props.phase).toBe("uncertain");
    // the visitor states the rejection: the attempt closes NOT_SENT, the loop ends, the panel renders the closed state as usual
    panel = fnNode(tree, "AttemptPanel");
    await panel.props.actions.onAbandon(ATTEMPT_ID); await vi.advanceTimersByTimeAsync(2100); tree = render(Developer);
    expect(calls.filter((c) => c.path.endsWith("/abandon"))).toHaveLength(1);
    panel = fnNode(tree, "AttemptPanel"); expect(panel.props.attempt.state).toBe("NOT_SENT"); expect(panel.props.phase).toBe("done"); expect(panel.props.busy).toBe(false);
    rendered = panel.type(panel.props); expect(content(rendered)).toContain("Nothing was sent: the wallet prompt was rejected or abandoned."); expect(rendered.props["data-uncertain"]).toBeUndefined();
    expect(h.wallet.provider.request.mock.calls.some((c: any[]) => c[0].method === "eth_sendTransaction")).toBe(false);
  });
});

describe("round 3 · the order dialog when the wallet leaves mid-review (item 5)", () => {
  it("disconnecting or switching the account during the review returns to the form with a notice and never reads the null body", async () => {
    const { OrderDialog } = await import("../src/components/OrderDialog");
    const create = vi.fn(async () => CREATED); const onCreated = vi.fn(); const onClose = vi.fn();
    const limits = { minNativeAtomic: 10n ** 15n, maxNativeAtomic: 10n ** 18n, stepNativeAtomic: 10n ** 12n, defaultNativeAtomic: 5n * 10n ** 16n, maxReferenceLength: 64 };
    const net: any = { ...h.net, fixtures: [{ id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MERCHANT, implementation: IMPL, approvedImplementation: IMPL, baselineDigest: baselineHash, expected: "NO_POLICY_VIOLATION" }] };
    const dlg = (payer: string | null) => render(() => OrderDialog({ payer, net, limits, create, onCreated, onClose }));
    const form = (tree: any) => nodes(tree).find((n) => n.type === "form");
    const payerInput = (tree: any) => nodes(tree).find((n) => n.type === "input" && n.props.id === "of-payer");
    freshHooks(); let tree = dlg(ACCOUNT);
    button(tree, "Autofill sample order").props.onClick(); tree = dlg(ACCOUNT);
    form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg(ACCOUNT);
    expect(content(tree)).toContain("Review the order"); expect(content(byTestId(tree, "order-review"))).toContain(ACCOUNT);
    // the wallet disconnects: the validated body is null — no throw, back on the form, the notice says why
    expect(() => { tree = dlg(null); }).not.toThrow();
    expect(content(tree)).toContain("Create a demonstration order"); expect(byTestId(tree, "order-review")).toBeUndefined();
    tree = dlg(null); // the effect's state lands
    expect(content(byTestId(tree, "order-notice"))).toContain("Your wallet disconnected while you were reviewing"); expect(button(tree, "Review order →").props.disabled).toBe(true);
    expect(payerInput(tree).props.value).toBe(""); expect(create).not.toHaveBeenCalled();
    // reconnected: review again (the notice goes away); then the account changes mid-review
    tree = dlg(ACCOUNT); form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg(ACCOUNT);
    expect(content(tree)).toContain("Review the order"); expect(byTestId(tree, "order-notice")).toBeUndefined();
    expect(() => { tree = dlg(OTHER_LOWER); }).not.toThrow(); tree = dlg(OTHER_LOWER);
    expect(content(tree)).toContain("Create a demonstration order"); expect(byTestId(tree, "order-review")).toBeUndefined();
    expect(content(byTestId(tree, "order-notice"))).toContain("Your wallet switched accounts while you were reviewing");
    expect(payerInput(tree).props.value).toBe(OTHER_LOWER); // the form shows the account that is connected now
    // submitting again reviews the NEW payer's body — never a create with the stale one
    form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg(OTHER_LOWER);
    expect(content(tree)).toContain("Review the order"); expect(content(byTestId(tree, "order-review"))).toContain(OTHER_LOWER); expect(content(byTestId(tree, "order-review"))).not.toContain(ACCOUNT);
    expect(create).not.toHaveBeenCalled();
    await form(tree).props.onSubmit({ preventDefault() {} });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ payer: OTHER_LOWER })); expect(onCreated).toHaveBeenCalledWith(CREATED);
  });
});

// 2026-10-09 real-wallet session (issues 1 and 2): the node refused eth_sendRawTransaction for an order creation and the page said "Nothing was
// changed"; "use" on the failed order marked step 1 complete, showed "unpaid" and allowed approval and quotes. An order is usable only once its
// creation is CONFIRMED, and an answer that names an order never reads "nothing was changed".
describe("2026-10-09 · an order whose creation is not confirmed never looks complete", () => {
  const ORDER_TX = `0x${"5e".repeat(32)}`; const B = `0x${"cd".repeat(32)}`;
  const NEXT = "creation sent, not yet confirmed — waiting for its receipt; recover re-sends the same signed transaction (never a second order); approval stays closed until the order is confirmed";
  const PENDING: any = { error: "ORDER_CREATION_PENDING", code: "ORDER_CREATION_PENDING", pending: true, orderId: order.orderId, state: "SENT", tx: ORDER_TX, nextAction: NEXT,
    reason: 'the node did not confirm taking the creation transaction (The method "eth_sendRawTransaction" does not exist / is not available.)', merchant: MERCHANT, proxy: "MAIN", payer: ACCOUNT, amountNativeAtomic: order.amountNativeAtomic, reference: null, owner: "visitor:1" };
  const SENT_VIEW: any = { ...ORDER_VIEW, state: "SENT", tx: ORDER_TX, block: null, paid: null, creation: { from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null }, nextAction: NEXT, note: null };
  const FAILED_VIEW: any = { ...SENT_VIEW, state: "FAILED", createdAt: "2026-10-03T11:50:00.000Z", nextAction: "this creation could not be established; create a new order (this row stays for the record)",
    note: `the creation nonce was consumed by another transaction (${D}); this order was never created — nothing is re-signed; a new order is a new row` };
  const LIMITS = { minNativeAtomic: 10n ** 15n, maxNativeAtomic: 10n ** 18n, stepNativeAtomic: 10n ** 12n, defaultNativeAtomic: 5n * 10n ** 16n, maxReferenceLength: 64 };
  const stepNode = (tree: any, n: number) => nodes(tree).find((x) => typeof x.type === "function" && x.type.name === "StepSection" && x.props.n === n);
  /** developerApi with the order routes answered from `view` / `list`, and the creation answered by `post` (202 pending by default) */
  function orderApi(o: { view: (id: string) => any; list: () => any[]; post?: () => [any, number] }) {
    const calls: { path: string; method: string }[] = [];
    const inner = developerApi().fetch.getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"; calls.push({ path, method });
      if (path === "/v1/demo/orders" && method === "POST") { const [b, st] = (o.post ?? ((): [any, number] => [PENDING, 202]))(); return response(b, st); }
      if (path === "/v1/demo/orders") return response({ orders: o.list() });
      const rec = /^\/v1\/demo\/orders\/(0x[0-9a-f]{64})\/recover$/.exec(path);
      if (rec && method === "POST") return response({ ...o.view(rec[1]), note: "the identical signed creation was handed to the node again; waiting for its receipt" });
      const one = /^\/v1\/demo\/orders\/(0x[0-9a-f]{64})$/.exec(path);
      if (one) return response(o.view(one[1]));
      return inner(path, init);
    }));
    return { calls, gets: (id: string) => calls.filter((c) => c.path === `/v1/demo/orders/${id}` && c.method === "GET").length, recovers: () => calls.filter((c) => c.path.endsWith("/recover") && c.method === "POST").length };
  }

  it("a 202 shows the order with its hash, keeps step 1 active and every later step closed, says 'unknown', offers Recover and polls until CONFIRMED — never 'Nothing was changed'", async () => {
    let confirmed = false;
    const api = orderApi({ view: () => (confirmed ? { ...ORDER_VIEW, tx: ORDER_TX } : SENT_VIEW), list: () => [confirmed ? { ...ORDER_VIEW, tx: ORDER_TX } : SENT_VIEW] });
    h.net.fixtures = [APPROVED_FIXTURE];
    render(Developer); await flush(); let tree = render(Developer);
    button(tree, "Create order").props.onClick(); tree = render(Developer);
    const dlg = dialogNode(tree); expect(dlg.props.unconfirmed).toBeNull();
    const answer = await dlg.props.create({ payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: order.amountNativeAtomic });
    expect(answer).toMatchObject({ pending: true, __status: 202, orderId: order.orderId, state: "SENT", tx: ORDER_TX });
    dlg.props.onCreated(answer); render(Developer); await flush(); tree = render(Developer);
    expect(dialogNode(tree)).toBeUndefined();
    const card = fnNode(tree, "OrderCard"); expect(card.props.order).toMatchObject({ orderId: order.orderId, state: "SENT", tx: ORDER_TX, paid: null }); expect(typeof card.props.onRecover).toBe("function");
    const stages = fnNode(tree, "Lifecycle").props.stages;
    expect(stages[0]).toMatchObject({ status: "active", note: "waiting for the creation receipt" }); expect(stages[1].status).not.toBe("done");
    const summary = content(stepNode(tree, 1).props.summary); expect(summary).toContain("unknown"); expect(summary).not.toContain("unpaid"); expect(summary).toContain("creation not confirmed");
    expect(nodes(stepNode(tree, 1).props.summary).some((n) => typeof n.type === "function" && n.type.name === "Hex" && n.props.value === ORDER_TX && String(n.props.link).includes(ORDER_TX))).toBe(true);
    expect(() => button(tree, "Approve & continue")).toThrow(); expect(() => button(tree, "Get quote")).toThrow(); // approval, quote, purchase and execution stay closed
    expect(content(byTestId(tree, "approve-closed"))).toContain("approval opens once its receipt confirms it");
    expect(content(tree)).not.toContain("Nothing was changed");
    // Recover: the owner's bounded reconciliation (the same signed creation, never a second order)
    card.props.onRecover(); await flush(); await flush(); tree = render(Developer);
    expect(api.recovers()).toBe(1); expect(fnNode(tree, "OrderCard").props.order.note).toContain("identical signed creation");
    // polling: GET every 3 s while SENT, until the creation is confirmed — then the workflow opens and the polling stops
    const before = api.gets(order.orderId);
    await vi.advanceTimersByTimeAsync(3_000); expect(api.gets(order.orderId)).toBe(before + 1);
    confirmed = true; await vi.advanceTimersByTimeAsync(3_000); render(Developer); await flush(); tree = render(Developer);
    expect(fnNode(tree, "OrderCard").props.order.state).toBe("CONFIRMED");
    expect(fnNode(tree, "Lifecycle").props.stages[0].status).toBe("done");
    expect(button(tree, "Approve & continue").props.disabled).toBe(false);
    const settled = api.gets(order.orderId); await vi.advanceTimersByTimeAsync(9_000); expect(api.gets(order.orderId)).toBe(settled);
  });

  it("while the latest order's creation is unconfirmed the dialog refuses another; 'use' on a failed order stops at step 1 ('unknown', nothing opens); a new order is allowed and the failed row stays listed", async () => {
    memStorage({ "arcpreflight.session:root": JSON.stringify(SESSION(1)) }); // this browser already holds the session that owns its orders
    let listed: any[] = [{ ...SENT_VIEW, createdAt: "2026-10-03T11:59:00.000Z" }];
    orderApi({ view: (id) => listed.find((x) => x.orderId === id) ?? listed[0], list: () => listed, post: () => [{ ...CREATED, orderId: B }, 201] });
    h.net.fixtures = [APPROVED_FIXTURE];
    render(Developer); await flush(); let tree = render(Developer);
    button(tree, "Create order").props.onClick(); tree = render(Developer);
    expect(dialogNode(tree).props.unconfirmed).toEqual({ orderId: order.orderId }); // the dialog refuses (its own test shows how)
    expect(nodes(byTestId(tree, "my-orders")).some((n) => n.type === "button" && content(n).includes("Recover order"))).toBe(true);
    // later the creation was closed FAILED (its nonce went to another transaction): "use" on it stops at step 1
    freshHooks(); listed = [FAILED_VIEW];
    render(Developer); await flush(); tree = render(Developer);
    button(byTestId(tree, "my-orders"), "use").props.onClick(); tree = render(Developer);
    expect(fnNode(tree, "OrderCard").props.order.state).toBe("FAILED");
    const stages = fnNode(tree, "Lifecycle").props.stages;
    expect(stages[0]).toMatchObject({ status: "stop", note: "creation not established — create a new order" }); expect(stages[1].status).not.toBe("done");
    const summary = content(stepNode(tree, 1).props.summary); expect(summary).toContain("unknown"); expect(summary).not.toContain("unpaid");
    expect(() => button(tree, "Approve & continue")).toThrow(); expect(() => button(tree, "Get quote")).toThrow();
    expect(content(byTestId(tree, "approve-closed"))).toContain("create a new order in step 1");
    // a new order is allowed (the latest order is closed, not unconfirmed); the failed one stays listed
    button(tree, "Create a new order").props.onClick(); tree = render(Developer);
    const dlg = dialogNode(tree); expect(dlg.props.unconfirmed).toBeNull();
    listed = [{ ...ORDER_VIEW, orderId: B, createdAt: "2026-10-03T12:00:00.000Z" }, FAILED_VIEW];
    dlg.props.onCreated(await dlg.props.create({ payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: order.amountNativeAtomic }));
    render(Developer); await flush(); tree = render(Developer);
    expect(fnNode(tree, "OrderCard").props.order).toMatchObject({ orderId: B, state: "CONFIRMED" });
    expect(fnNode(tree, "Lifecycle").props.stages[0].status).toBe("done");
    const mineNow = byTestId(tree, "my-orders"); expect(content(mineNow)).toContain(order.orderId); expect(content(mineNow)).toContain(B);
  });

  it("OrderDialog: refuses another order while one is unconfirmed; a 502 that names the order hands that order over; a lost answer says the order may exist", async () => {
    const { OrderDialog } = await import("../src/components/OrderDialog");
    const net: any = { ...h.net, fixtures: [APPROVED_FIXTURE] };
    let answer: () => any = () => PENDING;
    const create = vi.fn(async () => { const a = answer(); if (a instanceof Error) throw a; return a; });
    const onCreated = vi.fn(); const onLost = vi.fn(); let unconfirmed: any = { orderId: order.orderId };
    const dlg = () => render(() => OrderDialog({ payer: ACCOUNT, net, limits: LIMITS, create, onCreated, onClose: vi.fn(), unconfirmed, onLost }));
    const form = (tree: any) => nodes(tree).find((n) => n.type === "form");
    freshHooks(); let tree = dlg();
    expect(content(byTestId(tree, "order-unconfirmed"))).toContain("An earlier order creation is still unconfirmed — recover it first");
    button(tree, "Autofill sample order").props.onClick(); tree = dlg();
    expect(button(tree, "Review order").props.disabled).toBe(true);
    form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
    expect(content(tree)).not.toContain("Review the order"); expect(create).not.toHaveBeenCalled();
    // recovered or closed: the dialog works again; a 502 naming the order hands it over as FAILED — never "nothing was changed"
    unconfirmed = null; tree = dlg(); expect(byTestId(tree, "order-unconfirmed")).toBeUndefined();
    form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg(); expect(content(tree)).toContain("Review the order");
    answer = () => new ApiError(502, { error: "ORDER_CREATION_FAILED", reason: "the creation transaction reverted", orderId: order.orderId, state: "FAILED", tx: D });
    await form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ failed: true, orderId: order.orderId, state: "FAILED", tx: D, reason: "the creation transaction reverted", payer: ACCOUNT, proxy: "MAIN", merchant: MERCHANT }));
    expect(content(tree)).not.toContain("Nothing was changed");
    // the answer was lost on the way: the order may exist — My workflow is re-read; nothing claims "nothing was sent"
    answer = () => new TypeError("Failed to fetch");
    await form(tree).props.onSubmit({ preventDefault() {} }); tree = dlg();
    expect(onLost).toHaveBeenCalledTimes(1); expect(onCreated).toHaveBeenCalledTimes(1);
    expect(content(tree)).toContain("The order may have been recorded"); expect(content(tree)).not.toContain("Nothing was sent");
    // a 202 is handed over as it came
    answer = () => PENDING; await form(tree).props.onSubmit({ preventDefault() {} });
    expect(onCreated).toHaveBeenLastCalledWith(PENDING);
  });

  it("OrderCard: a sent creation says 'Order creation sent — not yet confirmed' with its hash link and Recover; an identity without a hash says so; payment reads 'unknown'", async () => {
    const { OrderCard } = await import("../src/components/OrderCard");
    const onRecover = vi.fn();
    let tree: any = OrderCard({ order: SENT_VIEW, net: h.net, feeTokenAtomic: "10000", onRecover, onRefresh: vi.fn() });
    expect(content(byTestId(tree, "order-creation-status"))).toContain("Order creation sent — not yet confirmed");
    expect(nodes(tree).some((n) => typeof n.type === "function" && n.type.name === "Hex" && n.props.value === ORDER_TX && String(n.props.link).includes(ORDER_TX))).toBe(true);
    const chips = nodes(tree).filter((n) => typeof n.type === "function" && n.type.name === "Chip").map((n) => content(n)).join(" ");
    expect(chips).toContain("unknown"); expect(chips).not.toContain("unpaid");
    button(tree, "Recover order").props.onClick(); expect(onRecover).toHaveBeenCalledTimes(1);
    tree = OrderCard({ order: { ...SENT_VIEW, state: "PLANNED", tx: null }, net: h.net, feeTokenAtomic: "10000", onRecover });
    expect(content(byTestId(tree, "order-creation-status"))).toContain("identity recorded; creation not confirmed");
    tree = OrderCard({ order: { ...ORDER_VIEW, paid: false }, net: h.net, feeTokenAtomic: "10000", onRecover });
    expect(byTestId(tree, "order-creation-status")).toBeUndefined(); expect(() => button(tree, "Recover order")).toThrow();
    expect(nodes(tree).filter((n) => typeof n.type === "function" && n.type.name === "Chip").map((n) => content(n)).join(" ")).toContain("unpaid"); // a confirmed, unpaid order says so
  });

  it("the Live Demo's wallet check stops at a 202: the order is named, nothing is quoted or signed, and the error never reads 'Nothing was changed'", async () => {
    const { useWalletRun } = await import("../src/lib/walletRun");
    const api = orderApi({ view: () => SENT_VIEW, list: () => [SENT_VIEW] });
    const wallet = { provider: h.wallet.provider, account: ACCOUNT, chainId: 5042002 };
    freshHooks(); let hook = render(() => useWalletRun(h.net, wallet));
    await hook.start({ ...APPROVED_FIXTURE, expected: "NO_POLICY_VIOLATION", implementation: IMPL } as any);
    hook = render(() => useWalletRun(h.net, wallet));
    expect(hook.run.phase).toBe("error");
    expect(hook.run.err?.text).toContain(`Order ${order.orderId.slice(0, 10)}… is recorded, but its creation is not confirmed yet`);
    expect(hook.run.err?.text).not.toContain("Nothing was changed");
    expect(hook.run.steps.map((s: any) => s.step)).toEqual(["orderCreationPending", "error"]);
    expect(api.calls.some((c) => c.path === "/v1/preflight")).toBe(false); expect(h.sign).not.toHaveBeenCalled();
  });

  it("FaucetCard: a 202 claim reads 'Sent, not yet confirmed' with its hash — never as received", async () => {
    const HASH = `0x${"fa".repeat(32)}`; h.net.faucet = FAUCET;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/v1/faucet") return response({ ok: true, pending: true, txHash: HASH, amountNativeAtomic: "200000000000000000", address: ACCOUNT, note: "sent, not yet confirmed: no receipt within the wait; follow the hash on the explorer" }, 202);
      throw new Error(`Unexpected URL: ${path}`);
    }));
    freshHooks();
    let card = render(() => FaucetCard({ net: h.net, wallet: h.wallet, balance: 0n, required: 63_000_000_000_000_000n, step: "buying the report" }));
    await button(card, "Claim testnet USDC").props.onClick(); card = render(() => FaucetCard({ net: h.net, wallet: h.wallet, balance: 0n, required: 63_000_000_000_000_000n, step: "buying the report" }));
    expect(content(card)).toContain("Sent, not yet confirmed: 0.20 USDC"); expect(content(card)).toContain("never repeated"); expect(content(card)).not.toContain("the balance refreshes in a moment");
    expect(nodes(card).some((n) => typeof n.type === "function" && n.type.name === "Hex" && n.props.value === HASH)).toBe(true);
  });
});
