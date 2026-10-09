// Live Demo (docs/LIFECYCLE.md §4, §9): two explicit entry points — WATCH a project-funded demo (the project's own runner pays the check fee,
// the order and the gas from project funds; a connected wallet changes nothing about who pays) and TRY WITH MY WALLET (the Developer
// workflow, where the visitor pays fee + order + gas from their own wallet on Arc testnet, with the faucet). The "check with your wallet"
// quick comparison lives under the second entry: the check fee is the visitor's, nothing is executed here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FlowCanvas } from "../components/FlowCanvas";
import { WhoPays } from "../components/WhoPays";
import { GuidePanel, type Origin } from "../components/GuidePanel";
import { guideFor, type CheckpointId } from "../lib/guide";
import { usdcNative } from "../lib/format";
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
  // the guided walkthrough (review of 2026-10-09): where this run came from, what the visitor already inspected, what this browser did with the passport
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [visited, setVisited] = useState<CheckpointId[]>([]);
  const [local, setLocal] = useState<{ runId: string; exported?: boolean; verified?: "passed" | "failed" | "partial" | null } | null>(null);
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
  const fresh = () => { setOrigin(null); setReason(null); setVisited([]); setLocal(null); };
  const start = async (opts: DemoOptions = {}) => {
    setBusy(true); setNotice(null); setSample(false); setRun(null); walletRun.reset(); fresh();
    try {
      const r = await startDemo(effective, undefined, opts);
      if (r.mode === "live") {
        setOrigin("live");
        setNotice(r.admission === "existing"
          ? { tone: "warn", text: "Same admission key: showing the original run — no second order was created." }
          : { tone: "info", text: opts.interruptAfterBroadcast ? "Started with a simulated interruption: a real transaction is broadcast, then the runner stops waiting; recovery resolves the outcome." : `Started on ${netLabel}: the project runner pays from project funds.` });
        poll(r.runId); return;
      }
      setBusy(false);
      const why = describeBody(r.body);
      setOrigin("sample"); setReason(why.text);
      setNotice({ tone: "warn", text: `${why.text} Showing the latest recorded run instead (RECORDED_SAMPLE) — no new transaction was initiated.`, raw: why }); setSample(true); setRun(r.run);
    } catch (e: any) { setBusy(false); const d = describeError(e); setNotice({ tone: "bad", text: d.text, raw: d }); }
  };
  const startWallet = async () => {
    if (!f) return;
    setNotice({ tone: "info", text: `Checking with your wallet on ${netLabel}: it signs the ${feeText} USDC check fee only — that fee is yours. Execution continues in the Developer workflow.` });
    setSample(false); setRun(null); fresh();
    await walletRun.start(f);
    refreshBal(); loadRuns();
  };
  const open = async (id: string) => { setSample(false); setNotice(null); walletRun.reset(); fresh(); setOrigin("history"); try { const r = await api.run(id); setRun(r); if (r.state === "RUNNING" || r.state === "RECONCILE_REQUIRED") { setBusy(r.state === "RUNNING"); poll(id); } } catch { /* ignore */ } };
  const guide = useMemo(() => guideFor(run, net, { ...(local && run && local.runId === run.runId ? local : {}), visited }), [run, net, local, visited]);
  const onGo = useCallback((id: CheckpointId | null) => { if (id) setVisited((v) => (v.includes(id) ? v : [...v, id])); }, []);
  // the element the guide points at gets the highlight (review of 2026-10-09, item 2)
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.getElementById(guide.next.target); if (!el) return;
    el.classList.add("guide-hot"); return () => el.classList.remove("guide-hot");
  }, [guide.next.target]);
  // ≈ check fee + order amount + a typical business gas spend (≈0.0012 USDC): the number the entry card and the run bar quote per project-funded run
  const perRun = (() => { try { return net?.priceTokenAtomic && net.budget?.amountNativeAtomic ? usdcNative((BigInt(net.priceTokenAtomic) * 10n ** 12n + BigInt(net.budget.amountNativeAtomic) + 1_200_000_000_000_000n).toString(), 3) : null; } catch { return null; } })();

  const headline = (f?.headline ?? "…").replace(/_/g, " ").toLowerCase();
  const walletShowing = walletRun.run.phase !== "idle";
  const showing = !!run || walletShowing;
  useEffect(() => { if (showing) setScrollKey((k) => k + 1); }, [showing]); // scroll once the panel exists, not before
  const running = run?.state === "RUNNING" || walletBusy;
  const liveSteps = walletShowing ? walletRun.run.steps : run?.steps ?? [];
  const seen = new Set(liveSteps.map((s) => s.step));
  const reached = STAGES.filter((st) => st.steps.some((x) => seen.has(x))).length;
  // the strip, the guide and the diagram count the same seven lifecycle stages (user feedback 2026-10-09: no two notions of "step")
  const stripStep = guide.now ? guide.stages.findIndex((st) => st.id === guide.now!.stage) + 1 : Math.max(1, guide.stages.filter((st) => st.status === "done").length);
  const pick = (id: Fixture) => { setFixture(id); setParams((p) => { p.set("fixture", id); return p; }); };
  const canRun = !busy && !walletBusy && !!net && !!f?.merchant && !gated;
  const runner = net?.accounts.demoRunner ?? null;
  return (
    <section className="section demo">
      <div className="container stack" style={{ gap: 28 }}>
        {running && (
          <div className="runstrip" role="status" aria-live="polite">
            <Spinner /><span className="small">{walletShowing ? `running · ${f?.title ?? effective} · your wallet · step ${Math.max(1, reached)}/${STAGES.length}` : `running · ${f?.title ?? effective} · project runner · ${guide.now?.label ?? "starting"} (step ${stripStep}/${guide.stages.length})`}</span>
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
            <p className="small muted">The project's runner {runner ? <Hex value={runner} n={4} /> : <code>…</code>} pays everything from <b>project funds</b> (testnet USDC): the {feeText} USDC check fee, the {orderText} USDC order and the gas. Your wallet is not involved.</p>
            <WhoPays mode="project" fee={feeText} order={orderText} />
            <div className="row"><a href="#situations" className="btn primary sm">{WATCH_LABEL} ↓</a><span className="tiny dim">no wallet needed{net && perRun ? ` · today ${net.budget.usedToday}/${net.budget.maxRunsPerDay} runs · ≈ ${perRun} each` : ""}</span></div>
          </section>
          <section className="entry" aria-labelledby="entry-try" data-testid="entry-try">
            <div className="kicker" id="entry-try">{TRY_LABEL}</div>
            <p className="small muted">The <Link to={link("/developer")}>Developer workflow</Link> runs the same seven steps with <b>your</b> wallet on {netLabel}: you pay the check fee, the order and your gas{mainnet ? "" : " (faucet available)"}.</p>
            <WhoPays mode="wallet" fee={feeText} order={orderText} />
            <div className="row" style={{ gap: 10 }}><Link to={link("/developer")} className="btn sm">{TRY_LABEL} →</Link></div>
            {w.account ? (onArc
              ? <div className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 10 }}><button className="btn sm" disabled={walletBusy || busy || !net || !f?.merchant || unfunded} title={unfunded ? `this wallet cannot pay the ${feeText} USDC check fee yet — claim testnet USDC below` : `your wallet signs the ${feeText} USDC check fee (yours); execution continues in the Developer workflow`} onClick={startWallet}>{walletBusy ? <><Spinner /> checking…</> : `▶ Check "${headline}" with your wallet`}</button></div>
                  <span className="tiny dim">a quicker look: your wallet signs the {feeText} USDC check fee — that fee is yours; nothing is executed here, execution continues in the Developer workflow</span>
                  <FaucetCard net={net} wallet={w} balance={bal} required={feeRequired} step="the check fee" onClaimed={refreshBal} />
                </div>
              : <div className="row" style={{ gap: 10 }}><button className="btn sm" onClick={() => net && w.switchChain(net)} title={`your wallet is on chain ${w.chainId ?? "?"}; the demo runs on ${netLabel}`}>{`Switch to ${netLabel} first`}</button><span className="tiny dim">your connected wallet is on another chain</span></div>)
              : <span className="tiny dim">or connect a wallet in the header to run only the check from here</span>}
          </section>
        </div>

        {!showing && <FlowCanvas stages={idleLifecycle()} idle caption="every run walks this lifecycle; the stage in progress lights up, and each node opens its result" />}
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

        {!showing && (
          <div className="facts" role="list" aria-label="before you start" data-testid="facts">
            <div className="fact" role="listitem"><span className="ico" aria-hidden="true">1</span><span><b>Real transactions on {netLabel}</b>, paid by the project runner from project funds ({mainnet ? "USDC" : "testnet USDC"}).</span></div>
            <div className="fact" role="listitem"><span className="ico" aria-hidden="true">2</span><span><b>Your connected wallet is never charged</b> by these two buttons.</span></div>
            <div className="fact" role="listitem"><span className="ico" aria-hidden="true">3</span><span><b>The order belongs to the project's DemoMerchant</b> — a demo merchant; nothing is delivered.</span></div>
          </div>
        )}
        <div className="stack" style={{ gap: 10 }}>
          <div className="row between runbar" style={{ alignItems: "center" }}>
            {!showing && <p className="muted small" style={{ maxWidth: 560 }}>Each run: order → paid check → decision → execution → passport. About {perRun ?? "0.06 USDC"} per run.</p>}
            <div className="row runbar-actions" style={{ gap: 10 }}>
              <button className="btn primary" id="run-start" disabled={!canRun} title={gated ? "gated on this instance — execution opens after the mainnet acceptance; use the testnet instance" : "the project runner pays from project funds"} onClick={() => start()}>{busy ? <><Spinner /> running…</> : f?.id === "APPROVED_PAYMENT" ? "▶ Run live · project runner" : `▶ Run "${headline}" live · project runner`}</button>
              {f?.id === "APPROVED_PAYMENT" && <button className="btn" disabled={!canRun} title={gated ? "gated on this instance — execution opens after the mainnet acceptance; use the testnet instance" : "a real transaction is broadcast; the runner then stops waiting for the receipt, as a crashed process would; recovery resolves it from the original hash and the order state"} onClick={() => start({ interruptAfterBroadcast: true })}>▶ Run with a simulated interruption</button>}
            </div>
          </div>
          {!showing && f?.id === "APPROVED_PAYMENT" && <p className="hint-line" data-testid="interruption-hint">Simulated interruption: a real transaction is broadcast, then the runner stops waiting for the confirmation. Recovery resolves it from the original hash and the order state — no second order, no second signature.</p>}
        </div>
        {!walletShowing && <GuidePanel guide={guide} origin={run ? origin : null} reason={reason} network={netLabel} onGo={onGo} link={link} underStrip={running} />}
        {notice && <div className={`banner ${notice.tone === "info" ? "info" : notice.tone === "bad" ? "bad" : ""}`}>{notice.text}{notice.raw?.code && <details className="error-raw"><summary>raw response ({notice.raw.code})</summary><pre className="json">{JSON.stringify(notice.raw.raw, null, 2)}</pre></details>}</div>}
        <div ref={panelRef} className="scroll-target stack" style={{ gap: 28 }}>
          {run && <><HandRule /><RunPanel key={run.runId} run={run} net={net} sample={sample} onUpdate={setRun} origin={origin} reason={reason} onLocal={(id, l) => setLocal({ runId: id, ...l })} /></>}
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
