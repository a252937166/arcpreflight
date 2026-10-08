import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex } from "viem";
import { IntentCore, intentDigest } from "@arcpreflight/schema";
import { openDb, row, run, type Db } from "../src/db.js";

// The relayer itself is covered by relay.test.ts; here it is a mock that writes the row state the way the real one does, so the
// durable-outbox, lease, binding and backend-dispatch rules of the payment layer are tested in isolation.
const mocks = vi.hoisted(() => ({ relay: vi.fn(), paused: vi.fn(), legacySettle: vi.fn(), legacyStatus: vi.fn() }));
vi.mock("../src/config.js", () => ({ cfg: {
  net: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", priceTokenAtomic: "10000", quoteTtlSeconds: 30, retentionDays: 30,
  merchant: { address: "0x2222222222222222222222222222222222222222", signMessage: async () => "0x" + "ab".repeat(65) },
  relay: { floorNativeAtomic: 50_000_000_000_000_000n, maxFeeNativeAtomic: 5_000_000_000_000_000n, receiptTimeoutMs: 100, scanChunkBlocks: 9000, scanChunksPerCall: 3 },
} }));
vi.mock("../src/report.js", () => ({ client: { getBlockNumber: async () => 1000n } }));
vi.mock("../src/relay.js", () => ({ Relayer: class { settle = mocks.relay; paused = mocks.paused; }, relayRpcFromClient: () => ({}) }));
vi.mock("@arcpreflight/client", async (original) => ({ ...(await original<typeof import("@arcpreflight/client")>()),
  FacilitatorClient: class { settle = mocks.legacySettle; status = mocks.legacyStatus; },
}));
import { makeQuote, paymentMatchesQuote, reconcilePayment, settleForRequest, resumeSettlements, settlementStatus, beginSettlementResume, type PaymentInput } from "../src/payments.js";

const D = "0x" + "11".repeat(32) as Hex;
const T = "0x" + "22".repeat(32) as Hex;
const payer = "0x3333333333333333333333333333333333333333";
const merchant = "0x2222222222222222222222222222222222222222";
const signature = "0x" + "42".repeat(65) as Hex;
const intent = IntentCore.parse({ schemaVersion: "1.0", clientRequestId: "test-request", chainId: 5042002, walletMode: "EOA_DIRECT_NON_DELEGATED", from: payer, operation: "CALL", to: merchant, data: "0x12345678", valueNativeAtomic: "50000000000000000", businessExpectation: { sourceId: "order-local", sourceDigest: D, action: "MERCHANT_PAY", recipient: merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: "50000000000000000", orderId: D }, baselineDigest: D, policyDigest: D, expiresAt: new Date(Date.now() + 600000).toISOString() });
const input = (): PaymentInput => ({ signature, authorization: { from: payer, to: merchant, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: D } });
/** relay outcomes: the mock updates the row exactly as the real relayer would */
const completes = async (db: Db, requestId: string) => { run(db, "UPDATE payments SET state = 'COMPLETED', tx_hash = ?, settlement_evidence_json = ? WHERE request_id = ?", T, JSON.stringify({ transactionHash: T }), requestId); return { state: "COMPLETED", txHash: T, reason: null, evidence: { transactionHash: T } }; };
const pending = async (db: Db, requestId: string) => { run(db, "UPDATE payments SET state = 'PENDING', tx_hash = ? WHERE request_id = ?", T, requestId); return { state: "PENDING", txHash: T, reason: "receipt not yet available", evidence: null }; };
const fails = async (db: Db, requestId: string) => { run(db, "UPDATE payments SET state = 'FAILED' WHERE request_id = ?", requestId); return { state: "FAILED", txHash: null, reason: "payer balance below the authorized amount", evidence: null }; };
let db: Db;
beforeEach(() => { vi.clearAllMocks(); mocks.paused.mockResolvedValue({ paused: false, balanceNativeAtomic: 10n ** 18n, floorNativeAtomic: 50_000_000_000_000_000n }); db = openDb(":memory:"); });
afterEach(() => { db.close(); });
const quote = (requestId = "request-0000000001") => makeQuote(requestId, "buyer", intent, intentDigest(intent), D, D).quote;
const submit = (requestId = "request-0000000001", p = input()) => settleForRequest(db, requestId, quote(requestId), intent, p, "http://offline.invalid/v1/preflight");

describe("durable payment recovery (self-relayed backend)", () => {
  it("persists an encrypted original authorization, backend and scan bound before the first relay attempt", async () => {
    mocks.relay.mockImplementationOnce(async (d: Db, requestId: string, payload: any) => {
      const saved = row(d, "SELECT * FROM payments");
      expect(saved).toMatchObject({ state: "SUBMITTED", backend: "relay", created_block: 998, facilitator_payment_id: null });
      expect(saved.settle_payload_encrypted).not.toContain(signature);
      expect(saved.settle_payload_encrypted).not.toContain('"signature"');
      expect(saved.quote_digest).toMatch(/^0x[0-9a-f]{64}$/); expect(saved.report_digest).toBe(D);
      expect(payload).toEqual({ signature, authorization: input().authorization });
      return completes(d, requestId);
    });
    expect(await submit()).toMatchObject({ state: "COMPLETED", txHash: T, backend: "relay", evidence: { transactionHash: T } });
    expect(mocks.relay).toHaveBeenCalledTimes(1); expect(mocks.legacySettle).not.toHaveBeenCalled();
  });
  it("replays the exact original authorization after a transport failure, without a second binding", async () => {
    mocks.relay.mockRejectedValueOnce(new Error("rpc connection lost")).mockImplementationOnce(completes);
    expect(await submit()).toMatchObject({ state: "SUBMITTED", reason: expect.stringContaining("not yet confirmed") });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED", txHash: T });
    expect(mocks.relay.mock.calls[1][2]).toEqual(mocks.relay.mock.calls[0][2]);
    expect(row(db, "SELECT settle_lease_owner FROM payments").settle_lease_owner).toBeNull();
  });
  it("recovers from the durable encrypted outbox after the database is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcpreflight-payment-test-"));
    const path = join(dir, "recovery.sqlite"); const savedDb = openDb(path); const requestId = "request-restart-0001";
    mocks.relay.mockRejectedValueOnce(new Error("timeout")).mockImplementationOnce(completes);
    try {
      expect(await settleForRequest(savedDb, requestId, quote(requestId), intent, input(), "http://offline.invalid/v1/preflight")).toMatchObject({ state: "SUBMITTED" });
      savedDb.close();
      const reopened = openDb(path);
      try { expect(await reconcilePayment(reopened, requestId)).toMatchObject({ state: "COMPLETED" }); } finally { reopened.close(); }
      expect(mocks.relay.mock.calls[1][2]).toEqual(mocks.relay.mock.calls[0][2]);
    } finally { if (savedDb.isOpen) savedDb.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("allows only one settlement attempt for concurrent initial submissions", async () => {
    let resolve!: (value: unknown) => void;
    mocks.relay.mockImplementationOnce((d: Db, requestId: string) => new Promise((r) => { resolve = () => r(completes(d, requestId)); }));
    const p = input(); const q = quote();
    const first = settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight");
    await vi.waitFor(() => expect(mocks.relay).toHaveBeenCalledTimes(1));
    expect(await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight")).toMatchObject({ state: "SUBMITTED" });
    expect(mocks.relay).toHaveBeenCalledTimes(1);
    resolve(undefined);
    expect(await first).toMatchObject({ state: "COMPLETED" });
  });
  it("honors a persisted lease and resumes after a crashed owner's lease expires", async () => {
    mocks.relay.mockRejectedValueOnce(new Error("timeout")).mockImplementationOnce(completes);
    await submit();
    run(db, "UPDATE payments SET settle_lease_owner = 'crashed', settle_lease_until = ?", Date.now() + 30000);
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "SUBMITTED" });
    expect(mocks.relay).toHaveBeenCalledTimes(1);
    run(db, "UPDATE payments SET settle_lease_until = ?", Date.now() - 1);
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED" });
    expect(mocks.relay).toHaveBeenCalledTimes(2);
  });
  it("keeps a broadcast-but-unconfirmed payment PENDING and resolves it on a later reconcile", async () => {
    mocks.relay.mockImplementationOnce(pending).mockImplementationOnce(completes);
    expect(await submit()).toMatchObject({ state: "PENDING", txHash: T, reason: "receipt not yet available" });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "COMPLETED", txHash: T });
    expect(mocks.relay).toHaveBeenCalledTimes(2);
  });
  it("rejects nonce or authorization changes and cross-request replay without a new settlement", async () => {
    const p = input(); const q = quote();
    mocks.relay.mockImplementationOnce(completes);
    await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight");
    expect(await settleForRequest(db, q.requestId, q, intent, { ...p, authorization: { ...p.authorization, nonce: T } }, "http://offline.invalid/v1/preflight")).toHaveProperty("conflict");
    expect(await settleForRequest(db, q.requestId, q, intent, { ...p, authorization: { ...p.authorization, validBefore: String(BigInt(p.authorization.validBefore) + 1n) } }, "http://offline.invalid/v1/preflight")).toHaveProperty("conflict");
    expect(await submit("request-0000000002", p)).toHaveProperty("conflict");
    expect(mocks.relay).toHaveBeenCalledTimes(1);
  });
  it("does not attempt terminal failed or completed payments again", async () => {
    mocks.relay.mockImplementationOnce(fails);
    expect(await submit()).toMatchObject({ state: "FAILED", reason: expect.stringContaining("payer balance") });
    expect(await reconcilePayment(db, "request-0000000001")).toMatchObject({ state: "FAILED" });
    expect(mocks.relay).toHaveBeenCalledTimes(1);
  });
  it("refuses a NEW authorization while settlement is paused, storing nothing, but still reconciles existing rows", async () => {
    mocks.paused.mockResolvedValueOnce({ paused: true, balanceNativeAtomic: 1n, floorNativeAtomic: 50_000_000_000_000_000n });
    expect(await submit()).toMatchObject({ paused: expect.stringContaining("paused") });
    expect(row(db, "SELECT COUNT(*) AS c FROM payments")).toMatchObject({ c: 0 }); expect(mocks.relay).not.toHaveBeenCalled();
    mocks.relay.mockImplementationOnce(completes);
    expect(await submit()).toMatchObject({ state: "COMPLETED" });
    expect(await settlementStatus()).toMatchObject({ backend: "relay", relayer: merchant, paused: false });
  });
  it("legacy rows settled through the hosted facilitator keep that reconciliation path and never touch the relayer", async () => {
    const q = quote();
    run(db, "INSERT INTO payments (request_id,payment_identifier,network,asset,payer,auth_nonce,state,created_at,updated_at,facilitator_payment_id) VALUES (?,?,?,?,?,?,?,?,?,?)", q.requestId, "ap_request-0000000001", q.network, q.asset, payer, D, "PENDING", new Date().toISOString(), new Date().toISOString(), "fac-original");
    mocks.legacyStatus.mockResolvedValueOnce({ httpStatus: 503, json: { status: "failed" }, text: "temporary" }).mockResolvedValueOnce({ httpStatus: 200, json: { status: "completed", transaction: T }, text: "" });
    expect(await reconcilePayment(db, q.requestId)).toMatchObject({ state: "PENDING", backend: "circle" });
    expect(await reconcilePayment(db, q.requestId)).toMatchObject({ state: "COMPLETED", txHash: T, backend: "circle", paymentId: "fac-original" });
    expect(mocks.legacyStatus).toHaveBeenCalledTimes(2); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("requires the original authorization when upgrading a legacy submitted record, then settles it with its own backend", async () => {
    const p = input(); const q = quote();
    run(db, "INSERT INTO payments (request_id,payment_identifier,network,asset,payer,auth_nonce,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", q.requestId, "ap_request-0000000001", q.network, q.asset, payer, D, "SUBMITTED", new Date().toISOString(), new Date().toISOString());
    expect(await reconcilePayment(db, q.requestId)).toMatchObject({ state: "SUBMITTED", backend: "circle", reason: expect.stringContaining("original authorization unavailable") });
    expect(mocks.legacySettle).not.toHaveBeenCalled(); expect(mocks.relay).not.toHaveBeenCalled();
    mocks.legacySettle.mockResolvedValueOnce({ httpStatus: 200, json: { success: true, transaction: T }, text: "" });
    expect(await settleForRequest(db, q.requestId, q, intent, p, "http://offline.invalid/v1/preflight")).toMatchObject({ state: "COMPLETED", backend: "circle" });
    expect(row(db, "SELECT settle_payload_encrypted FROM payments").settle_payload_encrypted).toBeTruthy(); expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("resumes every unresolved payment at start-up", async () => {
    mocks.relay.mockImplementationOnce(pending).mockImplementationOnce(completes);
    await submit();
    const lines: string[] = [];
    expect(await resumeSettlements(db, (m) => lines.push(m))).toBe(1);
    expect(lines[0]).toMatch(/PENDING -> COMPLETED/);
    expect(await resumeSettlements(db)).toBe(0);
  });
  it("returns validation failures for malformed payment inputs and permits recovery after authorization expiry", () => {
    expect(paymentMatchesQuote({} as PaymentInput, quote(), intent)).toBeTruthy();
    const p = input(); p.authorization.validBefore = "1";
    expect(paymentMatchesQuote(p, quote(), intent)).toBe("authorization expires too soon");
    expect(paymentMatchesQuote(p, quote(), intent, true)).toBeNull();
    p.authorization.validBefore = "not-a-number";
    expect(paymentMatchesQuote(p, quote(), intent, true)).toBeTruthy();
  });
  it("refuses NEW authorizations while start-up reconciliation is running, then accepts them once it completes", async () => {
    beginSettlementResume();
    expect(await settlementStatus()).toMatchObject({ paused: true, resumed: false });
    expect(await submit()).toMatchObject({ paused: expect.stringContaining("start-up") });
    expect(row(db, "SELECT COUNT(*) AS c FROM payments")).toMatchObject({ c: 0 }); expect(mocks.relay).not.toHaveBeenCalled();
    expect(await resumeSettlements(db)).toBe(0);
    mocks.relay.mockImplementationOnce(completes);
    expect(await submit()).toMatchObject({ state: "COMPLETED" });
  });
});

describe("observe vs act (design v3.2 §10.2)", () => {
  it("passes the sending permission through to the relayer and never submits a legacy row from a read route", async () => {
    mocks.relay.mockImplementation(pending);
    await submit(); // POST path: sending allowed
    expect(mocks.relay).toHaveBeenLastCalledWith(expect.anything(), "request-0000000001", expect.anything(), { allowSend: true });
    await reconcilePayment(db, "request-0000000001", { allowSend: false });
    expect(mocks.relay).toHaveBeenLastCalledWith(expect.anything(), "request-0000000001", expect.anything(), { allowSend: false });
    const q = quote("request-0000000002");
    run(db, "INSERT INTO payments (request_id,payment_identifier,network,asset,payer,auth_nonce,state,created_at,updated_at,settle_payload_encrypted) VALUES (?,?,?,?,?,?,?,?,?,?)", q.requestId, "ap_request-0000000002", q.network, q.asset, payer, T, "SUBMITTED", new Date().toISOString(), new Date().toISOString(), "{}");
    expect(await reconcilePayment(db, q.requestId, { allowSend: false })).toMatchObject({ state: "SUBMITTED", backend: "circle", reason: expect.stringContaining("settlement worker") });
    expect(mocks.legacySettle).not.toHaveBeenCalled();
    mocks.relay.mockReset();
  });
});
