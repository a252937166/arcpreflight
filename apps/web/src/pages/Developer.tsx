// Developer workflow (design v3.3, docs/LIFECYCLE.md §9): the complete lifecycle for every connected wallet, as seven guided steps —
// create an order → review & approve → preflight check → execute with your wallet → recover if interrupted → export the Payment
// Passport → verify it independently. The service observes, validates and records; your wallet signs; the decision runs here.
// The identity of the workflow (order, check, attempt) is persisted per instance AND per payer (lib/workflow.ts): a refresh lands back
// where the same account was; a different connected account starts at step 1 and sees the other account's items read-only under
// "other wallets in this browser". Before a paid step the page checks the wallet's budget (fee + order + gas) and names the shortfall.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex as HexT } from "viem";
import { intentDigest, policyDigest, type IntentCore } from "@arcpreflight/schema";
import { decide } from "@arcpreflight/policy";
import { useNet } from "../App";
import { api, apiPath, ApiError, explorerAddr, explorerTx, type AttemptView, type BaselineRecord, type CheckRow, type OrderView, type PassportBundle } from "../lib/api";
import { approvedBaseline, developerIntent, developerPolicy, prepareOrderQuote, quoteReady, WALLET_VALIDATION_WINDOW_SECONDS, type PreparedQuote, WALLET_REPORT_AGE_SECONDS } from "../lib/preflight";
import { useWallet } from "../lib/wallet";
import { purchaseReport, signFeeAuthorization, type Delivered } from "../lib/walletRun";
import { describeBody, describeError, type Described } from "../lib/errors";
import { storedSession, withSession, type Session } from "../lib/session";
import { rememberedChecks } from "../lib/checks";
import { saveJson } from "../lib/download";
import { baselineDigestFor, creationStopped, creationUnconfirmed, fixtureForProxy, nativeAtomicToUsdcText, orderLimits, orderViewFromCreated, paymentLabel, toDeveloperOrder, ORDER_GATED_TEXT, type OrderBody, type Proxy } from "../lib/orders";
import { executeAttempt, executionInFlight, insideWindow, isOpen, isTerminal, isUncertain, reconcileUncertainAttempt, rememberedAttempts, sendValidatedAttempt, stateTone, type ExecutePhase, type Refusal } from "../lib/attempts";
import { clearWorkflow, loadWorkflow, loadWorkflows, saveWorkflow } from "../lib/workflow";
import { LIFECYCLE_LABELS, type LifecycleId, type LifecycleStage, type StageStatus } from "../lib/outcome";
import { budgetCheck, budgetComponents } from "../lib/faucet";
import { useBalances } from "../lib/balances";
import { verificationStageStatus, type VerificationKind } from "../lib/verifyInBrowser";
import { Chip, DecisionBadge, Hex, Spinner } from "../components/Badges";
import { ReportView } from "../components/Report";
import { FaucetCard } from "../components/FaucetCard";
import { Lifecycle } from "../components/Lifecycle";
import { StepSection } from "../components/StepSection";
import { OrderDialog, type OrderAnswer } from "../components/OrderDialog";
import { OrderCard } from "../components/OrderCard";
import { AttemptPanel } from "../components/AttemptPanel";
import { VerifyInBrowser } from "../components/VerifyInBrowser";
import { usdcNative, usdcToken, usdc6, decisionTone, utc, ago, short } from "../lib/format";

function ErrorBanner({ err }: { err: Described | null }) {
  if (!err) return null;
  return <div className="banner bad" role="alert">{err.text}{err.code && <details className="error-raw"><summary>raw response ({err.code})</summary><pre className="json">{JSON.stringify(err.raw, null, 2)}</pre></details>}</div>;
}
const payTone = (s?: string | null) => (s === "COMPLETED" ? "ok" : s === "FAILED" ? "bad" : s ? "warn" : "neutral");
/** a recovered/refreshed request as the single-request routes report it, folded back into a history row */
function foldRequest(row: CheckRow, r: any): CheckRow {
  const delivered = r?.delivery === "DELIVERED";
  return { ...row, state: delivered ? "DELIVERED" : r?.state ?? row.state, reportDigest: r?.reportDigest ?? row.reportDigest,
    payment: r?.payment ? { state: r.payment.state ?? row.payment?.state ?? "UNKNOWN", backend: r.payment.backend ?? row.payment?.backend ?? "relay", transaction: r.payment.transaction ?? row.payment?.transaction ?? null } : row.payment,
    passportAvailable: delivered || row.passportAvailable };
}
type Check = { intent: IntentCore; requestId: string; quote: PreparedQuote | null; delivered: Delivered | null };
type Exec = { phase: ExecutePhase; txHash: string | null; refusal: Refusal | null; err: Described | null };
const IDLE: Exec = { phase: "idle", txHash: null, refusal: null, err: null };
const STEP_OF: Record<LifecycleId, number> = { order: 1, approve: 2, check: 3, execute: 4, recover: 5, passport: 6, verify: 7 };
const EXECUTING: ExecutePhase[] = ["validating", "prompting", "reporting", "polling"];
const TEST_WALLET_BUILD = import.meta.env.VITE_TEST_WALLET === "1";
/** an order whose creation is not confirmed is re-read this often (GET reconciles from the chain and never sends), for at most this long */
const ORDER_POLL_MS = 3_000; const ORDER_POLL_LIMIT_MS = 20 * 60_000;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export default function Developer() {
  const { net, testWallet, select, instances = [] } = useNet();
  const w = useWallet();
  const account = w.account;
  const onArc = !!net && !!account && w.chainId === net.chainId;
  const fixturesDeployed = !!net && net.fixtures.some((f) => !!f.merchant);
  const gated = !!net && (net.access?.walletExecution === false || net.access?.publicExecution === false);
  const otherTestnet = instances.some((i) => i.network === "testnet") && net?.network !== "testnet";
  const netLabel = net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet";
  const limits = orderLimits(net);
  const role = net?.accounts?.orderSignerRole ?? "order-creator";
  const adminInProcess = role === "deployer-admin" || !!net?.accounts?.adminKeyInProcess;
  const netRef = useRef(net); netRef.current = net;

  // this browser's anonymous session with the selected instance (P3): created by the first paid action, reused afterwards
  const [session, setSession] = useState<Session | null>(() => storedSession());
  const [dialog, setDialog] = useState(false);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [orderMeta, setOrderMeta] = useState<{ baselineDigest: string | null; proxy: Proxy | null }>({ baselineDigest: null, proxy: null });
  const [approved, setApproved] = useState(false);
  const [unitMistake, setUnitMistake] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  /** the referenced approval as last read for `digest`. `outcome` is the last COMPLETED result — `loading` until the first answer, `loaded`
   *  (with `record`), or `missing` (the API has no such baseline: a definitive answer) — and `error` is the latest request's failure, kept
   *  apart from it: a transient error after a completed result never turns the result back into loading (review 2026-10-10, P3). The
   *  decision is never made from a read that has not finished (presentation review 2026-10-09, finding 1). */
  const [baselineRead, setBaselineRead] = useState<{ digest: string | null; record: BaselineRecord | null; outcome: "none" | "loading" | "loaded" | "missing"; error: Described | null }>({ digest: null, record: null, outcome: "none", error: null });
  const [now, setNow] = useState(Date.now);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [exec, setExec] = useState<Exec>(IDLE);
  const [passport, setPassport] = useState<{ bundle: PassportBundle; name: string; kind: "attempt" | "check" } | null>(null);
  const [verification, setVerification] = useState<VerificationKind | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Described | null>(null);
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({});
  const [mine, setMine] = useState<{ orders: OrderView[]; attempts: AttemptView[]; loaded: boolean; busy: boolean; err: Described | null; rowBusy: string | null; rowErr: Described | null }>({ orders: [], attempts: [], loaded: false, busy: false, err: null, rowBusy: null, rowErr: null });
  const [checks, setChecks] = useState<{ rows: CheckRow[]; busy: boolean; err: Described | null; loaded: boolean; rowBusy: string | null; rowErr: Described | null }>({ rows: [], busy: false, err: null, loaded: false, rowBusy: null, rowErr: null });
  /** the account whose workflow is on screen (null while switching or reading back): the save effect writes under this payer only */
  const owner = useRef<string | null>(null);
  const hydrated = useRef<string | null>(null); const hydrating = useRef<string | null>(null); const quoteSeq = useRef(0);
  // balances on the API's chain (native = gas and the business payment, ERC-20 face = the same balance); re-read after orders, purchases and faucet claims
  const bal = useBalances(w.provider, w.account, onArc && !!net, net?.usdc ?? null);
  const refreshBal = bal.refresh;
  // re-read on the events that move the wallet's balance: an order created, a check fee settled, an attempt that reached a terminal state (a
  // confirmed payment); the store is shared with the nav chip and every other view of this wallet (lib/balances.ts), other tabs are told
  const balanceEvent = `${order?.orderId ?? ""}|${order?.state ?? ""}|${check?.delivered?.requestId ?? ""}|${attempt?.attemptId ?? ""}|${attempt?.state ?? ""}|${attempt?.businessStatus ?? ""}`;
  useEffect(() => { if (order || check?.delivered || attempt) refreshBal(); }, [balanceEvent, refreshBal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derived facts
  // 2026-10-09: an order is usable only once its creation is CONFIRMED — approval, quote, purchase and execution stay closed before that;
  // PLANNED/SENT wait for the creation receipt (Recover), FAILED/UNKNOWN_CREATION stop (a new order is a new row)
  const orderConfirmed = !!order && order.state === "CONFIRMED";
  const orderPending = creationUnconfirmed(order);
  const orderStopped = creationStopped(order);
  const devOrder = useMemo(() => (order ? toDeveloperOrder(order, orderMeta.baselineDigest) : null), [order, orderMeta.baselineDigest]);
  const policy = useMemo(() => (account && devOrder ? developerPolicy(account, devOrder) : null), [account, devOrder]);
  const pDigest = useMemo(() => (policy ? policyDigest(policy) : null), [policy]);
  const intent = check?.intent ?? null;
  const delivered = intent && check?.delivered && check.delivered.report.intentDigest === intentDigest(intent) ? check.delivered : null;
  const quoteOk = !!check?.quote && !!devOrder && quoteReady(check.quote, devOrder.block, now);
  // the budget before a paid step: check fee + order amount + gas reserve (the plan's gasLimit × maxFeePerGas once a plan exists, else 100 000 gas × 30 gwei)
  const feeToken = net?.priceTokenAtomic ?? null;
  const budgetBuy = useMemo(() => budgetCheck(bal.native, { feeTokenAtomic: feeToken, amountNativeAtomic: order?.amountNativeAtomic ?? limits.defaultNativeAtomic, plan: null }), [bal.native, feeToken, order?.amountNativeAtomic, limits.defaultNativeAtomic]);
  // step 4 comes after the report was bought: its fee is already paid, so the execution needs the order amount and the gas reserve
  const budgetExec = useMemo(() => budgetCheck(bal.native, { feeTokenAtomic: feeToken, amountNativeAtomic: order?.amountNativeAtomic ?? 0n, plan: attempt?.state === "VALIDATED" ? attempt?.plan ?? null : null, feePaid: !!delivered }), [bal.native, feeToken, order?.amountNativeAtomic, attempt?.plan, attempt?.state, delivered]);
  const canBuy = orderConfirmed && !delivered && quoteOk && !!account && onArc && !busy && budgetBuy.enough !== false;
  // the approval the decision may use: the record read for THIS digest (a stale record of another proxy never stands in)
  const baseline = baselineRead.digest === orderMeta.baselineDigest ? baselineRead.record : null;
  // no decision before the first read of the referenced approval has finished (or the API answered that there is none); a failed re-read
  // keeps the last successful read, a failed first read keeps waiting (the effect retries) — a network error is not "no approval"
  const baselinePending = !!orderMeta.baselineDigest && (baselineRead.digest !== orderMeta.baselineDigest || baselineRead.outcome === "loading" || baselineRead.outcome === "none");
  const decision = useMemo(() => (intent && policy && pDigest && delivered && !baselinePending
    ? decide({ intent, policy, policyDigest: pDigest, baseline: baseline?.baseline ?? null, baselineDigest: (baseline?.baselineDigest as HexT | undefined) ?? null, baselineRevoked: baseline?.revoked ?? false, report: delivered.report as any, reportDigest: delivered.digest as HexT, now: new Date(now), simulation: delivered.simulation })
    : null), [intent, policy, pDigest, delivered, baseline, baselinePending, now]);
  /** a report is delivered and the referenced approval is still being read: the check stage is in progress, nothing is decided, stopped or opened */
  const deciding = !!delivered && !attempt && baselinePending;
  /** a completed result stands (loaded or missing) and the latest re-read failed: the decision stays, the failure is said */
  const baselineRereadFailed = !!delivered && !deciding && baselineRead.error !== null && (baselineRead.outcome === "loaded" || baselineRead.outcome === "missing");
  const reconciling = (exec.phase === "unknown-submission" || exec.phase === "uncertain") && busy === "execute";
  /** §10 item 1: the attempt carries a prompt marker (server view, or this browser's memory of having opened the prompt) and this page is not mid-execution
   *  with it — the transaction may have been submitted: never "Continue in wallet", never "Abandon (nothing sent)" */
  const uncertain = !!attempt && attempt.state === "VALIDATED" && !EXECUTING.includes(exec.phase) && (exec.phase === "uncertain" || isUncertain(attempt));
  /** the wallet answered with an error that is not a rejection, or the attempt is uncertain, and it is still open: no second prompt; the visitor decides (explicit abandon), the panel stays at step 4 */
  const ambiguous = (exec.phase === "unknown-submission" || uncertain) && !!attempt && attempt.state === "VALIDATED";
  const executing = EXECUTING.includes(exec.phase) || reconciling;
  const attemptOpen = !!attempt && isOpen(attempt.state);
  const attemptDone = !!attempt && isTerminal(attempt.state);
  const freshUntil = delivered && policy ? new Date(delivered.report.observation.observedAt).getTime() + policy.maxReportAgeSeconds * 1000 : null;
  const freshLeft = freshUntil ? Math.max(0, Math.round((freshUntil - now) / 1000)) : null;
  // an attempt that ended without a transaction (rejected prompt, abandoned, never mined, closed unexecuted) leaves the visitor at step 4: the
  // order is still unpaid and may be executed again — with a fresh report; only a confirmed, mismatched or reverted attempt moves the workflow on to the passport
  const attemptSettled = !!attempt && (attempt.state === "CONFIRMED" || attempt.state === "MISMATCH" || attempt.state === "REVERTED");
  const expired = !!delivered && !attemptOpen && !attemptSettled && !executing && freshLeft === 0;
  const executable = orderConfirmed && decision?.decision === "NO_POLICY_VIOLATION" && !expired;
  const checkStopped = (!!decision && decision.decision !== "NO_POLICY_VIOLATION" && !expired && !attempt) || (attempt?.state === "REFUSED" && !expired);
  // a VALIDATED attempt inside its window is still step 4's business (the prompt may be opened again, or abandoned); one that is broadcast or whose
  // window closed is recovery's (step 5)
  const stage = !orderConfirmed ? 1 : !approved ? 2 : (!delivered && !attempt) || expired || deciding ? 3 : checkStopped ? (passport ? (verification ? 8 : 7) : 6) : !attempt || executing ? 4 : attemptOpen ? (attempt.state === "VALIDATED" && (insideWindow(attempt, now) || ambiguous) ? 4 : 5) : !attemptSettled ? 4 : passport ? (verification ? 8 : 7) : 6;
  const isStepOpen = (n: number) => openSteps[n] ?? n === stage;
  const toggle = (n: number) => setOpenSteps((o) => ({ ...o, [n]: !isStepOpen(n) }));
  const jump = (id: LifecycleId) => { const n = STEP_OF[id]; setOpenSteps((o) => ({ ...o, [n]: true })); if (typeof document !== "undefined") document.getElementById(`step-${n}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" }); };
  const sstat = (n: number, done: boolean, extra?: StageStatus): StageStatus => (extra ?? (done ? "done" : n === stage ? "active" : "todo"));
  const execStatus: StageStatus = checkStopped ? "skipped" : attempt ? (attempt.state === "CONFIRMED" && attempt.businessStatus === "SUCCESS" ? "done" : isOpen(attempt.state) ? "warn" : attempt.state === "NOT_SENT" || attempt.state === "NOT_EXECUTED" || attempt.state === "NOT_MINED" ? "warn" : "stop") : exec.phase === "refused" ? "stop" : stage === 4 ? "active" : "todo";
  const recoverStatus: StageStatus = stage === 5 ? "active" : attemptDone ? ((attempt?.recovery?.reconciliation?.length ?? 0) > 0 ? "done" : "skipped") : "skipped";
  const verifyStatus: StageStatus = verification ? verificationStageStatus(verification) : sstat(7, false);
  const verifyNote = verification === "passed" ? "verified in this browser: passed" : verification === "failed" ? "verification FAILED in this browser" : verification === "partial" ? "partially verified (unverified findings)" : null;
  const stages: LifecycleStage[] = [
    { id: "order", label: LIFECYCLE_LABELS.order, status: !order ? sstat(1, false) : orderConfirmed ? "done" : orderPending ? "active" : "stop",
      note: !order ? null : orderConfirmed ? `${nativeAtomicToUsdcText(order.amountNativeAtomic)} USDC · ${paymentLabel(order).text}` : orderPending ? "waiting for the creation receipt" : "creation not established — create a new order" },
    { id: "approve", label: LIFECYCLE_LABELS.approve, status: sstat(2, approved && orderConfirmed), note: approved && orderConfirmed ? "policy approved" : null },
    // once an attempt exists its RECORDED decision is the fact; the live re-evaluation ages with the report (maxReportAgeSeconds) and would mislead
    { id: "check", label: LIFECYCLE_LABELS.check, status: deciding ? "active" : expired ? sstat(3, false) : attempt ? (attempt.decision === "BLOCKED" ? "stop" : attempt.decision === "REVIEW_REQUIRED" || attempt.state === "REFUSED" ? "review" : "done") : delivered ? (decision?.decision === "BLOCKED" ? "stop" : decision?.decision === "REVIEW_REQUIRED" ? "review" : "done") : sstat(3, false), note: deciding ? "reading the referenced approval before deciding…" : expired ? "report expired — re-run the check" : attempt ? attempt.decision.toLowerCase().replace(/_/g, " ") : decision ? decision.decision.toLowerCase().replace(/_/g, " ") : null },
    { id: "execute", label: LIFECYCLE_LABELS.execute, status: execStatus, note: checkStopped ? "nothing executed" : ambiguous ? (exec.phase === "unknown-submission" ? "wallet answer unexplained — reconciling" : "wallet was asked to sign — submission uncertain") : attempt ? attempt.state.toLowerCase().replace(/_/g, " ") : exec.phase === "refused" ? "refused" : null },
    { id: "recover", label: LIFECYCLE_LABELS.recover, status: recoverStatus, note: recoverStatus === "done" ? "reconciled" : recoverStatus === "active" ? "attempt still open" : "not needed" },
    { id: "passport", label: LIFECYCLE_LABELS.passport, status: sstat(6, !!passport), note: passport ? passport.name : null },
    { id: "verify", label: LIFECYCLE_LABELS.verify, status: verifyStatus, note: verifyNote },
  ];

  // ---- loaders
  const loadMine = useCallback(async () => {
    const current = storedSession(); setSession(current);
    if (!current) { setMine((m) => ({ ...m, loaded: true, busy: false })); return; }
    setMine((m) => ({ ...m, busy: true, err: null }));
    try {
      const [o, a] = await Promise.all([withSession((t) => api.orders(t)), withSession((t) => api.attempts(t))]);
      setSession(storedSession());
      setMine((m) => ({ ...m, orders: o?.orders ?? [], attempts: a?.attempts ?? [], loaded: true, busy: false, err: null }));
    } catch (e) { setMine((m) => ({ ...m, loaded: true, busy: false, err: describeError(e) })); }
  }, []);
  const loadChecks = useCallback(async () => {
    const remembered = (known: Set<string>): CheckRow[] => rememberedChecks().filter((x) => !known.has(x.requestId)).map((x) => ({ requestId: x.requestId, clientRequestId: "", state: "NOT_UNDER_THIS_SESSION", createdAt: x.createdAt, updatedAt: x.createdAt, intentDigest: "", subject: x.subject ?? "", orderId: null, valueNativeAtomic: x.valueNativeAtomic ?? "0", reportDigest: null, payment: null, passportAvailable: false }));
    const current = storedSession(); setSession(current);
    if (!current) { setChecks((c) => ({ ...c, rows: remembered(new Set()), busy: false, loaded: true, err: null })); return; }
    setChecks((c) => ({ ...c, busy: true, err: null }));
    try {
      const r = await withSession((t) => api.requests(t));
      setSession(storedSession());
      setChecks((c) => ({ ...c, rows: [...r.requests, ...remembered(new Set(r.requests.map((x) => x.requestId)))], busy: false, err: null, loaded: true }));
    } catch (e) { setChecks((c) => ({ ...c, busy: false, err: describeError(e), loaded: true })); }
  }, []);
  const refreshOrder = useCallback(async (id?: string) => {
    const oid = id ?? order?.orderId; if (!oid) return;
    try { const o = await withSession((t) => api.order(oid, t)); setOrder((cur) => (!cur || cur.orderId.toLowerCase() === o.orderId.toLowerCase() ? o : cur)); } catch { /* keep what we have; the card says what was read */ }
  }, [order?.orderId]);
  /** everything that belongs to one payer's workflow leaves the screen (the server records stay; My workflow lists them) */
  const resetVisible = () => { setOrder(null); setOrderMeta({ baselineDigest: null, proxy: null }); setApproved(false); setUnitMistake(false); setCheck(null); setAttempt(null); setExec(IDLE); setPassport(null); setVerification(null); setOpenSteps({}); setErr(null); };
  // the saved workflow of THIS wallet on this instance: order, check (exact quoted intent), attempt — re-read from the server, never trusted blindly.
  // A different connected account never inherits another account's order, check or attempt: the view resets to step 1 and reads that account's own entry.
  useEffect(() => {
    if (!net?.chainId || !account) return;
    const key = `${net.chainId}:${account.toLowerCase()}`;
    if (hydrated.current === key) return;
    const switching = hydrated.current !== null; hydrated.current = key; owner.current = null;
    if (switching) resetVisible();
    const saved = loadWorkflow(account);
    if (!saved) { owner.current = account.toLowerCase(); void loadMine(); void loadChecks(); return; }
    hydrating.current = key;
    let alive = true;
    (async () => {
      try {
        const o = await withSession((t) => api.order(saved.orderId, t));
        if (!alive) return;
        if (!same(o.payer, account)) return; // never show another payer's order as this account's
        setOrder(o); setOrderMeta({ baselineDigest: saved.baselineDigest ?? baselineDigestFor(netRef.current, o.proxy), proxy: o.proxy }); setApproved(saved.approved);
        if (saved.requestId && saved.intent) {
          const r = await withSession((t) => api.request(saved.requestId!, t)).catch(() => null);
          if (!alive) return;
          const d: Delivered | null = r?.delivery === "DELIVERED" && r.report ? { report: r.report, digest: r.reportDigest, simulation: r.simulation, serviceFeeTx: r.payment?.transaction ?? null, requestId: saved.requestId } : null;
          setCheck({ intent: saved.intent, requestId: saved.requestId, quote: null, delivered: d });
        }
        if (saved.attemptId) {
          const a = await withSession((t) => api.attempt(saved.attemptId!, t)).catch(() => null);
          if (alive && a && same(a.payer, account)) {
            const restoredUncertain = isUncertain(a);
            setAttempt(a); setExec({ ...IDLE, phase: isTerminal(a.state) ? "done" : restoredUncertain ? "uncertain" : "idle", txHash: a.txHash });
            // §10 item 1: a refresh restores the uncertainty, not an idle attempt — recover once, then observe; nothing is offered to the wallet
            if (restoredUncertain) void reconcileUncertain(a);
          }
        }
      } catch (e) { if (alive) setErr(describeError(e)); }
      finally { if (hydrating.current === key) hydrating.current = null; if (alive) { owner.current = account.toLowerCase(); void loadMine(); void loadChecks(); } }
    })();
    return () => { alive = false; };
  }, [net?.chainId, account, loadMine, loadChecks]); // eslint-disable-line react-hooks/exhaustive-deps
  // persist the identity of the workflow (ids and the exact quoted intent) under its payer — never while the saved one is still being read back, never under another account
  useEffect(() => {
    if (!order || !account || hydrating.current || owner.current !== account.toLowerCase() || !same(order.payer, account)) return;
    saveWorkflow({ payer: account, orderId: order.orderId, proxy: orderMeta.proxy, baselineDigest: orderMeta.baselineDigest, approved, requestId: check?.requestId ?? null, intent: check?.intent ?? null, attemptId: attempt?.attemptId ?? null, handoff: null });
  }, [order?.orderId, orderMeta, approved, check?.requestId, check?.intent, attempt?.attemptId, account]); // eslint-disable-line react-hooks/exhaustive-deps
  // a creation that is not confirmed is re-read until it is CONFIRMED, FAILED or UNKNOWN_CREATION (bounded; refresh and Recover stay available)
  useEffect(() => {
    if (!order || !creationUnconfirmed(order)) return;
    const id = order.orderId; const since = Date.now();
    const timer = setInterval(() => { if (Date.now() - since > ORDER_POLL_LIMIT_MS) { clearInterval(timer); return; } void refreshOrder(id); }, ORDER_POLL_MS);
    return () => clearInterval(timer);
  }, [order?.orderId, order?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // the clock drives quote expiry, report freshness and the validation window
  useEffect(() => {
    if (!check?.quote && !delivered && !attemptOpen) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [check?.quote, delivered, attemptOpen]);
  // the referenced approval, re-read every 5 s while a report is on screen (a revocation flips the decision)
  useEffect(() => {
    const digest = orderMeta.baselineDigest;
    if (!digest) { setBaselineRead({ digest: null, record: null, outcome: "none", error: null }); return; }
    // a new digest starts a fresh read (nothing stands in for it meanwhile); the same digest keeps its record while it is re-read — the
    // re-read that follows a purchase used to clear it, and the page decided "review required" from the gap (2026-10-09)
    setBaselineRead((b) => (b.digest === digest ? b : { digest, record: null, outcome: "loading", error: null }));
    let alive = true; let request = 0;
    const refresh = () => { const current = ++request; return withSession((t) => approvedBaseline(digest, t))
      .then((b) => { if (alive && current === request) setBaselineRead({ digest, record: b, outcome: "loaded", error: null }); })
      .catch((e) => { if (!alive || current !== request) return;
        if (e instanceof ApiError && e.status === 404) setBaselineRead({ digest, record: null, outcome: "missing", error: null }); // a definitive answer: no approved baseline
        else setBaselineRead((prev) => (prev.digest === digest ? { ...prev, error: describeError(e) } : { digest, record: null, outcome: "loading", error: describeError(e) })); }); }; // the completed result stands; only the error is new
    refresh();
    const timer = delivered ? setInterval(refresh, 5000) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [orderMeta.baselineDigest, delivered]);

  // ---- actions
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(null); try { await fn(); } catch (e: any) { setErr(describeError(e)); } finally { setBusy(null); setSession(storedSession()); } };
  const rowAction = async (id: string, fn: () => Promise<void>) => { setMine((m) => ({ ...m, rowBusy: id, rowErr: null })); try { await fn(); setMine((m) => ({ ...m, rowBusy: null })); } catch (e) { setMine((m) => ({ ...m, rowBusy: null, rowErr: describeError(e) })); } };
  const resetAll = () => { clearWorkflow(account); resetVisible(); };
  const createOrder = (body: OrderBody) => withSession((t) => api.createOrder(body, t));
  /** 201 (confirmed), 202 (identity recorded, creation not confirmed) or a 502 that names the order: the card shows that order — never "nothing was changed" */
  const onCreated = (o: OrderAnswer) => {
    const view = orderViewFromCreated(o);
    setDialog(false); setOrder(view); setOrderMeta({ baselineDigest: ("baselineDigest" in o ? o.baselineDigest : null) ?? baselineDigestFor(net, view.proxy), proxy: view.proxy });
    setApproved(false); setCheck(null); setAttempt(null); setExec(IDLE); setPassport(null); setVerification(null); setOpenSteps({}); setErr(null);
    setSession(storedSession());
    void refreshOrder(view.orderId); void loadMine();
  };
  /** owner-only bounded reconciliation of an unconfirmed creation (may hand the node the same signed transaction again; never a second order) */
  const adoptOrder = (o: OrderView) => { setOrder((cur) => (cur && same(cur.orderId, o.orderId) ? o : cur)); setMine((m) => ({ ...m, orders: m.orders.map((x) => (same(x.orderId, o.orderId) ? o : x)) })); };
  const recoverOrder = (id: string) => run("recover-order", async () => adoptOrder(await withSession((t) => api.recoverOrder(id, t))));
  const recoverOrderRow = (id: string) => rowAction(id, async () => adoptOrder(await withSession((t) => api.recoverOrder(id, t))));
  const approve = () => { if (orderConfirmed) setApproved(true); };
  const getQuote = () => run("quote", async () => {
    if (!devOrder || !policy || !account || !net) return;
    const id = ++quoteSeq.current; const draft = developerIntent(net.chainId, account, devOrder, policy, unitMistake);
    setCheck(null); setAttempt(null); setExec(IDLE); setPassport(null); setVerification(null);
    const result = await withSession((t) => prepareOrderQuote(draft, devOrder.block, t, { isCurrent: () => quoteSeq.current === id }));
    setNow(Date.now()); setCheck({ intent: result.intent, requestId: result.response.requestId, quote: result, delivered: null });
  });
  const buy = () => run("buy", async () => {
    if (!w.provider || !account || !net || !check?.quote || !devOrder) return;
    if (check.delivered) throw new Error("This quote was already purchased; request a new quote for a fresh report.");
    if (!onArc || !quoteReady(check.quote, devOrder.block)) throw new Error("Quote is stale or expired; request a new quote before signing.");
    if (budgetBuy.enough === false) throw new Error(`Not enough USDC in your wallet: ${budgetBuy.sentence}.`);
    // the same helpers the Live Demo's wallet check uses (lib/walletRun.ts): one EIP-3009 authorization for exactly the quote, then the purchase
    const payment = await signFeeAuthorization(w.provider, account, net, check.quote);
    if (!quoteReady(check.quote, devOrder.block)) throw new Error("The quote expired during signing; request a new quote.");
    let d: Delivered;
    try { d = await withSession((t) => purchaseReport(check.quote!, t, payment)); } finally { void loadChecks(); }
    setCheck((c) => (c && c.requestId === d.requestId ? { ...c, delivered: d } : c));
    void refreshOrder();
  });
  const onExecEvent = (e: { phase: ExecutePhase; attempt: AttemptView | null; txHash?: string | null; refusal?: Refusal | null; error?: Described | null }) => {
    setExec((x) => ({ phase: e.phase, txHash: e.txHash ?? x.txHash, refusal: e.refusal ?? (e.phase === "refused" ? x.refusal : null), err: e.error ?? null }));
    if (e.attempt) setAttempt(e.attempt);
  };
  const execute = () => {
    if (executionInFlight() || busy) return; // a double click joins nothing: one execution at a time
    return run("execute", async () => {
      if (!w.provider || !account || !check || !delivered || !order || !policy) return;
      if (budgetExec.enough === false) throw new Error(`Not enough USDC in your wallet: ${budgetExec.sentence}.`);
      setExec({ phase: "validating", txHash: null, refusal: null, err: null }); setPassport(null); setVerification(null);
      const ev = await executeAttempt({ provider: w.provider, account, requestId: check.requestId, orderId: order.orderId, policy, withToken: withSession, onEvent: onExecEvent });
      if (ev.attempt) setAttempt(ev.attempt);
      void refreshOrder(); void loadMine();
    });
  };
  const resume = (a: AttemptView) => {
    if (executionInFlight() || busy) return;
    return run("execute", async () => {
      if (!w.provider || !account) return;
      setAttempt(a); setExec({ phase: "prompting", txHash: null, refusal: null, err: null });
      const ev = await sendValidatedAttempt({ provider: w.provider, account, attempt: a, withToken: withSession, onEvent: onExecEvent });
      if (ev.attempt) setAttempt(ev.attempt);
      void refreshOrder(); void loadMine();
    });
  };
  /** §10 item 1: a restored VALIDATED attempt with a prompt marker — recover once, then observe (the server reads the chain for such attempts); never a prompt */
  const reconcileUncertain = (a: AttemptView) => {
    if (executionInFlight()) return;
    return run("execute", async () => {
      setAttempt(a); setExec({ phase: "uncertain", txHash: a.txHash, refusal: null, err: null });
      const ev = await reconcileUncertainAttempt({ attempt: a, withToken: withSession, onEvent: onExecEvent });
      if (ev.attempt) setAttempt(ev.attempt);
      void refreshOrder(a.orderId); void loadMine();
    });
  };
  const adopt = (a: AttemptView) => {
    setAttempt((cur) => (!cur || cur.attemptId === a.attemptId ? a : cur));
    setMine((m) => ({ ...m, attempts: m.attempts.map((x) => (x.attemptId === a.attemptId ? { ...x, ...a } : x)) }));
    // an attempt still VALIDATED after an unexplained wallet answer keeps that status, and one with a prompt marker stays uncertain: no second prompt is offered until it closes or the visitor abandons it
    setExec((x) => (attempt && attempt.attemptId !== a.attemptId ? x : { ...x, phase: isTerminal(a.state) ? "done" : x.phase === "unresolved" ? "unresolved" : x.phase === "unknown-submission" ? "unknown-submission" : x.phase === "uncertain" || isUncertain(a) ? "uncertain" : "idle", err: x.phase === "unknown-submission" && !isTerminal(a.state) ? x.err : null }));
    void refreshOrder(a.orderId);
  };
  const abandon = (id: string) => rowAction(id, async () => adopt(await withSession((t) => api.attemptAbandon(id, t))));
  const recover = (id: string) => rowAction(id, async () => adopt(await withSession((t) => api.attemptRecover(id, t))));
  const observe = (id: string) => rowAction(id, async () => adopt(await withSession((t) => api.attempt(id, t))));
  /** make a listed attempt (or one remembered by this browser) the current one — the order follows it; only for this account's own attempts */
  const pick = (id: string) => rowAction(id, async () => {
    const full = await withSession((t) => api.attempt(id, t));
    if (!same(full.payer, account)) throw new Error(`This attempt belongs to wallet ${short(full.payer, 4)}; connect that wallet to continue it. It stays listed under "other wallets in this browser".`);
    const pickedUncertain = isUncertain(full);
    setAttempt(full); setExec({ phase: isTerminal(full.state) ? "done" : pickedUncertain ? "uncertain" : "idle", txHash: full.txHash, refusal: null, err: null }); setPassport(null); setVerification(null); setOpenSteps({});
    if (!order || order.orderId.toLowerCase() !== full.orderId.toLowerCase()) {
      const o = await withSession((t) => api.order(full.orderId, t));
      setOrder(o); setOrderMeta({ baselineDigest: baselineDigestFor(net, o.proxy), proxy: o.proxy }); setApproved(true); setCheck(null);
    }
    if (pickedUncertain) void reconcileUncertain(full); // §10 item 1: listed or remembered, an attempt whose prompt was opened is reconciled, never handed to the wallet again
  });
  const pickOrder = (o: OrderView) => { if (!same(o.payer, account)) return; setOrder(o); setOrderMeta({ baselineDigest: baselineDigestFor(net, o.proxy), proxy: o.proxy }); setApproved(false); setCheck(null); setAttempt(null); setExec(IDLE); setPassport(null); setVerification(null); setOpenSteps({}); };
  const download = () => run("passport", async () => {
    if (attempt && attempt.passportAvailable) { const { __status: _s, ...bundle } = (await withSession((t) => api.attemptPassport(attempt.attemptId, t))) as any; const name = `arcpreflight-wallet-passport-${attempt.attemptId.slice(0, 8)}.json`; saveJson(name, bundle); setPassport({ bundle, name, kind: "attempt" }); setVerification(null); return; }
    if (check?.delivered) { const { __status: _s, ...bundle } = (await withSession((t) => api.requestPassport(check.requestId, t))) as any; const name = `arcpreflight-check-passport-${check.requestId.slice(0, 8)}.json`; saveJson(name, bundle); setPassport({ bundle, name, kind: "check" }); setVerification(null); }
  });
  // my checks (fee history) rows
  const checkRow = async (id: string, fn: () => Promise<void>) => { setChecks((c) => ({ ...c, rowBusy: id, rowErr: null })); try { await fn(); setChecks((c) => ({ ...c, rowBusy: null })); } catch (e) { setChecks((c) => ({ ...c, rowBusy: null, rowErr: describeError(e) })); } };
  const patchRow = (id: string, r: any) => setChecks((c) => ({ ...c, rows: c.rows.map((row) => (row.requestId === id ? foldRequest(row, r) : row)) }));
  const refreshRow = (id: string) => checkRow(id, async () => patchRow(id, await withSession((t) => api.request(id, t))));
  const recoverRow = (id: string) => checkRow(id, async () => patchRow(id, await withSession((t) => api.recoverRequest(id, t))));
  const passportRow = (id: string) => checkRow(id, async () => { const { __status: _s, ...bundle } = (await withSession((t) => api.requestPassport(id, t))) as any; saveJson(`arcpreflight-check-passport-${id.slice(0, 8)}.json`, bundle); });

  const anchors = useMemo(() => ({ baselineDigests: orderMeta.baselineDigest ? [orderMeta.baselineDigest] : [], policyDigests: pDigest ? [pDigest] : [] }), [orderMeta.baselineDigest, pDigest]);
  const proxyFixture = fixtureForProxy(net, orderMeta.proxy);
  const implChanged = !!proxyFixture?.approvedImplementation && !!proxyFixture?.implementation && proxyFixture.approvedImplementation.toLowerCase() !== proxyFixture.implementation.toLowerCase();
  const listedIds = new Set(mine.attempts.map((a) => a.attemptId));
  const remembered = rememberedAttempts().filter((a) => !listedIds.has(a.attemptId));
  // the session owns every order and attempt made in this browser; only the connected account's own are this workflow's — the rest is listed read-only
  const myAttempts = mine.attempts.filter((a) => same(a.payer, account)), otherAttempts = mine.attempts.filter((a) => !same(a.payer, account));
  const myOrders = mine.orders.filter((o) => same(o.payer, account)), otherOrders = mine.orders.filter((o) => !same(o.payer, account));
  const otherSaved = loadWorkflows().filter((s) => !same(s.payer, account));
  const passportSource = attempt?.passportAvailable ? "attempt" : check?.delivered ? "check" : null;
  const execDisabledWhy = gated ? "execution is gated on this instance" : !orderConfirmed ? "the order's creation is not confirmed" : deciding ? "the referenced approval is being read — the decision follows" : !executable ? (expired ? "the report expired — re-run the check (a new quote and fee)" : decision ? `the decision is ${decision.decision}` : "run the preflight check first") : !onArc ? `switch your wallet to ${netLabel}` : budgetExec.enough === false ? budgetExec.sentence! : attemptOpen ? "an attempt is already open: continue, abandon or recover it" : executing ? "in progress" : busy ? "busy" : "";
  const faucetRequired = stage >= 4 ? budgetExec.required : budgetBuy.required;
  const faucetStep = stage >= 4 ? "executing the payment" : stage === 3 ? "buying the report" : "the first paid step (report + order + gas)";
  const faucetNeeds = budgetComponents({ feePaid: stage >= 4 && !!delivered }).long;
  // the dialog refuses another order while this wallet's latest order is still unconfirmed (the view on screen is the freshest copy of it)
  const latestMine = (() => { const byId = new Map(myOrders.map((o) => [o.orderId.toLowerCase(), o])); if (order && same(order.payer, account)) byId.set(order.orderId.toLowerCase(), order); return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ?? null; })();
  const unconfirmedLatest = latestMine && creationUnconfirmed(latestMine) ? { orderId: latestMine.orderId } : null;

  return (
    <section className="section">
      <div className="container stack" style={{ gap: 18 }}>
        <div className="row between" style={{ alignItems: "end", gap: 16 }}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="kicker">Developer workflow · {netLabel} · try with my wallet</div>
            <h2>Your wallet. <em>The whole lifecycle.</em></h2>
            <p className="muted small" style={{ maxWidth: 760 }}>Seven steps with your own wallet: order → approval → check → execute → recover → passport → verify. You pay the check fee, the order amount and your gas{net?.network === "testnet" ? " — testnet USDC from the faucet" : ""}.</p>
          </div>
          {order && <button className="btn sm ghost" onClick={resetAll} title="forget this browser's workflow identity for this wallet; the server records stay in My workflow">start over</button>}
        </div>
        <Lifecycle stages={stages} onPick={jump} />
        {TEST_WALLET_BUILD && testWallet && <div className="banner">Self-test build: a local test wallet is injected as <code>window.ethereum</code>. Open with <code>?testwallet=off</code> to use a real wallet.</div>}

        {/* gates: the instance, the wallet, the chain */}
        {net && !fixturesDeployed && <div className="banner" role="status">{describeBody({ error: "DEMO_UNAVAILABLE", reason: `fixtures are not deployed on ${netLabel}` }).text} Orders, checks and execution live on the testnet instance.{otherTestnet && <> <button className="btn sm" onClick={() => select("testnet")}>switch to Arc testnet</button></>}</div>}
        {net && fixturesDeployed && gated && <div className="banner info" role="status">Execution is gated on this instance until the mainnet acceptance is recorded. Orders, checks, My workflow, passports and verification work here.{otherTestnet && <> <button className="btn sm" onClick={() => select("testnet")}>use the testnet instance to execute</button></>}</div>}
        <div className="panel soft row between" style={{ gap: 14, alignItems: "center" }}>
          {!account ? (<>
            <div className="stack" style={{ gap: 2 }}><b>Connect a wallet to start.</b><span className="small muted">MetaMask, OKX Wallet, Rabby, Coinbase Wallet, Brave… Connecting is read-only; you sign only where a step says so.</span></div>
            <button className="btn primary" onClick={() => w.connect()} disabled={w.connecting}>{w.connecting ? <Spinner /> : "Connect wallet"}</button>
          </>) : (
            <div className="stack" style={{ gap: 6, width: "100%" }}>
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <Hex value={account} n={6} link={explorerAddr(net, account)} />{w.isTest && <Chip tone="warn">test wallet</Chip>}{w.info && <span className="tiny dim">{w.info.name}</span>}
                {onArc ? <Chip tone="ok">{netLabel} · {w.chainId}</Chip> : <><Chip tone="warn">chain {w.chainId ?? "?"}</Chip><button className="btn sm" onClick={() => net && w.switchChain(net)}>Switch to {netLabel} ({net?.chainId})</button></>}
                <span className="small muted" title="one balance, two faces: the 18-decimal native USDC pays gas and the order; the ERC-20 face shows 6 decimals">USDC {bal.native !== null ? usdcNative(bal.native, 4) : "…"} <span className="tiny dim">· ERC-20 face {bal.erc20 !== null ? usdcToken(bal.erc20) : "…"}</span></span>
                <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => void w.disconnect()}>disconnect</button>
              </div>
              <p className="tiny dim" role="note">{session ? <>session <code>{session.principal}</code></> : <>no session yet — the first paid action creates one</>} · your browser holds an anonymous session that owns your orders, checks and attempts; clearing site data loses it · other accounts' items stay listed under My workflow</p>
              {stage <= 2 && <FaucetCard net={net} wallet={w} balance={bal.native} required={faucetRequired} step={faucetStep} needs={faucetNeeds} onClaimed={refreshBal} />}
            </div>
          )}
        </div>
        {w.error && <div className="banner bad" role="alert">{w.error}</div>}
        <ErrorBanner err={err} />

        <div className="wsteps">
          {/* 1 · order */}
          <StepSection n={1} id="step-1" title="Create order" status={stages[0].status} open={isStepOpen(1)} onToggle={() => toggle(1)}
            summary={order && <>order <Hex value={order.orderId} n={5} /> · {nativeAtomicToUsdcText(order.amountNativeAtomic)} USDC{order.tx && <> · tx <Hex value={order.tx} n={4} link={explorerTx(net, order.tx)} /></>} · <Chip tone={paymentLabel(order).tone}>{paymentLabel(order).text}</Chip>{!orderConfirmed && <> · <Chip tone={orderPending ? "warn" : "bad"}>{orderPending ? "creation not confirmed" : order.state.toLowerCase().replace(/_/g, " ")}</Chip></>}</>}>
            {!order ? (<>
              <p className="small muted">A <b>demonstration order</b> on the project's DemoMerchant — nothing is delivered. Payable only by your wallet, {nativeAtomicToUsdcText(limits.minNativeAtomic)}–{nativeAtomicToUsdcText(limits.maxNativeAtomic)} USDC, optional reference.</p>
              <p className="small muted">{adminInProcess
                ? <>Created with the <code>deployer-admin</code> key <Chip tone="warn">admin key in process</Chip> — a fallback the release target does not use.</>
                : <>Created by the merchant's <code>order-creator</code> role — a key that can only create orders, never upgrade, pause or withdraw.</>}</p>
              <details className="why"><summary className="tiny">why an order first</summary><p className="small muted">You get a pinned report, the payment outcome read from the chain and a verifiable passport. The order's identity is recorded before its creation transaction is sent; the operator pays that gas.</p></details>
              <div className="row"><button className="btn primary" disabled={!account || !onArc || !fixturesDeployed || !!busy || gated} title={gated ? ORDER_GATED_TEXT : undefined} onClick={() => setDialog(true)}>Create order…</button>{gated ? <span className="tiny dim" data-testid="order-gated">{ORDER_GATED_TEXT}</span> : myOrders.length > 0 && <span className="tiny dim">or pick one of your {myOrders.length} orders in step 5</span>}</div>
            </>) : (<>
              <OrderCard order={order} net={net} feeTokenAtomic={net?.priceTokenAtomic ?? null} onRefresh={() => void refreshOrder()} onRecover={orderPending ? () => void recoverOrder(order.orderId) : undefined} busy={!!busy} />
              {orderStopped && <div className="row" style={{ gap: 10, alignItems: "center" }}><button className="btn primary" disabled={!account || !onArc || !fixturesDeployed || !!busy || gated} title={gated ? ORDER_GATED_TEXT : undefined} onClick={() => setDialog(true)}>Create a new order…</button><span className="tiny dim">this order stays listed in My workflow</span></div>}
            </>)}
          </StepSection>

          {/* 2 · review & approve */}
          <StepSection n={2} id="step-2" title="Review & approve" status={stages[1].status} open={isStepOpen(2)} onToggle={() => toggle(2)}
            summary={order && <>approval {orderMeta.baselineDigest ? <Hex value={orderMeta.baselineDigest} n={5} /> : <Chip tone="warn">none</Chip>} · policy {pDigest ? <Hex value={pDigest} n={5} /> : "—"} · window {WALLET_VALIDATION_WINDOW_SECONDS} s{approved && <Chip tone="ok">approved</Chip>}</>}>
            {!order || !orderConfirmed ? <p className="dim small" data-testid="approve-closed">{!order ? "create an order first" : orderPending ? "the order's creation is not confirmed yet — approval opens once its receipt confirms it" : "this order's creation was not established — create a new order in step 1"}</p> : (<>
              <div className="two" style={{ gap: 24 }}>
                <div className="kv w150">
                  <span className="k">referenced approval</span><span>{orderMeta.baselineDigest ? <Hex value={orderMeta.baselineDigest} n={8} /> : <Chip tone="warn">no baseline on this proxy</Chip>}{baseline && <span className="tiny dim"> · approved by {baseline.baseline.approvedBy} · {baseline.revoked ? <Chip tone="bad">revoked</Chip> : <Chip tone="ok">not revoked</Chip>}</span>}</span>
                  <span className="k">approved implementation</span><span>{proxyFixture?.approvedImplementation ? <Hex value={proxyFixture.approvedImplementation} n={5} link={explorerAddr(net, proxyFixture.approvedImplementation)} /> : "—"}</span>
                  <span className="k">current implementation</span><span>{proxyFixture?.implementation ? <><Hex value={proxyFixture.implementation} n={5} link={explorerAddr(net, proxyFixture.implementation)} /> <Chip tone={implChanged ? "warn" : "ok"}>{implChanged ? "changed since approval → review required" : "as approved"}</Chip></> : "—"}</span>
                  <span className="k">merchant · proxy</span><span><Hex value={order.merchant} n={5} link={explorerAddr(net, order.merchant)} /> · {orderMeta.proxy ?? "?"}</span>
                </div>
                <div className="kv w150">
                  <span className="k">your policy</span><span className="small">sender = your wallet · target = this merchant · selector <code>pay(bytes32)</code> · max payment {nativeAtomicToUsdcText(order.amountNativeAtomic)} USDC · max check fee 0.01 USDC · max gas 0.002 USDC</span>
                  <span className="k">freshness</span><span className="small" title="the service re-reads the critical state at a fresh block before anything is sent">report usable {Math.round(WALLET_REPORT_AGE_SECONDS / 60)} min after its pinned observation · validation window {WALLET_VALIDATION_WINDOW_SECONDS} s after you press execute</span>
                  <span className="k">required signals</span><span className="small">PROXY_TEMPLATE_VERIFIED · SUPPORTED_STATE_ORDER_PAYABLE · CALL_SIMULATION</span>
                  <span className="k">on unknown · on change</span><span className="small">REVIEW_REQUIRED · REVIEW_REQUIRED · type-2 only · no authorization list</span>
                  <span className="k">policyDigest</span><span>{pDigest ? <Hex value={pDigest} n={8} /> : "—"} <span className="tiny dim">checked by the server when it validates your attempt</span></span>
                </div>
              </div>
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <button className="btn primary" disabled={approved || !orderConfirmed} onClick={approve}>{approved ? "Approved ✓" : "Approve & continue"}</button>
                <span className="tiny dim">no server call — records your conscious approval of what will be checked and executed</span>
                <details style={{ marginLeft: "auto" }}><summary className="tiny">policy JSON</summary><pre className="json">{JSON.stringify(policy, null, 2)}</pre></details>
              </div>
            </>)}
          </StepSection>

          {/* 3 · preflight check */}
          <StepSection n={3} id="step-3" title="Preflight check" status={stages[2].status} open={isStepOpen(3)} onToggle={() => toggle(3)}
            summary={(delivered || attempt) && <>{attempt ? <DecisionBadge decision={attempt.decision} size="sm" /> : deciding ? <span className="tiny dim"><Spinner /> reading the referenced approval…</span> : decision ? <DecisionBadge decision={decision.decision} size="sm" /> : null}{delivered?.serviceFeeTx && <> · fee <Hex value={delivered.serviceFeeTx} n={4} link={explorerTx(net, delivered.serviceFeeTx)} /></>}{check && <> · request <code>{check.requestId.slice(0, 8)}</code></>}</>}>
            {!approved || !orderConfirmed ? <p className="dim small">{order && !orderConfirmed ? "the order's creation is not confirmed — nothing can be checked yet" : "approve the policy first"}</p> : (<>
              <div className="row between" style={{ gap: 10 }}>
                <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={unitMistake} disabled={!!busy} onChange={(e) => { setUnitMistake(e.target.checked); setCheck(null); setAttempt(null); setExec(IDLE); }} /> encode the value in 6-decimal units — the classic Arc mistake → BLOCKED</label>
                <span className="tiny dim">quote free · report {net ? usdcToken(net.priceTokenAtomic) : "0.01 USDC"} with one EIP-3009 signature from your wallet · a 402 in the console is the x402 price quote, not an error</span>
              </div>
              <div className="row">
                <button className="btn" disabled={!devOrder || !orderConfirmed || !!busy || !onArc} onClick={getQuote}>{busy === "quote" ? <Spinner /> : "Get quote (HTTP 402)"}</button>
                <button className="btn primary" disabled={!canBuy} title={budgetBuy.enough === false ? budgetBuy.sentence! : undefined} onClick={buy}>{busy === "buy" ? <><Spinner /> settling…</> : "Sign TransferWithAuthorization & buy"}</button>
                {budgetBuy.enough === false && !delivered && <span className="tiny" style={{ color: "var(--amber)" }} role="status" data-testid="budget-buy">{budgetBuy.sentence}</span>}
              </div>
              {stage === 3 && <FaucetCard net={net} wallet={w} balance={bal.native} required={budgetBuy.required} step="buying the report" onClaimed={refreshBal} />}
              {check?.quote && <div className="small muted">quote {usdcToken(check.quote.response.quote.amountTokenAtomic)} → payTo <Hex value={check.quote.response.quote.payTo} n={5} /> · report pinned at #{check.quote.response.pinnedBlock} · expires {utc(check.quote.response.quote.expiresAt)} · request <code>{check.requestId}</code>{delivered ? " · purchased" : !quoteOk && " · expired; request a new quote"}</div>}
              {delivered && (<>
                <div className="small muted">fee settled by the project's relayer: {delivered.serviceFeeTx ? <Hex value={delivered.serviceFeeTx} link={explorerTx(net, delivered.serviceFeeTx)} /> : "—"} · digest recomputed here, bound to your intent ✓ · pinned #{delivered.report.observation.blockNumber}{freshLeft !== null && <> · <Chip tone={freshLeft > 60 ? "info" : "warn"}>{freshLeft > 0 ? `usable for ${Math.floor(freshLeft / 60)}:${String(freshLeft % 60).padStart(2, "0")}` : "report expired — get a new quote and buy again"}</Chip></>}</div>
                {deciding && <div className="row small muted" role="status" data-testid="decision-pending" style={{ gap: 8, alignItems: "center" }}><Spinner /> reading the referenced approval before deciding — the decision and the next step appear together once it is read{baselineRead.error ? <> · the read failed ({baselineRead.error.text}); retrying every 5 s</> : null}</div>}
                {baselineRereadFailed && <div className="tiny" style={{ color: "var(--amber)" }} role="status" data-testid="baseline-reread-failed">the referenced approval could not be re-read ({baselineRead.error?.text}); the decision below is from the last completed read{baselineRead.outcome === "missing" ? " (no approved baseline)" : ""} · retrying every 5 s</div>}
                {decision && !attempt && (
                  <div className="two" style={{ gap: 20 }}>
                    <div className="stack" style={{ gap: 8 }}>
                      <DecisionBadge decision={decision.decision} />
                      {decision.reasons.length > 0 && <ul className="list small">{decision.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                      <details className="why"><summary className="tiny">how this was decided</summary><p className="tiny dim">deterministic policy from <code>@arcpreflight/policy</code>, run in this browser from the delivered bytes: hard violations block; unapproved change or unknowns require review; otherwise "no configured check fired" — never "safe"</p></details>
                    </div>
                    <div className="tablewrap fit"><table className="t"><tbody>{decision.checks.map((c) => <tr key={c.id}><td className="mono small">{c.id}</td><td className="fit"><Chip tone={decisionTone(c.outcome)}>{c.outcome}</Chip></td></tr>)}</tbody></table></div>
                  </div>
                )}
                {attempt && (
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 10, alignItems: "baseline" }}><DecisionBadge decision={attempt.decision} /><span className="tiny dim">recorded for attempt <code>{attempt.attemptId.slice(0, 8)}</code> at validation (server-side, same function)</span></div>
                    {attempt.decisionReasons.length > 0 && <ul className="list small">{attempt.decisionReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                    {decision && decision.decision !== attempt.decision && <details><summary className="tiny">re-evaluated now: {decision.decision.replace(/_/g, " ").toLowerCase()} — the report aged past {policy?.maxReportAgeSeconds ?? 60} s; a new payment needs a new check</summary><ul className="list small">{decision.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}
                  </div>
                )}
                <details><summary className="small">the pinned report</summary><div style={{ marginTop: 8 }}><ReportView report={delivered.report} digest={delivered.digest} net={net} compact /></div></details>
              </>)}
              {!delivered && attempt && <p className="small muted">this attempt's check decided <Chip tone={decisionTone(attempt.decision)}>{attempt.decision}</Chip> (request <code>{attempt.requestId.slice(0, 8)}</code>); run a new check for a fresh report</p>}
            </>)}
          </StepSection>

          {/* 4 · execute */}
          <StepSection n={4} id="step-4" title="Execute with your wallet" status={stages[3].status} open={isStepOpen(4)} onToggle={() => toggle(4)}
            summary={attempt && <><Chip tone={stateTone(attempt.state)}>{attempt.state.replace(/_/g, " ").toLowerCase()}</Chip>{(attempt.businessTxHash ?? attempt.txHash) && <> · tx <Hex value={attempt.businessTxHash ?? attempt.txHash!} n={4} link={explorerTx(net, attempt.businessTxHash ?? attempt.txHash!)} /></>}{attempt.businessStatus && <> · order {attempt.businessStatus === "SUCCESS" ? "paid" : attempt.businessStatus.toLowerCase().replace(/_/g, " ")}</>}{ambiguous && <> · <Chip tone="warn">{exec.phase === "unknown-submission" ? "wallet answer unexplained" : "submission uncertain"}</Chip></>}</>}>
            {gated ? <div className="banner info">Gated on this instance — execution opens after the mainnet acceptance. {otherTestnet ? <button className="btn sm" onClick={() => select("testnet")}>use the testnet instance</button> : null} Everything else in this workflow works here.</div> : (<>
              <p className="small muted">The service validates your exact plan at a fresh pinned block and records the attempt <code>VALIDATED</code> <em>before</em> your wallet is asked. Your wallet signs exactly that plan; the outcome is read from the receipt and the order state. Window {WALLET_VALIDATION_WINDOW_SECONDS} s.</p>
              <details className="why"><summary className="tiny">what is re-checked before the prompt</summary><p className="small muted">Implementation vs the referenced approval, pause, exact-call simulation, balance, fees, nonce, and that your account carries no code. Right before the prompt the page re-reads your account, your chain and the time left; a mismatch stops without prompting. Gas or nonce your wallet sets are recorded as deviations.</p></details>
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <button className="btn primary" disabled={!executable || !onArc || !!busy || executing || attemptOpen || !w.provider || budgetExec.enough === false} title={execDisabledWhy} onClick={execute}>{executing ? <><Spinner /> {exec.phase === "unknown-submission" || exec.phase === "uncertain" ? "reconciling" : exec.phase}…</> : "Execute with your wallet"}</button>
                {checkStopped && <span className="small muted">nothing to execute: the check decided <code>{decision?.decision ?? attempt?.decision}</code></span>}
                {executable && !attemptOpen && !executing && freshLeft !== null && budgetExec.enough !== false && <span className="tiny dim">execute within {Math.floor(freshLeft / 60)}:{String(freshLeft % 60).padStart(2, "0")} — then the report ages out and a new check is needed</span>}
                {executable && budgetExec.enough === false && !attemptOpen && <span className="tiny" style={{ color: "var(--amber)" }} role="status" data-testid="budget-exec">{budgetExec.sentence}</span>}
                {!executable && !checkStopped && (!attempt || expired) && execDisabledWhy && <span className="tiny dim">{execDisabledWhy}</span>}
                {expired && <button className="btn sm" disabled={!!busy || !onArc} onClick={() => { jump("check"); getQuote(); }}>Re-run the check ({net ? usdcToken(net.priceTokenAtomic) : "0.01 USDC"})</button>}
              </div>
              {stage === 4 && <FaucetCard net={net} wallet={w} balance={bal.native} required={budgetExec.required} step="executing the payment" needs={budgetComponents({ feePaid: !!delivered }).long} onClaimed={refreshBal} />}
              {(attempt || exec.phase !== "idle") && <AttemptPanel attempt={attempt} phase={exec.phase} txHash={exec.txHash} refusal={exec.refusal} err={exec.err} net={net} busy={busy === "execute" || (!!attempt && mine.rowBusy === attempt.attemptId)} now={now} actions={{ onRecover: recover, onAbandon: abandon, onResume: resume, onRefresh: observe }} />}
            </>)}
          </StepSection>

          {/* 5 · recover · my workflow */}
          <StepSection n={5} id="step-5" title="Recover · My workflow" status={stages[4].status} open={isStepOpen(5)} onToggle={() => toggle(5)}
            summary={mine.loaded && <span className="tiny dim">{myAttempts.length} attempt{myAttempts.length === 1 ? "" : "s"} · {myOrders.length} order{myOrders.length === 1 ? "" : "s"} for this wallet{otherAttempts.length + otherOrders.length > 0 ? ` · ${otherAttempts.length + otherOrders.length} from other wallets in this browser` : ""}</span>}
            aside={<button className="btn sm ghost" disabled={mine.busy} onClick={() => { void loadMine(); void loadChecks(); }}>{mine.busy ? <Spinner /> : "refresh"}</button>}>
            <p className="small muted">Recovery reads the hash, the order state and the merchant's <code>OrderPaid</code> event; it never re-signs or re-sends.</p>
            <details className="why"><summary className="tiny">open attempts after a refresh</summary><p className="small muted">An attempt left <code>VALIDATED</code> or <code>BROADCAST_ATTEMPTED</code> is listed here: continue, abandon or recover it. One whose wallet prompt was already opened is reconciled from the order state and never handed to the wallet again; "I rejected it — abandon" is your explicit statement that nothing was signed. The recovery worker does the same every 30 s.</p></details>
            <ErrorBanner err={mine.err} />
            {!session && <p className="dim small">no session yet — the first paid action creates one for this browser</p>}
            {(myAttempts.length > 0 || remembered.length > 0) && (
              <div className="tablewrap"><table className="t attempts" data-testid="my-attempts">
                <thead><tr><th>when (UTC)</th><th>attempt</th><th>state</th><th>transaction</th><th>next action</th><th></th></tr></thead>
                <tbody>
                  {myAttempts.map((a) => (
                    <tr key={a.attemptId} className={attempt?.attemptId === a.attemptId ? "on" : ""}>
                      <td className="when" title={ago(a.createdAt)}>{utc(a.createdAt)}</td>
                      <td><code>{a.attemptId.slice(0, 8)}</code><div className="tiny dim">order <Hex value={a.orderId} n={4} /> · {usdc6(a.amountNativeAtomic)}</div></td>
                      <td><Chip tone={stateTone(a.state)}>{a.state.replace(/_/g, " ").toLowerCase()}</Chip>{a.businessStatus && <div className="tiny dim">order {a.businessStatus === "SUCCESS" ? "paid" : a.businessStatus.toLowerCase().replace(/_/g, " ")}</div>}</td>
                      <td>{(a.businessTxHash ?? a.txHash) ? <Hex value={a.businessTxHash ?? a.txHash!} n={5} link={explorerTx(net, a.businessTxHash ?? a.txHash!)} /> : <span className="dim">none</span>}</td>
                      <td className="small muted" style={{ maxWidth: 260 }}>{a.nextAction}</td>
                      <td className="actions">
                        {attempt?.attemptId !== a.attemptId && <button className="btn sm ghost" disabled={mine.rowBusy === a.attemptId} onClick={() => pick(a.attemptId)}>use</button>}
                        {a.state === "VALIDATED" && <button className="btn sm" disabled={mine.rowBusy === a.attemptId} onClick={() => abandon(a.attemptId)} title={isUncertain(a) ? "records NOT_SENT: only if you know the wallet never signed or broadcast anything" : "records that the prompt was rejected; nothing was sent"}>{isUncertain(a) ? "I rejected it — abandon" : "Abandon"}</button>}
                        {isOpen(a.state) && <button className="btn sm" disabled={mine.rowBusy === a.attemptId} onClick={() => recover(a.attemptId)}>Recover</button>}
                        {a.state === "VALIDATED" && insideWindow(a, now) && attempt?.attemptId === a.attemptId && attempt.plan && !ambiguous && !isUncertain(a) && <button className="btn sm primary" disabled={!!busy} onClick={() => resume(attempt)}>Continue in wallet</button>}
                      </td>
                    </tr>
                  ))}
                  {remembered.map((a) => (
                    <tr key={a.attemptId}><td className="when">{utc(a.createdAt)}</td><td><code>{a.attemptId.slice(0, 8)}</code><div className="tiny dim">order <Hex value={a.orderId} n={4} /></div></td><td><Chip>{String(a.state ?? "remembered").replace(/_/g, " ").toLowerCase()}</Chip><div className="tiny dim">remembered in this browser, not under this session</div></td><td><span className="dim">—</span></td><td className="small muted">reconnect the session that created it</td><td className="actions"><button className="btn sm ghost" disabled={mine.rowBusy === a.attemptId} onClick={() => pick(a.attemptId)}>try</button></td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
            {myOrders.length > 0 && (
              <div className="tablewrap"><table className="t orders" data-testid="my-orders">
                <thead><tr><th>when (UTC)</th><th>order</th><th>amount</th><th>payment</th><th>next action</th><th></th></tr></thead>
                <tbody>{myOrders.map((o) => (
                  <tr key={o.orderId} className={order?.orderId === o.orderId ? "on" : ""}>
                    <td className="when" title={ago(o.createdAt)}>{utc(o.createdAt)}</td>
                    <td><Hex value={o.orderId} n={5} />{o.tx && <> · <Hex value={o.tx} n={4} link={explorerTx(net, o.tx)} /></>}{o.state !== "CONFIRMED" && <> <Chip tone={creationUnconfirmed(o) ? "warn" : "bad"}>{creationUnconfirmed(o) ? "creation not confirmed" : o.state.toLowerCase().replace(/_/g, " ")}</Chip></>}<div className="tiny dim">{o.proxy ?? "?"} · {o.source}{o.reference ? ` · “${o.reference}”` : ""}</div></td>
                    <td className="small">{nativeAtomicToUsdcText(o.amountNativeAtomic)} USDC</td>
                    <td><Chip tone={paymentLabel(o).tone}>{paymentLabel(o).text}</Chip>{o.attempts.length > 0 && <div className="tiny dim">{o.attempts.length} attempt{o.attempts.length === 1 ? "" : "s"}</div>}</td>
                    <td className="small muted" style={{ maxWidth: 260 }}>{o.nextAction}</td>
                    <td className="actions">{creationUnconfirmed(o) && <button className="btn sm" disabled={mine.rowBusy === o.orderId} onClick={() => recoverOrderRow(o.orderId)}>Recover order</button>}{order?.orderId !== o.orderId && <button className="btn sm ghost" onClick={() => pickOrder(o)}>use</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {session && mine.loaded && myOrders.length === 0 && myAttempts.length === 0 && !mine.err && <p className="dim small">no orders or attempts yet for this wallet in this browser's session</p>}
            {(otherAttempts.length > 0 || otherOrders.length > 0 || otherSaved.length > 0) && (
              <details className="others" data-testid="other-wallets" open={!order}>
                <summary className="small">Other wallets in this browser — {otherAttempts.length} attempt{otherAttempts.length === 1 ? "" : "s"} · {otherOrders.length} order{otherOrders.length === 1 ? "" : "s"} <span className="tiny dim">(read-only here — recover and abandon stay possible; connect that wallet to continue)</span></summary>
                <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                  {otherSaved.map((s) => <p key={s.payer} className="tiny dim">saved workflow for <Hex value={s.payer} n={4} /> — order <Hex value={s.orderId} n={4} />{s.attemptId ? <> · attempt <code>{s.attemptId.slice(0, 8)}</code></> : null} · connect that wallet to continue it</p>)}
                  {otherAttempts.length > 0 && (
                    <div className="tablewrap"><table className="t attempts">
                      <thead><tr><th>when (UTC)</th><th>wallet</th><th>attempt</th><th>state</th><th>transaction</th><th></th></tr></thead>
                      <tbody>{otherAttempts.map((a) => (
                        <tr key={a.attemptId}>
                          <td className="when" title={ago(a.createdAt)}>{utc(a.createdAt)}</td>
                          <td><Hex value={a.payer} n={4} link={explorerAddr(net, a.payer)} /></td>
                          <td><code>{a.attemptId.slice(0, 8)}</code><div className="tiny dim">order <Hex value={a.orderId} n={4} /> · {usdc6(a.amountNativeAtomic)}</div></td>
                          <td><Chip tone={stateTone(a.state)}>{a.state.replace(/_/g, " ").toLowerCase()}</Chip></td>
                          <td>{(a.businessTxHash ?? a.txHash) ? <Hex value={a.businessTxHash ?? a.txHash!} n={5} link={explorerTx(net, a.businessTxHash ?? a.txHash!)} /> : <span className="dim">none</span>}</td>
                          <td className="actions">
                            {a.state === "VALIDATED" && <button className="btn sm" disabled={mine.rowBusy === a.attemptId} onClick={() => abandon(a.attemptId)}>{isUncertain(a) ? "I rejected it — abandon" : "Abandon"}</button>}
                            {isOpen(a.state) && <button className="btn sm" disabled={mine.rowBusy === a.attemptId} onClick={() => recover(a.attemptId)}>Recover</button>}
                          </td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                  {otherOrders.length > 0 && (
                    <div className="tablewrap"><table className="t orders">
                      <thead><tr><th>when (UTC)</th><th>wallet</th><th>order</th><th>amount</th><th>payment</th></tr></thead>
                      <tbody>{otherOrders.map((o) => (
                        <tr key={o.orderId}>
                          <td className="when" title={ago(o.createdAt)}>{utc(o.createdAt)}</td>
                          <td><Hex value={o.payer} n={4} link={explorerAddr(net, o.payer)} /></td>
                          <td><Hex value={o.orderId} n={5} />{o.tx && <> · <Hex value={o.tx} n={4} link={explorerTx(net, o.tx)} /></>}<div className="tiny dim">{o.proxy ?? "?"} · {o.source}{o.reference ? ` · “${o.reference}”` : ""}</div></td>
                          <td className="small">{nativeAtomicToUsdcText(o.amountNativeAtomic)} USDC</td>
                          <td><Chip tone={paymentLabel(o).tone}>{paymentLabel(o).text}</Chip></td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </div>
              </details>
            )}
            <ErrorBanner err={mine.rowErr} />
            <details id="my-checks">
              <summary className="small">My checks — fee history ({checks.rows.length})</summary>
              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                <p className="tiny dim">every check this session bought · refresh re-reads the payment state · Run recovery re-examines an unsettled fee authorization (one nonce never pays twice) · Passport exports a delivered check's private passport</p>
                {session && checks.loaded && checks.rows.length === 0 && !checks.err && <p className="dim small">no checks yet in this browser's session</p>}
                <ErrorBanner err={checks.err} />
                {checks.rows.length > 0 && (
                  <div className="tablewrap"><table className="t checks">
                    <thead><tr><th>when (UTC)</th><th>subject</th><th>value</th><th>state</th><th>payment</th><th>report</th><th></th></tr></thead>
                    <tbody>{checks.rows.map((c) => (
                      <tr key={c.requestId}>
                        <td className="when" title={ago(c.createdAt)}>{utc(c.createdAt)}</td>
                        <td>{c.subject ? <Hex value={c.subject} n={5} link={explorerAddr(net, c.subject)} /> : "—"}<div className="tiny dim">request <code>{c.requestId.slice(0, 8)}</code></div></td>
                        <td className="small">{c.valueNativeAtomic ? usdc6(c.valueNativeAtomic) : "—"}</td>
                        <td><Chip tone={c.state === "DELIVERED" ? "ok" : c.state === "NOT_UNDER_THIS_SESSION" ? "neutral" : "warn"}>{c.state.replace(/_/g, " ").toLowerCase()}</Chip></td>
                        <td>{c.payment ? <><Chip tone={payTone(c.payment.state)}>{c.payment.state.toLowerCase()} · {c.payment.backend}</Chip>{c.payment.transaction && <> <Hex value={c.payment.transaction} n={5} link={explorerTx(net, c.payment.transaction)} /></>}{c.payment.reason && <div className="tiny dim">{c.payment.reason}</div>}</> : <span className="dim">no authorization yet</span>}</td>
                        <td>{c.reportDigest ? <Hex value={c.reportDigest} n={6} /> : <span className="dim">—</span>}</td>
                        <td className="actions">
                          {c.state !== "NOT_UNDER_THIS_SESSION" && <button className="btn sm ghost" disabled={checks.rowBusy === c.requestId} onClick={() => refreshRow(c.requestId)}>refresh</button>}
                          {c.payment && (c.payment.state === "PENDING" || c.payment.state === "SUBMITTED") && <button className="btn sm" disabled={checks.rowBusy === c.requestId} onClick={() => recoverRow(c.requestId)}>Run recovery</button>}
                          <button className="btn sm ghost" disabled={!c.passportAvailable || checks.rowBusy === c.requestId} title={c.passportAvailable ? "private Payment Passport of this check" : "available once the report is delivered"} onClick={() => passportRow(c.requestId)}>Passport</button>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
                <ErrorBanner err={checks.rowErr} />
              </div>
            </details>
          </StepSection>

          {/* 6 · passport */}
          <StepSection n={6} id="step-6" title="Export the Payment Passport" status={stages[5].status} open={isStepOpen(6)} onToggle={() => toggle(6)}
            summary={passport && <><code>{passport.name}</code> · <Chip tone="ok">{passport.kind === "attempt" ? "wallet-run · private" : "paid-check · private"}</Chip></>}>
            <p className="small muted">{passportSource === "attempt" ? <>Private passport of this attempt (<code>wallet-run</code>): approval, intent, report, decision, validation and plan, execution, costs, recovery, evidence — no signature, no key.</> : passportSource === "check" ? <>No attempt was executed; the delivered check's private passport (<code>paid-check</code>) packages the approval, intent, pinned report and fee settlement.</> : <>Available once a check is delivered or an attempt has finished or stopped.</>}</p>
            <div className="row" style={{ gap: 10, alignItems: "center" }}>
              <button className="btn primary" disabled={!passportSource || !!busy || (attempt ? attempt.state === "VALIDATED" && insideWindow(attempt, now) : false)} onClick={download}>{busy === "passport" ? <><Spinner /> exporting…</> : passport ? "Download again" : "Download Payment Passport"}</button>
              {attempt && attempt.state === "VALIDATED" && insideWindow(attempt, now) && <span className="tiny dim">available once the attempt has finished or stopped</span>}
              {passport && <span className="tiny dim">saved as <code>{passport.name}</code> · {Object.keys((passport.bundle as any).files ?? {}).length} files</span>}
            </div>
          </StepSection>

          {/* 7 · verify */}
          <StepSection n={7} id="step-7" title="Verify independently" status={stages[6].status} open={isStepOpen(7)} onToggle={() => toggle(7)}
            summary={verification && <Chip tone={verification === "passed" ? "ok" : verification === "failed" ? "bad" : "warn"}>{verification === "passed" ? "passed in this browser (no FAIL, no UNVERIFIED)" : verification === "failed" ? "FAILED in this browser" : "partially verified — unverified findings"}</Chip>}>
            <p className="small muted">The verifier runs here on the downloaded bundle against <code>{net?.rpc ?? "the Arc RPC"}</code>, with this site's digests as anchors — a consistency check, not independence; the CLI with your own anchors is. "Passed" means no finding is FAIL or UNVERIFIED.</p>
            <VerifyInBrowser bundle={passport?.bundle ?? null} name={passport?.name ?? null} net={net} anchors={anchors} anchorsSource="site" onVerified={(_r, s) => setVerification(s.kind)} />
          </StepSection>
        </div>

        {dialog && <OrderDialog payer={account} net={net} limits={limits} create={createOrder} onCreated={onCreated} onClose={() => setDialog(false)} unconfirmed={unconfirmedLatest} onLost={() => void loadMine()} />}

        <details>
          <summary className="small">Integrate (curl) — the same lifecycle over HTTP</summary>
          <pre className="json" style={{ marginTop: 8 }}>{`# 0. session (open self-service: no registration) — keep the token, it owns your orders, checks and attempts
TOKEN=$(curl -s -X POST ${location.origin}${apiPath("/v1/session")} | jq -r .token)
# 1. order (payer = your wallet; amount in 18-dec native units 1e15–1e18, step 1e12; reference ≤ 64 chars)
curl -s -X POST ${location.origin}${apiPath("/v1/demo/orders")} -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"payer":"0x…","proxy":"MAIN","amountNativeAtomic":"50000000000000000","reference":"invoice #42"}'
# 2. quote (free, report prepared & pinned) → 402 {quote, pinnedBlock, paymentRequirements}
curl -s -X POST ${location.origin}${apiPath("/v1/preflight")} -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"intent": …}'
# 3. sign EIP-3009 TransferWithAuthorization(from=you, to=quote.payTo, value=quote.amountTokenAtomic) with USDC domain {name:"USDC",version:"2",chainId:${net?.chainId ?? 5042},verifyingContract:"0x3600…0000"}; pay → report (or 202 + GET /v1/requests/{id} until settled)
curl -s -X POST ${location.origin}${apiPath("/v1/preflight")} -H "authorization: Bearer $TOKEN" -d '{"intent": …, "payment": {"signature": "0x…", "authorization": {…}}}'
# 4. decide locally: import { decide } from "@arcpreflight/policy"
# 5. execute with your wallet: POST ${apiPath("/v1/wallet/attempts")} {requestId, orderId, policy} → 201 VALIDATED {plan}; eth_sendTransaction(plan) → POST …/{id}/sent {txHash}; GET …/{id} observes; POST …/{id}/abandon on a rejected prompt; POST …/{id}/recover reconciles (also right after an ambiguous wallet error)
# 6. passports: GET ${apiPath("/v1/wallet/attempts/{id}/passport")} · GET ${apiPath("/v1/requests/{id}/passport")} → verify: pnpm exec tsx packages/verifier/src/cli.ts passport.json --rpc ${net?.rpc ?? "https://rpc.testnet.arc.io"} --anchors anchors.json`}</pre>
        </details>
      </div>
    </section>
  );
}
