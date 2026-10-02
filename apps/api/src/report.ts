import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, getAddress, type Hex, type PublicClient } from "viem";
import { ReportCore, reportDigest, type IntentCore, type BaselineCore, type Signal, type ExecutionDependency } from "@arcpreflight/schema";
import { captureSnapshot, observeProxy, readCall, type RpcEvidence } from "@arcpreflight/observer";
import { cfg } from "./config.js";
import { adapterManifests, adapterManifestDigests, methodologyDigest, arcAdvisorySignals, DEMO_MERCHANT_TEMPLATE_ABI } from "./manifests.js";

export const client: PublicClient = createPublicClient({ transport: http(cfg.rpc, { timeout: 15_000 }) });

export type BuiltReport = { report: ReportCore; digest: Hex; evidence: { evidence: RpcEvidence; digest: Hex }[]; simulation: { ok: boolean; error: string | null } | null };

const addSeconds = (iso: string, s: number) => new Date(new Date(iso).getTime() + s * 1000).toISOString();

/** OBJECT_OBSERVATION: raw facts about any address; never decision-eligible. */
export async function buildObjectReport(subject: Hex): Promise<BuiltReport> {
  const snapshot = await captureSnapshot(client, { providerId: cfg.rpc });
  const proxy = await observeProxy(client, subject, snapshot, adapterManifests);
  const signals: Signal[] = [...proxy.signals, ...arcAdvisorySignals];
  const report = ReportCore.parse({
    schemaVersion: "1.0", mode: "OBJECT_OBSERVATION", intentDigest: null, decisionEligible: false, observation: snapshot,
    methodologyDigest, adapterManifestDigests, baselineDigest: null, baselineResult: "NO_BASELINE",
    dependencies: proxy.dependencies, signals, rawEvidenceDigests: proxy.evidence.map((e) => e.digest),
    exclusions: ["no business intent supplied; no decision semantics", ...proxy.limitations], expiresAt: addSeconds(snapshot.observedAt, cfg.reportTtlSeconds),
  });
  return { report, digest: reportDigest(report), evidence: proxy.evidence, simulation: null };
}

/** SUPPORTED_INTENT: pinned observation of the exact target + baseline comparison + supported-state reads + exact-call simulation. */
export async function buildIntentReport(intent: IntentCore, intentDigest: Hex, baseline: BaselineCore | null, baselineDigest: Hex | null): Promise<BuiltReport> {
  const subject = getAddress(intent.to) as Hex;
  const snapshot = await captureSnapshot(client, { providerId: cfg.rpc });
  const proxy = await observeProxy(client, subject, snapshot, adapterManifests);
  const evidence: { evidence: RpcEvidence; digest: Hex }[] = [...proxy.evidence];
  const signals: Signal[] = [...proxy.signals];
  const exclusions: string[] = [...proxy.limitations];
  const deps: ExecutionDependency[] = proxy.dependencies;

  // Baseline comparison (EXECUTION_IDENTITY input)
  let baselineResult: ReportCore["baselineResult"] = "NO_BASELINE";
  if (baseline) {
    const approvedImpl = baseline.dependencies.find((d) => d.role === "IMPLEMENTATION");
    const approvedTarget = baseline.dependencies.find((d) => d.role === "TARGET");
    const curImpl = deps.find((d) => d.role === "IMPLEMENTATION");
    const curTarget = deps.find((d) => d.role === "TARGET");
    if (proxy.resolution !== "VERIFIED_TEMPLATE" || !curImpl?.codeHash) baselineResult = "UNKNOWN";
    else if (!approvedImpl?.codeHash) baselineResult = "UNKNOWN";
    else if (approvedTarget?.codeHash && curTarget?.codeHash && approvedTarget.codeHash !== curTarget.codeHash) baselineResult = "IMPLEMENTATION_CHANGED";
    else if (approvedImpl.address !== curImpl.address || approvedImpl.codeHash !== curImpl.codeHash) baselineResult = "IMPLEMENTATION_CHANGED";
    else if (baseline.adapterManifestDigests.length && !baseline.adapterManifestDigests.every((d) => adapterManifestDigests.includes(d))) baselineResult = "ADAPTER_CHANGED";
    else baselineResult = "MATCH";
  }

  // Supported-state reads (DemoMerchant template): paused(), getOrder(orderId), version()
  const decisionEligible = proxy.resolution === "VERIFIED_TEMPLATE" && intent.businessExpectation.action === "MERCHANT_PAY";
  if (intent.businessExpectation.action === "MERCHANT_PAY") {
    const paused = await readCall(client, subject, encodeFunctionData({ abi: DEMO_MERCHANT_TEMPLATE_ABI, functionName: "paused" }), snapshot);
    evidence.push({ evidence: paused.evidence, digest: paused.evidenceDigest });
    const pausedVal = paused.value.ok && paused.value.data ? (decodeFunctionResult({ abi: DEMO_MERCHANT_TEMPLATE_ABI, functionName: "paused", data: paused.value.data }) as boolean) : null;
    signals.push({ id: "SUPPORTED_STATE_PAUSED", state: pausedVal === null ? "unknown" : pausedVal ? "observed" : "not_observed", basis: "chain_read",
      scope: "DemoMerchant.paused() at pinned block", evidenceDigests: [paused.evidenceDigest], limitations: pausedVal === null ? ["paused() call failed"] : [], sourceIds: ["demo-merchant-v1-template"] });
    const order = await readCall(client, subject, encodeFunctionData({ abi: DEMO_MERCHANT_TEMPLATE_ABI, functionName: "getOrder", args: [intent.businessExpectation.orderId as Hex] }), snapshot);
    evidence.push({ evidence: order.evidence, digest: order.evidenceDigest });
    let orderState: "unknown" | "observed" | "not_observed" = "unknown"; const lim: string[] = [];
    if (order.value.ok && order.value.data) {
      const [payer, amount, paid] = decodeFunctionResult({ abi: DEMO_MERCHANT_TEMPLATE_ABI, functionName: "getOrder", data: order.value.data }) as readonly [Hex, bigint, boolean, bigint, bigint];
      const expectOk = payer.toLowerCase() === intent.from.toLowerCase() && amount.toString() === intent.businessExpectation.amountNativeAtomic && !paid;
      orderState = expectOk ? "observed" : "not_observed";
      if (payer === "0x0000000000000000000000000000000000000000") lim.push("order does not exist at pinned block");
      if (paid) lim.push("order already paid at pinned block");
      if (payer.toLowerCase() !== intent.from.toLowerCase() && payer !== "0x0000000000000000000000000000000000000000") lim.push("order payer differs from intent sender");
      if (amount.toString() !== intent.businessExpectation.amountNativeAtomic) lim.push(`onchain order amount ${amount} != approved ${intent.businessExpectation.amountNativeAtomic}`);
    } else lim.push("getOrder() call failed");
    signals.push({ id: "SUPPORTED_STATE_ORDER_PAYABLE", state: orderState, basis: "chain_read", scope: "DemoMerchant.getOrder(orderId): exists, unpaid, payer==sender, amount==approved",
      evidenceDigests: [order.evidenceDigest], limitations: lim, sourceIds: ["demo-merchant-v1-template"] });
  }

  // CALL_SIMULATION of the exact candidate call (from/to/data/value) at the pinned block
  const sim = await readCall(client, subject, intent.data as Hex, snapshot, intent.from as Hex, BigInt(intent.valueNativeAtomic));
  evidence.push({ evidence: sim.evidence, digest: sim.evidenceDigest });
  signals.push({ id: "CALL_SIMULATION", state: sim.value.ok ? "observed" : "not_observed", basis: "simulation",
    scope: "eth_call with the exact sender, target, calldata and value at the pinned block", evidenceDigests: [sim.evidenceDigest],
    limitations: sim.value.ok ? ["simulation success is not a guarantee of future inclusion or success"] : [`revert: ${sim.value.error}`], sourceIds: ["https://ethereum.org/developers/docs/apis/json-rpc/"] });
  signals.push(...arcAdvisorySignals);

  const report = ReportCore.parse({
    schemaVersion: "1.0", mode: "SUPPORTED_INTENT", intentDigest, decisionEligible, observation: snapshot, methodologyDigest, adapterManifestDigests,
    baselineDigest, baselineResult, dependencies: deps, signals, rawEvidenceDigests: evidence.map((e) => e.digest),
    exclusions: [...exclusions, "external oracles, delegatecall targets beyond two levels, and full storage are not covered"],
    expiresAt: addSeconds(snapshot.observedAt, cfg.reportTtlSeconds),
  });
  return { report, digest: reportDigest(report), evidence, simulation: { ok: sim.value.ok, error: sim.value.error } };
}
