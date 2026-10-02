import type { Account, Hex } from "viem";
import { toHex } from "viem";
import { usdcDomain, type ArcNet } from "./networks.js";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Eip3009Authorization = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };

/** Buyer side: sign an EIP-3009 TransferWithAuthorization for exactly `valueTokenAtomic` (6-dec USDC units)
 *  to `payTo`. The nonce is random 32 bytes; validBefore defaults to now+1h. One authorization = one quote (spec §8.5). */
export async function signTransferAuthorization(
  buyer: Account, net: ArcNet, params: { payTo: Hex; valueTokenAtomic: bigint; validBeforeSeconds?: number; nonce?: Hex },
): Promise<{ signature: Hex; authorization: Eip3009Authorization }> {
  if (!buyer.signTypedData) throw new Error("account cannot sign typed data");
  const nonce = params.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (params.validBeforeSeconds ?? 3600));
  const message = { from: buyer.address, to: params.payTo, value: params.valueTokenAtomic, validAfter: 0n, validBefore, nonce };
  const signature = await buyer.signTypedData({ domain: usdcDomain(net), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message });
  return {
    signature,
    authorization: { from: buyer.address, to: params.payTo, value: params.valueTokenAtomic.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce },
  };
}
