#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT="${PORT:-3001}"

VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

if lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Backend already listening on :$BACKEND_PORT — starting ops UI only (port 5174)."
  echo "Open http://localhost:5174"
  exec "$VITE_BIN" --config vite.internal.config.ts --port 5174 --strictPort
fi

echo "Starting ops UI (:5174) and backend (:$BACKEND_PORT)…"
# Do not use --kill-others-on-fail: a long ATTOM search or backend hiccup must not
# tear down the ops UI (that remounts auth and looks like a black-screen reset).
exec concurrently \
  "vite --config vite.internal.config.ts --port 5174 --strictPort" \
  "npm:push-server"
