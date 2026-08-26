#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$value"
    fi
  done < ./.env
fi

PROJECT_ID="${SCANNER_GCP_PROJECT:-${BACKEND_GCP_PROJECT:-${FIREBASE_PROJECT_ID:-houseyield}}}"
REGION="${SCANNER_GCP_REGION:-us-central1}"
SERVICE_NAME="${SCANNER_GCP_SERVICE:-renovation-scanner-host}"
MIN_INSTANCES="${SCANNER_GCP_MIN_INSTANCES:-0}"
MAX_INSTANCES="${SCANNER_GCP_MAX_INSTANCES:-1}"
MEMORY="${SCANNER_GCP_MEMORY:-8Gi}"
CPU="${SCANNER_GCP_CPU:-2}"
# Keep CPU allocated between requests only when at least one instance stays warm.
CPU_THROTTLING="${SCANNER_GCP_CPU_THROTTLING:-$([[ "$MIN_INSTANCES" -gt 0 ]] && echo 0 || echo 1)}"
SERVICE_ACCOUNT_NAME="${SCANNER_GCP_SERVICE_ACCOUNT_NAME:-}"
SERVICE_ACCOUNT_EMAIL="${SCANNER_GCP_SERVICE_ACCOUNT:-}"
if [[ -z "$SERVICE_ACCOUNT_EMAIL" && -n "$SERVICE_ACCOUNT_NAME" ]]; then
  SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
fi
ARTIFACT_REPOSITORY="${SCANNER_GCP_ARTIFACT_REPOSITORY:-houseyield-backend}"
ARTIFACT_LOCATION="${SCANNER_GCP_ARTIFACT_LOCATION:-${REGION}}"
IMAGE_URI="${ARTIFACT_LOCATION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"
CONFIG_ONLY="${SCANNER_GCP_CONFIG_ONLY:-0}"
BUILD_CONTEXT="$(mktemp -d)"
FRONTEND_DIST_DIR="$(mktemp -d)"

DIST_SCANNER_EXCLUDES=(
  --exclude='.DS_Store'
  --exclude='edited-meshes'
  --exclude='floor-models'
  --exclude='floor-overlays'
  --exclude='generated-objects'
  --exclude='generated-textures'
  --exclude='mesh-segments'
  --exclude='preprocessed-meshes'
  --exclude='retextured'
  --exclude='retextured-meshes'
  --exclude='test-mesh'
  --exclude='submissions'
)

cleanup() {
  rm -rf "$BUILD_CONTEXT"
  rm -rf "$FRONTEND_DIST_DIR"
}

trap cleanup EXIT

if [[ -z "$PROJECT_ID" ]]; then
  echo "SCANNER_GCP_PROJECT is not set and BACKEND_GCP_PROJECT/FIREBASE_PROJECT_ID were not found." >&2
  exit 1
fi

if [[ "$PROJECT_ID" == "silken-slice-480417-e0" ]]; then
  echo "Refusing to deploy renovation-scanner-host to silken-slice-480417-e0." >&2
  echo "That project is for IoT/GPU workloads only. Set SCANNER_GCP_PROJECT=houseyield." >&2
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
DEFAULT_SERVICE_ACCOUNT_EMAIL=""
if [[ -n "$PROJECT_NUMBER" ]]; then
  DEFAULT_SERVICE_ACCOUNT_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

if [[ -z "${MOBILE_SCAN_TOKEN_SECRET:-}" ]]; then
  echo "MOBILE_SCAN_TOKEN_SECRET must be set before deploying the hosted scanner." >&2
  exit 1
fi

should_reauth_for_output() {
  local output="$1"
  grep -qiE 'Reauthentication required|invalid_rapt|invalid_grant|reauth related error|please run:|gcloud auth login' <<<"$output"
}

run_gcloud_checked() {
  local output=""
  local status=0

  output="$(gcloud "$@" 2>&1)" || status=$?
  if [[ "$status" -ne 0 ]]; then
    if should_reauth_for_output "$output"; then
      echo "HouseYield gcloud reauthentication is required before scanner deployment can continue." >&2
      echo "Run: npm run gcloud:houseyield:login" >&2
    fi
    echo "$output" >&2
    exit "$status"
  fi

  if [[ -n "$output" ]]; then
    echo "$output"
  fi
}

gcloud_resource_exists() {
  local output=""
  local status=0

  output="$(gcloud "$@" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi

  if should_reauth_for_output "$output"; then
    echo "HouseYield gcloud reauthentication is required before scanner deployment can continue." >&2
    echo "Run: npm run gcloud:houseyield:login" >&2
    echo "$output" >&2
    exit "$status"
  fi

  return 1
}

ensure_artifact_repository() {
  if gcloud_resource_exists artifacts repositories describe "$ARTIFACT_REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$ARTIFACT_LOCATION" >/dev/null 2>&1; then
    return 0
  fi

  echo "==> Creating Artifact Registry repository ${ARTIFACT_REPOSITORY} in ${ARTIFACT_LOCATION}"
  run_gcloud_checked artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$ARTIFACT_LOCATION" \
    --repository-format docker \
    --description "HouseYield scanner host container images"
}

ENV_VARS=(
  "NODE_ENV=production"
)

SECRET_VARS=()

append_env_if_set() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" ]]; then
    ENV_VARS+=("${key}=${value}")
  fi
}

append_env_value_if_set() {
  local key="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    ENV_VARS+=("${key}=${value}")
  fi
}

grant_secret_access() {
  local secret_name="$1"
  local runtime_service_account="${SERVICE_ACCOUNT_EMAIL:-$DEFAULT_SERVICE_ACCOUNT_EMAIL}"
  if [[ -z "$runtime_service_account" ]]; then
    return 0
  fi

  run_gcloud_checked secrets add-iam-policy-binding "$secret_name" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${runtime_service_account}" \
    --role "roles/secretmanager.secretAccessor" >/dev/null
}

upsert_secret_from_env() {
  local env_key="$1"
  local secret_name="$2"
  local value="${!env_key:-}"
  if [[ -z "$value" ]]; then
    return 0
  fi

  if ! gcloud_resource_exists secrets describe "$secret_name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run_gcloud_checked secrets create "$secret_name" \
      --project "$PROJECT_ID" \
      --replication-policy automatic >/dev/null
  fi

  printf '%s' "$value" | gcloud secrets versions add "$secret_name" \
    --project "$PROJECT_ID" \
    --data-file=- >/dev/null

  grant_secret_access "$secret_name"
  SECRET_VARS+=("${env_key}=${secret_name}:latest")
}

upsert_secret_from_env MOBILE_SCAN_TOKEN_SECRET houseyield-scanner-mobile-scan-token
upsert_secret_from_env OPENAI_API_KEY houseyield-scanner-openai-api-key
upsert_secret_from_env REPLICATE_API_KEY houseyield-scanner-replicate-api-key
upsert_secret_from_env LUMA_API_KEY houseyield-scanner-luma-api-key

append_env_if_set GCP_GPU_WORKER_ENABLE
append_env_if_set GCP_GPU_WORKER_HOST
append_env_if_set GCP_GPU_WORKER_INSTANCE
append_env_if_set GCP_GPU_WORKER_ZONE
append_env_if_set GCP_GPU_WORKER_PROJECT
append_env_if_set GCP_GPU_WORKER_USER
append_env_if_set GCP_PROCESSING_DIR
append_env_value_if_set ROOM_TOUR_GCP_WORKER_ENABLE "${ROOM_TOUR_GCP_WORKER_ENABLE:-${GCP_GPU_WORKER_ENABLE:-}}"
append_env_value_if_set ROOM_TOUR_GCP_WORKER_INSTANCE "${ROOM_TOUR_GCP_WORKER_INSTANCE:-${GCP_GPU_WORKER_INSTANCE:-}}"
append_env_value_if_set ROOM_TOUR_GCP_WORKER_ZONE "${ROOM_TOUR_GCP_WORKER_ZONE:-${GCP_GPU_WORKER_ZONE:-}}"
append_env_value_if_set ROOM_TOUR_GCP_WORKER_PROJECT "${ROOM_TOUR_GCP_WORKER_PROJECT:-${GCP_GPU_WORKER_PROJECT:-}}"
append_env_value_if_set ROOM_TOUR_GCP_WORKER_USER "${ROOM_TOUR_GCP_WORKER_USER:-${GCP_GPU_WORKER_USER:-}}"
append_env_if_set ROOM_TOUR_GCP_PROCESSING_DIR
append_env_if_set ROOM_TOUR_GCP_SERVICE_DIR
append_env_if_set MASTER_V1_GCP_WORKER_ENABLE
append_env_if_set MASTER_V1_GCP_HOST
append_env_if_set MASTER_V1_GCP_TRANSPORT
append_env_if_set MASTER_V1_GCP_VM_NAME
append_env_if_set MASTER_V1_GCP_VM_ZONE
append_env_if_set MASTER_V1_GCP_VM_PROJECT
append_env_if_set MASTER_V1_GCP_WORKER_USER
append_env_if_set MASTER_V1_GCP_KEEP_REMOTE_ARTIFACTS
append_env_if_set MASTER_V1_GCP_DATA_DIR
append_env_if_set MASTER_V1_GCP_SERVICE_DIR
append_env_if_set MASTER_V1_GCP_PYTHON_PATH
append_env_if_set MASTER_V1_GCP_SSH_KEY_PATH
append_env_value_if_set PYTHON_PATH "/opt/venv/bin/python3"

if [[ "$CONFIG_ONLY" == "1" ]]; then
  echo "==> Updating Cloud Run service ${SERVICE_NAME} configuration without rebuilding the image"
  UPDATE_ARGS=(
    run services update "$SERVICE_NAME"
    --project "$PROJECT_ID"
    --region "$REGION"
    --update-env-vars "$(IFS=,; echo "${ENV_VARS[*]}")"
  )

  if [[ ${#SECRET_VARS[@]} -gt 0 ]]; then
    UPDATE_ARGS+=(--update-secrets "$(IFS=,; echo "${SECRET_VARS[*]}")")
  fi

  if [[ -n "$SERVICE_ACCOUNT_EMAIL" ]]; then
    UPDATE_ARGS+=(--service-account "$SERVICE_ACCOUNT_EMAIL")
  fi

  run_gcloud_checked "${UPDATE_ARGS[@]}"
else
  echo "==> Building scanner host image ${IMAGE_URI}"
  ensure_artifact_repository
  echo "==> Building scanner frontend bundle"
  npx vite build --outDir "$FRONTEND_DIST_DIR"

  cp Dockerfile package.json package-lock.json "$BUILD_CONTEXT"/
  mkdir -p "$BUILD_CONTEXT/dist-scanner"
  rsync -a "${DIST_SCANNER_EXCLUDES[@]}" dist-scanner/ "$BUILD_CONTEXT/dist-scanner/"
  cp "$FRONTEND_DIST_DIR/index.html" "$BUILD_CONTEXT/dist-scanner/scanner.html"
  rm -rf "$BUILD_CONTEXT/dist-scanner/assets"
  cp -R "$FRONTEND_DIST_DIR/assets" "$BUILD_CONTEXT/dist-scanner/"
  mkdir -p "$BUILD_CONTEXT/server/routes" "$BUILD_CONTEXT/server/services" "$BUILD_CONTEXT/server/scripts" "$BUILD_CONTEXT/server/scripts/photogrammetry" "$BUILD_CONTEXT/server/scripts/photogrammetry_v2"
  cp server/auth.js "$BUILD_CONTEXT/server/"
  cp server/room-scanner.js "$BUILD_CONTEXT/server/"
  cp server/image-stitching.js "$BUILD_CONTEXT/server/"
  cp server/scanner-host.js "$BUILD_CONTEXT/server/"
  cp -R server/routes "$BUILD_CONTEXT/server/"
  cp -R server/services "$BUILD_CONTEXT/server/"
  cp server/scripts/gcp_v2_pipeline.py "$BUILD_CONTEXT/server/scripts/"
  cp server/scripts/gcp_hybrid_pipeline.py "$BUILD_CONTEXT/server/scripts/"
  cp server/scripts/requirements.txt "$BUILD_CONTEXT/server/scripts/"
  cp server/scripts/photogrammetry/*.py "$BUILD_CONTEXT/server/scripts/photogrammetry/"
  cp server/scripts/photogrammetry/*.js "$BUILD_CONTEXT/server/scripts/photogrammetry/"
  cp server/scripts/photogrammetry/requirements.txt "$BUILD_CONTEXT/server/scripts/photogrammetry/"
  cp -R server/scripts/photogrammetry/gcp_scripts "$BUILD_CONTEXT/server/scripts/photogrammetry/"
  cp server/scripts/photogrammetry_v2/*.py "$BUILD_CONTEXT/server/scripts/photogrammetry_v2/"
  cp server/scripts/stitch_panorama.py "$BUILD_CONTEXT/server/scripts/"
  cp -R server/scripts/master_pipeline "$BUILD_CONTEXT/server/scripts/"
  cp -R server/scripts/room_tour "$BUILD_CONTEXT/server/scripts/"

  run_gcloud_checked builds submit --project "$PROJECT_ID" --tag "$IMAGE_URI" "$BUILD_CONTEXT"

  echo "==> Deploying Cloud Run service ${SERVICE_NAME}"
  DEPLOY_ARGS=(
    run deploy "$SERVICE_NAME"
    --project "$PROJECT_ID"
    --region "$REGION"
    --platform managed
    --allow-unauthenticated
    --image "$IMAGE_URI"
    --port 8080
    --memory "$MEMORY"
    --cpu "$CPU"
    --min-instances "$MIN_INSTANCES"
    --timeout 3600
    --max-instances "$MAX_INSTANCES"
    --set-env-vars "$(IFS=,; echo "${ENV_VARS[*]}")"
  )

  if [[ ${#SECRET_VARS[@]} -gt 0 ]]; then
    DEPLOY_ARGS+=(--set-secrets "$(IFS=,; echo "${SECRET_VARS[*]}")")
  fi

  if [[ -n "$SERVICE_ACCOUNT_EMAIL" ]]; then
    DEPLOY_ARGS+=(--service-account "$SERVICE_ACCOUNT_EMAIL")
  fi

  if [[ "$CPU_THROTTLING" == "1" ]]; then
    DEPLOY_ARGS+=(--cpu-throttling)
  else
    DEPLOY_ARGS+=(--no-cpu-throttling)
  fi

  run_gcloud_checked "${DEPLOY_ARGS[@]}"
fi

SERVICE_URL="$(run_gcloud_checked run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"

echo
echo "Hosted scanner URL: ${SERVICE_URL}"
if [[ -n "$SERVICE_ACCOUNT_EMAIL" ]]; then
  echo "Runtime service account: ${SERVICE_ACCOUNT_EMAIL}"
fi
echo "Set SCANNER_PUBLIC_URL=${SERVICE_URL} and VITE_SCANNER_PUBLIC_URL=${SERVICE_URL} in .env for QR generation."