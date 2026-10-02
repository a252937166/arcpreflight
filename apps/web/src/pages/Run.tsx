import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useNet } from "../App";
import { api, type Run } from "../lib/api";
import { RunPanel } from "../components/RunPanel";

export default function RunPage() {
  const { id } = useParams();
  const { net } = useNet();
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let t: number | null = null; let alive = true;
    const tick = async () => { try { const r = await api.run(id!); if (!alive) return; setRun(r); if (r.state !== "RUNNING" && t) { window.clearInterval(t); t = null; } } catch (e: any) { if (alive) setErr(e?.message ?? String(e)); } };
    tick(); t = window.setInterval(tick, 1500);
    return () => { alive = false; if (t) window.clearInterval(t); };
  }, [id]);
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 16 }}>
        <div className="row between"><div><span className="kicker">Run · permanent record</span><h2 style={{ marginTop: 6 }}>{run ? <>{run.fixture.replace(/_/g, " ").toLowerCase()} <em className="dim" style={{ fontSize: "0.6em" }}>#{id?.slice(0, 8)}</em></> : `#${id?.slice(0, 8)}`}</h2></div><Link to="/demo" className="btn">← demo</Link></div>
        {err && <div className="banner bad">{err}</div>}
        {run ? <RunPanel run={run} net={net} /> : !err && <div className="card"><span className="spinner" /></div>}
      </div>
    </section>
  );
}
