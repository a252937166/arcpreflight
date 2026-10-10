import { describe, expect, it } from "vitest";
import { filterEvidenceGroups, formatBytes, groupEvidenceFiles, limited } from "../src/lib/evidenceFiles";

// The published evidence list (review of 2026-10-10): folders, folded passport/anchors pairs, newest first, one filter, pages of eight.
const files = [
  { path: "baseline-testnet-MAIN-aaaa.json", bytes: 1797 }, { path: "baseline-testnet-CHANGED-bbbb.json", bytes: 1797 },
  { path: "selftest/passports/testnet-wallet-2026-10-08T10-50-41-609Z.passport.json", bytes: 78482 }, { path: "selftest/passports/testnet-wallet-2026-10-08T10-50-41-609Z.anchors.json", bytes: 202 },
  { path: "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.passport.json", bytes: 78539 }, { path: "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.anchors.json", bytes: 202 },
  { path: "selftest/passports/testnet-interrupt-2026-10-10T07-52-26-516Z.passport.json", bytes: 78532 }, { path: "selftest/passports/orphan.anchors.json", bytes: 200 },
  { path: "selftest/testnet-lifecycle-2026-10-10T07-52-09-832Z.json", bytes: 5000 }, { path: "spend/testnet-plan-x.json", bytes: 900 },
  { path: "selftest/passports/testnet-cli-r3-b582ac16/evidence/chain/fee-tx.json", bytes: 3000 }, // an exported passport DIRECTORY: its files stay in the passports folder, named by their tail
];
describe("evidence files", () => {
  it("groups by folder (root first), folds a passport's anchors into its row, keeps a stray anchors file as its own row, sorts newest stamps first and sums the sizes", () => {
    const groups = groupEvidenceFiles(files);
    expect(groups.map((g) => [g.label, g.files, g.rows.length])).toEqual([["evidence/", 2, 2], ["selftest/", 1, 1], ["selftest/passports/", 7, 5], ["spend/", 1, 1]]); // folders stop two levels deep
    const passports = groups[2];
    expect(passports.rows.map((r) => r.name)).toEqual(["testnet-wallet-2026-10-10T07-35-28-806Z.passport.json", "testnet-wallet-2026-10-08T10-50-41-609Z.passport.json", "testnet-interrupt-2026-10-10T07-52-26-516Z.passport.json", "testnet-cli-r3-b582ac16/evidence/chain/fee-tx.json", "orphan.anchors.json"]);
    expect(passports.rows[0].anchors).toEqual({ path: "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.anchors.json", bytes: 202 });
    expect(passports.rows[2].anchors).toBeNull(); expect(passports.bytes).toBe(78482 + 202 + 78539 + 202 + 78532 + 200 + 3000);
    expect(groups[0].rows.map((r) => r.name)).toEqual(["baseline-testnet-MAIN-aaaa.json", "baseline-testnet-CHANGED-bbbb.json"]);
  });
  it("filters every folder at once (all terms, any case, anchors included), drops empty folders and recounts; no filter returns the groups untouched", () => {
    const groups = groupEvidenceFiles(files);
    expect(filterEvidenceGroups(groups, "")).toBe(groups);
    const wallet = filterEvidenceGroups(groups, "WALLET 2026-10-10");
    expect(wallet.map((g) => [g.label, g.files, g.rows.length])).toEqual([["selftest/passports/", 2, 1]]);
    expect(filterEvidenceGroups(groups, "chain/fee").map((g) => [g.label, g.rows.map((r) => r.name)])).toEqual([["selftest/passports/", ["testnet-cli-r3-b582ac16/evidence/chain/fee-tx.json"]]]);
    expect(filterEvidenceGroups(groups, "lifecycle").map((g) => g.label)).toEqual(["selftest/"]);
    expect(filterEvidenceGroups(groups, "nothing-like-this")).toEqual([]);
  });
  it("limited() pages a list; formatBytes renders sizes a reader can compare", () => {
    expect(limited([1, 2, 3, 4, 5], 2)).toEqual({ shown: [1, 2], hidden: 3 }); expect(limited([1, 2], 8)).toEqual({ shown: [1, 2], hidden: 0 }); expect(limited([], 8)).toEqual({ shown: [], hidden: 0 });
    expect([formatBytes(202), formatBytes(1797), formatBytes(78539), formatBytes(2_400_000), formatBytes(-1)]).toEqual(["202 B", "1.8 KB", "77 KB", "2.3 MB", "—"]);
  });
});
