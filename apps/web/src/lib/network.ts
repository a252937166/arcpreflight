// Network identity is release configuration, never branding (design v3.2 §4.7). The site can front two instances of the same
// API bundle: the root (the submission network — Arc mainnet after the cutover) and a second one under /testnet. Everything the
// app labels comes from what an instance REPORTS in /v1/network; the path only says where to ask. Judges inspect mainnet proof
// on one side and run zero-cost demos on the other, from one static site.
import type { NetworkInfo } from "./api";

export type NetChoice = "mainnet" | "testnet";
/** API base paths this site may front: the root, and the testnet instance nginx (or the Vite proxy) serves under /testnet. */
export const BASES: readonly string[] = ["", "/testnet"];
export type Instance = { base: string; network: NetChoice; chainId: number; caip2: string; release: string };
export const CHOICE_KEY = "arcpreflight.net";
export const isChoice = (v: unknown): v is NetChoice => v === "mainnet" || v === "testnet";
export const netName = (n: NetChoice | string | null | undefined) => (n === "mainnet" ? "Arc mainnet" : n === "testnet" ? "Arc testnet" : "Arc");

/** Ask every base for its /v1/network, in parallel. An instance that does not answer (404, transport error, non-JSON, no
 *  recognisable network) is simply absent — the site then runs with whatever did answer. */
export async function discoverInstances(fetchImpl: typeof fetch = fetch, bases: readonly string[] = BASES): Promise<Instance[]> {
  const found = await Promise.all(bases.map(async (base): Promise<Instance | null> => {
    try {
      const r = await fetchImpl(`${base}/v1/network`, { headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j: any = await r.json();
      if (!isChoice(j?.network) || typeof j.chainId !== "number") return null;
      return { base, network: j.network, chainId: j.chainId, caip2: String(j.caip2 ?? ""), release: String(j.release ?? "") };
    } catch { return null; }
  }));
  return found.filter((x): x is Instance => x !== null);
}

export const netParam = (search: string): NetChoice | null => { try { const v = new URLSearchParams(search).get("net"); return isChoice(v) ? v : null; } catch { return null; } };
export function storedChoice(): NetChoice | null { try { const v = localStorage.getItem(CHOICE_KEY); return isChoice(v) ? v : null; } catch { return null; } }
export function persistChoice(c: NetChoice) { try { localStorage.setItem(CHOICE_KEY, c); } catch { /* storage unavailable: the choice lives for this page only */ } }
/** Resolution order: `?net=` in the URL, then the remembered choice, then mainnet. */
export const readChoice = (search: string): NetChoice => netParam(search) ?? storedChoice() ?? "mainnet";

/** The instance that REPORTS the chosen network (the root first when two report the same); otherwise the root instance,
 *  shown with its real network; otherwise whatever answered. Never a label derived from the path. */
export function selectInstance(instances: readonly Instance[], choice: NetChoice): Instance | null {
  return instances.find((i) => i.network === choice) ?? instances.find((i) => i.base === "") ?? instances[0] ?? null;
}
export const availableNetworks = (instances: readonly Instance[]): NetChoice[] => (["mainnet", "testnet"] as NetChoice[]).filter((n) => instances.some((i) => i.network === n));
/** The toggle only exists when two different networks answer; one network = the pill alone. */
export const toggleVisible = (instances: readonly Instance[]) => availableNetworks(instances).length >= 2;

/** Internal links carry ?net=<reported network> whenever the selected instance is not the root, so a shared link opens the same backend. */
export function withNet(to: string, selected: Instance | null): string {
  if (!selected || selected.base === "") return to;
  const [path, query = ""] = to.split("?");
  const sp = new URLSearchParams(query); sp.set("net", selected.network);
  return `${path}?${sp.toString()}`;
}
/** Where a switch should land: records (runs, subjects) are per instance, so leave them for their section. */
export function landingFor(pathname: string): string {
  if (pathname.startsWith("/runs/")) return "/demo";
  if (pathname.startsWith("/subjects/")) return "/inspect";
  return pathname;
}

export type NetworkNotice = { tone: "warn" | "info"; text: string };
/** The one line the site says about the selected instance, read from what it reports (capabilities included). */
export function networkNotice(net: NetworkInfo | null, instances: readonly Instance[]): NetworkNotice | null {
  if (!net) return null;
  if (net.network === "testnet") {
    return availableNetworks(instances).includes("mainnet")
      ? { tone: "warn", text: "Arc testnet — zero-cost demos on the project's testnet funds; mainnet proof lives on the mainnet side." }
      : { tone: "warn", text: "testnet preview — mainnet is the release target. Runs, fees and passports on this site are Arc testnet facts, not mainnet evidence." };
  }
  const verified = (net.capabilities ?? []).some((c) => c.status === "MAINNET_VERIFIED");
  return verified ? null : { tone: "info", text: "Arc mainnet — acceptance evidence pending; labels say IMPLEMENTED_TESTNET until it exists." };
}
