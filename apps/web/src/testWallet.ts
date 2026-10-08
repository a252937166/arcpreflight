// Injectable EIP-1193 test wallet for self-testing in automated browsers (no extension available). DEV ONLY: compiled into the bundle
// only when the build runs with VITE_TEST_WALLET=1 (main.tsx gates the import; a public build contains neither this module nor the
// `?testwallet` switch). Enabled by visiting ?testwallet=<privateKey> once (stored in localStorage) or by `localStorage.arcpreflight.testWallet`.
// It signs typed data / messages locally and proxies read RPCs to the public Arc endpoints. `eth_sendTransaction` signs the request
// locally (nonce from the pending count, gas estimated when missing, fees from the request or eth_gasPrice with Arc's 20 gwei floor),
// broadcasts with eth_sendRawTransaction and returns the hash — exactly what an extension does, without a prompt.
//
// Fault modes (review round 2, item 10) — `localStorage.arcpreflight.testWallet.fault`, read on every request so a test can arm one at the
// exact moment (right before "Execute", say):
//   reject-sign              eth_signTypedData_v4 answers like a declined prompt (code 4001)
//   reject-tx                eth_sendTransaction answers like a declined prompt (code 4001)
//   timeout-tx-after-send    the transaction IS broadcast, then a timeout error is thrown instead of the hash (ambiguous submission)
//   timeout-tx-no-send       the same timeout error, nothing sent
//   wrong-chain              eth_chainId answers the OTHER Arc chain (no chainChanged event: the page notices only when it re-reads)
//   switch-account           accountsChanged([other]) is emitted and eth_accounts answers the other account (key in `…testWallet.other`)
//   switch-account-silent    eth_accounts answers the other account without an event (a switch between the click and the prompt)
//   slow-rpc:<ms>            every RPC call the wallet makes is delayed by <ms>
// Older hooks kept: `…testWallet.hold = "1"` makes eth_sendTransaction wait like an open prompt (never resolves) so a page reload mid-prompt
// can be rehearsed; `…hold = "reject"` equals `fault = reject-tx`. The hash of a broadcast made under `timeout-tx-after-send` is kept in
// `…testWallet.lastHash` so a test can compare it with what reconciliation found.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const RPC: Record<number, string> = { 5042: "https://rpc.mainnet.arc.io", 5042002: "https://rpc.testnet.arc.io" };
const KEY = "arcpreflight.testWallet", CHAIN = "arcpreflight.testWallet.chain", CONNECTED = "arcpreflight.testWallet.connected", HOLD = "arcpreflight.testWallet.hold";
const FAULT = "arcpreflight.testWallet.fault", OTHER = "arcpreflight.testWallet.other", LAST_HASH = "arcpreflight.testWallet.lastHash";
const MIN_FEE = 20_000_000_000n; // Arc's 20 gwei floor: lower transactions are silently dropped
const big = (v: unknown, fallback: bigint): bigint => { try { return v === undefined || v === null || v === "" ? fallback : BigInt(v as any); } catch { return fallback; } };
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const fault = () => get(FAULT) ?? "";
const rejected = () => { const e: any = new Error("User rejected the request."); e.code = 4001; return e; };
const timedOut = () => { const e: any = new Error("Request timed out: the wallet did not receive a response from the node"); e.code = -32603; return e; };
const sleep = (ms: number) => new Promise<void>((s) => setTimeout(s, ms));

export function maybeInjectTestWallet(): boolean {
  try {
    const url = new URL(location.href);
    const q = url.searchParams.get("testwallet");
    if (q) { if (q === "off") localStorage.removeItem(KEY); else localStorage.setItem(KEY, q); url.searchParams.delete("testwallet"); history.replaceState(null, "", url.toString()); }
    const pk = localStorage.getItem(KEY) as Hex | null;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return false;
    const account = privateKeyToAccount(pk);
    /** the second account (fault modes switch-account*): its key lives in localStorage too, set by the test */
    const other = () => { const k = get(OTHER); return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? privateKeyToAccount(k as Hex) : null; };
    let chainId = Number(localStorage.getItem(CHAIN) ?? 5042002);
    if (!RPC[chainId]) chainId = 5042002;
    const otherChain = () => (chainId === 5042002 ? 5042 : 5042002);
    const listeners = new Map<string, Set<(...a: any[]) => void>>();
    const emit = (ev: string, ...a: any[]) => listeners.get(ev)?.forEach((cb) => { try { cb(...a); } catch { /* ignore */ } });
    // like a real extension, the site permission survives a reload (eth_accounts stays non-empty) until it is revoked
    let connected = localStorage.getItem(CONNECTED) === "1";
    const current = () => (fault().startsWith("switch-account") && other() ? other()!.address : account.address);
    const rpc = async (method: string, params: unknown) => {
      const f = fault(); if (f.startsWith("slow-rpc:")) await sleep(Math.max(0, Number(f.slice("slow-rpc:".length)) || 0));
      const r = await fetch(RPC[chainId], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
      const j = await r.json(); if (j.error) { const e: any = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
    };
    const sendTransaction = async (req: any): Promise<Hex> => {
      const hold = localStorage.getItem(HOLD); const f = fault();
      if (hold === "1") return new Promise<Hex>(() => { /* an open prompt that is never answered (self-test of a reload mid-prompt) */ });
      if (hold === "reject" || f === "reject-tx") throw rejected();
      if (f === "timeout-tx-no-send") throw timedOut();
      if (!req || typeof req !== "object") throw new Error("eth_sendTransaction needs a transaction object");
      if (req.from && String(req.from).toLowerCase() !== account.address.toLowerCase()) { const e: any = new Error("from is not the connected account"); e.code = 4100; throw e; }
      const to = req.to as Hex | undefined; const data = (req.data ?? req.input ?? "0x") as Hex; const value = big(req.value, 0n);
      const [nonceHex, gasHex, priceHex] = await Promise.all([
        req.nonce !== undefined ? Promise.resolve(req.nonce) : rpc("eth_getTransactionCount", [account.address, "pending"]),
        req.gas !== undefined ? Promise.resolve(req.gas) : rpc("eth_estimateGas", [{ from: account.address, to, data, value: `0x${value.toString(16)}` }]),
        req.maxFeePerGas !== undefined ? Promise.resolve(req.maxFeePerGas) : rpc("eth_gasPrice", []),
      ]);
      const gasPrice = big(priceHex, MIN_FEE);
      const maxFeePerGas = req.maxFeePerGas !== undefined ? big(req.maxFeePerGas, MIN_FEE) : (gasPrice > MIN_FEE ? gasPrice + 1_000_000_000n : MIN_FEE + 1_000_000_000n);
      const maxPriorityFeePerGas = req.maxPriorityFeePerGas !== undefined ? big(req.maxPriorityFeePerGas, 1_000_000_000n) : 1_000_000_000n;
      const raw = await account.signTransaction({ chainId, type: "eip1559", to, data, value, nonce: Number(big(nonceHex, 0n)), gas: big(gasHex, 60_000n), maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas, accessList: [] });
      const hash = (await rpc("eth_sendRawTransaction", [raw])) as Hex;
      try { localStorage.setItem(LAST_HASH, hash); } catch { /* ignore */ }
      if (f === "timeout-tx-after-send") throw timedOut(); // the transaction left; the wallet's answer did not
      return hash;
    };
    const provider = {
      isArcPreflightTestWallet: true,
      async request({ method, params }: { method: string; params?: any }) {
        const p = Array.isArray(params) ? params : [];
        switch (method) {
          case "eth_requestAccounts": connected = true; localStorage.setItem(CONNECTED, "1"); emit("accountsChanged", [current()]); return [current()];
          case "eth_accounts": return connected ? [current()] : [];
          case "wallet_revokePermissions": connected = false; localStorage.removeItem(CONNECTED); emit("accountsChanged", []); return null;
          case "eth_chainId": return `0x${(fault() === "wrong-chain" ? otherChain() : chainId).toString(16)}`;
          case "net_version": return String(fault() === "wrong-chain" ? otherChain() : chainId);
          case "wallet_switchEthereumChain": { const id = Number(p[0]?.chainId); if (!RPC[id]) { const e: any = new Error("Unrecognized chain ID"); e.code = 4902; throw e; } chainId = id; localStorage.setItem(CHAIN, String(id)); emit("chainChanged", `0x${id.toString(16)}`); return null; }
          case "wallet_addEthereumChain": { const id = Number(p[0]?.chainId); if (!RPC[id]) throw new Error("test wallet only knows Arc 5042 / 5042002"); chainId = id; localStorage.setItem(CHAIN, String(id)); emit("chainChanged", `0x${id.toString(16)}`); return null; }
          case "eth_signTypedData_v4": { if (fault() === "reject-sign") throw rejected(); const td = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1]; const { EIP712Domain: _d, ...types } = td.types ?? {}; return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }); }
          case "personal_sign": { const msg = p[0] as Hex; return account.signMessage({ message: { raw: msg } }); }
          case "eth_sendTransaction": { if (!connected) { const e: any = new Error("not connected"); e.code = 4100; throw e; } return sendTransaction(p[0]); }
          case "eth_signTransaction": { const e: any = new Error("Test wallet: eth_signTransaction is not supported; use eth_sendTransaction"); e.code = 4200; throw e; }
          default: return rpc(method, p);
        }
      },
      on(ev: string, cb: (...a: any[]) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(cb); },
      removeListener(ev: string, cb: (...a: any[]) => void) { listeners.get(ev)?.delete(cb); },
    };
    // the account switch is an event in a real extension: watch the fault key and announce the other (or original) account once per change
    let announced = fault() === "switch-account";
    setInterval(() => { const on = fault() === "switch-account"; if (on !== announced) { announced = on; if (connected) emit("accountsChanged", [current()]); } }, 400);
    // Wallet extensions may (re)define window.ethereum non-writably or after us; the app prefers this slot when present.
    (window as any).__arcpreflightTestProvider = provider;
    try { Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: true }); } catch { /* extension owns window.ethereum; the slot above still wins inside the app */ }
    return true;
  } catch { return false; }
}
