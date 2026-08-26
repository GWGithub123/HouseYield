#!/bin/bash

set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
    exec sudo bash "$0" "$@"
fi

SERVICE_DIR="${RENOVATION_MEASUREMENT_GCP_SERVICE_DIR:-/opt/renovation-measurement-service}"
VENV_PATH="${RENOVATION_MEASUREMENT_GCP_VENV_PATH:-/opt/renovation-measurement-venv}"
DATA_DIR="${RENOVATION_MEASUREMENT_GCP_DATA_DIR:-/opt/renovation-measurement-data}"
MODELS_DIR="${RENOVATION_MEASUREMENT_GCP_MODELS_DIR:-/opt/renovation-measurement-models}"
CACHE_DIR="${RENOVATION_MEASUREMENT_GCP_CACHE_DIR:-$DATA_DIR/cache}"
NODE_MAJOR="${RENOVATION_MEASUREMENT_NODE_MAJOR:-20}"
COLMAP_VERSION="${RENOVATION_MEASUREMENT_COLMAP_VERSION:-4.0.4}"
CUDA_ARCHITECTURES="${RENOVATION_MEASUREMENT_CUDA_ARCHITECTURES:-75;89}"
RUN_APT_UPGRADE="${RENOVATION_MEASUREMENT_APT_UPGRADE:-false}"
SETUP_SENTINEL="${RENOVATION_MEASUREMENT_SETUP_SENTINEL:-$DATA_DIR/.renovation-measurement-setup-complete}"
FORCE_SETUP="${RENOVATION_MEASUREMENT_FORCE_SETUP:-false}"

if [ "$FORCE_SETUP" != "true" ] && [ -f "$SETUP_SENTINEL" ]; then
    echo "Renovation measurement VM already provisioned; skipping heavy setup."
    echo "Set RENOVATION_MEASUREMENT_FORCE_SETUP=true to rerun provisioning."
    exit 0
fi

echo "================================================"
echo "Renovation Measurement VM Setup"
echo "================================================"
echo "Service dir: $SERVICE_DIR"
echo "Data dir:    $DATA_DIR"
echo "Venv:        $VENV_PATH"

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/cuda/bin:/usr/local/cuda-12.1/bin:${PATH}"
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:/usr/local/cuda-12.1/lib64:${LD_LIBRARY_PATH:-}"

apt-get update
if [ "$RUN_APT_UPGRADE" = "true" ]; then
    apt-get upgrade -y
fi

apt-get install -y --no-install-recommends \
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

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
    echo "Installing Node.js ${NODE_MAJOR}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
fi

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

mkdir -p "$SERVICE_DIR" "$DATA_DIR" "$MODELS_DIR" "$CACHE_DIR" "$MODELS_DIR/huggingface" "$MODELS_DIR/torch" "$CACHE_DIR/ultralytics"
chmod 777 "$DATA_DIR"

if [ ! -d "$VENV_PATH/bin" ]; then
    python3 -m venv "$VENV_PATH" --system-site-packages
fi

PIP="$VENV_PATH/bin/pip"
PYTHON="$VENV_PATH/bin/python3"

"$PIP" install --upgrade pip setuptools wheel
"$PIP" install \
    fastapi \
    'uvicorn[standard]' \
    numpy \
    scipy \
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
    ultralytics \
    transformers \
    accelerate \
    timm \
    einops \
    huggingface_hub \
    mmcv-lite

"$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cu121
if ! "$PYTHON" -c 'from sam2.sam2_image_predictor import SAM2ImagePredictor' >/dev/null 2>&1; then
    "$PIP" install 'git+https://github.com/facebookresearch/sam2.git'
fi
"$PYTHON" -c 'from sam2.sam2_image_predictor import SAM2ImagePredictor' >/dev/null

if [ ! -d /opt/hloc ]; then
    git clone --recursive https://github.com/cvg/Hierarchical-Localization.git /opt/hloc
fi
"$PIP" install -e /opt/hloc || true

if [ ! -d /opt/Metric3D ]; then
    git clone https://github.com/YvanYin/Metric3D.git /opt/Metric3D
fi

mkdir -p /opt/models/huggingface /opt/models/torch

cat > /etc/profile.d/renovation-measurement-venv.sh <<EOFPROFILE
source $VENV_PATH/bin/activate
export PYTHONPATH=/opt/Metric3D:/opt/hloc:\$PYTHONPATH
EOFPROFILE

if [ ! -f /etc/renovation-measurement.env ]; then
    cat > /etc/renovation-measurement.env <<EOFENV
NODE_ENV=production
RENOVATION_MEASUREMENT_API_HOST=0.0.0.0
RENOVATION_MEASUREMENT_API_PORT=8090
RENOVATION_MEASUREMENT_API_TIMEOUT_MS=600000
ROOM_GEOMETRY_GCP_ASSIST_ENABLE=false
MEASUREMENT_TARGET_DETECTOR_URL=http://127.0.0.1:8010/detect-target
MEASUREMENT_TARGET_SEGMENTATION_URL=http://127.0.0.1:8010/segment-target
ROOM_GEOMETRY_ASSIST_URL=http://127.0.0.1:8011/estimate-room-geometry
ROOM_GEOMETRY_ASSIST_TIMEOUT_MS=600000
ROOM_GEOMETRY_ASSIST_ROOM_TYPES=${ROOM_GEOMETRY_ASSIST_ROOM_TYPES:-bathroom,home_gym,basement,rec_room,family_room,media_room,bonus_room}
SPECIALIST_HOST=127.0.0.1
SPECIALIST_PORT=8010
SPECIALIST_DETECTOR_BACKEND=${SPECIALIST_DETECTOR_BACKEND:-auto}
SPECIALIST_YOLO_WEIGHTS=$MODELS_DIR/specialist-yolo.pt
SPECIALIST_GROUNDING_DINO_MODEL=${SPECIALIST_GROUNDING_DINO_MODEL:-IDEA-Research/grounding-dino-tiny}
SPECIALIST_SAM2_CHECKPOINT=facebook/sam2-hiera-large
SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD=${SPECIALIST_GROUNDING_DINO_BOX_THRESHOLD:-0.22}
SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD=${SPECIALIST_GROUNDING_DINO_TEXT_THRESHOLD:-0.15}
XDG_CACHE_HOME=$CACHE_DIR
HF_HOME=$MODELS_DIR/huggingface
TRANSFORMERS_CACHE=$MODELS_DIR/huggingface
TORCH_HOME=$MODELS_DIR/torch
YOLO_CONFIG_DIR=$CACHE_DIR/ultralytics
ROOM_GEOMETRY_ASSIST_HOST=127.0.0.1
ROOM_GEOMETRY_ASSIST_PORT=8011
ROOM_GEOMETRY_DATA_DIR=$DATA_DIR/geometry
ROOM_GEOMETRY_PYTHON_BIN=$PYTHON
ROOM_GEOMETRY_PIPELINE_SCRIPT=$SERVICE_DIR/server/scripts/photogrammetry_v2/pipeline_v2.py
ROOM_GEOMETRY_TIMEOUT_S=1800
ROOM_GEOMETRY_METRIC3D_MODEL=vit-small
ROOM_GEOMETRY_VOXEL_SIZE=0.02
EOFENV
fi

cat > /etc/systemd/system/renovation-measurement-api.service <<EOFAPI
[Unit]
Description=HouseYield Renovation Measurement API
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVICE_DIR
EnvironmentFile=/etc/renovation-measurement.env
ExecStart=/usr/bin/node $SERVICE_DIR/server/scripts/measurement/renovation_measurement_api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFAPI

cat > /etc/systemd/system/renovation-specialist-vision.service <<EOFSPECIALIST
[Unit]
Description=HouseYield Specialist Vision Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVICE_DIR
EnvironmentFile=/etc/renovation-measurement.env
ExecStart=$PYTHON $SERVICE_DIR/server/scripts/measurement/specialist_vision_service.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFSPECIALIST

cat > /etc/systemd/system/renovation-room-geometry-assist.service <<EOFGEOM
[Unit]
Description=HouseYield Room Geometry Assist Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVICE_DIR
EnvironmentFile=/etc/renovation-measurement.env
ExecStart=$PYTHON $SERVICE_DIR/server/scripts/measurement/room_geometry_assist_service.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFGEOM

systemctl daemon-reload
systemctl enable renovation-specialist-vision.service renovation-room-geometry-assist.service renovation-measurement-api.service
mkdir -p "$(dirname "$SETUP_SENTINEL")"
touch "$SETUP_SENTINEL"

echo ""
echo "Renovation measurement VM base setup complete"
echo "Node:          $(node -v)"
echo "Python:        $PYTHON"
echo "COLMAP:        $(command -v colmap)"
echo "glomap:        $(command -v glomap)"
echo "Service dir:   $SERVICE_DIR"
echo "Models dir:    $MODELS_DIR"
echo "Cache dir:     $CACHE_DIR"
echo "Env file:      /etc/renovation-measurement.env"
echo "Next step: deploy-renovation-measurement-vm.sh"