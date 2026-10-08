export const short = (h: string | null | undefined, n = 6) => (!h ? "—" : h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`);
export const usdcNative = (atomic: string | bigint | null | undefined, digits = 4) => (atomic === null || atomic === undefined ? "—" : `${(Number(BigInt(atomic)) / 1e18).toFixed(digits)} USDC`);
export const usdcToken = (atomic: string | bigint | null | undefined) => (atomic === null || atomic === undefined ? "—" : `${(Number(BigInt(atomic)) / 1e6).toFixed(2)} USDC`);
export const ms = (v: number) => (v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
export const ago = (iso: string) => { const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return `${Math.max(0, Math.floor(d))}s ago`; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; };
export const utc = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
export const gwei = (atomic: string | bigint) => `${(Number(BigInt(atomic)) / 1e9).toFixed(2)} gwei`;

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "violet";
export function decisionTone(d: string | null | undefined): Tone {
  if (d === "NO_POLICY_VIOLATION" || d === "CONFIRMED" || d === "PASS" || d === "SUCCESS" || d === "MATCH") return "ok";
  if (d === "REVIEW_REQUIRED" || d === "UNKNOWN" || d === "IMPLEMENTATION_CHANGED" || d === "ADAPTER_CHANGED" || d === "PENDING") return "warn";
  if (d === "BLOCKED" || d === "FAILED" || d === "REVERTED") return "bad";
  return "neutral";
}
export const signalTone = (s: string): Tone => (s === "observed" ? "ok" : s === "not_observed" ? "bad" : "warn");
/** 18-decimal native atomic → six-decimal USDC rendering (the primary screen shows money with six decimals, exact, no rounding up). */
export const usdc6 = (atomic: string | bigint | null | undefined) => { if (atomic === null || atomic === undefined) return "—"; const v = BigInt(atomic); const neg = v < 0n; const a = neg ? -v : v; return `${neg ? "-" : ""}${a / 10n ** 18n}.${(a % 10n ** 18n).toString().padStart(18, "0").slice(0, 6)} USDC`; };
/** 6-decimal token atomic → six-decimal USDC rendering */
export const usdcToken6 = (atomic: string | bigint | null | undefined) => { if (atomic === null || atomic === undefined) return "—"; const v = BigInt(atomic); return `${v / 10n ** 6n}.${(v % 10n ** 6n).toString().padStart(6, "0")} USDC`; };
/** exact decimal rendering of an 18-decimal atomic value (full precision, trailing zeros trimmed) — for gas lines */
export const usdcExact = (atomic: string | bigint | null | undefined) => { if (atomic === null || atomic === undefined) return "—"; const v = BigInt(atomic); const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, ""); return `${v / 10n ** 18n}${frac ? `.${frac}` : ""} USDC`; };
