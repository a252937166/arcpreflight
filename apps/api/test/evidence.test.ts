import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evidenceManifest, publishablePath, publishedEvidence } from "../src/evidence.js";

// Audit 2026-10-10, API-01 (P0): the public evidence route must serve only files of an explicit publish manifest under evidence/, never a
// path outside the root — the previous implementation resolved absolute paths away from the root and served any readable .json on the host.
let root: string; let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arcpf-evidence-")); outside = mkdtempSync(join(tmpdir(), "arcpf-outside-"));
  mkdirSync(resolve(root, "evidence", "selftest", "passports"), { recursive: true });
  mkdirSync(resolve(root, "evidence", "private"), { recursive: true });
  mkdirSync(resolve(root, "evidence", "selftest", "private"), { recursive: true });
  mkdirSync(resolve(root, "keys"), { recursive: true });
  writeFileSync(resolve(root, "evidence", "baseline-testnet-MAIN-aaaa.json"), '{"published":true}');
  writeFileSync(resolve(root, "evidence", "selftest", "passports", "run.passport.json"), '{"passport":1}');
  writeFileSync(resolve(root, "evidence", "selftest", "notes.txt"), "not json");
  writeFileSync(resolve(root, "evidence", "private", "secret.json"), '{"secret":1}');
  writeFileSync(resolve(root, "evidence", "selftest", "private", "nested-secret.json"), '{"secret":2}');
  writeFileSync(resolve(root, "keys", "demo-runner.json"), '{"address":"0x1","privateKey":"0xdead"}');
  writeFileSync(resolve(outside, "deployments-testnet.json"), '{"outside":true}');
  symlinkSync(resolve(root, "keys", "demo-runner.json"), resolve(root, "evidence", "selftest", "escape.json")); // a symlink pointing outside the root
  symlinkSync(resolve(root, "evidence", "baseline-testnet-MAIN-aaaa.json"), resolve(root, "evidence", "selftest", "alias.json")); // a symlink that stays inside
  symlinkSync(outside, resolve(root, "evidence", "linked-dir")); // a symlinked directory leaving the root
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe("published evidence", () => {
  it("the manifest lists publishable .json files only: no private directories at any depth, no symlink escapes, no symlinked directories, no non-json", () => {
    expect(evidenceManifest(root).map((e) => e.path)).toEqual(["baseline-testnet-MAIN-aaaa.json", "selftest/alias.json", "selftest/passports/run.passport.json"]);
    expect(evidenceManifest(resolve(root, "does-not-exist"))).toEqual([]);
  });
  it("serves exactly the manifest's files and nothing else — absolute paths, encoded or literal, traversal, private, symlink escapes, non-json and unknown names all read nothing", () => {
    expect(publishedEvidence(root, "baseline-testnet-MAIN-aaaa.json")).toBe('{"published":true}');
    expect(publishedEvidence(root, "selftest/passports/run.passport.json")).toBe('{"passport":1}');
    expect(publishedEvidence(root, "selftest/alias.json")).toBe('{"published":true}'); // an in-root symlink resolves inside the root
    const keyFile = resolve(root, "keys", "demo-runner.json"), outsideFile = resolve(outside, "deployments-testnet.json");
    for (const bad of [keyFile, outsideFile, `/${keyFile}`, `//${keyFile.slice(1)}`, "/etc/hostname.json", "%2Fetc%2Fpasswd.json", "../keys/demo-runner.json", "selftest/../../keys/demo-runner.json",
      "private/secret.json", "selftest/private/nested-secret.json", "PRIVATE/secret.json", "selftest/escape.json", "linked-dir/deployments-testnet.json", "selftest/notes.txt", "selftest/notes.txt.json", "nope.json", "", ".json", "a/./b.json", "selftest//alias.json", "selftest\\alias.json"]) {
      expect(publishedEvidence(root, bad), bad).toBeNull();
    }
    expect(publishablePath("ok-1.json")).toBe(true); expect(publishablePath("/abs.json")).toBe(false); expect(publishablePath("x/private/y.json")).toBe(false); expect(publishablePath("x/../y.json")).toBe(false);
  });
});
