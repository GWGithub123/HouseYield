#!/bin/bash
set -euo pipefail

# HouseYield Gaussian - dedicated RefGaussian-only VM installer.
#
# This script intentionally avoids the broader Master V1 mesh/export stack.
# It installs only the dependencies required for the saved-scan RefGaussian
# branch that we have been testing.
#
# Canonical run contract
# ----------------------
# 1. semantic_masks
#    - runs metadata/mask stage if the segmenter is configured
#    - masks are not copied into RefGaussian training images
#    - RefGaussian trainingMaskMode remains "metadata_only"
#
# 2. learned_matching
#    - preset: roma_v2
#    - image size: 1024
#    - RoMa setting: precise
#    - sampled matches per selected pair: 12000
#    - max verified matches per selected pair: 8192
#    - adaptive pair policy:
#      * <=10 images: exhaustive all-pairs
#      * <=48 images: offsets 1,2,3,4,6,8 plus medium anchors
#      * <=160 images: offsets 1,2,3,4,6,8,12,16 plus large anchors
#
# 3. global_sfm
#    - maintained COLMAP global_mapper path
#    - learned RoMa matches imported into COLMAP
#
# 4. metric3d_priors
#    - model size: large
#    - used as the upstream dense prior branch for gaussian initialization
#
# 5. gaussian_splatting
#    - mode: --gaussian-only --ref-gaussian-only
#    - vanilla gsplat training: skipped
#    - MirrorGS: disabled
#    - viewer preset: legacy_metric3d_sharp_mirror
#    - depth prior seed budget: 24000 points/image
#    - gsplat iteration argument retained at 20000 for stage compatibility
#    - RefGaussian iterations: 20000
#    - RefGaussian cleanup: disabled
#    - published primary artifact: converted .splat saved scan
#
# Standard launch shape from the local repo:
#   REF_GAUSSIAN_COMMAND='/opt/ref-gaussian-venv/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root /opt/ref-gaussian --python /opt/ref-gaussian-venv/bin/python3'
#   MASTER_V1_GCP_WORKER_ENABLE=true \
#   MASTER_V1_GCP_TRANSPORT=ssh \
#   MASTER_V1_GCP_HOST=<houseyield-gaussian-ip> \
#   node scripts/run-master-v1-gaussian-compare.mjs \
#     --include-presets roma_v2 \
#     --viewer-preset legacy_metric3d_sharp_mirror \
#     --gaussian-depth-priors-max-points-per-image 24000 \
#     --disable-mirror-gaussian \
#     --ref-gaussian-command "$REF_GAUSSIAN_COMMAND" \
#     --ref-gaussian-only \
#     --prefer-ref-gaussian

if [ "${EUID}" -ne 0 ]; then
    exec sudo bash "$0" "$@"
fi

SERVICE_DIR="${HOUSEYIELD_GAUSSIAN_SERVICE_DIR:-/opt/master-v1-service}"
DATA_DIR="${HOUSEYIELD_GAUSSIAN_DATA_DIR:-/opt/master-v1-data}"
MODELS_DIR="${HOUSEYIELD_GAUSSIAN_MODELS_DIR:-/opt/master-v1-models}"
MASTER_VENV_PATH="${HOUSEYIELD_GAUSSIAN_MASTER_VENV_PATH:-/opt/master-v1-venv}"
REFGAUSSIAN_ROOT="${HOUSEYIELD_GAUSSIAN_REFGAUSSIAN_ROOT:-/opt/ref-gaussian}"
REFGAUSSIAN_VENV_PATH="${HOUSEYIELD_GAUSSIAN_REFGAUSSIAN_VENV_PATH:-/opt/ref-gaussian-venv}"
REFGAUSSIAN_REPO_URL="${HOUSEYIELD_GAUSSIAN_REFGAUSSIAN_REPO_URL:-https://github.com/fudan-zvg/ref-gaussian.git}"
ROMA_V2_ROOT="${HOUSEYIELD_GAUSSIAN_ROMA_V2_ROOT:-/opt/RoMaV2}"
ROMA_V2_REPO_URL="${HOUSEYIELD_GAUSSIAN_ROMA_V2_REPO_URL:-}"
METRIC3D_ROOT="${HOUSEYIELD_GAUSSIAN_METRIC3D_ROOT:-/opt/Metric3D}"
COLMAP_VERSION="${HOUSEYIELD_GAUSSIAN_COLMAP_VERSION:-4.0.4}"
COLMAP_SRC_DIR="${HOUSEYIELD_GAUSSIAN_COLMAP_SRC_DIR:-/opt/colmap-src}"
COLMAP_CUDA_ARCHITECTURES="${HOUSEYIELD_GAUSSIAN_COLMAP_CUDA_ARCHITECTURES:-80}"

echo "================================================"
echo "HouseYield Gaussian RefGaussian-Only Installer"
echo "================================================"
echo "Service dir:       $SERVICE_DIR"
echo "Data dir:          $DATA_DIR"
echo "Master venv:       $MASTER_VENV_PATH"
echo "RefGaussian root:  $REFGAUSSIAN_ROOT"
echo "RefGaussian venv:  $REFGAUSSIAN_VENV_PATH"
echo "RoMaV2 root:       $ROMA_V2_ROOT"
echo "Metric3D root:     $METRIC3D_ROOT"
echo "COLMAP CUDA arch:  $COLMAP_CUDA_ARCHITECTURES"
echo ""
echo "Pipeline preset summary:"
echo "  learnedMatchingPreset=roma_v2"
echo "  learnedMatchingImageSize=1024"
echo "  gaussianViewerPreset=legacy_metric3d_sharp_mirror"
echo "  gaussianDepthPriorsMaxPointsPerImage=24000"
echo "  mirrorGaussianCommand=null"
echo "  refGaussianOnly=true"
echo "  preferredGaussianBackend=ref_gaussian"
echo "  refGaussianCleanup=disabled"
echo "  publishedFormat=.splat"
echo ""

export DEBIAN_FRONTEND=noninteractive
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export PATH="$CUDA_HOME/bin:/usr/local/cuda/bin:/usr/local/cuda-12.1/bin:${PATH}"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:/usr/local/cuda/lib64:/usr/local/cuda-12.1/lib64:${LD_LIBRARY_PATH:-}"

apt-get update
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
    libboost-graph-dev \
    libboost-system-dev \
    libboost-filesystem-dev \
    libboost-iostreams-dev \
    libboost-serialization-dev \
    libeigen3-dev \
    libopenimageio-dev \
    openimageio-tools \
    libmetis-dev \
    libgoogle-glog-dev \
    libgtest-dev \
    libgmock-dev \
    libsqlite3-dev \
    libglew-dev \
    libcgal-dev \
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
    libopencv-dev

update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-10 100
update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100

mkdir -p "$SERVICE_DIR" "$DATA_DIR" "$MODELS_DIR"
chmod 777 "$DATA_DIR"

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "ERROR: nvidia-smi is unavailable. Use a GPU image or install NVIDIA drivers first." >&2
    exit 1
fi

echo "GPU:"
nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader

install_colmap_global_mapper() {
    local global_mapper_ok=0
    local view_graph_ok=0
    if command -v colmap >/dev/null 2>&1; then
        colmap global_mapper -h >/dev/null 2>&1 && global_mapper_ok=1 || true
        colmap view_graph_calibrator -h >/dev/null 2>&1 && view_graph_ok=1 || true
    fi

    if [ "$global_mapper_ok" -eq 1 ] && [ "$view_graph_ok" -eq 1 ]; then
        echo "COLMAP global_mapper already installed"
    else
        echo "Installing COLMAP $COLMAP_VERSION global_mapper stack"
        rm -rf "$COLMAP_SRC_DIR"
        git clone --branch "$COLMAP_VERSION" --depth 1 https://github.com/colmap/colmap.git "$COLMAP_SRC_DIR"
        mkdir -p "$COLMAP_SRC_DIR/build"
        pushd "$COLMAP_SRC_DIR/build" >/dev/null
        cmake .. -GNinja \
            -DCMAKE_BUILD_TYPE=Release \
            -DBLA_VENDOR=OpenBLAS \
            -DCUDA_ENABLED=ON \
            -DCMAKE_CUDA_ARCHITECTURES="$COLMAP_CUDA_ARCHITECTURES" \
            -DCMAKE_C_COMPILER=/usr/bin/gcc-10 \
            -DCMAKE_CXX_COMPILER=/usr/bin/g++-10 \
            -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-10
        ninja
        ninja install
        ldconfig
        popd >/dev/null
    fi

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

    colmap global_mapper -h >/dev/null
    colmap view_graph_calibrator -h >/dev/null
    glomap -h >/dev/null
}

install_master_venv() {
    if [ ! -d "$MASTER_VENV_PATH/bin" ]; then
        python3 -m venv "$MASTER_VENV_PATH" --system-site-packages
    fi
    local pip_bin="$MASTER_VENV_PATH/bin/pip"
    local python_bin="$MASTER_VENV_PATH/bin/python3"

    "$pip_bin" install --upgrade pip wheel setuptools
    "$pip_bin" install \
        numpy \
        scipy \
        h5py \
        opencv-python \
        Pillow \
        scikit-learn \
        matplotlib \
        pandas \
        requests \
        tqdm \
        kornia \
        pycolmap \
        certifi \
        safetensors \
        transformers \
        accelerate \
        timm \
        einops \
        huggingface_hub \
        plyfile \
        trimesh \
        python-dotenv

    if ! "$python_bin" - <<'EOFCHECKTORCH'
import torch
assert torch.cuda.is_available()
print(f"torch={torch.__version__} cuda={torch.version.cuda}")
EOFCHECKTORCH
    then
        "$pip_bin" install torch torchvision
        "$python_bin" - <<'EOFCHECKTORCH2'
import torch
assert torch.cuda.is_available()
print(f"torch={torch.__version__} cuda={torch.version.cuda}")
EOFCHECKTORCH2
    fi
}

install_metric3d() {
    if [ ! -d "$METRIC3D_ROOT/.git" ]; then
        rm -rf "$METRIC3D_ROOT"
        git clone --recursive https://github.com/YvanYin/Metric3D.git "$METRIC3D_ROOT"
    else
        git -C "$METRIC3D_ROOT" pull --ff-only || true
        git -C "$METRIC3D_ROOT" submodule update --init --recursive
    fi

    "$MASTER_VENV_PATH/bin/pip" install \
        mmengine \
        mmcv-lite
}

install_roma_v2() {
    if [ -d "$ROMA_V2_ROOT/src" ]; then
        echo "$ROMA_V2_ROOT/src" > "$MASTER_VENV_PATH/lib/python3.10/site-packages/houseyield_roma_v2.pth"
    fi

    if "$MASTER_VENV_PATH/bin/python3" - <<'EOFCHECKROMA'
try:
    from romav2 import RoMaV2  # noqa: F401
    print("RoMaV2 already importable")
except Exception:
    raise SystemExit(1)
EOFCHECKROMA
    then
        return
    fi

    if [ -n "$ROMA_V2_REPO_URL" ]; then
        if [ ! -d "$ROMA_V2_ROOT/.git" ]; then
            rm -rf "$ROMA_V2_ROOT"
            git clone --recursive "$ROMA_V2_REPO_URL" "$ROMA_V2_ROOT"
        else
            git -C "$ROMA_V2_ROOT" pull --ff-only || true
            git -C "$ROMA_V2_ROOT" submodule update --init --recursive
        fi
        if [ -d "$ROMA_V2_ROOT/src" ]; then
            echo "$ROMA_V2_ROOT/src" > "$MASTER_VENV_PATH/lib/python3.10/site-packages/houseyield_roma_v2.pth"
        else
            "$MASTER_VENV_PATH/bin/pip" install -e "$ROMA_V2_ROOT"
        fi
    else
        echo "WARNING: RoMaV2 is not importable and HOUSEYIELD_GAUSSIAN_ROMA_V2_REPO_URL is not set." >&2
        echo "         Copy/provision the working RoMaV2 checkout to $ROMA_V2_ROOT or set the repo URL, then rerun." >&2
    fi
}

install_refgaussian() {
    if [ ! -d "$REFGAUSSIAN_ROOT/.git" ]; then
        rm -rf "$REFGAUSSIAN_ROOT"
        git clone --recursive "$REFGAUSSIAN_REPO_URL" "$REFGAUSSIAN_ROOT"
    else
        git -C "$REFGAUSSIAN_ROOT" pull --ff-only || true
        git -C "$REFGAUSSIAN_ROOT" submodule update --init --recursive
    fi

    python3 - "$REFGAUSSIAN_ROOT/scene/renderutils/ops.py" <<'EOF_PATCH_RENDERUTILS'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = """    torch.utils.cpp_extension.load(name='renderutils_plugin', sources=source_paths, extra_cflags=opts,\n         extra_cuda_cflags=opts, extra_ldflags=ldflags, with_cuda=True, verbose=True)\n\n    # Import, cache, and return the compiled module.\n    import renderutils_plugin\n    _cached_plugin = renderutils_plugin\n    return _cached_plugin\n"""
new = """    _cached_plugin = torch.utils.cpp_extension.load(name='renderutils_plugin', sources=source_paths, extra_cflags=opts,\n         extra_cuda_cflags=opts, extra_ldflags=ldflags, with_cuda=True, verbose=True)\n\n    # Cache and return the compiled module directly.\n    return _cached_plugin\n"""
if old in text:
    path.write_text(text.replace(old, new))
EOF_PATCH_RENDERUTILS

    if [ ! -d "$REFGAUSSIAN_VENV_PATH/bin" ]; then
        python3 -m venv "$REFGAUSSIAN_VENV_PATH" --system-site-packages
    fi

    local pip_bin="$REFGAUSSIAN_VENV_PATH/bin/pip"
    local python_bin="$REFGAUSSIAN_VENV_PATH/bin/python3"
    "$pip_bin" install --upgrade pip wheel setuptools

    if ! "$python_bin" - <<'EOFCHECKREFGTORCH'
import torch
assert torch.cuda.is_available()
print(f"refgaussian torch={torch.__version__} cuda={torch.version.cuda}")
EOFCHECKREFGTORCH
    then
        "$pip_bin" install torch torchvision
    fi

    "$pip_bin" uninstall -y \
        nvidia-cuda-nvcc \
        nvidia-cuda-cccl \
        nvidia-nvvm \
        nvidia-cuda-crt >/dev/null 2>&1 || true

    export CUDA_HOME=/usr/local/cuda
    export PATH="$CUDA_HOME/bin:$PATH"
    export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
    export LIBRARY_PATH="$CUDA_HOME/lib64:${LIBRARY_PATH:-}"
    export CPATH="/usr/include/eigen3:${CPATH:-}"
    export CPLUS_INCLUDE_PATH="/usr/include/eigen3:${CPLUS_INCLUDE_PATH:-}"
    nvcc --version

    local filtered_requirements
    filtered_requirements="$(mktemp)"
    grep -Ev '^(torch|torchvision|torchaudio|cubemapencoder|raytracing|skimage|nvdiffrast)==|^#|^[[:space:]]*$' \
        "$REFGAUSSIAN_ROOT/requirements.txt" > "$filtered_requirements" || true
    "$pip_bin" install --disable-pip-version-check -r "$filtered_requirements"
    rm -f "$filtered_requirements"
    "$pip_bin" install scikit-image
    "$pip_bin" install --disable-pip-version-check --no-build-isolation 'git+https://github.com/NVlabs/nvdiffrast.git'

    for submodule in cubemapencoder diff-surfel-rasterization simple-knn raytracing; do
        local path="$REFGAUSSIAN_ROOT/submodules/$submodule"
        if [ -d "$path" ]; then
            if [ "$submodule" = "simple-knn" ] && [ -f "$path/simple_knn.cu" ]; then
                "$python_bin" - "$path/simple_knn.cu" <<'EOF_PATCH_SIMPLE_KNN'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
if "FLT_MAX" in text and "<cfloat>" not in text and "<float.h>" not in text:
    marker = '#include "simple_knn.h"\n'
    if marker in text:
        text = text.replace(marker, marker + "#include <cfloat>\n")
    else:
        text = "#include <cfloat>\n" + text
    path.write_text(text)
EOF_PATCH_SIMPLE_KNN
            fi
            if [ "$submodule" = "raytracing" ] && [ -f "$path/setup.py" ]; then
                "$python_bin" - "$path/setup.py" "$path" <<'EOF_PATCH_RAYTRACING'
from pathlib import Path
import sys

path = Path(sys.argv[1])
src_path = Path(sys.argv[2])
text = path.read_text()
text = text.replace("-std=c++14", "-std=c++17")
text = text.replace(
    "minor_ver = int(line[len(MAJOR_VER_STR):])",
    "minor_ver = int(line[len(MINOR_VER_STR):])",
)
bundled_eigen = (src_path / "eigen-3.3.7").as_posix()
needle = "    return eigen_path\n"
replacement = (
    "    if eigen_path == 'eigen-3.3.7':\n"
    f"        eigen_path = os.path.join(_src_path, 'eigen-3.3.7')\n"
    "    return eigen_path\n"
)
if needle in text and "eigen_path == 'eigen-3.3.7'" not in text:
    text = text.replace(needle, replacement)
path.write_text(text)
EOF_PATCH_RAYTRACING
            fi
            "$pip_bin" install --disable-pip-version-check --no-build-isolation "$path"
        fi
    done
}

write_profile() {
    cat > /etc/profile.d/houseyield-gaussian.sh <<EOFPROFILE
source $MASTER_VENV_PATH/bin/activate
export MASTER_V1_GCP_SERVICE_DIR=$SERVICE_DIR
export MASTER_V1_GCP_DATA_DIR=$DATA_DIR
export MASTER_V1_GCP_VENV_PATH=$MASTER_VENV_PATH
export HF_HOME=/opt/models/huggingface
export TORCH_HOME=/opt/models/torch
export MASTER_PIPELINE_METRIC3D_REPO_DIR=$METRIC3D_ROOT
export MASTER_PIPELINE_ROMA_V2_ROOT=$ROMA_V2_ROOT
export MASTER_PIPELINE_REFGAUSSIAN_ROOT=$REFGAUSSIAN_ROOT
export REFGAUSSIAN_ROOT=$REFGAUSSIAN_ROOT
export MASTER_PIPELINE_REFGAUSSIAN_VENV_PATH=$REFGAUSSIAN_VENV_PATH
export MASTER_PIPELINE_REF_GAUSSIAN_COMMAND='$REFGAUSSIAN_VENV_PATH/bin/python3 $SERVICE_DIR/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root $REFGAUSSIAN_ROOT --python $REFGAUSSIAN_VENV_PATH/bin/python3'
export MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN=false
export HOUSEYIELD_GAUSSIAN_LEARNED_MATCHING_PRESET=roma_v2
export HOUSEYIELD_GAUSSIAN_LEARNED_MATCHING_IMAGE_SIZE=1024
export HOUSEYIELD_GAUSSIAN_VIEWER_PRESET=legacy_metric3d_sharp_mirror
export HOUSEYIELD_GAUSSIAN_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE=24000
export HOUSEYIELD_GAUSSIAN_REF_GAUSSIAN_ONLY=true
export HOUSEYIELD_GAUSSIAN_DISABLE_MIRROR_GAUSSIAN=true
export HOUSEYIELD_GAUSSIAN_CLEANUP=disabled
EOFPROFILE
}

verify_install() {
    command -v colmap >/dev/null
    command -v colmap-glomap >/dev/null
    command -v glomap >/dev/null

    "$MASTER_VENV_PATH/bin/python3" - <<EOF_VERIFY_MASTER
import os
import sys
import torch
import cv2  # noqa: F401
import h5py  # noqa: F401
import kornia  # noqa: F401
import numpy  # noqa: F401
import pycolmap  # noqa: F401
assert torch.cuda.is_available()
metric3d_root = "$METRIC3D_ROOT"
assert os.path.isfile(os.path.join(metric3d_root, "hubconf.py")), metric3d_root
roma_root = "$ROMA_V2_ROOT"
if os.path.isdir(os.path.join(roma_root, "src")) and os.path.join(roma_root, "src") not in sys.path:
    sys.path.insert(0, os.path.join(roma_root, "src"))
try:
    from romav2 import RoMaV2  # noqa: F401
    print("RoMaV2 import OK")
except Exception as exc:
    print(f"RoMaV2 import pending: {exc}")
print("master ref-only dependency import check OK")
EOF_VERIFY_MASTER

    "$REFGAUSSIAN_VENV_PATH/bin/python3" - <<EOF_VERIFY_REF
import os
import torch
import plyfile  # noqa: F401
root = "$REFGAUSSIAN_ROOT"
assert os.path.isfile(os.path.join(root, "train.py")), root
assert torch.cuda.is_available()
print("RefGaussian dependency import check OK")
EOF_VERIFY_REF

    if [ -f "$SERVICE_DIR/server/scripts/master_pipeline/run_refgaussian_adapter.py" ]; then
        if grep -q "disabled_temporarily" "$SERVICE_DIR/server/scripts/master_pipeline/run_refgaussian_adapter.py"; then
            echo "RefGaussian cleanup is disabled in deployed adapter"
        else
            echo "WARNING: deployed adapter does not contain disabled cleanup marker" >&2
        fi
    else
        echo "WARNING: worker bundle is not deployed yet at $SERVICE_DIR" >&2
    fi
}

install_colmap_global_mapper
install_master_venv
install_metric3d
install_roma_v2
install_refgaussian
write_profile
verify_install

echo "================================================"
echo "HouseYield Gaussian ref-only installer complete"
echo "================================================"
echo "Use this command template for RefGaussian:"
echo "$REFGAUSSIAN_VENV_PATH/bin/python3 $SERVICE_DIR/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root $REFGAUSSIAN_ROOT --python $REFGAUSSIAN_VENV_PATH/bin/python3"
echo "================================================"
