// recovery.json (docs/PASSPORT.md §4): counters derived from the recorded steps, never from preset copy.
//
// originalTransaction.status is derived from the execution receipt plus the reconciliation history, never from step logs alone:
//   execution.chainStatus      reconciled?  note mentions "OrderPaid"?  → status                 meaning
//   NOT_SIGNED                 –            –                          → none                   nothing was signed (no plan, refused, or check only)
//   SIGNED_NOT_BROADCAST       –            –                          → not-sent               signed (or validated for a wallet) but never sent
//   CONFIRMED                  no           –                          → confirmed              the original transaction confirmed in the attempt itself
//   CONFIRMED                  yes          no                         → recovered-confirmed    confirmed, established later by reconciliation (receipt / order read)
//   CONFIRMED                  yes          yes                        → recovered-from-event   the hash was never reported (wallet attempt) or not retained; the paying
//                                                                                              transaction was found through the merchant's OrderPaid(orderId) log
//   REVERTED                   –            –                          → reverted               mined and reverted; the order state decides whether it was paid
//   UNKNOWN + NOT_EXECUTED     –            –                          → not-mined              the nonce was consumed by another transaction; the order reads unpaid
//   UNKNOWN (other) / PENDING  –            –                          → unresolved             no fact established yet; reservations stay held until reconciliation
// "reconciled" means the history has at least one reconciliation entry (service store) or a recorded `reconciled` step.
import type { ExecutionReceipt } from "@arcpreflight/schema";
import { RECOVERY_VERSION, type Hex, type ReconciliationEntry, type RecoveryStatus, type RecoverySummary, type Step } from "./types.js";

const INTERRUPTION_STEPS = new Set(["interrupted", "interruptedBeforeBroadcast", "interruptedAfterBroadcast", "outcomeUnknown", "rebroadcast", "reconciled"]);

/** `recoveredFromEvent`: the confirming transaction was established through the merchant's OrderPaid log rather than a reported hash. */
export function originalTransactionStatus(execution: Pick<ExecutionReceipt, "chainStatus" | "businessStatus">, reconciled: boolean, recoveredFromEvent = false): RecoveryStatus {
  switch (execution.chainStatus) {
    case "NOT_SIGNED": return "none";
    case "SIGNED_NOT_BROADCAST": return "not-sent";
    case "CONFIRMED": return reconciled ? (recoveredFromEvent ? "recovered-from-event" : "recovered-confirmed") : "confirmed";
    case "REVERTED": return "reverted";
    case "UNKNOWN": return execution.businessStatus === "NOT_EXECUTED" ? "not-mined" : "unresolved";
    default: return "unresolved"; // PENDING
  }
}

export function recoverySummary(attemptId: string, steps: readonly Step[], execution: ExecutionReceipt, reconciliation: readonly ReconciliationEntry[] = []): RecoverySummary {
  const count = (name: string, pred: (s: Step) => boolean = () => true) => steps.filter((s) => s.step === name && pred(s)).length;
  const signed = count("signed"); const orders = count("createOrder"); const fees = count("signServiceFee"); const rebroadcasts = count("rebroadcast");
  const fromSteps: ReconciliationEntry[] = steps.filter((s) => s.step === "reconciled").map((s) => ({
    at: typeof s.at === "string" ? s.at : execution.recordedAt, chainStatus: String(s.chainStatus ?? execution.chainStatus), businessStatus: String(s.businessStatus ?? execution.businessStatus), note: typeof s.why === "string" ? s.why : null,
  }));
  const history = reconciliation.length ? [...reconciliation] : fromSteps;
  const reconciled = history.length > 0;
  const recoveredFromEvent = history.some((e) => typeof e.note === "string" && e.note.includes("OrderPaid"));
  return {
    recoveryVersion: RECOVERY_VERSION, attemptId,
    interrupted: reconciled || steps.some((s) => INTERRUPTION_STEPS.has(s.step)),
    counters: {
      ordersCreated: orders,
      checkFeeAuthorizations: fees,
      businessSignatures: signed,
      broadcastsOfOriginalBytes: count("broadcast", (s) => s.accepted !== false) + rebroadcasts,
      replacementSignatures: Math.max(0, signed - 1),
    },
    addedByRecovery: { ordersCreated: Math.max(0, orders - 1), checkFeeAuthorizations: Math.max(0, fees - 1), businessSignatures: Math.max(0, signed - 1), broadcastsOfOriginalBytes: rebroadcasts },
    originalTransaction: { hash: (execution.signedTransactionHash ?? execution.businessTxHash ?? null) as Hex | null, status: originalTransactionStatus(execution, reconciled, recoveredFromEvent) },
    reconciliation: history,
  };
}
