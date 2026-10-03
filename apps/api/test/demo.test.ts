import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  balance: vi.fn(), fixture: vi.fn(), order: vi.fn(),
  payer: "0x3333333333333333333333333333333333333333",
  merchant: "0x2222222222222222222222222222222222222222",
}));
vi.mock("../src/config.js", () => ({ cfg: {
  root: "/offline/demo-regression", net: "testnet", chainId: 5042002, caip2: "eip155:5042002", rpc: "http://offline.invalid",
  principals: new Map([["offline", "demo-runner"]]), port: 4040, releaseSha: "test", profile: "SUBMISSION_RESTRICTED",
  usdc: mocks.merchant, supportedTargets: [mocks.merchant], priceTokenAtomic: "10000", merchant: { address: mocks.merchant },
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
  createPublicClient: () => ({ getBalance: mocks.balance }), createWalletClient: () => ({}),
}));
vi.mock("@arcpreflight/runner", () => ({ runFixture: mocks.fixture, createOrder: mocks.order }));
import { createOrderFor, demoBudget, demoState, startRun } from "../src/demo.js";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
let db: ReturnType<typeof openDb>;
let finishRun: ReturnType<typeof deferred<any>>;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO baselines VALUES (?,?,?,?,?)").run("0x" + "11".repeat(32), mocks.merchant, "{}", 0, new Date().toISOString());
  demoBudget.maxRunsPerDay = 40; demoBudget.clientCooldownSeconds = 45;
  mocks.balance.mockReset().mockResolvedValue(10n ** 18n);
  finishRun = deferred(); mocks.fixture.mockReset().mockImplementation(() => finishRun.promise);
  mocks.order.mockReset().mockResolvedValue({ orderId: "0x" + "aa".repeat(32), tx: "0x" + "bb".repeat(32), block: "100" });
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
    const first = createOrderFor(db, mocks.payer as `0x${string}`, "client-a");
    const second = await createOrderFor(db, mocks.payer as `0x${string}`, "client-b");
    expect(second).toMatchObject({ ok: false, error: "DEMO_BUDGET_EXHAUSTED" });
    order.resolve({ orderId: "0x" + "aa".repeat(32), tx: "0x" + "bb".repeat(32), block: "100" });
    expect(await first).toMatchObject({ ok: true });
    expect(mocks.order).toHaveBeenCalledTimes(1);
  });

  it("keeps developer-order cooldown when the RPC fails after admission", async () => {
    mocks.order.mockRejectedValueOnce(new Error("receipt timeout"));
    await expect(createOrderFor(db, mocks.payer as `0x${string}`, "client-a")).rejects.toThrow("receipt timeout");
    expect(await createOrderFor(db, mocks.payer as `0x${string}`, "client-a")).toMatchObject({ ok: false, error: "DEMO_COOLDOWN" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_order_admissions").get()).toMatchObject({ c: 1 });
  });

  it("rolls back both order writes if admission linking fails, retaining only one reservation", async () => {
    db.exec("CREATE TABLE demo_order_admissions (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, client_key TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TRIGGER reject_link BEFORE UPDATE OF order_id ON demo_order_admissions BEGIN SELECT RAISE(ABORT, 'injected linkage failure'); END");
    await expect(createOrderFor(db, mocks.payer as `0x${string}`, "client-a")).rejects.toThrow("injected linkage failure");
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_orders").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM demo_order_admissions").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT order_id FROM demo_order_admissions").get()).toMatchObject({ order_id: null });
  });
});
