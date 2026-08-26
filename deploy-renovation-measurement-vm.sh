#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCLOUD_BIN="${RENOVATION_MEASUREMENT_GCLOUD_BIN:-gcloud}"

run_gcloud() {
  "$GCLOUD_BIN" "$@"
}

if [ -f "$SCRIPT_DIR/.env" ]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$value"
    fi
  done < "$SCRIPT_DIR/.env"
fi

VM_NAME="${1:-${RENOVATION_MEASUREMENT_GCP_VM_NAME:-renovation-measurement-gpu-useast1b}}"
ZONE="${2:-${RENOVATION_MEASUREMENT_GCP_VM_ZONE:-us-east1-b}}"
PROJECT="${3:-${RENOVATION_MEASUREMENT_GCP_VM_PROJECT:-silken-slice-480417-e0}}"
REMOTE_SERVICE_DIR="${RENOVATION_MEASUREMENT_GCP_SERVICE_DIR:-/opt/renovation-measurement-service}"
REMOTE_PYTHON="${RENOVATION_MEASUREMENT_GCP_PYTHON_PATH:-/opt/renovation-measurement-venv/bin/python3}"
REMOTE_DATA_DIR="${RENOVATION_MEASUREMENT_GCP_DATA_DIR:-/opt/renovation-measurement-data}"
REMOTE_MODELS_DIR="${RENOVATION_MEASUREMENT_GCP_MODELS_DIR:-/opt/renovation-measurement-models}"
REMOTE_CACHE_DIR="${RENOVATION_MEASUREMENT_GCP_CACHE_DIR:-$REMOTE_DATA_DIR/cache}"
REMOTE_ARCHIVE="/tmp/renovation-measurement-service.tar.gz"
REMOTE_ENV_FILE="/tmp/renovation-measurement.env"
API_TARGET_TAG="${RENOVATION_MEASUREMENT_API_TARGET_TAG:-renovation-measurement-api}"
API_FIREWALL_RULE="${RENOVATION_MEASUREMENT_API_FIREWALL_RULE:-allow-renovation-measurement-api-8090}"
API_SOURCE_RANGES="${RENOVATION_MEASUREMENT_API_SOURCE_RANGES:-}"
REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH="${REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH:-$REMOTE_MODELS_DIR/specialist-yolo.pt}"
SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH="${SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH:-}"
SPECIALIST_YOLO_WEIGHTS_URL="${SPECIALIST_YOLO_WEIGHTS_URL:-}"
SPECIALIST_DETECTOR_BACKEND="${SPECIALIST_DETECTOR_BACKEND:-grounding_dino}"
SPECIALIST_GROUNDING_DINO_MODEL="${SPECIALIST_GROUNDING_DINO_MODEL:-IDEA-Research/grounding-dino-tiny}"
SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD="${SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD:-0.22}"
SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD="${SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD:-0.15}"
REQUIRE_SPECIALIST_DETECTOR="${RENOVATION_MEASUREMENT_REQUIRE_SPECIALIST_DETECTOR:-${RENOVATION_MEASUREMENT_REQUIRE_SPECIALIST_YOLO:-false}}"
ROOM_GEOMETRY_ASSIST_ROOM_TYPES="${ROOM_GEOMETRY_ASSIST_ROOM_TYPES:-bathroom,home_gym,basement,rec_room,family_room,media_room,bonus_room}"

if ! command -v "$GCLOUD_BIN" >/dev/null 2>&1 && [ ! -x "$GCLOUD_BIN" ]; then
  echo "ERROR: gcloud command not found or not executable: $GCLOUD_BIN" >&2
  echo "Set RENOVATION_MEASUREMENT_GCLOUD_BIN to a working gcloud binary or wrapper script and retry." >&2
  exit 1
fi

declare -a MISSING_ENV_VARS=()
if [ -z "${OPENAI_API_KEY:-}" ]; then
  MISSING_ENV_VARS+=("OPENAI_API_KEY")
fi
if [ -z "${REPLICATE_API_TOKEN:-${REPLICATE_API_KEY:-}}" ]; then
  MISSING_ENV_VARS+=("REPLICATE_API_TOKEN or REPLICATE_API_KEY")
fi
if [ "${#MISSING_ENV_VARS[@]}" -gt 0 ]; then
  echo "ERROR: missing required local environment variables for deployment:" >&2
  printf '  - %s\n' "${MISSING_ENV_VARS[@]}" >&2
  echo "Populate them in your shell or .env before deploying so the remote API can authenticate upstream services." >&2
  exit 1
fi

if [ -n "$SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" ] && [ -n "$SPECIALIST_YOLO_WEIGHTS_URL" ]; then
  echo "ERROR: set either SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH or SPECIALIST_YOLO_WEIGHTS_URL, not both." >&2
  exit 1
fi

if [ -n "$SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" ] && [ ! -f "$SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" ]; then
  echo "ERROR: SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH does not exist: $SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/renovation-measurement-service.tar.gz"
LOCAL_ENV_FILE="$TMP_DIR/renovation-measurement.env"
PACKAGE_LOCK_HASH="$(shasum -a 256 "$SCRIPT_DIR/package-lock.json" | awk '{print $1}')"
REQUIREMENTS_HASH="$(shasum -a 256 "$SCRIPT_DIR/server/scripts/measurement/requirements.txt" | awk '{print $1}')"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$LOCAL_ENV_FILE" <<EOFENV
NODE_ENV=production
RENOVATION_MEASUREMENT_API_HOST=0.0.0.0
RENOVATION_MEASUREMENT_API_PORT=${RENOVATION_MEASUREMENT_API_PORT:-8090}
RENOVATION_MEASUREMENT_API_KEY=${RENOVATION_MEASUREMENT_API_KEY:-}
RENOVATION_MEASUREMENT_API_TIMEOUT_MS=${RENOVATION_MEASUREMENT_API_TIMEOUT_MS:-600000}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
REPLICATE_API_TOKEN=${REPLICATE_API_TOKEN:-${REPLICATE_API_KEY:-}}
ROOM_GEOMETRY_GCP_ASSIST_ENABLE=false
MEASUREMENT_TARGET_DETECTOR_URL=http://127.0.0.1:${SPECIALIST_PORT:-8010}/detect-target
MEASUREMENT_TARGET_SEGMENTATION_URL=http://127.0.0.1:${SPECIALIST_PORT:-8010}/segment-target
ROOM_GEOMETRY_ASSIST_URL=http://127.0.0.1:${ROOM_GEOMETRY_ASSIST_PORT:-8011}/estimate-room-geometry
ROOM_GEOMETRY_ASSIST_TIMEOUT_MS=${ROOM_GEOMETRY_ASSIST_TIMEOUT_MS:-600000}
ROOM_GEOMETRY_ASSIST_ROOM_TYPES=${ROOM_GEOMETRY_ASSIST_ROOM_TYPES}
SPECIALIST_HOST=127.0.0.1
SPECIALIST_PORT=${SPECIALIST_PORT:-8010}
SPECIALIST_DETECTOR_BACKEND=${SPECIALIST_DETECTOR_BACKEND}
SPECIALIST_YOLO_WEIGHTS=${REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH}
SPECIALIST_GROUNDING_DINO_MODEL=${SPECIALIST_GROUNDING_DINO_MODEL}
SPECIALIST_SAM2_CHECKPOINT=${SPECIALIST_SAM2_CHECKPOINT:-facebook/sam2-hiera-large}
SPECIALIST_YOLO_CONFIDENCE=${SPECIALIST_YOLO_CONFIDENCE:-0.15}
SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD=${SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD}
SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD=${SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD}
SPECIALIST_SAM2_MASK_THRESHOLD=${SPECIALIST_SAM2_MASK_THRESHOLD:-0.0}
ROOM_GEOMETRY_ASSIST_HOST=127.0.0.1
ROOM_GEOMETRY_ASSIST_PORT=${ROOM_GEOMETRY_ASSIST_PORT:-8011}
ROOM_GEOMETRY_DATA_DIR=${ROOM_GEOMETRY_DATA_DIR:-$REMOTE_DATA_DIR/geometry}
XDG_CACHE_HOME=${XDG_CACHE_HOME:-$REMOTE_CACHE_DIR}
HF_HOME=${HF_HOME:-$REMOTE_MODELS_DIR/huggingface}
TRANSFORMERS_CACHE=${TRANSFORMERS_CACHE:-$REMOTE_MODELS_DIR/huggingface}
TORCH_HOME=${TORCH_HOME:-$REMOTE_MODELS_DIR/torch}
YOLO_CONFIG_DIR=${YOLO_CONFIG_DIR:-$REMOTE_CACHE_DIR/ultralytics}
ROOM_GEOMETRY_PYTHON_BIN=${REMOTE_PYTHON}
ROOM_GEOMETRY_PIPELINE_SCRIPT=${REMOTE_SERVICE_DIR}/server/scripts/photogrammetry_v2/pipeline_v2.py
ROOM_GEOMETRY_TIMEOUT_S=${ROOM_GEOMETRY_TIMEOUT_S:-1800}
ROOM_GEOMETRY_METRIC3D_MODEL=${ROOM_GEOMETRY_METRIC3D_MODEL:-vit-small}
ROOM_GEOMETRY_VOXEL_SIZE=${ROOM_GEOMETRY_VOXEL_SIZE:-0.02}
ROOM_GEOMETRY_SAM2_CHECKPOINT=${ROOM_GEOMETRY_SAM2_CHECKPOINT:-facebook/sam2-hiera-large}
EOFENV

echo "=============================================="
echo "Deploying Renovation Measurement VM Bundle"
echo "=============================================="
echo "Project:      $PROJECT"
echo "VM:           $VM_NAME"
echo "Zone:         $ZONE"
echo "Remote dir:   $REMOTE_SERVICE_DIR"
echo "Remote python:$REMOTE_PYTHON"
echo "Remote cache: $REMOTE_CACHE_DIR"
echo "gcloud:       $GCLOUD_BIN"
echo ""

ACTIVE_ACCOUNT="$(run_gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"

if ! run_gcloud compute zones describe "$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "ERROR: unable to access Compute Engine zone '$ZONE' in project '$PROJECT'." >&2
  if [ -n "$ACTIVE_ACCOUNT" ]; then
    echo "Active gcloud account: $ACTIVE_ACCOUNT" >&2
  fi
  echo "Grant this account access to $PROJECT or set RENOVATION_MEASUREMENT_GCLOUD_BIN to a wrapper/account that can access the target project." >&2
  exit 1
fi

if ! run_gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1; then
  echo "ERROR: VM not found in $PROJECT/$ZONE: $VM_NAME" >&2
  echo "Create the VM first with ./create-renovation-measurement-vm.sh before deploying." >&2
  exit 1
fi

INSTANCE_NETWORK_URL="$(run_gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" --format='get(networkInterfaces[0].network)')"
INSTANCE_NETWORK="${INSTANCE_NETWORK_URL##*/}"

tar -czf "$ARCHIVE_PATH" -C "$SCRIPT_DIR" \
  package.json \
  package-lock.json \
  server/services/photoMeasurementService.js \
  server/services/gcpGpuWorker.js \
  server/services/renovationMeasurementScopeCalculator.js \
  server/scripts/measurement \
  server/scripts/photogrammetry \
  server/scripts/photogrammetry_v2

run_gcloud compute instances add-tags "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --tags="$API_TARGET_TAG"

if [ -n "$API_SOURCE_RANGES" ]; then
  if run_gcloud compute firewall-rules describe "$API_FIREWALL_RULE" --project="$PROJECT" >/dev/null 2>&1; then
    run_gcloud compute firewall-rules update "$API_FIREWALL_RULE" \
      --project="$PROJECT" \
      --allow="tcp:${RENOVATION_MEASUREMENT_API_PORT:-8090}" \
      --source-ranges="$API_SOURCE_RANGES" \
      --target-tags="$API_TARGET_TAG"
  else
    run_gcloud compute firewall-rules create "$API_FIREWALL_RULE" \
      --project="$PROJECT" \
      --network="$INSTANCE_NETWORK" \
      --direction=INGRESS \
      --action=ALLOW \
      --rules="tcp:${RENOVATION_MEASUREMENT_API_PORT:-8090}" \
      --source-ranges="$API_SOURCE_RANGES" \
      --target-tags="$API_TARGET_TAG" \
      --description="Allow scoped ingress to the renovation measurement API"
  fi
fi

run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="sudo mkdir -p $REMOTE_SERVICE_DIR $REMOTE_DATA_DIR $REMOTE_MODELS_DIR $REMOTE_CACHE_DIR && sudo mkdir -p $REMOTE_MODELS_DIR/huggingface $REMOTE_MODELS_DIR/torch $REMOTE_CACHE_DIR/ultralytics && sudo chown -R \$(whoami) $REMOTE_SERVICE_DIR $REMOTE_DATA_DIR $REMOTE_MODELS_DIR $REMOTE_CACHE_DIR"

if [ -n "$SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" ]; then
  run_gcloud compute scp "$SPECIALIST_YOLO_WEIGHTS_LOCAL_PATH" "$VM_NAME:$REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH" --zone="$ZONE" --project="$PROJECT"
elif [ -n "$SPECIALIST_YOLO_WEIGHTS_URL" ]; then
  run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="set -e; curl -fsSL '$SPECIALIST_YOLO_WEIGHTS_URL' -o '$REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH.tmp'; mv '$REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH.tmp' '$REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH'"
fi

run_gcloud compute scp "$ARCHIVE_PATH" "$LOCAL_ENV_FILE" "$VM_NAME:/tmp/" --zone="$ZONE" --project="$PROJECT"
run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="set -euo pipefail; META_DIR=$REMOTE_SERVICE_DIR/.deploy-meta; mkdir -p $REMOTE_SERVICE_DIR \"\$META_DIR\"; rm -rf $REMOTE_SERVICE_DIR/package.json $REMOTE_SERVICE_DIR/package-lock.json $REMOTE_SERVICE_DIR/server; tar -xzf $REMOTE_ARCHIVE -C $REMOTE_SERVICE_DIR; sudo mv $REMOTE_ENV_FILE /etc/renovation-measurement.env; cd $REMOTE_SERVICE_DIR; if [[ ! -f \"\$META_DIR/package-lock.sha256\" ]] || [[ \"\$(cat \"\$META_DIR/package-lock.sha256\")\" != \"$PACKAGE_LOCK_HASH\" ]]; then npm ci --omit=dev --no-audit --no-fund; printf '%s' '$PACKAGE_LOCK_HASH' > \"\$META_DIR/package-lock.sha256\"; else echo 'npm dependencies unchanged; skipping npm ci'; fi; if [[ ! -f \"\$META_DIR/requirements.sha256\" ]] || [[ \"\$(cat \"\$META_DIR/requirements.sha256\")\" != \"$REQUIREMENTS_HASH\" ]]; then $REMOTE_PYTHON -m pip install --upgrade-strategy only-if-needed -r server/scripts/measurement/requirements.txt; printf '%s' '$REQUIREMENTS_HASH' > \"\$META_DIR/requirements.sha256\"; else echo 'python requirements unchanged; skipping pip install'; fi; chmod +x server/scripts/measurement/*.py; sudo systemctl restart renovation-specialist-vision.service renovation-room-geometry-assist.service renovation-measurement-api.service"

run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="set -e; $REMOTE_PYTHON -c 'from sam2.sam2_image_predictor import SAM2ImagePredictor; print(\"sam2_import_ok\")'; $REMOTE_PYTHON -c 'from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor; print(\"grounding_dino_import_ok\")'; colmap global_mapper -h >/dev/null; glomap -h >/dev/null; if [ -f '$REMOTE_SPECIALIST_YOLO_WEIGHTS_PATH' ]; then echo 'specialist_yolo_weights_present'; else echo 'specialist_yolo_weights_missing'; fi"

run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="set -e; curl -fsS http://127.0.0.1:${RENOVATION_MEASUREMENT_API_PORT:-8090}/healthz >/dev/null; curl -fsS http://127.0.0.1:${SPECIALIST_PORT:-8010}/healthz >/dev/null; curl -fsS http://127.0.0.1:${ROOM_GEOMETRY_ASSIST_PORT:-8011}/healthz >/dev/null; echo 'renovation measurement services deployed and healthy'"

SPECIALIST_HEALTH_JSON="$(run_gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="curl -fsS http://127.0.0.1:${SPECIALIST_PORT:-8010}/healthz")"
if ! printf '%s' "$SPECIALIST_HEALTH_JSON" | grep -q '"segmenterConfigured":true'; then
  echo "ERROR: specialist SAM2 segmenter is not configured on the VM: $SPECIALIST_HEALTH_JSON" >&2
  exit 1
fi

if ! printf '%s' "$SPECIALIST_HEALTH_JSON" | grep -q '"detectorConfigured":true'; then
  if [ "$REQUIRE_SPECIALIST_DETECTOR" = "true" ]; then
    echo "ERROR: specialist detector is unavailable or unloadable: $SPECIALIST_HEALTH_JSON" >&2
    exit 1
  fi
  echo "WARNING: specialist detector is still degraded or unavailable: $SPECIALIST_HEALTH_JSON" >&2
fi

SPECIALIST_DETECTOR_BACKEND_LIVE="$(printf '%s' "$SPECIALIST_HEALTH_JSON" | sed -n 's/.*"detectorBackend":"\([^"]*\)".*/\1/p' | head -n 1)"

HOST_IP="$(run_gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"

echo ""
echo "Renovation measurement VM deployed successfully"
echo "External API URL: http://${HOST_IP}:${RENOVATION_MEASUREMENT_API_PORT:-8090}"
echo "Specialist detector backend: ${SPECIALIST_DETECTOR_BACKEND_LIVE:-unknown}"
echo "Grounding DINO model: ${SPECIALIST_GROUNDING_DINO_MODEL}"
echo "Room geometry assist room types: ${ROOM_GEOMETRY_ASSIST_ROOM_TYPES}"
if [ -n "$API_SOURCE_RANGES" ]; then
  echo "Firewall rule $API_FIREWALL_RULE allows ${API_SOURCE_RANGES} to reach tcp:${RENOVATION_MEASUREMENT_API_PORT:-8090}."
else
  echo "External ingress is unchanged. Set RENOVATION_MEASUREMENT_API_SOURCE_RANGES to expose tcp:${RENOVATION_MEASUREMENT_API_PORT:-8090} via a scoped firewall rule."
fi
echo "Set RENOVATION_MEASUREMENT_API_URL=http://${HOST_IP}:${RENOVATION_MEASUREMENT_API_PORT:-8090} in the main app environment."