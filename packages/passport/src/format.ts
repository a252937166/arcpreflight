import { sha256, stringToBytes } from "viem";
import type { Hex } from "./types.js";

/** Exact decimal rendering of an atomic amount: no floating point, trailing zeros trimmed ("0.002178525", "0.05", "0"). */
export function formatAtomic(value: bigint | string | number, decimals: number): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n; const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = (a / base).toString();
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
export const formatNative = (v: bigint | string | number) => formatAtomic(v, 18);
export const formatToken = (v: bigint | string | number) => formatAtomic(v, 6);
/** 6-decimal token units of USDC expressed in 18-decimal native units (same asset, two precisions). */
export const tokenToNative = (tokenAtomic: bigint | string): bigint => BigInt(tokenAtomic) * 10n ** 12n;

/** Profile sha256-file-1.0: sha256 over the file's UTF-8 bytes. viem's implementation keeps this module browser-safe. */
export const sha256File = (content: string): Hex => sha256(stringToBytes(content));

/** JSON with bigints rendered as decimal strings (RPC captures, derived files). */
export const jsonSafe = <T = unknown>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
export const pretty = (v: unknown): string => JSON.stringify(jsonSafe(v), null, 2) + "\n";
