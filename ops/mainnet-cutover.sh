#!/usr/bin/env bash
# Mainnet cutover (Gate D). Each spending or server-changing step runs ONLY after the operator's typed go for that step
# (export CUTOVER_GO=<step>); nothing here is automatic. Public mainnet execution stays CLOSED (PUBLIC_EXECUTION=0) until `open`,
# which is a separate approval after the acceptance evidence is recorded. Steps, in order:
#   preflight  read-only: release, RPC, balances + nonces, fees, server state, the plan ledger, and the read-only preflights of fund / deploy / probe
#              (the deploy preflight also shows the deployment journal and what a restart would do with it)
#   fund       deployer-admin → order-creator + visitor-rehearsal (allow-listed project keys; scripts/demo/fund.ts, guarded)
#   deploy     deployer-admin: 4 deployments + 2 setOrderCreator + 1 upgrade (scripts/demo/deploy.ts, guarded: 0.05/tx, 0.15 total)
#   probe      ONE self-relayed 0.01 USDC check fee on mainnet (scripts/selftest/relay-probe.ts, guarded) — before `server`: single sender
#   server     root → Arc mainnet with PUBLIC_EXECUTION=0 written explicitly; testnet under /testnet (public, its current database);
#              order-creator key on, deployer-admin key off; then verified: network, gate closed (probes 503), keys, release — else the
#              mainnet service is STOPPED and the step fails
#   baselines  approve MAIN (live A) and CHANGED (pinned to A) on the mainnet instance (admin route; no chain spend)
#   gatecheck  read-only: the mainnet instance's gate is closed (publicExecution=false; run / order / attempt probes answer 503)
#   acceptance scripts/selftest/mainnet.ts: dry run, then 3 × 3 runs with the admin token through the closed gate (cap 0.35 incl. gas)
#   lifecycle  scripts/selftest/lifecycle.ts: --preflight, then the wallet scenario (visitor-rehearsal) + the labelled interruption
#              (caps: visitor 0.05, project outflow 0.12) with the admin token through the closed gate
#   open       SEPARATE APPROVAL: PUBLIC_EXECUTION=1 + MAINNET_VERIFIED=1, only when PASS evidence for acceptance and lifecycle exists
#              for the running release
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
API="${API:-https://arcpreflight.axiqo.xyz}"
RPC=https://rpc.mainnet.arc.io
export ARC_NET=mainnet
step="${1:-}"
CODE_PATHS="apps packages package.json pnpm-lock.yaml pnpm-workspace.yaml"
FUND_PLAN_DEFAULT="order-creator:0.10,visitor-rehearsal:0.05"
addr() { python3 -c "import json;print(json.load(open('keys/$1.json'))['address'])"; } # the address field only
rpc() { curl -s -m 20 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
bal() { rpc eth_getBalance "[\"$1\",\"latest\"]" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16)/1e18)'; }
nonce() { rpc eth_getTransactionCount "[\"$1\",\"$2\"]" | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))'; }
require_go() { [ "${CUTOVER_GO:-}" = "$1" ] || { echo "refusing: export CUTOVER_GO=$1 only after the typed go-ahead for step '$1'"; exit 1; }; }
stop() { echo "STOP: $*"; exit 1; }
release() { git log -1 --format=%h -- $CODE_PATHS; }
clean_tree() { git diff --quiet HEAD -- $CODE_PATHS fixtures && [ -z "$(git ls-files --others --exclude-standard -- $CODE_PATHS fixtures)" ]; }
admin_token() { grep '^ADMIN_TOKEN=' keys/env.server | cut -d= -f2; }
# set KEY=VALUE in an env file (replace or append)
set_env() { local f="$1" k="$2" v="$3"; if grep -q "^$k=" "$f"; then python3 - "$f" "$k" "$v" <<'PY'
import sys,re; f,k,v=sys.argv[1:]; s=open(f).read(); s=re.sub(rf"^{re.escape(k)}=.*$", f"{k}={v}", s, flags=re.M); open(f,"w").write(s)
PY
else echo "$k=$v" >> "$f"; fi; }
del_env() { python3 - "$1" "$2" <<'PY'
import sys,re; f,k=sys.argv[1:]; s=open(f).read(); s=re.sub(rf"^{re.escape(k)}=.*\n?", "", s, flags=re.M); open(f,"w").write(s)
PY
}
# the gate of an instance: publicExecution=false, and the three execution routes answer 503 EXECUTION_GATED to a visitor (no admin token).
# Probes carry empty bodies: an open gate would answer 400, so a probe can never start a run, create an order or validate an attempt.
gatecheck() {
  local base="$1" want_chain="${2:-5042}"
  local netjson; netjson=$(curl -s -m 15 "$base/v1/network") || stop "GET $base/v1/network failed"
  echo "$netjson" | python3 -c "
import sys,json; d=json.load(sys.stdin); a=d.get('access',{})
problems=[]
if d.get('chainId')!=$want_chain: problems.append(f\"chainId {d.get('chainId')} != $want_chain\")
if a.get('publicExecution') is not False: problems.append(f\"publicExecution is {a.get('publicExecution')!r}, must be false\")
if a.get('operatorAcceptance') is not True: problems.append(f\"operatorAcceptance is {a.get('operatorAcceptance')!r}\")
print('network', d.get('caip2'), 'release', d.get('release'), 'publicExecution', a.get('publicExecution'), 'operatorAcceptance', a.get('operatorAcceptance'), 'executionReady', a.get('executionReady'))
if problems: print('GATE PROBLEMS: ' + '; '.join(problems)); sys.exit(1)" || return 1
  local token; token=$(curl -s -m 15 -X POST "$base/v1/session" -H 'content-type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
  [ -n "$token" ] || { echo "GATE PROBLEMS: no anonymous session for the probes"; return 1; }
  local p code body bad=0
  for p in /v1/demo/run /v1/demo/orders /v1/wallet/attempts; do
    body=$(curl -s -m 15 -o - -w '\n%{http_code}' -X POST "$base$p" -H 'content-type: application/json' -H "authorization: Bearer $token" -d '{}')
    code=$(echo "$body" | tail -1); err=$(echo "$body" | head -1 | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("error",""))
except Exception: print("")')
    echo "probe POST $p (visitor, no admin token, empty body) → $code $err"
    [ "$code" = "503" ] && [ "$err" = "EXECUTION_GATED" ] || bad=1
  done
  [ $bad = 0 ] || { echo "GATE PROBLEMS: an execution route did not answer 503 EXECUTION_GATED"; return 1; }
  echo "gate closed: only the operator's admin token passes"
}
latest_evidence() { # $1 = kind (acceptance|lifecycle); prints the newest PASS file for the running release, or nothing
  python3 - "$1" "$2" <<'PY'
import sys, json, glob, os
kind, rel = sys.argv[1], sys.argv[2]
files = sorted(glob.glob("evidence/selftest/mainnet-lifecycle-*.json" if kind == "lifecycle" else "evidence/selftest/mainnet-2*.json"), key=os.path.getmtime, reverse=True)
for f in files:
    if f.endswith("-INCOMPLETE.json"): continue
    d = json.load(open(f))
    ok = d.get("release") == rel and (d.get("status") == "PASS" if kind == "acceptance" else bool(d.get("scenarios", {}).get("wallet")) and bool(d.get("scenarios", {}).get("interrupt")))
    if ok: print(f); break
PY
}

case "$step" in
  preflight)
    echo "== release: last commit that changed what runs on the server (code paths: $CODE_PATHS)"
    REL=$(release); echo "release $REL ($(git log -1 --format='%ad %s' --date=iso-strict "$REL" | cut -c1-110))"
    clean_tree && echo "working tree clean in code paths and fixtures" || echo "PROBLEM: uncommitted or untracked changes in code paths or fixtures — commit before any step"
    echo "== Arc mainnet RPC"; echo "chainId $(rpc eth_chainId '[]' | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))') · head $(rpc eth_blockNumber '[]' | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))') · gasPrice $(rpc eth_gasPrice '[]' | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16)/1e9)') gwei"
    echo "== project keys on mainnet (native USDC, 18-dec) · nonce latest/pending"
    for role in deployer-admin order-creator demo-runner merchant-payto visitor-rehearsal; do A=$(addr "$role"); echo "$role $A $(bal "$A") USDC · nonce $(nonce "$A" latest)/$(nonce "$A" pending)"; done
    [ ! -f fixtures/deployments-mainnet.json ] && echo "fixtures/deployments-mainnet.json: absent (nothing deployed by this project yet)" || echo "fixtures/deployments-mainnet.json: PRESENT"
    echo "== server (read-only)"; ssh -o ConnectTimeout=15 "$HOST" "grep -E '^(ARC_NET|PORT|DB_PATH|PUBLIC_EXECUTION|MAINNET_VERIFIED|RELEASE_SHA)=' /opt/arcpreflight/arcpreflight.env; ls /opt/arcpreflight/keys/; ls /opt/arcpreflight/arcpreflight-testnet.env 2>/dev/null || echo 'no testnet instance env yet'"
    echo "== public API now"; curl -s -m 15 "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("network",d["caip2"],"release",d["release"],"access",d.get("access"))'
    echo "== plan ledger (read-only): what every step committed across its invocations, pending, remaining budget"; pnpm exec tsx scripts/lib/plan-status.ts || true
    echo "== fund preflight"; FUND_PLAN="${FUND_PLAN:-$FUND_PLAN_DEFAULT}" pnpm exec tsx scripts/demo/fund.ts || true
    echo "== deploy preflight"; pnpm exec tsx scripts/demo/deploy.ts || true
    echo "== probe preflight (nothing is signed on mainnet in a dry run)"; pnpm exec tsx scripts/selftest/relay-probe.ts || true
    ;;
  fund)
    require_go fund; clean_tree || stop "commit first (code paths / fixtures)"
    FUND_PLAN="${FUND_PLAN:-$FUND_PLAN_DEFAULT}" pnpm exec tsx scripts/demo/fund.ts || stop "fund preflight not ready"
    MAINNET_GO=1 FUND_PLAN="${FUND_PLAN:-$FUND_PLAN_DEFAULT}" pnpm exec tsx scripts/demo/fund.ts --execute
    ;;
  deploy)
    require_go deploy; clean_tree || stop "commit first (code paths / fixtures)"
    [ ! -f fixtures/deployments-mainnet.json ] || stop "fixtures/deployments-mainnet.json exists; refusing to redeploy over it"
    pnpm exec tsx scripts/demo/deploy.ts || stop "deploy preflight not ready"
    MAINNET_GO=1 pnpm exec tsx scripts/demo/deploy.ts --execute
    echo "next: commit fixtures/deployments-mainnet.json and the deploy evidence before the server step (the bundle ships fixtures/)"
    ;;
  probe)
    require_go probe
    pnpm exec tsx scripts/selftest/relay-probe.ts || stop "probe dry run not ready"
    MAINNET_GO=1 pnpm exec tsx scripts/selftest/relay-probe.ts --execute
    ;;
  server)
    require_go server
    [ -f fixtures/deployments-mainnet.json ] || stop "no mainnet deployments yet"
    clean_tree || stop "commit fixtures/deployments-mainnet.json (and any code) first: the bundle must match a commit"
    [ -f keys/env.server ] && [ -f keys/env.server-testnet ] && [ -f keys/order-creator.json ] || stop "keys/env.server, keys/env.server-testnet and keys/order-creator.json are required"
    MAIN=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["MAIN"]["address"])')
    CH=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["proxies"]["CHANGED"]["address"])')
    STAMP=$(date -u +%Y%m%dT%H%M%SZ); MENV=$(mktemp "${TMPDIR:-/tmp}/arcpf-mainnet-env.XXXXXX"); TENV=$(mktemp "${TMPDIR:-/tmp}/arcpf-testnet-env.XXXXXX")
    cp keys/env.server "$MENV"; cp keys/env.server-testnet "$TENV"
    echo "== mainnet env (root, port 4040): PUBLIC_EXECUTION=0 written explicitly; acceptance-sized daily caps; no faucet"
    set_env "$MENV" ARC_NET mainnet; set_env "$MENV" PORT 4040; set_env "$MENV" PUBLIC_BASE_URL "$API"
    set_env "$MENV" DB_PATH /opt/arcpreflight/data/arcpreflight-mainnet.sqlite; set_env "$MENV" SUPPORTED_TARGETS "$MAIN,$CH"
    set_env "$MENV" PUBLIC_EXECUTION 0; del_env "$MENV" MAINNET_VERIFIED; set_env "$MENV" FAUCET_ENABLED 0; set_env "$MENV" RECOVERY_INTERVAL_MS 30000
    set_env "$MENV" DEMO_MAX_RUNS_PER_DAY 14; set_env "$MENV" DEMO_DAILY_BUSINESS_CAP_ATOMIC 250000000000000000
    set_env "$MENV" DEMO_DAILY_FEE_CAP_ATOMIC 150000000000000000; set_env "$MENV" DEMO_DAILY_GAS_CAP_ATOMIC 150000000000000000
    set_env "$MENV" FUNDS_WARN_DEMO_RUNNER_ATOMIC 500000000000000000; set_env "$MENV" FUNDS_WARN_ORDER_CREATOR_ATOMIC 30000000000000000
    set_env "$MENV" FUNDS_WARN_MERCHANT_PAYTO_ATOMIC 100000000000000000; set_env "$MENV" FUNDS_WARN_DEPLOYER_ADMIN_ATOMIC 100000000000000000
    grep -q '^PUBLIC_EXECUTION=0$' "$MENV" || stop "the mainnet env does not say PUBLIC_EXECUTION=0"
    echo "== testnet env (/testnet, port 4041): public, continuing the current public testnet database"
    set_env "$TENV" PORT 4041; set_env "$TENV" PUBLIC_BASE_URL "$API/testnet"; set_env "$TENV" DB_PATH /opt/arcpreflight/data/arcpreflight-testnet-v33.sqlite
    set_env "$TENV" PUBLIC_EXECUTION 1; set_env "$TENV" RECOVERY_INTERVAL_MS 30000
    grep -q '^ARC_NET=testnet$' "$TENV" || stop "the testnet env must be ARC_NET=testnet"
    echo "== server: stop the root instance (single sender), back up the env, install both envs, keys (order-creator on, deployer-admin off)"
    ssh "$HOST" "systemctl stop arcpreflight; cp /opt/arcpreflight/arcpreflight.env /opt/arcpreflight/arcpreflight.env.bak-$STAMP"
    scp -q "$MENV" "$HOST:/opt/arcpreflight/arcpreflight.env"; scp -q "$TENV" "$HOST:/opt/arcpreflight/arcpreflight-testnet.env"; rm -f "$MENV" "$TENV"
    scp -q keys/order-creator.json "$HOST:/opt/arcpreflight/keys/order-creator.json"
    scp -q ops/arcpreflight-testnet.service "$HOST:/etc/systemd/system/arcpreflight-testnet.service"
    scp -q ops/nginx-arcpreflight.conf "$HOST:/etc/nginx/conf.d/arcpreflight.conf"
    ssh "$HOST" "chmod 600 /opt/arcpreflight/arcpreflight.env /opt/arcpreflight/arcpreflight-testnet.env /opt/arcpreflight/keys/order-creator.json && rm -f /opt/arcpreflight/keys/deployer-admin.json && systemctl daemon-reload && ls /opt/arcpreflight/keys/"
    echo "== release bundle (restarts the root and the testnet instance)"; ops/deploy.sh "$HOST"
    REL=$(release); sleep 5
    echo "== verify the mainnet instance — any failure stops it"
    curl -s -m 15 "$API/v1/network" | python3 -c "
import sys,json; d=json.load(sys.stdin); a=d['accounts']; x=d.get('access',{})
problems=[]
if d['chainId']!=5042 or d['network']!='mainnet': problems.append(f\"network {d['network']} chain {d['chainId']}\")
if d['release']!='$REL': problems.append(f\"release {d['release']} != $REL\")
if a.get('orderSignerRole')!='order-creator' or a.get('adminKeyInProcess'): problems.append(f\"order signer {a.get('orderSignerRole')} adminKeyInProcess {a.get('adminKeyInProcess')}\")
if x.get('publicExecution') is not False: problems.append('publicExecution is not false')
if x.get('executionReady') is not True: problems.append('executionReady is not true')
print('network',d['caip2'],'release',d['release'],'orderSigner',a.get('orderSignerRole'),'adminKeyInProcess',a.get('adminKeyInProcess'),'access',x)
if problems: print('PROBLEMS: '+'; '.join(problems)); sys.exit(1)" && gatecheck "$API" 5042 || { ssh "$HOST" "systemctl stop arcpreflight"; stop "post-cutover verification failed — the mainnet service was stopped; the testnet instance keeps running"; }
    ssh "$HOST" "ls /opt/arcpreflight/keys/ | grep -q deployer-admin && echo 'deployer-admin key PRESENT' || echo 'deployer-admin key absent (as required)'"
    curl -s -m 15 "$API/testnet/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("testnet instance:",d["caip2"],"release",d["release"],"publicExecution",d.get("access",{}).get("publicExecution"),"fixtures",[(f["id"],(f["baselineDigest"] or "none")[:10]) for f in d["fixtures"]])' || echo "testnet instance not answering yet"
    ;;
  baselines)
    require_go baselines
    IMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-mainnet.json"))["implA"]["address"])')
    AT=$(admin_token)
    API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
    API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$IMPLA"
    # the testnet instance continues the preview database, whose baselines exist; approve only if it reports none
    if curl -s -m 15 "$API/testnet/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if all(f["baselineDigest"] for f in d["fixtures"]) else 1)'; then echo "testnet baselines present; not re-approved"; else
      TIMPLA=$(python3 -c 'import json;print(json.load(open("fixtures/deployments-testnet.json"))["implA"]["address"])'); TAT=$(grep '^ADMIN_TOKEN=' keys/env.server-testnet | cut -d= -f2)
      ARC_NET=testnet API_URL=$API/testnet ADMIN_TOKEN=$TAT pnpm exec tsx scripts/demo/approve-baseline.ts MAIN
      ARC_NET=testnet API_URL=$API/testnet ADMIN_TOKEN=$TAT pnpm exec tsx scripts/demo/approve-baseline.ts CHANGED --pin-implementation "$TIMPLA"; fi
    curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("network",d["caip2"],"release",d["release"],[(f["id"],(f["baselineDigest"] or "")[:10]) for f in d["fixtures"]])'
    ;;
  gatecheck)
    gatecheck "$API" 5042 || stop "the mainnet gate is not closed"
    ;;
  acceptance)
    require_go acceptance
    gatecheck "$API" 5042 || stop "the mainnet gate must be closed during acceptance"
    REL=$(curl -s "$API/health/live" | python3 -c 'import sys,json;print(json.load(sys.stdin)["release"])'); AT=$(admin_token)
    echo "== dry run first (nothing started)"; API_URL=$API ADMIN_TOKEN=$AT pnpm exec tsx scripts/selftest/mainnet.ts || stop "acceptance dry run not ready"
    echo "== execute: 3 rounds × 3 fixtures through the closed gate with the operator's token; cap 0.35 USDC incl. gas ceilings, measured outflow stop"
    API_URL=$API ADMIN_TOKEN=$AT EXPECTED_RELEASE=$REL SPEND_CAP_USDC="${SPEND_CAP_USDC:-0.35}" pnpm exec tsx scripts/selftest/mainnet.ts --execute
    ;;
  lifecycle)
    require_go lifecycle
    WALLET_KEY_FILE="${WALLET_KEY_FILE:-keys/visitor-rehearsal.json}"; [ -f "$WALLET_KEY_FILE" ] || stop "WALLET_KEY_FILE (a project-owned, hand-funded visitor key; never a user's key) is required"
    gatecheck "$API" 5042 || stop "the mainnet gate must be closed during the lifecycle acceptance"
    AT=$(admin_token)
    echo "== preflight (read-only)"; API_URL=$API ADMIN_TOKEN=$AT WALLET_KEY_FILE=$WALLET_KEY_FILE SCENARIOS="${SCENARIOS:-wallet,interrupt}" pnpm exec tsx scripts/selftest/lifecycle.ts --preflight || stop "lifecycle preflight not ready"
    echo "== execute: wallet scenario + labelled interruption through the closed gate with the operator's token; passports verified by the CLI"
    MAINNET_GO=1 API_URL=$API ADMIN_TOKEN=$AT WALLET_KEY_FILE=$WALLET_KEY_FILE SCENARIOS="${SCENARIOS:-wallet,interrupt}" pnpm exec tsx scripts/selftest/lifecycle.ts
    ;;
  open)
    require_go open
    REL=$(curl -s "$API/health/live" | python3 -c 'import sys,json;print(json.load(sys.stdin)["release"])')
    A=$(latest_evidence acceptance "$REL"); L=$(latest_evidence lifecycle "$REL")
    [ -n "$A" ] || stop "no PASS mainnet acceptance evidence for release $REL in evidence/selftest/"
    [ -n "$L" ] || stop "no mainnet lifecycle evidence (wallet + interrupt) for release $REL in evidence/selftest/"
    grep -q "$(basename "$A")" docs/EVIDENCE.md && grep -q "$(basename "$L")" docs/EVIDENCE.md || stop "record $A and $L in docs/EVIDENCE.md first"
    echo "evidence: $A · $L (release $REL)"
    echo "== open public business execution on mainnet and flip the capability labels"
    ssh "$HOST" "cp /opt/arcpreflight/arcpreflight.env /opt/arcpreflight/arcpreflight.env.bak-open-$(date -u +%Y%m%dT%H%M%SZ) && sed -i -e 's/^PUBLIC_EXECUTION=.*/PUBLIC_EXECUTION=1/' /opt/arcpreflight/arcpreflight.env && (grep -q '^MAINNET_VERIFIED=' /opt/arcpreflight/arcpreflight.env && sed -i -e 's/^MAINNET_VERIFIED=.*/MAINNET_VERIFIED=1/' /opt/arcpreflight/arcpreflight.env || echo 'MAINNET_VERIFIED=1' >> /opt/arcpreflight/arcpreflight.env) && systemctl restart arcpreflight"; sleep 4
    curl -s "$API/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("access",d["access"]);print([c["id"]+":"+c["status"] for c in d["capabilities"] if c["id"] in ("wallet-execution","business-execution-recovery")])'
    ;;
  *) echo "usage: ops/mainnet-cutover.sh preflight|fund|deploy|probe|server|baselines|gatecheck|acceptance|lifecycle|open   (spending/server steps need export CUTOVER_GO=<step> after the typed go)"; exit 2;;
esac
