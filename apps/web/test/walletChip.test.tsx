import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT, NOW, response } from "./fixtures";

// The connected-wallet panel (review item 7): header (icon, name, network badge), short address + copy + "show full", the balance read
// through the wallet's provider, grouped actions, a faucet status area that tells "transaction sent" apart from "funds confirmed" (the
// receipt is read before "confirmed" is said), Disconnect set apart at the bottom. Same hook-mocking harness as pages.test.tsx.
const h = vi.hoisted(() => ({ cursor: 0, state: [] as any[], memo: [] as any[], effects: [] as any[], pending: [] as (() => void)[], net: {} as any, wallet: {} as any, receipt: (() => null) as () => any }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = typeof initial === "function" ? initial() : initial; return [h.state[i], (value: any) => { h.state[i] = typeof value === "function" ? value(h.state[i]) : value; }]; },
  useMemo: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn() }; return h.memo[i].value; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.state)) h.state[i] = { current: initial }; return h.state[i]; },
  useCallback: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.memo[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) h.memo[i] = { deps, value: fn }; return h.memo[i].value; },
  useEffect: (fn: any, deps: any[]) => { const i = h.cursor++; const old = h.effects[i]; if (!old || !deps || deps.some((d, j) => d !== old.deps[j])) h.pending.push(() => { old?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() }; }); },
}));
// the balance goes through the provider (eth_getBalance), so the test controls it like a wallet would
vi.mock("../src/lib/wallet", () => ({ useWallet: () => h.wallet, friendlyName: (i: any) => i.name, nativeBalance: async (p: any, a: string) => BigInt(await p.request({ method: "eth_getBalance", params: [a, "latest"] })), erc20Balance: async () => 1n, setTargetNetwork: vi.fn(), ensureChain: vi.fn() }));
import { WalletChip } from "../src/components/WalletChip";
import { awaitFaucetReceipt } from "../src/lib/faucet";
import { BALANCE_SIGNAL_KEY, onBalanceSignal, refreshBalances, resetBalanceStore } from "../src/lib/balances";
import { setApiBase } from "../src/lib/api";

function render(Page: () => any) { h.cursor = 0; const tree = Page(); for (const effect of h.pending.splice(0)) effect(); return tree; }
function nodes(tree: any): any[] { const all: any[] = []; const walk = (x: any) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { all.push(x); walk(x.props?.children); } }; walk(tree); return all; }
function content(tree: any): string { return nodes(tree).map((n) => JSON.stringify(n.props?.children, (_k, v) => typeof v === "bigint" ? v.toString() : v)).join(" "); }
/** the visible text in document order (string and number children concatenated), for sentences split across JSX expressions */
function text(tree: any): string { const out: string[] = []; const walk = (x: any) => { if (Array.isArray(x)) return x.forEach(walk); if (typeof x === "string" || typeof x === "number") { out.push(String(x)); return; } if (x && typeof x === "object") walk(x.props?.children); }; walk(tree); return out.join(""); }
function button(tree: any, label: string) { const b = nodes(tree).find((n) => n.type === "button" && content(n).includes(label)); if (!b) throw new Error(`button missing: ${label}`); return b; }
const panelOf = (tree: any) => nodes(tree).find((n) => n.props?.["data-testid"] === "wallet-panel");
const chip = () => render(() => WalletChip({ net: h.net }));
const flush = () => vi.advanceTimersByTimeAsync(0);
const CHIP = "0x0000…0a11";
const TX = `0x${"ab".repeat(32)}`;
const CLAIM = { ok: true, txHash: TX, amountNativeAtomic: "200000000000000000", address: ACCOUNT };
const balanceReads = () => h.wallet.provider.request.mock.calls.filter((c: any[]) => c[0].method === "eth_getBalance").length;
const receiptReads = () => h.wallet.provider.request.mock.calls.filter((c: any[]) => c[0].method === "eth_getTransactionReceipt").length;
let clipboard: { writeText: ReturnType<typeof vi.fn> };

async function openPanel() {
  let tree = chip(); await flush(); tree = chip();
  await button(tree, CHIP).props.onClick(); tree = chip(); await flush(); tree = chip();
  return tree;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  h.cursor = 0; h.state = []; h.memo = []; h.effects = []; h.pending = []; h.receipt = () => null; setApiBase(""); resetBalanceStore();
  h.net = { network: "testnet", chainId: 5042002, caip2: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000", rpc: "http://offline.invalid", explorer: "http://explorer.invalid", priceTokenAtomic: "10000", fixtures: [], accounts: {},
    budget: { maxRunsPerDay: 10, usedToday: 0, clientCooldownSeconds: 45, amountNativeAtomic: "50000000000000000", activeRun: null }, faucet: { enabled: true, amountNativeAtomic: "200000000000000000", perDay: 30, usedToday: 1, perAddressPer24h: 1, sender: null } };
  h.wallet = {
    provider: { request: vi.fn(async ({ method }: { method: string }) => (method === "eth_getBalance" ? "0xde0b6b3a7640000" : method === "eth_getTransactionReceipt" ? h.receipt() : method === "eth_chainId" ? "0x4cef52" : "0x1")) },
    info: { uuid: "okx", name: "OKX Wallet", icon: "data:image/png;base64,AAAA", rdns: "com.okex.wallet" }, account: ACCOUNT, chainId: 5042002, connecting: false, error: null, isTest: false, candidates: [], picker: false, switching: false,
    connect: vi.fn(), choose: vi.fn(), closePicker: vi.fn(), disconnect: vi.fn(), switchChain: vi.fn(),
  };
  clipboard = { writeText: vi.fn(async () => {}) };
  vi.stubGlobal("navigator", { clipboard });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { throw new Error(`unexpected fetch ${path}`); }));
});
afterEach(() => { for (const e of h.effects) e?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); setApiBase(""); });

describe("the connected-wallet panel", () => {
  it("header: icon, friendly name, an Arc Testnet badge and the short address; copy flips to 'copied ✓'; the full address is accessible and revealed by the toggle", async () => {
    let tree = await openPanel();
    const panel = panelOf(tree); expect(panel).toBeTruthy();
    expect(nodes(panel).some((n) => n.type === "img" && n.props.className === "wp-icon" && n.props.src === h.wallet.info.icon)).toBe(true);
    const text = content(panel);
    expect(text).toContain("OKX Wallet"); expect(text).toContain("Arc Testnet"); expect(text).toContain("0x000000…000a11"); // short(…, 6) with the copy button next to it
    expect(nodes(panel).some((n) => n.type === "code" && n.props.className === "wp-short" && n.props.title === ACCOUNT)).toBe(true); // the full address as the title/aria-label…
    expect(nodes(panel).some((n) => n.props?.className === "sr-only" && n.props.children === ACCOUNT)).toBe(true); // …and in the DOM for assistive tech before the toggle
    expect(nodes(panel).some((n) => n.props?.className === "wp-full")).toBe(false);
    await button(tree, "show full").props.onClick(); tree = chip();
    expect(nodes(tree).some((n) => n.type === "code" && n.props.className === "wp-full" && n.props.children === ACCOUNT)).toBe(true); expect(content(tree)).toContain("hide full");
    await button(tree, "copy").props.onClick(); expect(clipboard.writeText).toHaveBeenCalledWith(ACCOUNT);
    tree = chip(); expect(content(tree)).toContain("copied ✓");
    await vi.advanceTimersByTimeAsync(1300); tree = chip(); expect(content(tree)).not.toContain("copied ✓");
    // the explorer link and the faucet action are grouped as menu items; nothing here signs anything
    const actions = nodes(tree).find((n) => n.props?.className === "wp-actions");
    expect(nodes(actions).filter((n) => n.props?.role === "menuitem").map((n) => content(n))).toEqual([expect.stringContaining("View on explorer"), expect.stringContaining("Claim testnet USDC")]);
    expect(nodes(actions).some((n) => n.type === "a" && n.props.href === `http://explorer.invalid/address/${ACCOUNT}` && n.props.target === "_blank")).toBe(true);
  });
  it("balance: read through the provider on the API's chain, shown in the panel and as the chip suffix; re-read once (not the until-changed loop) when the panel opens", async () => {
    let tree = chip(); await flush(); tree = chip();
    expect(content(tree)).toContain("1.00 USDC"); // the chip suffix
    const before = balanceReads(); expect(before).toBe(1);
    await button(tree, CHIP).props.onClick(); tree = chip(); await flush(); tree = chip(); await flush(); tree = chip();
    const panel = panelOf(tree);
    expect(text(panel)).toContain("1 USDC on Arc Testnet");
    expect(balanceReads()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(6000); expect(balanceReads()).toBe(before + 1); // one read on open, no polling
  });
  it("the chip follows a refresh made by another view of the same wallet (the Developer page after a settled fee) and a signal from another tab — without the panel opening or a reload (2026-10-09)", async () => {
    let balance = "0x27f7d0bdb920000"; // 0.18 USDC
    h.wallet.provider.request.mockImplementation(async ({ method }: { method: string }) => (method === "eth_getBalance" ? balance : method === "eth_chainId" ? "0x4cef52" : "0x1"));
    let tree = chip(); await flush(); tree = chip();
    expect(content(tree)).toContain("0.18 USDC");
    balance = "0x19fb5ae2c7c4000"; // 0.117 USDC after the check fee: the Developer page's hook refreshes the shared store
    await refreshBalances(h.wallet.provider, ACCOUNT); tree = chip();
    expect(content(tree)).toContain("0.12 USDC"); expect(content(tree)).not.toContain("0.18 USDC");
    balance = "0xc6f3b40b6c0000"; // 0.056 USDC: another tab paid and wrote the signal
    onBalanceSignal(JSON.stringify({ account: ACCOUNT.toLowerCase(), native: "56000000000000000", at: 1, tab: "another-tab" })); await flush(); tree = chip();
    expect(content(tree)).toContain("0.06 USDC");
    expect(BALANCE_SIGNAL_KEY).toBe("arcpreflight.balances:signal");
  });
  it("off the API's chain: an amber 'not Arc' badge, the switch action, and no balance claim", async () => {
    h.wallet.chainId = 1;
    const tree = await openPanel(); const panel = panelOf(tree);
    expect(text(panel)).toContain("chain 1 · not Arc"); expect(text(panel)).toContain("Switch to Arc 5042002"); expect(text(panel)).toContain("balance is read once the wallet is on Arc Testnet");
    expect(balanceReads()).toBe(0);
    await button(tree, "Switch to Arc").props.onClick(); expect(h.wallet.switchChain).toHaveBeenCalledWith(h.net);
  });
  it("faucet: 'Transaction sent' with the tx link as soon as the API answers, 'Funds confirmed' only once the receipt was read through the provider; the balance is refreshed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { if (path === "/v1/faucet" && init?.method === "POST") { expect(JSON.parse(init.body as string)).toEqual({ address: ACCOUNT }); return response(CLAIM); } throw new Error(`unexpected ${path}`); }));
    let seen = 0; h.receipt = () => (++seen >= 2 ? { status: "0x1", blockNumber: "0x10" } : null);
    let tree = await openPanel();
    const readsBefore = balanceReads();
    const done = button(tree, "Claim testnet USDC").props.onClick();
    tree = chip(); expect(nodes(tree).find((n) => n.props?.role === "status")?.props["data-phase"]).toBe("sending");
    await flush(); tree = chip();
    let status = nodes(tree).find((n) => n.props?.role === "status");
    expect(status.props["data-phase"]).toBe("sent"); expect(status.props.className).toContain("info");
    expect(content(status)).toContain("Transaction sent"); expect(content(status)).toContain("+0.20 USDC"); expect(content(status)).not.toContain("Funds confirmed");
    expect(nodes(status).some((n) => n.type === "a" && n.props.href === `http://explorer.invalid/tx/${TX}`)).toBe(true);
    expect(button(tree, "Claim testnet USDC").props.disabled).toBe(true); // one claim at a time
    expect(receiptReads()).toBe(1); // the first receipt read answered null → polling
    await vi.advanceTimersByTimeAsync(2000); await done; tree = chip();
    status = nodes(tree).find((n) => n.props?.role === "status");
    expect(status.props["data-phase"]).toBe("confirmed"); expect(status.props.className).toContain("ok");
    expect(content(status)).toContain("Funds confirmed"); expect(content(status)).toContain("+0.20 USDC"); expect(content(status)).toContain("block #16");
    expect(nodes(status).some((n) => n.type === "a" && n.props.href === `http://explorer.invalid/tx/${TX}`)).toBe(true);
    expect(receiptReads()).toBe(2);
    await flush(); tree = chip(); await flush();
    expect(balanceReads()).toBeGreaterThan(readsBefore); // settled → the balance is re-read
    expect(button(tree, "Claim testnet USDC").props.disabled).toBe(false);
  });
  it("faucet: a receipt never seen inside the window reads 'confirmation not seen yet', never 'confirmed'; a refusal shows the readable reason in the same area", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(CLAIM)));
    let tree = await openPanel();
    const done = button(tree, "Claim testnet USDC").props.onClick();
    await flush(); await vi.advanceTimersByTimeAsync(61_000); await done; tree = chip();
    let status = nodes(tree).find((n) => n.props?.role === "status");
    expect(status.props["data-phase"]).toBe("unconfirmed"); expect(status.props.className).toContain("warn");
    expect(content(status)).toContain("confirmation not seen yet"); expect(content(status)).not.toContain("Funds confirmed");
    expect(nodes(status).some((n) => n.type === "a" && n.props.href === `http://explorer.invalid/tx/${TX}`)).toBe(true);
    // the cooldown refusal
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "FAUCET_COOLDOWN", reason: "one claim per wallet every 24 h; try again at 2026-10-04T12:00:00Z" }, 429)));
    await button(tree, "Claim testnet USDC").props.onClick(); tree = chip();
    status = nodes(tree).find((n) => n.props?.role === "status");
    expect(status.props["data-phase"]).toBe("error"); expect(status.props.className).toContain("bad"); expect(content(status)).toContain("one claim per wallet every 24 h");
  });
  it("on a mainnet instance there is no faucet action and the badge says Arc Mainnet", async () => {
    h.net = { ...h.net, network: "mainnet", chainId: 5042, caip2: "eip155:5042", faucet: { enabled: false } }; h.wallet.chainId = 5042;
    const tree = await openPanel(); const panel = panelOf(tree);
    expect(content(panel)).toContain("Arc Mainnet"); expect(content(panel)).not.toContain("Claim testnet USDC"); expect(content(panel)).toContain("View on explorer");
    expect(nodes(panel).some((n) => n.props?.role === "status")).toBe(false);
  });
  it("Disconnect is the last item, after a separator, and disconnects through the store", async () => {
    const tree = await openPanel(); const panel = panelOf(tree);
    const items = nodes(panel).filter((n) => n.props?.role === "menuitem");
    expect(content(items.at(-1))).toContain("Disconnect"); expect(items.at(-1).props.className).toContain("wp-disconnect");
    const kids = panel.props.children.filter(Boolean);
    expect(kids.at(-2).props.role).toBe("separator");
    await button(tree, "Disconnect").props.onClick(); expect(h.wallet.disconnect).toHaveBeenCalledTimes(1);
  });
  it("the test wallet keeps its tag in the header and the chip", async () => {
    h.wallet.isTest = true; h.wallet.info = { uuid: "arcpreflight-test-wallet", name: "Test wallet (local)", icon: "", rdns: "xyz.arcpreflight.testwallet" };
    const tree = await openPanel(); const panel = panelOf(tree);
    expect(content(panel)).toContain("Test wallet (local)"); expect(content(panel)).toContain("· test");
    expect(nodes(panel).some((n) => n.type === "img")).toBe(false); // no icon → the dot
  });
});

describe("the disconnected chip (real-wallet session: discovery in fresh and duplicated tabs)", () => {
  const disconnected = (over: Record<string, unknown>) => { Object.assign(h.wallet, { account: null, provider: null, info: null, chainId: null, picker: false, searching: false, missing: null, error: null, candidates: [], searchAgain: vi.fn(), dismissMissing: vi.fn() }, over); };
  it("the picker reads 'looking for wallets…' while late wallets may still answer, lists what answered, and offers Search again", async () => {
    disconnected({ picker: true, searching: true, candidates: [{ info: { uuid: "u-okx", name: "OKX Wallet", icon: "", rdns: "com.okex.wallet" }, provider: {} }] });
    let tree = chip(); const picker = nodes(tree).find((n) => n.props?.["data-testid"] === "wallet-picker");
    expect(nodes(picker).some((n) => n.props?.["data-testid"] === "wallet-searching")).toBe(true); expect(text(picker)).toContain("looking for wallets…");
    expect(text(picker)).toContain("OKX Wallet");
    const again = button(tree, "Search again"); expect(again.props.disabled).toBe(true); // not while a search runs
    disconnected({ picker: true, searching: false, candidates: [] }); tree = chip();
    expect(text(tree)).toContain("no wallet answered in this tab yet");
    button(tree, "Search again").props.onClick(); expect(h.wallet.searchAgain).toHaveBeenCalledTimes(1);
  });
  it("a remembered wallet that did not answer in this tab is named, with Search again, another wallet, or dismiss — nothing else is shown as connected", async () => {
    disconnected({ missing: { rdns: "io.metamask", name: "MetaMask" } });
    const tree = chip(); const notice = nodes(tree).find((n) => n.props?.["data-testid"] === "wallet-missing");
    expect(text(notice)).toContain("MetaMask was not detected in this tab — open the extension once or reload the tab. Nothing else was connected in its place.");
    expect(content(tree)).toContain("Connect wallet"); expect(content(tree)).not.toContain(CHIP);
    button(tree, "Search again").props.onClick(); expect(h.wallet.searchAgain).toHaveBeenCalledTimes(1);
    button(tree, "Choose another wallet").props.onClick(); expect(h.wallet.connect).toHaveBeenCalledTimes(1);
    button(tree, "dismiss").props.onClick(); expect(h.wallet.dismissMissing).toHaveBeenCalledTimes(1);
    expect(nodes(tree).find((n) => n.type === "button" && n.props.className === "wallet-btn")?.props.children[0].props.className).toBe("dot warn");
  });
  it("no wallet found: the readable error with Search again", async () => {
    disconnected({ error: "No EIP-1193 wallet found in this tab. Install MetaMask … press Search again." });
    const tree = chip(); const box = nodes(tree).find((n) => n.props?.["data-testid"] === "wallet-error");
    expect(text(box)).toContain("No EIP-1193 wallet found in this tab"); button(tree, "Search again").props.onClick(); expect(h.wallet.searchAgain).toHaveBeenCalledTimes(1);
  });
});

describe("awaitFaucetReceipt", () => {
  it("confirmed with its block, reverted, or unconfirmed after the window; a provider that throws is treated as 'not seen yet'", async () => {
    const answers: any[] = [new Error("rpc down"), null, { status: "0x0", blockNumber: "0x5" }];
    const provider = { request: vi.fn(async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; }) };
    let t = 0; const wait = async (ms: number) => { t += ms; };
    expect(await awaitFaucetReceipt(provider as any, TX, { wait, now: () => t, pollMs: 2000, maxMs: 60_000 })).toEqual({ kind: "reverted" });
    expect(provider.request).toHaveBeenCalledTimes(3);
    const ok = { request: vi.fn(async () => ({ status: 1, blockNumber: 42 })) };
    expect(await awaitFaucetReceipt(ok as any, TX, { wait, now: () => t })).toEqual({ kind: "confirmed", block: "42" });
    const never = { request: vi.fn(async () => null) }; t = 0;
    expect(await awaitFaucetReceipt(never as any, TX, { wait, now: () => t, pollMs: 2000, maxMs: 10_000 })).toEqual({ kind: "unconfirmed" });
    expect(never.request.mock.calls.length).toBe(6); // 0, 2, 4, 6, 8, 10 s
  });
});
