#!/usr/bin/env python3
"""Run appearance refinement for master_v1.

This stage is command-driven: if an external gsplat/3DGS rebake command is
configured, it is executed. Otherwise the UV bake assets pass through unchanged.
The pass-through mode keeps the canonical mesh-first pipeline complete while the
appearance sidecar remains optional.
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

from run_dense_evidence import parse_colmap_cameras_txt, parse_colmap_images_txt, quat_to_rot


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR / 'photogrammetry'
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

try:
    from texture_mapping import TextureMapper
except Exception:  # pragma: no cover - optional helper import
    TextureMapper = None


REFINER_COMMAND = os.environ.get('MASTER_PIPELINE_GSPLAT_REFINER_COMMAND', '').strip()
REQUIRE_REFINEMENT = os.environ.get('MASTER_PIPELINE_REQUIRE_APPEARANCE_REFINEMENT', 'true').lower() == 'true'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def resolve_colmap_binary() -> str | None:
    return shutil.which('colmap-glomap') or shutil.which('colmap')


def build_texture_camera_intrinsics(camera: dict) -> tuple[float, float, float, float]:
    model = camera['model']
    params = camera['params']
    if model in ('SIMPLE_PINHOLE', 'SIMPLE_RADIAL'):
        fx = fy = params[0]
        cx, cy = params[1], params[2]
    elif model in ('PINHOLE', 'OPENCV', 'RADIAL'):
        fx, fy = params[0], params[1]
        cx, cy = params[2], params[3]
    else:
        raise ValueError(f'unsupported_camera_model:{model}')
    return float(fx), float(fy), float(cx), float(cy)


def build_texture_cameras(sfm_text_model_dir: Path) -> dict[str, dict]:
    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    if not cameras_path.exists() or not images_path.exists():
        return {}

    camera_defs = parse_colmap_cameras_txt(cameras_path)
    image_defs = parse_colmap_images_txt(images_path)
    fallback_cameras: dict[str, dict] = {}

    for image_name, image in image_defs.items():
        camera = camera_defs.get(image['cam_id'])
        if not camera:
            continue
        try:
            fx, fy, cx, cy = build_texture_camera_intrinsics(camera)
        except ValueError:
            continue
        fallback_cameras[Path(image_name).stem] = {
            'fx': fx,
            'fy': fy,
            'cx': cx,
            'cy': cy,
            'rotation': quat_to_rot(image['qw'], image['qx'], image['qy'], image['qz']).tolist(),
            'translation': [image['tx'], image['ty'], image['tz']],
        }

    return fallback_cameras


def resolve_detail_mesh(mesh_authoring_dir: Path) -> dict | None:
    summary_path = mesh_authoring_dir / 'summary.json'
    if not summary_path.exists():
        return None

    summary = read_json(summary_path)
    detail_summary = summary.get('detailMesh')
    if not detail_summary:
        return None

    mesh_path = Path(detail_summary.get('meshPath') or '')
    if not mesh_path.exists():
        return None

    return {
        'summary': summary,
        'meshPath': mesh_path,
        'meshType': 'detail_mesh',
    }


def resolve_uv_assets(uv_bake_dir: Path) -> dict:
    summary = read_json(uv_bake_dir / 'summary.json')
    mesh_path = Path(summary['texturedMeshPath'])
    texture_path = Path(summary['texturePath'])
    mtl_path = Path(summary['mtlPath']) if summary.get('mtlPath') else None
    if not mesh_path.exists() or not texture_path.exists():
        raise FileNotFoundError('uv_initial_bake_assets_missing')
    return {
        'summary': summary,
        'meshPath': mesh_path,
        'texturePath': texture_path,
        'mtlPath': mtl_path,
        'meshType': 'uv_shell_mesh',
    }


def copy_uv_assets(mesh_path: Path, texture_path: Path, mtl_path: Path | None, output_dir: Path) -> dict:
    refined_mesh_path = output_dir / 'refined_mesh.obj'
    refined_texture_path = output_dir / f'refined_texture{texture_path.suffix or ".png"}'
    shutil.copyfile(mesh_path, refined_mesh_path)
    shutil.copyfile(texture_path, refined_texture_path)

    refined_mtl_path = None
    if mtl_path and mtl_path.exists():
        refined_mtl_path = output_dir / 'refined_mesh.mtl'
        shutil.copyfile(mtl_path, refined_mtl_path)

    return {
        'refinedMeshPath': str(refined_mesh_path),
        'refinedTexturePath': str(refined_texture_path),
        'refinedMtlPath': str(refined_mtl_path) if refined_mtl_path else None,
    }


def copy_detail_mesh(mesh_path: Path, output_dir: Path) -> dict:
    refined_mesh_path = output_dir / f'refined_mesh{mesh_path.suffix or ".ply"}'
    shutil.copyfile(mesh_path, refined_mesh_path)
    return {
        'refinedMeshPath': str(refined_mesh_path),
        'refinedTexturePath': None,
        'refinedMtlPath': None,
    }


def run_traditional_detail_texturing(
    mesh_path: Path,
    images_dir: Path,
    sfm_text_model_dir: Path,
    output_dir: Path,
    undistorted_dir: Path | None = None,
) -> dict:
    if TextureMapper is None:
        raise RuntimeError('detail_texture_mapper_unavailable')
    if shutil.which('InterfaceCOLMAP') is None or shutil.which('TextureMesh') is None:
        raise RuntimeError('detail_texture_openmvs_required')

    texture_output_dir = ensure_dir(output_dir / 'detail_texture')
    cameras: dict[str, dict | str] = build_texture_cameras(sfm_text_model_dir)
    colmap_binary = resolve_colmap_binary()
    openmvs_images_dir = images_dir
    if undistorted_dir is not None and undistorted_dir.exists():
        cameras['colmap_dir'] = str(undistorted_dir)
        openmvs_images_dir = undistorted_dir / 'images'
    elif colmap_binary:
        dense_workspace_dir = ensure_dir(texture_output_dir / 'colmap_dense')
        subprocess.run([
            colmap_binary,
            'image_undistorter',
            '--image_path', str(images_dir),
            '--input_path', str(sfm_text_model_dir),
            '--output_path', str(dense_workspace_dir),
            '--output_type', 'COLMAP',
        ], check=True)
        cameras['colmap_dir'] = str(dense_workspace_dir)
        openmvs_images_dir = dense_workspace_dir / 'images'

    texture_mapper = TextureMapper(resolution=4096, format='jpg', quality=95)
    texture_result = texture_mapper._run_openmvs(
        mesh_path,
        openmvs_images_dir,
        cameras,
        texture_output_dir,
        allow_fallback=False,
    )

    textured_mesh_path = Path(texture_result['textured_mesh_path'])
    texture_path_value = texture_result.get('texture_path')
    texture_path = Path(texture_path_value) if texture_path_value else None
    refined_mtl_path = textured_mesh_path.with_suffix('.mtl') if textured_mesh_path.suffix.lower() == '.obj' else None

    if not textured_mesh_path.exists():
        raise RuntimeError('detail_texturing_missing_mesh_output')
    if texture_path is None or not texture_path.exists():
        raise RuntimeError('detail_texturing_missing_texture_output')

    return {
        'refinedMeshPath': str(textured_mesh_path),
        'refinedTexturePath': str(texture_path),
        'refinedMtlPath': str(refined_mtl_path) if refined_mtl_path and refined_mtl_path.exists() else None,
    }


def run_external_refiner(
    command_template: str,
    images_dir: Path,
    sfm_text_model_dir: Path,
    uv_assets: dict,
    detail_mesh_assets: dict | None,
    output_dir: Path,
) -> dict:
    refined_mesh_path = output_dir / 'refined_mesh.obj'
    refined_texture_path = output_dir / 'refined_texture.png'
    refined_mtl_path = output_dir / 'refined_mesh.mtl'
    source_mesh_path = detail_mesh_assets['meshPath'] if detail_mesh_assets else uv_assets['meshPath']
    formatted_command = command_template.format(
        images_dir=str(images_dir),
        sfm_text_model_dir=str(sfm_text_model_dir),
        source_mesh_path=str(source_mesh_path),
        detail_mesh_path=str(detail_mesh_assets['meshPath']) if detail_mesh_assets else '',
        uv_mesh_path=str(uv_assets['meshPath']),
        uv_texture_path=str(uv_assets['texturePath']),
        output_dir=str(output_dir),
        refined_mesh_path=str(refined_mesh_path),
        refined_texture_path=str(refined_texture_path),
        refined_mtl_path=str(refined_mtl_path),
    )
    subprocess.run(shlex.split(formatted_command), check=True)
    if not refined_texture_path.exists():
        raise RuntimeError('appearance_refiner_missing_refined_texture')
    if not refined_mesh_path.exists():
        shutil.copyfile(uv_assets['meshPath'], refined_mesh_path)
    if uv_assets['mtlPath'] and uv_assets['mtlPath'].exists() and not refined_mtl_path.exists():
        shutil.copyfile(uv_assets['mtlPath'], refined_mtl_path)

    return {
        'refinedMeshPath': str(refined_mesh_path),
        'refinedTexturePath': str(refined_texture_path),
        'refinedMtlPath': str(refined_mtl_path) if refined_mtl_path.exists() else None,
    }


def run_appearance_refinement(
    job_id: str,
    images_dir: Path,
    sfm_text_model_dir: Path,
    uv_bake_dir: Path,
    mesh_authoring_dir: Path,
    output_dir: Path,
    dry_run: bool,
) -> dict:
    detail_mesh_assets = resolve_detail_mesh(mesh_authoring_dir)
    uv_assets = resolve_uv_assets(uv_bake_dir)

    if REFINER_COMMAND and not dry_run:
        refined_assets = run_external_refiner(
            REFINER_COMMAND,
            images_dir,
            sfm_text_model_dir,
            uv_assets,
            detail_mesh_assets,
            output_dir,
        )
        summary = {
            'jobId': job_id,
            'createdAt': now_iso(),
            'dryRun': False,
            'mode': 'external_refiner',
            'refinerCommandConfigured': True,
            'meshSource': detail_mesh_assets['meshType'] if detail_mesh_assets else uv_assets['meshType'],
            **refined_assets,
            'note': 'Appearance refinement used the configured gsplat/3DGS sidecar command and rebaked the result back to the final mesh asset.',
        }
        write_json(output_dir / 'summary.json', summary)
        return summary

    if detail_mesh_assets is not None and not dry_run:
        try:
            uv_undistorted_dir = None
            uv_undistorted_dir_value = uv_assets['summary'].get('undistortedDir')
            if uv_undistorted_dir_value:
                uv_undistorted_dir = Path(uv_undistorted_dir_value)

            refined_assets = run_traditional_detail_texturing(
                detail_mesh_assets['meshPath'],
                images_dir,
                sfm_text_model_dir,
                output_dir,
                undistorted_dir=uv_undistorted_dir,
            )
            summary = {
                'jobId': job_id,
                'createdAt': now_iso(),
                'dryRun': False,
                'mode': 'detail_mesh_traditional_texturing',
                'refinerCommandConfigured': bool(REFINER_COMMAND),
                'meshSource': detail_mesh_assets['meshType'],
                **refined_assets,
                'note': 'Appearance refinement textured the dense detail mesh directly using the available detail-mesh texturing backend.',
            }
            write_json(output_dir / 'summary.json', summary)
            return summary
        except Exception:
            raise

    if dry_run:
        refined_assets = copy_uv_assets(uv_assets['meshPath'], uv_assets['texturePath'], uv_assets['mtlPath'], output_dir)
        summary = {
            'jobId': job_id,
            'createdAt': now_iso(),
            'dryRun': True,
            'mode': 'dry_run_passthrough',
            'refinerCommandConfigured': bool(REFINER_COMMAND),
            'meshSource': uv_assets['meshType'],
            **refined_assets,
            'note': 'Dry-run appearance refinement passes through placeholder assets only for local contract validation.',
        }
        write_json(output_dir / 'summary.json', summary)
        return summary

    if detail_mesh_assets is None:
        raise RuntimeError('appearance_refinement_detail_mesh_missing')

    raise RuntimeError('appearance_refinement_requires_gsplat_or_openmvs_texturing')


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 appearance refinement')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--sfm-text-model-dir', required=True)
    parser.add_argument('--uv-bake-dir', required=True)
    parser.add_argument('--mesh-authoring-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    summary = run_appearance_refinement(
        job_id=args.job_id,
        images_dir=Path(args.images_dir),
        sfm_text_model_dir=Path(args.sfm_text_model_dir),
        uv_bake_dir=Path(args.uv_bake_dir),
        mesh_authoring_dir=Path(args.mesh_authoring_dir),
        output_dir=ensure_dir(Path(args.output_dir)),
        dry_run=args.dry_run,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()