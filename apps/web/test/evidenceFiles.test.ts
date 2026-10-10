import { describe, expect, it } from "vitest";
import { byNewest, filterEvidenceGroups, formatBytes, groupEvidenceFiles, limited, stampOf } from "../src/lib/evidenceFiles";

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
  it("groups by folder (root first), folds a passport's anchors into its row, keeps a stray anchors file as its own row, sorts newest moments first and sums the sizes", () => {
    const groups = groupEvidenceFiles(files);
    expect(groups.map((g) => [g.label, g.files, g.rows.length])).toEqual([["evidence/", 2, 2], ["selftest/", 1, 1], ["selftest/passports/", 7, 5], ["spend/", 1, 1]]); // folders stop two levels deep
    const passports = groups[2];
    // review of c3afab7 (P3): the 07:52 interrupt record of 2026-10-10 is newer than the 07:35 wallet record and far newer than the 2026-10-08 one — the
    // earlier expectation here had it third, because the names were compared backwards; undated names come last, in name order
    expect(passports.rows.map((r) => r.name)).toEqual(["testnet-interrupt-2026-10-10T07-52-26-516Z.passport.json", "testnet-wallet-2026-10-10T07-35-28-806Z.passport.json", "testnet-wallet-2026-10-08T10-50-41-609Z.passport.json", "orphan.anchors.json", "testnet-cli-r3-b582ac16/evidence/chain/fee-tx.json"]);
    expect(passports.rows[1].anchors).toEqual({ path: "selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.anchors.json", bytes: 202 });
    expect(passports.rows[0].anchors).toBeNull(); expect(passports.bytes).toBe(78482 + 202 + 78539 + 202 + 78532 + 200 + 3000);
    expect(groups[0].rows.map((r) => r.name)).toEqual(["baseline-testnet-CHANGED-bbbb.json", "baseline-testnet-MAIN-aaaa.json"]); // no moment in either name: name order
  });
  it("review of c3afab7 (P3): rows follow the moment their names carry — full stamps, days and compact days alike — the folder's date stands in for an undated name, names without any date come last, and the name only breaks ties", () => {
    // names from the live manifest whose reverse spelling put older records on top (wallet-acceptance 10-09 above lifecycle 10-10, payment-recovery above everything of "testnet-2026…")
    const selftest = ["selftest/wallet-acceptance-2026-10-09T19-28-51Z.json", "selftest/testnet-relay-probe-2026-10-07T15-21-18-879Z.json", "selftest/testnet-payment-recovery-20261003.json", "selftest/testnet-lifecycle-2026-10-10T07-53-30-995Z.json", "selftest/testnet-cli-crash-recovery-2026-10-08.json", "selftest/testnet-2026-10-09T12-37-36-651Z.json", "selftest/testnet-delayed-rpc-runs-2026-10-09.json"];
    expect(groupEvidenceFiles(selftest.map((path) => ({ path, bytes: 1 })))[0].rows.map((r) => r.name)).toEqual([
      "testnet-lifecycle-2026-10-10T07-53-30-995Z.json", "wallet-acceptance-2026-10-09T19-28-51Z.json", "testnet-2026-10-09T12-37-36-651Z.json", "testnet-delayed-rpc-runs-2026-10-09.json" /* a day only: the start of that day */,
      "testnet-cli-crash-recovery-2026-10-08.json", "testnet-relay-probe-2026-10-07T15-21-18-879Z.json", "testnet-payment-recovery-20261003.json"]);
    // a rehearsal folder: the journal carries no date of its own and takes the folder's day; the stamped records of that day sort above it, newest first
    const rehearsal = ["selftest/deploy-resume-rehearsal-2026-10-10/deploy-testnet-journal.json", "selftest/deploy-resume-rehearsal-2026-10-10/preflight/deploy-testnet-2026-10-10T02-45-42-460Z.json", "selftest/deploy-resume-rehearsal-2026-10-10/signed-before-broadcast/preflight/deploy-testnet-2026-10-10T07-20-46-599Z.json"];
    expect(groupEvidenceFiles(rehearsal.map((path) => ({ path, bytes: 1 })))[0].rows.map((r) => r.name)).toEqual(["signed-before-broadcast/preflight/deploy-testnet-2026-10-10T07-20-46-599Z.json", "preflight/deploy-testnet-2026-10-10T02-45-42-460Z.json", "deploy-testnet-journal.json"]);
    // the root folder of the live manifest: dated records newest first, the digest-named baselines after them in name order
    const root = ["baseline-testnet-MAIN-a49274a6.json", "baseline-testnet-CHANGED-016e7586.json", "g0-probe-2026-10-02T11-54-53-149Z.json", "deploy-testnet-2026-10-02T13-49-44-915Z.json", "fund-testnet-2026-10-09T15-58-25-343Z.json", "deploy-testnet-2026-10-07T16-06-32-482Z.json"];
    expect(groupEvidenceFiles(root.map((path) => ({ path, bytes: 1 })))[0].rows.map((r) => r.name)).toEqual(["fund-testnet-2026-10-09T15-58-25-343Z.json", "deploy-testnet-2026-10-07T16-06-32-482Z.json", "deploy-testnet-2026-10-02T13-49-44-915Z.json", "g0-probe-2026-10-02T11-54-53-149Z.json", "baseline-testnet-CHANGED-016e7586.json", "baseline-testnet-MAIN-a49274a6.json"]);
    // the moment itself
    expect(stampOf("selftest/passports/testnet-wallet-2026-10-10T07-35-28-806Z.passport.json")).toBe(Date.UTC(2026, 9, 10, 7, 35, 28, 806));
    expect(stampOf("selftest/wallet-acceptance-2026-10-09T14-35-45Z.json")).toBe(Date.UTC(2026, 9, 9, 14, 35, 45));
    expect(stampOf("spend/testnet-plan-rehearsal-deploy-20261010.json")).toBe(Date.UTC(2026, 9, 10)); expect(stampOf("selftest/testnet-cli-crash-recovery-2026-10-08.json")).toBe(Date.UTC(2026, 9, 8));
    expect(stampOf("selftest/deploy-resume-rehearsal-2026-10-10/preflight/deploy-testnet-2026-10-09T23-59-59-000Z.json")).toBe(Date.UTC(2026, 9, 9, 23, 59, 59)); // the name's own moment wins over the folder's day
    expect(stampOf("baseline-testnet-MAIN-a49274a6.json")).toBeNull(); expect(stampOf("runs/testnet-APPROVED_PAYMENT-235486c1-8371-46b6-a9a2-d52d00cb2aec.json")).toBeNull();
    expect(stampOf("selftest/passports/testnet-cli-r3-b582ac16/evidence/report/0xab20261003cd9f.json")).toBeNull(); // eight digits inside a hex digest are not a day
    expect(stampOf("x/odd-2026-13-40T99-99Z.json")).toBeNull(); // not a moment
    // the comparator alone: moments descending, null after every moment, names for ties
    const rows = [{ at: null, name: "b" }, { at: 2, name: "x" }, { at: null, name: "a" }, { at: 5, name: "z" }, { at: 5, name: "y" }];
    expect([...rows].sort(byNewest).map((r) => `${r.at}:${r.name}`)).toEqual(["5:y", "5:z", "2:x", "null:a", "null:b"]);
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
