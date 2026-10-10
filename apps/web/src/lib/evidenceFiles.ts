// The published evidence list, made readable (review of 2026-10-10: two hundred full paths with a separator each is a wall, not a list).
// Pure helpers: files are grouped by folder, a passport and its anchors are folded into one row, names carry their date, and a filter
// narrows everything at once. The page decides how many rows of a folder to show at a time.
// Review of c3afab7 (P3): "newest first" is decided by the moment a name carries (`2026-10-10T07-35-28-806Z`, `2026-10-09T14-35-45Z`,
// `2026-10-08`, `20261003`), not by spelling the names backwards — `wallet-acceptance-2026-10-09…` used to sit above `testnet-lifecycle-2026-10-10…`.
// The manifest carries no timestamps (the files are deployed copies; their mtimes are the deploy's), so the name is the record's own date;
// an undated name takes its folder's date, and names without any date come last, in name order. The name decides only between equal moments.
export type EvidenceFile = { path: string; bytes: number };
export type EvidenceRow = { path: string; name: string; bytes: number; /** the `.anchors.json` that belongs to this `.passport.json`, folded into its row */ anchors: EvidenceFile | null; /** the moment the name (or its folder) carries, ms since the epoch; null when it carries none */ at: number | null };
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

const utcOf = (y: string, mo: string, d: string, h = "0", mi = "0", s = "0", ms = "0"): number | null => {
  const [Y, M, D, H, I, S] = [y, mo, d, h, mi, s].map(Number);
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || I > 59 || S > 59) return null;
  const t = Date.UTC(Y, M - 1, D, H, I, S, Number(ms)); return Number.isFinite(t) ? t : null;
};
/** the moment ONE path segment carries: a full stamp, a day, or a compact day (`20261003`) that is not a slice of a hex digest */
function stampIn(segment: string): number | null {
  const full = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})(?:-(\d{2}))?(?:-(\d{3}))?Z/.exec(segment);
  if (full) return utcOf(full[1], full[2], full[3], full[4], full[5], full[6] ?? "0", full[7] ?? "0");
  const day = /(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(segment);
  if (day) return utcOf(day[1], day[2], day[3]);
  const compact = /(?:^|[^0-9a-fA-F])(20\d{2})(\d{2})(\d{2})(?![0-9a-fA-F])/.exec(segment); // bounded by non-hex characters: `…-20261003.json`, never `0xab20261003cd…`
  if (compact) return utcOf(compact[1], compact[2], compact[3]);
  return null;
}
/** The moment a published path carries: its file name first, then its folders from the innermost out; null when none carries one
 *  (a baseline named by its digest, a passport named by its run id). Exported for the tests and for anything else that orders records. */
export function stampOf(path: string): number | null {
  const parts = path.split("/");
  for (const segment of [parts[parts.length - 1], ...parts.slice(0, -1).reverse()]) { const t = stampIn(segment); if (t !== null) return t; }
  return null;
}
/** newest moment first; a row without a moment after every row with one; equal moments (and no moments) in name order — the name is only the tiebreaker */
export const byNewest = (a: Pick<EvidenceRow, "at" | "name">, b: Pick<EvidenceRow, "at" | "name">): number => {
  if (a.at !== b.at) { if (a.at === null) return 1; if (b.at === null) return -1; return b.at - a.at; }
  return a.name.localeCompare(b.name);
};

/** Files grouped by folder, newest first by the moment their names carry (`stampOf`), a passport's anchors folded into its row.
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
      rows.push({ path: f.path, name, bytes: f.bytes, anchors, at: stampOf(f.path) });
    }
    rows.sort(byNewest); // the moment in the name decides (review of c3afab7, P3); the name only breaks ties
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
