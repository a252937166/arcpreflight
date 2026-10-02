#!/usr/bin/env bash
# Mainnet cutover, run ONLY after the explicit go-ahead (spec v1.4 §17). Spends from the project keys:
#   deployer-admin: 4 contract deployments + 1 upgrade + createOrder per demo run (gas only, cents)
#   demo-runner:    0.01 USDC service fee + 0.05 USDC business payment + gas per demo run (both to project-owned addresses)
# Steps: (1) balance floor check (2) deploy fixtures on 5042 (3) switch the server env to mainnet (4) deploy release
#        (5) approve baselines against the server (6) three live runs through the public endpoint.
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
API=https://arcpreflight.axiqo.xyz
ENV_LOCAL=keys/env.server
need() { [ -n "${!1:-}" ] || { echo "missing $1"; exit 1; }; }
export ARC_NET=mainnet
echo "== balances (native USDC, 18-dec)"
for role in deployer-admin demo-runner merchant-payto; do
  A=$(python3 -c "import json;print(json.load(open('keys/$role.json'))['address'])")
  B=$(curl -s https://rpc.mainnet.arc.io -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$A\",\"latest\"]}" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16)/1e18)')
  echo "$role $A $B"
done
read -r -p "deployer >= 0.5 and runner >= 1 USDC? type GO to continue: " ok; [ "$ok" = "GO" ] || exit 1
echo "== deploy fixtures on Arc mainnet"; pnpm exec tsx scripts/demo/deploy.ts
MAIN=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["MAIN"]["address"])')
CH=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["CHANGED"]["address"])')
IMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["implA"]["address"])')
echo "== switch server env to mainnet"
sed -i '' -e 's/^ARC_NET=.*/ARC_NET=mainnet/' -e 's#^DB_PATH=.*#DB_PATH=/opt/arcpreflight/data/arcpreflight-mainnet.sqlite#' -e "s/^SUPPORTED_TARGETS=.*/SUPPORTED_TARGETS=$MAIN,$CH/" "$ENV_LOCAL"
scp -q "$ENV_LOCAL" "$HOST:/opt/arcpreflight/arcpreflight.env"
echo "== deploy release"; ops/deploy.sh "$HOST"
AT=$(grep '^ADMIN_TOKEN=' "$ENV_LOCAL" | cut -d= -f2)
echo "== approve baselines on the server"
API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$IMPLA"
curl -s $API/v1/network | python3 -c 'import sys,json;d=json.load(sys.stdin);print("network",d["caip2"],"release",d["release"],[(f["id"],(f["baselineDigest"] or "")[:10]) for f in d["fixtures"]])'
echo "== three live runs (DEMO_ON_MAINNET)"
for F in CHANGED_IMPLEMENTATION AMOUNT_UNIT_MISMATCH APPROVED_PAYMENT; do
  ID=$(curl -s -X POST $API/v1/demo/run -H 'content-type: application/json' -d "{\"fixture\":\"$F\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("runId",""))')
  echo "$F run=$ID"; [ -z "$ID" ] && { sleep 50; continue; }
  for i in $(seq 1 60); do sleep 3; ST=$(curl -s $API/v1/demo/runs/$ID | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])'); case "$ST" in DONE|FAILED) break;; esac; done
  curl -s $API/v1/demo/runs/$ID | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result");print(" ",d["state"],r and r["decision"]["decision"],r and r["execution"]["businessTxHash"],r and r["serviceFeeTx"],r and r["durationMs"])'
  sleep 48
done
echo "done: $API"
