import { NavLink } from "react-router-dom";
import type { NetworkInfo } from "../lib/api";

const LINKS = [["/", "Overview"], ["/demo", "Live demo"], ["/inspect", "Inspect"], ["/developer", "Developer"], ["/evidence", "Evidence"]] as const;

export function Nav({ net, testWallet }: { net: NetworkInfo | null; testWallet: boolean }) {
  const links = LINKS.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>);
  return (
    <header className="nav">
      <div className="container">
        <div className="nav-inner">
          <NavLink to="/" className="brand">ArcPreflight <span className="mark">for agents on <img src="/arc/arc-icon.svg" className="arc-icon" alt="" /> Arc</span></NavLink>
          <nav className="nav-links">{links}</nav>
          <div className="netpill" title={net ? `${net.caip2} · ${net.rpc}` : ""}>
            <span className={`dot ${net?.head ? "live" : ""}`} />
            {net ? <>{net.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}{net.head ? ` · #${net.head}` : ""}</> : "connecting…"}
            {testWallet && <span className="chip warn" title="window.ethereum is a local test wallet injected for automated self-testing">test wallet</span>}
          </div>
        </div>
        <nav className="mobile-links">{links}</nav>
      </div>
    </header>
  );
}
