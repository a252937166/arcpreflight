// Injectable EIP-1193 test wallet for self-testing in automated browsers (no extension available).
// Enabled by visiting ?testwallet=<privateKey> once (stored in localStorage) or by `localStorage.arcpreflight.testWallet`.
// It never sends transactions (eth_sendTransaction is rejected: wallet execution is off in the SUBMISSION_RESTRICTED profile);
// it signs typed data / messages locally and proxies read RPCs to the public Arc endpoints.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const RPC: Record<number, string> = { 5042: "https://rpc.mainnet.arc.io", 5042002: "https://rpc.testnet.arc.io" };
const KEY = "arcpreflight.testWallet", CHAIN = "arcpreflight.testWallet.chain";

export function maybeInjectTestWallet(): boolean {
  try {
    const url = new URL(location.href);
    const q = url.searchParams.get("testwallet");
    if (q) { if (q === "off") localStorage.removeItem(KEY); else localStorage.setItem(KEY, q); url.searchParams.delete("testwallet"); history.replaceState(null, "", url.toString()); }
    const pk = localStorage.getItem(KEY) as Hex | null;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return false;
    const account = privateKeyToAccount(pk);
    let chainId = Number(localStorage.getItem(CHAIN) ?? 5042002);
    if (!RPC[chainId]) chainId = 5042002;
    const listeners = new Map<string, Set<(...a: any[]) => void>>();
    const emit = (ev: string, ...a: any[]) => listeners.get(ev)?.forEach((cb) => { try { cb(...a); } catch { /* ignore */ } });
    let connected = false;
    const rpc = async (method: string, params: unknown) => {
      const r = await fetch(RPC[chainId], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
      const j = await r.json(); if (j.error) { const e: any = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
    };
    const provider = {
      isArcPreflightTestWallet: true,
      async request({ method, params }: { method: string; params?: any }) {
        const p = Array.isArray(params) ? params : [];
        switch (method) {
          case "eth_requestAccounts": connected = true; emit("accountsChanged", [account.address]); return [account.address];
          case "eth_accounts": return connected ? [account.address] : [];
          case "eth_chainId": return `0x${chainId.toString(16)}`;
          case "net_version": return String(chainId);
          case "wallet_switchEthereumChain": { const id = Number(p[0]?.chainId); if (!RPC[id]) { const e: any = new Error("Unrecognized chain ID"); e.code = 4902; throw e; } chainId = id; localStorage.setItem(CHAIN, String(id)); emit("chainChanged", `0x${id.toString(16)}`); return null; }
          case "wallet_addEthereumChain": { const id = Number(p[0]?.chainId); if (!RPC[id]) throw new Error("test wallet only knows Arc 5042 / 5042002"); chainId = id; localStorage.setItem(CHAIN, String(id)); emit("chainChanged", `0x${id.toString(16)}`); return null; }
          case "eth_signTypedData_v4": { const td = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1]; const { EIP712Domain: _d, ...types } = td.types ?? {}; return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }); }
          case "personal_sign": { const msg = p[0] as Hex; return account.signMessage({ message: { raw: msg } }); }
          case "eth_sendTransaction": { const e: any = new Error("Test wallet: eth_sendTransaction is disabled (wallet execution is off in SUBMISSION_RESTRICTED)"); e.code = 4001; throw e; }
          default: return rpc(method, p);
        }
      },
      on(ev: string, cb: (...a: any[]) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(cb); },
      removeListener(ev: string, cb: (...a: any[]) => void) { listeners.get(ev)?.delete(cb); },
    };
    (window as any).ethereum = provider;
    return true;
  } catch { return false; }
}
