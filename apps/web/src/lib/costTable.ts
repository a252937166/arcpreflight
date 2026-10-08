// One cost disclosure table for runs and attempts (docs/LIFECYCLE.md §5, §9 "cost statement 1.1"), straight from `costStatement` — the
// same object the passport writes. The `usdc` strings are rendered as given; atomic-only cells are rendered exactly with BigInt
// arithmetic (never floats). A null line is "not available (receipt unavailable)", never 0. A group whose receipt is missing
// (`complete === false`, or — for a 1.0 statement — a null line whose transaction exists) never shows a bare total: it reads
// "incomplete: <component> not available". The buyer is labelled by `buyer.role`, else by the execution mode: a project-funded run
// never reads "your wallet".
import type { CostStatement } from "./api";

export const NOT_AVAILABLE = "not available (receipt unavailable)";
export type CostRow = { key: string; group: "buyer" | "operator"; label: string; authorized: string; actual: string; unresolved: string; tx: string | null; hint?: string };
export type CostContext = { executionMode?: "runner" | "wallet" | null; subjectKind?: "demo-run" | "wallet-run" | "paid-check" | string | null };
export type CostGroup = { total: string | null; complete: boolean; missing: string[]; incomplete: string | null };
export type CostTableModel = { rows: CostRow[]; buyer: (CostGroup & { address: string; role: string }) | null; operator: CostGroup | null; unresolved: { usdc: string; note: string | null } | null; notes: string[] };

const NATIVE = 10n ** 18n, TOKEN = 10n ** 6n;
/** exact decimal rendering of an atomic value (trailing zeros trimmed); the statement's own `usdc` strings use the same rule */
export function exactUsdc(atomic: string | bigint | null | undefined, decimals: 18 | 6 = 18): string | null {
  if (atomic === null || atomic === undefined || atomic === "") return null;
  let v: bigint; try { v = typeof atomic === "bigint" ? atomic : BigInt(atomic); } catch { return null; }
  const unit = decimals === 18 ? NATIVE : TOKEN;
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / unit}${frac ? `.${frac}` : ""}`;
}
const usdc = (s: string | null | undefined) => (s === null || s === undefined ? NOT_AVAILABLE : `${s} USDC`);
const maybe = (s: string | null) => (s === null ? "—" : `${s} USDC`);

export const ROLE_LABELS = { "project-runner": "project demo-runner — project-funded, not your wallet", "visitor-wallet": "your wallet", buyer: "the buyer" } as const;
/** `buyer.role` when the statement carries it (1.1); otherwise the execution mode or the passport subject decides; never "your wallet" by default */
export function buyerRoleLabel(c: Pick<CostStatement, "buyer"> | null | undefined, ctx: CostContext = {}): string {
  const role = (c?.buyer as { role?: string } | undefined)?.role;
  if (role && role in ROLE_LABELS) return ROLE_LABELS[role as keyof typeof ROLE_LABELS];
  if (ctx.executionMode === "runner" || ctx.subjectKind === "demo-run") return ROLE_LABELS["project-runner"];
  if (ctx.executionMode === "wallet" || ctx.subjectKind === "wallet-run") return ROLE_LABELS["visitor-wallet"];
  return ROLE_LABELS.buyer;
}
const incompleteText = (missing: string[]) => `incomplete: ${missing.length ? missing.join(" and ") : "a receipt"} not available`;
/** `complete` from the statement (1.1) or derived from the null entries (1.0): a line is missing when its transaction exists but its receipt line is null */
export function completeness(c: CostStatement): { buyer: CostGroup; operator: CostGroup } {
  const b = c.buyer as CostStatement["buyer"] & { complete?: boolean }, o = c.operator as CostStatement["operator"] & { complete?: boolean }, s = c.sources ?? { feeTx: null, createOrderTx: null, businessTx: null };
  const buyerMissing = s.businessTx && !b?.businessGas ? ["business gas"] : [];
  const operatorMissing = [...(s.feeTx && !o?.feeRelay ? ["fee-relay gas"] : []), ...(s.createOrderTx && !o?.orderCreation ? ["order-creation gas"] : [])];
  const buyerComplete = (b?.complete ?? buyerMissing.length === 0) && buyerMissing.length === 0;
  const operatorComplete = (o?.complete ?? operatorMissing.length === 0) && operatorMissing.length === 0;
  return {
    buyer: { total: buyerComplete ? usdc(b?.totalUsdc) : null, complete: buyerComplete, missing: buyerMissing, incomplete: buyerComplete ? null : incompleteText(buyerMissing) },
    operator: { total: operatorComplete ? usdc(o?.totalUsdc) : null, complete: operatorComplete, missing: operatorMissing, incomplete: operatorComplete ? null : incompleteText(operatorMissing) },
  };
}

export function costTable(c: CostStatement | null | undefined, ctx: CostContext = {}): CostTableModel {
  if (!c) return { rows: [], buyer: null, operator: null, unresolved: null, notes: [] };
  const b = c.buyer, o = c.operator, max = c.authorizedMaximum ?? { businessPrincipalNativeAtomic: null, checkFeeTokenAtomic: null, businessGasNativeAtomic: null }, act = c.actual ?? { businessPrincipalNativeAtomic: null, checkFeeTokenAtomic: null, businessGasNativeAtomic: null };
  const unresolved = c.unresolvedReservation ? exactUsdc(c.unresolvedReservation.nativeAtomic) : null;
  const rows: CostRow[] = [
    { key: "principal", group: "buyer", label: "business principal", authorized: maybe(exactUsdc(max.businessPrincipalNativeAtomic)), actual: usdc(b?.businessPrincipal?.usdc ?? exactUsdc(act.businessPrincipalNativeAtomic)), unresolved: unresolved === null ? "—" : `${unresolved} USDC`, tx: c.sources?.businessTx ?? null, hint: "policy.maxNativePaymentAtomic → the order amount that moved" },
    { key: "fee", group: "buyer", label: "check fee", authorized: maybe(exactUsdc(max.checkFeeTokenAtomic, 6)), actual: b?.checkFee ? usdc(b.checkFee.usdc) : usdc(exactUsdc(act.checkFeeTokenAtomic, 6)), unresolved: "—", tx: c.sources?.feeTx ?? null, hint: "policy.maxServiceFeeTokenAtomic → the settled EIP-3009 fee (6-dec)" },
    { key: "businessGas", group: "buyer", label: "business gas", authorized: maybe(exactUsdc(max.businessGasNativeAtomic)), actual: b?.businessGas ? `${usdc(b.businessGas.usdc)} · ${b.businessGas.gasUsed} gas` : NOT_AVAILABLE, unresolved: "—", tx: c.sources?.businessTx ?? null, hint: "plan gasLimit × maxFeePerGas → the receipt" },
    { key: "feeRelay", group: "operator", label: "fee-relay gas", authorized: "—", actual: o?.feeRelay ? `${usdc(o.feeRelay.usdc)} · ${o.feeRelay.gasUsed} gas` : NOT_AVAILABLE, unresolved: "—", tx: o?.feeRelay?.tx ?? c.sources?.feeTx ?? null, hint: "paid by the relayer, not budgeted against the buyer" },
    { key: "orderCreation", group: "operator", label: "order-creation gas", authorized: "—", actual: o?.orderCreation ? `${usdc(o.orderCreation.usdc)} · ${o.orderCreation.gasUsed} gas` : NOT_AVAILABLE, unresolved: "—", tx: o?.orderCreation?.tx ?? c.sources?.createOrderTx ?? null, hint: "paid by the order creator, not budgeted against the buyer" },
  ];
  const done = completeness(c);
  return {
    rows,
    buyer: b ? { address: b.address, role: buyerRoleLabel(c, ctx), ...done.buyer } : null,
    operator: o ? done.operator : null,
    unresolved: c.unresolvedReservation ? { usdc: `${unresolved ?? "0"} USDC`, note: c.unresolvedReservation.note ?? null } : null,
    notes: Array.isArray(c.notes) ? c.notes : [],
  };
}
