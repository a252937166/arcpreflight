# ArcPreflight — design addendum v3.3

**The complete lifecycle for every connected wallet.** Supersedes two restrictions of *ArcPreflight — Payment Passports for
Recoverable USDC Orders* v3.2 (§6 "P0 closed": *self-service real-money onboarding* and *browser-wallet business
broadcasting*) and the parts of §5–§7, §13 and §18 that depend on them. Everything else in v3.2 stays the design of record;
spec v1.4 stays the engineering contract. Decision of record: the user, 2026-10-08 ("This expands the original v3.2
restrictions on self-service access and browser business execution. Update the design, implementation, capability
descriptions, and acceptance tests together so they accurately describe the same product.").

The implementation contract (routes, states, fields) is `docs/LIFECYCLE.md`; this document records the product decision,
its control model and its acceptance map.

## 1. What changed and why

The v3.2 product stopped a visitor at the checking stage: the project runner alone executed payments, a visitor's wallet
could buy a check but never pay, and self-service needed a configured principal. A review of the deployed preview found
that this hid the product's thesis from the people meant to evaluate it, and found defects behind it: a verifier that could
report PASS on a modified fee authorization or a wrong cost total, FAIL on history a node could not serve, order identity
recorded too late to reconcile an interrupted creation, run headlines derived from step logs rather than the execution
store, and a cost disclosure that did not separate authorized limits from actuals and unresolved reservations.

v3.3 makes the whole lifecycle usable from any browser:

```text
create an order → review and approve → run the preflight check → execute the payment (your wallet or the project runner)
→ recover the original attempt if interrupted → export the Payment Passport → verify it independently
```

and fixes the defects first, so the flow is presented as complete only after it is.

## 2. Two execution modes, one control model

| | `runner` (project runner, Live Demo) | `wallet` (the visitor's EIP-1193 wallet, Developer workflow) |
|---|---|---|
| who signs | the project's demo-runner key, inside the API process | the visitor, inside their wallet; the service never sees the signed bytes |
| before anything can reach the network | signed bytes + full context persisted, then a durable broadcast marker (D07) | the validated plan + full context persisted as an **attempt** (`VALIDATED`, 60 s window) before the wallet is asked to sign |
| field agreement | every serialized field compared with the plan **before** sending | `to`, `data`, `value`, `chainId`, type compared with the plan **after** the transaction is visible; wallet-set gas, fees and nonce are recorded as deviations, never silently accepted; a mismatch is `MISMATCH` and the order state still decides whether the order was paid |
| recovery | rebroadcast of identical bytes inside the window, nonce-consumer search, order state | no bytes to rebroadcast: the reported hash, the order state and the merchant's `OrderPaid` event; an attempt whose hash was never reported is recovered through `OrderPaid`, or closed `NOT_SENT` after 24 h |
| passport | `subject.kind = demo-run`, `executionMode = runner` | `subject.kind = wallet-run`, `executionMode = wallet`, private to the session |

Shared by both: an independent order whose **identity is durable before its creation transaction is sent** (`PLANNED →
SENT → CONFIRMED`; an interrupted creation is reconciled from `getOrder`, never replaced inside the same admission), the
referenced approval re-read at validation (validity and revocation), the pinned report, the deterministic decision, final
validation at a fresh block after the fee confirmation and the order creation with the payer account verified to carry no
code, the post-condition read-back, the cost statement and the verifier.

What the wallet mode does **not** change: the service never holds or spends a visitor's business funds; a browser payment
of the check fee still does not authorize anything beyond that check; smart accounts, EIP-7702 delegations and the
USDC-transfer intent stay closed; `NO_POLICY_VIOLATION` still means *no configured check fired*, not *safe*.

## 3. Self-service without trial tokens

Any visitor's browser obtains an anonymous session (`POST /v1/session`, hashed server-side, bounded per client and day).
The session owns its orders, checks, attempts, recovery commands and private passports. Nothing to register, nothing to
paste. Bounds that protect the project: the visitor pays the check fee and the business amount from their own wallet; the
project's exposure is the relayer's gas for the fee (covered by the fee) and the order-creation gas inside the daily order
budget; a testnet faucet (0.2 testnet USDC, one claim per wallet and per client per day) exists on the testnet instance only.
Business execution from browsers on the **mainnet** instance follows the same gate as the runner: enabled only once the
testnet rehearsal and the mainnet acceptance evidence exist (capability labels `IMPLEMENTED_TESTNET` → `MAINNET_VERIFIED`).

## 4. Product surfaces (replaces v3.2 §6 rows for the workbench and developer surfaces)

| Surface | Required capability | Explicit limit |
|---|---|---|
| Developer workflow (7 steps) | connect → **order dialog** (payer, proxy, amount, reference; *Autofill sample order*; validation; review step) → approve (the referenced approval and the buyer's policy, consciously confirmed) → preflight check → **execute with your wallet** → recover (My workflow: orders, attempts, remembered attempt ids) → passport → **verify in the browser** (online, anchors labelled as site-supplied) and the CLI line for a clean process | known fixture proxies and the one template; no arbitrary calldata; mainnet execution only after the mainnet acceptance |
| Live Demo | the project runner on the three fixtures, plus **Run with a simulated interruption**: the runner persists, marks and sends, then stops waiting; the recovery worker (or an observe read) resolves it from the original hash and the order state; the screen labels the interruption as simulated and shows what recovery added (orders 0, signatures 0) | project-funded, budgeted |
| Order and payment state | order id, creation tx, payment state (paid / unpaid, live), costs so far, next action — from records, never from preset copy; a run's headline follows the **execution store** (`outcome.source = store`), so a stored `BROADCAST_ATTEMPTED` never reads "nothing sent" | five state layers of v3.2 §7 retained |
| Cost disclosure | one table for both modes: business principal · check fee · business gas · fee-relay gas · order-creation gas × authorized maximum · actual · unresolved; buyer and operator grouped and totalled; exact USDC strings; null is "not available", never 0 | from `cost-statement.json`, the same object the passport writes |
| Passport & verifier | runner and wallet passports; the verifier recomputes the whole cost statement, matches the fee calldata to the authorization in every field, reports `UNVERIFIED` (with the reason) when a node cannot serve history, applies the wallet-mode plan-agreement rule by `executionMode` | no secrets; findings, never one overall PASS; `CURRENT_ELIGIBILITY` never evaluated |

Presentation rule (user feedback, 2026-10-08): concise text, a lifecycle diagram that marks the current stage, technical
detail collapsed, hashes as explorer links, no letter-wrapping chips, desktop-fitting tables, phone width without
horizontal scroll.

Presentation rule, extended (user feedback, 2026-10-09): the Live Demo guides — a persistent next-step panel derived from the
recorded run (what happened, what to click, what to inspect), every run labelled *live testnet execution* or *recorded example*,
the interruption explained before it starts and drawn while it recovers, execution and costs stated before the first click; less
prose everywhere, with explanations collapsed and graphics or canvas animation carrying the structure (lifecycle, who pays,
recovery).

## 5. State: never collapse distinct facts (extends v3.2 §7)

| Situation | Primary message | Permitted next action |
|---|---|---|
| Order planned or sent, receipt not seen | "Order creation not yet confirmed." | wait; reconciliation reads the chain; never a second order in the same admission |
| Order creation unknown after the window | "Order creation could not be established." | create a new order (a new row); the old row stays for the record |
| Attempt validated, wallet not yet answered | "Validated; waiting for your wallet." | confirm or abandon; the attempt is already durable |
| Hash reported, no receipt yet | "A broadcast was attempted; the outcome is not yet established." | recover (reads only); never "pay again" |
| Wallet sent something other than the plan | "The transaction deviates from the validated plan." | the order state decides whether the order was paid; export the record |
| Hash never reported, order later reads paid | "Paid by a transaction recovered through the merchant's event." | export; recovery status `recovered-from-event` |
| Hash never reported, order unpaid after 24 h | "Nothing was sent; closed without a transaction." | validate again when ready |

## 6. Acceptance additions — AP33 (extends v3.2 §18)

| ID | Required assertion | Minimum evidence setting |
|---|---|---|
| AP33-01 | A modified authorization validity window in `payment.json` fails `FEE_ATTRIBUTION`; a modified calldata hash in the capture fails it | verifier negative suite |
| AP33-02 | A cost statement whose totals, fee equivalence or authorized maximum differ from the records fails `COST_STATEMENT` | verifier negative suite |
| AP33-03 | Historical state the RPC cannot serve yields `UNVERIFIED`, never `FAIL` | verifier with a limited RPC fake |
| AP33-04 | A runner run interrupted right after the broadcast still exports a complete passport | API fault injection + testnet rehearsal |
| AP33-05 | An order is persisted before its creation transaction is sent; an interrupted creation is reconciled from chain, never replaced | API tests + testnet |
| AP33-06 | The run headline follows the execution store (`BROADCAST_ATTEMPTED` is never shown as "nothing sent") | API test + deployed UI check |
| AP33-07 | A wallet attempt is persisted `VALIDATED` with its plan before the wallet is prompted; abandon and sent are recorded | API tests |
| AP33-08 | A wallet transaction that deviates from the plan in `to/data/value` is recorded `MISMATCH`; gas/nonce deviations are recorded, not hidden | API tests |
| AP33-09 | A wallet attempt whose hash was never reported is recovered through the merchant's `OrderPaid` event, or closed `NOT_SENT` after the window | API tests |
| AP33-10 | A wallet attempt's passport verifies (wallet-mode plan agreement) in a clean process | testnet rehearsal, then mainnet |
| AP33-11 | Order dialog: validation, autofill, editable fields, review step; the created order shows id, tx, payment state, costs, next action | deployed UI check |
| AP33-12 | The Live Demo shows a successful payment, a labelled interruption-and-recovery, and passport export followed by verification | deployed UI check + testnet rehearsal, then mainnet |

`NOT_RUN` is not a pass. Mainnet rows require the typed go for each spend.

## 7. Submission copy delta (v3.2 §24)

Replace "the business runner directly executes the approved merchant call" with: "the approved merchant call is executed
either by the project runner or by the visitor's own wallet; in both modes the exact plan is validated at a fresh block,
recorded before anything can reach the network, compared with what was actually sent, and reconciled from the chain if the
session breaks". Replace the restricted-release sentence with: "The release supports one tested merchant template; any
visitor can run the complete lifecycle with their own wallet on Arc testnet, and on Arc mainnet once the mainnet acceptance
evidence exists."
