#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT="${PORT:-3001}"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"

# Slim product surface for the frontend; backend allowlist is opt-in via PRODUCT_MODE.
export VITE_PRODUCT_MODE=maintenance
export PRODUCT_MODE="${PRODUCT_MODE:-maintenance}"

#
# Auth must finish BEFORE Vite starts.
#
# Previously concurrently launched the UI and backend together. The backend then
# blocked on an interactive gcloud verification code while Vite was already up
# and hammering :3001 — flooding the terminal with ECONNREFUSED proxy errors
# that buried the prompt. Check credentials here, once, in the foreground.
#
if [[ -z "${FIREBASE_SERVICE_ACCOUNT_PATH:-}" ]]; then
  if ! bash ./scripts/gcloud-houseyield-service-account.sh >/dev/null 2>&1; then
    echo ""
    echo "HouseYield gcloud credentials need a refresh before the backend can start."
    echo "1. Open the Google link that appears next"
    echo "2. Sign in, then paste the verification code here"
    echo "Vite starts only after this finishes, so the prompt won't get buried."
    echo ""
    bash ./scripts/gcloud-houseyield-login.sh
  fi
fi

if lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Backend already listening on :$BACKEND_PORT — starting maintenance UI only (port 5175)."
  echo "Open http://localhost:5175"
  echo "Note: existing backend may still be in full mode unless PRODUCT_MODE=maintenance was set when it started."
  exec "$VITE_BIN" --config vite.maintenance.config.ts --port 5175 --strictPort
fi

echo "Starting Maintenance Orchestration UI (:5175) and backend (:$BACKEND_PORT) with PRODUCT_MODE=maintenance…"
exec concurrently \
  --names "ui,api" \
  --prefix-colors "cyan,magenta" \
  "vite --config vite.maintenance.config.ts --port 5175 --strictPort" \
  "npm:push-server"
