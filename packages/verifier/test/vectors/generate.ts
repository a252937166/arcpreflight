// Regenerates the digest and cost vectors from the current implementation. Vectors are frozen once published: if this script's
// output differs from the committed JSON, the implementation changed and old records would no longer re-hash (AP32-32).
//   pnpm exec tsx packages/verifier/test/vectors/generate.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { keccak256, sha256, stringToBytes } from "viem";
import { canonicalize, digest } from "@arcpreflight/schema";
import { syntheticRun } from "../../../passport/test/fixture.js";
import { costStatement, formatAtomic } from "@arcpreflight/passport";

const f = syntheticRun("APPROVED"); const r = f.source.result!;
const here = fileURLToPath(new URL(".", import.meta.url));
const jcs = [
  { kind: "intent", schemaVersion: "1.0", payload: r.intent },
  { kind: "decision", schemaVersion: "1.0", payload: r.decision },
  { kind: "evidence", schemaVersion: "1.0", payload: f.source.reportEvidence[0].evidence },
  { kind: "quote", schemaVersion: "1.0", payload: r.quote },
  { kind: "transactionPlan", schemaVersion: "1.0", payload: { b: "2", a: ["x", { d: null, c: true }], n: 1 } },
].map((v) => ({ ...v, canonical: canonicalize({ kind: v.kind, schemaVersion: v.schemaVersion, payload: v.payload }), digest: digest(v.kind as any, v.schemaVersion, v.payload) }));
const legacy = [JSON.stringify(r.postcondition), JSON.stringify({ orderId: r.orderId, paid: false, payer: r.intent.from, amountNativeAtomic: "50000000000000000", block: "1", receiptStatus: "reverted" })].map((preimage) => ({ preimage, digest: keccak256(stringToBytes(preimage)) }));
const file = ["", "{}\n", JSON.stringify(r.intent, null, 2) + "\n", "ünïcödé — 🪪"].map((content) => ({ content, sha256: sha256(stringToBytes(content)) }));
writeFileSync(resolve(here, "digests.json"), JSON.stringify({ generatedBy: "packages/verifier/test/vectors/generate.ts", profiles: { jcs: "arcpreflight-jcs-keccak-1.0", legacy: "legacy-json-stringify-keccak-1.0", file: "sha256-file-1.0" }, jcs, legacy, file }, null, 2) + "\n");

const cases = [["87141", "25000000000"], ["40364", "21000000000"], ["98107", "21000000000"], ["1", "1"], ["0", "21000000000"], ["123456789", "1000000001"]].map(([gasUsed, effectiveGasPrice]) => {
  const c = costStatement({ buyer: r.intent.from, relayer: null, orderCreator: null, businessPrincipalNativeAtomic: "0", businessPaid: false, checkFeeTokenAtomic: null, plan: null, policy: null, receipts: { businessTx: { gasUsed, effectiveGasPrice } }, txs: { businessTx: r.execution.businessTxHash }, capturedAt: "2026-10-08T00:00:00.000Z" });
  return { gasUsed, effectiveGasPrice, nativeAtomic: c.buyer.businessGas!.nativeAtomic, usdc: c.buyer.businessGas!.usdc };
});
const format = [["2178525000000000", 18], ["50000000000000000", 18], ["10000", 6], ["0", 18], ["1", 18], ["1000000000000000000", 18], ["123456789012345678901", 18]].map(([atomic, decimals]) => ({ atomic, decimals, usdc: formatAtomic(String(atomic), Number(decimals)) }));
writeFileSync(resolve(here, "cost.json"), JSON.stringify({ generatedBy: "packages/verifier/test/vectors/generate.ts", gas: cases, format }, null, 2) + "\n");
console.log(`wrote ${jcs.length} jcs, ${legacy.length} legacy, ${file.length} file digest vectors and ${cases.length}+${format.length} cost vectors`);
