// The persisted side of the plan ledger (packages/client/src/plan.ts): ONE record per approved plan, evidence/spend/<net>-plan-<id>.json,
// written by every spending step (deploy, fund, probe, acceptance, lifecycle). It carries settled outflow, pending commitments and the
// API-driven steps' first balance baseline across process restarts, and pins the approved caps: a step whose environment asks for more
// than the pinned cap is refused before anything is signed or started. Mainnet runs belong to the Gate D plan by default; a testnet run
// has no plan unless PLAN_ID names one (rehearsals of the mechanism). A dry run or preflight reads the record and never writes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SpendRefused, createPlan, parsePlan, parseUsdc18, sameCaps, serializePlan, summarizePlan, type PlanCaps, type PlanLedger } from "@arcpreflight/client";

/** the caps of docs/MAINNET-PLAN.md: step caps 0.15 + 0.20 + 0.02 + 0.35 + 0.12 = 0.84; budget cap 0.69 = that sum minus the 0.15 the fund step only moves between project keys */
export const APPROVED_CAPS: PlanCaps = {
  budgetCapNativeAtomic: parseUsdc18("0.69"),
  steps: {
    deploy: { totalNativeAtomic: parseUsdc18("0.15"), perTxNativeAtomic: parseUsdc18("0.05") },
    fund: { totalNativeAtomic: parseUsdc18("0.20"), perTxNativeAtomic: parseUsdc18("0.20") },
    probe: { totalNativeAtomic: parseUsdc18("0.02"), perTxNativeAtomic: parseUsdc18("0.016") },
    acceptance: { totalNativeAtomic: parseUsdc18("0.35"), perTxNativeAtomic: null },
    lifecycle: { totalNativeAtomic: parseUsdc18("0.12"), perTxNativeAtomic: null },
  },
};
export const DEFAULT_MAINNET_PLAN_ID = "gate-d-mainnet-2026-10";
/** PLAN_ID, else the Gate D plan on mainnet, else none (testnet runs are not budgeted by the plan unless a rehearsal names one) */
export function planIdFor(network: string): string | null { return process.env.PLAN_ID ?? (network === "mainnet" ? DEFAULT_MAINNET_PLAN_ID : null); }
export const planPath = (root: string, network: string, planId: string) => resolve(root, "evidence", "spend", `${network}-plan-${planId}.json`);

/** the open record: `apply` runs a pure update and persists the result (unless opened read-only) */
export class PlanBook {
  constructor(public plan: PlanLedger, readonly path: string, readonly write: boolean, readonly created: boolean) {}
  apply(fn: (p: PlanLedger) => PlanLedger): PlanLedger {
    this.plan = fn(this.plan);
    if (this.write) { mkdirSync(resolve(this.path, ".."), { recursive: true }); writeFileSync(this.path, serializePlan(this.plan)); }
    return this.plan;
  }
  lines(): string[] { return summarizePlan(this.plan).concat(this.created ? [`  (new record${this.write ? "" : "; a dry run does not write it"}: ${this.path})`] : [`  (record ${this.path})`]); }
}
export function openPlan(root: string, network: string, opts: { write: boolean; planId?: string | null }): PlanBook | null {
  const planId = opts.planId === undefined ? planIdFor(network) : opts.planId;
  if (!planId) return null;
  const path = planPath(root, network, planId);
  if (existsSync(path)) {
    const plan = parsePlan(readFileSync(path, "utf8"));
    if (plan.network !== network) throw new SpendRefused(`${path} is a ${plan.network} plan; this run is on ${network}`);
    if (plan.planId !== planId) throw new SpendRefused(`${path} names plan ${plan.planId}, not ${planId}`);
    if (!sameCaps(plan.approved, APPROVED_CAPS)) throw new SpendRefused(`plan ${planId} pins caps that differ from this code's approved caps (docs/MAINNET-PLAN.md) — a changed budget needs a new approval and a new PLAN_ID; the old record is kept`);
    return new PlanBook(plan, path, opts.write, false);
  }
  return new PlanBook(createPlan({ planId, network, approved: APPROVED_CAPS }), path, opts.write, true);
}
