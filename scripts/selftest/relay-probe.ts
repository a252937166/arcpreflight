// Bounded probe of the self-relayed check-fee path on the selected network, without the API or any fixture:
// demo-runner signs ONE EIP-3009 authorization for 0.01 USDC to merchant-payto; merchant-payto relays it to the USDC contract and
// pays the gas in USDC; the result is proven by the receipt's AuthorizationUsed + Transfer logs and written to evidence/selftest/.
// DRY RUN by default (balances, gas estimate, cost ceiling; nothing signed or sent). `--execute` is the only path that spends.
//   ARC_NET=mainnet pnpm exec tsx scripts/selftest/relay-probe.ts            # dry run
//   ARC_NET=mainnet pnpm exec tsx scripts/selftest/relay-probe.ts --execute  # one fee transfer + its gas, nothing else
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, type Hex } from "viem";
import { ARC, FIAT_TOKEN_EIP3009_ABI, signTransferAuthorization, verifyTransferAuthorization, encodeTransferWithAuthorization, findSettlementInLogs, waitForReceiptPatiently, sendIdentical } from "@arcpreflight/client";
import { net, chain, publicClient, account, feeParams, evidenceDir, ROOT } from "../demo/common.js";
import { limitsFrom, openGuard } from "../lib/spend-ledger.js";
import { openPlan } from "../lib/plan-ledger.js";
import { pinCaps, checkStep, recordGuard, beginStep, endStep, SpendRefused } from "@arcpreflight/client";

const EXECUTE = process.argv.includes("--execute");
const E18 = 10n ** 18n;
const FEE_ATOMIC6 = 10_000n; // 0.01 USDC in the ERC-20's 6-decimal units
const MAX_GAS_COST = BigInt(process.env.RELAY_MAX_FEE_ATOMIC ?? "5000000000000000"); // 0.005 USDC, the API's default cap
const RELAYER_FLOOR = BigInt(process.env.RELAY_FLOOR_ATOMIC ?? "50000000000000000"); // 0.05 USDC must remain after the probe
const usdc = (a: bigint) => `${a / E18}.${(a % E18).toString().padStart(18, "0").replace(/0+$/, "") || "0"}`;
assert.equal(process.env.ARC_NET, net, "ARC_NET must be set explicitly");

const runner = account("demo-runner"); const merchant = account("merchant-payto"); const token = ARC[net].usdc;
assert.equal(await publicClient.getChainId(), chain.id, `RPC is not ${net}`);
// Single-sender rule: this probe sends from the merchant key. It must not run while an API process relays with the same key on the
// same network (nonce collisions). PROBE_GUARD_URL names the API to check; --api-stopped overrides when you know it is down.
const guardUrl = process.env.PROBE_GUARD_URL ?? "https://arcpreflight.axiqo.xyz";
if (!process.argv.includes("--api-stopped")) {
  try {
    const n: any = await fetch(`${guardUrl}/v1/network`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const sameRelayer = n?.chainId === chain.id && n?.settlement?.backend === "relay" && String(n?.settlement?.relayer ?? "").toLowerCase() === merchant.address.toLowerCase();
    if (sameRelayer) { console.error(`REFUSED: ${guardUrl} is relaying with ${merchant.address} on chain ${chain.id}; stop that API first (or pass --api-stopped if it is already down)`); process.exit(1); }
    console.log(`guard: ${guardUrl} reports chain ${n?.chainId ?? "?"} / relayer ${n?.settlement?.relayer ?? "none"} — no conflict`);
  } catch (e: any) { console.log(`guard: ${guardUrl} not reachable (${String(e?.message ?? e).slice(0, 60)}); proceeding — make sure no API relays with this key`); }
}
const [runnerNative, merchantNative, runnerErc20] = await Promise.all([
  publicClient.getBalance({ address: runner.address }), publicClient.getBalance({ address: merchant.address }),
  publicClient.readContract({ address: token, abi: FIAT_TOKEN_EIP3009_ABI, functionName: "balanceOf", args: [runner.address] }) as Promise<bigint>,
]);
if (EXECUTE && net === "mainnet" && process.env.MAINNET_GO !== "1") { console.error("REFUSED: mainnet --execute needs MAINNET_GO=1, set only after the typed go for the probe step"); process.exit(1); }
// Gate D: nothing is signed on mainnet without the go — a mainnet dry run uses the measured gas bound instead of a signed estimate
const signNow = EXECUTE || net !== "mainnet";
const MEASURED_RELAY_GAS = 87_141n; // ≈ the testnet relay transactions (evidence/selftest/testnet-relay-probe-2026-10-07…)
let signature: Hex | null = null, authorization: Awaited<ReturnType<typeof signTransferAuthorization>>["authorization"] | null = null, data: Hex | null = null, gas: bigint, unused = true;
if (signNow) {
  ({ signature, authorization } = await signTransferAuthorization(runner, net, { payTo: merchant.address, valueTokenAtomic: FEE_ATOMIC6, validBeforeSeconds: 600 }));
  assert.deepEqual(await verifyTransferAuthorization(net, authorization, signature), { ok: true });
  unused = !(await publicClient.readContract({ address: token, abi: FIAT_TOKEN_EIP3009_ABI, functionName: "authorizationState", args: [runner.address, authorization.nonce] }));
  data = encodeTransferWithAuthorization(authorization, signature);
  gas = await publicClient.estimateGas({ account: merchant.address, to: token, data });
} else gas = MEASURED_RELAY_GAS;
const fees = await feeParams();
// the probe's spend limits: the 0.01 USDC fee (moves between two project keys) + the relay gas, per transaction and for the step
const limits = limitsFrom({ label: "relay-probe", network: net, perTxUsdc: "0.016", totalUsdc: "0.02", maxFeeGwei: 40, envPrefix: "PROBE", maxPerTxUsdc: "0.03", maxTotalUsdc: "0.05" });
const { guard, save } = openGuard(ROOT, limits, { write: EXECUTE });
// the plan ledger (review 2026-10-10, P1): pinned caps, the budget carried across steps and restarts (the fee is counted as outflow, conservatively)
const book = openPlan(ROOT, net, { write: EXECUTE });
if (net === "mainnet" && !book) throw new SpendRefused("mainnet needs the plan ledger (PLAN_ID must name the approved plan)");
if (book) pinCaps(book.plan, "probe", { totalNativeAtomic: limits.totalNativeAtomic, perTxNativeAtomic: limits.perTxNativeAtomic, maxFeePerGasCeiling: limits.maxFeePerGasCeiling }); // audit 2026-10-10 (OP-04): MAX_FEE_GWEI may lower the approved 40 gwei ceiling, never raise it
const syncPlan = () => { if (book) book.apply((p) => recordGuard(p, "probe", guard.entries)); };
const gasLimit = (gas * 12n) / 10n, costCeiling = gasLimit * fees.maxFeePerGas;
const problems: string[] = [];
if (!unused) problems.push("fresh nonce already reports authorizationState=true (should be impossible)");
if (runnerErc20 < FEE_ATOMIC6) problems.push(`demo-runner holds ${runnerErc20} (6-dec) < ${FEE_ATOMIC6}`);
if (costCeiling > MAX_GAS_COST) problems.push(`gas cost ceiling ${usdc(costCeiling)} USDC exceeds the cap ${usdc(MAX_GAS_COST)}`);
if (merchantNative - costCeiling < RELAYER_FLOOR) problems.push(`merchant-payto would drop below the relayer floor ${usdc(RELAYER_FLOOR)} USDC`);
try { guard.check({ purpose: "relay probe", tokenNativeEquivalent: FEE_ATOMIC6 * 10n ** 12n, gasLimit, maxFeePerGas: fees.maxFeePerGas }); } catch (e: any) { problems.push(e.message); }
if (book) { const c = checkStep(book.plan, "probe", FEE_ATOMIC6 * 10n ** 12n + costCeiling, limits.totalNativeAtomic); if (!c.ok) problems.push(c.reason!); }

console.log(`network=${net} chainId=${chain.id} mode=${EXECUTE ? "EXECUTE" : "DRY RUN (nothing will be sent)"}`);
console.log(`plan: ONE transferWithAuthorization on USDC ${token}`);
console.log(`  payer   demo-runner    ${runner.address}  native ${usdc(runnerNative)} USDC, erc20 ${Number(runnerErc20) / 1e6} USDC  → pays 0.01 USDC (6-dec ${FEE_ATOMIC6})`);
console.log(`  relayer merchant-payto ${merchant.address}  native ${usdc(merchantNative)} USDC  → receives 0.01 USDC, pays gas`);
console.log(`  gas ${signNow ? "estimate" : "bound (measured on testnet; nothing signed on mainnet in a dry run)"} ${gas} (limit ${gasLimit}) at ${Number(fees.maxFeePerGas) / 1e9} gwei max → cost ceiling ${usdc(costCeiling)} USDC (cap ${usdc(MAX_GAS_COST)})`);
console.log(`  spend guard: ${usdc(limits.perTxNativeAtomic)} USDC per transaction (fee + gas), ${usdc(limits.totalNativeAtomic)} USDC for the step, ${usdc(guard.committed())} already committed`);
if (book) for (const l of book.lines()) console.log(l);
if (authorization) console.log(`  authorization nonce ${authorization.nonce.slice(0, 12)}… validBefore ${authorization.validBefore} (unused on-chain: ${unused})`);
for (const p of problems) console.log(`  PROBLEM: ${p}`);
if (!EXECUTE) { console.log(problems.length ? "DRY RUN: NOT READY." : "DRY RUN OK: nothing sent. Re-run with --execute to relay this one authorization."); process.exit(problems.length ? 2 : 0); }
if (problems.length) { console.error("REFUSED: " + problems.join("; ")); process.exit(1); }

// execute: sign → record the hash BEFORE broadcasting → broadcast → prove by logs → read balances back
if (!authorization || !signature || !data) { console.error("REFUSED: no authorization was signed"); process.exit(1); }
const nonce = await publicClient.getTransactionCount({ address: merchant.address, blockTag: "pending" });
if (book) book.apply((p) => beginStep(p, "probe"));
const spendIdx = guard.reserve({ purpose: "relay probe", to: token, tokenNativeEquivalent: FEE_ATOMIC6 * 10n ** 12n, gasLimit, maxFeePerGas: fees.maxFeePerGas }); save(); syncPlan();
const raw = await merchant.signTransaction({ chainId: chain.id, type: "eip1559", to: token, data, value: 0n, nonce, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
const hash = keccak256(raw);
mkdirSync(resolve(evidenceDir, "selftest"), { recursive: true });
const file = resolve(evidenceDir, "selftest", `${net}-relay-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const record: Record<string, unknown> = { kind: "SELF_RELAYED_FEE_PROBE", network: net, chainId: chain.id, usdc: token, payer: runner.address, relayer: merchant.address, feeAtomic6: FEE_ATOMIC6.toString(),
  authorization: { ...authorization }, relayTx: { hash, nonce, gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString() }, stage: "signed", signedAtUTC: new Date().toISOString() };
writeFileSync(file, JSON.stringify(record, null, 2)); // the signature itself is never written
console.log(`signed relay tx ${hash} (nonce ${nonce}); recorded before broadcast → ${file}`);
guard.sent(spendIdx, hash); save(); syncPlan();
{ const sent = await sendIdentical(publicClient, raw, () => true, 3, 1500); if (!sent.accepted && !(await publicClient.getTransaction({ hash }).catch(() => null))) { console.error(`STOP: the node did not accept ${hash} after ${sent.attempts} attempt(s) (${sent.sendError}); the authorization stays unused until it expires; the spend ledger keeps the worst case`); process.exit(1); } }
const rc = await waitForReceiptPatiently(publicClient, hash, 90_000);
guard.settle(spendIdx, FEE_ATOMIC6 * 10n ** 12n + rc.gasUsed * rc.effectiveGasPrice); save(); syncPlan();
const evidence = findSettlementInLogs(rc.logs, { usdc: token, from: runner.address, to: merchant.address, value: FEE_ATOMIC6, nonce: authorization.nonce }, rc.transactionHash);
const [runnerAfter, merchantAfter, usedAfter] = await Promise.all([
  publicClient.getBalance({ address: runner.address }), publicClient.getBalance({ address: merchant.address }),
  publicClient.readContract({ address: token, abi: FIAT_TOKEN_EIP3009_ABI, functionName: "authorizationState", args: [runner.address, authorization.nonce] }) as Promise<boolean>,
]);
const gasPaid = rc.gasUsed * rc.effectiveGasPrice;
Object.assign(record, { stage: rc.status === "success" && evidence ? "SETTLED" : "NOT_SETTLED", receipt: { status: rc.status, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.effectiveGasPrice.toString(), gasPaidNativeAtomic: gasPaid.toString() },
  evidence, authorizationStateAfter: usedAfter, balancesNativeAtomic: { before: { payer: runnerNative.toString(), relayer: merchantNative.toString() }, after: { payer: runnerAfter.toString(), relayer: merchantAfter.toString() } }, settledAtUTC: new Date().toISOString() });
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(`receipt: status=${rc.status} block=${rc.blockNumber} gasUsed=${rc.gasUsed} gasPaid=${usdc(gasPaid)} USDC`);
console.log(`evidence: ${evidence ? `AuthorizationUsed@${evidence.authorizationUsedLogIndex} + Transfer@${evidence.transferLogIndex} in ${evidence.transactionHash}` : "MISSING — not treated as paid"}`);
console.log(`balances: payer ${usdc(runnerNative)} → ${usdc(runnerAfter)} (−0.01 expected); relayer ${usdc(merchantNative)} → ${usdc(merchantAfter)} (+0.01 − gas expected); authorizationState now ${usedAfter}`);
assert.equal(rc.status, "success"); assert.ok(evidence, "settlement logs missing"); assert.equal(usedAfter, true);
assert.equal(runnerNative - runnerAfter, FEE_ATOMIC6 * 10n ** 12n, "payer did not lose exactly 0.01 USDC");
assert.equal(merchantAfter - merchantNative, FEE_ATOMIC6 * 10n ** 12n - gasPaid, "relayer balance change is not +0.01 USDC minus gas");
if (book) book.apply((p) => endStep(p, "probe", "done"));
console.log(`PASS: one check fee self-relayed on ${net}. Evidence: ${file}`);
