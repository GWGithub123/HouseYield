#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$value"
    fi
  done < "$ROOT_DIR/.env"
fi

# The master-v1 GCP worker uses compute permissions from the default Cloud SDK
# config; .env can point CLOUDSDK_CONFIG at a Firebase/admin-only config.
export CLOUDSDK_CONFIG="$HOME/.config/gcloud"

cd "$ROOT_DIR"
exec node scripts/launch-refgaussian-six-image-vm.mjs "$@"
