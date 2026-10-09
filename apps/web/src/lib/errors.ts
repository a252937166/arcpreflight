// One readable sentence per API error code. Raw bodies stay available for engineers (shown in a <details>), never as the
// user-facing text: a judge reading "not delivered: {json}" learns nothing, "the check fee was not settled: …" does.
import { ApiError } from "./api";

export type Described = { text: string; code: string | null; raw: unknown };

const reason = (b: any) => (typeof b?.reason === "string" && b.reason ? b.reason : null);
const shortId = (id: unknown) => (typeof id === "string" && id.length > 14 ? `${id.slice(0, 10)}…` : typeof id === "string" ? id : "(unnamed)");
/** the order request's answer was lost on the way (network error): the server may have recorded the order and sent its creation */
export const ORDER_RESPONSE_LOST_TEXT = "The answer to the order request was lost (network error). The order may have been recorded and its creation sent — My workflow is re-read now; do not create another order until it shows there.";
const SENTENCES: Record<string, (b: any) => string> = {
  PAYMENT_FAILED: (b) => `The check fee was not settled: ${b?.payment?.reason ?? reason(b) ?? "the settlement failed"}. Nothing was charged and no report was delivered.`,
  QUOTE_EXPIRED: () => "The quote expired before signing; request a new quote.",
  PAYMENT_MISMATCH: (b) => `The signed authorization does not match the quote: ${reason(b) ?? "mismatch"}. Nothing was stored.`,
  PAYMENT_CONFLICT: (b) => `This request already has a different authorization or quote bound to it (${reason(b) ?? "conflict"}).`,
  SETTLEMENT_PAUSED: (b) => `Fee settlement is paused on the relayer side; try again in about ${b?.retryAfterSeconds ?? 60} seconds (no authorization was stored).`,
  RATE_LIMITED: (b) => reason(b) ?? "The rate limit for this principal is reached; try again later.",
  REQUEST_CONFLICT: () => "This client request id is already bound to a different intent; use a new request id.",
  DEMO_BUSY: () => "Another live run is in progress; wait for it to finish — nothing was started.",
  DEMO_COOLDOWN: (b) => `${reason(b) ?? "One live run per client per cooldown window"} — nothing was started.`,
  DEMO_BUDGET_EXHAUSTED: (b) => `${reason(b) ?? "Today's live-run budget is used up"}. Recorded samples remain available.`,
  DEMO_UNAVAILABLE: (b) => `The live demo is unavailable right now: ${reason(b) ?? "a dependency is missing"}. Nothing was started.`,
  // v3.3 execution gate (docs/LIFECYCLE.md §8): business execution is closed on this instance until the mainnet acceptance is recorded
  EXECUTION_GATED: (b) => `Execution is gated on this instance: ${reason(b) ?? "business execution opens after the mainnet acceptance"}. Nothing was started or created; checks, recovery and passports stay available — use the testnet instance to execute.`,
  // Gate D: the order creation's worst-case gas cost was above the per-transaction cap; it was refused before anything was persisted or sent
  GAS_CAP_EXCEEDED: (b) => `The order was not created: ${reason(b) ?? "the transaction's worst-case gas cost is above the per-transaction cap"}. Nothing was sent; try again when the network fee is lower.`,
  // v3.3 wallet attempts
  VALIDATION_FAILED: (b) => `Validation did not pass: ${reason(b) ?? "the decision or the final validation refused"}. Nothing was handed to the wallet.`,
  ORDER_NOT_CONFIRMED: (b) => `${reason(b) ?? "The order is not confirmed yet"}; only a confirmed order can be paid.`,
  ORDER_MISMATCH: () => "The order's payer, merchant or amount differs from the check's business expectation; nothing was validated.",
  ORDER_ALREADY_PAID: () => "This order already reads as paid; nothing was validated.",
  CHECK_NOT_DELIVERED: () => "The check fee has not settled yet; the report must be delivered before anything is executed.",
  ATTEMPT_OPEN: () => "An attempt for this order is still open: confirm it in your wallet, abandon it, or let it reconcile before validating another.",
  ATTEMPT_NOT_OPEN: (b) => `${reason(b) ?? "This attempt is no longer open"}.`,
  RUN_CONFLICT: () => "This admission key is already bound to a different scenario; start a new run (a new key is generated per click).",
  PASSPORT_NOT_READY: (b) => `The passport is not available yet: ${reason(b) ?? "the run is still in progress"}.`,
  UNAUTHENTICATED: () => "This browser's session is no longer valid; a new one was created — try again.",
  FORBIDDEN: () => "This action needs an administrator credential.",
  NOT_FOUND: () => "Nothing was found under that identifier for this principal.",
  UNSUPPORTED_TARGET: () => "This target is not a supported DemoMerchant proxy in this release.",
  UNSUPPORTED_ACTION: (b) => reason(b) ?? "This intent action is disabled in this release.",
  UNSUPPORTED_SUBJECT: (b) => reason(b) ?? "This release observes a curated list of public samples only.",
  INVALID_INPUT: (b) => `The request was rejected as invalid${reason(b) ? `: ${reason(b)}` : ""}.`,
  INVALID_JSON: () => "The request body was not valid JSON.",
  PAYLOAD_TOO_LARGE: () => "The request body is too large.",
  // once the server names an order identity, nothing here may claim that nothing changed (2026-10-09)
  DEPENDENCY_ERROR: (b) => b?.orderId ? `A dependency failed (RPC or database)${reason(b) ? `: ${reason(b)}` : ""}. Order ${shortId(b.orderId)} was recorded; its creation is reconciled from the chain — check My workflow.` : `A dependency failed (RPC or database)${reason(b) ? `: ${reason(b)}` : ""}. Nothing was changed by this request.`,
  // v3.3 order creation after the identity is recorded (2026-10-09): the answer names the order; never "nothing was changed"
  ORDER_CREATION_PENDING: (b) => `Order ${shortId(b?.orderId)} is recorded, but its creation is not confirmed yet${reason(b) ? ` (${reason(b)})` : ""}. It is reconciled from the chain — the same signed transaction is re-sent, never a second order. Wait for it or use Recover.`,
  ORDER_CREATION_FAILED: (b) => `Order ${shortId(b?.orderId)} was recorded but not created: ${reason(b) ?? "the creation did not go through"}. The row stays for the record; create a new order.`,
  NON_JSON: (b) => `The server answered with something that is not JSON${b?.text ? ` (${String(b.text).slice(0, 80)})` : ""}.`,
  // testnet faucet (P3) — every refusal says that nothing was sent
  FAUCET_DISABLED: () => "The faucet exists on Arc testnet only; nothing was sent.",
  FAUCET_COOLDOWN: (b) => `${reason(b) ?? "This wallet or client already claimed testnet USDC in the last 24 hours"}. Nothing was sent.`,
  FAUCET_BUDGET_EXHAUSTED: (b) => `${reason(b) ?? "The faucet's daily budget is used; try again tomorrow"}. Nothing was sent.`,
  FAUCET_EMPTY: () => "The faucet key is below its floor and is topped up by hand; nothing was sent.",
  FAUCET_FAILED: (b) => `The faucet transaction did not go through${reason(b) ? `: ${reason(b)}` : ""}. Check your balance before claiming again.`,
};

/** Turns an API error body into a sentence. Unknown codes fall back to the server's reason or the code itself. */
export function describeBody(body: any, status?: number): Described {
  const code = typeof body?.error === "string" ? body.error : null;
  if (code && SENTENCES[code]) return { text: SENTENCES[code](body), code, raw: body };
  const text = reason(body) ?? (code ? code.replace(/_/g, " ").toLowerCase() : null) ?? (status ? `HTTP ${status}` : "Unexpected response");
  return { text: text.endsWith(".") ? text : `${text}.`, code, raw: body };
}

export function describeError(e: unknown): Described {
  if (e instanceof ApiError || (e && typeof e === "object" && "body" in (e as any) && "status" in (e as any))) {
    const { body, status } = e as { body: any; status: number };
    return describeBody(body, status);
  }
  const msg = String((e as any)?.message ?? e ?? "unknown error");
  if (/Failed to fetch|NetworkError|network|ECONNREFUSED|Load failed/i.test(msg)) return { text: "The API could not be reached (network error). Nothing was sent; try again.", code: "NETWORK", raw: e };
  if (/user rejected|User denied|4001/i.test(msg)) return { text: "The wallet rejected the request; nothing was signed.", code: "WALLET_REJECTED", raw: e };
  return { text: msg.endsWith(".") ? msg : `${msg}.`, code: null, raw: e };
}
