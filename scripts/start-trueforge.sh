#!/usr/bin/env bash
# Start TrueForge in local mode (pinned version). Leave this terminal open: it is the server.
#   bash scripts/start-trueforge.sh            # UI + API at http://127.0.0.1:8790
set -euo pipefail

# Pinned on purpose: TrueForge ships several releases a week; this is the version we test with.
TRUEFORGE_VERSION="${TRUEFORGE_VERSION:-0.182.0}"
PORT="${PORT:-8790}"
# Listen on IPv4 loopback explicitly: "localhost" can resolve to ::1 in one process and to
# 127.0.0.1 in another (VS Code's extension host), which made the extension time out.
export HOST="${HOST:-127.0.0.1}"

# TrueForge's outbound-URL guard blocks loopback by default. The extension serves its editor tools
# as an MCP server on 127.0.0.1, so TrueForge must be allowed to call it.
# Model API hosts are allowlisted too: on IPv6-only networks with NAT64 (common on mobile/fibre ISPs)
# IPv4-only hosts resolve to synthetic 64:ff9b:: addresses, which the guard would otherwise refuse.
# Add hosts with EXTRA_ALLOWED_HOSTS='"api.example.com","other.example.org"'.
ALLOWED='"127.0.0.1","localhost","integrate.api.nvidia.com","api.z.ai","api.groq.com","api.mistral.ai"'
export OUTBOUND_URL_ALLOWED_HOSTS="[${ALLOWED}${EXTRA_ALLOWED_HOSTS:+,${EXTRA_ALLOWED_HOSTS}}]"
# run_command (e.g. a test suite) can take longer than TrueForge's 2-minute MCP default, and a turn
# on a slow model can take longer than its 10-minute default.
export MCP_REQUEST_TIMEOUT_MS="${MCP_REQUEST_TIMEOUT_MS:-900000}"
export SERVER_EXECUTION_TIMEOUT_SECONDS="${SERVER_EXECUTION_TIMEOUT_SECONDS:-1800}"
# TrueForge gives a model endpoint 5 s to accept the connection; slow Wi-Fi / tunnels need longer.
export MODEL_HTTP_CONNECT_TIMEOUT_MS="${MODEL_HTTP_CONNECT_TIMEOUT_MS:-20000}"

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
node_minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 14 ]; }; then
  echo "TrueForge needs Node >= 22.14 (found $(node -v 2>/dev/null || echo none))." >&2
  exit 1
fi

echo "Starting TrueForge ${TRUEFORGE_VERSION} on http://${HOST}:${PORT} (Ctrl+C to stop)"
exec npx --yes "@truefoundry/trueforge@${TRUEFORGE_VERSION}" --port "${PORT}"
