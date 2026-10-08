import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { walletStore, friendlyName } from "../src/lib/wallet";

// The wallet store against fake EIP-6963 providers in a bare node environment (window = an EventTarget).
const ADDR = getAddress("0x0000000000000000000000000000000000000a11"); // the store always reports EIP-55 checksummed addresses
function fakeProvider(opts: { accounts?: string[]; authorized?: string[]; revoke?: boolean } = {}) {
  const handlers = new Map<string, Set<(...a: any[]) => void>>();
  const calls: string[] = [];
  const p: any = {
    request: vi.fn(async ({ method, params }: { method: string; params?: any }) => {
      calls.push(method);
      if (method === "eth_requestAccounts") return opts.accounts ?? [ADDR];
      if (method === "eth_accounts") return opts.authorized ?? [];
      if (method === "eth_chainId") return `0x${(5042002).toString(16)}`;
      if (method === "wallet_revokePermissions") { if (opts.revoke === false) throw new Error("Method not supported"); expect(params).toEqual([{ eth_accounts: {} }]); return null; }
      if (method === "wallet_switchEthereumChain") return null;
      return null;
    }),
    on: (ev: string, cb: any) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev)!.add(cb); },
    removeListener: (ev: string, cb: any) => { handlers.get(ev)?.delete(cb); },
    emit: (ev: string, ...a: any[]) => { handlers.get(ev)?.forEach((cb) => cb(...a)); },
    calls, handlers,
  };
  return p;
}
const announce = (uuid: string, name: string, rdns: string, provider: any) => (globalThis as any).window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid, name, icon: "", rdns }, provider } }));
let win: any; let storage: Map<string, string>;
beforeEach(() => {
  win = new EventTarget(); storage = new Map();
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  walletStore.resetWalletStore();
});
afterEach(() => { walletStore.resetWalletStore(); vi.unstubAllGlobals(); });

describe("wallet store (EIP-6963 discovery, picker, revoke on disconnect)", () => {
  it("asks installed wallets to announce themselves and lists them with friendly names", () => {
    const seen: string[] = []; win.addEventListener("eip6963:requestProvider", () => seen.push("requested"));
    walletStore.startDiscovery();
    expect(seen).toEqual(["requested"]);
    announce("u1", "MetaMask", "io.metamask", fakeProvider()); announce("u2", "OKX", "com.okex.wallet", fakeProvider());
    const c = walletStore.candidates();
    expect(c.map((x) => friendlyName(x.info))).toEqual(["MetaMask", "OKX Wallet"]);
    expect(walletStore.getState().candidates).toHaveLength(2);
  });
  it("with several wallets connect() opens the picker; choosing one connects it and remembers the choice", async () => {
    walletStore.startDiscovery();
    const mm = fakeProvider(), okx = fakeProvider();
    announce("u1", "MetaMask", "io.metamask", mm); announce("u2", "OKX", "com.okex.wallet", okx);
    await walletStore.connect();
    expect(walletStore.getState().picker).toBe(true); expect(mm.calls).toEqual([]); expect(okx.calls).toEqual([]);
    await walletStore.connect("u2");
    const s = walletStore.getState();
    expect(s.picker).toBe(false); expect(s.account).toBe(ADDR); expect(s.chainId).toBe(5042002); expect(s.info?.rdns).toBe("com.okex.wallet");
    expect(okx.calls).toEqual(["eth_requestAccounts", "eth_chainId"]); expect(mm.calls).toEqual([]);
    expect(storage.get("arcpreflight.wallet")).toBe("com.okex.wallet");
  });
  it("with exactly one wallet connect() goes straight to eth_requestAccounts; with none it explains", async () => {
    walletStore.startDiscovery();
    await walletStore.connect();
    expect(walletStore.getState().error).toMatch(/No EIP-1193 wallet found/);
    const only = fakeProvider(); announce("u1", "Rabby", "io.rabby", only);
    await walletStore.connect();
    expect(walletStore.getState()).toMatchObject({ account: ADDR, picker: false, error: null }); expect(only.calls[0]).toBe("eth_requestAccounts");
  });
  it("falls back to legacy window.ethereum when nothing announces, and never lists the same provider twice", () => {
    const legacy = fakeProvider(); win.ethereum = legacy;
    walletStore.startDiscovery();
    expect(walletStore.candidates().map((c) => c.info.name)).toEqual(["Injected wallet"]);
    announce("u1", "MetaMask", "io.metamask", legacy); // the same object announced via 6963
    expect(walletStore.candidates().map((c) => c.info.name)).toEqual(["MetaMask"]);
  });
  it("disconnect revokes the account permission where supported, forgets the choice and clears the state", async () => {
    walletStore.startDiscovery(); const p = fakeProvider(); announce("u1", "MetaMask", "io.metamask", p);
    await walletStore.connect(); expect(walletStore.getState().account).toBe(ADDR);
    await walletStore.disconnect();
    expect(p.calls).toContain("wallet_revokePermissions");
    expect(walletStore.getState()).toMatchObject({ account: null, provider: null, info: null, chainId: null });
    expect(storage.has("arcpreflight.wallet")).toBe(false);
    // a wallet without wallet_revokePermissions still disconnects locally
    const q = fakeProvider({ revoke: false }); announce("u2", "OKX", "com.okex.wallet", q);
    await walletStore.connect("u2"); await walletStore.disconnect();
    expect(walletStore.getState().account).toBeNull();
  });
  it("tracks accountsChanged (empty = disconnected), chainChanged and disconnect events", async () => {
    walletStore.startDiscovery(); const p = fakeProvider(); announce("u1", "MetaMask", "io.metamask", p);
    await walletStore.connect();
    p.emit("accountsChanged", ["0x0000000000000000000000000000000000000b22"]); expect(walletStore.getState().account).toBe(getAddress("0x0000000000000000000000000000000000000b22"));
    p.emit("chainChanged", "0x13b2"); expect(walletStore.getState().chainId).toBe(5042);
    p.emit("accountsChanged", []); expect(walletStore.getState().account).toBeNull();
    p.emit("disconnect", { code: 4900 }); expect(walletStore.getState().chainId).toBeNull();
  });
  it("silently reconnects a remembered wallet through eth_accounts only, never prompting", async () => {
    storage.set("arcpreflight.wallet", "io.metamask");
    walletStore.startDiscovery(); const p = fakeProvider({ authorized: [ADDR] }); announce("u1", "MetaMask", "io.metamask", p);
    await walletStore.silentReconnect();
    expect(walletStore.getState().account).toBe(ADDR); expect(p.calls).toEqual(["eth_accounts", "eth_chainId"]);
    walletStore.resetWalletStore(); vi.stubGlobal("window", (win = new EventTarget()));
    walletStore.startDiscovery(); const q = fakeProvider({ authorized: [] }); announce("u1", "MetaMask", "io.metamask", q);
    await walletStore.silentReconnect();
    expect(walletStore.getState().account).toBeNull(); expect(q.calls).not.toContain("eth_requestAccounts");
  });
});

// ---- P3: automatic chain switch (once per event) and late reconnect ----
const NET: any = { network: "testnet", chainId: 5042002, rpc: "http://offline.invalid", explorer: "http://offline.invalid" };
/** a provider that starts on another chain and honours (or declines) wallet_switchEthereumChain */
function chainProvider(opts: { chain: number; decline?: boolean; authorized?: boolean } ) {
  let chain = opts.chain; const calls: string[] = [];
  const handlers = new Map<string, Set<(...a: any[]) => void>>();
  const p: any = {
    request: vi.fn(async ({ method, params }: { method: string; params?: any }) => {
      calls.push(method);
      if (method === "eth_requestAccounts") return [ADDR];
      if (method === "eth_accounts") return opts.authorized ? [ADDR] : [];
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "wallet_switchEthereumChain") { if (opts.decline) { const e: any = new Error("User rejected the request."); e.code = 4001; throw e; } chain = Number(params[0].chainId); handlers.get("chainChanged")?.forEach((cb) => cb(`0x${chain.toString(16)}`)); return null; }
      return null;
    }),
    on: (ev: string, cb: any) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev)!.add(cb); },
    removeListener: (ev: string, cb: any) => { handlers.get(ev)?.delete(cb); },
    calls,
  };
  return p;
}
const switches = (p: any) => p.calls.filter((m: string) => m === "wallet_switchEthereumChain").length;

describe("wallet store (P3: auto chain switch, late announce, legacy fallback)", () => {
  it("after connect a wallet on another chain is asked once to switch to the API's chain, and lands there", async () => {
    walletStore.setTargetNetwork(NET); walletStore.startDiscovery();
    const p = chainProvider({ chain: 1 }); announce("u1", "OKX", "com.okex.wallet", p);
    await walletStore.connect();
    expect(walletStore.getState()).toMatchObject({ account: ADDR, chainId: 5042002, switching: false, error: null });
    expect(switches(p)).toBe(1);
    walletStore.setTargetNetwork({ ...NET }); // the same network reported again (poll): no new prompt
    await Promise.resolve(); expect(switches(p)).toBe(1);
  });
  it("a declined switch (4001) is not an error: the account stays connected on its chain and the menu fallback remains; a later network change asks again, once", async () => {
    walletStore.setTargetNetwork(NET); walletStore.startDiscovery();
    const p = chainProvider({ chain: 1, decline: true }); announce("u1", "OKX", "com.okex.wallet", p);
    await walletStore.connect();
    expect(walletStore.getState()).toMatchObject({ account: ADDR, chainId: 1, error: null, switching: false });
    expect(switches(p)).toBe(1);
    expect(await walletStore.ensureChain()).toBe(false); expect(switches(p)).toBe(2); // an explicit new event prompts again
    walletStore.setTargetNetwork({ ...NET, network: "mainnet", chainId: 5042 }); await new Promise((r) => setTimeout(r, 0));
    expect(switches(p)).toBe(3);
    expect(walletStore.getState().error).toBeNull();
  });
  it("a network change while connected prompts once; nothing is prompted while disconnected or already on the chain", async () => {
    walletStore.startDiscovery();
    const p = chainProvider({ chain: 5042002 }); announce("u1", "OKX", "com.okex.wallet", p);
    walletStore.setTargetNetwork(NET); await new Promise((r) => setTimeout(r, 0)); expect(switches(p)).toBe(0); // not connected yet
    await walletStore.connect(); expect(switches(p)).toBe(0); // already on the chain
    walletStore.setTargetNetwork({ ...NET, network: "mainnet", chainId: 5042 }); await new Promise((r) => setTimeout(r, 0));
    expect(switches(p)).toBe(1); expect(walletStore.getState().chainId).toBe(5042);
  });
  it("reconnects when the remembered wallet announces 50 ms after the first render (eth_accounts only), then switches to the API's chain", async () => {
    vi.useFakeTimers();
    try {
      storage.set("arcpreflight.wallet", "com.okex.wallet"); walletStore.setTargetNetwork(NET);
      walletStore.startDiscovery(); await walletStore.silentReconnect();
      expect(walletStore.getState().account).toBeNull();
      await vi.advanceTimersByTimeAsync(50);
      const p = chainProvider({ chain: 1, authorized: true }); announce("u2", "OKX Wallet", "com.okex.wallet", p);
      await vi.advanceTimersByTimeAsync(0);
      expect(walletStore.getState()).toMatchObject({ account: ADDR, chainId: 5042002 }); expect(walletStore.getState().info?.rdns).toBe("com.okex.wallet");
      expect(p.calls).toEqual(["eth_accounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]); expect(p.calls).not.toContain("eth_requestAccounts");
    } finally { vi.useRealTimers(); }
  });
  it("falls back after 1.5 s to a window.ethereum that still exposes an authorized account when the remembered wallet never announces; an unauthorized one stays disconnected", async () => {
    vi.useFakeTimers();
    try {
      storage.set("arcpreflight.wallet", "com.okex.wallet");
      const legacy = chainProvider({ chain: 5042002, authorized: true }); win.ethereum = legacy;
      walletStore.startDiscovery(); await walletStore.silentReconnect();
      expect(walletStore.getState().account).toBeNull(); // not yet: the remembered wallet may still announce
      await vi.advanceTimersByTimeAsync(1499); expect(walletStore.getState().account).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(walletStore.getState()).toMatchObject({ account: ADDR, chainId: 5042002 }); expect(walletStore.getState().info?.rdns).toBe("com.okex.wallet");
      expect(legacy.calls).toEqual(["eth_accounts", "eth_chainId"]);
      // no authorized account on window.ethereum: nothing connects, nothing prompts
      walletStore.resetWalletStore(); vi.stubGlobal("window", (win = new EventTarget()));
      const cold = chainProvider({ chain: 5042002, authorized: false }); win.ethereum = cold;
      walletStore.startDiscovery(); await vi.advanceTimersByTimeAsync(1600);
      expect(walletStore.getState().account).toBeNull(); expect(cold.calls).toEqual(["eth_accounts"]);
      // a public build never looks for the injected test provider: window.ethereum is the only legacy candidate
      walletStore.resetWalletStore(); vi.stubGlobal("window", (win = new EventTarget()));
      const test = chainProvider({ chain: 5042002, authorized: true }); test.isArcPreflightTestWallet = true; const other = chainProvider({ chain: 5042002, authorized: true });
      win.__arcpreflightTestProvider = test; win.ethereum = other;
      walletStore.startDiscovery(); await vi.advanceTimersByTimeAsync(1600);
      expect(walletStore.candidates().map((c) => c.info.name)).toEqual(["Injected wallet"]);
      expect(walletStore.getState()).toMatchObject({ account: ADDR, isTest: false }); expect(test.calls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it("in a VITE_TEST_WALLET=1 build the injected test provider is a candidate and keeps precedence over window.ethereum", async () => {
    vi.stubEnv("VITE_TEST_WALLET", "1"); vi.resetModules();
    const fresh = await import("../src/lib/wallet");
    vi.useFakeTimers();
    try {
      fresh.walletStore.resetWalletStore(); storage.set("arcpreflight.wallet", "com.okex.wallet");
      const test = chainProvider({ chain: 5042002, authorized: true }); test.isArcPreflightTestWallet = true; const other = chainProvider({ chain: 5042002, authorized: true });
      win.__arcpreflightTestProvider = test; win.ethereum = other;
      fresh.walletStore.startDiscovery(); await vi.advanceTimersByTimeAsync(1600);
      expect(fresh.walletStore.candidates().map((c) => c.info.name)).toEqual(["Test wallet (local)", "Injected wallet"]);
      expect(fresh.walletStore.getState()).toMatchObject({ account: ADDR, isTest: true }); expect(other.calls).toEqual([]);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); fresh.walletStore.resetWalletStore(); }
  });
});
