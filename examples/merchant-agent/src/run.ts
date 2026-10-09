// merchant-agent: the persistent reference runner (design v3.2 §15). It drives the same loop as the public demo with a DURABLE
// execution store, so an interrupted attempt is reconciled from its original context on the next start — never re-signed.
//
//   run <FIXTURE> [--db <file>] [--api <url>] [--receipt-timeout <ms>] [--crash-after-broadcast]
//                  if the store holds open attempts or unconfirmed orders, `run` reconciles them and exits 3 WITHOUT starting a purchase
//   reconcile      [--db <file>]            resolve open attempts from the original hash, nonce and order state (may rebroadcast identical bytes),
//                                          and unconfirmed orders from the chain (design v3.3 §2: identity recorded before the send)
//   list           [--db <file>]            show stored attempts, orders and runs (artefact counts)
//   passport <attemptId|runKey> [--db <file>] [--out <dir>] [--disclosure public|private]
//                                          export the Payment Passport of a run from the artefacts persisted while it ran plus the
//                                          store's outcome — a run interrupted after the broadcast still exports completely
//
// Env: ARC_NET=testnet|mainnet, RUNNER_TOKEN (principal token for the API), BASELINE_DIGEST_MAIN / BASELINE_DIGEST_CHANGED,
//      ORDER_CREATOR_PRIVATE_KEY (or keys/order-creator.json) — the owner/deployer key is NOT accepted for order creation,
//      DEMO_RUNNER_PRIVATE_KEY (or keys/demo-runner.json). The store encrypts signed bytes with a key derived from the runner key.
// `--crash-after-broadcast` ends the process right after the broadcast marker and the send: the controlled interruption used for
// the recovery rehearsal (AP32-17). Only ever run it against your own testnet fixtures.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { ExecutionReceipt, executionDigest } from "@arcpreflight/schema";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { buildPassport, assembleRunResultFromArtifacts, type PassportSource, type Capture } from "@arcpreflight/passport";
import { writePassportDirectory } from "@arcpreflight/passport/node";
import { runFixture, reconcileExecution, reconcileRpcFromClient, reconcilePlannedOrder, postconditionDigest, SqliteExecutionStore, sealerFromSigner, openStoreDb, type Fixture, type ExecutionStore } from "@arcpreflight/runner";
import { net, chain, publicClient, walletFor, account, readDeployments, writeJson, evidenceDir, feeParams, ROOT } from "../../../scripts/demo/common.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);
const dbPath = resolve(flag("--db") ?? resolve(ROOT, "examples/merchant-agent/data", `agent-${net}.sqlite`));
const apiUrl = flag("--api") ?? process.env.API_URL ?? "http://127.0.0.1:4040";
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

async function openStore() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const runner = account("demo-runner");
  const sealer = await sealerFromSigner(runner, chain.id);
  return { runner, store: new SqliteExecutionStore(openStoreDb(dbPath), sealer, `merchant-agent:${net}`) };
}

/** Orders planned or sent before an interruption: confirmed from the receipt or the chain's order state, never replaced. Returns how many stay pending. */
async function reconcileOrders(store: SqliteExecutionStore): Promise<number> {
  let pending = 0;
  for (const o of store.listOpenOrders()) {
    const r = await reconcilePlannedOrder(publicClient as any, o);
    store.applyOrderReconciliation(o.orderId, r);
    if (r.kind === "pending") pending++;
    console.log(`order ${short(o.orderId)}: ${r.kind === "pending" ? "still pending (inside the window)" : `${r.kind.toUpperCase()} — ${r.note}`}`);
  }
  return pending;
}
/** Resolve every open attempt from its original context. Returns how many are still open inside their validation window. */
async function reconcileAll(store: SqliteExecutionStore, allowSend: boolean): Promise<number> {
  const rpc = reconcileRpcFromClient(publicClient as any);
  let openInWindow = 0;
  for (const row of store.listOpen()) {
    const x = store.toStored(row);
    const r = await reconcileExecution(rpc, x, { allowSend });
    if (r.kind === "closed") { store.close(x.attemptId, r.storeState, r.outcome, r.consumedBy); console.log(`${x.attemptId}: ${r.storeState} (${r.outcome.chainStatus}/${r.outcome.businessStatus})${r.consumedBy ? ` consumedBy=${short(r.consumedBy)}` : ""} — ${r.outcome.note ?? ""}`); continue; }
    store.note(x.attemptId, r.reason);
    if (new Date(x.validUntil) > new Date()) openInWindow++;
    console.log(`${x.attemptId}: still open — ${r.reason}${r.rebroadcast ? " (identical bytes rebroadcast)" : ""}`);
  }
  return openInWindow;
}

async function cmdRun() {
  const fixture = (args[1] ?? "APPROVED_PAYMENT") as Fixture;
  if (!["APPROVED_PAYMENT", "CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH"].includes(fixture)) throw new Error(`unknown fixture ${fixture}`);
  const which = fixture === "CHANGED_IMPLEMENTATION" ? "CHANGED" : "MAIN";
  const dep = readDeployments(); if (!dep) throw new Error(`no deployments file for ${net}`);
  const baselineDigest = process.env[`BASELINE_DIGEST_${which}`] as Hex | undefined; if (!baselineDigest) throw new Error(`BASELINE_DIGEST_${which} required`);
  const creatorKey = process.env.ORDER_CREATOR_PRIVATE_KEY ?? (existsSync(resolve(ROOT, "keys", "order-creator.json")) ? "file" : null);
  if (!creatorKey) throw new Error("ORDER_CREATOR_PRIVATE_KEY (or keys/order-creator.json) is required: orders are created by the narrowly scoped orderCreator role, never by the owner key");
  const { runner, store } = await openStore();
  // Restart rule (v3.2 §11, AP32-33): earlier attempts are reconciled from the store FIRST, and this invocation then stops — whatever
  // their outcome — so a new purchase is only ever started by a separate, explicit command once the old outcome has been seen.
  if (store.listOpenOrders().length > 0) {
    const pendingOrders = await reconcileOrders(store);
    console.log(pendingOrders > 0 ? `${pendingOrders} order creation(s) are still unconfirmed inside their window; run \`reconcile\` again later — no new purchase was started` : "unconfirmed order(s) resolved from the chain; run again to start a new purchase");
    process.exit(3);
  }
  if (store.listOpen().length > 0) {
    const open = await reconcileAll(store, true);
    console.log(open > 0 ? `${open} earlier attempt(s) remain unresolved inside their validation window; run \`reconcile\` again later — no new purchase was started`
      : "earlier attempt(s) reconciled from the store; review them (`list`) and run again to start a new purchase — nothing new was signed in this invocation");
    process.exit(3);
  }
  const crash = has("--crash-after-broadcast");
  const wrapped: ExecutionStore = crash ? {
    persistSigned: (e) => store.persistSigned(e),
    markBroadcastAttempted: (id, info) => store.markBroadcastAttempted(id, info),
    persistOutcome: (id, o) => store.persistOutcome(id, o),
  } : store;
  const client = crash ? Object.assign(Object.create(Object.getPrototypeOf(publicClient)), publicClient, {
    sendRawTransaction: async (a: any) => { const h = await publicClient.sendRawTransaction(a); console.log(`\n[crash-after-broadcast] sent ${h}; ending the process NOW — the receipt is never awaited; run \`reconcile\` to recover this attempt from the store`); process.exit(137); return h; },
  }) : publicClient;
  const runKey = `run-${randomUUID()}`; const evidence = store.beginRun(runKey, fixture); // every artefact and step is durable as it happens
  console.log(`run key ${runKey} (passport: merchant-agent passport ${runKey} --out <dir>)`);
  const out = await runFixture({ fixture, net, chain, publicClient: client, admin: walletFor("order-creator"), runner, merchant: getAddress(dep.proxies[which].address) as Hex, baselineDigest,
    apiUrl, token: process.env.RUNNER_TOKEN ?? "", feeParams, orderSignerLabel: "order-creator", executionStore: wrapped, orderStore: store.orderStore(), receiptTimeoutMs: Number(flag("--receipt-timeout") ?? 90_000),
    onArtifact: evidence.onArtifact, onStep: (s) => { evidence.onStep(s); console.log(`[${String(s.atMs).padStart(6)}ms] ${s.step}`, JSON.stringify(s).slice(0, 240)); } });
  writeJson(`${evidenceDir}/runs/${net}-${fixture}-${out.attemptId}.json`, out);
  console.log(`\nRESULT fixture=${fixture} decision=${out.decision.decision} businessTx=${out.execution.businessTxHash ?? "none"} chain=${out.execution.chainStatus} business=${out.execution.businessStatus} serviceFeeTx=${out.serviceFeeTx} store=${dbPath}`);
  if (out.execution.chainStatus === "UNKNOWN") console.log("the attempt is UNRESOLVED (receipt not obtained): run `reconcile` — it resolves from the original hash and the order state and never signs a replacement");
}

async function cmdReconcile() {
  const { store } = await openStore();
  const orders = store.listOpenOrders().length; const rows = store.listOpen();
  if (!rows.length && !orders) { console.log(`nothing open in ${dbPath}`); return; }
  if (orders) await reconcileOrders(store);
  if (rows.length) await reconcileAll(store, true);
}
/** The passport of a run from its artefacts plus the store's outcome (a crash after the broadcast loses nothing a passport needs). */
async function cmdPassport() {
  const id = args[1]; if (!id) throw new Error("usage: merchant-agent passport <attemptId|runKey> [--out <dir>] [--disclosure public|private]");
  const { store } = await openStore();
  const runRow = store.runByAttempt(id); if (!runRow) throw new Error(`no run with attempt id or run key ${id} in ${dbPath}`);
  const artifacts = store.artifactsOf(runRow.run_key); const steps = store.stepsOf(runRow.run_key);
  const result = assembleRunResultFromArtifacts(artifacts, steps, { fixture: runRow.fixture, network: net, chainId: chain.id });
  if (!result) throw new Error("the run has no intent, report, decision and execution artefacts yet; nothing to export");
  // the store's outcome is the fact: an execution artefact left PENDING/UNKNOWN by an interruption is replaced by the reconciled state
  const row = runRow.attempt_id ? store.get(runRow.attempt_id) : undefined;
  const reconciliation: { at: string; chainStatus: string; businessStatus: string; note: string | null; consumedBy: string | null }[] = [];
  if (row && !["SIGNED", "BROADCAST_ATTEMPTED"].includes(row.state)) {
    const chainStatus = row.state === "CONFIRMED" ? "CONFIRMED" : row.state === "REVERTED" ? "REVERTED" : row.state === "INTERRUPTED" || row.state === "NOT_BROADCAST" ? "SIGNED_NOT_BROADCAST" : "UNKNOWN";
    const exec: any = { ...result.execution, chainStatus, businessStatus: row.business_status ?? result.execution.businessStatus, businessTxHash: row.business_tx_hash ?? result.execution.businessTxHash, recordedAt: row.updated_at };
    const postcondition = row.postcondition_json ? JSON.parse(row.postcondition_json) : result.postcondition;
    if (postcondition) exec.postconditionEvidenceDigests = [postconditionDigest(postcondition)];
    const parsed = ExecutionReceipt.parse(exec);
    (result as any).execution = parsed; (result as any).executionDigest = executionDigest(parsed); (result as any).postcondition = postcondition ?? null;
    if (row.closed_by === "reconcile") reconciliation.push({ at: row.updated_at, chainStatus, businessStatus: parsed.businessStatus, note: row.note, consumedBy: row.consumed_by });
    if (reconciliation.length && !steps.some((s) => s.step === "reconciled")) result.steps = [...steps, { step: "reconciled", atMs: -1, chainStatus, businessStatus: parsed.businessStatus, businessTxHash: parsed.businessTxHash, consumedBy: row.consumed_by, why: row.note ?? "outcome established from the original transaction context" }];
  }
  const capture = async (hash: string | null | undefined): Promise<Capture | null> => {
    if (!hash) return null;
    const [tx, receipt] = await Promise.all([publicClient.getTransaction({ hash: hash as Hex }).catch(() => null), publicClient.getTransactionReceipt({ hash: hash as Hex }).catch(() => null)]);
    const j = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    return { tx: tx ? j(tx) : null, receipt: receipt ? j(receipt) : null, capturedAt: new Date().toISOString(), note: "captured from the CLI's RPC at export time; a labelled capture, not pinned evidence" };
  };
  const approval = (artifacts as any).approval ?? null;
  const disclosure = (flag("--disclosure") ?? "private") === "public" ? "public" : "private";
  const feeCapture = await capture(result.serviceFeeTx);
  const relayer = (feeCapture?.tx as any)?.from ? (getAddress(String((feeCapture!.tx as any).from)) as Hex) : null;
  const recorded = (artifacts as any).report?.settlement ?? null;
  // the report was delivered only after the fee settled (x402): a run without the recorded settlement facts still knows the fee transaction
  const settlement: PassportSource["settlement"] = recorded ? { backend: recorded.backend, state: recorded.state, transactionHash: recorded.transactionHash ?? (result.serviceFeeTx as Hex | null), relayer, evidence: recorded.evidence ?? null }
    : result.serviceFeeTx ? { backend: "relay", state: "COMPLETED", transactionHash: result.serviceFeeTx as Hex, relayer, evidence: null } : null;
  const source: PassportSource = {
    generator: { release: process.env.RELEASE_SHA ?? "cli", component: "cli" }, disclosure, chain: { chainId: chain.id as 5042 | 5042002, caip2: `eip155:${chain.id}`, usdc: "0x3600000000000000000000000000000000000000" },
    subject: { kind: "demo-run", runId: runRow.run_key, attemptId: result.attemptId, fixture: runRow.fixture, executionMode: "runner" },
    template: { id: "oz-erc1967proxy-uups@5.4.0", merchant: "DemoMerchantV1", method: "pay(bytes32)", selector: PAY_SELECTOR as Hex },
    result, baseline: approval?.baseline ?? null, reportEvidence: Array.isArray((artifacts as any).report?.evidence) ? (artifacts as any).report.evidence : [],
    settlement, payment: { requestId: result.requestId, quote: result.quote as any, authorization: result.feeAuthorization as any },
    chainCaptures: { feeTx: feeCapture, businessTx: await capture(result.execution.businessTxHash), createOrderTx: await capture(result.orderCreation?.tx) },
    reconciliation, createdAt: new Date().toISOString(),
  };
  const built = buildPassport(source);
  const outDir = resolve(flag("--out") ?? resolve(ROOT, "examples/merchant-agent/data/passports", `${net}-${result.attemptId}`));
  writePassportDirectory(outDir, built.files);
  console.log(`passport written to ${outDir} (${Object.keys(built.files).length} files; coverage ${Object.entries(built.manifest.stageCoverage).filter(([, v]) => v).map(([k]) => k).join(", ")})`);
  console.log(`verify: pnpm exec tsx packages/verifier/src/cli.ts ${outDir} --rpc <arc rpc> --anchors <your anchors.json>`);
}
async function cmdList() {
  const { store } = await openStore();
  for (const r of store.listRuns()) console.log(`${r.created_at}  run ${r.run_key}  ${r.fixture.padEnd(22)}  attempt ${r.attempt_id ?? "—"}  artefacts ${r.artifacts}`);
  for (const o of store.listOrders()) console.log(`${o.created_at}  order ${short(o.order_id)}  ${o.state.padEnd(16)}  tx ${short(o.tx_hash)}  block ${o.block ?? "—"}  ${o.note ?? ""}`);
  for (const r of store.list()) console.log(`${r.created_at}  ${r.attempt_id}  ${r.fixture.padEnd(22)}  ${r.state.padEnd(19)}  ${(r.business_status ?? "—").padEnd(12)}  tx ${short(r.tx_hash)}  ${r.business_tx_hash && r.business_tx_hash !== r.tx_hash ? `business ${short(r.business_tx_hash)}` : ""}  nonce ${r.nonce}  ${r.note ?? ""}`);
}

const commands: Record<string, () => Promise<void>> = { run: cmdRun, reconcile: cmdReconcile, list: cmdList, passport: cmdPassport };
if (!commands[command]) { console.log("usage: merchant-agent run <FIXTURE> | reconcile | list | passport <attemptId|runKey> [--out <dir>] [--disclosure public|private]   [--db <file>] [--api <url>] [--receipt-timeout <ms>] [--crash-after-broadcast]"); process.exit(command === "help" ? 0 : 1); }
await commands[command]();
