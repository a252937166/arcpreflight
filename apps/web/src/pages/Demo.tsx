import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useNet } from "../App";
import { api, type Fixture, type Run, type RunSummary } from "../lib/api";
import { Chip, DecisionBadge, Hex, Spinner } from "../components/Badges";
import { RunPanel } from "../components/RunPanel";
import { ago, ms } from "../lib/format";

export default function Demo() {
  const { net, refresh } = useNet();
  const [params, setParams] = useSearchParams();
  const initial = (params.get("fixture") as Fixture | null) ?? "CHANGED_IMPLEMENTATION";
  const [fixture, setFixture] = useState<Fixture>(initial);
  const [run, setRun] = useState<Run | null>(null);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string } | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const timer = useRef<number | null>(null);

  const loadRuns = useCallback(() => api.runs(12).then((r) => setRuns(r.runs)).catch(() => {}), []);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const poll = useCallback((id: string) => {
    if (timer.current) window.clearInterval(timer.current);
    const tick = async () => {
      try { const r = await api.run(id); setRun(r); if (r.state !== "RUNNING") { if (timer.current) window.clearInterval(timer.current); timer.current = null; setBusy(false); loadRuns(); refresh(); } }
      catch { /* keep polling */ }
    };
    tick(); timer.current = window.setInterval(tick, 1500);
  }, [loadRuns, refresh]);

  const start = async () => {
    setBusy(true); setNotice(null); setSample(false); setRun(null);
    try {
      const r = await api.startRun(fixture);
      if (r.runId) { setNotice({ tone: "info", text: "Live run started — the project's own runner is executing on-chain right now." }); poll(r.runId); return; }
      setBusy(false);
      const why = `${r.error}: ${r.reason}`;
      if (r.sampleRunId) { setNotice({ tone: "warn", text: `${why}. Showing the latest recorded run instead (labelled RECORDED_SAMPLE).` }); setSample(true); setRun(await api.run(r.sampleRunId)); }
      else setNotice({ tone: "bad", text: why });
    } catch (e: any) { setBusy(false); setNotice({ tone: "bad", text: e?.message ?? String(e) }); }
  };
  const open = async (id: string) => { setSample(false); setNotice(null); try { const r = await api.run(id); setRun(r); if (r.state === "RUNNING") { setBusy(true); poll(id); } } catch { /* ignore */ } };

  const f = net?.fixtures.find((x) => x.id === fixture);
  const cooldown = net?.budget.clientCooldownSeconds ?? 45;
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 20 }}>
        <div className="row between">
          <div><span className="kicker">Live demo · {net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</span><h2 style={{ marginTop: 6 }}>Pick a fixture, watch the loop run on-chain</h2></div>
          {net && <div className="ticker"><span>live runs today <b>{net.budget.usedToday}/{net.budget.maxRunsPerDay}</b></span><span>cooldown <b>{cooldown}s</b></span><span>business payment <b>0.05 USDC</b></span>{net.budget.activeRun && <span><b>a run is in progress</b></span>}</div>}
        </div>
        <div className="grid-3">
          {(net?.fixtures ?? []).map((x) => (
            <div key={x.id} className={`card clickable stack ${fixture === x.id ? "selected" : ""}`} style={{ gap: 8 }} onClick={() => { setFixture(x.id); setParams({ fixture: x.id }); }}>
              <div className="row between"><span className="kicker">{x.id.replace(/_/g, " ")}</span><DecisionBadge decision={x.headline} size="sm" /></div>
              <h3>{x.title}</h3>
              <p className="small muted">{x.blurb}</p>
              <div className="tiny dim row" style={{ gap: 6 }}><span>proxy {x.proxy}</span>{x.merchant && <Hex value={x.merchant} n={4} />}{x.baselineDigest ? <Chip tone="ok">baseline approved</Chip> : <Chip tone="warn">no baseline</Chip>}</div>
            </div>
          ))}
        </div>
        <div className="card row between">
          <div className="stack" style={{ gap: 4 }}>
            <div><b>{f?.title ?? "…"}</b> <span className="muted small">— expected outcome</span> <DecisionBadge decision={f?.headline} size="sm" /></div>
            <div className="small dim">Runner <code>{net?.accounts.demoRunner ? `${net.accounts.demoRunner.slice(0, 10)}…` : "…"}</code> buys the report (0.01 USDC via Circle Facilitator), decides locally, and only signs the business call when nothing fired. Service fees are paid even for negative results — a negative is a delivered result.</div>
          </div>
          <button className="btn primary" disabled={busy || !net || !f?.merchant} onClick={start}>{busy ? <><Spinner /> running…</> : "▶ Run live on-chain"}</button>
        </div>
        {notice && <div className={`banner ${notice.tone === "info" ? "info" : notice.tone === "bad" ? "bad" : ""}`}>{notice.text}</div>}
        {run && <RunPanel run={run} net={net} sample={sample} />}

        <div className="card">
          <div className="card-title"><h3>Recent runs</h3><span className="tiny dim">every run is persisted with its receipts; open one for the permanent link</span></div>
          {runs.length === 0 ? <div className="dim small">none yet</div> : (
            <table className="t">
              <thead><tr><th>When</th><th>Fixture</th><th>Outcome</th><th>Business tx</th><th>Service fee</th><th>Duration</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId}>
                    <td className="tiny dim">{ago(r.createdAt)}</td>
                    <td className="small">{r.fixture.replace(/_/g, " ").toLowerCase()}</td>
                    <td><DecisionBadge decision={r.businessStatus === "SUCCESS" ? "CONFIRMED" : r.decision ?? (r.state === "RUNNING" ? null : r.state)} size="sm" /></td>
                    <td>{r.businessTxHash ? <Hex value={r.businessTxHash} n={5} /> : <span className="dim">not signed</span>}</td>
                    <td>{r.serviceFeeTx ? <Hex value={r.serviceFeeTx} n={5} /> : "—"}</td>
                    <td className="tiny dim">{r.durationMs ? ms(r.durationMs) : "—"}</td>
                    <td><button className="btn sm ghost" onClick={() => open(r.runId)}>view</button> <Link to={`/runs/${r.runId}`} className="btn sm ghost">↗</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
