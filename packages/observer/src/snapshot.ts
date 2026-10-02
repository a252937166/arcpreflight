import type { PublicClient } from "viem";
import { Snapshot } from "@arcpreflight/schema";

/** Blocks behind head to pin at: the public RPC is load-balanced and a node that served `head` may not have the
 *  newest blocks on the next request (-32014); ~1 s blocks on Arc make a small lag cheap. Env PIN_LAG overrides. */
export const PIN_LAG: bigint = BigInt(process.env.PIN_LAG ?? "8");

/** Pin a block PIN_LAG blocks behind head and verify the EIP-1898 by-hash lookup returns the same number →
 *  pinningMode BLOCK_HASH (spec v1.4 §6.1). */
export async function captureSnapshot(client: PublicClient, opts: { providerId: string; blocksBehindHead?: bigint } ): Promise<Snapshot> {
  const chainId = await client.getChainId();
  if (chainId !== 5042 && chainId !== 5042002) throw new Error(`unexpected chainId ${chainId}; expected Arc 5042 or testnet 5042002`);
  const head = await client.getBlockNumber();
  const target = head - (opts.blocksBehindHead ?? PIN_LAG);
  const byNumber = await client.getBlock({ blockNumber: target });
  const byHash = await client.getBlock({ blockHash: byNumber.hash });
  if (byHash.number !== byNumber.number || byHash.hash !== byNumber.hash) {
    throw new Error("block hash lookup mismatch; refusing to pin");
  }
  return Snapshot.parse({
    chainId,
    blockNumber: byNumber.number.toString(),
    blockHash: byNumber.hash,
    observedAt: new Date().toISOString(),
    providerId: opts.providerId,
    pinningMode: "BLOCK_HASH",
  });
}
