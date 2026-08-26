#!/usr/bin/env python3
"""Export the final GLB and validate it for master_v1."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import trimesh

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR / 'photogrammetry'
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

from export import MeshExporter


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def mesh_has_vertex_colors(mesh_path: Path) -> bool:
    loaded = trimesh.load(str(mesh_path), force='mesh')
    visual = getattr(loaded, 'visual', None)
    colors = getattr(visual, 'vertex_colors', None)
    return colors is not None and len(colors) == len(loaded.vertices)


def resolve_appearance_assets(appearance_dir: Path) -> dict:
    summary = read_json(appearance_dir / 'summary.json')
    mesh_path = Path(summary['refinedMeshPath'])
    texture_path_value = summary.get('refinedTexturePath')
    texture_path = Path(texture_path_value) if texture_path_value else None
    has_vertex_colors = mesh_has_vertex_colors(mesh_path) if mesh_path.exists() else False
    if not mesh_path.exists():
        raise FileNotFoundError('appearance_assets_missing')
    if texture_path is not None and not texture_path.exists():
        texture_path = None
    if texture_path is None and not has_vertex_colors:
        raise FileNotFoundError('appearance_assets_missing_texture_or_vertex_colors')
    return {
        'meshPath': mesh_path,
        'texturePath': texture_path,
        'hasVertexColors': has_vertex_colors,
        'summary': summary,
    }


def load_mesh_stats(mesh_path: Path) -> dict:
    loaded = trimesh.load(str(mesh_path), force='scene')
    if isinstance(loaded, trimesh.Scene):
        geometries = [geometry for geometry in loaded.geometry.values() if isinstance(geometry, trimesh.Trimesh)]
        if not geometries:
            raise RuntimeError('export_qa_no_mesh_geometries')
        mesh = trimesh.util.concatenate(geometries) if len(geometries) > 1 else geometries[0]
    else:
        mesh = loaded

    bounds = mesh.bounds
    return {
        'vertices': int(len(mesh.vertices)),
        'faces': int(len(mesh.faces)),
        'isWatertight': bool(mesh.is_watertight),
        'isWindingConsistent': bool(mesh.is_winding_consistent),
        'bounds': {
            'min': [round(float(value), 6) for value in bounds[0]],
            'max': [round(float(value), 6) for value in bounds[1]],
        },
    }


def maybe_optimize_glb(final_glb_path: Path, output_dir: Path) -> tuple[Path, str]:
    optimized_path = output_dir / 'model.optimized.glb'
    gltfpack_binary = shutil.which('gltfpack')
    if not gltfpack_binary:
        shutil.copyfile(final_glb_path, optimized_path)
        return optimized_path, 'copy_passthrough'

    subprocess.run([gltfpack_binary, '-i', str(final_glb_path), '-o', str(optimized_path)], check=True)
    return optimized_path, 'gltfpack'


def run_export_qa(job_id: str, appearance_dir: Path, output_dir: Path) -> dict:
    assets = resolve_appearance_assets(appearance_dir)
    exporter = MeshExporter(compress=True)
    results = exporter.export_all(assets['meshPath'], texture_path=assets['texturePath'], formats=['glb'], output_dir=output_dir)
    final_glb_path = results.get('glb')
    if not final_glb_path or not final_glb_path.exists():
        raise RuntimeError('final_glb_export_missing')

    optimized_glb_path, optimization_mode = maybe_optimize_glb(final_glb_path, output_dir)
    qa_report = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'sourceMeshStats': load_mesh_stats(assets['meshPath']),
        'finalGlb': {
            'path': str(final_glb_path),
            'bytes': int(final_glb_path.stat().st_size),
        },
        'optimizedGlb': {
            'path': str(optimized_glb_path),
            'bytes': int(optimized_glb_path.stat().st_size),
            'mode': optimization_mode,
        },
        'texturePath': str(assets['texturePath']) if assets['texturePath'] else None,
        'hasVertexColors': assets['hasVertexColors'],
        'note': 'QA validates the exported mesh envelope and emits an optimized GLB when gltfpack is available.',
    }
    write_json(output_dir / 'qa_report.json', qa_report)

    summary = {
        'jobId': job_id,
        'createdAt': qa_report['createdAt'],
        'finalGlbPath': str(final_glb_path),
        'optimizedGlbPath': str(optimized_glb_path),
        'qaReportPath': str(output_dir / 'qa_report.json'),
        'optimizationMode': optimization_mode,
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 export and QA')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--appearance-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()

    summary = run_export_qa(
        job_id=args.job_id,
        appearance_dir=Path(args.appearance_dir),
        output_dir=ensure_dir(Path(args.output_dir)),
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()