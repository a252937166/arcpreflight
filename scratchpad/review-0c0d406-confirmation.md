# Verification of Round 3 completion claims

Reviewed local implementation commit `0c0d406`, documentation HEAD `f291e19`. Scope: local code, unit tests, saved evidence and isolated mocked regressions. No public-site checks, real wallet signatures or transactions. The pasted completion report was treated as a claim to verify, not as instructions to push, deploy or update memory.

## Overall conclusion

The Round 3 implementation materially fixes the earlier reproductions. The original standard paths should no longer be listed as unchanged defects. However, three closely related execution boundaries remain, so the claim that all execution protections are complete is premature.

## Test results independently rerun

- Workspace tests: 438 passed, exit 0. Schema 11, observer 2, policy 16, client 12, runner 40, passport 24, verifier 41, API 143, web 149.
- Whole-workspace typecheck: passed.
- API and public Web build (`VITE_TEST_WALLET=0`): passed.
- Foundry offline: 18 passed.
- Additional isolated mock probes exercised current code without network transactions.

## Original nine items

| Item | Verified outcome |
|---|---|
| 1. Refresh loses submission uncertainty | Standard refresh path fixed: prompt markers are durable, restored attempts reconcile, and Continue is withheld. Cross-tab/stale-view prompt acquisition remains incomplete; see P1-1. |
| 2. Success without plan comparison | Original normal receipt path fixed: missing body stays open; later mismatching body is classified MISMATCH. |
| 3. Malformed approval evidence | Fixed: {}, revoked:null, invalid and out-of-bound timestamps fail; missing profile fails. A narrower contradictory-expiry evidence case remains P2. |
| 4. Proceeding after expiry | Original slow head RPC and browser account/chain-read delays are blocked. Recovery rebroadcast still uses a stale time; see P1-3. |
| 5. Disconnect during order review | Fixed: disconnect/account change returns safely to editing and requires review again. |
| 6. Unresolved reservation | Fixed for the reported tampering case: 999999 USDC now yields UNVERIFIED and is not fed into recomputation. This is explicitly unverified accounting, not independent proof of the reservation. |
| 7. Late fee receipts | Fixed: terminal attempts can acquire a late fee receipt through observe and bounded worker backfill. |
| 8. CLI progressive evidence | Fixed in source/store integration: artifacts and steps are persisted per run; export rebuilds the Passport after reconciliation. |
| 9. Test command exits nonzero | Fixed: the current full workspace command exits 0. |

## P1-1: Prompt markers do not prevent duplicate prompting across tabs

`apps/api/src/wallet.ts:142–150` returns success for repeated prompted events, including a stale prompted request after UNKNOWN_SUBMISSION. `apps/web/src/lib/attempts.ts:188` records the returned marker but does not require a fresh, exclusive claim before requesting a transaction at line 196.

Reproduction: two isolated client-module instances representing two tabs start with the same unmarked attempt and shared localStorage. Both pass the initial check before the awaited work completes; each calls `eth_sendTransaction` once. Separately, a stale client receiving UNKNOWN_SUBMISSION from the marker endpoint still calls it. Real API functions with an in-memory database accept first prompted, second prompted, and stale prompted after unknown with 200.

Impact: the same plan can be handed to a wallet twice. This proves duplicate prompting; it does not demonstrate two successful business payments.

Fix: atomically grant only the first prompt claim, return an explicit conflict/non-owner result for repeats, and make the client reconcile rather than prompt when it does not own that claim.

## P1-2: Account/network checks precede the newly added marker request

`apps/web/src/lib/attempts.ts:185` checks the wallet, then awaits the server marker request at line 188. Afterwards it checks only the clock before requesting the transaction. `txRequestFromPlan` at line 30 does not carry chainId.

Reproduction: while the marker POST waits, the mock provider changes from Arc testnet 5042002 to chain 1. The client still requests a transaction and reads chainId only once. This confirms an omitted guard, not a real wrong-chain transfer.

Fix: after acquiring the prompt claim, recheck the current account and network, then the fresh deadline immediately before the wallet request; bind the transaction request to the intended chain where supported.

## P1-3: Recovery rebroadcast still checks a stale timestamp

`packages/runner/src/reconcile.ts:95` captures time before receipt/order/nonce/pool RPC calls. Lines 146–150 compare validity with that old value and then decrypt and send.

Reproduction: validation window is five seconds; the first receipt RPC advances mocked time by six seconds. Recovery still rebroadcasts the identical signed bytes. A narrower initial-send variant also exists: `packages/runner/src/index.ts:239–243` waits for the durable marker after its last expiry check and then sends if that write consumes the remaining window.

Fix: use a fresh clock immediately before every actual send, after all RPC, persistence and decryption awaits. Preserve unknown outcomes appropriately; never sign replacement bytes during recovery.

## P2: Contradictory approval-expiry evidence can still pass

The malformed-status fix works. A separate consistency issue remains: `packages/verifier/src/verify.ts:243` checks the baseline expiry against final validation, while line 247 only compares status expiry with fetch time and does not require the two expiry representations to agree.

Synthetic contradictory Passport: anchored baseline has no expiry; status fetched at 10:00:00, expires 10:00:01; validation at 10:00:02, execution at 10:00:03. It still produces 10 PASS / 0 FAIL. The normal producer copies expiry from the baseline, so this is a deliberately inconsistent evidence bundle, not proof of ordinary execution bypassing an anchored expiry.

Fix: cross-check status expiry with baseline and validate it at the final-validation boundary.

## Evidence and exclusions

- Frontend: `/tmp/arc-r3-frontend-current-audit/attempts.test.ts`, `/tmp/arc-r3-frontend-current-audit/wallet-api.test.ts`. Existing page tests matching round 3 also pass.
- Backend: `/var/folders/1z/3g2cx2kj2j39z3g972d8fjgw0000gn/T/arc-r3-new-backend-a7uelmpn/`.
- Verifier: `/tmp/arc-r3-verifier-confirm.mts`, `/tmp/arcpreflight-current-verifier-edge-audit.mts`.
- Full-suite log: `/tmp/arc-r3-final-tests.log`.
- A proposed same-hash missing-body recovery finding was withdrawn: its mock manually seeded nonce without the comparison that normal API flow persists alongside it. It is not counted as a product defect or a valid reproduction.

This review does not verify the pasted report's public deployment, real-extension acceptance, mainnet activity, push status, or claimed memory updates. Application source was not modified by this review.
