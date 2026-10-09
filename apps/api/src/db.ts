import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY, principal TEXT NOT NULL, client_request_id TEXT NOT NULL,
      intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(principal, client_request_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      report_digest TEXT PRIMARY KEY, request_id TEXT, subject TEXT NOT NULL, mode TEXT NOT NULL, report_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quotes (
      request_id TEXT PRIMARY KEY, quote_json TEXT NOT NULL, quote_digest TEXT NOT NULL, report_digest TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      request_id TEXT PRIMARY KEY, payment_identifier TEXT NOT NULL UNIQUE, network TEXT NOT NULL, asset TEXT NOT NULL,
      payer TEXT NOT NULL, auth_nonce TEXT NOT NULL, state TEXT NOT NULL, facilitator_payment_id TEXT, tx_hash TEXT,
      last_response_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      settle_payload_encrypted TEXT, quote_digest TEXT, report_digest TEXT, settle_lease_owner TEXT, settle_lease_until INTEGER,
      backend TEXT, relay_nonce INTEGER, relay_raw_tx_encrypted TEXT, created_block INTEGER, scanned_to_block INTEGER, settlement_evidence_json TEXT,
      UNIQUE(network, asset, payer, auth_nonce)
    );
    CREATE TABLE IF NOT EXISTS baselines (
      baseline_digest TEXT PRIMARY KEY, subject TEXT NOT NULL, baseline_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (principal TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(principal, day));
    CREATE TABLE IF NOT EXISTS demo_runs (
      run_id TEXT PRIMARY KEY, fixture TEXT NOT NULL, state TEXT NOT NULL, steps_json TEXT NOT NULL, labels_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, client_key TEXT, result_json TEXT
    );
    CREATE TABLE IF NOT EXISTS demo_orders (
      order_id TEXT PRIMARY KEY, payer TEXT NOT NULL, merchant TEXT NOT NULL, amount_atomic TEXT NOT NULL, tx_hash TEXT NOT NULL, block TEXT NOT NULL,
      client_key TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS budget (key TEXT PRIMARY KEY, window_start TEXT NOT NULL, used_atomic TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_run_admissions (client_run_request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, fixture TEXT NOT NULL, client_key TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY, owner TEXT, client_key TEXT, source TEXT NOT NULL, run_id TEXT,
      payer TEXT NOT NULL, merchant TEXT NOT NULL, proxy TEXT, amount_atomic TEXT NOT NULL, reference TEXT,
      state TEXT NOT NULL, tx_hash TEXT, block TEXT, from_addr TEXT, gas_used TEXT, effective_gas_price TEXT,
      paid INTEGER, paid_checked_at TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_owner ON orders(owner, created_at);
    CREATE TABLE IF NOT EXISTS wallet_attempts (
      attempt_id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_key TEXT, request_id TEXT NOT NULL, order_id TEXT NOT NULL, merchant TEXT NOT NULL, payer TEXT NOT NULL, amount_atomic TEXT NOT NULL,
      intent_digest TEXT NOT NULL, report_digest TEXT NOT NULL, decision_digest TEXT NOT NULL, baseline_digest TEXT NOT NULL, policy_digest TEXT NOT NULL, final_validation_digest TEXT, plan_digest TEXT,
      policy_json TEXT NOT NULL, decision_json TEXT NOT NULL, final_validation_json TEXT, fv_evidence_json TEXT, approval_status_json TEXT, plan_json TEXT, labels_json TEXT NOT NULL,
      state TEXT NOT NULL, valid_until TEXT, tx_hash TEXT, nonce INTEGER, from_addr TEXT, broadcast_block TEXT, scanned_to_block TEXT, deviations_json TEXT,
      business_status TEXT, business_tx_hash TEXT, block TEXT, receipt_json TEXT, postcondition_json TEXT, note TEXT, reconciliation_json TEXT NOT NULL DEFAULT '[]', refusal_json TEXT,
      fee_receipt_json TEXT, prompt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wallet_attempts_owner ON wallet_attempts(owner, created_at);
    CREATE INDEX IF NOT EXISTS wallet_attempts_order ON wallet_attempts(order_id);
    CREATE TABLE IF NOT EXISTS business_executions (
      attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, fixture TEXT NOT NULL, order_id TEXT NOT NULL, merchant TEXT NOT NULL, payer TEXT NOT NULL, amount_atomic TEXT NOT NULL,
      intent_digest TEXT NOT NULL, report_digest TEXT NOT NULL, decision_digest TEXT NOT NULL, baseline_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
      final_validation_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, raw_tx_encrypted TEXT NOT NULL, valid_until TEXT NOT NULL, labels_json TEXT NOT NULL,
      state TEXT NOT NULL, business_status TEXT, business_tx_hash TEXT, block TEXT, postcondition_json TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      broadcast_block TEXT, consumed_by TEXT
    );
  `);
  // additive migrations for databases created by earlier releases
  for (const sql of ["ALTER TABLE demo_runs ADD COLUMN client_key TEXT", "ALTER TABLE demo_runs ADD COLUMN result_json TEXT",
    "ALTER TABLE payments ADD COLUMN settle_payload_encrypted TEXT", "ALTER TABLE payments ADD COLUMN quote_digest TEXT",
    "ALTER TABLE payments ADD COLUMN report_digest TEXT", "ALTER TABLE payments ADD COLUMN settle_lease_owner TEXT",
    "ALTER TABLE payments ADD COLUMN settle_lease_until INTEGER",
    // settlement backend per row: NULL/'circle' = settled through the hosted facilitator (legacy), 'relay' = self-relayed EIP-3009
    "ALTER TABLE payments ADD COLUMN backend TEXT", "ALTER TABLE payments ADD COLUMN relay_nonce INTEGER", "ALTER TABLE payments ADD COLUMN relay_raw_tx_encrypted TEXT",
    "ALTER TABLE payments ADD COLUMN created_block INTEGER", "ALTER TABLE payments ADD COLUMN scanned_to_block INTEGER", "ALTER TABLE payments ADD COLUMN settlement_evidence_json TEXT",
    // v3.2: head block at the broadcast marker (bounds the nonce-consumer search) and the transaction that consumed the nonce
    "ALTER TABLE business_executions ADD COLUMN broadcast_block TEXT", "ALTER TABLE business_executions ADD COLUMN consumed_by TEXT",
    // v3.3: every artefact persisted as soon as it exists (a run that stops after the broadcast still exports a complete passport)
    "ALTER TABLE demo_runs ADD COLUMN artifacts_json TEXT",
    // review round 2: the fee relay receipt facts, so a wallet attempt's cost statement is complete on the operator side too
    "ALTER TABLE wallet_attempts ADD COLUMN fee_receipt_json TEXT",
    // review round 3: the wallet-prompt marker that keeps submission uncertainty across a page refresh
    "ALTER TABLE wallet_attempts ADD COLUMN prompt_json TEXT"]) {
    try { db.exec(sql); } catch (e: any) { if (!/duplicate column/i.test(String(e?.message ?? e))) throw e; }
  }
  // v3.3: orders created by earlier releases were written only after their receipt; carry them over as CONFIRMED (the pre-v3.3 table stays)
  db.exec(`INSERT OR IGNORE INTO orders (order_id, owner, client_key, source, run_id, payer, merchant, proxy, amount_atomic, reference, state, tx_hash, block, note, created_at, updated_at)
    SELECT order_id, NULL, client_key, 'developer', NULL, payer, merchant, NULL, amount_atomic, NULL, 'CONFIRMED', tx_hash, block, 'carried over from the pre-v3.3 order table', created_at, created_at FROM demo_orders`);
  // Demo runs interrupted by a restart (spec D07): a signed business transaction whose broadcast marker was written MAY be on the
  // network → the run waits for reconciliation from its original context. A transaction signed but never marked for broadcast was
  // never sent → the run failed before any money moved. Runs without a signed business transaction simply failed.
  const ts = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.exec(`UPDATE demo_runs SET state = 'RECONCILE_REQUIRED', updated_at = ${ts} WHERE state = 'RUNNING' AND run_id IN (SELECT run_id FROM business_executions WHERE state IN ('BROADCAST_ATTEMPTED','CONFIRMED','REVERTED','NOT_MINED','SUPERSEDED'))`);
  // one open wallet attempt per order, enforced by the database even under concurrent requests (review round 2)
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS wallet_attempts_one_open ON wallet_attempts(order_id) WHERE state IN ('VALIDATED','BROADCAST_ATTEMPTED')");
  db.exec(`UPDATE business_executions SET state = 'INTERRUPTED', business_status = 'NOT_EXECUTED', note = 'process stopped after signing and before any broadcast; nothing was sent', updated_at = ${ts} WHERE state = 'SIGNED'`);
  db.exec(`UPDATE demo_runs SET state = 'FAILED', steps_json = json_insert(steps_json, '$[#]', json('{"step":"interruptedBeforeBroadcast","atMs":-1,"why":"the process stopped after signing and before any broadcast; nothing reached the network and the order stays unpaid"}')), updated_at = ${ts} WHERE state = 'RUNNING' AND run_id IN (SELECT run_id FROM business_executions WHERE state = 'INTERRUPTED')`);
  db.exec(`UPDATE demo_runs SET state = 'FAILED', steps_json = json_insert(steps_json, '$[#]', json('{"step":"interrupted","atMs":-1,"why":"the process stopped before any business transaction was signed; nothing reached the network (a paid check fee, if any, is reconciled by the payments path)"}')), updated_at = ${ts} WHERE state = 'RUNNING'`);
  return db;
}
export type Db = ReturnType<typeof openDb>;
export const now = () => new Date().toISOString();
export const row = <T = any>(db: Db, sql: string, ...params: any[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
export const rows = <T = any>(db: Db, sql: string, ...params: any[]): T[] => db.prepare(sql).all(...params) as T[];
export const run = (db: Db, sql: string, ...params: any[]) => db.prepare(sql).run(...params);
