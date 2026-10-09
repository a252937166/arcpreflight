// The nav wallet chip: connect (with an EIP-6963 picker when several wallets are installed), and once connected a compact panel
// (review item 7): wallet icon + name, a network badge, the short address with copy and a "show full" toggle (the full address stays
// accessible), the balance on the API's chain, grouped actions (explorer, testnet faucet), a dedicated faucet status area that tells
// "transaction sent" apart from "funds confirmed" (the receipt is read through the wallet's provider before "confirmed" is said), and
// Disconnect set apart at the bottom. Read-only here: the chip never signs anything; signing happens only on the Developer page with
// the user's explicit action. Disconnected: the picker re-asks installed wallets and shows "looking for wallets…" while late ones may
// still answer, offers "Search again", and a remembered wallet that did not answer in this tab is named — nothing else stands in for it.
import { useEffect, useRef, useState } from "react";
import { explorerAddr, explorerTx, type NetworkInfo } from "../lib/api";
import { useWallet, friendlyName } from "../lib/wallet";
import { faucetAvailable, useBalances, useFaucetClaim, type FaucetProgress } from "../lib/faucet";
import { exactUsdc } from "../lib/costTable";
import { short, usdcNative } from "../lib/format";
import { Chip, Spinner } from "./Badges";

const netName = (net: NetworkInfo | null) => (net?.network === "mainnet" ? "Arc Mainnet" : "Arc Testnet");

/** the faucet status line: one tone, one sentence, the transaction link whenever a hash exists (a plain render function, inlined in the panel) */
export function faucetStatus(progress: FaucetProgress, net: NetworkInfo | null) {
  if (progress.phase === "idle") return null;
  const tx = "claim" in progress && progress.claim ? <a href={explorerTx(net, progress.claim.txHash)} target="_blank" rel="noreferrer">tx ↗</a> : null;
  const plus = "claim" in progress && progress.claim ? `+${usdcNative(progress.claim.amountNativeAtomic, 2)}` : "";
  const tone = progress.phase === "confirmed" ? "ok" : progress.phase === "error" ? "bad" : progress.phase === "unconfirmed" ? "warn" : "info";
  return (
    <div className={`wp-status ${tone}`} role="status" aria-live="polite" data-phase={progress.phase}>
      {progress.phase === "sending" && <><Spinner /> sending the faucet transaction…</>}
      {progress.phase === "sent" && <><Spinner /> <b>Transaction sent</b> · {plus} · {tx} · waiting for the receipt</>}
      {progress.phase === "confirmed" && <><b>Funds confirmed</b> · {plus}{progress.block ? ` · block #${progress.block}` : ""} · {tx}</>}
      {progress.phase === "unconfirmed" && <><b>Sent</b>; confirmation not seen yet — the balance refreshes when the node reports it · {tx}</>}
      {progress.phase === "error" && <>{progress.error.text}{tx && <> · {tx}</>}</>}
    </div>
  );
}

export function WalletChip({ net }: { net: NetworkInfo | null }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const onArc = !!net && w.chainId === net.chainId;
  const faucetOn = faucetAvailable(net, w); // testnet only, never on a mainnet instance
  // the balance on the API's chain, read whenever the wallet is connected there (the chip shows it too); re-read once when the panel opens
  const { native: balance, refresh } = useBalances(w.provider, w.account, onArc && !!w.account);
  const faucet = useFaucetClaim(w.provider, w.account, { onSettled: () => refresh() });
  useEffect(() => { if (open) refresh({ untilChanged: false }); }, [open, refresh]);
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
      try { const ta = document.createElement("textarea"); ta.value = w.account; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } catch { /* clipboard unavailable: the full address is shown as selectable text */ }
    }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  if (!w.account) {
    return (
      <div className="wallet-wrap" ref={box}>
        <button className="wallet-btn" onClick={() => w.connect()} disabled={w.connecting} aria-haspopup="menu" aria-expanded={w.picker} title="Connect an EIP-1193 wallet (MetaMask, OKX Wallet, Rabby, Coinbase Wallet…) — read-only here; nothing is signed by connecting">
          <span className={`dot ${w.missing ? "warn" : ""}`} />{w.connecting ? "connecting…" : "Connect wallet"}
        </button>
        {w.picker && (
          <div className="wallet-menu" role="menu" aria-label="choose a wallet" data-testid="wallet-picker">
            <span className="label">choose a wallet</span>
            {w.searching && <span className="wp-hint" role="status" data-testid="wallet-searching"><Spinner /> looking for wallets…</span>}
            {w.candidates.map((c) => <button key={c.info.uuid} className="wallet-item" role="menuitem" onClick={() => w.choose(c.info.uuid)}>{c.info.icon ? <img src={c.info.icon} alt="" /> : <span className="dot" />}{friendlyName(c.info)}</button>)}
            {!w.searching && w.candidates.length === 0 && <span className="wp-hint">no wallet answered in this tab yet</span>}
            <button className="wallet-item" role="menuitem" disabled={w.searching} onClick={() => w.searchAgain()}>Search again</button>
            <button className="wallet-item" role="menuitem" onClick={w.closePicker}>cancel</button>
          </div>
        )}
        {w.error && !w.picker && (
          <div className="wallet-menu" role="status" data-testid="wallet-error"><span className="addr">{w.error}</span>
            <button className="wallet-item" role="menuitem" onClick={() => w.searchAgain()}>Search again</button>
          </div>
        )}
        {w.missing && !w.picker && !w.error && (
          <div className="wallet-menu" role="status" data-testid="wallet-missing">
            <span className="addr">{w.missing.name} was not detected in this tab — open the extension once or reload the tab. Nothing else was connected in its place.</span>
            <button className="wallet-item" role="menuitem" disabled={w.searching} onClick={() => w.searchAgain()}>{w.searching ? <><Spinner /> searching…</> : "Search again"}</button>
            <button className="wallet-item" role="menuitem" onClick={() => w.connect()}>Choose another wallet</button>
            <button className="wallet-item" role="menuitem" onClick={() => w.dismissMissing()}>dismiss</button>
          </div>
        )}
      </div>
    );
  }
  const balanceText = balance === null ? "…" : `${exactUsdc(balance) ?? "…"} USDC`;
  return (
    <div className="wallet-wrap" ref={box}>
      <button className="wallet-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={w.switching ? "asking the wallet to switch to the API's chain…" : onArc ? `connected on ${netName(net)} — open for the address, balance, explorer link${faucetOn ? ", faucet" : ""} and disconnect` : `your wallet is on chain ${w.chainId ?? "?"}; the site runs on ${netName(net)}`}>
        {w.switching ? <Spinner /> : <span className={`dot ${onArc ? "ok" : "warn"}`} />}{short(w.account, 4)}{w.isTest && <span className="tiny dim">test</span>}{onArc && balance !== null && <span className="tiny dim wp-chipbal">{usdcNative(balance, 2)}</span>}
      </button>
      {open && (
        <div className="wallet-menu panel" role="menu" aria-label="wallet" data-testid="wallet-panel">
          <div className="wp-head">
            {w.info?.icon ? <img className="wp-icon" src={w.info.icon} alt="" /> : <span className="dot wp-icon" aria-hidden="true" />}
            <span className="wp-name" title={w.info ? friendlyName(w.info) : "Wallet"}><span className="wp-name-text">{w.info ? friendlyName(w.info) : "Wallet"}</span>{w.isTest && <span className="tiny dim wp-tag">· test</span>}</span>
            <span className="wp-net"><Chip tone={onArc ? "ok" : "warn"} title={onArc ? `chain ${w.chainId}` : `the site runs on ${netName(net)} (chain ${net?.chainId ?? "?"})`}>{onArc ? netName(net) : `chain ${w.chainId ?? "?"} · not Arc`}</Chip></span>
          </div>
          <div className="wp-addr">
            <code className="wp-short" title={w.account} aria-label={`address ${w.account}`}>{short(w.account, 6)}</code>
            <button type="button" className="wp-mini" role="menuitem" onClick={copy} aria-label="copy the full address">{copied ? "copied ✓" : "copy"}</button>
            <button type="button" className="wp-mini ghost" role="menuitem" onClick={() => setFull((f) => !f)} aria-expanded={full} aria-controls="wp-full-address">{full ? "hide full" : "show full"}</button>
          </div>
          {full ? <code className="wp-full" id="wp-full-address">{w.account}</code> : <span className="sr-only" id="wp-full-address">{w.account}</span>}
          <div className="wp-balance" aria-live="polite">{onArc ? <><b>{balanceText}</b> <span className="dim">on {netName(net)}</span></> : <span className="dim">balance is read once the wallet is on {netName(net)}</span>}</div>
          {!onArc && net && <button className="wallet-item" role="menuitem" onClick={() => { setOpen(false); void w.switchChain(net); }}>Switch to Arc {net.chainId}</button>}
          <div className="wp-actions" role="group" aria-label="actions">
            <a className="wp-action" role="menuitem" href={explorerAddr(net, w.account)} target="_blank" rel="noreferrer">View on explorer ↗</a>
            {faucetOn && <button type="button" className="wp-action" role="menuitem" disabled={faucet.progress.phase === "sending" || faucet.progress.phase === "sent"} onClick={() => faucet.claim()} title="0.2 testnet USDC from the project's testnet funds · one claim per wallet and per browser every 24 h">Claim testnet USDC</button>}
          </div>
          {faucetOn && net?.faucet?.enabled && <p className="wp-hint" data-testid="wp-faucet-hint">{usdcNative(net.faucet.amountNativeAtomic, 1)} per claim · once per wallet and per browser every 24 h · {Math.max(0, net.faucet.perDay - net.faucet.usedToday)} of {net.faucet.perDay} left today · more from <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle's faucet ↗</a> · this funds your wallet, not the project runner</p>}
          {faucetStatus(faucet.progress, net)}
          <div className="wp-divider" role="separator" />
          <button type="button" className="wallet-item wp-disconnect" role="menuitem" onClick={() => { setOpen(false); void w.disconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
