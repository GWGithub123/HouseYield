#!/bin/bash

set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
    exec sudo bash "$0" "$@"
fi

MASTER_V1_VENV_PATH="${MASTER_V1_GCP_VENV_PATH:-/opt/master-v1-venv}"
MASTER_V1_SERVICE_DIR="${MASTER_V1_GCP_SERVICE_DIR:-/opt/master-v1-service}"
MASTER_V1_DATA_DIR="${MASTER_V1_GCP_DATA_DIR:-/opt/master-v1-data}"
MASTER_V1_MODELS_DIR="${MASTER_V1_GCP_MODELS_DIR:-/opt/master-v1-models}"
COLMAP_VERSION="${COLMAP_VERSION:-4.0.4}"
CUDA_ARCHITECTURES="${COLMAP_CUDA_ARCHITECTURES:-75;89}"

echo "================================================"
echo "Master v1 Canonical Pipeline - Standalone VM Setup"
echo "================================================"
echo "Service dir: $MASTER_V1_SERVICE_DIR"
echo "Data dir:    $MASTER_V1_DATA_DIR"
echo "Venv:        $MASTER_V1_VENV_PATH"

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/cuda/bin:/usr/local/cuda-12.1/bin:${PATH}"
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:/usr/local/cuda-12.1/lib64:${LD_LIBRARY_PATH:-}"

apt-get update
apt-get upgrade -y

apt-get install -y \
    git \
    wget \
    curl \
    unzip \
    ffmpeg \
    python3-pip \
    python3-venv \
    cmake \
    ninja-build \
    build-essential \
    gcc-10 \
    g++-10 \
    pkg-config \
    libboost-program-options-dev \
    libboost-filesystem-dev \
    libboost-graph-dev \
    libboost-system-dev \
    libboost-iostreams-dev \
    libboost-serialization-dev \
    libeigen3-dev \
    libflann-dev \
    libfreeimage-dev \
    libopenimageio-dev \
    openimageio-tools \
    libmetis-dev \
    libgoogle-glog-dev \
    libgtest-dev \
    libsqlite3-dev \
    libglew-dev \
    libceres-dev \
    libsuitesparse-dev \
    libatlas-base-dev \
    libopenblas-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    libpng-dev \
    libjpeg-dev \
    libturbojpeg0-dev \
    libtiff-dev \
    zlib1g-dev \
    libglu1-mesa-dev \
    libxmu-dev \
    libxi-dev \
    libopencv-dev \
    libcgal-dev \
    libnanoflann-dev \
    qtbase5-dev \
    libqt5opengl5-dev || true

update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-10 100
update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100

if ! nvidia-smi >/dev/null 2>&1; then
    echo "Installing NVIDIA drivers..."
    if [ -f /opt/deeplearning/install-driver.sh ]; then
        /opt/deeplearning/install-driver.sh
    else
        apt-get install -y nvidia-driver-570
    fi
    echo "GPU driver installed. Reboot and rerun this script."
    exit 1
fi

if ! command -v nvcc >/dev/null 2>&1; then
    echo "Installing CUDA toolkit 12.1..."
    wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
    dpkg -i cuda-keyring_1.1-1_all.deb
    apt-get update
    apt-get install -y cuda-toolkit-12-1
    rm -f cuda-keyring_1.1-1_all.deb
    ln -sf /usr/local/cuda-12.1 /usr/local/cuda
fi

echo "CUDA: $(nvcc --version | grep release | head -1)"
echo "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"

CMAKE_VERSION=$(cmake --version | head -1 | awk '{print $3}')
CMAKE_MAJOR=$(echo "$CMAKE_VERSION" | cut -d. -f1)
CMAKE_MINOR=$(echo "$CMAKE_VERSION" | cut -d. -f2)
if [ "$CMAKE_MAJOR" -lt 3 ] || { [ "$CMAKE_MAJOR" -eq 3 ] && [ "$CMAKE_MINOR" -lt 28 ]; }; then
    pip3 install --upgrade cmake
    hash -r
fi

mkdir -p /usr/include/opencv4

COLMAP_BLAS_VENDOR="Generic"
if dpkg -s libmkl-full-dev >/dev/null 2>&1; then
    COLMAP_BLAS_VENDOR="Intel10_64lp"
elif dpkg -s libopenblas-dev >/dev/null 2>&1; then
    COLMAP_BLAS_VENDOR="OpenBLAS"
fi

COLMAP_GLOBAL_MAPPER_OK=0
COLMAP_VIEW_GRAPH_OK=0
COLMAP_CUDA_OK=0
if command -v colmap >/dev/null 2>&1; then
    colmap global_mapper -h >/dev/null 2>&1 && COLMAP_GLOBAL_MAPPER_OK=1
    colmap view_graph_calibrator -h >/dev/null 2>&1 && COLMAP_VIEW_GRAPH_OK=1
    colmap -h 2>&1 | grep -qi cuda && COLMAP_CUDA_OK=1 || true
fi

if [ "$COLMAP_GLOBAL_MAPPER_OK" -ne 1 ] || [ "$COLMAP_VIEW_GRAPH_OK" -ne 1 ] || [ "$COLMAP_CUDA_OK" -ne 1 ]; then
    echo "Building COLMAP $COLMAP_VERSION with CUDA + global_mapper..."
    rm -rf /opt/colmap
    git clone --branch "$COLMAP_VERSION" --depth 1 https://github.com/colmap/colmap.git /opt/colmap
    cd /opt/colmap
    mkdir -p build
    cd build
    echo "Using BLAS vendor: $COLMAP_BLAS_VENDOR"
    cmake .. -GNinja \
        -DCMAKE_BUILD_TYPE=Release \
        -DBLA_VENDOR="$COLMAP_BLAS_VENDOR" \
        -DCUDA_ENABLED=ON \
        -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
        -DCMAKE_C_COMPILER=/usr/bin/gcc-10 \
        -DCMAKE_CXX_COMPILER=/usr/bin/g++-10 \
        -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-10
    ninja
    ninja install
    ldconfig
fi

colmap global_mapper -h >/dev/null 2>&1
colmap view_graph_calibrator -h >/dev/null 2>&1

cat > /usr/local/bin/glomap <<'EOFGLOMAP'
#!/bin/bash
set -euo pipefail

if [ "${1:-}" = "mapper" ]; then
    shift
    exec colmap global_mapper "$@"
fi

if [ $# -eq 0 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    exec colmap global_mapper -h
fi

echo "Unsupported glomap command: ${1:-}. This compatibility wrapper only supports 'glomap mapper'." >&2
exit 1
EOFGLOMAP
chmod +x /usr/local/bin/glomap
ln -sf "$(command -v colmap)" /usr/local/bin/colmap-glomap

if ! command -v PoissonRecon >/dev/null 2>&1; then
    echo "Installing PoissonRecon..."
    rm -rf /opt/PoissonRecon
    git clone https://github.com/mkazhdan/PoissonRecon.git /opt/PoissonRecon
    cd /opt/PoissonRecon
    make -j"$(nproc)"
    cp Bin/Linux/PoissonRecon /usr/local/bin/
    cp Bin/Linux/SurfaceTrimmer /usr/local/bin/
fi

if ! command -v TextureMesh >/dev/null 2>&1; then
    echo "Installing OpenMVS..."
    git clone https://github.com/cnr-isti-vclab/vcglib.git /opt/vcglib 2>/dev/null || true
    rm -rf /opt/openMVS
    git clone --branch v2.1.0 --recursive https://github.com/cdcseacave/openMVS.git /opt/openMVS
    cd /opt/openMVS
    mkdir -p build_release
    cd build_release
    cmake .. \
        -DCMAKE_BUILD_TYPE=Release \
        -DOpenMVS_USE_CUDA=OFF \
        -DVCG_ROOT=/opt/vcglib
    make -j"$(nproc)"
    make install
    ln -sf /opt/openMVS/build_release/bin/* /usr/local/bin/
fi

command -v InterfaceCOLMAP >/dev/null 2>&1
command -v TextureMesh >/dev/null 2>&1

mkdir -p "$MASTER_V1_VENV_PATH" "$MASTER_V1_SERVICE_DIR" "$MASTER_V1_DATA_DIR" "$MASTER_V1_MODELS_DIR"
chmod 777 "$MASTER_V1_DATA_DIR"

if [ ! -d "$MASTER_V1_VENV_PATH/bin" ]; then
    python3 -m venv "$MASTER_V1_VENV_PATH" --system-site-packages
fi

PIP="$MASTER_V1_VENV_PATH/bin/pip"
PYTHON="$MASTER_V1_VENV_PATH/bin/python3"

"$PIP" install --upgrade pip
"$PIP" install \
    numpy \
    scipy \
    h5py \
    opencv-python \
    Pillow \
    open3d \
    trimesh \
    scikit-learn \
    matplotlib \
    pandas \
    requests \
    tqdm \
    kornia \
    pycolmap \
    certifi \
    pygltflib \
    python-dotenv \
    safetensors \
    transformers \
    accelerate \
    timm \
    einops \
    huggingface_hub

"$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cu121

if [ ! -d /opt/MirrorGS/.git ]; then
    rm -rf /opt/MirrorGS
    git clone --recursive https://github.com/TingtingLiao/MirrorGS.git /opt/MirrorGS
else
    git -C /opt/MirrorGS pull --ff-only || true
    git -C /opt/MirrorGS submodule update --init --recursive
fi

"$PIP" install -r /opt/MirrorGS/requirements.txt || true
if [ -d /opt/MirrorGS/submodules/diff-surfel-rasterization ]; then
    "$PIP" install --no-build-isolation /opt/MirrorGS/submodules/diff-surfel-rasterization
fi
if [ -d /opt/MirrorGS/submodules/simple-knn ]; then
    "$PIP" install --no-build-isolation /opt/MirrorGS/submodules/simple-knn
fi
"$PIP" install -U xformers --index-url https://download.pytorch.org/whl/cu121 || true

if [ ! -d /opt/fast3r/.git ]; then
    rm -rf /opt/fast3r
    git clone --recursive https://github.com/facebookresearch/fast3r.git /opt/fast3r
else
    git -C /opt/fast3r pull --ff-only || true
    git -C /opt/fast3r submodule update --init --recursive
fi

"$PIP" install -r /opt/fast3r/requirements.txt
"$PIP" install -e /opt/fast3r

if [ ! -d /opt/Metric3D/.git ]; then
    rm -rf /opt/Metric3D
    git clone --recursive https://github.com/YvanYin/Metric3D.git /opt/Metric3D
else
    git -C /opt/Metric3D pull --ff-only || true
    git -C /opt/Metric3D submodule update --init --recursive
fi

if [ ! -d /opt/hloc/.git ]; then
    rm -rf /opt/hloc
    git clone --recursive https://github.com/cvg/Hierarchical-Localization.git /opt/hloc
else
    git -C /opt/hloc pull --ff-only || true
    git -C /opt/hloc submodule update --init --recursive
fi

"$PIP" install -e /opt/hloc

mkdir -p /opt/models/huggingface /opt/models/torch

"$PYTHON" <<'EOF_SETUP_DOWNLOADS'
import os
import sys

os.environ.setdefault('HF_HOME', '/opt/models/huggingface')
os.environ.setdefault('TORCH_HOME', '/opt/models/torch')

try:
    from huggingface_hub import hf_hub_download
    hf_hub_download(
        repo_id='JUGGHM/Metric3D',
        filename='metric_depth_vit_large_800k.pth',
        cache_dir='/opt/models/huggingface',
    )
    print('Metric3D weights ready')
except Exception as exc:
    print(f'Metric3D preload skipped: {exc}')

try:
    import kornia.feature as KF
    KF.LoFTR(pretrained='indoor')
    print('LoFTR indoor weights ready')
except Exception as exc:
    print(f'LoFTR preload skipped: {exc}')

try:
    fast3r_root = '/opt/fast3r'
    if fast3r_root not in sys.path:
        sys.path.insert(0, fast3r_root)
    from fast3r.models.fast3r import Fast3R

    model = Fast3R.from_pretrained(
        os.environ.get('MASTER_PIPELINE_FAST3R_MODEL_NAME', 'jedyang97/Fast3R_ViT_Large_512')
    )
    del model
    print('Fast3r weights ready')
except Exception as exc:
    print(f'Fast3r preload skipped: {exc}')
EOF_SETUP_DOWNLOADS

cat > /etc/profile.d/master-v1-venv.sh <<EOFPROFILE
source $MASTER_V1_VENV_PATH/bin/activate
export MASTER_V1_GCP_SERVICE_DIR=$MASTER_V1_SERVICE_DIR
export MASTER_V1_GCP_DATA_DIR=$MASTER_V1_DATA_DIR
export MASTER_V1_GCP_VENV_PATH=$MASTER_V1_VENV_PATH
export HF_HOME=/opt/models/huggingface
export TORCH_HOME=/opt/models/torch
export MASTER_PIPELINE_FAST3R_ROOT=/opt/fast3r
export MASTER_PIPELINE_METRIC3D_REPO_DIR=/opt/Metric3D
export MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_PRESET=fast3r
export MASTER_PIPELINE_REMOTE_LEARNED_MATCHING_IMAGE_SIZE=512
export MASTER_PIPELINE_METRIC3D_GPU_INDICES=0
export MASTER_PIPELINE_LEARNED_MATCHING_GPU_INDICES=1
export MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES=0,1
export MASTER_PIPELINE_MIRRORGS_ROOT=/opt/MirrorGS
export MIRRORGS_ROOT=/opt/MirrorGS
export MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND='/opt/master-v1-venv/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_mirrorgs_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --mirrorgs-root /opt/MirrorGS --python /opt/master-v1-venv/bin/python3'
export MASTER_PIPELINE_REQUIRE_MIRROR_GAUSSIAN=false
export MASTER_PIPELINE_REFGAUSSIAN_ROOT=/opt/ref-gaussian
export REFGAUSSIAN_ROOT=/opt/ref-gaussian
export MASTER_PIPELINE_REFGAUSSIAN_VENV_PATH=/opt/ref-gaussian-venv
# RefGaussian is installed with server/scripts/master_pipeline/install_refgaussian_vm.sh
# and remains opt-in so the stable vanilla gaussian path is not invoked through it.
export MASTER_PIPELINE_REF_GAUSSIAN_COMMAND=''
export MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN=false
EOFPROFILE

echo "Verifying Python dependencies..."
"$PYTHON" - <<'EOF_VERIFY'
import cv2
import os
import torch
import open3d
import trimesh
import h5py
import hloc
import kornia
import pycolmap
import certifi
import pygltflib
import sys

fast3r_root = '/opt/fast3r'
if fast3r_root not in sys.path:
    sys.path.insert(0, fast3r_root)
from fast3r.models.fast3r import Fast3R  # noqa: F401
from hloc import match_features  # noqa: F401

metric3d_root = '/opt/Metric3D'
assert os.path.isfile(os.path.join(metric3d_root, 'hubconf.py'))
assert os.path.isdir(os.path.join(metric3d_root, 'mono'))

lightglue_keys = [key for key in match_features.confs if 'lightglue' in key]
assert lightglue_keys, sorted(match_features.confs)

print('Python dependency import check OK')
print(f'Torch CUDA available: {torch.cuda.is_available()}')
EOF_VERIFY

SETUP_SENTINEL="$MASTER_V1_DATA_DIR/.setup-complete"
cat > "$SETUP_SENTINEL" <<EOF_SETUP_COMPLETE
completed_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
python=$PYTHON
colmap=$(command -v colmap)
glomap=$(command -v glomap)
PoissonRecon=$(command -v PoissonRecon)
InterfaceCOLMAP=$(command -v InterfaceCOLMAP)
TextureMesh=$(command -v TextureMesh)
EOF_SETUP_COMPLETE

echo "================================================"
echo "Master v1 standalone VM setup complete"
echo "================================================"
echo "colmap:       $(command -v colmap)"
echo "glomap:       $(command -v glomap)"
echo "PoissonRecon: $(command -v PoissonRecon)"
echo "InterfaceCOLMAP: $(command -v InterfaceCOLMAP)"
echo "TextureMesh:  $(command -v TextureMesh)"
echo "Python:       $PYTHON"
echo "Service dir:  $MASTER_V1_SERVICE_DIR"
echo "Data dir:     $MASTER_V1_DATA_DIR"
echo "Sentinel:     $SETUP_SENTINEL"