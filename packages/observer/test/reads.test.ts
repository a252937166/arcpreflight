import { describe, expect, it } from "vitest";
import { isUnavailable, readCall } from "../src/reads.js";

// audit 2026-10-10 (VF-04): a transport or node failure is missing evidence, never a revert
const snapshot: any = { chainId: 5042002, blockNumber: "100", blockHash: "0x" + "11".repeat(32), observedAt: "2026-10-10T00:00:00.000Z", providerId: "rpc.testnet", pinningMode: "BLOCK_HASH" };
const client = (call: () => Promise<any>): any => ({ call });
const err = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${name} happened`), { name, ...extra });

describe("readCall classification", () => {
  it("an HTTP 503, a timeout or a node error is `unavailable` with no revert data; an EVM revert is not", async () => {
    const http = await readCall(client(async () => { throw Object.assign(err("CallExecutionError"), { cause: err("HttpRequestError", { status: 503, shortMessage: "HTTP request failed. Status: 503 Service Unavailable" }) }); }), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(http.value).toMatchObject({ ok: false, unavailable: true, revertData: null }); expect(http.evidence.error).toMatch(/^unavailable: /);
    const timeout = await readCall(client(async () => { throw err("TimeoutError", { shortMessage: "The request took too long to respond." }); }), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(timeout.value).toMatchObject({ ok: false, unavailable: true });
    const plain = await readCall(client(async () => { throw new Error("fetch failed"); }), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(plain.value.unavailable).toBe(true);
    const revert = await readCall(client(async () => { throw Object.assign(err("CallExecutionError"), { cause: err("ExecutionRevertedError", { data: "0x1234abcd", shortMessage: "execution reverted" }) }); }), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(revert.value).toMatchObject({ ok: false, unavailable: false, revertData: "0x1234abcd" }); expect(revert.evidence.error).not.toMatch(/^unavailable/);
    const revertNoData = await readCall(client(async () => { throw Object.assign(err("ContractFunctionExecutionError"), { shortMessage: "execution reverted: OrderAlreadyPaid", cause: err("ContractFunctionRevertedError") }); }), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(revertNoData.value).toMatchObject({ ok: false, unavailable: false });
    const ok = await readCall(client(async () => ({ data: "0x" })), "0x0000000000000000000000000000000000000a11", "0x8609cad1", snapshot);
    expect(ok.value).toMatchObject({ ok: true, unavailable: false });
    expect(isUnavailable(err("HttpRequestError", { status: 429 }))).toBe(true); expect(isUnavailable(new Error("execution reverted"))).toBe(false);
  });
});
