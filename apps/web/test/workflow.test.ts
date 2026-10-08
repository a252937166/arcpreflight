import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBase } from "../src/lib/api";
import { clearWorkflow, loadWorkflow, loadWorkflows, patchWorkflow, saveWorkflow } from "../src/lib/workflow";
import { ACCOUNT } from "./fixtures";

// The workflow identity is per payer (docs/LIFECYCLE.md §9): a different connected account never inherits another account's order, check or attempt.
const OTHER = "0x0000000000000000000000000000000000000B11";
const ORDER_A = `0x${"aa".repeat(32)}`, ORDER_B = `0x${"bb".repeat(32)}`;
let storage: Map<string, string>;
beforeEach(() => { storage = new Map(); vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } }); setApiBase(""); });
afterEach(() => { vi.unstubAllGlobals(); setApiBase(""); });
const base = { proxy: "MAIN" as const, baselineDigest: null, approved: true, requestId: null, intent: null, attemptId: null, handoff: null };

describe("per-payer workflow identity", () => {
  it("saves one entry per payer (case-insensitive) and reads back only the asked payer's", () => {
    saveWorkflow({ ...base, payer: ACCOUNT, orderId: ORDER_A });
    saveWorkflow({ ...base, payer: OTHER, orderId: ORDER_B, approved: false });
    expect(loadWorkflow(ACCOUNT)).toMatchObject({ payer: ACCOUNT, orderId: ORDER_A, approved: true });
    expect(loadWorkflow(OTHER.toLowerCase())).toMatchObject({ payer: OTHER, orderId: ORDER_B, approved: false });
    expect(loadWorkflow("0x0000000000000000000000000000000000000c11")).toBeNull(); expect(loadWorkflow(null)).toBeNull();
    expect(loadWorkflows().map((w) => w.orderId).sort()).toEqual([ORDER_A, ORDER_B].sort());
    patchWorkflow(ACCOUNT, { attemptId: "att-1" });
    expect(loadWorkflow(ACCOUNT)!.attemptId).toBe("att-1"); expect(loadWorkflow(OTHER)!.attemptId).toBeNull(); // the other payer's entry is untouched
    clearWorkflow(ACCOUNT);
    expect(loadWorkflow(ACCOUNT)).toBeNull(); expect(loadWorkflow(OTHER)).toMatchObject({ orderId: ORDER_B });
    clearWorkflow(OTHER); expect(storage.has("arcpreflight.workflow:root")).toBe(false);
  });
  it("reads a pre-round-2 single-object entry as that payer's and never as another account's", () => {
    storage.set("arcpreflight.workflow:root", JSON.stringify({ ...base, payer: ACCOUNT, orderId: ORDER_A, updatedAt: "2026-10-08T00:00:00Z" }));
    expect(loadWorkflow(ACCOUNT)).toMatchObject({ orderId: ORDER_A }); expect(loadWorkflow(OTHER)).toBeNull();
    saveWorkflow({ ...base, payer: OTHER, orderId: ORDER_B }); // migrates to the keyed shape, keeping the legacy entry
    expect(loadWorkflow(ACCOUNT)).toMatchObject({ orderId: ORDER_A }); expect(loadWorkflow(OTHER)).toMatchObject({ orderId: ORDER_B });
    expect(Object.keys(JSON.parse(storage.get("arcpreflight.workflow:root")!))).toEqual([ACCOUNT.toLowerCase(), OTHER.toLowerCase()]);
  });
  it("stays per API instance and survives unusable storage", () => {
    saveWorkflow({ ...base, payer: ACCOUNT, orderId: ORDER_A });
    setApiBase("/testnet"); expect(loadWorkflow(ACCOUNT)).toBeNull(); setApiBase("");
    storage.set("arcpreflight.workflow:root", "not json"); expect(loadWorkflow(ACCOUNT)).toBeNull(); expect(loadWorkflows()).toEqual([]);
    storage.set("arcpreflight.workflow:root", JSON.stringify({ [OTHER.toLowerCase()]: { ...base, payer: ACCOUNT, orderId: ORDER_A, updatedAt: "x" } })); // a mislabelled entry is ignored
    expect(loadWorkflow(OTHER)).toBeNull(); expect(loadWorkflow(ACCOUNT)).toBeNull();
  });
});
