// Deploy DemoMerchant fixtures: impl A, impl B, MAIN proxy (stays on A), CHANGED proxy (upgraded A->B once), the order-creator role on both.
// PREFLIGHT BY DEFAULT (read-only: chain, deployer balance and nonce, fee, gas estimates or measured bounds, predicted addresses, the spend
// plan against the caps; nothing is signed). `--execute` deploys; on mainnet it also needs MAINNET_GO=1 (after the typed go for this step).
// Every transaction goes through the spend guard: explicit gas limit and max fee, a per-transaction cap and a step total that includes gas,
// persisted in evidence/spend/<net>-deploy.json so a re-run continues the same total. Writes fixtures/deployments-<net>.json and
// evidence/deploy-<net>-<ts>.json with the gas and cost of every transaction.
//   ARC_NET=mainnet pnpm exec tsx scripts/demo/deploy.ts                          # preflight
//   ARC_NET=mainnet MAINNET_GO=1 pnpm exec tsx scripts/demo/deploy.ts --execute   # deploy (spends gas)
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, type Hex } from "viem";
import { SpendRefused, waitForReceiptPatiently, sendIdentical } from "@arcpreflight/client";
import { ROOT, net, chain, publicClient, walletFor, artifact, deploymentsPath, writeJson, evidenceDir, feeParams } from "./common.js";
import { limitsFrom, openGuard, usdc18 } from "../lib/spend-ledger.js";

const EXECUTE = process.argv.includes("--execute");
const addressOf = (role: string): Hex => getAddress(JSON.parse(readFileSync(resolve(ROOT, "keys", `${role}.json`), "utf8")).address) as Hex; // the address field only; no key is loaded in a preflight
if (EXECUTE && net === "mainnet" && process.env.MAINNET_GO !== "1") throw new SpendRefused("mainnet --execute needs MAINNET_GO=1, set only after the typed go for the deploy step");
const limits = limitsFrom({ label: "deploy", network: net, perTxUsdc: "0.05", totalUsdc: "0.15", maxFeeGwei: 40, envPrefix: "DEPLOY", maxPerTxUsdc: "0.10", maxTotalUsdc: "0.30" });
const { guard, save, path: ledger, priorEntries } = openGuard(ROOT, limits, { write: EXECUTE });

const deployer = addressOf("deployer-admin");
const runnerAddr = addressOf("demo-runner");
const orderCreator = getAddress(process.env.ORDER_CREATOR_ADDRESS ?? addressOf("order-creator")) as Hex; // the narrow role (address only; its key is loaded by the API)
const V1 = artifact("DemoMerchantV1"), V2 = artifact("DemoMerchantV2"), PROXY = artifact("ERC1967Proxy");
// gas measured on Arc testnet for the same bytecode (receipts of the 2026-10-07 deployment: 0xdfc1a05a6b…, 0x25a4967df4…, 0x0cc49157d8…,
// 0xf6a9d6200f…, 0x350dfc4e55…, 0xcd9f2e1b0f…, 0x3955633f68…); a transaction whose live estimate exceeds 1.5 × its bound is not sent
const MEASURED: Record<string, bigint> = { implA: 1_067_071n, implB: 1_095_198n, proxyMAIN: 178_416n, proxyCHANGED: 178_416n, creatorMAIN: 52_167n, creatorCHANGED: 52_167n, upgrade: 37_633n };
const margin = (g: bigint) => (g * 12n + 9n) / 10n; // ×1.2, rounded up

const chainId = await publicClient.getChainId();
if (chainId !== chain.id) throw new SpendRefused(`RPC serves chain ${chainId}, not ${net} (${chain.id})`);
const [bal, nonceLatest, noncePending, fees] = await Promise.all([publicClient.getBalance({ address: deployer }), publicClient.getTransactionCount({ address: deployer, blockTag: "latest" }), publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }), feeParams()]);
const block = await publicClient.getBlock();
const baseFee = block.baseFeePerGas ?? 20_000_000_000n;
const predicted = { implA: getContractAddress({ from: deployer, nonce: BigInt(noncePending) }), implB: getContractAddress({ from: deployer, nonce: BigInt(noncePending + 1) }), MAIN: getContractAddress({ from: deployer, nonce: BigInt(noncePending + 2) }), CHANGED: getContractAddress({ from: deployer, nonce: BigInt(noncePending + 3) }) };
// the plan: live estimates where they do not depend on earlier deployments, measured bounds otherwise
const est = async (data: Hex, to?: Hex) => publicClient.estimateGas({ account: deployer, ...(to ? { to } : {}), data }).catch(() => null);
const [estA, estB] = await Promise.all([est(V1.bytecode.object), est(V2.bytecode.object)]);
const steps = [
  { key: "implA", label: "deploy implementation A (DemoMerchantV1)", gas: estA ?? MEASURED.implA, source: estA ? "live estimate" : "measured on testnet" },
  { key: "implB", label: "deploy implementation B (DemoMerchantV2)", gas: estB ?? MEASURED.implB, source: estB ? "live estimate" : "measured on testnet" },
  { key: "proxyMAIN", label: "deploy MAIN proxy on A", gas: MEASURED.proxyMAIN, source: "measured on testnet" },
  { key: "proxyCHANGED", label: "deploy CHANGED proxy on A", gas: MEASURED.proxyCHANGED, source: "measured on testnet" },
  { key: "creatorMAIN", label: "setOrderCreator on MAIN", gas: MEASURED.creatorMAIN, source: "measured on testnet" },
  { key: "creatorCHANGED", label: "setOrderCreator on CHANGED", gas: MEASURED.creatorCHANGED, source: "measured on testnet" },
  { key: "upgrade", label: "upgrade CHANGED proxy A -> B", gas: MEASURED.upgrade, source: "measured on testnet" },
].map((s) => ({ ...s, gasLimit: margin(s.gas), worst: margin(s.gas) * fees.maxFeePerGas, expected: s.gas * (baseFee + fees.maxPriorityFeePerGas) }));
const totalWorst = steps.reduce((a, s) => a + s.worst, 0n), totalExpected = steps.reduce((a, s) => a + s.expected, 0n);

const problems: string[] = [];
if (net === "mainnet" && existsSync(deploymentsPath)) problems.push(`${deploymentsPath} exists: refusing to redeploy over it`);
if (nonceLatest !== noncePending) problems.push(`deployer has ${noncePending - nonceLatest} pending transaction(s): nonce latest ${nonceLatest} != pending ${noncePending}`);
if (bal < totalWorst) problems.push(`deployer holds ${usdc18(bal)} USDC, below the plan's worst case ${usdc18(totalWorst)} USDC`);
const codes = await Promise.all(Object.values(predicted).map((a) => publicClient.getCode({ address: a })));
codes.forEach((c, i) => { if (c && c !== "0x") problems.push(`code already exists at the predicted address ${Object.values(predicted)[i]}`); });
// dry check of every step against the guard (per-tx cap, running total incl. this step's ledger, fee ceiling)
{ const dry = openGuard(ROOT, limits, { write: false }).guard; for (const s of steps) { try { dry.reserve({ purpose: s.label, gasLimit: s.gasLimit, maxFeePerGas: fees.maxFeePerGas }); } catch (e: any) { problems.push(e.message); } } }

console.log(`network=${net} chainId=${chainId} mode=${EXECUTE ? "EXECUTE" : "PREFLIGHT (read-only; nothing is signed)"}`);
console.log(`deployer ${deployer} balance ${usdc18(bal)} USDC · nonce ${noncePending} · runner ${runnerAddr} · orderCreator ${orderCreator}`);
console.log(`fees: base ${Number(baseFee) / 1e9} gwei · max fee sent ${Number(fees.maxFeePerGas) / 1e9} gwei · priority ${Number(fees.maxPriorityFeePerGas) / 1e9} gwei · ceiling ${Number(limits.maxFeePerGasCeiling) / 1e9} gwei`);
console.log(`caps: ${usdc18(limits.perTxNativeAtomic)} USDC per transaction · ${usdc18(limits.totalNativeAtomic)} USDC total (gas included) · ledger ${ledger} (${priorEntries} prior entr${priorEntries === 1 ? "y" : "ies"}, ${usdc18(guard.committed())} USDC committed)`);
console.log("plan:"); for (const s of steps) console.log(`  ${s.label.padEnd(44)} gas ${String(s.gas).padStart(8)} (${s.source}) · limit ${String(s.gasLimit).padStart(8)} · worst ${usdc18(s.worst).padEnd(12)} · expected ${usdc18(s.expected)}`);
console.log(`  total worst ${usdc18(totalWorst)} USDC · expected ${usdc18(totalExpected)} USDC`);
console.log(`predicted addresses: implA ${predicted.implA} · implB ${predicted.implB} · MAIN ${predicted.MAIN} · CHANGED ${predicted.CHANGED}`);
const preflight = { network: net, chainId, at: new Date().toISOString(), deployer, balanceNativeAtomic: bal.toString(), nonce: noncePending, baseFeeGwei: Number(baseFee) / 1e9, maxFeeGwei: Number(fees.maxFeePerGas) / 1e9, caps: guard.summary(), steps: steps.map((s) => ({ ...s, gas: s.gas.toString(), gasLimit: s.gasLimit.toString(), worstUsdc: usdc18(s.worst), expectedUsdc: usdc18(s.expected), worst: undefined, expected: undefined })), totalWorstUsdc: usdc18(totalWorst), totalExpectedUsdc: usdc18(totalExpected), predicted, problems };
writeJson(`${evidenceDir}/preflight/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, preflight);
if (problems.length) { console.log(`NOT READY (${problems.length}):`); for (const p of problems) console.log(`  - ${p}`); process.exit(2); }
if (!EXECUTE) { console.log("PREFLIGHT OK: nothing was signed or sent."); process.exit(0); }

// ---- execute: every transaction reserved before signing, sent with its explicit gas limit / max fee / nonce, settled from its receipt
const admin = walletFor("deployer-admin");
if (getAddress(admin.account.address) !== deployer) throw new SpendRefused("the deployer key does not match keys/deployer-admin.json's address");
let nonce = noncePending;
const txs: Record<string, any> = {};
// Every transaction is signed locally, its hash recorded, then the IDENTICAL bytes handed to the node up to 3 times: the public Arc RPC
// sometimes routes eth_sendRawTransaction to a node that refuses it ("method does not exist / is not available"); the same signed bytes
// have one hash and one nonce, so a re-send can never deploy or call twice.
async function send(key: string, label: string, bound: bigint, tx: (gas: bigint, f: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, n: number) => Promise<Hex>, estimate: () => Promise<bigint>) {
  const f = await feeParams();
  const live = await estimate();
  if (live > (bound * 15n) / 10n) throw new SpendRefused(`${label}: live gas estimate ${live} is above 1.5 × the planned ${bound} — stopping`);
  const gas = margin(live);
  const idx = guard.reserve({ purpose: label, gasLimit: gas, maxFeePerGas: f.maxFeePerGas }); save();
  let raw: Hex;
  try { raw = await tx(gas, f, nonce); } catch (e) { guard.release(idx); save(); throw e; } // failed while signing: nothing was sent
  const hash = keccak256(raw);
  guard.sent(idx, hash); save(); // from here on it may reach the network: committed at its worst case until the receipt settles it
  const sent = await sendIdentical(publicClient, raw, () => true, 3, 1500);
  if (!sent.accepted && !(await publicClient.getTransaction({ hash }).catch(() => null))) throw new SpendRefused(`${label}: the node did not accept ${hash} after ${sent.attempts} attempt(s) (${sent.sendError}); it stays committed at its worst case in the ledger — stopping; re-run the step to continue from the same nonce`);
  nonce++;
  const rcpt = await waitForReceiptPatiently(publicClient, hash, 120_000);
  const actual = rcpt.gasUsed * rcpt.effectiveGasPrice; guard.settle(idx, actual); save();
  if (rcpt.status !== "success") throw new SpendRefused(`${label} reverted: ${hash} — stopping`);
  txs[key] = { tx: hash, block: rcpt.blockNumber.toString(), gasLimit: gas.toString(), gasUsed: rcpt.gasUsed.toString(), effectiveGasPrice: rcpt.effectiveGasPrice.toString(), costUsdc: usdc18(actual), contractAddress: rcpt.contractAddress ?? null };
  console.log(`${label}: ${hash} block ${rcpt.blockNumber} gas ${rcpt.gasUsed}/${gas} cost ${usdc18(actual)} USDC${rcpt.contractAddress ? ` → ${rcpt.contractAddress}` : ""} · committed ${usdc18(guard.committed())}/${usdc18(limits.totalNativeAtomic)}`);
  return rcpt;
}
async function deploy(key: string, label: string, abi: any, bytecode: Hex, args: unknown[] = []) {
  const data = encodeDeployData({ abi, bytecode, args });
  const rcpt = await send(key, label, MEASURED[key], (gas, f, n) => admin.signTransaction({ chain, data, gas, nonce: n, value: 0n, type: "eip1559", ...f } as any), () => publicClient.estimateGas({ account: deployer, data }));
  if (!rcpt.contractAddress) throw new SpendRefused(`${label}: no contract address in the receipt`);
  const code = await publicClient.getCode({ address: rcpt.contractAddress });
  return { address: rcpt.contractAddress, tx: rcpt.transactionHash, codeHash: keccak256(code!), block: rcpt.blockNumber.toString() };
}
async function call(key: string, label: string, address: Hex, functionName: string, args: unknown[]) {
  const data = encodeFunctionData({ abi: V1.abi, functionName, args } as any);
  const rcpt = await send(key, label, MEASURED[key], (gas, f, n) => admin.signTransaction({ chain, to: address, data, gas, nonce: n, value: 0n, type: "eip1559", ...f } as any), () => publicClient.estimateGas({ account: deployer, to: address, data }));
  return { tx: rcpt.transactionHash, block: rcpt.blockNumber.toString() };
}
const implA = await deploy("implA", "implA (DemoMerchantV1)", V1.abi, V1.bytecode.object);
const implB = await deploy("implB", "implB (DemoMerchantV2)", V2.abi, V2.bytecode.object);
const initArgs = (impl: Hex) => [impl, encodeFunctionData({ abi: V1.abi, functionName: "initialize", args: [deployer] })];
const mainProxy = await deploy("proxyMAIN", "MAIN proxy (A)", PROXY.abi, PROXY.bytecode.object, initArgs(implA.address));
const changedProxy = await deploy("proxyCHANGED", "CHANGED proxy (A, to be upgraded)", PROXY.abi, PROXY.bytecode.object, initArgs(implA.address));
const mainCreator = await call("creatorMAIN", "setOrderCreator on MAIN", mainProxy.address, "setOrderCreator", [orderCreator]);
const changedCreator = await call("creatorCHANGED", "setOrderCreator on CHANGED", changedProxy.address, "setOrderCreator", [orderCreator]);
const up = await call("upgrade", "upgrade CHANGED proxy A -> B", changedProxy.address, "upgradeToAndCall", [implB.address, "0x"]);
const deployments = {
  network: net, chainId: chain.id, deployer, runner: runnerAddr, orderCreator, deployedAtUTC: new Date().toISOString(),
  implA, implB, proxies: { MAIN: { ...mainProxy, setOrderCreatorTx: mainCreator.tx, setOrderCreatorBlock: mainCreator.block }, CHANGED: { ...changedProxy, setOrderCreatorTx: changedCreator.tx, setOrderCreatorBlock: changedCreator.block, upgradeTx: up.tx, upgradeBlock: up.block, currentImpl: implB.address } },
  compiler: { solc: "0.8.28", evm: "cancun", optimizerRuns: 200 },
};
writeJson(deploymentsPath, deployments);
writeJson(`${evidenceDir}/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, { ...deployments, transactions: txs, spend: guard.summary() });
console.log(`wrote ${deploymentsPath} · spent ${usdc18(guard.committed())} USDC of the ${usdc18(limits.totalNativeAtomic)} USDC cap`);
