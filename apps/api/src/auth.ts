import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cfg } from "./config.js";

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
export function isAdmin(req: IncomingMessage): boolean {
  if (!cfg.adminToken) return false;
  const h = req.headers["x-admin-token"]; const t = Array.isArray(h) ? h[0] : h; if (!t) return false;
  const a = Buffer.from(cfg.adminToken), b = Buffer.from(t);
  return a.length === b.length && timingSafeEqual(a, b);
}
