// Wallet execution from the browser (docs/LIFECYCLE.md §3, §9, AP33-07): the service validates the exact plan and persists the attempt
// VALIDATED before the wallet is prompted; this module remembers the attempt id per instance BEFORE eth_sendTransaction, re-checks the
// wallet right before the prompt (same account as the plan's payer, same chain, more than 5 s of window left — a mismatch aborts without
// prompting and says why), asks the wallet to sign exactly the plan (no nonce — wallets own it), reports the hash right after the wallet
// returns it, polls the observe route until the state leaves BROADCAST_ATTEMPTED, abandons on a rejected prompt, and treats any OTHER
// wallet error as a possible submission: reconcile first (POST …/recover), then poll — never a second prompt, never "nothing was sent"
// until the attempt is closed or the visitor explicitly abandons it. One execution at a time: a second call joins the one in flight.
import { toHex } from "viem";
import { api, ApiError, type AttemptState, type AttemptView, type Deviations } from "./api";
import type { Eip1193 } from "./wallet";
import { scopedKey } from "./storage";
import { describeError, type Described } from "./errors";
import { short, utc, type Tone } from "./format";

export type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;
export const OPEN_STATES: readonly AttemptState[] = ["VALIDATED", "BROADCAST_ATTEMPTED"];
export const isOpen = (s: AttemptState | string | null | undefined) => s === "VALIDATED" || s === "BROADCAST_ATTEMPTED";
export const isTerminal = (s: AttemptState | string | null | undefined) => !!s && !isOpen(s);
/** the window inside which the wallet prompt may still be answered (server: validUntil = validatedAt + policy.maxFinalValidationAgeSeconds) */
export const insideWindow = (a: Pick<AttemptView, "state" | "validUntil"> | null | undefined, now = Date.now()) => !!a && a.state === "VALIDATED" && !!a.validUntil && new Date(a.validUntil).getTime() > now;
/** a prompt needs more than this much of the window left, or it is not opened */
export const MIN_WINDOW_LEFT_MS = 5000;

/** The transaction request handed to the wallet: exactly the validated plan, as hex quantities. No nonce — the wallet owns it. */
export function txRequestFromPlan(plan: { from: string; to: string; data: string; valueNativeAtomic: string; gasLimit: string; maxFeePerGasNativeAtomic: string; maxPriorityFeePerGasNativeAtomic: string }) {
  return { from: plan.from, to: plan.to, data: plan.data, value: toHex(BigInt(plan.valueNativeAtomic)), gas: toHex(BigInt(plan.gasLimit)), maxFeePerGas: toHex(BigInt(plan.maxFeePerGasNativeAtomic)), maxPriorityFeePerGas: toHex(BigInt(plan.maxPriorityFeePerGasNativeAtomic)), type: "0x2" as const };
}
/** EIP-1193 4001 (user rejected), plus the message shapes MetaMask, OKX and viem use for it */
export function isUserRejection(e: unknown): boolean {
  const x = e as any;
  const code = x?.code ?? x?.cause?.code ?? x?.data?.originalError?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  return /user rejected|user denied|rejected the request|user cancel/i.test(String(x?.shortMessage ?? x?.message ?? ""));
}

// ---- remembered attempts (per API instance): found again after a refresh, before the server list has answered
export type RememberedAttempt = { attemptId: string; orderId: string; requestId: string; createdAt: string; state?: AttemptState | string };
const STORE = () => scopedKey("arcpreflight.attempts");
function read(): Record<string, RememberedAttempt> {
  try { const raw = localStorage.getItem(STORE()); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
export function rememberAttempt(a: RememberedAttempt) {
  const all = read(); all[a.attemptId] = { ...all[a.attemptId], ...a };
  const ids = Object.keys(all); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete all[id];
  try { localStorage.setItem(STORE(), JSON.stringify(all)); } catch { /* storage unavailable: the server list (GET /v1/wallet/attempts) still has it */ }
}
export const rememberedAttempts = (): RememberedAttempt[] => Object.values(read()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
export const rememberedAttempt = (id: string): RememberedAttempt | null => read()[id] ?? null;
const rememberView = (a: AttemptView) => rememberAttempt({ attemptId: a.attemptId, orderId: a.orderId, requestId: a.requestId, createdAt: a.createdAt, state: a.state });

// ---- the state machine
/** `unknown-submission`: the wallet threw something that is not a rejection — the transaction may have left; reconciling. `open-attempt`: the
 *  server answered ATTEMPT_OPEN and the open attempt was loaded instead (continue, abandon or recover it). */
export type ExecutePhase = "idle" | "validating" | "prompting" | "reporting" | "polling" | "done" | "unresolved" | "refused" | "abandoned" | "error" | "unknown-submission" | "open-attempt";
export type Refusal = { stage: "decision" | "finalValidation" | "server"; reasons: string[]; attemptId: string | null; text: string };
export type ExecuteEvent = { phase: ExecutePhase; attempt: AttemptView | null; txHash?: string | null; refusal?: Refusal | null; error?: Described | null };
export type Poller = { intervalMs?: number; maxMs?: number; /** how long an ambiguous submission is reconciled before the visitor is asked (default 60 s) */ ambiguousMaxMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number };
const sleep = (ms: number) => new Promise<void>((s) => setTimeout(s, ms));
export const AMBIGUOUS_TEXT = "The wallet did not return a hash; the transaction may have been submitted. Reconciling from the order state…";
export const AMBIGUOUS_OPEN_TEXT = "The wallet returned an error instead of a hash and reconciliation found no payment for this order yet. The attempt stays VALIDATED: if you know you rejected the prompt, abandon it; otherwise recover again in a moment — nothing is prompted again by itself.";

/** GET …/{id} every ~2 s (the server throttles chain reads to one per 1.5 s per attempt) until the state leaves the open set or `maxMs` passes. */
export async function pollAttempt(attemptId: string, withToken: WithToken, opts: Poller = {}, onTick?: (a: AttemptView) => void): Promise<{ attempt: AttemptView | null; settled: boolean }> {
  const intervalMs = opts.intervalMs ?? 2000, maxMs = opts.maxMs ?? 120_000, wait = opts.wait ?? sleep, now = opts.now ?? Date.now;
  const t0 = now(); let last: AttemptView | null = null;
  for (;;) {
    try { last = await withToken((t) => api.attempt(attemptId, t)); onTick?.(last); if (!isOpen(last.state)) return { attempt: last, settled: true }; }
    catch (e) { if (e instanceof ApiError && e.status !== 429 && e.status < 500) throw e; /* transport or 5xx: keep polling */ }
    if (now() - t0 >= maxMs) return { attempt: last, settled: false };
    await wait(intervalMs);
  }
}

/** The open attempt of an order (the server allows one): the brief list row, then the full view with its plan. */
export async function findOpenAttempt(orderId: string, withToken: WithToken): Promise<AttemptView | null> {
  const list = await withToken((t) => api.attempts(t));
  const brief = (list.attempts ?? []).find((a) => a.orderId.toLowerCase() === orderId.toLowerCase() && isOpen(a.state));
  return brief ? withToken((t) => api.attempt(brief.attemptId, t)) : null;
}

export type PreSendCheck = { ok: true } | { ok: false; code: "ACCOUNT_CHANGED" | "CHAIN_CHANGED" | "WINDOW_CLOSED" | "WALLET_UNAVAILABLE"; text: string };
/** Immediately before eth_sendTransaction: the wallet's first account must be the plan's `from` and the attempt's payer, its chain the
 *  plan's chainId, and more than 5 s of the validation window must be left. A mismatch aborts without a prompt and says why. */
export async function preSendCheck(provider: Eip1193, attempt: AttemptView, now = Date.now()): Promise<PreSendCheck> {
  const plan = attempt.plan as { from: string; chainId: number };
  let accounts: unknown, chainHex: unknown;
  try { [accounts, chainHex] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]); }
  catch (e: any) { return { ok: false, code: "WALLET_UNAVAILABLE", text: `Your wallet did not answer (${String(e?.message ?? e)}); nothing was prompted. The attempt stays validated — try again inside the window, or abandon it.` }; }
  const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  if (!first || first.toLowerCase() !== plan.from.toLowerCase() || first.toLowerCase() !== attempt.payer.toLowerCase())
    return { ok: false, code: "ACCOUNT_CHANGED", text: `Your wallet switched to ${first ? short(first, 4) : "no account"}; this attempt was validated for ${short(attempt.payer, 4)} (the order's payer). Nothing was prompted — switch back to that account to continue inside the window, or abandon the attempt.` };
  const chainId = Number(chainHex);
  if (!Number.isFinite(chainId) || chainId !== plan.chainId)
    return { ok: false, code: "CHAIN_CHANGED", text: `Your wallet is on chain ${Number.isFinite(chainId) ? chainId : String(chainHex)}; the plan was validated for chain ${plan.chainId}. Nothing was prompted — switch the wallet back to chain ${plan.chainId} to continue inside the window, or abandon the attempt.` };
  const left = attempt.validUntil ? new Date(attempt.validUntil).getTime() - now : 0;
  if (left <= MIN_WINDOW_LEFT_MS)
    return { ok: false, code: "WINDOW_CLOSED", text: left > 0 ? `The validation window closes in ${Math.ceil(left / 1000)} s — too little for a wallet prompt; nothing was prompted. Recover reads the order state; abandon records that nothing was sent; a new execution validates a fresh plan.` : `The validation window closed${attempt.validUntil ? ` at ${utc(attempt.validUntil)}` : ""}; nothing was prompted. Recover reads the order state; abandon records that nothing was sent.` };
  return { ok: true };
}

// one execution at a time: the button, a double click and a resumed attempt all join the call in flight
let inflight: Promise<ExecuteEvent> | null = null;
export const executionInFlight = () => inflight !== null;
function guarded(fn: () => Promise<ExecuteEvent>): Promise<ExecuteEvent> {
  if (inflight) return inflight;
  const p = fn().finally(() => { if (inflight === p) inflight = null; });
  inflight = p; return p;
}
/** test seam */
export function resetExecutionGuard() { inflight = null; }

export type SendInput = { provider: Eip1193; account: string; attempt: AttemptView; withToken: WithToken; onEvent?: (ev: ExecuteEvent) => void; poll?: Poller };
export type ExecuteInput = { provider: Eip1193; account: string; requestId: string; orderId: string; policy: unknown; withToken: WithToken; onEvent?: (ev: ExecuteEvent) => void; poll?: Poller };
/** POST /v1/wallet/attempts, then the wallet part. A 409 VALIDATION_FAILED is a refusal (nothing was sent); a 409 ATTEMPT_OPEN loads the open
 *  attempt and shows it instead of an error; other refusals surface as errors. A second call while one runs returns the running one. */
export function executeAttempt(i: ExecuteInput): Promise<ExecuteEvent> { return guarded(() => executeInner(i)); }
async function executeInner(i: ExecuteInput): Promise<ExecuteEvent> {
  const emit = (ev: ExecuteEvent) => { i.onEvent?.(ev); return ev; };
  emit({ phase: "validating", attempt: null });
  let attempt: AttemptView;
  try { attempt = await i.withToken((t) => api.createAttempt({ requestId: i.requestId, orderId: i.orderId, policy: i.policy }, t)); }
  catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body?.error === "VALIDATION_FAILED") {
      const reasons: string[] = Array.isArray(e.body?.reasons) ? e.body.reasons : [];
      const attemptId = typeof e.body?.attemptId === "string" ? e.body.attemptId : null;
      if (attemptId) rememberAttempt({ attemptId, orderId: i.orderId, requestId: i.requestId, createdAt: new Date().toISOString(), state: "REFUSED" });
      const stage: Refusal["stage"] = /final validation/i.test(String(e.body?.reason)) ? "finalValidation" : "decision";
      return emit({ phase: "refused", attempt: null, refusal: { stage, reasons, attemptId, text: describeError(e).text } });
    }
    if (e instanceof ApiError && e.status === 409 && e.body?.error === "ATTEMPT_OPEN") {
      const open = await findOpenAttempt(i.orderId, i.withToken).catch(() => null);
      if (open) {
        rememberView(open);
        if (open.state === "BROADCAST_ATTEMPTED") {
          emit({ phase: "polling", attempt: open, txHash: open.txHash });
          const polled = await pollAttempt(open.attemptId, i.withToken, i.poll, (a) => { rememberView(a); emit({ phase: "polling", attempt: a, txHash: a.txHash }); });
          const last = polled.attempt ?? open;
          return emit({ phase: polled.settled ? "done" : "unresolved", attempt: last, txHash: last.businessTxHash ?? last.txHash });
        }
        return emit({ phase: "open-attempt", attempt: open });
      }
    }
    return emit({ phase: "error", attempt: null, error: describeError(e) });
  }
  return sendInner({ provider: i.provider, account: i.account, attempt, withToken: i.withToken, onEvent: i.onEvent, poll: i.poll });
}

/** The part that needs the wallet: remember → re-check the wallet → prompt → report the hash → poll. Reused to resume a VALIDATED attempt
 *  found after a refresh. A second call while one runs returns the running one. */
export function sendValidatedAttempt(i: SendInput): Promise<ExecuteEvent> { return guarded(() => sendInner(i)); }
async function sendInner(i: SendInput): Promise<ExecuteEvent> {
  const emit = (ev: ExecuteEvent) => { i.onEvent?.(ev); return ev; };
  const { attempt } = i;
  if (attempt.state !== "VALIDATED" || !attempt.plan) return emit({ phase: "error", attempt, error: { text: `This attempt is ${attempt.state}; only a validated attempt with its plan can be handed to the wallet.`, code: "ATTEMPT_NOT_OPEN", raw: attempt } });
  // remembered BEFORE the prompt: a refresh while the wallet is open still finds the attempt in "My workflow"
  rememberView(attempt);
  const pre = await preSendCheck(i.provider, attempt, (i.poll?.now ?? Date.now)());
  if (!pre.ok) return emit({ phase: "error", attempt, error: { text: pre.text, code: pre.code, raw: null } }); // the attempt stays VALIDATED for abandon / recover
  emit({ phase: "prompting", attempt });
  let txHash: string;
  try {
    const hash = await i.provider.request({ method: "eth_sendTransaction", params: [txRequestFromPlan({ ...attempt.plan, from: i.account })] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`the wallet returned ${JSON.stringify(hash)} instead of a transaction hash`);
    txHash = hash;
  } catch (e) {
    if (isUserRejection(e)) {
      try { const a = await i.withToken((t) => api.attemptAbandon(attempt.attemptId, t)); rememberView(a); return emit({ phase: "abandoned", attempt: a }); }
      catch (e2) { return emit({ phase: "error", attempt, error: describeError(e2) }); }
    }
    return reconcileAmbiguous(i, attempt, describeError(e), emit); // timeout, "already known", "nonce too low", network error: possibly submitted
  }
  emit({ phase: "reporting", attempt, txHash });
  let sent: AttemptView | null = null;
  try { sent = await i.withToken((t) => api.attemptSent(attempt.attemptId, txHash, t)); rememberView(sent); }
  catch (e) { emit({ phase: "error", attempt, txHash, error: describeError(e) }); /* the hash exists on the network; keep observing — the worker also recovers through OrderPaid */ }
  if (sent && !isOpen(sent.state)) return emit({ phase: "done", attempt: sent, txHash });
  emit({ phase: "polling", attempt: sent ?? attempt, txHash });
  const polled = await pollAttempt(attempt.attemptId, i.withToken, i.poll, (a) => { rememberView(a); emit({ phase: "polling", attempt: a, txHash }); });
  const last = polled.attempt ?? sent ?? attempt;
  return emit({ phase: polled.settled ? "done" : "unresolved", attempt: last, txHash });
}

/** The wallet threw something that is not a rejection: the transaction MAY have been submitted. Reconcile first (POST …/recover performs the
 *  order / OrderPaid search at once, docs/LIFECYCLE.md §9), then observe every ~2 s with a recover every third tick, for up to 60 s. Ends
 *  `done` when the attempt closes (CONFIRMED through OrderPaid, or MISMATCH/REVERTED), otherwise stays `unknown-submission` with the attempt
 *  still VALIDATED: the visitor decides (explicit abandon) — never a second prompt, never "nothing was sent". */
async function reconcileAmbiguous(i: SendInput, attempt: AttemptView, error: Described, emit: (ev: ExecuteEvent) => ExecuteEvent): Promise<ExecuteEvent> {
  emit({ phase: "unknown-submission", attempt, error });
  const intervalMs = i.poll?.intervalMs ?? 2000, maxMs = i.poll?.ambiguousMaxMs ?? 60_000, wait = i.poll?.wait ?? sleep, now = i.poll?.now ?? Date.now;
  const t0 = now(); let last = attempt;
  for (let n = 0; ; n++) {
    try {
      last = await i.withToken((t) => (n % 3 === 0 ? api.attemptRecover(attempt.attemptId, t) : api.attempt(attempt.attemptId, t)));
      rememberView(last);
      if (!isOpen(last.state)) return emit({ phase: "done", attempt: last, txHash: last.businessTxHash ?? last.txHash, error: null });
      emit({ phase: "unknown-submission", attempt: last, txHash: last.txHash, error });
    } catch (e) { if (e instanceof ApiError && e.status !== 429 && e.status < 500) return emit({ phase: "unknown-submission", attempt: last, error: describeError(e) }); /* transport or 5xx: keep going */ }
    if (now() - t0 >= maxMs) return emit({ phase: "unknown-submission", attempt: last, txHash: last.txHash, error });
    await wait(intervalMs);
  }
}

// ---- rendering helpers (pure)
export type Headline = { text: string; tone: Tone };
/** one sentence keyed on the recorded state — never preset success copy. `reconciling`: the ambiguous-submission loop is still running. */
export function attemptMessage(a: AttemptView | null, phase: ExecutePhase = "idle", opts: { reconciling?: boolean } = {}): Headline {
  if (phase === "validating") return { text: "Validating the exact plan at a fresh pinned block (server-side, for your wallet)…", tone: "info" };
  if (phase === "prompting") return { text: "Attempt recorded. Confirm the transaction in your wallet — it signs exactly the validated plan.", tone: "info" };
  if (phase === "reporting") return { text: "Your wallet returned a hash; reporting it to the service.", tone: "info" };
  if (phase === "polling") return { text: "Broadcast attempted. Waiting for the receipt; the outcome is not established yet.", tone: "warn" };
  if (phase === "refused") return { text: "Validation did not pass; nothing was handed to the wallet.", tone: "bad" };
  if (phase === "unknown-submission") return opts.reconciling || !a || !isOpen(a.state) ? { text: AMBIGUOUS_TEXT, tone: "warn" } : { text: AMBIGUOUS_OPEN_TEXT, tone: "warn" };
  if (phase === "open-attempt") return { text: "An attempt for this order is already open (validated earlier; nothing new was validated): it is shown below — continue it in your wallet inside its window, abandon it, or recover it.", tone: "warn" };
  if (!a) return { text: "No attempt yet.", tone: "neutral" };
  switch (a.state) {
    case "VALIDATED": return insideWindow(a) ? { text: "Validated. The plan waits for your wallet; the window closes at the recorded time.", tone: "info" } : { text: "Validated, but the window closed without a reported hash. Recover reads the order state; abandon records that nothing was sent.", tone: "warn" };
    case "BROADCAST_ATTEMPTED": return { text: "A broadcast was attempted; the outcome is not yet established.", tone: "warn" };
    case "CONFIRMED": return a.businessStatus === "SUCCESS" ? { text: "Order payment confirmed: the order reads as paid by your wallet for the exact amount.", tone: "ok" } : { text: "Transaction confirmed; the expected order outcome was not verified.", tone: "bad" };
    case "MISMATCH": return { text: "The transaction your wallet sent deviates from the validated plan; the order state decides whether the order was paid.", tone: "bad" };
    case "REVERTED": return { text: "The transaction reverted; this attempt did not pay the order.", tone: "bad" };
    case "NOT_SENT": return { text: "Nothing was sent: the wallet prompt was rejected or abandoned. The order stays unpaid.", tone: "neutral" };
    case "NOT_MINED": return { text: "The reported hash can never be mined (its nonce was consumed by another transaction); the order reads as unpaid; nothing was re-signed.", tone: "warn" };
    case "NOT_EXECUTED": return { text: "No transaction was established by this service; the order reads as unpaid.", tone: "warn" };
    case "REFUSED": return { text: "Validation did not pass; nothing was handed to the wallet.", tone: "bad" };
    default: return { text: `State ${a.state}.`, tone: "neutral" };
  }
}
export const stateTone = (s: AttemptState | string | null | undefined): Tone => (s === "CONFIRMED" ? "ok" : s === "VALIDATED" || s === "BROADCAST_ATTEMPTED" ? "info" : s === "NOT_SENT" ? "neutral" : s === "MISMATCH" || s === "REVERTED" || s === "REFUSED" ? "bad" : "warn");
export type DeviationRow = { field: string; plan: string | null; actual: string | null; kind: "mismatch" | "deviation" };
/** mismatch = the call itself differs (red); deviation = wallet-set gas, fees or nonce (amber, recorded, never silently accepted) */
export function deviationRows(d: Deviations | null | undefined): DeviationRow[] {
  if (!d) return [];
  const rows: DeviationRow[] = (d.mismatch ?? []).map((field) => ({ field, plan: null, actual: null, kind: "mismatch" as const }));
  for (const [field, v] of Object.entries(d.deviations ?? {})) rows.push({ field, plan: v.plan, actual: v.actual, kind: "deviation" });
  return rows;
}
