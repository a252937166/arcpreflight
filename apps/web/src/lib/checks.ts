// "My checks": the requestIds this browser bought, so the Developer page can list and recover them even before the trial
// token is typed again. The server list (GET /v1/requests) is the source of truth; this is a per-browser convenience.
import { scopedKey } from "./storage";
// per API instance (P2); the pre-P2 list under "arcpreflight.myChecks" is moved once into the root scope
const STORE = () => scopedKey("arcpreflight.checks", undefined, { legacyName: "arcpreflight.myChecks" });
export type RememberedCheck = { requestId: string; createdAt: string; subject: string | null; valueNativeAtomic: string | null };

function read(): Record<string, RememberedCheck> {
  try { const raw = localStorage.getItem(STORE()); const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
export function rememberCheck(c: RememberedCheck) {
  const all = read(); all[c.requestId] = { ...all[c.requestId], ...c };
  const ids = Object.keys(all); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete all[id];
  try { localStorage.setItem(STORE(), JSON.stringify(all)); } catch { /* storage unavailable: the server list still works with the token */ }
}
export const rememberedChecks = (): RememberedCheck[] => Object.values(read()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
