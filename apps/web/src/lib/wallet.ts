// Minimal EIP-1193 wallet integration (no wallet SDK): connect, read chain, switch/add Arc, balances, typed-data signing.
import { useCallback, useEffect, useState } from "react";
import { getAddress, type Hex } from "viem";
import type { NetworkInfo } from "./api";

export type Eip1193 = { request(args: { method: string; params?: unknown[] | object }): Promise<any>; on?(ev: string, cb: (...a: any[]) => void): void; removeListener?(ev: string, cb: (...a: any[]) => void): void; isArcPreflightTestWallet?: boolean; isMetaMask?: boolean };
export const getProvider = (): Eip1193 | null => ((window as any).ethereum as Eip1193 | undefined) ?? null;

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

export type WalletState = { provider: Eip1193 | null; account: string | null; chainId: number | null; connecting: boolean; error: string | null; isTest: boolean };
export function useWallet() {
  const [s, set] = useState<WalletState>(() => { const p = getProvider(); return { provider: p, account: null, chainId: null, connecting: false, error: null, isTest: !!p?.isArcPreflightTestWallet }; });
  const refresh = useCallback(async (p: Eip1193) => {
    try { const [accs, cid] = await Promise.all([p.request({ method: "eth_accounts" }) as Promise<string[]>, p.request({ method: "eth_chainId" }) as Promise<string>]);
      set((x) => ({ ...x, provider: p, account: accs?.[0] ? getAddress(accs[0]) : null, chainId: Number(cid), isTest: !!p.isArcPreflightTestWallet })); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const p = getProvider(); if (!p) return;
    refresh(p);
    const onAcc = (a: string[]) => set((x) => ({ ...x, account: a?.[0] ? getAddress(a[0]) : null }));
    const onChain = (c: string) => set((x) => ({ ...x, chainId: Number(c) }));
    p.on?.("accountsChanged", onAcc); p.on?.("chainChanged", onChain);
    return () => { p.removeListener?.("accountsChanged", onAcc); p.removeListener?.("chainChanged", onChain); };
  }, [refresh]);
  const connect = useCallback(async () => {
    const p = getProvider(); if (!p) { set((x) => ({ ...x, error: "No EIP-1193 wallet found. Install MetaMask / Rabby, or open with ?testwallet=<key> for a local test wallet." })); return; }
    set((x) => ({ ...x, connecting: true, error: null }));
    try { const accs: string[] = await p.request({ method: "eth_requestAccounts" }); const cid: string = await p.request({ method: "eth_chainId" }); set((x) => ({ ...x, provider: p, account: accs?.[0] ? getAddress(accs[0]) : null, chainId: Number(cid), connecting: false, isTest: !!p.isArcPreflightTestWallet })); }
    catch (e: any) { set((x) => ({ ...x, connecting: false, error: e?.message ?? String(e) })); }
  }, []);
  const disconnect = useCallback(() => set((x) => ({ ...x, account: null })), []);
  const switchChain = useCallback(async (n: NetworkInfo) => { const p = getProvider(); if (!p) return; try { await switchToArc(p, n); await refresh(p); } catch (e: any) { set((x) => ({ ...x, error: e?.message ?? String(e) })); } }, [refresh]);
  return { ...s, connect, disconnect, switchChain, refresh: () => { const p = getProvider(); if (p) refresh(p); } };
}
