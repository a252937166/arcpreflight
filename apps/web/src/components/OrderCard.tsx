// The created order (docs/LIFECYCLE.md §2): id, creation transaction, payment state, costs so far and the next action — from
// GET /v1/demo/orders/{id}, which also reports the live `paid` flag. Facts, not prose.
import { Chip, Hex, Spinner } from "./Badges";
import { explorerAddr, explorerTx, type NetworkInfo, type OrderView } from "../lib/api";
import { nativeAtomicToUsdcText, orderCostsSoFar } from "../lib/orders";
import { utc } from "../lib/format";

const stateTone = (s: OrderView["state"]) => (s === "CONFIRMED" ? "ok" : s === "FAILED" || s === "UNKNOWN_CREATION" ? "bad" : "warn");
export function OrderCard({ order, net, feeTokenAtomic, onRefresh, busy, compact }: { order: OrderView; net: NetworkInfo | null; feeTokenAtomic: string | null; onRefresh?: () => void; busy?: boolean; compact?: boolean }) {
  const costs = orderCostsSoFar(order, feeTokenAtomic);
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="order-card">
      <div className="kv w150">
        <span className="k">orderId</span><span><Hex value={order.orderId} n={8} /> <span className="tiny dim">{order.source} · {order.proxy ?? "?"} proxy</span></span>
        <span className="k">creation tx</span><span>{order.tx ? <><Hex value={order.tx} n={6} link={explorerTx(net, order.tx)} />{order.block && <> @ #{order.block}</>}</> : <span className="dim">not recorded yet</span>} <Chip tone={stateTone(order.state)}>{order.state.toLowerCase().replace(/_/g, " ")}</Chip></span>
        <span className="k">payment</span><span><Chip tone={order.paid === true ? "ok" : order.paid === false ? "neutral" : "warn"}>{order.paid === true ? "paid" : order.paid === false ? "unpaid" : "not read yet"}</Chip>{order.paidCheckedAt && <span className="tiny dim"> · read {utc(order.paidCheckedAt)}</span>}</span>
        <span className="k">amount</span><span>{nativeAtomicToUsdcText(order.amountNativeAtomic)} USDC{order.reference && <> · <span className="muted">“{order.reference}”</span></>}</span>
        {!compact && <><span className="k">merchant · payer</span><span><Hex value={order.merchant} n={5} link={explorerAddr(net, order.merchant)} /> · <Hex value={order.payer} n={5} link={explorerAddr(net, order.payer)} /></span></>}
        <span className="k">costs so far</span>
        <span className="stack" style={{ gap: 2 }}>{costs.map((c) => <span key={c.label} className="small">{c.label} <span className="tiny dim">({c.who})</span>: <b>{c.usdc === null ? "not available (receipt unavailable)" : `${c.usdc} USDC`}</b>{c.detail && <span className="tiny dim"> · {c.detail}</span>}</span>)}</span>
        <span className="k">next action</span><span className="small">{order.nextAction}{order.attempts.length > 0 && <span className="tiny dim"> · {order.attempts.length} attempt{order.attempts.length === 1 ? "" : "s"}</span>}</span>
        {order.note && <><span className="k">note</span><span className="small muted">{order.note}</span></>}
      </div>
      {onRefresh && <div className="row"><button className="btn sm ghost" disabled={busy} onClick={onRefresh}>{busy ? <Spinner /> : "refresh (reads the order)"}</button></div>}
    </div>
  );
}
