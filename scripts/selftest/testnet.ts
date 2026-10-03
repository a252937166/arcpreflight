// Explicit integration test: this spends only the project's Arc Testnet fixture funds. Never run on mainnet.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executionDigest, intentDigest, reportDigest, decisionDigest, finalValidationDigest, transactionPlanDigest } from "@arcpreflight/schema";

const api = process.env.API_URL ?? "http://127.0.0.1:4041";
const network = await fetch(`${api}/v1/network`).then((r) => r.json()) as any;
assert.equal(network.chainId, 5042002, "self-test requires Arc Testnet (5042002)");
assert.equal(network.network, "testnet");
assert.equal(process.env.ARC_NET, "testnet", "ARC_NET=testnet must be explicit");
const repeats = Number(process.env.SELFTEST_REPEATS ?? 3);
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
const fixtures = ["CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT"] as const;
const expected = ["REVIEW_REQUIRED", "BLOCKED", "NO_POLICY_VIOLATION"];
const runs: any[] = [];
for (let round = 1; round <= repeats; round++) {
  for (const [i, fixture] of fixtures.entries()) {
    const response = await fetch(`${api}/v1/demo/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixture }) });
    const start = await response.json() as any;
    assert.equal(response.status, 202, JSON.stringify(start));
    let run: any;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      run = await fetch(`${api}/v1/demo/runs/${start.runId}`).then((r) => r.json());
      if (run.state !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    assert.equal(run.state, "DONE", JSON.stringify(run.steps?.at(-1)));
    const out = run.result;
    assert.equal(out.decision.decision, expected[i]);
    assert.equal(intentDigest(out.intent), out.intentDigest);
    assert.equal(reportDigest(out.report), out.reportDigest);
    assert.equal(decisionDigest(out.decision), out.decisionDigest);
    assert.equal(executionDigest(out.execution), out.executionDigest);
    assert(out.serviceFeeTx, "service-fee settlement must have a real testnet transaction hash");
    assert.equal(out.chainId, 5042002);
    assert(!out.execution.labels.includes("DEMO_ON_MAINNET"));
    if (fixture === "APPROVED_PAYMENT") {
      assert.equal(out.execution.chainStatus, "CONFIRMED");
      assert.equal(out.execution.businessStatus, "SUCCESS");
      assert.equal(out.postcondition.paid, true);
      assert.equal(finalValidationDigest(out.finalValidation), out.execution.finalValidationDigest);
      assert.equal(transactionPlanDigest(out.plan), out.execution.transactionPlanDigest);
    } else {
      assert.equal(out.execution.chainStatus, "NOT_SIGNED");
      assert.equal(out.execution.businessStatus, "NOT_EXECUTED");
      assert.equal(out.execution.businessTxHash, null);
    }
    const summary = { round, fixture, runId: run.runId, decision: out.decision.decision, serviceFeeTx: out.serviceFeeTx,
      businessTxHash: out.execution.businessTxHash, businessStatus: out.execution.businessStatus, durationMs: out.durationMs, reportDigest: out.reportDigest };
    runs.push(summary);
    console.log(JSON.stringify(summary));
  }
}
const dir = resolve(process.env.SELFTEST_OUTPUT_DIR ?? "evidence/selftest");
mkdirSync(dir, { recursive: true });
const output = resolve(dir, `testnet-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(output, JSON.stringify({ chainId: 5042002, release: network.release, testedAtUTC: new Date().toISOString(), repeats, runs }, null, 2));
console.log(`PASS: ${runs.length} testnet runs; receipt digest chains and business outcomes verified. Evidence: ${output}`);
