// Enforced spending limits for operator scripts (Gate D). Every transaction a script signs is checked BEFORE it is signed against a
// per-transaction cap and a running total, both counting the native value, any token amount (in 18-decimal native units) and the gas
// worst case (gasLimit × maxFeePerGas — the transaction is then sent with exactly that gas limit and max fee, so it cannot cost more).
// A max-fee ceiling refuses sending into a fee spike. A send whose outcome is unknown stays committed at its worst case. Pure: the
// scripts persist `entries` (a ledger per network and step) so a re-run of the same step continues the same total instead of starting over.
export type SpendLimits = { label: string; network: string; perTxNativeAtomic: bigint; totalNativeAtomic: bigint; maxFeePerGasCeiling: bigint };
/** `authorization: true` — an off-chain signed token authorization (EIP-3009) that someone else relays: it carries no gas of its own, so
 *  gas and max fee may be 0 and the fee ceiling does not apply; its token amount still counts against both caps */
export type SpendItem = { purpose: string; to?: string | null; valueNativeAtomic?: bigint; tokenNativeEquivalent?: bigint; gasLimit: bigint; maxFeePerGas: bigint; authorization?: boolean };
export type SpendStatus = "reserved" | "sent" | "settled" | "released";
export type SpendEntry = { purpose: string; to: string | null; worstNativeAtomic: string; actualNativeAtomic: string | null; status: SpendStatus; txHash: string | null; at: string };
export class SpendRefused extends Error { constructor(msg: string) { super(msg); this.name = "SpendRefused"; } }
const E18 = 10n ** 18n;
/** exact decimal rendering of an 18-decimal native amount */
export const usdc18 = (a: bigint): string => { const neg = a < 0n; const v = neg ? -a : a; const frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, ""); return `${neg ? "-" : ""}${v / E18}${frac ? `.${frac}` : ""}`; };
/** parse "0.15" (USDC) into 18-decimal native units; refuses anything that is not a plain non-negative decimal */
export function parseUsdc18(s: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(s.trim())) throw new SpendRefused(`not a USDC amount: ${JSON.stringify(s)}`);
  const [i, f = ""] = s.trim().split("."); return BigInt(i) * E18 + BigInt(f.padEnd(18, "0"));
}
export const worstCaseOf = (i: SpendItem): bigint => (i.valueNativeAtomic ?? 0n) + (i.tokenNativeEquivalent ?? 0n) + i.gasLimit * i.maxFeePerGas;

export class SpendGuard {
  readonly entries: SpendEntry[];
  constructor(readonly limits: SpendLimits, prior: readonly SpendEntry[] = []) {
    if (limits.perTxNativeAtomic <= 0n || limits.totalNativeAtomic <= 0n || limits.maxFeePerGasCeiling <= 0n) throw new SpendRefused("spend limits must be positive");
    this.entries = prior.map((e) => ({ ...e }));
  }
  /** settled actuals + the worst case of everything reserved or sent without a settled outcome */
  committed(): bigint { return this.entries.reduce((s, e) => s + (e.status === "settled" ? BigInt(e.actualNativeAtomic ?? e.worstNativeAtomic) : e.status === "released" ? 0n : BigInt(e.worstNativeAtomic)), 0n); }
  remaining(): bigint { const r = this.limits.totalNativeAtomic - this.committed(); return r > 0n ? r : 0n; }
  /** the worst case of `i`, or SpendRefused with the reason — nothing is recorded */
  check(i: SpendItem): bigint {
    if (i.authorization) { if (i.gasLimit !== 0n || i.maxFeePerGas !== 0n || (i.valueNativeAtomic ?? 0n) !== 0n) throw new SpendRefused(`${i.purpose}: a token authorization carries no gas and no native value`); }
    else if (i.gasLimit <= 0n || i.maxFeePerGas <= 0n) throw new SpendRefused(`${i.purpose}: gas limit and max fee must be explicit and positive`);
    if (!i.authorization && i.maxFeePerGas > this.limits.maxFeePerGasCeiling) throw new SpendRefused(`${i.purpose}: max fee ${i.maxFeePerGas / 10n ** 9n} gwei is above the ceiling of ${this.limits.maxFeePerGasCeiling / 10n ** 9n} gwei (fee spike) — not sent`);
    const worst = worstCaseOf(i);
    if (worst > this.limits.perTxNativeAtomic) throw new SpendRefused(`${i.purpose}: worst case ${usdc18(worst)} USDC exceeds the per-transaction cap of ${usdc18(this.limits.perTxNativeAtomic)} USDC — not sent`);
    const after = this.committed() + worst;
    if (after > this.limits.totalNativeAtomic) throw new SpendRefused(`${i.purpose}: ${usdc18(this.committed())} USDC already committed + worst case ${usdc18(worst)} USDC exceeds the ${this.limits.label} total cap of ${usdc18(this.limits.totalNativeAtomic)} USDC — not sent`);
    return worst;
  }
  /** check, then record the worst case as committed; returns the entry index */
  reserve(i: SpendItem, at: string = new Date().toISOString()): number {
    const worst = this.check(i);
    this.entries.push({ purpose: i.purpose, to: i.to ?? null, worstNativeAtomic: worst.toString(), actualNativeAtomic: null, status: "reserved", txHash: null, at });
    return this.entries.length - 1;
  }
  /** the transaction was signed and handed to the network: from here on it may cost up to its worst case whatever happens */
  sent(idx: number, txHash: string) { const e = this.entry(idx); e.status = "sent"; e.txHash = txHash; }
  /** the receipt is known: the actual cost (value + token + gasUsed × effectiveGasPrice) replaces the worst case */
  settle(idx: number, actualNativeAtomic: bigint) { const e = this.entry(idx); e.status = "settled"; e.actualNativeAtomic = actualNativeAtomic.toString(); }
  /** only when it is certain nothing was signed or sent (a failure before signing) */
  release(idx: number) { const e = this.entry(idx); if (e.status !== "reserved") throw new SpendRefused(`${e.purpose}: a ${e.status} entry cannot be released (it may have reached the network)`); e.status = "released"; }
  summary() { return { label: this.limits.label, network: this.limits.network, perTxCapUsdc: usdc18(this.limits.perTxNativeAtomic), totalCapUsdc: usdc18(this.limits.totalNativeAtomic), maxFeeCeilingGwei: (this.limits.maxFeePerGasCeiling / 10n ** 9n).toString(), committedUsdc: usdc18(this.committed()), remainingUsdc: usdc18(this.remaining()), entries: this.entries }; }
  private entry(idx: number) { const e = this.entries[idx]; if (!e) throw new SpendRefused(`no spend entry #${idx}`); return e; }
}

/** Measured outflow across a set of project addresses (for spends a script triggers but does not sign itself, e.g. through the API):
 *  the sum of their balances at the start minus the sum now. Transfers between the measured addresses net out; gas and payments to
 *  other addresses count. `headroomFor(worst)` refuses the next step when it could carry the outflow past the cap. */
export class OutflowMeter {
  constructor(readonly label: string, readonly capNativeAtomic: bigint, readonly startTotal: bigint) {}
  outflow(currentTotal: bigint): bigint { const o = this.startTotal - currentTotal; return o > 0n ? o : 0n; }
  headroomFor(currentTotal: bigint, nextWorst: bigint): { ok: boolean; outflow: bigint; reason: string | null } {
    const outflow = this.outflow(currentTotal);
    if (outflow + nextWorst > this.capNativeAtomic) return { ok: false, outflow, reason: `${this.label}: measured outflow ${usdc18(outflow)} USDC + next step's worst case ${usdc18(nextWorst)} USDC exceeds the cap of ${usdc18(this.capNativeAtomic)} USDC — stopping` };
    return { ok: true, outflow, reason: null };
  }
}
