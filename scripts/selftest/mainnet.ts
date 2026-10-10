// Mainnet acceptance runner (spec v1.4 §12.9): every demo scenario at least 3x on Arc mainnet through the public demo API, with
// the service fee and the business payment labelled separately and every on-chain fact re-read from the mainnet RPC.
// DRY RUN by default: GET /v1/network + RPC balance reads only, nothing is started. `--execute` starts runs and spends the
// project's own funds (0.01 USDC service fee per run; APPROVED_PAYMENT also pays the 0.05 USDC order; plus gas).
//   dry run : pnpm exec tsx scripts/selftest/mainnet.ts
//   execute : API_URL=https://arcpreflight.axiqo.xyz EXPECTED_RELEASE=<release shown by /health/live> [DEMO_RUNNER_TOKEN=...] \
//             pnpm exec tsx scripts/selftest/mainnet.ts --execute
// Env: SELFTEST_REPEATS (1..5, default 3 = the G2 minimum), SPEND_CAP_USDC (fee + business + gas ceilings, default 0.35, refused above 1),
//      ADMIN_TOKEN (required: acceptance runs while the instance is still gated, PUBLIC_EXECUTION=0; an already public instance is refused),
//      RUNNER_FLOOR_USDC (the server's runner floor, default 0.15; not exposed by /v1/network), COOLDOWN_MARGIN_SECONDS (3),
//      ARC_RPC_URL, SELFTEST_OUTPUT_DIR (default evidence/selftest), DEMO_RUNNER_TOKEN (optional authenticated recovery check).
// Refuses anything that is not Arc mainnet (5042) under SUBMISSION_RESTRICTED. Runs are sequential and the first failed or
// unexpected run stops everything. The only thing ever retried is a refused start (HTTP 429 cooldown/busy): nothing was started.
import { mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { resolve } from "node:path";
import { createPublicClient, http, keccak256, toHex, type Chain, type Hex, type PublicClient } from "viem";
import { arc } from "viem/chains";
import { ARC, OutflowMeter, pinCaps, checkStep, beginMeasured, updateMeasured, noteOpen, endStep } from "@arcpreflight/client";
import { openPlan } from "../lib/plan-ledger.js";
import { SLOTS, slotToAddress } from "@arcpreflight/observer";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { executionDigest, intentDigest, reportDigest, decisionDigest, finalValidationDigest, transactionPlanDigest } from "@arcpreflight/schema";
import { fromBundle } from "@arcpreflight/passport";
import { verifyPassport, rpcFromUrl } from "@arcpreflight/verifier";

const E18 = 10n ** 18n; // native USDC (gas) has 18 decimals; the ERC-20 face at 0x3600…0000 has 6
const E12 = 10n ** 12n;
export const FIXTURES = ["CHANGED_IMPLEMENTATION", "AMOUNT_UNIT_MISMATCH", "APPROVED_PAYMENT"] as const;
export type FixtureId = (typeof FIXTURES)[number];
const EXPECT: Record<FixtureId, { decision: string; chainStatus: string; businessStatus: string }> = {
  CHANGED_IMPLEMENTATION: { decision: "REVIEW_REQUIRED", chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED" },
  AMOUNT_UNIT_MISMATCH: { decision: "BLOCKED", chainStatus: "NOT_SIGNED", businessStatus: "NOT_EXECUTED" },
  APPROVED_PAYMENT: { decision: "NO_POLICY_VIOLATION", chainStatus: "CONFIRMED", businessStatus: "SUCCESS" },
};
/** The project's own mainnet wallets (public addresses). /v1/network must report exactly these. The API signs orders with the
 *  narrowly scoped order-creator key; the deployer-admin (owner) key must not be in the API process (design v3.2 §14, MN-01). */
export const ACCOUNTS = { deployerAdmin: "0xDBb3598F78A9a8888d89E96F938aB0A719b075aA", orderCreator: "0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b", demoRunner: "0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE", merchantPayTo: "0x06873b35575D6A22eC8008f30F56c71C19BeE7b0" } as const;
const ROLE_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { type: "function", name: "orderCreator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ADMISSION_KEY = () => `mn-${crypto.randomUUID()}`;
// Gas assumptions for the spend list. Observed on the testnet rehearsal: createOrder 98,107 gas, pay 40,364 gas, 20-25 gwei.
const GAS_CREATE_ORDER = 150_000n, GAS_PAY = 80_000n, GAS_PRICE_CEIL = 40n * 10n ** 9n;
/** the relayer's per-transaction cap enforced by the API (RELAY_MAX_FEE_ATOMIC default): the fee relay's gas ceiling per run */
const RELAY_GAS_CEIL = 5_000_000_000_000_000n;
const GAS_CREATE_ORDER_OBSERVED = 98_107n, GAS_PAY_OBSERVED = 40_364n, GAS_PRICE_OBSERVED = 20n * 10n ** 9n;
const FALLBACK_COOLDOWN_SECONDS = 48;
const ZERO = "0x0000000000000000000000000000000000000000";

const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const AUTH_USED = keccak256(toHex("AuthorizationUsed(address,bytes32)")); // EIP-3009
const ORDER_CREATED = keccak256(toHex("OrderCreated(bytes32,address,uint256)"));
const ORDER_PAID = keccak256(toHex("OrderPaid(bytes32,address,uint256)"));
const GET_ORDER_ABI = [{ type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }] }] as const;

class Refused extends Error {}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const usdc = (a: bigint): string => (a < 0n ? `-${usdc(-a)}` : `${a / E18}.${(a % E18).toString().padStart(18, "0").replace(/0+$/, "") || "0"}`);
const parseUsdc = (s: string): bigint => { if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Refused(`bad USDC amount "${s}"`); const [i, f = ""] = s.split("."); return BigInt(i) * E18 + BigInt((f + "0".repeat(18)).slice(0, 18)); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");
const topicOf = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

type Network = {
  network: string; chainId: number; caip2: string; usdc: string; profile: string; release: string; priceTokenAtomic: string; supportedTargets: string[];
  accounts: { deployerAdmin: string | null; orderCreator: string | null; orderSignerRole?: string | null; adminKeyInProcess?: boolean; demoRunner: string | null; merchantPayTo: string | null };
  fixtures: { id: string; proxy: "MAIN" | "CHANGED"; merchant: string | null; implementation: string | null; approvedImplementation: string | null; baselineDigest: string | null }[];
  budget: { maxRunsPerDay: number; usedToday: number; clientCooldownSeconds?: number; amountNativeAtomic: string; activeRun: string | null };
  access?: { publicExecution?: boolean; operatorAcceptance?: boolean; executionReady?: boolean; walletExecution?: boolean };
};
export type RunReport = {
  round?: number; fixture: FixtureId; runId: string; requestId: string; labels: string[]; decision: string; chainStatus: string; businessStatus: string; durationMs: number;
  serviceFee: { kind: "SERVICE_FEE"; amountUsdc: string; tx: string; payer: string; payTo: string; verifiedOnChain: true };
  order: { orderId: string; merchant: string; createTx: string; paidOnChain: boolean };
  businessPayment: { kind: "BUSINESS_PAYMENT"; amountUsdc: string; tx: string | null; executed: boolean };
  digests: Record<string, string | null>;
  gasUsdc: { createOrder: string; businessPay: string | null };
  recovery?: { unauthenticatedStatus: number; authenticated: string };
  /** AP32-08: the admission key re-sent right after the start answered with the same run and no second run */
  admission?: { replayStatus: number; sameRun: boolean };
  /** AP32-28: the run's passport, exported through the public route and verified by the independent verifier against the mainnet RPC */
  passport?: { file: string; findings: Record<string, string>; counts: { pass: number; fail: number; unverified: number; notEvaluated: number } };
};

/** Spend plan (pure): what `repeats` rounds of the three fixtures can cost at most. The hard cap applies to the TOTAL worst case:
 *  fees + business payments + every gas ceiling (order creation, the business pay, the fee relay) — Gate D, 2026-10-09. */
export function planSpend(o: { repeats: number; feeNative: bigint; businessNative: bigint; capNative: bigint; floorNative: bigint }) {
  const runs = BigInt(o.repeats * FIXTURES.length), approved = BigInt(o.repeats);
  const fees = runs * o.feeNative, business = approved * o.businessNative;
  const gasCreateCeil = runs * GAS_CREATE_ORDER * GAS_PRICE_CEIL, gasPayCeil = approved * GAS_PAY * GAS_PRICE_CEIL, gasRelayCeil = runs * RELAY_GAS_CEIL;
  const gasExpected = runs * GAS_CREATE_ORDER_OBSERVED * GAS_PRICE_OBSERVED + approved * GAS_PAY_OBSERVED * GAS_PRICE_OBSERVED;
  const totalWorst = fees + business + gasCreateCeil + gasPayCeil + gasRelayCeil;
  return {
    runs: Number(runs), approved: Number(approved), fees, business, feeAndBusiness: fees + business, totalWorst, withinCap: totalWorst <= o.capNative, gasCreateCeil, gasPayCeil, gasRelayCeil, gasExpected,
    /** the worst case of ONE run, for the measured-outflow stop before each start */
    worstPerRun: { approved: o.feeNative + o.businessNative + GAS_CREATE_ORDER * GAS_PRICE_CEIL + GAS_PAY * GAS_PRICE_CEIL + RELAY_GAS_CEIL, other: o.feeNative + GAS_CREATE_ORDER * GAS_PRICE_CEIL + RELAY_GAS_CEIL },
    // the server refuses any run that starts with runner balance < floor + order amount, so the LAST run still needs that after everything else was spent
    runnerNeed: fees + business + gasPayCeil + o.floorNative + o.businessNative, creatorNeed: gasCreateCeil,
  };
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** The public Arc RPC is load-balanced: a node can briefly lag behind the one that served the API, so reads are retried. */
async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 15, delayMs = 2000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(delayMs); } }
  throw new Error(`${what} not readable from the RPC after ${tries} tries: ${String((last as any)?.shortMessage ?? last).slice(0, 160)}`);
}
type Lg = { address: string; topics: readonly string[]; data: string };
const hasLog = (logs: readonly Lg[], o: { address: string; topic0: Hex; t1?: Hex; t2?: Hex; value?: bigint }) =>
  logs.some((l) => same(l.address, o.address) && l.topics[0] === o.topic0 && (!o.t1 || l.topics[1] === o.t1) && (!o.t2 || l.topics[2] === o.t2) && (o.value === undefined || (l.data !== "0x" && BigInt(l.data) === o.value)));

export type Ctx = {
  client: PublicClient; chainId: number; usdc: Hex; runner: Hex; creator: Hex; payTo: Hex;
  feeAtomic6: bigint; // service fee in 6-decimal token units (the ERC-20 face of USDC)
  businessNative: bigint; // order amount in 18-decimal native units
  fixtures: Record<FixtureId, { merchant: string }>; // proxy per fixture as reported by /v1/network
  requiredLabels: string[];
};

/** Everything one finished run must prove. Throws on the first mismatch (the caller stops the whole sequence). */
export async function verifyRun(ctx: Ctx, fixture: FixtureId, run: any): Promise<RunReport> {
  const exp = EXPECT[fixture];
  must(run.state === "DONE", `run ${run.runId} ended ${run.state}: ${JSON.stringify(run.steps?.at(-1))}`);
  const out = run.result;
  must(out && out.fixture === fixture, `run ${run.runId} has no result for ${fixture}`);
  // 1. what the API reports
  must(out.chainId === ctx.chainId, `result chainId ${out.chainId} != ${ctx.chainId}`);
  for (const l of ctx.requiredLabels) must(out.execution.labels.includes(l) && run.labels.includes(l), `labels ${JSON.stringify(out.execution.labels)} / ${JSON.stringify(run.labels)} lack ${l}`);
  must(out.decision.decision === exp.decision, `${fixture}: decision ${out.decision.decision}, expected ${exp.decision}`);
  must(out.execution.chainStatus === exp.chainStatus, `${fixture}: chainStatus ${out.execution.chainStatus}, expected ${exp.chainStatus}`);
  must(out.execution.businessStatus === exp.businessStatus, `${fixture}: businessStatus ${out.execution.businessStatus}, expected ${exp.businessStatus}`);
  must(same(out.merchant, ctx.fixtures[fixture].merchant), `${fixture}: ran against ${out.merchant}, /v1/network lists ${ctx.fixtures[fixture].merchant}`);
  // 2. digest chain: recompute every digest and check that each receipt points at the one before it
  must(intentDigest(out.intent) === out.intentDigest, "intent digest mismatch");
  must(reportDigest(out.report) === out.reportDigest && out.report.intentDigest === out.intentDigest, "report digest mismatch or report bound to another intent");
  must(decisionDigest(out.decision) === out.decisionDigest && out.decision.intentDigest === out.intentDigest && out.decision.reportDigest === out.reportDigest, "decision digest mismatch or wrong links");
  must(executionDigest(out.execution) === out.executionDigest, "execution digest mismatch");
  must(out.execution.intentDigest === out.intentDigest && out.execution.reportDigest === out.reportDigest && out.execution.decisionDigest === out.decisionDigest, "execution receipt does not point at this intent/report/decision");
  if (fixture === "APPROVED_PAYMENT") {
    must(out.finalValidation?.result === "PASS", `final validation ${out.finalValidation?.result}: ${JSON.stringify(out.finalValidation?.reasons)}`);
    must(finalValidationDigest(out.finalValidation) === out.execution.finalValidationDigest, "final validation digest mismatch");
    must(transactionPlanDigest(out.plan) === out.execution.transactionPlanDigest && out.finalValidation.transactionPlanDigest === out.execution.transactionPlanDigest, "transaction plan digest mismatch");
    must(out.finalValidation.intentDigest === out.intentDigest && out.finalValidation.reportDigest === out.reportDigest && out.finalValidation.decisionDigest === out.decisionDigest, "final validation does not point at this intent/report/decision");
    must(out.execution.businessTxHash, "APPROVED_PAYMENT without a business tx hash");
  } else {
    must(out.execution.businessTxHash === null && out.execution.finalValidationDigest === null && out.execution.transactionPlanDigest === null, `${fixture}: nothing may be signed or sent, but the receipt shows a plan/tx`);
  }
  // 3. independent on-chain re-reads (mainnet RPC, not the API's word)
  const { client, usdc: token } = ctx;
  const receipt = (hash: string) => withRetry(`receipt ${short(hash)}`, () => client.getTransactionReceipt({ hash: hash as Hex }));
  const txOf = (hash: string) => withRetry(`tx ${short(hash)}`, () => client.getTransaction({ hash: hash as Hex }));
  const orderId = String(out.orderId).toLowerCase() as Hex;
  const merchant = out.merchant as Hex;
  const runnerT = topicOf(ctx.runner);
  // 3a. createOrder (order-creator -> proxy): the independently approved order the business expectation comes from; the sender must be
  //     the narrowly scoped order-creator role, never the owner key (MN-01)
  const co = run.steps.find((s: any) => s.step === "createOrder");
  must(co?.tx && same(co.orderId, orderId), "createOrder step missing or for another order");
  const [coRc, coTx] = await Promise.all([receipt(co.tx), txOf(co.tx)]);
  must(coRc.status === "success" && same(coTx.from, ctx.creator) && same(coTx.to, merchant), `createOrder ${short(co.tx)}: status ${coRc.status}, from ${coTx.from} (expected order-creator ${ctx.creator}), to ${coTx.to}`);
  must(hasLog(coRc.logs, { address: merchant, topic0: ORDER_CREATED, t1: orderId, t2: runnerT, value: ctx.businessNative }), `createOrder ${short(co.tx)}: no OrderCreated(order, runner, ${ctx.businessNative}) log`);
  // 3b. service fee: EIP-3009 transferWithAuthorization relayed by the merchant account straight to the USDC contract (6-dec ERC-20 Transfer log)
  must(out.serviceFeeTx, "no service-fee tx hash");
  const [feeRc, feeTx] = await Promise.all([receipt(out.serviceFeeTx), txOf(out.serviceFeeTx)]);
  must(feeRc.status === "success", `service fee ${short(out.serviceFeeTx)} status ${feeRc.status}`);
  must(same(feeTx.to, token), `service fee ${short(out.serviceFeeTx)} was sent to ${feeTx.to}, expected the USDC contract ${token}`);
  must(hasLog(feeRc.logs, { address: token, topic0: TRANSFER, t1: runnerT, t2: topicOf(ctx.payTo), value: ctx.feeAtomic6 }), `service fee ${short(out.serviceFeeTx)}: no USDC Transfer(demo-runner -> merchant-payto, ${ctx.feeAtomic6}) log`);
  must(hasLog(feeRc.logs, { address: token, topic0: AUTH_USED, t1: runnerT }), `service fee ${short(out.serviceFeeTx)}: no EIP-3009 AuthorizationUsed log by the demo runner`);
  // 3c. business payment: only APPROVED_PAYMENT; the order itself must read as paid, by this payer, for the exact amount
  let bizTx: string | null = null, payGas: bigint | null = null;
  if (fixture === "APPROVED_PAYMENT") {
    bizTx = out.execution.businessTxHash as string;
    const [bRc, bTx] = await Promise.all([receipt(bizTx), txOf(bizTx)]);
    must(bRc.status === "success", `business tx ${short(bizTx)} status ${bRc.status}`);
    must(same(bTx.from, ctx.runner) && same(bTx.to, merchant) && bTx.value === ctx.businessNative, `business tx ${short(bizTx)}: from ${bTx.from} to ${bTx.to} value ${bTx.value}`);
    must(bTx.input.slice(0, 10).toLowerCase() === String(PAY_SELECTOR).toLowerCase() && `0x${bTx.input.slice(10, 74)}`.toLowerCase() === orderId, `business tx ${short(bizTx)} is not pay(${short(orderId)})`);
    must(hasLog(bRc.logs, { address: merchant, topic0: ORDER_PAID, t1: orderId, t2: runnerT, value: ctx.businessNative }), `business tx ${short(bizTx)}: no OrderPaid(order, runner, ${ctx.businessNative}) log`);
    payGas = bRc.gasUsed * bRc.effectiveGasPrice;
  }
  const wantPaid = fixture === "APPROVED_PAYMENT";
  const ord = await withRetry(`order ${short(orderId)}`, async () => {
    const [payer, amount, paid] = await client.readContract({ address: merchant, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
    if (same(payer, ZERO)) throw new Error("order not visible on this node yet");
    if (wantPaid && !paid) throw new Error("order not yet paid on this node");
    return { payer, amount, paid };
  }, 12, 2000);
  must(same(ord.payer, ctx.runner) && ord.amount === ctx.businessNative, `order ${short(orderId)}: payer ${ord.payer}, amount ${ord.amount}`);
  must(ord.paid === wantPaid, wantPaid ? `order ${short(orderId)} is not paid` : `order ${short(orderId)} is PAID although ${fixture} must not execute the business call`);
  return {
    fixture, runId: run.runId, requestId: out.requestId, labels: out.execution.labels, decision: out.decision.decision, chainStatus: out.execution.chainStatus, businessStatus: out.execution.businessStatus, durationMs: out.durationMs,
    serviceFee: { kind: "SERVICE_FEE", amountUsdc: usdc(ctx.feeAtomic6 * E12), tx: out.serviceFeeTx, payer: ctx.runner, payTo: ctx.payTo, verifiedOnChain: true },
    order: { orderId, merchant, createTx: co.tx, paidOnChain: ord.paid },
    businessPayment: { kind: "BUSINESS_PAYMENT", amountUsdc: wantPaid ? usdc(ctx.businessNative) : "0", tx: bizTx, executed: wantPaid },
    digests: { intent: out.intentDigest, report: out.reportDigest, decision: out.decisionDigest, finalValidation: out.execution.finalValidationDigest, transactionPlan: out.execution.transactionPlanDigest, execution: out.executionDigest },
    gasUsdc: { createOrder: usdc(coRc.gasUsed * coRc.effectiveGasPrice), businessPay: payGas === null ? null : usdc(payGas) },
  };
}

/** AP32-28 on mainnet: export the finished run's passport through the public route, verify it with the independent verifier against
 *  the mainnet RPC (anchors = the baseline digest /v1/network lists for the fixture and the run's own policy digest), require no FAIL. */
export async function verifyRunPassport(api: string, run: any, rpcUrl: string, baselineDigest: string, dir: string): Promise<NonNullable<RunReport["passport"]>> {
  const res = await fetch(`${api}/v1/demo/runs/${run.runId}/passport`, { signal: AbortSignal.timeout(60_000) });
  must(res.status === 200, `passport export returned ${res.status}`);
  const text = await res.text();
  must(!/[0-9a-f]{130}/i.test(text.replace(/"input":"0x[0-9a-f]+"/gi, "")) , "passport text contains a 65-byte hex string outside transaction calldata");
  const files = fromBundle(text);
  const v = await verifyPassport(files, { rpc: rpcFromUrl(rpcUrl), anchors: { baselineDigests: [baselineDigest], policyDigests: [run.result.policyDigest] } });
  const findings = Object.fromEntries(v.findings.map((f) => [f.id, f.status]));
  must(v.counts.fail === 0, `passport verification failed: ${v.findings.filter((f) => f.status === "FAIL").map((f) => `${f.id}: ${f.detail}`).join("; ")}`);
  for (const id of ["FILE_INTEGRITY", "DIGEST_INTEGRITY", "DISCLOSURE", "APPROVAL_SOURCE", "NETWORK_IDENTITY", "FEE_ATTRIBUTION"]) must(findings[id] === "PASS", `passport finding ${id} is ${findings[id]}, expected PASS`);
  if (run.result.execution.businessTxHash) for (const id of ["TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT"]) must(findings[id] === "PASS", `passport finding ${id} is ${findings[id]}, expected PASS`);
  mkdirSync(resolve(dir, "passports"), { recursive: true });
  const file = resolve(dir, "passports", `mainnet-${run.runId}.passport.json`);
  writeFileSync(file, text);
  return { file: file.replace(`${process.cwd()}/`, ""), findings, counts: v.counts };
}

/** Private request data must not be readable anonymously; with the runner token the same payment and report must come back. */
export async function verifyRecovery(api: string, token: string | undefined, out: any): Promise<NonNullable<RunReport["recovery"]>> {
  const url = `${api}/v1/requests/${out.requestId}`;
  const anon = await getJson(url);
  must(anon.status === 401, `unauthenticated GET /v1/requests/{id} returned ${anon.status}, expected 401`);
  if (!token) return { unauthenticatedStatus: 401, authenticated: "SKIPPED (no DEMO_RUNNER_TOKEN)" };
  const r = await getJson(url, { headers: { authorization: `Bearer ${token}` } });
  must(r.status === 200 && r.body?.delivery === "DELIVERED" && r.body?.payment?.state === "COMPLETED", `authenticated recovery returned ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
  must(same(r.body.payment.transaction, out.serviceFeeTx), "recovered payment is a different transaction");
  must(r.body.reportDigest === out.reportDigest && reportDigest(r.body.report) === r.body.reportDigest, "recovered report differs from the delivered one");
  return { unauthenticatedStatus: 401, authenticated: "VERIFIED (same payment tx, same report digest)" };
}

async function startRun(api: string, fixture: FixtureId, cooldownMs: number): Promise<{ runId: string; startedAt: number; admission: NonNullable<RunReport["admission"]> }> {
  const key = ADMISSION_KEY();
  for (let attempt = 0; ; attempt++) {
    let res: { status: number; body: any };
    try { res = await getJson(`${api}/v1/demo/run`, { method: "POST", headers: { "content-type": "application/json", ...(process.env.ADMIN_TOKEN ? { "x-admin-token": process.env.ADMIN_TOKEN } : {}) }, body: JSON.stringify({ fixture, clientRunRequestId: key }) }); }
    catch (e: any) {
      // the response was lost: the admission key makes the retry safe — the same key returns the run that was admitted (or nothing was)
      console.log(`  POST /v1/demo/run did not answer (${e?.message ?? e}); re-sending the SAME admission key`);
      await sleep(2000); continue;
    }
    if ((res.status === 202 || res.status === 200) && res.body?.runId) {
      // AP32-08: re-send the same key immediately — the server must answer with the original run and start nothing
      const replay = await getJson(`${api}/v1/demo/run`, { method: "POST", headers: { "content-type": "application/json", ...(process.env.ADMIN_TOKEN ? { "x-admin-token": process.env.ADMIN_TOKEN } : {}) }, body: JSON.stringify({ fixture, clientRunRequestId: key }) });
      const sameRun = replay.status === 200 && replay.body?.runId === res.body.runId && replay.body?.admission === "existing";
      must(sameRun, `admission replay returned ${replay.status} ${JSON.stringify(replay.body)}; expected 200 with the same run ${res.body.runId}`);
      return { runId: res.body.runId, startedAt: Date.now(), admission: { replayStatus: replay.status, sameRun } };
    }
    // A refusal means the server started nothing and charged nothing, so waiting and asking again cannot double-spend.
    if (res.status === 429 && (res.body?.error === "DEMO_COOLDOWN" || res.body?.error === "DEMO_BUSY") && attempt < 3) {
      console.log(`  start refused (${res.body.error}); nothing was started, waiting before asking again`);
      await sleep(res.body.error === "DEMO_BUSY" ? 5_000 : cooldownMs); continue;
    }
    throw new Error(`run start refused or unexpected: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}
async function awaitRun(api: string, runId: string): Promise<any> {
  const deadline = Date.now() + 240_000;
  let body: any = null;
  while (Date.now() < deadline) {
    const r = await getJson(`${api}/v1/demo/runs/${runId}`).catch(() => null);
    if (r?.body && r.body.state !== "RUNNING") { body = r.body; break; }
    await sleep(2000);
  }
  if (!body) throw new Error(`run ${runId} is still RUNNING after 240 s; not starting anything else. Check ${api}/v1/demo/runs/${runId}`);
  // a receipt that is only late leaves the run RECONCILE_REQUIRED: wait for reconciliation (bounded: the plan's stop condition 7, 10 minutes)
  if (body.state === "RECONCILE_REQUIRED") {
    console.log(`  ${runId}: outcome not established yet (RECONCILE_REQUIRED) — waiting for reconciliation from the original hash and the order state`);
    const until = Date.now() + 600_000;
    while (Date.now() < until && body.state === "RECONCILE_REQUIRED") { await sleep(5000); const r = await getJson(`${api}/v1/demo/runs/${runId}`).catch(() => null); if (r?.body) body = r.body; }
    if (body.state === "RECONCILE_REQUIRED") throw new Error(`run ${runId} is still unresolved after 10 minutes of reconciliation — stop condition 7: nothing else is started`);
  }
  return body;
}

async function main(): Promise<number> {
  const EXECUTE = process.argv.includes("--execute");
  const api = (process.env.API_URL ?? "https://arcpreflight.axiqo.xyz").replace(/\/+$/, "");
  if (EXECUTE && !process.env.API_URL) throw new Refused("--execute needs API_URL set explicitly (there is no default target for spending runs)");
  const repeats = Number(process.env.SELFTEST_REPEATS ?? 3);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Refused("SELFTEST_REPEATS must be an integer 1..5 (the G2 minimum is 3)");
  const cap = parseUsdc(process.env.SPEND_CAP_USDC ?? "0.35");
  if (cap > E18) throw new Refused("SPEND_CAP_USDC above 1 USDC is refused");
  // the plan ledger (review 2026-10-10, P1): the approved cap is pinned (SPEND_CAP_USDC may lower it, never raise it); the measured outflow
  // is carried across restarts from the FIRST invocation's balance baseline; runs still open count at their worst case until they settle
  const book = openPlan(process.env.ARCPREFLIGHT_ROOT ?? process.cwd(), "mainnet", { write: EXECUTE });
  if (book) pinCaps(book.plan, "acceptance", { totalNativeAtomic: cap });
  const floor = parseUsdc(process.env.RUNNER_FLOOR_USDC ?? "0.15");
  const marginS = Number(process.env.COOLDOWN_MARGIN_SECONDS ?? 3);
  const rpc = process.env.ARC_RPC_URL ?? ARC.mainnet.rpc;
  const token = process.env.DEMO_RUNNER_TOKEN || undefined;

  const first = await getJson(`${api}/v1/network`).catch((e) => { throw new Refused(`GET ${api}/v1/network failed: ${e?.message ?? e}`); });
  const net = first.body as Network | null;
  if (first.status !== 200 || !net) throw new Refused(`GET ${api}/v1/network returned ${first.status}`);
  // ---- refusals: this runner only ever talks to Arc mainnet under the restricted profile
  if (net.chainId !== 5042 || net.network !== "mainnet" || net.caip2 !== "eip155:5042") throw new Refused(`${api} reports ${net.network} / chain ${net.chainId}; this runner is mainnet-only (use scripts/selftest/testnet.ts for testnet)`);
  if (net.profile !== "SUBMISSION_RESTRICTED") throw new Refused(`profile ${net.profile}, expected SUBMISSION_RESTRICTED`);
  if (!same(net.usdc, ARC.mainnet.usdc)) throw new Refused(`USDC ${net.usdc} is not the Arc mainnet USDC ${ARC.mainnet.usdc}`);
  for (const [k, v] of Object.entries(ACCOUNTS)) if (!same((net.accounts as any)[k], v)) throw new Refused(`server ${k} ${(net.accounts as any)[k]} != the project's ${v}`);
  if (net.accounts.orderSignerRole !== "order-creator" || net.accounts.adminKeyInProcess) throw new Refused(`the API signs orders as ${net.accounts.orderSignerRole ?? "unknown"} (adminKeyInProcess=${String(net.accounts.adminKeyInProcess)}); the release requires the order-creator role with the deployer-admin key off the API (MN-01)`);
  // Gate D: the acceptance runs BEFORE public execution opens — with the operator's admin token through a gate that must still be closed
  if (net.access?.publicExecution !== false) throw new Refused(`public execution is ${net.access?.publicExecution === true ? "already open" : "not reported"} on ${api}; the mainnet acceptance must run while PUBLIC_EXECUTION=0`);
  if (net.access?.executionReady === false) throw new Refused("the instance reports executionReady=false (deployments, order signer or runner missing)");
  if (EXECUTE && !process.env.ADMIN_TOKEN) throw new Refused("--execute needs ADMIN_TOKEN: the gate stays closed during acceptance and only the operator's token passes it");
  const expectedRelease = process.env.EXPECTED_RELEASE;
  if (EXECUTE && !expectedRelease) throw new Refused("--execute needs EXPECTED_RELEASE (the release shown by /health/live) so the tested build is the one you mean");
  if (expectedRelease && expectedRelease !== net.release) throw new Refused(`server release ${net.release} != EXPECTED_RELEASE ${expectedRelease}`);

  const client = createPublicClient({ chain: arc as Chain, transport: http(rpc, { timeout: 20_000 }) }) as PublicClient;
  must((await client.getChainId()) === 5042, `RPC ${rpc} is not Arc mainnet (5042)`);
  const feeNative = BigInt(net.priceTokenAtomic) * E12, businessNative = BigInt(net.budget.amountNativeAtomic);
  const plan = planSpend({ repeats, feeNative, businessNative, capNative: cap, floorNative: floor });
  const cooldown = Number.isFinite(net.budget.clientCooldownSeconds) ? net.budget.clientCooldownSeconds! : FALLBACK_COOLDOWN_SECONDS;
  const [runnerBal, creatorBal] = await Promise.all([client.getBalance({ address: ACCOUNTS.demoRunner }), client.getBalance({ address: ACCOUNTS.orderCreator })]);

  const problems: string[] = [];
  if (!plan.withinCap) problems.push(`plan worst case ${usdc(plan.totalWorst)} USDC (fees + business + gas ceilings) exceeds the cap ${usdc(cap)}`);
  if (runnerBal < plan.runnerNeed) problems.push(`demo-runner holds ${usdc(runnerBal)} USDC, needs >= ${usdc(plan.runnerNeed)}`);
  if (creatorBal < plan.creatorNeed) problems.push(`order-creator holds ${usdc(creatorBal)} USDC, needs >= ${usdc(plan.creatorNeed)} for createOrder gas`);
  if (net.budget.usedToday + plan.runs > net.budget.maxRunsPerDay) problems.push(`daily live-run budget: ${net.budget.usedToday} used + ${plan.runs} planned > ${net.budget.maxRunsPerDay}`);
  if (net.budget.activeRun) problems.push(`a run is already active (${net.budget.activeRun})`);
  if (book) { const c = checkStep(book.plan, "acceptance", plan.totalWorst, cap); if (!c.ok) problems.push(c.reason!); }
  for (const id of FIXTURES) {
    const f = net.fixtures.find((x) => x.id === id);
    if (!f?.merchant || !f.baselineDigest) problems.push(`${id}: fixture proxy or approved baseline missing in /v1/network`);
    else if (!net.supportedTargets.some((t) => same(t, f.merchant))) problems.push(`${id}: proxy ${f.merchant} is not in supportedTargets`);
  }

  console.log(`network=${net.network} chainId=${net.chainId} release=${net.release} profile=${net.profile} mode=${EXECUTE ? "EXECUTE" : "DRY RUN (nothing will be started)"}`);
  console.log(`plan: ${repeats} round(s) x [${FIXTURES.join(", ")}] = ${plan.runs} sequential runs, one start per ${cooldown + marginS} s (~${Math.ceil((plan.runs * (cooldown + marginS)) / 60)} min)${repeats < 3 ? "  (below the G2 minimum of 3 rounds)" : ""}`);
  console.log(`spend list, worst case (project funds only; every transfer stays inside the project's own addresses):`);
  console.log(`  service fee       ${plan.runs} x ${usdc(feeNative)} = ${usdc(plan.fees)} USDC   demo-runner -> merchant-payto via x402 (the merchant relayer pays settlement gas in USDC)`);
  console.log(`  business payment  ${plan.approved} x ${usdc(businessNative)} = ${usdc(plan.business)} USDC   demo-runner -> MAIN proxy, APPROVED_PAYMENT only (owner-withdrawable)`);
  console.log(`  fee + business    ${usdc(plan.feeAndBusiness)} USDC`);
  console.log(`  fee relay gas     ${plan.runs} x <= ${usdc(RELAY_GAS_CEIL)} = ${usdc(plan.gasRelayCeil)} USDC   merchant-payto (the API's per-relay cap)`);
  console.log(`  TOTAL worst case  ${usdc(plan.totalWorst)} USDC (fees + business + all gas ceilings) · hard cap ${usdc(cap)} · stops before any run whose worst case would carry the measured outflow past it`);
  console.log(`  gas               createOrder ${plan.runs} x <=${GAS_CREATE_ORDER} gas (order-creator) + pay ${plan.approved} x <=${GAS_PAY} gas (demo-runner) at <=${Number(GAS_PRICE_CEIL) / 1e9} gwei: <= ${usdc(plan.gasCreateCeil + plan.gasPayCeil)} USDC (expected ~${usdc(plan.gasExpected)})`);
  console.log(`  demo-runner       ${usdc(runnerBal)} USDC (needs >= ${usdc(plan.runnerNeed)}: spend + server floor ${usdc(floor)} + order ${usdc(businessNative)})`);
  console.log(`  order-creator     ${usdc(creatorBal)} USDC (needs >= ${usdc(plan.creatorNeed)}; the deployer-admin key is not used by the demo)`);
  console.log(`  server budget     ${net.budget.usedToday}/${net.budget.maxRunsPerDay} runs used today, cooldown ${cooldown} s${Number.isFinite(net.budget.clientCooldownSeconds) ? "" : " (fallback, not reported)"}, active run ${net.budget.activeRun ?? "none"}`);
  if (!expectedRelease) console.log(`  EXPECTED_RELEASE not set (required for --execute); the server reports ${net.release}`);
  if (book) for (const l of book.lines()) console.log(l);
  for (const p of problems) console.log(`  PROBLEM: ${p}`);
  if (!EXECUTE) {
    console.log(problems.length ? `DRY RUN: NOT READY (${problems.length} problem(s)). Nothing was started.` : `DRY RUN OK: nothing was started. To run: API_URL=${api} EXPECTED_RELEASE=${net.release} pnpm exec tsx scripts/selftest/mainnet.ts --execute`);
    return problems.length ? 2 : 0;
  }
  if (problems.length) throw new Refused(`not ready: ${problems.join("; ")}`);

  // ---- execute. Pre-flight: the fixtures really are in the A / B states /v1/network claims (EIP-1967 slot read from the RPC), and the
  //      on-chain roles are what the release manifest says (AP32-24): owner = deployer-admin (off the API), orderCreator = the API's order key
  for (const id of FIXTURES) {
    const f = net.fixtures.find((x) => x.id === id)!;
    const impl = slotToAddress((await client.getStorageAt({ address: f.merchant as Hex, slot: SLOTS.erc1967Impl })) ?? "0x");
    if (id === "CHANGED_IMPLEMENTATION") must(same(impl, f.implementation) && !same(impl, f.approvedImplementation), `${id}: proxy implementation ${impl} must be the upgraded B (${f.implementation}), not the approved A (${f.approvedImplementation})`);
    else must(same(impl, f.approvedImplementation), `${id}: proxy implementation ${impl} != approved ${f.approvedImplementation}`);
    const [owner, creator] = await Promise.all([client.readContract({ address: f.merchant as Hex, abi: ROLE_ABI, functionName: "owner" }), client.readContract({ address: f.merchant as Hex, abi: ROLE_ABI, functionName: "orderCreator" })]);
    must(same(owner, ACCOUNTS.deployerAdmin), `${id}: proxy owner is ${owner}, expected deployer-admin ${ACCOUNTS.deployerAdmin}`);
    must(same(creator, ACCOUNTS.orderCreator), `${id}: proxy orderCreator is ${creator}, expected ${ACCOUNTS.orderCreator}`);
    must(!same(owner, creator) && !same(creator, ACCOUNTS.demoRunner) && !same(creator, ACCOUNTS.merchantPayTo), `${id}: roles must be distinct accounts`);
  }
  const ctx: Ctx = { client, chainId: 5042, usdc: ARC.mainnet.usdc, runner: ACCOUNTS.demoRunner, creator: ACCOUNTS.orderCreator, payTo: ACCOUNTS.merchantPayTo, feeAtomic6: BigInt(net.priceTokenAtomic), businessNative,
    fixtures: Object.fromEntries(FIXTURES.map((id) => [id, { merchant: net.fixtures.find((x) => x.id === id)!.merchant! }])) as Ctx["fixtures"], requiredLabels: ["LIVE_REQUEST", "DEMO_ON_MAINNET"] };
  const reports: RunReport[] = [];
  const startedAtUTC = new Date().toISOString();
  const stamp = startedAtUTC.replace(/[:.]/g, "-");
  const dir = resolve(process.env.SELFTEST_OUTPUT_DIR ?? "evidence/selftest");
  let measured: bigint | null = null;
  const save = (status: "PASS" | "INCOMPLETE", failure?: unknown) => {
    mkdirSync(dir, { recursive: true });
    const approved = reports.filter((r) => r.businessPayment.executed).length;
    const file = resolve(dir, `mainnet-${stamp}${status === "PASS" ? "" : "-INCOMPLETE"}.json`);
    writeFileSync(file, JSON.stringify({ status, chainId: 5042, network: "mainnet", release: net.release, profile: net.profile, api, startedAtUTC, finishedAtUTC: new Date().toISOString(), repeats, accounts: ACCOUNTS,
      plan: { runs: plan.runs, serviceFeeUsdc: usdc(plan.fees), businessPaymentUsdc: usdc(plan.business), capUsdc: usdc(cap), gasCeilingUsdc: usdc(plan.gasCreateCeil + plan.gasPayCeil + plan.gasRelayCeil), totalWorstUsdc: usdc(plan.totalWorst) },
      measuredOutflowUsdc: measured === null ? null : usdc(measured),
      spent: { serviceFeeUsdc: usdc(BigInt(reports.length) * feeNative), businessPaymentUsdc: usdc(BigInt(approved) * businessNative), note: "service fees land in merchant-payto, business payments in the MAIN proxy; both stay inside the project" },
      runs: reports, failure: failure ?? null }, null, 2));
    return file;
  };
  const total = plan.runs;
  // the aggregate limit, measured: the summed balances of the three project keys the runs touch (internal fee transfers net out)
  const meterAddrs = [ACCOUNTS.demoRunner, ACCOUNTS.orderCreator, ACCOUNTS.merchantPayTo] as Hex[];
  const sumBalances = async () => (await Promise.all(meterAddrs.map((a) => client.getBalance({ address: a })))).reduce((x, y) => x + y, 0n);
  // the baseline: this invocation's balances on a first start, the FIRST invocation's balances when resuming (the plan record carries it)
  const startTotal = await sumBalances();
  if (book) book.apply((p) => beginMeasured(p, "acceptance", meterAddrs, startTotal));
  const baseline = book?.plan.steps.acceptance.baselineTotalNativeAtomic ?? startTotal;
  const meter = new OutflowMeter("mainnet acceptance outflow", cap, baseline);
  if (book && baseline !== startTotal) console.log(`  resuming: measured outflow carried from the first invocation ${usdc(meter.outflow(startTotal))} USDC (baseline ${usdc(baseline)} USDC, now ${usdc(startTotal)})`);
  const syncMeasured = async () => { const t = await sumBalances(); if (book) book.apply((p) => updateMeasured(p, "acceptance", t)); return t; };
  let current: { fixture: FixtureId; runId?: string; run?: any } | null = null, lastStart = 0;
  try {
    // runs a previous invocation started and never saw finish: wait for them first (their worst case stays pending until they settle)
    for (const openRun of book?.plan.steps.acceptance.openRuns ?? []) {
      console.log(`  resuming: run ${openRun} was started by a previous invocation and is still open in the plan record — waiting for it before starting anything`);
      const r = await awaitRun(api, openRun);
      console.log(`  ${openRun}: ${r.state} ${r.outcome?.kind ?? ""}`);
      book!.apply((p) => noteOpen(p, "acceptance", openRun, false, plan.worstPerRun.approved));
      await syncMeasured();
    }
    for (let round = 1; round <= repeats; round++) {
      for (const fixture of FIXTURES) {
        const wait = lastStart ? lastStart + (cooldown + marginS) * 1000 - Date.now() : 0;
        if (wait > 0) { console.log(`  cooldown: waiting ${Math.ceil(wait / 1000)} s before the next start`); await sleep(wait); }
        const worstNow = fixture === "APPROVED_PAYMENT" ? plan.worstPerRun.approved : plan.worstPerRun.other;
        const head = meter.headroomFor(await syncMeasured(), worstNow);
        if (!head.ok) throw new Refused(head.reason!);
        if (book) { const c = checkStep(book.plan, "acceptance", worstNow, cap); if (!c.ok) throw new Refused(c.reason!); }
        console.log(`[${reports.length + 1}/${total}] ${fixture}: starting a live mainnet run (measured outflow so far ${usdc(head.outflow)} of ${usdc(cap)} USDC)`);
        current = { fixture };
        const { runId, startedAt, admission } = await startRun(api, fixture, (cooldown + marginS) * 1000);
        lastStart = startedAt; current.runId = runId;
        if (book) book.apply((p) => noteOpen(p, "acceptance", runId, true, worstNow)); // pending at its worst case until it settles
        current.run = await awaitRun(api, runId);
        if (book) book.apply((p) => noteOpen(p, "acceptance", runId, false, worstNow));
        await syncMeasured();
        const report = await verifyRun(ctx, fixture, current.run);
        report.round = round; report.admission = admission;
        report.recovery = await verifyRecovery(api, token, current.run.result);
        report.passport = await verifyRunPassport(api, current.run, rpc, net.fixtures.find((x) => x.id === fixture)!.baselineDigest!, dir);
        reports.push(report);
        console.log(JSON.stringify({ round, fixture, runId, decision: report.decision, serviceFeeTx: report.serviceFee.tx, businessTx: report.businessPayment.tx, orderPaid: report.order.paidOnChain, durationMs: report.durationMs }));
      }
    }
  } catch (e: any) {
    const failure = { message: String(e?.message ?? e), fixture: current?.fixture ?? null, runId: current?.runId ?? null, lastStep: current?.run?.steps?.at(-1)?.step ?? null,
      serviceFeeTx: current?.run?.result?.serviceFeeTx ?? null, businessTxHash: current?.run?.result?.execution?.businessTxHash ?? null };
    measured = meter.outflow(await sumBalances().catch(() => meter.startTotal));
    if (book) { try { await syncMeasured(); } catch { /* the record keeps its last reading */ } book.apply((p) => endStep(p, "acceptance", "stopped")); }
    console.error(`STOPPED after ${reports.length}/${total} verified runs: ${failure.message}`);
    console.error(`INCOMPLETE evidence (money trail of the failing run included): ${save("INCOMPLETE", failure)}`);
    return 1;
  }
  measured = meter.outflow(await syncMeasured());
  if (book) book.apply((p) => endStep(p, "acceptance", "done"));
  const file = save("PASS");
  console.log(`\n #  scenario                decision             service fee (0.01)   business payment (0.05)  order   ms      recovery`);
  reports.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}  ${r.fixture.padEnd(22)}  ${r.decision.padEnd(19)}  ${short(r.serviceFee.tx).padEnd(18)}   ${short(r.businessPayment.tx).padEnd(22)}   ${r.order.paidOnChain ? "paid  " : "unpaid"}  ${String(r.durationMs).padStart(6)}  ${r.recovery?.authenticated.split(" ")[0]}  passport ${r.passport ? `${r.passport.counts.pass} pass / ${r.passport.counts.unverified} unverified / ${r.passport.counts.fail} fail` : "—"}`));
  console.log(`PASS: ${reports.length} mainnet runs; digest chains, service fees, business payments and order states re-read from the mainnet RPC; every passport verified independently. Evidence: ${file}`);
  return 0;
}

if (process.env.MAINNET_SELFTEST_IMPORT_ONLY !== "1") process.exit(await main().catch((e) => { console.error(`${e instanceof Refused ? "REFUSED" : "FAILED"}: ${e?.message ?? e}`); return 1; }));
