import { useState } from "react";
import { decisionTone, short, type Tone } from "../lib/format";

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span className={`chip ${tone === "neutral" ? "" : tone}`} title={title}>{children}</span>;
}
/** The outcome word, set in italic serif with a hand-drawn mark — not a box. */
export function DecisionBadge({ decision, size = "md" }: { decision: string | null | undefined; size?: "md" | "sm" }) {
  const tone = decisionTone(decision);
  const label = decision === "NO_POLICY_VIOLATION" ? "no policy violation" : (decision ?? "pending").replace(/_/g, " ").toLowerCase();
  const mark = tone === "ok" ? "✓" : tone === "warn" ? "!" : tone === "bad" ? "✕" : "…";
  return size === "sm" ? <Chip tone={tone}>{mark} {label}</Chip> : <span className={`badge ${tone}`}><span className="mk">{mark}</span>{label}</span>;
}
export function Hex({ value, n = 6, link }: { value: string | null | undefined; n?: number; link?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="dim">—</span>;
  const copy = async (e: React.MouseEvent) => { e.preventDefault(); try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } };
  const el = <span className={`hex ${copied ? "copied" : ""}`} title={`${value} (click to copy)`} onClick={copy}>{copied ? "copied" : short(value, n)}</span>;
  return link ? <span>{el} <a href={link} target="_blank" rel="noreferrer" className="tiny">↗</a></span> : el;
}
export function Labels({ labels, network }: { labels: string[]; network?: string }) {
  return <span className="row" style={{ gap: 6 }}>
    {labels.map((l) => <Chip key={l} tone={l === "RECORDED_SAMPLE" ? "warn" : l === "DEMO_ON_MAINNET" ? "violet" : "info"}>{l}</Chip>)}
    {network && <Chip tone={network === "mainnet" ? "violet" : "neutral"}>{network === "mainnet" ? "Arc mainnet 5042" : "Arc testnet 5042002"}</Chip>}
  </span>;
}
export function Spinner() { return <span className="spinner" aria-label="loading" />; }
