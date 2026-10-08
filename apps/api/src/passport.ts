// Payment Passport export for the API (design v3.2 §13, docs/PASSPORT.md): assembles a PassportSource from records the API already
// holds (run result, approval, report evidence, settlement facts) plus transaction/receipt captures fetched at export time, and
// hands it to the exporter package. Exporting is read-only: it never reconciles, settles or sends anything. The same package
// functions produce the recovery summary and cost statement shown on the run itself, so UI and passport cannot disagree.
import { getAddress, type Hex } from "viem";
import { BaselineCore, IntentCore, QuoteCore, ReportCore, ExecutionReceipt, executionDigest } from "@arcpreflight/schema";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { buildPassport, toBundle, costStatement, recoverySummary, type PassportSource, type Capture, type CostStatement, type RecoverySummary, type ReconciliationEntry, type EvidenceEntry, type Manifest, type Step } from "@arcpreflight/passport";
import { cfg } from "./config.js";
import { client } from "./report.js";
import { openJson } from "./payments.js";
import { type Db, row, now } from "./db.js";

export const TEMPLATE = { id: "oz-erc1967proxy-uups@5.4.0", merchant: "DemoMerchantV1", method: "pay(bytes32)", selector: PAY_SELECTOR as Hex } as const;
const bigJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
export type PassportResult = { ok: true; bundle: unknown; manifest: Manifest } | { ok: false; status: number; error: string; reason: string };

/** Transaction + receipt as the exporter's RPC sees them now: a labelled capture, never pinned evidence. */
export async function capture(hash: string | null | undefined): Promise<Capture | null> {
  if (!hash || typeof (client as any).getTransaction !== "function") return null;
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: hash as Hex }).catch(() => null), client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null)]);
  return { tx: tx ? bigJson(tx) : null, receipt: receipt ? bigJson(receipt) : null, capturedAt: now(), note: "captured from the exporter's RPC at export time; a labelled capture, not pinned evidence" };
}
export function reportEvidenceFor(db: Db, reportDigest: string | null | undefined): EvidenceEntry[] {
  if (!reportDigest) return [];
  const r = row(db, "SELECT evidence_json FROM reports WHERE report_digest = ?", reportDigest);
  if (!r) return [];
  const ev = JSON.parse(r.evidence_json);
  const list = Array.isArray(ev) ? ev : Array.isArray(ev?.evidence) ? ev.evidence : [];
  return list.filter((e: any) => e && e.evidence && typeof e.digest === "string");
}
export function baselineFor(db: Db, digest: string | null | undefined) {
  if (!digest) return null;
  const b = row(db, "SELECT baseline_json FROM baselines WHERE baseline_digest = ?", digest);
  if (!b) return null;
  try { return BaselineCore.parse(JSON.parse(b.baseline_json)); } catch { return null; }
}
export function settlementFor(db: Db, requestId: string | null | undefined): PassportSource["settlement"] {
  if (!requestId) return null;
  const p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!p) return null;
  const relay = p.backend === "relay";
  return { backend: relay ? "relay" : "circle", state: p.state, transactionHash: (p.tx_hash as Hex | null) ?? null, relayer: relay ? ((cfg.merchant?.address as Hex | undefined) ?? null) : null, evidence: p.settlement_evidence_json ? JSON.parse(p.settlement_evidence_json) : null };
}
/** `result.reconciliation` is an array of entries since v3.2; earlier rows stored a single object. */
export function reconciliationOf(result: any): ReconciliationEntry[] {
  const rec = result?.reconciliation;
  if (Array.isArray(rec)) return rec.map((e: any) => ({ at: String(e.at ?? result.execution?.recordedAt ?? ""), chainStatus: String(e.chainStatus ?? result.execution?.chainStatus ?? "UNKNOWN"), businessStatus: String(e.businessStatus ?? result.execution?.businessStatus ?? "UNKNOWN"), note: e.note ?? null }));
  if (rec && typeof rec === "object") return [{ at: String(rec.at ?? ""), chainStatus: String(result.execution?.chainStatus ?? "UNKNOWN"), businessStatus: String(result.execution?.businessStatus ?? "UNKNOWN"), note: rec.note ?? null }];
  return [];
}

/** Recovery summary for the run JSON (same function as recovery.json in the passport). */
export function runRecovery(result: any, steps: Step[]): RecoverySummary | null {
  if (!result?.execution || !result?.attemptId) return null;
  try { return recoverySummary(result.attemptId, steps, result.execution, reconciliationOf(result)); } catch { return null; }
}
const receiptLike = (r: any) => (r && r.gasUsed && r.effectiveGasPriceNativeAtomic ? { gasUsed: String(r.gasUsed), effectiveGasPrice: String(r.effectiveGasPriceNativeAtomic), from: r.from ?? null, transactionHash: r.tx ?? null } : null);
/** Cost statement for the run JSON (same function as cost-statement.json). Receipt facts come from the runner's record; missing ones stay null. */
export function runCostStatement(result: any, buyerRole: "project-runner" | "visitor-wallet" | "buyer" = result?.executionMode === "wallet" ? "visitor-wallet" : "project-runner"): CostStatement | null {
  if (!result?.intent) return null;
  try {
    return costStatement({
      buyer: getAddress(result.intent.from) as Hex, buyerRole, relayer: (cfg.merchant?.address as Hex | undefined) ?? null, orderCreator: result.orderCreation?.from ? (getAddress(result.orderCreation.from) as Hex) : null,
      businessPrincipalNativeAtomic: result.intent.businessExpectation.amountNativeAtomic, businessPaid: result.execution?.businessStatus === "SUCCESS",
      checkFeeTokenAtomic: result.serviceFeeTx ? String(result.quote?.amountTokenAtomic ?? cfg.priceTokenAtomic) : null,
      plan: result.plan ? { gasLimit: result.plan.gasLimit, maxFeePerGasNativeAtomic: result.plan.maxFeePerGasNativeAtomic } : null,
      policy: result.policy ? { maxNativePaymentAtomic: result.policy.maxNativePaymentAtomic, maxServiceFeeTokenAtomic: result.policy.maxServiceFeeTokenAtomic } : null,
      receipts: { feeTx: receiptLike(result.feeReceipt), businessTx: receiptLike(result.businessReceipt), createOrderTx: receiptLike(result.orderCreation) },
      txs: { feeTx: result.serviceFeeTx ?? null, businessTx: result.execution?.businessTxHash ?? null, createOrderTx: result.orderCreation?.tx ?? null },
      capturedAt: result.execution?.recordedAt ?? now(),
    });
  } catch { return null; }
}

/** A complete run record rebuilt from the artefacts persisted while the run was in progress (design v3.3 §4): what `runFixture`
 *  would have returned had the process not stopped. Null until intent, report, decision and an execution receipt exist. */
export function assembleFromArtifacts(a: Record<string, any>, steps: Step[], x: { fixture: string; orderId?: string | null; merchant?: string | null }): any | null {
  if (!a?.intent?.intent || !a?.report?.report || !a?.decision?.decision || !a?.execution) return null;
  let execution: any; try { execution = ExecutionReceipt.parse(a.execution); } catch { return null; }
  const last = steps.length ? Math.max(...steps.map((s) => (typeof s.atMs === "number" && s.atMs >= 0 ? s.atMs : 0))) : 0;
  return { executionMode: "runner", fixture: x.fixture, network: cfg.net, chainId: cfg.chainId, attemptId: execution.executionAttemptId, orderId: a.order?.orderId ?? x.orderId ?? a.intent.intent.businessExpectation?.orderId ?? null, merchant: x.merchant ?? a.order?.merchant ?? a.intent.intent.to,
    intent: a.intent.intent, intentDigest: a.intent.intentDigest, policy: a.intent.policy, policyDigest: a.intent.policyDigest, requestId: a.quote?.requestId ?? null, serviceFeeTx: a.report.serviceFeeTx ?? null,
    report: a.report.report, reportDigest: a.report.reportDigest, simulation: a.report.simulation ?? null, decision: a.decision.decision, decisionDigest: a.decision.decisionDigest,
    finalValidation: a.finalValidation?.finalValidation ?? null, plan: a.finalValidation?.plan ?? null, execution, executionDigest: executionDigest(execution), postcondition: a.postcondition?.postcondition ?? null, steps, durationMs: last,
    quote: a.quote?.quote ?? null, quoteDigest: a.quote?.quoteDigest ?? null, feeAuthorization: a.feeAuthorization ?? null,
    orderCreation: a.order ? { tx: a.order.tx, block: a.order.block, from: a.order.from ?? null, gasUsed: a.order.gasUsed ?? null, effectiveGasPriceNativeAtomic: a.order.effectiveGasPriceNativeAtomic ?? null, signer: a.order.signer ?? "order creator", reference: a.order.reference ?? null } : null,
    feeReceipt: a.finalValidation?.feeReceipt ?? null, businessReceipt: a.postcondition?.businessReceipt ?? null, finalValidationEvidence: a.finalValidation?.finalValidationEvidence ?? [], approvalStatusAtValidation: a.finalValidation?.approvalStatusAtValidation ?? null,
    reconstructedFromArtifacts: true };
}
/** Public passport of a finished demo run. */
export async function buildRunPassport(db: Db, runId: string): Promise<PassportResult> {
  const r = row(db, "SELECT * FROM demo_runs WHERE run_id = ?", runId);
  if (!r) return { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown run" };
  if (r.state === "RUNNING") return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "the run is still in progress; a passport is exported from a finished or stopped workflow" };
  const steps: Step[] = JSON.parse(r.steps_json);
  // v3.3: a run that stopped before its result was written is exported from the artefacts persisted while it ran (AP33-04)
  const result = r.result_json ? JSON.parse(r.result_json) : assembleFromArtifacts(r.artifacts_json ? JSON.parse(r.artifacts_json) : {}, steps, { fixture: r.fixture });
  if (!result?.intent || !result?.report || !result?.decision || !result?.execution) return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "this run has no complete record (it stopped before a report was delivered or decided); nothing to export" };
  const createTx = result.orderCreation?.tx ?? (steps.find((s) => s.step === "createOrder")?.tx as string | undefined) ?? null;
  const [feeTx, businessTx, createOrderTx] = await Promise.all([capture(result.serviceFeeTx), capture(result.execution.businessTxHash), capture(createTx)]);
  const source: PassportSource = {
    generator: { release: cfg.releaseSha, component: "api" }, disclosure: "public", chain: { chainId: cfg.chainId as 5042 | 5042002, caip2: cfg.caip2, usdc: cfg.usdc as Hex },
    subject: { kind: "demo-run", runId, attemptId: result.attemptId, fixture: r.fixture, executionMode: "runner" }, template: TEMPLATE,
    result: { ...result, steps }, baseline: baselineFor(db, result.intent.baselineDigest), reportEvidence: reportEvidenceFor(db, result.reportDigest),
    settlement: settlementFor(db, result.requestId), payment: { requestId: result.requestId, quote: result.quote ?? null, authorization: result.feeAuthorization ?? null },
    chainCaptures: { feeTx, businessTx, createOrderTx }, reconciliation: reconciliationOf(result), createdAt: now(),
  };
  const built = buildPassport(source);
  return { ok: true, bundle: toBundle(built.files), manifest: built.manifest };
}

/** Private passport of a paid check: the owner's report, quote, payment facts and evidence — no decision or execution (the buyer decides locally). */
export async function buildCheckPassport(db: Db, requestId: string, principal: string): Promise<PassportResult> {
  const req = row(db, "SELECT * FROM requests WHERE request_id = ?", requestId);
  if (!req || req.principal !== principal) return { ok: false, status: 404, error: "NOT_FOUND", reason: "unknown request" }; // no existence leak across principals
  const q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
  const p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!q || !p || p.state !== "COMPLETED") return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "the check fee has not settled; a passport is exported once the report is delivered" };
  const rep = row(db, "SELECT report_json FROM reports WHERE report_digest = ?", q.report_digest);
  if (!rep) return { ok: false, status: 409, error: "PASSPORT_NOT_READY", reason: "the delivered report is not on record" };
  const intent = IntentCore.parse(JSON.parse(req.intent_json)); const report = ReportCore.parse(JSON.parse(rep.report_json)); const quote = QuoteCore.parse(JSON.parse(q.quote_json));
  let authorization: PassportSource["payment"] extends infer P ? (P extends { authorization: infer A } ? A : never) : never = null;
  if (p.settle_payload_encrypted) {
    try { const a = (await openJson(p.settle_payload_encrypted)).paymentPayload.payload.authorization; authorization = { from: a.from, to: a.to, value: String(a.value), validAfter: String(a.validAfter), validBefore: String(a.validBefore), nonce: a.nonce }; } catch { authorization = null; }
  }
  const source: PassportSource = {
    generator: { release: cfg.releaseSha, component: "api" }, disclosure: "private", chain: { chainId: cfg.chainId as 5042 | 5042002, caip2: cfg.caip2, usdc: cfg.usdc as Hex },
    subject: { kind: "paid-check", runId: null, attemptId: null, fixture: null }, template: TEMPLATE,
    result: null, check: { intent, report }, baseline: baselineFor(db, intent.baselineDigest), reportEvidence: reportEvidenceFor(db, q.report_digest),
    settlement: settlementFor(db, requestId), payment: { requestId, quote, authorization }, chainCaptures: { feeTx: await capture(p.tx_hash) }, createdAt: now(),
  };
  const built = buildPassport(source);
  return { ok: true, bundle: toBundle(built.files), manifest: built.manifest };
}
