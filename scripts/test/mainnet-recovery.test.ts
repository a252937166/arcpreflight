// The mainnet acceptance script's ACTUAL recovery flow (review of bf0c800, P1), driven end to end against a fake ArcPreflight API and a fake
// Arc JSON-RPC node: the real main() reads the plan record, decides what to recover, re-sends admissions, follows runs, settles the ledger and
// writes the evidence. Only the per-run chain verifications (receipts, passports) are replaced through the `deps` seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNTS, BALANCES, D, MAIN, WORST_APPROVED, WORST_OTHER, doneRun, evidence as evidenceOf, evidenceFiles, fakeApi, fakeRpc, planPath, readPlan as readPlanOf, seedPlan as seedPlanAt, serve, type FixtureId, type Json } from "./helpers/mainnet-fakes.js";
const E18 = 10n ** 18n;
process.env.MAINNET_SELFTEST_IMPORT_ONLY = "1";
const { main, classifyReplay, parseOpenId } = await import("../selftest/mainnet.js");
const deps = {
  verifyRun: async (_ctx: unknown, fixture: FixtureId, run: any) => ({ fixture, runId: run.runId, requestId: run.result.requestId, labels: run.labels, decision: fixture === "APPROVED_PAYMENT" ? "NO_POLICY_VIOLATION" : fixture === "AMOUNT_UNIT_MISMATCH" ? "BLOCKED" : "REVIEW_REQUIRED", chainStatus: "x", businessStatus: "x", durationMs: 1,
    serviceFee: { kind: "SERVICE_FEE" as const, amountUsdc: "0.01", tx: D, payer: ACCOUNTS.demoRunner, payTo: ACCOUNTS.merchantPayTo, verifiedOnChain: true as const }, order: { orderId: D, merchant: MAIN, createTx: D, paidOnChain: fixture === "APPROVED_PAYMENT" },
    businessPayment: { kind: "BUSINESS_PAYMENT" as const, amountUsdc: fixture === "APPROVED_PAYMENT" ? "0.05" : "0", tx: fixture === "APPROVED_PAYMENT" ? D : null, executed: fixture === "APPROVED_PAYMENT" }, digests: {}, gasUsdc: { createOrder: "0.002", businessPay: null } }),
  verifyRecovery: async () => ({ unauthenticatedStatus: 401, authenticated: "SKIPPED (test)" }),
  verifyRunPassport: async () => ({ file: "test.passport.json", findings: {}, counts: { pass: 10, fail: 0, unverified: 0, notEvaluated: 1 } }),
  sleep: async () => {},
};
let root: string; let api: ReturnType<typeof fakeApi>; let apiServer: Awaited<ReturnType<typeof serve>>; let rpcServer: Awaited<ReturnType<typeof serve>>;
const readPlan = () => readPlanOf(root); const evidence = () => evidenceOf(root); const seedPlan = (o: Parameters<typeof seedPlanAt>[1]) => seedPlanAt(root, o);
const logs: string[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "arcpf-mainnet-")); api = fakeApi(); apiServer = await api.server; rpcServer = await fakeRpc(BALANCES);
  Object.assign(process.env, { ARCPREFLIGHT_ROOT: root, PLAN_ID: "test-plan", API_URL: apiServer.url, ARC_RPC_URL: rpcServer.url, ADMIN_TOKEN: "operator-token", EXPECTED_RELEASE: "abc1234", SELFTEST_REPEATS: "1", SELFTEST_OUTPUT_DIR: join(root, "out"), COOLDOWN_MARGIN_SECONDS: "0" });
  delete process.env.SPEND_CAP_USDC; delete process.env.DEMO_RUNNER_TOKEN;
  logs.length = 0; vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }); vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(async () => { vi.restoreAllMocks(); await apiServer.close(); await rpcServer.close(); rmSync(root, { recursive: true, force: true }); });
const dryRun = () => main(deps, []); const execute = () => main(deps, ["--execute"]);
const postsFor = (key: string) => api.state.posts.filter((p) => p.key === key);

describe("mainnet acceptance — recovery first, completed positions kept, the remaining work budgeted (review of bf0c800, P1)", () => {
  it("reproduction: a pending commitment plus the completed rounds used to be budgeted as a complete new batch and refused; now the dry run is READY, the open operation is recovered with its own fixture and key, the completed positions are re-verified and nothing new is started", async () => {
    seedPlan({ outflow: 200_000_000_000_000_000n, settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: "R2" }], open: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "k3", worst: WORST_APPROVED }] });
    api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION")); api.state.runs.set("R2", doneRun("R2", "AMOUNT_UNIT_MISMATCH"));
    api.state.runs.set("R3", doneRun("R3", "APPROVED_PAYMENT")); api.state.bound.set("k3", { runId: "R3", fixture: "APPROVED_PAYMENT" }); // the server admitted k3 before the previous invocation died
    // 0.20 settled + 0.0742 pending + 0.1162 for a complete new round = 0.39 > 0.35: the old budget check refused this; the remaining work is 0
    expect(await dryRun()).toBe(0);
    expect(logs.join("\n")).toMatch(/1 open operation\(s\) .* 2 completed .* 0 of 3 runs remaining; budgeted for the remaining work: 0\.0 USDC/);
    expect(api.state.posts).toEqual([]); // a dry run asks the server nothing about admissions
    expect(await execute()).toBe(0);
    expect(api.state.posts).toEqual([{ fixture: "APPROVED_PAYMENT", key: "k3" }]); // the ONE open operation re-sent with ITS fixture and key; no new key, no new run
    const p = readPlan().steps.acceptance;
    expect(p).toMatchObject({ status: "done", openRuns: [], pendingNativeAtomic: 0n, invocations: 2 }); expect(p.settledRuns).toHaveLength(3); expect(p.settledRuns[2]).toBe("run-1-APPROVED_PAYMENT:key:k3:run:R3");
    const ev = evidence(); expect(ev.status).toBe("PASS"); expect(ev.runs.map((r: any) => [r.round, r.fixture, r.runId])).toEqual([[1, "CHANGED_IMPLEMENTATION", "R1"], [1, "AMOUNT_UNIT_MISMATCH", "R2"], [1, "APPROVED_PAYMENT", "R3"]]);
    expect(ev.positions).toMatchObject({ total: 3, recoveredOpen: 1, completedBefore: 2, remainingAtStart: 0 });
    expect(ev.recovered.map((r: any) => r.how)).toEqual([expect.stringContaining("admission re-sent: existing"), expect.stringContaining("re-read and re-verified"), expect.stringContaining("re-read and re-verified")]);
  });
  it("reproduction: the re-sent admission carries the ORIGINAL fixture — an operation whose first request never arrived is admitted as that operation, never as APPROVED_PAYMENT", async () => {
    seedPlan({ outflow: 0n, open: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "kc", worst: WORST_OTHER }] }); // reserved, but the POST never reached the server
    expect(await execute()).toBe(0);
    expect(postsFor("kc")).toEqual([{ fixture: "CHANGED_IMPLEMENTATION", key: "kc" }]); // the same operation, admitted now (202 new) — the old code re-sent APPROVED_PAYMENT here
    expect(api.state.bound.get("kc")).toMatchObject({ fixture: "CHANGED_IMPLEMENTATION" });
    const fixturesStarted = [...api.state.bound.values()].map((b) => b.fixture).sort(); expect(fixturesStarted).toEqual(["AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT", "CHANGED_IMPLEMENTATION"]); // each position exactly once
    const ev = evidence(); expect(ev.status).toBe("PASS"); expect(ev.runs).toHaveLength(3); expect(ev.recovered[0].how).toContain("admission re-sent: new");
    expect(readPlan().steps.acceptance.settledRuns.map((s) => s.split(":key:")[0])).toEqual(["run-1-CHANGED_IMPLEMENTATION", "run-1-AMOUNT_UNIT_MISMATCH", "run-1-APPROVED_PAYMENT"]);
  });
  it("reproduction: an answer that proves nothing — a lost response, 503 EXECUTION_GATED, 409 — KEEPS the reservation and stops; a budget refusal releases it; a cooldown is waited out and the same key re-sent", async () => {
    for (const [label, answer] of [["lost response", "drop"], ["gate", { status: 503, body: { error: "EXECUTION_GATED", reason: "gated" } }], ["conflict", { status: 409, body: { error: "RUN_CONFLICT" } }]] as const) {
      api.state.posts.length = 0; api.state.replay = () => answer as Json;
      seedPlan({ outflow: 0n, open: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "ka", worst: WORST_APPROVED }] });
      expect(await execute(), label).toBe(1);
      const p = readPlan().steps.acceptance;
      expect(p.openRuns, label).toEqual(["run-1-APPROVED_PAYMENT:key:ka"]); expect(p.pendingNativeAtomic, label).toBe(WORST_APPROVED); expect(p.status).toBe("stopped"); // kept — the old code released it as "never admitted"
      expect(api.state.posts, label).toEqual([{ fixture: "APPROVED_PAYMENT", key: "ka" }]); // and nothing else was started
      expect(logs.join("\n"), label).toMatch(/reservation is KEPT/);
      rmSync(join(root, "out"), { recursive: true, force: true });
    }
    // a refusal that proves the key was never bound: released, and the position is then run in order with a fresh key
    api.state.posts.length = 0; api.state.replay = (key) => (key === "ka" ? { status: 429, body: { error: "DEMO_BUDGET_EXHAUSTED" } } : null);
    seedPlan({ outflow: 0n, open: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "ka", worst: WORST_APPROVED }] });
    expect(await execute()).toBe(0);
    expect(postsFor("ka")).toHaveLength(1); expect(api.state.bound.has("ka")).toBe(false);
    expect(readPlan().steps.acceptance).toMatchObject({ status: "done", openRuns: [], pendingNativeAtomic: 0n }); expect(evidence().recovered[0].how).toMatch(/released: DEMO_BUDGET_EXHAUSTED/);
    rmSync(join(root, "out"), { recursive: true, force: true });
    // a cooldown: nothing started, the SAME key is asked again and the operation recovered
    api.state.posts.length = 0; let asked = 0; api.state.replay = (key) => (key === "kb" && asked++ === 0 ? { status: 429, body: { error: "DEMO_COOLDOWN" } } : null);
    seedPlan({ outflow: 0n, open: [{ round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "kb", worst: WORST_OTHER }] });
    expect(await execute()).toBe(0);
    expect(postsFor("kb")).toEqual([{ fixture: "AMOUNT_UNIT_MISMATCH", key: "kb" }, { fixture: "AMOUNT_UNIT_MISMATCH", key: "kb" }]);
    expect(evidence().recovered[0].how).toContain("admission re-sent: new");
  });
  it("control: a fresh plan runs every position once with its own key (start + the AP32-08 replay each), records every operation as settled with its run id and writes PASS evidence", async () => {
    expect(await dryRun()).toBe(0); expect(logs.join("\n")).toMatch(/0 open operation\(s\) .* 0 completed .* 3 of 3 runs remaining/);
    expect(await execute()).toBe(0);
    expect(api.state.posts).toHaveLength(6); // 3 starts, each followed by the same key re-sent (AP32-08: the original run, nothing new)
    const keys = new Set(api.state.posts.map((p) => p.key)); expect(keys.size).toBe(3);
    expect(api.state.posts.map((p) => p.fixture)).toEqual(["CHANGED_IMPLEMENTATION", "CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT", "APPROVED_PAYMENT"]);
    const p = readPlan().steps.acceptance; expect(p).toMatchObject({ status: "done", openRuns: [], pendingNativeAtomic: 0n, invocations: 1 });
    expect(p.settledRuns).toHaveLength(3); for (const id of p.settledRuns) expect(parseOpenId(id)).toMatchObject({ position: expect.objectContaining({ round: 1 }), key: expect.any(String), runId: expect.stringMatching(/^run-/) });
    expect(evidence()).toMatchObject({ status: "PASS", positions: { total: 3, recoveredOpen: 0, completedBefore: 0, remainingAtStart: 3 } }); expect(evidence().runs).toHaveLength(3);
  });
  it("interrupted variant: completed positions of a previous invocation are kept and only the remaining one is budgeted and started — the budget check no longer counts the completed work twice", async () => {
    seedPlan({ outflow: 250_000_000_000_000_000n, settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: "R2" }] });
    api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION")); api.state.runs.set("R2", doneRun("R2", "AMOUNT_UNIT_MISMATCH"));
    // 0.25 settled + 0.1162 for a whole round > 0.35 refused before; 0.25 + 0.0742 for the one remaining run fits
    expect(await dryRun()).toBe(0); expect(logs.join("\n")).toMatch(/1 of 3 runs remaining; budgeted for the remaining work: 0.0742 USDC/);
    expect(await execute()).toBe(0);
    expect(api.state.posts.map((p) => p.fixture)).toEqual(["APPROVED_PAYMENT", "APPROVED_PAYMENT"]); // one start (+ its replay); nothing re-run
    const ev = evidence(); expect(ev.runs.map((r: any) => r.fixture)).toEqual(["CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT"]); expect(ev.positions).toMatchObject({ completedBefore: 2, remainingAtStart: 1 });
  });
  describe("review of 0d1088e (P1) — only verified runs count; released reservations are unfinished work; the funds are those of the remaining work", () => {
    it("reproduction (false PASS): a reservation the previous invocation released used to be read as a completed run — now it is unfinished work: the dry run lists it as remaining, the execution runs it, and PASS carries a verified report for every planned position", async () => {
      // the record shape the 0d1088e code left behind a release: an entry settled WITHOUT a run id (plus one it recorded as released)
      seedPlan({ outflow: 100_000_000_000_000_000n, settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: null }], released: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "k3" }] });
      api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION"));
      expect(await dryRun()).toBe(0);
      expect(logs.join("\n")).toMatch(/1 completed .* 1 released reservation\(s\) and 1 settled without a run id \(NOT counted as done: run again\), 2 of 3 runs remaining/);
      expect(await execute()).toBe(0);
      expect(api.state.posts.map((p) => p.fixture)).toEqual(["AMOUNT_UNIT_MISMATCH", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT", "APPROVED_PAYMENT"]); // both unfinished positions started (each with its AP32-08 replay); R1 only re-read
      const ev = evidence(); expect(ev.status).toBe("PASS"); expect(ev.runs.map((r: any) => r.fixture)).toEqual(["CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT"]);
      expect(ev.positions).toMatchObject({ total: 3, completedBefore: 1, releasedBefore: 1, unverifiedBefore: 1, remainingAtStart: 2, verified: 3 });
      const p = readPlan().steps.acceptance; expect(p.status).toBe("done"); expect(p.settledRuns.filter((id) => id.includes(":run:"))).toHaveLength(3); expect(p.releasedRuns).toEqual(["run-1-APPROVED_PAYMENT:key:k3"]);
    });
    it("a reservation released in THIS invocation is recorded as released, not settled, and its position is started afterwards; a restart after a stop keeps treating it as unfinished", async () => {
      api.state.replay = (key) => (key === "ka" ? { status: 429, body: { error: "DEMO_BUDGET_EXHAUSTED" } } : null);
      seedPlan({ outflow: 0n, open: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "ka", worst: WORST_APPROVED }] });
      expect(await execute()).toBe(0);
      const p = readPlan().steps.acceptance;
      expect(p.releasedRuns).toEqual(["run-1-APPROVED_PAYMENT:key:ka"]); expect(p.settledRuns.some((id) => id.includes(":key:ka"))).toBe(false);
      expect(p.settledRuns.filter((id) => id.startsWith("run-1-APPROVED_PAYMENT:key:") && id.includes(":run:"))).toHaveLength(1); // the position ran under a NEW key and is settled with its run id
      expect(evidence().positions.verified).toBe(3);
    });
    it("never PASS without evidence: a completed position whose run cannot be re-verified, or cannot be read back, leaves the invocation INCOMPLETE", async () => {
      seedPlan({ outflow: 100_000_000_000_000_000n, settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: "R2" }] });
      api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION")); api.state.runs.set("R2", doneRun("R2", "AMOUNT_UNIT_MISMATCH"));
      const strict = { ...deps, verifyRun: async (ctx: unknown, fixture: FixtureId, run: any) => { if (run.runId === "R2") throw new Error("R2: service fee log missing"); return deps.verifyRun(ctx, fixture, run); } };
      expect(await main(strict, ["--execute"])).toBe(1);
      expect(evidenceFiles(root)[0]).toMatch(/INCOMPLETE/); expect(evidence().failure.message).toContain("R2: service fee log missing"); expect(evidence().runs).toHaveLength(1);
      expect(api.state.posts).toEqual([]); // nothing new was started after the failed verification
      rmSync(join(root, "out"), { recursive: true, force: true }); api.state.runs.delete("R2"); // the server no longer serves R2 at all
      expect(await execute()).toBe(1); expect(evidenceFiles(root)[0]).toMatch(/INCOMPLETE/); expect(readPlan().steps.acceptance.status).toBe("stopped");
    }, 60_000); // the re-read of a vanished run retries with real 2 s pauses
    it("reproduction (funds): the balances only have to cover the REMAINING work — a runner and a creator that could not pay for a whole batch but can pay for the one unfinished run are READY, and the run completes", async () => {
      await apiServer.close(); await rpcServer.close();
      // 0.27 USDC covers one remaining APPROVED run (0.2632: fee + order + pay gas + floor + order) but not a whole round (0.2832); 0.01 covers one createOrder (0.006), not three (0.018)
      const low = { [ACCOUNTS.demoRunner.toLowerCase()]: 270_000_000_000_000_000n, [ACCOUNTS.orderCreator.toLowerCase()]: 10_000_000_000_000_000n, [ACCOUNTS.merchantPayTo.toLowerCase()]: E18 / 2n };
      api = fakeApi(); apiServer = await api.server; rpcServer = await fakeRpc(low); process.env.API_URL = apiServer.url; process.env.ARC_RPC_URL = rpcServer.url;
      const sum = Object.values(low).reduce((a, b) => a + b, 0n);
      seedPlan({ outflow: 50_000_000_000_000_000n, sum, settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: "R2" }] });
      api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION")); api.state.runs.set("R2", doneRun("R2", "AMOUNT_UNIT_MISMATCH"));
      expect(await dryRun()).toBe(0); expect(logs.join("\n")).toMatch(/needs >= 0\.2632 for the remaining work/);
      expect(await execute()).toBe(0); expect(evidence().positions.verified).toBe(3);
      // and once a reservation is released, the position it frees is funded as unfinished work BEFORE anything is started: too little → stop, no start
      rmSync(join(root, "out"), { recursive: true, force: true }); api.state.posts.length = 0;
      await apiServer.close(); await rpcServer.close();
      const lower = { ...low, [ACCOUNTS.demoRunner.toLowerCase()]: 200_000_000_000_000_000n }; // below 0.2632
      api = fakeApi(); apiServer = await api.server; rpcServer = await fakeRpc(lower); process.env.API_URL = apiServer.url; process.env.ARC_RPC_URL = rpcServer.url;
      api.state.replay = (key) => (key === "ka" ? { status: 429, body: { error: "DEMO_BUDGET_EXHAUSTED" } } : null);
      seedPlan({ outflow: 0n, sum: Object.values(lower).reduce((a, b) => a + b, 0n), settled: [{ round: 1, fixture: "CHANGED_IMPLEMENTATION", key: "k1", runId: "R1" }, { round: 1, fixture: "AMOUNT_UNIT_MISMATCH", key: "k2", runId: "R2" }], open: [{ round: 1, fixture: "APPROVED_PAYMENT", key: "ka", worst: WORST_APPROVED }] });
      api.state.runs.set("R1", doneRun("R1", "CHANGED_IMPLEMENTATION")); api.state.runs.set("R2", doneRun("R2", "AMOUNT_UNIT_MISMATCH"));
      expect(await dryRun()).toBe(0); // the open one is recovered first: nothing is remaining at the dry run
      expect(await execute()).toBe(1);
      expect(api.state.posts).toEqual([{ fixture: "APPROVED_PAYMENT", key: "ka" }]); // the replay only — the freed position was NOT started with too little
      expect(logs.join("\n")).toMatch(/unfinished run\(s\) need >= 0\.2632 — nothing more is started/);
      expect(readPlan().steps.acceptance.releasedRuns).toEqual(["run-1-APPROVED_PAYMENT:key:ka"]);
    });
  });
  it("classifyReplay and parseOpenId: the pure decisions behind the flow", () => {
    expect(classifyReplay(null, 1000)).toMatchObject({ kind: "ambiguous" });
    expect(classifyReplay({ status: 200, body: { runId: "r", admission: "existing" } }, 1000)).toEqual({ kind: "run", runId: "r", admission: "existing" });
    expect(classifyReplay({ status: 202, body: { runId: "r" } }, 1000)).toEqual({ kind: "run", runId: "r", admission: "new" });
    expect(classifyReplay({ status: 429, body: { error: "DEMO_COOLDOWN" } }, 1000)).toMatchObject({ kind: "retry", waitMs: 1000 });
    expect(classifyReplay({ status: 429, body: { error: "DEMO_BUDGET_EXHAUSTED" } }, 1000)).toMatchObject({ kind: "nothing-started" });
    expect(classifyReplay({ status: 503, body: { error: "DEMO_UNAVAILABLE" } }, 1000)).toMatchObject({ kind: "nothing-started" });
    expect(classifyReplay({ status: 503, body: { error: "EXECUTION_GATED" } }, 1000)).toMatchObject({ kind: "ambiguous" });
    expect(classifyReplay({ status: 500, body: null }, 1000)).toMatchObject({ kind: "ambiguous" });
    expect(parseOpenId("run-2-APPROVED_PAYMENT:key:mn-abc:run:11")).toEqual({ position: { round: 2, fixture: "APPROVED_PAYMENT" }, key: "mn-abc", runId: "11" });
    expect(parseOpenId("key:mn-legacy")).toEqual({ position: null, key: "mn-legacy", runId: null }); // the 40c5858 format: no fixture, no round
  });
});
