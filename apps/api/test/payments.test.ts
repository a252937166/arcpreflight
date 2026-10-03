import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex } from "viem";
import { IntentCore, intentDigest } from "@arcpreflight/schema";
import { openDb, row, run, type Db } from "../src/db.js";

const mocks = vi.hoisted(() => ({ settle: vi.fn(), status: vi.fn() }));
vi.mock("../src/config.js", () => ({ cfg: {
  net: "testnet", caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", priceTokenAtomic: "10000", quoteTtlSeconds: 30, retentionDays: 30,
  merchant: { address: "0x2222222222222222222222222222222222222222", signMessage: async () => "0x" + "ab".repeat(65) },
} }));
vi.mock("@arcpreflight/client", async (original) => ({ ...(await original<typeof import("@arcpreflight/client")>()),
  FacilitatorClient: class { settle = mocks.settle; status = mocks.status; },
}));
import { makeQuote, paymentMatchesQuote, reconcilePayment, settleForRequest, type PaymentInput } from "../src/payments.js";

const D = "0x" + "11".repeat(32) as Hex;
const T = "0x" + "22".repeat(32) as Hex;
const payer = "0x3333333333333333333333333333333333333333";
const merchant = "0x2222222222222222222222222222222222222222";
const signature = "0x" + "42".repeat(65) as Hex;
const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "test-request", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: payer, operation: "CALL", to: merchant, data: "0x12345678", valueNativeAtomic: "50000000000000000", businessExpectation: { sourceId: "order-local", sourceDigest: D, action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: "50000000000000000", orderId: D }, baselineDigest: D, policyDigest: D, expiresAt: new Date(Date.now() + 600000).toISOString() });
const input = (): PaymentInput => ({ signature, authorization: { from: payer, to: merchant, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: D } });
const completed = () => ({ httpStatus: 200, json: { success: true, transaction: T }, text: "" });
let db: Db;
beforeEach(() => { vi.clearAllMocks(); db = openDb(":memory:"); });
afterEach(() => { db.close(); });
const quote = (requestId = "request-0000000001") => makeQuote(requestId, "buyer", intent, intentDigest(intent), D, D).quote;
const submit = (requestId = "request-0000000001", p = input()) => settleForRequest(db, requestId, quote(requestId), intent, p, "http://offline.invalid/v1/preflight");

describe("durable payment recovery", () => {
  it("persists an encrypted original authorization and quote/report binding before submitting", async () => {
    mocks.settle.mockImplementationOnce(async (body) => {
      const saved = row(db, "SELECT * FROM payments");
      expect(saved.state).toBe("SUBMITTED");
      expect(saved.settle_payload_encrypted).not.toContain(signature);
      expect(saved.settle_payload_encrypted).not.toContain('"signature"');
      expect(saved.quote_digest).toMatch(/^0x[0-9a-f]{64}$/);
      expect(saved.report_digest).toBe(D);
      expect(body.paymentPayload.payload.signature).toBe(signature);
      expect(body.paymentPayload.extensions["payment-identifier"].info.id).toBe(saved.payment_identifier);
      return completed();
    });
    expect(await submit()).toMatchObject({ state: "COMPLETED", txHash: T });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it("replays the exact original body and identifier after a transport timeout", async () => {
    mocks.settle.mockRejectedValueOnce(new Error("connection lost after acceptance")).mockResolvedValueOnce(completed());
    expect(await submit()).toMatchObject({ state: "SUBMITTED", paymentId: null });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED", txHash: T });
    expect(mocks.settle.mock.calls[1][0]).toEqual(mocks.settle.mock.calls[0][0]);
    expect(row(db, "SELECT settle_lease_owner FROM payments").settle_lease_owner).toBeNull();
  });

  it("recovers from the durable encrypted outbox after the database is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcpreflight-payment-test-"));
    const path = join(dir, "recovery.sqlite");
    const savedDb = openDb(path);
    const requestId = "request-restart-0001";
    mocks.settle.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(completed());
    try {
      expect(await settleForRequest(savedDb, requestId, quote(requestId), intent, input(), "http://offline.invalid/v1/preflight")).toMatchObject({ state: "SUBMITTED" });
      savedDb.close();
      const reopened = openDb(path);
      try { expect(await reconcilePayment(reopened, requestId)).toMatchObject({ state: "COMPLETED" }); }
      finally { reopened.close(); }
      expect(mocks.settle.mock.calls[1][0]).toEqual(mocks.settle.mock.calls[0][0]);
    } finally { if (savedDb.isOpen) savedDb.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("allows only one remote settlement for concurrent initial submissions", async () => {
    let resolve!: (value: ReturnType<typeof completed>) => void;
    mocks.settle.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const p = input(); const q = quote();
    const first = settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight");
    await vi.waitFor(() => expect(mocks.settle).toHaveBeenCalledTimes(1));
    const second = await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight");
    expect(second).toMatchObject({ state: "SUBMITTED" });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    resolve(completed());
    expect(await first).toMatchObject({ state: "COMPLETED" });
  });

  it("honors a persisted lease and resumes after a crashed owner's lease expires", async () => {
    mocks.settle.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(completed());
    await submit();
    run(db, "UPDATE payments SET settle_lease_owner = 'crashed', settle_lease_until = ?", Date.now() + 30000);
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "SUBMITTED" });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    run(db, "UPDATE payments SET settle_lease_until = ?", Date.now() - 1);
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED" });
    expect(mocks.settle).toHaveBeenCalledTimes(2);
  });

  it("uses status for a known pending payment ID and keeps HTTP errors nonterminal", async () => {
    mocks.settle.mockResolvedValueOnce({ httpStatus: 200, json: { success: false, errorReason: "settlement_pending", extensions: { "settlement-status": { status: "pending", paymentId: "fac-original", statusUrl: "unused" } } }, text: "" });
    expect(await submit()).toMatchObject({ state: "PENDING", paymentId: "fac-original" });
    mocks.status.mockResolvedValueOnce({ httpStatus: 503, json: { status: "failed" }, text: "temporary" }).mockResolvedValueOnce({ httpStatus: 200, json: { status: "completed", transaction: T }, text: "" });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "PENDING" });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED", txHash: T });
    expect(mocks.status).toHaveBeenNthCalledWith(1, "fac-original");
    expect(mocks.status).toHaveBeenNthCalledWith(2, "fac-original");
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps non-200 settle responses recoverable rather than declaring a failed payment", async () => {
    mocks.settle.mockResolvedValueOnce({ httpStatus: 503, json: null, text: "temporary" }).mockResolvedValueOnce(completed());
    expect(await submit()).toMatchObject({ state: "SUBMITTED" });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED" });
  });

  it("rejects nonce or authorization changes and cross-request replay without submitting", async () => {
    const p = input(); const q = quote();
    mocks.settle.mockResolvedValueOnce(completed());
    await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight");
    expect(await settleForRequest(db, q.requestId, q, intent, { ...p, authorization: { ...p.authorization, nonce: T } }, "http://offline.invalid/v1/preflight")).toHaveProperty("conflict");
    expect(await settleForRequest(db, q.requestId, q, intent, { ...p, authorization: { ...p.authorization, validBefore: String(BigInt(p.authorization.validBefore) + 1n) } }, "http://offline.invalid/v1/preflight")).toHaveProperty("conflict");
    expect(await submit("request-0000000002", p)).toHaveProperty("conflict");
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it("does not submit terminal failed or completed payments again", async () => {
    mocks.settle.mockResolvedValueOnce({ httpStatus: 200, json: { success: false, errorReason: "insufficient_funds" }, text: "" });
    expect(await submit()).toMatchObject({ state: "FAILED" });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "FAILED" });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it("requires the original authorization when upgrading a legacy submitted record", async () => {
    const p = input(); const q = quote();
    run(db, "INSERT INTO payments (request_id,payment_identifier,network,asset,payer,auth_nonce,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", q.requestId, "ap_request-0000000001", q.network, q.asset, payer, D, "SUBMITTED", new Date().toISOString(), new Date().toISOString());
    expect(await reconcilePayment(db, q.requestId)).toMatchObject({ state: "SUBMITTED", reason: expect.stringContaining("original authorization unavailable") });
    expect(mocks.settle).not.toHaveBeenCalled();
    mocks.settle.mockResolvedValueOnce(completed());
    expect(await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight")).toMatchObject({ state: "COMPLETED" });
    expect(row(db, "SELECT settle_payload_encrypted FROM payments").settle_payload_encrypted).toBeTruthy();
  });

  it("returns validation failures for malformed payment inputs and permits recovery after authorization expiry", () => {
    expect(paymentMatchesQuote({} as PaymentInput, quote(), intent)).toBeTruthy();
    const p = input(); p.authorization.validBefore = "1";
    expect(paymentMatchesQuote(p, quote(), intent)).toBe("authorization expires too soon");
    expect(paymentMatchesQuote(p, quote(), intent, true)).toBeNull();
    p.authorization.validBefore = "not-a-number";
    expect(paymentMatchesQuote(p, quote(), intent, true)).toBeTruthy();
  });
});
