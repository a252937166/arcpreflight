// Wallet execution (design v3.3 §3, docs/LIFECYCLE.md): a visitor's own EIP-1193 wallet executes the business payment under a
// different control model from the project runner. The service never sees the signed bytes: it validates the exact plan at a
// fresh pinned block and persists the attempt VALIDATED *before* the wallet is prompted, records the hash the wallet returns,
// compares the visible transaction with the plan after the fact (to/data/value/chainId/type must agree; wallet-set gas, fees
// and nonce are recorded as deviations), and establishes the outcome from the receipt, the order state and the merchant's
// OrderPaid event. Nothing here signs, re-signs, re-sends or re-orders. Chain access is injected for reconciliation so the
// module is testable with a fake RPC; the HTTP layer passes the process-wide client.
import { randomUUID } from "node:crypto";
import { getAddress, toHex, type Hex } from "viem";
import { IntentCore, PolicyCore, ReportCore, QuoteCore, DecisionReceipt, ExecutionReceipt, BaselineCore, policyDigest as computePolicyDigest, decisionDigest as computeDecisionDigest, executionDigest, type FinalValidationReceipt, type TransactionPlan } from "@arcpreflight/schema";
import { decide } from "@arcpreflight/policy";
import { PIN_LAG } from "@arcpreflight/observer";
import { finalValidate, outcomeFromReceipt, findNonceConsumer, paysThisOrder, GET_ORDER_ABI, ORDER_PAID_TOPIC, postconditionDigest, type ExecutionOutcome, type StoredExecution } from "@arcpreflight/runner";
import { buildPassport, toBundle, type PassportSource, type Step } from "@arcpreflight/passport";
import { cfg } from "./config.js";
import { client } from "./report.js";
import { feeParams } from "./demo.js";
import { openJson } from "./payments.js";
import { TEMPLATE, capture, reportEvidenceFor, baselineFor, settlementFor, runRecovery, runCostStatement, type PassportResult } from "./passport.js";
import { getOrderRow, type OrderRow } from "./orders.js";
import { type Db, row, rows, run, now } from "./db.js";

export type WalletAttemptState = "VALIDATED" | "REFUSED" | "BROADCAST_ATTEMPTED" | "NOT_SENT" | "CONFIRMED" | "REVERTED" | "MISMATCH" | "NOT_MINED" | "NOT_EXECUTED";
export type AttemptRow = {
  attempt_id: string; owner: string; client_key: string | null; request_id: string; order_id: string; merchant: string; payer: string; amount_atomic: string;
  intent_digest: string; report_digest: string; decision_digest: string; baseline_digest: string; policy_digest: string; final_validation_digest: string | null; plan_digest: string | null;
  policy_json: string; decision_json: string; final_validation_json: string | null; fv_evidence_json: string | null; approval_status_json: string | null; plan_json: string | null; labels_json: string;
  state: WalletAttemptState; valid_until: string | null; tx_hash: string | null; nonce: number | null; from_addr: string | null; broadcast_block: string | null; scanned_to_block: string | null; deviations_json: string | null;
  business_status: string | null; business_tx_hash: string | null; block: string | null; receipt_json: string | null; postcondition_json: string | null; note: string | null; reconciliation_json: string; refusal_json: string | null;
  fee_receipt_json: string | null; prompt_json: string | null; created_at: string; updated_at: string;
};
/** `claimId`: the prompt claim's secret, known to its holder only (never part of the attempt view); it releases an untouched claim (review of `0c0d406`, P1-1) */
export type PromptMarker = { state: "PROMPTED" | "UNKNOWN_SUBMISSION"; at: string; detail: string | null; claimId?: string };
const promptOf = (a: AttemptRow): PromptMarker | null => (a.prompt_json ? JSON.parse(a.prompt_json) : null);
/** the marker as the view shows it: without the claim id */
const publicPrompt = (a: AttemptRow): Omit<PromptMarker, "claimId"> | null => { const m = promptOf(a); if (!m) return null; const { claimId: _c, ...pub } = m; return pub; };
/** The slice of chain access reconciliation uses (a viem PublicClient satisfies it through `walletRpcFromClient`; tests inject a fake). */
export type WalletRpc = {
  getTransaction(a: { hash: Hex }): Promise<any>;
  getTransactionReceipt(a: { hash: Hex }): Promise<any>;
  getTransactionCount(a: { address: Hex; blockTag?: "latest" | "pending"; blockNumber?: bigint }): Promise<number>;
  readContract(a: { address: Hex; abi: any; functionName: string; args: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  getBlockNumber(): Promise<bigint>;
  getBlock(a: { blockNumber: bigint; includeTransactions?: boolean }): Promise<any>;
  getLogs(f: { address: Hex; topics: (Hex | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<{ transactionHash: string; blockNumber: string }[]>;
};
export function walletRpcFromClient(c: any): WalletRpc {
  return {
    getTransaction: (a) => c.getTransaction(a), getTransactionReceipt: (a) => c.getTransactionReceipt(a), getTransactionCount: (a) => c.getTransactionCount(a),
    readContract: (a) => c.readContract(a), getBlockNumber: () => c.getBlockNumber(), getBlock: (a) => c.getBlock(a),
    getLogs: async (f) => ((await c.request({ method: "eth_getLogs", params: [{ address: f.address, topics: f.topics, fromBlock: toHex(f.fromBlock), toBlock: toHex(f.toBlock) }] })) ?? []) as { transactionHash: string; blockNumber: string }[],
  };
}
const liveRpc = () => walletRpcFromClient(client);
const sleep = (ms: number) => new Promise<void>((s) => setTimeout(s, ms));
const labelsFor = () => (cfg.net === "mainnet" ? ["LIVE_REQUEST", "DEMO_ON_MAINNET"] : ["LIVE_REQUEST"]);
/** how long after the validation window an unreported or unmined attempt stays open before it is closed without a transaction */
export const WALLET_CLOSE_AFTER_MS = 24 * 3600_000;
export const ATTEMPTS_PER_CLIENT_PER_DAY = Number(process.env.WALLET_ATTEMPTS_PER_CLIENT_PER_DAY ?? 60);
/** a polling browser observes at most this often; the chain is not re-read for every GET */
const OBSERVE_MIN_INTERVAL_MS = 1500;

export type AttemptResult = { ok: true; status: number; attempt: ReturnType<typeof shapeAttempt> } | { ok: false; status: number; error: string; reason: string; reasons?: string[]; attemptId?: string | null; /** the current attempt, when a conflict is best answered with it (PROMPT_CLAIMED) */ attempt?: ReturnType<typeof shapeAttempt> };
const bad = (reason: string): AttemptResult => ({ ok: false, status: 400, error: "INVALID_INPUT", reason });
const conflict = (error: string, reason: string, extra: Partial<AttemptResult> = {}): AttemptResult => ({ ok: false, status: 409, error, reason, ...(extra as object) });
const notFound: AttemptResult = { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown attempt" }; // no existence leak across owners

/** POST /v1/wallet/attempts: server-side final validation for the wallet payer; the attempt is durable before any prompt. */
export async function createWalletAttempt(db: Db, principal: string, clientKey: string | null, body: any): Promise<AttemptResult> {
  const requestId = String(body?.requestId ?? ""); const orderId = String(body?.orderId ?? "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(requestId)) return bad("requestId must be the id of a delivered check");
  if (!/^0x[0-9a-f]{64}$/.test(orderId)) return bad("orderId must be a 32-byte hex id");
  const pol = PolicyCore.safeParse(body?.policy);
  if (!pol.success) return bad("policy must be the buyer's PolicyCore that the intent references (its digest is intent.policyDigest)");
  const policy = pol.data; const pDigest = computePolicyDigest(policy);
  if (policy.maxFinalValidationAgeSeconds > 120) return bad("policy.maxFinalValidationAgeSeconds must be at most 120 seconds: a wallet prompt is human-paced, but the plan must not outlive the state it was validated against");
  const req = row(db, "SELECT * FROM requests WHERE request_id = ?", requestId);
  if (!req || req.principal !== principal) return { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown check" };
  const intent = IntentCore.parse(JSON.parse(req.intent_json));
  if (intent.policyDigest.toLowerCase() !== pDigest.toLowerCase()) return bad("the supplied policy is not the one the intent references (digest mismatch)");
  if (intent.businessExpectation.action !== "MERCHANT_PAY" || intent.businessExpectation.orderId.toLowerCase() !== orderId) return bad("the check's intent is not bound to this order");
  const order = getOrderRow(db, orderId);
  if (!order || order.owner !== principal) return { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown order" };
  if (order.state !== "CONFIRMED") return conflict("ORDER_NOT_CONFIRMED", `the order is ${order.state}; only a confirmed order can be paid`);
  if (order.payer !== intent.from.toLowerCase() || order.merchant !== intent.to.toLowerCase() || BigInt(order.amount_atomic) !== BigInt(intent.businessExpectation.amountNativeAtomic)) return conflict("ORDER_MISMATCH", "the order's payer, merchant or amount differs from the check's business expectation");
  if (order.paid === 1) return conflict("ORDER_ALREADY_PAID", "this order already reads as paid");
  const q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId); const p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!q || !p || p.state !== "COMPLETED") return conflict("CHECK_NOT_DELIVERED", "the check fee has not settled; the report must be delivered before anything is executed");
  const rep = row(db, "SELECT * FROM reports WHERE report_digest = ?", q.report_digest);
  if (!rep) return conflict("CHECK_NOT_DELIVERED", "the delivered report is not on record");
  const report = ReportCore.parse(JSON.parse(rep.report_json)); const ev = JSON.parse(rep.evidence_json); const simulation = ev?.simulation ?? null;
  if (row(db, "SELECT 1 FROM wallet_attempts WHERE order_id = ? AND state IN ('VALIDATED','BROADCAST_ATTEMPTED') LIMIT 1", orderId)) return conflict("ATTEMPT_OPEN", "an attempt for this order is still open; abandon it or let it reconcile before validating another");
  // validation is RPC-heavy (snapshot, reads, simulation, estimate, bounded wait): bounded per client and day. Audit 2026-10-10 (API-04):
  // the admission is RESERVED here, atomically and before any await, and never given back (a refused or failed validation keeps its slot);
  // one validation runs per client at a time, so a burst of concurrent requests admits only what the quota still allows
  const today = now().slice(0, 10);
  const admissionKey = clientKey ?? principal;
  if (inflightValidations.has(admissionKey)) return { ok: false, status: 429, error: "RATE_LIMITED", reason: "a validation is already in progress for this client; wait for it to finish" };
  if (!admitValidation(db, admissionKey, today, ATTEMPTS_PER_CLIENT_PER_DAY)) return { ok: false, status: 429, error: "RATE_LIMITED", reason: `at most ${ATTEMPTS_PER_CLIENT_PER_DAY} wallet attempts per client per day` };
  inflightValidations.add(admissionKey);
  try { return await validateAdmitted(db, principal, clientKey, req, { requestId, orderId, intent, order, q, p, report, simulation, policy, pDigest }); }
  finally { inflightValidations.delete(admissionKey); }
}
/** the in-flight validations by client (one at a time per client) */
const inflightValidations = new Set<string>();
/** one more admission for the client today, if the quota allows: an atomic counter update, so concurrent requests cannot all pass the same check */
export function admitValidation(db: Db, key: string, day: string, cap: number): boolean {
  run(db, "INSERT OR IGNORE INTO wallet_admissions (client_key, day, count) VALUES (?, ?, 0)", key, day);
  const r = db.prepare("UPDATE wallet_admissions SET count = count + 1 WHERE client_key = ? AND day = ? AND count < ?").run(key, day, cap);
  return Number(r.changes) === 1;
}
export const admissionsToday = (db: Db, key: string, day: string): number => Number(row(db, "SELECT count FROM wallet_admissions WHERE client_key = ? AND day = ?", key, day)?.count ?? 0);
async function validateAdmitted(db: Db, principal: string, clientKey: string | null, req: any, a: { requestId: string; orderId: string; intent: any; order: any; q: any; p: any; report: any; simulation: any; policy: any; pDigest: Hex }): Promise<AttemptResult> {
  const { requestId, orderId, intent, order, q, p, report, simulation, policy, pDigest } = a;
  const attemptId = randomUUID();
  const approval = () => { const b = row(db, "SELECT * FROM baselines WHERE baseline_digest = ?", intent.baselineDigest); return { baseline: b ? BaselineCore.parse(JSON.parse(b.baseline_json)) : null, baselineDigest: (b?.baseline_digest as Hex | undefined) ?? null, baselineRevoked: !!b?.revoked }; };
  const { decision, reasons } = decide({ intent, policy, policyDigest: pDigest, ...approval(), report, reportDigest: q.report_digest as Hex, now: new Date(), simulation });
  const decisionReceipt = DecisionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: attemptId, intentDigest: req.intent_digest, reportDigest: q.report_digest, baselineDigest: intent.baselineDigest, policyDigest: pDigest, decision, reasons, decidedAt: now() });
  const dDigest = computeDecisionDigest(decisionReceipt);
  const insert = (state: WalletAttemptState, extra: { fv?: FinalValidationReceipt | null; fvDigest?: Hex | null; plan?: TransactionPlan | null; planDigest?: Hex | null; evidence?: unknown[]; approvalStatus?: unknown; refusal?: unknown; validUntil?: string | null }) =>
    run(db, `INSERT INTO wallet_attempts (attempt_id, owner, client_key, request_id, order_id, merchant, payer, amount_atomic, intent_digest, report_digest, decision_digest, baseline_digest, policy_digest, final_validation_digest, plan_digest,
      policy_json, decision_json, final_validation_json, fv_evidence_json, approval_status_json, plan_json, labels_json, state, valid_until, refusal_json, reconciliation_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      attemptId, principal, clientKey, requestId, orderId, order.merchant, order.payer, order.amount_atomic, req.intent_digest, q.report_digest, dDigest, intent.baselineDigest, pDigest, extra.fvDigest ?? null, extra.planDigest ?? null,
      JSON.stringify(policy), JSON.stringify(decisionReceipt), extra.fv ? JSON.stringify(extra.fv) : null, extra.evidence ? JSON.stringify(extra.evidence) : null, extra.approvalStatus ? JSON.stringify(extra.approvalStatus) : null, extra.plan ? JSON.stringify(extra.plan) : null,
      JSON.stringify(labelsFor()), state, extra.validUntil ?? null, extra.refusal ? JSON.stringify(extra.refusal) : null, "[]", now(), now());
  if (decision !== "NO_POLICY_VIOLATION") {
    insert("REFUSED", { refusal: { stage: "decision", decision, reasons } });
    return conflict("VALIDATION_FAILED", `the decision is ${decision}: nothing is executed`, { reasons, attemptId });
  }
  // the final-validation snapshot must follow the fee confirmation and the order creation
  let feeBlock: bigint | null = null;
  try { const sev = p.settlement_evidence_json ? JSON.parse(p.settlement_evidence_json) : null; if (sev?.blockNumber) feeBlock = BigInt(sev.blockNumber); } catch { feeBlock = null; }
  if (feeBlock === null && p.tx_hash) { const rc = await client.getTransactionReceipt({ hash: p.tx_hash as Hex }).catch(() => null); if (rc?.blockNumber !== undefined && rc?.blockNumber !== null) feeBlock = BigInt(rc.blockNumber); }
  const orderBlock = order.block ? BigInt(order.block) : 0n;
  const v = await finalValidate({ publicClient: client, net: cfg.net, chainId: cfg.chainId, merchant: getAddress(order.merchant) as Hex, intent, report, policy, attemptId, intentDigest: req.intent_digest as Hex, reportDigest: q.report_digest as Hex, decisionDigest: dDigest, policyDigest: pDigest, baselineDigest: intent.baselineDigest as Hex,
    approval: async () => approval(), signer: { address: getAddress(order.payer) as Hex, type: "wallet", requireLocal: false }, feeBlock, orderBlock, feeParams, providerId: `rpc.${cfg.net}`,
    waitForBlock: async (required) => { for (let n = 0; n < 25; n++) { const head = await client.getBlockNumber(); if (head >= required + PIN_LAG) return; await sleep(1000); } } });
  const pass = v.finalValidation.result === "PASS";
  try { insert(pass ? "VALIDATED" : "REFUSED", { fv: v.finalValidation, fvDigest: v.finalValidationDigest, plan: v.plan, planDigest: v.planDigest, evidence: v.evidence, approvalStatus: v.approvalStatusAtValidation, validUntil: v.finalValidation.expiresAt, refusal: pass ? null : { stage: "finalValidation", reasons: v.reasons } }); }
  catch (e: any) { // the partial unique index: another request validated an attempt for this order meanwhile
    if (/UNIQUE constraint failed: wallet_attempts\.order_id|wallet_attempts_one_open/.test(String(e?.message ?? e))) return conflict("ATTEMPT_OPEN", "an attempt for this order was validated by a concurrent request; continue, abandon or recover that one");
    throw e;
  }
  if (!pass) return conflict("VALIDATION_FAILED", "final validation did not pass; nothing is signed", { reasons: v.reasons, attemptId });
  return { ok: true, status: 201, attempt: shapeAttempt(db, getAttemptRow(db, attemptId)!) };
}

export const getAttemptRow = (db: Db, attemptId: string): AttemptRow | undefined => row<AttemptRow>(db, "SELECT * FROM wallet_attempts WHERE attempt_id = ?", attemptId);
const owned = (db: Db, principal: string, attemptId: string): AttemptRow | null => { const a = getAttemptRow(db, attemptId); return a && a.owner === principal ? a : null; };

/** POST …/sent: the wallet returned a hash. From here on the transaction MAY be on the network; the fields are compared once visible. */
export async function markSent(db: Db, principal: string, attemptId: string, txHash: string, rpc: WalletRpc = liveRpc()): Promise<AttemptResult> {
  const a = owned(db, principal, attemptId); if (!a) return notFound;
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) return bad("txHash must be a 32-byte transaction hash");
  if (a.state !== "VALIDATED") {
    // review of 0d14ad9: a report whose answer was lost is repeated — the same hash on the attempt it already moved is the same report: 200, nothing changes
    if (a.tx_hash && a.tx_hash.toLowerCase() === txHash.toLowerCase()) return { ok: true, status: 200, attempt: shapeAttempt(db, a) };
    return conflict("ATTEMPT_NOT_OPEN", `the attempt is ${a.state}; a hash can be reported once, for a validated attempt`);
  }
  const head = await rpc.getBlockNumber().then((b) => b.toString()).catch(() => null);
  run(db, "UPDATE wallet_attempts SET state = 'BROADCAST_ATTEMPTED', tx_hash = ?, broadcast_block = ?, note = ?, updated_at = ? WHERE attempt_id = ? AND state = 'VALIDATED'", txHash.toLowerCase(), head, "hash reported by the wallet; the transaction may be on the network; fields are compared with the plan once it is visible", now(), attemptId);
  await reconcileWalletAttempts(db, rpc, { attemptId, source: "sent" }).catch(() => {});
  return { ok: true, status: 200, attempt: shapeAttempt(db, getAttemptRow(db, attemptId)!) };
}
const PROMPTED_NOTE = "the wallet was asked to sign this plan; until a hash is reported or the visitor states a rejection, the transaction may have been submitted";
const UNKNOWN_NOTE = "the wallet returned an error that is not a rejection; the transaction may have been submitted — reconciled from the order state before anything else";
const RELEASED_NOTE = "the prompt claim was handed back by its holder before any wallet request (its re-check right before the prompt failed); nothing was prompted";
/** POST …/prompt — the prompt CLAIM (review round 3 and the review of `0c0d406`, docs/LIFECYCLE.md §10). `prompted`: the browser is about to
 *  ask the wallet; the claim is granted atomically to the FIRST caller only (the marker is written where none exists, in one statement), so a
 *  second tab, a stale view or a retry gets 409 PROMPT_CLAIMED with the attempt and reconciles instead of prompting again. `unknown-submission`:
 *  the wallet answered with something that is not a rejection — recorded on top of the claim (a claim id, when given, must be the holder's),
 *  never downgraded. `not-prompted`: the holder states that it did NOT ask the wallet after all (its re-check right before the prompt failed)
 *  and hands the claim back with its claim id; a claim that already turned into UNKNOWN_SUBMISSION, somebody else's claim or a closed attempt
 *  is never released. Either marker makes a VALIDATED attempt uncertain: it is reconciled from the chain before anything else may be signed,
 *  and a page refresh restores the uncertainty. The claim id never appears in the attempt view.
 *  Review of 0d14ad9 (2026-10-10): a repeat of the holder's own successful call is the same call (a lost answer is retried safely): `prompted`
 *  under the claim id that holds the PROMPTED marker answers 200 with the grant standing, `not-prompted` with nothing held answers 200 unchanged,
 *  a repeated `unknown-submission` keeps its first moment. */
export function markPrompted(db: Db, principal: string, attemptId: string, body: any): AttemptResult {
  const a = owned(db, principal, attemptId); if (!a) return notFound;
  const event = String(body?.event ?? "");
  if (event !== "prompted" && event !== "unknown-submission" && event !== "not-prompted") return bad("event must be prompted, unknown-submission or not-prompted");
  if (a.state !== "VALIDATED") return conflict("ATTEMPT_NOT_OPEN", `the attempt is ${a.state}; a prompt is recorded for a validated attempt only`);
  const claimId = typeof body?.claimId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.claimId) ? body.claimId : null;
  const detail = typeof body?.detail === "string" ? body.detail.slice(0, 200) : null;
  const view = () => shapeAttempt(db, getAttemptRow(db, attemptId)!);
  const prior = promptOf(a);
  if (event === "prompted") {
    const next: PromptMarker = { state: "PROMPTED", at: now(), detail, claimId: claimId ?? randomUUID() };
    const r = run(db, "UPDATE wallet_attempts SET prompt_json = ?, note = ?, updated_at = ? WHERE attempt_id = ? AND state = 'VALIDATED' AND prompt_json IS NULL", JSON.stringify(next), PROMPTED_NOTE, now(), attemptId);
    if (Number(r.changes) === 1) return { ok: true, status: 200, attempt: view() };
    const held = promptOf(getAttemptRow(db, attemptId)!);
    if (held?.state === "PROMPTED" && claimId && held.claimId === claimId) return { ok: true, status: 200, attempt: view() }; // the holder asks again: its grant stands
    return conflict("PROMPT_CLAIMED", `the wallet prompt for this attempt was already claimed at ${held?.at ?? "an earlier time"} (${held?.state ?? "marker present"}); the transaction may have been submitted — reconcile instead of prompting again`, { attempt: view() });
  }
  if (event === "unknown-submission") {
    if (prior?.claimId && claimId && claimId !== prior.claimId) return conflict("PROMPT_CLAIMED", "another prompt claim holds this attempt; its holder's answer decides — reconcile instead", { attempt: view() });
    const next: PromptMarker = { state: "UNKNOWN_SUBMISSION", at: prior?.state === "UNKNOWN_SUBMISSION" ? prior.at : now(), detail: detail ?? prior?.detail ?? null, ...(prior?.claimId ?? claimId ? { claimId: prior?.claimId ?? claimId! } : {}) }; // repeated: the first moment stands
    run(db, "UPDATE wallet_attempts SET prompt_json = ?, note = ?, updated_at = ? WHERE attempt_id = ? AND state = 'VALIDATED'", JSON.stringify(next), UNKNOWN_NOTE, now(), attemptId);
    return { ok: true, status: 200, attempt: view() };
  }
  // not-prompted: hand back the holder's untouched claim — compare-and-set on the exact marker that was read, so a concurrent change wins
  if (!prior) return { ok: true, status: 200, attempt: view() }; // nothing is held: a release repeated after a lost answer finds the attempt unclaimed — 200, unchanged
  if (prior.state !== "PROMPTED") return conflict("PROMPT_NOT_RELEASABLE", `the marker is ${prior.state}: the wallet answered ambiguously, so the claim cannot be handed back — reconcile instead`, { attempt: view() });
  if (!prior.claimId || !claimId || claimId !== prior.claimId) return conflict("PROMPT_CLAIMED", "only the holder of the prompt claim may hand it back (claim id mismatch); reconcile instead", { attempt: view() });
  const r = run(db, "UPDATE wallet_attempts SET prompt_json = NULL, note = ?, updated_at = ? WHERE attempt_id = ? AND state = 'VALIDATED' AND prompt_json = ?", RELEASED_NOTE, now(), attemptId, a.prompt_json);
  if (Number(r.changes) !== 1) return conflict("PROMPT_NOT_RELEASABLE", "the marker changed while it was being handed back; reconcile instead", { attempt: view() });
  return { ok: true, status: 200, attempt: view() };
}
/** POST …/abandon: the wallet prompt was rejected; nothing was sent. */
export function abandonAttempt(db: Db, principal: string, attemptId: string): AttemptResult {
  const a = owned(db, principal, attemptId); if (!a) return notFound;
  if (a.state === "NOT_SENT") return { ok: true, status: 200, attempt: shapeAttempt(db, a) }; // review of 0d14ad9: abandoning again is the same statement — 200, unchanged
  if (a.state !== "VALIDATED") return conflict("ATTEMPT_NOT_OPEN", `the attempt is ${a.state}; only a validated attempt can be abandoned`);
  run(db, "UPDATE wallet_attempts SET state = 'NOT_SENT', business_status = 'NOT_EXECUTED', note = ?, updated_at = ? WHERE attempt_id = ? AND state = 'VALIDATED'", "the wallet prompt was rejected or abandoned by the visitor; nothing was sent; the order stays unpaid", now(), attemptId);
  return { ok: true, status: 200, attempt: shapeAttempt(db, getAttemptRow(db, attemptId)!) };
}
/** GET …/{id}: observe (reads only), then shape. */
export async function observeAttempt(db: Db, principal: string, attemptId: string, rpc: WalletRpc = liveRpc()): Promise<AttemptResult> {
  const a = owned(db, principal, attemptId); if (!a) return notFound;
  const recentlyObserved = Date.now() - new Date(a.updated_at).getTime() < OBSERVE_MIN_INTERVAL_MS;
  if ((a.state === "VALIDATED" || a.state === "BROADCAST_ATTEMPTED") && !recentlyObserved) await reconcileWalletAttempts(db, rpc, { attemptId, source: "observe" }).catch(() => {});
  else if (a.state !== "VALIDATED" && a.state !== "BROADCAST_ATTEMPTED" && !a.fee_receipt_json) await ensureFeeReceipt(db, rpc, a).catch(() => {}); // a closed attempt still receives a late fee receipt (review round 3, item 7)
  return { ok: true, status: 200, attempt: shapeAttempt(db, getAttemptRow(db, attemptId)!) };
}
/** Worker: closed attempts of the last day whose fee relay receipt was not yet captured (bounded), so page and passport agree. */
export async function backfillFeeReceipts(db: Db, rpc: WalletRpc, limit = 10): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString(); let n = 0;
  for (const a of rows<AttemptRow>(db, "SELECT * FROM wallet_attempts WHERE fee_receipt_json IS NULL AND state NOT IN ('VALIDATED','BROADCAST_ATTEMPTED') AND created_at > ? ORDER BY created_at DESC LIMIT ?", cutoff, limit)) {
    await ensureFeeReceipt(db, rpc, a).catch(() => {}); if (getAttemptRow(db, a.attempt_id)?.fee_receipt_json) n++;
  }
  return n;
}
/** POST …/recover: the owner asks for a bounded reconciliation of THAT attempt now (same reads as the worker; nothing is sent). */
export async function recoverAttempt(db: Db, principal: string, attemptId: string, rpc: WalletRpc = liveRpc(), log: (m: string) => void = () => {}): Promise<AttemptResult> {
  const a = owned(db, principal, attemptId); if (!a) return notFound;
  await reconcileWalletAttempts(db, rpc, { attemptId, source: "recover", log });
  return { ok: true, status: 200, attempt: shapeAttempt(db, getAttemptRow(db, attemptId)!) };
}
export function listAttempts(db: Db, principal: string, limit = 50) {
  return rows<AttemptRow>(db, "SELECT * FROM wallet_attempts WHERE owner = ? ORDER BY created_at DESC LIMIT ?", principal, limit).map((a) => shapeAttempt(db, a, { brief: true }));
}

// ---- after-the-fact comparison with the validated plan
export type Comparison = { mismatch: string[]; deviations: Record<string, { plan: string; actual: string }> };
export function compareWithPlan(tx: any, plan: TransactionPlan): Comparison {
  const mismatch: string[] = []; const deviations: Comparison["deviations"] = {};
  const low = (v: unknown) => String(v ?? "").toLowerCase();
  if (low(tx.to) !== plan.to.toLowerCase()) mismatch.push("to");
  if (low(tx.input ?? tx.data) !== plan.data.toLowerCase()) mismatch.push("data");
  if (BigInt(tx.value ?? 0) !== BigInt(plan.valueNativeAtomic)) mismatch.push("value");
  if (tx.chainId !== undefined && tx.chainId !== null && Number(tx.chainId) !== plan.chainId) mismatch.push("chainId");
  if (tx.type !== undefined && tx.type !== null && !(tx.type === "eip1559" || tx.type === "0x2" || tx.type === 2)) mismatch.push("type");
  if (tx.from !== undefined && low(tx.from) !== plan.from.toLowerCase()) mismatch.push("from");
  const dev = (name: string, actual: unknown, planned: string) => { if (actual !== undefined && actual !== null && BigInt(actual as any) !== BigInt(planned)) deviations[name] = { plan: planned, actual: BigInt(actual as any).toString() }; };
  dev("gasLimit", tx.gas, plan.gasLimit); dev("maxFeePerGas", tx.maxFeePerGas, plan.maxFeePerGasNativeAtomic); dev("maxPriorityFeePerGas", tx.maxPriorityFeePerGas, plan.maxPriorityFeePerGasNativeAtomic); dev("nonce", tx.nonce, plan.nonce);
  return { mismatch, deviations };
}

/** Bounded eth_getLogs search for OrderPaid(orderId) emitted by the merchant: chunks of `chunk` blocks, at most `maxChunks` per call. */
export async function searchOrderPaid(rpc: WalletRpc, merchant: Hex, orderId: Hex, fromBlock: bigint, toBlock: bigint, chunk = BigInt(cfg.relay?.scanChunkBlocks ?? 9000), maxChunks = cfg.relay?.scanChunksPerCall ?? 3): Promise<{ found: { hash: Hex; block: bigint } | null; scannedTo: bigint }> {
  let from = fromBlock; let scannedTo = fromBlock - 1n;
  for (let i = 0; i < maxChunks && from <= toBlock; i++) {
    const to = from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n;
    const logs = await rpc.getLogs({ address: merchant, topics: [ORDER_PAID_TOPIC as Hex, orderId], fromBlock: from, toBlock: to });
    if (logs.length) return { found: { hash: logs[0].transactionHash as Hex, block: BigInt(logs[0].blockNumber) }, scannedTo: to };
    scannedTo = to; from = to + 1n;
  }
  return { found: null, scannedTo };
}

type Source = "worker" | "recover" | "observe" | "sent";
/** The check fee's relay receipt (gas paid by the operator), read once so the attempt's cost statement is complete on the operator side. */
async function ensureFeeReceipt(db: Db, rpc: WalletRpc, a: AttemptRow) {
  if (a.fee_receipt_json) return;
  const p = row(db, "SELECT tx_hash FROM payments WHERE request_id = ?", a.request_id);
  if (!p?.tx_hash) return;
  const rc = await rpc.getTransactionReceipt({ hash: p.tx_hash as Hex }).catch(() => null);
  if (!rc) return;
  run(db, "UPDATE wallet_attempts SET fee_receipt_json = ? WHERE attempt_id = ? AND fee_receipt_json IS NULL", JSON.stringify({ ...receiptFacts(rc), tx: p.tx_hash }), a.attempt_id);
}
/** A transaction identified through the merchant's OrderPaid event (or a same-nonce replacement) closes the attempt only with its receipt
 *  AND its fields compared with the validated plan (review round 2): the event alone proves nothing about what was sent. */
async function closeFromFoundTransaction(db: Db, rpc: WalletRpc, a: AttemptRow, subject: { merchant: Hex; orderId: Hex; payer: Hex; amountNativeAtomic: string }, found: Hex, how: string, opts: { record: boolean; prior?: Comparison | null; nonce?: number | null; from?: string | null }): Promise<"closed" | "pending"> {
  const plan: TransactionPlan | null = a.plan_json ? JSON.parse(a.plan_json) : null;
  const [tx, rc] = await Promise.all([rpc.getTransaction({ hash: found }).catch(() => null), rpc.getTransactionReceipt({ hash: found }).catch(() => null)]);
  if (!rc || !tx) { pendingNote(db, a, `${how}: transaction ${found} was identified but its ${!rc ? "receipt" : "body"} is not visible on this node yet; nothing is concluded`, { deviations: opts.prior ?? null, nonce: opts.nonce ?? null, from: opts.from ?? null }); return "pending"; }
  const comparison = plan ? compareWithPlan(tx, plan) : null;
  const mismatch = !!comparison?.mismatch.length;
  const o = await outcomeFromReceipt(rpc as any, subject, found, rc);
  const note = `${how}; ${mismatch ? `the transaction deviates from the validated plan in ${comparison!.mismatch.join(", ")}; the order state decides whether the order was paid; ` : "its fields agree with the validated plan; "}nothing was re-signed or re-sent by this service`;
  run(db, "UPDATE wallet_attempts SET tx_hash = COALESCE(tx_hash, ?), nonce = COALESCE(?, nonce), from_addr = COALESCE(?, from_addr) WHERE attempt_id = ?", found.toLowerCase(), tx.nonce !== undefined && tx.nonce !== null ? Number(tx.nonce) : null, tx.from ? String(tx.from).toLowerCase() : null, a.attempt_id);
  close(db, a, mismatch ? "MISMATCH" : o.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED", { ...o, note }, { record: opts.record, receipt: rc, deviations: comparison, consumedBy: found.toLowerCase() === (a.tx_hash ?? "").toLowerCase() ? null : found });
  return "closed";
}
const receiptFacts = (rc: any) => ({ from: rc?.from ?? null, gasUsed: rc?.gasUsed !== undefined && rc?.gasUsed !== null ? String(rc.gasUsed) : null, effectiveGasPriceNativeAtomic: rc?.effectiveGasPrice !== undefined && rc?.effectiveGasPrice !== null ? String(rc.effectiveGasPrice) : null, blockNumber: rc?.blockNumber !== undefined && rc?.blockNumber !== null ? String(rc.blockNumber) : null, status: rc?.status !== undefined ? String(rc.status) : null });
type CloseOutcome = Omit<ExecutionOutcome, "chainStatus"> & { chainStatus: ExecutionOutcome["chainStatus"] | "NOT_SIGNED" };
function close(db: Db, a: AttemptRow, state: WalletAttemptState, o: CloseOutcome, opts: { record: boolean; receipt?: any; deviations?: Comparison | null; consumedBy?: Hex | null }) {
  const history: unknown[] = JSON.parse(a.reconciliation_json || "[]");
  if (opts.record) history.push({ at: now(), chainStatus: o.chainStatus, businessStatus: o.businessStatus, note: o.note ?? null, consumedBy: opts.consumedBy ?? null });
  run(db, "UPDATE wallet_attempts SET state = ?, business_status = ?, business_tx_hash = ?, block = ?, postcondition_json = ?, receipt_json = COALESCE(?, receipt_json), deviations_json = COALESCE(?, deviations_json), note = ?, reconciliation_json = ?, updated_at = ? WHERE attempt_id = ?",
    state, o.businessStatus, o.businessTxHash?.toLowerCase() ?? null, o.block ?? null, o.postcondition ? JSON.stringify(o.postcondition) : null, opts.receipt ? JSON.stringify(receiptFacts(opts.receipt)) : null, opts.deviations ? JSON.stringify(opts.deviations) : null, o.note ?? null, JSON.stringify(history), now(), a.attempt_id);
}
const pendingNote = (db: Db, a: AttemptRow, note: string, extra: { scannedTo?: bigint | null; deviations?: Comparison | null; nonce?: number | null; from?: string | null } = {}) =>
  run(db, "UPDATE wallet_attempts SET note = ?, scanned_to_block = COALESCE(?, scanned_to_block), deviations_json = COALESCE(?, deviations_json), nonce = COALESCE(?, nonce), from_addr = COALESCE(?, from_addr), updated_at = ? WHERE attempt_id = ?",
    note, extra.scannedTo !== undefined && extra.scannedTo !== null ? extra.scannedTo.toString() : null, extra.deviations ? JSON.stringify(extra.deviations) : null, extra.nonce ?? null, extra.from?.toLowerCase() ?? null, now(), a.attempt_id);

/** Resolve open wallet attempts from chain facts. Never sends. `source` decides whether a closing is recorded as a reconciliation
 *  entry: the worker and the recovery command act after the browser went away (recovery); the observe and sent paths are the
 *  normal flow of a browser that stayed. An outcome recovered through the OrderPaid event is always recorded. */
export async function reconcileWalletAttempts(db: Db, rpc: WalletRpc, opts: { attemptId?: string | null; now?: Date; source: Source; log?: (m: string) => void }): Promise<{ resolved: number; pending: number }> {
  const open: AttemptRow[] = opts.attemptId ? rows(db, "SELECT * FROM wallet_attempts WHERE state IN ('VALIDATED','BROADCAST_ATTEMPTED') AND attempt_id = ?", opts.attemptId) : rows(db, "SELECT * FROM wallet_attempts WHERE state IN ('VALIDATED','BROADCAST_ATTEMPTED') ORDER BY created_at");
  const at = opts.now ?? new Date(); const record = opts.source === "worker" || opts.source === "recover";
  const log = opts.log ?? (() => {});
  let resolved = 0, pending = 0;
  for (const a of open) {
    try {
      await ensureFeeReceipt(db, rpc, a).catch(() => {});
      const merchant = getAddress(a.merchant) as Hex, orderId = a.order_id as Hex;
      const subject = { merchant, orderId, payer: a.payer as Hex, amountNativeAtomic: a.amount_atomic };
      const validUntil = a.valid_until ? new Date(a.valid_until).getTime() : new Date(a.created_at).getTime();
      const readOrder = async () => { const ord = (await rpc.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] })) as readonly unknown[]; return { payer: String(ord[0]), amount: BigInt(ord[1] as bigint | string), paid: ord[2] === true }; };
      const startBlock = a.scanned_to_block ? BigInt(a.scanned_to_block) + 1n : a.broadcast_block ? BigInt(a.broadcast_block) - 2n : null;
      if (a.state === "VALIDATED") {
        // inside the window the wallet prompt may still be open: only an explicit recovery command looks at the chain now ("reconcile first"
        // after an ambiguous wallet error); the worker and observe reads wait for the window to close
        const uncertain = !!promptOf(a);
        if (validUntil > at.getTime() && opts.source !== "recover" && !(uncertain && opts.source === "observe")) { pending++; continue; }
        const ord = await readOrder();
        if (ord.paid) {
          const head = await rpc.getBlockNumber();
          const orderRow = getOrderRow(db, a.order_id);
          const from = startBlock ?? (orderRow?.block ? BigInt(orderRow.block) : head > 50_000n ? head - 50_000n : 0n);
          const s = await searchOrderPaid(rpc, merchant, orderId, from, head);
          if (s.found) {
            const done = await closeFromFoundTransaction(db, rpc, a, subject, s.found.hash, `no hash was reported by the browser; the order was paid by transaction ${s.found.hash}, recovered through the merchant's OrderPaid event`, { record: true });
            if (done === "closed") { resolved++; log(`${a.attempt_id}: closed from OrderPaid ${s.found.hash}`); } else pending++;
            continue;
          }
          pendingNote(db, a, "the order reads as paid but the paying transaction has not been identified yet (bounded log search continues)", { scannedTo: s.scannedTo }); pending++; continue;
        }
        if (validUntil > at.getTime()) { pendingNote(db, a, uncertain ? "the wallet was asked to sign this plan and reconciliation found no payment for this order yet; the transaction may still appear — recover again, or abandon only if you know you rejected the prompt" : "recovery found no payment for this order yet; the validation window is still open — confirm in your wallet, or abandon if you rejected the prompt"); pending++; continue; }
        if (at.getTime() > validUntil + WALLET_CLOSE_AFTER_MS) {
          close(db, a, "NOT_SENT", { chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "no transaction was reported within 24 h of the validation window and the order reads as unpaid; closed without a transaction" }, { record });
          resolved++; log(`${a.attempt_id}: NOT_SENT`); continue;
        }
        pendingNote(db, a, "the validation window closed without a reported hash; the order reads as unpaid; the attempt closes after 24 h unless the order becomes paid"); pending++; continue;
      }
      // BROADCAST_ATTEMPTED: a hash was reported
      const hash = a.tx_hash as Hex;
      const plan: TransactionPlan | null = a.plan_json ? JSON.parse(a.plan_json) : null;
      let comparison: Comparison | null = a.deviations_json ? JSON.parse(a.deviations_json) : null;
      let nonce: number | null = a.nonce; let from: string | null = a.from_addr;
      const tx = await rpc.getTransaction({ hash }).catch(() => null);
      if (tx && plan) { comparison = compareWithPlan(tx, plan); nonce = tx.nonce !== undefined && tx.nonce !== null ? Number(tx.nonce) : nonce; from = tx.from ?? from; }
      const mismatch = !!comparison?.mismatch.length;
      const mismatchNote = mismatch ? `the transaction the wallet sent deviates from the validated plan in ${comparison!.mismatch.join(", ")}; the order state decides whether the order was paid` : "";
      const rc = await rpc.getTransactionReceipt({ hash }).catch(() => null);
      if (rc && (!tx || !plan)) { // the receipt alone cannot close the attempt: the plan comparison needs the transaction body (review round 3, item 2)
        pendingNote(db, a, "the receipt is visible but the transaction body is not served by this node yet; the comparison with the validated plan is outstanding, so nothing is concluded", { deviations: comparison, nonce, from }); pending++; continue;
      }
      if (rc) {
        const o = await outcomeFromReceipt(rpc as any, subject, hash, rc);
        const state: WalletAttemptState = mismatch ? "MISMATCH" : o.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED";
        run(db, "UPDATE wallet_attempts SET nonce = COALESCE(?, nonce), from_addr = COALESCE(?, from_addr) WHERE attempt_id = ?", nonce, from?.toLowerCase() ?? null, a.attempt_id);
        close(db, a, state, { ...o, note: mismatch ? `${mismatchNote}; ${o.note ?? ""}` : (o.note ?? "") }, { record, receipt: rc, deviations: comparison });
        resolved++; log(`${a.attempt_id}: ${state} (${o.chainStatus}/${o.businessStatus})`); continue;
      }
      const ord = await readOrder();
      if (ord.paid) {
        const head = await rpc.getBlockNumber();
        const from0 = startBlock ?? (head > 50_000n ? head - 50_000n : 0n);
        const s = await searchOrderPaid(rpc, merchant, orderId, from0 < 0n ? 0n : from0, head);
        if (s.found) {
          const same = s.found.hash.toLowerCase() === hash.toLowerCase();
          const done = await closeFromFoundTransaction(db, rpc, a, subject, s.found.hash, same ? "the receipt became visible through the OrderPaid event" : `the reported hash ${hash} was not mined; the order was paid by transaction ${s.found.hash} (recovered through the merchant's OrderPaid event)`, { record: record || !same, prior: comparison, nonce, from });
          if (done === "closed") { resolved++; log(`${a.attempt_id}: closed via OrderPaid ${s.found.hash}`); } else pending++;
          continue;
        }
        pendingNote(db, a, "the order reads as paid but neither the reported hash nor the paying transaction is visible yet (bounded log search continues)", { scannedTo: s.scannedTo, deviations: comparison, nonce, from }); pending++; continue;
      }
      if (nonce !== null && nonce !== undefined) {
        const latest = await rpc.getTransactionCount({ address: a.payer as Hex, blockTag: "latest" });
        if (latest > nonce) {
          // a consumed nonce alone proves nothing about the reported hash (a load-balanced node may lag on the receipt and the order read):
          // NOT_MINED only from an identified consuming transaction whose receipt is visible and does not pay this order
          const by = await findNonceConsumer(rpc as any, { payer: a.payer as Hex, nonce, broadcastBlock: a.broadcast_block } as StoredExecution).catch(() => null);
          if (!by) { pendingNote(db, a, `the wallet's nonce ${nonce} appears consumed but the consuming transaction could not be identified yet (a lagging node may be the cause); nothing is concluded`, { deviations: comparison, nonce, from }); pending++; continue; }
          if (by.hash.toLowerCase() === hash.toLowerCase()) {
            const rc2 = await rpc.getTransactionReceipt({ hash }).catch(() => null);
            if (rc2) {
              const o = await outcomeFromReceipt(rpc as any, subject, hash, rc2);
              const state: WalletAttemptState = mismatch ? "MISMATCH" : o.chainStatus === "CONFIRMED" ? "CONFIRMED" : "REVERTED";
              close(db, a, state, { ...o, note: mismatch ? `${mismatchNote}; ${o.note ?? ""}` : (o.note ?? "") }, { record, receipt: rc2, deviations: comparison });
              resolved++; log(`${a.attempt_id}: ${state} (receipt found after the block scan)`); continue;
            }
            pendingNote(db, a, `block ${by.block} contains the reported transaction but its receipt is not visible on this node yet`, { deviations: comparison, nonce, from }); pending++; continue;
          }
          const byRc = await rpc.getTransactionReceipt({ hash: by.hash }).catch(() => null);
          if (!byRc) { pendingNote(db, a, `the wallet's nonce ${nonce} was consumed by ${by.hash}, whose receipt is not visible yet; nothing is concluded`, { deviations: comparison, nonce, from }); pending++; continue; }
          if (paysThisOrder(byRc, subject)) {
            const done = await closeFromFoundTransaction(db, rpc, a, subject, by.hash, `the reported hash ${hash} was not mined; the order was paid by transaction ${by.hash}, which consumed the same wallet nonce`, { record: true, prior: comparison, nonce, from });
            if (done === "closed") { resolved++; log(`${a.attempt_id}: closed via same-nonce replacement ${by.hash}`); } else pending++;
            continue;
          }
          close(db, a, "NOT_MINED", { chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: `the wallet's nonce ${nonce} was consumed by transaction ${by.hash}, which does not pay this order; the reported hash can never be mined; the order reads as unpaid; nothing is re-signed` }, { record, deviations: comparison, consumedBy: by.hash });
          resolved++; log(`${a.attempt_id}: NOT_MINED (consumed by ${by.hash})`); continue;
        }
      }
      if (at.getTime() > validUntil + WALLET_CLOSE_AFTER_MS) {
        close(db, a, "NOT_EXECUTED", { chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED", businessTxHash: null, note: "no transaction was established by this service within 24 h of the validation window; the order reads as unpaid" }, { record, deviations: comparison });
        resolved++; log(`${a.attempt_id}: NOT_EXECUTED`); continue;
      }
      pendingNote(db, a, tx ? `${mismatch ? mismatchNote + "; " : ""}the transaction is visible but has no receipt yet` : "the reported hash is not visible on this node yet; the order reads as unpaid", { deviations: comparison, nonce, from }); pending++;
    } catch (e: any) { pending++; log(`${a.attempt_id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  return { resolved, pending };
}

// ---- shaping: execution receipt, synthesised steps, result-like object for the cost statement, recovery summary and passport
export function executionReceiptOf(a: AttemptRow, at = now()) {
  const open = a.state === "VALIDATED" && a.valid_until && new Date(a.valid_until).getTime() > Date.parse(at);
  const [chainStatus, businessStatus] = a.state === "VALIDATED" ? (open ? ["NOT_SIGNED", "NOT_EXECUTED"] : ["UNKNOWN", "UNKNOWN"])
    : a.state === "REFUSED" || a.state === "NOT_SENT" ? ["NOT_SIGNED", "NOT_EXECUTED"]
    : a.state === "BROADCAST_ATTEMPTED" ? ["PENDING", "PENDING"]
    : a.state === "CONFIRMED" ? ["CONFIRMED", a.business_status ?? "UNKNOWN"]
    : a.state === "REVERTED" ? ["REVERTED", a.business_status ?? "FAILED"]
    : a.state === "MISMATCH" ? [a.block ? (a.business_status === "SUCCESS" || a.business_status === "FAILED" ? (JSON.parse(a.receipt_json ?? "{}").status === "reverted" ? "REVERTED" : "CONFIRMED") : "UNKNOWN") : "UNKNOWN", a.business_status ?? "UNKNOWN"]
    : ["UNKNOWN", "NOT_EXECUTED"]; // NOT_MINED, NOT_EXECUTED
  const postcondition = a.postcondition_json ? JSON.parse(a.postcondition_json) : null;
  return ExecutionReceipt.parse({ schemaVersion: "1.0", executionAttemptId: a.attempt_id, intentDigest: a.intent_digest, reportDigest: a.report_digest, decisionDigest: a.decision_digest, baselineDigest: a.baseline_digest, policyDigest: a.policy_digest,
    finalValidationDigest: a.final_validation_digest, transactionPlanDigest: a.plan_digest, signedTransactionHash: null, businessTxHash: a.business_tx_hash ?? (a.state === "BROADCAST_ATTEMPTED" ? a.tx_hash : null), chainStatus, businessStatus,
    postconditionEvidenceDigests: postcondition ? [postconditionDigest(postcondition)] : [], labels: JSON.parse(a.labels_json), recordedAt: a.updated_at });
}
function synthesisedSteps(a: AttemptRow, order: OrderRow | undefined, payment: any, decision: DecisionReceipt | null, fv: FinalValidationReceipt | null): Step[] {
  const t0 = new Date(a.created_at).getTime();
  const ms = (iso: string | null | undefined) => (iso ? Math.max(0, new Date(iso).getTime() - t0) : 0);
  const steps: Step[] = [];
  if (order) steps.push({ step: "createOrder", atMs: 0, tx: order.tx_hash, orderId: order.order_id, block: order.block, who: "order creator (API)", why: "an order payable only by the visitor's address: the independent business expectation" });
  steps.push({ step: "intent", atMs: 0, intentDigest: a.intent_digest, who: "the visitor's browser", why: "exact candidate call bound to the approved order" });
  steps.push({ step: "quote", atMs: 0, requestId: a.request_id, why: "the report was prepared and pinned before any charge" });
  if (payment) steps.push({ step: "signServiceFee", atMs: 0, who: "the visitor's wallet", why: "one EIP-3009 authorization for the check fee; the business payment is separate" });
  steps.push({ step: "reportDelivered", atMs: 0, serviceFeeTx: payment?.tx_hash ?? null, reportDigest: a.report_digest, why: "the check fee settled by the project's relayer; the report is bound to the intent" });
  if (decision) steps.push({ step: "decision", atMs: 0, decision: decision.decision, reasons: decision.reasons.slice(0, 8), who: "deterministic policy (server-side, same function as the browser)", why: "hard violations block; unapproved change or unknowns require review" });
  if (fv) steps.push({ step: "finalValidation", atMs: ms(fv.validatedAt), result: fv.result, reasons: fv.reasons, newPinnedBlock: fv.snapshot.blockNumber, who: "ArcPreflight (for the wallet payer)", why: "the exact plan re-validated at a fresh pinned block after the fee confirmation and the order creation; the payer account verified to carry no code" });
  const refusal = a.refusal_json ? JSON.parse(a.refusal_json) : null;
  if (a.state === "REFUSED") steps.push({ step: "notSigned", atMs: ms(a.updated_at), stage: refusal?.stage ?? null, why: "validation did not pass; nothing was handed to the wallet" });
  else if (fv) steps.push({ step: "walletPrompted", atMs: ms(fv.validatedAt), validUntil: a.valid_until, who: "the visitor's wallet", why: "the attempt is durable with its plan before the wallet is asked to sign; the service never sees the signed bytes" });
  if (a.state === "NOT_SENT") steps.push({ step: "walletRejected", atMs: ms(a.updated_at), why: a.note ?? "the prompt was rejected; nothing was sent" });
  if (a.tx_hash && a.state !== "NOT_SENT") {
    steps.push({ step: "broadcastAttempted", atMs: ms(a.updated_at), businessTxHash: a.tx_hash, headBlock: a.broadcast_block, why: "the wallet returned a hash: from here on the transaction may be on the network" });
    steps.push({ step: "broadcast", atMs: ms(a.updated_at), businessTxHash: a.tx_hash, accepted: true, who: "the visitor's wallet", why: "sent by the wallet; the service compares the visible transaction with the plan after the fact" });
  }
  const dev = a.deviations_json ? JSON.parse(a.deviations_json) : null;
  if (dev && (dev.mismatch?.length || Object.keys(dev.deviations ?? {}).length)) steps.push({ step: "planComparison", atMs: ms(a.updated_at), mismatch: dev.mismatch, deviations: dev.deviations, why: "to/data/value/chainId/type must agree with the plan; wallet-set gas, fees and nonce are recorded as deviations, never silently accepted" });
  if (a.postcondition_json) { const pc = JSON.parse(a.postcondition_json); steps.push({ step: "postcondition", atMs: ms(a.updated_at), ...pc, why: "chain receipt success is not business success: the order itself must read as paid, by this payer, for the exact amount" }); }
  if (a.state === "NOT_MINED" || a.state === "NOT_EXECUTED") steps.push({ step: "outcomeUnknown", atMs: ms(a.updated_at), businessTxHash: a.tx_hash, why: a.note ?? "" });
  return steps;
}
/** The attempt as a run-result-like record (docs/PASSPORT.md RunResultLike), for the cost statement, recovery summary and passport. */
export function attemptResult(db: Db, a: AttemptRow, feeAuthorization: unknown = null) {
  const order = getOrderRow(db, a.order_id);
  const req = row(db, "SELECT * FROM requests WHERE request_id = ?", a.request_id);
  const q = row(db, "SELECT * FROM quotes WHERE request_id = ?", a.request_id); const p = row(db, "SELECT * FROM payments WHERE request_id = ?", a.request_id);
  const rep = row(db, "SELECT * FROM reports WHERE report_digest = ?", a.report_digest);
  const intent = req ? IntentCore.parse(JSON.parse(req.intent_json)) : null; const report = rep ? ReportCore.parse(JSON.parse(rep.report_json)) : null;
  const ev = rep ? JSON.parse(rep.evidence_json) : null;
  const decision = DecisionReceipt.parse(JSON.parse(a.decision_json)); const policy = PolicyCore.parse(JSON.parse(a.policy_json));
  const fv: FinalValidationReceipt | null = a.final_validation_json ? JSON.parse(a.final_validation_json) : null; const plan: TransactionPlan | null = a.plan_json ? JSON.parse(a.plan_json) : null;
  const execution = executionReceiptOf(a); const steps = synthesisedSteps(a, order, p, decision, fv);
  const receipt = a.receipt_json ? JSON.parse(a.receipt_json) : null;
  const feeReceipt = a.fee_receipt_json ? JSON.parse(a.fee_receipt_json) : null;
  let quote: unknown = null; try { quote = q ? QuoteCore.parse(JSON.parse(q.quote_json)) : null; } catch { quote = q ? JSON.parse(q.quote_json) : null; }
  return {
    executionMode: "wallet" as const, fixture: "WALLET_EXECUTION", network: cfg.net, chainId: cfg.chainId, attemptId: a.attempt_id, orderId: a.order_id as Hex, merchant: getAddress(a.merchant) as Hex,
    intent, intentDigest: a.intent_digest as Hex, policy, policyDigest: a.policy_digest as Hex, requestId: a.request_id, serviceFeeTx: (p?.tx_hash as string | null) ?? null,
    report, reportDigest: a.report_digest as Hex, simulation: ev?.simulation ?? null, decision, decisionDigest: a.decision_digest as Hex,
    finalValidation: fv, plan, execution, executionDigest: executionDigest(execution), postcondition: a.postcondition_json ? JSON.parse(a.postcondition_json) : null, steps, durationMs: Math.max(0, new Date(a.updated_at).getTime() - new Date(a.created_at).getTime()),
    quote, quoteDigest: (q?.quote_digest as string | null) ?? null, feeAuthorization,
    orderCreation: order ? { tx: order.tx_hash as Hex, block: order.block, from: (order.from_addr as Hex | null) ?? null, gasUsed: order.gas_used, effectiveGasPriceNativeAtomic: order.effective_gas_price, signer: "order creator", reference: order.reference } : null,
    feeReceipt: feeReceipt ? { from: feeReceipt.from, gasUsed: feeReceipt.gasUsed, effectiveGasPriceNativeAtomic: feeReceipt.effectiveGasPriceNativeAtomic, blockNumber: feeReceipt.blockNumber } : null, businessReceipt: receipt ? { from: receipt.from, gasUsed: receipt.gasUsed, effectiveGasPriceNativeAtomic: receipt.effectiveGasPriceNativeAtomic, blockNumber: receipt.blockNumber, status: receipt.status } : null,
    finalValidationEvidence: a.fv_evidence_json ? JSON.parse(a.fv_evidence_json) : [], approvalStatusAtValidation: a.approval_status_json ? JSON.parse(a.approval_status_json) : null,
    reconciliation: JSON.parse(a.reconciliation_json || "[]"),
  };
}
const nextActionOf = (a: AttemptRow): string => {
  const open = a.valid_until && new Date(a.valid_until).getTime() > Date.now();
  switch (a.state) {
    case "VALIDATED": return promptOf(a) ? "the wallet was asked to sign this plan: the transaction may have been submitted — recover first; abandon only if you know you rejected the prompt" : open ? "confirm the transaction in your wallet, then the page reports its hash; or abandon it" : "the validation window closed; recover to establish the outcome from the chain, or validate again";
    case "REFUSED": return "review the reasons; nothing was handed to the wallet; fix the cause (approval, funds, order) and validate again";
    case "BROADCAST_ATTEMPTED": return "waiting for the receipt; recover to reconcile now from the hash, the order state and the OrderPaid event";
    case "CONFIRMED": return a.business_status === "SUCCESS" ? "the order is paid: export the Payment Passport and verify it independently" : "the transaction confirmed but the order does not read as paid for this payer and amount: export the passport for the record";
    case "MISMATCH": return "the wallet sent something other than the validated plan: export the passport; the order state is recorded";
    case "REVERTED": return "the transaction reverted; the order stays unpaid: export the passport for the record";
    case "NOT_SENT": return "nothing was sent; validate again when ready";
    default: return "no transaction was established; the order reads as unpaid: validate again or export the passport for the record";
  }
};
export function shapeAttempt(db: Db, a: AttemptRow, opts: { brief?: boolean } = {}) {
  const decision = JSON.parse(a.decision_json); const refusal = a.refusal_json ? JSON.parse(a.refusal_json) : null; const dev = a.deviations_json ? JSON.parse(a.deviations_json) : null;
  const base = { attemptId: a.attempt_id, executionMode: "wallet" as const, state: a.state, requestId: a.request_id, orderId: a.order_id, merchant: a.merchant, payer: a.payer, amountNativeAtomic: a.amount_atomic, labels: JSON.parse(a.labels_json),
    decision: decision.decision, decisionReasons: decision.reasons, refusal, validUntil: a.valid_until, prompt: publicPrompt(a), txHash: a.tx_hash, nonce: a.nonce, from: a.from_addr, broadcastBlock: a.broadcast_block,
    businessStatus: a.business_status, businessTxHash: a.business_tx_hash, block: a.block, note: a.note, deviations: dev, nextAction: nextActionOf(a), passportAvailable: a.state !== "VALIDATED",
    businessExecution: { state: a.state, txHash: a.tx_hash, nonce: a.nonce, broadcastBlock: a.broadcast_block, consumedBy: null, note: a.note, validUntil: a.valid_until },
    createdAt: a.created_at, updatedAt: a.updated_at };
  if (opts.brief) return base;
  const result = attemptResult(db, a);
  return { ...base, decisionReceipt: result.decision, decisionDigest: a.decision_digest, finalValidation: result.finalValidation, finalValidationDigest: a.final_validation_digest, plan: result.plan, planDigest: a.plan_digest, approvalStatusAtValidation: result.approvalStatusAtValidation,
    execution: result.execution, executionDigest: result.executionDigest, postcondition: result.postcondition, receipt: result.businessReceipt, reconciliation: result.reconciliation, steps: result.steps,
    recovery: runRecovery(result, result.steps), costStatement: runCostStatement(result, "visitor-wallet"), order: result.orderCreation };
}

/** Private passport of a wallet attempt (subject kind wallet-run, execution mode wallet). Open VALIDATED attempts are not exported yet. */
export async function buildWalletPassport(db: Db, attemptId: string, principal: string): Promise<PassportResult> {
  const a = owned(db, principal, attemptId);
  if (!a) return { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown attempt" };
  if (a.state === "VALIDATED" && a.valid_until && new Date(a.valid_until).getTime() > Date.now()) return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "the attempt is waiting for the wallet; a passport is exported from a finished or stopped workflow" };
  const p = row(db, "SELECT * FROM payments WHERE request_id = ?", a.request_id);
  let authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex } | null = null;
  if (p?.settle_payload_encrypted) { try { const x = (await openJson(p.settle_payload_encrypted)).paymentPayload.payload.authorization; authorization = { from: x.from, to: x.to, value: String(x.value), validAfter: String(x.validAfter), validBefore: String(x.validBefore), nonce: x.nonce }; } catch { authorization = null; } }
  const result = attemptResult(db, a, authorization);
  if (!result.intent || !result.report) return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "the check this attempt refers to is not on record" };
  const order = getOrderRow(db, a.order_id);
  const [feeTx, businessTx, createOrderTx] = await Promise.all([capture(result.serviceFeeTx), capture(result.execution.businessTxHash), capture(order?.tx_hash ?? null)]);
  const source = {
    generator: { release: cfg.releaseSha, component: "api" as const }, disclosure: "private" as const, chain: { chainId: cfg.chainId as 5042 | 5042002, caip2: cfg.caip2, usdc: cfg.usdc as Hex },
    subject: { kind: "wallet-run", runId: null, attemptId: a.attempt_id, fixture: null, executionMode: "wallet" }, template: TEMPLATE,
    result, baseline: baselineFor(db, result.intent.baselineDigest), reportEvidence: reportEvidenceFor(db, a.report_digest),
    settlement: settlementFor(db, a.request_id), payment: { requestId: a.request_id, quote: result.quote as any, authorization },
    chainCaptures: { feeTx, businessTx, createOrderTx }, reconciliation: result.reconciliation, createdAt: now(),
  } as unknown as PassportSource;
  const built = buildPassport(source);
  return { ok: true, bundle: toBundle(built.files), manifest: built.manifest };
}
