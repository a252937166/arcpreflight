import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useNet } from "../App";
import { api, explorerAddr, type RunSummary } from "../lib/api";
import { DecisionBadge, Hex } from "../components/Badges";
import { Pipeline } from "../components/Pipeline";
import { Typewriter } from "../components/Typewriter";
import { Thread, type Anchor } from "../components/Thread";
import { HeroScene, TwoFaces, PinnedBlocks, ReceiptChain, FacilitatorFlow, ProxySwap, Squiggle } from "../components/Illustrations";
import { ago, usdcToken } from "../lib/format";

const MONOLOGUE = [
  "I'm an agent. I'm about to pay 0.05 USDC to a merchant contract on Arc.",
  "The contract is a proxy. It was approved on implementation A last week.",
  "Before I sign anything I buy a report pinned at one block: what is behind that proxy right now?",
  "Still A → I validate again at a fresh block, sign the exact plan, and prove the order got paid.",
  "Moved to B, same ABI, same calldata → I stop and ask a human.",
];

export default function Home() {
  const { net } = useNet();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  useEffect(() => { api.runs(5).then((r) => setRuns(r.runs)).catch(() => {}); }, []);
  const fx = (id: string) => net?.fixtures.find((f) => f.id === id);
  const home = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLDivElement>(null), loop = useRef<HTMLDivElement>(null), o1 = useRef<HTMLDivElement>(null), o2 = useRef<HTMLDivElement>(null), o3 = useRef<HTMLDivElement>(null), arc = useRef<HTMLDivElement>(null), fee = useRef<HTMLDivElement>(null), chain = useRef<HTMLDivElement>(null), honest = useRef<HTMLDivElement>(null);
  const anchors = useMemo<Anchor[]>(() => [{ ref: hero, side: "left" }, { ref: loop, side: "right" }, { ref: o1, side: "left" }, { ref: o2, side: "right" }, { ref: o3, side: "left" }, { ref: arc, side: "right" }, { ref: fee, side: "left" }, { ref: chain, side: "right" }, { ref: honest, side: "left" }], []);
  return (
    <div className="home" ref={home}>
      <Thread container={home} anchors={anchors} />

      {/* hero: Arc first, then the agent */}
      <section className="section" style={{ paddingTop: 48, paddingBottom: 30 }}>
        <div className="container" ref={hero}>
          <div className="arc-lockup">
            <img src="/arc/logo-gradient.svg" className="arc-logo-big" alt="Arc" />
            <p className="arc-logo-note">built on <b>Arc</b> — Circle's chain where <b>USDC is the gas</b>, chain id {net?.chainId ?? 5042}, ~1 s blocks</p>
          </div>
          <div className="cols" style={{ marginTop: 34 }}>
            <div className="stack" style={{ gap: 22 }}>
              <h1>Know what you're paying<br /><span className="underline-squiggle">before you sign<Squiggle /></span></h1>
              <Typewriter lines={MONOLOGUE} className="monologue" />
              <div className="row" style={{ marginTop: 4 }}>
                <Link to="/demo" className="btn primary">Run it live on Arc</Link>
                <Link to="/inspect" className="btn">Look at any Arc contract</Link>
                <Link to="/developer" className="btn ghost">bring your own wallet →</Link>
              </div>
              <div className="chain-strip">
                <span className="blk" /><span className="blk" /><span className="blk" />
                <span>head <b style={{ color: "var(--ink-2)" }}>{net?.head ? `#${net.head}` : "…"}</b></span>
                <span>· {net?.caip2 ?? "eip155:5042"}</span>
                <span>· a report costs {net ? usdcToken(net.priceTokenAtomic) : "0.01 USDC"}</span>
                <span>· live runs today {net ? `${net.budget.usedToday}/${net.budget.maxRunsPerDay}` : "…"}</span>
              </div>
            </div>
            <HeroScene />
          </div>
        </div>
      </section>

      {/* the loop, hanging off the thread to the right */}
      <section className="section-tight">
        <div className="container">
          <div className="along right w-880" ref={loop}>
            <p className="caption">the whole loop. the report is decision support — the agent decides, signs, broadcasts and checks the outcome itself</p>
            <Pipeline idle />
          </div>
        </div>
      </section>

      {/* three outcomes, left / right / left along the thread */}
      <section className="section" style={{ paddingTop: 30 }}>
        <div className="container stack" style={{ gap: 64 }}>
          <p className="bigq along left w-760">Between <em>approved</em> and <em>signed</em> there is time, there is a proxy, and there is USDC with two faces. Three things can be true.</p>
          <div className="along left w-880" ref={o1}>
            <div className="cols" style={{ gap: 28 }}>
              <div className="stack" style={{ gap: 10 }}>
                <p className="hand">① the implementation moved</p>
                <h2 style={{ fontSize: "1.9rem" }}>Review required.</h2>
                <p className="muted">The merchant proxy was approved on implementation A and silently upgraded to B. Same ABI, same calldata, same price. The pinned report sees the new code hash; the agent refuses to sign until a human re-approves the baseline.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="REVIEW_REQUIRED" size="sm" />{fx("CHANGED_IMPLEMENTATION")?.merchant && <span className="tiny dim">proxy <Hex value={fx("CHANGED_IMPLEMENTATION")!.merchant} n={4} /></span>}<Link to="/demo?fixture=CHANGED_IMPLEMENTATION" className="small">run this one →</Link></p>
              </div>
              <ProxySwap changed />
            </div>
          </div>
          <div className="along right w-880" ref={o2}>
            <div className="cols rev" style={{ gap: 28 }}>
              <TwoFaces />
              <div className="stack" style={{ gap: 10 }}>
                <p className="hand rose">② the amount is in the wrong units</p>
                <h2 style={{ fontSize: "1.9rem" }}>Blocked.</h2>
                <p className="muted">USDC is Arc's gas. Native value has 18 decimals, the ERC-20 face has 6, one balance behind both. The order is 0.05 USDC; the calldata carries <code>value = 50000</code>. AMOUNT_SEMANTICS blocks it before a signature exists — and the pinned simulation decodes the contract's own <code>WrongAmount(...)</code>.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="BLOCKED" size="sm" /><Link to="/demo?fixture=AMOUNT_UNIT_MISMATCH" className="small">run this one →</Link></p>
              </div>
            </div>
          </div>
          <div className="along left w-880" ref={o3}>
            <div className="cols" style={{ gap: 28 }}>
              <div className="stack" style={{ gap: 10 }}>
                <p className="hand mint">③ nothing fired</p>
                <h2 style={{ fontSize: "1.9rem" }}>Paid, and proven.</h2>
                <p className="muted">Baseline matches, the order is payable, the simulation passes. The agent re-validates at a new block after paying the service fee, signs exactly the validated plan, decodes its own signed bytes against the plan, broadcasts, and reads the order back: paid, by this payer, for this amount.</p>
                <p className="row" style={{ gap: 10 }}><DecisionBadge decision="CONFIRMED" size="sm" /><Link to="/demo?fixture=APPROVED_PAYMENT" className="small">run this one →</Link></p>
              </div>
              <PinnedBlocks />
            </div>
          </div>
        </div>
      </section>

      {/* Arc, specifically */}
      <section className="section">
        <div className="container stack" style={{ gap: 56 }}>
          <div className="along right w-760" ref={arc}>
            <h2><img src="/arc/arc-icon.svg" className="arc-icon" alt="" /> Arc-specific by construction, <em>not by branding</em></h2>
            <p className="muted" style={{ marginTop: 12 }}>Everything here exists because of how Arc works. USDC pays for gas, so a unit mistake is a money mistake. Blocks come every second, so a report must say <em>which</em> block it looked at. Circle's Facilitator settles x402 on Arc, so the report itself can be bought with USDC and nothing else.</p>
            <div className="stack" style={{ marginTop: 18, gap: 10 }}>
              <p className="margin-note" style={{ maxWidth: "none" }}>reads are pinned by block hash and re-verified by number — a few blocks behind head, because the public RPC is load-balanced</p>
              <p className="margin-note" style={{ maxWidth: "none", color: "var(--violet)" }}>fee floor is 20 gwei: lower transactions are silently dropped, so final validation re-estimates before signing</p>
              <p className="margin-note" style={{ maxWidth: "none", color: "var(--rose)" }}>PREVRANDAO is 0, value-transfer rules differ, SELFDESTRUCT moves USDC — surfaced as documentation-backed advisories, never as target findings</p>
            </div>
          </div>
          <div className="along left w-760" ref={fee}>
            <p className="hand teal">the service fee is x402, settled by the Circle Facilitator on Arc</p>
            <p className="muted" style={{ marginTop: 8 }}>One EIP-3009 <code>TransferWithAuthorization</code> for exactly the quoted 0.01 USDC, forwarded with a seller proof. The buyer needs no allowance and pays no gas; the settlement is a real transaction on Arc and the report is delivered only after it.</p>
            <FacilitatorFlow />
          </div>
          <div className="along right w-760" ref={chain}>
            <p className="hand violet">every receipt carries the receipts before it</p>
            <p className="muted" style={{ marginTop: 8 }}>Intent, report, decision, final validation, plan and execution are each digested over canonical JSON. Anyone with the raw RPC evidence can replay the chain and arrive at the same bytes. Circle's own proxies on Arc — GatewayWallet, FxEscrow, the ERC-8004 registries — are the public test objects: <Link to="/inspect">look at one</Link>.</p>
            <ReceiptChain />
          </div>
        </div>
      </section>

      {/* honesty + runs */}
      <section className="section" style={{ paddingTop: 10 }}>
        <div className="container two" style={{ alignItems: "start" }}>
          <div className="stack along left w-640" style={{ gap: 12 }} ref={honest}>
            <h2 style={{ fontSize: "1.9rem" }}>Honest by construction</h2>
            <p className="muted"><b style={{ color: "var(--ink)" }}>NO_POLICY_VIOLATION</b> means no configured check fired at the pinned block. It is never "safe". Runs are labelled <code>LIVE_REQUEST</code> when they happened on-chain just now, <code>DEMO_ON_MAINNET</code> when the project's own runner did it on Arc mainnet, and <code>RECORDED_SAMPLE</code> when the daily budget is spent and you are looking at a replay. Every signal says what it is based on — a chain read, a simulation, or a network advisory — and what it could not see.</p>
            <p className="caption">LLMs may explain. Code decides.</p>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row between"><h3>Recent runs on {net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}</h3><Link to="/demo" className="small">all runs →</Link></div>
            {runs.length === 0 && <p className="dim small">No runs yet — start one on the demo page.</p>}
            <ul className="runs-list">
              {runs.map((r) => (
                <li key={r.runId}>
                  <Link to={`/runs/${r.runId}`} className="row" style={{ gap: 10, color: "inherit" }}><DecisionBadge decision={r.businessStatus === "SUCCESS" ? "CONFIRMED" : r.decision ?? (r.state === "RUNNING" ? null : "FAILED")} size="sm" /><span className="small">{r.fixture.replace(/_/g, " ").toLowerCase()}</span></Link>
                  <span className="tiny dim">{ago(r.createdAt)}</span>
                </li>
              ))}
            </ul>
            {net?.deployments && <p className="tiny dim">fixtures deployed {net.deployments.deployedAtUTC.slice(0, 10)} · MAIN proxy <a href={explorerAddr(net, net.deployments.proxies.MAIN.address)} target="_blank" rel="noreferrer">{net.deployments.proxies.MAIN.address.slice(0, 10)}…</a></p>}
          </div>
        </div>
      </section>
    </div>
  );
}
