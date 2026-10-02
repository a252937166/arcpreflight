import { useEffect, useState } from "react";

/** Types a sequence of lines like an agent thinking out loud. Deterministic text; no model involved. */
export function Typewriter({ lines, speed = 22, pause = 700, loop = false, className }: { lines: string[]; speed?: number; pause?: number; loop?: boolean; className?: string }) {
  const [li, setLi] = useState(0);
  const [ci, setCi] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => { setLi(0); setCi(0); setDone([]); }, [lines.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (li >= lines.length) { if (loop) { const t = setTimeout(() => { setLi(0); setCi(0); setDone([]); }, 4000); return () => clearTimeout(t); } return; }
    const line = lines[li];
    if (ci < line.length) { const t = setTimeout(() => setCi(ci + 1), speed + (line[ci] === "." || line[ci] === "—" ? 120 : 0)); return () => clearTimeout(t); }
    const t = setTimeout(() => { setDone((d) => [...d, line]); setLi(li + 1); setCi(0); }, pause);
    return () => clearTimeout(t);
  }, [li, ci, lines, speed, pause, loop]);
  const current = li < lines.length ? lines[li].slice(0, ci) : null;
  return (
    <div className={className}>
      {done.map((l, i) => <p key={i} className="type-line done">{l}</p>)}
      {current !== null && <p className="type-line">{current}<span className="caret">▍</span></p>}
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
    case "settlementPending": return `The facilitator says pending. I'll recover the same request rather than pay twice.`;
    case "reportDelivered": return `Settled on Arc (${String(s.serviceFeeTx).slice(0, 10)}…). I re-hashed the report myself: it is bound to my intent, baseline says ${s.baselineResult}, pinned at #${s.pinnedBlock}.`;
    case "decision": return s.decision === "BLOCKED" ? `My policy says BLOCKED — ${(s.reasons as string[])?.[0] ?? "a hard check fired"}. I will not sign.` : s.decision === "REVIEW_REQUIRED" ? `My policy says REVIEW REQUIRED — ${(s.reasons as string[])?.[0] ?? "something changed since approval"}. A human has to re-approve; I stop here.` : `No configured check fired at the pinned block. That is not "safe" — it means I may proceed to final validation.`;
    case "finalValidation": return s.result === "PASS" ? `Time passed and the fee changed my balance, so I re-read implementation, paused state, the order and fees at a new block (#${s.newPinnedBlock}). Still consistent. Gas ${s.gasLimit} at ${s.maxFeePerGasGwei} gwei.` : `Final validation did not pass (${(s.reasons as string[])?.join("; ")}). I stop.`;
    case "signed": return `I signed the plan, then decoded my own signed transaction and compared it field by field with the plan before letting it leave.`;
    case "broadcast": return `Broadcast. Now I wait for the receipt — a receipt is not an outcome.`;
    case "postcondition": return s.paid ? `The order reads as paid, by me, for the exact amount, at block #${s.block}. That is the outcome I can prove.` : `Receipt says ${s.receiptStatus} but the order does not read as paid. I record a failure, not a success.`;
    case "notSigned": return `Nothing was signed. The service fee was still paid — a negative result is a delivered result.`;
    case "error": return `Something broke on my side: ${String(s.error).slice(0, 120)}`;
    default: return null;
  }
}
