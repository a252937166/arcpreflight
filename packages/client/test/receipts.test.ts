import { describe, expect, it, vi } from "vitest";
import { isReceiptNotFound, waitForReceiptPatiently } from "../src/receipts.js";

// The delayed chain-RPC scenario (2026-10-09): a node that serves the transaction but not yet its receipt made viem's wait give up in ~1 s.
const H = `0x${"ab".repeat(32)}` as const;
const notFound = () => Object.assign(new Error(`Transaction receipt with hash "${H}" could not be found. The Transaction may not be processed on a block yet.`), { name: "TransactionReceiptNotFoundError" });
describe("waitForReceiptPatiently", () => {
  it("retries 'receipt not found' until the receipt appears, passing the full timeout first and the time left afterwards", async () => {
    let t = 0; const calls: number[] = [];
    const client = { waitForTransactionReceipt: vi.fn(async ({ timeout }: { timeout?: number }) => { calls.push(timeout!); if (calls.length < 3) throw notFound(); return { status: "success" }; }) };
    const r = await waitForReceiptPatiently(client, H, 60_000, 1500, () => t, async (ms) => { t += ms; });
    expect(r).toEqual({ status: "success" }); expect(calls).toEqual([60_000, 58_500, 57_000]);
  });
  it("throws every other error at once (a real timeout included), and gives up on 'not found' at its own deadline", async () => {
    const timeout = { waitForTransactionReceipt: vi.fn(async () => { throw new Error("Timed out while waiting for transaction"); }) };
    await expect(waitForReceiptPatiently(timeout, H, 60_000)).rejects.toThrow(/Timed out/); expect(timeout.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    let t = 0; const never = { waitForTransactionReceipt: vi.fn(async () => { throw notFound(); }) };
    await expect(waitForReceiptPatiently(never, H, 5_000, 1500, () => t, async (ms) => { t += ms; })).rejects.toThrow(/could not be found/);
    expect(never.waitForTransactionReceipt.mock.calls.length).toBe(4); // 0, 1.5, 3.0, 4.5 s — the next pause would pass the deadline
    expect(isReceiptNotFound(notFound())).toBe(true); expect(isReceiptNotFound(new Error("socket hang up"))).toBe(false);
  });
});
