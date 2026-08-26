#!/usr/bin/env python3
"""Detect conservative opening candidates from a solved room layout.

The detector projects dense evidence onto each synthesized wall plane and only
accepts voids that are bounded by surrounding support. This keeps blank walls
solid unless the evidence for a doorway/window-shaped opening is strong.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def normalize(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm < 1e-8:
        raise ValueError('zero_length_vector')
    return vector / norm


def load_dense_points(dense_evidence_dir: Path, layout: dict, dry_run: bool) -> np.ndarray:
    if dry_run:
        return build_synthetic_opening_cloud(layout)

    points_path = dense_evidence_dir / 'points.npy'
    if not points_path.exists():
        raise FileNotFoundError(f'dense evidence points missing: {points_path}')
    return np.load(points_path).astype(np.float32)


def build_synthetic_opening_cloud(layout: dict) -> np.ndarray:
    room_bounds = layout['roomBounds']
    up_axis = np.asarray(room_bounds['upAxis'], dtype=np.float32)
    u_axis = np.asarray(room_bounds['uAxis'], dtype=np.float32)
    v_axis = np.asarray(room_bounds['vAxis'], dtype=np.float32)

    floor_height = room_bounds['floorHeight']
    ceiling_height = room_bounds['ceilingHeight']
    u_min = room_bounds['uMin']
    u_max = room_bounds['uMax']
    v_min = room_bounds['vMin']
    v_max = room_bounds['vMax']

    samples_u = np.linspace(u_min, u_max, 72, dtype=np.float32)
    samples_v = np.linspace(v_min, v_max, 80, dtype=np.float32)
    samples_h = np.linspace(floor_height, ceiling_height, 56, dtype=np.float32)
    points = []

    doorway_u0 = (u_min + u_max) * 0.5 - 0.45
    doorway_u1 = doorway_u0 + 0.9
    doorway_h1 = floor_height + 2.05

    for u_value in samples_u:
        for v_value in samples_v:
            points.append(((u_axis * u_value) + (v_axis * v_value) + (up_axis * floor_height)).tolist())
            points.append(((u_axis * u_value) + (v_axis * v_value) + (up_axis * ceiling_height)).tolist())

    for h_value in samples_h:
        for v_value in samples_v:
            points.append(((u_axis * u_min) + (v_axis * v_value) + (up_axis * h_value)).tolist())
            points.append(((u_axis * u_max) + (v_axis * v_value) + (up_axis * h_value)).tolist())
        for u_value in samples_u:
            if not (doorway_u0 <= u_value <= doorway_u1 and h_value <= doorway_h1):
                points.append(((u_axis * u_value) + (v_axis * v_min) + (up_axis * h_value)).tolist())
            points.append(((u_axis * u_value) + (v_axis * v_max) + (up_axis * h_value)).tolist())

    cloud = np.asarray(points, dtype=np.float32)
    noise = np.random.default_rng(21).normal(0.0, 0.002, size=cloud.shape).astype(np.float32)
    return cloud + noise


def wall_frame(wall: dict) -> dict:
    corners = np.asarray(wall['corners'], dtype=np.float32)
    origin = corners[0]
    horizontal_axis = normalize(corners[1] - corners[0])
    vertical_axis = normalize(corners[3] - corners[0])
    normal = normalize(np.asarray(wall['normal'], dtype=np.float32))
    return {
        'origin': origin,
        'horizontalAxis': horizontal_axis,
        'verticalAxis': vertical_axis,
        'normal': normal,
        'width': float(np.linalg.norm(corners[1] - corners[0])),
        'height': float(np.linalg.norm(corners[3] - corners[0])),
    }


def project_points_to_wall(points: np.ndarray, wall: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    frame = wall_frame(wall)
    relative = points - frame['origin']
    depth = relative @ frame['normal']
    u_coords = relative @ frame['horizontalAxis']
    v_coords = relative @ frame['verticalAxis']

    near_plane = np.abs(depth) <= max(0.08, 0.025 * frame['width'])
    within_bounds = (
        (u_coords >= -0.04)
        & (u_coords <= frame['width'] + 0.04)
        & (v_coords >= -0.04)
        & (v_coords <= frame['height'] + 0.04)
    )
    mask = near_plane & within_bounds
    return u_coords[mask], v_coords[mask], depth[mask]


def build_occupancy_grid(u_coords: np.ndarray, v_coords: np.ndarray, width: float, height: float) -> tuple[np.ndarray, float, float]:
    grid_width = max(28, min(160, int(np.ceil(width / 0.08))))
    grid_height = max(28, min(120, int(np.ceil(height / 0.08))))
    occupancy = np.zeros((grid_height, grid_width), dtype=np.uint16)

    if u_coords.size:
        x_index = np.clip((u_coords / max(width, 1e-6) * (grid_width - 1)).astype(np.int32), 0, grid_width - 1)
        y_index = np.clip((v_coords / max(height, 1e-6) * (grid_height - 1)).astype(np.int32), 0, grid_height - 1)
        for xi, yi in zip(x_index, y_index):
            occupancy[grid_height - 1 - yi, xi] += 1

    return occupancy, width / grid_width, height / grid_height


def candidate_confidence(boundary_ratio: float, interior_occupancy: float, area_fill_ratio: float) -> float:
    confidence = 0.35 + (0.45 * boundary_ratio) + (0.2 * (1.0 - interior_occupancy)) + (0.1 * area_fill_ratio)
    return round(float(min(0.99, max(0.0, confidence))), 4)


def detect_openings_for_wall(points: np.ndarray, wall: dict, debug_dir: Path) -> tuple[list[dict], dict]:
    frame = wall_frame(wall)
    u_coords, v_coords, _ = project_points_to_wall(points, wall)
    occupancy_counts, meters_per_x, meters_per_y = build_occupancy_grid(u_coords, v_coords, frame['width'], frame['height'])

    occupied = (occupancy_counts > 0).astype(np.uint8)
    dilated = cv2.dilate(occupied, np.ones((3, 3), dtype=np.uint8), iterations=2)
    void_mask = (1 - dilated).astype(np.uint8)
    void_mask[0, :] = 0
    void_mask[-1, :] = 0
    void_mask[:, 0] = 0
    void_mask[:, -1] = 0

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(void_mask, connectivity=8)
    detections: list[dict] = []

    for label_index in range(1, num_labels):
        x, y, width_cells, height_cells, area = stats[label_index]
        if width_cells <= 1 or height_cells <= 1:
            continue
        if x == 0 or y == 0 or (x + width_cells) >= void_mask.shape[1] or (y + height_cells) >= void_mask.shape[0]:
            continue

        width_m = float(width_cells * meters_per_x)
        height_m = float(height_cells * meters_per_y)
        if width_m < 0.55 or height_m < 0.6:
            continue
        if width_m > frame['width'] * 0.8 or height_m > frame['height'] * 0.85:
            continue

        region_occ = occupied[y:y + height_cells, x:x + width_cells]
        interior_occupancy = float(region_occ.mean()) if region_occ.size else 0.0
        if interior_occupancy > 0.12:
            continue

        border_top = dilated[max(y - 1, 0), x:x + width_cells]
        border_bottom = dilated[min(y + height_cells, dilated.shape[0] - 1), x:x + width_cells]
        border_left = dilated[y:y + height_cells, max(x - 1, 0)]
        border_right = dilated[y:y + height_cells, min(x + width_cells, dilated.shape[1] - 1)]
        boundary_values = np.concatenate([border_top, border_bottom, border_left, border_right])
        boundary_ratio = float(boundary_values.mean()) if boundary_values.size else 0.0
        if boundary_ratio < 0.35:
            continue

        area_fill_ratio = min(1.0, area / max(width_cells * height_cells, 1))
        bottom_m = float((occupied.shape[0] - (y + height_cells)) * meters_per_y)
        center_u = float((x + (width_cells / 2.0)) * meters_per_x)
        center_v = float((occupied.shape[0] - (y + (height_cells / 2.0))) * meters_per_y)
        opening_type = 'opening'
        if bottom_m <= 0.3 and height_m >= 1.45 and (bottom_m + height_m) >= 1.8:
            opening_type = 'doorway'
        elif bottom_m >= 0.45 and height_m >= 0.5:
            opening_type = 'window'

        detections.append({
            'wallId': wall['id'],
            'type': opening_type,
            'confidence': candidate_confidence(boundary_ratio, interior_occupancy, area_fill_ratio),
            'bboxMeters': {
                'uMin': round(float(x * meters_per_x), 6),
                'uMax': round(float((x + width_cells) * meters_per_x), 6),
                'zMin': round(bottom_m, 6),
                'zMax': round(bottom_m + height_m, 6),
                'width': round(width_m, 6),
                'height': round(height_m, 6),
            },
            'centerMeters': {
                'u': round(center_u, 6),
                'z': round(center_v, 6),
            },
            'evidence': {
                'boundaryRatio': round(boundary_ratio, 4),
                'interiorOccupancy': round(interior_occupancy, 4),
                'voidFillRatio': round(area_fill_ratio, 4),
                'sampleCount': int(u_coords.size),
            },
        })

    debug_image = np.repeat((occupied * 255)[:, :, None], 3, axis=2)
    for detection in detections:
        bbox = detection['bboxMeters']
        x0 = int(round((bbox['uMin'] / max(frame['width'], 1e-6)) * (occupied.shape[1] - 1)))
        x1 = int(round((bbox['uMax'] / max(frame['width'], 1e-6)) * (occupied.shape[1] - 1)))
        y1 = int(round(occupied.shape[0] - ((bbox['zMin'] / max(frame['height'], 1e-6)) * (occupied.shape[0] - 1))))
        y0 = int(round(occupied.shape[0] - ((bbox['zMax'] / max(frame['height'], 1e-6)) * (occupied.shape[0] - 1))))
        cv2.rectangle(debug_image, (x0, y0), (x1, y1), (0, 255, 255), 1)
    cv2.imwrite(str(debug_dir / f"{wall['id']}_occupancy.png"), debug_image)

    wall_summary = {
        'wallId': wall['id'],
        'inputPointCount': int(u_coords.size),
        'occupancyCells': int(occupied.sum()),
        'candidateCount': len(detections),
    }
    return detections, wall_summary


def run_opening_detection(job_id: str, dense_evidence_dir: Path, layout_path: Path, output_dir: Path, dry_run: bool) -> dict:
    layout = read_json(layout_path)
    points = load_dense_points(dense_evidence_dir, layout, dry_run=dry_run)
    walls = [plane for plane in layout['layoutPlanes'] if plane['type'] == 'wall']
    debug_dir = ensure_dir(output_dir / 'debug')

    detections: list[dict] = []
    wall_summaries = []
    for wall in walls:
        wall_detections, wall_summary = detect_openings_for_wall(points, wall, debug_dir)
        detections.extend(wall_detections)
        wall_summaries.append(wall_summary)

    detections.sort(key=lambda item: item['confidence'], reverse=True)
    payload = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'candidateCount': len(detections),
        'candidates': detections,
        'wallSummaries': wall_summaries,
        'note': 'Candidates are conservative by design and require bounded support around a wall void.',
    }
    write_json(output_dir / 'candidates.json', payload)

    summary = {
        'jobId': job_id,
        'createdAt': payload['createdAt'],
        'dryRun': dry_run,
        'wallCount': len(walls),
        'candidateCount': len(detections),
        'doorwayCount': sum(1 for item in detections if item['type'] == 'doorway'),
        'windowCount': sum(1 for item in detections if item['type'] == 'window'),
        'openingCount': sum(1 for item in detections if item['type'] == 'opening'),
        'note': 'Only high-structure voids survive this stage; blank walls remain solid if the boundary evidence is weak.',
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 opening detection')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--dense-evidence-dir', required=True)
    parser.add_argument('--layout-path', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    summary = run_opening_detection(
        job_id=args.job_id,
        dense_evidence_dir=Path(args.dense_evidence_dir),
        layout_path=Path(args.layout_path),
        output_dir=ensure_dir(Path(args.output_dir)),
        dry_run=args.dry_run,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()