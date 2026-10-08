// The result of a "Check with your wallet" flow (P3, v3.3): the same primary screen vocabulary as a project-runner run — one order, its
// referenced approval, its money, the decision — and the truthful next step: a NO_POLICY_VIOLATION check continues in the Developer
// workflow, where the service validates the exact plan and your wallet executes it; any other decision executes nothing.
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { Chip, DecisionBadge, Hex, NetworkChip, Spinner } from "./Badges";
import { Pipeline } from "./Pipeline";
import { StepLog } from "./StepLog";
import { ReportView } from "./Report";
import { Lifecycle } from "./Lifecycle";
import { Typewriter, narrate } from "./Typewriter";
import { explorerAddr, explorerTx, type FixtureInfo, type NetworkInfo } from "../lib/api";
import { checkDecidedLine, type WalletRun } from "../lib/walletRun";
import { LIFECYCLE_LABELS, type LifecycleStage } from "../lib/outcome";
import { decisionTone, ms, short, usdc6, usdcToken6 } from "../lib/format";

const FIXTURE_TITLES: Record<string, string> = { APPROVED_PAYMENT: "approved payment", CHANGED_IMPLEMENTATION: "unapproved implementation change", AMOUNT_UNIT_MISMATCH: "6-dec amount on the 18-dec path" };

/** The primary message (design §7) keyed on what was recorded — never preset success copy. */
export function walletMessageOf(run: WalletRun): { text: string; tone: "ok" | "warn" | "bad" | "info" | "neutral" } {
  if (run.phase === "running") return { text: "Check in progress — your wallet signs the check fee only.", tone: "info" };
  if (run.phase === "error") return { text: run.err?.text ?? "The check stopped.", tone: "bad" };
  const d = run.decision?.decision;
  if (d === "BLOCKED" || d === "REVIEW_REQUIRED") return { text: "This payment is outside the referenced approval.", tone: d === "BLOCKED" ? "bad" : "warn" };
  if (d === "NO_POLICY_VIOLATION") return { text: "No configured check fired at the pinned block. Execution continues in the Developer workflow with your wallet.", tone: "neutral" };
  return { text: "No recorded outcome.", tone: "neutral" };
}
/** the lifecycle of a check-only wallet run: it ends at the decision; execution is the Developer workflow's */
export function lifecycleFromWalletRun(run: WalletRun): LifecycleStage[] {
  const d = run.decision?.decision ?? null; const running = run.phase === "running";
  const st = (id: LifecycleStage["id"], status: LifecycleStage["status"], note?: string | null): LifecycleStage => ({ id, label: LIFECYCLE_LABELS[id], status, note: note ?? null });
  return [
    st("order", run.order ? "done" : running ? "active" : "todo", run.order ? `${run.order.proxy} proxy` : null),
    st("approve", run.intent ? "done" : run.order && running ? "active" : "todo", run.intent ? "approval referenced" : null),
    st("check", d ? (d === "BLOCKED" ? "stop" : d === "REVIEW_REQUIRED" ? "review" : "done") : run.phase === "error" ? "stop" : run.intent && running ? "active" : "todo", d ? d.toLowerCase().replace(/_/g, " ") : run.phase === "error" ? "stopped" : null),
    st("execute", run.handoff ? "todo" : d ? "skipped" : "todo", run.handoff ? "continues in the Developer workflow" : d ? "nothing executed" : null),
    st("recover", "skipped", "not needed"),
    st("passport", "todo", run.delivered ? "check passport in the Developer workflow" : null),
    st("verify", "todo"),
  ];
}

export function WalletRunPanel({ run, net, account, fixture }: { run: WalletRun; net: NetworkInfo | null; account: string | null; fixture?: FixtureInfo | null }) {
  const { link = (to: string) => to } = useNet();
  const running = run.phase === "running";
  const d = run.decision?.decision ?? null;
  const message = walletMessageOf(run);
  const narration = useMemo(() => run.steps.map(narrate).filter((x): x is string => !!x), [run.steps]);
  const rep = run.delivered?.report ?? null;
  const observedImpl = rep?.dependencies.find((x) => x.role === "IMPLEMENTATION")?.address ?? null;
  const approvedImpl = fixture?.approvedImplementation ?? null;
  const feeAtomic = run.quote?.response.quote.amountTokenAtomic ?? net?.priceTokenAtomic ?? null;
  const took = run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null;
  return (
    <div className="stack fade" style={{ gap: 24 }} data-testid="wallet-run">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
          <span className="serif" style={{ fontSize: "1.5rem" }}>{FIXTURE_TITLES[run.fixture ?? ""] ?? run.fixture}</span>
          <span className="row" style={{ gap: 6 }}><Chip tone="violet">WALLET_CHECK</Chip><NetworkChip network={net?.network} />{account && <Chip title={account}>payer {short(account, 4)}</Chip>}</span>
        </div>
        <div className="row" style={{ gap: 10 }}>{running ? <><Spinner /> <span className="small muted">live · {run.steps.length} steps</span></> : <span className="small dim">{took !== null ? ms(took) : ""}</span>}</div>
      </div>
      <Lifecycle stages={lifecycleFromWalletRun(run)} compact />

      <div className="panel outcome stack" style={{ gap: 14 }}>
        <div className="card-title" style={{ flexWrap: "wrap" }}>
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <span className="serif" style={{ fontSize: "1.25rem" }}>Order {run.order ? <Hex value={run.order.orderId} n={5} /> : <span className="dim">…</span>}</span>
            <Chip tone={net?.network === "mainnet" ? "violet" : "neutral"}>{net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</Chip>
            {run.order && <span className="tiny dim">{run.order.proxy} proxy · created at #{run.order.block}</span>}
          </div>
          <div className={`banner ${message.tone === "info" ? "info" : message.tone === "bad" ? "bad" : ""}`} style={{ margin: 0 }}>{message.text}</div>
        </div>
        <div className="two" style={{ gap: 28 }}>
          <div className="kv w190">
            <span className="k">merchant</span><span>{run.order ? <Hex value={run.order.merchant} n={5} link={explorerAddr(net, run.order.merchant)} /> : "—"}{run.order && <> · order tx <Hex value={run.order.tx} n={4} link={explorerTx(net, run.order.tx)} /></>}</span>
            <span className="k">approved implementation</span><span>{approvedImpl ? <Hex value={approvedImpl} n={5} link={explorerAddr(net, approvedImpl)} /> : "—"}{observedImpl && approvedImpl && observedImpl.toLowerCase() !== approvedImpl.toLowerCase() && <> · observed <Hex value={observedImpl} n={5} link={explorerAddr(net, observedImpl)} /></>}</span>
            <span className="k">referenced approval</span><span>{run.intent ? <><Hex value={run.intent.baselineDigest} n={6} />{rep && <> <Chip tone={rep.baselineResult === "MATCH" ? "ok" : rep.baselineResult === "NO_BASELINE" ? "bad" : "warn"}>{rep.baselineResult === "MATCH" ? "unchanged" : rep.baselineResult.toLowerCase().replace(/_/g, " ")}</Chip></>}</> : "—"}</span>
            <span className="k">business amount</span><span>{run.order ? usdc6(run.order.amountNativeAtomic) : "—"}{run.intent && run.order && run.intent.valueNativeAtomic !== run.order.amountNativeAtomic && <> <Chip tone="bad">candidate value {run.intent.valueNativeAtomic} atomic</Chip></>}</span>
            <span className="k">check fee</span><span>{feeAtomic ? usdcToken6(feeAtomic) : "—"}{run.delivered?.serviceFeeTx && <> · <Hex value={run.delivered.serviceFeeTx} link={explorerTx(net, run.delivered.serviceFeeTx)} /> <span className="tiny dim">signed by your wallet · relayed by the project</span></>}</span>
          </div>
          <div className="kv w190">
            <span className="k">decision</span><span>{run.decision ? <DecisionBadge decision={run.decision.decision} size="sm" /> : running ? <Spinner /> : "—"}</span>
            <span className="k">business transaction</span>
            <span>{run.handoff
              ? <span className="stack" style={{ gap: 6 }}><span><Chip tone="info">not executed here</Chip> <span className="small muted">{checkDecidedLine("NO_POLICY_VIOLATION")}</span></span><span><Link to={link("/developer#step-4")} className="btn sm primary">Execute from the Developer workflow with your wallet →</Link></span></span>
              : <><Chip tone={d === "BLOCKED" ? "bad" : "warn"}>not executed</Chip> <span className="small muted">{d ? checkDecidedLine(d) : running ? "the check is still running" : "no decision was recorded"}</span></>}</span>
            <span className="k">order result</span><span><Chip tone="neutral">unpaid</Chip> <span className="tiny dim">nothing was signed or sent from this wallet by the check</span></span>
            <span className="k">your record</span><span className="small">this order and check belong to this browser's anonymous session — they are listed under <Link to={link("/developer#step-5")}>My workflow</Link> on the Developer page, where recovery and the private Payment Passport live</span>
          </div>
        </div>
      </div>

      <div className="two" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 14 }}>
          <p className="caption">the agent, thinking out loud — narration is generated from the steps; the decision is code</p>
          <Typewriter lines={narration} speed={running ? 12 : 3} pause={running ? 350 : 90} className="monologue small" />
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <DecisionBadge decision={running ? null : d} />
          {run.decision && run.decision.reasons.length > 0 && <ul className="list">{run.decision.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {run.decision && (
            <div className="tablewrap fit"><table className="t"><tbody>{run.decision.checks.map((c) => <tr key={c.id}><td className="mono">{c.id}</td><td className="fit"><Chip tone={decisionTone(c.outcome)}>{c.outcome}</Chip></td></tr>)}</tbody></table></div>
          )}
        </div>
      </div>

      <div className="two stack-wide" style={{ gap: 44 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h3>Step by step</h3>
          <p className="tiny dim">who did what, and why — your wallet appears only where it signed</p>
          <Pipeline steps={run.steps} decision={d} running={running} />
          <StepLog steps={run.steps} net={net} />
        </div>
        <div className="stack" style={{ gap: 26 }}>
          {run.delivered && (
            <details open>
              <summary><b>The pinned report</b> <span className="tiny dim">— bought over x402 with your signature · delivered after settlement</span></summary>
              <div style={{ marginTop: 10 }}><ReportView report={run.delivered.report} digest={run.delivered.digest} net={net} compact /></div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
