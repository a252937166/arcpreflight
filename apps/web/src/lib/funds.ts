// The project-funds reading the API's worker exposes on /v1/network (operator decision 2026-10-09): shown on the Evidence page, and as
// a warning on the Live Demo when a key is below its threshold. Public addresses and chain balances only.
import type { NetworkInfo } from "./api";
import { usdcNative } from "./format";

export type FundsRow = { role: string; address: string; balance: string; threshold: string; status: "ok" | "low" | "unread"; note: string };
export type FundsSummary = { available: boolean; checkedAt: string | null; low: boolean; lowRoles: string[]; rows: FundsRow[]; note: string | null };
export function fundsSummary(net: NetworkInfo | null | undefined): FundsSummary {
  const f = net?.funds;
  if (!f || !f.checkedAt) return { available: false, checkedAt: null, low: false, lowRoles: [], rows: [], note: f?.note ?? null };
  const rows: FundsRow[] = f.keys.map((k) => ({ role: k.role, address: k.address,
    balance: k.balanceNativeAtomic !== null ? `${usdcNative(k.balanceNativeAtomic, 4)}` : k.lastObserved ? `not read (last ${usdcNative(k.lastObserved.balanceNativeAtomic, 4)})` : "not read",
    threshold: usdcNative(k.warnBelowNativeAtomic, 2), status: k.balanceNativeAtomic === null ? "unread" : k.low ? "low" : "ok", note: k.note }));
  // a key that cannot be read now but was low at its last successful reading still counts as low (review 2026-10-09)
  const lowRoles = f.keys.flatMap((k) => (k.balanceNativeAtomic !== null ? (k.low ? [k.role] : []) : k.lastObserved?.low ? [`${k.role} (last reading)`] : []));
  return { available: true, checkedAt: f.checkedAt, low: f.low || lowRoles.length > 0, lowRoles, rows, note: f.note };
}
/** the one sentence a visitor sees when a key is low */
export const fundsWarning = (s: FundsSummary, network: string): string | null => (s.low ? `Project funds are low on ${network} (${s.lowRoles.join(", ")}): live runs or faucet claims may be refused until the operator tops them up. Recorded runs, checks and passports stay available.` : null);
