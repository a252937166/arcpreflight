#!/usr/bin/env bash
# Mainnet cutover (design v3.2 Gate D). Each step runs ONLY after the explicit typed go-ahead for it; nothing here is automatic.
# Steps (run one at a time: ops/mainnet-cutover.sh <step>):
#   balances   read-only: project balances on 5042 and the public API's current network
#   deploy     deployer-admin sends 4 deployments + 2 setOrderCreator + 1 upgrade on Arc mainnet (gas only)
#   server     switch the server to mainnet: order-creator key on, deployer-admin key OFF the server, env, release bundle, health
#   baselines  approve MAIN (live A) and CHANGED (pinned to A) against the server (admin route; no chain spend)
#   acceptance scripts/selftest/mainnet.ts --execute: 3 x 3 runs, admission replay, role inspection, passport export + verification
#   lifecycle  scripts/selftest/lifecycle.ts on mainnet (design v3.3): the wallet scenario with a project-owned "visitor" key
#              (WALLET_KEY_FILE, funded by hand first) and the Live Demo's labelled interruption; passports verified by the CLI
#   open       PUBLIC_EXECUTION=1 + MAINNET_VERIFIED=1 on the server: public business execution opens and labels flip to
#              MAINNET_VERIFIED — only after acceptance and lifecycle passed and their evidence is recorded in docs/
# Spend (worst case, project funds moving between project-owned addresses only):
#   deploy      deployer-admin gas, ceiling 0.15 USDC
#   acceptance  demo-runner 9 x 0.01 USDC check fees + 3 x 0.05 USDC business payments + pay gas; order-creator createOrder gas;
#               merchant-payto relay gas (received fees exceed it). Hard cap in the runner: SPEND_CAP_USDC (fee + business), default 0.5
#   lifecycle   visitor key: 0.01 USDC fee + WALLET_AMOUNT_ATOMIC (default 0.005 USDC) + pay gas; demo-runner 0.01 + 0.05 + gas;
#               order-creator 2 x createOrder gas; merchant-payto relay gas
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
API="${API:-https://arcpreflight.axiqo.xyz}"
ENV_LOCAL=keys/env.server
RPC=https://rpc.mainnet.arc.io
export ARC_NET=mainnet
step="${1:-}"
addr() { python3 -c "import json;print(json.load(open('keys/$1.json'))['address'])"; }
bal() { curl -s "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$1\",\"latest\"]}" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16)/1e18)'; }
require_go() { [ "${CUTOVER_GO:-}" = "$1" ] || { echo "refusing: export CUTOVER_GO=$1 only after the typed go-ahead for step '$1'"; exit 1; }; }

case "$step" in
  balances)
    echo "== native USDC (18-dec) on Arc mainnet"
    for role in deployer-admin order-creator demo-runner merchant-payto; do A=$(addr "$role"); echo "$role $A $(bal "$A")"; done
    echo "== public API"; curl -s "$API/health/live"; echo
    ;;
  deploy)
    require_go deploy
    A=$(addr deployer-admin); B=$(bal "$A"); echo "deployer-admin $A $B USDC"
    python3 -c "import sys; sys.exit(0 if float('$B') >= 0.3 else 1)" || { echo "deployer-admin below 0.3 USDC"; exit 1; }
    [ ! -f fixtures/deployments-mainnet.json ] || { echo "fixtures/deployments-mainnet.json exists; refusing to redeploy over it"; exit 1; }
    echo "== deploy fixtures on Arc mainnet (4 deployments, 2 setOrderCreator, 1 upgrade)"; pnpm exec tsx scripts/demo/deploy.ts
    ;;
  server)
    require_go server
    [ -f fixtures/deployments-mainnet.json ] || { echo "no mainnet deployments yet"; exit 1; }
    MAIN=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["MAIN"]["address"])')
    CH=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["CHANGED"]["address"])')
    echo "== server env -> mainnet (fresh database path; new SUPPORTED_TARGETS; recovery worker; labels stay IMPLEMENTED_TESTNET until the acceptance evidence exists)"
    sed -i '' -e 's/^ARC_NET=.*/ARC_NET=mainnet/' -e 's#^DB_PATH=.*#DB_PATH=/opt/arcpreflight/data/arcpreflight-mainnet.sqlite#' -e "s/^SUPPORTED_TARGETS=.*/SUPPORTED_TARGETS=$MAIN,$CH/" "$ENV_LOCAL"
    grep -q '^RECOVERY_INTERVAL_MS=' "$ENV_LOCAL" || echo 'RECOVERY_INTERVAL_MS=30000' >> "$ENV_LOCAL"
    sed -i '' -e '/^MAINNET_VERIFIED=/d' "$ENV_LOCAL"
    echo "== keys: order-creator ON the server, deployer-admin OFF the server (single sender: the old process is stopped first)"
    ssh "$HOST" "systemctl stop arcpreflight"
    scp -q keys/order-creator.json "$HOST:/opt/arcpreflight/keys/order-creator.json"
    ssh "$HOST" "chmod 600 /opt/arcpreflight/keys/order-creator.json && rm -f /opt/arcpreflight/keys/deployer-admin.json && ls -l /opt/arcpreflight/keys/"
    scp -q "$ENV_LOCAL" "$HOST:/opt/arcpreflight/arcpreflight.env"
    echo "== testnet instance under /testnet (dual network): own env + database, same bundle, nginx location, systemd unit"
    [ -f keys/env.server-testnet ] || { echo "keys/env.server-testnet missing (ops/README.md: dual network)"; exit 1; }
    scp -q keys/env.server-testnet "$HOST:/opt/arcpreflight/arcpreflight-testnet.env"
    scp -q ops/arcpreflight-testnet.service "$HOST:/etc/systemd/system/arcpreflight-testnet.service"
    scp -q ops/nginx-arcpreflight.conf "$HOST:/etc/nginx/conf.d/arcpreflight.conf"
    ssh "$HOST" "chmod 600 /opt/arcpreflight/arcpreflight-testnet.env && systemctl daemon-reload && free -m | head -2"
    echo "== release bundle (restarts the root instance and the testnet instance)"; ops/deploy.sh "$HOST"
    curl -s "$API/testnet/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("testnet instance:",d["caip2"],"release",d["release"],"fixtures",[(f["id"],(f["baselineDigest"] or "none")[:10]) for f in d["fixtures"]])' || echo "testnet instance not answering yet"
    curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);a=d["accounts"];print("network",d["caip2"],"release",d["release"],"orderSignerRole",a["orderSignerRole"],"adminKeyInProcess",a["adminKeyInProcess"],"orderCreator",a["orderCreator"])'
    ;;
  baselines)
    require_go baselines
    IMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["implA"]["address"])')
    AT=$(grep '^ADMIN_TOKEN=' "$ENV_LOCAL" | cut -d= -f2)
    API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
    API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$IMPLA"
    echo "== testnet instance: approve the (redeployed) testnet fixtures' baselines under /testnet (no chain spend)"
    TIMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-testnet.json"))["implA"]["address"])')
    TAT=$(grep '^ADMIN_TOKEN=' keys/env.server-testnet | cut -d= -f2)
    ARC_NET=testnet API_URL=$API/testnet ADMIN_TOKEN=$TAT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
    ARC_NET=testnet API_URL=$API/testnet ADMIN_TOKEN=$TAT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$TIMPLA"
    curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("network",d["caip2"],"release",d["release"],[(f["id"],(f["baselineDigest"] or "")[:10]) for f in d["fixtures"]])'
    ;;
  acceptance)
    require_go acceptance
    REL=$(curl -s "$API/health/live" | python3 -c 'import sys,json;print(json.load(sys.stdin)["release"])')
    AT=$(grep '^ADMIN_TOKEN=' "$ENV_LOCAL" | cut -d= -f2) # the mainnet instance gates public execution (PUBLIC_EXECUTION unset = off): the acceptance passes the gate with the admin token
    echo "== dry run first (nothing started)"; API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/selftest/mainnet.ts
    echo "== execute: 3 rounds x 3 fixtures, admission replay, on-chain role inspection, passport export + independent verification"
    API_URL=$API ADMIN_TOKEN=$AT EXPECTED_RELEASE=$REL pnpm exec tsx scripts/selftest/mainnet.ts --execute
    ;;
  lifecycle)
    require_go lifecycle
    [ -n "${WALLET_KEY_FILE:-}" ] && [ -f "$WALLET_KEY_FILE" ] || { echo "WALLET_KEY_FILE (a project-owned, hand-funded visitor key; never a user's key) is required"; exit 1; }
    echo "== dry: the API must report wallet execution and the mainnet network"; curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["chainId"]==5042 and d["access"]["walletExecution"] is True, d.get("access");print("network",d["caip2"],"release",d["release"],"walletExecution",d["access"]["walletExecution"])'
    echo "== execute: wallet scenario + labelled interruption, passports verified by the CLI"
    AT=$(grep '^ADMIN_TOKEN=' "$ENV_LOCAL" | cut -d= -f2)
    MAINNET_GO=1 API_URL=$API ADMIN_TOKEN=$AT WALLET_KEY_FILE=$WALLET_KEY_FILE SCENARIOS="${SCENARIOS:-wallet,interrupt}" pnpm exec tsx scripts/selftest/lifecycle.ts
    ;;
  open)
    require_go open
    echo "== open public business execution on mainnet and flip the capability labels (only after acceptance + lifecycle passed and their evidence is recorded)"
    grep -q '^PUBLIC_EXECUTION=' "$ENV_LOCAL" && sed -i '' -e 's/^PUBLIC_EXECUTION=.*/PUBLIC_EXECUTION=1/' "$ENV_LOCAL" || echo 'PUBLIC_EXECUTION=1' >> "$ENV_LOCAL"
    grep -q '^MAINNET_VERIFIED=' "$ENV_LOCAL" && sed -i '' -e 's/^MAINNET_VERIFIED=.*/MAINNET_VERIFIED=1/' "$ENV_LOCAL" || echo 'MAINNET_VERIFIED=1' >> "$ENV_LOCAL"
    scp -q "$ENV_LOCAL" "$HOST:/opt/arcpreflight/arcpreflight.env"; ssh "$HOST" "systemctl restart arcpreflight"; sleep 3
    curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("access",d["access"]);print([c["id"]+":"+c["status"] for c in d["capabilities"] if c["id"] in ("wallet-execution","business-execution-recovery")])'
    ;;
  *) echo "usage: ops/mainnet-cutover.sh balances|deploy|server|baselines|acceptance|lifecycle|open   (each step after its own typed go; export CUTOVER_GO=<step>)"; exit 2;;
esac
