#!/bin/bash

set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
    exec sudo bash "$0" "$@"
fi

REFGAUSSIAN_ROOT="${MASTER_PIPELINE_REFGAUSSIAN_ROOT:-/opt/ref-gaussian}"
REFGAUSSIAN_VENV_PATH="${MASTER_PIPELINE_REFGAUSSIAN_VENV_PATH:-/opt/ref-gaussian-venv}"
REFGAUSSIAN_REPO_URL="${MASTER_PIPELINE_REFGAUSSIAN_REPO_URL:-https://github.com/fudan-zvg/ref-gaussian.git}"
REFGAUSSIAN_TORCH_INDEX_URL="${MASTER_PIPELINE_REFGAUSSIAN_TORCH_INDEX_URL:-}"
REFGAUSSIAN_TORCH_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_TORCH_VERSION:-torch}"
REFGAUSSIAN_TORCHVISION_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_TORCHVISION_VERSION:-torchvision}"
REFGAUSSIAN_TORCHAUDIO_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_TORCHAUDIO_VERSION:-}"
REFGAUSSIAN_CUDA_NVCC_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_CUDA_NVCC_VERSION:-nvidia-cuda-nvcc==13.0.*}"
REFGAUSSIAN_CUDA_CCCL_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_CUDA_CCCL_VERSION:-nvidia-cuda-cccl==13.0.*}"
REFGAUSSIAN_CUDA_NVVM_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_CUDA_NVVM_VERSION:-nvidia-nvvm==13.0.*}"
REFGAUSSIAN_CUDA_CRT_VERSION="${MASTER_PIPELINE_REFGAUSSIAN_CUDA_CRT_VERSION:-nvidia-cuda-crt==13.0.*}"

echo "================================================"
echo "Master v1 RefGaussian VM Installer"
echo "================================================"
echo "Root:      $REFGAUSSIAN_ROOT"
echo "Venv:      $REFGAUSSIAN_VENV_PATH"
echo "Repo:      $REFGAUSSIAN_REPO_URL"
echo "Torch URL: $REFGAUSSIAN_TORCH_INDEX_URL"

export DEBIAN_FRONTEND=noninteractive
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export PATH="$CUDA_HOME/bin:/usr/local/cuda/bin:/usr/local/cuda-12.1/bin:${PATH}"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:/usr/local/cuda/lib64:/usr/local/cuda-12.1/lib64:${LD_LIBRARY_PATH:-}"

apt-get update
apt-get install -y git python3-venv python3-pip build-essential cmake ninja-build libeigen3-dev
export CPATH="/usr/include/eigen3:${CPATH:-}"
export CPLUS_INCLUDE_PATH="/usr/include/eigen3:${CPLUS_INCLUDE_PATH:-}"

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
    text = text.replace(old, new)
    path.write_text(text)
EOF_PATCH_RENDERUTILS

if [ ! -d "$REFGAUSSIAN_VENV_PATH/bin" ]; then
    python3 -m venv "$REFGAUSSIAN_VENV_PATH"
fi

PIP="$REFGAUSSIAN_VENV_PATH/bin/pip"
PYTHON="$REFGAUSSIAN_VENV_PATH/bin/python3"

"$PIP" install --upgrade pip wheel setuptools
TORCH_INSTALL_ARGS=(
    "$REFGAUSSIAN_TORCH_VERSION"
    "$REFGAUSSIAN_TORCHVISION_VERSION"
)
if [ -n "$REFGAUSSIAN_TORCHAUDIO_VERSION" ]; then
    TORCH_INSTALL_ARGS+=("$REFGAUSSIAN_TORCHAUDIO_VERSION")
fi
if [ -n "$REFGAUSSIAN_TORCH_INDEX_URL" ]; then
    TORCH_INSTALL_ARGS+=(--index-url "$REFGAUSSIAN_TORCH_INDEX_URL")
fi
"$PIP" install "${TORCH_INSTALL_ARGS[@]}"
"$PIP" install \
    "$REFGAUSSIAN_CUDA_NVCC_VERSION" \
    "$REFGAUSSIAN_CUDA_CCCL_VERSION" \
    "$REFGAUSSIAN_CUDA_NVVM_VERSION" \
    "$REFGAUSSIAN_CUDA_CRT_VERSION"

PYTHON_CUDA_HOME="$("$PYTHON" - <<'EOF_CUDA_HOME'
from pathlib import Path
import site

for site_dir in site.getsitepackages():
    for candidate in (
        Path(site_dir) / "nvidia" / "cu13",
        Path(site_dir) / "nvidia" / "cuda_nvcc",
    ):
        if (candidate / "bin" / "nvcc").exists():
            print(candidate)
            raise SystemExit
EOF_CUDA_HOME
)"
if [ -n "$PYTHON_CUDA_HOME" ]; then
    export CUDA_HOME="$PYTHON_CUDA_HOME"
    export PATH="$CUDA_HOME/bin:$PATH"
    export LD_LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
    export LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:${LIBRARY_PATH:-}"
    if [ -d "$CUDA_HOME/lib" ]; then
        for cuda_lib in "$CUDA_HOME"/lib/lib*.so.*; do
            [ -e "$cuda_lib" ] || continue
            cuda_lib_name="$(basename "$cuda_lib")"
            ln -sfn "$cuda_lib_name" "$CUDA_HOME/lib/${cuda_lib_name%%.so.*}.so"
        done
    fi
fi

FILTERED_REQUIREMENTS="$(mktemp)"
grep -Ev '^(torch|torchvision|torchaudio|cubemapencoder|raytracing|skimage|nvdiffrast)==|^#|^[[:space:]]*$' \
    "$REFGAUSSIAN_ROOT/requirements.txt" > "$FILTERED_REQUIREMENTS" || true
"$PIP" install --disable-pip-version-check -r "$FILTERED_REQUIREMENTS"
rm -f "$FILTERED_REQUIREMENTS"
"$PIP" install scikit-image
"$PIP" install --disable-pip-version-check --no-build-isolation 'git+https://github.com/NVlabs/nvdiffrast.git'

for submodule in cubemapencoder diff-surfel-rasterization simple-knn raytracing; do
    path="$REFGAUSSIAN_ROOT/submodules/$submodule"
    if [ -d "$path" ]; then
        if [ "$submodule" = "raytracing" ] && [ -f "$path/setup.py" ]; then
            "$PYTHON" - "$path/setup.py" <<'EOF_PATCH_RAYTRACING'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("-std=c++14", "-std=c++17")
path.write_text(text)
EOF_PATCH_RAYTRACING
        fi
        "$PIP" install --disable-pip-version-check --no-build-isolation "$path"
    fi
done

cat > /etc/profile.d/master-v1-refgaussian.sh <<EOFPROFILE
export MASTER_PIPELINE_REFGAUSSIAN_ROOT=$REFGAUSSIAN_ROOT
export REFGAUSSIAN_ROOT=$REFGAUSSIAN_ROOT
export MASTER_PIPELINE_REFGAUSSIAN_VENV_PATH=$REFGAUSSIAN_VENV_PATH
export MASTER_PIPELINE_REF_GAUSSIAN_COMMAND='$REFGAUSSIAN_VENV_PATH/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root $REFGAUSSIAN_ROOT --python $REFGAUSSIAN_VENV_PATH/bin/python3'
export MASTER_PIPELINE_REQUIRE_REF_GAUSSIAN=false
EOFPROFILE

"$PYTHON" - <<'EOF_VERIFY'
import os
import sys
import torch
import plyfile  # noqa: F401

root = os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_ROOT", "/opt/ref-gaussian")
assert os.path.isfile(os.path.join(root, "train.py")), root
print("RefGaussian dependency import check OK")
print(f"Torch CUDA available: {torch.cuda.is_available()}")
EOF_VERIFY

echo "================================================"
echo "RefGaussian installer complete"
echo "Command template:"
echo "$REFGAUSSIAN_VENV_PATH/bin/python3 /opt/master-v1-service/server/scripts/master_pipeline/run_refgaussian_adapter.py --manifest {manifest_path} --result {result_path} --output-dir {output_dir} --refgaussian-root $REFGAUSSIAN_ROOT --python $REFGAUSSIAN_VENV_PATH/bin/python3"
echo "================================================"
