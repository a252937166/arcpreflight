// Three ways in, one lifecycle (usage guide, 2026-10-10): the data the home page's tiles and the integration page's matrix share.
// Every cell names what a way DOES at a stage — a route, a command, a step — never a slogan. Hues mean ways and nothing else on these
// pages: sky = the HTTP API, mint = the command line in your own process, violet = this browser with your wallet.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LIFECYCLE_LABELS, type LifecycleId } from "../lib/outcome";

export type WayId = "api" | "cli" | "browser";
export type Way = { id: WayId; title: string; hue: string; what: string; needs: string; anchor: string };
export const WAYS: readonly Way[] = [
  { id: "api", title: "HTTP API", hue: "var(--sky)", what: "Your app or agent calls the service over JSON. Your own key signs the fee and the payment.", needs: "a session token and a wallet or key that can sign", anchor: "#api" },
  { id: "cli", title: "Command line", hue: "var(--mint)", what: "The reference agent runs a payment from a durable store. The verifier checks any passport in a clean process.", needs: "the repository checkout, Node 22.6 or newer, pnpm", anchor: "#cli" },
  { id: "browser", title: "Browser", hue: "var(--violet)", what: "The live demo pays from project funds. The wallet workflow runs every stage with your wallet.", needs: "a browser; for the wallet workflow, a wallet with testnet USDC", anchor: "#browser" },
];
export const wayById = (id: WayId): Way => WAYS.find((w) => w.id === id)!;

/** one cell of the matrix: what this way does at this stage */
export type Cell = { code?: string[]; text: string; /** the browser way: the page that holds the step */ to?: string; step?: string };
export const STAGES: readonly LifecycleId[] = ["order", "approve", "check", "execute", "recover", "passport", "verify"];
export const MATRIX: Record<LifecycleId, Record<WayId, Cell>> = {
  order: {
    api: { code: ["POST /v1/session", "POST /v1/demo/orders", "GET /v1/demo/orders/{orderId}"], text: "A session once, then your order, read back until confirmed." },
    cli: { code: ["pnpm exec tsx examples/merchant-agent/src/run.ts run APPROVED_PAYMENT"], text: "Creates the order with the order-creator key; the identity is stored first." },
    browser: { step: "Wallet workflow · step 1", to: "/developer", text: "The order dialog. The live demo creates its own." },
  },
  approve: {
    api: { code: ["GET /v1/baselines/{baselineDigest}"], text: "The approved baseline and its revocation state. The policy stays yours." },
    cli: { code: ["BASELINE_DIGEST_MAIN=0x…"], text: "Runs with the baseline digest you retained; its policy in its own config." },
    browser: { step: "Wallet workflow · step 2", to: "/developer", text: "Review the policy and the approval, then approve." },
  },
  check: {
    api: { code: ["POST /v1/preflight → 402 quote", "POST /v1/preflight + payment", "GET /v1/requests/{requestId}"], text: "A quote, one EIP-3009 fee authorization, the same intent again, the report." },
    cli: { code: ["… run.ts run <FIXTURE>"], text: "Buys the pinned report over x402 and applies the policy." },
    browser: { step: "Wallet workflow · step 3", to: "/developer", text: "Quote, sign the fee, read the report and the decision." },
  },
  execute: {
    api: { code: ["POST /v1/wallet/attempts", "POST /v1/wallet/attempts/{id}/prompt", "POST /v1/wallet/attempts/{id}/sent"], text: "Validate the exact plan, claim the prompt, report the hash. The wallet helper does all of it." },
    cli: { code: ["… run.ts run <FIXTURE> --crash-after-broadcast"], text: "Re-validates, signs exactly the plan, sends. The flag rehearses a crash." },
    browser: { step: "Wallet workflow · step 4", to: "/developer", text: "Execute with your wallet: it signs the validated plan, nothing else." },
  },
  recover: {
    api: { code: ["POST /v1/wallet/attempts/{id}/recover", "GET /v1/wallet/attempts/{id}", "POST /v1/requests/{requestId}/recover"], text: "Reconcile from the hash and the order. Abandon only a known rejection." },
    cli: { code: ["… run.ts reconcile", "… run.ts list"], text: "Open attempts resolved from the store and the chain, never re-signed." },
    browser: { step: "Wallet workflow · step 5", to: "/developer", text: "Recover here or on the recovery desk. Nothing is paid twice." },
  },
  passport: {
    api: { code: ["GET /v1/wallet/attempts/{id}/passport", "GET /v1/requests/{requestId}/passport", "GET /v1/demo/runs/{runId}/passport"], text: "The passport of an attempt, a paid check or a public run." },
    cli: { code: ["… run.ts passport <attemptId> --out <dir>"], text: "A stored run exported as a passport directory." },
    browser: { step: "Wallet workflow · step 6", to: "/developer", text: "Download your passport. Every demo run offers its own." },
  },
  verify: {
    api: { text: "No API call: the passport is self-contained." },
    cli: { code: ["pnpm exec tsx packages/verifier/src/cli.ts passport.json --rpc <rpc> --anchors anchors.json"], text: "Re-hash, re-read the chain, check the anchors. Exit 0 when nothing fails." },
    browser: { step: "Verify page", to: "/verify", text: "The same checks in this browser, labelled as not independent." },
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
