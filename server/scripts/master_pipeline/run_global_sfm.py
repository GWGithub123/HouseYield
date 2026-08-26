#!/usr/bin/env python3
"""Run global SfM for master_v1.

This worker is fail-fast by design. It requires learned indoor matches to be
imported successfully and requires a global-SfM backend for the mapping stage.
The intended backend is GLOMAP, either via the standalone ``glomap`` binary or
via the maintained COLMAP ``global_mapper`` command. There is no fallback to
alternative matchers or incremental COLMAP mapping.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path


GLOMAP_COLMAP_PATH = '/opt/glomap/build/_deps/colmap-build/src/colmap/exe/colmap'
PAIR_ID_MULTIPLIER = 2147483647
CAMERA_MODEL_PINHOLE = 1
COLMAP_SIFT_DESCRIPTOR_DIM = 128
COLMAP_FEATURE_EXTRACTOR_SIFT = 0
def read_env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return value.strip().lower() not in {'0', 'false', 'no', 'off'}


def read_env_int(name: str, default: int, minimum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = int(default)
    if minimum is not None:
        value = max(value, int(minimum))
    return value


def read_env_float(name: str, default: float, minimum: float | None = None) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = float(default)
    if minimum is not None:
        value = max(value, float(minimum))
    return value


MIN_TRACK_SUPPORT_FOR_PAIRWISE_IMPORT = read_env_int('MASTER_PIPELINE_MIN_TRACK_SUPPORT_FOR_PAIRWISE_IMPORT', 3, 2)
EXPERIMENTAL_MULTIVIEW_BACKEND_ENABLED = read_env_bool('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_BACKEND', True)
EXPERIMENTAL_MULTIVIEW_TRACK_MIN_SUPPORT = read_env_int('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_TRACK_MIN_SUPPORT', 3, 2)
EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS = read_env_int('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS', 2, 1)
EXPERIMENTAL_MULTIVIEW_MIN_SEED_INLIERS = read_env_int('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_MIN_SEED_INLIERS', 48, 8)
EXPERIMENTAL_MULTIVIEW_MIN_PNP_INLIERS = read_env_int('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_MIN_PNP_INLIERS', 24, 6)
EXPERIMENTAL_MULTIVIEW_PNP_REPROJECTION_ERROR = read_env_float('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_PNP_REPROJECTION_ERROR', 8.0, 0.5)
EXPERIMENTAL_MULTIVIEW_TRIANGULATION_ERROR = read_env_float('MASTER_PIPELINE_EXPERIMENTAL_MULTIVIEW_TRIANGULATION_ERROR', 12.0, 0.5)
FAST3R_MULTIVIEW_TRACK_PROMOTION_ENABLED = read_env_bool('MASTER_PIPELINE_FAST3R_MULTIVIEW_TRACK_PROMOTION', False)
FAST3R_PROMOTED_TRACK_MIN_SUPPORT = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_SUPPORT', 3, 2)
FAST3R_PROMOTED_TRACK_MIN_SOURCE_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_SOURCE_PAIRS', 2, 1)
FAST3R_PROMOTED_TRACK_MIN_MULTIVIEW_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_MULTIVIEW_PAIRS', 2, 1)
FAST3R_PROMOTED_TRACK_MIN_WINDOW_SUPPORT = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_WINDOW_SUPPORT', 4, 2)
FAST3R_PROMOTED_TRACK_MIN_LOCAL_HEAD_PAIRS = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_LOCAL_HEAD_PAIRS', 1, 0)
FAST3R_PROMOTED_TRACK_MIN_CONNECTIONS = read_env_int('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_CONNECTIONS', 2, 1)
FAST3R_PROMOTED_TRACK_MIN_MEAN_SCORE = read_env_float('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_MEAN_SCORE', 2.0, 0.0)
FAST3R_PROMOTED_TRACK_MIN_MEAN_PAIR_CONFIDENCE = read_env_float('MASTER_PIPELINE_FAST3R_PROMOTED_TRACK_MIN_MEAN_PAIR_CONFIDENCE', 2.0, 0.0)
FAST3R_POINTMAP_TAIL_RESCUE_ENABLED = read_env_bool('MASTER_PIPELINE_FAST3R_POINTMAP_TAIL_RESCUE', False)
FAST3R_POINTMAP_TAIL_RESCUE_MIN_ANCHORS = read_env_int('MASTER_PIPELINE_FAST3R_POINTMAP_TAIL_RESCUE_MIN_ANCHORS', 24, 6)
FAST3R_POINTMAP_TAIL_RESCUE_MAX_PNP_REPROJECTION_ERROR = read_env_float('MASTER_PIPELINE_FAST3R_POINTMAP_TAIL_RESCUE_MAX_PNP_REPROJECTION_ERROR', 8.0, 0.5)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def get_colmap_binary() -> str | None:
    if os.path.exists(GLOMAP_COLMAP_PATH):
        return GLOMAP_COLMAP_PATH

    colmap_glomap = shutil.which('colmap-glomap')
    if colmap_glomap:
        return colmap_glomap

    return shutil.which('colmap')


def colmap_supports_command(colmap_path: str, command_name: str) -> bool:
    try:
        result = subprocess.run(
            [colmap_path, command_name, '-h'],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        return False

    output = f'{result.stdout}\n{result.stderr}'.lower()
    if 'not recognized' in output or 'unknown command' in output:
        return False
    return result.returncode == 0


def colmap_command_supports_option(colmap_path: str, command_name: str, option_name: str) -> bool:
    try:
        result = subprocess.run(
            [colmap_path, command_name, '-h'],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception:
        return False

    output = f'{result.stdout}\n{result.stderr}'
    return option_name in output


def resolve_global_mapper_backend(colmap_path: str | None) -> dict | None:
    glomap_path = shutil.which('glomap')
    if glomap_path:
        return {
            'id': 'glomap',
            'command': [glomap_path, 'mapper'],
            'supportsViewGraphCalibrator': False,
        }

    if colmap_path and colmap_supports_command(colmap_path, 'global_mapper'):
        return {
            'id': 'colmap_global_mapper',
            'command': [colmap_path, 'global_mapper'],
            'supportsViewGraphCalibrator': colmap_supports_command(colmap_path, 'view_graph_calibrator'),
        }

    return None


def get_gpu_indices() -> str | None:
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=index', '--format=csv,noheader'],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        indices = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return ','.join(indices) if indices else None
    except Exception:
        return None


def run_command(command: list[str]) -> None:
    subprocess.run(command, check=True)


def find_largest_sparse_model(sparse_root: Path) -> Path:
    candidates = [path for path in sparse_root.iterdir() if path.is_dir()]
    if not candidates:
        raise RuntimeError('No sparse model directories generated')

    def model_size(directory: Path) -> int:
        images_bin = directory / 'images.bin'
        if images_bin.exists():
            return images_bin.stat().st_size
        points_bin = directory / 'points3D.bin'
        return points_bin.stat().st_size if points_bin.exists() else 0

    return max(candidates, key=model_size)


def count_registered_images(images_txt_path: Path) -> int:
    if not images_txt_path.exists():
        return 0
    with images_txt_path.open() as handle:
        lines = [line for line in handle if not line.startswith('#') and line.strip()]
    return len(lines) // 2


def count_points(points_txt_path: Path) -> int:
    if not points_txt_path.exists():
        return 0
    with points_txt_path.open() as handle:
        return sum(1 for line in handle if not line.startswith('#') and line.strip())


def collect_non_finite_pose_images(images_txt_path: Path) -> list[str]:
    if not images_txt_path.exists():
        return []

    with images_txt_path.open() as handle:
        data_lines = [line.strip() for line in handle if not line.startswith('#') and line.strip()]

    invalid_images: list[str] = []
    for index in range(0, len(data_lines), 2):
        tokens = data_lines[index].split()
        if len(tokens) < 10:
            continue

        try:
            pose_values = [float(value) for value in tokens[1:8]]
        except ValueError:
            invalid_images.append(tokens[9])
            continue

        if not all(math.isfinite(value) for value in pose_values):
            invalid_images.append(tokens[9])

    return invalid_images


def camera_center_from_pose(qvec: list[float], tvec: list[float]):
    import numpy as np

    qw, qx, qy, qz = [float(value) for value in qvec]
    rotation = np.asarray([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
        [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
        [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
    ], dtype=np.float64)
    translation = np.asarray(tvec, dtype=np.float64).reshape(3, 1)
    return (-rotation.T @ translation).reshape(3)


def collect_pose_outlier_images(
    images_by_name: dict[str, dict],
    *,
    mad_multiplier: float = 8.0,
    min_absolute_distance: float = 50.0,
    min_cameras_required: int = 4,
) -> tuple[list[str], dict]:
    import numpy as np

    if len(images_by_name) < min_cameras_required:
        return [], {
            'applied': False,
            'reason': 'too_few_cameras',
            'cameraCountBefore': len(images_by_name),
            'cameraCountAfter': len(images_by_name),
        }

    centers: dict[str, np.ndarray | None] = {}
    for image_name, image_entry in images_by_name.items():
        center = camera_center_from_pose(image_entry['qvec'], image_entry['tvec'])
        centers[image_name] = center if np.all(np.isfinite(center)) else None

    valid_names = [name for name, center in centers.items() if center is not None]
    non_finite_names = [name for name, center in centers.items() if center is None]
    if len(valid_names) < min_cameras_required:
        return non_finite_names, {
            'applied': bool(non_finite_names),
            'reason': 'non_finite_camera_centers',
            'outlierImages': non_finite_names,
            'cameraCountBefore': len(images_by_name),
            'cameraCountAfter': len(valid_names),
        }

    coords = np.stack([centers[name] for name in valid_names], axis=0)
    reference_center = np.median(coords, axis=0)
    distances = np.linalg.norm(coords - reference_center, axis=1)
    median_distance = float(np.median(distances))
    threshold = max(min_absolute_distance, mad_multiplier * max(median_distance, 1e-3))
    outliers = [
        name
        for name, distance in zip(valid_names, distances, strict=False)
        if float(distance) > threshold
    ]
    outliers.extend(non_finite_names)

    return outliers, {
        'applied': bool(outliers),
        'referenceCenter': [float(value) for value in reference_center],
        'medianDistance': median_distance,
        'threshold': float(threshold),
        'outlierImages': outliers,
        'cameraCountBefore': len(images_by_name),
        'cameraCountAfter': len(images_by_name) - len(outliers),
    }


def remove_images_from_colmap_model(
    cameras_by_id: dict[int, dict],
    images_by_name: dict[str, dict],
    points_by_id: dict[int, dict],
    excluded_image_names: set[str],
) -> tuple[dict[int, dict], dict[str, dict], dict[int, dict]]:
    excluded_image_ids = {
        images_by_name[image_name]['imageId']
        for image_name in excluded_image_names
        if image_name in images_by_name
    }
    filtered_images = {
        image_name: image_entry
        for image_name, image_entry in images_by_name.items()
        if image_name not in excluded_image_names
    }
    filtered_points: dict[int, dict] = {}
    for point_id, point in points_by_id.items():
        track = [
            (image_id, point2d_idx)
            for image_id, point2d_idx in point.get('track', [])
            if image_id not in excluded_image_ids
        ]
        if not track:
            filtered_points[point_id] = {**point, 'track': track}
            continue
        if len(track) >= 2:
            filtered_points[point_id] = {**point, 'track': track}
    return cameras_by_id, filtered_images, filtered_points


def filter_pose_outliers_in_text_model(text_model_dir: Path) -> dict:
    enabled = os.environ.get('MASTER_PIPELINE_SFM_CAMERA_OUTLIER_FILTER_ENABLE', 'true').strip().lower() not in {
        '0',
        'false',
        'no',
    }
    if not enabled:
        return {'applied': False, 'reason': 'disabled'}

    mad_multiplier = float(os.environ.get('MASTER_PIPELINE_SFM_CAMERA_OUTLIER_MAD_MULTIPLIER', '8.0'))
    min_absolute_distance = float(os.environ.get('MASTER_PIPELINE_SFM_CAMERA_OUTLIER_MIN_DISTANCE', '50.0'))
    min_cameras_required = int(os.environ.get('MASTER_PIPELINE_SFM_CAMERA_OUTLIER_MIN_CAMERAS', '4'))

    cameras_by_id = parse_colmap_cameras_text(text_model_dir / 'cameras.txt')
    images_by_name = parse_colmap_images_text(text_model_dir / 'images.txt')
    points_by_id = parse_colmap_points3d_text(text_model_dir / 'points3D.txt')
    outliers, diagnostics = collect_pose_outlier_images(
        images_by_name,
        mad_multiplier=mad_multiplier,
        min_absolute_distance=min_absolute_distance,
        min_cameras_required=min_cameras_required,
    )
    diagnostics['sparsePointCountBefore'] = len(points_by_id)
    if not outliers:
        diagnostics.setdefault('reason', 'no_outliers_detected')
        diagnostics['sparsePointCountAfter'] = len(points_by_id)
        return diagnostics

    if len(images_by_name) - len(outliers) < 2:
        diagnostics['applied'] = False
        diagnostics['reason'] = 'filter_would_remove_too_many_cameras'
        diagnostics['sparsePointCountAfter'] = len(points_by_id)
        return diagnostics

    _, filtered_images, filtered_points = remove_images_from_colmap_model(
        cameras_by_id,
        images_by_name,
        points_by_id,
        set(outliers),
    )
    write_colmap_text_model(cameras_by_id, filtered_images, filtered_points, text_model_dir)
    diagnostics['applied'] = True
    diagnostics['reason'] = 'removed_pose_outlier_cameras'
    diagnostics['sparsePointCountAfter'] = len(filtered_points)
    return diagnostics


def image_ids_to_pair_id(image_id1: int, image_id2: int) -> int:
    if image_id1 > image_id2:
        image_id1, image_id2 = image_id2, image_id1
    return PAIR_ID_MULTIPLIER * image_id1 + image_id2


def get_table_columns(cursor: sqlite3.Cursor, table_name: str) -> list[str]:
    return [row[1] for row in cursor.execute(f'PRAGMA table_info({table_name})').fetchall()]


def load_base_intrinsics(intrinsics_path: Path) -> dict | None:
    if not intrinsics_path.exists():
        return None

    try:
        intrinsics = json.loads(intrinsics_path.read_text())
    except Exception:
        return None

    required_keys = ('width', 'height', 'fx', 'fy', 'cx', 'cy')
    if not all(key in intrinsics for key in required_keys):
        return None

    return intrinsics


def build_camera_params(width: int, height: int, base_intrinsics: dict | None):
    import numpy as np

    if base_intrinsics:
        base_width = max(float(base_intrinsics['width']), 1.0)
        base_height = max(float(base_intrinsics['height']), 1.0)
        scale_x = width / base_width
        scale_y = height / base_height
        fx = float(base_intrinsics['fx']) * scale_x
        fy = float(base_intrinsics['fy']) * scale_y
        cx = float(base_intrinsics['cx']) * scale_x
        cy = float(base_intrinsics['cy']) * scale_y
    else:
        focal = max(width, height) * 1.2
        fx = focal
        fy = focal
        cx = width / 2.0
        cy = height / 2.0

    return np.asarray([fx, fy, cx, cy], dtype=np.float64)


def load_track_store(track_store_path: Path | None) -> dict | None:
    if track_store_path is None or not track_store_path.exists():
        return None

    try:
        return json.loads(track_store_path.read_text())
    except Exception:
        return None


def build_camera_matrix(camera_params):
    import numpy as np

    fx, fy, cx, cy = [float(value) for value in camera_params]
    return np.asarray([
        [fx, 0.0, cx],
        [0.0, fy, cy],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)


def normalize_keypoints(keypoints, camera_params):
    import numpy as np

    keypoints = np.asarray(keypoints, dtype=np.float64).reshape(-1, 2)
    fx, fy, cx, cy = [float(value) for value in camera_params]
    normalized = np.empty_like(keypoints, dtype=np.float64)
    normalized[:, 0] = (keypoints[:, 0] - cx) / max(fx, 1e-9)
    normalized[:, 1] = (keypoints[:, 1] - cy) / max(fy, 1e-9)
    return normalized


def rotation_matrix_to_qvec(rotation_matrix):
    import numpy as np

    matrix = np.asarray(rotation_matrix, dtype=np.float64)
    trace = float(np.trace(matrix))
    if trace > 0.0:
        scale = math.sqrt(trace + 1.0) * 2.0
        qw = 0.25 * scale
        qx = (matrix[2, 1] - matrix[1, 2]) / scale
        qy = (matrix[0, 2] - matrix[2, 0]) / scale
        qz = (matrix[1, 0] - matrix[0, 1]) / scale
    elif matrix[0, 0] > matrix[1, 1] and matrix[0, 0] > matrix[2, 2]:
        scale = math.sqrt(1.0 + matrix[0, 0] - matrix[1, 1] - matrix[2, 2]) * 2.0
        qw = (matrix[2, 1] - matrix[1, 2]) / scale
        qx = 0.25 * scale
        qy = (matrix[0, 1] + matrix[1, 0]) / scale
        qz = (matrix[0, 2] + matrix[2, 0]) / scale
    elif matrix[1, 1] > matrix[2, 2]:
        scale = math.sqrt(1.0 + matrix[1, 1] - matrix[0, 0] - matrix[2, 2]) * 2.0
        qw = (matrix[0, 2] - matrix[2, 0]) / scale
        qx = (matrix[0, 1] + matrix[1, 0]) / scale
        qy = 0.25 * scale
        qz = (matrix[1, 2] + matrix[2, 1]) / scale
    else:
        scale = math.sqrt(1.0 + matrix[2, 2] - matrix[0, 0] - matrix[1, 1]) * 2.0
        qw = (matrix[1, 0] - matrix[0, 1]) / scale
        qx = (matrix[0, 2] + matrix[2, 0]) / scale
        qy = (matrix[1, 2] + matrix[2, 1]) / scale
        qz = 0.25 * scale

    qvec = np.asarray([qw, qx, qy, qz], dtype=np.float64)
    norm = float(np.linalg.norm(qvec))
    if norm <= 0.0:
        return np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
    qvec /= norm
    if qvec[0] < 0.0:
        qvec *= -1.0
    return qvec


def qvec_to_rotation_matrix(qvec):
    import numpy as np

    qw, qx, qy, qz = [float(value) for value in qvec]
    return np.asarray([
        [1.0 - 2.0 * qy * qy - 2.0 * qz * qz, 2.0 * qx * qy - 2.0 * qz * qw, 2.0 * qx * qz + 2.0 * qy * qw],
        [2.0 * qx * qy + 2.0 * qz * qw, 1.0 - 2.0 * qx * qx - 2.0 * qz * qz, 2.0 * qy * qz - 2.0 * qx * qw],
        [2.0 * qx * qz - 2.0 * qy * qw, 2.0 * qy * qz + 2.0 * qx * qw, 1.0 - 2.0 * qx * qx - 2.0 * qy * qy],
    ], dtype=np.float64)


def sample_dense_map_values(dense_map, keypoints, image_size):
    import numpy as np

    dense_map = np.asarray(dense_map)
    keypoints = np.asarray(keypoints, dtype=np.float64).reshape(-1, 2)
    if dense_map.ndim < 2 or keypoints.size == 0:
        return np.zeros((0,), dtype=np.float32)

    image_width, image_height = image_size
    dense_height, dense_width = dense_map.shape[:2]
    scale_x = (dense_width - 1) / max(float(image_width - 1), 1.0)
    scale_y = (dense_height - 1) / max(float(image_height - 1), 1.0)

    sample_x = np.clip(np.rint(keypoints[:, 0] * scale_x).astype(np.int32), 0, dense_width - 1)
    sample_y = np.clip(np.rint(keypoints[:, 1] * scale_y).astype(np.int32), 0, dense_height - 1)
    return np.asarray(dense_map[sample_y, sample_x])


def load_depth_prior_dense_maps(depth_priors_dir, image_name, camera_params, cache, image_size):
    """Back-project a depth-prior map into a dense camera-frame pointmap (HxWx3)
    plus a per-pixel confidence map (HxW). License-clean replacement for the legacy
    Fast3R dense pointmaps. Returns (None, None) when depth priors are unavailable
    so the caller degrades gracefully (skips that pair)."""
    import numpy as np

    if depth_priors_dir is None:
        return None, None
    if image_name in cache:
        return cache[image_name]

    stem = Path(image_name).stem
    depth_path = Path(depth_priors_dir) / 'depth' / f'{stem}_depth.npy'
    confidence_path = Path(depth_priors_dir) / 'confidence' / f'{stem}_confidence.npy'
    if not depth_path.exists():
        cache[image_name] = (None, None)
        return None, None

    try:
        depth = np.asarray(np.load(depth_path), dtype=np.float64)
    except Exception:
        cache[image_name] = (None, None)
        return None, None

    if depth.ndim != 2:
        cache[image_name] = (None, None)
        return None, None

    height, width = depth.shape
    image_width, image_height = image_size
    fx, fy, cx, cy = [float(value) for value in camera_params]
    # Intrinsics are expressed at the source image resolution; rescale to the depth grid.
    scale_x = width / max(float(image_width), 1.0)
    scale_y = height / max(float(image_height), 1.0)
    fx *= scale_x
    fy *= scale_y
    cx *= scale_x
    cy *= scale_y

    us = np.arange(width, dtype=np.float64)[None, :]
    vs = np.arange(height, dtype=np.float64)[:, None]
    pointmap = np.empty((height, width, 3), dtype=np.float32)
    pointmap[:, :, 0] = ((us - cx) / max(fx, 1e-9) * depth).astype(np.float32)
    pointmap[:, :, 1] = ((vs - cy) / max(fy, 1e-9) * depth).astype(np.float32)
    pointmap[:, :, 2] = depth.astype(np.float32)
    pointmap[~np.isfinite(pointmap)] = 0.0
    pointmap[(depth <= 1e-6)[:, :, None].repeat(3, axis=2)] = 0.0

    if confidence_path.exists():
        try:
            confidence = np.asarray(np.load(confidence_path), dtype=np.float32)
            if confidence.shape != depth.shape:
                confidence = np.ones((height, width), dtype=np.float32)
        except Exception:
            confidence = np.ones((height, width), dtype=np.float32)
    else:
        confidence = np.ones((height, width), dtype=np.float32)
    confidence[~np.isfinite(confidence)] = 0.0
    confidence[depth <= 1e-6] = 0.0

    cache[image_name] = (pointmap, confidence)
    return pointmap, confidence


def estimate_similarity_transform(source_points, target_points, weights=None):
    import numpy as np

    source_points = np.asarray(source_points, dtype=np.float64).reshape(-1, 3)
    target_points = np.asarray(target_points, dtype=np.float64).reshape(-1, 3)
    if source_points.shape[0] != target_points.shape[0] or source_points.shape[0] < 3:
        return None

    if weights is None:
        weights = np.ones((source_points.shape[0],), dtype=np.float64)
    else:
        weights = np.asarray(weights, dtype=np.float64).reshape(-1)
    if weights.shape[0] != source_points.shape[0]:
        return None

    positive_mask = np.isfinite(weights) & (weights > 0.0)
    if positive_mask.sum() < 3:
        return None
    source_points = source_points[positive_mask]
    target_points = target_points[positive_mask]
    weights = weights[positive_mask]

    weight_sum = float(weights.sum())
    if weight_sum <= 0.0:
        return None
    normalized_weights = weights / weight_sum

    source_mean = np.sum(source_points * normalized_weights[:, None], axis=0)
    target_mean = np.sum(target_points * normalized_weights[:, None], axis=0)
    source_centered = source_points - source_mean
    target_centered = target_points - target_mean

    covariance = target_centered.T @ (source_centered * normalized_weights[:, None])
    u_matrix, singular_values, vh_matrix = np.linalg.svd(covariance)
    reflection = np.eye(3, dtype=np.float64)
    if np.linalg.det(u_matrix) * np.linalg.det(vh_matrix) < 0.0:
        reflection[-1, -1] = -1.0
    rotation = u_matrix @ reflection @ vh_matrix

    source_variance = float(np.sum(normalized_weights * np.sum(source_centered * source_centered, axis=1)))
    if source_variance <= 1e-12:
        return None
    scale = float(np.sum(singular_values * np.diag(reflection)) / source_variance)
    translation = target_mean - scale * (rotation @ source_mean)
    return {
        'scale': scale,
        'rotation': rotation,
        'translation': translation,
    }


def apply_similarity_transform(points, transform):
    import numpy as np

    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    return (float(transform['scale']) * (np.asarray(transform['rotation'], dtype=np.float64) @ points.T).T) + np.asarray(transform['translation'], dtype=np.float64)


def parse_colmap_cameras_text(cameras_txt_path: Path) -> dict[int, dict]:
    cameras: dict[int, dict] = {}
    if not cameras_txt_path.exists():
        return cameras

    with cameras_txt_path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith('#'):
                continue
            tokens = line.split()
            if len(tokens) < 5:
                continue
            camera_id = int(tokens[0])
            cameras[camera_id] = {
                'cameraId': camera_id,
                'model': tokens[1],
                'width': int(tokens[2]),
                'height': int(tokens[3]),
                'params': [float(value) for value in tokens[4:]],
            }
    return cameras


def parse_colmap_images_text(images_txt_path: Path) -> dict[str, dict]:
    images_by_name: dict[str, dict] = {}
    if not images_txt_path.exists():
        return images_by_name

    with images_txt_path.open() as handle:
        data_lines = [line.strip() for line in handle if not line.startswith('#') and line.strip()]

    for index in range(0, len(data_lines), 2):
        header_tokens = data_lines[index].split()
        if len(header_tokens) < 10:
            continue
        point_tokens = data_lines[index + 1].split() if index + 1 < len(data_lines) else []
        points2d = []
        for point_index in range(0, len(point_tokens), 3):
            if point_index + 2 >= len(point_tokens):
                break
            points2d.append({
                'xy': [float(point_tokens[point_index]), float(point_tokens[point_index + 1])],
                'point3DId': int(point_tokens[point_index + 2]),
            })

        image_name = header_tokens[9]
        images_by_name[image_name] = {
            'imageId': int(header_tokens[0]),
            'qvec': [float(value) for value in header_tokens[1:5]],
            'tvec': [float(value) for value in header_tokens[5:8]],
            'cameraId': int(header_tokens[8]),
            'image': image_name,
            'points2D': points2d,
        }
    return images_by_name


def parse_colmap_points3d_text(points_txt_path: Path) -> dict[int, dict]:
    import numpy as np

    points_by_id: dict[int, dict] = {}
    if not points_txt_path.exists():
        return points_by_id

    with points_txt_path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith('#'):
                continue
            tokens = line.split()
            if len(tokens) < 8:
                continue
            point_id = int(tokens[0])
            track = []
            for track_index in range(8, len(tokens), 2):
                if track_index + 1 >= len(tokens):
                    break
                track.append((int(tokens[track_index]), int(tokens[track_index + 1])))
            points_by_id[point_id] = {
                'pointId': point_id,
                'xyz': np.asarray([float(value) for value in tokens[1:4]], dtype=np.float64),
                'rgb': [int(value) for value in tokens[4:7]],
                'error': float(tokens[7]),
                'track': track,
            }
    return points_by_id


def build_point3d_id_by_feature_index(image_entry: dict, feature_keypoints: list[list[float]] | list[tuple[float, float]]) -> list[int]:
    import numpy as np
    from collections import defaultdict

    feature_points = np.asarray(feature_keypoints, dtype=np.float64).reshape(-1, 2)
    if feature_points.size == 0:
        return []

    point_ids = [-1] * int(feature_points.shape[0])
    points2d = image_entry.get('points2D', [])
    if not points2d:
        return point_ids

    lookup: defaultdict[tuple[int, int], list[int]] = defaultdict(list)
    for feature_index, xy in enumerate(feature_points):
        lookup[(int(round(float(xy[0]) * 1000.0)), int(round(float(xy[1]) * 1000.0)))].append(feature_index)

    unresolved = []
    for point_entry in points2d:
        point_id = int(point_entry.get('point3DId', -1))
        if point_id <= 0:
            continue
        xy = np.asarray(point_entry.get('xy', [0.0, 0.0]), dtype=np.float64).reshape(2)
        key = (int(round(float(xy[0]) * 1000.0)), int(round(float(xy[1]) * 1000.0)))
        candidate_indices = lookup.get(key, [])
        if candidate_indices:
            if len(candidate_indices) == 1:
                point_ids[candidate_indices[0]] = point_id
            else:
                best_index = min(candidate_indices, key=lambda index: float(np.sum((feature_points[index] - xy) ** 2)))
                point_ids[best_index] = point_id
            continue
        unresolved.append((xy, point_id))

    if unresolved:
        for xy, point_id in unresolved:
            squared_distances = np.sum((feature_points - xy) ** 2, axis=1)
            best_index = int(np.argmin(squared_distances))
            if float(squared_distances[best_index]) <= 2.25:
                point_ids[best_index] = point_id

    return point_ids


def write_colmap_text_model(cameras_by_id: dict[int, dict], images_by_name: dict[str, dict], points_by_id: dict[int, dict], output_dir: Path) -> dict:
    text_model_dir = ensure_dir(output_dir)
    cameras_txt_path = text_model_dir / 'cameras.txt'
    images_txt_path = text_model_dir / 'images.txt'
    points_txt_path = text_model_dir / 'points3D.txt'

    camera_lines = ['# Camera list\n', '# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n']
    for camera_id in sorted(cameras_by_id):
        camera = cameras_by_id[camera_id]
        params = ' '.join(str(value) for value in camera['params'])
        camera_lines.append(f"{camera_id} {camera['model']} {camera['width']} {camera['height']} {params}\n")
    cameras_txt_path.write_text(''.join(camera_lines), encoding='utf-8')

    image_lines = ['# Image list\n', '# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n', '# POINTS2D[] as (X, Y, POINT3D_ID)\n']
    for image_entry in sorted(images_by_name.values(), key=lambda item: item['imageId']):
        qvec = image_entry['qvec']
        tvec = image_entry['tvec']
        image_lines.append(
            f"{image_entry['imageId']} {qvec[0]} {qvec[1]} {qvec[2]} {qvec[3]} {tvec[0]} {tvec[1]} {tvec[2]} {image_entry['cameraId']} {image_entry['image']}\n"
        )
        points2d = image_entry.get('points2D', [])
        if points2d:
            image_lines.append(' '.join(f"{point['xy'][0]} {point['xy'][1]} {point['point3DId']}" for point in points2d) + '\n')
        else:
            image_lines.append('0 0 -1\n')
    images_txt_path.write_text(''.join(image_lines), encoding='utf-8')

    point_lines = ['# 3D point list\n', '# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n']
    for point_id in sorted(points_by_id):
        point = points_by_id[point_id]
        xyz = point['xyz']
        rgb = point['rgb']
        track = ' '.join(f'{image_id} {point2d_idx}' for image_id, point2d_idx in point.get('track', []))
        point_lines.append(f'{point_id} {xyz[0]} {xyz[1]} {xyz[2]} {rgb[0]} {rgb[1]} {rgb[2]} {point["error"]} {track}\n')
    points_txt_path.write_text(''.join(point_lines), encoding='utf-8')

    return {
        'textModelDir': str(text_model_dir),
        'camerasPath': str(cameras_txt_path),
        'imagesPath': str(images_txt_path),
        'pointsPath': str(points_txt_path),
    }


def copy_colmap_text_model(source_dir: Path, output_dir: Path) -> dict:
    import shutil

    text_model_dir = ensure_dir(output_dir)
    model_paths = {
        'textModelDir': str(text_model_dir),
        'camerasPath': str(text_model_dir / 'cameras.txt'),
        'imagesPath': str(text_model_dir / 'images.txt'),
        'pointsPath': str(text_model_dir / 'points3D.txt'),
    }
    for filename in ('cameras.txt', 'images.txt', 'points3D.txt'):
        source_path = source_dir / filename
        if not source_path.exists():
            raise RuntimeError(f'Missing COLMAP text-model file for promotion: {source_path}')
        shutil.copy2(source_path, text_model_dir / filename)
    return model_paths


def triangulate_track_point(observations, registered_poses, camera_params_by_name, max_mean_reprojection_error: float):
    import numpy as np

    usable_observations = [observation for observation in observations if observation['image'] in registered_poses]
    if len(usable_observations) < 2:
        return None

    prepared_observations = []
    for observation in usable_observations:
        pose = registered_poses[observation['image']]
        projection = build_camera_matrix(camera_params_by_name[observation['image']]) @ np.hstack([
            np.asarray(pose['R'], dtype=np.float64),
            np.asarray(pose['t'], dtype=np.float64).reshape(3, 1),
        ])
        prepared_observations.append({
            'observation': observation,
            'projection': projection,
        })

    best_candidate = None
    for left_index in range(len(prepared_observations) - 1):
        for right_index in range(left_index + 1, len(prepared_observations)):
            hypothesis_views = [prepared_observations[left_index], prepared_observations[right_index]]
            design_rows = []
            for view in hypothesis_views:
                x_coord = float(view['observation']['xy'][0])
                y_coord = float(view['observation']['xy'][1])
                projection = view['projection']
                design_rows.append((x_coord * projection[2]) - projection[0])
                design_rows.append((y_coord * projection[2]) - projection[1])

            _, _, vh = np.linalg.svd(np.asarray(design_rows, dtype=np.float64))
            homogeneous_point = vh[-1]
            if abs(float(homogeneous_point[3])) < 1e-9:
                continue

            point = homogeneous_point[:3] / homogeneous_point[3]
            inlier_errors = []
            all_errors = []
            valid_candidate = True
            for view in prepared_observations:
                projection = view['projection']
                camera_point = projection[:, :3] @ point + projection[:, 3]
                depth = float(camera_point[2])
                if not np.all(np.isfinite(camera_point)) or depth <= 1e-6:
                    valid_candidate = False
                    break
                projected_xy = camera_point[:2] / depth
                reprojection_error = float(np.linalg.norm(projected_xy - np.asarray(view['observation']['xy'], dtype=np.float64)))
                all_errors.append(reprojection_error)
                if reprojection_error <= float(max_mean_reprojection_error):
                    inlier_errors.append(reprojection_error)

            if not valid_candidate or len(inlier_errors) < 2:
                continue

            mean_error = float(sum(inlier_errors) / len(inlier_errors))
            max_error = float(max(inlier_errors))
            candidate = {
                'point': np.asarray(point, dtype=np.float64),
                'meanError': mean_error,
                'maxError': max_error,
                'observationCount': len(inlier_errors),
                'allObservationCount': len(all_errors),
            }
            if best_candidate is None or (
                candidate['observationCount'],
                -candidate['meanError'],
                -candidate['maxError'],
            ) > (
                best_candidate['observationCount'],
                -best_candidate['meanError'],
                -best_candidate['maxError'],
            ):
                best_candidate = candidate

    return best_candidate


def build_experimental_pair_track_index(filtered_tracks: list[dict]) -> dict[tuple[str, str], list[dict]]:
    pair_track_index: dict[tuple[str, str], list[dict]] = {}
    for track in filtered_tracks:
        observations_by_image = {observation['image']: observation for observation in track.get('observations', [])}
        for image0, image1 in itertools.combinations(sorted(observations_by_image), 2):
            pair_track_index.setdefault((image0, image1), []).append({
                'trackId': track['trackId'],
                'support': int(track['support']),
                'observation0': observations_by_image[image0],
                'observation1': observations_by_image[image1],
            })
    return pair_track_index


def resolve_experimental_pnp_min_inliers(candidate_point_count: int) -> int:
    adaptive_floor = max(12, int(math.ceil(float(candidate_point_count) * 0.4)))
    return min(EXPERIMENTAL_MULTIVIEW_MIN_PNP_INLIERS, adaptive_floor)


def estimate_experimental_seed_pair(camera_edges: list[dict], pair_track_index: dict[tuple[str, str], list[dict]], camera_params_by_name: dict[str, object], reference_image: str | None) -> dict | None:
    import cv2
    import numpy as np

    candidate_edges = sorted(
        camera_edges,
        key=lambda edge: (
            0 if reference_image in {edge['image0'], edge['image1']} else 1,
            -int(edge['sharedTrackCount']),
            edge['image0'],
            edge['image1'],
        ),
    )

    best_seed = None
    for edge in candidate_edges:
        image0 = str(edge['image0'])
        image1 = str(edge['image1'])
        pair_key = tuple(sorted((image0, image1)))
        pair_tracks = pair_track_index.get(pair_key, [])
        if len(pair_tracks) < EXPERIMENTAL_MULTIVIEW_MIN_SEED_INLIERS:
            continue

        points0 = np.asarray([entry['observation0']['xy'] for entry in pair_tracks], dtype=np.float64)
        points1 = np.asarray([entry['observation1']['xy'] for entry in pair_tracks], dtype=np.float64)
        normalized0 = normalize_keypoints(points0, camera_params_by_name[pair_key[0]])
        normalized1 = normalize_keypoints(points1, camera_params_by_name[pair_key[1]])

        essential_matrix, mask = cv2.findEssentialMat(
            normalized0,
            normalized1,
            cameraMatrix=np.eye(3, dtype=np.float64),
            method=cv2.RANSAC,
            prob=0.999,
            threshold=0.01,
        )
        if essential_matrix is None or mask is None:
            continue

        inlier_count, rotation, translation, pose_mask = cv2.recoverPose(
            essential_matrix,
            normalized0,
            normalized1,
            cameraMatrix=np.eye(3, dtype=np.float64),
            mask=mask,
        )
        if int(inlier_count) < EXPERIMENTAL_MULTIVIEW_MIN_SEED_INLIERS:
            continue

        pose_mask = np.asarray(pose_mask).reshape(-1).astype(bool)
        inlier_entries = [pair_tracks[index] for index in range(min(len(pair_tracks), pose_mask.size)) if pose_mask[index]]
        candidate_seed = {
            'image0': pair_key[0],
            'image1': pair_key[1],
            'rotation': np.asarray(rotation, dtype=np.float64),
            'translation': np.asarray(translation, dtype=np.float64).reshape(3),
            'inlierCount': int(len(inlier_entries)),
            'inlierEntries': inlier_entries,
            'sharedTrackCount': int(edge['sharedTrackCount']),
            'sharedTrackSupport': int(edge['sharedTrackSupport']),
        }
        if best_seed is None or (candidate_seed['inlierCount'], candidate_seed['sharedTrackSupport']) > (best_seed['inlierCount'], best_seed['sharedTrackSupport']):
            best_seed = candidate_seed

    return best_seed


def run_experimental_multiview_solver(
    *,
    images: list[Path],
    filtered_tracks: list[dict],
    camera_edges: list[dict],
    camera_params_by_name: dict[str, object],
    reference_image: str | None,
) -> dict:
    import cv2
    import numpy as np

    if not filtered_tracks:
        raise RuntimeError('No multiview tracks available for experimental reconstruction')

    image_names = [image.name for image in images]
    track_lookup = {track['trackId']: track for track in filtered_tracks}
    pair_track_index = build_experimental_pair_track_index(filtered_tracks)
    seed = estimate_experimental_seed_pair(camera_edges, pair_track_index, camera_params_by_name, reference_image)
    if seed is None:
        raise RuntimeError('Experimental multiview solver could not find a valid seed image pair')

    registered_poses = {
        seed['image0']: {
            'R': np.eye(3, dtype=np.float64),
            't': np.zeros(3, dtype=np.float64),
        },
        seed['image1']: {
            'R': np.asarray(seed['rotation'], dtype=np.float64),
            't': np.asarray(seed['translation'], dtype=np.float64).reshape(3),
        },
    }
    registered_order = [seed['image0'], seed['image1']]

    points_by_track_id: dict[str, dict] = {}
    for entry in seed['inlierEntries']:
        track_id = entry['trackId']
        triangulated = triangulate_track_point(
            [entry['observation0'], entry['observation1']],
            registered_poses,
            camera_params_by_name,
            EXPERIMENTAL_MULTIVIEW_TRIANGULATION_ERROR,
        )
        if triangulated is not None:
            points_by_track_id[track_id] = triangulated

    image_observation_index: dict[str, list[tuple[str, dict]]] = {image_name: [] for image_name in image_names}
    for track in filtered_tracks:
        for observation in track.get('observations', []):
            image_observation_index.setdefault(observation['image'], []).append((track['trackId'], observation))

    while True:
        best_candidate = None
        for image_name in image_names:
            if image_name in registered_poses:
                continue

            candidate_track_ids = []
            object_points = []
            image_points = []
            for track_id, observation in image_observation_index.get(image_name, []):
                point_entry = points_by_track_id.get(track_id)
                if point_entry is None:
                    continue
                candidate_track_ids.append(track_id)
                object_points.append(point_entry['point'])
                image_points.append(observation['xy'])

            required_inliers = resolve_experimental_pnp_min_inliers(len(object_points))
            if len(object_points) < required_inliers:
                continue

            object_points_array = np.asarray(object_points, dtype=np.float64)
            image_points_array = np.asarray(image_points, dtype=np.float64)
            camera_matrix = build_camera_matrix(camera_params_by_name[image_name])
            success, rvec, tvec, inliers = cv2.solvePnPRansac(
                object_points_array,
                image_points_array,
                camera_matrix,
                None,
                iterationsCount=250,
                reprojectionError=float(EXPERIMENTAL_MULTIVIEW_PNP_REPROJECTION_ERROR),
                confidence=0.999,
                flags=cv2.SOLVEPNP_EPNP,
            )
            if not success or inliers is None or int(len(inliers)) < required_inliers:
                continue

            inlier_indices = np.asarray(inliers, dtype=np.int32).reshape(-1)
            cv2.solvePnP(
                object_points_array[inlier_indices],
                image_points_array[inlier_indices],
                camera_matrix,
                None,
                rvec,
                tvec,
                useExtrinsicGuess=True,
                flags=cv2.SOLVEPNP_ITERATIVE,
            )
            rotation, _ = cv2.Rodrigues(rvec)
            projected_points, _ = cv2.projectPoints(object_points_array[inlier_indices], rvec, tvec, camera_matrix, None)
            reprojection_errors = np.linalg.norm(projected_points.reshape(-1, 2) - image_points_array[inlier_indices], axis=1)
            candidate = {
                'image': image_name,
                'rotation': np.asarray(rotation, dtype=np.float64),
                'translation': np.asarray(tvec, dtype=np.float64).reshape(3),
                'inlierCount': int(len(inlier_indices)),
                'requiredInliers': int(required_inliers),
                'meanReprojectionError': float(reprojection_errors.mean()) if reprojection_errors.size else float('inf'),
                'supportTrackIds': [candidate_track_ids[index] for index in inlier_indices],
            }
            if best_candidate is None or (candidate['inlierCount'], -candidate['meanReprojectionError']) > (best_candidate['inlierCount'], -best_candidate['meanReprojectionError']):
                best_candidate = candidate

        if best_candidate is None:
            break

        image_name = best_candidate['image']
        registered_poses[image_name] = {
            'R': best_candidate['rotation'],
            't': best_candidate['translation'],
        }
        registered_order.append(image_name)

        for track in filtered_tracks:
            if track['trackId'] in points_by_track_id:
                continue
            triangulated = triangulate_track_point(
                [observation for observation in track.get('observations', []) if observation['image'] in registered_poses],
                registered_poses,
                camera_params_by_name,
                EXPERIMENTAL_MULTIVIEW_TRIANGULATION_ERROR,
            )
            if triangulated is not None:
                points_by_track_id[track['trackId']] = triangulated

    refined_points: dict[str, dict] = {}
    for track in filtered_tracks:
        triangulated = triangulate_track_point(
            [observation for observation in track.get('observations', []) if observation['image'] in registered_poses],
            registered_poses,
            camera_params_by_name,
            EXPERIMENTAL_MULTIVIEW_TRIANGULATION_ERROR,
        )
        if triangulated is not None:
            refined_points[track['trackId']] = triangulated

    if refined_points:
        points_by_track_id = refined_points

    point_errors = [point_entry['meanError'] for point_entry in points_by_track_id.values()]
    return {
        'seedImage0': seed['image0'],
        'seedImage1': seed['image1'],
        'seedInlierCount': int(seed['inlierCount']),
        'registeredPoses': registered_poses,
        'registeredImages': registered_order,
        'unregisteredImages': [image_name for image_name in image_names if image_name not in registered_poses],
        'pointsByTrackId': points_by_track_id,
        'meanPointReprojectionError': float(sum(point_errors) / len(point_errors)) if point_errors else None,
        'trackLookup': track_lookup,
    }


def write_experimental_multiview_model(
    *,
    experimental_dir: Path,
    images: list[Path],
    image_size_by_name: dict[str, tuple[int, int]],
    camera_params_by_name: dict[str, object],
    reconstruction: dict,
) -> dict:
    import numpy as np

    text_model_dir = ensure_dir(experimental_dir / 'text-model')
    poses_path = experimental_dir / 'poses.json'
    cameras_txt_path = text_model_dir / 'cameras.txt'
    images_txt_path = text_model_dir / 'images.txt'
    points_txt_path = text_model_dir / 'points3D.txt'

    registered_poses = reconstruction['registeredPoses']
    track_lookup = reconstruction['trackLookup']
    points_by_track_id = reconstruction['pointsByTrackId']
    image_id_by_name = {image.name: index for index, image in enumerate(images, start=1)}

    camera_ids_by_size: dict[tuple[int, int], int] = {}
    camera_id_by_name: dict[str, int] = {}
    camera_lines = ['# Camera list\n', '# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n']
    for image in images:
        image_name = image.name
        if image_name not in registered_poses:
            continue
        width, height = image_size_by_name[image_name]
        camera_key = (width, height)
        camera_id = camera_ids_by_size.get(camera_key)
        if camera_id is None:
            camera_id = len(camera_ids_by_size) + 1
            camera_ids_by_size[camera_key] = camera_id
            fx, fy, cx, cy = [float(value) for value in camera_params_by_name[image_name]]
            camera_lines.append(f'{camera_id} PINHOLE {width} {height} {fx} {fy} {cx} {cy}\n')
        camera_id_by_name[image_name] = camera_id
    cameras_txt_path.write_text(''.join(camera_lines), encoding='utf-8')

    image_points_by_name: dict[str, list[tuple[float, float, int]]] = {image.name: [] for image in images}
    point2d_index_by_track_image: dict[tuple[str, str], int] = {}
    point_items = sorted(points_by_track_id.items(), key=lambda item: item[0])
    point_id_by_track_id = {track_id: index for index, (track_id, _) in enumerate(point_items, start=1)}
    for track_id, _point_entry in point_items:
        for observation in track_lookup[track_id].get('observations', []):
            image_name = observation['image']
            if image_name not in registered_poses:
                continue
            point_id = point_id_by_track_id[track_id]
            point2d_index_by_track_image[(track_id, image_name)] = len(image_points_by_name[image_name])
            image_points_by_name[image_name].append((float(observation['xy'][0]), float(observation['xy'][1]), point_id))

    pose_manifest = []
    image_lines = ['# Image list\n', '# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n', '# POINTS2D[] as (X, Y, POINT3D_ID)\n']
    for image in images:
        image_name = image.name
        if image_name not in registered_poses:
            continue
        pose = registered_poses[image_name]
        qvec = rotation_matrix_to_qvec(pose['R'])
        tvec = np.asarray(pose['t'], dtype=np.float64).reshape(3)
        pose_manifest.append({
            'image': image_name,
            'qvec': [float(value) for value in qvec],
            'tvec': [float(value) for value in tvec],
        })
        image_lines.append(
            f"{image_id_by_name[image_name]} {qvec[0]} {qvec[1]} {qvec[2]} {qvec[3]} {tvec[0]} {tvec[1]} {tvec[2]} {camera_id_by_name[image_name]} {image_name}\n"
        )
        image_points = image_points_by_name.get(image_name, [])
        if image_points:
            image_lines.append(' '.join(f'{x_coord} {y_coord} {point_id}' for x_coord, y_coord, point_id in image_points) + '\n')
        else:
            image_lines.append('0 0 -1\n')
    images_txt_path.write_text(''.join(image_lines), encoding='utf-8')

    point_lines = ['# 3D point list\n', '# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n']
    for track_id, point_entry in point_items:
        point_id = point_id_by_track_id[track_id]
        point = np.asarray(point_entry['point'], dtype=np.float64).reshape(3)
        track_parts = []
        for observation in track_lookup[track_id].get('observations', []):
            image_name = observation['image']
            if image_name not in registered_poses:
                continue
            point2d_index = point2d_index_by_track_image.get((track_id, image_name))
            if point2d_index is None:
                continue
            track_parts.append(f'{image_id_by_name[image_name]} {point2d_index}')
        point_lines.append(
            f"{point_id} {point[0]} {point[1]} {point[2]} 255 255 255 {float(point_entry['meanError'])} {' '.join(track_parts)}\n"
        )
    points_txt_path.write_text(''.join(point_lines), encoding='utf-8')
    poses_path.write_text(json.dumps(pose_manifest, indent=2), encoding='utf-8')

    return {
        'textModelDir': str(text_model_dir),
        'camerasPath': str(cameras_txt_path),
        'imagesPath': str(images_txt_path),
        'pointsPath': str(points_txt_path),
        'posesPath': str(poses_path),
    }


def run_experimental_multiview_backend(
    *,
    output_dir: Path,
    images: list[Path],
    learned_feature_store_path: Path,
    track_store_path: Path | None,
    base_intrinsics: dict | None,
) -> dict:
    import cv2
    import numpy as np
    from collections import Counter, defaultdict

    experimental_dir = ensure_dir(output_dir / 'experimental_multiview')
    summary_path = experimental_dir / 'summary.json'
    bundle_path = experimental_dir / 'bundle.npz'
    camera_graph_path = experimental_dir / 'camera_graph.json'
    pose_graph_path = experimental_dir / 'pose_graph.json'

    feature_store = json.loads(learned_feature_store_path.read_text()) if learned_feature_store_path.exists() else {'images': []}
    track_store = load_track_store(track_store_path) or {'tracks': []}

    image_names = [image.name for image in images]
    image_index_by_name = {image_name: index for index, image_name in enumerate(image_names)}
    feature_counts = {
        image_entry.get('image'): len(image_entry.get('keypoints', []))
        for image_entry in feature_store.get('images', [])
        if image_entry.get('image') in image_index_by_name
    }

    filtered_tracks = []
    observation_track_indices = []
    observation_image_indices = []
    observation_keypoint_indices = []
    observation_xy = []
    observation_scores = []
    track_offsets = []
    track_lengths = []
    track_ids = []
    track_supports = []
    track_mean_scores = []
    edge_counter = Counter()
    edge_track_support = Counter()
    image_size_by_name: dict[str, tuple[int, int]] = {}
    camera_params_by_name: dict[str, object] = {}

    for image_path in images:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f'Unable to read image for experimental multiview backend: {image_path}')
        height, width = image.shape[:2]
        image_size_by_name[image_path.name] = (width, height)
        camera_params_by_name[image_path.name] = build_camera_params(width, height, base_intrinsics)

    for track in track_store.get('tracks', []):
        observations = []
        for observation in track.get('observations', []):
            image_name = observation.get('image')
            if image_name not in image_index_by_name:
                continue
            observations.append({
                'image': image_name,
                'imageIndex': image_index_by_name[image_name],
                'keypointIndex': int(observation.get('keypointIndex', -1)),
                'xy': [float(value) for value in observation.get('xy', [0.0, 0.0])[:2]],
                'score': float(observation.get('score', 0.0)),
            })

        if len(observations) < EXPERIMENTAL_MULTIVIEW_TRACK_MIN_SUPPORT:
            continue

        track_index = len(filtered_tracks)
        track_ids.append(str(track.get('trackId', f'track_{track_index:06d}')))
        track_supports.append(int(track.get('support', len(observations))))
        track_mean_scores.append(float(track.get('meanScore', 0.0)))
        track_offsets.append(len(observation_track_indices))
        track_lengths.append(len(observations))
        filtered_tracks.append({
            'trackId': str(track.get('trackId', f'track_{track_index:06d}')),
            'support': int(track.get('support', len(observations))),
            'meanScore': float(track.get('meanScore', 0.0)),
            'observations': observations,
        })

        for observation in observations:
            observation_track_indices.append(track_index)
            observation_image_indices.append(observation['imageIndex'])
            observation_keypoint_indices.append(observation['keypointIndex'])
            observation_xy.append(observation['xy'])
            observation_scores.append(observation['score'])

        for left_observation, right_observation in itertools.combinations(observations, 2):
            edge_key = tuple(sorted((left_observation['image'], right_observation['image'])))
            edge_counter[edge_key] += 1
            edge_track_support[edge_key] += int(filtered_tracks[-1]['support'])

    camera_edges = []
    weighted_degree = Counter()
    for (image0, image1), shared_track_count in edge_counter.items():
        edge = {
            'image0': image0,
            'image1': image1,
            'sharedTrackCount': int(shared_track_count),
            'sharedTrackSupport': int(edge_track_support[(image0, image1)]),
        }
        camera_edges.append(edge)
        weighted_degree[image0] += int(shared_track_count)
        weighted_degree[image1] += int(shared_track_count)

    camera_edges.sort(key=lambda item: (-item['sharedTrackCount'], item['image0'], item['image1']))
    reference_image = max(image_names, key=lambda image_name: (weighted_degree[image_name], feature_counts.get(image_name, 0))) if image_names else None

    class UnionFind:
        def __init__(self, items):
            self.parent = {item: item for item in items}

        def find(self, item):
            parent = self.parent[item]
            if parent != item:
                self.parent[item] = self.find(parent)
            return self.parent[item]

        def union(self, left, right):
            left_root = self.find(left)
            right_root = self.find(right)
            if left_root != right_root:
                self.parent[right_root] = left_root

    component_union = UnionFind(image_names)
    for edge in camera_edges:
        if edge['sharedTrackCount'] >= EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS:
            component_union.union(edge['image0'], edge['image1'])

    components = defaultdict(list)
    for image_name in image_names:
        components[component_union.find(image_name)].append(image_name)
    component_list = sorted((sorted(component) for component in components.values()), key=lambda component: (-len(component), component))

    spanning_union = UnionFind(image_names)
    pose_graph_edges = []
    for edge in camera_edges:
        if edge['sharedTrackCount'] < EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS:
            continue
        if spanning_union.find(edge['image0']) == spanning_union.find(edge['image1']):
            continue
        spanning_union.union(edge['image0'], edge['image1'])
        pose_graph_edges.append(edge)

    np.savez_compressed(
        bundle_path,
        image_names=np.asarray(image_names, dtype=object),
        feature_counts=np.asarray([int(feature_counts.get(image_name, 0)) for image_name in image_names], dtype=np.int32),
        track_ids=np.asarray(track_ids, dtype=object),
        track_supports=np.asarray(track_supports, dtype=np.int32),
        track_mean_scores=np.asarray(track_mean_scores, dtype=np.float32),
        track_offsets=np.asarray(track_offsets, dtype=np.int32),
        track_lengths=np.asarray(track_lengths, dtype=np.int32),
        observation_track_indices=np.asarray(observation_track_indices, dtype=np.int32),
        observation_image_indices=np.asarray(observation_image_indices, dtype=np.int32),
        observation_keypoint_indices=np.asarray(observation_keypoint_indices, dtype=np.int32),
        observation_xy=np.asarray(observation_xy, dtype=np.float32),
        observation_scores=np.asarray(observation_scores, dtype=np.float32),
    )

    camera_graph = {
        'images': [
            {
                'image': image_name,
                'imageIndex': image_index_by_name[image_name],
                'featureCount': int(feature_counts.get(image_name, 0)),
                'weightedDegree': int(weighted_degree.get(image_name, 0)),
            }
            for image_name in image_names
        ],
        'edges': camera_edges,
        'components': component_list,
    }
    camera_graph_path.write_text(json.dumps(camera_graph, indent=2), encoding='utf-8')

    pose_graph = {
        'referenceImage': reference_image,
        'edgeMinSharedTracks': int(EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS),
        'edges': pose_graph_edges,
    }
    pose_graph_path.write_text(json.dumps(pose_graph, indent=2), encoding='utf-8')

    reconstruction = run_experimental_multiview_solver(
        images=images,
        filtered_tracks=filtered_tracks,
        camera_edges=camera_edges,
        camera_params_by_name=camera_params_by_name,
        reference_image=reference_image,
    )
    model_paths = write_experimental_multiview_model(
        experimental_dir=experimental_dir,
        images=images,
        image_size_by_name=image_size_by_name,
        camera_params_by_name=camera_params_by_name,
        reconstruction=reconstruction,
    )

    summary = {
        'jobId': output_dir.name,
        'createdAt': now_iso(),
        'backendId': 'experimental_multiview_track_solver',
        'status': 'ready',
        'imageCount': len(image_names),
        'rawTrackCount': len(track_store.get('tracks', [])),
        'filteredTrackCount': len(filtered_tracks),
        'observationCount': len(observation_track_indices),
        'cameraEdgeCount': len(camera_edges),
        'componentCount': len(component_list),
        'referenceImage': reference_image,
        'trackMinSupport': int(EXPERIMENTAL_MULTIVIEW_TRACK_MIN_SUPPORT),
        'edgeMinSharedTracks': int(EXPERIMENTAL_MULTIVIEW_EDGE_MIN_SHARED_TRACKS),
        'bundlePath': str(bundle_path),
        'cameraGraphPath': str(camera_graph_path),
        'poseGraphPath': str(pose_graph_path),
        'preservesTracksNatively': True,
        'registeredImageCount': len(reconstruction['registeredImages']),
        'registeredImages': reconstruction['registeredImages'],
        'unregisteredImages': reconstruction['unregisteredImages'],
        'sparsePointCount': len(reconstruction['pointsByTrackId']),
        'seedImage0': reconstruction['seedImage0'],
        'seedImage1': reconstruction['seedImage1'],
        'seedInlierCount': int(reconstruction['seedInlierCount']),
        'meanPointReprojectionError': reconstruction['meanPointReprojectionError'],
        'textModelDir': model_paths['textModelDir'],
        'camerasPath': model_paths['camerasPath'],
        'imagesPath': model_paths['imagesPath'],
        'pointsPath': model_paths['pointsPath'],
        'posesPath': model_paths['posesPath'],
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_fast3r_pointmap_tail_rescue(
    *,
    output_dir: Path,
    images: list[Path],
    text_model_dir: Path,
    learned_feature_store_path: Path,
    learned_matches_store_path: Path,
    base_intrinsics: dict | None,
    depth_priors_dir: Path | None = None,
) -> dict:
    import cv2
    import numpy as np

    rescue_dir = ensure_dir(output_dir / 'fast3r_pointmap_tail_rescue')
    depth_priors_dense_cache: dict[str, tuple] = {}
    summary_path = rescue_dir / 'summary.json'
    poses_path = rescue_dir / 'poses.json'

    if not FAST3R_POINTMAP_TAIL_RESCUE_ENABLED:
        summary = {
            'jobId': output_dir.name,
            'createdAt': now_iso(),
            'status': 'disabled',
            'rescuedImageCount': 0,
        }
        summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
        return summary

    if not learned_feature_store_path.exists() or not learned_matches_store_path.exists():
        summary = {
            'jobId': output_dir.name,
            'createdAt': now_iso(),
            'status': 'missing_learned_inputs',
            'rescuedImageCount': 0,
        }
        summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
        return summary

    cameras_by_id = parse_colmap_cameras_text(text_model_dir / 'cameras.txt')
    model_images_by_name = parse_colmap_images_text(text_model_dir / 'images.txt')
    points_by_id = parse_colmap_points3d_text(text_model_dir / 'points3D.txt')
    feature_store = json.loads(learned_feature_store_path.read_text())
    matches_store = json.loads(learned_matches_store_path.read_text())
    feature_store_by_name = {
        image_entry.get('image'): image_entry
        for image_entry in feature_store.get('images', [])
        if image_entry.get('image')
    }

    image_names = [image.name for image in images]
    unregistered_images = [image_name for image_name in image_names if image_name not in model_images_by_name]
    if not unregistered_images:
        summary = {
            'jobId': output_dir.name,
            'createdAt': now_iso(),
            'status': 'skipped_no_unregistered_images',
            'registeredImageCountBefore': len(model_images_by_name),
            'registeredImageCountAfter': len(model_images_by_name),
            'rescuedImageCount': 0,
            'rescuedImages': [],
            'unresolvedImages': [],
        }
        summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
        return summary

    image_size_by_name: dict[str, tuple[int, int]] = {}
    camera_params_by_name: dict[str, object] = {}
    for image_path in images:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f'Unable to read image for Fast3R pointmap tail rescue: {image_path}')
        height, width = image.shape[:2]
        image_size_by_name[image_path.name] = (width, height)
        camera_params_by_name[image_path.name] = build_camera_params(width, height, base_intrinsics)

    point3d_id_by_feature_index: dict[str, list[int]] = {}
    for image_name, image_entry in model_images_by_name.items():
        feature_keypoints = feature_store_by_name.get(image_name, {}).get('keypoints', [])
        point3d_id_by_feature_index[image_name] = build_point3d_id_by_feature_index(image_entry, feature_keypoints)

    pairs_dir = learned_matches_store_path.parent / 'pairs'
    rescued_images = []
    rescue_pose_entries = []
    rescue_candidates = []

    augmented_cameras = {
        camera_id: {
            'cameraId': camera['cameraId'],
            'model': camera['model'],
            'width': camera['width'],
            'height': camera['height'],
            'params': list(camera['params']),
        }
        for camera_id, camera in cameras_by_id.items()
    }
    augmented_images = {
        image_name: {
            'imageId': image_entry['imageId'],
            'qvec': list(image_entry['qvec']),
            'tvec': list(image_entry['tvec']),
            'cameraId': image_entry['cameraId'],
            'image': image_entry['image'],
            'points2D': [
                {
                    'xy': list(point_entry['xy']),
                    'point3DId': int(point_entry['point3DId']),
                }
                for point_entry in image_entry.get('points2D', [])
            ],
        }
        for image_name, image_entry in model_images_by_name.items()
    }
    augmented_points = {
        point_id: {
            'pointId': point_id,
            'xyz': np.asarray(point_entry['xyz'], dtype=np.float64),
            'rgb': list(point_entry['rgb']),
            'error': float(point_entry['error']),
            'track': list(point_entry.get('track', [])),
        }
        for point_id, point_entry in points_by_id.items()
    }

    next_image_id = max((image_entry['imageId'] for image_entry in augmented_images.values()), default=0) + 1
    next_camera_id = max(augmented_cameras, default=0) + 1
    camera_id_by_size = {
        (camera['width'], camera['height']): camera_id
        for camera_id, camera in augmented_cameras.items()
    }

    for unregistered_image in unregistered_images:
        best_candidate = None
        for pair_entry in matches_store.get('pairs', []):
            image0 = pair_entry.get('image0')
            image1 = pair_entry.get('image1')
            if unregistered_image not in {image0, image1}:
                continue

            registered_image = image1 if image0 == unregistered_image else image0
            if registered_image not in model_images_by_name:
                continue

            pair_id = pair_entry.get('pairId')
            if not pair_id:
                continue
            pair_path = pairs_dir / f'{pair_id}.npz'
            if not pair_path.exists():
                continue

            with np.load(pair_path, allow_pickle=False) as pair_data:
                if 'global_matches' not in pair_data.files:
                    continue
                global_matches = np.asarray(pair_data['global_matches'], dtype=np.int64)
                keypoints0 = np.asarray(pair_data['keypoints0'], dtype=np.float32)
                keypoints1 = np.asarray(pair_data['keypoints1'], dtype=np.float32)
                confidence = np.asarray(pair_data['confidence'], dtype=np.float32).reshape(-1)
                has_pointmaps = all(
                    key in pair_data.files
                    for key in ('pointmap0', 'pointmap1', 'confidence_map0', 'confidence_map1')
                )
                if has_pointmaps:
                    pointmap0 = np.asarray(pair_data['pointmap0'], dtype=np.float32)
                    pointmap1 = np.asarray(pair_data['pointmap1'], dtype=np.float32)
                    confidence_map0 = np.asarray(pair_data['confidence_map0'], dtype=np.float32)
                    confidence_map1 = np.asarray(pair_data['confidence_map1'], dtype=np.float32)
                else:
                    pointmap0 = pointmap1 = confidence_map0 = confidence_map1 = None

            if not has_pointmaps:
                # EfficientLoFTR pairs carry no dense pointmaps; back-project depth priors
                # depth priors into camera-frame pointmaps instead (license-clean).
                pointmap0, confidence_map0 = load_depth_prior_dense_maps(
                    depth_priors_dir, image0, camera_params_by_name[image0], depth_priors_dense_cache, image_size_by_name[image0],
                )
                pointmap1, confidence_map1 = load_depth_prior_dense_maps(
                    depth_priors_dir, image1, camera_params_by_name[image1], depth_priors_dense_cache, image_size_by_name[image1],
                )
                if pointmap0 is None or pointmap1 is None:
                    continue

            if global_matches.size == 0:
                continue
            if global_matches.ndim == 1:
                global_matches = global_matches.reshape(-1, 2)

            registered_column = 0 if image0 == registered_image else 1
            unregistered_column = 1 - registered_column
            registered_keypoints = keypoints0 if registered_column == 0 else keypoints1
            unregistered_keypoints = keypoints1 if registered_column == 0 else keypoints0
            registered_pointmap = pointmap0 if registered_column == 0 else pointmap1
            unregistered_pointmap = pointmap1 if registered_column == 0 else pointmap0
            registered_confidence_map = confidence_map0 if registered_column == 0 else confidence_map1
            unregistered_confidence_map = confidence_map1 if registered_column == 0 else confidence_map0

            registered_point_ids = point3d_id_by_feature_index.get(registered_image, [])
            if not registered_point_ids:
                continue

            sampled_registered_points = sample_dense_map_values(
                registered_pointmap,
                registered_keypoints,
                image_size_by_name[registered_image],
            )
            sampled_unregistered_points = sample_dense_map_values(
                unregistered_pointmap,
                unregistered_keypoints,
                image_size_by_name[unregistered_image],
            )
            sampled_registered_confidence = sample_dense_map_values(
                registered_confidence_map,
                registered_keypoints,
                image_size_by_name[registered_image],
            ).reshape(-1)
            sampled_unregistered_confidence = sample_dense_map_values(
                unregistered_confidence_map,
                unregistered_keypoints,
                image_size_by_name[unregistered_image],
            ).reshape(-1)

            anchor_source_points = []
            anchor_target_points = []
            anchor_weights = []
            rescue_candidates_by_feature: dict[int, dict] = {}
            for match_index, match_pair in enumerate(global_matches):
                registered_feature_index = int(match_pair[registered_column])
                unregistered_feature_index = int(match_pair[unregistered_column])
                if registered_feature_index < 0 or registered_feature_index >= len(registered_point_ids):
                    continue
                point_id = int(registered_point_ids[registered_feature_index])
                if point_id <= 0 or point_id not in points_by_id:
                    continue

                registered_point = np.asarray(sampled_registered_points[match_index], dtype=np.float64).reshape(-1)
                unregistered_point = np.asarray(sampled_unregistered_points[match_index], dtype=np.float64).reshape(-1)
                if registered_point.size != 3 or unregistered_point.size != 3:
                    continue
                if not np.all(np.isfinite(registered_point)) or not np.all(np.isfinite(unregistered_point)):
                    continue

                confidence_score = float(confidence[match_index]) if match_index < confidence.shape[0] else 0.0
                confidence_score *= max(0.0, float(min(
                    sampled_registered_confidence[match_index] if match_index < sampled_registered_confidence.shape[0] else 0.0,
                    sampled_unregistered_confidence[match_index] if match_index < sampled_unregistered_confidence.shape[0] else 0.0,
                )))
                if confidence_score <= 0.0:
                    confidence_score = float(confidence[match_index]) if match_index < confidence.shape[0] else 0.0

                anchor_source_points.append(registered_point)
                anchor_target_points.append(np.asarray(points_by_id[point_id]['xyz'], dtype=np.float64).reshape(3))
                anchor_weights.append(max(confidence_score, 1e-6))

                existing_candidate = rescue_candidates_by_feature.get(unregistered_feature_index)
                if existing_candidate is None or confidence_score > existing_candidate['score']:
                    rescue_candidates_by_feature[unregistered_feature_index] = {
                        'point3DId': point_id,
                        'keypoint': np.asarray(unregistered_keypoints[match_index], dtype=np.float64),
                        'pointmap': unregistered_point,
                        'score': confidence_score,
                    }

            if len(anchor_source_points) < FAST3R_POINTMAP_TAIL_RESCUE_MIN_ANCHORS:
                continue

            anchor_order = np.argsort(-np.asarray(anchor_weights, dtype=np.float64))
            anchor_order = anchor_order[: min(anchor_order.shape[0], 1024)]
            similarity = estimate_similarity_transform(
                np.asarray(anchor_source_points, dtype=np.float64)[anchor_order],
                np.asarray(anchor_target_points, dtype=np.float64)[anchor_order],
                weights=np.asarray(anchor_weights, dtype=np.float64)[anchor_order],
            )
            if similarity is None:
                continue

            candidate_entries = sorted(rescue_candidates_by_feature.values(), key=lambda item: (-item['score'], item['point3DId']))
            candidate_entries = candidate_entries[: min(len(candidate_entries), 4096)]
            if len(candidate_entries) < resolve_experimental_pnp_min_inliers(len(candidate_entries)):
                continue

            object_points = apply_similarity_transform(
                np.asarray([entry['pointmap'] for entry in candidate_entries], dtype=np.float64),
                similarity,
            )
            image_points = np.asarray([entry['keypoint'] for entry in candidate_entries], dtype=np.float64)
            point_ids = [int(entry['point3DId']) for entry in candidate_entries]
            candidate_scores = [float(entry['score']) for entry in candidate_entries]

            finite_mask = np.isfinite(object_points).all(axis=1) & np.isfinite(image_points).all(axis=1)
            object_points = object_points[finite_mask]
            image_points = image_points[finite_mask]
            point_ids = [point_id for point_id, is_valid in zip(point_ids, finite_mask.tolist()) if is_valid]
            candidate_scores = [score for score, is_valid in zip(candidate_scores, finite_mask.tolist()) if is_valid]
            required_inliers = resolve_experimental_pnp_min_inliers(int(object_points.shape[0]))
            if object_points.shape[0] < required_inliers:
                continue

            camera_matrix = build_camera_matrix(camera_params_by_name[unregistered_image])
            success, rvec, tvec, inliers = cv2.solvePnPRansac(
                object_points,
                image_points,
                camera_matrix,
                None,
                iterationsCount=250,
                reprojectionError=float(FAST3R_POINTMAP_TAIL_RESCUE_MAX_PNP_REPROJECTION_ERROR),
                confidence=0.999,
                flags=cv2.SOLVEPNP_EPNP,
            )
            if not success or inliers is None or int(len(inliers)) < required_inliers:
                continue

            inlier_indices = np.asarray(inliers, dtype=np.int32).reshape(-1)
            cv2.solvePnP(
                object_points[inlier_indices],
                image_points[inlier_indices],
                camera_matrix,
                None,
                rvec,
                tvec,
                useExtrinsicGuess=True,
                flags=cv2.SOLVEPNP_ITERATIVE,
            )
            rotation, _ = cv2.Rodrigues(rvec)
            projected_points, _ = cv2.projectPoints(object_points[inlier_indices], rvec, tvec, camera_matrix, None)
            reprojection_errors = np.linalg.norm(projected_points.reshape(-1, 2) - image_points[inlier_indices], axis=1)

            candidate = {
                'image': unregistered_image,
                'registeredImage': registered_image,
                'pairId': pair_id,
                'rotation': np.asarray(rotation, dtype=np.float64),
                'translation': np.asarray(tvec, dtype=np.float64).reshape(3),
                'inlierCount': int(len(inlier_indices)),
                'requiredInliers': int(required_inliers),
                'meanReprojectionError': float(reprojection_errors.mean()) if reprojection_errors.size else float('inf'),
                'anchorCount': int(len(anchor_source_points)),
                'candidatePointCount': int(object_points.shape[0]),
                'inlierObservations': [
                    {
                        'xy': [float(value) for value in image_points[index]],
                        'point3DId': int(point_ids[index]),
                        'score': float(candidate_scores[index]),
                    }
                    for index in inlier_indices.tolist()
                ],
            }
            if best_candidate is None or (
                candidate['inlierCount'],
                -candidate['meanReprojectionError'],
                candidate['anchorCount'],
            ) > (
                best_candidate['inlierCount'],
                -best_candidate['meanReprojectionError'],
                best_candidate['anchorCount'],
            ):
                best_candidate = candidate

        if best_candidate is None:
            continue

        image_width, image_height = image_size_by_name[unregistered_image]
        camera_key = (image_width, image_height)
        camera_id = camera_id_by_size.get(camera_key)
        if camera_id is None:
            camera_id = next_camera_id
            next_camera_id += 1
            camera_id_by_size[camera_key] = camera_id
            augmented_cameras[camera_id] = {
                'cameraId': camera_id,
                'model': 'PINHOLE',
                'width': image_width,
                'height': image_height,
                'params': [float(value) for value in camera_params_by_name[unregistered_image]],
            }

        image_id = next_image_id
        next_image_id += 1
        point_entries = []
        for point_index, observation in enumerate(best_candidate['inlierObservations']):
            point_id = int(observation['point3DId'])
            point_entries.append({
                'xy': list(observation['xy']),
                'point3DId': point_id,
            })
            point_entry = augmented_points.get(point_id)
            if point_entry is not None and (image_id, point_index) not in point_entry['track']:
                point_entry['track'].append((image_id, point_index))

        augmented_images[unregistered_image] = {
            'imageId': image_id,
            'qvec': [float(value) for value in rotation_matrix_to_qvec(best_candidate['rotation'])],
            'tvec': [float(value) for value in best_candidate['translation']],
            'cameraId': camera_id,
            'image': unregistered_image,
            'points2D': point_entries,
        }
        rescued_images.append(unregistered_image)
        rescue_candidates.append({
            'image': unregistered_image,
            'registeredImage': best_candidate['registeredImage'],
            'pairId': best_candidate['pairId'],
            'inlierCount': int(best_candidate['inlierCount']),
            'candidatePointCount': int(best_candidate['candidatePointCount']),
            'anchorCount': int(best_candidate['anchorCount']),
            'meanReprojectionError': float(best_candidate['meanReprojectionError']),
        })
        rescue_pose_entries.append({
            'image': unregistered_image,
            'qvec': augmented_images[unregistered_image]['qvec'],
            'tvec': augmented_images[unregistered_image]['tvec'],
            'registeredImage': best_candidate['registeredImage'],
            'pairId': best_candidate['pairId'],
            'inlierCount': int(best_candidate['inlierCount']),
        })

    model_paths = None
    if rescued_images:
        model_paths = write_colmap_text_model(augmented_cameras, augmented_images, augmented_points, rescue_dir / 'text-model')
        poses_path.write_text(json.dumps(rescue_pose_entries, indent=2), encoding='utf-8')

    summary = {
        'jobId': output_dir.name,
        'createdAt': now_iso(),
        'status': 'rescued' if rescued_images else 'no_rescue_candidates',
        'registeredImageCountBefore': len(model_images_by_name),
        'registeredImageCountAfter': len(model_images_by_name) + len(rescued_images),
        'unregisteredImageCount': len(unregistered_images),
        'rescuedImageCount': len(rescued_images),
        'rescuedImages': rescued_images,
        'unresolvedImages': [image_name for image_name in unregistered_images if image_name not in rescued_images],
        'candidates': rescue_candidates,
        'summaryPath': str(summary_path),
        'posesPath': str(poses_path) if rescued_images else None,
        'textModelDir': model_paths['textModelDir'] if model_paths else None,
        'imagesPath': model_paths['imagesPath'] if model_paths else None,
        'pointsPath': model_paths['pointsPath'] if model_paths else None,
        'camerasPath': model_paths['camerasPath'] if model_paths else None,
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def build_pairwise_match_index(
    matches_store: dict,
    track_store: dict | None,
    keypoint_counts: dict[str, int],
    min_track_support: int = MIN_TRACK_SUPPORT_FOR_PAIRWISE_IMPORT,
):
    pair_matches: dict[tuple[str, str], set[tuple[int, int]]] = {}
    direct_match_count = 0
    track_match_count = 0
    track_store_count = 0
    imported_track_count = 0
    promoted_track_count = 0

    def is_multiview_promoted_track(track: dict) -> bool:
        if not FAST3R_MULTIVIEW_TRACK_PROMOTION_ENABLED:
            return False

        support = int(track.get('support', 0))
        if support >= int(min_track_support):
            return False
        if support < FAST3R_PROMOTED_TRACK_MIN_SUPPORT:
            return False
        if int(track.get('sourcePairCount', 0)) < FAST3R_PROMOTED_TRACK_MIN_SOURCE_PAIRS:
            return False
        if int(track.get('multiviewSourcePairCount', 0)) < FAST3R_PROMOTED_TRACK_MIN_MULTIVIEW_PAIRS:
            return False
        if int(track.get('maxWindowSupport', 1)) < FAST3R_PROMOTED_TRACK_MIN_WINDOW_SUPPORT:
            return False
        if int(track.get('localHeadSourcePairCount', 0)) < FAST3R_PROMOTED_TRACK_MIN_LOCAL_HEAD_PAIRS:
            return False
        if int(track.get('sourceConnectionCount', 0)) < FAST3R_PROMOTED_TRACK_MIN_CONNECTIONS:
            return False
        if float(track.get('meanScore', 0.0)) < FAST3R_PROMOTED_TRACK_MIN_MEAN_SCORE:
            return False
        if float(track.get('meanPairConfidence', 0.0)) < FAST3R_PROMOTED_TRACK_MIN_MEAN_PAIR_CONFIDENCE:
            return False
        return True

    def add_match(image0: str, image1: str, keypoint_index0: int, keypoint_index1: int) -> bool:
        if image0 == image1:
            return False
        if keypoint_index0 < 0 or keypoint_index1 < 0:
            return False
        if keypoint_index0 >= keypoint_counts.get(image0, 0):
            return False
        if keypoint_index1 >= keypoint_counts.get(image1, 0):
            return False

        image_pair = tuple(sorted((image0, image1)))
        if image0 == image_pair[0]:
            match = (int(keypoint_index0), int(keypoint_index1))
        else:
            match = (int(keypoint_index1), int(keypoint_index0))
        pair_set = pair_matches.setdefault(image_pair, set())
        previous_size = len(pair_set)
        pair_set.add(match)
        return len(pair_set) > previous_size

    for pair_entry in matches_store.get('pairs', []):
        image0 = pair_entry.get('image0')
        image1 = pair_entry.get('image1')
        if not image0 or not image1:
            continue
        for match in pair_entry.get('globalMatches', []):
            if len(match) < 2:
                continue
            if add_match(image0, image1, int(match[0]), int(match[1])):
                direct_match_count += 1

    if track_store:
        for track in track_store.get('tracks', []):
            track_store_count += 1
            promoted_track = is_multiview_promoted_track(track)
            if int(track.get('support', 0)) < int(min_track_support) and not promoted_track:
                continue

            observations = []
            for observation in track.get('observations', []):
                image_name = observation.get('image')
                keypoint_index = int(observation.get('keypointIndex', -1))
                if image_name not in keypoint_counts:
                    continue
                if keypoint_index < 0 or keypoint_index >= keypoint_counts[image_name]:
                    continue
                observations.append((image_name, keypoint_index))
            if len(observations) < 2:
                continue
            imported_track_count += 1
            if promoted_track:
                promoted_track_count += 1
            for (image0, keypoint_index0), (image1, keypoint_index1) in itertools.combinations(observations, 2):
                if add_match(image0, image1, keypoint_index0, keypoint_index1):
                    track_match_count += 1

    return pair_matches, {
        'directMatchCount': direct_match_count,
        'trackDerivedMatchCount': track_match_count,
        'trackCount': track_store_count,
        'importedTrackCount': imported_track_count,
        'promotedTrackCount': promoted_track_count,
        'trackMinSupport': int(min_track_support),
        'multiviewTrackPromotionEnabled': bool(FAST3R_MULTIVIEW_TRACK_PROMOTION_ENABLED),
        'promotedTrackMinSupport': int(FAST3R_PROMOTED_TRACK_MIN_SUPPORT),
        'promotedTrackMinSourcePairs': int(FAST3R_PROMOTED_TRACK_MIN_SOURCE_PAIRS),
        'promotedTrackMinMultiviewPairs': int(FAST3R_PROMOTED_TRACK_MIN_MULTIVIEW_PAIRS),
        'promotedTrackMinWindowSupport': int(FAST3R_PROMOTED_TRACK_MIN_WINDOW_SUPPORT),
        'usedTrackStore': bool(track_store and imported_track_count > 0),
    }


def import_learned_matches_to_colmap(
    database_path: Path,
    images_dir: Path,
    feature_store_path: Path,
    matches_store_path: Path,
    track_store_path: Path | None,
    colmap_path: str,
    base_intrinsics: dict | None,
) -> dict:
    import cv2
    import numpy as np

    if not feature_store_path.exists():
        raise RuntimeError(f'Learned feature store not found: {feature_store_path}')
    if not matches_store_path.exists():
        raise RuntimeError(f'Learned matches store not found: {matches_store_path}')

    if database_path.exists():
        database_path.unlink()

    run_command([colmap_path, 'database_creator', '--database_path', str(database_path)])

    image_files = list_images(images_dir)
    if not image_files:
        raise RuntimeError('No images available for learned-match import')

    feature_store = json.loads(feature_store_path.read_text())
    matches_store = json.loads(matches_store_path.read_text())
    track_store = load_track_store(track_store_path)

    connection = sqlite3.connect(database_path)
    cursor = connection.cursor()
    descriptor_columns = get_table_columns(cursor, 'descriptors')

    image_size_by_name: dict[str, tuple[int, int]] = {}
    for image_path in image_files:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f'Unable to read image: {image_path}')
        height, width = image.shape[:2]
        image_size_by_name[image_path.name] = (width, height)

    camera_ids_by_size: dict[tuple[int, int], int] = {}

    name_to_id: dict[str, int] = {}
    keypoint_counts: dict[str, int] = {}
    for image_entry in feature_store.get('images', []):
        image_name = image_entry['image']
        image_size = image_size_by_name.get(image_name)
        if image_size is None:
            raise RuntimeError(f'Image size unavailable for learned-match import: {image_name}')

        width, height = image_size
        camera_key = (width, height)
        camera_id = camera_ids_by_size.get(camera_key)
        if camera_id is None:
            camera_params = build_camera_params(width, height, base_intrinsics)
            cursor.execute(
                'INSERT INTO cameras(model, width, height, params, prior_focal_length) VALUES (?, ?, ?, ?, ?)',
                (CAMERA_MODEL_PINHOLE, width, height, camera_params.tobytes(), 0),
            )
            camera_id = cursor.lastrowid
            camera_ids_by_size[camera_key] = camera_id

        cursor.execute(
            'INSERT INTO images(name, camera_id) VALUES (?, ?)',
            (image_name, camera_id),
        )
        image_id = cursor.lastrowid
        name_to_id[image_name] = image_id

        keypoints = np.asarray(image_entry.get('keypoints', []), dtype=np.float32)
        if keypoints.ndim == 1:
            keypoints = keypoints.reshape(-1, 2)
        if keypoints.size == 0:
            keypoints = np.zeros((0, 2), dtype=np.float32)
        keypoint_counts[image_name] = int(keypoints.shape[0])
        cursor.execute(
            'INSERT INTO keypoints(image_id, rows, cols, data) VALUES (?, ?, ?, ?)',
            (image_id, int(keypoints.shape[0]), 2, keypoints.tobytes()),
        )

        descriptors = np.zeros((int(keypoints.shape[0]), COLMAP_SIFT_DESCRIPTOR_DIM), dtype=np.uint8)
        if 'type' in descriptor_columns:
            cursor.execute(
                'INSERT INTO descriptors(image_id, type, rows, cols, data) VALUES (?, ?, ?, ?, ?)',
                (
                    image_id,
                    COLMAP_FEATURE_EXTRACTOR_SIFT,
                    int(descriptors.shape[0]),
                    descriptors.shape[1],
                    descriptors.tobytes(),
                ),
            )
        else:
            cursor.execute(
                'INSERT INTO descriptors(image_id, rows, cols, data) VALUES (?, ?, ?, ?)',
                (image_id, int(descriptors.shape[0]), descriptors.shape[1], descriptors.tobytes()),
            )

    pair_match_index, match_stats = build_pairwise_match_index(matches_store, track_store, keypoint_counts)

    inserted_pairs = 0
    inserted_matches = 0
    for (image0, image1), raw_matches in sorted(pair_match_index.items()):
        image_id0 = name_to_id.get(image0)
        image_id1 = name_to_id.get(image1)
        if image_id0 is None or image_id1 is None:
            continue

        match_pairs = np.asarray(sorted(raw_matches), dtype=np.uint32)
        if match_pairs.size == 0:
            continue
        if match_pairs.ndim == 1:
            match_pairs = match_pairs.reshape(-1, 2)

        valid_mask = (
            (match_pairs[:, 0] < keypoint_counts[image0])
            & (match_pairs[:, 1] < keypoint_counts[image1])
        )
        match_pairs = match_pairs[valid_mask]
        if match_pairs.size == 0:
            continue

        if image_id0 > image_id1:
            image_id0, image_id1 = image_id1, image_id0
            match_pairs = match_pairs[:, ::-1]

        pair_id = image_ids_to_pair_id(image_id0, image_id1)
        cursor.execute(
            'INSERT INTO matches(pair_id, rows, cols, data) VALUES (?, ?, ?, ?)',
            (pair_id, int(match_pairs.shape[0]), 2, match_pairs.tobytes()),
        )
        inserted_pairs += 1
        inserted_matches += int(match_pairs.shape[0])

    connection.commit()
    connection.close()

    if inserted_pairs == 0 or inserted_matches == 0:
        raise RuntimeError('Learned-match import produced no valid COLMAP match entries')

    match_stats.update({
        'insertedPairs': inserted_pairs,
        'insertedMatches': inserted_matches,
        'trackStorePath': str(track_store_path) if track_store_path and track_store_path.exists() else None,
    })
    return match_stats


def write_dry_run_outputs(job_id: str, images: list[Path], output_dir: Path, learned_match_graph_path: Path) -> dict:
    sparse_dir = ensure_dir(output_dir / 'sparse' / '0')
    text_dir = ensure_dir(output_dir / 'text-model')
    database_path = output_dir / 'database.db'
    database_path.write_text('', encoding='utf-8')

    cameras_txt = text_dir / 'cameras.txt'
    images_txt = text_dir / 'images.txt'
    points_txt = text_dir / 'points3D.txt'

    cameras_txt.write_text(
        '# Dry-run placeholder cameras\n1 OPENCV 1920 1080 1200 1200 960 540 0 0 0 0\n',
        encoding='utf-8',
    )

    image_lines = []
    for index, image in enumerate(images, start=1):
        image_lines.append(f'{index} 1 0 0 0 0 0 0 1 {image.name}\n\n')
    images_txt.write_text(''.join(image_lines), encoding='utf-8')
    points_txt.write_text('# Dry-run placeholder points\n1 0 0 0 255 255 255 0 1 1\n', encoding='utf-8')
    (sparse_dir / 'README.txt').write_text('Dry-run sparse model placeholder', encoding='utf-8')

    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': True,
        'colmapBinary': 'dry-run-placeholder',
        'mapper': 'global_mapper_placeholder',
        'matcher': 'learned_indoor_matching_placeholder',
        'imageCount': len(images),
        'registeredImageCount': len(images),
        'sparsePointCount': 1,
        'usedLearnedMatchGraph': learned_match_graph_path.exists(),
        'learnedGraphImported': learned_match_graph_path.exists(),
        'textModelDir': str(text_dir),
        'sparseModelDir': str(output_dir / 'sparse'),
        'databasePath': str(database_path),
    }
    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_global_sfm(
    job_id: str,
    images: list[Path],
    output_dir: Path,
    learned_match_graph_path: Path,
    learned_feature_store_path: Path,
    learned_matches_store_path: Path,
    depth_priors_dir: Path | None = None,
) -> dict:
    colmap_path = get_colmap_binary()
    if not colmap_path:
        raise RuntimeError('COLMAP binary not found; master_v1 requires COLMAP for geometric verification and model export')

    mapper_backend = resolve_global_mapper_backend(colmap_path)
    if not mapper_backend:
        raise RuntimeError(
            'No maintained global-SfM backend found; install standalone glomap or a COLMAP build that provides global_mapper. '
            'master_v1 will not fall back to incremental COLMAP'
        )

    if not learned_match_graph_path.exists():
        raise RuntimeError(f'Learned match graph missing: {learned_match_graph_path}')

    gpu_indices = get_gpu_indices()
    sparse_root = ensure_dir(output_dir / 'sparse')
    text_root = ensure_dir(output_dir / 'text-model')
    database_path = output_dir / 'database.db'
    image_count = len(images)
    base_intrinsics = load_base_intrinsics(output_dir.parent.parent / 'calibration' / 'intrinsics.json')
    learned_track_store_path = learned_matches_store_path.with_name('track_store.json')

    import_stats = import_learned_matches_to_colmap(
        database_path,
        images[0].parent,
        learned_feature_store_path,
        learned_matches_store_path,
        learned_track_store_path,
        colmap_path,
        base_intrinsics,
    )

    verifier_cmd = [
        colmap_path, 'geometric_verifier',
        '--database_path', str(database_path),
        '--TwoViewGeometry.compute_relative_pose', '1',
    ]
    supports_feature_matching_gpu = colmap_command_supports_option(
        colmap_path,
        'geometric_verifier',
        '--FeatureMatching.use_gpu',
    )
    if gpu_indices and supports_feature_matching_gpu:
        verifier_cmd.extend(['--FeatureMatching.use_gpu', '1', '--FeatureMatching.gpu_index', gpu_indices])
    elif supports_feature_matching_gpu:
        verifier_cmd.extend(['--FeatureMatching.use_gpu', '0'])
    run_command(verifier_cmd)

    if mapper_backend['supportsViewGraphCalibrator']:
        run_command([
            colmap_path,
            'view_graph_calibrator',
            '--database_path',
            str(database_path),
        ])

    run_command([
        *mapper_backend['command'],
        '--database_path', str(database_path),
        '--image_path', str(images[0].parent),
        '--output_path', str(sparse_root),
        '--GlobalMapper.track_min_num_views_per_track', '2',
        '--GlobalMapper.ba_min_track_length', '2',
        '--GlobalMapper.ba_refine_focal_length', '0',
        '--GlobalMapper.ba_refine_extra_params', '0',
    ])

    model_dir = find_largest_sparse_model(sparse_root)
    run_command([
        colmap_path, 'model_converter',
        '--input_path', str(model_dir),
        '--output_path', str(text_root),
        '--output_type', 'TXT',
    ])

    images_txt_path = text_root / 'images.txt'
    points_txt_path = text_root / 'points3D.txt'
    registered_image_count = count_registered_images(images_txt_path)
    sparse_point_count = count_points(points_txt_path)

    invalid_pose_images = collect_non_finite_pose_images(images_txt_path)
    if registered_image_count < 2:
        raise RuntimeError(f'Global SfM registered too few images: {registered_image_count}')
    if sparse_point_count <= 0:
        raise RuntimeError(
            'Global SfM produced zero sparse points '
            f'(registered_images={registered_image_count}, mapper={mapper_backend["id"]})'
        )
    if invalid_pose_images:
        invalid_list = ', '.join(invalid_pose_images)
        raise RuntimeError(
            'Global SfM exported non-finite poses '
            f'(registered_images={registered_image_count}, sparse_points={sparse_point_count}, invalid_images={invalid_list})'
        )

    glomap_text_model_paths = {
        'textModelDir': str(text_root),
        'camerasPath': str(text_root / 'cameras.txt'),
        'imagesPath': str(text_root / 'images.txt'),
        'pointsPath': str(text_root / 'points3D.txt'),
    }
    effective_text_model_paths = dict(glomap_text_model_paths)
    effective_registered_image_count = registered_image_count
    effective_text_model_source = 'glomap'
    fast3r_tail_rescue_promoted = False

    fast3r_tail_rescue_summary = None
    fast3r_tail_rescue_error = None
    if FAST3R_POINTMAP_TAIL_RESCUE_ENABLED:
        try:
            fast3r_tail_rescue_summary = run_fast3r_pointmap_tail_rescue(
                output_dir=output_dir,
                images=images,
                text_model_dir=text_root,
                learned_feature_store_path=learned_feature_store_path,
                learned_matches_store_path=learned_matches_store_path,
                base_intrinsics=base_intrinsics,
                depth_priors_dir=depth_priors_dir,
            )
            if (
                fast3r_tail_rescue_summary.get('status') == 'rescued'
                and fast3r_tail_rescue_summary.get('textModelDir')
            ):
                glomap_text_model_paths = copy_colmap_text_model(text_root, output_dir / 'glomap-text-model')
                effective_text_model_paths = copy_colmap_text_model(Path(fast3r_tail_rescue_summary['textModelDir']), text_root)
                effective_registered_image_count = int(
                    fast3r_tail_rescue_summary.get('registeredImageCountAfter', registered_image_count)
                )
                effective_text_model_source = 'fast3r_pointmap_tail_rescue'
                fast3r_tail_rescue_promoted = True
        except Exception as exc:
            fast3r_tail_rescue_error = str(exc)

    pose_outlier_filter = filter_pose_outliers_in_text_model(Path(effective_text_model_paths['textModelDir']))
    effective_registered_image_count = count_registered_images(Path(effective_text_model_paths['imagesPath']))
    sparse_point_count = count_points(Path(effective_text_model_paths['pointsPath']))

    experimental_summary = None
    experimental_error = None
    if EXPERIMENTAL_MULTIVIEW_BACKEND_ENABLED:
        try:
            experimental_summary = run_experimental_multiview_backend(
                output_dir=output_dir,
                images=images,
                learned_feature_store_path=learned_feature_store_path,
                track_store_path=learned_track_store_path,
                base_intrinsics=base_intrinsics,
            )
        except Exception as exc:
            experimental_error = str(exc)

    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': False,
        'colmapBinary': colmap_path,
        'mapper': mapper_backend['id'],
        'matcher': 'learned_indoor_matching',
        'imageCount': image_count,
        'registeredImageCount': effective_registered_image_count,
        'glomapRegisteredImageCount': registered_image_count,
        'sparsePointCount': sparse_point_count,
        'usedLearnedMatchGraph': True,
        'learnedGraphImported': True,
        'usedLearnedTrackStore': bool(import_stats.get('usedTrackStore')),
        'learnedTrackImported': bool(import_stats.get('trackDerivedMatchCount')),
        'trackCount': int(import_stats.get('trackCount', 0)),
        'importedTrackCount': int(import_stats.get('importedTrackCount', 0)),
        'trackMinSupport': int(import_stats.get('trackMinSupport', 0)),
        'trackDerivedMatchCount': int(import_stats.get('trackDerivedMatchCount', 0)),
        'colmapImportedPairCount': int(import_stats.get('insertedPairs', 0)),
        'colmapImportedMatchCount': int(import_stats.get('insertedMatches', 0)),
        'textModelDir': effective_text_model_paths['textModelDir'],
        'textModelSource': effective_text_model_source,
        'camerasPath': effective_text_model_paths['camerasPath'],
        'imagesPath': effective_text_model_paths['imagesPath'],
        'pointsPath': effective_text_model_paths['pointsPath'],
        'glomapTextModelDir': glomap_text_model_paths['textModelDir'],
        'glomapCamerasPath': glomap_text_model_paths['camerasPath'],
        'glomapImagesPath': glomap_text_model_paths['imagesPath'],
        'glomapPointsPath': glomap_text_model_paths['pointsPath'],
        'sparseModelDir': str(sparse_root),
        'databasePath': str(database_path),
        'fast3rPointmapTailRescueStatus': fast3r_tail_rescue_summary.get('status') if fast3r_tail_rescue_summary else ('error' if fast3r_tail_rescue_error else 'disabled'),
        'fast3rPointmapTailRescueSummaryPath': str(output_dir / 'fast3r_pointmap_tail_rescue' / 'summary.json') if fast3r_tail_rescue_summary else None,
        'fast3rPointmapTailRescuePromoted': bool(fast3r_tail_rescue_promoted),
        'fast3rPointmapTailRescueRescuedImageCount': int(fast3r_tail_rescue_summary.get('rescuedImageCount', 0)) if fast3r_tail_rescue_summary else 0,
        'fast3rPointmapTailRescueRegisteredImageCountAfter': int(fast3r_tail_rescue_summary.get('registeredImageCountAfter', 0)) if fast3r_tail_rescue_summary else registered_image_count,
        'fast3rPointmapTailRescueImages': fast3r_tail_rescue_summary.get('rescuedImages') if fast3r_tail_rescue_summary else [],
        'fast3rPointmapTailRescueTextModelDir': fast3r_tail_rescue_summary.get('textModelDir') if fast3r_tail_rescue_summary else None,
        'fast3rPointmapTailRescueImagesPath': fast3r_tail_rescue_summary.get('imagesPath') if fast3r_tail_rescue_summary else None,
        'fast3rPointmapTailRescuePointsPath': fast3r_tail_rescue_summary.get('pointsPath') if fast3r_tail_rescue_summary else None,
        'fast3rPointmapTailRescuePosesPath': fast3r_tail_rescue_summary.get('posesPath') if fast3r_tail_rescue_summary else None,
        'fast3rPointmapTailRescueError': fast3r_tail_rescue_error,
        'experimentalMultiviewEnabled': bool(EXPERIMENTAL_MULTIVIEW_BACKEND_ENABLED),
        'experimentalMultiviewStatus': 'ready' if experimental_summary else ('error' if experimental_error else 'disabled'),
        'experimentalMultiviewSummaryPath': str(output_dir / 'experimental_multiview' / 'summary.json') if experimental_summary else None,
        'experimentalMultiviewBundlePath': str(output_dir / 'experimental_multiview' / 'bundle.npz') if experimental_summary else None,
        'experimentalMultiviewCameraGraphPath': str(output_dir / 'experimental_multiview' / 'camera_graph.json') if experimental_summary else None,
        'experimentalMultiviewPoseGraphPath': str(output_dir / 'experimental_multiview' / 'pose_graph.json') if experimental_summary else None,
        'experimentalMultiviewTrackCount': int(experimental_summary.get('filteredTrackCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewObservationCount': int(experimental_summary.get('observationCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewCameraEdgeCount': int(experimental_summary.get('cameraEdgeCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewComponentCount': int(experimental_summary.get('componentCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewReferenceImage': experimental_summary.get('referenceImage') if experimental_summary else None,
        'experimentalMultiviewRegisteredImageCount': int(experimental_summary.get('registeredImageCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewSparsePointCount': int(experimental_summary.get('sparsePointCount', 0)) if experimental_summary else 0,
        'experimentalMultiviewTextModelDir': experimental_summary.get('textModelDir') if experimental_summary else None,
        'experimentalMultiviewImagesPath': experimental_summary.get('imagesPath') if experimental_summary else None,
        'experimentalMultiviewPointsPath': experimental_summary.get('pointsPath') if experimental_summary else None,
        'experimentalMultiviewPosesPath': experimental_summary.get('posesPath') if experimental_summary else None,
        'experimentalMultiviewError': experimental_error,
        'poseOutlierFilterApplied': bool(pose_outlier_filter.get('applied')),
        'poseOutlierFilterReason': pose_outlier_filter.get('reason'),
        'poseOutlierImages': pose_outlier_filter.get('outlierImages') or [],
        'poseOutlierCameraCountBefore': int(pose_outlier_filter.get('cameraCountBefore', effective_registered_image_count) or 0),
        'poseOutlierCameraCountAfter': int(pose_outlier_filter.get('cameraCountAfter', effective_registered_image_count) or 0),
        'poseOutlierSparsePointCountBefore': int(pose_outlier_filter.get('sparsePointCountBefore', sparse_point_count) or 0),
        'poseOutlierSparsePointCountAfter': int(pose_outlier_filter.get('sparsePointCountAfter', sparse_point_count) or 0),
        'poseOutlierDistanceThreshold': float(pose_outlier_filter.get('threshold', 0.0) or 0.0),
    }
    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 global SfM')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--learned-match-graph-path', required=True)
    parser.add_argument('--learned-feature-store-path', required=True)
    parser.add_argument('--learned-matches-store-path', required=True)
    parser.add_argument('--depth-priors-dir', '--metric3d-dir', dest='depth_priors_dir', default='')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    learned_match_graph_path = Path(args.learned_match_graph_path)
    learned_feature_store_path = Path(args.learned_feature_store_path)
    learned_matches_store_path = Path(args.learned_matches_store_path)
    images = list_images(images_dir)
    if len(images) < 3:
        raise RuntimeError(f'Need at least 3 images for global SfM, found {len(images)}')

    if args.dry_run:
        summary = write_dry_run_outputs(args.job_id, images, output_dir, learned_match_graph_path)
    else:
        summary = run_global_sfm(
            args.job_id,
            images,
            output_dir,
            learned_match_graph_path,
            learned_feature_store_path,
            learned_matches_store_path,
            depth_priors_dir=Path(args.depth_priors_dir) if args.depth_priors_dir else None,
        )

    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
