import { cfg } from "./config.js";

export type CuratedSubject = { address: string; label: string; kind: "external" | "fixture" };

/**
 * The only addresses the unauthenticated observation route (GET /v1/subjects/{address}) will read and publish. Every accepted
 * request stores a public report, so an open route would let anyone fill the database and push the curated samples out of
 * /v1/public-reports. External objects are the public Arc/Circle contracts from the spec (§6.2); the fixture proxies are the
 * configured supported targets. Anything else is refused before any RPC read, cache or database write.
 */
const EXTERNAL: Record<"mainnet" | "testnet", { address: string; label: string }[]> = {
  mainnet: [
    { address: "0x3600000000000000000000000000000000000000", label: "USDC (ERC-20 face of native USDC)" },
    { address: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", label: "Circle GatewayWallet" },
    { address: "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6", label: "StableFX FxEscrow" },
    { address: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", label: "CCTP TokenMessengerV2" },
    { address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", label: "ERC-8004 IdentityRegistry" },
  ],
  testnet: [{ address: "0x3600000000000000000000000000000000000000", label: "USDC (ERC-20 face of native USDC)" }],
};

export function curatedSubjects(): CuratedSubject[] {
  const out = new Map<string, CuratedSubject>();
  for (const s of EXTERNAL[cfg.net] ?? []) out.set(s.address.toLowerCase(), { ...s, kind: "external" });
  for (const a of cfg.supportedTargets) if (!out.has(a.toLowerCase())) out.set(a.toLowerCase(), { address: a, label: "DemoMerchant proxy (supported intent target)", kind: "fixture" });
  return [...out.values()];
}

export const isCuratedSubject = (address: string): boolean => curatedSubjects().some((s) => s.address.toLowerCase() === address.toLowerCase());
