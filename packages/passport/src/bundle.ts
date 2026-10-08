// Bundle form: one JSON document holding the same files as the directory (docs/PASSPORT.md §1).
import { PASSPORT_BUNDLE_VERSION, type PassportFiles } from "./types.js";
import { PassportFormatError, validateFiles } from "./paths.js";

export type PassportBundle = { passportBundleVersion: typeof PASSPORT_BUNDLE_VERSION; files: PassportFiles };

export function toBundle(files: PassportFiles): PassportBundle {
  const v = validateFiles(files);
  if (!v.ok) throw new PassportFormatError("refusing to bundle an invalid passport", v.problems);
  const sorted: PassportFiles = {};
  for (const path of Object.keys(files).sort()) sorted[path] = files[path];
  return { passportBundleVersion: PASSPORT_BUNDLE_VERSION, files: sorted };
}
export const bundleToString = (files: PassportFiles): string => JSON.stringify(toBundle(files), null, 2) + "\n";

/** Parses and validates a bundle (string or already-parsed object). Path, count, size and manifest rules are enforced; nothing is skipped. */
export function fromBundle(input: string | unknown): PassportFiles {
  let obj: any;
  try { obj = typeof input === "string" ? JSON.parse(input) : input; } catch (e: any) { throw new PassportFormatError("bundle is not valid JSON", [String(e?.message ?? e)]); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new PassportFormatError("bundle must be a JSON object");
  if (obj.passportBundleVersion !== PASSPORT_BUNDLE_VERSION) throw new PassportFormatError(`unsupported passportBundleVersion ${JSON.stringify(obj.passportBundleVersion)}`);
  if (!obj.files || typeof obj.files !== "object" || Array.isArray(obj.files)) throw new PassportFormatError("bundle.files must be an object of path → content");
  const files: PassportFiles = {};
  for (const [path, content] of Object.entries(obj.files as Record<string, unknown>)) {
    if (typeof content !== "string") throw new PassportFormatError(`${path}: file content must be a string`);
    files[path] = content;
  }
  const v = validateFiles(files);
  if (!v.ok) throw new PassportFormatError("bundle violates the passport path rules", v.problems);
  return files;
}
