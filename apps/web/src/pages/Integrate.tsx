// How to use ArcPreflight (usage guide, 2026-10-10): three ways in — the HTTP API, the command line, this browser — and what each one does
// at every stage of the one lifecycle. Everything on the page is real: the routes of this instance, the commands of the repository, a
// verifier run captured on a published passport, and the instance's own facts read from GET /v1/network when the page loads.
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, apiPath, type NetworkInfo } from "../lib/api";
import { netName } from "../lib/network";
import { usdcToken } from "../lib/format";
import { MATRIX, STAGES, WAYS, WayTiles, Snippet, stageLabel, wayById, type Way } from "../components/WaysIn";
import lifecycleDownload from "../../../../docs/LIFECYCLE.md?url";
import requestContractsDownload from "../../../../packages/schema/src/types.ts?url";
import authorizationHelperDownload from "../../../../packages/client/src/eip3009.ts?url";
import walletHelperDownload from "../../../../packages/client/src/walletExecute.ts?url";

const REPOSITORY = "https://github.com/a252937166/arcpreflight";
/** a published wallet passport and its anchors, used for the captured verifier run below */
const PASSPORT_FILE = "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.passport.json";
const ANCHORS_FILE = "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.anchors.json";
/** what `arcpreflight-verify` printed for that passport on 2026-10-10 against rpc.testnet.arc.io (detail columns shortened to one line) */
const VERIFIER_RUN = `Payment Passport 1.0 · eip155:5042002 · subject wallet-run · attempt 07b79860… · payer 0xA711…3FF2
PASS           FILE_INTEGRITY              33 files listed, present and intact
PASS           DIGEST_INTEGRITY            24 digested objects re-hashed under accepted profiles; cross-links hold
PASS           DISCLOSURE                  no signatures, private keys, encrypted payloads or signed transaction bytes in the export
PASS           APPROVAL_SOURCE             baseline 0x12ec…a027 and policy 0x749b…7486 match the supplied anchors
PASS           APPROVAL_COVERAGE           every receipt references approval 0x12ec…a027; report MATCH, decision NO_POLICY_VIOLATION; not revoked
PASS           NETWORK_IDENTITY            RPC serves chain 5042002 (eip155:5042002); USDC is the canonical 0x3600…0000
PASS           FEE_ATTRIBUTION             10000 token units moved payer → merchant in 0x1913…c37e (block 66442423), relayed through transferWithAuthorization
PASS           TRANSACTION_PLAN_AGREEMENT  business transaction 0xfa61…1339 matches the validated plan in chainId, type, from, to, data and value
PASS           ORDER_OUTCOME               order 0x6bbf…5cba reads paid=true by the payer for 5000000000000000 at block 66442454; post-condition reproduced byte-exact
PASS           COST_STATEMENT              recomputed statement matches field by field: buyer total 0.0160091 USDC, operator total 0.004686225 USDC
NOT_EVALUATED  CURRENT_ELIGIBILITY         whether a new payment may execute now is a present-time question; never inferred from history

10 PASS · 0 FAIL · 0 UNVERIFIED · 1 NOT_EVALUATED        exit 0`;

type Counts = { runs: number | null; files: number | null };
const hue = (w: Way): CSSProperties => ({ "--way": w.hue } as CSSProperties);

function InstanceCard({ net, apiBase, counts }: { net: NetworkInfo | null; apiBase: string; counts: Counts }) {
  const execution = !net?.access ? null : net.access.publicExecution === false ? { text: "gated until the mainnet acceptance", tone: "warn" } : net.access.walletExecution === false ? { text: "demo runs only; wallet execution closed", tone: "warn" } : { text: "open: demo runs and wallet execution", tone: "ok" };
  const facts: [string, string | number | null | undefined, string?][] = [
    ["API base", apiBase.replace(/^https?:\/\//, "")], // the host fits the card on one line; every command below carries the full origin
    ["Network", net ? `${netName(net.network)} · chain ${net.chainId}` : null],
    ["Head", net?.head ? `#${net.head}` : null],
    ["Check price", net ? usdcToken(net.priceTokenAtomic) : null],
    ["Execution", execution?.text ?? null, execution?.tone],
    ["Demo runs today", net ? `${net.budget.usedToday} of ${net.budget.maxRunsPerDay}` : null],
    ["Runs recorded", counts.runs],
    ["Evidence files", counts.files],
    ["Release", net?.release ?? null],
  ];
  return (
    <aside className="instance" aria-label="This instance, read when the page loaded">
      <div className="instance-head"><h2>This instance, now</h2><span className="live">live</span></div>
      <dl className="instance-facts">
        {facts.map(([k, v, tone]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className={tone ?? ""}>{v === null || v === undefined ? "…" : String(v)}</dd></div>)}
      </dl>
      <p className="tiny dim instance-note">Read from <code>GET /v1/network</code> when this page loaded. Switching the network in the header changes every route and command on this page.</p>
    </aside>
  );
}

export default function Integrate() {
  const { net, base = "", link = (to: string) => to } = useNet();
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
  const apiBase = `${origin}${base}`;
  const price = net ? usdcToken(net.priceTokenAtomic) : "0.01 USDC";
  const rpc = net?.rpc ?? "https://rpc.testnet.arc.io";
  const merchant = net?.fixtures.find((f) => f.id === "APPROVED_PAYMENT")?.merchant ?? "<merchant proxy from GET /v1/network>";
  const [counts, setCounts] = useState<Counts>({ runs: null, files: null });
  useEffect(() => {
    let alive = true;
    Promise.all([api.runs(1).catch(() => null), api.evidence().catch(() => null)]).then(([r, e]) => { if (alive) setCounts({ runs: r?.total ?? null, files: e?.files.length ?? null }); });
    return () => { alive = false; };
  }, [base]);
  const api_ = wayById("api"), cli = wayById("cli"), browser = wayById("browser");
  const networkPreview = net ? JSON.stringify({ network: net.network, chainId: net.chainId, head: net.head, release: net.release, priceTokenAtomic: net.priceTokenAtomic, access: net.access ? { publicExecution: net.access.publicExecution, walletExecution: net.access.walletExecution } : undefined }, null, 2) : "…";

  // every command line stays under 66 characters: it is read in a column, never wrapped mid-token
  const readInstance = `curl -s "${apiBase}/v1/network" \\
  | jq '{network, chainId, head, priceTokenAtomic, access}'`;
  const openSession = `curl -s -X POST "${apiBase}/v1/session"
# → { "principal": "visitor:…", "token": "…" }
# keep the token private: it owns your orders, checks and attempts
export TOKEN=…`;
  const createOrder = `curl -s -X POST "${apiBase}/v1/demo/orders" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "payer": "0xYourWallet", "proxy": "MAIN",
        "amountNativeAtomic": "50000000000000000" }'
# → the order id, its creation transaction and state;
#   read GET /v1/demo/orders/{orderId} until "CONFIRMED"`;
  const quoteCheck = `curl -s -X POST "${apiBase}/v1/preflight" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "intent": {
    "schemaVersion": "1.0",
    "clientRequestId": "my-agent-0001",
    "chainId": ${net?.chainId ?? 5042002},
    "walletMode": "EOA_DIRECT_NON_DELEGATED",
    "from": "0xYourWallet",
    "operation": "CALL",
    "to": "${merchant}",
    "data": "0x8609cad1<orderId>",
    "valueNativeAtomic": "50000000000000000",
    "businessExpectation": {
      "action": "MERCHANT_PAY",
      "orderId": "0x<orderId>",
      "recipient": "${merchant}",
      "asset": "ARC_NATIVE_USDC",
      "amountNativeAtomic": "50000000000000000",
      "sourceId": "order:<orderId>",
      "sourceDigest": "0x<keccak256 of order:id:payer:amount>"
    },
    "baselineDigest": "0x<approved baseline>",
    "policyDigest": "0x<your policy digest>",
    "expiresAt": "<now + 10 min, UTC>"
  } }'
# → 402 { requestId, quote: { amountTokenAtomic: "${net?.priceTokenAtomic ?? "10000"}", … } }
#   sign ONE EIP-3009 authorization for exactly that quote and resend
#   the same intent with "payment": { signature, authorization }
#   → 202 while the fee settles on Arc, then the report`;
  const executeAttempt = `curl -s -X POST "${apiBase}/v1/wallet/attempts" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "requestId": "<from the paid check>",
        "orderId": "0x<orderId>", "policy": { …your policy… } }'
# → VALIDATED: the exact plan and validUntil, or 409 with reasons
# then, in order:
#   POST …/{id}/prompt  { "event": "prompted", "claimId": "<uuid>" }
#   your wallet signs exactly the plan (eth_sendTransaction)
#   POST …/{id}/sent    { "txHash": "0x…" }      the moment it returns
#   GET  …/{id} until CONFIRMED
#   a lost answer → POST …/{id}/recover, never a second payment`;

  const walletHelper = `// packages/client/src/walletExecute.ts (download below): the hand-over
// the site performs, for your own code — one instance, one session
import { executeValidatedAttempt } from "@arcpreflight/client";
const r = await executeValidatedAttempt({
  api: "${apiBase}", token: TOKEN,
  attemptId, provider: window.ethereum,   // any EIP-1193 provider
});
// it reads the attempt; converts the plan to the wallet's fields
// (hex value, gas, fees, type 2, chainId; no nonce); checks the
// account, the chain and the window; claims the prompt (claimId);
// checks again; eth_sendTransaction; reports the hash at once.
switch (r.outcome) {
  case "sent": /* r.txHash; observe GET …/{id} until it closes */ break;
  case "not-prompted": /* r.check.code: ACCOUNT_CHANGED, CHAIN_CHANGED,
     WINDOW_CLOSED, ATTEMPT_UNCERTAIN … nothing was asked */ break;
  case "claimed-elsewhere": /* another tab holds the claim: recover */ break;
  case "abandoned": /* the wallet prompt was rejected: NOT_SENT */ break;
  case "unknown-submission": /* marked and reconciled; never re-prompt */ break;
}`;
  const setupCheckout = `git clone --recurse-submodules \\
  https://github.com/a252937166/arcpreflight && cd arcpreflight
pnpm install && (cd packages/contracts && forge build)
# Node 22.6 or newer, pnpm and Foundry. The public repository holds an
# older release than this site; the commands below exist in both.`;
  const verifyPublished = `E=${apiBase}/v1/evidence/selftest/passports
P=testnet-wallet-2026-10-10T07-35-28-806Z
curl -sO "$E/$P.passport.json" && curl -sO "$E/$P.anchors.json"
pnpm exec tsx packages/verifier/src/cli.ts $P.passport.json \\
  --rpc ${rpc} --anchors $P.anchors.json
# run from the checkout's root; no API, no token, no key
# exit 0 when nothing fails, 2 on a FAIL; --json for machines
# without --rpc the online findings stay UNVERIFIED`;
  const runAgent = `# against your own testnet API (README): the runner key pays
# the check fee and the order; run from the checkout's root
ARC_NET=testnet API_URL=http://127.0.0.1:4040 \\
RUNNER_TOKEN=… BASELINE_DIGEST_MAIN=0x… \\
  pnpm exec tsx examples/merchant-agent/src/run.ts run APPROVED_PAYMENT
# the same, stopping right after the send, like a crash:
ARC_NET=testnet API_URL=http://127.0.0.1:4040 \\
RUNNER_TOKEN=… BASELINE_DIGEST_MAIN=0x… \\
  pnpm exec tsx examples/merchant-agent/src/run.ts run APPROVED_PAYMENT \\
  --crash-after-broadcast
# resolve open attempts from the store; never re-signs
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts reconcile
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts list
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts \\
  passport <attemptId> --out ./passport`;

  return (
    <div className="ways-page">
      <section className="section" style={{ paddingBottom: 40 }}>
        <div className="container">
          <div className="ways-hero">
            <div className="stack" style={{ gap: 20 }}>
              <p className="kicker">How to use ArcPreflight · {netName(net?.network)}</p>
              <h1>Three ways in.<br />One lifecycle.</h1>
              <p className="lead">Create an order, approve it, check it, pay it, recover it if needed, export its Payment Passport, verify it anywhere. Seven stages, driven from your code, your terminal or this browser.</p>
              <WayTiles hrefFor={(w) => w.anchor} />
              <p className="mcp-line">MCP: this release has no MCP server. An MCP-capable agent uses the HTTP API.</p>
            </div>
            <InstanceCard net={net} apiBase={apiBase} counts={counts} />
          </div>
        </div>
      </section>

      <section className="section-tight" aria-labelledby="matrix-title">
        <div className="container">
          <div className="ways-head">
            <h2 id="matrix-title">What each way does, stage by stage.</h2>
            <p className="muted" style={{ maxWidth: 760 }}>Real routes, real commands, the real steps on this instance.</p>
          </div>
          <div className="matrix-wrap">
            <table className="matrix">
              <thead><tr><th scope="col">Stage</th>{WAYS.map((w) => <th key={w.id} scope="col" style={hue(w)}><a href={w.anchor}>{w.title}</a></th>)}</tr></thead>
              <tbody>
                {STAGES.map((id, i) => (
                  <tr key={id}>
                    <th scope="row"><span><span className="lc-dot" aria-hidden="true">{i + 1}</span><span>{stageLabel(id)}</span></span></th>
                    {WAYS.map((w) => { const c = MATRIX[id][w.id]; return (
                      <td key={w.id} data-way={w.title} style={hue(w)}>
                        {c.step && c.to && <Link className="m-step" to={link(c.to)}>{c.step}</Link>}
                        {c.code && <ul className="m-code">{c.code.map((x) => <li key={x}><code>{x}</code></li>)}</ul>}
                        <p>{c.text}</p>
                      </td>); })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="api" className="way" style={hue(api_)} tabIndex={-1} aria-labelledby="way-api">
        <div className="container">
          <div className="way-head"><span className="way-mark" aria-hidden="true" /><div><h2 id="way-api">HTTP API</h2><p className="muted">Your app calls <code>{apiBase}/v1</code> with JSON. Your own wallet or key signs two things: the {price} fee authorization and the payment transaction. The service never holds your keys.</p></div></div>
          <div className="way-body">
            <div className="stack" style={{ gap: 14 }}>
              <h3>What it does</h3>
              <dl className="fn-list">
                <div><dt><code>GET /v1/network</code></dt><dd>Chain, head, price, fixtures, execution availability. No token.</dd></div>
                <div><dt><code>POST /v1/session</code></dt><dd>A bearer token that owns what you create.</dd></div>
                <div><dt><code>POST /v1/demo/orders</code></dt><dd>An order payable only by your wallet.</dd></div>
                <div><dt><code>GET /v1/baselines/{"{digest}"}</code></dt><dd>The approved baseline and its revocation state.</dd></div>
                <div><dt><code>POST /v1/preflight</code></dt><dd>The x402 check: a quote, then the pinned report.</dd></div>
                <div><dt><code>GET /v1/requests/{"{id}"}</code></dt><dd>The paid check as recorded, with recovery next to it.</dd></div>
                <div><dt><code>POST /v1/wallet/attempts</code></dt><dd>The exact plan, validated and recorded before any prompt.</dd></div>
                <div><dt><code>…/{"{id}"}/prompt · /sent · /recover · /abandon</code></dt><dd>Claim, hash, reconciliation, explicit rejection.</dd></div>
                <div><dt><code>GET …/{"{id}"}/passport</code></dt><dd>The Payment Passport of an attempt, a check or a run.</dd></div>
                <div><dt><code>GET /v1/public-reports · /v1/subjects/{"{address}"} · /v1/demo/runs · /v1/evidence</code></dt><dd>Sample reports, observed contracts, runs, evidence files.</dd></div>
              </dl>
              <p className="muted">Every request and response shape is in the <Link to={link("/api")}>API reference</Link>.</p>
            </div>
            <div className="stack" style={{ gap: 14 }}>
              <Snippet label="Read this instance" code={readInstance} />
              <Snippet output label="What it answers right now" code={networkPreview} note="an excerpt of the live answer, read when this page loaded" />
              <Snippet label="Open a session" code={openSession} />
              <Snippet label="Create an order for your wallet (0.05 USDC on the MAIN proxy)" code={createOrder} />
              <Snippet label="Quote the check, pay its fee, receive the report" code={quoteCheck} note="the data is pay(orderId) on the DemoMerchant proxy; every field is defined in the request schema below" />
              <Snippet label="Validate, claim the prompt, sign, report the hash, recover" code={executeAttempt} />
              <Snippet label="The same hand-over from your own code: the wallet helper" code={walletHelper} note={<>the helper is <a href={walletHelperDownload} download="arcpreflight-walletExecute.ts">one file without dependencies</a>, tested in <code>packages/client/test/walletExecute.test.ts</code>; the site's Developer page runs the same checks</>} />
            </div>
          </div>
        </div>
      </section>

      <section id="cli" className="way" style={hue(cli)} tabIndex={-1} aria-labelledby="way-cli">
        <div className="container">
          <div className="way-head"><span className="way-mark" aria-hidden="true" /><div><h2 id="way-cli">Command line</h2><p className="muted">Two programs in the repository, run with <code>pnpm exec tsx</code> from the checkout's root: nothing is on npm, and the public repository holds an older release than this site. The verifier needs only a passport, an Arc RPC and anchors you trust. The reference agent runs the lifecycle from a durable store and restarts into recovery.</p></div></div>
          <div className="way-body">
            <div className="stack" style={{ gap: 14 }}>
              <h3>What it does</h3>
              <dl className="fn-list">
                <div><dt><code>pnpm exec tsx packages/verifier/src/cli.ts &lt;passport&gt; --rpc --anchors</code></dt><dd>Re-hashes, re-reads the chain, checks the anchors. Exit 0, or 2 on a FAIL.</dd></div>
                <div><dt><code>pnpm exec tsx examples/merchant-agent/src/run.ts run &lt;FIXTURE&gt;</code></dt><dd>Order, report, decision, validation, signature, broadcast, outcome, receipts.</dd></div>
                <div><dt><code>… run.ts run &lt;FIXTURE&gt; --crash-after-broadcast</code></dt><dd>Stops right after the send, like a crash.</dd></div>
                <div><dt><code>… run.ts reconcile</code></dt><dd>Resolves open attempts; the only way a crashed run continues.</dd></div>
                <div><dt><code>… run.ts list · … run.ts passport &lt;attemptId&gt; --out &lt;dir&gt;</code></dt><dd>Lists stored runs; exports one as a passport.</dd></div>
              </dl>
              <p className="muted">Fixtures: <code>APPROVED_PAYMENT</code>, <code>CHANGED_IMPLEMENTATION</code>, <code>AMOUNT_UNIT_MISMATCH</code>. A run spends the runner key's testnet funds.</p>
            </div>
            <div className="stack" style={{ gap: 14 }}>
              <Snippet label="Get the checkout" code={setupCheckout} />
              <Snippet label="Verify a published passport in a clean process" code={verifyPublished} note={<>the passport and its anchors are published under <a href={apiPath(`/v1/evidence/${PASSPORT_FILE}`)} target="_blank" rel="noreferrer">/v1/evidence</a>; anchors you copied from this site check consistency, independence needs anchors you already held</>} />
              <Snippet label="Run the reference agent" code={runAgent} />
            </div>
          </div>
          <Snippet output wide label="What it printed on 2026-10-10 for that passport" code={VERIFIER_RUN} note="captured from the real run against rpc.testnet.arc.io; the detail columns are shortened to one line each" />
        </div>
      </section>

      <section id="browser" className="way" style={hue(browser)} tabIndex={-1} aria-labelledby="way-browser">
        <div className="container">
          <div className="way-head"><span className="way-mark" aria-hidden="true" /><div><h2 id="way-browser">Browser</h2><p className="muted">Nothing to install. The live demo spends project funds on real testnet orders. The wallet workflow runs the same seven stages with your wallet. Both end in a passport.</p></div></div>
          <div className="way-body">
            <div className="stack" style={{ gap: 14 }}>
              <h3>What it does</h3>
              <dl className="fn-list">
                <div><dt><Link className="plain" to={link("/demo")}>Live demo</Link></dt><dd>Three scenarios paid by the project's runner, interruption and recovery desk included.</dd></div>
                <div><dt><Link className="plain" to={link("/developer")}>Wallet workflow</Link></dt><dd>Order, approve, check, execute, recover, export, verify. Your wallet, your passport.</dd></div>
                <div><dt><Link className="plain" to={link("/verify")}>Verify</Link></dt><dd>Drop a passport here: the same findings as the command line.</dd></div>
                <div><dt><Link className="plain" to={link("/inspect")}>Inspect</Link></dt><dd>The sample contracts observed at a pinned block.</dd></div>
                <div><dt><Link className="plain" to={link("/evidence")}>Evidence</Link></dt><dd>Every published file, run and sample report.</dd></div>
              </dl>
            </div>
            <div className="stack" style={{ gap: 14 }}>
              <div className="panel soft stack" style={{ gap: 12 }}>
                <h3 style={{ color: "var(--ink)" }}>Start here</h3>
                <p className="muted">The demo needs no wallet. The wallet workflow needs a wallet on {netName(net?.network)}{net?.faucet?.enabled ? `; the faucet sends ${(Number(BigInt(net.faucet.amountNativeAtomic)) / 1e18).toFixed(2)} testnet USDC per wallet and day` : ""}.</p>
                <div className="row"><Link to={link("/demo")} className="btn primary">Run the demo</Link><Link to={link("/developer")} className="btn">Try with my wallet</Link></div>
              </div>
              <p className="muted">Your wallet signs twice: one EIP-3009 authorization for the {price} fee, relayed by the service, and the payment transaction itself. The service records the hash and reads the outcome from Arc.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section-tight">
        <div className="container">
          <div className="ref-strip">
            <span className="small muted">Reference:</span>
            <Link to={link("/api")} className="btn sm">API reference</Link>
            <a href={lifecycleDownload} download="arcpreflight-lifecycle.md" className="btn sm">Lifecycle contract</a>
            <a href={requestContractsDownload} download="arcpreflight-schema.ts" className="btn sm">Request schemas</a>
            <a href={authorizationHelperDownload} download="arcpreflight-eip3009.ts" className="btn sm">EIP-3009 signing helper</a>
            <a href={walletHelperDownload} download="arcpreflight-walletExecute.ts" className="btn sm">Wallet execution helper</a>
            <a href={REPOSITORY} target="_blank" rel="noreferrer" className="btn sm">Repository</a>
          </div>
          <div className="ways-close">
            <div className="stack" style={{ gap: 4 }}><h3>Start with one complete run.</h3><p className="muted">The check, the outcome, the recovery record and the passport, together.</p></div>
            <div className="row"><Link to={link("/demo")} className="btn primary">Run the demo</Link><Link to={link("/developer")} className="btn">Try with my wallet</Link></div>
          </div>
        </div>
      </section>
    </div>
  );
}
