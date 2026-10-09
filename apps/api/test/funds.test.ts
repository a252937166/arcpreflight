import { beforeEach, describe, expect, it } from "vitest";
import { fundsPass, fundsSnapshot, readFunds, resetFunds, type FundsRole } from "../src/funds.js";

// The low-balance watch (operator decision 2026-10-09): reads only, thresholds per role, logs on change, exposed on /v1/network.
const A: Record<FundsRole, string> = { "demo-runner": "0x00000000000000000000000000000000000000a1", "order-creator": "0x00000000000000000000000000000000000000a2", "merchant-payto": "0x00000000000000000000000000000000000000a3", "deployer-admin": "0x00000000000000000000000000000000000000a4" };
const WARN: Record<FundsRole, bigint> = { "demo-runner": 10n ** 18n, "order-creator": 2n * 10n ** 18n, "merchant-payto": 5n * 10n ** 17n, "deployer-admin": 10n ** 17n };
const client = (balances: Record<string, bigint | Error>) => ({ getBalance: async ({ address }: { address: string }) => { const b = balances[address.toLowerCase()]; if (b instanceof Error) throw b; return b ?? 0n; } });
const B = (over: Record<string, bigint | Error> = {}) => ({ [A["demo-runner"]]: 16n * 10n ** 18n, [A["order-creator"]]: 11n * 10n ** 18n, [A["merchant-payto"]]: 20n * 10n ** 18n, [A["deployer-admin"]]: 7n * 10n ** 18n, ...over });

beforeEach(() => resetFunds());

describe("readFunds", () => {
  it("reads every configured key, marks the ones below their threshold, and never calls an unreadable balance low", async () => {
    const s = await readFunds(client(B({ [A["order-creator"]]: 15n * 10n ** 17n, [A["merchant-payto"]]: new Error("rpc down") })), A, WARN, "2026-10-09T10:00:00.000Z");
    expect(s.checkedAt).toBe("2026-10-09T10:00:00.000Z"); expect(s.low).toBe(true);
    expect(s.keys.map((k) => `${k.role}:${k.low}`)).toEqual(["demo-runner:false", "order-creator:true", "merchant-payto:false", "deployer-admin:false"]);
    expect(s.keys[1]).toMatchObject({ balanceNativeAtomic: "1500000000000000000", warnBelowNativeAtomic: "2000000000000000000", note: expect.stringContaining("faucet") });
    expect(s.keys[2]).toMatchObject({ balanceNativeAtomic: null, low: false });
    expect(s.note).toMatch(/nothing is claimed or moved automatically/);
    // keys without an address are skipped (a mainnet instance without the order-creator key, a test instance without a runner)
    expect((await readFunds(client(B()), { "demo-runner": A["demo-runner"], "order-creator": null }, WARN)).keys.map((k) => k.role)).toEqual(["demo-runner"]);
  });
});

describe("fundsPass", () => {
  it("remembers the latest reading for /v1/network and logs only on change: newly low, recovered, unreadable", async () => {
    const log: string[] = [];
    expect(fundsSnapshot()).toMatchObject({ checkedAt: null, low: false, keys: [] });
    await fundsPass(client(B({ [A["demo-runner"]]: 5n * 10n ** 17n })), A, (m) => log.push(m), WARN, "2026-10-09T10:00:00.000Z");
    expect(log).toEqual([`LOW demo-runner ${A["demo-runner"]} holds 0.5000 USDC, below the 1.0000 USDC threshold — pays the project-funded demo runs (≈0.06 USDC each); top it up`]);
    expect(fundsSnapshot()).toMatchObject({ checkedAt: "2026-10-09T10:00:00.000Z", low: true });
    await fundsPass(client(B({ [A["demo-runner"]]: 4n * 10n ** 17n })), A, (m) => log.push(m), WARN, "2026-10-09T10:05:00.000Z");
    expect(log).toHaveLength(1); // still low: no repeat
    await fundsPass(client(B({ [A["demo-runner"]]: 3n * 10n ** 18n, [A["deployer-admin"]]: new Error("timeout") })), A, (m) => log.push(m), WARN, "2026-10-09T10:10:00.000Z");
    expect(log.slice(1)).toEqual([`OK demo-runner ${A["demo-runner"]} is back above its threshold: 3.0000 USDC`, `UNREAD deployer-admin ${A["deployer-admin"]}: the balance could not be read (last reading 7.0000 USDC)`]); // the last successful reading travels with the line
    expect(fundsSnapshot().low).toBe(false); expect(fundsSnapshot().keys[3].balanceNativeAtomic).toBeNull();
    await fundsPass(client(B({ [A["deployer-admin"]]: new Error("timeout") })), A, (m) => log.push(m), WARN);
    expect(log).toHaveLength(3); // still unreadable: no repeat
  });
});

describe("fundsPass keeps the last successfully observed alert state apart from read availability (review 2026-10-09)", () => {
  const low = () => B({ [A["order-creator"]]: 15n * 10n ** 17n }), down = () => B({ [A["order-creator"]]: new Error("rpc down") }), healthy = () => B({ [A["order-creator"]]: 5n * 10n ** 18n });
  it("LOW → UNREAD → healthy reports the recovery", async () => {
    const log: string[] = [];
    await fundsPass(client(low()), A, (m) => log.push(m), WARN);
    await fundsPass(client(down()), A, (m) => log.push(m), WARN);
    expect(fundsSnapshot().low).toBe(true); // the last observed state was low: an RPC failure does not clear the warning
    expect(fundsSnapshot().keys[1]).toMatchObject({ balanceNativeAtomic: null, low: false, lastObserved: { low: true, balanceNativeAtomic: "1500000000000000000" } });
    await fundsPass(client(healthy()), A, (m) => log.push(m), WARN);
    expect(log.map((m) => m.split(" ")[0])).toEqual(["LOW", "UNREAD", "OK"]);
    expect(log[2]).toBe(`OK order-creator ${A["order-creator"]} is back above its threshold: 5.0000 USDC`);
    expect(fundsSnapshot().low).toBe(false);
  });
  it("LOW → UNREAD → still LOW never repeats the low alert", async () => {
    const log: string[] = [];
    await fundsPass(client(low()), A, (m) => log.push(m), WARN);
    await fundsPass(client(down()), A, (m) => log.push(m), WARN);
    await fundsPass(client(B({ [A["order-creator"]]: 12n * 10n ** 17n })), A, (m) => log.push(m), WARN);
    await fundsPass(client(down()), A, (m) => log.push(m), WARN);
    await fundsPass(client(low()), A, (m) => log.push(m), WARN);
    expect(log.map((m) => m.split(" ")[0])).toEqual(["LOW", "UNREAD", "UNREAD"]); // one low alert; each loss of readability said once
    expect(fundsSnapshot().low).toBe(true);
  });
  it("a key that was never read successfully is not low, and its first healthy reading says nothing", async () => {
    const log: string[] = [];
    await fundsPass(client(down()), A, (m) => log.push(m), WARN);
    expect(fundsSnapshot().low).toBe(false); expect(fundsSnapshot().keys[1].lastObserved).toBeNull();
    await fundsPass(client(healthy()), A, (m) => log.push(m), WARN);
    expect(log.map((m) => m.split(" ")[0])).toEqual(["UNREAD"]);
  });
});
