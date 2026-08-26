#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_URL="${BACKEND_PUBLIC_URL:-https://houseyield-backend-rhrpiopisa-uc.a.run.app}"
WEBHOOK_URL="${SHELLY_WEBHOOK_URL:-${BACKEND_URL%/}/api/shelly/webhook}"

echo "==> HouseYield IoT backend consolidation"
echo "Backend URL:  ${BACKEND_URL}"
echo "Webhook URL:  ${WEBHOOK_URL}"
echo

echo "==> Step 1: Scale houseyield Cloud Run services to zero when idle"
bash "$ROOT_DIR/scripts/optimize-cloud-run-costs.sh"

echo
echo "==> Step 2: Right-size houseyield-backend (1 CPU / 1 GiB, min-instances=0)"
GCLOUD=(bash "$ROOT_DIR/scripts/gcloud-houseyield.sh")
PROJECT="${BACKEND_GCP_PROJECT:-houseyield}"
REGION="${BACKEND_GCP_REGION:-us-central1}"

"${GCLOUD[@]}" run services update houseyield-backend \
  --project "$PROJECT" \
  --region "$REGION" \
  --memory "${BACKEND_GCP_MEMORY:-1Gi}" \
  --cpu "${BACKEND_GCP_CPU:-1}" \
  --min-instances "${BACKEND_GCP_MIN_INSTANCES:-0}"

echo
echo "==> Step 3: Deploy backend container (Cloud Run webhook handler)"
bash "$ROOT_DIR/deploy-backend-cloudrun.sh"

echo
echo "==> Step 4: Verify backend webhook endpoint"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${WEBHOOK_URL}" || true)"
echo "GET ${WEBHOOK_URL} -> HTTP ${HTTP_CODE}"

echo
cat <<EOF
==> Step 5: Reconfigure physical Shelly devices (on property WiFi)

Flood sensor (press button to wake, then run from dev machine on same LAN):
  curl -X POST http://127.0.0.1:3001/api/shelly/flood/reconfigure-webhooks \\
    -H 'Content-Type: application/json' \\
    -d '{"propertyId":"YOUR_PROPERTY_ID"}'

Water relay (outbound WebSocket + status webhooks):
  curl -X POST http://127.0.0.1:3001/api/shelly/relay/reconfigure-cloud \\
    -H 'Content-Type: application/json' \\
    -d '{"deviceId":"YOUR_RELAY_DEVICE_ID"}'

Or use the Sensor Dashboard reconnect flow in the app.

==> Step 6: Delete legacy silken IoT Cloud Run (after devices are migrated)
  bash scripts/cleanup-silken-iot-cloudrun.sh --confirm

==> Step 7: Delete retired shellyWebhook/health copies on houseyield (optional)
  bash scripts/cleanup-houseyield-retired-iot-cloudrun.sh --confirm

Scheduled IoT jobs still run as Firebase functions on houseyield:
  bash scripts/deploy-iot-functions-houseyield.sh
EOF
