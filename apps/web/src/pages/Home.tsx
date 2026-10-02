import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, explorerAddr, type RunSummary } from "../lib/api";
import { Chip, DecisionBadge, Hex, Labels } from "../components/Badges";
import { Pipeline } from "../components/Pipeline";
import { ago, usdcToken } from "../lib/format";

const ARC_USES = [
  { t: "USDC is the gas — and it has two faces", d: "Native USDC has 18 decimals, the ERC-20 interface at 0x3600…0000 has 6, one balance behind both. ArcPreflight's AMOUNT_SEMANTICS check catches the 10¹² mistake before a signature exists.", tag: "AMOUNT_SEMANTICS" },
  { t: "Pinned reads at a verified block hash", d: "Every fact in a report is read with EIP-1898 block-hash pinning on Arc's public RPC, re-verified by number, and digested as raw evidence. Final validation repeats the critical reads at a new block before signing.", tag: "BLOCK_HASH pinning" },
  { t: "x402 settled by the Circle Facilitator on Arc", d: "The report is bought with one EIP-3009 TransferWithAuthorization (0.01 USDC, 6-dec units) settled through Circle's Facilitator on Arc — no custom payment contract, no allowance, no gas for the buyer.", tag: "x402 · EIP-3009" },
  { t: "Circle's own proxies as subjects", d: "GatewayWallet, FxEscrow and the ERC-8004 registries on Arc mainnet are minimal ERC-1967 proxies. The observer reads their slots raw and only then matches a verified template — unknown shapes stay 'unknown'.", tag: "ERC-1967 raw → template" },
];

export default function Home() {
  const { net } = useNet();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => { api.runs(6).then((r) => setRuns(r.runs)).catch(() => {}); }, []);
  return (
    <>
      <section className="section" style={{ paddingTop: 64 }}>
        <div className="container stack" style={{ gap: 22 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="kicker">Arc Microgrants · agentic economy</span>
            {net && <Chip tone={net.profile === "SUBMISSION_RESTRICTED" ? "warn" : "ok"}>{net.profile}</Chip>}
          </div>
          <h1 className="hero-title">Agents pay on Arc.<br />ArcPreflight proves the target is still <span className="g">what was approved</span> — before anything is signed.</h1>
          <p className="lead">A block-pinned preflight report bought over x402 with USDC on Arc, a deterministic decision in the agent's own process, final validation at a fresh block, an exact signed plan, and a verified business outcome. Unapproved implementation change → <b>REVIEW</b>. Wrong USDC units → <b>BLOCKED</b>. Approved → <b>paid and proven</b>.</p>
          <div className="row">
            <Link to="/demo" className="btn primary">▶ Run the live demo</Link>
            <Link to="/inspect" className="btn">Inspect any Arc contract</Link>
            <Link to="/developer" className="btn ghost">Developer console →</Link>
          </div>
          <div className="ticker">
            <span>chain <b>{net?.caip2 ?? "…"}</b></span>
            <span>head <b>{net?.head ? `#${net.head}` : "…"}</b></span>
            <span>report price <b>{net ? usdcToken(net.priceTokenAtomic) : "…"}</b></span>
            <span>live runs today <b>{net ? `${net.budget.usedToday}/${net.budget.maxRunsPerDay}` : "…"}</b></span>
            <span>release <b>{net?.release ?? "…"}</b></span>
          </div>
        </div>
      </section>

      <section className="section-tight">
        <div className="container card">
          <div className="card-title"><h3>One loop: sense → decide → act → verify</h3><span className="tiny dim">the report is decision support; the agent decides, signs, broadcasts and checks the outcome itself</span></div>
          <Pipeline idle />
        </div>
      </section>

      <section className="section">
        <div className="container stack" style={{ gap: 18 }}>
          <div><span className="kicker">Three outcomes, one code path</span><h2 style={{ marginTop: 6 }}>Same merchant ABI. Same calldata shape. Three different truths.</h2></div>
          <div className="grid-3">
            {(net?.fixtures ?? []).map((f) => (
              <Link key={f.id} to={`/demo?fixture=${f.id}`} className="card clickable stack" style={{ color: "inherit", textDecoration: "none" }}>
                <div className="row between"><span className="kicker">{f.id.replace(/_/g, " ")}</span><DecisionBadge decision={f.headline} size="sm" /></div>
                <h3>{f.title}</h3>
                <p className="small muted">{f.blurb}</p>
                <div className="tiny dim">merchant {f.merchant ? <Hex value={f.merchant} n={4} /> : "not deployed"}{f.upgradeTx && <> · upgraded A→B</>}</div>
              </Link>
            ))}
            {!net && [0, 1, 2].map((i) => <div key={i} className="card"><div className="spinner" /></div>)}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container stack" style={{ gap: 18 }}>
          <div><span className="kicker">What it uses Arc for</span><h2 style={{ marginTop: 6 }}>Arc-specific by construction, not by branding</h2></div>
          <div className="grid-2">
            {ARC_USES.map((u) => <div key={u.t} className="card stack" style={{ gap: 8 }}><Chip tone="info">{u.tag}</Chip><h3>{u.t}</h3><p className="small muted">{u.d}</p></div>)}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container grid-2">
          <div className="card stack">
            <span className="kicker">Honest by construction</span>
            <h3>Labels you can audit</h3>
            <Labels labels={["LIVE_REQUEST", "DEMO_ON_MAINNET", "RECORDED_SAMPLE"]} />
            <ul className="list">
              <li><b>LIVE_REQUEST</b> — the run you are watching happened on-chain just now; every hash links to the explorer.</li>
              <li><b>DEMO_ON_MAINNET</b> — the project's own runner, on Arc mainnet, against the project's own DemoMerchant fixtures.</li>
              <li><b>RECORDED_SAMPLE</b> — served when the live budget is exhausted; never presented as live.</li>
              <li><b>NO_POLICY_VIOLATION</b> means "no configured check fired at the pinned block", never "safe".</li>
              <li>Signals carry a <code>basis</code>: <code>chain_read</code>, <code>simulation</code>, or <code>network_advisory</code> (documentation-backed Arc rules, not target findings).</li>
            </ul>
          </div>
          <div className="card stack">
            <div className="card-title"><h3>Recent runs</h3><Link to="/demo" className="small">all runs →</Link></div>
            {runs.length === 0 && <div className="dim small">No runs yet — start one on the demo page.</div>}
            {runs.map((r) => (
              <Link key={r.runId} to={`/runs/${r.runId}`} className="row between" style={{ color: "inherit", textDecoration: "none", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="row" style={{ gap: 8 }}><DecisionBadge decision={r.businessStatus === "SUCCESS" ? "CONFIRMED" : r.decision ?? (r.state === "RUNNING" ? null : "FAILED")} size="sm" /><span className="small">{r.fixture.replace(/_/g, " ").toLowerCase()}</span></span>
                <span className="tiny dim">{ago(r.createdAt)}</span>
              </Link>
            ))}
            {net?.deployments && <div className="tiny dim">fixtures deployed {net.deployments.deployedAtUTC.slice(0, 10)} · MAIN <a href={explorerAddr(net, net.deployments.proxies.MAIN.address)} target="_blank" rel="noreferrer">{net.deployments.proxies.MAIN.address.slice(0, 10)}…</a></div>}
          </div>
        </div>
      </section>
    </>
  );
}
