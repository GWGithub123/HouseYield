#!/usr/bin/env bash
# Create/update a Cloud Scheduler job that keeps HouseYield IoT climate history
# flowing without a local push-server.
#
# Hits: GET {BACKEND}/api/shelly/climate-history/tick every 2 minutes
# Also warms Cloud Run so BLE gateway webhooks avoid cold-start timeouts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GCLOUD_HOUSEYIELD=(bash "$ROOT_DIR/scripts/gcloud-houseyield.sh")
PROJECT_ID="${BACKEND_GCP_PROJECT:-houseyield}"
REGION="${BACKEND_GCP_REGION:-us-central1}"
JOB_NAME="${IOT_CLIMATE_SCHEDULER_JOB:-houseyield-iot-climate-history}"
BACKEND_URL="${BACKEND_PUBLIC_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app}"
TICK_URL="${BACKEND_URL%/}/api/shelly/climate-history/tick"
SCHEDULE="${IOT_CLIMATE_SCHEDULER_CRON:-*/2 * * * *}"

AUTH_HEADER_ARGS=()
if [[ -n "${SHELLY_WEBHOOK_SECRET:-}" ]]; then
  AUTH_HEADER_ARGS+=(--headers "X-Shelly-Webhook-Secret=${SHELLY_WEBHOOK_SECRET}")
fi

echo "==> Ensuring Cloud Scheduler job ${JOB_NAME}"
echo "    URL: ${TICK_URL}"
echo "    Cron: ${SCHEDULE}"

if "${GCLOUD_HOUSEYIELD[@]}" scheduler jobs describe "$JOB_NAME" \
  --project "$PROJECT_ID" \
  --location "$REGION" >/dev/null 2>&1; then
  "${GCLOUD_HOUSEYIELD[@]}" scheduler jobs update http "$JOB_NAME" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --schedule "$SCHEDULE" \
    --uri "$TICK_URL" \
    --http-method GET \
    --attempt-deadline 60s \
    "${AUTH_HEADER_ARGS[@]}"
  echo "✅ Updated ${JOB_NAME}"
else
  "${GCLOUD_HOUSEYIELD[@]}" scheduler jobs create http "$JOB_NAME" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --schedule "$SCHEDULE" \
    --uri "$TICK_URL" \
    --http-method GET \
    --attempt-deadline 60s \
    --time-zone "America/New_York" \
    "${AUTH_HEADER_ARGS[@]}"
  echo "✅ Created ${JOB_NAME}"
fi

echo
echo "Also recommended: BACKEND_GCP_MIN_INSTANCES=1 on houseyield-backend"
echo "  gcloud run services update houseyield-backend --min-instances=1 --region=${REGION} --project=${PROJECT_ID}"
