#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        var_name="${line%%=*}"
        var_value="${line#*=}"
        if [ -z "${!var_name+x}" ]; then
            export "$var_name=$var_value"
        fi
    done < <(grep -E '^MASTER_V1_GCP_[A-Z0-9_]*=' "$SCRIPT_DIR/.env" || true)
fi

VM_NAME="${1:-${MASTER_V1_GCP_VM_NAME:-master-v1-gpu-2xl4-useast1b}}"
ZONE="${2:-${MASTER_V1_GCP_VM_ZONE:-us-east1-b}}"
PROJECT="${3:-${MASTER_V1_GCP_VM_PROJECT:-silken-slice-480417-e0}}"
GCLOUD_ACCOUNT="${MASTER_V1_GCP_GCLOUD_ACCOUNT:-}"
HOST="${MASTER_V1_GCP_HOST:-}"
TRANSPORT="${MASTER_V1_GCP_TRANSPORT:-ssh}"
WORKER_USER="${MASTER_V1_GCP_WORKER_USER:-${USER}}"
SSH_KEY_PATH="${MASTER_V1_GCP_SSH_KEY_PATH:-$HOME/.ssh/google_compute_engine}"
REMOTE_SERVICE_DIR="${MASTER_V1_GCP_SERVICE_DIR:-/opt/master-v1-service}"
REMOTE_PYTHON="${MASTER_V1_GCP_PYTHON_PATH:-/opt/master-v1-venv/bin/python3}"
REMOTE_ARCHIVE="/tmp/master-v1-service.tar.gz"
SSH_CONNECT_TIMEOUT_SECONDS="${MASTER_V1_GCP_SSH_CONNECT_TIMEOUT_SECONDS:-20}"
SSH_COMMON_OPTS=(
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o PasswordAuthentication=no
    -o KbdInteractiveAuthentication=no
    -o ChallengeResponseAuthentication=no
    -o ConnectTimeout="$SSH_CONNECT_TIMEOUT_SECONDS"
    -o ServerAliveInterval=10
    -o ServerAliveCountMax=2
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
)

FILES=(
    "server/scripts/requirements.txt"
    "server/scripts/photogrammetry/requirements.txt"
    "server/scripts/measurement/requirements.txt"
    "server/scripts/measurement/specialist_vision_service.py"
    "server/scripts/master_pipeline/orchestrator.py"
    "server/scripts/master_pipeline/run_semantic_masks.py"
    "server/scripts/master_pipeline/run_gaussian_splatting.py"
    "server/scripts/master_pipeline/run_mirrorgs_adapter.py"
    "server/scripts/master_pipeline/run_refgaussian_adapter.py"
    "server/scripts/master_pipeline/run_scaffoldgs_adapter.py"
    "server/scripts/master_pipeline/refgaussian_bundle.py"
    "server/scripts/master_pipeline/run_depth_priors.py"
    "server/scripts/master_pipeline/run_metric3d_priors.py"
    "server/scripts/master_pipeline/run_loftr_indoor_matching.py"
    "server/scripts/master_pipeline/run_global_sfm.py"
    "server/scripts/master_pipeline/run_dense_evidence.py"
    "server/scripts/master_pipeline/run_plane_layout.py"
    "server/scripts/master_pipeline/run_opening_detection.py"
    "server/scripts/master_pipeline/run_mesh_authoring.py"
    "server/scripts/master_pipeline/run_gaussian_mesh_hybrid.py"
    "server/scripts/master_pipeline/run_refgaussian_surface_extraction.py"
    "server/scripts/master_pipeline/run_uv_initial_bake.py"
    "server/scripts/master_pipeline/run_appearance_refinement.py"
    "server/scripts/master_pipeline/run_export_qa.py"
    "server/scripts/master_pipeline/install_global_mapper_vm.sh"
    "server/scripts/master_pipeline/install_houseyield_gaussian_vm.sh"
    "server/scripts/master_pipeline/install_refgaussian_vm.sh"
    "server/scripts/photogrammetry/__init__.py"
    "server/scripts/photogrammetry/pipeline.py"
    "server/scripts/photogrammetry/feature_extraction.py"
    "server/scripts/photogrammetry/feature_matching.py"
    "server/scripts/photogrammetry/sfm.py"
    "server/scripts/photogrammetry/dense_reconstruction.py"
    "server/scripts/photogrammetry/gcp_worker_client.py"
    "server/scripts/photogrammetry/generate_depth_priors.py"
    "server/scripts/photogrammetry/generate_fast3r_depth_priors.py"
    "server/scripts/photogrammetry/generate_metric3d_depth_priors.py"
    "server/scripts/photogrammetry/mesh_generation.py"
    "server/scripts/photogrammetry/export.py"
    "server/scripts/photogrammetry/texture_mapping.py"
    "server/scripts/photogrammetry/viewpoint_clustering.py"
    "server/scripts/room_tour/process_room_tour.py"
)

for file in "${FILES[@]}"; do
    if [ ! -f "$SCRIPT_DIR/$file" ]; then
        echo "ERROR: required file missing: $file" >&2
        exit 1
    fi
done

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="$TMP_DIR/master-v1-service.tar.gz"
SEMANTIC_MASK_ENV_PATH="$TMP_DIR/master-v1-semantic-mask.env"
SEMANTIC_MASK_UNIT_PATH="$TMP_DIR/master-v1-semantic-mask.service"
DEFAULT_SPECIALIST_SAM2_CHECKPOINT="${SPECIALIST_SAM2_CHECKPOINT:-/opt/sam2/checkpoints/sam2.1_hiera_large.pt}"
DEFAULT_SPECIALIST_SAM2_CONFIG="${SPECIALIST_SAM2_CONFIG:-configs/sam2.1/sam2.1_hiera_l.yaml}"
DEFAULT_SPECIALIST_SAM2_CHECKPOINT_URL="${SPECIALIST_SAM2_CHECKPOINT_URL:-https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt}"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$SEMANTIC_MASK_ENV_PATH" <<EOF
SPECIALIST_HOST=127.0.0.1
SPECIALIST_PORT=8010
SPECIALIST_DETECTOR_BACKEND=grounding_dino
SPECIALIST_GROUNDING_DINO_MODEL=${SPECIALIST_GROUNDING_DINO_MODEL:-IDEA-Research/grounding-dino-tiny}
SPECIALIST_SAM2_CHECKPOINT=${DEFAULT_SPECIALIST_SAM2_CHECKPOINT}
SPECIALIST_SAM2_CONFIG=${DEFAULT_SPECIALIST_SAM2_CONFIG}
SPECIALIST_SAM2_MASK_THRESHOLD=${SPECIALIST_SAM2_MASK_THRESHOLD:-0.0}
EOF

cat > "$SEMANTIC_MASK_UNIT_PATH" <<EOF
[Unit]
Description=Master v1 semantic mask service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${WORKER_USER}
WorkingDirectory=${REMOTE_SERVICE_DIR}/server/scripts/measurement
EnvironmentFile=/etc/master-v1-semantic-mask.env
Environment=PYTHONUNBUFFERED=1
ExecStart=${REMOTE_PYTHON} ${REMOTE_SERVICE_DIR}/server/scripts/measurement/specialist_vision_service.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "=============================================="
echo "Deploying Master v1 Standalone Worker Bundle"
echo "=============================================="
echo "Project:      $PROJECT"
echo "VM:           $VM_NAME"
echo "Zone:         $ZONE"
if [ -n "$GCLOUD_ACCOUNT" ]; then
    echo "Account:      $GCLOUD_ACCOUNT"
fi
if [ -n "$HOST" ] && [ "$TRANSPORT" != "gcloud" ]; then
    echo "Host:         $HOST"
    echo "SSH user:     $WORKER_USER"
fi
echo "Transport:    $TRANSPORT"
echo "Remote dir:   $REMOTE_SERVICE_DIR"
echo "Remote python:$REMOTE_PYTHON"
echo ""

tar -czf "$ARCHIVE_PATH" -C "$SCRIPT_DIR" "${FILES[@]}"

remote_ssh() {
    local remote_command="$1"
    if [ -n "$HOST" ] && [ "$TRANSPORT" != "gcloud" ]; then
        ssh -i "$SSH_KEY_PATH" \
            "${SSH_COMMON_OPTS[@]}" \
            "$WORKER_USER@$HOST" \
            "$remote_command"
    else
        if [ -n "$GCLOUD_ACCOUNT" ]; then
            "${GCLOUD_CMD[@]}" "--account=$GCLOUD_ACCOUNT" compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="$remote_command"
        else
            "${GCLOUD_CMD[@]}" compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT" --command="$remote_command"
        fi
    fi
}

remote_scp() {
    local local_path="$1"
    local remote_path="$2"
    if [ -n "$HOST" ] && [ "$TRANSPORT" != "gcloud" ]; then
        scp -i "$SSH_KEY_PATH" \
            "${SSH_COMMON_OPTS[@]}" \
            "$local_path" \
            "$WORKER_USER@$HOST:$remote_path"
    else
        if [ -n "$GCLOUD_ACCOUNT" ]; then
            "${GCLOUD_CMD[@]}" "--account=$GCLOUD_ACCOUNT" compute scp "$local_path" "$VM_NAME:$remote_path" --zone="$ZONE" --project="$PROJECT"
        else
            "${GCLOUD_CMD[@]}" compute scp "$local_path" "$VM_NAME:$remote_path" --zone="$ZONE" --project="$PROJECT"
        fi
    fi
}

remote_ssh "sudo mkdir -p $REMOTE_SERVICE_DIR && sudo chown \$(whoami):\$(id -gn) $REMOTE_SERVICE_DIR"
remote_scp "$ARCHIVE_PATH" "$REMOTE_ARCHIVE"
remote_scp "$SEMANTIC_MASK_ENV_PATH" "/tmp/master-v1-semantic-mask.env"
remote_scp "$SEMANTIC_MASK_UNIT_PATH" "/tmp/master-v1-semantic-mask.service"
remote_ssh "sudo rm -rf $REMOTE_SERVICE_DIR/server && sudo mkdir -p $REMOTE_SERVICE_DIR && sudo tar -xzf $REMOTE_ARCHIVE -C $REMOTE_SERVICE_DIR && sudo chmod +x $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/*.py && sudo chown -R \$(whoami):\$(id -gn) $REMOTE_SERVICE_DIR"

if [[ "$DEFAULT_SPECIALIST_SAM2_CHECKPOINT" == /opt/sam2/checkpoints/* ]]; then
    remote_ssh "set -e; sudo mkdir -p /opt/sam2/checkpoints; if [ ! -s '$DEFAULT_SPECIALIST_SAM2_CHECKPOINT' ]; then sudo curl -fL '$DEFAULT_SPECIALIST_SAM2_CHECKPOINT_URL' -o '$DEFAULT_SPECIALIST_SAM2_CHECKPOINT'; fi; test -s '$DEFAULT_SPECIALIST_SAM2_CHECKPOINT'"
fi

remote_ssh "set -e; $REMOTE_PYTHON - <<'EOF'
import os
import subprocess

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-r',
    '$REMOTE_SERVICE_DIR/server/scripts/requirements.txt',
], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-r',
    '$REMOTE_SERVICE_DIR/server/scripts/photogrammetry/requirements.txt',
], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-r',
    '$REMOTE_SERVICE_DIR/server/scripts/measurement/requirements.txt',
], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    'git+https://github.com/facebookresearch/sam2.git',
], check=True)

if not os.path.isdir('/opt/hloc/.git'):
    subprocess.run([
        'sudo',
        'git',
        'clone',
        '--recursive',
        'https://github.com/cvg/Hierarchical-Localization.git',
        '/opt/hloc',
    ], check=True)
else:
    subprocess.run(['sudo', 'git', '-C', '/opt/hloc', 'pull', '--ff-only'], check=False)
    subprocess.run(['sudo', 'git', '-C', '/opt/hloc', 'submodule', 'update', '--init', '--recursive'], check=True)

if not os.path.isdir('/opt/Metric3D/.git'):
    subprocess.run([
        'sudo',
        'git',
        'clone',
        '--recursive',
        'https://github.com/YvanYin/Metric3D.git',
        '/opt/Metric3D',
    ], check=True)
else:
    subprocess.run(['sudo', 'git', '-C', '/opt/Metric3D', 'pull', '--ff-only'], check=False)
    subprocess.run(['sudo', 'git', '-C', '/opt/Metric3D', 'submodule', 'update', '--init', '--recursive'], check=True)

if not os.path.isdir('/opt/MirrorGS/.git'):
    subprocess.run([
        'sudo',
        'git',
        'clone',
        '--recursive',
        'https://github.com/TingtingLiao/MirrorGS.git',
        '/opt/MirrorGS',
    ], check=True)
else:
    subprocess.run(['sudo', 'git', '-C', '/opt/MirrorGS', 'pull', '--ff-only'], check=False)
    subprocess.run(['sudo', 'git', '-C', '/opt/MirrorGS', 'submodule', 'update', '--init', '--recursive'], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-e',
    '/opt/hloc',
], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    'gsplat',
    'plyfile',
], check=True)

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-r',
    '/opt/MirrorGS/requirements.txt',
], check=False)

optional_submodules = {
    'diff-surfel-rasterization': 'diff_surfel_rasterization',
    'simple-knn': 'simple_knn',
}
for submodule, import_name in optional_submodules.items():
    path = f'/opt/MirrorGS/submodules/{submodule}'
    if os.path.isdir(path):
        probe = subprocess.run([
            '$REMOTE_PYTHON',
            '-c',
            f'import {import_name}',
        ], check=False)
        if probe.returncode == 0:
            print(f'{import_name}_already_importable OK')
            continue
        install_result = subprocess.run([
            'sudo',
            '$REMOTE_PYTHON',
            '-m',
            'pip',
            'install',
            '--disable-pip-version-check',
            '--no-build-isolation',
            path,
        ], check=False)
        if install_result.returncode != 0:
            print(f'WARNING: optional MirrorGS submodule install failed for {submodule}; continuing')

subprocess.run([
    'sudo',
    '$REMOTE_PYTHON',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '-U',
    'xformers',
    '--index-url',
    'https://download.pytorch.org/whl/cu121',
], check=False)

import certifi
import cv2
import gsplat
import h5py
import hloc
import kornia
import mmengine
import open3d
import plyfile
import pycolmap
import pygltflib
import safetensors
import sys
import torch
import trimesh
from sam2.build_sam import build_sam2  # noqa: F401
from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: F401

hloc_root = '/opt/hloc'
if hloc_root not in sys.path:
    sys.path.insert(0, hloc_root)

from hloc import match_features
lightglue_keys = [key for key in match_features.confs if 'lightglue' in key]
assert lightglue_keys, match_features.confs.keys()
print(f'hloc_lightglue_keys={lightglue_keys}')

fast3r_root = '/opt/fast3r'
if fast3r_root not in sys.path:
    sys.path.insert(0, fast3r_root)
try:
    from fast3r.models.fast3r import Fast3R  # noqa: F401
    print('fast3r_import_check OK')
except Exception as exc:
    print(f'WARNING: optional Fast3R import check failed: {exc}')

metric3d_root = '/opt/Metric3D'
if metric3d_root not in sys.path:
    sys.path.insert(0, metric3d_root)

metric3d_model = torch.hub.load(metric3d_root, 'metric3d_vit_large', pretrain=False, source='local')
del metric3d_model
print('metric3d_local_repo_check OK')

print('master_v1 dependency check OK')
print(f'torch_cuda={torch.cuda.is_available()}')
print(f'gsplat_version={gsplat.__version__}')
EOF
PYTHONPATH=/opt/MirrorGS:$REMOTE_SERVICE_DIR/server/scripts $REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_mirrorgs_adapter.py --help >/dev/null
PYTHONPATH=$REMOTE_SERVICE_DIR/server/scripts/master_pipeline:$REMOTE_SERVICE_DIR/server/scripts $REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/refgaussian_bundle.py --help >/dev/null
PYTHONPATH=$REMOTE_SERVICE_DIR/server/scripts/master_pipeline:$REMOTE_SERVICE_DIR/server/scripts $REMOTE_PYTHON - <<'EOF'
from refgaussian_bundle import export_refgaussian_bundle  # noqa: F401
print('refgaussian_bundle import check OK')
EOF
command -v glomap >/dev/null
command -v colmap-glomap >/dev/null
command -v InterfaceCOLMAP >/dev/null
command -v TextureMesh >/dev/null
PYTHONPATH=/opt/hloc:/opt/fast3r:$REMOTE_SERVICE_DIR/server/scripts $REMOTE_PYTHON - <<'EOF'
from photogrammetry.dense_reconstruction import DenseReconstructor  # noqa: F401
try:
    from photogrammetry.generate_fast3r_depth_priors import generate_fast3r_depth_priors  # noqa: F401
    print('fast3r depth prior import check OK')
except Exception as exc:
    print(f'WARNING: optional fast3r depth prior import check failed: {exc}')
from photogrammetry.generate_metric3d_depth_priors import generate_metric3d_depth_priors  # noqa: F401
from photogrammetry.pipeline import ProcessingOptions  # noqa: F401
print('legacy photogrammetry import check OK')
EOF
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_metric3d_priors.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_depth_priors.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_gaussian_splatting.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_loftr_indoor_matching.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_dense_evidence.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/orchestrator.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_plane_layout.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_opening_detection.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_mesh_authoring.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_uv_initial_bake.py --help >/dev/null
$REMOTE_PYTHON $REMOTE_SERVICE_DIR/server/scripts/master_pipeline/run_export_qa.py --help >/dev/null
echo 'master_v1 worker bundle deployed and smoke-checked'
"

remote_ssh "set -e; sudo mv /tmp/master-v1-semantic-mask.env /etc/master-v1-semantic-mask.env; sudo mv /tmp/master-v1-semantic-mask.service /etc/systemd/system/master-v1-semantic-mask.service; sudo chmod 644 /etc/master-v1-semantic-mask.env /etc/systemd/system/master-v1-semantic-mask.service; sudo systemctl daemon-reload; sudo systemctl enable --now master-v1-semantic-mask.service; SPECIALIST_HEALTH_JSON=\"\$(curl -fsS http://127.0.0.1:8010/healthz)\"; if ! printf '%s' \"\$SPECIALIST_HEALTH_JSON\" | grep -q '\"openVocabSegmenterConfigured\":true'; then echo \"ERROR: master semantic mask service is not configured on the VM: \$SPECIALIST_HEALTH_JSON\" >&2; exit 1; fi"

echo ""
echo "Master v1 worker bundle deployed successfully"
echo "Remote root: $REMOTE_SERVICE_DIR"