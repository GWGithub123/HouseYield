#!/bin/bash
set -euo pipefail

COLMAP_VERSION="${COLMAP_VERSION:-4.0.4}"
COLMAP_SRC_DIR="${COLMAP_SRC_DIR:-/opt/colmap-src}"
CUDA_ARCHITECTURES="${COLMAP_CUDA_ARCHITECTURES:-75;89}"

if [ "${EUID}" -ne 0 ]; then
    exec sudo bash "$0" "$@"
fi

echo "[master_v1] Installing maintained COLMAP global-mapper stack"
echo "[master_v1] COLMAP version: $COLMAP_VERSION"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
    git \
    cmake \
    ninja-build \
    build-essential \
    python3-pip \
    gcc-10 \
    g++-10 \
    libboost-program-options-dev \
    libboost-graph-dev \
    libboost-system-dev \
    libeigen3-dev \
    libopenimageio-dev \
    openimageio-tools \
    libmetis-dev \
    libgoogle-glog-dev \
    libgtest-dev \
    libgmock-dev \
    libsqlite3-dev \
    libglew-dev \
    qt6-base-dev \
    libqt6opengl6-dev \
    libqt6openglwidgets6 \
    libcgal-dev \
    libceres-dev \
    libsuitesparse-dev \
    libcurl4-openssl-dev \
    libssl-dev

if ! dpkg -s libmkl-full-dev >/dev/null 2>&1; then
    apt-get install -y libmkl-full-dev || apt-get install -y libatlas-base-dev libopenblas-dev
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
if command -v colmap >/dev/null 2>&1; then
    colmap global_mapper -h >/dev/null 2>&1 && COLMAP_GLOBAL_MAPPER_OK=1
    colmap view_graph_calibrator -h >/dev/null 2>&1 && COLMAP_VIEW_GRAPH_OK=1
fi

if [ "$COLMAP_GLOBAL_MAPPER_OK" -ne 1 ] || [ "$COLMAP_VIEW_GRAPH_OK" -ne 1 ]; then
    echo "[master_v1] Building COLMAP from source"
    rm -rf "$COLMAP_SRC_DIR"
    git clone --branch "$COLMAP_VERSION" --depth 1 https://github.com/colmap/colmap.git "$COLMAP_SRC_DIR"
    cd "$COLMAP_SRC_DIR"
    mkdir -p build
    cd build

    CMAKE_ARGS=(
        -GNinja
        -DCMAKE_BUILD_TYPE=Release
        -DBLA_VENDOR=$COLMAP_BLAS_VENDOR
    )

    echo "[master_v1] Using BLAS vendor: $COLMAP_BLAS_VENDOR"

    if command -v nvcc >/dev/null 2>&1 && command -v nvidia-smi >/dev/null 2>&1; then
        export CC=/usr/bin/gcc-10
        export CXX=/usr/bin/g++-10
        export CUDAHOSTCXX=/usr/bin/g++-10
        CMAKE_ARGS+=(
            -DCUDA_ENABLED=ON
            -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES"
            -DCMAKE_C_COMPILER=/usr/bin/gcc-10
            -DCMAKE_CXX_COMPILER=/usr/bin/g++-10
            -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-10
        )
        echo "[master_v1] CUDA detected; enabling GPU build"
    else
        echo "[master_v1] CUDA toolchain not found; building COLMAP without CUDA"
        echo "[master_v1] This is acceptable for global_mapper only, but not for the full production room-tour pipeline" >&2
    fi

    cmake .. "${CMAKE_ARGS[@]}"
    ninja
    ninja install
    ldconfig
fi

if ! command -v colmap >/dev/null 2>&1; then
    echo "[master_v1] ERROR: colmap is not installed" >&2
    exit 1
fi

colmap global_mapper -h >/dev/null 2>&1 || {
    echo "[master_v1] ERROR: colmap global_mapper is unavailable after install" >&2
    exit 1
}

colmap view_graph_calibrator -h >/dev/null 2>&1 || {
    echo "[master_v1] ERROR: colmap view_graph_calibrator is unavailable after install" >&2
    exit 1
}

cat > /usr/local/bin/glomap <<'EOF'
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
EOF
chmod +x /usr/local/bin/glomap
ln -sf "$(command -v colmap)" /usr/local/bin/colmap-glomap

echo "[master_v1] Installed glomap compatibility wrapper"
echo "[master_v1] Verification:"
which colmap
which glomap
colmap global_mapper -h >/dev/null
colmap view_graph_calibrator -h >/dev/null
glomap -h >/dev/null
echo "[master_v1] Global-mapper stack ready"
