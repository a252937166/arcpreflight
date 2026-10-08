// Independent verification, in the visitor's browser (docs/LIFECYCLE.md §6): the real verifier (`packages/verifier`) runs on the
// downloaded bundle against an Arc RPC the browser reaches directly (the Arc RPCs answer cross-origin requests). The anchors a page
// prefills are the site's own digests — labelled as such: a passport verified against anchors supplied by the party that wrote it
// is a consistency check, not independence. The CLI in a clean process with anchors kept elsewhere is the independent path.
import { verifyPassport, rpcFromUrl, type Anchors, type VerificationResult, type FindingStatus } from "@arcpreflight/verifier";
import { fromBundle } from "@arcpreflight/passport";

export type { Anchors, VerificationResult, FindingStatus };
export type AnchorsSource = "site" | "user" | "none";

/** parse + verify; throws PassportFormatError (from the passport package) on a malformed bundle */
export async function verifyBundleInBrowser(bundle: unknown, opts: { rpcUrl: string | null; anchors: Anchors | null; timeoutMs?: number }): Promise<VerificationResult> {
  const files = fromBundle(bundle);
  const rpc = opts.rpcUrl ? rpcFromUrl(opts.rpcUrl, opts.timeoutMs ?? 20_000) : null;
  return verifyPassport(files, { rpc, anchors: opts.anchors && (opts.anchors.baselineDigests.length || opts.anchors.policyDigests.length) ? opts.anchors : null });
}

/** the one-liner for a clean-process verification of the same bundle (anchors.json written by hand from the digests the buyer kept) */
export function cliCommand(rpcUrl: string, passportFile = "passport.json", anchorsFile = "anchors.json"): string {
  return `pnpm exec tsx packages/verifier/src/cli.ts ${passportFile} --rpc ${rpcUrl} --anchors ${anchorsFile}`;
}
export const anchorsJson = (a: Anchors) => JSON.stringify({ baselineDigests: a.baselineDigests, policyDigests: a.policyDigests }, null, 2);
/** split a pasted list of digests ("0x…, 0x…" or one per line) into valid 32-byte hex values */
export const parseDigests = (text: string): string[] => Array.from(new Set((text.match(/0x[0-9a-fA-F]{64}/g) ?? []).map((d) => d.toLowerCase())));
export const findingTone = (s: FindingStatus): "ok" | "bad" | "warn" | "neutral" => (s === "PASS" ? "ok" : s === "FAIL" ? "bad" : s === "UNVERIFIED" ? "warn" : "neutral");
/** counts, never a verdict word */
export const countsLine = (r: VerificationResult) => `${r.counts.pass} PASS · ${r.counts.fail} FAIL · ${r.counts.unverified} UNVERIFIED · ${r.counts.notEvaluated} NOT_EVALUATED`;

// ---- review round 2 (docs/LIFECYCLE.md §9, item 1c): "completed" is not "passed"
export type VerificationKind = "passed" | "failed" | "partial";
export type VerificationState = { kind: VerificationKind; tone: "ok" | "bad" | "warn"; failing: string[]; unverified: string[]; counts: VerificationResult["counts"]; text: string };
/** passed = no FAIL and no UNVERIFIED (NOT_EVALUATED does not count against); any FAIL is a red stop state naming the failing findings;
 *  any UNVERIFIED without a FAIL is an amber partial state. */
export function verificationState(r: VerificationResult): VerificationState {
  const failing = r.findings.filter((f) => f.status === "FAIL").map((f) => f.id);
  const unverified = r.findings.filter((f) => f.status === "UNVERIFIED").map((f) => f.id);
  const c = r.counts;
  if (c.fail > 0 || failing.length) return { kind: "failed", tone: "bad", failing, unverified, counts: c, text: `Verification FAILED — ${failing.join(", ")}: the passport contradicts the chain or its own records. Do not treat this payment as proven.` };
  if (c.unverified > 0 || unverified.length) return { kind: "partial", tone: "warn", failing, unverified, counts: c, text: `Partially verified (${c.unverified} unverified: ${unverified.join(", ")}) — nothing contradicted the records, but these findings could not be established (missing anchors, RPC or history). Not a pass.` };
  return { kind: "passed", tone: "ok", failing, unverified, counts: c, text: `Passed: every evaluated finding is PASS (${c.pass} PASS · ${c.notEvaluated} NOT_EVALUATED, which does not count against).` };
}
/** the lifecycle rail's "verify" stage: a green check only when passed */
export const verificationStageStatus = (k: VerificationKind | null | undefined): "done" | "stop" | "warn" | "todo" => (k === "passed" ? "done" : k === "failed" ? "stop" : k === "partial" ? "warn" : "todo");
