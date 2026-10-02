// Read-only integration test against Arc mainnet (no signing, no funds). Official Circle objects must come back
// as RAW_OBSERVATION (their minimal proxies are not in our verified manifest) with recorded slots.
import { describe, it, expect } from "vitest";
import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";
import { captureSnapshot, observeProxy, slotToAddress } from "../src/index.js";

const client = createPublicClient({ chain: arc, transport: http("https://rpc.mainnet.arc.io") });
const GATEWAY = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";

describe("observer against Arc mainnet (read-only)", () => {
  it("pins a snapshot by block hash", async () => {
    const s = await captureSnapshot(client, { providerId: "rpc.mainnet.arc.io" });
    expect(s.pinningMode).toBe("BLOCK_HASH");
    expect(s.chainId).toBe(5042);
  });
  it("GatewayWallet is RAW_OBSERVATION with a non-zero ERC-1967 impl slot and no decision semantics", async () => {
    const s = await captureSnapshot(client, { providerId: "rpc.mainnet.arc.io" });
    const o = await observeProxy(client, GATEWAY, s, []);
    expect(o.resolution).toBe("RAW_OBSERVATION");
    expect(slotToAddress(o.rawSlots.erc1967Impl)).not.toBeNull();
    expect(o.dependencies.find((d) => d.role === "IMPLEMENTATION")?.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(o.signals.map((x) => x.id)).toContain("PROXY_SLOTS_RAW");
    expect(o.evidence.length).toBeGreaterThanOrEqual(7);
  });
});
