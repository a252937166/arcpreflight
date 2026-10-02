import type { PublicClient, Hex } from "viem";
import { keccak256 } from "viem";
import type { Snapshot } from "@arcpreflight/schema";
import { makeEvidence, type RpcEvidence } from "./evidence.js";

export type Read<T> = { value: T; evidence: RpcEvidence; evidenceDigest: `0x${string}` };

const blockTag = (s: Snapshot) => ({ blockHash: s.blockHash as Hex });

export async function readCode(client: PublicClient, address: Hex, s: Snapshot): Promise<Read<{ code: Hex | null; codeHash: Hex | null; bytes: number }>> {
  const code = (await client.getCode({ address, ...blockTag(s) })) ?? null;
  const ev = makeEvidence("eth_getCode", [address, { blockHash: s.blockHash }], s, code, null);
  const value = code && code !== "0x" ? { code, codeHash: keccak256(code), bytes: (code.length - 2) / 2 } : { code: null, codeHash: null, bytes: 0 };
  return { value, evidence: ev.evidence, evidenceDigest: ev.digest };
}

export async function readSlot(client: PublicClient, address: Hex, slot: Hex, s: Snapshot): Promise<Read<Hex>> {
  const v = (await client.getStorageAt({ address, slot, ...blockTag(s) })) ?? ("0x" + "00".repeat(32)) as Hex;
  const ev = makeEvidence("eth_getStorageAt", [address, slot, { blockHash: s.blockHash }], s, v, null);
  return { value: v, evidence: ev.evidence, evidenceDigest: ev.digest };
}

export async function readCall(client: PublicClient, to: Hex, data: Hex, s: Snapshot, from?: Hex, valueNativeAtomic?: bigint): Promise<Read<{ ok: boolean; data: Hex | null; error: string | null }>> {
  try {
    const r = await client.call({ to, data, account: from, value: valueNativeAtomic, ...blockTag(s) });
    const out = (r.data ?? "0x") as Hex;
    const ev = makeEvidence("eth_call", [{ to, data, from: from ?? null, value: valueNativeAtomic?.toString() ?? null }, { blockHash: s.blockHash }], s, out, null);
    return { value: { ok: true, data: out, error: null }, evidence: ev.evidence, evidenceDigest: ev.digest };
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    const ev = makeEvidence("eth_call", [{ to, data, from: from ?? null, value: valueNativeAtomic?.toString() ?? null }, { blockHash: s.blockHash }], s, null, msg);
    return { value: { ok: false, data: null, error: msg }, evidence: ev.evidence, evidenceDigest: ev.digest };
  }
}

export const SLOTS = {
  erc1967Impl:   "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  erc1967Admin:  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  erc1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  zosImpl:       "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zosAdmin:      "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
} as const;

export const slotToAddress = (v: Hex): Hex | null => (BigInt(v) === 0n ? null : (("0x" + v.slice(-40)) as Hex));
