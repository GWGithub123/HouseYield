#!/usr/bin/env python3
"""Prototype: mesh + texture a Gaussian scene scaffold.

This consumes a completed gaussian-side job artifact (scene.ply), generates a
Poisson mesh from that point cloud, and runs OpenMVS texturing against the
job's selected frames and solved SfM cameras.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR / 'photogrammetry'
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

from mesh_generation import MeshGenerator
from run_appearance_refinement import run_traditional_detail_texturing
from run_refgaussian_surface_extraction import run_refgaussian_surface_extraction


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def run_gaussian_mesh_hybrid(
    *,
    job_dir: Path,
    output_dir: Path,
    gaussian_ply_path: Path | None,
    refgaussian_surface_ply_path: Path | None,
    refgaussian_result_path: Path | None,
    refgaussian_output_dir: Path | None,
    poisson_depth: int,
    target_triangles: int,
    target_surface_samples: int,
    min_opacity: float,
    voxel_size: float,
    normal_radius: float,
    normal_max_nn: int,
    force_similarity_normalization: bool,
) -> dict:
    gaussian_dir = job_dir / 'gaussian' / 'splatting'
    frames_dir = job_dir / 'frames' / 'selected'
    sfm_text_model_dir = job_dir / 'sfm' / 'global_sfm' / 'text-model'

    resolved_gaussian_ply = gaussian_ply_path or (gaussian_dir / 'native-output' / 'scene.ply')
    if not resolved_gaussian_ply.exists():
        raise FileNotFoundError(f'gaussian_scene_ply_missing:{resolved_gaussian_ply}')
    if not frames_dir.exists():
        raise FileNotFoundError(f'gaussian_hybrid_frames_missing:{frames_dir}')
    if not sfm_text_model_dir.exists():
        raise FileNotFoundError(f'gaussian_hybrid_sfm_missing:{sfm_text_model_dir}')

    mesh_output_dir = ensure_dir(output_dir / 'mesh')
    texture_output_dir = ensure_dir(output_dir / 'texture')
    surface_output_dir = ensure_dir(output_dir / 'surface')

    surface_summary = run_refgaussian_surface_extraction(
        job_dir=job_dir,
        output_dir=surface_output_dir,
        sfm_text_model_dir=sfm_text_model_dir,
        refgaussian_ply_path=resolved_gaussian_ply,
        refgaussian_surface_ply_path=refgaussian_surface_ply_path,
        refgaussian_result_path=refgaussian_result_path,
        refgaussian_output_dir=refgaussian_output_dir,
        target_surface_samples=target_surface_samples,
        min_opacity=min_opacity,
        voxel_size=voxel_size,
        normal_radius=normal_radius,
        normal_max_nn=normal_max_nn,
        auto_similarity=True,
        force_similarity=force_similarity_normalization,
    )
    surface_ply_path = Path(surface_summary['surfacePlyPath'])

    generator = MeshGenerator(
        method='poisson',
        depth=poisson_depth,
        target_triangles=target_triangles,
        clean_mesh=True,
    )
    mesh_result = generator.run(surface_ply_path, mesh_output_dir)
    mesh_path = Path(mesh_result['mesh_path'])
    textured_result = run_traditional_detail_texturing(
        mesh_path,
        frames_dir,
        sfm_text_model_dir,
        texture_output_dir,
        undistorted_dir=None,
    )

    summary = {
        'createdAt': now_iso(),
        'jobDir': str(job_dir),
        'gaussianScenePlyPath': str(resolved_gaussian_ply),
        'normalizedSurfacePlyPath': str(surface_ply_path),
        'surfaceExtraction': surface_summary,
        'poissonDepth': int(poisson_depth),
        'targetTriangles': int(target_triangles),
        'meshPath': str(mesh_path),
        'numVertices': int(mesh_result['num_vertices']),
        'numFaces': int(mesh_result['num_faces']),
        'dimensions': mesh_result.get('dimensions', {}),
        'texturedMeshPath': str(textured_result['refinedMeshPath']),
        'texturePath': str(textured_result['refinedTexturePath']) if textured_result.get('refinedTexturePath') else None,
        'mtlPath': str(textured_result['refinedMtlPath']) if textured_result.get('refinedMtlPath') else None,
        'note': 'Ref-Gaussian hybrid: normalized Ref-Gaussian surface points, Poisson mesh, and OpenMVS texturing.',
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Prototype hybrid Gaussian-to-mesh OpenMVS texturing')
    parser.add_argument('--job-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--gaussian-ply-path', default='')
    parser.add_argument('--refgaussian-surface-ply-path', default='')
    parser.add_argument('--refgaussian-result-path', default='')
    parser.add_argument('--refgaussian-output-dir', default='')
    parser.add_argument('--poisson-depth', type=int, default=10)
    parser.add_argument('--target-triangles', type=int, default=500000)
    parser.add_argument('--target-surface-samples', type=int, default=750000)
    parser.add_argument('--min-opacity', type=float, default=0.0)
    parser.add_argument('--voxel-size', type=float, default=0.0)
    parser.add_argument('--normal-radius', type=float, default=0.1)
    parser.add_argument('--normal-max-nn', type=int, default=30)
    parser.add_argument('--force-similarity-normalization', action='store_true')
    args = parser.parse_args()

    summary = run_gaussian_mesh_hybrid(
        job_dir=Path(args.job_dir),
        output_dir=ensure_dir(Path(args.output_dir)),
        gaussian_ply_path=Path(args.gaussian_ply_path) if args.gaussian_ply_path else None,
        refgaussian_surface_ply_path=Path(args.refgaussian_surface_ply_path) if args.refgaussian_surface_ply_path else None,
        refgaussian_result_path=Path(args.refgaussian_result_path) if args.refgaussian_result_path else None,
        refgaussian_output_dir=Path(args.refgaussian_output_dir) if args.refgaussian_output_dir else None,
        poisson_depth=args.poisson_depth,
        target_triangles=args.target_triangles,
        target_surface_samples=args.target_surface_samples,
        min_opacity=args.min_opacity,
        voxel_size=args.voxel_size,
        normal_radius=args.normal_radius,
        normal_max_nn=args.normal_max_nn,
        force_similarity_normalization=args.force_similarity_normalization,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
