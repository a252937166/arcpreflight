// Deploy DemoMerchant fixtures: impl A, impl B, MAIN proxy (stays on A), CHANGED proxy (upgraded A->B once), the order-creator role on both.
// PREFLIGHT BY DEFAULT (read-only: chain, deployer balance and nonce, fee, gas estimates or measured bounds, predicted addresses, the spend
// plan against the caps, and what a restart would do with the journal; nothing is signed). `--execute` deploys; on mainnet it also needs
// MAINNET_GO=1 (after the typed go for this step).
// Every transaction goes through the spend guard (explicit gas limit and max fee, a per-transaction cap and a step total that includes gas,
// persisted in evidence/spend/<net>-deploy.json) and through the plan ledger (evidence/spend/<net>-plan-<id>.json: the approved caps pinned,
// the budget carried across every step and restart). RESUMABLE (review 2026-10-10, P1): every step's transaction identity — nonce, hash, the
// identical signed bytes — is written to evidence/deploy-<net>-journal.json BEFORE the broadcast and its receipt afterwards. A restart
// reconciles the journal against the chain (confirm a mined step, wait for a known one, re-send the identical bytes of an unknown one whose
// nonce is still free, STOP on a reverted step or a consumed nonce) and continues with the unfinished steps only — a confirmed step is never
// deployed again under a new nonce. The manifest fixtures/deployments-<net>.json is written from the journal when every step is confirmed.
//   ARC_NET=mainnet pnpm exec tsx scripts/demo/deploy.ts                          # preflight
//   ARC_NET=mainnet MAINNET_GO=1 pnpm exec tsx scripts/demo/deploy.ts --execute   # deploy (spends gas); re-run after an interruption to resume
// Rehearsal hooks (testnet only): DEPLOY_OUT_DIR=<dir> keeps the journal, manifest and evidence out of fixtures/ and evidence/;
// DEPLOY_STOP_AFTER=<step key> ends the process right after that step is confirmed (before the manifest); DEPLOY_STOP_AFTER_SEND=<step key>
// ends it right after that step's broadcast (before its receipt); DEPLOY_STOP_AFTER_SIGN=<step key> ends it after the step is signed and journaled
// but BEFORE the broadcast — the three interruptions a restart must survive.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, type Hex } from "viem";
import { SpendRefused, waitForReceiptPatiently, sendIdentical, usdc18, checkStep, pinCaps, recordGuard, beginStep, endStep,
  newJournal, journalMatches, markSigned, markConfirmed, markReverted, markManifestWritten, unfinished, complete, confirmedAddress, reconcileSigned, nextNonce, plannedNonce, summarize, type DeployJournal, type JournalStep } from "@arcpreflight/client";
import { ROOT, net, chain, publicClient, walletFor, artifact, deploymentsPath, writeJson, evidenceDir, feeParams } from "./common.js";
import { limitsFrom, openGuard } from "../lib/spend-ledger.js";
import { openPlan } from "../lib/plan-ledger.js";

const EXECUTE = process.argv.includes("--execute");
const addressOf = (role: string): Hex => getAddress(JSON.parse(readFileSync(resolve(ROOT, "keys", `${role}.json`), "utf8")).address) as Hex; // the address field only; no key is loaded in a preflight
if (EXECUTE && net === "mainnet" && process.env.MAINNET_GO !== "1") throw new SpendRefused("mainnet --execute needs MAINNET_GO=1, set only after the typed go for the deploy step");
const REHEARSAL = { outDir: process.env.DEPLOY_OUT_DIR ?? null, stopAfter: process.env.DEPLOY_STOP_AFTER ?? null, stopAfterSend: process.env.DEPLOY_STOP_AFTER_SEND ?? null, stopAfterSign: process.env.DEPLOY_STOP_AFTER_SIGN ?? null };
if (net === "mainnet" && (REHEARSAL.outDir || REHEARSAL.stopAfter || REHEARSAL.stopAfterSend || REHEARSAL.stopAfterSign)) throw new SpendRefused("DEPLOY_OUT_DIR / DEPLOY_STOP_AFTER / DEPLOY_STOP_AFTER_SEND / DEPLOY_STOP_AFTER_SIGN are testnet rehearsal hooks and are refused on mainnet");
const outDir = REHEARSAL.outDir ? resolve(REHEARSAL.outDir) : evidenceDir;
const manifestPath = REHEARSAL.outDir ? resolve(outDir, `deployments-${net}.json`) : deploymentsPath;
const journalPath = resolve(outDir, `deploy-${net}-journal.json`);
const limits = limitsFrom({ label: "deploy", network: net, perTxUsdc: "0.05", totalUsdc: "0.15", maxFeeGwei: 40, envPrefix: "DEPLOY", maxPerTxUsdc: "0.10", maxTotalUsdc: "0.30" });
const { guard, save, path: ledger, priorEntries } = openGuard(ROOT, limits, { write: EXECUTE });
const book = openPlan(ROOT, net, { write: EXECUTE });
if (net === "mainnet" && !book) throw new SpendRefused("mainnet needs the plan ledger (PLAN_ID must name the approved plan)");
if (book) pinCaps(book.plan, "deploy", { totalNativeAtomic: limits.totalNativeAtomic, perTxNativeAtomic: limits.perTxNativeAtomic, maxFeePerGasCeiling: limits.maxFeePerGasCeiling }); // an environment override cannot raise an approved cap or the fee ceiling
const syncPlan = () => { if (book) book.apply((p) => recordGuard(p, "deploy", guard.entries)); };

const deployer = addressOf("deployer-admin");
const runnerAddr = addressOf("demo-runner");
const orderCreator = getAddress(process.env.ORDER_CREATOR_ADDRESS ?? addressOf("order-creator")) as Hex; // the narrow role (address only; its key is loaded by the API)
const V1 = artifact("DemoMerchantV1"), V2 = artifact("DemoMerchantV2"), PROXY = artifact("ERC1967Proxy");
// gas measured on Arc testnet for the same bytecode (receipts of the 2026-10-07 deployment: 0xdfc1a05a6b…, 0x25a4967df4…, 0x0cc49157d8…,
// 0xf6a9d6200f…, 0x350dfc4e55…, 0xcd9f2e1b0f…, 0x3955633f68…); a transaction whose live estimate exceeds 1.5 × its bound is not sent
const MEASURED: Record<string, bigint> = { implA: 1_067_071n, implB: 1_095_198n, proxyMAIN: 178_416n, proxyCHANGED: 178_416n, creatorMAIN: 52_167n, creatorCHANGED: 52_167n, upgrade: 37_633n };
const margin = (g: bigint) => (g * 12n + 9n) / 10n; // ×1.2, rounded up
const STEP_DEFS = [
  { key: "implA", label: "deploy implementation A (DemoMerchantV1)" }, { key: "implB", label: "deploy implementation B (DemoMerchantV2)" },
  { key: "proxyMAIN", label: "deploy MAIN proxy on A" }, { key: "proxyCHANGED", label: "deploy CHANGED proxy on A" },
  { key: "creatorMAIN", label: "setOrderCreator on MAIN" }, { key: "creatorCHANGED", label: "setOrderCreator on CHANGED" }, { key: "upgrade", label: "upgrade CHANGED proxy A -> B" },
];

const chainId = await publicClient.getChainId();
if (chainId !== chain.id) throw new SpendRefused(`RPC serves chain ${chainId}, not ${net} (${chain.id})`);
// ---- the journal: a previous invocation's record of this deployment, or a fresh one
let journal: DeployJournal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : newJournal({ network: net, chainId, deployer, steps: STEP_DEFS });
const resuming = existsSync(journalPath);
const persistJournal = () => { if (EXECUTE) writeJson(journalPath, journal); };
const problems: string[] = [];
{ const why = resuming ? journalMatches(journal, { network: net, chainId, deployer, steps: STEP_DEFS }) : null; if (why) problems.push(`journal ${journalPath}: ${why} — not continuing a deployment that is not this one`); }

let [bal, nonceLatest, noncePending, fees] = await Promise.all([publicClient.getBalance({ address: deployer }), publicClient.getTransactionCount({ address: deployer, blockTag: "latest" }), publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }), feeParams()]);
const block = await publicClient.getBlock();
const baseFee = block.baseFeePerGas ?? 20_000_000_000n;
/** what the chain says about a signed step (read-only) */
async function chainView(step: JournalStep) {
  const hash = step.txHash as Hex;
  const [rc, tx, latest] = await Promise.all([publicClient.getTransactionReceipt({ hash }).catch(() => null), publicClient.getTransaction({ hash }).catch(() => null), publicClient.getTransactionCount({ address: deployer, blockTag: "latest" })]);
  return { receipt: rc ? { status: rc.status, contractAddress: (rc.contractAddress ?? null) as Hex | null, blockNumber: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString() } : null, known: !!tx, nonceLatest: latest, rc };
}
const signedSteps = journal.steps.filter((s) => s.status === "signed");
const restartActions = await Promise.all(signedSteps.map(async (s) => ({ step: s, ...reconcileSigned(s, await chainView(s)) })));
for (const a of restartActions) if (a.action === "conflict" || a.action === "reverted") problems.push(a.reason);
if (journal.steps.some((s) => s.status === "reverted")) problems.push("the journal records a reverted step: the deployment needs a manual check; nothing is re-signed");

// ---- the plan for the UNFINISHED steps: live estimates where they do not depend on earlier deployments, measured bounds otherwise
const est = async (data: Hex, to?: Hex) => publicClient.estimateGas({ account: deployer, ...(to ? { to } : {}), data }).catch(() => null);
const [estA, estB] = await Promise.all([est(V1.bytecode.object), est(V2.bytecode.object)]);
const liveGas: Record<string, bigint | null> = { implA: estA, implB: estB };
const todo = unfinished(journal).filter((s) => s.status === "pending"); // signed ones are reconciled, never planned again
// audit 2026-10-10 (OP-01): the plan is laid out from the JOURNAL's next nonce; the chain's pending nonce is compared only in execute, after
// every signed step was reconciled — a step signed and never broadcast leaves the chain one nonce behind, which a restart resolves by re-sending
const nonceNext = plannedNonce(journal, noncePending);
if (!signedSteps.length) { try { nextNonce(journal, noncePending); } catch (e: any) { problems.push(e.message); } }
let n = nonceNext; const predicted: Record<string, Hex> = {};
for (const s of todo) { if (s.key.startsWith("impl") || s.key.startsWith("proxy")) predicted[s.key] = getContractAddress({ from: deployer, nonce: BigInt(n) }); n++; }
const steps = todo.map((s) => { const gas = liveGas[s.key] ?? MEASURED[s.key]; return { key: s.key, label: s.label, gas, source: liveGas[s.key] ? "live estimate" : "measured on testnet", gasLimit: margin(gas), worst: margin(gas) * fees.maxFeePerGas, expected: gas * (baseFee + fees.maxPriorityFeePerGas) }; });
const totalWorst = steps.reduce((a, s) => a + s.worst, 0n), totalExpected = steps.reduce((a, s) => a + s.expected, 0n);
const waitingWorst = restartActions.filter((a) => a.action === "wait" || a.action === "resend").reduce((a, x) => a + (guard.entries.find((e) => e.txHash?.toLowerCase() === x.step.txHash?.toLowerCase() && e.status === "sent") ? 0n : 0n), 0n); // already committed in the ledger at its worst case

if (net === "mainnet" && existsSync(manifestPath) && !complete(journal)) problems.push(`${manifestPath} exists but the journal is incomplete: refusing to redeploy over it`);
if (existsSync(manifestPath) && complete(journal) && journal.manifestWrittenAt) problems.push(`${manifestPath} exists and the journal is complete: nothing to deploy`);
if (nonceLatest !== noncePending && !signedSteps.length) problems.push(`deployer has ${noncePending - nonceLatest} pending transaction(s) the journal does not know: nonce latest ${nonceLatest} != pending ${noncePending}`);
if (bal < totalWorst) problems.push(`deployer holds ${usdc18(bal)} USDC, below the plan's worst case ${usdc18(totalWorst)} USDC`);
const codes = await Promise.all(Object.values(predicted).map((a) => publicClient.getCode({ address: a })));
codes.forEach((c, i) => { if (c && c !== "0x") problems.push(`code already exists at the predicted address ${Object.values(predicted)[i]}`); });
// dry check of every unfinished step against the guard (per-tx cap, running total incl. this step's ledger, fee ceiling) and the plan's budget
{ const dry = openGuard(ROOT, limits, { write: false }).guard; for (const s of steps) { try { dry.reserve({ purpose: s.label, gasLimit: s.gasLimit, maxFeePerGas: fees.maxFeePerGas }); } catch (e: any) { problems.push(e.message); } } }
if (book) { const c = checkStep(book.plan, "deploy", totalWorst, limits.totalNativeAtomic); if (!c.ok) problems.push(c.reason!); }

console.log(`network=${net} chainId=${chainId} mode=${EXECUTE ? "EXECUTE" : "PREFLIGHT (read-only; nothing is signed)"}${resuming ? " · RESUMING from the journal" : ""}`);
console.log(`deployer ${deployer} balance ${usdc18(bal)} USDC · nonce ${noncePending} · runner ${runnerAddr} · orderCreator ${orderCreator}`);
console.log(`fees: base ${Number(baseFee) / 1e9} gwei · max fee sent ${Number(fees.maxFeePerGas) / 1e9} gwei · priority ${Number(fees.maxPriorityFeePerGas) / 1e9} gwei · ceiling ${Number(limits.maxFeePerGasCeiling) / 1e9} gwei`);
console.log(`caps: ${usdc18(limits.perTxNativeAtomic)} USDC per transaction · ${usdc18(limits.totalNativeAtomic)} USDC total (gas included) · ledger ${ledger} (${priorEntries} prior entr${priorEntries === 1 ? "y" : "ies"}, ${usdc18(guard.committed())} USDC committed)`);
if (book) for (const l of book.lines()) console.log(l);
console.log(`journal ${journalPath}${resuming ? "" : " (new)"}:`); for (const l of summarize(journal)) console.log(`  ${l}`);
for (const a of restartActions) console.log(`  restart → ${a.action}: ${a.reason}`);
console.log(`plan (${steps.length} unfinished step${steps.length === 1 ? "" : "s"}):`); for (const s of steps) console.log(`  ${s.label.padEnd(44)} gas ${String(s.gas).padStart(8)} (${s.source}) · limit ${String(s.gasLimit).padStart(8)} · worst ${usdc18(s.worst).padEnd(12)} · expected ${usdc18(s.expected)}`);
console.log(`  total worst ${usdc18(totalWorst)} USDC · expected ${usdc18(totalExpected)} USDC`);
if (Object.keys(predicted).length) console.log(`predicted addresses: ${Object.entries(predicted).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
const preflight = { network: net, chainId, at: new Date().toISOString(), deployer, balanceNativeAtomic: bal.toString(), nonce: noncePending, baseFeeGwei: Number(baseFee) / 1e9, maxFeeGwei: Number(fees.maxFeePerGas) / 1e9, caps: guard.summary(), plan: book ? { planId: book.plan.planId, lines: book.lines() } : null,
  journal: { path: journalPath, resuming, steps: journal.steps.map((s) => ({ key: s.key, status: s.status, nonce: s.nonce, txHash: s.txHash, address: s.address })), restartActions: restartActions.map((a) => ({ key: a.step.key, action: a.action })) },
  steps: steps.map((s) => ({ key: s.key, label: s.label, source: s.source, gas: s.gas.toString(), gasLimit: s.gasLimit.toString(), worstUsdc: usdc18(s.worst), expectedUsdc: usdc18(s.expected) })), totalWorstUsdc: usdc18(totalWorst), totalExpectedUsdc: usdc18(totalExpected), predicted, problems };
writeJson(`${outDir}/preflight/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, preflight);
void waitingWorst;
if (problems.length) { console.log(`NOT READY (${problems.length}):`); for (const p of problems) console.log(`  - ${p}`); process.exit(2); }
if (!EXECUTE) { console.log("PREFLIGHT OK: nothing was signed or sent."); process.exit(0); }

// ---- execute: reconcile what a previous invocation signed, then every unfinished step — reserved before signing, journaled before the
//      broadcast, sent with its explicit gas limit / max fee / nonce, settled from its receipt
const admin = walletFor("deployer-admin");
if (getAddress(admin.account.address) !== deployer) throw new SpendRefused("the deployer key does not match keys/deployer-admin.json's address");
if (book) book.apply((p) => beginStep(p, "deploy"));
const ledgerIndexOf = (hash: Hex) => guard.entries.findIndex((e) => e.txHash?.toLowerCase() === hash.toLowerCase());
const stopHere = (why: string, code = 3): never => { console.log(`REHEARSAL STOP: ${why} — the process ends here as an interruption would`); process.exit(code); };
async function confirmFromReceipt(key: string, rc: { status: string; contractAddress?: Hex | null; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; transactionHash: Hex }) {
  const step = journal.steps.find((s) => s.key === key)!;
  const actual = rc.gasUsed * rc.effectiveGasPrice;
  const idx = ledgerIndexOf(rc.transactionHash); if (idx >= 0 && guard.entries[idx].status === "sent") { guard.settle(idx, actual); save(); syncPlan(); }
  if (rc.status !== "success") { journal = markReverted(journal, key, `reverted in block ${rc.blockNumber}`); persistJournal(); throw new SpendRefused(`${step.label} reverted: ${rc.transactionHash} — stopping`); }
  journal = markConfirmed(journal, key, { address: (rc.contractAddress ?? null) as Hex | null, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString(), txHash: rc.transactionHash }); persistJournal();
  console.log(`${step.label}: ${rc.transactionHash} block ${rc.blockNumber} gas ${rc.gasUsed} cost ${usdc18(actual)} USDC${rc.contractAddress ? ` → ${rc.contractAddress}` : ""} · committed ${usdc18(guard.committed())}/${usdc18(limits.totalNativeAtomic)}`);
  if (REHEARSAL.stopAfter === key) stopHere(`DEPLOY_STOP_AFTER=${key}: confirmed, manifest not written`);
}
try {
  // 1. the steps a previous invocation signed
  for (const a of restartActions) {
    const hash = a.step.txHash as Hex;
    if (a.action === "confirm") { const v = await chainView(a.step); await confirmFromReceipt(a.step.key, v.rc!); continue; }
    if (a.action === "resend") { console.log(a.reason); const sent = await sendIdentical(publicClient, a.step.raw as Hex, () => true, 3, 1500); if (!sent.accepted && !(await publicClient.getTransaction({ hash }).catch(() => null))) throw new SpendRefused(`${a.step.label}: the node did not accept ${hash} again after ${sent.attempts} attempt(s) (${sent.sendError}) — stopping`); }
    else console.log(a.reason);
    const rc = await waitForReceiptPatiently(publicClient, hash, 180_000);
    await confirmFromReceipt(a.step.key, rc as any);
  }
  // 2. the unfinished steps, in order, from the journal's next nonce
  [nonceLatest, noncePending] = await Promise.all([publicClient.getTransactionCount({ address: deployer, blockTag: "latest" }), publicClient.getTransactionCount({ address: deployer, blockTag: "pending" })]);
  let nonce = nextNonce(journal, noncePending);
  async function send(key: string, bound: bigint, tx: (gas: bigint, f: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, n: number) => Promise<Hex>, estimate: () => Promise<bigint>) {
    const step = journal.steps.find((s) => s.key === key)!; const label = step.label;
    const f = await feeParams();
    const live = await estimate();
    if (live > (bound * 15n) / 10n) throw new SpendRefused(`${label}: live gas estimate ${live} is above 1.5 × the planned ${bound} — stopping`);
    const gas = margin(live);
    if (book) { const c = checkStep(book.plan, "deploy", gas * f.maxFeePerGas, limits.totalNativeAtomic); if (!c.ok) throw new SpendRefused(c.reason!); }
    const idx = guard.reserve({ purpose: label, gasLimit: gas, maxFeePerGas: f.maxFeePerGas }); save(); syncPlan();
    let raw: Hex;
    try { raw = await tx(gas, f, nonce); } catch (e) { guard.release(idx); save(); syncPlan(); throw e; } // failed while signing: nothing was sent
    const hash = keccak256(raw);
    // the identity is durable BEFORE the broadcast: ledger (worst case committed) and journal (nonce, hash, the identical bytes)
    guard.sent(idx, hash); save(); syncPlan();
    journal = markSigned(journal, key, { nonce, txHash: hash, raw }); persistJournal();
    if (REHEARSAL.stopAfterSign === key) stopHere(`DEPLOY_STOP_AFTER_SIGN=${key}: signed and journaled, nothing broadcast`);
    const sent = await sendIdentical(publicClient, raw, () => true, 3, 1500);
    if (!sent.accepted && !(await publicClient.getTransaction({ hash }).catch(() => null))) throw new SpendRefused(`${label}: the node did not accept ${hash} after ${sent.attempts} attempt(s) (${sent.sendError}); it stays committed at its worst case in the ledger and signed in the journal — stopping; re-run the step to reconcile and continue`);
    if (REHEARSAL.stopAfterSend === key) stopHere(`DEPLOY_STOP_AFTER_SEND=${key}: broadcast, receipt not awaited`);
    nonce++;
    const rc = await waitForReceiptPatiently(publicClient, hash, 120_000);
    await confirmFromReceipt(key, rc as any);
  }
  const deployStep = async (key: string, abi: any, bytecode: Hex, args: unknown[] = []) => {
    if (journal.steps.find((s) => s.key === key)!.status === "confirmed") return;
    const data = encodeDeployData({ abi, bytecode, args });
    await send(key, MEASURED[key], (gas, f, nn) => admin.signTransaction({ chain, data, gas, nonce: nn, value: 0n, type: "eip1559", ...f } as any), () => publicClient.estimateGas({ account: deployer, data }));
  };
  const callStep = async (key: string, address: Hex, functionName: string, args: unknown[]) => {
    if (journal.steps.find((s) => s.key === key)!.status === "confirmed") return;
    const data = encodeFunctionData({ abi: V1.abi, functionName, args } as any);
    await send(key, MEASURED[key], (gas, f, nn) => admin.signTransaction({ chain, to: address, data, gas, nonce: nn, value: 0n, type: "eip1559", ...f } as any), () => publicClient.estimateGas({ account: deployer, to: address, data }));
  };
  const initArgs = (impl: Hex) => [impl, encodeFunctionData({ abi: V1.abi, functionName: "initialize", args: [deployer] })];
  await deployStep("implA", V1.abi, V1.bytecode.object);
  await deployStep("implB", V2.abi, V2.bytecode.object);
  await deployStep("proxyMAIN", PROXY.abi, PROXY.bytecode.object, initArgs(confirmedAddress(journal, "implA")));
  await deployStep("proxyCHANGED", PROXY.abi, PROXY.bytecode.object, initArgs(confirmedAddress(journal, "implA")));
  await callStep("creatorMAIN", confirmedAddress(journal, "proxyMAIN"), "setOrderCreator", [orderCreator]);
  await callStep("creatorCHANGED", confirmedAddress(journal, "proxyCHANGED"), "setOrderCreator", [orderCreator]);
  await callStep("upgrade", confirmedAddress(journal, "proxyCHANGED"), "upgradeToAndCall", [confirmedAddress(journal, "implB"), "0x"]);
} catch (e) { if (book) book.apply((p) => endStep(p, "deploy", "stopped")); throw e; }

// ---- the manifest, from the journal (every step confirmed); the code hashes are read from the chain now
if (!complete(journal)) throw new SpendRefused("not every step is confirmed; the manifest is not written");
const S = (key: string) => journal.steps.find((s) => s.key === key)!;
const deployed = async (key: string) => { const address = confirmedAddress(journal, key); const code = await publicClient.getCode({ address }); return { address, tx: S(key).txHash as Hex, codeHash: keccak256(code!), block: S(key).block as string }; };
const [implA, implB, mainProxy, changedProxy] = await Promise.all([deployed("implA"), deployed("implB"), deployed("proxyMAIN"), deployed("proxyCHANGED")]);
const deployments = {
  network: net, chainId: chain.id, deployer, runner: runnerAddr, orderCreator, deployedAtUTC: new Date().toISOString(),
  implA, implB, proxies: { MAIN: { ...mainProxy, setOrderCreatorTx: S("creatorMAIN").txHash, setOrderCreatorBlock: S("creatorMAIN").block }, CHANGED: { ...changedProxy, setOrderCreatorTx: S("creatorCHANGED").txHash, setOrderCreatorBlock: S("creatorCHANGED").block, upgradeTx: S("upgrade").txHash, upgradeBlock: S("upgrade").block, currentImpl: implB.address } },
  compiler: { solc: "0.8.28", evm: "cancun", optimizerRuns: 200 },
};
writeJson(manifestPath, deployments);
journal = markManifestWritten(journal); persistJournal();
if (book) book.apply((p) => endStep(p, "deploy", "done"));
const txs = Object.fromEntries(journal.steps.map((s) => [s.key, { tx: s.txHash, block: s.block, gasUsed: s.gasUsed, effectiveGasPrice: s.effectiveGasPrice, costUsdc: s.gasUsed && s.effectiveGasPrice ? usdc18(BigInt(s.gasUsed) * BigInt(s.effectiveGasPrice)) : null, contractAddress: s.address }]));
writeJson(`${outDir}/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, { ...deployments, transactions: txs, spend: guard.summary(), journal: { path: journalPath, startedAt: journal.startedAt, resumed: resuming }, plan: book ? book.lines() : null });
console.log(`wrote ${manifestPath} · spent ${usdc18(guard.committed())} USDC of the ${usdc18(limits.totalNativeAtomic)} USDC cap${resuming ? " · resumed from the journal" : ""}`);
