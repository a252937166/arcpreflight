// RFC 8785 JSON Canonicalization Scheme (JCS) for the value subset we use:
// objects, arrays, strings, booleans, null, and finite numbers (ES number→string, as JSON.stringify does).
// Big integers (amounts, block numbers) MUST be passed as decimal strings (see UIntString in types.ts).
import { keccak256, stringToBytes } from "viem";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(value); // ES Number::toString semantics as required by RFC 8785
  }
  if (typeof value === "bigint") throw new Error("JCS: bigint not allowed; encode as decimal string");
  if (typeof value === "undefined") throw new Error("JCS: undefined not allowed; use null or omit the key");
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const k of keys) if (obj[k] === undefined) throw new Error(`JCS: undefined at key ${k}`);
    // RFC 8785 §3.2.3: sort by UTF-16 code units; JS default string comparison does exactly that.
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

export type DigestKind =
  | "intent" | "report" | "policy" | "baseline" | "decision" | "transactionPlan"
  | "finalValidation" | "execution" | "quote" | "evidence" | "methodology" | "adapterManifest";

/** keccak256(UTF8(JCS({kind, schemaVersion, payload}))) — spec v1.4 §7.1 */
export function digest(kind: DigestKind, schemaVersion: string, payload: unknown): `0x${string}` {
  const canon = canonicalize({ kind, schemaVersion, payload });
  return keccak256(stringToBytes(canon));
}

export function canonicalBytesLength(value: unknown): number {
  return stringToBytes(canonicalize(value)).length;
}
