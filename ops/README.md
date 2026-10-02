# Ops

Single small server (CentOS 7, Node 22 at `/usr/local/bin/node`, nginx, certbot). The API is one Node process behind
nginx; the web app is static files. Nothing else is required (SQLite via `node:sqlite`).

## First-time setup (done once, by hand)

```
/opt/arcpreflight/
  dist/server.mjs         # esbuild bundle (ops/deploy.sh)
  fixtures/               # adapters.json + deployments-<net>.json
  evidence/               # published evidence (never evidence/private)
  keys/*.json             # project keys, 600 (deployer-admin, merchant-payto, demo-runner)
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
(the DemoMerchant proxies), `PUBLIC_BASE_URL`, optional `DEMO_MAX_RUNS_PER_DAY`, `DEMO_CLIENT_COOLDOWN_SECONDS`, `PIN_LAG`.

## Each release

`ops/deploy.sh` builds API + web, rsyncs, bumps `RELEASE_SHA`, restarts the service and checks `/health/live`.
After a fresh database, approve the baselines against the server:

```
ARC_NET=<net> API_URL=https://arcpreflight.axiqo.xyz ADMIN_TOKEN=… pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
ARC_NET=<net> API_URL=https://arcpreflight.axiqo.xyz ADMIN_TOKEN=… pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation <implA>
```

Switching the live site from testnet to mainnet = new `deployments-mainnet.json` (scripts/demo/deploy.ts after the
explicit go-ahead), `ARC_NET=mainnet`, `DB_PATH`, `SUPPORTED_TARGETS`, then baselines again.
