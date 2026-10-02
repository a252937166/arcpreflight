// Hand-drawn-style SVG illustrations. Every figure explains one idea; a shared "sketch" filter wobbles the strokes.
const Sketch = ({ id = "sketch" }: { id?: string }) => (
  <defs>
    <filter id={id} x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale="0.9" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></marker>
  </defs>
);

/** Squiggly underline for one headline word. */
export const Squiggle = () => (
  <svg viewBox="0 0 300 12" preserveAspectRatio="none" aria-hidden><path d="M2 8 C 30 2, 60 12, 90 7 S 150 2, 180 8 S 240 12, 298 5" /></svg>
);

/** Hand-drawn horizontal rule. */
export const HandRule = () => (
  <div className="rule hand"><svg viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden><path d="M0 3 C 120 1, 240 5, 360 3 S 600 1, 720 4 S 900 5, 1000 2" fill="none" stroke="rgba(174,184,200,0.35)" strokeWidth="1.2" strokeLinecap="round" /></svg></div>
);

/** Hero: an agent looks at a contract through a block-pinned lens; the proxy may have moved from A to B. */
export function HeroScene() {
  return (
    <svg className="ill" viewBox="0 0 640 400" role="img" aria-label="An agent inspects a proxy contract through a block-pinned lens before paying with USDC">
      <Sketch />
      <g filter="url(#sketch)">
        {/* agent */}
        <g className="float slow">
          <rect x="34" y="150" width="104" height="78" rx="14" className="ink draw" />
          <circle cx="66" cy="184" r="5" className="fill-teal" /><circle cx="106" cy="184" r="5" className="fill-teal" />
          <path d="M70 206 Q86 216 102 206" className="ink teal draw d1" />
          <path d="M86 150 L86 128 M78 128 L94 128" className="ink draw d1" />
          <text x="86" y="252" textAnchor="middle" fontSize="12">agent</text>
        </g>
        {/* lens */}
        <g>
          <circle cx="300" cy="190" r="86" className="ink teal draw" strokeWidth="2.2" />
          <path d="M360 254 L410 304" className="ink teal draw d1" strokeWidth="5" />
          <clipPath id="lensclip"><circle cx="300" cy="190" r="84" /></clipPath>
          <g clipPath="url(#lensclip)">
            <rect x="214" y="100" width="172" height="12" className="fill-teal pulse" opacity="0.18" />
            <g className="scan"><rect x="214" y="186" width="172" height="2" className="fill-teal" opacity="0.6" /></g>
          </g>
          <text x="300" y="300" textAnchor="middle" fontSize="12" className="fill-teal">pinned at block #N</text>
          <text x="300" y="322" textAnchor="middle" fontSize="13" className="mono">by hash · EIP-1898</text>
        </g>
        {/* contract inside the lens */}
        <g>
          <rect x="262" y="160" width="76" height="56" rx="8" className="ink draw d1" />
          <text x="300" y="183" textAnchor="middle" fontSize="13" className="lbl">proxy</text>
          <text x="300" y="202" textAnchor="middle" className="mono">slot 0x3608…bbc</text>
        </g>
        {/* implementations */}
        <g>
          <path d="M340 176 C 390 150, 430 130, 470 118" className="ink mint draw d2" markerEnd="url(#arrow)" style={{ color: "var(--mint)" }} />
          <rect x="474" y="96" width="118" height="44" rx="8" className="ink mint draw d2" />
          <text x="533" y="114" textAnchor="middle" fontSize="12" className="lbl">implementation A</text>
          <text x="533" y="130" textAnchor="middle" className="mono">approved · 0x55f4…c24a</text>
          <path d="M340 204 C 390 230, 430 250, 470 262" className="ink amber dashed draw d3" markerEnd="url(#arrow)" style={{ color: "var(--amber)" }} />
          <rect x="474" y="240" width="118" height="44" rx="8" className="ink amber dashed draw d3" />
          <text x="533" y="258" textAnchor="middle" fontSize="12" className="lbl">implementation B</text>
          <text x="533" y="274" textAnchor="middle" className="mono">upgraded? · 0x430c…9ac5</text>
          <text x="548" y="306" textAnchor="middle" fontSize="17" className="fill-amber note">same ABI, same calldata…</text>
        </g>
        {/* agent -> lens arrow + coin */}
        <path d="M142 186 C 170 176, 190 176, 212 186" className="ink soft draw d1" markerEnd="url(#arrow)" style={{ color: "var(--ink-3)" }} />
        <g className="float">
          <circle cx="150" cy="86" r="26" className="ink amber draw d2" />
          <text x="150" y="92" textAnchor="middle" fontSize="12" className="fill-amber">$</text>
          <text className="note" x="150" y="46" textAnchor="middle" fontSize="16">0.01 USDC via x402</text>
        </g>
        <text className="note" x="40" y="330" fontSize="17">nothing is signed until the lens says "still A"</text>
      </g>
    </svg>
  );
}

/** USDC on Arc: one balance, two interfaces, a 10^12 gap. */
export function TwoFaces() {
  return (
    <svg className="ill" viewBox="0 0 560 250" role="img" aria-label="USDC on Arc has an 18-decimal native face and a 6-decimal ERC-20 face over one balance">
      <Sketch id="sk2" />
      <g filter="url(#sk2)">
        <ellipse cx="150" cy="110" rx="78" ry="78" className="ink amber draw" />
        <ellipse cx="150" cy="110" rx="78" ry="20" className="ink amber soft draw d1" opacity="0.5" />
        <text x="150" y="98" textAnchor="middle" fontSize="12" className="fill-amber">native</text>
        <text x="150" y="124" textAnchor="middle" className="mono">18 decimals · pays gas</text>
        <text x="150" y="142" textAnchor="middle" className="mono">msg.value</text>
        <ellipse cx="410" cy="110" rx="78" ry="78" className="ink sky draw d1" />
        <text x="410" y="98" textAnchor="middle" fontSize="12" className="fill-ink" style={{ fill: "var(--sky)" }}>ERC-20 face</text>
        <text x="410" y="124" textAnchor="middle" className="mono">6 decimals · 0x3600…0000</text>
        <text x="410" y="142" textAnchor="middle" className="mono">transfer(to, amount)</text>
        <path d="M232 110 C 260 100, 300 120, 328 110" className="ink draw d2" markerEnd="url(#arrow)" markerStart="url(#arrow)" style={{ color: "var(--ink-2)" }} />
        <text x="280" y="92" textAnchor="middle" fontSize="12">one balance</text>
        <text x="280" y="206" textAnchor="middle" fontSize="19" className="fill-rose note">50000 ≠ 50 000 000 000 000 000</text>
        <text x="280" y="230" textAnchor="middle" fontSize="15" className="fill-dim note">a 10¹² underpayment that looks like 0.05 USDC — AMOUNT_SEMANTICS blocks it before a signature exists</text>
      </g>
    </svg>
  );
}

/** Blocks on a line: pin at N, re-read at N+k, head ahead. */
export function PinnedBlocks() {
  const blocks = Array.from({ length: 11 }, (_, i) => i);
  return (
    <svg className="ill" viewBox="0 0 560 190" role="img" aria-label="Report pinned at block N by hash; final validation re-reads at a fresh block; the head is a few blocks ahead">
      <Sketch id="sk3" />
      <g filter="url(#sk3)">
        <path d="M20 100 L540 100" className="ink soft draw" />
        {blocks.map((i) => <rect key={i} x={30 + i * 48} y="82" width="34" height="36" rx="6" className={`ink draw ${i === 3 ? "teal" : i === 7 ? "mint" : i === 10 ? "amber" : "soft"}`} />)}
        <path d="M47 76 L47 46" className="ink teal draw d1" /><circle cx="47" cy="40" r="5" className="fill-teal" transform="translate(126 0)" />
        <path d="M173 76 L173 46" className="ink teal draw d1" />
        <text x="173" y="34" textAnchor="middle" fontSize="12" className="fill-teal">report pinned here (#N, by hash)</text>
        <path d="M365 76 L365 46" className="ink mint draw d2" />
        <text x="365" y="34" textAnchor="middle" fontSize="12" className="fill-mint">final validation re-reads at #N+k</text>
        <text x="527" y="150" textAnchor="middle" fontSize="12" className="fill-amber">head</text>
        <path d="M470 100 C 490 70, 505 70, 520 96" className="ink amber dashed draw d3" />
        <text x="300" y="160" textAnchor="middle" fontSize="15" className="fill-dim note">a few blocks behind head on purpose: Arc's public RPC is load-balanced, and the hash is what gets verified</text>
      </g>
    </svg>
  );
}

/** Chain of digests. */
export function ReceiptChain() {
  const links = ["intent", "report", "decision", "final validation", "plan", "execution"];
  return (
    <svg className="ill" viewBox="0 0 640 120" role="img" aria-label="Receipt chain: each digest includes the previous ones">
      <Sketch id="sk4" />
      <g filter="url(#sk4)">
        {links.map((l, i) => (
          <g key={l}>
            <rect x={14 + i * 104} y="34" width="86" height="40" rx="20" className={`ink draw ${i % 2 ? "violet" : "sky"}`} style={{ animationDelay: `${i * 0.18}s` }} />
            <text x={57 + i * 104} y="58" textAnchor="middle" fontSize="12" className="lbl">{l}</text>
            {i < links.length - 1 && <path d={`M${100 + i * 104} 54 L${118 + i * 104} 54`} className="ink soft draw" markerEnd="url(#arrow)" style={{ color: "var(--ink-3)" }} />}
          </g>
        ))}
        <text x="320" y="104" textAnchor="middle" fontSize="16" className="fill-violet note">every arrow = the next receipt carries the previous digests · keccak256 over canonical JSON</text>
      </g>
    </svg>
  );
}

/** x402 on Arc through the Circle Facilitator. */
export function FacilitatorFlow() {
  return (
    <svg className="ill" viewBox="0 0 560 220" role="img" aria-label="The agent signs an EIP-3009 authorization; ArcPreflight forwards it with a seller proof; the Circle Facilitator settles on Arc">
      <Sketch id="sk5" />
      <g filter="url(#sk5)">
        <rect x="20" y="70" width="110" height="56" rx="12" className="ink draw" /><text x="75" y="94" textAnchor="middle" fontSize="12" className="lbl">agent (buyer)</text><text x="75" y="112" textAnchor="middle" className="mono">signs EIP-3009</text>
        <rect x="225" y="70" width="110" height="56" rx="12" className="ink teal draw d1" /><text x="280" y="94" textAnchor="middle" fontSize="12" className="lbl">ArcPreflight</text><text x="280" y="112" textAnchor="middle" className="mono">seller proof</text>
        <rect x="430" y="70" width="110" height="56" rx="12" className="ink violet draw d2" /><text x="485" y="94" textAnchor="middle" fontSize="12" className="lbl">Circle Facilitator</text><text x="485" y="112" textAnchor="middle" className="mono">/settle on Arc</text>
        <path d="M132 98 L220 98" className="ink draw d1" markerEnd="url(#arrow)" style={{ color: "var(--ink-2)" }} /><text x="176" y="88" textAnchor="middle" fontSize="12">authorization</text>
        <path d="M337 98 L425 98" className="ink draw d2" markerEnd="url(#arrow)" style={{ color: "var(--ink-2)" }} /><text x="381" y="88" textAnchor="middle" fontSize="12">settle</text>
        <path d="M485 128 C 485 160, 300 160, 280 180" className="ink mint dashed draw d3" markerEnd="url(#arrow)" style={{ color: "var(--mint)" }} />
        <text x="420" y="178" textAnchor="middle" fontSize="12" className="fill-mint">tx on Arc → report delivered</text>
        <text x="75" y="160" textAnchor="middle" fontSize="15" className="fill-amber note">0.01 USDC, 6-dec</text>
        <text x="75" y="180" textAnchor="middle" fontSize="14" className="fill-dim note">no allowance, no gas</text>
      </g>
    </svg>
  );
}

/** A proxy with its implementation slot, approved vs live. */
export function ProxySwap({ changed }: { changed?: boolean }) {
  return (
    <svg className="ill" viewBox="0 0 320 170" role="img" aria-label="Proxy implementation slot pointing to A (approved) or B (live)">
      <Sketch id="sk6" />
      <g filter="url(#sk6)">
        <rect x="16" y="60" width="92" height="50" rx="10" className="ink draw" /><text x="62" y="81" textAnchor="middle" fontSize="12" className="lbl">proxy</text><text x="62" y="98" textAnchor="middle" className="mono">impl slot</text>
        <path d="M110 76 C 150 60, 180 50, 210 44" className={`ink draw d1 ${changed ? "soft dashed" : "mint"}`} markerEnd="url(#arrow)" style={{ color: changed ? "var(--ink-3)" : "var(--mint)" }} />
        <rect x="214" y="22" width="92" height="42" rx="8" className={`ink draw d1 ${changed ? "soft" : "mint"}`} /><text x="260" y="40" textAnchor="middle" fontSize="11" className="lbl">impl A · approved</text><text x="260" y="55" textAnchor="middle" className="mono">0x55f4…c24a</text>
        <path d="M110 96 C 150 112, 180 122, 210 128" className={`ink draw d2 ${changed ? "amber" : "soft dashed"}`} markerEnd="url(#arrow)" style={{ color: changed ? "var(--amber)" : "var(--ink-3)" }} />
        <rect x="214" y="106" width="92" height="42" rx="8" className={`ink draw d2 ${changed ? "amber" : "soft dashed"}`} /><text x="260" y="124" textAnchor="middle" fontSize="11" className="lbl">impl B · live now</text><text x="260" y="139" textAnchor="middle" className="mono">0x430c…9ac5</text>
      </g>
    </svg>
  );
}
