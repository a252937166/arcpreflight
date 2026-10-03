import { BaselineCore, QuoteCore, ReportCore, baselineDigest, intentDigest } from "@arcpreflight/schema";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import type { DeveloperOrder } from "../src/lib/preflight";

export const D = `0x${"11".repeat(32)}` as const;
export const ACCOUNT = "0x0000000000000000000000000000000000000a11";
export const MERCHANT = "0x0000000000000000000000000000000000000a22";
export const IMPL = "0x0000000000000000000000000000000000000b22";
export const REQUEST = "00000000-0000-0000-0000-000000000001";
export const NOW = new Date("2026-10-03T12:00:00Z");
export const snapshot = { chainId: 5042002 as const, blockNumber: "100", blockHash: D, observedAt: NOW.toISOString(), providerId: "offline", pinningMode: "BLOCK_HASH" as const };
export const baseline = BaselineCore.parse({ schemaVersion: "1.0", chainId: 5042002, subject: MERCHANT, approvedBy: "offline-admin", approvedAt: "2026-10-02T12:00:00Z", validUntil: null, previousBaselineDigest: null,
  referenceSnapshot: snapshot, dependencies: [{ address: MERCHANT, role: "TARGET", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" }, { address: IMPL, role: "IMPLEMENTATION", codeHash: D, adapterDigest: D, resolution: "VERIFIED_TEMPLATE" }],
  allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [D], approvedState: [] });
export const baselineHash = baselineDigest(baseline);
export const order: DeveloperOrder = { orderId: `0x${"ab".repeat(32)}`, tx: D, block: "100", merchant: MERCHANT, amountNativeAtomic: "50000000000000000", baselineDigest: baselineHash };
export function reportFor(intent: Parameters<typeof intentDigest>[0]) {
  return ReportCore.parse({ schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: intentDigest(intent), decisionEligible: true, observation: snapshot, methodologyDigest: D, adapterManifestDigests: [D], baselineDigest: baselineHash, baselineResult: "MATCH", dependencies: baseline.dependencies,
    signals: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"].map((id) => ({ id, state: "observed", basis: id === "CALL_SIMULATION" ? "simulation" : "chain_read", scope: "offline", evidenceDigests: [D], limitations: [], sourceIds: [] })), rawEvidenceDigests: [D], exclusions: [], expiresAt: "2026-10-03T12:01:00Z" });
}
export function quoteFor(intent: Parameters<typeof intentDigest>[0], pinnedBlock = "100") {
  const quote = QuoteCore.parse({ schemaVersion: "1.0", requestId: REQUEST, buyerPrincipal: "offline-trial", payer: intent.from, intentDigest: intentDigest(intent), reportDigest: D, coverageDigest: D, network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amountTokenAtomic: "10000", payTo: MERCHANT,
    preparedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), retentionUntil: "2026-11-03T12:00:00Z" });
  return { requestId: REQUEST, pinnedBlock, quote };
}
export function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
