import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { isAddress } from "viem";
import { useNet } from "../App";
import { api, explorerAddr, type Report } from "../lib/api";
import { Chip, Hex, Spinner } from "../components/Badges";
import { ReportView } from "../components/Report";

const OFFICIAL: Record<string, { name: string; address: string; note: string }[]> = {
  mainnet: [
    { name: "USDC (ERC-20 face)", address: "0x3600000000000000000000000000000000000000", note: "FiatToken proxy, ZeppelinOS slots" },
    { name: "Circle GatewayWallet", address: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", note: "minimal ERC-1967 proxy" },
    { name: "StableFX FxEscrow", address: "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6", note: "minimal ERC-1967 proxy" },
    { name: "CCTP TokenMessengerV2", address: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", note: "ERC-1967 impl + admin" },
    { name: "ERC-8004 IdentityRegistry", address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", note: "minimal ERC-1967 proxy" },
  ],
  testnet: [
    { name: "USDC (ERC-20 face)", address: "0x3600000000000000000000000000000000000000", note: "FiatToken proxy, ZeppelinOS slots" },
  ],
};

export default function Inspect() {
  const { net } = useNet();
  const { address } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(address ?? "");
  const [data, setData] = useState<{ reportDigest: string; report: Report; supported: boolean; evidenceCount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) { setData(null); return; }
    setInput(address); setBusy(true); setErr(null); setData(null);
    api.subject(address).then(setData).catch((e) => setErr(e?.message ?? String(e))).finally(() => setBusy(false));
  }, [address]);
  const go = (a: string) => { const v = a.trim(); if (!isAddress(v, { strict: false })) { setErr("not a 20-byte address"); return; } nav(`/subjects/${v}`); };
  const picks = [...(net?.fixtures.filter((f) => f.merchant).map((f) => ({ name: `DemoMerchant ${f.proxy} proxy`, address: f.merchant!, note: f.proxy === "CHANGED" ? "upgraded A→B after approval" : "approved implementation A" })) ?? []), ...(OFFICIAL[net?.network ?? "mainnet"] ?? [])]
    .filter((p, i, arr) => arr.findIndex((q) => q.address.toLowerCase() === p.address.toLowerCase()) === i);
  return (
    <section className="section">
      <div className="container stack" style={{ gap: 18 }}>
        <div><span className="kicker">Inspect · OBJECT_OBSERVATION</span><h2 style={{ marginTop: 6 }}>Raw, pinned facts about any Arc address</h2><p className="muted" style={{ marginTop: 6 }}>Proxy slots are read raw at a verified block hash, then matched against a known template. No intent, no decision — object observation is never decision-eligible.</p></div>
        <form className="card row" onSubmit={(e) => { e.preventDefault(); go(input); }}>
          <input className="input mono" placeholder="0x… contract address on Arc" value={input} onChange={(e) => setInput(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
          <button className="btn primary" type="submit" disabled={busy}>{busy ? <Spinner /> : "Observe"}</button>
        </form>
        <div className="row" style={{ gap: 8 }}>
          {picks.map((p) => <button key={p.address} className="btn sm" title={`${p.address} · ${p.note}`} onClick={() => go(p.address)}>{p.name}</button>)}
        </div>
        {err && <div className="banner bad">{err}</div>}
        {data && (
          <div className="card glow stack">
            <div className="row between">
              <div className="row" style={{ gap: 8 }}><h3>Subject <Hex value={address!} n={8} link={explorerAddr(net, address!)} /></h3>{data.supported ? <Chip tone="ok">supported intent target</Chip> : <Chip>object observation only</Chip>}<Chip tone="info">{data.evidenceCount} raw RPC evidence items</Chip></div>
              <a className="btn sm" href={`/v1/public-reports/${data.reportDigest}`} target="_blank" rel="noreferrer">report + evidence JSON ↗</a>
            </div>
            <ReportView report={data.report} digest={data.reportDigest} net={net} />
            {!data.supported && <div className="banner info">Decision-eligible SUPPORTED_INTENT reports exist only for the DemoMerchant fixtures in this release (SUBMISSION_RESTRICTED). Everything else is observed, never judged.</div>}
          </div>
        )}
      </div>
    </section>
  );
}
