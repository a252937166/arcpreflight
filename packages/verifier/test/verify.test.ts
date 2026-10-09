import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, stringToBytes, keccak256 } from "viem";
import { buildPassport, bundleToString, type PassportFiles } from "@arcpreflight/passport";
import { writePassportDirectory } from "@arcpreflight/passport/node";
import { verifyPassport, loadBundle, PassportLoadError, utf8Length, type Finding, type VerifierRpc } from "../src/index.js";
import { syntheticRun, RELAYER, PAYER, MERCHANT, FEE_TX, BIZ_TX, CREATE_TX } from "../../passport/test/fixture.js";

const statuses = (r: { findings: Finding[] }) => Object.fromEntries(r.findings.map((f) => [f.id, f.status]));
const finding = (r: { findings: Finding[] }, id: string) => r.findings.find((f) => f.id === id)!;
const ALL_PASS = { FILE_INTEGRITY: "PASS", DIGEST_INTEGRITY: "PASS", DISCLOSURE: "PASS", APPROVAL_SOURCE: "PASS", APPROVAL_COVERAGE: "PASS", NETWORK_IDENTITY: "PASS", FEE_ATTRIBUTION: "PASS", TRANSACTION_PLAN_AGREEMENT: "PASS", ORDER_OUTCOME: "PASS", COST_STATEMENT: "PASS", CURRENT_ELIGIBILITY: "NOT_EVALUATED" };
/** Re-signs the manifest after a deliberate change so FILE_INTEGRITY stays clean and the deeper checks are exercised. */
function retouch(files: PassportFiles, mutate: (f: PassportFiles) => void): PassportFiles {
  const copy = { ...files }; mutate(copy);
  const manifest = JSON.parse(copy["manifest.json"]);
  manifest.files = manifest.files.filter((e: any) => copy[e.path] !== undefined);
  for (const path of Object.keys(copy)) {
    if (path === "manifest.json") continue;
    let e = manifest.files.find((x: any) => x.path === path);
    if (!e) { e = { path, bytes: 0, sha256: "", object: null }; manifest.files.push(e); }
    e.bytes = utf8Length(copy[path]); e.sha256 = sha256(stringToBytes(copy[path]));
  }
  copy["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return copy;
}
const editManifest = (files: PassportFiles, mutate: (m: any) => void) => { const copy = { ...files }; const m = JSON.parse(copy["manifest.json"]); mutate(m); copy["manifest.json"] = JSON.stringify(m, null, 2) + "\n"; return copy; };
const roundTrip = (files: PassportFiles) => loadBundle(bundleToString(files));

describe("a complete approved run", () => {
  const f = syntheticRun("APPROVED");
  const files = roundTrip(buildPassport(f.source).files);
  it("passes every finding with an RPC and anchors; CURRENT_ELIGIBILITY is never evaluated", async () => {
    const r = await verifyPassport(files, { rpc: f.rpc(), anchors: f.anchors });
    expect(statuses(r)).toEqual(ALL_PASS);
    expect(r.counts).toEqual({ pass: 10, fail: 0, unverified: 0, notEvaluated: 1 });
    expect(r.passportVersion).toBe("1.0"); expect(r.chain).toEqual({ chainId: 5042002, caip2: "eip155:5042002" });
    expect(finding(r, "FEE_ATTRIBUTION").evidence).toMatchObject({ relayer: RELAYER, blockNumber: "65993438", authorizationUsedLogIndex: 17, transferLogIndex: 19, directCall: true, entryPoint: "transferWithAuthorization", validityVerified: true, captureHash: "matches" });
    expect(finding(r, "TRANSACTION_PLAN_AGREEMENT").evidence).toEqual({ executionMode: "runner", deviations: [] });
    expect(finding(r, "ORDER_OUTCOME").detail).toMatch(/paid=true/); expect(finding(r, "ORDER_OUTCOME").detail).toMatch(/reproduced byte-exact/);
    expect(finding(r, "COST_STATEMENT").detail).toMatch(/matches the statement/);
    expect(JSON.stringify(r)).not.toMatch(/"verdict"|overall/i);
  });
  it("without an RPC the online findings are UNVERIFIED, not failed", async () => {
    const r = await verifyPassport(files, { anchors: f.anchors });
    expect(statuses(r)).toEqual({ ...ALL_PASS, NETWORK_IDENTITY: "UNVERIFIED", FEE_ATTRIBUTION: "UNVERIFIED", TRANSACTION_PLAN_AGREEMENT: "UNVERIFIED", ORDER_OUTCOME: "UNVERIFIED", COST_STATEMENT: "UNVERIFIED" });
    expect(finding(r, "NETWORK_IDENTITY").detail).toBe("no RPC configured");
  });
  it("a passport whose digests all verify is still UNVERIFIED on approval source without anchors (a rewritten passport proves nothing about approval)", async () => {
    const r = await verifyPassport(files, { rpc: f.rpc() });
    expect(statuses(r)).toEqual({ ...ALL_PASS, APPROVAL_SOURCE: "UNVERIFIED" });
    expect(finding(r, "APPROVAL_SOURCE").detail).toMatch(/cannot vouch for its own approval/);
    expect(finding(r, "DIGEST_INTEGRITY").status).toBe("PASS");
  });
  it("wrong anchors fail the approval source; the omitted-baseline case stays UNVERIFIED", async () => {
    const wrong = await verifyPassport(files, { anchors: { baselineDigests: ["0x" + "99".repeat(32)], policyDigests: f.anchors.policyDigests } });
    expect(finding(wrong, "APPROVAL_SOURCE")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/not an anchored approval/) });
    const omitted = roundTrip(buildPassport({ ...f.source, baseline: null }).files);
    const r = await verifyPassport(omitted, { anchors: f.anchors, rpc: f.rpc() });
    expect(finding(r, "APPROVAL_SOURCE")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/baseline\.json omitted; the intent references .* which is among the anchors/) });
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS");
  });
  it("records when the revocation state at execution was not retained", async () => {
    const src = structuredClone(f.source); src.result!.approvalStatusAtValidation = null;
    const r = await verifyPassport(roundTrip(buildPassport(src).files), { anchors: f.anchors });
    expect(finding(r, "APPROVAL_COVERAGE")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/revocation state at execution not retained/) });
  });
});

describe("negative suite", () => {
  const f = syntheticRun("APPROVED");
  const files = roundTrip(buildPassport(f.source).files);
  it("a tampered file fails FILE_INTEGRITY (and the digest it carried)", async () => {
    const tampered = { ...files, "intent.json": files["intent.json"].replace("demo-APPROVED-fixture", "demo-APPROVED-fixturf") };
    const r = await verifyPassport(tampered, { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(r, "FILE_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/intent\.json: sha256 does not match/) });
    expect(finding(r, "DIGEST_INTEGRITY").status).toBe("FAIL");
  });
  it("an unlisted extra file, a missing listed file and a path-traversal entry fail FILE_INTEGRITY; the bundle loader refuses traversal outright", async () => {
    expect(finding(await verifyPassport({ ...files, "extra.json": "{}" }), "FILE_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/extra\.json: present but not listed/) });
    const { "policy.json": _dropped, ...missing } = files;
    expect(finding(await verifyPassport(missing), "FILE_INTEGRITY").detail).toMatch(/policy\.json: listed in the manifest but missing/);
    expect(finding(await verifyPassport({ ...files, "../evil.json": "{}" }), "FILE_INTEGRITY").detail).toMatch(/'\.' or '\.\.'/);
    expect(() => loadBundle({ passportBundleVersion: "1.0", files: { ...files, "../evil.json": "{}" } })).toThrow(PassportLoadError);
    expect(() => loadBundle({ passportBundleVersion: "0.9", files })).toThrow(/unsupported passportBundleVersion/);
  });
  it("an RPC on another chain fails NETWORK_IDENTITY and leaves the online findings UNVERIFIED", async () => {
    const r = await verifyPassport(files, { rpc: f.rpc({ chainId: 1 }), anchors: f.anchors });
    expect(statuses(r)).toEqual({ ...ALL_PASS, NETWORK_IDENTITY: "FAIL", FEE_ATTRIBUTION: "UNVERIFIED", TRANSACTION_PLAN_AGREEMENT: "UNVERIFIED", ORDER_OUTCOME: "UNVERIFIED", COST_STATEMENT: "UNVERIFIED" });
    expect(finding(r, "NETWORK_IDENTITY").detail).toMatch(/RPC serves chain 1, passport is for chain 5042002/);
  });
  it("a switched order id in a re-signed order summary fails DIGEST_INTEGRITY while FILE_INTEGRITY passes", async () => {
    const switched = retouch(files, (c) => { const s = JSON.parse(c["order-summary.json"]); s.orderId = "0x" + "bb".repeat(32); c["order-summary.json"] = JSON.stringify(s, null, 2) + "\n"; });
    const r = await verifyPassport(switched, { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS");
    expect(finding(r, "DIGEST_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/order-summary\.orderId != intent order/) });
  });
  it("the chain disagreeing with the receipts fails ORDER_OUTCOME and TRANSACTION_PLAN_AGREEMENT", async () => {
    const otherPayer = await verifyPassport(files, { rpc: f.rpc({ orderState: { payer: RELAYER } }), anchors: f.anchors });
    expect(finding(otherPayer, "ORDER_OUTCOME")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/order paid by/) });
    const unpaid = await verifyPassport(files, { rpc: f.rpc({ orderState: { paid: false } }), anchors: f.anchors });
    expect(finding(unpaid, "ORDER_OUTCOME").detail).toMatch(/reads paid=false/);
    const base = f.rpc();
    const rewritten: VerifierRpc = { ...base, getTransaction: async (h) => { const t = await base.getTransaction(h); return t && h.toLowerCase() === BIZ_TX.toLowerCase() ? { ...t, value: (50_000_000_000_000_001n).toString(), nonce: 10 } : t; } };
    const r = await verifyPassport(files, { rpc: rewritten, anchors: f.anchors });
    expect(finding(r, "TRANSACTION_PLAN_AGREEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/deviates from the validated plan: value, nonce/) });
  });
  it("a fee receipt without the authorization logs fails FEE_ATTRIBUTION; a missing transaction is UNVERIFIED", async () => {
    const base = f.rpc();
    const noLogs: VerifierRpc = { ...base, getTransactionReceipt: async (h) => { const rc = await base.getTransactionReceipt(h); return rc && h.toLowerCase() === FEE_TX.toLowerCase() ? { ...rc, logs: (rc.logs as any[]).filter((l) => l.logIndex !== 17) } : rc; } };
    expect(finding(await verifyPassport(files, { rpc: noLogs }), "FEE_ATTRIBUTION")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/lacks AuthorizationUsed/) });
    expect(finding(await verifyPassport(files, { rpc: f.rpc({ drop: [FEE_TX.toLowerCase()] }) }), "FEE_ATTRIBUTION")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/not found on this RPC/) });
    const reverted: VerifierRpc = { ...base, getTransactionReceipt: async (h) => { const rc = await base.getTransactionReceipt(h); return rc && h.toLowerCase() === FEE_TX.toLowerCase() ? { ...rc, status: "reverted" } : rc; } };
    expect(finding(await verifyPassport(files, { rpc: reverted }), "FEE_ATTRIBUTION").detail).toMatch(/did not succeed/);
  });
  it("gas or sender that differ from the receipts fail COST_STATEMENT", async () => {
    const base = f.rpc();
    const moreGas: VerifierRpc = { ...base, getTransactionReceipt: async (h) => { const rc = await base.getTransactionReceipt(h); return rc && h.toLowerCase() === CREATE_TX.toLowerCase() ? { ...rc, gasUsed: "98108" } : rc; } };
    expect(finding(await verifyPassport(files, { rpc: moreGas }), "COST_STATEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/order creation: statement 2060247000000000 native units, receipts give 2060268000000000/) });
    const otherSender: VerifierRpc = { ...base, getTransaction: async (h) => { const t = await base.getTransaction(h); return t && h.toLowerCase() === FEE_TX.toLowerCase() ? { ...t, from: PAYER } : t; } };
    expect(finding(await verifyPassport(files, { rpc: otherSender }), "COST_STATEMENT").detail).toMatch(/fee relay: sent by/);
  });
  it("an unknown digest profile named inside the manifest fails DIGEST_INTEGRITY and executes nothing", async () => {
    const r = await verifyPassport(editManifest(files, (m) => { m.files.find((e: any) => e.path === "intent.json").object.digestProfile = "sha3-custom-9.9"; }));
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS");
    expect(finding(r, "DIGEST_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/sha3-custom-9\.9.* is not accepted/) });
    const wrongDigest = await verifyPassport(editManifest(files, (m) => { m.files.find((e: any) => e.path === "decision.json").object.digest = "0x" + "77".repeat(32); }));
    expect(finding(wrongDigest, "DIGEST_INTEGRITY").detail).toMatch(/decision\.json: decision digest .* != manifest/);
  });
  it("a planted 65-byte signature fails DISCLOSURE even in a correctly listed file", async () => {
    const leaky = retouch(files, (c) => { c["notes.json"] = JSON.stringify({ note: "0x" + "ab".repeat(65) }); });
    const r = await verifyPassport(leaky);
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS");
    expect(finding(r, "DISCLOSURE")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/notes\.json: 65-byte hex value/) });
    const keyed = retouch(files, (c) => { c["notes.json"] = JSON.stringify({ privateKey: "0x" + "11".repeat(32) }); });
    expect(finding(await verifyPassport(keyed), "DISCLOSURE").detail).toMatch(/forbidden key/);
  });
  it("a passport without a business transaction keeps its coverage flags false and the transaction findings UNVERIFIED with a reason", async () => {
    const g = syntheticRun("REVIEW_REQUIRED");
    const r = await verifyPassport(roundTrip(buildPassport(g.source).files), { rpc: g.rpc(), anchors: g.anchors });
    expect(statuses(r)).toEqual({ ...ALL_PASS, TRANSACTION_PLAN_AGREEMENT: "UNVERIFIED", ORDER_OUTCOME: "UNVERIFIED" });
    expect(finding(r, "TRANSACTION_PLAN_AGREEMENT").detail).toMatch(/no business transaction/);
    expect(r.subject).toMatchObject({ fixture: "CHANGED_IMPLEMENTATION" });
    const m = JSON.parse(roundTrip(buildPassport(g.source).files)["manifest.json"]);
    expect(m.stageCoverage).toMatchObject({ finalValidation: false, transactionPlan: false, signed: false, broadcast: false, postcondition: false });
    expect(finding(r, "APPROVAL_COVERAGE").detail).toMatch(/report result IMPLEMENTATION_CHANGED, decision REVIEW_REQUIRED/);
  });
  it("an unusable manifest fails FILE_INTEGRITY and leaves everything else UNVERIFIED", async () => {
    const r = await verifyPassport({ "manifest.json": "{not json" });
    expect(finding(r, "FILE_INTEGRITY").status).toBe("FAIL");
    expect(finding(r, "DIGEST_INTEGRITY").status).toBe("UNVERIFIED"); expect(finding(r, "ORDER_OUTCOME").status).toBe("UNVERIFIED"); expect(finding(r, "CURRENT_ELIGIBILITY").status).toBe("NOT_EVALUATED");
    const v2 = await verifyPassport({ "manifest.json": JSON.stringify({ passportVersion: "2.0", files: [] }) });
    expect(finding(v2, "FILE_INTEGRITY").detail).toMatch(/unsupported passportVersion/);
  });
});

describe("AP33-01 — fee attribution requires the calldata authorization, every field", () => {
  const f = syntheticRun("APPROVED");
  const files = roundTrip(buildPassport(f.source).files);
  const editJson = (path: string, mutate: (v: any) => void) => retouch(files, (c) => { const v = JSON.parse(c[path]); mutate(v); c[path] = JSON.stringify(v, null, 2) + "\n"; });
  it("a modified validBefore in payment.json fails FEE_ATTRIBUTION although the logs still match", async () => {
    const r = await verifyPassport(editJson("payment.json", (p) => { p.authorization.validBefore = "9999999998"; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS"); expect(finding(r, "DIGEST_INTEGRITY").status).toBe("PASS");
    expect(finding(r, "FEE_ATTRIBUTION")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/calldata authorization differs from payment\.json \(fields validBefore\)/), evidence: expect.objectContaining({ directCall: true, validityVerified: false }) });
    const after = await verifyPassport(editJson("payment.json", (p) => { p.authorization.validAfter = "1"; }), { rpc: f.rpc() });
    expect(finding(after, "FEE_ATTRIBUTION").detail).toMatch(/fields validAfter/);
  });
  it("a modified inputKeccak256 in the fee capture fails FEE_ATTRIBUTION; a capture without it is noted", async () => {
    const r = await verifyPassport(editJson("evidence/chain/fee-tx.json", (c) => { c.tx.inputKeccak256 = "0x" + "77".repeat(32); }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(r, "FEE_ATTRIBUTION")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/records inputKeccak256 0x7777.*the fetched calldata hashes to 0x/), evidence: expect.objectContaining({ captureHash: "differs" }) });
    const absent = await verifyPassport(editJson("evidence/chain/fee-tx.json", (c) => { delete c.tx.inputKeccak256; }), { rpc: f.rpc() });
    expect(finding(absent, "FEE_ATTRIBUTION")).toMatchObject({ status: "PASS", detail: expect.stringMatching(/carries no inputKeccak256/), evidence: expect.objectContaining({ captureHash: "absent" }) });
  });
  it("a settlement that is not a direct USDC authorization call passes on the logs alone and says the validity window was not verifiable", async () => {
    const wrapped = ("0xdeadbeef" + String(f.txs[FEE_TX.toLowerCase()].input).slice(10)) as `0x${string}`;
    const base = f.rpc();
    const viaWrapper: VerifierRpc = { ...base, getTransaction: async (h) => { const t = await base.getTransaction(h); return t && h.toLowerCase() === FEE_TX.toLowerCase() ? { ...t, input: wrapped } : t; } };
    const r = await verifyPassport(editJson("evidence/chain/fee-tx.json", (c) => { c.tx.inputKeccak256 = keccak256(wrapped); }), { rpc: viaWrapper, anchors: f.anchors });
    expect(finding(r, "FEE_ATTRIBUTION")).toMatchObject({ status: "PASS", detail: expect.stringMatching(/not a direct call; validity window not verifiable from calldata/), evidence: expect.objectContaining({ directCall: false, validityVerified: false, entryPoint: null, captureHash: "matches" }) });
  });
});

describe("AP33-02 — the cost statement is recomputed in full", () => {
  const f = syntheticRun("APPROVED");
  const files = roundTrip(buildPassport(f.source).files);
  const costWith = (mutate: (c: any) => void) => retouch(files, (c) => { const v = JSON.parse(c["cost-statement.json"]); mutate(v); c["cost-statement.json"] = JSON.stringify(v, null, 2) + "\n"; });
  const failsOn = async (path: RegExp, mutate: (c: any) => void) => {
    const r = await verifyPassport(costWith(mutate), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(r, "FILE_INTEGRITY").status).toBe("PASS");
    expect(finding(r, "COST_STATEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/statement differs from the recomputation/) });
    expect(finding(r, "COST_STATEMENT").detail).toMatch(path);
  };
  it("wrong buyer and operator totals fail", async () => {
    await failsOn(/buyer\.totalNativeAtomic: statement "60847644000000001", recomputed "60847644000000000"/, (c) => { c.buyer.totalNativeAtomic = "60847644000000001"; });
    await failsOn(/operator\.totalNativeAtomic/, (c) => { c.operator.totalNativeAtomic = "4238772000000001"; });
  });
  it("a wrong 18-decimal fee equivalence, authorized maximum or actual figure fails", async () => {
    await failsOn(/buyer\.checkFee\.nativeAtomicEquivalent/, (c) => { c.buyer.checkFee.nativeAtomicEquivalent = "10000000000000001"; });
    await failsOn(/authorizedMaximum\.businessGasNativeAtomic: statement "1260000000000001", recomputed "1260000000000000"/, (c) => { c.authorizedMaximum.businessGasNativeAtomic = "1260000000000001"; });
    await failsOn(/authorizedMaximum\.businessPrincipalNativeAtomic/, (c) => { c.authorizedMaximum.businessPrincipalNativeAtomic = "60000000000000000"; });
    await failsOn(/actual\.businessPrincipalNativeAtomic/, (c) => { c.actual.businessPrincipalNativeAtomic = "0"; });
  });
  it("a wrong usdc rendering, a swapped source hash or a dropped note fails", async () => {
    await failsOn(/operator\.totalUsdc: statement "0\.004238773", recomputed "0\.004238772"/, (c) => { c.operator.totalUsdc = "0.004238773"; });
    await failsOn(/buyer\.businessGas\.usdc/, (c) => { c.buyer.businessGas.usdc = "0.00084764"; });
    await failsOn(/sources\.feeTx/, (c) => { c.sources.feeTx = CREATE_TX; });
    await failsOn(/notes: statement has 2 entries, recomputed 3/, (c) => { c.notes.pop(); });
  });
  it("the untouched statement still passes with the recomputed totals in the detail; a missing receipt is UNVERIFIED, not failed", async () => {
    const ok = await verifyPassport(files, { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(ok, "COST_STATEMENT")).toMatchObject({ status: "PASS", detail: expect.stringMatching(/matches the statement field by field.*buyer total 0\.060847644 USDC.*operator total 0\.004238772 USDC/) });
    const r = await verifyPassport(files, { rpc: f.rpc({ drop: [CREATE_TX.toLowerCase()] }), anchors: f.anchors });
    expect(finding(r, "COST_STATEMENT")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/order creation: .* not found on this RPC/) });
  });
});

describe("AP33-03 — history the RPC cannot serve is UNVERIFIED, never FAIL", () => {
  const f = syntheticRun("APPROVED");
  const files = roundTrip(buildPassport(f.source).files);
  it("getOrder failing with a pruned-state error leaves ORDER_OUTCOME UNVERIFIED with that reason and nothing else touched", async () => {
    const base = f.rpc();
    const pruned: VerifierRpc = { ...base, call: async () => { throw new Error("missing trie node 6f1a… (path ) state 0x2a… is not available"); } };
    const r = await verifyPassport(files, { rpc: pruned, anchors: f.anchors });
    expect(statuses(r)).toEqual({ ...ALL_PASS, ORDER_OUTCOME: "UNVERIFIED" });
    expect(finding(r, "ORDER_OUTCOME").detail).toMatch(/historical order state at block 65993462 could not be read from this RPC: missing trie node/);
    expect(finding(r, "ORDER_OUTCOME").detail).toMatch(/receipt itself succeeded and the OrderPaid log is present/);
    expect(r.counts.fail).toBe(0);
    const noBlock: VerifierRpc = { ...pruned, getBlock: async () => null };
    expect(finding(await verifyPassport(files, { rpc: noBlock }), "ORDER_OUTCOME")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/is not served by this RPC/) });
  });
  it("a receipt lookup that throws is UNVERIFIED for every finding that needs it, with the reason", async () => {
    const base = f.rpc();
    const flaky: VerifierRpc = { ...base, getTransactionReceipt: async () => { throw new Error("HTTP request failed: 503 Service Unavailable"); } };
    const r = await verifyPassport(files, { rpc: flaky, anchors: f.anchors });
    expect(statuses(r)).toEqual({ ...ALL_PASS, FEE_ATTRIBUTION: "UNVERIFIED", ORDER_OUTCOME: "UNVERIFIED", COST_STATEMENT: "UNVERIFIED" });
    expect(finding(r, "ORDER_OUTCOME").detail).toMatch(/could not be fetched: HTTP request failed: 503/);
    expect(finding(r, "COST_STATEMENT").detail).toMatch(/fee relay: .* could not be fetched: HTTP request failed/);
    expect(finding(r, "FEE_ATTRIBUTION").detail).toMatch(/could not be fetched/);
    const noTx: VerifierRpc = { ...base, getTransaction: async () => { throw new Error("rate limited"); } };
    const t = await verifyPassport(files, { rpc: noTx, anchors: f.anchors });
    expect(statuses(t)).toEqual({ ...ALL_PASS, FEE_ATTRIBUTION: "UNVERIFIED", TRANSACTION_PLAN_AGREEMENT: "UNVERIFIED", COST_STATEMENT: "UNVERIFIED" });
    expect(finding(t, "TRANSACTION_PLAN_AGREEMENT").detail).toMatch(/could not be fetched: rate limited/);
  });
  it("a contradiction that is already established still fails, listing the unavailable history alongside", async () => {
    const base = f.rpc();
    const rpc: VerifierRpc = { ...base, call: async () => { throw new Error("missing trie node"); }, getTransactionReceipt: async (h) => { const rc = await base.getTransactionReceipt(h); return rc && h.toLowerCase() === BIZ_TX.toLowerCase() ? { ...rc, status: "reverted" } : rc; } };
    const r = await verifyPassport(files, { rpc, anchors: f.anchors });
    expect(finding(r, "ORDER_OUTCOME")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/records SUCCESS but the transaction reverted; additionally unverifiable: .*missing trie node/) });
  });
});

describe("execution modes — wallet-mode plan agreement", () => {
  const w = syntheticRun("WALLET");
  const files = roundTrip(buildPassport(w.source).files);
  it("a wallet-run passport passes every finding; wallet-set gas, fees and nonce are reported as deviations, not failures", async () => {
    const r = await verifyPassport(files, { rpc: w.rpc(), anchors: w.anchors });
    expect(statuses(r)).toEqual(ALL_PASS);
    expect(r.subject).toMatchObject({ kind: "wallet-run", executionMode: "wallet" });
    const tpa = finding(r, "TRANSACTION_PLAN_AGREEMENT");
    expect(tpa.detail).toMatch(/matches the validated plan in chainId, type, from, to, data and value \(wallet mode\)/);
    expect(tpa.detail).toMatch(/wallet-set deviations recorded, not failed: nonce plan 9, transaction 10, gas plan 60000, transaction 70000, maxFeePerGas plan 21000000000, transaction 22000000000, maxPriorityFeePerGas plan 1000000000, transaction 1500000000/);
    expect(tpa.evidence).toEqual({ executionMode: "wallet", deviations: [
      { field: "nonce", plan: "9", transaction: "10" }, { field: "gas", plan: "60000", transaction: "70000" },
      { field: "maxFeePerGas", plan: "21000000000", transaction: "22000000000" }, { field: "maxPriorityFeePerGas", plan: "1000000000", transaction: "1500000000" },
    ] });
    expect(finding(r, "COST_STATEMENT").status).toBe("PASS"); // gas is measured from the receipt, the authorized maximum from the plan
  });
  it("to, data, value, from or an authorization list that differ from the plan still fail in wallet mode", async () => {
    const base = w.rpc();
    const swap = (patch: Record<string, unknown>): VerifierRpc => ({ ...base, getTransaction: async (h) => { const t = await base.getTransaction(h); return t && h.toLowerCase() === BIZ_TX.toLowerCase() ? { ...t, ...patch } : t; } });
    const to = await verifyPassport(files, { rpc: swap({ to: RELAYER }), anchors: w.anchors });
    expect(finding(to, "TRANSACTION_PLAN_AGREEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/deviates from the validated plan: to \(wallet mode: chainId, type, from, to, data, value and authorizationList must match the plan\)/) });
    expect(finding(await verifyPassport(files, { rpc: swap({ value: "50000000000000001" }) }), "TRANSACTION_PLAN_AGREEMENT").detail).toMatch(/plan: value /);
    expect(finding(await verifyPassport(files, { rpc: swap({ authorizationList: [{ address: MERCHANT }] }) }), "TRANSACTION_PLAN_AGREEMENT").detail).toMatch(/plan: authorizationList/);
    expect(finding(await verifyPassport(files, { rpc: swap({ input: "0x" }) }), "TRANSACTION_PLAN_AGREEMENT").detail).toMatch(/plan: data /);
  });
  it("the same wallet-set deviations fail a runner-mode passport, and a manifest that misdescribes its mode fails DIGEST_INTEGRITY", async () => {
    const runner = syntheticRun("APPROVED"); const runnerFiles = roundTrip(buildPassport(runner.source).files);
    const r = await verifyPassport(runnerFiles, { rpc: w.rpc(), anchors: runner.anchors }); // the wallet variant's chain view against a runner passport
    expect(finding(r, "TRANSACTION_PLAN_AGREEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/deviates from the validated plan: nonce, gas, maxFeePerGas, maxPriorityFeePerGas$/) });
    const relabelled = editManifest(runnerFiles, (m) => { m.subject.executionMode = "wallet"; });
    const d = await verifyPassport(relabelled, { rpc: w.rpc(), anchors: runner.anchors });
    expect(finding(d, "FILE_INTEGRITY").status).toBe("PASS");
    expect(finding(d, "DIGEST_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/order-summary\.executionMode runner != manifest subject\.executionMode wallet; manifest subject\.kind demo-run is inconsistent with executionMode wallet/) });
  });
});

describe("CLI", () => {
  it("returns 0 with no failures, 2 on a failure, 1 when the passport cannot be loaded; directory and bundle forms alike", async () => {
    process.env.ARCPREFLIGHT_VERIFY_IMPORT_ONLY = "1";
    const { main } = await import("../src/cli.js");
    const f = syntheticRun("APPROVED"); const { files } = buildPassport(f.source);
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const bundle = join(dir, "passport.json"); writeFileSync(bundle, bundleToString(files));
    const anchors = join(dir, "anchors.json"); writeFileSync(anchors, JSON.stringify(f.anchors));
    const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      expect(await main([bundle, "--json", "--anchors", anchors])).toBe(0);
      expect(JSON.parse(logs.join("\n")).counts).toMatchObject({ fail: 0, unverified: 5 });
      logs.length = 0;
      expect(await main([bundle])).toBe(0);
      expect(logs.join("\n")).toMatch(/UNVERIFIED\s+NETWORK_IDENTITY\s+no RPC configured/); expect(logs.join("\n")).toMatch(/no --anchors/);
      const passportDir = join(dir, "payment-passport"); writePassportDirectory(passportDir, files);
      expect(await main([passportDir, "--anchors", anchors])).toBe(0);
      const tampered = join(dir, "tampered.json"); writeFileSync(tampered, bundleToString({ ...files, "intent.json": files["intent.json"].replace("fixture", "fixturf") }));
      expect(await main([tampered])).toBe(2);
      expect(await main([join(dir, "nope.json")])).toBe(1);
      writeFileSync(join(dir, "bad-anchors.json"), JSON.stringify({ baselineDigests: ["nope"] }));
      expect(await main([bundle, "--anchors", join(dir, "bad-anchors.json")])).toBe(1);
    } finally { console.log = orig; }
  });
});

describe("review round 2 — approval validity, format completeness and statement values", () => {
  const f = syntheticRun("APPROVED"); const w = syntheticRun("WALLET");
  it("a wallet run whose approval was recorded revoked at validation fails APPROVAL_COVERAGE (no signed hash exists in wallet mode)", async () => {
    const src = structuredClone(w.source); src.result!.approvalStatusAtValidation = { revoked: true, validUntil: null, fetchedAt: "2026-10-08T10:00:00.000Z" };
    const r = await verifyPassport(roundTrip(buildPassport(src).files), { anchors: w.anchors, rpc: w.rpc() });
    expect(finding(r, "APPROVAL_COVERAGE")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/recorded as revoked at final validation, yet a transaction was executed/) });
  });
  it("an approval recorded as already expired when it was read fails; an unretained status or an omitted baseline is UNVERIFIED for an executed run, in wallet mode too", async () => {
    const expired = structuredClone(f.source); expired.result!.approvalStatusAtValidation = { revoked: false, validUntil: "2026-10-08T09:00:00.000Z", fetchedAt: "2026-10-08T10:00:00.000Z" };
    expect(finding(await verifyPassport(roundTrip(buildPassport(expired).files), { anchors: f.anchors }), "APPROVAL_COVERAGE")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/recorded as expired/) });
    const unretained = structuredClone(w.source); unretained.result!.approvalStatusAtValidation = null;
    expect(finding(await verifyPassport(roundTrip(buildPassport(unretained).files), { anchors: w.anchors }), "APPROVAL_COVERAGE")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/not retained/) });
    const omitted = roundTrip(buildPassport({ ...w.source, baseline: null }).files);
    expect(finding(await verifyPassport(omitted, { anchors: w.anchors, rpc: w.rpc() }), "APPROVAL_COVERAGE")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/baseline\.json omitted/) });
  });
  it("a missing or unsupported verification profile fails FILE_INTEGRITY", async () => {
    const files = roundTrip(buildPassport(f.source).files);
    const missing = retouch(files, (c) => { delete c["verification-profile.json"]; });
    expect(finding(await verifyPassport(missing, { anchors: f.anchors }), "FILE_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/verification-profile\.json missing/) });
    const unsupported = retouch(files, (c) => { const v = JSON.parse(c["verification-profile.json"]); v.acceptedDigestProfiles.push("sha3-512-file-9.9"); c["verification-profile.json"] = JSON.stringify(v, null, 2) + "\n"; });
    expect(finding(await verifyPassport(unsupported, { anchors: f.anchors }), "FILE_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/unsupported digest profile "sha3-512-file-9\.9"/) });
    const wrongVersion = retouch(files, (c) => { const v = JSON.parse(c["verification-profile.json"]); v.verificationProfileVersion = "2.0"; c["verification-profile.json"] = JSON.stringify(v, null, 2) + "\n"; });
    expect(finding(await verifyPassport(wrongVersion, { anchors: f.anchors }), "FILE_INTEGRITY")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/unsupported verificationProfileVersion/) });
  });
  it("a reservation value that is not a decimal string fails COST_STATEMENT; a 1.0 statement without the completeness fields still verifies", async () => {
    const files = roundTrip(buildPassport(f.source).files);
    const costWith = (mutate: (c: any) => void) => retouch(files, (c) => { const v = JSON.parse(c["cost-statement.json"]); mutate(v); c["cost-statement.json"] = JSON.stringify(v, null, 2) + "\n"; });
    const bad = await verifyPassport(costWith((c) => { c.unresolvedReservation.nativeAtomic = "1e18"; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(bad, "COST_STATEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/unresolvedReservation\.nativeAtomic "1e18" is not a decimal/) });
    const legacy = await verifyPassport(costWith((c) => { c.costStatementVersion = "1.0"; delete c.buyer.role; delete c.buyer.complete; delete c.operator.complete; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(legacy, "COST_STATEMENT").status).toBe("PASS");
    const current = await verifyPassport(files, { rpc: f.rpc(), anchors: f.anchors });
    expect(JSON.parse(files["cost-statement.json"])).toMatchObject({ costStatementVersion: "1.1", buyer: { role: "project-runner", complete: true }, operator: { complete: true } });
    expect(finding(current, "COST_STATEMENT").status).toBe("PASS");
    const wrongRole = await verifyPassport(costWith((c) => { c.buyer.role = "visitor-wallet"; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(wrongRole, "COST_STATEMENT")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/buyer\.role/) });
    expect(JSON.parse(roundTrip(buildPassport(w.source).files)["cost-statement.json"]).buyer.role).toBe("visitor-wallet");
  });
});

describe("review round 3 — malformed approval evidence and the unresolved reservation", () => {
  const f = syntheticRun("APPROVED"); const w = syntheticRun("WALLET");
  const withStatus = (src: any, status: any) => { const c = structuredClone(src); c.result.approvalStatusAtValidation = status; return roundTrip(buildPassport(c).files); };
  it("an empty object, a non-boolean revoked flag, an invalid or out-of-range timestamp never PASS for an executed run", async () => {
    for (const [status, why] of [
      [{}, /revoked is not a boolean/], [{ revoked: null, validUntil: null, fetchedAt: "2026-10-08T10:00:00.000Z" }, /revoked is not a boolean/],
      [{ revoked: false, validUntil: null, fetchedAt: "not-a-date" }, /fetchedAt is not a valid timestamp/],
      [{ revoked: false, validUntil: "soon", fetchedAt: "2026-10-08T10:00:00.000Z" }, /validUntil is neither null nor a valid timestamp/],
      [{ revoked: false, fetchedAt: "2026-10-08T10:00:00.000Z" }, /validUntil is missing/],
      [{ revoked: false, validUntil: null, fetchedAt: "2026-10-08T09:59:00.000Z" }, /precedes the report's observation/],
      [{ revoked: false, validUntil: null, fetchedAt: "2026-10-08T10:00:03.000Z" }, /after the execution record/],
    ] as const) {
      for (const src of [f.source, w.source]) {
        const r = await verifyPassport(withStatus(src, status), { anchors: f.anchors, rpc: f.rpc() });
        expect(finding(r, "APPROVAL_COVERAGE"), JSON.stringify(status)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(why) });
        expect(r.counts.fail).toBeGreaterThan(0);
      }
    }
    const ok = await verifyPassport(withStatus(w.source, { revoked: false, validUntil: null, fetchedAt: "2026-10-08T10:00:00.000Z" }), { anchors: w.anchors, rpc: w.rpc() });
    expect(finding(ok, "APPROVAL_COVERAGE").status).toBe("PASS");
  });
  it("an unresolved reservation is never taken from the statement itself: a non-zero value leaves COST_STATEMENT UNVERIFIED, a tampered zero still has to match", async () => {
    const files = roundTrip(buildPassport(f.source).files);
    const costWith = (mutate: (c: any) => void) => retouch(files, (c) => { const v = JSON.parse(c["cost-statement.json"]); mutate(v); c["cost-statement.json"] = JSON.stringify(v, null, 2) + "\n"; });
    const inflated = await verifyPassport(costWith((c) => { c.unresolvedReservation.nativeAtomic = "999999000000000000000000"; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(inflated, "COST_STATEMENT")).toMatchObject({ status: "UNVERIFIED", detail: expect.stringMatching(/service-side reservation that no chain or passport record can establish/) });
    expect(inflated.counts.fail).toBe(0);
    const untouched = await verifyPassport(files, { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(untouched, "COST_STATEMENT").status).toBe("PASS");
    const tamperedTotal = await verifyPassport(costWith((c) => { c.unresolvedReservation.nativeAtomic = "5"; c.buyer.totalNativeAtomic = "1"; }), { rpc: f.rpc(), anchors: f.anchors });
    expect(finding(tamperedTotal, "COST_STATEMENT").status).toBe("FAIL");
  });
});
