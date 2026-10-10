// The Developer workflow's identity, persisted per API instance AND per payer (review round 2, docs/LIFECYCLE.md §9): a refresh (or a
// wallet prompt left open) lands back on the same order, check and attempt of the SAME connected account; a different connected account
// never inherits or relabels another account's items — each payer has its own entry, the others stay listed as "other wallets in this
// browser". The server is the source of truth for every state; this keeps only the ids and the exact quoted intent (needed to re-run the
// deterministic decision in the browser — GET /v1/requests/{id} returns the report, not the intent). A browser convenience: when storage
// is unavailable the page still works, it just starts from "create an order" after a refresh.
// Review of c3afab7 (P2): every function takes the API base the record belongs to (the operation's `client.base`); the default — the
// instance selected now — is right only for the page's own render-time reads and writes, never for a step that completes after a switch.
import type { IntentCore } from "@arcpreflight/schema";
import { scopedKey, scopeOf } from "./storage";

export type SavedWorkflow = {
  payer: string; orderId: string; proxy: "MAIN" | "CHANGED" | null; baselineDigest: string | null; approved: boolean;
  requestId: string | null; intent: IntentCore | null; attemptId: string | null; updatedAt: string;
  /** set by the Live Demo's wallet check: "continue in the Developer workflow" (docs/LIFECYCLE.md §1) */
  handoff?: "demo" | null;
};
const STORE = (base?: string) => scopedKey("arcpreflight.workflow", scopeOf(base));
const key = (payer: string) => payer.toLowerCase();
const isSaved = (v: any): v is SavedWorkflow => !!v && typeof v === "object" && typeof v.orderId === "string" && typeof v.payer === "string";
/** every payer's workflow on this instance; a pre-round-2 single object (one payer) is read as that payer's entry */
function readAll(base?: string): Record<string, SavedWorkflow> {
  try {
    const raw = localStorage.getItem(STORE(base)); const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    if (isSaved(v)) return { [key(v.payer)]: v }; // legacy shape
    const out: Record<string, SavedWorkflow> = {};
    for (const [k, w] of Object.entries(v)) if (isSaved(w) && key(w.payer) === k.toLowerCase()) out[k.toLowerCase()] = w;
    return out;
  } catch { return {}; }
}
function writeAll(all: Record<string, SavedWorkflow>, base?: string) { try { localStorage.setItem(STORE(base), JSON.stringify(all)); } catch { /* storage unavailable */ } }
/** the workflow of ONE payer (the connected account); null for an account that has none here */
export function loadWorkflow(payer: string | null | undefined, base?: string): SavedWorkflow | null { if (!payer) return null; return readAll(base)[key(payer)] ?? null; }
/** every saved workflow, newest first — the other accounts' entries are listed read-only under "other wallets in this browser" */
export const loadWorkflows = (base?: string): SavedWorkflow[] => Object.values(readAll(base)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
export function saveWorkflow(w: Omit<SavedWorkflow, "updatedAt">, base?: string) { const all = readAll(base); all[key(w.payer)] = { ...w, updatedAt: new Date().toISOString() }; writeAll(all, base); }
export function patchWorkflow(payer: string, patch: Partial<SavedWorkflow>, base?: string) { const w = loadWorkflow(payer, base); if (w) saveWorkflow({ ...w, ...patch, payer: w.payer }, base); }
export function clearWorkflow(payer: string | null | undefined, base?: string) { if (!payer) return; const all = readAll(base); delete all[key(payer)]; if (Object.keys(all).length) writeAll(all, base); else { try { localStorage.removeItem(STORE(base)); } catch { /* storage unavailable */ } } }
