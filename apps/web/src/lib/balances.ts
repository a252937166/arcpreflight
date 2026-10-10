// One balance per connected wallet, shared by every view of it (presentation review 2026-10-09, finding 2). The nav chip, the Developer
// page, the Demo page and the faucet cards used to run their own `useBalances` hook, so the header kept showing 0.18 USDC after the
// Developer page had refreshed to 0.1170. Now every hook subscribes to ONE store entry per (provider, account): a refresh anywhere — a
// settled check fee, a confirmed payment, a faucet claim, a view opening — updates all of them at once. Other tabs of this origin are told
// through the `storage` event (the browser fires it in every other tab, never in the writer) and re-read until they see the change.
// Reads still go through the wallet's own provider: nothing here invents a balance, and a tab never adopts another tab's number unread.
import { useCallback, useEffect, useState } from "react";
import { erc20Balance, nativeBalance, type Eip1193 } from "./wallet";

export type Balances = { native: bigint | null; erc20: bigint | null; readAt: number | null };
/** `untilChanged` (default): re-read every 2 s, up to 8 times, until the native value differs from the last one shown — public RPC nodes
 *  lag a few blocks — or equals `expect` (a value another view or tab already read). `untilChanged: false` reads once (a panel opening). */
export type RefreshOptions = { untilChanged?: boolean; expect?: bigint | null };
export const EMPTY_BALANCES: Balances = { native: null, erc20: null, readAt: null };
export const BALANCE_RECHECK_MS = 2000;
export const BALANCE_RECHECK_MAX = 8;
/** the localStorage key other tabs watch; the value is `{ account, native, at, tab }` — a signal to re-read, never a balance to display */
export const BALANCE_SIGNAL_KEY = "arcpreflight.balances:signal";

type Loop = { untilChanged: boolean; expect: bigint | null; attempts: number; before: bigint | null; joined: Promise<void>; done: () => void; read: () => void; followUp: boolean };
type Entry = { provider: Eip1193; account: string; usdc: string | null; value: Balances; listeners: Set<() => void>; gen: number; timer: ReturnType<typeof setTimeout> | null; reading: boolean; settle: (() => void) | null; loop: Loop | null };
const providerIds = new WeakMap<Eip1193, number>(); let nextProviderId = 1;
function providerId(p: Eip1193): number { let id = providerIds.get(p); if (id === undefined) { id = nextProviderId++; providerIds.set(p, id); } return id; }
const keyOf = (p: Eip1193, account: string) => `${providerId(p)}|${account.toLowerCase()}`;
const entries = new Map<string, Entry>();
const TAB = Math.random().toString(36).slice(2, 10);

function entryOf(p: Eip1193, account: string, usdc: string | null): Entry {
  const key = keyOf(p, account);
  let e = entries.get(key);
  if (!e) { e = { provider: p, account, usdc, value: EMPTY_BALANCES, listeners: new Set(), gen: 0, timer: null, reading: false, settle: null, loop: null }; entries.set(key, e); }
  // the ERC-20 face is read for everyone once one view asks for it; a read already in flight started without it, so one more read follows
  if (usdc && !e.usdc) { e.usdc = usdc; if (e.loop) e.loop.followUp = true; }
  return e;
}
const notify = (e: Entry) => { for (const l of [...e.listeners]) l(); };
/** ends the running loop: its promise resolves (superseded or stopped), its timer is cleared, its late reads are ignored */
const stopLoop = (e: Entry) => { e.gen++; e.reading = false; e.loop = null; if (e.timer) { clearTimeout(e.timer); e.timer = null; } const settle = e.settle; e.settle = null; settle?.(); };

/** the last reading shared by every view of this wallet (EMPTY until the first read lands) */
export function balancesOf(p: Eip1193, account: string): Balances { return entries.get(keyOf(p, account))?.value ?? EMPTY_BALANCES; }

/** Re-read this wallet's balances through its provider and hand the result to every subscribed view. One loop per entry: a request that
 *  arrives while a loop runs JOINS it — a single read (a panel opening) never replaces an until-changed loop with one stale read (review
 *  2026-10-10, P2), and a second until-changed request keeps the loop, adopts its `expect` and starts the re-read budget afresh. Resolves
 *  when the loop settles (never rejects: a provider error keeps the last reading). */
export function refreshBalances(p: Eip1193, account: string, opts: RefreshOptions = {}): Promise<void> {
  const e = entryOf(p, account, null);
  const untilChanged = opts.untilChanged !== false; const expect = opts.expect ?? null;
  if (e.loop) {
    const l = e.loop;
    if (untilChanged) { l.untilChanged = true; l.attempts = 0; if (expect !== null) l.expect = expect; }
    if (e.timer) { clearTimeout(e.timer); e.timer = null; l.read(); } // read now instead of waiting out the pause; the loop goes on if the value has not moved
    return l.joined;
  }
  stopLoop(e);
  const gen = e.gen; e.reading = true;
  const loop: Loop = { untilChanged, expect, attempts: 0, before: e.value.native, joined: Promise.resolve(), done: () => {}, read: () => {}, followUp: false };
  loop.joined = new Promise<void>((resolve) => {
    let finished = false;
    const done = () => { if (finished) return; finished = true; if (e.settle === done) e.settle = null; if (e.loop === loop) e.loop = null; resolve(); };
    loop.done = done; e.settle = done; e.loop = loop;
    const read = (): Promise<void> => Promise.all([nativeBalance(p, account), e.usdc ? erc20Balance(p, e.usdc, account) : Promise.resolve<bigint | null>(null)]).then(([native, erc20]) => {
      if (gen !== e.gen) return done(); // superseded or stopped (stopLoop resolved it already)
      const changed = loop.before === null || native !== loop.before;
      const settled = !loop.untilChanged || changed || (loop.expect !== null && native === loop.expect) || loop.attempts >= BALANCE_RECHECK_MAX;
      if (!settled) { loop.attempts++; e.timer = setTimeout(read, BALANCE_RECHECK_MS); return; } // the node still reports the old value
      // a token requirement arrived while this read was in flight: read once more so the ERC-20 face is not left unread
      if (loop.followUp && erc20 === null && e.usdc) { loop.followUp = false; loop.untilChanged = false; e.timer = setTimeout(read, 0); return; }
      e.timer = null; e.reading = false; e.value = { native, erc20, readAt: Date.now() }; notify(e);
      if (loop.before !== null && native !== loop.before) signalOtherTabs(account, native);
      done();
    }).catch(() => { if (gen === e.gen) { e.timer = null; e.reading = false; } done(); });
    loop.read = () => { void read(); };
    read();
  });
  return loop.joined;
}

/** A view of this wallet's balance: it sees the shared reading and re-reads once on mount (the cached value shows meanwhile) unless a
 *  loop is already delivering. Returns the unsubscribe; the last view leaving stops a running loop. */
export function subscribeBalances(p: Eip1193, account: string, usdc: string | null, listener: () => void): () => void {
  startBalanceSignals();
  const e = entryOf(p, account, usdc);
  e.listeners.add(listener);
  // a read in flight is joined (and, if this view brought the token requirement, followed by one more read); otherwise read once now
  if (!e.reading) void refreshBalances(p, account, { untilChanged: false });
  else if (usdc && e.value.erc20 === null && e.loop) e.loop.followUp = true;
  return () => { e.listeners.delete(listener); if (e.listeners.size === 0) stopLoop(e); };
}

// ---- other tabs
function signalOtherTabs(account: string, native: bigint | null) {
  try { localStorage.setItem(BALANCE_SIGNAL_KEY, JSON.stringify({ account: account.toLowerCase(), native: native === null ? null : native.toString(), at: Date.now(), tab: TAB })); } catch { /* storage unavailable: this tab's views are already updated */ }
}
/** what another tab wrote under `BALANCE_SIGNAL_KEY`: every subscribed view of that account re-reads until it sees that value or a change */
export function onBalanceSignal(raw: string | null): void {
  if (!raw) return;
  let d: any; try { d = JSON.parse(raw); } catch { return; }
  if (!d || typeof d.account !== "string" || d.tab === TAB) return;
  let expect: bigint | null = null; if (typeof d.native === "string") { try { expect = BigInt(d.native); } catch { expect = null; } }
  for (const e of entries.values()) if (e.account.toLowerCase() === d.account.toLowerCase() && e.listeners.size > 0) void refreshBalances(e.provider, e.account, { untilChanged: true, expect });
}
let signalsOn: { target: any; handler: (ev: StorageEvent) => void } | null = null;
function startBalanceSignals() {
  const target: any = typeof window !== "undefined" ? window : null;
  if (!target || typeof target.addEventListener !== "function" || signalsOn?.target === target) return;
  if (signalsOn) signalsOn.target.removeEventListener?.("storage", signalsOn.handler);
  const handler = (ev: StorageEvent) => { if (ev.key === BALANCE_SIGNAL_KEY) onBalanceSignal(ev.newValue); };
  target.addEventListener("storage", handler);
  signalsOn = { target, handler };
}

/** tests: forget every entry, stop every loop, detach the storage listener */
export function resetBalanceStore() {
  for (const e of entries.values()) stopLoop(e);
  entries.clear();
  if (signalsOn) { try { signalsOn.target.removeEventListener?.("storage", signalsOn.handler); } catch { /* detached already */ } signalsOn = null; }
}

/** The connected wallet's balances on the API's chain, shared with every other view of the same wallet (see the file comment). `refresh()`
 *  re-reads until the value changes (see `RefreshOptions`); `refresh({ untilChanged: false })` reads once. The parameter is deliberately
 *  loose: callers hand `refresh` to `onClaimed(claim)`-style callbacks too. */
export function useBalances(provider: Eip1193 | null, account: string | null, enabled: boolean, usdc?: string | null) {
  const on = !!provider && !!account && enabled;
  const [value, setValue] = useState<Balances>(() => (on ? balancesOf(provider!, account!) : EMPTY_BALANCES));
  useEffect(() => {
    if (!on) { setValue(EMPTY_BALANCES); return; }
    const off = subscribeBalances(provider!, account!, usdc ?? null, () => setValue(balancesOf(provider!, account!)));
    setValue(balancesOf(provider!, account!));
    return off;
  }, [provider, account, on, usdc]);
  const refresh = useCallback((opts?: RefreshOptions | object) => {
    if (!on) return;
    const o = (opts && typeof opts === "object" ? opts : {}) as RefreshOptions;
    void refreshBalances(provider!, account!, { untilChanged: o.untilChanged !== false, expect: o.expect ?? null });
  }, [provider, account, on]);
  return { native: value.native, erc20: value.erc20, readAt: value.readAt, refresh };
}
