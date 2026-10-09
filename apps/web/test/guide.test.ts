import { describe, expect, it } from "vitest";
import { guideFor, happenedOf, phaseOf } from "../src/lib/guide";
import type { Run } from "../src/lib/api";
import { D, NOW, REQUEST } from "./fixtures";

// Review of 2026-10-09 (items 2–5): the guide is derived from the recorded run — its state, steps and store outcome — never from preset copy.
const NET: any = { network: "testnet", chainId: 5042002, explorer: "https://testnet.arcscan.app" };
const base = (over: Partial<Run> & Record<string, any> = {}): Run => ({ runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: [], steps: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, ...over });
const steps = (...names: string[]) => names.map((step, i) => ({ step, atMs: i }));
const paid = (over: Record<string, any> = {}) => base({ steps: [...steps("orderPlanned", "createOrder", "intent", "quote", "signServiceFee", "reportDelivered"), { step: "decision", atMs: 6, decision: "NO_POLICY_VIOLATION" }, ...steps("finalValidation", "signed", "broadcastAttempted", "broadcast", "postcondition")],
  outcome: { kind: "PAID", text: "", source: "store" }, order: { orderId: D, state: "CONFIRMED", tx: D, block: "1", payer: D, merchant: D, amountNativeAtomic: "1", reference: null, paid: true },
  businessExecution: { state: "CONFIRMED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null, businessStatus: "SUCCESS" }, ...over });

describe("phaseOf: the moment a run is in", () => {
  it("names waiting, checking, broadcasting, recovering, confirmed, stopped and failed from the records", () => {
    expect(phaseOf(null)).toBe("idle");
    expect(phaseOf(base({ state: "RUNNING" }))).toBe("waiting");
    expect(phaseOf(base({ state: "RUNNING", steps: steps("orderPlanned", "createOrder", "intent", "quote", "signServiceFee", "settlementPending") }))).toBe("waiting");
    expect(phaseOf(base({ state: "RUNNING", steps: steps("orderPlanned", "createOrder", "intent") }))).toBe("checking");
    expect(phaseOf(base({ state: "RUNNING", steps: steps("createOrder", "decision", "finalValidation", "signed", "broadcastAttempted", "broadcast") }))).toBe("broadcasting");
    expect(phaseOf(base({ state: "RECONCILE_REQUIRED", steps: steps("broadcast", "interruptedAfterBroadcast") }))).toBe("recovering");
    expect(phaseOf(paid())).toBe("confirmed");
    expect(phaseOf(base({ outcome: { kind: "SUPERSEDED", text: "", source: "store" } }))).toBe("confirmed");
    expect(phaseOf(base({ outcome: { kind: "BROADCAST_UNRESOLVED", text: "", source: "store" } }))).toBe("recovering");
    expect(phaseOf(base({ outcome: { kind: "BLOCKED", text: "", source: "decision" } }))).toBe("stopped");
    expect(phaseOf(base({ outcome: { kind: "REVIEW_REQUIRED", text: "", source: "decision" } }))).toBe("stopped");
    for (const kind of ["NOT_MINED", "REVERTED", "CONFIRMED_UNPAID", "SIGNED_NOT_BROADCAST", "NOT_SIGNED", "FAILED"]) expect(phaseOf(base({ outcome: { kind, text: "", source: "store" } })), kind).toBe("failed");
    // runs recorded before v3.3 (no outcome): decision and receipts decide
    expect(phaseOf(base({ steps: steps("decision"), result: { decision: { decision: "BLOCKED" } } as any }))).toBe("stopped");
    expect(phaseOf(base({ result: { execution: { chainStatus: "CONFIRMED", businessStatus: "SUCCESS" } } as any }))).toBe("confirmed");
    expect(phaseOf(base({ result: { execution: { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN" } } as any }))).toBe("recovering");
    expect(phaseOf(base({ state: "FAILED" }))).toBe("failed");
  });
});

describe("guideFor: what happened, what to do next, what to inspect", () => {
  it("idle: pick and run; nothing is charged to the visitor", () => {
    const g = guideFor(null, NET);
    expect(g.phase).toBe("idle"); expect(g.happened).toMatch(/your wallet is not charged/);
    expect(g.next).toMatchObject({ label: "Run the project-funded demo", target: "run-start" });
    expect(g.checkpoints.map((c) => `${c.id}:${c.status}`)).toEqual(["order:current", "check:todo", "payment:todo", "explorer:todo", "passport:todo", "verify:todo"]);
  });
  it("while running, the created order can already be inspected; the run continues meanwhile", () => {
    const run = base({ state: "RUNNING", steps: steps("orderPlanned", "createOrder", "intent"), order: { orderId: D, state: "CONFIRMED", tx: D, block: "1", payer: D, merchant: D, amountNativeAtomic: "1", reference: null, paid: false } });
    const g = guideFor(run, NET);
    expect(g.phase).toBe("checking"); expect(g.happened).toBe("Exact intent built against the order");
    expect(g.next).toMatchObject({ label: "Inspect the created order", target: "sec-order", checkpoint: "order", hint: "the run continues meanwhile" });
    expect(g.checkpoints.find((c) => c.id === "check")?.status).toBe("pending"); expect(g.checkpoints.find((c) => c.id === "payment")?.status).toBe("pending");
    const seen = guideFor(run, NET, { visited: ["order"] });
    expect(seen.next).toMatchObject({ label: "Watch the steps", target: "sec-steps" }); expect(seen.inspect).toMatch(/order, pinned report/);
  });
  it("broadcasting and recovering name the moment; recovery points at the desk and the original hash", () => {
    const run = base({ state: "RECONCILE_REQUIRED", steps: steps("createOrder", "decision", "signed", "broadcastAttempted", "broadcast", "interruptedAfterBroadcast"), businessExecution: { state: "BROADCAST_ATTEMPTED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null } });
    const g = guideFor(run, NET, { visited: ["order", "check"] });
    expect(g.phase).toBe("recovering"); expect(g.happened).toMatch(/simulated interruption/);
    expect(g.next).toMatchObject({ label: "Recover this attempt", target: "sec-recovery" }); expect(g.inspect).toMatch(/original transaction hash/);
    expect(g.interrupted).toEqual({ hash: D, status: "recovering" });
    expect(g.checkpoints.find((c) => c.id === "explorer")).toMatchObject({ status: "pending", external: true, target: expect.stringContaining(D) });
    expect(phaseOf(base({ state: "RUNNING", steps: steps("createOrder", "decision", "signed", "broadcastAttempted") }))).toBe("broadcasting");
  });
  it("a confirmed run walks order → check → payment → explorer → passport → verify, then hands over to the Developer workflow", () => {
    const run = paid();
    let g = guideFor(run, NET);
    expect(g.phase).toBe("confirmed"); expect(g.happened).toBe("Order read back from the chain: not paid"); // the fixture's postcondition step carries no `paid` field
    expect(g.next).toMatchObject({ label: "Inspect the created order", checkpoint: "order" });
    g = guideFor(run, NET, { visited: ["order"] }); expect(g.next).toMatchObject({ label: "Review the check result", target: "sec-check" }); expect(g.inspect).toMatch(/decision, its reasons/);
    g = guideFor(run, NET, { visited: ["order", "check"] }); expect(g.next).toMatchObject({ label: "Inspect the payment outcome", target: "sec-payment" });
    g = guideFor(run, NET, { visited: ["order", "check", "payment"] }); expect(g.next).toMatchObject({ label: "Open the transaction in the explorer", external: true, target: `https://testnet.arcscan.app/tx/${D}` });
    g = guideFor(run, NET, { visited: ["order", "check", "payment", "explorer"] }); expect(g.next).toMatchObject({ label: "Download the Payment Passport", target: "btn-passport" });
    g = guideFor(run, NET, { visited: ["order", "check", "payment", "explorer"], exported: true }); expect(g.next).toMatchObject({ label: "Verify the passport here", target: "sec-verify" });
    g = guideFor(run, NET, { visited: ["order", "check", "payment", "explorer"], exported: true, verified: "passed" });
    expect(g.next).toMatchObject({ label: "Try it with your wallet", target: "/developer", route: true }); expect(g.checkpoints.every((c) => c.status === "done")).toBe(true);
    g = guideFor(run, NET, { visited: ["order", "check", "payment", "explorer"], exported: true, verified: "failed" });
    expect(g.next).toMatchObject({ label: "Verify the passport here" }); expect(g.checkpoints.find((c) => c.id === "verify")?.hint).toMatch(/verification failed/);
  });
  it("a run stopped by the check explains why and marks payment and explorer as not applicable; the passport still exists", () => {
    const run = base({ steps: [...steps("createOrder", "intent", "quote", "signServiceFee", "reportDelivered"), { step: "decision", atMs: 9, decision: "REVIEW_REQUIRED", reasons: ["BASELINE_STATUS: the implementation changed since the approval"] }, { step: "notSigned", atMs: 10 }],
      outcome: { kind: "REVIEW_REQUIRED", text: "", source: "decision" }, order: { orderId: D, state: "CONFIRMED", tx: D, block: "1", payer: D, merchant: D, amountNativeAtomic: "1", reference: null, paid: false } });
    const g = guideFor(run, NET, { visited: ["order"] });
    expect(g.phase).toBe("stopped"); expect(g.blocked).toBe("The check stopped the payment: BASELINE_STATUS: the implementation changed since the approval");
    expect(g.next).toMatchObject({ label: "Review the check result", target: "sec-check" });
    expect(g.checkpoints.map((c) => `${c.id}:${c.status}`)).toEqual(["order:done", "check:current", "payment:na", "explorer:na", "passport:todo", "verify:pending"]);
    expect(g.checkpoints.find((c) => c.id === "payment")?.hint).toMatch(/nothing was signed/);
    expect(happenedOf(run)).toBe("Nothing was signed");
  });
  it("a failed run and a run without steps still get honest sentences", () => {
    expect(guideFor(base({ state: "FAILED", steps: steps("createOrder", "error") }), NET)).toMatchObject({ phase: "failed", happened: "The run hit an error" });
    expect(happenedOf(base({ state: "RUNNING" }))).toMatch(/admitted/); expect(happenedOf(base())).toBe("No steps were recorded");
    expect(happenedOf(base({ steps: [{ step: "decision", atMs: 1, decision: "NO_POLICY_VIOLATION" }] }))).toBe("Decision: no policy violation");
    expect(happenedOf(base({ steps: [{ step: "reconciled", atMs: 1, chainStatus: "CONFIRMED", businessStatus: "SUCCESS" }] }))).toBe("Recovered from the original hash and the order state: confirmed / success");
  });
});
