import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, nativeAtomicToUsdcText, orderCostsSoFar, orderLimits, orderViewFromCreated, sampleOrder, serverFieldError, tokenAtomicToUsdcText, toDeveloperOrder, usdcToNativeAtomic, validateOrderForm, baselineDigestFor, fixtureForProxy } from "../src/lib/orders";
import { ACCOUNT, D, MERCHANT } from "./fixtures";

// The order dialog mirrors the server's rules (docs/LIFECYCLE.md §2, AP33-11): USDC text → 18-decimal native units, limits, reference.
describe("order form: conversion", () => {
  it("converts USDC text to 18-decimal native units exactly, never through floats", () => {
    expect(usdcToNativeAtomic("0.05")).toEqual({ ok: true, atomic: 50_000_000_000_000_000n });
    expect(usdcToNativeAtomic("0.005")).toEqual({ ok: true, atomic: 5_000_000_000_000_000n });
    expect(usdcToNativeAtomic("1")).toEqual({ ok: true, atomic: 10n ** 18n });
    expect(usdcToNativeAtomic(".000001")).toEqual({ ok: true, atomic: 10n ** 12n }); // one 6-decimal unit = 1e12 native units
    expect(usdcToNativeAtomic("0,05")).toEqual({ ok: true, atomic: 50_000_000_000_000_000n }); // a comma decimal separator is accepted
    expect(usdcToNativeAtomic("0.1234567")).toMatchObject({ ok: false }); // 7 decimals cannot be a whole token unit
    expect(usdcToNativeAtomic("")).toMatchObject({ ok: false }); expect(usdcToNativeAtomic("abc")).toMatchObject({ ok: false }); expect(usdcToNativeAtomic("1e3")).toMatchObject({ ok: false }); expect(usdcToNativeAtomic(".")).toMatchObject({ ok: false });
  });
  it("renders atomic values back as exact decimal text", () => {
    expect(nativeAtomicToUsdcText("50000000000000000")).toBe("0.05"); expect(nativeAtomicToUsdcText(10n ** 18n)).toBe("1"); expect(nativeAtomicToUsdcText("2178625000000000")).toBe("0.002178625"); expect(nativeAtomicToUsdcText("0")).toBe("0");
    expect(tokenAtomicToUsdcText("10000")).toBe("0.01"); expect(tokenAtomicToUsdcText("20000")).toBe("0.02");
    expect(nativeAtomicToUsdcText(usdcToNativeAtomic("0.123456").ok ? (usdcToNativeAtomic("0.123456") as any).atomic : 0n)).toBe("0.123456"); // round trip
  });
});

describe("order form: validation", () => {
  const form = { proxy: "MAIN" as const, amountUsdc: "0.05", reference: "invoice #42" };
  it("accepts a valid form and produces the exact server body (reference trimmed, omitted when empty)", () => {
    expect(validateOrderForm(form, ACCOUNT)).toEqual({ errors: {}, body: { payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: "50000000000000000", reference: "invoice #42" } });
    expect(validateOrderForm({ ...form, reference: "   " }, ACCOUNT).body).toEqual({ payer: ACCOUNT, proxy: "MAIN", amountNativeAtomic: "50000000000000000" });
    expect(validateOrderForm({ ...form, proxy: "CHANGED", reference: "  x  " }, ACCOUNT).body).toMatchObject({ proxy: "CHANGED", reference: "x" });
  });
  it("labels every refusal on its field, with the server's limits", () => {
    expect(validateOrderForm(form, null).errors.payer).toMatch(/connect a wallet/);
    expect(validateOrderForm(form, "0x123").errors.payer).toBeDefined();
    expect(validateOrderForm({ ...form, amountUsdc: "0.0001" }, ACCOUNT).errors.amount).toBe("between 0.001 and 1 USDC");
    expect(validateOrderForm({ ...form, amountUsdc: "1.5" }, ACCOUNT).errors.amount).toBe("between 0.001 and 1 USDC");
    expect(validateOrderForm({ ...form, amountUsdc: "0.0000001" }, ACCOUNT).errors.amount).toMatch(/at most 6 decimals/);
    expect(validateOrderForm({ ...form, amountUsdc: "" }, ACCOUNT).errors.amount).toMatch(/enter an amount/);
    expect(validateOrderForm({ ...form, reference: "x".repeat(65) }, ACCOUNT).errors.reference).toBe("at most 64 characters (65 typed)");
    expect(validateOrderForm({ ...form, reference: "bad\u0007ref" }, ACCOUNT).errors.reference).toBe("no control characters");
    expect(validateOrderForm({ ...form, proxy: "OTHER" as any }, ACCOUNT).errors.proxy).toBeDefined();
    expect(validateOrderForm({ ...form, amountUsdc: "9" }, ACCOUNT).body).toBeNull();
    // tighter limits from /v1/network are honoured
    const tight = { ...DEFAULT_LIMITS, maxNativeAtomic: 10n ** 17n, maxReferenceLength: 8 };
    expect(validateOrderForm({ ...form, amountUsdc: "0.5" }, ACCOUNT, tight).errors.amount).toBe("between 0.001 and 0.1 USDC");
    expect(validateOrderForm(form, ACCOUNT, tight).errors.reference).toBe("at most 8 characters (11 typed)");
  });
  it("reads the limits from /v1/network and falls back to the server defaults", () => {
    expect(orderLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(orderLimits({ orders: { minNativeAtomic: "1000", maxNativeAtomic: "2000", stepNativeAtomic: "10", defaultNativeAtomic: "1500", maxReferenceLength: 12 } } as any)).toEqual({ minNativeAtomic: 1000n, maxNativeAtomic: 2000n, stepNativeAtomic: 10n, defaultNativeAtomic: 1500n, maxReferenceLength: 12 });
    expect(orderLimits({ orders: { minNativeAtomic: "nope" } } as any)).toEqual(DEFAULT_LIMITS);
  });
  it("autofills a valid, editable sample (default amount, dated reference) that passes its own validation", () => {
    const s = sampleOrder(new Date("2026-10-08T12:00:00Z"));
    expect(s).toEqual({ proxy: "MAIN", amountUsdc: "0.05", reference: "sample order 2026-10-08" });
    expect(validateOrderForm(s, ACCOUNT).body).toMatchObject({ amountNativeAtomic: "50000000000000000", reference: "sample order 2026-10-08" });
    expect(validateOrderForm({ ...s, amountUsdc: "0.005" }, ACCOUNT).body).toMatchObject({ amountNativeAtomic: "5000000000000000" }); // edited after autofill
  });
  it("folds a 400 INVALID_INPUT { field, reason } onto the field it names", () => {
    expect(serverFieldError({ error: "INVALID_INPUT", field: "amountNativeAtomic", reason: "amount must be a whole number of 6-decimal USDC units" })).toEqual({ amount: "amount must be a whole number of 6-decimal USDC units" });
    expect(serverFieldError({ error: "INVALID_INPUT", field: "reference", reason: "too long" })).toEqual({ reference: "too long" });
    expect(serverFieldError({ error: "INVALID_INPUT", field: "payer", reason: "payer must be a 20-byte address" })).toEqual({ payer: "payer must be a 20-byte address" });
    expect(serverFieldError({ error: "INVALID_INPUT" })).toEqual({ amount: "the server rejected this order" });
  });
});

describe("order views", () => {
  const net: any = { fixtures: [{ id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MERCHANT, baselineDigest: D }, { id: "CHANGED_IMPLEMENTATION", proxy: "CHANGED", merchant: MERCHANT, baselineDigest: `0x${"22".repeat(32)}` }, { id: "GHOST", proxy: "MAIN", merchant: null, baselineDigest: null }] };
  const created: any = { orderId: "0xABC", tx: D, block: "100", merchant: MERCHANT, proxy: "MAIN", payer: ACCOUNT, amountNativeAtomic: "5000000000000000", reference: "r", baselineDigest: D, state: "CONFIRMED", owner: "visitor:1" };
  it("finds the fixture of a proxy (deployed ones only) and its approval digest", () => {
    expect(fixtureForProxy(net, "MAIN")?.id).toBe("APPROVED_PAYMENT"); expect(fixtureForProxy(net, "CHANGED")?.id).toBe("CHANGED_IMPLEMENTATION");
    expect(baselineDigestFor(net, "CHANGED")).toBe(`0x${"22".repeat(32)}`); expect(baselineDigestFor(null, "MAIN")).toBeNull(); expect(baselineDigestFor({ fixtures: [] } as any, "MAIN")).toBeNull();
  });
  it("shapes the creation response like a listed order and keeps the baseline digest for the preflight helpers", () => {
    const v = orderViewFromCreated(created);
    expect(v).toMatchObject({ orderId: "0xabc", source: "developer", state: "CONFIRMED", paid: false, tx: D, block: "100", checks: [], attempts: [] });
    expect(toDeveloperOrder(v, D)).toMatchObject({ orderId: "0xabc", tx: D, block: "100", merchant: MERCHANT, amountNativeAtomic: "5000000000000000", baselineDigest: D, proxy: "MAIN", reference: "r" });
    expect(toDeveloperOrder(created, null).baselineDigest).toBe(D); // the creation response carries it
    expect(toDeveloperOrder({ ...v, tx: null, block: null }, null)).toMatchObject({ tx: "0x", block: "0", baselineDigest: null });
  });
  it("lists costs so far from facts only — the operator's creation gas, settled fees, the principal once paid", () => {
    const v = { ...orderViewFromCreated(created), creation: { from: ACCOUNT, gasUsed: "100292", effectiveGasPriceNativeAtomic: "25000000000" }, checks: [{ paymentState: "COMPLETED" }, { paymentState: "FAILED" }] as any, paid: true };
    const rows = orderCostsSoFar(v, "10000");
    expect(rows).toEqual([
      { label: "order creation gas", who: "operator", usdc: "0.0025073", detail: "100292 gas" },
      { label: "check fee (1 settled)", who: "buyer", usdc: "0.01" },
      { label: "business principal", who: "buyer", usdc: "0.005", detail: "paid" },
    ]);
    const bare = orderCostsSoFar(orderViewFromCreated(created), "10000");
    expect(bare[0]).toMatchObject({ usdc: null, detail: "receipt not recorded" }); // never 0 for a missing receipt
    expect(bare[1]).toMatchObject({ usdc: "0" }); expect(bare[2]).toMatchObject({ usdc: "0", detail: "unpaid" });
  });
});
