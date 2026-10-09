import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, explorerAddr, type RunSummary } from "../lib/api";
import { Chip, DecisionBadge, Hex } from "../components/Badges";
import { RunsTable } from "../components/RunsTable";
import { Pipeline } from "../components/Pipeline";
import { Typewriter } from "../components/Typewriter";
import { Thread, type Anchor } from "../components/Thread";
import { HeroScene, TwoFaces, PinnedBlocks, ReceiptChain, FacilitatorFlow, ProxySwap, Squiggle } from "../components/Illustrations";
import { usdcToken } from "../lib/format";

const MONOLOGUE = [
  "I'm an agent about to pay a 0.05 USDC order on Arc. The merchant is an upgradeable proxy, approved on implementation A.",
  "Before I sign I buy one pinned report: what is behind that proxy right now, and does my exact call still match the order?",
  "The proxy moved to B — same ABI, same calldata, the payment would still succeed. I stop. B was never approved.",
  "Another day my response vanished after the transaction may have left. I don't pay again — I recover the original attempt.",
  "When it's done, the Payment Passport leaves with me: a new process can verify what was approved, sent and settled.",
];

export default function Home() {
  const { net, link = (to: string) => to } = useNet();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => { api.runs(5).then((r) => setRuns(r.runs)).catch(() => {}); }, []);
  const fx = (id: string) => net?.fixtures.find((f) => f.id === id);
  const mainnet = net?.network === "mainnet";
  const netName = mainnet ? "Arc mainnet" : "Arc testnet";
  const home = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLDivElement>(null), loop = useRef<HTMLDivElement>(null), mA = useRef<HTMLDivElement>(null), mB = useRef<HTMLDivElement>(null), mC = useRef<HTMLDivElement>(null), f2 = useRef<HTMLDivElement>(null), f3 = useRef<HTMLDivElement>(null), arc = useRef<HTMLDivElement>(null), fee = useRef<HTMLDivElement>(null), chain = useRef<HTMLDivElement>(null), honest = useRef<HTMLDivElement>(null);
  const anchors = useMemo<Anchor[]>(() => [{ ref: hero, side: "left" }, { ref: loop, side: "right" }, { ref: mA, side: "left" }, { ref: mB, side: "right" }, { ref: mC, side: "left" }, { ref: f2, side: "right" }, { ref: f3, side: "left" }, { ref: arc, side: "right" }, { ref: fee, side: "left" }, { ref: chain, side: "right" }, { ref: honest, side: "left" }], []);
  return (
    <div className="home" ref={home}>
      <Thread container={home} anchors={anchors} />

      {/* hero: Arc first, then the payment that outlives its session */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 30 }}>
        <div className="container" ref={hero}>
          <div className="arc-lockup">
            <img src="/arc/logo-gradient.svg" className="arc-logo-big" alt="Arc" />
            <p className="arc-logo-note">built on <b>Arc</b> — Circle's chain where <b>USDC is the gas</b>, chain id {net?.chainId ?? 5042}, ~1 s blocks</p>
          </div>
          <div className="cols" style={{ marginTop: 34 }}>
            <div className="stack" style={{ gap: 22 }}>
              <h1>Pay the approved order.<br />Recover the original attempt.<br /><span className="underline-squiggle">Take the proof with you.<Squiggle /></span></h1>
              <p className="muted" style={{ fontSize: "1.15rem", maxWidth: 640 }}>Recoverable USDC checkout on Arc, with approval-aware execution and portable proof.</p>
              
              <Typewriter lines={MONOLOGUE} className="monologue" />
              <div className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <Link to={link("/demo")} className="btn primary" title="the project's runner pays from project funds; no wallet needed">Watch a project-funded demo</Link>
                <Link to={link("/developer")} className="btn" title="your wallet pays the check fee, the order and the gas on Arc testnet; the faucet funds it">Try with my wallet</Link>
                <Link to={link("/verify")} className="btn ghost">Verify a passport</Link>
                <Link to={link("/inspect")} className="btn ghost">Inspect the sample contracts</Link>
              </div>
              <div className="chain-strip">
                <span className="blk" /><span className="blk" /><span className="blk" />
                <span>head <b style={{ color: "var(--ink-2)" }}>{net?.head ? `#${net.head}` : "…"}</b></span>
                <span>· {net?.caip2 ?? "eip155:5042"}</span>
                <span>· a check costs {net ? usdcToken(net.priceTokenAtomic) : "0.01 USDC"}</span>
                <span>· live runs today {net ? `${net.budget.usedToday}/${net.budget.maxRunsPerDay}` : "…"}</span>
              </div>
            </div>
            <HeroScene />
          </div>
        </div>
      </section>

      {/* how to explore: three paths, what each needs (design v3.3: the whole lifecycle with your own wallet) */}
      <section className="section-tight">
        <div className="container">
          <div className="panel soft" aria-label="how to explore">
            <div className="row between" style={{ alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <div className="kicker">explore in three minutes</div>
              <span className="tiny dim">{mainnet ? "business execution on Arc mainnet opens after the mainnet acceptance — the testnet side is free to use now" : "everything below runs on Arc testnet with free test funds; the mainnet side shows the same product behind its acceptance gate"}</span>
            </div>
            <div className="three" style={{ gap: 20, marginTop: 10 }}>
              <div className="stack" style={{ gap: 6 }}>
                <b>1 · Watch a project-funded demo</b>
                <span className="small muted">No wallet needed. <Link to={link("/demo")}>Watch a project-funded demo</Link>: the project runner pays a real order from project funds.</span>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <b>2 · Try with my wallet</b>
                <span className="small muted"><Link to={link("/developer")}>Try with my wallet</Link>: your wallet, your order, the seven steps, your passport.</span>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <b>3 · Check the proof</b>
                <span className="small muted"><Link to={link("/verify")}>Verify</Link> any passport offline and against an Arc RPC — in the browser or in a clean process.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* the loop, hanging off the thread to the right */}
      <section className="section-tight">
        <div className="container">
          <div className="along right w-880" ref={loop}>
            <p className="caption">the whole loop. the report is decision support — the agent decides, signs, broadcasts, checks the outcome, and the attempt stays recoverable</p>
            <Pipeline idle />
          </div>
        </div>
      </section>

      {/* three moments */}
      <section className="section" style={{ paddingTop: 30 }}>
        <div className="container stack" style={{ gap: 64 }}>
          <p className="bigq along left w-760">A payment should outlive the agent session that started it. <em>Three moments</em> show what that means.</p>
          <div className="along left w-880" ref={mA}>
            <div className="cols" style={{ gap: 28 }}>
              <div className="stack" style={{ gap: 10 }}>
                <p className="kicker">moment A · the address stayed, the approval did not</p>
                <h2 style={{ fontSize: "1.9rem" }}>Review required.</h2>
                <p className="muted">Implementation A was approved. The proxy now runs compatible B: same ABI, same price, a simulation passes. Signing stops anyway — B was never approved.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="REVIEW_REQUIRED" size="sm" />{fx("CHANGED_IMPLEMENTATION")?.merchant && <span className="tiny dim">proxy <Hex value={fx("CHANGED_IMPLEMENTATION")!.merchant} n={4} /></span>}<Link to={link("/demo?fixture=CHANGED_IMPLEMENTATION")} className="small">run this one →</Link></p>
              </div>
              <ProxySwap changed />
            </div>
          </div>
          <div className="along right w-880" ref={mB}>
            <div className="cols rev" style={{ gap: 28 }}>
              <ReceiptChain />
              <div className="stack" style={{ gap: 10 }}>
                <p className="kicker" style={{ color: "var(--amber, #fbbf24)" }}>moment B · the response disappeared, not necessarily the money</p>
                <h2 style={{ fontSize: "1.9rem" }}>Recover the purchase, don't repeat it.</h2>
                <p className="muted">The signed transaction and a durable "broadcast may be attempted" marker are persisted before anything leaves. If the response is lost, the attempt is recovered from its hash and the order state — never by paying again.</p>
                <p className="row" style={{ gap: 10 }}><Chip tone="warn">payment result not yet established → recovery desk</Chip><Link to={link("/demo?fixture=APPROVED_PAYMENT")} className="small">run one with a simulated interruption →</Link></p>
              </div>
            </div>
          </div>
          <div className="along left w-880" ref={mC}>
            <div className="cols" style={{ gap: 28 }}>
              <div className="stack" style={{ gap: 10 }}>
                <p className="kicker" style={{ color: "var(--mint)" }}>moment C · a new reader finds the payment</p>
                <h2 style={{ fontSize: "1.9rem" }}>Take the Payment Passport with you.</h2>
                <p className="muted">Every run exports a Payment Passport: the approval, the intent, the pinned report, the decision, the execution record and a USDC cost statement. Anyone can verify it later, in a clean process.</p>
                <p className="row" style={{ gap: 10 }}><Chip tone="ok">manifest · digests · cost statement · evidence</Chip><Link to={link("/verify")} className="small">how verification works →</Link></p>
              </div>
              <PinnedBlocks />
            </div>
          </div>
        </div>
      </section>

      {/* the other two acceptance fixtures */}
      <section className="section" style={{ paddingTop: 10 }}>
        <div className="container stack" style={{ gap: 48 }}>
          <p className="caption along left w-760">the live demo runs three fixed fixtures on the project's own funds — moment A above, and these two</p>
          <div className="along right w-880" ref={f2}>
            <div className="cols rev" style={{ gap: 28 }}>
              <TwoFaces />
              <div className="stack" style={{ gap: 10 }}>
                <p className="kicker" style={{ color: "var(--rose)" }}>the amount is in the wrong units</p>
                <h2 style={{ fontSize: "1.9rem" }}>Blocked.</h2>
                <p className="muted">USDC is Arc's gas: 18 decimals native, 6 on the ERC-20 face, one balance. A 0.05 USDC order sent as native <code>50000</code> is a million times too small. Blocked before signing.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="BLOCKED" size="sm" /><Link to={link("/demo?fixture=AMOUNT_UNIT_MISMATCH")} className="small">run this one →</Link></p>
              </div>
            </div>
          </div>
          <div className="along left w-880" ref={f3}>
            <div className="cols" style={{ gap: 28 }}>
              <div className="stack" style={{ gap: 10 }}>
                <p className="kicker" style={{ color: "var(--mint)" }}>nothing fired</p>
                <h2 style={{ fontSize: "1.9rem" }}>Paid, proven, exported.</h2>
                <p className="muted">Baseline matches, the order is payable, the simulation passes. The runner re-validates at a fresh pinned block, signs exactly the plan, broadcasts, and reads the order back: paid, by this payer, for this amount.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="CONFIRMED" size="sm" /><Link to={link("/demo?fixture=APPROVED_PAYMENT")} className="small">run this one →</Link></p>
              </div>
              <ProxySwap />
            </div>
          </div>
        </div>
      </section>

      {/* Arc, specifically */}
      <section className="section">
        <div className="container stack" style={{ gap: 56 }}>
          <div className="along right w-760" ref={arc}>
            <h2><img src="/arc/arc-icon.svg" className="arc-icon" alt="" /> Arc-specific by construction, <em>not by branding</em></h2>
            <p className="muted" style={{ marginTop: 12 }}>Arc settles the fee, the payment and the gas in one denomination, USDC. The workflow budgets and explains every cost in it.</p>
            <div className="stack" style={{ marginTop: 18, gap: 10 }}>
              <p className="margin-note" style={{ maxWidth: "none" }}>reads are pinned by block hash and re-verified by number — a few blocks behind head, because the public RPC is load-balanced</p>
              <p className="margin-note" style={{ maxWidth: "none", color: "var(--violet)" }}>fee floor is 20 gwei: lower transactions are silently dropped, so final validation re-estimates before signing and the cost statement shows authorized maximum next to actual spend</p>
              <p className="tiny dim">PREVRANDAO is 0, value-transfer rules differ, SELFDESTRUCT moves USDC: advisories, never findings.</p>
            </div>
          </div>
          <div className="along left w-760" ref={fee}>
            <h3>The check fee is x402, settled on Arc by ArcPreflight's own relayer</h3>
            <p className="muted" style={{ marginTop: 8 }}>One EIP-3009 <code>TransferWithAuthorization</code> for exactly 0.01 USDC, relayed by the project's own merchant account. The report is delivered only after the fee settles on Arc.</p>
            <FacilitatorFlow />
          </div>
          <div className="along right w-760" ref={chain}>
            <h3>Every receipt carries the receipts before it</h3>
            <p className="muted" style={{ marginTop: 8 }}>Each digest is keccak256 over canonical JSON and feeds the next receipt. A blocked request stops at its stage; nothing is made up. The passport packages what a replay needs. <Link to={link("/inspect")}>Look at an observed contract</Link>.</p>
          </div>
        </div>
      </section>

      {/* honesty + capabilities, then the recent runs at full width (P3: the history table never scrolls sideways on a desktop) */}
      <section className="section" style={{ paddingTop: 10 }}>
        <div className="container stack" style={{ gap: 44 }}>
          <div className="stack along left w-640" style={{ gap: 12 }} ref={honest}>
            <h2 style={{ fontSize: "1.9rem" }}>Honest by construction</h2>
            <p className="muted"><b style={{ color: "var(--ink)" }}>NO_POLICY_VIOLATION</b> means no configured check fired at the pinned block. It is never "safe". Runs are labelled <code>LIVE_REQUEST</code>, <code>DEMO_ON_MAINNET</code> or <code>RECORDED_SAMPLE</code> for what they are.</p>
            <p className="muted small"><b style={{ color: "var(--ink)" }}>What this is not:</b> a security audit, an escrow, wallet-level enforcement, or proof that an offchain service was delivered. One tested merchant template; nothing is custodied.</p>
            <p className="caption">LLMs may explain. Code decides.</p>
            <p className="small"><Link to={link("/evidence")}>Implementation status per capability, limitations and evidence files →</Link></p>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row between"><h3>Recent runs on {netName}</h3><Link to={link("/demo")} className="small">all runs →</Link></div>
            {runs.length === 0 ? <p className="dim small">No runs yet — start one on the demo page.</p> : <RunsTable runs={runs} net={net} compact />}
            {net?.deployments && <p className="tiny dim">fixtures deployed {net.deployments.deployedAtUTC.slice(0, 10)} on {netName} · MAIN proxy <a href={explorerAddr(net, net.deployments.proxies.MAIN.address)} target="_blank" rel="noreferrer">{net.deployments.proxies.MAIN.address.slice(0, 10)}…</a>{net.accounts.orderCreator && <> · orders created by <code>{net.accounts.orderSignerRole ?? "order-creator"}</code>{net.accounts.adminKeyInProcess ? " (admin key in process — preview only)" : ""}</>}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
