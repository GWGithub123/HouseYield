#!/usr/bin/env python3
"""Normalize Ref-Gaussian output into a Poisson-ready surface cloud.

This stage is intentionally narrow: it does not perform semantic cleanup or
architectural edits. It only converts the completed Ref-Gaussian artifact into
the same GLOMAP/COLMAP world frame and writes an oriented point cloud for
Poisson reconstruction.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

SCRIPTS_DIR = Path(__file__).resolve().parent
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR.parent / 'photogrammetry'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

try:
    import open3d as o3d
except Exception as exc:  # pragma: no cover - runtime dependency
    raise RuntimeError('refgaussian_surface_extraction_requires_open3d') from exc

try:
    from plyfile import PlyData
except Exception:  # pragma: no cover - optional but preferred for Gaussian PLYs
    PlyData = None

from run_dense_evidence import parse_colmap_images_txt, parse_colmap_points_lookup, quat_to_rot


SH_C0 = 0.28209479177387814


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def camera_center(image: dict) -> np.ndarray:
    rotation = quat_to_rot(image['qw'], image['qx'], image['qy'], image['qz'])
    translation = np.asarray([image['tx'], image['ty'], image['tz']], dtype=np.float64)
    return -rotation.T @ translation


def point_bounds(points: np.ndarray) -> dict:
    if points.size == 0:
        return {'count': 0}
    mins = np.min(points, axis=0)
    maxs = np.max(points, axis=0)
    extent = maxs - mins
    center = (mins + maxs) * 0.5
    radius = float(np.linalg.norm(extent) * 0.5)
    return {
        'count': int(points.shape[0]),
        'min': mins.tolist(),
        'max': maxs.tolist(),
        'center': center.tolist(),
        'extent': extent.tolist(),
        'radius': radius,
    }


def load_reference_world_points(sfm_text_model_dir: Path) -> tuple[np.ndarray, dict]:
    points_path = sfm_text_model_dir / 'points3D.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    reference_points: list[np.ndarray] = []
    sparse_count = 0
    camera_count = 0

    if points_path.exists():
        points_by_id = parse_colmap_points_lookup(points_path)
        for point in points_by_id.values():
            xyz_value = point.get('xyz')
            xyz = np.asarray(xyz_value if xyz_value is not None else [], dtype=np.float64)
            if xyz.shape == (3,) and np.all(np.isfinite(xyz)):
                reference_points.append(xyz)
                sparse_count += 1

    if images_path.exists():
        images = parse_colmap_images_txt(images_path)
        for image in images.values():
            center = camera_center(image)
            if center.shape == (3,) and np.all(np.isfinite(center)):
                reference_points.append(center)
                camera_count += 1

    if not reference_points:
        return np.zeros((0, 3), dtype=np.float64), {'sparsePointCount': 0, 'cameraCount': 0}

    return np.stack(reference_points, axis=0), {
        'sparsePointCount': sparse_count,
        'cameraCount': camera_count,
    }


def resolve_refgaussian_result(job_dir: Path, explicit_result_path: Path | None) -> dict | None:
    candidates = []
    if explicit_result_path is not None:
        candidates.append(explicit_result_path)
    candidates.extend([
        job_dir / 'gaussian' / 'splatting' / 'ref-gaussian' / 'result.json',
        job_dir / 'gaussian' / 'splatting' / 'ref-gaussian' / 'output' / 'result.json',
    ])
    for path in candidates:
        if path.exists():
            return read_json(path)
    return None


def resolve_refgaussian_output_dir(job_dir: Path, result: dict | None, explicit_output_dir: Path | None) -> Path | None:
    if explicit_output_dir is not None and explicit_output_dir.exists():
        return explicit_output_dir
    if result:
        for key in ('outputDir',):
            value = result.get(key)
            if value:
                path = Path(value)
                if path.exists():
                    return path
        model_value = result.get('modelDir')
        if model_value:
            model_dir = Path(model_value)
            if model_dir.exists():
                return model_dir.parent
    candidates = [
        job_dir / 'gaussian' / 'splatting' / 'ref-gaussian' / 'output',
        job_dir / 'gaussian' / 'splatting' / 'native-output',
    ]
    for path in candidates:
        if path.exists():
            return path
    return None


def resolve_scene_ply(job_dir: Path, result: dict | None, explicit_ply: Path | None, ref_output_dir: Path | None) -> Path:
    candidates = []
    if explicit_ply is not None:
        candidates.append(explicit_ply)
    if result:
        for key in ('splatPlyPath', 'scenePlyPath'):
            value = result.get(key)
            if value:
                candidates.append(Path(value))
    if ref_output_dir is not None:
        candidates.extend([
            ref_output_dir / 'final' / 'scene.ply',
            ref_output_dir / 'scene.ply',
        ])
    candidates.extend([
        job_dir / 'gaussian' / 'splatting' / 'ref-gaussian' / 'output' / 'final' / 'scene.ply',
        job_dir / 'gaussian' / 'splatting' / 'native-output' / 'scene.ply',
    ])
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(f'refgaussian_scene_ply_missing:{candidates[0] if candidates else job_dir}')


def resolve_native_surface_ply(result: dict | None, ref_output_dir: Path | None, explicit_surface_ply: Path | None) -> Path | None:
    candidates = []
    if explicit_surface_ply is not None:
        candidates.append(explicit_surface_ply)
    if result and result.get('modelDir'):
        model_dir = Path(result['modelDir'])
        candidates.extend(sorted(model_dir.glob('test_*.ply'), reverse=True))
    if ref_output_dir is not None:
        model_dir = ref_output_dir / 'refgaussian-model'
        candidates.extend(sorted(model_dir.glob('test_*.ply'), reverse=True))
        native_model_dir = ref_output_dir / 'native-render' / 'model'
        candidates.extend(sorted(native_model_dir.glob('test_*.ply'), reverse=True))
    for path in candidates:
        if path.exists():
            return path
    return None


def read_gaussian_ply_with_attributes(ply_path: Path, min_opacity: float) -> tuple[o3d.geometry.PointCloud, dict]:
    if PlyData is None:
        pcd = o3d.io.read_point_cloud(str(ply_path))
        if len(pcd.points) == 0:
            raise RuntimeError(f'open3d_failed_to_read_gaussian_ply:{ply_path}')
        return pcd, {
            'reader': 'open3d',
            'sourcePointCount': int(len(pcd.points)),
            'keptPointCount': int(len(pcd.points)),
            'hasOpacity': False,
            'hasGaussianScale': False,
        }

    ply = PlyData.read(str(ply_path))
    vertex = ply['vertex']
    names = set(vertex.data.dtype.names or [])
    required = {'x', 'y', 'z'}
    if not required.issubset(names):
        raise RuntimeError(f'gaussian_ply_missing_xyz:{ply_path}')

    points = np.stack([
        np.asarray(vertex['x'], dtype=np.float64),
        np.asarray(vertex['y'], dtype=np.float64),
        np.asarray(vertex['z'], dtype=np.float64),
    ], axis=1)
    valid = np.all(np.isfinite(points), axis=1)

    opacity_stats = None
    if 'opacity' in names:
        opacity = sigmoid(np.asarray(vertex['opacity'], dtype=np.float64))
        opacity_stats = {
            'min': float(np.min(opacity)) if opacity.size else None,
            'median': float(np.median(opacity)) if opacity.size else None,
            'max': float(np.max(opacity)) if opacity.size else None,
        }
        if min_opacity > 0:
            valid &= opacity >= min_opacity

    colors = None
    if {'red', 'green', 'blue'}.issubset(names):
        colors = np.stack([
            np.asarray(vertex['red'], dtype=np.float64),
            np.asarray(vertex['green'], dtype=np.float64),
            np.asarray(vertex['blue'], dtype=np.float64),
        ], axis=1)
        if np.nanmax(colors) > 1.0:
            colors = colors / 255.0
    elif {'f_dc_0', 'f_dc_1', 'f_dc_2'}.issubset(names):
        colors = np.stack([
            np.asarray(vertex['f_dc_0'], dtype=np.float64),
            np.asarray(vertex['f_dc_1'], dtype=np.float64),
            np.asarray(vertex['f_dc_2'], dtype=np.float64),
        ], axis=1)
        colors = np.clip(colors * SH_C0 + 0.5, 0.0, 1.0)

    normals = None
    stored_normals_summary = None
    if {'nx', 'ny', 'nz'}.issubset(names):
        candidate_normals = np.stack([
            np.asarray(vertex['nx'], dtype=np.float64),
            np.asarray(vertex['ny'], dtype=np.float64),
            np.asarray(vertex['nz'], dtype=np.float64),
        ], axis=1)
        normal_lengths = np.linalg.norm(candidate_normals, axis=1)
        usable_normals = np.isfinite(normal_lengths) & (normal_lengths > 1e-8)
        stored_normals_summary = {
            'present': True,
            'usableCount': int(np.count_nonzero(usable_normals)),
            'zeroOrInvalidCount': int(candidate_normals.shape[0] - np.count_nonzero(usable_normals)),
        }
        if np.count_nonzero(usable_normals) >= max(100, int(candidate_normals.shape[0] * 0.1)):
            valid &= usable_normals
            normals = candidate_normals / np.maximum(normal_lengths[:, None], 1e-8)

    scale_stats = None
    scale_names = [name for name in ('scale_0', 'scale_1', 'scale_2') if name in names]
    if scale_names:
        log_scales = np.stack([np.asarray(vertex[name], dtype=np.float64) for name in scale_names], axis=1)
        scales = np.exp(np.clip(log_scales, -20.0, 20.0))
        scale_stats = {
            'fields': scale_names,
            'median': np.median(scales, axis=0).tolist(),
            'p90': np.percentile(scales, 90, axis=0).tolist(),
        }

    points = points[valid]
    pcd = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points))
    if colors is not None:
        pcd.colors = o3d.utility.Vector3dVector(np.clip(colors[valid], 0.0, 1.0))
    if normals is not None:
        pcd.normals = o3d.utility.Vector3dVector(normals[valid])

    return pcd, {
        'reader': 'plyfile',
        'sourcePointCount': int(len(vertex)),
        'keptPointCount': int(points.shape[0]),
        'hasOpacity': opacity_stats is not None,
        'opacityStats': opacity_stats,
        'hasGaussianScale': scale_stats is not None,
        'scaleStats': scale_stats,
        'storedNormals': stored_normals_summary or {'present': False},
        'minOpacity': float(min_opacity),
    }


def load_native_surface_ply(ply_path: Path, target_samples: int) -> tuple[o3d.geometry.PointCloud, dict]:
    mesh = o3d.io.read_triangle_mesh(str(ply_path))
    if len(mesh.triangles) > 0 and len(mesh.vertices) > 0:
        if not mesh.has_vertex_normals():
            mesh.compute_vertex_normals()
        sample_count = min(max(int(target_samples), 1), max(len(mesh.vertices), int(target_samples)))
        pcd = mesh.sample_points_uniformly(number_of_points=sample_count)
        return pcd, {
            'reader': 'open3d_triangle_mesh',
            'sourceVertexCount': int(len(mesh.vertices)),
            'sourceFaceCount': int(len(mesh.triangles)),
            'sampleCount': int(len(pcd.points)),
        }

    pcd = o3d.io.read_point_cloud(str(ply_path))
    if len(pcd.points) == 0:
        raise RuntimeError(f'native_surface_ply_empty:{ply_path}')
    return pcd, {
        'reader': 'open3d_point_cloud',
        'sourcePointCount': int(len(pcd.points)),
        'sampleCount': int(len(pcd.points)),
    }


def load_rendered_depth_normal_surface(ref_output_dir: Path | None) -> tuple[o3d.geometry.PointCloud, dict] | None:
    # Hook for phase-2 rendered depth/normal fusion. Current Ref-Gaussian exports
    # RGB/normal galleries but usually does not persist camera-space depth maps.
    # If depth maps are added later, this function is the single integration point.
    if ref_output_dir is None:
        return None
    render_root = ref_output_dir / 'native-render' / 'model' / 'test' / 'renders'
    depth_dir = render_root / 'depth'
    normal_dir = render_root / 'normal'
    if not depth_dir.exists():
        return None
    return None


def apply_world_normalization(
    pcd: o3d.geometry.PointCloud,
    reference_points: np.ndarray,
    auto_similarity: bool,
    force_similarity: bool,
) -> tuple[o3d.geometry.PointCloud, dict]:
    points = np.asarray(pcd.points, dtype=np.float64)
    source_bounds = point_bounds(points)
    reference_bounds = point_bounds(reference_points)
    transform = {
        'applied': False,
        'method': 'already_in_glomap_world',
        'reason': 'reference_or_source_bounds_unavailable',
        'scale': 1.0,
        'translation': [0.0, 0.0, 0.0],
    }
    if points.size == 0 or reference_points.size == 0:
        return pcd, {
            'sourceBounds': source_bounds,
            'referenceBounds': reference_bounds,
            'transform': transform,
        }

    source_radius = max(float(source_bounds.get('radius') or 0.0), 1e-8)
    reference_radius = max(float(reference_bounds.get('radius') or 0.0), 1e-8)
    source_center = np.asarray(source_bounds['center'], dtype=np.float64)
    reference_center = np.asarray(reference_bounds['center'], dtype=np.float64)
    radius_ratio = source_radius / reference_radius
    center_distance = float(np.linalg.norm(source_center - reference_center))
    should_apply = force_similarity or (
        auto_similarity and (
            radius_ratio < 0.1
            or radius_ratio > 10.0
            or center_distance > max(10.0 * reference_radius, 10.0)
        )
    )

    if should_apply:
        scale = reference_radius / source_radius
        transformed = (points - source_center[None, :]) * scale + reference_center[None, :]
        pcd.points = o3d.utility.Vector3dVector(transformed)
        transform = {
            'applied': True,
            'method': 'axis_aligned_bounds_similarity',
            'reason': 'forced' if force_similarity else 'source_bounds_outside_glomap_world_tolerance',
            'scale': float(scale),
            'translation': (reference_center - source_center * scale).tolist(),
            'sourceRadius': source_radius,
            'referenceRadius': reference_radius,
            'sourceToReferenceRadiusRatio': float(radius_ratio),
            'centerDistanceBefore': center_distance,
        }
        source_bounds = point_bounds(transformed)
    else:
        transform = {
            'applied': False,
            'method': 'already_in_glomap_world',
            'reason': 'source_bounds_match_glomap_world',
            'scale': 1.0,
            'translation': [0.0, 0.0, 0.0],
            'sourceRadius': source_radius,
            'referenceRadius': reference_radius,
            'sourceToReferenceRadiusRatio': float(radius_ratio),
            'centerDistance': center_distance,
        }

    return pcd, {
        'sourceBounds': source_bounds,
        'referenceBounds': reference_bounds,
        'transform': transform,
    }


def ensure_poisson_normals(pcd: o3d.geometry.PointCloud, normal_radius: float, normal_max_nn: int) -> tuple[o3d.geometry.PointCloud, dict]:
    summary = {
        'hadInputNormals': bool(pcd.has_normals()),
        'estimatedNormals': False,
        'orientedNormals': False,
        'normalRadius': float(normal_radius),
        'normalMaxNn': int(normal_max_nn),
    }
    if not pcd.has_normals():
        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=float(normal_radius), max_nn=int(normal_max_nn))
        )
        summary['estimatedNormals'] = True

    neighbor_count = min(50, len(pcd.points) - 1)
    if neighbor_count >= 3:
        pcd.orient_normals_consistent_tangent_plane(k=neighbor_count)
        summary['orientedNormals'] = True
        summary['orientationNeighborCount'] = int(neighbor_count)
    return pcd, summary


def maybe_voxel_downsample(pcd: o3d.geometry.PointCloud, voxel_size: float) -> tuple[o3d.geometry.PointCloud, dict]:
    before = int(len(pcd.points))
    if voxel_size <= 0:
        return pcd, {'applied': False, 'voxelSize': float(voxel_size), 'before': before, 'after': before}
    pcd = pcd.voxel_down_sample(voxel_size=float(voxel_size))
    return pcd, {'applied': True, 'voxelSize': float(voxel_size), 'before': before, 'after': int(len(pcd.points))}


def run_refgaussian_surface_extraction(
    *,
    job_dir: Path,
    output_dir: Path,
    sfm_text_model_dir: Path,
    refgaussian_ply_path: Path | None,
    refgaussian_surface_ply_path: Path | None,
    refgaussian_result_path: Path | None,
    refgaussian_output_dir: Path | None,
    target_surface_samples: int,
    min_opacity: float,
    voxel_size: float,
    normal_radius: float,
    normal_max_nn: int,
    auto_similarity: bool,
    force_similarity: bool,
) -> dict:
    result = resolve_refgaussian_result(job_dir, refgaussian_result_path)
    resolved_ref_output_dir = resolve_refgaussian_output_dir(job_dir, result, refgaussian_output_dir)
    scene_ply = resolve_scene_ply(job_dir, result, refgaussian_ply_path, resolved_ref_output_dir)
    native_surface_ply = resolve_native_surface_ply(result, resolved_ref_output_dir, refgaussian_surface_ply_path)

    source_kind = 'phase1_gaussian_ply_normalization'
    source_path = scene_ply
    source_summary: dict[str, Any]

    rendered_surface = load_rendered_depth_normal_surface(resolved_ref_output_dir)
    if native_surface_ply is not None:
        pcd, source_summary = load_native_surface_ply(native_surface_ply, target_surface_samples)
        source_kind = 'phase2_refgaussian_native_surface_ply'
        source_path = native_surface_ply
    elif rendered_surface is not None:
        pcd, source_summary = rendered_surface
        source_kind = 'phase2_rendered_depth_normal_fusion'
        source_path = resolved_ref_output_dir or scene_ply
    else:
        pcd, source_summary = read_gaussian_ply_with_attributes(scene_ply, min_opacity=min_opacity)

    if len(pcd.points) == 0:
        raise RuntimeError(f'refgaussian_surface_extraction_empty:{source_path}')

    reference_points, reference_summary = load_reference_world_points(sfm_text_model_dir)
    pcd, world_summary = apply_world_normalization(
        pcd,
        reference_points,
        auto_similarity=auto_similarity,
        force_similarity=force_similarity,
    )
    pcd, downsample_summary = maybe_voxel_downsample(pcd, voxel_size)
    pcd, normal_summary = ensure_poisson_normals(pcd, normal_radius=normal_radius, normal_max_nn=normal_max_nn)

    surface_ply_path = output_dir / 'normalized_surface_points.ply'
    if not o3d.io.write_point_cloud(str(surface_ply_path), pcd, write_ascii=False, compressed=False):
        raise RuntimeError(f'failed_to_write_refgaussian_surface_ply:{surface_ply_path}')

    final_points = np.asarray(pcd.points, dtype=np.float64)
    summary = {
        'createdAt': now_iso(),
        'jobDir': str(job_dir),
        'mode': 'refgaussian_surface_normalization',
        'sourceKind': source_kind,
        'sourcePath': str(source_path),
        'scenePlyPath': str(scene_ply),
        'refGaussianOutputDir': str(resolved_ref_output_dir) if resolved_ref_output_dir else None,
        'nativeSurfacePlyPath': str(native_surface_ply) if native_surface_ply else None,
        'surfacePlyPath': str(surface_ply_path),
        'pointCount': int(len(pcd.points)),
        'bounds': point_bounds(final_points),
        'reference': reference_summary,
        'source': source_summary,
        'worldNormalization': world_summary,
        'downsample': downsample_summary,
        'normals': normal_summary,
        'phase1': {
            'implemented': True,
            'description': 'Normalize Ref-Gaussian PLY centers/attributes into Poisson-ready world-space points.',
        },
        'phase2': {
            'implemented': True,
            'description': 'Prefer Ref-Gaussian native extracted surface PLY when present; rendered depth/normal fusion hook is available when depth maps are exported.',
            'selected': source_kind.startswith('phase2'),
        },
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Normalize Ref-Gaussian output into Poisson-ready surface samples')
    parser.add_argument('--job-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--sfm-text-model-dir', required=True)
    parser.add_argument('--refgaussian-ply-path', default='')
    parser.add_argument('--refgaussian-surface-ply-path', default='')
    parser.add_argument('--refgaussian-result-path', default='')
    parser.add_argument('--refgaussian-output-dir', default='')
    parser.add_argument('--target-surface-samples', type=int, default=750000)
    parser.add_argument('--min-opacity', type=float, default=0.0)
    parser.add_argument('--voxel-size', type=float, default=0.0)
    parser.add_argument('--normal-radius', type=float, default=0.1)
    parser.add_argument('--normal-max-nn', type=int, default=30)
    parser.add_argument('--disable-auto-similarity-normalization', action='store_true')
    parser.add_argument('--force-similarity-normalization', action='store_true')
    args = parser.parse_args()

    summary = run_refgaussian_surface_extraction(
        job_dir=Path(args.job_dir),
        output_dir=ensure_dir(Path(args.output_dir)),
        sfm_text_model_dir=Path(args.sfm_text_model_dir),
        refgaussian_ply_path=Path(args.refgaussian_ply_path) if args.refgaussian_ply_path else None,
        refgaussian_surface_ply_path=Path(args.refgaussian_surface_ply_path) if args.refgaussian_surface_ply_path else None,
        refgaussian_result_path=Path(args.refgaussian_result_path) if args.refgaussian_result_path else None,
        refgaussian_output_dir=Path(args.refgaussian_output_dir) if args.refgaussian_output_dir else None,
        target_surface_samples=args.target_surface_samples,
        min_opacity=args.min_opacity,
        voxel_size=args.voxel_size,
        normal_radius=args.normal_radius,
        normal_max_nn=args.normal_max_nn,
        auto_similarity=not args.disable_auto_similarity_normalization,
        force_similarity=args.force_similarity_normalization,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
