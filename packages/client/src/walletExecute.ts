// Execute a VALIDATED wallet attempt the way the site does it (docs/LIFECYCLE.md §9–§10), from your own code: read the attempt, turn its
// plan into the wallet's transaction fields, check the account, the chain and the validation window, claim the prompt exclusively, check
// again, ask the wallet to sign exactly the plan, report the hash the moment it returns, and never prompt twice — a rejected prompt is
// abandoned, any other wallet error is marked and reconciled. No key leaves your wallet; the service never sees the signed bytes before they
// leave. Runs anywhere `fetch` and an EIP-1193 provider exist (a browser extension, a wallet SDK, a node script with a local signer).
// Review of 199dd55 (2026-10-10): a fact the wallet established is never lost to a failed API call — a hash whose report failed, a claim
// whose release failed, a rejection whose abandon failed, a wallet error whose mark failed all come back as `pending-recovery` with the
// fact kept (the hash, the claim id, the wallet's answer); `completePendingRecovery` finishes the step later without any wallet prompt.
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
export type PreSendCheck = { ok: true } | { ok: false; code: "ATTEMPT_NOT_OPEN" | "ATTEMPT_UNCERTAIN" | "ACCOUNT_CHANGED" | "CHAIN_CHANGED" | "WINDOW_CLOSED" | "WALLET_UNAVAILABLE"; reason: string };
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
/** A step the wallet already settled that the service has not recorded yet. Nothing here asks the wallet for anything; `completePendingRecovery`
 *  retries exactly the missing API call. `next` says what that call is, for a reader. */
export type PendingRecovery = { outcome: "pending-recovery"; claimId: string; attempt: AttemptLike; error: string; next: string } & (
  | { stage: "report-sent"; txHash: string } // the wallet returned this hash; POST …/sent failed — the transaction is on the network
  | { stage: "release-claim"; txHash: null; check: FailedCheck } // the re-check failed after the claim; POST …/prompt not-prompted failed — the claim is still held
  | { stage: "abandon"; txHash: null } // the wallet rejected the prompt; POST …/abandon failed
  | { stage: "mark-unknown-submission"; txHash: null; walletError: string }); // the wallet answered an error; POST …/prompt unknown-submission failed
export type ExecuteOutcome =
  | { outcome: "sent"; txHash: string; attempt: AttemptLike }
  | { outcome: "not-prompted"; check: FailedCheck; attempt: AttemptLike }
  | { outcome: "claimed-elsewhere"; attempt: AttemptLike }
  | { outcome: "abandoned"; attempt: AttemptLike }
  | { outcome: "unknown-submission"; attempt: AttemptLike; error: string }
  | PendingRecovery;
class ApiFailure extends Error { constructor(public status: number, public body: any) { super(`HTTP ${status}${body?.error ? ` ${body.error}` : ""}${body?.reason ? `: ${body.reason}` : ""}`); } }
const describe = (e: unknown): string => String((e as { message?: string })?.message ?? e);
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
  catch (e) { if (e instanceof ApiFailure && e.status === 409 && e.body?.error === "PROMPT_CLAIMED") return { outcome: "claimed-elsewhere", attempt: (e.body.attempt as AttemptLike) ?? attempt }; throw e; }
  const again = await preSendChecks(i.provider, { ...claimed, prompt: null }, now); // the claim was another await: read the wallet and the clock again
  if (!again.ok) {
    try { return { outcome: "not-prompted", check: again, attempt: await post("/prompt", { event: "not-prompted", claimId, detail: again.code }) }; }
    catch (e) { return { outcome: "pending-recovery", stage: "release-claim", txHash: null, check: again, claimId, attempt: claimed, error: describe(e), next: `the wallet was not asked (${again.code}) but the claim is still held: POST ${base}/prompt { event: "not-prompted", claimId } hands it back` }; }
  }
  let txHash: string;
  try {
    const hash = await i.provider.request({ method: "eth_sendTransaction", params: [walletRequestFromPlan(attempt.plan!, attempt.payer)] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`the wallet returned ${JSON.stringify(hash)} instead of a transaction hash`);
    txHash = hash;
  } catch (e) {
    if (isUserRejection(e)) {
      try { return { outcome: "abandoned", attempt: await post("/abandon") }; }
      catch (e2) { return { outcome: "pending-recovery", stage: "abandon", txHash: null, claimId, attempt: claimed, error: describe(e2), next: `the wallet rejected the prompt and nothing was sent, but the service has not recorded it: POST ${base}/abandon` }; }
    }
    const walletError = describe(e); // the transaction MAY have left: mark it, then reconcile — never a second prompt
    let marked: AttemptLike;
    try { marked = await post("/prompt", { event: "unknown-submission", claimId, detail: walletError.slice(0, 200) }); }
    catch (e2) { return { outcome: "pending-recovery", stage: "mark-unknown-submission", txHash: null, walletError, claimId, attempt: claimed, error: describe(e2), next: `the wallet answered "${walletError.slice(0, 80)}" instead of a hash and the mark was not recorded: POST ${base}/prompt { event: "unknown-submission", claimId }, then POST ${base}/recover` }; }
    return { outcome: "unknown-submission", attempt: await post("/recover").catch(() => marked), error: walletError };
  }
  try { return { outcome: "sent", txHash, attempt: await post("/sent", { txHash }) }; } // the hash is reported the moment the wallet returns it
  catch (e) {
    // the transaction is on the network under this hash and the service does not know it yet: keep the hash, reconcile the attempt from the
    // order (OrderPaid closes it even without the hash), and hand the report back to the caller — the wallet is never asked again
    const reconciled = await post("/recover").catch(() => null);
    return { outcome: "pending-recovery", stage: "report-sent", txHash, claimId, attempt: reconciled ?? claimed, error: describe(e), next: `POST ${base}/sent { txHash: "${txHash}" } reports the hash; then observe GET ${base} until the attempt closes` };
  }
}
/** report a hash the wallet returned (idempotent: the same hash can be reported again) */
export const reportSent = (t: AttemptTarget, txHash: string): Promise<AttemptLike> => routes(t).post("/sent", { txHash });
/** hand an untouched claim back under the claim id it was granted to */
export const releaseClaim = (t: AttemptTarget, claimId: string, detail?: string): Promise<AttemptLike> => routes(t).post("/prompt", { event: "not-prompted", claimId, ...(detail ? { detail } : {}) });
/** Finish what `executeValidatedAttempt` left `pending-recovery`: exactly the missing API call for its stage, nothing else — no wallet is involved.
 *  Returns the outcome the step would have had, or `pending-recovery` again with the new error, so it can be called until it settles. */
export async function completePendingRecovery(t: AttemptTarget, p: PendingRecovery): Promise<ExecuteOutcome> {
  const { post } = routes(t);
  try {
    switch (p.stage) {
      case "report-sent": return { outcome: "sent", txHash: p.txHash, attempt: await post("/sent", { txHash: p.txHash }) };
      case "release-claim": return { outcome: "not-prompted", check: p.check, attempt: await post("/prompt", { event: "not-prompted", claimId: p.claimId, detail: p.check.code }) };
      case "abandon": return { outcome: "abandoned", attempt: await post("/abandon") };
      case "mark-unknown-submission": { const marked = await post("/prompt", { event: "unknown-submission", claimId: p.claimId, detail: p.walletError.slice(0, 200) }); return { outcome: "unknown-submission", attempt: await post("/recover").catch(() => marked), error: p.walletError }; }
    }
  } catch (e) { return { ...p, error: describe(e) }; }
}
