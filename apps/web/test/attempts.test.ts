import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFor, setApiBase, type AttemptView, api, type ApiClient } from "../src/lib/api";
import { resetSessions, sessionFor } from "../src/lib/session";
import { AMBIGUOUS_OPEN_TEXT, AMBIGUOUS_TEXT, UNCERTAIN_OPEN_TEXT, UNCERTAIN_TEXT, attemptMessage, deviationRows, executeAttempt, executionInFlight, findOpenAttempt, insideWindow, isOpen, isTerminal, isUncertain, isUserRejection, pollAttempt, preSendCheck, reconcileUncertainAttempt, rememberAttempt, rememberedAttempt, rememberedAttempts, resetExecutionGuard, sendValidatedAttempt, txRequestFromPlan, windowCheck } from "../src/lib/attempts";
import { ACCOUNT, D, MERCHANT, NOW, REQUEST, response } from "./fixtures";

// Wallet execution from the browser (docs/LIFECYCLE.md §3, §9, AP33-07): the attempt is remembered before the wallet is prompted, the wallet
// is re-checked right before the prompt (account, chain, window), the wallet signs exactly the plan (no nonce), the hash is reported right
// away, the observe route is polled until the state leaves the open set, a rejected prompt abandons, a refusal sends nothing, an
// unexplained wallet error reconciles instead of prompting again, and one execution runs at a time.
// Review round 3 (§10): the `prompted` marker is written on the server right before the prompt (no marker → no prompt), `unknown-submission`
// when the wallet answered with anything but a rejection; an attempt carrying a marker is uncertain — restored, it is reconciled and never
// handed to the wallet again; the validation window is re-read from the clock after every await that precedes eth_sendTransaction (item 4).
const ORDER = `0x${"ab".repeat(32)}`;
const PROMPTED = { state: "PROMPTED" as const, at: NOW.toISOString(), detail: null };
const PLAN = { chainId: 5042002, from: ACCOUNT, type: 2 as const, to: MERCHANT, data: "0x8609cad1" + "ab".repeat(32), valueNativeAtomic: "5000000000000000", nonce: "7", gasLimit: "40735", maxFeePerGasNativeAtomic: "29000000000", maxPriorityFeePerGasNativeAtomic: "5000000000", accessList: [], authorizationList: [] };
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const OTHER = "0x0000000000000000000000000000000000000b11";
const view = (over: Partial<AttemptView> = {}): AttemptView => ({ attemptId: ATTEMPT, executionMode: "wallet", state: "VALIDATED", requestId: REQUEST, orderId: ORDER, merchant: MERCHANT, payer: ACCOUNT, amountNativeAtomic: "5000000000000000", labels: ["LIVE_REQUEST"], decision: "NO_POLICY_VIOLATION", decisionReasons: [], refusal: null, validUntil: new Date(NOW.getTime() + 60_000).toISOString(), txHash: null, nonce: null, from: null, broadcastBlock: null, businessStatus: null, businessTxHash: null, block: null, note: null, deviations: null, nextAction: "confirm in your wallet", passportAvailable: false, businessExecution: { state: "VALIDATED", txHash: null, nonce: null, broadcastBlock: null, consumedBy: null, note: null, validUntil: null }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), plan: PLAN, ...over });
const withToken = async <T,>(fn: (t: string, c: ApiClient) => Promise<T>) => fn("tok", api); // the operation's client: the current instance here (review of bf0c800)
/** a wallet that answers the pre-send reads like an extension does, and hands eth_sendTransaction to `onSend` */
function wallet(onSend: (req: any) => Promise<any> | any, over: { accounts?: string[]; chainId?: number } = {}) {
  const sends: any[] = [];
  const request = vi.fn(async ({ method, params }: any) => {
    if (method === "eth_accounts") return over.accounts ?? [ACCOUNT];
    if (method === "eth_chainId") return `0x${(over.chainId ?? 5042002).toString(16)}`;
    if (method === "eth_sendTransaction") { sends.push(params[0]); return onSend(params[0]); }
    throw new Error(`unexpected ${method}`);
  });
  return { request, sends } as any;
}
let storage: Map<string, string>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); storage = new Map(); vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } }); setApiBase(""); resetExecutionGuard(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setApiBase(""); resetExecutionGuard(); });

describe("plan → wallet request", () => {
  it("hands the wallet exactly the plan as hex quantities, type 2, bound to the plan's chain, and never a nonce", () => {
    const req = txRequestFromPlan(PLAN);
    expect(req).toEqual({ from: ACCOUNT, to: MERCHANT, data: PLAN.data, value: "0x11c37937e08000", gas: "0x9f1f", maxFeePerGas: "0x6c088e200", maxPriorityFeePerGas: "0x12a05f200", type: "0x2", chainId: "0x4cef52" }); // bound to the plan's chain (review of 0c0d406, P1-2)
    expect("nonce" in req).toBe(false);
  });
  it("recognises a rejected prompt in its usual shapes", () => {
    expect(isUserRejection({ code: 4001, message: "User rejected the request." })).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection(new Error("MetaMask Tx Signature: User denied transaction signature."))).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error("insufficient funds"))).toBe(false);
    expect(isUserRejection({ code: -32000 })).toBe(false);
    expect(isUserRejection(Object.assign(new Error("Request timed out"), { code: -32603 }))).toBe(false);
  });
  it("state helpers", () => {
    expect(isOpen("VALIDATED")).toBe(true); expect(isOpen("BROADCAST_ATTEMPTED")).toBe(true); expect(isOpen("CONFIRMED")).toBe(false); expect(isTerminal("NOT_SENT")).toBe(true); expect(isTerminal(null)).toBe(false);
    expect(insideWindow(view())).toBe(true); expect(insideWindow(view(), NOW.getTime() + 61_000)).toBe(false); expect(insideWindow(view({ state: "NOT_SENT" }))).toBe(false); expect(insideWindow(null)).toBe(false);
  });
});

describe("remembered attempts (per instance)", () => {
  it("remembers before the prompt, updates the state later, stays per API instance", () => {
    rememberAttempt({ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED" });
    expect(rememberedAttempts()).toEqual([{ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED" }]);
    rememberAttempt({ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "CONFIRMED" });
    expect(rememberedAttempts()[0].state).toBe("CONFIRMED"); expect(storage.has("arcpreflight.attempts:root")).toBe(true);
    setApiBase("/testnet"); expect(rememberedAttempts()).toEqual([]); // another instance's attempts never leak across
  });
  it("§10 item 1: the prompt marker is remembered per attempt and makes a VALIDATED attempt uncertain — from the server view or from this browser's memory alone", () => {
    expect(isUncertain(view())).toBe(false); // plainly validated: nothing was handed to a wallet yet
    expect(isUncertain(view({ prompt: PROMPTED }))).toBe(true); // the server recorded the prompt
    expect(isUncertain(view({ prompt: { state: "UNKNOWN_SUBMISSION", at: NOW.toISOString(), detail: "Request timed out" } }))).toBe(true);
    rememberAttempt({ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" });
    expect(rememberedAttempt(ATTEMPT)?.promptState).toBe("PROMPTED");
    expect(isUncertain(view())).toBe(true); // the server view lacks the key (older API) but this browser opened the prompt: still uncertain
    expect(isUncertain(view(), null)).toBe(false); // …and the memory is what carries it
    expect(isUncertain(view({ state: "CONFIRMED", prompt: PROMPTED }))).toBe(false); // closed attempts are what they are
    expect(isUncertain(view({ state: "BROADCAST_ATTEMPTED", prompt: PROMPTED }))).toBe(false);
    expect(isUncertain(null)).toBe(false);
  });
});

/** the prompt marker route answers like the API: the view with `prompt` set (PROMPTED, or UNKNOWN_SUBMISSION with the wallet's answer as detail) */
function fakeApi(opts: { create?: () => Response; observe: (n: number) => Response; sent?: () => Response; recover?: (n: number) => Response; list?: () => Response; prompt?: (body: any) => Response }) {
  const calls: { path: string; method: string; body: any }[] = []; let observes = 0; let recovers = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null; calls.push({ path, method: init?.method ?? "GET", body });
    if (path === "/v1/wallet/attempts" && init?.method === "POST") return (opts.create ?? (() => response(view(), 201)))();
    if (path === "/v1/wallet/attempts") return (opts.list ?? (() => response({ attempts: [] })))();
    if (path === `/v1/wallet/attempts/${ATTEMPT}/sent`) return (opts.sent ?? (() => response(view({ state: "BROADCAST_ATTEMPTED", txHash: D }))))();
    if (path === `/v1/wallet/attempts/${ATTEMPT}/abandon`) return response(view({ state: "NOT_SENT", businessStatus: "NOT_EXECUTED" }));
    if (path === `/v1/wallet/attempts/${ATTEMPT}/recover`) return (opts.recover ?? (() => response(view())))(recovers++);
    if (path === `/v1/wallet/attempts/${ATTEMPT}/prompt`) return (opts.prompt ?? ((b: any) => b.event === "not-prompted" ? response(view()) : response(view({ prompt: { state: b.event === "prompted" ? "PROMPTED" : "UNKNOWN_SUBMISSION", at: NOW.toISOString(), detail: b.detail ?? null } }))))(body);
    if (path === `/v1/wallet/attempts/${ATTEMPT}`) return opts.observe(observes++);
    throw new Error(`Unexpected URL: ${path}`);
  }));
  return calls;
}
const paths = (calls: { path: string; method: string }[]) => calls.map((c) => `${c.method} ${c.path}`);
const PROMPT_PATH = `POST /v1/wallet/attempts/${ATTEMPT}/prompt`;

describe("executeAttempt: the state machine", () => {
  it("validates, remembers the attempt BEFORE prompting, re-reads account and chain, sends exactly the plan without a nonce, reports the hash, polls to CONFIRMED", async () => {
    const calls = fakeApi({ observe: (n) => response(n === 0 ? view({ state: "BROADCAST_ATTEMPTED", txHash: D }) : view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", block: "200", deviations: { mismatch: [], deviations: { nonce: { plan: "7", actual: "8" } } } })) });
    const events: string[] = []; let rememberedAtPrompt: any[] = []; let callsAtPrompt: string[] = [];
    const provider = wallet(() => { rememberedAtPrompt = rememberedAttempts(); callsAtPrompt = paths(calls); return D; });
    const policy = { ownerPrincipal: "x" };
    const result = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy, withToken, onEvent: (e) => events.push(e.phase), poll: { wait: async () => {}, intervalMs: 0 } });
    expect(calls[0]).toMatchObject({ path: "/v1/wallet/attempts", method: "POST", body: { requestId: REQUEST, orderId: ORDER, policy } });
    expect(rememberedAtPrompt).toEqual([{ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" }]); // AP33-07 + §10: remembered, with the marker, before the wallet is asked
    expect(callsAtPrompt).toEqual(["POST /v1/wallet/attempts", PROMPT_PATH]); // §10 item 1: the marker is on the server before eth_sendTransaction
    expect(calls[1]).toMatchObject({ path: `/v1/wallet/attempts/${ATTEMPT}/prompt`, method: "POST", body: { event: "prompted" } });
    expect(provider.sends[0]).toEqual(txRequestFromPlan(PLAN)); expect(provider.sends[0].nonce).toBeUndefined();
    const methods = provider.request.mock.calls.map((c: any[]) => c[0].method);
    expect(methods.indexOf("eth_accounts")).toBeLessThan(methods.indexOf("eth_sendTransaction")); expect(methods.indexOf("eth_chainId")).toBeLessThan(methods.indexOf("eth_sendTransaction")); // re-read right before the prompt
    expect(calls[2]).toMatchObject({ path: `/v1/wallet/attempts/${ATTEMPT}/sent`, method: "POST", body: { txHash: D } });
    expect(calls.filter((c) => c.path === `/v1/wallet/attempts/${ATTEMPT}` && c.method === "GET")).toHaveLength(2);
    expect(events).toEqual(["validating", "prompting", "reporting", "polling", "polling", "polling", "done"]);
    expect(result.phase).toBe("done"); expect(result.attempt?.state).toBe("CONFIRMED"); expect(result.txHash).toBe(D);
    expect(rememberedAttempts()[0].state).toBe("CONFIRMED");
    expect(deviationRows(result.attempt!.deviations)).toEqual([{ field: "nonce", plan: "7", actual: "8", kind: "deviation" }]);
  });
  it("a rejected prompt (4001) abandons the attempt: NOT_SENT, nothing was sent", async () => {
    const calls = fakeApi({ observe: () => response(view()) });
    const provider = wallet(() => { const e: any = new Error("User rejected the request."); e.code = 4001; throw e; });
    const result = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(result.phase).toBe("abandoned"); expect(result.attempt?.state).toBe("NOT_SENT");
    expect(calls.map((c) => c.path)).toEqual(["/v1/wallet/attempts", `/v1/wallet/attempts/${ATTEMPT}/prompt`, `/v1/wallet/attempts/${ATTEMPT}/abandon`]); // a rejection is the one wallet answer that is NOT an unknown submission
    expect(rememberedAttempts()[0].state).toBe("NOT_SENT");
  });
  it("§10 item 1: a prompt marker that cannot be written means nothing is prompted — the uncertainty could not be persisted", async () => {
    const calls = fakeApi({ observe: () => response(view()), prompt: () => response({ error: "DEPENDENCY_ERROR", reason: "store unavailable" }, 503) });
    const provider = wallet(() => D);
    const events: string[] = [];
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, onEvent: (e) => events.push(e.phase) });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("PROMPT_MARKER_FAILED"); expect(r.error?.text).toMatch(/nothing was prompted/); expect(r.error?.text).toMatch(/store unavailable/);
    expect(provider.sends).toEqual([]); expect(events).not.toContain("prompting");
    expect(paths(calls)).toEqual(["POST /v1/wallet/attempts", PROMPT_PATH]); // no abandon by itself: the attempt stays VALIDATED for a retry inside the window, abandon or recover
    expect(r.attempt?.state).toBe("VALIDATED"); expect(rememberedAttempt(ATTEMPT)?.promptState).toBeUndefined(); // no marker anywhere: it stays a plain validated attempt
    // the attempt closed meanwhile (409 ATTEMPT_NOT_OPEN from the marker route): the same rule — nothing is prompted
    fakeApi({ observe: () => response(view()), prompt: () => response({ error: "ATTEMPT_NOT_OPEN", reason: "the attempt is NOT_EXECUTED; a prompt is recorded for a validated attempt only" }, 409) });
    const r2 = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken });
    expect(r2.phase).toBe("error"); expect(r2.error?.code).toBe("PROMPT_MARKER_FAILED"); expect(r2.error?.text).toMatch(/NOT_EXECUTED/); expect(provider.sends).toEqual([]);
  });
  it("§10 item 1: an attempt that carries a prompt marker is never handed to the wallet again — sendValidatedAttempt refuses before any wallet read", async () => {
    const calls = fakeApi({ observe: () => response(view({ prompt: PROMPTED })) });
    const provider = wallet(() => D);
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view({ prompt: PROMPTED }), withToken });
    expect(r.phase).toBe("uncertain"); expect(r.error?.code).toBe("ATTEMPT_UNCERTAIN"); expect(r.error?.text).toMatch(/already handed to a wallet/); expect(r.error?.text).not.toMatch(/nothing was sent/i);
    expect(provider.request).not.toHaveBeenCalled(); expect(calls).toEqual([]);
    // the same from this browser's memory alone (the server view predates the route)
    rememberAttempt({ attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" });
    expect((await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken })).error?.code).toBe("ATTEMPT_UNCERTAIN"); expect(provider.sends).toEqual([]);
  });
  it("a 409 VALIDATION_FAILED is a refusal with reasons — no prompt, nothing sent, the REFUSED attempt remembered", async () => {
    fakeApi({ create: () => response({ error: "VALIDATION_FAILED", reason: "the decision is REVIEW_REQUIRED: nothing is executed", reasons: ["BASELINE_STATUS: implementation changed"], attemptId: ATTEMPT }, 409), observe: () => response(view()) });
    const provider = wallet(() => D);
    const result = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(result.phase).toBe("refused"); expect(result.refusal).toMatchObject({ stage: "decision", reasons: ["BASELINE_STATUS: implementation changed"], attemptId: ATTEMPT });
    expect(result.refusal!.text).toMatch(/Validation did not pass/);
    expect(provider.request).not.toHaveBeenCalled(); expect(rememberedAttempts()[0]).toMatchObject({ attemptId: ATTEMPT, state: "REFUSED" });
    fakeApi({ create: () => response({ error: "VALIDATION_FAILED", reason: "final validation did not pass; nothing is signed", reasons: ["balance"], attemptId: null }, 409), observe: () => response(view()) });
    expect((await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken })).refusal?.stage).toBe("finalValidation");
  });
  it("other refusals (ORDER_ALREADY_PAID, EXECUTION_GATED) surface as readable errors without a prompt", async () => {
    fakeApi({ create: () => response({ error: "ORDER_ALREADY_PAID", reason: "this order already reads as paid" }, 409), observe: () => response(view()) });
    const provider = wallet(() => D);
    let r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("ORDER_ALREADY_PAID"); expect(r.error?.text).toMatch(/already reads as paid/);
    fakeApi({ create: () => response({ error: "EXECUTION_GATED", reason: "gated until the mainnet acceptance" }, 503), observe: () => response(view()) });
    r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(r.error?.code).toBe("EXECUTION_GATED"); expect(r.error?.text).toMatch(/gated on this instance/); expect(provider.request).not.toHaveBeenCalled();
  });
  it("409 ATTEMPT_OPEN: the open attempt is loaded and shown instead of an error (VALIDATED → open-attempt; BROADCAST_ATTEMPTED → polled)", async () => {
    const calls = fakeApi({ create: () => response({ error: "ATTEMPT_OPEN", reason: "an attempt for this order is still open" }, 409), list: () => response({ attempts: [{ ...view(), plan: undefined }] }), observe: () => response(view()) });
    const provider = wallet(() => D);
    let r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(r.phase).toBe("open-attempt"); expect(r.attempt?.attemptId).toBe(ATTEMPT); expect(r.attempt?.plan).toEqual(PLAN); expect(r.error ?? null).toBeNull();
    expect(paths(calls)).toEqual(["POST /v1/wallet/attempts", "GET /v1/wallet/attempts", `GET /v1/wallet/attempts/${ATTEMPT}`]);
    expect(provider.request).not.toHaveBeenCalled(); // nothing is prompted by itself; the panel offers continue / abandon / recover
    expect(rememberedAttempts()[0]).toMatchObject({ attemptId: ATTEMPT, state: "VALIDATED" });
    expect(attemptMessage(r.attempt, "open-attempt").text).toMatch(/already open/);
    // the open one is already broadcast: it is observed to its outcome
    fakeApi({ create: () => response({ error: "ATTEMPT_OPEN" }, 409), list: () => response({ attempts: [view({ state: "BROADCAST_ATTEMPTED", txHash: D })] }), observe: (n) => response(n === 0 ? view({ state: "BROADCAST_ATTEMPTED", txHash: D }) : view({ state: "CONFIRMED", txHash: D, businessStatus: "SUCCESS" })) });
    r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { wait: async () => {}, intervalMs: 0 } });
    expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED");
    // no open attempt found after all: the plain readable error
    fakeApi({ create: () => response({ error: "ATTEMPT_OPEN", reason: "an attempt for this order is still open" }, 409), list: () => response({ attempts: [] }), observe: () => response(view()) });
    r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("ATTEMPT_OPEN");
    expect(await findOpenAttempt(ORDER, withToken)).toBeNull();
  });
  it("§10 item 1: 409 ATTEMPT_OPEN whose open attempt carries a prompt marker is reconciled (recover once, then observe), never shown as 'continue in your wallet'", async () => {
    // the full-view GET that loads the open attempt is observe #0; recover answers still open; the next observes close it through OrderPaid
    const calls = fakeApi({ create: () => response({ error: "ATTEMPT_OPEN" }, 409), list: () => response({ attempts: [{ ...view({ prompt: PROMPTED }), plan: undefined }] }), recover: () => response(view({ prompt: PROMPTED, note: "reconciliation found no payment for this order yet" })), observe: (n) => response(n < 2 ? view({ prompt: PROMPTED }) : view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", note: "recovered through the merchant's OrderPaid event" })) });
    const provider = wallet(() => D); const events: string[] = [];
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, onEvent: (e) => events.push(e.phase), poll: { wait: async () => {}, intervalMs: 0 } });
    expect(events).toEqual(["validating", "uncertain", "uncertain", "uncertain", "done"]); expect(events).not.toContain("open-attempt");
    expect(paths(calls)).toEqual(["POST /v1/wallet/attempts", "GET /v1/wallet/attempts", `GET /v1/wallet/attempts/${ATTEMPT}`, `POST /v1/wallet/attempts/${ATTEMPT}/recover`, `GET /v1/wallet/attempts/${ATTEMPT}`, `GET /v1/wallet/attempts/${ATTEMPT}`]);
    expect(provider.request).not.toHaveBeenCalled(); expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED"); expect(r.txHash).toBe(D);
  });
  it("polling stops at the deadline with 'unresolved' (recover is the next action) and tolerates transport errors", async () => {
    let t = NOW.getTime(); const now = () => t;
    const calls = fakeApi({ observe: (n) => { if (n === 1) throw new TypeError("Failed to fetch"); return response(view({ state: "BROADCAST_ATTEMPTED", txHash: D })); } });
    const provider = wallet(() => D);
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { intervalMs: 2000, maxMs: 6000, now, wait: async (ms) => { t += ms; } } });
    expect(r.phase).toBe("unresolved"); expect(r.attempt?.state).toBe("BROADCAST_ATTEMPTED");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(4); // t=0, 2 s (failed), 4 s, 6 s → deadline
  });
  it("resumes a VALIDATED attempt found after a refresh with its own plan, and refuses one without a plan", async () => {
    fakeApi({ observe: () => response(view({ state: "CONFIRMED", txHash: D, businessStatus: "SUCCESS" })) });
    const provider = wallet((req) => { expect(req.to).toBe(MERCHANT); return D; });
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, poll: { wait: async () => {}, intervalMs: 0 } });
    expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED");
    const r2 = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view({ plan: null }), withToken });
    expect(r2.phase).toBe("error"); expect(r2.error?.code).toBe("ATTEMPT_NOT_OPEN");
    const r3 = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view({ state: "NOT_SENT" }), withToken });
    expect(r3.phase).toBe("error");
  });
  it("pollAttempt: a 4xx other than 429 propagates (the owner lost the attempt), 5xx keeps polling", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? response({ error: "DEPENDENCY_ERROR" }, 503) : response(view({ state: "NOT_SENT" })))));
    expect((await pollAttempt(ATTEMPT, withToken, { wait: async () => {}, intervalMs: 0 })).settled).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "NOT_FOUND" }, 404)));
    await expect(pollAttempt(ATTEMPT, withToken, { wait: async () => {}, intervalMs: 0 })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("right before eth_sendTransaction (docs/LIFECYCLE.md §9)", () => {
  it("the wallet's first account must be the plan's from and the attempt's payer; a switched account aborts without a prompt and says so", async () => {
    const calls = fakeApi({ observe: () => response(view()) });
    const provider = wallet(() => D, { accounts: [OTHER] });
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("ACCOUNT_CHANGED"); expect(r.error?.text).toMatch(/Your wallet switched to 0x0000…0b11/); expect(r.error?.text).toMatch(/Nothing was prompted/);
    expect(provider.sends).toEqual([]); expect(calls.map((c) => c.path)).toEqual([]); // no prompt, no abandon: the attempt stays VALIDATED for abandon / recover
    expect(r.attempt?.state).toBe("VALIDATED");
    expect(await preSendCheck(wallet(() => D, { accounts: [] }), view())).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" });
    expect(await preSendCheck(wallet(() => D, { accounts: [ACCOUNT.toUpperCase().replace("0X", "0x")] }), view())).toEqual({ ok: true }); // case-insensitive
    expect(await preSendCheck(wallet(() => D), view({ payer: OTHER }))).toMatchObject({ ok: false, code: "ACCOUNT_CHANGED" }); // plan.from and payer must both match
  });
  it("the wallet's chain must be the plan's chainId", async () => {
    fakeApi({ observe: () => response(view()) });
    const provider = wallet(() => D, { chainId: 5042 });
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("CHAIN_CHANGED"); expect(r.error?.text).toMatch(/is on chain 5042; the plan was validated for chain 5042002/);
    expect(provider.sends).toEqual([]);
  });
  it("more than 5 s of the validation window must be left", async () => {
    fakeApi({ observe: () => response(view()) });
    const provider = wallet(() => D);
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view({ validUntil: new Date(NOW.getTime() + 4000).toISOString() }), withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("WINDOW_CLOSED"); expect(r.error?.text).toMatch(/closes in 4 s|window closed/);
    const closed = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view({ validUntil: new Date(NOW.getTime() - 1000).toISOString() }), withToken });
    expect(closed.error?.text).toMatch(/The validation window closed/);
    expect(provider.sends).toEqual([]);
    expect(await preSendCheck(provider, view({ validUntil: new Date(NOW.getTime() + 5001).toISOString() }))).toEqual({ ok: true });
  });
  it("a wallet that does not answer the reads is reported, not prompted", async () => {
    const provider = { request: vi.fn(async () => { throw new Error("provider disconnected"); }) } as any;
    expect(await preSendCheck(provider, view())).toMatchObject({ ok: false, code: "WALLET_UNAVAILABLE" });
  });
});

describe("§10 item 4: the window is read from the clock after every await that precedes eth_sendTransaction", () => {
  /** a wallet whose eth_accounts answers late: the clock moves while the read is pending */
  const slowWallet = (advance: () => void) => { const sends: any[] = []; const request = vi.fn(async ({ method, params }: any) => { if (method === "eth_accounts") { advance(); return [ACCOUNT]; } if (method === "eth_chainId") return "0x4cef52"; if (method === "eth_sendTransaction") { sends.push(params[0]); return D; } throw new Error(`unexpected ${method}`); }); return { request, sends } as any; };
  it("preSendCheck: 60 s left when the call starts, 4 s left once the wallet answered → WINDOW_CLOSED, no prompt", async () => {
    let t = NOW.getTime(); const clock = () => t;
    const provider = slowWallet(() => { t += 56_000; });
    const r = await preSendCheck(provider, view(), clock);
    expect(r).toMatchObject({ ok: false, code: "WINDOW_CLOSED" }); expect((r as any).text).toMatch(/closes in 4 s/);
    expect(windowCheck(view(), NOW.getTime() + 54_999)).toEqual({ ok: true }); expect(windowCheck(view(), NOW.getTime() + 55_000)).toMatchObject({ ok: false, code: "WINDOW_CLOSED" }); // > 5 s must be left
  });
  it("sendValidatedAttempt: the slow eth_accounts read carries the plan past its window → no marker, no eth_sendTransaction, the attempt stays VALIDATED", async () => {
    let t = NOW.getTime();
    const calls = fakeApi({ observe: () => response(view()) });
    const provider = slowWallet(() => { t += 61_000; });
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, poll: { now: () => t } });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("WINDOW_CLOSED"); expect(r.error?.text).toMatch(/The validation window closed/);
    expect(provider.sends).toEqual([]); expect(paths(calls)).toEqual([]); // not even the marker: the check runs before it
    expect(r.attempt?.state).toBe("VALIDATED"); expect(isUncertain(r.attempt)).toBe(false);
  });
  it("sendValidatedAttempt: the marker call itself is the slow await → the window is read once more right before the prompt; no eth_sendTransaction, the claim is handed back", async () => {
    let t = NOW.getTime();
    const calls = fakeApi({ observe: () => response(view()), prompt: (b) => { if (b.event === "not-prompted") return response(view()); t += 57_000; return response(view({ prompt: { state: "PROMPTED", at: NOW.toISOString(), detail: b.detail ?? null } })); } });
    const provider = wallet(() => D);
    const events: string[] = [];
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, poll: { now: () => t }, onEvent: (e) => events.push(e.phase) });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("WINDOW_CLOSED"); expect(r.error?.text).toMatch(/closes in 3 s/);
    expect(provider.sends).toEqual([]); expect(events).not.toContain("prompting");
    expect(paths(calls)).toEqual([PROMPT_PATH, PROMPT_PATH]); // the claim was granted, the re-check failed → the claim is handed back (not-prompted, with the same claim id)
    expect(calls[0].body).toMatchObject({ event: "prompted", claimId: expect.any(String) }); expect(calls[1].body).toEqual({ event: "not-prompted", detail: "WINDOW_CLOSED", claimId: calls[0].body.claimId });
    expect(isUncertain(r.attempt)).toBe(false); expect(rememberedAttempt(ATTEMPT)?.promptState ?? null).toBeNull(); // nothing was prompted and the service knows it: a plain validated attempt again
  });
});

describe("§10 item 1: a restored attempt with a prompt marker (after a refresh) is reconciled, never prompted", () => {
  it("recovers once, then observes; CONFIRMED through OrderPaid ends done; no wallet call at all", async () => {
    let t = NOW.getTime(); const now = () => t;
    const calls = fakeApi({ recover: () => response(view({ prompt: PROMPTED, note: "the wallet was asked to sign this plan and reconciliation found no payment for this order yet" })), observe: (n) => response(n === 0 ? view({ prompt: PROMPTED }) : view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", prompt: PROMPTED })) });
    const events: { phase: string; state?: string }[] = [];
    const r = await reconcileUncertainAttempt({ attempt: view({ prompt: PROMPTED }), withToken, onEvent: (e) => events.push({ phase: e.phase, state: e.attempt?.state }), poll: { intervalMs: 2000, now, wait: async (ms) => { t += ms; } } });
    expect(paths(calls)).toEqual([`POST /v1/wallet/attempts/${ATTEMPT}/recover`, `GET /v1/wallet/attempts/${ATTEMPT}`, `GET /v1/wallet/attempts/${ATTEMPT}`]); // recover once on restore, then observe (chain-reading on the server for such attempts)
    expect(events.map((e) => e.phase)).toEqual(["uncertain", "uncertain", "uncertain", "done"]);
    expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED"); expect(r.txHash).toBe(D);
    expect(calls.some((c) => c.path.endsWith("/abandon"))).toBe(false);
  });
  it("when nothing closes it within the window the attempt stays VALIDATED in phase uncertain: the visitor's explicit abandon is the only 'nothing was sent'; the copy never says it", async () => {
    let t = NOW.getTime(); const now = () => t;
    const calls = fakeApi({ recover: () => response(view({ prompt: PROMPTED })), observe: () => response(view({ prompt: PROMPTED })) });
    const r = await reconcileUncertainAttempt({ attempt: view({ prompt: PROMPTED }), withToken, poll: { intervalMs: 2000, ambiguousMaxMs: 10_000, now, wait: async (ms) => { t += ms; } } });
    expect(r.phase).toBe("uncertain"); expect(r.attempt?.state).toBe("VALIDATED"); expect(r.error ?? null).toBeNull();
    expect(paths(calls).filter((p) => p.endsWith("/recover"))).toHaveLength(1); expect(paths(calls).filter((p) => p.startsWith("GET"))).toHaveLength(5); // 6 ticks over 10 s: recover at 0, observe after
    expect(attemptMessage(r.attempt, "uncertain", { reconciling: true })).toEqual({ text: UNCERTAIN_TEXT, tone: "warn" });
    expect(attemptMessage(r.attempt, "uncertain")).toEqual({ text: UNCERTAIN_OPEN_TEXT, tone: "warn" });
    expect(attemptMessage(r.attempt, "idle", { uncertain: true, reconciling: true }).text).toBe(UNCERTAIN_TEXT); // restored and not yet reconciled: never "waits for your wallet"
    expect(attemptMessage(r.attempt, "open-attempt", { uncertain: true }).text).toBe(UNCERTAIN_OPEN_TEXT);
    for (const text of [UNCERTAIN_TEXT, UNCERTAIN_OPEN_TEXT]) expect(text.toLowerCase()).not.toMatch(/nothing was sent|continue in wallet/);
    expect(UNCERTAIN_TEXT).toBe("The wallet was asked to sign this plan; the transaction may have been submitted. Reconciling from the order state…");
  });
  it("a plainly validated attempt is not reconciled (idle), and a 404 while reconciling ends with the readable error", async () => {
    fakeApi({ observe: () => response(view()) });
    const r = await reconcileUncertainAttempt({ attempt: view(), withToken });
    expect(r.phase).toBe("idle");
    fakeApi({ recover: () => response({ error: "NOT_FOUND" }, 404), observe: () => response(view({ prompt: PROMPTED })) });
    const r2 = await reconcileUncertainAttempt({ attempt: view({ prompt: PROMPTED }), withToken, poll: { wait: async () => {}, intervalMs: 0, ambiguousMaxMs: 0 } });
    expect(r2.phase).toBe("uncertain"); expect(r2.error?.code).toBe("NOT_FOUND");
  });
});

describe("ambiguous submission: the wallet threw something that is not a rejection", () => {
  it("reconciles first (POST …/recover), then polls; a payment found through OrderPaid ends CONFIRMED without any second prompt", async () => {
    let t = NOW.getTime(); const now = () => t;
    const calls = fakeApi({ observe: (n) => response(n === 0 ? view() : view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", note: "recovered through the merchant's OrderPaid event" })), recover: () => response(view()) });
    const events: { phase: string; state?: string }[] = [];
    const provider = wallet(() => { const e: any = new Error("Request timed out"); e.code = -32603; throw e; });
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, onEvent: (e) => events.push({ phase: e.phase, state: e.attempt?.state }), poll: { intervalMs: 2000, now, wait: async (ms) => { t += ms; } } });
    expect(paths(calls)).toEqual(["POST /v1/wallet/attempts", PROMPT_PATH, PROMPT_PATH, `POST /v1/wallet/attempts/${ATTEMPT}/recover`, `GET /v1/wallet/attempts/${ATTEMPT}`, `GET /v1/wallet/attempts/${ATTEMPT}`]); // prompted → unknown-submission markers, recover first, then observe
    const prompts = calls.filter((c) => c.path.endsWith("/prompt")).map((c) => c.body);
    expect(prompts).toEqual([{ event: "prompted", claimId: expect.any(String) }, { event: "unknown-submission", detail: expect.stringMatching(/Request timed out/), claimId: prompts[0].claimId }]); // §10 item 1: the wallet's answer travels as the marker's detail, under the holder's claim id
    expect(rememberedAttempt(ATTEMPT)?.promptState).toBe("UNKNOWN_SUBMISSION");
    expect(calls.some((c) => c.path.endsWith("/abandon"))).toBe(false); // never "nothing was sent" by itself
    expect(provider.sends).toHaveLength(1); // never a second prompt
    expect(events.map((e) => e.phase)).toEqual(["validating", "prompting", "unknown-submission", "unknown-submission", "unknown-submission", "done"]);
    expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED"); expect(r.txHash).toBe(D);
  });
  it("when reconciliation finds nothing within 60 s the attempt stays VALIDATED in phase unknown-submission (explicit abandon is the visitor's), recover is repeated every third tick", async () => {
    let t = NOW.getTime(); const now = () => t;
    const calls = fakeApi({ observe: () => response(view()), recover: () => response(view({ note: "recovery found no payment for this order yet; the validation window is still open" })) });
    const provider = wallet(() => { throw new Error("already known"); });
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { intervalMs: 2000, now, wait: async (ms) => { t += ms; } } });
    expect(r.phase).toBe("unknown-submission"); expect(r.attempt?.state).toBe("VALIDATED"); expect(r.error?.text).toMatch(/already known/);
    const after = paths(calls).slice(1).filter((p) => !p.endsWith("/prompt"));
    expect(after.filter((p) => p.endsWith("/recover"))).toHaveLength(11); expect(after.filter((p) => p.startsWith("GET"))).toHaveLength(20); // 31 ticks over 60 s: recover at 0, 3, 6, …
    expect(after.some((p) => p.endsWith("/abandon"))).toBe(false); expect(provider.sends).toHaveLength(1);
    expect(t - NOW.getTime()).toBe(60_000);
    expect(attemptMessage(r.attempt, "unknown-submission", { reconciling: true }).text).toBe(AMBIGUOUS_TEXT);
    expect(attemptMessage(r.attempt, "unknown-submission").text).toBe(AMBIGUOUS_OPEN_TEXT);
    expect(attemptMessage(r.attempt, "unknown-submission").text).not.toMatch(/nothing was sent/i);
  });
  it("the ambiguous window is configurable and a 404 while reconciling stops with the readable error", async () => {
    let t = NOW.getTime(); const now = () => t;
    fakeApi({ observe: () => response({ error: "NOT_FOUND" }, 404), recover: () => response(view()) });
    const provider = wallet(() => { throw new Error("network error"); });
    const r = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { intervalMs: 1000, ambiguousMaxMs: 5000, now, wait: async (ms) => { t += ms; } } });
    expect(r.phase).toBe("unknown-submission"); expect(r.error?.code).toBe("NOT_FOUND");
  });
});

describe("one execution at a time", () => {
  it("a second call while one is in flight returns the running promise; nothing is validated or prompted twice", async () => {
    let release!: () => void; const gate = new Promise<void>((s) => { release = s; });
    const calls = fakeApi({ observe: () => response(view({ state: "CONFIRMED", txHash: D, businessStatus: "SUCCESS" })) });
    const provider = wallet(async () => { await gate; return D; });
    const p1 = executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { wait: async () => {}, intervalMs: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(executionInFlight()).toBe(true);
    const p2 = executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken });
    const p3 = sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken });
    expect(p2).toBe(p1); expect(p3).toBe(p1);
    release(); const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r2); expect(r2).toBe(r3); expect(r1.phase).toBe("done");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/wallet/attempts")).toHaveLength(1); expect(provider.sends).toHaveLength(1); expect(calls.filter((c) => c.path.endsWith("/prompt"))).toHaveLength(1);
    expect(executionInFlight()).toBe(false);
    // once finished, a new execution may start
    const again = await executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken, poll: { wait: async () => {}, intervalMs: 0 } });
    expect(again).not.toBe(r1);
  });
});

describe("messages", () => {
  it("keys the sentence on the recorded state or the phase, never on preset success copy", () => {
    expect(attemptMessage(null, "validating").tone).toBe("info");
    expect(attemptMessage(view(), "prompting").text).toMatch(/Confirm the transaction in your wallet/);
    expect(attemptMessage(view({ state: "BROADCAST_ATTEMPTED" }), "polling").text).toMatch(/not established yet/);
    expect(attemptMessage(view({ state: "CONFIRMED", businessStatus: "SUCCESS" }))).toEqual({ text: "Order payment confirmed: the order reads as paid by your wallet for the exact amount.", tone: "ok" });
    expect(attemptMessage(view({ state: "CONFIRMED", businessStatus: "FAILED" })).tone).toBe("bad");
    expect(attemptMessage(view({ state: "MISMATCH" })).text).toMatch(/deviates from the validated plan/);
    expect(attemptMessage(view({ state: "NOT_SENT" })).text).toMatch(/Nothing was sent/);
    expect(attemptMessage(view({ state: "NOT_MINED" })).text).toMatch(/never be mined/);
    expect(attemptMessage(view({ state: "VALIDATED", validUntil: new Date(NOW.getTime() - 1000).toISOString() })).text).toMatch(/window closed/);
    expect(attemptMessage(null, "refused").tone).toBe("bad");
    expect(attemptMessage(view(), "unknown-submission", { reconciling: true })).toEqual({ text: AMBIGUOUS_TEXT, tone: "warn" });
    expect(attemptMessage(view(), "open-attempt").tone).toBe("warn");
  });
  it("deviation rows: mismatch (red) vs wallet-set deviations (amber, recorded)", () => {
    expect(deviationRows(null)).toEqual([]);
    expect(deviationRows({ mismatch: ["to", "value"], deviations: { gasLimit: { plan: "40735", actual: "60000" } } })).toEqual([
      { field: "to", plan: null, actual: null, kind: "mismatch" }, { field: "value", plan: null, actual: null, kind: "mismatch" }, { field: "gasLimit", plan: "40735", actual: "60000", kind: "deviation" },
    ]);
  });
});

describe("review of 0c0d406 — the exclusive prompt claim and the re-check after it", () => {
  const UNKNOWN = { state: "UNKNOWN_SUBMISSION" as const, at: NOW.toISOString(), detail: "timeout" };
  /** a wallet whose reads change between calls: eth_chainId answers `chains[n]` on the n-th read, eth_accounts `accounts[n]` */
  const changingWallet = (o: { chains?: number[]; accounts?: string[][] } = {}) => {
    let c = 0, a = 0; const sends: any[] = [];
    const request = vi.fn(async ({ method, params }: any) => {
      if (method === "eth_accounts") { const list = o.accounts ?? [[ACCOUNT]]; return list[Math.min(a++, list.length - 1)]; }
      if (method === "eth_chainId") { const chains = o.chains ?? [5042002]; return `0x${chains[Math.min(c++, chains.length - 1)].toString(16)}`; }
      if (method === "eth_sendTransaction") { sends.push(params[0]); return D; }
      throw new Error(`unexpected ${method}`);
    });
    return { request, sends } as any;
  };
  it("P1-1: the claim is refused (409 PROMPT_CLAIMED — another tab holds it) → no eth_sendTransaction; the attempt is reconciled as uncertain and ends when it closes", async () => {
    const calls = fakeApi({ observe: (n) => response(n === 0 ? view({ prompt: PROMPTED }) : view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", prompt: PROMPTED })), recover: () => response(view({ prompt: PROMPTED })),
      prompt: () => response({ error: "PROMPT_CLAIMED", reason: "already claimed", attempt: view({ prompt: PROMPTED }) }, 409) });
    const provider = wallet(() => D); const events: { phase: string; code?: string }[] = [];
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, onEvent: (e) => events.push({ phase: e.phase, code: e.error?.code }), poll: { wait: async () => {}, intervalMs: 0 } });
    expect(provider.sends).toEqual([]); expect(events.map((e) => e.phase)).not.toContain("prompting");
    expect(events[0]).toEqual({ phase: "uncertain", code: "PROMPT_CLAIMED" });
    expect(paths(calls)).toEqual([PROMPT_PATH, `POST /v1/wallet/attempts/${ATTEMPT}/recover`, `GET /v1/wallet/attempts/${ATTEMPT}`, `GET /v1/wallet/attempts/${ATTEMPT}`]); // reconcile first, then observe; never a second prompt
    expect(r.phase).toBe("done"); expect(r.attempt?.state).toBe("CONFIRMED"); expect(r.txHash).toBe(D);
    expect(rememberedAttempt(ATTEMPT)?.promptState).toBe("PROMPTED"); // the other tab's claim is remembered here too: a refresh keeps the uncertainty
    expect(attemptMessage(r.attempt, "done").text).toMatch(/Order payment confirmed/);
  });
  it("P1-1: a claim refused without the attempt in the body is still treated as held — uncertain, reconciled, no prompt", async () => {
    let t = NOW.getTime();
    const calls = fakeApi({ observe: () => response(view({ prompt: PROMPTED })), recover: () => response(view({ prompt: PROMPTED })), prompt: () => response({ error: "PROMPT_CLAIMED", reason: "already claimed" }, 409) });
    const provider = wallet(() => D);
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, poll: { now: () => t, wait: async (ms) => { t += ms; }, intervalMs: 2000, ambiguousMaxMs: 4000 } });
    expect(provider.sends).toEqual([]); expect(r.phase).toBe("uncertain"); expect(r.error?.code).toBe("PROMPT_CLAIMED"); expect(r.error?.text).toMatch(/Another tab or an earlier request/);
    expect(calls[0].path).toBe(`/v1/wallet/attempts/${ATTEMPT}/prompt`); expect(calls.filter((c) => c.path.endsWith("/prompt"))).toHaveLength(1); // no hand-back: this call never held the claim
    expect(isUncertain(r.attempt)).toBe(true);
  });
  it("P1-2: the wallet's chain changes while the claim request is pending → re-read after the claim, no eth_sendTransaction, the claim is handed back", async () => {
    const calls = fakeApi({ observe: () => response(view()) });
    const provider = changingWallet({ chains: [5042002, 1] });
    const events: string[] = [];
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, onEvent: (e) => events.push(e.phase) });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("CHAIN_CHANGED"); expect(r.error?.text).toMatch(/on chain 1; the plan was validated for chain 5042002/); expect(r.error?.text).toMatch(/Nothing was prompted/);
    expect(provider.sends).toEqual([]); expect(events).not.toContain("prompting");
    expect(calls.map((c) => c.body?.event)).toEqual(["prompted", "not-prompted"]); expect(calls[1].body.claimId).toBe(calls[0].body.claimId); expect(calls[1].body.detail).toBe("CHAIN_CHANGED");
    expect(isUncertain(r.attempt)).toBe(false); expect(rememberedAttempt(ATTEMPT)?.promptState ?? null).toBeNull();
    const methods = provider.request.mock.calls.map((c: any[]) => c[0].method);
    expect(methods.filter((m: string) => m === "eth_chainId")).toHaveLength(2); expect(methods.filter((m: string) => m === "eth_accounts")).toHaveLength(2); // once before the claim, once after it
  });
  it("P1-2: the account switches during the claim → ACCOUNT_CHANGED, nothing prompted, the claim handed back; a wallet that stops answering → WALLET_UNAVAILABLE, same", async () => {
    let calls = fakeApi({ observe: () => response(view()) });
    let r = await sendValidatedAttempt({ provider: changingWallet({ accounts: [[ACCOUNT], [OTHER]] }), account: ACCOUNT, attempt: view(), withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("ACCOUNT_CHANGED"); expect(calls.map((c) => c.body?.event)).toEqual(["prompted", "not-prompted"]); expect(isUncertain(r.attempt)).toBe(false);
    calls = fakeApi({ observe: () => response(view()) });
    let n = 0; const flaky = { request: vi.fn(async ({ method }: any) => { if (method === "eth_accounts") { if (n++ > 0) throw new Error("wallet locked"); return [ACCOUNT]; } if (method === "eth_chainId") return "0x4cef52"; throw new Error(`unexpected ${method}`); }) } as any;
    r = await sendValidatedAttempt({ provider: flaky, account: ACCOUNT, attempt: view(), withToken });
    expect(r.phase).toBe("error"); expect(r.error?.code).toBe("WALLET_UNAVAILABLE"); expect(calls.map((c) => c.body?.event)).toEqual(["prompted", "not-prompted"]);
  });
  it("P1-2: when the hand-back is refused (the marker became UNKNOWN_SUBMISSION meanwhile) the attempt stays uncertain and is reconciled, never prompted", async () => {
    const calls = fakeApi({ observe: () => response(view({ prompt: UNKNOWN })), recover: () => response(view({ prompt: UNKNOWN })),
      prompt: (b) => (b.event === "not-prompted" ? response({ error: "PROMPT_NOT_RELEASABLE", reason: "the marker is UNKNOWN_SUBMISSION", attempt: view({ prompt: UNKNOWN }) }, 409) : response(view({ prompt: PROMPTED }))) });
    const provider = changingWallet({ chains: [5042002, 1] });
    let t = NOW.getTime(); const events: string[] = [];
    const r = await sendValidatedAttempt({ provider, account: ACCOUNT, attempt: view(), withToken, onEvent: (e) => events.push(e.phase), poll: { now: () => t, wait: async (ms) => { t += ms; }, intervalMs: 2000, ambiguousMaxMs: 4000 } });
    expect(provider.sends).toEqual([]); expect(events).not.toContain("prompting");
    expect(r.phase).toBe("uncertain"); expect(r.error?.code).toBe("CHAIN_CHANGED"); expect(r.error?.text).toMatch(/could not be handed back/);
    expect(paths(calls).slice(0, 3)).toEqual([PROMPT_PATH, PROMPT_PATH, `POST /v1/wallet/attempts/${ATTEMPT}/recover`]); // claim, failed hand-back, then reconcile first
    expect(isUncertain(r.attempt)).toBe(true); expect(r.attempt?.prompt?.state).toBe("UNKNOWN_SUBMISSION");
  });
});

describe("review of c3afab7 (P2) · an operation's browser memory lands under the instance the operation is bound to", () => {
  // The remembered attempts (the id written before the prompt, the marker, the states the polls bring back) used to be stored under the instance
  // selected at the moment of each write: an execution bound to /testnet whose wallet prompt outlived a switch to root wrote its attempt into
  // ROOT's memory — and a VALIDATED attempt restored on /testnet was read against root's memory, so its prompt marker went unseen.
  const stored = (scope: string) => JSON.parse(storage.get(`arcpreflight.attempts:${scope}`) ?? "{}");
  const ROOT_ATTEMPT = { attemptId: "root-att", orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED" };
  const CONFIRMED = () => response(view({ state: "CONFIRMED", txHash: D, businessTxHash: D, businessStatus: "SUCCESS", block: "200", deviations: { mismatch: [], deviations: {} } }));
  /** the fake API moved under /testnet: a request that reaches the root instance is answered 403 and recorded */
  function underTestnet(): string[] {
    const inner = globalThis.fetch as any; const wrong: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { if (!path.startsWith("/testnet/")) { wrong.push(path); return response({ error: "WRONG_INSTANCE" }, 403); } return inner(path.slice("/testnet".length), init); }));
    return wrong;
  }
  const onTestnet = () => { setApiBase("/testnet"); resetSessions(); storage.set("arcpreflight.session:/testnet", JSON.stringify({ principal: "visitor:1", token: "tok" })); storage.set("arcpreflight.attempts:root", JSON.stringify({ "root-att": ROOT_ATTEMPT })); };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  it("reproduction: an execution bound to /testnet whose wallet prompt outlives a switch to root remembers its attempt under /testnet, and root's memory keeps only its own attempt", async () => {
    onTestnet(); fakeApi({ observe: (n) => (n === 0 ? response(view({ state: "BROADCAST_ATTEMPTED", txHash: D })) : CONFIRMED()) }); const wrong = underTestnet();
    let release: ((h: string) => void) | null = null;
    const provider = wallet(() => new Promise<string>((r) => { release = r; }));
    const pending = executeAttempt({ provider, account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken: sessionFor("/testnet"), poll: { wait: async () => {}, intervalMs: 0 } });
    for (let i = 0; i < 100 && !release; i++) await flush(); if (!release) throw new Error("the wallet was never asked");
    expect(stored("/testnet")[ATTEMPT]).toMatchObject({ state: "VALIDATED", promptState: "PROMPTED" }); // remembered before the prompt, under the operation's instance
    setApiBase(""); // the root instance is selected while the wallet is open
    release!(D); const ev = await pending;
    expect(ev.phase).toBe("done"); expect(wrong).toEqual([]); // the hash report and the polls stayed on /testnet …
    expect(stored("/testnet")[ATTEMPT].state).toBe("CONFIRMED"); // … and so did their memory
    expect(stored("root")).toEqual({ "root-att": ROOT_ATTEMPT }); // root's memory is untouched (the hash report and the polls used to write the testnet attempt here)
  });
  it("control: without a switch the same execution remembers its attempt under /testnet and leaves root's memory alone", async () => {
    onTestnet(); fakeApi({ observe: () => CONFIRMED() }); const wrong = underTestnet();
    const ev = await executeAttempt({ provider: wallet(() => D), account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken: sessionFor("/testnet"), poll: { wait: async () => {}, intervalMs: 0 } });
    expect(ev.phase).toBe("done"); expect(wrong).toEqual([]);
    expect(stored("/testnet")[ATTEMPT].state).toBe("CONFIRMED"); expect(stored("root")).toEqual({ "root-att": ROOT_ATTEMPT });
    expect(rememberedAttempts("/testnet").map((a) => a.attemptId)).toEqual([ATTEMPT]); expect(rememberedAttempt(ATTEMPT, "")).toBeNull(); // the reads take the instance too
  });
  it("concurrent variant: while the /testnet prompt is open the root page remembers a root attempt — afterwards each instance's memory holds exactly its own; an unbound caller's memory follows the instance selected when ITS operation began", async () => {
    onTestnet(); fakeApi({ observe: () => CONFIRMED() }); const wrong = underTestnet();
    let release: ((h: string) => void) | null = null;
    const pending = executeAttempt({ provider: wallet(() => new Promise<string>((r) => { release = r; })), account: ACCOUNT, requestId: REQUEST, orderId: ORDER, policy: {}, withToken: sessionFor("/testnet"), poll: { wait: async () => {}, intervalMs: 0 } });
    for (let i = 0; i < 100 && !release; i++) await flush(); if (!release) throw new Error("the wallet was never asked");
    setApiBase(""); rememberAttempt({ attemptId: "root-2", orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" }, ""); // the root page, meanwhile
    release!(D); const ev = await pending;
    expect(ev.phase).toBe("done"); expect(wrong).toEqual([]);
    expect(Object.keys(stored("root")).sort()).toEqual(["root-2", "root-att"]); expect(Object.keys(stored("/testnet"))).toEqual([ATTEMPT]);
    // an unbound withToken (no `base`): the instance selected when the operation starts is fixed then — a switch during the prompt changes nothing
    resetExecutionGuard(); setApiBase("/testnet"); storage.delete("arcpreflight.attempts:/testnet");
    let release2: ((h: string) => void) | null = null; const unbound = async <T,>(fn: (t: string, c: ApiClient) => Promise<T>) => fn("tok", apiFor("/testnet"));
    const pending2 = sendValidatedAttempt({ provider: wallet(() => new Promise<string>((r) => { release2 = r; })), account: ACCOUNT, attempt: view(), withToken: unbound, poll: { wait: async () => {}, intervalMs: 0 } });
    for (let i = 0; i < 100 && !release2; i++) await flush(); if (!release2) throw new Error("the wallet was never asked");
    setApiBase(""); release2!(D); expect((await pending2).phase).toBe("done");
    expect(stored("/testnet")[ATTEMPT].state).toBe("CONFIRMED"); expect(Object.keys(stored("root")).sort()).toEqual(["root-2", "root-att"]);
  });
  it("reproduction (the read side): a VALIDATED attempt whose prompt marker lives only in /testnet's memory is reconciled through its /testnet-bound session while root is selected — not taken for idle", async () => {
    onTestnet(); storage.set("arcpreflight.attempts:/testnet", JSON.stringify({ [ATTEMPT]: { attemptId: ATTEMPT, orderId: ORDER, requestId: REQUEST, createdAt: NOW.toISOString(), state: "VALIDATED", promptState: "PROMPTED" } }));
    const calls = fakeApi({ observe: () => CONFIRMED(), recover: () => CONFIRMED() }); const wrong = underTestnet();
    setApiBase(""); // root selected; the restored attempt belongs to /testnet
    const events: string[] = [];
    const ev = await reconcileUncertainAttempt({ attempt: view() /* the server view carries no marker; only the browser's memory does */, withToken: sessionFor("/testnet"), onEvent: (e) => events.push(e.phase), poll: { wait: async () => {}, intervalMs: 0 } });
    expect(events[0]).toBe("uncertain"); expect(ev.phase).toBe("done"); expect(wrong).toEqual([]); // reconciled (recover once) and closed — root's empty memory used to make it "idle"
    expect(paths(calls)).toContain(`POST /v1/wallet/attempts/${ATTEMPT}/recover`);
    expect(stored("/testnet")[ATTEMPT].state).toBe("CONFIRMED"); expect(stored("root")).toEqual({ "root-att": ROOT_ATTEMPT });
  });
});
