import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC, type ArcNet } from "@arcpreflight/client";

const ROOT = process.env.ARCPREFLIGHT_ROOT ?? resolve(process.cwd(), "../..");
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
  port: Number(process.env.PORT ?? 4040),
  dbPath: process.env.DB_PATH ?? resolve(ROOT, `data/arcpreflight-${net}.sqlite`),
  profile: process.env.PROFILE ?? "SUBMISSION_RESTRICTED",
  releaseSha: process.env.RELEASE_SHA ?? "dev",
  /** token -> principal; external paid access is closed unless a principal is listed here */
  principals: parsePrincipals(process.env.PRINCIPAL_TOKENS),
  adminToken: process.env.ADMIN_TOKEN ?? null,
  priceTokenAtomic: process.env.PRICE_TOKEN_ATOMIC ?? "10000", // 0.01 USDC (6-dec)
  reportTtlSeconds: Number(process.env.REPORT_TTL_SECONDS ?? 60),
  quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? 30),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
  /** supported intent targets (DemoMerchant proxies) — anything else is OBJECT_OBSERVATION only */
  supportedTargets: (process.env.SUPPORTED_TARGETS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4040}`,
  merchant: loadAccount("MERCHANT_PAYTO_PRIVATE_KEY", "merchant-payto"),
  maxPreflightPerPrincipalPerDay: Number(process.env.MAX_PREFLIGHT_PER_DAY ?? 200),
};
export type Cfg = typeof cfg;
