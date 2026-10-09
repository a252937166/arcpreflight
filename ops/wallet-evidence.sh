#!/usr/bin/env bash
# Real-wallet acceptance evidence (AP33-30): after a person ran docs/WALLET-CHECKLIST.md with MetaMask or OKX Wallet on the public
# testnet instance, read what the SERVER recorded for that wallet — orders, paid checks, wallet attempts with their prompt markers,
# states, hashes, deviations — and save it next to the checklist results. Read-only: the database is opened read-only on the server;
# nothing is changed; session tokens and secrets are never selected.
#   ops/wallet-evidence.sh <payer address> [since ISO time, default 24 h ago] [instance: root|testnet, default: whichever is Arc testnet]
set -euo pipefail
HOST="${HOST:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PAYER="${1:?payer address required}"; SINCE="${2:-$(python3 -c 'import datetime;print((datetime.datetime.utcnow()-datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ"))')}"
echo "$PAYER" | grep -qiE '^0x[0-9a-f]{40}$' || { echo "not an address: $PAYER"; exit 1; }
INST="${3:-}"
if [ -z "$INST" ]; then INST=$(ssh "$HOST" "grep -q '^ARC_NET=testnet' /opt/arcpreflight/arcpreflight.env && echo root || echo testnet"); fi
ENVF=/opt/arcpreflight/arcpreflight.env; [ "$INST" = "testnet" ] && ENVF=/opt/arcpreflight/arcpreflight-testnet.env
OUT="evidence/selftest/wallet-acceptance-$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
scp -q ops/lib/wallet-evidence.cjs "$HOST:/tmp/arcpf-wallet-evidence.cjs"
TMP=$(mktemp "${TMPDIR:-/tmp}/arcpf-wallet-evidence.XXXXXX")
ssh "$HOST" "set -a; . $ENVF; set +a; INSTANCE='$INST' PAYER='$PAYER' SINCE='$SINCE' node --no-warnings /tmp/arcpf-wallet-evidence.cjs; rc=\$?; rm -f /tmp/arcpf-wallet-evidence.cjs; exit \$rc" > "$TMP" || { rm -f "$TMP"; echo "the server-side read failed; nothing saved"; exit 1; }
mv "$TMP" "$OUT"
python3 - "$OUT" <<'PY'
import json, sys; d = json.load(open(sys.argv[1]))
print(f"{d['network']} ({d['instance']}) release {d['release']} · payer {d['payer']} since {d['since']}")
print(f"orders {len(d['orders'])} · paid checks {len(d['payments'])} · wallet attempts {len(d['attempts'])}")
for a in d["attempts"]: print(f"  {a['created_at'][:19]} {a['attempt_id'][:8]} {a['state']:<20} {a.get('business_status') or '':<12} prompt {((a.get('prompt') or {}).get('state') or '-'):<18} tx {(a['tx_hash'] or '-')[:12]}")
print(f"saved {sys.argv[1]}")
PY
