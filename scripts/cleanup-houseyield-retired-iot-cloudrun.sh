#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT="${BACKEND_GCP_PROJECT:-houseyield}"
REGION="${BACKEND_GCP_REGION:-us-central1}"
CONFIRM="${1:-}"

RETIRED_SERVICES=(
  shellywebhook
  health
)

if [[ "$CONFIRM" != "--confirm" ]]; then
  cat <<EOF
This deletes retired Firebase Gen2 Cloud Run services on ${PROJECT}.

Device webhooks now use houseyield-backend /api/shelly/webhook instead.
Scheduled jobs (pollHTSensors, etc.) are separate and are NOT deleted.

Services targeted:
$(printf '  - %s\n' "${RETIRED_SERVICES[@]}")

Re-run with:
  bash scripts/cleanup-houseyield-retired-iot-cloudrun.sh --confirm
EOF
  exit 0
fi

GCLOUD=(bash "$ROOT_DIR/scripts/gcloud-houseyield.sh")

for svc in "${RETIRED_SERVICES[@]}"; do
  if "${GCLOUD[@]}" run services describe "$svc" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
    echo "Deleting ${svc}..."
    "${GCLOUD[@]}" run services delete "$svc" --project "$PROJECT" --region "$REGION" --quiet
  else
    echo "Skipping ${svc} (not found)"
  fi
done

echo "Done."
