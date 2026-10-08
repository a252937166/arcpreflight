// Payment Passport format 1.0 — the field names here are the contract in docs/PASSPORT.md (§2, §4, §7).
// Core receipts keep schemaVersion "1.0" and their digest rules; everything passport-specific carries its own version.
import type { BaselineCore, IntentCore, PolicyCore, ReportCore, DecisionReceipt, TransactionPlan, FinalValidationReceipt, ExecutionReceipt, QuoteCore, Snapshot } from "@arcpreflight/schema";

export type Hex = `0x${string}`;
export const PASSPORT_VERSION = "1.0" as const;
export const PASSPORT_BUNDLE_VERSION = "1.0" as const;
export const COST_STATEMENT_VERSION = "1.1" as const;
/** who the buyer side of a cost statement is: the project's own runner (project-funded demo), a visitor's wallet, or a check buyer */
export type BuyerRole = "project-runner" | "visitor-wallet" | "buyer";
export const RECOVERY_VERSION = "1.0" as const;
export const ORDER_SUMMARY_VERSION = "1.0" as const;
export const PAYMENT_VERSION = "1.0" as const;
export const VERIFICATION_PROFILE_VERSION = "1.0" as const;

/** The only digest profiles a verifier may accept (docs/PASSPORT.md §3). Names are frozen. */
export const DIGEST_PROFILES = {
  jcs: "arcpreflight-jcs-keccak-1.0",
  legacy: "legacy-json-stringify-keccak-1.0",
  file: "sha256-file-1.0",
} as const;
export type DigestProfile = (typeof DIGEST_PROFILES)[keyof typeof DIGEST_PROFILES];
export const DIGEST_PROFILE_DESCRIPTIONS: Record<DigestProfile, string> = {
  "arcpreflight-jcs-keccak-1.0": "keccak256(UTF8(JCS({kind, schemaVersion, payload}))) — RFC 8785 canonical JSON; kinds: intent, report, policy, baseline, decision, transactionPlan, finalValidation, execution, quote, evidence",
  "legacy-json-stringify-keccak-1.0": "keccak256(UTF8(JSON.stringify(record))) over the record exactly as the runner serialised it; the file holds the byte-exact preimage",
  "sha256-file-1.0": "sha256 over the file's UTF-8 bytes",
};

/** Structural copy of the observer's RpcEvidence: the passport package does not depend on the observer. */
export type RpcEvidenceLike = { kind: "rpc"; method: string; params: string[]; result: string | null; error: string | null; snapshot: Snapshot; capturedAt: string };
export type EvidenceEntry = { evidence: RpcEvidenceLike; digest: Hex };
export type Eip3009AuthorizationWithoutSignature = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
export type SettlementEvidenceLike = { transactionHash: Hex; blockNumber: string; authorizationUsedLogIndex: number; transferLogIndex: number; from: Hex; to: Hex; value: string; nonce: Hex };
export type Step = { step: string; atMs: number; [k: string]: unknown };
/** A transaction and receipt as returned by an RPC at export time (bigints rendered as decimal strings). A labelled capture, not pinned evidence. */
export type Capture = { tx: Record<string, unknown> | null; receipt: Record<string, unknown> | null; capturedAt?: string; note?: string };
export type ReconciliationEntry = { at: string; chainStatus: string; businessStatus: string; note: string | null };
export type PostconditionRecord = { orderId: Hex; paid: boolean; payer: string; amountNativeAtomic: string; block: string; receiptStatus: string };
export type ApprovalStatus = { revoked: boolean; validUntil: string | null; fetchedAt: string };
/** docs/LIFECYCLE.md §1: who signed the business transaction. `runner` = the project runner (bytes persisted before broadcast, every
 *  plan field compared before sending); `wallet` = the visitor's EIP-1193 wallet (plan persisted as an attempt before the prompt,
 *  only the hash reported; wallet-set gas, fees and nonce are recorded as deviations). */
export type ExecutionMode = "runner" | "wallet";
/** `demo-run` executes through the runner, `wallet-run` through the visitor's wallet, `paid-check` executed nothing. */
export type SubjectKind = "demo-run" | "wallet-run" | "paid-check";

/** What `runFixture` returns, plus the passport additions (quote, fee authorization without signature, final-validation evidence, approval status). */
export type RunResultLike = {
  fixture: string; network: string; chainId: number; attemptId: string; orderId: Hex; merchant: Hex;
  intent: IntentCore; intentDigest: Hex; policy: PolicyCore; policyDigest: Hex; requestId: string; serviceFeeTx: Hex | null;
  report: ReportCore; reportDigest: Hex; simulation: unknown; decision: DecisionReceipt; decisionDigest: Hex;
  finalValidation: FinalValidationReceipt | null; plan: TransactionPlan | null; execution: ExecutionReceipt; executionDigest: Hex;
  postcondition: PostconditionRecord | null; steps: Step[]; durationMs: number;
  quote?: QuoteCore | null; quoteDigest?: Hex | null; feeAuthorization?: Eip3009AuthorizationWithoutSignature | null;
  finalValidationEvidence?: EvidenceEntry[]; approvalStatusAtValidation?: ApprovalStatus | null;
};

export type PassportSource = {
  generator: { release: string; component: "api" | "cli" };
  disclosure: "public" | "private";
  chain: { chainId: 5042 | 5042002; caip2: string; usdc: Hex };
  /** executionMode defaults by kind: demo-run → runner, wallet-run → wallet, paid-check → runner; an inconsistent pair is refused */
  subject: { kind: SubjectKind; runId: string | null; attemptId: string | null; fixture?: string | null; executionMode?: ExecutionMode };
  template: { id: string; merchant: string | null; method: string; selector: Hex };
  /** the runner's output; null for a paid-check passport */
  result: RunResultLike | null;
  /** for a paid-check passport (no runner output): the intent that was checked and the report that was paid for */
  check?: { intent: IntentCore; report: ReportCore } | null;
  /** the referenced approval as stored by the approving server; null → listed under omissions */
  baseline: BaselineCore | null;
  reportEvidence: EvidenceEntry[];
  settlement: { backend: "relay" | "circle"; state: string; transactionHash: Hex | null; relayer: Hex | null; evidence: SettlementEvidenceLike | null } | null;
  payment: { requestId: string; quote: QuoteCore | null; authorization: Eip3009AuthorizationWithoutSignature | null } | null;
  chainCaptures?: { feeTx?: Capture | null; businessTx?: Capture | null; createOrderTx?: Capture | null };
  reconciliation?: ReconciliationEntry[];
  createdAt?: string;
};

export type ManifestFileEntry = {
  path: string; bytes: number; sha256: Hex;
  object: { kind: string; schemaVersion: string | null; digestProfile: DigestProfile; digest: Hex } | null;
};
export type StageCoverage = { order: boolean; intent: boolean; quote: boolean; feeSettlement: boolean; report: boolean; decision: boolean; finalValidation: boolean; transactionPlan: boolean; signed: boolean; broadcast: boolean; postcondition: boolean; reconciliation: boolean };
export type Manifest = {
  passportVersion: typeof PASSPORT_VERSION;
  generator: { name: "arcpreflight"; release: string; component: "api" | "cli" };
  createdAt: string;
  disclosure: "public" | "private";
  chain: { chainId: number; caip2: string; usdc: Hex; nativeDecimals: 18; tokenDecimals: 6 };
  subject: { kind: SubjectKind; executionMode: ExecutionMode; runId: string | null; attemptId: string | null; fixture: string | null; orderId: Hex | null; merchant: Hex | null; payer: Hex | null };
  template: { id: string; merchant: string | null; method: string; selector: Hex };
  stageCoverage: StageCoverage;
  digestProfiles: Record<DigestProfile, string>;
  files: ManifestFileEntry[];
  omissions: { path: string; reason: string }[];
  notes: string[];
};

export type OrderSummary = {
  orderSummaryVersion: typeof ORDER_SUMMARY_VERSION;
  orderId: Hex; merchant: Hex; payer: Hex; amountNativeAtomic: string; amountUsdc: string;
  createOrder: { tx: Hex | null; block: string | null; signer: string | null };
  referencedApproval: { baselineDigest: Hex; approvedImplementation: Hex | null; observedImplementation: Hex | null; baselineResult: string; statusAtFinalValidation: ApprovalStatus | null };
  executionMode: ExecutionMode;
  decision: string; chainResult: string; orderResult: "paid" | "unpaid" | "unknown"; serviceOutcome: "NOT_EVALUATED";
  checkFee: { tokenAtomic: string | null; usdc: string | null; tx: Hex | null };
  businessTx: Hex | null; network: string; release: string;
};

export type PaymentFile = {
  paymentVersion: typeof PAYMENT_VERSION; scheme: "x402/exact"; assetTransferMethod: "eip3009"; requestId: string;
  quote: QuoteCore | null; quoteDigest: Hex | null;
  authorization: Eip3009AuthorizationWithoutSignature | null;
  settlement: { backend: "relay" | "circle"; state: string; relayer: Hex | null; transactionHash: Hex | null; blockNumber: string | null; authorizationUsedLogIndex: number | null; transferLogIndex: number | null } | null;
};

export type MoneyNative = { nativeAtomic: string; usdc: string };
export type GasCost = { nativeAtomic: string; usdc: string; gasUsed: string; effectiveGasPriceNativeAtomic: string; tx: Hex | null };
export type GasCostWithAddress = GasCost & { address: Hex | null };
export type CostStatement = {
  costStatementVersion: typeof COST_STATEMENT_VERSION; unit: "USDC"; nativeDecimals: 18; tokenDecimals: 6; capturedAt: string;
  /** `complete` is false when a receipt that should exist is missing (the total is then the known subtotal, never the full cost; a reader must not show it as the total) */
  buyer: { address: Hex; role: BuyerRole; businessPrincipal: MoneyNative; checkFee: { tokenAtomic: string; nativeAtomicEquivalent: string; usdc: string } | null; businessGas: GasCost | null; totalNativeAtomic: string; totalUsdc: string; complete: boolean };
  operator: { feeRelay: GasCostWithAddress | null; orderCreation: GasCostWithAddress | null; totalNativeAtomic: string; totalUsdc: string; complete: boolean };
  authorizedMaximum: { businessPrincipalNativeAtomic: string | null; checkFeeTokenAtomic: string | null; businessGasNativeAtomic: string | null };
  actual: { businessPrincipalNativeAtomic: string; checkFeeTokenAtomic: string; businessGasNativeAtomic: string | null };
  unresolvedReservation: { nativeAtomic: string; note: string };
  sources: { feeTx: Hex | null; createOrderTx: Hex | null; businessTx: Hex | null };
  notes: string[];
};

/** see the mapping table at the top of recovery.ts */
export type RecoveryStatus = "none" | "not-sent" | "confirmed" | "recovered-confirmed" | "recovered-from-event" | "reverted" | "not-mined" | "unresolved";
export type RecoverySummary = {
  recoveryVersion: typeof RECOVERY_VERSION; attemptId: string; interrupted: boolean;
  counters: { ordersCreated: number; checkFeeAuthorizations: number; businessSignatures: number; broadcastsOfOriginalBytes: number; replacementSignatures: number };
  /** what recovery added beyond the original attempt (design §5 "New orders created: 0"): everything past the first of each, plus rebroadcasts */
  addedByRecovery: { ordersCreated: number; checkFeeAuthorizations: number; businessSignatures: number; broadcastsOfOriginalBytes: number };
  originalTransaction: { hash: Hex | null; status: RecoveryStatus };
  reconciliation: ReconciliationEntry[];
};

export type VerificationProfile = {
  verificationProfileVersion: typeof VERIFICATION_PROFILE_VERSION;
  acceptedDigestProfiles: DigestProfile[];
  anchors: { format: { baselineDigests: string[]; policyDigests: string[] }; source: string };
  offlineChecks: string[]; anchorChecks: string[]; onlineChecks: string[]; neverEvaluated: string[];
  rpc: { chainId: number; methods: string[] };
};

export type PassportFiles = Record<string, string>;
export type BuiltPassport = { files: PassportFiles; manifest: Manifest };
