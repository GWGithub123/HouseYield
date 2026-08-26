#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

should_override_from_dotenv() {
  case "$1" in
    SCANNER_PUBLIC_URL|VITE_SCANNER_PUBLIC_URL|CLOUDSDK_CONFIG|GOOGLE_APPLICATION_CREDENTIALS|MASTER_V1_GCP_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && { should_override_from_dotenv "$key" || [[ -z "${!key+x}" ]]; }; then
      export "$key=$value"
    fi
  done < "$ROOT_DIR/.env"
fi

export CLOUDSDK_CONFIG="${CLOUDSDK_CONFIG:-$HOME/.config/gcloud-myhouseyield}"
export FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT="${FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT:-1}"
export HOUSEYIELD_AUTO_GCLOUD_LOGIN="${HOUSEYIELD_AUTO_GCLOUD_LOGIN:-1}"
export RENOVATION_MEASUREMENT_API_URL="${RENOVATION_MEASUREMENT_API_URL:-http://35.243.185.85:8090}"
export RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK="${RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK:-false}"
export RENOVATION_MEASUREMENT_API_TIMEOUT_MS="${RENOVATION_MEASUREMENT_API_TIMEOUT_MS:-600000}"

PROJECT_ID="${BACKEND_GCP_PROJECT:-${FIREBASE_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-houseyield}}}"
SERVICE_ACCOUNT_NAME="${BACKEND_GCP_SERVICE_ACCOUNT_NAME:-houseyield-backend-runtime}"
export FIREBASE_IMPERSONATE_SERVICE_ACCOUNT="${FIREBASE_IMPERSONATE_SERVICE_ACCOUNT:-${BACKEND_GCP_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}}"
export FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH="${FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH:-$CLOUDSDK_CONFIG/houseyield-service-account-credentials.json}"

default_adc_path="$CLOUDSDK_CONFIG/application_default_credentials.json"
service_account_path="${FIREBASE_SERVICE_ACCOUNT_PATH:-}"
use_explicit_service_account=0

if [[ -n "$service_account_path" ]]; then
  if [[ -f "$service_account_path" ]]; then
    use_explicit_service_account=1
    export FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT=0
    export GOOGLE_APPLICATION_CREDENTIALS="$service_account_path"
  else
    echo "⚠️  FIREBASE_SERVICE_ACCOUNT_PATH not found at $service_account_path; continuing with gcloud service-account impersonation." >&2
  fi
fi

if [[ "$use_explicit_service_account" -eq 0 ]] && [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" || "${GOOGLE_APPLICATION_CREDENTIALS}" == "$default_adc_path" ]]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH"
fi

if [[ "${1:-}" == "--print-env" ]]; then
  printf 'SCANNER_PUBLIC_URL=%s\n' "${SCANNER_PUBLIC_URL:-}"
  printf 'VITE_SCANNER_PUBLIC_URL=%s\n' "${VITE_SCANNER_PUBLIC_URL:-}"
  printf 'RENOVATION_MEASUREMENT_API_URL=%s\n' "$RENOVATION_MEASUREMENT_API_URL"
  printf 'RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK=%s\n' "$RENOVATION_MEASUREMENT_API_ALLOW_LOCAL_FALLBACK"
  printf 'RENOVATION_MEASUREMENT_API_TIMEOUT_MS=%s\n' "$RENOVATION_MEASUREMENT_API_TIMEOUT_MS"
  printf 'CLOUDSDK_CONFIG=%s\n' "$CLOUDSDK_CONFIG"
  printf 'FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT=%s\n' "$FIREBASE_USE_GCLOUD_SERVICE_ACCOUNT"
  printf 'HOUSEYIELD_AUTO_GCLOUD_LOGIN=%s\n' "$HOUSEYIELD_AUTO_GCLOUD_LOGIN"
  printf 'FIREBASE_SERVICE_ACCOUNT_PATH=%s\n' "$service_account_path"
  printf 'FIREBASE_IMPERSONATE_SERVICE_ACCOUNT=%s\n' "$FIREBASE_IMPERSONATE_SERVICE_ACCOUNT"
  printf 'FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH=%s\n' "$FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH"
  printf 'GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$GOOGLE_APPLICATION_CREDENTIALS"
  exit 0
fi

backend_only=0
if [[ "${1:-}" == "--backend-only" ]]; then
  backend_only=1
  shift
fi

cd "$ROOT_DIR"

should_auto_login_for_output() {
  local output="$1"
  grep -qiE 'invalid_rapt|invalid_grant|reauth related error|unable to impersonate|gcloud service-account credentials are required|Missing source gcloud credential file|not impersonating' <<<"$output"
}

ensure_local_gcloud_service_account_auth() {
  local output=""
  local status=0

  output="$(bash ./scripts/gcloud-houseyield-service-account.sh 2>&1)" || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "$output" >&2
    if [[ "$HOUSEYIELD_AUTO_GCLOUD_LOGIN" == "1" ]] && should_auto_login_for_output "$output"; then
      echo "==> Refreshing HouseYield gcloud login for local backend auth..."
      bash ./scripts/gcloud-houseyield-login.sh
    else
      return "$status"
    fi
  fi

  output="$(node ./scripts/check-gcloud-service-account-auth.cjs 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "$output"
    return 0
  fi

  echo "$output" >&2
  if [[ "$HOUSEYIELD_AUTO_GCLOUD_LOGIN" == "1" ]] && should_auto_login_for_output "$output"; then
    echo "==> Refreshing HouseYield gcloud login for local backend auth..."
    bash ./scripts/gcloud-houseyield-login.sh
    node ./scripts/check-gcloud-service-account-auth.cjs
    return 0
  fi

  return "$status"
}

if [[ "$use_explicit_service_account" -eq 1 ]]; then
  echo "🔐 Using FIREBASE_SERVICE_ACCOUNT_PATH for local backend auth: $service_account_path"
else
  ensure_local_gcloud_service_account_auth
fi

# Backend watcher stays off for now. `--watch-path=./server` restart-loops on
# DB/log writes; empty `"${WATCH_ARGS[@]}"` under `set -u` also crashed startup.
# Restart manually after server/ edits until a safer watcher is wired in.
if [[ "$backend_only" -eq 1 ]]; then
  exec node server/index.js "$@"
fi

exec node server/dev-local.js "$@"