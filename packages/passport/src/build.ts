// buildPassport: turns records the application already holds into the file set of docs/PASSPORT.md §1. Pure: no I/O, no
// fetches, nothing funds-moving. Exporter inconsistencies (an evidence digest that does not match, a post-condition record whose
// digest the execution receipt does not reference) throw instead of producing a passport a verifier would reject.
import { keccak256, stringToBytes, getAddress } from "viem";
import { digest as schemaDigest, intentDigest, policyDigest, baselineDigest, reportDigest, decisionDigest, transactionPlanDigest, finalValidationDigest, executionDigest, quoteDigest, type IntentCore, type ReportCore } from "@arcpreflight/schema";
import {
  DIGEST_PROFILES, DIGEST_PROFILE_DESCRIPTIONS, PASSPORT_VERSION, ORDER_SUMMARY_VERSION, PAYMENT_VERSION, VERIFICATION_PROFILE_VERSION,
  type BuiltPassport, type Capture, type EvidenceEntry, type ExecutionMode, type Hex, type Manifest, type ManifestFileEntry, type OrderSummary, type PassportFiles, type PassportSource, type PaymentFile, type StageCoverage, type VerificationProfile, type Eip3009AuthorizationWithoutSignature, type BuyerRole } from "./types.js";
import { MANIFEST_PATH, PassportFormatError, validateFiles, utf8Length } from "./paths.js";
import { formatNative, formatToken, jsonSafe, pretty, sha256File } from "./format.js";
import { costStatement, type ReceiptLike } from "./cost.js";
import { recoverySummary } from "./recovery.js";

export const FINDING_IDS = {
  offline: ["FILE_INTEGRITY", "DIGEST_INTEGRITY", "DISCLOSURE", "APPROVAL_COVERAGE"],
  anchor: ["APPROVAL_SOURCE"],
  online: ["NETWORK_IDENTITY", "FEE_ATTRIBUTION", "TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT"],
  never: ["CURRENT_ELIGIBILITY"],
} as const;

/** Profile legacy-json-stringify-keccak-1.0: the runner's `postconditionDigest` over the exact JSON.stringify output. */
export const legacyRecordDigest = (preimage: string): Hex => keccak256(stringToBytes(preimage));
export const evidenceDigestOf = (evidence: unknown): Hex => schemaDigest("evidence", "1.0", evidence);

/** the buyer side by subject kind: the project's runner for a demo run, the visitor's wallet for a wallet run, a check buyer otherwise */
export const buyerRoleOf = (kind: string | undefined): BuyerRole => (kind === "demo-run" ? "project-runner" : kind === "wallet-run" ? "visitor-wallet" : "buyer");
export function verificationProfile(chainId: number): VerificationProfile {
  return {
    verificationProfileVersion: VERIFICATION_PROFILE_VERSION,
    acceptedDigestProfiles: [DIGEST_PROFILES.jcs, DIGEST_PROFILES.legacy, DIGEST_PROFILES.file],
    anchors: { format: { baselineDigests: ["0x…"], policyDigests: ["0x…"] }, source: "retained by the verifier's operator through a trusted channel, never taken from the passport" },
    offlineChecks: [...FINDING_IDS.offline], anchorChecks: [...FINDING_IDS.anchor], onlineChecks: [...FINDING_IDS.online], neverEvaluated: [...FINDING_IDS.never],
    rpc: { chainId, methods: ["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_getBlockByHash"] },
  };
}

const VERIFY_MD = (m: Manifest) => `# Verify this Payment Passport

This directory (or its single-file bundle) is a read-only evidence export of one ArcPreflight workflow on ${m.chain.caip2}.
It grants nothing: no signing authority, no raw transactions, no authorization signatures, no right to reuse a receipt.

Run the independent verifier in a clean process, without any ArcPreflight API, token or key:

    pnpm exec tsx packages/verifier/src/cli.ts <passport-dir-or-bundle.json> --rpc <arc rpc url> --anchors anchors.json
    # equivalent: pnpm -C packages/verifier verify <passport> --rpc <url> --anchors anchors.json
    #         or: node packages/verifier/bin/arcpreflight-verify.mjs <passport> --rpc <url> --anchors anchors.json

- \`--rpc\` is an explicitly configured Arc RPC (chain ${m.chain.chainId}). Without it the online findings are UNVERIFIED.
- \`--anchors\` is a JSON file \`{ "baselineDigests": ["0x…"], "policyDigests": ["0x…"] }\` holding the approval digests you
  retained through a trusted channel. Without it APPROVAL_SOURCE is UNVERIFIED: a passport cannot vouch for its own approval.

The verifier prints one line per finding (PASS, FAIL, UNVERIFIED or NOT_EVALUATED) and never a single overall "PASS".
CURRENT_ELIGIBILITY is always NOT_EVALUATED: whether a new payment may execute now is a present-time question that
historical success never answers. A transaction hash is not proof of service delivery, and a contract balance is not proof
that this order was paid; the ORDER_OUTCOME finding reads the order itself at the receipt's block.

Execution mode: ${m.subject.executionMode}. ${m.subject.executionMode === "wallet"
  ? "The business transaction was signed by the payer's own wallet from a plan this service validated and persisted first; TRANSACTION_PLAN_AGREEMENT requires chainId, type, from, to, data and value to match that plan and reports wallet-set gas, fees and nonce as recorded deviations."
  : "The business transaction was signed by the project runner from the validated plan; TRANSACTION_PLAN_AGREEMENT requires every serialized field to match that plan."}

Files under evidence/chain/ were captured from the exporter's RPC at export time and are labelled captures, not pinned
evidence; the verifier re-fetches what it needs. The fee transaction's calldata is not included (it carries the buyer's
authorization signature); the verifier fetches it from the chain when it needs it.
`;

function stripSignature(a: unknown): Eip3009AuthorizationWithoutSignature | null {
  if (!a || typeof a !== "object") return null;
  const { from, to, value, validAfter, validBefore, nonce } = a as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || typeof nonce !== "string") return null;
  return { from: from as Hex, to: to as Hex, value: String(value), validAfter: String(validAfter), validBefore: String(validBefore), nonce: nonce as Hex };
}
/** The fee transaction's calldata carries the buyer's authorization signature: export its hash, never its bytes. */
function redactFeeCapture(c: Capture): Capture {
  if (!c.tx || typeof c.tx !== "object") return c;
  const { input, data, ...rest } = c.tx as Record<string, unknown>;
  const raw = (input ?? data) as string | undefined;
  return { ...c, tx: { ...rest, input: null, inputKeccak256: typeof raw === "string" ? keccak256(raw as Hex) : null, inputBytes: typeof raw === "string" ? (raw.length - 2) / 2 : null }, note: `${c.note ? `${c.note}; ` : ""}calldata redacted: it carries the authorization signature` };
}
const receiptOf = (c?: Capture | null): ReceiptLike | null => {
  const r = c?.receipt as any;
  return r && r.gasUsed !== undefined && r.effectiveGasPrice !== undefined ? { gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, from: r.from ?? null, transactionHash: r.transactionHash ?? null, status: r.status } : null;
};
const implementationOf = (deps: { role: string; address: string }[] | undefined): Hex | null => (deps?.find((d) => d.role === "IMPLEMENTATION")?.address as Hex | undefined) ?? null;

export function buildPassport(source: PassportSource): BuiltPassport {
  const files: PassportFiles = {};
  const entries: ManifestFileEntry[] = [];
  const omissions: { path: string; reason: string }[] = [];
  const notes: string[] = [];
  const add = (path: string, content: string, object: ManifestFileEntry["object"]) => {
    if (files[path] !== undefined) throw new PassportFormatError(`${path}: produced twice`);
    files[path] = content;
    entries.push({ path, bytes: utf8Length(content), sha256: sha256File(content), object });
  };
  const addCore = (path: string, kind: string, value: unknown, fn: (v: unknown) => Hex) => {
    const d = fn(value); // validates the object against schema 1.0 before hashing
    add(path, pretty(value), { kind, schemaVersion: "1.0", digestProfile: DIGEST_PROFILES.jcs, digest: d });
    return d;
  };
  const addEvidence = (dir: string, list: EvidenceEntry[], referenced: Set<string>) => {
    let skipped = 0;
    for (const e of list) {
      const d = evidenceDigestOf(e.evidence);
      if (d.toLowerCase() !== e.digest.toLowerCase()) throw new PassportFormatError(`${dir}: evidence digest ${e.digest} does not match its content (${d})`);
      if (!referenced.has(d.toLowerCase())) { skipped++; continue; }
      const path = `${dir}/${d}.json`;
      if (files[path] !== undefined) continue;
      add(path, pretty(e.evidence), { kind: "evidence", schemaVersion: "1.0", digestProfile: DIGEST_PROFILES.jcs, digest: d });
    }
    if (skipped) notes.push(`${skipped} evidence object(s) supplied for ${dir} were not referenced by the receipt and were not exported`);
  };

  const r = source.result;
  const createdAt = source.createdAt ?? new Date().toISOString();
  const intent: IntentCore | null = r?.intent ?? source.check?.intent ?? null;
  const report: ReportCore | null = r?.report ?? source.check?.report ?? null;
  if (!intent || !report) throw new PassportFormatError("a passport needs at least an intent and a report (result or check)");
  if (source.subject.kind !== "paid-check" && !r) throw new PassportFormatError(`a ${source.subject.kind} passport needs the execution result`);
  const executionMode: ExecutionMode = source.subject.executionMode ?? (source.subject.kind === "wallet-run" ? "wallet" : "runner");
  if ((source.subject.kind === "wallet-run") !== (executionMode === "wallet") && source.subject.kind !== "paid-check") throw new PassportFormatError(`subject.kind ${source.subject.kind} is inconsistent with executionMode ${executionMode}`);

  // ---- core objects (schema 1.0, JCS profile)
  const iDigest = addCore("intent.json", "intent", intent, intentDigest);
  if (source.baseline) {
    const bDigest = addCore("baseline.json", "baseline", source.baseline, baselineDigest);
    if (bDigest.toLowerCase() !== intent.baselineDigest.toLowerCase()) throw new PassportFormatError(`baseline.json digest ${bDigest} is not the approval the intent references (${intent.baselineDigest})`);
  } else omissions.push({ path: "baseline.json", reason: "the approving server did not return the referenced baseline" });
  const repDigest = addCore("report.json", "report", report, reportDigest);
  if (report.intentDigest && report.intentDigest.toLowerCase() !== iDigest.toLowerCase()) throw new PassportFormatError("report is bound to a different intent");
  addEvidence("evidence/report", source.reportEvidence, new Set(report.rawEvidenceDigests.map((d) => d.toLowerCase())));

  let plan = r?.plan ?? null, fv = r?.finalValidation ?? null;
  if (r) {
    addCore("policy.json", "policy", r.policy, policyDigest);
    addCore("decision.json", "decision", r.decision, decisionDigest);
    if (plan) addCore("transaction-plan.json", "transactionPlan", plan, transactionPlanDigest);
    if (fv) {
      addCore("final-validation.json", "finalValidation", fv, finalValidationDigest);
      const referenced = new Set([...fv.criticalStateEvidenceDigests, fv.simulationEvidenceDigest ?? "", fv.walletEvidenceDigest].filter(Boolean).map((d) => d.toLowerCase()));
      addEvidence("evidence/final-validation", r.finalValidationEvidence ?? [], referenced);
    }
    const eDigest = addCore("execution.json", "execution", r.execution, executionDigest);
    if (r.executionDigest && r.executionDigest.toLowerCase() !== eDigest.toLowerCase()) throw new PassportFormatError("execution receipt digest does not match the recorded executionDigest");
    if (r.postcondition) {
      const preimage = JSON.stringify(r.postcondition); // byte-exact preimage of the legacy profile
      const d = legacyRecordDigest(preimage);
      if (!r.execution.postconditionEvidenceDigests.some((x) => x.toLowerCase() === d.toLowerCase())) throw new PassportFormatError(`post-condition record digest ${d} is not referenced by the execution receipt`);
      add("evidence/postcondition.json", preimage, { kind: "postcondition", schemaVersion: null, digestProfile: DIGEST_PROFILES.legacy, digest: d });
    }
  }

  // ---- check-fee facts (no signature, ever)
  const quote = source.payment?.quote ?? r?.quote ?? null;
  const authorization = stripSignature(source.payment?.authorization ?? r?.feeAuthorization ?? null);
  const settlement = source.settlement;
  const feeTx = (settlement?.transactionHash ?? r?.serviceFeeTx ?? null) as Hex | null;
  const payment: PaymentFile = {
    paymentVersion: PAYMENT_VERSION, scheme: "x402/exact", assetTransferMethod: "eip3009", requestId: source.payment?.requestId ?? r?.requestId ?? "",
    quote, quoteDigest: quote ? quoteDigest(quote) : null, authorization,
    settlement: settlement ? { backend: settlement.backend, state: settlement.state, relayer: settlement.relayer, transactionHash: settlement.transactionHash, blockNumber: settlement.evidence?.blockNumber ?? null, authorizationUsedLogIndex: settlement.evidence?.authorizationUsedLogIndex ?? null, transferLogIndex: settlement.evidence?.transferLogIndex ?? null } : null,
  };
  add("payment.json", pretty(payment), null);
  if (!quote) omissions.push({ path: "payment.json#quote", reason: "the quote was not supplied by the exporter" });

  // ---- chain captures (labelled, fee calldata redacted)
  const caps = source.chainCaptures ?? {};
  if (caps.feeTx) add("evidence/chain/fee-tx.json", pretty({ capture: true, capturedAt: caps.feeTx.capturedAt ?? createdAt, ...redactFeeCapture(caps.feeTx) }), null);
  if (caps.businessTx) add("evidence/chain/business-tx.json", pretty({ capture: true, capturedAt: caps.businessTx.capturedAt ?? createdAt, ...caps.businessTx }), null);
  if (caps.createOrderTx) add("evidence/chain/create-order-tx.json", pretty({ capture: true, capturedAt: caps.createOrderTx.capturedAt ?? createdAt, ...caps.createOrderTx }), null);
  if (caps.feeTx || caps.businessTx || caps.createOrderTx) notes.push("evidence/chain/* were captured from the exporter's RPC at export time and are labelled captures, not pinned evidence; the fee transaction's calldata is replaced by its keccak256");

  // ---- derived files for a run
  const steps = r?.steps ?? [];
  const createStep = steps.find((s) => s.step === "createOrder") as Record<string, unknown> | undefined;
  const payer = getAddress(intent.from) as Hex;
  const merchant = getAddress(intent.to) as Hex;
  const orderId = (intent.businessExpectation.action === "MERCHANT_PAY" ? intent.businessExpectation.orderId : null) as Hex | null;
  const amount = intent.businessExpectation.action === "MERCHANT_PAY" ? intent.businessExpectation.amountNativeAtomic : "0";
  if (r) {
    const businessTx = (r.execution.businessTxHash ?? null) as Hex | null;
    const orderResult: OrderSummary["orderResult"] = r.postcondition ? (r.postcondition.paid ? "paid" : "unpaid") : r.execution.businessStatus === "SUCCESS" ? "paid" : r.execution.businessStatus === "NOT_EXECUTED" ? "unpaid" : "unknown";
    const summary: OrderSummary = {
      orderSummaryVersion: ORDER_SUMMARY_VERSION, orderId: (orderId ?? r.orderId) as Hex, merchant, payer, amountNativeAtomic: amount, amountUsdc: formatNative(amount),
      createOrder: { tx: (createStep?.tx as Hex | undefined) ?? null, block: createStep?.block !== undefined ? String(createStep.block) : null, signer: (createStep?.who as string | undefined) ?? null },
      referencedApproval: { baselineDigest: intent.baselineDigest as Hex, approvedImplementation: implementationOf(source.baseline?.dependencies), observedImplementation: implementationOf(report.dependencies), baselineResult: report.baselineResult, statusAtFinalValidation: r.approvalStatusAtValidation ?? null },
      executionMode, decision: r.decision.decision, chainResult: r.execution.chainStatus, orderResult, serviceOutcome: "NOT_EVALUATED",
      checkFee: { tokenAtomic: quote?.amountTokenAtomic ?? authorization?.value ?? null, usdc: quote?.amountTokenAtomic ? formatToken(quote.amountTokenAtomic) : authorization?.value ? formatToken(authorization.value) : null, tx: feeTx },
      businessTx, network: source.chain.caip2, release: source.generator.release,
    };
    add("order-summary.json", pretty(summary), null);
    const cost = costStatement({
      buyer: payer, buyerRole: buyerRoleOf(source.subject.kind), relayer: settlement?.relayer ?? null, orderCreator: ((caps.createOrderTx?.tx as any)?.from as Hex | undefined) ?? null,
      businessPrincipalNativeAtomic: amount, businessPaid: r.execution.businessStatus === "SUCCESS",
      checkFeeTokenAtomic: settlement?.state === "COMPLETED" || feeTx ? (quote?.amountTokenAtomic ?? authorization?.value ?? null) : null,
      plan: plan ? { gasLimit: plan.gasLimit, maxFeePerGasNativeAtomic: plan.maxFeePerGasNativeAtomic } : null,
      policy: { maxNativePaymentAtomic: r.policy.maxNativePaymentAtomic, maxServiceFeeTokenAtomic: r.policy.maxServiceFeeTokenAtomic },
      receipts: { feeTx: receiptOf(caps.feeTx), businessTx: receiptOf(caps.businessTx), createOrderTx: receiptOf(caps.createOrderTx) },
      txs: { feeTx, businessTx, createOrderTx: (createStep?.tx as Hex | undefined) ?? null }, capturedAt: createdAt,
    });
    add("cost-statement.json", pretty(cost), null);
    add("recovery.json", pretty(recoverySummary(r.attemptId, steps, r.execution, source.reconciliation ?? [])), null);
  }
  add("verification-profile.json", pretty(verificationProfile(source.chain.chainId)), null);

  const coverage: StageCoverage = {
    order: !!createStep || !!r?.orderId, intent: true, quote: !!quote || steps.some((s) => s.step === "quote"), feeSettlement: !!feeTx || settlement?.state === "COMPLETED", report: true,
    decision: !!r, finalValidation: !!fv, transactionPlan: !!plan, signed: !!r?.execution.signedTransactionHash,
    broadcast: !!r && ["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"].includes(r.execution.chainStatus), postcondition: !!r?.postcondition,
    reconciliation: (source.reconciliation?.length ?? 0) > 0 || steps.some((s) => s.step === "reconciled"),
  };
  const manifestBase: Omit<Manifest, "files"> = {
    passportVersion: PASSPORT_VERSION, generator: { name: "arcpreflight", release: source.generator.release, component: source.generator.component }, createdAt, disclosure: source.disclosure,
    chain: { chainId: source.chain.chainId, caip2: source.chain.caip2, usdc: source.chain.usdc, nativeDecimals: 18, tokenDecimals: 6 },
    subject: { kind: source.subject.kind, executionMode, runId: source.subject.runId, attemptId: source.subject.attemptId ?? r?.attemptId ?? null, fixture: source.subject.fixture ?? r?.fixture ?? null, orderId: (orderId ?? r?.orderId ?? null) as Hex | null, merchant, payer },
    template: source.template, stageCoverage: coverage, digestProfiles: DIGEST_PROFILE_DESCRIPTIONS, omissions, notes,
  };
  add("verify.md", VERIFY_MD({ ...manifestBase, files: [] }), null);
  const manifest: Manifest = { ...manifestBase, files: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  files[MANIFEST_PATH] = pretty(manifest); // the manifest lists every other file and never hashes itself
  const v = validateFiles(files);
  if (!v.ok) throw new PassportFormatError("built passport violates its own path rules", v.problems);
  return { files, manifest: jsonSafe(manifest) };
}
