// Plan ledger (Gate D; review of 2026-10-10, P1 "acceptance and lifecycle budgets reset across process restarts"). One persisted
// accounting record per approved plan — a stable plan id — that every spending step writes to: settled outflow, pending commitments
// (worst case of anything signed or started whose outcome is not settled), what stayed inside the project, and for API-driven steps the
// balance baseline of the FIRST invocation so a restart measures from where the step began, not from the current balances. The approved
// caps are pinned in the record when it is created: an environment override may lower a cap for a run, never raise it. Pure: the scripts
// persist the record (evidence/spend/<net>-plan-<id>.json); this module decides.
import { SpendRefused, usdc18, type SpendEntry } from "./spend.js";

export type PlanStepId = "deploy" | "fund" | "probe" | "acceptance" | "lifecycle";
export const PLAN_STEPS: PlanStepId[] = ["deploy", "fund", "probe", "acceptance", "lifecycle"];
export type PlanStepCaps = { totalNativeAtomic: bigint; perTxNativeAtomic: bigint | null };
/** `maxFeePerGasCeiling`: the highest max fee any script-signed transaction may carry under this plan (audit 2026-10-10, OP-04: pinned like the money caps) */
export type PlanCaps = { budgetCapNativeAtomic: bigint; maxFeePerGasCeiling: bigint; steps: Record<PlanStepId, PlanStepCaps> };
export type PlanStepStatus = "pending" | "running" | "done" | "stopped";
export type PlanStepState = {
  status: PlanStepStatus;
  /** settled money that left the project's keys (gas, payments into the project's own merchant contract counted conservatively) */
  outflowNativeAtomic: bigint;
  /** the worst case of commitments whose outcome is not settled: signed transactions without a receipt, runs still open */
  pendingNativeAtomic: bigint;
  /** settled value that only moved between project keys (the funding transfers): not outflow */
  internalNativeAtomic: bigint;
  /** API-driven steps: the summed balances of the measured keys when the step FIRST started, carried across restarts */
  baselineTotalNativeAtomic: bigint | null; measuredAddresses: string[] | null;
  openRuns: string[];
  /** operations this step settled (closed) under the plan, in order — a restart knows what is already done (review of bf0c800, P1) */
  settledRuns: string[];
  invocations: number; updatedAt: string | null;
};
export type PlanLedger = { planVersion: 1; planId: string; network: string; createdAt: string; updatedAt: string; approved: PlanCaps; steps: Record<PlanStepId, PlanStepState> };

const stamp = (now?: string) => now ?? new Date().toISOString();
const emptyStep = (): PlanStepState => ({ status: "pending", outflowNativeAtomic: 0n, pendingNativeAtomic: 0n, internalNativeAtomic: 0n, baselineTotalNativeAtomic: null, measuredAddresses: null, openRuns: [], settledRuns: [], invocations: 0, updatedAt: null });
export function createPlan(o: { planId: string; network: string; approved: PlanCaps; now?: string }): PlanLedger {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(o.planId)) throw new SpendRefused(`plan id ${JSON.stringify(o.planId)} must be 3–64 lower-case letters, digits or dashes`);
  const sum = PLAN_STEPS.reduce((a, s) => a + o.approved.steps[s].totalNativeAtomic, 0n);
  if (o.approved.budgetCapNativeAtomic <= 0n || o.approved.budgetCapNativeAtomic > sum) throw new SpendRefused(`the budget cap ${usdc18(o.approved.budgetCapNativeAtomic)} must be positive and at most the sum of the step caps ${usdc18(sum)}`);
  if (o.approved.maxFeePerGasCeiling <= 0n) throw new SpendRefused("the approved fee ceiling must be positive");
  const at = stamp(o.now);
  return { planVersion: 1, planId: o.planId, network: o.network, createdAt: at, updatedAt: at, approved: o.approved, steps: Object.fromEntries(PLAN_STEPS.map((s) => [s, emptyStep()])) as Record<PlanStepId, PlanStepState> };
}
const big = (v: unknown, what: string): bigint => { if (typeof v !== "string" || !/^\d+$/.test(v)) throw new SpendRefused(`plan file: ${what} is not an integer string`); return BigInt(v); };
/** JSON with every bigint as a decimal string */
export function serializePlan(p: PlanLedger): string { return JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2); }
export function parsePlan(text: string): PlanLedger {
  const d = JSON.parse(text);
  if (d?.planVersion !== 1 || typeof d.planId !== "string" || typeof d.network !== "string") throw new SpendRefused("plan file: not a version-1 plan ledger");
  const steps = Object.fromEntries(PLAN_STEPS.map((s) => { const x = d.steps?.[s] ?? {}; return [s, { ...emptyStep(), ...x, settledRuns: Array.isArray(x.settledRuns) ? x.settledRuns.map(String) : [], outflowNativeAtomic: big(x.outflowNativeAtomic ?? "0", `${s}.outflow`), pendingNativeAtomic: big(x.pendingNativeAtomic ?? "0", `${s}.pending`), internalNativeAtomic: big(x.internalNativeAtomic ?? "0", `${s}.internal`), baselineTotalNativeAtomic: x.baselineTotalNativeAtomic == null ? null : big(x.baselineTotalNativeAtomic, `${s}.baseline`), openRuns: Array.isArray(x.openRuns) ? x.openRuns : [] }]; })) as Record<PlanStepId, PlanStepState>;
  const approved: PlanCaps = { budgetCapNativeAtomic: big(d.approved?.budgetCapNativeAtomic, "approved.budgetCap"), maxFeePerGasCeiling: big(d.approved?.maxFeePerGasCeiling ?? "40000000000", "approved.maxFeePerGasCeiling"), steps: Object.fromEntries(PLAN_STEPS.map((s) => [s, { totalNativeAtomic: big(d.approved?.steps?.[s]?.totalNativeAtomic, `approved.${s}.total`), perTxNativeAtomic: d.approved?.steps?.[s]?.perTxNativeAtomic == null ? null : big(d.approved.steps[s].perTxNativeAtomic, `approved.${s}.perTx`) }])) as Record<PlanStepId, PlanStepCaps> };
  return { planVersion: 1, planId: d.planId, network: d.network, createdAt: d.createdAt, updatedAt: d.updatedAt, approved, steps };
}
/** the caps the record pins must be the ones the code was approved with; a change needs a new approval under a new plan id */
export function sameCaps(a: PlanCaps, b: PlanCaps): boolean {
  return a.budgetCapNativeAtomic === b.budgetCapNativeAtomic && a.maxFeePerGasCeiling === b.maxFeePerGasCeiling && PLAN_STEPS.every((s) => a.steps[s].totalNativeAtomic === b.steps[s].totalNativeAtomic && (a.steps[s].perTxNativeAtomic ?? null) === (b.steps[s].perTxNativeAtomic ?? null));
}
/** a run's requested caps (defaults or environment overrides) against the pinned ones: lower is accepted, higher is refused */
export function pinCaps(p: PlanLedger, step: PlanStepId, requested: { totalNativeAtomic: bigint; perTxNativeAtomic?: bigint | null; maxFeePerGasCeiling?: bigint | null }): PlanStepCaps {
  const pinned = p.approved.steps[step];
  if (requested.maxFeePerGasCeiling != null && requested.maxFeePerGasCeiling > p.approved.maxFeePerGasCeiling) throw new SpendRefused(`${step}: the requested max-fee ceiling ${requested.maxFeePerGasCeiling / 10n ** 9n} gwei is above the ${p.approved.maxFeePerGasCeiling / 10n ** 9n} gwei pinned by plan ${p.planId} — an environment override (MAX_FEE_GWEI) cannot raise an approved ceiling`);
  if (requested.totalNativeAtomic > pinned.totalNativeAtomic) throw new SpendRefused(`${step}: the requested total cap ${usdc18(requested.totalNativeAtomic)} USDC is above the ${usdc18(pinned.totalNativeAtomic)} USDC pinned by plan ${p.planId} — an environment override cannot raise an approved cap (a new cap needs a new approval and plan id)`);
  if (requested.perTxNativeAtomic != null && pinned.perTxNativeAtomic !== null && requested.perTxNativeAtomic > pinned.perTxNativeAtomic) throw new SpendRefused(`${step}: the requested per-transaction cap ${usdc18(requested.perTxNativeAtomic)} USDC is above the ${usdc18(pinned.perTxNativeAtomic)} USDC pinned by plan ${p.planId}`);
  return { totalNativeAtomic: requested.totalNativeAtomic, perTxNativeAtomic: requested.perTxNativeAtomic ?? pinned.perTxNativeAtomic };
}
const committedOf = (s: PlanStepState) => s.outflowNativeAtomic + s.pendingNativeAtomic;
/** everything that left or may still leave the project's keys under this plan (settled outflow + pending commitments of every step) */
export const planCommitted = (p: PlanLedger): bigint => PLAN_STEPS.reduce((a, s) => a + committedOf(p.steps[s]), 0n);
export const planRemaining = (p: PlanLedger): bigint => { const r = p.approved.budgetCapNativeAtomic - planCommitted(p); return r > 0n ? r : 0n; };
/** before a step spends `nextWorst` more: the step's cumulative total and the plan's cumulative total must both stay under their caps */
export function checkStep(p: PlanLedger, step: PlanStepId, nextWorst: bigint, stepCap: bigint = p.approved.steps[step].totalNativeAtomic): { ok: boolean; reason: string | null; stepCommitted: bigint; planCommittedNow: bigint } {
  const stepCommitted = committedOf(p.steps[step]), planCommittedNow = planCommitted(p);
  if (stepCommitted + nextWorst > stepCap) return { ok: false, stepCommitted, planCommittedNow, reason: `${step}: ${usdc18(stepCommitted)} USDC committed across every invocation + worst case ${usdc18(nextWorst)} USDC exceeds the step cap ${usdc18(stepCap)} USDC — stopping` };
  if (planCommittedNow + nextWorst > p.approved.budgetCapNativeAtomic) return { ok: false, stepCommitted, planCommittedNow, reason: `plan ${p.planId}: ${usdc18(planCommittedNow)} USDC committed across every step + worst case ${usdc18(nextWorst)} USDC exceeds the budget cap ${usdc18(p.approved.budgetCapNativeAtomic)} USDC — stopping` };
  return { ok: true, reason: null, stepCommitted, planCommittedNow };
}
const put = (p: PlanLedger, step: PlanStepId, patch: Partial<PlanStepState>, now?: string): PlanLedger => ({ ...p, updatedAt: stamp(now), steps: { ...p.steps, [step]: { ...p.steps[step], ...patch, updatedAt: stamp(now) } } });
/** one more invocation of a step begins (status running) */
export const beginStep = (p: PlanLedger, step: PlanStepId, now?: string): PlanLedger => put(p, step, { status: "running", invocations: p.steps[step].invocations + 1 }, now);
export const endStep = (p: PlanLedger, step: PlanStepId, status: "done" | "stopped", now?: string): PlanLedger => put(p, step, { status }, now);
/** scripted steps: the step's spend-guard ledger is the source — settled actuals are outflow (minus what stayed internal), unsettled
 *  reservations and sends are pending at their worst case */
export function recordGuard(p: PlanLedger, step: PlanStepId, entries: readonly SpendEntry[], internalNativeAtomic = 0n, now?: string): PlanLedger {
  const settled = entries.filter((e) => e.status === "settled").reduce((a, e) => a + BigInt(e.actualNativeAtomic ?? e.worstNativeAtomic), 0n);
  const pending = entries.filter((e) => e.status === "reserved" || e.status === "sent").reduce((a, e) => a + BigInt(e.worstNativeAtomic), 0n);
  if (internalNativeAtomic < 0n || internalNativeAtomic > settled) throw new SpendRefused(`${step}: internal value ${usdc18(internalNativeAtomic)} must be between 0 and the settled total ${usdc18(settled)}`);
  return put(p, step, { outflowNativeAtomic: settled - internalNativeAtomic, pendingNativeAtomic: pending, internalNativeAtomic }, now);
}
/** API-driven steps (acceptance, lifecycle): the baseline is the summed balances of the measured keys at the step's FIRST start and is
 *  carried across restarts; a later invocation over a different set of keys is refused (its measurement would not be comparable) */
export function beginMeasured(p: PlanLedger, step: PlanStepId, addresses: string[], currentTotal: bigint, now?: string): PlanLedger {
  const s = p.steps[step]; const addrs = [...addresses].map((a) => a.toLowerCase()).sort();
  if (s.baselineTotalNativeAtomic === null) return put(beginStep(p, step, now), step, { baselineTotalNativeAtomic: currentTotal, measuredAddresses: addrs }, now);
  const prev = [...(s.measuredAddresses ?? [])].sort();
  if (prev.join(",") !== addrs.join(",")) throw new SpendRefused(`${step}: this plan measures [${prev.join(", ")}]; this invocation would measure [${addrs.join(", ")}] — stopping (the carried-forward baseline would not be comparable)`);
  return beginStep(p, step, now);
}
/** the step's outflow as measured from the carried-forward baseline (never negative) */
export function updateMeasured(p: PlanLedger, step: PlanStepId, currentTotal: bigint, now?: string): PlanLedger {
  const base = p.steps[step].baselineTotalNativeAtomic; if (base === null) throw new SpendRefused(`${step}: no baseline recorded yet`);
  const out = base - currentTotal;
  return put(p, step, { outflowNativeAtomic: out > 0n ? out : 0n }, now);
}
/** a run or scenario the step started whose outcome is not settled yet counts at its worst case until it is */
export function noteOpen(p: PlanLedger, step: PlanStepId, id: string, open: boolean, worstNativeAtomic: bigint, now?: string): PlanLedger {
  const s = p.steps[step]; const runs = open ? Array.from(new Set([...s.openRuns, id])) : s.openRuns.filter((r) => r !== id);
  const pending = open ? s.pendingNativeAtomic + (s.openRuns.includes(id) ? 0n : worstNativeAtomic) : (s.openRuns.includes(id) ? (s.pendingNativeAtomic > worstNativeAtomic ? s.pendingNativeAtomic - worstNativeAtomic : 0n) : s.pendingNativeAtomic);
  const settledRuns = !open && s.openRuns.includes(id) ? Array.from(new Set([...s.settledRuns, id])) : s.settledRuns; // closing an open operation records it as settled
  return put(p, step, { openRuns: runs, pendingNativeAtomic: pending, settledRuns }, now);
}
/** Open run ids may carry the identities a scenario learns as it goes, as `:tag:value` suffixes (the lifecycle script writes
 *  `interrupt-<stamp>:key:<admission key>` and `wallet-<stamp>:order:<id>:attempt:<id>:tx:<hash>`); a restart recovers from them. */
export function openIdTags(id: string): { base: string; tags: Record<string, string> } {
  const parts = id.split(":"); const tags: Record<string, string> = {};
  for (let i = 1; i + 1 < parts.length; i += 2) tags[parts[i]] = parts[i + 1];
  return { base: parts[0], tags };
}
/** an open run learned a new identity: its id changes, its pending worst case does not (no-op when `from` is not open) */
export function relabelOpen(p: PlanLedger, step: PlanStepId, from: string, to: string, now?: string): PlanLedger {
  const s = p.steps[step]; if (from === to || !s.openRuns.includes(from)) return p;
  return put(p, step, { openRuns: Array.from(new Set(s.openRuns.map((r) => (r === from ? to : r)))) }, now);
}
/** The plan a run belongs to (audit 2026-10-10, OP-02): mainnet ALWAYS has one — the default Gate D plan unless PLAN_ID names another; a
 *  blank or whitespace PLAN_ID on mainnet is refused, never "no plan". Testnet runs are unbudgeted unless PLAN_ID names a rehearsal plan. */
export function resolvePlanId(network: string, envValue: string | undefined, mainnetDefault: string): string | null {
  if (envValue === undefined) return network === "mainnet" ? mainnetDefault : null;
  const id = envValue.trim();
  if (network === "mainnet") { if (!id) throw new SpendRefused("PLAN_ID is set but blank: mainnet runs must belong to a named plan (unset it for the Gate D default)"); return id; }
  return id || null;
}
export function summarizePlan(p: PlanLedger): string[] {
  const lines = [`plan ${p.planId} (${p.network}) · budget cap ${usdc18(p.approved.budgetCapNativeAtomic)} USDC · fee ceiling ${p.approved.maxFeePerGasCeiling / 10n ** 9n} gwei · committed ${usdc18(planCommitted(p))} · remaining ${usdc18(planRemaining(p))}`];
  for (const s of PLAN_STEPS) { const x = p.steps[s]; lines.push(`  ${s.padEnd(11)} ${x.status.padEnd(8)} cap ${usdc18(p.approved.steps[s].totalNativeAtomic).padEnd(6)} outflow ${usdc18(x.outflowNativeAtomic).padEnd(20)} pending ${usdc18(x.pendingNativeAtomic).padEnd(20)} internal ${usdc18(x.internalNativeAtomic).padEnd(6)} invocations ${x.invocations}${x.openRuns.length ? ` open ${x.openRuns.map((r) => r.slice(0, 8)).join(",")}` : ""}${x.settledRuns.length ? ` settled ${x.settledRuns.length}` : ""}${x.baselineTotalNativeAtomic !== null ? ` baseline ${usdc18(x.baselineTotalNativeAtomic)}` : ""}`); }
  return lines;
}
