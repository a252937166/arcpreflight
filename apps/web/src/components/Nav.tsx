import { NavLink } from "react-router-dom";
import type { NetworkInfo } from "../lib/api";
import { Chip } from "./Badges";

const LINKS = [["/", "Overview"], ["/demo", "Live demo"], ["/inspect", "Inspect"], ["/developer", "Developer"], ["/evidence", "Evidence"]] as const;

export function Nav({ net, testWallet }: { net: NetworkInfo | null; testWallet: boolean }) {
  const links = LINKS.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>);
  return (
    <header className="nav">
      <div className="container">
        <div className="nav-inner">
          <NavLink to="/" className="brand"><span className="logo">A</span>ArcPreflight</NavLink>
          <nav className="nav-links">{links}</nav>
          <div className="row" style={{ gap: 8 }}>
            {net ? <Chip tone={net.network === "mainnet" ? "violet" : "info"} title={`${net.caip2} · ${net.rpc}`}><span className={`dot ${net.head ? "live" : ""}`} /> {net.network === "mainnet" ? "Arc mainnet" : "Arc testnet"}{net.head ? ` · #${net.head}` : ""}</Chip> : <Chip>connecting…</Chip>}
            {testWallet && <Chip tone="warn" title="window.ethereum is a local test wallet injected for automated self-testing">test wallet</Chip>}
          </div>
        </div>
        <nav className="mobile-links">{links}</nav>
      </div>
    </header>
  );
}
