import type { Account, Hex } from "viem";
import { keccak256, toBytes, toHex } from "viem";
import { ARC, type ArcNet } from "./networks.js";

export const SELLER_REQUEST_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" }, { name: "method", type: "string" }, { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" }, { name: "payTo", type: "address" }, { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type ProofPurpose = "verify" | "settle" | "status";

/** Seller side (keyless trial): base64url envelope with an EIP-712 signature proving control of payTo and binding
 *  the request to purpose + method + body (docs: facilitator-service/sign-seller-proof). GET hashes empty bytes. */
export async function buildSellerProof(seller: Account, net: ArcNet, purpose: ProofPurpose, method: "GET" | "POST", body: string, ttlSeconds = 300): Promise<string> {
  if (!seller.signTypedData) throw new Error("seller account cannot sign typed data");
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const network = ARC[net].caip2;
  const signature = await seller.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: ARC[net].chainId },
    types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest",
    message: { purpose, method, bodyHash: keccak256(toBytes(body)), network, payTo: seller.address, nonce, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt) },
  });
  const envelope = { version: 1, signature, network, payTo: seller.address, nonce, issuedAt, expiresAt };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

export function decodeSellerProof(proof: string): { version: number; signature: Hex; network: string; payTo: Hex; nonce: Hex; issuedAt: number; expiresAt: number } {
  return JSON.parse(Buffer.from(proof, "base64url").toString("utf8"));
}
