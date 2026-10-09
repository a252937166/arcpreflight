// The interruption scenario as three moments (review of 2026-10-09, item 3): sent → the runner stops waiting → recovery reads the
// original hash and the order state. The current moment is highlighted from the recorded run; nothing here is preset.
import { Hex } from "./Badges";
import { explorerTx, type NetworkInfo } from "../lib/api";

export type RecoveryMoment = "before" | "broadcast" | "interrupted" | "recovering" | "resolved" | "failed";
const NODES: { id: RecoveryMoment | "resolved"; label: string }[] = [{ id: "broadcast", label: "real transaction broadcast" }, { id: "interrupted", label: "runner stops waiting" }, { id: "recovering", label: "recovery reads hash + order" }, { id: "resolved", label: "outcome established" }];
const ORDER: RecoveryMoment[] = ["before", "broadcast", "interrupted", "recovering", "resolved"];
export function RecoveryStrip({ moment, hash, net, outcome }: { moment: RecoveryMoment; hash?: string | null; net: NetworkInfo | null; outcome?: string | null }) {
  const at = moment === "failed" ? 3 : ORDER.indexOf(moment);
  return (
    <div className="recovery-strip" data-testid="recovery-strip" data-moment={moment}>
      <svg className="ill" viewBox="0 0 520 70" role="img" aria-label={`interruption scenario: ${NODES.map((n) => n.label).join(", ")}; now: ${moment}`}>
        {NODES.map((n, i) => {
          const x = 70 + i * 128; const idx = i + 1; // 1-based against ORDER
          const done = at > idx, now = at === idx, bad = moment === "failed" && i === 3;
          const stroke = bad ? "rose" : done ? "mint" : now ? "amber" : "soft";
          return (
            <g key={n.id}>
              {i < NODES.length - 1 && <line x1={x + 16} y1="22" x2={x + 112} y2="22" className={`ink ${at > idx ? "mint" : "soft dashed"}`} />}
              <circle cx={x} cy="22" r="14" className={`ink ${stroke} ${now ? "pulse" : ""}`} fill={now ? "rgba(251,191,36,0.14)" : done ? "rgba(110,231,183,0.14)" : "none"} />
              <text x={x} y="26" textAnchor="middle" className="lbl" fill={bad ? "var(--rose)" : done ? "var(--mint)" : now ? "var(--amber)" : "var(--ink-3)"}>{bad ? "✕" : done ? "✓" : now ? "●" : String(idx)}</text>
              <text x={x} y="56" textAnchor="middle" className="mono" style={{ fontSize: 9.5 }}>{n.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="row recovery-facts" style={{ gap: 12 }}>
        <span className="tiny dim">original transaction</span>
        {hash ? <Hex value={hash} n={6} link={explorerTx(net, hash)} /> : <span className="tiny dim">not sent yet</span>}
        <span className="tiny dim">· status</span><b className="small">{moment === "resolved" ? outcome ?? "established" : moment === "recovering" ? "recovering — the confirmed outcome appears under Payment outcome below" : moment === "interrupted" ? "interrupted — waiting for recovery" : moment === "failed" ? outcome ?? "not established" : moment === "broadcast" ? "broadcast" : "not started"}</b>
      </div>
    </div>
  );
}
