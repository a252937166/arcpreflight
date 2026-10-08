import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { BaselineCore, IntentCore, PolicyCore, QuoteCore, baselineDigest, intentDigest, policyDigest } from "@arcpreflight/schema";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { api, type BaselineRecord } from "./api";

export type DeveloperOrder = { orderId: Hex; tx: Hex; block: string; merchant: Hex; amountNativeAtomic: string; baselineDigest: Hex | null };
export type PinnedQuote = { requestId: string; pinnedBlock: string; quote: QuoteCore; __status: number };
export type PreparedQuote = { intent: IntentCore; response: PinnedQuote };

/** the human-paced validation window (docs/LIFECYCLE.md §3): a wallet prompt takes seconds, not milliseconds; the server caps it at 120 s */
export const WALLET_VALIDATION_WINDOW_SECONDS = 60;
/** how long a delivered report may be used by the wallet workflow (reading the decision, answering the prompt): matches the server's report
 *  lifetime (REPORT_TTL_SECONDS, 300); the final validation re-reads the critical state at a fresh block regardless */
export const WALLET_REPORT_AGE_SECONDS = 300;
/** The buyer's policy for an order paid from a browser wallet. Deterministic in (account, order), so the same digest is reproduced after a reload
 *  and equals `intent.policyDigest` — the server checks exactly that when it validates a wallet attempt. */
export function developerPolicy(account: string, order: DeveloperOrder): PolicyCore {
  return PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "developer-console", allowedSenders: [account], allowedTargets: [order.merchant], allowedSelectors: [PAY_SELECTOR],
    maxNativePaymentAtomic: order.amountNativeAtomic, maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: WALLET_REPORT_AGE_SECONDS, maxFinalValidationAgeSeconds: WALLET_VALIDATION_WINDOW_SECONDS,
    requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
}

/** A revision gets one request ID and expiry. Keep the returned intent unchanged through quote and payment. */
export function developerIntent(chainId: number, account: string, order: DeveloperOrder, policy: PolicyCore, unitMistake: boolean): IntentCore {
  return IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `dev-${crypto.randomUUID()}`, chainId, walletMode: "EOA_DIRECT_NON_DELEGATED", from: account, operation: "CALL", to: order.merchant,
    data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [order.orderId] }), valueNativeAtomic: unitMistake ? (BigInt(order.amountNativeAtomic) / 10n ** 12n).toString() : order.amountNativeAtomic,
    businessExpectation: { sourceId: `order:${order.orderId}`, sourceDigest: keccak256(toHex(`order:${order.orderId}:${account}:${order.amountNativeAtomic}`)), action: "MERCHANT_PAY", recipient: order.merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: order.amountNativeAtomic, orderId: order.orderId },
    baselineDigest: order.baselineDigest ?? ("0x" + "00".repeat(32)), policyDigest: policyDigest(policy), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
}

export function newRequestIntent(intent: IntentCore): IntentCore {
  return IntentCore.parse({ ...intent, clientRequestId: `dev-${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
}

export function quoteReady(prepared: PreparedQuote | null, orderBlock: string, now = Date.now()): boolean {
  if (!prepared || !/^(0|[1-9][0-9]*)$/.test(prepared.response.pinnedBlock)) return false;
  return BigInt(prepared.response.pinnedBlock) >= BigInt(orderBlock) &&
    prepared.response.quote.intentDigest === intentDigest(prepared.intent) &&
    new Date(prepared.response.quote.expiresAt).getTime() > now && new Date(prepared.intent.expiresAt).getTime() > now;
}

/** Re-request stale observations under new IDs; retrying the old ID would reuse the same pinned quote. */
export async function prepareOrderQuote(intent: IntentCore, orderBlock: string, token: string, options: {
  maxAttempts?: number; wait?: () => Promise<void>; isCurrent?: () => boolean;
} = {}): Promise<PreparedQuote> {
  const maxAttempts = options.maxAttempts ?? 8;
  let current = intent;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.isCurrent?.() === false) throw new Error("Wallet or intent changed; request a new quote.");
    const response = await api.preflight(current, token);
    if (options.isCurrent?.() === false) throw new Error("Wallet or intent changed; request a new quote.");
    if (response.__status !== 402 || !response.quote) throw new Error(`expected 402 quote, got ${response.__status}`);
    const quote = QuoteCore.parse(response.quote);
    if (quote.intentDigest !== intentDigest(current) || quote.requestId !== response.requestId) throw new Error("quote is not bound to this intent and request");
    const prepared = { intent: current, response: { ...response, quote } } as PreparedQuote;
    if (BigInt(quote.amountTokenAtomic) > 10_000n) throw new Error("quote exceeds policy.maxServiceFeeTokenAtomic");
    if (quoteReady(prepared, orderBlock)) return prepared;
    if (attempt + 1 < maxAttempts) {
      await (options.wait?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 1500)));
      current = newRequestIntent(current);
    }
  }
  throw new Error("The pinned block cannot see this order yet. Nothing was paid; request a new quote shortly.");
}

export async function approvedBaseline(digest: string, token: string): Promise<BaselineRecord> {
  const response = await api.baseline(digest, token);
  const baseline = BaselineCore.parse(response.baseline);
  if (baselineDigest(baseline) !== digest || response.baselineDigest !== digest || typeof response.revoked !== "boolean") throw new Error("baseline digest or revocation metadata mismatch");
  return { baselineDigest: response.baselineDigest, baseline, revoked: response.revoked };
}
