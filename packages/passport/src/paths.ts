// Path and size rules of docs/PASSPORT.md §1. Violations are reported, never silently skipped; the verifier turns them into
// a FILE_INTEGRITY failure and the importers refuse the passport.
export const PATH_LIMITS = { maxFiles: 200, maxPathLength: 200, maxTotalBytes: 4 * 1024 * 1024 } as const;
export const PATH_RE = /^[A-Za-z0-9._/-]+$/;
export const MANIFEST_PATH = "manifest.json";

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export function pathProblems(path: string): string[] {
  const p: string[] = [];
  if (typeof path !== "string" || path.length === 0) return ["empty path"];
  if (path.length > PATH_LIMITS.maxPathLength) p.push(`${path.slice(0, 40)}…: longer than ${PATH_LIMITS.maxPathLength} characters`);
  if (path.includes("\\")) p.push(`${path}: backslash separators are not allowed`);
  if (path.startsWith("/")) p.push(`${path}: absolute paths are not allowed`);
  if (!PATH_RE.test(path)) p.push(`${path}: characters outside [A-Za-z0-9._/-]`);
  for (const seg of path.split("/")) {
    if (seg === "") { p.push(`${path}: empty path segment`); break; }
    if (seg === "." || seg === "..") { p.push(`${path}: '.' and '..' segments are not allowed`); break; }
  }
  return p;
}

/** Every rule that can be checked on the path list alone (count, duplicates, syntax). */
export function validatePaths(paths: readonly string[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (paths.length > PATH_LIMITS.maxFiles) problems.push(`${paths.length} files exceed the limit of ${PATH_LIMITS.maxFiles}`);
  const seen = new Set<string>();
  for (const path of paths) {
    problems.push(...pathProblems(path));
    const key = String(path).toLowerCase();
    if (seen.has(key)) problems.push(`${path}: duplicate path (case-insensitive)`);
    seen.add(key);
  }
  return { ok: problems.length === 0, problems };
}

/** Path rules plus total size and the manifest requirement; the importers call this before trusting any content. */
export function validateFiles(files: Record<string, string>): { ok: boolean; problems: string[]; totalBytes: number } {
  const paths = Object.keys(files);
  const { problems } = validatePaths(paths);
  let totalBytes = 0;
  for (const path of paths) {
    const content = files[path];
    if (typeof content !== "string") { problems.push(`${path}: file content must be a UTF-8 string`); continue; }
    totalBytes += utf8Length(content);
  }
  if (totalBytes > PATH_LIMITS.maxTotalBytes) problems.push(`total size ${totalBytes} bytes exceeds ${PATH_LIMITS.maxTotalBytes}`);
  if (!paths.includes(MANIFEST_PATH)) problems.push(`${MANIFEST_PATH} is missing`);
  return { ok: problems.length === 0, problems, totalBytes };
}

export class PassportFormatError extends Error {
  constructor(message: string, public readonly problems: string[] = []) { super(problems.length ? `${message}: ${problems.join("; ")}` : message); this.name = "PassportFormatError"; }
}
