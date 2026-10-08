// Per-instance browser storage (P2): run admission keys, remembered checks and trial tokens belong to the backend they came
// from, so switching networks never mixes them. Names are `<name>:<scope>`; a pre-P2 unsuffixed value is moved once into the
// scope it belonged to (the root instance) and the old key removed. Storage stays a per-browser convenience: every access is
// guarded, and nothing the server relies on lives here.
import { getApiBase } from "./api";

/** the storage scope of the selected API base: "root" for "", otherwise the base path itself (e.g. "/testnet") */
export const scopeOf = (base = getApiBase()) => (base ? base : "root");

export function scopedKey(name: string, scope = scopeOf(), opts: { legacyName?: string; migrateTo?: string } = {}): string {
  const legacyName = opts.legacyName ?? name;
  const target = `${name}:${opts.migrateTo ?? "root"}`;
  try {
    const legacy = localStorage.getItem(legacyName);
    if (legacy !== null) {
      if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy);
      localStorage.removeItem(legacyName);
    }
  } catch { /* storage unavailable */ }
  return `${name}:${scope}`;
}
