// One hand-drawn thread stitches the sections of a page together. Anchors are measured from the DOM so the thread
// passes through a knot beside each section; between sections it runs down the margin and crosses the page only in
// the gap between two sections, never through text. It draws itself as you scroll, and small "blocks" travel along
// it — Arc produces about one per second.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type Anchor = { ref: RefObject<HTMLElement | null>; side: "left" | "right" | "center" };
type Pt = { x: number; y: number; top: number; bottom: number };

function route(pts: Pt[]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.abs(a.x - b.x) < 40) { d += ` L ${b.x} ${b.y}`; continue; }
    const gap = b.top - a.bottom;
    const cy = gap > 24 ? a.bottom + gap / 2 : (a.y + b.y) / 2; // cross in the whitespace between the two sections
    const bend = Math.min(70, Math.max(24, gap / 2));
    d += ` L ${a.x} ${cy - bend}`;
    d += ` C ${a.x} ${cy + bend * 0.6}, ${b.x} ${cy - bend * 0.6}, ${b.x} ${cy + bend}`;
    d += ` L ${b.x} ${b.y}`;
  }
  return d;
}

export function Thread({ container, anchors }: { container: RefObject<HTMLElement | null>; anchors: Anchor[] }) {
  const [geom, setGeom] = useState<{ w: number; h: number; pts: Pt[] }>({ w: 0, h: 0, pts: [] });
  const [progress, setProgress] = useState(0);
  const pathRef = useRef<SVGPathElement | null>(null);
  const [len, setLen] = useState(1);

  useLayoutEffect(() => {
    const measure = () => {
      const c = container.current; if (!c) return;
      const cr = c.getBoundingClientRect();
      const pts = anchors.map((a) => {
        const el = a.ref.current; if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = a.side === "left" ? r.left - cr.left - 30 : a.side === "right" ? r.right - cr.left + 30 : r.left - cr.left + r.width / 2;
        return { x: Math.max(14, Math.min(cr.width - 14, x)), y: r.top - cr.top + Math.min(56, r.height / 2), top: r.top - cr.top, bottom: r.bottom - cr.top };
      }).filter((p): p is Pt => !!p);
      setGeom({ w: cr.width, h: c.scrollHeight, pts });
    };
    measure();
    const ro = new ResizeObserver(measure); if (container.current) ro.observe(container.current);
    window.addEventListener("resize", measure);
    const t1 = setTimeout(measure, 600), t2 = setTimeout(measure, 2000); // fonts / images settle
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); clearTimeout(t1); clearTimeout(t2); };
  }, [container, anchors]);

  useEffect(() => { if (pathRef.current) setLen(pathRef.current.getTotalLength() || 1); }, [geom]);
  useEffect(() => {
    const onScroll = () => {
      const c = container.current; if (!c) return;
      const r = c.getBoundingClientRect();
      setProgress(Math.min(1, Math.max(0, (window.innerHeight * 0.9 - r.top) / r.height)));
    };
    onScroll(); window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [container, geom]);

  const d = route(geom.pts);
  if (!d) return null;
  return (
    <svg className="thread" width={geom.w} height={geom.h} viewBox={`0 0 ${geom.w} ${geom.h}`} aria-hidden>
      <defs>
        <filter id="thread-sketch" x="-2%" y="-2%" width="104%" height="104%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="3" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" /></filter>
      </defs>
      <path d={d} className="thread-ghost" />
      <path ref={pathRef} d={d} className="thread-ink" filter="url(#thread-sketch)" style={{ strokeDasharray: len, strokeDashoffset: len * (1 - progress) }} />
      {geom.pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="6" className={`thread-knot ${progress * geom.pts.length > i + 0.2 ? "on" : ""}`} />)}
      {[0, 1, 2].map((i) => (
        <rect key={i} width="9" height="9" rx="2" className="thread-block" x="-4.5" y="-4.5"><animateMotion dur={`${28 + i * 8}s`} begin={`${-i * 11}s`} repeatCount="indefinite" path={d} rotate="auto" /></rect>
      ))}
    </svg>
  );
}
