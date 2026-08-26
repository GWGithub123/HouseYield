#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_SCRIPT="${RENOVATION_MEASUREMENT_GCP_STARTUP_SCRIPT:-$SCRIPT_DIR/renovation-measurement-vm-setup.sh}"
GCLOUD_BIN="${RENOVATION_MEASUREMENT_GCLOUD_BIN:-gcloud}"

run_gcloud() {
    "$GCLOUD_BIN" "$@"
}

if [ -f "$SCRIPT_DIR/.env" ]; then
    RENOVATION_ENV_VARS=$(grep -E '^RENOVATION_MEASUREMENT_GCP_' "$SCRIPT_DIR/.env" | xargs || true)
    if [ -n "$RENOVATION_ENV_VARS" ]; then
        export $RENOVATION_ENV_VARS
    fi
fi

VM_NAME="${1:-${RENOVATION_MEASUREMENT_GCP_VM_NAME:-renovation-measurement-gpu-useast1b}}"
ZONE="${2:-${RENOVATION_MEASUREMENT_GCP_VM_ZONE:-us-east1-b}}"
PROJECT="${3:-${RENOVATION_MEASUREMENT_GCP_VM_PROJECT:-silken-slice-480417-e0}}"
MACHINE_TYPE="${RENOVATION_MEASUREMENT_GCP_MACHINE_TYPE:-g2-standard-8}"
GPU_TYPE="${RENOVATION_MEASUREMENT_GCP_GPU_TYPE:-nvidia-l4}"
GPU_COUNT="${RENOVATION_MEASUREMENT_GCP_GPU_COUNT:-1}"
BOOT_DISK_SIZE_GB="${RENOVATION_MEASUREMENT_GCP_BOOT_DISK_SIZE_GB:-100}"
BOOT_DISK_TYPE="${RENOVATION_MEASUREMENT_GCP_BOOT_DISK_TYPE:-pd-balanced}"
IMAGE_FAMILY="${RENOVATION_MEASUREMENT_GCP_IMAGE_FAMILY:-common-cu129-ubuntu-2204-nvidia-580}"
IMAGE_PROJECT="${RENOVATION_MEASUREMENT_GCP_IMAGE_PROJECT:-deeplearning-platform-release}"
API_TARGET_TAG="${RENOVATION_MEASUREMENT_API_TARGET_TAG:-renovation-measurement-api}"

if [ ! -f "$STARTUP_SCRIPT" ]; then
    echo "ERROR: startup script not found at $STARTUP_SCRIPT" >&2
    exit 1
fi

if ! command -v "$GCLOUD_BIN" >/dev/null 2>&1 && [ ! -x "$GCLOUD_BIN" ]; then
    echo "ERROR: gcloud command not found or not executable: $GCLOUD_BIN" >&2
    echo "Set RENOVATION_MEASUREMENT_GCLOUD_BIN to a working gcloud binary or wrapper script and retry." >&2
    exit 1
fi

echo "=============================================="
echo "Creating Renovation Measurement GPU VM"
echo "=============================================="
echo "Project:      $PROJECT"
echo "VM:           $VM_NAME"
echo "Zone:         $ZONE"
echo "Machine type: $MACHINE_TYPE"
echo "GPU:          $GPU_COUNT x $GPU_TYPE"
echo "Image:        $IMAGE_PROJECT / $IMAGE_FAMILY"
echo "Startup:      $STARTUP_SCRIPT"
echo "API tag:      $API_TARGET_TAG"
echo "gcloud:       $GCLOUD_BIN"
echo ""

ACTIVE_ACCOUNT="$(run_gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"

if ! run_gcloud compute zones describe "$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: unable to access Compute Engine zone '$ZONE' in project '$PROJECT'." >&2
    if [ -n "$ACTIVE_ACCOUNT" ]; then
        echo "Active gcloud account: $ACTIVE_ACCOUNT" >&2
    fi
    echo "Grant this account access to $PROJECT or set RENOVATION_MEASUREMENT_GCLOUD_BIN to a wrapper/account that can access the target project." >&2
    exit 1
fi

if run_gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
    echo "ERROR: VM already exists: $VM_NAME" >&2
    exit 1
fi

run_gcloud compute instances create "$VM_NAME" \
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
    --tags="$API_TARGET_TAG" \
    --labels=system=renovation-measurement,pipeline=renovation-measurement,role=measurement-gpu

echo ""
echo "Renovation measurement VM creation requested."
echo "Startup provisioning will take several minutes."
echo "Next steps:"
echo "  1. gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT"
echo "  2. Verify: node -v && colmap global_mapper -h && glomap -h && nvidia-smi"
echo "  3. Run ./deploy-renovation-measurement-vm.sh after the VM is ready"