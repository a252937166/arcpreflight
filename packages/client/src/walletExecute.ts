// Execute a VALIDATED wallet attempt the way the site does it (docs/LIFECYCLE.md §9–§10), from your own code: read the attempt, turn its
// plan into the wallet's transaction fields, check the account, the chain and the validation window, claim the prompt exclusively, check
// again, ask the wallet to sign exactly the plan, report the hash the moment it returns, and never prompt twice — a rejected prompt is
// abandoned, any other wallet error is marked and reconciled. No key leaves your wallet; the service never sees the signed bytes before they
// leave. Runs anywhere `fetch` and an EIP-1193 provider exist (a browser extension, a wallet SDK, a node script with a local signer).
// Review of 199dd55 (2026-10-10): a fact the wallet established is never lost to a failed API call — a hash whose report failed, a claim
// whose release failed, a rejection whose abandon failed, a wallet error whose mark failed all come back as `pending-recovery` with the
// fact kept (the hash, the claim id, the wallet's answer); `completePendingRecovery` finishes the step later without any wallet prompt.
// Review of 0d14ad9 (2026-10-10): an answer that was LOST after the service applied the call never leaves recovery stuck — every completion
// reads the attempt first and recognises a step that already took effect (the hash on record, the claim gone, NOT_SENT, the marker), and the
// service answers a repeat of the holder's own call with 200 (idempotent), so the retry of a lost answer is the same call, not a conflict.
// The claim itself is retried once under the same id when its answer is lost (the grant is idempotent for its holder); if that fails too,
// the claim stage is handed to recovery, which releases a claim that turned out to be this call's.
export type ValidatedPlan = { chainId: number; from: string; to: string; data: string; valueNativeAtomic: string; gasLimit: string; maxFeePerGasNativeAtomic: string; maxPriorityFeePerGasNativeAtomic: string; type?: number };
export type AttemptLike = { attemptId: string; state: string; payer: string; validUntil: string | null; plan: ValidatedPlan | null; prompt?: { state: string } | null; txHash?: string | null; [k: string]: unknown };
export type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export type WalletTransaction = { from: string; to: string; data: string; value: `0x${string}`; gas: `0x${string}`; maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}`; type: "0x2"; chainId: `0x${string}` };
const hex = (v: string | number | bigint): `0x${string}` => `0x${BigInt(v).toString(16)}`;

/** The transaction request handed to the wallet: exactly the validated plan as hex quantities, EIP-1559 (type 2), bound to the plan's chain;
 *  no nonce — the wallet owns it. */
export function walletRequestFromPlan(plan: ValidatedPlan, from: string = plan.from): WalletTransaction {
  return { from, to: plan.to, data: plan.data, value: hex(plan.valueNativeAtomic), gas: hex(plan.gasLimit), maxFeePerGas: hex(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: hex(plan.maxPriorityFeePerGasNativeAtomic), type: "0x2", chainId: hex(plan.chainId) };
}
/** more than this much of the validation window must be left at the moment the wallet is asked */
export const MIN_WINDOW_LEFT_MS = 5_000;
export type PreSendCheck = { ok: true } | { ok: false; code: "ATTEMPT_NOT_OPEN" | "ATTEMPT_UNCERTAIN" | "ACCOUNT_CHANGED" | "CHAIN_CHANGED" | "WINDOW_CLOSED" | "WALLET_UNAVAILABLE" | "CLAIM_UNCONFIRMED"; reason: string };
export type FailedCheck = Exclude<PreSendCheck, { ok: true }>;
/** Immediately before the wallet is asked: VALIDATED with a plan and no prompt marker; the wallet's first account is the plan's `from` and
 *  the attempt's payer; its chain is the plan's; more than 5 s of the window are left. The clock is read AFTER the wallet answered. */
export async function preSendChecks(provider: Eip1193, attempt: AttemptLike, now: () => number = Date.now): Promise<PreSendCheck> {
  if (attempt.state !== "VALIDATED" || !attempt.plan) return { ok: false, code: "ATTEMPT_NOT_OPEN", reason: `the attempt is ${attempt.state}; only a VALIDATED attempt with its plan can be handed to a wallet` };
  if (attempt.prompt) return { ok: false, code: "ATTEMPT_UNCERTAIN", reason: "this plan was already handed to a wallet: reconcile it (POST …/recover), never prompt again" };
  let accounts: unknown, chainHex: unknown;
  try { [accounts, chainHex] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]); }
  catch (e) { return { ok: false, code: "WALLET_UNAVAILABLE", reason: `the wallet did not answer: ${String((e as { message?: string })?.message ?? e)}` }; }
  const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
  if (!first || first !== attempt.plan.from.toLowerCase() || first !== attempt.payer.toLowerCase()) return { ok: false, code: "ACCOUNT_CHANGED", reason: `the wallet's account ${first ?? "(none)"} is not the plan's payer ${attempt.plan.from}` };
  const chainId = Number(chainHex);
  if (!Number.isFinite(chainId) || chainId !== attempt.plan.chainId) return { ok: false, code: "CHAIN_CHANGED", reason: `the wallet is on chain ${String(chainHex)}; the plan was validated for chain ${attempt.plan.chainId}` };
  const left = attempt.validUntil ? new Date(attempt.validUntil).getTime() - now() : 0;
  if (left <= MIN_WINDOW_LEFT_MS) return { ok: false, code: "WINDOW_CLOSED", reason: left > 0 ? `only ${Math.ceil(left / 1000)} s of the validation window are left` : "the validation window closed; recover or abandon, then validate a fresh plan" };
  return { ok: true };
}
/** EIP-1193 4001 and the message shapes wallets use for a rejected prompt */
export const isUserRejection = (e: unknown): boolean => { const x = e as { code?: unknown; message?: string; shortMessage?: string; cause?: { code?: unknown } }; const code = x?.code ?? x?.cause?.code; return code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request|user cancel/i.test(String(x?.shortMessage ?? x?.message ?? "")); };
export const newClaimId = (): string => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(""));

/** one instance, one session, one attempt: what every call to the API needs */
export type AttemptTarget = { api: string; token: string; attemptId: string; fetch?: typeof fetch };
export type ExecuteInput = AttemptTarget & { provider: Eip1193; now?: () => number; claimId?: string };
/** A step whose answer the service did not give (the call failed, or its answer was lost after the service applied it). Nothing here asks the
 *  wallet for anything; `completePendingRecovery` reads the attempt, recognises a step that already took effect, and otherwise repeats exactly
 *  the missing call — which the service answers idempotently for its holder. `next` says what that call is, for a reader. */
export type PendingRecovery = { outcome: "pending-recovery"; claimId: string; attempt: AttemptLike; error: string; next: string } & (
  | { stage: "claim"; txHash: null } // the claim's answer was lost twice; the claim MAY be this call's — nothing was prompted
  | { stage: "report-sent"; txHash: string } // the wallet returned this hash; POST …/sent gave no answer — the transaction is on the network
  | { stage: "release-claim"; txHash: null; check: FailedCheck } // the re-check failed after the claim; POST …/prompt not-prompted gave no answer
  | { stage: "abandon"; txHash: null } // the wallet rejected the prompt; POST …/abandon gave no answer
  | { stage: "mark-unknown-submission"; txHash: null; walletError: string }); // the wallet answered an error; POST …/prompt unknown-submission gave no answer
export type ExecuteOutcome =
  | { outcome: "sent"; txHash: string; attempt: AttemptLike }
  | { outcome: "not-prompted"; check: FailedCheck; attempt: AttemptLike }
  | { outcome: "claimed-elsewhere"; attempt: AttemptLike }
  | { outcome: "abandoned"; attempt: AttemptLike }
  | { outcome: "unknown-submission"; attempt: AttemptLike; error: string }
  | PendingRecovery;
class ApiFailure extends Error { constructor(public status: number, public body: any) { super(`HTTP ${status}${body?.error ? ` ${body.error}` : ""}${body?.reason ? `: ${body.reason}` : ""}`); } }
const describe = (e: unknown): string => String((e as { message?: string })?.message ?? e);
const refused = (e: unknown, ...codes: string[]): e is ApiFailure => e instanceof ApiFailure && e.status === 409 && codes.includes(String(e.body?.error));
/** a definite refusal: the service answered and applied nothing (4xx other than 409 and 429); anything else may have been applied */
const definite = (e: unknown): boolean => e instanceof ApiFailure && e.status < 500 && e.status !== 409 && e.status !== 429;
async function call<T>(f: typeof fetch, api: string, token: string, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const r = await f(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: "NON_JSON", text: text.slice(0, 200) }; }
  if (!r.ok) throw new ApiFailure(r.status, parsed);
  return parsed as T;
}
const routes = (t: AttemptTarget) => {
  const f = t.fetch ?? fetch; const base = `/v1/wallet/attempts/${t.attemptId}`;
  return { base, get: () => call<AttemptLike>(f, t.api, t.token, base, "GET"), post: (action: string, body?: unknown) => call<AttemptLike>(f, t.api, t.token, `${base}${action}`, "POST", body) };
};
const CLAIM_UNCONFIRMED: FailedCheck = { ok: false, code: "CLAIM_UNCONFIRMED", reason: "the claim's answer was lost; the claim was handed back (or was never granted) and nothing was prompted — run the execution again" };
/** The whole hand-over for one VALIDATED attempt. Every step talks to ONE instance (`api`) with ONE session (`token`). The wallet is asked at most
 *  once, and only between a granted claim and the report of its answer; every other failure returns without a prompt. */
export async function executeValidatedAttempt(i: ExecuteInput): Promise<ExecuteOutcome> {
  const now = i.now ?? Date.now; const { base, get, post } = routes(i);
  const attempt = await get();
  const before = await preSendChecks(i.provider, attempt, now); // nothing is claimed for an attempt the wallet could not sign anyway
  if (!before.ok) return { outcome: "not-prompted", check: before, attempt };
  const claimId = i.claimId ?? newClaimId();
  let claimed: AttemptLike;
  try { claimed = await post("/prompt", { event: "prompted", claimId }); } // the exclusive claim: durable before the wallet is asked
  catch (e) {
    if (refused(e, "PROMPT_CLAIMED")) return { outcome: "claimed-elsewhere", attempt: (e.body.attempt as AttemptLike) ?? attempt };
    if (definite(e)) throw e;
    // the answer was lost: the claim MAY already be this call's — the grant is idempotent under its claim id, so ask once more under the same id
    try { claimed = await post("/prompt", { event: "prompted", claimId }); }
    catch (e2) {
      if (refused(e2, "PROMPT_CLAIMED")) return { outcome: "claimed-elsewhere", attempt: (e2.body.attempt as AttemptLike) ?? attempt };
      if (definite(e2)) throw e2;
      return { outcome: "pending-recovery", stage: "claim", txHash: null, claimId, attempt, error: describe(e2), next: `the claim under this id may be held and nothing was prompted: completePendingRecovery reads the attempt and hands the claim back (POST ${base}/prompt { event: "not-prompted", claimId }); then run the execution again` };
    }
  }
  const again = await preSendChecks(i.provider, { ...claimed, prompt: null }, now); // the claim was another await: read the wallet and the clock again
  if (!again.ok) {
    try { return { outcome: "not-prompted", check: again, attempt: await post("/prompt", { event: "not-prompted", claimId, detail: again.code }) }; }
    catch (e) { return { outcome: "pending-recovery", stage: "release-claim", txHash: null, check: again, claimId, attempt: claimed, error: describe(e), next: `the wallet was not asked (${again.code}) but the claim may still be held: POST ${base}/prompt { event: "not-prompted", claimId } hands it back` }; }
  }
  let txHash: string;
  try {
    const hash = await i.provider.request({ method: "eth_sendTransaction", params: [walletRequestFromPlan(attempt.plan!, attempt.payer)] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`the wallet returned ${JSON.stringify(hash)} instead of a transaction hash`);
    txHash = hash;
  } catch (e) {
    if (isUserRejection(e)) {
      try { return { outcome: "abandoned", attempt: await post("/abandon") }; }
      catch (e2) { return { outcome: "pending-recovery", stage: "abandon", txHash: null, claimId, attempt: claimed, error: describe(e2), next: `the wallet rejected the prompt and nothing was sent, but the service gave no answer: POST ${base}/abandon` }; }
    }
    const walletError = describe(e); // the transaction MAY have left: mark it, then reconcile — never a second prompt
    let marked: AttemptLike;
    try { marked = await post("/prompt", { event: "unknown-submission", claimId, detail: walletError.slice(0, 200) }); }
    catch (e2) { return { outcome: "pending-recovery", stage: "mark-unknown-submission", txHash: null, walletError, claimId, attempt: claimed, error: describe(e2), next: `the wallet answered "${walletError.slice(0, 80)}" instead of a hash and the mark gave no answer: POST ${base}/prompt { event: "unknown-submission", claimId }, then POST ${base}/recover` }; }
    return { outcome: "unknown-submission", attempt: await post("/recover").catch(() => marked), error: walletError };
  }
  try { return { outcome: "sent", txHash, attempt: await post("/sent", { txHash }) }; } // the hash is reported the moment the wallet returns it
  catch (e) {
    // the transaction is on the network under this hash and the service may not know it yet: keep the hash, reconcile the attempt from the
    // order (OrderPaid closes it even without the hash), and hand the report back to the caller — the wallet is never asked again
    const reconciled = await post("/recover").catch(() => null);
    return { outcome: "pending-recovery", stage: "report-sent", txHash, claimId, attempt: reconciled ?? claimed, error: describe(e), next: `POST ${base}/sent { txHash: "${txHash}" } reports the hash (idempotent); then observe GET ${base} until the attempt closes` };
  }
}
/** report a hash the wallet returned (idempotent: the same hash reported again answers 200 unchanged) */
export const reportSent = (t: AttemptTarget, txHash: string): Promise<AttemptLike> => routes(t).post("/sent", { txHash });
/** hand an untouched claim back under the claim id it was granted to (idempotent: nothing held answers 200 unchanged) */
export const releaseClaim = (t: AttemptTarget, claimId: string, detail?: string): Promise<AttemptLike> => routes(t).post("/prompt", { event: "not-prompted", claimId, ...(detail ? { detail } : {}) });
const sameHash = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** What a pending step reads as from the attempt alone, when it already took effect (the lost answer was the service's "done"): the outcome the
 *  step would have had, without another call; null while the step is still to be made. */
export function settledPendingRecovery(p: PendingRecovery, a: AttemptLike): ExecuteOutcome | null {
  const open = a.state === "VALIDATED";
  switch (p.stage) {
    case "report-sent": return sameHash(a.txHash, p.txHash) || !open ? { outcome: "sent", txHash: p.txHash, attempt: a } : null; // the hash is on record, or the attempt closed (reconciled from the order); the caller keeps the hash either way
    case "release-claim": return !a.prompt || !open ? { outcome: "not-prompted", check: p.check, attempt: a } : null;
    case "claim": return !a.prompt ? { outcome: "not-prompted", check: CLAIM_UNCONFIRMED, attempt: a } : !open ? { outcome: "not-prompted", check: { ok: false, code: "ATTEMPT_NOT_OPEN", reason: `the attempt is ${a.state}; nothing was prompted by this call` }, attempt: a } : null;
    case "abandon": return a.state === "NOT_SENT" ? { outcome: "abandoned", attempt: a } : !open ? { outcome: "unknown-submission", attempt: a, error: `the attempt closed as ${a.state} although the wallet reported a rejection; the chain decides` } : null;
    case "mark-unknown-submission": return !open ? { outcome: "unknown-submission", attempt: a, error: p.walletError } : null;
  }
}
/** Finish what `executeValidatedAttempt` left `pending-recovery`: read the attempt and recognise a step that already took effect; otherwise
 *  exactly the missing API call for the stage, which the service answers idempotently for its holder — no wallet is involved. A 409 means the
 *  attempt moved meanwhile: it is read again and decided from. Returns the outcome the step would have had, or `pending-recovery` again with
 *  the new error, so it can be called until it settles. */
export async function completePendingRecovery(t: AttemptTarget, p: PendingRecovery): Promise<ExecuteOutcome> {
  const { get, post } = routes(t);
  let a: AttemptLike;
  try { a = await get(); } catch (e) { return { ...p, error: describe(e) }; }
  const settled = settledPendingRecovery(p, a); if (settled) return settled;
  try {
    switch (p.stage) {
      case "report-sent": return { outcome: "sent", txHash: p.txHash, attempt: await post("/sent", { txHash: p.txHash }) };
      case "release-claim": return { outcome: "not-prompted", check: p.check, attempt: await post("/prompt", { event: "not-prompted", claimId: p.claimId, detail: p.check.code }) };
      case "claim": return { outcome: "not-prompted", check: CLAIM_UNCONFIRMED, attempt: await post("/prompt", { event: "not-prompted", claimId: p.claimId, detail: "CLAIM_UNCONFIRMED" }) };
      case "abandon": return { outcome: "abandoned", attempt: await post("/abandon") };
      case "mark-unknown-submission": {
        const marked = a.prompt?.state === "UNKNOWN_SUBMISSION" ? a : await post("/prompt", { event: "unknown-submission", claimId: p.claimId, detail: p.walletError.slice(0, 200) });
        return { outcome: "unknown-submission", attempt: await post("/recover").catch(() => marked), error: p.walletError };
      }
    }
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 409) { // the attempt moved between the read and the call: read once more and decide from it
      const again = await get().catch(() => null);
      const s = again && settledPendingRecovery(p, again); if (s) return s;
      if (refused(e, "PROMPT_CLAIMED", "PROMPT_NOT_RELEASABLE")) return { outcome: "claimed-elsewhere", attempt: (e.body.attempt as AttemptLike) ?? again ?? a };
      if (refused(e, "PROMPT_NOT_CLAIMED")) return { outcome: "not-prompted", check: p.stage === "release-claim" ? p.check : CLAIM_UNCONFIRMED, attempt: again ?? a }; // an older service: nothing is held
    }
    return { ...p, attempt: a, error: describe(e) };
  }
}
