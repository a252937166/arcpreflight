#!/usr/bin/env bash
# Build the API bundle and the web app locally, rsync to the server, restart the service, verify health.
# First-time server setup (dirs, keys, env, nginx, certbot, systemd unit) is manual; see ops/README.md.
# Usage: ops/deploy.sh [user@host]
set -euo pipefail
HOST="${1:-root@206.237.18.80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# the release label is the last commit that changed what runs on the server (the API and web bundles are built from these paths);
# docs-only commits keep the label. The bundle must match a commit: uncommitted or untracked changes there (or in fixtures/) are refused.
CODE_PATHS="apps packages package.json pnpm-lock.yaml pnpm-workspace.yaml"
cd "$ROOT"
if ! git diff --quiet HEAD -- $CODE_PATHS fixtures || [ -n "$(git ls-files --others --exclude-standard -- $CODE_PATHS fixtures)" ]; then
  echo "refusing: uncommitted or untracked changes in $CODE_PATHS fixtures — commit first so the release label names the deployed code"; exit 1
fi
SHA="$(git log -1 --format=%h -- $CODE_PATHS)"
pnpm --filter @arcpreflight/api run build
pnpm --filter @arcpreflight/web run build
rsync -az --delete "$ROOT/apps/api/dist/" "$HOST:/opt/arcpreflight/dist/"
rsync -az "$ROOT/fixtures/" "$HOST:/opt/arcpreflight/fixtures/"
rsync -az --exclude 'private/' "$ROOT/evidence/" "$HOST:/opt/arcpreflight/evidence/"
rsync -az --delete "$ROOT/apps/web/dist/" "$HOST:/var/www/arcpreflight/"
# both instances run the same bundle: the root (mainnet after the cutover) and the testnet instance under /testnet (if its env file exists)
ssh "$HOST" "sed -i 's/^RELEASE_SHA=.*/RELEASE_SHA=$SHA/' /opt/arcpreflight/arcpreflight.env && ([ -f /opt/arcpreflight/arcpreflight-testnet.env ] && sed -i 's/^RELEASE_SHA=.*/RELEASE_SHA=$SHA/' /opt/arcpreflight/arcpreflight-testnet.env || true) \
  && systemctl daemon-reload && systemctl enable --now arcpreflight >/dev/null 2>&1; systemctl restart arcpreflight && sleep 3 && curl -s http://127.0.0.1:4040/health/live && echo \
  && ([ -f /opt/arcpreflight/arcpreflight-testnet.env ] && systemctl enable --now arcpreflight-testnet >/dev/null 2>&1 && systemctl restart arcpreflight-testnet && sleep 3 && curl -s http://127.0.0.1:4041/health/live && echo || echo 'no testnet instance configured') \
  && nginx -t 2>&1 | tail -1 && systemctl reload nginx"
echo "deployed $SHA"
