import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { openDb, type Db } from "../src/db.js";
import { parseOrderInput, planOrder, orderSent, orderConfirmed, reconcileOrders, refreshPaid, shapeOrder, getOrderRow, listOrderRows, runnerOrderStore, ORDER_LIMITS, type OrderRpc } from "../src/orders.js";

// Order identity before the send (design v3.3 §2, AP33-05): the table and its reconciliation with a fake chain. No key material, no network.
const PAYER = "0x3333333333333333333333333333333333333333"; const MERCHANT = "0x2222222222222222222222222222222222222222";
const ID = ("0x" + "ab".repeat(32)) as `0x${string}`; const TX = ("0x" + "bc".repeat(32)) as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";
let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => db.close());
const rpc = (o: { receipt?: any; exists?: boolean; paid?: boolean; receiptError?: boolean } = {}): OrderRpc => ({
  getTransactionReceipt: async () => { if (o.receiptError) throw new Error("rpc down"); if (!o.receipt) throw new Error("not found"); return o.receipt; },
  readContract: async () => (o.exists ? [PAYER, 50_000_000_000_000_000n, !!o.paid, 1n, 0n] : [ZERO, 0n, false, 0n, 0n]),
});
const plan = (extra: Partial<Parameters<typeof planOrder>[1]> = {}) => planOrder(db, { orderId: ID, owner: "visitor:a", clientKey: "c", source: "developer", payer: PAYER, merchant: MERCHANT, proxy: "MAIN", amountNativeAtomic: "50000000000000000", reference: "ref", ...extra });

describe("order input validation (AP33-11 server side)", () => {
  const parse = (body: any) => parseOrderInput(body, isAddress, getAddress);
  it("fills the default amount, keeps the reference, and labels every refusal with its field", () => {
    expect(parse({ payer: PAYER })).toMatchObject({ ok: true, value: { payer: getAddress(PAYER), proxy: "MAIN", amountNativeAtomic: ORDER_LIMITS.defaultNativeAtomic, reference: null } });
    expect(parse({ payer: PAYER, proxy: "CHANGED", amountNativeAtomic: "7000000000000000", reference: "  invoice #42 " })).toMatchObject({ ok: true, value: { proxy: "CHANGED", amountNativeAtomic: 7_000_000_000_000_000n, reference: "invoice #42" } });
    expect(parse({ payer: "0x12" })).toMatchObject({ ok: false, field: "payer" });
    expect(parse({ payer: PAYER, proxy: "OTHER" })).toMatchObject({ ok: false, field: "proxy" });
    expect(parse({ payer: PAYER, amountNativeAtomic: 5 })).toMatchObject({ ok: false, field: "amountNativeAtomic" });
    expect(parse({ payer: PAYER, amountNativeAtomic: "1" })).toMatchObject({ ok: false, field: "amountNativeAtomic", reason: expect.stringContaining("between") });
    expect(parse({ payer: PAYER, amountNativeAtomic: "2000000000000000000" })).toMatchObject({ ok: false, field: "amountNativeAtomic" });
    expect(parse({ payer: PAYER, amountNativeAtomic: "50000000000000001" })).toMatchObject({ ok: false, field: "amountNativeAtomic", reason: expect.stringContaining("6-decimal") });
    expect(parse({ payer: PAYER, reference: "x".repeat(65) })).toMatchObject({ ok: false, field: "reference" });
    expect(parse({ payer: PAYER, reference: "bad\u0007" })).toMatchObject({ ok: false, field: "reference" });
    expect(parse({ payer: PAYER, reference: 42 })).toMatchObject({ ok: false, field: "reference" });
  });
});

describe("order rows: PLANNED → SENT → CONFIRMED, and reconciliation from the chain", () => {
  it("records identity before any hash exists and only moves forward", () => {
    plan();
    expect(getOrderRow(db, ID)).toMatchObject({ state: "PLANNED", tx_hash: null, owner: "visitor:a", reference: "ref", amount_atomic: "50000000000000000" });
    orderSent(db, ID, TX); expect(getOrderRow(db, ID)).toMatchObject({ state: "SENT", tx_hash: TX });
    orderConfirmed(db, { orderId: ID, tx: TX, block: "100", from: PAYER as `0x${string}`, gasUsed: "90000", effectiveGasPriceNativeAtomic: "21000000000" });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "CONFIRMED", block: "100", gas_used: "90000" });
    orderSent(db, ID, ("0x" + "ff".repeat(32)) as `0x${string}`); // a late or repeated transition never rewrites a confirmed row
    expect(getOrderRow(db, ID)).toMatchObject({ state: "CONFIRMED", tx_hash: TX });
    expect(listOrderRows(db, "visitor:a")).toHaveLength(1); expect(listOrderRows(db, "visitor:b")).toHaveLength(0);
  });
  it("SENT with a visible receipt: CONFIRMED on success with the receipt facts, FAILED on revert", async () => {
    plan(); orderSent(db, ID, TX);
    expect(await reconcileOrders(db, rpc({ receipt: { status: "success", blockNumber: 120n, from: PAYER, gasUsed: 91_000n, effectiveGasPrice: 20_000_000_000n } }))).toEqual({ resolved: 1, pending: 0 });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "CONFIRMED", block: "120", gas_used: "91000", effective_gas_price: "20000000000", note: expect.stringContaining("reconciliation") });
    plan({ orderId: ("0x" + "cd".repeat(32)) as `0x${string}` }); orderSent(db, ("0x" + "cd".repeat(32)) as `0x${string}`, ("0x" + "de".repeat(32)) as `0x${string}`);
    await reconcileOrders(db, rpc({ receipt: { status: "reverted", blockNumber: 121n } }));
    expect(getOrderRow(db, "0x" + "cd".repeat(32))).toMatchObject({ state: "FAILED", note: expect.stringContaining("reverted") });
  });
  it("no receipt but the order exists on chain (the process stopped between send and hash record): CONFIRMED from chain state, never replaced", async () => {
    plan();
    expect(await reconcileOrders(db, rpc({ exists: true }))).toEqual({ resolved: 1, pending: 0 });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "CONFIRMED", tx_hash: null, block: null, note: expect.stringContaining("exists on chain") });
    expect(listOrderRows(db, "visitor:a")).toHaveLength(1);
  });
  it("neither receipt nor chain order: pending inside the window, UNKNOWN_CREATION after it", async () => {
    plan();
    expect(await reconcileOrders(db, rpc({}), { now: new Date(Date.now() + 60_000) })).toEqual({ resolved: 0, pending: 1 });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "PLANNED" });
    expect(await reconcileOrders(db, rpc({}), { now: new Date(Date.now() + 11 * 60_000) })).toEqual({ resolved: 1, pending: 0 });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "UNKNOWN_CREATION", note: expect.stringContaining("not on chain after the window") });
  });
  it("an RPC failure concludes nothing", async () => {
    plan(); orderSent(db, ID, TX);
    const failing: OrderRpc = { getTransactionReceipt: async () => { throw new Error("rpc down"); }, readContract: async () => { throw new Error("rpc down"); } };
    expect(await reconcileOrders(db, failing, { now: new Date(Date.now() + 11 * 60_000) })).toEqual({ resolved: 0, pending: 1 });
    expect(getOrderRow(db, ID)).toMatchObject({ state: "SENT" });
  });
  it("the runner's store carries the run id and proxy; the paid flag is refreshed by reads only", async () => {
    const store = runnerOrderStore(db, "run-1", "client-x", "CHANGED");
    await store.planned({ orderId: ID, payer: PAYER as `0x${string}`, amountNativeAtomic: "50000000000000000", merchant: MERCHANT as `0x${string}` });
    await store.sent({ orderId: ID, tx: TX }); await store.confirmed({ orderId: ID, tx: TX, block: "100", from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null });
    const o = getOrderRow(db, ID)!;
    expect(o).toMatchObject({ source: "runner", run_id: "run-1", proxy: "CHANGED", state: "CONFIRMED", paid: null });
    await refreshPaid(db, rpc({ exists: true, paid: true }), [o]);
    expect(getOrderRow(db, ID)).toMatchObject({ paid: 1 });
  });
  it("shapes the owner's view with linked checks, attempts and the next action", () => {
    plan(); orderSent(db, ID, TX); orderConfirmed(db, { orderId: ID, tx: TX, block: "100" });
    expect(shapeOrder(db, getOrderRow(db, ID)!, "visitor:a")).toMatchObject({ orderId: ID, state: "CONFIRMED", paid: null, checks: [], attempts: [], nextAction: expect.stringContaining("run the preflight check") });
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO requests (request_id, principal, client_request_id, intent_json, intent_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("11111111-1111-4111-8111-111111111111", "visitor:a", "c1", JSON.stringify({ valueNativeAtomic: "50000000000000000", businessExpectation: { orderId: ID } }), "0x" + "11".repeat(32), "DELIVERED", ts, ts);
    db.prepare("INSERT INTO quotes (request_id, quote_json, quote_digest, report_digest, expires_at, created_at) VALUES (?,?,?,?,?,?)").run("11111111-1111-4111-8111-111111111111", "{}", "0x" + "22".repeat(32), "0x" + "33".repeat(32), ts, ts);
    db.prepare("INSERT INTO payments (request_id, payment_identifier, network, asset, payer, auth_nonce, state, created_at, updated_at, tx_hash) VALUES (?,?,?,?,?,?,?,?,?,?)").run("11111111-1111-4111-8111-111111111111", "p1", "eip155:5042002", "usdc", PAYER, "0x" + "44".repeat(32), "COMPLETED", ts, ts, "0x" + "55".repeat(32));
    const shaped = shapeOrder(db, getOrderRow(db, ID)!, "visitor:a");
    expect(shaped.checks).toHaveLength(1); expect(shaped.checks[0]).toMatchObject({ paymentState: "COMPLETED", reportDigest: "0x" + "33".repeat(32) });
    expect(shaped.nextAction).toContain("execute with your wallet");
    expect(shapeOrder(db, getOrderRow(db, ID)!, "visitor:b").checks).toHaveLength(0); // another owner's checks are never listed
  });
});
