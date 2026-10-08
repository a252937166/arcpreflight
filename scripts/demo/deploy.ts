// Deploy DemoMerchant fixtures: impl A, impl B, MAIN proxy (stays on A), CHANGED proxy (upgraded A->B once).
// Writes fixtures/deployments-<net>.json and evidence/deploy-<net>-<ts>.json. Testnet: free rein; mainnet: run only after explicit go-ahead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFunctionData, getAddress, keccak256, type Hex } from "viem";
import { ROOT, net, chain, publicClient, walletFor, artifact, deploymentsPath, writeJson, evidenceDir, feeParams } from "./common.js";

const admin = walletFor("deployer-admin");
const runnerAddr = (await import("./common.js")).account("demo-runner").address;
// the narrow order-creator role (address only; its key is loaded by the API, never here)
const orderCreator = getAddress(process.env.ORDER_CREATOR_ADDRESS ?? JSON.parse(readFileSync(resolve(ROOT, "keys", "order-creator.json"), "utf8")).address) as Hex;
console.log(`network=${net} chainId=${chain.id} deployer=${admin.account.address} runner=${runnerAddr} orderCreator=${orderCreator}`);
const bal = await publicClient.getBalance({ address: admin.account.address });
console.log(`deployer native USDC balance: ${Number(bal) / 1e18}`);
if (bal < 2n * 10n ** 17n) throw new Error("deployer needs at least 0.2 USDC (native) for deployments");

const V1 = artifact("DemoMerchantV1"), V2 = artifact("DemoMerchantV2"), PROXY = artifact("ERC1967Proxy");
async function deploy(label: string, abi: any, bytecode: Hex, args: unknown[] = []) {
  const fees = await feeParams();
  const hash = await admin.deployContract({ abi, bytecode, args, ...fees });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`${label} deploy failed: ${hash}`);
  const code = await publicClient.getCode({ address: rcpt.contractAddress });
  console.log(`${label}: ${rcpt.contractAddress} tx=${hash} codeHash=${keccak256(code!)}`);
  return { address: rcpt.contractAddress, tx: hash, codeHash: keccak256(code!), block: rcpt.blockNumber.toString() };
}
const implA = await deploy("implA (DemoMerchantV1)", V1.abi, V1.bytecode.object);
const implB = await deploy("implB (DemoMerchantV2)", V2.abi, V2.bytecode.object);
const init = encodeFunctionData({ abi: V1.abi, functionName: "initialize", args: [admin.account.address] });
const mainProxy = await deploy("MAIN proxy (A)", PROXY.abi, PROXY.bytecode.object, [implA.address, init]);
const changedProxy = await deploy("CHANGED proxy (A, to be upgraded)", PROXY.abi, PROXY.bytecode.object, [implA.address, init]);
// grant the order-creator role on both proxies (owner-only call; the role can only create orders)
async function setCreator(label: string, proxy: Hex) {
  const hash = await admin.writeContract({ address: proxy, abi: V1.abi, functionName: "setOrderCreator", args: [orderCreator], ...(await feeParams()) });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label}: setOrderCreator failed: ${hash}`);
  console.log(`${label}: orderCreator=${orderCreator} tx=${hash} block=${rcpt.blockNumber}`);
  return { tx: hash, block: rcpt.blockNumber.toString() };
}
const mainCreator = await setCreator("MAIN proxy", mainProxy.address);
const changedCreator = await setCreator("CHANGED proxy", changedProxy.address);
// upgrade CHANGED proxy A -> B (the "unapproved change" fixture); keep the tx as evidence
const fees = await feeParams();
const upHash = await admin.writeContract({ address: changedProxy.address, abi: V1.abi, functionName: "upgradeToAndCall", args: [implB.address, "0x"], ...fees });
const upRcpt = await publicClient.waitForTransactionReceipt({ hash: upHash });
if (upRcpt.status !== "success") throw new Error("upgrade failed");
console.log(`CHANGED proxy upgraded A->B tx=${upHash} block=${upRcpt.blockNumber}`);
const deployments = {
  network: net, chainId: chain.id, deployer: admin.account.address, runner: runnerAddr, orderCreator, deployedAtUTC: new Date().toISOString(),
  implA, implB, proxies: { MAIN: { ...mainProxy, setOrderCreatorTx: mainCreator.tx, setOrderCreatorBlock: mainCreator.block }, CHANGED: { ...changedProxy, setOrderCreatorTx: changedCreator.tx, setOrderCreatorBlock: changedCreator.block, upgradeTx: upHash, upgradeBlock: upRcpt.blockNumber.toString(), currentImpl: implB.address } },
  compiler: { solc: "0.8.28", evm: "cancun", optimizerRuns: 200 },
};
writeJson(deploymentsPath, deployments);
writeJson(`${evidenceDir}/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, deployments);
console.log("wrote", deploymentsPath);
