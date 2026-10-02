// G0 read-only probe: chain identity, pinned reads (EIP-1898), proxy slot observations for candidate external objects.
// Writes evidence/g0-probe-<timestamp>.json with the fields required by spec v1.4 §6.5 / §16.2. No signing, no funds.
import { createPublicClient, http, keccak256 } from "viem";
import { arc } from "viem/chains";
import { writeFileSync, mkdirSync } from "node:fs";

const RPC = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
const client = createPublicClient({ chain: arc, transport: http(RPC) });
const SLOTS = {
  erc1967_impl:   "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  erc1967_admin:  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  erc1967_beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  zos_impl:       "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zos_admin:      "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
};
const SUBJECTS = {
  USDC_ERC20:            "0x3600000000000000000000000000000000000000",
  GatewayWallet:         "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
  StableFX_FxEscrow:     "0xe2E5F173576B513d994073CCbDaCBE027d43DFe6",
  CCTP_TokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  ERC8004_Identity:      "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};
const capturedAtUTC = new Date().toISOString();
const chainId = await client.getChainId();
const head = await client.getBlockNumber();
const pinned = await client.getBlock({ blockNumber: head - 20n });
const blockHash = pinned.hash;
// Verify EIP-1898: same block fetched by hash matches number
const byHash = await client.getBlock({ blockHash });
const pinningMode = byHash.number === pinned.number ? "BLOCK_HASH" : "BLOCK_NUMBER_HASH_CHECKED";
const observations = {};
for (const [name, address] of Object.entries(SUBJECTS)) {
  const code = await client.getCode({ address, blockNumber: pinned.number });
  const slots = {};
  for (const [k, slot] of Object.entries(SLOTS)) {
    const v = await client.getStorageAt({ address, slot, blockNumber: pinned.number });
    slots[k] = v;
  }
  observations[name] = {
    fullAddress: address,
    codeBytes: code ? (code.length - 2) / 2 : 0,
    codeHash: code ? keccak256(code) : null,
    rawSlots: slots,
    rpcMethod: ["eth_getCode", "eth_getStorageAt"],
    limitations: ["raw slot values only; proxy kind not inferred here (template adapter decides)"],
  };
}
const out = {
  status: "RUN", capturedAtUTC, providerId: RPC, chainId,
  blockNumber: pinned.number.toString(), blockHash, blockTimestampUTC: new Date(Number(pinned.timestamp) * 1000).toISOString(),
  pinningMode, headAtCapture: head.toString(),
  scriptPath: "scripts/g0/probe.mjs",
  observations,
};
mkdirSync("evidence", { recursive: true });
const file = `evidence/g0-probe-${capturedAtUTC.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ chainId, pinnedBlock: out.blockNumber, pinningMode, file }, null, 1));
for (const [n, o] of Object.entries(observations)) {
  const nz = Object.entries(o.rawSlots).filter(([, v]) => v && BigInt(v) !== 0n).map(([k, v]) => `${k}=0x${v.slice(-40)}`);
  console.log(`${n.padEnd(22)} code=${String(o.codeBytes).padStart(5)}B  ${nz.join("; ") || "no known proxy slots set"}`);
}
