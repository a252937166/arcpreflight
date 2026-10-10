// "My checks": the requestIds this browser bought, so the Developer page can list and recover them even before the trial
// token is typed again. The server list (GET /v1/requests) is the source of truth; this is a per-browser convenience.
import { scopedKey, scopeOf } from "./storage";
// per API instance (P2); the pre-P2 list under "arcpreflight.myChecks" is moved once into the root scope. The instance is the one the
// operation is bound to (`client.base`), not the one selected when a delayed purchase finally records its request (review of c3afab7, P2).
const STORE = (base?: string) => scopedKey("arcpreflight.checks", scopeOf(base), { legacyName: "arcpreflight.myChecks" });
export type RememberedCheck = { requestId: string; createdAt: string; subject: string | null; valueNativeAtomic: string | null };

function read(base?: string): Record<string, RememberedCheck> {
  try { const raw = localStorage.getItem(STORE(base)); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
export function rememberCheck(c: RememberedCheck, base?: string) {
  const all = read(base); all[c.requestId] = { ...all[c.requestId], ...c };
  const ids = Object.keys(all); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete all[id];
  try { localStorage.setItem(STORE(base), JSON.stringify(all)); } catch { /* storage unavailable: the server list still works with the token */ }
}
export const rememberedChecks = (base?: string): RememberedCheck[] => Object.values(read(base)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
