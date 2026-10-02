#!/usr/bin/env bash
# Build the API bundle and the web app locally, rsync to the server, restart the service. Usage: ops/deploy.sh [host]
set -euo pipefail
HOST="${1:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
cd "$ROOT"
RELEASE_SHA="$SHA" pnpm --filter @arcpreflight/api run build
rsync -az --delete "$ROOT/apps/api/dist/" "$HOST:/opt/arcpreflight/dist/"
rsync -az "$ROOT/fixtures/" "$HOST:/opt/arcpreflight/fixtures/"
if [ -d "$ROOT/apps/web/dist" ]; then rsync -az --delete "$ROOT/apps/web/dist/" "$HOST:/var/www/arcpreflight/"; fi
ssh "$HOST" "sed -i 's/^RELEASE_SHA=.*/RELEASE_SHA=$SHA/' /opt/arcpreflight/arcpreflight.env && systemctl restart arcpreflight && sleep 2 && curl -s http://127.0.0.1:4040/health/live"
echo
echo "deployed $SHA"
