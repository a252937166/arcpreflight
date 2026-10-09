// Complete-lifecycle rehearsal (design v3.3, docs/LIFECYCLE.md; acceptance AP33-04/07/08/09/10/12). Two scenarios against a running
// ArcPreflight API on the network it reports:
//   wallet   — a scripted "wallet" (a local key that stands in for the visitor's browser wallet): anonymous session → own order with
//              amount + reference → free quote → ONE EIP-3009 fee authorization → report → server-side wallet attempt (VALIDATED with
//              plan) → the wallet signs and broadcasts exactly the plan → the hash is reported → outcome from the chain → passport →
//              independent verification in a clean process (the verifier CLI).
//   interrupt — the Live Demo runner with `interruptAfterBroadcast`: the run stops right after the send, goes RECONCILE_REQUIRED
//              with its hash recorded, is resolved by the recovery worker (or an observe read) from the original context, exports a
//              complete passport, verified the same way.
// Spends: wallet fee 0.01 + business amount + gas from the wallet key; runner fee 0.01 + 0.05 + gas from the project keys. Testnet by
// default; on mainnet the operator runs it only after the explicit go (ARC_NET must match the API's network).
// Secrets: the wallet key is read from WALLET_KEY_FILE and never printed; only addresses and hashes appear in the output.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createPublicClient, encodeFunctionData, http, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IntentCore, PolicyCore, intentDigest, policyDigest } from "@arcpreflight/schema";
import { DEMO_MERCHANT_ABI, PAY_SELECTOR } from "@arcpreflight/policy";
import { signTransferAuthorization, type ArcNet } from "@arcpreflight/client";
import { PIN_LAG } from "@arcpreflight/observer";

const api = process.env.API_URL ?? "http://127.0.0.1:4041";
const scenarios = (process.env.SCENARIOS ?? "wallet,interrupt").split(",").map((s) => s.trim()).filter(Boolean);
const network = await fetch(`${api}/v1/network`).then((r) => r.json()) as any;
const net = network.network as ArcNet;
assert.equal(process.env.ARC_NET, net, `ARC_NET must be explicit and equal to the API's network (${net})`);
if (net === "mainnet") assert.equal(process.env.MAINNET_GO, "1", "mainnet lifecycle rehearsal needs MAINNET_GO=1 after the typed go");
assert(network.access?.walletExecution === true || (network.access?.publicExecution === false && process.env.ADMIN_TOKEN), "the API must expose wallet execution (design v3.3), or be gated with ADMIN_TOKEN supplied to pass the gate");
const rpcUrl = network.rpc as string; const chainId = network.chainId as number;
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) });
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(process.cwd(), "evidence/selftest"); mkdirSync(resolve(outDir, "passports"), { recursive: true });
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) as any });
const adminHeader: Record<string, string> = process.env.ADMIN_TOKEN ? { "x-admin-token": process.env.ADMIN_TOKEN } : {}; // the mainnet instance gates public execution until the acceptance is recorded; the operator's token passes the gate
const post = (path: string, body: unknown, token?: string) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", ...adminHeader, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(j);
const get = (path: string, token?: string) => fetch(`${api}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(j);
const evidence: any = { generatedAt: new Date().toISOString(), api, network: network.caip2, release: network.release, scenarios: {} };

/** Clean-process verification: the verifier CLI with the API-independent RPC and the anchors the buyer would hold. */
function verifyInCleanProcess(passportPath: string, anchors: { baselineDigests: string[]; policyDigests: string[] }) {
  const anchorsPath = passportPath.replace(/\.passport\.json$/, ".anchors.json");
  writeFileSync(anchorsPath, JSON.stringify(anchors, null, 2));
  const r = spawnSync("pnpm", ["exec", "tsx", "packages/verifier/src/cli.ts", passportPath, "--rpc", rpcUrl, "--anchors", anchorsPath, "--json"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } });
  const out = r.stdout.trim(); const start = out.indexOf("{");
  const parsed = start >= 0 ? JSON.parse(out.slice(start)) : null;
  assert(parsed, `verifier produced no JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  const by = Object.fromEntries(parsed.findings.map((f: any) => [f.id, f.status]));
  return { exit: r.status, counts: parsed.counts, findings: by, anchorsPath };
}
async function waitForBlock(after: bigint) { for (let i = 0; i < 60; i++) { if ((await client.getBlockNumber()) >= after + BigInt(PIN_LAG) + 1n) return; await sleep(1000); } throw new Error("head did not advance past the required block"); }

if (scenarios.includes("wallet")) {
  const keyFile = process.env.WALLET_KEY_FILE; assert(keyFile, "WALLET_KEY_FILE (path to the scripted wallet's key) is required for the wallet scenario");
  const keyText = readFileSync(keyFile, "utf8").trim(); // a raw hex key, or a keys/*.json file with a privateKey field; never printed
  const wallet = privateKeyToAccount((keyText.startsWith("{") ? JSON.parse(keyText).privateKey : keyText) as Hex);
  const amount = BigInt(process.env.WALLET_AMOUNT_ATOMIC ?? "5000000000000000"); // 0.005 USDC
  const reference = process.env.WALLET_REFERENCE ?? `lifecycle rehearsal ${stamp.slice(0, 19)}`;
  log(`wallet scenario: payer ${wallet.address}, amount ${amount} native units, reference "${reference}"`);
  let balance = await client.getBalance({ address: wallet.address });
  const needed = amount + 30_000_000_000_000_000n; // fee 0.01 + amount + a gas reserve
  if (balance < needed && network.faucet?.enabled) { // the visitor path on testnet: claim the project faucet like the site does
    const claim = await post("/v1/faucet", { address: wallet.address });
    log(`faucet claim: ${claim.status} ${claim.body?.txHash ?? claim.body?.error ?? ""} ${claim.body?.reason ?? ""}`);
    for (let i = 0; i < 20 && balance < needed; i++) { await sleep(2000); balance = await client.getBalance({ address: wallet.address }); }
  }
  assert(balance >= needed, `wallet balance ${balance} too low for fee + amount + gas (needed ${needed})`);
  const session = await post("/v1/session", {}); assert.equal(session.status, 201, JSON.stringify(session.body)); const token = session.body.token as string;
  // 1. the order: identity durable before the send; amount and reference are the visitor's
  const order = await post("/v1/demo/orders", { payer: wallet.address, proxy: "MAIN", amountNativeAtomic: amount.toString(), reference }, token);
  assert.equal(order.status, 201, JSON.stringify(order.body)); assert.equal(order.body.state, "CONFIRMED"); assert.equal(order.body.reference, reference);
  log(`order ${order.body.orderId.slice(0, 12)}… created in ${order.body.tx} (block ${order.body.block}) on ${order.body.merchant}`);
  const listed = await get("/v1/demo/orders", token); assert.equal(listed.status, 200); assert(listed.body.orders.some((o: any) => o.orderId === order.body.orderId.toLowerCase()), "the owner's order list must contain the new order");
  assert.equal((await get("/v1/demo/orders", `vs_${"0".repeat(48)}`)).status, 401);
  // 2. policy + intent as the Developer page builds them (human-paced validation window)
  const policy = PolicyCore.parse({ schemaVersion: "1.0", ownerPrincipal: "lifecycle-rehearsal", allowedSenders: [wallet.address], allowedTargets: [order.body.merchant], allowedSelectors: [PAY_SELECTOR], maxNativePaymentAtomic: amount.toString(), maxTokenPaymentAtomic: "0", maxServiceFeeTokenAtomic: "10000", maxGasCostNativeAtomic: "2000000000000000", maxReportAgeSeconds: 60, maxFinalValidationAgeSeconds: 60, requiredSignalIds: ["PROXY_TEMPLATE_VERIFIED", "SUPPORTED_STATE_ORDER_PAYABLE", "CALL_SIMULATION"], unknownAction: "REVIEW_REQUIRED", implementationChangeAction: "REVIEW_REQUIRED", allowedTransactionTypes: [2], allowAuthorizationList: false });
  const pDigest = policyDigest(policy);
  const makeIntent = () => IntentCore.parse({ schemaVersion: "1.0", clientRequestId: `lc-${crypto.randomUUID()}`, chainId, walletMode: "EOA_DIRECT_NON_DELEGATED", from: wallet.address, operation: "CALL", to: order.body.merchant, data: encodeFunctionData({ abi: DEMO_MERCHANT_ABI, functionName: "pay", args: [order.body.orderId] }), valueNativeAtomic: amount.toString(),
    businessExpectation: { sourceId: `order:${order.body.orderId}`, sourceDigest: keccak256(toHex(`order:${order.body.orderId}:${wallet.address}:${amount}`)), action: "MERCHANT_PAY", recipient: order.body.merchant, asset: "ARC_NATIVE_USDC", amountNativeAtomic: amount.toString(), orderId: order.body.orderId },
    baselineDigest: order.body.baselineDigest, policyDigest: pDigest, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  await waitForBlock(BigInt(order.body.block));
  let intent = makeIntent(); let quoted = await post("/v1/preflight", { intent }, token);
  for (let i = 0; i < 5 && quoted.status === 402 && BigInt(quoted.body.pinnedBlock ?? 0) < BigInt(order.body.block); i++) { log("quote pinned before the order; re-requesting under a new clientRequestId (nothing paid)"); await sleep(1500); intent = makeIntent(); quoted = await post("/v1/preflight", { intent }, token); }
  assert.equal(quoted.status, 402, JSON.stringify(quoted.body)); assert(BigInt(quoted.body.pinnedBlock) >= BigInt(order.body.block));
  // 3. ONE fee authorization signed by the wallet; the report is delivered once the fee settles
  const { signature, authorization } = await signTransferAuthorization(wallet, net, { payTo: quoted.body.quote.payTo, valueTokenAtomic: BigInt(quoted.body.quote.amountTokenAtomic) });
  let delivered = await post("/v1/preflight", { intent, payment: { signature, authorization } }, token);
  for (let i = 0; i < 20 && delivered.status === 202; i++) { await sleep(1500); delivered = await get(`/v1/requests/${quoted.body.requestId}`, token); }
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body).slice(0, 300)); assert.equal(delivered.body.delivery, "DELIVERED");
  log(`report delivered; fee settled in ${delivered.body.payment.transaction}; baselineResult ${delivered.body.report.baselineResult}`);
  // 4. the wallet attempt: VALIDATED with its plan before any signature exists
  const attempt = await post("/v1/wallet/attempts", { requestId: quoted.body.requestId, orderId: order.body.orderId, policy }, token);
  assert.equal(attempt.status, 201, JSON.stringify(attempt.body).slice(0, 400));
  assert.equal(attempt.body.state, "VALIDATED"); assert.equal(attempt.body.decision, "NO_POLICY_VIOLATION"); assert(attempt.body.plan?.nonce !== undefined);
  const plan = attempt.body.plan; const attemptId = attempt.body.attemptId as string;
  log(`attempt ${attemptId} VALIDATED until ${attempt.body.validUntil}; plan nonce ${plan.nonce} gas ${plan.gasLimit} maxFee ${Number(plan.maxFeePerGasNativeAtomic) / 1e9} gwei`);
  assert.equal((await get(`/v1/wallet/attempts/${attemptId}/passport`, token)).status, 409, "an open attempt is not exported");
  const second = await post("/v1/wallet/attempts", { requestId: quoted.body.requestId, orderId: order.body.orderId, policy }, token);
  assert.equal(second.status, 409); assert.equal(second.body.error, "ATTEMPT_OPEN");
  // review of 0c0d406 (P1-1): the prompt claim is exclusive — probed with two claim ids before this process signs; the holder's hand-back leaves a plain VALIDATED attempt
  const claimA = `selftest-a-${crypto.randomUUID()}`, claimB = `selftest-b-${crypto.randomUUID()}`;
  const c1 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "prompted", claimId: claimA }, token);
  assert.equal(c1.status, 200, JSON.stringify(c1.body).slice(0, 200)); assert.equal(c1.body.prompt?.state, "PROMPTED"); assert(!JSON.stringify(c1.body).includes(claimA), "the claim id must not appear in the view");
  const c2 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "prompted", claimId: claimB }, token);
  assert.equal(c2.status, 409, JSON.stringify(c2.body).slice(0, 200)); assert.equal(c2.body.error, "PROMPT_CLAIMED"); assert.equal(c2.body.attempt?.state, "VALIDATED");
  const c3 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "not-prompted", claimId: claimB }, token);
  assert.equal(c3.status, 409); assert.equal(c3.body.error, "PROMPT_CLAIMED");
  const c4 = await post(`/v1/wallet/attempts/${attemptId}/prompt`, { event: "not-prompted", claimId: claimA }, token);
  assert.equal(c4.status, 200, JSON.stringify(c4.body).slice(0, 200)); assert.equal(c4.body.prompt, null); assert.equal(c4.body.state, "VALIDATED");
  const claimProbe = { granted: c1.status, secondClaim: `${c2.status} ${c2.body.error}`, strangerHandBack: `${c3.status} ${c3.body.error}`, holderHandBack: `${c4.status} prompt=${c4.body.prompt}` };
  log(`prompt claim probe: granted once (200), second claim ${claimProbe.secondClaim}, stranger's hand-back ${claimProbe.strangerHandBack}, holder's hand-back 200 → plain VALIDATED again`);
  // 5. the "wallet" signs EXACTLY the plan and broadcasts it itself (the service never sees the bytes), then reports the hash
  const raw = await wallet.signTransaction({ chainId: plan.chainId, type: "eip1559", to: plan.to as Hex, data: plan.data as Hex, value: BigInt(plan.valueNativeAtomic), nonce: Number(plan.nonce), gas: BigInt(plan.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGasNativeAtomic), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGasNativeAtomic), accessList: [] });
  const parsed = parseTransaction(raw); assert.equal(parsed.to?.toLowerCase(), plan.to.toLowerCase()); assert.equal(parsed.data?.toLowerCase(), plan.data.toLowerCase());
  const txHash = keccak256(raw);
  await client.sendRawTransaction({ serializedTransaction: raw });
  log(`wallet broadcast ${txHash}`);
  const sent = await post(`/v1/wallet/attempts/${attemptId}/sent`, { txHash }, token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300)); assert(["BROADCAST_ATTEMPTED", "CONFIRMED"].includes(sent.body.state), sent.body.state);
  let a = sent;
  for (let i = 0; i < 60 && a.body.state === "BROADCAST_ATTEMPTED"; i++) { await sleep(2000); a = await get(`/v1/wallet/attempts/${attemptId}`, token); }
  assert.equal(a.body.state, "CONFIRMED", JSON.stringify({ state: a.body.state, note: a.body.note }));
  assert.equal(a.body.businessStatus, "SUCCESS"); assert.equal(a.body.businessTxHash.toLowerCase(), txHash.toLowerCase());
  assert.deepEqual(a.body.deviations?.mismatch ?? [], [], "the wallet sent exactly the plan");
  assert.equal(a.body.recovery.interrupted, false); assert.equal(a.body.recovery.counters.businessSignatures, 0);
  log(`attempt CONFIRMED: order paid in block ${a.body.block}; cost statement buyer total ${a.body.costStatement?.buyer?.totalUsdc} USDC`);
  const shownOrder = await get(`/v1/demo/orders/${order.body.orderId}`, token); assert.equal(shownOrder.body.paid, true); assert(shownOrder.body.attempts.some((x: any) => x.attemptId === attemptId));
  // 6. passport + independent verification in a clean process
  const passport = await get(`/v1/wallet/attempts/${attemptId}/passport`, token); assert.equal(passport.status, 200);
  const passportPath = resolve(outDir, "passports", `${net}-wallet-${stamp}.passport.json`); writeFileSync(passportPath, JSON.stringify(passport.body, null, 2));
  const v = verifyInCleanProcess(passportPath, { baselineDigests: [order.body.baselineDigest], policyDigests: [pDigest] });
  log(`verifier: exit ${v.exit}, pass ${v.counts.pass}, fail ${v.counts.fail}, unverified ${v.counts.unverified ?? 0}; TRANSACTION_PLAN_AGREEMENT=${v.findings.TRANSACTION_PLAN_AGREEMENT} ORDER_OUTCOME=${v.findings.ORDER_OUTCOME} COST_STATEMENT=${v.findings.COST_STATEMENT}`);
  assert.equal(v.counts.fail, 0, JSON.stringify(v.findings));
  const manifest = JSON.parse(passport.body.files["manifest.json"]); assert.equal(manifest.subject.kind, "wallet-run"); assert.equal(manifest.subject.executionMode, "wallet");
  evidence.scenarios.wallet = { payer: wallet.address, claimProbe, order: { orderId: order.body.orderId, tx: order.body.tx, block: order.body.block, amountNativeAtomic: amount.toString(), reference }, requestId: quoted.body.requestId, feeTx: delivered.body.payment.transaction, attemptId, plan, txHash, outcome: { state: a.body.state, businessStatus: a.body.businessStatus, block: a.body.block, deviations: a.body.deviations }, costStatement: a.body.costStatement, passport: passportPath, verifier: v };
}

if (scenarios.includes("interrupt")) {
  const clientRunRequestId = `lc-${crypto.randomUUID()}`;
  let started = await post("/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId, interruptAfterBroadcast: true });
  if (started.status === 429 && started.body?.error === "DEMO_COOLDOWN") { // the public instance's per-client cooldown: wait it out
    const wait = (Number(network.budget?.clientCooldownSeconds ?? 45) + 2) * 1000; log(`cooldown: waiting ${wait / 1000}s`); await sleep(wait);
    started = await post("/v1/demo/run", { fixture: "APPROVED_PAYMENT", clientRunRequestId, interruptAfterBroadcast: true });
  }
  assert.equal(started.status, 202, JSON.stringify(started.body)); const runId = started.body.runId as string;
  log(`live demo run ${runId} started with a labelled interruption after the broadcast`);
  let run: any;
  for (let i = 0; i < 120; i++) { await sleep(2000); run = (await get(`/v1/demo/runs/${runId}`)).body; if (run.state !== "RUNNING") break; }
  const stepNames = run.steps.map((s: any) => s.step);
  assert(stepNames.includes("orderPlanned"), "the order identity is recorded before its creation is sent");
  assert(stepNames.includes("broadcastAttempted") && stepNames.includes("interruptedAfterBroadcast"), `expected the interruption steps, got ${stepNames.join(",")}`);
  const interruptedState = run.state; const outcomeAtStop = run.outcome;
  log(`run stopped: state ${interruptedState}, outcome ${outcomeAtStop?.kind} (${outcomeAtStop?.source}), store ${run.businessExecution?.state}`);
  if (interruptedState === "RECONCILE_REQUIRED") assert.equal(outcomeAtStop.kind, "BROADCAST_UNRESOLVED"); // AP33-06: the headline follows the store, never "nothing sent"
  for (let i = 0; i < 60 && run.state === "RECONCILE_REQUIRED"; i++) { await sleep(3000); run = (await get(`/v1/demo/runs/${runId}`)).body; }
  assert.equal(run.state, "DONE", `run did not reconcile: ${run.state} ${run.businessExecution?.note ?? ""}`);
  assert.equal(run.outcome.kind, "PAID"); assert.equal(run.businessExecution.state, "CONFIRMED");
  assert.equal(run.recovery.addedByRecovery.ordersCreated, 0); assert.equal(run.recovery.addedByRecovery.businessSignatures, 0);
  log(`reconciled: ${run.businessExecution.txHash} CONFIRMED/${run.businessExecution.businessStatus}; recovery added orders=${run.recovery.addedByRecovery.ordersCreated} signatures=${run.recovery.addedByRecovery.businessSignatures}`);
  const passport = await get(`/v1/demo/runs/${runId}/passport`); assert.equal(passport.status, 200);
  const passportPath = resolve(outDir, "passports", `${net}-interrupt-${stamp}.passport.json`); writeFileSync(passportPath, JSON.stringify(passport.body, null, 2));
  const fixture = network.fixtures.find((f: any) => f.id === "APPROVED_PAYMENT");
  const v = verifyInCleanProcess(passportPath, { baselineDigests: [fixture.baselineDigest], policyDigests: [run.result.policyDigest] });
  log(`verifier: exit ${v.exit}, pass ${v.counts.pass}, fail ${v.counts.fail}; ORDER_OUTCOME=${v.findings.ORDER_OUTCOME} TRANSACTION_PLAN_AGREEMENT=${v.findings.TRANSACTION_PLAN_AGREEMENT} COST_STATEMENT=${v.findings.COST_STATEMENT}`);
  assert.equal(v.counts.fail, 0, JSON.stringify(v.findings));
  evidence.scenarios.interrupt = { runId, clientRunRequestId, stateAtStop: interruptedState, outcomeAtStop, steps: stepNames, businessExecution: run.businessExecution, recovery: run.recovery, reconciliation: run.result.reconciliation, costStatement: run.result.costStatement, passport: passportPath, verifier: v };
}

const outPath = resolve(outDir, `${net}-lifecycle-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
log(`evidence written to ${outPath}`);
