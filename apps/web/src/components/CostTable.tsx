// Cost disclosure (docs/LIFECYCLE.md §5, §9): one table for a runner run and a wallet attempt, from `costStatement` — the same object the
// passport writes. Rows: business principal · check fee · business gas · fee-relay gas · order-creation gas; columns: authorized
// maximum · actual · unresolved; buyer and operator grouped with their totals. Exact strings; a missing receipt is "not available"; a
// group with a missing receipt shows "incomplete: <component> not available" instead of a total; the buyer is labelled by its role
// (a project-funded run never reads "your wallet"). The table scrolls sideways on a phone — the unresolved column is never hidden — and
// the unresolved reservation is also written out as its own line.
import { Hex } from "./Badges";
import { explorerTx, type CostStatement, type NetworkInfo } from "../lib/api";
import { costTable, type CostContext } from "../lib/costTable";

export function CostTable({ statement, net, title = "Cost disclosure", context = {} }: { statement: CostStatement | null | undefined; net: NetworkInfo | null; title?: string | null; context?: CostContext }) {
  const m = costTable(statement, context);
  if (!statement) return <div className="stack" style={{ gap: 4 }}>{title && <h3>{title}</h3>}<p className="dim small">cost statement not available yet — it is written from receipts, never estimated</p></div>;
  const group = (g: "buyer" | "operator") => m.rows.filter((r) => r.group === g);
  const total = (g: { total: string | null; incomplete: string | null } | null) => (!g ? "—" : g.total ?? <span className="incomplete" title="a receipt this total should include is not available; the known subtotal is not shown as the cost">{g.incomplete}</span>);
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="cost-table">
      {title && <div className="row between" style={{ alignItems: "baseline" }}><h3>{title}</h3><span className="tiny dim">USDC · exact strings from <code>cost-statement.json</code> v{statement.costStatementVersion} · {statement.capturedAt ? `captured ${statement.capturedAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}` : ""}</span></div>}
      <div className="tablewrap cost-wrap">
        <table className="t cost">
          <thead><tr><th>line</th><th>authorized maximum</th><th>actual</th><th>unresolved</th></tr></thead>
          <tbody>
            <tr className="grp"><td colSpan={4}>buyer {m.buyer && <Hex value={m.buyer.address} n={4} />} <span className="tiny dim role" data-testid="buyer-role">— {m.buyer?.role ?? "the buyer"}</span></td></tr>
            {group("buyer").map((r) => <tr key={r.key}><td title={r.hint}>{r.label}{r.tx && <> <Hex value={r.tx} n={4} link={explorerTx(net, r.tx)} /></>}</td><td className="num">{r.authorized}</td><td className={`num ${r.actual.startsWith("not available") ? "dim" : ""}`}>{r.actual}</td><td className="num">{r.unresolved}</td></tr>)}
            <tr className="total"><td>buyer total</td><td className="num">—</td><td className="num" data-testid="buyer-total">{total(m.buyer)}</td><td className="num">{m.unresolved?.usdc ?? "—"}</td></tr>
            <tr className="grp"><td colSpan={4}>operator <span className="tiny dim">— the project's relayer and order creator; never charged to the buyer</span></td></tr>
            {group("operator").map((r) => <tr key={r.key}><td title={r.hint}>{r.label}{r.tx && <> <Hex value={r.tx} n={4} link={explorerTx(net, r.tx)} /></>}</td><td className="num">{r.authorized}</td><td className={`num ${r.actual.startsWith("not available") ? "dim" : ""}`}>{r.actual}</td><td className="num">—</td></tr>)}
            <tr className="total"><td>operator total</td><td className="num">—</td><td className="num" data-testid="operator-total">{total(m.operator)}</td><td className="num">—</td></tr>
          </tbody>
        </table>
      </div>
      {m.unresolved && <p className="tiny dim unresolved-line" data-testid="unresolved-line">unresolved reservation <b>{m.unresolved.usdc}</b>{m.unresolved.note ? ` — ${m.unresolved.note}` : ""}</p>}
      {(m.buyer?.incomplete || m.operator?.incomplete) && <p className="tiny dim">a total marked <em>incomplete</em> lacks a receipt that exists on chain; the statement keeps the known subtotal in <code>cost-statement.json</code> and the verifier recomputes it — it is never shown here as the cost</p>}
      {m.notes.length > 0 && <details><summary className="tiny">notes from the statement ({m.notes.length})</summary><ul className="list small">{m.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
    </div>
  );
}
