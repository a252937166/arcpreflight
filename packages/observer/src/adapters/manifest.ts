import { digest } from "@arcpreflight/schema";

/** An adapter manifest binds a *verified* proxy template to its exact runtime code hash.
 *  Only templates listed here can yield resolution=VERIFIED_TEMPLATE; everything else is RAW_OBSERVATION. */
export type AdapterManifest = {
  adapterId: string;
  version: string;
  template: "OZ_ERC1967Proxy_UUPS";
  knownProxyCodeHashes: `0x${string}`[];   // keccak256 of the proxy's runtime bytecode
  sourceReferences: string[];
  semanticAssumptions: string[];
};

export function manifestDigest(m: AdapterManifest): `0x${string}` {
  return digest("adapterManifest", "1.0", m);
}
