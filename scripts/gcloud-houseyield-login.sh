#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOGIN_ACCOUNT="${HOUSEYIELD_GCLOUD_LOGIN_ACCOUNT:-admin@myhouseyield.com}"
PROJECT_ID="${HOUSEYIELD_GCLOUD_PROJECT:-houseyield}"
USE_NO_LAUNCH_BROWSER="${HOUSEYIELD_GCLOUD_NO_LAUNCH_BROWSER:-1}"

if [[ "${1:-}" == "--help" ]]; then
  cat <<EOF
Refresh the isolated HouseYield gcloud login and ADC, then rebuild the impersonated backend credential.

Environment overrides:
  HOUSEYIELD_GCLOUD_LOGIN_ACCOUNT   Account email to log in with (default: ${LOGIN_ACCOUNT})
  HOUSEYIELD_GCLOUD_NO_LAUNCH_BROWSER  Print a copy/paste auth URL instead of opening the browser automatically (default: ${USE_NO_LAUNCH_BROWSER})
EOF
  exit 0
fi

unset GOOGLE_APPLICATION_CREDENTIALS

login_help="$(bash ./scripts/gcloud-houseyield.sh auth login --help 2>/dev/null || true)"
bash ./scripts/gcloud-houseyield.sh auth application-default revoke --quiet >/dev/null 2>&1 || true

login_args=(auth login --force)
if [[ "$USE_NO_LAUNCH_BROWSER" == "1" ]]; then
  login_args+=(--no-launch-browser)
fi

if grep -q -- '--update-adc' <<<"$login_help"; then
  login_args+=(--update-adc)
  bash ./scripts/gcloud-houseyield.sh "${login_args[@]}" "$LOGIN_ACCOUNT"
else
  bash ./scripts/gcloud-houseyield.sh "${login_args[@]}" "$LOGIN_ACCOUNT"
  bash ./scripts/gcloud-houseyield.sh auth application-default login
fi

bash ./scripts/gcloud-houseyield.sh config set project "$PROJECT_ID" >/dev/null
bash ./scripts/gcloud-houseyield.sh auth application-default set-quota-project "$PROJECT_ID" >/dev/null 2>&1 || true

bash ./scripts/gcloud-houseyield-service-account.sh
