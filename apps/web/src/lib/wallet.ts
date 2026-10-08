// Wallet layer (no wallet SDK): EIP-6963 multi-provider discovery with a picker, the injected test provider for self-tests,
// a legacy window.ethereum fallback, silent reconnect, revoke-on-disconnect, and the same Arc helpers as before.
// One module-level store feeds every useWallet() caller (nav chip, Demo and Developer pages), so they can never disagree.
// P3 (hands-on feedback): a connected wallet on another chain is asked ONCE per event to switch to the API's chain; the
// remembered wallet reconnects when it announces itself (OKX and others announce asynchronously), not only at init.
import { useCallback, useEffect, useState } from "react";
import { getAddress, type Hex } from "viem";
import type { NetworkInfo } from "./api";

export type Eip1193 = { request(args: { method: string; params?: unknown[] | object }): Promise<any>; on?(ev: string, cb: (...a: any[]) => void): void; removeListener?(ev: string, cb: (...a: any[]) => void): void; isArcPreflightTestWallet?: boolean; isMetaMask?: boolean };
export type ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
export type ProviderDetail = { info: ProviderInfo; provider: Eip1193 };
export type WalletState = {
  provider: Eip1193 | null; info: ProviderInfo | null; account: string | null; chainId: number | null; connecting: boolean; error: string | null; isTest: boolean;
  /** every wallet that can be connected right now (test provider first, then EIP-6963 announcements, then legacy window.ethereum) */
  candidates: ProviderDetail[];
  /** more than one candidate and no choice yet: the UI shows the picker */
  picker: boolean;
  /** an automatic chain switch is in flight (the wallet is showing its prompt) */
  switching: boolean;
};

const REMEMBER = "arcpreflight.wallet";
/** the injected private-key test provider is looked for only in builds made with VITE_TEST_WALLET=1 (docs/LIFECYCLE.md §9 "public builds") */
const TEST_WALLET_BUILD = import.meta.env.VITE_TEST_WALLET === "1";
/** how long to wait for the remembered wallet's EIP-6963 announcement before trusting an authorized window.ethereum */
export const LEGACY_FALLBACK_MS = 1500;
const TEST_INFO: ProviderInfo = { uuid: "arcpreflight-test-wallet", name: "Test wallet (local)", icon: "", rdns: "xyz.arcpreflight.testwallet" };
const INJECTED_INFO: ProviderInfo = { uuid: "window-ethereum", name: "Injected wallet", icon: "", rdns: "injected" };
const FRIENDLY: Record<string, string> = { "io.metamask": "MetaMask", "io.metamask.flask": "MetaMask Flask", "com.okex.wallet": "OKX Wallet", "io.rabby": "Rabby", "com.coinbase.wallet": "Coinbase Wallet", "com.brave.wallet": "Brave Wallet", "app.phantom": "Phantom", "io.zerion.wallet": "Zerion", "com.trustwallet.app": "Trust Wallet" };
export const friendlyName = (info: ProviderInfo) => FRIENDLY[info.rdns] ?? info.name;

const w = (): any => (typeof window === "undefined" ? null : window);
const store = {
  state: initial() as WalletState, listeners: new Set<(s: WalletState) => void>(), discovered: new Map<string, ProviderDetail>(), started: false,
  bound: { provider: null as Eip1193 | null, off: () => {} },
  /** the API's network as the nav last reported it: the chain an auto-switch targets */
  target: null as NetworkInfo | null,
  reconnecting: null as Promise<void> | null, fallbackTimer: null as ReturnType<typeof setTimeout> | null,
};
function initial(): WalletState { return { provider: null, info: null, account: null, chainId: null, connecting: false, error: null, isTest: false, candidates: [], picker: false, switching: false }; }
function set(patch: Partial<WalletState>) { store.state = { ...store.state, ...patch }; for (const l of store.listeners) l(store.state); }

/** Test provider first, then every EIP-6963 announcement (sorted by name), then legacy window.ethereum when it is not one of them. */
export function candidates(): ProviderDetail[] {
  const win = w(); const out: ProviderDetail[] = [];
  if (TEST_WALLET_BUILD) { const test: Eip1193 | undefined = win?.__arcpreflightTestProvider; if (test) out.push({ info: TEST_INFO, provider: test }); }
  const announced = [...store.discovered.values()].sort((a, b) => friendlyName(a.info).localeCompare(friendlyName(b.info)));
  out.push(...announced);
  const legacy: Eip1193 | undefined = win?.ethereum;
  if (legacy && !out.some((c) => c.provider === legacy)) out.push({ info: INJECTED_INFO, provider: legacy });
  return out;
}
/** EIP-6963: listen first, then ask every installed wallet to announce itself. Safe to call repeatedly. */
export function startDiscovery() {
  const win = w(); if (!win || store.started || typeof win.addEventListener !== "function") return;
  store.started = true;
  win.addEventListener("eip6963:announceProvider", (e: any) => {
    const d = e?.detail; if (!d?.info?.uuid || !d.provider) return;
    store.discovered.set(d.info.uuid, { info: { ...d.info }, provider: d.provider });
    set({ candidates: candidates() });
    // the remembered wallet announced late (after the first render): reconnect now, still through eth_accounts only
    if (!store.state.account && !store.state.connecting && remembered() === d.info.rdns) void silentReconnect();
  });
  try { win.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* no CustomEvent support: legacy fallback still applies */ }
  set({ candidates: candidates() });
  // nothing announced the remembered wallet in time: an authorized window.ethereum is the next best evidence of "this site's wallet"
  if (remembered() && !store.state.account) store.fallbackTimer = setTimeout(() => { store.fallbackTimer = null; void silentReconnect({ legacy: true }); }, LEGACY_FALLBACK_MS);
}
const remember = (rdns: string | null) => { try { if (rdns) localStorage.setItem(REMEMBER, rdns); else localStorage.removeItem(REMEMBER); } catch { /* storage unavailable */ } };
const remembered = (): string | null => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };

function bind(c: ProviderDetail) {
  store.bound.off();
  const p = c.provider;
  const onAcc = (a: string[]) => { if (!a?.length) { set({ account: null }); return; } set({ account: getAddress(a[0]) }); };
  const onChain = (cid: string) => set({ chainId: Number(cid) });
  const onDisc = () => set({ account: null, chainId: null });
  p.on?.("accountsChanged", onAcc); p.on?.("chainChanged", onChain); p.on?.("disconnect", onDisc);
  store.bound = { provider: p, off: () => { p.removeListener?.("accountsChanged", onAcc); p.removeListener?.("chainChanged", onChain); p.removeListener?.("disconnect", onDisc); store.bound = { provider: null, off: () => {} }; } };
}
async function finish(c: ProviderDetail, accs: string[], prompt: boolean): Promise<void> {
  const cid: string = await c.provider.request({ method: "eth_chainId" });
  const account = accs?.[0] ? getAddress(accs[0]) : null;
  if (prompt || account) bind(c);
  set({ provider: c.provider, info: c.info, account, chainId: Number(cid), isTest: !!c.provider.isArcPreflightTestWallet, connecting: false, error: null, picker: false });
}
async function read(c: ProviderDetail, prompt: boolean): Promise<void> {
  const accs: string[] = await c.provider.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
  await finish(c, accs, prompt);
}

/** Reconnect without a prompt when the remembered wallet still exposes an authorized account (eth_accounts only).
 *  With `legacy`, a window.ethereum (or the test provider, which keeps precedence) that exposes an authorized account stands in
 *  for a remembered wallet that never announced itself. Concurrent calls share one attempt. */
export function silentReconnect(opts: { legacy?: boolean } = {}): Promise<void> {
  if (store.reconnecting) return store.reconnecting;
  const attempt = (async () => {
    if (store.state.account || store.state.connecting) return;
    const rdns = remembered(); if (!rdns) return;
    const list = candidates(); const win = w();
    const c = list.find((x) => x.info.rdns === rdns)
      ?? (opts.legacy ? (TEST_WALLET_BUILD ? list.find((x) => x.provider === win?.__arcpreflightTestProvider) : undefined) ?? list.find((x) => x.provider === win?.ethereum) : undefined);
    if (!c) return;
    try {
      const accs: string[] = await c.provider.request({ method: "eth_accounts" });
      if (!accs?.length || store.state.account) return; // not authorized any more (or another path connected meanwhile): stay as we are, never prompt
      await finish(c.info.rdns === rdns ? c : { ...c, info: { ...c.info, rdns } }, accs, false);
      void ensureChain();
    } catch { /* not authorized any more: stay disconnected */ }
  })();
  store.reconnecting = attempt.finally(() => { store.reconnecting = null; });
  return store.reconnecting;
}
/** Connect: a named candidate, the only candidate, or — with several — open the picker. A connected wallet on another chain is asked once to switch. */
export async function connect(uuid?: string) {
  const list = candidates(); set({ candidates: list, error: null });
  if (!list.length) { set({ error: "No EIP-1193 wallet found. Install MetaMask, OKX Wallet, Rabby, Coinbase Wallet or Brave Wallet, then reload this page." }); return; }
  const chosen = uuid ? list.find((c) => c.info.uuid === uuid) : list.length === 1 ? list[0] : null;
  if (!chosen) { set({ picker: true }); return; }
  set({ connecting: true, picker: false });
  try { await read(chosen, true); remember(chosen.info.rdns); await ensureChain(); }
  catch (e: any) { set({ connecting: false, error: e?.message ?? String(e) }); }
}
export const closePicker = () => set({ picker: false });
/** Disconnect: revoke the site's account permission where the wallet supports it (MetaMask and others), then forget the choice. */
export async function disconnect() {
  const p = store.state.provider;
  if (p) { try { await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* wallets without wallet_revokePermissions: a local disconnect is all we can do */ } }
  store.bound.off(); remember(null);
  set({ provider: null, info: null, account: null, chainId: null, connecting: false, error: null, isTest: false, picker: false, switching: false });
}
export const chainParams = (n: NetworkInfo) => ({
  chainId: `0x${n.chainId.toString(16)}`, chainName: n.network === "mainnet" ? "Arc" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [n.rpc], blockExplorerUrls: [n.explorer],
});
export async function switchToArc(p: Eip1193, n: NetworkInfo) {
  const params = chainParams(n);
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] }); }
  catch (e: any) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code === 4902 || code === -32603 || /Unrecognized chain|not added|4902/i.test(String(e?.message))) { await p.request({ method: "wallet_addEthereumChain", params: [params] }); }
    else throw e;
  }
}
/** Manual switch from the UI: errors are shown. */
export async function switchChain(n: NetworkInfo) {
  const p = store.state.provider; if (!p) return;
  try { await switchToArc(p, n); const cid: string = await p.request({ method: "eth_chainId" }); set({ chainId: Number(cid), error: null }); }
  catch (e: any) { set({ error: e?.message ?? String(e) }); }
}
/** The API's network, as the nav reports it. When it changes while a wallet is connected on another chain, the wallet is asked once to switch. */
export function setTargetNetwork(n: NetworkInfo | null) {
  const prev = store.target; store.target = n;
  if (n && prev?.chainId !== n.chainId && store.state.account && store.state.chainId !== n.chainId) void ensureChain();
}
/** One automatic switch per event (connect, silent reconnect, network change): a declined prompt (4001) or an unsupported method is
 *  not an error — the wallet menu and the pages keep the manual "Switch to Arc" fallback. Never prompts while a prompt is open. */
export async function ensureChain(): Promise<boolean> {
  const p = store.state.provider; const n = store.target;
  if (!p || !n || !store.state.account) return false;
  if (store.state.chainId === n.chainId) return true;
  if (store.state.switching) return false;
  set({ switching: true });
  try { await switchToArc(p, n); const cid: string = await p.request({ method: "eth_chainId" }); set({ chainId: Number(cid) }); return Number(cid) === n.chainId; }
  catch { return false; }
  finally { set({ switching: false }); }
}
export async function refresh() {
  const p = store.state.provider; if (!p) return;
  try { const [accs, cid] = await Promise.all([p.request({ method: "eth_accounts" }) as Promise<string[]>, p.request({ method: "eth_chainId" }) as Promise<string>]); set({ account: accs?.[0] ? getAddress(accs[0]) : null, chainId: Number(cid) }); } catch { /* ignore */ }
}
/** Test seam: forget discovery and state (the module is a singleton). */
export function resetWalletStore() { store.bound.off(); store.state = initial(); store.discovered.clear(); store.started = false; store.target = null; store.reconnecting = null; if (store.fallbackTimer) { clearTimeout(store.fallbackTimer); store.fallbackTimer = null; } }
export const walletStore = { getState: () => store.state, subscribe: (l: (s: WalletState) => void) => { store.listeners.add(l); return () => { store.listeners.delete(l); }; }, candidates, startDiscovery, silentReconnect, connect, closePicker, disconnect, switchChain, setTargetNetwork, ensureChain, refresh, resetWalletStore };

export const toHexQuantity = (v: bigint) => `0x${v.toString(16)}`;
export async function nativeBalance(p: Eip1193, addr: string): Promise<bigint> { return BigInt(await p.request({ method: "eth_getBalance", params: [addr, "latest"] })); }
export async function erc20Balance(p: Eip1193, token: string, addr: string): Promise<bigint> {
  const data = `0x70a08231${addr.slice(2).toLowerCase().padStart(64, "0")}`;
  const r: string = await p.request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
  return r && r !== "0x" ? BigInt(r) : 0n;
}
export async function signTypedDataV4(p: Eip1193, from: string, typedData: unknown): Promise<Hex> {
  return (await p.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] })) as Hex;
}

/** Every caller sees the same store; the first mount starts discovery and the silent reconnect. */
export function useWallet() {
  const [s, setS] = useState<WalletState>(store.state);
  useEffect(() => { const off = walletStore.subscribe(setS); startDiscovery(); void silentReconnect(); setS(store.state); return off; }, []);
  const connectCb = useCallback((uuid?: string) => connect(typeof uuid === "string" ? uuid : undefined), []);
  const switchCb = useCallback((n: NetworkInfo) => switchChain(n), []);
  return { ...s, connect: connectCb, choose: connectCb, closePicker, disconnect, switchChain: switchCb, ensureChain, refresh };
}
