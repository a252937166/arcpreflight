# ArcPreflight

**Preflight for agent payments on Arc.** An agent is about to pay a contract with USDC on Arc. ArcPreflight sells it a
block-pinned report of what that contract *is right now* — resolved implementation, approved-baseline comparison,
supported-state reads, an exact-call simulation and Arc-specific rule advisories — over x402, settled by the Circle
Facilitator on Arc. The agent then decides deterministically in its own process, re-validates at a fresh block, signs
exactly the validated plan, broadcasts, and proves the business outcome.

Live: **https://arcpreflight.axiqo.xyz** · API: `/openapi.json` · Submission: Arc Microgrants (DoraHacks)

## Three outcomes, one code path

| Fixture | What happens | Outcome |
|---|---|---|
| `CHANGED_IMPLEMENTATION` | the merchant proxy was approved on implementation A and silently upgraded to B; same ABI, same calldata, same price | **REVIEW_REQUIRED** — nothing is signed until a human re-approves |
| `AMOUNT_UNIT_MISMATCH` | order is 0.05 USDC; calldata carries `value = 50000` (6-dec units on the 18-dec native path) | **BLOCKED** — `AMOUNT_SEMANTICS` fires, and the pinned simulation decodes `WrongAmount(...)` |
| `APPROVED_PAYMENT` | baseline matches, order payable, simulation passes | **NO_POLICY_VIOLATION** → final validation → signed plan → broadcast → order reads as paid |

Every run on the live site is persisted with its receipt chain (`intentDigest → reportDigest → decisionDigest →
finalValidationDigest → transactionPlanDigest → executionDigest`) and labelled `LIVE_REQUEST` / `DEMO_ON_MAINNET` /
`RECORDED_SAMPLE`. `NO_POLICY_VIOLATION` means *no configured check fired at the pinned block* — never "safe".

## What it uses Arc for

- **USDC is the gas, with two faces.** Native USDC has 18 decimals; the ERC-20 interface at `0x3600…0000` has 6, one
  balance behind both. `AMOUNT_SEMANTICS` compares the exact candidate call with an independently approved business
  expectation and catches the 10¹² mistake before a signature exists.
- **Block-hash-pinned reads.** Every fact is read with EIP-1898 pinning on Arc's public RPC (`PIN_LAG` blocks behind
  head because the endpoint is load-balanced), verified by number, and digested as raw evidence.
- **x402 on Arc via the Circle Facilitator.** The report is bought with one EIP-3009 `TransferWithAuthorization`
  (USDC EIP-712 domain `USDC`/`2`, verified against the on-chain `DOMAIN_SEPARATOR`), settled through
  `api.circle.com/v1/facilitator/x402` with a seller proof. No allowance, no gas for the buyer.
- **Circle's own proxies as subjects.** GatewayWallet, FxEscrow, the ERC-8004 registries and CCTP on Arc mainnet are
  ERC-1967 proxies; the observer reads their slots raw and only then matches a verified template.
- **Arc runtime advisories** (`basis: network_advisory`): 20 gwei fee floor, value-transfer rules, `PREVRANDAO = 0`,
  SELFDESTRUCT semantics, non-strict timestamps — documentation-backed rules, never claims about the target.

## Repository

```
packages/schema     zod contracts (schemaVersion 1.0), canonical JSON + keccak digests
packages/observer   pinned snapshot, raw reads, ERC-1967 template adapter, RPC evidence
packages/policy     deterministic checks: INTENT_BINDING, AMOUNT_SEMANTICS, allowlists, BASELINE_STATUS, EXECUTION_IDENTITY, CALL_SIMULATION, EVIDENCE_FRESHNESS
packages/client     EIP-3009 buyer signing, Facilitator seller proof + settle/status client
packages/runner     the full loop as a library (used by the API's live demo and the CLI example)
packages/contracts  DemoMerchant V1/V2 (UUPS) + Foundry tests
apps/api            x402 seller API (quote → settle → deliver → recover), object observation, demo endpoints, evidence
apps/web            the site (Vite + React): overview, live demo, inspect, developer console (EIP-1193 wallet), evidence
scripts/demo        deploy fixtures, approve baselines; examples/merchant-agent is the CLI runner
```

Release profile `SUBMISSION_RESTRICTED`: external paid access is closed (configured principals only), wallet-popup
execution, the USDC-transfer intent path and SCA buyers are off — each a deferred feature whose rejection is tested,
not a hidden gap.

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

Tests: `pnpm -r test` (schema, observer, policy, client) and `forge test` in `packages/contracts`.

## Honesty notes

- Testnet is a rehearsal network; the submission network is Arc mainnet (`eip155:5042`). Reports never mix the two.
- The live demo is driven by the project's own runner against the project's own fixtures; a tester's purchase on the
  developer page is a tester's purchase, not agent adoption.
- Spec of record: `ArcPreflight_最终项目方案与开发规格_v1.4.md` (project notes, Chinese).
