// Step 1 of the Developer workflow (docs/LIFECYCLE.md §2, §9, AP33-11): a dialog that first says what is being bought — a demonstration
// order on the project's DemoMerchant contract, no goods or services, in return for a pinned preflight report, the payment outcome read
// from the chain and a verifiable Payment Passport — then labelled fields: payer (the connected wallet, read-only), the merchant (as
// approved / changed since approval), amount in USDC, reference; an "Autofill sample order" button whose values stay editable, inline
// validation that mirrors the server's rules, a human-readable review step, then "Create order". Proxy code names (MAIN / CHANGED), atomic
// units and the raw JSON body live under a collapsed "technical details". A 400 from the server lands on the field it names.
// Review round 3 (item 5): the review stage renders only while the validated body exists and its payer is still the account the review was
// opened for; a wallet that disconnects or switches accounts mid-review returns the dialog to the form with a notice — nothing reads `body.*` on null.
// 2026-10-09: once the server answers with an order identity (202 pending, 502 naming the order) the dialog hands that order to the page —
// it never says "nothing was changed"; a lost answer says the order may exist; and while the latest order's creation is unconfirmed the
// dialog refuses another one ("recover it first").
import { useEffect, useRef, useState } from "react";
import { Chip, Hex, Spinner } from "./Badges";
import { ApiError, explorerAddr, type NetworkInfo, type OrderCreated, type OrderCreationFailure, type OrderPending } from "../lib/api";
import { EMPTY_ORDER_FORM, feeUsdcText, fixtureForProxy, nativeAtomicToUsdcText, sampleOrder, serverFieldError, usdcToNativeAtomic, validateOrderForm, UNCONFIRMED_BLOCK_TEXT, type OrderBody, type OrderForm, type OrderFormErrors, type OrderLimits, type Proxy } from "../lib/orders";
import { describeError, ORDER_RESPONSE_LOST_TEXT } from "../lib/errors";

/** what the two merchant choices mean to a visitor; the proxy code name is a technical detail */
export const PROXY_LABELS: Record<Proxy, { title: string; blurb: string }> = {
  MAIN: { title: "Merchant as approved", blurb: "still runs the approved implementation — the check should find nothing" },
  CHANGED: { title: "Merchant changed since approval", blurb: "upgraded to a compatible but unapproved implementation — the check should stop at REVIEW REQUIRED" },
};

export type OrderAnswer = OrderCreated | OrderPending | OrderCreationFailure;
export function OrderDialog({ payer, net, limits, create, onCreated, onClose, unconfirmed = null, onLost }: { payer: string | null; net: NetworkInfo | null; limits: OrderLimits; create: (body: OrderBody) => Promise<OrderCreated | OrderPending>; onCreated: (o: OrderAnswer) => void; onClose: () => void;
  /** the latest order of this wallet whose creation is not confirmed: no other order until it is recovered (or closed) */ unconfirmed?: { orderId: string } | null;
  /** the answer was lost on the way: the page re-reads My workflow (the order may exist) */ onLost?: () => void }) {
  const [form, setForm] = useState<OrderForm>(EMPTY_ORDER_FORM);
  const [touched, setTouched] = useState(false);
  const [stage, setStage] = useState<"edit" | "review">("edit");
  /** the connected account the review was opened for (item 5): a different or missing account returns the dialog to the form */
  const [reviewPayer, setReviewPayer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<OrderFormErrors>({});
  const [state, setState] = useState<{ busy: boolean; err: string | null }>({ busy: false, err: null });
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && typeof d.showModal === "function" && !d.open) { try { d.showModal(); } catch { /* already open */ } } return () => { try { d?.close?.(); } catch { /* closed */ } }; }, []);
  const { errors: own, body } = validateOrderForm(form, payer, limits);
  const samePayer = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  // the review is valid only while the body exists and still names the account it was reviewed for; the render below never reads `body.*` otherwise
  const reviewing = stage === "review" && !!body && samePayer(body.payer, reviewPayer) && samePayer(payer, reviewPayer);
  useEffect(() => {
    if (stage !== "review" || reviewing || state.busy) return;
    setStage("edit"); setReviewPayer(null);
    setNotice(payer ? "Your wallet switched accounts while you were reviewing — the payer changed; review the order again." : "Your wallet disconnected while you were reviewing — connect it again and review the order again.");
  }, [stage, reviewing, state.busy, payer]);
  const errors: OrderFormErrors = { ...own, ...serverErrors };
  const show = (f: keyof OrderFormErrors) => (touched || serverErrors[f]) && errors[f];
  const set = (patch: Partial<OrderForm>) => { setForm((f) => ({ ...f, ...patch })); setServerErrors({}); setTouched(true); };
  const atomic = usdcToNativeAtomic(form.amountUsdc);
  const submit = async () => {
    if (!body || !reviewing || unconfirmed) return;
    setState({ busy: true, err: null });
    try { const o = await create(body); setState({ busy: false, err: null }); onCreated(o); }
    catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.body?.error === "INVALID_INPUT") { setServerErrors(serverFieldError(e.body)); setStage("edit"); setState({ busy: false, err: null }); return; }
      if (e instanceof ApiError && typeof e.body?.orderId === "string") { // the identity exists: show that order, never "nothing was changed"
        const known = { orderId: e.body.orderId as string, tx: (e.body.tx as string | null | undefined) ?? null, merchant: fixtureForProxy(net, body.proxy)?.merchant ?? "", proxy: body.proxy, payer: body.payer, amountNativeAtomic: body.amountNativeAtomic, reference: body.reference ?? null };
        const st = e.body.state ?? "FAILED"; const why: string = e.body.reason ?? describeError(e).text;
        setState({ busy: false, err: null });
        onCreated(st === "PLANNED" || st === "SENT"
          ? { pending: true, ...known, state: st, reason: why, nextAction: "creation not confirmed — it is reconciled from the chain; recover re-sends the same signed transaction (never a second order)" }
          : { failed: true, ...known, state: st, reason: why });
        return;
      }
      const d = describeError(e);
      if (d.code === "NETWORK") { setState({ busy: false, err: ORDER_RESPONSE_LOST_TEXT }); onLost?.(); return; }
      setState({ busy: false, err: d.text });
    }
  };
  const changedFor = (p: Proxy) => { const f = fixtureForProxy(net, p); return !!f?.approvedImplementation && !!f?.implementation && f.approvedImplementation.toLowerCase() !== f.implementation.toLowerCase(); };
  const proxyCard = (p: Proxy) => {
    const f = fixtureForProxy(net, p); const changed = changedFor(p);
    return (
      <label key={p} className={`proxy-card ${form.proxy === p ? "on" : ""}`}>
        <input type="radio" name="proxy" value={p} checked={form.proxy === p} onChange={() => set({ proxy: p })} aria-label={PROXY_LABELS[p].title} />
        <span className="stack" style={{ gap: 2 }}>
          <span className="row" style={{ gap: 8 }}><b>{PROXY_LABELS[p].title}</b>{f ? <Chip tone={changed ? "warn" : "ok"}>{changed ? "implementation changed since approval" : "implementation as approved"}</Chip> : <Chip tone="warn">not deployed here</Chip>}</span>
          <span className="tiny dim">{PROXY_LABELS[p].blurb}{f ? <> · expected decision <code>{f.expected}</code></> : null}</span>
        </span>
      </label>
    );
  };
  const reviewFixture = reviewing && body ? fixtureForProxy(net, body.proxy) : null;
  return (
    <dialog ref={ref} className="dlg" aria-labelledby="order-dialog-title" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <form className="dlg-inner stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); if (unconfirmed) return; if (!reviewing) { setTouched(true); if (body && samePayer(body.payer, payer)) { setReviewPayer(payer); setNotice(null); setStage("review"); } } else void submit(); }}>
        <div className="row between" style={{ alignItems: "baseline" }}>
          <h3 id="order-dialog-title">{!reviewing ? "Create a demonstration order" : "Review the order"}</h3>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label="close">✕</button>
        </div>
        {unconfirmed && <div className="banner bad" role="alert" data-testid="order-unconfirmed">{UNCONFIRMED_BLOCK_TEXT[0].toUpperCase() + UNCONFIRMED_BLOCK_TEXT.slice(1)} — order <Hex value={unconfirmed.orderId} n={6} /> (Recover in step 1 or in My workflow).</div>}
        {!reviewing || !body ? (
          <>
            {notice && <div className="banner" role="status" data-testid="order-notice">{notice}</div>}
            <div className="banner info" role="note" data-testid="order-explainer"><b>This is a demonstration order on the project's DemoMerchant contract — no goods or services are delivered.</b></div>
            <p className="small muted">You pay the check fee ({feeUsdcText(net)} USDC), the order amount and your gas from your wallet.</p>
            <details className="why"><summary className="tiny">what you get, who creates it</summary><p className="small muted">Paying it exercises the lifecycle with your own wallet: a pinned preflight report, the payment outcome read from the chain, and a verifiable Payment Passport. The order is payable only by your wallet; the merchant's <code>{net?.accounts?.orderSignerRole ?? "order-creator"}</code> key creates it and the operator pays that gas. Its identity is recorded before the creation transaction is sent.</p></details>
            <div className="field"><label htmlFor="of-payer">payer <span className="tiny dim">connected wallet · read-only</span></label><input id="of-payer" className="input mono" readOnly value={payer ?? ""} placeholder="connect a wallet" aria-invalid={!!show("payer")} />{show("payer") && <span className="ferr">{errors.payer}</span>}</div>
            <div className="field"><span className="flabel">merchant <span className="tiny dim">receives the payment</span></span><div className="proxy-cards" role="radiogroup" aria-label="merchant">{(["MAIN", "CHANGED"] as Proxy[]).map(proxyCard)}</div>{show("proxy") && <span className="ferr">{errors.proxy}</span>}</div>
            <div className="field"><label htmlFor="of-amount">amount <span className="tiny dim">USDC · up to 6 decimals · {nativeAtomicToUsdcText(limits.minNativeAtomic)}–{nativeAtomicToUsdcText(limits.maxNativeAtomic)}</span></label>
              <input id="of-amount" className="input" inputMode="decimal" placeholder="0.05" value={form.amountUsdc} onChange={(e) => set({ amountUsdc: e.target.value })} aria-invalid={!!show("amount")} />
              {show("amount") && <span className="ferr">{errors.amount}</span>}</div>
            <div className="field"><label htmlFor="of-ref" title="stored off-chain">reference <span className="tiny dim">optional · ≤ {limits.maxReferenceLength} characters · {form.reference.trim().length}/{limits.maxReferenceLength}</span></label>
              <input id="of-ref" className="input" placeholder="invoice 2026-10-08 #42" value={form.reference} onChange={(e) => set({ reference: e.target.value })} aria-invalid={!!show("reference")} />
              {show("reference") && <span className="ferr">{errors.reference}</span>}</div>
            <details className="tech" data-testid="technical-details">
              <summary className="tiny">technical details</summary>
              <div className="kv w150 small" style={{ marginTop: 8 }}>
                <span className="k">proxy</span><span><code>{form.proxy}</code> · {(() => { const f = fixtureForProxy(net, form.proxy); return f ? <>merchant {f.merchant ? <Hex value={f.merchant} n={5} link={explorerAddr(net, f.merchant)} /> : "—"} · approved impl {f.approvedImplementation ? <Hex value={f.approvedImplementation} n={4} link={explorerAddr(net, f.approvedImplementation)} /> : "—"} · current impl {f.implementation ? <Hex value={f.implementation} n={4} link={explorerAddr(net, f.implementation)} /> : "—"}</> : "not deployed on this instance"; })()}</span>
                <span className="k">amount on chain</span><span>{atomic.ok ? <><code>amountNativeAtomic = {atomic.atomic.toString()}</code> (18-decimal native units; USDC is Arc's gas token)</> : "the chain stores 18-decimal native units; the dialog converts whole 6-decimal token units"}</span>
                <span className="k">approval</span><span>{(() => { const f = fixtureForProxy(net, form.proxy); return f?.baselineDigest ? <><Hex value={f.baselineDigest} n={6} /> <span className="tiny dim">the baseline the check will reference</span></> : <Chip tone="warn">no baseline</Chip>; })()}</span>
              </div>
            </details>
            <div className="row between" style={{ gap: 10 }}>
              <button type="button" className="btn" onClick={() => { setForm(sampleOrder(new Date(), limits)); setServerErrors({}); setTouched(true); }}>Autofill sample order</button>
              <button type="submit" className="btn primary" disabled={!payer || !!unconfirmed}>Review order →</button>
            </div>
          </>
        ) : (
          <>
            <p className="small muted">Nothing has left yet. Creating the order costs your wallet nothing.</p>
            <div className="kv w120" data-testid="order-review">
              <span className="k">payer</span><span><Hex value={body.payer} n={8} /> <span className="tiny dim">your wallet</span></span>
              <span className="k">merchant</span><span>{PROXY_LABELS[body.proxy].title.toLowerCase()} {reviewFixture ? <Chip tone={changedFor(body.proxy) ? "warn" : "ok"}>{changedFor(body.proxy) ? "changed since approval" : "as approved"}</Chip> : <Chip tone="warn">not deployed here</Chip>}</span>
              <span className="k">amount</span><span><b>{nativeAtomicToUsdcText(body.amountNativeAtomic)} USDC</b> <span className="tiny dim">payable only by your wallet, later</span></span>
              <span className="k">reference</span><span>{body.reference ?? <span className="dim">none</span>}</span>
              <span className="k">you get</span><span className="small">pinned report (check fee {feeUsdcText(net)} USDC) · payment outcome from the chain · verifiable Payment Passport — no goods or services</span>
            </div>
            <details className="tech" data-testid="technical-details">
              <summary className="tiny">technical details — the exact body of <code>POST /v1/demo/orders</code></summary>
              <div className="kv w120 small" style={{ marginTop: 8 }}>
                <span className="k">proxy</span><span><code>{body.proxy}</code> · merchant {reviewFixture?.merchant ? <Hex value={reviewFixture.merchant} n={5} link={explorerAddr(net, reviewFixture.merchant)} /> : "—"}</span>
                <span className="k">amount</span><span><code>{body.amountNativeAtomic}</code> native units (18 decimals)</span>
                <span className="k">approval</span><span>{reviewFixture?.baselineDigest ? <Hex value={reviewFixture.baselineDigest} n={6} /> : <Chip tone="warn">no baseline</Chip>} <span className="tiny dim">the approval the check will reference</span></span>
              </div>
              <pre className="json" style={{ marginTop: 8 }}>{JSON.stringify(body, null, 2)}</pre>
            </details>
            {state.err && <div className="banner bad" role="alert">{state.err}</div>}
            <div className="row between" style={{ gap: 10 }}>
              <button type="button" className="btn ghost" disabled={state.busy} onClick={() => { setStage("edit"); setReviewPayer(null); }}>← Edit</button>
              <button type="submit" className="btn primary" disabled={state.busy || !!unconfirmed}>{state.busy ? <><Spinner /> creating…</> : "Create order"}</button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
