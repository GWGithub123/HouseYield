#!/usr/bin/env bash

set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is not installed or not on PATH." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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

PROJECT_ID="${BACKEND_GCP_PROJECT:-${FIREBASE_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
SERVICE_ACCOUNT_NAME="${BACKEND_GCP_SERVICE_ACCOUNT_NAME:-houseyield-backend-runtime}"
SERVICE_ACCOUNT_EMAIL="${BACKEND_GCP_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"
DEPLOYER_ACCOUNT="${BACKEND_GCP_DEPLOYER_ACCOUNT:-$(gcloud config get-value account 2>/dev/null || true)}"
RUNTIME_ROLES=(
  "roles/datastore.user"
  "roles/storage.objectViewer"
  "roles/storage.objectCreator"
)
BUILD_SERVICE_ACCOUNT="$(gcloud builds get-default-service-account --project "$PROJECT_ID" 2>/dev/null || true)"
BUILD_SERVICE_ACCOUNT_ROLES=(
  "roles/artifactregistry.writer"
  "roles/logging.logWriter"
  "roles/storage.objectViewer"
)

if [[ -z "$PROJECT_ID" ]]; then
  echo "BACKEND_GCP_PROJECT is not set and no active gcloud project was found." >&2
  exit 1
fi

if [[ -n "${BACKEND_GCP_EXTRA_RUNTIME_ROLES:-}" ]]; then
  IFS=',' read -r -a extra_roles <<< "$BACKEND_GCP_EXTRA_RUNTIME_ROLES"
  for role in "${extra_roles[@]}"; do
    [[ -n "$role" ]] && RUNTIME_ROLES+=("$role")
  done
fi

if [[ -n "${BACKEND_GCP_EXTRA_BUILD_ROLES:-}" ]]; then
  IFS=',' read -r -a extra_build_roles <<< "$BACKEND_GCP_EXTRA_BUILD_ROLES"
  for role in "${extra_build_roles[@]}"; do
    [[ -n "$role" ]] && BUILD_SERVICE_ACCOUNT_ROLES+=("$role")
  done
fi

wait_for_service_account() {
  local max_attempts="${1:-15}"
  local attempt=1

  until gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; do
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      echo "Service account ${SERVICE_ACCOUNT_EMAIL} was not visible after creation." >&2
      exit 1
    fi

    echo "==> Waiting for ${SERVICE_ACCOUNT_EMAIL} to become available (${attempt}/${max_attempts})"
    sleep 2
    attempt=$((attempt + 1))
  done
}

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  --project "$PROJECT_ID" >/dev/null

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> Creating service account ${SERVICE_ACCOUNT_EMAIL}"
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --project "$PROJECT_ID" \
    --display-name "HouseYield backend runtime"
  wait_for_service_account
else
  echo "==> Service account ${SERVICE_ACCOUNT_EMAIL} already exists"
fi

grant_project_role() {
  local member="$1"
  local role="$2"
  local target_account="$3"

  echo "==> Granting ${role} to ${target_account}"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "$member" \
    --role "$role" \
    --quiet >/dev/null
}

for role in "${RUNTIME_ROLES[@]}"; do
  grant_project_role "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" "$role" "$SERVICE_ACCOUNT_EMAIL"
done

if [[ -n "$BUILD_SERVICE_ACCOUNT" && "$BUILD_SERVICE_ACCOUNT" != "(unset)" ]]; then
  for role in "${BUILD_SERVICE_ACCOUNT_ROLES[@]}"; do
    grant_project_role "serviceAccount:${BUILD_SERVICE_ACCOUNT}" "$role" "$BUILD_SERVICE_ACCOUNT"
  done
fi

if [[ -n "$DEPLOYER_ACCOUNT" && "$DEPLOYER_ACCOUNT" != "(unset)" ]]; then
  deployer_member="user:${DEPLOYER_ACCOUNT}"
  if [[ "$DEPLOYER_ACCOUNT" == *gserviceaccount.com ]]; then
    deployer_member="serviceAccount:${DEPLOYER_ACCOUNT}"
  fi

  echo "==> Granting roles/iam.serviceAccountUser on ${SERVICE_ACCOUNT_EMAIL} to ${DEPLOYER_ACCOUNT}"
  gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
    --project "$PROJECT_ID" \
    --member "$deployer_member" \
    --role roles/iam.serviceAccountUser \
    --quiet >/dev/null

  echo "==> Granting roles/iam.serviceAccountTokenCreator on ${SERVICE_ACCOUNT_EMAIL} to ${DEPLOYER_ACCOUNT}"
  gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
    --project "$PROJECT_ID" \
    --member "$deployer_member" \
    --role roles/iam.serviceAccountTokenCreator \
    --quiet >/dev/null
fi

echo
echo "Backend runtime service account ready: ${SERVICE_ACCOUNT_EMAIL}"
if [[ -n "$BUILD_SERVICE_ACCOUNT" && "$BUILD_SERVICE_ACCOUNT" != "(unset)" ]]; then
  echo "Cloud Build service account ready: ${BUILD_SERVICE_ACCOUNT}"
fi
echo "Add this to .env if it is not already set:"
echo "BACKEND_GCP_SERVICE_ACCOUNT=${SERVICE_ACCOUNT_EMAIL}"