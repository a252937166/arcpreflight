# Ops

Single small server (CentOS 7, Node 22 at `/usr/local/bin/node`, nginx, certbot). The API is one Node process behind
nginx; the web app is static files. Nothing else is required (SQLite via `node:sqlite`).

## First-time setup (done once, by hand)

```
/opt/arcpreflight/
  dist/server.mjs         # esbuild bundle (ops/deploy.sh)
  fixtures/               # adapters.json + deployments-<net>.json
  evidence/               # published evidence (never evidence/private)
  keys/*.json             # project keys, 600 (merchant-payto, demo-runner, order-creator; deployer-admin stays OFF the server)
  data/                   # SQLite
  arcpreflight.env        # EnvironmentFile for systemd, 600 (see .env.example + apps/api/src/config.ts)
/var/www/arcpreflight/    # apps/web/dist
/etc/nginx/conf.d/arcpreflight.conf   # ops/nginx-arcpreflight.conf
/etc/systemd/system/arcpreflight.service
```

Certificate: `certbot certonly --webroot -w /var/www/letsencrypt -d arcpreflight.axiqo.xyz` after the port-80 server
block is live; certbot's timer renews it.

Required env (testnet or mainnet): `ARC_NET`, `PORT`, `PROFILE`, `RELEASE_SHA`, `ARCPREFLIGHT_ROOT`, `KEYS_DIR`, `DB_PATH`,
`PRINCIPAL_TOKENS` (`principal:token,…`; `demo-runner` must be present for live demo runs), `ADMIN_TOKEN`, `SUPPORTED_TARGETS`
(the DemoMerchant proxies), `PUBLIC_BASE_URL`, optional `DEMO_MAX_RUNS_PER_DAY`, `DEMO_CLIENT_COOLDOWN_SECONDS`, `PIN_LAG`,
`RECOVERY_INTERVAL_MS` (recovery worker, default 30000), `SESSIONS_PER_CLIENT_PER_DAY` (anonymous visitor sessions, default 10),
`FUNDS_CHECK_INTERVAL_MS` (the low-balance watch, default 300000; reads only) and `FUNDS_WARN_DEMO_RUNNER_ATOMIC`,
`FUNDS_WARN_ORDER_CREATOR_ATOMIC`, `FUNDS_WARN_MERCHANT_PAYTO_ATOMIC`, `FUNDS_WARN_DEPLOYER_ADMIN_ATOMIC` (warning thresholds in
18-decimal native USDC; defaults 1, 2, 0.5 and 0.1 USDC — the log says `FUNDS LOW …` once when a key drops below, `/v1/network.funds`
and the Evidence page show it; nothing is claimed or moved automatically),
testnet instance only: `FAUCET_ENABLED` (default on; the faucet is refused on any chain other than 5042002), `FAUCET_AMOUNT_ATOMIC`,
`FAUCET_PER_DAY`, `FAUCET_FLOOR_ATOMIC` — keep the order-creator key topped up on testnet (it sends the faucet claims);
`MAINNET_VERIFIED=1` (set only after the mainnet acceptance evidence
exists; flips the capability labels to `MAINNET_VERIFIED`). The API refuses to start order creation with the owner key
silently: without `keys/order-creator.json` it falls back to deployer-admin with a start-up warning and
`adminKeyInProcess = true` in `/v1/network` — the mainnet acceptance runner refuses that configuration.

## Each release

The public **testnet preview** (root instance on Arc testnet, before the mainnet cutover) is redeployed with
`PREVIEW_GO=1 ops/testnet-preview.sh`: it installs the env derived from `keys/env.server-testnet` at the root (port 4040, a
fresh database), puts the order-creator key on the server, removes the owner key from it, runs `ops/deploy.sh`, approves the
baselines and prints the checks. The mainnet cutover stays `ops/mainnet-cutover.sh`.

`ops/deploy.sh` builds API + web, rsyncs, bumps `RELEASE_SHA`, restarts the service and checks `/health/live`.
After a fresh database, approve the baselines against the server:

```
ARC_NET=<net> API_URL=https://arcpreflight.axiqo.xyz ADMIN_TOKEN=… pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
ARC_NET=<net> API_URL=https://arcpreflight.axiqo.xyz ADMIN_TOKEN=… pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation <implA>
```

Switching the live site from testnet to mainnet = new `deployments-mainnet.json` (scripts/demo/deploy.ts after the
explicit go-ahead), `ARC_NET=mainnet`, `DB_PATH`, `SUPPORTED_TARGETS`, then baselines again.

Acceptance after a cutover (each step after its own typed go, `ops/mainnet-cutover.sh <step>`): `acceptance` (3 × 3 runner
runs, admission replay, role inspection, passports verified) and `lifecycle` (design v3.3: a wallet attempt with a
project-owned visitor key and the Live Demo's labelled interruption, passports verified by the CLI in a clean process). The
same `scripts/selftest/lifecycle.ts` runs against the testnet instance without a go (`ARC_NET=testnet API_URL=… WALLET_KEY_FILE=…`).
`MAINNET_VERIFIED=1` is set only after both have passed on mainnet — together with `PUBLIC_EXECUTION=1` (cutover step `open`):
on mainnet, public business execution (live runs, wallet attempts) is gated with `503 EXECUTION_GATED` until then; the
acceptance scripts pass the gate with `ADMIN_TOKEN` (sent as `x-admin-token`). Testnet defaults to open.

## Dual network: mainnet at the root, testnet under `/testnet`

Two instances of the same bundle run behind one nginx (design v3.2 P2): the root API (`arcpreflight.service`,
`/opt/arcpreflight/arcpreflight.env`, port 4040, Arc mainnet after the cutover) and the testnet instance
(`arcpreflight-testnet.service`, `/opt/arcpreflight/arcpreflight-testnet.env`, port 4041, `PUBLIC_BASE_URL=https://arcpreflight.axiqo.xyz/testnet`,
its own `data/arcpreflight-testnet.sqlite`, `SUPPORTED_TARGETS` = the redeployed testnet proxies). nginx maps `location /testnet/` to
`http://127.0.0.1:4041/` (the trailing slash strips the prefix, so `/testnet/v1/…`, `/testnet/health/…` and `/testnet/openapi.json`
reach the testnet instance unchanged). The web app is one static bundle: its network switch only changes the API base path
(`""` or `/testnet`), the explorer, the wallet chain it asks for, and the per-network local storage. Judges can inspect mainnet
proof at the root and run zero-cost demos on testnet. `ops/deploy.sh` restarts and health-checks both instances;
`ops/mainnet-cutover.sh server` installs the testnet unit, env and nginx location. Both instances load the same key files
(the same addresses on both chains): the single-sender rule holds per network because nonces are per chain, but never run a
maintenance script against a network while that network's instance is executing a run. Memory: each instance is capped at 200 MB
(`MemoryLimit`); check `free -m` on the 728 MB server before enabling the second unit.

## Mainnet cutover (Gate D) — `ops/mainnet-cutover.sh`

The plan, budget and stop conditions are in `docs/MAINNET-PLAN.md`. `preflight` and `gatecheck` are read-only; every other step needs
`export CUTOVER_GO=<step>` after the operator's typed go, and the scripts it calls refuse mainnet execution without `MAINNET_GO=1`.

- **Order:** `preflight` → `deploy` → `fund` → `probe` → commit `fixtures/deployments-mainnet.json` → `server` → `baselines` →
  `gatecheck` → `acceptance` → `lifecycle` → record the evidence → `open` (separate approval).
- **Spend limits:** `scripts/demo/deploy.ts`, `scripts/demo/fund.ts`, `scripts/selftest/relay-probe.ts` and the lifecycle's visitor key
  sign through the spend guard (`packages/client/src/spend.ts`): an explicit gas limit and max fee per transaction, a per-transaction
  cap and a step total that both count value, token amounts and the gas worst case, a 40 gwei max-fee ceiling, and a ledger per network
  and step in `evidence/spend/` so a re-run continues the same total. API-driven spends (acceptance, lifecycle) stop on the measured
  outflow of the project keys; the server enforces its own per-transaction gas ceilings (createOrder 0.006, relay 0.005, pay via the
  policy 0.002 USDC) and daily reservations. Overrides: `DEPLOY_* / FUND_* / PROBE_*_PER_TX_CAP_USDC`, `…_TOTAL_CAP_USDC`,
  `MAX_FEE_GWEI`, `SPEND_CAP_USDC`, `WALLET_*_CAP_USDC`, `LIFECYCLE_PROJECT_CAP_USDC` — each refused above a hard maximum.
- **The gate:** the mainnet env is written with `PUBLIC_EXECUTION=0`; `server` verifies it after the restart (and the release, the order
  signer, the deployer key's absence, and that visitor probes of `/v1/demo/run`, `/v1/demo/orders`, `/v1/wallet/attempts` answer
  503) and stops the mainnet service if anything is off. Acceptance and lifecycle pass the closed gate with `ADMIN_TOKEN`.
- **Release label:** `ops/deploy.sh` labels the bundle with the last commit that changed `apps`, `packages` or the workspace files and
  refuses uncommitted changes there or in `fixtures/`.
- **Real-wallet evidence:** `ops/wallet-evidence.sh <address> [since]` copies a read-only query to the server and saves what the API
  recorded for that wallet to `evidence/selftest/wallet-acceptance-<ts>.json`.
- **Deployment journal (review 2026-10-10):** `scripts/demo/deploy.ts` writes `evidence/deploy-<net>-journal.json` before every broadcast and
  after every receipt; re-running `--execute` after an interruption reconciles the journal against the chain and continues with the
  unfinished steps only. Testnet rehearsal hooks: `DEPLOY_OUT_DIR` (keeps the journal, manifest and evidence out of `fixtures/`),
  `DEPLOY_STOP_AFTER=<step>` (exit after that step's confirmation), `DEPLOY_STOP_AFTER_SEND=<step>` (exit after its broadcast); refused on mainnet.
- **Evidence route containment (2026-10-10):** `/etc/nginx/conf.d/arcpreflight.conf` carried `location ^~ /v1/evidence/ { return 404; }` from 06:18Z
  (the audit's API-01) until 07:27Z, when release `40c5858` with `apps/api/src/evidence.ts` was live and the checks had passed at the API port
  (encoded absolute, double-slash, traversal, nested `private/` paths → 404; a manifest file → 200); the line was removed, `nginx -t`, reload, and
  the checks repeated through the public host (`evidence/preflight/evidence-route-live-check-2026-10-10T07-27Z.txt`). The repository's
  `ops/nginx-arcpreflight.conf` never carried the line; backups `arcpreflight.conf.bak-evidence-20261010T061822Z` and
  `arcpreflight.conf.bak-uncontain-20261010T072714Z` stay on the server.
- **Plan ledger:** `evidence/spend/<net>-plan-<id>.json` (`PLAN_ID`; mainnet defaults to `gate-d-mainnet-2026-10`, testnet has none unless set)
  carries every step's settled outflow, pending commitments and first baseline across restarts, with the approved caps pinned; environment
  cap overrides may lower, never raise. `pnpm exec tsx scripts/lib/plan-status.ts` prints it (read-only; part of `preflight`).
- **Lifecycle restart (found in the `40c5858` rehearsal, fixed in `00f9eb0`, 2026-10-10):** every scenario `scripts/selftest/lifecycle.ts` starts is open in the plan record
  under an id that carries its durable identity — `interrupt-<stamp>:key:<admission key>` (written before the POST) and `wallet-<stamp>` with
  `:order:`, `:attempt:` and `:tx:` appended as the scenario learns them. A re-run under the same `PLAN_ID` (on mainnet: the same
  `ops/mainnet-cutover.sh lifecycle`) settles the open scenarios of previous invocations before it starts anything: the interruption scenario by
  re-sending its admission key (the server returns the original run, which is followed to its outcome and verified; the scenario then counts as
  complete under the plan and is not started again), the wallet scenario from its hash (receipt awaited) or its attempt (nothing of the project's
  left in flight), or from the balances once the server's receipt deadlines are past (10 minutes). A record without identities (written before
  this version) stops the run until `LIFECYCLE_SETTLE_OPEN=<open id>` names it after a manual check of the server's state. `--preflight` shows
  the same decisions read-only. Rehearsal hook `LIFECYCLE_STOP_AFTER=interrupt-start|wallet-order|wallet-attempt|wallet-sent` (testnet only)
  stops right after that checkpoint's durable write, the way an interrupted process would.

## Delayed chain RPC (acceptance row S12, testnet only)

- `ops/rpc-delay-proxy.mjs`: a JSON-RPC proxy that delays chosen methods (`DELAY_<METHOD>_MS`) and answers receipts `null` for a while
  after a transaction is first seen (`HOLD_RECEIPT_MS`; `HOLD_SELECTOR=0x8609cad1 HOLD_SELECTOR_MS=…` holds only the DemoMerchant pay
  call). Every answer that is not held is the upstream's. It refuses Arc mainnet. Run it locally and point a wallet extension's custom
  RPC URL at it to delay the wallet's chain RPC.
- `ops/rpc-delay-session.sh on|off|status`: routes the public testnet instance's own RPC through the proxy on the server
  (`ARC_RPC_URL=http://127.0.0.1:8549`, `PUBLIC_RPC_URL` keeps clients on the public RPC) and restores it afterwards.

## Keys on the server (release target)

The current testnet preview keeps all three project keys in `/opt/arcpreflight/keys/`. The release target is for the
publicly reachable API process to hold only the runner and merchant keys plus a narrowly scoped order-creator key
(order creation only); the deployer-admin key (upgrade, pause, withdraw) stays on an operator machine and is used from
an independent maintenance process. The evidence index records when the redeployed fixtures exist.

## Single sender: one process per relayer address

The merchant account relays check-fee settlements and the runner signs business transactions. Their nonces are
serialised by an in-process lock only, so:

- exactly one active sending process per relayer address — never run two API instances, or an API and a maintenance
  script (for example `scripts/selftest/relay-probe.ts`), against the same key on the same network at the same time;
- no overlapping old and new senders during a deployment: stop the old process, let start-up reconciliation of
  unresolved payments finish in the new one, then accept new sends;
- transaction and nonce state are durable in the SQLite database — never delete or replace `data/` while payments are
  unresolved;
- no concurrent manual transactions from the same account (hardware wallet, CLI, explorer) — this includes
  `examples/merchant-agent`, which uses the demo-runner and order-creator keys: never run it against the same network
  while the API is executing a run;
- read routes never send: broadcasts come only from start-up reconciliation, the recovery worker, `POST /v1/preflight`,
  the `POST /v1/demo/run` gate and the two authorized recovery commands. After a deployment, watch the `SETTLEMENT` /
  `EXECUTION` log lines of the first worker ticks before announcing the release.
