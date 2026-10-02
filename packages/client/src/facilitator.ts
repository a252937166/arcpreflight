import type { Account, Hex } from "viem";
import { ARC, FACILITATOR_BASE, type ArcNet } from "./networks.js";
import { buildSellerProof } from "./sellerProof.js";
import type { Eip3009Authorization } from "./eip3009.js";

export type PaymentRequirements = {
  scheme: "exact"; network: string; amount: string; asset: Hex; payTo: Hex; maxTimeoutSeconds: number;
  extra: { name: "USDC"; version: "2" };
};
export type Resource = { url: string; description: string; mimeType: string };

/** payment-identifier: 16–128 chars of [A-Za-z0-9_-], seller-scoped idempotency key (spec §8.5 / Circle docs). */
export function paymentIdentifier(requestId: string): string {
  const id = `ap_${requestId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  if (id.length < 16) return (id + "_".repeat(16)).slice(0, 16);
  return id;
}

export function buildSettleBody(args: {
  net: ArcNet; resource: Resource; payTo: Hex; amountTokenAtomic: string; signature: Hex; authorization: Eip3009Authorization; paymentId: string; maxTimeoutSeconds?: number;
}) {
  const req: PaymentRequirements = {
    scheme: "exact", network: ARC[args.net].caip2, amount: args.amountTokenAtomic, asset: ARC[args.net].usdc, payTo: args.payTo,
    maxTimeoutSeconds: args.maxTimeoutSeconds ?? 12, extra: { name: "USDC", version: "2" },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: args.resource,
      accepted: { ...req, extra: { ...req.extra, assetTransferMethod: "eip3009" } },
      payload: { signature: args.signature, authorization: args.authorization },
      extensions: { "payment-identifier": { info: { required: true, id: args.paymentId } } },
    },
    paymentRequirements: req,
  };
}

export type SettleResponse = {
  success: boolean; payer?: Hex; transaction?: string; network?: string; amount?: string; errorReason?: string;
  extensions?: { "settlement-status"?: { status: "pending" | "completed" | "failed"; paymentId: string; statusUrl: string } };
};
export type StatusResponse = { paymentId: string; status: "pending" | "completed" | "failed"; transaction?: string; errorReason?: string; network?: string; [k: string]: unknown };

export class FacilitatorClient {
  constructor(private seller: Account, private net: ArcNet, private base = FACILITATOR_BASE, private fetchImpl: typeof fetch = fetch) {}

  private async send(path: string, purpose: "verify" | "settle" | "status", method: "GET" | "POST", body?: unknown) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const proof = await buildSellerProof(this.seller, this.net, purpose, method, raw);
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method, headers: { "Facilitator-Seller-Proof": proof, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, body: method === "POST" ? raw : undefined,
    });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    return { httpStatus: res.status, json, text };
  }
  /** POST /settle — HTTP 200 always carries an outcome (success true | pending | terminal failure); 4xx/5xx carry none. */
  async settle(body: ReturnType<typeof buildSettleBody>) { return this.send("/settle", "settle", "POST", body) as Promise<{ httpStatus: number; json: SettleResponse | null; text: string }>; }
  async verify(body: ReturnType<typeof buildSettleBody>) { return this.send("/verify", "verify", "POST", body); }
  async status(paymentId: string) { return this.send(`/status/${paymentId}`, "status", "GET") as Promise<{ httpStatus: number; json: StatusResponse | null; text: string }>; }
}

/** Interpret a /settle outcome for the application payment state machine (spec §8.6/§8.7). */
export function classifySettle(r: { httpStatus: number; json: SettleResponse | null }): { state: "COMPLETED" | "PENDING" | "FAILED" | "REJECTED"; paymentId?: string; transaction?: string; reason?: string } {
  if (r.httpStatus !== 200 || !r.json) return { state: "REJECTED", reason: `http ${r.httpStatus}` };
  const j = r.json; const ext = j.extensions?.["settlement-status"];
  if (j.success) return { state: "COMPLETED", transaction: j.transaction, paymentId: ext?.paymentId };
  if (j.errorReason === "settlement_pending" && ext?.paymentId) return { state: "PENDING", paymentId: ext.paymentId, reason: j.errorReason };
  return { state: "FAILED", paymentId: ext?.paymentId, reason: j.errorReason };
}
