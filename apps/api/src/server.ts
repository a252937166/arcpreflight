import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { IntentCore, intentDigest as computeIntentDigest, BaselineCore, baselineDigest as computeBaselineDigest } from "@arcpreflight/schema";
import { cfg } from "./config.js";
import { openDb, row, rows, run, now, type Db } from "./db.js";
import { principalOf, isAdmin } from "./auth.js";
import { buildObjectReport, buildIntentReport, client } from "./report.js";
import { makeQuote, paymentRequirementsFor, paymentMatchesQuote, settleForRequest, reconcilePending, type PaymentInput } from "./payments.js";
import { networkInfo, startRun, getRun, listRuns, createOrderFor, evidenceIndex, evidenceFile, clientKey, FIXTURES } from "./demo.js";

const db: Db = openDb(cfg.dbPath);
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
let lastReady: { at: number; body: unknown } | null = null;

function usageOk(principal: string): boolean {
  const day = now().slice(0, 10);
  const r = row(db, "SELECT count FROM usage WHERE principal = ? AND day = ?", principal, day);
  const c = (r?.count ?? 0) + 1;
  if (c > cfg.maxPreflightPerPrincipalPerDay) return false;
  run(db, "INSERT INTO usage (principal, day, count) VALUES (?,?,?) ON CONFLICT(principal, day) DO UPDATE SET count = ?", principal, day, c, c);
  return true;
}

const clientIp = (req: IncomingMessage) => { const xf = req.headers["x-forwarded-for"]; const s = Array.isArray(xf) ? xf[0] : xf; return (s?.split(",")[0].trim()) || req.socket.remoteAddress || undefined; };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  let m: RegExpExecArray | null;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (req.method === "GET" && path === "/health/live") return json(res, 200, { ok: true, release: cfg.releaseSha, profile: cfg.profile, network: cfg.caip2 });
    // Public: network + fixture facts, demo runs (budgeted live runs by the project's own runner), evidence index
    if (req.method === "GET" && path === "/v1/network") return json(res, 200, await networkInfo(db));
    if (req.method === "GET" && path === "/v1/demo/runs") return json(res, 200, { runs: listRuns(db, Math.min(Number(url.searchParams.get("limit") ?? 20), 100)) });
    if (req.method === "GET" && (m = /^\/v1\/demo\/runs\/([0-9a-f-]{36})$/.exec(path))) { const r = getRun(db, m[1]); return r ? json(res, 200, r) : json(res, 404, { error: "NOT_FOUND" }); }
    if (req.method === "POST" && path === "/v1/demo/run") {
      const body = await readJson(req);
      const fixture = String(body.fixture ?? "");
      if (!(fixture in FIXTURES)) return json(res, 400, { error: "INVALID_INPUT", reason: `fixture must be one of ${Object.keys(FIXTURES).join(", ")}` });
      const r = await startRun(db, fixture as keyof typeof FIXTURES, clientKey(clientIp(req), req.headers["user-agent"]));
      return r.ok ? json(res, 202, { runId: r.runId, poll: `/v1/demo/runs/${r.runId}` }) : json(res, r.status, { error: r.error, reason: r.reason, sampleRunId: r.sample ?? null });
    }
    if (req.method === "POST" && path === "/v1/demo/orders") {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED", hint: "a trial principal token is required to create developer orders in this release" });
      const body = await readJson(req);
      if (!isAddress(String(body.payer ?? ""))) return json(res, 400, { error: "INVALID_INPUT", reason: "payer must be an address" });
      const r = await createOrderFor(db, getAddress(body.payer) as Hex, clientKey(clientIp(req), req.headers["user-agent"]));
      return r.ok ? json(res, 201, r) : json(res, r.status, { error: r.error, reason: r.reason });
    }
    if (req.method === "GET" && path === "/v1/public-reports") {
      const list = rows(db, "SELECT report_digest, subject, mode, created_at FROM reports WHERE is_public = 1 ORDER BY created_at DESC LIMIT 50");
      return json(res, 200, { reports: list.map((r: any) => ({ reportDigest: r.report_digest, subject: r.subject, mode: r.mode, createdAt: r.created_at })) });
    }
    if (req.method === "GET" && path === "/v1/evidence") return json(res, 200, { files: evidenceIndex() });
    if (req.method === "GET" && (m = /^\/v1\/evidence\/(.+)$/.exec(path))) {
      const f = evidenceFile(decodeURIComponent(m[1]));
      if (!f) return json(res, 404, { error: "NOT_FOUND" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60", ...CORS }); return res.end(f);
    }
    if (req.method === "GET" && path === "/health/ready") {
      if (lastReady && Date.now() - lastReady.at < 10_000) return json(res, 200, lastReady.body);
      const deps: Record<string, unknown> = {};
      try { const t = Date.now(); const bn = await Promise.race([client.getBlockNumber(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), 4000))]); deps.rpc = { ok: true, head: bn.toString(), ms: Date.now() - t }; } catch (e: any) { deps.rpc = { ok: false, error: String(e?.message ?? e) }; }
      try { row(db, "SELECT 1"); deps.db = { ok: true }; } catch (e: any) { deps.db = { ok: false, error: String(e?.message ?? e) }; }
      deps.merchantConfigured = !!cfg.merchant; deps.supportedTargets = cfg.supportedTargets.length;
      const degraded = !(deps.rpc as any).ok || !(deps.db as any).ok;
      const body = { ready: !degraded, state: degraded ? "degraded" : "ok", release: cfg.releaseSha, profile: cfg.profile, network: cfg.caip2, deps, checkedAt: now() };
      lastReady = { at: Date.now(), body };
      return json(res, degraded ? 503 : 200, body);
    }
    if (req.method === "GET" && path === "/openapi.json") return json(res, 200, openapi());

    // Public object observation (never decision-eligible)
    if (req.method === "GET" && (m = /^\/v1\/subjects\/(0x[0-9a-fA-F]{40})$/.exec(path))) {
      const addr = getAddress(m[1]) as Hex;
      const c = objectCache.get(addr.toLowerCase());
      if (c && Date.now() - c.at < 30_000) return json(res, 200, c.body);
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
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED", hint: "external paid access is not open in this release; see /openapi.json" });
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
      const resourceUrl = `${cfg.publicBaseUrl}/v1/preflight`;
      // Baseline lookup (by digest the intent references; must be for this subject and not revoked)
      const bRow = row(db, "SELECT * FROM baselines WHERE baseline_digest = ?", intent.baselineDigest);
      const baseline = bRow ? BaselineCore.parse(JSON.parse(bRow.baseline_json)) : null;
      // Quote: prepare report once; reuse while the quote is valid
      let q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
      let reportDigestStr: string;
      if (!q || new Date(q.expires_at) < new Date()) {
        const payRow0 = row(db, "SELECT state FROM payments WHERE request_id = ?", requestId);
        if (payRow0 && payRow0.state !== "FAILED") {
          // a payment exists for the old quote: do not re-quote; recover instead
          return await recover(req, res, requestId, principal);
        }
        const built = await buildIntentReport(intent, iDigest as Hex, baseline && !bRow.revoked ? baseline : null, baseline ? (bRow.baseline_digest as Hex) : null);
        run(db, "INSERT OR IGNORE INTO reports (report_digest, request_id, subject, mode, report_json, evidence_json, is_public, created_at) VALUES (?,?,?,?,?,?,?,?)",
          built.digest, requestId, intent.to.toLowerCase(), "SUPPORTED_INTENT", JSON.stringify(built.report), JSON.stringify({ evidence: built.evidence, simulation: built.simulation, baselineRevoked: !!bRow?.revoked }), 0, now());
        const { quote, digest: qd } = makeQuote(requestId, principal, intent, iDigest, built.digest, built.digest);
        run(db, "INSERT INTO quotes (request_id, quote_json, quote_digest, report_digest, expires_at, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET quote_json = excluded.quote_json, quote_digest = excluded.quote_digest, report_digest = excluded.report_digest, expires_at = excluded.expires_at, created_at = excluded.created_at",
          requestId, JSON.stringify(quote), qd, built.digest, quote.expiresAt, now());
        run(db, "UPDATE requests SET state = 'WAITING_PAYMENT', updated_at = ? WHERE request_id = ?", now(), requestId);
        q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
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
      const mismatch = paymentMatchesQuote(p, quote, intent);
      if (mismatch) return json(res, 400, { error: "PAYMENT_MISMATCH", reason: mismatch });
      const s = await settleForRequest(db, requestId, quote, intent, p, resourceUrl);
      if ("conflict" in s) return json(res, 409, { error: "PAYMENT_CONFLICT", reason: s.conflict });
      if (s.state === "COMPLETED") {
        run(db, "UPDATE requests SET state = 'DELIVERED', updated_at = ? WHERE request_id = ?", now(), requestId);
        const r = row(db, "SELECT * FROM reports WHERE report_digest = ?", reportDigestStr);
        const ev = JSON.parse(r.evidence_json);
        return json(res, 200, { requestId, delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: s.txHash, paymentId: s.paymentId }, reportDigest: reportDigestStr, report: JSON.parse(r.report_json), evidence: ev.evidence, simulation: ev.simulation });
      }
      if (s.state === "PENDING") return json(res, 202, { requestId, payment: { state: "PENDING", paymentId: s.paymentId }, reportDigest: reportDigestStr, note: "settlement pending; recover via GET /v1/requests/{requestId} with the same credentials" });
      return json(res, 402, { requestId, error: "PAYMENT_FAILED", payment: { state: s.state, reason: s.reason, httpStatus: s.httpStatus }, quote });
    }
    if (req.method === "GET" && (m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(path))) {
      const principal = principalOf(req);
      if (!principal) return json(res, 401, { error: "UNAUTHENTICATED" });
      return await recover(req, res, m[1], principal);
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

async function recover(req: IncomingMessage, res: ServerResponse, requestId: string, principal: string) {
  const r = row(db, "SELECT * FROM requests WHERE request_id = ?", requestId);
  if (!r || r.principal !== principal) return json(res, 404, { error: "NOT_FOUND" }); // no existence leak across principals
  const pay = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
  const q = row(db, "SELECT * FROM quotes WHERE request_id = ?", requestId);
  let payState = pay?.state ?? "NOT_REQUESTED";
  if (payState === "PENDING") payState = (await reconcilePending(db, requestId)) ?? payState;
  if (payState === "COMPLETED") {
    run(db, "UPDATE requests SET state = 'DELIVERED', updated_at = ? WHERE request_id = ?", now(), requestId);
    const rep = row(db, "SELECT * FROM reports WHERE report_digest = ?", q.report_digest);
    const ev = JSON.parse(rep.evidence_json);
    const p2 = row(db, "SELECT * FROM payments WHERE request_id = ?", requestId);
    return json(res, 200, { requestId, delivery: "DELIVERED", payment: { state: "COMPLETED", transaction: p2.tx_hash, paymentId: p2.facilitator_payment_id }, reportDigest: q.report_digest, report: JSON.parse(rep.report_json), evidence: ev.evidence, simulation: ev.simulation, expired: new Date(JSON.parse(rep.report_json).expiresAt) < new Date() });
  }
  return json(res, payState === "PENDING" ? 202 : 200, { requestId, state: r.state, payment: { state: payState, paymentId: pay?.facilitator_payment_id ?? null }, quote: q ? JSON.parse(q.quote_json) : null, quoteExpired: q ? new Date(q.expires_at) < new Date() : null });
}

function openapi() {
  return {
    openapi: "3.0.3", info: { title: "ArcPreflight API", version: cfg.releaseSha, description: `profile=${cfg.profile}; network=${cfg.caip2}. External paid access is closed unless a principal token is configured.` },
    paths: {
      "/health/live": { get: { summary: "process liveness" } }, "/health/ready": { get: { summary: "dependency readiness (bounded probes)" } },
      "/v1/network": { get: { summary: "network, fixture deployments, approved baselines, demo budget" } },
      "/v1/subjects/{address}": { get: { summary: "public object observation (OBJECT_OBSERVATION, never decision-eligible)" } },
      "/v1/public-reports": { get: { summary: "list public sample reports" } },
      "/v1/public-reports/{reportDigest}": { get: { summary: "public sample report with raw evidence" } },
      "/v1/demo/run": { post: { summary: "start a budgeted live demo run by the project's own runner (fixture: APPROVED_PAYMENT | CHANGED_IMPLEMENTATION | AMOUNT_UNIT_MISMATCH)" } },
      "/v1/demo/runs": { get: { summary: "recent demo runs" } }, "/v1/demo/runs/{runId}": { get: { summary: "run steps, receipts and labels" } },
      "/v1/demo/orders": { post: { summary: "create a DemoMerchant order for an external payer (trial principals only)", security: [{ bearer: [] }] } },
      "/v1/evidence": { get: { summary: "index of published evidence files" } }, "/v1/evidence/{path}": { get: { summary: "one evidence file" } },
      "/v1/preflight": { post: { summary: "supported-intent preflight; 402 with quote until paid (x402 exact, EIP-3009, Circle Facilitator on Arc)", security: [{ bearer: [] }] } },
      "/v1/requests/{requestId}": { get: { summary: "authenticated recovery of payment state and purchased report", security: [{ bearer: [] }] } },
    },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  };
}

createServer((req, res) => { handle(req, res); }).listen(cfg.port, "127.0.0.1", () => {
  console.log(now(), `arcpreflight api listening on 127.0.0.1:${cfg.port} profile=${cfg.profile} network=${cfg.caip2} release=${cfg.releaseSha} principals=${cfg.principals.size} targets=${cfg.supportedTargets.length}`);
});
