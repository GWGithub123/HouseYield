#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CLOUDSDK_CONFIG="${CLOUDSDK_CONFIG:-$HOME/.config/gcloud-myhouseyield}"

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < ./.env
fi

PROJECT_ID="${BACKEND_GCP_PROJECT:-${FIREBASE_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-houseyield}}}"
SERVICE_ACCOUNT_NAME="${BACKEND_GCP_SERVICE_ACCOUNT_NAME:-houseyield-backend-runtime}"
SERVICE_ACCOUNT_EMAIL="${FIREBASE_IMPERSONATE_SERVICE_ACCOUNT:-${BACKEND_GCP_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}}"
SOURCE_CREDENTIAL_PATH="${FIREBASE_GCLOUD_SOURCE_CREDENTIAL_PATH:-$CLOUDSDK_CONFIG/application_default_credentials.json}"
TARGET_CREDENTIAL_PATH="${FIREBASE_GCLOUD_SERVICE_ACCOUNT_CREDENTIAL_PATH:-$CLOUDSDK_CONFIG/houseyield-service-account-credentials.json}"

if [[ ! -f "$SOURCE_CREDENTIAL_PATH" ]]; then
  echo "Missing source gcloud credential file at $SOURCE_CREDENTIAL_PATH" >&2
  echo "Run: npm run gcloud:houseyield:login" >&2
  exit 1
fi

export PROJECT_ID SERVICE_ACCOUNT_EMAIL SOURCE_CREDENTIAL_PATH TARGET_CREDENTIAL_PATH

node <<'NODE'
const fs = require('fs');

const sourcePath = process.env.SOURCE_CREDENTIAL_PATH;
const targetPath = process.env.TARGET_CREDENTIAL_PATH;
const projectId = process.env.PROJECT_ID;
const serviceAccountEmail = process.env.SERVICE_ACCOUNT_EMAIL;

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

if (source.type !== 'authorized_user') {
  if (
    source.type === 'impersonated_service_account'
    && typeof source.service_account_impersonation_url === 'string'
    && source.service_account_impersonation_url.includes(serviceAccountEmail)
  ) {
    fs.writeFileSync(targetPath, `${JSON.stringify(source, null, 2)}\n`);
    console.log(`Credential file already impersonates ${serviceAccountEmail}: ${targetPath}`);
    process.exit(0);
  }

  throw new Error(`Expected authorized_user source credential at ${sourcePath}, found ${source.type || 'unknown'}`);
}

const impersonatedConfig = {
  type: 'impersonated_service_account',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`,
  source_credentials: source,
  delegates: [],
  quota_project_id: projectId,
  universe_domain: source.universe_domain || 'googleapis.com'
};

fs.writeFileSync(targetPath, `${JSON.stringify(impersonatedConfig, null, 2)}\n`);
console.log(`Wrote service-account credential file: ${targetPath}`);
NODE