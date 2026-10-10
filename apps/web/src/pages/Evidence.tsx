import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, apiPath, explorerAddr, explorerTx, type RunSummary } from "../lib/api";
import { Chip, Hex, Labels } from "../components/Badges";
import { HandRule, ReceiptChain } from "../components/Illustrations";
import { RunsTable } from "../components/RunsTable";
import { EvidenceFiles } from "../components/EvidenceFiles";
import { ShowMore } from "../components/ShowMore";
import { limited, LIST_PAGE } from "../lib/evidenceFiles";
import { ago, utc, type Tone } from "../lib/format";
import { fundsSummary, fundsWarning } from "../lib/funds";
import type { Capability } from "../lib/api";

const CAP_TONE: Record<Capability["status"], Tone> = { MAINNET_VERIFIED: "violet", IMPLEMENTED_TESTNET: "info", PROPOSED: "warn", DISABLED: "neutral" };

const PAGE = 12; // a page of runs at a time, like the Demo page (review of 2026-10-10: no fifty-row dumps)

export default function Evidence() {
  const { net, link = (to: string) => to } = useNet();
  const funds = fundsSummary(net); const warning = fundsWarning(funds, net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet");
  const [files, setFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [reports, setReports] = useState<{ reportDigest: string; subject: string; mode: string; createdAt: string }[]>([]);
  const [history, setHistory] = useState<{ runs: RunSummary[]; total?: number; more: boolean }>({ runs: [], total: undefined, more: false });
  const [ready, setReady] = useState<any>(null);
  const [reportLimit, setReportLimit] = useState(LIST_PAGE);
  useEffect(() => { api.evidence().then((r) => setFiles(r.files)).catch(() => {}); api.publicReports().then((r) => setReports(r.reports)).catch(() => {}); api.runs(PAGE, 0).then((r) => setHistory({ runs: r.runs ?? [], total: r.total ?? (r.runs ?? []).length, more: false })).catch(() => {}); api.health().then(setReady).catch((e) => setReady(e?.body ?? null)); }, []);
  const loadMore = useCallback(() => {
    setHistory((h) => ({ ...h, more: true }));
    api.runs(PAGE, history.runs.length).then((r) => setHistory((h) => ({ runs: [...h.runs, ...(r.runs ?? []).filter((x) => !h.runs.some((y) => y.runId === x.runId))], total: r.total ?? h.total, more: false }))).catch(() => setHistory((h) => ({ ...h, more: false })));
  }, [history.runs.length]);
  const d = net?.deployments;
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 30 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="kicker">Evidence</div>
          <h2>Everything the demo claims, <em>with the bytes to check it.</em></h2>
        </div>
        <div className="row" style={{ gap: 44 }}>
          <div className="stat"><div className="v">{net?.release ?? "…"}</div><div className="l">release</div></div>
          <div className="stat"><div className="v" style={{ fontSize: "1.3rem", paddingTop: 8 }}>{net?.profile ?? "…"}</div><div className="l">release profile</div></div>
          <div className="stat"><div className="v">{net?.caip2 ?? "…"}</div><div className="l">network</div></div>
          <div className="stat"><div className="v" style={{ color: ready?.ready ? "var(--mint)" : "var(--amber)" }}>{ready ? (ready.ready ? "ready" : ready.state ?? "degraded") : "…"}</div><div className="l">/health/ready{ready?.deps?.rpc?.ms ? ` · rpc ${ready.deps.rpc.ms} ms` : ""}</div></div>
        </div>
        <HandRule />

        <div className="two">
          <div className="stack" style={{ gap: 22 }}>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Fixture deployments</h3>
              {d ? (
                <div className="tablewrap fit"><table className="t"><tbody>
                  <tr><td>implA · DemoMerchantV1</td><td><Hex value={d.implA.address} n={6} link={explorerAddr(net, d.implA.address)} /></td><td className="tiny dim">code <Hex value={d.implA.codeHash} n={4} /></td></tr>
                  <tr><td>implB · DemoMerchantV2</td><td><Hex value={d.implB.address} n={6} link={explorerAddr(net, d.implB.address)} /></td><td className="tiny dim">code <Hex value={d.implB.codeHash} n={4} /></td></tr>
                  <tr><td>MAIN proxy (stays on A)</td><td><Hex value={d.proxies.MAIN.address} n={6} link={explorerAddr(net, d.proxies.MAIN.address)} /></td><td className="tiny dim">deploy <Hex value={d.proxies.MAIN.tx} n={4} link={explorerTx(net, d.proxies.MAIN.tx)} /></td></tr>
                  <tr><td>CHANGED proxy (A → B)</td><td><Hex value={d.proxies.CHANGED.address} n={6} link={explorerAddr(net, d.proxies.CHANGED.address)} /></td><td className="tiny dim">upgrade <Hex value={d.proxies.CHANGED.upgradeTx} n={4} link={explorerTx(net, d.proxies.CHANGED.upgradeTx)} /> @ #{d.proxies.CHANGED.upgradeBlock}</td></tr>
                </tbody></table></div>
              ) : <p className="dim small">not deployed on this network</p>}
              {d && <p className="tiny dim">deployed {utc(d.deployedAtUTC)} · solc {d.compiler.solc} · {d.compiler.evm} · optimizer runs {d.compiler.optimizerRuns}</p>}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Approved baselines</h3>
              <div className="tablewrap fit"><table className="t"><tbody>{(net?.fixtures ?? []).map((f) => <tr key={f.id}><td className="small">{f.id.replace(/_/g, " ").toLowerCase()}</td><td>{f.baselineDigest ? <Hex value={f.baselineDigest} n={8} /> : <Chip tone="warn">none</Chip>}</td><td className="tiny dim">approved impl <Hex value={f.approvedImplementation} n={4} /> · live impl <Hex value={f.implementation} n={4} /></td></tr>)}</tbody></table></div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Accounts</h3>
              <div className="kv w140">
                <span className="k">deployer-admin</span><span><Hex value={net?.accounts.deployerAdmin} n={8} link={net?.accounts.deployerAdmin ? explorerAddr(net, net.accounts.deployerAdmin) : undefined} /> <span className="tiny dim">owner: upgrade, pause, withdraw — {net?.accounts.adminKeyInProcess ? "loaded by the API on this deployment" : "off the API"}</span></span>
                <span className="k">order-creator</span><span><Hex value={net?.accounts.orderCreator} n={8} link={net?.accounts.orderCreator ? explorerAddr(net, net.accounts.orderCreator) : undefined} /> <span className="tiny dim">creates orders only · signs as <code>{net?.accounts.orderSignerRole ?? "—"}</code></span></span>
                <span className="k">demo-runner</span><span><Hex value={net?.accounts.demoRunner} n={8} link={net?.accounts.demoRunner ? explorerAddr(net, net.accounts.demoRunner) : undefined} /></span>
                <span className="k">merchant payTo</span><span><Hex value={net?.accounts.merchantPayTo} n={8} link={net?.accounts.merchantPayTo ? explorerAddr(net, net.accounts.merchantPayTo) : undefined} /> <span className="tiny dim">receives fees, relays settlements</span></span>
              </div>
              {funds.available ? (
                <div className="stack" style={{ gap: 6 }} id="funds" data-testid="funds">
                  <div className="row between"><h3 style={{ fontSize: "1.05rem" }}>Project funds (live)</h3><span className="tiny dim">read by the worker {ago(funds.checkedAt!)} · every {Math.round((net?.funds?.intervalMs ?? 0) / 60000)} min</span></div>
                  {warning && <div className="banner" role="status">{warning}</div>}
                  <div className="tablewrap fit"><table className="t"><thead><tr><th>key</th><th>balance</th><th>warn below</th><th>status</th></tr></thead><tbody>
                    {funds.rows.map((r) => <tr key={r.role}><td className="small"><Hex value={r.address} n={5} link={explorerAddr(net, r.address)} /> <span className="tiny dim">{r.role}</span></td><td className="mono">{r.balance}{r.status !== "unread" ? " USDC" : ""}</td><td className="mono">{r.threshold} USDC</td><td><Chip tone={r.status === "ok" ? "ok" : r.status === "low" ? "bad" : "warn"} title={r.note}>{r.status}</Chip></td></tr>)}
                  </tbody></table></div>
                  <p className="tiny dim">{funds.note}</p>
                </div>
              ) : <p className="tiny dim">project funds: {net?.funds?.note ?? "not reported by this API"}</p>}
            </div>
          </div>
          <div className="stack" style={{ gap: 22 }}>
            <div className="stack" style={{ gap: 8 }}>
              <h3>Labels and the release profile</h3>
              <Labels labels={["LIVE_REQUEST", "DEMO_ON_MAINNET", "RECORDED_SAMPLE"]} />
              <p className="muted small"><code>SUBMISSION_RESTRICTED</code>: {net?.access?.selfService ? "anonymous browser sessions buy checks (self-service)" : "external paid access closed (only configured principals buy reports)"}; wallet-popup execution {net?.access?.walletExecution === false ? "off" : net?.access?.publicExecution === false ? "gated until the mainnet acceptance is recorded" : "on"}; USDC-transfer intent path off; SCA buyers off. Each closed path is a <em>deferred feature</em> with its rejection tested, not a hidden gap; the open ones are what this instance reports under <code>/v1/network.access</code>.{" "}Gates: G0 read-only probes · G1 contracts + schema + observer tests · G2 three fixtures live + recovery · G3 hardening. The live demo page is G2.</p>
              <ReceiptChain />
            </div>
            {net?.capabilities && net.capabilities.length > 0 && (
              <div className="stack" style={{ gap: 6 }} id="capabilities">
                <h3>What is implemented where</h3>
                <p className="tiny dim">per capability on this deployment · <code>IMPLEMENTED_TESTNET</code> rehearsed on Arc testnet · <code>MAINNET_VERIFIED</code> evidenced on Arc mainnet · <code>PROPOSED</code> designed, not shipped · <code>DISABLED</code> closed in this release</p>
                <ul className="list">
                  {net.capabilities.map((c) => <li key={c.id} className="row" style={{ gap: 8, alignItems: "baseline" }}><Chip tone={CAP_TONE[c.status] ?? "neutral"}>{c.status}</Chip><span className="small">{c.label}</span>{c.note && <span className="tiny dim">— {c.note}</span>}</li>)}
                </ul>
              </div>
            )}
            <div className="stack" style={{ gap: 8 }}>
              <h3>Published evidence files</h3>
              <EvidenceFiles files={files} href={(path) => apiPath(`/v1/evidence/${path}`)} />
            </div>
            <p className="small muted">API: <a href={apiPath("/openapi.json")} target="_blank" rel="noreferrer">{apiPath("/openapi.json")}</a> · <a href={apiPath("/health/ready")} target="_blank" rel="noreferrer">{apiPath("/health/ready")}</a> · <a href={apiPath("/v1/network")} target="_blank" rel="noreferrer">{apiPath("/v1/network")}</a> · <a href={apiPath("/v1/demo/runs")} target="_blank" rel="noreferrer">{apiPath("/v1/demo/runs")}</a></p>
          </div>
        </div>

        <HandRule />
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between"><h3>All demo runs</h3><span className="tiny dim">{history.total ?? history.runs.length} persisted · UTC timestamps · passport per finished run</span></div>
          <RunsTable runs={history.runs} net={net} total={history.total} onMore={loadMore} loadingMore={history.more} />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between"><h3>Public object reports</h3><span className="tiny dim">cached observations with raw evidence</span></div>
          {reports.length === 0 ? <p className="dim small">none yet</p> : <div className="tablewrap fit"><table className="t"><tbody>{limited(reports, reportLimit).shown.map((r) => <tr key={r.reportDigest}><td className="when" title={ago(r.createdAt)}>{utc(r.createdAt)}</td><td><Link to={link(`/subjects/${r.subject}`)}><Hex value={r.subject} n={6} /></Link></td><td className="small">{r.mode}</td><td><a href={apiPath(`/v1/public-reports/${r.reportDigest}`)} target="_blank" rel="noreferrer"><Hex value={r.reportDigest} n={6} /></a></td></tr>)}</tbody></table><ShowMore shown={Math.min(reportLimit, reports.length)} total={reports.length} onMore={() => setReportLimit((l) => l + LIST_PAGE)} noun="reports" testId="reports-more" /></div>}
        </div>
      </div>
    </section>
  );
}
