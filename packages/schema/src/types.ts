// Runtime-validated contracts for spec v1.4 §7 (schemaVersion "1.0"). TypeScript types alone are not enough:
// every external input must pass these zod schemas (addresses 20 bytes, digests 32 bytes, UIntString, UTC time).
import { z } from "zod";
import { getAddress, isAddress } from "viem";

export const SCHEMA_VERSION = "1.0" as const;
export const ARC_CHAIN_ID = 5042 as const;

export const Address = z.string().refine((s) => isAddress(s, { strict: false }), "invalid 20-byte address")
  .transform((s) => getAddress(s).toLowerCase() as `0x${string}`); // canonical lowercase for hashing (spec §7.1)
export const Digest = z.string().regex(/^0x[0-9a-f]{64}$/, "digest must be 32 bytes lowercase hex");
export const HexData = z.string().regex(/^0x([0-9a-f]{2})*$/, "hex data must be lowercase, even length");
export const UIntString = z.string().regex(/^(0|[1-9][0-9]*)$/, "UIntString: decimal integer, no leading zeros, no sign");
export const UtcTime = z.string().datetime({ offset: false }); // RFC 3339 UTC "Z"
export const ChainId = z.literal(ARC_CHAIN_ID);

export const Snapshot = z.object({
  chainId: ChainId,
  blockNumber: UIntString,
  blockHash: Digest,
  observedAt: UtcTime,
  providerId: z.string().min(1),
  pinningMode: z.enum(["BLOCK_HASH", "BLOCK_NUMBER_HASH_CHECKED"]),
}).strict();

export const BusinessExpectation = z.discriminatedUnion("action", [
  z.object({
    sourceId: z.string().min(1),
    sourceDigest: Digest,
    action: z.literal("MERCHANT_PAY"),
    recipient: Address,
    asset: z.literal("ARC_NATIVE_USDC"),
    amountNativeAtomic: UIntString,
    orderId: Digest,
  }).strict(),
  z.object({
    sourceId: z.string().min(1),
    sourceDigest: Digest,
    action: z.literal("SUPPORTED_USDC_TRANSFER"),
    recipient: Address,
    asset: z.literal("ARC_USDC_ERC20"),
    tokenAddress: Address,
    amountTokenAtomic: UIntString,
  }).strict(),
]);

export const ExecutionDependency = z.object({
  address: Address,
  role: z.enum(["TARGET", "IMPLEMENTATION", "BEACON", "TOKEN", "OTHER"]),
  codeHash: Digest.nullable(),
  adapterDigest: Digest.nullable(),
  resolution: z.enum(["VERIFIED_TEMPLATE", "RAW_OBSERVATION", "UNKNOWN"]),
}).strict();

export const BaselineCore = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  chainId: ChainId,
  subject: Address,
  approvedBy: z.string().min(1),
  approvedAt: UtcTime,
  validUntil: UtcTime.nullable(),
  previousBaselineDigest: Digest.nullable(),
  referenceSnapshot: Snapshot,
  dependencies: z.array(ExecutionDependency),
  allowedSelectors: z.array(HexData),
  adapterManifestDigests: z.array(Digest),
  approvedState: z.array(z.object({ key: z.string().min(1), canonicalValue: z.string() }).strict()),
}).strict();

export const PolicyCore = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  ownerPrincipal: z.string().min(1),
  allowedSenders: z.array(Address),
  allowedTargets: z.array(Address),
  allowedSelectors: z.array(HexData),
  maxNativePaymentAtomic: UIntString,
  maxTokenPaymentAtomic: UIntString,
  maxServiceFeeTokenAtomic: UIntString,
  maxGasCostNativeAtomic: UIntString,
  maxReportAgeSeconds: z.number().int().positive(),
  maxFinalValidationAgeSeconds: z.number().int().positive(),
  requiredSignalIds: z.array(z.string().min(1)),
  unknownAction: z.literal("REVIEW_REQUIRED"),
  implementationChangeAction: z.literal("REVIEW_REQUIRED"),
  allowedTransactionTypes: z.tuple([z.literal(2)]),
  allowAuthorizationList: z.literal(false),
}).strict();

export const IntentCore = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  clientRequestId: z.string().min(1).max(128),
  chainId: ChainId,
  walletMode: z.literal("EOA_DIRECT_NON_DELEGATED"),
  from: Address,
  operation: z.literal("CALL"),
  to: Address,
  data: HexData,
  valueNativeAtomic: UIntString,
  businessExpectation: BusinessExpectation,
  baselineDigest: Digest,
  policyDigest: Digest,
  expiresAt: UtcTime,
}).strict();

export const SignalState = z.enum(["observed", "not_observed", "unknown", "not_applicable"]);
export const SignalBasis = z.enum(["chain_read", "simulation", "heuristic", "network_advisory", "indexer_observation"]);
export const Signal = z.object({
  id: z.string().min(1),
  state: SignalState,
  basis: SignalBasis,
  scope: z.string(),
  evidenceDigests: z.array(Digest),
  limitations: z.array(z.string()),
  sourceIds: z.array(z.string()),
}).strict();

export const ReportCore = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  mode: z.enum(["OBJECT_OBSERVATION", "SUPPORTED_INTENT"]),
  intentDigest: Digest.nullable(),
  decisionEligible: z.boolean(),
  observation: Snapshot,
  methodologyDigest: Digest,
  adapterManifestDigests: z.array(Digest),
  baselineDigest: Digest.nullable(),
  baselineResult: z.enum(["MATCH", "IMPLEMENTATION_CHANGED", "STATE_CHANGED", "ADAPTER_CHANGED", "NO_BASELINE", "UNKNOWN"]),
  dependencies: z.array(ExecutionDependency),
  signals: z.array(Signal),
  rawEvidenceDigests: z.array(Digest),
  exclusions: z.array(z.string()),
  expiresAt: UtcTime,
}).strict();

export const Decision = z.enum(["NO_POLICY_VIOLATION", "REVIEW_REQUIRED", "BLOCKED"]);

export const DecisionReceipt = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  executionAttemptId: z.string().min(1),
  intentDigest: Digest,
  reportDigest: Digest,
  baselineDigest: Digest,
  policyDigest: Digest,
  decision: Decision,
  reasons: z.array(z.string()),
  decidedAt: UtcTime,
}).strict();

export const TransactionPlan = z.object({
  chainId: ChainId,
  from: Address,
  type: z.literal(2),
  to: Address,
  data: HexData,
  valueNativeAtomic: UIntString,
  nonce: UIntString,
  gasLimit: UIntString,
  maxFeePerGasNativeAtomic: UIntString,
  maxPriorityFeePerGasNativeAtomic: UIntString,
  accessList: z.tuple([]),
  authorizationList: z.tuple([]), // application-level constraint: must be empty (spec §7.5)
}).strict();

export const FinalValidationReceipt = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  executionAttemptId: z.string().min(1),
  intentDigest: Digest,
  reportDigest: Digest,
  decisionDigest: Digest,
  baselineDigest: Digest,
  policyDigest: Digest,
  snapshot: Snapshot,
  transactionPlan: TransactionPlan,
  transactionPlanDigest: Digest,
  walletEvidenceDigest: Digest,
  criticalStateEvidenceDigests: z.array(Digest),
  simulationEvidenceDigest: Digest.nullable(),
  balanceNativeAtomic: UIntString,
  reservedGasNativeAtomic: UIntString,
  reservedOtherNativeAtomic: UIntString,
  feeEvidenceDigest: Digest,
  result: z.enum(["PASS", "REVIEW_REQUIRED", "BLOCKED"]),
  reasons: z.array(z.string()),
  validatedAt: UtcTime,
  expiresAt: UtcTime,
}).strict();

export const ExecutionReceipt = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  executionAttemptId: z.string().min(1),
  intentDigest: Digest,
  reportDigest: Digest,
  decisionDigest: Digest,
  baselineDigest: Digest,
  policyDigest: Digest,
  finalValidationDigest: Digest.nullable(),
  transactionPlanDigest: Digest.nullable(),
  signedTransactionHash: Digest.nullable(),
  businessTxHash: Digest.nullable(),
  chainStatus: z.enum(["NOT_SIGNED", "SIGNED_NOT_BROADCAST", "PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"]),
  businessStatus: z.enum(["NOT_EXECUTED", "PENDING", "SUCCESS", "FAILED", "UNKNOWN"]),
  postconditionEvidenceDigests: z.array(Digest),
  labels: z.array(z.enum(["LIVE_REQUEST", "DEMO_ON_MAINNET", "RECORDED_SAMPLE"])),
  recordedAt: UtcTime,
}).strict();

export const QuoteCore = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: z.string().min(1),
  buyerPrincipal: z.string().min(1),
  payer: Address,
  intentDigest: Digest,
  reportDigest: Digest,
  coverageDigest: Digest,
  network: z.literal("eip155:5042"),
  asset: Address,
  amountTokenAtomic: UIntString,
  payTo: Address,
  preparedAt: UtcTime,
  expiresAt: UtcTime,
  retentionUntil: UtcTime,
}).strict();

export type Snapshot = z.infer<typeof Snapshot>;
export type BusinessExpectation = z.infer<typeof BusinessExpectation>;
export type ExecutionDependency = z.infer<typeof ExecutionDependency>;
export type BaselineCore = z.infer<typeof BaselineCore>;
export type PolicyCore = z.infer<typeof PolicyCore>;
export type IntentCore = z.infer<typeof IntentCore>;
export type Signal = z.infer<typeof Signal>;
export type ReportCore = z.infer<typeof ReportCore>;
export type DecisionReceipt = z.infer<typeof DecisionReceipt>;
export type TransactionPlan = z.infer<typeof TransactionPlan>;
export type FinalValidationReceipt = z.infer<typeof FinalValidationReceipt>;
export type ExecutionReceipt = z.infer<typeof ExecutionReceipt>;
export type QuoteCore = z.infer<typeof QuoteCore>;
export type Decision = z.infer<typeof Decision>;
