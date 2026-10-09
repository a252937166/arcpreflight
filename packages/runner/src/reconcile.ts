// Business-transaction reconciliation from the ORIGINAL context (spec D07, design v3.2 §11). One implementation for the API
// and the CLI. It never signs a replacement, never creates an order, never buys a check. The order is the business fact:
// a receipt alone is not business success, and "our hash was never mined" is not "the order is unpaid" — a same-nonce
// replacement may have paid the same order, so the consuming transaction is identified where the node allows it.
import type { Hex } from "viem";
import { GET_ORDER_ABI, ORDER_PAID_TOPIC } from "./abi.js";
import type { ExecutionOutcome } from "./index.js";

/** The slice of chain access reconciliation uses. A viem PublicClient satisfies it; tests inject a fake. */
export type ReconcileRpc = {
  getTransactionReceipt(a: { hash: Hex }): Promise<any>;
  getTransaction(a: { hash: Hex }): Promise<any>;
  getTransactionCount(a: { address: Hex; blockTag?: "latest" | "pending"; blockNumber?: bigint }): Promise<number>;
  readContract(a: { address: Hex; abi: any; functionName: string; args: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  getBlock(a: { blockNumber: bigint; includeTransactions?: boolean }): Promise<any>;
  getBlockNumber(): Promise<bigint>;
  sendRawTransaction(a: { serializedTransaction: Hex }): Promise<Hex>;
};

/** Adapts a viem PublicClient (whose parameter types are discriminated unions) to the narrow ReconcileRpc surface. */
export function reconcileRpcFromClient(client: { getTransactionReceipt: Function; getTransaction: Function; getTransactionCount: Function; readContract: Function; getBlock: Function; getBlockNumber: Function; sendRawTransaction: Function }): ReconcileRpc {
  return {
    getTransactionReceipt: (a) => client.getTransactionReceipt(a), getTransaction: (a) => client.getTransaction(a), getTransactionCount: (a) => client.getTransactionCount(a),
    readContract: (a) => client.readContract(a), getBlock: (a) => client.getBlock(a), getBlockNumber: () => client.getBlockNumber(), sendRawTransaction: (a) => client.sendRawTransaction(a),
  };
}

/** A persisted business transaction as the store hands it back (raw bytes stay encrypted until `openRaw` is called). */
export type StoredExecution = {
  attemptId: string; state: "SIGNED" | "BROADCAST_ATTEMPTED";
  txHash: Hex; nonce: number; payer: Hex; merchant: Hex; orderId: Hex; amountNativeAtomic: string;
  validUntil: string; broadcastBlock: string | null;
  openRaw: () => Promise<Hex>;
};
export type ReconcileClosedState = "INTERRUPTED" | "CONFIRMED" | "REVERTED" | "NOT_MINED" | "SUPERSEDED";
export type ReconcileResult =
  | { kind: "closed"; storeState: ReconcileClosedState; outcome: ExecutionOutcome; consumedBy: Hex | null }
  | { kind: "pending"; reason: string; rebroadcast: boolean };
export type ReconcileOptions = {
  /** false for read routes and other observers: never rebroadcast; true only for the recovery worker and authorized recovery commands */
  allowSend: boolean;
  /** a fixed reference time (tests); `clock` is consulted for the fresh reads */
  now?: Date;
  /** the clock read again immediately before any send, after every await (review of `0c0d406`, P1-3); defaults to the wall clock */
  clock?: () => Date;
  /** how far back the nonce-consumer search may look when no broadcast block is known */
  maxSearchBlocks?: number;
};

type OrderState = { payer: string; amount: bigint; paid: boolean };
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isSuccess = (rc: any) => rc?.status === "success" || rc?.status === "0x1" || rc?.status === 1;
const pending = (reason: string, rebroadcast = false): ReconcileResult => ({ kind: "pending", reason, rebroadcast });

async function readOrder(rpc: ReconcileRpc, x: StoredExecution, blockNumber?: bigint): Promise<OrderState> {
  const ord = (await rpc.readContract({ address: x.merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [x.orderId], ...(blockNumber === undefined ? {} : { blockNumber }) })) as readonly unknown[];
  return { payer: String(ord[0]), amount: BigInt(ord[1] as bigint | string), paid: ord[2] === true };
}

/** Receipt + order state at the receipt's block → outcome. Receipt success is not business success. */
export async function outcomeFromReceipt(rpc: ReconcileRpc, x: Pick<StoredExecution, "merchant" | "orderId" | "payer" | "amountNativeAtomic">, txHash: Hex, rc: any): Promise<ExecutionOutcome> {
  const success = isSuccess(rc);
  const block = BigInt(rc.blockNumber);
  const ord = await readOrder(rpc, x as StoredExecution, block);
  const paidOk = success && ord.paid && same(ord.payer, x.payer) && ord.amount === BigInt(x.amountNativeAtomic);
  const postcondition = { orderId: x.orderId, paid: ord.paid, payer: ord.payer, amountNativeAtomic: ord.amount.toString(), block: block.toString(), receiptStatus: success ? "success" : "reverted" };
  const receiptFacts = { from: (rc.from as Hex | undefined) ?? null, gasUsed: rc.gasUsed !== undefined && rc.gasUsed !== null ? String(rc.gasUsed) : null, effectiveGasPriceNativeAtomic: rc.effectiveGasPrice !== undefined && rc.effectiveGasPrice !== null ? String(rc.effectiveGasPrice) : null, blockNumber: block.toString(), status: success ? "success" : "reverted" };
  return { chainStatus: success ? "CONFIRMED" : "REVERTED", businessStatus: paidOk ? "SUCCESS" : "FAILED", businessTxHash: txHash, block: block.toString(), postcondition, receiptFacts, note: "reconciled from the original transaction hash and the order state" };
}

/** True when the receipt's logs carry OrderPaid(orderId, …) emitted by the merchant. */
export function paysThisOrder(rc: any, x: Pick<StoredExecution, "merchant" | "orderId">): boolean {
  return (rc?.logs ?? []).some((l: any) => same(l.address, x.merchant) && same(l.topics?.[0], ORDER_PAID_TOPIC) && same(l.topics?.[1], x.orderId));
}

/** The transaction that consumed `x.nonce` from `x.payer`, found by a bounded binary search over eth_getTransactionCount at
 *  block numbers (an account transaction count alone names no transaction; the block that raised it does). Returns null when
 *  the node cannot serve the history or the window is exhausted — callers must then say "unidentified", never guess. */
/** The chain reads the nonce search needs (also used for order creations, which have no StoredExecution). */
export type NonceSearchRpc = Pick<ReconcileRpc, "getBlockNumber" | "getTransactionCount" | "getBlock">;
export async function findNonceConsumer(rpc: NonceSearchRpc, x: Pick<StoredExecution, "payer" | "nonce" | "broadcastBlock">, maxSearchBlocks = 20_000): Promise<{ hash: Hex; block: bigint } | null> {
  const head = await rpc.getBlockNumber();
  const countAt = (b: bigint) => rpc.getTransactionCount({ address: x.payer, blockNumber: b });
  if ((await countAt(head)) <= x.nonce) return null;
  const floor = head > BigInt(maxSearchBlocks) ? head - BigInt(maxSearchBlocks) : 0n;
  let lo = x.broadcastBlock !== null ? BigInt(x.broadcastBlock) - 2n : floor;
  if (lo < floor) lo = floor;
  // the nonce may have been consumed before the recorded broadcast block (a replacement sent earlier): widen backwards, bounded
  for (let i = 0; lo > floor && (await countAt(lo)) > x.nonce; i++) { if (i >= 8) return null; const span = head - lo; lo = lo - (span > 64n ? span : 64n); if (lo < floor) lo = floor; }
  if ((await countAt(lo)) > x.nonce) return null; // consumed before the search window: outside what this search may establish
  let hi = head;
  while (lo < hi) { const mid = (lo + hi) / 2n; if ((await countAt(mid)) > x.nonce) hi = mid; else lo = mid + 1n; }
  const block = await rpc.getBlock({ blockNumber: lo, includeTransactions: true });
  const tx = (block?.transactions ?? []).find((t: any) => t && typeof t === "object" && same(t.from, x.payer) && Number(t.nonce) === x.nonce);
  return tx ? { hash: tx.hash as Hex, block: lo } : null;
}

/** Resolve one persisted business transaction. Order of evidence: broadcast marker → receipt → order state → nonce → pool. */
export async function reconcileExecution(rpc: ReconcileRpc, x: StoredExecution, opts: ReconcileOptions): Promise<ReconcileResult> {
  const clock = opts.clock ?? (opts.now ? () => opts.now! : () => new Date());
  if (x.state === "SIGNED") { // the broadcast marker was never written: nothing reached the network
    return { kind: "closed", storeState: "INTERRUPTED", consumedBy: null, outcome: { chainStatus: "SIGNED_NOT_BROADCAST", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "interrupted after signing and before any broadcast; nothing reached the network; the order stays unpaid" } };
  }
  const rc = await rpc.getTransactionReceipt({ hash: x.txHash }).catch(() => null);
  if (rc) {
    const outcome = await outcomeFromReceipt(rpc, x, x.txHash, rc);
    return { kind: "closed", storeState: outcome.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED", consumedBy: null, outcome };
  }
  let ord: OrderState;
  try { ord = await readOrder(rpc, x); } catch { return pending("order state unreadable on this node; nothing is concluded"); }
  const latest = await rpc.getTransactionCount({ address: x.payer, blockTag: "latest" });
  const consumed = latest > x.nonce;
  if (ord.paid) {
    if (!consumed) return pending("the order reads as paid but the receipt is not visible on this node yet; retry later");
    const by = await findNonceConsumer(rpc, x, opts.maxSearchBlocks).catch(() => null);
    if (!by) return pending("the order reads as paid; the transaction that consumed the signer nonce could not be identified within the search window; manual reconciliation required");
    const byRc = await rpc.getTransactionReceipt({ hash: by.hash }).catch(() => null);
    if (same(by.hash, x.txHash)) { // the consumer is OUR transaction: the first receipt read lagged; close from this receipt or wait for it
      if (!byRc) return pending(`block ${by.block} contains this transaction but its receipt is not visible on this node yet; retry later`);
      const outcome = await outcomeFromReceipt(rpc, x, x.txHash, byRc);
      return { kind: "closed", storeState: outcome.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED", consumedBy: null, outcome };
    }
    if (byRc && paysThisOrder(byRc, x)) {
      const o = await outcomeFromReceipt(rpc, x, by.hash, byRc);
      return { kind: "closed", storeState: "SUPERSEDED", consumedBy: by.hash, outcome: { ...o, chainStatus: "UNKNOWN", note: `the original hash was never mined; the order was paid by transaction ${by.hash}, which consumed the same signer nonce; nothing was re-signed by this runner` } };
    }
    return pending(`the order reads as paid but the transaction that consumed this nonce (${by.hash}) does not pay it; manual reconciliation required`);
  }
  if (consumed) {
    // A consumed nonce alone proves nothing about THIS hash: on a load-balanced RPC the receipt and the order read may lag behind the
    // node that answered the nonce query (observed on Arc testnet 2026-10-08). NOT_MINED is concluded only from an identified consuming
    // transaction whose receipt is visible and does not pay this order; anything less stays pending.
    const by = await findNonceConsumer(rpc, x, opts.maxSearchBlocks).catch(() => null);
    if (!by) return pending("the signer nonce appears consumed but the consuming transaction could not be identified within the search window (a lagging or load-balanced node may be the cause); nothing is concluded and nothing is re-signed");
    if (same(by.hash, x.txHash)) { // our own transaction is in a block; the receipt was not visible on the node that answered: re-fetch once, else wait
      const rc2 = await rpc.getTransactionReceipt({ hash: x.txHash }).catch(() => null);
      if (rc2) { const outcome = await outcomeFromReceipt(rpc, x, x.txHash, rc2); return { kind: "closed", storeState: outcome.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED", consumedBy: null, outcome }; }
      return pending(`block ${by.block} contains this transaction but its receipt is not visible on this node yet; retry later`);
    }
    const byRc = await rpc.getTransactionReceipt({ hash: by.hash }).catch(() => null);
    if (!byRc) return pending(`the signer nonce was consumed by transaction ${by.hash}, whose receipt is not visible on this node yet; nothing is concluded`);
    if (paysThisOrder(byRc, x)) { // the latest order read lagged: a same-nonce replacement paid this order — confirmed by the order state at the receipt's block
      const o = await outcomeFromReceipt(rpc, x, by.hash, byRc);
      if (o.businessStatus !== "SUCCESS") return pending(`transaction ${by.hash} carries OrderPaid for this order but the order state read at its block does not agree; the node is inconsistent; retry later`);
      return { kind: "closed", storeState: "SUPERSEDED", consumedBy: by.hash, outcome: { ...o, chainStatus: "UNKNOWN", note: `the original hash was never mined; the order was paid by transaction ${by.hash}, which consumed the same signer nonce; nothing was re-signed by this runner` } };
    }
    return { kind: "closed", storeState: "NOT_MINED", consumedBy: by.hash, outcome: { chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED", businessTxHash: null,
      note: `the signer nonce was consumed by transaction ${by.hash}, which does not pay this order; this hash can never be mined; the order reads as unpaid; nothing is re-signed` } };
  }
  if (await rpc.getTransaction({ hash: x.txHash }).catch(() => null)) return pending("still in the transaction pool");
  // P1-3: the window is judged by a clock read NOW — after the receipt, order, nonce and pool reads above — never by a time captured before them
  if (new Date(x.validUntil) > clock()) { // dropped but still inside its validation window: only the IDENTICAL bytes may be re-broadcast, and only by an authorized sender
    if (!opts.allowSend) return pending("dropped from the pool inside its validation window; the recovery worker may rebroadcast the identical signed bytes");
    const raw = await x.openRaw();
    if (new Date(x.validUntil) <= clock()) return pending("dropped after its validation window (it closed during the reads or the decryption, before any send); waiting for the nonce to be consumed before closing (no replacement is signed)"); // read once more after the last await before the send
    await rpc.sendRawTransaction({ serializedTransaction: raw }).catch(() => {});
    return pending("rebroadcast the identical signed bytes inside the validation window", true);
  }
  return pending("dropped after its validation window; waiting for the nonce to be consumed before closing (no replacement is signed)");
}
