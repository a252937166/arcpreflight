// Low-balance watch (operator decision 2026-10-09). The worker reads the project keys' native USDC balances on a schedule, keeps the
// latest reading, logs when a key crosses its warning threshold, and exposes the reading on GET /v1/network so the Evidence page can
// show it. Reads only: nothing is claimed, moved or signed here; topping a key up stays a manual, operator-side action.
export type FundsRole = "demo-runner" | "order-creator" | "merchant-payto" | "deployer-admin";
export const FUNDS_ROLES: FundsRole[] = ["demo-runner", "order-creator", "merchant-payto", "deployer-admin"];
export type FundsKey = { role: FundsRole; address: string; balanceNativeAtomic: string | null; warnBelowNativeAtomic: string; low: boolean; note: string };
export type FundsSnapshot = { checkedAt: string | null; intervalMs: number; low: boolean; keys: FundsKey[]; note: string };
export type FundsReader = { getBalance(a: { address: `0x${string}` }): Promise<bigint> };

const NOTES: Record<FundsRole, string> = {
  "demo-runner": "pays the project-funded demo runs (≈0.06 USDC each)",
  "order-creator": "creates orders (creation gas) and, on testnet, sends the faucet claims (0.2 USDC each)",
  "merchant-payto": "relays the check fee (≈0.002 USDC of gas per check)",
  "deployer-admin": "deployments and approved baselines only",
};
const ONE = 10n ** 18n;
/** defaults follow what each key must still afford: ≈16 demo runs, the faucet floor plus five claims, ≈250 fee relays, a few baseline writes */
const DEFAULT_WARN: Record<FundsRole, bigint> = { "demo-runner": ONE, "order-creator": 2n * ONE, "merchant-payto": ONE / 2n, "deployer-admin": ONE / 10n };
const envAtomic = (name: string, fallback: bigint): bigint => { const v = process.env[name]; if (!v) return fallback; try { return BigInt(v); } catch { return fallback; } };
export const WARN_BELOW: Record<FundsRole, bigint> = {
  "demo-runner": envAtomic("FUNDS_WARN_DEMO_RUNNER_ATOMIC", DEFAULT_WARN["demo-runner"]),
  "order-creator": envAtomic("FUNDS_WARN_ORDER_CREATOR_ATOMIC", DEFAULT_WARN["order-creator"]),
  "merchant-payto": envAtomic("FUNDS_WARN_MERCHANT_PAYTO_ATOMIC", DEFAULT_WARN["merchant-payto"]),
  "deployer-admin": envAtomic("FUNDS_WARN_DEPLOYER_ADMIN_ATOMIC", DEFAULT_WARN["deployer-admin"]),
};
export const FUNDS_CHECK_INTERVAL_MS = Math.max(30_000, Number(process.env.FUNDS_CHECK_INTERVAL_MS ?? 5 * 60_000));
const NOTE = "native USDC balances read from the chain by the worker; the thresholds are the operator's; nothing is claimed or moved automatically";
const usdc = (atomic: string | null) => (atomic === null ? "?" : (Number(BigInt(atomic)) / 1e18).toFixed(4));

/** one reading of every configured key; an unreadable balance is null (and never "low") */
export async function readFunds(client: FundsReader, accounts: Partial<Record<FundsRole, string | null | undefined>>, warn: Record<FundsRole, bigint> = WARN_BELOW, at: string = new Date().toISOString()): Promise<FundsSnapshot> {
  const keys: FundsKey[] = [];
  for (const role of FUNDS_ROLES) {
    const address = accounts[role]; if (!address) continue;
    let balance: bigint | null = null;
    try { balance = await client.getBalance({ address: address as `0x${string}` }); } catch { balance = null; }
    keys.push({ role, address, balanceNativeAtomic: balance === null ? null : balance.toString(), warnBelowNativeAtomic: warn[role].toString(), low: balance !== null && balance < warn[role], note: NOTES[role] });
  }
  return { checkedAt: at, intervalMs: FUNDS_CHECK_INTERVAL_MS, low: keys.some((k) => k.low), keys, note: NOTE };
}

let latest: FundsSnapshot = { checkedAt: null, intervalMs: FUNDS_CHECK_INTERVAL_MS, low: false, keys: [], note: `${NOTE}; not read yet` };
export const fundsSnapshot = (): FundsSnapshot => latest;
/** test seam */
export function resetFunds() { latest = { checkedAt: null, intervalMs: FUNDS_CHECK_INTERVAL_MS, low: false, keys: [], note: `${NOTE}; not read yet` }; }

/** one worker pass: read, remember, and log every key that became low, recovered, or could not be read — on change, not every pass */
export async function fundsPass(client: FundsReader, accounts: Partial<Record<FundsRole, string | null | undefined>>, log: (m: string) => void, warn: Record<FundsRole, bigint> = WARN_BELOW, at?: string): Promise<FundsSnapshot> {
  const prev = latest;
  const next = await readFunds(client, accounts, warn, at);
  for (const k of next.keys) {
    const before = prev.keys.find((p) => p.role === k.role) ?? null;
    if (k.balanceNativeAtomic === null) { if (!before || before.balanceNativeAtomic !== null) log(`UNREAD ${k.role} ${k.address}: the balance could not be read`); continue; }
    if (k.low && !(before?.low ?? false)) log(`LOW ${k.role} ${k.address} holds ${usdc(k.balanceNativeAtomic)} USDC, below the ${usdc(k.warnBelowNativeAtomic)} USDC threshold — ${k.note}; top it up`);
    else if (!k.low && (before?.low ?? false)) log(`OK ${k.role} ${k.address} is back above its threshold: ${usdc(k.balanceNativeAtomic)} USDC`);
  }
  latest = next;
  return next;
}
