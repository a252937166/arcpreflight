// Testnet faucet (P3) and the budget check (review round 2, docs/LIFECYCLE.md §9 "order dialog"): a connected wallet with too little
// USDC for the step in front of it is told exactly what the step needs — check fee + order amount + gas reserve — and, on the testnet
// instance, offered a claim from the project's testnet funds. Testnet only — the API answers 404 elsewhere and the site never offers
// it on a mainnet instance. Budgeted on the server (one claim per wallet and per client every 24 h, a daily cap).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FaucetClaim, type NetworkInfo } from "./api";
import { erc20Balance, nativeBalance, type Eip1193 } from "./wallet";
import { exactUsdc } from "./costTable";
import { describeError, type Described } from "./errors";

export type FaucetWallet = { account: string | null; chainId: number | null };
/** 100 000 gas × 30 gwei = 0.003 USDC: the reserve assumed before a validated plan exists */
export const DEFAULT_GAS_RESERVE_NATIVE_ATOMIC = 100_000n * 30_000_000_000n;
const TOKEN_TO_NATIVE = 10n ** 12n; // 6-decimal token units → 18-decimal native units
export type BudgetPlan = { gasLimit: string; maxFeePerGasNativeAtomic: string } | null | undefined;
/** `feePaid`: the report is already delivered (its fee settled), so the step in front of the visitor needs the order amount and the gas only */
export type BudgetInput = { feeTokenAtomic: string | bigint | null | undefined; amountNativeAtomic: string | bigint | null | undefined; plan?: BudgetPlan; feePaid?: boolean };
const big = (v: string | bigint | null | undefined): bigint => { if (v === null || v === undefined || v === "") return 0n; try { return typeof v === "bigint" ? v : BigInt(v); } catch { return 0n; } };
/** the plan's gasLimit × maxFeePerGas when a plan exists, else the default reserve */
export const gasReserveNativeAtomic = (plan: BudgetPlan): bigint => (plan ? big(plan.gasLimit) * big(plan.maxFeePerGasNativeAtomic) : DEFAULT_GAS_RESERVE_NATIVE_ATOMIC);
/** required = check fee (6-dec → 18-dec, unless already paid) + order amount + gas reserve */
export const requiredNativeAtomic = (i: BudgetInput): bigint => (i.feePaid ? 0n : big(i.feeTokenAtomic) * TOKEN_TO_NATIVE) + big(i.amountNativeAtomic) + gasReserveNativeAtomic(i.plan);
/** what the required amount is made of, for the sentences next to a disabled button and on the faucet card */
export const budgetComponents = (i: Pick<BudgetInput, "feePaid">) => (i.feePaid ? { short: "order + gas; the check fee is already paid", long: "order amount + gas reserve; the check fee is already paid" } : { short: "fee + order + gas", long: "check fee + order amount + gas reserve" });
export type Budget = { required: bigint; balance: bigint | null; enough: boolean | null; sentence: string | null };
/** `enough` is null until the balance has been read; the sentence is the one the disabled button shows */
export function budgetCheck(balance: bigint | null, i: BudgetInput): Budget {
  const required = requiredNativeAtomic(i);
  if (balance === null) return { required, balance, enough: null, sentence: null };
  const enough = balance >= required;
  return { required, balance, enough, sentence: enough ? null : `your wallet holds ${exactUsdc(balance)} USDC; this step needs ≥ ${exactUsdc(required)} USDC (${budgetComponents(i).short})` };
}

/** The faucet exists for this wallet: testnet instance, faucet enabled, wallet connected on the API's chain. Never on mainnet. */
export function faucetAvailable(net: NetworkInfo | null, wallet: FaucetWallet): boolean {
  return !!net && net.network === "testnet" && net.chainId !== 5042 && net.faucet?.enabled === true && !!wallet.account && wallet.chainId === net.chainId;
}
/** …and the card is shown only when the wallet actually needs funds: native balance known and below what the step in front of it requires. */
export function faucetOffered(net: NetworkInfo | null, wallet: FaucetWallet, balance: bigint | null, required: bigint): boolean {
  return faucetAvailable(net, wallet) && balance !== null && balance < required;
}
export const claimFaucet = (address: string): Promise<FaucetClaim> => api.faucet(address);

/** The connected wallet's balances on the API's chain. `refresh()` re-reads; because public RPC nodes lag a few blocks, a refresh
 *  keeps re-reading every 2 s (up to 8 times) until the native value actually changes — so a faucet claim or a paid fee shows up.
 *  `refresh({ untilChanged: false })` reads once (a panel opening, where nothing is expected to have changed). */
export function useBalances(provider: Eip1193 | null, account: string | null, enabled: boolean, usdc?: string | null) {
  const [bal, setBal] = useState<{ native: bigint | null; erc20: bigint | null }>({ native: null, erc20: null });
  const [tick, setTick] = useState(0);
  const last = useRef<bigint | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (!provider || !account || !enabled) { setBal({ native: null, erc20: null }); last.current = null; return; }
    let alive = true; let attempts = 0; let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => Promise.all([nativeBalance(provider, account), usdc ? erc20Balance(provider, usdc, account) : Promise.resolve<bigint | null>(null)]).then(([native, erc20]) => {
      if (!alive) return;
      const changed = last.current === null || native !== last.current;
      if (changed || tick === 0 || attempts >= 8 || once.current) { last.current = native; setBal({ native, erc20 }); return; }
      attempts++; timer = setTimeout(read, 2000); // a refresh was asked for but the node still reports the old value
    }).catch(() => {});
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [provider, account, enabled, usdc, tick]);
  // the parameter is deliberately loose: callers hand `refresh` to `onClaimed(claim)`-style callbacks too
  const refresh = useCallback((opts?: { untilChanged?: boolean } | object) => { once.current = !!opts && typeof opts === "object" && (opts as { untilChanged?: boolean }).untilChanged === false; setTick((t) => t + 1); }, []);
  return { ...bal, refresh };
}

// ---- the faucet claim as the connected-wallet panel shows it (review item 7)
/** "sent" is the API's answer (a hash exists); "confirmed" is said only once the transaction's receipt was read through the wallet's
 *  provider and succeeded; "unconfirmed" means the receipt was not seen inside the window — never a confirmation that was not read. */
export type FaucetProgress =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; claim: FaucetClaim }
  | { phase: "confirmed"; claim: FaucetClaim; block: string | null }
  | { phase: "unconfirmed"; claim: FaucetClaim }
  | { phase: "error"; error: Described; claim?: FaucetClaim | null };
export const FAUCET_RECEIPT_POLL_MS = 2000;
export const FAUCET_RECEIPT_MAX_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const blockOf = (rc: any): string | null => { const b = rc?.blockNumber; if (b === null || b === undefined) return null; if (typeof b === "string") return b.startsWith("0x") ? String(parseInt(b, 16)) : b; return String(b); };
/** polls eth_getTransactionReceipt through the provider every `pollMs` for up to `maxMs`: a successful receipt → confirmed (with its block), a failed one → reverted, none in time → unconfirmed */
export async function awaitFaucetReceipt(provider: Eip1193, txHash: string, o: { pollMs?: number; maxMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number; alive?: () => boolean } = {}): Promise<{ kind: "confirmed"; block: string | null } | { kind: "reverted" } | { kind: "unconfirmed" }> {
  const pollMs = o.pollMs ?? FAUCET_RECEIPT_POLL_MS, maxMs = o.maxMs ?? FAUCET_RECEIPT_MAX_MS, wait = o.wait ?? sleep, now = o.now ?? Date.now, alive = o.alive ?? (() => true);
  const t0 = now();
  for (;;) {
    let rc: any = null;
    try { rc = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }); } catch { rc = null; }
    if (!alive()) return { kind: "unconfirmed" };
    if (rc && typeof rc === "object") {
      const ok = rc.status === "0x1" || rc.status === 1 || rc.status === "success" || rc.status === true;
      return ok ? { kind: "confirmed", block: blockOf(rc) } : { kind: "reverted" };
    }
    if (now() - t0 >= maxMs) return { kind: "unconfirmed" };
    await wait(pollMs);
  }
}
/** the claim flow for a connected account: POST /v1/faucet, then the receipt through the wallet's provider; `onSettled` fires once the
 *  claim is confirmed, unconfirmed or reverted (a balance refresh belongs there). A second claim supersedes the first one's follow-up. */
export function useFaucetClaim(provider: Eip1193 | null, account: string | null, o: { onSettled?: (p: FaucetProgress) => void; pollMs?: number; maxMs?: number } = {}) {
  const [progress, setProgress] = useState<FaucetProgress>({ phase: "idle" });
  const alive = useRef(true); const gen = useRef(0); const settled = useRef(o.onSettled); settled.current = o.onSettled;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const claim = useCallback(async () => {
    if (!account) return;
    const g = ++gen.current;
    const live = () => alive.current && g === gen.current;
    setProgress({ phase: "sending" });
    let c: FaucetClaim;
    try { c = await claimFaucet(account); } catch (e) { if (live()) setProgress({ phase: "error", error: describeError(e) }); return; }
    if (!live()) return;
    setProgress({ phase: "sent", claim: c });
    if (!provider) { settled.current?.({ phase: "sent", claim: c }); return; }
    const r = await awaitFaucetReceipt(provider, c.txHash, { pollMs: o.pollMs, maxMs: o.maxMs, alive: live });
    if (!live()) return;
    const p: FaucetProgress = r.kind === "confirmed" ? { phase: "confirmed", claim: c, block: r.block }
      : r.kind === "reverted" ? { phase: "error", error: { text: "The faucet transaction reverted on the node; nothing was received. Try again in a moment.", code: "FAUCET_REVERTED", raw: null }, claim: c }
      : { phase: "unconfirmed", claim: c };
    setProgress(p); settled.current?.(p);
  }, [account, provider, o.pollMs, o.maxMs]);
  const reset = useCallback(() => { gen.current++; setProgress({ phase: "idle" }); }, []);
  return { progress, claim, reset };
}
