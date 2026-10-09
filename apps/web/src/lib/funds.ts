// The project-funds reading the API's worker exposes on /v1/network (operator decision 2026-10-09): shown on the Evidence page, and as
// a warning on the Live Demo when a key is below its threshold. Public addresses and chain balances only.
import type { NetworkInfo } from "./api";
import { usdcNative } from "./format";

export type FundsRow = { role: string; address: string; balance: string; threshold: string; status: "ok" | "low" | "unread"; note: string };
export type FundsSummary = { available: boolean; checkedAt: string | null; low: boolean; lowRoles: string[]; rows: FundsRow[]; note: string | null };
export function fundsSummary(net: NetworkInfo | null | undefined): FundsSummary {
  const f = net?.funds;
  if (!f || !f.checkedAt) return { available: false, checkedAt: null, low: false, lowRoles: [], rows: [], note: f?.note ?? null };
  const rows: FundsRow[] = f.keys.map((k) => ({ role: k.role, address: k.address, balance: k.balanceNativeAtomic === null ? "not read" : `${usdcNative(k.balanceNativeAtomic, 4)}`, threshold: usdcNative(k.warnBelowNativeAtomic, 2), status: k.balanceNativeAtomic === null ? "unread" : k.low ? "low" : "ok", note: k.note }));
  return { available: true, checkedAt: f.checkedAt, low: f.low, lowRoles: rows.filter((r) => r.status === "low").map((r) => r.role), rows, note: f.note };
}
/** the one sentence a visitor sees when a key is low */
export const fundsWarning = (s: FundsSummary, network: string): string | null => (s.low ? `Project funds are low on ${network} (${s.lowRoles.join(", ")}): live runs or faucet claims may be refused until the operator tops them up. Recorded runs, checks and passports stay available.` : null);
