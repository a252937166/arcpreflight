// Guarded funding transfers between PROJECT-OWNED keys (Gate D step "fund"). PREFLIGHT BY DEFAULT (read-only: balances, nonce, fee,
// gas estimate per transfer, the plan against the caps; nothing is signed). `--execute` sends; on mainnet it also needs MAINNET_GO=1.
// Destinations are allow-listed (the project's own key roles only); every transfer goes through the spend guard (value + gas worst
// case, per-transfer cap, step total in evidence/spend/<net>-fund.json); balances are read back and must have moved by exactly the value.
//   ARC_NET=mainnet FUND_PLAN="order-creator:0.10,visitor-rehearsal:0.05" pnpm exec tsx scripts/demo/fund.ts
//   ARC_NET=mainnet MAINNET_GO=1 FUND_PLAN="…" pnpm exec tsx scripts/demo/fund.ts --execute
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { SpendRefused, parseUsdc18, waitForReceiptPatiently, sendIdentical } from "@arcpreflight/client";
import { ROOT, net, chain, rpc, publicClient, writeJson, evidenceDir, feeParams } from "./common.js";
import { limitsFrom, openGuard, usdc18 } from "../lib/spend-ledger.js";

const EXECUTE = process.argv.includes("--execute");
const ROLES = ["deployer-admin", "order-creator", "demo-runner", "merchant-payto", "visitor-rehearsal"] as const;
type Role = (typeof ROLES)[number];
const keyFile = (role: Role) => resolve(ROOT, "keys", `${role}.json`);
const addressOf = (role: Role): Hex => getAddress(JSON.parse(readFileSync(keyFile(role), "utf8")).address) as Hex; // the address field only
if (EXECUTE && net === "mainnet" && process.env.MAINNET_GO !== "1") throw new SpendRefused("mainnet --execute needs MAINNET_GO=1, set only after the typed go for the fund step");
const from = (process.env.FUND_FROM ?? "deployer-admin") as Role;
if (!ROLES.includes(from) || !existsSync(keyFile(from))) throw new SpendRefused(`FUND_FROM must be a project key role with a key file: ${ROLES.join(", ")}`);
const planText = process.env.FUND_PLAN ?? "";
if (!planText) throw new SpendRefused('FUND_PLAN is required, e.g. FUND_PLAN="order-creator:0.10,visitor-rehearsal:0.05"');
const plan = planText.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [role, amount] = x.split(":"); if (!ROLES.includes(role as Role) || role === from) throw new SpendRefused(`destination ${role} is not an allow-listed project key (or is the sender)`); if (!existsSync(keyFile(role as Role))) throw new SpendRefused(`keys/${role}.json missing`); return { role: role as Role, to: addressOf(role as Role), value: parseUsdc18(amount ?? "") }; });
const limits = limitsFrom({ label: "fund", network: net, perTxUsdc: "0.20", totalUsdc: "0.20", maxFeeGwei: 40, envPrefix: "FUND", maxPerTxUsdc: "0.50", maxTotalUsdc: "0.60" });
const { guard, save, path: ledger } = openGuard(ROOT, limits, { write: EXECUTE });
const sender = addressOf(from);
const chainId = await publicClient.getChainId(); if (chainId !== chain.id) throw new SpendRefused(`RPC serves chain ${chainId}, not ${net}`);
const [bal, nonceLatest, noncePending, fees] = await Promise.all([publicClient.getBalance({ address: sender }), publicClient.getTransactionCount({ address: sender, blockTag: "latest" }), publicClient.getTransactionCount({ address: sender, blockTag: "pending" }), feeParams()]);
const rows = [] as { role: Role; to: Hex; value: bigint; gas: bigint; gasLimit: bigint; worst: bigint; before: bigint }[];
for (const p of plan) { const gas = await publicClient.estimateGas({ account: sender, to: p.to, value: p.value }); const gasLimit = (gas * 12n + 9n) / 10n; rows.push({ ...p, gas, gasLimit, worst: p.value + gasLimit * fees.maxFeePerGas, before: await publicClient.getBalance({ address: p.to }) }); }
const problems: string[] = [];
const totalWorst = rows.reduce((a, r) => a + r.worst, 0n);
if (nonceLatest !== noncePending) problems.push(`${from} has pending transactions (nonce ${nonceLatest} vs ${noncePending})`);
if (bal < totalWorst) problems.push(`${from} holds ${usdc18(bal)} USDC, below the plan's worst case ${usdc18(totalWorst)} USDC`);
{ const dry = openGuard(ROOT, limits, { write: false }).guard; for (const r of rows) { try { dry.reserve({ purpose: `fund ${r.role}`, to: r.to, valueNativeAtomic: r.value, gasLimit: r.gasLimit, maxFeePerGas: fees.maxFeePerGas }); } catch (e: any) { problems.push(e.message); } } }
console.log(`network=${net} chainId=${chainId} mode=${EXECUTE ? "EXECUTE" : "PREFLIGHT (read-only; nothing is signed)"}`);
console.log(`from ${from} ${sender} balance ${usdc18(bal)} USDC nonce ${noncePending} · max fee ${Number(fees.maxFeePerGas) / 1e9} gwei · caps ${usdc18(limits.perTxNativeAtomic)} per transfer, ${usdc18(limits.totalNativeAtomic)} total (gas included) · ledger ${ledger} (${usdc18(guard.committed())} committed)`);
for (const r of rows) console.log(`  → ${r.role.padEnd(18)} ${r.to} +${usdc18(r.value)} USDC · gas ${r.gas} (limit ${r.gasLimit}) · worst ${usdc18(r.worst)} · balance now ${usdc18(r.before)}`);
console.log(`  total worst ${usdc18(totalWorst)} USDC`);
if (problems.length) { console.log(`NOT READY (${problems.length}):`); for (const p of problems) console.log(`  - ${p}`); process.exit(2); }
if (!EXECUTE) { console.log("PREFLIGHT OK: nothing was signed or sent."); process.exit(0); }
const account = privateKeyToAccount(JSON.parse(readFileSync(keyFile(from), "utf8")).privateKey as Hex);
if (getAddress(account.address) !== sender) throw new SpendRefused(`the ${from} key does not match its address field`);
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
let nonce = noncePending; const out: any[] = [];
for (const r of rows) {
  const f = await feeParams();
  const idx = guard.reserve({ purpose: `fund ${r.role}`, to: r.to, valueNativeAtomic: r.value, gasLimit: r.gasLimit, maxFeePerGas: f.maxFeePerGas }); save();
  let raw: Hex;
  try { raw = await wallet.signTransaction({ chain, to: r.to, value: r.value, gas: r.gasLimit, nonce, type: "eip1559", ...f } as any); } catch (e) { guard.release(idx); save(); throw e; } // nothing was sent
  const hash = keccak256(raw);
  guard.sent(idx, hash); save(); // the identical bytes may be re-sent: one hash, one nonce, never a second transfer
  const sent = await sendIdentical(publicClient, raw, () => true, 3, 1500);
  if (!sent.accepted && !(await publicClient.getTransaction({ hash }).catch(() => null))) throw new SpendRefused(`transfer to ${r.role}: the node did not accept ${hash} after ${sent.attempts} attempt(s) (${sent.sendError}) — stopping; it stays committed at its worst case in the ledger`);
  nonce++;
  const rc = await waitForReceiptPatiently(publicClient, hash, 120_000);
  const actual = r.value + rc.gasUsed * rc.effectiveGasPrice; guard.settle(idx, actual); save();
  if (rc.status !== "success") throw new SpendRefused(`transfer to ${r.role} reverted: ${hash} — stopping`);
  let after = r.before; for (let i = 0; i < 15 && after - r.before !== r.value; i++) { after = await publicClient.getBalance({ address: r.to }); if (after - r.before !== r.value) await new Promise((s) => setTimeout(s, 2000)); }
  const moved = after - r.before;
  console.log(`  ${r.role}: ${hash} block ${rc.blockNumber} gas ${rc.gasUsed} · received ${usdc18(moved)} USDC (expected ${usdc18(r.value)})${moved === r.value ? "" : " — MISMATCH"}`);
  out.push({ role: r.role, to: r.to, valueUsdc: usdc18(r.value), tx: hash, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(), costUsdc: usdc18(actual), receivedUsdc: usdc18(moved), ok: moved === r.value });
  if (moved !== r.value) throw new SpendRefused(`${r.role} received ${usdc18(moved)} USDC, expected ${usdc18(r.value)} — stopping`);
}
writeJson(`${evidenceDir}/fund-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, { network: net, from, sender, transfers: out, spend: guard.summary() });
console.log(`done · committed ${usdc18(guard.committed())} USDC of ${usdc18(limits.totalNativeAtomic)}`);
