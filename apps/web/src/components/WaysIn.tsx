// Three ways in, one lifecycle (usage guide, 2026-10-10): the data the home page's tiles and the integration page's matrix share.
// Every cell names what a way DOES at a stage — a route, a command, a step — never a slogan. Hues mean ways and nothing else on these
// pages: sky = the HTTP API, mint = the command line in your own process, violet = this browser with your wallet.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LIFECYCLE_LABELS, type LifecycleId } from "../lib/outcome";

export type WayId = "api" | "cli" | "browser";
export type Way = { id: WayId; title: string; hue: string; what: string; needs: string; anchor: string };
export const WAYS: readonly Way[] = [
  { id: "api", title: "HTTP API", hue: "var(--sky)", what: "Your app or agent calls the service over JSON. Your signer authorizes the check fee and the payment; the service records, validates and recovers.", needs: "one session token and a wallet or key that can sign", anchor: "#api" },
  { id: "cli", title: "Command line", hue: "var(--mint)", what: "The reference agent drives a payment from a durable store and restarts into recovery. The verifier checks any passport in a clean process.", needs: "the repository checkout, Node 22.6 or newer and pnpm", anchor: "#cli" },
  { id: "browser", title: "Browser", hue: "var(--violet)", what: "The live demo pays real testnet orders from project funds. The wallet workflow runs every stage with your own wallet and exports your passport.", needs: "a browser, and a wallet with testnet USDC for the wallet workflow", anchor: "#browser" },
];
export const wayById = (id: WayId): Way => WAYS.find((w) => w.id === id)!;

/** one cell of the matrix: what this way does at this stage */
export type Cell = { code?: string[]; text: string; /** the browser way: the page that holds the step */ to?: string; step?: string };
export const STAGES: readonly LifecycleId[] = ["order", "approve", "check", "execute", "recover", "passport", "verify"];
export const MATRIX: Record<LifecycleId, Record<WayId, Cell>> = {
  order: {
    api: { code: ["POST /v1/session", "POST /v1/demo/orders", "GET /v1/demo/orders/{orderId}"], text: "Open an anonymous session once. Create an order for your payer on the MAIN or CHANGED proxy, then read it back until its creation is confirmed." },
    cli: { code: ["run.ts run APPROVED_PAYMENT"], text: "The reference agent creates the order with the order-creator key and writes its identity to the store before anything is sent." },
    browser: { step: "Wallet workflow · step 1", to: "/developer", text: "The order dialog creates your order. The live demo creates its own from project funds." },
  },
  approve: {
    api: { code: ["GET /v1/baselines/{baselineDigest}"], text: "Read the approved baseline the order references and whether it is revoked. The policy is yours and stays in your code." },
    cli: { code: ["BASELINE_DIGEST_MAIN=0x…"], text: "The agent runs with the approved baseline digest you retained; its policy sits in its own configuration." },
    browser: { step: "Wallet workflow · step 2", to: "/developer", text: "Review the policy and the referenced approval, then approve and continue." },
  },
  check: {
    api: { code: ["POST /v1/preflight → 402 quote", "POST /v1/preflight + payment", "GET /v1/requests/{requestId}"], text: "Send the exact intent for a quote, sign one EIP-3009 authorization for the fee, send the same intent with it. Poll the request while the fee settles, then decide from the report." },
    cli: { code: ["run.ts run <FIXTURE>"], text: "The same run buys the pinned report over x402 with the runner's key and applies the policy. BLOCKED and REVIEW_REQUIRED stop here." },
    browser: { step: "Wallet workflow · step 3", to: "/developer", text: "Get the quote, sign the fee in your wallet, read the report and the decision. The live demo's wallet check does the same without executing." },
  },
  execute: {
    api: { code: ["POST /v1/wallet/attempts", "POST /v1/wallet/attempts/{id}/prompt", "POST /v1/wallet/attempts/{id}/sent"], text: "Validate the exact plan at a fresh block and record the attempt. Claim the prompt before your wallet signs. Report the hash the moment the wallet returns it." },
    cli: { code: ["run.ts run <FIXTURE> --crash-after-broadcast"], text: "The agent re-validates, signs exactly the plan, persists a broadcast marker and sends. The flag rehearses a crash right after the send." },
    browser: { step: "Wallet workflow · step 4", to: "/developer", text: "Execute with your wallet: the validated plan is what the wallet is asked to sign, nothing else." },
  },
  recover: {
    api: { code: ["POST /v1/wallet/attempts/{id}/recover", "GET /v1/wallet/attempts/{id}", "POST /v1/requests/{requestId}/recover"], text: "Reconcile the original attempt from its hash and the order state, then observe it. A fee settlement recovers the same way. Abandon only a prompt you know was rejected." },
    cli: { code: ["run.ts reconcile", "run.ts list"], text: "Restart into reconciliation: open attempts are resolved from the store and the chain, never re-signed." },
    browser: { step: "Wallet workflow · step 5", to: "/developer", text: "Recover the attempt here or on the demo's recovery desk. Nothing is paid twice." },
  },
  passport: {
    api: { code: ["GET /v1/wallet/attempts/{id}/passport", "GET /v1/requests/{requestId}/passport", "GET /v1/demo/runs/{runId}/passport"], text: "Export the Payment Passport of an attempt, of a paid check, or of a public demo run." },
    cli: { code: ["run.ts passport <attemptId> --out <dir>"], text: "Export a stored run as a passport directory, with public or private disclosure." },
    browser: { step: "Wallet workflow · step 6", to: "/developer", text: "Download your passport. Every finished demo run offers its own on its run page." },
  },
  verify: {
    api: { text: "No API call. The passport is self-contained: verify it with the command line in a clean process, or in this browser." },
    cli: { code: ["arcpreflight-verify passport.json --rpc <rpc> --anchors anchors.json"], text: "Re-hash every record, re-read the chain and check the approval against anchors you already trust. Exit 0 when nothing fails." },
    browser: { step: "Verify page", to: "/verify", text: "The same checks in this browser, labelled as not independent of this site." },
  },
};
export const stageLabel = (id: LifecycleId) => LIFECYCLE_LABELS[id];

/** the three tiles: on the home page they lead to the guide's sections, on the guide to the sections of the same page */
export function WayTiles({ hrefFor, compact }: { hrefFor: (w: Way) => string; compact?: boolean }) {
  return (
    <div className={`ways-tiles${compact ? " compact" : ""}`} role="list">
      {WAYS.map((w) => (
        <Link key={w.id} role="listitem" to={hrefFor(w)} className="ways-tile" style={{ "--way": w.hue } as CSSProperties} data-way={w.id}>
          <span className="ways-tile-title">{w.title}</span>
          <span className="ways-tile-what">{w.what}</span>
          {!compact && <span className="ways-tile-needs">Needs {w.needs}.</span>}
        </Link>
      ))}
    </div>
  );
}

/** a copyable block: a command, a request body, or a captured output (`output`) */
export function Snippet({ label, code, note, output, wide }: { label: string; code: string; note?: ReactNode; output?: boolean; /** full width, no wrapping: a terminal capture read as printed */ wide?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "unavailable">("idle");
  const copy = async () => { try { await navigator.clipboard.writeText(code); setState("copied"); } catch { setState("unavailable"); } };
  return (
    <figure className={`snippet${output ? " output" : ""}${wide ? " wide" : ""}`}>
      <figcaption className="snippet-head"><span>{label}</span>{!output && <button type="button" className="btn sm ghost" onClick={() => void copy()} aria-label={`Copy: ${label}`}>{state === "copied" ? "Copied" : "Copy"}</button>}</figcaption>
      <pre className="snippet-code"><code>{code}</code></pre>
      {state === "unavailable" && <p className="tiny muted" role="status">Copy is unavailable here. Select the text to copy it.</p>}
      {note && <p className="tiny dim snippet-note">{note}</p>}
    </figure>
  );
}
