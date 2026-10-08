// arcpreflight-verify <dir|bundle.json> [--rpc <url>] [--anchors <file>] [--json]
// Runs without any ArcPreflight API, token or key. Exit 0: no FAIL finding; 2: at least one FAIL; 1: usage or load error.
//   pnpm exec tsx packages/verifier/src/cli.ts ./payment-passport --rpc https://rpc.mainnet.arc.io --anchors anchors.json
//   pnpm -C packages/verifier verify ./payment-passport --rpc … --anchors …      (same thing, via the package script)
//   node packages/verifier/bin/arcpreflight-verify.mjs ./payment-passport …        (launcher; needs tsx resolvable from the cwd)
import { verifyPassport } from "./verify.js";
import { rpcFromUrl } from "./rpc.js";
import { loadAnchorsFile, loadPassportPath } from "./node.js";
import { PassportLoadError } from "./load.js";
import type { Finding } from "./types.js";

function usage(code: number): never {
  console.error("usage: arcpreflight-verify <passport-dir | bundle.json> [--rpc <arc rpc url>] [--anchors <anchors.json>] [--json]\n  without --rpc the online findings are UNVERIFIED; without --anchors APPROVAL_SOURCE is UNVERIFIED");
  process.exit(code);
}
function parseArgs(argv: string[]) {
  const o: { path?: string; rpc?: string; anchors?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // `pnpm … verify -- <args>` forwards the separator
    if (a === "--rpc") o.rpc = argv[++i]; else if (a === "--anchors") o.anchors = argv[++i]; else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") usage(0); else if (a.startsWith("--")) usage(1); else if (!o.path) o.path = a; else usage(1);
  }
  if (!o.path || (o.rpc !== undefined && !o.rpc) || (o.anchors !== undefined && !o.anchors)) usage(1);
  return o as { path: string; rpc?: string; anchors?: string; json: boolean };
}
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
export function renderTable(findings: Finding[]): string {
  return findings.map((f) => `${pad(f.status, 13)} ${pad(f.id, 27)} ${f.detail}`).join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const o = parseArgs(argv);
  let files, anchors = null;
  try { files = loadPassportPath(o.path); if (o.anchors) anchors = loadAnchorsFile(o.anchors); }
  catch (e: any) { console.error(e instanceof PassportLoadError ? e.message : `cannot load passport: ${String(e?.message ?? e)}`); return 1; }
  const result = await verifyPassport(files, { rpc: o.rpc ? rpcFromUrl(o.rpc) : null, anchors });
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Payment Passport ${result.passportVersion ?? "?"} · ${result.chain.caip2 ?? "unknown chain"} · subject ${JSON.stringify(result.subject ?? null)}`);
    console.log(renderTable(result.findings));
    console.log(`\n${result.counts.pass} PASS · ${result.counts.fail} FAIL · ${result.counts.unverified} UNVERIFIED · ${result.counts.notEvaluated} NOT_EVALUATED${o.rpc ? "" : "  (no --rpc: online checks not run)"}${anchors ? "" : "  (no --anchors: approval source not checked)"}`);
  }
  return result.counts.fail ? 2 : 0;
}

if (process.env.ARCPREFLIGHT_VERIFY_IMPORT_ONLY !== "1") process.exit(await main().catch((e) => { console.error(`verifier error: ${String(e?.message ?? e)}`); return 1; }));
