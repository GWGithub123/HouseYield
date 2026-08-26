#!/usr/bin/env python3
"""Run the master_v1 gaussian splatting side branch.

This stage is intentionally best-effort by default. It consumes the solved
global SfM text model and selected RGB frames to train a gaussian splat sidecar
without blocking the canonical mesh branch when the gsplat runtime is
unavailable.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
ROOM_TOUR_DIR = SCRIPTS_DIR / 'room_tour'
if str(ROOM_TOUR_DIR) not in sys.path:
    sys.path.insert(0, str(ROOM_TOUR_DIR))

ROOM_TOUR_IMPORT_ERROR: Exception | None = None
ROOM_TOUR_WORKER = None
try:
    import process_room_tour as ROOM_TOUR_WORKER  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional runtime import
    ROOM_TOUR_IMPORT_ERROR = exc


DENSE_EVIDENCE_IMPORT_ERROR: Exception | None = None
DENSE_EVIDENCE = None
try:
    import run_dense_evidence as DENSE_EVIDENCE  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    DENSE_EVIDENCE_IMPORT_ERROR = exc


MASTER_PIPELINE_DIR = Path(__file__).resolve().parent
if str(MASTER_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(MASTER_PIPELINE_DIR))

SEMANTIC_MASKS_IMPORT_ERROR: Exception | None = None
SEMANTIC_MASKS = None
try:
    import run_semantic_masks as SEMANTIC_MASKS  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    SEMANTIC_MASKS_IMPORT_ERROR = exc


ENABLE_GAUSSIAN_SPLATTING = os.environ.get('MASTER_PIPELINE_GAUSSIAN_SPLATTING_ENABLE', 'true').lower() == 'true'
REQUIRE_GAUSSIAN_SPLATTING = os.environ.get('MASTER_PIPELINE_REQUIRE_GAUSSIAN_SPLATTING', 'false').lower() == 'true'
# Stage 8c mirror reflection baking is DISABLED by default. The Householder
# reflection appended a mirrored copy of the room behind every detected mirror
# plane, which produced a duplicated/ghost half-room inside the splat rather than
# a clean in-mirror reflection. Re-enable only behind an explicit opt-in once the
# reflection is properly bounded to the mirror surface.
MIRROR_REFLECTION_BAKING = os.environ.get('MASTER_PIPELINE_GSPLAT_MIRROR_BAKING', 'false').lower() == 'true'
MIRROR_REFLECTIVITY = min(max(float(os.environ.get('MASTER_PIPELINE_GSPLAT_MIRROR_REFLECTIVITY', '0.7')), 0.05), 0.95)
DEFAULT_MIRROR_GAUSSIAN_COMMAND = os.environ.get('MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND', '').strip()
MIRROR_GAUSSIAN_TIMEOUT_SECONDS = max(
    0,
    int(os.environ.get('MASTER_PIPELINE_MIRROR_GAUSSIAN_TIMEOUT_SECONDS', '0')),
)
DEFAULT_REF_GAUSSIAN_COMMAND = os.environ.get('MASTER_PIPELINE_REF_GAUSSIAN_COMMAND', '').strip()
REF_GAUSSIAN_TIMEOUT_SECONDS = max(
    0,
    int(os.environ.get('MASTER_PIPELINE_REF_GAUSSIAN_TIMEOUT_SECONDS', '0')),
)
DEFAULT_SCAFFOLD_GS_COMMAND = os.environ.get('MASTER_PIPELINE_SCAFFOLD_GS_COMMAND', '').strip()
SCAFFOLD_GS_TIMEOUT_SECONDS = max(
    0,
    int(os.environ.get('MASTER_PIPELINE_SCAFFOLD_GS_TIMEOUT_SECONDS', '0')),
)
DEFAULT_GSPLAT_ITERATIONS = max(20000, int(os.environ.get('MASTER_PIPELINE_GSPLAT_ITERATIONS', '20000')))
DEFAULT_MAX_INIT_POINTS = max(128, int(os.environ.get('MASTER_PIPELINE_GSPLAT_MAX_INIT_POINTS', '160000')))
DEFAULT_MIN_INIT_POINTS = max(3, int(os.environ.get('MASTER_PIPELINE_GSPLAT_MIN_INIT_POINTS', '128')))
GSPLAT_MIN_ADAPTIVE_ITERATIONS = max(
    DEFAULT_GSPLAT_ITERATIONS,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_MIN_ADAPTIVE_ITERATIONS', str(DEFAULT_GSPLAT_ITERATIONS))),
)
GSPLAT_MAX_ADAPTIVE_ITERATIONS = max(
    GSPLAT_MIN_ADAPTIVE_ITERATIONS,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_MAX_ADAPTIVE_ITERATIONS', '60000')),
)
GSPLAT_ADAPTIVE_BASELINE_IMAGE_COUNT = max(
    1,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_BASELINE_IMAGE_COUNT', '12')),
)
GSPLAT_ITERATION_STEP_PER_IMAGE = max(
    0,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_ITERATION_STEP_PER_IMAGE', '120')),
)
GSPLAT_DENSIFY_START_FRACTION = min(
    max(float(os.environ.get('MASTER_PIPELINE_GSPLAT_DENSIFY_START_FRACTION', '0.04')), 0.0),
    1.0,
)
GSPLAT_DENSIFY_STOP_FRACTION = min(
    max(
        float(os.environ.get('MASTER_PIPELINE_GSPLAT_DENSIFY_STOP_FRACTION', '0.85')),
        GSPLAT_DENSIFY_START_FRACTION,
    ),
    1.0,
)
GSPLAT_INIT_POINT_BASELINE_IMAGE_COUNT = max(
    1,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_INIT_POINT_BASELINE_IMAGE_COUNT', '16')),
)
GSPLAT_INIT_POINT_STEP_PER_IMAGE = max(
    0,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_INIT_POINT_STEP_PER_IMAGE', '2500')),
)
GSPLAT_MAX_INIT_POINTS_CEILING = max(
    DEFAULT_MAX_INIT_POINTS,
    int(os.environ.get('MASTER_PIPELINE_GSPLAT_MAX_INIT_POINTS_CEILING', '600000')),
)
DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE = max(
    1024,
    int(
        os.environ.get(
            'MASTER_PIPELINE_GSPLAT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE',
            os.environ.get(
                'MASTER_PIPELINE_GSPLAT_METRIC3D_MAX_POINTS_PER_IMAGE',
                str(getattr(DENSE_EVIDENCE, 'MAX_METRIC3D_POINTS_PER_IMAGE_WITH_LEARNED_DENSE', 12000)),
            ),
        )
    ),
)
SPLAT_RECORD_DTYPE = np.dtype(
    [
        ('means', '<f4', (3,)),
        ('scales', '<f4', (3,)),
        ('rgba', 'u1', (4,)),
        ('quat', 'u1', (4,)),
    ]
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def _resolve_optional_path(value: str | os.PathLike[str] | None, *, base_dir: Path | None = None) -> Path | None:
    if value in (None, ''):
        return None
    path = Path(value)
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path


def _read_splat_records(path: Path) -> np.ndarray:
    if not path.exists():
        raise FileNotFoundError(f'splat_missing:{path}')
    byte_size = path.stat().st_size
    if byte_size % SPLAT_RECORD_DTYPE.itemsize != 0:
        raise ValueError(f'invalid_splat_record_size:{path}')
    return np.fromfile(path, dtype=SPLAT_RECORD_DTYPE)


def _write_splat_records(path: Path, records: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records.astype(SPLAT_RECORD_DTYPE, copy=False).tofile(path)


def _build_splat_viewer_html(viewer_dir: Path, job_id: str) -> Path:
    if ROOM_TOUR_WORKER is not None:
        return ROOM_TOUR_WORKER.build_splat_viewer_html(viewer_dir, job_id)

    viewer_dir.mkdir(parents=True, exist_ok=True)
    html_path = viewer_dir / 'index.html'
    html_path.write_text(
        '\n'.join([
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="utf-8"/>',
            '  <meta name="viewport" content="width=device-width, initial-scale=1"/>',
            f'  <title>{job_id}</title>',
            '</head>',
            '<body style="margin:0;background:#0b1020;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;">',
            '  <main style="max-width:560px;padding:24px;text-align:center;line-height:1.5;">',
            '    <h1 style="margin:0 0 12px;">Gaussian Viewer Artifact</h1>',
            '    <p style="margin:0;opacity:0.8;">A fallback viewer placeholder was generated because the room-tour viewer runtime was unavailable during postprocessing. The cleaned splat file is still written alongside this page as ../scene.splat.</p>',
            '  </main>',
            '</body>',
            '</html>',
        ]),
        encoding='utf-8',
    )
    return html_path


def _neighbor_offsets_3d() -> list[tuple[int, int, int]]:
    offsets: list[tuple[int, int, int]] = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if dx == 0 and dy == 0 and dz == 0:
                    continue
                offsets.append((dx, dy, dz))
    return offsets


VOXEL_NEIGHBOR_OFFSETS = _neighbor_offsets_3d()


def _extract_largest_voxel_component(records: np.ndarray, voxel_size: float) -> tuple[np.ndarray, dict]:
    if records.shape[0] == 0 or voxel_size <= 0:
        return records, {
            'applied': False,
            'reason': 'largest_component_disabled',
            'voxel': float(voxel_size),
            'kept': int(records.shape[0]),
            'dropped': 0,
            'componentGaussians': int(records.shape[0]),
        }

    means = np.asarray(records['means'], dtype=np.float32)
    voxel_coords = np.floor(means / float(voxel_size)).astype(np.int64)
    unique_voxels, inverse = np.unique(voxel_coords, axis=0, return_inverse=True)
    if unique_voxels.shape[0] <= 1:
        return records, {
            'applied': False,
            'reason': 'single_component',
            'voxel': float(voxel_size),
            'kept': int(records.shape[0]),
            'dropped': 0,
            'componentGaussians': int(records.shape[0]),
        }

    voxel_keys = [tuple(int(value) for value in coord) for coord in unique_voxels]
    voxel_index = {key: idx for idx, key in enumerate(voxel_keys)}
    voxel_counts = np.bincount(inverse, minlength=unique_voxels.shape[0])
    visited = np.zeros(unique_voxels.shape[0], dtype=bool)
    best_component_indices: list[int] = []
    best_component_gaussians = 0

    for start_idx in range(unique_voxels.shape[0]):
        if visited[start_idx]:
            continue
        stack = [start_idx]
        visited[start_idx] = True
        component_indices: list[int] = []
        component_gaussians = 0

        while stack:
            current_idx = stack.pop()
            component_indices.append(current_idx)
            component_gaussians += int(voxel_counts[current_idx])
            vx, vy, vz = voxel_keys[current_idx]
            for dx, dy, dz in VOXEL_NEIGHBOR_OFFSETS:
                neighbor_idx = voxel_index.get((vx + dx, vy + dy, vz + dz))
                if neighbor_idx is None or visited[neighbor_idx]:
                    continue
                visited[neighbor_idx] = True
                stack.append(neighbor_idx)

        if component_gaussians > best_component_gaussians:
            best_component_indices = component_indices
            best_component_gaussians = component_gaussians

    keep_voxel_mask = np.zeros(unique_voxels.shape[0], dtype=bool)
    keep_voxel_mask[np.asarray(best_component_indices, dtype=np.int64)] = True
    keep_mask = keep_voxel_mask[inverse]
    kept_records = records[keep_mask]
    dropped = int(records.shape[0] - kept_records.shape[0])
    return kept_records, {
        'applied': dropped > 0,
        'reason': None if dropped > 0 else 'largest_component_already_dominant',
        'voxel': float(voxel_size),
        'kept': int(kept_records.shape[0]),
        'dropped': dropped,
        'componentGaussians': int(best_component_gaussians),
    }


def _clamp_splat_anisotropy(
    records: np.ndarray,
    target_ratio: float,
    *,
    relaxed_target_ratio: float = 0.0,
    relaxed_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, dict]:
    if records.shape[0] == 0 or target_ratio <= 1.0:
        return records, {
            'applied': False,
            'reason': 'anisotropy_clamp_disabled',
            'targetRatio': float(target_ratio),
            'relaxedTargetRatio': None,
            'relaxedCount': 0,
            'changed': 0,
        }

    clamped = records.copy()
    scales = np.asarray(clamped['scales'], dtype=np.float32)
    axis_max = scales.max(axis=1, keepdims=True)
    effective_target_ratios = np.full((records.shape[0], 1), float(target_ratio), dtype=np.float32)
    relaxed_count = 0
    normalized_relaxed_ratio = float(relaxed_target_ratio)
    if relaxed_mask is not None and normalized_relaxed_ratio > float(target_ratio):
        candidate_mask = np.asarray(relaxed_mask, dtype=bool).reshape(-1)
        if candidate_mask.shape[0] == records.shape[0]:
            effective_target_ratios[candidate_mask, 0] = normalized_relaxed_ratio
            relaxed_count = int(candidate_mask.sum())
    min_allowed = axis_max / effective_target_ratios
    clamped_scales = np.maximum(scales, min_allowed)
    changed_mask = np.any(np.abs(clamped_scales - scales) > 1e-6, axis=1)
    clamped['scales'] = clamped_scales.astype(np.float32)
    changed = int(changed_mask.sum())
    return clamped, {
        'applied': changed > 0,
        'reason': None if changed > 0 else 'anisotropy_already_within_target',
        'targetRatio': float(target_ratio),
        'relaxedTargetRatio': normalized_relaxed_ratio if normalized_relaxed_ratio > float(target_ratio) else None,
        'relaxedCount': relaxed_count,
        'changed': changed,
    }


def _build_reflective_exclusion_mask(frame_masks: dict[str, object]) -> np.ndarray | None:
    exclusion = None
    cv2 = None

    for class_name in ('mirror', 'window', 'glass'):
        class_mask = frame_masks.get(class_name)
        if class_mask is None:
            continue
        class_mask = np.asarray(class_mask)
        if class_mask.ndim < 2 or class_mask.size == 0:
            continue
        class_bool = class_mask.astype(bool)
        if exclusion is None:
            exclusion = class_bool
            continue
        if class_bool.shape[:2] != exclusion.shape[:2]:
            if cv2 is None:
                import cv2 as cv2_module
                cv2 = cv2_module
            class_bool = cv2.resize(
                class_bool.astype(np.uint8),
                (exclusion.shape[1], exclusion.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            ).astype(bool)
        exclusion |= class_bool

    return exclusion


def _build_reflective_boundary_relaxation_mask(
    *,
    records: np.ndarray,
    sfm_text_model_dir: Path,
    masks_dir: Path | None,
    boundary_band_px: int,
    min_support_views: int,
    relaxed_target_ratio: float,
) -> tuple[np.ndarray, dict]:
    band_px = int(max(0, boundary_band_px))
    support_view_threshold = int(max(0, min_support_views))
    relaxed_mask = np.zeros(records.shape[0], dtype=bool)
    summary = {
        'applied': False,
        'reason': 'reflective_boundary_relaxation_disabled',
        'bandPx': band_px,
        'minSupportViews': support_view_threshold,
        'relaxedTargetRatio': float(relaxed_target_ratio),
        'framesConsidered': 0,
        'framesWithMasks': 0,
        'framesWithBoundaryBands': 0,
        'supportedGaussians': 0,
        'boundarySupportedGaussians': 0,
        'relaxedGaussians': 0,
        'totalBoundaryProjections': 0,
    }
    if records.shape[0] == 0 or band_px <= 0 or support_view_threshold <= 0:
        return relaxed_mask, summary

    if masks_dir is None:
        summary['reason'] = 'reflective_boundary_relaxation_masks_missing'
        return relaxed_mask, summary
    if DENSE_EVIDENCE is None:
        summary['reason'] = f'reflective_boundary_relaxation_dense_evidence_import_failed:{DENSE_EVIDENCE_IMPORT_ERROR}'
        return relaxed_mask, summary
    if SEMANTIC_MASKS is None:
        summary['reason'] = f'reflective_boundary_relaxation_semantic_masks_import_failed:{SEMANTIC_MASKS_IMPORT_ERROR}'
        return relaxed_mask, summary

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    if not cameras_path.exists() or not images_path.exists():
        summary['reason'] = 'reflective_boundary_relaxation_sfm_inputs_missing'
        return relaxed_mask, summary

    try:
        import cv2 as cv2_module
    except Exception as exc:
        summary['reason'] = f'reflective_boundary_relaxation_cv2_import_failed:{exc}'
        return relaxed_mask, summary
    cv2 = cv2_module

    try:
        manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
    except Exception as exc:
        summary['reason'] = f'reflective_boundary_relaxation_manifest_load_failed:{exc}'
        return relaxed_mask, summary
    if not manifest:
        summary['reason'] = 'reflective_boundary_relaxation_manifest_missing'
        return relaxed_mask, summary

    try:
        cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
        images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
    except Exception as exc:
        summary['reason'] = f'reflective_boundary_relaxation_sfm_parse_failed:{exc}'
        return relaxed_mask, summary
    if not cameras or not images_meta:
        summary['reason'] = 'reflective_boundary_relaxation_sfm_parse_failed'
        return relaxed_mask, summary

    means = np.asarray(records['means'], dtype=np.float32)
    support_counts = np.zeros(means.shape[0], dtype=np.int32)
    boundary_counts = np.zeros(means.shape[0], dtype=np.int32)
    frames_considered = 0
    frames_with_masks = 0
    frames_with_boundary_bands = 0
    total_boundary_projections = 0
    kernel_size = max(1, band_px) * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))

    for image_name, image_data in sorted(images_meta.items()):
        frames_considered += 1
        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        try:
            frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, manifest)
        except Exception:
            frame_masks = {}

        exclusion = _build_reflective_exclusion_mask(frame_masks)
        if exclusion is None or not np.any(exclusion):
            continue

        frames_with_masks += 1
        boundary_band = cv2.dilate(exclusion.astype(np.uint8), kernel, iterations=1).astype(bool)
        eroded = cv2.erode(exclusion.astype(np.uint8), kernel, iterations=1).astype(bool)
        boundary_band &= ~eroded
        if not np.any(boundary_band):
            continue

        frames_with_boundary_bands += 1
        intrinsics = np.asarray(DENSE_EVIDENCE.get_intrinsics_matrix(camera), dtype=np.float32)
        rotation, translation = DENSE_EVIDENCE.get_camera_extrinsics(image_data)
        rotation = np.asarray(rotation, dtype=np.float32)
        translation = np.asarray(translation, dtype=np.float32).reshape(3)
        points_camera = (rotation @ means.T).T + translation
        depth = points_camera[:, 2]
        valid = np.isfinite(depth) & (depth > 1e-4)
        if not np.any(valid):
            continue

        fx, fy, cx, cy = intrinsics[0, 0], intrinsics[1, 1], intrinsics[0, 2], intrinsics[1, 2]
        u = fx * (points_camera[:, 0] / depth) + cx
        v = fy * (points_camera[:, 1] / depth) + cy
        mask_height, mask_width = boundary_band.shape[:2]
        inside = (
            valid
            & np.isfinite(u)
            & np.isfinite(v)
            & (u >= 0)
            & (v >= 0)
            & (u < mask_width)
            & (v < mask_height)
        )
        if not np.any(inside):
            continue

        indices = np.nonzero(inside)[0]
        uu = np.floor(u[inside]).astype(np.int32)
        vv = np.floor(v[inside]).astype(np.int32)
        support_counts[indices] += 1
        boundary_hits = boundary_band[vv, uu]
        if np.any(boundary_hits):
            boundary_counts[indices[boundary_hits]] += 1
            total_boundary_projections += int(boundary_hits.sum())

    relaxed_mask = boundary_counts >= support_view_threshold
    summary.update({
        'applied': bool(relaxed_mask.any()),
        'reason': None if relaxed_mask.any() else (
            'reflective_boundary_relaxation_no_boundary_support_candidates'
            if frames_with_masks > 0 else
            'reflective_boundary_relaxation_no_mask_frames'
        ),
        'framesConsidered': int(frames_considered),
        'framesWithMasks': int(frames_with_masks),
        'framesWithBoundaryBands': int(frames_with_boundary_bands),
        'supportedGaussians': int((support_counts > 0).sum()),
        'boundarySupportedGaussians': int((boundary_counts > 0).sum()),
        'relaxedGaussians': int(relaxed_mask.sum()),
        'totalBoundaryProjections': int(total_boundary_projections),
    })
    return relaxed_mask, summary


def _filter_reflective_mask_supported_gaussians(
    *,
    records: np.ndarray,
    sfm_text_model_dir: Path,
    masks_dir: Path | None,
    masked_support_ratio: float,
    min_masked_hits: int,
    min_support_views: int,
) -> tuple[np.ndarray, dict]:
    normalized_ratio = min(max(float(masked_support_ratio), 0.0), 1.0)
    summary = {
        'applied': False,
        'reason': 'reflective_mask_cleanup_disabled',
        'maskedSupportRatio': normalized_ratio,
        'minMaskedHits': int(max(0, min_masked_hits)),
        'minSupportViews': int(max(0, min_support_views)),
        'framesConsidered': 0,
        'framesWithMasks': 0,
        'supportedGaussians': 0,
        'candidateGaussians': 0,
        'maskedAnyCount': 0,
        'maskedMajorityCount': 0,
        'totalMaskedProjections': 0,
        'dropped': 0,
        'kept': int(records.shape[0]),
    }
    if (
        records.shape[0] == 0
        or normalized_ratio <= 0.0
        or min_masked_hits <= 0
        or min_support_views <= 0
    ):
        return records, summary

    if masks_dir is None:
        summary['reason'] = 'reflective_mask_cleanup_masks_missing'
        return records, summary
    if DENSE_EVIDENCE is None:
        summary['reason'] = f'reflective_mask_cleanup_dense_evidence_import_failed:{DENSE_EVIDENCE_IMPORT_ERROR}'
        return records, summary
    if SEMANTIC_MASKS is None:
        summary['reason'] = f'reflective_mask_cleanup_semantic_masks_import_failed:{SEMANTIC_MASKS_IMPORT_ERROR}'
        return records, summary

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    if not cameras_path.exists() or not images_path.exists():
        summary['reason'] = 'reflective_mask_cleanup_sfm_inputs_missing'
        return records, summary

    try:
        manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
    except Exception as exc:
        summary['reason'] = f'reflective_mask_cleanup_manifest_load_failed:{exc}'
        return records, summary
    if not manifest:
        summary['reason'] = 'reflective_mask_cleanup_manifest_missing'
        return records, summary

    try:
        cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
        images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
    except Exception as exc:
        summary['reason'] = f'reflective_mask_cleanup_sfm_parse_failed:{exc}'
        return records, summary
    if not cameras or not images_meta:
        summary['reason'] = 'reflective_mask_cleanup_sfm_parse_failed'
        return records, summary

    means = np.asarray(records['means'], dtype=np.float32)
    support_counts = np.zeros(means.shape[0], dtype=np.int32)
    masked_counts = np.zeros(means.shape[0], dtype=np.int32)
    frames_considered = 0
    frames_with_masks = 0
    total_masked_projections = 0
    cv2 = None

    for image_name, image_data in sorted(images_meta.items()):
        frames_considered += 1
        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        try:
            frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, manifest)
        except Exception:
            frame_masks = {}

        exclusion = _build_reflective_exclusion_mask(frame_masks)

        if exclusion is None or not np.any(exclusion):
            continue

        frames_with_masks += 1
        intrinsics = np.asarray(DENSE_EVIDENCE.get_intrinsics_matrix(camera), dtype=np.float32)
        rotation, translation = DENSE_EVIDENCE.get_camera_extrinsics(image_data)
        rotation = np.asarray(rotation, dtype=np.float32)
        translation = np.asarray(translation, dtype=np.float32).reshape(3)
        points_camera = (rotation @ means.T).T + translation
        depth = points_camera[:, 2]
        valid = np.isfinite(depth) & (depth > 1e-4)
        if not np.any(valid):
            continue

        fx, fy, cx, cy = intrinsics[0, 0], intrinsics[1, 1], intrinsics[0, 2], intrinsics[1, 2]
        u = fx * (points_camera[:, 0] / depth) + cx
        v = fy * (points_camera[:, 1] / depth) + cy
        mask_height, mask_width = exclusion.shape[:2]
        inside = (
            valid
            & np.isfinite(u)
            & np.isfinite(v)
            & (u >= 0)
            & (v >= 0)
            & (u < mask_width)
            & (v < mask_height)
        )
        if not np.any(inside):
            continue

        indices = np.nonzero(inside)[0]
        uu = np.floor(u[inside]).astype(np.int32)
        vv = np.floor(v[inside]).astype(np.int32)
        support_counts[indices] += 1
        frame_hits = exclusion[vv, uu]
        if np.any(frame_hits):
            masked_counts[indices[frame_hits]] += 1
            total_masked_projections += int(frame_hits.sum())

    supported_mask = support_counts > 0
    candidate_mask = support_counts >= int(min_support_views)
    majority_threshold = np.ceil(support_counts.astype(np.float32) * 0.5).astype(np.int32)
    drop_threshold = np.ceil(support_counts.astype(np.float32) * normalized_ratio).astype(np.int32)
    drop_mask = (
        candidate_mask
        & (masked_counts >= int(min_masked_hits))
        & (masked_counts >= drop_threshold)
    )
    kept_records = records[~drop_mask]
    dropped = int(drop_mask.sum())
    summary.update({
        'applied': dropped > 0,
        'reason': None if dropped > 0 else (
            'reflective_mask_cleanup_no_masked_support_candidates'
            if frames_with_masks > 0 else
            'reflective_mask_cleanup_no_mask_frames'
        ),
        'framesConsidered': int(frames_considered),
        'framesWithMasks': int(frames_with_masks),
        'supportedGaussians': int(supported_mask.sum()),
        'candidateGaussians': int(candidate_mask.sum()),
        'maskedAnyCount': int((masked_counts > 0).sum()),
        'maskedMajorityCount': int((supported_mask & (masked_counts >= majority_threshold)).sum()),
        'totalMaskedProjections': int(total_masked_projections),
        'dropped': dropped,
        'kept': int(kept_records.shape[0]),
    })
    return kept_records, summary


def _build_postprocessed_output(
    *,
    job_id: str,
    output_dir: Path,
    sfm_text_model_dir: Path,
    masks_dir: Path | None,
    raw_splat_scene_path: Path,
    raw_splat_ply_path: Path | None,
    component_voxel_size: float,
    reflective_masked_support_ratio: float,
    reflective_masked_min_hits: int,
    reflective_masked_min_support_views: int,
    max_anisotropy_ratio: float,
    reflective_boundary_band_px: int,
    reflective_boundary_min_support_views: int,
    reflective_boundary_max_anisotropy_ratio: float,
) -> tuple[Path, Path | None, Path, dict]:
    records = _read_splat_records(raw_splat_scene_path)
    initial_count = int(records.shape[0])
    current_records = records

    component_summary = {
        'applied': False,
        'reason': 'largest_component_disabled',
        'voxel': float(component_voxel_size),
        'kept': initial_count,
        'dropped': 0,
        'componentGaussians': initial_count,
    }
    if component_voxel_size > 0:
        current_records, component_summary = _extract_largest_voxel_component(current_records, component_voxel_size)

    reflective_mask_summary = {
        'applied': False,
        'reason': 'reflective_mask_cleanup_disabled',
        'maskedSupportRatio': float(max(0.0, reflective_masked_support_ratio)),
        'minMaskedHits': int(max(0, reflective_masked_min_hits)),
        'minSupportViews': int(max(0, reflective_masked_min_support_views)),
        'framesConsidered': 0,
        'framesWithMasks': 0,
        'supportedGaussians': 0,
        'candidateGaussians': 0,
        'maskedAnyCount': 0,
        'maskedMajorityCount': 0,
        'totalMaskedProjections': 0,
        'dropped': 0,
        'kept': int(current_records.shape[0]),
    }
    if reflective_masked_support_ratio > 0 and reflective_masked_min_hits > 0 and reflective_masked_min_support_views > 0:
        current_records, reflective_mask_summary = _filter_reflective_mask_supported_gaussians(
            records=current_records,
            sfm_text_model_dir=sfm_text_model_dir,
            masks_dir=masks_dir,
            masked_support_ratio=reflective_masked_support_ratio,
            min_masked_hits=reflective_masked_min_hits,
            min_support_views=reflective_masked_min_support_views,
        )

    boundary_relax_summary = {
        'applied': False,
        'reason': 'reflective_boundary_relaxation_disabled',
        'bandPx': int(max(0, reflective_boundary_band_px)),
        'minSupportViews': int(max(0, reflective_boundary_min_support_views)),
        'relaxedTargetRatio': float(reflective_boundary_max_anisotropy_ratio),
        'framesConsidered': 0,
        'framesWithMasks': 0,
        'framesWithBoundaryBands': 0,
        'supportedGaussians': 0,
        'boundarySupportedGaussians': 0,
        'relaxedGaussians': 0,
        'totalBoundaryProjections': 0,
    }
    relaxed_boundary_mask = None
    if (
        max_anisotropy_ratio > 1.0
        and reflective_boundary_band_px > 0
        and reflective_boundary_min_support_views > 0
        and reflective_boundary_max_anisotropy_ratio > max_anisotropy_ratio
    ):
        relaxed_boundary_mask, boundary_relax_summary = _build_reflective_boundary_relaxation_mask(
            records=current_records,
            sfm_text_model_dir=sfm_text_model_dir,
            masks_dir=masks_dir,
            boundary_band_px=reflective_boundary_band_px,
            min_support_views=reflective_boundary_min_support_views,
            relaxed_target_ratio=reflective_boundary_max_anisotropy_ratio,
        )

    ratio_summary = {
        'applied': False,
        'reason': 'anisotropy_clamp_disabled',
        'targetRatio': float(max_anisotropy_ratio),
        'relaxedTargetRatio': None,
        'relaxedCount': 0,
        'changed': 0,
    }
    if max_anisotropy_ratio > 1.0:
        current_records, ratio_summary = _clamp_splat_anisotropy(
            current_records,
            max_anisotropy_ratio,
            relaxed_target_ratio=reflective_boundary_max_anisotropy_ratio,
            relaxed_mask=relaxed_boundary_mask,
        )

    final_output_dir = ensure_dir(output_dir / 'final-output')
    final_splat_scene_path = final_output_dir / 'scene.splat'
    _write_splat_records(final_splat_scene_path, current_records)

    final_splat_ply_path = None
    if raw_splat_ply_path is not None and raw_splat_ply_path.exists() and current_records.shape[0] == initial_count:
        final_splat_ply_path = final_output_dir / 'scene.ply'
        shutil.copyfile(raw_splat_ply_path, final_splat_ply_path)

    viewer_html_path = _build_splat_viewer_html(final_output_dir / 'viewer', job_id)
    summary = {
        'applied': True,
        'rawPointCount': initial_count,
        'pointCount': int(current_records.shape[0]),
        'rawSplatScenePath': str(raw_splat_scene_path),
        'finalSplatScenePath': str(final_splat_scene_path),
        'finalSplatPlyPath': str(final_splat_ply_path) if final_splat_ply_path else None,
        'viewerHtmlPath': str(viewer_html_path),
        'largestComponent': component_summary,
        'reflectiveMaskCleanup': reflective_mask_summary,
        'reflectiveBoundaryAnisotropyRelaxation': boundary_relax_summary,
        'anisotropyClamp': ratio_summary,
    }
    write_json(final_output_dir / 'cleanup-summary.json', summary)
    return final_splat_scene_path, final_splat_ply_path, viewer_html_path, summary


def _parse_colmap_points3d(points_path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if ROOM_TOUR_WORKER is not None:
        points, colors = ROOM_TOUR_WORKER._parse_colmap_points3d(points_path)
        support = np.ones(points.shape[0], dtype=np.float32)
        return points, colors, support

    points: list[list[float]] = []
    colors: list[list[float]] = []
    support_counts: list[float] = []
    if not points_path.exists():
        return (
            np.empty((0, 3), dtype=np.float32),
            np.empty((0, 3), dtype=np.float32),
            np.empty((0,), dtype=np.float32),
        )

    with points_path.open(encoding='utf-8') as handle:
        for line in handle:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            points.append([float(parts[1]), float(parts[2]), float(parts[3])])
            colors.append([int(parts[4]) / 255.0, int(parts[5]) / 255.0, int(parts[6]) / 255.0])
            support_counts.append(float(max(1, (len(parts) - 8) // 2)))

    return (
        np.asarray(points, dtype=np.float32),
        np.asarray(colors, dtype=np.float32),
        np.asarray(support_counts, dtype=np.float32),
    )


def _count_registered_images(images_path: Path) -> int:
    if ROOM_TOUR_WORKER is not None:
        return len(ROOM_TOUR_WORKER.parse_colmap_images_txt(images_path))

    count = 0
    if not images_path.exists():
        return 0

    with images_path.open(encoding='utf-8') as handle:
        lines = [line for line in handle if not line.startswith('#') and line.strip()]
    return len(lines) // 2


def _resolve_effective_gsplat_iterations(requested_iterations: int, registered_image_count: int) -> int:
    baseline_target = max(int(requested_iterations), GSPLAT_MIN_ADAPTIVE_ITERATIONS)
    extra_images = max(0, int(registered_image_count) - GSPLAT_ADAPTIVE_BASELINE_IMAGE_COUNT)
    adaptive_target = GSPLAT_MIN_ADAPTIVE_ITERATIONS + (extra_images * GSPLAT_ITERATION_STEP_PER_IMAGE)
    return max(baseline_target, min(GSPLAT_MAX_ADAPTIVE_ITERATIONS, adaptive_target))


def _resolve_effective_max_init_points(requested_max_points: int, registered_image_count: int) -> int:
    baseline_budget = max(int(requested_max_points), DEFAULT_MAX_INIT_POINTS)
    extra_images = max(0, int(registered_image_count) - GSPLAT_INIT_POINT_BASELINE_IMAGE_COUNT)
    adaptive_budget = DEFAULT_MAX_INIT_POINTS + (extra_images * GSPLAT_INIT_POINT_STEP_PER_IMAGE)
    adaptive_budget = min(GSPLAT_MAX_INIT_POINTS_CEILING, adaptive_budget)
    return max(baseline_budget, adaptive_budget)


def _subsample_points(
    points: np.ndarray,
    colors: np.ndarray,
    max_points: int,
    *,
    weights: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool]:
    if points.shape[0] <= max_points:
        resolved_weights = np.ones(points.shape[0], dtype=np.float32) if weights is None else np.asarray(weights, dtype=np.float32)
        return points, colors, resolved_weights, False

    if weights is None or np.asarray(weights).shape[0] != points.shape[0]:
        resolved_weights = np.ones(points.shape[0], dtype=np.float32)
    else:
        resolved_weights = np.asarray(weights, dtype=np.float32).reshape(-1)
    resolved_weights = np.where(np.isfinite(resolved_weights), resolved_weights, 0.0)

    bounds_min = np.min(points, axis=0)
    bounds_extent = np.max(points, axis=0) - bounds_min
    max_extent = float(np.max(bounds_extent)) if bounds_extent.size else 0.0
    if not np.isfinite(max_extent) or max_extent <= 1e-6:
        order = np.argsort(-resolved_weights, kind='stable')[:max_points]
        order = np.sort(order.astype(np.int64))
        return points[order], colors[order], resolved_weights[order], True

    approx_voxels_per_axis = max(1, int(round(max_points ** (1.0 / 3.0))))
    voxel_size = max(max_extent / float(approx_voxels_per_axis), 1e-6)
    voxel_indices = np.floor((points - bounds_min) / voxel_size).astype(np.int32)
    best_per_voxel: dict[tuple[int, int, int], int] = {}
    for point_index, voxel_index in enumerate(voxel_indices.tolist()):
        voxel_key = (int(voxel_index[0]), int(voxel_index[1]), int(voxel_index[2]))
        current_best = best_per_voxel.get(voxel_key)
        if current_best is None or resolved_weights[point_index] > resolved_weights[current_best]:
            best_per_voxel[voxel_key] = point_index

    selected = np.asarray(sorted(best_per_voxel.values()), dtype=np.int64)
    if selected.shape[0] > max_points:
        selected_weights = resolved_weights[selected]
        keep = np.argsort(-selected_weights, kind='stable')[:max_points]
        selected = np.sort(selected[keep])
    elif selected.shape[0] < max_points:
        keep_mask = np.zeros(points.shape[0], dtype=bool)
        keep_mask[selected] = True
        remaining = np.flatnonzero(~keep_mask)
        if remaining.shape[0] > 0:
            remaining_order = remaining[np.argsort(-resolved_weights[remaining], kind='stable')]
            fill = remaining_order[: max_points - selected.shape[0]]
            selected = np.sort(np.concatenate([selected, fill]).astype(np.int64))

    return points[selected], colors[selected], resolved_weights[selected], True


def _empty_metric3d_init(*, requested: bool, reason: str | None = None) -> dict:
    return {
        'requested': requested,
        'candidatePointCount': 0,
        'selectedPointCount': 0,
        'calibratedImageCount': 0,
        'calibrationAnchorCount': 0,
        'pointBudgetPerImage': int(DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE) if requested else 0,
        'maskExcludedPixelCount': 0,
        'mirrorExclusionBandPx': 0,
        'maxMirrorExclusionBandPx': 0,
        'reflectiveSkipCoverageThreshold': 0.0,
        'skippedReflectiveFrameCount': 0,
        'maxReflectiveCoverage': 0.0,
        'downsampled': False,
        'reason': reason,
        'points': np.empty((0, 3), dtype=np.float32),
        'colors': np.empty((0, 3), dtype=np.float32),
        'weights': np.empty((0,), dtype=np.float32),
    }


def _depth_priors_are_post_sfm_aligned(metric3d_dir: Path | None) -> bool:
    if metric3d_dir is None:
        return False

    summary_path = metric3d_dir / 'summary.json'
    if not summary_path.exists():
        return False

    try:
        summary = json.loads(summary_path.read_text(encoding='utf-8'))
    except Exception:
        return False

    return str(summary.get('method', '')) == 'depth_anything_v2_post_sfm_aligned'


def _project_world_points_to_image(
    points_world: np.ndarray,
    *,
    rotation: np.ndarray,
    translation: np.ndarray,
    intrinsics: np.ndarray,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    points_cam = (rotation @ points_world.T).T + translation.reshape(1, 3)
    z = points_cam[:, 2]
    valid_z = np.isfinite(z) & (z > 1e-4)
    u = (points_cam[:, 0] * intrinsics[0, 0] / np.maximum(z, 1e-6)) + intrinsics[0, 2]
    v = (points_cam[:, 1] * intrinsics[1, 1] / np.maximum(z, 1e-6)) + intrinsics[1, 2]
    in_bounds = (
        valid_z
        & np.isfinite(u)
        & np.isfinite(v)
        & (u >= 0.0)
        & (u < float(width))
        & (v >= 0.0)
        & (v < float(height))
    )
    return u, v, z, in_bounds


def _weighted_voxel_fuse_points(
    points: np.ndarray,
    colors: np.ndarray,
    weights: np.ndarray,
    *,
    max_points: int,
    voxel_size: float | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool, float]:
    if points.shape[0] == 0:
        return points, colors, weights, False, 0.0

    finite = (
        np.isfinite(points).all(axis=1)
        & np.isfinite(colors).all(axis=1)
        & np.isfinite(weights)
        & (weights > 0.0)
    )
    points = points[finite]
    colors = colors[finite]
    weights = weights[finite]
    if points.shape[0] == 0:
        return points, colors, weights, False, 0.0

    if voxel_size is None or voxel_size <= 0.0:
        p05 = np.percentile(points, 5, axis=0)
        p95 = np.percentile(points, 95, axis=0)
        robust_diagonal = float(np.linalg.norm(p95 - p05))
        voxel_size = max(0.025, robust_diagonal * 0.003)

    origin = points.min(axis=0)
    voxel_indices = np.floor((points - origin.reshape(1, 3)) / float(voxel_size)).astype(np.int64)
    _, inverse = np.unique(voxel_indices, axis=0, return_inverse=True)
    voxel_count = int(inverse.max()) + 1

    weight_sums = np.zeros(voxel_count, dtype=np.float64)
    point_sums = np.zeros((voxel_count, 3), dtype=np.float64)
    color_sums = np.zeros((voxel_count, 3), dtype=np.float64)
    np.add.at(weight_sums, inverse, weights.astype(np.float64))
    np.add.at(point_sums, inverse, points.astype(np.float64) * weights[:, None].astype(np.float64))
    np.add.at(color_sums, inverse, colors.astype(np.float64) * weights[:, None].astype(np.float64))

    nonzero = weight_sums > 0.0
    fused_points = (point_sums[nonzero] / weight_sums[nonzero, None]).astype(np.float32)
    fused_colors = (color_sums[nonzero] / weight_sums[nonzero, None]).astype(np.float32)
    fused_weights = weight_sums[nonzero].astype(np.float32)
    fused_colors = np.clip(fused_colors, 0.0, 1.0)

    downsampled = points.shape[0] != fused_points.shape[0]
    if fused_points.shape[0] > max_points:
        fused_points, fused_colors, fused_weights, _ = _subsample_points(
            fused_points,
            fused_colors,
            max_points,
            weights=fused_weights,
        )
        downsampled = True

    return fused_points, fused_colors, fused_weights, downsampled, float(voxel_size)


def _load_metric3d_fused_hole_fill_init_points(
    *,
    images_dir: Path,
    sfm_text_model_dir: Path,
    metric3d_dir: Path | None,
    max_points: int,
    point_budget_per_image: int = DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE,
    masks_dir: Path | None = None,
    mirror_exclusion_band_px: int = 0,
    max_mirror_exclusion_band_px: int | None = None,
    mirror_exclusion_band_coverage_scale_px: float = 0.0,
    reflective_skip_coverage_threshold: float = 0.0,
    min_support_views: int = 2,
    depth_agreement_tolerance: float = 0.10,
    neighbor_view_count: int = 6,
    sfm_coverage_radius_px: int = 14,
    candidate_multiplier: int = 3,
) -> dict:
    if metric3d_dir is None:
        return _empty_metric3d_init(requested=False)
    if max_points <= 0:
        return _empty_metric3d_init(requested=True, reason='metric3d_init_budget_exhausted')
    if DENSE_EVIDENCE is None:
        return _empty_metric3d_init(
            requested=True,
            reason=f'metric3d_helper_import_failed:{DENSE_EVIDENCE_IMPORT_ERROR}',
        )
    if not metric3d_dir.exists():
        return _empty_metric3d_init(requested=True, reason=f'metric3d_dir_missing:{metric3d_dir}')

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    points_path = sfm_text_model_dir / 'points3D.txt'
    if not cameras_path.exists() or not images_path.exists() or not points_path.exists():
        return _empty_metric3d_init(requested=True, reason='metric3d_alignment_inputs_missing')

    cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
    images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
    points_by_id = DENSE_EVIDENCE.parse_colmap_points_lookup(points_path)
    if not cameras or not images_meta or not points_by_id:
        return _empty_metric3d_init(requested=True, reason='metric3d_alignment_inputs_missing')

    import cv2

    priors_are_aligned = _depth_priors_are_post_sfm_aligned(metric3d_dir)
    masks_manifest = None
    if masks_dir is not None and SEMANTIC_MASKS is not None:
        try:
            masks_manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
        except Exception:
            masks_manifest = None

    sfm_points = np.asarray(
        [np.asarray(point['xyz'], dtype=np.float32) for point in points_by_id.values()],
        dtype=np.float32,
    ).reshape(-1, 3)
    mirror_exclusion_band_px = int(max(0, mirror_exclusion_band_px))
    max_mirror_exclusion_band_px = int(
        max(
            mirror_exclusion_band_px,
            max_mirror_exclusion_band_px if max_mirror_exclusion_band_px is not None else mirror_exclusion_band_px,
        )
    )
    mirror_exclusion_band_coverage_scale_px = max(0.0, float(mirror_exclusion_band_coverage_scale_px))
    reflective_skip_coverage_threshold = min(max(float(reflective_skip_coverage_threshold), 0.0), 1.0)
    min_support_views = max(1, int(min_support_views))
    depth_agreement_tolerance = max(0.01, float(depth_agreement_tolerance))
    neighbor_view_count = max(1, int(neighbor_view_count))
    candidate_multiplier = max(1, int(candidate_multiplier))

    records: list[dict] = []
    calibration_anchor_count = 0
    masks_excluded_pixel_count = 0
    sfm_covered_pixel_count = 0
    skipped_reflective_frame_count = 0
    max_reflective_coverage = 0.0
    max_dynamic_mirror_exclusion_band_px = mirror_exclusion_band_px
    mirror_exclusion_kernel_cache: dict[int, np.ndarray] = {}

    def get_mirror_exclusion_kernel(band_px: int) -> np.ndarray | None:
        band_px = int(max(0, band_px))
        if band_px <= 0:
            return None
        kernel = mirror_exclusion_kernel_cache.get(band_px)
        if kernel is None:
            kernel = np.ones(((band_px * 2) + 1, (band_px * 2) + 1), dtype=np.uint8)
            mirror_exclusion_kernel_cache[band_px] = kernel
        return kernel

    sfm_kernel = (
        np.ones(((sfm_coverage_radius_px * 2) + 1, (sfm_coverage_radius_px * 2) + 1), dtype=np.uint8)
        if sfm_coverage_radius_px > 0
        else None
    )

    for image_index, (image_name, image_data) in enumerate(sorted(images_meta.items())):
        depth_path = metric3d_dir / 'depth' / f'{Path(image_name).stem}_depth.npy'
        confidence_path = metric3d_dir / 'confidence' / f'{Path(image_name).stem}_confidence.npy'
        image_path = images_dir / image_name
        if not depth_path.exists() or not confidence_path.exists() or not image_path.exists():
            continue

        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        depth_map = np.load(depth_path).astype(np.float32)
        confidence_map = np.load(confidence_path).astype(np.float32)
        if priors_are_aligned:
            calibrated_depth_map = depth_map
            calibration = {'applied': True, 'anchorCount': 0}
        else:
            calibrated_depth_map, calibration = DENSE_EVIDENCE.calibrate_metric3d_depth_map(
                depth_map,
                confidence_map,
                image_data,
                camera,
                points_by_id,
            )
        calibration_anchor_count += int(calibration.get('anchorCount', 0) or 0)
        if not calibration.get('applied'):
            continue

        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        if image.shape[:2] != calibrated_depth_map.shape[:2]:
            image = cv2.resize(image, (calibrated_depth_map.shape[1], calibrated_depth_map.shape[0]))
        if confidence_map.shape[:2] != calibrated_depth_map.shape[:2]:
            confidence_map = cv2.resize(
                confidence_map,
                (calibrated_depth_map.shape[1], calibrated_depth_map.shape[0]),
                interpolation=cv2.INTER_LINEAR,
            )

        height, width = calibrated_depth_map.shape[:2]
        prior_valid = (
            np.isfinite(calibrated_depth_map)
            & np.isfinite(confidence_map)
            & (calibrated_depth_map > 0.05)
            & (calibrated_depth_map < 50.0)
            & (confidence_map > 0.2)
        )

        if masks_manifest is not None:
            try:
                frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, masks_manifest)
            except Exception:
                frame_masks = {}
            exclusion = None
            raw_class_masks: dict[str, np.ndarray] = {}
            reflective_union = None
            mirror_coverage = 0.0
            for class_name in ('mirror', 'window', 'glass'):
                class_mask = frame_masks.get(class_name)
                if class_mask is None:
                    continue
                class_mask = np.asarray(class_mask)
                if class_mask.shape[:2] != (height, width):
                    class_mask = cv2.resize(
                        class_mask.astype(np.uint8),
                        (width, height),
                        interpolation=cv2.INTER_NEAREST,
                    )
                class_bool = class_mask.astype(bool)
                raw_class_masks[class_name] = class_bool
                reflective_union = class_bool if reflective_union is None else (reflective_union | class_bool)
                if class_name == 'mirror':
                    mirror_coverage = float(class_bool.mean())
            reflective_coverage = float(reflective_union.mean()) if reflective_union is not None else 0.0
            max_reflective_coverage = max(max_reflective_coverage, reflective_coverage)
            if reflective_skip_coverage_threshold > 0.0 and mirror_coverage >= reflective_skip_coverage_threshold:
                skipped_reflective_frame_count += 1
                continue

            frame_mirror_exclusion_band_px = mirror_exclusion_band_px
            if mirror_exclusion_band_px > 0 and mirror_coverage > 0.0:
                coverage_bonus_px = int(round(mirror_coverage * mirror_exclusion_band_coverage_scale_px))
                frame_mirror_exclusion_band_px = min(
                    max_mirror_exclusion_band_px,
                    mirror_exclusion_band_px + max(0, coverage_bonus_px),
                )
            max_dynamic_mirror_exclusion_band_px = max(
                max_dynamic_mirror_exclusion_band_px,
                int(frame_mirror_exclusion_band_px),
            )
            mirror_exclusion_kernel = get_mirror_exclusion_kernel(frame_mirror_exclusion_band_px)
            for class_name, class_bool in raw_class_masks.items():
                if class_name == 'mirror' and mirror_exclusion_kernel is not None and np.any(class_bool):
                    class_bool = cv2.dilate(
                        class_bool.astype(np.uint8),
                        mirror_exclusion_kernel,
                        iterations=1,
                    ).astype(bool)
                exclusion = class_bool if exclusion is None else (exclusion | class_bool)
            if exclusion is not None and np.any(exclusion):
                masks_excluded_pixel_count += int((prior_valid & exclusion).sum())
                prior_valid &= ~exclusion

        intrinsics = np.asarray(DENSE_EVIDENCE.get_intrinsics_matrix(camera), dtype=np.float32)
        rotation, translation = DENSE_EVIDENCE.get_camera_extrinsics(image_data)
        rotation = np.asarray(rotation, dtype=np.float32)
        translation = np.asarray(translation, dtype=np.float32).reshape(3)

        hole_valid = prior_valid.copy()
        if sfm_points.shape[0] > 0:
            u_sfm, v_sfm, _, sfm_in_bounds = _project_world_points_to_image(
                sfm_points,
                rotation=rotation,
                translation=translation,
                intrinsics=intrinsics,
                width=width,
                height=height,
            )
            sfm_coverage = np.zeros((height, width), dtype=np.uint8)
            if np.any(sfm_in_bounds):
                x = np.rint(u_sfm[sfm_in_bounds]).astype(np.int32)
                y = np.rint(v_sfm[sfm_in_bounds]).astype(np.int32)
                x = np.clip(x, 0, width - 1)
                y = np.clip(y, 0, height - 1)
                sfm_coverage[y, x] = 1
                if sfm_kernel is not None:
                    sfm_coverage = cv2.dilate(sfm_coverage, sfm_kernel, iterations=1)
                sfm_covered = sfm_coverage.astype(bool)
                sfm_covered_pixel_count += int((hole_valid & sfm_covered).sum())
                hole_valid &= ~sfm_covered

        records.append({
            'index': image_index,
            'name': image_name,
            'depth': calibrated_depth_map,
            'confidence': confidence_map,
            'image': image.astype(np.float32) / 255.0,
            'prior_valid': prior_valid,
            'hole_valid': hole_valid,
            'intrinsics': intrinsics,
            'rotation': rotation,
            'translation': translation,
            'center': (-rotation.T @ translation.reshape(3)).astype(np.float32),
        })

    if not records:
        return {
            **_empty_metric3d_init(requested=True, reason='metric3d_no_calibrated_points'),
            'calibrationAnchorCount': int(calibration_anchor_count),
            'maskExcludedPixelCount': int(masks_excluded_pixel_count),
            'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
            'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
            'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
            'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
            'maxReflectiveCoverage': float(max_reflective_coverage),
            'initMode': 'fused_hole_fill',
        }

    accepted_points: list[np.ndarray] = []
    accepted_colors: list[np.ndarray] = []
    accepted_weights: list[np.ndarray] = []
    source_candidate_count = 0
    support_rejected_count = 0
    point_budget = max(1, int(point_budget_per_image))
    camera_centers = np.asarray([record['center'] for record in records], dtype=np.float32).reshape(-1, 3)
    neighbor_positions_by_record: list[list[int]] = []
    for record_pos, center in enumerate(camera_centers):
        distances = np.linalg.norm(camera_centers - center.reshape(1, 3), axis=1)
        order = np.argsort(distances, kind='stable')
        neighbor_positions_by_record.append([
            int(pos)
            for pos in order.tolist()
            if int(pos) != record_pos
        ][:neighbor_view_count])

    for record_pos, record in enumerate(records):
        valid_y, valid_x = np.nonzero(record['hole_valid'])
        if valid_x.shape[0] == 0:
            continue
        source_candidate_count += int(valid_x.shape[0])

        sample_limit = max(point_budget, point_budget * candidate_multiplier)
        if valid_x.shape[0] > sample_limit:
            order = np.linspace(0, valid_x.shape[0] - 1, sample_limit, dtype=np.int64)
            valid_x = valid_x[order]
            valid_y = valid_y[order]

        depth_values = record['depth'][valid_y, valid_x].astype(np.float32)
        fx = record['intrinsics'][0, 0]
        fy = record['intrinsics'][1, 1]
        cx = record['intrinsics'][0, 2]
        cy = record['intrinsics'][1, 2]
        x_cam = (valid_x.astype(np.float32) - cx) * depth_values / fx
        y_cam = (valid_y.astype(np.float32) - cy) * depth_values / fy
        points_cam = np.stack([x_cam, y_cam, depth_values], axis=-1)
        points_world = (
            record['rotation'].T @ (points_cam - record['translation'].reshape(1, 3)).T
        ).T.astype(np.float32)
        support = np.ones(points_world.shape[0], dtype=np.int32)

        neighbor_positions = neighbor_positions_by_record[record_pos]
        for neighbor_pos in neighbor_positions:
            neighbor = records[neighbor_pos]
            height, width = neighbor['depth'].shape[:2]
            u, v, z, in_bounds = _project_world_points_to_image(
                points_world,
                rotation=neighbor['rotation'],
                translation=neighbor['translation'],
                intrinsics=neighbor['intrinsics'],
                width=width,
                height=height,
            )
            if not np.any(in_bounds):
                continue
            xi = np.rint(u[in_bounds]).astype(np.int32)
            yi = np.rint(v[in_bounds]).astype(np.int32)
            xi = np.clip(xi, 0, width - 1)
            yi = np.clip(yi, 0, height - 1)
            neighbor_valid = neighbor['prior_valid'][yi, xi]
            neighbor_depth = neighbor['depth'][yi, xi]
            z_valid = z[in_bounds]
            denom = np.maximum(np.maximum(np.abs(neighbor_depth), np.abs(z_valid)), 1e-3)
            agrees = neighbor_valid & (np.abs(z_valid - neighbor_depth) / denom <= depth_agreement_tolerance)
            in_bounds_indices = np.flatnonzero(in_bounds)
            support[in_bounds_indices[agrees]] += 1

        keep = support >= min_support_views
        support_rejected_count += int((~keep).sum())
        if not np.any(keep):
            continue

        colors = record['image'][valid_y[keep], valid_x[keep]].astype(np.float32)
        confidence = record['confidence'][valid_y[keep], valid_x[keep]].astype(np.float32)
        weights = np.clip(confidence, 0.05, 1.0) * support[keep].astype(np.float32)
        accepted_points.append(points_world[keep])
        accepted_colors.append(colors)
        accepted_weights.append(weights)

    if not accepted_points:
        return {
            **_empty_metric3d_init(requested=True, reason='metric3d_no_multiview_consistent_hole_points'),
            'candidatePointCount': int(source_candidate_count),
            'calibratedImageCount': int(len(records)),
            'calibrationAnchorCount': int(calibration_anchor_count),
            'maskExcludedPixelCount': int(masks_excluded_pixel_count),
            'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
            'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
            'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
            'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
            'maxReflectiveCoverage': float(max_reflective_coverage),
            'sfmCoveredPixelCount': int(sfm_covered_pixel_count),
            'supportRejectedPointCount': int(support_rejected_count),
            'initMode': 'fused_hole_fill',
        }

    candidate_points = np.concatenate(accepted_points, axis=0).astype(np.float32)
    candidate_colors = np.concatenate(accepted_colors, axis=0).astype(np.float32)
    candidate_weights = np.concatenate(accepted_weights, axis=0).astype(np.float32)
    fused_points, fused_colors, fused_weights, downsampled, voxel_size = _weighted_voxel_fuse_points(
        candidate_points,
        candidate_colors,
        candidate_weights,
        max_points=max_points,
    )

    return {
        'requested': True,
        'candidatePointCount': int(source_candidate_count),
        'selectedPointCount': int(fused_points.shape[0]),
        'calibratedImageCount': int(len(records)),
        'calibrationAnchorCount': int(calibration_anchor_count),
        'pointBudgetPerImage': int(point_budget_per_image),
        'maskExcludedPixelCount': int(masks_excluded_pixel_count),
        'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
        'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
        'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
        'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
        'maxReflectiveCoverage': float(max_reflective_coverage),
        'sfmCoveredPixelCount': int(sfm_covered_pixel_count),
        'supportRejectedPointCount': int(support_rejected_count),
        'multiviewAcceptedPointCount': int(candidate_points.shape[0]),
        'fusedPointCount': int(fused_points.shape[0]),
        'minSupportViews': int(min_support_views),
        'depthAgreementTolerance': float(depth_agreement_tolerance),
        'neighborViewCount': int(neighbor_view_count),
        'sfmCoverageRadiusPx': int(sfm_coverage_radius_px),
        'voxelSize': float(voxel_size),
        'initMode': 'fused_hole_fill',
        'downsampled': bool(downsampled),
        'reason': None,
        'points': fused_points,
        'colors': fused_colors,
        'weights': fused_weights,
    }


def _load_metric3d_init_points(
    *,
    images_dir: Path,
    sfm_text_model_dir: Path,
    metric3d_dir: Path | None,
    max_points: int,
    point_budget_per_image: int = DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE,
    masks_dir: Path | None = None,
    mirror_exclusion_band_px: int = 0,
    max_mirror_exclusion_band_px: int | None = None,
    mirror_exclusion_band_coverage_scale_px: float = 0.0,
    reflective_skip_coverage_threshold: float = 0.0,
) -> dict:
    if metric3d_dir is None:
        return _empty_metric3d_init(requested=False)
    if max_points <= 0:
        return _empty_metric3d_init(requested=True, reason='metric3d_init_budget_exhausted')
    if DENSE_EVIDENCE is None:
        return _empty_metric3d_init(
            requested=True,
            reason=f'metric3d_helper_import_failed:{DENSE_EVIDENCE_IMPORT_ERROR}',
        )
    if not metric3d_dir.exists():
        return _empty_metric3d_init(
            requested=True,
            reason=f'metric3d_dir_missing:{metric3d_dir}',
        )

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    points_path = sfm_text_model_dir / 'points3D.txt'
    if not cameras_path.exists() or not images_path.exists() or not points_path.exists():
        return _empty_metric3d_init(requested=True, reason='metric3d_alignment_inputs_missing')

    cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
    images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
    points_by_id = DENSE_EVIDENCE.parse_colmap_points_lookup(points_path)
    if not cameras or not images_meta or not points_by_id:
        return _empty_metric3d_init(requested=True, reason='metric3d_alignment_inputs_missing')

    import cv2

    priors_are_aligned = _depth_priors_are_post_sfm_aligned(metric3d_dir)
    masks_manifest = None
    masks_excluded_pixel_count = 0
    if masks_dir is not None and SEMANTIC_MASKS is not None:
        try:
            masks_manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
        except Exception:
            masks_manifest = None

    metric3d_points: list[np.ndarray] = []
    metric3d_colors: list[np.ndarray] = []
    metric3d_weights: list[np.ndarray] = []
    calibrated_image_count = 0
    calibration_anchor_count = 0
    mirror_exclusion_band_px = int(max(0, mirror_exclusion_band_px))
    max_mirror_exclusion_band_px = int(
        max(
            mirror_exclusion_band_px,
            max_mirror_exclusion_band_px if max_mirror_exclusion_band_px is not None else mirror_exclusion_band_px,
        )
    )
    mirror_exclusion_band_coverage_scale_px = max(0.0, float(mirror_exclusion_band_coverage_scale_px))
    reflective_skip_coverage_threshold = min(max(float(reflective_skip_coverage_threshold), 0.0), 1.0)
    mirror_exclusion_kernel_cache: dict[int, np.ndarray] = {}
    skipped_reflective_frame_count = 0
    max_reflective_coverage = 0.0
    max_dynamic_mirror_exclusion_band_px = mirror_exclusion_band_px

    def get_mirror_exclusion_kernel(band_px: int) -> np.ndarray | None:
        band_px = int(max(0, band_px))
        if band_px <= 0:
            return None
        kernel = mirror_exclusion_kernel_cache.get(band_px)
        if kernel is None:
            kernel_size = (band_px * 2) + 1
            kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
            mirror_exclusion_kernel_cache[band_px] = kernel
        return kernel

    for image_name, image_data in sorted(images_meta.items()):
        depth_path = metric3d_dir / 'depth' / f'{Path(image_name).stem}_depth.npy'
        confidence_path = metric3d_dir / 'confidence' / f'{Path(image_name).stem}_confidence.npy'
        image_path = images_dir / image_name
        if not depth_path.exists() or not confidence_path.exists() or not image_path.exists():
            continue

        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        depth_map = np.load(depth_path).astype(np.float32)
        confidence_map = np.load(confidence_path).astype(np.float32)
        if priors_are_aligned:
            calibrated_depth_map = depth_map
            calibration = {'applied': True, 'anchorCount': 0}
        else:
            calibrated_depth_map, calibration = DENSE_EVIDENCE.calibrate_metric3d_depth_map(
                depth_map,
                confidence_map,
                image_data,
                camera,
                points_by_id,
            )
        calibration_anchor_count += int(calibration.get('anchorCount', 0) or 0)
        if not calibration.get('applied'):
            continue
        calibrated_image_count += 1

        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        if image.shape[:2] != calibrated_depth_map.shape[:2]:
            image = cv2.resize(image, (calibrated_depth_map.shape[1], calibrated_depth_map.shape[0]))

        intrinsics = np.asarray(DENSE_EVIDENCE.get_intrinsics_matrix(camera), dtype=np.float32)
        rotation, translation = DENSE_EVIDENCE.get_camera_extrinsics(image_data)
        rotation = np.asarray(rotation, dtype=np.float32)
        translation = np.asarray(translation, dtype=np.float32).reshape(3)
        fx, fy, cx, cy = intrinsics[0, 0], intrinsics[1, 1], intrinsics[0, 2], intrinsics[1, 2]

        height, width = calibrated_depth_map.shape[:2]
        u_coords, v_coords = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        valid = (
            np.isfinite(calibrated_depth_map)
            & np.isfinite(confidence_map)
            & (calibrated_depth_map > 0.05)
            & (calibrated_depth_map < 50.0)
            & (confidence_map > 0.2)
        )

        # Mask-aware seeding: drop mirror/window/glass pixels so reflective or
        # transmissive surfaces do not seed phantom gaussians.
        if masks_manifest is not None:
            try:
                frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, masks_manifest)
            except Exception:
                frame_masks = {}
            exclusion = None
            raw_class_masks: dict[str, np.ndarray] = {}
            reflective_union = None
            mirror_coverage = 0.0
            for class_name in ('mirror', 'window', 'glass'):
                class_mask = frame_masks.get(class_name)
                if class_mask is None:
                    continue
                class_mask = np.asarray(class_mask)
                if class_mask.shape[:2] != (height, width):
                    class_mask = cv2.resize(
                        class_mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST
                    )
                class_bool = class_mask.astype(bool)
                raw_class_masks[class_name] = class_bool
                reflective_union = class_bool if reflective_union is None else (reflective_union | class_bool)
                if class_name == 'mirror':
                    mirror_coverage = float(class_bool.mean())
            reflective_coverage = float(reflective_union.mean()) if reflective_union is not None else 0.0
            max_reflective_coverage = max(max_reflective_coverage, reflective_coverage)
            if (
                reflective_skip_coverage_threshold > 0.0
                and mirror_coverage >= reflective_skip_coverage_threshold
            ):
                skipped_reflective_frame_count += 1
                continue

            frame_mirror_exclusion_band_px = mirror_exclusion_band_px
            if mirror_exclusion_band_px > 0 and mirror_coverage > 0.0:
                coverage_bonus_px = int(round(mirror_coverage * mirror_exclusion_band_coverage_scale_px))
                frame_mirror_exclusion_band_px = min(
                    max_mirror_exclusion_band_px,
                    mirror_exclusion_band_px + max(0, coverage_bonus_px),
                )
            max_dynamic_mirror_exclusion_band_px = max(
                max_dynamic_mirror_exclusion_band_px,
                int(frame_mirror_exclusion_band_px),
            )
            mirror_exclusion_kernel = get_mirror_exclusion_kernel(frame_mirror_exclusion_band_px)

            for class_name, class_bool in raw_class_masks.items():
                if class_name == 'mirror' and mirror_exclusion_kernel is not None and np.any(class_bool):
                    class_bool = cv2.dilate(
                        class_bool.astype(np.uint8),
                        mirror_exclusion_kernel,
                        iterations=1,
                    ).astype(bool)
                exclusion = class_bool if exclusion is None else (exclusion | class_bool)
            if exclusion is not None and np.any(exclusion):
                masks_excluded_pixel_count += int((valid & exclusion).sum())
                valid &= ~exclusion

        if not np.any(valid):
            continue

        x_cam = (u_coords - cx) * calibrated_depth_map / fx
        y_cam = (v_coords - cy) * calibrated_depth_map / fy
        points_cam = np.stack([x_cam[valid], y_cam[valid], calibrated_depth_map[valid]], axis=-1)
        colors = image[valid].astype(np.float32) / 255.0
        points_world = (rotation.T @ (points_cam - translation).T).T

        point_budget = max(1, int(point_budget_per_image))
        sampled_points, sampled_colors, sampled_weights, _ = _subsample_points(
            points_world.astype(np.float32),
            colors.astype(np.float32),
            point_budget,
            weights=confidence_map[valid].astype(np.float32),
        )
        finite_mask = (
            np.isfinite(sampled_points).all(axis=1)
            & np.isfinite(sampled_colors).all(axis=1)
            & np.isfinite(sampled_weights)
        )
        sampled_points = sampled_points[finite_mask]
        sampled_colors = sampled_colors[finite_mask]
        sampled_weights = np.clip(sampled_weights[finite_mask], 0.05, 1.0)
        if sampled_points.size == 0:
            continue

        metric3d_points.append(sampled_points.astype(np.float32))
        metric3d_colors.append(sampled_colors.astype(np.float32))
        metric3d_weights.append(sampled_weights.astype(np.float32))

    if not metric3d_points:
        return {
            **_empty_metric3d_init(requested=True, reason='metric3d_no_calibrated_points'),
            'calibratedImageCount': calibrated_image_count,
            'calibrationAnchorCount': calibration_anchor_count,
            'maskExcludedPixelCount': int(masks_excluded_pixel_count),
            'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
            'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
            'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
            'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
            'maxReflectiveCoverage': float(max_reflective_coverage),
        }

    candidate_points = np.concatenate(metric3d_points, axis=0).astype(np.float32)
    candidate_colors = np.concatenate(metric3d_colors, axis=0).astype(np.float32)
    candidate_weights = np.concatenate(metric3d_weights, axis=0).astype(np.float32)
    finite_mask = (
        np.isfinite(candidate_points).all(axis=1)
        & np.isfinite(candidate_colors).all(axis=1)
        & np.isfinite(candidate_weights)
    )
    candidate_points = candidate_points[finite_mask]
    candidate_colors = candidate_colors[finite_mask]
    candidate_weights = candidate_weights[finite_mask]

    if candidate_points.shape[0] == 0:
        return {
            **_empty_metric3d_init(requested=True, reason='metric3d_no_finite_points'),
            'calibratedImageCount': calibrated_image_count,
            'calibrationAnchorCount': calibration_anchor_count,
            'maskExcludedPixelCount': int(masks_excluded_pixel_count),
            'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
            'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
            'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
            'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
            'maxReflectiveCoverage': float(max_reflective_coverage),
        }

    selected_points, selected_colors, selected_weights, downsampled = _subsample_points(
        candidate_points,
        candidate_colors,
        max_points,
        weights=candidate_weights,
    )
    return {
        'requested': True,
        'candidatePointCount': int(candidate_points.shape[0]),
        'selectedPointCount': int(selected_points.shape[0]),
        'calibratedImageCount': int(calibrated_image_count),
        'calibrationAnchorCount': int(calibration_anchor_count),
        'pointBudgetPerImage': int(point_budget_per_image),
        'maskExcludedPixelCount': int(masks_excluded_pixel_count),
        'mirrorExclusionBandPx': int(mirror_exclusion_band_px),
        'maxMirrorExclusionBandPx': int(max_dynamic_mirror_exclusion_band_px),
        'reflectiveSkipCoverageThreshold': float(reflective_skip_coverage_threshold),
        'skippedReflectiveFrameCount': int(skipped_reflective_frame_count),
        'maxReflectiveCoverage': float(max_reflective_coverage),
        'downsampled': bool(downsampled),
        'reason': None,
        'points': selected_points,
        'colors': selected_colors,
        'weights': selected_weights,
    }


def _build_depth_supervision(
    *,
    images_dir: Path,
    sfm_text_model_dir: Path,
    metric3d_dir: Path | None,
    masks_dir: Path | None = None,
) -> dict:
    """Produce per-image aligned depth-prior maps (camera-space Z, aligned to
    the COLMAP/global_sfm scale) plus confidence and window/glass exclusion masks for
    use as a depth-supervision signal during gaussian training.

    Returns a dict keyed by COLMAP image name -> {'depth', 'confidence', 'exclude'}
    where 'depth'/'confidence' are float32 HxW arrays and 'exclude' is a bool HxW
    array (True where the depth signal must be ignored, e.g. window/glass pixels).
    Returns {} gracefully when inputs are missing so training proceeds photometric-only.
    """
    if metric3d_dir is None or DENSE_EVIDENCE is None or not metric3d_dir.exists():
        return {}

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    points_path = sfm_text_model_dir / 'points3D.txt'
    if not cameras_path.exists() or not images_path.exists() or not points_path.exists():
        return {}

    try:
        cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
        images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
        points_by_id = DENSE_EVIDENCE.parse_colmap_points_lookup(points_path)
    except Exception:
        return {}
    if not cameras or not images_meta or not points_by_id:
        return {}

    import cv2

    priors_are_aligned = _depth_priors_are_post_sfm_aligned(metric3d_dir)
    masks_manifest = None
    if masks_dir is not None and SEMANTIC_MASKS is not None:
        try:
            masks_manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
        except Exception:
            masks_manifest = None

    supervision: dict[str, dict] = {}
    for image_name, image_data in sorted(images_meta.items()):
        depth_path = metric3d_dir / 'depth' / f'{Path(image_name).stem}_depth.npy'
        confidence_path = metric3d_dir / 'confidence' / f'{Path(image_name).stem}_confidence.npy'
        if not depth_path.exists() or not confidence_path.exists():
            continue

        camera = cameras.get(image_data['cam_id'])
        if not camera:
            continue

        try:
            depth_map = np.load(depth_path).astype(np.float32)
            confidence_map = np.load(confidence_path).astype(np.float32)
            if priors_are_aligned:
                calibrated_depth_map = depth_map
                calibration = {'applied': True, 'anchorCount': 0}
            else:
                calibrated_depth_map, calibration = DENSE_EVIDENCE.calibrate_metric3d_depth_map(
                    depth_map,
                    confidence_map,
                    image_data,
                    camera,
                    points_by_id,
                )
        except Exception:
            continue
        if not calibration.get('applied'):
            continue

        height, width = calibrated_depth_map.shape[:2]
        if confidence_map.shape[:2] != (height, width):
            confidence_map = cv2.resize(
                confidence_map, (width, height), interpolation=cv2.INTER_LINEAR
            )

        exclude = np.zeros((height, width), dtype=bool)
        # Reflective/transmissive surfaces are explicitly treated as no-trust
        # supervision in the simplified gaussian-only path.
        if masks_manifest is not None:
            try:
                frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, masks_manifest)
            except Exception:
                frame_masks = {}
            for class_name in ('mirror', 'window', 'glass'):
                class_mask = frame_masks.get(class_name)
                if class_mask is None:
                    continue
                class_mask = np.asarray(class_mask)
                if class_mask.shape[:2] != (height, width):
                    class_mask = cv2.resize(
                        class_mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST
                    )
                exclude |= class_mask.astype(bool)

        supervision[image_name] = {
            'depth': calibrated_depth_map.astype(np.float32),
            'confidence': confidence_map.astype(np.float32),
            'exclude': exclude,
        }

    return supervision


def _build_mirror_reflection_planes(
    *,
    sfm_text_model_dir: Path,
    masks_dir: Path | None,
    require_reflection_baking: bool = True,
) -> list[dict]:
    """Transform per-frame camera-space mirror planes (written to planes.json by the
    Metric3D reflective-flattening stage) into clustered world-space planes for the
    gaussian mirror-baking step.

    Returns a list of {'normal': [nx, ny, nz], 'd': float, 'reflectivity': float,
    'frameCount': int} where each plane satisfies n·X_world + d = 0. Returns []
    gracefully when masks/planes/poses are unavailable so training is unaffected.
    """
    if (require_reflection_baking and not MIRROR_REFLECTION_BAKING) or masks_dir is None or ROOM_TOUR_WORKER is None:
        return []

    planes_path = Path(masks_dir) / 'planes.json'
    images_path = sfm_text_model_dir / 'images.txt'
    if not planes_path.exists() or not images_path.exists():
        return []

    try:
        planes_payload = json.loads(planes_path.read_text(encoding='utf-8'))
    except Exception:
        return []
    frames = planes_payload.get('frames')
    if not isinstance(frames, list) or not frames:
        return []

    try:
        images_meta = ROOM_TOUR_WORKER.parse_colmap_images_txt(images_path)
    except Exception:
        return []
    if not images_meta:
        return []

    world_planes: list[dict] = []
    for frame in frames:
        if not isinstance(frame, dict):
            continue
        mirror = (frame.get('planes') or {}).get('mirror')
        if not isinstance(mirror, dict):
            continue
        image_name = frame.get('image')
        image_data = images_meta.get(image_name)
        if image_data is None:
            continue
        try:
            n_cam = np.asarray(mirror['normal'], dtype=np.float64)
            d_cam = float(mirror['d'])
        except (KeyError, TypeError, ValueError):
            continue
        nrm = float(np.linalg.norm(n_cam))
        if nrm < 1e-8:
            continue
        n_cam = n_cam / nrm
        d_cam = d_cam / nrm

        try:
            R, t = ROOM_TOUR_WORKER.get_camera_extrinsics(image_data)
        except Exception:
            continue
        R = np.asarray(R, dtype=np.float64)
        t = np.asarray(t, dtype=np.float64).reshape(3)
        # camera plane n_cam·(R·X_world + t) + d = 0  ->  (R^T n_cam)·X_world + (n_cam·t + d) = 0
        n_world = R.T @ n_cam
        n_world = n_world / max(float(np.linalg.norm(n_world)), 1e-12)
        d_world = float(n_cam @ t) + d_cam
        world_planes.append({
            'normal': n_world,
            'd': d_world,
            'weight': float(mirror.get('pixelCount', 1) or 1),
        })

    if not world_planes:
        return []

    # Greedy cluster planes that share orientation and offset (sign-agnostic normal).
    clusters: list[dict] = []
    for plane in world_planes:
        n = plane['normal']
        d = plane['d']
        merged = False
        for cluster in clusters:
            cn = cluster['normal']
            dot = float(n @ cn)
            sign = 1.0 if dot >= 0 else -1.0
            if abs(dot) < 0.94:
                continue
            scale = max(abs(d), abs(cluster['d']), 1.0)
            if abs(sign * d - cluster['d']) > 0.08 * scale:
                continue
            w = plane['weight']
            cluster['normal'] = cn + sign * n * w
            cluster['normal'] = cluster['normal'] / max(float(np.linalg.norm(cluster['normal'])), 1e-12)
            cluster['d_sum'] += sign * d * w
            cluster['weight'] += w
            cluster['d'] = cluster['d_sum'] / cluster['weight']
            cluster['frameCount'] += 1
            merged = True
            break
        if not merged:
            clusters.append({
                'normal': n.copy(),
                'd': d,
                'd_sum': d * plane['weight'],
                'weight': plane['weight'],
                'frameCount': 1,
            })

    result: list[dict] = []
    for cluster in clusters:
        result.append({
            'normal': [float(value) for value in cluster['normal']],
            'd': float(cluster['d']),
            'reflectivity': MIRROR_REFLECTIVITY,
            'frameCount': int(cluster['frameCount']),
        })
    return result


def _run_mirror_gaussian_refinement(
    *,
    job_id: str,
    output_dir: Path,
    images_dir: Path,
    sfm_text_model_dir: Path,
    masks_dir: Path | None,
    mirror_planes: list[dict],
    command_template: str,
    source_splat_scene_path: Path,
    source_splat_ply_path: Path | None,
    source_viewer_html_path: Path | None,
) -> tuple[Path, Path | None, Path | None, dict]:
    summary = {
        'configured': True,
        'applied': False,
        'reason': None,
        'mirrorPlaneCount': int(len(mirror_planes)),
    }

    if not mirror_planes:
        summary['reason'] = 'mirror_gaussian_no_mirror_planes'
        return source_splat_scene_path, source_splat_ply_path, source_viewer_html_path, summary
    if masks_dir is None:
        summary['reason'] = 'mirror_gaussian_masks_missing'
        return source_splat_scene_path, source_splat_ply_path, source_viewer_html_path, summary
    if not source_splat_scene_path.exists():
        raise RuntimeError(f'mirror_gaussian_source_splat_missing:{source_splat_scene_path}')

    bundle_dir = ensure_dir(output_dir / 'mirror-gaussian')
    runner_output_dir = ensure_dir(bundle_dir / 'output')
    manifest_path = bundle_dir / 'manifest.json'
    result_path = bundle_dir / 'result.json'

    manifest = {
        'schemaVersion': 1,
        'jobId': job_id,
        'imagesDir': str(images_dir),
        'sfmTextModelDir': str(sfm_text_model_dir),
        'masksDir': str(masks_dir),
        'mirrorPlanes': mirror_planes,
        'sourceAssets': {
            'splatScenePath': str(source_splat_scene_path),
            'splatPlyPath': str(source_splat_ply_path) if source_splat_ply_path else None,
            'viewerHtmlPath': str(source_viewer_html_path) if source_viewer_html_path else None,
        },
        'runner': {
            'outputDir': str(runner_output_dir),
            'resultPath': str(result_path),
        },
    }
    write_json(manifest_path, manifest)

    try:
        formatted_command = command_template.format(
            job_id=job_id,
            bundle_dir=str(bundle_dir),
            manifest_path=str(manifest_path),
            result_path=str(result_path),
            output_dir=str(runner_output_dir),
            images_dir=str(images_dir),
            sfm_text_model_dir=str(sfm_text_model_dir),
            masks_dir=str(masks_dir),
            source_splat_scene_path=str(source_splat_scene_path),
            source_splat_ply_path=str(source_splat_ply_path) if source_splat_ply_path else '',
            source_viewer_html_path=str(source_viewer_html_path) if source_viewer_html_path else '',
        )
    except KeyError as exc:
        raise RuntimeError(f'mirror_gaussian_command_placeholder_missing:{exc.args[0]}') from exc

    command = shlex.split(formatted_command)
    if not command:
        raise RuntimeError('mirror_gaussian_command_empty')

    timeout_seconds = MIRROR_GAUSSIAN_TIMEOUT_SECONDS or None
    subprocess.run(command, check=True, timeout=timeout_seconds)

    if not result_path.exists():
        raise RuntimeError(f'mirror_gaussian_missing_result:{result_path}')
    try:
        result = json.loads(result_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise RuntimeError(f'mirror_gaussian_invalid_result:{exc}') from exc

    scene_path = _resolve_optional_path(
        result.get('splatScenePath') or result.get('sceneSplatPath'),
        base_dir=runner_output_dir,
    )
    if scene_path is None:
        raise RuntimeError('mirror_gaussian_missing_scene_splat_path')
    if not scene_path.exists():
        raise RuntimeError(f'mirror_gaussian_scene_splat_missing:{scene_path}')

    ply_path = _resolve_optional_path(
        result.get('splatPlyPath') or result.get('scenePlyPath'),
        base_dir=runner_output_dir,
    )
    if ply_path is not None and not ply_path.exists():
        raise RuntimeError(f'mirror_gaussian_scene_ply_missing:{ply_path}')

    viewer_path = _resolve_optional_path(result.get('viewerHtmlPath'), base_dir=runner_output_dir)
    if viewer_path is not None and not viewer_path.exists():
        raise RuntimeError(f'mirror_gaussian_viewer_missing:{viewer_path}')
    if viewer_path is None:
        viewer_path = _build_splat_viewer_html(runner_output_dir / 'viewer', f'{job_id}-mirror-gaussian')

    overlay_scene_path = _resolve_optional_path(
        result.get('overlaySplatScenePath') or result.get('overlaySceneSplatPath'),
        base_dir=runner_output_dir,
    )
    if overlay_scene_path is not None and not overlay_scene_path.exists():
        raise RuntimeError(f'mirror_gaussian_overlay_scene_splat_missing:{overlay_scene_path}')

    summary.update({
        'applied': True,
        'reason': 'mirror_gaussian_completed',
        'manifestPath': str(manifest_path),
        'resultPath': str(result_path),
        'outputDir': str(runner_output_dir),
        'command': formatted_command,
        'debugSplatScenePath': str(scene_path),
        'debugSplatPlyPath': str(ply_path) if ply_path else None,
        'debugViewerHtmlPath': str(viewer_path) if viewer_path else None,
        'overlaySplatScenePath': str(overlay_scene_path) if overlay_scene_path else None,
        'overlayPointCount': int(result.get('overlayPointCount', 0) or 0),
        'overlayMinOpacity': float(result.get('overlayMinOpacity', 0) or 0),
        'pointCount': int(result.get('pointCount', 0) or 0),
    })
    return source_splat_scene_path, source_splat_ply_path, source_viewer_html_path, summary


def _run_ref_gaussian_fork(
    *,
    job_id: str,
    output_dir: Path,
    images_dir: Path,
    sfm_text_model_dir: Path,
    depth_priors_dir: Path | None,
    masks_dir: Path | None,
    max_init_points: int,
    depth_priors_max_points_per_image: int,
    sparse_point_count: int,
    command_template: str,
    source_splat_scene_path: Path | None,
    source_splat_ply_path: Path | None,
    source_viewer_html_path: Path | None,
) -> dict:
    summary = {
        'configured': True,
        'applied': False,
        'required': False,
        'reason': None,
        'trainingMaskMode': 'metadata_only',
    }

    bundle_dir = ensure_dir(output_dir / 'ref-gaussian')
    runner_output_dir = ensure_dir(bundle_dir / 'output')
    manifest_path = bundle_dir / 'manifest.json'
    result_path = bundle_dir / 'result.json'

    manifest = {
        'schemaVersion': 1,
        'jobId': job_id,
        'imagesDir': str(images_dir),
        'sfmTextModelDir': str(sfm_text_model_dir),
        # RefGaussian should see the original reflective pixels. Masks are only
        # carried for evaluation and labeling, not for train-time cutouts.
        'masksDir': str(masks_dir) if masks_dir else None,
        'trainingMaskMode': 'metadata_only',
        'depthPriors': {
            'requested': bool(depth_priors_dir is not None),
            'dir': str(depth_priors_dir) if depth_priors_dir else None,
            'maxInitPoints': int(max_init_points),
            'pointBudgetPerImage': int(depth_priors_max_points_per_image),
            'sparsePointCount': int(sparse_point_count),
            'defaultMode': os.environ.get('MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE', 'light').strip().lower(),
        },
        'sourceAssets': {
            'splatScenePath': str(source_splat_scene_path) if source_splat_scene_path else None,
            'splatPlyPath': str(source_splat_ply_path) if source_splat_ply_path else None,
            'viewerHtmlPath': str(source_viewer_html_path) if source_viewer_html_path else None,
        },
        'runner': {
            'outputDir': str(runner_output_dir),
            'resultPath': str(result_path),
        },
    }
    write_json(manifest_path, manifest)

    try:
        formatted_command = command_template.format(
            job_id=job_id,
            bundle_dir=str(bundle_dir),
            manifest_path=str(manifest_path),
            result_path=str(result_path),
            output_dir=str(runner_output_dir),
            images_dir=str(images_dir),
            sfm_text_model_dir=str(sfm_text_model_dir),
            masks_dir=str(masks_dir) if masks_dir else '',
            source_splat_scene_path=str(source_splat_scene_path) if source_splat_scene_path else '',
            source_splat_ply_path=str(source_splat_ply_path) if source_splat_ply_path else '',
            source_viewer_html_path=str(source_viewer_html_path) if source_viewer_html_path else '',
        )
    except KeyError as exc:
        raise RuntimeError(f'ref_gaussian_command_placeholder_missing:{exc.args[0]}') from exc

    command = shlex.split(formatted_command)
    if not command:
        raise RuntimeError('ref_gaussian_command_empty')

    timeout_seconds = REF_GAUSSIAN_TIMEOUT_SECONDS or None
    subprocess.run(command, check=True, timeout=timeout_seconds)

    if not result_path.exists():
        raise RuntimeError(f'ref_gaussian_missing_result:{result_path}')
    try:
        result = json.loads(result_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise RuntimeError(f'ref_gaussian_invalid_result:{exc}') from exc

    scene_path = _resolve_optional_path(
        result.get('splatScenePath') or result.get('sceneSplatPath'),
        base_dir=runner_output_dir,
    )
    if scene_path is not None and not scene_path.exists():
        raise RuntimeError(f'ref_gaussian_scene_splat_missing:{scene_path}')

    ply_path = _resolve_optional_path(
        result.get('splatPlyPath') or result.get('scenePlyPath'),
        base_dir=runner_output_dir,
    )
    if ply_path is not None and not ply_path.exists():
        raise RuntimeError(f'ref_gaussian_scene_ply_missing:{ply_path}')

    viewer_path = _resolve_optional_path(result.get('viewerHtmlPath'), base_dir=runner_output_dir)
    if viewer_path is not None and not viewer_path.exists():
        raise RuntimeError(f'ref_gaussian_viewer_missing:{viewer_path}')
    if viewer_path is None and scene_path is not None:
        viewer_path = _build_splat_viewer_html(runner_output_dir / 'viewer', f'{job_id}-ref-gaussian')
    if viewer_path is None and scene_path is None and ply_path is None:
        raise RuntimeError('ref_gaussian_missing_viewable_artifact')

    native_render_contract = result.get('nativeRenderContract') or None
    raw_native_render_contract_path = result.get('nativeRenderContractPath')
    if not raw_native_render_contract_path and native_render_contract:
        raw_native_render_contract_path = native_render_contract.get('path')
    native_render_contract_path = _resolve_optional_path(raw_native_render_contract_path, base_dir=runner_output_dir)
    if native_render_contract_path is not None and not native_render_contract_path.exists():
        raise RuntimeError(f'ref_gaussian_native_render_contract_missing:{native_render_contract_path}')

    point_count = int(result.get('pointCount', 0) or 0)
    if point_count <= 0 and scene_path is not None:
        try:
            point_count = int(_read_splat_records(scene_path).shape[0])
        except Exception:
            point_count = 0

    summary.update({
        'applied': True,
        'reason': 'ref_gaussian_completed',
        'manifestPath': str(manifest_path),
        'resultPath': str(result_path),
        'outputDir': str(runner_output_dir),
        'command': formatted_command,
        'method': result.get('method') or 'ref_gaussian_adapter',
        'renderMode': result.get('renderMode') or 'ref_gaussian_viewer',
        'modelDir': result.get('modelDir'),
        'viewerHtmlPath': str(viewer_path) if viewer_path else None,
        'splatScenePath': str(scene_path) if scene_path else None,
        'splatPlyPath': str(ply_path) if ply_path else None,
        'pointCount': point_count,
        'trainingMaskMode': result.get('trainingMaskMode') or 'metadata_only',
        'adaptiveTraining': result.get('adaptiveTraining'),
        'dataset': result.get('dataset'),
        'cleanupSummary': result.get('cleanupSummary'),
        'refGaussianBundle': result.get('refGaussianBundle'),
        'refGaussianBundleJsonPath': result.get('refGaussianBundleJsonPath'),
        'refGaussianBundleBinPath': result.get('refGaussianBundleBinPath'),
        'refGaussianBundleError': result.get('refGaussianBundleError'),
        'nativeRender': result.get('nativeRender'),
        'nativeRenderError': result.get('nativeRenderError'),
        'nativeRenderContract': native_render_contract,
        'nativeRenderContractPath': str(native_render_contract_path) if native_render_contract_path else None,
        'nativeRenderContractManifestPath': result.get('nativeRenderContractManifestPath'),
        'nativeRenderContractError': result.get('nativeRenderContractError'),
    })
    return summary


def _run_scaffold_gs_fork(
    *,
    job_id: str,
    output_dir: Path,
    images_dir: Path,
    sfm_text_model_dir: Path,
    depth_priors_dir: Path | None,
    masks_dir: Path | None,
    max_init_points: int,
    depth_priors_max_points_per_image: int,
    sparse_point_count: int,
    command_template: str,
    source_splat_scene_path: Path | None,
    source_splat_ply_path: Path | None,
    source_viewer_html_path: Path | None,
) -> dict:
    summary = {
        'configured': True,
        'applied': False,
        'required': False,
        'reason': None,
        'trainingMaskMode': 'metadata_only',
    }

    bundle_dir = ensure_dir(output_dir / 'scaffold-gs')
    runner_output_dir = ensure_dir(bundle_dir / 'output')
    manifest_path = bundle_dir / 'manifest.json'
    result_path = bundle_dir / 'result.json'

    manifest = {
        'schemaVersion': 1,
        'jobId': job_id,
        'backend': 'scaffold_gs',
        'imagesDir': str(images_dir),
        'sfmTextModelDir': str(sfm_text_model_dir),
        'masksDir': str(masks_dir) if masks_dir else None,
        'trainingMaskMode': 'metadata_only',
        'depthPriors': {
            'requested': bool(depth_priors_dir is not None),
            'dir': str(depth_priors_dir) if depth_priors_dir else None,
            'maxInitPoints': int(max_init_points),
            'pointBudgetPerImage': int(depth_priors_max_points_per_image),
            'sparsePointCount': int(sparse_point_count),
        },
        'sourceAssets': {
            'splatScenePath': str(source_splat_scene_path) if source_splat_scene_path else None,
            'splatPlyPath': str(source_splat_ply_path) if source_splat_ply_path else None,
            'viewerHtmlPath': str(source_viewer_html_path) if source_viewer_html_path else None,
        },
        'runner': {
            'outputDir': str(runner_output_dir),
            'resultPath': str(result_path),
        },
    }
    write_json(manifest_path, manifest)

    try:
        formatted_command = command_template.format(
            job_id=job_id,
            bundle_dir=str(bundle_dir),
            manifest_path=str(manifest_path),
            result_path=str(result_path),
            output_dir=str(runner_output_dir),
            images_dir=str(images_dir),
            sfm_text_model_dir=str(sfm_text_model_dir),
            masks_dir=str(masks_dir) if masks_dir else '',
            depth_priors_dir=str(depth_priors_dir) if depth_priors_dir else '',
            source_splat_scene_path=str(source_splat_scene_path) if source_splat_scene_path else '',
            source_splat_ply_path=str(source_splat_ply_path) if source_splat_ply_path else '',
            source_viewer_html_path=str(source_viewer_html_path) if source_viewer_html_path else '',
        )
    except KeyError as exc:
        raise RuntimeError(f'scaffold_gs_command_placeholder_missing:{exc.args[0]}') from exc

    command = shlex.split(formatted_command)
    if not command:
        raise RuntimeError('scaffold_gs_command_empty')

    timeout_seconds = SCAFFOLD_GS_TIMEOUT_SECONDS or None
    subprocess.run(command, check=True, timeout=timeout_seconds)

    if not result_path.exists():
        raise RuntimeError(f'scaffold_gs_missing_result:{result_path}')
    try:
        result = json.loads(result_path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise RuntimeError(f'scaffold_gs_invalid_result:{exc}') from exc

    scene_path = _resolve_optional_path(
        result.get('splatScenePath') or result.get('sceneSplatPath'),
        base_dir=runner_output_dir,
    )
    if scene_path is not None and not scene_path.exists():
        raise RuntimeError(f'scaffold_gs_scene_splat_missing:{scene_path}')

    ply_path = _resolve_optional_path(
        result.get('splatPlyPath') or result.get('scenePlyPath'),
        base_dir=runner_output_dir,
    )
    if ply_path is not None and not ply_path.exists():
        raise RuntimeError(f'scaffold_gs_scene_ply_missing:{ply_path}')

    viewer_path = _resolve_optional_path(result.get('viewerHtmlPath'), base_dir=runner_output_dir)
    if viewer_path is not None and not viewer_path.exists():
        raise RuntimeError(f'scaffold_gs_viewer_missing:{viewer_path}')
    if viewer_path is None and scene_path is not None:
        viewer_path = _build_splat_viewer_html(runner_output_dir / 'viewer', f'{job_id}-scaffold-gs')
    if viewer_path is None and scene_path is None and ply_path is None:
        raise RuntimeError('scaffold_gs_missing_viewable_artifact')

    point_count = int(result.get('pointCount', 0) or 0)
    if point_count <= 0 and scene_path is not None:
        try:
            point_count = int(_read_splat_records(scene_path).shape[0])
        except Exception:
            point_count = 0

    summary.update({
        'applied': True,
        'reason': 'scaffold_gs_completed',
        'manifestPath': str(manifest_path),
        'resultPath': str(result_path),
        'outputDir': str(runner_output_dir),
        'command': formatted_command,
        'method': result.get('method') or 'scaffold_gs_adapter',
        'renderMode': result.get('renderMode') or 'converted_splat_fallback',
        'modelDir': result.get('modelDir'),
        'viewerHtmlPath': str(viewer_path) if viewer_path else None,
        'splatScenePath': str(scene_path) if scene_path else None,
        'splatPlyPath': str(ply_path) if ply_path else None,
        'pointCount': point_count,
        'nativeSummary': result.get('nativeSummary'),
    })
    return summary


def build_summary(
    *,
    job_id: str,
    output_dir: Path,
    dry_run: bool,
    status: str,
    reason: str | None,
    registered_image_count: int,
    sparse_point_count: int,
    init_point_count: int,
    gsplat_iterations: int,
    downsampled_init_points: bool,
    splat_scene_path: Path | None,
    splat_ply_path: Path | None,
    viewer_html_path: Path | None,
    runtime_available: bool,
    init_point_source: str = 'global_sfm_points3d',
    depth_priors: dict | None = None,
    point_count: int = 0,
    raw_splat_scene_path: Path | None = None,
    raw_splat_ply_path: Path | None = None,
    raw_viewer_html_path: Path | None = None,
    gaussian_postprocess: dict | None = None,
    mirror_gaussian: dict | None = None,
    ref_gaussian: dict | None = None,
    scaffold_gs: dict | None = None,
) -> dict:
    depth_priors = depth_priors or _empty_metric3d_init(requested=False)
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'status': status,
        'reason': reason,
        'runtimeAvailable': runtime_available,
        'registeredImageCount': int(registered_image_count),
        'sparsePointCount': int(sparse_point_count),
        'initPointCount': int(init_point_count),
        'initPointSource': init_point_source,
        'downsampledInitPoints': downsampled_init_points,
        'depthPriorsRequested': bool(depth_priors.get('requested', False)),
        'depthPriorsCandidatePointCount': int(depth_priors.get('candidatePointCount', 0) or 0),
        'depthPriorsInitPointCount': int(depth_priors.get('selectedPointCount', 0) or 0),
        'depthPriorsAlignedImageCount': int(depth_priors.get('calibratedImageCount', 0) or 0),
        'depthPriorsCalibrationAnchorCount': int(depth_priors.get('calibrationAnchorCount', 0) or 0),
        'depthPriorsPointBudgetPerImage': int(depth_priors.get('pointBudgetPerImage', 0) or 0),
        'depthPriorsDownsampled': bool(depth_priors.get('downsampled', False)),
        'depthPriorsReason': depth_priors.get('reason'),
        'gsplatIterations': int(gsplat_iterations),
        'pointCount': int(point_count),
        'splatScenePath': str(splat_scene_path) if splat_scene_path else None,
        'splatPlyPath': str(splat_ply_path) if splat_ply_path else None,
        'viewerHtmlPath': str(viewer_html_path) if viewer_html_path else None,
        'rawSplatScenePath': str(raw_splat_scene_path) if raw_splat_scene_path else None,
        'rawSplatPlyPath': str(raw_splat_ply_path) if raw_splat_ply_path else None,
        'rawViewerHtmlPath': str(raw_viewer_html_path) if raw_viewer_html_path else None,
        'gaussianPostprocess': gaussian_postprocess,
        'mirrorGaussian': mirror_gaussian,
        'refGaussian': ref_gaussian,
        'scaffoldGs': scaffold_gs,
        'note': 'Gaussian splatting runs as a post-GLOMAP side branch so mesh authoring remains the geometry authority while viewer splats stay optional.',
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def run_gaussian_splatting(
    *,
    job_id: str,
    images_dir: Path,
    sfm_text_model_dir: Path,
    depth_priors_dir: Path | None,
    output_dir: Path,
    dry_run: bool,
    gsplat_iterations: int,
    max_init_points: int,
    min_init_points: int,
    depth_priors_max_points_per_image: int = DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE,
    masks_dir: Path | None = None,
    training_max_anisotropy: float = 0.0,
    postprocess_largest_component_voxel: float = 0.0,
    postprocess_reflective_masked_support_ratio: float = 0.0,
    postprocess_reflective_masked_min_hits: int = 0,
    postprocess_reflective_masked_min_support_views: int = 0,
    postprocess_max_anisotropy_ratio: float = 0.0,
    postprocess_reflective_boundary_band_px: int = 0,
    postprocess_reflective_boundary_min_support_views: int = 0,
    postprocess_reflective_boundary_max_anisotropy_ratio: float = 0.0,
    mirror_gaussian_command: str = DEFAULT_MIRROR_GAUSSIAN_COMMAND,
    mirror_gaussian_required: bool = False,
    ref_gaussian_command: str = DEFAULT_REF_GAUSSIAN_COMMAND,
    ref_gaussian_required: bool = False,
    ref_gaussian_only: bool = False,
    scaffold_gs_command: str = DEFAULT_SCAFFOLD_GS_COMMAND,
    scaffold_gs_required: bool = False,
    scaffold_gs_only: bool = False,
) -> dict:
    mirror_gaussian_command = (mirror_gaussian_command or '').strip()
    if mirror_gaussian_required and not mirror_gaussian_command:
        raise RuntimeError('mirror_gaussian_required_without_command')
    ref_gaussian_command = (ref_gaussian_command or '').strip()
    if ref_gaussian_required and not ref_gaussian_command:
        raise RuntimeError('ref_gaussian_required_without_command')
    scaffold_gs_command = (scaffold_gs_command or '').strip()
    if scaffold_gs_required and not scaffold_gs_command:
        raise RuntimeError('scaffold_gs_required_without_command')

    native_output_dir = ensure_dir(output_dir / 'native-output')
    ensure_dir(output_dir / 'workspace')

    images_path = sfm_text_model_dir / 'images.txt'
    points_path = sfm_text_model_dir / 'points3D.txt'
    registered_image_count = _count_registered_images(images_path)
    sparse_points, sparse_colors, sparse_support = _parse_colmap_points3d(points_path)
    sparse_point_count = int(sparse_points.shape[0])
    gsplat_iterations = _resolve_effective_gsplat_iterations(gsplat_iterations, registered_image_count)
    max_init_points = (
        int(max_init_points)
        if scaffold_gs_only
        else _resolve_effective_max_init_points(max_init_points, registered_image_count)
    )
    depth_priors_init = _empty_metric3d_init(requested=depth_priors_dir is not None)

    if not ENABLE_GAUSSIAN_SPLATTING:
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=dry_run,
            status='skipped',
            reason='gaussian_splatting_disabled',
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=0,
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=False,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=False,
            depth_priors=depth_priors_init,
        )

    runtime_available = ROOM_TOUR_WORKER is not None
    if ROOM_TOUR_IMPORT_ERROR is not None and REQUIRE_GAUSSIAN_SPLATTING:
        raise RuntimeError(f'gaussian_splatting_runtime_import_failed:{ROOM_TOUR_IMPORT_ERROR}') from ROOM_TOUR_IMPORT_ERROR
    if ROOM_TOUR_IMPORT_ERROR is not None:
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=dry_run,
            status='skipped',
            reason=f'gaussian_splatting_runtime_import_failed:{ROOM_TOUR_IMPORT_ERROR}',
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=0,
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=False,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=False,
            depth_priors=depth_priors_init,
        )

    if dry_run:
        if depth_priors_dir is not None:
            depth_priors_init = _empty_metric3d_init(requested=True, reason='depth_priors_skipped_dry_run')
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=True,
            status='dry_run',
            reason=None,
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=min(int(sparse_points.shape[0]), int(max_init_points)),
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=bool(sparse_points.shape[0] > max_init_points),
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=runtime_available,
            depth_priors=depth_priors_init,
        )

    if not ref_gaussian_only and not scaffold_gs_only and not getattr(ROOM_TOUR_WORKER.torch.cuda, 'is_available', lambda: False)():
        if REQUIRE_GAUSSIAN_SPLATTING:
            raise RuntimeError('gaussian_splatting_requires_cuda')
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=False,
            status='skipped',
            reason='gaussian_splatting_requires_cuda',
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=0,
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=False,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=runtime_available,
            depth_priors=depth_priors_init,
        )

    sparse_downsampled = False
    init_points = sparse_points
    init_colors = sparse_colors
    init_weights = sparse_support
    if sparse_points.shape[0] > max_init_points:
        init_points, init_colors, init_weights, sparse_downsampled = _subsample_points(
            sparse_points,
            sparse_colors,
            max_init_points,
            weights=sparse_support,
        )
        if depth_priors_dir is not None:
            depth_priors_init = _empty_metric3d_init(requested=True, reason='depth_priors_init_budget_exhausted')
    elif depth_priors_dir is not None:
        depth_priors_init = _load_metric3d_init_points(
            images_dir=images_dir,
            sfm_text_model_dir=sfm_text_model_dir,
            metric3d_dir=depth_priors_dir,
            max_points=max(0, max_init_points - int(sparse_points.shape[0])),
            point_budget_per_image=depth_priors_max_points_per_image,
            masks_dir=masks_dir,
        )
        depth_prior_points = depth_priors_init['points']
        if depth_prior_points.shape[0] > 0:
            init_points = np.concatenate([sparse_points, depth_prior_points], axis=0)
            init_colors = np.concatenate([sparse_colors, depth_priors_init['colors']], axis=0)
            init_weights = np.concatenate([sparse_support, depth_priors_init['weights']], axis=0)

    init_points, init_colors, init_weights, extra_downsampled = _subsample_points(
        init_points,
        init_colors,
        max_init_points,
        weights=init_weights,
    )
    downsampled = bool(sparse_downsampled or depth_priors_init.get('downsampled', False) or extra_downsampled)
    init_point_source = (
        'global_sfm_points3d_plus_depth_priors_world'
        if int(depth_priors_init.get('selectedPointCount', 0) or 0) > 0
        else 'global_sfm_points3d'
    )

    if ref_gaussian_only or scaffold_gs_only:
        only_backend = 'scaffold_gs' if scaffold_gs_only else 'ref_gaussian'
        mirror_planes = (
            _build_mirror_reflection_planes(
                sfm_text_model_dir=sfm_text_model_dir,
                masks_dir=masks_dir,
                require_reflection_baking=False,
            )
            if ref_gaussian_only
            else []
        )
        mirror_gaussian = {
            'configured': bool(mirror_gaussian_command),
            'applied': False,
            'required': bool(mirror_gaussian_required),
            'reason': f'skipped_{only_backend}_only' if mirror_gaussian_command else 'mirror_gaussian_not_configured',
            'mirrorPlaneCount': int(len(mirror_planes)),
        }
        ref_gaussian = {
            'configured': bool(ref_gaussian_command),
            'applied': False,
            'required': bool(ref_gaussian_required),
            'reason': (
                'skipped_scaffold_gs_only'
                if scaffold_gs_only
                else ('ref_gaussian_not_configured' if not ref_gaussian_command else None)
            ),
            'trainingMaskMode': 'metadata_only',
        }
        scaffold_gs = {
            'configured': bool(scaffold_gs_command),
            'applied': False,
            'required': bool(scaffold_gs_required),
            'reason': (
                'skipped_ref_gaussian_only'
                if ref_gaussian_only
                else ('scaffold_gs_not_configured' if not scaffold_gs_command else None)
            ),
            'trainingMaskMode': 'metadata_only',
        }
        gaussian_postprocess = {
            'applied': False,
            'reason': f'skipped_{only_backend}_only',
        }
        point_count = 0

        if ref_gaussian_only and ref_gaussian_command:
            try:
                ref_gaussian = _run_ref_gaussian_fork(
                    job_id=job_id,
                    output_dir=output_dir,
                    images_dir=images_dir,
                    sfm_text_model_dir=sfm_text_model_dir,
                    depth_priors_dir=depth_priors_dir,
                    masks_dir=masks_dir,
                    max_init_points=max_init_points,
                    depth_priors_max_points_per_image=depth_priors_max_points_per_image,
                    sparse_point_count=sparse_point_count,
                    command_template=ref_gaussian_command,
                    source_splat_scene_path=None,
                    source_splat_ply_path=None,
                    source_viewer_html_path=None,
                )
                ref_gaussian['required'] = bool(ref_gaussian_required)
                point_count = int(ref_gaussian.get('pointCount', 0) or 0)
            except Exception as exc:
                if ref_gaussian_required:
                    raise RuntimeError(f'ref_gaussian_failed:{exc}') from exc
                ref_gaussian = {
                    'configured': True,
                    'applied': False,
                    'required': bool(ref_gaussian_required),
                    'reason': f'ref_gaussian_failed:{exc}',
                    'trainingMaskMode': 'metadata_only',
                }

        if scaffold_gs_only and scaffold_gs_command:
            try:
                scaffold_gs = _run_scaffold_gs_fork(
                    job_id=job_id,
                    output_dir=output_dir,
                    images_dir=images_dir,
                    sfm_text_model_dir=sfm_text_model_dir,
                    depth_priors_dir=depth_priors_dir,
                    masks_dir=masks_dir,
                    max_init_points=max_init_points,
                    depth_priors_max_points_per_image=depth_priors_max_points_per_image,
                    sparse_point_count=sparse_point_count,
                    command_template=scaffold_gs_command,
                    source_splat_scene_path=None,
                    source_splat_ply_path=None,
                    source_viewer_html_path=None,
                )
                scaffold_gs['required'] = bool(scaffold_gs_required)
                point_count = int(scaffold_gs.get('pointCount', 0) or 0)
            except Exception as exc:
                if scaffold_gs_required:
                    raise RuntimeError(f'scaffold_gs_failed:{exc}') from exc
                scaffold_gs = {
                    'configured': True,
                    'applied': False,
                    'required': bool(scaffold_gs_required),
                    'reason': f'scaffold_gs_failed:{exc}',
                    'trainingMaskMode': 'metadata_only',
                }

        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=False,
            status='completed',
            reason=f'{only_backend}_only_completed',
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=int(init_points.shape[0]),
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=downsampled,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=runtime_available,
            init_point_source=init_point_source,
            depth_priors=depth_priors_init,
            point_count=point_count,
            raw_splat_scene_path=None,
            raw_splat_ply_path=None,
            raw_viewer_html_path=None,
            gaussian_postprocess=gaussian_postprocess,
            mirror_gaussian=mirror_gaussian,
            ref_gaussian=ref_gaussian,
            scaffold_gs=scaffold_gs,
        )

    if init_points.shape[0] < min_init_points:
        reason = f'gaussian_splatting_insufficient_init_points:{init_points.shape[0]}'
        if REQUIRE_GAUSSIAN_SPLATTING:
            raise RuntimeError(reason)
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=False,
            status='skipped',
            reason=reason,
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=int(init_points.shape[0]),
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=downsampled,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=runtime_available,
            init_point_source=init_point_source,
            depth_priors=depth_priors_init,
        )

    try:
        ROOM_TOUR_WORKER.GSPLAT_ITERATIONS = int(gsplat_iterations)
        ROOM_TOUR_WORKER.GSPLAT_DENSIFY_START = max(500, int(round(gsplat_iterations * GSPLAT_DENSIFY_START_FRACTION)))
        ROOM_TOUR_WORKER.GSPLAT_DENSIFY_STOP = max(
            ROOM_TOUR_WORKER.GSPLAT_DENSIFY_START,
            int(round(gsplat_iterations * GSPLAT_DENSIFY_STOP_FRACTION)),
        )
        ROOM_TOUR_WORKER.GSPLAT_DEFAULT_DENSIFY_STOP_FRAC = (
            ROOM_TOUR_WORKER.GSPLAT_DENSIFY_STOP / max(ROOM_TOUR_WORKER.GSPLAT_ITERATIONS, 1)
        )
        prior_training_max_anisotropy = getattr(ROOM_TOUR_WORKER, 'GSPLAT_MAX_ANISOTROPY', None)
        if training_max_anisotropy > 1.0 and prior_training_max_anisotropy is not None:
            ROOM_TOUR_WORKER.GSPLAT_MAX_ANISOTROPY = float(training_max_anisotropy)
        depth_supervision = _build_depth_supervision(
            images_dir=images_dir,
            sfm_text_model_dir=sfm_text_model_dir,
            metric3d_dir=depth_priors_dir,
            masks_dir=masks_dir,
        )
        mirror_planes = _build_mirror_reflection_planes(
            sfm_text_model_dir=sfm_text_model_dir,
            masks_dir=masks_dir,
            require_reflection_baking=not bool(mirror_gaussian_command),
        )
        room_tour_mirror_planes = [] if mirror_gaussian_command else mirror_planes
        splat_scene_path = ROOM_TOUR_WORKER.run_gsplat_training(
            images_dir,
            sfm_text_model_dir,
            init_points,
            init_colors,
            output_dir / 'workspace',
            native_output_dir,
            depth_supervision=depth_supervision,
            mirror_planes=room_tour_mirror_planes,
        )
        raw_viewer_html_path = _build_splat_viewer_html(native_output_dir / 'viewer', job_id)
    except Exception as exc:
        if REQUIRE_GAUSSIAN_SPLATTING:
            raise
        return build_summary(
            job_id=job_id,
            output_dir=output_dir,
            dry_run=False,
            status='skipped',
            reason=f'gaussian_splatting_runtime_failed:{exc}',
            registered_image_count=registered_image_count,
            sparse_point_count=sparse_point_count,
            init_point_count=int(init_points.shape[0]),
            gsplat_iterations=gsplat_iterations,
            downsampled_init_points=downsampled,
            splat_scene_path=None,
            splat_ply_path=None,
            viewer_html_path=None,
            runtime_available=runtime_available,
            init_point_source=init_point_source,
            depth_priors=depth_priors_init,
        )
    finally:
        if 'prior_training_max_anisotropy' in locals() and prior_training_max_anisotropy is not None:
            ROOM_TOUR_WORKER.GSPLAT_MAX_ANISOTROPY = prior_training_max_anisotropy

    raw_splat_scene_path = Path(splat_scene_path)
    raw_splat_ply_path = native_output_dir / 'scene.ply'
    final_splat_scene_path = raw_splat_scene_path
    final_splat_ply_path = raw_splat_ply_path if raw_splat_ply_path.exists() else None
    final_viewer_html_path = raw_viewer_html_path
    point_count = 0
    gaussian_postprocess = None
    mirror_gaussian = {
        'configured': bool(mirror_gaussian_command),
        'applied': False,
        'required': bool(mirror_gaussian_required),
        'reason': 'mirror_gaussian_not_configured' if not mirror_gaussian_command else None,
        'mirrorPlaneCount': int(len(mirror_planes)),
    }
    ref_gaussian = {
        'configured': bool(ref_gaussian_command),
        'applied': False,
        'required': bool(ref_gaussian_required),
        'reason': 'ref_gaussian_not_configured' if not ref_gaussian_command else None,
        'trainingMaskMode': 'metadata_only',
    }

    if (
        postprocess_largest_component_voxel > 0
        or postprocess_reflective_masked_support_ratio > 0
        or postprocess_max_anisotropy_ratio > 1.0
    ):
        try:
            final_splat_scene_path, final_splat_ply_path, final_viewer_html_path, gaussian_postprocess = _build_postprocessed_output(
                job_id=job_id,
                output_dir=output_dir,
                sfm_text_model_dir=sfm_text_model_dir,
                masks_dir=masks_dir,
                raw_splat_scene_path=raw_splat_scene_path,
                raw_splat_ply_path=final_splat_ply_path,
                component_voxel_size=postprocess_largest_component_voxel,
                reflective_masked_support_ratio=postprocess_reflective_masked_support_ratio,
                reflective_masked_min_hits=postprocess_reflective_masked_min_hits,
                reflective_masked_min_support_views=postprocess_reflective_masked_min_support_views,
                max_anisotropy_ratio=postprocess_max_anisotropy_ratio,
                reflective_boundary_band_px=postprocess_reflective_boundary_band_px,
                reflective_boundary_min_support_views=postprocess_reflective_boundary_min_support_views,
                reflective_boundary_max_anisotropy_ratio=postprocess_reflective_boundary_max_anisotropy_ratio,
            )
            point_count = int(gaussian_postprocess.get('pointCount', 0) or 0)
        except Exception as exc:
            if REQUIRE_GAUSSIAN_SPLATTING:
                raise RuntimeError(f'gaussian_splatting_postprocess_failed:{exc}') from exc
            gaussian_postprocess = {
                'applied': False,
                'reason': f'gaussian_splatting_postprocess_failed:{exc}',
            }

    if mirror_gaussian_command:
        try:
            final_splat_scene_path, final_splat_ply_path, final_viewer_html_path, mirror_gaussian = _run_mirror_gaussian_refinement(
                job_id=job_id,
                output_dir=output_dir,
                images_dir=images_dir,
                sfm_text_model_dir=sfm_text_model_dir,
                masks_dir=masks_dir,
                mirror_planes=mirror_planes,
                command_template=mirror_gaussian_command,
                source_splat_scene_path=final_splat_scene_path,
                source_splat_ply_path=final_splat_ply_path,
                source_viewer_html_path=final_viewer_html_path,
            )
            point_count = 0
        except Exception as exc:
            if mirror_gaussian_required:
                raise RuntimeError(f'mirror_gaussian_failed:{exc}') from exc
            mirror_gaussian = {
                'configured': True,
                'applied': False,
                'required': bool(mirror_gaussian_required),
                'reason': f'mirror_gaussian_failed:{exc}',
                'mirrorPlaneCount': int(len(mirror_planes)),
            }

    if ref_gaussian_command:
        try:
            ref_gaussian = _run_ref_gaussian_fork(
                job_id=job_id,
                output_dir=output_dir,
                images_dir=images_dir,
                sfm_text_model_dir=sfm_text_model_dir,
                depth_priors_dir=depth_priors_dir,
                masks_dir=masks_dir,
                max_init_points=max_init_points,
                depth_priors_max_points_per_image=depth_priors_max_points_per_image,
                sparse_point_count=sparse_point_count,
                command_template=ref_gaussian_command,
                source_splat_scene_path=final_splat_scene_path,
                source_splat_ply_path=final_splat_ply_path,
                source_viewer_html_path=final_viewer_html_path,
            )
            ref_gaussian['required'] = bool(ref_gaussian_required)
        except Exception as exc:
            if ref_gaussian_required:
                raise RuntimeError(f'ref_gaussian_failed:{exc}') from exc
            ref_gaussian = {
                'configured': True,
                'applied': False,
                'required': bool(ref_gaussian_required),
                'reason': f'ref_gaussian_failed:{exc}',
                'trainingMaskMode': 'metadata_only',
            }

    scaffold_gs = {
        'configured': bool(scaffold_gs_command),
        'applied': False,
        'required': bool(scaffold_gs_required),
        'reason': 'scaffold_gs_not_configured' if not scaffold_gs_command else None,
        'trainingMaskMode': 'metadata_only',
    }
    if scaffold_gs_command:
        try:
            scaffold_gs = _run_scaffold_gs_fork(
                job_id=job_id,
                output_dir=output_dir,
                images_dir=images_dir,
                sfm_text_model_dir=sfm_text_model_dir,
                depth_priors_dir=depth_priors_dir,
                masks_dir=masks_dir,
                max_init_points=max_init_points,
                depth_priors_max_points_per_image=depth_priors_max_points_per_image,
                sparse_point_count=sparse_point_count,
                command_template=scaffold_gs_command,
                source_splat_scene_path=final_splat_scene_path,
                source_splat_ply_path=final_splat_ply_path,
                source_viewer_html_path=final_viewer_html_path,
            )
            scaffold_gs['required'] = bool(scaffold_gs_required)
        except Exception as exc:
            if scaffold_gs_required:
                raise RuntimeError(f'scaffold_gs_failed:{exc}') from exc
            scaffold_gs = {
                'configured': True,
                'applied': False,
                'required': bool(scaffold_gs_required),
                'reason': f'scaffold_gs_failed:{exc}',
                'trainingMaskMode': 'metadata_only',
            }

    if point_count <= 0:
        try:
            point_count = int(_read_splat_records(final_splat_scene_path).shape[0])
        except Exception:
            point_count = 0

    return build_summary(
        job_id=job_id,
        output_dir=output_dir,
        dry_run=False,
        status='completed',
        reason=None,
        registered_image_count=registered_image_count,
        sparse_point_count=sparse_point_count,
        init_point_count=int(init_points.shape[0]),
        gsplat_iterations=gsplat_iterations,
        downsampled_init_points=downsampled,
        splat_scene_path=final_splat_scene_path,
        splat_ply_path=final_splat_ply_path,
        viewer_html_path=final_viewer_html_path,
        runtime_available=runtime_available,
        init_point_source=init_point_source,
        depth_priors=depth_priors_init,
        point_count=point_count,
        raw_splat_scene_path=raw_splat_scene_path,
        raw_splat_ply_path=raw_splat_ply_path if raw_splat_ply_path.exists() else None,
        raw_viewer_html_path=raw_viewer_html_path,
        gaussian_postprocess=gaussian_postprocess,
        mirror_gaussian=mirror_gaussian,
        ref_gaussian=ref_gaussian,
        scaffold_gs=scaffold_gs,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 gaussian splatting side branch')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--sfm-text-model-dir', required=True)
    parser.add_argument('--depth-priors-dir', '--metric3d-dir', dest='depth_priors_dir', default='')
    parser.add_argument('--masks-dir', default='')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--gsplat-iterations', type=int, default=DEFAULT_GSPLAT_ITERATIONS)
    parser.add_argument('--max-init-points', type=int, default=DEFAULT_MAX_INIT_POINTS)
    parser.add_argument('--min-init-points', type=int, default=DEFAULT_MIN_INIT_POINTS)
    parser.add_argument('--depth-priors-max-points-per-image', type=int, default=DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE)
    parser.add_argument('--training-max-anisotropy', type=float, default=0.0)
    parser.add_argument('--postprocess-largest-component-voxel', type=float, default=0.0)
    parser.add_argument('--postprocess-reflective-masked-support-ratio', type=float, default=0.0)
    parser.add_argument('--postprocess-reflective-masked-min-hits', type=int, default=0)
    parser.add_argument('--postprocess-reflective-masked-min-support-views', type=int, default=0)
    parser.add_argument('--postprocess-max-anisotropy-ratio', type=float, default=0.0)
    parser.add_argument('--postprocess-reflective-boundary-band-px', type=int, default=0)
    parser.add_argument('--postprocess-reflective-boundary-min-support-views', type=int, default=0)
    parser.add_argument('--postprocess-reflective-boundary-max-anisotropy-ratio', type=float, default=0.0)
    parser.add_argument('--mirror-gaussian-command', default=DEFAULT_MIRROR_GAUSSIAN_COMMAND)
    parser.add_argument('--mirror-gaussian-required', action='store_true')
    parser.add_argument('--ref-gaussian-command', default=DEFAULT_REF_GAUSSIAN_COMMAND)
    parser.add_argument('--ref-gaussian-required', action='store_true')
    parser.add_argument('--ref-gaussian-only', action='store_true')
    parser.add_argument('--scaffold-gs-command', default=DEFAULT_SCAFFOLD_GS_COMMAND)
    parser.add_argument('--scaffold-gs-required', action='store_true')
    parser.add_argument('--scaffold-gs-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.mirror_gaussian_required and not (args.mirror_gaussian_command or '').strip():
        parser.error('--mirror-gaussian-required needs --mirror-gaussian-command')
    if args.ref_gaussian_required and not (args.ref_gaussian_command or '').strip():
        parser.error('--ref-gaussian-required needs --ref-gaussian-command')
    if args.scaffold_gs_required and not (args.scaffold_gs_command or '').strip():
        parser.error('--scaffold-gs-required needs --scaffold-gs-command')
    if args.ref_gaussian_only and args.scaffold_gs_only:
        parser.error('--ref-gaussian-only and --scaffold-gs-only are mutually exclusive')

    summary = run_gaussian_splatting(
        job_id=args.job_id,
        images_dir=Path(args.images_dir),
        sfm_text_model_dir=Path(args.sfm_text_model_dir),
        depth_priors_dir=Path(args.depth_priors_dir) if args.depth_priors_dir else None,
        masks_dir=Path(args.masks_dir) if args.masks_dir else None,
        output_dir=ensure_dir(Path(args.output_dir)),
        dry_run=args.dry_run,
        gsplat_iterations=args.gsplat_iterations,
        max_init_points=args.max_init_points,
        min_init_points=args.min_init_points,
        depth_priors_max_points_per_image=args.depth_priors_max_points_per_image,
        training_max_anisotropy=args.training_max_anisotropy,
        postprocess_largest_component_voxel=args.postprocess_largest_component_voxel,
        postprocess_reflective_masked_support_ratio=args.postprocess_reflective_masked_support_ratio,
        postprocess_reflective_masked_min_hits=args.postprocess_reflective_masked_min_hits,
        postprocess_reflective_masked_min_support_views=args.postprocess_reflective_masked_min_support_views,
        postprocess_max_anisotropy_ratio=args.postprocess_max_anisotropy_ratio,
        postprocess_reflective_boundary_band_px=args.postprocess_reflective_boundary_band_px,
        postprocess_reflective_boundary_min_support_views=args.postprocess_reflective_boundary_min_support_views,
        postprocess_reflective_boundary_max_anisotropy_ratio=args.postprocess_reflective_boundary_max_anisotropy_ratio,
        mirror_gaussian_command=args.mirror_gaussian_command,
        mirror_gaussian_required=args.mirror_gaussian_required,
        ref_gaussian_command=args.ref_gaussian_command,
        ref_gaussian_required=args.ref_gaussian_required,
        ref_gaussian_only=args.ref_gaussian_only,
        scaffold_gs_command=args.scaffold_gs_command,
        scaffold_gs_required=args.scaffold_gs_required,
        scaffold_gs_only=args.scaffold_gs_only,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()