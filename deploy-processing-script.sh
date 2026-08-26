#!/bin/bash
# Deploy processing scripts to GCP VM
# Uploads the full pipeline with:
# - HLOC SuperPoint (deep learning feature extraction)
# - LightGlue (state-of-the-art matching)
# - GLOMAP (10-100x faster sparse reconstruction)
# - Depth Anything v2 priors (fills featureless surfaces)
# - PatchMatch Stereo with depth priors

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load from .env if available
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -E '^GCP_GPU_WORKER_' "$SCRIPT_DIR/.env" | xargs)
fi

VM_NAME="${1:-${GCP_GPU_WORKER_INSTANCE:-room-tour-gpu-2xl4-uscentral1a}}"
ZONE="${2:-${GCP_GPU_WORKER_ZONE:-us-central1-a}}"
PROJECT="${3:-${GCP_GPU_WORKER_PROJECT:-silken-slice-480417-e0}}"

echo "═══════════════════════════════════════════════════════════════════════"
echo "Deploying Full Photogrammetry Pipeline to GCP VM"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "Project: $PROJECT"
echo "VM: $VM_NAME"
echo "Zone: $ZONE"
echo ""
echo "Pipeline components:"
echo "  ✓ HLOC SuperPoint - Deep learning feature extraction"
echo "  ✓ LightGlue - State-of-the-art feature matching"
echo "  ✓ GLOMAP - 10-100x faster sparse reconstruction"
echo "  ✓ Depth Anything v2 - AI depth priors (.photometric.bin)"
echo "  ✓ PatchMatch Stereo - Dense reconstruction with priors"
echo "  ✓ PoissonRecon + OpenMVS - Mesh & texturing"
echo ""

# Check that source files exist
if [ ! -f "$SCRIPT_DIR/process_full_pipeline.py" ]; then
    echo "ERROR: process_full_pipeline.py not found in $SCRIPT_DIR"
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/server/scripts/photogrammetry/generate_depth_priors.py" ]; then
    echo "ERROR: generate_depth_priors.py not found"
    exit 1
fi

echo "Step 1/4: Creating service directory on VM..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="sudo mkdir -p /opt/photogrammetry-service"

echo "Step 2/4: Uploading process_full_pipeline.py..."
gcloud compute scp "$SCRIPT_DIR/process_full_pipeline.py" $VM_NAME:/tmp/process_full_pipeline.py --zone=$ZONE --project=$PROJECT
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="sudo mv /tmp/process_full_pipeline.py /opt/photogrammetry-service/process_full_pipeline.py && sudo chmod +x /opt/photogrammetry-service/process_full_pipeline.py"

echo "Step 3/4: Uploading generate_depth_priors.py (with .photometric.bin fix)..."
gcloud compute scp "$SCRIPT_DIR/server/scripts/photogrammetry/generate_depth_priors.py" $VM_NAME:/tmp/generate_depth_priors.py --zone=$ZONE --project=$PROJECT
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="sudo mv /tmp/generate_depth_priors.py /opt/photogrammetry-service/generate_depth_priors.py && sudo chmod +x /opt/photogrammetry-service/generate_depth_priors.py"

echo "Step 4/4: Verifying deployment..."
gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT --command="
echo '=== Checking installed files ==='
ls -la /opt/photogrammetry-service/

echo ''
echo '=== Checking depth prior output format ==='
grep -o 'photometric.bin' /opt/photogrammetry-service/generate_depth_priors.py | head -1 && echo '✅ Depth priors will output .photometric.bin (correct!)'

echo ''
echo '=== Checking pipeline dependencies ==='
python3 -c 'import hloc; print(\"✅ HLOC:\", hloc.__version__)' 2>/dev/null || echo '⚠️  HLOC not installed'
which glomap && echo '✅ GLOMAP available' || echo '⚠️  GLOMAP not installed'
python3 -c 'import torch; print(\"✅ PyTorch:\", torch.__version__)' 2>/dev/null || echo '⚠️  PyTorch not installed'
python3 -c 'from transformers import AutoModelForDepthEstimation; print(\"✅ Transformers available\")' 2>/dev/null || echo '⚠️  Transformers not installed'

echo ''
echo '=== Testing depth prior import ==='
cd /opt/photogrammetry-service && python3 -c 'from generate_depth_priors import generate_depth_priors; print(\"✅ Depth prior module loads correctly\")' 2>/dev/null || echo '⚠️  Depth prior module has issues'
"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "✅ Deployment complete!"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "Files deployed to /opt/photogrammetry-service/:"
echo "  - process_full_pipeline.py (main pipeline)"
echo "  - generate_depth_priors.py (AI depth priors)"
echo ""
echo "The pipeline will now:"
echo "  1. Extract features with SuperPoint (via HLOC)"
echo "  2. Match with LightGlue"
echo "  3. Sparse reconstruction with GLOMAP"
echo "  4. Generate AI depth priors (Depth Anything v2)"
echo "     → Outputs .photometric.bin for COLMAP to use as initialization"
echo "  5. Dense reconstruction with PatchMatch (uses priors)"
echo "  6. Mesh with PoissonRecon"
echo "  7. Texture with OpenMVS"
echo ""
