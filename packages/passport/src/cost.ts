// cost-statement.json (docs/PASSPORT.md §4): buyer vs operator USDC costs from receipts. BigInt only; a missing receipt yields
// null plus a note — nothing is estimated as if it had been measured.
import { COST_STATEMENT_VERSION, type BuyerRole, type CostStatement, type GasCost, type GasCostWithAddress, type Hex } from "./types.js";
import { formatNative, formatToken, tokenToNative } from "./format.js";

export type ReceiptLike = { gasUsed: bigint | string | number; effectiveGasPrice: bigint | string | number; from?: string | null; transactionHash?: string | null; status?: unknown };
export type CostInput = {
  buyer: Hex;
  /** who the buyer is (a project-funded demo never reads as "your wallet"); default "buyer" */
  buyerRole?: BuyerRole;
  relayer: Hex | null;
  orderCreator: Hex | null;
  /** the order amount; counted as paid only when businessPaid is true */
  businessPrincipalNativeAtomic: string;
  businessPaid: boolean;
  /** the settled check fee in 6-decimal token units; null when no fee settled */
  checkFeeTokenAtomic: string | null;
  plan: { gasLimit: string; maxFeePerGasNativeAtomic: string } | null;
  policy: { maxNativePaymentAtomic: string; maxServiceFeeTokenAtomic: string } | null;
  receipts: { feeTx?: ReceiptLike | null; businessTx?: ReceiptLike | null; createOrderTx?: ReceiptLike | null };
  txs: { feeTx?: Hex | null; businessTx?: Hex | null; createOrderTx?: Hex | null };
  unresolvedReservationNativeAtomic?: string;
  capturedAt?: string;
  /** Which source transactions this statement MUST account for (review of bf0c800, P2): a required source that is not even recorded makes the
   *  total incomplete — "not applicable" (this run made no business payment) is told apart from "required evidence missing" (a run always
   *  created its order; a paid payment has a hash). Defaults, for callers that do not say: a hash that is recorded, a paid business payment,
   *  a settled check fee. */
  expected?: { feeTx?: boolean; businessTx?: boolean; createOrderTx?: boolean };
};

const big = (v: bigint | string | number): bigint => (typeof v === "bigint" ? v : BigInt(v));
function gasCost(r: ReceiptLike | null | undefined, tx: Hex | null | undefined): GasCost | null {
  if (!r) return null;
  const used = big(r.gasUsed), price = big(r.effectiveGasPrice), cost = used * price;
  return { nativeAtomic: cost.toString(), usdc: formatNative(cost), gasUsed: used.toString(), effectiveGasPriceNativeAtomic: price.toString(), tx: tx ?? (r.transactionHash as Hex | null) ?? null };
}
const withAddress = (g: GasCost | null, address: Hex | null): GasCostWithAddress | null => (g ? { ...g, address } : null);

export function costStatement(i: CostInput): CostStatement {
  const notes = [
    "gas deductions are not payment Transfer events",
    "the fee's native-system and ERC-20 event representations are one payment",
    "sub-micro-USDC gas precision is preserved; usdc strings are exact decimal renderings of the atomic values",
  ];
  const principal = i.businessPaid ? BigInt(i.businessPrincipalNativeAtomic) : 0n;
  if (!i.businessPaid) notes.push("no business payment was made: the business principal counts as 0");
  const feeToken = i.checkFeeTokenAtomic !== null ? BigInt(i.checkFeeTokenAtomic) : null;
  const feeNative = feeToken !== null ? tokenToNative(feeToken) : 0n;
  if (feeToken === null) notes.push("no check fee settled: the check fee counts as 0");
  const businessGas = gasCost(i.receipts.businessTx, i.txs.businessTx);
  if (i.txs.businessTx && !businessGas) notes.push("business transaction receipt unavailable at export: businessGas is null, not estimated");
  const feeRelay = withAddress(gasCost(i.receipts.feeTx, i.txs.feeTx), i.relayer);
  if (i.txs.feeTx && !feeRelay) notes.push("fee relay receipt unavailable at export: operator.feeRelay is null, not estimated");
  const orderCreation = withAddress(gasCost(i.receipts.createOrderTx, i.txs.createOrderTx), i.orderCreator);
  if (i.txs.createOrderTx && !orderCreation) notes.push("order-creation receipt unavailable at export: operator.orderCreation is null, not estimated");
  // review of bf0c800 (P2): a source the statement must account for but that is not even recorded is MISSING EVIDENCE, not "not applicable"
  const expected = { feeTx: i.expected?.feeTx ?? (feeToken !== null || !!i.txs.feeTx), businessTx: i.expected?.businessTx ?? (i.businessPaid || !!i.txs.businessTx), createOrderTx: i.expected?.createOrderTx ?? !!i.txs.createOrderTx };
  if (expected.businessTx && !i.txs.businessTx) notes.push("business transaction evidence missing: no transaction hash is recorded for the business payment; businessGas is null, not estimated");
  if (expected.feeTx && !i.txs.feeTx) notes.push("fee relay evidence missing: no settlement transaction hash is recorded for the settled check fee; operator.feeRelay is null, not estimated");
  if (expected.createOrderTx && !i.txs.createOrderTx) notes.push("order-creation evidence missing: no creation transaction is recorded for this order; operator.orderCreation is null, not estimated");
  const buyerTotal = principal + feeNative + (businessGas ? BigInt(businessGas.nativeAtomic) : 0n);
  const operatorTotal = (feeRelay ? BigInt(feeRelay.nativeAtomic) : 0n) + (orderCreation ? BigInt(orderCreation.nativeAtomic) : 0n);
  // 1.1: a total that lacks a receipt it should include — unavailable at export, or never recorded although required — is a known subtotal,
  // flagged incomplete, never presented as the cost
  const buyerComplete = !(expected.businessTx && !businessGas);
  const operatorComplete = !(expected.feeTx && !feeRelay) && !(expected.createOrderTx && !orderCreation);
  if (!buyerComplete) notes.push("buyer total is incomplete: business gas not available");
  if (!operatorComplete) notes.push("operator total is incomplete: a relay or order-creation receipt is not available");
  const authorizedGas = i.plan ? BigInt(i.plan.gasLimit) * BigInt(i.plan.maxFeePerGasNativeAtomic) : null;
  return {
    costStatementVersion: COST_STATEMENT_VERSION, unit: "USDC", nativeDecimals: 18, tokenDecimals: 6, capturedAt: i.capturedAt ?? new Date().toISOString(),
    buyer: {
      address: i.buyer, role: i.buyerRole ?? "buyer",
      businessPrincipal: { nativeAtomic: principal.toString(), usdc: formatNative(principal) },
      checkFee: feeToken === null ? null : { tokenAtomic: feeToken.toString(), nativeAtomicEquivalent: feeNative.toString(), usdc: formatToken(feeToken) },
      businessGas,
      totalNativeAtomic: buyerTotal.toString(), totalUsdc: formatNative(buyerTotal), complete: buyerComplete,
    },
    operator: { feeRelay, orderCreation, totalNativeAtomic: operatorTotal.toString(), totalUsdc: formatNative(operatorTotal), complete: operatorComplete },
    authorizedMaximum: {
      businessPrincipalNativeAtomic: i.policy?.maxNativePaymentAtomic ?? null,
      checkFeeTokenAtomic: i.policy?.maxServiceFeeTokenAtomic ?? null,
      businessGasNativeAtomic: authorizedGas === null ? null : authorizedGas.toString(),
    },
    actual: { businessPrincipalNativeAtomic: principal.toString(), checkFeeTokenAtomic: (feeToken ?? 0n).toString(), businessGasNativeAtomic: businessGas?.nativeAtomic ?? null },
    unresolvedReservation: { nativeAtomic: i.unresolvedReservationNativeAtomic ?? "0", note: "reservations released only after reconciliation" },
    sources: { feeTx: i.txs.feeTx ?? null, createOrderTx: i.txs.createOrderTx ?? null, businessTx: i.txs.businessTx ?? null },
    notes,
  };
}
