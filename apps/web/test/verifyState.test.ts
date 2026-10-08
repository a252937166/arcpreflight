import { describe, expect, it } from "vitest";
import { verificationStageStatus, verificationState, type VerificationResult } from "../src/lib/verifyInBrowser";
import { lifecycleFromRun, verifyStage } from "../src/lib/outcome";
import { D, NOW, REQUEST } from "./fixtures";

// docs/LIFECYCLE.md §9 (review item 1c): "completed" is not "passed". passed = no FAIL and no UNVERIFIED; FAIL → red stop; UNVERIFIED → amber partial;
// NOT_EVALUATED never counts against.
const result = (statuses: Record<string, "PASS" | "FAIL" | "UNVERIFIED" | "NOT_EVALUATED">): VerificationResult => {
  const findings = Object.entries(statuses).map(([id, status]) => ({ id: id as any, status, detail: "" }));
  const counts = { pass: 0, fail: 0, unverified: 0, notEvaluated: 0 };
  for (const f of findings) { if (f.status === "PASS") counts.pass++; else if (f.status === "FAIL") counts.fail++; else if (f.status === "UNVERIFIED") counts.unverified++; else counts.notEvaluated++; }
  return { passportVersion: "1.0", subject: { kind: "wallet-run" }, chain: { chainId: 5042002, caip2: "eip155:5042002" }, findings, counts };
};
const ALL_PASS = { FILE_INTEGRITY: "PASS", DIGEST_INTEGRITY: "PASS", DISCLOSURE: "PASS", APPROVAL_SOURCE: "PASS", APPROVAL_COVERAGE: "PASS", NETWORK_IDENTITY: "PASS", FEE_ATTRIBUTION: "PASS", TRANSACTION_PLAN_AGREEMENT: "PASS", ORDER_OUTCOME: "PASS", COST_STATEMENT: "PASS", CURRENT_ELIGIBILITY: "NOT_EVALUATED" } as const;

describe("verification state", () => {
  it("passed only when no finding is FAIL and none is UNVERIFIED; NOT_EVALUATED does not count against", () => {
    const s = verificationState(result(ALL_PASS));
    expect(s).toMatchObject({ kind: "passed", tone: "ok", failing: [], unverified: [] });
    expect(s.text).toMatch(/^Passed/); expect(s.text).toContain("10 PASS · 1 NOT_EVALUATED");
    expect(verificationStageStatus(s.kind)).toBe("done");
  });
  it("any FAIL is a red stop state that names the failing findings, even with many PASS", () => {
    const s = verificationState(result({ ...ALL_PASS, FILE_INTEGRITY: "FAIL", COST_STATEMENT: "FAIL" }));
    expect(s).toMatchObject({ kind: "failed", tone: "bad", failing: ["FILE_INTEGRITY", "COST_STATEMENT"] });
    expect(s.text).toMatch(/^Verification FAILED — FILE_INTEGRITY, COST_STATEMENT/); expect(s.text).not.toMatch(/^Passed/);
    expect(verificationStageStatus(s.kind)).toBe("stop");
    // FAIL wins over UNVERIFIED
    expect(verificationState(result({ ...ALL_PASS, ORDER_OUTCOME: "FAIL", APPROVAL_SOURCE: "UNVERIFIED" })).kind).toBe("failed");
  });
  it("any UNVERIFIED without a FAIL is an amber partial state with the count", () => {
    const s = verificationState(result({ ...ALL_PASS, APPROVAL_SOURCE: "UNVERIFIED", ORDER_OUTCOME: "UNVERIFIED" }));
    expect(s).toMatchObject({ kind: "partial", tone: "warn", unverified: ["APPROVAL_SOURCE", "ORDER_OUTCOME"] });
    expect(s.text).toMatch(/^Partially verified \(2 unverified: APPROVAL_SOURCE, ORDER_OUTCOME\)/); expect(s.text).toContain("Not a pass");
    expect(verificationStageStatus(s.kind)).toBe("warn"); expect(verificationStageStatus(null)).toBe("todo");
  });
  it("the lifecycle rail's verify stage shows the check mark only for a pass", () => {
    expect(verifyStage("passed")).toEqual({ status: "done", note: "verified in this browser: passed" });
    expect(verifyStage(true).status).toBe("done"); // older callers
    expect(verifyStage("failed")).toMatchObject({ status: "stop" }); expect(verifyStage("partial")).toMatchObject({ status: "warn" }); expect(verifyStage(null)).toMatchObject({ status: "todo" }); expect(verifyStage(false).status).toBe("todo");
    const run: any = { runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: [], steps: [{ step: "createOrder", atMs: 1 }, { step: "intent", atMs: 2 }, { step: "decision", atMs: 3, decision: "NO_POLICY_VIOLATION" }], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), expected: null, headline: null, result: null, outcome: { kind: "PAID", text: "", source: "store" }, businessExecution: { state: "CONFIRMED", txHash: D, nonce: 1, broadcastBlock: "1", consumedBy: null, note: null, validUntil: null } };
    expect(lifecycleFromRun(run, { exported: true, verified: "failed" }).at(-1)).toMatchObject({ id: "verify", status: "stop" });
    expect(lifecycleFromRun(run, { exported: true, verified: "partial" }).at(-1)).toMatchObject({ id: "verify", status: "warn" });
    expect(lifecycleFromRun(run, { exported: true, verified: "passed" }).at(-1)).toMatchObject({ id: "verify", status: "done" });
  });
});
