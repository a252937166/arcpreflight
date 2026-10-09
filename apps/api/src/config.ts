import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC, type ArcNet } from "@arcpreflight/client";

// repo root: apps/api/src/config.ts and apps/api/dist/server.mjs are both three levels below it
const ROOT = process.env.ARCPREFLIGHT_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url));
function keyFromFile(role: string): `0x${string}` | null {
  const f = resolve(process.env.KEYS_DIR ?? resolve(ROOT, "keys"), `${role}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")).privateKey;
}
function loadAccount(envName: string, role: string): PrivateKeyAccount | null {
  const pk = (process.env[envName] as `0x${string}` | undefined) ?? keyFromFile(role);
  return pk ? privateKeyToAccount(pk) : null;
}
function parsePrincipals(s: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = pair.indexOf(":"); if (i > 0) m.set(pair.slice(i + 1), pair.slice(0, i)); // token -> principal
  }
  return m;
}

export const net = (process.env.ARC_NET ?? "testnet") as ArcNet;
export const cfg = {
  root: ROOT,
  net,
  chainId: ARC[net].chainId,
  caip2: ARC[net].caip2,
  usdc: ARC[net].usdc,
  rpc: process.env.ARC_RPC_URL ?? ARC[net].rpc,
  /** the RPC published to visitors (GET /v1/network → wallet "add network"): the network's public endpoint unless PUBLIC_RPC_URL says
   *  otherwise — never the operator's own ARC_RPC_URL, which may be a private or keyed endpoint */
  publicRpc: process.env.PUBLIC_RPC_URL ?? ARC[net].rpc,
  port: Number(process.env.PORT ?? 4040),
  dbPath: process.env.DB_PATH ?? resolve(ROOT, `data/arcpreflight-${net}.sqlite`),
  profile: process.env.PROFILE ?? "SUBMISSION_RESTRICTED",
  releaseSha: process.env.RELEASE_SHA ?? "dev",
  /** token -> principal; external paid access is closed unless a principal is listed here */
  principals: parsePrincipals(process.env.PRINCIPAL_TOKENS),
  adminToken: process.env.ADMIN_TOKEN ?? null,
  priceTokenAtomic: process.env.PRICE_TOKEN_ATOMIC ?? "10000", // 0.01 USDC (6-dec)
  /** a delivered report stays usable this long after its pinned observation (design v3.3: human-paced — a visitor reads the decision
   *  and answers a wallet prompt; the final validation re-reads the critical state at a fresh block before anything is executed) */
  reportTtlSeconds: Number(process.env.REPORT_TTL_SECONDS ?? 300),
  quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? 30),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
  /** supported intent targets (DemoMerchant proxies) — anything else is OBJECT_OBSERVATION only */
  supportedTargets: (process.env.SUPPORTED_TARGETS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4040}`,
  merchant: loadAccount("MERCHANT_PAYTO_PRIVATE_KEY", "merchant-payto"),
  maxPreflightPerPrincipalPerDay: Number(process.env.MAX_PREFLIGHT_PER_DAY ?? 200),
  /** the recovery worker: the only periodic sender (relay rebroadcast/re-sign, identical-bytes rebroadcast of business transactions) */
  recoveryIntervalMs: Number(process.env.RECOVERY_INTERVAL_MS ?? 30_000),
  /** set by the operator only after the mainnet acceptance evidence exists; flips capability labels to MAINNET_VERIFIED */
  mainnetVerified: process.env.MAINNET_VERIFIED === "1",
  /** public business execution (live runs, wallet attempts). Default: on for testnet, OFF on mainnet until the operator sets
   *  PUBLIC_EXECUTION=1 after the mainnet acceptance; while off, those routes answer 503 EXECUTION_GATED unless the request
   *  carries the admin token (the acceptance scripts), so the gate itself cannot block the evidence it waits for */
  publicExecution: process.env.PUBLIC_EXECUTION !== undefined ? process.env.PUBLIC_EXECUTION === "1" : net !== "mainnet",
  /** testnet only: a budgeted faucet paid from the order-creator key so a visitor's wallet can buy a check with its own signature */
  faucet: {
    enabled: process.env.FAUCET_ENABLED !== "0",
    amountNativeAtomic: BigInt(process.env.FAUCET_AMOUNT_ATOMIC ?? "200000000000000000"), // 0.2 testnet USDC per claim
    perDay: Number(process.env.FAUCET_PER_DAY ?? 30),
    floorNativeAtomic: BigInt(process.env.FAUCET_FLOOR_ATOMIC ?? "1000000000000000000"), // keep ≥ 1 USDC for order creation
  },

  /** self-relayed EIP-3009 settlement of the check fee (merchant account pays gas in USDC) */
  relay: {
    floorNativeAtomic: BigInt(process.env.RELAY_FLOOR_ATOMIC ?? "50000000000000000"), // 0.05 USDC: below this, new fee settlements pause
    maxFeeNativeAtomic: BigInt(process.env.RELAY_MAX_FEE_ATOMIC ?? "5000000000000000"), // 0.005 USDC per relay transaction (observed on testnet: ≈ 87k gas ≈ 0.0018 USDC at 21 gwei; the cap trips above ≈ 48 gwei)
    receiptTimeoutMs: Number(process.env.RELAY_RECEIPT_TIMEOUT_MS ?? 12_000),
    scanChunkBlocks: Number(process.env.RELAY_SCAN_CHUNK_BLOCKS ?? 9_000), // the public RPC refuses eth_getLogs ranges above 10k blocks
    scanChunksPerCall: Number(process.env.RELAY_SCAN_CHUNKS_PER_CALL ?? 3),
  },
};
export type Cfg = typeof cfg;
