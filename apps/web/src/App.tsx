import { createContext, useContext, useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { api, type NetworkInfo } from "./lib/api";
import { Nav } from "./components/Nav";
import Home from "./pages/Home";
import Demo from "./pages/Demo";
import RunPage from "./pages/Run";
import Inspect from "./pages/Inspect";
import Developer from "./pages/Developer";
import Evidence from "./pages/Evidence";

export const NetCtx = createContext<{ net: NetworkInfo | null; refresh: () => void; testWallet: boolean }>({ net: null, refresh: () => {}, testWallet: false });
export const useNet = () => useContext(NetCtx);

export default function App({ testWallet }: { testWallet: boolean }) {
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [tick, setTick] = useState(0);
  const loc = useLocation();
  useEffect(() => { let alive = true; api.network().then((n) => alive && setNet(n)).catch(() => {}); const t = setInterval(() => api.network().then((n) => alive && setNet(n)).catch(() => {}), 15_000); return () => { alive = false; clearInterval(t); }; }, [tick]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc.pathname]);
  return (
    <NetCtx.Provider value={{ net, refresh: () => setTick((t) => t + 1), testWallet }}>
      <div className="aurora"><div className="blob" /></div>
      <div className="grid-bg" />
      <Nav net={net} testWallet={testWallet} />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/demo" element={<Demo />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/inspect" element={<Inspect />} />
          <Route path="/subjects/:address" element={<Inspect />} />
          <Route path="/developer" element={<Developer />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="*" element={<div className="container section"><h2>Not found</h2></div>} />
        </Routes>
      </main>
      <footer className="footer">
        <div className="container row between">
          <span>ArcPreflight · release <code>{net?.release ?? "…"}</code> · profile <code>{net?.profile ?? "…"}</code> · {net?.caip2 ?? ""}</span>
          <span className="row" style={{ gap: 14 }}><a href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a><a href="https://github.com/a252937166/arcpreflight" target="_blank" rel="noreferrer">GitHub</a><a href="https://docs.arc.io" target="_blank" rel="noreferrer">Arc docs</a></span>
        </div>
      </footer>
    </NetCtx.Provider>
  );
}
