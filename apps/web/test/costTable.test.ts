import { describe, expect, it } from "vitest";
import { NOT_AVAILABLE, ROLE_LABELS, buyerRoleLabel, completeness, costTable, exactUsdc } from "../src/lib/costTable";
import type { CostStatement } from "../src/lib/api";

// The cost disclosure (docs/LIFECYCLE.md §5, §9) renders the statement's exact strings; a missing receipt is "not available", never 0; a
// group whose receipt is missing never shows a bare total; the buyer is labelled by role, never "your wallet" for a project-funded run.
const FEE_TX = `0x${"aa".repeat(32)}`, CREATE_TX = `0x${"bb".repeat(32)}`, BIZ_TX = `0x${"cc".repeat(32)}`;
/** a 1.0 statement as the API exported it before round 2: the business receipt was missing at export, the total is a bare subtotal */
const statement: CostStatement = {
  costStatementVersion: "1.0", unit: "USDC", nativeDecimals: 18, tokenDecimals: 6, capturedAt: "2026-10-08T10:51:59.878Z",
  buyer: { address: "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE", businessPrincipal: { nativeAtomic: "50000000000000000", usdc: "0.05" }, checkFee: { tokenAtomic: "10000", nativeAtomicEquivalent: "10000000000000000", usdc: "0.01" }, businessGas: null, totalNativeAtomic: "60000000000000000", totalUsdc: "0.06" },
  operator: { feeRelay: { nativeAtomic: "2178625000000000", usdc: "0.002178625", gasUsed: "87145", effectiveGasPriceNativeAtomic: "25000000000", tx: FEE_TX, address: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0" }, orderCreation: { nativeAtomic: "2507300000000000", usdc: "0.0025073", gasUsed: "100292", effectiveGasPriceNativeAtomic: "25000000000", tx: CREATE_TX, address: "0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b" }, totalNativeAtomic: "4685925000000000", totalUsdc: "0.004685925" },
  authorizedMaximum: { businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: "1181315000000000" },
  actual: { businessPrincipalNativeAtomic: "50000000000000000", checkFeeTokenAtomic: "10000", businessGasNativeAtomic: null },
  unresolvedReservation: { nativeAtomic: "0", note: "reservations released only after reconciliation" },
  sources: { feeTx: FEE_TX, createOrderTx: CREATE_TX, businessTx: BIZ_TX }, notes: ["business transaction receipt unavailable at export: businessGas is null, not estimated"],
};
const GAS = { nativeAtomic: "1018375000000000", usdc: "0.001018375", gasUsed: "40735", effectiveGasPriceNativeAtomic: "25000000000", tx: BIZ_TX };
/** the same run as a complete 1.1 statement */
const complete11: CostStatement = { ...statement, costStatementVersion: "1.1", buyer: { ...statement.buyer, role: "project-runner", businessGas: GAS, totalNativeAtomic: "61018375000000000", totalUsdc: "0.061018375", complete: true }, operator: { ...statement.operator, complete: true }, actual: { ...statement.actual, businessGasNativeAtomic: GAS.nativeAtomic }, notes: [] };

describe("cost table", () => {
  it("renders exact strings per row and group from the statement (never recomputed floats)", () => {
    const m = costTable(statement, { executionMode: "runner" });
    expect(m.rows.map((r) => [r.group, r.label, r.authorized, r.actual, r.unresolved])).toEqual([
      ["buyer", "business principal", "0.05 USDC", "0.05 USDC", "0 USDC"],
      ["buyer", "check fee", "0.01 USDC", "0.01 USDC", "—"],
      ["buyer", "business gas", "0.001181315 USDC", NOT_AVAILABLE, "—"],
      ["operator", "fee-relay gas", "—", "0.002178625 USDC · 87145 gas", "—"],
      ["operator", "order-creation gas", "—", "0.0025073 USDC · 100292 gas", "—"],
    ]);
    expect(m.operator).toEqual({ total: "0.004685925 USDC", complete: true, missing: [], incomplete: null });
    expect(m.unresolved).toEqual({ usdc: "0 USDC", note: "reservations released only after reconciliation" });
    expect(m.rows.find((r) => r.key === "feeRelay")!.tx).toBe(FEE_TX); expect(m.rows.find((r) => r.key === "principal")!.tx).toBe(BIZ_TX);
    expect(m.notes).toHaveLength(1);
  });
  it("a statement with a missing gas receipt renders 'incomplete: business gas not available' instead of the bare subtotal (1.0 derived, 1.1 flagged)", () => {
    const m = costTable(statement);
    expect(m.buyer).toMatchObject({ address: statement.buyer.address, total: null, complete: false, missing: ["business gas"], incomplete: "incomplete: business gas not available" });
    expect(JSON.stringify(m.buyer)).not.toContain("0.06"); // the known subtotal is never shown as the cost
    const flagged = costTable({ ...statement, costStatementVersion: "1.1", buyer: { ...statement.buyer, role: "visitor-wallet", complete: false }, operator: { ...statement.operator, complete: true } });
    expect(flagged.buyer).toMatchObject({ total: null, complete: false, incomplete: "incomplete: business gas not available" });
    // the server says incomplete without a null line the client can name: still never a bare number
    const unnamed = costTable({ ...complete11, buyer: { ...complete11.buyer, complete: false } });
    expect(unnamed.buyer).toMatchObject({ total: null, complete: false, incomplete: "incomplete: a receipt not available" });
    // operator side: a fee tx without its relay receipt
    const op = costTable({ ...complete11, operator: { ...complete11.operator, feeRelay: null, complete: false } });
    expect(op.operator).toMatchObject({ total: null, complete: false, missing: ["fee-relay gas"], incomplete: "incomplete: fee-relay gas not available" });
    const both = completeness({ ...complete11, operator: { ...complete11.operator, feeRelay: null, orderCreation: null } });
    expect(both.operator.incomplete).toBe("incomplete: fee-relay gas and order-creation gas not available");
    // no business tx at all (a blocked check): nothing is missing, the total renders
    const blocked = costTable({ ...statement, sources: { ...statement.sources, businessTx: null }, buyer: { ...statement.buyer, businessPrincipal: { nativeAtomic: "0", usdc: "0" }, totalUsdc: "0.01", totalNativeAtomic: "10000000000000000" } });
    expect(blocked.buyer).toMatchObject({ total: "0.01 USDC", complete: true, incomplete: null });
  });
  it("a complete 1.1 statement renders its totals", () => {
    const m = costTable(complete11);
    expect(m.buyer).toMatchObject({ total: "0.061018375 USDC", complete: true, incomplete: null, role: ROLE_LABELS["project-runner"] });
    expect(m.rows.find((r) => r.key === "businessGas")!.actual).toBe("0.001018375 USDC · 40735 gas");
  });
  it("labels the buyer by role — a project-funded run never says 'your wallet'; the execution mode decides for a 1.0 statement", () => {
    expect(buyerRoleLabel(complete11)).toBe("project demo-runner — project-funded, not your wallet");
    expect(buyerRoleLabel({ buyer: { ...complete11.buyer, role: "visitor-wallet" } })).toBe("your wallet");
    expect(buyerRoleLabel({ buyer: { ...complete11.buyer, role: "buyer" } })).toBe("the buyer");
    expect(buyerRoleLabel(statement, { executionMode: "runner" })).toBe("project demo-runner — project-funded, not your wallet");
    expect(buyerRoleLabel(statement, { subjectKind: "demo-run" })).toBe("project demo-runner — project-funded, not your wallet");
    expect(buyerRoleLabel(statement, { executionMode: "wallet" })).toBe("your wallet");
    expect(buyerRoleLabel(statement, { subjectKind: "wallet-run" })).toBe("your wallet");
    expect(buyerRoleLabel(statement, { subjectKind: "paid-check" })).toBe("the buyer");
    expect(buyerRoleLabel(statement)).toBe("the buyer"); // never "your wallet" by default
    expect(costTable(complete11, { executionMode: "wallet" }).buyer!.role).toBe(ROLE_LABELS["project-runner"]); // the statement's own role wins over the context
    expect(costTable(statement, { executionMode: "runner" }).buyer!.role).not.toBe("your wallet");
    expect(costTable(statement, { executionMode: "wallet" }).buyer!.role).toBe("your wallet");
  });
  it("a null line is 'not available (receipt unavailable)', never 0; null maxima render as —", () => {
    const m = costTable({ ...statement, buyer: { ...statement.buyer, checkFee: null, businessGas: null }, operator: { ...statement.operator, feeRelay: null, orderCreation: null, totalUsdc: "0", totalNativeAtomic: "0" }, authorizedMaximum: { businessPrincipalNativeAtomic: null, checkFeeTokenAtomic: null, businessGasNativeAtomic: null }, actual: { businessPrincipalNativeAtomic: "0", checkFeeTokenAtomic: "0", businessGasNativeAtomic: null }, sources: { feeTx: null, createOrderTx: null, businessTx: null } });
    const by = Object.fromEntries(m.rows.map((r) => [r.key, r]));
    expect(by.businessGas.actual).toBe(NOT_AVAILABLE); expect(by.feeRelay.actual).toBe(NOT_AVAILABLE); expect(by.orderCreation.actual).toBe(NOT_AVAILABLE);
    expect(by.businessGas.authorized).toBe("—"); expect(by.principal.authorized).toBe("—"); expect(by.fee.authorized).toBe("—");
    expect(by.fee.actual).toBe("0 USDC"); // the statement says 0 fee settled (actual.checkFeeTokenAtomic "0") — a recorded zero, not a missing receipt
    expect(m.operator).toMatchObject({ total: "0 USDC", complete: true }); // no transactions at all: nothing is missing
    expect(JSON.stringify(m)).not.toContain("NaN");
  });
  it("tolerates a missing statement and exact rendering of atomic values", () => {
    expect(costTable(null)).toEqual({ rows: [], buyer: null, operator: null, unresolved: null, notes: [] });
    expect(exactUsdc("1181315000000000")).toBe("0.001181315"); expect(exactUsdc("10000", 6)).toBe("0.01"); expect(exactUsdc("0")).toBe("0"); expect(exactUsdc(null)).toBeNull(); expect(exactUsdc("x")).toBeNull();
    expect(exactUsdc(10n ** 18n)).toBe("1"); expect(exactUsdc("123456789012345678")).toBe("0.123456789012345678");
  });
});
