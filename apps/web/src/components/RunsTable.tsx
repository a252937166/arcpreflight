// Run history (design §6 "records a developer can come back to"): UTC time, network, recorded money, transactions with
// explorer links, and a passport link for every finished run. Paged through `offset` until `total` is reached.
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { DecisionBadge, Hex, NetworkChip, Spinner } from "./Badges";
import { explorerTx, passportUrl, type NetworkInfo, type RunSummary } from "../lib/api";
import { ago, ms, usdcNative, usdcToken, utc } from "../lib/format";

export const outcomeOf = (r: RunSummary) => (r.businessStatus === "SUCCESS" ? "CONFIRMED" : r.decision ?? (r.state === "RUNNING" ? null : r.state));
const situation = (f: string) => f.replace(/_/g, " ").toLowerCase();

export function RunsTable({ runs, net, total, onMore, loadingMore, compact, onView }: { runs: RunSummary[]; net: NetworkInfo | null; total?: number; onMore?: () => void; loadingMore?: boolean; compact?: boolean; onView?: (id: string) => void }) {
  const { link = (to: string) => to } = useNet(); // links carry ?net= when the selected instance is not the root (P2)
  const more = total !== undefined && runs.length < total && !!onMore;
  if (!runs.length) return <p className="dim small">no runs recorded on {net ? (net.network === "mainnet" ? "Arc mainnet" : "Arc testnet") : "this network"} yet</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className={`tablewrap ${compact ? "" : "wide"}`}>
        <table className="t runs">
          <thead><tr><th>when (UTC)</th><th>network</th><th>situation</th><th>outcome</th><th>check fee</th><th>business payment</th>{!compact && <><th>business tx</th><th>service fee tx</th><th>took</th></>}<th></th></tr></thead>
          <tbody>
            {runs.map((r) => {
              const paid = r.businessPaidNativeAtomic && r.businessPaidNativeAtomic !== "0" ? r.businessPaidNativeAtomic : null;
              return (
                <tr key={r.runId}>
                  <td className="when" title={ago(r.createdAt)}>{utc(r.createdAt)}</td>
                  <td><NetworkChip network={r.network ?? net?.network} /></td>
                  <td className="small">{situation(r.fixture)}</td>
                  <td><DecisionBadge decision={outcomeOf(r)} size="sm" /></td>
                  <td className="small">{r.feeTokenAtomic ? usdcToken(r.feeTokenAtomic) : <span className="dim">—</span>}</td>
                  <td className="small" title={r.orderAmountNativeAtomic ? `order ${usdcNative(r.orderAmountNativeAtomic, 2)}` : undefined}>{paid ? usdcNative(paid, 2) : <span className="dim">—</span>}</td>
                  {!compact && <>
                    <td>{r.businessTxHash ? <Hex value={r.businessTxHash} n={5} link={explorerTx(net, r.businessTxHash)} /> : <span className="dim">not signed</span>}</td>
                    <td>{r.serviceFeeTx ? <Hex value={r.serviceFeeTx} n={5} link={explorerTx(net, r.serviceFeeTx)} /> : <span className="dim">—</span>}</td>
                    <td className="tiny dim">{r.durationMs ? ms(r.durationMs) : "—"}</td>
                  </>}
                  <td className="actions">
                    {onView && <button className="btn sm ghost" onClick={() => onView(r.runId)}>view</button>}
                    <Link to={link(`/runs/${r.runId}`)} className="btn sm ghost">open</Link>
                    {r.passportAvailable && <a className="btn sm ghost" href={passportUrl(r.runId)} download={`arcpreflight-passport-${r.runId.slice(0, 8)}.json`} title="Payment Passport bundle (format 1.0) of this run">passport</a>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row between">
        <span className="tiny dim">{runs.length}{total !== undefined ? ` of ${total}` : ""} runs</span>
        {more && <button className="btn sm ghost" onClick={onMore} disabled={loadingMore}>{loadingMore ? <Spinner /> : "show more"}</button>}
      </div>
    </div>
  );
}
