// Orders with identity before sending (design v3.3 §2, docs/LIFECYCLE.md). Every order the service creates — for the Live Demo
// runner or for a visitor's wallet — is written PLANNED before its creation transaction leaves, SENT with the hash right after
// the send, CONFIRMED with the block after the receipt. A process that stops in between leaves a row that reconciliation
// resolves from the chain (getOrder), never by creating a replacement inside the same admission. No key material lives here;
// chain access is injected, so the module is testable with a fake RPC.
import { type Hex } from "viem";
import { reconcilePlannedOrder, readChainOrder, type OrderStore, type OrderRpc } from "@arcpreflight/runner";
export { readChainOrder, type OrderRpc };
import { type Db, row, rows, run, now } from "./db.js";

export type OrderState = "PLANNED" | "SENT" | "CONFIRMED" | "UNKNOWN_CREATION" | "FAILED";
export type OrderRow = {
  order_id: string; owner: string | null; client_key: string | null; source: "developer" | "runner"; run_id: string | null;
  payer: string; merchant: string; proxy: string | null; amount_atomic: string; reference: string | null;
  state: OrderState; tx_hash: string | null; block: string | null; from_addr: string | null; gas_used: string | null; effective_gas_price: string | null;
  paid: number | null; paid_checked_at: string | null; note: string | null; created_at: string; updated_at: string;
};

export const ORDER_LIMITS: { minNativeAtomic: bigint; maxNativeAtomic: bigint; stepNativeAtomic: bigint; defaultNativeAtomic: bigint; maxReferenceLength: number } = {
  minNativeAtomic: 1_000_000_000_000_000n, // 0.001 USDC
  maxNativeAtomic: 1_000_000_000_000_000_000n, // 1 USDC
  stepNativeAtomic: 1_000_000_000_000n, // whole 6-decimal token units
  defaultNativeAtomic: 50_000_000_000_000_000n, // 0.05 USDC
  maxReferenceLength: 64,
};

export type OrderInput = { payer: Hex; proxy: "MAIN" | "CHANGED"; amountNativeAtomic: bigint; reference: string | null };
/** Body validation for POST /v1/demo/orders: labelled reasons, nothing coerced silently. */
export function parseOrderInput(body: any, isAddress: (s: string) => boolean, getAddress: (s: string) => string): { ok: true; value: OrderInput } | { ok: false; reason: string; field: string } {
  if (!isAddress(String(body?.payer ?? ""))) return { ok: false, field: "payer", reason: "payer must be a 20-byte address" };
  const proxy = body?.proxy === undefined ? "MAIN" : body.proxy;
  if (proxy !== "MAIN" && proxy !== "CHANGED") return { ok: false, field: "proxy", reason: "proxy must be MAIN or CHANGED" };
  let amount = ORDER_LIMITS.defaultNativeAtomic;
  if (body?.amountNativeAtomic !== undefined) {
    if (typeof body.amountNativeAtomic !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.amountNativeAtomic)) return { ok: false, field: "amountNativeAtomic", reason: "amountNativeAtomic must be a decimal string of 18-decimal native units" };
    amount = BigInt(body.amountNativeAtomic);
    if (amount < ORDER_LIMITS.minNativeAtomic || amount > ORDER_LIMITS.maxNativeAtomic) return { ok: false, field: "amountNativeAtomic", reason: `amount must be between ${ORDER_LIMITS.minNativeAtomic} and ${ORDER_LIMITS.maxNativeAtomic} native units (0.001–1 USDC)` };
    if (amount % ORDER_LIMITS.stepNativeAtomic !== 0n) return { ok: false, field: "amountNativeAtomic", reason: "amount must be a whole number of 6-decimal USDC units (a multiple of 1e12 native units)" };
  }
  let reference: string | null = null;
  if (body?.reference !== undefined && body?.reference !== null && body?.reference !== "") {
    if (typeof body.reference !== "string") return { ok: false, field: "reference", reason: "reference must be text" };
    const trimmed: string = body.reference.trim();
    if (trimmed.length > ORDER_LIMITS.maxReferenceLength) return { ok: false, field: "reference", reason: `reference must be at most ${ORDER_LIMITS.maxReferenceLength} characters` };
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, field: "reference", reason: "reference must not contain control characters" };
    reference = trimmed.length ? trimmed : null;
  }
  return { ok: true, value: { payer: getAddress(body.payer) as Hex, proxy, amountNativeAtomic: amount, reference } };
}

export type PlanOrderInput = { orderId: Hex; owner: string | null; clientKey: string | null; source: "developer" | "runner"; runId?: string | null; payer: Hex; merchant: Hex; proxy: "MAIN" | "CHANGED" | null; amountNativeAtomic: string; reference: string | null };
export function planOrder(db: Db, o: PlanOrderInput) {
  run(db, "INSERT INTO orders (order_id, owner, client_key, source, run_id, payer, merchant, proxy, amount_atomic, reference, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    o.orderId.toLowerCase(), o.owner, o.clientKey, o.source, o.runId ?? null, o.payer.toLowerCase(), o.merchant.toLowerCase(), o.proxy, o.amountNativeAtomic, o.reference, "PLANNED", now(), now());
}
export function orderSent(db: Db, orderId: Hex, tx: Hex) {
  run(db, "UPDATE orders SET state = 'SENT', tx_hash = ?, updated_at = ? WHERE order_id = ? AND state = 'PLANNED'", tx.toLowerCase(), now(), orderId.toLowerCase());
}
export function orderConfirmed(db: Db, o: { orderId: Hex; tx: Hex | null; block: string | null; from?: Hex | null; gasUsed?: string | null; effectiveGasPriceNativeAtomic?: string | null; note?: string | null }) {
  run(db, "UPDATE orders SET state = 'CONFIRMED', tx_hash = COALESCE(?, tx_hash), block = COALESCE(?, block), from_addr = ?, gas_used = ?, effective_gas_price = ?, note = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')",
    o.tx?.toLowerCase() ?? null, o.block ?? null, o.from?.toLowerCase() ?? null, o.gasUsed ?? null, o.effectiveGasPriceNativeAtomic ?? null, o.note ?? null, now(), o.orderId.toLowerCase());
}
export function orderFailed(db: Db, orderId: Hex, state: "FAILED" | "UNKNOWN_CREATION", note: string) {
  run(db, "UPDATE orders SET state = ?, note = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')", state, note, now(), orderId.toLowerCase());
}
/** The runner's OrderStore over this table (Live Demo orders carry their run id). */
export function runnerOrderStore(db: Db, runId: string, clientKey: string | null, proxy: "MAIN" | "CHANGED", reference: string | null = null): OrderStore {
  return {
    planned: (o) => planOrder(db, { orderId: o.orderId, owner: null, clientKey, source: "runner", runId, payer: o.payer, merchant: o.merchant, proxy, amountNativeAtomic: o.amountNativeAtomic, reference }),
    sent: (o) => orderSent(db, o.orderId, o.tx),
    confirmed: (o) => orderConfirmed(db, { orderId: o.orderId, tx: o.tx, block: o.block, from: o.from, gasUsed: o.gasUsed, effectiveGasPriceNativeAtomic: o.effectiveGasPriceNativeAtomic }),
  };
}

/** Start-up pass, worker and read routes: PLANNED/SENT orders are resolved from the chain through the shared `reconcilePlannedOrder`
 *  (`packages/runner`, also used by the reference CLI); nothing is sent. An order not on chain after the window is closed
 *  UNKNOWN_CREATION (the row stays; a new order is a new row). */
export async function reconcileOrders(db: Db, rpc: OrderRpc, opts: { orderId?: string | null; now?: Date; windowMs?: number; log?: (m: string) => void } = {}): Promise<{ resolved: number; pending: number }> {
  const open: OrderRow[] = opts.orderId ? rows(db, "SELECT * FROM orders WHERE state IN ('PLANNED','SENT') AND order_id = ?", opts.orderId.toLowerCase()) : rows(db, "SELECT * FROM orders WHERE state IN ('PLANNED','SENT') ORDER BY created_at");
  let resolved = 0, pending = 0;
  for (const o of open) {
    try {
      const r = await reconcilePlannedOrder(rpc, { orderId: o.order_id as Hex, merchant: o.merchant as Hex, txHash: (o.tx_hash as Hex | null) ?? null, createdAt: o.created_at }, { now: opts.now, windowMs: opts.windowMs });
      if (r.kind === "confirmed") orderConfirmed(db, { orderId: o.order_id as Hex, tx: r.tx, block: r.block, from: r.from, gasUsed: r.gasUsed, effectiveGasPriceNativeAtomic: r.effectiveGasPriceNativeAtomic, note: r.note });
      else if (r.kind === "failed") orderFailed(db, o.order_id as Hex, "FAILED", r.note);
      else if (r.kind === "unknown") orderFailed(db, o.order_id as Hex, "UNKNOWN_CREATION", r.note);
      if (r.kind === "pending") pending++; else { resolved++; opts.log?.(`order ${o.order_id.slice(0, 10)}: ${r.kind.toUpperCase()}`); }
    } catch (e: any) { pending++; opts.log?.(`order ${o.order_id.slice(0, 10)}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  return { resolved, pending };
}

/** Refreshes the live `paid` flag of confirmed, not-yet-paid orders (bounded; a read, never a send). */
export async function refreshPaid(db: Db, rpc: OrderRpc, list: OrderRow[], limit = 20) {
  const todo = list.filter((o) => o.state === "CONFIRMED" && o.paid !== 1).slice(0, limit);
  for (const o of todo) {
    try {
      const c = await readChainOrder(rpc, o.merchant as Hex, o.order_id as Hex);
      run(db, "UPDATE orders SET paid = ?, paid_checked_at = ?, updated_at = ? WHERE order_id = ?", c.paid ? 1 : 0, now(), now(), o.order_id);
      o.paid = c.paid ? 1 : 0; o.paid_checked_at = now();
    } catch { /* unreadable now: the stored flag stays and is labelled by paid_checked_at */ }
  }
}

export type LinkedCheck = { requestId: string; state: string; createdAt: string; reportDigest: string | null; paymentState: string | null; serviceFeeTx: string | null; valueNativeAtomic: string };
export type LinkedAttempt = { attemptId: string; state: string; txHash: string | null; businessStatus: string | null; createdAt: string; updatedAt: string };
export function shapeOrder(db: Db, o: OrderRow, owner: string | null) {
  const checks: LinkedCheck[] = owner ? rows(db, "SELECT r.request_id, r.state, r.created_at, r.intent_json, q.report_digest, p.state AS pay_state, p.tx_hash FROM requests r LEFT JOIN quotes q ON q.request_id = r.request_id LEFT JOIN payments p ON p.request_id = r.request_id WHERE r.principal = ? AND lower(json_extract(r.intent_json, '$.businessExpectation.orderId')) = ? ORDER BY r.created_at DESC LIMIT 20", owner, o.order_id)
    .map((r: any) => { const intent = JSON.parse(r.intent_json); return { requestId: r.request_id, state: r.state, createdAt: r.created_at, reportDigest: r.report_digest ?? null, paymentState: r.pay_state ?? null, serviceFeeTx: r.tx_hash ?? null, valueNativeAtomic: intent.valueNativeAtomic }; }) : [];
  let attempts: LinkedAttempt[] = [];
  try { attempts = rows(db, "SELECT attempt_id, state, tx_hash, business_status, created_at, updated_at FROM wallet_attempts WHERE order_id = ? ORDER BY created_at DESC LIMIT 20", o.order_id).map((a: any) => ({ attemptId: a.attempt_id, state: a.state, txHash: a.tx_hash ?? null, businessStatus: a.business_status ?? null, createdAt: a.created_at, updatedAt: a.updated_at })); } catch { attempts = []; }
  const delivered = checks.find((c) => c.paymentState === "COMPLETED");
  const openAttempt = attempts.find((a) => a.state === "VALIDATED" || a.state === "BROADCAST_ATTEMPTED");
  const paidAttempt = attempts.find((a) => a.businessStatus === "SUCCESS");
  const nextAction = o.state === "PLANNED" || o.state === "SENT" ? "waiting for the creation receipt; reconciliation resolves it from the chain"
    : o.state !== "CONFIRMED" ? "this creation could not be established; create a new order (this row stays for the record)"
    : o.paid === 1 ? (paidAttempt ? "paid: export the passport of the paying attempt and verify it independently" : "the order reads as paid on chain (by a transaction this service did not establish); export the attempt's passport if one exists")
    : openAttempt ? (openAttempt.state === "VALIDATED" ? "an attempt is validated: confirm it in your wallet, or abandon it" : "a broadcast was attempted: wait for the receipt, or recover to reconcile now")
    : delivered ? "the check is delivered: review the decision and execute with your wallet" : checks.length ? "a check was started: pay its quote to receive the report" : "run the preflight check for this order";
  return { orderId: o.order_id, owner: o.owner, source: o.source, runId: o.run_id, payer: o.payer, merchant: o.merchant, proxy: o.proxy, amountNativeAtomic: o.amount_atomic, reference: o.reference,
    state: o.state, tx: o.tx_hash, block: o.block, creation: { from: o.from_addr, gasUsed: o.gas_used, effectiveGasPriceNativeAtomic: o.effective_gas_price }, paid: o.paid === null ? null : o.paid === 1, paidCheckedAt: o.paid_checked_at, note: o.note,
    checks, attempts, nextAction, createdAt: o.created_at, updatedAt: o.updated_at };
}
export const getOrderRow = (db: Db, orderId: string): OrderRow | undefined => row<OrderRow>(db, "SELECT * FROM orders WHERE order_id = ?", orderId.toLowerCase());
export const listOrderRows = (db: Db, owner: string, limit = 50): OrderRow[] => rows<OrderRow>(db, "SELECT * FROM orders WHERE owner = ? ORDER BY created_at DESC LIMIT ?", owner, limit);
