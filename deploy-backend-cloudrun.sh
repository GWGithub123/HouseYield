#!/usr/bin/env bash

set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is not installed or not on PATH." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

GCLOUD_HOUSEYIELD=(bash "$ROOT_DIR/scripts/gcloud-houseyield.sh")

ACTIVE_GCLOUD_ACCOUNT="$("${GCLOUD_HOUSEYIELD[@]}" config get-value account 2>/dev/null || true)"
ACTIVE_GCLOUD_PROJECT="$("${GCLOUD_HOUSEYIELD[@]}" config get-value project 2>/dev/null || true)"
echo "==> Using gcloud account: ${ACTIVE_GCLOUD_ACCOUNT:-unknown}"
echo "==> Using gcloud project: ${ACTIVE_GCLOUD_PROJECT:-unknown}"

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      if [[ -n "${!key+x}" ]]; then
        continue
      fi
      export "$key=$value"
    fi
  done < ./.env
fi

PROJECT_ID="${BACKEND_GCP_PROJECT:-${FIREBASE_PROJECT_ID:-$("${GCLOUD_HOUSEYIELD[@]}" config get-value project 2>/dev/null || true)}}"
REGION="${BACKEND_GCP_REGION:-us-central1}"
SERVICE_NAME="${BACKEND_GCP_SERVICE:-houseyield-backend}"
SERVICE_ACCOUNT_NAME="${BACKEND_GCP_SERVICE_ACCOUNT_NAME:-houseyield-backend-runtime}"
SERVICE_ACCOUNT_EMAIL="${BACKEND_GCP_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
ARTIFACT_LOCATION="${BACKEND_GCP_ARTIFACT_LOCATION:-$REGION}"
ARTIFACT_REPOSITORY="${BACKEND_GCP_ARTIFACT_REPOSITORY:-houseyield-backend}"
MEMORY="${BACKEND_GCP_MEMORY:-1Gi}"
CPU="${BACKEND_GCP_CPU:-1}"
MIN_INSTANCES="${BACKEND_GCP_MIN_INSTANCES:-0}"
BACKEND_GCP_CPU_BOOST="${BACKEND_GCP_CPU_BOOST:-1}"
# Shelly outbound WebSockets live in process memory. Until commands are routed
# through a shared broker, more than one backend instance can send an HTTP
# command to an instance that does not own the device socket. Keep this service
# single-instance so remote valve control is deterministic.
MAX_INSTANCES="${BACKEND_GCP_MAX_INSTANCES:-1}"
TIMEOUT="${BACKEND_GCP_TIMEOUT:-900}"
ALLOW_UNAUTHENTICATED="${BACKEND_GCP_ALLOW_UNAUTHENTICATED:-1}"
BACKEND_PUBLIC_URL="${BACKEND_PUBLIC_URL:-}"
IMAGE_URI="${ARTIFACT_LOCATION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"
BUILD_CONTEXT="$(mktemp -d)"
ENV_LINES_FILE="$BUILD_CONTEXT/runtime-env.list"
ENV_VARS_FILE="$BUILD_CONTEXT/runtime-env.yaml"

cleanup() {
  rm -rf "$BUILD_CONTEXT"
}

trap cleanup EXIT

if [[ -z "$PROJECT_ID" ]]; then
  echo "BACKEND_GCP_PROJECT is not set and no active gcloud project was found." >&2
  exit 1
fi

if [[ -z "$SERVICE_ACCOUNT_EMAIL" ]]; then
  echo "BACKEND_GCP_SERVICE_ACCOUNT is required." >&2
  exit 1
fi

if [[ -z "${FRONTEND_URL:-}" ]]; then
  echo "FRONTEND_URL must be set before deploying the backend so generated links point at the real app." >&2
  exit 1
fi

ensure_artifact_repository() {
  if "${GCLOUD_HOUSEYIELD[@]}" artifacts repositories describe "$ARTIFACT_REPOSITORY" \
    --location "$ARTIFACT_LOCATION" \
    --project "$PROJECT_ID" >/dev/null 2>&1; then
    return
  fi

  echo "==> Creating Artifact Registry repository ${ARTIFACT_REPOSITORY} in ${ARTIFACT_LOCATION}"
  "${GCLOUD_HOUSEYIELD[@]}" artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$ARTIFACT_LOCATION" \
    --repository-format docker \
    --description "HouseYield backend container images" >/dev/null
}

is_blacklisted_env_key() {
  case "$1" in
    BACKEND_GCP_*|SCANNER_GCP_*|HOUSEYIELD_GCLOUD_*|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_CONFIG|FIREBASE_SERVICE_ACCOUNT_PATH|NODE_ENV|PORT|PUBLIC_URL|FRONTEND_URL|GOOGLE_CLOUD_PROJECT|FIREBASE_PROJECT_ID|VITE_PUSH_SERVER_URL|VITE_PHONE_CALL_BACKEND_URL|VITE_VOICE_API_KEY|NGROK_URL|CLOUDFLARE_TUNNEL_URL)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

lookup_env_file_value() {
  local lookup_key="$1"
  local env_file
  local match_line

  for env_file in .env.development.local .env.development .env.local .env; do
    [[ -f "$env_file" ]] || continue

    match_line="$(grep -m1 "^${lookup_key}=" "$env_file" || true)"
    if [[ -n "$match_line" ]]; then
      printf '%s' "${match_line#*=}"
      return 0
    fi
  done

  return 1
}

append_env_line() {
  local key="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_LINES_FILE"
  fi
}

append_env_line NODE_ENV production
append_env_line GOOGLE_CLOUD_PROJECT "$PROJECT_ID"
append_env_line FIREBASE_PROJECT_ID "${FIREBASE_PROJECT_ID:-$PROJECT_ID}"
append_env_line FRONTEND_URL "$FRONTEND_URL"
append_env_line ALLOWED_ORIGINS "${ALLOWED_ORIGINS:-}"

if [[ -n "$BACKEND_PUBLIC_URL" ]]; then
  append_env_line PUBLIC_URL "$BACKEND_PUBLIC_URL"
fi

VOICE_API_KEY_VALUE="${VOICE_API_KEY:-}"
if [[ -z "$VOICE_API_KEY_VALUE" ]]; then
  VOICE_API_KEY_VALUE="${VITE_VOICE_API_KEY:-}"
fi
if [[ -z "$VOICE_API_KEY_VALUE" ]]; then
  VOICE_API_KEY_VALUE="$(lookup_env_file_value VOICE_API_KEY || true)"
fi
if [[ -z "$VOICE_API_KEY_VALUE" ]]; then
  VOICE_API_KEY_VALUE="$(lookup_env_file_value VITE_VOICE_API_KEY || true)"
fi

append_env_line VOICE_API_KEY "$VOICE_API_KEY_VALUE"

STAFF_EMAILS_VALUE="${HOUSEYIELD_INTERNAL_STAFF_EMAILS:-}"
if [[ -z "$STAFF_EMAILS_VALUE" ]]; then
  STAFF_EMAILS_VALUE="$(lookup_env_file_value HOUSEYIELD_INTERNAL_STAFF_EMAILS || true)"
fi
if [[ -z "$STAFF_EMAILS_VALUE" ]]; then
  STAFF_EMAILS_VALUE="$(lookup_env_file_value VITE_INTERNAL_STAFF_EMAILS || true)"
fi
append_env_line HOUSEYIELD_INTERNAL_STAFF_EMAILS "$STAFF_EMAILS_VALUE"
if [[ -z "$STAFF_EMAILS_VALUE" ]]; then
  echo "Warning: HOUSEYIELD_INTERNAL_STAFF_EMAILS is not configured; internal ops endpoints (/api/attom/absentee-search, /api/internal/*) will return 503." >&2
fi

if [[ -z "$VOICE_API_KEY_VALUE" ]]; then
  echo "Warning: VOICE_API_KEY is not configured for Cloud Run deploy; production /api/voice/* routes will return Server configuration error." >&2
fi

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi

    if is_blacklisted_env_key "$key"; then
      continue
    fi

    append_env_line "$key" "$value"
  done < ./.env
fi

node - "$ENV_LINES_FILE" "$ENV_VARS_FILE" <<'EOF'
const fs = require('fs');

const [linesPath, yamlPath] = process.argv.slice(2);
const lines = fs.readFileSync(linesPath, 'utf8').split(/\r?\n/).filter(Boolean);
const envMap = new Map();

for (const line of lines) {
  const separator = line.indexOf('=');
  if (separator <= 0) continue;
  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);
  envMap.set(key, value);
}

const yaml = Array.from(envMap.entries())
  .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  .join('\n') + '\n';

fs.writeFileSync(yamlPath, yaml);
EOF

echo "==> Building backend image ${IMAGE_URI}"
cp Dockerfile.backend "$BUILD_CONTEXT/Dockerfile"
cp package.json package-lock.json "$BUILD_CONTEXT/"
mkdir -p "$BUILD_CONTEXT/src"
mkdir -p "$BUILD_CONTEXT/server"
rsync -a \
  --exclude='data/' \
  --exclude='temp/' \
  --exclude='uploads/' \
  --exclude='renovation/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.DS_Store' \
  server/ "$BUILD_CONTEXT/server/"
mkdir -p "$BUILD_CONTEXT/server/data"
cp server/data/insurers.js "$BUILD_CONTEXT/server/data/insurers.js"
cp -R backend "$BUILD_CONTEXT/backend"
cp -R landing "$BUILD_CONTEXT/landing"
mkdir -p "$BUILD_CONTEXT/public"
rsync -a \
  --exclude='edited-meshes/' \
  --exclude='retextured/' \
  --exclude='retextured-meshes/' \
  --exclude='floor-models/' \
  --exclude='floor-overlays/' \
  --exclude='mesh-segments/' \
  --exclude='generated-textures/' \
  --exclude='generated-objects/' \
  --exclude='preprocessed-meshes/' \
  --exclude='test-mesh/' \
  --exclude='.DS_Store' \
  public/ "$BUILD_CONTEXT/public/"
cp -R src/shared "$BUILD_CONTEXT/src/shared"
# server/index.js imports this at boot — must be in the Cloud Build context.
mkdir -p "$BUILD_CONTEXT/src/utils"
cp src/utils/rentalVacancyModel.js "$BUILD_CONTEXT/src/utils/rentalVacancyModel.js"

# Keep 3D scanner and photogrammetry workloads on the dedicated scanner host.
rm -rf \
  "$BUILD_CONTEXT/server/image-stitching.js" \
  "$BUILD_CONTEXT/server/scanner-host.js" \
  "$BUILD_CONTEXT/server/routes/photogrammetry.js" \
  "$BUILD_CONTEXT/server/routes/room-tours.js" \
  "$BUILD_CONTEXT/server/routes/mesh-editor.js" \
  "$BUILD_CONTEXT/server/routes/mesh-segmentation.js" \
  "$BUILD_CONTEXT/server/routes/mesh-preprocessing.js" \
  "$BUILD_CONTEXT/server/services/roomTourPipeline.js" \
  "$BUILD_CONTEXT/server/services/roomTourGcpWorker.js" \
  "$BUILD_CONTEXT/server/scripts/photogrammetry" \
  "$BUILD_CONTEXT/server/scripts/photogrammetry_v2" \
  "$BUILD_CONTEXT/server/scripts/room_tour" \
  "$BUILD_CONTEXT/server/scripts/gcp_hybrid_pipeline.py" \
  "$BUILD_CONTEXT/server/scripts/gcp_v2_pipeline.py" \
  "$BUILD_CONTEXT/server/scripts/stitch_panorama.py" \
  "$BUILD_CONTEXT/server/scripts/preprocess_mesh.py" \
  "$BUILD_CONTEXT/server/scripts/mesh_editor.py" \
  "$BUILD_CONTEXT/server/scripts/mesh_segmentation.py"

rm -rf "$BUILD_CONTEXT/server/data/bookkeeping" \
  "$BUILD_CONTEXT/server/data/stripe-connect" \
  "$BUILD_CONTEXT/server/data/income-verification" \
  "$BUILD_CONTEXT/server/data/plaid" \
  "$BUILD_CONTEXT/server/data/voice-identity" \
  "$BUILD_CONTEXT/server/data/room-scans" 2>/dev/null || true
rm -rf \
  "$BUILD_CONTEXT/server/temp" \
  "$BUILD_CONTEXT/server/uploads" \
  "$BUILD_CONTEXT/server/scripts/photogrammetry/venv"
rm -rf \
  "$BUILD_CONTEXT/public/edited-meshes" \
  "$BUILD_CONTEXT/public/retextured" \
  "$BUILD_CONTEXT/public/retextured-meshes" \
  "$BUILD_CONTEXT/public/floor-models" \
  "$BUILD_CONTEXT/public/floor-overlays" \
  "$BUILD_CONTEXT/public/mesh-segments" \
  "$BUILD_CONTEXT/public/generated-textures" \
  "$BUILD_CONTEXT/public/generated-objects" \
  "$BUILD_CONTEXT/public/preprocessed-meshes" \
  "$BUILD_CONTEXT/public/test-mesh"
mkdir -p \
  "$BUILD_CONTEXT/public/edited-meshes" \
  "$BUILD_CONTEXT/public/retextured" \
  "$BUILD_CONTEXT/public/retextured-meshes" \
  "$BUILD_CONTEXT/public/floor-models" \
  "$BUILD_CONTEXT/public/floor-overlays" \
  "$BUILD_CONTEXT/public/mesh-segments" \
  "$BUILD_CONTEXT/public/generated-textures" \
  "$BUILD_CONTEXT/public/generated-objects" \
  "$BUILD_CONTEXT/public/preprocessed-meshes" \
  "$BUILD_CONTEXT/public/test-mesh"
find "$BUILD_CONTEXT/server" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$BUILD_CONTEXT/server" -type f \( -name '*.pyc' -o -name '.DS_Store' \) -delete

ensure_artifact_repository

"${GCLOUD_HOUSEYIELD[@]}" builds submit --project "$PROJECT_ID" --tag "$IMAGE_URI" "$BUILD_CONTEXT"

echo "==> Deploying Cloud Run service ${SERVICE_NAME}"
DEPLOY_ARGS=(
  run deploy "$SERVICE_NAME"
  --project "$PROJECT_ID"
  --region "$REGION"
  --platform managed
  --image "$IMAGE_URI"
  --port 8080
  --memory "$MEMORY"
  --cpu "$CPU"
  --min-instances "$MIN_INSTANCES"
  --max-instances "$MAX_INSTANCES"
  --timeout "$TIMEOUT"
  --service-account "$SERVICE_ACCOUNT_EMAIL"
  --env-vars-file "$ENV_VARS_FILE"
)

if [[ "$BACKEND_GCP_CPU_BOOST" == "1" ]]; then
  DEPLOY_ARGS+=(--cpu-boost)
  echo "==> CPU boost enabled for faster cold starts"
fi

if [[ "$ALLOW_UNAUTHENTICATED" == "1" ]]; then
  DEPLOY_ARGS+=(--no-invoker-iam-check)
else
  DEPLOY_ARGS+=(--invoker-iam-check)
fi

"${GCLOUD_HOUSEYIELD[@]}" "${DEPLOY_ARGS[@]}"

SERVICE_URL="$("${GCLOUD_HOUSEYIELD[@]}" run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

if [[ -z "$BACKEND_PUBLIC_URL" ]]; then
  BACKEND_PUBLIC_URL="$SERVICE_URL"
fi

echo "==> Setting backend PUBLIC_URL to ${BACKEND_PUBLIC_URL}"
"${GCLOUD_HOUSEYIELD[@]}" run services update "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --update-env-vars "PUBLIC_URL=${BACKEND_PUBLIC_URL}"

MAINTENANCE_PRACTICE_MODE="${MAINTENANCE_PRACTICE_MODE:-1}"
TWILIO_TEST_TO_NUMBER="${TWILIO_TEST_TO_NUMBER:-+12026420437}"
MAINTENANCE_OWNER_SMS_TEST_PHONE="${MAINTENANCE_OWNER_SMS_TEST_PHONE:-$TWILIO_TEST_TO_NUMBER}"
MAINTENANCE_PRACTICE_TEST_PHONES="${MAINTENANCE_PRACTICE_TEST_PHONES:-Griffin (DC) — (202) 642-0437|+12026420437}"
MAINTENANCE_PRACTICE_CALL_PHONE="${MAINTENANCE_PRACTICE_CALL_PHONE:-+12026420437}"
echo "==> Enabling maintenance owner SMS + practice call routing on Cloud Run"
"${GCLOUD_HOUSEYIELD[@]}" run services update "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --update-env-vars "^@^MAINTENANCE_PRACTICE_MODE=${MAINTENANCE_PRACTICE_MODE}@MAINTENANCE_OWNER_SMS_ENABLED=1@MAINTENANCE_OWNER_SMS_BLOCK_DISPATCH=1@MAINTENANCE_OWNER_SMS_REQUIRE_PROVIDER_APPROVAL=1@AUTO_MONITOR_EMAILS=false@TWILIO_TEST_TO_NUMBER=${TWILIO_TEST_TO_NUMBER}@MAINTENANCE_OWNER_SMS_TEST_PHONE=${MAINTENANCE_OWNER_SMS_TEST_PHONE}@MAINTENANCE_PRACTICE_CALL_PHONE=${MAINTENANCE_PRACTICE_CALL_PHONE}@MAINTENANCE_PRACTICE_TEST_PHONES=${MAINTENANCE_PRACTICE_TEST_PHONES}"

echo
echo "Backend URL: ${SERVICE_URL}"
echo "Runtime service account: ${SERVICE_ACCOUNT_EMAIL}"
echo "Set VITE_PHONE_CALL_BACKEND_URL=${SERVICE_URL} in the local frontend environment to route phone calls through Cloud Run without ngrok."
echo "Set VITE_PUSH_SERVER_URL=${SERVICE_URL} only if you want the entire frontend API surface to use Cloud Run."