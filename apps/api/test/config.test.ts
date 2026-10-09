import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARC } from "@arcpreflight/client";

// The RPC published to visitors (GET /v1/network → the wallet's "add network") is the network's public endpoint unless
// PUBLIC_RPC_URL says otherwise; the operator's ARC_RPC_URL may be private or keyed and is never published.
// The real config module is loaded with an empty keys directory, so no key file is read.
const KEYS = ["MERCHANT_PAYTO_PRIVATE_KEY", "ORDER_CREATOR_PRIVATE_KEY", "DEPLOYER_ADMIN_PRIVATE_KEY", "DEMO_RUNNER_PRIVATE_KEY"];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
async function loadWith(env: Record<string, string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "arcpreflight-config-")); dirs.push(dir);
  for (const k of [...KEYS, "ARC_NET", "ARC_RPC_URL", "PUBLIC_RPC_URL", "KEYS_DIR", "ARCPREFLIGHT_ROOT"]) { if (!(k in saved)) saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { KEYS_DIR: dir, ARCPREFLIGHT_ROOT: dir });
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
  return (await import("../src/config.js")).cfg;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("config: the published RPC", () => {
  it("defaults to the network's public RPC even when the operator uses a private endpoint", async () => {
    const cfg = await loadWith({ ARC_NET: "testnet", ARC_RPC_URL: "https://private.invalid/v1/key" });
    expect(cfg.rpc).toBe("https://private.invalid/v1/key");
    expect(cfg.publicRpc).toBe(ARC.testnet.rpc);
    expect(cfg.merchant).toBeNull(); // no key was loaded
  });
  it("follows PUBLIC_RPC_URL, per network", async () => {
    expect((await loadWith({ ARC_NET: "testnet", PUBLIC_RPC_URL: "https://rpc.example.invalid" })).publicRpc).toBe("https://rpc.example.invalid");
    const main = await loadWith({ ARC_NET: "mainnet" });
    expect(main.publicRpc).toBe(ARC.mainnet.rpc); expect(main.rpc).toBe(ARC.mainnet.rpc);
  });
});
