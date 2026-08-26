#!/usr/bin/env python3
"""Bake initial textures for the canonical shell mesh.

Real runs use COLMAP image undistortion plus OpenMVS InterfaceCOLMAP and
TextureMesh. Dry runs emit a placeholder texture and MTL so downstream stages
can validate the artifact contract locally.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def run_command(command: list[str], cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=str(cwd) if cwd else None, check=True)


def find_sparse_model_dir(root: Path) -> Path:
    candidates = [root]
    candidates.extend(sorted(path for path in root.iterdir() if path.is_dir()))
    for candidate in candidates:
        if (candidate / 'cameras.bin').exists() and (candidate / 'images.bin').exists():
            return candidate
        if (candidate / 'cameras.txt').exists() and (candidate / 'images.txt').exists():
            return candidate
    raise FileNotFoundError(f'No sparse model found under {root}')


def resolve_binary(name: str) -> str:
    binary = shutil.which(name)
    if not binary:
        raise RuntimeError(f'Required binary not found on PATH: {name}')
    return binary


def fix_mtl_transparency(mtl_path: Path) -> None:
    if not mtl_path.exists():
        return
    content = mtl_path.read_text(encoding='utf-8')
    content = content.replace('Tr 1.0', 'd 1.0')
    content = content.replace('Tr 0.0', 'd 1.0')
    if 'map_Kd' in content and 'd ' not in content:
        content += '\nd 1.0\n'
    mtl_path.write_text(content, encoding='utf-8')


def write_placeholder_texture(texture_path: Path) -> None:
    image = Image.new('RGB', (1024, 1024), '#d7d2c8')
    draw = ImageDraw.Draw(image)
    for step in range(0, 1024, 128):
        draw.line((step, 0, step, 1023), fill='#b8b1a6', width=2)
        draw.line((0, step, 1023, step), fill='#b8b1a6', width=2)
    draw.rectangle((96, 96, 928, 928), outline='#f1eee8', width=6)
    image.save(texture_path)


def write_placeholder_textured_obj(shell_mesh_path: Path, output_dir: Path) -> dict:
    obj_path = output_dir / 'textured_shell.obj'
    mtl_path = output_dir / 'textured_shell.mtl'
    texture_path = output_dir / 'initial_texture.png'
    write_placeholder_texture(texture_path)

    source_lines = shell_mesh_path.read_text(encoding='utf-8').splitlines()
    obj_lines = [f'mtllib {mtl_path.name}']
    use_material_inserted = False
    for line in source_lines:
        if line.startswith('f ') and not use_material_inserted:
            obj_lines.append('usemtl material_0')
            use_material_inserted = True
        obj_lines.append(line)
    obj_path.write_text('\n'.join(obj_lines) + '\n', encoding='utf-8')

    mtl_path.write_text(
        '\n'.join([
            'newmtl material_0',
            'Ka 1.000 1.000 1.000',
            'Kd 1.000 1.000 1.000',
            'Ks 0.000 0.000 0.000',
            'd 1.0',
            f'map_Kd {texture_path.name}',
            '',
        ]),
        encoding='utf-8',
    )

    return {
        'backend': 'dry_run_placeholder',
        'texturedMeshPath': str(obj_path),
        'mtlPath': str(mtl_path),
        'texturePath': str(texture_path),
        'undistortedDir': None,
        'sceneMvsPath': None,
    }


def run_uv_initial_bake(job_id: str, images_dir: Path, sfm_sparse_model_dir: Path, shell_mesh_path: Path, output_dir: Path, dry_run: bool) -> dict:
    if dry_run:
        assets = write_placeholder_textured_obj(shell_mesh_path, output_dir)
        summary = {
            'jobId': job_id,
            'createdAt': now_iso(),
            'dryRun': True,
            **assets,
            'note': 'Dry-run UV bake writes a placeholder texture so downstream refinement/export can be validated locally.',
        }
        write_json(output_dir / 'summary.json', summary)
        return summary

    colmap = resolve_binary('colmap')
    interface_colmap = resolve_binary('InterfaceCOLMAP')
    texture_mesh = resolve_binary('TextureMesh')
    sparse_model_dir = find_sparse_model_dir(sfm_sparse_model_dir)

    dense_dir = ensure_dir(output_dir / 'colmap_dense')
    scene_mvs = output_dir / 'textured_shell.mvs'
    run_command([
        colmap,
        'image_undistorter',
        '--image_path', str(images_dir),
        '--input_path', str(sparse_model_dir),
        '--output_path', str(dense_dir),
        '--output_type', 'COLMAP',
    ])

    run_command([
        interface_colmap,
        '-i', str(dense_dir),
        '-o', str(scene_mvs),
        '--image-folder', str(dense_dir / 'images'),
    ])

    run_command([
        texture_mesh,
        str(scene_mvs),
        '--mesh-file', str(shell_mesh_path),
        '-o', str(scene_mvs),
        '--export-type', 'obj',
        '--resolution-level', '1',
        '--cost-smoothness-ratio', '0.1',
    ], cwd=output_dir)

    textured_mesh_path = output_dir / 'textured_shell.obj'
    mtl_path = output_dir / 'textured_shell.mtl'
    texture_candidates = sorted(output_dir.glob('textured_shell*map_Kd*'))
    if not textured_mesh_path.exists() or not mtl_path.exists() or not texture_candidates:
        raise RuntimeError('uv_initial_bake_outputs_missing')

    fix_mtl_transparency(mtl_path)
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': False,
        'backend': 'openmvs_texturemesh',
        'texturedMeshPath': str(textured_mesh_path),
        'mtlPath': str(mtl_path),
        'texturePath': str(texture_candidates[0]),
        'undistortedDir': str(dense_dir),
        'sceneMvsPath': str(scene_mvs),
        'note': 'Initial UV bake uses the authored structural shell mesh with multi-view OpenMVS texturing.',
    }
    write_json(output_dir / 'summary.json', summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 UV initial bake')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--sfm-sparse-model-dir', required=True)
    parser.add_argument('--shell-mesh-path', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    summary = run_uv_initial_bake(
        job_id=args.job_id,
        images_dir=Path(args.images_dir),
        sfm_sparse_model_dir=Path(args.sfm_sparse_model_dir),
        shell_mesh_path=Path(args.shell_mesh_path),
        output_dir=ensure_dir(Path(args.output_dir)),
        dry_run=args.dry_run,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()