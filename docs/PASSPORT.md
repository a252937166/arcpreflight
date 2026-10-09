# Payment Passport — format 1.0 and verification contract

A Payment Passport is a **portable, read-only evidence artifact** exported from one ArcPreflight workflow: what was
approved, what was actually sent, what settled, and what another process can verify. It is a directory (or a single JSON
bundle holding the same files) generated from records the application already holds. It is not a token, an NFT, a new
payment standard, an identity credential, a guarantee, or a bearer authorization. Importing a passport never enables
signing or broadcasting: the private **Recovery Store** (encrypted signed bytes, authorization signatures, keys) is a
different thing and is never exported.

This document is the contract between the exporter (`packages/passport`, used by the API and the CLI), the independent
verifier (`packages/verifier`, runs without application credentials) and the UI. Versioned separately from the frozen
core receipts: every core object keeps `schemaVersion: "1.0"` and its exact digest rules (spec v1.4 §7.1).

## 1. Layout

```text
payment-passport/
  manifest.json                 file list with sha256 digests, object digests + profiles, chain identity, coverage, disclosure
  order-summary.json            the human summary the primary screen shows (derived; never the source of truth)
  intent.json                   IntentCore (schema 1.0)
  baseline.json                 BaselineCore referenced by the intent, as stored by the approving server (may be omitted → listed in omissions)
  policy.json                   PolicyCore
  report.json                   ReportCore (the pinned, paid-for report)
  decision.json                 DecisionReceipt
  transaction-plan.json         TransactionPlan            — only if final validation produced one
  final-validation.json         FinalValidationReceipt     — only if reached
  execution.json                ExecutionReceipt (always; chainStatus/businessStatus tell how far the workflow went)
  payment.json                  check-fee facts: quote, authorization WITHOUT signature, settlement evidence
  cost-statement.json           buyer vs operator USDC costs (authorized maximum / actual / unresolved reservation)
  recovery.json                 recovery counters and reconciliation history of this attempt
  evidence/
    report/<digest>.json        RpcEvidence objects referenced by report.rawEvidenceDigests
    final-validation/<digest>.json  RpcEvidence for the critical-state, simulation and signer-account reads
    postcondition.json          the business post-condition record, byte-exact preimage of its legacy digest
    chain/fee-tx.json           { tx, receipt } captured at export time (labelled capture, not pinned evidence)
    chain/business-tx.json      same, for the business transaction (if any)
    chain/create-order-tx.json  same, for order creation
  verification-profile.json     what the verifier accepts and which checks need an RPC or anchors
  verify.md                     human instructions
```

**Bundle form.** The same files as one JSON document: `{ "passportBundleVersion": "1.0", "files": { "<path>": "<file content as UTF-8 string>" } }`.
`manifest.json` is one of the entries. Digests are computed over each file's UTF-8 bytes, so a bundle and a directory
of the same passport verify identically. The web app downloads the bundle; the CLI writes either.

**Path rules (enforced on import):** relative, `/` separators, no leading `/`, no `.` or `..` segments, no duplicates
(case-insensitive), characters `[A-Za-z0-9._/-]`, ≤ 200 characters, ≤ 200 files, ≤ 4 MiB total, symlinks refused, no
external fetches during offline checks. Violations are a `FILE_INTEGRITY` failure, never silently skipped.

## 2. manifest.json

```json
{
  "passportVersion": "1.0",
  "generator": { "name": "arcpreflight", "release": "<releaseSha>", "component": "api" },
  "createdAt": "2026-10-09T12:00:00.000Z",
  "disclosure": "public",
  "chain": { "chainId": 5042, "caip2": "eip155:5042", "usdc": "0x3600000000000000000000000000000000000000", "nativeDecimals": 18, "tokenDecimals": 6 },
  "subject": { "kind": "demo-run", "executionMode": "runner", "runId": "<uuid>", "attemptId": "<uuid>", "fixture": "APPROVED_PAYMENT", "orderId": "0x…", "merchant": "0x…", "payer": "0x…" },
  "template": { "id": "oz-erc1967proxy-uups@5.4.0", "merchant": "DemoMerchantV1", "method": "pay(bytes32)", "selector": "0x…" },
  "stageCoverage": { "order": true, "intent": true, "quote": true, "feeSettlement": true, "report": true, "decision": true, "finalValidation": true, "transactionPlan": true, "signed": true, "broadcast": true, "postcondition": true, "reconciliation": false },
  "digestProfiles": {
    "arcpreflight-jcs-keccak-1.0": "keccak256(UTF8(JCS({kind, schemaVersion, payload}))) — RFC 8785 canonical JSON; kinds: intent, report, policy, baseline, decision, transactionPlan, finalValidation, execution, quote, evidence",
    "legacy-json-stringify-keccak-1.0": "keccak256(UTF8(JSON.stringify(record))) over the record exactly as the runner serialised it; the file holds the byte-exact preimage",
    "sha256-file-1.0": "sha256 over the file's UTF-8 bytes"
  },
  "files": [
    { "path": "intent.json", "bytes": 812, "sha256": "0x…", "object": { "kind": "intent", "schemaVersion": "1.0", "digestProfile": "arcpreflight-jcs-keccak-1.0", "digest": "0x…" } },
    { "path": "evidence/postcondition.json", "bytes": 190, "sha256": "0x…", "object": { "kind": "postcondition", "schemaVersion": null, "digestProfile": "legacy-json-stringify-keccak-1.0", "digest": "0x…" } },
    { "path": "verify.md", "bytes": 1400, "sha256": "0x…", "object": null }
  ],
  "omissions": [ { "path": "baseline.json", "reason": "the approving server did not return the referenced baseline" } ],
  "notes": [ "evidence/chain/* were captured from the exporter's RPC at export time and are labelled captures, not pinned evidence" ]
}
```

`subject.kind` ∈ `demo-run | wallet-run | paid-check`; `subject.executionMode` ∈ `runner | wallet` (design v3.3: `wallet-run`
is a visitor's own wallet executing the validated plan; `demo-run` and `paid-check` are `runner`; an inconsistent pair is
refused by the exporter and fails `DIGEST_INTEGRITY` in the verifier). `order-summary.json` repeats `executionMode`.

Rules: the manifest lists every file except itself and never hashes itself. `object` is present for files that are a
digested object; its `digest` must equal the digest other records reference (for example `execution.json`'s
`finalValidationDigest` equals the `object.digest` of `final-validation.json`). A deliberate omission is listed under
`omissions` with a reason; nothing is ever removed from a digested object (that would change its digest).

## 3. Digest profiles (frozen, allow-listed)

| Profile | Used for | Rule |
|---|---|---|
| `arcpreflight-jcs-keccak-1.0` | all core objects and RPC evidence | exactly `digest(kind, "1.0", payload)` in `@arcpreflight/schema` (RFC 8785 JCS, then keccak256) |
| `legacy-json-stringify-keccak-1.0` | business post-condition records | `keccak256(UTF8(JSON.stringify(record)))`, the runner's existing `postconditionDigest`; the passport stores the preimage bytes |
| `sha256-file-1.0` | every passport file | sha256 over the file bytes, hex with `0x` |

The verifier accepts only these three names. An unknown profile name is a `DIGEST_INTEGRITY` failure; nothing executes
an algorithm named inside an imported file. Test vectors live in `packages/verifier/test/vectors/` and must reproduce
exact bytes for every profile (AP32-32). Old records are never re-hashed under new rules.

## 4. Derived files

### order-summary.json
```json
{ "orderSummaryVersion": "1.0", "orderId": "0x…", "merchant": "0x…", "payer": "0x…", "amountNativeAtomic": "50000000000000000", "amountUsdc": "0.05",
  "createOrder": { "tx": "0x…", "block": "123", "signer": "order-creator" },
  "referencedApproval": { "baselineDigest": "0x…", "approvedImplementation": "0x…", "observedImplementation": "0x…", "baselineResult": "MATCH", "statusAtFinalValidation": { "revoked": false, "validUntil": null, "fetchedAt": "…" } },
  "decision": "NO_POLICY_VIOLATION", "chainResult": "CONFIRMED", "orderResult": "paid", "serviceOutcome": "NOT_EVALUATED",
  "checkFee": { "tokenAtomic": "10000", "usdc": "0.01", "tx": "0x…" }, "businessTx": "0x…", "network": "eip155:5042", "release": "<sha>" }
```
`orderResult` is `paid | unpaid | unknown` from the post-condition / reconciliation, never from the receipt alone.
`serviceOutcome` is always `NOT_EVALUATED`: a paid order does not prove an offchain service was delivered.

### payment.json
```json
{ "paymentVersion": "1.0", "scheme": "x402/exact", "assetTransferMethod": "eip3009", "requestId": "<uuid>",
  "quote": { …QuoteCore… }, "quoteDigest": "0x…",
  "authorization": { "from": "0x…", "to": "0x…", "value": "10000", "validAfter": "0", "validBefore": "…", "nonce": "0x…" },
  "settlement": { "backend": "relay", "state": "COMPLETED", "relayer": "0x…", "transactionHash": "0x…", "blockNumber": "…", "authorizationUsedLogIndex": 17, "transferLogIndex": 19 } }
```
The authorization **signature is never exported** (it is a bearer instruction until its validity ends). The verifier
fetches the public calldata of `settlement.transactionHash` when it needs it.

### cost-statement.json

Version **1.1** (2026-10-08): `buyer.role` ∈ `project-runner | visitor-wallet | buyer` (who the buyer side is; a project-funded
demo run is never "your wallet"), `buyer.complete` and `operator.complete` — `false` when a receipt that should exist is
missing (business gas with a business tx, fee relay with a fee tx, order creation with a creation tx). The totals are then
the known subtotal and a note names the missing component; a reader must not present them as the cost. 1.0 statements (no
`role`, no `complete`) are still accepted by the verifier, which compares them against the 1.0 projection of its recomputation.
```json
{ "costStatementVersion": "1.0", "unit": "USDC", "nativeDecimals": 18, "tokenDecimals": 6, "capturedAt": "…",
  "buyer": { "address": "0x…",
    "businessPrincipal": { "nativeAtomic": "50000000000000000", "usdc": "0.05" },
    "checkFee": { "tokenAtomic": "10000", "nativeAtomicEquivalent": "10000000000000000", "usdc": "0.01" },
    "businessGas": { "nativeAtomic": "…", "usdc": "…", "gasUsed": "…", "effectiveGasPriceNativeAtomic": "…", "tx": "0x…" },
    "totalNativeAtomic": "…", "totalUsdc": "…" },
  "operator": {
    "feeRelay": { "address": "0x…", "nativeAtomic": "…", "usdc": "…", "gasUsed": "…", "effectiveGasPriceNativeAtomic": "…", "tx": "0x…" },
    "orderCreation": { "address": "0x…", "nativeAtomic": "…", "usdc": "…", "gasUsed": "…", "effectiveGasPriceNativeAtomic": "…", "tx": "0x…" },
    "totalNativeAtomic": "…", "totalUsdc": "…" },
  "authorizedMaximum": { "businessPrincipalNativeAtomic": "…", "checkFeeTokenAtomic": "…", "businessGasNativeAtomic": "gasLimit × maxFeePerGas from the plan, or null" },
  "actual": { "businessPrincipalNativeAtomic": "…", "checkFeeTokenAtomic": "…", "businessGasNativeAtomic": "…" },
  "unresolvedReservation": { "nativeAtomic": "0", "note": "reservations released only after reconciliation" },
  "sources": { "feeTx": "0x…", "createOrderTx": "0x…", "businessTx": "0x…" },
  "notes": [ "gas deductions are not payment Transfer events", "the fee's native-system and ERC-20 event representations are one payment", "sub-micro-USDC gas precision is preserved; usdc strings are exact decimal renderings of the atomic values" ] }
```
All arithmetic is BigInt over atomic strings; `usdc` strings are exact decimal renderings (trailing zeros trimmed). Any
receipt that is unavailable makes the corresponding entry `null` and adds a note; nothing is estimated as if measured.

### recovery.json
```json
{ "recoveryVersion": "1.0", "attemptId": "<uuid>", "interrupted": false,
  "counters": { "ordersCreated": 1, "checkFeeAuthorizations": 1, "businessSignatures": 1, "broadcastsOfOriginalBytes": 1, "replacementSignatures": 0 },
  "addedByRecovery": { "ordersCreated": 0, "checkFeeAuthorizations": 0, "businessSignatures": 0, "broadcastsOfOriginalBytes": 0 },
  "originalTransaction": { "hash": "0x…", "status": "confirmed" },
  "reconciliation": [ { "at": "…", "chainStatus": "CONFIRMED", "businessStatus": "SUCCESS", "note": "reconciled from the original transaction hash and the order state" } ] }
```
Counters come from the recorded steps: `createOrder`, `signServiceFee`, `signed`, `broadcast` (accepted) plus
`rebroadcast` steps, `replacementSignatures` = `signed` steps beyond the first (always 0 by construction).
`addedByRecovery` is what the primary screen shows as "new orders created / new check-fee authorizations / new business
signatures": everything beyond the first of each, plus the number of `rebroadcast` steps (identical bytes, same hash).
`originalTransaction.status` ∈ `none | not-sent | confirmed | recovered-confirmed | recovered-from-event | reverted | not-mined | unresolved`
(`recovered-from-event`: the paying transaction was identified through the merchant's `OrderPaid` event because no receipt
for a reported hash existed — wallet mode, or a hash never reported). Interruption steps that mark a run as `interrupted`:
`interrupted`, `interruptedBeforeBroadcast`, `interruptedAfterBroadcast` (the Live Demo's labelled interruption), `outcomeUnknown`,
`rebroadcast`, `reconciled`. In wallet mode `businessSignatures` is 0 by construction: the service never signs.

## 5. verification-profile.json
```json
{ "verificationProfileVersion": "1.0",
  "acceptedDigestProfiles": ["arcpreflight-jcs-keccak-1.0", "legacy-json-stringify-keccak-1.0", "sha256-file-1.0"],
  "anchors": { "format": { "baselineDigests": ["0x…"], "policyDigests": ["0x…"] }, "source": "retained by the verifier's operator through a trusted channel, never taken from the passport" },
  "offlineChecks": ["FILE_INTEGRITY", "DIGEST_INTEGRITY", "DISCLOSURE", "APPROVAL_COVERAGE"],
  "anchorChecks": ["APPROVAL_SOURCE"],
  "onlineChecks": ["NETWORK_IDENTITY", "FEE_ATTRIBUTION", "TRANSACTION_PLAN_AGREEMENT", "ORDER_OUTCOME", "COST_STATEMENT"],
  "neverEvaluated": ["CURRENT_ELIGIBILITY"],
  "rpc": { "chainId": 5042, "methods": ["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_getBlockByHash"] } }
```

## 6. What the verifier proves (findings)

Every finding is `{ id, status: "PASS" | "FAIL" | "UNVERIFIED" | "NOT_EVALUATED", detail, evidence? }`. There is no
single overall PASS: the result is the list plus counts. Missing trust or history yields `UNVERIFIED`, never an invented
success.

| Finding | Needs | Meaning |
|---|---|---|
| `FILE_INTEGRITY` | passport | manifest version known; every listed file present with matching sha256 and size; no unlisted files; path rules hold; `verification-profile.json` present, version 1.0, naming only allow-listed digest profiles and the manifest's chain |
| `DIGEST_INTEGRITY` | passport | every digested object re-hashes under its named (allow-listed) profile to the manifest digest; cross-links hold: `report.intentDigest`, decision/final-validation/execution links, `finalValidation.transactionPlanDigest`, `execution.postconditionEvidenceDigests` ⊇ post-condition digest, evidence digests referenced by report/final validation match the evidence files present |
| `DISCLOSURE` | passport | no 32-byte private-key-like fields, no 65-byte signatures, no blob whose keccak equals `execution.signedTransactionHash`, no `privateKey`/`relay_raw_tx`/`settle_payload` keys |
| `APPROVAL_SOURCE` | anchors | `baseline.json` digest ∈ `anchors.baselineDigests` and `policy.json` digest ∈ `anchors.policyDigests`; without anchors → `UNVERIFIED` |
| `APPROVAL_COVERAGE` | passport | which approval applied at execution: intent, decision, final validation and execution all reference the same `baselineDigest`; `report.baselineResult` and the decision agree; for an executed run (runner or wallet mode: a signed hash, a business hash or a chain status past signing) the approval must have been recorded **not revoked and not expired** at validation (`statusAtFinalValidation = { revoked: boolean, validUntil: ISO | null, fetchedAt: ISO }`, with `fetchedAt` between the report's observation and the execution record; `baseline.validUntil` must not precede `finalValidation.validatedAt`) — a revoked or expired approval with an executed transaction is `FAIL`, and so is a malformed status (`{}`, a non-boolean `revoked`, an invalid or out-of-range timestamp); an omitted `baseline.json` or an unretained status with an executed transaction is `UNVERIFIED` |
| `NETWORK_IDENTITY` | RPC | `eth_chainId` equals `manifest.chain.chainId`; on mismatch every other online check is skipped as `UNVERIFIED` |
| `FEE_ATTRIBUTION` | RPC | the settlement transaction exists, succeeded, targets the USDC contract, and its logs carry `AuthorizationUsed(payer, nonce)` + `Transfer(payer → payTo, amount)` from the USDC contract for exactly `payment.json`'s authorization; when the transaction is a direct USDC call its decoded calldata must equal the authorization in **every** field (from, to, value, validAfter, validBefore, nonce — a modified validity window fails; AP33-01), and `evidence/chain/fee-tx.json.inputKeccak256` must equal the keccak of the fetched calldata; a non-direct call passes on the logs with the note that the validity window is not verifiable from calldata; the `from` of that transaction is reported (relayer attribution) |
| `TRANSACTION_PLAN_AGREEMENT` | RPC | the business transaction fetched by hash matches `transaction-plan.json`: in `runner` mode field by field (chainId, type 2, from, to, input, value, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, empty access list); in `wallet` mode chainId, type, from, to, input, value and the empty authorization list must match while nonce, gas, fee and access-list differences are reported in the detail and `evidence.deviations` without failing (the wallet owns those fields) |
| `ORDER_OUTCOME` | RPC | receipt status, `OrderPaid(orderId, payer, amount)` from the merchant, and `getOrder(orderId)` read at the receipt's block hash: paid by that payer for that amount; the post-condition record is reproduced byte-exact from these facts; an RPC error or a block the node cannot serve is `UNVERIFIED` with the reason, `FAIL` only when a fact contradicts the records (AP33-03) |
| `COST_STATEMENT` | RPC | `costStatementVersion` must be 1.0 or 1.1 and `unresolvedReservation.nativeAtomic` a decimal string; the reservation is a service-side figure no chain or passport record can establish, so it is never fed into the recomputation and a non-zero value leaves the finding `UNVERIFIED`; everything else in the statement is recomputed from the passport's own records and the fetched receipts (principal, fee and its 18-decimal equivalent, per-transaction gas, buyer and operator totals, exact `usdc` renderings, `authorizedMaximum` from policy and plan, `actual`, sources) and compared field by field; any difference fails (AP33-02); missing or unfetchable receipts stay `UNVERIFIED`; attribution: fee tx sender = relayer, business tx sender = buyer, create-order tx sender = order creator |
| `CURRENT_ELIGIBILITY` | — | always `NOT_EVALUATED`: whether a new payment may execute now is a present-time question never inferred from historical success |

A complete rewritten passport with newly computed hashes is not proof of original approval (that is what anchors are for).
A transaction hash is not proof of service delivery. A current contract balance is not proof that this order was paid.

## 7. Exporter inputs (`packages/passport`)

```ts
type PassportSource = {
  generator: { release: string; component: "api" | "cli" };
  disclosure: "public" | "private";
  chain: { chainId: 5042 | 5042002; caip2: string; usdc: `0x${string}` };
  subject: { kind: "demo-run" | "paid-check"; runId: string | null; attemptId: string | null; fixture?: string | null };
  template: { id: string; merchant: string | null; method: string; selector: `0x${string}` };
  result: RunResultLike | null;                 // the runner's output (see below); null for a paid-check passport
  baseline: BaselineCore | null;                // referenced approval as stored; null → omission
  reportEvidence: { evidence: RpcEvidence; digest: `0x${string}` }[];
  settlement: { backend: "relay" | "circle"; state: string; transactionHash: `0x${string}` | null; relayer: `0x${string}` | null; evidence: SettlementEvidence | null } | null;
  payment: { requestId: string; quote: QuoteCore | null; authorization: Eip3009AuthorizationWithoutSignature | null } | null;
  chainCaptures?: { feeTx?: Capture; businessTx?: Capture; createOrderTx?: Capture };  // { tx, receipt } as returned by the RPC, bigints as decimal strings
  reconciliation?: { at: string; chainStatus: string; businessStatus: string; note: string | null }[];
  createdAt?: string;
};
```
`RunResultLike` is the object `runFixture` returns: `fixture, network, chainId, attemptId, orderId, merchant, intent,
intentDigest, policy, policyDigest, requestId, serviceFeeTx, report, reportDigest, simulation, decision, decisionDigest,
finalValidation, plan, execution, executionDigest, postcondition, steps, durationMs` plus (added for passports)
`quote, quoteDigest, feeAuthorization` (no signature), `finalValidationEvidence: {evidence, digest}[]`,
`approvalStatusAtValidation: { revoked, validUntil, fetchedAt } | null`.

Exports: `buildPassport(source): { files: Record<string,string>; manifest }`, `toBundle(files)`, `fromBundle(json)`,
`writePassportDirectory(dir, files)`, `readPassportDirectory(dir)`, `costStatement(...)`, `recoverySummary(...)`,
`validatePaths(paths)`.

### 7.1 Implementation notes (as built, 2026-10-08)

- `PassportSource.check?: { intent: IntentCore; report: ReportCore } | null` supplies the intent and report of a **paid-check** passport, which has no runner `result`.
- `evidence/chain/fee-tx.json` carries the fee transaction with `tx.input` replaced by `inputKeccak256` + `inputBytes`: the calldata embeds the buyer's authorization signature (v3.2 §13.1). Business and create-order captures keep their input.
- `recoverySummary(attemptId, steps, execution, reconciliation?)` — the attempt id is the first argument.
- `sha256-file-1.0` is computed with viem's pure-JS `sha256`, so `buildPassport` and `verifyPassport` are browser-safe; only the `@arcpreflight/passport/node` and `@arcpreflight/verifier/node` subpaths and the CLI touch the file system (both packages therefore carry an `exports` map with `.` and `./node`).
- The verifier re-implements the path/bundle rules (`load.ts`) and does not import the exporter at runtime; `@arcpreflight/passport` is only a devDependency of its tests.
- `DIGEST_INTEGRITY` also cross-checks derived files against the core objects (order-summary ↔ intent/decision/execution; payment quote/authorization ↔ intent; manifest subject/chain ↔ intent) and fails if `payment.authorization` carries a `signature` key.
- CLI invocations that resolve from the repository root: `pnpm exec tsx packages/verifier/src/cli.ts <passport> …`, `pnpm -C packages/verifier verify <passport> …`, or `node packages/verifier/bin/arcpreflight-verify.mjs <passport> …` (pnpm links bins only into dependents, so `pnpm exec arcpreflight-verify` does not resolve at the root).

## 8. Verifier (`packages/verifier`)

`verifyPassport(files, { rpc?: VerifierRpc; anchors?: Anchors }) → { passportVersion, subject, findings[], counts }`.
`VerifierRpc` is a small interface (`getChainId, getTransaction, getTransactionReceipt, getBlock, call/readContract`)
implemented over an explicitly configured Arc RPC URL; tests inject a fake. CLI: `arcpreflight-verify <dir|bundle.json>
[--rpc <url>] [--anchors <file>] [--json]`; exit code 0 when no finding is `FAIL`, 2 when any is, 1 on usage error.
Without `--rpc`, online checks are `UNVERIFIED`; without `--anchors`, `APPROVAL_SOURCE` is `UNVERIFIED`.

## 9. Where passports come from

| Source | Route / command | Disclosure |
|---|---|---|
| Demo run (project-funded, public; `demo-run` / `runner`) | `GET /v1/demo/runs/{runId}/passport` → bundle JSON (download); also for a run that stopped after the broadcast (assembled from persisted artefacts, AP33-04) | public |
| Wallet attempt (the visitor's wallet executed the plan; `wallet-run` / `wallet`) | `GET /v1/wallet/attempts/{attemptId}/passport` (owner session only; 409 while the attempt waits for the wallet inside its window) | private |
| Paid check (session or configured principal; `paid-check` / `runner`) | `GET /v1/requests/{requestId}/passport` (owner only) | private; report, quote, payment facts, evidence; no decision/execution (the buyer decides locally) |
| CLI runner | `merchant-agent passport <attemptId|runKey> --out <dir> [--disclosure public|private]` — built from the artefacts and steps the CLI persisted while it ran plus its store's outcome (a crash after the broadcast loses nothing a passport needs) | `--disclosure`, default private |

Exporting is read-only. It never triggers reconciliation, settlement or any funds-moving action.
