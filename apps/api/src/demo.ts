// Public demo endpoints (spec v1.4 §8.9 / §12): the project's own runner buys the x402 report and walks the full
// sense -> decide -> (final validation -> sign -> broadcast -> postcondition) loop against the DemoMerchant fixtures.
// Budgeted: one run at a time, a global per-day cap, a per-client cooldown, and a runner balance floor. Anything that
// cannot run live is served from the latest recorded run with the RECORDED_SAMPLE label.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, getAddress, type Hex, type PublicClient, type WalletClient, type Transport, type Chain, type Account } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { runFixture, createOrder, type Fixture, type Step } from "@arcpreflight/runner";
import { cfg } from "./config.js";
import { type Db, row, rows, run, now } from "./db.js";

export const FIXTURES: Record<Fixture, { title: string; headline: string; expected: string; proxy: "MAIN" | "CHANGED"; blurb: string }> = {
  CHANGED_IMPLEMENTATION: { title: "Unapproved implementation change", headline: "REVIEW_REQUIRED", expected: "REVIEW_REQUIRED", proxy: "CHANGED",
    blurb: "The merchant proxy was approved on implementation A and silently upgraded to B. Same ABI, same calldata, same price - the pinned report sees the new code hash and the agent refuses to sign until a human re-approves." },
  AMOUNT_UNIT_MISMATCH: { title: "6-decimal amount on the 18-decimal path", headline: "BLOCKED", expected: "BLOCKED", proxy: "MAIN",
    blurb: "USDC is Arc's gas: one balance, two interfaces (native 18 dec, ERC-20 6 dec). The order is for 0.05 USDC but the calldata carries value=50000 - a 10^12 underpayment. AMOUNT_SEMANTICS blocks it before any signature." },
  APPROVED_PAYMENT: { title: "Approved payment, exact plan, verified outcome", headline: "CONFIRMED", expected: "NO_POLICY_VIOLATION", proxy: "MAIN",
    blurb: "Baseline matches, order is payable, simulation passes. The runner re-validates at a new block after paying the service fee, signs exactly the validated plan, broadcasts, and proves the order reads as paid." },
};

const chain: Chain = cfg.net === "mainnet" ? arc : arcTestnet;
const publicClient: PublicClient = createPublicClient({ chain, transport: http(cfg.rpc, { timeout: 20_000 }) });
function keyFromFile(role: string): Hex | null {
  const f = resolve(process.env.KEYS_DIR ?? resolve(cfg.root, "keys"), `${role}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).privateKey : null;
}
const adminPk = (process.env.DEPLOYER_ADMIN_PRIVATE_KEY as Hex | undefined) ?? keyFromFile("deployer-admin");
const runnerPk = (process.env.DEMO_RUNNER_PRIVATE_KEY as Hex | undefined) ?? keyFromFile("demo-runner");
const adminAcct: PrivateKeyAccount | null = adminPk ? privateKeyToAccount(adminPk) : null;
const runnerAcct: PrivateKeyAccount | null = runnerPk ? privateKeyToAccount(runnerPk) : null;
const adminWallet: WalletClient<Transport, Chain, Account> | null = adminAcct ? createWalletClient({ account: adminAcct, chain, transport: http(cfg.rpc, { timeout: 20_000 }) }) : null;

export const demoBudget = {
  maxRunsPerDay: Number(process.env.DEMO_MAX_RUNS_PER_DAY ?? 40),
  clientCooldownSeconds: Number(process.env.DEMO_CLIENT_COOLDOWN_SECONDS ?? 45),
  runnerFloorNativeAtomic: BigInt(process.env.DEMO_RUNNER_FLOOR_ATOMIC ?? "150000000000000000"), // 0.15 USDC keeps >=2 runs of headroom
  amountNativeAtomic: BigInt(process.env.DEMO_AMOUNT_ATOMIC ?? "50000000000000000"), // 0.05 USDC per business payment
};

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
// one admin key, possibly several callers (live runs + developer orders): serialise its transactions
let adminQueue: Promise<unknown> = Promise.resolve();
const adminLock = <T,>(fn: () => Promise<T>): Promise<T> => { const p = adminQueue.then(fn, fn); adminQueue = p.catch(() => {}); return p; };

let headCache: { at: number; head: string | null } = { at: 0, head: null };
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
  return { network: cfg.net, chainId: cfg.chainId, caip2: cfg.caip2, rpc: cfg.rpc, explorer: cfg.net === "mainnet" ? "https://explorer.arc.io" : "https://testnet.arcscan.app", head: headCache.head,
    usdc: cfg.usdc, profile: cfg.profile, release: cfg.releaseSha, priceTokenAtomic: cfg.priceTokenAtomic, supportedTargets: cfg.supportedTargets,
    accounts: { deployerAdmin: dep?.deployer ?? adminAcct?.address ?? null, demoRunner: runnerAcct?.address ?? null, merchantPayTo: cfg.merchant?.address ?? null },
    deployments: dep ? { implA: dep.implA, implB: dep.implB, proxies: dep.proxies, deployedAtUTC: dep.deployedAtUTC, compiler: dep.compiler } : null,
    fixtures, budget: { maxRunsPerDay: demoBudget.maxRunsPerDay, usedToday: used, clientCooldownSeconds: demoBudget.clientCooldownSeconds, amountNativeAtomic: demoBudget.amountNativeAtomic.toString(), activeRun: active } };
}

export type StartResult = { ok: true; runId: string } | { ok: false; status: number; error: string; reason: string; sample?: string | null };

export async function startRun(db: Db, fixture: Fixture, client: string): Promise<StartResult> {
  if (!FIXTURES[fixture]) return { ok: false, status: 400, error: "INVALID_INPUT", reason: "unknown fixture" };
  const dep = deployments();
  if (!dep || !adminWallet || !runnerAcct) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "fixtures not deployed on this network", sample: latestSample(db, fixture) };
  const token = runnerToken();
  if (!token) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "runner principal not configured", sample: latestSample(db, fixture) };
  const proxy = dep.proxies[FIXTURES[fixture].proxy];
  const baselineDigest = baselineDigestFor(db, proxy.address);
  if (!baselineDigest) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "no approved baseline for the fixture proxy", sample: latestSample(db, fixture) };
  if (active) return { ok: false, status: 429, error: "DEMO_BUSY", reason: `another run (${active}) is in progress; wait for it to finish`, sample: latestSample(db, fixture) };
  const day = now().slice(0, 10);
  const used = row(db, "SELECT COUNT(*) AS c FROM demo_runs WHERE substr(created_at,1,10) = ? AND labels_json LIKE '%LIVE_REQUEST%'", day)?.c ?? 0;
  if (used >= demoBudget.maxRunsPerDay) return { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: `daily live-run budget (${demoBudget.maxRunsPerDay}) used; recorded samples remain available`, sample: latestSample(db, fixture) };
  const last = row(db, "SELECT created_at FROM demo_runs WHERE client_key = ? ORDER BY created_at DESC LIMIT 1", client);
  if (last && Date.now() - new Date(last.created_at).getTime() < demoBudget.clientCooldownSeconds * 1000) return { ok: false, status: 429, error: "DEMO_COOLDOWN", reason: `one live run per ${demoBudget.clientCooldownSeconds}s per client`, sample: latestSample(db, fixture) };
  const bal = await publicClient.getBalance({ address: runnerAcct.address });
  if (bal < demoBudget.runnerFloorNativeAtomic + demoBudget.amountNativeAtomic) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "runner balance below the configured floor; live runs paused", sample: latestSample(db, fixture) };

  const runId = randomUUID();
  // schema labels: LIVE_REQUEST always; DEMO_ON_MAINNET only on 5042 (the network itself is recorded in the result)
  const labels = cfg.net === "mainnet" ? ["LIVE_REQUEST", "DEMO_ON_MAINNET"] : ["LIVE_REQUEST"];
  run(db, "INSERT INTO demo_runs (run_id, fixture, state, steps_json, labels_json, created_at, updated_at, client_key, result_json) VALUES (?,?,?,?,?,?,?,?,?)", runId, fixture, "RUNNING", "[]", JSON.stringify(labels), now(), now(), client, null);
  active = runId;
  const steps: Step[] = [];
  const persist = () => run(db, "UPDATE demo_runs SET steps_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(steps), now(), runId);
  (async () => {
    try {
      const out = await runFixture({ fixture, net: cfg.net, chain, publicClient, admin: adminWallet, runner: runnerAcct, merchant: getAddress(proxy.address) as Hex, baselineDigest,
        apiUrl: `http://127.0.0.1:${cfg.port}`, token, amountNativeAtomic: demoBudget.amountNativeAtomic, feeParams, labels: labels as any, adminLock,
        onStep: (s) => { steps.push(s); persist(); } });
      run(db, "UPDATE demo_runs SET state = 'DONE', steps_json = ?, result_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(steps), JSON.stringify(out), now(), runId);
    } catch (e: any) {
      steps.push({ step: "error", atMs: -1, error: String(e?.message ?? e).slice(0, 400) });
      run(db, "UPDATE demo_runs SET state = 'FAILED', steps_json = ?, updated_at = ? WHERE run_id = ?", JSON.stringify(steps), now(), runId);
      console.error(now(), "DEMO_RUN_FAILED", runId, fixture, String(e?.message ?? e));
    } finally { active = null; }
  })();
  return { ok: true, runId };
}

export function getRun(db: Db, runId: string) {
  const r = row(db, "SELECT * FROM demo_runs WHERE run_id = ?", runId);
  if (!r) return null;
  return shapeRun(r);
}
function shapeRun(r: any) {
  const result = r.result_json ? JSON.parse(r.result_json) : null;
  return { runId: r.run_id, fixture: r.fixture, state: r.state, labels: JSON.parse(r.labels_json), steps: JSON.parse(r.steps_json), createdAt: r.created_at, updatedAt: r.updated_at,
    expected: FIXTURES[r.fixture as Fixture]?.expected ?? null, headline: FIXTURES[r.fixture as Fixture]?.headline ?? null, result };
}
export function listRuns(db: Db, limit = 20) {
  return rows(db, "SELECT run_id, fixture, state, labels_json, created_at, updated_at, result_json FROM demo_runs ORDER BY created_at DESC LIMIT ?", limit).map((r: any) => {
    const res = r.result_json ? JSON.parse(r.result_json) : null;
    return { runId: r.run_id, fixture: r.fixture, state: r.state, labels: JSON.parse(r.labels_json), createdAt: r.created_at, updatedAt: r.updated_at,
      decision: res?.decision?.decision ?? null, businessTxHash: res?.execution?.businessTxHash ?? null, businessStatus: res?.execution?.businessStatus ?? null, serviceFeeTx: res?.serviceFeeTx ?? null, durationMs: res?.durationMs ?? null };
  });
}
export function latestSample(db: Db, fixture: Fixture): string | null {
  return row(db, "SELECT run_id FROM demo_runs WHERE fixture = ? AND state = 'DONE' ORDER BY created_at DESC LIMIT 1", fixture)?.run_id ?? null;
}

/** Developer path (restricted profile): create an order for an external payer on the MAIN proxy so a wallet-connected user can buy a preflight
 *  with their own EIP-3009 signature and run the local decision in the browser. Execution of the business call stays off (§8.9). */
export async function createOrderFor(db: Db, payer: Hex, client: string): Promise<{ ok: true; orderId: Hex; tx: Hex; block: string; merchant: Hex; amountNativeAtomic: string; baselineDigest: Hex | null } | StartResult> {
  const dep = deployments();
  if (!dep || !adminWallet) return { ok: false, status: 503, error: "DEMO_UNAVAILABLE", reason: "fixtures not deployed on this network" };
  const day = now().slice(0, 10);
  const used = row(db, "SELECT COUNT(*) AS c FROM demo_orders WHERE substr(created_at,1,10) = ?", day)?.c ?? 0;
  if (used >= demoBudget.maxRunsPerDay) return { ok: false, status: 429, error: "DEMO_BUDGET_EXHAUSTED", reason: "daily order budget used" };
  const last = row(db, "SELECT created_at FROM demo_orders WHERE client_key = ? ORDER BY created_at DESC LIMIT 1", client);
  if (last && Date.now() - new Date(last.created_at).getTime() < demoBudget.clientCooldownSeconds * 1000) return { ok: false, status: 429, error: "DEMO_COOLDOWN", reason: `one order per ${demoBudget.clientCooldownSeconds}s per client` };
  const merchant = getAddress(dep.proxies.MAIN.address) as Hex;
  const o = await adminLock(() => createOrder({ publicClient, admin: adminWallet, merchant, feeParams }, payer, demoBudget.amountNativeAtomic));
  run(db, "INSERT INTO demo_orders (order_id, payer, merchant, amount_atomic, tx_hash, block, client_key, created_at) VALUES (?,?,?,?,?,?,?,?)", o.orderId, payer.toLowerCase(), merchant.toLowerCase(), demoBudget.amountNativeAtomic.toString(), o.tx, o.block, client, now());
  return { ok: true, ...o, merchant, amountNativeAtomic: demoBudget.amountNativeAtomic.toString(), baselineDigest: baselineDigestFor(db, merchant) };
}

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
