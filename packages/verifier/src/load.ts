// Passport loading rules (docs/PASSPORT.md §1), re-implemented here so the verifier stands on its own.
import type { PassportFiles } from "./types.js";

export const LIMITS = { maxFiles: 200, maxPathLength: 200, maxTotalBytes: 4 * 1024 * 1024 } as const;
const PATH_RE = /^[A-Za-z0-9._/-]+$/;
export const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export class PassportLoadError extends Error {
  constructor(message: string, public readonly problems: string[] = []) { super(problems.length ? `${message}: ${problems.join("; ")}` : message); this.name = "PassportLoadError"; }
}

export function pathProblems(path: string): string[] {
  const p: string[] = [];
  if (typeof path !== "string" || !path) return ["empty path"];
  if (path.length > LIMITS.maxPathLength) p.push(`${path.slice(0, 40)}…: longer than ${LIMITS.maxPathLength} characters`);
  if (path.includes("\\")) p.push(`${path}: backslash separators are not allowed`);
  if (path.startsWith("/")) p.push(`${path}: absolute paths are not allowed`);
  if (!PATH_RE.test(path)) p.push(`${path}: characters outside [A-Za-z0-9._/-]`);
  for (const seg of path.split("/")) { if (seg === "" || seg === "." || seg === "..") { p.push(`${path}: empty, '.' or '..' path segment`); break; } }
  return p;
}
/** Path, count, size and manifest rules over an in-memory file set. */
export function fileSetProblems(files: PassportFiles): string[] {
  const problems: string[] = [];
  const paths = Object.keys(files);
  if (paths.length > LIMITS.maxFiles) problems.push(`${paths.length} files exceed the limit of ${LIMITS.maxFiles}`);
  const seen = new Set<string>(); let total = 0;
  for (const path of paths) {
    problems.push(...pathProblems(path));
    const k = path.toLowerCase(); if (seen.has(k)) problems.push(`${path}: duplicate path (case-insensitive)`); seen.add(k);
    if (typeof files[path] !== "string") problems.push(`${path}: content must be a string`); else total += utf8Length(files[path]);
  }
  if (total > LIMITS.maxTotalBytes) problems.push(`total size ${total} bytes exceeds ${LIMITS.maxTotalBytes}`);
  if (!paths.includes("manifest.json")) problems.push("manifest.json is missing");
  return problems;
}

/** Bundle → files. Throws PassportLoadError on any format violation; nothing is skipped. */
export function loadBundle(input: string | unknown): PassportFiles {
  let obj: any;
  try { obj = typeof input === "string" ? JSON.parse(input) : input; } catch (e: any) { throw new PassportLoadError("bundle is not valid JSON", [String(e?.message ?? e)]); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new PassportLoadError("bundle must be a JSON object");
  if (obj.passportBundleVersion !== "1.0") throw new PassportLoadError(`unsupported passportBundleVersion ${JSON.stringify(obj.passportBundleVersion)}`);
  if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) throw new PassportLoadError("bundle.files must be an object of path → content");
  const files: PassportFiles = {};
  for (const [path, content] of Object.entries(obj.files as Record<string, unknown>)) { if (typeof content !== "string") throw new PassportLoadError(`${path}: file content must be a string`); files[path] = content; }
  const problems = fileSetProblems(files);
  if (problems.length) throw new PassportLoadError("bundle violates the passport path rules", problems);
  return files;
}
