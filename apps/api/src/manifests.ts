import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbi } from "viem";
import { digest } from "@arcpreflight/schema";
import type { Signal } from "@arcpreflight/schema";
import type { AdapterManifest } from "@arcpreflight/observer";
import { manifestDigest } from "@arcpreflight/observer";
import { cfg } from "./config.js";

export const adapterManifests: AdapterManifest[] = JSON.parse(readFileSync(resolve(cfg.root, "fixtures/adapters.json"), "utf8"));
export const adapterManifestDigests = adapterManifests.map(manifestDigest);

export const DEMO_MERCHANT_TEMPLATE_ABI = parseAbi([
  "function pay(bytes32 orderId) payable",
  "function paused() view returns (bool)",
  "function version() view returns (string)",
  "function owner() view returns (address)",
  "function getOrder(bytes32 orderId) view returns (address payer, uint256 amountNativeAtomic, bool paid, uint64 createdAtBlock, uint64 paidAtBlock)",
]);

/** Methodology descriptor — digested so every report states which rule set produced it. */
export const methodology = {
  id: "arcpreflight-methodology", version: "0.1.0",
  checks: ["INTENT_BINDING", "AMOUNT_SEMANTICS", "BASELINE_STATUS", "EXECUTION_IDENTITY", "SUPPORTED_STATE", "CALL_SIMULATION", "EVIDENCE_FRESHNESS"],
  templates: ["oz-erc1967proxy-uups@5.4.0", "demo-merchant-v1-template"],
  advisories: ["ARC_USDC_TWO_INTERFACES", "ARC_VALUE_TRANSFER_RULES", "ARC_PREVRANDAO_ZERO", "ARC_SELFDESTRUCT_RULES", "ARC_TIMESTAMP_NON_STRICT", "ARC_MIN_BASE_FEE"],
  notes: ["network advisories are documentation-backed network rules, not target-specific findings"],
};
export const methodologyDigest = digest("methodology", "1.0", methodology);

/** Arc runtime advisories (spec v1.4 §5.5): basis=network_advisory, state=observed means "this rule applies on Arc",
 *  never "this target is vulnerable". Each carries its documentation reference in sourceIds. */
export const arcAdvisorySignals: Signal[] = [
  { id: "ARC_USDC_TWO_INTERFACES", state: "observed", basis: "network_advisory", scope: "network rule: native USDC (18 dec) and ERC-20 USDC (6 dec) share one balance; amounts must be converted at the boundary",
    evidenceDigests: [], limitations: ["network rule only; see AMOUNT_SEMANTICS for the target-specific check"], sourceIds: ["https://docs.arc.io/arc/references/evm-differences", "https://www.arc.io/blog/arc-compatibility-guide-for-existing-evm-apps"] },
  { id: "ARC_VALUE_TRANSFER_RULES", state: "observed", basis: "network_advisory", scope: "network rule: native value transfers to the zero address, to/from blocklisted addresses, burns and some SELFDESTRUCT paths revert even with sufficient balance; blocklist reverts still consume gas",
    evidenceDigests: [], limitations: ["does not assert that this call triggers any of these rules"], sourceIds: ["https://docs.arc.io/arc/references/evm-differences"] },
  { id: "ARC_PREVRANDAO_ZERO", state: "observed", basis: "network_advisory", scope: "network rule: block.prevrandao is always 0 on Arc; onchain randomness must come from an oracle/VRF",
    evidenceDigests: [], limitations: ["does not assert the target reads prevrandao"], sourceIds: ["https://docs.arc.io/arc/references/evm-differences"] },
  { id: "ARC_SELFDESTRUCT_RULES", state: "observed", basis: "network_advisory", scope: "network rule: SELFDESTRUCT follows EIP-6780 plus Arc value rules and moves the contract's native USDC to the beneficiary; sends to a destructed account revert",
    evidenceDigests: [], limitations: ["opcode presence is not checked in P0; this is a rule reminder"], sourceIds: ["https://docs.arc.io/arc/references/evm-differences", "https://eips.ethereum.org/EIPS/eip-6780"] },
  { id: "ARC_TIMESTAMP_NON_STRICT", state: "observed", basis: "network_advisory", scope: "network rule: sub-second blocks may share a timestamp; order by block number, not timestamp",
    evidenceDigests: [], limitations: [], sourceIds: ["https://docs.arc.io/arc/references/evm-differences"] },
  { id: "ARC_MIN_BASE_FEE", state: "observed", basis: "network_advisory", scope: "network rule: transactions with maxFeePerGas below 20 gwei are silently dropped; fee is paid in USDC",
    evidenceDigests: [], limitations: ["the floor is not a sufficiency guarantee; final validation re-estimates fees"], sourceIds: ["https://docs.arc.io/arc/references/gas-and-fees"] },
];
