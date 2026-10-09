import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  balance: vi.fn(), fixture: vi.fn(), order: vi.fn(), receipt: vi.fn(), tx: vi.fn(), nonce: vi.fn(), read: vi.fn(), send: vi.fn(), head: vi.fn(), block: vi.fn(), sendNative: vi.fn(),
  sign: vi.fn(), walletSend: vi.fn(), estimate: vi.fn(),
  payer: "0x3333333333333333333333333333333333333333",
  merchant: "0x2222222222222222222222222222222222222222",
}));
vi.mock("../src/config.js", () => ({ cfg: {
  root: "/offline/demo-regression", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", rpc: "http://offline.invalid", publicRpc: "https://rpc.public.invalid",
  principals: new Map([["offline", "demo-runner"]]), port: 4040, releaseSha: "test", profile: "SUBMISSION_RESTRICTED", publicExecution: true,
  usdc: mocks.merchant, supportedTargets: [mocks.merchant], priceTokenAtomic: "10000", merchant: { address: mocks.merchant },
  faucet: { enabled: true, amountNativeAtomic: 200000000000000000n, perDay: 30, floorNativeAtomic: 1000000000000000000n },
} }));
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...real,
    existsSync: (p: string) => p.endsWith("deployments-testnet.json") || p.endsWith(".json") && p.includes("/keys/"),
    readFileSync: (p: string, encoding: string) => p.includes("/keys/")
      ? JSON.stringify({ privateKey: "0x" + "11".repeat(32) })
      : p.endsWith("deployments-testnet.json") ? JSON.stringify({ proxies: { MAIN: { address: mocks.merchant }, CHANGED: { address: mocks.merchant } } })
      : real.readFileSync(p, encoding as BufferEncoding),
  };
});
vi.mock("viem/accounts", () => ({ privateKeyToAccount: () => ({ address: mocks.payer }) }));
vi.mock("viem", async () => ({ ...await vi.importActual<typeof import("viem")>("viem"),
  createPublicClient: () => ({ getBalance: mocks.balance, getTransactionReceipt: mocks.receipt, getTransaction: mocks.tx, getTransactionCount: mocks.nonce, readContract: mocks.read, sendRawTransaction: mocks.send, getBlockNumber: mocks.head, getBlock: mocks.block, waitForTransactionReceipt: mocks.receipt, estimateGas: mocks.estimate, estimateFeesPerGas: async () => ({ maxFeePerGas: 21_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }) }), createWalletClient: () => ({ account: { address: mocks.payer }, sendTransaction: mocks.sendNative, signTransaction: mocks.sign, sendRawTransaction: mocks.walletSend }),
}));
// the shared reconciler is real (its own tests live in packages/runner); only the run loop and order creation are mocked here
vi.mock("@arcpreflight/runner", async () => ({ ...(await vi.importActual<any>("@arcpreflight/runner")), runFixture: mocks.fixture, createOrder: mocks.order }));
vi.mock("../src/payments.js", () => ({ sealJson: async (o: unknown) => JSON.stringify(o), openJson: async (s: string) => JSON.parse(s) }));
vi.mock("../src/report.js", () => ({ client: {} })); // the passport module's export-time captures are not exercised here
import { ORDER_PAID_TOPIC, OrderCreationPending, OrderCreationNotSent } from "@arcpreflight/runner";
import { keccak256 } from "viem";
import { createOrderFor, demoBudget, demoState, startRun, reconcileExecutions, observeExecutions, recoverRun, getRun, listRuns, networkInfo } from "../src/demo.js";
import { buildRunPassport } from "../src/passport.js";
import { syntheticRun } from "../../../packages/passport/test/fixture.js";
const ORDER_IN = (client: string, extra: Partial<Parameters<typeof createOrderFor>[1]> = {}) => ({ payer: mocks.payer as `0x${string}`, proxy: "MAIN" as const, amountNativeAtomic: 50_000_000_000_000_000n, reference: null, owner: `visitor:${client}`, client, ...extra });

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let db: ReturnType<typeof openDb>;
let finishRun: ReturnType<typeof deferred<any>>;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO baselines VALUES (?,?,?,?,?)").run("0x" + "11".repeat(32), mocks.merchant, "{}", 0, new Date().toISOString());
  demoBudget.maxRunsPerDay = 40; demoBudget.clientCooldownSeconds = 45;
  mocks.balance.mockReset().mockResolvedValue(10n ** 18n);
  finishRun = deferred(); mocks.fixture.mockReset().mockImplementation(() => finishRun.promise);
  // the real createOrder writes PLANNED → SENT → CONFIRMED through the store it is handed; the mock mimics that so the order table is exercised
  mocks.order.mockReset().mockImplementation(async (_o: any, payer: string, amount: bigint, store?: any) => {
    const created = { orderId: "0x" + "aa".repeat(32), tx: "0x" + "bb".repeat(32), block: "100", from: mocks.payer, gasUsed: "90000", effectiveGasPriceNativeAtomic: "21000000000" };
    await store?.planned({ orderId: created.orderId, payer, amountNativeAtomic: amount.toString(), merchant: mocks.merchant }); await store?.sent({ orderId: created.orderId, tx: created.tx }); await store?.confirmed(created); return created;
  });
  mocks.receipt.mockReset().mockRejectedValue(new Error("not found")); mocks.tx.mockReset().mockResolvedValue(null); mocks.nonce.mockReset().mockResolvedValue(0);
  mocks.read.mockReset().mockResolvedValue([mocks.payer, 50_000_000_000_000_000n, false, 0n, 0n]); mocks.send.mockReset().mockResolvedValue("0x" + "cc".repeat(32));
  mocks.head.mockReset().mockResolvedValue(1000n); mocks.block.mockReset().mockResolvedValue({ transactions: [] });
  mocks.sign.mockReset().mockResolvedValue(`0x02${"fa".repeat(60)}`); mocks.estimate.mockReset().mockResolvedValue(21_000n); mocks.sendNative.mockReset();
  mocks.walletSend.mockReset().mockImplementation(async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) => keccak256(serializedTransaction));
  demoBudget.dailyBusinessCapAtomic = 10n ** 18n; demoBudget.dailyFeeCapAtomic = 4n * 10n ** 17n; demoBudget.dailyGasCapAtomic = 5n * 10n ** 17n;
});
afterEach(async () => {
  finishRun.resolve({});
  await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
  db.close();
});

describe("persistent demo admissions", () => {
  it("reserves before the balance await and rejects a concurrent run", async () => {
    const balance = deferred<bigint>(); mocks.balance.mockReturnValue(balance.promise);
    const first = startRun(db, "APPROVED_PAYMENT", "client-a");
    const second = await startRun(db, "APPROVED_PAYMENT", "client-b");
    expect(second).toMatchObject({ ok: false, error: "DEMO_BUSY" });
    expect(mocks.balance).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_runs WHERE state='RUNNING'").get()).toMatchObject({ c: 1 });
    balance.resolve(10n ** 18n);
    const accepted = await first;
    expect(accepted.ok).toBe(true); expect(mocks.fixture).toHaveBeenCalledTimes(1);
    if (accepted.ok) expect(demoState().activeRun).toBe(accepted.runId);
  });

  it("releases only its own reservation when the balance probe fails", async () => {
    mocks.balance.mockRejectedValueOnce(new Error("rpc unavailable"));
    expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: false, status: 503 });
    expect(demoState().activeRun).toBeNull();
    expect(db.prepare("SELECT state FROM demo_runs").get()).toMatchObject({ state: "FAILED" });
    expect(await startRun(db, "APPROVED_PAYMENT", "client-b")).toMatchObject({ ok: true });
  });

  it("failed reservations still consume the daily budget", async () => {
    demoBudget.maxRunsPerDay = 1; mocks.balance.mockResolvedValue(0n);
    expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: false, status: 503 });
    expect(await startRun(db, "APPROVED_PAYMENT", "client-b")).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED" });
  });

  it("preserves the consumed budget after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arcpreflight-budget-"));
    try {
      db.close(); db = openDb(join(directory, "test.sqlite"));
      db.prepare("INSERT INTO baselines VALUES (?,?,?,?,?)").run("0x" + "11".repeat(32), mocks.merchant, "{}", 0, new Date().toISOString());
      demoBudget.maxRunsPerDay = 1; mocks.balance.mockResolvedValue(0n);
      expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: false, status: 503 });
      db.close(); db = openDb(join(directory, "test.sqlite"));
      expect(await startRun(db, "APPROVED_PAYMENT", "client-b")).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED" });
      expect(mocks.balance).toHaveBeenCalledTimes(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("checks persisted RUNNING reservations even when the process flag is empty", async () => {
    db.prepare("INSERT INTO demo_runs (run_id, fixture,state,steps_json,labels_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("persisted-run", "APPROVED_PAYMENT", "RUNNING", "[]", '["LIVE_REQUEST"]', new Date().toISOString(), new Date().toISOString());
    expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: false, error: "DEMO_BUSY" });
    expect(mocks.balance).not.toHaveBeenCalled();
  });

  it("reserves the last developer-order budget before its admin transaction is queued", async () => {
    demoBudget.maxRunsPerDay = 1;
    const order = deferred<any>(); mocks.order.mockReturnValue(order.promise);
    const first = createOrderFor(db, ORDER_IN("client-a"));
    const second = await createOrderFor(db, ORDER_IN("client-b"));
    expect(second).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED" });
    order.resolve({ orderId: "0x" + "aa".repeat(32), tx: "0x" + "bb".repeat(32), block: "100" });
    expect(await first).toMatchObject({ ok: true });
    expect(mocks.order).toHaveBeenCalledTimes(1);
  });

  it("keeps developer-order cooldown when the RPC fails after admission", async () => {
    mocks.order.mockRejectedValueOnce(new Error("rpc unavailable")); // before the identity was planned: nothing was created
    expect(await createOrderFor(db, ORDER_IN("client-a"))).toMatchObject({ ok: false, status: 503, error: "DEPENDENCY_ERROR", reason: expect.stringContaining("no order identity was recorded and nothing was sent") });
    expect(await createOrderFor(db, ORDER_IN("client-a"))).toMatchObject({ ok: false, error: "DEMO_COOLDOWN" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_order_admissions").get()).toMatchObject({ c: 1 });
  });

  it("rolls back both order writes if admission linking fails, retaining only one reservation", async () => {
    db.exec("CREATE TABLE demo_order_admissions (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, client_key TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TRIGGER reject_link BEFORE UPDATE OF order_id ON demo_order_admissions BEGIN SELECT RAISE(ABORT, 'injected linkage failure'); END");
    expect(await createOrderFor(db, ORDER_IN("client-a"))).toMatchObject({ ok: false, status: 503, error: "DEPENDENCY_ERROR", reason: expect.stringMatching(/injected linkage failure.*no order identity was recorded/) });
    expect(db.prepare("SELECT COUNT(*) AS c FROM orders").get()).toMatchObject({ c: 0 }); // the PLANNED row and its admission link are one transaction
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_order_admissions").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT order_id FROM demo_order_admissions").get()).toMatchObject({ order_id: null });
  });

  it("rejects names that only exist on the prototype chain before reserving anything", async () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(await startRun(db, name as never, "client-a")).toMatchObject({ ok: false, status: 400, error: "INVALID_INPUT" });
    }
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_runs").get()).toMatchObject({ c: 0 }); // no budget, cooldown or run slot was consumed
    expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: true });
  });
});

const D = "0x" + "11".repeat(32);
const RAW = "0x02f8" + "ab".repeat(60);
function insertExecution(d: ReturnType<typeof openDb>, o: { runId: string; runState: string; state: string; nonce?: number; validUntil?: string; txHash?: string; resultJson?: string | null }) {
  const ts = new Date().toISOString();
  d.prepare("INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)").run(o.runId, "APPROVED_PAYMENT", o.runState, "[]", '["LIVE_REQUEST"]', ts, ts, "client-x", o.resultJson ?? null);
  d.prepare("INSERT INTO business_executions (attempt_id, run_id, fixture, order_id, merchant, payer, amount_atomic, intent_digest, report_digest, decision_digest, baseline_digest, policy_digest, final_validation_digest, plan_digest, tx_hash, nonce, raw_tx_encrypted, valid_until, labels_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`attempt-${o.runId}`, o.runId, "APPROVED_PAYMENT", "0x" + "aa".repeat(32), mocks.merchant, mocks.payer, "50000000000000000", D, D, D, D, D, D, D, o.txHash ?? "0x" + "cc".repeat(32), o.nonce ?? 5, JSON.stringify({ raw: RAW }), o.validUntil ?? new Date(Date.now() + 60_000).toISOString(), '["LIVE_REQUEST"]', o.state, ts, ts);
}
const execRow = (d: ReturnType<typeof openDb>, runId: string) => d.prepare("SELECT * FROM business_executions WHERE run_id = ?").get(runId) as any;
const runRow = (d: ReturnType<typeof openDb>, runId: string) => d.prepare("SELECT * FROM demo_runs WHERE run_id = ?").get(runId) as any;

describe("monetary caps (configured reservations, committed with the admission)", () => {
  it("reserves per-category amounts atomically and refuses a run that would exceed the business cap", async () => {
    demoBudget.dailyBusinessCapAtomic = 50_000_000_000_000_000n; demoBudget.clientCooldownSeconds = 0;
    const first = await startRun(db, "APPROVED_PAYMENT", "client-a"); expect(first.ok).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    expect(db.prepare("SELECT used_atomic FROM budget WHERE key = ?").get(`business:${day}`)).toMatchObject({ used_atomic: "50000000000000000" });
    expect(db.prepare("SELECT used_atomic FROM budget WHERE key = ?").get(`fee:${day}`)).toMatchObject({ used_atomic: "10000000000000000" });
    finishRun.resolve({ execution: { chainStatus: "CONFIRMED", businessStatus: "SUCCESS" } });
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    expect(await startRun(db, "APPROVED_PAYMENT", "client-b")).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED", reason: expect.stringContaining("business cap") });
    expect(await startRun(db, "CHANGED_IMPLEMENTATION", "client-c")).toMatchObject({ ok: true }); // no business payment in that fixture
  });
  it("a developer order reserves gas against the daily gas cap", async () => {
    demoBudget.dailyGasCapAtomic = 1n;
    expect(await createOrderFor(db, ORDER_IN("client-a"))).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED", reason: expect.stringContaining("gas cap") });
    expect(mocks.order).not.toHaveBeenCalled();
  });
});

describe("order identity before the send (design v3.3 §2, AP33-05)", () => {
  it("a developer order is PLANNED with owner, amount and reference before the creation transaction, SENT with the hash, CONFIRMED with the receipt facts", async () => {
    const seen: string[] = [];
    mocks.order.mockImplementation(async (_o: any, payer: string, amount: bigint, store: any) => {
      await store.planned({ orderId: "0x" + "ab".repeat(32), payer, amountNativeAtomic: amount.toString(), merchant: mocks.merchant }); seen.push((db.prepare("SELECT state FROM orders").get() as any).state);
      await store.sent({ orderId: "0x" + "ab".repeat(32), tx: "0x" + "bc".repeat(32) }); seen.push((db.prepare("SELECT state FROM orders").get() as any).state);
      const created = { orderId: "0x" + "ab".repeat(32), tx: "0x" + "bc".repeat(32), block: "123", from: mocks.payer, gasUsed: "90000", effectiveGasPriceNativeAtomic: "21000000000" };
      await store.confirmed(created); return created;
    });
    const r = await createOrderFor(db, ORDER_IN("client-a", { amountNativeAtomic: 7_000_000_000_000_000n, reference: "invoice #42" }));
    expect(r).toMatchObject({ ok: true, orderId: "0x" + "ab".repeat(32), amountNativeAtomic: "7000000000000000", reference: "invoice #42", state: "CONFIRMED", owner: "visitor:client-a" });
    expect(seen).toEqual(["PLANNED", "SENT"]);
    const o = db.prepare("SELECT * FROM orders").get() as any;
    expect(o).toMatchObject({ state: "CONFIRMED", owner: "visitor:client-a", source: "developer", amount_atomic: "7000000000000000", reference: "invoice #42", tx_hash: "0x" + "bc".repeat(32), block: "123", gas_used: "90000" });
    expect(db.prepare("SELECT order_id FROM demo_order_admissions").get()).toMatchObject({ order_id: "0x" + "ab".repeat(32) });
  });
  it("a creation that stops after the send stays SENT for reconciliation; nothing replaces it inside the admission", async () => {
    mocks.order.mockImplementation(async (_o: any, payer: string, amount: bigint, store: any) => {
      await store.planned({ orderId: "0x" + "ab".repeat(32), payer, amountNativeAtomic: amount.toString(), merchant: mocks.merchant }); await store.sent({ orderId: "0x" + "ab".repeat(32), tx: "0x" + "bc".repeat(32) });
      throw new Error("process stopped: receipt timeout");
    });
    // the identity exists: the answer is the pending order (202 ORDER_CREATION_PENDING), never a plain error that reads "nothing was changed"
    expect(await createOrderFor(db, ORDER_IN("client-a"))).toMatchObject({ ok: true, pending: true, status: 202, orderId: "0x" + "ab".repeat(32), state: "SENT", tx: "0x" + "bc".repeat(32),
      nextAction: expect.stringContaining("not yet confirmed"), reason: expect.stringContaining("process stopped: receipt timeout") });
    expect(db.prepare("SELECT state, tx_hash FROM orders").get()).toMatchObject({ state: "SENT", tx_hash: "0x" + "bc".repeat(32) });
    expect(db.prepare("SELECT COUNT(*) AS c FROM orders").get()).toMatchObject({ c: 1 });
  });
  it("the Live Demo runner's order is recorded with its run id through the order store it is handed", async () => {
    mocks.fixture.mockImplementation(async (opts: any) => {
      await opts.orderStore.planned({ orderId: "0x" + "ad".repeat(32), payer: mocks.payer, amountNativeAtomic: "50000000000000000", merchant: mocks.merchant });
      expect(db.prepare("SELECT state, source, run_id FROM orders").get()).toMatchObject({ state: "PLANNED", source: "runner" });
      await opts.orderStore.sent({ orderId: "0x" + "ad".repeat(32), tx: "0x" + "ae".repeat(32) });
      await opts.orderStore.confirmed({ orderId: "0x" + "ad".repeat(32), tx: "0x" + "ae".repeat(32), block: "100", from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null });
      return { execution: { chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED" }, decision: { decision: "REVIEW_REQUIRED" } };
    });
    const started = await startRun(db, "CHANGED_IMPLEMENTATION", "client-a"); expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    if (started.ok) {
      expect(db.prepare("SELECT state, run_id, proxy FROM orders").get()).toMatchObject({ state: "CONFIRMED", run_id: started.runId, proxy: "CHANGED" });
      const shaped = getRun(db, started.runId)!;
      expect(shaped.order).toMatchObject({ orderId: "0x" + "ad".repeat(32), state: "CONFIRMED" });
      expect(shaped.outcome).toMatchObject({ kind: "REVIEW_REQUIRED", source: "decision" });
    }
  });
});

describe("artefacts, interruption and store-derived outcomes (design v3.3 §4, AP33-04/06)", () => {
  const F = syntheticRun("APPROVED"); const R = F.source.result!;
  it("interruptAfterBroadcast reaches the runner for the paying fixture only", async () => {
    mocks.fixture.mockResolvedValue({ execution: { chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED" } });
    expect((await startRun(db, "CHANGED_IMPLEMENTATION", "client-a", null, { interruptAfterBroadcast: true })).ok).toBe(true);
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    expect(mocks.fixture.mock.calls[0][0].interruptAfterBroadcast).toBe(false);
    demoBudget.clientCooldownSeconds = 0;
    expect((await startRun(db, "APPROVED_PAYMENT", "client-b", null, { interruptAfterBroadcast: true })).ok).toBe(true);
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    expect(mocks.fixture.mock.calls[1][0].interruptAfterBroadcast).toBe(true);
  });
  it("a run that stops right after the broadcast is served from its artefacts, its headline follows the store, and after reconciliation it exports a complete passport", async () => {
    mocks.fixture.mockImplementation(async (opts: any) => {
      await opts.onArtifact("order", { orderId: R.orderId, tx: F.hashes.CREATE_TX, block: "100", from: null, gasUsed: null, effectiveGasPriceNativeAtomic: null, signer: "order-creator", reference: null });
      await opts.onArtifact("intent", { intent: R.intent, intentDigest: R.intentDigest, policy: R.policy, policyDigest: R.policyDigest });
      await opts.onArtifact("quote", { quote: R.quote, quoteDigest: R.quoteDigest, requestId: R.requestId });
      await opts.onArtifact("feeAuthorization", R.feeAuthorization);
      await opts.onArtifact("report", { report: R.report, reportDigest: R.reportDigest, serviceFeeTx: R.serviceFeeTx, simulation: R.simulation, evidence: [] });
      await opts.onArtifact("decision", { decision: R.decision, decisionDigest: R.decisionDigest });
      await opts.onArtifact("finalValidation", { finalValidation: R.finalValidation, finalValidationEvidence: R.finalValidationEvidence ?? [], plan: R.plan, approvalStatusAtValidation: R.approvalStatusAtValidation ?? null, feeReceipt: null });
      await opts.executionStore.persistSigned({ attemptId: R.attemptId, fixture: "APPROVED_PAYMENT", orderId: R.orderId, merchant: R.merchant, payer: R.intent.from, amountNativeAtomic: (R.intent.businessExpectation as any).amountNativeAtomic, intentDigest: R.intentDigest, reportDigest: R.reportDigest, decisionDigest: R.decisionDigest, baselineDigest: R.intent.baselineDigest, policyDigest: R.policyDigest, finalValidationDigest: R.execution.finalValidationDigest, transactionPlanDigest: R.execution.transactionPlanDigest, txHash: R.execution.businessTxHash!, nonce: Number(R.plan!.nonce), raw: RAW, validUntil: new Date(Date.now() + 60_000).toISOString(), labels: ["LIVE_REQUEST"] });
      await opts.executionStore.markBroadcastAttempted(R.attemptId, { headBlock: "100" });
      await opts.onArtifact("execution", { ...R.execution, chainStatus: "PENDING", businessStatus: "PENDING", postconditionEvidenceDigests: [] });
      opts.onStep({ step: "broadcastAttempted", atMs: 10, businessTxHash: R.execution.businessTxHash });
      throw new Error("simulated process crash after the send");
    });
    const started = await startRun(db, "APPROVED_PAYMENT", "client-a"); expect(started.ok).toBe(true); if (!started.ok) return;
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    const open = getRun(db, started.runId)!;
    expect(open.state).toBe("RECONCILE_REQUIRED"); expect(open.partial).toBe(true);
    expect(open.businessExecution).toMatchObject({ state: "BROADCAST_ATTEMPTED", txHash: R.execution.businessTxHash!.toLowerCase() });
    expect(open.outcome).toMatchObject({ kind: "BROADCAST_UNRESOLVED", source: "store" }); // AP33-06: never "nothing sent" while the store says a broadcast was attempted
    expect(open.result?.intent).toBeTruthy(); expect(open.result?.report).toBeTruthy(); expect(open.result?.decision).toBeTruthy();
    expect(listRuns(db).runs[0]).toMatchObject({ runId: started.runId, businessExecutionState: "BROADCAST_ATTEMPTED", outcome: "BROADCAST_UNRESOLVED", passportAvailable: true });
    // reconciliation from the original hash and the order state completes the record
    const rc = F.receipts[R.execution.businessTxHash!.toLowerCase()]; // the fixture mined the business transaction
    mocks.receipt.mockResolvedValue(rc); mocks.read.mockResolvedValue([R.intent.from, BigInt((R.intent.businessExpectation as any).amountNativeAtomic), true, 1n, 1n]);
    expect(await reconcileExecutions(db, () => {}, { allowSend: true })).toMatchObject({ resolved: 1 });
    const done = getRun(db, started.runId)!;
    expect(done.state).toBe("DONE"); expect(done.outcome).toMatchObject({ kind: "PAID", source: "store" });
    expect(done.result?.reconstructedFromArtifacts).toBe(true); expect(done.result?.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS" });
    expect(mocks.send).not.toHaveBeenCalled();
    db.prepare("INSERT OR IGNORE INTO baselines (baseline_digest, subject, baseline_json, revoked, created_at) VALUES (?,?,?,?,?)").run(F.digests.baseline, F.source.baseline!.subject, JSON.stringify(F.source.baseline), 0, new Date().toISOString());
    const passport = await buildRunPassport(db, started.runId); // AP33-04: complete passport although the process never wrote a result
    expect(passport.ok).toBe(true); if (!passport.ok) return;
    expect(passport.manifest.subject).toMatchObject({ kind: "demo-run", executionMode: "runner", runId: started.runId });
    expect(passport.manifest.stageCoverage).toMatchObject({ intent: true, report: true, decision: true, finalValidation: true, transactionPlan: true, signed: true, broadcast: true, reconciliation: true });
  });
});

describe("business-transaction recovery (spec D07)", () => {
  it("at start-up: broadcast-attempted runs wait for reconciliation, signed-but-never-broadcast runs fail, others fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcpreflight-d07-"));
    try {
      db.close(); db = openDb(join(dir, "t.sqlite"));
      insertExecution(db, { runId: "run-attempted", runState: "RUNNING", state: "BROADCAST_ATTEMPTED", txHash: "0x" + "c1".repeat(32) });
      insertExecution(db, { runId: "run-signed", runState: "RUNNING", state: "SIGNED", txHash: "0x" + "c2".repeat(32) });
      db.prepare("INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("run-plain", "APPROVED_PAYMENT", "RUNNING", "[]", '["LIVE_REQUEST"]', new Date().toISOString(), new Date().toISOString());
      db.close(); db = openDb(join(dir, "t.sqlite"));
      expect(runRow(db, "run-attempted").state).toBe("RECONCILE_REQUIRED"); expect(execRow(db, "run-attempted").state).toBe("BROADCAST_ATTEMPTED");
      expect(runRow(db, "run-signed").state).toBe("FAILED"); expect(execRow(db, "run-signed").state).toBe("INTERRUPTED");
      expect(JSON.parse(runRow(db, "run-signed").steps_json).at(-1).step).toBe("interruptedBeforeBroadcast");
      expect(runRow(db, "run-plain").state).toBe("FAILED"); expect(JSON.parse(runRow(db, "run-plain").steps_json).at(-1).step).toBe("interrupted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("crash window (review round 2): a run whose store row was already closed before the run was finalised is closed from the store, not marked failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arcpreflight-crash-"));
    try {
      db.close(); db = openDb(join(dir, "t.sqlite"));
      insertExecution(db, { runId: "run-stranded", runState: "RUNNING", state: "CONFIRMED", txHash: "0x" + "c3".repeat(32) });
      db.prepare("UPDATE business_executions SET business_status = 'SUCCESS', business_tx_hash = tx_hash, block = '777', postcondition_json = ? WHERE run_id = 'run-stranded'").run(JSON.stringify({ orderId: "0x" + "aa".repeat(32), paid: true, payer: mocks.payer, amountNativeAtomic: "50000000000000000", block: "777", receiptStatus: "success" }));
      db.close(); db = openDb(join(dir, "t.sqlite"));
      expect(runRow(db, "run-stranded").state).toBe("RECONCILE_REQUIRED"); // never FAILED: the store already holds the outcome
      expect(await reconcileExecutions(db, () => {}, { allowSend: false })).toEqual({ resolved: 1, pending: 0 });
      const r = runRow(db, "run-stranded"); expect(r.state).toBe("DONE");
      const result = JSON.parse(r.result_json);
      expect(result.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: "0x" + "c3".repeat(32) });
      expect(result.reconciliation.at(-1).note).toContain("run closed from the store");
      expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled(); // closed from the record, not re-read
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reconciles from the receipt and the order state, re-digesting the execution receipt, without sending anything", async () => {
    insertExecution(db, { runId: "run-1", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED" });
    mocks.receipt.mockResolvedValue({ status: "success", blockNumber: 123n, transactionHash: "0x" + "cc".repeat(32) });
    mocks.read.mockResolvedValue([mocks.payer, 50_000_000_000_000_000n, true, 0n, 123n]);
    expect(await reconcileExecutions(db)).toEqual({ resolved: 1, pending: 0 });
    const r = runRow(db, "run-1"); expect(r.state).toBe("DONE");
    const result = JSON.parse(r.result_json);
    expect(result.execution).toMatchObject({ chainStatus: "CONFIRMED", businessStatus: "SUCCESS", businessTxHash: "0x" + "cc".repeat(32), signedTransactionHash: "0x" + "cc".repeat(32) });
    expect(result.executionDigest).toMatch(/^0x[0-9a-f]{64}$/); expect(result.reconstructedAfterCrash).toBe(true);
    expect(result.postcondition).toMatchObject({ paid: true, block: "123" });
    expect(execRow(db, "run-1")).toMatchObject({ state: "CONFIRMED", business_status: "SUCCESS" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("closes a transaction whose nonce was consumed by something else, without signing a replacement", async () => {
    insertExecution(db, { runId: "run-2", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED", nonce: 5 });
    mocks.nonce.mockResolvedValue(6);
    // a consumed nonce alone concludes nothing (the node may lag): the attempt stays open until the consuming transaction is identified
    expect(await reconcileExecutions(db)).toEqual({ resolved: 0, pending: 1 });
    expect(execRow(db, "run-2")).toMatchObject({ state: "BROADCAST_ATTEMPTED", note: expect.stringContaining("could not be identified") });
    const other = "0x" + "ee".repeat(32);
    mocks.nonce.mockImplementation(async (a: any) => (a.blockNumber !== undefined ? (a.blockNumber >= 995n ? 6 : 5) : 6)); // nonce 5 consumed in block 995
    mocks.block.mockResolvedValue({ transactions: [{ hash: other, from: mocks.payer, nonce: 5 }] });
    mocks.receipt.mockImplementation(async ({ hash }: any) => { if (hash === other) return { status: "success", blockNumber: 995n, logs: [] }; throw new Error("not found"); });
    expect(await reconcileExecutions(db)).toEqual({ resolved: 1, pending: 0 });
    expect(execRow(db, "run-2")).toMatchObject({ state: "NOT_MINED", business_status: "NOT_EXECUTED", consumed_by: other });
    const result = JSON.parse(runRow(db, "run-2").result_json);
    expect(result.execution).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "NOT_EXECUTED", businessTxHash: null });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rebroadcasts the identical bytes inside the validation window and never afterwards; a paid order waits for its receipt", async () => {
    insertExecution(db, { runId: "run-3", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED", validUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(await reconcileExecutions(db)).toEqual({ resolved: 0, pending: 1 });
    expect(mocks.send).toHaveBeenCalledWith({ serializedTransaction: RAW });
    expect(execRow(db, "run-3").state).toBe("BROADCAST_ATTEMPTED");
    db.prepare("UPDATE business_executions SET valid_until = ? WHERE run_id = ?").run(new Date(Date.now() - 1).toISOString(), "run-3");
    expect(await reconcileExecutions(db)).toEqual({ resolved: 0, pending: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.read.mockResolvedValue([mocks.payer, 50_000_000_000_000_000n, true, 0n, 0n]); // paid on-chain, receipt not visible yet
    expect(await reconcileExecutions(db)).toEqual({ resolved: 0, pending: 1 });
    expect(execRow(db, "run-3").state).toBe("BROADCAST_ATTEMPTED");
  });
  it("refuses a new run while an earlier business transaction is unresolved and still within its validation window", async () => {
    insertExecution(db, { runId: "run-4", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED", validUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(await startRun(db, "APPROVED_PAYMENT", "client-a")).toMatchObject({ ok: false, status: 503, reason: expect.stringContaining("unresolved") });
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_runs").get()).toMatchObject({ c: 1 });
  });
  it("wires the durable store: SIGNED before BROADCAST_ATTEMPTED, encrypted-at-rest bytes, and UNKNOWN outcomes keep the run open", async () => {
    const states: string[] = [];
    mocks.fixture.mockImplementation(async (opts: any) => {
      await opts.executionStore.persistSigned({ attemptId: "att-1", fixture: "APPROVED_PAYMENT", orderId: "0x" + "aa".repeat(32), merchant: mocks.merchant, payer: mocks.payer, amountNativeAtomic: "50000000000000000", intentDigest: D, reportDigest: D, decisionDigest: D, baselineDigest: D, policyDigest: D, finalValidationDigest: D, transactionPlanDigest: D, txHash: "0x" + "dd".repeat(32), nonce: 7, raw: RAW, validUntil: new Date(Date.now() + 5000).toISOString(), labels: ["LIVE_REQUEST"] });
      states.push(execRow(db, opts.labels ? (db.prepare("SELECT run_id FROM business_executions WHERE attempt_id = 'att-1'").get() as any).run_id : "").state);
      await opts.executionStore.markBroadcastAttempted("att-1"); states.push((db.prepare("SELECT state FROM business_executions WHERE attempt_id = 'att-1'").get() as any).state);
      await opts.executionStore.persistOutcome("att-1", { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: "0x" + "dd".repeat(32), note: "receipt not obtained" });
      return { execution: { chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", businessTxHash: "0x" + "dd".repeat(32) } };
    });
    const started = await startRun(db, "APPROVED_PAYMENT", "client-a"); expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(demoState().activeRun).toBeNull());
    expect(states).toEqual(["SIGNED", "BROADCAST_ATTEMPTED"]);
    const x = db.prepare("SELECT * FROM business_executions WHERE attempt_id = 'att-1'").get() as any;
    expect(x.state).toBe("BROADCAST_ATTEMPTED"); expect(JSON.parse(x.raw_tx_encrypted).raw).toBe(RAW); // (sealJson is an identity mock here; production encrypts)
    if (started.ok) expect(runRow(db, started.runId).state).toBe("RECONCILE_REQUIRED");
  });
});

describe("admission identity and recovery commands (design v3.2 §10)", () => {
  it("the same clientRunRequestId returns the admitted run; a different scenario under the same key conflicts", async () => {
    const first = await startRun(db, "APPROVED_PAYMENT", "client-a", "key-aaaaaaaaaaaaaaaa");
    expect(first).toMatchObject({ ok: true }); if (!first.ok) return;
    const again = await startRun(db, "APPROVED_PAYMENT", "client-b", "key-aaaaaaaaaaaaaaaa"); // the lost-response retry, even from another address
    expect(again).toEqual({ ok: true, runId: first.runId, existing: true });
    expect(await startRun(db, "CHANGED_IMPLEMENTATION", "client-a", "key-aaaaaaaaaaaaaaaa")).toMatchObject({ ok: false, status: 409, error: "RUN_CONFLICT" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_runs").get()).toMatchObject({ c: 1 });
    expect(mocks.fixture).toHaveBeenCalledTimes(1); expect(mocks.order).not.toHaveBeenCalled(); // no second order, no second check
    expect(db.prepare("SELECT run_id FROM demo_run_admissions WHERE client_run_request_id = ?").get("key-aaaaaaaaaaaaaaaa")).toMatchObject({ run_id: first.runId });
  });
  it("a read-route observation never broadcasts; the recovery command needs the admission key and then rebroadcasts identical bytes", async () => {
    insertExecution(db, { runId: "run-5", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED", validUntil: new Date(Date.now() + 60_000).toISOString() });
    db.prepare("INSERT INTO demo_run_admissions (client_run_request_id, run_id, fixture, client_key, created_at) VALUES (?,?,?,?,?)").run("key-5555555555555555", "run-5", "APPROVED_PAYMENT", "client-x", new Date().toISOString());
    expect(await observeExecutions(db, "run-5")).toEqual({ resolved: 0, pending: 1 });
    expect(mocks.send).not.toHaveBeenCalled(); expect(execRow(db, "run-5").note).toContain("recovery worker");
    expect(await recoverRun(db, "run-5", "key-wrongwrongwrongwrong")).toBeNull(); expect(mocks.send).not.toHaveBeenCalled();
    const recovered = await recoverRun(db, "run-5", "key-5555555555555555");
    expect(recovered?.runId).toBe("run-5");
    expect(mocks.send).toHaveBeenCalledWith({ serializedTransaction: RAW });
    expect(JSON.parse(runRow(db, "run-5").steps_json).at(-1).step).toBe("rebroadcast");
  });
  it("a same-nonce replacement that paid the order closes the attempt as SUPERSEDED, names the replacement and re-signs nothing", async () => {
    insertExecution(db, { runId: "run-6", runState: "RECONCILE_REQUIRED", state: "BROADCAST_ATTEMPTED", nonce: 5 });
    db.prepare("UPDATE business_executions SET broadcast_block = '990' WHERE run_id = 'run-6'").run();
    const replacement = "0x" + "ee".repeat(32);
    mocks.read.mockResolvedValue([mocks.payer, 50_000_000_000_000_000n, true, 0n, 995n]); // the order reads as paid
    mocks.nonce.mockImplementation(async (a: any) => (a.blockNumber !== undefined ? (a.blockNumber >= 995n ? 6 : 5) : 6)); // nonce 5 consumed in block 995
    mocks.block.mockResolvedValue({ transactions: [{ hash: replacement, from: mocks.payer, nonce: 5 }] });
    mocks.receipt.mockImplementation(async ({ hash }: any) => { if (hash === replacement) return { status: "success", blockNumber: 995n, logs: [{ address: mocks.merchant, topics: [ORDER_PAID_TOPIC, "0x" + "aa".repeat(32)] }] }; throw new Error("not found"); });
    expect(await reconcileExecutions(db, () => {}, { allowSend: true })).toEqual({ resolved: 1, pending: 0 });
    expect(execRow(db, "run-6")).toMatchObject({ state: "SUPERSEDED", business_status: "SUCCESS", consumed_by: replacement });
    const result = JSON.parse(runRow(db, "run-6").result_json);
    expect(result.execution).toMatchObject({ chainStatus: "UNKNOWN", businessStatus: "SUCCESS", businessTxHash: replacement });
    expect(result.reconciliation.at(-1)).toMatchObject({ consumedBy: replacement });
    expect(runRow(db, "run-6").state).toBe("DONE"); expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("run history rows", () => {
  it("lists runs newest first with network, recorded amounts, passport availability and a total for paging", async () => {
    const ts = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const result = { network: "testnet", chainId: 5042002, attemptId: "a", orderId: "0x" + "aa".repeat(32), intent: { businessExpectation: { amountNativeAtomic: "50000000000000000" } }, report: {}, serviceFeeTx: "0x" + "11".repeat(32), quote: { amountTokenAtomic: "10000" }, execution: { businessStatus: "SUCCESS", chainStatus: "CONFIRMED", businessTxHash: "0x" + "22".repeat(32) }, decision: { decision: "NO_POLICY_VIOLATION" }, durationMs: 31000 };
    db.prepare("INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)").run("r-old", "APPROVED_PAYMENT", "DONE", "[]", '["LIVE_REQUEST"]', ts(100), ts(100), "c", JSON.stringify(result));
    db.prepare("INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)").run("r-new", "CHANGED_IMPLEMENTATION", "RUNNING", "[]", '["LIVE_REQUEST"]', ts(1), ts(1), "c", null);
    const { listRuns } = await import("../src/demo.js");
    const page = listRuns(db, 1, 0);
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 0 }); expect(page.runs[0]).toMatchObject({ runId: "r-new", passportAvailable: false, feeTokenAtomic: null, businessPaidNativeAtomic: "0" });
    expect(listRuns(db, 1, 1).runs[0]).toMatchObject({ runId: "r-old", network: "testnet", chainId: 5042002, feeTokenAtomic: "10000", orderAmountNativeAtomic: "50000000000000000", businessPaidNativeAtomic: "50000000000000000", passportAvailable: true, decision: "NO_POLICY_VIOLATION" });
  });
});

describe("testnet faucet (budgeted, testnet only)", () => {
  const RAW_F = (`0x02${"fa".repeat(60)}`) as `0x${string}`; const HASH_F = keccak256(RAW_F);
  const addr = (d: string) => ("0x" + d.repeat(40)) as `0x${string}`;
  const claimRow = (a: string) => db.prepare("SELECT tx_hash FROM faucet_claims WHERE address = ?").get(a.toLowerCase());
  beforeEach(() => { mocks.receipt.mockResolvedValue({ status: "success", blockNumber: 5n }); mocks.balance.mockResolvedValue(5n * 10n ** 18n); mocks.nonce.mockResolvedValue(9); });
  it("sends one claim per wallet and per client every 24 h from the order-creator key, keeps the reservation when the send fails, and reports its status", async () => {
    const { claimFaucet, faucetInfo } = await import("../src/demo.js");
    const a = addr("4");
    expect(faucetInfo(db)).toMatchObject({ enabled: true, amountNativeAtomic: "200000000000000000", usedToday: 0 });
    expect(await claimFaucet(db, a, "ip-1")).toEqual({ ok: true, txHash: HASH_F, amountNativeAtomic: "200000000000000000", address: a });
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({ to: a, value: 200000000000000000n, nonce: 9, gas: 25_200n })); // signed locally: explicit nonce, estimate × 1.2
    expect(mocks.walletSend).toHaveBeenCalledWith({ serializedTransaction: RAW_F });
    expect(mocks.sendNative).not.toHaveBeenCalled(); // never sign-and-send in one call: the hash is on the claim before the broadcast
    expect(claimRow(a)).toMatchObject({ tx_hash: HASH_F });
    expect(await claimFaucet(db, a, "ip-2")).toMatchObject({ ok: false, status: 429, error: "FAUCET_COOLDOWN" }); // same wallet
    expect(await claimFaucet(db, addr("5"), "ip-1")).toMatchObject({ ok: false, status: 429, error: "FAUCET_COOLDOWN" }); // same client
    mocks.estimate.mockRejectedValueOnce(new Error("rpc unavailable")); // fails before anything is signed
    expect(await claimFaucet(db, addr("6"), "ip-3")).toMatchObject({ ok: false, status: 503, error: "FAUCET_FAILED", reason: expect.stringContaining("nothing was sent") });
    expect(await claimFaucet(db, addr("6"), "ip-3")).toMatchObject({ ok: false, status: 429 }); // the failed claim still counts: no retry storm
    expect(faucetInfo(db)).toMatchObject({ usedToday: 2 });
    mocks.balance.mockResolvedValueOnce(10n ** 17n); // the faucet key is below its floor
    expect(await claimFaucet(db, addr("7"), "ip-4")).toMatchObject({ ok: false, status: 503, error: "FAUCET_EMPTY" });
  });
  it("a refused send gets the identical bytes again; an unacknowledged one is 'sent, not yet confirmed' with its recorded hash; an outright refusal says nothing was sent (2026-10-09)", async () => {
    const { claimFaucet } = await import("../src/demo.js");
    const REFUSED = 'The method "eth_sendRawTransaction" does not exist / is not available.';
    mocks.walletSend.mockRejectedValueOnce(new Error(REFUSED)); // refused once, then taken
    expect(await claimFaucet(db, addr("8"), "ip-5")).toEqual({ ok: true, txHash: HASH_F, amountNativeAtomic: "200000000000000000", address: addr("8") });
    expect(mocks.walletSend.mock.calls.map((c: any[]) => c[0].serializedTransaction)).toEqual([RAW_F, RAW_F]); expect(mocks.sign).toHaveBeenCalledTimes(1);
    mocks.walletSend.mockReset().mockRejectedValue(new Error("socket hang up")); mocks.sign.mockClear();
    expect(await claimFaucet(db, addr("9"), "ip-6")).toMatchObject({ ok: true, pending: true, txHash: HASH_F, note: expect.stringMatching(/^sent, not yet confirmed/) });
    expect(mocks.walletSend).toHaveBeenCalledTimes(3); expect(mocks.sign).toHaveBeenCalledTimes(1); // one claim, one signature
    expect(claimRow(addr("9"))).toMatchObject({ tx_hash: HASH_F });
    expect(await claimFaucet(db, addr("9"), "ip-6")).toMatchObject({ ok: false, status: 429 }); // never a second transfer for the same wallet
    mocks.walletSend.mockReset().mockRejectedValue(new Error("insufficient funds for gas * price + value"));
    expect(await claimFaucet(db, addr("a"), "ip-7")).toMatchObject({ ok: false, status: 503, error: "FAUCET_FAILED", reason: expect.stringContaining("nothing was sent") });
    expect(mocks.walletSend).toHaveBeenCalledTimes(1); expect(claimRow(addr("a"))).toMatchObject({ tx_hash: null });
    mocks.walletSend.mockReset().mockImplementation(async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) => keccak256(serializedTransaction));
    mocks.receipt.mockRejectedValueOnce(new Error("Timed out while waiting for transaction"));
    expect(await claimFaucet(db, addr("b"), "ip-8")).toMatchObject({ ok: true, pending: true, txHash: HASH_F, note: expect.stringContaining("no receipt within the wait") });
  });
});

describe("order creation outcomes once the identity is recorded, recovery and the published RPC (2026-10-09)", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ident = (d: string) => ({ orderId: ("0x" + d.repeat(32)) as `0x${string}`, raw: (`0x02${d.repeat(80)}`) as `0x${string}` });
  /** the store sequence of the real createOrder up to the broadcast, then `then` decides how it ends */
  const recordedThen = (id: { orderId: `0x${string}`; raw: `0x${string}` }, then: () => never, nonce = 5) => mocks.order.mockImplementation(async (_o: any, payer: string, amount: bigint, store: any) => {
    await store.planned({ orderId: id.orderId, payer, amountNativeAtomic: amount.toString(), merchant: mocks.merchant });
    await store.sent({ orderId: id.orderId, tx: keccak256(id.raw), raw: id.raw, nonce, from: mocks.payer });
    return then();
  });
  it("an unacknowledged creation is the pending order with its recorded identity; the row keeps the signed bytes, the answer never carries them", async () => {
    const id = ident("a1");
    recordedThen(id, () => { throw new OrderCreationPending(id.orderId, keccak256(id.raw), 'the node did not confirm taking the creation transaction (The method "eth_sendRawTransaction" does not exist / is not available.)'); });
    const r = await createOrderFor(db, ORDER_IN("client-p"));
    expect(r).toMatchObject({ ok: true, pending: true, status: 202, orderId: id.orderId, state: "SENT", tx: keccak256(id.raw), nextAction: expect.stringContaining("approval stays closed"), reason: expect.stringContaining("eth_sendRawTransaction") });
    expect(JSON.stringify(r)).not.toContain(id.raw.slice(2, 60));
    expect(db.prepare("SELECT state, tx_hash, raw_tx, tx_nonce FROM orders WHERE order_id = ?").get(id.orderId)).toMatchObject({ state: "SENT", tx_hash: keccak256(id.raw), raw_tx: id.raw, tx_nonce: 5 });
    expect(mocks.order.mock.calls[0][0]).toMatchObject({ adminLock: expect.any(Function), orderReceiptTimeoutMs: 30_000 }); // the single-sender lock around nonce → send; a bounded receipt wait
  });
  it("a creation that was never sent, or that reverted, is ORDER_CREATION_FAILED naming the order", async () => {
    const n = ident("b2");
    mocks.order.mockImplementation(async (_o: any, payer: string, amount: bigint, store: any) => {
      await store.planned({ orderId: n.orderId, payer, amountNativeAtomic: amount.toString(), merchant: mocks.merchant });
      const reason = "the creation transaction was not signed or not recorded (signer unavailable); nothing was sent";
      await store.notSent({ orderId: n.orderId, reason }); throw new OrderCreationNotSent(n.orderId, reason);
    });
    expect(await createOrderFor(db, ORDER_IN("client-n"))).toMatchObject({ ok: false, status: 502, error: "ORDER_CREATION_FAILED", orderId: n.orderId, state: "FAILED", tx: null, reason: expect.stringContaining("nothing was sent") });
    const v = ident("c3");
    recordedThen(v, () => { throw new Error(`createOrder failed: ${keccak256(v.raw)}`); });
    expect(await createOrderFor(db, ORDER_IN("client-v"))).toMatchObject({ ok: false, status: 502, error: "ORDER_CREATION_FAILED", orderId: v.orderId, state: "FAILED", tx: keccak256(v.raw), reason: expect.stringContaining("reverted") });
  });
  it("recover: owner only, one per order every 3 s, hands the node the identical signed creation; a read never sends; the worker may", async () => {
    const id = ident("d4");
    recordedThen(id, () => { throw new OrderCreationPending(id.orderId, keccak256(id.raw), "the node did not confirm taking the creation transaction"); });
    await createOrderFor(db, ORDER_IN("client-r"));
    mocks.read.mockResolvedValue([ZERO, 0n, false, 0n, 0n]); mocks.nonce.mockResolvedValue(5); mocks.tx.mockResolvedValue(null); // not on chain, nonce 5 still free, not in the pool
    const { recoverOrder, getOrder, reconcileOrderCreations } = await import("../src/demo.js");
    expect(await getOrder(db, "visitor:client-r", id.orderId)).toMatchObject({ state: "SENT", paid: null });
    expect(mocks.walletSend).not.toHaveBeenCalled(); // GET observes only
    expect(await recoverOrder(db, "visitor:someone-else", id.orderId)).toMatchObject({ ok: false, status: 404 });
    const rec = await recoverOrder(db, "visitor:client-r", id.orderId);
    expect(rec).toMatchObject({ ok: true, order: { orderId: id.orderId, state: "SENT", tx: keccak256(id.raw), paid: null, note: expect.stringContaining("identical signed creation") } });
    expect(mocks.walletSend).toHaveBeenCalledWith({ serializedTransaction: id.raw }); expect(mocks.sign).not.toHaveBeenCalled(); // nothing re-signed
    expect(JSON.stringify(rec)).not.toContain(id.raw.slice(2, 60));
    expect(await recoverOrder(db, "visitor:client-r", id.orderId)).toMatchObject({ ok: false, status: 429, error: "RATE_LIMITED" });
    mocks.walletSend.mockClear(); await reconcileOrderCreations(db);
    expect(mocks.walletSend).toHaveBeenCalledTimes(1);
    mocks.read.mockResolvedValue([mocks.payer, 50_000_000_000_000_000n, false, 0n, 0n]); mocks.walletSend.mockClear(); // now on chain
    await reconcileOrderCreations(db);
    expect(mocks.walletSend).not.toHaveBeenCalled(); expect(db.prepare("SELECT state FROM orders WHERE order_id = ?").get(id.orderId)).toMatchObject({ state: "CONFIRMED" });
  });
  it("network info publishes the network's public RPC, never the operator's own endpoint", async () => {
    const info = await networkInfo(db);
    expect(info.rpc).toBe("https://rpc.public.invalid"); expect(info.rpc).not.toBe("http://offline.invalid");
  });
});

describe("Gate D: readiness apart from the public gate, and the order creation's gas cap", () => {
  it("network info reports executionReady (deployments, order signer, runner) independently of the gate, and operatorAcceptance while public execution is closed", async () => {
    const { cfg } = await import("../src/config.js");
    const open = (await networkInfo(db)).access as any;
    expect(open).toMatchObject({ publicExecution: true, walletExecution: true, executionReady: true, operatorAcceptance: false });
    (cfg as any).publicExecution = false;
    try {
      const gated = (await networkInfo(db)).access as any;
      expect(gated).toMatchObject({ publicExecution: false, walletExecution: false, executionReady: true, operatorAcceptance: true }); // ready for the operator's acceptance, closed to the public
    } finally { (cfg as any).publicExecution = true; }
  });
  it("both order-creation paths hand the per-transaction cap to createOrder", async () => {
    await createOrderFor(db, ORDER_IN("client-cap"));
    expect(mocks.order.mock.calls[0][0]).toMatchObject({ maxOrderGasCostNativeAtomic: demoBudget.gasCeilingPerOrderAtomic });
    expect(await startRun(db, "APPROVED_PAYMENT", "client-run", "admission-cap-0000001")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(mocks.fixture).toHaveBeenCalled());
    expect(mocks.fixture.mock.calls[0][0]).toMatchObject({ maxOrderGasCostNativeAtomic: demoBudget.gasCeilingPerOrderAtomic });
    finishRun.resolve({ execution: { chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED" } });
  });
  it("a creation refused by the gas cap answers GAS_CAP_EXCEEDED and leaves no order row claiming a send", async () => {
    // the real createOrder refuses before store.planned: nothing is persisted, nothing is sent
    mocks.order.mockReset().mockRejectedValueOnce(new Error("createOrder refused: worst-case gas cost 12000000000000000 (gas limit 60000 × maxFeePerGas 200000000000) exceeds the per-transaction cap 6000000000000000; nothing was persisted or sent"));
    const r = await createOrderFor(db, ORDER_IN("client-spike"));
    expect(r).toMatchObject({ ok: false, status: 503, error: "GAS_CAP_EXCEEDED", reason: expect.stringContaining("exceeds the per-transaction cap") });
    expect(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE client_key = ?").get("client-spike")).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE state IN ('PLANNED','SENT')").get()).toMatchObject({ c: 0 });
  });
});
