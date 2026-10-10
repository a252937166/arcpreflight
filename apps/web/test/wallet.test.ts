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
  walletStore.resetWalletStore(); walletStore.setDiscoveryWait(0); // Connect re-requests discovery; the tests below that need the wait set it
});
afterEach(() => { walletStore.resetWalletStore(); walletStore.setDiscoveryWait(600); vi.unstubAllGlobals(); });

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
  it("a remembered wallet that never announces is never replaced by window.ethereum: after ≈2 s of re-requests the store says it was not detected; nothing is touched", async () => {
    vi.useFakeTimers();
    try {
      storage.set("arcpreflight.wallet", "com.okex.wallet");
      const legacy = chainProvider({ chain: 5042002, authorized: true }); win.ethereum = legacy;
      const requests: number[] = []; win.addEventListener("eip6963:requestProvider", () => requests.push(Date.now()));
      walletStore.startDiscovery(); await walletStore.silentReconnect();
      await vi.advanceTimersByTimeAsync(1999); expect(walletStore.getState()).toMatchObject({ account: null, missing: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(walletStore.getState()).toMatchObject({ account: null, missing: { rdns: "com.okex.wallet", name: "OKX Wallet" } });
      expect(legacy.calls).toEqual([]); // the old 1.5 s fallback connected this provider and labelled it OKX — never again
      expect(requests).toHaveLength(3); // at start, then re-requested at 0.4 s and 1 s
      // the legacy entry is named from its own (absent) flags, never as the remembered wallet
      expect(walletStore.candidates().map((c) => [c.info.name, c.info.rdns])).toEqual([["Injected wallet", "legacy:injected"]]);
    } finally { vi.useRealTimers(); }
  });
  it("in a VITE_TEST_WALLET=1 build the injected test provider is a candidate; it reconnects only when it is the remembered wallet, never in place of another", async () => {
    vi.stubEnv("VITE_TEST_WALLET", "1"); vi.resetModules();
    const fresh = await import("../src/lib/wallet");
    vi.useFakeTimers();
    try {
      fresh.walletStore.resetWalletStore(); storage.set("arcpreflight.wallet", "com.okex.wallet");
      const test = chainProvider({ chain: 5042002, authorized: true }); test.isArcPreflightTestWallet = true; const other = chainProvider({ chain: 5042002, authorized: true });
      win.__arcpreflightTestProvider = test; win.ethereum = other;
      fresh.walletStore.startDiscovery(); await vi.advanceTimersByTimeAsync(2100);
      expect(fresh.walletStore.candidates().map((c) => c.info.name)).toEqual(["Test wallet (local)", "Injected wallet"]);
      expect(fresh.walletStore.getState()).toMatchObject({ account: null, missing: { name: "OKX Wallet" } }); expect(test.calls).toEqual([]); expect(other.calls).toEqual([]);
      fresh.walletStore.resetWalletStore(); storage.set("arcpreflight.wallet", "xyz.arcpreflight.testwallet"); // the self-tests remember the test wallet itself
      fresh.walletStore.startDiscovery(); await fresh.walletStore.silentReconnect();
      expect(fresh.walletStore.getState()).toMatchObject({ account: ADDR, isTest: true }); expect(other.calls).toEqual([]);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); fresh.walletStore.resetWalletStore(); }
  });
});

// ---- real-wallet session (2026-10-09): MetaMask missing in fresh and duplicated tabs; the legacy fallback reconnected OKX as MetaMask ----
/** a wallet whose page script answers EIP-6963 requests only from a given request on, `delayMs` after each request */
function lateWallet(name: string, rdns: string, provider: any, o: { answerFrom?: number; delayMs?: number } = {}) {
  let requests = 0;
  win.addEventListener("eip6963:requestProvider", () => { requests++; if (requests < (o.answerFrom ?? 1)) return; const fire = () => announce(`uuid-${rdns}`, name, rdns, provider); if (o.delayMs) setTimeout(fire, o.delayMs); else fire(); });
  return { requests: () => requests };
}
describe("audit 2026-10-10 (W09): a late completion never overrides the wallet the visitor chose", () => {
  it("remembered MetaMask's silent reconnect is held on its chain read; the visitor explicitly connects OKX; MetaMask's read lands → the connection stays OKX, the remembered wallet stays OKX", async () => {
    storage.set("arcpreflight.wallet", "io.metamask"); walletStore.setTargetNetwork(NET);
    let releaseChain!: (cid: string) => void;
    const mm = chainProvider({ chain: 5042002, authorized: true });
    const mmRequest = mm.request.getMockImplementation()!;
    mm.request.mockImplementation(async (a: any) => (a.method === "eth_chainId" ? new Promise<string>((r) => { releaseChain = r; }) : mmRequest(a)));
    const okx = chainProvider({ chain: 5042002, authorized: true });
    announce("u-mm", "MetaMask", "io.metamask", mm); announce("u-okx", "OKX Wallet", "com.okex.wallet", okx);
    const reconnect = walletStore.silentReconnect(); await new Promise((r) => setTimeout(r, 0)); // eth_accounts answered, eth_chainId held
    expect(walletStore.getState().account).toBeNull();
    await walletStore.connect("u-okx"); // the explicit choice
    expect(walletStore.getState()).toMatchObject({ account: ADDR, chainId: 5042002 }); expect(walletStore.getState().info?.rdns).toBe("com.okex.wallet");
    releaseChain(`0x${(5042002).toString(16)}`); await reconnect; await new Promise((r) => setTimeout(r, 0));
    expect(walletStore.getState().info?.rdns).toBe("com.okex.wallet"); expect(walletStore.getState().provider).toBe(okx); // MetaMask's late answer bound nothing
    expect(storage.get("arcpreflight.wallet")).toBe("com.okex.wallet");
    expect(mm.calls).not.toContain("eth_requestAccounts"); // the wallet that lost was never prompted and bound nothing
  });
  it("a connect held on the wallet's answer, then a disconnect: the late answer does not reconnect anything", async () => {
    let release!: (accs: string[]) => void;
    const p = chainProvider({ chain: 5042002, authorized: true });
    const orig = p.request.getMockImplementation()!;
    p.request.mockImplementation(async (a: any) => (a.method === "eth_requestAccounts" ? new Promise<string[]>((r) => { release = r; }) : orig(a)));
    announce("u1", "OKX Wallet", "com.okex.wallet", p);
    const pending = walletStore.connect("u1"); await new Promise((r) => setTimeout(r, 0));
    expect(walletStore.getState().connecting).toBe(true);
    await walletStore.disconnect();
    release([ADDR]); await pending; await new Promise((r) => setTimeout(r, 0));
    expect(walletStore.getState()).toMatchObject({ account: null, provider: null, connecting: false }); expect(storage.get("arcpreflight.wallet")).toBeUndefined();
  });
});

describe("discovery in fresh and duplicated tabs, and an honest legacy fallback", () => {
  it("Connect re-asks the wallets and waits: a wallet announcing 300 ms after the request is found while the picker reads 'looking for wallets…'", async () => {
    vi.useFakeTimers();
    try {
      walletStore.setDiscoveryWait(600);
      const mm = fakeProvider(); const w1 = lateWallet("MetaMask", "io.metamask", mm, { delayMs: 300 });
      walletStore.startDiscovery(); // the first request is answered 300 ms later too, but the page decides only when the visitor clicks
      const connecting = walletStore.connect();
      expect(walletStore.getState()).toMatchObject({ picker: true, searching: true });
      await vi.advanceTimersByTimeAsync(300); expect(walletStore.candidates().map((c) => friendlyName(c.info))).toEqual(["MetaMask"]);
      expect(walletStore.getState().searching).toBe(true); // still inside the wait
      await vi.advanceTimersByTimeAsync(300); await connecting;
      expect(walletStore.getState()).toMatchObject({ account: ADDR, picker: false, searching: false, error: null }); expect(mm.calls).toEqual(["eth_requestAccounts", "eth_chainId"]);
      expect(w1.requests()).toBe(2); // the page asked again on Connect
      expect(storage.get("arcpreflight.wallet")).toBe("io.metamask");
    } finally { vi.useRealTimers(); }
  });
  it("a duplicated tab whose wallet answers only a later request: the re-request on Connect finds it (the old single request found nothing)", async () => {
    const mm = fakeProvider(); const w1 = lateWallet("MetaMask", "io.metamask", mm, { answerFrom: 2 });
    walletStore.startDiscovery();
    expect(walletStore.candidates()).toEqual([]); // the first request went unanswered
    await walletStore.connect();
    expect(w1.requests()).toBe(2); expect(walletStore.getState()).toMatchObject({ account: ADDR, error: null }); expect(mm.calls[0]).toBe("eth_requestAccounts");
    // nothing at all answers: a readable error that suggests opening the extension and searching again
    walletStore.resetWalletStore(); vi.stubGlobal("window", (win = new EventTarget())); walletStore.startDiscovery();
    await walletStore.connect(); expect(walletStore.getState().error).toMatch(/No EIP-1193 wallet found in this tab.*Search again/);
  });
  it("remembered MetaMask with only an OKX-owned window.ethereum (isOkxWallet + isMetaMask): no silent connect, the notice names MetaMask, the legacy entry reads 'OKX Wallet' and is remembered as legacy:okx", async () => {
    vi.useFakeTimers();
    try {
      storage.set("arcpreflight.wallet", "io.metamask");
      const okx = chainProvider({ chain: 5042002, authorized: true }); okx.isOkxWallet = true; okx.isMetaMask = true; win.ethereum = okx;
      walletStore.startDiscovery(); await walletStore.silentReconnect(); await vi.advanceTimersByTimeAsync(2000);
      expect(walletStore.getState()).toMatchObject({ account: null, missing: { rdns: "io.metamask", name: "MetaMask" } });
      expect(okx.calls).toEqual([]); // never connected in MetaMask's place
      const [entry] = walletStore.candidates();
      expect(entry.info).toEqual({ uuid: "window-ethereum:okx", name: "OKX Wallet", icon: "", rdns: "legacy:okx" }); expect(friendlyName(entry.info)).toBe("OKX Wallet");
      await walletStore.connect(entry.info.uuid);
      expect(walletStore.getState()).toMatchObject({ account: ADDR, missing: null }); expect(walletStore.getState().info?.name).toBe("OKX Wallet");
      expect(storage.get("arcpreflight.wallet")).toBe("legacy:okx"); // remembered as what it is
      // a new tab: the legacy OKX choice reconnects silently, as OKX, through eth_accounts only
      walletStore.resetWalletStore(); vi.stubGlobal("window", (win = new EventTarget())); win.ethereum = okx; okx.calls.length = 0;
      walletStore.startDiscovery(); await walletStore.silentReconnect();
      expect(walletStore.getState()).toMatchObject({ account: ADDR }); expect(walletStore.getState().info?.rdns).toBe("legacy:okx"); expect(okx.calls).toEqual(["eth_accounts", "eth_chainId"]);
    } finally { vi.useRealTimers(); }
  });
  it("with MetaMask and OKX both announcing, each keeps its own label, no legacy entry is added, and the remembered one (MetaMask) reconnects", async () => {
    storage.set("arcpreflight.wallet", "io.metamask");
    const mm = chainProvider({ chain: 5042002, authorized: true }), okx = chainProvider({ chain: 5042002, authorized: true }); okx.isOkxWallet = true; okx.isMetaMask = true;
    win.ethereum = okx; // OKX also owns window.ethereum
    walletStore.startDiscovery();
    announce("u-okx", "OKX Wallet", "com.okex.wallet", okx); announce("u-mm", "MetaMask", "io.metamask", mm);
    await walletStore.silentReconnect();
    expect(walletStore.candidates().map((c) => friendlyName(c.info))).toEqual(["MetaMask", "OKX Wallet"]);
    expect(walletStore.getState()).toMatchObject({ account: ADDR }); expect(walletStore.getState().info?.rdns).toBe("io.metamask");
    expect(mm.calls).toEqual(["eth_accounts", "eth_chainId"]); expect(okx.calls).toEqual([]);
  });
  it("the remembered wallet announcing after the notice clears it and reconnects; 'Search again' re-asks and waits", async () => {
    vi.useFakeTimers();
    try {
      walletStore.setDiscoveryWait(600); storage.set("arcpreflight.wallet", "io.metamask");
      const requests: number[] = []; win.addEventListener("eip6963:requestProvider", () => requests.push(1));
      walletStore.startDiscovery(); await vi.advanceTimersByTimeAsync(2000);
      expect(walletStore.getState().missing).toMatchObject({ name: "MetaMask" }); const before = requests.length;
      const searching = walletStore.searchAgain(); expect(walletStore.getState().searching).toBe(true); expect(requests.length).toBe(before + 1);
      const mm = chainProvider({ chain: 5042002, authorized: true });
      await vi.advanceTimersByTimeAsync(200); announce("u-mm", "MetaMask", "io.metamask", mm); // the visitor opened the extension
      await vi.advanceTimersByTimeAsync(400); await searching;
      expect(walletStore.getState()).toMatchObject({ account: ADDR, missing: null, searching: false }); expect(mm.calls).not.toContain("eth_requestAccounts");
    } finally { vi.useRealTimers(); }
  });
});
