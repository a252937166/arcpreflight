// Admission keys for demo runs (design §10.1). A key is generated once per click and re-sent verbatim on every retry:
// the server binds it to one run, so a lost response, a refresh or a retry can only return the ORIGINAL run — never a
// second order. The browser also keeps runId → key so it can later ask for recovery of exactly that attempt.
// Storage is a per-browser convenience: when it is unavailable nothing breaks, recovery is simply not offered here.
import { scopedKey, scopeOf } from "./storage";
import { getApiBase } from "./api";
// keys are per API instance (P2): a run admitted on the testnet instance is recovered on the testnet instance. Review of 0d1088e (P1): every
// access names the instance explicitly — an operation stores, reads and clears the keys of the instance it was started on (`base`, captured at
// the click), never those of whatever instance is selected when its answer finally lands.
const STORE = (base: string) => scopedKey("arcpreflight.runKeys", scopeOf(base));
const PENDING = (base: string) => scopedKey("arcpreflight.pendingRunKeys", scopeOf(base));
const PENDING_TTL_MS = 10 * 60_000;
type Keys = Record<string, string>;
type Pending = Record<string, { key: string; at: number }>;

function read<T extends object>(name: string): T {
  try { const raw = localStorage.getItem(name); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v as T : {} as T; } catch { return {} as T; }
}
function write(name: string, value: unknown) { try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* storage unavailable or full: keys are a convenience, not state the server relies on */ } }

export function newRunKey(): string {
  try { return crypto.randomUUID(); } catch { return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`; }
}
/** remember which key admitted a run, keeping the map bounded */
export function rememberRunKey(runId: string, key: string, base: string = getApiBase()) {
  const name = STORE(base); const keys = read<Keys>(name); keys[runId] = key;
  const ids = Object.keys(keys); for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete keys[id];
  write(name, keys);
}
export const runKeyFor = (runId: string, base: string = getApiBase()): string | null => read<Keys>(STORE(base))[runId] ?? null;
/** a start whose response never came back: the same fixture re-uses this key ON THAT INSTANCE until the server has told us which run it became */
export function setPendingKey(fixture: string, key: string, base: string = getApiBase()) { const name = PENDING(base); const p = read<Pending>(name); p[fixture] = { key, at: Date.now() }; write(name, p); }
export function takePendingKey(fixture: string, base: string = getApiBase()): string | null { const e = read<Pending>(PENDING(base))[fixture]; return e && Date.now() - e.at < PENDING_TTL_MS ? e.key : null; }
/** clears the pending key of ONE instance, and only if it is still the key this operation set (a newer start on that instance keeps its own) */
export function clearPendingKey(fixture: string, base: string = getApiBase(), key?: string) { const name = PENDING(base); const p = read<Pending>(name); if (fixture in p && (key === undefined || p[fixture].key === key)) { delete p[fixture]; write(name, p); } }
