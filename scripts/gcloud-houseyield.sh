#!/usr/bin/env bash

set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is not installed or not on PATH." >&2
  exit 1
fi

HOUSEYIELD_GCLOUD_CONFIG_DIR="${HOUSEYIELD_GCLOUD_CONFIG_DIR:-$HOME/.config/gcloud-myhouseyield}"
HOUSEYIELD_GCLOUD_CONFIG_NAME="${HOUSEYIELD_GCLOUD_CONFIG_NAME:-houseyield}"
HOUSEYIELD_GCLOUD_PROJECT="${HOUSEYIELD_GCLOUD_PROJECT:-houseyield}"

export CLOUDSDK_CONFIG="$HOUSEYIELD_GCLOUD_CONFIG_DIR"

if [[ "${1:-}" == "--print-env" ]]; then
  printf 'CLOUDSDK_CONFIG=%s\n' "$CLOUDSDK_CONFIG"
  printf 'CLOUDSDK_ACTIVE_CONFIG_NAME=%s\n' "$HOUSEYIELD_GCLOUD_CONFIG_NAME"
  printf 'GOOGLE_CLOUD_PROJECT=%s\n' "$HOUSEYIELD_GCLOUD_PROJECT"
  printf 'ADC_PATH=%s\n' "$CLOUDSDK_CONFIG/application_default_credentials.json"
  exit 0
fi

mkdir -p "$CLOUDSDK_CONFIG"

existing_configs="$(gcloud config configurations list --format='value(name)' 2>/dev/null || true)"
if ! grep -Fxq "$HOUSEYIELD_GCLOUD_CONFIG_NAME" <<<"$existing_configs"; then
  gcloud config configurations create "$HOUSEYIELD_GCLOUD_CONFIG_NAME" --quiet >/dev/null 2>&1
fi

gcloud config configurations activate "$HOUSEYIELD_GCLOUD_CONFIG_NAME" --quiet >/dev/null 2>&1

current_project="$(gcloud config configurations describe "$HOUSEYIELD_GCLOUD_CONFIG_NAME" --format='value(properties.core.project)' 2>/dev/null || true)"
has_explicit_project_arg=false
for arg in "$@"; do
  if [[ "$arg" == "--project" || "$arg" == --project=* ]]; then
    has_explicit_project_arg=true
    break
  fi
done

if [[ "$current_project" != "$HOUSEYIELD_GCLOUD_PROJECT" && "$has_explicit_project_arg" != "true" ]]; then
  if [[ "${1:-}" != "auth" ]]; then
    if ! gcloud config set project "$HOUSEYIELD_GCLOUD_PROJECT" --quiet >/dev/null 2>&1; then
      echo "Warning: unable to set default gcloud project to $HOUSEYIELD_GCLOUD_PROJECT; continuing with explicit command arguments." >&2
    fi
  fi
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: bash ./scripts/gcloud-houseyield.sh <gcloud args>"
  echo "Example: bash ./scripts/gcloud-houseyield.sh auth login admin@myhouseyield.com"
  exit 1
fi

exec gcloud "$@"