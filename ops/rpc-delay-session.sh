#!/usr/bin/env bash
# Route the public TESTNET instance's own chain RPC through ops/rpc-delay-proxy.mjs on the server, for the delayed chain-RPC acceptance
# scenario (AP33-30 row 11), and restore it afterwards. Testnet only: refuses an instance whose env is not ARC_NET=testnet. Clients keep
# seeing the public RPC (PUBLIC_RPC_URL); only the server's calls are delayed. Every other visitor sees the same delays while it is on.
#   ops/rpc-delay-session.sh on   [HOLD_RECEIPT_MS=30000 HOLD_TO=<proxy> HOLD_TO_MS=120000 DELAY_ETH_SENDRAWTRANSACTION_MS=3000 …]
#   ops/rpc-delay-session.sh off
#   ops/rpc-delay-session.sh status
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
API="${API:-https://arcpreflight.axiqo.xyz}"
step="${1:-status}"
# the instance that serves Arc testnet: the root until the mainnet cutover, /testnet afterwards
ENVF=$(ssh "$HOST" "grep -q '^ARC_NET=testnet' /opt/arcpreflight/arcpreflight.env && echo /opt/arcpreflight/arcpreflight.env || ( [ -f /opt/arcpreflight/arcpreflight-testnet.env ] && grep -q '^ARC_NET=testnet' /opt/arcpreflight/arcpreflight-testnet.env && echo /opt/arcpreflight/arcpreflight-testnet.env ) || echo none")
[ "$ENVF" != none ] || { echo "no Arc testnet instance found on the server"; exit 1; }
UNIT=arcpreflight; [ "$ENVF" = /opt/arcpreflight/arcpreflight-testnet.env ] && UNIT=arcpreflight-testnet
BASE="$API"; [ "$UNIT" = arcpreflight-testnet ] && BASE="$API/testnet"
case "$step" in
  on)
    scp -q ops/rpc-delay-proxy.mjs "$HOST:/opt/arcpreflight/rpc-delay-proxy.mjs"
    PROPS="UPSTREAM=https://rpc.testnet.arc.io PORT=8549 HOST=127.0.0.1 HOLD_RECEIPT_MS=${HOLD_RECEIPT_MS:-30000} HOLD_TO=${HOLD_TO:-} HOLD_TO_MS=${HOLD_TO_MS:-0} HOLD_SELECTOR=${HOLD_SELECTOR:-} HOLD_SELECTOR_MS=${HOLD_SELECTOR_MS:-0} DELAY_ETH_SENDRAWTRANSACTION_MS=${DELAY_ETH_SENDRAWTRANSACTION_MS:-3000} DELAY_ETH_CALL_MS=${DELAY_ETH_CALL_MS:-0}"
    ENVARGS=""; for kv in $PROPS; do ENVARGS="$ENVARGS --setenv=$kv"; done
    ssh "$HOST" "systemctl stop arcpf-rpc-delay 2>/dev/null; systemctl reset-failed arcpf-rpc-delay 2>/dev/null; systemd-run --unit=arcpf-rpc-delay $ENVARGS /usr/local/bin/node /opt/arcpreflight/rpc-delay-proxy.mjs >/dev/null && sleep 2 && curl -s http://127.0.0.1:8549/stats"
    echo
    ssh "$HOST" "cp $ENVF $ENVF.bak-rpcdelay && sed -i -e '/^ARC_RPC_URL=/d' -e '/^PUBLIC_RPC_URL=/d' $ENVF && echo 'ARC_RPC_URL=http://127.0.0.1:8549' >> $ENVF && echo 'PUBLIC_RPC_URL=https://rpc.testnet.arc.io' >> $ENVF && systemctl restart $UNIT"
    sleep 5; curl -s -m 15 "$BASE/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("instance",d["caip2"],"release",d["release"],"reports rpc",d["rpc"])'
    echo "ON: $UNIT's chain RPC goes through the delay proxy ($PROPS)"
    ;;
  off)
    ssh "$HOST" "sed -i -e '/^ARC_RPC_URL=/d' -e '/^PUBLIC_RPC_URL=/d' $ENVF && systemctl restart $UNIT; sleep 3; curl -s http://127.0.0.1:8549/stats 2>/dev/null; echo; systemctl stop arcpf-rpc-delay 2>/dev/null; systemctl reset-failed arcpf-rpc-delay 2>/dev/null; true"
    sleep 4; curl -s -m 15 "$BASE/v1/network" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("instance",d["caip2"],"release",d["release"],"reports rpc",d["rpc"])'
    echo "OFF: $UNIT uses its normal RPC again; the proxy unit is stopped"
    ;;
  status)
    ssh "$HOST" "grep -E '^(ARC_NET|ARC_RPC_URL|PUBLIC_RPC_URL)=' $ENVF; systemctl is-active arcpf-rpc-delay 2>/dev/null || true; curl -s http://127.0.0.1:8549/stats 2>/dev/null; echo"
    ;;
  *) echo "usage: ops/rpc-delay-session.sh on|off|status"; exit 2;;
esac
