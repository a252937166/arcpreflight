// Execute a VALIDATED wallet attempt the way the site does it (docs/LIFECYCLE.md §9–§10), from your own code: read the attempt, turn its
// plan into the wallet's transaction fields, check the account, the chain and the validation window, claim the prompt exclusively, check
// again, ask the wallet to sign exactly the plan, report the hash the moment it returns, and never prompt twice — a rejected prompt is
// abandoned, any other wallet error is marked and reconciled. No key leaves your wallet; the service never sees the signed bytes before they
// leave. Runs anywhere `fetch` and an EIP-1193 provider exist (a browser extension, a wallet SDK, a node script with a local signer).
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

export type ExecuteInput = { api: string; token: string; attemptId: string; provider: Eip1193; fetch?: typeof fetch; now?: () => number; claimId?: string };
export type ExecuteOutcome =
  | { outcome: "sent"; txHash: string; attempt: AttemptLike }
  | { outcome: "not-prompted"; check: Exclude<PreSendCheck, { ok: true }>; attempt: AttemptLike }
  | { outcome: "claimed-elsewhere"; attempt: AttemptLike }
  | { outcome: "abandoned"; attempt: AttemptLike }
  | { outcome: "unknown-submission"; attempt: AttemptLike; error: string };
class ApiFailure extends Error { constructor(public status: number, public body: any) { super(`HTTP ${status}${body?.error ? ` ${body.error}` : ""}${body?.reason ? `: ${body.reason}` : ""}`); } }
async function call<T>(f: typeof fetch, api: string, token: string, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const r = await f(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: "NON_JSON", text: text.slice(0, 200) }; }
  if (!r.ok) throw new ApiFailure(r.status, parsed);
  return parsed as T;
}
/** The whole hand-over for one VALIDATED attempt. Every step talks to ONE instance (`api`) with ONE session (`token`). */
export async function executeValidatedAttempt(i: ExecuteInput): Promise<ExecuteOutcome> {
  const f = i.fetch ?? fetch; const now = i.now ?? Date.now; const base = `/v1/wallet/attempts/${i.attemptId}`;
  const attempt = await call<AttemptLike>(f, i.api, i.token, base, "GET");
  const before = await preSendChecks(i.provider, attempt, now); // nothing is claimed for an attempt the wallet could not sign anyway
  if (!before.ok) return { outcome: "not-prompted", check: before, attempt };
  const claimId = i.claimId ?? newClaimId();
  let claimed: AttemptLike;
  try { claimed = await call<AttemptLike>(f, i.api, i.token, `${base}/prompt`, "POST", { event: "prompted", claimId }); } // the exclusive claim: durable before the wallet is asked
  catch (e) { if (e instanceof ApiFailure && e.status === 409 && e.body?.error === "PROMPT_CLAIMED") return { outcome: "claimed-elsewhere", attempt: (e.body.attempt as AttemptLike) ?? attempt }; throw e; }
  const again = await preSendChecks(i.provider, { ...claimed, prompt: null }, now); // the claim was another await: read the wallet and the clock again
  if (!again.ok) { const released = await call<AttemptLike>(f, i.api, i.token, `${base}/prompt`, "POST", { event: "not-prompted", claimId, detail: again.code }).catch(() => claimed); return { outcome: "not-prompted", check: again, attempt: released }; }
  let txHash: string;
  try {
    const hash = await i.provider.request({ method: "eth_sendTransaction", params: [walletRequestFromPlan(attempt.plan!, attempt.payer)] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`the wallet returned ${JSON.stringify(hash)} instead of a transaction hash`);
    txHash = hash;
  } catch (e) {
    if (isUserRejection(e)) return { outcome: "abandoned", attempt: await call<AttemptLike>(f, i.api, i.token, `${base}/abandon`, "POST") };
    const error = String((e as { message?: string })?.message ?? e); // the transaction MAY have left: mark it, then reconcile — never a second prompt
    await call(f, i.api, i.token, `${base}/prompt`, "POST", { event: "unknown-submission", claimId, detail: error.slice(0, 200) }).catch(() => null);
    const reconciled = await call<AttemptLike>(f, i.api, i.token, `${base}/recover`, "POST").catch(() => claimed);
    return { outcome: "unknown-submission", attempt: reconciled, error };
  }
  const sent = await call<AttemptLike>(f, i.api, i.token, `${base}/sent`, "POST", { txHash }); // the hash is reported the moment the wallet returns it
  return { outcome: "sent", txHash, attempt: sent };
}
