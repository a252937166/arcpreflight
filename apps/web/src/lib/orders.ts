// The order dialog's rules (docs/LIFECYCLE.md §2, AP33-11): amounts are typed in USDC (6 decimals) and sent as 18-decimal native
// units; the limits come from `GET /v1/network → orders` and are mirrored here so a visitor sees the same refusal the server
// would give, before anything leaves. Nothing here talks to the API: the Developer page does, with this module's body.
import { isAddress } from "viem";
import type { FixtureInfo, NetworkInfo, OrderCreated, OrderCreationFailure, OrderPending, OrderView } from "./api";
import type { DeveloperOrder } from "./preflight";

export type Proxy = "MAIN" | "CHANGED";
export type OrderLimits = { minNativeAtomic: bigint; maxNativeAtomic: bigint; stepNativeAtomic: bigint; defaultNativeAtomic: bigint; maxReferenceLength: number };
/** the server's defaults (apps/api ORDER_LIMITS); used until /v1/network has answered */
export const DEFAULT_LIMITS: OrderLimits = { minNativeAtomic: 1_000_000_000_000_000n, maxNativeAtomic: 1_000_000_000_000_000_000n, stepNativeAtomic: 1_000_000_000_000n, defaultNativeAtomic: 50_000_000_000_000_000n, maxReferenceLength: 64 };
export function orderLimits(net: NetworkInfo | null | undefined): OrderLimits {
  const o = net?.orders; if (!o) return DEFAULT_LIMITS;
  try { return { minNativeAtomic: BigInt(o.minNativeAtomic), maxNativeAtomic: BigInt(o.maxNativeAtomic), stepNativeAtomic: BigInt(o.stepNativeAtomic), defaultNativeAtomic: BigInt(o.defaultNativeAtomic), maxReferenceLength: Number(o.maxReferenceLength) || 64 }; }
  catch { return DEFAULT_LIMITS; }
}

/** what the visitor types; the payer is the connected wallet and is not editable */
export type OrderForm = { proxy: Proxy; amountUsdc: string; reference: string };
export type OrderFormField = "payer" | "proxy" | "amount" | "reference";
export type OrderFormErrors = Partial<Record<OrderFormField, string>>;
/** the exact body of POST /v1/demo/orders */
export type OrderBody = { payer: string; proxy: Proxy; amountNativeAtomic: string; reference?: string };

const ONE_USDC = 10n ** 18n;
/** "0.05" → 50000000000000000n. Up to 6 decimals (whole 6-decimal token units), nothing else accepted; never a float. */
export function usdcToNativeAtomic(text: string): { ok: true; atomic: bigint } | { ok: false; reason: string } {
  const t = text.trim().replace(/,/g, ".");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!t || !m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, reason: "enter an amount in USDC, e.g. 0.05" };
  const whole = m[1] || "0", frac = m[2] ?? "";
  if (frac.length > 6) return { ok: false, reason: "at most 6 decimals: USDC is a 6-decimal token (the chain stores 18-decimal native units, in whole token steps)" };
  return { ok: true, atomic: BigInt(whole) * ONE_USDC + BigInt(frac.padEnd(18, "0").slice(0, 18)) };
}
/** exact decimal text of 18-decimal native units, trailing zeros trimmed ("0.05", "1", "0.000001"); no floats */
export function nativeAtomicToUsdcText(atomic: bigint | string): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const neg = v < 0n; const a = neg ? -v : v;
  const frac = (a % ONE_USDC).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / ONE_USDC}${frac ? `.${frac}` : ""}`;
}
/** exact decimal text of 6-decimal token units ("0.01") */
export function tokenAtomicToUsdcText(atomic: bigint | string): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${v / 1_000_000n}${frac ? `.${frac}` : ""}`;
}

/** the check fee (6-decimal token units from /v1/network) as USDC text; "0.01" until the network has answered */
export function feeUsdcText(net: Pick<NetworkInfo, "priceTokenAtomic"> | null | undefined, fallback = "0.01"): string {
  try { return net?.priceTokenAtomic ? tokenAtomicToUsdcText(net.priceTokenAtomic) : fallback; } catch { return fallback; }
}
/** the demonstration order amount the Live Demo pays (18-decimal native units from /v1/network → budget); "0.05" until known */
export function demoOrderUsdcText(net: Pick<NetworkInfo, "budget"> | null | undefined, fallback = "0.05"): string {
  try { return net?.budget?.amountNativeAtomic ? nativeAtomicToUsdcText(net.budget.amountNativeAtomic) : fallback; } catch { return fallback; }
}

/** Mirrors apps/api parseOrderInput: labelled reasons per field, nothing coerced silently. `body` is set only when every field passes. */
export function validateOrderForm(form: OrderForm, payer: string | null, limits: OrderLimits = DEFAULT_LIMITS): { errors: OrderFormErrors; body: OrderBody | null } {
  const errors: OrderFormErrors = {};
  if (!payer || !isAddress(payer)) errors.payer = "connect a wallet: the payer is the connected account";
  if (form.proxy !== "MAIN" && form.proxy !== "CHANGED") errors.proxy = "proxy must be MAIN or CHANGED";
  const amount = usdcToNativeAtomic(form.amountUsdc);
  if (!amount.ok) errors.amount = amount.reason;
  else if (amount.atomic < limits.minNativeAtomic || amount.atomic > limits.maxNativeAtomic) errors.amount = `between ${nativeAtomicToUsdcText(limits.minNativeAtomic)} and ${nativeAtomicToUsdcText(limits.maxNativeAtomic)} USDC`;
  else if (amount.atomic % limits.stepNativeAtomic !== 0n) errors.amount = "a whole number of 6-decimal USDC units";
  const reference = form.reference.trim();
  if (reference.length > limits.maxReferenceLength) errors.reference = `at most ${limits.maxReferenceLength} characters (${reference.length} typed)`;
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f]/.test(reference)) errors.reference = "no control characters";
  if (Object.keys(errors).length || !amount.ok || !payer) return { errors, body: null };
  return { errors, body: { payer, proxy: form.proxy, amountNativeAtomic: amount.atomic.toString(), ...(reference ? { reference } : {}) } };
}

/** "Autofill sample order": valid values a visitor can edit — the default amount and a dated reference. */
export function sampleOrder(date: Date = new Date(), limits: OrderLimits = DEFAULT_LIMITS): OrderForm {
  return { proxy: "MAIN", amountUsdc: nativeAtomicToUsdcText(limits.defaultNativeAtomic), reference: `sample order ${date.toISOString().slice(0, 10)}` };
}
export const EMPTY_ORDER_FORM: OrderForm = { proxy: "MAIN", amountUsdc: "", reference: "" };

/** A 400 INVALID_INPUT { field, reason } from the server, folded onto the field it names (unknown fields land on the amount line). */
export function serverFieldError(body: any): OrderFormErrors {
  const reason = typeof body?.reason === "string" ? body.reason : "the server rejected this order";
  const map: Record<string, OrderFormField> = { payer: "payer", proxy: "proxy", amountNativeAtomic: "amount", reference: "reference" };
  return { [map[String(body?.field)] ?? "amount"]: reason };
}

/** The fixture that describes a proxy (approved vs current implementation, baseline digest). Both MAIN fixtures share one approval; the
 *  one whose expectation is about the proxy itself (APPROVED_PAYMENT, CHANGED_IMPLEMENTATION) wins over the unit-mistake fixture. */
const PROXY_FIXTURE_PREFERENCE = ["APPROVED_PAYMENT", "CHANGED_IMPLEMENTATION"];
export const fixtureForProxy = (net: NetworkInfo | null | undefined, proxy: Proxy | null | undefined): FixtureInfo | null => {
  const deployed = (net?.fixtures ?? []).filter((f) => f.proxy === proxy && !!f.merchant);
  return deployed.find((f) => PROXY_FIXTURE_PREFERENCE.includes(f.id)) ?? deployed[0] ?? null;
};
export const baselineDigestFor = (net: NetworkInfo | null | undefined, proxy: Proxy | null | undefined): string | null => fixtureForProxy(net, proxy)?.baselineDigest ?? null;

/** The order as the preflight helpers (lib/preflight.ts) expect it, from either the creation response or a listed order. */
export function toDeveloperOrder(o: OrderCreated | OrderView, baselineDigest: string | null): DeveloperOrder & { proxy: Proxy | null; reference: string | null } {
  const digest = (o as OrderCreated).baselineDigest ?? baselineDigest ?? null;
  return { orderId: o.orderId as `0x${string}`, tx: (o.tx ?? "0x") as `0x${string}`, block: o.block ?? "0", merchant: o.merchant as `0x${string}`, amountNativeAtomic: o.amountNativeAtomic, baselineDigest: digest as `0x${string}` | null, proxy: o.proxy ?? null, reference: o.reference ?? null };
}

/** 202 ORDER_CREATION_PENDING: the identity is recorded, the creation is not confirmed */
export const isPendingOrder = (o: unknown): o is OrderPending => !!o && typeof o === "object" && (o as any).pending === true;
/** 502 ORDER_CREATION_FAILED folded with the body the dialog sent */
export const isFailedCreation = (o: unknown): o is OrderCreationFailure => !!o && typeof o === "object" && (o as any).failed === true;
/** PLANNED / SENT: the creation is neither confirmed nor closed — the order is not usable yet (no approval, quote, purchase or execution) */
export const creationUnconfirmed = (o: Pick<OrderView, "state"> | null | undefined) => !!o && (o.state === "PLANNED" || o.state === "SENT");
/** FAILED / UNKNOWN_CREATION: the creation could not be established; a new order is a new row, this one stays for the record */
export const creationStopped = (o: Pick<OrderView, "state"> | null | undefined) => !!o && (o.state === "FAILED" || o.state === "UNKNOWN_CREATION");
export const UNCONFIRMED_BLOCK_TEXT = "an earlier order creation is still unconfirmed — recover it first";
/** The payment state as every summary says it: "unknown" whenever it is not established — an order whose creation is not confirmed, or a
 *  confirmed one not read yet. Never "unpaid" for an order that may not exist. */
export function paymentLabel(o: Pick<OrderView, "state" | "paid"> | null | undefined): { text: "paid" | "unpaid" | "unknown"; tone: "ok" | "neutral" | "warn" } {
  if (!o || o.state !== "CONFIRMED" || o.paid === null || o.paid === undefined) return { text: "unknown", tone: "warn" };
  return o.paid ? { text: "paid", tone: "ok" } : { text: "unpaid", tone: "neutral" };
}
/** what the order card says about a creation that is not confirmed: sent (a hash was recorded) or only identified */
export function creationStatusText(o: Pick<OrderView, "state" | "tx">): string | null {
  if (creationUnconfirmed(o)) return o.tx ? "Order creation sent — not yet confirmed" : "identity recorded; creation not confirmed";
  if (creationStopped(o)) return "creation not established — create a new order (this row stays for the record)";
  return null;
}
/** The creation response (201, 202 pending, or a 502 failure folded with its body), shaped like a listed order so the card renders one shape
 *  (the GET refreshes it with the live state). Only a confirmed creation reads as unpaid: it was just created and nothing could have paid it. */
export function orderViewFromCreated(o: OrderCreated | OrderPending | OrderCreationFailure): OrderView {
  const at = new Date().toISOString();
  const base = { orderId: o.orderId.toLowerCase(), owner: (o as OrderCreated).owner ?? null, source: "developer" as const, runId: null, payer: o.payer, merchant: o.merchant, proxy: o.proxy, amountNativeAtomic: o.amountNativeAtomic, reference: o.reference ?? null,
    creation: { from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null }, paidCheckedAt: null, checks: [], attempts: [], createdAt: at, updatedAt: at };
  if (isFailedCreation(o)) return { ...base, state: o.state, tx: o.tx, block: null, paid: null, note: o.reason, nextAction: "this creation could not be established; create a new order (this row stays for the record)" };
  if (isPendingOrder(o)) return { ...base, state: o.state, tx: o.tx, block: null, paid: null, note: o.reason ?? null, nextAction: o.nextAction };
  return { ...base, state: o.state, tx: o.tx, block: o.block, paid: false, note: null, nextAction: "run the preflight check for this order" };
}

/** "costs so far" of an order, from facts only: the operator's creation gas (receipt), the check fees that settled, the principal once paid. */
/** `missing`: what to say when `usdc` is null (default: no receipt) */
export type CostLine = { label: string; who: "buyer" | "operator"; usdc: string | null; detail?: string; missing?: string };
export function orderCostsSoFar(o: OrderView, feeTokenAtomic: string | null): CostLine[] {
  const out: CostLine[] = [];
  const gas = o.creation?.gasUsed && o.creation?.effectiveGasPriceNativeAtomic ? BigInt(o.creation.gasUsed) * BigInt(o.creation.effectiveGasPriceNativeAtomic) : null;
  out.push({ label: "order creation gas", who: "operator", usdc: gas === null ? null : nativeAtomicToUsdcText(gas), detail: gas === null ? "receipt not recorded" : `${o.creation.gasUsed} gas` });
  const settled = o.checks.filter((c) => c.paymentState === "COMPLETED").length;
  out.push({ label: `check fee${settled === 1 ? "" : "s"} (${settled} settled)`, who: "buyer", usdc: settled && feeTokenAtomic ? tokenAtomicToUsdcText(BigInt(feeTokenAtomic) * BigInt(settled)) : settled ? null : "0" });
  const pay = paymentLabel(o);
  if (pay.text === "unknown") out.push({ label: "business principal", who: "buyer", usdc: null, detail: o.state !== "CONFIRMED" ? "the order's creation is not confirmed" : "payment state not read yet", missing: "unknown" });
  else out.push({ label: "business principal", who: "buyer", usdc: pay.text === "paid" ? nativeAtomicToUsdcText(o.amountNativeAtomic) : "0", detail: pay.text });
  return out;
}
/** Gate D: an order is a project-paid transaction, gated with execution until the mainnet acceptance is recorded (Developer and Demo say the same) */
export const ORDER_GATED_TEXT = "order creation is gated on this instance until the mainnet acceptance is recorded";
