// The faucet card (P3, review round 2): shown on the Demo and Developer pages when a wallet connected on Arc testnet holds less than the
// step in front of it requires (check fee + order amount + gas reserve — the same number that disables the step's button, never a fixed
// 0.05). One click asks the API to send testnet USDC from the project's order-creator key; the answer is a transaction link and a
// refreshed balance, or one readable sentence (cooldown, budget, empty faucet).
import { useState } from "react";
import { explorerTx, type FaucetClaim, type NetworkInfo } from "../lib/api";
import { claimFaucet, faucetOffered, type FaucetWallet } from "../lib/faucet";
import { exactUsdc } from "../lib/costTable";
import { describeError, type Described } from "../lib/errors";
import { usdcNative } from "../lib/format";
import { Chip, Hex, Spinner } from "./Badges";

export function FaucetCard({ net, wallet, balance, required, step, needs = "check fee + order amount + gas reserve", onClaimed }: { net: NetworkInfo | null; wallet: FaucetWallet; balance: bigint | null; /** what the step in front of the visitor needs (fee + order + gas) */ required: bigint; /** the step this amount belongs to, e.g. "buying the report" */ step?: string; /** what `required` is made of */ needs?: string; onClaimed?: (claim: FaucetClaim) => void }) {
  const [state, setState] = useState<{ busy: boolean; claim: FaucetClaim | null; err: Described | null }>({ busy: false, claim: null, err: null });
  // stays visible after a successful claim so the transaction link does not vanish the moment the balance refreshes
  if ((!faucetOffered(net, wallet, balance, required) && !state.claim) || !net || net.faucet?.enabled !== true) return null;
  const f = net.faucet;
  const claim = async () => {
    if (!wallet.account) return;
    setState({ busy: true, claim: null, err: null });
    try { const c = await claimFaucet(wallet.account); setState({ busy: false, claim: c, err: null }); onClaimed?.(c); }
    catch (e) { setState({ busy: false, claim: null, err: describeError(e) }); }
  };
  return (
    <div className="faucet stack" role="region" aria-label="testnet faucet" style={{ gap: 8 }} data-testid="faucet-card">
      <div className="row between" style={{ alignItems: "center" }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="small"><b>Your wallet holds {balance === null ? "…" : `${exactUsdc(balance)} USDC`} on Arc testnet</b> — {step ?? "this step"} needs ≥ {exactUsdc(required)} USDC ({needs}), all paid from your own balance.</span>
          <span className="tiny dim">Testnet only · {usdcNative(f.amountNativeAtomic, 2)} per claim from the project's testnet funds · one claim per wallet and per client every 24 h · {f.perDay - f.usedToday} of {f.perDay} claims left today · more from <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle's faucet ↗</a> · funding your wallet does not replenish the project runner</span>
        </div>
        <button className="btn" disabled={state.busy || !!state.claim} onClick={claim}>{state.busy ? <><Spinner /> sending…</> : state.claim ? "Claimed ✓" : "Claim testnet USDC"}</button>
      </div>
      {state.claim && <div className="banner info" role="status">{`Sent ${usdcNative(state.claim.amountNativeAtomic, 2)} to your wallet · tx `}<Hex value={state.claim.txHash} link={explorerTx(net, state.claim.txHash)} /> · the balance refreshes in a moment <Chip tone="ok">testnet</Chip></div>}
      {state.err && <div className="banner bad" role="alert">{state.err.text}</div>}
    </div>
  );
}
