#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

SILKEN_PROJECT="${SILKEN_GCP_PROJECT:-silken-slice-480417-e0}"
REGION="${BACKEND_GCP_REGION:-us-central1}"
CONFIRM="${1:-}"

IOT_SERVICES=(
  shellywebhook
  health
  getsensorstatus
  manualpollht
  pollhtsensors
  checkstaleblesensors
)

if [[ "$CONFIRM" != "--confirm" ]]; then
  cat <<EOF
This deletes legacy IoT Cloud Run services from ${SILKEN_PROJECT}.

Only run this AFTER Shelly devices are posting to the houseyield backend:
  https://houseyield-backend-rhrpiopisa-uc.a.run.app/api/shelly/webhook

Services targeted:
$(printf '  - %s\n' "${IOT_SERVICES[@]}")

Re-run with:
  bash scripts/cleanup-silken-iot-cloudrun.sh --confirm
EOF
  exit 0
fi

echo "==> Using gcloud account: $(gcloud config get-value account 2>/dev/null || echo unknown)"
echo "==> Deleting silken IoT Cloud Run services in ${SILKEN_PROJECT}/${REGION}"

for svc in "${IOT_SERVICES[@]}"; do
  if gcloud run services describe "$svc" --project "$SILKEN_PROJECT" --region "$REGION" >/dev/null 2>&1; then
    echo "Deleting ${svc}..."
    gcloud run services delete "$svc" --project "$SILKEN_PROJECT" --region "$REGION" --quiet
  else
    echo "Skipping ${svc} (not found)"
  fi
done

echo
echo "Done. GPU VMs on ${SILKEN_PROJECT} were not touched."
