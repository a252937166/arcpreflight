#!/usr/bin/env bash
# Build the API bundle and the web app locally, rsync to the server, restart the service, verify health.
# First-time server setup (dirs, keys, env, nginx, certbot, systemd unit) is manual; see ops/README.md.
# Usage: ops/deploy.sh [user@host]
set -euo pipefail
HOST="${1:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
cd "$ROOT"
pnpm --filter @arcpreflight/api run build
pnpm --filter @arcpreflight/web run build
rsync -az --delete "$ROOT/apps/api/dist/" "$HOST:/opt/arcpreflight/dist/"
rsync -az "$ROOT/fixtures/" "$HOST:/opt/arcpreflight/fixtures/"
rsync -az --exclude 'private/' "$ROOT/evidence/" "$HOST:/opt/arcpreflight/evidence/"
rsync -az --delete "$ROOT/apps/web/dist/" "$HOST:/var/www/arcpreflight/"
ssh "$HOST" "sed -i 's/^RELEASE_SHA=.*/RELEASE_SHA=$SHA/' /opt/arcpreflight/arcpreflight.env && systemctl daemon-reload && systemctl enable --now arcpreflight >/dev/null 2>&1; systemctl restart arcpreflight && sleep 3 && curl -s http://127.0.0.1:4040/health/live && echo && nginx -t 2>&1 | tail -1 && systemctl reload nginx"
echo "deployed $SHA"
