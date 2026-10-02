export const ARC = {
  mainnet: { chainId: 5042, caip2: "eip155:5042" as const, usdc: "0x3600000000000000000000000000000000000000" as const, rpc: "https://rpc.mainnet.arc.io" },
  testnet: { chainId: 5042002, caip2: "eip155:5042002" as const, usdc: "0x3600000000000000000000000000000000000000" as const, rpc: "https://rpc.testnet.arc.io" },
} as const;
export type ArcNet = keyof typeof ARC;
export const FACILITATOR_BASE = "https://api.circle.com/v1/facilitator/x402";
/** USDC (FiatToken v2.x) EIP-712 domain used by EIP-3009 on Arc. Verified against DOMAIN_SEPARATOR() in tests. */
export const usdcDomain = (net: ArcNet) => ({ name: "USDC", version: "2", chainId: ARC[net].chainId, verifyingContract: ARC[net].usdc });
