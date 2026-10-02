// Developer console: connect an EIP-1193 wallet, switch to Arc, buy a preflight with your own EIP-3009 signature
// (trial principals only in SUBMISSION_RESTRICTED), run the deterministic decision in the browser, see the exact plan.
// Wallet execution of the business call is off in this release (spec v1.4 §8.9) — the plan is shown, never sent.
import { useEffect, useMemo, useState } from "react";
import { encodeFunctionData, keccak256, toHex, type Hex as HexT } from "viem";
import { IntentCore, PolicyCore, intentDigest, policyDigest, ReportCore, reportDigest } from "@arcpreflight/schema";
import { checkIntentBinding, decide, DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain, type ArcNet } from "@arcpreflight/client";
import { useNet } from "../App";
import { api, explorerTx, type Report } from "../lib/api";
import { useWallet, erc20Balance, nativeBalance, signTypedDataV4 } from "../lib/wallet";
import { Chip, DecisionBadge, Hex, Spinner } from "../components/Badges";
import { ReportView } from "../components/Report";
import { usdcNative, usdcToken, decisionTone } from "../lib/format";

type Order = { orderId: HexT; tx: HexT; block: string; merchant: HexT; amountNativeAtomic: string; baselineDigest: HexT | null };
const TOKEN_KEY = "arcpreflight.trialToken";

export default function Developer() {
  const { net, testWallet } = useNet();
  const w = useWallet();
  const [token, setToken] = useState<string>(() => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } });
  const [bal, setBal] = useState<{ native: bigint; erc20: bigint } | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [unitMistake, setUnitMistake] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [report, setReport] = useState<{ report: Report; digest: string; simulation: any; serviceFeeTx: string | null } | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ } }, [token]);
  const onArc = !!net && w.chainId === net.chainId;
  useEffect(() => {
    if (!w.provider || !w.account || !onArc || !net) { setBal(null); return; }
    let alive = true;
    Promise.all([nativeBalance(w.provider, w.account), erc20Balance(w.provider, net.usdc, w.account)]).then(([native, erc20]) => alive && setBal({ native, erc20 })).catch(() => {});
    return () => { alive = false; };
  }, [w.provider, w.account, onArc, net, order, report]);

  // --- local artefacts (no API). The intent must stay byte-identical between quote and payment (the service binds
  //     clientRequestId to one intent digest), so it depends only on primitives and a per-order expiry. ---
  const chainId = net?.chainId ?? null;
  const account = w.account;
  const expiresAt = useMemo(() => new Date(Date.now() + 10 * 60_000).toISOString(), [order?.orderId, unitMistake]); // eslint-disable-line react-hooks/exhaustive-deps
  const policy = useMemo(() => (account && order ? PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "developer-console", allowedSenders: [account], allowedTargets: [order.merchant], allowedSelectors: [PAY_SELECTOR],
    maxNativePaymentAtomic: order.amountNativeAtomic, maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 5,
    requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false }) : null), [account, order]);
  const intent = useMemo(() => {
    if (!chainId || !account || !order || !policy) return null;
    const value = unitMistake ? (BigInt(order.amountNativeAtomic) / 10n ** 12n).toString() : order.amountNativeAtomic;
    return IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `dev-${order.orderId.slice(2, 10)}-${unitMistake ? "u" : "n"}`, chainId, walletMode: "EOA_DIRECT_NON_DELEGATED", from: account, operation: "CALL", to: order.merchant,
      data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [order.orderId] }), valueNativeAtomic: value,
      businessExpectation: { sourceId: `order:${order.orderId}`, sourceDigest: keccak256(toHex(`order:${order.orderId}:${account}:${order.amountNativeAtomic}`)), action: "MERCHANT_PAY", recipient: order.merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: order.amountNativeAtomic, orderId: order.orderId },
      baselineDigest: order.baselineDigest ?? ("0x" + "00".repeat(32)), policyDigest: policyDigest(policy), expiresAt });
  }, [chainId, account, order, policy, unitMistake, expiresAt]);
  const localCheck = useMemo(() => (intent ? checkIntentBinding(intent) : null), [intent]);
  const decision = useMemo(() => {
    if (!intent || !policy || !report) return null;
    const d = decide({ intent, policy, policyDigest: policyDigest(policy), baseline: null, baselineDigest: null, baselineRevoked: false, report: report.report as any, reportDigest: report.digest as HexT, now: new Date(), simulation: report.simulation });
    const checks = d.checks.filter((c) => c.id !== "BASELINE_STATUS");
    const bound = !!order?.baselineDigest && report.report.baselineDigest?.toLowerCase() === order.baselineDigest.toLowerCase();
    const decision = checks.some((c) => c.outcome === "BLOCKED") ? "BLOCKED" : checks.some((c) => c.outcome === "REVIEW_REQUIRED") || !bound ? "REVIEW_REQUIRED" : "NO_POLICY_VIOLATION";
    return { decision, checks, reasons: [...d.reasons.filter((r) => !r.startsWith("BASELINE_STATUS")), ...(bound ? [] : ["BASELINE_STATUS: report is not bound to the approved baseline"])] };
  }, [intent, policy, report, order]);

  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(null); try { await fn(); } catch (e: any) { setErr(e?.body?.reason ?? e?.body?.error ?? e?.message ?? String(e)); } finally { setBusy(null); } };
  const createOrder = () => run("order", async () => { setQuote(null); setReport(null); setPlan(null); const r = await api.createOrder(w.account!, token); setOrder(r); });
  const getQuote = () => run("quote", async () => { const r = await api.preflight(intent, token); if (r.__status !== 402) throw new Error(`expected 402, got ${r.__status}: ${JSON.stringify(r).slice(0, 200)}`); setQuote(r); });
  const buy = () => run("buy", async () => {
    if (!w.provider || !w.account || !net || !quote) return;
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
    const message = { from: w.account, to: quote.quote.payTo, value: quote.quote.amountTokenAtomic, validAfter: "0", validBefore, nonce };
    const typed = { types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...TRANSFER_WITH_AUTHORIZATION_TYPES }, primaryType: "TransferWithAuthorization", domain: usdcDomain(net.network as ArcNet), message };
    const signature = await signTypedDataV4(w.provider, w.account, typed);
    let r = await api.preflight(intent, token, { signature, authorization: message });
    let tries = 0;
    while (r.__status === 202 && tries++ < 20) { await new Promise((s) => setTimeout(s, 1500)); r = await api.request(quote.requestId, token); }
    if (r.delivery !== "DELIVERED") throw new Error(`not delivered: ${JSON.stringify(r).slice(0, 240)}`);
    const rep = ReportCore.parse(r.report);
    if (reportDigest(rep) !== r.reportDigest) throw new Error("report digest mismatch (recomputed in the browser)");
    if (rep.intentDigest !== intentDigest(intent!)) throw new Error("report bound to a different intent");
    setReport({ report: r.report, digest: r.reportDigest, simulation: r.simulation, serviceFeeTx: r.payment?.transaction ?? null });
  });
  const buildPlan = () => run("plan", async () => {
    if (!w.provider || !intent) return;
    const [gas, nonce, fee] = await Promise.all([w.provider.request({ method: "eth_estimateGas", params: [{ from: intent.from, to: intent.to, data: intent.data, value: `0x${BigInt(intent.valueNativeAtomic).toString(16)}` }] }).catch(() => null), w.provider.request({ method: "eth_getTransactionCount", params: [intent.from, "pending"] }), w.provider.request({ method: "eth_gasPrice", params: [] })]);
    const maxFee = BigInt(fee) > 20_000_000_000n ? BigInt(fee) : 21_000_000_000n;
    setPlan({ chainId: intent.chainId, from: intent.from, type: 2, to: intent.to, data: intent.data, valueNativeAtomic: intent.valueNativeAtomic, nonce: String(Number(nonce)), gasLimit: gas ? String(Number(gas)) : "estimate failed (call would revert)", maxFeePerGasNativeAtomic: maxFee.toString(), maxPriorityFeePerGasNativeAtomic: "1000000000", accessList: [], authorizationList: [] });
  });

  return (
    <section className="section">
      <div className="container stack" style={{ gap: 18 }}>
        <div><span className="kicker">Developer console</span><h2 style={{ marginTop: 6 }}>Bring your own wallet. Keep your own decision.</h2><p className="muted" style={{ marginTop: 6 }}>The service never signs for you. It observes at a pinned block and sells the report over x402; the policy and the decision run here, in your browser, from the delivered bytes.</p></div>
        {testWallet && <div className="banner">A local test wallet is injected as <code>window.ethereum</code> (automated self-test mode). Open with <code>?testwallet=off</code> to remove it and use a real wallet.</div>}
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="card stack">
            <div className="card-title"><h3>1 · Wallet</h3>{w.account ? <Chip tone="ok">connected</Chip> : <Chip>not connected</Chip>}</div>
            {!w.account ? <button className="btn primary" onClick={w.connect} disabled={w.connecting}>{w.connecting ? <Spinner /> : "Connect wallet (EIP-1193)"}</button> : (
              <div className="kv" style={{ gridTemplateColumns: "120px 1fr" }}>
                <span className="k">account</span><span><Hex value={w.account} n={8} /> {w.isTest && <Chip tone="warn">test wallet</Chip>}</span>
                <span className="k">chain</span><span>{w.chainId ?? "?"} {onArc ? <Chip tone="ok">{net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</Chip> : <button className="btn sm" onClick={() => net && w.switchChain(net)}>switch / add Arc {net?.chainId}</button>}</span>
                <span className="k">native USDC</span><span>{bal ? usdcNative(bal.native, 4) : "…"} <span className="tiny dim">(18-dec, gas)</span></span>
                <span className="k">ERC-20 USDC</span><span>{bal ? usdcToken(bal.erc20) : "…"} <span className="tiny dim">(6-dec face, same balance)</span></span>
                <span className="k"></span><span><button className="btn sm ghost" onClick={w.disconnect}>disconnect</button></span>
              </div>
            )}
            {w.error && <div className="banner bad">{w.error}</div>}
            <div className="hr" />
            <div className="card-title"><h3>2 · Trial access</h3><Chip tone="warn">SUBMISSION_RESTRICTED</Chip></div>
            <p className="small muted">External paid access is closed in this release; the project issues trial principal tokens on request. Without a token you can still connect, switch chains, and run the local checks below.</p>
            <input className="input mono" placeholder="trial principal token" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="card stack">
            <div className="card-title"><h3>3 · Order for your wallet</h3>{order && <Chip tone="ok">created</Chip>}</div>
            <p className="small muted">The merchant (deployer-admin) creates a 0.05 USDC order payable only by your address on the MAIN DemoMerchant proxy. This is the independent business expectation the intent must match.</p>
            <button className="btn" disabled={!w.account || !token || !!busy || !onArc} onClick={createOrder}>{busy === "order" ? <Spinner /> : "Create order (admin tx)"}</button>
            {order && <div className="kv" style={{ gridTemplateColumns: "110px 1fr" }}><span className="k">orderId</span><span><Hex value={order.orderId} n={8} /></span><span className="k">tx</span><span><Hex value={order.tx} n={8} link={explorerTx(net, order.tx)} /> @ #{order.block}</span><span className="k">merchant</span><span><Hex value={order.merchant} n={6} /></span><span className="k">baseline</span><span>{order.baselineDigest ? <Hex value={order.baselineDigest} n={6} /> : <Chip tone="warn">none</Chip>}</span></div>}
            <div className="hr" />
            <div className="card-title"><h3>4 · Exact intent + local checks</h3>{localCheck && <Chip tone={decisionTone(localCheck.outcome)}>{localCheck.id}: {localCheck.outcome}</Chip>}</div>
            <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={unitMistake} onChange={(e) => { setUnitMistake(e.target.checked); setQuote(null); setReport(null); setPlan(null); }} /> encode the value in 6-decimal units (the classic Arc mistake)</label>
            {intent && <><div className="tiny dim">intentDigest <Hex value={intentDigest(intent)} n={8} /> · value {intent.valueNativeAtomic} atomic ({usdcNative(intent.valueNativeAtomic, 6)})</div>{localCheck && localCheck.reasons.length > 0 && <ul className="list">{localCheck.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}<details><summary>intent JSON</summary><pre className="json">{JSON.stringify(intent, null, 2)}</pre></details></>}
          </div>
        </div>

        <div className="card stack">
          <div className="card-title"><h3>5 · Buy the pinned report with your signature (x402 · EIP-3009)</h3>{report && <Chip tone="ok">delivered</Chip>}</div>
          <div className="row">
            <button className="btn" disabled={!intent || !token || !!busy} onClick={getQuote}>{busy === "quote" ? <Spinner /> : "Get quote (HTTP 402)"}</button>
            <button className="btn primary" disabled={!quote || !!busy || !onArc} onClick={buy}>{busy === "buy" ? <><Spinner /> settling…</> : "Sign TransferWithAuthorization & buy"}</button>
          </div>
          {quote && <div className="small muted">quote {usdcToken(quote.quote.amountTokenAtomic)} → payTo <Hex value={quote.quote.payTo} n={5} /> · report pinned at #{quote.pinnedBlock} · expires {quote.quote.expiresAt} · requestId <code>{quote.requestId}</code></div>}
          {report && (<>
            <div className="small muted">service fee settled by the Circle Facilitator: {report.serviceFeeTx ? <Hex value={report.serviceFeeTx} link={explorerTx(net, report.serviceFeeTx)} /> : "—"} · digest recomputed in the browser and bound to your intent ✓</div>
            <ReportView report={report.report} digest={report.digest} net={net} compact />
          </>)}
        </div>

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="card stack">
            <div className="card-title"><h3>6 · Decision (in your browser)</h3>{decision && <DecisionBadge decision={decision.decision} size="sm" />}</div>
            {!decision ? <div className="dim small">buy a report first</div> : (<>
              <table className="t"><tbody>{decision.checks.map((c) => <tr key={c.id}><td className="mono">{c.id}</td><td><Chip tone={decisionTone(c.outcome)}>{c.outcome}</Chip></td></tr>)}</tbody></table>
              {decision.reasons.length > 0 && <ul className="list">{decision.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
              <div className="tiny dim">Deterministic policy from <code>@arcpreflight/policy</code>: hard violations block; unapproved change or unknowns require review; otherwise "no configured check fired".</div>
            </>)}
          </div>
          <div className="card stack">
            <div className="card-title"><h3>7 · Transaction plan</h3><Chip tone="warn">not executed · wallet execution off</Chip></div>
            <p className="small muted">What an agent would sign after final validation: type-2, exact calldata, exact value, fee floor 20 gwei. In this release the plan is displayed only (spec §8.9); the live demo executes it with the project's own runner.</p>
            <button className="btn" disabled={!intent || !onArc || !!busy} onClick={buildPlan}>{busy === "plan" ? <Spinner /> : "Build plan (estimate gas via wallet RPC)"}</button>
            {plan && <pre className="json">{JSON.stringify(plan, null, 2)}</pre>}
          </div>
        </div>
        {err && <div className="banner bad">{err}</div>}

        <div className="card stack">
          <h3>Integrate</h3>
          <pre className="json">{`# 1. quote (free, report prepared & pinned)
curl -s -X POST ${location.origin}/v1/preflight -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' -d '{"intent": …}'   # → 402 {quote, pinnedBlock, paymentRequirements}
# 2. sign EIP-3009 TransferWithAuthorization(from=you, to=quote.payTo, value=quote.amountTokenAtomic) with USDC domain {name:"USDC",version:"2",chainId:${net?.chainId ?? 5042},verifyingContract:"0x3600…0000"}
# 3. pay → report (or 202 + GET /v1/requests/{id} until settled)
curl -s -X POST ${location.origin}/v1/preflight -H 'authorization: Bearer $TOKEN' -d '{"intent": …, "payment": {"signature": "0x…", "authorization": {…}}}'
# 4. decide locally: import { decide } from "@arcpreflight/policy"`}</pre>
        </div>
      </div>
    </section>
  );
}
