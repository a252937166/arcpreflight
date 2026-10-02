import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, parseAbi, verifyTypedData, keccak256, toBytes, hashTypedData } from "viem";
import { signTransferAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/eip3009.js";
import { buildSellerProof, decodeSellerProof, SELLER_REQUEST_TYPES } from "../src/sellerProof.js";
import { ARC, usdcDomain } from "../src/networks.js";
import { paymentIdentifier, buildSettleBody, classifySettle } from "../src/facilitator.js";

const buyer = privateKeyToAccount("0x" + "ab".repeat(32) as `0x${string}`); // throwaway test key
const seller = privateKeyToAccount("0x" + "cd".repeat(32) as `0x${string}`);

describe("USDC EIP-712 domain on Arc (read-only chain check)", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    it(`${net}: DOMAIN_SEPARATOR() matches name=USDC version=2 chainId=${ARC[net].chainId}`, async () => {
      const client = createPublicClient({ transport: http(ARC[net].rpc) });
      const onchain = await client.readContract({ address: ARC[net].usdc, abi: parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]), functionName: "DOMAIN_SEPARATOR" });
      const d = usdcDomain(net);
      const expected = keccak256(new Uint8Array([
        ...toBytes(keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))),
        ...toBytes(keccak256(toBytes(d.name))), ...toBytes(keccak256(toBytes(d.version))),
        ...toBytes(("0x" + d.chainId.toString(16).padStart(64, "0")) as `0x${string}`),
        ...toBytes(("0x" + d.verifyingContract.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`),
      ]));
      expect(onchain.toLowerCase()).toBe(expected.toLowerCase());
    });
  }
});

describe("EIP-3009 buyer authorization", () => {
  it("signature recovers to the buyer and binds payTo/value/nonce", async () => {
    const { signature, authorization } = await signTransferAuthorization(buyer, "testnet", { payTo: seller.address, valueTokenAtomic: 10000n });
    const ok = await verifyTypedData({ address: buyer.address, domain: usdcDomain("testnet"), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization",
      message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce }, signature });
    expect(ok).toBe(true);
    expect(authorization.value).toBe("10000"); // 0.01 USDC in 6-dec units
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("seller proof", () => {
  it("envelope decodes and signature recovers to payTo for the exact body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const proof = await buildSellerProof(seller, "testnet", "settle", "POST", body);
    const env = decodeSellerProof(proof);
    expect(env.payTo.toLowerCase()).toBe(seller.address.toLowerCase());
    expect(env.network).toBe("eip155:5042002");
    const ok = await verifyTypedData({ address: seller.address, domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: 5042002 }, types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest",
      message: { purpose: "settle", method: "POST", bodyHash: keccak256(toBytes(body)), network: env.network, payTo: env.payTo, nonce: env.nonce, issuedAt: BigInt(env.issuedAt), expiresAt: BigInt(env.expiresAt) }, signature: env.signature });
    expect(ok).toBe(true);
    expect(env.expiresAt - env.issuedAt).toBe(300);
  });
});

describe("settle body + classification", () => {
  it("payment identifier is 16–128 chars of the allowed alphabet", () => {
    expect(paymentIdentifier("r")).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(paymentIdentifier("x".repeat(500))).toHaveLength(128);
    expect(paymentIdentifier("a b/c")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("body carries exact scheme, Arc network, USDC asset, payTo and identifier", async () => {
    const { signature, authorization } = await signTransferAuthorization(buyer, "mainnet", { payTo: seller.address, valueTokenAtomic: 10000n });
    const body = buildSettleBody({ net: "mainnet", resource: { url: "https://x/preflight", description: "ArcPreflight check", mimeType: "application/json" }, payTo: seller.address, amountTokenAtomic: "10000", signature, authorization, paymentId: paymentIdentifier("req-0001") });
    expect(body.paymentRequirements.network).toBe("eip155:5042");
    expect(body.paymentRequirements.asset).toBe("0x3600000000000000000000000000000000000000");
    expect(body.paymentPayload.accepted.extra.assetTransferMethod).toBe("eip3009");
    expect(body.paymentPayload.extensions["payment-identifier"].info.id).toMatch(/^ap_req-0001_*$/);
    expect(body.paymentPayload.extensions["payment-identifier"].info.id.length).toBeGreaterThanOrEqual(16);
  });
  it("classifies success / pending / failure / rejected", () => {
    expect(classifySettle({ httpStatus: 200, json: { success: true, transaction: "0xabc" } }).state).toBe("COMPLETED");
    expect(classifySettle({ httpStatus: 200, json: { success: false, errorReason: "settlement_pending", extensions: { "settlement-status": { status: "pending", paymentId: "p1", statusUrl: "u" } } } })).toMatchObject({ state: "PENDING", paymentId: "p1" });
    expect(classifySettle({ httpStatus: 200, json: { success: false, errorReason: "insufficient_funds" } }).state).toBe("FAILED");
    expect(classifySettle({ httpStatus: 403, json: null }).state).toBe("REJECTED");
  });
});
