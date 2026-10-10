// Published evidence (audit 2026-10-10, API-01 P0). The old route resolved the request path under evidence/ with path.resolve, and an
// absolute path discards the root: any readable .json on the host could be fetched. Now the route serves ONLY files that appear in an
// explicit publish manifest built from the evidence directory itself (regular files, `.json`, never under a `private` directory at any
// depth, never through a symlink that leaves the root), and a request is answered only when its exact relative path is in that manifest
// AND the real path of the file is still inside the real path of the root. Nothing outside evidence/ is ever opened.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export type EvidenceEntry = { path: string; bytes: number };
/** a published path: relative, forward slashes, `.json`, every segment a plain name (no empty, dot or dot-dot segments), no `private` segment */
export const PUBLISHABLE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
export function publishablePath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 512 || !PUBLISHABLE.test(rel)) return false;
  const segments = rel.split("/");
  return segments.every((s) => s !== "." && s !== ".." && s.toLowerCase() !== "private");
}
const realRoot = (root: string): string | null => { try { return realpathSync(resolve(root, "evidence")); } catch { return null; } };
/** `child` is `root` itself or below it, compared on real paths */
const within = (child: string, root: string) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/** The publish manifest: every publishable file under evidence/, walked without following symlinked directories; a symlinked file counts only
 *  when its target stays inside the root. Sorted by path. */
export function evidenceManifest(root: string): EvidenceEntry[] {
  const base = realRoot(root);
  if (!base) return [];
  const out: EvidenceEntry[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const path = resolve(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.toLowerCase() === "private") continue;
      if (e.isSymbolicLink()) { // a symlink is published only as a FILE whose target is inside the root; symlinked directories are not walked
        let target: string; try { target = realpathSync(path); } catch { continue; }
        if (!within(target, base)) continue;
        let st; try { st = statSync(target); } catch { continue; }
        if (st.isFile() && publishablePath(r)) out.push({ path: r, bytes: st.size });
        continue;
      }
      if (e.isDirectory()) { walk(path, r); continue; }
      if (e.isFile() && publishablePath(r)) { try { out.push({ path: r, bytes: statSync(path).size }); } catch { /* vanished */ } }
    }
  };
  walk(base, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
/** The content of ONE published file, or null: the exact relative path must be in the manifest and its real path inside the real root. */
export function publishedEvidence(root: string, rel: string): string | null {
  if (!publishablePath(rel)) return null;
  const base = realRoot(root); if (!base) return null;
  if (!evidenceManifest(root).some((e) => e.path === rel)) return null;
  const candidate = resolve(base, ...rel.split("/"));
  if (!within(candidate, base)) return null;
  let real: string; try { real = realpathSync(candidate); } catch { return null; }
  if (!within(real, base)) return null;
  try { if (!lstatSync(candidate).isFile() && !statSync(real).isFile()) return null; return readFileSync(real, "utf8"); } catch { return null; }
}
export const evidenceDirExists = (root: string) => existsSync(resolve(root, "evidence"));
