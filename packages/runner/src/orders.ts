// Order identity before the send (design v3.3 §2): the reconciliation of a PLANNED or SENT order from the chain, shared by the API
// service and the reference CLI. An order found on chain is CONFIRMED even when its creation hash was never recorded. A SENT order whose
// signed creation was recorded (raw bytes, nonce, signer) is re-sent with the IDENTICAL bytes while its window is open — when the caller
// allows sending (the worker, an explicit recover; never a plain read) — because the node may have refused the first call; it has one
// hash and one nonce, so it can never create twice. A creation nonce consumed by an identified OTHER transaction means this order was
// never created (FAILED). Nothing here signs anything; an order not on chain after the window is closed UNKNOWN_CREATION (a new order is a new row).
import type { Hex } from "viem";
import { GET_ORDER_ABI } from "./abi.js";
import { sendIdentical, type RawSender } from "./send.js";
import { findNonceConsumer, type NonceSearchRpc } from "./reconcile.js";

export type OrderRpc = {
  getTransactionReceipt(a: { hash: Hex }): Promise<any>;
  readContract(a: { address: Hex; abi: any; functionName: string; args: readonly unknown[] }): Promise<unknown>;
  /** optional: needed to tell "the creation nonce is still free" from "it was consumed" (a viem PublicClient has all of these) */
  getTransactionCount?(a: { address: Hex; blockTag?: "latest" | "pending"; blockNumber?: bigint }): Promise<number>;
  getTransaction?(a: { hash: Hex }): Promise<any>;
  getBlock?(a: { blockNumber: bigint; includeTransactions?: boolean }): Promise<any>;
  getBlockNumber?(): Promise<bigint>;
};
/** `raw`, `nonce`, `from`: the signed creation transaction as recorded before its broadcast (absent for rows written by older releases) */
export type PlannedOrder = { orderId: Hex; merchant: Hex; txHash: Hex | null; createdAt: string; raw?: Hex | null; nonce?: number | null; from?: Hex | null };
export type OrderReconciliation =
  | { kind: "confirmed"; tx: Hex | null; block: string | null; from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; note: string }
  | { kind: "failed"; note: string }
  | { kind: "unknown"; note: string }
  | { kind: "pending"; note?: string; resent?: boolean };
/** `send`: present only where re-sending is allowed (the worker, an explicit recover) — a read route passes nothing and never sends */
export type OrderReconcileOptions = { now?: Date; windowMs?: number; send?: RawSender | null; maxSearchBlocks?: number };
const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
export async function readChainOrder(rpc: OrderRpc, merchant: Hex, orderId: Hex): Promise<{ exists: boolean; payer: string; amount: bigint; paid: boolean }> {
  const ord = (await rpc.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] })) as readonly unknown[];
  const payer = String(ord[0]);
  return { exists: payer.toLowerCase() !== ZERO, payer, amount: BigInt(ord[1] as bigint | string), paid: ord[2] === true };
}
const fromReceipt = (o: PlannedOrder, rc: any): OrderReconciliation => {
  const ok = rc.status === "success" || rc.status === "0x1" || rc.status === 1;
  if (!ok) return { kind: "failed", note: "the creation transaction reverted; the order does not exist on chain" };
  return { kind: "confirmed", tx: o.txHash, block: String(rc.blockNumber), from: (rc.from as Hex) ?? null, gasUsed: rc.gasUsed !== undefined && rc.gasUsed !== null ? String(rc.gasUsed) : null, effectiveGasPriceNativeAtomic: rc.effectiveGasPrice !== undefined && rc.effectiveGasPrice !== null ? String(rc.effectiveGasPrice) : null, note: "confirmed by reconciliation from the creation transaction's receipt" };
};
/** Receipt first (when a hash was recorded), then the chain's order state, then the creation nonce, then the window. */
export async function reconcilePlannedOrder(rpc: OrderRpc, o: PlannedOrder, opts: OrderReconcileOptions = {}): Promise<OrderReconciliation> {
  const nowMs = (opts.now ?? new Date()).getTime(); const windowMs = opts.windowMs ?? 10 * 60_000;
  const inWindow = nowMs - new Date(o.createdAt).getTime() <= windowMs;
  if (o.txHash) {
    const rc = await rpc.getTransactionReceipt({ hash: o.txHash }).catch(() => null);
    if (rc) return fromReceipt(o, rc);
  }
  const chain = await readChainOrder(rpc, o.merchant, o.orderId);
  if (chain.exists) return { kind: "confirmed", tx: null, block: null, from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null, note: o.txHash ? "the order exists on chain; its receipt was not visible on this node" : "the order exists on chain although no creation hash was recorded" };
  // a recorded signed creation: is its nonce still free (re-send the same bytes) or consumed (by it, or by another transaction)?
  if (o.txHash && o.raw && o.from && typeof o.nonce === "number" && rpc.getTransactionCount) {
    const latest = await rpc.getTransactionCount({ address: o.from, blockTag: "latest" });
    if (latest > o.nonce) {
      const rc2 = await rpc.getTransactionReceipt({ hash: o.txHash }).catch(() => null); // a lagging node may have hidden it the first time
      if (rc2) return fromReceipt(o, rc2);
      const by = rpc.getBlock && rpc.getBlockNumber
        ? await findNonceConsumer(rpc as NonceSearchRpc, { payer: o.from, nonce: o.nonce, broadcastBlock: null }, opts.maxSearchBlocks).catch(() => null) : null;
      if (by && !same(by.hash, o.txHash)) { // another transaction holds the nonce: these signed bytes can never be mined
        const again = await readChainOrder(rpc, o.merchant, o.orderId);
        if (again.exists) return { kind: "confirmed", tx: null, block: null, from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null, note: `the order exists on chain; the recorded creation nonce was consumed by transaction ${by.hash}` };
        return { kind: "failed", note: `the creation nonce was consumed by another transaction (${by.hash}); this order was never created — nothing is re-signed; a new order is a new row` };
      }
      const why = by ? `block ${by.block} contains this creation transaction, but neither its receipt nor the order is visible on this node` : "the creation nonce is consumed by a transaction this node could not identify";
      if (inWindow) return { kind: "pending", note: `${why}; nothing is concluded yet` };
      return { kind: "unknown", note: `${why}; after the window the creation is treated as not having happened — a new order is a new row` };
    }
    const inPool = rpc.getTransaction ? await rpc.getTransaction({ hash: o.txHash }).catch(() => null) : null;
    if (inPool) return { kind: "pending", note: "the creation transaction is known to the node; waiting for its receipt" };
    if (inWindow && opts.send) { // the nonce is free and the node does not hold it: hand it the SAME bytes again (one hash, one nonce)
      const { accepted, sendError } = await sendIdentical(opts.send, o.raw, () => true);
      return { kind: "pending", resent: accepted, note: accepted ? "the identical signed creation was handed to the node again; waiting for its receipt" : `the node did not take the identical signed creation (${sendError ?? "no answer"}); it is retried while the window is open` };
    }
  }
  if (!inWindow) return { kind: "unknown", note: o.txHash ? "no receipt and no order on chain after the window; the creation is treated as not having happened — a new order is a new row" : "no creation hash was recorded and the order is not on chain after the window" };
  return { kind: "pending" };
}
