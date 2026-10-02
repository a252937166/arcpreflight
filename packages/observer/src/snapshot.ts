import type { PublicClient } from "viem";
import { Snapshot } from "@arcpreflight/schema";

/** Pin a block a few blocks behind head (avoids -32014 on the load-balanced public RPC) and verify
 *  the EIP-1898 by-hash lookup returns the same number → pinningMode BLOCK_HASH (spec v1.4 §6.1). */
export async function captureSnapshot(client: PublicClient, opts: { providerId: string; blocksBehindHead?: bigint } ): Promise<Snapshot> {
  const chainId = await client.getChainId();
  if (chainId !== 5042) throw new Error(`unexpected chainId ${chainId}; expected Arc mainnet 5042`);
  const head = await client.getBlockNumber();
  const target = head - (opts.blocksBehindHead ?? 20n);
  const byNumber = await client.getBlock({ blockNumber: target });
  const byHash = await client.getBlock({ blockHash: byNumber.hash });
  if (byHash.number !== byNumber.number || byHash.hash !== byNumber.hash) {
    throw new Error("block hash lookup mismatch; refusing to pin");
  }
  return Snapshot.parse({
    chainId: 5042,
    blockNumber: byNumber.number.toString(),
    blockHash: byNumber.hash,
    observedAt: new Date().toISOString(),
    providerId: opts.providerId,
    pinningMode: "BLOCK_HASH",
  });
}
