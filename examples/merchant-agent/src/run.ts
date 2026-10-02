// CLI: ARC_NET=testnet API_URL=http://127.0.0.1:4040 RUNNER_TOKEN=... BASELINE_DIGEST_MAIN=0x... BASELINE_DIGEST_CHANGED=0x... tsx examples/merchant-agent/src/run.ts APPROVED_PAYMENT
import { getAddress, type Hex } from "viem";
import { runFixture, type Fixture } from "@arcpreflight/runner";
import { net, chain, publicClient, walletFor, account, readDeployments, writeJson, evidenceDir, feeParams } from "../../../scripts/demo/common.js";

const fixture = (process.argv[2] ?? "APPROVED_PAYMENT") as Fixture;
const which = fixture === "CHANGED_IMPLEMENTATION" ? "CHANGED" : "MAIN";
const dep = readDeployments(); if (!dep) throw new Error("no deployments file");
const baselineDigest = process.env[`BASELINE_DIGEST_${which}`] as Hex | undefined; if (!baselineDigest) throw new Error(`BASELINE_DIGEST_${which} required`);
const out = await runFixture({ fixture, net, chain, publicClient, admin: walletFor("deployer-admin"), runner: account("demo-runner"), merchant: getAddress(dep.proxies[which].address) as Hex, baselineDigest,
  apiUrl: process.env.API_URL ?? "http://127.0.0.1:4040", token: process.env.RUNNER_TOKEN ?? "", feeParams,
  onStep: (s) => console.log(`[${String(s.atMs).padStart(6)}ms] ${s.step}`, JSON.stringify(s).slice(0, 240)) });
writeJson(`${evidenceDir}/runs/${net}-${fixture}-${out.attemptId}.json`, out);
console.log(`\nRESULT fixture=${fixture} decision=${out.decision.decision} businessTx=${out.execution.businessTxHash ?? "none"} businessStatus=${out.execution.businessStatus} serviceFeeTx=${out.serviceFeeTx}`);
