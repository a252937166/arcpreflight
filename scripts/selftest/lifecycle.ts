// Complete-lifecycle rehearsal (design v3.3, docs/LIFECYCLE.md; acceptance AP33-04/07/08/09/10/12). Two scenarios against a running
// ArcPreflight API on the network it reports:
//   wallet   — a scripted "wallet" (a local key that stands in for the visitor's browser wallet): anonymous session → own order with
//              amount + reference → free quote → ONE EIP-3009 fee authorization → report → server-side wallet attempt (VALIDATED with
//              plan) → the wallet signs and broadcasts exactly the plan → the hash is reported → outcome from the chain → passport →
//              independent verification in a clean process (the verifier CLI).
//   interrupt — the Live Demo runner with `interruptAfterBroadcast`: the run stops right after the send, goes RECONCILE_REQUIRED
//              with its hash recorded, is resolved by the recovery worker (or an observe read) from the original context, exports a
//              complete passport, verified the same way.
// Spends: wallet fee 0.01 + business amount + gas from the wallet key; runner fee 0.01 + 0.05 + gas from the project keys. Testnet by
// default; on mainnet the operator runs it only after the explicit go (ARC_NET must match the API's network).
// Secrets: the wallet key is read from WALLET_KEY_FILE and never printed; only addresses and hashes appear in the output.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createPublicClient, encodeFunctionData, http, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IntentCore, PolicyCore, intentDigest, policyDigest } from "@arcpreflight/schema";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization, type ArcNet } from "@arcpreflight/client";
import { PIN_LAG } from "@arcpreflight/observer";
import { OutflowMeter, SpendRefused, parseUsdc18, usdc18, pinCaps, checkStep, beginMeasured, updateMeasured, noteOpen, relabelOpen, openIdTags, endStep } from "@arcpreflight/client";
import { openGuard } from "../lib/spend-ledger.js";
import { openPlan } from "../lib/plan-ledger.js";

// Gate D (2026-10-09): `--preflight` is read-only (no session, no order, no signature): the gate state, the balances, the plan and the caps.
// Execution enforces two limits: the visitor key's own spend (the fee authorization + its business transaction, gas included) through a
// SpendGuard, and the measured outflow of every project key involved (visitor, demo-runner, order-creator, merchant-payto) through an
// OutflowMeter that refuses a scenario whose worst case could carry the total past LIFECYCLE_PROJECT_CAP_USDC. On mainnet the instance must
// still be gated (PUBLIC_EXECUTION=0): acceptance runs with the operator's admin token before public execution opens.
const PREFLIGHT = process.argv.includes("--preflight");

const api = process.env.API_URL ?? "http://127.0.0.1:4041";
const scenarios = (process.env.SCENARIOS ?? "wallet,interrupt").split(",").map((s) => s.trim()).filter(Boolean);
const network = await fetch(`${api}/v1/network`).then((r) => r.json()) as any;
const net = network.network as ArcNet;
assert.equal(process.env.ARC_NET, net, `ARC_NET must be explicit and equal to the API's network (${net})`);
if (net === "mainnet" && !PREFLIGHT) assert.equal(process.env.MAINNET_GO, "1", "mainnet lifecycle rehearsal needs MAINNET_GO=1 after the typed go");
if (net === "mainnet") { // acceptance precedes opening: the operator's token passes a gate that must still be closed
  assert.equal(network.access?.publicExecution, false, "public execution is already open on this mainnet instance; the lifecycle acceptance must run before it opens (PUBLIC_EXECUTION=0)");
  if (network.access?.executionReady !== undefined) assert.equal(network.access.executionReady, true, "the instance is not ready for execution (deployments, order signer or runner missing)");
}
if (!PREFLIGHT) assert(network.access?.walletExecution === true || (network.access?.publicExecution === false && process.env.ADMIN_TOKEN), "the API must expose wallet execution (design v3.3), or be gated with ADMIN_TOKEN supplied to pass the gate");
const rpcUrl = network.rpc as string; const chainId = network.chainId as number;
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) });
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(process.cwd(), "evidence/selftest"); mkdirSync(resolve(outDir, "passports"), { recursive: true });
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
// review of bf0c800 (P2): the repository the verifier CLI is run from (the tests under scripts/test run this script from a scratch cwd so
// nothing lands in the repository), and the bound on waiting for a recovered attempt to leave its open state (tests shorten it)
const REPO_DIR = process.env.ARCPREFLIGHT_REPO ?? process.cwd();
const RECOVERY_WAIT_MS = Number(process.env.LIFECYCLE_RECOVERY_WAIT_MS ?? 120_000);
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) as any });
const adminHeader: Record<string, string> = process.env.ADMIN_TOKEN ? { "x-admin-token": process.env.ADMIN_TOKEN } : {}; // the mainnet instance gates public execution until the acceptance is recorded; the operator's token passes the gate
const post = (path: string, body: unknown, token?: string) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", ...adminHeader, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(j);
const get = (path: string, token?: string) => fetch(`${api}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(j);
const evidence: any = { generatedAt: new Date().toISOString(), api, network: network.caip2, release: network.release, scenarios: {} };

/** Clean-process verification: the verifier CLI with the API-independent RPC and the anchors the buyer would hold. */
function verifyInCleanProcess(passportPath: string, anchors: { baselineDigests: string[]; policyDigests: string[] }) {
  const anchorsPath = passportPath.replace(/\.passport\.json$/, ".anchors.json");
  writeFileSync(anchorsPath, JSON.stringify(anchors, null, 2));
  const r = spawnSync("pnpm", ["exec", "tsx", resolve(REPO_DIR, "packages/verifier/src/cli.ts"), passportPath, "--rpc", rpcUrl, "--anchors", anchorsPath, "--json"], { cwd: REPO_DIR, encoding: "utf8", env: { ...process.env } });
  const out = r.stdout.trim(); const start = out.indexOf("{");
  const parsed = start >= 0 ? JSON.parse(out.slice(start)) : null;
  assert(parsed, `verifier produced no JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  const by = Object.fromEntries(parsed.findings.map((f: any) => [f.id, f.status]));
  return { exit: r.status, counts: parsed.counts, findings: by, anchorsPath };
}
async function waitForBlock(after: bigint) { for (let i = 0; i < 60; i++) { if ((await client.getBlockNumber()) >= after + BigInt(PIN_LAG) + 1n) return; await sleep(1000); } throw new Error("head did not advance past the required block"); }

// ---- limits and the read-only preflight
const GWEI = 10n ** 9n;
const capFrom = (env: string, dflt: string, max: string) => { const v = parseUsdc18(process.env[env] ?? dflt); if (v > parseUsdc18(max)) throw new SpendRefused(`${env} above ${max} USDC is refused`); return v; };
const walletAmount = BigInt(process.env.WALLET_AMOUNT_ATOMIC ?? "5000000000000000"); // 0.005 USDC
const feeNative = BigInt(network.priceTokenAtomic ?? "10000") * 10n ** 12n;
const walletLimits = { label: "lifecycle-wallet", network: net, perTxNativeAtomic: capFrom("WALLET_PER_TX_CAP_USDC", "0.03", "0.10"), totalNativeAtomic: capFrom("WALLET_SPEND_CAP_USDC", "0.05", "0.20"), maxFeePerGasCeiling: BigInt(process.env.MAX_FEE_GWEI ?? "40") * GWEI };
const projectCap = capFrom("LIFECYCLE_PROJECT_CAP_USDC", "0.12", "0.30");
// server-sent gas ceilings (enforced server-side per transaction): createOrder 150k × 40 gwei, relay 0.005 USDC, the business pay ≤ policy.maxGasCostNativeAtomic 0.002
const ORDER_GAS_CEIL = 150_000n * 40n * GWEI, RELAY_GAS_CEIL = 5_000_000_000_000_000n, PAY_GAS_CEIL = 2_000_000_000_000_000n;
const worstOf = { wallet: ORDER_GAS_CEIL + feeNative + RELAY_GAS_CEIL + walletAmount + PAY_GAS_CEIL, interrupt: ORDER_GAS_CEIL + feeNative + RELAY_GAS_CEIL + BigInt(network.budget?.amountNativeAtomic ?? "50000000000000000") + PAY_GAS_CEIL } as Record<string, bigint>;
const walletAddress = (() => { const f = process.env.WALLET_KEY_FILE; if (!f) return null; /* the measured key set belongs to the plan, not to this invocation's scenarios: the visitor key is measured whenever it is configured */ const t = readFileSync(f, "utf8").trim(); if (t.startsWith("{")) { const j = JSON.parse(t); if (j.address) return j.address as string; return privateKeyToAccount(j.privateKey as Hex).address; } return privateKeyToAccount(t as Hex).address; })();
const projectAddresses = Array.from(new Set([walletAddress, network.accounts?.demoRunner, network.accounts?.orderCreator, network.accounts?.merchantPayTo].filter((a): a is string => !!a).map((a) => a.toLowerCase())));
const sumBalances = async () => (await Promise.all(projectAddresses.map((a) => client.getBalance({ address: a as Hex })))).reduce((x, y) => x + y, 0n);
// the plan ledger (review 2026-10-10, P1): the approved project cap is pinned (the environment may lower it, never raise it); the measured
// outflow is carried across restarts from the FIRST invocation's balance baseline; a scenario that was started counts at its worst case
// until it settles. The visitor key's own guard is persisted too (evidence/spend/<net>-lifecycle-wallet.json) so its cap holds across re-runs.
const ROOT_DIR = process.env.ARCPREFLIGHT_ROOT ?? process.cwd();
const book = openPlan(ROOT_DIR, net, { write: !PREFLIGHT });
if (net === "mainnet" && !book) throw new SpendRefused("mainnet lifecycle needs the plan ledger (PLAN_ID must name the approved plan)"); // audit 2026-10-10 (OP-02)
if (book) pinCaps(book.plan, "lifecycle", { totalNativeAtomic: projectCap, maxFeePerGasCeiling: walletLimits.maxFeePerGasCeiling }); // OP-04: MAX_FEE_GWEI may lower the pinned 40 gwei ceiling, never raise it
const previous = book ? { updatedAt: book.plan.steps.lifecycle.updatedAt, invocations: book.plan.steps.lifecycle.invocations, openRuns: [...book.plan.steps.lifecycle.openRuns] } : null;
const startTotal = await sumBalances();
if (book && !PREFLIGHT) book.apply((p) => beginMeasured(p, "lifecycle", projectAddresses, startTotal));
const baseline = book?.plan.steps.lifecycle.baselineTotalNativeAtomic ?? startTotal;
const meter = new OutflowMeter("lifecycle project outflow", projectCap, baseline);
const syncMeasured = async () => { const t = await sumBalances(); if (book && !PREFLIGHT) book.apply((p) => updateMeasured(p, "lifecycle", t)); return t; };
/** one durable update: the open scenario's pending worst case released and the measured outflow recorded together, after the balance read */
const settleOpen = async (openId: string, worst: bigint) => { const t = await sumBalances(); if (book && !PREFLIGHT) book.apply((p) => updateMeasured(noteOpen(p, "lifecycle", openId, false, worst), "lifecycle", t)); return t; };
// rehearsal hook (testnet only): stop right after a checkpoint's durable write, the way an interrupted process would
const STOP_AFTER = process.env.LIFECYCLE_STOP_AFTER ?? null;
if (STOP_AFTER && net === "mainnet") throw new SpendRefused("LIFECYCLE_STOP_AFTER is a testnet rehearsal hook; refused on mainnet");
const stopAfter = (mark: string) => { if (STOP_AFTER === mark) { log(`LIFECYCLE_STOP_AFTER=${mark}: stopping here like an interrupted process; the plan record keeps the open scenario`); process.exit(3); } };
const walletLedger = openGuard(ROOT_DIR, walletLimits, { write: !PREFLIGHT });
const walletGuard = walletLedger.guard; const saveWallet = walletLedger.save;

/** Review of bf0c800 (P2): the wallet scenario's session and identities, persisted PRIVATELY under data/ (gitignored; never under evidence/),
 *  keyed by the scenario's base id. A restart observes the attempt through the session that owns it, exports its passport and proves the
 *  outcome before the scenario counts as complete — a receipt alone proves nothing about payment, plan agreement or costs. */
type WalletSession = { token: string; principal: string; payer?: string; orderId?: string; requestId?: string; attemptId?: string; policyDigest?: string; baselineDigest?: string; plan?: any; txHash?: string; updatedAt?: string };
const sessionsPath = resolve(ROOT_DIR, "data", "lifecycle", `${net}-${book?.plan.planId ?? "no-plan"}.sessions.json`);
const sessions = {
  all(): Record<string, WalletSession> { try { return JSON.parse(readFileSync(sessionsPath, "utf8")); } catch { return {}; } },
  get(base: string): WalletSession | null { const s = this.all()[base]; return s && typeof s.token === "string" && s.token ? s : null; },
  put(base: string, patch: Partial<WalletSession>) { if (PREFLIGHT) return; const all = this.all(); all[base] = { ...(all[base] ?? { token: "", principal: "" }), ...patch, updatedAt: new Date().toISOString() }; mkdirSync(resolve(sessionsPath, ".."), { recursive: true }); writeFileSync(sessionsPath, JSON.stringify(all, null, 2)); },
};

/** follows a labelled-interruption run to its outcome, exports and verifies its passport (a fresh start and a recovery share this) */
async function followInterruptRun(runId: string, clientRunRequestId: string, recovered: boolean) {
  let run: any = null;
  for (let i = 0; i < 120; i++) { run = (await get(`/v1/demo/runs/${runId}`)).body; if (run?.state && run.state !== "RUNNING") break; await sleep(2000); }
  assert(run?.steps, `run ${runId} could not be read`);
  const stepNames = run.steps.map((s: any) => s.step);
  assert(stepNames.includes("orderPlanned"), "the order identity is recorded before its creation is sent");
  assert(stepNames.includes("broadcastAttempted") && stepNames.includes("interruptedAfterBroadcast"), `expected the interruption steps, got ${stepNames.join(",")}`);
  const interruptedState = run.state; const outcomeAtStop = run.outcome;
  log(`run ${recovered ? "found" : "stopped"}: state ${interruptedState}, outcome ${outcomeAtStop?.kind} (${outcomeAtStop?.source}), store ${run.businessExecution?.state}`);
  if (interruptedState === "RECONCILE_REQUIRED") assert.equal(outcomeAtStop.kind, "BROADCAST_UNRESOLVED"); // AP33-06: the headline follows the store, never "nothing sent"
  for (let i = 0; i < 60 && run.state === "RECONCILE_REQUIRED"; i++) { await sleep(3000); run = (await get(`/v1/demo/runs/${runId}`)).body; }
  assert.equal(run.state, "DONE", `run did not reconcile: ${run.state} ${run.businessExecution?.note ?? ""}`);
  assert.equal(run.outcome.kind, "PAID"); assert.equal(run.businessExecution.state, "CONFIRMED");
  assert.equal(run.recovery.addedByRecovery.ordersCreated, 0); assert.equal(run.recovery.addedByRecovery.businessSignatures, 0);
  log(`reconciled: ${run.businessExecution.txHash} CONFIRMED/${run.businessExecution.businessStatus}; recovery added orders=${run.recovery.addedByRecovery.ordersCreated} signatures=${run.recovery.addedByRecovery.businessSignatures}`);
  const passport = await get(`/v1/demo/runs/${runId}/passport`); assert.equal(passport.status, 200);
  const passportPath = resolve(outDir, "passports", `${net}-interrupt-${stamp}.passport.json`); writeFileSync(passportPath, JSON.stringify(passport.body, null, 2));
  const fixture = network.fixtures.find((f: any) => f.id === "APPROVED_PAYMENT");
  const v = verifyInCleanProcess(passportPath, { baselineDigests: [fixture.baselineDigest], policyDigests: [run.result.policyDigest] });
  log(`verifier: exit ${v.exit}, pass ${v.counts.pass}, fail ${v.counts.fail}; ORDER_OUTCOME=${v.findings.ORDER_OUTCOME} TRANSACTION_PLAN_AGREEMENT=${v.findings.TRANSACTION_PLAN_AGREEMENT} COST_STATEMENT=${v.findings.COST_STATEMENT}`);
  assert.equal(v.counts.fail, 0, JSON.stringify(v.findings));
  return { runId, clientRunRequestId, recoveredFromPreviousInvocation: recovered, stateAtStop: interruptedState, outcomeAtStop, steps: stepNames, businessExecution: run.businessExecution, recovery: run.recovery, reconciliation: run.result.reconciliation, costStatement: run.result.costStatement, passport: passportPath, verifier: v };
}

// Lifecycle rehearsal on 40c5858 (2026-10-10): the script died on a dropped connection right after it had started the interruption
// scenario, and the plan record kept that scenario open at its worst case with no way to settle it. Now every open scenario carries
// its durable identity in its id (the admission key is written BEFORE the POST; the wallet scenario adds its order, attempt and hash
// as it learns them) and a restart settles the open scenarios of previous invocations FIRST, before anything new is started:
//   interrupt  the same admission key is re-sent — the server returns the original run (or admits the same operation now); it is
//              followed to its outcome, its passport verified, and the scenario counts as complete under this plan
//   wallet     an attempt or a broadcast hash → the attempt is OBSERVED through the recorded session (review of bf0c800, P2): only a
//              CONFIRMED/SUCCESS attempt for that hash that matches the plan, whose receipt succeeded, whose order reads paid and whose
//              cost statement agrees with the receipt, with its passport exported and verified, completes the scenario; a terminal
//              attempt that did not succeed settles the money and stops; an open one keeps the reservation; earlier stops → settled
//              from the balances once the server's receipt deadlines are past (10 minutes), refused before that
//   anything else (a record written before this version, or no recorded session) → refused unless LIFECYCLE_SETTLE_OPEN names it after a manual check
const completed = new Set<string>(); evidence.recovered = [];
const GRACE_MS = 10 * 60_000; const settleExplicit = process.env.LIFECYCLE_SETTLE_OPEN ?? null;
type OpenDecision = { action: "explicit" | "replay" | "observe" | "settle" | "wait" | "refuse"; completes: boolean; note: string };
/** what this invocation does with a scenario a previous invocation left open — the same decision in the read-only preflight and the run */
const decideOpen = (open: string, base: string, sc: string, tags: Record<string, string>, ageMs: number): OpenDecision => {
  if (settleExplicit === open) return { action: "explicit", completes: false, note: "settled by the operator (LIFECYCLE_SETTLE_OPEN) after a manual check of the server's state" };
  if (sc === "interrupt" && tags.key) return { action: "replay", completes: true, note: `the same admission key ${tags.key.slice(0, 14)}… is re-sent: the server returns the original run, which is followed to its outcome and verified` };
  if (sc === "wallet") {
    if (tags.tx || tags.attempt) {
      const s = sessions.get(base);
      if (!s || !(s.attemptId ?? tags.attempt)) return { action: "refuse", completes: false, note: `attempt ${tags.attempt ?? "?"}${tags.tx ? ` and transaction ${tags.tx}` : ""} are recorded, but no session for ${base} is stored under ${sessionsPath}, so the outcome cannot be observed through the session that owns the attempt — check the attempt and the receipt by hand and re-run with LIFECYCLE_SETTLE_OPEN=${open}` };
      return { action: "observe", completes: !!tags.tx, note: `attempt ${s.attemptId ?? tags.attempt} is observed through the recorded session: only CONFIRMED/SUCCESS for ${tags.tx ?? s.txHash ?? "its transaction"}, matching the plan, with a successful receipt, the order paid, the costs as the receipt says and a passport that verifies, completes the scenario; anything else stops` };
    }
    if (ageMs >= GRACE_MS) return { action: "settle", completes: false, note: `stopped before its attempt ${Math.round(ageMs / 60_000)} min ago, past the server's receipt deadlines: settled from the balances` };
    return { action: "wait", completes: false, note: `stopped before its attempt only ${Math.round(ageMs / 1000)} s ago: the project's order creation or fee relay may still be in flight — retry after ${GRACE_MS / 60_000} minutes` };
  }
  return { action: "refuse", completes: false, note: `no durable identity to recover from (a record written before this version, or an unknown scenario): check the server's state (GET /v1/demo/runs newest first, the attempt) and re-run with LIFECYCLE_SETTLE_OPEN=${open} to settle it from the balances` };
};
const OPEN_ATTEMPT = ["VALIDATED", "BROADCAST_ATTEMPTED"], NOTHING_SENT = ["VALIDATED", "NOT_SENT", "REFUSED", "NOT_EXECUTED"];
/** The open wallet scenario, proven or not (review of bf0c800, P2): the attempt is read through the session that owns it; the money is settled
 *  from the receipt whatever the outcome; the scenario completes only on the full proof (attempt, receipt, plan, order, costs, passport). */
async function observeWalletScenario(open: string, base: string, tags: Record<string, string>) {
  const s = sessions.get(base)!; const attemptId = (s.attemptId ?? tags.attempt) as string;
  const read = async () => { const a = await get(`/v1/wallet/attempts/${attemptId}`, s.token); assert.equal(a.status, 200, `the recorded session cannot read attempt ${attemptId}: HTTP ${a.status} ${JSON.stringify(a.body)?.slice(0, 200)} — manual check, the reservation is kept`); return a.body; };
  let view = await read();
  if (s.payer && view.payer && view.payer.toLowerCase() !== s.payer.toLowerCase()) assert.fail(`attempt ${attemptId} belongs to ${view.payer}, the record says ${s.payer}`);
  const hash = (tags.tx ?? s.txHash ?? view.businessTxHash ?? view.txHash ?? null) as string | null;
  if (!hash && NOTHING_SENT.includes(view.state)) { // nothing of the visitor's ever left; the project's order creation and fee relay were mined before the attempt existed
    return { completes: false, failed: false, how: `attempt ${attemptId} is ${view.state} with no transaction: the wallet never broadcast; the project's order creation and fee relay were already mined`, extra: { attemptId, state: view.state } };
  }
  assert(hash, `attempt ${attemptId} is ${view.state} but neither the record nor the server names its transaction — manual check, the reservation is kept`);
  // the server reconciles an open attempt from the chain: wait, bounded, for it to leave the open states — unless the chain already answers
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  let rc = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  while (OPEN_ATTEMPT.includes(view.state) && !rc && Date.now() < deadline) { await sleep(2000); view = await read(); rc = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null); }
  if (!rc && OPEN_ATTEMPT.includes(view.state)) {
    const windowOver = view.state === "VALIDATED" && view.validUntil && new Date(view.validUntil).getTime() < Date.now() - 60_000;
    if (!windowOver) throw new SpendRefused(`${open}: attempt ${attemptId} is still ${view.state} and ${hash} has no receipt after ${Math.round(RECOVERY_WAIT_MS / 1000)} s; the reservation is KEPT — retry later (the server keeps reconciling)`);
    return { completes: false, failed: false, how: `the recorded transaction ${hash} never reached the chain (no receipt; the attempt's window closed VALIDATED): nothing of the visitor's moved; its sent entry stays at its worst case in the visitor ledger`, extra: { attemptId, txHash: hash, state: view.state } };
  }
  // one more read once the receipt exists, so the server's reconciliation of this very attempt is what is judged
  if (rc && OPEN_ATTEMPT.includes(view.state)) { for (let i = 0; i < 5 && OPEN_ATTEMPT.includes(view.state); i++) { await sleep(2000); view = await read(); } }
  if (OPEN_ATTEMPT.includes(view.state)) throw new SpendRefused(`${open}: ${hash} is mined (status ${rc!.status}) but the server still reports attempt ${attemptId} as ${view.state}; the reservation is KEPT — retry once the server has reconciled it`);
  const gas = rc!.gasUsed * rc!.effectiveGasPrice;
  const value = BigInt(view.amountNativeAtomic ?? s.plan?.valueNativeAtomic ?? 0);
  const actual = rc!.status === "success" ? value + gas : gas; // a reverted payment cost its gas only
  // the visitor ledger: the entry that was `sent` with this hash settles to what the receipt says — the money is final either way
  const idx = walletGuard.entries.findIndex((e) => e.status === "sent" && e.txHash?.toLowerCase() === hash.toLowerCase());
  if (idx >= 0) { walletGuard.settle(idx, actual); saveWallet(); }
  const problems: string[] = [];
  if (view.state !== "CONFIRMED") problems.push(`attempt state ${view.state}`);
  if (view.businessStatus !== "SUCCESS") problems.push(`business status ${view.businessStatus ?? "unknown"}`);
  if (!view.businessTxHash || view.businessTxHash.toLowerCase() !== hash.toLowerCase()) problems.push(`the server names transaction ${view.businessTxHash ?? "none"}, the record ${hash}`);
  if (!view.deviations || !Array.isArray(view.deviations.mismatch)) problems.push("no plan comparison recorded"); else if (view.deviations.mismatch.length) problems.push(`the transaction deviates from the plan in ${view.deviations.mismatch.join(", ")}`);
  if (view.recovery?.counters?.businessSignatures !== 0) problems.push(`the recovery counters report ${view.recovery?.counters?.businessSignatures ?? "unknown"} business signature(s) by the service`);
  if (rc!.status !== "success") problems.push(`receipt status ${rc!.status}`);
  if (view.costStatement?.buyer?.complete !== true) problems.push("the cost statement's buyer total is not complete");
  if (view.costStatement?.actual?.businessGasNativeAtomic !== gas.toString()) problems.push(`the cost statement's business gas ${view.costStatement?.actual?.businessGasNativeAtomic ?? "none"} differs from the receipt's ${gas.toString()}`);
  const orderId = (s.orderId ?? tags.order ?? view.orderId) as string | undefined;
  const order = orderId ? await get(`/v1/demo/orders/${orderId}`, s.token) : null;
  if (!order || order.status !== 200) problems.push(`order ${orderId ?? "?"} not readable (${order?.status ?? "no id"})`);
  else if (order.body.paid !== true) problems.push(`order ${orderId} reads paid=${order.body.paid}`);
  else if (!(order.body.attempts ?? []).some((x: any) => x.attemptId === attemptId)) problems.push(`order ${orderId} does not list attempt ${attemptId}`);
  const base_extra = { attemptId, txHash: hash, state: view.state, businessStatus: view.businessStatus ?? null, receiptStatus: rc!.status, block: rc!.blockNumber.toString(), visitorActualNativeAtomic: actual.toString() };
  if (problems.length) return { completes: false, failed: true, how: `the wallet scenario did not succeed: ${problems.join("; ")} — manual check`, extra: base_extra };
  // the original passport, exported through the session that owns the attempt and verified in a clean process against the recorded anchors
  const passport = await get(`/v1/wallet/attempts/${attemptId}/passport`, s.token); assert.equal(passport.status, 200, `passport export answered ${passport.status} ${JSON.stringify(passport.body)?.slice(0, 200)}`);
  const passportPath = resolve(outDir, "passports", `${net}-wallet-${stamp}.passport.json`); writeFileSync(passportPath, JSON.stringify(passport.body, null, 2));
  assert(s.baselineDigest && s.policyDigest, `the recorded session for ${base} lacks the approval anchors (baseline and policy digests): the passport cannot be verified independently — manual check`);
  const v = verifyInCleanProcess(passportPath, { baselineDigests: [s.baselineDigest], policyDigests: [s.policyDigest] });
  log(`verifier: exit ${v.exit}, pass ${v.counts.pass}, fail ${v.counts.fail}, unverified ${v.counts.unverified ?? 0}; TRANSACTION_PLAN_AGREEMENT=${v.findings.TRANSACTION_PLAN_AGREEMENT} ORDER_OUTCOME=${v.findings.ORDER_OUTCOME} COST_STATEMENT=${v.findings.COST_STATEMENT}`);
  assert.equal(v.counts.fail, 0, JSON.stringify(v.findings));
  for (const id of ["TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT", "FEE_ATTRIBUTION"]) assert.equal(v.findings[id], "PASS", `passport finding ${id} is ${v.findings[id]}, expected PASS`);
  const manifest = JSON.parse(passport.body.files["manifest.json"]); assert.equal(manifest.subject.kind, "wallet-run"); assert.equal(manifest.subject.executionMode, "wallet");
  evidence.scenarios.wallet = { recoveredFromPreviousInvocation: true, payer: view.payer, order: { orderId, paid: order!.body.paid, amountNativeAtomic: view.amountNativeAtomic }, requestId: s.requestId ?? view.requestId, attemptId, plan: s.plan ?? view.plan ?? null, txHash: hash,
    outcome: { state: view.state, businessStatus: view.businessStatus, block: view.block, deviations: view.deviations }, receipt: { status: rc!.status, block: rc!.blockNumber.toString(), gasUsed: rc!.gasUsed.toString(), effectiveGasPrice: rc!.effectiveGasPrice.toString() }, costStatement: view.costStatement, passport: passportPath, verifier: v };
  return { completes: true, failed: false, how: `attempt ${attemptId} CONFIRMED/SUCCESS for ${hash}: receipt success, plan matched, order paid, costs as the receipt says; passport exported through the recorded session and verified (${v.counts.pass} PASS, ${v.counts.fail} FAIL)`, extra: { ...base_extra, verifier: v.counts } };
}
const writeEvidence = (status: "PASS" | "FAILED") => { evidence.status = status; const outPath = resolve(outDir, `${net}-lifecycle-${stamp}.json`); writeFileSync(outPath, JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)); return outPath; };
if (book && previous && previous.openRuns.length) for (const open of previous.openRuns) {
  const { base, tags } = openIdTags(open); const sc = base.split("-")[0]; const worst = worstOf[sc] ?? 0n;
  const ageMs = Date.now() - new Date(previous.updatedAt ?? 0).getTime();
  const d = decideOpen(open, base, sc, tags, ageMs);
  if (PREFLIGHT) { // read-only: say what a run would do and show the record as it would stand after that (in memory only; nothing is written, nothing asked of the API)
    if (d.action === "wait" || d.action === "refuse") { log(`open from invocation ${previous.invocations}: ${open} — a run would stop: ${d.note}`); continue; }
    log(`open from invocation ${previous.invocations}: ${open} — a run settles it first (${d.action}): ${d.note}`);
    book.apply((p) => noteOpen(p, "lifecycle", open, false, worst)); if (d.completes) completed.add(sc); continue;
  }
  log(`resuming: ${open} was started by invocation ${previous.invocations} and is still open in the plan record — settling it before starting anything (${d.action})`);
  if (d.action === "wait" || d.action === "refuse") throw new SpendRefused(`${open}: ${d.note}`);
  let extra: Record<string, unknown> = {}; let completes = d.completes; let how = d.note; let failed = false;
  if (d.action === "replay") {
    const body = { fixture: "APPROVED_PAYMENT", clientRunRequestId: tags.key, interruptAfterBroadcast: true };
    let r = await post("/v1/demo/run", body);
    if (r.status === 429 && r.body?.error === "DEMO_COOLDOWN") { const wait = (Number(network.budget?.clientCooldownSeconds ?? 45) + 2) * 1000; log(`cooldown: waiting ${wait / 1000}s`); await sleep(wait); r = await post("/v1/demo/run", body); }
    assert([200, 202].includes(r.status) && r.body?.runId, `re-sending admission ${tags.key.slice(0, 14)}… answered ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
    log(`  admission ${r.body.admission}: run ${r.body.runId}`);
    evidence.scenarios.interrupt = await followInterruptRun(r.body.runId as string, tags.key, true);
    extra.runId = r.body.runId; extra.admission = r.body.admission;
  }
  if (d.action === "observe") { const r = await observeWalletScenario(open, base, tags); extra = r.extra; completes = r.completes; how = r.how; failed = r.failed; }
  const t = await settleOpen(open, worst); const measured = usdc18(meter.outflow(t));
  evidence.recovered.push({ open, scenario: sc, action: d.action, how, succeeded: !failed, ...extra, measuredProjectOutflowUsdc: measured });
  if (failed) { // the money is final and recorded; the scenario is not complete — the operator checks before anything else runs
    book.apply((p) => endStep(p, "lifecycle", "stopped"));
    log(`  settled (money final), scenario NOT complete: ${how}; measured project outflow ${measured} USDC; evidence ${writeEvidence("FAILED")}`);
    assert.fail(`${open}: ${how}`);
  }
  if (completes) completed.add(sc);
  log(`  settled: ${how}; measured project outflow ${measured} USDC`);
}
const toRun = scenarios.filter((sc) => !completed.has(sc));
for (const sc of scenarios) if (completed.has(sc)) log(`${sc}: completed by the recovered scenario of a previous invocation; not started again under this plan`);
{
  const fees = await client.estimateFeesPerGas().catch(() => null);
  const rows = toRun.map((sc) => `  ${sc.padEnd(10)} worst ${usdc18(worstOf[sc] ?? 0n)} USDC`);
  const totalWorst = toRun.reduce((a, sc) => a + (worstOf[sc] ?? 0n), 0n);
  const problems: string[] = [];
  if (totalWorst > projectCap) problems.push(`the scenarios' worst case ${usdc18(totalWorst)} USDC exceeds LIFECYCLE_PROJECT_CAP_USDC ${usdc18(projectCap)}`);
  if (book) { const c = checkStep(book.plan, "lifecycle", totalWorst, projectCap); if (!c.ok) problems.push(c.reason!); }
  if (walletLedger.priorEntries) log(`visitor key ledger: ${walletLedger.priorEntries} prior entr${walletLedger.priorEntries === 1 ? "y" : "ies"}, ${usdc18(walletGuard.committed())} USDC committed of ${usdc18(walletLimits.totalNativeAtomic)} (carried across runs)`);
  if (toRun.includes("wallet")) { const need = walletAmount + feeNative + PAY_GAS_CEIL; if (feeNative + walletAmount + PAY_GAS_CEIL > walletLimits.totalNativeAtomic) problems.push(`the wallet scenario needs up to ${usdc18(need)} USDC, above WALLET_SPEND_CAP_USDC ${usdc18(walletLimits.totalNativeAtomic)}`); if (walletAddress) { const b = await client.getBalance({ address: walletAddress as Hex }); if (b < need && !network.faucet?.enabled) problems.push(`the visitor key ${walletAddress} holds ${usdc18(b)} USDC, below the ${usdc18(need)} USDC the wallet scenario needs`); } else problems.push("WALLET_KEY_FILE is required for the wallet scenario"); }
  if (net === "mainnet" && !process.env.ADMIN_TOKEN) problems.push("ADMIN_TOKEN is required on mainnet (the gate stays closed during acceptance)");
  if (fees?.maxFeePerGas && fees.maxFeePerGas > walletLimits.maxFeePerGasCeiling) problems.push(`network max fee ${fees.maxFeePerGas / GWEI} gwei is above the ${walletLimits.maxFeePerGasCeiling / GWEI} gwei ceiling`);
  log(`${PREFLIGHT ? "PREFLIGHT (read-only: no session, no order, no signature)" : "limits"} · ${network.caip2} release ${network.release} · gate: publicExecution ${network.access?.publicExecution} · operatorAcceptance ${network.access?.operatorAcceptance ?? "?"} · executionReady ${network.access?.executionReady ?? "?"} · admin token ${process.env.ADMIN_TOKEN ? "supplied" : "absent"}`);
  log(`caps: visitor key ${usdc18(walletLimits.perTxNativeAtomic)} per transaction / ${usdc18(walletLimits.totalNativeAtomic)} total (fee authorization + business tx + gas) · project outflow ${usdc18(projectCap)} (measured over ${projectAddresses.length} keys, baseline ${usdc18(meter.startTotal)} USDC${baseline !== startTotal ? ` carried from the first invocation; now ${usdc18(startTotal)}, outflow so far ${usdc18(meter.outflow(startTotal))}` : ""})`);
  if (book) for (const l of book.lines()) log(l);
  for (const r of rows) log(r); log(`  total worst ${usdc18(totalWorst)} USDC`);
  for (const pr of problems) log(`PROBLEM: ${pr}`);
  if (PREFLIGHT) { log(problems.length ? `PREFLIGHT: NOT READY (${problems.length})` : "PREFLIGHT OK: nothing was created, signed or sent."); process.exit(problems.length ? 2 : 0); }
  if (problems.length) throw new SpendRefused(problems.join("; "));
}
const scenarioId = (sc: string) => `${sc}-${stamp}`;
const beforeScenario = async (sc: string, openId: string) => { // the open id is the scenario's durable identity, written before anything is sent
  const h = meter.headroomFor(await syncMeasured(), worstOf[sc] ?? 0n); if (!h.ok) throw new SpendRefused(h.reason!);
  if (book) { const c = checkStep(book.plan, "lifecycle", worstOf[sc] ?? 0n, projectCap); if (!c.ok) throw new SpendRefused(c.reason!); book.apply((p) => noteOpen(p, "lifecycle", openId, true, worstOf[sc] ?? 0n)); }
  log(`${sc}: measured project outflow so far ${usdc18(h.outflow)} USDC; worst case of this scenario ${usdc18(worstOf[sc] ?? 0n)} USDC; cap ${usdc18(projectCap)} USDC`);
};
// audit 2026-10-10 (OP-03): the pending commitment is released and the measured outflow recorded in ONE durable update, after the balance read
// succeeded; a failed read keeps the commitment pending
const afterScenario = async (sc: string, openId: string) => { const t = await sumBalances(); if (book && !PREFLIGHT) book.apply((p) => updateMeasured(noteOpen(p, "lifecycle", openId, false, worstOf[sc] ?? 0n), "lifecycle", t)); };

/** the open scenario learned an identity (order, attempt, hash): the plan record carries it from here on */
const relabel = (from: string, to: string) => { if (book && !PREFLIGHT) book.apply((p) => relabelOpen(p, "lifecycle", from, to)); return to; };

if (toRun.includes("wallet")) {
  const walletBase = scenarioId("wallet"); let walletOpen = walletBase; await beforeScenario("wallet", walletOpen);
  const keyFile = process.env.WALLET_KEY_FILE; assert(keyFile, "WALLET_KEY_FILE (path to the scripted wallet's key) is required for the wallet scenario");
  const keyText = readFileSync(keyFile, "utf8").trim(); // a raw hex key, or a keys/*.json file with a privateKey field; never printed
  const wallet = privateKeyToAccount((keyText.startsWith("{") ? JSON.parse(keyText).privateKey : keyText) as Hex);
  const amount = walletAmount;
  const reference = process.env.WALLET_REFERENCE ?? `lifecycle rehearsal ${stamp.slice(0, 19)}`;
  log(`wallet scenario: payer ${wallet.address}, amount ${amount} native units, reference "${reference}"`);
  let balance = await client.getBalance({ address: wallet.address });
  const needed = amount + 30_000_000_000_000_000n; // fee 0.01 + amount + a gas reserve
  if (balance < needed && network.faucet?.enabled) { // the visitor path on testnet: claim the project faucet like the site does
    const claim = await post("/v1/faucet", { address: wallet.address });
    log(`faucet claim: ${claim.status} ${claim.body?.txHash ?? claim.body?.error ?? ""} ${claim.body?.reason ?? ""}`);
    for (let i = 0; i < 20 && balance < needed; i++) { await sleep(2000); balance = await client.getBalance({ address: wallet.address }); }
  }
  assert(balance >= needed, `wallet balance ${balance} too low for fee + amount + gas (needed ${needed})`);
  const session = await post("/v1/session", {}); assert.equal(session.status, 201, JSON.stringify(session.body)); const token = session.body.token as string;
  sessions.put(walletBase, { token, principal: session.body.principal, payer: wallet.address }); // private: the session that will own the order, the check and the attempt
  // 1. the order: identity durable before the send; amount and reference are the visitor's
  let order = await post("/v1/demo/orders", { payer: wallet.address, proxy: "MAIN", amountNativeAtomic: amount.toString(), reference }, token);
  if (order.status === 202 && order.body?.orderId) { // the creation was recorded but not confirmed within the server's wait: follow THAT order, never create another
    log(`order creation pending (${order.body.state}${order.body.tx ? `, tx ${order.body.tx}` : ""}): following order ${order.body.orderId.slice(0, 12)}…`);
    const id = order.body.orderId as string;
    for (let i = 0; i < 60 && order.body?.state !== "CONFIRMED"; i++) { await sleep(3000); const g = await get(`/v1/demo/orders/${id}`, token); if (g.status === 200) order = { status: 201, body: { ...g.body, baselineDigest: g.body.baselineDigest ?? order.body.baselineDigest ?? network.fixtures?.find((f: any) => f.proxy === "MAIN")?.baselineDigest } }; if (["FAILED", "UNKNOWN_CREATION"].includes(order.body?.state)) break; }
  }
  assert.equal(order.status, 201, JSON.stringify(order.body)); assert.equal(order.body.state, "CONFIRMED"); assert.equal(order.body.reference, reference);
  log(`order ${order.body.orderId.slice(0, 12)}… created in ${order.body.tx} (block ${order.body.block}) on ${order.body.merchant}`);
  walletOpen = relabel(walletOpen, `${walletOpen}:order:${order.body.orderId}`); sessions.put(walletBase, { orderId: order.body.orderId, baselineDigest: order.body.baselineDigest ?? undefined }); stopAfter("wallet-order");
  const listed = await get("/v1/demo/orders", token); assert.equal(listed.status, 200); assert(listed.body.orders.some((o: any) => o.orderId === order.body.orderId.toLowerCase()), "the owner's order list must contain the new order");
  assert.equal((await get("/v1/demo/orders", `vs_${"0".repeat(48)}`)).status, 401);
  // 2. policy + intent as the Developer page builds them (human-paced validation window)
  const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "lifecycle-rehearsal", allowedSenders: [wallet.address], allowedTargets: [order.body.merchant], allowedSelectors: [PAY_SELECTOR], maxNativePaymentAtomic: amount.toString(), maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 60, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
  const pDigest = policyDigest(policy); sessions.put(walletBase, { policyDigest: pDigest });
  const makeIntent = () => IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `lc-${crypto.randomUUID()}`, chainId, walletMode: "EOA_DIRECT_NON_DELEGATED", from: wallet.address, operation: "CALL", to: order.body.merchant, data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [order.body.orderId] }), valueNativeAtomic: amount.toString(),
    businessExpectation: { sourceId: `order:${order.body.orderId}`, sourceDigest: keccak256(toHex(`order:${order.body.orderId}:${wallet.address}:${amount}`)), action: "MERCHANT_PAY", recipient: order.body.merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: amount.toString(), orderId: order.body.orderId },
    baselineDigest: order.body.baselineDigest, policyDigest: pDigest, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  await waitForBlock(BigInt(order.body.block));
  let intent = makeIntent(); let quoted = await post("/v1/preflight", { intent }, token);
  for (let i = 0; i < 5 && quoted.status === 402 && BigInt(quoted.body.pinnedBlock ?? 0) < BigInt(order.body.block); i++) { log("quote pinned before the order; re-requesting under a new clientRequestId (nothing paid)"); await sleep(1500); intent = makeIntent(); quoted = await post("/v1/preflight", { intent }, token); }
  assert.equal(quoted.status, 402, JSON.stringify(quoted.body)); assert(BigInt(quoted.body.pinnedBlock) >= BigInt(order.body.block));
  sessions.put(walletBase, { requestId: quoted.body.requestId });
  // 3. ONE fee authorization signed by the wallet; the report is delivered once the fee settles
  const feeIdx = walletGuard.reserve({ purpose: "check fee authorization", to: quoted.body.quote.payTo, tokenNativeEquivalent: BigInt(quoted.body.quote.amountTokenAtomic) * 10n ** 12n, gasLimit: 0n, maxFeePerGas: 0n, authorization: true }); saveWallet();
  const { signature, authorization } = await signTransferAuthorization(wallet, net, { payTo: quoted.body.quote.payTo, valueTokenAtomic: BigInt(quoted.body.quote.amountTokenAtomic) });
  let delivered = await post("/v1/preflight", { intent, payment: { signature, authorization } }, token);
  for (let i = 0; i < 20 && delivered.status === 202; i++) { await sleep(1500); delivered = await get(`/v1/requests/${quoted.body.requestId}`, token); }
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body).slice(0, 300)); assert.equal(delivered.body.delivery, "DELIVERED");
  log(`report delivered; fee settled in ${delivered.body.payment.transaction}; baselineResult ${delivered.body.report.baselineResult}`);
  walletGuard.settle(feeIdx, BigInt(quoted.body.quote.amountTokenAtomic) * 10n ** 12n); saveWallet();
  // 4. the wallet attempt: VALIDATED with its plan before any signature exists
  const attempt = await post("/v1/wallet/attempts", { requestId: quoted.body.requestId, orderId: order.body.orderId, policy }, token);
  assert.equal(attempt.status, 201, JSON.stringify(attempt.body).slice(0, 400));
  assert.equal(attempt.body.state, "VALIDATED"); assert.equal(attempt.body.decision, "NO_POLICY_VIOLATION"); assert(attempt.body.plan?.nonce !== undefined);
  const plan = attempt.body.plan; const attemptId = attempt.body.attemptId as string;
  log(`attempt ${attemptId} VALIDATED until ${attempt.body.validUntil}; plan nonce ${plan.nonce} gas ${plan.gasLimit} maxFee ${Number(plan.maxFeePerGasNativeAtomic) / 1e9} gwei`);
  walletOpen = relabel(walletOpen, `${walletOpen}:attempt:${attemptId}`); sessions.put(walletBase, { attemptId, plan }); stopAfter("wallet-attempt");
  assert.equal((await get(`/v1/wallet/attempts/${attemptId}/passport`, token)).status, 409, "an open attempt is not exported");
  const second = await post("/v1/wallet/attempts", { requestId: quoted.body.requestId, orderId: order.body.orderId, policy }, token);
  assert.equal(second.status, 409); assert.equal(second.body.error, "ATTEMPT_OPEN");
  // review of 0c0d406 (P1-1): the prompt claim is exclusive — probed with two claim ids before this process signs; the holder's hand-back leaves a plain VALIDATED attempt
  const claimA = `selftest-a-${crypto.randomUUID()}`, claimB = `selftest-b-${crypto.randomUUID()}`;
  const c1 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "prompted", claimId: claimA }, token);
  assert.equal(c1.status, 200, JSON.stringify(c1.body).slice(0, 200)); assert.equal(c1.body.prompt?.state, "PROMPTED"); assert(!JSON.stringify(c1.body).includes(claimA), "the claim id must not appear in the view");
  const c2 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "prompted", claimId: claimB }, token);
  assert.equal(c2.status, 409, JSON.stringify(c2.body).slice(0, 200)); assert.equal(c2.body.error, "PROMPT_CLAIMED"); assert.equal(c2.body.attempt?.state, "VALIDATED");
  const c3 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "not-prompted", claimId: claimB }, token);
  assert.equal(c3.status, 409); assert.equal(c3.body.error, "PROMPT_CLAIMED");
  const c4 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "not-prompted", claimId: claimA }, token);
  assert.equal(c4.status, 200, JSON.stringify(c4.body).slice(0, 200)); assert.equal(c4.body.prompt, null); assert.equal(c4.body.state, "VALIDATED");
  const claimProbe = { granted: c1.status, secondClaim: `${c2.status} ${c2.body.error}`, strangerHandBack: `${c3.status} ${c3.body.error}`, holderHandBack: `${c4.status} prompt=${c4.body.prompt}` };
  log(`prompt claim probe: granted once (200), second claim ${claimProbe.secondClaim}, stranger's hand-back ${claimProbe.strangerHandBack}, holder's hand-back 200 → plain VALIDATED again`);
  // 5. the "wallet" signs EXACTLY the plan and broadcasts it itself (the service never sees the bytes), then reports the hash —
  //    within the visitor key's caps (value + gasLimit × maxFee per transaction, and the step total with the fee authorization)
  const payIdx = walletGuard.reserve({ purpose: "business payment", to: plan.to, valueNativeAtomic: BigInt(plan.valueNativeAtomic), gasLimit: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic) }); saveWallet();
  const raw = await wallet.signTransaction({ chainId: plan.chainId, type: "eip1559", to: plan.to as Hex, data: plan.data as Hex, value: BigInt(plan.valueNativeAtomic), nonce: Number(plan.nonce), gas: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGasNativeAtomic), accessList: [] });
  const parsed = parseTransaction(raw); assert.equal(parsed.to?.toLowerCase(), plan.to.toLowerCase()); assert.equal(parsed.data?.toLowerCase(), plan.data.toLowerCase());
  const txHash = keccak256(raw);
  walletGuard.sent(payIdx, txHash); saveWallet();
  walletOpen = relabel(walletOpen, `${walletOpen}:tx:${txHash}`); sessions.put(walletBase, { txHash }); // the hash is in the plan record and the session store before the broadcast
  await client.sendRawTransaction({ serializedTransaction: raw });
  log(`wallet broadcast ${txHash}`); stopAfter("wallet-sent");
  const sent = await post(`/v1/wallet/attempts/${attemptId}/sent`, { txHash }, token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300)); assert(["BROADCAST_ATTEMPTED", "CONFIRMED"].includes(sent.body.state), sent.body.state);
  let a = sent;
  for (let i = 0; i < 60 && a.body.state === "BROADCAST_ATTEMPTED"; i++) { await sleep(2000); a = await get(`/v1/wallet/attempts/${attemptId}`, token); }
  assert.equal(a.body.state, "CONFIRMED", JSON.stringify({ state: a.body.state, note: a.body.note }));
  assert.equal(a.body.businessStatus, "SUCCESS"); assert.equal(a.body.businessTxHash.toLowerCase(), txHash.toLowerCase());
  assert.deepEqual(a.body.deviations?.mismatch ?? [], [], "the wallet sent exactly the plan");
  assert.equal(a.body.recovery.interrupted, false); assert.equal(a.body.recovery.counters.businessSignatures, 0);
  log(`attempt CONFIRMED: order paid in block ${a.body.block}; cost statement buyer total ${a.body.costStatement?.buyer?.totalUsdc} USDC`);
  { const rc = await client.getTransactionReceipt({ hash: txHash }); walletGuard.settle(payIdx, BigInt(plan.valueNativeAtomic) + rc.gasUsed * rc.effectiveGasPrice); saveWallet(); log(`visitor key spend: ${walletGuard.summary().committedUsdc} USDC of the ${usdc18(walletLimits.totalNativeAtomic)} USDC cap`); }
  const shownOrder = await get(`/v1/demo/orders/${order.body.orderId}`, token); assert.equal(shownOrder.body.paid, true); assert(shownOrder.body.attempts.some((x: any) => x.attemptId === attemptId));
  // 6. passport + independent verification in a clean process
  const passport = await get(`/v1/wallet/attempts/${attemptId}/passport`, token); assert.equal(passport.status, 200);
  const passportPath = resolve(outDir, "passports", `${net}-wallet-${stamp}.passport.json`); writeFileSync(passportPath, JSON.stringify(passport.body, null, 2));
  const v = verifyInCleanProcess(passportPath, { baselineDigests: [order.body.baselineDigest], policyDigests: [pDigest] });
  log(`verifier: exit ${v.exit}, pass ${v.counts.pass}, fail ${v.counts.fail}, unverified ${v.counts.unverified ?? 0}; TRANSACTION_PLAN_AGREEMENT=${v.findings.TRANSACTION_PLAN_AGREEMENT} ORDER_OUTCOME=${v.findings.ORDER_OUTCOME} COST_STATEMENT=${v.findings.COST_STATEMENT}`);
  assert.equal(v.counts.fail, 0, JSON.stringify(v.findings));
  const manifest = JSON.parse(passport.body.files["manifest.json"]); assert.equal(manifest.subject.kind, "wallet-run"); assert.equal(manifest.subject.executionMode, "wallet");
  await afterScenario("wallet", walletOpen);
  evidence.scenarios.wallet = { payer: wallet.address, claimProbe, order: { orderId: order.body.orderId, tx: order.body.tx, block: order.body.block, amountNativeAtomic: amount.toString(), reference }, requestId: quoted.body.requestId, feeTx: delivered.body.payment.transaction, attemptId, plan, txHash, outcome: { state: a.body.state, businessStatus: a.body.businessStatus, block: a.body.block, deviations: a.body.deviations }, costStatement: a.body.costStatement, passport: passportPath, verifier: v };
}

if (toRun.includes("interrupt")) {
  const clientRunRequestId = `lc-${crypto.randomUUID()}`; const openId = `${scenarioId("interrupt")}:key:${clientRunRequestId}`; // the admission key is the durable identity, in the plan record before the POST
  await beforeScenario("interrupt", openId);
  let started = await post("/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId, interruptAfterBroadcast: true });
  if (started.status === 429 && started.body?.error === "DEMO_COOLDOWN") { // the public instance's per-client cooldown: wait it out
    const wait = (Number(network.budget?.clientCooldownSeconds ?? 45) + 2) * 1000; log(`cooldown: waiting ${wait / 1000}s`); await sleep(wait);
    started = await post("/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId, interruptAfterBroadcast: true });
  }
  assert.equal(started.status, 202, JSON.stringify(started.body)); const runId = started.body.runId as string;
  log(`live demo run ${runId} started with a labelled interruption after the broadcast`); stopAfter("interrupt-start");
  const rec = await followInterruptRun(runId, clientRunRequestId, false);
  await afterScenario("interrupt", openId);
  evidence.scenarios.interrupt = rec;
}

evidence.spend = { visitorKey: walletGuard.summary(), projectOutflow: { capUsdc: usdc18(projectCap), measuredUsdc: usdc18(meter.outflow(await syncMeasured())), baselineUsdc: usdc18(baseline), carriedBaseline: baseline !== startTotal, addresses: projectAddresses }, plan: book ? book.lines() : null };
if (book) book.apply((p) => endStep(p, "lifecycle", "done"));
log(`measured project outflow: ${evidence.spend.projectOutflow.measuredUsdc} USDC of the ${usdc18(projectCap)} USDC cap`);
log(`evidence written to ${writeEvidence("PASS")}`);
