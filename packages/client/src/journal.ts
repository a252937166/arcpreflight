// Deployment journal (Gate D; review of 2026-10-10, P1 "deployment is not safely resumable"). Every deployment step's transaction
// identity — nonce, hash, the identical signed bytes — is persisted BEFORE the broadcast, and its outcome afterwards. A process that stops
// after a confirmation but before the manifest is written restarts by reconciling what the chain already holds (receipt, pending
// transaction, or a nonce consumed by something else) and continues with the unfinished steps only: a confirmed step is never deployed
// again under a new nonce and address, and a signed step is never signed a second time. Pure: the script persists the journal
// (evidence/deploy-<net>-journal.json) and talks to the chain; this module decides.
import type { Hex } from "viem";
import { SpendRefused } from "./spend.js";

export type JournalStatus = "pending" | "signed" | "confirmed" | "reverted";
export type JournalStep = {
  key: string; label: string; status: JournalStatus;
  nonce: number | null; txHash: Hex | null; raw: Hex | null;
  address: Hex | null; block: string | null; gasUsed: string | null; effectiveGasPrice: string | null;
  signedAt: string | null; confirmedAt: string | null; note: string | null;
};
export type DeployJournal = { journalVersion: 1; network: string; chainId: number; deployer: Hex; startedAt: string; updatedAt: string; manifestWrittenAt: string | null; steps: JournalStep[] };

const stamp = (now?: string) => now ?? new Date().toISOString();
export function newJournal(o: { network: string; chainId: number; deployer: Hex; steps: { key: string; label: string }[]; now?: string }): DeployJournal {
  const at = stamp(o.now);
  return { journalVersion: 1, network: o.network, chainId: o.chainId, deployer: o.deployer, startedAt: at, updatedAt: at, manifestWrittenAt: null,
    steps: o.steps.map((s) => ({ key: s.key, label: s.label, status: "pending", nonce: null, txHash: null, raw: null, address: null, block: null, gasUsed: null, effectiveGasPrice: null, signedAt: null, confirmedAt: null, note: null })) };
}
export function stepOf(j: DeployJournal, key: string): JournalStep { const s = j.steps.find((x) => x.key === key); if (!s) throw new SpendRefused(`journal: unknown step ${key}`); return s; }
const touch = (j: DeployJournal, now?: string): DeployJournal => ({ ...j, updatedAt: stamp(now) });
/** the journal must belong to this deployment: same network, chain and deployer, same step keys in the same order */
export function journalMatches(j: DeployJournal, o: { network: string; chainId: number; deployer: Hex; steps: { key: string }[] }): string | null {
  if (j.journalVersion !== 1) return `journal version ${String((j as any).journalVersion)} is not 1`;
  if (j.network !== o.network || j.chainId !== o.chainId) return `journal is for ${j.network}/${j.chainId}, this run is ${o.network}/${o.chainId}`;
  if (j.deployer.toLowerCase() !== o.deployer.toLowerCase()) return `journal deployer ${j.deployer} differs from ${o.deployer}`;
  const a = j.steps.map((s) => s.key).join(","), b = o.steps.map((s) => s.key).join(",");
  if (a !== b) return `journal steps [${a}] differ from the plan [${b}]`;
  return null;
}
/** the step is about to be broadcast: refused for a confirmed step (never deploy twice) and for a step already signed with another hash
 *  (a second signature for the same step is never made: reconcile the first one) */
export function markSigned(j: DeployJournal, key: string, o: { nonce: number; txHash: Hex; raw: Hex; now?: string }): DeployJournal {
  const s = stepOf(j, key);
  if (s.status === "confirmed") throw new SpendRefused(`${s.label}: already confirmed in the journal (${s.txHash}) — never signed again`);
  if (s.status === "signed" && s.txHash && s.txHash.toLowerCase() !== o.txHash.toLowerCase()) throw new SpendRefused(`${s.label}: a different transaction ${s.txHash} is already signed for this step — reconcile it first; nothing new is signed`);
  const steps = j.steps.map((x) => (x.key === key ? { ...x, status: "signed" as const, nonce: o.nonce, txHash: o.txHash, raw: o.raw, signedAt: stamp(o.now), note: null } : x));
  return touch({ ...j, steps }, o.now);
}
export function markConfirmed(j: DeployJournal, key: string, o: { address: Hex | null; block: string; gasUsed: string; effectiveGasPrice: string; txHash?: Hex; now?: string }): DeployJournal {
  const s = stepOf(j, key);
  if (s.status === "pending" && !o.txHash) throw new SpendRefused(`${s.label}: cannot confirm a step that was never signed`);
  const steps = j.steps.map((x) => (x.key === key ? { ...x, status: "confirmed" as const, txHash: o.txHash ?? x.txHash, address: o.address, block: o.block, gasUsed: o.gasUsed, effectiveGasPrice: o.effectiveGasPrice, confirmedAt: stamp(o.now) } : x));
  return touch({ ...j, steps }, o.now);
}
export function markReverted(j: DeployJournal, key: string, note: string, now?: string): DeployJournal {
  stepOf(j, key);
  return touch({ ...j, steps: j.steps.map((x) => (x.key === key ? { ...x, status: "reverted" as const, note } : x)) }, now);
}
export const markManifestWritten = (j: DeployJournal, now?: string): DeployJournal => ({ ...touch(j, now), manifestWrittenAt: stamp(now) });
export const unfinished = (j: DeployJournal): JournalStep[] => j.steps.filter((s) => s.status !== "confirmed");
export const complete = (j: DeployJournal): boolean => j.steps.every((s) => s.status === "confirmed");
/** the confirmed address of a deployment step (what later steps depend on) */
export function confirmedAddress(j: DeployJournal, key: string): Hex { const s = stepOf(j, key); if (s.status !== "confirmed" || !s.address) throw new SpendRefused(`${s.label}: no confirmed address in the journal`); return s.address; }

/** What the chain says about a signed step: its receipt (if mined), whether the node holds the transaction, and the deployer's latest nonce. */
export type ChainView = { receipt: { status: "success" | "reverted"; contractAddress: Hex | null; blockNumber: string; gasUsed: string; effectiveGasPrice: string } | null; known: boolean; nonceLatest: number };
export type ReconcileAction = { action: "confirm" | "wait" | "resend" | "reverted" | "conflict"; reason: string };
/** What a restart must do with a step that is `signed` in the journal but has no confirmation there. Never signs anything new. */
export function reconcileSigned(step: JournalStep, chain: ChainView): ReconcileAction {
  if (step.status !== "signed") throw new SpendRefused(`${step.label}: only a signed step is reconciled (status ${step.status})`);
  if (chain.receipt) return chain.receipt.status === "success" ? { action: "confirm", reason: `${step.label}: ${step.txHash} is mined in block ${chain.receipt.blockNumber}` } : { action: "reverted", reason: `${step.label}: ${step.txHash} reverted in block ${chain.receipt.blockNumber} — stopping; nothing is re-sent` };
  if (chain.known) return { action: "wait", reason: `${step.label}: the node holds ${step.txHash} without a receipt yet — waiting` };
  if (step.nonce !== null && step.nonce < chain.nonceLatest) return { action: "conflict", reason: `${step.label}: nonce ${step.nonce} was consumed by a transaction that is not ${step.txHash} — stopping; the step needs a manual check (never re-signed automatically)` };
  return { action: "resend", reason: `${step.label}: the node does not hold ${step.txHash} and nonce ${step.nonce} is still free — the identical signed bytes are handed to the node again` };
}
/** the nonce the journal says the next unfinished step will use (its last signed/confirmed nonce + 1, or `noncePending` for a fresh journal):
 *  for planning and preflight display; it asks the chain nothing (audit 2026-10-10, OP-01) */
export function plannedNonce(j: DeployJournal, noncePending: number): number {
  const used = j.steps.filter((s) => s.nonce !== null && s.status !== "pending").map((s) => s.nonce as number);
  return used.length ? Math.max(...used) + 1 : noncePending;
}
/** the nonce the next unfinished step must use: the journal's last signed/confirmed nonce + 1, which must equal the chain's pending nonce.
 *  Call it only once every signed step is reconciled (confirmed, or re-sent and confirmed): a step signed but never broadcast leaves the
 *  chain's pending nonce one behind the journal, which is exactly the state a restart must resolve by re-sending — not refuse. */
export function nextNonce(j: DeployJournal, noncePending: number): number {
  if (j.steps.some((s) => s.status === "signed")) throw new SpendRefused("a signed step is not reconciled yet: reconcile (confirm, wait or re-send the identical bytes) before planning the next nonce");
  const used = j.steps.filter((s) => s.nonce !== null && s.status !== "pending").map((s) => s.nonce as number);
  if (!used.length) return noncePending;
  const expected = Math.max(...used) + 1;
  if (noncePending < expected) throw new SpendRefused(`the chain's pending nonce ${noncePending} is behind the journal's next nonce ${expected}: a signed step is not reconciled yet`);
  if (noncePending > expected) throw new SpendRefused(`the deployer's nonce moved outside the journal (pending ${noncePending}, journal expects ${expected}): a transaction this journal does not know was sent — stopping for a manual check`);
  return expected;
}
export function summarize(j: DeployJournal): string[] {
  return j.steps.map((s) => `${s.label.padEnd(44)} ${s.status.padEnd(9)}${s.nonce !== null ? ` nonce ${s.nonce}` : ""}${s.txHash ? ` ${s.txHash.slice(0, 12)}…` : ""}${s.address ? ` → ${s.address}` : ""}${s.block ? ` block ${s.block}` : ""}${s.note ? ` · ${s.note}` : ""}`);
}
