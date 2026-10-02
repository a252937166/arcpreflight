import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, explorerAddr, explorerTx, type RunSummary } from "../lib/api";
import { Chip, DecisionBadge, Hex, Labels } from "../components/Badges";
import { ago, utc } from "../lib/format";

export default function Evidence() {
  const { net } = useNet();
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [reports, setReports] = useState<{ reportDigest: string; subject: string; mode: string; createdAt: string }[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [ready, setReady] = useState<any>(null);
  useEffect(() => { api.evidence().then((r) => setFiles(r.files)).catch(() => {}); api.publicReports().then((r) => setReports(r.reports)).catch(() => {}); api.runs(50).then((r) => setRuns(r.runs)).catch(() => {}); api.health().then(setReady).catch((e) => setReady(e?.body ?? null)); }, []);
  const d = net?.deployments;
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 18 }}>
        <div><span className="kicker">Evidence</span><h2 style={{ marginTop: 6 }}>Everything the demo claims, with the bytes to check it</h2></div>
        <div className="grid-4">
          <div className="card stat"><span className="v">{net?.release ?? "…"}</span><span className="l">release</span></div>
          <div className="card stat"><span className="v" style={{ fontSize: "1.05rem" }}>{net?.profile ?? "…"}</span><span className="l">release profile</span></div>
          <div className="card stat"><span className="v">{net?.caip2 ?? "…"}</span><span className="l">network</span></div>
          <div className="card stat"><span className="v" style={{ color: ready?.ready ? "#6ee7b7" : "#fcd34d" }}>{ready ? (ready.ready ? "ready" : ready.state ?? "degraded") : "…"}</span><span className="l">/health/ready {ready?.deps?.rpc?.ms ? `· rpc ${ready.deps.rpc.ms} ms` : ""}</span></div>
        </div>

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="card stack">
            <h3>Fixture deployments</h3>
            {d ? (
              <table className="t"><tbody>
                <tr><td>implA · DemoMerchantV1</td><td><Hex value={d.implA.address} n={6} link={explorerAddr(net, d.implA.address)} /></td><td className="tiny dim">code <Hex value={d.implA.codeHash} n={4} /></td></tr>
                <tr><td>implB · DemoMerchantV2</td><td><Hex value={d.implB.address} n={6} link={explorerAddr(net, d.implB.address)} /></td><td className="tiny dim">code <Hex value={d.implB.codeHash} n={4} /></td></tr>
                <tr><td>MAIN proxy (stays on A)</td><td><Hex value={d.proxies.MAIN.address} n={6} link={explorerAddr(net, d.proxies.MAIN.address)} /></td><td className="tiny dim">deploy <Hex value={d.proxies.MAIN.tx} n={4} link={explorerTx(net, d.proxies.MAIN.tx)} /></td></tr>
                <tr><td>CHANGED proxy (A → B)</td><td><Hex value={d.proxies.CHANGED.address} n={6} link={explorerAddr(net, d.proxies.CHANGED.address)} /></td><td className="tiny dim">upgrade <Hex value={d.proxies.CHANGED.upgradeTx} n={4} link={explorerTx(net, d.proxies.CHANGED.upgradeTx)} /> @ #{d.proxies.CHANGED.upgradeBlock}</td></tr>
              </tbody></table>
            ) : <div className="dim small">not deployed on this network</div>}
            <div className="tiny dim">{d ? `deployed ${utc(d.deployedAtUTC)} · solc ${d.compiler.solc} · ${d.compiler.evm} · runs ${d.compiler.optimizerRuns}` : ""}</div>
            <h3 style={{ marginTop: 8 }}>Approved baselines</h3>
            <table className="t"><tbody>{(net?.fixtures ?? []).map((f) => <tr key={f.id}><td className="small">{f.id.replace(/_/g, " ").toLowerCase()}</td><td>{f.baselineDigest ? <Hex value={f.baselineDigest} n={8} /> : <Chip tone="warn">none</Chip>}</td><td className="tiny dim">approved impl <Hex value={f.approvedImplementation} n={4} /> · live impl <Hex value={f.implementation} n={4} /></td></tr>)}</tbody></table>
            <h3 style={{ marginTop: 8 }}>Accounts</h3>
            <div className="kv" style={{ gridTemplateColumns: "140px 1fr" }}>
              <span className="k">deployer-admin</span><span><Hex value={net?.accounts.deployerAdmin} n={8} link={net?.accounts.deployerAdmin ? explorerAddr(net, net.accounts.deployerAdmin) : undefined} /></span>
              <span className="k">demo-runner</span><span><Hex value={net?.accounts.demoRunner} n={8} link={net?.accounts.demoRunner ? explorerAddr(net, net.accounts.demoRunner) : undefined} /></span>
              <span className="k">merchant payTo</span><span><Hex value={net?.accounts.merchantPayTo} n={8} link={net?.accounts.merchantPayTo ? explorerAddr(net, net.accounts.merchantPayTo) : undefined} /></span>
            </div>
          </div>
          <div className="card stack">
            <h3>Acceptance labels & release profile</h3>
            <Labels labels={["LIVE_REQUEST", "DEMO_ON_MAINNET", "RECORDED_SAMPLE"]} />
            <ul className="list">
              <li><code>SUBMISSION_RESTRICTED</code>: external paid API closed (only configured principals buy reports), wallet-popup execution off, USDC-transfer intent path off, SCA buyers off. Each is a <i>deferred feature</i> with its rejection tested, not a hidden gap.</li>
              <li>Reports carry <code>methodologyDigest</code> and <code>adapterManifestDigests</code>; receipts carry every upstream digest, so a run can be re-verified from the raw evidence alone.</li>
              <li>Gates: G0 read-only probes · G1 contracts + schema + observer tests · G2 three fixtures live + recovery · G3 hardening. The live demo page is G2.</li>
            </ul>
            <h3 style={{ marginTop: 8 }}>Published evidence files</h3>
            {files.length === 0 ? <div className="dim small">none published</div> : <ul className="list">{files.map((f) => <li key={f.path}><a href={`/v1/evidence/${f.path}`} target="_blank" rel="noreferrer" className="mono">{f.path}</a> <span className="tiny dim">{f.bytes} B</span></li>)}</ul>}
            <h3 style={{ marginTop: 8 }}>API</h3>
            <div className="small muted"><a href="/openapi.json" target="_blank" rel="noreferrer">/openapi.json</a> · <a href="/health/ready" target="_blank" rel="noreferrer">/health/ready</a> · <a href="/v1/network" target="_blank" rel="noreferrer">/v1/network</a> · <a href="/v1/demo/runs" target="_blank" rel="noreferrer">/v1/demo/runs</a></div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3>All demo runs</h3><span className="tiny dim">{runs.length} persisted</span></div>
          <table className="t">
            <thead><tr><th>When</th><th>Fixture</th><th>Outcome</th><th>Labels</th><th>Business tx</th><th>Service fee</th><th></th></tr></thead>
            <tbody>{runs.map((r) => <tr key={r.runId}><td className="tiny dim">{ago(r.createdAt)}</td><td className="small">{r.fixture.replace(/_/g, " ").toLowerCase()}</td><td><DecisionBadge decision={r.businessStatus === "SUCCESS" ? "CONFIRMED" : r.decision ?? r.state} size="sm" /></td><td><Labels labels={r.labels} /></td><td>{r.businessTxHash ? <Hex value={r.businessTxHash} n={5} link={explorerTx(net, r.businessTxHash)} /> : <span className="dim">—</span>}</td><td>{r.serviceFeeTx ? <Hex value={r.serviceFeeTx} n={5} link={explorerTx(net, r.serviceFeeTx)} /> : "—"}</td><td><Link to={`/runs/${r.runId}`} className="btn sm ghost">open</Link></td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <div className="card-title"><h3>Public object reports</h3><span className="tiny dim">cached observations with raw evidence</span></div>
          {reports.length === 0 ? <div className="dim small">none yet</div> : <table className="t"><tbody>{reports.map((r) => <tr key={r.reportDigest}><td className="tiny dim">{ago(r.createdAt)}</td><td><Link to={`/subjects/${r.subject}`}><Hex value={r.subject} n={6} /></Link></td><td className="small">{r.mode}</td><td><a href={`/v1/public-reports/${r.reportDigest}`} target="_blank" rel="noreferrer"><Hex value={r.reportDigest} n={6} /></a></td></tr>)}</tbody></table>}
        </div>
      </div>
    </section>
  );
}
