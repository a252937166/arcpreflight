import { describe, expect, it } from "vitest";
import { idleLifecycle, lifecycleFromRun, outcomeHeadline } from "../src/lib/outcome";
import { headlineOf, messageOf } from "../src/components/RunPanel";
import type { Run } from "../src/lib/api";
import { D, NOW, REQUEST } from "./fixtures";

// AP33-06: the headline follows the execution store (`run.outcome`), never the step log. Older runs without `outcome` fall back to receipts.
const base = (over: Partial<Run> & Record<string, any> = {}): Run => ({ runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: [], steps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, ...over });
const signedThenStopped = (kind: any, beState: string) => base({ state: kind === "BROADCAST_UNRESOLVED" ? "RECONCILE_REQUIRED" : "DONE", steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "reportDelivered", atMs: 3 }, { step: "decision", atMs: 4, decision: "NO_POLICY_VIOLATION" }, { step: "finalValidation", atMs: 5 }, { step: "signed", atMs: 6 }],
  outcome: { kind, text: "x", source: "store" }, businessExecution: { state: beState, txHash: D, nonce: 1, broadcastBlock: "10", consumedBy: null, note: null, validUntil: null } });

describe("outcome headline", () => {
  it("maps every outcome kind to a badge word, a tone and a sentence; the source is kept", () => {
    expect(outcomeHeadline(base({ outcome: { kind: "PAID", text: "", source: "store" } }))).toMatchObject({ text: "CONFIRMED", decision: "CONFIRMED", tone: "ok", message: "Order payment confirmed.", source: "store" });
    expect(outcomeHeadline(base({ outcome: { kind: "BROADCAST_UNRESOLVED", text: "", source: "store" } }))).toMatchObject({ text: "BROADCAST ATTEMPTED · OUTCOME NOT ESTABLISHED", tone: "warn" });
    expect(outcomeHeadline(base({ outcome: { kind: "SIGNED_NOT_BROADCAST", text: "", source: "store" } }))).toMatchObject({ text: "NOT SENT" });
    expect(outcomeHeadline(base({ outcome: { kind: "REVERTED", text: "", source: "store" } }))).toMatchObject({ tone: "bad", decision: "FAILED" });
    expect(outcomeHeadline(base({ outcome: { kind: "CONFIRMED_UNPAID", text: "", source: "store" } }))).toMatchObject({ text: "CONFIRMED · ORDER UNPAID", tone: "bad" });
    expect(outcomeHeadline(base({ outcome: { kind: "REVIEW_REQUIRED", text: "", source: "decision" } }))).toMatchObject({ decision: "REVIEW_REQUIRED", source: "decision", message: "This payment is outside the referenced approval." });
    expect(outcomeHeadline(base({ outcome: { kind: "BLOCKED", text: "", source: "decision" } }))).toMatchObject({ decision: "BLOCKED", tone: "bad" });
    expect(outcomeHeadline(base({ outcome: { kind: "RUNNING", text: "", source: "state" } }))).toMatchObject({ text: "RUNNING", tone: "info" });
    expect(outcomeHeadline(base({ outcome: { kind: "NOT_MINED", text: "", source: "store" } }))).toMatchObject({ text: "NOT MINED" });
    expect(outcomeHeadline(base({ outcome: { kind: "SUPERSEDED", text: "", source: "store" } }))).toMatchObject({ text: "SUPERSEDED" });
    expect(outcomeHeadline(base({ outcome: { kind: "FAILED", text: "", source: "state" } }))).toMatchObject({ text: "RUN FAILED" });
    expect(outcomeHeadline(base({ outcome: { kind: "NOT_SIGNED", text: "", source: "state" } }))).toMatchObject({ text: "NOT SIGNED" });
    expect(outcomeHeadline(base())).toBeNull(); expect(outcomeHeadline(base({ outcome: { kind: "SOMETHING_NEW" as any, text: "", source: "store" } }))).toBeNull();
  });
  it("a run whose last step is `signed` but whose store says BROADCAST_ATTEMPTED reads as a broadcast attempt, never 'nothing sent' (AP33-06)", () => {
    const run = signedThenStopped("BROADCAST_UNRESOLVED", "BROADCAST_ATTEMPTED");
    expect(headlineOf(run).text).toBe("BROADCAST ATTEMPTED · OUTCOME NOT ESTABLISHED"); expect(headlineOf(run).decision).toBeNull();
    expect(messageOf(run).text).toMatch(/A broadcast was attempted/); expect(messageOf(run).text).not.toMatch(/not sent|nothing sent/i);
    const paid = signedThenStopped("PAID", "CONFIRMED");
    expect(headlineOf(paid)).toEqual({ text: "CONFIRMED", decision: "CONFIRMED" }); expect(messageOf(paid)).toEqual({ text: "Order payment confirmed.", tone: "ok" });
  });
  it("runs recorded before v3.3 (no outcome) still map from their receipts", () => {
    const legacy = base({ result: { decision: { decision: "NO_POLICY_VIOLATION", reasons: [] }, execution: { chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: D, signedTransactionHash: D, labels: [] } } as any });
    expect(headlineOf(legacy).text).toBe("CONFIRMED"); expect(messageOf(legacy).text).toBe("Order payment confirmed.");
    const running = base({ state: "RUNNING", steps: [{ step: "settlementPending", atMs: 1 }] });
    expect(messageOf(running).text).toBe("Check fee awaiting reconciliation."); // the RUNNING outcome never hides the settlement-pending message
    expect(messageOf(base({ state: "RUNNING", outcome: { kind: "RUNNING", text: "running", source: "state" }, steps: [{ step: "settlementPending", atMs: 1 }] })).text).toBe("Check fee awaiting reconciliation.");
  });
});

describe("lifecycle from a run", () => {
  const ids = (s: ReturnType<typeof lifecycleFromRun>) => s.map((x) => `${x.id}:${x.status}`);
  it("idle: seven todo nodes in order", () => { expect(idleLifecycle().map((s) => s.id)).toEqual(["order", "approve", "check", "execute", "recover", "passport", "verify"]); expect(new Set(idleLifecycle().map((s) => s.status))).toEqual(new Set(["todo"])); });
  it("a paid run after a labelled interruption: order and approval done, check done, execute done, recover done, passport ready", () => {
    const run = base({ steps: ["orderPlanned", "createOrder", "intent", "quote", "signServiceFee", "reportDelivered", "decision", "finalValidation", "signed", "broadcastAttempted", "broadcast", "interruptedAfterBroadcast", "reconciled"].map((step, i) => ({ step, atMs: i, ...(step === "decision" ? { decision: "NO_POLICY_VIOLATION" } : {}), ...(step === "reconciled" ? { businessStatus: "SUCCESS" } : {}) })),
      outcome: { kind: "PAID", text: "", source: "store" }, businessExecution: { state: "CONFIRMED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null }, order: { orderId: D, state: "CONFIRMED", tx: D, block: "1", payer: "0x", merchant: "0x", amountNativeAtomic: "1", reference: "r", paid: true } });
    expect(ids(lifecycleFromRun(run))).toEqual(["order:done", "approve:done", "check:done", "execute:done", "recover:done", "passport:todo", "verify:todo"]);
    expect(lifecycleFromRun(run)[4].note).toMatch(/simulated interruption/);
    expect(ids(lifecycleFromRun(run, { exported: true, verified: true })).slice(5)).toEqual(["passport:done", "verify:done"]);
  });
  it("order creation is complete only once confirmed; a sent, failed or unknown creation is said as such (review 2026-10-09)", () => {
    const o = (state: string, over: Record<string, unknown> = {}) => ({ orderId: D, state, tx: D, block: null, payer: D, merchant: D, amountNativeAtomic: "1", reference: null, paid: null, ...over });
    const st = (step: string, i: number) => ({ step, atMs: i });
    const sent = lifecycleFromRun(base({ state: "RUNNING", steps: [st("orderPlanned", 1)], order: o("SENT") }));
    expect(ids(sent)[0]).toBe("order:active"); expect(sent[0].note).toBe("creation sent · waiting for the receipt"); expect(ids(sent)[1]).toBe("approve:todo");
    expect(ids(lifecycleFromRun(base({ state: "FAILED", steps: [st("orderPlanned", 1)], order: o("FAILED") })))[0]).toBe("order:stop");
    expect(lifecycleFromRun(base({ state: "FAILED", steps: [st("orderPlanned", 1)], order: o("FAILED") }))[0].note).toBe("creation failed");
    expect(ids(lifecycleFromRun(base({ state: "FAILED", steps: [st("orderPlanned", 1)], order: o("UNKNOWN_CREATION") })))[0]).toBe("order:warn");
    expect(ids(lifecycleFromRun(base({ state: "FAILED", steps: [st("orderPlanned", 1)], order: o("SENT") })))[0]).toBe("order:warn"); // the run ended while the creation was in flight
    expect(ids(lifecycleFromRun(base({ state: "RUNNING", steps: [st("orderPlanned", 1), st("createOrder", 2)], order: o("CONFIRMED", { block: "1" }) })))[0]).toBe("order:done");
    expect(ids(lifecycleFromRun(base({ steps: [st("createOrder", 1)] })))[0]).toBe("order:done"); // recorded before v3.3: no order object, the step counts
  });
  it("execution stays active while the run waits for the receipt (RUNNING + BROADCAST_ATTEMPTED); it warns only once the run has left RUNNING", () => {
    const run = base({ state: "RUNNING", steps: ["createOrder", "intent", "quote", "signServiceFee", "reportDelivered", "decision", "finalValidation", "signed", "broadcastAttempted", "broadcast"].map((step, i) => ({ step, atMs: i })),
      businessExecution: { state: "BROADCAST_ATTEMPTED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null } });
    expect(ids(lifecycleFromRun(run))).toEqual(["order:done", "approve:done", "check:done", "execute:active", "recover:skipped", "passport:todo", "verify:todo"]);
    expect(lifecycleFromRun(run)[3].note).toBe("broadcast · waiting for the receipt");
    expect(lifecycleFromRun({ ...run, steps: run.steps.slice(0, 8), businessExecution: null })[3].note).toBe("signed"); // signed, marker not yet written
    expect(ids(lifecycleFromRun({ ...run, state: "DONE", outcome: { kind: "BROADCAST_UNRESOLVED", text: "", source: "store" } }))[3]).toBe("execute:warn");
  });
  it("the final validation's recorded result decides: REVIEW_REQUIRED never reads as passed, and notSigned wins over any in-progress reading (review 2026-10-09)", () => {
    const st = (step: string, i: number, extra: Record<string, unknown> = {}) => ({ step, atMs: i, ...extra });
    const common = [st("createOrder", 1), st("intent", 2), st("quote", 3), st("signServiceFee", 4), st("reportDelivered", 5), st("decision", 6, { decision: "NO_POLICY_VIOLATION" })];
    const refusedRunning = lifecycleFromRun(base({ state: "RUNNING", steps: [...common, st("finalValidation", 7, { result: "REVIEW_REQUIRED", reasons: ["BALANCE: below the plan's maximum cost"] })] }));
    expect(ids(refusedRunning)[3]).toBe("execute:active"); expect(refusedRunning[3].note).toBe("final validation: review required"); expect(refusedRunning[3].note).not.toMatch(/passed/);
    const refused = lifecycleFromRun(base({ state: "DONE", outcome: { kind: "NOT_SIGNED", text: "", source: "state" }, steps: [...common, st("finalValidation", 7, { result: "REVIEW_REQUIRED" }), st("notSigned", 8)] }));
    expect(ids(refused)[3]).toBe("execute:warn"); expect(refused[3].note).toBe("final validation: review required — nothing signed");
    expect(lifecycleFromRun(base({ state: "RUNNING", steps: [...common, st("finalValidation", 7, { result: "PASS" })] }))[3].note).toBe("final validation passed");
    expect(lifecycleFromRun(base({ state: "RUNNING", steps: [...common, st("finalValidation", 7)] }))[3].note).toBe("final validation: not passed"); // no result recorded is not a pass
  });
  it("while the interrupted run waits for reconciliation: execute warns, recover is active", () => {
    const run = signedThenStopped("BROADCAST_UNRESOLVED", "BROADCAST_ATTEMPTED"); run.steps.push({ step: "broadcastAttempted", atMs: 7 }, { step: "broadcast", atMs: 8 }, { step: "interruptedAfterBroadcast", atMs: 9 });
    expect(ids(lifecycleFromRun(run))).toEqual(["order:done", "approve:done", "check:done", "execute:warn", "recover:active", "passport:todo", "verify:todo"]);
  });
  it("a BLOCKED check stops at the check; execution and recovery are skipped; a RUNNING run shows the active stage", () => {
    const blocked = base({ steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "decision", atMs: 3, decision: "BLOCKED" }], outcome: { kind: "BLOCKED", text: "", source: "decision" } });
    expect(ids(lifecycleFromRun(blocked))).toEqual(["order:done", "approve:done", "check:stop", "execute:skipped", "recover:skipped", "passport:todo", "verify:todo"]);
    const review = base({ steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "decision", atMs: 3, decision: "REVIEW_REQUIRED" }] });
    expect(lifecycleFromRun(review)[2].status).toBe("review");
    const running = base({ state: "RUNNING", steps: [{ step: "orderPlanned", atMs: 1 }] });
    expect(ids(lifecycleFromRun(running)).slice(0, 3)).toEqual(["order:active", "approve:todo", "check:todo"]);
    const checking = base({ state: "RUNNING", steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "signServiceFee", atMs: 3 }] });
    expect(ids(lifecycleFromRun(checking)).slice(0, 3)).toEqual(["order:done", "approve:done", "check:active"]);
  });
});
