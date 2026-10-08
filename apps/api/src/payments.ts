import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { getAddress } from "viem";
import { QuoteCore, quoteDigest, type IntentCore } from "@arcpreflight/schema";
import { FacilitatorClient, buildSettleBody, paymentIdentifier, classifySettle, type Eip3009Authorization, type SettlementEvidence } from "@arcpreflight/client";
import { cfg } from "./config.js";
import { type Db, row, rows, run, now } from "./db.js";
import { client } from "./report.js";
import { Relayer, relayRpcFromClient } from "./relay.js";

export function makeQuote(requestId: string, principal: string, intent: IntentCore, intentDigest: Hex, reportDigest: Hex, coverageDigest: Hex) {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  const preparedAt = now();
  const quote = QuoteCore.parse({
    schemaVersion: "1.0", requestId, buyerPrincipal: principal, payer: intent.from, intentDigest, reportDigest, coverageDigest,
    network: cfg.caip2, asset: cfg.usdc, amountTokenAtomic: cfg.priceTokenAtomic, payTo: cfg.merchant.address,
    preparedAt, expiresAt: new Date(Date.now() + cfg.quoteTtlSeconds * 1000).toISOString(),
    retentionUntil: new Date(Date.now() + cfg.retentionDays * 86400e3).toISOString(),
  });
  return { quote, digest: quoteDigest(quote) };
}

/** x402 "accepts" entry the buyer must satisfy: exact scheme, EIP-3009 on Arc USDC. The wire format is the open standard;
 *  settlement is performed by this server's own relayer, not a hosted facilitator. */
export function paymentRequirementsFor(quote: QuoteCore, resourceUrl: string) {
  return { x402Version: 2, resource: { url: resourceUrl, description: "ArcPreflight supported-intent check", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: quote.network, amount: quote.amountTokenAtomic, asset: quote.asset, payTo: quote.payTo, maxTimeoutSeconds: 12, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }] };
}

export type PaymentInput = { signature: Hex; authorization: Eip3009Authorization };
type SettleBody = ReturnType<typeof buildSettleBody>;
export type SettlementBackend = "circle" | "relay";
type PaymentState = "SUBMITTED" | "PENDING" | "COMPLETED" | "FAILED";
export type PaymentResult = { state: PaymentState; txHash: string | null; paymentId: string | null; backend: SettlementBackend; evidence: SettlementEvidence | null; reason?: string | null; httpStatus?: number };

export function paymentMatchesQuote(p: PaymentInput, quote: QuoteCore, intent: IntentCore, recovering = false): string | null {
  const a = p?.authorization;
  if (!a || typeof p.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p.signature)) return "invalid payment signature or authorization";
  if (![a.value, a.validAfter, a.validBefore].every((v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v))) return "authorization amounts and times must be unsigned decimal strings";
  try {
    if (getAddress(a.to) !== getAddress(quote.payTo)) return "authorization.to != quote.payTo";
    if (a.value !== quote.amountTokenAtomic) return "authorization.value != quote.amount";
    if (getAddress(a.from) !== getAddress(intent.from) || getAddress(a.from) !== getAddress(quote.payer)) return "payer must equal the business sender in the restricted profile";
  } catch { return "invalid authorization address"; }
  // A previously submitted authorization must remain recoverable after its expiry, including completed payments.
  if (!recovering && BigInt(a.validBefore) < BigInt(Math.floor(Date.now() / 1000) + 30)) return "authorization expires too soon";
  if (BigInt(a.validAfter) >= BigInt(a.validBefore)) return "invalid authorization validity window";
  if (typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return "bad nonce";
  return null;
}

// Only the recovery outbox holds buyer signatures (and the relayer's signed transactions), encrypted at rest. A deterministic,
// domain-separated seller signature derives its storage key; retaining the original seller key is required to recover old payments.
async function recoveryKey() {
  if (!cfg.merchant?.signMessage) throw new Error("merchant cannot derive the payment recovery storage key");
  const signature = await cfg.merchant.signMessage({ message: `ArcPreflight payment recovery storage v1\n${cfg.caip2}\n${cfg.merchant.address.toLowerCase()}` });
  return createHash("sha256").update(signature).digest();
}
export async function sealJson(obj: unknown): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await recoveryKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}
export async function openJson(encrypted: string): Promise<any> {
  const envelope = JSON.parse(encrypted);
  if (envelope.version !== 1) throw new Error("unsupported payment recovery payload version");
  const decipher = createDecipheriv("aes-256-gcm", await recoveryKey(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}
const openBody = (s: string) => openJson(s) as Promise<SettleBody>;
function sameAuthorization(a: Eip3009Authorization, b: Eip3009Authorization) {
  return a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase() && a.nonce.toLowerCase() === b.nonce.toLowerCase()
    && a.value === b.value && a.validAfter === b.validAfter && a.validBefore === b.validBefore;
}
const backendOf = (p: any): SettlementBackend => (p?.backend === "relay" ? "relay" : "circle");
const outcome = (p: any): PaymentResult => ({ state: p.state, txHash: p.tx_hash ?? null, paymentId: p.facilitator_payment_id ?? null, backend: backendOf(p),
  evidence: p.settlement_evidence_json ? JSON.parse(p.settlement_evidence_json) : null });

// Single-sender rule: after a restart, earlier payments are reconciled BEFORE any new relay transaction is signed. The server calls
// beginSettlementResume() before listening and resumeSettlements() right after; until that completes, new authorizations are refused
// (503), existing ones are still recoverable. Tests never call beginSettlementResume(), so they run as "resumed".
let settlementResumeState: "not-started" | "resuming" | "done" = "not-started";
export const beginSettlementResume = () => { settlementResumeState = "resuming"; };
export const settlementResumed = () => settlementResumeState !== "resuming";

let relayerInstance: Relayer | null = null;
export function getRelayer(): Relayer {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  return (relayerInstance ??= new Relayer({ net: cfg.net, chainId: cfg.chainId, usdc: cfg.usdc as Hex, account: cfg.merchant, rpc: relayRpcFromClient(client), ...cfg.relay, seal: sealJson, open: openJson }));
}
/** For /health: whether new fee settlements are accepted. Never throws. */
export async function settlementStatus(): Promise<{ backend: "relay"; relayer: string | null; paused: boolean; resumed: boolean; balanceNativeAtomic: string | null; floorNativeAtomic: string; error?: string }> {
  const floor = cfg.relay.floorNativeAtomic.toString(); const resumed = settlementResumed();
  if (!cfg.merchant) return { backend: "relay", relayer: null, paused: true, resumed, balanceNativeAtomic: null, floorNativeAtomic: floor, error: "merchant key not configured" };
  try { const s = await getRelayer().paused(); return { backend: "relay", relayer: cfg.merchant.address, paused: s.paused || !resumed, resumed, balanceNativeAtomic: s.balanceNativeAtomic.toString(), floorNativeAtomic: floor, ...(resumed ? {} : { error: "start-up reconciliation of earlier payments in progress" }) }; }
  catch (e: any) { return { backend: "relay", relayer: cfg.merchant.address, paused: true, resumed, balanceNativeAtomic: null, floorNativeAtomic: floor, error: String(e?.message ?? e).slice(0, 120) }; }
}

/** Resume the persisted payment, never minting a replacement identifier or authorization. The SQLite lease guards concurrent
 *  POST/GET callers and expires after a crashed process. Each row keeps the backend it was first settled with. */
export type SendOpts = { allowSend: boolean };
export async function reconcilePayment(db: Db, requestId: string, opts: SendOpts = { allowSend: true }): Promise<PaymentResult | null> {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  let p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!p) return null;
  if (p.state === "COMPLETED" || p.state === "FAILED") return outcome(p);
  const owner = randomUUID();
  const leaseMs = backendOf(p) === "relay" ? 90_000 : 30_000; // a relay may wait for a receipt and scan logs
  const claimed = run(db, "UPDATE payments SET settle_lease_owner = ?, settle_lease_until = ? WHERE request_id = ? AND state IN ('SUBMITTED','PENDING') AND (settle_lease_until IS NULL OR settle_lease_until <= ?)",
    owner, Date.now() + leaseMs, requestId, Date.now());
  if (!claimed.changes) return outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId));
  try {
    p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    if (backendOf(p) === "circle") return await reconcileLegacyCircle(db, p, owner, opts.allowSend);
    if (!p.settle_payload_encrypted) return { ...outcome(p), reason: "original authorization unavailable; retry this request with the original payment" };
    const body = await openBody(p.settle_payload_encrypted);
    if (body.paymentRequirements.network !== cfg.caip2 || body.paymentRequirements.payTo.toLowerCase() !== cfg.merchant.address.toLowerCase()) throw new Error("payment recovery seller or network changed");
    const r = await getRelayer().settle(db, requestId, { signature: body.paymentPayload.payload.signature, authorization: body.paymentPayload.payload.authorization }, opts);
    return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId)), reason: r.reason ?? null };
  } catch (e: any) {
    // Transport or RPC failures have no terminal outcome: the outbox is preserved and recovery replays it later.
    run(db, "UPDATE payments SET last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?", JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) }), now(), requestId, owner);
    return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId)), reason: "settlement outcome not yet confirmed; recover the original request" };
  } finally {
    run(db, "UPDATE payments SET settle_lease_owner = NULL, settle_lease_until = NULL WHERE request_id = ? AND settle_lease_owner = ?", requestId, owner);
  }
}

/** Legacy rows only: payments first submitted to the hosted facilitator keep its status / replay path. No new row is created here. */
async function reconcileLegacyCircle(db: Db, p: any, owner: string, allowSend = true): Promise<PaymentResult> {
  const fac = new FacilitatorClient(cfg.merchant!, cfg.net);
  if (!allowSend && !p.facilitator_payment_id) return { ...outcome(p), reason: "legacy payment awaiting the settlement worker (read routes never submit)" };
  if (p.facilitator_payment_id) {
    const s = await fac.status(p.facilitator_payment_id);
    const st = s.httpStatus === 200 ? s.json?.status : null;
    const state = st === "completed" ? "COMPLETED" : st === "failed" ? "FAILED" : p.state;
    run(db, "UPDATE payments SET state = ?, tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?",
      state, s.httpStatus === 200 ? s.json?.transaction ?? null : null, JSON.stringify({ httpStatus: s.httpStatus, body: s.json ?? s.text }), now(), p.request_id, owner);
    return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", p.request_id)), httpStatus: s.httpStatus };
  }
  if (!p.settle_payload_encrypted) return { ...outcome(p), reason: "original authorization unavailable; retry this request with the original payment" };
  const body = await openBody(p.settle_payload_encrypted);
  if (body.paymentRequirements.network !== cfg.caip2 || body.paymentRequirements.payTo.toLowerCase() !== cfg.merchant!.address.toLowerCase()) throw new Error("payment recovery seller or network changed");
  const res = await fac.settle(body);
  const c = classifySettle(res);
  const state: PaymentState = c.state === "REJECTED" ? "SUBMITTED" : c.state; // non-200 responses have no terminal outcome
  run(db, "UPDATE payments SET state = ?, facilitator_payment_id = COALESCE(?, facilitator_payment_id), tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?",
    state, c.paymentId ?? null, c.transaction ?? null, JSON.stringify({ httpStatus: res.httpStatus, body: res.json ?? res.text }), now(), p.request_id, owner);
  return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", p.request_id)), reason: c.reason ?? null, httpStatus: res.httpStatus };
}

/** Bind one authorization to one immutable quote before the first settlement attempt. New rows always use the relay backend. */
export async function settleForRequest(db: Db, requestId: string, quote: QuoteCore, intent: IntentCore, p: PaymentInput, resourceUrl: string): Promise<PaymentResult | { conflict: string } | { paused: string }> {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  const existingRow = row(db, "SELECT request_id FROM payments WHERE request_id = ?", requestId);
  const mismatch = paymentMatchesQuote(p, quote, intent, !!existingRow);
  if (mismatch) return { conflict: mismatch };
  if (!existingRow && new Date(quote.expiresAt).getTime() <= Date.now()) return { conflict: "the quoted payment has expired before its first submission" };
  if (!existingRow) {
    // Low balance or start-up stops NEW quotes/broadcasts only: nothing is stored for this request, the buyer retries later.
    // Previously accepted authorizations keep their durable record and continue through reconciliation regardless.
    const status = await settlementStatus();
    if (status.paused) return { paused: status.error ? `settlement unavailable: ${status.error}` : "settlement paused: relayer balance below floor" };
  }
  const pid = paymentIdentifier(requestId);
  const body = buildSettleBody({ net: cfg.net, resource: { url: resourceUrl, description: "ArcPreflight supported-intent check", mimeType: "application/json" },
    payTo: quote.payTo as Hex, amountTokenAtomic: quote.amountTokenAtomic, signature: p.signature, authorization: p.authorization, paymentId: pid });
  const encrypted = await sealJson(body);
  const createdBlock = await client.getBlockNumber?.().then((b) => Math.max(Number(b) - 2, 0)).catch(() => null) ?? null; // bounds later log scans
  try {
    run(db, "INSERT OR IGNORE INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, settle_payload_encrypted, quote_digest, report_digest, backend, created_block) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM quotes WHERE request_id = ? AND quote_digest != ?)",
      requestId, pid, quote.network, quote.asset.toLowerCase(), p.authorization.from.toLowerCase(), p.authorization.nonce.toLowerCase(), "SUBMITTED", now(), now(), encrypted, quoteDigest(quote), quote.reportDigest, "relay", createdBlock, requestId, quoteDigest(quote));
  } catch (e: any) {
    return { conflict: `payment binding could not be persisted: ${String(e?.message ?? e)}` };
  }
  const existing = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!existing) return { conflict: "the quote changed or this authorization nonce is already bound to another request" };
  if (existing.auth_nonce.toLowerCase() !== p.authorization.nonce.toLowerCase() || existing.payer.toLowerCase() !== p.authorization.from.toLowerCase()
    || (existing.quote_digest && existing.quote_digest !== quoteDigest(quote)) || (existing.report_digest && existing.report_digest !== quote.reportDigest)) {
    return { conflict: "a different authorization or quote is already bound to this request" };
  }
  if (existing.settle_payload_encrypted) {
    const original = await openBody(existing.settle_payload_encrypted);
    if (!sameAuthorization(original.paymentPayload.payload.authorization, p.authorization)) return { conflict: "a different authorization is already bound to this request" };
  } else {
    // Add recovery payloads to pre-migration records only when their originally bound payer and nonce are supplied.
    run(db, "UPDATE payments SET settle_payload_encrypted = ?, quote_digest = ?, report_digest = ? WHERE request_id = ? AND settle_payload_encrypted IS NULL", encrypted, quoteDigest(quote), quote.reportDigest, requestId);
  }
  return (await reconcilePayment(db, requestId))!;
}

export async function reconcilePending(db: Db, requestId: string, opts: SendOpts = { allowSend: true }) {
  return (await reconcilePayment(db, requestId, opts))?.state ?? null;
}

/** The settlement side of the recovery worker: re-examine every unresolved payment with sending allowed. Sequential, best effort. */
export async function reconcileOpenPayments(db: Db, log: (m: string) => void = () => {}, minAgeMs = 0) {
  const cutoff = new Date(Date.now() - minAgeMs).toISOString(); // the worker skips rows a POST may still be settling; start-up resume (minAgeMs 0) takes everything
  const open = rows(db, "SELECT request_id, backend, state FROM payments WHERE state IN ('SUBMITTED','PENDING') AND created_at <= ? ORDER BY created_at", cutoff);
  for (const p of open) {
    try { const r = await reconcilePayment(db, p.request_id, { allowSend: true }); log(`reconcile ${p.request_id} (${backendOf(p)}): ${p.state} -> ${r?.state}${r?.reason ? ` (${r.reason})` : ""}`); }
    catch (e: any) { log(`reconcile ${p.request_id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  return open.length;
}
/** At start-up: the same pass, after which new authorizations are accepted again (a crash may have happened between signing and broadcast). */
export async function resumeSettlements(db: Db, log: (m: string) => void = () => {}) {
  try { return await reconcileOpenPayments(db, log); } finally { settlementResumeState = "done"; }
}
