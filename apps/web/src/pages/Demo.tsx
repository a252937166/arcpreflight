// Live Demo (docs/LIFECYCLE.md §4, §9): two explicit entry points — WATCH a project-funded demo (the project's own runner pays the check fee,
// the order and the gas from project funds; a connected wallet changes nothing about who pays) and TRY WITH MY WALLET (the Developer
// workflow, where the visitor pays fee + order + gas from their own wallet on Arc testnet, with the faucet). The "check with your wallet"
// quick comparison lives under the second entry: the check fee is the visitor's, nothing is executed here.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useNet } from "../App";
import { api, type Fixture, type FixtureInfo, type Run, type RunSummary } from "../lib/api";
import { startDemo, type DemoOptions } from "../lib/demo";
import { describeBody, describeError, type Described } from "../lib/errors";
import { useWallet } from "../lib/wallet";
import { useWalletRun } from "../lib/walletRun";
import { requiredNativeAtomic, useBalances } from "../lib/faucet";
import { idleLifecycle } from "../lib/outcome";
import { demoOrderUsdcText, feeUsdcText } from "../lib/orders";
import { Chip, DecisionBadge, Hex, Spinner } from "../components/Badges";
import { RunPanel } from "../components/RunPanel";
import { WalletRunPanel } from "../components/WalletRunPanel";
import { FaucetCard } from "../components/FaucetCard";
import { RunsTable } from "../components/RunsTable";
import { Lifecycle } from "../components/Lifecycle";
import { STAGES } from "../components/Pipeline";
import { HandRule } from "../components/Illustrations";

const PAGE = 12;
/** a run that is RUNNING is polled fast; one left RECONCILE_REQUIRED (the labelled interruption) is observed every 2 s until it resolves, for at most 10 minutes */
const POLL_MS = { RUNNING: 1500, RECONCILE_REQUIRED: 2000 } as const;
const RECONCILE_WATCH_MS = 10 * 60_000;
/** the order the situations are shown in: the approved payment first (default), then the blocked unit mistake, then the unapproved upgrade */
export const SCENARIO_ORDER: Fixture[] = ["APPROVED_PAYMENT", "AMOUNT_UNIT_MISMATCH", "CHANGED_IMPLEMENTATION"];
export const DEFAULT_SCENARIO: Fixture = "APPROVED_PAYMENT";
export const orderedFixtures = (list: FixtureInfo[] | undefined): FixtureInfo[] => [...(list ?? [])].sort((a, b) => (SCENARIO_ORDER.indexOf(a.id) === -1 ? 99 : SCENARIO_ORDER.indexOf(a.id)) - (SCENARIO_ORDER.indexOf(b.id) === -1 ? 99 : SCENARIO_ORDER.indexOf(b.id)));
export const WATCH_LABEL = "Watch a project-funded demo", TRY_LABEL = "Try with my wallet";

export default function Demo() {
  const { net, refresh, select, instances = [], link = (to: string) => to } = useNet();
  const w = useWallet();
  const [params, setParams] = useSearchParams();
  const initial = (params.get("fixture") as Fixture | null) ?? DEFAULT_SCENARIO;
  const [fixture, setFixture] = useState<Fixture>(initial);
  const [run, setRun] = useState<Run | null>(null);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string; raw?: Described | null } | null>(null);
  const [history, setHistory] = useState<{ runs: RunSummary[]; total?: number; more: boolean }>({ runs: [], total: undefined, more: false });
  const [scrollKey, setScrollKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // wallet check (P3/v3.3): runs under this browser's anonymous session; it stops at the decision and hands over to the Developer workflow
  const walletRun = useWalletRun(net, w);
  const onArc = !!net && !!w.account && w.chainId === net.chainId;
  const walletBusy = walletRun.run.phase === "running";
  const { native: bal, refresh: refreshBal } = useBalances(w.provider, w.account, onArc);
  // the quick check costs the wallet the check fee only (one EIP-3009 signature; no gas, no order amount)
  const feeRequired = requiredNativeAtomic({ feeTokenAtomic: net?.priceTokenAtomic ?? null, amountNativeAtomic: 0n, plan: null }) - requiredNativeAtomic({ feeTokenAtomic: null, amountNativeAtomic: 0n, plan: null });
  const unfunded = bal !== null && bal < feeRequired;
  const gated = !!net && net.access?.publicExecution === false;

  const fixtures = orderedFixtures(net?.fixtures);
  // the default situation is the approved payment; an instance that does not list it falls back to the first one it does list
  const effective: Fixture = fixtures.some((x) => x.id === fixture) ? fixture : (fixtures[0]?.id ?? fixture);
  const f = fixtures.find((x) => x.id === effective);
  const mainnet = net?.network === "mainnet";
  const netLabel = mainnet ? "Arc mainnet" : "Arc testnet";
  const feeText = feeUsdcText(net);
  const orderText = demoOrderUsdcText(net);

  const loadRuns = useCallback(() => api.runs(PAGE, 0).then((r) => setHistory({ runs: r.runs ?? [], total: r.total ?? (r.runs ?? []).length, more: false })).catch(() => {}), []);
  const loadMore = useCallback(() => {
    setHistory((h) => ({ ...h, more: true }));
    api.runs(PAGE, history.runs.length).then((r) => setHistory((h) => ({ runs: [...h.runs, ...(r.runs ?? []).filter((x) => !h.runs.some((y) => y.runId === x.runId))], total: r.total ?? h.total, more: false }))).catch(() => setHistory((h) => ({ ...h, more: false })));
  }, [history.runs.length]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (scrollKey) panelRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }, [scrollKey]);
  const poll = useCallback((id: string) => {
    if (timer.current) clearTimeout(timer.current);
    const started = Date.now();
    const tick = async () => {
      let next: number | null = POLL_MS.RUNNING;
      try {
        const r = await api.run(id); setRun(r);
        if (r.state === "RUNNING") next = POLL_MS.RUNNING;
        else if (r.state === "RECONCILE_REQUIRED" && Date.now() - started < RECONCILE_WATCH_MS) { next = POLL_MS.RECONCILE_REQUIRED; setBusy(false); }
        else { next = null; setBusy(false); loadRuns(); refresh(); }
      } catch { /* keep polling */ }
      if (next !== null) timer.current = setTimeout(tick, next); else timer.current = null;
    };
    void tick();
  }, [loadRuns, refresh]);
  const start = async (opts: DemoOptions = {}) => {
    setBusy(true); setNotice(null); setSample(false); setRun(null); walletRun.reset();
    try {
      const r = await startDemo(effective, undefined, opts);
      if (r.mode === "live") {
        setNotice(r.admission === "existing"
          ? { tone: "warn", text: "This admission key was already accepted: showing the original run — no second order was created." }
          : { tone: "info", text: opts.interruptAfterBroadcast ? `Started with a labelled interruption: the runner will stop waiting right after the broadcast; the recovery worker (every 30 s) resolves the outcome from the recorded hash and the order state.` : `Started. The project's own runner is doing this on ${net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"} right now, from project funds.` });
        poll(r.runId); return;
      }
      setBusy(false);
      const why = describeBody(r.body);
      setNotice({ tone: "warn", text: `${why.text} Showing the latest recorded run — labelled RECORDED_SAMPLE.`, raw: why }); setSample(true); setRun(r.run);
    } catch (e: any) { setBusy(false); const d = describeError(e); setNotice({ tone: "bad", text: d.text, raw: d }); }
  };
  const startWallet = async () => {
    if (!f) return;
    setNotice({ tone: "info", text: `Checking with your wallet on ${net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}: it signs the ${feeText} USDC check fee only — that fee is yours. A NO_POLICY_VIOLATION check continues in the Developer workflow, where your wallet executes the validated plan.` });
    setSample(false); setRun(null);
    await walletRun.start(f);
    refreshBal(); loadRuns();
  };
  const open = async (id: string) => { setSample(false); setNotice(null); walletRun.reset(); try { const r = await api.run(id); setRun(r); if (r.state === "RUNNING" || r.state === "RECONCILE_REQUIRED") { setBusy(r.state === "RUNNING"); poll(id); } } catch { /* ignore */ } };

  const headline = (f?.headline ?? "…").replace(/_/g, " ").toLowerCase();
  const walletShowing = walletRun.run.phase !== "idle";
  const showing = !!run || walletShowing;
  useEffect(() => { if (showing) setScrollKey((k) => k + 1); }, [showing]); // scroll once the panel exists, not before
  const running = run?.state === "RUNNING" || walletBusy;
  const liveSteps = walletShowing ? walletRun.run.steps : run?.steps ?? [];
  const seen = new Set(liveSteps.map((s) => s.step));
  const reached = STAGES.filter((st) => st.steps.some((x) => seen.has(x))).length;
  const pick = (id: Fixture) => { setFixture(id); setParams((p) => { p.set("fixture", id); return p; }); };
  const canRun = !busy && !walletBusy && !!net && !!f?.merchant && !gated;
  const runner = net?.accounts.demoRunner ?? null;
  return (
    <section className="section demo">
      <div className="container stack" style={{ gap: 28 }}>
        {running && (
          <div className="runstrip" role="status" aria-live="polite">
            <Spinner /><span className="small">{`running · ${f?.title ?? effective} · ${walletShowing ? "your wallet" : "project runner"} · step ${Math.max(1, reached)}/${STAGES.length}`}</span>
            <button className="btn sm" onClick={() => setScrollKey((k) => k + 1)}>view</button>
          </div>
        )}
        <div className="cols" style={{ alignItems: "end" }}>
          <div><div className="kicker">Live demo · {netLabel}</div><h2 style={{ marginTop: 8 }}>Pick a situation. <em>Watch the payment handled, on-chain.</em></h2></div>
          {net && <p className="ticker" style={{ justifyContent: "flex-end" }}><span>live runs today <b>{net.budget.usedToday}/{net.budget.maxRunsPerDay}</b></span><span>cooldown <b>{net.budget.clientCooldownSeconds}s</b></span><span>business payment <b>{orderText} USDC</b></span>{(net.budget.unresolvedBusinessTransactions ?? 0) > 0 && <span><b>{net.budget.unresolvedBusinessTransactions} unresolved business tx</b></span>}{net.budget.activeRun && <span><b>a run is in progress</b></span>}</p>}
        </div>

        {/* two explicit entry points (docs/LIFECYCLE.md §9): who pays is decided here, never by a connected wallet */}
        <div className="entry-points" role="group" aria-label="two ways to use the demo" data-testid="entry-points">
          <section className="entry on" aria-labelledby="entry-watch">
            <div className="kicker" id="entry-watch">{WATCH_LABEL}</div>
            <p className="small muted">The project's own runner {runner ? <Hex value={runner} n={4} /> : <code>…</code>} pays everything from <b>project funds</b>: the {feeText} USDC check fee, the {orderText} USDC order and the gas. Your wallet is not involved — connected or not, it never pays here. Pick a situation below and press Run; one admission key per click, so a retry returns the same run, never a second order.</p>
            <div className="row"><a href="#situations" className="btn primary sm">{WATCH_LABEL} ↓</a><span className="tiny dim">no wallet needed</span></div>
          </section>
          <section className="entry" aria-labelledby="entry-try" data-testid="entry-try">
            <div className="kicker" id="entry-try">{TRY_LABEL}</div>
            <p className="small muted">The <Link to={link("/developer")}>Developer workflow</Link> runs the same seven steps with <b>your</b> wallet on {netLabel}: you pay the check fee ({feeText} USDC), the order amount and the gas of your own payment from your own wallet{mainnet ? "" : " — the testnet faucet gives you testnet USDC"}; the service validates the exact plan and records the attempt before your wallet is asked; the passport is yours.</p>
            <div className="row" style={{ gap: 10 }}><Link to={link("/developer")} className="btn sm">{TRY_LABEL} →</Link></div>
            {w.account ? (onArc
              ? <div className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 10 }}><button className="btn sm" disabled={walletBusy || busy || !net || !f?.merchant || unfunded} title={unfunded ? `this wallet cannot pay the ${feeText} USDC check fee yet — claim testnet USDC below` : `your wallet signs the ${feeText} USDC check fee (yours); a NO_POLICY_VIOLATION check continues in the Developer workflow, where your wallet executes`} onClick={startWallet}>{walletBusy ? <><Spinner /> checking…</> : `▶ Check "${headline}" with your wallet`}</button></div>
                  <span className="tiny dim">a quicker look from here: your wallet signs the {feeText} USDC check fee — that fee is yours — on the situation picked below; nothing is executed on this page, execution continues in the Developer workflow with your wallet</span>
                  <FaucetCard net={net} wallet={w} balance={bal} required={feeRequired} step="the check fee" onClaimed={refreshBal} />
                </div>
              : <div className="row" style={{ gap: 10 }}><button className="btn sm" onClick={() => net && w.switchChain(net)} title={`your wallet is on chain ${w.chainId ?? "?"}; the demo runs on ${netLabel}`}>{`Switch to ${netLabel} first`}</button><span className="tiny dim">your connected wallet is on another chain</span></div>)
              : <span className="tiny dim">or connect a wallet in the header to run only the check from here with your own fee signature</span>}
          </section>
        </div>

        {!showing && <Lifecycle stages={idleLifecycle()} caption="every run walks this lifecycle: the order, the approval it references, the paid check, the decision, execution, recovery if interrupted, the passport, and verification you can run anywhere" />}
        {net && !net.fixtures.some((x) => x.merchant) && (
          <div className="banner" role="status">No fixtures are deployed on {netLabel} yet — live runs cannot start on this instance.
            {instances.some((i) => i.network === "testnet") && net.network !== "testnet" && <> <button className="btn sm" onClick={() => select("testnet")}>switch to Arc testnet</button> to run zero-cost demos.</>}
          </div>
        )}
        {net && net.fixtures.some((x) => x.merchant) && gated && (
          <div className="banner info" role="status">Execution is gated on this instance — it opens after the mainnet acceptance is recorded. Recorded runs, checks, orders and passports stay available.
            {instances.some((i) => i.network === "testnet") && net.network !== "testnet" && <> <button className="btn sm" onClick={() => select("testnet")}>use the testnet instance</button></>}
          </div>
        )}

        <div id="situations" className="stack" style={{ gap: 10 }}>
          <div className="row between"><div className="kicker">{WATCH_LABEL} · pick a situation</div>{showing && <span className="tiny dim">project runner · project funds</span>}</div>
          {showing ? (
            <div className="pick-row" role="tablist" aria-label="situation">
              {fixtures.map((x) => <button key={x.id} type="button" role="tab" aria-selected={effective === x.id} className={`pick-chip ${effective === x.id ? "on" : ""}`} onClick={() => pick(x.id)}>{effective === x.id && <span className="hand">☞</span>}<span className="serif">{x.title}</span><DecisionBadge decision={x.headline} size="sm" /></button>)}
            </div>
          ) : (
            <div className="three" style={{ gap: 14 }} role="group" aria-label="situation">
              {fixtures.map((x) => (
                <button key={x.id} type="button" className={`pick ${effective === x.id ? "on" : ""}`} aria-pressed={effective === x.id} data-fixture={x.id} onClick={() => pick(x.id)}>
                  <span className="row between" style={{ alignItems: "baseline" }}><span className="pick-title serif">{effective === x.id ? <span className="hand" style={{ marginRight: 8 }}>☞</span> : null}{x.title}</span><DecisionBadge decision={x.headline} size="sm" /></span>
                  <span className="small muted">{x.blurb}</span>
                  <span className="tiny dim row" style={{ gap: 6 }}>{x.merchant && <Hex value={x.merchant} n={4} />}{x.baselineDigest ? <Chip tone="ok">baseline approved</Chip> : <Chip tone="warn">no baseline</Chip>}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <div className="row between runbar" style={{ alignItems: "center" }}>
            {!showing && <p className="muted small" style={{ maxWidth: 640 }}>The runner <code>{runner ? `${runner.slice(0, 10)}…` : "…"}</code> buys the report ({feeText} USDC, one EIP-3009 authorization settled by the project's relayer), decides locally, and signs the business call only when nothing fired — all from project funds.</p>}
            <div className="row runbar-actions" style={{ gap: 10 }}>
              <button className="btn primary" disabled={!canRun} title={gated ? "gated on this instance — execution opens after the mainnet acceptance; use the testnet instance" : "the project runner pays from project funds"} onClick={() => start()}>{busy ? <><Spinner /> running…</> : f?.id === "APPROVED_PAYMENT" ? "▶ Run live · project runner" : `▶ Run "${headline}" live · project runner`}</button>
              {f?.id === "APPROVED_PAYMENT" && <button className="btn" disabled={!canRun} title={gated ? "gated on this instance — execution opens after the mainnet acceptance; use the testnet instance" : "the runner persists, marks and sends as always, then stops waiting right after the send; the recovery worker resolves the outcome from the recorded hash and the order state"} onClick={() => start({ interruptAfterBroadcast: true })}>▶ Run with a simulated interruption</button>}
            </div>
          </div>
        </div>
        {notice && <div className={`banner ${notice.tone === "info" ? "info" : notice.tone === "bad" ? "bad" : ""}`}>{notice.text}{notice.raw?.code && <details className="error-raw"><summary>raw response ({notice.raw.code})</summary><pre className="json">{JSON.stringify(notice.raw.raw, null, 2)}</pre></details>}</div>}
        <div ref={panelRef} className="scroll-target stack" style={{ gap: 28 }}>
          {run && <><HandRule /><RunPanel run={run} net={net} sample={sample} onUpdate={setRun} /></>}
          {!run && walletShowing && <><HandRule /><WalletRunPanel run={walletRun.run} net={net} account={w.account} fixture={f ?? null} /></>}
        </div>

        <HandRule />
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between"><h3>Recent runs</h3><span className="tiny dim">every run is persisted with its receipts; open one for the permanent link, download its Payment Passport from the row</span></div>
          <RunsTable runs={history.runs} net={net} total={history.total} onMore={loadMore} loadingMore={history.more} onView={open} />
        </div>
      </div>
    </section>
  );
}
