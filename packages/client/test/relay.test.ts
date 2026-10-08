import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeFunctionData, encodeErrorResult, toHex, type Hex } from "viem";
import { signTransferAuthorization } from "../src/eip3009.js";
import { ARC } from "../src/networks.js";
import { FIAT_TOKEN_EIP3009_ABI, EIP3009_CALL_ABI, AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC, addressTopic, encodeTransferWithAuthorization, verifyTransferAuthorization, findSettlementInLogs, decodeRevertReason, authorizationCallMatches } from "../src/relay.js";

const buyer = privateKeyToAccount("0x" + "ab".repeat(32) as Hex); // throwaway test keys
const seller = privateKeyToAccount("0x" + "cd".repeat(32) as Hex);
const USDC = ARC.testnet.usdc;
const TX = "0x" + "77".repeat(32);
const authorized = () => signTransferAuthorization(buyer, "testnet", { payTo: seller.address, valueTokenAtomic: 10000n });
const log = (topics: string[], data = "0x", extra: Record<string, unknown> = {}) => ({ address: USDC, topics, data, logIndex: 0, transactionHash: TX, blockNumber: 100n, ...extra });
const usedLog = (nonce: Hex, extra = {}) => log([AUTHORIZATION_USED_TOPIC, addressTopic(buyer.address), nonce], "0x", { logIndex: 3, ...extra });
const transferLog = (value = 10000n, extra = {}) => log([TRANSFER_TOPIC, addressTopic(buyer.address), addressTopic(seller.address)], toHex(value, { size: 32 }), { logIndex: 4, ...extra });

describe("self-relayed EIP-3009 helpers", () => {
  it("encodes transferWithAuthorization with the signature split into v, r, s", async () => {
    const { signature, authorization } = await authorized();
    const data = encodeTransferWithAuthorization(authorization, signature);
    expect(data.slice(0, 10)).toBe("0xe3ee160e");
    const decoded = decodeFunctionData({ abi: FIAT_TOKEN_EIP3009_ABI, data });
    expect(decoded.functionName).toBe("transferWithAuthorization");
    expect(decoded.args?.slice(0, 6)).toEqual([buyer.address, seller.address, 10000n, 0n, BigInt(authorization.validBefore), authorization.nonce]);
    expect([27, 28]).toContain(decoded.args?.[6]);
  });
  it("verifies that the authorization signature recovers to the payer, and rejects forgeries", async () => {
    const { signature, authorization } = await authorized();
    expect(await verifyTransferAuthorization("testnet", authorization, signature)).toEqual({ ok: true });
    expect(await verifyTransferAuthorization("testnet", { ...authorization, value: "20000" }, signature)).toMatchObject({ ok: false });
    expect(await verifyTransferAuthorization("mainnet", authorization, signature)).toMatchObject({ ok: false }); // other chain domain
    expect(await verifyTransferAuthorization("testnet", authorization, "0x1234" as Hex)).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
  });
  it("accepts settlement only when AuthorizationUsed and the exact Transfer appear in the same transaction", async () => {
    const { authorization } = await authorized();
    const x = { usdc: USDC, from: buyer.address, to: seller.address, value: 10000n, nonce: authorization.nonce };
    const both = findSettlementInLogs([usedLog(authorization.nonce), transferLog()], x);
    expect(both).toMatchObject({ transactionHash: TX, blockNumber: "100", authorizationUsedLogIndex: 3, transferLogIndex: 4, value: "10000" });
    expect(findSettlementInLogs([transferLog()], x)).toBeNull(); // transfer without the authorization event
    expect(findSettlementInLogs([usedLog(authorization.nonce)], x)).toBeNull(); // authorization consumed, no transfer (cancellation shape)
    expect(findSettlementInLogs([usedLog(authorization.nonce), transferLog(9999n)], x)).toBeNull(); // wrong amount
    expect(findSettlementInLogs([usedLog(authorization.nonce), transferLog(10000n, { address: "0x" + "99".repeat(20) })], x)).toBeNull(); // not the USDC contract
    expect(findSettlementInLogs([usedLog(authorization.nonce), transferLog(10000n, { transactionHash: "0x" + "88".repeat(32) })], x)).toBeNull(); // different transactions
    const raw = findSettlementInLogs([{ ...usedLog(authorization.nonce), transactionHash: null, logIndex: "0x3", blockNumber: "0x64" }, { ...transferLog(), transactionHash: null, logIndex: "0x4" }], x, TX);
    expect(raw).toMatchObject({ transactionHash: TX, blockNumber: "0x64", authorizationUsedLogIndex: 3, transferLogIndex: 4 }); // raw eth_getLogs shapes
  });
  it("decodes Error(string) revert data and tags anything else", () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: ["FiatTokenV2: authorization is used or canceled"] });
    expect(decodeRevertReason(data)).toBe("FiatTokenV2: authorization is used or canceled");
    expect(decodeRevertReason("0x")).toBeNull();
    expect(decodeRevertReason("0xdeadbeef")).toMatch(/^revert data 0xdeadbeef/);
  });
  it("recognises only a direct USDC call that consumes exactly this authorization (all four entry points), never a wrapper or other arguments", async () => {
    const { signature, authorization } = await authorized();
    expect(authorizationCallMatches(encodeTransferWithAuthorization(authorization, signature), authorization)).toBe(true);
    const receive = encodeFunctionData({ abi: EIP3009_CALL_ABI, functionName: "receiveWithAuthorization", args: [authorization.from, authorization.to, 10000n, 0n, BigInt(authorization.validBefore), authorization.nonce, signature] });
    expect(authorizationCallMatches(receive, authorization)).toBe(true);
    expect(authorizationCallMatches(encodeTransferWithAuthorization({ ...authorization, value: "9999" }, signature), authorization)).toBe(false);
    expect(authorizationCallMatches(encodeTransferWithAuthorization({ ...authorization, nonce: `0x${"33".repeat(32)}` }, signature), authorization)).toBe(false);
    expect(authorizationCallMatches("0xdeadbeef", authorization)).toBe(false);
    expect(authorizationCallMatches("0x", authorization)).toBe(false);
    expect(authorizationCallMatches(null, authorization)).toBe(false);
  });
});
