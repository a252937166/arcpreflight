// The created order (docs/LIFECYCLE.md §2): id, creation transaction, payment state, costs so far and the next action — from
// GET /v1/demo/orders/{id}, which also reports the live `paid` flag. Facts, not prose. A creation that is not confirmed says so first
// ("Order creation sent — not yet confirmed" / "identity recorded; creation not confirmed"), its payment reads "unknown", and Recover
// asks the service to reconcile it now (2026-10-09).
import { Chip, Hex, Spinner } from "./Badges";
import { explorerAddr, explorerTx, type NetworkInfo, type OrderView } from "../lib/api";
import { creationStatusText, creationUnconfirmed, nativeAtomicToUsdcText, orderCostsSoFar, paymentLabel } from "../lib/orders";
import { utc } from "../lib/format";

const stateTone = (s: OrderView["state"]) => (s === "CONFIRMED" ? "ok" : s === "FAILED" || s === "UNKNOWN_CREATION" ? "bad" : "warn");
export function OrderCard({ order, net, feeTokenAtomic, onRefresh, onRecover, busy, compact }: { order: OrderView; net: NetworkInfo | null; feeTokenAtomic: string | null; onRefresh?: () => void; onRecover?: () => void; busy?: boolean; compact?: boolean }) {
  const costs = orderCostsSoFar(order, feeTokenAtomic);
  const pay = paymentLabel(order); const status = creationStatusText(order); const pending = creationUnconfirmed(order);
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="order-card">
      {status && <div className={`banner${pending ? "" : " bad"}`} role="status" data-testid="order-creation-status"><b>{status}</b>{pending && <span className="tiny dim"> · approval, the check and execution open once its receipt confirms it; nothing is created twice</span>}</div>}
      <div className="kv w150">
        <span className="k">orderId</span><span><Hex value={order.orderId} n={8} /> <span className="tiny dim">{order.source} · {order.proxy ?? "?"} proxy</span></span>
        <span className="k">creation tx</span><span>{order.tx ? <><Hex value={order.tx} n={6} link={explorerTx(net, order.tx)} />{order.block && <> @ #{order.block}</>}</> : <span className="dim">not recorded yet</span>} <Chip tone={stateTone(order.state)}>{order.state.toLowerCase().replace(/_/g, " ")}</Chip></span>
        <span className="k">payment</span><span><Chip tone={pay.tone}>{pay.text}</Chip>{order.paidCheckedAt && pay.text !== "unknown" && <span className="tiny dim"> · read {utc(order.paidCheckedAt)}</span>}{pay.text === "unknown" && <span className="tiny dim"> · {order.state === "CONFIRMED" ? "not read yet" : "not established: the creation is not confirmed"}</span>}</span>
        <span className="k">amount</span><span>{nativeAtomicToUsdcText(order.amountNativeAtomic)} USDC{order.reference && <> · <span className="muted">“{order.reference}”</span></>}</span>
        {!compact && <><span className="k">merchant · payer</span><span><Hex value={order.merchant} n={5} link={explorerAddr(net, order.merchant)} /> · <Hex value={order.payer} n={5} link={explorerAddr(net, order.payer)} /></span></>}
        <span className="k">costs so far</span>
        <span className="stack" style={{ gap: 2 }}>{costs.map((c) => <span key={c.label} className="small">{c.label} <span className="tiny dim">({c.who})</span>: <b>{c.usdc === null ? c.missing ?? "not available (no receipt)" : `${c.usdc} USDC`}</b>{c.detail && <span className="tiny dim"> · {c.detail}</span>}</span>)}</span>
        <span className="k">next action</span><span className="small">{order.nextAction}{order.attempts.length > 0 && <span className="tiny dim"> · {order.attempts.length} attempt{order.attempts.length === 1 ? "" : "s"}</span>}</span>
        {order.note && <><span className="k">note</span><span className="small muted">{order.note}</span></>}
      </div>
      {(onRefresh || (pending && onRecover)) && <div className="row">
        {pending && onRecover && <button className="btn sm" disabled={busy} onClick={onRecover} title="reconciles this creation now: reads the receipt, the order and the creation nonce, and may hand the node the same signed transaction again — never a second order">Recover order</button>}
        {onRefresh && <button className="btn sm ghost" disabled={busy} onClick={onRefresh} title="re-reads the order from the chain">{busy ? <Spinner /> : "refresh"}</button>}
      </div>}
    </div>
  );
}
