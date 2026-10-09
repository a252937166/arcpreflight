import { describe, expect, it } from "vitest";
import { ACCOUNT, MERCHANT } from "./fixtures";
import { creationStatusText, creationStopped, creationUnconfirmed, isFailedCreation, isPendingOrder, orderCostsSoFar, orderViewFromCreated, paymentLabel } from "../src/lib/orders";
import { describeBody, describeError, ORDER_RESPONSE_LOST_TEXT } from "../src/lib/errors";
import { ApiError } from "../src/lib/api";

// 2026-10-09 real-wallet session: an order creation the node refused was answered "Nothing was changed", and an unconfirmed order could
// read as complete and "unpaid". These are the pure rules the page builds on.
const ID = `0x${"ab".repeat(32)}`; const TX = `0x${"5e".repeat(32)}`;
const pending: any = { pending: true, orderId: ID, state: "SENT", tx: TX, nextAction: "creation sent, not yet confirmed — waiting for its receipt", reason: "the node did not confirm taking the creation transaction",
  merchant: MERCHANT, proxy: "MAIN", payer: ACCOUNT, amountNativeAtomic: "50000000000000000", reference: null };

describe("order creation that is not confirmed (2026-10-09)", () => {
  it("payment reads 'unknown' whenever it is not established — never 'unpaid' for an order that may not exist", () => {
    for (const state of ["PLANNED", "SENT", "FAILED", "UNKNOWN_CREATION"] as const) for (const paid of [null, false, true]) expect(paymentLabel({ state, paid })).toEqual({ text: "unknown", tone: "warn" });
    expect(paymentLabel({ state: "CONFIRMED", paid: null })).toMatchObject({ text: "unknown" });
    expect(paymentLabel({ state: "CONFIRMED", paid: false })).toEqual({ text: "unpaid", tone: "neutral" });
    expect(paymentLabel({ state: "CONFIRMED", paid: true })).toEqual({ text: "paid", tone: "ok" });
    expect(paymentLabel(null).text).toBe("unknown");
  });
  it("says what an unconfirmed creation is — sent with a hash, or only identified — and that a closed one needs a new order", () => {
    expect(creationStatusText({ state: "SENT", tx: TX })).toBe("Order creation sent — not yet confirmed");
    expect(creationStatusText({ state: "PLANNED", tx: null })).toBe("identity recorded; creation not confirmed");
    expect(creationStatusText({ state: "UNKNOWN_CREATION", tx: null })).toContain("create a new order");
    expect(creationStatusText({ state: "CONFIRMED", tx: TX })).toBeNull();
    expect([creationUnconfirmed({ state: "SENT" }), creationUnconfirmed({ state: "CONFIRMED" }), creationUnconfirmed(null), creationStopped({ state: "FAILED" }), creationStopped({ state: "SENT" })]).toEqual([true, false, false, true, false]);
  });
  it("shapes a 202 and a failure that names the order like listed orders: not confirmed, paid unknown, the server's next action", () => {
    expect(isPendingOrder(pending)).toBe(true); expect(isPendingOrder({ ...pending, pending: undefined })).toBe(false);
    const v = orderViewFromCreated(pending);
    expect(v).toMatchObject({ orderId: ID, state: "SENT", tx: TX, block: null, paid: null, nextAction: pending.nextAction, note: pending.reason });
    const failed: any = { failed: true, orderId: ID, state: "FAILED", tx: TX, reason: "the creation transaction reverted", merchant: MERCHANT, proxy: "MAIN", payer: ACCOUNT, amountNativeAtomic: "50000000000000000", reference: null };
    expect(isFailedCreation(failed)).toBe(true); expect(isFailedCreation(pending)).toBe(false);
    expect(orderViewFromCreated(failed)).toMatchObject({ state: "FAILED", paid: null, note: "the creation transaction reverted", nextAction: expect.stringContaining("create a new order") });
    expect(orderCostsSoFar(v, "10000")[2]).toEqual({ label: "business principal", who: "buyer", usdc: null, detail: "the order's creation is not confirmed", missing: "unknown" });
  });
  it("an answer that names an order never reads 'nothing was changed'; a lost answer says the order may exist", () => {
    const p = describeBody({ error: "ORDER_CREATION_PENDING", ...pending });
    expect(p.text).toContain(`Order ${ID.slice(0, 10)}… is recorded, but its creation is not confirmed yet`); expect(p.text).toContain("never a second order");
    const f = describeBody({ error: "ORDER_CREATION_FAILED", orderId: ID, state: "FAILED", tx: TX, reason: "the creation transaction reverted" });
    expect(f.text).toContain("was recorded but not created: the creation transaction reverted"); expect(f.text).toContain("create a new order");
    const dep = describeBody({ error: "DEPENDENCY_ERROR", reason: "rpc down", orderId: ID });
    for (const t of [p.text, f.text, dep.text]) expect(t).not.toMatch(/nothing was changed/i);
    // before an identity exists the server says no order was created, and "nothing was changed" is still true
    expect(describeBody({ error: "DEPENDENCY_ERROR", reason: "the order was not created (rpc down); no order identity was recorded and nothing was sent" }).text).toContain("Nothing was changed by this request");
    expect(describeError(new ApiError(502, { error: "ORDER_CREATION_FAILED", orderId: ID, reason: "x" })).code).toBe("ORDER_CREATION_FAILED");
    expect(ORDER_RESPONSE_LOST_TEXT).toContain("may have been recorded"); expect(ORDER_RESPONSE_LOST_TEXT).not.toMatch(/nothing was sent/i);
  });
});
