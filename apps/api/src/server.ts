import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { IntentCore, intentDigest as computeIntentDigest, BaselineCore, baselineDigest as computeBaselineDigest } from "@arcpreflight/schema";
import { checkBaselineStatus } from "@arcpreflight/policy";
import { cfg } from "./config.js";
import { openDb, row, rows, run, now, type Db } from "./db.js";
import { principalOf as configuredPrincipalOf, sessionPrincipalOf, createSession, isAdmin } from "./auth.js";
const principalOf = (req: IncomingMessage) => configuredPrincipalOf(req) ?? sessionPrincipalOf(db, req);
import { buildObjectReport, buildIntentReport, client } from "./report.js";
import { makeQuote, paymentRequirementsFor, paymentMatchesQuote, settleForRequest, reconcilePending, settlementStatus, resumeSettlements, beginSettlementResume, reconcileOpenPayments, type PaymentInput } from "./payments.js";
import { fundsPass, FUNDS_CHECK_INTERVAL_MS } from "./funds.js";
import { evidenceManifest, publishedEvidence } from "./evidence.js";
import { networkInfo, startRun, getRun, listRuns, createOrderFor, listOrders, getOrder, recoverOrder, reconcileOrderCreations, chainClient, clientKey, reconcileExecutions, observeExecutions, recoverRun, claimFaucet, faucetInfo, FIXTURES, projectAccounts } from "./demo.js";
import { parseOrderInput } from "./orders.js";
import { createWalletAttempt, markSent, markPrompted, abandonAttempt, observeAttempt, recoverAttempt, listAttempts, buildWalletPassport, reconcileWalletAttempts, backfillFeeReceipts, walletRpcFromClient } from "./wallet.js";
import { curatedSubjects, isCuratedSubject } from "./subjects.js";
import { buildRunPassport, buildCheckPassport } from "./passport.js";

export const db: Db = openDb(cfg.dbPath);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-admin-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-arcpreflight-release": cfg.releaseSha, ...CORS, ...headers });
  res.end(s);
};
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const objectCache = new Map<string, { at: number; body: unknown }>();
const preflightLocks = new Map<string, Promise<void>>();
async function withPreflightLock<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  const previous = preflightLocks.get(requestId) ?? Promise.resolve();
  const pending = previous.then(fn);
  const queue = pending.then(() => {}, () => {});
  preflightLocks.set(requestId, queue);
  try { return await pending; }
  finally { if (preflightLocks.get(requestId) === queue) preflightLocks.delete(requestId); }
}
let lastReady: { at: number; body: unknown } | null = null;
// Public object observation costs RPC reads: a small per-client and global fixed-window limiter (no auth on that route).
const subjectHits = new Map<string, { win: number; n: number }>();
function subjectAllowed(client: string): boolean {
  const win = Math.floor(Date.now() / 60_000);
  const bump = (k: string, max: number) => { const e = subjectHits.get(k); if (!e || e.win !== win) { subjectHits.set(k, { win, n: 1 }); return true; } e.n++; return e.n <= max; };
  if (subjectHits.size > 5000) subjectHits.clear();
  return bump(`c:${client}`, 12) && bump("global", 90);
}

function usageOk(principal: string): boolean {
  const day = now().slice(0, 10);
  const r = row(db, "SELECT count FROM usage WHERE principal = ? AND day = ?", principal, day);
  const c = (r?.count ?? 0) + 1;
  if (c > cfg.maxPreflightPerPrincipalPerDay) return false;
  run(db, "INSERT INTO usage (principal, day, count) VALUES (?,?,?) ON CONFLICT(principal, day) DO UPDATE SET count = ?", principal, day, c, c);
  return true;
}

const ADMISSION_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const clientIp = (req: IncomingMessage) => { const xf = req.headers["x-forwarded-for"]; const s = Array.isArray(xf) ? xf[0] : xf; return (s?.split(",")[0].trim()) || req.socket.remoteAddress || undefined; };

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  let m: RegExpExecArray | null;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (req.method === "GET" && path === "/health/live") return json(res, 200, { ok: true, release: cfg.releaseSha, profile: cfg.profile, network: cfg.caip2 });
    // Public: network + fixture facts, demo runs (budgeted live runs by the project's own runner), evidence index
    if (req.method === "GET" && path === "/v1/network") return json(res, 200, await networkInfo(db));
    if (req.method === "GET" && path === "/v1/demo/runs") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100), offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
      return json(res, 200, listRuns(db, limit, offset));
    }
    if (req.method === "GET" && (m = /^\/v1\/demo\/runs\/([0-9a-f-]{36})$/.exec(path))) {
      let r = getRun(db, m[1]);
      // read route: refresh chain facts (receipt, order state, nonce) for an unresolved attempt, but never broadcast anything (v3.2 §10.2)
      if (r?.state === "RECONCILE_REQUIRED") { await observeExecutions(db, m[1]).catch(() => {}); r = getRun(db, m[1]); }
      return r ? json(res, 200, r) : json(res, 404, { error: "NOT_FOUND" });
    }
    if (req.method === "GET" && (m = /^\/v1\/demo\/runs\/([0-9a-f-]{36})\/passport$/.exec(path))) { // read-only export (design v3.2 §13)
      const r = await buildRunPassport(db, m[1]);
      if (!r.ok) return json(res, r.status, { error: r.error, reason: r.reason });
      return json(res, 200, r.bundle, { "content-disposition": `attachment; filename="arcpreflight-passport-${m[1].slice(0, 8)}.json"` });
    }
    if (req.method === "POST" && (m = /^\/v1\/demo\/runs\/([0-9a-f-]{36})\/recover$/.exec(path))) {
      const body = await readJson(req);
      const key = typeof body.clientRunRequestId === "string" ? body.clientRunRequestId : "";
      if (!ADMISSION_KEY.test(key)) return json(res, 400, { error: "INVALID_INPUT", reason: "the clientRunRequestId of the admission is required" });
      const r = await recoverRun(db, m[1], key, (msg) => console.log(now(), "EXECUTION", msg));
      return r ? json(res, 200, r) : json(res, 404, { error: "NOT_FOUND" }); // a wrong key reads like a missing run: no existence leak
    }
    if (req.method === "POST" && path === "/v1/demo/run") {
      // the gate is checked before the body is read or validated (Gate D): a probe with an empty body answers 503 while gated and 400 when open — it can never start a run
      if (!cfg.publicExecution && !isAdmin(req)) return json(res, 503, { error: "EXECUTION_GATED", reason: "business execution on this instance is gated until the operator records the mainnet acceptance; recorded runs, checks, orders and passports stay available", sampleRunId: null });
      const body = await readJson(req);
      const fixture = String(body.fixture ?? "");
      if (!Object.hasOwn(FIXTURES, fixture)) return json(res, 400, { error: "INVALID_INPUT", reason: `fixture must be one of ${Object.keys(FIXTURES).join(", ")}` });
      const key = typeof body.clientRunRequestId === "string" ? body.clientRunRequestId : "";
      if (!ADMISSION_KEY.test(key)) return json(res, 400, { error: "INVALID_INPUT", reason: "clientRunRequestId (16-128 chars of [A-Za-z0-9._-]) is required: it binds this admission so that a lost response returns the same run instead of starting another" });
      if (body.interruptAfterBroadcast !== undefined && typeof body.interruptAfterBroadcast !== "boolean") return json(res, 400, { error: "INVALID_INPUT", reason: "interruptAfterBroadcast must be a boolean" });
      // v3.3 labelled interruption: the runner persists, marks and sends as always, then stops waiting; recovery establishes the outcome
      const r = await startRun(db, fixture as keyof typeof FIXTURES, clientKey(clientIp(req), req.headers["user-agent"]), key, { interruptAfterBroadcast: body.interruptAfterBroadcast === true });
      if (r.ok) return json(res, r.existing ? 200 : 202, { runId: r.runId, poll: `/v1/demo/runs/${r.runId}`, admission: r.existing ? "existing" : "new" });
      return json(res, r.status, { error: r.error, reason: r.reason, sampleRunId: r.sample ?? null });
    }
    if (req.method === "POST" && path === "/v1/session") { // open self-service: an anonymous session for this browser (no registration, no token to paste)
      const r = createSession(db, clientKey(clientIp(req), req.headers["user-agent"]));
      return r.ok ? json(res, 201, { principal: r.principal, token: r.token, note: "keep this token in your browser; it owns the checks you buy with it (recovery, history, private passports)" }) : json(res, r.status, { error: r.error, reason: r.reason });
    }
    if (req.method === "GET" && path === "/v1/faucet") return json(res, 200, faucetInfo(db));
    if (req.method === "POST" && path === "/v1/faucet") { // testnet only (404 elsewhere); budgeted; the site offers it when a connected wallet has no funds
      const body = await readJson(req);
      if (!isAddress(String(body.address ?? ""))) return json(res, 400, { error: "INVALID_INPUT", reason: "address must be a 20-byte address" });
      const r = await claimFaucet(db, getAddress(body.address) as Hex, clientKey(clientIp(req), req.headers["user-agent"]));
      // 202: the claim's one transaction is signed, recorded and handed to the node, but not confirmed ("sent, not yet confirmed", with its hash)
      return r.ok ? json(res, r.pending ? 202 : 200, r) : json(res, r.status, { error: r.error, reason: r.reason, ...(r.txHash ? { txHash: r.txHash } : {}) });
    }
    if (req.method === "POST" && path === "/v1/demo/orders") { // v3.3: the visitor's order (payer, proxy, amount, reference), identity durable before the send
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED", hint: "POST /v1/session gives any visitor a bearer token" });
      // Gate D: creating an order is a transaction the project pays for; while execution is closed nobody could pay it through the service,
      // so the order route is gated with the execution routes (the operator's admin token passes), before the body is read
      if (!cfg.publicExecution && !isAdmin(req)) return json(res, 503, { error: "EXECUTION_GATED", reason: "order creation on this instance is gated until the operator records the mainnet acceptance; checks, recovery and passports stay available" });
      const body = await readJson(req);
      const parsed = parseOrderInput(body, isAddress, getAddress);
      if (!parsed.ok) return json(res, 400, { error: "INVALID_INPUT", field: parsed.field, reason: parsed.reason });
      const r = await createOrderFor(db, { ...parsed.value, owner: principal, client: clientKey(clientIp(req), req.headers["user-agent"]) });
      // a failure after the identity was recorded names the order (orderId, state, tx): the visitor's view must never read "nothing was changed"
      if (!r.ok) return json(res, r.status, { error: r.error, reason: r.reason, ...(r.orderId ? { orderId: r.orderId, state: r.state, tx: r.tx ?? null } : {}) });
      if (r.pending) { const { ok: _ok, status: _status, ...body } = r; return json(res, 202, { error: "ORDER_CREATION_PENDING", code: "ORDER_CREATION_PENDING", ...body }); }
      return json(res, 201, r);
    }
    if (req.method === "POST" && (m = /^\/v1\/demo\/orders\/(0x[0-9a-fA-F]{64})\/recover$/.exec(path))) { // owner only; at most one per order every 3 s
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const r = await recoverOrder(db, principal, m[1].toLowerCase());
      return r.ok ? json(res, 200, r.order) : json(res, r.status, { error: r.error, reason: r.reason });
    }
    if (req.method === "GET" && path === "/v1/demo/orders") { // the owner's orders with their live paid state, linked checks and attempts
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
      return json(res, 200, await listOrders(db, principal, limit));
    }
    if (req.method === "GET" && (m = /^\/v1\/demo\/orders\/(0x[0-9a-fA-F]{64})$/.exec(path))) {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const o = await getOrder(db, principal, m[1].toLowerCase());
      return o ? json(res, 200, o) : json(res, 404, { error: "NOT_FOUND" });
    }
    // ---- wallet execution (design v3.3 §3): the visitor's wallet signs; the service validates, records and reconciles; it never sends
    if (req.method === "POST" && path === "/v1/wallet/attempts") {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED", hint: "POST /v1/session gives any visitor a bearer token" });
      if (!cfg.publicExecution && !isAdmin(req)) return json(res, 503, { error: "EXECUTION_GATED", reason: "wallet execution on this instance is gated until the operator records the mainnet acceptance; checks, orders, recovery and passports stay available" });
      const body = await readJson(req);
      const r = await createWalletAttempt(db, principal, clientKey(clientIp(req), req.headers["user-agent"]), body);
      return r.ok ? json(res, r.status, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason, reasons: r.reasons ?? null, attemptId: r.attemptId ?? null });
    }
    if (req.method === "GET" && path === "/v1/wallet/attempts") {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
      return json(res, 200, { attempts: listAttempts(db, principal, limit) });
    }
    if ((m = /^\/v1\/wallet\/attempts\/([0-9a-f-]{36})(?:\/(sent|prompt|abandon|recover|passport))?$/.exec(path))) {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const id = m[1], action = m[2] ?? null;
      if (req.method === "GET" && !action) { const r = await observeAttempt(db, principal, id); return r.ok ? json(res, 200, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason }); }
      if (req.method === "GET" && action === "passport") {
        const r = await buildWalletPassport(db, id, principal);
        if (!r.ok) return json(res, r.status, { error: r.error, reason: r.reason });
        return json(res, 200, r.bundle, { "content-disposition": `attachment; filename="arcpreflight-wallet-passport-${id.slice(0, 8)}.json"` });
      }
      if (req.method === "POST" && action === "sent") { const body = await readJson(req); const r = await markSent(db, principal, id, String(body.txHash ?? "")); return r.ok ? json(res, 200, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason }); }
      if (req.method === "POST" && action === "prompt") { const body = await readJson(req); const r = markPrompted(db, principal, id, body); return r.ok ? json(res, 200, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason, ...(r.attempt ? { attempt: r.attempt } : {}) }); }
      if (req.method === "POST" && action === "abandon") { const r = abandonAttempt(db, principal, id); return r.ok ? json(res, 200, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason }); }
      if (req.method === "POST" && action === "recover") { const r = await recoverAttempt(db, principal, id, undefined, (msg) => console.log(now(), "WALLET", msg)); return r.ok ? json(res, 200, r.attempt) : json(res, r.status, { error: r.error, reason: r.reason }); }
      return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    }
    if (req.method === "GET" && path === "/v1/public-reports") {
      const list = rows(db, "SELECT report_digest, subject, mode, created_at FROM reports WHERE is_public = 1 ORDER BY created_at DESC LIMIT 50");
      return json(res, 200, { reports: list.map((r: any) => ({ reportDigest: r.report_digest, subject: r.subject, mode: r.mode, createdAt: r.created_at })) });
    }
    if (req.method === "GET" && path === "/v1/evidence") return json(res, 200, { files: evidenceManifest(cfg.root) });
    if (req.method === "GET" && (m = /^\/v1\/evidence\/(.+)$/.exec(path))) {
      // audit 2026-10-10 (API-01): only a path in the publish manifest, decoded once, is read — and only from inside the evidence root's real path
      let rel: string; try { rel = decodeURIComponent(m[1]); } catch { return json(res, 404, { error: "NOT_FOUND" }); }
      const f = publishedEvidence(cfg.root, rel);
      if (!f) return json(res, 404, { error: "NOT_FOUND" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60", ...CORS }); return res.end(f);
    }
    if (req.method === "GET" && path === "/health/ready") {
      if (lastReady && Date.now() - lastReady.at < 10_000) return json(res, 200, lastReady.body);
      const deps: Record<string, unknown> = {};
      try { const t = Date.now(); const bn = await Promise.race([client.getBlockNumber(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), 4000))]); deps.rpc = { ok: true, head: bn.toString(), ms: Date.now() - t }; } catch (e: any) { deps.rpc = { ok: false, error: String(e?.message ?? e) }; }
      try { row(db, "SELECT 1"); deps.db = { ok: true }; } catch (e: any) { deps.db = { ok: false, error: String(e?.message ?? e) }; }
      deps.merchantConfigured = !!cfg.merchant; deps.supportedTargets = cfg.supportedTargets.length;
      // fee settlement is self-relayed; a paused relayer stops new paid checks but not the public, read-only routes
      try { deps.settlement = await Promise.race([settlementStatus(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("settlement probe timeout")), 4000))]); }
      catch (e: any) { deps.settlement = { backend: "relay", paused: true, error: String(e?.message ?? e) }; }
      const degraded = !(deps.rpc as any).ok || !(deps.db as any).ok;
      const settlementPaused = !!(deps.settlement as any)?.paused;
      const body = { ready: !degraded, state: degraded ? "degraded" : settlementPaused ? "paused" : "ok", settlementPaused, release: cfg.releaseSha, profile: cfg.profile, network: cfg.caip2, deps, checkedAt: now() };
      lastReady = { at: Date.now(), body };
      return json(res, degraded ? 503 : 200, body);
    }
    if (req.method === "GET" && path === "/openapi.json") return json(res, 200, openapi());

    // Public object observation (never decision-eligible), curated samples only: every accepted request stores a public report
    if (req.method === "GET" && (m = /^\/v1\/subjects\/(0x[0-9a-fA-F]{40})$/.exec(path))) {
      const addr = getAddress(m[1]) as Hex;
      if (!isCuratedSubject(addr)) return json(res, 422, { error: "UNSUPPORTED_SUBJECT", reason: "this release observes a curated list of public samples only", curated: curatedSubjects() });
      const c = objectCache.get(addr.toLowerCase());
      if (c && Date.now() - c.at < 30_000) return json(res, 200, c.body);
      if (!subjectAllowed(clientKey(clientIp(req), req.headers["user-agent"]))) return json(res, 429, { error: "RATE_LIMITED", reason: "object observation is limited to 12 new subjects per minute per client" });
      const built = await buildObjectReport(addr);
      run(db, "INSERT OR IGNORE INTO reports (report_digest, request_id, subject, mode, report_json, evidence_json, is_public, created_at) VALUES (?,?,?,?,?,?,?,?)",
        built.digest, null, addr.toLowerCase(), "OBJECT_OBSERVATION", JSON.stringify(built.report), JSON.stringify(built.evidence), 1, now());
      const body = { reportDigest: built.digest, report: built.report, supported: cfg.supportedTargets.includes(addr.toLowerCase()), evidenceCount: built.evidence.length };
      objectCache.set(addr.toLowerCase(), { at: Date.now(), body });
      return json(res, 200, body);
    }
    if (req.method === "GET" && (m = /^\/v1\/public-reports\/(0x[0-9a-f]{64})$/.exec(path))) {
      const r = row(db, "SELECT * FROM reports WHERE report_digest = ? AND is_public = 1", m[1]);
      if (!r) return json(res, 404, { error: "NOT_FOUND" });
      return json(res, 200, { reportDigest: r.report_digest, report: JSON.parse(r.report_json), evidence: JSON.parse(r.evidence_json) });
    }

    // Authenticated approval lookup: callers validate scope, digest, expiry and current revocation locally.
    if (req.method === "GET" && (m = /^\/v1\/baselines\/(0x[0-9a-f]{64})$/.exec(path))) {
      if (!principalOf(req)) return json(res, 401, { error: "UNAUTHENTICATED" });
      const b = row(db, "SELECT * FROM baselines WHERE baseline_digest = ?", m[1]);
      if (!b) return json(res, 404, { error: "NOT_FOUND" });
      return json(res, 200, { baselineDigest: b.baseline_digest, baseline: BaselineCore.parse(JSON.parse(b.baseline_json)), revoked: !!b.revoked });
    }

    // Admin: approve a baseline for a supported target (internal; token-gated)
    if (req.method === "POST" && path === "/v1/admin/baselines") {
      if (!isAdmin(req)) return json(res, 403, { error: "FORBIDDEN" });
      const body = await readJson(req);
      const baseline = BaselineCore.parse(body.baseline);
      const d = computeBaselineDigest(baseline);
      run(db, "INSERT OR IGNORE INTO baselines (baseline_digest, subject, baseline_json, revoked, created_at) VALUES (?,?,?,?,?)", d, baseline.subject.toLowerCase(), JSON.stringify(baseline), 0, now());
      return json(res, 201, { baselineDigest: d });
    }
    if (req.method === "POST" && (m = /^\/v1\/admin\/baselines\/(0x[0-9a-f]{64})\/revoke$/.exec(path))) {
      if (!isAdmin(req)) return json(res, 403, { error: "FORBIDDEN" });
      run(db, "UPDATE baselines SET revoked = 1 WHERE baseline_digest = ?", m[1]);
      return json(res, 200, { revoked: m[1] });
    }

    // Private: supported-intent preflight (x402). Restricted profile: only configured principals.
    if (req.method === "POST" && path === "/v1/preflight") {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED", hint: "POST /v1/session gives any visitor a bearer token; configured principals may use their own" });
      const body = await readJson(req);
      const parsed = IntentCore.safeParse(body.intent);
      if (!parsed.success) return json(res, 400, { error: "INVALID_INPUT", issues: parsed.error.issues.slice(0, 10) });
      const intent = parsed.data;
      if (intent.chainId !== cfg.chainId) return json(res, 400, { error: "INVALID_INPUT", reason: `chainId must be ${cfg.chainId}` });
      if (!cfg.supportedTargets.includes(intent.to.toLowerCase())) return json(res, 422, { error: "UNSUPPORTED_TARGET", supportedTargets: cfg.supportedTargets });
      if (intent.businessExpectation.action !== "MERCHANT_PAY") return json(res, 422, { error: "UNSUPPORTED_ACTION", reason: "USDC transfer path is disabled in this release" });
      const iDigest = computeIntentDigest(intent);
      let reqRow = row(db, "SELECT * FROM requests WHERE principal = ? AND client_request_id = ?", principal, intent.clientRequestId);
      if (reqRow && reqRow.intent_digest !== iDigest) return json(res, 409, { error: "REQUEST_CONFLICT", reason: "clientRequestId already bound to a different intent" });
      if (!reqRow) {
        if (!usageOk(principal)) return json(res, 429, { error: "RATE_LIMITED" });
        const requestId = randomUUID();
        run(db, "INSERT INTO requests (request_id, principal, client_request_id, intent_json, intent_digest, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
          requestId, principal, intent.clientRequestId, JSON.stringify(intent), iDigest, "PREPARING", now(), now());
        reqRow = row(db, "SELECT * FROM requests WHERE request_id = ?", requestId);
      }
      const requestId = reqRow.request_id as string;
      return await withPreflightLock(requestId, async () => {
      const resourceUrl = `${cfg.publicBaseUrl}/v1/preflight`;
      // Baseline lookup (by digest the intent references; must be for this subject and not revoked)
      const bRow = row(db, "SELECT * FROM baselines WHERE baseline_digest = ?", intent.baselineDigest);
      const baseline = bRow ? BaselineCore.parse(JSON.parse(bRow.baseline_json)) : null;
      const baselineStatus = checkBaselineStatus({ intent, baseline, baselineDigest: bRow?.baseline_digest ?? null, baselineRevoked: !!bRow?.revoked, now: new Date() });
      // Quote: prepare report once; reuse while the quote is valid
      let q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
      let existingPayment = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
      if (existingPayment && !body.payment) return await recover(req, res, requestId, principal);
      if (!existingPayment && body.payment && (!q || new Date(q.expires_at).getTime() <= Date.now())) {
        return json(res, 409, { requestId, error: "QUOTE_EXPIRED", reason: "obtain a current quote before signing a service-fee authorization" });
      }
      let reportDigestStr: string;
      if (!q || (!existingPayment && new Date(q.expires_at) < new Date())) {
        if (existingPayment) throw new Error("the original payment quote is unavailable");
        const built = await buildIntentReport(intent, iDigest as Hex, baselineStatus.outcome === "PASS" ? baseline : null, baseline ? (bRow.baseline_digest as Hex) : null);
        run(db, "INSERT OR IGNORE INTO reports (report_digest, request_id, subject, mode, report_json, evidence_json, is_public, created_at) VALUES (?,?,?,?,?,?,?,?)",
          built.digest, requestId, intent.to.toLowerCase(), "SUPPORTED_INTENT", JSON.stringify(built.report), JSON.stringify({ evidence: built.evidence, simulation: built.simulation, baselineRevoked: !!bRow?.revoked }), 0, now());
        const { quote, digest: qd } = makeQuote(requestId, principal, intent, iDigest, built.digest, built.digest);
        run(db, "INSERT INTO quotes (request_id, quote_json, quote_digest, report_digest, expires_at, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET quote_json = excluded.quote_json, quote_digest = excluded.quote_digest, report_digest = excluded.report_digest, expires_at = excluded.expires_at, created_at = excluded.created_at WHERE quotes.expires_at <= excluded.created_at AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.request_id = quotes.request_id)",
          requestId, JSON.stringify(quote), qd, built.digest, quote.expiresAt, now());
        run(db, "UPDATE requests SET state = 'WAITING_PAYMENT', updated_at = ? WHERE request_id = ? AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.request_id = requests.request_id)", now(), requestId);
        q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
        existingPayment = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
        if (existingPayment && !body.payment) return await recover(req, res, requestId, principal);
      }
      const quote = JSON.parse(q.quote_json);
      reportDigestStr = q.report_digest;
      if (!body.payment) {
        const prepared = row(db, "SELECT report_json FROM reports WHERE report_digest = ?", reportDigestStr);
        const obs = prepared ? JSON.parse(prepared.report_json).observation : null;
        return json(res, 402, { requestId, quote, quoteDigest: q.quote_digest, reportDigest: reportDigestStr, pinnedBlock: obs?.blockNumber ?? null, observedAt: obs?.observedAt ?? null,
          paymentRequirements: paymentRequirementsFor(quote, resourceUrl), note: "Report is prepared and pinned; pay exactly this quote to receive it." });
      }
      const p: PaymentInput = body.payment;
      const mismatch = paymentMatchesQuote(p, quote, intent, !!existingPayment);
      if (mismatch) return json(res, 400, { error: "PAYMENT_MISMATCH", reason: mismatch });
      const s = await settleForRequest(db, requestId, quote, intent, p, resourceUrl);
      if ("conflict" in s) return json(res, 409, { error: "PAYMENT_CONFLICT", reason: s.conflict });
      if ("paused" in s) return json(res, 503, { requestId, error: "SETTLEMENT_PAUSED", reason: s.paused, retryAfterSeconds: 60, note: "no authorization was stored; obtain a fresh quote and pay again later" }, { "retry-after": "60" });
      if (s.state === "COMPLETED") {
        run(db, "UPDATE requests SET state = 'DELIVERED', updated_at = ? WHERE request_id = ?", now(), requestId);
        const r = row(db, "SELECT * FROM reports WHERE report_digest = ?", reportDigestStr);
        const ev = JSON.parse(r.evidence_json);
        return json(res, 200, { requestId, delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: s.txHash, paymentId: s.paymentId, backend: s.backend, evidence: s.evidence }, reportDigest: reportDigestStr, report: JSON.parse(r.report_json), evidence: ev.evidence, simulation: ev.simulation });
      }
      if (s.state === "PENDING" || s.state === "SUBMITTED") return json(res, 202, { requestId, payment: { state: s.state, paymentId: s.paymentId, backend: s.backend, transaction: s.txHash, reason: s.reason ?? null }, reportDigest: reportDigestStr, note: "settlement not yet confirmed; recover the original request via GET /v1/requests/{requestId} with the same credentials" });
      return json(res, 402, { requestId, error: "PAYMENT_FAILED", payment: { state: s.state, reason: s.reason, httpStatus: s.httpStatus, backend: s.backend, transaction: s.txHash }, quote });
      });
    }
    if (req.method === "GET" && path === "/v1/requests") { // the owner's check history: read-only, owner-scoped, nothing is reconciled here
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
      const list = rows(db, "SELECT r.request_id, r.client_request_id, r.state, r.created_at, r.updated_at, r.intent_digest, r.intent_json, q.report_digest, p.state AS pay_state, p.backend, p.tx_hash, p.last_response_json FROM requests r LEFT JOIN quotes q ON q.request_id = r.request_id LEFT JOIN payments p ON p.request_id = r.request_id WHERE r.principal = ? ORDER BY r.created_at DESC LIMIT ?", principal, limit);
      return json(res, 200, { requests: list.map((r: any) => { const intent = JSON.parse(r.intent_json); return { requestId: r.request_id, clientRequestId: r.client_request_id, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, intentDigest: r.intent_digest, subject: intent.to, orderId: intent.businessExpectation?.orderId ?? null, valueNativeAtomic: intent.valueNativeAtomic, reportDigest: r.report_digest ?? null,
        payment: r.pay_state ? { state: r.pay_state, backend: r.backend === "relay" ? "relay" : "circle", transaction: r.tx_hash ?? null, reason: (() => { try { return JSON.parse(r.last_response_json ?? "null")?.reason ?? null; } catch { return null; } })() } : null, passportAvailable: r.pay_state === "COMPLETED" && !!r.report_digest }; }) });
    }
    if (req.method === "GET" && (m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(path))) {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      return await recover(req, res, m[1], principal, false); // read route: observe only, never a broadcast
    }
    if (req.method === "GET" && (m = /^\/v1\/requests\/([0-9a-f-]{36})\/passport$/.exec(path))) { // the owner's private passport of a paid check
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      const r = await buildCheckPassport(db, m[1], principal);
      if (!r.ok) return json(res, r.status, { error: r.error, reason: r.reason });
      return json(res, 200, r.bundle, { "content-disposition": `attachment; filename="arcpreflight-check-passport-${m[1].slice(0, 8)}.json"` });
    }
    if (req.method === "POST" && (m = /^\/v1\/requests\/([0-9a-f-]{36})\/recover$/.exec(path))) {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      return await recover(req, res, m[1], principal, true); // authenticated recovery command: the already accepted authorization may be (re)sent
    }
    return json(res, 404, { error: "NOT_FOUND" });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/payload too large/.test(msg)) return json(res, 413, { error: "PAYLOAD_TOO_LARGE" });
    if (/Unexpected token|JSON/.test(msg)) return json(res, 400, { error: "INVALID_JSON" });
    console.error(now(), "ERR", req.method, path, msg);
    return json(res, 503, { error: "DEPENDENCY_ERROR", reason: msg.slice(0, 200) });
  }
}

async function recover(req: IncomingMessage, res: ServerResponse, requestId: string, principal: string, allowSend = true) {
  const r = row(db, "SELECT * FROM requests WHERE request_id = ?", requestId);
  if (!r || r.principal !== principal) return json(res, 404, { error: "NOT_FOUND" }); // no existence leak across principals
  let pay = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  const q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
  let payState = pay?.state ?? "NOT_REQUESTED";
  if (payState === "PENDING" || payState === "SUBMITTED") {
    payState = (await reconcilePending(db, requestId, { allowSend })) ?? payState;
    pay = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  }
  if (payState === "COMPLETED") {
    run(db, "UPDATE requests SET state = 'DELIVERED', updated_at = ? WHERE request_id = ?", now(), requestId);
    const rep = row(db, "SELECT * FROM reports WHERE report_digest = ?", q.report_digest);
    const ev = JSON.parse(rep.evidence_json);
    const p2 = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    return json(res, 200, { requestId, delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: p2.tx_hash, paymentId: p2.facilitator_payment_id, backend: p2.backend === "relay" ? "relay" : "circle", evidence: p2.settlement_evidence_json ? JSON.parse(p2.settlement_evidence_json) : null }, reportDigest: q.report_digest, report: JSON.parse(rep.report_json), evidence: ev.evidence, simulation: ev.simulation, expired: new Date(JSON.parse(rep.report_json).expiresAt) < new Date() });
  }
  const last = pay?.last_response_json ? JSON.parse(pay.last_response_json) : null;
  return json(res, payState === "PENDING" || payState === "SUBMITTED" ? 202 : 200, { requestId, state: r.state, payment: { state: payState, paymentId: pay?.facilitator_payment_id ?? null, backend: pay ? (pay.backend === "relay" ? "relay" : "circle") : null, transaction: pay?.tx_hash ?? null, reason: last?.reason ?? null }, quote: q ? JSON.parse(q.quote_json) : null, quoteExpired: q ? new Date(q.expires_at) < new Date() : null });
}

// The OpenAPI document (2026-10-10: parameters, request bodies, responses and the key schemas added, so the site's API reference and any
// client generator see more than a summary). The route summaries are the contract's prose; the schemas name the key fields, not every one.
const S = {
  str: (description?: string, extra: Record<string, unknown> = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra }),
  bool: (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: "integer", ...(description ? { description } : {}) }),
  addr: (description?: string) => ({ type: "string", format: "0x address", ...(description ? { description } : {}) }),
  hash: (description?: string) => ({ type: "string", format: "0x 32-byte hex", ...(description ? { description } : {}) }),
  uint: (description?: string) => ({ type: "string", format: "decimal uint", ...(description ? { description } : {}) }),
  time: (description?: string) => ({ type: "string", format: "UTC ISO-8601", ...(description ? { description } : {}) }),
  enm: (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) }),
  obj: (properties: Record<string, unknown>, required: string[] = [], description?: string) => ({ type: "object", properties, ...(required.length ? { required } : {}), ...(description ? { description } : {}) }),
  arr: (items: unknown, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) }),
  ref: (name: string) => ({ $ref: `#/components/schemas/${name}` }),
  body: (schema: unknown, description?: string) => ({ required: true, ...(description ? { description } : {}), content: { "application/json": { schema } } }),
  res: (description: string, schema?: unknown) => (schema ? { description, content: { "application/json": { schema } } } : { description }),
  path: (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } }),
  query: (name: string, description: string) => ({ name, in: "query", required: false, description, schema: { type: "integer" } }),
};
const ERR = S.res("the error and its reason", S.ref("Error"));
const AUTH = { 401: S.res("no or unknown bearer token", S.ref("Error")) };
const PAGING = (max: number, def: number) => [S.query("limit", `rows per page, 1–${max} (default ${def})`), S.query("offset", "rows to skip (default 0)")];
function openapi() {
  return {
    openapi: "3.0.3", info: { title: "ArcPreflight API", version: cfg.releaseSha, description: `profile=${cfg.profile}; network=${cfg.caip2}. Self-service is open: POST /v1/session issues an anonymous bearer token. The complete lifecycle is available to every visitor: own orders, paid checks over x402, wallet execution validated and recorded before the prompt, recovery, private passports. Public reads need no token. Nothing here custodies funds: your wallet or key signs the check fee (EIP-3009) and the payment.` },
    paths: {
      "/health/live": { get: { summary: "process liveness", responses: { 200: S.res("the process is up", S.obj({ ok: S.bool(), release: S.str("the running release"), profile: S.str(), network: S.str("CAIP-2 chain id") })) } } },
      "/health/ready": { get: { summary: "dependency readiness (bounded probes)", responses: { 200: S.res("every probe passed"), 503: S.res("a dependency is not ready") } } },
      "/v1/network": { get: { summary: "network (with its public RPC: PUBLIC_RPC_URL or the network's public endpoint, never the operator's own), fixture deployments, approved baselines, demo budget", responses: { 200: S.res("this instance, now", S.ref("Network")) } } },
      "/v1/subjects/{address}": { get: { summary: "public object observation of the curated samples listed in /v1/network observableSubjects (OBJECT_OBSERVATION, never decision-eligible); other addresses get 422 UNSUPPORTED_SUBJECT", parameters: [S.path("address", "one of the curated sample addresses")], responses: { 200: S.res("the observation report with its evidence count", S.obj({ reportDigest: S.hash(), report: S.obj({}, [], "the pinned observation report"), supported: S.bool(), evidenceCount: S.int() })), 422: S.res("not a curated sample", S.ref("Error")), 429: S.res("too many observations from this client", S.ref("Error")) } } },
      "/v1/public-reports": { get: { summary: "list public sample reports", responses: { 200: S.res("the public reports", S.obj({ reports: S.arr(S.obj({ reportDigest: S.hash(), subject: S.addr(), mode: S.str(), createdAt: S.time() })) })) } } },
      "/v1/public-reports/{reportDigest}": { get: { summary: "public sample report with raw evidence", parameters: [S.path("reportDigest", "the report digest")], responses: { 200: S.res("the report and its evidence", S.obj({ reportDigest: S.hash(), report: S.obj({}), evidence: S.arr(S.obj({ evidence: S.obj({}), digest: S.hash() })) })), 404: ERR } } },
      "/v1/demo/run": { post: { summary: "start a budgeted live demo run by the project's own runner (body: fixture APPROVED_PAYMENT | CHANGED_IMPLEMENTATION | AMOUNT_UNIT_MISMATCH, clientRunRequestId admission key, optional interruptAfterBroadcast for a labelled interruption after the business broadcast); the admission key binds the run: same key → the original run (200), another fixture under the same key → 409 ADMISSION_CONFLICT; 429 while a run is active or the daily budget is used; 503 DEMO_UNAVAILABLE without fixtures", requestBody: S.body(S.obj({ fixture: S.enm(["APPROVED_PAYMENT", "CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH"]), clientRunRequestId: S.str("your admission key, 16–128 characters of [A-Za-z0-9._-]; the same key always returns the same run"), interruptAfterBroadcast: S.bool("rehearse an interruption right after the business broadcast") }, ["fixture", "clientRunRequestId"])), responses: { 202: S.res("a new run was admitted", S.ref("Admission")), 200: S.res("the run this key already started", S.ref("Admission")), 400: ERR, 409: S.res("another fixture under the same key", S.ref("Error")), 429: S.res("a run is active, the client is cooling down, or the budget is used", S.ref("Error")), 503: S.res("no fixtures on this instance", S.ref("Error")) } } },
      "/v1/demo/runs": { get: { summary: "demo runs, newest first (limit ≤ 100, offset); each row carries network, recorded fee/business amounts and passport availability", parameters: PAGING(100, 20), responses: { 200: S.res("a page of runs", S.obj({ runs: S.arr(S.ref("RunSummary")), total: S.int(), limit: S.int(), offset: S.int() })) } } },
      "/v1/demo/runs/{runId}": { get: { summary: "run steps, receipts, labels and recovery summary; read routes never broadcast", parameters: [S.path("runId", "the run id")], responses: { 200: S.res("the run", S.ref("Run")), 404: ERR } } },
      "/v1/demo/runs/{runId}/passport": { get: { summary: "Payment Passport bundle (format 1.0, docs/PASSPORT.md) of a finished run: portable read-only evidence with no secrets; 409 PASSPORT_NOT_READY while the run is in progress", parameters: [S.path("runId", "the run id")], responses: { 200: S.res("the passport bundle", S.ref("PassportBundle")), 404: ERR, 409: S.res("the run is still in progress", S.ref("Error")) } } },
      "/v1/demo/runs/{runId}/recover": { post: { summary: "authorized recovery of THAT attempt only (body: the admission's clientRunRequestId); reconciles from the original context and may rebroadcast identical bytes; never signs a replacement, creates an order or starts a run", parameters: [S.path("runId", "the run id")], requestBody: S.body(S.obj({ clientRunRequestId: S.str("the admission key the run was started with") }, ["clientRunRequestId"])), responses: { 200: S.res("the run after reconciliation", S.ref("Run")), 403: S.res("not the run's admission key", S.ref("Error")), 404: ERR } } },
      "/v1/session": { post: { summary: "open self-service: create an anonymous session token for this browser (bearer for /v1/preflight, /v1/requests*, /v1/demo/orders, /v1/baselines); at most 10 new sessions per client per day", responses: { 201: S.res("a new anonymous principal and its bearer token", S.obj({ principal: S.str("visitor:<uuid>"), token: S.str("send it as Authorization: Bearer <token>; it owns what you create"), note: S.str() }, ["principal", "token"])), 429: S.res("too many sessions from this client today", S.ref("Error")) } } },
      "/v1/faucet": { get: { summary: "testnet faucet status (enabled on Arc testnet only)", responses: { 200: S.res("the faucet's status", S.obj({ enabled: S.bool(), amountNativeAtomic: S.uint(), perDay: S.int(), usedToday: S.int(), perAddressPer24h: S.int(), sender: S.addr(), note: S.str() })), 404: S.res("no faucet on this network", S.ref("Error")) } }, post: { summary: "testnet only: send a small amount of testnet USDC from the project's order-creator key to a visitor's wallet (body: address); one claim per wallet and per client every 24 h; 429 when the daily budget or the per-client limit is used; 503 when the sender is busy", requestBody: S.body(S.obj({ address: S.addr("the wallet to fund") }, ["address"])), responses: { 200: S.res("sent (or sent, not yet confirmed: pending=true)", S.obj({ ok: S.bool(), txHash: S.hash(), amountNativeAtomic: S.uint(), address: S.addr(), pending: S.bool(), note: S.str() })), 400: ERR, 404: S.res("no faucet on this network", S.ref("Error")), 429: ERR, 503: ERR } } },
      "/v1/demo/orders": { post: { summary: "create a DemoMerchant order for the caller's wallet on the MAIN or CHANGED fixture proxy (body: payer, proxy, amountNativeAtomic 1e15–1e18 in steps of 1e12, reference ≤ 64 chars); the order identity is durable before the creation is sent: 201 CONFIRMED, 202 ORDER_CREATION_PENDING when the receipt is not in yet (GET reconciles), 502 ORDER_CREATION_UNKNOWN names the order when the answer was lost", security: [{ bearer: [] }], requestBody: S.body(S.obj({ payer: S.addr("the wallet that will pay; only it can"), proxy: S.enm(["MAIN", "CHANGED"], "which fixture proxy (default MAIN)"), amountNativeAtomic: S.uint("18-decimal native units, 1e15–1e18 in steps of 1e12 (default 5e16 = 0.05 USDC)"), reference: S.str("optional free text, ≤ 64 characters") }, ["payer"])), responses: { 201: S.res("created and confirmed on Arc", S.ref("Order")), 202: S.res("identity recorded, creation not confirmed yet: read it back", S.ref("Order")), 400: ERR, ...AUTH, 409: S.res("your latest order's creation is still unconfirmed", S.ref("Error")), 502: S.res("the creation's answer was lost; the order is named", S.ref("Error")) } }, get: { summary: "the owner's orders with live paid state, linked checks and wallet attempts, and the next action", security: [{ bearer: [] }], parameters: [S.query("limit", "rows, 1–200 (default 50)")], responses: { 200: S.res("your orders, newest first", S.obj({ orders: S.arr(S.ref("Order")) })), ...AUTH } } },
      "/v1/demo/orders/{orderId}": { get: { summary: "one of the owner's orders (unconfirmed creations are reconciled from the chain on read; nothing is sent)", security: [{ bearer: [] }], parameters: [S.path("orderId", "the order id")], responses: { 200: S.res("the order as it reads now", S.ref("Order")), ...AUTH, 404: ERR } } },
      "/v1/demo/orders/{orderId}/recover": { post: { summary: "owner only, at most one per order every 3 s (429 RATE_LIMITED): one bounded reconciliation of an unconfirmed creation — reads the receipt, the order and the creation nonce, and may hand the node the IDENTICAL signed creation again; never signs a replacement", security: [{ bearer: [] }], parameters: [S.path("orderId", "the order id")], responses: { 200: S.res("the order after reconciliation", S.ref("Order")), ...AUTH, 404: ERR, 429: S.res("one recovery per order every 3 s", S.ref("Error")) } } },
      "/v1/wallet/attempts": { post: { summary: "validate a wallet execution (body: requestId of the delivered check, orderId, policy): decision + final validation for the wallet payer at a fresh pinned block; the attempt is persisted VALIDATED with its plan before any prompt; 409 VALIDATION_FAILED with reasons, 409 ATTEMPT_OPEN when one is open for the order, 403 EXECUTION_GATED on an instance whose execution is closed", security: [{ bearer: [] }], requestBody: S.body(S.obj({ requestId: S.str("the paid check's request id"), orderId: S.hash("the order to pay"), policy: S.obj({}, [], "your policy (PolicyCore): the decision is re-run with it") }, ["requestId", "orderId", "policy"])), responses: { 201: S.res("VALIDATED: the exact plan and the window", S.ref("Attempt")), 400: ERR, ...AUTH, 403: S.res("execution is closed on this instance", S.ref("Error")), 404: ERR, 409: S.res("VALIDATION_FAILED with reasons, or ATTEMPT_OPEN", S.obj({ error: S.str(), reason: S.str(), reasons: S.arr(S.str()), attemptId: S.str() })) } }, get: { summary: "the owner's wallet attempts", security: [{ bearer: [] }], parameters: [S.query("limit", "rows, 1–200 (default 50)")], responses: { 200: S.res("your attempts, newest first", S.obj({ attempts: S.arr(S.ref("Attempt")) })), ...AUTH } } },
      "/v1/wallet/attempts/{attemptId}": { get: { summary: "observe one attempt (chain reads only): state, plan comparison, outcome, recovery summary, cost statement, next action", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], responses: { 200: S.res("the attempt as it reads now", S.ref("Attempt")), ...AUTH, 404: ERR } } },
      "/v1/wallet/attempts/{attemptId}/sent": { post: { summary: "report the hash the wallet returned (body: txHash); fields are compared with the plan once visible; a mismatch in to/data/value/chainId/type is recorded MISMATCH", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], requestBody: S.body(S.obj({ txHash: S.hash("the hash your wallet returned") }, ["txHash"])), responses: { 200: S.res("BROADCAST_ATTEMPTED, or already closed", S.ref("Attempt")), 400: ERR, ...AUTH, 404: ERR, 409: S.res("the attempt is not open", S.ref("Error")) } } },
      "/v1/wallet/attempts/{attemptId}/prompt": { post: { summary: "the prompt claim: event prompted (body may carry a claimId) is granted to the first caller only — 409 PROMPT_CLAIMED with the attempt for everyone else, who reconciles instead of prompting; event unknown-submission marks a wallet answer that was not a rejection; event not-prompted with the same claimId hands an untouched claim back", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], requestBody: S.body(S.obj({ event: S.enm(["prompted", "unknown-submission", "not-prompted"]), claimId: S.str("8–64 characters of [A-Za-z0-9_-], generated per operation and kept in its memory"), detail: S.str("optional, ≤ 200 characters: what the wallet answered") }, ["event"])), responses: { 200: S.res("the attempt with its prompt marker", S.ref("Attempt")), 400: ERR, ...AUTH, 404: ERR, 409: S.res("PROMPT_CLAIMED: another caller holds the claim; the attempt is in the body", S.obj({ error: S.str(), reason: S.str(), attempt: S.ref("Attempt") })) } } },
      "/v1/wallet/attempts/{attemptId}/abandon": { post: { summary: "the visitor states that the wallet prompt was rejected: NOT_SENT", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], responses: { 200: S.res("NOT_SENT", S.ref("Attempt")), ...AUTH, 404: ERR, 409: S.res("the attempt is not open", S.ref("Error")) } } },
      "/v1/wallet/attempts/{attemptId}/recover": { post: { summary: "bounded reconciliation of THAT attempt now from the hash, the order state and the merchant's OrderPaid event; nothing is signed or sent", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], responses: { 200: S.res("the attempt after reconciliation", S.ref("Attempt")), ...AUTH, 404: ERR, 429: S.res("one recovery every 3 s", S.ref("Error")) } } },
      "/v1/wallet/attempts/{attemptId}/passport": { get: { summary: "private Payment Passport of a wallet attempt (subject wallet-run, execution mode wallet)", security: [{ bearer: [] }], parameters: [S.path("attemptId", "the attempt id")], responses: { 200: S.res("the passport bundle", S.ref("PassportBundle")), ...AUTH, 404: ERR, 409: S.res("not available yet", S.ref("Error")) } } },
      "/v1/evidence": { get: { summary: "index of published evidence files", responses: { 200: S.res("every published file", S.obj({ files: S.arr(S.obj({ path: S.str(), bytes: S.int() })) })) } } },
      "/v1/evidence/{path}": { get: { summary: "one evidence file", parameters: [S.path("path", "a path from the index (JSON files only)")], responses: { 200: S.res("the file"), 404: ERR } } },
      "/v1/preflight": { post: { summary: "supported-intent preflight; 402 with quote until paid (x402 exact, EIP-3009 TransferWithAuthorization on Arc USDC, settled by this server's own relayer which pays gas in USDC; 503 SETTLEMENT_PAUSED when the relayer is paused); 202 while the fee is settling; the report, its digest and the payment facts once delivered", security: [{ bearer: [] }], requestBody: S.body(S.obj({ intent: S.ref("Intent"), payment: S.obj({ signature: S.str("the EIP-712 signature of the authorization"), authorization: S.obj({ from: S.addr(), to: S.addr("the quote's payTo"), value: S.uint("exactly the quote's amountTokenAtomic"), validAfter: S.uint(), validBefore: S.uint(), nonce: S.hash() }, ["from", "to", "value", "validAfter", "validBefore", "nonce"]) }, ["signature", "authorization"], "omit it to get the quote; send it with the same intent to pay") }, ["intent"])), responses: { 402: S.res("the quote: pay it by resending the intent with `payment`", S.obj({ requestId: S.str(), pinnedBlock: S.uint(), quote: S.obj({ amountTokenAtomic: S.uint("6-decimal USDC units"), payTo: S.addr(), asset: S.addr("Arc USDC"), network: S.str(), expiresAt: S.time() }) })), 202: S.res("accepted: the fee is settling on Arc; poll GET /v1/requests/{requestId}", S.obj({ requestId: S.str(), delivery: S.str(), payment: S.obj({ state: S.str() }) })), 200: S.res("delivered: the report", S.obj({ requestId: S.str(), delivery: S.enm(["DELIVERED"]), report: S.obj({}, [], "the pinned report (ReportCore)"), reportDigest: S.hash(), simulation: S.obj({}), payment: S.obj({ state: S.str(), transaction: S.hash() }) })), 400: ERR, ...AUTH, 422: S.res("unsupported intent or subject", S.ref("Error")), 429: S.res("the principal's daily check budget is used", S.ref("Error")), 503: S.res("settlement paused", S.ref("Error")) } } },
      "/v1/baselines/{baselineDigest}": { get: { summary: "authenticated approved baseline and current revocation state", security: [{ bearer: [] }], parameters: [S.path("baselineDigest", "the approved baseline's digest")], responses: { 200: S.res("the baseline and whether it is revoked", S.obj({ baselineDigest: S.hash(), baseline: S.obj({}, [], "the approved baseline (BaselineCore)"), revoked: S.bool() })), ...AUTH, 404: ERR } } },
      "/v1/requests": { get: { summary: "the owner's check history (read-only; payment state as recorded, passport availability)", security: [{ bearer: [] }], parameters: [S.query("limit", "rows, 1–200 (default 50)")], responses: { 200: S.res("your checks, newest first", S.obj({ requests: S.arr(S.ref("CheckRow")) })), ...AUTH } } },
      "/v1/requests/{requestId}": { get: { summary: "authenticated read of payment state and purchased report (observes chain facts; never broadcasts)", security: [{ bearer: [] }], parameters: [S.path("requestId", "the request id from the quote")], responses: { 200: S.res("delivered: the report", S.obj({ requestId: S.str(), delivery: S.str(), report: S.obj({}), reportDigest: S.hash(), payment: S.obj({ state: S.str(), transaction: S.hash() }) })), 202: S.res("the fee is still settling"), ...AUTH, 404: ERR } } },
      "/v1/requests/{requestId}/passport": { get: { summary: "the owner's private passport of a paid check (report, quote, payment facts without the authorization signature, evidence)", security: [{ bearer: [] }], parameters: [S.path("requestId", "the request id")], responses: { 200: S.res("the passport bundle", S.ref("PassportBundle")), ...AUTH, 404: ERR, 409: S.res("not paid yet", S.ref("Error")) } } },
      "/v1/requests/{requestId}/recover": { post: { summary: "authenticated reconciliation of an already accepted fee authorization (the settlement may be sent or re-sent; one authorization nonce cannot pay twice)", security: [{ bearer: [] }], parameters: [S.path("requestId", "the request id")], responses: { 200: S.res("the request after reconciliation"), ...AUTH, 404: ERR } } },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "the token from POST /v1/session (or a configured principal token)" } },
      schemas: {
        Error: S.obj({ error: S.str("a stable code, e.g. NOT_FOUND, VALIDATION_FAILED, RATE_LIMITED"), reason: S.str("one sentence for a reader") }, ["error"]),
        Network: S.obj({ network: S.enm(["mainnet", "testnet"]), chainId: S.int(), caip2: S.str(), rpc: S.str("a public RPC for this network"), explorer: S.str(), head: S.uint("the head block when answered"), usdc: S.addr(), profile: S.str(), release: S.str(), priceTokenAtomic: S.uint("the check price in 6-decimal USDC units"), supportedTargets: S.arr(S.addr()), fixtures: S.arr(S.obj({ id: S.str(), title: S.str(), headline: S.str(), proxy: S.enm(["MAIN", "CHANGED"]), merchant: S.addr() })), budget: S.obj({ maxRunsPerDay: S.int(), usedToday: S.int(), clientCooldownSeconds: S.int(), amountNativeAtomic: S.uint() }), access: S.obj({ selfService: S.bool(), session: S.str(), publicExecution: S.bool(), walletExecution: S.bool() }), faucet: S.obj({ enabled: S.bool() }), orders: S.obj({ minNativeAtomic: S.uint(), maxNativeAtomic: S.uint(), stepNativeAtomic: S.uint(), defaultNativeAtomic: S.uint() }) }, [], "key fields; the live answer carries more (deployments, accounts, capabilities, settlement, funds)"),
        Intent: S.obj({ schemaVersion: S.enm(["1.0"]), clientRequestId: S.str("your id for this check, 1–128 characters"), chainId: S.int(), walletMode: S.enm(["EOA_DIRECT_NON_DELEGATED"]), from: S.addr("the payer"), operation: S.enm(["CALL"]), to: S.addr("the merchant proxy"), data: S.str("pay(orderId) calldata, 0x8609cad1 + orderId"), valueNativeAtomic: S.uint("the order amount in 18-decimal native units"), businessExpectation: S.obj({ action: S.enm(["MERCHANT_PAY"]), orderId: S.hash(), recipient: S.addr(), asset: S.enm(["ARC_NATIVE_USDC"]), amountNativeAtomic: S.uint(), sourceId: S.str("order:<orderId>"), sourceDigest: S.hash("keccak256 of order:<orderId>:<payer>:<amount>") }, ["action", "orderId", "recipient", "asset", "amountNativeAtomic", "sourceId", "sourceDigest"]), baselineDigest: S.hash("the approved baseline the order references"), policyDigest: S.hash("the digest of your policy"), expiresAt: S.time("when this intent expires") }, ["schemaVersion", "clientRequestId", "chainId", "walletMode", "from", "operation", "to", "data", "valueNativeAtomic", "businessExpectation", "baselineDigest", "policyDigest", "expiresAt"], "the exact call you intend to make (IntentCore); the full schema is in packages/schema"),
        Order: S.obj({ orderId: S.hash(), payer: S.addr(), merchant: S.addr(), proxy: S.enm(["MAIN", "CHANGED"]), amountNativeAtomic: S.uint(), reference: S.str(), state: S.enm(["PLANNED", "SENT", "CONFIRMED", "FAILED", "UNKNOWN_CREATION"], "the creation's state"), tx: S.hash("the creation transaction"), block: S.uint(), paid: S.bool("read from the chain"), paidCheckedAt: S.time(), checks: S.arr(S.obj({ requestId: S.str() })), attempts: S.arr(S.obj({ attemptId: S.str(), state: S.str() })), nextAction: S.str(), createdAt: S.time(), updatedAt: S.time() }, [], "key fields of an order view"),
        Attempt: S.obj({ attemptId: S.str(), executionMode: S.enm(["wallet"]), state: S.enm(["VALIDATED", "REFUSED", "BROADCAST_ATTEMPTED", "NOT_SENT", "CONFIRMED", "REVERTED", "MISMATCH", "NOT_MINED", "NOT_EXECUTED"]), requestId: S.str(), orderId: S.hash(), merchant: S.addr(), payer: S.addr(), amountNativeAtomic: S.uint(), decision: S.str("the recorded decision"), decisionReasons: S.arr(S.str()), validUntil: S.time("the window inside which the wallet may still be asked"), plan: S.obj({ chainId: S.int(), from: S.addr(), to: S.addr(), data: S.str(), valueNativeAtomic: S.uint(), gasLimit: S.uint(), maxFeePerGasNativeAtomic: S.uint(), maxPriorityFeePerGasNativeAtomic: S.uint(), type: S.int() }, [], "exactly what the wallet must sign"), prompt: S.obj({ state: S.enm(["PROMPTED", "UNKNOWN_SUBMISSION"]), at: S.time(), detail: S.str() }, [], "the prompt marker, when one was written"), txHash: S.hash(), businessStatus: S.str("SUCCESS when the order reads as paid by this attempt"), businessTxHash: S.hash(), block: S.uint(), deviations: S.obj({ mismatch: S.arr(S.str()), deviations: S.obj({}) }, [], "the sent transaction compared with the plan"), costStatement: S.obj({}, [], "USDC costs of this attempt, once known"), recovery: S.obj({}, [], "what reconciliation found"), nextAction: S.str(), passportAvailable: S.bool(), createdAt: S.time(), updatedAt: S.time() }, [], "key fields of an attempt view"),
        Admission: S.obj({ runId: S.str(), poll: S.str("the run's GET path"), admission: S.enm(["new", "existing"]) }),
        RunSummary: S.obj({ runId: S.str(), fixture: S.str(), state: S.enm(["RUNNING", "DONE", "FAILED", "RECONCILE_REQUIRED"]), executionMode: S.str(), labels: S.arr(S.str()), network: S.str(), chainId: S.int(), decision: S.str(), businessTxHash: S.hash(), businessStatus: S.str(), outcome: S.str(), passportAvailable: S.bool(), createdAt: S.time(), updatedAt: S.time() }, [], "one row of the run list"),
        Run: S.obj({ runId: S.str(), fixture: S.str(), state: S.enm(["RUNNING", "DONE", "FAILED", "RECONCILE_REQUIRED"]), labels: S.arr(S.str()), steps: S.arr(S.obj({ step: S.str(), atMs: S.int() }, [], "one recorded step with its facts")), result: S.obj({}, [], "the outcome once the run ended"), recovery: S.obj({}, [], "the recovery summary"), createdAt: S.time(), updatedAt: S.time() }, [], "key fields of a run"),
        CheckRow: S.obj({ requestId: S.str(), clientRequestId: S.str(), state: S.str(), subject: S.addr(), orderId: S.hash(), valueNativeAtomic: S.uint(), reportDigest: S.hash(), payment: S.obj({ state: S.str(), backend: S.str(), transaction: S.hash() }), passportAvailable: S.bool(), createdAt: S.time(), updatedAt: S.time() }),
        PassportBundle: S.obj({ passportBundleVersion: S.str(), files: S.obj({}, [], "path → JSON text of every file in the passport directory (manifest, intent, policy, report, decision, execution, cost statement, evidence)") }, ["passportBundleVersion", "files"]),
      },
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Single-sender rule: new relay transactions wait until earlier payments are reconciled; public read-only routes serve meanwhile.
  beginSettlementResume();
  createServer((req, res) => { handle(req, res); }).listen(cfg.port, "127.0.0.1", () => {
    console.log(now(), `arcpreflight api listening on 127.0.0.1:${cfg.port} profile=${cfg.profile} network=${cfg.caip2} release=${cfg.releaseSha} principals=${cfg.principals.size} targets=${cfg.supportedTargets.length}`);
    // a crash between signing and broadcasting a relay transaction must never lose a payment: re-examine unresolved rows
    resumeSettlements(db, (m) => console.log(now(), "SETTLEMENT", m)).then((n) => { if (n) console.log(now(), `SETTLEMENT resumed ${n} unresolved payment(s)`); }).catch((e) => console.error(now(), "SETTLEMENT resume failed", String(e?.message ?? e)));
    // business transactions whose broadcast was attempted before a restart are reconciled from their original context (D07)
    reconcileExecutions(db, (m) => console.log(now(), "EXECUTION", m), { allowSend: true }).then((r) => { if (r.resolved || r.pending) console.log(now(), `EXECUTION reconciliation: resolved ${r.resolved}, pending ${r.pending}`); }).catch((e) => console.error(now(), "EXECUTION reconciliation failed", String(e?.message ?? e)));
    // v3.3: order creations planned or sent before a restart are resolved from the chain; wallet attempts whose browser went away are reconciled (reads only)
    reconcileOrderCreations(db, (m) => console.log(now(), "ORDER", m)).then((r) => { if (r.resolved || r.pending) console.log(now(), `ORDER reconciliation: resolved ${r.resolved}, pending ${r.pending}`); }).catch((e) => console.error(now(), "ORDER reconciliation failed", String(e?.message ?? e)));
    reconcileWalletAttempts(db, walletRpcFromClient(chainClient), { source: "worker", log: (m) => console.log(now(), "WALLET", m) }).then((r) => { if (r.resolved || r.pending) console.log(now(), `WALLET reconciliation: resolved ${r.resolved}, pending ${r.pending}`); }).catch((e) => console.error(now(), "WALLET reconciliation failed", String(e?.message ?? e)));
    // the recovery worker is the only periodic sender: unresolved fee settlements and business transactions, from their original context
    setInterval(() => { recoveryWorker().catch((e) => console.error(now(), "RECOVERY worker failed", String(e?.message ?? e))); }, cfg.recoveryIntervalMs).unref();
    // the low-balance watch (operator decision 2026-10-09): reads only; logs once when a key drops below its threshold; shown on /v1/network and the Evidence page
    const fundsLog = (m: string) => (m.startsWith("LOW") ? console.warn : console.log)(now(), "FUNDS", m);
    const watchFunds = () => fundsPass(chainClient, projectAccounts(), fundsLog).catch((e) => console.error(now(), "FUNDS watch failed", String(e?.message ?? e)));
    void watchFunds(); setInterval(watchFunds, FUNDS_CHECK_INTERVAL_MS).unref();
  });
}
let workerBusy = false;
async function recoveryWorker() {
  if (workerBusy) return; workerBusy = true;
  try {
    await reconcileOpenPayments(db, (m) => console.log(now(), "SETTLEMENT", m), 60_000);
    const r = await reconcileExecutions(db, (m) => console.log(now(), "EXECUTION", m), { allowSend: true });
    if (r.resolved) console.log(now(), `EXECUTION reconciliation: resolved ${r.resolved}, pending ${r.pending}`);
    const o = await reconcileOrderCreations(db, (m) => console.log(now(), "ORDER", m));
    if (o.resolved) console.log(now(), `ORDER reconciliation: resolved ${o.resolved}, pending ${o.pending}`);
    const w = await reconcileWalletAttempts(db, walletRpcFromClient(chainClient), { source: "worker", log: (m) => console.log(now(), "WALLET", m) });
    if (w.resolved) console.log(now(), `WALLET reconciliation: resolved ${w.resolved}, pending ${w.pending}`);
    const f = await backfillFeeReceipts(db, walletRpcFromClient(chainClient)); if (f) console.log(now(), `WALLET fee receipts backfilled: ${f}`);
  } finally { workerBusy = false; }
}
