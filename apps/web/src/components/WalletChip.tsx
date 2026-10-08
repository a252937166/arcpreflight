// The nav wallet chip: connect (with an EIP-6963 picker when several wallets are installed), and once connected a small
// menu — full address with copy, explorer link, switch to the API's chain when needed, disconnect. Read-only here: the chip
// never signs anything; signing happens only on the Developer page with the user's explicit action.
import { useEffect, useRef, useState } from "react";
import { explorerAddr, explorerTx, type NetworkInfo } from "../lib/api";
import { useWallet, friendlyName } from "../lib/wallet";
import { claimFaucet, faucetAvailable } from "../lib/faucet";
import { describeError } from "../lib/errors";
import { short, usdcNative } from "../lib/format";
import { Spinner } from "./Badges";

export function WalletChip({ net }: { net: NetworkInfo | null }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [faucet, setFaucet] = useState<{ busy: boolean; text: string | null; tx: string | null; bad: boolean }>({ busy: false, text: null, tx: null, bad: false });
  const box = useRef<HTMLDivElement>(null);
  const onArc = !!net && w.chainId === net.chainId;
  const faucetOn = faucetAvailable(net, w); // testnet only, never on a mainnet instance
  const claim = async () => {
    if (!w.account) return;
    setFaucet({ busy: true, text: null, tx: null, bad: false });
    try { const c = await claimFaucet(w.account); setFaucet({ busy: false, text: `sent ${usdcNative(c.amountNativeAtomic, 2)} (testnet)`, tx: c.txHash, bad: false }); }
    catch (e) { setFaucet({ busy: false, text: describeError(e).text, tx: null, bad: true }); }
  };
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const copy = async () => {
    if (!w.account) return;
    try { await navigator.clipboard.writeText(w.account); } catch {
      try { const ta = document.createElement("textarea"); ta.value = w.account; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } catch { /* clipboard unavailable: the address is shown as selectable text */ }
    }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  if (!w.account) {
    return (
      <div className="wallet-wrap" ref={box}>
        <button className="wallet-btn" onClick={() => w.connect()} disabled={w.connecting} aria-haspopup="menu" aria-expanded={w.picker} title="Connect an EIP-1193 wallet (MetaMask, OKX Wallet, Rabby, Coinbase Wallet…) — read-only here">{w.connecting ? <Spinner /> : <span className="dot" />}Connect wallet</button>
        {w.picker && (
          <div className="wallet-menu" role="menu" aria-label="choose a wallet">
            <span className="label">choose a wallet</span>
            {w.candidates.map((c) => <button key={c.info.uuid} className="wallet-item" role="menuitem" onClick={() => w.choose(c.info.uuid)}>{c.info.icon ? <img src={c.info.icon} alt="" /> : <span className="dot" />}{friendlyName(c.info)}</button>)}
            <button className="wallet-item" role="menuitem" onClick={w.closePicker}>cancel</button>
          </div>
        )}
        {w.error && !w.picker && <div className="wallet-menu" role="status"><span className="addr">{w.error}</span></div>}
      </div>
    );
  }
  return (
    <div className="wallet-wrap" ref={box}>
      <button className="wallet-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={w.switching ? "asking the wallet to switch to the API's chain…" : onArc ? `connected on ${net?.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}` : `connected on chain ${w.chainId ?? "?"} — not the API's chain`}>
        {w.switching ? <Spinner /> : <span className={`dot ${onArc ? "ok" : "warn"}`} />}{short(w.account, 4)}{w.isTest && <span className="tiny dim">test</span>}
      </button>
      {open && (
        <div className="wallet-menu" role="menu" aria-label="wallet">
          <span className="label">{w.info ? friendlyName(w.info) : "wallet"} · chain {w.chainId ?? "?"}{onArc ? "" : " (not Arc)"}</span>
          <span className="addr" aria-label="full address">{w.account}</span>
          <button className="wallet-item" role="menuitem" onClick={copy}>{copied ? "copied ✓" : "Copy address"}</button>
          <a className="wallet-item" role="menuitem" href={explorerAddr(net, w.account)} target="_blank" rel="noreferrer">View on explorer ↗</a>
          {!onArc && net && <button className="wallet-item" role="menuitem" onClick={() => { setOpen(false); void w.switchChain(net); }}>Switch to Arc {net.chainId}</button>}
          {faucetOn && <button className="wallet-item" role="menuitem" disabled={faucet.busy} onClick={claim}>{faucet.busy ? <Spinner /> : null}Claim testnet USDC</button>}
          {faucet.text && <span className={`addr ${faucet.bad ? "bad" : ""}`} role="status">{faucet.text}{faucet.tx && net && <> · <a href={explorerTx(net, faucet.tx)} target="_blank" rel="noreferrer">tx ↗</a></>}</span>}
          <button className="wallet-item danger" role="menuitem" onClick={() => { setOpen(false); void w.disconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
