import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useNet } from "../App";
import { api, type Run } from "../lib/api";
import { RunPanel } from "../components/RunPanel";

/** The permanent record of one run. A RUNNING run is polled; one left RECONCILE_REQUIRED (an interruption) is observed every 2 s until it resolves. */
export default function RunPage() {
  const { id } = useParams();
  const { net, link = (to: string) => to } = useNet();
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null; let alive = true; const started = Date.now();
    const tick = async () => {
      try {
        const r = await api.run(id!); if (!alive) return; setRun(r);
        const again = r.state === "RUNNING" ? 1500 : r.state === "RECONCILE_REQUIRED" && Date.now() - started < 10 * 60_000 ? 2000 : null;
        if (again !== null) t = setTimeout(tick, again); else t = null;
      } catch (e: any) { if (alive) setErr(e?.message ?? String(e)); }
    };
    void tick();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, [id]);
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 16 }}>
        <div className="row between"><div><span className="kicker">Run · permanent record · {net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</span><h2 style={{ marginTop: 6 }}>{run ? <>{run.fixture.replace(/_/g, " ").toLowerCase()} <em className="dim" style={{ fontSize: "0.6em" }}>#{id?.slice(0, 8)}</em></> : `#${id?.slice(0, 8)}`}</h2></div><Link to={link("/demo")} className="btn">← demo</Link></div>
        {err && <div className="banner bad">{err}</div>}
        {run ? <RunPanel key={run.runId} run={run} net={net} onUpdate={setRun} /> : !err && <div className="card"><span className="spinner" /></div>}
      </div>
    </section>
  );
}
