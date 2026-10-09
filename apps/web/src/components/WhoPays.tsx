// "Who pays" at a glance (review of 2026-10-09, item 1): the two Live Demo entries differ only in whose wallet the money leaves.
export function WhoPays({ mode, fee, order }: { mode: "project" | "wallet"; fee: string; order: string }) {
  const payer = mode === "project" ? "project runner" : "your wallet";
  return (
    <svg className="ill whopays" viewBox="0 0 400 104" role="img" aria-label={mode === "project" ? `the project runner pays the ${fee} USDC check fee, the ${order} USDC order and the gas; your connected wallet is not charged` : `your wallet pays the ${fee} USDC check fee, the ${order} USDC order and the gas`}>
      <rect x="8" y="22" width="124" height="44" rx="10" className={`ink ${mode === "project" ? "mint" : "amber"}`} />
      <text x="70" y="41" textAnchor="middle" className="lbl">{payer}</text>
      <text x="70" y="57" textAnchor="middle" className="mono">{mode === "project" ? "project funds" : "your USDC"}</text>
      <rect x="268" y="22" width="124" height="44" rx="10" className="ink" />
      <text x="330" y="41" textAnchor="middle" className="lbl">DemoMerchant</text>
      <text x="330" y="57" textAnchor="middle" className="mono">demo order</text>
      <path d="M134 36 C 180 20, 220 20, 266 36" className={`ink ${mode === "project" ? "mint" : "amber"}`} markerEnd="url(#arrow)" />
      <path d="M134 50 C 180 66, 220 66, 266 50" className={`ink ${mode === "project" ? "mint" : "amber"}`} markerEnd="url(#arrow)" />
      <text x="200" y="20" textAnchor="middle" className="mono">{order} USDC order + gas</text>
      <text x="200" y="80" textAnchor="middle" className="mono">{fee} USDC check fee (x402)</text>
      {mode === "project" && <g><line x1="18" y1="82" x2="122" y2="82" className="ink rose dashed" /><text x="70" y="98" textAnchor="middle" className="mono" fill="var(--rose)">your wallet · not charged</text></g>}
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></marker></defs>
    </svg>
  );
}
