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
  return base64url(new TextEncoder().encode(JSON.stringify(envelope)));
}

export function decodeSellerProof(proof: string): { version: number; signature: Hex; network: string; payTo: Hex; nonce: Hex; issuedAt: number; expiresAt: number } {
  return JSON.parse(new TextDecoder().decode(fromBase64url(proof)));
}

// platform-neutral base64url (Node and browsers share btoa/atob)
function base64url(bytes: Uint8Array): string {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
