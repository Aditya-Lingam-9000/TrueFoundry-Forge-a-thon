#!/usr/bin/env bash
# Start TrueForge in local mode (pinned version). Leave this terminal open: it is the server.
#   bash scripts/start-trueforge.sh            # UI + API at http://localhost:8790
set -euo pipefail

# Pinned on purpose: TrueForge ships several releases a week; this is the version we test with.
TRUEFORGE_VERSION="${TRUEFORGE_VERSION:-0.182.0}"
PORT="${PORT:-8790}"

# TrueForge's outbound-URL guard blocks loopback by default. The extension serves its editor tools
# as an MCP server on 127.0.0.1, so TrueForge must be allowed to call it.
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
node_minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 14 ]; }; then
  echo "TrueForge needs Node >= 22.14 (found $(node -v 2>/dev/null || echo none))." >&2
  exit 1
fi

echo "Starting TrueForge ${TRUEFORGE_VERSION} on http://localhost:${PORT} (Ctrl+C to stop)"
exec npx --yes "@truefoundry/trueforge@${TRUEFORGE_VERSION}" --port "${PORT}"
