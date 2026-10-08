// Node-only helpers (directory form). Kept out of the main entry so the exporter core stays browser-safe.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PassportFiles } from "./types.js";
import { PassportFormatError, PATH_LIMITS, validateFiles } from "./paths.js";

/** Writes every file under `dir`, creating sub-directories. Refuses to overwrite: a passport is written once. */
export function writePassportDirectory(dir: string, files: PassportFiles): string[] {
  const v = validateFiles(files);
  if (!v.ok) throw new PassportFormatError("refusing to write an invalid passport", v.problems);
  const root = resolve(dir);
  const written: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const target = resolve(root, ...path.split("/"));
    if (!target.startsWith(root + sep) && target !== root) throw new PassportFormatError(`${path}: resolves outside the target directory`);
    if (existsSync(target)) throw new PassportFormatError(`${path}: already exists; a passport directory is written once`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files[path], "utf8");
    written.push(path);
  }
  return written;
}

/** Reads a passport directory. Symlinks (files or directories) are refused; only regular files are read. */
export function readPassportDirectory(dir: string): PassportFiles {
  const root = resolve(dir);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new PassportFormatError(`${dir}: not a directory`);
  const files: PassportFiles = {};
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new PassportFormatError(`${relative(root, full)}: symlinks are refused`);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new PassportFormatError(`${relative(root, full)}: not a regular file`);
      total += st.size;
      if (total > PATH_LIMITS.maxTotalBytes) throw new PassportFormatError(`directory exceeds ${PATH_LIMITS.maxTotalBytes} bytes`);
      files[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  const v = validateFiles(files);
  if (!v.ok) throw new PassportFormatError("directory violates the passport path rules", v.problems);
  return files;
}
