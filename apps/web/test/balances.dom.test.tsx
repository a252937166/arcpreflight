// @vitest-environment jsdom
// The header chip and a page view of the same wallet, under real React: one shared balance (presentation review 2026-10-09, finding 2).
// Before the shared store the chip kept its own hook and showed 0.18 USDC while the Developer page had refreshed to 0.1170.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ACCOUNT } from "./fixtures";

const fake = vi.hoisted(() => ({ wallet: {} as any }));
vi.mock("../src/lib/wallet", async (original) => ({ ...await original<typeof import("../src/lib/wallet")>(), useWallet: () => fake.wallet }));
import { WalletChip } from "../src/components/WalletChip";
import { BALANCE_SIGNAL_KEY, resetBalanceStore, useBalances } from "../src/lib/balances";

const USDC = "0x3600000000000000000000000000000000000000";
const NET: any = { network: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: USDC, rpc: "http://offline.invalid", explorer: "http://explorer.invalid", priceTokenAtomic: "10000", fixtures: [], accounts: {}, faucet: { enabled: true, amountNativeAtomic: "200000000000000000", perDay: 30, usedToday: 1, perAddressPer24h: 1, sender: null } };
/** what the Developer page does: its own `useBalances` view, and a refresh after a settled fee or a confirmed payment */
function PageView({ provider }: { provider: any }) {
  const b = useBalances(provider, ACCOUNT, true, USDC);
  return <div><span data-testid="page-balance">{b.native === null ? "…" : b.native.toString()}</span><button data-testid="page-refresh" onClick={() => b.refresh()}>refresh</button></div>;
}
let root: Root; let host: HTMLDivElement; let balance: bigint;
const provider = { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_getBalance" ? `0x${balance.toString(16)}` : method === "eth_call" ? `0x${(1n).toString(16).padStart(64, "0")}` : "0x4cef52")) };
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }); };
const chipText = () => host.querySelector(".wallet-btn")!.textContent ?? "";
const pageText = () => host.querySelector("[data-testid=page-balance]")!.textContent ?? "";

beforeEach(() => {
  resetBalanceStore(); balance = 180_000_000_000_000_000n; provider.request.mockClear(); localStorage.clear();
  fake.wallet = { provider, info: { uuid: "mm", name: "MetaMask", icon: "", rdns: "io.metamask" }, account: ACCOUNT, chainId: 5042002, connecting: false, error: null, isTest: false, candidates: [], picker: false, searching: false, missing: null, switching: false,
    connect: vi.fn(), choose: vi.fn(), closePicker: vi.fn(), disconnect: vi.fn(), switchChain: vi.fn(), searchAgain: vi.fn(), dismissMissing: vi.fn() };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetBalanceStore(); });

describe("one balance for the header chip and the page", () => {
  it("the chip shows the page's refreshed value without the panel opening, and both follow a signal written by another tab", async () => {
    await act(async () => { root.render(<><WalletChip net={NET} /><PageView provider={provider} /></>); });
    await settle();
    expect(chipText()).toContain("0.18 USDC"); expect(pageText()).toBe("180000000000000000");
    const reads = () => provider.request.mock.calls.filter((c) => c[0].method === "eth_getBalance").length;
    expect(reads()).toBe(1); // both views mounted together: the second one joined the read in flight — one reading, read once
    // the fee settled: the page refreshes — the header follows at once (before: it kept 0.18 until a reload)
    balance = 117_000_000_000_000_000n;
    await act(async () => { (host.querySelector("[data-testid=page-refresh]") as HTMLButtonElement).click(); });
    await settle();
    expect(pageText()).toBe("117000000000000000"); expect(chipText()).toContain("0.12 USDC");
    expect(JSON.parse(localStorage.getItem(BALANCE_SIGNAL_KEY)!)).toMatchObject({ account: ACCOUNT.toLowerCase(), native: "117000000000000000" }); // other tabs are told
    // another tab paid and saw 0.056: this tab re-reads until it sees that value
    balance = 56_000_000_000_000_000n;
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: BALANCE_SIGNAL_KEY, newValue: JSON.stringify({ account: ACCOUNT.toLowerCase(), native: "56000000000000000", at: Date.now(), tab: "other-tab" }) })); });
    await settle();
    expect(pageText()).toBe("56000000000000000"); expect(chipText()).toContain("0.06 USDC");
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "arcpreflight.something-else", newValue: "x" })); }); await settle();
    expect(reads()).toBe(3); // a foreign key changes nothing
  });
});
