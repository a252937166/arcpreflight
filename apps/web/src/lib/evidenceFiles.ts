// The published evidence list, made readable (review of 2026-10-10: two hundred full paths with a separator each is a wall, not a list).
// Pure helpers: files are grouped by folder, a passport and its anchors are folded into one row, names carry their date, and a filter
// narrows everything at once. The page decides how many rows of a folder to show at a time.
export type EvidenceFile = { path: string; bytes: number };
export type EvidenceRow = { path: string; name: string; bytes: number; /** the `.anchors.json` that belongs to this `.passport.json`, folded into its row */ anchors: EvidenceFile | null };
export type EvidenceGroup = { dir: string; label: string; rows: EvidenceRow[]; files: number; bytes: number };

export const ROOT_DIR = "";
/** folders are at most two levels deep (`selftest/passports`); anything below becomes part of the row's name — an exported passport
 *  directory stays one folder, not six */
export const GROUP_DEPTH = 2;
const dirOf = (path: string) => { const parts = path.split("/"); return parts.length <= 1 ? ROOT_DIR : parts.slice(0, Math.min(GROUP_DEPTH, parts.length - 1)).join("/"); };
const nameOf = (path: string) => { const dir = dirOf(path); return dir === ROOT_DIR ? path : path.slice(dir.length + 1); };
/** "1.2 MB", "76.7 KB", "202 B" — a size a reader can compare at a glance */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/** the folder as a heading: "evidence/" for the root, otherwise the directory with a trailing slash */
export const groupLabel = (dir: string) => (dir === ROOT_DIR ? "evidence/" : `${dir}/`);

/** Files grouped by folder, newest-looking names first (ISO stamps in names sort as dates), a passport's anchors folded into its row.
 *  Folder order: the root first, then folders by name. */
export function groupEvidenceFiles(files: EvidenceFile[]): EvidenceGroup[] {
  const byDir = new Map<string, EvidenceFile[]>();
  for (const f of files) { const d = dirOf(f.path); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d)!.push(f); }
  const groups: EvidenceGroup[] = [];
  for (const [dir, list] of [...byDir.entries()].sort(([a], [b]) => (a === ROOT_DIR ? -1 : b === ROOT_DIR ? 1 : a.localeCompare(b)))) {
    const byName = new Map(list.map((f) => [nameOf(f.path), f]));
    const rows: EvidenceRow[] = [];
    for (const f of list) {
      const name = nameOf(f.path); // relative to the folder: a file of a deeper directory keeps that tail in its name
      if (name.endsWith(".anchors.json") && byName.has(`${name.slice(0, -".anchors.json".length)}.passport.json`)) continue; // folded into its passport's row
      const anchors = name.endsWith(".passport.json") ? byName.get(`${name.slice(0, -".passport.json".length)}.anchors.json`) ?? null : null;
      rows.push({ path: f.path, name, bytes: f.bytes, anchors });
    }
    rows.sort((a, b) => b.name.localeCompare(a.name)); // newest stamp first; plain names fall in reverse alphabetical order, which keeps the latest baselines on top too
    groups.push({ dir, label: groupLabel(dir), rows, files: list.length, bytes: list.reduce((s, f) => s + f.bytes, 0) });
  }
  return groups;
}
/** the groups narrowed to rows whose path contains the filter (case-insensitive, whitespace-separated terms all required); empty groups are dropped */
export function filterEvidenceGroups(groups: EvidenceGroup[], filter: string): EvidenceGroup[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return groups;
  return groups.map((g) => {
    const rows = g.rows.filter((r) => { const hay = `${r.path} ${r.anchors?.path ?? ""}`.toLowerCase(); return terms.every((t) => hay.includes(t)); });
    return { ...g, rows, files: rows.reduce((n, r) => n + 1 + (r.anchors ? 1 : 0), 0), bytes: rows.reduce((s, r) => s + r.bytes + (r.anchors?.bytes ?? 0), 0) };
  }).filter((g) => g.rows.length > 0);
}
/** the first `limit` items and how many stay hidden — the one rule every long list on the site follows */
export const LIST_PAGE = 8;
export function limited<T>(items: T[], limit: number): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, Math.max(0, limit)), hidden: Math.max(0, items.length - limit) };
}
