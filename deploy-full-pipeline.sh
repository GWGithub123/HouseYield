#!/bin/bash
# Deploy the full pipeline processing script to GCP VM
# This updates the Python script that runs COLMAP + OpenMVS with texture mapping

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load from .env if available
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -E '^GCP_GPU_WORKER_' "$SCRIPT_DIR/.env" | xargs)
fi

VM_NAME="${GCP_GPU_WORKER_INSTANCE:-photogrammetry-gpu-worker}"
ZONE="${GCP_GPU_WORKER_ZONE:-asia-southeast1-c}"
PROJECT="${GCP_GPU_WORKER_PROJECT:-silken-slice-480417-e0}"

echo "=============================================="
echo "Deploying Full Pipeline Script to GCP VM"
echo "=============================================="
echo "VM: $VM_NAME"
echo "Zone: $ZONE"
echo ""

# Check if the script exists locally
if [ ! -f "$SCRIPT_DIR/process_full_pipeline.py" ]; then
    echo "❌ Error: process_full_pipeline.py not found in $SCRIPT_DIR"
    exit 1
fi

echo "✅ Found local script at $SCRIPT_DIR/process_full_pipeline.py"

# Ensure VM is running
echo ""
echo "Step 1: Checking VM status..."
VM_STATUS=$(gcloud compute instances describe $VM_NAME --zone=$ZONE --project=$PROJECT --format='get(status)' 2>/dev/null || echo "NOT_FOUND")

if [ "$VM_STATUS" = "NOT_FOUND" ]; then
    echo "❌ Error: VM $VM_NAME not found in zone $ZONE"
    exit 1
elif [ "$VM_STATUS" = "TERMINATED" ]; then
    echo "Starting VM..."
    gcloud compute instances start $VM_NAME --zone=$ZONE --project=$PROJECT
    echo "Waiting for VM to start..."
    sleep 30
fi

echo "✅ VM is running"

# Create service directory on VM
echo ""
echo "Step 2: Creating service directory on VM..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="sudo mkdir -p /opt/photogrammetry-service && sudo chown \$(whoami) /opt/photogrammetry-service"

# Upload the script
echo ""
echo "Step 3: Uploading process_full_pipeline.py..."
gcloud compute scp "$SCRIPT_DIR/process_full_pipeline.py" $VM_NAME:/opt/photogrammetry-service/process_full_pipeline.py --zone=$ZONE --project=$PROJECT

# Set permissions
echo ""
echo "Step 4: Setting permissions..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="chmod +x /opt/photogrammetry-service/process_full_pipeline.py"

# Verify the script
echo ""
echo "Step 5: Verifying deployment..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="
echo 'Checking script...'
if [ -f /opt/photogrammetry-service/process_full_pipeline.py ]; then
    echo '✅ Script exists'
    python3 /opt/photogrammetry-service/process_full_pipeline.py --help 2>&1 | head -5
else
    echo '❌ Script not found!'
    exit 1
fi
"

# Check for OpenMVS tools
echo ""
echo "Step 6: Checking OpenMVS tools..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="
echo 'OpenMVS binaries:'
ls -la /usr/local/bin/OpenMVS/ 2>/dev/null || echo 'OpenMVS not found in /usr/local/bin/OpenMVS/'
echo ''
echo 'PATH check:'
which InterfaceCOLMAP 2>/dev/null || echo 'InterfaceCOLMAP not in PATH'
which TextureMesh 2>/dev/null || echo 'TextureMesh not in PATH'
"

echo ""
echo "=============================================="
echo "✅ Deployment Complete!"
echo "=============================================="
echo ""
echo "The updated process_full_pipeline.py has been deployed to:"
echo "  /opt/photogrammetry-service/process_full_pipeline.py"
echo ""
echo "This version includes:"
echo "  • SuperPoint + LightGlue feature extraction/matching (HLOC)"
echo "  • GLOMAP global SfM (10-100x faster than incremental)"
echo "  • Metric3D v2 depth priors (metric-accurate AI depth)"
echo "  • OPENCV -> PINHOLE camera model conversion"
echo "  • MTL transparency fix (Tr -> d)"
echo "  • Full texture atlas generation with TextureMesh"
echo ""
