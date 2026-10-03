import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentCore, intentDigest } from "@arcpreflight/schema";
import { api, ApiError } from "../src/lib/api";
import { startDemo } from "../src/lib/demo";
import { approvedBaseline, developerIntent, developerPolicy, prepareOrderQuote, quoteReady } from "../src/lib/preflight";
import { ACCOUNT, NOW, REQUEST, baseline, baselineHash, order, quoteFor, response } from "./fixtures";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const intent = () => developerIntent(5042002, ACCOUNT, order, developerPolicy(ACCOUNT, order), false);

describe("developer report purchase", () => {
  it("re-requests a pre-order pin under a new ID and binds payment to the accepted intent", async () => {
    const sent: { intent: IntentCore; payment?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      if (body.payment) return response({ delivery: "DELIVERED" });
      return response(quoteFor(body.intent, sent.length === 1 ? "99" : "100"), 402);
    }));
    const prepared = await prepareOrderQuote(intent(), order.block, "offline-token", { wait: async () => {} });
    expect(sent).toHaveLength(2);
    expect(sent[1].intent.clientRequestId).not.toBe(sent[0].intent.clientRequestId);
    expect(sent[1].intent.businessExpectation).toEqual(sent[0].intent.businessExpectation);
    expect(quoteReady(prepared, order.block)).toBe(true);
    await api.preflight(prepared.intent, "offline-token", { signature: "offline-fixture" });
    expect(JSON.stringify(sent[2].intent)).toBe(JSON.stringify(sent[1].intent));
    expect(sent.slice(0, 2).every((b) => !b.payment)).toBe(true);
  });
  it("bounds retries and never exposes an old pin as payable", async () => {
    const sent: IntentCore[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path, init) => { const i = JSON.parse(init.body).intent; sent.push(i); return response(quoteFor(i, "99"), 402); }));
    await expect(prepareOrderQuote(intent(), "100", "offline-token", { maxAttempts: 3, wait: async () => {} })).rejects.toThrow("Nothing was paid");
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((i) => i.clientRequestId)).size).toBe(3);
    expect(quoteReady({ intent: sent[0], response: { ...quoteFor(sent[0], "99"), __status: 402 } }, "100")).toBe(false);
  });
  it("normal → wrong units → normal creates independent request revisions", async () => {
    const policy = developerPolicy(ACCOUNT, order);
    const revisions = [false, true, false].map((units) => developerIntent(5042002, ACCOUNT, order, policy, units));
    const bound = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn(async (_path, init) => {
      const i = JSON.parse(init.body).intent; const digest = intentDigest(i);
      if (bound.has(i.clientRequestId) && bound.get(i.clientRequestId) !== digest) return response({ error: "REQUEST_CONFLICT" }, 409);
      bound.set(i.clientRequestId, digest); return response(quoteFor(i), 402);
    }));
    for (const revision of revisions) expect(quoteReady(await prepareOrderQuote(revision, "100", "offline-token"), "100")).toBe(true);
    expect(new Set(revisions.map((i) => i.clientRequestId)).size).toBe(3);
    expect(revisions.map((i) => i.valueNativeAtomic)).toEqual([order.amountNativeAtomic, "50000", order.amountNativeAtomic]);
  });
  it("refuses expired or mismatched quotes and cancels a changed wallet before the next request", async () => {
    const i = intent(); const q = { intent: i, response: { ...quoteFor(i), __status: 402 } };
    expect(quoteReady(q, "100", NOW.getTime() + 30_000)).toBe(false);
    expect(quoteReady({ ...q, intent: { ...i, clientRequestId: "different" } }, "100")).toBe(false);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(prepareOrderQuote(i, "100", "offline-token", { isCurrent: () => false })).rejects.toThrow("Wallet or intent changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("loads content-checked baseline and keeps explicit revocation metadata", async () => {
    const fetch = vi.fn(async () => response({ baselineDigest: baselineHash, baseline, revoked: true })); vi.stubGlobal("fetch", fetch);
    expect(await approvedBaseline(baselineHash, "offline-token")).toEqual({ baselineDigest: baselineHash, baseline, revoked: true });
    expect(fetch.mock.calls[0][0]).toBe(`/v1/baselines/${baselineHash}`);
    fetch.mockImplementation(async () => response({ baselineDigest: baselineHash, baseline: { ...baseline, approvedBy: "tampered" }, revoked: false }));
    await expect(approvedBaseline(baselineHash, "offline-token")).rejects.toThrow("baseline digest");
  });
});

describe("recorded demo fallback", () => {
  it.each([429, 503])("loads the sample carried by HTTP %s", async (status) => {
    const run = { runId: REQUEST, fixture: "APPROVED_PAYMENT", state: "DONE", labels: ["LIVE_REQUEST"], steps: [], result: null };
    const fetch = vi.fn(async (path) => String(path) === "/v1/demo/run" ? response({ error: "DEMO_UNAVAILABLE", reason: "budget/cooldown", sampleRunId: REQUEST }, status) : response(run));
    vi.stubGlobal("fetch", fetch);
    expect(await startDemo("APPROVED_PAYMENT")).toMatchObject({ mode: "sample", run, reason: "DEMO_UNAVAILABLE: budget/cooldown" });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/v1/demo/run", `/v1/demo/runs/${REQUEST}`]);
  });
  it("preserves missing sample and other API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "DEMO_COOLDOWN", reason: "wait" }, 429)));
    await expect(startDemo("APPROVED_PAYMENT")).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "FORBIDDEN", sampleRunId: REQUEST }, 403)));
    await expect(startDemo("APPROVED_PAYMENT")).rejects.toBeInstanceOf(ApiError);
  });
  it("returns the live run ID without loading a sample", async () => {
    const fetch = vi.fn(async () => response({ runId: REQUEST }, 202)); vi.stubGlobal("fetch", fetch);
    expect(await startDemo("APPROVED_PAYMENT")).toEqual({ mode: "live", runId: REQUEST });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
