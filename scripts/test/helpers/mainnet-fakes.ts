// Fake ArcPreflight API and fake Arc JSON-RPC node for driving scripts/selftest/mainnet.ts end to end (review of bf0c800, P1).
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData } from "viem";
import { beginMeasured, createPlan, noteOpen, parsePlan, relabelOpen, serializePlan, updateMeasured, type PlanLedger } from "@arcpreflight/client";
import { APPROVED_CAPS } from "../../lib/plan-ledger.js";
process.env.MAINNET_SELFTEST_IMPORT_ONLY = "1";
export const { ACCOUNTS, FIXTURES } = await import("../../selftest/mainnet.js");
export type FixtureId = (typeof FIXTURES)[number];
export const MAIN = "0x1000000000000000000000000000000000000001", CHANGED = "0x1000000000000000000000000000000000000002";
export const IMPL_A = "0x2000000000000000000000000000000000000a0a", IMPL_B = "0x2000000000000000000000000000000000000b0b";
export const D = `0x${"11".repeat(32)}`;
export const E18 = 10n ** 18n;
export const word = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
export const ROLE_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { type: "function", name: "orderCreator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
export const SEL_OWNER = encodeFunctionData({ abi: ROLE_ABI, functionName: "owner" }), SEL_CREATOR = encodeFunctionData({ abi: ROLE_ABI, functionName: "orderCreator" });
// the worst case per run as planSpend computes it: fee 0.01 + (business 0.05) + createOrder 150k·40 gwei + (pay 80k·40 gwei) + relay 0.005
export const WORST_APPROVED = 74_200_000_000_000_000n, WORST_OTHER = 21_000_000_000_000_000n;

export type Json = { status: number; body: unknown } | "drop";
export async function serve(handler: (req: { method: string; url: string; body: any }) => Json | Promise<Json>) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const answer = await handler({ method: req.method ?? "GET", url: req.url ?? "/", body: text ? JSON.parse(text) : null });
      if (answer === "drop") { req.socket.destroy(); return; }
      res.writeHead(answer.status, { "content-type": "application/json" }); res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
/** Arc mainnet as the script reads it: chain 5042, balances, the fixtures' EIP-1967 slots, owner and orderCreator roles */
export function fakeRpc(balances: Record<string, bigint>) {
  return serve(({ body }) => {
    const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: body.id, result } });
    switch (body.method) {
      case "eth_chainId": return reply("0x13b2");
      case "eth_blockNumber": return reply("0x10");
      case "eth_getBalance": return reply(`0x${(balances[String(body.params[0]).toLowerCase()] ?? 0n).toString(16)}`);
      case "eth_getStorageAt": return reply(word(String(body.params[0]).toLowerCase() === CHANGED.toLowerCase() ? IMPL_B : IMPL_A));
      case "eth_call": { const data = String(body.params[0].data); if (data.startsWith(SEL_OWNER)) return reply(word(ACCOUNTS.deployerAdmin)); if (data.startsWith(SEL_CREATOR)) return reply(word(ACCOUNTS.orderCreator)); return reply("0x"); }
      default: return { status: 200, body: { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `unsupported ${body.method}` } } };
    }
  });
}
export type Api = { posts: { fixture: string; key: string }[]; bound: Map<string, { runId: string; fixture: string }>; runs: Map<string, any>; replay: ((key: string, fixture: string, n: number) => Json | null) | null; network: any };
export const networkInfo = () => ({ network: "mainnet", chainId: 5042, caip2: "eip155:5042", usdc: "0x3600000000000000000000000000000000000000", profile: "SUBMISSION_RESTRICTED", release: "abc1234", priceTokenAtomic: "10000", supportedTargets: [MAIN, CHANGED],
  accounts: { deployerAdmin: ACCOUNTS.deployerAdmin, orderCreator: ACCOUNTS.orderCreator, demoRunner: ACCOUNTS.demoRunner, merchantPayTo: ACCOUNTS.merchantPayTo, orderSignerRole: "order-creator", adminKeyInProcess: false },
  fixtures: [{ id: "CHANGED_IMPLEMENTATION", proxy: "CHANGED", merchant: CHANGED, implementation: IMPL_B, approvedImplementation: IMPL_A, baselineDigest: D }, { id: "AMOUNT_UNIT_MISMATCH", proxy: "MAIN", merchant: MAIN, implementation: IMPL_A, approvedImplementation: IMPL_A, baselineDigest: D }, { id: "APPROVED_PAYMENT", proxy: "MAIN", merchant: MAIN, implementation: IMPL_A, approvedImplementation: IMPL_A, baselineDigest: D }],
  budget: { maxRunsPerDay: 20, usedToday: 0, clientCooldownSeconds: 0, amountNativeAtomic: "50000000000000000", activeRun: null }, access: { publicExecution: false, executionReady: true, operatorAcceptance: true } });
export const doneRun = (runId: string, fixture: string) => ({ runId, fixture, state: "DONE", labels: ["LIVE_REQUEST", "DEMO_ON_MAINNET"], steps: [{ step: "createOrder", tx: D }], result: { fixture, requestId: `req-${runId}`, execution: { businessTxHash: fixture === "APPROVED_PAYMENT" ? D : null } } });
/** the demo API: admission by key (bound → 200 existing; another fixture → 409 RUN_CONFLICT; unknown → 202 new), runs by id; `replay` scripts the answers to one key */
export function fakeApi() {
  const state: Api = { posts: [], bound: new Map(), runs: new Map(), replay: null, network: networkInfo() };
  let n = 0;
  const server = serve(({ method, url, body }) => {
    if (method === "GET" && url === "/v1/network") return { status: 200, body: state.network };
    if (method === "POST" && url === "/v1/demo/run") {
      const { fixture, clientRunRequestId: key } = body; state.posts.push({ fixture, key });
      const scripted = state.replay?.(key, fixture, ++n); if (scripted) return scripted;
      const bound = state.bound.get(key);
      if (bound) return bound.fixture === fixture ? { status: 200, body: { runId: bound.runId, admission: "existing" } } : { status: 409, body: { error: "RUN_CONFLICT", reason: "key bound to another scenario" } };
      const runId = `run-${state.runs.size + 1}-${fixture}`; state.runs.set(runId, doneRun(runId, fixture)); state.bound.set(key, { runId, fixture });
      return { status: 202, body: { runId, admission: "new" } };
    }
    const m = /^\/v1\/demo\/runs\/([^/]+)$/.exec(url ?? "");
    if (method === "GET" && m) { const run = state.runs.get(m[1]); return run ? { status: 200, body: run } : { status: 404, body: { error: "NOT_FOUND" } }; }
    return { status: 404, body: { error: "NOT_FOUND", url } };
  });
  return { state, server };
}
export const addrs = [ACCOUNTS.demoRunner, ACCOUNTS.orderCreator, ACCOUNTS.merchantPayTo].map((a) => a.toLowerCase());
export const BALANCES = { [ACCOUNTS.demoRunner.toLowerCase()]: 5n * E18, [ACCOUNTS.orderCreator.toLowerCase()]: E18, [ACCOUNTS.merchantPayTo.toLowerCase()]: E18 / 2n };
export const SUM = 65n * E18 / 10n;
export const planPath = (root: string) => join(root, "evidence", "spend", "mainnet-plan-test-plan.json");
export const readPlan = (root: string) => parsePlan(readFileSync(planPath(root), "utf8"));
/** a plan record as a previous invocation left it: measured outflow `outflow` (from the carried baseline), `settled` positions with run ids, `open` ones with their key */
export function seedPlan(root: string, o: { outflow: bigint; settled?: { round: number; fixture: FixtureId; key: string; runId: string }[]; open?: { round: number; fixture: FixtureId; key: string; worst: bigint }[] }) {
  let p: PlanLedger = createPlan({ planId: "test-plan", network: "mainnet", approved: APPROVED_CAPS, now: "2026-10-11T00:00:00.000Z" });
  p = beginMeasured(p, "acceptance", addrs, SUM + o.outflow); p = updateMeasured(p, "acceptance", SUM);
  for (const s of o.settled ?? []) { const id = `run-${s.round}-${s.fixture}:key:${s.key}`; p = noteOpen(p, "acceptance", id, true, 1n); p = relabelOpen(p, "acceptance", id, `${id}:run:${s.runId}`); p = noteOpen(p, "acceptance", `${id}:run:${s.runId}`, false, 1n); }
  for (const x of o.open ?? []) p = noteOpen(p, "acceptance", `run-${x.round}-${x.fixture}:key:${x.key}`, true, x.worst);
  mkdirSync(join(root, "evidence", "spend"), { recursive: true }); writeFileSync(planPath(root), serializePlan(p));
  return p;
}
export const evidenceFiles = (root: string) => (existsSync(join(root, "out")) ? readdirSync(join(root, "out")).filter((f) => f.startsWith("mainnet-")) : []);
export const evidence = (root: string) => JSON.parse(readFileSync(join(root, "out", evidenceFiles(root)[0]), "utf8"));
