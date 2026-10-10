import { useEffect } from "react";
import { NavLink } from "react-router-dom";
import type { NetworkInfo } from "../lib/api";
import { availableNetworks, netName, toggleVisible, withNet, type Instance, type NetChoice } from "../lib/network";
import { setTargetNetwork } from "../lib/wallet";
import { WalletChip } from "./WalletChip";

const LINKS = [["/", "Overview"], ["/integrate", "API & CLI"], ["/demo", "Live demo"], ["/developer", "Wallet workflow"], ["/inspect", "Inspect"], ["/verify", "Verify"], ["/evidence", "Evidence"]] as const;

/** The network switch: one button per network that an instance REPORTS (never per path); shown only when two differ. */
export function NetworkToggle({ instances, selected, onSelect }: { instances: readonly Instance[]; selected: Instance | null; onSelect: (c: NetChoice) => void }) {
  if (!toggleVisible(instances)) return null;
  return (
    <div className="segmented" role="group" aria-label="network">
      {availableNetworks(instances).map((n) => {
        const on = selected?.network === n;
        return <button key={n} type="button" className={on ? "on" : ""} aria-pressed={on} onClick={() => { if (!on) onSelect(n); }} title={n === "testnet" ? "zero-cost demos on the project's testnet funds" : "the submission network: mainnet proof lives here"}>{netName(n)}</button>;
      })}
    </div>
  );
}

export function Nav({ net, testWallet, instances = [], selected = null, onSelect = () => {} }: { net: NetworkInfo | null; testWallet: boolean; instances?: readonly Instance[]; selected?: Instance | null; onSelect?: (c: NetChoice) => void }) {
  const links = LINKS.map(([to, label]) => <NavLink key={to} to={withNet(to, selected)} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>);
  // the wallet store learns the API's chain here (the nav is always mounted): a connected wallet on another chain is asked once to switch
  useEffect(() => { setTargetNetwork(net); }, [net]);
  return (
    <header className="nav">
      <div className="container">
        <div className="nav-inner">
          <NavLink to="/" className="brand">ArcPreflight <span className="mark">for agents on <img src="/arc/arc-icon.svg" className="arc-icon" alt="" /> Arc</span></NavLink>
          <nav className="nav-links">{links}</nav>
          <div className="nav-right">
            <NetworkToggle instances={instances} selected={selected} onSelect={onSelect} />
            <div className="netpill" title={net ? `${net.caip2} · ${net.rpc}` : ""}>
              <span className={`dot ${net?.head ? "live" : ""}`} />
              {net ? <>{netName(net.network)}{net.head ? <span className="head"> · #{net.head}</span> : null}</> : "connecting…"}
              {testWallet && import.meta.env.VITE_TEST_WALLET === "1" && <span className="chip warn" title="window.ethereum is a local test wallet injected for automated self-testing (open with ?testwallet=off to remove it)">test</span>}
            </div>
            <WalletChip net={net} />
          </div>
        </div>
        <nav className="mobile-links">{links}</nav>
      </div>
    </header>
  );
}
