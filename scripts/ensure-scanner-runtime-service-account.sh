#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is not installed or not on PATH." >&2
  exit 1
fi

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

GCLOUD_WRAPPER="$ROOT_DIR/scripts/gcloud-houseyield.sh"
if [[ -f "$GCLOUD_WRAPPER" ]]; then
  GCLOUD_CMD=(bash "$GCLOUD_WRAPPER")
else
  GCLOUD_CMD=(gcloud)
fi

SCANNER_GCP_IAM_ACCOUNT="${SCANNER_GCP_IAM_ACCOUNT:-}"
SCANNER_GCP_VM_IAM_ACCOUNT="${SCANNER_GCP_VM_IAM_ACCOUNT:-${SCANNER_GCP_IAM_ACCOUNT:-}}"

SCANNER_PROJECT_ID="${SCANNER_GCP_PROJECT:-$(${GCLOUD_CMD[@]} config get-value project 2>/dev/null || true)}"
SCANNER_SERVICE_ACCOUNT_NAME="${SCANNER_GCP_SERVICE_ACCOUNT_NAME:-houseyield-scanner-runtime}"
SCANNER_SERVICE_ACCOUNT_EMAIL="${SCANNER_GCP_SERVICE_ACCOUNT:-${SCANNER_SERVICE_ACCOUNT_NAME}@${SCANNER_PROJECT_ID}.iam.gserviceaccount.com}"
DEPLOYER_ACCOUNT="${SCANNER_GCP_DEPLOYER_ACCOUNT:-$(${GCLOUD_CMD[@]} config get-value account 2>/dev/null || true)}"
TARGET_VM_PROJECT_ID="${MASTER_V1_GCP_VM_PROJECT:-${GCP_GPU_WORKER_PROJECT:-}}"
TARGET_VM_NAME="${MASTER_V1_GCP_VM_NAME:-}"
TARGET_VM_ZONE="${MASTER_V1_GCP_VM_ZONE:-}"
TARGET_VM_SERVICE_ACCOUNT="${MASTER_V1_GCP_VM_SERVICE_ACCOUNT:-}"

if [[ -z "$SCANNER_PROJECT_ID" ]]; then
  echo "SCANNER_GCP_PROJECT is not set and no active gcloud project was found." >&2
  exit 1
fi

if [[ -z "$TARGET_VM_PROJECT_ID" ]]; then
  echo "MASTER_V1_GCP_VM_PROJECT must be set so the scanner runtime account can reach the GPU VM project." >&2
  exit 1
fi

should_reauth_for_output() {
  local output="$1"
  grep -qiE 'Reauthentication required|invalid_rapt|invalid_grant|reauth related error|please run:|gcloud auth login' <<<"$output"
}

run_gcloud_checked() {
  local account="$1"
  shift
  local output=""
  local status=0

  if [[ -n "$account" ]]; then
    output="$("${GCLOUD_CMD[@]}" "$@" --account "$account" 2>&1)" || status=$?
  else
    output="$("${GCLOUD_CMD[@]}" "$@" 2>&1)" || status=$?
  fi
  if [[ "$status" -ne 0 ]]; then
    if should_reauth_for_output "$output"; then
      echo "HouseYield gcloud reauthentication is required before scanner runtime setup can continue." >&2
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
  local account="$1"
  shift
  local output=""
  local status=0

  if [[ -n "$account" ]]; then
    output="$("${GCLOUD_CMD[@]}" "$@" --account "$account" 2>&1)" || status=$?
  else
    output="$("${GCLOUD_CMD[@]}" "$@" 2>&1)" || status=$?
  fi
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi

  if should_reauth_for_output "$output"; then
    echo "HouseYield gcloud reauthentication is required before scanner runtime setup can continue." >&2
    echo "Run: npm run gcloud:houseyield:login" >&2
    echo "$output" >&2
    exit "$status"
  fi

  return 1
}

wait_for_service_account() {
  local account="$1"
  shift
  local email="$1"
  local project="$2"
  local max_attempts="${3:-15}"
  local attempt=1

  until gcloud_resource_exists "$account" iam service-accounts describe "$email" --project "$project"; do
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      echo "Service account ${email} was not visible after creation." >&2
      exit 1
    fi

    echo "==> Waiting for ${email} to become available (${attempt}/${max_attempts})"
    sleep 2
    attempt=$((attempt + 1))
  done
}

grant_project_role() {
  local account="$1"
  shift
  local project="$1"
  local member="$2"
  local role="$3"
  local target="$4"

  echo "==> Granting ${role} on ${project} to ${target}"
  run_gcloud_checked "$account" projects add-iam-policy-binding "$project" \
    --member "$member" \
    --role "$role" \
    --quiet >/dev/null
}

grant_instance_role() {
  local account="$1"
  shift
  local project="$1"
  local zone="$2"
  local instance="$3"
  local member="$4"
  local role="$5"
  local target="$6"

  echo "==> Granting ${role} on ${instance} (${zone}) to ${target}"
  run_gcloud_checked "$account" compute instances add-iam-policy-binding "$instance" \
    --project "$project" \
    --zone "$zone" \
    --member "$member" \
    --role "$role" \
    --quiet >/dev/null
}

if ! gcloud_resource_exists "$SCANNER_GCP_IAM_ACCOUNT" iam service-accounts describe "$SCANNER_SERVICE_ACCOUNT_EMAIL" --project "$SCANNER_PROJECT_ID"; then
  echo "==> Creating scanner runtime service account ${SCANNER_SERVICE_ACCOUNT_EMAIL}"
  run_gcloud_checked "$SCANNER_GCP_IAM_ACCOUNT" iam service-accounts create "$SCANNER_SERVICE_ACCOUNT_NAME" \
    --project "$SCANNER_PROJECT_ID" \
    --display-name "HouseYield scanner runtime"
  wait_for_service_account "$SCANNER_GCP_IAM_ACCOUNT" "$SCANNER_SERVICE_ACCOUNT_EMAIL" "$SCANNER_PROJECT_ID"
else
  echo "==> Scanner runtime service account ${SCANNER_SERVICE_ACCOUNT_EMAIL} already exists"
fi

if [[ -n "$TARGET_VM_NAME" && -n "$TARGET_VM_ZONE" ]]; then
  grant_instance_role \
    "$SCANNER_GCP_VM_IAM_ACCOUNT" \
    "$TARGET_VM_PROJECT_ID" \
    "$TARGET_VM_ZONE" \
    "$TARGET_VM_NAME" \
    "serviceAccount:${SCANNER_SERVICE_ACCOUNT_EMAIL}" \
    "roles/compute.instanceAdmin.v1" \
    "$SCANNER_SERVICE_ACCOUNT_EMAIL"
else
  grant_project_role \
    "$SCANNER_GCP_VM_IAM_ACCOUNT" \
    "$TARGET_VM_PROJECT_ID" \
    "serviceAccount:${SCANNER_SERVICE_ACCOUNT_EMAIL}" \
    "roles/compute.instanceAdmin.v1" \
    "$SCANNER_SERVICE_ACCOUNT_EMAIL"
fi

grant_project_role \
  "$SCANNER_GCP_VM_IAM_ACCOUNT" \
  "$TARGET_VM_PROJECT_ID" \
  "serviceAccount:${SCANNER_SERVICE_ACCOUNT_EMAIL}" \
  "roles/compute.viewer" \
  "$SCANNER_SERVICE_ACCOUNT_EMAIL"

if [[ -z "$TARGET_VM_SERVICE_ACCOUNT" && -n "$TARGET_VM_NAME" && -n "$TARGET_VM_ZONE" ]]; then
  TARGET_VM_SERVICE_ACCOUNT="$(run_gcloud_checked "$SCANNER_GCP_VM_IAM_ACCOUNT" compute instances describe "$TARGET_VM_NAME" \
    --project "$TARGET_VM_PROJECT_ID" \
    --zone "$TARGET_VM_ZONE" \
    --format='value(serviceAccounts[0].email)')"
fi

if [[ -n "$TARGET_VM_SERVICE_ACCOUNT" ]]; then
  echo "==> Granting roles/iam.serviceAccountUser on VM service account ${TARGET_VM_SERVICE_ACCOUNT} to ${SCANNER_SERVICE_ACCOUNT_EMAIL}"
  run_gcloud_checked "$SCANNER_GCP_VM_IAM_ACCOUNT" iam service-accounts add-iam-policy-binding "$TARGET_VM_SERVICE_ACCOUNT" \
    --project "$TARGET_VM_PROJECT_ID" \
    --member "serviceAccount:${SCANNER_SERVICE_ACCOUNT_EMAIL}" \
    --role roles/iam.serviceAccountUser \
    --quiet >/dev/null
fi

if [[ -n "$DEPLOYER_ACCOUNT" && "$DEPLOYER_ACCOUNT" != "(unset)" ]]; then
  deployer_member="user:${DEPLOYER_ACCOUNT}"
  if [[ "$DEPLOYER_ACCOUNT" == *gserviceaccount.com ]]; then
    deployer_member="serviceAccount:${DEPLOYER_ACCOUNT}"
  fi

  echo "==> Granting roles/iam.serviceAccountUser on ${SCANNER_SERVICE_ACCOUNT_EMAIL} to ${DEPLOYER_ACCOUNT}"
  run_gcloud_checked "$SCANNER_GCP_IAM_ACCOUNT" iam service-accounts add-iam-policy-binding "$SCANNER_SERVICE_ACCOUNT_EMAIL" \
    --project "$SCANNER_PROJECT_ID" \
    --member "$deployer_member" \
    --role roles/iam.serviceAccountUser \
    --quiet >/dev/null

  echo "==> Granting roles/iam.serviceAccountTokenCreator on ${SCANNER_SERVICE_ACCOUNT_EMAIL} to ${DEPLOYER_ACCOUNT}"
  run_gcloud_checked "$SCANNER_GCP_IAM_ACCOUNT" iam service-accounts add-iam-policy-binding "$SCANNER_SERVICE_ACCOUNT_EMAIL" \
    --project "$SCANNER_PROJECT_ID" \
    --member "$deployer_member" \
    --role roles/iam.serviceAccountTokenCreator \
    --quiet >/dev/null
fi

echo
echo "Scanner runtime service account ready: ${SCANNER_SERVICE_ACCOUNT_EMAIL}"
echo "Cloud Run deploy target project: ${SCANNER_PROJECT_ID}"
echo "GPU VM access project: ${TARGET_VM_PROJECT_ID}"
echo "Recommended next step:"
echo "SCANNER_GCP_CONFIG_ONLY=1 bash ./deploy-scanner-host.sh"