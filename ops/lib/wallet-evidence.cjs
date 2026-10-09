// Read-only dump of what the API recorded for one payer (run on the server by ops/wallet-evidence.sh). No secrets: session tokens,
// encrypted payloads and claim ids are never selected or are removed.
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
const p = String(process.env.PAYER || "").toLowerCase(), since = String(process.env.SINCE || "");
const q = (sql, ...a) => db.prepare(sql).all(...a);
const out = {
  instance: process.env.INSTANCE, network: process.env.ARC_NET, release: process.env.RELEASE_SHA, payer: p, since, readAt: new Date().toISOString(),
  orders: q("SELECT order_id, source, proxy, merchant, amount_atomic, reference, state, tx_hash, block, note, created_at, updated_at FROM orders WHERE lower(payer) = ? AND created_at >= ? ORDER BY created_at", p, since),
  payments: q("SELECT request_id, backend, state, tx_hash, created_at, updated_at FROM payments WHERE lower(payer) = ? AND created_at >= ? ORDER BY created_at", p, since),
  attempts: q("SELECT attempt_id, order_id, request_id, state, business_status, business_tx_hash, json_extract(decision_json, '$.decision') AS decision, valid_until, prompt_json, tx_hash, nonce, broadcast_block, deviations_json, note, created_at, updated_at FROM wallet_attempts WHERE lower(payer) = ? AND created_at >= ? ORDER BY created_at", p, since),
};
for (const a of out.attempts) { if (a.prompt_json) { const m = JSON.parse(a.prompt_json); delete m.claimId; a.prompt = m; } delete a.prompt_json; }
process.stdout.write(JSON.stringify(out, null, 2));
