import { createPublicClient, http, BlockNotFoundError, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from "viem";
import type { VerifierRpc } from "./types.js";

const plain = <T = Record<string, unknown>>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
/** "Not found" is a fact (null); any other failure (timeout, pruned history, HTTP error) propagates so the verifier reports it as UNVERIFIED with the reason. */
const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch((e: unknown) => { if (e instanceof TransactionNotFoundError || e instanceof TransactionReceiptNotFoundError || e instanceof BlockNotFoundError) return null; throw e; });

/** A VerifierRpc over an explicitly configured Arc RPC URL. Reads only; nothing here can sign or send. */
export function rpcFromUrl(url: string, timeoutMs = 20_000): VerifierRpc {
  const client = createPublicClient({ transport: http(url, { timeout: timeoutMs }) });
  return {
    getChainId: () => client.getChainId(),
    getTransaction: (hash) => orNull(client.getTransaction({ hash }).then(plain)),
    getTransactionReceipt: (hash) => orNull(client.getTransactionReceipt({ hash }).then(plain)),
    getBlock: (blockHash) => orNull(client.getBlock({ blockHash }).then(plain)),
    // raw eth_call so the EIP-1898 block-hash pin is exactly what goes over the wire
    call: (a) => client.request({ method: "eth_call", params: [{ to: a.to, data: a.data }, { blockHash: a.blockHash }] }) as Promise<Hex>,
  };
}
