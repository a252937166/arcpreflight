// Order identity before the send (design v3.3 §2): the reconciliation of a PLANNED or SENT order from the chain, shared by the API
// service and the reference CLI. Nothing here sends anything: an order that is not on chain after the window is closed
// UNKNOWN_CREATION and a new order is a new row; an order found on chain is CONFIRMED even when its creation hash was never recorded.
import type { Hex } from "viem";
import { GET_ORDER_ABI } from "./abi.js";

export type OrderRpc = {
  getTransactionReceipt(a: { hash: Hex }): Promise<any>;
  readContract(a: { address: Hex; abi: any; functionName: string; args: readonly unknown[] }): Promise<unknown>;
};
export type PlannedOrder = { orderId: Hex; merchant: Hex; txHash: Hex | null; createdAt: string };
export type OrderReconciliation =
  | { kind: "confirmed"; tx: Hex | null; block: string | null; from: Hex | null; gasUsed: string | null; effectiveGasPriceNativeAtomic: string | null; note: string }
  | { kind: "failed"; note: string }
  | { kind: "unknown"; note: string }
  | { kind: "pending" };
const ZERO = "0x0000000000000000000000000000000000000000";
export async function readChainOrder(rpc: OrderRpc, merchant: Hex, orderId: Hex): Promise<{ exists: boolean; payer: string; amount: bigint; paid: boolean }> {
  const ord = (await rpc.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] })) as readonly unknown[];
  const payer = String(ord[0]);
  return { exists: payer.toLowerCase() !== ZERO, payer, amount: BigInt(ord[1] as bigint | string), paid: ord[2] === true };
}
/** Receipt first (when a hash was recorded), then the chain's order state, then the window. Reads only. */
export async function reconcilePlannedOrder(rpc: OrderRpc, o: PlannedOrder, opts: { now?: Date; windowMs?: number } = {}): Promise<OrderReconciliation> {
  const nowMs = (opts.now ?? new Date()).getTime(); const windowMs = opts.windowMs ?? 10 * 60_000;
  if (o.txHash) {
    const rc = await rpc.getTransactionReceipt({ hash: o.txHash }).catch(() => null);
    if (rc) {
      const ok = rc.status === "success" || rc.status === "0x1" || rc.status === 1;
      if (ok) return { kind: "confirmed", tx: o.txHash, block: String(rc.blockNumber), from: (rc.from as Hex) ?? null, gasUsed: rc.gasUsed !== undefined && rc.gasUsed !== null ? String(rc.gasUsed) : null, effectiveGasPriceNativeAtomic: rc.effectiveGasPrice !== undefined && rc.effectiveGasPrice !== null ? String(rc.effectiveGasPrice) : null, note: "confirmed by reconciliation from the recorded creation hash" };
      return { kind: "failed", note: "the creation transaction reverted; the order does not exist on chain" };
    }
  }
  const chain = await readChainOrder(rpc, o.merchant, o.orderId);
  if (chain.exists) return { kind: "confirmed", tx: null, block: null, from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null, note: o.txHash ? "the order exists on chain; its receipt was not visible on this node" : "the order exists on chain although no creation hash was recorded (the process stopped between the send and the hash record)" };
  if (nowMs - new Date(o.createdAt).getTime() > windowMs) return { kind: "unknown", note: o.txHash ? "no receipt and no order on chain after the window; the creation is treated as not having happened — a new order is a new row" : "no creation hash was recorded and the order is not on chain after the window" };
  return { kind: "pending" };
}
