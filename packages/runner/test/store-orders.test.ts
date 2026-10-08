import { describe, expect, it } from "vitest";
import { SqliteExecutionStore, makeSealer, openStoreDb, reconcilePlannedOrder } from "../src/index.js";

// Reference-CLI parity (review round 2 §4): the same order identity before the send and the same chain reconciliation as the API.
const ID = ("0x" + "ab".repeat(32)) as `0x${string}`; const TX = ("0x" + "bc".repeat(32)) as `0x${string}`;
const PAYER = "0x3333333333333333333333333333333333333333" as const; const MERCHANT = "0x2222222222222222222222222222222222222222" as const;
describe("CLI store: orders PLANNED → SENT → CONFIRMED and reconciliation from the chain", () => {
  it("records the identity before any hash exists, then the hash, then the receipt facts", async () => {
    const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    const os = store.orderStore();
    await os.planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    expect(store.listOpenOrders()).toEqual([{ orderId: ID, merchant: MERCHANT, txHash: null, createdAt: expect.any(String) }]);
    await os.sent({ orderId: ID, tx: TX }); expect(store.listOpenOrders()[0].txHash).toBe(TX);
    await os.confirmed({ orderId: ID, tx: TX, block: "100", from: PAYER, gasUsed: "90000", effectiveGasPriceNativeAtomic: "21000000000" });
    expect(store.listOpenOrders()).toHaveLength(0); expect(store.listOrders()[0]).toMatchObject({ state: "CONFIRMED", block: "100", gas_used: "90000" });
  });
  it("an order left SENT by an interrupted process is confirmed from its receipt, or from the chain's order state, or closed UNKNOWN_CREATION after the window", async () => {
    const store = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    const os = store.orderStore();
    await os.planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT }); await os.sent({ orderId: ID, tx: TX });
    const withReceipt = { getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, from: PAYER, gasUsed: 1n, effectiveGasPrice: 2n }), readContract: async () => ["0x0000000000000000000000000000000000000000", 0n, false, 0n, 0n] };
    const r = await reconcilePlannedOrder(withReceipt as any, store.listOpenOrders()[0]);
    expect(r).toMatchObject({ kind: "confirmed", tx: TX, block: "5", gasUsed: "1" });
    store.applyOrderReconciliation(ID, r); expect(store.listOrders()[0]).toMatchObject({ state: "CONFIRMED", block: "5" });
    const store2 = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    await store2.orderStore().planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    const noReceiptButOnChain = { getTransactionReceipt: async () => { throw new Error("not found"); }, readContract: async () => [PAYER, 1n, false, 1n, 0n] };
    const r2 = await reconcilePlannedOrder(noReceiptButOnChain as any, store2.listOpenOrders()[0]);
    expect(r2).toMatchObject({ kind: "confirmed", tx: null, note: expect.stringContaining("exists on chain although no creation hash was recorded") });
    const store3 = new SqliteExecutionStore(openStoreDb(":memory:"), makeSealer(Buffer.alloc(32, 7)), "test");
    await store3.orderStore().planned({ orderId: ID, payer: PAYER, amountNativeAtomic: "1", merchant: MERCHANT });
    const nothing = { getTransactionReceipt: async () => { throw new Error("not found"); }, readContract: async () => ["0x0000000000000000000000000000000000000000", 0n, false, 0n, 0n] };
    expect((await reconcilePlannedOrder(nothing as any, store3.listOpenOrders()[0])).kind).toBe("pending");
    const r3 = await reconcilePlannedOrder(nothing as any, store3.listOpenOrders()[0], { now: new Date(Date.now() + 11 * 60_000) });
    expect(r3.kind).toBe("unknown"); store3.applyOrderReconciliation(ID, r3); expect(store3.listOrders()[0].state).toBe("UNKNOWN_CREATION");
  });
});
