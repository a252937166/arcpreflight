import { Chip, Hex } from "./Badges";
import { explorerTx, type NetworkInfo, type Step } from "../lib/api";
import { ms, usdcNative, decisionTone } from "../lib/format";

const TITLES: Record<string, string> = {
  createOrder: "Merchant creates the order (admin)", intent: "Agent builds the exact intent", quote: "402 quote — report prepared & pinned", staleObservation: "Pinned block predates the order — re-quote (free)",
  signServiceFee: "Agent signs the 0.01 USDC service fee (EIP-3009)", settlementPending: "Facilitator settlement pending", reportDelivered: "Report delivered after settlement on Arc", decision: "Deterministic local decision",
  finalValidation: "Final validation at a new pinned block", signed: "Signed — decoded and compared with the plan", broadcast: "Broadcast raw transaction", postcondition: "Business postcondition verified", notSigned: "Nothing signed", error: "Run error",
};
const HIDE = new Set(["step", "atMs", "who", "why"]);

function tone(s: Step): "ok" | "warn" | "bad" | "" {
  if (s.step === "error") return "bad";
  if (s.step === "decision") { const t = decisionTone(String(s.decision)); return t === "ok" || t === "warn" || t === "bad" ? t : ""; }
  if (s.step === "finalValidation") return s.result === "PASS" ? "ok" : "warn";
  if (s.step === "notSigned") return s.decision === "BLOCKED" ? "bad" : "warn";
  if (s.step === "postcondition") return s.paid === true ? "ok" : "bad";
  if (s.step === "staleObservation") return "warn";
  if (["reportDelivered", "signed", "broadcast", "createOrder"].includes(s.step)) return "ok";
  return "";
}
function Fact({ k, v, net }: { k: string; v: unknown; net: NetworkInfo | null }) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) && /tx|Tx|hash|Hash/.test(k)) return <Chip>{k}: <Hex value={v} link={explorerTx(net, v)} /></Chip>;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return <Chip>{k}: <Hex value={v} /></Chip>;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return <Chip>{k}: <Hex value={v} n={4} /></Chip>;
  if (/Atomic$/.test(k) && typeof v === "string" && /^\d+$/.test(v)) return <Chip title={v}>{k}: {k.includes("Native") || k.includes("balance") ? usdcNative(v, 4) : `${(Number(v) / 1e6).toFixed(2)} USDC (6-dec)`}</Chip>;
  if (Array.isArray(v)) return v.length ? <Chip title={v.join("\n")}>{k}: {v.slice(0, 4).map(String).join(" · ")}{v.length > 4 ? ` +${v.length - 4}` : ""}</Chip> : null;
  if (typeof v === "object") return <Chip title={JSON.stringify(v)}>{k}: {JSON.stringify(v).slice(0, 60)}…</Chip>;
  const s = String(v);
  const t = k === "decision" || k === "result" || k === "baselineResult" ? decisionTone(s) : "neutral";
  return <Chip tone={t}>{k}: {s.length > 70 ? s.slice(0, 70) + "…" : s}</Chip>;
}
export function StepLog({ steps, net }: { steps: Step[]; net: NetworkInfo | null }) {
  if (!steps.length) return <div className="dim small">Waiting for the first step…</div>;
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={i} className={`step ${tone(s)}`}>
          <div className="pip">{i + 1}</div>
          <div>
            <div className="head"><span className="title">{TITLES[s.step] ?? s.step}</span><span className="t">+{s.atMs >= 0 ? ms(s.atMs) : "—"}</span>{s.who && <span className="who">{s.who}</span>}</div>
            {s.why && <div className="why">{s.why}</div>}
            <div className="facts">{Object.entries(s).filter(([k]) => !HIDE.has(k)).map(([k, v]) => <Fact key={k} k={k} v={v} net={net} />)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
