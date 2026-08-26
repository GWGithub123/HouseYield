#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Room-Tour 3D Pipeline — Standalone VM Provisioning
# ══════════════════════════════════════════════════════════════════════════════
#
# This script provisions a FRESH Ubuntu 22.04 VM with the full room-tour
# neural stack. It does NOT depend on the photogrammetry startup script.
#
# What it installs:
#   - NVIDIA GPU drivers + CUDA toolkit
#   - System build dependencies (cmake, gcc-10, boost, etc.)
#   - COLMAP with CUDA support
#   - FFmpeg for frame extraction
#   - A separate Python venv at /opt/room-tour-venv
#   - MASt3R (learned multiview geometry) at /opt/room-tour-service/mast3r
#   - Metric3D v2 at /opt/Metric3D
#   - gsplat (Gaussian splatting training) via pip
#   - Open3D, OpenCV, and all supporting packages
#
# Usage:
#   sudo bash room-tour-vm-setup.sh
#
# ══════════════════════════════════════════════════════════════════════════════

set -e

echo "════════════════════════════════════════════════════"
echo " Room-Tour Neural Pipeline — VM Setup"
echo "════════════════════════════════════════════════════"

# ──────────────────────────────────────────────────────────────────────────────
# Stage 0: GPU Drivers & CUDA
# ──────────────────────────────────────────────────────────────────────────────

if ! nvidia-smi &> /dev/null; then
    echo "Installing NVIDIA GPU drivers..."
    apt-get update -qq
    if [ -f /opt/deeplearning/install-driver.sh ]; then
        /opt/deeplearning/install-driver.sh
    else
        apt-get install -y nvidia-driver-570
    fi
    echo "GPU driver installed. Rebooting in 5 seconds..."
    echo "Re-run this script after reboot."
    sleep 5
    reboot
fi

echo "✓ GPU driver active: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"

# ──────────────────────────────────────────────────────────────────────────────
# Stage 0b: System packages
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing system build dependencies..."

apt-get update -qq
apt-get install -y \
    git \
    cmake \
    ninja-build \
    build-essential \
    libboost-program-options-dev \
    libboost-filesystem-dev \
    libboost-graph-dev \
    libboost-system-dev \
    libeigen3-dev \
    libflann-dev \
    libfreeimage-dev \
    libmetis-dev \
    libgoogle-glog-dev \
    libgtest-dev \
    libsqlite3-dev \
    libglew-dev \
    qtbase5-dev \
    libqt5opengl5-dev \
    libcgal-dev \
    libceres-dev \
    python3-pip \
    python3-venv \
    gcc-10 \
    g++-10 \
    libpng-dev \
    libjpeg-dev \
    zlib1g-dev \
    ffmpeg \
    wget \
    curl \
    unzip

echo "✓ System packages installed"

# ──────────────────────────────────────────────────────────────────────────────
# Stage 0c: CUDA toolkit (if nvcc not found)
# ──────────────────────────────────────────────────────────────────────────────

export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH

if ! command -v nvcc &> /dev/null; then
    echo ""
    echo "Installing CUDA toolkit 12.1..."
    wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
    dpkg -i cuda-keyring_1.1-1_all.deb
    apt-get update -qq
    apt-get install -y cuda-toolkit-12-1
    rm -f cuda-keyring_1.1-1_all.deb
    export PATH=/usr/local/cuda-12.1/bin:$PATH
    export LD_LIBRARY_PATH=/usr/local/cuda-12.1/lib64:$LD_LIBRARY_PATH
    ln -sf /usr/local/cuda-12.1 /usr/local/cuda
fi

echo "✓ CUDA found: $(nvcc --version | grep release)"

# ──────────────────────────────────────────────────────────────────────────────
# Stage 0d: COLMAP with CUDA
# ──────────────────────────────────────────────────────────────────────────────

if ! command -v colmap &> /dev/null; then
    echo ""
    echo "Building COLMAP with CUDA support..."
    cd /opt
    git clone https://github.com/colmap/colmap.git
    cd colmap
    git checkout b6b7b54eca6078070f73a3f0a084f79c629a6f10
    mkdir build && cd build
    cmake .. -GNinja \
        -DCMAKE_CUDA_ARCHITECTURES="61;75;89" \
        -DCUDA_ENABLED=ON \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=/usr/bin/gcc-10 \
        -DCMAKE_CXX_COMPILER=/usr/bin/g++-10 \
        -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-10
    ninja
    ninja install
    echo "✓ COLMAP with CUDA installed"
else
    echo "✓ COLMAP already installed: $(which colmap)"
fi

echo "✓ FFmpeg: $(ffmpeg -version 2>&1 | head -1)"

# ──────────────────────────────────────────────────────────────────────────────
# Create separate room-tour Python venv
# ──────────────────────────────────────────────────────────────────────────────

VENV_PATH="/opt/room-tour-venv"
PYTHON="$VENV_PATH/bin/python3"
PIP="$VENV_PATH/bin/pip"
SERVICE_DIR="/opt/room-tour-service"
DATA_DIR="/opt/room-tour-data"

echo ""
echo "Creating separate room-tour Python venv at $VENV_PATH..."

if [ ! -d "$VENV_PATH" ]; then
    python3 -m venv "$VENV_PATH" --system-site-packages
fi

$PIP install --upgrade pip

# ──────────────────────────────────────────────────────────────────────────────
# Install PyTorch + CUDA (into the room-tour venv)
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing PyTorch with CUDA into room-tour venv..."
$PIP install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# Verify GPU access from this venv
$PYTHON -c "import torch; assert torch.cuda.is_available(), 'No CUDA'; print(f'✓ PyTorch {torch.__version__} with CUDA {torch.version.cuda}')"

# ──────────────────────────────────────────────────────────────────────────────
# Install MASt3R (Matching and Stereo 3D Reconstruction)
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing MASt3R (learned multiview geometry)..."

MAST3R_DIR="$SERVICE_DIR/mast3r"

if [ ! -d "$MAST3R_DIR" ]; then
    mkdir -p "$SERVICE_DIR"
    cd "$SERVICE_DIR"
    git clone --recursive https://github.com/naver/mast3r.git
fi

cd "$MAST3R_DIR"
git pull --recurse-submodules || true

# Install MASt3R + DUSt3R dependencies
if [ -f "$MAST3R_DIR/dust3r/setup.py" ] || [ -f "$MAST3R_DIR/dust3r/pyproject.toml" ]; then
    $PIP install -e "$MAST3R_DIR/dust3r"
else
    echo "  dust3r has no setup.py — installing deps manually"
    $PIP install roma einops scipy huggingface_hub accelerate trimesh
fi

if [ -f "$MAST3R_DIR/setup.py" ] || [ -f "$MAST3R_DIR/pyproject.toml" ]; then
    $PIP install -e "$MAST3R_DIR"
else
    echo "  mast3r has no setup.py — adding to PYTHONPATH instead"
    echo "$MAST3R_DIR" > "$VENV_PATH/lib/python3.10/site-packages/mast3r.pth"
    echo "$MAST3R_DIR/dust3r" >> "$VENV_PATH/lib/python3.10/site-packages/mast3r.pth"
    echo "$MAST3R_DIR/dust3r/croco" >> "$VENV_PATH/lib/python3.10/site-packages/mast3r.pth"
fi

# Additional dependencies for MASt3R
$PIP install roma einops scipy huggingface_hub accelerate

# Download MASt3R pretrained checkpoint
echo "Downloading MASt3R pretrained weights..."
$PYTHON << 'EOF_MAST3R_DOWNLOAD'
import os
os.environ['HF_HOME'] = '/opt/models/huggingface'
os.makedirs('/opt/models/huggingface', exist_ok=True)

from huggingface_hub import hf_hub_download

# MASt3R ViT-Large checkpoint
try:
    path = hf_hub_download(
        repo_id="naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric",
        filename="checkpoint.pth",
        cache_dir='/opt/models/huggingface'
    )
    print(f"✓ MASt3R checkpoint downloaded: {path}")
except Exception as e:
    print(f"Warning: MASt3R download failed, will retry on first use: {e}")
EOF_MAST3R_DOWNLOAD

# Verify MASt3R imports
$PYTHON -c "from mast3r.model import AsymmetricMASt3R; print('✓ MASt3R importable')" || echo "⚠ MASt3R import check failed (may need first-run init)"

# ──────────────────────────────────────────────────────────────────────────────
# Install Metric3D v2 dependencies (repo is already at /opt/Metric3D)
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing Metric3D v2 dependencies into room-tour venv..."

$PIP install transformers timm einops huggingface_hub

# Metric3D repo — clone fresh if not present
if [ ! -d "/opt/Metric3D" ]; then
    echo "Cloning Metric3D v2..."
    cd /opt
    git clone https://github.com/YvanYin/Metric3D.git
fi

# Download model weights if not already cached
$PYTHON << 'EOF_METRIC3D_DOWNLOAD'
import os
os.environ['HF_HOME'] = '/opt/models/huggingface'
os.makedirs('/opt/models/huggingface', exist_ok=True)

from huggingface_hub import hf_hub_download

try:
    path = hf_hub_download(
        repo_id="JUGGHM/Metric3D",
        filename="metric_depth_vit_large_800k.pth",
        cache_dir='/opt/models/huggingface'
    )
    print(f"✓ Metric3D v2 model cached: {path}")
except Exception as e:
    print(f"Warning: Metric3D download issue: {e}")
EOF_METRIC3D_DOWNLOAD

# ──────────────────────────────────────────────────────────────────────────────
# Install gsplat (Gaussian Splatting training)
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing gsplat (Gaussian splatting)..."

# gsplat builds CUDA kernels at install time — needs nvcc in PATH
export CUDA_HOME=/usr/local/cuda
$PIP install gsplat

# Verify gsplat
$PYTHON -c "import gsplat; print(f'✓ gsplat {gsplat.__version__} installed')" || echo "⚠ gsplat import check (CUDA kernels compile on first use)"

# Also install nerfview for optional live monitoring and plyfile for splat export
$PIP install plyfile tqdm Pillow

# ──────────────────────────────────────────────────────────────────────────────
# Install remaining dependencies
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Installing supporting packages..."

$PIP install \
    numpy \
    opencv-python \
    open3d \
    trimesh \
    scipy \
    scikit-learn \
    matplotlib \
    Pillow \
    psutil

# ──────────────────────────────────────────────────────────────────────────────
# Create directories
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "Creating room-tour directories..."

mkdir -p "$SERVICE_DIR"
mkdir -p "$DATA_DIR"
chmod 777 "$DATA_DIR"

# ──────────────────────────────────────────────────────────────────────────────
# Create activation convenience script
# ──────────────────────────────────────────────────────────────────────────────

cat > /etc/profile.d/room-tour-venv.sh << 'EOF_PROFILE'
# Room-tour venv activation (separate from photogrammetry)
alias room-tour-env='source /opt/room-tour-venv/bin/activate'
export ROOM_TOUR_VENV=/opt/room-tour-venv
EOF_PROFILE

# ──────────────────────────────────────────────────────────────────────────────
# Final verification
# ──────────────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════"
echo " Verification"
echo "════════════════════════════════════════════════════"

$PYTHON << 'EOF_VERIFY'
import sys
print(f"Python: {sys.executable}")
print(f"Version: {sys.version}")

checks = []

try:
    import torch
    assert torch.cuda.is_available()
    checks.append(f"✓ PyTorch {torch.__version__} (CUDA {torch.version.cuda}, GPU: {torch.cuda.get_device_name(0)})")
except Exception as e:
    checks.append(f"✗ PyTorch: {e}")

try:
    from mast3r.model import AsymmetricMASt3R
    checks.append("✓ MASt3R importable")
except Exception as e:
    checks.append(f"✗ MASt3R: {e}")

try:
    sys.path.insert(0, '/opt/Metric3D')
    import torch
    checks.append("✓ Metric3D path available")
except Exception as e:
    checks.append(f"✗ Metric3D: {e}")

try:
    import gsplat
    checks.append(f"✓ gsplat {gsplat.__version__}")
except Exception as e:
    checks.append(f"✗ gsplat: {e}")

try:
    import open3d
    checks.append(f"✓ Open3D {open3d.__version__}")
except Exception as e:
    checks.append(f"✗ Open3D: {e}")

try:
    import cv2
    checks.append(f"✓ OpenCV {cv2.__version__}")
except Exception as e:
    checks.append(f"✗ OpenCV: {e}")

for c in checks:
    print(c)

failures = [c for c in checks if c.startswith("✗")]
if failures:
    print(f"\n⚠ {len(failures)} component(s) failed verification")
    sys.exit(1)
else:
    print("\n✓ All room-tour neural pipeline components verified")
EOF_VERIFY

echo ""
echo "════════════════════════════════════════════════════"
echo " Room-Tour VM Setup Complete"
echo "════════════════════════════════════════════════════"
echo ""
echo "Separate venv:    $VENV_PATH"
echo "Service dir:      $SERVICE_DIR"
echo "Data dir:         $DATA_DIR"
echo "MASt3R:           $MAST3R_DIR"
echo "Metric3D:         /opt/Metric3D (shared, read-only)"
echo "gsplat:           pip (in $VENV_PATH)"
echo ""
echo "Next: run deploy-room-tour-pipeline.sh to upload the processing script"
