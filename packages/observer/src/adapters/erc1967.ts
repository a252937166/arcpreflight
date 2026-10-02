import type { PublicClient, Hex } from "viem";
import type { Snapshot, ExecutionDependency, Signal } from "@arcpreflight/schema";
import { readCode, readSlot, readCall, SLOTS, slotToAddress } from "../reads.js";
import type { AdapterManifest } from "./manifest.js";
import { manifestDigest } from "./manifest.js";
import type { RpcEvidence } from "../evidence.js";

export type ProxyObservation = {
  subject: Hex;
  proxyCodeHash: Hex | null;
  rawSlots: Record<keyof typeof SLOTS, Hex>;
  resolution: "VERIFIED_TEMPLATE" | "RAW_OBSERVATION" | "UNKNOWN";
  templateId: string | null;
  implementation: Hex | null;
  implementationCodeHash: Hex | null;
  proxiableUUIDMatches: boolean | null;
  dependencies: ExecutionDependency[];
  signals: Signal[];
  evidence: { evidence: RpcEvidence; digest: Hex }[];
  limitations: string[];
};

const PROXIABLE_UUID_SELECTOR = "0x52d1902d" as Hex; // proxiableUUID()

/** Observe a proxy subject. Raw slot values are always recorded; only a manifest-verified proxy template
 *  gets VERIFIED_TEMPLATE and a resolved implementation (spec v1.4 §5.3). */
export async function observeProxy(client: PublicClient, subject: Hex, s: Snapshot, manifests: AdapterManifest[]): Promise<ProxyObservation> {
  const evidence: ProxyObservation["evidence"] = [];
  const limitations: string[] = [];
  const code = await readCode(client, subject, s); evidence.push({ evidence: code.evidence, digest: code.evidenceDigest });
  const rawSlots = {} as Record<keyof typeof SLOTS, Hex>;
  for (const k of Object.keys(SLOTS) as (keyof typeof SLOTS)[]) {
    const r = await readSlot(client, subject, SLOTS[k], s); rawSlots[k] = r.value; evidence.push({ evidence: r.evidence, digest: r.evidenceDigest });
  }
  const deps: ExecutionDependency[] = [{ address: subject.toLowerCase() as Hex, role: "TARGET", codeHash: code.value.codeHash, adapterDigest: null, resolution: "RAW_OBSERVATION" }];
  const signals: Signal[] = [];
  const evDigests = evidence.map((e) => e.digest);

  if (!code.value.codeHash) {
    return { subject, proxyCodeHash: null, rawSlots, resolution: "UNKNOWN", templateId: null, implementation: null, implementationCodeHash: null,
      proxiableUUIDMatches: null, dependencies: deps, signals, evidence, limitations: ["subject has no code at the pinned block"] };
  }
  const manifest = manifests.find((m) => m.knownProxyCodeHashes.includes(code.value.codeHash!.toLowerCase() as Hex));
  const implFromSlot = slotToAddress(rawSlots.erc1967Impl);

  if (!manifest) {
    limitations.push("proxy code hash not in any verified adapter manifest; slots recorded as raw observation only");
    signals.push({ id: "PROXY_SLOTS_RAW", state: "observed", basis: "chain_read", scope: "ERC-1967 and ZeppelinOS slots read at pinned block; no template semantics inferred",
      evidenceDigests: evDigests, limitations: ["slot presence does not establish upgradeability or proxy kind"], sourceIds: ["eip-1967"] });
    if (implFromSlot) {
      const implCode = await readCode(client, implFromSlot, s); evidence.push({ evidence: implCode.evidence, digest: implCode.evidenceDigest });
      deps.push({ address: implFromSlot.toLowerCase() as Hex, role: "IMPLEMENTATION", codeHash: implCode.value.codeHash, adapterDigest: null, resolution: "RAW_OBSERVATION" });
    }
    return { subject, proxyCodeHash: code.value.codeHash, rawSlots, resolution: "RAW_OBSERVATION", templateId: null, implementation: implFromSlot,
      implementationCodeHash: (deps[1]?.codeHash ?? null) as Hex | null, proxiableUUIDMatches: null, dependencies: deps, signals, evidence, limitations };
  }

  // Verified template: OZ ERC1967Proxy (UUPS). Resolve implementation, read its code hash, check proxiableUUID().
  const mDigest = manifestDigest(manifest);
  deps[0] = { ...deps[0], adapterDigest: mDigest, resolution: "VERIFIED_TEMPLATE" };
  if (!implFromSlot) {
    limitations.push("verified ERC-1967 proxy but implementation slot is zero");
    return { subject, proxyCodeHash: code.value.codeHash, rawSlots, resolution: "UNKNOWN", templateId: manifest.adapterId, implementation: null, implementationCodeHash: null,
      proxiableUUIDMatches: null, dependencies: deps, signals, evidence, limitations };
  }
  const implCode = await readCode(client, implFromSlot, s); evidence.push({ evidence: implCode.evidence, digest: implCode.evidenceDigest });
  const uuid = await readCall(client, implFromSlot, PROXIABLE_UUID_SELECTOR, s); evidence.push({ evidence: uuid.evidence, digest: uuid.evidenceDigest });
  const uuidOk = uuid.value.ok && uuid.value.data?.toLowerCase() === SLOTS.erc1967Impl;
  deps.push({ address: implFromSlot.toLowerCase() as Hex, role: "IMPLEMENTATION", codeHash: implCode.value.codeHash, adapterDigest: mDigest, resolution: uuidOk ? "VERIFIED_TEMPLATE" : "RAW_OBSERVATION" });
  signals.push({ id: "PROXY_TEMPLATE_VERIFIED", state: "observed", basis: "chain_read", scope: `proxy runtime code hash matches ${manifest.adapterId}@${manifest.version}`,
    evidenceDigests: [code.evidenceDigest], limitations: ["template match covers the proxy contract only; implementation semantics are a separate question"], sourceIds: manifest.sourceReferences });
  signals.push({ id: "UUPS_PROXIABLE_UUID", state: uuidOk ? "observed" : uuid.value.ok ? "not_observed" : "unknown", basis: "simulation",
    scope: "implementation.proxiableUUID() == ERC-1967 implementation slot", evidenceDigests: [uuid.evidenceDigest],
    limitations: ["proxiableUUID only shows the implementation declares UUPS; upgrade authority is a separate check"], sourceIds: ["eip-1822", "eip-1967"] });
  if (!uuidOk) limitations.push("implementation does not return the expected proxiableUUID; treated as raw observation");
  return { subject, proxyCodeHash: code.value.codeHash, rawSlots, resolution: uuidOk ? "VERIFIED_TEMPLATE" : "RAW_OBSERVATION", templateId: manifest.adapterId,
    implementation: implFromSlot, implementationCodeHash: implCode.value.codeHash, proxiableUUIDMatches: uuidOk, dependencies: deps, signals, evidence, limitations };
}
