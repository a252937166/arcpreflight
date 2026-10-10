import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { Chip } from "../components/Badges";
import { apiPath } from "../lib/api";
import { usdcToken } from "../lib/format";
import lifecycleContract from "../../../../docs/LIFECYCLE.md?raw";
import lifecycleDownload from "../../../../docs/LIFECYCLE.md?url";
import requestContractsDownload from "../../../../packages/schema/src/types.ts?url";
import authorizationHelperDownload from "../../../../packages/client/src/eip3009.ts?url";

const REPOSITORY = "https://github.com/a252937166/arcpreflight";

function CodeSnippet({ label, code }: { label: string; code: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyState("copied"); }
    catch { setCopyState("unavailable"); }
  };
  return (
    <div className="integration-code stack" style={{ gap: 8 }}>
      <div className="integration-code-header row between">
        <span className="tiny muted">{label}</span>
        <button type="button" className="btn sm ghost" onClick={() => void copy()} aria-label={`Copy ${label}`}>Copy</button>
      </div>
      <pre className="json selectable"><code>{code}</code></pre>
      <span className="tiny muted" role="status" aria-live="polite" hidden={copyState === "idle"}>{copyState === "copied" ? "Copied." : "Copy is unavailable. Select the code to copy it."}</span>
    </div>
  );
}

function FlowStep({ n, title, endpoints, children }: { n: number; title: string; endpoints: string[]; children: ReactNode }) {
  return (
    <li className="integration-step">
      <span className="integration-number mono" aria-hidden="true">{String(n).padStart(2, "0")}</span>
      <div className="stack" style={{ gap: 8 }}>
        <h3>{title}</h3>
        <div className="integration-endpoints stack" style={{ gap: 3 }}>{endpoints.map((endpoint) => <code key={endpoint}>{endpoint}</code>)}</div>
        {children}
      </div>
    </li>
  );
}

export default function Integrate() {
  const { net, base, link = (to: string) => to } = useNet();
  const origin = window.location.origin;
  const network = net?.network === "mainnet" ? "Arc mainnet" : net?.network === "testnet" ? "Arc testnet" : "Selected Arc instance";
  const rpc = net?.rpc ?? (net?.network === "mainnet" ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
  const networkCommand = `curl --fail-with-body --silent --show-error \\\n  "${origin}${apiPath("/v1/network")}"`;
  const sessionCommand = `curl --fail-with-body --silent --show-error \\\n  -X POST "${origin}${apiPath("/v1/session")}"`;
  const runnerCommand = `ARC_NET=testnet API_URL=http://127.0.0.1:4040 RUNNER_TOKEN=… BASELINE_DIGEST_MAIN=0x… \\\n  pnpm exec tsx examples/merchant-agent/src/run.ts run APPROVED_PAYMENT
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts reconcile
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts list`;
  const verifyCommand = `pnpm exec tsx packages/verifier/src/cli.ts passport.json \\\n  --rpc ${rpc} --anchors anchors.json`;

  const walletMapping = `const hex = (value) => "0x" + BigInt(value).toString(16);
const tx = {
  from: plan.from, to: plan.to, data: plan.data,
  value: hex(plan.valueNativeAtomic), gas: hex(plan.gasLimit),
  maxFeePerGas: hex(plan.maxFeePerGasNativeAtomic),
  maxPriorityFeePerGas: hex(plan.maxPriorityFeePerGasNativeAtomic),
  type: "0x2", chainId: hex(plan.chainId),
};
// After the exclusive claim and fresh account, chain and expiry checks:
const txHash = await wallet.request({
  method: "eth_sendTransaction", params: [tx],
});`;
  return (
    <section className="section integrate-page">
      <div className="container stack" style={{ gap: 40 }}>
        <header className="integrate-intro stack" style={{ gap: 16 }}>
          <p className="kicker">Developer guide · {network}</p>
          <h1>Use the API.<br /><em>Keep control of the payment.</em></h1>
          <p className="lead">ArcPreflight is an HTTP API for checking, recording and recovering supported USDC payments on Arc. Your app or agent calls the service; your wallet signs the payment.</p>
          <div className="row">
            <a href={apiPath("/openapi.json")} className="btn primary" target="_blank" rel="noreferrer">Open API reference ↗</a>
            <Link to={link("/developer")} className="btn">Try with my wallet</Link>
            <Link to={link("/demo")} className="btn ghost">Run demo · no wallet</Link>
          </div>
        </header>

        <section aria-labelledby="integration-methods-title" className="stack" style={{ gap: 14 }}>
          <h2 id="integration-methods-title">Choose your way in.</h2>
          <div className="integration-methods">
            <article className="stack integration-method" style={{ gap: 12 }}>
              <div className="row between"><h3>HTTP API</h3><Chip tone="info">Main interface</Chip></div>
              <p className="small muted">For your application or agent. Request a check, validate a payment plan, recover an attempt and export its proof over <code>/v1</code>.</p>
              <a href="#http-api" className="small">Start with an API call →</a>
            </article>
            <article className="stack integration-method" style={{ gap: 12 }}>
              <div className="row between"><h3>Web workbench</h3><Chip tone="neutral">Hands-on</Chip></div>
              <p className="small muted">Try the same lifecycle step by step. The Demo uses project funds; the wallet workbench uses your wallet and testnet USDC.</p>
              <Link to={link("/developer")} className="small">Open the wallet workbench →</Link>
            </article>
            <article className="stack integration-method" style={{ gap: 12 }}>
              <div className="row between"><h3>Repository CLI</h3><Chip tone="warn">Source publication pending</Chip></div>
              <p className="small muted">A persistent TypeScript runner and passport verifier exist in the current project checkout. This release's source has not reached the public repository; the packages are not published to npm.</p>
              <a href="#cli" className="small">See the CLI commands →</a>
            </article>
          </div>
          <p className="small muted"><b style={{ color: "var(--ink)" }}>MCP:</b> no MCP server or install endpoint is available in this release. Agents integrate through the HTTP API.</p>
        </section>

        <section id="http-api" tabIndex={-1} aria-labelledby="http-api-title" className="stack" style={{ gap: 20 }}>
          <div className="row between">
            <div className="stack" style={{ gap: 6 }}>
              <p className="kicker">HTTP API · first request</p>
              <h2 id="http-api-title">Read the instance before you start.</h2>
            </div>
            <a href={apiPath("/openapi.json")} target="_blank" rel="noreferrer" className="small">Live endpoint reference ↗</a>
          </div>
          <div className="two" style={{ gap: 28 }}>
            <div className="stack" style={{ gap: 14 }}>
              <p className="small muted">No wallet or token is needed for this read. It returns the chain, supported targets, check price and execution availability.</p>
              <CodeSnippet label="Read network configuration" code={networkCommand} />
              <p className="tiny muted">API base <code style={{ overflowWrap: "anywhere" }}>{origin}{base}</code> · {net?.caip2 ?? "chain loading"}. The network selector updates these links and examples.</p>
              <details className="why">
                <summary className="small">Create a session for your own orders and checks</summary>
                <div className="stack" style={{ gap: 12, marginTop: 12 }}>
                  <CodeSnippet label="Create an anonymous session" code={sessionCommand} />
                  <p className="small muted">Save the returned token privately and send <code>Authorization: Bearer &lt;token&gt;</code> with owned requests. Keep the token and workflow IDs bound to this API instance.</p>
                </div>
              </details>
            </div>
            <aside className="panel soft stack" style={{ gap: 14 }} aria-label="Payment responsibilities">
              <h3>Two signatures, two purposes</h3>
              <p className="small muted"><b style={{ color: "var(--ink)" }}>Check fee.</b> Your wallet signs an EIP-3009 fee authorization. The service relays that authorization and delivers the report after settlement{net ? ` (${usdcToken(net.priceTokenAtomic)} for a check)` : ""}.</p>
              <p className="small muted"><b style={{ color: "var(--ink)" }}>Order payment.</b> Your wallet sends the validated business transaction and pays its gas. The API records the returned hash and reads the outcome from Arc.</p>
              <p className="small muted">The complete payment path currently supports the project's DemoMerchant template. Check <code>access.publicExecution</code> and <code>access.walletExecution</code> before starting; mainnet execution remains behind its acceptance gate.</p>
            </aside>
          </div>
        </section>

        <section aria-labelledby="integration-contracts-title" className="integration-contract-links stack" style={{ gap: 12 }}>
          <h2 id="integration-contracts-title">Current request contracts</h2>
          <p className="small muted">The endpoint reference lists routes. Download the lifecycle contract, intent and policy schemas, and EIP-3009 signing reference from this version of the site.</p>
          <div className="row">
            <a href={lifecycleDownload} download="arcpreflight-lifecycle.md" className="btn sm">Download lifecycle contract</a>
            <a href={requestContractsDownload} download="arcpreflight-schema.ts" className="btn sm">Download request schemas</a>
            <a href={authorizationHelperDownload} download="arcpreflight-eip3009.ts" className="btn sm">Download signing reference</a>
          </div>
          <details><summary>Read the lifecycle contract and review amendments</summary><pre className="json integration-contract-text">{lifecycleContract}</pre></details>
        </section>

        <section aria-labelledby="integration-flow-title" className="stack" style={{ gap: 20 }}>
          <div className="stack" style={{ gap: 8 }}>
            <p className="kicker">Your app + the service + your wallet</p>
            <h2 id="integration-flow-title">The wallet lifecycle over HTTP.</h2>
            <p className="small muted" style={{ maxWidth: 800 }}>Start in the <Link to={link("/developer")}>wallet workbench</Link> to see the records. Use the downloadable contracts above for request bodies and the OpenAPI reference for endpoints. Capture one API client before asking for a signature, and retain it for retries and recovery.</p>
          </div>
          <ol className="integration-flow" aria-label="Wallet payment integration steps">
            <FlowStep n={1} title="Create the order and retain its approval" endpoints={["POST /v1/session", "POST /v1/demo/orders"]}>
              <p className="small muted">Use the session token to create a supported order for your payer. Retain the order ID; review the merchant baseline and your policy, and keep their approved digests separately. Wait for confirmed creation before continuing.</p>
            </FlowStep>
            <FlowStep n={2} title="Quote, sign the check fee, receive the report" endpoints={["POST /v1/preflight", "GET /v1/requests/{requestId}"]}>
              <p className="small muted">Send the exact intent for a <code>402</code> quote. Your wallet signs the quoted EIP-3009 authorization; send the same intent with that payment to the API. Retain the request ID and observe it while settlement returns <code>202</code>.</p>
            </FlowStep>
            <FlowStep n={3} title="Decide locally, then validate an attempt" endpoints={["POST /v1/wallet/attempts"]}>
              <p className="small muted">Apply your policy to the report. Stop on <code>BLOCKED</code> or <code>REVIEW_REQUIRED</code>. Submit <code>{"{ requestId, orderId, policy }"}</code> for fresh validation; retain the returned attempt ID, exact plan and expiry before opening the wallet.</p>
            </FlowStep>
            <FlowStep n={4} title="Claim the prompt, recheck, then ask the wallet" endpoints={["POST /v1/wallet/attempts/{id}/prompt", "wallet: eth_sendTransaction(mapped transaction)"]}>
              <p className="small muted">Generate <code>claimId = crypto.randomUUID()</code> for this operation and keep it in the operation's memory. Send <code>{'{ event: "prompted", claimId }'}</code> and require the exclusive claim. A <code>409 PROMPT_CLAIMED</code> means recover the attempt instead of prompting again.</p>
              <p className="small muted">Immediately before the wallet send, recheck its account against <code>plan.from</code> and the attempt payer, its chain against <code>plan.chainId</code>, and more than five seconds of validity. If a recheck fails before the prompt, return the untouched claim with <code>{'{ event: "not-prompted", claimId }'}</code>.</p>
              <details><summary>Map the validated plan to the wallet request</summary><CodeSnippet label="Wallet transaction mapping" code={walletMapping} /></details>
            </FlowStep>
            <FlowStep n={5} title="Report the hash and recover the original attempt" endpoints={["POST /v1/wallet/attempts/{id}/sent", "GET /v1/wallet/attempts/{id}", "POST /v1/wallet/attempts/{id}/recover"]}>
              <p className="small muted">Report <code>{"{ txHash }"}</code> as soon as the wallet returns it, then observe. For an ambiguous wallet answer, mark <code>{'{ event: "unknown-submission" }'}</code> on <code>/prompt</code> and recover this same attempt from its hash and order state. Keep an uncertain submission pending; use <code>/abandon</code> only for a known rejected or unsubmitted prompt.</p>
            </FlowStep>
            <FlowStep n={6} title="Export the proof and verify it elsewhere" endpoints={["GET /v1/wallet/attempts/{id}/passport"]}>
              <p className="small muted">Download the session-owned Payment Passport when available. Verify its receipts and approval with an Arc RPC and the baseline and policy digests you retained through a trusted channel.</p>
            </FlowStep>
          </ol>
        </section>

        <section id="cli" tabIndex={-1} aria-labelledby="repository-cli-title" className="stack" style={{ gap: 20 }}>
          <div className="row between">
            <div className="stack" style={{ gap: 6 }}><p className="kicker">Repository tools</p><h2 id="repository-cli-title">Run it in your own process.</h2></div>
            <a href={REPOSITORY} target="_blank" rel="noreferrer" className="small">Public repository · earlier release ↗</a>
          </div>
          <div className="two" style={{ gap: 28 }}>
            <div className="stack" style={{ gap: 12 }}>
              <h3>Reference merchant agent</h3>
              <p className="small muted">These commands need the current project checkout. Follow its README to set up your own testnet API, fixtures, runner key and order-creator key, then replace the token and baseline placeholders. Running a fixture spends that runner's testnet funds.</p>
              <CodeSnippet label="Configured testnet runner examples" code={runnerCommand} />
              <p className="tiny muted">Source: <code>examples/merchant-agent/src/run.ts</code>. Its <code>passport</code> command exports stored runs; <code>--crash-after-broadcast</code> rehearses recovery on your own testnet fixtures.</p>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <h3>Independent passport verifier</h3>
              <p className="small muted">From the current checkout with dependencies installed, supply the downloaded passport, an RPC and your own <code>anchors.json</code>. Verification needs no API token or signing key. Use the browser verifier while source publication is pending.</p>
              <CodeSnippet label="Verify a downloaded passport" code={verifyCommand} />
              <p className="small muted"><code>anchors.json</code> contains <code>baselineDigests</code> and <code>policyDigests</code> arrays. Digests copied from the same site check consistency; independent approval requires anchors you already trust.</p>
              <Link to={link("/verify")} className="small">See the verification guide →</Link>
            </div>
          </div>
          <p className="tiny muted">Node 22.6+ and pnpm · <code>@arcpreflight/client</code>, <code>@arcpreflight/policy</code> and the other TypeScript packages are repository workspace libraries.</p>
        </section>

        <div className="panel soft integration-footer row between">
          <div className="stack" style={{ gap: 4 }}><h3>Start with one complete run.</h3><p className="small muted">See the check, payment outcome, recovery record and exported passport together.</p></div>
          <div className="row"><Link to={link("/demo")} className="btn primary">Run demo · no wallet</Link><Link to={link("/developer")} className="btn">Try with my wallet</Link></div>
        </div>
      </div>
    </section>
  );
}
