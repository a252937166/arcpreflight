# ArcPreflight

**Pay the approved order. Recover the original attempt. Take the proof with you.**

ArcPreflight is a recoverable payment workbench for developers automating USDC orders on Arc. It binds a supported
merchant payment to an independent order and an approved contract implementation, re-validates at a fresh block before
signing, signs exactly the validated plan, and — when a response is lost or a process dies after the broadcast —
reconciles the *original* attempt from its recorded hash and the order state instead of creating another purchase.
Each finished or stopped workflow exports a **Payment Passport**: the referenced approval, the records, the correctly
attributed USDC costs and the chain facts a separate process can verify with an Arc RPC and trusted approval anchors
(`docs/PASSPORT.md`). A passport is evidence, not a token, not a guarantee and not proof that an offchain service was
delivered.

Three moments make the story: **A** — the address stayed, the approval did not (a compatible upgrade stops business
signing); **B** — the response disappeared, not necessarily the money (the original attempt is recovered, never
repeated); **C** — a new reader finds the payment (the passport verifies in a clean process).

Live: **https://arcpreflight.axiqo.xyz** — today the Arc **testnet preview** (free to try with your own wallet; the faucet gives
testnet USDC); after the mainnet cutover Arc mainnet serves at the root and testnet stays under `/testnet` (the network switch in
the header only changes the API base path, explorer and wallet chain) ·
API: `/openapi.json` · Submission: Arc Microgrants (DoraHacks)

## Three outcomes, one code path

| Fixture | What happens | Outcome |
|---|---|---|
| `CHANGED_IMPLEMENTATION` | the merchant proxy was approved on implementation A and later upgraded to B — a compatible upgrade: same ABI, same calldata, same price, and the payment would still succeed | **REVIEW_REQUIRED** — the controlled signer refuses because B was never approved. No business transaction is signed or broadcast until a human re-approves the baseline; the separately authorized check fee may already have settled |
| `AMOUNT_UNIT_MISMATCH` | order is 0.05 USDC; the transaction sets native `value` to `50000`, instead of `50000000000000000` for the approved 0.05-USDC order (6-decimal units on the 18-decimal native path) | **BLOCKED** — ArcPreflight explains why the candidate amount violates the independently approved order. In this fixture, the merchant contract also rejects the incorrect amount, and the pinned simulation decodes `WrongAmount(...)`. No business transaction is signed or broadcast |
| `APPROVED_PAYMENT` | baseline matches, order payable, simulation passes | **NO_POLICY_VIOLATION** → final validation → signed plan → broadcast → order reads as paid |

Every run on the live site is persisted with its receipts and can be exported as a passport (`GET /v1/demo/runs/{id}/passport`). The digest dependencies run: intent + report + decision +
transaction plan + fresh evidence → `finalValidationDigest` (the transaction plan and its digest sit inside the
final-validation receipt) → signed transaction hash + chain receipt + business postconditions → `executionDigest`. Each
digest is keccak256 over canonical JSON. A blocked request stops at its stage; no signing or broadcast records are
manufactured. Replaying the chain needs the schemas, methodology, adapters, policy, baseline and raw evidence, not just
the hashes, and hash consistency does not prove that an RPC provider supplied truthful state. Runs are labelled
`LIVE_REQUEST` / `DEMO_ON_MAINNET` / `RECORDED_SAMPLE`. `NO_POLICY_VIOLATION` means *no configured check fired at the
pinned block* — never "safe".

## What this is not

ArcPreflight is not a transaction simulator, not a risk score and not a spend guard, and it can be used alongside all three.

- Simulators such as Tenderly answer *what will this transaction do*: traces, balance changes, gas, revert reasons.
  ArcPreflight runs one exact-call simulation as one of its checks and treats the result as evidence, not as a verdict.
- Risk APIs such as GoPlus answer *is this token, address or approval risky*. ArcPreflight produces no score and makes
  no audit claim; `NO_POLICY_VIOLATION` only means that no configured check fired at the pinned block.
- Agent spend guards enforce budgets, allowlists and kill switches on the agent's side. ArcPreflight does not manage the
  agent's budget.

ArcPreflight answers a different question: *is this call still the one that was approved?* — an independent business
expectation (the order), an approved implementation baseline, re-validation at a fresh block before signing, and
byte-exact binding of the signed transaction to the validated plan.

## What it uses Arc for

- **USDC is the gas, with two interfaces.** Native USDC has 18 decimals; the ERC-20 interface at `0x3600…0000` has 6, one
  balance behind both. `AMOUNT_SEMANTICS` compares the exact candidate call with an independently approved business
  expectation and flags the 10¹² mistake before any business transaction is signed or broadcast (the separately
  authorized check fee may already have settled).
- **Block-hash-pinned reads.** Every fact is read with EIP-1898 pinning on Arc's public RPC (`PIN_LAG` blocks behind
  head because the endpoint is load-balanced), verified by number, and digested as raw evidence. The 20 gwei fee floor
  is respected and re-estimated at final validation.
- **Check fee settled on Arc by the project's own relayer.** The 0.01 USDC fee is paid with one EIP-3009
  `TransferWithAuthorization` (USDC EIP-712 domain `USDC`/`2`, verified against the on-chain `DOMAIN_SEPARATOR`).
  ArcPreflight's merchant account submits the transfer to the USDC contract and pays the gas in USDC — fees collected and
  settlement gas paid in the same asset. The buyer needs no allowance and no gas for the fee. This covers the check fee
  only: the business payment that follows is the agent's own transaction, with its own gas.
- **Arc runtime advisories** (`basis: network_advisory`): 20 gwei fee floor, value-transfer rules, `PREVRANDAO = 0`,
  SELFDESTRUCT semantics, non-strict timestamps — documentation-backed rules, never claims about the target.
- **Public Arc/Circle contracts as read-only observation subjects.** A curated set of Arc/Circle contracts is observed
  read-only. Proxy resolution is reported only where the exact deployed template has been verified; otherwise,
  observations remain raw or unknown. Observation is never decision-eligible.

## Repository

```
packages/schema     zod contracts (schemaVersion 1.0), canonical JSON + keccak digests
packages/observer   pinned snapshot, raw reads, ERC-1967 template adapter, RPC evidence
packages/policy     deterministic checks: INTENT_BINDING, AMOUNT_SEMANTICS, allowlists, BASELINE_STATUS, EXECUTION_IDENTITY, CALL_SIMULATION, EVIDENCE_FRESHNESS
packages/client     EIP-3009 buyer signing, USDC domain checks, settlement helpers
packages/runner     the full loop as a library + the shared reconciler (original hash, nonce, order state) + a SQLite execution store
packages/passport   Payment Passport exporter (format 1.0): manifest, digests, cost statement, recovery counters, bundle/directory forms
packages/verifier   independent verifier + CLI: digests, anchors, fee attribution, plan agreement, order outcome, cost statement
packages/contracts  DemoMerchant V1/V2 (UUPS, orderCreator role) + Foundry tests
apps/api            x402 seller API (quote → self-relayed EIP-3009 settlement → deliver → recover), demo runs with admission keys, observe-only reads, recovery commands, passport export
apps/web            the site (Vite + React): live demo (incl. a labelled interruption), the 7-step Developer workflow (order dialog → approve → check → execute with your wallet → recover → passport → verify in the browser), recovery desk, /verify, inspect, evidence, mainnet/testnet switch
scripts/demo        deploy fixtures, approve baselines; scripts/selftest: testnet and mainnet acceptance runners
examples/merchant-agent  the persistent reference CLI: run | reconcile | list, durable store, --crash-after-broadcast
```

Release profile `SUBMISSION_RESTRICTED`: the USDC-transfer intent path and smart-account / EIP-7702 buyers are off —
each a deferred feature whose rejection is tested, not a hidden gap. Everything else in the lifecycle is open to every
visitor through an anonymous browser session (`POST /v1/session`): own orders (amount and reference, identity durable
before the creation is sent), paid checks (the visitor pays the 0.01 USDC fee with their own wallet; on testnet a small
project faucet covers it), **execution with the visitor's own wallet** (validated server-side, recorded before the prompt,
compared with the plan after the fact, reconciled from the chain), recovery and private passports — see `docs/LIFECYCLE.md`
and `docs/DESIGN-v3.3.md`. The checks constrain the supported signer paths under a trusted application process. They do not
provide on-chain enforcement or protection against compromise of that process or its keys. Business execution on the
mainnet instance follows the `IMPLEMENTED_TESTNET` → `MAINNET_VERIFIED` gate in `docs/KNOWN_LIMITATIONS.md`.

## Run it

```
git clone --recurse-submodules https://github.com/a252937166/arcpreflight && cd arcpreflight
pnpm install && (cd packages/contracts && forge build)
# keys/*.json (never committed), then:
ARC_NET=testnet pnpm exec tsx scripts/demo/deploy.ts                         # fixtures
set -a; source keys/env.testnet; set +a; pnpm exec tsx apps/api/src/server.ts # API on :4040
pnpm --filter @arcpreflight/web dev                                          # site on :5173
ARC_NET=testnet API_URL=http://127.0.0.1:4040 ADMIN_TOKEN=… pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
```

Reference CLI (durable store, restart into reconciliation; orders are created with the `orderCreator` key, never the owner key):

```
ARC_NET=testnet API_URL=http://127.0.0.1:4040 RUNNER_TOKEN=… BASELINE_DIGEST_MAIN=0x… \
  pnpm exec tsx examples/merchant-agent/src/run.ts run APPROVED_PAYMENT [--crash-after-broadcast]
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts reconcile    # resolves open attempts from the store; never re-signs
ARC_NET=testnet pnpm exec tsx examples/merchant-agent/src/run.ts list
```

Verify a passport in a clean process (no API, no keys; anchors are the approved baseline/policy digests you retained):

```
pnpm exec tsx packages/verifier/src/cli.ts arcpreflight-passport-<run>.json --rpc https://rpc.testnet.arc.io --anchors anchors.json
```

Tests: `pnpm -r test` and `forge test` in `packages/contracts`.

The workspace test command also covers API payment recovery, persistent demo admissions, baseline scope/expiry,
runner retries, closed-capability rejections and the developer/inspection UI. Run with Node 22.6+ for `node:sqlite`;
native Rollup/esbuild modules must match the Node architecture. `pnpm -r typecheck` and
`pnpm --filter @arcpreflight/api --filter @arcpreflight/web build` check the release bundles.

For an explicitly configured **testnet** API, `ARC_NET=testnet API_URL=http://127.0.0.1:4041 pnpm exec tsx scripts/selftest/testnet.ts`
runs all three fixtures three times and verifies receipt digests, negative no-sign outcomes and positive paid orders.
It spends the project's testnet funds (0.09 USDC check fees + 0.15 USDC business payments, plus gas), refuses mainnet,
and saves the public result summary under `evidence/selftest/`. Keep the API's cooldown/budget configuration appropriate
for this isolated test run; no production limits are changed by the script. `scripts/selftest/mainnet.ts` is the
mainnet acceptance runner: a dry run by default, and `--execute` requires an explicit `API_URL` and `EXPECTED_RELEASE`.

## Honesty notes

- Testnet is a rehearsal network; the submission network is Arc mainnet (`eip155:5042`). Reports never mix the two.
- The live demo is driven by the project's own runner against the project's own fixtures and is project-funded; demo
  payments move between project-owned addresses and are not revenue. A tester's purchase on the developer page is a
  tester's purchase, not agent adoption.
- Check-fee settlements made before the relayer existed went through a hosted facilitator; they remain evidence of the
  EIP-3009 buyer flow, not of the relayer. See `docs/EVIDENCE.md`.
- Recovery counters and cost statements are computed from the recorded steps and receipts of each run, never from preset
  copy; a run that never needed recovery shows "new orders created: 0" because nothing beyond its original attempt exists.
- Wallets: the Developer page talks to injected EIP-1193 providers discovered through EIP-6963 (MetaMask, OKX Wallet, Rabby,
  Coinbase Wallet extension, Brave…), asks the wallet to switch to the selected Arc network, reconnects after a refresh and
  revokes the site's permission on disconnect where the wallet supports it. In wallet mode it asks the wallet to send exactly
  the validated plan; the service never sees the signed bytes and compares what was sent after the fact (design v3.3).
  WalletConnect and mobile deep links are not supported in this release.
- Capability labels (`IMPLEMENTED_TESTNET`, `MAINNET_VERIFIED`, `PROPOSED`, `DISABLED`) say where a capability has been
  exercised; `MAINNET_VERIFIED` appears only after the mainnet acceptance evidence exists. Testnet rehearsals of the
  recovery paths are listed in `docs/EVIDENCE.md`; a crash injected on testnet is labelled testnet.
- Design of record: `ArcPreflight_Final_Product_Design_v3.2.md` (English) with the v3.3 addendum `docs/DESIGN-v3.3.md`
  (the complete lifecycle for every connected wallet); engineering contract: `ArcPreflight_最终项目方案与开发规格_v1.4.md` (Chinese).
