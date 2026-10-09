// Public demo endpoints (spec v1.4 §8.9 / §12): the project's own runner buys the x402 report and walks the full
// sense -> decide -> (final validation -> sign -> persist -> broadcast -> postcondition) loop against the DemoMerchant fixtures.
// Budgeted: one run at a time, a global per-day run cap, per-category daily monetary caps reserved atomically before anything
// external happens, a per-client cooldown, and a runner balance floor. Anything that cannot run live is served from the latest
// recorded run with the RECORDED_SAMPLE label. Business transactions are persisted before broadcast and reconciled from their
// original context after a crash or timeout (spec D07): nothing is re-signed, no new order or check is bought by recovery.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, getAddress, type Hex, type PublicClient, type WalletClient, type Transport, type Chain, type Account } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { runFixture, createOrder, postconditionDigest, reconcileExecution, reconcileRpcFromClient, type Fixture, type Step, type ExecutionStore, type ExecutionOutcome, type StoredExecution, type ArtifactName } from "@arcpreflight/runner";
import { ExecutionReceipt, executionDigest } from "@arcpreflight/schema";
import { planOrder, orderSent, orderConfirmed, orderFailed, runnerOrderStore, getOrderRow, listOrderRows, shapeOrder, refreshPaid, reconcileOrders, ORDER_LIMITS, type OrderInput, type OrderRow } from "./orders.js";
import { cfg } from "./config.js";
import { curatedSubjects } from "./subjects.js";
import { capabilities, PASSPORT_VERSIONS } from "./capabilities.js";
import { fundsSnapshot, type FundsRole } from "./funds.js";
import { runRecovery, runCostStatement, assembleFromArtifacts } from "./passport.js";
import { sealJson, openJson } from "./payments.js";
import { type Db, row, rows, run, now } from "./db.js";

export const FIXTURES: Record<Fixture, { title: string; headline: string; expected: string; proxy: "MAIN" | "CHANGED"; blurb: string }> = {
  CHANGED_IMPLEMENTATION: { title: "Unapproved implementation change", headline: "REVIEW_REQUIRED", expected: "REVIEW_REQUIRED", proxy: "CHANGED",
    blurb: "The merchant proxy was approved on implementation A and later upgraded to B: same ABI, same calldata, same price, the payment would still succeed. The pinned report resolves B, the approval pins A, and the controlled signer refuses until a human approves B. No business transaction is signed or broadcast." },
  AMOUNT_UNIT_MISMATCH: { title: "6-decimal amount on the 18-decimal path", headline: "BLOCKED", expected: "BLOCKED", proxy: "MAIN",
    blurb: "USDC is Arc's gas: one balance, two interfaces (native 18 dec, ERC-20 6 dec). The order is for 0.05 USDC but the transaction sets native value to 50000 instead of 50000000000000000. AMOUNT_SEMANTICS explains why the amount violates the approved order; in this fixture the merchant contract would also reject it. No business transaction is signed or broadcast." },
  APPROVED_PAYMENT: { title: "Approved payment, exact plan, verified outcome", headline: "CONFIRMED", expected: "NO_POLICY_VIOLATION", proxy: "MAIN",
    blurb: "Baseline matches, order is payable, simulation passes. The runner re-validates at a new block after the fee is confirmed, verifies its own account path, signs exactly the validated plan, persists it, broadcasts, and proves the order reads as paid." },
};

const chain: Chain = cfg.net === "mainnet" ? arc : arcTestnet;
const publicClient: PublicClient = createPublicClient({ chain, transport: http(cfg.rpc, { timeout: 20_000 }) });
function keyFromFile(role: string): Hex | null {
  const f = resolve(process.env.KEYS_DIR ?? resolve(cfg.root, "keys"), `${role}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).privateKey : null;
}
// Order creation is signed by the narrowly scoped order-creator key when present; the deployer-admin (owner: upgrade, pause,
// withdraw) key is only a legacy fallback and should not live in the public API process (review §5).
const creatorPk = (process.env.ORDER_CREATOR_PRIVATE_KEY as Hex | undefined) ?? keyFromFile("order-creator");
const adminPk = creatorPk ? null : (process.env.DEPLOYER_ADMIN_PRIVATE_KEY as Hex | undefined) ?? keyFromFile("deployer-admin");
const runnerPk = (process.env.DEMO_RUNNER_PRIVATE_KEY as Hex | undefined) ?? keyFromFile("demo-runner");
export const orderSignerRole: "order-creator" | "deployer-admin" | null = creatorPk ? "order-creator" : adminPk ? "deployer-admin" : null;
const orderSignerAcct: PrivateKeyAccount | null = creatorPk ? privateKeyToAccount(creatorPk) : adminPk ? privateKeyToAccount(adminPk) : null;
const runnerAcct: PrivateKeyAccount | null = runnerPk ? privateKeyToAccount(runnerPk) : null;
const orderWallet: WalletClient<Transport, Chain, Account> | null = orderSignerAcct ? createWalletClient({ account: orderSignerAcct, chain, transport: http(cfg.rpc, { timeout: 20_000 }) }) : null;
if (orderSignerRole === "deployer-admin") console.warn(now(), "WARNING: the deployer-admin (owner) key is loaded by the API process because no order-creator key is configured");

export const demoBudget = {
  maxRunsPerDay: Number(process.env.DEMO_MAX_RUNS_PER_DAY ?? 40),
  clientCooldownSeconds: Number(process.env.DEMO_CLIENT_COOLDOWN_SECONDS ?? 45),
  runnerFloorNativeAtomic: BigInt(process.env.DEMO_RUNNER_FLOOR_ATOMIC ?? "150000000000000000"), // 0.15 USDC keeps >=2 runs of headroom
  amountNativeAtomic: BigInt(process.env.DEMO_AMOUNT_ATOMIC ?? "50000000000000000"), // 0.05 USDC per business payment
  // Monetary caps per cost category and UTC day, reserved from CONFIGURED per-run amounts (not measured spend), separately from the run count.
  dailyBusinessCapAtomic: BigInt(process.env.DEMO_DAILY_BUSINESS_CAP_ATOMIC ?? "1000000000000000000"), // 1 USDC of business payments (spec §9.5)
  dailyFeeCapAtomic: BigInt(process.env.DEMO_DAILY_FEE_CAP_ATOMIC ?? "400000000000000000"), // 0.40 USDC of check fees (40 × 0.01)
  dailyGasCapAtomic: BigInt(process.env.DEMO_DAILY_GAS_CAP_ATOMIC ?? "500000000000000000"), // 0.50 USDC of gas ceilings
  gasCeilingPerOrderAtomic: 150_000n * 40_000_000_000n, // createOrder ≤ 150k gas at ≤ 40 gwei
  gasCeilingPerPayAtomic: 80_000n * 40_000_000_000n, // pay ≤ 80k gas at ≤ 40 gwei
};
const feePerRunNative = () => BigInt(cfg.priceTokenAtomic) * 10n ** 12n; // the 6-decimal check fee in 18-decimal native units
type Category = "business" | "fee" | "gas";
const capOf = (c: Category) => (c === "business" ? demoBudget.dailyBusinessCapAtomic : c === "fee" ? demoBudget.dailyFeeCapAtomic : demoBudget.dailyGasCapAtomic);
const reservedToday = (db: Db, day: string, c: Category): bigint => BigInt(row(db, "SELECT used_atomic FROM budget WHERE key = ?", `${c}:${day}`)?.used_atomic ?? "0");
/** Must be called inside the admission transaction: commits the reservation atomically before any external operation. */
function reserveSpend(db: Db, day: string, items: [Category, bigint][]): { ok: true } | { ok: false; category: Category; reserved: bigint; cap: bigint } {
  for (const [c, amount] of items) { const used = reservedToday(db, day, c); if (used + amount > capOf(c)) return { ok: false, category: c, reserved: used, cap: capOf(c) }; }
  for (const [c, amount] of items) {
    if (amount === 0n) continue;
    const used = reservedToday(db, day, c);
    run(db, "INSERT INTO budget (key, window_start, used_atomic) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET used_atomic = excluded.used_atomic", `${c}:${day}`, day, (used + amount).toString());
  }
  return { ok: true };
}

export function deployments(): any | null {
  const p = resolve(cfg.root, "fixtures", `deployments-${cfg.net}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
/** Approved baseline digests per proxy: the latest non-revoked baseline for that subject (CHANGED approves impl A, see scripts/demo/approve-baseline.ts). */
export function baselineDigestFor(db: Db, subject: string): Hex | null {
  const r = row(db, "SELECT baseline_digest FROM baselines WHERE subject = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1", subject.toLowerCase());
  return (r?.baseline_digest as Hex) ?? null;
}
export async function feeParams() {
  const f = await publicClient.estimateFeesPerGas();
  const floor = 20_000_000_000n;
  const maxFeePerGas = f.maxFeePerGas && f.maxFeePerGas > floor ? f.maxFeePerGas : floor + 1_000_000_000n;
  return { maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 1_000_000_000n };
}
const runnerToken = () => { for (const [t, p] of cfg.principals) if (p === "demo-runner") return t; return null; };
export const clientKey = (ip: string | undefined, ua: string | undefined) => createHash("sha256").update(`${ip ?? "?"}|${ua ?? "?"}`).digest("hex").slice(0, 16);

let active: string | null = null;
export const demoState = () => ({ activeRun: active });
// one order-creation key, possibly several callers (live runs + developer orders): serialise its transactions
let adminQueue: Promise<unknown> = Promise.resolve();
const adminLock = <T,>(fn: () => Promise<T>): Promise<T> => { const p = adminQueue.then(fn, fn); adminQueue = p.catch(() => {}); return p; };

let headCache: { at: number; head: string | null } = { at: 0, head: null };
/** the project keys the low-balance watch reads (public addresses; the keys themselves never leave their process) */
export function projectAccounts(): Partial<Record<FundsRole, string | null>> {
  const dep = deployments();
  return { "demo-runner": runnerAcct?.address ?? null, "order-creator": orderSignerRole === "order-creator" ? orderSignerAcct?.address ?? null : dep?.orderCreator ?? null, "merchant-payto": cfg.merchant?.address ?? null, "deployer-admin": dep?.deployer ?? null };
}
export async function networkInfo(db: Db) {
  if (Date.now() - headCache.at > 5000) { try { headCache = { at: Date.now(), head: (await publicClient.getBlockNumber()).toString() }; } catch { headCache = { at: Date.now(), head: null }; } }
  const dep = deployments();
  const fixtures = Object.entries(FIXTURES).map(([id, f]) => {
    const proxy = dep?.proxies?.[f.proxy];
    return { id, ...f, merchant: proxy?.address ?? null, implementation: f.proxy === "CHANGED" ? proxy?.currentImpl ?? null : dep?.implA?.address ?? null, approvedImplementation: dep?.implA?.address ?? null,
      upgradeTx: proxy?.upgradeTx ?? null, baselineDigest: proxy ? baselineDigestFor(db, proxy.address) : null };
  });
  const day = now().slice(0, 10);
  const used = row(db, "SELECT COUNT(*) AS c FROM demo_runs WHERE substr(created_at,1,10) = ? AND labels_json LIKE '%LIVE_REQUEST%'", day)?.c ?? 0;
  const unresolved = row(db, "SELECT COUNT(*) AS c FROM business_executions WHERE state = 'BROADCAST_ATTEMPTED'")?.c ?? 0;
  return { network: cfg.net, chainId: cfg.chainId, caip2: cfg.caip2, rpc: cfg.rpc, explorer: cfg.net === "mainnet" ? "https://explorer.arc.io" : "https://testnet.arcscan.app", head: headCache.head,
    usdc: cfg.usdc, profile: cfg.profile, release: cfg.releaseSha, priceTokenAtomic: cfg.priceTokenAtomic, supportedTargets: cfg.supportedTargets,
    quoteTtlSeconds: cfg.quoteTtlSeconds, reportTtlSeconds: cfg.reportTtlSeconds,
    accounts: { deployerAdmin: dep?.deployer ?? null, orderCreator: orderSignerRole === "order-creator" ? orderSignerAcct?.address ?? null : dep?.orderCreator ?? null, orderSignerRole, adminKeyInProcess: orderSignerRole === "deployer-admin", demoRunner: runnerAcct?.address ?? null, merchantPayTo: cfg.merchant?.address ?? null },
    deployments: dep ? { implA: dep.implA, implB: dep.implB, proxies: dep.proxies, deployedAtUTC: dep.deployedAtUTC, compiler: dep.compiler } : null,
    fixtures,
    budget: { maxRunsPerDay: demoBudget.maxRunsPerDay, usedToday: used, clientCooldownSeconds: demoBudget.clientCooldownSeconds, amountNativeAtomic: demoBudget.amountNativeAtomic.toString(), activeRun: active, unresolvedBusinessTransactions: unresolved,
      caps: { businessAtomic: demoBudget.dailyBusinessCapAtomic.toString(), feeAtomic: demoBudget.dailyFeeCapAtomic.toString(), gasAtomic: demoBudget.dailyGasCapAtomic.toString() },
      reservedToday: { business: reservedToday(db, day, "business").toString(), fee: reservedToday(db, day, "fee").toString(), gas: reservedToday(db, day, "gas").toString() },
      note: "caps are reservations computed from configured per-run amounts, committed before any external operation; they are not measured spend" },
    observableSubjects: curatedSubjects(),
    capabilities: capabilities(), passport: PASSPORT_VERSIONS,
    faucet: faucetInfo(db),
    funds: fundsSnapshot(),
    access: { selfService: true, session: "/v1/session", publicExecution: cfg.publicExecution, walletExecution: cfg.publicExecution && !!dep && !!orderWallet,
      note: cfg.publicExecution ? "any visitor: anonymous session, own orders, paid checks, wallet execution with after-the-fact plan comparison, recovery, private passports" : "business execution on this instance is gated until the operator records the mainnet acceptance (PUBLIC_EXECUTION); checks, orders, recovery and passports stay available" },
    orders: { minNativeAtomic: ORDER_LIMITS.minNativeAtomic.toString(), maxNativeAtomic: ORDER_LIMITS.maxNativeAtomic.toString(), stepNativeAtomic: ORDER_LIMITS.stepNativeAtomic.toString(), defaultNativeAtomic: ORDER_LIMITS.defaultNativeAtomic.toString(), maxReferenceLength: ORDER_LIMITS.maxReferenceLength },
    settlement: { backend: "relay", relayer: cfg.merchant?.address ?? null, feeAsset: "USDC", note: "the check fee is an EIP-3009 authorization relayed by the merchant account, which pays gas in USDC; the business payment is the agent's own transaction with its own gas" } };
}

export type StartResult = { ok: true; runId: string; existing?: boolean } | { ok: false; status: number; error: string; reason: string; sample?: string | null };

// ---- testnet faucet (design v3.2 P3 feedback): a visitor's wallet needs a little testnet USDC to pay the 0.01 check fee with its own
//      signature. Paid from the order-creator key under the same in-process lock as order creation (one sender per key); budgeted per
//      address, per client and per day; never on mainnet (the chain id is checked, not only the configured network name).
const FAUCET_TABLE = "CREATE TABLE IF NOT EXISTS faucet_claims (id TEXT PRIMARY KEY, address TEXT NOT NULL, client_key TEXT NOT NULL, amount_atomic TEXT NOT NULL, tx_hash TEXT, created_at TEXT NOT NULL)";
export const faucetEnabled = () => cfg.net === "testnet" && cfg.chainId === 5042002 && cfg.faucet.enabled && !!orderWallet;
export function faucetInfo(db: Db) {
  if (!faucetEnabled()) return { enabled: false as const, note: "testnet only" };
  db.exec(FAUCET_TABLE);
  const day = now().slice(0, 10);
  const used = row(db, "SELECT COUNT(*) AS c FROM faucet_claims WHERE substr(created_at,1,10) = ?", day)?.c ?? 0;
  return { enabled: true as const, amountNativeAtomic: cfg.faucet.amountNativeAtomic.toString(), perDay: cfg.faucet.perDay, usedToday: used, perAddressPer24h: 1, sender: orderSignerAcct?.address ?? null, note: "project testnet funds; one claim per wallet and per client every 24 h; nothing on mainnet" };
}
export type FaucetResult = { ok: true; txHash: Hex; amountNativeAtomic: string; address: Hex } | { ok: false; status: number; error: string; reason: string };
export async function claimFaucet(db: Db, address: Hex, client: string): Promise<FaucetResult> {
  if (!faucetEnabled() || !orderWallet) return { ok: false, status: 404, error: "FAUCET_DISABLED", reason: "the faucet exists on Arc testnet only" };
  db.exec(FAUCET_TABLE);
  const id = randomUUID(); const amount = cfg.faucet.amountNativeAtomic;
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString(); const day = now().slice(0, 10);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (row(db, "SELECT 1 FROM faucet_claims WHERE address = ? AND created_at > ? LIMIT 1", address.toLowerCase(), cutoff)) { db.exec("COMMIT"); return { ok: false, status: 429, error: "FAUCET_COOLDOWN", reason: "this wallet already claimed testnet USDC in the last 24 hours" }; }
    if (row(db, "SELECT 1 FROM faucet_claims WHERE client_key = ? AND created_at > ? LIMIT 1", client, cutoff)) { db.exec("COMMIT"); return { ok: false, status: 429, error: "FAUCET_COOLDOWN", reason: "one claim per client every 24 hours" }; }
    const used = row(db, "SELECT COUNT(*) AS c FROM faucet_claims WHERE substr(created_at,1,10) = ?", day)?.c ?? 0;
    if (used >= cfg.faucet.perDay) { db.exec("COMMIT"); return { ok: false, status: 429, error: "FAUCET_BUDGET_EXHAUSTED", reason: `the faucet's daily budget (${cfg.faucet.perDay} claims) is used; try again tomorrow` }; }
    run(db, "INSERT INTO faucet_claims (id, address, client_key, amount_atomic, created_at) VALUES (?,?,?,?,?)", id, address.toLowerCase(), client, amount.toString(), now()); // the reservation is kept even if the send fails: no retry storm
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  try {
    const bal = await publicClient.getBalance({ address: orderWallet.account.address });
    if (bal < amount + cfg.faucet.floorNativeAtomic) return { ok: false, status: 503, error: "FAUCET_EMPTY", reason: "the faucet key is below its floor; it is topped up by hand" };
    const txHash = await adminLock(async () => orderWallet!.sendTransaction({ to: address, value: amount, ...(await feeParams()) } as any));
    const rc = await publicClient.waitForTransactionReceipt({ hash: txHash });
    run(db, "UPDATE faucet_claims SET tx_hash = ? WHERE id = ?", txHash, id);
    if (rc.status !== "success") return { ok: false, status: 503, error: "FAUCET_FAILED", reason: `the faucet transaction reverted (${txHash})` };
    return { ok: true, txHash, amountNativeAtomic: amount.toString(), address };
  } catch (e: any) { return { ok: false, status: 503, error: "FAUCET_FAILED", reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) }; }
}

/** Durable store for the runner's signed business transaction (spec D07). The raw bytes are encrypted at rest like the payment outbox. */
function executionStore(db: Db, runId: string): ExecutionStore {
  return {
    persistSigned: async (e) => {
      run(db, "INSERT INTO business_executions (attempt_id, run_id, fixture, order_id, merchant, payer, amount_atomic, intent_digest, report_digest, decision_digest, baseline_digest, policy_digest, final_validation_digest, plan_digest, tx_hash, nonce, raw_tx_encrypted, valid_until, labels_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        e.attemptId, runId, e.fixture, e.orderId.toLowerCase(), e.merchant.toLowerCase(), e.payer.toLowerCase(), e.amountNativeAtomic, e.intentDigest, e.reportDigest, e.decisionDigest, e.baselineDigest, e.policyDigest, e.finalValidationDigest, e.transactionPlanDigest, e.txHash.toLowerCase(), e.nonce, await sealJson({ raw: e.raw }), e.validUntil, JSON.stringify(e.labels), "SIGNED", now(), now());
    },
    markBroadcastAttempted: (attemptId, info) => { run(db, "UPDATE business_executions SET state = 'BROADCAST_ATTEMPTED', broadcast_block = ?, updated_at = ? WHERE attempt_id = ? AND state = 'SIGNED'", info?.headBlock ?? null, now(), attemptId); },
    persistOutcome: (attemptId, o) => {
      const state = o.chainStatus === "CONFIRMED" || o.chainStatus === "REVERTED" ? o.chainStatus : o.chainStatus === "SIGNED_NOT_BROADCAST" ? "NOT_BROADCAST" : "BROADCAST_ATTEMPTED";
      run(db, "UPDATE business_executions SET state = ?, business_status = ?, business_tx_hash = ?, block = ?, postcondition_json = ?, note = ?, updated_at = ? WHERE attempt_id = ?",
        state, o.businessStatus, o.businessTxHash?.toLowerCase() ?? null, o.block ?? null, o.postcondition ? JSON.stringify(o.postcondition) : null, o.note ?? null, now(), attemptId);
    },
  };
}

const boundRun = (db: Db, key: string | null) => (key ? row(db, "SELECT run_id, fixture FROM demo_run_admissions WHERE client_run_request_id = ?", key) : undefined);
const boundResult = (bound: any, fixture: Fixture): StartResult => bound.fixture === fixture ? { ok: true, runId: bound.run_id, existing: true } : { ok: false, status: 409, error: "RUN_CONFLICT", reason: "clientRunRequestId is already bound to a different scenario" };
export type RunOpts = { interruptAfterBroadcast?: boolean };
export async function startRun(db: Db, fixture: Fixture, client: string, clientRunRequestId: string | null = null, runOpts: RunOpts = {}): Promise<StartResult> {
  if (!Object.hasOwn(FIXTURES, fixture)) return { ok: false, status: 400, error: "INVALID_INPUT", reason: "unknown fixture" };
  // Admission identity (design v3.2 §10.1): the same key returns the run it already admitted. A lost response is never permission
  // to start a second purchase; the same key with another scenario is a conflict.
  const bound = boundRun(db, clientRunRequestId);
  if (bound) return boundResult(bound, fixture);
  const dep = deployments();
  if (!dep || !orderWallet || !runnerAcct) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "fixtures not deployed on this network", sample: latestSample(db, fixture) };
  const token = runnerToken();
  if (!token) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "runner principal not configured", sample: latestSample(db, fixture) };
  const proxy = dep.proxies[FIXTURES[fixture].proxy];
  const baselineDigest = baselineDigestFor(db, proxy.address);
  if (!baselineDigest) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "no approved baseline for the fixture proxy", sample: latestSample(db, fixture) };
  // An earlier business transaction that may still be minable must be resolved before another one is signed with the same key.
  if (row(db, "SELECT 1 FROM business_executions WHERE state = 'BROADCAST_ATTEMPTED' LIMIT 1")) await reconcileExecutions(db, () => {}, { allowSend: true }).catch(() => {});
  const openTx = row(db, "SELECT attempt_id, valid_until FROM business_executions WHERE state = 'BROADCAST_ATTEMPTED' ORDER BY created_at LIMIT 1");
  if (openTx && new Date(openTx.valid_until) > new Date()) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "a previous business transaction is unresolved and still within its validation window; reconciliation pending", sample: latestSample(db, fixture) };
  const runId = randomUUID();
  // schema labels: LIVE_REQUEST always; DEMO_ON_MAINNET only on 5042 (the network itself is recorded in the result)
  const labels = cfg.net === "mainnet" ? ["LIVE_REQUEST", "DEMO_ON_MAINNET"] : ["LIVE_REQUEST"];
  // Admission: the execution slot, cooldown, run count and the per-category monetary reservations are committed in ONE transaction
  // before any external operation. Failed or interrupted attempts keep their reservations, so a retry cannot spend twice.
  db.exec("BEGIN IMMEDIATE");
  try {
    const raced = boundRun(db, clientRunRequestId); // re-checked under the write lock: two concurrent retries admit exactly one run
    if (raced) { db.exec("COMMIT"); return boundResult(raced, fixture); }
    const running = row(db, "SELECT run_id FROM demo_runs WHERE state = 'RUNNING' LIMIT 1");
    const day = now().slice(0, 10);
    const used = row(db, "SELECT COUNT(*) AS c FROM demo_runs WHERE substr(created_at,1,10) = ? AND labels_json LIKE '%LIVE_REQUEST%'", day)?.c ?? 0;
    const last = row(db, "SELECT created_at FROM demo_runs WHERE client_key = ? ORDER BY created_at DESC LIMIT 1", client);
    let denied: StartResult | null = null;
    if (active || running) denied = { ok: false, status: 429, error: "DEMO_BUSY", reason: "another run is in progress; wait for it to finish", sample: latestSample(db, fixture) };
    else if (used >= demoBudget.maxRunsPerDay) denied = { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: `daily live-run budget (${demoBudget.maxRunsPerDay}) used; recorded samples remain available`, sample: latestSample(db, fixture) };
    else if (last && Date.now() - new Date(last.created_at).getTime() < demoBudget.clientCooldownSeconds * 1000) denied = { ok: false, status: 429, error: "DEMO_COOLDOWN", reason: `one live run per ${demoBudget.clientCooldownSeconds}s per client`, sample: latestSample(db, fixture) };
    if (!denied) {
      const pays = fixture === "APPROVED_PAYMENT";
      const reserved = reserveSpend(db, day, [["business", pays ? demoBudget.amountNativeAtomic : 0n], ["fee", feePerRunNative()], ["gas", demoBudget.gasCeilingPerOrderAtomic + (pays ? demoBudget.gasCeilingPerPayAtomic : 0n)]]);
      if (!reserved.ok) denied = { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: `daily ${reserved.category} cap reached (${reserved.reserved} of ${reserved.cap} native units reserved); recorded samples remain available`, sample: latestSample(db, fixture) };
    }
    if (denied) { db.exec("COMMIT"); return denied; }
    run(db, "INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)", runId, fixture, "RUNNING", "[]", JSON.stringify(labels), now(), now(), client, null);
    if (clientRunRequestId) run(db, "INSERT INTO demo_run_admissions (client_run_request_id, run_id, fixture, client_key, created_at) VALUES (?,?,?,?,?)", clientRunRequestId, runId, fixture, client, now());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  active = runId;
  const steps: Step[] = [];
  const persist = () => run(db, "UPDATE demo_runs SET steps_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(steps), now(), runId);
  // v3.3: every artefact is durable as soon as it exists, so a run that stops after the broadcast still exports a complete passport
  const artifacts: Record<string, unknown> = {};
  const persistArtifact = (name: ArtifactName, value: unknown) => { artifacts[name] = value; run(db, "UPDATE demo_runs SET artifacts_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(artifacts), now(), runId); };
  try {
    const bal = await publicClient.getBalance({ address: runnerAcct.address });
    if (bal < demoBudget.runnerFloorNativeAtomic + demoBudget.amountNativeAtomic) throw new Error("runner balance below the configured floor; live runs paused");
  } catch (e: any) {
    const reason = String(e?.message ?? e).slice(0, 200);
    run(db, "UPDATE demo_runs SET state = 'FAILED', steps_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify([{ step: "error", atMs: 0, error: reason }]), now(), runId);
    if (active === runId) active = null;
    return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason, sample: latestSample(db, fixture) };
  }
  (async () => {
    try {
      const out = await runFixture({ fixture, net: cfg.net, chain, publicClient, admin: orderWallet, runner: runnerAcct, merchant: getAddress(proxy.address) as Hex, baselineDigest,
        apiUrl: `http://127.0.0.1:${cfg.port}`, token, amountNativeAtomic: demoBudget.amountNativeAtomic, feeParams, labels: labels as any, adminLock, orderSignerLabel: orderSignerRole ?? "order creator",
        executionStore: executionStore(db, runId), onStep: (s) => { steps.push(s); persist(); }, onArtifact: persistArtifact,
        orderStore: runnerOrderStore(db, runId, client, FIXTURES[fixture].proxy), interruptAfterBroadcast: !!runOpts.interruptAfterBroadcast && fixture === "APPROVED_PAYMENT" });
      const unresolved = out.execution?.chainStatus === "UNKNOWN" || out.execution?.businessStatus === "UNKNOWN";
      run(db, "UPDATE demo_runs SET state = ?, steps_json = ?, result_json = ?, updated_at = ? WHERE run_id = ?", unresolved ? "RECONCILE_REQUIRED" : "DONE", JSON.stringify(steps), JSON.stringify({ ...out, executionMode: "runner" }), now(), runId);
    } catch (e: any) {
      steps.push({ step: "error", atMs: -1, error: String(e?.message ?? e).slice(0, 400) });
      // an order whose creation was planned or sent but never confirmed is left to order reconciliation (chain state decides); never replaced here
      const planned = row(db, "SELECT order_id FROM orders WHERE run_id = ? AND state IN ('PLANNED','SENT')", runId);
      if (planned && /createOrder failed/.test(String(e?.message ?? e))) orderFailed(db, planned.order_id as Hex, "FAILED", "the creation transaction reverted");
      // if a broadcast was attempted, the transaction may be on the network: never record a business failure before reconciliation
      const attempted = row(db, "SELECT 1 FROM business_executions WHERE run_id = ? AND state = 'BROADCAST_ATTEMPTED'", runId);
      run(db, "UPDATE demo_runs SET state = ?, steps_json = ?, updated_at = ? WHERE run_id = ?", attempted ? "RECONCILE_REQUIRED" : "FAILED", JSON.stringify(steps), now(), runId);
      console.error(now(), attempted ? "DEMO_RUN_UNRESOLVED" : "DEMO_RUN_FAILED", runId, fixture, String(e?.message ?? e));
    } finally { if (active === runId) active = null; }
  })();
  return { ok: true, runId };
}

/** Writes the reconciled outcome into the run: patches the stored result (or reconstructs a minimal one after a crash) and re-digests the receipt. */
function finalizeRun(db: Db, x: any, o: ExecutionOutcome, runState: "DONE" | "FAILED" = "DONE", consumedBy: Hex | null = null) {
  const r = row(db, "SELECT * FROM demo_runs WHERE run_id = ?", x.run_id);
  if (!r) return;
  const stepsNow: Step[] = JSON.parse(r.steps_json);
  const result = r.result_json ? JSON.parse(r.result_json) : assembleFromArtifacts(r.artifacts_json ? JSON.parse(r.artifacts_json) : {}, stepsNow, { fixture: x.fixture, orderId: x.order_id, merchant: x.merchant });
  const exec = result?.execution ?? { schemaVersion: "1.0", executionAttemptId: x.attempt_id, intentDigest: x.intent_digest, reportDigest: x.report_digest, decisionDigest: x.decision_digest, baselineDigest: x.baseline_digest, policyDigest: x.policy_digest,
    finalValidationDigest: x.final_validation_digest, transactionPlanDigest: x.plan_digest, signedTransactionHash: x.tx_hash, businessTxHash: null, chainStatus: "UNKNOWN", businessStatus: "UNKNOWN", postconditionEvidenceDigests: [], labels: JSON.parse(x.labels_json), recordedAt: now() };
  exec.chainStatus = o.chainStatus; exec.businessStatus = o.businessStatus; exec.businessTxHash = o.businessTxHash; exec.recordedAt = now();
  if (o.postcondition) exec.postconditionEvidenceDigests = [postconditionDigest(o.postcondition)];
  const parsed = ExecutionReceipt.parse(exec);
  const history: unknown[] = Array.isArray(result?.reconciliation) ? result.reconciliation : result?.reconciliation ? [result.reconciliation] : [];
  const entry = { at: now(), chainStatus: o.chainStatus, businessStatus: o.businessStatus, note: o.note ?? null, consumedBy };
  const merged = { ...(result ?? { fixture: x.fixture, network: cfg.net, chainId: cfg.chainId, attemptId: x.attempt_id, orderId: x.order_id, merchant: x.merchant, intentDigest: x.intent_digest, reportDigest: x.report_digest, decisionDigest: x.decision_digest, serviceFeeTx: null, reconstructedAfterCrash: true }),
    execution: parsed, executionDigest: executionDigest(parsed), postcondition: o.postcondition ?? result?.postcondition ?? null, reconciliation: [...history, entry],
    // the receipt the outcome rests on: its gas feeds the cost statement, so the page and the passport show the same total (review round 2)
    businessReceipt: o.receiptFacts ? { from: o.receiptFacts.from, gasUsed: o.receiptFacts.gasUsed, effectiveGasPriceNativeAtomic: o.receiptFacts.effectiveGasPriceNativeAtomic, blockNumber: o.receiptFacts.blockNumber, status: o.receiptFacts.status } : (result?.businessReceipt ?? null) };
  const steps = JSON.parse(r.steps_json);
  steps.push({ step: "reconciled", atMs: -1, chainStatus: o.chainStatus, businessStatus: o.businessStatus, businessTxHash: o.businessTxHash, consumedBy, why: o.note ?? "outcome established from the original transaction context" });
  run(db, "UPDATE demo_runs SET state = ?, steps_json = ?, result_json = ?, updated_at = ? WHERE run_id = ?", runState, JSON.stringify(steps), JSON.stringify(merged), now(), x.run_id);
}
function appendStep(db: Db, runId: string, step: Step) {
  const r = row(db, "SELECT steps_json FROM demo_runs WHERE run_id = ?", runId); if (!r) return;
  const steps = JSON.parse(r.steps_json); steps.push(step);
  run(db, "UPDATE demo_runs SET steps_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(steps), now(), runId);
}
/** Spec D07: resolve business transactions whose broadcast was attempted, from their original context (the shared reconciler in
 *  @arcpreflight/runner). Never signs a replacement, never creates an order or buys a check. `allowSend: false` is the observer mode
 *  of read routes: it may record facts read from the chain but never sends anything; only the start-up pass, the recovery worker,
 *  the pre-run gate (POST) and an authorized recovery command run with `allowSend: true`. Safe to call repeatedly. */
export type ReconcileOpts = { allowSend: boolean; runId?: string | null };
export async function reconcileExecutions(db: Db, log: (m: string) => void = () => {}, opts: ReconcileOpts = { allowSend: true }): Promise<{ resolved: number; pending: number }> {
  const open = opts.runId ? rows(db, "SELECT * FROM business_executions WHERE state IN ('SIGNED','BROADCAST_ATTEMPTED') AND run_id = ? ORDER BY created_at", opts.runId)
    : rows(db, "SELECT * FROM business_executions WHERE state IN ('SIGNED','BROADCAST_ATTEMPTED') ORDER BY created_at");
  let resolved = 0, pending = 0;
  // Crash window (review round 2): the store recorded a closed outcome but the process stopped before the run was finalised. The
  // run is closed from the store — the store is the fact; the run record and the passport must not disagree with it.
  const stranded = opts.runId ? rows(db, "SELECT x.* FROM business_executions x JOIN demo_runs r ON r.run_id = x.run_id WHERE r.state = 'RECONCILE_REQUIRED' AND x.state IN ('CONFIRMED','REVERTED','NOT_MINED','SUPERSEDED') AND x.run_id = ? AND x.run_id != COALESCE(?, '')", opts.runId, active)
    : rows(db, "SELECT x.* FROM business_executions x JOIN demo_runs r ON r.run_id = x.run_id WHERE r.state = 'RECONCILE_REQUIRED' AND x.state IN ('CONFIRMED','REVERTED','NOT_MINED','SUPERSEDED') AND x.run_id != COALESCE(?, '')", active);
  for (const x of stranded) {
    const outcome: ExecutionOutcome = { chainStatus: x.state === "CONFIRMED" ? "CONFIRMED" : x.state === "REVERTED" ? "REVERTED" : "UNKNOWN", businessStatus: (x.business_status ?? "UNKNOWN") as ExecutionOutcome["businessStatus"], businessTxHash: (x.business_tx_hash as Hex | null) ?? null, block: x.block ?? null, postcondition: x.postcondition_json ? JSON.parse(x.postcondition_json) : undefined, note: `${x.note ?? "outcome recorded by the store"} (run closed from the store after an interruption)` };
    finalizeRun(db, x, outcome, "DONE", (x.consumed_by as Hex | null) ?? null); resolved++; log(`${x.attempt_id}: run closed from the stored ${x.state} outcome`);
  }
  for (const x of open) {
    if (x.run_id === active) { pending++; continue; } // the owning run is still in progress in this process
    try {
      const stored: StoredExecution = { attemptId: x.attempt_id, state: x.state, txHash: x.tx_hash as Hex, nonce: Number(x.nonce), payer: x.payer as Hex, merchant: x.merchant as Hex, orderId: x.order_id as Hex, amountNativeAtomic: x.amount_atomic,
        validUntil: x.valid_until, broadcastBlock: x.broadcast_block ?? null, openRaw: async () => (await openJson(x.raw_tx_encrypted)).raw as Hex };
      const r = await reconcileExecution(reconcileRpcFromClient(publicClient), stored, { allowSend: opts.allowSend });
      if (r.kind === "closed") {
        run(db, "UPDATE business_executions SET state = ?, business_status = ?, business_tx_hash = ?, block = ?, postcondition_json = ?, note = ?, consumed_by = ?, updated_at = ? WHERE attempt_id = ?",
          r.storeState, r.outcome.businessStatus, r.outcome.businessTxHash?.toLowerCase() ?? null, r.outcome.block ?? null, r.outcome.postcondition ? JSON.stringify(r.outcome.postcondition) : null, r.outcome.note ?? null, r.consumedBy?.toLowerCase() ?? null, now(), x.attempt_id);
        finalizeRun(db, x, r.outcome, r.storeState === "INTERRUPTED" ? "FAILED" : "DONE", r.consumedBy);
        resolved++; log(`${x.attempt_id}: ${r.storeState} (${r.outcome.chainStatus}/${r.outcome.businessStatus})`); continue;
      }
      run(db, "UPDATE business_executions SET note = ?, updated_at = ? WHERE attempt_id = ?", r.reason, now(), x.attempt_id);
      if (r.rebroadcast) appendStep(db, x.run_id, { step: "rebroadcast", atMs: -1, businessTxHash: x.tx_hash, why: "the identical signed bytes were handed to the node again inside the validation window by the recovery worker: same hash, no replacement, no new signature" });
      pending++; log(`${x.attempt_id}: ${r.reason}`);
    } catch (e: any) { pending++; log(`${x.attempt_id}: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  return { resolved, pending };
}
/** Read-route variant: refreshes informational state from chain facts, never broadcasts (design v3.2 §10.2). */
export const observeExecutions = (db: Db, runId?: string | null) => reconcileExecutions(db, () => {}, { allowSend: false, runId: runId ?? null });
/** Authorized recovery command: the session that admitted the run (it holds the clientRunRequestId) asks for a bounded, act-mode
 *  reconciliation of THAT attempt only. Nothing else can be changed through it; a wrong key reads like a missing run. */
export async function recoverRun(db: Db, runId: string, clientRunRequestId: string, log: (m: string) => void = () => {}) {
  const adm = row(db, "SELECT run_id FROM demo_run_admissions WHERE client_run_request_id = ? AND run_id = ?", clientRunRequestId, runId);
  if (!adm) return null;
  await reconcileExecutions(db, log, { allowSend: true, runId });
  return getRun(db, runId);
}

export function getRun(db: Db, runId: string) {
  const r = row(db, "SELECT * FROM demo_runs WHERE run_id = ?", runId);
  if (!r) return null;
  return shapeRun(db, r);
}
/** The business transaction as the durable store knows it: the headline of a run follows THIS state, never the last step log (AP33-06). */
export function businessExecutionOf(db: Db, runId: string) {
  const x = row(db, "SELECT attempt_id, state, tx_hash, nonce, broadcast_block, business_status, business_tx_hash, block, consumed_by, note, valid_until, updated_at FROM business_executions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
  return x ? { attemptId: x.attempt_id, state: x.state, txHash: x.tx_hash, nonce: Number(x.nonce), broadcastBlock: x.broadcast_block ?? null, businessStatus: x.business_status ?? null, businessTxHash: x.business_tx_hash ?? null, block: x.block ?? null, consumedBy: x.consumed_by ?? null, note: x.note ?? null, validUntil: x.valid_until, updatedAt: x.updated_at } : null;
}
export type RunOutcome = { kind: "RUNNING" | "PAID" | "BROADCAST_UNRESOLVED" | "SIGNED_NOT_BROADCAST" | "NOT_MINED" | "SUPERSEDED" | "REVERTED" | "CONFIRMED_UNPAID" | "REVIEW_REQUIRED" | "BLOCKED" | "NOT_SIGNED" | "FAILED"; text: string; source: "store" | "decision" | "state" };
export function runOutcome(state: string, result: any, be: ReturnType<typeof businessExecutionOf>): RunOutcome {
  if (be) {
    switch (be.state) {
      case "BROADCAST_ATTEMPTED": return { kind: "BROADCAST_UNRESOLVED", text: "a broadcast was attempted; the outcome is not yet established — reconciliation works from the recorded hash and the order state", source: "store" };
      case "SIGNED": return { kind: "SIGNED_NOT_BROADCAST", text: "signed, not yet broadcast", source: "store" };
      case "INTERRUPTED": case "NOT_BROADCAST": return { kind: "SIGNED_NOT_BROADCAST", text: "signed but never broadcast: nothing reached the network; the order stays unpaid", source: "store" };
      case "CONFIRMED": return be.businessStatus === "SUCCESS" ? { kind: "PAID", text: "confirmed: the order reads as paid by this payer for the exact amount", source: "store" } : { kind: "CONFIRMED_UNPAID", text: "the transaction confirmed but the order does not read as paid for this payer and amount", source: "store" };
      case "REVERTED": return { kind: "REVERTED", text: "the transaction reverted; the order stays unpaid", source: "store" };
      case "NOT_MINED": return { kind: "NOT_MINED", text: "the original hash can never be mined (its nonce was consumed by something else); the order reads as unpaid; nothing was re-signed", source: "store" };
      case "SUPERSEDED": return { kind: "SUPERSEDED", text: `the order was paid by a same-nonce replacement${be.consumedBy ? ` (${be.consumedBy})` : ""}; nothing was re-signed by this runner`, source: "store" };
    }
  }
  if (state === "RUNNING") return { kind: "RUNNING", text: "running", source: "state" };
  const d = result?.decision?.decision;
  if (d === "BLOCKED") return { kind: "BLOCKED", text: "blocked: a hard violation; no business transaction was signed", source: "decision" };
  if (d === "REVIEW_REQUIRED") return { kind: "REVIEW_REQUIRED", text: "review required: no business transaction was signed", source: "decision" };
  if (d === "NO_POLICY_VIOLATION" && result?.finalValidation && result.finalValidation.result !== "PASS") return { kind: "NOT_SIGNED", text: "final validation did not pass; no business transaction was signed", source: "decision" };
  if (state === "FAILED") return { kind: "FAILED", text: "the run stopped before any business transaction was signed; nothing reached the network", source: "state" };
  return { kind: "NOT_SIGNED", text: "no business transaction was signed", source: "state" };
}
/** The run as the API serves it: the stored record plus the recovery summary and cost statement computed by the passport package
 *  (the same functions that write recovery.json and cost-statement.json), so the screen and the exported passport cannot disagree.
 *  A run that stopped before its result was written is served from its persisted artefacts (`partial: true`). */
function shapeRun(db: Db, r: any) {
  const steps: Step[] = JSON.parse(r.steps_json);
  const artifacts = r.artifacts_json ? JSON.parse(r.artifacts_json) : {};
  const stored = r.result_json ? JSON.parse(r.result_json) : null;
  const result = stored ?? assembleFromArtifacts(artifacts, steps, { fixture: r.fixture });
  const be = businessExecutionOf(db, r.run_id);
  const orderRow = row<OrderRow>(db, "SELECT * FROM orders WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", r.run_id);
  return { runId: r.run_id, fixture: r.fixture, state: r.state, executionMode: "runner" as const, labels: JSON.parse(r.labels_json), steps, createdAt: r.created_at, updatedAt: r.updated_at,
    expected: FIXTURES[r.fixture as Fixture]?.expected ?? null, headline: FIXTURES[r.fixture as Fixture]?.headline ?? null,
    outcome: runOutcome(r.state, result, be), businessExecution: be, partial: !stored && !!result,
    order: orderRow ? { orderId: orderRow.order_id, state: orderRow.state, tx: orderRow.tx_hash, block: orderRow.block, payer: orderRow.payer, merchant: orderRow.merchant, amountNativeAtomic: orderRow.amount_atomic, reference: orderRow.reference, paid: orderRow.paid === null ? null : orderRow.paid === 1 } : null,
    result: result ? { ...result, costStatement: runCostStatement(result) } : null, recovery: runRecovery(result, steps), artifactsPresent: Object.keys(artifacts) };
}
/** A passport can be exported once the workflow finished or stopped with a complete record (same rule as buildRunPassport). */
export const passportAvailable = (state: string, res: any): boolean => state !== "RUNNING" && !!(res?.intent && res?.report && res?.decision && res?.execution);
export function listRuns(db: Db, limit = 20, offset = 0) {
  const total = row(db, "SELECT COUNT(*) AS c FROM demo_runs")?.c ?? 0;
  const runs = rows(db, "SELECT run_id, fixture, state, labels_json, created_at, updated_at, result_json, artifacts_json, steps_json FROM demo_runs ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset).map((r: any) => {
    const res = r.result_json ? JSON.parse(r.result_json) : assembleFromArtifacts(r.artifacts_json ? JSON.parse(r.artifacts_json) : {}, JSON.parse(r.steps_json ?? "[]"), { fixture: r.fixture });
    const paid = res?.execution?.businessStatus === "SUCCESS";
    const be = businessExecutionOf(db, r.run_id);
    return { runId: r.run_id, fixture: r.fixture, state: r.state, executionMode: "runner", labels: JSON.parse(r.labels_json), createdAt: r.created_at, updatedAt: r.updated_at, businessExecutionState: be?.state ?? null, outcome: runOutcome(r.state, res, be).kind,
      network: res?.network ?? cfg.net, chainId: res?.chainId ?? cfg.chainId, attemptId: res?.attemptId ?? null, orderId: res?.orderId ?? null,
      decision: res?.decision?.decision ?? null, businessTxHash: res?.execution?.businessTxHash ?? null, businessStatus: res?.execution?.businessStatus ?? null, chainStatus: res?.execution?.chainStatus ?? null, serviceFeeTx: res?.serviceFeeTx ?? null, durationMs: res?.durationMs ?? null,
      // money, as recorded: the settled check fee (6-dec token units) and the business principal that actually moved (18-dec native units)
      feeTokenAtomic: res?.serviceFeeTx ? String(res?.quote?.amountTokenAtomic ?? cfg.priceTokenAtomic) : null,
      orderAmountNativeAtomic: res?.intent?.businessExpectation?.amountNativeAtomic ?? null, businessPaidNativeAtomic: paid ? (res?.intent?.businessExpectation?.amountNativeAtomic ?? null) : "0",
      passportAvailable: passportAvailable(r.state, res) };
  });
  return { runs, total, limit, offset };
}
export function latestSample(db: Db, fixture: Fixture): string | null {
  return row(db, "SELECT run_id FROM demo_runs WHERE fixture = ? AND state = 'DONE' ORDER BY created_at DESC LIMIT 1", fixture)?.run_id ?? null;
}

/** Developer path (design v3.3 §2): create an order for a visitor's wallet on the MAIN or CHANGED proxy with the visitor's amount
 *  and reference. The order's identity is durable (PLANNED) before the creation transaction is sent; SENT right after the send;
 *  CONFIRMED after the receipt. A failure in between leaves a row that order reconciliation resolves from the chain. */
export type CreatedOrder = { ok: true; orderId: Hex; tx: Hex; block: string; merchant: Hex; proxy: "MAIN" | "CHANGED"; payer: Hex; amountNativeAtomic: string; reference: string | null; baselineDigest: Hex | null; state: "CONFIRMED"; owner: string | null };
export async function createOrderFor(db: Db, input: OrderInput & { owner: string | null; client: string }): Promise<CreatedOrder | StartResult> {
  const dep = deployments(); const which = input.proxy;
  if (!dep || !orderWallet || !dep.proxies?.[which]) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "fixtures not deployed on this network" };
  // Persist admissions (count, cooldown and the gas reservation) before queuing the management transaction. A failed RPC/receipt
  // must not refund a reservation: the transaction may already have been accepted by the chain.
  db.exec("CREATE TABLE IF NOT EXISTS demo_order_admissions (id TEXT PRIMARY KEY, order_id TEXT UNIQUE, client_key TEXT NOT NULL, created_at TEXT NOT NULL)");
  const admissionId = randomUUID(); const client = input.client;
  db.exec("BEGIN IMMEDIATE");
  try {
    const day = now().slice(0, 10);
    const legacy = row(db, "SELECT COUNT(*) AS c FROM demo_orders o WHERE substr(created_at,1,10) = ? AND NOT EXISTS (SELECT 1 FROM demo_order_admissions a WHERE a.order_id = o.order_id)", day)?.c ?? 0;
    const reserved = row(db, "SELECT COUNT(*) AS c FROM demo_order_admissions WHERE substr(created_at,1,10) = ?", day)?.c ?? 0;
    const last = row(db, "SELECT created_at FROM (SELECT created_at FROM orders WHERE client_key = ? AND source = 'developer' UNION ALL SELECT created_at FROM demo_order_admissions WHERE client_key = ?) ORDER BY created_at DESC LIMIT 1", client, client);
    if (legacy + reserved >= demoBudget.maxRunsPerDay) { db.exec("COMMIT"); return { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: "daily order budget used" }; }
    if (last && Date.now() - new Date(last.created_at).getTime() < demoBudget.clientCooldownSeconds * 1000) { db.exec("COMMIT"); return { ok: false, status: 429, error: "DEMO_COOLDOWN", reason: `one order per ${demoBudget.clientCooldownSeconds}s per client` }; }
    const gas = reserveSpend(db, day, [["gas", demoBudget.gasCeilingPerOrderAtomic]]);
    if (!gas.ok) { db.exec("COMMIT"); return { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: `daily gas cap reached (${gas.reserved} of ${gas.cap} native units reserved)` }; }
    run(db, "INSERT INTO demo_order_admissions (id, client_key, created_at) VALUES (?,?,?)", admissionId, client, now());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  const merchant = getAddress(dep.proxies[which].address) as Hex;
  const store = {
    planned: (o: { orderId: Hex; payer: Hex; amountNativeAtomic: string; merchant: Hex }) => { // one transaction: the order row and its admission link exist together or not at all
      db.exec("BEGIN IMMEDIATE");
      try { planOrder(db, { orderId: o.orderId, owner: input.owner, clientKey: client, source: "developer", payer: o.payer, merchant: o.merchant, proxy: which, amountNativeAtomic: o.amountNativeAtomic, reference: input.reference }); run(db, "UPDATE demo_order_admissions SET order_id = ? WHERE id = ?", o.orderId.toLowerCase(), admissionId); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    sent: (o: { orderId: Hex; tx: Hex }) => orderSent(db, o.orderId, o.tx),
    confirmed: (o: any) => orderConfirmed(db, { orderId: o.orderId, tx: o.tx, block: o.block, from: o.from, gasUsed: o.gasUsed, effectiveGasPriceNativeAtomic: o.effectiveGasPriceNativeAtomic }),
  };
  let o;
  try { o = await adminLock(() => createOrder({ publicClient, admin: orderWallet!, merchant, feeParams }, input.payer, input.amountNativeAtomic, store)); }
  catch (e: any) {
    const planned = row(db, "SELECT order_id FROM orders WHERE client_key = ? AND source = 'developer' AND state IN ('PLANNED','SENT') ORDER BY created_at DESC LIMIT 1", client);
    if (planned && /createOrder failed/.test(String(e?.message ?? e))) orderFailed(db, planned.order_id as Hex, "FAILED", "the creation transaction reverted");
    throw e; // anything else (RPC error, receipt timeout) stays PLANNED/SENT for order reconciliation: the chain decides, nothing is replaced here
  }
  return { ok: true, ...o, merchant, proxy: which, payer: input.payer, amountNativeAtomic: input.amountNativeAtomic.toString(), reference: input.reference, baselineDigest: baselineDigestFor(db, merchant), state: "CONFIRMED", owner: input.owner };
}
/** Owner-scoped order views (read routes: chain reads refresh the paid flag; nothing is sent). */
export async function listOrders(db: Db, owner: string, limit = 50) {
  const list = listOrderRows(db, owner, limit);
  await refreshPaid(db, publicClient, list).catch(() => {});
  return { orders: list.map((o) => shapeOrder(db, o, owner)) };
}
export async function getOrder(db: Db, owner: string, orderId: string) {
  const o = getOrderRow(db, orderId);
  if (!o || o.owner !== owner) return null; // no existence leak across owners
  if (o.state === "PLANNED" || o.state === "SENT") await reconcileOrders(db, publicClient, { orderId }).catch(() => {});
  const fresh = getOrderRow(db, orderId)!;
  await refreshPaid(db, publicClient, [fresh]).catch(() => {});
  return shapeOrder(db, fresh, owner);
}
/** Start-up pass and worker: unconfirmed order creations are resolved from the chain (reads only). */
export const reconcileOrderCreations = (db: Db, log: (m: string) => void = () => {}) => reconcileOrders(db, publicClient, { log });
/** The process-wide chain client, for modules that reconcile with reads only. */
export const chainClient: PublicClient = publicClient;

/** Evidence index: files under evidence/ that are safe to publish (no private material lives there). */
export function evidenceIndex() {
  const dir = resolve(cfg.root, "evidence");
  if (!existsSync(dir)) return [];
  const out: { path: string; bytes: number }[] = [];
  const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === "private") continue; const p = resolve(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p, r); else if (e.name.endsWith(".json")) out.push({ path: r, bytes: readFileSync(p).length }); } };
  walk(dir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
export function evidenceFile(rel: string): string | null {
  if (!/^[A-Za-z0-9._\/-]+\.json$/.test(rel) || rel.includes("..") || rel.startsWith("private")) return null;
  const p = resolve(cfg.root, "evidence", rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
