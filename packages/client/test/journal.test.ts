import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { SpendRefused } from "../src/spend.js";
import { complete, confirmedAddress, journalMatches, markConfirmed, markManifestWritten, markReverted, markSigned, newJournal, nextNonce, plannedNonce, reconcileSigned, summarize, unfinished } from "../src/journal.js";

// Gate D review 2026-10-10, P1: a deployment that stops after a confirmation and before the manifest must resume with the unfinished
// steps only — a confirmed step is never deployed again, a signed step never signed twice; what the chain holds decides.
const D = "0xDBb3598F78A9a8888d89E96F938aB0A719b075aA" as Hex;
const STEPS = [{ key: "implA", label: "implA" }, { key: "implB", label: "implB" }, { key: "proxyMAIN", label: "MAIN proxy" }];
const H = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;
const base = () => newJournal({ network: "mainnet", chainId: 5042, deployer: D, steps: STEPS, now: "2026-10-10T00:00:00.000Z" });

describe("deployment journal", () => {
  it("records the identity before the broadcast and the outcome after it; a confirmed step is never signed again, a second signature for a signed step is refused", () => {
    let j = base();
    expect(unfinished(j).map((s) => s.key)).toEqual(["implA", "implB", "proxyMAIN"]);
    j = markSigned(j, "implA", { nonce: 2, txHash: H(1), raw: "0x02aa" as Hex, now: "2026-10-10T00:00:01.000Z" });
    expect(j.steps[0]).toMatchObject({ status: "signed", nonce: 2, txHash: H(1), raw: "0x02aa" });
    expect(markSigned(j, "implA", { nonce: 2, txHash: H(1), raw: "0x02aa" as Hex }).steps[0].status).toBe("signed"); // the same bytes again: a re-send, fine
    expect(() => markSigned(j, "implA", { nonce: 2, txHash: H(9), raw: "0x02bb" as Hex })).toThrow(/different transaction .* already signed/);
    j = markConfirmed(j, "implA", { address: "0x00e393aCDCD8cfBef4Ab5D0F826bEBD87bf4Ae14" as Hex, block: "100", gasUsed: "1067071", effectiveGasPrice: "20000000000" });
    expect(() => markSigned(j, "implA", { nonce: 3, txHash: H(2), raw: "0x02cc" as Hex })).toThrow(/already confirmed .* never signed again/);
    expect(confirmedAddress(j, "implA")).toBe("0x00e393aCDCD8cfBef4Ab5D0F826bEBD87bf4Ae14");
    expect(() => confirmedAddress(j, "implB")).toThrow(SpendRefused);
    expect(unfinished(j).map((s) => s.key)).toEqual(["implB", "proxyMAIN"]); expect(complete(j)).toBe(false);
    expect(() => markConfirmed(j, "implB", { address: null, block: "1", gasUsed: "1", effectiveGasPrice: "1" })).toThrow(/never signed/);
    expect(summarize(j)[0]).toContain("confirmed"); expect(summarize(j)[0]).toContain("→ 0x00e393aCDCD8cfBef4Ab5D0F826bEBD87bf4Ae14");
  });
  it("a restart reconciles a signed step from the chain: mined → confirm; held by the node → wait; unknown with the nonce free → re-send the identical bytes; unknown with the nonce consumed → conflict (manual); reverted → stop", () => {
    const j = markSigned(base(), "implB", { nonce: 3, txHash: H(5), raw: "0x02dd" as Hex });
    const step = j.steps[1];
    const rc = { contractAddress: "0x816Ca9Da6D3A316D9b4cFf414890b07cBC95B399" as Hex, blockNumber: "101", gasUsed: "1095198", effectiveGasPrice: "20000000000" };
    expect(reconcileSigned(step, { receipt: { status: "success", ...rc }, known: true, nonceLatest: 4 }).action).toBe("confirm");
    expect(reconcileSigned(step, { receipt: { status: "reverted", ...rc }, known: true, nonceLatest: 4 }).action).toBe("reverted");
    expect(reconcileSigned(step, { receipt: null, known: true, nonceLatest: 3 }).action).toBe("wait");
    expect(reconcileSigned(step, { receipt: null, known: false, nonceLatest: 3 }).action).toBe("resend");
    const c = reconcileSigned(step, { receipt: null, known: false, nonceLatest: 4 }); expect(c.action).toBe("conflict"); expect(c.reason).toContain("never re-signed");
    expect(() => reconcileSigned(j.steps[0], { receipt: null, known: false, nonceLatest: 3 })).toThrow(/only a signed step/);
  });
  it("the next nonce follows the journal and must agree with the chain; the journal must belong to this deployment; the manifest is recorded", () => {
    let j = base();
    expect(nextNonce(j, 2)).toBe(2);
    j = markConfirmed(markSigned(j, "implA", { nonce: 2, txHash: H(1), raw: "0x02aa" as Hex }), "implA", { address: D, block: "1", gasUsed: "1", effectiveGasPrice: "1" });
    expect(nextNonce(j, 3)).toBe(3);
    expect(() => nextNonce(j, 2)).toThrow(/behind the journal/);
    expect(() => nextNonce(j, 5)).toThrow(/moved outside the journal/);
    expect(journalMatches(j, { network: "mainnet", chainId: 5042, deployer: D, steps: STEPS })).toBeNull();
    expect(journalMatches(j, { network: "testnet", chainId: 5042002, deployer: D, steps: STEPS })).toMatch(/is for mainnet/);
    expect(journalMatches(j, { network: "mainnet", chainId: 5042, deployer: "0x0000000000000000000000000000000000000001" as Hex, steps: STEPS })).toMatch(/deployer/);
    expect(journalMatches(j, { network: "mainnet", chainId: 5042, deployer: D, steps: STEPS.slice(0, 2) })).toMatch(/steps/);
    j = markReverted(j, "implB", "status reverted"); expect(j.steps[1].status).toBe("reverted"); expect(complete(j)).toBe(false);
    const done = markManifestWritten(j, "2026-10-10T01:00:00.000Z"); expect(done.manifestWrittenAt).toBe("2026-10-10T01:00:00.000Z");
  });
});

describe("audit 2026-10-10 (OP-01): a step signed before the broadcast is reconciled by re-sending, never refused by the nonce check", () => {
  it("signed nonce 2, chain pending 2, node knows nothing: reconcile says re-send; the nonce check is not consulted before that; after the confirmation the next nonce is 3", () => {
    let j = markSigned(base(), "implA", { nonce: 2, txHash: H(1), raw: "0x02aa" as Hex });
    expect(reconcileSigned(j.steps[0], { receipt: null, known: false, nonceLatest: 2 }).action).toBe("resend");
    expect(plannedNonce(j, 2)).toBe(3); // the plan shows the journal's next nonce without asking the chain
    expect(() => nextNonce(j, 2)).toThrow(/not reconciled yet/); // and the chain check refuses to run ahead of the reconciliation
    j = markConfirmed(j, "implA", { address: D, block: "7", gasUsed: "1", effectiveGasPrice: "1" }); // the re-sent bytes were mined
    expect(nextNonce(j, 3)).toBe(3); expect(plannedNonce(base(), 5)).toBe(5);
  });
});
