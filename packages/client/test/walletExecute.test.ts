import { describe, expect, it } from "vitest";
import { executeValidatedAttempt, preSendChecks, walletRequestFromPlan, MIN_WINDOW_LEFT_MS, type AttemptLike } from "../src/walletExecute.js";

// The hand-over helper for integrators (usage guide, 2026-10-10): plan → wallet fields; account, chain, window and claim checked before the
// prompt; the hash reported at once; a rejection abandoned; anything else marked and reconciled; a claim held elsewhere never prompts.
const PAYER = "0xA71138FF271DB9A18D2B216cAF13b830Eeab3FF2";
const PLAN = { chainId: 5042002, from: PAYER, to: "0xa8eb51ef994567b84215981e8d1fe17cb8e42252", data: "0x8609cad1" + "ab".repeat(32), valueNativeAtomic: "50000000000000000", gasLimit: "40735", maxFeePerGasNativeAtomic: "29000000000", maxPriorityFeePerGasNativeAtomic: "5000000000", type: 2 };
const NOW = Date.parse("2026-10-10T12:00:00Z"); const now = () => NOW;
const HASH = `0x${"7a".repeat(32)}`;
const attempt = (over: Partial<AttemptLike> = {}): AttemptLike => ({ attemptId: "att-1", state: "VALIDATED", payer: PAYER, validUntil: new Date(NOW + 60_000).toISOString(), plan: PLAN, prompt: null, txHash: null, ...over });
const wallet = (onSend: (tx: any) => unknown, over: { accounts?: string[]; chain?: string } = {}) => {
  const calls: string[] = [];
  return { calls, request: async ({ method, params }: { method: string; params?: unknown[] }) => { calls.push(method); if (method === "eth_accounts") return over.accounts ?? [PAYER]; if (method === "eth_chainId") return over.chain ?? "0x4cef52"; if (method === "eth_sendTransaction") return onSend(params![0]); throw new Error(`unexpected ${method}`); } };
};
/** a fake API: records every call; answers by path and method */
function api(routes: Record<string, (body: any) => { status: number; body: unknown }>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.test", ""); const body = init?.body ? JSON.parse(init.body as string) : undefined; calls.push({ method: init?.method ?? "GET", path, body });
    const key = `${init?.method ?? "GET"} ${path}`; const r = routes[key]?.(body) ?? { status: 404, body: { error: "NOT_FOUND" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}
const BASE = "/v1/wallet/attempts/att-1";
const ok = (b: unknown) => ({ status: 200, body: b });
const run = (a: ReturnType<typeof api>, w: ReturnType<typeof wallet>, extra: Partial<Parameters<typeof executeValidatedAttempt>[0]> = {}) => executeValidatedAttempt({ api: "https://api.test", token: "tok", attemptId: "att-1", provider: w, fetch: a.fetch, now, claimId: "claim-123", ...extra });

describe("walletRequestFromPlan", () => {
  it("hands the wallet exactly the plan as hex quantities, type 2, bound to the plan's chain, without a nonce", () => {
    expect(walletRequestFromPlan(PLAN)).toEqual({ from: PAYER, to: PLAN.to, data: PLAN.data, value: "0xb1a2bc2ec50000", gas: "0x9f1f", maxFeePerGas: "0x6c088e200", maxPriorityFeePerGas: "0x12a05f200", type: "0x2", chainId: "0x4cef52" });
    expect("nonce" in walletRequestFromPlan(PLAN)).toBe(false);
  });
});
describe("preSendChecks", () => {
  it("passes for a validated attempt whose wallet is on the payer's account and chain with time left; the clock is read after the wallet answered", async () => {
    expect(await preSendChecks(wallet(() => HASH), attempt(), now)).toEqual({ ok: true });
  });
  it("refuses a closed attempt, a prompt marker, another account, another chain, a closing window and a silent wallet, each with its reason", async () => {
    expect((await preSendChecks(wallet(() => HASH), attempt({ state: "NOT_SENT" }), now) as any).code).toBe("ATTEMPT_NOT_OPEN");
    expect((await preSendChecks(wallet(() => HASH), attempt({ prompt: { state: "PROMPTED" } }), now) as any).code).toBe("ATTEMPT_UNCERTAIN");
    expect((await preSendChecks(wallet(() => HASH, { accounts: ["0x0000000000000000000000000000000000000b11"] }), attempt(), now) as any).code).toBe("ACCOUNT_CHANGED");
    expect((await preSendChecks(wallet(() => HASH, { chain: "0x1" }), attempt(), now) as any).code).toBe("CHAIN_CHANGED");
    expect((await preSendChecks(wallet(() => HASH), attempt({ validUntil: new Date(NOW + MIN_WINDOW_LEFT_MS - 1).toISOString() }), now) as any).code).toBe("WINDOW_CLOSED");
    expect((await preSendChecks({ request: async () => { throw new Error("locked"); } }, attempt(), now) as any).code).toBe("WALLET_UNAVAILABLE");
  });
});
describe("executeValidatedAttempt", () => {
  it("reads the attempt, checks, claims the prompt with the claim id, checks again, sends exactly the plan, reports the hash at once", async () => {
    const a = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: (b) => ok(attempt({ prompt: { state: b.event === "prompted" ? "PROMPTED" : "UNKNOWN_SUBMISSION" } })), [`POST ${BASE}/sent`]: (b) => ok(attempt({ state: "BROADCAST_ATTEMPTED", txHash: b.txHash })) });
    const sends: any[] = []; const w = wallet((tx) => { sends.push(tx); return HASH; });
    const r = await run(a, w);
    expect(r).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "BROADCAST_ATTEMPTED", txHash: HASH } });
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BASE}`, `POST ${BASE}/prompt`, `POST ${BASE}/sent`]);
    expect(a.calls[1].body).toEqual({ event: "prompted", claimId: "claim-123" }); expect(a.calls[2].body).toEqual({ txHash: HASH });
    expect(sends).toEqual([walletRequestFromPlan(PLAN)]);
    expect(w.calls).toEqual(["eth_accounts", "eth_chainId", "eth_accounts", "eth_chainId", "eth_sendTransaction"]); // the wallet is read before the claim and again after it, then asked once
  });
  it("a failed check before the claim prompts nothing and claims nothing; a failed check after the claim hands the claim back with the same id", async () => {
    const a = api({ [`GET ${BASE}`]: () => ok(attempt()) });
    const r = await run(a, wallet(() => HASH, { accounts: ["0x0000000000000000000000000000000000000b11"] }));
    expect(r).toMatchObject({ outcome: "not-prompted", check: { code: "ACCOUNT_CHANGED" } }); expect(a.calls.map((c) => c.path)).toEqual([BASE]);
    let reads = 0; const w = { calls: [] as string[], request: async ({ method }: { method: string }) => { if (method === "eth_accounts") return [PAYER]; if (method === "eth_chainId") return ++reads > 1 ? "0x1" : "0x4cef52"; throw new Error("never asked"); } }; // the chain changes while the claim is written
    const b = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: (body) => ok(attempt({ prompt: body.event === "not-prompted" ? null : { state: "PROMPTED" } })) });
    const r2 = await run(b, w);
    expect(r2).toMatchObject({ outcome: "not-prompted", check: { code: "CHAIN_CHANGED" }, attempt: { prompt: null } });
    expect(b.calls.map((c) => [c.path, c.body?.event, c.body?.claimId])).toEqual([[BASE, undefined, undefined], [`${BASE}/prompt`, "prompted", "claim-123"], [`${BASE}/prompt`, "not-prompted", "claim-123"]]);
  });
  it("a claim held by another caller means no prompt at all; a rejected prompt is abandoned; any other wallet error is marked unknown-submission and reconciled", async () => {
    const held = attempt({ prompt: { state: "PROMPTED" } });
    const a = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: () => ({ status: 409, body: { error: "PROMPT_CLAIMED", attempt: held } }) });
    const w = wallet(() => { throw new Error("must not be asked"); });
    expect(await run(a, w)).toMatchObject({ outcome: "claimed-elsewhere", attempt: { prompt: { state: "PROMPTED" } } }); expect(w.calls).not.toContain("eth_sendTransaction");
    const b = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: () => ok(attempt({ prompt: { state: "PROMPTED" } })), [`POST ${BASE}/abandon`]: () => ok(attempt({ state: "NOT_SENT" })) });
    expect(await run(b, wallet(() => { throw Object.assign(new Error("User rejected the request"), { code: 4001 }); }))).toMatchObject({ outcome: "abandoned", attempt: { state: "NOT_SENT" } });
    expect(b.calls.map((c) => c.path)).toEqual([BASE, `${BASE}/prompt`, `${BASE}/abandon`]);
    const c = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: (body) => ok(attempt({ prompt: { state: body.event === "prompted" ? "PROMPTED" : "UNKNOWN_SUBMISSION" } })), [`POST ${BASE}/recover`]: () => ok(attempt({ state: "CONFIRMED", txHash: HASH })) });
    const r = await run(c, wallet(() => { throw new Error("request timed out"); }));
    expect(r).toMatchObject({ outcome: "unknown-submission", error: "request timed out", attempt: { state: "CONFIRMED" } }); // reconciliation found the payment through the order
    expect(c.calls.map((c) => [c.path, c.body?.event])).toEqual([[BASE, undefined], [`${BASE}/prompt`, "prompted"], [`${BASE}/prompt`, "unknown-submission"], [`${BASE}/recover`, undefined]]);
  });
  it("an attempt that is not open, or already carries a prompt marker, is never handed to the wallet", async () => {
    const a = api({ [`GET ${BASE}`]: () => ok(attempt({ prompt: { state: "PROMPTED" } })) });
    const w = wallet(() => HASH);
    expect(await run(a, w)).toMatchObject({ outcome: "not-prompted", check: { code: "ATTEMPT_UNCERTAIN" } }); expect(w.calls).toEqual([]); expect(a.calls).toHaveLength(1);
  });
});
