// Approve a baseline for a proxy: observe at a pinned block, record TARGET + IMPLEMENTATION code hashes.
// Usage: ARC_NET=testnet API_URL=http://127.0.0.1:4040 ADMIN_TOKEN=... tsx scripts/demo/approve-baseline.ts MAIN|CHANGED [--pin-implementation 0x...]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Hex } from "viem";
import { BaselineCore, baselineDigest } from "@arcpreflight/schema";
import { captureSnapshot, observeProxy, manifestDigest } from "@arcpreflight/observer";
import { PAY_SELECTOR } from "@arcpreflight/policy";
import { publicClient, readDeployments, ROOT, net, writeJson, evidenceDir } from "./common.js";

const which = (process.argv[2] ?? "MAIN") as "MAIN" | "CHANGED";
const pinIdx = process.argv.indexOf("--pin-implementation");
const dep = readDeployments(); if (!dep) throw new Error("no deployments file");
const subject = getAddress(dep.proxies[which].address) as Hex;
const manifests = JSON.parse(readFileSync(resolve(ROOT, "fixtures/adapters.json"), "utf8"));
const snapshot = await captureSnapshot(publicClient as any, { providerId: process.env.ARC_RPC_URL ?? `rpc.${net}` });
const obs = await observeProxy(publicClient as any, subject, snapshot, manifests);
if (obs.resolution !== "VERIFIED_TEMPLATE") throw new Error(`proxy not verified template: ${obs.resolution} ${obs.limitations.join("; ")}`);
// For CHANGED we approve implementation A (the historical, pre-upgrade implementation) so the live state shows an unapproved change.
let implAddr = obs.implementation!, implHash = obs.implementationCodeHash!;
if (pinIdx > 0) { implAddr = getAddress(process.argv[pinIdx + 1]) as Hex; const code = await publicClient.getCode({ address: implAddr, blockNumber: BigInt(snapshot.blockNumber) }); const { keccak256 } = await import("viem"); implHash = keccak256(code!); }
const baseline = BaselineCore.parse({
  schemaVersion: "1.0", chainId: snapshot.chainId, subject: subject.toLowerCase(), approvedBy: "deployer-admin", approvedAt: new Date().toISOString(), validUntil: null, previousBaselineDigest: null,
  referenceSnapshot: snapshot,
  dependencies: [
    { address: subject.toLowerCase(), role: "TARGET", codeHash: obs.proxyCodeHash, adapterDigest: manifestDigest(manifests[0]), resolution: "VERIFIED_TEMPLATE" },
    { address: implAddr.toLowerCase(), role: "IMPLEMENTATION", codeHash: implHash, adapterDigest: manifestDigest(manifests[0]), resolution: "VERIFIED_TEMPLATE" },
  ],
  allowedSelectors: [PAY_SELECTOR], adapterManifestDigests: [manifestDigest(manifests[0])], approvedState: [{ key: "paused", canonicalValue: "false" }],
});
const d = baselineDigest(baseline);
const api = process.env.API_URL ?? "http://127.0.0.1:4040";
const r = await fetch(`${api}/v1/admin/baselines`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": process.env.ADMIN_TOKEN ?? "" }, body: JSON.stringify({ baseline }) });
console.log("api:", r.status, await r.text());
writeJson(`${evidenceDir}/baseline-${net}-${which}-${d.slice(2, 10)}.json`, { baseline, baselineDigest: d, approvedImplementation: implAddr, liveImplementationAtApproval: obs.implementation });
console.log(`baseline ${which} subject=${subject} impl=${implAddr} digest=${d}`);
