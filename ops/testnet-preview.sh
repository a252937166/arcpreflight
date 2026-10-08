#!/usr/bin/env bash
# Redeploy the PUBLIC TESTNET PREVIEW (root instance, Arc testnet 5042002) on the current commit — review round 2, item 10.
# Not the mainnet cutover (ops/mainnet-cutover.sh): the root stays on testnet with the fixtures redeployed on 2026-10-07
# (orderCreator role), the order-creator key goes ON the server and the deployer-admin (owner) key comes OFF it.
# Steps: env (derived from keys/env.server-testnet, port 4040, root base URL, fresh database) → keys → ops/deploy.sh → baselines → checks.
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
API="${API:-https://arcpreflight.axiqo.xyz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
[ "${PREVIEW_GO:-}" = "1" ] || { echo "refusing: export PREVIEW_GO=1 to redeploy the public testnet preview"; exit 1; }
[ -f keys/env.server-testnet ] || { echo "keys/env.server-testnet missing"; exit 1; }
[ -f keys/order-creator.json ] || { echo "keys/order-creator.json missing"; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ENV_PREVIEW=$(mktemp "${TMPDIR:-/tmp}/arcpf-preview-env.XXXXXX")
# the testnet instance env, re-homed at the root: port 4040, the public base URL without /testnet, its own fresh database
sed -e 's/^PORT=.*/PORT=4040/' -e "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$API#" -e 's#^DB_PATH=.*#DB_PATH=/opt/arcpreflight/data/arcpreflight-testnet-v33.sqlite#' keys/env.server-testnet > "$ENV_PREVIEW"
grep -q '^RECOVERY_INTERVAL_MS=' "$ENV_PREVIEW" || echo 'RECOVERY_INTERVAL_MS=30000' >> "$ENV_PREVIEW"
grep -q '^ARC_NET=testnet' "$ENV_PREVIEW" || { echo "the preview env must be ARC_NET=testnet"; exit 1; }
echo "== server: back up the old env, install the preview env, order-creator ON, deployer-admin OFF (the instance is stopped first: single sender)"
ssh "$HOST" "systemctl stop arcpreflight; cp /opt/arcpreflight/arcpreflight.env /opt/arcpreflight/arcpreflight.env.bak-$STAMP"
scp -q "$ENV_PREVIEW" "$HOST:/opt/arcpreflight/arcpreflight.env"; rm -f "$ENV_PREVIEW"
scp -q keys/order-creator.json "$HOST:/opt/arcpreflight/keys/order-creator.json"
ssh "$HOST" "chmod 600 /opt/arcpreflight/arcpreflight.env /opt/arcpreflight/keys/order-creator.json && rm -f /opt/arcpreflight/keys/deployer-admin.json && ls -l /opt/arcpreflight/keys/"
echo "== release bundle"; ops/deploy.sh "$HOST"
echo "== baselines on the fresh database (admin route; no chain spend)"
IMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-testnet.json"))["implA"]["address"])')
AT=$(grep '^ADMIN_TOKEN=' keys/env.server-testnet | cut -d= -f2)
ARC_NET=testnet API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
ARC_NET=testnet API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$IMPLA"
echo "== checks"; curl -s "$API/health/live"; echo
curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);a=d["accounts"];print("network",d["caip2"],"release",d["release"],"orderSignerRole",a["orderSignerRole"],"adminKeyInProcess",a["adminKeyInProcess"],"access",d["access"],"faucet",d["faucet"].get("enabled"),"fixtures",[(f["id"],(f["baselineDigest"] or "none")[:10]) for f in d["fixtures"]])'
