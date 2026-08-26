#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CLOUDSDK_CONFIG="${HOUSEYIELD_GCLOUD_CONFIG_DIR:-$HOME/.config/gcloud-myhouseyield}"
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-$CLOUDSDK_CONFIG/application_default_credentials.json}"
export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-houseyield}"

FIREBASE_BIN="$ROOT_DIR/node_modules/.bin/firebase"
if [[ ! -x "$FIREBASE_BIN" ]]; then
  echo "Missing local firebase-tools. Run: npm install" >&2
  exit 1
fi

echo "Deploying Shelly IoT Firebase resources to project: houseyield"
echo "Using admin ADC: $GOOGLE_APPLICATION_CREDENTIALS"
echo
echo "Includes shellyWebhook (dashboard delete + CORS) and Firestore rules."
echo "Device webhooks may also target Cloud Run:"
echo "  ${BACKEND_PUBLIC_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app}/api/shelly/webhook"
echo

"$FIREBASE_BIN" deploy \
  --only functions:shellyWebhook,functions:checkStaleBleSensors,functions:pollHTSensors,functions:manualPollHT,functions:getSensorStatus,firestore:rules \
  --project houseyield \
  --non-interactive \
  --force

echo ""
echo "Optional: delete retired Cloud Run copies of shellyWebhook/health on houseyield after verifying backend webhooks."
