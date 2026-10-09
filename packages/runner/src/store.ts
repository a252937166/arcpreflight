// Durable execution store for the CLI runner (spec D07 / design v3.2 §15): the signed business transaction and its context are
// persisted BEFORE any broadcast, encrypted at rest, and reconciled from this record after a restart. The API keeps its own
// store in its database; both hand `StoredExecution` rows to the shared `reconcileExecution`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { ExecutionStore, ExecutionOutcome, SignedExecution, OrderStore } from "./index.js";
import type { StoredExecution, ReconcileClosedState } from "./reconcile.js";
import type { OrderReconciliation, PlannedOrder } from "./orders.js";

export type StoredRunRow = { run_key: string; fixture: string; attempt_id: string | null; created_at: string; updated_at: string };
export type StoredOrderRow = { order_id: string; merchant: string; payer: string; amount_atomic: string; state: string; tx_hash: string | null; block: string | null; from_addr: string | null; gas_used: string | null; effective_gas_price: string | null; note: string | null; created_at: string; updated_at: string };

export type Sealer = { seal: (obj: unknown) => Promise<string>; open: (s: string) => Promise<any> };
const now = () => new Date().toISOString();

/** AES-256-GCM over a caller-supplied 32-byte key. The CLI derives the key from a deterministic, domain-separated signature of
 *  the runner key (see `sealerFromSigner`), so the raw bytes are unreadable without that key. */
export function makeSealer(key: Buffer): Sealer {
  if (key.length !== 32) throw new Error("sealer key must be 32 bytes");
  return {
    seal: async (obj) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]); return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }); },
    open: async (s) => { const e = JSON.parse(s); if (e.version !== 1) throw new Error("unsupported sealed payload version"); const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64")); return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8")); },
  };
}
export async function sealerFromSigner(signer: { address: string; signMessage: (a: { message: string }) => Promise<Hex> }, chainId: number): Promise<Sealer> {
  const sig = await signer.signMessage({ message: `ArcPreflight execution store v1\n${chainId}\n${signer.address.toLowerCase()}` });
  return makeSealer(createHash("sha256").update(sig).digest());
}

export type StoreRow = {
  attempt_id: string; label: string | null; fixture: string; order_id: string; merchant: string; payer: string; amount_atomic: string;
  intent_digest: string; report_digest: string; decision_digest: string; baseline_digest: string; policy_digest: string; final_validation_digest: string; plan_digest: string;
  tx_hash: string; nonce: number; raw_tx_encrypted: string; valid_until: string; labels_json: string; broadcast_block: string | null;
  state: string; business_status: string | null; business_tx_hash: string | null; block: string | null; postcondition_json: string | null; note: string | null; consumed_by: string | null;
  closed_by: string | null; created_at: string; updated_at: string;
};

export class SqliteExecutionStore implements ExecutionStore {
  constructor(readonly db: DatabaseSync, private readonly sealer: Sealer, private readonly label: string | null = null) {
    db.exec(`CREATE TABLE IF NOT EXISTS executions (
      attempt_id TEXT PRIMARY KEY, label TEXT, fixture TEXT NOT NULL, order_id TEXT NOT NULL, merchant TEXT NOT NULL, payer TEXT NOT NULL, amount_atomic TEXT NOT NULL,
      intent_digest TEXT NOT NULL, report_digest TEXT NOT NULL, decision_digest TEXT NOT NULL, baseline_digest TEXT NOT NULL, policy_digest TEXT NOT NULL,
      final_validation_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, nonce INTEGER NOT NULL, raw_tx_encrypted TEXT NOT NULL, valid_until TEXT NOT NULL, labels_json TEXT NOT NULL,
      broadcast_block TEXT, state TEXT NOT NULL, business_status TEXT, business_tx_hash TEXT, block TEXT, postcondition_json TEXT, note TEXT, consumed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // review round 3 §8: every artefact as the run produces it, and the step log, keyed by the run — a crash after the broadcast
    // keeps the inputs a complete passport needs, not only the payment state
    db.exec(`CREATE TABLE IF NOT EXISTS runs (run_key TEXT PRIMARY KEY, fixture TEXT NOT NULL, attempt_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS artifacts (run_key TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (run_key, name))`);
    db.exec(`CREATE TABLE IF NOT EXISTS run_steps (run_key TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_key, seq))`);
    try { db.exec("ALTER TABLE executions ADD COLUMN closed_by TEXT"); } catch { /* exists */ }
    // design v3.3 §2: the order's identity is durable before its creation transaction is sent (PLANNED → SENT → CONFIRMED)
    db.exec(`CREATE TABLE IF NOT EXISTS orders (order_id TEXT PRIMARY KEY, merchant TEXT NOT NULL, payer TEXT NOT NULL, amount_atomic TEXT NOT NULL, state TEXT NOT NULL, tx_hash TEXT, block TEXT,
      from_addr TEXT, gas_used TEXT, effective_gas_price TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  /** Progressive evidence for one run: `onArtifact` and `onStep` callbacks for `runFixture`; the attempt id is learned from the execution artefact. */
  beginRun(runKey: string, fixture: string): { onArtifact: (name: string, value: unknown) => void; onStep: (s: { step: string; atMs: number }) => void } {
    this.db.prepare("INSERT OR IGNORE INTO runs (run_key, fixture, created_at, updated_at) VALUES (?,?,?,?)").run(runKey, fixture, now(), now());
    let seq = 0;
    return {
      onArtifact: (name, value) => {
        this.db.prepare("INSERT INTO artifacts (run_key, name, json, updated_at) VALUES (?,?,?,?) ON CONFLICT(run_key, name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(runKey, name, JSON.stringify(value), now());
        const attemptId = name === "execution" ? (value as any)?.executionAttemptId : null;
        if (attemptId) this.db.prepare("UPDATE runs SET attempt_id = ?, updated_at = ? WHERE run_key = ?").run(String(attemptId), now(), runKey);
      },
      onStep: (s) => { this.db.prepare("INSERT OR REPLACE INTO run_steps (run_key, seq, json) VALUES (?,?,?)").run(runKey, seq++, JSON.stringify(s)); },
    };
  }
  runByAttempt(attemptId: string): StoredRunRow | undefined { return (this.db.prepare("SELECT * FROM runs WHERE attempt_id = ? OR run_key = ?").get(attemptId, attemptId) as StoredRunRow | undefined); }
  listRuns(limit = 50): (StoredRunRow & { artifacts: number })[] { return this.db.prepare("SELECT r.*, (SELECT COUNT(*) FROM artifacts a WHERE a.run_key = r.run_key) AS artifacts FROM runs r ORDER BY created_at DESC LIMIT ?").all(limit) as any; }
  artifactsOf(runKey: string): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const r of this.db.prepare("SELECT name, json FROM artifacts WHERE run_key = ?").all(runKey) as any[]) out[r.name] = JSON.parse(r.json); return out; }
  stepsOf(runKey: string): { step: string; atMs: number; [k: string]: unknown }[] { return (this.db.prepare("SELECT json FROM run_steps WHERE run_key = ? ORDER BY seq").all(runKey) as any[]).map((r) => JSON.parse(r.json)); }
  /** the runner's OrderStore over this database */
  orderStore(): OrderStore {
    return {
      planned: (o) => { this.db.prepare("INSERT INTO orders (order_id, merchant, payer, amount_atomic, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(o.orderId.toLowerCase(), o.merchant.toLowerCase(), o.payer.toLowerCase(), o.amountNativeAtomic, "PLANNED", now(), now()); },
      sent: (o) => { this.db.prepare("UPDATE orders SET state = 'SENT', tx_hash = ?, updated_at = ? WHERE order_id = ? AND state = 'PLANNED'").run(o.tx.toLowerCase(), now(), o.orderId.toLowerCase()); },
      confirmed: (o) => { this.db.prepare("UPDATE orders SET state = 'CONFIRMED', tx_hash = COALESCE(?, tx_hash), block = ?, from_addr = ?, gas_used = ?, effective_gas_price = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')").run(o.tx?.toLowerCase() ?? null, o.block, o.from?.toLowerCase() ?? null, o.gasUsed, o.effectiveGasPriceNativeAtomic, now(), o.orderId.toLowerCase()); },
    };
  }
  listOpenOrders(): PlannedOrder[] {
    return (this.db.prepare("SELECT * FROM orders WHERE state IN ('PLANNED','SENT') ORDER BY created_at").all() as unknown as StoredOrderRow[]).map((r) => ({ orderId: r.order_id as Hex, merchant: r.merchant as Hex, txHash: (r.tx_hash as Hex | null) ?? null, createdAt: r.created_at }));
  }
  listOrders(limit = 50): StoredOrderRow[] { return this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as StoredOrderRow[]; }
  /** applies what `reconcilePlannedOrder` established; a pending result changes nothing */
  applyOrderReconciliation(orderId: Hex, r: OrderReconciliation) {
    if (r.kind === "confirmed") this.db.prepare("UPDATE orders SET state = 'CONFIRMED', tx_hash = COALESCE(?, tx_hash), block = COALESCE(?, block), from_addr = ?, gas_used = ?, effective_gas_price = ?, note = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')").run(r.tx?.toLowerCase() ?? null, r.block, r.from?.toLowerCase() ?? null, r.gasUsed, r.effectiveGasPriceNativeAtomic, r.note, now(), orderId.toLowerCase());
    else if (r.kind === "failed") this.db.prepare("UPDATE orders SET state = 'FAILED', note = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')").run(r.note, now(), orderId.toLowerCase());
    else if (r.kind === "unknown") this.db.prepare("UPDATE orders SET state = 'UNKNOWN_CREATION', note = ?, updated_at = ? WHERE order_id = ? AND state IN ('PLANNED','SENT')").run(r.note, now(), orderId.toLowerCase());
  }
  async persistSigned(e: SignedExecution) {
    this.db.prepare("INSERT INTO executions (attempt_id, label, fixture, order_id, merchant, payer, amount_atomic, intent_digest, report_digest, decision_digest, baseline_digest, policy_digest, final_validation_digest, plan_digest, tx_hash, nonce, raw_tx_encrypted, valid_until, labels_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(e.attemptId, this.label, e.fixture, e.orderId.toLowerCase(), e.merchant.toLowerCase(), e.payer.toLowerCase(), e.amountNativeAtomic, e.intentDigest, e.reportDigest, e.decisionDigest, e.baselineDigest, e.policyDigest, e.finalValidationDigest, e.transactionPlanDigest, e.txHash.toLowerCase(), e.nonce, await this.sealer.seal({ raw: e.raw }), e.validUntil, JSON.stringify(e.labels), "SIGNED", now(), now());
  }
  markBroadcastAttempted(attemptId: string, info?: { headBlock: string | null }) {
    this.db.prepare("UPDATE executions SET state = 'BROADCAST_ATTEMPTED', broadcast_block = ?, updated_at = ? WHERE attempt_id = ? AND state = 'SIGNED'").run(info?.headBlock ?? null, now(), attemptId);
  }
  persistOutcome(attemptId: string, o: ExecutionOutcome) {
    const state = o.chainStatus === "CONFIRMED" || o.chainStatus === "REVERTED" ? o.chainStatus : o.chainStatus === "SIGNED_NOT_BROADCAST" ? "NOT_BROADCAST" : "BROADCAST_ATTEMPTED";
    this.db.prepare("UPDATE executions SET state = ?, business_status = ?, business_tx_hash = ?, block = ?, postcondition_json = ?, note = ?, closed_by = 'run', updated_at = ? WHERE attempt_id = ?")
      .run(state, o.businessStatus, o.businessTxHash?.toLowerCase() ?? null, o.block ?? null, o.postcondition ? JSON.stringify(o.postcondition) : null, o.note ?? null, now(), attemptId);
  }
  /** Rows the reconciler must look at after a restart. */
  listOpen(): StoreRow[] { return this.db.prepare("SELECT * FROM executions WHERE state IN ('SIGNED','BROADCAST_ATTEMPTED') ORDER BY created_at").all() as unknown as StoreRow[]; }
  get(attemptId: string): StoreRow | undefined { return this.db.prepare("SELECT * FROM executions WHERE attempt_id = ?").get(attemptId) as StoreRow | undefined; }
  list(limit = 50): StoreRow[] { return this.db.prepare("SELECT * FROM executions ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as StoreRow[]; }
  toStored(r: StoreRow): StoredExecution {
    return { attemptId: r.attempt_id, state: r.state as "SIGNED" | "BROADCAST_ATTEMPTED", txHash: r.tx_hash as Hex, nonce: Number(r.nonce), payer: r.payer as Hex, merchant: r.merchant as Hex, orderId: r.order_id as Hex,
      amountNativeAtomic: r.amount_atomic, validUntil: r.valid_until, broadcastBlock: r.broadcast_block, openRaw: async () => (await this.sealer.open(r.raw_tx_encrypted)).raw as Hex };
  }
  close(attemptId: string, storeState: ReconcileClosedState, o: ExecutionOutcome, consumedBy: Hex | null) {
    this.db.prepare("UPDATE executions SET state = ?, business_status = ?, business_tx_hash = ?, block = ?, postcondition_json = ?, note = ?, consumed_by = ?, closed_by = 'reconcile', updated_at = ? WHERE attempt_id = ?")
      .run(storeState, o.businessStatus, o.businessTxHash?.toLowerCase() ?? null, o.block ?? null, o.postcondition ? JSON.stringify(o.postcondition) : null, o.note ?? null, consumedBy?.toLowerCase() ?? null, now(), attemptId);
  }
  note(attemptId: string, text: string) { this.db.prepare("UPDATE executions SET note = ?, updated_at = ? WHERE attempt_id = ?").run(text, now(), attemptId); }
}
export const openStoreDb = (path: string) => new DatabaseSync(path);
