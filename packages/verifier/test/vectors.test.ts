// AP32-32: every digest profile reproduces exact bytes against frozen vectors; old records are never re-hashed under new rules.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { keccak256, sha256, stringToBytes } from "viem";
import { canonicalize, digest } from "@arcpreflight/schema";
import { costStatement, formatAtomic } from "@arcpreflight/passport";
import { ACCEPTED_PROFILES } from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors/digests.json", import.meta.url), "utf8"));
const cost = JSON.parse(readFileSync(new URL("./vectors/cost.json", import.meta.url), "utf8"));

describe("digest profile vectors", () => {
  it("names exactly the three accepted profiles", () => {
    expect(vectors.profiles).toEqual({ jcs: ACCEPTED_PROFILES.jcs, legacy: ACCEPTED_PROFILES.legacy, file: ACCEPTED_PROFILES.file });
  });
  it("arcpreflight-jcs-keccak-1.0 reproduces the canonical bytes and digests", () => {
    expect(vectors.jcs.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors.jcs) {
      expect(canonicalize({ kind: v.kind, schemaVersion: v.schemaVersion, payload: v.payload }), v.kind).toBe(v.canonical);
      expect(digest(v.kind, v.schemaVersion, v.payload), v.kind).toBe(v.digest);
      expect(keccak256(stringToBytes(v.canonical))).toBe(v.digest);
    }
  });
  it("legacy-json-stringify-keccak-1.0 hashes the preimage bytes as stored", () => {
    for (const v of vectors.legacy) { expect(keccak256(stringToBytes(v.preimage))).toBe(v.digest); expect(JSON.stringify(JSON.parse(v.preimage))).toBe(v.preimage); }
  });
  it("sha256-file-1.0 hashes UTF-8 file bytes", () => {
    for (const v of vectors.file) expect(sha256(stringToBytes(v.content))).toBe(v.sha256);
    expect(vectors.file.some((v: any) => v.content === "")).toBe(true);
  });
});

describe("cost vectors", () => {
  it("gas × price is exact BigInt arithmetic with exact decimal rendering", () => {
    for (const v of cost.gas) {
      const c = costStatement({ buyer: "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE", relayer: null, orderCreator: null, businessPrincipalNativeAtomic: "0", businessPaid: false, checkFeeTokenAtomic: null, plan: null, policy: null, receipts: { businessTx: { gasUsed: v.gasUsed, effectiveGasPrice: v.effectiveGasPrice } }, txs: { businessTx: "0x" + "11".repeat(32) as `0x${string}` } });
      expect(c.buyer.businessGas!.nativeAtomic, `${v.gasUsed}×${v.effectiveGasPrice}`).toBe(v.nativeAtomic);
      expect(c.buyer.businessGas!.usdc).toBe(v.usdc);
      expect(BigInt(v.nativeAtomic)).toBe(BigInt(v.gasUsed) * BigInt(v.effectiveGasPrice));
    }
    expect(cost.gas.find((v: any) => v.gasUsed === "87141")).toMatchObject({ nativeAtomic: "2178525000000000", usdc: "0.002178525" });
    for (const v of cost.format) expect(formatAtomic(v.atomic, v.decimals), v.atomic).toBe(v.usdc);
  });
});
