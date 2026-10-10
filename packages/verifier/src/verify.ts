// verifyPassport: the findings table of docs/PASSPORT.md §6. Offline findings need only the files; APPROVAL_SOURCE needs
// anchors retained through a trusted channel; the online findings need an explicitly configured Arc RPC. Missing trust or
// history yields UNVERIFIED, never an invented success, and there is no single overall PASS.
import { keccak256, sha256, stringToBytes, toHex, getAddress, isAddressEqual, encodeFunctionData, decodeFunctionData, decodeAbiParameters, type Hex as ViemHex } from "viem";
import { digest as schemaDigest, intentDigest, policyDigest, baselineDigest, reportDigest, decisionDigest, transactionPlanDigest, finalValidationDigest, executionDigest, quoteDigest } from "@arcpreflight/schema";
import { findSettlementInLogs, authorizationCallMatches, addressTopic, EIP3009_CALL_ABI, ARC } from "@arcpreflight/client";
import { costStatement, type ReceiptLike, buyerRoleOf } from "@arcpreflight/passport";
import { ACCEPTED_PROFILES, FINDING_ORDER, type Anchors, type Finding, type FindingId, type FindingStatus, type Hex, type PassportFiles, type VerificationResult, type VerifierRpc } from "./types.js";
import { fileSetProblems, utf8Length } from "./load.js";

export const ORDER_PAID_TOPIC = keccak256(toHex("OrderPaid(bytes32,address,uint256)"));
export const ORDER_CREATED_TOPIC = keccak256(toHex("OrderCreated(bytes32,address,uint256)"));
const PAY_ABI = [{ type: "function", name: "pay", stateMutability: "payable", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [] }] as const;
const CREATE_ORDER_ABI = [{ type: "function", name: "createOrder", stateMutability: "nonpayable", inputs: [{ name: "orderId", type: "bytes32" }, { name: "payer", type: "address" }, { name: "amountNativeAtomic", type: "uint256" }], outputs: [] }] as const;
/** the canonical Arc identity of a chain the verifier knows: the passport never chooses which contract counts as USDC (audit 2026-10-10, VF-02) */
const canonicalArc = (chainId: unknown) => (Number(chainId) === ARC.mainnet.chainId ? ARC.mainnet : Number(chainId) === ARC.testnet.chainId ? ARC.testnet : null);
const GET_ORDER_ABI = [{ type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "bytes32" }], outputs: [{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }] }] as const;
const CORE_DIGESTS: Record<string, (v: unknown) => Hex> = { intent: intentDigest, policy: policyDigest, baseline: baselineDigest, report: reportDigest, decision: decisionDigest, transactionPlan: transactionPlanDigest, finalValidation: finalValidationDigest, execution: executionDigest, quote: quoteDigest, evidence: (v) => schemaDigest("evidence", "1.0", v) };

const low = (s: unknown) => String(s ?? "").toLowerCase();
const same = (a: unknown, b: unknown) => !!a && !!b && low(a) === low(b);
const sameAddr = (a: unknown, b: unknown) => { try { return isAddressEqual(String(a) as ViemHex, String(b) as ViemHex); } catch { return false; } };
const big = (v: unknown): bigint | null => { try { if (typeof v === "bigint") return v; if (typeof v === "number") return BigInt(v); if (typeof v === "string") return v.startsWith("0x") ? BigInt(v) : BigInt(v); return null; } catch { return null; } };
const isType2 = (t: unknown) => t === "eip1559" || t === 2 || t === "2" || t === "0x2" || t === "0x02";
const succeeded = (r: Record<string, unknown>) => r.status === "success" || r.status === "0x1" || r.status === 1 || r.status === "1" || r.status === true;
const list = (p: string[], max = 6) => (p.length > max ? [...p.slice(0, max), `… ${p.length - max} more`] : p).join("; ");
const errText = (e: unknown) => String((e as any)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
const brief = (v: unknown) => { const t = v === undefined ? "undefined" : JSON.stringify(v); return t.length > 48 ? `${t.slice(0, 46)}…` : t; };
const HEX40 = /^0x[0-9a-fA-F]{40}$/, HEX64 = /^0x[0-9a-fA-F]{64}$/, HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
type Eip3009Call = { name: string; from: string; to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: string };
/** The six authorization arguments shared by the four EIP-3009 entry points, or null when the calldata is not one of them (wrapper, router, other method). */
function decodeEip3009Call(input: string): Eip3009Call | null {
  if (!input || input.length < 10) return null;
  try {
    const d = decodeFunctionData({ abi: EIP3009_CALL_ABI, data: input as ViemHex });
    const [from, to, value, validAfter, validBefore, nonce] = d.args as unknown as [string, string, bigint, bigint, bigint, string];
    return { name: d.functionName, from, to, value, validAfter, validBefore, nonce };
  } catch { return null; }
}
const authorizationFieldDiffs = (c: Eip3009Call, a: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }) =>
  [!sameAddr(c.from, a.from) && "from", !sameAddr(c.to, a.to) && "to", c.value !== big(a.value) && "value", c.validAfter !== big(a.validAfter) && "validAfter", c.validBefore !== big(a.validBefore) && "validBefore", !same(c.nonce, a.nonce) && "nonce"].filter(Boolean) as string[];
/** Paths where `statement` differs from `recomputed`. Addresses and 32-byte hashes compare case-insensitively; everything else byte for byte. */
function fieldDiffs(recomputed: unknown, statement: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(recomputed) || Array.isArray(statement)) {
    if (!Array.isArray(recomputed) || !Array.isArray(statement)) { out.push(`${path}: statement ${brief(statement)}, recomputed ${brief(recomputed)}`); return out; }
    if (recomputed.length !== statement.length) { out.push(`${path}: statement has ${statement.length} entries, recomputed ${recomputed.length}`); return out; }
    recomputed.forEach((v, i) => fieldDiffs(v, statement[i], `${path}[${i}]`, out));
    return out;
  }
  if (recomputed && typeof recomputed === "object" && statement && typeof statement === "object") {
    for (const k of new Set([...Object.keys(recomputed), ...Object.keys(statement)])) fieldDiffs((recomputed as Record<string, unknown>)[k], (statement as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (typeof recomputed === "string" && typeof statement === "string") {
    if (HEX40.test(recomputed) && HEX40.test(statement) && sameAddr(recomputed, statement)) return out;
    if (HEX64.test(recomputed) && HEX64.test(statement) && low(recomputed) === low(statement)) return out;
  }
  if (recomputed !== statement) out.push(`${path}: statement ${brief(statement)}, recomputed ${brief(recomputed)}`);
  return out;
}

export type VerifyOptions = { rpc?: VerifierRpc | null; anchors?: Anchors | null };

export async function verifyPassport(files: PassportFiles, opts: VerifyOptions = {}): Promise<VerificationResult> {
  const findings = new Map<FindingId, Finding>();
  const set = (id: FindingId, status: FindingStatus, detail: string, evidence?: Record<string, unknown>) => { findings.set(id, { id, status, detail, ...(evidence ? { evidence } : {}) }); };
  const finish = (manifest: any): VerificationResult => {
    set("CURRENT_ELIGIBILITY", "NOT_EVALUATED", "whether a new payment may execute now is a present-time question; it is never inferred from historical success");
    const ordered = FINDING_ORDER.map((id) => findings.get(id)).filter((f): f is Finding => !!f);
    const counts = { pass: 0, fail: 0, unverified: 0, notEvaluated: 0 };
    for (const f of ordered) { if (f.status === "PASS") counts.pass++; else if (f.status === "FAIL") counts.fail++; else if (f.status === "UNVERIFIED") counts.unverified++; else counts.notEvaluated++; }
    return { passportVersion: manifest?.passportVersion ?? null, subject: manifest?.subject ?? null, chain: { chainId: manifest?.chain?.chainId ?? null, caip2: manifest?.chain?.caip2 ?? null }, findings: ordered, counts };
  };
  const unusable = (reason: string) => {
    for (const id of ["DIGEST_INTEGRITY", "DISCLOSURE", "APPROVAL_SOURCE", "APPROVAL_COVERAGE", "NETWORK_IDENTITY", "FEE_ATTRIBUTION", "TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT"] as FindingId[]) set(id, "UNVERIFIED", reason);
  };

  // ---- FILE_INTEGRITY
  const fileProblems = fileSetProblems(files);
  let manifest: any = null;
  try { manifest = files["manifest.json"] !== undefined ? JSON.parse(files["manifest.json"]) : null; } catch (e: any) { fileProblems.push(`manifest.json is not valid JSON: ${String(e?.message ?? e).slice(0, 80)}`); }
  if (manifest && manifest.passportVersion !== "1.0") fileProblems.push(`unsupported passportVersion ${JSON.stringify(manifest.passportVersion)}`);
  if (manifest && !Array.isArray(manifest.files)) fileProblems.push("manifest.files is not an array");
  if (!manifest || !Array.isArray(manifest.files) || manifest.passportVersion !== "1.0") {
    set("FILE_INTEGRITY", "FAIL", list(fileProblems.length ? fileProblems : ["manifest unusable"]));
    unusable("manifest unusable; nothing else can be checked");
    return finish(manifest);
  }
  const listed = new Map<string, any>();
  for (const e of manifest.files) {
    if (!e || typeof e.path !== "string") { fileProblems.push("manifest entry without a path"); continue; }
    if (e.path === "manifest.json") fileProblems.push("manifest.json must not list itself");
    if (listed.has(e.path)) fileProblems.push(`${e.path}: listed twice in the manifest`);
    listed.set(e.path, e);
    const content = files[e.path];
    if (content === undefined) { fileProblems.push(`${e.path}: listed in the manifest but missing`); continue; }
    if (utf8Length(content) !== e.bytes) fileProblems.push(`${e.path}: ${utf8Length(content)} bytes, manifest says ${e.bytes}`);
    if (!same(sha256(stringToBytes(content)), e.sha256)) fileProblems.push(`${e.path}: sha256 does not match the manifest`);
  }
  for (const path of Object.keys(files)) if (path !== "manifest.json" && !listed.has(path)) fileProblems.push(`${path}: present but not listed in the manifest`);
  // verification-profile.json is part of the format: it names what a verifier may accept; absent or unknown content is refused
  if (files["verification-profile.json"] === undefined) fileProblems.push("verification-profile.json missing");
  else {
    try {
      const vp = JSON.parse(files["verification-profile.json"]);
      if (vp?.verificationProfileVersion !== "1.0") fileProblems.push(`unsupported verificationProfileVersion ${JSON.stringify(vp?.verificationProfileVersion)}`);
      const accepted = Array.isArray(vp?.acceptedDigestProfiles) ? vp.acceptedDigestProfiles : null;
      if (!accepted || !accepted.length) fileProblems.push("verification-profile.json names no acceptedDigestProfiles");
      else for (const name of accepted) if (!Object.values(ACCEPTED_PROFILES).includes(name)) fileProblems.push(`verification-profile.json names an unsupported digest profile ${JSON.stringify(name)}`);
      if (manifest && vp?.rpc?.chainId !== undefined && vp.rpc.chainId !== manifest.chain?.chainId) fileProblems.push(`verification-profile.json rpc.chainId ${vp.rpc.chainId} != manifest chain ${manifest.chain?.chainId}`);
    } catch { fileProblems.push("verification-profile.json is not valid JSON"); }
  }
  set("FILE_INTEGRITY", fileProblems.length ? "FAIL" : "PASS", fileProblems.length ? list(fileProblems) : `${listed.size} files listed, present and intact`);

  // ---- parse helpers
  const parsed = new Map<string, any>();
  const digestProblems: string[] = [];
  const json = (path: string): any => {
    if (parsed.has(path)) return parsed.get(path);
    if (files[path] === undefined) { parsed.set(path, null); return null; }
    try { const v = JSON.parse(files[path]); parsed.set(path, v); return v; } catch (e: any) { digestProblems.push(`${path}: not valid JSON`); parsed.set(path, null); return null; }
  };
  const intent = json("intent.json"), policy = json("policy.json"), baseline = json("baseline.json"), report = json("report.json"), decision = json("decision.json"), plan = json("transaction-plan.json"), fv = json("final-validation.json"), execution = json("execution.json"), payment = json("payment.json"), summary = json("order-summary.json"), cost = json("cost-statement.json");
  const recomputed = new Map<string, Hex>(); // path -> object digest actually recomputed

  // ---- DIGEST_INTEGRITY: profiles, recomputation, cross-links
  for (const e of manifest.files as any[]) {
    if (!e?.object || files[e.path] === undefined) continue;
    const { digestProfile, kind, digest: claimed } = e.object;
    if (digestProfile === ACCEPTED_PROFILES.jcs) {
      const fn = CORE_DIGESTS[kind];
      if (!fn) { digestProblems.push(`${e.path}: unknown object kind ${JSON.stringify(kind)}`); continue; }
      const value = json(e.path); if (value === null) continue;
      try { const d = fn(value); recomputed.set(e.path, d); if (!same(d, claimed)) digestProblems.push(`${e.path}: ${kind} digest ${d} != manifest ${claimed}`); }
      catch (err: any) { digestProblems.push(`${e.path}: not a valid schema-1.0 ${kind} (${String(err?.message ?? err).slice(0, 80)})`); }
    } else if (digestProfile === ACCEPTED_PROFILES.legacy) {
      const d = keccak256(stringToBytes(files[e.path])); recomputed.set(e.path, d);
      if (!same(d, claimed)) digestProblems.push(`${e.path}: legacy digest ${d} != manifest ${claimed}`);
    } else digestProblems.push(`${e.path}: digest profile ${JSON.stringify(digestProfile)} is not accepted; nothing named inside a passport is executed`);
  }
  const D = (path: string) => recomputed.get(path) ?? null;
  const link = (what: string, a: unknown, b: unknown) => { if (!same(a, b)) digestProblems.push(`${what}: ${a ?? "null"} != ${b ?? "null"}`); };
  if (intent) {
    if (manifest.chain?.chainId !== intent.chainId) digestProblems.push(`manifest chainId ${manifest.chain?.chainId} != intent chainId ${intent.chainId}`);
    if (manifest.subject?.payer && !sameAddr(manifest.subject.payer, intent.from)) digestProblems.push("manifest subject.payer != intent.from");
    if (manifest.subject?.merchant && !sameAddr(manifest.subject.merchant, intent.to)) digestProblems.push("manifest subject.merchant != intent.to");
    if (manifest.subject?.orderId && intent.businessExpectation?.orderId && !same(manifest.subject.orderId, intent.businessExpectation.orderId)) digestProblems.push("manifest subject.orderId != intent order");
    // audit 2026-10-10 (VF-01): a run that went to execution (a plan exists) must have planned the intent's EXACT call, and the intent must
    // satisfy its own business expectation and the anchored policy — a rehashed, self-consistent passport cannot describe one call and execute another
    if (plan) {
      const dev: string[] = [];
      if (Number(plan.chainId) !== Number(intent.chainId)) dev.push("chainId"); if (!sameAddr(plan.from, intent.from)) dev.push("from"); if (!sameAddr(plan.to, intent.to)) dev.push("to");
      if (!same(plan.data, intent.data)) dev.push("data"); if (String(plan.valueNativeAtomic) !== String(intent.valueNativeAtomic)) dev.push("value"); if (!isType2(plan.type)) dev.push("type");
      if (dev.length) digestProblems.push(`transaction-plan.json is not the intent's exact call (differs in ${dev.join(", ")})`);
      if (fv?.transactionPlan) { try { if (!same(transactionPlanDigest(fv.transactionPlan), D("transaction-plan.json") ?? transactionPlanDigest(plan))) digestProblems.push("final-validation.json embeds a plan whose digest differs from transaction-plan.json"); } catch { digestProblems.push("final-validation.json embeds a plan that is not a valid schema-1.0 transaction plan"); } }
      const be = intent.businessExpectation;
      if (be?.action === "MERCHANT_PAY") {
        if (!sameAddr(be.recipient, intent.to)) digestProblems.push("intent.to != businessExpectation.recipient");
        if (String(be.amountNativeAtomic) !== String(intent.valueNativeAtomic)) digestProblems.push("intent.valueNativeAtomic != businessExpectation.amountNativeAtomic");
        try { if (!same(intent.data, encodeFunctionData({ abi: PAY_ABI, functionName: "pay", args: [be.orderId as ViemHex] }))) digestProblems.push("intent.data is not pay(businessExpectation.orderId)"); } catch { digestProblems.push("businessExpectation.orderId is not a 32-byte id"); }
      }
      if (policy) {
        if (Array.isArray(policy.allowedSenders) && !policy.allowedSenders.some((a: string) => sameAddr(a, intent.from))) digestProblems.push("intent.from is not in policy.allowedSenders");
        if (Array.isArray(policy.allowedTargets) && !policy.allowedTargets.some((a: string) => sameAddr(a, intent.to))) digestProblems.push("intent.to is not in policy.allowedTargets");
        const sel = String(intent.data ?? "").slice(0, 10).toLowerCase(); if (Array.isArray(policy.allowedSelectors) && !policy.allowedSelectors.some((x: string) => low(x) === sel)) digestProblems.push("intent.data selector is not in policy.allowedSelectors");
        const maxNative = big(policy.maxNativePaymentAtomic), val = big(intent.valueNativeAtomic); if (maxNative !== null && val !== null && val > maxNative) digestProblems.push("intent.valueNativeAtomic exceeds policy.maxNativePaymentAtomic");
      }
    }
    // audit 2026-10-10 (VF-02): the quote's asset and network are the canonical USDC and CAIP-2 of the intent's chain, never the passport's own choice
    { const canon = canonicalArc(intent.chainId); if (canon && payment?.quote) { if (!sameAddr(payment.quote.asset, canon.usdc)) digestProblems.push(`quote.asset ${payment.quote.asset} is not the canonical Arc USDC ${canon.usdc}`); if (low(payment.quote.network) !== canon.caip2) digestProblems.push(`quote.network ${payment.quote.network} != ${canon.caip2}`); } }
    if (report?.intentDigest) link("report.intentDigest", report.intentDigest, D("intent.json"));
    // review of bf0c800 (P1): the intent, the decision, the final validation and the execution all reference ONE policy — the recomputed
    // policy.json (which APPROVAL_SOURCE anchors); without policy.json the receipts must at least agree with the intent's reference
    const policyRef = policy ? D("policy.json") : intent.policyDigest;
    if (policy) link("intent.policyDigest", intent.policyDigest, policyRef);
    if (baseline) { link("baseline digest vs intent.baselineDigest", D("baseline.json"), intent.baselineDigest); if (!sameAddr(baseline.subject, intent.to)) digestProblems.push("baseline.subject != intent.to"); if (baseline.chainId !== intent.chainId) digestProblems.push("baseline.chainId != intent.chainId"); }
    if (decision) { link("decision.intentDigest", decision.intentDigest, D("intent.json")); link("decision.reportDigest", decision.reportDigest, D("report.json")); link("decision.baselineDigest", decision.baselineDigest, intent.baselineDigest); link("decision.policyDigest", decision.policyDigest, policyRef); }
    if (fv) { link("finalValidation.intentDigest", fv.intentDigest, D("intent.json")); link("finalValidation.reportDigest", fv.reportDigest, D("report.json")); link("finalValidation.decisionDigest", fv.decisionDigest, D("decision.json")); link("finalValidation.baselineDigest", fv.baselineDigest, intent.baselineDigest); link("finalValidation.policyDigest", fv.policyDigest, policyRef);
      if (!plan) digestProblems.push("final-validation.json present without transaction-plan.json"); else link("finalValidation.transactionPlanDigest", fv.transactionPlanDigest, D("transaction-plan.json"));
      if (fv.snapshot?.chainId !== intent.chainId) digestProblems.push("final validation snapshot chain != intent chain"); }
    if (execution) {
      link("execution.intentDigest", execution.intentDigest, D("intent.json")); link("execution.reportDigest", execution.reportDigest, D("report.json")); link("execution.decisionDigest", execution.decisionDigest, D("decision.json")); link("execution.baselineDigest", execution.baselineDigest, intent.baselineDigest); link("execution.policyDigest", execution.policyDigest, policyRef);
      if (fv || execution.finalValidationDigest) link("execution.finalValidationDigest", execution.finalValidationDigest, D("final-validation.json"));
      if (plan || execution.transactionPlanDigest) link("execution.transactionPlanDigest", execution.transactionPlanDigest, D("transaction-plan.json"));
      const pc = D("evidence/postcondition.json");
      if (pc && !(execution.postconditionEvidenceDigests ?? []).some((x: string) => same(x, pc))) digestProblems.push("evidence/postcondition.json digest is not referenced by execution.postconditionEvidenceDigests");
    }
    if (report) for (const path of Object.keys(files)) {
      if (path.startsWith("evidence/report/")) { const d = D(path); const name = path.slice("evidence/report/".length, -".json".length); if (!d) continue; if (!same(name, d)) digestProblems.push(`${path}: file name is not its digest`); if (!(report.rawEvidenceDigests ?? []).some((x: string) => same(x, d))) digestProblems.push(`${path}: not referenced by report.rawEvidenceDigests`); }
      if (path.startsWith("evidence/final-validation/")) { const d = D(path); if (!d) continue; const refs = fv ? [...(fv.criticalStateEvidenceDigests ?? []), fv.simulationEvidenceDigest, fv.walletEvidenceDigest] : []; if (!refs.some((x: string) => same(x, d))) digestProblems.push(`${path}: not referenced by the final-validation receipt`); }
    }
    if (payment) {
      if (payment.quote) { try { link("payment.quoteDigest", quoteDigest(payment.quote), payment.quoteDigest); } catch (e: any) { digestProblems.push(`payment.quote is not a valid schema-1.0 quote`); }
        link("quote.intentDigest", payment.quote.intentDigest, D("intent.json")); link("quote.reportDigest", payment.quote.reportDigest, D("report.json"));
        if (!sameAddr(payment.quote.payer, intent.from)) digestProblems.push("quote.payer != intent.from");
        if (payment.authorization) { if (!sameAddr(payment.authorization.to, payment.quote.payTo)) digestProblems.push("authorization.to != quote.payTo"); if (payment.authorization.value !== payment.quote.amountTokenAtomic) digestProblems.push("authorization.value != quote.amountTokenAtomic"); } }
      if (payment.authorization && !sameAddr(payment.authorization.from, intent.from)) digestProblems.push("authorization.from != intent.from");
      if (payment.authorization && "signature" in payment.authorization) digestProblems.push("payment.authorization carries a signature field");
    }
    if (summary) {
      if (!same(summary.orderId, intent.businessExpectation?.orderId)) digestProblems.push("order-summary.orderId != intent order"); if (!sameAddr(summary.merchant, intent.to)) digestProblems.push("order-summary.merchant != intent.to"); if (!sameAddr(summary.payer, intent.from)) digestProblems.push("order-summary.payer != intent.from");
      if (summary.amountNativeAtomic !== intent.businessExpectation?.amountNativeAtomic) digestProblems.push("order-summary.amountNativeAtomic != approved order amount");
      if (!same(summary.referencedApproval?.baselineDigest, intent.baselineDigest)) digestProblems.push("order-summary.referencedApproval.baselineDigest != intent.baselineDigest");
      if (decision && summary.decision !== decision.decision) digestProblems.push("order-summary.decision != decision receipt");
      if (execution && summary.chainResult !== execution.chainStatus) digestProblems.push("order-summary.chainResult != execution.chainStatus");
      if (execution && !same(summary.businessTx ?? "", execution.businessTxHash ?? "") && (summary.businessTx || execution.businessTxHash)) digestProblems.push("order-summary.businessTx != execution.businessTxHash");
      if (summary.serviceOutcome !== "NOT_EVALUATED") digestProblems.push("order-summary.serviceOutcome must be NOT_EVALUATED");
      if (manifest.subject?.executionMode !== undefined && summary.executionMode !== undefined && summary.executionMode !== manifest.subject.executionMode) digestProblems.push(`order-summary.executionMode ${summary.executionMode} != manifest subject.executionMode ${manifest.subject.executionMode}`);
    }
  } else digestProblems.push("intent.json missing or unreadable");
  if (!report) digestProblems.push("report.json missing or unreadable");
  const subjectMode = manifest.subject?.executionMode;
  if (subjectMode !== undefined && subjectMode !== "runner" && subjectMode !== "wallet") digestProblems.push(`manifest subject.executionMode ${JSON.stringify(subjectMode)} is not runner or wallet`);
  if ((manifest.subject?.kind === "wallet-run" && subjectMode !== undefined && subjectMode !== "wallet") || (manifest.subject?.kind === "demo-run" && subjectMode === "wallet")) digestProblems.push(`manifest subject.kind ${manifest.subject.kind} is inconsistent with executionMode ${subjectMode}`);
  set("DIGEST_INTEGRITY", digestProblems.length ? "FAIL" : "PASS", digestProblems.length ? list(digestProblems) : `${recomputed.size} digested objects re-hashed under accepted profiles; cross-links hold`);

  // ---- DISCLOSURE
  const leaks: string[] = [];
  const signedHash = execution?.signedTransactionHash ? low(execution.signedTransactionHash) : null;
  for (const [path, content] of Object.entries(files)) {
    if (/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/.test(content)) leaks.push(`${path}: 65-byte hex value (signature-shaped)`);
    if (/"(privateKey|private_key|relay_raw_tx[A-Za-z_]*|settle_payload[A-Za-z_]*|raw_tx_encrypted|mnemonic|seedPhrase|secretKey)"\s*:/.test(content)) leaks.push(`${path}: forbidden key`);
    if (signedHash) for (const m of content.match(/0x[0-9a-fA-F]{200,}/g) ?? []) if (low(keccak256(m as ViemHex)) === signedHash) leaks.push(`${path}: contains the signed business transaction bytes`);
  }
  set("DISCLOSURE", leaks.length ? "FAIL" : "PASS", leaks.length ? list(leaks) : "no signatures, private keys, encrypted payloads or signed transaction bytes in the export");

  // ---- APPROVAL_SOURCE (anchors) and APPROVAL_COVERAGE (history)
  const anchors = opts.anchors ?? null;
  if (!anchors) set("APPROVAL_SOURCE", "UNVERIFIED", "no anchors supplied: a passport cannot vouch for its own approval");
  else if (!intent) set("APPROVAL_SOURCE", "UNVERIFIED", "intent unreadable");
  else {
    const bAnch = (anchors.baselineDigests ?? []).map(low), pAnch = (anchors.policyDigests ?? []).map(low);
    const bd = D("baseline.json"), pd = D("policy.json");
    const problems: string[] = [];
    if (!bd) set("APPROVAL_SOURCE", "UNVERIFIED", `baseline.json omitted; the intent references ${intent.baselineDigest}, which ${bAnch.includes(low(intent.baselineDigest)) ? "is" : "is not"} among the anchors, but its content cannot be checked`);
    else {
      if (!bAnch.includes(low(bd))) problems.push(`baseline ${bd} is not an anchored approval`);
      if (pd && !pAnch.includes(low(pd))) problems.push(`policy ${pd} is not an anchored policy`);
      if (!pd && policy === null && files["policy.json"] === undefined && manifest.subject?.kind !== "paid-check") problems.push("policy.json missing");
      set("APPROVAL_SOURCE", problems.length ? "FAIL" : "PASS", problems.length ? list(problems) : `baseline ${bd}${pd ? ` and policy ${pd}` : ""} match the supplied anchors`);
    }
  }
  if (!intent || !report) set("APPROVAL_COVERAGE", "UNVERIFIED", "intent or report unreadable");
  else {
    const problems: string[] = []; const notes: string[] = [];
    const refs = [["decision", decision?.baselineDigest], ["final validation", fv?.baselineDigest], ["execution", execution?.baselineDigest]].filter(([, v]) => v !== undefined && v !== null);
    for (const [what, v] of refs) if (!same(v, intent.baselineDigest)) problems.push(`${what} references approval ${v}, intent references ${intent.baselineDigest}`);
    if (report.baselineDigest && !same(report.baselineDigest, intent.baselineDigest)) problems.push(`report evaluated approval ${report.baselineDigest}, intent references ${intent.baselineDigest}`);
    if (decision) { if (report.baselineResult !== "MATCH" && decision.decision === "NO_POLICY_VIOLATION") problems.push(`decision NO_POLICY_VIOLATION although the report's baselineResult is ${report.baselineResult}`); }
    else notes.push("check only: no decision or execution in this passport");
    const rawStatus = summary?.referencedApproval?.statusAtFinalValidation;
    const status = rawStatus === undefined || rawStatus === null ? null : rawStatus;
    // "executed" in either mode: the runner records the signed hash; a wallet run records only the business hash / chain status
    const executed = !!execution && (!!execution.signedTransactionHash || !!execution.businessTxHash || !["NOT_SIGNED", "SIGNED_NOT_BROADCAST"].includes(String(execution.chainStatus)));
    const ms = (v: unknown): number | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
    const sameExpiry = (a: unknown, b: unknown) => ((a === null || a === undefined) && (b === null || b === undefined)) || (a !== null && a !== undefined && b !== null && b !== undefined && ms(a) !== null && ms(a) === ms(b));
    // the recorded status must be well-formed before it may vouch for anything (review round 3): an explicit boolean, a valid read time
    // inside the run (after the report's observation, not after the execution record), and a valid or null validUntil
    const statusProblems: string[] = [];
    if (status !== null) {
      if (typeof status !== "object" || typeof status.revoked !== "boolean") statusProblems.push("statusAtFinalValidation.revoked is not a boolean");
      const fetchedAt = ms(status?.fetchedAt);
      if (fetchedAt === null) statusProblems.push("statusAtFinalValidation.fetchedAt is not a valid timestamp");
      else {
        const observed = ms(report.observation?.observedAt); const recorded = ms(execution?.recordedAt);
        if (observed !== null && fetchedAt < observed) statusProblems.push(`statusAtFinalValidation.fetchedAt ${status.fetchedAt} precedes the report's observation ${report.observation?.observedAt}`);
        if (recorded !== null && fetchedAt > recorded) statusProblems.push(`statusAtFinalValidation.fetchedAt ${status.fetchedAt} is after the execution record ${execution?.recordedAt}`);
      }
      if (status?.validUntil !== null && status?.validUntil !== undefined && ms(status.validUntil) === null) statusProblems.push("statusAtFinalValidation.validUntil is neither null nor a valid timestamp");
      if (status?.validUntil === undefined) statusProblems.push("statusAtFinalValidation.validUntil is missing (null means no expiry)");
    }
    if (baseline && baseline.validUntil !== null && baseline.validUntil !== undefined && ms(baseline.validUntil) === null) statusProblems.push("baseline.validUntil is not a valid timestamp");
    let unverified = false;
    if (executed) {
      if (!baseline) { unverified = true; notes.push("baseline.json omitted: the approval's content and validity at execution cannot be checked"); }
      else if (baseline.validUntil && fv?.validatedAt && ms(baseline.validUntil) !== null && ms(fv.validatedAt) !== null && ms(baseline.validUntil)! < ms(fv.validatedAt)!) problems.push(`the referenced approval expired at ${baseline.validUntil}, before final validation at ${fv.validatedAt}, yet a transaction was executed`);
      if (statusProblems.length) problems.push(`malformed approval status recorded for an executed transaction: ${statusProblems.join("; ")}`);
      else if (!status) { unverified = true; notes.push("revocation state at execution not retained"); }
      else if (status.revoked) problems.push("the referenced approval was recorded as revoked at final validation, yet a transaction was executed");
      else if (status.validUntil && ms(status.validUntil)! < ms(status.fetchedAt)!) problems.push(`the referenced approval was recorded as expired (valid until ${status.validUntil}) when it was read at ${status.fetchedAt}, yet a transaction was executed`);
      // review of 0c0d406 (P2): the status expiry must hold at the final-validation boundary, and it must be the baseline's own expiry — the
      // producer copies it from the referenced baseline, so two different values are contradictory evidence, not two facts
      else if (status.validUntil && fv?.validatedAt && ms(fv.validatedAt) !== null && ms(status.validUntil)! < ms(fv.validatedAt)!) problems.push(`the referenced approval's recorded expiry ${status.validUntil} precedes final validation at ${fv.validatedAt}, yet a transaction was executed`);
      else if (baseline && !sameExpiry(baseline.validUntil, status.validUntil)) problems.push(`contradictory expiry evidence: the approval status records validUntil ${status.validUntil ?? "null"} while the referenced baseline says ${baseline.validUntil ?? "null"} (the status is read from that baseline, so the two must agree)`);
      else notes.push(`approval ${intent.baselineDigest} read as not revoked at ${status.fetchedAt}${status.validUntil ? ` (valid until ${status.validUntil}, as the baseline says)` : " (no expiry, as the baseline says)"}`);
    } else {
      if (statusProblems.length) notes.push(`approval status recorded but malformed (nothing was executed): ${statusProblems.join("; ")}`);
      else if (status && baseline && !sameExpiry(baseline.validUntil, status.validUntil)) notes.push(`approval status expiry ${status.validUntil ?? "null"} differs from the baseline's ${baseline.validUntil ?? "null"} (nothing was executed)`);
      else if (status?.revoked && decision?.decision === "NO_POLICY_VIOLATION") problems.push("the referenced approval was recorded as revoked at final validation, yet the decision is NO_POLICY_VIOLATION");
    }
    unverified = unverified && !problems.length;
    set("APPROVAL_COVERAGE", problems.length ? "FAIL" : unverified ? "UNVERIFIED" : "PASS", problems.length ? list(problems) : [`every receipt references approval ${intent.baselineDigest}; report result ${report.baselineResult}${decision ? `, decision ${decision.decision}` : ""}`, ...notes].join("; "));
  }

  // ---- online findings
  const rpc = opts.rpc ?? null;
  const onlineIds: FindingId[] = ["FEE_ATTRIBUTION", "TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT"];
  if (!rpc) { set("NETWORK_IDENTITY", "UNVERIFIED", "no RPC configured"); for (const id of onlineIds) set(id, "UNVERIFIED", "no RPC configured"); return finish(manifest); }
  let chainId: number | null = null;
  try { chainId = await rpc.getChainId(); } catch (e: any) { set("NETWORK_IDENTITY", "UNVERIFIED", `RPC unreachable: ${errText(e).slice(0, 80)}`); for (const id of onlineIds) set(id, "UNVERIFIED", "RPC unreachable"); return finish(manifest); }
  if (chainId !== manifest.chain?.chainId) { set("NETWORK_IDENTITY", "FAIL", `RPC serves chain ${chainId}, passport is for chain ${manifest.chain?.chainId}`); for (const id of onlineIds) set(id, "UNVERIFIED", "network mismatch: online checks skipped"); return finish(manifest); }
  const canonical = canonicalArc(chainId);
  if (!canonical) { set("NETWORK_IDENTITY", "FAIL", `chain ${chainId} is not an Arc network this verifier knows (5042, 5042002)`); for (const id of onlineIds) set(id, "UNVERIFIED", "unknown network: online checks skipped"); return finish(manifest); }
  if (!sameAddr(manifest.chain?.usdc, canonical.usdc) || low(manifest.chain?.caip2) !== canonical.caip2) {
    set("NETWORK_IDENTITY", "FAIL", `passport names USDC ${manifest.chain?.usdc} on ${manifest.chain?.caip2}; the canonical identity of chain ${chainId} is USDC ${canonical.usdc} on ${canonical.caip2} — a passport does not choose which contract counts as USDC`);
    for (const id of onlineIds) set(id, "UNVERIFIED", "asset identity mismatch: online checks skipped"); return finish(manifest);
  }
  set("NETWORK_IDENTITY", "PASS", `RPC serves chain ${chainId} (${canonical.caip2}); USDC is the canonical ${canonical.usdc}`);
  const usdc = canonical.usdc as Hex; // the canonical contract, never the passport's word
  /** docs/LIFECYCLE.md §1/§6: wallet mode relaxes the plan agreement to the fields that identify the call; everything else is runner mode. */
  const mode: "runner" | "wallet" = manifest.subject?.executionMode === "wallet" ? "wallet" : "runner";
  // Every rpc.* read goes through `fetched`, which keeps "the RPC threw" apart from "not found": unavailable history is UNVERIFIED, never FAIL.
  type Fetched = { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string };
  const memo = new Map<string, Promise<Fetched>>();
  const fetched = (key: string, run: () => Promise<Record<string, unknown> | null>) => { if (!memo.has(key)) memo.set(key, run().then((value): Fetched => ({ ok: true, value }), (e): Fetched => ({ ok: false, error: errText(e) }))); return memo.get(key)!; };
  const tx = (h: string) => fetched(`tx:${low(h)}`, () => rpc.getTransaction(h as Hex));
  const rc = (h: string) => fetched(`rc:${low(h)}`, () => rpc.getTransactionReceipt(h as Hex));
  const firstError = (...xs: Fetched[]) => xs.find((x): x is { ok: false; error: string } => !x.ok)?.error ?? "unknown error";

  // FEE_ATTRIBUTION
  const auth = payment?.authorization ?? null, feeHash = payment?.settlement?.transactionHash ?? null;
  if (!payment || !auth) set("FEE_ATTRIBUTION", "UNVERIFIED", "payment.json has no authorization to attribute");
  else if (!feeHash) set("FEE_ATTRIBUTION", "UNVERIFIED", `no settlement transaction recorded (state ${payment.settlement?.state ?? "unknown"})`);
  else if (!usdc) set("FEE_ATTRIBUTION", "UNVERIFIED", "manifest does not name the USDC contract");
  else {
    const [ft, fr] = await Promise.all([tx(feeHash), rc(feeHash)]);
    if (!ft.ok || !fr.ok) set("FEE_ATTRIBUTION", "UNVERIFIED", `settlement transaction ${feeHash} could not be fetched: ${firstError(ft, fr)}`);
    else if (!ft.value || !fr.value) set("FEE_ATTRIBUTION", "UNVERIFIED", `settlement transaction ${feeHash} not found on this RPC`);
    else {
      const t = ft.value, r = fr.value;
      if (!succeeded(r)) set("FEE_ATTRIBUTION", "FAIL", `settlement transaction ${feeHash} did not succeed`);
      else if (!sameAddr(t.to, usdc)) set("FEE_ATTRIBUTION", "FAIL", `settlement transaction targets ${t.to}, not the USDC contract ${usdc}`);
      else {
        const ev = findSettlementInLogs((r.logs as any[]) ?? [], { usdc: usdc as ViemHex, from: auth.from, to: auth.to, value: BigInt(auth.value), nonce: auth.nonce }, feeHash);
        if (!ev) set("FEE_ATTRIBUTION", "FAIL", "receipt lacks AuthorizationUsed(payer, nonce) + Transfer(payer → payTo, amount) from the USDC contract for this authorization");
        else {
          const problems: string[] = []; const notes: string[] = [];
          const s = payment.settlement;
          if (s.blockNumber !== null && s.blockNumber !== undefined && big(s.blockNumber) !== big(ev.blockNumber)) problems.push(`payment.json says block ${s.blockNumber}, chain says ${ev.blockNumber}`);
          if (s.authorizationUsedLogIndex !== null && s.authorizationUsedLogIndex !== undefined && Number(s.authorizationUsedLogIndex) !== ev.authorizationUsedLogIndex) problems.push("AuthorizationUsed log index differs from payment.json");
          if (s.transferLogIndex !== null && s.transferLogIndex !== undefined && Number(s.transferLogIndex) !== ev.transferLogIndex) problems.push("Transfer log index differs from payment.json");
          if (s.relayer && !sameAddr(s.relayer, t.from)) problems.push(`payment.json names relayer ${s.relayer}, the transaction was sent by ${t.from}`);
          // The logs prove from/to/value/nonce; only the calldata carries validAfter/validBefore. A direct USDC call must agree with payment.json in every field.
          const input = String(t.input ?? t.data ?? "");
          const call = decodeEip3009Call(input);
          const matches = authorizationCallMatches(input, auth);
          const validityVerified = !!call && matches;
          if (call && !matches) problems.push(`calldata authorization differs from payment.json (fields ${authorizationFieldDiffs(call, auth).join(", ") || "undetermined"})`);
          if (!call) notes.push("not a direct call; validity window not verifiable from calldata");
          const inputHash = HEX_BYTES.test(input) ? keccak256(input as ViemHex) : null;
          let captureHash: "matches" | "absent" | "differs" | "no-capture" = "no-capture";
          if (files["evidence/chain/fee-tx.json"] !== undefined) {
            const recorded = json("evidence/chain/fee-tx.json")?.tx?.inputKeccak256;
            if (typeof recorded === "string" && recorded) {
              if (inputHash && same(recorded, inputHash)) captureHash = "matches";
              else { captureHash = "differs"; problems.push(`evidence/chain/fee-tx.json records inputKeccak256 ${recorded}, the fetched calldata hashes to ${inputHash ?? "nothing decodable"}`); }
            } else { captureHash = "absent"; notes.push("evidence/chain/fee-tx.json carries no inputKeccak256; the capture is not tied to the fetched calldata"); }
          }
          set("FEE_ATTRIBUTION", problems.length ? "FAIL" : "PASS",
            problems.length ? list(problems) : [`${auth.value} token units moved ${auth.from} → ${auth.to} in ${feeHash} (block ${ev.blockNumber}), relayed by ${t.from}${call ? ` through a direct USDC ${call.name} call whose authorization equals payment.json in every field (valid ${auth.validAfter}–${auth.validBefore})` : " (not a direct USDC authorization call)"}${captureHash === "matches" ? "; capture inputKeccak256 matches the fetched calldata" : ""}`, ...notes].join("; "),
            { relayer: t.from, blockNumber: ev.blockNumber, authorizationUsedLogIndex: ev.authorizationUsedLogIndex, transferLogIndex: ev.transferLogIndex, directCall: !!call, entryPoint: call?.name ?? null, validityVerified, calldataKeccak256: inputHash, captureHash });
        }
      }
    }
  }

  // TRANSACTION_PLAN_AGREEMENT
  const bizHash = execution?.businessTxHash ?? null;
  if (!plan || !bizHash) set("TRANSACTION_PLAN_AGREEMENT", "UNVERIFIED", "no business transaction: nothing was signed or broadcast for this workflow");
  else {
    const bt = await tx(bizHash);
    if (!bt.ok) set("TRANSACTION_PLAN_AGREEMENT", "UNVERIFIED", `business transaction ${bizHash} could not be fetched: ${bt.error}`);
    else if (!bt.value) set("TRANSACTION_PLAN_AGREEMENT", "UNVERIFIED", `business transaction ${bizHash} not found on this RPC`);
    else {
      const t = bt.value;
      const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const shown = (v: unknown) => (v === undefined || v === null ? "absent" : typeof v === "string" && v.length > 24 ? `${v.slice(0, 22)}…` : String(v));
      let fields: { field: string; strict: boolean; plan: string; transaction: string; differs: boolean }[] | null = null;
      try {
        // strict = the identity of the call (and the wallet-mode must-match set of LIFECYCLE §6); the rest is wallet-set in wallet mode. Runner mode: every field.
        fields = [
          { field: "chainId", strict: true, plan: String(plan.chainId), transaction: shown(t.chainId ?? plan.chainId), differs: Number(t.chainId ?? plan.chainId) !== plan.chainId },
          { field: "type", strict: true, plan: "2", transaction: shown(t.type), differs: !isType2(t.type) },
          { field: "from", strict: true, plan: String(plan.from), transaction: shown(t.from), differs: !sameAddr(t.from, plan.from) },
          { field: "to", strict: true, plan: String(plan.to), transaction: shown(t.to), differs: !sameAddr(t.to, plan.to) },
          { field: "data", strict: true, plan: shown(plan.data), transaction: shown(t.input ?? t.data), differs: !same(t.input ?? t.data, plan.data) },
          { field: "value", strict: true, plan: String(plan.valueNativeAtomic), transaction: shown(t.value), differs: big(t.value) !== BigInt(plan.valueNativeAtomic) },
          { field: "nonce", strict: false, plan: String(plan.nonce), transaction: shown(t.nonce), differs: big(t.nonce) !== BigInt(plan.nonce) },
          { field: "gas", strict: false, plan: String(plan.gasLimit), transaction: shown(t.gas), differs: big(t.gas) !== BigInt(plan.gasLimit) },
          { field: "maxFeePerGas", strict: false, plan: String(plan.maxFeePerGasNativeAtomic), transaction: shown(t.maxFeePerGas), differs: big(t.maxFeePerGas) !== BigInt(plan.maxFeePerGasNativeAtomic) },
          { field: "maxPriorityFeePerGas", strict: false, plan: String(plan.maxPriorityFeePerGasNativeAtomic), transaction: shown(t.maxPriorityFeePerGas), differs: big(t.maxPriorityFeePerGas) !== BigInt(plan.maxPriorityFeePerGasNativeAtomic) },
          { field: "accessList", strict: false, plan: "[]", transaction: `${count(t.accessList)} entries`, differs: count(t.accessList) !== 0 },
          { field: "authorizationList", strict: true, plan: "[]", transaction: `${count(t.authorizationList)} entries`, differs: count(t.authorizationList) !== 0 },
        ];
      } catch (e) { set("TRANSACTION_PLAN_AGREEMENT", "UNVERIFIED", `transaction-plan.json is not comparable: ${errText(e)}`); }
      if (fields) {
        const differing = fields.filter((f) => f.differs);
        const failing = mode === "wallet" ? differing.filter((f) => f.strict) : differing;
        const deviations = mode === "wallet" ? differing.filter((f) => !f.strict).map(({ field, plan: planned, transaction }) => ({ field, plan: planned, transaction })) : [];
        const evidence = { executionMode: mode, deviations };
        if (failing.length) set("TRANSACTION_PLAN_AGREEMENT", "FAIL", `business transaction deviates from the validated plan: ${failing.map((f) => f.field).join(", ")}${mode === "wallet" ? " (wallet mode: chainId, type, from, to, data, value and authorizationList must match the plan)" : ""}`, evidence);
        else if (mode === "wallet") set("TRANSACTION_PLAN_AGREEMENT", "PASS", `business transaction ${bizHash} matches the validated plan in chainId, type, from, to, data and value (wallet mode)${deviations.length ? `; wallet-set deviations recorded, not failed: ${deviations.map((d) => `${d.field} plan ${d.plan}, transaction ${d.transaction}`).join(", ")}` : "; nonce, gas and fees as planned"}`, evidence);
        else set("TRANSACTION_PLAN_AGREEMENT", "PASS", `business transaction ${bizHash} matches the validated plan field by field (type 2, nonce ${plan.nonce}, gas ${plan.gasLimit})`, evidence);
      }
    }
  }

  // ORDER_OUTCOME
  if (!bizHash || !intent || !execution) set("ORDER_OUTCOME", "UNVERIFIED", "no business transaction: nothing was signed or broadcast for this workflow");
  else {
    const br = await rc(bizHash);
    const orderId = low(intent.businessExpectation?.orderId) as Hex, merchant = intent.to as Hex, payer = intent.from as Hex, amount = big(intent.businessExpectation?.amountNativeAtomic ?? "0") ?? 0n;
    if (!br.ok) set("ORDER_OUTCOME", "UNVERIFIED", `receipt for ${bizHash} could not be fetched: ${br.error}`);
    else if (!br.value) set("ORDER_OUTCOME", "UNVERIFIED", `receipt for ${bizHash} not found on this RPC`);
    else if (!br.value.blockHash) set("ORDER_OUTCOME", "UNVERIFIED", "receipt carries no block hash; the order cannot be read at that block");
    else {
      const bizReceipt = br.value, blockHash = bizReceipt.blockHash as Hex;
      const problems: string[] = [];
      const ok = succeeded(bizReceipt);
      const expectPaid = execution.businessStatus === "SUCCESS";
      const paidLog = ((bizReceipt.logs as any[]) ?? []).some((l) => sameAddr(l.address, merchant) && same(l.topics?.[0], ORDER_PAID_TOPIC) && same(l.topics?.[1], orderId) && same(l.topics?.[2], addressTopic(payer)) && l.data && l.data !== "0x" && big(l.data) === amount);
      if (ok && !paidLog) problems.push("receipt succeeded but carries no OrderPaid(orderId, payer, amount) from the merchant");
      if (!ok && expectPaid) problems.push("execution receipt records SUCCESS but the transaction reverted");
      // Historical state: an RPC that cannot serve the block or its state leaves the order unread (UNVERIFIED); only a read that contradicts the records fails.
      let state: { payer: string; amount: bigint; paid: boolean } | null = null; let unavailable: string | null = null;
      let out: Hex | null = null;
      try { out = await rpc.call({ to: merchant, data: encodeFunctionData({ abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] }), blockHash }); }
      catch (e) {
        const reason = errText(e);
        let blockServed: boolean | null = null;
        try { blockServed = (await rpc.getBlock(blockHash)) !== null; } catch { blockServed = null; }
        unavailable = blockServed === false ? `block ${blockHash} is not served by this RPC, so the order cannot be read at the receipt block (${reason})` : `historical order state at block ${big(bizReceipt.blockNumber) ?? blockHash} could not be read from this RPC: ${reason}`;
      }
      if (out !== null) {
        try { const [p, a, paid] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }], out as ViemHex); state = { payer: p, amount: a, paid }; }
        catch (e) { unavailable = `getOrder at block ${big(bizReceipt.blockNumber) ?? blockHash} returned ${brief(out)}, which is not a decodable order record (${errText(e)})`; }
      }
      if (state) {
        if (state.paid !== expectPaid) problems.push(`order reads paid=${state.paid} at the receipt block, execution receipt says ${execution.businessStatus}`);
        if (expectPaid && (!sameAddr(state.payer, payer) || state.amount !== amount)) problems.push(`order paid by ${state.payer} for ${state.amount}, expected ${payer} for ${amount}`);
        const pcFile = files["evidence/postcondition.json"];
        if (pcFile !== undefined) {
          const reproduced = JSON.stringify({ orderId, paid: state.paid, payer: getAddress(state.payer), amountNativeAtomic: state.amount.toString(), block: String(big(bizReceipt.blockNumber) ?? ""), receiptStatus: ok ? "success" : "reverted" });
          if (reproduced !== pcFile) problems.push(`post-condition record not reproduced byte-exact from chain facts (stored ${pcFile.slice(0, 120)}…; reproduced ${reproduced.slice(0, 120)}…)`);
        }
      }
      if (problems.length) set("ORDER_OUTCOME", "FAIL", list(unavailable ? [...problems, `additionally unverifiable: ${unavailable}`] : problems));
      else if (unavailable) set("ORDER_OUTCOME", "UNVERIFIED", `${unavailable}; the receipt itself ${ok ? "succeeded" : "reverted"} and the OrderPaid log is ${paidLog ? "present" : "absent"}`);
      else set("ORDER_OUTCOME", "PASS", `order ${orderId} reads paid=${state?.paid} by ${state?.payer} for ${state?.amount} at block ${big(bizReceipt.blockNumber)} (receipt ${ok ? "success" : "reverted"}, OrderPaid ${paidLog ? "present" : "absent"})${files["evidence/postcondition.json"] !== undefined ? "; post-condition record reproduced byte-exact" : ""}`);
    }
  }

  // COST_STATEMENT: the whole statement is recomputed with the exporter's own function from the passport's records and the fetched
  // receipts, then compared field by field (notes as a set, capturedAt and the service-side reservation taken from the statement).
  if (!cost) set("COST_STATEMENT", "UNVERIFIED", "no cost-statement.json");
  else if (!intent || !execution || !policy) set("COST_STATEMENT", "UNVERIFIED", `cost statement not recomputable: ${[!intent && "intent.json", !execution && "execution.json", !policy && "policy.json"].filter(Boolean).join(", ")} missing or unreadable`);
  else {
    const problems: string[] = []; const notes: string[] = []; let missing = 0;
    const feeSrc = (payment?.settlement?.transactionHash ?? summary?.checkFee?.tx ?? null) as Hex | null;
    const bizSrc = (execution.businessTxHash ?? null) as Hex | null;
    const createSrc = (summary?.createOrder?.tx ?? null) as Hex | null;
    type Got = { receipt: ReceiptLike | null; sender: string | null };
    const fetchFor = async (label: string, hash: Hex | null, entry: any, expectedSender: string | null | undefined): Promise<Got> => {
      if (!hash) return { receipt: null, sender: null };
      const [t, r] = await Promise.all([tx(hash), rc(hash)]);
      if (!t.ok || !r.ok) { missing++; notes.push(`${label}: ${hash} could not be fetched: ${firstError(t, r)}`); return { receipt: null, sender: null }; }
      if (!t.value || !r.value) { missing++; notes.push(`${label}: ${hash} not found on this RPC`); return { receipt: null, sender: null }; }
      const used = big(r.value.gasUsed), price = big(r.value.effectiveGasPrice);
      if (used === null || price === null) { missing++; notes.push(`${label}: receipt lacks gasUsed/effectiveGasPrice`); return { receipt: null, sender: null }; }
      const actual = (used * price).toString(); const sender = String(t.value.from);
      if (!entry) { notes.push(`${label}: statement had no receipt at export; the chain gives ${actual} native units, which the statement's totals exclude`); return { receipt: null, sender }; }
      if (entry.nativeAtomic !== actual) problems.push(`${label}: statement ${entry.nativeAtomic} native units, receipts give ${actual}`);
      if (expectedSender && !sameAddr(sender, expectedSender)) problems.push(`${label}: sent by ${sender}, statement attributes it to ${expectedSender}`);
      return { receipt: { gasUsed: used.toString(), effectiveGasPrice: price.toString(), from: sender, transactionHash: hash }, sender };
    };
    if (!/^(0|[1-9][0-9]*)$/.test(String(cost.unresolvedReservation?.nativeAtomic))) problems.push(`unresolvedReservation.nativeAtomic ${JSON.stringify(cost.unresolvedReservation?.nativeAtomic)} is not a decimal native-unit string`);
    // a service-side reservation cannot be derived from the chain or the passport: it is never fed back into the recomputation, and a
    // non-zero value leaves the statement UNVERIFIED on that point (review round 3, item 6)
    const reservation = /^(0|[1-9][0-9]*)$/.test(String(cost.unresolvedReservation?.nativeAtomic)) ? String(cost.unresolvedReservation.nativeAtomic) : "0";
    let reservationUnverified = false;
    if (reservation !== "0") { reservationUnverified = true; notes.push(`unresolvedReservation.nativeAtomic ${reservation} is a service-side reservation that no chain or passport record can establish; it is not counted as verified`); }
    if (cost.costStatementVersion !== "1.0" && cost.costStatementVersion !== "1.1") problems.push(`unsupported costStatementVersion ${JSON.stringify(cost.costStatementVersion)}`);
    const fee = await fetchFor("fee relay", feeSrc, cost.operator?.feeRelay, cost.operator?.feeRelay?.address);
    const biz = await fetchFor("business payment", bizSrc, cost.buyer?.businessGas, cost.buyer?.address);
    const create = await fetchFor("order creation", createSrc, cost.operator?.orderCreation, cost.operator?.orderCreation?.address);
    // review of bf0c800 (P2): what this passport MUST account for — a run created its order, a paid payment has a hash, a settled fee its
    // settlement. A required source that the passport does not record at all is missing evidence: the recomputed total is incomplete (a
    // statement that still claims completeness differs from the recomputation and fails), and the finding is never a PASS.
    const settledFee = payment?.settlement?.state === "COMPLETED" || !!feeSrc;
    const expected = { createOrderTx: manifest.subject?.kind !== "paid-check", feeTx: settledFee, businessTx: execution.businessStatus === "SUCCESS" };
    const requiredMissing: string[] = [];
    if (expected.createOrderTx && !createSrc) requiredMissing.push("order creation: no creation transaction is recorded (a run always created its order) — the operator total is a known subtotal, not the cost");
    if (expected.businessTx && !bizSrc) requiredMissing.push("business payment: recorded as SUCCESS without a transaction hash — the buyer total is a known subtotal");
    if (expected.feeTx && !feeSrc) requiredMissing.push("fee relay: the check fee is recorded as settled without a settlement transaction — the operator total is a known subtotal");
    // audit 2026-10-10 (VF-03): the order creation's gas is attributed only to THIS order's creation — a transaction to the merchant whose
    // calldata is createOrder(orderId, payer, amount) for the intent's order, that succeeded and emitted OrderCreated; never the fee relay or the payment
    if (createSrc) {
      if ((feeSrc && same(createSrc, feeSrc)) || (bizSrc && same(createSrc, bizSrc))) problems.push("order creation names the same transaction as the fee relay or the business payment");
      const [ct, cr] = await Promise.all([tx(createSrc), rc(createSrc)]);
      if (ct.ok && cr.ok && ct.value && cr.value) {
        const t = ct.value, r = cr.value, be = intent.businessExpectation; const prov: string[] = [];
        if (!sameAddr(t.to, intent.to)) prov.push(`targets ${t.to}, not the merchant ${intent.to}`);
        let decoded: { args?: readonly unknown[] } | null = null;
        try { decoded = decodeFunctionData({ abi: CREATE_ORDER_ABI, data: String(t.input ?? t.data ?? "0x") as ViemHex }) as any; } catch { prov.push("calldata is not createOrder(orderId, payer, amount)"); }
        if (decoded?.args) { const [oid, payer, amount] = decoded.args as [string, string, bigint]; if (!same(oid, be?.orderId)) prov.push("creates another order id"); if (!sameAddr(payer, intent.from)) prov.push("creates an order for another payer"); if (String(amount) !== String(be?.amountNativeAtomic)) prov.push("creates an order for another amount"); }
        if (!succeeded(r)) prov.push("the creation transaction did not succeed");
        const created = ((r.logs as any[]) ?? []).some((l) => sameAddr(l.address, intent.to) && same(l.topics?.[0], ORDER_CREATED_TOPIC) && same(l.topics?.[1], be?.orderId) && same(l.topics?.[2], addressTopic(intent.from as ViemHex)) && l.data && l.data !== "0x" && big(l.data) === big(be?.amountNativeAtomic));
        if (!created) prov.push("no OrderCreated(orderId, payer, amount) log from the merchant");
        if (prov.length) problems.push(`order creation ${createSrc} is not this order's creation: ${prov.join("; ")}`);
      }
    }
    if (!missing) {
      try {
        const toAddr = (a: string | null): Hex | null => (a && HEX40.test(a) ? (getAddress(a) as Hex) : null);
        const settled = settledFee;
        const recomputedFull = costStatement({
          buyer: getAddress(intent.from) as Hex, buyerRole: buyerRoleOf(manifest.subject?.kind),
          relayer: toAddr(fee.sender) ?? (payment?.settlement?.relayer ?? null),
          orderCreator: toAddr(create.sender),
          businessPrincipalNativeAtomic: intent.businessExpectation?.action === "MERCHANT_PAY" ? String(intent.businessExpectation.amountNativeAtomic) : "0",
          businessPaid: execution.businessStatus === "SUCCESS",
          checkFeeTokenAtomic: settled ? (payment?.quote?.amountTokenAtomic ?? payment?.authorization?.value ?? null) : null,
          plan: plan ? { gasLimit: String(plan.gasLimit), maxFeePerGasNativeAtomic: String(plan.maxFeePerGasNativeAtomic) } : null,
          policy: { maxNativePaymentAtomic: String(policy.maxNativePaymentAtomic), maxServiceFeeTokenAtomic: String(policy.maxServiceFeeTokenAtomic) },
          receipts: { feeTx: fee.receipt, businessTx: biz.receipt, createOrderTx: create.receipt },
          txs: { feeTx: feeSrc, businessTx: bizSrc, createOrderTx: createSrc },
          unresolvedReservationNativeAtomic: "0", // never the statement's own value
          capturedAt: typeof cost.capturedAt === "string" ? cost.capturedAt : undefined,
          expected,
        });
        // a 1.0 statement predates the completeness flags and the buyer role: compare it against the 1.0 projection of the recomputation
        const recomputed: any = cost.costStatementVersion === "1.0"
          ? (() => { const { role: _r, complete: _c, ...buyer } = recomputedFull.buyer as any; const { complete: _oc, ...operator } = recomputedFull.operator as any; return { ...recomputedFull, costStatementVersion: "1.0", buyer, operator, notes: recomputedFull.notes.filter((n) => !/total is incomplete/.test(n)) }; })()
          : recomputedFull;
        const normalise = (c: any) => { const { unresolvedReservation: _u, ...rest } = c ?? {}; return { ...rest, notes: Array.isArray(c?.notes) ? [...c.notes].map(String).sort() : c?.notes }; };
        const diffs = fieldDiffs(JSON.parse(JSON.stringify(normalise(recomputed))), normalise(cost));
        if (diffs.length) problems.push(`statement differs from the recomputation in ${diffs.length} field${diffs.length === 1 ? "" : "s"}: ${list(diffs, 4)}`);
        if (!problems.length) notes.unshift(`recomputed from intent, execution, payment, plan, policy and the three receipts: buyer total ${recomputed.buyer.totalUsdc} USDC (principal ${recomputed.buyer.businessPrincipal.usdc}, check fee ${recomputed.buyer.checkFee?.usdc ?? "0"}, gas ${recomputed.buyer.businessGas?.usdc ?? "none"}), operator total ${recomputed.operator.totalUsdc} USDC, authorized maximum gas ${recomputed.authorizedMaximum.businessGasNativeAtomic ?? "none"} native units`);
      } catch (e) { missing++; notes.push(`statement could not be recomputed from the records: ${errText(e)}`); }
    }
    set("COST_STATEMENT", problems.length ? "FAIL" : missing || reservationUnverified || requiredMissing.length ? "UNVERIFIED" : "PASS",
      problems.length ? list(problems) : missing ? list(notes) : requiredMissing.length ? [`required evidence missing: ${requiredMissing.join("; ")}`, ...notes].join("; ") : reservationUnverified ? [`every field except the unresolved reservation matches the recomputation`, ...notes].join("; ") : [`statement recomputed from the passport's own records and the receipts matches the statement field by field (buyer ${cost.buyer?.address})`, ...notes].join("; "));
  }
  return finish(manifest);
}
