#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GCLOUD_HOUSEYIELD=(bash "$ROOT_DIR/scripts/gcloud-houseyield.sh")
REGION="${BACKEND_GCP_REGION:-us-central1}"
HOUSEYIELD_PROJECT="${BACKEND_GCP_PROJECT:-houseyield}"
SILKEN_PROJECT="silken-slice-480417-e0"

echo "==> Silken-slice: legacy IoT Cloud Run (delete after devices migrate)"
echo "    Run: bash scripts/cleanup-silken-iot-cloudrun.sh --confirm"
if gcloud run services describe shellywebhook \
  --project "$SILKEN_PROJECT" \
  --region "$REGION" >/dev/null 2>&1; then
  echo "    WARNING: shellywebhook still exists on silken and may still be receiving traffic."
else
  echo "    shellywebhook not found on silken (already removed)."
fi

echo
echo "==> Houseyield: scale scanner to zero when idle"
"${GCLOUD_HOUSEYIELD[@]}" run services update renovation-scanner-host \
  --project "$HOUSEYIELD_PROJECT" \
  --region "$REGION" \
  --min-instances 0 \
  --cpu-throttling

# IoT BLE H&T history posts from the Shelly gateway to /api/shelly/webhook.
# Scale-to-zero cold starts (~10–30s) often exceed the gateway HTTP timeout, so
# charts go silent unless a laptop is dual-writing. Keep one warm instance for
# the main backend (override with BACKEND_GCP_MIN_INSTANCES=0 if you accept gaps).
BACKEND_MIN="${BACKEND_GCP_MIN_INSTANCES:-1}"
echo "==> Houseyield backend min-instances=${BACKEND_MIN} (IoT webhook reliability)"
"${GCLOUD_HOUSEYIELD[@]}" run services update houseyield-backend \
  --project "$HOUSEYIELD_PROJECT" \
  --region "$REGION" \
  --min-instances "$BACKEND_MIN" \
  --memory "${BACKEND_GCP_MEMORY:-1Gi}" \
  --cpu "${BACKEND_GCP_CPU:-1}"

echo
echo "Done. Scanner scales to zero; backend min-instances=${BACKEND_MIN}."
echo "Also schedule: GET /api/shelly/climate-history/tick every 1–2 minutes (Cloud Scheduler)."
