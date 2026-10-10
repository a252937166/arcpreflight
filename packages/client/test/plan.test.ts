import { describe, expect, it } from "vitest";
import { SpendRefused, parseUsdc18, type SpendEntry } from "../src/spend.js";
import { beginMeasured, checkStep, createPlan, endStep, noteOpen, openIdTags, parsePlan, relabelOpen, pinCaps, planCommitted, planRemaining, recordGuard, resolvePlanId, sameCaps, serializePlan, summarizePlan, updateMeasured } from "../src/plan.js";

// Gate D review 2026-10-10, P1: the cumulative cap must hold across process restarts — one record per plan id carries settled outflow,
// pending commitments and the first invocation's balance baseline; the approved caps are pinned and cannot be raised by the environment.
const U = parseUsdc18;
const APPROVED = { budgetCapNativeAtomic: U("0.69"), maxFeePerGasCeiling: 40n * 10n ** 9n, steps: { deploy: { totalNativeAtomic: U("0.15"), perTxNativeAtomic: U("0.05") }, fund: { totalNativeAtomic: U("0.20"), perTxNativeAtomic: U("0.20") }, probe: { totalNativeAtomic: U("0.02"), perTxNativeAtomic: U("0.016") }, acceptance: { totalNativeAtomic: U("0.35"), perTxNativeAtomic: null }, lifecycle: { totalNativeAtomic: U("0.12"), perTxNativeAtomic: null } } };
const plan = () => createPlan({ planId: "gate-d-mainnet-2026-10", network: "mainnet", approved: APPROVED, now: "2026-10-10T00:00:00.000Z" });
const entry = (status: SpendEntry["status"], worst: string, actual: string | null = null, to: string | null = null): SpendEntry => ({ purpose: "t", to, worstNativeAtomic: U(worst).toString(), actualNativeAtomic: actual === null ? null : U(actual).toString(), status, txHash: null, at: "2026-10-10T00:00:00.000Z" });

describe("plan ledger", () => {
  it("round-trips through JSON with exact amounts; a plan id and a budget cap are validated; pinned caps are compared", () => {
    const p = plan(); const back = parsePlan(serializePlan(p));
    expect(back).toEqual(p); expect(sameCaps(back.approved, APPROVED)).toBe(true);
    expect(sameCaps(back.approved, { ...APPROVED, budgetCapNativeAtomic: U("0.70") })).toBe(false);
    expect(() => createPlan({ planId: "X!", network: "mainnet", approved: APPROVED })).toThrow(SpendRefused);
    expect(() => createPlan({ planId: "too-big", network: "mainnet", approved: { ...APPROVED, budgetCapNativeAtomic: U("0.85") } })).toThrow(/at most the sum of the step caps/);
    expect(() => parsePlan(JSON.stringify({ planVersion: 2 }))).toThrow(SpendRefused);
    expect(() => parsePlan(serializePlan(p).replace('"outflowNativeAtomic": "0"', '"outflowNativeAtomic": "x"'))).toThrow(/not an integer string/);
  });
  it("environment overrides may lower a pinned cap, never raise it", () => {
    const p = plan();
    expect(pinCaps(p, "acceptance", { totalNativeAtomic: U("0.30") }).totalNativeAtomic).toBe(U("0.30"));
    expect(() => pinCaps(p, "acceptance", { totalNativeAtomic: U("0.36") })).toThrow(/cannot raise an approved cap/);
    expect(() => pinCaps(p, "deploy", { totalNativeAtomic: U("0.15"), perTxNativeAtomic: U("0.06") })).toThrow(/per-transaction cap/);
    expect(pinCaps(p, "deploy", { totalNativeAtomic: U("0.10") })).toEqual({ totalNativeAtomic: U("0.10"), perTxNativeAtomic: U("0.05") }); // the pinned per-tx cap applies when none is requested
  });
  it("scripted steps carry their guard ledger: settled actuals are outflow (minus internal value), unsettled sends are pending; the step and the plan caps are checked cumulatively", () => {
    let p = recordGuard(plan(), "deploy", [entry("settled", "0.031", "0.0215"), entry("settled", "0.0318", "0.0221"), entry("sent", "0.0051")]);
    expect(p.steps.deploy).toMatchObject({ outflowNativeAtomic: U("0.0436"), pendingNativeAtomic: U("0.0051") });
    expect(planCommitted(p)).toBe(U("0.0487")); expect(planRemaining(p)).toBe(U("0.6413"));
    // a restart of the deploy step: what is already committed counts before the next step's worst case
    expect(checkStep(p, "deploy", U("0.10")).ok).toBe(true);
    const over = checkStep(p, "deploy", U("0.1014")); expect(over.ok).toBe(false); expect(over.reason).toContain("across every invocation");
    // the fund step: value to project keys stays internal
    p = recordGuard(p, "fund", [entry("settled", "0.1006", "0.1005", "0xb6eE"), entry("settled", "0.0506", "0.0505", "0xA711")], U("0.15"));
    expect(p.steps.fund).toMatchObject({ outflowNativeAtomic: U("0.001"), internalNativeAtomic: U("0.15") });
    expect(() => recordGuard(p, "fund", [entry("settled", "0.1", "0.1")], U("0.2"))).toThrow(/internal value/);
    // the plan-level cap: a step within its own cap can still be refused by the budget
    let q = plan(); for (const s of ["deploy", "fund", "probe", "acceptance"] as const) q = recordGuard(q, s, [entry("settled", "0.9", APPROVED.steps[s].totalNativeAtomic === U("0.35") ? "0.35" : s === "deploy" ? "0.15" : s === "fund" ? "0.20" : "0.02")]);
    expect(planCommitted(q)).toBe(U("0.72")); // already past the 0.69 budget (the fund value counted as outflow here, no internal given)
    const r = checkStep(q, "lifecycle", U("0.01")); expect(r.ok).toBe(false); expect(r.reason).toContain("budget cap");
  });
  it("API-driven steps measure from the FIRST invocation's baseline across restarts; open runs count at their worst case until settled; a different key set is refused", () => {
    let p = beginMeasured(plan(), "acceptance", ["0xC618", "0xb6eE", "0x0687"], U("10.0"), "2026-10-10T01:00:00.000Z");
    expect(p.steps.acceptance).toMatchObject({ status: "running", invocations: 1, baselineTotalNativeAtomic: U("10.0") });
    p = updateMeasured(p, "acceptance", U("9.88")); expect(p.steps.acceptance.outflowNativeAtomic).toBe(U("0.12"));
    p = noteOpen(p, "acceptance", "run-1", true, U("0.06")); expect(p.steps.acceptance.pendingNativeAtomic).toBe(U("0.06"));
    p = noteOpen(p, "acceptance", "run-1", true, U("0.06")); expect(p.steps.acceptance.pendingNativeAtomic).toBe(U("0.06")); // idempotent
    expect(checkStep(p, "acceptance", U("0.18")).ok).toBe(false); // 0.12 + 0.06 + 0.18 > 0.35
    expect(checkStep(p, "acceptance", U("0.17")).ok).toBe(true);
    // the process dies and restarts: the record is re-read, the baseline is the old one, the open run is still pending
    const restarted = beginMeasured(parsePlan(serializePlan(p)), "acceptance", ["0x0687", "0xC618", "0xb6eE"], U("9.80"));
    expect(restarted.steps.acceptance).toMatchObject({ invocations: 2, baselineTotalNativeAtomic: U("10.0"), openRuns: ["run-1"] });
    const measured = updateMeasured(restarted, "acceptance", U("9.80")); expect(measured.steps.acceptance.outflowNativeAtomic).toBe(U("0.20")); // from the first baseline, not from 9.88
    const settled = noteOpen(measured, "acceptance", "run-1", false, U("0.06")); expect(settled.steps.acceptance).toMatchObject({ pendingNativeAtomic: 0n, openRuns: [], settledRuns: ["run-1"] }); // review of bf0c800: closing an open operation records it as settled, so a restart knows what is done
    expect(noteOpen(settled, "acceptance", "never-open", false, U("0.06")).steps.acceptance.settledRuns).toEqual(["run-1"]); // closing an id that was not open records nothing
    expect(parsePlan(serializePlan(settled)).steps.acceptance.settledRuns).toEqual(["run-1"]);
    { const raw = JSON.parse(serializePlan(settled)); delete raw.steps.acceptance.settledRuns; expect(parsePlan(JSON.stringify(raw)).steps.acceptance.settledRuns).toEqual([]); } // a record written before this field reads as none settled
    expect(() => beginMeasured(settled, "acceptance", ["0xC618"], U("9.80"))).toThrow(/would not be comparable/);
    expect(() => updateMeasured(plan(), "lifecycle", U("1"))).toThrow(/no baseline/);
    expect(endStep(settled, "acceptance", "done").steps.acceptance.status).toBe("done");
    expect(summarizePlan(settled)[0]).toContain("budget cap 0.69"); expect(summarizePlan(settled).find((l) => l.includes("acceptance"))).toContain("baseline 10");
  });
});

describe("lifecycle rehearsal on 40c5858 (2026-10-10): an open scenario carries the identities a restart recovers from", () => {
  it("relabelOpen renames an open run and keeps its pending worst case; openIdTags reads the identities back; unknown ids are no-ops", () => {
    let p = beginMeasured(plan(), "lifecycle", ["0xA711", "0xC618"], U("10.0"), "2026-10-10T07:35:00.000Z");
    p = noteOpen(p, "lifecycle", "interrupt-2026-10-10T07-35-28-806Z", true, U("0.073"));
    p = relabelOpen(p, "lifecycle", "interrupt-2026-10-10T07-35-28-806Z", "interrupt-2026-10-10T07-35-28-806Z:key:lc-abc-123");
    expect(p.steps.lifecycle).toMatchObject({ openRuns: ["interrupt-2026-10-10T07-35-28-806Z:key:lc-abc-123"], pendingNativeAtomic: U("0.073") });
    expect(openIdTags(p.steps.lifecycle.openRuns[0])).toEqual({ base: "interrupt-2026-10-10T07-35-28-806Z", tags: { key: "lc-abc-123" } });
    let w = noteOpen(p, "lifecycle", "wallet-2026-10-10T07-35-28-806Z", true, U("0.028"));
    w = relabelOpen(w, "lifecycle", "wallet-2026-10-10T07-35-28-806Z", "wallet-2026-10-10T07-35-28-806Z:order:0x6bbf:attempt:07b7");
    w = relabelOpen(w, "lifecycle", "wallet-2026-10-10T07-35-28-806Z:order:0x6bbf:attempt:07b7", "wallet-2026-10-10T07-35-28-806Z:order:0x6bbf:attempt:07b7:tx:0xfa61");
    expect(w.steps.lifecycle.pendingNativeAtomic).toBe(U("0.101"));
    expect(openIdTags(w.steps.lifecycle.openRuns[1]).tags).toEqual({ order: "0x6bbf", attempt: "07b7", tx: "0xfa61" });
    expect(relabelOpen(w, "lifecycle", "never-open", "x")).toBe(w); // not open: nothing changes
    expect(relabelOpen(w, "lifecycle", w.steps.lifecycle.openRuns[1], w.steps.lifecycle.openRuns[1])).toBe(w);
    const restarted = parsePlan(serializePlan(w)); // the restart reads the identities back and settles the scenario under its final id
    const settled = noteOpen(restarted, "lifecycle", restarted.steps.lifecycle.openRuns[1], false, U("0.028"));
    expect(settled.steps.lifecycle).toMatchObject({ pendingNativeAtomic: U("0.073"), openRuns: ["interrupt-2026-10-10T07-35-28-806Z:key:lc-abc-123"] });
    expect(openIdTags("interrupt-2026-10-10T07-35-28-806Z")).toEqual({ base: "interrupt-2026-10-10T07-35-28-806Z", tags: {} }); // a record written before this version: no identity
  });
});

describe("audit 2026-10-10 (OP-02, OP-04): the plan id is mandatory on mainnet; the fee ceiling is pinned like the money caps", () => {
  it("OP-02: on mainnet a blank or whitespace PLAN_ID is refused, an unset one takes the default, a named one is used; testnet has no plan unless named", () => {
    expect(resolvePlanId("mainnet", undefined, "gate-d")).toBe("gate-d");
    expect(resolvePlanId("mainnet", "rehearsal-x", "gate-d")).toBe("rehearsal-x");
    expect(() => resolvePlanId("mainnet", "", "gate-d")).toThrow(/blank/); expect(() => resolvePlanId("mainnet", "   ", "gate-d")).toThrow(/blank/);
    expect(resolvePlanId("testnet", undefined, "gate-d")).toBeNull(); expect(resolvePlanId("testnet", "", "gate-d")).toBeNull(); expect(resolvePlanId("testnet", " r1 ", "gate-d")).toBe("r1");
  });
  it("OP-04: MAX_FEE_GWEI above the pinned 40 gwei is refused for every step; 40 or lower is accepted; the ceiling is part of the pinned caps", () => {
    const p = plan();
    for (const step of ["deploy", "fund", "probe", "lifecycle"] as const) {
      expect(() => pinCaps(p, step, { totalNativeAtomic: U("0.01"), maxFeePerGasCeiling: 41n * 10n ** 9n })).toThrow(/cannot raise an approved ceiling/);
      expect(() => pinCaps(p, step, { totalNativeAtomic: U("0.01"), maxFeePerGasCeiling: 80n * 10n ** 9n })).toThrow(/80 gwei/);
      expect(pinCaps(p, step, { totalNativeAtomic: U("0.01"), maxFeePerGasCeiling: 40n * 10n ** 9n }).totalNativeAtomic).toBe(U("0.01"));
      expect(pinCaps(p, step, { totalNativeAtomic: U("0.01"), maxFeePerGasCeiling: 25n * 10n ** 9n }).totalNativeAtomic).toBe(U("0.01"));
    }
    expect(sameCaps(p.approved, { ...APPROVED, maxFeePerGasCeiling: 80n * 10n ** 9n })).toBe(false);
    expect(parsePlan(serializePlan(p)).approved.maxFeePerGasCeiling).toBe(40n * 10n ** 9n);
    expect(summarizePlan(p)[0]).toContain("fee ceiling 40 gwei");
  });
});
