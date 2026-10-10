import { describe, expect, it } from "vitest";
import { completePendingRecovery, executeValidatedAttempt, preSendChecks, releaseClaim, reportSent, settledPendingRecovery, walletRequestFromPlan, MIN_WINDOW_LEFT_MS, type AttemptLike, type PendingRecovery } from "../src/walletExecute.js";

// The hand-over helper for integrators (usage guide, 2026-10-10): plan → wallet fields; account, chain, window and claim checked before the
// prompt; the hash reported at once; a rejection abandoned; anything else marked and reconciled; a claim held elsewhere never prompts.
// Review of 199dd55: a fact the wallet established survives a failed API call as `pending-recovery` (the hash, the claim, the rejection, the
// wallet's error), and `completePendingRecovery` retries exactly the missing call — the wallet is never asked a second time.
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
    const key = `${init?.method ?? "GET"} ${path}`; const r = routes[key]?.(body) ?? { status: 404, body: { error: "NOT_FOUND" } }; // a route that throws stands for a transport failure
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
describe("pending-recovery: what the wallet settled is never lost to a failed API call (review of 199dd55)", () => {
  const down = () => { throw new TypeError("Failed to fetch"); };
  const target = (a: ReturnType<typeof api>) => ({ api: "https://api.test", token: "tok", attemptId: "att-1", fetch: a.fetch });
  it("a hash the wallet returned survives a failed report: the result keeps it, the attempt is reconciled, the wallet was asked once; the report is finished later; the helper never prompts that attempt again", async () => {
    let reportable = false;
    const a = api({ [`GET ${BASE}`]: () => ok(reportable ? attempt({ prompt: { state: "PROMPTED" } }) : attempt()), [`POST ${BASE}/prompt`]: () => ok(attempt({ prompt: { state: "PROMPTED" } })), [`POST ${BASE}/sent`]: (b) => (reportable ? ok(attempt({ state: "BROADCAST_ATTEMPTED", txHash: b.txHash })) : down()), [`POST ${BASE}/recover`]: () => ok(attempt({ prompt: { state: "PROMPTED" }, note: "reconciliation found no payment for this order yet" })) });
    const w = wallet(() => HASH);
    const r = await run(a, w);
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "report-sent", txHash: HASH, claimId: "claim-123", error: "Failed to fetch", attempt: { note: "reconciliation found no payment for this order yet" } });
    expect((r as PendingRecovery).next).toContain(`POST ${BASE}/sent`); expect((r as PendingRecovery).next).toContain(HASH);
    expect(a.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BASE}`, `POST ${BASE}/prompt`, `POST ${BASE}/sent`, `POST ${BASE}/recover`]); // reconciled from the order without the hash; nothing else
    expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
    reportable = true; // the API is reachable again
    expect(await completePendingRecovery(target(a), r as PendingRecovery)).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "BROADCAST_ATTEMPTED", txHash: HASH } });
    expect(a.calls.at(-1)).toMatchObject({ method: "POST", path: `${BASE}/sent`, body: { txHash: HASH } });
    expect(await reportSent(target(a), HASH)).toMatchObject({ txHash: HASH }); // the plain report, for a caller that kept the hash itself
    const again = await run(a, w); // the same attempt once more: the server's prompt marker refuses it before any wallet read
    expect(again).toMatchObject({ outcome: "not-prompted", check: { code: "ATTEMPT_UNCERTAIN" } }); expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  });
  it("a hash whose report failed stays in the result even when the reconciliation call fails too", async () => {
    const a = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: () => ok(attempt({ prompt: { state: "PROMPTED" } })), [`POST ${BASE}/sent`]: () => ({ status: 503, body: { error: "DEPENDENCY_ERROR", reason: "store unavailable" } }), [`POST ${BASE}/recover`]: down });
    const r = await run(a, wallet(() => HASH));
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "report-sent", txHash: HASH, error: "HTTP 503 DEPENDENCY_ERROR: store unavailable", attempt: { prompt: { state: "PROMPTED" } } }); // the last view the service gave
  });
  it("a failed claim release is unresolved, not not-prompted: the claim id and the failed check are kept, and the release is finished later", async () => {
    let reads = 0; const w = { calls: [] as string[], request: async ({ method }: { method: string }) => { if (method === "eth_accounts") return [PAYER]; if (method === "eth_chainId") return ++reads > 1 ? "0x1" : "0x4cef52"; throw new Error("never asked"); } };
    let releasable = false, held = false; // the service: the claim stays held while its release is refused by the network
    const a = api({ [`GET ${BASE}`]: () => ok(held ? attempt({ prompt: { state: "PROMPTED" } }) : attempt()), [`POST ${BASE}/prompt`]: (b) => { if (b.event === "not-prompted") { if (!releasable) down(); held = false; return ok(attempt()); } held = true; return ok(attempt({ prompt: { state: "PROMPTED" } })); } });
    const r = await run(a, w);
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "release-claim", txHash: null, claimId: "claim-123", check: { code: "CHAIN_CHANGED" }, attempt: { prompt: { state: "PROMPTED" } }, error: "Failed to fetch" });
    expect((r as PendingRecovery).next).toContain('"not-prompted"');
    expect(await completePendingRecovery(target(a), r as PendingRecovery)).toMatchObject({ outcome: "pending-recovery", stage: "release-claim", error: "Failed to fetch" }); // still held, still unreachable: pending again
    releasable = true;
    expect(await completePendingRecovery(target(a), r as PendingRecovery)).toMatchObject({ outcome: "not-prompted", check: { code: "CHAIN_CHANGED" }, attempt: { prompt: null } });
    expect(a.calls.at(-1)?.body).toEqual({ event: "not-prompted", claimId: "claim-123", detail: "CHAIN_CHANGED" }); // the same claim id, as the API requires
    expect(await releaseClaim(target(a), "claim-123")).toMatchObject({ prompt: null }); expect(a.calls.at(-1)?.body).toEqual({ event: "not-prompted", claimId: "claim-123" });
  });
  it("a rejection whose abandon failed and a wallet error whose mark failed are pending-recovery with their facts; completing them abandons, or marks and reconciles", async () => {
    let up = false;
    const a = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: (b) => ok(attempt({ prompt: { state: b.event === "prompted" ? "PROMPTED" : "UNKNOWN_SUBMISSION" } })), [`POST ${BASE}/abandon`]: () => (up ? ok(attempt({ state: "NOT_SENT" })) : down()) });
    const r = await run(a, wallet(() => { throw Object.assign(new Error("User rejected the request"), { code: 4001 }); }));
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "abandon", txHash: null, claimId: "claim-123", error: "Failed to fetch" }); expect((r as PendingRecovery).next).toContain(`POST ${BASE}/abandon`);
    expect(await completePendingRecovery(target(a), r as PendingRecovery)).toMatchObject({ outcome: "pending-recovery", stage: "abandon", error: "Failed to fetch" }); // still down: the same result, the new error
    up = true; expect(await completePendingRecovery(target(a), r as PendingRecovery)).toMatchObject({ outcome: "abandoned", attempt: { state: "NOT_SENT" } });
    let markable = false;
    const b = api({ [`GET ${BASE}`]: () => ok(attempt()), [`POST ${BASE}/prompt`]: (body) => (body.event === "unknown-submission" ? (markable ? ok(attempt({ prompt: { state: "UNKNOWN_SUBMISSION" } })) : down()) : ok(attempt({ prompt: { state: "PROMPTED" } }))), [`POST ${BASE}/recover`]: () => ok(attempt({ state: "CONFIRMED", txHash: HASH })) });
    const r2 = await run(b, wallet(() => { throw new Error("request timed out"); }));
    expect(r2).toMatchObject({ outcome: "pending-recovery", stage: "mark-unknown-submission", txHash: null, walletError: "request timed out", claimId: "claim-123", error: "Failed to fetch" });
    expect(b.calls.map((c) => c.path)).toEqual([BASE, `${BASE}/prompt`, `${BASE}/prompt`]); // no recover before the mark is durable
    markable = true;
    expect(await completePendingRecovery(target(b), r2 as PendingRecovery)).toMatchObject({ outcome: "unknown-submission", error: "request timed out", attempt: { state: "CONFIRMED" } });
    expect(b.calls.slice(3).map((c) => [c.path, c.body?.event, c.body?.claimId, c.body?.detail])).toEqual([[BASE, undefined, undefined, undefined], [`${BASE}/prompt`, "unknown-submission", "claim-123", "request timed out"], [`${BASE}/recover`, undefined, undefined, undefined]]); // read first, then the mark, then the reconciliation
  });
});
describe("lost answers never leave recovery stuck (review of 0d14ad9): a step the service applied is recognised from the attempt, and a repeat is the same call", () => {
  const target = (a: ReturnType<typeof api>) => ({ api: "https://api.test", token: "tok", attemptId: "att-1", fetch: a.fetch });
  const conflict = (error: string, attempt?: AttemptLike) => ({ status: 409, body: { error, reason: error, ...(attempt ? { attempt } : {}) } });
  /** a service that applies every call before answering, and loses the answers it is told to lose (`drop[route]` times); idempotent like the real one */
  function service(initial: AttemptLike = attempt(), drop: Record<string, number> = {}, opts: { holder?: string | null; staleGets?: number } = {}) {
    const s = { a: initial, holder: opts.holder ?? null, staleGets: opts.staleGets ?? 0, drop };
    const lose = (route: string) => { if ((s.drop[route] ?? 0) > 0) { s.drop[route]--; throw new TypeError("Failed to fetch"); } };
    const stale = initial;
    const calls = api({
      [`GET ${BASE}`]: () => ok(s.staleGets-- > 0 ? stale : s.a),
      [`POST ${BASE}/prompt`]: (b) => {
        if (s.a.state !== "VALIDATED") return conflict("ATTEMPT_NOT_OPEN");
        if (b.event === "prompted") { if (s.a.prompt && s.holder !== b.claimId) { lose("prompted-refused"); return conflict("PROMPT_CLAIMED", s.a); } s.a = { ...s.a, prompt: { state: "PROMPTED" } }; s.holder = b.claimId; lose("prompted"); return ok(s.a); }
        if (b.event === "not-prompted") { if (!s.a.prompt) return ok(s.a); if (s.holder !== b.claimId) return conflict("PROMPT_CLAIMED", s.a); if (s.a.prompt.state !== "PROMPTED") return conflict("PROMPT_NOT_RELEASABLE", s.a); s.a = { ...s.a, prompt: null }; s.holder = null; lose("not-prompted"); return ok(s.a); }
        s.a = { ...s.a, prompt: { state: "UNKNOWN_SUBMISSION" } }; lose("unknown-submission"); return ok(s.a);
      },
      [`POST ${BASE}/sent`]: (b) => { if (s.a.state !== "VALIDATED") return s.a.txHash === b.txHash ? ok(s.a) : conflict("ATTEMPT_NOT_OPEN"); s.a = { ...s.a, state: "BROADCAST_ATTEMPTED", txHash: b.txHash }; lose("sent"); return ok(s.a); },
      [`POST ${BASE}/abandon`]: () => { if (s.a.state === "NOT_SENT") return ok(s.a); if (s.a.state !== "VALIDATED") return conflict("ATTEMPT_NOT_OPEN"); s.a = { ...s.a, state: "NOT_SENT" }; lose("abandon"); return ok(s.a); },
      [`POST ${BASE}/recover`]: () => ok(s.a),
    });
    return { s, ...calls, since: (n: number) => calls.calls.slice(n).map((c) => `${c.method} ${c.path}${c.body?.event ? ` ${c.body.event}` : ""}`) };
  }
  it("the report's answer was lost after the hash was recorded: completion finds the hash on record and answers sent without a second report; a second completion changes nothing", async () => {
    const svc = service(attempt(), { sent: 1 }); const w = wallet(() => HASH);
    const r = await run(svc, w);
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "report-sent", txHash: HASH }); expect(svc.s.a).toMatchObject({ state: "BROADCAST_ATTEMPTED", txHash: HASH }); // applied, unanswered
    const n = svc.calls.length;
    expect(await completePendingRecovery(target(svc), r as PendingRecovery)).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "BROADCAST_ATTEMPTED", txHash: HASH } });
    expect(svc.since(n)).toEqual([`GET ${BASE}`]); // recognised from the attempt: no call that could conflict
    expect(await completePendingRecovery(target(svc), r as PendingRecovery)).toMatchObject({ outcome: "sent" }); expect(svc.since(n)).toEqual([`GET ${BASE}`, `GET ${BASE}`]);
    expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
    expect(await reportSent(target(svc), HASH)).toMatchObject({ state: "BROADCAST_ATTEMPTED", txHash: HASH }); // the plain repeat is idempotent on the service
  });
  it("a stale read followed by a 409 on the repeat (the attempt moved in between) is read again and decided from — never returned as pending for ever", async () => {
    const svc = service(attempt(), { sent: 1 }); const r = await run(svc, wallet(() => HASH));
    svc.s.staleGets = 1; // the next read still answers the attempt as it was before the report
    expect(await completePendingRecovery(target(svc), r as PendingRecovery)).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "BROADCAST_ATTEMPTED" } });
    const b = service(attempt(), { sent: 1 }); const r2 = await run(b, wallet(() => HASH));
    b.s.a = { ...b.s.a, state: "CONFIRMED", txHash: null, businessTxHash: HASH }; // closed through the order before the hash was recorded (OrderPaid)
    expect(await completePendingRecovery(target(b), r2 as PendingRecovery)).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "CONFIRMED" } }); // the caller keeps the hash; the attempt is closed
  });
  it("a rejection whose abandon was applied but unanswered: completion reads NOT_SENT and answers abandoned without a second abandon; a wallet error whose mark was applied: no second mark, reconciled", async () => {
    const svc = service(attempt(), { abandon: 1 });
    const r = await run(svc, wallet(() => { throw Object.assign(new Error("User rejected the request"), { code: 4001 }); }));
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "abandon" }); expect(svc.s.a.state).toBe("NOT_SENT");
    const n = svc.calls.length; expect(await completePendingRecovery(target(svc), r as PendingRecovery)).toMatchObject({ outcome: "abandoned", attempt: { state: "NOT_SENT" } }); expect(svc.since(n)).toEqual([`GET ${BASE}`]);
    const b = service(attempt(), { "unknown-submission": 1 });
    const r2 = await run(b, wallet(() => { throw new Error("request timed out"); }));
    expect(r2).toMatchObject({ outcome: "pending-recovery", stage: "mark-unknown-submission", walletError: "request timed out" }); expect(b.s.a.prompt).toEqual({ state: "UNKNOWN_SUBMISSION" });
    const m = b.calls.length; expect(await completePendingRecovery(target(b), r2 as PendingRecovery)).toMatchObject({ outcome: "unknown-submission", error: "request timed out", attempt: { prompt: { state: "UNKNOWN_SUBMISSION" } } });
    expect(b.since(m)).toEqual([`GET ${BASE}`, `POST ${BASE}/recover`]); // the marker is on record: reconcile only
  });
  it("a release whose answer was lost after the claim was handed back: completion reads the attempt unclaimed and answers not-prompted with the failed check; a run afterwards takes a fresh claim", async () => {
    let reads = 0; const w = { calls: [] as string[], request: async ({ method }: { method: string }) => { w.calls.push(method); if (method === "eth_accounts") return [PAYER]; if (method === "eth_chainId") return ++reads === 2 ? "0x1" : "0x4cef52"; if (method === "eth_sendTransaction") return HASH; throw new Error(`unexpected ${method}`); } }; // the chain is wrong at the second read only
    const svc = service(attempt(), { "not-prompted": 1 });
    const r = await run(svc, w);
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "release-claim", check: { code: "CHAIN_CHANGED" }, claimId: "claim-123" }); expect(svc.s.a.prompt).toBeNull(); expect(svc.s.holder).toBeNull(); // handed back, unanswered
    const n = svc.calls.length; expect(await completePendingRecovery(target(svc), r as PendingRecovery)).toMatchObject({ outcome: "not-prompted", check: { code: "CHAIN_CHANGED" }, attempt: { prompt: null } }); expect(svc.since(n)).toEqual([`GET ${BASE}`]);
    expect(await run(svc, w, { claimId: "claim-456" })).toMatchObject({ outcome: "sent", txHash: HASH }); // the next execution claims afresh and goes through
    expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  });
  it("the claim's answer was lost after the grant: the same id asks once more, is recognised as the holder, and the execution goes on to one prompt", async () => {
    const svc = service(attempt(), { prompted: 1 }); const w = wallet(() => HASH);
    expect(await run(svc, w)).toMatchObject({ outcome: "sent", txHash: HASH, attempt: { state: "BROADCAST_ATTEMPTED" } });
    expect(svc.since(0)).toEqual([`GET ${BASE}`, `POST ${BASE}/prompt prompted`, `POST ${BASE}/prompt prompted`, `POST ${BASE}/sent`]); // the repeat under the same claim id, then the prompt once
    expect(svc.calls.filter((c) => c.body?.event === "prompted").map((c) => c.body.claimId)).toEqual(["claim-123", "claim-123"]); expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  });
  it("the claim's answer was lost twice: pending at the claim stage; completion reads the marker, hands this call's claim back and says CLAIM_UNCONFIRMED; the next run claims afresh — nothing was ever prompted twice", async () => {
    const svc = service(attempt(), { prompted: 2 }); const w = wallet(() => HASH);
    const r = await run(svc, w);
    expect(r).toMatchObject({ outcome: "pending-recovery", stage: "claim", txHash: null, claimId: "claim-123" }); expect(svc.s.a.prompt).toEqual({ state: "PROMPTED" }); expect(svc.s.holder).toBe("claim-123"); expect(w.calls).not.toContain("eth_sendTransaction");
    const n = svc.calls.length; const done = await completePendingRecovery(target(svc), r as PendingRecovery);
    expect(done).toMatchObject({ outcome: "not-prompted", check: { code: "CLAIM_UNCONFIRMED" }, attempt: { prompt: null } }); expect(svc.since(n)).toEqual([`GET ${BASE}`, `POST ${BASE}/prompt not-prompted`]); expect(svc.calls.at(-1)?.body).toMatchObject({ claimId: "claim-123" });
    expect(await run(svc, w, { claimId: "claim-456" })).toMatchObject({ outcome: "sent", txHash: HASH }); expect(w.calls.filter((m) => m === "eth_sendTransaction")).toHaveLength(1);
  });
  it("the lost answer was somebody else's refusal: the repeat under the same id meets 409 PROMPT_CLAIMED and the outcome is claimed-elsewhere, without a prompt", async () => {
    const svc = service(attempt({ prompt: null }), { "prompted-refused": 1 }, { holder: "tab-b" }); svc.s.a = { ...svc.s.a, prompt: { state: "PROMPTED" } }; // held by another tab; the server's view carries the marker
    const w = wallet(() => HASH);
    const held = await run({ ...svc, fetch: ((url: string, init?: RequestInit) => svc.fetch(url, init)) as typeof fetch }, w); // the first read sees the marker → ATTEMPT_UNCERTAIN before any claim
    expect(held).toMatchObject({ outcome: "not-prompted", check: { code: "ATTEMPT_UNCERTAIN" } });
    const svc2 = service(attempt(), { "prompted-refused": 1 }, { holder: "tab-b" }); // the marker is written by the other tab between this call's read and its claim
    const original = svc2.fetch; let reads = 0;
    const raced = (async (url: string, init?: RequestInit) => { const r = await original(url, init); if ((init?.method ?? "GET") === "GET" && ++reads === 1) { svc2.s.a = { ...svc2.s.a, prompt: { state: "PROMPTED" } }; } return r; }) as typeof fetch;
    expect(await executeValidatedAttempt({ api: "https://api.test", token: "tok", attemptId: "att-1", provider: w, fetch: raced, now, claimId: "claim-123" })).toMatchObject({ outcome: "claimed-elsewhere", attempt: { prompt: { state: "PROMPTED" } } });
    expect(svc2.since(0)).toEqual([`GET ${BASE}`, `POST ${BASE}/prompt prompted`, `POST ${BASE}/prompt prompted`]); expect(w.calls).not.toContain("eth_sendTransaction");
  });
  it("settledPendingRecovery reads every stage from the attempt alone", () => {
    const base = { outcome: "pending-recovery" as const, claimId: "c", attempt: attempt(), error: "e", next: "n" };
    expect(settledPendingRecovery({ ...base, stage: "report-sent", txHash: HASH }, attempt())).toBeNull();
    expect(settledPendingRecovery({ ...base, stage: "report-sent", txHash: HASH }, attempt({ state: "BROADCAST_ATTEMPTED", txHash: HASH.toUpperCase().replace("0X", "0x") }))).toMatchObject({ outcome: "sent" });
    expect(settledPendingRecovery({ ...base, stage: "release-claim", txHash: null, check: { ok: false, code: "CHAIN_CHANGED", reason: "" } }, attempt({ prompt: { state: "PROMPTED" } }))).toBeNull();
    expect(settledPendingRecovery({ ...base, stage: "release-claim", txHash: null, check: { ok: false, code: "CHAIN_CHANGED", reason: "" } }, attempt())).toMatchObject({ outcome: "not-prompted", check: { code: "CHAIN_CHANGED" } });
    expect(settledPendingRecovery({ ...base, stage: "claim", txHash: null }, attempt({ prompt: { state: "PROMPTED" } }))).toBeNull();
    expect(settledPendingRecovery({ ...base, stage: "claim", txHash: null }, attempt({ state: "NOT_EXECUTED", prompt: { state: "PROMPTED" } }))).toMatchObject({ outcome: "not-prompted", check: { code: "ATTEMPT_NOT_OPEN" } });
    expect(settledPendingRecovery({ ...base, stage: "abandon", txHash: null }, attempt({ state: "CONFIRMED", txHash: HASH }))).toMatchObject({ outcome: "unknown-submission", error: expect.stringContaining("closed as CONFIRMED") });
    expect(settledPendingRecovery({ ...base, stage: "mark-unknown-submission", txHash: null, walletError: "x" }, attempt({ prompt: { state: "UNKNOWN_SUBMISSION" } }))).toBeNull();
    expect(settledPendingRecovery({ ...base, stage: "mark-unknown-submission", txHash: null, walletError: "x" }, attempt({ state: "MISMATCH", txHash: HASH }))).toMatchObject({ outcome: "unknown-submission", error: "x" });
  });
});
