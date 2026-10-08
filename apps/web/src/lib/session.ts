// Anonymous browser session (P3): anyone who visits can buy a check — no registration, no token to paste. The API issues a
// session principal on demand (POST /v1/session → { principal: "visitor:<uuid>", token }); the browser keeps it per API instance
// and reuses it for every principal-gated call. A token the server no longer accepts (401 UNAUTHENTICATED) is replaced once and
// the call retried. Storage is a per-browser convenience with a real consequence: clearing site data loses the session, and with
// it the ownership of the checks it bought (history, recovery, private passports).
import { api, ApiError, getApiBase } from "./api";
import { scopeOf } from "./storage";

export type Session = { principal: string; token: string };
/** per instance: "arcpreflight.session:root" for the root API, "arcpreflight.session:/testnet" for the second one */
export const sessionKey = (base = getApiBase()) => `arcpreflight.session:${scopeOf(base)}`;
const memory = new Map<string, Session>(); // when localStorage is unavailable the session still lives for this page
const inflight = new Map<string, Promise<Session>>();
const valid = (v: any): v is Session => !!v && typeof v.token === "string" && v.token.length > 0 && typeof v.principal === "string";

export function storedSession(base = getApiBase()): Session | null {
  try { const raw = localStorage.getItem(sessionKey(base)); const v = raw ? JSON.parse(raw) : null; if (valid(v)) return { principal: v.principal, token: v.token }; } catch { /* unavailable or not ours */ }
  return memory.get(sessionKey(base)) ?? null;
}
export function forgetSession(base = getApiBase()) { memory.delete(sessionKey(base)); try { localStorage.removeItem(sessionKey(base)); } catch { /* storage unavailable */ } }
/** The stored session, or a new one from the API — one request even when several callers ask at once. `fresh` ignores the stored one. */
export function getSession(opts: { fresh?: boolean } = {}): Promise<Session> {
  const base = getApiBase();
  if (!opts.fresh) { const s = storedSession(base); if (s) return Promise.resolve(s); }
  const pending = inflight.get(base); if (pending) return pending;
  const p = (async () => {
    const r = await api.session();
    const s: Session = { principal: r.principal, token: r.token };
    memory.set(sessionKey(base), s);
    try { localStorage.setItem(sessionKey(base), JSON.stringify(s)); } catch { /* storage unavailable: the session lives for this page only */ }
    return s;
  })();
  inflight.set(base, p);
  return p.finally(() => { if (inflight.get(base) === p) inflight.delete(base); });
}
/** Runs a principal-gated call with this browser's session. A 401 means the server no longer knows the token: it is replaced once and the call retried. */
export async function withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const base = getApiBase();
  const s = await getSession();
  try { return await fn(s.token); }
  catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    if (storedSession(base)?.token === s.token) forgetSession(base);
    const fresh = await getSession({ fresh: true });
    return await fn(fresh.token);
  }
}
/** test seam */
export function resetSessions() { memory.clear(); inflight.clear(); }
