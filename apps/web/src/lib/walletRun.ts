// "Check with your wallet" (P3, v3.3): the Live Demo's quick comparison driven from a connected wallet — an order on the fixture's
// proxy (MAIN or CHANGED), the free 402 quote, ONE EIP-3009 fee authorization signed by the wallet, the report bought over x402 and
// the deterministic decision in the browser. It stops at the decision on purpose: execution is the Developer workflow's step 4,
// where the service validates the exact plan at a fresh block and persists the attempt before the wallet is prompted
// (docs/LIFECYCLE.md §3). A NO_POLICY_VIOLATION check hands its order and request over to that workflow.
// The helpers below are the single implementation the Developer workflow's step buttons use as well.
import { useCallback, useRef, useState } from "react";
import { toHex, type Hex } from "viem";
import { intentDigest, policyDigest, ReportCore, reportDigest, type IntentCore } from "@arcpreflight/schema";
import { decide } from "@arcpreflight/policy";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain, type ArcNet } from "@arcpreflight/client";
import { api, ApiError, type ApiClient, type BaselineRecord, type Fixture, type FixtureInfo, type NetworkInfo, type Report, type Step } from "./api";
import { approvedBaseline, developerIntent, developerPolicy, prepareOrderQuote, type DeveloperOrder, type PreparedQuote } from "./preflight";
import { signTypedDataV4, type Eip1193 } from "./wallet";
import { withSession } from "./session";
import { rememberCheck } from "./checks";
import { saveWorkflow } from "./workflow";
import { describeError, describedError, ORDER_RESPONSE_LOST_TEXT, type Described } from "./errors";
import { isPendingOrder } from "./orders";

/** the truthful line a check-only wallet run ends with (v3.3): what the check decided, and where execution happens */
export const checkDecidedLine = (decision: string) => decision === "NO_POLICY_VIOLATION"
  ? "the check decided NO_POLICY_VIOLATION; execute from the Developer workflow with your wallet — the service validates the exact plan at a fresh block and records the attempt before your wallet is prompted"
  : `the check decided ${decision}; nothing is executed — a payment outside the referenced approval is not handed to any wallet`;

export type FeeAuthorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
export type FeePayment = { signature: Hex; authorization: FeeAuthorization };
/** ONE EIP-3009 TransferWithAuthorization for exactly the quoted fee, signed by the wallet (eth_signTypedData_v4). */
export async function signFeeAuthorization(provider: Eip1193, account: string, net: NetworkInfo, quote: PreparedQuote): Promise<FeePayment> {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
  const authorization: FeeAuthorization = { from: quote.intent.from, to: quote.response.quote.payTo, value: quote.response.quote.amountTokenAtomic, validAfter: "0", validBefore, nonce };
  const typed = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...TRANSFER_WITH_AUTHORIZATION_TYPES }, primaryType: "TransferWithAuthorization", domain: usdcDomain(net.network as ArcNet), message: authorization };
  const signature = await signTypedDataV4(provider, account, typed);
  return { signature, authorization };
}

export type Delivered = { report: Report; digest: string; simulation: any; serviceFeeTx: string | null; requestId: string };
/** Pays the quote and waits for delivery. A 202 means the fee is still settling on Arc: the SAME request is polled — nothing is paid twice.
 *  The request id is remembered before anything leaves, so "My checks" can find it even if the response is lost. */
export async function purchaseReport(quote: PreparedQuote, token: string, payment: FeePayment, opts: { wait?: () => Promise<void>; maxPolls?: number; client?: ApiClient } = {}): Promise<Delivered> {
  const quotedIntent = quote.intent; const requestId = quote.response.requestId; const c = opts.client ?? api; // the purchase and its polls stay on one instance
  rememberCheck({ requestId, createdAt: new Date().toISOString(), subject: quotedIntent.to, valueNativeAtomic: quotedIntent.valueNativeAtomic });
  let r = await c.preflight(quotedIntent, token, payment);
  let tries = 0; const max = opts.maxPolls ?? 20;
  while (r.__status === 202 && tries++ < max) { await (opts.wait?.() ?? new Promise((s) => setTimeout(s, 1500))); r = await c.request(requestId, token); }
  if (r.__status === 202) throw new Error("The check fee is still settling on Arc. Nothing is paid twice: recover this request from \"My checks\" on the Developer page once it has settled.");
  if (r.delivery !== "DELIVERED") throw new ApiError(r.__status, r);
  const rep = ReportCore.parse(r.report);
  if (reportDigest(rep) !== r.reportDigest) throw new Error("report digest mismatch (recomputed in the browser)");
  if (rep.intentDigest !== intentDigest(quotedIntent)) throw new Error("report bound to a different intent");
  return { report: r.report, digest: r.reportDigest, simulation: r.simulation, serviceFeeTx: r.payment?.transaction ?? null, requestId };
}

export type WalletRunPhase = "idle" | "running" | "done" | "error";
export type WalletRun = {
  phase: WalletRunPhase; fixture: Fixture | null; startedAt: number | null; finishedAt: number | null;
  steps: Step[]; order: (DeveloperOrder & { proxy: "MAIN" | "CHANGED" }) | null; intent: IntentCore | null; quote: PreparedQuote | null;
  delivered: Delivered | null; baseline: BaselineRecord | null; decision: ReturnType<typeof decide> | null; err: Described | null;
  /** the referenced approval could not be read (not a 404): the paid report is kept, no decision was made (audit 2026-10-10, W07) */
  approvalReadFailed?: Described | null;
  /** the check handed over to the Developer workflow for execution (NO_POLICY_VIOLATION only) */
  handoff: boolean;
};
export const EMPTY_WALLET_RUN: WalletRun = { phase: "idle", fixture: null, startedAt: null, finishedAt: null, steps: [], order: null, intent: null, quote: null, delivered: null, baseline: null, decision: null, err: null, handoff: false, approvalReadFailed: null };
export type WalletLike = { provider: Eip1193 | null; account: string | null; chainId: number | null };

/** The one-flow hook: `start(fixture)` runs the check with the connected wallet under this browser's anonymous session (created on
 *  first use, see lib/session.ts); every step is recorded as it happens (same step names the runner emits). */
export function useWalletRun(net: NetworkInfo | null, wallet: WalletLike) {
  const [run, setRun] = useState<WalletRun>(EMPTY_WALLET_RUN);
  const seq = useRef(0);
  const { provider, account, chainId } = wallet;
  const start = useCallback(async (fixture: FixtureInfo) => {
    if (!net || !provider || !account || chainId !== net.chainId) return;
    const id = ++seq.current; const t0 = Date.now();
    const alive = () => seq.current === id;
    const patch = (p: Partial<WalletRun>) => { if (alive()) setRun((r) => ({ ...r, ...p })); };
    const push = (step: string, facts: Record<string, unknown>) => { if (alive()) setRun((r) => ({ ...r, steps: [...r.steps, { step, atMs: Date.now() - t0, ...facts }] })); };
    setRun({ ...EMPTY_WALLET_RUN, phase: "running", fixture: fixture.id, startedAt: t0 });
    try {
      let answer;
      try { answer = await withSession((t, c) => c.createOrder({ payer: account, proxy: fixture.proxy }, t)); }
      catch (e) { if (describeError(e).code === "NETWORK") throw new Error(ORDER_RESPONSE_LOST_TEXT); throw e; } // a lost answer may hide a recorded order
      if (isPendingOrder(answer)) { // 202: the identity is recorded, the creation is not confirmed — nothing below may use it yet (2026-10-09)
        push("orderCreationPending", { who: "order-creator (API)", why: answer.reason ?? "the creation is not confirmed yet", orderId: answer.orderId, createOrderTx: answer.tx });
        throw new Error(`Order ${answer.orderId.slice(0, 10)}… is recorded, but its creation is not confirmed yet${answer.reason ? ` (${answer.reason})` : ""}. It is reconciled from the chain — the same signed transaction is re-sent, never a second order. Follow it in the Developer workflow (My workflow) before starting another check.`);
      }
      const o = answer;
      const order: WalletRun["order"] = { orderId: o.orderId as Hex, tx: o.tx as Hex, block: o.block, merchant: o.merchant as Hex, amountNativeAtomic: o.amountNativeAtomic, baselineDigest: (o.baselineDigest as Hex | null) ?? null, proxy: o.proxy ?? fixture.proxy };
      patch({ order });
      push("createOrder", { who: "order-creator (API)", why: `an order payable only by your address on the ${order.proxy} proxy — the independent business expectation`, orderId: order.orderId, block: order.block, createOrderTx: order.tx, merchant: order.merchant, proxy: order.proxy, amountNativeAtomic: order.amountNativeAtomic });
      const policy = developerPolicy(account, order);
      const unitMistake = fixture.id === "AMOUNT_UNIT_MISMATCH";
      const intent = developerIntent(net.chainId, account, order, policy, unitMistake);
      patch({ intent });
      push("intent", { who: "your browser", why: unitMistake ? "the value is encoded in 6-decimal units on the 18-decimal native path — the classic Arc mistake" : "exact call: pay(orderId) with the approved amount", intentDigest: intentDigest(intent), to: intent.to, valueNativeAtomic: intent.valueNativeAtomic, approvedAmountNativeAtomic: order.amountNativeAtomic });
      const quote = await withSession((t, c) => prepareOrderQuote(intent, order.block, t, { isCurrent: alive }, c));
      if (!alive()) return;
      patch({ quote, intent: quote.intent });
      push("quote", { who: "ArcPreflight API (x402 · HTTP 402)", why: "the report is prepared and pinned before anything is charged", requestId: quote.response.requestId, priceTokenAtomic: quote.response.quote.amountTokenAtomic, pinnedBlock: quote.response.pinnedBlock, expiresAt: quote.response.quote.expiresAt });
      const payment = await signFeeAuthorization(provider, account, net, quote);
      if (!alive()) return;
      push("signServiceFee", { who: "your wallet", why: "one EIP-3009 TransferWithAuthorization for exactly the quoted fee — the only thing this wallet signs in a check", from: payment.authorization.from, payTo: payment.authorization.to, valueTokenAtomic: payment.authorization.value });
      const delivered = await withSession((t, c) => purchaseReport(quote, t, payment, { client: c }));
      if (!alive()) return;
      patch({ delivered });
      push("reportDelivered", { who: "ArcPreflight relayer → API", why: "the fee settled on Arc (gas in USDC paid by the project's merchant account); the report's digest is recomputed here", serviceFeeTx: delivered.serviceFeeTx, reportDigest: delivered.digest, baselineResult: delivered.report.baselineResult, pinnedBlock: delivered.report.observation.blockNumber });
      // audit 2026-10-10 (W07): a 404 is an answer (no approved baseline → the decision is made without one); any other failure is NOT a decision —
      // the paid report is kept, handed to the Developer workflow as this wallet's check, and the error says to retry the same report (no new fee)
      let baseline: BaselineRecord | null = null;
      if (order.baselineDigest) {
        try { baseline = await withSession((t, c) => approvedBaseline(order.baselineDigest!, t, c)); }
        catch (e) {
          if (!alive()) return;
          if (!(e instanceof ApiError && e.status === 404)) {
            saveWorkflow({ payer: account, orderId: order.orderId, proxy: order.proxy, baselineDigest: order.baselineDigest, approved: true, requestId: delivered.requestId, intent: quote.intent, attemptId: null, handoff: "demo" });
            patch({ approvalReadFailed: describeError(e) });
            throw describedError(`The referenced approval could not be read (${describeError(e).text}) — no decision was made. Your paid report (request ${delivered.requestId.slice(0, 8)}…) is kept under My workflow on the Developer page; the decision is retried there from the same report, with no new fee.`, "APPROVAL_UNREAD", e);
          }
        }
      }
      if (!alive()) return;
      patch({ baseline });
      const decision = decide({ intent: quote.intent, policy, policyDigest: policyDigest(policy), baseline: baseline?.baseline ?? null, baselineDigest: (baseline?.baselineDigest as Hex | undefined) ?? null, baselineRevoked: baseline?.revoked ?? false, report: delivered.report as any, reportDigest: delivered.digest as Hex, now: new Date(), simulation: delivered.simulation });
      patch({ decision });
      push("decision", { who: "your browser (@arcpreflight/policy)", why: "deterministic: hard violations block, unapproved change or unknowns require review, otherwise no configured check fired", decision: decision.decision, reasons: decision.reasons });
      if (decision.decision === "NO_POLICY_VIOLATION") {
        // the Developer workflow picks this up (same browser, same instance, same anonymous session): order + exact quoted intent + delivered request
        saveWorkflow({ payer: account, orderId: order.orderId, proxy: order.proxy, baselineDigest: order.baselineDigest, approved: true, requestId: delivered.requestId, intent: quote.intent, attemptId: null, handoff: "demo" });
        patch({ handoff: true });
        push("readyToExecute", { who: "your browser", why: checkDecidedLine(decision.decision), orderId: order.orderId, requestId: delivered.requestId });
      } else {
        push("notSigned", { who: "your browser", why: checkDecidedLine(decision.decision), decision: decision.decision });
      }
      patch({ phase: "done", finishedAt: Date.now() });
    } catch (e) {
      if (!alive()) return;
      const err = describeError(e);
      push("error", { who: "your browser", error: err.text });
      patch({ phase: "error", err, finishedAt: Date.now() });
    }
  }, [net, provider, account, chainId]);
  const reset = useCallback(() => { seq.current++; setRun(EMPTY_WALLET_RUN); }, []);
  return { run, start, reset };
}
