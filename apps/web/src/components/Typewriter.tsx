import { useEffect, useState } from "react";

/** Types a sequence of lines like an agent thinking out loud. Deterministic text; no model involved.
 *  Presentation finding 2026-10-10: the block takes its FINAL height from the first render — every line is laid out invisibly in full from the
 *  start (a ghost layer) and the typed text is painted over it in the same grid cell, so the page never grows while the narration types and
 *  the scrollbar stays put. The caret takes no layout width, so it never wraps a line that its own text would not wrap. */
const LAYER = { gridArea: "1 / 1" } as const;
const GHOST = { gridArea: "1 / 1", visibility: "hidden" } as const;
const CARET = { display: "inline-block", width: 0, overflow: "visible" } as const;
export function Typewriter({ lines, speed = 22, pause = 700, loop = false, className }: { lines: string[]; speed?: number; pause?: number; loop?: boolean; className?: string }) {
  const [li, setLi] = useState(0);
  const [ci, setCi] = useState(0);
  useEffect(() => { setLi(0); setCi(0); }, [lines.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (li >= lines.length) { if (loop) { const t = setTimeout(() => { setLi(0); setCi(0); }, 4000); return () => clearTimeout(t); } return; }
    const line = lines[li];
    if (ci < line.length) { const t = setTimeout(() => setCi(ci + 1), speed + (line[ci] === "." || line[ci] === "—" ? 120 : 0)); return () => clearTimeout(t); }
    const t = setTimeout(() => { setLi(li + 1); setCi(0); }, pause);
    return () => clearTimeout(t);
  }, [li, ci, lines, speed, pause, loop]);
  return (
    <div className={className}>
      {lines.map((line, i) => {
        if (i < li) return <p key={i} className="type-line done">{line}</p>;
        const typed = i === li ? line.slice(0, ci) : null; // the line being typed; later lines are reserved by their ghost alone
        return (
          <p key={i} className="type-line" style={{ display: "grid" }}>
            <span style={GHOST} aria-hidden="true">{line}</span>
            {typed !== null && <span style={LAYER}>{typed}<span className="caret" style={CARET}>▍</span></span>}
          </p>
        );
      })}
    </div>
  );
}

/** Narration from receipts: each runner step becomes one first-person sentence. Text only — the decision is code. */
export function narrate(step: { step: string; [k: string]: unknown }): string | null {
  const s = step as any;
  switch (step.step) {
    case "createOrder": return `The merchant created order ${String(s.orderId).slice(0, 10)}… for me at block #${s.block}. That is my business expectation — I never read the amount out of calldata.`;
    case "intent": return s.valueNativeAtomic !== s.approvedAmountNativeAtomic ? `I built the exact call. The value in it is ${s.valueNativeAtomic} atomic — that already looks wrong next to the approved ${s.approvedAmountNativeAtomic}.` : `I built the exact call: pay(orderId), value ${s.valueNativeAtomic} atomic. Digest ${String(s.intentDigest).slice(0, 10)}….`;
    case "staleObservation": return `The free quote shows the report was pinned at #${s.pinnedBlock}, before my order existed at #${s.orderBlock}. I paid nothing — I'll ask again under a new request id.`;
    case "quote": return `Quote received: ${Number(s.priceTokenAtomic) / 1e6} USDC, report already pinned at #${s.pinnedBlock}. Nothing has been charged yet.`;
    case "signServiceFee": return `I signed one EIP-3009 authorization for exactly that quote. One authorization, one quote — the fee cannot be replayed.`;
    case "settlementPending": return `The fee transfer is still pending on Arc. I'll recover the same request rather than pay twice.`;
    case "reportDelivered": return `Settled on Arc (${String(s.serviceFeeTx).slice(0, 10)}…). I re-hashed the report myself: it is bound to my intent, baseline says ${s.baselineResult}, pinned at #${s.pinnedBlock}.`;
    case "decision": return s.decision === "BLOCKED" ? `My policy says BLOCKED — ${(s.reasons as string[])?.[0] ?? "a hard check fired"}. I will not sign.` : s.decision === "REVIEW_REQUIRED" ? `My policy says REVIEW REQUIRED — ${(s.reasons as string[])?.[0] ?? "something changed since approval"}. A human has to re-approve; I stop here.` : `No configured check fired at the pinned block. That is not "safe" — it means I may proceed to final validation.`;
    case "finalValidation": return s.result === "PASS" ? `Time passed and the fee changed my balance, so I re-read implementation, paused state, the order, fees and the approval this intent references at a new block (#${s.newPinnedBlock}) — one that must not predate the fee settlement; a fresh fetch of an old block would not count. Still consistent. Gas ${s.gasLimit} at ${s.maxFeePerGasGwei} gwei.` : `Final validation did not pass (${(s.reasons as string[])?.join("; ")}). I stop.`;
    case "signed": return `I signed the plan, then decoded my own signed transaction and compared it field by field with the plan before letting it leave.`;
    case "broadcast": return `Broadcast. Now I wait for the receipt — a receipt is not an outcome.`;
    case "postcondition": return s.paid ? `The order reads as paid, by me, for the exact amount, at block #${s.block}. That is the outcome I can prove.` : `Receipt says ${s.receiptStatus} but the order does not read as paid. I record a failure, not a success.`;
    case "notSigned": return `No business transaction is signed or broadcast. The separately authorized check fee may already have settled — a negative result is a delivered result.`;
    case "walletPlan": return `I built the type-2 plan an agent would sign: gas ${s.gasLimit} at ${s.maxFeePerGasGwei} gwei, nonce ${s.nonce}. This check stops here; execution happens in the Developer workflow.`;
    case "readyToExecute": return `No configured check fired. I stop this quick check here; to pay, I go to the Developer workflow, where the service validates the exact plan at a fresh block and records the attempt before my wallet is asked to sign.`;
    case "orderPlanned": return `Before the order is even sent, its identity is written down: ${String(s.orderId).slice(0, 10)}…, my address, the amount. If the process dies now, reconciliation reads the chain for it — it is never replaced.`;
    case "broadcastAttempted": return `A durable marker first: from this moment the transaction may be on the network, whatever happens to this process.`;
    case "interruptedAfterBroadcast": return `SIMULATED interruption: I stopped waiting right after the send, like a crashed process would. The hash is recorded; recovery will read it and the order state — never sign a replacement.`;
    case "walletPrompted": return `The attempt is durable with its plan. Now the wallet is asked to sign exactly that plan; the service never sees the signed bytes.`;
    case "walletRejected": return `The wallet prompt was rejected. Nothing was sent; the order stays unpaid.`;
    case "planComparison": return (s.mismatch as string[])?.length ? `The transaction the wallet sent differs from the validated plan in ${(s.mismatch as string[]).join(", ")}. Recorded as a mismatch; the order state decides whether the order was paid.` : `The visible transaction matches the plan in to, data, value, chain and type; the wallet set its own ${Object.keys((s.deviations as object) ?? {}).join(", ")} — recorded as deviations, not hidden.`;
    case "intentRetried": return `New request id ${String(s.clientRequestId)}: the stale quote was never paid, so nothing is owed for it.`;
    case "notBroadcast": return `My final validation expired before the bytes left. I discard the signed transaction — nothing reached the network.`;
    case "outcomeUnknown": return `No receipt within my wait. The transaction may be out there, so I leave this attempt unresolved: reconciliation will work from the original hash and the order state, never from a replacement.`;
    case "rebroadcast": return `The same signed bytes went out again — same hash, same nonce, inside the validation window. It cannot pay twice.`;
    case "reconciled": return s.businessStatus === "SUCCESS" ? `Reconciled: the original transaction is confirmed and the order reads as paid. No second purchase was needed.` : s.businessStatus === "NOT_EXECUTED" ? `Reconciled: the original transaction never reached the chain and the order is unpaid. I signed nothing new — a human decides whether to try again.` : `Reconciled: ${String(s.chainStatus)} / ${String(s.businessStatus)}. ${String(s.why ?? "")}`;
    case "interruptedBeforeBroadcast": return `The process stopped after I signed and before anything was sent. Nothing reached the network; the order stays unpaid.`;
    case "interrupted": return `The process stopped before any business transaction was signed. Nothing reached the network.`;
    case "error": return `Something broke on my side: ${String(s.error).slice(0, 120)}`;
    default: return null;
  }
}
