import { Fragment } from "react";
import { Chip, Hex } from "./Badges";
import { explorerAddr, type Evidence, type NetworkInfo, type Report } from "../lib/api";
import { decisionTone, signalTone, utc } from "../lib/format";

const BASIS: Record<string, "info" | "violet" | "warn" | "neutral"> = { chain_read: "info", simulation: "violet", network_advisory: "warn", heuristic: "warn", template: "info" };
/** a signal id may wrap at its underscores (never letter by letter) when the column is narrow */
const breakable = (id: string) => id.split("_").map((part, i, all) => <Fragment key={i}>{part}{i < all.length - 1 ? <>_<wbr /></> : null}</Fragment>);
/** prose with code identifiers ("DemoMerchant.getOrder(orderId)") may wrap after a dot, a parenthesis or a slash */
const prose = (text: string) => text.split(/(?<=[.(/])(?=\S)/).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>);

export function ReportView({ report, digest, evidence, net, compact }: { report: Report; digest?: string; evidence?: Evidence[]; net: NetworkInfo | null; compact?: boolean }) {
  const target = report.dependencies.find((d) => d.role === "TARGET");
  const impl = report.dependencies.find((d) => d.role === "IMPLEMENTATION");
  const adv = report.signals.filter((s) => s.basis === "network_advisory");
  const core = report.signals.filter((s) => s.basis !== "network_advisory");
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        <Chip tone={report.mode === "SUPPORTED_INTENT" ? "violet" : "info"}>{report.mode}</Chip>
        <Chip tone={report.decisionEligible ? "ok" : "warn"}>{report.decisionEligible ? "decision-eligible" : "not decision-eligible"}</Chip>
        <Chip tone={decisionTone(report.baselineResult)}>baseline: {report.baselineResult}</Chip>
        <Chip tone="info">pinned #{report.observation.blockNumber} · {report.observation.pinningMode}</Chip>
        {digest && <Chip>report <Hex value={digest} /></Chip>}
      </div>
      <div className="kv">
        <span className="k">Observed at</span><span>{utc(report.observation.observedAt)} · provider <code>{report.observation.providerId}</code> · expires {utc(report.expiresAt)}</span>
        <span className="k">Block hash</span><span><Hex value={report.observation.blockHash} n={10} /></span>
        <span className="k">Target</span><span>{target ? <><Hex value={target.address} n={8} link={explorerAddr(net, target.address)} /> <Chip tone={target.resolution === "VERIFIED_TEMPLATE" ? "ok" : "warn"}>{target.resolution}</Chip> code <Hex value={target.codeHash} /></> : "—"}</span>
        <span className="k">Implementation</span><span>{impl ? <><Hex value={impl.address} n={8} link={explorerAddr(net, impl.address)} /> code <Hex value={impl.codeHash} /></> : <span className="dim">none resolved</span>}</span>
        {report.baselineDigest && <><span className="k">Baseline</span><span><Hex value={report.baselineDigest} /></span></>}
        <span className="k">Methodology</span><span><Hex value={report.methodologyDigest} /> · adapters {report.adapterManifestDigests.map((d) => <Hex key={d} value={d} />)}</span>
      </div>
      <div className="tablewrap fit"><table className="t signals">
        <thead><tr><th>Signal</th><th className="fit">State</th><th className="fit">Basis</th><th>Scope / limitations</th></tr></thead>
        <tbody>
          {core.map((s) => (
            <tr key={s.id}>
              <td className="mono sig">{breakable(s.id)}</td>
              <td className="fit"><Chip tone={signalTone(s.state)}>{s.state}</Chip></td>
              <td className="fit"><Chip tone={BASIS[s.basis] ?? "neutral"}>{s.basis}</Chip></td>
              <td className="scope"><div className="small">{prose(s.scope)}</div>{s.limitations.length > 0 && <div className="tiny muted">{prose(s.limitations.join(" · "))}</div>}{s.evidenceDigests.length > 0 && <div className="tiny dim row" style={{ gap: 4 }}>evidence {s.evidenceDigests.map((d) => <Hex key={d} value={d} n={4} />)}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {!compact && adv.length > 0 && (
        <details>
          <summary>{adv.length} Arc network advisories (documentation-backed rules, not target findings)</summary>
          <div className="tablewrap fit"><table className="t" style={{ marginTop: 8 }}><tbody>{adv.map((s) => <tr key={s.id}><td className="mono">{s.id}</td><td className="small">{s.scope} {s.sourceIds.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="tiny"> docs↗</a>)}</td></tr>)}</tbody></table></div>
        </details>
      )}
      {!compact && (
        <details>
          <summary>Exclusions ({report.exclusions.length}) · raw evidence digests ({report.rawEvidenceDigests.length}){evidence ? ` · ${evidence.length} raw RPC evidence items` : ""}</summary>
          <ul className="list" style={{ marginTop: 8 }}>{report.exclusions.map((e, i) => <li key={i}>{e}</li>)}</ul>
          {evidence && <pre className="json" style={{ marginTop: 8 }}>{JSON.stringify(evidence, null, 2)}</pre>}
        </details>
      )}
    </div>
  );
}
