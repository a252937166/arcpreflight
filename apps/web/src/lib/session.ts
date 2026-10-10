// Anonymous browser session (P3): anyone who visits can buy a check — no registration, no token to paste. The API issues a
// session principal on demand (POST /v1/session → { principal: "visitor:<uuid>", token }); the browser keeps it per API instance
// and reuses it for every principal-gated call. A token the server no longer accepts (401 UNAUTHENTICATED) is replaced once and
// the call retried. Storage is a per-browser convenience with a real consequence: clearing site data loses the session, and with
// it the ownership of the checks it bought (history, recovery, private passports).
import { api, ApiError, getApiBase, pinBase, InstanceChangedError } from "./api";
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
export function getSession(opts: { fresh?: boolean; base?: string } = {}): Promise<Session> {
  const base = opts.base ?? getApiBase();
  if (!opts.fresh) { const s = storedSession(base); if (s) return Promise.resolve(s); }
  const pending = inflight.get(base); if (pending) return pending;
  const p = (async () => {
    const create = async (): Promise<Session> => {
      const r = await api.session();
      const s: Session = { principal: r.principal, token: r.token };
      // audit 2026-10-10 (W10): another tab may have created and stored a session for this instance meanwhile (two fresh tabs, a renewal); a
      // stored session that owns records is never replaced — this tab adopts it and drops the one it just created (no record exists under it yet)
      const stored = opts.fresh ? null : storedSession(base);
      if (stored && stored.token !== s.token) { memory.set(sessionKey(base), stored); return stored; }
      memory.set(sessionKey(base), s);
      try { localStorage.setItem(sessionKey(base), JSON.stringify(s)); } catch { /* storage unavailable: the session lives for this page only */ }
      return s;
    };
    // where the browser offers Web Locks, tabs of this origin take turns creating the instance's session (the lock holder re-reads storage first)
    const locks: any = typeof navigator !== "undefined" ? (navigator as any).locks : null;
    if (locks?.request) return locks.request(`arcpreflight-session:${scopeOf(base)}`, async () => { if (!opts.fresh) { const s = storedSession(base); if (s) return s; } return create(); }) as Promise<Session>;
    return create();
  })();
  inflight.set(base, p);
  return p.finally(() => { if (inflight.get(base) === p) inflight.delete(base); });
}
/** Runs a principal-gated call with this browser's session, bound to the instance selected when it started (audit 2026-10-10, W01): the
 *  session, the call and the one retry after a 401 all go to that instance; if the selected network changes meanwhile the operation is
 *  refused — never retried on the new instance with the old token, never redirected. */
export async function withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const base = getApiBase();
  const unpin = pinBase(base);
  try {
    const s = await getSession({ base });
    if (getApiBase() !== base) throw new InstanceChangedError(base, getApiBase());
    try { return await fn(s.token); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      if (getApiBase() !== base) throw new InstanceChangedError(base, getApiBase());
      if (storedSession(base)?.token === s.token) forgetSession(base);
      const fresh = await getSession({ fresh: true, base });
      if (getApiBase() !== base) throw new InstanceChangedError(base, getApiBase());
      return await fn(fresh.token);
    }
  } finally { unpin(); }
}
/** test seam */
export function resetSessions() { memory.clear(); inflight.clear(); }
