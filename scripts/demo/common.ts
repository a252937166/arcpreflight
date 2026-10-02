import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import { ARC, type ArcNet } from "@arcpreflight/client";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const net = (process.env.ARC_NET ?? "testnet") as ArcNet;
export const chain: Chain = net === "mainnet" ? arc : arcTestnet;
export const rpc = process.env.ARC_RPC_URL ?? ARC[net].rpc;
export const publicClient = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
export function account(role: "deployer-admin" | "merchant-payto" | "demo-runner") {
  const envName = { "deployer-admin": "DEPLOYER_ADMIN_PRIVATE_KEY", "merchant-payto": "MERCHANT_PAYTO_PRIVATE_KEY", "demo-runner": "DEMO_RUNNER_PRIVATE_KEY" }[role];
  const pk = (process.env[envName] as Hex | undefined) ?? JSON.parse(readFileSync(resolve(ROOT, "keys", `${role}.json`), "utf8")).privateKey;
  return privateKeyToAccount(pk);
}
export const walletFor = (role: Parameters<typeof account>[0]) => createWalletClient({ account: account(role), chain, transport: http(rpc, { timeout: 20_000 }) });
export const artifact = (name: string) => JSON.parse(readFileSync(resolve(ROOT, "packages/contracts/out", `${name}.sol`, `${name}.json`), "utf8"));
export const deploymentsPath = resolve(ROOT, "fixtures", `deployments-${net}.json`);
export const readDeployments = (): any => (existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, "utf8")) : null);
export function writeJson(path: string, data: unknown) { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2)); }
export const evidenceDir = resolve(ROOT, "evidence");
/** Arc: maxFeePerGas must be >= 20 gwei; take the network estimate and floor it. */
export async function feeParams() {
  const f = await publicClient.estimateFeesPerGas();
  const floor = 20_000_000_000n;
  const maxFeePerGas = f.maxFeePerGas && f.maxFeePerGas > floor ? f.maxFeePerGas : floor + 1_000_000_000n;
  const maxPriorityFeePerGas = f.maxPriorityFeePerGas ?? 1_000_000_000n;
  return { maxFeePerGas, maxPriorityFeePerGas };
}
