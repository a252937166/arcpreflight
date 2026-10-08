import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cfg } from "./config.js";
import { type Db, row, run, now } from "./db.js";

export function principalOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(h); if (!m) return null;
  const token = m[1].trim();
  for (const [t, p] of cfg.principals) {
    const a = Buffer.from(t), b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) return p;
  }
  return null;
}
// Open self-service (user decision 2026-10-08): anyone may obtain an anonymous session — a bearer token the site creates for the
// browser — and use it like a configured principal. Ownership of requests, recovery and private passports stays with that
// session. Tokens are stored hashed; creation is bounded per client so principal churn cannot defeat the per-principal limits.
const SESSIONS = "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, client_key TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)";
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const SESSIONS_PER_CLIENT_PER_DAY = Number(process.env.SESSIONS_PER_CLIENT_PER_DAY ?? 10);
export function createSession(db: Db, clientKey: string): { ok: true; principal: string; token: string } | { ok: false; status: number; error: string; reason: string } {
  db.exec(SESSIONS);
  const day = now().slice(0, 10);
  const made = row(db, "SELECT COUNT(*) AS c FROM sessions WHERE client_key = ? AND substr(created_at,1,10) = ?", clientKey, day)?.c ?? 0;
  if (made >= SESSIONS_PER_CLIENT_PER_DAY) return { ok: false, status: 429, error: "RATE_LIMITED", reason: `at most ${SESSIONS_PER_CLIENT_PER_DAY} new sessions per client per day; reuse the one your browser already holds` };
  const token = `vs_${randomBytes(24).toString("hex")}`; const principal = `visitor:${randomUUID()}`;
  run(db, "INSERT INTO sessions (token_hash, principal, client_key, created_at, last_seen_at) VALUES (?,?,?,?,?)", hashToken(token), principal, clientKey, now(), now());
  return { ok: true, principal, token };
}
export function sessionPrincipalOf(db: Db, req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(vs_[0-9a-f]{48})$/.exec(h); if (!m) return null;
  db.exec(SESSIONS);
  const s = row(db, "SELECT principal FROM sessions WHERE token_hash = ?", hashToken(m[1]));
  if (!s) return null;
  run(db, "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", now(), hashToken(m[1]));
  return s.principal as string;
}
export function isAdmin(req: IncomingMessage): boolean {
  if (!cfg.adminToken) return false;
  const h = req.headers["x-admin-token"]; const t = Array.isArray(h) ? h[0] : h; if (!t) return false;
  const a = Buffer.from(cfg.adminToken), b = Buffer.from(t);
  return a.length === b.length && timingSafeEqual(a, b);
}
