# Current-code audit, round 3 — 2026-10-08

Scope: current local source and local tests only. No public-site checks, wallet signing, faucet claims or transactions. No application-source changes made by this review. The working tree was updated concurrently; the execution-budget `feePaid` improvement was rechecked and removed from the findings.

Verdict: substantial repairs are present, but concrete correctness and recovery defects remain. Do not describe the code as fully fixed yet.

## Verification performed

- Final workspace run: `pnpm -r --parallel --no-bail test`. 418 individual tests passed, but the command exited 1 because runner has an unhandled Promise rejection. Package counts: schema 11, policy 16, client 12, observer 2, passport 23, verifier 39, runner 39, API 140, web 136.
- Full workspace typecheck passed. Web typecheck was repeated after the concurrent budget change and passed.
- API and Web builds passed. A separate public Web build with `VITE_TEST_WALLET=0` was written to `/tmp/arcpreflight-code-audit-public-20261008`; its JS assets contain none of the test-wallet URL/storage markers searched.
- Foundry offline: 18 passed.
- Additional isolated offline tests reproduce the findings below. These reproduce defects using mocked RPC, component rendering or saved Passport data; they do not prove real transactions occurred.

## Remaining findings

### P1 — Submission uncertainty is lost after refresh

The client handles an ambiguous wallet error as `unknown-submission`, but persists only the attempt identity/state. Restoring an open attempt sets the phase back to `idle`. Within the validation window, Continue in wallet and Abandon (nothing sent) reappear even though the original transaction might already have been submitted.

Evidence: `apps/web/src/lib/attempts.ts:37`, `apps/web/src/pages/Developer.tsx:202`, `apps/web/src/components/AttemptPanel.tsx:17` and `:27`. Offline test reproduced timeout → uncertain state → remount → continuation enabled.

Fix: persist prompt/submission uncertainty before invoking the wallet, retain it across refresh/navigation/account changes, and reconcile before allowing another signature. A duplicate business payment was not demonstrated; the confirmed problem is unsafe retry eligibility and misleading state.

### P1 — Ordinary wallet receipt recovery can still skip plan comparison

The OrderPaid discovery path is fixed, but the normal reported-hash path can close CONFIRMED/SUCCESS when the receipt and paid order exist while `getTransaction` is null. `deviations` remains null. Closed attempts are excluded from later reconciliation, so a later-visible mismatching transaction body is never compared.

Evidence: `apps/api/src/wallet.ts:260–269`. Isolated test first closed with no transaction body, then supplied mismatching calldata and called recovery; recovery made no further RPC calls. `apps/web/src/components/AttemptPanel.tsx:47` also still renders green “as planned” with a hash and missing comparison.

Fix: require transaction body, receipt and completed comparison before asserting plan agreement. Keep outcome and plan verification separate if payment itself is already established.

### P1 — Malformed approval status still produces false PASS

The old missing/revoked standard cases were repaired, but status `{}`, `revoked: null`, or invalid date strings still produce APPROVAL_COVERAGE PASS. One repro returns 10 PASS / 0 FAIL with the explanation “read as not revoked at undefined.” Status expiry is compared against fetch time rather than final-validation time in one branch.

Evidence: `packages/verifier/src/verify.ts:223–229`. Fix with strict status schema validation, an explicit `revoked === false` requirement, valid timestamps, and validity at the actual validation/execution boundary. Missing evidence should be UNVERIFIED, contradictory evidence FAIL.

### P1 — Validation can expire during the final RPC wait and still be broadcast

The runner checks expiry before awaiting the current block and durable broadcast marker. It does not recheck immediately before `sendRawTransaction`. An isolated test delayed the final head query six seconds with a five-second validation window; the runner still sent once and confirmed.

Evidence: `packages/runner/src/index.ts:227–236`. Recheck after the final potentially blocking operation and before the send. Audit the shared reconciler's captured-time rebroadcast decision for the same pattern.

### P2 — Disconnecting a wallet during order review crashes rendering

Review mode dereferences `body!.payer`. Disconnecting changes payer to null, causing form validation to return null without leaving review mode. The offline component test reproduces a null-property exception.

Evidence: `apps/web/src/components/OrderDialog.tsx:93`. Guard the review body and close/reset/reconfirm the order when wallet identity becomes invalid or changes.

### P2 — Reservation verification remains circular

The verifier validates decimal syntax, then copies the supplied unresolved reservation into its own recomputation. A forged reservation of 999999 USDC still gets COST_STATEMENT PASS and 10 PASS / 0 FAIL. Producers omit the actual reservation input, which defaults to zero even for unresolved executions.

Evidence: `packages/verifier/src/verify.ts:410` and `:430`; `packages/passport/src/cost.ts:75`. Derive reservations from durable attempt/budget records, or mark the field unknown/unverified rather than treating self-comparison as evidence.

### P2 — Wallet page and Passport still use different cost inputs

Wallet API results set `feeReceipt: null`, while Passport export refetches the fee receipt and adds relay gas. The new completeness flag makes the page honest about missing costs, but the two outputs are not the same complete statement. The runner's new interruption record does have matching totals; that prior runner defect is fixed.

Evidence: `apps/api/src/wallet.ts:383`, `:412`, `:426`. Persist or share a common cost snapshot instead of relying on export-only enrichment.

### P2 — Test suite exits nonzero despite passing assertions

The artifact failure test creates a rejecting Promise, advances all timers, and only then attaches the rejection expectation. Vitest correctly reports an unhandled rejection. This is a test-handler timing defect: the production path correctly blocked the payment.

Evidence: `packages/runner/test/runner.test.ts:235–236`. Attach the rejection expectation first, advance timers, then await the expectation. This was reproduced by the isolated test and both workspace runs.

### CLI limitation — Progressive evidence inputs are still not retained

The CLI now supplies an order store, but no `onArtifact` callback, and writes the full run JSON only after the run returns. Order/payment reconciliation is available; a process crash does not guarantee that all Passport inputs survived.

Evidence: `examples/merchant-agent/src/run.ts:93–96`. Add the same progressive artifact persistence contract used by the API if complete crash-time evidence is part of the CLI promise.

## Confirmed repairs

- Missing wallet approval history becomes UNVERIFIED; explicit revocation and clear expiry fail; missing/unsupported verification profile is rejected.
- Event-discovered wallet transactions now require body, receipt and plan comparison.
- Database uniqueness blocks concurrent open attempts for the same order.
- Required artifact failures before business broadcast stop the runner; final snapshot age uses observedAt.
- API startup repairs the closed-store/unfinalized-run crash window; CLI has order identity persistence.
- Per-account workflow storage and pre-sign account/network/deadline guards exist.
- FAIL and UNVERIFIED verifier results no longer mark the lifecycle successful.
- Cost completeness flags and payer-role labels exist; new runner interruption totals match exported Passport totals.
- Accordion hiding, keyboard scenario buttons, approved-payment default, distinct demo/trial entry points and clearer order explanation are implemented.
- Autofill/edit/review remain available, technical JSON is secondary, faucet budget is dynamic, and the latest execution budget excludes an already-paid report fee.
- The test wallet is behind a build-time flag and its module is absent from the inspected public build.

## Reproduction evidence

- Backend: `/var/folders/1z/3g2cx2kj2j39z3g972d8fjgw0000gn/T/arc-current-backend-1yp3sykg/` — two bounded negative tests.
- Frontend: `/tmp/arc-front-review-_l66vx6c/review.test.tsx` — two remaining regressions and one assertion confirming the latest fee-budget fix.
- Verifier: `/tmp/arcpreflight-current-verifier-edge-audit.mts` and `/tmp/arcpreflight-v33-passport-latest-audit.mts`.
- Final workspace log: `/tmp/arcpreflight-code-final-tests.log`.

Review source timestamps at final read: Developer 15:26:32 ET; OrderDialog 13:56:24; verifier 13:20:09; API wallet 13:25:29; runner index 13:22:15; runner test 13:24:07. These findings describe that snapshot, not later edits.
