import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromBundle } from "@arcpreflight/passport";
import { verifyPassport } from "@arcpreflight/verifier";
process.env.MAINNET_SELFTEST_IMPORT_ONLY = "1";
const { signatureShapedValues } = await import("../selftest/mainnet.js");

// 2026-10-11: the first mainnet acceptance stopped after its first run (5cab2579, CHANGED_IMPLEMENTATION → REVIEW_REQUIRED, in order on
// chain) because the script's passport scan used an unbounded pattern (/[0-9a-f]{130}/) that matched substrings of the receipt's
// logsBloom, of contract bytecode and of eth_call results. The scan is now the verifier's exact rule: a 0x-prefixed 65-byte hex value.
const text = readFileSync(resolve(__dirname, "fixtures/mainnet-run-5cab2579.passport.json"), "utf8");
describe("the acceptance script's passport scan", () => {
  it("the real mainnet passport of run 5cab2579 carries no signature-shaped value; the pattern used before flagged it", () => {
    expect(signatureShapedValues(text)).toEqual([]);
    expect(/[0-9a-f]{130}/i.test(text.replace(/"input":"0x[0-9a-f]+"/gi, ""))).toBe(true); // what stopped the run: substrings of longer hex
    const files = fromBundle(text); expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(JSON.parse(files["evidence/chain/fee-tx.json"]).receipt.logsBloom).toMatch(/^0x[0-9a-f]{512}$/); // 256 bytes, never a signature
    const code = Object.entries(files).filter(([k]) => k.startsWith("evidence/report/")).map(([, v]) => JSON.parse(v).result).filter((r) => typeof r === "string" && r.length > 2000);
    expect(code.length).toBeGreaterThan(0); // the implementation's bytecode, read for its code hash
  });
  it("a signature-shaped value anywhere in the text is caught; hashes, blooms, code, calldata and other lengths are not", () => {
    const sig = `0x${"ab".repeat(65)}`;
    expect(signatureShapedValues(`{"payment":{"signature":"${sig}"}}`)).toEqual([sig]);
    expect(signatureShapedValues(`{"note":"sig ${sig} inline"}`)).toEqual([sig]);
    expect(signatureShapedValues(`{"hash":"0x${"cd".repeat(32)}","bloom":"0x${"00".repeat(256)}","code":"0x${"60".repeat(2000)}","input":"0x${"ef".repeat(100)}"}`)).toEqual([]);
    expect(signatureShapedValues(`{"x":"0x${"ab".repeat(66)}","y":"0x${"ab".repeat(64)}"}`)).toEqual([]);
  });
  it("the verifier's DISCLOSURE finding agrees: PASS offline for the real passport, FAIL once a signature is planted", async () => {
    const files = fromBundle(text);
    const v = await verifyPassport(files, { anchors: { baselineDigests: [], policyDigests: [] } });
    expect(v.findings.find((f) => f.id === "DISCLOSURE")?.status).toBe("PASS");
    const planted = { ...files, "payment.json": JSON.stringify({ ...JSON.parse(files["payment.json"]), signature: `0x${"ab".repeat(65)}` }) };
    const v2 = await verifyPassport(planted, { anchors: { baselineDigests: [], policyDigests: [] } });
    expect(v2.findings.find((f) => f.id === "DISCLOSURE")?.status).toBe("FAIL");
  });
});
