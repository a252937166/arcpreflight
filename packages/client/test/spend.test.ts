import { describe, expect, it } from "vitest";
import { OutflowMeter, SpendGuard, SpendRefused, parseUsdc18, usdc18, worstCaseOf } from "../src/spend.js";

// Gate D: enforced spending limits — per transaction and in total, gas included, a max-fee ceiling, re-runs continue the same total.
const GWEI = 10n ** 9n, U = (s: string) => parseUsdc18(s);
const limits = { label: "deploy", network: "mainnet", perTxNativeAtomic: U("0.05"), totalNativeAtomic: U("0.15"), maxFeePerGasCeiling: 40n * GWEI };
const tx = (gasLimit: bigint, maxFee = 30n, over: Record<string, unknown> = {}) => ({ purpose: "t", gasLimit, maxFeePerGas: maxFee * GWEI, ...over });

describe("amounts", () => {
  it("parses and renders exact USDC", () => {
    expect(parseUsdc18("0.15")).toBe(150_000_000_000_000_000n); expect(parseUsdc18("1")).toBe(10n ** 18n); expect(usdc18(1_500_000_000_000_001n)).toBe("0.001500000000000001"); expect(usdc18(0n)).toBe("0");
    for (const bad of ["-1", "1e18", "0.1.2", "", "abc", "0." + "1".repeat(19)]) expect(() => parseUsdc18(bad), bad).toThrow(SpendRefused);
    expect(worstCaseOf({ purpose: "x", valueNativeAtomic: 5n, tokenNativeEquivalent: 7n, gasLimit: 10n, maxFeePerGas: 3n })).toBe(42n);
  });
});

describe("SpendGuard", () => {
  it("refuses a transaction whose worst case (value + token + gasLimit × maxFee) exceeds the per-transaction cap", () => {
    const g = new SpendGuard(limits);
    expect(g.check(tx(1_300_000n))).toBe(39_000_000_000_000_000n); // 1.3M gas × 30 gwei = 0.039
    expect(() => g.check(tx(1_700_000n))).toThrow(/exceeds the per-transaction cap of 0.05 USDC/); // 0.051
    expect(() => g.check(tx(21_000n, 30n, { valueNativeAtomic: U("0.05") }))).toThrow(/per-transaction cap/); // the value counts
    expect(() => g.check(tx(100_000n, 30n, { tokenNativeEquivalent: U("0.05") }))).toThrow(/per-transaction cap/); // a token amount counts
    expect(g.entries).toEqual([]); // check records nothing
  });
  it("refuses a max fee above the ceiling and a missing gas limit", () => {
    const g = new SpendGuard(limits);
    expect(() => g.check(tx(21_000n, 41n))).toThrow(/above the ceiling of 40 gwei/);
    expect(() => g.check(tx(0n))).toThrow(/explicit and positive/);
  });
  it("keeps a running total: reserved and sent entries count at their worst case, settled ones at their actual cost, released ones not at all", () => {
    const g = new SpendGuard(limits);
    const a = g.reserve(tx(1_300_000n)); g.sent(a, "0xaa"); expect(g.committed()).toBe(U("0.039"));
    g.settle(a, U("0.0267")); expect(g.committed()).toBe(U("0.0267"));
    const b = g.reserve(tx(1_300_000n)); g.settle(b, U("0.0274"));
    const c = g.reserve(tx(1_300_000n)); g.sent(c, "0xcc"); // outcome unknown: stays at its worst case
    expect(g.committed()).toBe(U("0.0267") + U("0.0274") + U("0.039"));
    expect(() => g.reserve(tx(1_700_000n, 30n))).toThrow(SpendRefused); // per-tx first
    const d = g.reserve(tx(1_000_000n)); g.release(d); expect(g.entries[d].status).toBe("released");
    expect(() => g.release(c)).toThrow(/cannot be released/); // a sent entry may have reached the network
    g.reserve(tx(1_400_000n)); expect(g.committed()).toBe(U("0.1351")); // 0.0931 + 0.042 fits under 0.15
    expect(() => g.reserve(tx(1_300_000n))).toThrow(/0.1351 USDC already committed \+ worst case 0.039 USDC exceeds the deploy total cap of 0.15 USDC/);
  });
  it("a re-run continues the same total from the persisted entries", () => {
    const first = new SpendGuard(limits); const i = first.reserve(tx(1_300_000n)); first.sent(i, "0x1"); first.settle(i, U("0.14"));
    const rerun = new SpendGuard(limits, JSON.parse(JSON.stringify(first.entries)));
    expect(rerun.committed()).toBe(U("0.14")); expect(rerun.remaining()).toBe(U("0.01"));
    expect(() => rerun.reserve(tx(400_000n))).toThrow(/total cap/); // 0.012 > the 0.01 left
    expect(rerun.summary()).toMatchObject({ committedUsdc: "0.14", remainingUsdc: "0.01", perTxCapUsdc: "0.05", totalCapUsdc: "0.15", maxFeeCeilingGwei: "40" });
  });
  it("refuses non-positive limits", () => { expect(() => new SpendGuard({ ...limits, totalNativeAtomic: 0n })).toThrow(SpendRefused); });
  it("a signed token authorization counts its token amount, carries no gas and is not subject to the fee ceiling", () => {
    const g = new SpendGuard({ ...limits, perTxNativeAtomic: U("0.03"), totalNativeAtomic: U("0.05") });
    const fee = g.reserve({ purpose: "check fee authorization", tokenNativeEquivalent: U("0.01"), gasLimit: 0n, maxFeePerGas: 0n, authorization: true });
    expect(g.committed()).toBe(U("0.01")); g.settle(fee, U("0.01"));
    expect(() => g.check({ purpose: "x", tokenNativeEquivalent: U("0.04"), gasLimit: 0n, maxFeePerGas: 0n, authorization: true })).toThrow(/per-transaction cap of 0.03/);
    expect(() => g.check({ purpose: "x", tokenNativeEquivalent: U("0.01"), gasLimit: 21_000n, maxFeePerGas: 0n, authorization: true })).toThrow(/carries no gas/);
    expect(() => g.check({ purpose: "y", gasLimit: 0n, maxFeePerGas: 0n })).toThrow(/explicit and positive/); // a transaction must say its gas
    g.reserve(tx(40_735n, 29n, { valueNativeAtomic: U("0.005") })); // the wallet's business transaction: 0.005 + 40,735 × 29 gwei
    expect(g.committed()).toBe(U("0.01") + U("0.005") + 40_735n * 29n * GWEI);
  });
});

describe("OutflowMeter", () => {
  it("measures the drop of the summed balances and refuses a next step that could exceed the cap", () => {
    const m = new OutflowMeter("acceptance", U("0.30"), U("5.5"));
    expect(m.outflow(U("5.5") + 1n)).toBe(0n); // an increase is not negative outflow
    expect(m.headroomFor(U("5.3"), U("0.0742"))).toMatchObject({ ok: true, outflow: U("0.2") });
    expect(m.headroomFor(U("5.25"), U("0.0742"))).toMatchObject({ ok: false, reason: expect.stringMatching(/measured outflow 0.25 USDC \+ next step's worst case 0.0742 USDC exceeds the cap of 0.3 USDC/) });
  });
});
