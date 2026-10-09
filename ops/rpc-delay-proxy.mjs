#!/usr/bin/env node
// Delaying JSON-RPC proxy for the delayed chain-RPC acceptance scenario (AP33-30, checklist row 11). It sits between a client (the API
// server, or a wallet extension's custom RPC URL) and the real Arc RPC, and makes the CHAIN RPC slow: per-method delays, and receipts
// held back (answered `null`, i.e. "not mined yet") for a while after a transaction is first seen. Nothing is invented or altered: every
// answer that is not held is the upstream's answer. Refuses Arc mainnet unless ALLOW_MAINNET=1. No dependencies.
//   UPSTREAM=https://rpc.testnet.arc.io PORT=8549 HOST=127.0.0.1 node ops/rpc-delay-proxy.mjs
// Env:
//   DELAY_MS                      added to every call (default 0)
//   DELAY_<METHOD>_MS             per method, e.g. DELAY_ETH_SENDRAWTRANSACTION_MS=4000, DELAY_ETH_CALL_MS=1500
//   HOLD_RECEIPT_MS               eth_getTransactionReceipt answers null until this long after the hash was first seen (sent through
//                                 this proxy, or first asked for); default 0
//   HOLD_TO=0xA,0xB  HOLD_TO_MS   a longer hold for transactions to these addresses (looked up once per hash)
//   HOLD_SELECTOR=0x8609cad1 HOLD_SELECTOR_MS   a longer hold for transactions whose calldata starts with this selector (e.g. the
//                                 DemoMerchant pay call), so order creation and fee relays are not held while payments are
//   LOG=0                         silence the per-call log
import { createServer } from "node:http";

const UPSTREAM = process.env.UPSTREAM ?? "https://rpc.testnet.arc.io";
const PORT = Number(process.env.PORT ?? 8549), HOST = process.env.HOST ?? "127.0.0.1";
const DELAY_ALL = Number(process.env.DELAY_MS ?? 0);
const HOLD_MS = Number(process.env.HOLD_RECEIPT_MS ?? 0);
const HOLD_TO = new Set((process.env.HOLD_TO ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
const HOLD_TO_MS = Number(process.env.HOLD_TO_MS ?? HOLD_MS);
const HOLD_SELECTOR = (process.env.HOLD_SELECTOR ?? "").toLowerCase();
const HOLD_SELECTOR_MS = Number(process.env.HOLD_SELECTOR_MS ?? HOLD_MS);
const LOG = process.env.LOG !== "0";
const firstSeen = new Map(); // tx hash → ms
const toOf = new Map(); // tx hash → { to, input } (lower-case)
const stats = { calls: 0, held: 0, delayedMs: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delayFor = (method) => DELAY_ALL + Number(process.env[`DELAY_${String(method).toUpperCase()}_MS`] ?? 0);
const log = (...a) => { if (LOG) console.log(new Date().toISOString(), ...a); };

async function upstream(body) {
  const r = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return r.json();
}
async function holdFor(hash) {
  if (!HOLD_TO.size && !HOLD_SELECTOR) return HOLD_MS;
  if (!toOf.has(hash)) { try { const t = await upstream({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }); if (!t?.result) return HOLD_MS; toOf.set(hash, { to: String(t.result.to ?? "").toLowerCase(), input: String(t.result.input ?? "").toLowerCase() }); } catch { return HOLD_MS; } }
  const tx = toOf.get(hash);
  if (HOLD_SELECTOR && tx.input.startsWith(HOLD_SELECTOR)) return HOLD_SELECTOR_MS;
  return HOLD_TO.has(tx.to) ? HOLD_TO_MS : HOLD_MS;
}
async function one(req) {
  stats.calls++;
  const method = req?.method, d = delayFor(method);
  if (d > 0) { stats.delayedMs += d; await sleep(d); }
  if (method === "eth_getTransactionReceipt" && Array.isArray(req.params) && typeof req.params[0] === "string") {
    const hash = req.params[0].toLowerCase();
    if (!firstSeen.has(hash)) firstSeen.set(hash, Date.now());
    const hold = await holdFor(hash), age = Date.now() - firstSeen.get(hash);
    if (age < hold) { stats.held++; log(`HOLD receipt ${hash.slice(0, 12)}… ${Math.ceil((hold - age) / 1000)} s left`); return { jsonrpc: "2.0", id: req.id, result: null }; }
  }
  const res = await upstream(req);
  if (method === "eth_sendRawTransaction" && typeof res?.result === "string") { const h = res.result.toLowerCase(); if (!firstSeen.has(h)) firstSeen.set(h, Date.now()); log(`SEND ${h.slice(0, 12)}… after ${d} ms delay`); }
  else if (d > 0) log(`${method} +${d} ms`);
  return res;
}

const chain = await upstream({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }).then((r) => parseInt(r.result, 16)).catch(() => null);
if (chain === null) { console.error(`upstream ${UPSTREAM} did not answer eth_chainId`); process.exit(1); }
if (chain === 5042 && process.env.ALLOW_MAINNET !== "1") { console.error("refusing: the upstream is Arc mainnet (5042); this proxy is for the testnet acceptance scenario"); process.exit(1); }
createServer(async (req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET" && req.url === "/stats") { res.writeHead(200, { "content-type": "application/json", ...cors }); return res.end(JSON.stringify({ upstream: UPSTREAM, chain, ...stats, tracked: firstSeen.size })); }
  if (req.method !== "POST") { res.writeHead(405, cors); return res.end(); }
  let raw = ""; for await (const c of req) raw += c;
  try {
    const body = JSON.parse(raw);
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    res.writeHead(200, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(out));
  } catch (e) { res.writeHead(502, { "content-type": "application/json", ...cors }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `proxy: ${String(e?.message ?? e)}` } })); }
}).listen(PORT, HOST, () => console.log(`rpc-delay-proxy on http://${HOST}:${PORT} → ${UPSTREAM} (chain ${chain}) · delay ${DELAY_ALL} ms + per method · receipt hold ${HOLD_MS} ms${HOLD_TO.size ? ` (${HOLD_TO_MS} ms for ${[...HOLD_TO].join(",")})` : ""}${HOLD_SELECTOR ? ` (${HOLD_SELECTOR_MS} ms for calls ${HOLD_SELECTOR})` : ""}`));
