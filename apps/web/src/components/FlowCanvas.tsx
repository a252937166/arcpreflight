// The lifecycle as a canvas animation (review of 2026-10-09: graphics over text). Seven nodes on a line; completed nodes are filled,
// the active one breathes and a dot travels into it; idle, a dot loops along the whole path. It is drawn from the same
// `LifecycleStage[]` the CSS diagram uses, so the picture can never say more than the records. The CSS diagram stays in the DOM as
// the accessible fallback: it is shown whenever the canvas cannot draw (no 2d context, phone width, reduced motion keeps a static frame).
import { useEffect, useRef } from "react";
import type { LifecycleId, LifecycleStage, StageStatus } from "../lib/outcome";
import { Lifecycle } from "./Lifecycle";

const GLYPH: Record<StageStatus, string | null> = { done: "✓", stop: "✕", review: "!", warn: "!", skipped: "–", active: null, todo: null };
type Palette = { ink: string; ink2: string; ink3: string; line: string; mint: string; amber: string; rose: string; bg: string; teal: string };
function palette(): Palette {
  const css = typeof getComputedStyle === "function" && typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const v = (name: string, fallback: string) => (css?.getPropertyValue(name).trim() || fallback);
  return { ink: v("--ink", "#e9eef7"), ink2: v("--ink-2", "#aeb8c8"), ink3: v("--ink-3", "#6f7a8c"), line: v("--line-2", "rgba(174,184,200,0.32)"), mint: v("--mint", "#6ee7b7"), amber: v("--amber", "#fbbf24"), rose: v("--rose", "#fb7185"), bg: v("--bg", "#07090f"), teal: v("--teal", "#5eead4") };
}

export function FlowCanvas({ stages, idle, onPick, caption, height = 112 }: { stages: LifecycleStage[]; idle?: boolean; onPick?: (id: LifecycleId) => void; caption?: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stagesRef = useRef(stages); stagesRef.current = stages;
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || typeof window === "undefined") return;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;
    wrap.setAttribute("data-canvas", "on");
    const reduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    const p = palette();
    let raf = 0, width = 0, dpr = 1;
    const size = () => {
      const w = Math.max(320, Math.floor(wrap.clientWidth || 640));
      dpr = Math.min(2, window.devicePixelRatio || 1); width = w;
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(height * dpr);
      canvas.style.height = `${height}px`;
    };
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const st = stagesRef.current; const n = st.length;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      const pad = width < 760 ? 44 : 66, y = 40, xs = st.map((_, i) => pad + (i * (width - 2 * pad)) / Math.max(1, n - 1));
      const lastDone = st.reduce((acc, s, i) => (s.status === "done" || s.status === "stop" || s.status === "review" || s.status === "warn" ? i : acc), -1);
      const activeIdx = st.findIndex((s) => s.status === "active");
      // edges: the travelled part solid, the rest dashed
      ctx.lineWidth = 2; ctx.lineCap = "round";
      for (let i = 0; i < n - 1; i++) {
        const travelled = i < lastDone || (activeIdx > 0 && i < activeIdx);
        ctx.beginPath(); ctx.setLineDash(travelled ? [] : [4, 6]); ctx.strokeStyle = travelled ? p.teal : p.line;
        ctx.moveTo(xs[i] + 16, y); ctx.lineTo(xs[i + 1] - 16, y); ctx.stroke();
      }
      ctx.setLineDash([]);
      // the travelling dot: idle → the whole path; active → from the previous node into the active one
      const dot = (x: number, r: number, color: string, alpha = 1) => { ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1; };
      if (!reduce) {
        if (idle && n > 1) { const u = (t % 9) / 9; dot(xs[0] + u * (xs[n - 1] - xs[0]), 5, p.amber, 0.9); }
        else if (activeIdx > 0) { const u = (t % 1.6) / 1.6; const a = xs[activeIdx - 1], b = xs[activeIdx]; dot(a + u * (b - a), 4.5, p.amber, 1 - u * 0.5); }
      }
      // nodes
      st.forEach((s, i) => {
        const x = xs[i];
        const breathe = s.status === "active" && !reduce ? 1 + 0.08 * Math.sin(t * 4) : 1;
        const r = 15 * breathe;
        const color = s.status === "done" ? p.teal : s.status === "stop" ? p.rose : s.status === "review" || s.status === "warn" || s.status === "active" ? p.amber : p.ink3;
        if (s.status === "active" && !reduce) { ctx.globalAlpha = 0.18 + 0.12 * Math.sin(t * 4); ctx.beginPath(); ctx.arc(x, y, r + 9, 0, Math.PI * 2); ctx.fillStyle = p.amber; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = s.status === "done" ? "rgba(94,234,212,0.16)" : s.status === "stop" ? "rgba(251,113,133,0.18)" : s.status === "active" || s.status === "review" || s.status === "warn" ? "rgba(251,191,36,0.14)" : p.bg;
        ctx.fill(); ctx.lineWidth = s.status === "skipped" ? 1 : 1.8; ctx.strokeStyle = color; ctx.globalAlpha = s.status === "skipped" ? 0.45 : 1; ctx.stroke();
        ctx.fillStyle = color; ctx.font = "600 12px 'Space Grotesk', Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(GLYPH[s.status] ?? String(i + 1), x, y + 0.5);
        ctx.globalAlpha = s.status === "skipped" ? 0.5 : 1;
        ctx.fillStyle = s.status === "active" ? p.ink : p.ink2; ctx.font = `${width < 760 ? 10 : 11.5}px 'Space Grotesk', Inter, sans-serif`;
        const label = width < 760 ? s.label.split(" ").slice(0, 2).join(" ") : s.label;
        ctx.fillText(label, x, y + 36);
        if (s.note && width >= 760) { ctx.fillStyle = p.ink3; ctx.font = "10px Inter, system-ui, sans-serif"; ctx.fillText(s.note.length > 22 ? `${s.note.slice(0, 21)}…` : s.note, x, y + 52); }
        ctx.globalAlpha = 1;
      });
      if (!reduce && (idle || activeIdx >= 0)) raf = window.requestAnimationFrame(draw); else raf = 0;
    };
    size(); draw(t0);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { size(); if (!raf) draw(typeof performance !== "undefined" ? performance.now() : Date.now()); }) : null;
    ro?.observe(wrap);
    return () => { if (raf && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(raf); ro?.disconnect(); wrap.removeAttribute("data-canvas"); };
  }, [idle, height, stages]);
  const summary = stages.map((s) => `${s.label}: ${s.status}${s.note ? ` — ${s.note}` : ""}`).join("; ");
  return (
    <div className="flow" ref={wrapRef} data-testid="flow">
      <canvas ref={canvasRef} className="flow-canvas" role="img" aria-label={`lifecycle — ${summary}`} />
      <div className="flow-fallback"><Lifecycle stages={stages} compact onPick={onPick} caption={caption} /></div>
      {caption && <p className="tiny dim flow-caption">{caption}</p>}
    </div>
  );
}
