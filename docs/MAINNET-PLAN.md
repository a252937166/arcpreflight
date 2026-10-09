# Arc mainnet execution plan (Gate D)

**Status: proposed, awaiting the operator's approval of this plan and its budget.** No mainnet transaction has been sent by this
project since the 2026-10-07 funding split (deployer-admin nonce 2). Every spending or server-changing step below additionally needs
its own typed go (`export CUTOVER_GO=<step>`). Public mainnet execution stays closed (`PUBLIC_EXECUTION=0`) until the acceptance
evidence is recorded; opening it and pushing to GitHub are separate approvals.

## Release

| | |
|---|---|
| Release (code) | **`78c8dc2`** — the last commit that changed what runs on the server (`apps`, `packages`, workspace files). Docs-only commits keep the label; `ops/deploy.sh` refuses uncommitted code or fixtures. |
| Running now | the public **testnet** preview at `https://arcpreflight.axiqo.xyz` runs `78c8dc2` after its redeploy (2026-10-09); `3749ae2` before it. |
| Found in the testnet rehearsal | the public Arc testnet RPC once answered `eth_sendRawTransaction` with "method does not exist / is not available" (a load-balanced node that does not take transactions); the runner sent once, so the transaction never reached the network and the run waited for its nonce. `78c8dc2` re-sends the identical signed bytes up to 3 times, each only after a fresh clock read inside the validation window; no different transaction is ever signed. |
| Tests on `78c8dc2` | `pnpm -r test` exit 0: web 184, API 153, runner 49, client 20, verifier 43, passport 24, schema 11, policy 16, observer 2; typecheck incl. scripts; public build without the test wallet. |
| Read-only preflight | `ops/mainnet-cutover.sh preflight` on release `78c8dc2`, 2026-10-09 ≈12:33Z: release clean; fund, deploy and probe preflights **OK**, nothing signed (`evidence/preflight/deploy-mainnet-2026-10-09T12-33-13-558Z.json`; first run on `3749ae2` at 12:19Z identical). |

## Accounts (Arc mainnet, read 2026-10-09)

| Key | Address | Balance | Nonce | Signs in this plan |
|---|---|---|---|---|
| deployer-admin | `0xDBb3598F78A9a8888d89E96F938aB0A719b075aA` | 4.49916 USDC | 2 | the 7 deployment transactions, the 2 funding transfers (laptop; the key is not on the server) |
| order-creator | `0xb6eEF219F86ae75FFc3aF9eF3cAdE49F89a7582b` | 0 | 0 | `createOrder` for every run and the lifecycle order (server) |
| demo-runner | `0xC6182D363D7c3Da6Db491f703C430Dc91d0e2ACE` | 5.0 USDC | 0 | the probe's fee authorization (laptop); the runs' fee authorizations and business payments (server) |
| merchant-payto | `0x06873b35575D6A22eC8008f30F56c71C19BeE7b0` | 0.5 USDC | 0 | relays every fee authorization (probe: laptop; runs: server) |
| visitor-rehearsal | `0xA71138FF271DB9A18D2B216cAF13b830Eeab3FF2` | 0 | 0 | the lifecycle wallet scenario's fee authorization and business payment (laptop) |

Network facts at preflight: chain 5042, base fee 20 gwei (the floor), max fee sent 24 gwei, priority ≈ 0. Every transaction a script
signs is capped at a 40 gwei max fee; above it nothing is sent.

## Steps, in order

| # | Step (`ops/mainnet-cutover.sh …`) | Who signs | What happens | Expected cost | Enforced cap |
|---|---|---|---|---|---|
| 0 | preconditions | — | real-wallet acceptance on testnet `78c8dc2` recorded (AP33-30, needs your session); this plan approved | — | — |
| 1 | `deploy` | deployer-admin | implementation A, implementation B, MAIN proxy on A, CHANGED proxy on A, `setOrderCreator` ×2, upgrade CHANGED A→B. Predicted addresses (nonce 2–5): implA `0x00e393aCDCD8cfBef4Ab5D0F826bEBD87bf4Ae14`, implB `0x816Ca9Da6D3A316D9b4cFf414890b07cBC95B399`, MAIN `0xa09f5Dd3753823B4920CEa629e83fC481fe00EBc`, CHANGED `0x3bc7340CfE664c3b09D4e64d1B7dE239F6748605` | gas 0.0536 | 0.05 per transaction, 0.15 total (worst case 0.0772) |
| 2 | `fund` | deployer-admin | +0.10 USDC to order-creator, +0.05 to visitor-rehearsal (allow-listed project keys; balances read back) | 0.15 moved inside the project + gas 0.0008 | 0.20 per transfer, 0.20 total incl. value (worst 0.1512) |
| 3 | `probe` | demo-runner, merchant-payto | ONE 0.01 USDC check fee (EIP-3009) relayed by merchant-payto, proven by its logs — before `server`, so no API relays with that key on mainnet yet | fee 0.01 inside the project + gas ≈ 0.0018 | 0.016 per transaction, 0.02 total; relay gas ≤ 0.005 |
| 4 | commit | — | `fixtures/deployments-mainnet.json` and the deploy / fund / probe evidence (the release bundle ships `fixtures/`; the label stays `78c8dc2`) | — | — |
| 5 | `server` | — (no chain spend) | root → Arc mainnet with `PUBLIC_EXECUTION=0` written explicitly, daily caps sized for acceptance (14 runs; business 0.25, fees 0.15, gas 0.15 USDC), no faucet; testnet moves to `/testnet` and keeps the current public database; order-creator key on, deployer-admin key off. Then verified: network, release, order signer, deployer key absent, gate probes 503 — **any failure stops the mainnet service** | — | — |
| 6 | `baselines` | — (admin API) | approve MAIN (live A) and CHANGED (pinned to A) at a pinned mainnet block | — | — |
| 7 | `gatecheck` | — | `publicExecution=false`; run / order / attempt probes from a visitor answer 503 | — | — |
| 8 | `acceptance` | server: order-creator, demo-runner, merchant-payto | 3 rounds × 3 fixtures through the closed gate with the admin token; admission replay; on-chain role checks; every passport verified in a clean process | fees 0.09 (inside the project), business 0.15 into the MAIN proxy, gas ≈ 0.036 | 0.35 total incl. every gas ceiling (worst 0.3486), measured outflow stop before each run; server per-transaction ceilings: createOrder 0.006, pay 0.002, relay 0.005 |
| 9 | `lifecycle` | visitor-rehearsal (laptop); server keys | the wallet scenario (order, paid check, validated attempt, the wallet's own broadcast, passport) and the labelled interruption (recovery adds 0 orders, 0 signatures) through the closed gate | business 0.055 into the MAIN proxy, fees 0.02 inside, gas ≈ 0.012 | visitor key 0.03 per transaction, 0.05 total; project outflow 0.12 measured |
| 10 | record | — | evidence rows in `docs/EVIDENCE.md`, `docs/ACCEPTANCE.md` mainnet columns | — | — |
| 11 | `open` — **separate approval** | — | `PUBLIC_EXECUTION=1`, `MAINNET_VERIFIED=1`; refused unless PASS acceptance and lifecycle evidence for the running release is recorded | — | — |
| 12 | push — **separate approval** | — | `git push` (force-push of the rewritten history included) | — | — |

## Money

| | USDC |
|---|---|
| Gas burned (leaves the project) | ≈ 0.105 expected |
| Business payments into the project's own DemoMerchant MAIN proxy (owner-withdrawable by deployer-admin) | 0.205 |
| Moved between project keys only (funding, check fees) | 0.27 |
| **Expected outflow from the project's keys** | **≈ 0.31** (0.105 gas + 0.205 into the merchant contract) |
| Sum of the enforced step caps | 0.84 (deploy 0.15 + fund 0.20 + probe 0.02 + acceptance 0.35 + lifecycle 0.12) |
| **Maximum total spend** | **0.69** — the caps minus the 0.15 the fund step only moves between project keys |

Balances after the plan (expected): deployer-admin ≈ 4.29, demo-runner ≈ 4.69, merchant-payto ≈ 0.60, order-creator ≈ 0.08,
visitor-rehearsal ≈ 0.03. Every step's worst case fits the signing key's balance; the preflights check it again before signing.

## Stop conditions

Any of these stops the plan; nothing further is sent, the evidence (including `-INCOMPLETE` files and the spend ledgers in
`evidence/spend/`) is kept, and resuming needs a new typed go:

1. A preflight is NOT READY: balance below the step's worst case, a pending nonce, code at a predicted address, a max fee above 40 gwei, an existing `fixtures/deployments-mainnet.json`.
2. The spend guard refuses a transaction (per-transaction cap, step total, fee ceiling); a live gas estimate above 1.5 × its planned bound.
3. Any receipt reverts; a funded key does not receive exactly the planned value.
4. Post-cutover verification fails (network, release, order signer, deployer key on the server, gate) — the mainnet service is stopped.
5. The gate is not closed before acceptance or the lifecycle (`publicExecution` true or any probe other than 503).
6. A run with an unexpected decision or outcome, an unverified fee or business transaction, a passport with a FAIL finding, or measured outflow that would pass a cap.
7. A business transaction left `BROADCAST_ATTEMPTED` for more than 10 minutes: reconcile first, no new run.
8. The RPC reports a chain other than 5042, or the running release is not `78c8dc2` (or an approved successor).

## Approvals needed

1. This plan and budget (maximum 0.69 USDC out of the project's keys, expected ≈ 0.31).
2. Then one typed go per step, in order: `deploy`, `fund`, `probe`, `server`, `baselines`, `acceptance`, `lifecycle`.
3. Separately, later: `open` (public mainnet execution) and the GitHub push.
