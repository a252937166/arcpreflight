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
/** A shortened hash or address. With `link` the text itself opens the explorer in a new tab (P3: no copy-on-click — copying lives in the wallet menu). */
export function Hex({ value, n = 6, link }: { value: string | null | undefined; n?: number; link?: string }) {
  if (!value) return <span className="dim">—</span>;
  if (link) return <a className="hex link" href={link} target="_blank" rel="noreferrer" title={`${value} — open in the explorer`}>{short(value, n)}<span className="arrow" aria-hidden="true">↗</span></a>;
  return <span className="hex" title={value}>{short(value, n)}</span>;
}
export function Labels({ labels, network }: { labels: string[]; network?: string }) {
  return <span className="row" style={{ gap: 6 }}>
    {labels.map((l) => <Chip key={l} tone={l === "RECORDED_SAMPLE" ? "warn" : l === "DEMO_ON_MAINNET" ? "violet" : "info"}>{l}</Chip>)}
    {network && <Chip tone={network === "mainnet" ? "violet" : "neutral"}>{network === "mainnet" ? "Arc mainnet 5042" : "Arc testnet 5042002"}</Chip>}
  </span>;
}
export function NetworkChip({ network }: { network?: string | null }) {
  if (!network) return <span className="dim">—</span>;
  return <Chip tone={network === "mainnet" ? "violet" : "neutral"}>{network === "mainnet" ? "Arc mainnet 5042" : "Arc testnet 5042002"}</Chip>;
}
export function Spinner() { return <span className="spinner" aria-label="loading" />; }
