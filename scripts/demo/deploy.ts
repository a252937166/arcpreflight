// Deploy DemoMerchant fixtures: impl A, impl B, MAIN proxy (stays on A), CHANGED proxy (upgraded A->B once).
// Writes fixtures/deployments-<net>.json and evidence/deploy-<net>-<ts>.json. Testnet: free rein; mainnet: run only after explicit go-ahead.
import { encodeFunctionData, keccak256, type Hex } from "viem";
import { net, chain, publicClient, walletFor, artifact, deploymentsPath, writeJson, evidenceDir, feeParams } from "./common.js";

const admin = walletFor("deployer-admin");
const runnerAddr = (await import("./common.js")).account("demo-runner").address;
console.log(`network=${net} chainId=${chain.id} deployer=${admin.account.address} runner=${runnerAddr}`);
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
// upgrade CHANGED proxy A -> B (the "unapproved change" fixture); keep the tx as evidence
const fees = await feeParams();
const upHash = await admin.writeContract({ address: changedProxy.address, abi: V1.abi, functionName: "upgradeToAndCall", args: [implB.address, "0x"], ...fees });
const upRcpt = await publicClient.waitForTransactionReceipt({ hash: upHash });
if (upRcpt.status !== "success") throw new Error("upgrade failed");
console.log(`CHANGED proxy upgraded A->B tx=${upHash} block=${upRcpt.blockNumber}`);
const deployments = {
  network: net, chainId: chain.id, deployer: admin.account.address, runner: runnerAddr, deployedAtUTC: new Date().toISOString(),
  implA, implB, proxies: { MAIN: mainProxy, CHANGED: { ...changedProxy, upgradeTx: upHash, upgradeBlock: upRcpt.blockNumber.toString(), currentImpl: implB.address } },
  compiler: { solc: "0.8.28", evm: "cancun", optimizerRuns: 200 },
};
writeJson(deploymentsPath, deployments);
writeJson(`${evidenceDir}/deploy-${net}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, deployments);
console.log("wrote", deploymentsPath);
