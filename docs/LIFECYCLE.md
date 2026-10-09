# The complete lifecycle (v3.3) — contract for API, UI, passport and verifier

Decision of record (user, 2026-10-08): the product must demonstrate the **complete** lifecycle for every connected-wallet
visitor, not only for the project's own runner:

```text
create an order → review and approve the payment → run the preflight check → execute the payment
→ recover the original attempt if interrupted → export the Payment Passport → verify it independently
```

This expands two v3.2 restrictions: paid self-service is open through anonymous browser sessions (`POST /v1/session`), and a
visitor's **browser wallet may execute the business payment** under an explicitly different control model (§3). Design,
implementation, capability descriptions and acceptance tests must describe the same product; this document is the contract.

## 1. Two execution modes

| | `runner` (project runner, Live Demo) | `wallet` (visitor's EIP-1193 wallet, Developer / "your wallet") |
|---|---|---|
| who signs | the project's demo-runner key, in the API process | the visitor, in their wallet |
| before broadcast | signed bytes + full context persisted, durable broadcast marker (D07) | the validated plan + full context persisted as an **attempt** (`VALIDATED`) before the wallet is asked to sign |
| what the service sees | the raw transaction | only the transaction hash the wallet returns (`…/sent`) |
| field agreement | every serialized field compared with the plan **before** sending | `to`, `data`, `value`, `chainId`, type compared with the plan **after** the transaction is visible; wallet-set gas, fees and nonce are recorded as deviations, never silently accepted as "the plan" |
| recovery | rebroadcast identical bytes inside the window; nonce-consumer search; order state | no bytes to rebroadcast: reconciliation from the reported hash, the order state and the merchant's `OrderPaid` log; an attempt whose hash was never reported is recovered through `OrderPaid` for its order |
| passport | `subject.kind = "demo-run"`, `executionMode: "runner"` | `subject.kind = "wallet-run"`, `executionMode: "wallet"` |

Both modes share: independent order, referenced approval, pinned report, deterministic decision, final validation at a fresh
block after the fee confirmation and the order creation, post-condition read-back, cost statement, passport, verifier.

## 2. Orders (every visitor; session-owned)

`POST /v1/demo/orders` (bearer: session or principal) body:

```json
{ "payer": "0x…", "proxy": "MAIN" | "CHANGED", "amountNativeAtomic": "50000000000000000", "reference": "invoice 2026-10-08 #42" }
```
`amountNativeAtomic`: 18-decimal native USDC, default 0.05 USDC, `1e15 ≤ amount ≤ 1e18` (0.001–1 USDC), a multiple of `1e12`
(whole 6-decimal token units). `reference`: optional free text ≤ 64 chars, stored off-chain and shown in the order summary.
Response 201: `{ orderId, tx, block, merchant, proxy, payer, amountNativeAtomic, reference, baselineDigest, state }`.

**Identity before sending (review item "order identity"):** the server writes the planned order (`orderId`, payer, amount,
merchant, owner, `PLANNED`) before it sends `createOrder`, records the hash (`SENT`) right after the send, and `CONFIRMED`
with the block after the receipt. A process that stops in between leaves a row that start-up reconciliation resolves by
reading `getOrder(orderId)` on chain: `CONFIRMED` (it exists), or `UNKNOWN_CREATION` (not found after a bounded window) — never
hidden, never replaced by a fresh order inside the same admission. `GET /v1/demo/orders` lists the owner's orders with the
live `paid` state and linked checks/attempts; `GET /v1/demo/orders/{orderId}` returns one.

The web dialog (Developer page): fields payer (connected wallet, read-only), proxy (MAIN / CHANGED with the approved
implementation shown), amount (USDC, 6 decimals), reference; **Autofill sample order** fills valid values; every autofilled
field stays editable; validation inline; a **review step** shows the exact order before "Create order"; afterwards the card
shows orderId, creation tx (explorer link), payment state (unpaid/paid), costs so far and the next action.

## 3. Wallet execution (attempts)

| Route | Who | Does |
|---|---|---|
| `POST /v1/wallet/attempts` `{ requestId, orderId }` | session that owns both | server-side final validation for the wallet payer at a fresh pinned block ≥ fee confirmation and order creation: implementation vs the referenced approval (re-read, incl. revocation), `paused`, exact-call simulation from the wallet, balance ≥ value + gas reserve, fee params, gas estimate, pending nonce, `eth_getCode(payer)` empty (no code → non-delegated EOA), report freshness. Persists the attempt `VALIDATED` with plan, receipts, digests, `validUntil = now + 60 s` (wallet prompts are human-paced; the window is recorded). 201 `{ attemptId, decision, finalValidation, plan, validUntil }`; 409 `VALIDATION_FAILED { reasons }` (recorded as `REFUSED`) |
| `POST /v1/wallet/attempts/{id}/sent` `{ txHash }` | owner | `BROADCAST_ATTEMPTED` + head block; the server fetches the transaction when visible, records `nonce`/`from` and compares `to/data/value/chainId/type` with the plan; a mismatch is recorded as `MISMATCH` (the order state still decides whether the order was paid) |
| `POST /v1/wallet/attempts/{id}/abandon` | owner | `NOT_SENT` (the wallet prompt was rejected); only from `VALIDATED` |
| `GET /v1/wallet/attempts/{id}` | owner | observe-only: state, execution outcome, `recovery`, `costStatement`, `businessExecution` facts |
| `POST /v1/wallet/attempts/{id}/recover` | owner | bounded reconciliation of THAT attempt now (same reads as the worker) |
| `GET /v1/wallet/attempts` | owner | history |
| `GET /v1/wallet/attempts/{id}/passport` | owner | passport bundle (`wallet-run`, disclosure `private`) |

**Reconciliation (worker, start-up, recover command):** `BROADCAST_ATTEMPTED` → receipt ⇒ `CONFIRMED`/`REVERTED` with the
order read at that block; no receipt ⇒ read the order; paid ⇒ find the paying transaction through the merchant's
`OrderPaid(orderId)` log (bounded `eth_getLogs` from the attempt's block) ⇒ `CONFIRMED` with that hash (note: recovered from the
event); unpaid ⇒ if the nonce is known and consumed ⇒ `NOT_MINED`; otherwise `UNRESOLVED` until `validUntil + 24 h`, then
`NOT_EXECUTED` ("no transaction established by this service; the order reads unpaid"). `VALIDATED` with no hash reported past
`validUntil` ⇒ the same order/`OrderPaid` search ⇒ `CONFIRMED` or, after 24 h, `NOT_SENT`. Nothing is ever re-signed,
re-sent or re-ordered by recovery; a visitor who refreshes mid-way finds the attempt in "My workflow" and can recover it.

## 4. Live Demo: the project runner, with a labelled interruption

`POST /v1/demo/run` gains `interruptAfterBroadcast?: boolean`: the runner persists, marks and sends as always, then **stops
waiting** and records an `interruptedAfterBroadcast` step — the run goes `RECONCILE_REQUIRED` with its hash recorded and the
recovery worker (or the recovery command) resolves it from the original context. The UI labels it "simulated interruption
after broadcast". The run JSON carries `businessExecution` (`state`, `txHash`, `nonce`, `broadcastBlock`, `consumedBy`,
`note`) from the store, and the headline derives from that state, not from step logs: a run whose last step is `signed`
but whose store says `BROADCAST_ATTEMPTED` reads "a broadcast was attempted; outcome not yet established".

The runner also records `orderPlanned` (before the order is sent) and `broadcastAttempted` (before the send) steps, and
persists every artefact as soon as it exists (`onArtifact`: intent, policy, quote, fee authorization without signature,
report + evidence, decision, final validation + evidence, plan, execution), so a run that stops after the broadcast still
exports a complete passport.

## 5. Cost disclosure

Both run cards show one table: rows business principal · check fee · business gas · fee-relay gas · order-creation gas;
columns **authorized maximum** (policy / plan), **actual** (receipts), **unresolved** (reservations not yet released); buyer
and operator grouped and totalled, straight from `cost-statement.json` (same function as the passport).

## 6. Passport and verifier changes

- `manifest.subject.executionMode: "runner" | "wallet"` and `subject.kind: "demo-run" | "wallet-run" | "paid-check"`.
- `FEE_ATTRIBUTION`: when the settlement transaction is a direct USDC call, its decoded calldata must equal the recorded
  authorization in **every** field (from, to, value, validAfter, validBefore, nonce) — a modified validity window fails;
  `evidence/chain/fee-tx.json.inputKeccak256` must equal the keccak of the fetched calldata.
- `COST_STATEMENT`: the whole statement is recomputed from the passport's own records and the receipts (principal, fee and its
  18-decimal equivalent, per-transaction gas, buyer and operator totals, exact `usdc` renderings, `authorizedMaximum` from
  policy and plan, `actual`, sources) and compared field by field; any difference fails.
- `ORDER_OUTCOME` / `TRANSACTION_PLAN_AGREEMENT`: an RPC error or absent historical state is `UNVERIFIED` with the reason;
  only facts that contradict the records are `FAIL`.
- `TRANSACTION_PLAN_AGREEMENT` in wallet mode: `chainId`, type, `from`, `to`, `data`, `value` must match; gas, fees and nonce
  differences are reported in the detail (recorded deviations) and do not fail the finding; in runner mode every field must match.
- Online verification runs in the visitor's browser too: the Arc RPCs answer cross-origin requests, so `/verify` can run
  `verifyPassport` with `rpcFromUrl` and anchors the visitor supplies (anchors prefilled from the site are labelled as the
  site's, not independent); the CLI remains the clean-process path.

## 7. Acceptance additions (AP33)

| ID | Assertion |
|---|---|
| AP33-01 | A modified authorization validity window in `payment.json` fails `FEE_ATTRIBUTION`; a modified calldata hash in the capture fails it |
| AP33-02 | A cost statement whose totals, fee equivalence or authorized maximum differ from the records fails `COST_STATEMENT` |
| AP33-03 | Historical state the RPC cannot serve yields `UNVERIFIED`, never `FAIL` |
| AP33-04 | A runner run interrupted right after the broadcast still exports a complete passport |
| AP33-05 | An order is persisted before its creation transaction is sent; an interrupted creation is reconciled from chain, never replaced |
| AP33-06 | The run headline follows the execution store (`BROADCAST_ATTEMPTED` is never shown as "nothing sent") |
| AP33-07 | A wallet attempt is persisted `VALIDATED` with its plan before the wallet is prompted; abandon and sent are recorded |
| AP33-08 | A wallet transaction that deviates from the plan in `to/data/value` is recorded `MISMATCH`; gas/nonce deviations are recorded, not hidden |
| AP33-09 | A wallet attempt whose hash was never reported is recovered through the merchant's `OrderPaid` event, or closed `NOT_SENT` after the window |
| AP33-10 | A wallet attempt's passport verifies (wallet-mode plan agreement) in a clean process |
| AP33-11 | Order dialog: validation, autofill, editable fields, review step; the created order shows id, tx, payment state, costs, next action |
| AP33-12 | The Live Demo shows a successful payment, a labelled interruption-and-recovery, and passport export followed by verification |

## 8. API as built (2026-10-08) — the reference the web client and the docs follow

**Run JSON (`GET /v1/demo/runs/{id}`)** adds `executionMode: "runner"`, `outcome: { kind, text, source }` (kinds `RUNNING | PAID |
BROADCAST_UNRESOLVED | SIGNED_NOT_BROADCAST | NOT_MINED | SUPERSEDED | REVERTED | CONFIRMED_UNPAID | REVIEW_REQUIRED | BLOCKED |
NOT_SIGNED | FAILED`; `source: "store"` when derived from the execution store, else `decision` / `state`), `businessExecution`
(`attemptId, state, txHash, nonce, broadcastBlock, businessStatus, businessTxHash, block, consumedBy, note, validUntil, updatedAt`
or null), `order` (the run's order row: `orderId, state, tx, block, payer, merchant, amountNativeAtomic, reference, paid`),
`partial: true` when the result was assembled from persisted artefacts (`artifactsPresent` lists them), `result.reconstructedFromArtifacts`.
Steps added by the runner: `orderPlanned`, `broadcastAttempted`, `interruptedAfterBroadcast` (the labelled interruption), and by
recovery: `reconciled`, `rebroadcast`. `GET /v1/demo/runs` rows add `executionMode`, `businessExecutionState`, `outcome` (kind).
`POST /v1/demo/run` accepts `interruptAfterBroadcast: boolean` (effective for `APPROVED_PAYMENT` only).

**Orders.** `POST /v1/demo/orders` body `{ payer, proxy?, amountNativeAtomic?, reference? }` → 201
`{ orderId, tx, block, merchant, proxy, payer, amountNativeAtomic, reference, baselineDigest, state: "CONFIRMED", owner }`; 400
`INVALID_INPUT` carries `field` (`payer | proxy | amountNativeAtomic | reference`) and `reason`; limits are published in
`GET /v1/network` → `orders { minNativeAtomic, maxNativeAtomic, stepNativeAtomic, defaultNativeAtomic, maxReferenceLength }`.
`GET /v1/demo/orders` → `{ orders: [OrderView] }`; `GET /v1/demo/orders/{orderId}` → `OrderView` (404 for another owner).
`OrderView = { orderId, owner, source: "developer" | "runner", runId, payer, merchant, proxy, amountNativeAtomic, reference, state:
PLANNED | SENT | CONFIRMED | UNKNOWN_CREATION | FAILED, tx, block, creation { from, gasUsed, effectiveGasPriceNativeAtomic },
paid: boolean | null, paidCheckedAt, note, checks: [{ requestId, state, createdAt, reportDigest, paymentState, serviceFeeTx,
valueNativeAtomic }], attempts: [{ attemptId, state, txHash, businessStatus, createdAt, updatedAt }], nextAction, createdAt, updatedAt }`.

**Wallet attempts.** `POST /v1/wallet/attempts` body `{ requestId, orderId, policy }` — `policy` is the buyer's `PolicyCore` whose
digest equals `intent.policyDigest` (`maxFinalValidationAgeSeconds ≤ 120`). 201 → `AttemptView` (state `VALIDATED`); 409
`VALIDATION_FAILED { reason, reasons[], attemptId }` (recorded `REFUSED`, stage `decision` or `finalValidation`); other 409s:
`ORDER_NOT_CONFIRMED`, `ORDER_MISMATCH`, `ORDER_ALREADY_PAID`, `CHECK_NOT_DELIVERED`, `ATTEMPT_OPEN`; 404 for another owner's
request or order. `POST …/{id}/sent { txHash }`, `POST …/{id}/abandon`, `POST …/{id}/recover`, `GET …/{id}` (observe: reads only),
`GET /v1/wallet/attempts` → `{ attempts: [brief AttemptView] }`, `GET …/{id}/passport` (409 `PASSPORT_NOT_READY` while VALIDATED
inside its window). States: `VALIDATED | REFUSED | BROADCAST_ATTEMPTED | NOT_SENT | CONFIRMED | REVERTED | MISMATCH | NOT_MINED |
NOT_EXECUTED`.
`AttemptView = { attemptId, executionMode: "wallet", state, requestId, orderId, merchant, payer, amountNativeAtomic, labels,
decision, decisionReasons, refusal { stage, reasons, decision? } | null, validUntil, txHash, nonce, from, broadcastBlock,
businessStatus, businessTxHash, block, note, deviations { mismatch: string[], deviations: { [field]: { plan, actual } } } | null,
nextAction, passportAvailable, businessExecution { state, txHash, nonce, broadcastBlock, consumedBy, note, validUntil },
createdAt, updatedAt,  // full view adds:
decisionReceipt, decisionDigest, finalValidation, finalValidationDigest, plan (TransactionPlan), planDigest,
approvalStatusAtValidation, execution (ExecutionReceipt; signedTransactionHash is always null in wallet mode), executionDigest,
postcondition, receipt, reconciliation[], steps[], recovery (RecoverySummary), costStatement (CostStatement), order }`.
The wallet signs **exactly** `plan` (`to, data, value, type 2, chainId`; gas/fees from the plan are recommended; a wallet-set
nonce or gas is recorded as a deviation, never a mismatch). The browser reports the hash (`/sent`) right after
`eth_sendTransaction` returns, remembers the attempt id per network before prompting, and calls `/abandon` on rejection (4001).

**Report lifetime (human-paced, 2026-10-08).** `REPORT_TTL_SECONDS` defaults to 300: a visitor reads the decision and answers
a wallet prompt at human speed, so a delivered report stays usable for five minutes after its pinned observation (the
Developer policy's `maxReportAgeSeconds` is 300 to match; the runner's own policy keeps 60 s because it executes within
seconds). The attempt's validation window after "execute" stays 60 s, and the final validation re-reads the implementation,
pause state, simulation, balance and the payer's code at a fresh block before anything is sent. `GET /v1/network` publishes
`quoteTtlSeconds` and `reportTtlSeconds`.

**Nonce-consumed rule (both reconcilers, fixed 2026-10-08).** A consumed signer nonce without a receipt for the reported hash
is concluded only through the identified consuming transaction (bounded binary search over `eth_getTransactionCount` + the
block's transactions): our own hash → `CONFIRMED`/`REVERTED` from its receipt once visible, else wait; another hash that pays
the order → `SUPERSEDED` (runner) / `CONFIRMED` with that hash (wallet); another hash that does not pay → `NOT_MINED`;
unidentified → pending with a note. The public Arc RPC is load-balanced, so one call may reach a fresher node than the next.

**Execution gate.** `GET /v1/network` → `access: { selfService, session, publicExecution, walletExecution, note }`.
`publicExecution` is `cfg.publicExecution` (`PUBLIC_EXECUTION`; default on for testnet, off for mainnet until the operator
records the mainnet acceptance); `walletExecution` is `publicExecution && fixtures deployed && order-creator key present`.
While gated, `POST /v1/demo/run` and `POST /v1/wallet/attempts` answer `503 EXECUTION_GATED { reason }` unless the request
carries the operator's `x-admin-token` (the acceptance scripts). Checks, orders, recovery, history and passports are never
gated. The web client reads these two flags and says "gated on this instance" instead of failing.

**Rehearsed on Arc testnet (2026-10-08, `evidence/selftest/testnet-lifecycle-2026-10-08T10-50-41-609Z.json`):** wallet scenario
CONFIRMED/SUCCESS with zero deviations, passport verified in a clean process (10 PASS, 0 FAIL, 0 UNVERIFIED); Live Demo with the
labelled interruption reconciled from the original hash (`recovered-confirmed`, nothing added by recovery), passport verified the
same way. Script: `scripts/selftest/lifecycle.ts` (`ARC_NET`, `API_URL`, `WALLET_KEY_FILE`, `SCENARIOS=wallet,interrupt`).

## 9. Review round 2 (2026-10-08) — contract for the fixes

Decision of record (user): passing tests does not make the product ready for public self-service wallet trials; ten
items must be fixed together. The API/verifier side of each item and what the web client must do.

**Cost statement 1.1** (`packages/passport`): `buyer.complete` / `operator.complete` (false when a receipt that should exist
is missing — business gas with a business tx, fee relay with a fee tx, order creation with a creation tx), `buyer.role`
∈ `project-runner | visitor-wallet | buyer` (demo-run → project-runner, wallet-run → visitor-wallet, paid-check → buyer),
notes name the missing component. Totals stay the known subtotal; **the client must never render a bare total when
`complete` is false** — show "incomplete: <component> not available" — and must label the buyer by `role` (a project-funded
run never reads "your wallet"). The verifier recomputes 1.1 and still accepts 1.0 statements (fields added in 1.1 ignored).
The run JSON's `result.costStatement` now carries receipt facts after reconciliation (gas is no longer missing on the page).

**Verifier**: `APPROVAL_COVERAGE` fails when the referenced approval was recorded revoked, or expired (`baseline.validUntil`
before `finalValidation.validatedAt`) and a transaction was still executed (runner or wallet mode — the wallet mode has no
`signedTransactionHash`, so execution is detected by `businessTxHash`/`chainStatus`); it is `UNVERIFIED` when `baseline.json`
is omitted or the revocation state at validation was not retained and something was executed. `FILE_INTEGRITY` requires
`verification-profile.json` with a known version and only allow-listed digest profiles. `COST_STATEMENT` fails on a reservation
value that is not a decimal string. **Client semantics**: a verification run is "completed"; it is "passed" only when
`counts.fail === 0 && counts.unverified === 0`; any FAIL is a red stop state, any UNVERIFIED is an amber partial state; the
lifecycle rail's "verify" stage must not show a green check otherwise.

**Wallet attempts**: one open attempt per order is enforced by a partial unique index (concurrent POSTs → the second gets
409 `ATTEMPT_OPEN`). Recovery through `OrderPaid` requires the paying transaction's **receipt** and compares its fields with
the plan (`MISMATCH` when `to/data/value/chainId/type` deviate); without a receipt the attempt stays open. `POST …/recover`
on a `VALIDATED` attempt inside its window now performs the order/`OrderPaid` search at once ("reconcile first"): the
client calls it when the wallet returned an error that is not a user rejection (timeouts, "already known", network errors)
and must **not** offer another signing attempt or say "nothing was sent" until the attempt is closed or the visitor
explicitly abandons it. Before `eth_sendTransaction` the client re-checks `eth_accounts[0] === plan.from === attempt.payer`,
`eth_chainId === plan.chainId`, and `validUntil - now > 5 s`; a mismatch aborts without prompting and explains why. The
workflow identity is per payer: a different connected account never inherits or relabels another account's order, check or
attempt (they stay listed under "other wallets in this browser").

**Freshness**: `finalValidation.expiresAt` is now `snapshot.observedAt + maxFinalValidationAgeSeconds` (bounded by intent,
report and approval expiry) — the window counts from the pinned observation, not from the end of the RPC reads; a validation
whose snapshot already aged out is refused ("final validation exceeded its own window").

**Artefacts before broadcast**: a failure to persist any artefact up to and including the signed execution record is fatal
before the broadcast marker (the run fails, nothing is sent); after the send, persistence failures are logged, never fatal.
A process that stops after the store recorded a closed outcome but before the run was finalised is closed from the store at
start-up (store and passport cannot disagree).

**Reference CLI**: the same order store (`PLANNED → SENT → CONFIRMED`, reconciled from `getOrder` at start) through the
shared `reconcilePlannedOrders` in `packages/runner`.

**Public builds**: the private-key test wallet is compiled out unless `VITE_TEST_WALLET=1`; production copy never mentions
`?testwallet=`.

**Demo page**: two explicit entry points — *Watch a project-funded demo* (the project runner, three situations, default
`APPROVED_PAYMENT` first, then the blocked payment, the unapproved upgrade, and "run with a simulated interruption") and
*Try with my wallet* (the Developer workflow). A connected wallet on the Demo page changes nothing about who pays.

**As built (web, 2026-10-08)**: step 3 checks `balance ≥ fee + amount + gas reserve` before a report is bought; step 4 checks
`balance ≥ amount + gas reserve` (the fee is already paid, said on the button). `validUntil` is bounded by the report's own
expiry: an attempt validated near the end of the report's usable window gets a correspondingly short prompt window. Wallet
attempts record the fee relay receipt once (`fee_receipt_json`) so their cost statement is complete on the operator side.

**Order dialog**: says it is a demonstration order with no goods delivered and what the visitor gets (report, payment
outcome, passport); proxy names, atomic units and raw JSON live under "technical details"; before buying a report the
client checks `balance ≥ fee + amount + gas reserve` (the faucet card uses the same number, not a fixed 0.05).

## 10. Review round 3 (`51cc0dd`, 2026-10-08) — contract for the fixes

**Submission uncertainty is durable (item 1).** `POST /v1/wallet/attempts/{id}/prompt { event: "prompted" | "unknown-submission", detail? }`
(owner; state `VALIDATED`) records `prompt: { state: "PROMPTED" | "UNKNOWN_SUBMISSION", at, detail }` on the attempt; `AttemptView.prompt`
carries it. The client calls `prompted` right before `eth_sendTransaction` (after remembering the attempt) and `unknown-submission`
when the wallet returned anything that is not a user rejection. With a prompt marker present, a `VALIDATED` attempt is **uncertain**:
`GET …/{id}` (observe) and `POST …/recover` read the order and the `OrderPaid` log even inside the window; the client never offers
"Continue in wallet" or "Abandon (nothing sent)" for it — only "Recover" and "I rejected it — abandon" (an explicit statement by the
visitor); `nextAction` says so. A page refresh therefore restores the uncertainty, not an idle attempt.

**Plan agreement is never skipped (item 2).** A receipt without the transaction body leaves a `BROADCAST_ATTEMPTED` attempt open
("receipt visible, transaction body not yet served; the plan comparison is outstanding"); it closes only once `to/data/value/chainId/type`
were compared.

**Approval evidence must be well-formed (item 3).** `statusAtFinalValidation` must be `{ revoked: boolean, validUntil: ISO|null,
fetchedAt: ISO }` with `fetchedAt` between the report's observation and the execution record (and `validUntil ≥ fetchedAt`); anything
else fails `APPROVAL_COVERAGE` for an executed run (`{}`, `revoked: null`, invalid timestamps included).

**Expiry is re-checked at the last moment (item 4).** Runner: after the head-block read, immediately before the broadcast marker and
the send. Browser: `Date.now()` is taken after the wallet queries (`eth_accounts`, `eth_chainId`), immediately before `eth_sendTransaction`.

**Unresolved reservation (item 6).** The verifier cannot derive service-side reservations: `COST_STATEMENT` compares every other
field and reports `UNVERIFIED` whenever `unresolvedReservation.nativeAtomic` is not `"0"` (the statement's own value is never fed
back into the recomputation).

**Late receipts (item 7).** `GET …/{id}` backfills a missing fee relay receipt on terminal attempts too, and the worker backfills
recently closed attempts (bounded), so the page and the exported passport carry the same cost evidence.

**CLI evidence (item 8).** The reference CLI persists every artefact as it is produced (`artifacts` table in its store, keyed by
the run) and exports a passport from them with `merchant-agent passport <attemptId> --out <dir>`; the runner emits an `approval`
artefact (the referenced baseline as read at decision time) so the export carries `baseline.json`.

**As built (2026-10-09).** The runner's `report` artefact now carries the settlement facts delivered with the report (`settlement:
{ backend, state, transactionHash, evidence }`) and an `approval` artefact records the referenced baseline as read at decision time,
so a passport built from artefacts alone (API after a crash, CLI always) has `payment.settlement` and `baseline.json`; the CLI
derives the relayer from the fee transaction's sender at export. Prompt markers: a later `prompted` never downgrades an
`UNKNOWN_SUBMISSION`; closed attempts take no prompt (409). The observe read backfills the fee relay receipt of closed attempts;
the worker backfills attempts closed in the last 24 h (10 per pass). Browser (as built): the `prompted` marker is written before `eth_sendTransaction` and also remembered in the browser per attempt and per API instance, so a refresh restores the uncertainty even while the server view lags; a marker that cannot be written prompts nothing (`PROMPT_MARKER_FAILED`); a `409 ATTEMPT_OPEN` whose open attempt carries a marker is reconciled (recover once, then observe) instead of being offered to the wallet; an ambiguous wallet answer writes `unknown-submission`, reconciles first (`/recover`), then observes every ~2 s with a recover every third tick for up to 60 s, and leaves the visitor's explicit abandon as the only "nothing was sent"; the validation window is re-read after every await (`eth_accounts`, `eth_chainId`, the marker call) immediately before the prompt.

**Follow-up (review of `0c0d406`, 2026-10-09).** *(P1-1)* The prompt marker is an **exclusive claim**: `POST …/prompt { event: "prompted",
claimId }` writes the marker only where none exists, in one statement, so exactly one caller is granted; every other caller — a second tab, a
stale view, a retry — receives `409 PROMPT_CLAIMED` with the current attempt in the body and reconciles instead of prompting.
`unknown-submission` records the holder's ambiguous answer on top of the claim (a claim id, when given, must be the holder's); `{ event:
"not-prompted", claimId }` hands an untouched claim back — the holder's re-check right before the prompt failed, so nothing was prompted and
the attempt is a plain `VALIDATED` attempt again; an `UNKNOWN_SUBMISSION` marker (`409 PROMPT_NOT_RELEASABLE`), somebody else's claim
(`409 PROMPT_CLAIMED`), a missing claim (`409 PROMPT_NOT_CLAIMED`) or a closed attempt (`409 ATTEMPT_NOT_OPEN`) is never released. The claim
id is generated per call, kept in that call's memory only and never appears in the attempt view, so a reloaded page can never hand back a
claim it did not make. *(P1-2)* After the claim call the browser reads the wallet's account and chain **again** and the clock after them,
immediately before `eth_sendTransaction`; a change hands the claim back and says why (`ACCOUNT_CHANGED`, `CHAIN_CHANGED`, `WINDOW_CLOSED`,
`WALLET_UNAVAILABLE`); a refused hand-back leaves the attempt uncertain and reconciles it. The request handed to the wallet carries the plan's
`chainId`, which wallets that honour it (MetaMask-style) refuse on another network; the injected test wallet does the same. *(P1-3)* The
runner reads the clock once more after the broadcast marker — the last await before the send — and closes a transaction it never sent as
`SIGNED_NOT_BROADCAST`; the recovery rebroadcast judges the window by a clock read after the receipt, order, nonce and pool reads and again
after the decryption, never by a time captured before them. *(P2)* The verifier requires the recorded approval status expiry to equal the
referenced baseline's (the producer copies it from that baseline) and to hold at final validation; a disagreement is contradictory evidence
and fails `APPROVAL_COVERAGE` for an executed run.
