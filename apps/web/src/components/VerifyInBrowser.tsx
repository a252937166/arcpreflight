// "Verify independently", in this browser (docs/LIFECYCLE.md §6, §9): the real verifier over the downloaded bundle against the Arc RPC
// the browser reaches directly. The findings table says PASS / FAIL / UNVERIFIED / NOT_EVALUATED, and the state line above it says what
// that adds up to: passed only when nothing failed and nothing is unverified; any FAIL is a red stop state naming the findings; any
// UNVERIFIED is an amber partial state. Anchors a page prefills are the site's own digests and are labelled as such; the CLI line is the
// clean-process path.
import { useEffect, useRef, useState } from "react";
import { Chip, Hex, Spinner } from "./Badges";
import type { NetworkInfo } from "../lib/api";
import { anchorsJson, cliCommand, countsLine, findingTone, verificationState, verifyBundleInBrowser, type Anchors, type AnchorsSource, type VerificationResult, type VerificationState } from "../lib/verifyInBrowser";
import { describeError } from "../lib/errors";

export function VerifyInBrowser({ bundle, name, net, anchors, anchorsSource, onVerified, compact }: { bundle: unknown | null; name?: string | null; net: NetworkInfo | null; anchors: Anchors | null; anchorsSource: AnchorsSource; /** called after every completed run with the result AND its state — "completed" is not "passed" */ onVerified?: (r: VerificationResult, state: VerificationState) => void; compact?: boolean }) {
  const [state, setState] = useState<{ busy: boolean; result: VerificationResult | null; err: string | null }>({ busy: false, result: null, err: null });
  const rpc = net?.rpc ?? null;
  // audit 2026-10-10 (W02): a result belongs to the exact inputs it was computed for — the bundle, the RPC and the anchors. Any change of
  // those (or an unmount) moves the generation on: a verification still running for the old inputs is dropped when it lands, its callback
  // never fires, and the findings shown are only ever those of the inputs on screen.
  const identity = `${name ?? ""}|${rpc ?? ""}|${(anchors?.baselineDigests ?? []).join(",")}|${(anchors?.policyDigests ?? []).join(",")}|${anchorsSource}`;
  const gen = useRef(0);
  const bundleRef = useRef<unknown>(bundle); const identityRef = useRef(identity);
  if (bundleRef.current !== bundle || identityRef.current !== identity) { bundleRef.current = bundle; identityRef.current = identity; gen.current++; }
  useEffect(() => { setState({ busy: false, result: null, err: null }); }, [bundle, identity]); // new inputs: the previous findings no longer apply
  useEffect(() => () => { gen.current++; }, []); // unmounted: nothing in flight may report back
  const run = async () => {
    if (!bundle) return;
    const mine = gen.current;
    setState({ busy: true, result: null, err: null });
    try {
      const r = await verifyBundleInBrowser(bundle, { rpcUrl: rpc, anchors });
      if (gen.current !== mine) return; // the inputs changed while verifying: this result is nobody's
      setState({ busy: false, result: r, err: null }); onVerified?.(r, verificationState(r));
    } catch (e) { if (gen.current !== mine) return; setState({ busy: false, result: null, err: describeError(e).text }); }
  };
  const r = state.result;
  const vs = r ? verificationState(r) : null;
  const anchorCount = (anchors?.baselineDigests.length ?? 0) + (anchors?.policyDigests.length ?? 0);
  return (
    <div className="stack" style={{ gap: 10 }} data-testid="verify-in-browser" data-verification={vs?.kind ?? ""}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <button className="btn primary" disabled={!bundle || state.busy} onClick={run} title={bundle ? `runs packages/verifier in this tab against ${rpc ?? "no RPC"}` : "download the passport first"}>{state.busy ? <><Spinner /> verifying…</> : "Verify in browser"}</button>
        <span className="tiny dim">{name ? <><code>{name}</code> · </> : null}RPC <code>{rpc ?? "—"}</code> (online findings) · same verifier code as the CLI</span>
      </div>
      <div className="kv w150 small">
        <span className="k">anchors</span>
        <span>
          {anchorCount === 0 ? <Chip tone="warn">none — APPROVAL_SOURCE stays UNVERIFIED</Chip>
            : <span className="row" style={{ gap: 6 }}>{anchors!.baselineDigests.map((d) => <Chip key={d}>baseline <Hex value={d} n={5} /></Chip>)}{anchors!.policyDigests.map((d) => <Chip key={d}>policy <Hex value={d} n={5} /></Chip>)}
              <Chip tone={anchorsSource === "site" ? "warn" : "info"}>{anchorsSource === "site" ? "supplied by this site (not independent)" : "supplied by you"}</Chip></span>}
        </span>
      </div>
      {state.err && <div className="banner bad" role="alert">{state.err}</div>}
      {r && vs && (
        <div className="stack fade" style={{ gap: 8 }}>
          <div className={`banner ${vs.kind === "passed" ? "info ok" : vs.kind === "failed" ? "bad" : ""}`} role="status" data-testid="verification-state">{vs.kind === "passed" ? "✓ " : vs.kind === "failed" ? "✕ " : "! "}{vs.text}</div>
          <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <Chip tone={vs.kind === "passed" ? "ok" : "neutral"}>{r.counts.pass} PASS</Chip><Chip tone={r.counts.fail ? "bad" : "neutral"}>{r.counts.fail} FAIL</Chip><Chip tone={r.counts.unverified ? "warn" : "neutral"}>{r.counts.unverified} UNVERIFIED</Chip><Chip tone="neutral">{r.counts.notEvaluated} NOT_EVALUATED</Chip>
            <span className="tiny dim">{(r.subject as any)?.kind ?? "passport"} · {(r.subject as any)?.executionMode ?? "—"} mode · chain {r.chain.caip2 ?? r.chain.chainId}</span>
          </div>
          <div className="tablewrap fit"><table className="t findings">
            <thead><tr><th>finding</th><th className="fit">result</th><th>detail</th></tr></thead>
            <tbody>{r.findings.map((f) => <tr key={f.id} className={f.status === "FAIL" ? "fail" : ""}><td className="mono small" style={{ overflowWrap: "anywhere" }}>{f.id}</td><td className="fit"><Chip tone={findingTone(f.status)}>{f.status}</Chip></td><td className="small muted" style={{ overflowWrap: "anywhere" }}>{compact && f.detail.length > 160 ? <details><summary className="tiny">{f.detail.slice(0, 120)}…</summary>{f.detail}</details> : f.detail}</td></tr>)}</tbody>
          </table></div>
          <p className="tiny dim">{countsLine(r)}. {anchorsSource === "site" ? "The anchors came from this site: APPROVAL_SOURCE confirms consistency with what the site says it approved, not independence." : ""}</p>
        </div>
      )}
      <details>
        <summary className="small">Same check in a clean process (CLI)</summary>
        <pre className="json selectable" style={{ marginTop: 8 }}>{`# anchors.json — digests you kept yourself, not copied from the passport\n${anchors ? anchorsJson(anchors) : `{ "baselineDigests": ["0x…"], "policyDigests": ["0x…"] }`}\n\n${cliCommand(rpc ?? "https://rpc.testnet.arc.io", name ?? "passport.json")}\n# exit 0 = no FAIL finding, 2 = a finding FAILED · --json for machine-readable output`}</pre>
      </details>
    </div>
  );
}
