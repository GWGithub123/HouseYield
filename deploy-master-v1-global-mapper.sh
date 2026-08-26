#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_INSTALLER="$SCRIPT_DIR/server/scripts/master_pipeline/install_global_mapper_vm.sh"
REMOTE_DIR="${MASTER_V1_GCP_BOOTSTRAP_DIR:-/opt/master-v1-service/bootstrap}"

if [ -f "$SCRIPT_DIR/.env" ]; then
    MASTER_V1_ENV_VARS=$(grep -E '^MASTER_V1_GCP_' "$SCRIPT_DIR/.env" | xargs || true)
    if [ -n "$MASTER_V1_ENV_VARS" ]; then
        export $MASTER_V1_ENV_VARS
    fi
fi

VM_NAME="${1:-${MASTER_V1_GCP_VM_NAME:-master-v1-gpu-2xl4-uscentral1a}}"
ZONE="${2:-${MASTER_V1_GCP_VM_ZONE:-us-central1-a}}"
PROJECT="${3:-${MASTER_V1_GCP_VM_PROJECT:-silken-slice-480417-e0}}"

if [ ! -f "$LOCAL_INSTALLER" ]; then
    echo "ERROR: installer not found at $LOCAL_INSTALLER" >&2
    exit 1
fi

echo "=============================================="
echo "Provisioning Master v1 Global Mapper on VM"
echo "=============================================="
echo "Project: $PROJECT"
echo "VM: $VM_NAME"
echo "Zone: $ZONE"
echo ""

VM_STATUS=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --format='get(status)' 2>/dev/null || echo "NOT_FOUND")
if [ "$VM_STATUS" = "NOT_FOUND" ]; then
    echo "ERROR: VM $VM_NAME not found in project $PROJECT zone $ZONE" >&2
    exit 1
fi
if [ "$VM_STATUS" = "TERMINATED" ]; then
    echo "Starting VM..."
    gcloud compute instances start "$VM_NAME" --zone="$ZONE" --project="$PROJECT"
fi

echo "Creating remote directory..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="sudo mkdir -p $REMOTE_DIR && sudo chown \$(whoami) $REMOTE_DIR"

echo "Uploading installer..."
gcloud compute scp "$LOCAL_INSTALLER" "$VM_NAME:$REMOTE_DIR/install_global_mapper_vm.sh" --zone="$ZONE" --project="$PROJECT"

echo "Running installer..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="chmod +x $REMOTE_DIR/install_global_mapper_vm.sh && sudo COLMAP_VERSION=4.0.4 bash $REMOTE_DIR/install_global_mapper_vm.sh"

echo "Verifying global-mapper stack..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="
set -e
which colmap
which glomap
colmap global_mapper -h >/dev/null
colmap view_graph_calibrator -h >/dev/null
glomap -h >/dev/null
echo 'global_mapper: OK'
echo 'view_graph_calibrator: OK'
echo 'glomap wrapper: OK'
"

echo ""
echo "=============================================="
echo "Master v1 global-mapper provisioning complete"
echo "=============================================="
