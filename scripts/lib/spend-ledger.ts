// The persisted side of the spend guard (packages/client/src/spend.ts): one ledger per network and step under evidence/spend/, so the
// aggregate limit holds across re-runs of the same step (a partly failed deploy re-run continues the same total). A dry run never writes.
// Limits come from env overrides with hard maxima, so a typo cannot raise a cap past what the plan allows.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpendGuard, SpendRefused, parseUsdc18, usdc18, type SpendEntry, type SpendLimits } from "@arcpreflight/client";

const GWEI = 10n ** 9n;
export type LimitSpec = { label: string; network: string; perTxUsdc: string; totalUsdc: string; maxFeeGwei: number; envPrefix: string; maxPerTxUsdc: string; maxTotalUsdc: string; maxFeeGweiHard?: number };
/** reads <PREFIX>_PER_TX_CAP_USDC, <PREFIX>_TOTAL_CAP_USDC and MAX_FEE_GWEI; refuses values above the hard maxima */
export function limitsFrom(spec: LimitSpec): SpendLimits {
  const perTx = parseUsdc18(process.env[`${spec.envPrefix}_PER_TX_CAP_USDC`] ?? spec.perTxUsdc);
  const total = parseUsdc18(process.env[`${spec.envPrefix}_TOTAL_CAP_USDC`] ?? spec.totalUsdc);
  const maxFeeGwei = BigInt(process.env.MAX_FEE_GWEI ?? String(spec.maxFeeGwei));
  if (perTx > parseUsdc18(spec.maxPerTxUsdc)) throw new SpendRefused(`${spec.envPrefix}_PER_TX_CAP_USDC above ${spec.maxPerTxUsdc} USDC is refused`);
  if (total > parseUsdc18(spec.maxTotalUsdc)) throw new SpendRefused(`${spec.envPrefix}_TOTAL_CAP_USDC above ${spec.maxTotalUsdc} USDC is refused`);
  if (maxFeeGwei > BigInt(spec.maxFeeGweiHard ?? 200)) throw new SpendRefused(`MAX_FEE_GWEI above ${spec.maxFeeGweiHard ?? 200} is refused`);
  return { label: spec.label, network: spec.network, perTxNativeAtomic: perTx, totalNativeAtomic: total, maxFeePerGasCeiling: maxFeeGwei * GWEI };
}
export function ledgerPath(root: string, network: string, label: string) { return resolve(root, "evidence", "spend", `${network}-${label}.json`); }
/** the guard with the step's previous entries; `save()` writes the ledger (never in a dry run) */
export function openGuard(root: string, limits: SpendLimits, opts: { write: boolean }) {
  const path = ledgerPath(root, limits.network, limits.label);
  const prior: SpendEntry[] = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).entries ?? []) : [];
  const guard = new SpendGuard(limits, prior);
  const save = () => { if (!opts.write) return; mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), ...guard.summary() }, null, 2)); };
  return { guard, save, path, priorEntries: prior.length };
}
export { usdc18 };
