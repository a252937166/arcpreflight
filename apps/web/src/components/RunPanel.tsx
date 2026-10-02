import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Chip, DecisionBadge, Hex, Labels, Spinner } from "./Badges";
import { Pipeline } from "./Pipeline";
import { StepLog } from "./StepLog";
import { ReportView } from "./Report";
import { Typewriter, narrate } from "./Typewriter";
import { explorerAddr, explorerTx, type NetworkInfo, type Run } from "../lib/api";
import { ago, ms, usdcNative, utc } from "../lib/format";

const FIXTURE_TITLES: Record<string, string> = { APPROVED_PAYMENT: "approved payment", CHANGED_IMPLEMENTATION: "unapproved implementation change", AMOUNT_UNIT_MISMATCH: "6-dec amount on the 18-dec path" };

export function headlineOf(run: Run): { text: string; decision: string | null } {
  const d = run.result?.decision?.decision ?? (run.steps.find((s) => s.step === "decision")?.decision as string | undefined) ?? null;
  if (run.state === "FAILED") return { text: "RUN FAILED", decision: "FAILED" };
  if (!d) return { text: "RUNNING", decision: null };
  if (d === "NO_POLICY_VIOLATION") { const bs = run.result?.execution?.businessStatus; return bs === "SUCCESS" ? { text: "CONFIRMED", decision: "CONFIRMED" } : bs === "FAILED" ? { text: "EXECUTION FAILED", decision: "FAILED" } : { text: "NO POLICY VIOLATION", decision: d }; }
  return { text: d.replace(/_/g, " "), decision: d };
}

export function RunPanel({ run, net, sample }: { run: Run; net: NetworkInfo | null; sample?: boolean }) {
  const r = run.result;
  const running = run.state === "RUNNING";
  const head = headlineOf(run);
  const labels = sample ? [...run.labels.filter((l) => l !== "LIVE_REQUEST"), "RECORDED_SAMPLE"] : run.labels;
  const decisionStep = run.steps.find((s) => s.step === "decision");
  const reasons = (r?.decision?.reasons ?? (decisionStep?.reasons as string[] | undefined) ?? []) as string[];
  const narration = useMemo(() => run.steps.map(narrate).filter((x): x is string => !!x), [run.steps]);
  return (
    <div className="stack fade" style={{ gap: 28 }}>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
          <span className="serif" style={{ fontSize: "1.5rem" }}>{FIXTURE_TITLES[run.fixture] ?? run.fixture}</span>
          <Labels labels={labels} network={r?.network ?? net?.network} />
        </div>
        <div className="row" style={{ gap: 10 }}>
          {running ? <><Spinner /> <span className="small muted">live · {run.steps.length} steps</span></> : <span className="small dim">{run.result ? ms(run.result.durationMs) : ""} · {ago(run.updatedAt)}</span>}
          <Link to={`/runs/${run.runId}`} className="tiny dim" title="permanent link">#{run.runId.slice(0, 8)}</Link>
        </div>
      </div>
      <Pipeline steps={run.steps} decision={head.decision === "CONFIRMED" ? "NO_POLICY_VIOLATION" : head.decision} running={running} />

      <div className="two" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 14 }}>
          <p className="caption">the agent, thinking out loud — narration is generated from the receipts; the decision is code</p>
          <Typewriter lines={narration} speed={running ? 12 : 3} pause={running ? 350 : 90} className="monologue small" />
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <DecisionBadge decision={head.text === "RUNNING" ? null : head.decision === "CONFIRMED" ? "CONFIRMED" : head.decision} />
          {run.expected && !running && r && <p className="small muted">expected <code>{run.expected}</code>, got <code>{r.decision.decision}</code> {r.decision.decision === run.expected ? <Chip tone="ok">as expected</Chip> : <Chip tone="bad">unexpected</Chip>}</p>}
          {reasons.length > 0 && <ul className="list">{reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {r && (
            <div className="kv" style={{ gridTemplateColumns: "120px 1fr", marginTop: 6 }}>
              <span className="k">order</span><span><Hex value={r.orderId} /> · {usdcNative(r.intent.businessExpectation.amountNativeAtomic, 2)}</span>
              <span className="k">merchant</span><span><Hex value={r.merchant} n={5} link={explorerAddr(net, r.merchant)} /></span>
              <span className="k">service fee</span><span>{r.serviceFeeTx ? <><Hex value={r.serviceFeeTx} link={explorerTx(net, r.serviceFeeTx)} /> <span className="tiny dim">0.01 USDC · Circle Facilitator</span></> : "—"}</span>
              <span className="k">business tx</span><span>{r.execution.businessTxHash ? <><Hex value={r.execution.businessTxHash} link={explorerTx(net, r.execution.businessTxHash)} /> <Chip tone={r.execution.businessStatus === "SUCCESS" ? "ok" : "bad"}>{r.execution.chainStatus} / {r.execution.businessStatus}</Chip></> : <Chip tone={head.decision === "BLOCKED" ? "bad" : "warn"}>{r.execution.chainStatus} · {r.execution.businessStatus}</Chip>}</span>
              {r.postcondition && <><span className="k">postcondition</span><span><Chip tone={r.postcondition.paid ? "ok" : "bad"}>paid={String(r.postcondition.paid)}</Chip> payer <Hex value={r.postcondition.payer} n={4} /> amount {usdcNative(r.postcondition.amountNativeAtomic, 2)} @ #{r.postcondition.block}</span></>}
            </div>
          )}
        </div>
      </div>

      <div className="two" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h3>Step by step</h3>
          <p className="tiny dim">who did what, and why — straight from the runner</p>
          <StepLog steps={run.steps} net={net} />
        </div>
        <div className="stack" style={{ gap: 26 }}>
          {r && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Receipt chain</h3>
              <p className="tiny dim">every digest is keccak256 over canonical JSON, schema 1.0</p>
              <div className="kv" style={{ gridTemplateColumns: "150px 1fr" }}>
                <span className="k">intent</span><span><Hex value={r.intentDigest} n={8} /></span>
                <span className="k">policy</span><span><Hex value={r.policyDigest} n={8} /></span>
                <span className="k">report</span><span><Hex value={r.reportDigest} n={8} /></span>
                <span className="k">baseline</span><span><Hex value={r.report.baselineDigest} n={8} /> <Chip tone={r.report.baselineResult === "MATCH" ? "ok" : "warn"}>{r.report.baselineResult}</Chip></span>
                <span className="k">decision</span><span><Hex value={r.decisionDigest} n={8} /></span>
                {r.finalValidation && <><span className="k">final validation</span><span><Chip tone={r.finalValidation.result === "PASS" ? "ok" : "warn"}>{r.finalValidation.result}</Chip> @ #{r.finalValidation.snapshot.blockNumber} · balance {usdcNative(r.finalValidation.balanceNativeAtomic, 3)} · gas reserve {usdcNative(r.finalValidation.reservedGasNativeAtomic, 6)}</span></>}
                {r.plan && <><span className="k">plan</span><span><Hex value={r.execution.transactionPlanDigest as string} n={8} /> · type {r.plan.type} · nonce {r.plan.nonce} · gas {r.plan.gasLimit} · {(Number(r.plan.maxFeePerGasNativeAtomic) / 1e9).toFixed(1)} gwei</span></>}
                {r.execution.signedTransactionHash && <><span className="k">signed tx</span><span><Hex value={r.execution.signedTransactionHash} n={8} /></span></>}
                <span className="k">execution</span><span><Hex value={r.executionDigest} n={8} /></span>
                <span className="k">recorded</span><span>{utc(r.execution.recordedAt as string)}</span>
              </div>
            </div>
          )}
          {r && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>The pinned report</h3>
              <p className="tiny dim">bought over x402 · delivered after settlement</p>
              <ReportView report={r.report} digest={r.reportDigest} net={net} compact />
            </div>
          )}
          {r && <details><summary>raw run JSON (intent, policy, report, receipts)</summary><pre className="json" style={{ marginTop: 10 }}>{JSON.stringify(r, null, 2)}</pre></details>}
        </div>
      </div>
    </div>
  );
}
