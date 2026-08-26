#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_SCRIPT="${MASTER_V1_GCP_STARTUP_SCRIPT:-$SCRIPT_DIR/master-v1-vm-setup.sh}"
GCLOUD_WRAPPER="$SCRIPT_DIR/scripts/gcloud-houseyield.sh"

if [ -f "$GCLOUD_WRAPPER" ]; then
    GCLOUD_CMD=(bash "$GCLOUD_WRAPPER")
elif command -v gcloud >/dev/null 2>&1; then
    GCLOUD_CMD=(gcloud)
else
    echo "ERROR: gcloud CLI is not installed and $GCLOUD_WRAPPER was not found" >&2
    exit 1
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
    MASTER_V1_ENV_VARS=$(grep -E '^MASTER_V1_GCP_' "$SCRIPT_DIR/.env" | xargs || true)
    if [ -n "$MASTER_V1_ENV_VARS" ]; then
        export $MASTER_V1_ENV_VARS
    fi
fi

VM_NAME="${1:-${MASTER_V1_GCP_VM_NAME:-master-v1-gpu-2xl4-useast1b}}"
ZONE="${2:-${MASTER_V1_GCP_VM_ZONE:-us-east1-b}}"
PROJECT="${3:-${MASTER_V1_GCP_VM_PROJECT:-silken-slice-480417-e0}}"
MACHINE_TYPE="${MASTER_V1_GCP_MACHINE_TYPE:-g2-standard-24}"
GPU_TYPE="${MASTER_V1_GCP_GPU_TYPE:-nvidia-l4}"
GPU_COUNT="${MASTER_V1_GCP_GPU_COUNT:-2}"
BOOT_DISK_SIZE_GB="${MASTER_V1_GCP_BOOT_DISK_SIZE_GB:-200}"
BOOT_DISK_TYPE="${MASTER_V1_GCP_BOOT_DISK_TYPE:-pd-ssd}"
IMAGE_FAMILY="${MASTER_V1_GCP_IMAGE_FAMILY:-common-cu129-ubuntu-2204-nvidia-580}"
IMAGE_PROJECT="${MASTER_V1_GCP_IMAGE_PROJECT:-deeplearning-platform-release}"

if [ ! -f "$STARTUP_SCRIPT" ]; then
    echo "ERROR: startup script not found at $STARTUP_SCRIPT" >&2
    exit 1
fi

echo "=============================================="
echo "Creating Master v1 Standalone GPU VM"
echo "=============================================="
echo "Project:      $PROJECT"
echo "VM:           $VM_NAME"
echo "Zone:         $ZONE"
echo "Machine type: $MACHINE_TYPE"
echo "GPU:          $GPU_COUNT x $GPU_TYPE"
echo "Image:        $IMAGE_PROJECT / $IMAGE_FAMILY"
echo "Startup:      $STARTUP_SCRIPT"
echo ""

if "${GCLOUD_CMD[@]}" compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: VM already exists: $VM_NAME" >&2
    exit 1
fi

"${GCLOUD_CMD[@]}" compute instances create "$VM_NAME" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --accelerator="type=$GPU_TYPE,count=$GPU_COUNT" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --maintenance-policy=TERMINATE \
    --boot-disk-size="${BOOT_DISK_SIZE_GB}GB" \
    --boot-disk-type="$BOOT_DISK_TYPE" \
    --metadata-from-file=startup-script="$STARTUP_SCRIPT" \
    --labels=system=master-v1,pipeline=master-v1,role=gpu-worker

echo ""
echo "Master v1 VM creation requested."
echo "Startup provisioning will take several minutes."
echo "Next steps:"
echo "  1. bash ./scripts/gcloud-houseyield.sh compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT"
echo "  2. Verify: colmap global_mapper -h && glomap -h && nvidia-smi"
echo "  3. Run ./deploy-master-v1-pipeline.sh after the VM is ready"