// Independent verifier of Payment Passports (docs/PASSPORT.md §6, §8). This package deliberately does not depend on the
// exporter: it re-implements the few format rules it needs so a passport can be checked by code that never produced one.
export type Hex = `0x${string}`;
export type FindingId = "FILE_INTEGRITY" | "DIGEST_INTEGRITY" | "DISCLOSURE" | "APPROVAL_SOURCE" | "APPROVAL_COVERAGE" | "NETWORK_IDENTITY" | "FEE_ATTRIBUTION" | "TRANSACTION_PLAN_AGREEMENT" | "ORDER_OUTCOME" | "COST_STATEMENT" | "CURRENT_ELIGIBILITY";
export type FindingStatus = "PASS" | "FAIL" | "UNVERIFIED" | "NOT_EVALUATED";
export type Finding = { id: FindingId; status: FindingStatus; detail: string; evidence?: Record<string, unknown> };
export const FINDING_ORDER: FindingId[] = ["FILE_INTEGRITY", "DIGEST_INTEGRITY", "DISCLOSURE", "APPROVAL_SOURCE", "APPROVAL_COVERAGE", "NETWORK_IDENTITY", "FEE_ATTRIBUTION", "TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT", "CURRENT_ELIGIBILITY"];

export type Anchors = { baselineDigests: string[]; policyDigests: string[] };
export type VerificationResult = {
  passportVersion: string | null;
  subject: Record<string, unknown> | null;
  chain: { chainId: number | null; caip2: string | null };
  findings: Finding[];
  counts: { pass: number; fail: number; unverified: number; notEvaluated: number };
};

/** The slice of an Arc RPC the verifier uses. Production adapts an explicitly configured URL; tests inject a fake.
 *  Values may come back as bigint, number, hex or decimal strings; the verifier normalises them. */
export type VerifierRpc = {
  getChainId(): Promise<number>;
  getTransaction(hash: Hex): Promise<Record<string, unknown> | null>;
  getTransactionReceipt(hash: Hex): Promise<Record<string, unknown> | null>;
  getBlock(blockHash: Hex): Promise<Record<string, unknown> | null>;
  /** eth_call pinned to a block hash (EIP-1898) */
  call(a: { to: Hex; data: Hex; blockHash: Hex }): Promise<Hex>;
};

export type PassportFiles = Record<string, string>;
export const ACCEPTED_PROFILES = { jcs: "arcpreflight-jcs-keccak-1.0", legacy: "legacy-json-stringify-keccak-1.0", file: "sha256-file-1.0" } as const;
