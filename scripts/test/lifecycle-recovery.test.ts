// The lifecycle script's ACTUAL wallet-recovery flow (review of bf0c800, P2 "wallet recovery counts a receipt as completed acceptance"),
// run as a child process from a scratch directory against a fake ArcPreflight API and a fake Arc JSON-RPC node that serve a REAL verifiable
// wallet-run passport and its chain facts. Only the plan record, the visitor ledger and the private session store are pre-seeded, as a
// previous invocation would have left them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTEMPT_ID, AMOUNT, BIZ_GAS, WORST_WALLET, attemptView, evidenceFiles, fakeApi, fakeRpc, fixture, openId, orderView, passportFiles, readPlan, readWalletLedger, runScript, seedPlan, seedSessions, seedWalletLedger, writeKey } from "./helpers/lifecycle-fakes.js";

const f = fixture();
let root: string; let key: { path: string; address: string }; let closers: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "arcpf-lifecycle-")); key = writeKey(root); seedWalletLedger(root, f); });
afterEach(async () => { for (const c of closers.splice(0)) await c(); rmSync(root, { recursive: true, force: true }); });
async function world(o: { attempt: () => any; order?: () => any; bizStatus?: "0x1" | "0x0"; bizReceipt?: boolean; passportReady?: boolean }) {
  const rpc = fakeRpc(f, { bizStatus: o.bizStatus, bizReceipt: o.bizReceipt }); const rpcServer = await rpc.server;
  const api = fakeApi(f, rpcServer.url, { attempt: o.attempt, order: o.order, passportReady: o.passportReady }); const apiServer = await api.server;
  closers.push(apiServer.close, rpcServer.close);
  return { api, rpc, apiUrl: apiServer.url };
}
const walletRequests = (api: { requests: { url: string; auth: string | null }[] }) => api.requests.filter((r) => r.url.startsWith("/v1/wallet/"));
const sentEntry = () => readWalletLedger(root).entries.find((e: any) => e.purpose === "business payment");

describe("lifecycle wallet recovery — the scenario completes only on the full proof (review of bf0c800, P2)", () => {
  it("reproduction: a REVERTED attempt with a mined receipt no longer completes the scenario — the money is settled from the receipt (gas only), the plan is settled and stopped, the run fails naming the state, and no wallet success is recorded", async () => {
    seedPlan(root, key.address, { open: openId(f) }); seedSessions(root, f);
    const { api } = await world({ attempt: () => attemptView(f, { state: "REVERTED", businessStatus: "FAILED", costStatement: { ...attemptView(f).costStatement, buyer: { ...attemptView(f).costStatement.buyer, complete: false } } }), order: () => orderView({ paid: false }), bizStatus: "0x0" });
    const r = await runScript(root, key.path, (await api.server).url);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/did not succeed: attempt state REVERTED; business status FAILED/); expect(r.out).toMatch(/receipt status reverted/); expect(r.out).toMatch(/order .* reads paid=false/);
    const plan = readPlan(root).steps.lifecycle;
    expect(plan).toMatchObject({ status: "stopped", openRuns: [], pendingNativeAtomic: 0n, invocations: 2 }); expect(plan.settledRuns).toEqual([openId(f)]); // the money is final: settled, not kept pending
    expect(sentEntry()).toMatchObject({ status: "settled", actualNativeAtomic: BIZ_GAS.toString() }); // a reverted payment cost its gas only
    const ev = evidenceFiles(root); expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe("FAILED"); expect(ev[0].scenarios.wallet).toBeUndefined(); // no success record anywhere
    expect(ev[0].recovered[0]).toMatchObject({ action: "observe", succeeded: false, attemptId: ATTEMPT_ID, receiptStatus: "reverted", how: expect.stringContaining("did not succeed") });
    expect(passportFiles(root)).toEqual([]); // nothing was exported for a scenario that did not succeed
    expect(walletRequests(api).every((q) => q.auth === `Bearer ${"vs_" + "7".repeat(48)}`)).toBe(true); // observed through the recorded session only
  }, 180_000);
  it("control: a CONFIRMED/SUCCESS attempt whose receipt, plan comparison, order and costs agree, with the original passport exported through the recorded session and verified by the real CLI, completes the scenario; the visitor ledger settles to value + gas and the plan is done", async () => {
    seedPlan(root, key.address, { open: openId(f) }); seedSessions(root, f);
    const { api, rpc } = await world({ attempt: () => attemptView(f) });
    // the read-only preflight reads the record and the session store, asks the API nothing about the attempt, and says what a run would do
    const pre = await runScript(root, key.path, (await api.server).url, ["--preflight"]);
    expect(pre.status, pre.out).toBe(0); expect(pre.out).toMatch(/a run settles it first \(observe\): attempt .* is observed through the recorded session/); expect(walletRequests(api)).toEqual([]);
    const r = await runScript(root, key.path, (await api.server).url);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/verifier: exit 0, pass 10, fail 0/); expect(r.out).toMatch(/settled: attempt .* CONFIRMED\/SUCCESS .* passport exported through the recorded session and verified/);
    const ev = evidenceFiles(root); expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe("PASS"); expect(ev[0].scenarios.wallet).toMatchObject({ recoveredFromPreviousInvocation: true, attemptId: ATTEMPT_ID, txHash: f.hashes.BIZ_TX, outcome: { state: "CONFIRMED", businessStatus: "SUCCESS" }, receipt: { status: "success", gasUsed: "40364" } });
    expect(ev[0].scenarios.wallet.verifier.counts).toMatchObject({ fail: 0, pass: 10 }); expect(ev[0].scenarios.wallet.verifier.findings).toMatchObject({ TRANSACTION_PLAN_AGREEMENT: "PASS", ORDER_OUTCOME: "PASS", COST_STATEMENT: "PASS", FEE_ATTRIBUTION: "PASS" });
    expect(ev[0].recovered[0]).toMatchObject({ action: "observe", succeeded: true, attemptId: ATTEMPT_ID });
    expect(passportFiles(root).some((x) => x.endsWith(".passport.json"))).toBe(true); expect(passportFiles(root).some((x) => x.endsWith(".anchors.json"))).toBe(true);
    expect(sentEntry()).toMatchObject({ status: "settled", actualNativeAtomic: (AMOUNT + BIZ_GAS).toString() }); // value + gasUsed × effectiveGasPrice from the receipt
    expect(readPlan(root).steps.lifecycle).toMatchObject({ status: "done", openRuns: [], pendingNativeAtomic: 0n, settledRuns: [openId(f)] });
    const urls = api.requests.map((q) => q.url); expect(urls).toContain(`/v1/wallet/attempts/${ATTEMPT_ID}`); expect(urls).toContain(`/v1/wallet/attempts/${ATTEMPT_ID}/passport`); expect(urls).toContain(`/v1/demo/orders/${f.source.result!.orderId}`);
    expect(rpc.calls).toContain("eth_getTransactionReceipt"); expect(rpc.calls).toContain("eth_call"); // the receipt read by the script and the verifier's own chain reads
  }, 180_000);
  it("interrupted variants: an attempt still BROADCAST_ATTEMPTED with no receipt keeps the reservation and says retry; a record without a stored session is refused with the explicit-settle hint; a mismatching plan comparison or a missing passport never completes", async () => {
    // 1. still open on the server, nothing mined yet
    seedPlan(root, key.address, { open: openId(f) }); seedSessions(root, f);
    const w1 = await world({ attempt: () => attemptView(f, { state: "BROADCAST_ATTEMPTED", businessStatus: null, businessTxHash: null, block: null, deviations: null, passportAvailable: false, costStatement: null }), bizReceipt: false, passportReady: false });
    const r1 = await runScript(root, key.path, w1.apiUrl);
    expect(r1.status, r1.out).not.toBe(0); expect(r1.out).toMatch(/still BROADCAST_ATTEMPTED .* no receipt .* reservation is KEPT — retry later/);
    expect(readPlan(root).steps.lifecycle).toMatchObject({ openRuns: [openId(f)], pendingNativeAtomic: WORST_WALLET }); expect(sentEntry().status).toBe("sent"); expect(evidenceFiles(root)).toEqual([]);
    const polled = walletRequests(w1.api).length; expect(polled).toBeGreaterThanOrEqual(2); // the open attempt was polled through the recorded session during the bounded wait
    // 2. the session store is missing: nothing can be observed through the owning session — refused, explicit settle only
    rmSync(join(root, "data"), { recursive: true, force: true });
    const r2 = await runScript(root, key.path, w1.apiUrl);
    expect(r2.status, r2.out).not.toBe(0); expect(r2.out).toMatch(/no session for wallet-2026-10-10T07-00-00-000Z is stored/); expect(r2.out).toMatch(/LIFECYCLE_SETTLE_OPEN=wallet-2026-10-10T07-00-00-000Z:order:/);
    expect(readPlan(root).steps.lifecycle).toMatchObject({ openRuns: [openId(f)], pendingNativeAtomic: WORST_WALLET }); expect(walletRequests(w1.api)).toHaveLength(polled); // without a session nothing is asked of the API
    // 3. CONFIRMED but the server's plan comparison reports a mismatch: money settled, scenario NOT complete
    seedSessions(root, f);
    const w3 = await world({ attempt: () => attemptView(f, { deviations: { mismatch: ["value"], deviations: {} } }) });
    const r3 = await runScript(root, key.path, w3.apiUrl);
    expect(r3.status, r3.out).not.toBe(0); expect(r3.out).toMatch(/did not succeed: the transaction deviates from the plan in value/);
    expect(readPlan(root).steps.lifecycle).toMatchObject({ status: "stopped", openRuns: [], pendingNativeAtomic: 0n }); expect(sentEntry()).toMatchObject({ status: "settled", actualNativeAtomic: (AMOUNT + BIZ_GAS).toString() });
    expect(evidenceFiles(root).at(-1).scenarios.wallet).toBeUndefined();
    // 4. everything agrees but the passport cannot be exported: the proof is incomplete, the run stops (the plan was already settled by this invocation's money reading)
    seedPlan(root, key.address, { open: openId(f) }); seedSessions(root, f); seedWalletLedger(root, f);
    const w4 = await world({ attempt: () => attemptView(f), passportReady: false });
    const r4 = await runScript(root, key.path, w4.apiUrl);
    expect(r4.status, r4.out).not.toBe(0); expect(r4.out).toMatch(/passport export answered 409/);
    expect(evidenceFiles(root).every((e) => e.status !== "PASS")).toBe(true); // no PASS evidence from any run of this scenario
    expect(readPlan(root).steps.lifecycle).toMatchObject({ openRuns: [openId(f)], pendingNativeAtomic: WORST_WALLET }); // the proof is incomplete: the reservation is kept for a re-run once the passport exists
  }, 180_000);
});
