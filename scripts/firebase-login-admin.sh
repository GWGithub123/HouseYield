#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CLOUDSDK_CONFIG="${HOUSEYIELD_GCLOUD_CONFIG_DIR:-$HOME/.config/gcloud-myhouseyield}"

echo "Firebase CLI must use admin@myhouseyield.com to deploy to the houseyield project."
echo ""
echo "If you only see houseyield@gmail.com, that is because Firebase is re-authenticating"
echo "the account it already has saved. Do NOT click Allow on that screen."
echo ""
echo "Run these commands instead:"
echo ""
echo "  npx firebase-tools logout"
echo "  CLOUDSDK_CONFIG=$CLOUDSDK_CONFIG npx firebase-tools login"
echo ""
echo "When Google opens:"
echo "  1. Click 'Use another account' (not Allow on houseyield@gmail.com)"
echo "  2. Sign in as admin@myhouseyield.com"
echo ""
echo "Or add admin as a second Firebase CLI account:"
echo ""
echo "  CLOUDSDK_CONFIG=$CLOUDSDK_CONFIG npx firebase-tools login:add"
echo "  npx firebase-tools login:use admin@myhouseyield.com"
echo ""
echo "Then verify with:"
echo "  npx firebase-tools login:list"
echo ""
read -r -p "Press Enter after admin@myhouseyield.com shows in login:list..."

ACTIVE_FIREBASE_ACCOUNT="$(npx --yes firebase-tools@latest login:list 2>/dev/null | sed -n 's/^Logged in as //p' | head -1)"
if [[ "$ACTIVE_FIREBASE_ACCOUNT" != "admin@myhouseyield.com" ]]; then
  echo "Still not logged in as admin@myhouseyield.com (got: ${ACTIVE_FIREBASE_ACCOUNT:-none})." >&2
  exit 1
fi

echo "Logged in as admin@myhouseyield.com"
