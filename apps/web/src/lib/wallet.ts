// Wallet layer (no wallet SDK): EIP-6963 multi-provider discovery with a picker, the injected test provider for self-tests,
// a legacy window.ethereum fallback, silent reconnect, revoke-on-disconnect, and the same Arc helpers as before.
// One module-level store feeds every useWallet() caller (nav chip, Demo and Developer pages), so they can never disagree.
// P3 (hands-on feedback): a connected wallet on another chain is asked ONCE per event to switch to the API's chain; the
// remembered wallet reconnects when it announces itself (OKX and others announce asynchronously), not only at init.
// Real-wallet session (2026-10-09): MetaMask was missing from the picker in fresh and duplicated tabs while OKX answered, and the
// legacy fallback reconnected OKX's window.ethereum under the remembered MetaMask label. Discovery is therefore: one announce listener
// for the page's lifetime (registered at module load, never removed); `eip6963:requestProvider` re-sent whenever Connect is clicked,
// the picker opens or "Search again" is pressed, then a short wait for late announcements; a legacy window.ethereum entry only when no
// EIP-6963 wallet announced, labelled from its OWN flags (OKX first) and remembered as `legacy:<kind>`; a silent reconnect that uses
// only the exact remembered wallet — re-requesting over ≈2 s — and otherwise says "<wallet> was not detected in this tab".
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
  /** discovery was re-requested and the page is waiting for late announcements (the picker reads "looking for wallets…") */
  searching: boolean;
  /** the remembered wallet did not announce itself in this tab: nothing else is connected in its place; the chip says so */
  missing: { rdns: string; name: string } | null;
};

const REMEMBER = "arcpreflight.wallet";
/** the injected private-key test provider is looked for only in builds made with VITE_TEST_WALLET=1 (docs/LIFECYCLE.md §9 "public builds") */
const TEST_WALLET_BUILD = import.meta.env.VITE_TEST_WALLET === "1";
/** how long a remembered EIP-6963 wallet may take to announce itself in this tab (discovery is re-requested meanwhile) before the
 *  chip says it was not detected; nothing else is ever connected in its place */
export const RECONNECT_SEARCH_MS = 2000;
/** re-requests during that search (a fresh or duplicated tab may answer only a later request) */
const RECONNECT_REQUESTS_AT_MS = [400, 1000];
/** how long Connect / the picker / "Search again" waits for late announcements before deciding what exists */
let discoveryWaitMs = 600;
const TEST_INFO: ProviderInfo = { uuid: "arcpreflight-test-wallet", name: "Test wallet (local)", icon: "", rdns: "xyz.arcpreflight.testwallet" };
const FRIENDLY: Record<string, string> = { "io.metamask": "MetaMask", "io.metamask.flask": "MetaMask Flask", "com.okex.wallet": "OKX Wallet", "io.rabby": "Rabby", "com.coinbase.wallet": "Coinbase Wallet", "com.brave.wallet": "Brave Wallet", "app.phantom": "Phantom", "io.zerion.wallet": "Zerion", "com.trustwallet.app": "Trust Wallet" };
/** a legacy window.ethereum is named from its own flags, OKX first — OKX's provider may also say isMetaMask */
const LEGACY_KINDS: { kind: string; name: string; test: (p: any) => boolean }[] = [
  { kind: "okx", name: "OKX Wallet", test: (p) => !!(p?.isOkxWallet || p?.isOKExWallet) },
  { kind: "rabby", name: "Rabby", test: (p) => !!p?.isRabby },
  { kind: "coinbase", name: "Coinbase Wallet", test: (p) => !!p?.isCoinbaseWallet },
  { kind: "brave", name: "Brave Wallet", test: (p) => !!p?.isBraveWallet },
  { kind: "metamask", name: "MetaMask (injected)", test: (p) => !!p?.isMetaMask },
];
export function legacyKind(p: unknown): { kind: string; name: string } { const k = LEGACY_KINDS.find((x) => x.test(p)); return k ? { kind: k.kind, name: k.name } : { kind: "injected", name: "Injected wallet" }; }
/** the legacy entry's identity: remembered as `legacy:<kind>`, never as an EIP-6963 rdns */
export function legacyInfo(p: unknown): ProviderInfo { const k = legacyKind(p); return { uuid: `window-ethereum:${k.kind}`, name: k.name, icon: "", rdns: `legacy:${k.kind}` }; }
export const friendlyName = (info: ProviderInfo) => FRIENDLY[info.rdns] ?? info.name;
/** the name of a remembered wallet that is not present (for the "not detected in this tab" notice) */
export function rememberedName(rdns: string): string {
  if (FRIENDLY[rdns]) return FRIENDLY[rdns];
  if (rdns === TEST_INFO.rdns) return TEST_INFO.name;
  if (rdns.startsWith("legacy:")) { const kind = rdns.slice(7); return LEGACY_KINDS.find((k) => k.kind === kind)?.name ?? "Injected wallet"; }
  return rdns;
}

const w = (): any => (typeof window === "undefined" ? null : window);
const store = {
  state: initial() as WalletState, listeners: new Set<(s: WalletState) => void>(), discovered: new Map<string, ProviderDetail>(), started: false,
  bound: { provider: null as Eip1193 | null, off: () => {} },
  /** the API's network as the nav last reported it: the chain an auto-switch targets */
  target: null as NetworkInfo | null,
  reconnecting: null as Promise<void> | null, timers: [] as ReturnType<typeof setTimeout>[],
  /** the window the announce listener is attached to (one listener per page lifetime) */
  listenerOn: null as any,
};
function initial(): WalletState { return { provider: null, info: null, account: null, chainId: null, connecting: false, error: null, isTest: false, candidates: [], picker: false, switching: false, searching: false, missing: null }; }
function set(patch: Partial<WalletState>) { store.state = { ...store.state, ...patch }; for (const l of store.listeners) l(store.state); }

/** Test provider first (dev builds), then every EIP-6963 announcement (sorted by name); a legacy window.ethereum only when NO EIP-6963
 *  wallet announced — named from its own flags, so an OKX-owned window.ethereum reads "OKX Wallet", never the remembered wallet. */
export function candidates(): ProviderDetail[] {
  const win = w(); const out: ProviderDetail[] = [];
  const test: Eip1193 | undefined = TEST_WALLET_BUILD ? win?.__arcpreflightTestProvider : undefined;
  if (test) out.push({ info: TEST_INFO, provider: test });
  const announced = [...store.discovered.values()].sort((a, b) => friendlyName(a.info).localeCompare(friendlyName(b.info)));
  out.push(...announced);
  const legacy: Eip1193 | undefined = win?.ethereum;
  if (legacy && store.discovered.size === 0 && legacy !== test) out.push({ info: legacyInfo(legacy), provider: legacy });
  return out;
}
/** every announcement (also late ones) lands here: added or updated by uuid; the picker re-renders; the remembered wallet reconnects */
function onAnnounce(e: any) {
  const d = e?.detail; if (!d?.info?.uuid || !d.provider) return;
  store.discovered.set(d.info.uuid, { info: { ...d.info }, provider: d.provider });
  const patch: Partial<WalletState> = { candidates: candidates() };
  if (store.state.missing?.rdns === d.info.rdns) patch.missing = null;
  set(patch);
  // the remembered wallet announced late (after the first render, or after a re-request): reconnect now, still through eth_accounts only
  if (!store.state.account && !store.state.connecting && remembered() === d.info.rdns) void silentReconnect();
}
/** One announce listener per page lifetime, attached as early as possible (module load) and never removed. Idempotent. */
function ensureListener() {
  const win = w(); if (!win || typeof win.addEventListener !== "function" || store.listenerOn === win) return;
  win.addEventListener("eip6963:announceProvider", onAnnounce);
  store.listenerOn = win;
}
ensureListener();
/** Ask every installed wallet to announce itself (EIP-6963). Sent again on Connect, picker open and "Search again": a wallet whose page
 *  script started late (a fresh or duplicated tab, a sleeping extension worker) answers a later request. */
export function requestProviders() {
  ensureListener();
  const win = w(); if (!win || typeof win.dispatchEvent !== "function") return;
  try { win.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* no Event support: the legacy entry still applies */ }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** EIP-6963: listen (already done at module load), then ask; for a remembered wallet that has not announced, ask again over ≈2 s and
 *  then say it was not detected — without connecting anything else. Safe to call repeatedly. */
export function startDiscovery() {
  const win = w(); if (!win || store.started || typeof win.addEventListener !== "function") return;
  store.started = true;
  requestProviders();
  set({ candidates: candidates() });
  const rdns = remembered();
  if (!rdns || store.state.account) return;
  for (const at of RECONNECT_REQUESTS_AT_MS) store.timers.push(setTimeout(() => { if (!store.state.account && !present(rdns)) requestProviders(); }, at));
  store.timers.push(setTimeout(() => {
    if (store.state.account || store.state.connecting || remembered() !== rdns) return;
    if (!present(rdns)) set({ missing: { rdns, name: rememberedName(rdns) } });
  }, RECONNECT_SEARCH_MS));
}
/** the remembered wallet is a candidate right now (exact identity only) */
const present = (rdns: string) => candidates().some((c) => c.info.rdns === rdns);
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

/** Reconnect without a prompt when the remembered wallet — that exact wallet, by its remembered identity — is present and still exposes
 *  an authorized account (eth_accounts only). Another provider (an OKX-owned window.ethereum, the test provider) never stands in for it.
 *  Concurrent calls share one attempt. */
export function silentReconnect(): Promise<void> {
  if (store.reconnecting) return store.reconnecting;
  const attempt = (async () => {
    if (store.state.account || store.state.connecting) return;
    const rdns = remembered(); if (!rdns) return;
    const c = candidates().find((x) => x.info.rdns === rdns);
    if (!c) return; // not present (yet): the announce listener and the ≈2 s re-requests retry; the chip says so if it never appears
    try {
      const accs: string[] = await c.provider.request({ method: "eth_accounts" });
      if (!accs?.length || store.state.account) return; // not authorized any more (or another path connected meanwhile): stay as we are, never prompt
      await finish(c, accs, false);
      void ensureChain();
    } catch { /* not authorized any more: stay disconnected */ }
  })();
  store.reconnecting = attempt.finally(() => { store.reconnecting = null; });
  return store.reconnecting;
}
const NO_WALLET = "No EIP-1193 wallet found in this tab. Install MetaMask, OKX Wallet, Rabby, Coinbase Wallet or Brave Wallet — or, if one is installed, open the extension once and press Search again.";
/** Re-request discovery and wait for late announcements (the picker reads "looking for wallets…" meanwhile). */
export async function searchAgain(): Promise<ProviderDetail[]> {
  set({ searching: true, error: null });
  requestProviders();
  await sleep(discoveryWaitMs);
  const list = candidates();
  set({ searching: false, candidates: list });
  const rdns = remembered();
  if (rdns && !store.state.account && list.some((c) => c.info.rdns === rdns)) await silentReconnect();
  return list;
}
/** Connect: a named candidate; otherwise re-request discovery, wait briefly for late announcements, then the only candidate — or, with
 *  several, the picker. A connected wallet on another chain is asked once to switch. */
export async function connect(uuid?: string) {
  if (uuid) {
    const chosen = candidates().find((c) => c.info.uuid === uuid);
    if (!chosen) { set({ error: "That wallet is no longer available in this tab — press Search again.", picker: true }); return; }
    return connectTo(chosen);
  }
  set({ picker: true, error: null });
  const list = await searchAgain();
  if (!store.state.picker) return; // closed while searching
  if (!list.length) { set({ picker: false, error: NO_WALLET }); return; }
  if (list.length === 1) return connectTo(list[0]);
  set({ picker: true });
}
async function connectTo(chosen: ProviderDetail) {
  set({ connecting: true, picker: false, error: null });
  try { await read(chosen, true); remember(chosen.info.rdns); set({ missing: null }); await ensureChain(); }
  catch (e: any) { set({ connecting: false, error: e?.message ?? String(e) }); }
}
export const closePicker = () => set({ picker: false, searching: false });
/** the "not detected in this tab" notice can be dismissed; the remembered choice stays */
export const dismissMissing = () => set({ missing: null });
/** Disconnect: revoke the site's account permission where the wallet supports it (MetaMask and others), then forget the choice. */
export async function disconnect() {
  const p = store.state.provider;
  if (p) { try { await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* wallets without wallet_revokePermissions: a local disconnect is all we can do */ } }
  store.bound.off(); remember(null);
  set({ provider: null, info: null, account: null, chainId: null, connecting: false, error: null, isTest: false, picker: false, switching: false, searching: false, missing: null });
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
/** Test seam: forget discovery and state (the module is a singleton); the listener moves to the current window on the next use. */
export function resetWalletStore() {
  store.bound.off(); store.state = initial(); store.discovered.clear(); store.started = false; store.target = null; store.reconnecting = null;
  for (const t of store.timers) clearTimeout(t); store.timers = [];
  try { store.listenerOn?.removeEventListener?.("eip6963:announceProvider", onAnnounce); } catch { /* ignore */ }
  store.listenerOn = null; ensureListener();
}
/** Test seam: how long Connect / "Search again" waits for late announcements */
export function setDiscoveryWait(ms: number) { discoveryWaitMs = ms; }
export const walletStore = { getState: () => store.state, subscribe: (l: (s: WalletState) => void) => { store.listeners.add(l); return () => { store.listeners.delete(l); }; }, candidates, startDiscovery, requestProviders, searchAgain, silentReconnect, connect, closePicker, dismissMissing, disconnect, switchChain, setTargetNetwork, ensureChain, refresh, resetWalletStore, setDiscoveryWait };

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
  const searchCb = useCallback(() => { void searchAgain(); }, []);
  return { ...s, connect: connectCb, choose: connectCb, closePicker, disconnect, switchChain: switchCb, ensureChain, refresh, searchAgain: searchCb, dismissMissing };
}
