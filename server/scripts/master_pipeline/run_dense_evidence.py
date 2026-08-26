#!/usr/bin/env python3
"""Fuse dense evidence for master_v1.

This worker fuses global-SfM sparse points with world-aligned Fast3R pointmaps
and aligned post-SfM depth priors. COLMAP PatchMatch stereo remains an
optional enhancer when it produces valid points.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


MIN_LAYOUT_READY_POINT_COUNT = 400
MIN_DENSE_STEREO_POINTS_PER_IMAGE = 100
MIN_SPARSE_STEREO_POINT_COUNT = max(0, int(os.environ.get('MASTER_PIPELINE_MIN_SPARSE_STEREO_POINT_COUNT', '500')))
MIN_LEARNED_POINTMAP_ANCHORS = 24
LEARNED_POINTMAP_CONFIDENCE_PERCENTILE = 75.0
LEARNED_POINTMAP_MAX_REPROJECTION_ERROR_PX = 10.0
MAX_LEARNED_POINTS_PER_VIEW = 12000
LEARNED_POINTMAP_ANCHOR_MEDIAN_ERROR_RATIO = 0.05
LEARNED_POINTMAP_ANCHOR_P90_ERROR_RATIO = 0.12
LEARNED_POINTMAP_ANCHOR_MIN_MEDIAN_ERROR = 0.12
LEARNED_POINTMAP_ANCHOR_MIN_P90_ERROR = 0.35
MIN_METRIC3D_CALIBRATION_ANCHORS = 8
MAX_METRIC3D_POINTS_PER_IMAGE = 25000
MAX_METRIC3D_POINTS_PER_IMAGE_WITH_LEARNED_DENSE = 12000
MAX_METRIC3D_MESH_POINTS_PER_IMAGE = max(
    1000,
    int(os.environ.get('MASTER_PIPELINE_METRIC3D_MESH_POINTS_PER_IMAGE', '150000')),
)
METRIC3D_DEPTH_CONFIDENCE_THRESHOLD = float(os.environ.get('MASTER_PIPELINE_METRIC3D_DEPTH_CONFIDENCE_THRESHOLD', '0.35'))
METRIC3D_MAX_DEPTH_METERS = float(os.environ.get('MASTER_PIPELINE_METRIC3D_MAX_DEPTH_METERS', '8.0'))
METRIC3D_MIRROR_MASK_DILATION_PX = int(os.environ.get('MASTER_PIPELINE_METRIC3D_MIRROR_MASK_DILATION_PX', '12'))
METRIC3D_VOXEL_SIZE = float(os.environ.get('MASTER_PIPELINE_METRIC3D_VOXEL_SIZE', '0.005'))
METRIC3D_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS = float(
    os.environ.get('MASTER_PIPELINE_METRIC3D_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS', '0.2')
)
METRIC3D_MAX_CALIBRATION_P90_RESIDUAL_METERS = float(
    os.environ.get('MASTER_PIPELINE_METRIC3D_MAX_CALIBRATION_P90_RESIDUAL_METERS', '0.6')
)
DENSE_STEREO_MAX_IMAGE_SIZE = int(os.environ.get('MASTER_PIPELINE_DENSE_STEREO_MAX_IMAGE_SIZE', '-1'))
DENSE_STEREO_WINDOW_RADIUS = int(os.environ.get('MASTER_PIPELINE_DENSE_STEREO_WINDOW_RADIUS', '7'))
DENSE_STEREO_FUSION_MIN_NUM_PIXELS = max(
    1,
    int(os.environ.get('MASTER_PIPELINE_DENSE_STEREO_FUSION_MIN_NUM_PIXELS', '1')),
)
METRIC3D_HOLE_FILL_MAX_NEAREST_STEREO_DISTANCE_METERS = float(
    os.environ.get('MASTER_PIPELINE_METRIC3D_HOLE_FILL_MAX_NEAREST_STEREO_DISTANCE_METERS', '0.5')
)
METRIC3D_HOLE_FILL_MIN_NEAREST_STEREO_DISTANCE_METERS = float(
    os.environ.get('MASTER_PIPELINE_METRIC3D_HOLE_FILL_MIN_NEAREST_STEREO_DISTANCE_METERS', '0.02')
)
METRIC3D_HOLE_FILL_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS = float(
    os.environ.get('MASTER_PIPELINE_METRIC3D_HOLE_FILL_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS', '0.35')
)

SEMANTIC_MASKS = None
try:
    import run_semantic_masks as SEMANTIC_MASKS  # type: ignore[import-not-found]
except Exception:
    SEMANTIC_MASKS = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def depth_priors_are_post_sfm_aligned(depth_priors_dir: Path | None) -> bool:
    if depth_priors_dir is None:
        return False

    summary_path = depth_priors_dir / 'summary.json'
    if not summary_path.exists():
        return False

    try:
        summary = json.loads(summary_path.read_text())
    except Exception:
        return False

    return str(summary.get('method', '')) == 'depth_anything_v2_post_sfm_aligned'


def resolve_colmap_binary() -> str | None:
    return shutil.which('colmap-glomap') or shutil.which('colmap')


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


def parse_gpu_indices(raw_value: str | None) -> str | None:
    if not raw_value:
        return None

    normalized = []
    for token in str(raw_value).split(','):
        token = token.strip()
        if not token:
            continue
        index = int(token)
        if index < 0:
            raise ValueError(f'invalid_gpu_index:{token}')
        normalized.append(str(index))

    return ','.join(normalized) if normalized else None


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def get_min_dense_stereo_point_count(images_dir: Path) -> int:
    return max(MIN_LAYOUT_READY_POINT_COUNT, len(list_images(images_dir)) * MIN_DENSE_STEREO_POINTS_PER_IMAGE)


def parse_colmap_cameras_txt(path: Path) -> dict[int, dict]:
    cameras: dict[int, dict] = {}
    with path.open() as handle:
        for line in handle:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            camera_id = int(parts[0])
            cameras[camera_id] = {
                'model': parts[1],
                'width': int(parts[2]),
                'height': int(parts[3]),
                'params': [float(value) for value in parts[4:]],
            }
    return cameras


def parse_colmap_images_txt(path: Path) -> dict[str, dict]:
    images: dict[str, dict] = {}
    if not path.exists():
        return images

    with path.open() as handle:
        lines = [line for line in handle if not line.startswith('#') and line.strip()]
    for index in range(0, len(lines), 2):
        parts = lines[index].split()
        point_tokens = lines[index + 1].split() if index + 1 < len(lines) else []
        points2d = []
        for point_index in range(0, len(point_tokens), 3):
            if point_index + 2 >= len(point_tokens):
                break
            points2d.append({
                'xy': [float(point_tokens[point_index]), float(point_tokens[point_index + 1])],
                'point3DId': int(point_tokens[point_index + 2]),
            })
        images[parts[9]] = {
            'id': int(parts[0]),
            'cam_id': int(parts[8]),
            'qw': float(parts[1]),
            'qx': float(parts[2]),
            'qy': float(parts[3]),
            'qz': float(parts[4]),
            'tx': float(parts[5]),
            'ty': float(parts[6]),
            'tz': float(parts[7]),
            'points2D': points2d,
        }
    return images


def parse_colmap_points_txt(path: Path):
    import numpy as np

    points = []
    colors = []
    if not path.exists():
        return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.float32)

    with path.open() as handle:
        for line in handle:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            points.append([float(parts[1]), float(parts[2]), float(parts[3])])
            colors.append([int(parts[4]), int(parts[5]), int(parts[6])])

    if not points:
        return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.float32)

    return np.asarray(points, dtype=np.float32), (np.asarray(colors, dtype=np.float32) / 255.0)


def parse_colmap_points_lookup(path: Path) -> dict[int, dict]:
    import numpy as np

    points_by_id: dict[int, dict] = {}
    if not path.exists():
        return points_by_id

    with path.open() as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if len(parts) < 8:
                continue
            point_id = int(parts[0])
            points_by_id[point_id] = {
                'xyz': np.asarray([float(parts[1]), float(parts[2]), float(parts[3])], dtype=np.float64),
                'rgb': [int(parts[4]), int(parts[5]), int(parts[6])],
                'error': float(parts[7]),
            }

    return points_by_id


def quat_to_rot(qw, qx, qy, qz):
    import numpy as np

    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ], dtype=np.float32)


def get_intrinsics_matrix(camera: dict):
    import numpy as np

    model = camera['model']
    params = camera['params']
    if model in ('SIMPLE_PINHOLE', 'SIMPLE_RADIAL'):
        fx = fy = params[0]
        cx, cy = params[1], params[2]
    elif model in ('PINHOLE', 'OPENCV', 'RADIAL'):
        fx, fy = params[0], params[1]
        cx, cy = params[2], params[3]
    else:
        fx = fy = params[0] if params else camera['width']
        cx, cy = camera['width'] / 2, camera['height'] / 2
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float32)


def get_camera_extrinsics(image_data: dict):
    import numpy as np

    rotation = quat_to_rot(image_data['qw'], image_data['qx'], image_data['qy'], image_data['qz'])
    translation = np.array([image_data['tx'], image_data['ty'], image_data['tz']], dtype=np.float32)
    return rotation, translation


def sample_dense_map_values(dense_map, keypoints, image_size):
    import numpy as np

    dense_map = np.asarray(dense_map)
    keypoints = np.asarray(keypoints, dtype=np.float64).reshape(-1, 2)
    if dense_map.ndim < 2 or keypoints.size == 0:
        return np.zeros((0,) + tuple(dense_map.shape[2:]), dtype=np.float32) if dense_map.ndim > 2 else np.zeros((0,), dtype=np.float32)

    image_width, image_height = image_size
    dense_height, dense_width = dense_map.shape[:2]
    scale_x = (dense_width - 1) / max(float(image_width - 1), 1.0)
    scale_y = (dense_height - 1) / max(float(image_height - 1), 1.0)

    sample_x = np.clip(np.rint(keypoints[:, 0] * scale_x).astype(np.int32), 0, dense_width - 1)
    sample_y = np.clip(np.rint(keypoints[:, 1] * scale_y).astype(np.int32), 0, dense_height - 1)
    return np.asarray(dense_map[sample_y, sample_x])


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
    if int(positive_mask.sum()) < 3:
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


def compute_scene_diagonal(points) -> float:
    import numpy as np

    points = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if points.shape[0] == 0:
        return 0.0
    mins = np.min(points, axis=0)
    maxs = np.max(points, axis=0)
    return float(np.linalg.norm(maxs - mins))


def project_world_points_to_image(points_world, camera: dict, image_data: dict):
    import numpy as np

    points_world = np.asarray(points_world, dtype=np.float64).reshape(-1, 3)
    if points_world.shape[0] == 0:
        return np.zeros((0, 2), dtype=np.float64), np.zeros((0,), dtype=np.float64)

    rotation, translation = get_camera_extrinsics(image_data)
    rotation = np.asarray(rotation, dtype=np.float64)
    translation = np.asarray(translation, dtype=np.float64).reshape(1, 3)
    intrinsics = np.asarray(get_intrinsics_matrix(camera), dtype=np.float64)

    camera_points = (rotation @ points_world.T).T + translation
    camera_depth = camera_points[:, 2]
    projected = np.full((points_world.shape[0], 2), np.nan, dtype=np.float64)
    valid = np.isfinite(camera_depth) & (camera_depth > 1e-6)
    if np.any(valid):
        projected[valid, 0] = (intrinsics[0, 0] * camera_points[valid, 0] / camera_depth[valid]) + intrinsics[0, 2]
        projected[valid, 1] = (intrinsics[1, 1] * camera_points[valid, 1] / camera_depth[valid]) + intrinsics[1, 2]

    return projected, camera_depth


def load_resized_rgb_image(image_path: Path, target_height: int, target_width: int, cache: dict[tuple[str, int, int], object]):
    import cv2
    import numpy as np

    cache_key = (str(image_path), int(target_height), int(target_width))
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f'learned_dense_image_unreadable:{image_path.name}')
    image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    if image.shape[:2] != (target_height, target_width):
        image = cv2.resize(image, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    rgb = image.astype(np.float32) / 255.0
    cache[cache_key] = rgb
    return rgb


def collect_learned_world_space_points(images_dir: Path, learned_matching_dir: Path, cameras: dict[int, dict], images_meta: dict[str, dict], points_by_id: dict[int, dict], scene_diagonal: float) -> dict:
    import numpy as np

    feature_store_path = learned_matching_dir / 'feature_store.json'
    matches_store_path = learned_matching_dir / 'matches_store.json'
    pairs_dir = learned_matching_dir / 'pairs'
    if not feature_store_path.exists() or not matches_store_path.exists() or not pairs_dir.exists():
        return {
            'points': np.zeros((0, 3), dtype=np.float32),
            'colors': np.zeros((0, 3), dtype=np.float32),
            'alignedPointCount': 0,
            'alignmentReady': False,
            'attemptedPairCount': 0,
            'acceptedPairCount': 0,
            'acceptedViewCount': 0,
        }

    feature_store = read_json(feature_store_path)
    matches_store = read_json(matches_store_path)
    feature_store_by_name = {
        entry.get('image'): entry.get('keypoints', [])
        for entry in feature_store.get('images', [])
        if entry.get('image')
    }
    pair_metadata_by_id = {
        entry.get('pairId'): entry
        for entry in matches_store.get('pairs', [])
        if entry.get('pairId')
    }

    point3d_id_by_feature_index: dict[str, list[int]] = {}
    for image_name, image_data in images_meta.items():
        feature_keypoints = feature_store_by_name.get(image_name)
        if not feature_keypoints:
            continue
        point_ids = build_point3d_id_by_feature_index(image_data, feature_keypoints)
        if any(point_id > 0 for point_id in point_ids):
            point3d_id_by_feature_index[image_name] = point_ids

    if not point3d_id_by_feature_index:
        return {
            'points': np.zeros((0, 3), dtype=np.float32),
            'colors': np.zeros((0, 3), dtype=np.float32),
            'alignedPointCount': 0,
            'alignmentReady': False,
            'attemptedPairCount': 0,
            'acceptedPairCount': 0,
            'acceptedViewCount': 0,
        }

    image_cache: dict[tuple[str, int, int], object] = {}
    collected_points = []
    collected_colors = []
    raw_point_count = 0
    attempted_pairs = 0
    accepted_pairs = 0
    accepted_views = 0
    median_error_limit = max(scene_diagonal * LEARNED_POINTMAP_ANCHOR_MEDIAN_ERROR_RATIO, LEARNED_POINTMAP_ANCHOR_MIN_MEDIAN_ERROR)
    p90_error_limit = max(scene_diagonal * LEARNED_POINTMAP_ANCHOR_P90_ERROR_RATIO, LEARNED_POINTMAP_ANCHOR_MIN_P90_ERROR)

    for pair_path in sorted(pairs_dir.glob('*.npz')):
        pair_id = pair_path.stem
        pair_meta = pair_metadata_by_id.get(pair_id)
        if not pair_meta:
            continue

        image0_name = pair_meta.get('image0')
        image1_name = pair_meta.get('image1')
        if image0_name not in images_meta or image1_name not in images_meta:
            continue
        if image0_name not in point3d_id_by_feature_index and image1_name not in point3d_id_by_feature_index:
            continue

        attempted_pairs += 1
        with np.load(pair_path, allow_pickle=False) as pair_data:
            required_keys = {'global_matches', 'keypoints0', 'keypoints1', 'confidence', 'pointmap0', 'pointmap1', 'confidence_map0', 'confidence_map1'}
            if not required_keys.issubset(set(pair_data.files)):
                continue
            global_matches = np.asarray(pair_data['global_matches'], dtype=np.int64)
            keypoints0 = np.asarray(pair_data['keypoints0'], dtype=np.float32)
            keypoints1 = np.asarray(pair_data['keypoints1'], dtype=np.float32)
            confidence = np.asarray(pair_data['confidence'], dtype=np.float32).reshape(-1)
            pointmap0 = np.asarray(pair_data['pointmap0'], dtype=np.float32)
            pointmap1 = np.asarray(pair_data['pointmap1'], dtype=np.float32)
            confidence_map0 = np.asarray(pair_data['confidence_map0'], dtype=np.float32)
            confidence_map1 = np.asarray(pair_data['confidence_map1'], dtype=np.float32)

        if global_matches.size == 0:
            continue
        if global_matches.ndim == 1:
            global_matches = global_matches.reshape(-1, 2)

        image0_data = images_meta[image0_name]
        image1_data = images_meta[image1_name]
        camera0 = cameras.get(image0_data['cam_id'])
        camera1 = cameras.get(image1_data['cam_id'])
        if camera0 is None or camera1 is None:
            continue

        image0_size = (int(camera0['width']), int(camera0['height']))
        image1_size = (int(camera1['width']), int(camera1['height']))
        sampled_points0 = sample_dense_map_values(pointmap0, keypoints0, image0_size)
        sampled_points1 = sample_dense_map_values(pointmap1, keypoints1, image1_size)
        sampled_confidence0 = sample_dense_map_values(confidence_map0, keypoints0, image0_size).reshape(-1)
        sampled_confidence1 = sample_dense_map_values(confidence_map1, keypoints1, image1_size).reshape(-1)

        point_views = [
            {
                'image_name': image0_name,
                'image_data': image0_data,
                'camera': camera0,
                'point_ids': point3d_id_by_feature_index.get(image0_name),
                'sampled_points': sampled_points0,
                'sampled_confidence': sampled_confidence0,
                'pointmap': pointmap0,
                'confidence_map': confidence_map0,
            },
            {
                'image_name': image1_name,
                'image_data': image1_data,
                'camera': camera1,
                'point_ids': point3d_id_by_feature_index.get(image1_name),
                'sampled_points': sampled_points1,
                'sampled_confidence': sampled_confidence1,
                'pointmap': pointmap1,
                'confidence_map': confidence_map1,
            },
        ]

        anchor_source_points = []
        anchor_target_points = []
        anchor_weights = []
        for match_index, match_pair in enumerate(global_matches):
            base_score = float(confidence[match_index]) if match_index < confidence.shape[0] else 0.0
            for column, view in enumerate(point_views):
                point_ids = view['point_ids']
                if not point_ids:
                    continue
                feature_index = int(match_pair[column])
                if feature_index < 0 or feature_index >= len(point_ids):
                    continue
                if match_index >= view['sampled_points'].shape[0]:
                    continue
                point_id = int(point_ids[feature_index])
                if point_id <= 0 or point_id not in points_by_id:
                    continue

                dense_point = np.asarray(view['sampled_points'][match_index], dtype=np.float64).reshape(-1)
                if dense_point.size != 3 or not np.all(np.isfinite(dense_point)):
                    continue

                dense_confidence = float(view['sampled_confidence'][match_index]) if match_index < view['sampled_confidence'].shape[0] else 0.0
                weight = max(base_score, 1e-3)
                if np.isfinite(dense_confidence) and dense_confidence > 0.0:
                    weight *= dense_confidence

                anchor_source_points.append(dense_point)
                anchor_target_points.append(np.asarray(points_by_id[point_id]['xyz'], dtype=np.float64).reshape(3))
                anchor_weights.append(max(weight, 1e-6))

        if len(anchor_source_points) < MIN_LEARNED_POINTMAP_ANCHORS:
            continue

        anchor_source_array = np.asarray(anchor_source_points, dtype=np.float64)
        anchor_target_array = np.asarray(anchor_target_points, dtype=np.float64)
        anchor_weight_array = np.asarray(anchor_weights, dtype=np.float64)
        anchor_order = np.argsort(-anchor_weight_array)[: min(anchor_weight_array.shape[0], 2048)]
        similarity = estimate_similarity_transform(
            anchor_source_array[anchor_order],
            anchor_target_array[anchor_order],
            weights=anchor_weight_array[anchor_order],
        )
        if similarity is None:
            continue

        aligned_anchor_points = apply_similarity_transform(anchor_source_array, similarity)
        anchor_errors = np.linalg.norm(aligned_anchor_points - anchor_target_array, axis=1)
        finite_anchor_errors = anchor_errors[np.isfinite(anchor_errors)]
        if finite_anchor_errors.size < MIN_LEARNED_POINTMAP_ANCHORS:
            continue

        median_anchor_error = float(np.median(finite_anchor_errors))
        p90_anchor_error = float(np.percentile(finite_anchor_errors, 90))
        if median_anchor_error > median_error_limit or p90_anchor_error > p90_error_limit:
            continue

        pair_added = 0
        for view in point_views:
            pointmap = np.asarray(view['pointmap'], dtype=np.float32)
            confidence_map = np.asarray(view['confidence_map'], dtype=np.float32)
            valid_mask = np.isfinite(pointmap).all(axis=-1) & np.isfinite(confidence_map)
            if not np.any(valid_mask):
                continue

            valid_confidence = confidence_map[valid_mask]
            confidence_threshold = max(float(np.percentile(valid_confidence, LEARNED_POINTMAP_CONFIDENCE_PERCENTILE)), 0.0)
            selected_mask = valid_mask & (confidence_map >= confidence_threshold)
            ys, xs = np.nonzero(selected_mask)
            if ys.size == 0:
                continue

            if ys.size > MAX_LEARNED_POINTS_PER_VIEW:
                selected_confidence = confidence_map[ys, xs]
                selected_indices = np.argpartition(selected_confidence, -MAX_LEARNED_POINTS_PER_VIEW)[-MAX_LEARNED_POINTS_PER_VIEW:]
                ys = ys[selected_indices]
                xs = xs[selected_indices]

            local_points = np.asarray(pointmap[ys, xs], dtype=np.float64).reshape(-1, 3)
            world_points = apply_similarity_transform(local_points, similarity)
            projected_points, camera_depth = project_world_points_to_image(world_points, view['camera'], view['image_data'])

            dense_height, dense_width = pointmap.shape[:2]
            source_pixels = np.stack([
                xs.astype(np.float64) * max(float(view['camera']['width'] - 1), 1.0) / max(float(dense_width - 1), 1.0),
                ys.astype(np.float64) * max(float(view['camera']['height'] - 1), 1.0) / max(float(dense_height - 1), 1.0),
            ], axis=-1)
            reprojection_error = np.linalg.norm(projected_points - source_pixels, axis=1)
            valid_projection = (
                np.isfinite(world_points).all(axis=1)
                & np.isfinite(projected_points).all(axis=1)
                & np.isfinite(camera_depth)
                & (camera_depth > 0.05)
                & np.isfinite(reprojection_error)
                & (reprojection_error <= LEARNED_POINTMAP_MAX_REPROJECTION_ERROR_PX)
            )
            if not np.any(valid_projection):
                continue

            image_rgb = load_resized_rgb_image(images_dir / view['image_name'], dense_height, dense_width, image_cache)
            colors = np.asarray(image_rgb[ys, xs], dtype=np.float32)
            world_points = np.asarray(world_points[valid_projection], dtype=np.float32)
            colors = np.asarray(colors[valid_projection], dtype=np.float32)
            if world_points.shape[0] == 0:
                continue

            collected_points.append(world_points)
            collected_colors.append(colors)
            raw_point_count += int(world_points.shape[0])
            pair_added += int(world_points.shape[0])
            accepted_views += 1

        if pair_added > 0:
            accepted_pairs += 1

    if collected_points:
        points = np.concatenate(collected_points, axis=0).astype(np.float32, copy=False)
        colors = np.concatenate(collected_colors, axis=0).astype(np.float32, copy=False)
    else:
        points = np.zeros((0, 3), dtype=np.float32)
        colors = np.zeros((0, 3), dtype=np.float32)

    return {
        'points': points,
        'colors': colors,
        'alignedPointCount': raw_point_count,
        'alignmentReady': bool(raw_point_count > 0),
        'attemptedPairCount': attempted_pairs,
        'acceptedPairCount': accepted_pairs,
        'acceptedViewCount': accepted_views,
    }


def calibrate_metric3d_depth_map(depth_map, confidence_map, image_data: dict, camera: dict, points_by_id: dict[int, dict]) -> tuple[object, dict]:
    import numpy as np

    depth_map = np.asarray(depth_map, dtype=np.float32)
    confidence_map = np.asarray(confidence_map, dtype=np.float32)
    if depth_map.ndim != 2 or confidence_map.ndim != 2:
        return depth_map, {'applied': False, 'anchorCount': 0, 'scale': None, 'bias': None, 'medianResidual': None}

    image_width = int(camera['width'])
    image_height = int(camera['height'])
    depth_height, depth_width = depth_map.shape
    scale_x = (depth_width - 1) / max(float(image_width - 1), 1.0)
    scale_y = (depth_height - 1) / max(float(image_height - 1), 1.0)
    rotation, translation = get_camera_extrinsics(image_data)
    rotation = np.asarray(rotation, dtype=np.float64)
    translation = np.asarray(translation, dtype=np.float64).reshape(3)

    source_depths = []
    target_depths = []
    weights = []
    for point_entry in image_data.get('points2D', []):
        point_id = int(point_entry.get('point3DId', -1))
        if point_id <= 0 or point_id not in points_by_id:
            continue

        xy = np.asarray(point_entry.get('xy', [0.0, 0.0]), dtype=np.float64).reshape(2)
        sample_x = int(np.clip(np.rint(xy[0] * scale_x), 0, depth_width - 1))
        sample_y = int(np.clip(np.rint(xy[1] * scale_y), 0, depth_height - 1))
        raw_depth = float(depth_map[sample_y, sample_x])
        confidence = float(confidence_map[sample_y, sample_x])
        if not np.isfinite(raw_depth) or raw_depth <= 0.05 or not np.isfinite(confidence) or confidence <= 0.0:
            continue

        point_world = np.asarray(points_by_id[point_id]['xyz'], dtype=np.float64).reshape(3)
        point_camera = (rotation @ point_world) + translation
        target_depth = float(point_camera[2])
        if not np.isfinite(target_depth) or target_depth <= 0.05:
            continue

        source_depths.append(raw_depth)
        target_depths.append(target_depth)
        weights.append(max(confidence, 1e-3))

    anchor_count = len(source_depths)
    if anchor_count < MIN_METRIC3D_CALIBRATION_ANCHORS:
        return depth_map, {'applied': False, 'anchorCount': anchor_count, 'scale': None, 'bias': None, 'medianResidual': None, 'method': None}

    source_depths_array = np.asarray(source_depths, dtype=np.float64)
    target_depths_array = np.asarray(target_depths, dtype=np.float64)
    weight_array = np.asarray(weights, dtype=np.float64)
    calibration_candidates = []

    design = np.stack([source_depths_array, np.ones_like(source_depths_array)], axis=1)
    sqrt_weights = np.sqrt(np.maximum(weight_array, 1e-6))
    weighted_design = design * sqrt_weights[:, None]
    weighted_target = target_depths_array * sqrt_weights
    affine_scale, affine_bias = np.linalg.lstsq(weighted_design, weighted_target, rcond=None)[0]
    if np.isfinite(affine_scale) and np.isfinite(affine_bias) and affine_scale > 0.0:
        affine_residuals = np.abs((affine_scale * source_depths_array) + affine_bias - target_depths_array)
        calibration_candidates.append({
            'method': 'affine',
            'scale': float(affine_scale),
            'bias': float(affine_bias),
            'medianResidual': float(np.median(affine_residuals)) if affine_residuals.size else float('inf'),
        })

    scale_only_denominator = float(np.sum(weight_array * source_depths_array * source_depths_array))
    if scale_only_denominator > 1e-9:
        scale_only = float(np.sum(weight_array * source_depths_array * target_depths_array) / scale_only_denominator)
        if np.isfinite(scale_only) and scale_only > 0.0:
            scale_only_residuals = np.abs((scale_only * source_depths_array) - target_depths_array)
            calibration_candidates.append({
                'method': 'scale_only_weighted_ls',
                'scale': scale_only,
                'bias': 0.0,
                'medianResidual': float(np.median(scale_only_residuals)) if scale_only_residuals.size else float('inf'),
            })

    ratio_mask = source_depths_array > 1e-6
    if np.any(ratio_mask):
        ratio_scale = float(np.median(target_depths_array[ratio_mask] / source_depths_array[ratio_mask]))
        if np.isfinite(ratio_scale) and ratio_scale > 0.0:
            ratio_residuals = np.abs((ratio_scale * source_depths_array) - target_depths_array)
            calibration_candidates.append({
                'method': 'scale_only_median_ratio',
                'scale': ratio_scale,
                'bias': 0.0,
                'medianResidual': float(np.median(ratio_residuals)) if ratio_residuals.size else float('inf'),
            })

    if not calibration_candidates:
        return depth_map, {'applied': False, 'anchorCount': anchor_count, 'scale': None, 'bias': None, 'medianResidual': None, 'method': None}

    best_candidate = min(
        calibration_candidates,
        key=lambda candidate: (candidate['medianResidual'], 0 if candidate['method'] == 'affine' else 1),
    )
    scale = float(best_candidate['scale'])
    bias = float(best_candidate['bias'])

    calibrated_depth = (scale * depth_map.astype(np.float64)) + bias
    calibrated_depth = np.where(np.isfinite(calibrated_depth) & (calibrated_depth > 0.05), calibrated_depth, 0.0).astype(np.float32)
    return calibrated_depth, {
        'applied': True,
        'anchorCount': anchor_count,
        'scale': scale,
        'bias': bias,
        'medianResidual': float(best_candidate['medianResidual']),
        'method': str(best_candidate['method']),
    }


def collect_metric3d_depth_anchors(depth_map, confidence_map, image_data: dict, camera: dict, points_by_id: dict[int, dict]):
    import numpy as np

    depth_map = np.asarray(depth_map, dtype=np.float32)
    confidence_map = np.asarray(confidence_map, dtype=np.float32)
    if depth_map.ndim != 2 or confidence_map.ndim != 2:
        return [], [], []

    image_width = int(camera['width'])
    image_height = int(camera['height'])
    depth_height, depth_width = depth_map.shape
    scale_x = (depth_width - 1) / max(float(image_width - 1), 1.0)
    scale_y = (depth_height - 1) / max(float(image_height - 1), 1.0)
    rotation, translation = get_camera_extrinsics(image_data)
    rotation = np.asarray(rotation, dtype=np.float64)
    translation = np.asarray(translation, dtype=np.float64).reshape(3)

    source_depths = []
    target_depths = []
    weights = []
    for point_entry in image_data.get('points2D', []):
        point_id = int(point_entry.get('point3DId', -1))
        if point_id <= 0 or point_id not in points_by_id:
            continue

        xy = np.asarray(point_entry.get('xy', [0.0, 0.0]), dtype=np.float64).reshape(2)
        sample_x = int(np.clip(np.rint(xy[0] * scale_x), 0, depth_width - 1))
        sample_y = int(np.clip(np.rint(xy[1] * scale_y), 0, depth_height - 1))
        raw_depth = float(depth_map[sample_y, sample_x])
        confidence = float(confidence_map[sample_y, sample_x])
        if (
            not np.isfinite(raw_depth)
            or raw_depth <= 0.05
            or not np.isfinite(confidence)
            or confidence < METRIC3D_DEPTH_CONFIDENCE_THRESHOLD
        ):
            continue

        point_world = np.asarray(points_by_id[point_id]['xyz'], dtype=np.float64).reshape(3)
        point_camera = (rotation @ point_world) + translation
        target_depth = float(point_camera[2])
        if not np.isfinite(target_depth) or target_depth <= 0.05:
            continue

        source_depths.append(raw_depth)
        target_depths.append(target_depth)
        weights.append(max(confidence, 1e-3))

    return source_depths, target_depths, weights


def estimate_global_metric3d_calibration(depth_priors_dir: Path, images_meta: dict[str, dict], cameras: dict[int, dict], points_by_id: dict[int, dict]) -> dict:
    import numpy as np

    source_depths = []
    target_depths = []
    weights = []
    per_image_anchor_counts: dict[str, int] = {}

    for image_name, image_data in sorted(images_meta.items()):
        depth_path = depth_priors_dir / 'depth' / f'{Path(image_name).stem}_depth.npy'
        confidence_path = depth_priors_dir / 'confidence' / f'{Path(image_name).stem}_confidence.npy'
        camera = cameras.get(image_data['cam_id'])
        if not depth_path.exists() or not confidence_path.exists() or not camera:
            per_image_anchor_counts[image_name] = 0
            continue

        depth_map = np.load(depth_path).astype(np.float32)
        confidence_map = np.load(confidence_path).astype(np.float32)
        image_sources, image_targets, image_weights = collect_metric3d_depth_anchors(
            depth_map,
            confidence_map,
            image_data,
            camera,
            points_by_id,
        )
        per_image_anchor_counts[image_name] = len(image_sources)
        source_depths.extend(image_sources)
        target_depths.extend(image_targets)
        weights.extend(image_weights)

    anchor_count = len(source_depths)
    if anchor_count < MIN_METRIC3D_CALIBRATION_ANCHORS:
        return {
            'applied': False,
            'anchorCount': anchor_count,
            'scale': None,
            'bias': 0.0,
            'medianResidual': None,
            'method': 'global_scale_only_median_ratio',
            'perImageAnchorCounts': per_image_anchor_counts,
        }

    source = np.asarray(source_depths, dtype=np.float64)
    target = np.asarray(target_depths, dtype=np.float64)
    weight_array = np.asarray(weights, dtype=np.float64)
    ratio_mask = np.isfinite(source) & np.isfinite(target) & (source > 1e-6) & (target > 0.05)
    source = source[ratio_mask]
    target = target[ratio_mask]
    weight_array = weight_array[ratio_mask]
    if source.shape[0] < MIN_METRIC3D_CALIBRATION_ANCHORS:
        return {
            'applied': False,
            'anchorCount': int(source.shape[0]),
            'scale': None,
            'bias': 0.0,
            'medianResidual': None,
            'method': 'global_scale_only_median_ratio',
            'perImageAnchorCounts': per_image_anchor_counts,
        }

    ratios = target / source
    low, high = np.percentile(ratios, [5.0, 95.0])
    trimmed = np.isfinite(ratios) & (ratios >= low) & (ratios <= high)
    if int(trimmed.sum()) >= MIN_METRIC3D_CALIBRATION_ANCHORS:
        source = source[trimmed]
        target = target[trimmed]
        weight_array = weight_array[trimmed]
        ratios = ratios[trimmed]

    # Use one shared scale and no additive bias. A per-image affine bias can make
    # independently plausible depth maps disagree in 3D, which Poisson turns into
    # shards and stretched sheets.
    scale = float(np.median(ratios))
    if not np.isfinite(scale) or scale <= 0.0:
        denominator = float(np.sum(weight_array * source * source))
        scale = float(np.sum(weight_array * source * target) / denominator) if denominator > 1e-9 else 0.0

    if not np.isfinite(scale) or scale <= 0.0:
        return {
            'applied': False,
            'anchorCount': int(source.shape[0]),
            'scale': None,
            'bias': 0.0,
            'medianResidual': None,
            'method': 'global_scale_only_median_ratio',
            'perImageAnchorCounts': per_image_anchor_counts,
        }

    residuals = np.abs((scale * source) - target)
    return {
        'applied': True,
        'anchorCount': int(source.shape[0]),
        'scale': scale,
        'bias': 0.0,
        'medianResidual': float(np.median(residuals)) if residuals.size else None,
        'p90Residual': float(np.percentile(residuals, 90)) if residuals.size else None,
        'method': 'global_scale_only_median_ratio',
        'perImageAnchorCounts': per_image_anchor_counts,
    }


def load_reflective_mask(
    masks_dir: Path | None,
    image_name: str,
    target_shape: tuple[int, int],
    cv2,
    np,
    *,
    exclude_mirror: bool = True,
    exclude_transmissive: bool = True,
):
    if SEMANTIC_MASKS is None or masks_dir is None:
        return None, 0, 0.0

    manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
    if not manifest:
        return None, 0, 0.0

    try:
        frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, manifest)
    except Exception:
        return None, 0, 0.0

    target_height, target_width = target_shape
    reflective_union = None
    class_names = []
    if exclude_mirror:
        class_names.append('mirror')
    if exclude_transmissive:
        class_names.extend(['window', 'glass'])
    for class_name in class_names:
        class_mask = frame_masks.get(class_name)
        if class_mask is None:
            continue
        class_bool = np.asarray(class_mask) > 0
        if class_bool.shape[:2] != (target_height, target_width):
            class_bool = cv2.resize(
                class_bool.astype(np.uint8),
                (target_width, target_height),
                interpolation=cv2.INTER_NEAREST,
            ).astype(bool)
        if class_name == 'mirror' and METRIC3D_MIRROR_MASK_DILATION_PX > 0 and np.any(class_bool):
            kernel = np.ones(
                ((METRIC3D_MIRROR_MASK_DILATION_PX * 2) + 1, (METRIC3D_MIRROR_MASK_DILATION_PX * 2) + 1),
                dtype=np.uint8,
            )
            class_bool = cv2.dilate(class_bool.astype(np.uint8), kernel, iterations=1).astype(bool)
        reflective_union = class_bool if reflective_union is None else (reflective_union | class_bool)

    if reflective_union is None:
        return None, 0, 0.0
    excluded = int(reflective_union.sum())
    coverage = float(reflective_union.mean())
    return reflective_union, excluded, coverage


def build_geometry_source(*, learned_point_count: int, depth_prior_point_count: int, stereo_point_count: int) -> str:
    sources = []
    if learned_point_count > 0:
        sources.append('fast3r_world_pointmaps')
    if depth_prior_point_count > 0:
        sources.append('depth_priors_world')
    if stereo_point_count > 0:
        sources.append('colmap_stereo')
    return '_plus_'.join(sources) if sources else 'sparse_only'


def write_ply(points, colors, path: Path, normals=None) -> None:
    with path.open('w', encoding='utf-8') as handle:
        handle.write('ply\nformat ascii 1.0\n')
        handle.write(f'element vertex {points.shape[0]}\n')
        handle.write('property float x\nproperty float y\nproperty float z\n')
        has_normals = normals is not None and getattr(normals, 'shape', (0,))[0] == points.shape[0]
        if has_normals:
            handle.write('property float nx\nproperty float ny\nproperty float nz\n')
        handle.write('property uchar red\nproperty uchar green\nproperty uchar blue\n')
        handle.write('end_header\n')
        for index in range(points.shape[0]):
            red, green, blue = (colors[index] * 255).clip(0, 255).astype(int)
            if has_normals:
                handle.write(
                    f'{points[index, 0]} {points[index, 1]} {points[index, 2]} '
                    f'{normals[index, 0]} {normals[index, 1]} {normals[index, 2]} '
                    f'{red} {green} {blue}\n'
                )
            else:
                handle.write(f'{points[index, 0]} {points[index, 1]} {points[index, 2]} {red} {green} {blue}\n')


def metric3d_mesh_calibration_is_usable(calibration: dict) -> tuple[bool, str | None]:
    median_residual = calibration.get('medianResidual')
    p90_residual = calibration.get('p90Residual')
    if median_residual is None or p90_residual is None:
        return False, 'missing_residuals'

    median_residual = float(median_residual)
    p90_residual = float(p90_residual)
    if not (median_residual <= METRIC3D_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS):
        return False, (
            f'median_residual_m={median_residual:.3f}'
            f'>limit={METRIC3D_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS:.3f}'
        )
    if not (p90_residual <= METRIC3D_MAX_CALIBRATION_P90_RESIDUAL_METERS):
        return False, (
            f'p90_residual_m={p90_residual:.3f}'
            f'>limit={METRIC3D_MAX_CALIBRATION_P90_RESIDUAL_METERS:.3f}'
        )
    return True, None


def filter_metric3d_points_against_stereo_support(
    sampled_points,
    sampled_colors,
    sampled_normals,
    stereo_point_tree,
    *,
    min_distance_meters: float,
    max_distance_meters: float,
):
    import numpy as np

    if stereo_point_tree is None or sampled_points.shape[0] == 0:
        return sampled_points, sampled_colors, sampled_normals

    distances, _ = stereo_point_tree.query(sampled_points, k=1)
    keep_mask = (
        np.isfinite(distances)
        & (distances >= min_distance_meters)
        & (distances <= max_distance_meters)
    )
    sampled_points = sampled_points[keep_mask]
    sampled_colors = sampled_colors[keep_mask]
    if sampled_normals is not None:
        sampled_normals = sampled_normals[keep_mask]
    return sampled_points, sampled_colors, sampled_normals


def count_ply_points(path: Path) -> int:
    with path.open('rb') as handle:
        for line in handle:
            if line.startswith(b'element vertex'):
                return int(line.split()[2])
            if line.startswith(b'end_header'):
                break
    return 0


def save_colmap_float_map(array, output_path: Path) -> None:
    import numpy as np

    if array.ndim == 2:
        height, width = array.shape
        channels = 1
    elif array.ndim == 3:
        height, width, channels = array.shape
    else:
        raise ValueError(f'Unsupported COLMAP float map rank: {array.ndim}')

    ensure_dir(output_path.parent)
    contiguous = np.ascontiguousarray(array.astype('<f4', copy=False))
    with output_path.open('wb') as handle:
        handle.write(f'{width}&{height}&{channels}&'.encode('ascii'))
        handle.write(contiguous.tobytes(order='C'))


def save_colmap_depth_map(depth, output_path: Path) -> None:
    import numpy as np

    if depth.ndim != 2:
        raise ValueError(f'Expected a 2D depth map, got shape {depth.shape}')

    sanitized_depth = np.where(np.isfinite(depth) & (depth > 0), depth, 0.0).astype(np.float32, copy=False)
    save_colmap_float_map(sanitized_depth, output_path)


def normalize_colmap_normal_map(normals, valid_depth_mask):
    import numpy as np

    if normals.ndim != 3 or normals.shape[2] != 3:
        raise ValueError(f'Expected an HxWx3 normal map, got shape {normals.shape}')

    sanitized = np.ascontiguousarray(normals.astype(np.float32, copy=False))
    finite_mask = np.all(np.isfinite(sanitized), axis=2) & valid_depth_mask
    norms = np.linalg.norm(sanitized, axis=2, keepdims=True)
    normalized = np.divide(
        sanitized,
        np.where(norms > 1e-8, norms, 1.0),
        out=np.zeros_like(sanitized),
        where=norms > 1e-8,
    )
    normalized[~finite_mask] = 0.0
    return normalized.astype(np.float32, copy=False)


def save_colmap_normal_map(normals, output_path: Path) -> None:
    save_colmap_float_map(normals, output_path)


def iter_workspace_images(images_dir: Path):
    for image_path in sorted(images_dir.rglob('*')):
        if image_path.is_file() and image_path.suffix.lower() in {'.jpg', '.jpeg', '.png'}:
            yield image_path


def generate_metric3d_depth_priors(
    metric3d_dir: Path,
    dense_workspace_dir: Path,
    images_meta: dict[str, dict],
    cameras: dict[int, dict],
    points_by_id: dict[int, dict],
    *,
    masks_dir: Path | None = None,
    priors_are_aligned: bool = False,
    global_metric3d_calibration: dict | None = None,
    prefer_global_calibration: bool = True,
) -> tuple[Path, Path, int]:
    import cv2
    import numpy as np

    depth_maps_dir = dense_workspace_dir / 'stereo' / 'depth_maps'
    normal_maps_dir = dense_workspace_dir / 'stereo' / 'normal_maps'
    depth_maps_dir.mkdir(parents=True, exist_ok=True)
    normal_maps_dir.mkdir(parents=True, exist_ok=True)
    undistorted_images_dir = dense_workspace_dir / 'images'

    generated = 0
    missing_priors: list[str] = []
    for image_path in iter_workspace_images(undistorted_images_dir):
        relative_image_path = image_path.relative_to(undistorted_images_dir)
        image_name = relative_image_path.name

        source_depth_path = metric3d_dir / 'depth' / f'{image_path.stem}_depth.npy'
        source_confidence_path = metric3d_dir / 'confidence' / f'{image_path.stem}_confidence.npy'
        source_normal_path = metric3d_dir / 'normals' / f'{image_path.stem}_normals.npy'
        image_data = images_meta.get(image_name)
        camera = cameras.get(image_data['cam_id']) if image_data else None
        if (
            not source_depth_path.exists()
            or not source_confidence_path.exists()
            or not source_normal_path.exists()
            or image_data is None
            or camera is None
        ):
            missing_priors.append(relative_image_path.as_posix())
            continue

        depth = np.load(source_depth_path).astype(np.float32)
        confidence = np.load(source_confidence_path).astype(np.float32)
        normals = np.load(source_normal_path).astype(np.float32)
        undistorted_image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if undistorted_image is None:
            raise RuntimeError(f'undistorted_dense_image_unreadable:{relative_image_path.as_posix()}')

        if depth.ndim != 2 or confidence.ndim != 2:
            raise RuntimeError(f'metric3d_depth_prior_invalid_shape:{source_depth_path.name}')
        if normals.ndim != 3 or normals.shape[2] != 3:
            raise RuntimeError(f'metric3d_normal_prior_invalid_shape:{source_normal_path.name}')

        target_height, target_width = undistorted_image.shape[:2]
        if depth.shape[:2] != (target_height, target_width):
            depth = cv2.resize(depth, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
        if confidence.shape[:2] != (target_height, target_width):
            confidence = cv2.resize(confidence, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
        if normals.shape[:2] != (target_height, target_width):
            normals = cv2.resize(normals, (target_width, target_height), interpolation=cv2.INTER_LINEAR)

        if priors_are_aligned:
            calibrated_depth = depth
            calibration = {'applied': True, 'method': 'post_sfm_aligned'}
        elif prefer_global_calibration and (global_metric3d_calibration or {}).get('applied'):
            scale = float((global_metric3d_calibration or {})['scale'])
            calibrated_depth = np.where(
                np.isfinite(depth) & (depth > 0.05),
                depth.astype(np.float64) * scale,
                0.0,
            ).astype(np.float32)
            calibration = {'applied': True, 'method': 'global_scale_only'}
        else:
            calibrated_depth, calibration = calibrate_metric3d_depth_map(
                depth,
                confidence,
                image_data,
                camera,
                points_by_id,
            )

        if calibration.get('applied'):
            reflective_mask, _, _ = load_reflective_mask(
                masks_dir,
                image_name,
                (target_height, target_width),
                cv2,
                np,
                exclude_mirror=False,
            )
            valid_depth_mask = (
                np.isfinite(calibrated_depth)
                & np.isfinite(confidence)
                & (calibrated_depth > 0.05)
                & (calibrated_depth < METRIC3D_MAX_DEPTH_METERS)
                & (confidence >= METRIC3D_DEPTH_CONFIDENCE_THRESHOLD)
            )
            if reflective_mask is not None:
                valid_depth_mask &= ~reflective_mask
            calibrated_depth = np.where(valid_depth_mask, calibrated_depth, 0.0).astype(np.float32, copy=False)
        else:
            calibrated_depth = np.zeros((target_height, target_width), dtype=np.float32)
            valid_depth_mask = np.zeros((target_height, target_width), dtype=bool)

        normalized_normals = normalize_colmap_normal_map(normals, valid_depth_mask)
        depth_output_path = depth_maps_dir / relative_image_path.parent / f'{relative_image_path.name}.photometric.bin'
        normal_output_path = normal_maps_dir / relative_image_path.parent / f'{relative_image_path.name}.photometric.bin'

        save_colmap_depth_map(calibrated_depth, depth_output_path)
        save_colmap_normal_map(normalized_normals, normal_output_path)
        generated += 1

    if missing_priors:
        raise RuntimeError(f'metric3d_dense_priors_missing_for_registered_images:{len(missing_priors)}')

    if generated == 0:
        raise RuntimeError('metric3d_dense_priors_missing_for_dense_stereo')

    return depth_maps_dir, normal_maps_dir, generated


def run_dense_stereo(
    images_dir: Path,
    sfm_text_model_dir: Path,
    depth_priors_dir: Path,
    output_dir: Path,
    patch_match_gpu_indices: str | None,
    *,
    images_meta: dict[str, dict],
    cameras: dict[int, dict],
    points_by_id: dict[int, dict],
    masks_dir: Path | None = None,
    priors_are_aligned: bool = False,
    global_metric3d_calibration: dict | None = None,
    prefer_global_calibration: bool = True,
) -> tuple[Path, int, str | None, str]:
    colmap_binary = resolve_colmap_binary()
    if not colmap_binary:
        raise RuntimeError('colmap_binary_missing_for_dense_stereo')

    dense_workspace_dir = output_dir / 'colmap_dense'
    dense_workspace_dir.mkdir(parents=True, exist_ok=True)
    fused_ply_path = output_dir / 'fused.ply'
    applied_patch_match_gpu_indices = None
    supports_patch_match_gpu_index = colmap_command_supports_option(colmap_binary, 'patch_match_stereo', '--PatchMatchStereo.gpu_index')
    supports_patch_match_filter = colmap_command_supports_option(colmap_binary, 'patch_match_stereo', '--PatchMatchStereo.filter')
    if patch_match_gpu_indices and supports_patch_match_gpu_index:
        applied_patch_match_gpu_indices = patch_match_gpu_indices

    def run_dense_attempt(mode: str, *, use_depth_priors: bool, geom_consistency: bool, fusion_input_type: str) -> int:
        if dense_workspace_dir.exists():
            shutil.rmtree(dense_workspace_dir)
        dense_workspace_dir.mkdir(parents=True, exist_ok=True)
        if fused_ply_path.exists():
            fused_ply_path.unlink()

        subprocess.run([
            colmap_binary,
            'image_undistorter',
            '--image_path', str(images_dir),
            '--input_path', str(sfm_text_model_dir),
            '--output_path', str(dense_workspace_dir),
            '--output_type', 'COLMAP',
        ], check=True)

        if use_depth_priors:
            generate_metric3d_depth_priors(
                depth_priors_dir,
                dense_workspace_dir,
                images_meta,
                cameras,
                points_by_id,
                masks_dir=masks_dir,
                priors_are_aligned=priors_are_aligned,
                global_metric3d_calibration=global_metric3d_calibration,
                prefer_global_calibration=prefer_global_calibration,
            )

        patch_match_command = [
            colmap_binary,
            'patch_match_stereo',
            '--workspace_path', str(dense_workspace_dir),
            '--workspace_format', 'COLMAP',
            '--PatchMatchStereo.geom_consistency', 'true' if geom_consistency else 'false',
        ]
        if DENSE_STEREO_MAX_IMAGE_SIZE > 0:
            patch_match_command.extend(['--PatchMatchStereo.max_image_size', str(DENSE_STEREO_MAX_IMAGE_SIZE)])
        if DENSE_STEREO_WINDOW_RADIUS > 0:
            patch_match_command.extend(['--PatchMatchStereo.window_radius', str(DENSE_STEREO_WINDOW_RADIUS)])
        if geom_consistency:
            patch_match_command.extend(['--PatchMatchStereo.write_consistency_graph', 'true'])
            if supports_patch_match_filter:
                patch_match_command.extend(['--PatchMatchStereo.filter', 'true'])
        if applied_patch_match_gpu_indices:
            patch_match_command.extend(['--PatchMatchStereo.gpu_index', applied_patch_match_gpu_indices])

        print(f'[DenseEvidence] Running dense stereo mode={mode}')
        subprocess.run(patch_match_command, check=True)

        subprocess.run([
            colmap_binary,
            'stereo_fusion',
            '--workspace_path', str(dense_workspace_dir),
            '--workspace_format', 'COLMAP',
            '--input_type', fusion_input_type,
            '--StereoFusion.min_num_pixels', str(DENSE_STEREO_FUSION_MIN_NUM_PIXELS),
            '--output_path', str(fused_ply_path),
        ], check=True)

        return count_ply_points(fused_ply_path)

    min_dense_stereo_point_count = get_min_dense_stereo_point_count(images_dir)
    dense_attempts = [
        ('depth_priors_geometric', True, True, 'geometric'),
        ('no_priors_geometric', False, True, 'geometric'),
        ('no_priors_photometric', False, False, 'photometric'),
    ]
    last_error: Exception | None = None
    last_point_count = 0
    best_attempt_mode: str | None = None
    best_attempt_path: Path | None = None
    best_point_count = 0

    for attempt_mode, use_depth_priors, geom_consistency, fusion_input_type in dense_attempts:
        try:
            fused_point_count = run_dense_attempt(
                attempt_mode,
                use_depth_priors=use_depth_priors,
                geom_consistency=geom_consistency,
                fusion_input_type=fusion_input_type,
            )
        except Exception as error:
            last_error = error
            print(f'[DenseEvidence] Dense stereo mode={attempt_mode} failed: {error}')
            continue

        last_point_count = fused_point_count
        attempt_output_path = output_dir / f'fused_{attempt_mode}.ply'
        shutil.copyfile(fused_ply_path, attempt_output_path)
        if fused_point_count > best_point_count:
            best_point_count = fused_point_count
            best_attempt_mode = attempt_mode
            best_attempt_path = attempt_output_path

        print(
            f'[DenseEvidence] Dense stereo mode={attempt_mode} produced '
            f'{fused_point_count} points; expected at least {min_dense_stereo_point_count}.',
        )

    if best_attempt_path is not None and best_point_count > 0:
        return best_attempt_path, best_point_count, applied_patch_match_gpu_indices, str(best_attempt_mode)

    if last_error is not None and last_point_count == 0:
        raise last_error

    raise RuntimeError(f'dense_stereo_point_count_too_low:{last_point_count}')


def write_dry_run_outputs(job_id: str, output_dir: Path, learned_matching_dir: Path, patch_match_gpu_indices: str | None) -> dict:
    import numpy as np

    u = np.linspace(-1.0, 1.0, 48, dtype=np.float32)
    v = np.linspace(-1.0, 1.0, 48, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)
    points = np.stack([uu.reshape(-1), vv.reshape(-1), np.ones(uu.size, dtype=np.float32)], axis=-1)
    colors = np.tile(np.array([[0.78, 0.78, 0.78]], dtype=np.float32), (points.shape[0], 1))

    np.save(output_dir / 'points.npy', points)
    np.save(output_dir / 'colors.npy', colors)
    write_ply(points, colors, output_dir / 'fused_scene.ply')

    learned_summary_path = learned_matching_dir / 'summary.json'
    learned_summary = read_json(learned_summary_path) if learned_summary_path.exists() else {}
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': True,
        'pointCount': int(points.shape[0]),
        'sparsePointCount': 0,
        'depthPriorsBackprojectedPointCount': int(points.shape[0]),
        'learnedPairCount': learned_summary.get('pairCount', 0),
        'learnedWorldAlignedPointCount': 0,
        'learnedWorldAlignmentReady': False,
        'patchMatchGpuIndices': patch_match_gpu_indices,
        'note': 'Dry-run dense evidence output for master_v1 wiring validation only.',
    }
    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_dense_evidence(
    job_id: str,
    images_dir: Path,
    sfm_text_model_dir: Path,
    depth_priors_dir: Path,
    learned_matching_dir: Path,
    output_dir: Path,
    patch_match_gpu_indices: str | None,
    skip_patch_match_stereo: bool = False,
    masks_dir: Path | None = None,
    mesh_primary_fusion: bool = False,
) -> dict:
    import cv2
    import numpy as np
    import open3d as o3d

    cameras = parse_colmap_cameras_txt(sfm_text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(sfm_text_model_dir / 'images.txt')
    sparse_points, sparse_colors = parse_colmap_points_txt(sfm_text_model_dir / 'points3D.txt')
    points_by_id = parse_colmap_points_lookup(sfm_text_model_dir / 'points3D.txt')

    if sparse_points.shape[0] < MIN_SPARSE_STEREO_POINT_COUNT:
        raise RuntimeError(f'sparse_geometry_too_weak_for_dense_stereo:{sparse_points.shape[0]}')

    priors_are_aligned = depth_priors_are_post_sfm_aligned(depth_priors_dir)
    global_metric3d_calibration = {'applied': False, 'anchorCount': 0, 'method': None}
    global_metric3d_calibration_usable = bool(priors_are_aligned)
    global_metric3d_calibration_reason = None
    if not priors_are_aligned:
        global_metric3d_calibration = estimate_global_metric3d_calibration(
            depth_priors_dir,
            images_meta,
            cameras,
            points_by_id,
        )
        global_metric3d_calibration_usable, global_metric3d_calibration_reason = metric3d_mesh_calibration_is_usable(
            global_metric3d_calibration
        )
        if skip_patch_match_stereo and not global_metric3d_calibration.get('applied'):
            raise RuntimeError(
                'metric3d_mesh_requires_global_depth_scale: '
                f'anchors={global_metric3d_calibration.get("anchorCount", 0)}'
            )
        if skip_patch_match_stereo and not global_metric3d_calibration_usable:
            raise RuntimeError(
                'metric3d_mesh_calibration_residual_too_high: '
                f'{global_metric3d_calibration_reason}; '
                f'anchors={global_metric3d_calibration.get("anchorCount", 0)}'
            )

    fused_ply_path = output_dir / 'fused.ply'
    fused_point_count = 0
    applied_patch_match_gpu_indices = None
    dense_stereo_mode: str | None = None
    dense_stereo_error: str | None = None
    stereo_points = np.empty((0, 3), dtype=np.float32)
    stereo_colors = np.empty((0, 3), dtype=np.float32)

    if skip_patch_match_stereo:
        dense_stereo_mode = 'skipped_metric3d_mesh_sidecar'
    else:
        try:
            fused_ply_path, fused_point_count, applied_patch_match_gpu_indices, dense_stereo_mode = run_dense_stereo(
                images_dir,
                sfm_text_model_dir,
                depth_priors_dir,
                output_dir,
                patch_match_gpu_indices,
                images_meta=images_meta,
                cameras=cameras,
                points_by_id=points_by_id,
                masks_dir=masks_dir,
                priors_are_aligned=priors_are_aligned,
                global_metric3d_calibration=global_metric3d_calibration,
                prefer_global_calibration=global_metric3d_calibration_usable,
            )
            stereo_point_cloud = o3d.io.read_point_cloud(str(fused_ply_path))
            stereo_points = np.asarray(stereo_point_cloud.points, dtype=np.float32)
            stereo_colors = np.asarray(stereo_point_cloud.colors, dtype=np.float32)
            if stereo_points.shape[0] > 0 and stereo_colors.shape[0] != stereo_points.shape[0]:
                stereo_colors = np.ones((stereo_points.shape[0], 3), dtype=np.float32)
            if stereo_points.shape[0] == 0:
                dense_stereo_error = 'dense_stereo_produced_empty_point_cloud'
        except Exception as error:
            dense_stereo_error = str(error)

    fused_points = []
    fused_colors = []
    fused_normals = []
    if len(sparse_points) and not skip_patch_match_stereo and not mesh_primary_fusion:
        fused_points.append(sparse_points)
        fused_colors.append(sparse_colors)
    if stereo_points.shape[0] > 0:
        fused_points.append(stereo_points)
        fused_colors.append(stereo_colors.clip(0.0, 1.0))

    learned_dense_summary = collect_learned_world_space_points(
        images_dir,
        learned_matching_dir,
        cameras,
        images_meta,
        points_by_id,
        compute_scene_diagonal(sparse_points),
    )
    learned_points = np.asarray(learned_dense_summary['points'], dtype=np.float32)
    learned_colors = np.asarray(learned_dense_summary['colors'], dtype=np.float32)
    if learned_points.shape[0] > 0 and not skip_patch_match_stereo and not mesh_primary_fusion:
        fused_points.append(learned_points)
        fused_colors.append(learned_colors.clip(0.0, 1.0))

    depth_priors_added = 0
    depth_priors_aligned_image_count = 0
    depth_priors_calibration_anchor_count = 0
    depth_prior_point_budget = (
        MAX_METRIC3D_MESH_POINTS_PER_IMAGE if (skip_patch_match_stereo or mesh_primary_fusion)
        else (
            MAX_METRIC3D_POINTS_PER_IMAGE_WITH_LEARNED_DENSE
            if learned_points.shape[0] > 0
            else MAX_METRIC3D_POINTS_PER_IMAGE
        )
    )
    stereo_point_tree = None
    if mesh_primary_fusion and not skip_patch_match_stereo and stereo_points.shape[0] > 0:
        from scipy.spatial import cKDTree

        stereo_point_tree = cKDTree(stereo_points.astype(np.float64))

    metric3d_backprojection_enabled = True
    metric3d_hole_fill_only = bool(mesh_primary_fusion and stereo_point_tree is not None)
    metric3d_backprojection_suppressed_reason = None
    if (
        mesh_primary_fusion
        and not skip_patch_match_stereo
        and stereo_point_tree is None
        and not priors_are_aligned
        and (not global_metric3d_calibration.get('applied') or not global_metric3d_calibration_usable)
    ):
        metric3d_backprojection_enabled = False
        metric3d_backprojection_suppressed_reason = (
            global_metric3d_calibration_reason
            if global_metric3d_calibration.get('applied')
            else 'global_scale_unavailable'
        )
    mask_excluded_pixel_count = 0
    max_reflective_mask_coverage = 0.0

    for image_name, image_data in sorted(images_meta.items()):
        depth_path = depth_priors_dir / 'depth' / f'{Path(image_name).stem}_depth.npy'
        confidence_path = depth_priors_dir / 'confidence' / f'{Path(image_name).stem}_confidence.npy'
        normals_path = depth_priors_dir / 'normals' / f'{Path(image_name).stem}_normals.npy'
        image_path = images_dir / image_name
        if not depth_path.exists() or not confidence_path.exists() or not image_path.exists():
            continue

        depth_map = np.load(depth_path).astype(np.float32)
        confidence_map = np.load(confidence_path).astype(np.float32)
        normals_map = np.load(normals_path).astype(np.float32) if normals_path.exists() else None
        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        if priors_are_aligned:
            calibrated_depth_map = depth_map
            calibration = {'applied': True, 'anchorCount': 0}
        elif global_metric3d_calibration.get('applied') and (
            skip_patch_match_stereo or not mesh_primary_fusion or global_metric3d_calibration_usable
        ):
            scale = float(global_metric3d_calibration['scale'])
            calibrated_depth_map = np.where(
                np.isfinite(depth_map) & (depth_map > 0.05),
                depth_map.astype(np.float64) * scale,
                0.0,
            ).astype(np.float32)
            calibration = {
                'applied': True,
                'anchorCount': int(global_metric3d_calibration.get('perImageAnchorCounts', {}).get(image_name, 0)),
                'scale': scale,
                'bias': 0.0,
                'method': str(global_metric3d_calibration.get('method') or 'global_scale_only'),
            }
        else:
            calibrated_depth_map, calibration = calibrate_metric3d_depth_map(depth_map, confidence_map, image_data, camera, points_by_id)
        depth_priors_calibration_anchor_count += int(calibration.get('anchorCount', 0) or 0)
        if not calibration.get('applied'):
            continue
        depth_priors_aligned_image_count += 1
        if not metric3d_backprojection_enabled:
            continue

        image = cv2.imread(str(image_path))
        if image is None:
            continue
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        if image.shape[:2] != calibrated_depth_map.shape[:2]:
            image = cv2.resize(image, (calibrated_depth_map.shape[1], calibrated_depth_map.shape[0]))
        if normals_map is not None and normals_map.shape[:2] != calibrated_depth_map.shape[:2]:
            normals_map = cv2.resize(
                normals_map,
                (calibrated_depth_map.shape[1], calibrated_depth_map.shape[0]),
                interpolation=cv2.INTER_LINEAR,
            )

        intrinsics = get_intrinsics_matrix(camera)
        rotation, translation = get_camera_extrinsics(image_data)
        fx, fy, cx, cy = intrinsics[0, 0], intrinsics[1, 1], intrinsics[0, 2], intrinsics[1, 2]

        height, width = calibrated_depth_map.shape[:2]
        reflective_mask, excluded_pixels, reflective_coverage = load_reflective_mask(
            masks_dir,
            image_name,
            (height, width),
            cv2,
            np,
            exclude_mirror=False,
        )
        mask_excluded_pixel_count += excluded_pixels
        max_reflective_mask_coverage = max(max_reflective_mask_coverage, reflective_coverage)
        u, v = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        valid = (
            np.isfinite(calibrated_depth_map)
            & np.isfinite(confidence_map)
            & (calibrated_depth_map > 0.05)
            & (calibrated_depth_map < METRIC3D_MAX_DEPTH_METERS)
            & (confidence_map >= METRIC3D_DEPTH_CONFIDENCE_THRESHOLD)
        )
        if reflective_mask is not None:
            valid &= ~reflective_mask
        if not np.any(valid):
            continue

        x_cam = (u - cx) * calibrated_depth_map / fx
        y_cam = (v - cy) * calibrated_depth_map / fy
        points_cam = np.stack([x_cam[valid], y_cam[valid], calibrated_depth_map[valid]], axis=-1)
        colors = image[valid].astype(np.float32) / 255.0
        points_world = (rotation.T @ (points_cam - translation).T).T
        normals_world = None
        if normals_map is not None and normals_map.ndim == 3 and normals_map.shape[2] == 3:
            normals_cam = normals_map[valid].astype(np.float32)
            normal_lengths = np.linalg.norm(normals_cam, axis=1)
            normal_mask = np.isfinite(normals_cam).all(axis=1) & (normal_lengths > 1e-6)
            normals_cam = normals_cam[normal_mask] / normal_lengths[normal_mask, None]
            if normals_cam.shape[0] > 0:
                points_world = points_world[normal_mask]
                colors = colors[normal_mask]
                normals_world = (rotation.T @ normals_cam.T).T.astype(np.float32)
                normals_world_lengths = np.linalg.norm(normals_world, axis=1)
                normals_world = normals_world / np.maximum(normals_world_lengths[:, None], 1e-6)
        elif skip_patch_match_stereo:
            continue

        step = max(1, len(points_world) // depth_prior_point_budget)
        sampled_points = points_world[::step]
        sampled_colors = colors[::step]
        sampled_normals = normals_world[::step] if normals_world is not None else None
        finite_mask = np.isfinite(sampled_points).all(axis=1) & np.isfinite(sampled_colors).all(axis=1)
        if sampled_normals is not None:
            finite_mask &= np.isfinite(sampled_normals).all(axis=1)
        sampled_points = sampled_points[finite_mask]
        sampled_colors = sampled_colors[finite_mask]
        if sampled_normals is not None:
            sampled_normals = sampled_normals[finite_mask]
        if sampled_points.size == 0:
            continue

        if (
            mesh_primary_fusion
            and not skip_patch_match_stereo
            and stereo_point_tree is not None
        ):
            calibration_median_residual = calibration.get('medianResidual')
            if calibration_median_residual is not None and float(calibration_median_residual) > METRIC3D_HOLE_FILL_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS:
                continue
            sampled_points, sampled_colors, sampled_normals = filter_metric3d_points_against_stereo_support(
                sampled_points,
                sampled_colors,
                sampled_normals,
                stereo_point_tree,
                min_distance_meters=METRIC3D_HOLE_FILL_MIN_NEAREST_STEREO_DISTANCE_METERS,
                max_distance_meters=METRIC3D_HOLE_FILL_MAX_NEAREST_STEREO_DISTANCE_METERS,
            )
            if sampled_points.size == 0:
                continue

        fused_points.append(sampled_points)
        fused_colors.append(sampled_colors)
        if sampled_normals is not None:
            fused_normals.append(sampled_normals)
        depth_priors_added += int(sampled_points.shape[0])

    if skip_patch_match_stereo and depth_priors_added == 0:
        raise RuntimeError(
            'metric3d_mesh_requires_depth_prior_fusion: '
            f'no Metric3D depth points were backprojected from {depth_priors_dir}'
        )

    if not fused_points:
        raise RuntimeError('Dense evidence fusion produced no points')

    all_points = np.concatenate(fused_points, axis=0).astype(np.float32)
    all_colors = np.concatenate(fused_colors, axis=0).astype(np.float32)
    all_normals = None
    if fused_normals:
        concatenated_normals = np.concatenate(fused_normals, axis=0).astype(np.float32)
        if concatenated_normals.shape[0] == all_points.shape[0]:
            all_normals = concatenated_normals
    finite_mask = np.isfinite(all_points).all(axis=1) & np.isfinite(all_colors).all(axis=1)
    if all_normals is not None:
        finite_mask &= np.isfinite(all_normals).all(axis=1)
    all_points = all_points[finite_mask]
    all_colors = all_colors[finite_mask]
    if all_normals is not None:
        all_normals = all_normals[finite_mask]

    if all_points.shape[0] == 0:
        raise RuntimeError('Dense evidence fusion produced no finite points')

    try:
        point_cloud = o3d.geometry.PointCloud()
        point_cloud.points = o3d.utility.Vector3dVector(all_points)
        point_cloud.colors = o3d.utility.Vector3dVector(all_colors.clip(0.0, 1.0))
        if all_normals is not None and all_normals.shape[0] == all_points.shape[0]:
            point_cloud.normals = o3d.utility.Vector3dVector(all_normals)
        if all_points.shape[0] >= 20:
            point_cloud, _ = point_cloud.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
        if METRIC3D_VOXEL_SIZE > 0.0:
            point_cloud = point_cloud.voxel_down_sample(voxel_size=METRIC3D_VOXEL_SIZE)
        final_points = np.asarray(point_cloud.points, dtype=np.float32)
        final_colors = np.asarray(point_cloud.colors, dtype=np.float32)
        final_normals = np.asarray(point_cloud.normals, dtype=np.float32) if point_cloud.has_normals() else None
    except Exception:
        final_points = all_points
        final_colors = all_colors.clip(0.0, 1.0)
        final_normals = all_normals

    if final_points.shape[0] < MIN_LAYOUT_READY_POINT_COUNT and all_points.shape[0] >= MIN_LAYOUT_READY_POINT_COUNT:
        final_points = all_points
        final_colors = all_colors.clip(0.0, 1.0)
        final_normals = all_normals

    np.save(output_dir / 'points.npy', final_points)
    np.save(output_dir / 'colors.npy', final_colors)
    if final_normals is not None and final_normals.shape[0] == final_points.shape[0]:
        np.save(output_dir / 'normals.npy', final_normals)
    else:
        final_normals = None
    write_ply(final_points, final_colors, output_dir / 'fused_scene.ply', normals=final_normals)

    learned_summary_path = learned_matching_dir / 'summary.json'
    learned_summary = read_json(learned_summary_path) if learned_summary_path.exists() else {}
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': False,
        'pointCount': int(final_points.shape[0]),
        'stereoFusionPointCount': int(fused_point_count),
        'sparsePointCount': int(sparse_points.shape[0]),
        'depthPriorsBackprojectedPointCount': depth_priors_added,
        'depthPriorsAlignedImageCount': depth_priors_aligned_image_count,
        'depthPriorsCalibrationAnchorCount': depth_priors_calibration_anchor_count,
        'depthPriorsCalibration': global_metric3d_calibration,
        'depthPriorsPointBudgetPerImage': int(depth_prior_point_budget),
        'metric3dDepthConfidenceThreshold': float(METRIC3D_DEPTH_CONFIDENCE_THRESHOLD),
        'metric3dMaxDepthMeters': float(METRIC3D_MAX_DEPTH_METERS),
        'metric3dVoxelSize': float(METRIC3D_VOXEL_SIZE),
        'metric3dMaxCalibrationMedianResidualMeters': float(METRIC3D_MAX_CALIBRATION_MEDIAN_RESIDUAL_METERS),
        'metric3dMaxCalibrationP90ResidualMeters': float(METRIC3D_MAX_CALIBRATION_P90_RESIDUAL_METERS),
        'normalSource': 'metric3d_world' if final_normals is not None else 'none',
        'normalCount': int(final_normals.shape[0]) if final_normals is not None else 0,
        'maskExcludedPixelCount': int(mask_excluded_pixel_count),
        'maxReflectiveMaskCoverage': float(max_reflective_mask_coverage),
        'learnedPairCount': learned_summary.get('pairCount', 0),
        'learnedWorldAlignedPointCount': int(learned_dense_summary['alignedPointCount']),
        'learnedWorldAlignmentReady': bool(learned_dense_summary['alignmentReady']),
        'learnedWorldAlignedPairCount': int(learned_dense_summary['acceptedPairCount']),
        'learnedWorldAlignedViewCount': int(learned_dense_summary['acceptedViewCount']),
        'meshPrimaryFusion': bool(mesh_primary_fusion),
        'metric3dHoleFillOnly': bool(metric3d_hole_fill_only),
        'metric3dBackprojectionEnabled': bool(metric3d_backprojection_enabled),
        'metric3dBackprojectionSuppressedReason': metric3d_backprojection_suppressed_reason,
        'metric3dHoleFillMaxNearestStereoDistanceMeters': float(METRIC3D_HOLE_FILL_MAX_NEAREST_STEREO_DISTANCE_METERS),
        'metric3dHoleFillMinNearestStereoDistanceMeters': float(METRIC3D_HOLE_FILL_MIN_NEAREST_STEREO_DISTANCE_METERS),
        'geometrySource': build_geometry_source(
            learned_point_count=int(learned_dense_summary['alignedPointCount']),
            depth_prior_point_count=depth_priors_added,
            stereo_point_count=int(fused_point_count),
        ),
        'denseStereoMode': dense_stereo_mode,
        'denseStereoError': dense_stereo_error,
        'patchMatchGpuIndices': applied_patch_match_gpu_indices,
        'patchMatchStereoSkipped': bool(skip_patch_match_stereo),
        'note': 'Dense evidence can seed COLMAP PatchMatch with calibrated Metric3D priors, then fuse the resulting stereo cloud with optional world-space Metric3D completion. Mesh-primary fusion prefers PatchMatch-supported geometry and only adds direct Metric3D backprojections when alignment quality is acceptable.',
    }
    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 dense evidence fusion')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--sfm-text-model-dir', required=True)
    parser.add_argument('--depth-priors-dir', '--metric3d-dir', dest='depth_priors_dir', required=True)
    parser.add_argument('--learned-matching-dir', required=True)
    parser.add_argument('--masks-dir')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--patch-match-gpu-indices', default=os.environ.get('MASTER_PIPELINE_DENSE_STEREO_GPU_INDICES', ''))
    parser.add_argument('--skip-patch-match-stereo', action='store_true', default=os.environ.get('MASTER_PIPELINE_SKIP_PATCH_MATCH_STEREO', '').lower() in {'1', 'true', 'yes', 'on'})
    parser.add_argument('--mesh-primary-fusion', action='store_true', default=os.environ.get('MASTER_PIPELINE_MESH_PRIMARY_FUSION', '').lower() in {'1', 'true', 'yes', 'on'})
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    sfm_text_model_dir = Path(args.sfm_text_model_dir)
    depth_priors_dir = Path(args.depth_priors_dir)
    learned_matching_dir = Path(args.learned_matching_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    patch_match_gpu_indices = parse_gpu_indices(args.patch_match_gpu_indices)

    if args.dry_run:
        summary = write_dry_run_outputs(args.job_id, output_dir, learned_matching_dir, patch_match_gpu_indices)
    else:
        summary = run_dense_evidence(
            args.job_id,
            images_dir,
            sfm_text_model_dir,
            depth_priors_dir,
            learned_matching_dir,
            output_dir,
            patch_match_gpu_indices,
            skip_patch_match_stereo=args.skip_patch_match_stereo,
            masks_dir=Path(args.masks_dir) if args.masks_dir else None,
            mesh_primary_fusion=args.mesh_primary_fusion,
        )

    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()