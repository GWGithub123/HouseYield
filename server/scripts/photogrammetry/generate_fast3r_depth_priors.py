#!/usr/bin/env python3
"""Generate COLMAP depth priors directly from Fast3R multiview predictions.

Fast3R runs on the undistorted COLMAP workspace. Small scans run as one global
context, while larger scans are split into overlapping sparse-topology clusters.
Each cluster is aligned to the solved sparse frame, then fused into per-image
depth and normal priors for COLMAP PatchMatch.

This path is intentionally independent from learned sparse pair artifacts such
as feature stores, match stores, and pair npz files.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

from photogrammetry.generate_depth_priors import (
    compute_normals_from_depth,
    save_colmap_depth_map,
    save_colmap_normal_map,
)

SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from master_pipeline.run_dense_evidence import (
    LEARNED_POINTMAP_ANCHOR_MEDIAN_ERROR_RATIO,
    LEARNED_POINTMAP_ANCHOR_MIN_MEDIAN_ERROR,
    LEARNED_POINTMAP_ANCHOR_MIN_P90_ERROR,
    LEARNED_POINTMAP_ANCHOR_P90_ERROR_RATIO,
    LEARNED_POINTMAP_MAX_REPROJECTION_ERROR_PX,
    MIN_LEARNED_POINTMAP_ANCHORS,
    apply_similarity_transform,
    compute_scene_diagonal,
    estimate_similarity_transform,
    parse_colmap_cameras_txt,
    parse_colmap_images_txt,
    parse_colmap_points_lookup,
    project_world_points_to_image,
    sample_dense_map_values,
)
from master_pipeline.run_loftr_indoor_matching import (
    build_fast3r_window_indices,
    load_fast3r_model,
    run_fast3r_inference,
    select_preferred_fast3r_variant,
)


def read_env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return value.strip().lower() not in {'0', 'false', 'no', 'off'}


def read_env_float(name: str, default: float, minimum: float | None = None) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = float(default)
    if minimum is not None:
        value = max(value, float(minimum))
    return value


def read_env_int(name: str, default: int, minimum: int | None = None) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = int(default)
    if minimum is not None:
        value = max(value, int(minimum))
    return value


DEFAULT_FAST3R_PRIOR_IMAGE_SIZE = read_env_int('PHOTOGRAMMETRY_FAST3R_PRIOR_IMAGE_SIZE', 1024, 256)
DEFAULT_FAST3R_PRIOR_GLOBAL_MAX_IMAGES = read_env_int('PHOTOGRAMMETRY_FAST3R_PRIOR_GLOBAL_MAX_IMAGES', 8, 2)
DEFAULT_FAST3R_PRIOR_CLUSTER_SIZE = read_env_int('PHOTOGRAMMETRY_FAST3R_PRIOR_CLUSTER_SIZE', 6, 4)
DEFAULT_FAST3R_PRIOR_CONFIDENCE_PERCENTILE = read_env_float(
    'PHOTOGRAMMETRY_FAST3R_PRIOR_CONFIDENCE_PERCENTILE',
    60.0,
    0.0,
)
DEFAULT_FAST3R_PRIOR_MAX_POINTS_PER_VIEW = read_env_int(
    'PHOTOGRAMMETRY_FAST3R_PRIOR_MAX_POINTS_PER_VIEW',
    40000,
    1024,
)
FAST3R_PRIOR_REQUIRE_REPROJECTION = read_env_bool('PHOTOGRAMMETRY_FAST3R_PRIOR_REQUIRE_REPROJECTION', True)


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for image_path in sorted(images_dir.rglob('*')):
        if image_path.is_file() and image_path.suffix.lower() in {'.jpg', '.jpeg', '.png'}:
            images.append(image_path)
    return images


def model_dir_has_text_model(model_dir: Path) -> bool:
    return all((model_dir / filename).exists() for filename in ('cameras.txt', 'images.txt', 'points3D.txt'))


def model_dir_has_binary_model(model_dir: Path) -> bool:
    return all((model_dir / filename).exists() for filename in ('cameras.bin', 'images.bin', 'points3D.bin'))


def resolve_sparse_model_dir(sparse_model_dir: Path) -> Path:
    sparse_model_dir = Path(sparse_model_dir)
    if model_dir_has_text_model(sparse_model_dir) or model_dir_has_binary_model(sparse_model_dir):
        return sparse_model_dir

    candidate_dirs: list[Path] = []
    for preferred_name in ('merged', '0'):
        candidate = sparse_model_dir / preferred_name
        if candidate.exists() and candidate.is_dir():
            candidate_dirs.append(candidate)
    candidate_dirs.extend(
        candidate
        for candidate in sorted(sparse_model_dir.iterdir())
        if candidate.is_dir() and candidate not in candidate_dirs
    )

    for candidate_dir in candidate_dirs:
        if model_dir_has_text_model(candidate_dir) or model_dir_has_binary_model(candidate_dir):
            return candidate_dir

    raise FileNotFoundError(f'Could not resolve sparse model directory from {sparse_model_dir}')


def resolve_colmap_binary(colmap_path: str | None) -> str:
    if colmap_path:
        return str(colmap_path)

    resolved = shutil.which('colmap-glomap') or shutil.which('colmap')
    if not resolved:
        raise FileNotFoundError('COLMAP binary not found for sparse model conversion')
    return resolved


def ensure_text_model(sparse_model_dir: Path, colmap_path: str | None) -> Path:
    model_dir = resolve_sparse_model_dir(sparse_model_dir)
    if model_dir_has_text_model(model_dir):
        return model_dir

    text_model_dir = model_dir.parent / f'{model_dir.name}_text'
    if model_dir_has_text_model(text_model_dir):
        return text_model_dir

    resolved_colmap = resolve_colmap_binary(colmap_path)
    text_model_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            resolved_colmap,
            'model_converter',
            '--input_path',
            str(model_dir),
            '--output_path',
            str(text_model_dir),
            '--output_type',
            'TXT',
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return text_model_dir


def resolve_registered_image_key(images_meta: dict[str, dict], image_path: Path, images_dir: Path) -> str | None:
    relative_key = image_path.relative_to(images_dir).as_posix()
    if relative_key in images_meta:
        return relative_key
    if image_path.name in images_meta:
        return image_path.name
    return None


def build_registered_image_items(images_dir: Path, images_meta: dict[str, dict]) -> list[tuple[str, Path]]:
    registered_items = []
    for image_path in list_images(images_dir):
        image_key = resolve_registered_image_key(images_meta, image_path, images_dir)
        if image_key:
            registered_items.append((image_key, image_path))
    return registered_items


def build_point_id_sets(images_meta: dict[str, dict], image_keys: list[str]) -> dict[str, set[int]]:
    point_ids_by_image: dict[str, set[int]] = {}
    for image_key in image_keys:
        image_entry = images_meta.get(image_key, {})
        point_ids_by_image[image_key] = {
            int(point_entry.get('point3DId', -1))
            for point_entry in image_entry.get('points2D', [])
            if int(point_entry.get('point3DId', -1)) > 0
        }
    return point_ids_by_image


def build_topology_clusters(image_keys: list[str], images_meta: dict[str, dict]) -> list[tuple[str, ...]]:
    image_count = len(image_keys)
    if image_count <= 1:
        return []
    if image_count <= DEFAULT_FAST3R_PRIOR_GLOBAL_MAX_IMAGES:
        return [tuple(image_keys)]

    cluster_size = min(image_count, max(DEFAULT_FAST3R_PRIOR_CLUSTER_SIZE, 4))
    minimum_cluster_size = min(image_count, 4)
    point_ids_by_image = build_point_id_sets(images_meta, image_keys)
    index_by_key = {image_key: index for index, image_key in enumerate(image_keys)}
    shared_counts: dict[str, dict[str, int]] = defaultdict(dict)

    for left_index, left_key in enumerate(image_keys):
        left_points = point_ids_by_image.get(left_key, set())
        if not left_points:
            continue
        for right_key in image_keys[left_index + 1:]:
            shared_point_count = len(left_points & point_ids_by_image.get(right_key, set()))
            if shared_point_count <= 0:
                continue
            shared_counts[left_key][right_key] = shared_point_count
            shared_counts[right_key][left_key] = shared_point_count

    clusters: list[tuple[str, ...]] = []
    seen_clusters: set[tuple[str, ...]] = set()

    def add_cluster(cluster_keys) -> None:
        ordered_cluster = tuple(image_key for image_key in image_keys if image_key in set(cluster_keys))
        if len(ordered_cluster) < minimum_cluster_size:
            return
        if ordered_cluster in seen_clusters:
            return
        seen_clusters.add(ordered_cluster)
        clusters.append(ordered_cluster)

    for image_key in image_keys:
        selected = [image_key]
        ranked_neighbors = sorted(
            (
                (
                    -int(shared_counts.get(image_key, {}).get(candidate_key, 0)),
                    abs(index_by_key[candidate_key] - index_by_key[image_key]),
                    candidate_key,
                )
                for candidate_key in image_keys
                if candidate_key != image_key
            ),
        )

        for negative_shared_count, _, candidate_key in ranked_neighbors:
            if -negative_shared_count <= 0:
                continue
            if candidate_key in selected:
                continue
            selected.append(candidate_key)
            if len(selected) >= cluster_size:
                break

        if len(selected) < cluster_size:
            sequential_neighbors = sorted(
                (
                    (
                        abs(index_by_key[candidate_key] - index_by_key[image_key]),
                        candidate_key,
                    )
                    for candidate_key in image_keys
                    if candidate_key not in selected
                ),
            )
            for _, candidate_key in sequential_neighbors:
                selected.append(candidate_key)
                if len(selected) >= cluster_size:
                    break

        add_cluster(selected)

    for window_indices in build_fast3r_window_indices(image_count, cluster_size):
        add_cluster(image_keys[index] for index in window_indices)

    if not clusters:
        add_cluster(image_keys)

    return clusters


def resolve_fast3r_device(gpu_indices: str | None):
    import torch

    if not torch.cuda.is_available():
        return torch.device('cpu')

    if gpu_indices:
        primary_gpu = str(gpu_indices).split(',')[0].strip()
        if primary_gpu:
            return torch.device(f'cuda:{primary_gpu}')

    return torch.device('cuda:0')


def sample_cluster_alignment_anchors(
    *,
    cluster_keys: tuple[str, ...],
    cluster_variants: dict[str, dict],
    images_meta: dict[str, dict],
    cameras: dict[int, dict],
    points_by_id: dict[int, dict],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    source_points = []
    target_points = []
    weights = []

    for image_key in cluster_keys:
        cluster_variant = cluster_variants.get(image_key)
        image_entry = images_meta.get(image_key)
        if cluster_variant is None or image_entry is None:
            continue

        camera = cameras.get(image_entry['cam_id'])
        if camera is None:
            continue

        anchor_entries = [
            point_entry
            for point_entry in image_entry.get('points2D', [])
            if int(point_entry.get('point3DId', -1)) > 0 and int(point_entry.get('point3DId', -1)) in points_by_id
        ]
        if not anchor_entries:
            continue

        keypoints = np.asarray([point_entry['xy'] for point_entry in anchor_entries], dtype=np.float32)
        sampled_points = sample_dense_map_values(
            cluster_variant['pointmap'],
            keypoints,
            (int(camera['width']), int(camera['height'])),
        )
        sampled_confidence = sample_dense_map_values(
            cluster_variant['confidence'],
            keypoints,
            (int(camera['width']), int(camera['height'])),
        ).reshape(-1)

        for anchor_index, point_entry in enumerate(anchor_entries):
            sampled_point = np.asarray(sampled_points[anchor_index], dtype=np.float64).reshape(-1)
            if sampled_point.size != 3 or not np.all(np.isfinite(sampled_point)):
                continue

            confidence = float(sampled_confidence[anchor_index]) if anchor_index < sampled_confidence.shape[0] else 0.0
            if not np.isfinite(confidence) or confidence <= 0.0:
                continue

            point_id = int(point_entry.get('point3DId', -1))
            source_points.append(sampled_point)
            target_points.append(np.asarray(points_by_id[point_id]['xyz'], dtype=np.float64).reshape(3))
            weights.append(confidence)

    if not source_points:
        return (
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0,), dtype=np.float64),
        )

    return (
        np.asarray(source_points, dtype=np.float64),
        np.asarray(target_points, dtype=np.float64),
        np.asarray(weights, dtype=np.float64),
    )


def fit_cluster_similarity_transform(
    *,
    source_points: np.ndarray,
    target_points: np.ndarray,
    weights: np.ndarray,
    scene_diagonal: float,
) -> tuple[dict | None, dict]:
    if source_points.shape[0] < MIN_LEARNED_POINTMAP_ANCHORS:
        return None, {
            'accepted': False,
            'anchorCount': int(source_points.shape[0]),
            'medianAnchorError': None,
            'p90AnchorError': None,
        }

    ranked_anchor_indices = np.argsort(-weights)[: min(weights.shape[0], 4096)]
    transform = estimate_similarity_transform(
        source_points[ranked_anchor_indices],
        target_points[ranked_anchor_indices],
        weights=weights[ranked_anchor_indices],
    )
    if transform is None:
        return None, {
            'accepted': False,
            'anchorCount': int(source_points.shape[0]),
            'medianAnchorError': None,
            'p90AnchorError': None,
        }

    aligned_anchor_points = apply_similarity_transform(source_points, transform)
    anchor_errors = np.linalg.norm(aligned_anchor_points - target_points, axis=1)
    finite_anchor_errors = anchor_errors[np.isfinite(anchor_errors)]
    if finite_anchor_errors.size < MIN_LEARNED_POINTMAP_ANCHORS:
        return None, {
            'accepted': False,
            'anchorCount': int(finite_anchor_errors.size),
            'medianAnchorError': None,
            'p90AnchorError': None,
        }

    median_anchor_error = float(np.median(finite_anchor_errors))
    p90_anchor_error = float(np.percentile(finite_anchor_errors, 90))
    median_error_limit = max(
        scene_diagonal * LEARNED_POINTMAP_ANCHOR_MEDIAN_ERROR_RATIO,
        LEARNED_POINTMAP_ANCHOR_MIN_MEDIAN_ERROR,
    )
    p90_error_limit = max(
        scene_diagonal * LEARNED_POINTMAP_ANCHOR_P90_ERROR_RATIO,
        LEARNED_POINTMAP_ANCHOR_MIN_P90_ERROR,
    )
    if median_anchor_error > median_error_limit or p90_anchor_error > p90_error_limit:
        return None, {
            'accepted': False,
            'anchorCount': int(finite_anchor_errors.size),
            'medianAnchorError': median_anchor_error,
            'p90AnchorError': p90_anchor_error,
        }

    inlier_threshold = min(p90_error_limit, max(median_anchor_error * 3.0, LEARNED_POINTMAP_ANCHOR_MIN_P90_ERROR))
    inlier_mask = np.isfinite(anchor_errors) & (anchor_errors <= inlier_threshold)
    if int(inlier_mask.sum()) >= MIN_LEARNED_POINTMAP_ANCHORS:
        refined_transform = estimate_similarity_transform(
            source_points[inlier_mask],
            target_points[inlier_mask],
            weights=weights[inlier_mask],
        )
        if refined_transform is not None:
            transform = refined_transform
            refined_anchor_points = apply_similarity_transform(source_points[inlier_mask], transform)
            refined_anchor_errors = np.linalg.norm(refined_anchor_points - target_points[inlier_mask], axis=1)
            if refined_anchor_errors.size:
                median_anchor_error = float(np.median(refined_anchor_errors))
                p90_anchor_error = float(np.percentile(refined_anchor_errors, 90))

    return transform, {
        'accepted': True,
        'anchorCount': int(source_points.shape[0]),
        'medianAnchorError': median_anchor_error,
        'p90AnchorError': p90_anchor_error,
    }


def initialize_fusion_state(
    registered_items: list[tuple[str, Path]],
    images_meta: dict[str, dict],
    cameras: dict[int, dict],
) -> dict[str, dict]:
    fusion_state: dict[str, dict] = {}
    for image_key, _ in registered_items:
        image_entry = images_meta[image_key]
        camera = cameras[image_entry['cam_id']]
        height = int(camera['height'])
        width = int(camera['width'])
        fusion_state[image_key] = {
            'depth_sum': np.zeros((height, width), dtype=np.float32),
            'weight_sum': np.zeros((height, width), dtype=np.float32),
            'support_count': np.zeros((height, width), dtype=np.uint16),
            'clusterVoteCount': 0,
            'projectedPointCount': 0,
        }
    return fusion_state


def accumulate_cluster_votes(
    *,
    cluster_keys: tuple[str, ...],
    cluster_variants: dict[str, dict],
    transform: dict,
    images_meta: dict[str, dict],
    cameras: dict[int, dict],
    fusion_state: dict[str, dict],
) -> dict[str, int]:
    accepted_images = 0
    accepted_points = 0

    for image_key in cluster_keys:
        cluster_variant = cluster_variants.get(image_key)
        image_entry = images_meta.get(image_key)
        image_fusion_state = fusion_state.get(image_key)
        if cluster_variant is None or image_entry is None or image_fusion_state is None:
            continue

        camera = cameras.get(image_entry['cam_id'])
        if camera is None:
            continue

        pointmap = np.asarray(cluster_variant['pointmap'], dtype=np.float32)
        confidence_map = np.asarray(cluster_variant['confidence'], dtype=np.float32)
        valid_mask = np.isfinite(pointmap).all(axis=-1) & np.isfinite(confidence_map) & (confidence_map > 0.0)
        if not np.any(valid_mask):
            continue

        valid_confidence = confidence_map[valid_mask]
        confidence_threshold = float(np.percentile(valid_confidence, DEFAULT_FAST3R_PRIOR_CONFIDENCE_PERCENTILE))
        selected_mask = valid_mask & (confidence_map >= confidence_threshold)
        ys, xs = np.nonzero(selected_mask)
        if ys.size == 0:
            continue

        if ys.size > DEFAULT_FAST3R_PRIOR_MAX_POINTS_PER_VIEW:
            selected_confidence = confidence_map[ys, xs]
            keep_indices = np.argpartition(selected_confidence, -DEFAULT_FAST3R_PRIOR_MAX_POINTS_PER_VIEW)[-DEFAULT_FAST3R_PRIOR_MAX_POINTS_PER_VIEW:]
            ys = ys[keep_indices]
            xs = xs[keep_indices]

        local_points = np.asarray(pointmap[ys, xs], dtype=np.float64).reshape(-1, 3)
        world_points = apply_similarity_transform(local_points, transform)
        projected_points, camera_depth = project_world_points_to_image(world_points, camera, image_entry)

        dense_height, dense_width = pointmap.shape[:2]
        source_pixels = np.stack([
            xs.astype(np.float64) * max(float(camera['width'] - 1), 1.0) / max(float(dense_width - 1), 1.0),
            ys.astype(np.float64) * max(float(camera['height'] - 1), 1.0) / max(float(dense_height - 1), 1.0),
        ], axis=-1)
        reprojection_error = np.linalg.norm(projected_points - source_pixels, axis=1)
        valid_projection = (
            np.isfinite(world_points).all(axis=1)
            & np.isfinite(projected_points).all(axis=1)
            & np.isfinite(camera_depth)
            & (camera_depth > 0.05)
        )
        if FAST3R_PRIOR_REQUIRE_REPROJECTION:
            valid_projection &= np.isfinite(reprojection_error) & (reprojection_error <= LEARNED_POINTMAP_MAX_REPROJECTION_ERROR_PX)
        if not np.any(valid_projection):
            continue

        projected_points = projected_points[valid_projection]
        camera_depth = np.asarray(camera_depth[valid_projection], dtype=np.float32)
        confidence = np.asarray(confidence_map[ys, xs][valid_projection], dtype=np.float32)

        pixel_x = np.clip(np.rint(projected_points[:, 0]), 0, int(camera['width']) - 1).astype(np.int64)
        pixel_y = np.clip(np.rint(projected_points[:, 1]), 0, int(camera['height']) - 1).astype(np.int64)
        flat_indices = (pixel_y * int(camera['width'])) + pixel_x

        np.add.at(image_fusion_state['depth_sum'].reshape(-1), flat_indices, camera_depth * confidence)
        np.add.at(image_fusion_state['weight_sum'].reshape(-1), flat_indices, confidence)
        np.add.at(image_fusion_state['support_count'].reshape(-1), flat_indices, 1)
        image_fusion_state['clusterVoteCount'] += 1
        image_fusion_state['projectedPointCount'] += int(camera_depth.shape[0])
        accepted_images += 1
        accepted_points += int(camera_depth.shape[0])

    return {
        'acceptedImageCount': accepted_images,
        'acceptedPointCount': accepted_points,
    }


def finalize_fused_priors(
    *,
    images_dir: Path,
    output_dir: Path,
    registered_items: list[tuple[str, Path]],
    fusion_state: dict[str, dict],
) -> tuple[list[dict], list[dict], list[dict], int]:
    depth_maps_dir = output_dir / 'stereo' / 'depth_maps'
    normal_maps_dir = output_dir / 'stereo' / 'normal_maps'
    depth_maps_dir.mkdir(parents=True, exist_ok=True)
    normal_maps_dir.mkdir(parents=True, exist_ok=True)

    depth_maps = []
    normal_maps = []
    image_summaries = []
    generated_count = 0

    for image_key, image_path in registered_items:
        image_fusion_state = fusion_state[image_key]
        valid_mask = image_fusion_state['weight_sum'] > 0.0
        if not np.any(valid_mask):
            image_summaries.append({
                'image': image_key,
                'generated': False,
                'coverageRatio': 0.0,
                'clusterVoteCount': int(image_fusion_state['clusterVoteCount']),
                'projectedPointCount': int(image_fusion_state['projectedPointCount']),
            })
            continue

        depth = np.divide(
            image_fusion_state['depth_sum'],
            image_fusion_state['weight_sum'],
            out=np.zeros_like(image_fusion_state['depth_sum']),
            where=valid_mask,
        ).astype(np.float32, copy=False)
        depth = np.where(valid_mask, depth, 0.0).astype(np.float32, copy=False)
        normals = compute_normals_from_depth(depth)

        relative_image_path = image_path.relative_to(images_dir)
        depth_output_path = depth_maps_dir / relative_image_path.parent / f'{relative_image_path.name}.photometric.bin'
        normal_output_path = normal_maps_dir / relative_image_path.parent / f'{relative_image_path.name}.photometric.bin'
        save_colmap_depth_map(depth, depth_output_path)
        save_colmap_normal_map(normals, normal_output_path)

        valid_depth = depth[valid_mask]
        image_summary = {
            'image': image_key,
            'generated': True,
            'coverageRatio': float(valid_mask.mean()),
            'clusterVoteCount': int(image_fusion_state['clusterVoteCount']),
            'projectedPointCount': int(image_fusion_state['projectedPointCount']),
            'depthRange': [float(valid_depth.min()), float(valid_depth.max())],
            'depthFile': str(depth_output_path),
            'normalFile': str(normal_output_path),
        }
        depth_maps.append({
            'image': image_key,
            'depth_file': str(depth_output_path),
            'depth_range': image_summary['depthRange'],
        })
        normal_maps.append({
            'image': image_key,
            'normal_file': str(normal_output_path),
        })
        image_summaries.append(image_summary)
        generated_count += 1

    return depth_maps, normal_maps, image_summaries, generated_count


def generate_fast3r_depth_priors(
    images_dir: Path,
    output_dir: Path,
    sparse_model_dir: Path,
    colmap_path: str,
    gpu_indices: str | None = None,
    image_size: int = DEFAULT_FAST3R_PRIOR_IMAGE_SIZE,
) -> dict:
    images_dir = Path(images_dir)
    output_dir = Path(output_dir)
    sparse_model_dir = Path(sparse_model_dir)

    text_model_dir = ensure_text_model(sparse_model_dir, colmap_path)
    cameras = parse_colmap_cameras_txt(text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')
    points_by_id = parse_colmap_points_lookup(text_model_dir / 'points3D.txt')
    if not cameras or not images_meta or not points_by_id:
        raise RuntimeError('Fast3R depth priors need a COLMAP text model with cameras, images, and sparse points')

    registered_items = build_registered_image_items(images_dir, images_meta)
    if len(registered_items) < 2:
        raise RuntimeError('Fast3R depth priors need at least two registered undistorted images')

    scene_points = np.asarray([point_data['xyz'] for point_data in points_by_id.values()], dtype=np.float64)
    scene_diagonal = compute_scene_diagonal(scene_points)
    clusters = build_topology_clusters([image_key for image_key, _ in registered_items], images_meta)
    if not clusters:
        raise RuntimeError('No Fast3R prior clusters could be constructed from the sparse model')

    device = resolve_fast3r_device(gpu_indices)
    model = load_fast3r_model(device)
    path_by_key = {image_key: image_path for image_key, image_path in registered_items}
    fusion_state = initialize_fusion_state(registered_items, images_meta, cameras)
    cluster_summaries = []
    accepted_cluster_count = 0

    for cluster_index, cluster_keys in enumerate(clusters):
        cluster_image_paths = [path_by_key[image_key] for image_key in cluster_keys if image_key in path_by_key]
        if len(cluster_image_paths) < 2:
            cluster_summaries.append({
                'clusterIndex': cluster_index,
                'images': list(cluster_keys),
                'accepted': False,
                'reason': 'insufficient_registered_images',
            })
            continue

        inference_output = run_fast3r_inference(
            model,
            cluster_image_paths,
            f'dense_prior_cluster_{cluster_index:03d}',
            image_size,
            device,
        )
        cluster_variants = {}
        for image_key, view, pred in zip(cluster_keys, inference_output['views'], inference_output['preds']):
            preferred_variant = select_preferred_fast3r_variant(view, pred)
            cluster_variants[image_key] = {
                'variantName': preferred_variant['name'],
                'pointmap': np.asarray(preferred_variant['pointmap'], dtype=np.float32),
                'confidence': np.asarray(preferred_variant['confidence'], dtype=np.float32),
            }

        source_points, target_points, weights = sample_cluster_alignment_anchors(
            cluster_keys=cluster_keys,
            cluster_variants=cluster_variants,
            images_meta=images_meta,
            cameras=cameras,
            points_by_id=points_by_id,
        )
        transform, alignment_summary = fit_cluster_similarity_transform(
            source_points=source_points,
            target_points=target_points,
            weights=weights,
            scene_diagonal=scene_diagonal,
        )
        if transform is None:
            cluster_summaries.append({
                'clusterIndex': cluster_index,
                'images': list(cluster_keys),
                'accepted': False,
                'reason': 'cluster_alignment_rejected',
                **alignment_summary,
            })
            continue

        cluster_vote_summary = accumulate_cluster_votes(
            cluster_keys=cluster_keys,
            cluster_variants=cluster_variants,
            transform=transform,
            images_meta=images_meta,
            cameras=cameras,
            fusion_state=fusion_state,
        )
        cluster_summaries.append({
            'clusterIndex': cluster_index,
            'images': list(cluster_keys),
            'accepted': True,
            'transformScale': float(transform['scale']),
            'acceptedImageCount': int(cluster_vote_summary['acceptedImageCount']),
            'acceptedPointCount': int(cluster_vote_summary['acceptedPointCount']),
            **alignment_summary,
        })
        accepted_cluster_count += 1

    depth_maps, normal_maps, image_summaries, generated_count = finalize_fused_priors(
        images_dir=images_dir,
        output_dir=output_dir,
        registered_items=registered_items,
        fusion_state=fusion_state,
    )

    if generated_count == 0:
        raise RuntimeError('fast3r_dense_priors_missing_for_dense_stereo')

    result = {
        'source': 'fast3r',
        'num_images': len(registered_items),
        'generatedImageCount': generated_count,
        'clusterMode': 'global' if len(clusters) == 1 and len(clusters[0]) == len(registered_items) else 'clustered',
        'imageSize': int(image_size),
        'globalMaxImages': int(DEFAULT_FAST3R_PRIOR_GLOBAL_MAX_IMAGES),
        'clusterSize': int(min(len(registered_items), max(DEFAULT_FAST3R_PRIOR_CLUSTER_SIZE, 4))),
        'clusterCount': len(clusters),
        'acceptedClusterCount': accepted_cluster_count,
        'clusters': cluster_summaries,
        'depth_maps': depth_maps,
        'normal_maps': normal_maps,
        'images': image_summaries,
        'textModelDir': str(text_model_dir),
    }
    manifest_path = output_dir / 'fast3r_depth_priors_manifest.json'
    manifest_path.write_text(json.dumps(result, indent=2), encoding='utf-8')
    result['manifestPath'] = str(manifest_path)
    return result
