// What a Payment Passport proves and how to check one (docs/PASSPORT.md §6–§8, docs/LIFECYCLE.md §6). Two ways in the page: the offline
// integrity preview (same code as the site — a quick look) and the real verifier run in this browser against an Arc RPC with anchors
// you type (or this site's, labelled as not independent). The CLI in a clean process remains the independent path.
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useNet } from "../App";
import { Chip } from "../components/Badges";
import { HandRule } from "../components/Illustrations";
import { VerifyInBrowser } from "../components/VerifyInBrowser";
import { previewBundle, type Preview } from "../lib/passportPreview";
import { parseDigests } from "../lib/verifyInBrowser";
import { describeError } from "../lib/errors";

export const FINDINGS = [
  { id: "FILE_INTEGRITY", needs: "passport", plain: "every listed file is present and unchanged (sha256); nothing unlisted; every path obeys the format" },
  { id: "DIGEST_INTEGRITY", needs: "passport", plain: "each core record re-hashes to the digest the next one points at: intent → report → decision → final validation → execution" },
  { id: "DISCLOSURE", needs: "passport", plain: "no private key, fee-authorization signature or signed transaction bytes inside the export" },
  { id: "APPROVAL_SOURCE", needs: "anchors", plain: "the baseline and policy match digests you kept separately; without anchors it stays UNVERIFIED — fresh hashes prove no original approval" },
  { id: "APPROVAL_COVERAGE", needs: "passport", plain: "intent, decision, final validation and execution reference the same approval; its revocation state at validation is recorded or marked not retained" },
  { id: "NETWORK_IDENTITY", needs: "RPC", plain: "your RPC serves the chain the passport names; otherwise every online check is UNVERIFIED" },
  { id: "FEE_ATTRIBUTION", needs: "RPC", plain: "the fee transaction exists, succeeded, targets USDC and carries AuthorizationUsed + Transfer for exactly the recorded authorization" },
  { id: "TRANSACTION_PLAN_AGREEMENT", needs: "RPC", plain: "the business transaction equals the validated plan — every field in runner mode; in wallet mode chain, type, from, to, calldata and value, with wallet-set gas, fees and nonce reported as deviations" },
  { id: "ORDER_OUTCOME", needs: "RPC", plain: "the receipt succeeded, OrderPaid was emitted for this order, and the order read at that block is paid by that payer for that amount; unavailable history is UNVERIFIED, never FAIL" },
  { id: "COST_STATEMENT", needs: "RPC", plain: "the whole statement is recomputed from the records and receipts, field by field" },
  { id: "CURRENT_ELIGIBILITY", needs: "—", plain: "always NOT_EVALUATED: whether a payment may execute now is a present-time question" },
] as const;

const tone = (s: string) => (s === "PASS" ? "ok" : s === "FAIL" ? "bad" : "warn");

export default function Verify() {
  const { net, link = (to: string) => to } = useNet();
  const [params] = useSearchParams();
  const runId = params.get("run");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [bundle, setBundle] = useState<unknown | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [anchorText, setAnchorText] = useState({ baseline: "", policy: "" });
  const [siteFilled, setSiteFilled] = useState(false);
  const rpc = net?.rpc ?? (net?.network === "mainnet" ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
  const anchors = useMemo(() => ({ baselineDigests: parseDigests(anchorText.baseline), policyDigests: parseDigests(anchorText.policy) }), [anchorText]);
  const anchorsSource = anchors.baselineDigests.length + anchors.policyDigests.length === 0 ? "none" : siteFilled ? "site" : "user";
  const onFile = async (e: { target: { files?: ArrayLike<{ name?: string; text: () => Promise<string> }> | null } }) => {
    const f = e.target.files?.[0]; if (!f) return;
    setErr(null); setName(f.name ?? "passport.json");
    try { const parsed = JSON.parse(await f.text()); setBundle(parsed); setPreview(await previewBundle(parsed)); } catch (ex: any) { setPreview(null); setBundle(null); setErr(ex instanceof SyntaxError ? "That file is not a JSON passport bundle." : describeError(ex).text); }
  };
  const onDrop = (e: { preventDefault(): void; dataTransfer?: { files?: ArrayLike<{ name?: string; text: () => Promise<string> }> | null } | null }) => { e.preventDefault(); setOver(false); void onFile({ target: { files: e.dataTransfer?.files ?? null } }); };
  const fillFromSite = () => { setAnchorText((a) => ({ ...a, baseline: Array.from(new Set((net?.fixtures ?? []).map((f) => f.baselineDigest).filter((x): x is string => !!x))).join("\n") })); setSiteFilled(true); };
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 28 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="kicker">Verify independently · {net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</div>
          <h2>Take the proof with you. <em>Check it somewhere else.</em></h2>
          <p className="muted" style={{ maxWidth: 760 }}>A Payment Passport packages what was approved, sent and settled, with the evidence. Not a token, not a guarantee, not proof of service delivery; importing one grants no signing authority.</p>
          {runId && <p className="small"><Chip tone="info">run #{runId.slice(0, 8)}</Chip> download its passport from the run page, then verify it below or with the CLI.</p>}
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <h3>1 · Load a passport</h3>
          <label className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            <input className="visually-hidden" type="file" accept="application/json,.json" onChange={onFile} aria-label="passport bundle" />
            <span className="btn sm" aria-hidden="true">Choose passport file…</span>
            <span className="small muted">{name ?? "or drop an arcpreflight-…passport….json here"}</span>
          </label>
          {err && <div className="banner bad">{err}</div>}
        </div>

        <div className="two" style={{ gap: 44, alignItems: "start" }}>
          <div className="stack" style={{ gap: 12 }}>
            <h3>2 · Offline integrity preview</h3>
            <p className="small muted"><b style={{ color: "var(--ink)" }}>This preview runs the same code as the site; for independence run the CLI in a clean process.</b> Paths, sha256 of every file, core digests — nothing online.</p>
            {preview && (
              <div className="stack fade" style={{ gap: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  {name && <span className="small">{name}</span>}
                  <Chip tone="ok">{preview.counts.PASS} pass</Chip><Chip tone={preview.counts.FAIL ? "bad" : "neutral"}>{preview.counts.FAIL} fail</Chip><Chip tone="neutral">{preview.counts.SKIPPED} skipped</Chip>
                </div>
                {preview.problems.map((p, i) => <div key={i} className="banner bad">{p}</div>)}
                {preview.manifest && (
                  <div className="kv w140">
                    <span className="k">passport</span><span>v{preview.manifest.passportVersion} · {preview.manifest.disclosure} · generated by {preview.manifest.generator?.component} release <code>{preview.manifest.generator?.release}</code></span>
                    <span className="k">chain</span><span>{preview.manifest.chain?.caip2}</span>
                    <span className="k">subject</span><span>{preview.manifest.subject?.kind} · {preview.manifest.subject?.executionMode ?? "runner"} mode · order <code>{String(preview.manifest.subject?.orderId ?? "").slice(0, 12)}…</code></span>
                    <span className="k">coverage</span><span className="small">{Object.entries(preview.manifest.stageCoverage ?? {}).filter(([, v]) => v).map(([k]) => k).join(" · ") || "—"}</span>
                  </div>
                )}
                <details>
                  <summary className="small">{preview.findings.length} file and digest findings</summary>
                  <div className="tablewrap fit" style={{ marginTop: 8 }}><table className="t">
                    <thead><tr><th>file</th><th className="hide-narrow">check</th><th>result</th><th>detail</th></tr></thead>
                    <tbody>{preview.findings.map((f, i) => <tr key={i}><td className="small"><code style={{ overflowWrap: "anywhere" }}>{f.path}</code></td><td className="tiny dim hide-narrow">{f.check}</td><td><Chip tone={tone(f.status)}>{f.status}</Chip></td><td className="small muted" style={{ overflowWrap: "anywhere" }}>{f.detail}</td></tr>)}</tbody>
                  </table></div>
                </details>
                <p className="tiny dim">Counts, not a verdict. Online findings and anchors: step 3 or the CLI.</p>
              </div>
            )}
            {!preview && <p className="dim small">load a passport to preview it</p>}
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <h3>3 · Run the verifier here (online)</h3>
            <p className="small muted">The real verifier, in this tab, against <code>{rpc}</code>. Anchors are the digests <em>you</em> kept when you approved the baseline and wrote the policy; filling them from this site is a consistency check, not independence.</p>
            <div className="field"><label htmlFor="anc-b">baseline digests <span className="tiny dim">one per line or comma-separated</span></label><textarea id="anc-b" className="input mono" rows={2} value={anchorText.baseline} onChange={(e) => { setAnchorText((a) => ({ ...a, baseline: e.target.value })); setSiteFilled(false); }} placeholder="0x…" /></div>
            <div className="field"><label htmlFor="anc-p">policy digests</label><textarea id="anc-p" className="input mono" rows={2} value={anchorText.policy} onChange={(e) => { setAnchorText((a) => ({ ...a, policy: e.target.value })); setSiteFilled(false); }} placeholder="0x…" /></div>
            <div className="row"><button className="btn sm ghost" onClick={fillFromSite} disabled={!net?.fixtures?.some((f) => f.baselineDigest)}>fill baseline digests from this site (not independent)</button></div>
            <VerifyInBrowser bundle={bundle} name={name} net={net} anchors={anchors} anchorsSource={anchorsSource} />
          </div>
        </div>

        <HandRule />
        <div className="two" style={{ gap: 44, alignItems: "start" }}>
          <div className="stack" style={{ gap: 12 }}>
            <h3>4 · Or in a clean process (independent)</h3>
            <p className="small muted">No credentials, no database, no signing key: the passport, an Arc RPC you configure, and anchors you kept through a trusted channel.</p>
            <pre className="json selectable">{`git clone --recurse-submodules https://github.com/a252937166/arcpreflight && cd arcpreflight && pnpm install
pnpm exec tsx packages/verifier/src/cli.ts <passport.json> --rpc ${rpc} --anchors anchors.json
# offline (digests only):   pnpm exec tsx packages/verifier/src/cli.ts <passport.json>
# machine-readable output:  … --json      exit 0 = no FAIL finding, 2 = a finding FAILED`}</pre>
            <pre className="json selectable">{`{ "baselineDigests": ["0x…"], "policyDigests": ["0x…"] }   # anchors.json — the digests you trust`}</pre>
            <p className="small muted">Mainnet RPC <code>https://rpc.mainnet.arc.io</code> (5042) · testnet <code>https://rpc.testnet.arc.io</code> (5042002). Evidence from another chain is refused.</p>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <h3>What the verifier reports</h3>
            <p className="small muted">Each finding is PASS, FAIL, UNVERIFIED or NOT_EVALUATED — no single overall word. Missing trust or history yields UNVERIFIED, never an invented success.</p>
            <div className="tablewrap fit"><table className="t">
              <thead><tr><th>finding</th><th>needs</th><th>what it establishes</th></tr></thead>
              <tbody>{FINDINGS.map((f) => <tr key={f.id}><td><code style={{ overflowWrap: "anywhere" }}>{f.id}</code></td><td className="tiny dim">{f.needs}</td><td className="small muted">{f.plain}</td></tr>)}</tbody>
            </table></div>
            <p className="small muted">A rewritten passport with new hashes is not proof of the original approval. A transaction hash is not proof of delivery. A contract balance is not proof this order was paid. Format and rules: <code>docs/PASSPORT.md</code> · <Link to={link("/demo")}>start a run</Link> or <Link to={link("/developer")}>run the lifecycle with your wallet</Link> to get a passport.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
