import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { getAddress } from "viem";
import { QuoteCore, quoteDigest, type IntentCore } from "@arcpreflight/schema";
import { FacilitatorClient, buildSettleBody, paymentIdentifier, classifySettle, type Eip3009Authorization } from "@arcpreflight/client";
import { cfg } from "./config.js";
import { type Db, row, run, now } from "./db.js";

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

/** x402 "accepts" entry the buyer must satisfy (mirrors paymentRequirements used at /settle). */
export function paymentRequirementsFor(quote: QuoteCore, resourceUrl: string) {
  return { x402Version: 2, resource: { url: resourceUrl, description: "ArcPreflight supported-intent check", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: quote.network, amount: quote.amountTokenAtomic, asset: quote.asset, payTo: quote.payTo, maxTimeoutSeconds: 12, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }] };
}

export type PaymentInput = { signature: Hex; authorization: Eip3009Authorization };
type SettleBody = ReturnType<typeof buildSettleBody>;
type PaymentState = "SUBMITTED" | "PENDING" | "COMPLETED" | "FAILED";
type PaymentResult = { state: PaymentState; txHash: string | null; paymentId: string | null; reason?: string | null; httpStatus?: number };

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

// Only the recovery outbox holds buyer signatures, encrypted at rest. A deterministic, domain-separated seller
// signature derives its storage key; retaining the original seller key is required to recover its old payments.
async function recoveryKey() {
  if (!cfg.merchant?.signMessage) throw new Error("merchant cannot derive the payment recovery storage key");
  const signature = await cfg.merchant.signMessage({ message: `ArcPreflight payment recovery storage v1\n${cfg.caip2}\n${cfg.merchant.address.toLowerCase()}` });
  return createHash("sha256").update(signature).digest();
}
async function sealBody(body: SettleBody): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await recoveryKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}
async function openBody(encrypted: string): Promise<SettleBody> {
  const envelope = JSON.parse(encrypted);
  if (envelope.version !== 1) throw new Error("unsupported payment recovery payload version");
  const decipher = createDecipheriv("aes-256-gcm", await recoveryKey(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}
function sameAuthorization(a: Eip3009Authorization, b: Eip3009Authorization) {
  return a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase() && a.nonce.toLowerCase() === b.nonce.toLowerCase()
    && a.value === b.value && a.validAfter === b.validAfter && a.validBefore === b.validBefore;
}
const outcome = (p: any): PaymentResult => ({ state: p.state, txHash: p.tx_hash ?? null, paymentId: p.facilitator_payment_id ?? null });

/** Resume the persisted payment, never minting a replacement identifier or authorization. The SQLite lease guards
 * concurrent POST/GET callers and expires after a crashed process; Facilitator HTTP calls are bounded to 15 seconds. */
export async function reconcilePayment(db: Db, requestId: string): Promise<PaymentResult | null> {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  let p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!p) return null;
  if (p.state === "COMPLETED" || p.state === "FAILED") return outcome(p);
  const owner = randomUUID();
  const claimed = run(db, "UPDATE payments SET settle_lease_owner = ?, settle_lease_until = ? WHERE request_id = ? AND state IN ('SUBMITTED','PENDING') AND (settle_lease_until IS NULL OR settle_lease_until <= ?)",
    owner, Date.now() + 30_000, requestId, Date.now());
  if (!claimed.changes) return outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId));
  try {
    p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    const fac = new FacilitatorClient(cfg.merchant, cfg.net);
    if (p.facilitator_payment_id) {
      const s = await fac.status(p.facilitator_payment_id);
      const st = s.httpStatus === 200 ? s.json?.status : null;
      const state = st === "completed" ? "COMPLETED" : st === "failed" ? "FAILED" : p.state;
      run(db, "UPDATE payments SET state = ?, tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?",
        state, s.httpStatus === 200 ? s.json?.transaction ?? null : null, JSON.stringify({ httpStatus: s.httpStatus, body: s.json ?? s.text }), now(), requestId, owner);
      return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId)), httpStatus: s.httpStatus };
    }
    if (!p.settle_payload_encrypted) return { ...outcome(p), reason: "original authorization unavailable; retry this request with the original payment" };
    const body = await openBody(p.settle_payload_encrypted);
    if (body.paymentRequirements.network !== cfg.caip2 || body.paymentRequirements.payTo.toLowerCase() !== cfg.merchant.address.toLowerCase()) throw new Error("payment recovery seller or network changed");
    const res = await fac.settle(body);
    const c = classifySettle(res);
    // Non-200 responses and transport failures have no terminal settlement outcome.
    const state: PaymentState = c.state === "REJECTED" ? "SUBMITTED" : c.state;
    run(db, "UPDATE payments SET state = ?, facilitator_payment_id = COALESCE(?, facilitator_payment_id), tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?",
      state, c.paymentId ?? null, c.transaction ?? null, JSON.stringify({ httpStatus: res.httpStatus, body: res.json ?? res.text }), now(), requestId, owner);
    return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId)), reason: c.reason ?? null, httpStatus: res.httpStatus };
  } catch (e: any) {
    // Preserve the original outbox on a timeout. Recovery will replay its identifier, even after quote/report expiry.
    run(db, "UPDATE payments SET last_response_json = ?, updated_at = ? WHERE request_id = ? AND settle_lease_owner = ?", JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) }), now(), requestId, owner);
    return { ...outcome(row(db, "SELECT * FROM payments WHERE request_id = ?", requestId)), reason: "settlement outcome not yet confirmed; recover the original request" };
  } finally {
    run(db, "UPDATE payments SET settle_lease_owner = NULL, settle_lease_until = NULL WHERE request_id = ? AND settle_lease_owner = ?", requestId, owner);
  }
}

/** Bind one authorization to one immutable quote before the first remote submission. */
export async function settleForRequest(db: Db, requestId: string, quote: QuoteCore, intent: IntentCore, p: PaymentInput, resourceUrl: string): Promise<PaymentResult | { conflict: string }> {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  const mismatch = paymentMatchesQuote(p, quote, intent, !!row(db, "SELECT request_id FROM payments WHERE request_id = ?", requestId));
  if (mismatch) return { conflict: mismatch };
  if (!row(db, "SELECT request_id FROM payments WHERE request_id = ?", requestId) && new Date(quote.expiresAt).getTime() <= Date.now()) return { conflict: "the quoted payment has expired before its first submission" };
  const pid = paymentIdentifier(requestId);
  const body = buildSettleBody({ net: cfg.net, resource: { url: resourceUrl, description: "ArcPreflight supported-intent check", mimeType: "application/json" },
    payTo: quote.payTo as Hex, amountTokenAtomic: quote.amountTokenAtomic, signature: p.signature, authorization: p.authorization, paymentId: pid });
  const encrypted = await sealBody(body);
  try {
    run(db, "INSERT OR IGNORE INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, settle_payload_encrypted, quote_digest, report_digest) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM quotes WHERE request_id = ? AND quote_digest != ?)",
      requestId, pid, quote.network, quote.asset.toLowerCase(), p.authorization.from.toLowerCase(), p.authorization.nonce.toLowerCase(), "SUBMITTED", now(), now(), encrypted, quoteDigest(quote), quote.reportDigest, requestId, quoteDigest(quote));
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

export async function reconcilePending(db: Db, requestId: string) {
  return (await reconcilePayment(db, requestId))?.state ?? null;
}
