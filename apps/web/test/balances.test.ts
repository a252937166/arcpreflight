import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT } from "./fixtures";
import { BALANCE_SIGNAL_KEY, balancesOf, onBalanceSignal, refreshBalances, resetBalanceStore, subscribeBalances } from "../src/lib/balances";

// The shared balance store (presentation review 2026-10-09, finding 2): one reading per (provider, account) for every view of a wallet,
// refreshed from anywhere, re-read until the node reports the change, and told to other tabs through the storage key they watch.
const USDC = "0x3600000000000000000000000000000000000000";
const OTHER = "0x00000000000000000000000000000000000000b2";
function provider(balances: Record<string, () => bigint>) {
  const p: any = { request: vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
    if (method === "eth_getBalance") return `0x${balances[String(params![0]).toLowerCase()]().toString(16)}`;
    if (method === "eth_call") return `0x${(1n).toString(16).padStart(64, "0")}`;
    throw new Error(`unexpected ${method}`);
  }) };
  p.reads = (addr = ACCOUNT) => p.request.mock.calls.filter((c: any[]) => c[0].method === "eth_getBalance" && String(c[0].params[0]).toLowerCase() === addr.toLowerCase()).length;
  return p;
}
const flush = () => vi.advanceTimersByTimeAsync(0);
let storage: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); resetBalanceStore(); storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
});
afterEach(() => { resetBalanceStore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared wallet balances", () => {
  it("two views of one wallet share one reading: a mount reads once, a refresh from either view reaches both listeners", async () => {
    let bal = 180_000_000_000_000_000n; const p = provider({ [ACCOUNT.toLowerCase()]: () => bal });
    const seenA: (bigint | null)[] = [], seenB: (bigint | null)[] = [];
    const offA = subscribeBalances(p, ACCOUNT, USDC, () => seenA.push(balancesOf(p, ACCOUNT).native));
    await flush();
    expect(balancesOf(p, ACCOUNT)).toMatchObject({ native: 180_000_000_000_000_000n, erc20: 1n }); expect(p.reads()).toBe(1);
    const offB = subscribeBalances(p, ACCOUNT, null, () => seenB.push(balancesOf(p, ACCOUNT).native));
    await flush(); expect(p.reads()).toBe(2); // the second view re-reads once too (the cached value showed meanwhile)
    bal = 117_000_000_000_000_000n;
    await refreshBalances(p, ACCOUNT); // what the Developer page does after a settled fee or a confirmed payment
    expect(seenA.at(-1)).toBe(117_000_000_000_000_000n); expect(seenB.at(-1)).toBe(117_000_000_000_000_000n); // the chip's view follows the page's refresh
    expect(balancesOf(p, ACCOUNT).erc20).toBe(1n); // the ERC-20 face asked for by view A is read for everyone
    offA(); offB();
  });
  it("until-changed: re-reads every 2 s while the node reports the old value, up to 8 times; a value equal to `expect` settles at once; `untilChanged: false` reads once", async () => {
    let bal = 10n ** 18n; const p = provider({ [ACCOUNT.toLowerCase()]: () => bal });
    const off = subscribeBalances(p, ACCOUNT, null, () => {}); await flush(); expect(p.reads()).toBe(1);
    const loop = refreshBalances(p, ACCOUNT); await flush(); expect(p.reads()).toBe(2); // first read: unchanged → wait
    await vi.advanceTimersByTimeAsync(2000); expect(p.reads()).toBe(3);
    bal = 990_000_000_000_000_000n; await vi.advanceTimersByTimeAsync(2000); await loop; expect(p.reads()).toBe(4);
    expect(balancesOf(p, ACCOUNT).native).toBe(990_000_000_000_000_000n);
    // never more than 8 re-reads for a value that does not move
    const n0 = p.reads(); const stuck = refreshBalances(p, ACCOUNT); await vi.advanceTimersByTimeAsync(2000 * 9); await stuck; expect(p.reads()).toBe(n0 + 9);
    // `expect`: the value another view or tab saw is enough
    const n1 = p.reads(); await refreshBalances(p, ACCOUNT, { expect: 990_000_000_000_000_000n }); expect(p.reads()).toBe(n1 + 1);
    const n2 = p.reads(); await refreshBalances(p, ACCOUNT, { untilChanged: false }); expect(p.reads()).toBe(n2 + 1);
    off();
  });
  it("a new refresh supersedes a running loop; the last view leaving stops it; a provider error keeps the last reading", async () => {
    let bal = 10n ** 18n; let fail = false;
    const p = provider({ [ACCOUNT.toLowerCase()]: () => { if (fail) throw new Error("rpc down"); return bal; } });
    const off = subscribeBalances(p, ACCOUNT, null, () => {}); await flush();
    const first = refreshBalances(p, ACCOUNT); await flush();
    bal = 5n; const second = refreshBalances(p, ACCOUNT, { untilChanged: false }); await first; await second;
    expect(balancesOf(p, ACCOUNT).native).toBe(5n);
    const n = p.reads(); void refreshBalances(p, ACCOUNT); await flush(); off(); await vi.advanceTimersByTimeAsync(10_000); expect(p.reads()).toBe(n + 1); // stopped with the view
    const off2 = subscribeBalances(p, ACCOUNT, null, () => {}); await flush(); fail = true; await refreshBalances(p, ACCOUNT); expect(balancesOf(p, ACCOUNT).native).toBe(5n); off2();
  });
  it("other tabs: a change is written under the signal key; a signal from another tab makes every view of that account re-read until it sees that value; this tab's own signal and other accounts are ignored", async () => {
    let bal = 180_000_000_000_000_000n, other = 7n;
    const p = provider({ [ACCOUNT.toLowerCase()]: () => bal, [OTHER]: () => other });
    const offA = subscribeBalances(p, ACCOUNT, null, () => {}); const offO = subscribeBalances(p, OTHER, null, () => {}); await flush();
    bal = 117_000_000_000_000_000n; await refreshBalances(p, ACCOUNT);
    const written = JSON.parse(storage.get(BALANCE_SIGNAL_KEY)!); expect(written).toMatchObject({ account: ACCOUNT.toLowerCase(), native: "117000000000000000" }); expect(typeof written.tab).toBe("string");
    const nA = p.reads(), nO = p.reads(OTHER);
    onBalanceSignal(storage.get(BALANCE_SIGNAL_KEY)!); await flush(); expect(p.reads()).toBe(nA); // our own signal (same tab id): nothing
    // another tab saw 0.056 before this tab's node did: re-read until that value shows
    let served = 0; const lagging = [117_000_000_000_000_000n, 117_000_000_000_000_000n, 56_000_000_000_000_000n];
    bal = lagging[0]; const pLag = provider({ [ACCOUNT.toLowerCase()]: () => lagging[Math.min(served++, lagging.length - 1)] });
    const offL = subscribeBalances(pLag, ACCOUNT, null, () => {}); await flush(); served = 0;
    onBalanceSignal(JSON.stringify({ account: ACCOUNT, native: "56000000000000000", at: 1, tab: "other-tab" }));
    await flush(); await vi.advanceTimersByTimeAsync(2000); await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(balancesOf(pLag, ACCOUNT).native).toBe(56_000_000_000_000_000n);
    expect(p.reads(OTHER)).toBe(nO); // the other account was never asked to re-read
    onBalanceSignal("not json"); onBalanceSignal(null); onBalanceSignal(JSON.stringify({ tab: "x" })); // malformed signals are ignored
    offA(); offO(); offL();
  });
});
