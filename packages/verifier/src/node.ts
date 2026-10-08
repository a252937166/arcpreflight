// Node-only loaders (directory form, files on disk). The verifier core in ./verify.ts never touches the file system.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { LIMITS, PassportLoadError, fileSetProblems, loadBundle } from "./load.js";
import type { Anchors, PassportFiles } from "./types.js";

/** Reads a passport directory; symlinks are refused, only regular files count. */
export function readPassportDirectory(dir: string): PassportFiles {
  const root = resolve(dir);
  const files: PassportFiles = {}; let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name); const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new PassportLoadError(`${relative(root, full)}: symlinks are refused`);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new PassportLoadError(`${relative(root, full)}: not a regular file`);
      total += st.size; if (total > LIMITS.maxTotalBytes) throw new PassportLoadError(`directory exceeds ${LIMITS.maxTotalBytes} bytes`);
      files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  const problems = fileSetProblems(files);
  if (problems.length) throw new PassportLoadError("directory violates the passport path rules", problems);
  return files;
}
/** A directory or a bundle file, decided by what is on disk. */
export function loadPassportPath(path: string): PassportFiles {
  if (!existsSync(path)) throw new PassportLoadError(`${path}: no such file or directory`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new PassportLoadError(`${path}: symlinks are refused`);
  return st.isDirectory() ? readPassportDirectory(path) : loadBundle(readFileSync(path, "utf8"));
}
export function loadAnchorsFile(path: string): Anchors {
  let a: any;
  try { a = JSON.parse(readFileSync(path, "utf8")); } catch (e: any) { throw new PassportLoadError(`${path}: anchors file is not valid JSON`, [String(e?.message ?? e)]); }
  const arr = (v: unknown, name: string) => { if (v === undefined) return []; if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x))) throw new PassportLoadError(`${path}: ${name} must be an array of 32-byte hex digests`); return v as string[]; };
  return { baselineDigests: arr(a?.baselineDigests, "baselineDigests"), policyDigests: arr(a?.policyDigests, "policyDigests") };
}
