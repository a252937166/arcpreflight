// Fake ArcPreflight API (testnet shape) and fake Arc JSON-RPC node for driving scripts/selftest/lifecycle.ts end to end from a scratch
// directory (review of bf0c800, P2: wallet recovery). The chain facts and the passport come from the synthetic WALLET run of
// packages/passport/test/fixture.ts, converted to JSON-RPC wire format so viem (the script and the verifier CLI) parses them.
import http from "node:http";
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { encodeAbiParameters, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildPassport, bundleToString } from "@arcpreflight/passport";
import { SpendGuard, beginMeasured, createPlan, noteOpen, parsePlan, parseUsdc18, serializePlan, type PlanLedger } from "@arcpreflight/client";
import { APPROVED_CAPS } from "../../lib/plan-ledger.js";
import { syntheticRun, PAYER, MERCHANT, RELAYER, ORDER_CREATOR, ORDER_ID, AMOUNT, FEE, CHAIN, USDC, type Fixture } from "../../../packages/passport/test/fixture.js";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const SCRIPT = resolve(REPO, "scripts/selftest/lifecycle.ts");
const TSX = resolve(REPO, "node_modules/tsx/dist/cli.mjs");
export { PAYER, MERCHANT, ORDER_ID, AMOUNT };
export const DEMO_RUNNER = "0x00000000000000000000000000000000000000d1";
export const PLAN_ID = "lifecycle-test-plan";
export const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"; // the fixture's attempt
export const BASE = "wallet-2026-10-10T07-00-00-000Z";
export const TOKEN = "vs_" + "7".repeat(48);
/** the wallet scenario's worst case as the script computes it with its defaults: createOrder gas 0.006 + fee 0.01 + relay 0.005 + amount 0.005 + pay gas 0.002 */
export const WORST_WALLET = 28_000_000_000_000_000n;
export const BIZ_GAS = 40_364n * 21_000_000_000n; // the fixture's business receipt: gasUsed × effectiveGasPrice
export const BALANCE = 5n * 10n ** 18n;
export const fixture = (): Fixture => syntheticRun("WALLET");

type Json = { status: number; body: unknown } | "drop";
export type Req = { method: string; url: string; body: any; headers: http.IncomingHttpHeaders };
export async function serve(handler: (req: Req) => Json | Promise<Json>) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const answer = await handler({ method: req.method ?? "GET", url: req.url ?? "/", body, headers: req.headers });
      if (answer === "drop") { req.socket.destroy(); return; }
      res.writeHead(answer.status, { "content-type": "application/json" }); res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---- JSON-RPC wire format for the fixture's chain facts
const q = (v: unknown) => toHex(BigInt(String(v)));
const ZERO32 = `0x${"00".repeat(32)}`;
function wireTx(t: Record<string, unknown>, blockHash: string, blockNumber: string) {
  return { hash: t.hash, nonce: q(t.nonce), blockHash, blockNumber: q(blockNumber), transactionIndex: "0x0", from: t.from, to: t.to, value: q(t.value), gas: q(t.gas), gasPrice: q(t.maxFeePerGas), maxFeePerGas: q(t.maxFeePerGas), maxPriorityFeePerGas: q(t.maxPriorityFeePerGas), input: t.input, type: "0x2", chainId: q(CHAIN), accessList: [], v: "0x1", r: "0x1", s: "0x1", yParity: "0x1" };
}
function wireReceipt(r: Record<string, unknown>, status: "0x1" | "0x0") {
  const logs = status === "0x1" ? (r.logs as any[]) : [];
  return { transactionHash: r.transactionHash, transactionIndex: "0x0", blockHash: r.blockHash, blockNumber: q(r.blockNumber), from: r.from, to: r.to, cumulativeGasUsed: q(r.gasUsed), gasUsed: q(r.gasUsed), effectiveGasPrice: q(r.effectiveGasPrice), contractAddress: null,
    logs: logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: q(l.blockNumber), blockHash: r.blockHash, transactionHash: l.transactionHash, transactionIndex: "0x0", logIndex: q(l.logIndex), removed: false })), logsBloom: `0x${"00".repeat(256)}`, status, type: "0x2" };
}
const wireBlock = (number: string, hash: string) => ({ number: q(number), hash, parentHash: ZERO32, nonce: "0x0000000000000000", sha3Uncles: ZERO32, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: ZERO32, stateRoot: ZERO32, receiptsRoot: ZERO32, miner: "0x0000000000000000000000000000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x200", gasLimit: "0x1c9c380", gasUsed: "0x5208", timestamp: "0x68e60000", baseFeePerGas: "0x4a817c800", mixHash: ZERO32, transactions: [], uncles: [] });

/** The chain as the script and the verifier read it: the fixture's fee, order-creation and business transactions; `bizStatus` and `bizReceipt`
 *  script the business transaction's receipt (reverted, or not yet readable); balances are one fixed value for every address. */
export function fakeRpc(f: Fixture, o: { bizStatus?: "0x1" | "0x0"; bizReceipt?: boolean } = {}) {
  const biz = f.hashes.BIZ_TX.toLowerCase(); const bizStatus = o.bizStatus ?? "0x1"; const bizReceipt = o.bizReceipt ?? true;
  const receiptOf = (h: string) => f.receipts[h] ?? null;
  const calls: string[] = [];
  const server = serve(({ body }) => {
    const id = body?.id ?? null; calls.push(String(body?.method));
    const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
    const error = (message: string) => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message } } });
    switch (body?.method) {
      case "eth_chainId": return reply(toHex(CHAIN));
      case "eth_blockNumber": return reply("0x3ef2e6e");
      case "eth_getBalance": return reply(toHex(BALANCE));
      case "eth_getTransactionByHash": { const h = String(body.params[0]).toLowerCase(); const t = f.txs[h]; const r = receiptOf(h); if (!t || !r) return reply(null); if (h === biz && !bizReceipt) return reply({ ...wireTx(t, ZERO32, "0"), blockHash: null, blockNumber: null, transactionIndex: null }); return reply(wireTx(t, String(r.blockHash), String(r.blockNumber))); }
      case "eth_getTransactionReceipt": { const h = String(body.params[0]).toLowerCase(); const r = receiptOf(h); if (!r || (h === biz && !bizReceipt)) return reply(null); return reply(wireReceipt(r, h === biz ? bizStatus : "0x1")); }
      case "eth_getBlockByHash": { const bh = String(body.params[0]).toLowerCase(); const r = Object.values(f.receipts).find((x) => String(x.blockHash).toLowerCase() === bh); return reply(r ? wireBlock(String(r.blockNumber), String(r.blockHash)) : null); }
      case "eth_call": { const call = body.params[0]; if (String(call?.to).toLowerCase() !== MERCHANT.toLowerCase()) return error("unexpected call"); const paid = bizStatus === "0x1" && bizReceipt; return reply(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }], [PAYER, AMOUNT, paid, 0n, 0n])); }
      default: return error(`unsupported ${body?.method}`);
    }
  });
  return { server, calls };
}

/** the attempt as the server's observe route reports it after reconciling from the chain — CONFIRMED/SUCCESS unless overridden */
export function attemptView(f: Fixture, over: Record<string, unknown> = {}) {
  const r: any = f.source.result;
  return { attemptId: ATTEMPT_ID, executionMode: "wallet", state: "CONFIRMED", requestId: r.requestId, orderId: ORDER_ID, merchant: MERCHANT, payer: PAYER, amountNativeAtomic: AMOUNT.toString(), labels: ["LIVE_REQUEST"], decision: "NO_POLICY_VIOLATION", decisionReasons: [], refusal: null, validUntil: "2026-10-08T10:06:00.000Z", prompt: null,
    txHash: f.hashes.BIZ_TX, nonce: 10, from: PAYER, broadcastBlock: "65993460", businessStatus: "SUCCESS", businessTxHash: f.hashes.BIZ_TX, block: "65993462", note: null, deviations: { mismatch: [], deviations: { nonce: { plan: "9", actual: "10" }, gas: { plan: "60000", actual: "70000" } } }, nextAction: "none", passportAvailable: true,
    businessExecution: { attemptId: ATTEMPT_ID, state: "CONFIRMED", txHash: f.hashes.BIZ_TX, nonce: 10, broadcastBlock: "65993460", businessStatus: "SUCCESS", businessTxHash: f.hashes.BIZ_TX, block: "65993462", consumedBy: null, note: null, validUntil: null }, createdAt: "2026-10-08T10:05:00.000Z", updatedAt: "2026-10-08T10:06:00.000Z",
    plan: r.plan, recovery: { recoveryVersion: "1.0", attemptId: ATTEMPT_ID, interrupted: false, counters: { ordersCreated: 1, checkFeeAuthorizations: 1, businessSignatures: 0, broadcastsOfOriginalBytes: 1, replacementSignatures: 0 }, addedByRecovery: { ordersCreated: 0, checkFeeAuthorizations: 0, businessSignatures: 0, broadcastsOfOriginalBytes: 0 }, originalTransaction: { hash: f.hashes.BIZ_TX, status: "confirmed" }, reconciliation: [{ at: "2026-10-08T10:06:00.000Z", chainStatus: "CONFIRMED", businessStatus: "SUCCESS", note: null }] },
    costStatement: { costStatementVersion: "1.1", buyer: { address: PAYER, role: "visitor-wallet", complete: true, totalNativeAtomic: (AMOUNT + FEE * 10n ** 12n + BIZ_GAS).toString(), totalUsdc: "0.060847644" }, operator: { complete: true }, actual: { businessPrincipalNativeAtomic: AMOUNT.toString(), checkFeeTokenAtomic: FEE.toString(), businessGasNativeAtomic: BIZ_GAS.toString() } },
    ...over };
}
export const orderView = (over: Record<string, unknown> = {}) => ({ orderId: ORDER_ID, owner: "visitor:test", source: "developer", runId: null, payer: PAYER, merchant: MERCHANT, proxy: "MAIN", amountNativeAtomic: AMOUNT.toString(), reference: "lifecycle rehearsal", state: "CONFIRMED", tx: null, block: "65993420", paid: true, paidCheckedAt: "2026-10-08T10:06:00.000Z", note: null, checks: [], attempts: [{ attemptId: ATTEMPT_ID, state: "CONFIRMED", txHash: null, businessStatus: "SUCCESS", createdAt: "", updatedAt: "" }], nextAction: "none", createdAt: "", updatedAt: "", ...over });

/** The ArcPreflight API as the script sees it on the testnet: /v1/network, the owner's attempt (bearer-checked), its passport and its order. */
export function fakeApi(f: Fixture, rpcUrl: string, o: { attempt: () => any; order?: () => any; passportReady?: boolean; token?: string }) {
  const token = o.token ?? TOKEN; const requests: { method: string; url: string; auth: string | null }[] = [];
  const bundle = JSON.parse(bundleToString(buildPassport(f.source).files));
  const network = { network: "testnet", chainId: CHAIN, caip2: "eip155:5042002", rpc: rpcUrl, explorer: "http://explorer.invalid", usdc: USDC, profile: "SUBMISSION_RESTRICTED", release: "test0000", priceTokenAtomic: FEE.toString(), supportedTargets: [MERCHANT], head: "65993470",
    accounts: { deployerAdmin: null, demoRunner: DEMO_RUNNER, merchantPayTo: RELAYER, orderCreator: ORDER_CREATOR, orderSignerRole: "order-creator", adminKeyInProcess: false }, deployments: null,
    fixtures: [{ id: "APPROVED_PAYMENT", title: "approved", headline: "NO_POLICY_VIOLATION", expected: "", proxy: "MAIN", blurb: "", merchant: MERCHANT, implementation: null, approvedImplementation: null, upgradeTx: null, baselineDigest: f.digests.baseline }],
    budget: { maxRunsPerDay: 20, usedToday: 0, clientCooldownSeconds: 0, amountNativeAtomic: AMOUNT.toString(), activeRun: null }, access: { selfService: true, session: "/v1/session", publicExecution: true, walletExecution: true, executionReady: true, operatorAcceptance: false }, faucet: { enabled: false } };
  const server = serve(({ method, url, headers }) => {
    const auth = typeof headers.authorization === "string" ? headers.authorization : null; requests.push({ method, url, auth });
    const owned = (answer: () => Json): Json => (auth === `Bearer ${token}` ? answer() : { status: 401, body: { error: "UNAUTHENTICATED" } });
    if (method === "GET" && url === "/v1/network") return { status: 200, body: network };
    if (method === "POST" && url === "/v1/session") return { status: 201, body: { principal: "visitor:new", token: `vs_${"8".repeat(48)}` } };
    if (method === "GET" && url === `/v1/wallet/attempts/${ATTEMPT_ID}`) return owned(() => ({ status: 200, body: o.attempt() }));
    if (method === "GET" && url === `/v1/wallet/attempts/${ATTEMPT_ID}/passport`) return owned(() => (o.passportReady === false ? { status: 409, body: { error: "PASSPORT_NOT_READY" } } : { status: 200, body: bundle }));
    if (method === "GET" && url === `/v1/demo/orders/${ORDER_ID}`) return owned(() => ({ status: 200, body: (o.order ?? orderView)() }));
    return { status: 404, body: { error: "NOT_FOUND", url } };
  });
  return { server, requests };
}

// ---- what a previous invocation left behind in the scratch root
export const addrsOf = (walletAddress: string) => [walletAddress, DEMO_RUNNER, ORDER_CREATOR, RELAYER].map((a) => a.toLowerCase());
export const openId = (f: Fixture, tx = true) => `${BASE}:order:${ORDER_ID}:attempt:${ATTEMPT_ID}${tx ? `:tx:${f.hashes.BIZ_TX}` : ""}`;
/** a throwaway visitor key written as the script expects (`{ address, privateKey }`); the key is never printed */
export function writeKey(root: string) { const pk = generatePrivateKey(); const address = privateKeyToAccount(pk).address; const path = join(root, "keys", "visitor.json"); mkdirSync(join(root, "keys"), { recursive: true }); writeFileSync(path, JSON.stringify({ address, privateKey: pk })); return { path, address }; }
export function seedPlan(root: string, walletAddress: string, o: { open: string; pending?: bigint; outflow?: bigint }) {
  let p: PlanLedger = createPlan({ planId: PLAN_ID, network: "testnet", approved: APPROVED_CAPS, now: "2026-10-10T07:00:00.000Z" });
  p = beginMeasured(p, "lifecycle", addrsOf(walletAddress), 4n * BALANCE + (o.outflow ?? 10_000_000_000_000_000n), "2026-10-10T07:00:00.000Z");
  p = noteOpen(p, "lifecycle", o.open, true, o.pending ?? WORST_WALLET, "2026-10-10T07:01:00.000Z");
  mkdirSync(join(root, "evidence", "spend"), { recursive: true }); writeFileSync(join(root, "evidence", "spend", `testnet-plan-${PLAN_ID}.json`), serializePlan(p));
}
export const readPlan = (root: string) => parsePlan(readFileSync(join(root, "evidence", "spend", `testnet-plan-${PLAN_ID}.json`), "utf8"));
/** the visitor ledger as the previous invocation wrote it: the fee settled, the business payment `sent` with the fixture's hash */
export function seedWalletLedger(root: string, f: Fixture) {
  const g = new SpendGuard({ label: "lifecycle-wallet", network: "testnet", perTxNativeAtomic: parseUsdc18("0.10"), totalNativeAtomic: parseUsdc18("0.20"), maxFeePerGasCeiling: 40n * 10n ** 9n }, []);
  const fee = g.reserve({ purpose: "check fee authorization", to: RELAYER, tokenNativeEquivalent: FEE * 10n ** 12n, gasLimit: 0n, maxFeePerGas: 0n, authorization: true }); g.settle(fee, FEE * 10n ** 12n);
  const pay = g.reserve({ purpose: "business payment", to: MERCHANT, valueNativeAtomic: AMOUNT, gasLimit: 60_000n, maxFeePerGas: 21_000_000_000n }); g.sent(pay, f.hashes.BIZ_TX);
  mkdirSync(join(root, "evidence", "spend"), { recursive: true }); writeFileSync(join(root, "evidence", "spend", "testnet-lifecycle-wallet.json"), JSON.stringify({ updatedAt: "2026-10-10T07:01:00.000Z", ...g.summary() }, null, 2));
}
export const readWalletLedger = (root: string) => JSON.parse(readFileSync(join(root, "evidence", "spend", "testnet-lifecycle-wallet.json"), "utf8"));
/** the private session store a previous invocation wrote under data/ */
export function seedSessions(root: string, f: Fixture, over: Record<string, unknown> = {}) {
  const r: any = f.source.result;
  const entry = { token: TOKEN, principal: "visitor:test", payer: PAYER, orderId: ORDER_ID, requestId: r.requestId, attemptId: ATTEMPT_ID, policyDigest: f.digests.policy, baselineDigest: f.digests.baseline, plan: r.plan, txHash: f.hashes.BIZ_TX, updatedAt: "2026-10-10T07:01:00.000Z", ...over };
  mkdirSync(join(root, "data", "lifecycle"), { recursive: true }); writeFileSync(join(root, "data", "lifecycle", `testnet-${PLAN_ID}.sessions.json`), JSON.stringify({ [BASE]: entry }, null, 2));
}
export function evidenceFiles(root: string) { const dir = join(root, "evidence", "selftest"); return existsSync(dir) ? readdirSync(dir).filter((x) => x.startsWith("testnet-lifecycle-")).map((x) => JSON.parse(readFileSync(join(dir, x), "utf8"))) : []; }
export function passportFiles(root: string) { const dir = join(root, "evidence", "selftest", "passports"); return existsSync(dir) ? readdirSync(dir) : []; }

/** runs the REAL script as a child process from the scratch root (`cwd`), against the fake API; the verifier CLI runs from the repository.
 *  Asynchronous on purpose: the fake servers live in THIS process, so a blocking spawn would leave the child's requests unanswered. */
export function runScript(root: string, keyPath: string, apiUrl: string, args: string[] = [], env: Record<string, string | undefined> = {}, script = SCRIPT): Promise<{ status: number | null; signal: string | null; out: string; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ARC_NET: "testnet", API_URL: apiUrl, WALLET_KEY_FILE: keyPath, PLAN_ID, ARCPREFLIGHT_ROOT: root, ARCPREFLIGHT_REPO: REPO, SCENARIOS: "", WALLET_PER_TX_CAP_USDC: "0.10", WALLET_SPEND_CAP_USDC: "0.20", LIFECYCLE_RECOVERY_WAIT_MS: "3000", LIFECYCLE_STOP_AFTER: undefined, LIFECYCLE_SETTLE_OPEN: undefined, MAINNET_GO: undefined, NODE_OPTIONS: undefined, ...env };
  for (const k of Object.keys(childEnv)) if (/^VITEST/.test(k)) delete childEnv[k];
  return new Promise((done) => {
    const child = spawn(process.execPath, [TSX, script, ...args], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (status, signal) => { clearTimeout(timer); done({ status, signal, out: `${stdout}\n${stderr}`, stdout, stderr }); });
  });
}
