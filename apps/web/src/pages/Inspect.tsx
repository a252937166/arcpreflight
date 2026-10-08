import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useNet } from "../App";
import { api, apiPath, explorerAddr, type Report } from "../lib/api";
import { Chip, Hex, Spinner } from "../components/Badges";
import { ReportView } from "../components/Report";
import { HandRule, ProxySwap } from "../components/Illustrations";
import { describeError } from "../lib/errors";

export default function Inspect() {
  const { net, link = (to: string) => to } = useNet();
  const { address } = useParams();
  const nav = useNavigate();
  const [observation, setObservation] = useState<{ address: string; reportDigest: string; report: Report; supported: boolean; evidenceCount: number } | null>(null);
  const data = observation?.address.toLowerCase() === address?.toLowerCase() ? observation : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) { setObservation(null); setBusy(false); return; }
    let alive = true;
    const controller = new AbortController();
    setBusy(true); setErr(null); setObservation(null);
    api.subject(address, controller.signal).then((r) => { if (alive) setObservation({ ...r, address }); })
      .catch((e) => { if (alive) setErr(describeError(e).text); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; controller.abort(); };
  }, [address]);
  const go = (a: string) => nav(link(`/subjects/${a}`));
  // The server decides what may be observed (GET /v1/network observableSubjects); fixture proxies get their story from net.fixtures.
  const picks = (net?.observableSubjects ?? []).map((s) => {
    const f = net?.fixtures.find((x) => x.merchant && x.merchant.toLowerCase() === s.address.toLowerCase());
    if (f) return { name: `DemoMerchant ${f.proxy} proxy`, address: s.address, note: f.proxy === "CHANGED" ? "upgraded A→B after approval" : "approved implementation A" };
    return { name: s.label, address: s.address, note: s.kind === "external" ? "public Arc contract" : "supported intent target" };
  });
  const impl = data?.report.dependencies.find((d) => d.role === "IMPLEMENTATION");
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 26 }}>
        <div className="cols" style={{ alignItems: "start" }}>
          <div className="stack" style={{ gap: 14 }}>
            <div className="kicker">Inspect · object observation</div>
            <h2>What is behind that address, <em>right now?</em></h2>
            <p className="muted">Proxy slots are read raw at a verified block hash, then matched against a known template. No intent, no decision — an object observation is never decision-eligible. It is the same observer the paid reports use, pointed at a curated list of public samples.</p>
            <p className="small dim row" style={{ gap: 10 }}>
              <span className="hand" style={{ fontSize: "1.1rem" }}>pick one →</span>
              {picks.map((p) => <button key={p.address} className="btn sm ghost" title={`${p.address} · ${p.note}`} onClick={() => go(p.address)} disabled={busy}>{p.name}</button>)}
              {busy && <Spinner />}
            </p>
            <p className="small dim">This release observes the samples above only. Each observation is stored as a public report, so arbitrary addresses are refused to keep that list a set of reviewed samples.</p>
            {err && <div className="banner bad">{err}</div>}
          </div>
          <ProxySwap changed={data?.report.baselineResult === "IMPLEMENTATION_CHANGED"} />
        </div>
        {data && (
          <>
            <HandRule />
            <div className="stack fade" style={{ gap: 14 }}>
              <div className="row between" style={{ alignItems: "baseline" }}>
                <div className="row" style={{ gap: 10, alignItems: "baseline" }}><span className="serif" style={{ fontSize: "1.5rem" }}>subject</span> <Hex value={address!} n={8} link={explorerAddr(net, address!)} />{data.supported ? <Chip tone="ok">supported intent target</Chip> : <Chip>object observation only</Chip>}<Chip tone="info">{data.evidenceCount} raw RPC evidence items</Chip></div>
                <a className="small" href={apiPath(`/v1/public-reports/${data.reportDigest}`)} target="_blank" rel="noreferrer">report + evidence JSON ↗</a>
              </div>
              {impl && <p className="caption">it resolves to implementation {impl.address.slice(0, 10)}… with code hash {impl.codeHash?.slice(0, 12)}… — that pair is what a baseline would pin</p>}
              <ReportView report={data.report} digest={data.reportDigest} net={net} />
              {!data.supported && <p className="small dim">Decision-eligible reports exist only for the DemoMerchant fixtures in this release (SUBMISSION_RESTRICTED). Everything else is observed, never judged.</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
