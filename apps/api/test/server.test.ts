import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Hex } from "viem";
import { BaselineCore, baselineDigest, IntentCore, reportDigest, ReportCore } from "@arcpreflight/schema";
import { openapi } from "../src/openapi.js";
import { check } from "./helpers/schema.js";
const DOC: any = openapi({ releaseSha: "test", profile: "SUBMISSION_RESTRICTED", caip2: "eip155:5042002" }); // real route answers below are checked against the published schema
const mocks = vi.hoisted(() => ({ relay: vi.fn(), paused: vi.fn(), build: vi.fn(), order: vi.fn(), listOrders: vi.fn(), getOrder: vi.fn(), startRun: vi.fn(), attempt: vi.fn(), sent: vi.fn(), abandon: vi.fn(), observe: vi.fn(), recover: vi.fn(), listAttempts: vi.fn(), walletPassport: vi.fn(), recoverOrder: vi.fn() }));
vi.mock("../src/config.js", () => ({ cfg: {
  dbPath: ":memory:", root: "/tmp/arcpreflight-offline-test", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", publicBaseUrl: "http://offline.invalid", port: 4040, profile: "SUBMISSION_RESTRICTED", releaseSha: "test",
  principals: new Map([["buyer-token", "buyer"], ["other-token", "other"]]), adminToken: "admin-test", supportedTargets: ["0x2222222222222222222222222222222222222222"], maxPreflightPerPrincipalPerDay: 200, priceTokenAtomic: "10000", quoteTtlSeconds: 30, retentionDays: 30, relay: { floorNativeAtomic: 50000000000000000n, maxFeeNativeAtomic: 5000000000000000n, receiptTimeoutMs: 0, scanChunkBlocks: 9000, scanChunksPerCall: 3 },
  publicExecution: true,
  merchant: { address: "0x2222222222222222222222222222222222222222", signMessage: async () => "0x" + "ab".repeat(65) },
} }));
vi.mock("../src/relay.js", () => ({ Relayer: class { settle = mocks.relay; paused = mocks.paused; }, relayRpcFromClient: () => ({}) }));
vi.mock("../src/report.js", () => ({ client: {}, buildObjectReport: vi.fn(), buildIntentReport: mocks.build }));
vi.mock("../src/demo.js", () => ({ claimFaucet: vi.fn(async () => ({ ok: false, status: 404, error: "FAUCET_DISABLED", reason: "the faucet exists on Arc testnet only" })), faucetInfo: vi.fn(() => ({ enabled: false, note: "testnet only" })), FIXTURES: { APPROVED_PAYMENT: {} }, networkInfo: vi.fn(), startRun: mocks.startRun, getRun: vi.fn(), listRuns: vi.fn(), createOrderFor: mocks.order, listOrders: mocks.listOrders, getOrder: mocks.getOrder, recoverOrder: mocks.recoverOrder, reconcileOrderCreations: vi.fn(), chainClient: {}, evidenceIndex: vi.fn(), evidenceFile: vi.fn(), clientKey: vi.fn(() => "client-key"), reconcileExecutions: vi.fn(), observeExecutions: vi.fn(), recoverRun: vi.fn() }));
vi.mock("../src/wallet.js", () => ({ createWalletAttempt: mocks.attempt, markSent: mocks.sent, abandonAttempt: mocks.abandon, observeAttempt: mocks.observe, recoverAttempt: mocks.recover, listAttempts: mocks.listAttempts, buildWalletPassport: mocks.walletPassport, reconcileWalletAttempts: vi.fn(), walletRpcFromClient: () => ({}) }));
import { db, handle } from "../src/server.js";
import { buildObjectReport } from "../src/report.js";
const D = "0x" + "11".repeat(32) as Hex;
const T = "0x" + "22".repeat(32) as Hex;
const merchant = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const makeIntent = (baseline = D) => IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "test-request", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: payer, operation: "CALL", to: merchant, data: "0x12345678", valueNativeAtomic: "50000000000000000", businessExpectation: { sourceId: "order-local", sourceDigest: D, action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: "50000000000000000", orderId: D }, baselineDigest: baseline, policyDigest: D, expiresAt: new Date(Date.now() + 600000).toISOString() });
const payment = () => ({ signature: "0x" + "42".repeat(65), authorization: { from: payer, to: merchant, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: D } });
// relay outcomes: the mock writes the row state exactly as the real relayer does (relay.test.ts covers the relayer itself)
const completion = async (d: any, requestId: string) => { d.prepare("UPDATE payments SET state = 'COMPLETED', tx_hash = ?, settlement_evidence_json = ? WHERE request_id = ?").run(T, JSON.stringify({ transactionHash: T }), requestId); return { state: "COMPLETED", txHash: T, reason: null, evidence: { transactionHash: T } }; };
const failure = async (d: any, requestId: string) => { d.prepare("UPDATE payments SET state = 'FAILED' WHERE request_id = ?").run(requestId); return { state: "FAILED", txHash: null, reason: "payer balance below the authorized amount", evidence: null }; };
const snapshot = () => ({ chainId: 5042002, blockNumber: "100", blockHash: D, observedAt: new Date().toISOString(), providerId: "offline-test", pinningMode: "BLOCK_HASH" });
const approvedBaseline = (subject = merchant) => BaselineCore.parse({ schemaVersion: "1.0", chainId: 5042002, subject, approvedBy: "test-admin", approvedAt: new Date().toISOString(), validUntil: null, previousBaselineDigest: null, referenceSnapshot: snapshot(), dependencies: [], allowedSelectors: ["0x12345678"], adapterManifestDigests: [], approvedState: [] });
function storeBaseline(b = approvedBaseline(), revoked = false) {
  const digest = baselineDigest(b);
  db.prepare("INSERT INTO baselines (baseline_digest,subject,baseline_json,revoked,created_at) VALUES (?,?,?,?,?)").run(digest, b.subject, JSON.stringify(b), Number(revoked), new Date().toISOString());
  return digest;
}
async function call(method: string, url: string, body?: unknown, token: string | null = "buyer-token") {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: "127.0.0.1" } });
  let status = 0; let result: any;
  const res = { writeHead(s: number) { status = s; }, end(s?: string) { result = s ? JSON.parse(s) : null; } };
  await handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { status, body: result };
}
let serial = 0;
beforeEach(() => {
  vi.clearAllMocks(); serial = 0; mocks.paused.mockResolvedValue({ paused: false, balanceNativeAtomic: 10n ** 18n, floorNativeAtomic: 1n });
  for (const table of ["payments", "quotes", "reports", "requests", "baselines", "usage"]) db.exec(`DELETE FROM ${table}`);
  mocks.build.mockImplementation(async (_intent, digest, baseline, suppliedBaselineDigest) => {
    const report = ReportCore.parse({ schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest: digest, decisionEligible: true, observation: { ...snapshot(), blockNumber: String(100 + serial++) }, methodologyDigest: D, adapterManifestDigests: [], baselineDigest: suppliedBaselineDigest, baselineResult: baseline ? "MATCH" : "NO_BASELINE", dependencies: [], signals: [], rawEvidenceDigests: [], exclusions: [], expiresAt: new Date(Date.now() + 60000).toISOString() });
    return { report, digest: reportDigest(report), evidence: [], simulation: { ok: true, error: null } };
  });
});
afterEach(() => vi.useRealTimers());
afterAll(() => db.close());

describe("preflight quote, payment and recovery routes", () => {
  it("recovers the original report after timeout and quote/report expiry without another charge", async () => {
    const intent = makeIntent(); const p = payment();
    const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockRejectedValueOnce(new Error("connection lost after acceptance")).mockImplementationOnce(completion);
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 202, body: { payment: { state: "SUBMITTED" } } });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120000);
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`)).toMatchObject({ status: 200, body: { delivery: "DELIVERED", expired: true, reportDigest: quoted.body.reportDigest, payment: { transaction: T } } });
    expect(mocks.relay.mock.calls[1][2]).toEqual(mocks.relay.mock.calls[0][2]);
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 200, body: { delivery: "DELIVERED", reportDigest: quoted.body.reportDigest } });
    expect(mocks.build).toHaveBeenCalledTimes(1); expect(mocks.relay).toHaveBeenCalledTimes(2);
  });
  it("resumes an expired SUBMITTED quote via POST without preparing a new report", async () => {
    const intent = makeIntent(); const p = payment(); const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockRejectedValueOnce(new Error("timeout")).mockImplementationOnce(completion);
    await call("POST", "/v1/preflight", { intent, payment: p });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 200, body: { delivery: "DELIVERED", reportDigest: quoted.body.reportDigest } });
    expect(mocks.build).toHaveBeenCalledTimes(1); expect(mocks.relay.mock.calls[1][2]).toEqual(mocks.relay.mock.calls[0][2]);
  });
  it("rejects a first payment for an expired quote without replacing its report or charging", async () => {
    const intent = makeIntent(); const quoted = await call("POST", "/v1/preflight", { intent });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    expect(await call("POST", "/v1/preflight", { intent, payment: payment() })).toMatchObject({ status: 409, body: { error: "QUOTE_EXPIRED" } });
    expect(mocks.relay).not.toHaveBeenCalled(); expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT quote_digest FROM quotes").get()?.quote_digest).toBe(quoted.body.quoteDigest);
    const refreshed = await call("POST", "/v1/preflight", { intent });
    expect(refreshed.status).toBe(402); expect(refreshed.body.reportDigest).not.toBe(quoted.body.reportDigest);
  });
  it("requires a prepared quote before accepting a first payment", async () => {
    expect(await call("POST", "/v1/preflight", { intent: makeIntent(), payment: payment() })).toMatchObject({ status: 409, body: { error: "QUOTE_EXPIRED" } });
    expect(mocks.relay).not.toHaveBeenCalled(); expect(mocks.build).not.toHaveBeenCalled();
  });
  it("prepares one immutable quote for concurrent requests with the same intent", async () => {
    const intent = makeIntent(); const [first, second] = await Promise.all([call("POST", "/v1/preflight", { intent }), call("POST", "/v1/preflight", { intent })]);
    expect(first.status).toBe(402); expect(second.status).toBe(402); expect(first.body.quoteDigest).toBe(second.body.quoteDigest); expect(first.body.reportDigest).toBe(second.body.reportDigest); expect(mocks.build).toHaveBeenCalledTimes(1);
  });
  it("keeps concurrent GET recovery pending while one remote settle owns the lease", async () => {
    const intent = makeIntent(); const quoted = await call("POST", "/v1/preflight", { intent });
    let resolve!: () => void;
    mocks.relay.mockImplementationOnce((d: any, requestId: string) => new Promise((r) => { resolve = () => r(completion(d, requestId)); }));
    const submitting = call("POST", "/v1/preflight", { intent, payment: payment() });
    await vi.waitFor(() => expect(mocks.relay).toHaveBeenCalledTimes(1));
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`)).toMatchObject({ status: 202, body: { payment: { state: "SUBMITTED" } } });
    expect(mocks.relay).toHaveBeenCalledTimes(1); resolve();
    expect(await submitting).toMatchObject({ status: 200, body: { delivery: "DELIVERED" } });
  });
  it("preserves failed quotes and rejects a replacement authorization", async () => {
    const intent = makeIntent(); const p = payment(); const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockImplementationOnce(failure);
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 402, body: { payment: { state: "FAILED" } } });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString()); p.authorization.nonce = T;
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 409, body: { error: "PAYMENT_CONFLICT" } });
    expect(db.prepare("SELECT report_digest FROM quotes").get()?.report_digest).toBe(quoted.body.reportDigest); expect(mocks.relay).toHaveBeenCalledTimes(1); expect(mocks.build).toHaveBeenCalledTimes(1);
  });
  it("does not reveal or reconcile another principal's private request", async () => {
    const quoted = await call("POST", "/v1/preflight", { intent: makeIntent() });
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, "other-token")).toMatchObject({ status: 404 });
    expect(mocks.relay).not.toHaveBeenCalled();
  });
});

describe("authenticated baseline metadata", () => {
  it("requires authentication, returns current revocation and reports unknown digests", async () => {
    const b = approvedBaseline(); const digest = storeBaseline(b, true);
    expect(await call("GET", `/v1/baselines/${digest}`, undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", `/v1/baselines/${digest}`)).toEqual({ status: 200, body: { baselineDigest: digest, baseline: b, revoked: true } });
    expect(await call("GET", `/v1/baselines/${D}`)).toMatchObject({ status: 404, body: { error: "NOT_FOUND" } });
  });
  it("supplies a valid baseline to the report builder", async () => {
    const b = approvedBaseline(); const digest = storeBaseline(b);
    expect((await call("POST", "/v1/preflight", { intent: makeIntent(digest) })).status).toBe(402); expect(mocks.build.mock.calls[0][2]).toEqual(b);
  });
  it("does not treat expired or wrong-subject baselines as approved", async () => {
    const b = approvedBaseline("0x4444444444444444444444444444444444444444"); const digest = storeBaseline(b);
    await call("POST", "/v1/preflight", { intent: makeIntent(digest) }); expect(mocks.build.mock.calls[0][2]).toBeNull();
    const expired = { ...approvedBaseline(), validUntil: new Date(Date.now() - 1).toISOString() }; const expiredDigest = storeBaseline(expired);
    const next = makeIntent(expiredDigest); next.clientRequestId = "expired-baseline-request";
    await call("POST", "/v1/preflight", { intent: next }); expect(mocks.build.mock.calls[1][2]).toBeNull();
  });
});

describe("public object observation is limited to the curated samples", () => {
  const usdc = "0x3600000000000000000000000000000000000000";
  const reportCount = () => (db.prepare("SELECT COUNT(*) AS c FROM reports").get() as { c: number }).c;
  const observe = (address: string) => call("GET", `/v1/subjects/${address}`, undefined, null);
  const stored = { digest: D, report: { mode: "OBJECT_OBSERVATION" }, evidence: [{}, {}] };
  it("refuses an address outside the curated list before any chain read, cache or database write", async () => {
    const r = await observe("0x4444444444444444444444444444444444444444");
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "UNSUPPORTED_SUBJECT" });
    expect(r.body.curated.map((s: { address: string }) => s.address.toLowerCase())).toEqual(expect.arrayContaining([usdc, merchant]));
    expect(buildObjectReport).not.toHaveBeenCalled();
    expect(reportCount()).toBe(0);
  });
  it("refusals do not touch the per-client limiter and never grow the report list", async () => {
    for (let i = 1; i <= 30; i++) expect((await observe(`0x${i.toString(16).padStart(40, "0")}`)).status).toBe(422);
    expect(buildObjectReport).not.toHaveBeenCalled();
    expect(reportCount()).toBe(0);
    vi.mocked(buildObjectReport).mockResolvedValue(stored as never);
    expect((await observe(merchant)).status).toBe(200); // a curated address is still served (each test uses its own address: the route keeps a 30 s in-memory cache)
  });
  it("observes and publishes a curated external sample, and marks a fixture proxy as a supported target", async () => {
    vi.mocked(buildObjectReport).mockResolvedValue(stored as never);
    const external = await observe(usdc.toUpperCase().replace("0X", "0x"));
    expect(external).toMatchObject({ status: 200, body: { reportDigest: D, supported: false, evidenceCount: 2 } });
    expect(db.prepare("SELECT mode, is_public, subject FROM reports").all()).toMatchObject([{ mode: "OBJECT_OBSERVATION", is_public: 1, subject: usdc }]);
    expect(await observe(merchant)).toMatchObject({ status: 200, body: { supported: true } });
  });
});

describe("closed capabilities and access control are rejected", () => {
  async function rawCall(method: string, url: string, body: string | undefined, headers: Record<string, string> = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: "127.0.0.1" } });
    let status = 0; let result: any;
    const res = { writeHead(s: number) { status = s; }, end(s?: string) { result = s ? JSON.parse(s) : null; } };
    await handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status, body: result };
  }
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const usdcTransfer = () => IntentCore.parse({ ...makeIntent(), businessExpectation: { sourceId: "order-local", sourceDigest: D, action: "SUPPORTED_USDC_TRANSFER", recipient: merchant, asset: "ARC_USDC_ERC20", tokenAddress: "0x3600000000000000000000000000000000000000", amountTokenAtomic: "50000" } });

  it("external paid access is closed: no token, a forged token and a truncated token are all 401", async () => {
    for (const token of [null, "buyer-tokeX", "buyer-toke"]) {
      expect(await call("POST", "/v1/preflight", { intent: makeIntent() }, token)).toMatchObject({ status: 401, body: { error: "UNAUTHENTICATED" } });
    }
    expect(mocks.build).not.toHaveBeenCalled(); expect(count("requests")).toBe(0);
  });
  it("the USDC-transfer intent path is closed (422 UNSUPPORTED_ACTION) before any request, report or quote exists", async () => {
    const r = await call("POST", "/v1/preflight", { intent: usdcTransfer() });
    expect(r).toMatchObject({ status: 422, body: { error: "UNSUPPORTED_ACTION" } });
    expect(mocks.build).not.toHaveBeenCalled(); expect(count("requests")).toBe(0); expect(count("quotes")).toBe(0);
  });
  it("an unsupported target is 422 and lists only the supported ones", async () => {
    const r = await call("POST", "/v1/preflight", { intent: IntentCore.parse({ ...makeIntent(), to: "0x4444444444444444444444444444444444444444" }) });
    expect(r).toMatchObject({ status: 422, body: { error: "UNSUPPORTED_TARGET", supportedTargets: [merchant] } });
    expect(mocks.build).not.toHaveBeenCalled(); expect(count("requests")).toBe(0);
  });
  it("an intent for another chain is 400", async () => {
    const r = await call("POST", "/v1/preflight", { intent: IntentCore.parse({ ...makeIntent(), chainId: 5042 }) });
    expect(r).toMatchObject({ status: 400, body: { error: "INVALID_INPUT", reason: "chainId must be 5042002" } });
    expect(count("requests")).toBe(0);
  });
  it("smart-account and EIP-7702 wallet modes cannot be expressed: schema validation rejects them (400)", async () => {
    for (const walletMode of ["SMART_ACCOUNT_ERC4337", "EOA_EIP7702_DELEGATED", "UNKNOWN"]) {
      expect(await call("POST", "/v1/preflight", { intent: { ...makeIntent(), walletMode } })).toMatchObject({ status: 400, body: { error: "INVALID_INPUT" } });
    }
    expect(mocks.build).not.toHaveBeenCalled(); expect(count("requests")).toBe(0);
  });
  it("one clientRequestId cannot be rebound to a different intent (409 REQUEST_CONFLICT)", async () => {
    const first = makeIntent();
    expect((await call("POST", "/v1/preflight", { intent: first })).status).toBe(402);
    const second = await call("POST", "/v1/preflight", { intent: { ...first, valueNativeAtomic: "50000000000000001" } });
    expect(second).toMatchObject({ status: 409, body: { error: "REQUEST_CONFLICT" } });
    expect(count("requests")).toBe(1);
  });
  it("admin routes need the admin token: none, a wrong one, or a buyer bearer token are 403 and change nothing", async () => {
    const body = JSON.stringify({ baseline: approvedBaseline() });
    for (const headers of [{}, { "x-admin-token": "admin-tesT" }, { "x-admin-token": "admin" }, { authorization: "Bearer buyer-token" }] as Record<string, string>[]) {
      expect(await rawCall("POST", "/v1/admin/baselines", body, headers)).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } });
    }
    expect(count("baselines")).toBe(0);
    const ok = await rawCall("POST", "/v1/admin/baselines", body, { "x-admin-token": "admin-test" });
    expect(ok.status).toBe(201); expect(count("baselines")).toBe(1);
    const revokeUrl = `/v1/admin/baselines/${ok.body.baselineDigest}/revoke`;
    expect((await rawCall("POST", revokeUrl, undefined, { authorization: "Bearer buyer-token" })).status).toBe(403);
    expect(db.prepare("SELECT revoked FROM baselines").get()).toMatchObject({ revoked: 0 });
    expect((await rawCall("POST", revokeUrl, undefined, { "x-admin-token": "admin-test" })).status).toBe(200);
    expect(db.prepare("SELECT revoked FROM baselines").get()).toMatchObject({ revoked: 1 });
  });
  it("approved-baseline lookup needs a principal", async () => {
    const digest = storeBaseline();
    expect(await call("GET", `/v1/baselines/${digest}`, undefined, null)).toMatchObject({ status: 401 });
    expect((await call("GET", `/v1/baselines/${digest}`)).status).toBe(200);
  });
  it("request recovery is private: no token is 401 and another principal gets 404, not a leak", async () => {
    const quoted = await call("POST", "/v1/preflight", { intent: makeIntent() });
    const url = `/v1/requests/${quoted.body.requestId}`;
    expect(await call("GET", url, undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", url, undefined, "other-token")).toMatchObject({ status: 404, body: { error: "NOT_FOUND" } });
    expect((await call("GET", url)).status).toBe(200);
  });
  it("developer orders need a principal and a real payer address", async () => {
    expect(await call("POST", "/v1/demo/orders", { payer: payer }, null)).toMatchObject({ status: 401 });
    expect(await call("POST", "/v1/demo/orders", { payer: "0x1234" })).toMatchObject({ status: 400, body: { error: "INVALID_INPUT", field: "payer" } });
    expect(await call("POST", "/v1/demo/orders", { payer, amountNativeAtomic: "1" })).toMatchObject({ status: 400, body: { error: "INVALID_INPUT", field: "amountNativeAtomic" } });
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("the public demo accepts only the three fixed fixtures", async () => {
    expect(await call("POST", "/v1/demo/run", { fixture: "SOMETHING_ELSE" }, null)).toMatchObject({ status: 400, body: { error: "INVALID_INPUT" } });
    expect(await call("POST", "/v1/demo/run", { fixture: "__proto__" }, null)).toMatchObject({ status: 400 });
    expect(await call("POST", "/v1/demo/run", {}, null)).toMatchObject({ status: 400 });
  });
  it("oversized and malformed bodies are 413 and 400, unknown routes 404", async () => {
    const auth = { authorization: "Bearer buyer-token" };
    expect((await rawCall("POST", "/v1/preflight", "x".repeat(70_000), auth)).status).toBe(413);
    expect(await rawCall("POST", "/v1/preflight", "{not json", auth)).toMatchObject({ status: 400, body: { error: "INVALID_JSON" } });
    expect(await call("GET", "/v1/nope", undefined, null)).toMatchObject({ status: 404, body: { error: "NOT_FOUND" } });
  });
});

describe("admission keys, observe-only reads and recovery commands (design v3.2 §10)", () => {
  it("run admission requires a client key; the same key returns the original run (200) and a conflict is 409", async () => {
    const { startRun } = await import("../src/demo.js");
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT" }, null)).toMatchObject({ status: 400, body: { reason: expect.stringContaining("clientRunRequestId") } });
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "short" }, null)).toMatchObject({ status: 400 });
    expect(startRun).not.toHaveBeenCalled();
    vi.mocked(startRun).mockResolvedValueOnce({ ok: true, runId: "11111111-1111-4111-8111-111111111111" } as any);
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "key-aaaaaaaaaaaaaaaa" }, null)).toMatchObject({ status: 202, body: { admission: "new" } });
    expect(vi.mocked(startRun).mock.calls.at(-1)?.[3]).toBe("key-aaaaaaaaaaaaaaaa");
    vi.mocked(startRun).mockResolvedValueOnce({ ok: true, runId: "11111111-1111-4111-8111-111111111111", existing: true } as any);
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "key-aaaaaaaaaaaaaaaa" }, null)).toMatchObject({ status: 200, body: { admission: "existing", runId: "11111111-1111-4111-8111-111111111111" } });
    vi.mocked(startRun).mockResolvedValueOnce({ ok: false, status: 409, error: "RUN_CONFLICT", reason: "bound to another scenario" } as any);
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "key-aaaaaaaaaaaaaaaa" }, null)).toMatchObject({ status: 409, body: { error: "RUN_CONFLICT" } });
  });
  it("GET on an unresolved run observes only; the recovery command needs the admission key and a matching run", async () => {
    const { getRun, observeExecutions, reconcileExecutions, recoverRun } = await import("../src/demo.js");
    const id = "11111111-1111-4111-8111-111111111111";
    vi.mocked(getRun).mockReturnValue({ runId: id, state: "RECONCILE_REQUIRED" } as any);
    vi.mocked(observeExecutions).mockResolvedValue({ resolved: 0, pending: 1 });
    try {
      expect(await call("GET", `/v1/demo/runs/${id}`, undefined, null)).toMatchObject({ status: 200 });
      expect(observeExecutions).toHaveBeenCalledWith(expect.anything(), id); expect(reconcileExecutions).not.toHaveBeenCalled();
      expect(await call("POST", `/v1/demo/runs/${id}/recover`, {}, null)).toMatchObject({ status: 400 });
      vi.mocked(recoverRun).mockResolvedValueOnce(null);
      expect(await call("POST", `/v1/demo/runs/${id}/recover`, { clientRunRequestId: "key-wrongwrongwrongwrong" }, null)).toMatchObject({ status: 404 });
      vi.mocked(recoverRun).mockResolvedValueOnce({ runId: id, state: "DONE" } as any);
      expect(await call("POST", `/v1/demo/runs/${id}/recover`, { clientRunRequestId: "key-aaaaaaaaaaaaaaaa" }, null)).toMatchObject({ status: 200, body: { state: "DONE" } });
      expect(vi.mocked(recoverRun).mock.calls.at(-1)?.slice(1, 3)).toEqual([id, "key-aaaaaaaaaaaaaaaa"]);
    } finally { vi.mocked(getRun).mockReset(); }
  });
  it("GET /v1/requests/{id} observes without sending; POST …/recover is the authenticated act-mode command", async () => {
    const intent = makeIntent(); const p = payment();
    const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockImplementation(async (d: any, requestId: string) => { d.prepare("UPDATE payments SET state = 'PENDING', tx_hash = ? WHERE request_id = ?").run(T, requestId); return { state: "PENDING", txHash: T, reason: "receipt not yet available", evidence: null }; });
    try {
      expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 202 });
      expect(mocks.relay).toHaveBeenLastCalledWith(expect.anything(), quoted.body.requestId, expect.anything(), { allowSend: true });
      expect(await call("GET", `/v1/requests/${quoted.body.requestId}`)).toMatchObject({ status: 202 });
      expect(mocks.relay).toHaveBeenLastCalledWith(expect.anything(), quoted.body.requestId, expect.anything(), { allowSend: false });
      expect(await call("POST", `/v1/requests/${quoted.body.requestId}/recover`, undefined, null)).toMatchObject({ status: 401 });
      expect(await call("POST", `/v1/requests/${quoted.body.requestId}/recover`, undefined, "other-token")).toMatchObject({ status: 404 });
      expect(await call("POST", `/v1/requests/${quoted.body.requestId}/recover`)).toMatchObject({ status: 202 });
      expect(mocks.relay).toHaveBeenLastCalledWith(expect.anything(), quoted.body.requestId, expect.anything(), { allowSend: true });
    } finally { mocks.relay.mockReset(); }
  });
});

describe("history lists (design v3.2 §6: records a developer can come back to)", () => {
  it("GET /v1/requests lists only the caller's checks with payment state and passport availability, never another principal's", async () => {
    const intent = makeIntent(); const p = payment();
    const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockImplementationOnce(completion);
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 200 });
    expect(await call("GET", "/v1/requests", undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", "/v1/requests", undefined, "other-token")).toMatchObject({ status: 200, body: { requests: [] } });
    const mine = await call("GET", "/v1/requests");
    expect(mine.status).toBe(200); expect(mine.body.requests).toHaveLength(1);
    expect(check(DOC, "get", "/v1/requests", 200, mine.body)).toEqual([]); // the check history as served
    expect(mine.body.requests[0]).toMatchObject({ requestId: quoted.body.requestId, state: "DELIVERED", subject: merchant, payment: { state: "COMPLETED", backend: "relay", transaction: T }, passportAvailable: true });
    expect(mocks.relay).toHaveBeenCalledTimes(1); // listing reconciles nothing
  });
  it("GET /v1/demo/runs paginates and bounds its limit", async () => {
    const { listRuns } = await import("../src/demo.js");
    vi.mocked(listRuns).mockReturnValue({ runs: [], total: 0, limit: 100, offset: 5 } as any);
    expect(await call("GET", "/v1/demo/runs?limit=500&offset=5", undefined, null)).toMatchObject({ status: 200, body: { total: 0 } });
    expect(vi.mocked(listRuns).mock.calls.at(-1)?.slice(1)).toEqual([100, 5]);
  });
});

describe("readiness (AP32-34)", () => {
  it("reports degraded with 503 when the RPC cannot be reached, without inventing a healthy state", async () => {
    const r = await call("GET", "/health/ready", undefined, null);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ready: false, state: "degraded", deps: { rpc: { ok: false }, db: { ok: true } } });
    expect(await call("GET", "/health/live", undefined, null)).toMatchObject({ status: 200, body: { ok: true, network: "eip155:5042002" } });
  });
});

describe("the complete lifecycle for every session (design v3.3): orders and wallet attempts", () => {
  const ATT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("creates the caller's order with amount and reference, owner-scoped, and lists or reads it back", async () => {
    mocks.order.mockResolvedValue({ ok: true, orderId: D, tx: T, block: "100", merchant, proxy: "CHANGED", payer, amountNativeAtomic: "7000000000000000", reference: "invoice #42", baselineDigest: null, state: "CONFIRMED", owner: "buyer" });
    expect(await call("POST", "/v1/demo/orders", { payer, proxy: "CHANGED", amountNativeAtomic: "7000000000000000", reference: "invoice #42" })).toMatchObject({ status: 201, body: { orderId: D, reference: "invoice #42", state: "CONFIRMED" } });
    expect(mocks.order.mock.calls[0][1]).toMatchObject({ payer, proxy: "CHANGED", amountNativeAtomic: 7_000_000_000_000_000n, reference: "invoice #42", owner: "buyer", client: "client-key" });
    mocks.listOrders.mockResolvedValue({ orders: [{ orderId: D }] }); mocks.getOrder.mockResolvedValue(null);
    expect(await call("GET", "/v1/demo/orders", undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", "/v1/demo/orders")).toMatchObject({ status: 200, body: { orders: [{ orderId: D }] } }); expect(mocks.listOrders.mock.calls[0][1]).toBe("buyer");
    expect(await call("GET", `/v1/demo/orders/${D}`)).toMatchObject({ status: 404 }); expect(mocks.getOrder.mock.calls[0].slice(1)).toEqual(["buyer", D]);
  });
  it("order creation answers 202 ORDER_CREATION_PENDING with the identity, 502 naming the order, and says no order was created before an identity exists (2026-10-09)", async () => {
    mocks.order.mockResolvedValueOnce({ ok: true, pending: true, status: 202, orderId: D, state: "SENT", tx: T, nextAction: "creation sent, not yet confirmed — waiting for its receipt; recover re-sends the same signed transaction (never a second order); approval stays closed until the order is confirmed",
      reason: "the node did not confirm taking the creation transaction", merchant, proxy: "MAIN", payer, amountNativeAtomic: "50000000000000000", reference: null, owner: "buyer" });
    const pending = await call("POST", "/v1/demo/orders", { payer });
    expect(pending).toMatchObject({ status: 202, body: { error: "ORDER_CREATION_PENDING", code: "ORDER_CREATION_PENDING", pending: true, orderId: D, state: "SENT", tx: T, nextAction: expect.stringContaining("not yet confirmed") } });
    expect(pending.body).not.toHaveProperty("ok"); expect(pending.body).not.toHaveProperty("status");
    mocks.order.mockResolvedValueOnce({ ok: false, status: 502, error: "ORDER_CREATION_FAILED", reason: "the creation transaction reverted", orderId: D, state: "FAILED", tx: T });
    expect(await call("POST", "/v1/demo/orders", { payer })).toMatchObject({ status: 502, body: { error: "ORDER_CREATION_FAILED", reason: "the creation transaction reverted", orderId: D, state: "FAILED", tx: T } });
    mocks.order.mockResolvedValueOnce({ ok: false, status: 503, error: "DEPENDENCY_ERROR", reason: "the order was not created (rpc unavailable); no order identity was recorded and nothing was sent" });
    const before = await call("POST", "/v1/demo/orders", { payer });
    expect(before).toMatchObject({ status: 503, body: { error: "DEPENDENCY_ERROR", reason: expect.stringContaining("no order identity was recorded") } });
    expect(before.body).not.toHaveProperty("orderId");
  });
  it("order recovery: the owner's session, owner-scoped, rate-limited by the service, answers with the order", async () => {
    expect(await call("POST", `/v1/demo/orders/${D}/recover`, undefined, null)).toMatchObject({ status: 401 });
    mocks.recoverOrder.mockResolvedValueOnce({ ok: true, order: { orderId: D, state: "SENT", paid: null } });
    expect(await call("POST", `/v1/demo/orders/${D}/recover`)).toMatchObject({ status: 200, body: { orderId: D, state: "SENT", paid: null } });
    expect(mocks.recoverOrder.mock.calls[0].slice(1)).toEqual(["buyer", D]);
    mocks.recoverOrder.mockResolvedValueOnce({ ok: false, status: 429, error: "RATE_LIMITED", reason: "one recovery per order every 3 seconds" });
    expect(await call("POST", `/v1/demo/orders/${D}/recover`)).toMatchObject({ status: 429, body: { error: "RATE_LIMITED" } });
    mocks.recoverOrder.mockResolvedValueOnce({ ok: false, status: 404, error: "NOT_FOUND", reason: "unknown order" });
    expect(await call("POST", `/v1/demo/orders/${D}/recover`, undefined, "other-token")).toMatchObject({ status: 404 });
    expect(mocks.recoverOrder.mock.calls[2].slice(1)).toEqual(["other", D]);
    const paths = (await call("GET", "/openapi.json", undefined, null)).body.paths;
    expect(paths["/v1/demo/orders/{orderId}/recover"].post.summary).toMatch(/IDENTICAL signed creation.*never signs a replacement/);
    expect(paths["/v1/demo/orders"].post.summary).toContain("202 ORDER_CREATION_PENDING");
  });
  it("wallet attempts: every route needs the owner's session; validation refusals carry their reasons", async () => {
    expect(await call("POST", "/v1/wallet/attempts", { requestId: ATT, orderId: D }, null)).toMatchObject({ status: 401 });
    mocks.attempt.mockResolvedValue({ ok: false, status: 409, error: "VALIDATION_FAILED", reason: "final validation did not pass; nothing is signed", reasons: ["balance < value + gas reserve"], attemptId: ATT });
    expect(await call("POST", "/v1/wallet/attempts", { requestId: ATT, orderId: D, policy: {} })).toMatchObject({ status: 409, body: { error: "VALIDATION_FAILED", reasons: ["balance < value + gas reserve"], attemptId: ATT } });
    mocks.attempt.mockResolvedValue({ ok: true, status: 201, attempt: { attemptId: ATT, state: "VALIDATED" } });
    expect(await call("POST", "/v1/wallet/attempts", { requestId: ATT, orderId: D, policy: {} })).toMatchObject({ status: 201, body: { attemptId: ATT, state: "VALIDATED" } });
    expect(mocks.attempt.mock.calls[1].slice(1, 3)).toEqual(["buyer", "client-key"]);
    for (const [fn, method, suffix, body] of [[mocks.sent, "POST", "/sent", { txHash: T }], [mocks.abandon, "POST", "/abandon", {}], [mocks.recover, "POST", "/recover", {}], [mocks.observe, "GET", "", undefined]] as const) {
      (fn as any).mockReturnValue({ ok: true, status: 200, attempt: { attemptId: ATT, state: "CONFIRMED" } }); // plain object: abandon is synchronous, the others are awaited
      expect(await call(method, `/v1/wallet/attempts/${ATT}${suffix}`, body, null)).toMatchObject({ status: 401 });
      expect(await call(method, `/v1/wallet/attempts/${ATT}${suffix}`, body)).toMatchObject({ status: 200, body: { attemptId: ATT } });
    }
    expect(mocks.sent.mock.calls[0].slice(1)).toEqual(["buyer", ATT, T]);
    mocks.listAttempts.mockReturnValue([{ attemptId: ATT }]);
    expect(await call("GET", "/v1/wallet/attempts")).toMatchObject({ status: 200, body: { attempts: [{ attemptId: ATT }] } });
    mocks.walletPassport.mockResolvedValue({ ok: true, bundle: { files: {} }, manifest: {} });
    expect(await call("GET", `/v1/wallet/attempts/${ATT}/passport`)).toMatchObject({ status: 200 }); expect(mocks.walletPassport.mock.calls[0].slice(1)).toEqual([ATT, "buyer"]);
    expect(await call("DELETE", `/v1/wallet/attempts/${ATT}`)).toMatchObject({ status: 405 });
  });
  /** a request with arbitrary headers (the admin token travels as x-admin-token) */
  async function callWith(method: string, url: string, body: unknown, headers: Record<string, string>) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers, socket: { remoteAddress: "127.0.0.1" } });
    let status = 0; let result: any;
    const res = { writeHead(s: number) { status = s; }, end(x?: string) { result = x ? JSON.parse(x) : null; } };
    await handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status, body: result };
  }
  it("while public execution is gated, live runs, wallet attempts and order creation answer 503 unless the operator's admin token is present; checks and reads stay open", async () => {
    const { cfg } = await import("../src/config.js");
    (cfg as any).publicExecution = false;
    try {
      expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "k".repeat(20) }, null)).toMatchObject({ status: 503, body: { error: "EXECUTION_GATED" } });
      expect(await call("POST", "/v1/wallet/attempts", { requestId: ATT, orderId: D, policy: {} })).toMatchObject({ status: 503, body: { error: "EXECUTION_GATED" } });
      // Gate D: an order is a project-paid transaction — gated with execution while public execution is closed
      expect(await call("POST", "/v1/demo/orders", { payer })).toMatchObject({ status: 503, body: { error: "EXECUTION_GATED", reason: expect.stringContaining("order creation on this instance is gated") } });
      expect(mocks.startRun).not.toHaveBeenCalled(); expect(mocks.attempt).not.toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled();
      mocks.listOrders.mockResolvedValue({ orders: [] });
      expect((await call("GET", "/v1/demo/orders")).status).toBe(200); // reads stay open
      // the operator's token passes all three
      mocks.startRun.mockResolvedValue({ ok: true, runId: ATT }); mocks.attempt.mockResolvedValue({ ok: true, status: 201, attempt: { attemptId: ATT } }); mocks.order.mockResolvedValue({ ok: true, orderId: D, state: "CONFIRMED" });
      expect((await callWith("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "k".repeat(20) }, { "x-admin-token": "admin-test" })).status).toBe(202); // the acceptance scripts pass the gate with the operator's token
      expect((await callWith("POST", "/v1/wallet/attempts", { requestId: ATT, orderId: D, policy: {} }, { authorization: "Bearer buyer-token", "x-admin-token": "admin-test" })).status).toBe(201);
      expect((await callWith("POST", "/v1/demo/orders", { payer }, { authorization: "Bearer buyer-token", "x-admin-token": "admin-test" })).status).toBe(201);
      expect((await callWith("POST", "/v1/demo/orders", { payer }, { authorization: "Bearer buyer-token", "x-admin-token": "wrong" })).status).toBe(503); // a wrong token is no token
    } finally { (cfg as any).publicExecution = true; }
  });
  it("gate probes are safe: empty bodies answer 503 while gated, validation errors when open or with the operator's token — never a run, an attempt or an order", async () => {
    const { cfg } = await import("../src/config.js");
    const visitor = { authorization: "Bearer buyer-token" }, operator = { authorization: "Bearer buyer-token", "x-admin-token": "admin-test" };
    // the real createWalletAttempt refuses an empty body with 400 before any side effect (requestId is checked first); mirrored here
    mocks.attempt.mockResolvedValue({ ok: false, status: 400, error: "INVALID_INPUT", reason: "requestId must be the id of a delivered check" });
    const probe = (headers: Record<string, string>) => Promise.all([callWith("POST", "/v1/demo/run", {}, headers), callWith("POST", "/v1/demo/orders", {}, headers), callWith("POST", "/v1/wallet/attempts", {}, headers)]);
    (cfg as any).publicExecution = false;
    try {
      const gated = await probe(visitor);
      expect(gated.map((r) => `${r.status} ${r.body?.error}`)).toEqual(["503 EXECUTION_GATED", "503 EXECUTION_GATED", "503 EXECUTION_GATED"]);
      expect((await callWith("POST", "/v1/demo/run", {}, {})).status).toBe(503); // no session needed for the run route's probe
      const withToken = await probe(operator);
      expect(withToken.map((r) => r.status)).toEqual([400, 400, 400]); // past the gate, the empty bodies fail validation
      expect(mocks.startRun).not.toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled();
    } finally { (cfg as any).publicExecution = true; }
    const open = await probe(visitor);
    expect(open.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(open.every((r) => r.status < 200 || r.status >= 300)).toBe(true);
    expect((await callWith("POST", "/v1/demo/orders", {}, {})).status).toBe(401); // no session: unauthenticated, never created
    expect(mocks.startRun).not.toHaveBeenCalled(); expect(mocks.order).not.toHaveBeenCalled();
  });
  it("the Live Demo accepts a labelled interruption flag and passes it to the run", async () => {
    mocks.startRun.mockResolvedValue({ ok: true, runId: ATT });
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "k".repeat(20), interruptAfterBroadcast: "yes" }, null)).toMatchObject({ status: 400 });
    expect(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "k".repeat(20), interruptAfterBroadcast: true }, null)).toMatchObject({ status: 202 });
    expect(mocks.startRun.mock.calls[0][4]).toEqual({ interruptAfterBroadcast: true });
  });
});

describe("every documented branch is a branch the route answers (review of 199dd55, 2026-10-10)", () => {
  const ATT6 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  /** the answer validates against the document's schema for that route and status */
  const documented = (r: { status: number; body: any }, method: string, path: string) => { expect(check(DOC, method, path, r.status, r.body), `${method.toUpperCase()} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`).toEqual([]); return r; };
  it("a check that is unpaid or whose payment failed reads 200 with its payment state (never 402); the quote, the refused payment and the conflicts validate too", async () => {
    const intent = makeIntent(); const p = payment();
    const quoted = documented(await call("POST", "/v1/preflight", { intent }), "post", "/v1/preflight");
    expect(quoted).toMatchObject({ status: 402, body: { quote: { requestId: expect.any(String) }, paymentRequirements: expect.anything() } }); expect(quoted.body.error).toBeUndefined();
    const unpaid = documented(await call("GET", `/v1/requests/${quoted.body.requestId}`), "get", "/v1/requests/{requestId}");
    expect(unpaid).toMatchObject({ status: 200, body: { state: "WAITING_PAYMENT", payment: { state: "NOT_REQUESTED", paymentId: null, backend: null, transaction: null, reason: null }, quote: { requestId: quoted.body.requestId }, quoteExpired: false } });
    expect(unpaid.body.delivery).toBeUndefined(); // the unpaid branch: a status, not a report
    const rebound = documented(await call("POST", "/v1/preflight", { intent: { ...intent, valueNativeAtomic: "50000000000000001" } }), "post", "/v1/preflight"); expect(rebound).toMatchObject({ status: 409, body: { error: "REQUEST_CONFLICT" } });
    mocks.relay.mockImplementationOnce(failure);
    const refused = documented(await call("POST", "/v1/preflight", { intent, payment: p }), "post", "/v1/preflight");
    expect(refused).toMatchObject({ status: 402, body: { error: "PAYMENT_FAILED", payment: { state: "FAILED", reason: "payer balance below the authorized amount", backend: "relay" }, quote: { requestId: quoted.body.requestId } } });
    const failed = documented(await call("GET", `/v1/requests/${quoted.body.requestId}`), "get", "/v1/requests/{requestId}");
    expect(failed).toMatchObject({ status: 200, body: { payment: { state: "FAILED", backend: "relay", transaction: null }, quoteExpired: false } }); expect(failed.body.delivery).toBeUndefined();
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString()); p.authorization.nonce = T;
    const conflict = documented(await call("POST", "/v1/preflight", { intent, payment: p }), "post", "/v1/preflight"); expect(conflict).toMatchObject({ status: 409, body: { error: "PAYMENT_CONFLICT" } });
    const other = { ...makeIntent(), clientRequestId: "another-request" }; const q2 = await call("POST", "/v1/preflight", { intent: other });
    db.prepare("UPDATE quotes SET expires_at = ? WHERE request_id = ?").run(new Date(Date.now() - 1).toISOString(), q2.body.requestId);
    const expired = documented(await call("POST", "/v1/preflight", { intent: other, payment: payment() }), "post", "/v1/preflight"); expect(expired).toMatchObject({ status: 409, body: { error: "QUOTE_EXPIRED", requestId: q2.body.requestId } });
  });
  it("a settling fee reads 202 with the same status shape on POST /v1/preflight, GET /v1/requests/{id} and POST …/recover; a delivered check reads 200 on all three", async () => {
    const intent = makeIntent(); const p = payment(); const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.relay.mockImplementation(async (d: any, requestId: string) => { d.prepare("UPDATE payments SET state = 'PENDING', tx_hash = ? WHERE request_id = ?").run(T, requestId); return { state: "PENDING", txHash: T, reason: "receipt not yet available", evidence: null }; });
    try {
      expect(documented(await call("POST", "/v1/preflight", { intent, payment: p }), "post", "/v1/preflight")).toMatchObject({ status: 202, body: { payment: { state: "PENDING", transaction: T }, note: expect.stringContaining("not yet confirmed") } });
      expect(documented(await call("GET", `/v1/requests/${quoted.body.requestId}`), "get", "/v1/requests/{requestId}")).toMatchObject({ status: 202, body: { state: "WAITING_PAYMENT", payment: { state: "PENDING", backend: "relay", transaction: T } } });
      expect(documented(await call("POST", `/v1/requests/${quoted.body.requestId}/recover`), "post", "/v1/requests/{requestId}/recover")).toMatchObject({ status: 202, body: { payment: { state: "PENDING" } } });
      mocks.relay.mockImplementation(completion);
      expect(documented(await call("POST", `/v1/requests/${quoted.body.requestId}/recover`), "post", "/v1/requests/{requestId}/recover")).toMatchObject({ status: 200, body: { delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: T }, expired: false } });
      expect(documented(await call("GET", `/v1/requests/${quoted.body.requestId}`), "get", "/v1/requests/{requestId}")).toMatchObject({ status: 200, body: { delivery: "DELIVERED" } });
      expect(documented(await call("POST", "/v1/preflight", { intent, payment: p }), "post", "/v1/preflight")).toMatchObject({ status: 200, body: { delivery: "DELIVERED" } });
    } finally { mocks.relay.mockReset(); }
  });
  it("a paused relayer answers 503 SETTLEMENT_PAUSED as documented and stores no authorization", async () => {
    const intent = makeIntent(); await call("POST", "/v1/preflight", { intent });
    mocks.paused.mockResolvedValueOnce({ paused: true, balanceNativeAtomic: 1n, floorNativeAtomic: 10n ** 18n });
    const paused = documented(await call("POST", "/v1/preflight", { intent, payment: payment() }), "post", "/v1/preflight");
    expect(paused).toMatchObject({ status: 503, body: { error: "SETTLEMENT_PAUSED", retryAfterSeconds: 60, note: expect.stringContaining("no authorization was stored") } });
    expect(db.prepare("SELECT count(*) AS n FROM payments").get()?.n).toBe(0); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("the faucet's 200, 202 (pending, with the hash) and 503 (a hash when one was sent) validate", async () => {
    const { claimFaucet } = await import("../src/demo.js");
    const sent = { ok: true as const, txHash: T, amountNativeAtomic: "200000000000000000", address: payer as Hex };
    vi.mocked(claimFaucet).mockResolvedValueOnce({ ...sent, pending: false, note: "sent and confirmed" } as any);
    expect(documented(await call("POST", "/v1/faucet", { address: payer }, null), "post", "/v1/faucet").status).toBe(200);
    vi.mocked(claimFaucet).mockResolvedValueOnce({ ...sent, pending: true, note: "sent, not yet confirmed: no receipt within the wait; follow the hash on the explorer" } as any);
    expect(documented(await call("POST", "/v1/faucet", { address: payer }, null), "post", "/v1/faucet")).toMatchObject({ status: 202, body: { pending: true, txHash: T } });
    vi.mocked(claimFaucet).mockResolvedValueOnce({ ok: false, status: 503, error: "FAUCET_FAILED", reason: "no receipt", txHash: T } as any);
    expect(documented(await call("POST", "/v1/faucet", { address: payer }, null), "post", "/v1/faucet")).toMatchObject({ status: 503, body: { error: "FAUCET_FAILED", txHash: T } });
    expect(documented(await call("POST", "/v1/faucet", { address: payer }, null), "post", "/v1/faucet")).toMatchObject({ status: 404, body: { error: "FAUCET_DISABLED" } }); // the default mock: disabled
  });
  it("POST /v1/wallet/attempts: 503 while gated (not 403), 409 ATTEMPT_OPEN with reasons: null, 409 VALIDATION_FAILED with reasons, 429 — each as documented", async () => {
    const { cfg } = await import("../src/config.js");
    (cfg as any).publicExecution = false;
    try { expect(documented(await call("POST", "/v1/wallet/attempts", { requestId: ATT6, orderId: D, policy: {} }), "post", "/v1/wallet/attempts")).toMatchObject({ status: 503, body: { error: "EXECUTION_GATED" } }); }
    finally { (cfg as any).publicExecution = true; }
    expect(DOC.paths["/v1/wallet/attempts"].post.responses[403]).toBeUndefined(); // the route never answers 403
    mocks.attempt.mockResolvedValueOnce({ ok: false, status: 409, error: "ATTEMPT_OPEN", reason: "an attempt for this order is still open", attemptId: ATT6 });
    const open = documented(await call("POST", "/v1/wallet/attempts", { requestId: ATT6, orderId: D, policy: {} }), "post", "/v1/wallet/attempts");
    expect(open).toMatchObject({ status: 409, body: { error: "ATTEMPT_OPEN", reasons: null, attemptId: ATT6 } });
    mocks.attempt.mockResolvedValueOnce({ ok: false, status: 409, error: "VALIDATION_FAILED", reason: "the decision is REVIEW_REQUIRED: nothing is executed", reasons: ["BASELINE_STATUS: implementation changed"], attemptId: ATT6 });
    expect(documented(await call("POST", "/v1/wallet/attempts", { requestId: ATT6, orderId: D, policy: {} }), "post", "/v1/wallet/attempts")).toMatchObject({ status: 409, body: { reasons: ["BASELINE_STATUS: implementation changed"] } });
    mocks.attempt.mockResolvedValueOnce({ ok: false, status: 409, error: "ORDER_ALREADY_PAID", reason: "this order already reads as paid" });
    expect(documented(await call("POST", "/v1/wallet/attempts", { requestId: ATT6, orderId: D, policy: {} }), "post", "/v1/wallet/attempts")).toMatchObject({ status: 409, body: { reasons: null, attemptId: null } });
    mocks.attempt.mockResolvedValueOnce({ ok: false, status: 429, error: "RATE_LIMITED", reason: "at most 20 validations per principal per day" });
    expect(documented(await call("POST", "/v1/wallet/attempts", { requestId: ATT6, orderId: D, policy: {} }), "post", "/v1/wallet/attempts").status).toBe(429);
  });
  it("orders answer 429 on the budget or the cooldown, runs 409 RUN_CONFLICT, readiness 503 when degraded — each as documented", async () => {
    mocks.order.mockResolvedValueOnce({ ok: false, status: 429, error: "DEMO_COOLDOWN", reason: "this client created an order 10 s ago; wait 50 s" });
    expect(documented(await call("POST", "/v1/demo/orders", { payer }), "post", "/v1/demo/orders")).toMatchObject({ status: 429, body: { error: "DEMO_COOLDOWN" } });
    mocks.order.mockResolvedValueOnce({ ok: false, status: 503, error: "GAS_CAP_EXCEEDED", reason: "the creation would cost more than the cap" });
    expect(documented(await call("POST", "/v1/demo/orders", { payer }), "post", "/v1/demo/orders").status).toBe(503);
    mocks.startRun.mockResolvedValueOnce({ ok: false, status: 409, error: "RUN_CONFLICT", reason: "clientRunRequestId already bound to another fixture" });
    expect(documented(await call("POST", "/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId: "k".repeat(20) }, null), "post", "/v1/demo/run")).toMatchObject({ status: 409, body: { error: "RUN_CONFLICT", sampleRunId: null } });
    expect(DOC.paths["/v1/demo/run"].post.summary).toContain("RUN_CONFLICT"); expect(DOC.paths["/v1/demo/run"].post.summary).not.toContain("ADMISSION_CONFLICT");
    expect(documented(await call("GET", "/health/ready", undefined, null), "get", "/health/ready")).toMatchObject({ status: 503, body: { ready: false, state: "degraded" } });
  });
});

describe("faucet route", () => {
  it("validates the address and answers 404 where the faucet is disabled (mainnet)", async () => {
    expect(await call("POST", "/v1/faucet", { address: "0x1234" }, null)).toMatchObject({ status: 400, body: { error: "INVALID_INPUT" } });
    expect(await call("POST", "/v1/faucet", { address: payer }, null)).toMatchObject({ status: 404, body: { error: "FAUCET_DISABLED" } });
    expect(await call("GET", "/v1/faucet", undefined, null)).toMatchObject({ status: 200, body: { enabled: false } });
  });
  it("answers 202 with the recorded hash when the claim was sent but not yet confirmed", async () => {
    const { claimFaucet } = await import("../src/demo.js");
    vi.mocked(claimFaucet).mockResolvedValueOnce({ ok: true, pending: true, txHash: T, amountNativeAtomic: "200000000000000000", address: payer as Hex, note: "sent, not yet confirmed: no receipt within the wait; follow the hash on the explorer" });
    expect(await call("POST", "/v1/faucet", { address: payer }, null)).toMatchObject({ status: 202, body: { pending: true, txHash: T, note: expect.stringMatching(/^sent, not yet confirmed/) } });
  });
});

describe("open self-service through anonymous sessions (user decision 2026-10-08)", () => {
  it("issues a session any visitor can use as a principal, scopes ownership to it, and bounds session creation per client", async () => {
    const { clientKey } = await import("../src/demo.js"); vi.mocked(clientKey).mockReturnValue("client-session-test");
    const made = await call("POST", "/v1/session", undefined, null);
    expect(made.status).toBe(201); expect(made.body.token).toMatch(/^vs_[0-9a-f]{48}$/); expect(made.body.principal).toMatch(/^visitor:/);
    expect(check(DOC, "post", "/v1/session", 201, made.body)).toEqual([]); // the session as served
    const intent = makeIntent();
    const quoted = await call("POST", "/v1/preflight", { intent }, made.body.token);
    expect(quoted.status).toBe(402);
    expect(check(DOC, "post", "/v1/preflight", 402, quoted.body)).toEqual([]); // the quote as served
    expect(await call("GET", "/v1/requests", undefined, made.body.token)).toMatchObject({ status: 200, body: { requests: [{ requestId: quoted.body.requestId }] } });
    const other = await call("POST", "/v1/session", undefined, null);
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, other.body.token)).toMatchObject({ status: 404 }); // another visitor's session cannot see it
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, "vs_" + "00".repeat(24))).toMatchObject({ status: 401 }); // unknown token
    for (let i = 0; i < 8; i++) expect((await call("POST", "/v1/session", undefined, null)).status).toBe(201);
    expect(await call("POST", "/v1/session", undefined, null)).toMatchObject({ status: 429, body: { error: "RATE_LIMITED" } });
  });
});
