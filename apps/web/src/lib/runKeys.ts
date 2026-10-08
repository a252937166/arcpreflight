// Admission keys for demo runs (design §10.1). A key is generated once per click and re-sent verbatim on every retry:
// the server binds it to one run, so a lost response, a refresh or a retry can only return the ORIGINAL run — never a
// second order. The browser also keeps runId → key so it can later ask for recovery of exactly that attempt.
// Storage is a per-browser convenience: when it is unavailable nothing breaks, recovery is simply not offered here.
import { scopedKey } from "./storage";
// keys are per API instance (P2): a run admitted on the testnet instance is recovered on the testnet instance
const STORE = () => scopedKey("arcpreflight.runKeys");
const PENDING = () => scopedKey("arcpreflight.pendingRunKeys");
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
export function rememberRunKey(runId: string, key: string) {
  const name = STORE(); const keys = read<Keys>(name); keys[runId] = key;
  const ids = Object.keys(keys); for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete keys[id];
  write(name, keys);
}
export const runKeyFor = (runId: string): string | null => read<Keys>(STORE())[runId] ?? null;
/** a start whose response never came back: the same fixture re-uses this key until the server has told us which run it became */
export function setPendingKey(fixture: string, key: string) { const name = PENDING(); const p = read<Pending>(name); p[fixture] = { key, at: Date.now() }; write(name, p); }
export function takePendingKey(fixture: string): string | null { const e = read<Pending>(PENDING())[fixture]; return e && Date.now() - e.at < PENDING_TTL_MS ? e.key : null; }
export function clearPendingKey(fixture: string) { const name = PENDING(); const p = read<Pending>(name); if (fixture in p) { delete p[fixture]; write(name, p); } }
