import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, apiPath, setApiBase, type NetworkInfo } from "./lib/api";
import { discoverInstances, landingFor, netName, netParam, networkNotice, persistChoice, selectInstance, storedChoice, withNet, type Instance, type NetChoice } from "./lib/network";
import { Nav } from "./components/Nav";
import Home from "./pages/Home";
import Demo from "./pages/Demo";
import RunPage from "./pages/Run";
import Inspect from "./pages/Inspect";
import Developer from "./pages/Developer";
import Evidence from "./pages/Evidence";
import Verify from "./pages/Verify";
import Integrate from "./pages/Integrate";

/** The selected API instance and what it reports (design v3.2 §4.7): pages label by `net`, link with `link`, switch with `select`. */
export type NetContext = {
  net: NetworkInfo | null; refresh: () => void; testWallet: boolean;
  choice: NetChoice; instances: Instance[]; selected: Instance | null; base: string; ready: boolean;
  /** a ?net= in the URL named a network no instance serves (the root is shown instead) */
  unavailable: NetChoice | null;
  select: (choice: NetChoice) => void; link: (to: string) => string;
};
export const NetCtx = createContext<NetContext>({ net: null, refresh: () => {}, testWallet: false, choice: "mainnet", instances: [], selected: null, base: "", ready: false, unavailable: null, select: () => {}, link: (to) => to });
export const useNet = () => useContext(NetCtx);

export default function App({ testWallet }: { testWallet: boolean }) {
  const loc = useLocation(); const navigate = useNavigate();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [tick, setTick] = useState(0);
  // discover which instances answer (root, /testnet); an instance that fails is simply absent
  useEffect(() => { let alive = true; discoverInstances().then((list) => { if (alive) setInstances(list); }).catch(() => { if (alive) setInstances([]); }); return () => { alive = false; }; }, []);
  // The choice is derived, never a second source of truth: a ?net= in the URL (a shared link names its backend) wins, then the
  // remembered choice, then mainnet. Deriving it from the location means a switch is just a navigation — nothing can race it.
  const urlNet = netParam(loc.search);
  const choice: NetChoice = urlNet ?? storedChoice() ?? "mainnet";
  useEffect(() => { if (urlNet && urlNet !== storedChoice()) persistChoice(urlNet); }, [urlNet]);
  const selected = useMemo(() => (instances ? selectInstance(instances, choice) : null), [instances, choice]);
  const base = selected?.base ?? "";
  setApiBase(base); // render-time and idempotent: every fetch a page issues after this render goes to the selected instance
  useLayoutEffect(() => { setApiBase(base); }, [base]);
  const ready = instances !== null;
  const unavailable = urlNet && instances && !instances.some((i) => i.network === urlNet) ? urlNet : null;
  // the selected instance's /v1/network, polled; cleared the moment the instance changes
  useEffect(() => {
    if (!ready) return;
    let alive = true; setNet(null);
    const load = () => api.network().then((n) => { if (alive) setNet(n); }).catch(() => {});
    load(); const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [base, tick, ready]);
  // keep the URL honest: ?net=<network> is present exactly when the selected instance is not the root
  useEffect(() => {
    if (!ready) return;
    const sp = new URLSearchParams(loc.search); const has = sp.get("net");
    if (base && selected && has !== selected.network) { sp.set("net", selected.network); navigate({ pathname: loc.pathname, search: `?${sp.toString()}`, hash: loc.hash }, { replace: true }); }
    else if (!base && has) { sp.delete("net"); navigate({ pathname: loc.pathname, search: sp.toString() ? `?${sp.toString()}` : "", hash: loc.hash }, { replace: true }); }
  }, [ready, base, selected, loc.pathname, loc.search, loc.hash, navigate]);
  const select = useCallback((c: NetChoice) => {
    persistChoice(c);
    const target = selectInstance(instances ?? [], c);
    const sp = new URLSearchParams(loc.search); if (target && target.base) sp.set("net", target.network); else sp.delete("net");
    navigate({ pathname: landingFor(loc.pathname), search: sp.toString() ? `?${sp.toString()}` : "", hash: loc.pathname === "/integrate" ? loc.hash : "" }, { replace: true });
  }, [instances, loc.pathname, loc.search, loc.hash, navigate]);
  const link = useCallback((to: string) => withNet(to, selected), [selected]);
  useEffect(() => {
    if (!ready) return;
    const section = loc.hash ? document.getElementById(loc.hash.slice(1)) : null;
    if (section) { section.scrollIntoView(); section.focus({ preventScroll: true }); }
    else window.scrollTo({ top: 0 });
  }, [loc.pathname, loc.hash, ready, base]);
  const notice = networkNotice(net, instances ?? []);
  const value = useMemo<NetContext>(() => ({ net, refresh: () => setTick((t) => t + 1), testWallet, choice, instances: instances ?? [], selected, base, ready, unavailable, select, link }), [net, testWallet, choice, instances, selected, base, ready, unavailable, select, link]);
  return (
    <NetCtx.Provider value={value}>
      <div className="aurora"><div className="blob" /></div>
      <div className="grain" />
      <Nav net={net} testWallet={testWallet} instances={instances ?? []} selected={selected} onSelect={select} />
      {(unavailable || notice) && (
        <div className="container netnotices">
          {unavailable && <div className="banner bad" role="status">This link points at {netName(unavailable)} records, which this site does not currently serve — showing {netName(selected?.network)} instead.</div>}
          {notice && <div className={`banner ${notice.tone === "info" ? "info" : ""}`} role="status">{notice.text}</div>}
        </div>
      )}
      {/* keyed by the API base: switching instances remounts every page, so no run, order, quote, report or subject survives the switch */}
      <main key={base}>
        {ready ? (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/integrate" element={<Integrate />} />
            <Route path="/demo" element={<Demo />} />
            <Route path="/runs/:id" element={<RunPage />} />
            <Route path="/inspect" element={<Inspect />} />
            <Route path="/subjects/:address" element={<Inspect />} />
            <Route path="/developer" element={<Developer />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="*" element={<div className="container section"><h2>Not found</h2></div>} />
          </Routes>
        ) : <div className="container section"><p className="dim small"><span className="spinner" /> finding the API instances this site fronts…</p></div>}
      </main>
      <footer className="footer">
        <div className="container row between">
          <span><span className="serif" style={{ fontSize: "1.05rem", color: "var(--ink-2)" }}>ArcPreflight</span> · release <code>{net?.release ?? "…"}</code> · <code>{net?.profile ?? "…"}</code> · {net?.caip2 ?? ""}{base ? <span className="tiny dim"> · served under <code>{base}</code></span> : null}</span>
          <span className="row" style={{ gap: 14 }}><Link to={link("/integrate")}>How to use</Link><a href={apiPath("/openapi.json")} target="_blank" rel="noreferrer">OpenAPI</a><a href="https://github.com/a252937166/arcpreflight" target="_blank" rel="noreferrer">GitHub</a><a href="https://docs.arc.io" target="_blank" rel="noreferrer">Arc docs</a></span>
        </div>
      </footer>
    </NetCtx.Provider>
  );
}
