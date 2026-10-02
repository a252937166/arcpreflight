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

export function paymentMatchesQuote(p: PaymentInput, quote: QuoteCore, intent: IntentCore): string | null {
  const a = p.authorization;
  if (getAddress(a.to) !== getAddress(quote.payTo)) return "authorization.to != quote.payTo";
  if (a.value !== quote.amountTokenAtomic) return "authorization.value != quote.amount";
  if (getAddress(a.from) !== getAddress(intent.from)) return "payer must equal the business sender in the restricted profile";
  if (BigInt(a.validBefore) < BigInt(Math.floor(Date.now() / 1000) + 30)) return "authorization expires too soon";
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return "bad nonce";
  return null;
}

/** Settle exactly one authorization for exactly one quote. Idempotent on (request) via payment-identifier and on
 *  (network, asset, payer, nonce) via the DB unique constraint (spec §8.5). */
export async function settleForRequest(db: Db, requestId: string, quote: QuoteCore, intent: IntentCore, p: PaymentInput, resourceUrl: string) {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  const pid = paymentIdentifier(requestId);
  const existing = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (existing) {
    if (existing.auth_nonce.toLowerCase() !== p.authorization.nonce.toLowerCase() || existing.payer.toLowerCase() !== p.authorization.from.toLowerCase()) {
      return { conflict: "a different authorization is already bound to this request" as const };
    }
    if (existing.state === "COMPLETED") return { state: "COMPLETED" as const, txHash: existing.tx_hash as string | null, paymentId: existing.facilitator_payment_id as string | null };
  } else {
    try {
      run(db, "INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        requestId, pid, quote.network, quote.asset.toLowerCase(), p.authorization.from.toLowerCase(), p.authorization.nonce.toLowerCase(), "SUBMITTED", now(), now());
    } catch (e: any) {
      return { conflict: `authorization nonce already used: ${String(e?.message ?? e)}` as const };
    }
  }
  const fac = new FacilitatorClient(cfg.merchant, cfg.net);
  const body = buildSettleBody({ net: cfg.net, resource: { url: resourceUrl, description: "ArcPreflight supported-intent check", mimeType: "application/json" },
    payTo: quote.payTo as Hex, amountTokenAtomic: quote.amountTokenAtomic, signature: p.signature, authorization: p.authorization, paymentId: pid });
  const res = await fac.settle(body);
  const c = classifySettle(res);
  const state = c.state === "COMPLETED" ? "COMPLETED" : c.state === "PENDING" ? "PENDING" : c.state === "FAILED" ? "FAILED" : "SUBMITTED";
  run(db, "UPDATE payments SET state = ?, facilitator_payment_id = COALESCE(?, facilitator_payment_id), tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ?",
    state, c.paymentId ?? null, c.transaction ?? null, JSON.stringify({ httpStatus: res.httpStatus, body: res.json ?? res.text }), now(), requestId);
  return { state: c.state, txHash: c.transaction ?? null, paymentId: c.paymentId ?? null, reason: c.reason ?? null, httpStatus: res.httpStatus };
}

export async function reconcilePending(db: Db, requestId: string) {
  if (!cfg.merchant) throw new Error("merchant payTo key not configured");
  const p = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  if (!p || p.state !== "PENDING" || !p.facilitator_payment_id) return p?.state ?? null;
  const fac = new FacilitatorClient(cfg.merchant, cfg.net);
  const s = await fac.status(p.facilitator_payment_id);
  const st = s.json?.status;
  const state = st === "completed" ? "COMPLETED" : st === "failed" ? "FAILED" : "PENDING";
  run(db, "UPDATE payments SET state = ?, tx_hash = COALESCE(?, tx_hash), last_response_json = ?, updated_at = ? WHERE request_id = ?",
    state, (s.json?.transaction as string | undefined) ?? null, JSON.stringify({ httpStatus: s.httpStatus, body: s.json ?? s.text }), now(), requestId);
  return state;
}
