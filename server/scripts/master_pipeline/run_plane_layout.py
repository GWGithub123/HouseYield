#!/usr/bin/env python3
"""Infer a plane-aware room layout for master_v1.

This worker converts the dense evidence cloud into a compact structural layout:
- detects dominant planes from the fused evidence cloud
- infers a stable up axis from the best opposing plane pair when available
- synthesizes floor, ceiling, and four wall planes from the solved room bounds

The first-pass layout intentionally prefers clean structural planes over noisy
surface detail so later meshing stages can preserve blank walls instead of
locking in Poisson/MVS wall artifacts.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    import open3d as o3d
except ImportError as exc:  # pragma: no cover - environment-dependent
    raise RuntimeError('Open3D is required for plane layout inference') from exc


MAX_PLANES = 12
MIN_PLANE_POINTS = 400


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def normalize(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm < 1e-8:
        raise ValueError('zero_length_vector')
    return vector / norm


def orthonormal_basis(up_axis: np.ndarray, hint_axis: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    if hint_axis is not None:
        projected = hint_axis - (np.dot(hint_axis, up_axis) * up_axis)
        if np.linalg.norm(projected) > 1e-6:
            u_axis = normalize(projected)
            return u_axis, normalize(np.cross(up_axis, u_axis))

    arbitrary = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    if abs(np.dot(arbitrary, up_axis)) > 0.9:
        arbitrary = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    u_axis = normalize(np.cross(up_axis, arbitrary))
    v_axis = normalize(np.cross(up_axis, u_axis))
    return u_axis, v_axis


def build_room_box_cloud() -> np.ndarray:
    width = 4.6
    depth = 6.2
    height = 2.7
    samples_u = np.linspace(-width / 2, width / 2, 48, dtype=np.float32)
    samples_v = np.linspace(-depth / 2, depth / 2, 64, dtype=np.float32)
    samples_h = np.linspace(0.0, height, 40, dtype=np.float32)

    points = []
    for u in samples_u:
        for v in samples_v:
            points.append([u, 0.0, v])
            points.append([u, height, v])
    for h in samples_h:
        for v in samples_v:
            points.append([-width / 2, h, v])
            points.append([width / 2, h, v])
        for u in samples_u:
            points.append([u, h, -depth / 2])
            points.append([u, h, depth / 2])

    cloud = np.asarray(points, dtype=np.float32)
    noise = np.random.default_rng(13).normal(0.0, 0.003, size=cloud.shape).astype(np.float32)
    return cloud + noise


def load_dense_points(dense_evidence_dir: Path, dry_run: bool) -> np.ndarray:
    if dry_run:
        return build_room_box_cloud()

    points_path = dense_evidence_dir / 'points.npy'
    if not points_path.exists():
        raise FileNotFoundError(f'dense evidence points missing: {points_path}')

    points = np.load(points_path).astype(np.float32)
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError('dense_evidence_points_invalid_shape')
    if points.shape[0] < MIN_PLANE_POINTS:
        raise ValueError(f'dense_evidence_point_count_too_low:{points.shape[0]}')

    return points


def point_cloud_scale(points: np.ndarray) -> float:
    mins = points.min(axis=0)
    maxs = points.max(axis=0)
    return float(np.linalg.norm(maxs - mins))


def detect_planes(points: np.ndarray) -> list[dict]:
    cloud = o3d.geometry.PointCloud()
    cloud.points = o3d.utility.Vector3dVector(points)

    diagonal = point_cloud_scale(points)
    distance_threshold = max(0.02, diagonal * 0.0075)
    remaining_cloud = cloud
    remaining_indices = np.arange(points.shape[0])
    planes: list[dict] = []

    for plane_index in range(MAX_PLANES):
        if len(remaining_cloud.points) < MIN_PLANE_POINTS:
            break

        plane_model, inliers = remaining_cloud.segment_plane(
            distance_threshold=distance_threshold,
            ransac_n=3,
            num_iterations=2000,
        )

        inliers = np.asarray(inliers, dtype=np.int32)
        if inliers.size < MIN_PLANE_POINTS:
            break

        full_indices = remaining_indices[inliers]
        plane_points = points[full_indices]
        normal = normalize(np.asarray(plane_model[:3], dtype=np.float32))
        offset = float(plane_model[3])
        centroid = plane_points.mean(axis=0)
        residuals = np.abs((plane_points @ normal) + offset)

        planes.append({
            'id': f'detected_plane_{plane_index + 1}',
            'normal': normal,
            'offset': offset,
            'centroid': centroid.astype(np.float32),
            'supportCount': int(inliers.size),
            'rmsError': float(np.sqrt(np.mean(residuals ** 2))),
            'indices': full_indices,
        })

        keep_mask = np.ones(len(remaining_cloud.points), dtype=bool)
        keep_mask[inliers] = False
        remaining_indices = remaining_indices[keep_mask]
        remaining_cloud = remaining_cloud.select_by_index(inliers.tolist(), invert=True)

    return planes


def infer_up_axis(points: np.ndarray, planes: list[dict]) -> tuple[np.ndarray, dict]:
    best_pair = None
    best_score = -1.0

    for left_index in range(len(planes)):
        for right_index in range(left_index + 1, len(planes)):
            left = planes[left_index]
            right = planes[right_index]
            alignment = abs(float(np.dot(left['normal'], right['normal'])))
            if alignment < 0.94:
                continue

            separation = abs(float(np.dot(right['centroid'] - left['centroid'], left['normal'])))
            if separation < 1.8:
                continue

            support_total = left['supportCount'] + right['supportCount']
            height_prior_score = max(0.0, 1.0 - (abs(separation - 2.7) / 1.8))
            score = support_total * (1.0 + (3.0 * height_prior_score))
            if score > best_score:
                best_score = score
                best_pair = (left, right, separation)

    if best_pair is not None:
        left, right, separation = best_pair
        up_axis = normalize(left['normal'])
        left_projection = float(np.median(points[left['indices']] @ up_axis))
        right_projection = float(np.median(points[right['indices']] @ up_axis))
        if left_projection > right_projection:
            up_axis = -up_axis
            left_projection, right_projection = right_projection, left_projection
            left, right = right, left

        return up_axis, {
            'source': 'opposing_plane_pair',
            'floorPlaneId': left['id'],
            'ceilingPlaneId': right['id'],
            'pairAlignment': round(abs(float(np.dot(left['normal'], right['normal']))), 5),
            'pairSeparation': round(separation, 5),
        }

    centered = points - points.mean(axis=0)
    covariance = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    up_axis = normalize(eigenvectors[:, np.argmin(eigenvalues)].astype(np.float32))
    projections = points @ up_axis
    if float(np.percentile(projections, 50)) < 0:
        up_axis = -up_axis

    return up_axis, {
        'source': 'pca_smallest_variance_axis',
        'floorPlaneId': None,
        'ceilingPlaneId': None,
        'pairAlignment': None,
        'pairSeparation': None,
    }


def classify_detected_plane(plane: dict, up_axis: np.ndarray, floor_height: float, ceiling_height: float) -> str:
    vertical_alignment = abs(float(np.dot(plane['normal'], up_axis)))
    projection = float(np.median(plane['centroid'] @ up_axis))
    if vertical_alignment >= 0.88:
        if abs(projection - floor_height) <= abs(projection - ceiling_height):
            return 'floor_like'
        return 'ceiling_like'
    if vertical_alignment <= 0.25:
        return 'wall_like'
    return 'oblique'


def solve_room_bounds(points: np.ndarray, up_axis: np.ndarray) -> dict:
    projections_up = points @ up_axis
    floor_height = float(np.percentile(projections_up, 1.5))
    ceiling_height = float(np.percentile(projections_up, 98.5))
    room_height = ceiling_height - floor_height
    if room_height <= 1.6:
        floor_height = float(np.min(projections_up))
        ceiling_height = float(np.max(projections_up))
        room_height = ceiling_height - floor_height

    planar_points = points - np.outer(projections_up, up_axis)
    centered = planar_points - planar_points.mean(axis=0)
    covariance = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    horizontal_order = np.argsort(eigenvalues)[::-1]
    u_hint = eigenvectors[:, horizontal_order[0]].astype(np.float32)
    u_axis, v_axis = orthonormal_basis(up_axis, u_hint)

    u_coords = points @ u_axis
    v_coords = points @ v_axis
    u_min = float(np.percentile(u_coords, 1.0))
    u_max = float(np.percentile(u_coords, 99.0))
    v_min = float(np.percentile(v_coords, 1.0))
    v_max = float(np.percentile(v_coords, 99.0))

    padding = max(0.03, 0.02 * max(u_max - u_min, v_max - v_min))
    u_min -= padding
    u_max += padding
    v_min -= padding
    v_max += padding

    footprint_uv = [
        [u_min, v_min],
        [u_max, v_min],
        [u_max, v_max],
        [u_min, v_max],
    ]

    def point_from_uvh(u_value: float, v_value: float, h_value: float) -> list[float]:
        point = (u_axis * u_value) + (v_axis * v_value) + (up_axis * h_value)
        return [round(float(value), 6) for value in point]

    floor_corners = [point_from_uvh(u_value, v_value, floor_height) for u_value, v_value in footprint_uv]
    ceiling_corners = [point_from_uvh(u_value, v_value, ceiling_height) for u_value, v_value in footprint_uv]

    return {
        'upAxis': [round(float(value), 6) for value in up_axis],
        'uAxis': [round(float(value), 6) for value in u_axis],
        'vAxis': [round(float(value), 6) for value in v_axis],
        'floorHeight': round(floor_height, 6),
        'ceilingHeight': round(ceiling_height, 6),
        'height': round(room_height, 6),
        'width': round(u_max - u_min, 6),
        'depth': round(v_max - v_min, 6),
        'uMin': round(u_min, 6),
        'uMax': round(u_max, 6),
        'vMin': round(v_min, 6),
        'vMax': round(v_max, 6),
        'footprintUv': [[round(float(value), 6) for value in pair] for pair in footprint_uv],
        'floorCorners': floor_corners,
        'ceilingCorners': ceiling_corners,
    }


def synthesize_layout_planes(room_bounds: dict) -> list[dict]:
    up_axis = np.asarray(room_bounds['upAxis'], dtype=np.float32)
    u_axis = np.asarray(room_bounds['uAxis'], dtype=np.float32)
    v_axis = np.asarray(room_bounds['vAxis'], dtype=np.float32)

    u_min = room_bounds['uMin']
    u_max = room_bounds['uMax']
    v_min = room_bounds['vMin']
    v_max = room_bounds['vMax']
    floor_height = room_bounds['floorHeight']
    ceiling_height = room_bounds['ceilingHeight']

    def wall_corners(axis_value: float, axis: str) -> list[list[float]]:
        if axis == 'u':
            return [
                ((u_axis * axis_value) + (v_axis * v_min) + (up_axis * floor_height)).tolist(),
                ((u_axis * axis_value) + (v_axis * v_max) + (up_axis * floor_height)).tolist(),
                ((u_axis * axis_value) + (v_axis * v_max) + (up_axis * ceiling_height)).tolist(),
                ((u_axis * axis_value) + (v_axis * v_min) + (up_axis * ceiling_height)).tolist(),
            ]
        return [
            ((u_axis * u_min) + (v_axis * axis_value) + (up_axis * floor_height)).tolist(),
            ((u_axis * u_max) + (v_axis * axis_value) + (up_axis * floor_height)).tolist(),
            ((u_axis * u_max) + (v_axis * axis_value) + (up_axis * ceiling_height)).tolist(),
            ((u_axis * u_min) + (v_axis * axis_value) + (up_axis * ceiling_height)).tolist(),
        ]

    def rounded_corners(raw_corners: list[list[float]]) -> list[list[float]]:
        return [[round(float(value), 6) for value in corner] for corner in raw_corners]

    return [
        {
            'id': 'floor',
            'type': 'floor',
            'normal': [round(float(value), 6) for value in up_axis],
            'corners': room_bounds['floorCorners'],
            'height': floor_height,
        },
        {
            'id': 'ceiling',
            'type': 'ceiling',
            'normal': [round(float(value), 6) for value in (-up_axis)],
            'corners': room_bounds['ceilingCorners'],
            'height': ceiling_height,
        },
        {
            'id': 'wall_west',
            'type': 'wall',
            'normal': [round(float(value), 6) for value in u_axis],
            'corners': rounded_corners(wall_corners(u_min, 'u')),
            'boundAxis': 'u',
            'boundValue': u_min,
        },
        {
            'id': 'wall_east',
            'type': 'wall',
            'normal': [round(float(value), 6) for value in (-u_axis)],
            'corners': rounded_corners(wall_corners(u_max, 'u')),
            'boundAxis': 'u',
            'boundValue': u_max,
        },
        {
            'id': 'wall_south',
            'type': 'wall',
            'normal': [round(float(value), 6) for value in v_axis],
            'corners': rounded_corners(wall_corners(v_min, 'v')),
            'boundAxis': 'v',
            'boundValue': v_min,
        },
        {
            'id': 'wall_north',
            'type': 'wall',
            'normal': [round(float(value), 6) for value in (-v_axis)],
            'corners': rounded_corners(wall_corners(v_max, 'v')),
            'boundAxis': 'v',
            'boundValue': v_max,
        },
    ]


def solve_plane_layout(job_id: str, dense_evidence_dir: Path, output_dir: Path, dry_run: bool) -> dict:
    points = load_dense_points(dense_evidence_dir, dry_run=dry_run)
    planes = detect_planes(points)
    if not planes:
        raise RuntimeError('plane_layout_detected_no_planes')

    up_axis, axis_metadata = infer_up_axis(points, planes)
    room_bounds = solve_room_bounds(points, up_axis)
    up_axis = np.asarray(room_bounds['upAxis'], dtype=np.float32)

    detected_planes = []
    for plane in planes:
        detected_planes.append({
            'id': plane['id'],
            'type': classify_detected_plane(plane, up_axis, room_bounds['floorHeight'], room_bounds['ceilingHeight']),
            'normal': [round(float(value), 6) for value in plane['normal']],
            'offset': round(float(plane['offset']), 6),
            'centroid': [round(float(value), 6) for value in plane['centroid']],
            'supportCount': plane['supportCount'],
            'rmsError': round(float(plane['rmsError']), 6),
        })

    layout_planes = synthesize_layout_planes(room_bounds)

    layout = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'axisInference': axis_metadata,
        'roomBounds': room_bounds,
        'layoutPlanes': layout_planes,
        'detectedPlanes': detected_planes,
        'note': 'Wall planes are synthesized from the solved room box so blank walls remain clean even when dense evidence is sparse or blotchy.',
    }

    write_json(output_dir / 'layout.json', layout)
    summary = {
        'jobId': job_id,
        'createdAt': layout['createdAt'],
        'dryRun': dry_run,
        'inputPointCount': int(points.shape[0]),
        'detectedPlaneCount': len(detected_planes),
        'layoutPlaneCount': len(layout_planes),
        'axisInference': axis_metadata['source'],
        'roomHeight': room_bounds['height'],
        'roomWidth': room_bounds['width'],
        'roomDepth': room_bounds['depth'],
        'note': 'First-pass layout solves a structural room box for downstream shell meshing and conservative opening detection.',
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 plane layout inference')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--dense-evidence-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    dense_evidence_dir = Path(args.dense_evidence_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    summary = solve_plane_layout(args.job_id, dense_evidence_dir, output_dir, dry_run=args.dry_run)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()