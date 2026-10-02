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
  `);
  // additive migrations for databases created by earlier releases
  for (const sql of ["ALTER TABLE demo_runs ADD COLUMN client_key TEXT", "ALTER TABLE demo_runs ADD COLUMN result_json TEXT"]) {
    try { db.exec(sql); } catch (e: any) { if (!/duplicate column/i.test(String(e?.message ?? e))) throw e; }
  }
  // demo runs interrupted by a restart can never finish
  db.exec("UPDATE demo_runs SET state = 'FAILED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state = 'RUNNING'");
  return db;
}
export type Db = ReturnType<typeof openDb>;
export const now = () => new Date().toISOString();
export const row = <T = any>(db: Db, sql: string, ...params: any[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
export const rows = <T = any>(db: Db, sql: string, ...params: any[]): T[] => db.prepare(sql).all(...params) as T[];
export const run = (db: Db, sql: string, ...params: any[]) => db.prepare(sql).run(...params);
