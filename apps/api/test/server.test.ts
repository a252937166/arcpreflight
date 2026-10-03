import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Hex } from "viem";
import { BaselineCore, baselineDigest, IntentCore, reportDigest, ReportCore } from "@arcpreflight/schema";
const mocks = vi.hoisted(() => ({ settle: vi.fn(), status: vi.fn(), build: vi.fn() }));
vi.mock("../src/config.js", () => ({ cfg: {
  dbPath: ":memory:", root: "/tmp/arcpreflight-offline-test", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", publicBaseUrl: "http://offline.invalid", port: 4040, profile: "SUBMISSION_RESTRICTED", releaseSha: "test",
  principals: new Map([["buyer-token", "buyer"], ["other-token", "other"]]), adminToken: "admin-test", supportedTargets: ["0x2222222222222222222222222222222222222222"], maxPreflightPerPrincipalPerDay: 200, priceTokenAtomic: "10000", quoteTtlSeconds: 30, retentionDays: 30,
  merchant: { address: "0x2222222222222222222222222222222222222222", signMessage: async () => "0x" + "ab".repeat(65) },
} }));
vi.mock("@arcpreflight/client", async (original) => ({ ...(await original<typeof import("@arcpreflight/client")>()), FacilitatorClient: class { settle = mocks.settle; status = mocks.status; } }));
vi.mock("../src/report.js", () => ({ client: {}, buildObjectReport: vi.fn(), buildIntentReport: mocks.build }));
vi.mock("../src/demo.js", () => ({ FIXTURES: {}, networkInfo: vi.fn(), startRun: vi.fn(), getRun: vi.fn(), listRuns: vi.fn(), createOrderFor: vi.fn(), evidenceIndex: vi.fn(), evidenceFile: vi.fn(), clientKey: vi.fn() }));
import { db, handle } from "../src/server.js";
const D = "0x" + "11".repeat(32) as Hex;
const T = "0x" + "22".repeat(32) as Hex;
const merchant = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const makeIntent = (baseline = D) => IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "test-request", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: payer, operation: "CALL", to: merchant, data: "0x12345678", valueNativeAtomic: "50000000000000000", businessExpectation: { sourceId: "order-local", sourceDigest: D, action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: "50000000000000000", orderId: D }, baselineDigest: baseline, policyDigest: D, expiresAt: new Date(Date.now() + 600000).toISOString() });
const payment = () => ({ signature: "0x" + "42".repeat(65), authorization: { from: payer, to: merchant, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: D } });
const completion = () => ({ httpStatus: 200, json: { success: true, transaction: T }, text: "" });
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
  vi.clearAllMocks(); serial = 0;
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
    mocks.settle.mockRejectedValueOnce(new Error("connection lost after acceptance")).mockResolvedValueOnce(completion());
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 202, body: { payment: { state: "SUBMITTED" } } });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120000);
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`)).toMatchObject({ status: 200, body: { delivery: "DELIVERED", expired: true, reportDigest: quoted.body.reportDigest, payment: { transaction: T } } });
    expect(mocks.settle.mock.calls[1][0]).toEqual(mocks.settle.mock.calls[0][0]);
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 200, body: { delivery: "DELIVERED", reportDigest: quoted.body.reportDigest } });
    expect(mocks.build).toHaveBeenCalledTimes(1); expect(mocks.settle).toHaveBeenCalledTimes(2);
  });
  it("resumes an expired SUBMITTED quote via POST without preparing a new report", async () => {
    const intent = makeIntent(); const p = payment(); const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.settle.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(completion());
    await call("POST", "/v1/preflight", { intent, payment: p });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 200, body: { delivery: "DELIVERED", reportDigest: quoted.body.reportDigest } });
    expect(mocks.build).toHaveBeenCalledTimes(1); expect(mocks.settle.mock.calls[1][0]).toEqual(mocks.settle.mock.calls[0][0]);
  });
  it("rejects a first payment for an expired quote without replacing its report or charging", async () => {
    const intent = makeIntent(); const quoted = await call("POST", "/v1/preflight", { intent });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    expect(await call("POST", "/v1/preflight", { intent, payment: payment() })).toMatchObject({ status: 409, body: { error: "QUOTE_EXPIRED" } });
    expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT quote_digest FROM quotes").get()?.quote_digest).toBe(quoted.body.quoteDigest);
    const refreshed = await call("POST", "/v1/preflight", { intent });
    expect(refreshed.status).toBe(402); expect(refreshed.body.reportDigest).not.toBe(quoted.body.reportDigest);
  });
  it("requires a prepared quote before accepting a first payment", async () => {
    expect(await call("POST", "/v1/preflight", { intent: makeIntent(), payment: payment() })).toMatchObject({ status: 409, body: { error: "QUOTE_EXPIRED" } });
    expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.build).not.toHaveBeenCalled();
  });
  it("prepares one immutable quote for concurrent requests with the same intent", async () => {
    const intent = makeIntent(); const [first, second] = await Promise.all([call("POST", "/v1/preflight", { intent }), call("POST", "/v1/preflight", { intent })]);
    expect(first.status).toBe(402); expect(second.status).toBe(402); expect(first.body.quoteDigest).toBe(second.body.quoteDigest); expect(first.body.reportDigest).toBe(second.body.reportDigest); expect(mocks.build).toHaveBeenCalledTimes(1);
  });
  it("keeps concurrent GET recovery pending while one remote settle owns the lease", async () => {
    const intent = makeIntent(); const quoted = await call("POST", "/v1/preflight", { intent });
    let resolve!: (value: ReturnType<typeof completion>) => void;
    mocks.settle.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const submitting = call("POST", "/v1/preflight", { intent, payment: payment() });
    await vi.waitFor(() => expect(mocks.settle).toHaveBeenCalledTimes(1));
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`)).toMatchObject({ status: 202, body: { payment: { state: "SUBMITTED" } } });
    expect(mocks.settle).toHaveBeenCalledTimes(1); resolve(completion());
    expect(await submitting).toMatchObject({ status: 200, body: { delivery: "DELIVERED" } });
  });
  it("preserves failed quotes and rejects a replacement authorization", async () => {
    const intent = makeIntent(); const p = payment(); const quoted = await call("POST", "/v1/preflight", { intent });
    mocks.settle.mockResolvedValueOnce({ httpStatus: 200, json: { success: false, errorReason: "insufficient_funds" }, text: "" });
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 402, body: { payment: { state: "FAILED" } } });
    db.prepare("UPDATE quotes SET expires_at = ?").run(new Date(Date.now() - 1).toISOString()); p.authorization.nonce = T;
    expect(await call("POST", "/v1/preflight", { intent, payment: p })).toMatchObject({ status: 409, body: { error: "PAYMENT_CONFLICT" } });
    expect(db.prepare("SELECT report_digest FROM quotes").get()?.report_digest).toBe(quoted.body.reportDigest); expect(mocks.settle).toHaveBeenCalledTimes(1); expect(mocks.build).toHaveBeenCalledTimes(1);
  });
  it("does not reveal or reconcile another principal's private request", async () => {
    const quoted = await call("POST", "/v1/preflight", { intent: makeIntent() });
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", `/v1/requests/${quoted.body.requestId}`, undefined, "other-token")).toMatchObject({ status: 404 });
    expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
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
