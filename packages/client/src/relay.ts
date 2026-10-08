import { encodeFunctionData, decodeFunctionData, parseSignature, recoverTypedDataAddress, keccak256, toHex, decodeErrorResult, getAddress, isAddressEqual, type Hex } from "viem";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, type Eip3009Authorization } from "./eip3009.js";
import { usdcDomain, type ArcNet } from "./networks.js";

/** FiatToken v2 (Arc USDC at 0x3600…0000): the EIP-3009 surface a self-hosted relayer needs. Pure helpers only; no I/O. */
export const FIAT_TOKEN_EIP3009_ABI = [
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "AuthorizationUsed", inputs: [{ name: "authorizer", type: "address", indexed: true }, { name: "nonce", type: "bytes32", indexed: true }] },
  { type: "event", name: "AuthorizationCanceled", inputs: [{ name: "authorizer", type: "address", indexed: true }, { name: "nonce", type: "bytes32", indexed: true }] },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
] as const;

export const AUTHORIZATION_USED_TOPIC = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
export const AUTHORIZATION_CANCELED_TOPIC = keccak256(toHex("AuthorizationCanceled(address,bytes32)"));
export const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
export const addressTopic = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

export type SettlementExpectation = { usdc: Hex; from: Hex; to: Hex; value: bigint; nonce: Hex };
/** What "paid" means: one transaction whose USDC logs carry BOTH AuthorizationUsed(from, nonce) and Transfer(from → to, value). */
export type SettlementEvidence = { transactionHash: Hex; blockNumber: string; authorizationUsedLogIndex: number; transferLogIndex: number; from: Hex; to: Hex; value: string; nonce: Hex };
export type LogLike = { address: string; topics: readonly string[]; data: string; logIndex?: number | string | null; transactionHash?: string | null; blockNumber?: bigint | number | string | null };

/** Local replacement for a facilitator's /verify: the typed-data signature must recover to the payer. */
export async function verifyTransferAuthorization(net: ArcNet, a: Eip3009Authorization, signature: Hex): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const recovered = await recoverTypedDataAddress({ domain: usdcDomain(net), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", signature,
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
    return isAddressEqual(recovered, a.from) ? { ok: true } : { ok: false, reason: `signature recovers to ${recovered}, not the payer` };
  } catch (e: any) { return { ok: false, reason: `malformed signature: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)}` }; }
}

/** calldata for USDC.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s) */
export function encodeTransferWithAuthorization(a: Eip3009Authorization, signature: Hex): Hex {
  const sig = parseSignature(signature);
  const v = sig.v ?? (sig.yParity === undefined ? undefined : BigInt(sig.yParity) + 27n);
  if (v === undefined) throw new Error("signature lacks v / yParity");
  return encodeFunctionData({ abi: FIAT_TOKEN_EIP3009_ABI, functionName: "transferWithAuthorization",
    args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v), sig.r, sig.s] });
}

/** Finds proof of settlement in receipt logs or in raw eth_getLogs output. The `authorizationState` boolean is NOT proof: a
 *  cancellation sets it too, and a transfer by another broadcaster is still a payment. Both logs must come from the USDC contract
 *  in the same transaction. `defaultTx` names the transaction when the logs lack transactionHash (receipt logs carry it). */
export function findSettlementInLogs(logs: readonly LogLike[], x: SettlementExpectation, defaultTx?: string | null): SettlementEvidence | null {
  const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  const groups = new Map<string, LogLike[]>();
  for (const l of logs) { const k = (l.transactionHash ?? defaultTx ?? "").toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(l); }
  for (const [tx, group] of groups) {
    if (!tx) continue;
    const used = group.find((l) => same(l.address, x.usdc) && same(l.topics[0], AUTHORIZATION_USED_TOPIC) && same(l.topics[1], addressTopic(x.from)) && same(l.topics[2], x.nonce));
    const transfer = group.find((l) => same(l.address, x.usdc) && same(l.topics[0], TRANSFER_TOPIC) && same(l.topics[1], addressTopic(x.from)) && same(l.topics[2], addressTopic(x.to)) && l.data !== "0x" && BigInt(l.data) === x.value);
    if (used && transfer) {
      return { transactionHash: tx as Hex, blockNumber: String(used.blockNumber ?? transfer.blockNumber ?? ""), authorizationUsedLogIndex: Number(used.logIndex ?? -1), transferLogIndex: Number(transfer.logIndex ?? -1),
        from: x.from, to: x.to, value: x.value.toString(), nonce: x.nonce };
    }
  }
  return null;
}

/** The four USDC entry points that consume an EIP-3009 authorization directly. */
export const EIP3009_CALL_ABI = [
  FIAT_TOKEN_EIP3009_ABI[0],
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "signature", type: "bytes" }] },
  { type: "function", name: "receiveWithAuthorization", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
  { type: "function", name: "receiveWithAuthorization", stateMutability: "nonpayable", outputs: [],
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "signature", type: "bytes" }] },
] as const;

/** True only when `input` is a DIRECT USDC call consuming exactly this authorization (any of the four entry points, every field equal).
 *  Wrappers, routers and mismatched arguments never match: such executions stay pending for manual reconciliation. */
export function authorizationCallMatches(input: string | null | undefined, a: Eip3009Authorization): boolean {
  if (!input || input.length < 10) return false;
  try {
    const d = decodeFunctionData({ abi: EIP3009_CALL_ABI, data: input as Hex });
    const [from, to, value, validAfter, validBefore, nonce] = d.args as unknown as [string, string, bigint, bigint, bigint, string];
    return isAddressEqual(from as Hex, a.from) && isAddressEqual(to as Hex, a.to) && value === BigInt(a.value) && validAfter === BigInt(a.validAfter) && validBefore === BigInt(a.validBefore) && nonce.toLowerCase() === a.nonce.toLowerCase();
  } catch { return false; }
}

/** Error(string) revert data → text; anything else → a short hex tag. */
export function decodeRevertReason(data?: string | null): string | null {
  if (!data || data === "0x") return null;
  try { const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], data: data as Hex }); return String(d.args?.[0] ?? d.errorName); }
  catch { return `revert data ${data.slice(0, 18)}…`; }
}
