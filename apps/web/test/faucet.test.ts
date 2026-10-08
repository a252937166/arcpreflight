import { describe, expect, it } from "vitest";
import { DEFAULT_GAS_RESERVE_NATIVE_ATOMIC, budgetCheck, faucetOffered, gasReserveNativeAtomic, requiredNativeAtomic } from "../src/lib/faucet";
import { ACCOUNT } from "./fixtures";

// The budget check before a paid step (docs/LIFECYCLE.md §9): required = check fee + order amount + gas reserve; the faucet card uses the same number.
const NET: any = { network: "testnet", chainId: 5042002, faucet: { enabled: true, amountNativeAtomic: "200000000000000000", perDay: 30, usedToday: 0, perAddressPer24h: 1, sender: null } };
describe("budget", () => {
  it("required = fee (6-dec → 18-dec) + order amount + gas reserve; the plan's gasLimit × maxFeePerGas replaces the 100 000 × 30 gwei default", () => {
    expect(DEFAULT_GAS_RESERVE_NATIVE_ATOMIC).toBe(3_000_000_000_000_000n); // 0.003 USDC
    expect(gasReserveNativeAtomic(null)).toBe(DEFAULT_GAS_RESERVE_NATIVE_ATOMIC);
    expect(gasReserveNativeAtomic({ gasLimit: "40735", maxFeePerGasNativeAtomic: "29000000000" })).toBe(1_181_315_000_000_000n);
    expect(requiredNativeAtomic({ feeTokenAtomic: "10000", amountNativeAtomic: "4000000000000000" })).toBe(10_000_000_000_000_000n + 4_000_000_000_000_000n + 3_000_000_000_000_000n); // 0.017 USDC
    expect(requiredNativeAtomic({ feeTokenAtomic: "10000", amountNativeAtomic: "50000000000000000", plan: { gasLimit: "40735", maxFeePerGasNativeAtomic: "29000000000" } })).toBe(61_181_315_000_000_000n);
    expect(requiredNativeAtomic({ feeTokenAtomic: null, amountNativeAtomic: null })).toBe(DEFAULT_GAS_RESERVE_NATIVE_ATOMIC);
    // once the report is bought its fee is paid: executing needs the order and the gas only
    expect(requiredNativeAtomic({ feeTokenAtomic: "10000", amountNativeAtomic: "1000000000000000", feePaid: true })).toBe(4_000_000_000_000_000n);
    expect(budgetCheck(5_900_000_000_000_000n, { feeTokenAtomic: "10000", amountNativeAtomic: "1000000000000000", feePaid: true })).toMatchObject({ enough: true });
    expect(budgetCheck(1_000_000_000_000_000n, { feeTokenAtomic: "10000", amountNativeAtomic: "1000000000000000", feePaid: true }).sentence).toBe("your wallet holds 0.001 USDC; this step needs ≥ 0.004 USDC (order + gas; the check fee is already paid)");
  });
  it("the disabled button's sentence names both numbers exactly; a known-enough balance has no sentence; an unread balance decides nothing", () => {
    const i = { feeTokenAtomic: "10000", amountNativeAtomic: "4000000000000000" };
    expect(budgetCheck(0n, i)).toEqual({ required: 17_000_000_000_000_000n, balance: 0n, enough: false, sentence: "your wallet holds 0 USDC; this step needs ≥ 0.017 USDC (fee + order + gas)" });
    expect(budgetCheck(12_345_000_000_000_000n, i).sentence).toBe("your wallet holds 0.012345 USDC; this step needs ≥ 0.017 USDC (fee + order + gas)");
    expect(budgetCheck(17_000_000_000_000_000n, i)).toMatchObject({ enough: true, sentence: null });
    expect(budgetCheck(null, i)).toMatchObject({ enough: null, sentence: null });
  });
  it("the faucet card's threshold is the step's required amount, not a fixed 0.05", () => {
    const wallet = { account: ACCOUNT, chainId: 5042002 };
    expect(faucetOffered(NET, wallet, 40_000_000_000_000_000n, 17_000_000_000_000_000n)).toBe(false); // 0.04 ≥ 0.017: funded for this step
    expect(faucetOffered(NET, wallet, 40_000_000_000_000_000n, 63_000_000_000_000_000n)).toBe(true); // 0.04 < 0.063: offered
    expect(faucetOffered(NET, wallet, null, 1n)).toBe(false);
    expect(faucetOffered({ ...NET, network: "mainnet", chainId: 5042 }, { account: ACCOUNT, chainId: 5042 }, 0n, 1n)).toBe(false); // never on mainnet
    expect(faucetOffered(NET, { account: ACCOUNT, chainId: 1 }, 0n, 1n)).toBe(false);
  });
});
