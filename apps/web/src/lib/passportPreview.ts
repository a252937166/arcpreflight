// Offline integrity preview of a Payment Passport bundle (docs/PASSPORT.md): path rules, sha256 per file, and the core
// object digests recomputed with the schema's own digest functions. This runs the same code as the site — it is a
// convenience, not independence. For independence run packages/verifier in a clean process.
import { keccak256, stringToBytes } from "viem";
import { digest, intentDigest, reportDigest, policyDigest, baselineDigest, decisionDigest, transactionPlanDigest, finalValidationDigest, executionDigest, quoteDigest } from "@arcpreflight/schema";

export type PreviewStatus = "PASS" | "FAIL" | "SKIPPED";
export type PreviewFinding = { path: string; check: "path" | "sha256" | "object"; status: PreviewStatus; detail: string };
export type Preview = { manifest: any | null; findings: PreviewFinding[]; counts: Record<PreviewStatus, number>; problems: string[] };

const PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
export function pathProblem(p: string): string | null {
  if (!PATH_RE.test(p)) return "path has disallowed characters or is too long";
  if (p.startsWith("/")) return "absolute path";
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "empty or dot segment in path";
  return null;
}
const CORE: Record<string, (v: unknown) => string> = {
  intent: intentDigest, report: reportDigest, policy: policyDigest, baseline: baselineDigest, decision: decisionDigest,
  transactionPlan: transactionPlanDigest, finalValidation: finalValidationDigest, execution: executionDigest, quote: quoteDigest,
  evidence: (v) => digest("evidence", "1.0", v),
};
export const ACCEPTED_PROFILES = ["arcpreflight-jcs-keccak-1.0", "legacy-json-stringify-keccak-1.0", "sha256-file-1.0"] as const;

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "0x" + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function previewBundle(bundle: unknown): Promise<Preview> {
  const findings: PreviewFinding[] = []; const problems: string[] = [];
  const empty = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  const b = bundle as any;
  if (!b || typeof b !== "object" || b.passportBundleVersion !== "1.0" || !b.files || typeof b.files !== "object" || Array.isArray(b.files)) {
    return { manifest: null, findings, counts: empty, problems: ["not a passport bundle 1.0: expected { passportBundleVersion: \"1.0\", files: { path: content } }"] };
  }
  const files: Record<string, unknown> = b.files;
  const paths = Object.keys(files);
  if (paths.length > 200) problems.push(`${paths.length} files; the format allows at most 200`);
  const seen = new Set<string>();
  for (const p of paths) {
    const prob = pathProblem(p);
    if (prob) findings.push({ path: p, check: "path", status: "FAIL", detail: prob });
    else if (seen.has(p.toLowerCase())) findings.push({ path: p, check: "path", status: "FAIL", detail: "duplicate path (case-insensitive)" });
    seen.add(p.toLowerCase());
    if (typeof files[p] !== "string") findings.push({ path: p, check: "path", status: "FAIL", detail: "file content is not a string" });
  }
  let manifest: any = null;
  try { manifest = typeof files["manifest.json"] === "string" ? JSON.parse(files["manifest.json"] as string) : null; } catch { manifest = null; }
  if (!manifest) problems.push("manifest.json missing or not JSON");
  else {
    if (manifest.passportVersion !== "1.0") problems.push(`unknown passportVersion ${JSON.stringify(manifest.passportVersion)}`);
    const listed = new Set<string>();
    for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
      if (!f || typeof f.path !== "string") { findings.push({ path: String(f?.path ?? "?"), check: "sha256", status: "FAIL", detail: "manifest entry without a path" }); continue; }
      listed.add(f.path);
      const content = files[f.path];
      if (typeof content !== "string") { findings.push({ path: f.path, check: "sha256", status: "FAIL", detail: "listed in the manifest but missing from the bundle" }); continue; }
      const actual = await sha256Hex(content);
      const ok = actual === String(f.sha256 ?? "").toLowerCase();
      findings.push({ path: f.path, check: "sha256", status: ok ? "PASS" : "FAIL", detail: ok ? `sha256 matches (${content.length} chars)` : `sha256 ${actual.slice(0, 18)}… does not match the manifest` });
      const o = f.object;
      if (!o || !o.digestProfile) continue;
      try {
        if (o.digestProfile === "arcpreflight-jcs-keccak-1.0") {
          const fn = CORE[String(o.kind)];
          if (!fn) { findings.push({ path: f.path, check: "object", status: "SKIPPED", detail: `no digest function for kind ${o.kind}` }); continue; }
          const d = fn(JSON.parse(content));
          findings.push({ path: f.path, check: "object", status: d === o.digest ? "PASS" : "FAIL", detail: d === o.digest ? `${o.kind} digest reproduced` : `${o.kind} digest ${d.slice(0, 18)}… differs from the manifest` });
        } else if (o.digestProfile === "legacy-json-stringify-keccak-1.0") {
          const d = keccak256(stringToBytes(content));
          findings.push({ path: f.path, check: "object", status: d === o.digest ? "PASS" : "FAIL", detail: d === o.digest ? "legacy digest reproduced from the byte-exact preimage" : "legacy digest differs from the manifest" });
        } else {
          findings.push({ path: f.path, check: "object", status: "FAIL", detail: `unknown digest profile ${String(o.digestProfile)} (accepted: ${ACCEPTED_PROFILES.join(", ")})` });
        }
      } catch (e: any) { findings.push({ path: f.path, check: "object", status: "FAIL", detail: `object does not validate: ${String(e?.message ?? e).slice(0, 140)}` }); }
    }
    for (const p of paths) if (p !== "manifest.json" && !listed.has(p)) findings.push({ path: p, check: "sha256", status: "FAIL", detail: "present in the bundle but not listed in the manifest" });
  }
  const counts = { ...empty }; for (const f of findings) counts[f.status]++;
  return { manifest, findings, counts, problems };
}
