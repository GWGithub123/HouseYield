#!/usr/bin/env python3
"""Generate COLMAP depth priors from Metric3D predictions.

Metric3D is used here as a secondary prior source behind Fast3R. The predicted
depth maps are calibrated against sparse SfM anchor depths before being written
as COLMAP photometric initialization maps.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from photogrammetry.generate_depth_priors import (
    compute_normals_from_depth,
    save_colmap_depth_map,
    save_colmap_normal_map,
)
from photogrammetry.generate_fast3r_depth_priors import ensure_text_model, list_images

SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from master_pipeline.run_dense_evidence import (
    calibrate_metric3d_depth_map,
    parse_colmap_cameras_txt,
    parse_colmap_images_txt,
    parse_colmap_points_lookup,
    read_json,
)


def read_env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return int(default)


DEFAULT_METRIC3D_MODEL_SIZE = os.environ.get('PHOTOGRAMMETRY_METRIC3D_MODEL_SIZE', 'large')
MIN_METRIC3D_CONFIDENCE = float(os.environ.get('PHOTOGRAMMETRY_METRIC3D_MIN_CONFIDENCE', '0.05'))
METRIC3D_PRIOR_FILL_MISSING = os.environ.get('PHOTOGRAMMETRY_METRIC3D_FILL_MISSING', 'false').lower() == 'true'
DEFAULT_METRIC3D_PRIOR_IMAGE_SIZE = read_env_int('PHOTOGRAMMETRY_METRIC3D_PRIOR_IMAGE_SIZE', 1024)


def build_intrinsics(camera: dict) -> dict:
    params = camera.get('params', [])
    model = camera.get('model')
    if model in ('SIMPLE_PINHOLE', 'SIMPLE_RADIAL'):
        fx = fy = float(params[0])
        cx = float(params[1])
        cy = float(params[2])
    elif model in ('PINHOLE', 'OPENCV', 'RADIAL'):
        fx = float(params[0])
        fy = float(params[1])
        cx = float(params[2])
        cy = float(params[3])
    else:
        fx = fy = float(params[0]) if params else float(camera['width'])
        cx = float(camera['width']) / 2.0
        cy = float(camera['height']) / 2.0

    return {
        'fx': fx,
        'fy': fy,
        'cx': cx,
        'cy': cy,
        'width': int(camera['width']),
        'height': int(camera['height']),
    }


def run_metric3d_worker(images_dir: Path, calibration_dir: Path, output_dir: Path, gpu_indices: str | None, model_size: str) -> Path:
    script_path = SCRIPTS_ROOT / 'master_pipeline' / 'run_metric3d_priors.py'
    if not script_path.exists():
        raise FileNotFoundError(f'Metric3D priors script not found at {script_path}')

    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        str(script_path),
        '--job-id',
        output_dir.name,
        '--images-dir',
        str(images_dir),
        '--calibration-dir',
        str(calibration_dir),
        '--output-dir',
        str(output_dir),
        '--model-size',
        str(model_size),
    ]
    if gpu_indices:
        command.extend(['--gpu-indices', gpu_indices])

    subprocess.run(
        command,
        check=True,
        cwd=str(SCRIPTS_ROOT.parents[1]),
        env=os.environ.copy(),
    )
    return output_dir


def generate_metric3d_depth_priors(
    images_dir: Path,
    output_dir: Path,
    sparse_model_dir: Path,
    colmap_path: str,
    gpu_indices: str | None = None,
    model_size: str = DEFAULT_METRIC3D_MODEL_SIZE,
) -> dict:
    images_dir = Path(images_dir)
    output_dir = Path(output_dir)
    sparse_model_dir = Path(sparse_model_dir)

    image_files = list_images(images_dir)
    if not image_files:
        raise ValueError(f'No images found in {images_dir}')

    text_model_dir = ensure_text_model(sparse_model_dir, colmap_path)
    cameras = parse_colmap_cameras_txt(text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')
    points_by_id = parse_colmap_points_lookup(text_model_dir / 'points3D.txt')
    if not cameras or not images_meta or not points_by_id:
        raise RuntimeError('Metric3D depth priors need a COLMAP text model with cameras, images, and sparse points')

    first_camera = cameras[next(iter(cameras))]
    calibration_workspace = Path(tempfile.mkdtemp(prefix='metric3d_calibration_'))
    try:
        intrinsics = build_intrinsics(first_camera)
        (calibration_workspace / 'intrinsics.json').write_text(json.dumps(intrinsics, indent=2), encoding='utf-8')

        priors_workspace = output_dir / 'metric3d_depth_priors'
        metric3d_dir = run_metric3d_worker(
            images_dir=images_dir,
            calibration_dir=calibration_workspace,
            output_dir=priors_workspace / 'metric3d',
            gpu_indices=gpu_indices,
            model_size=model_size,
        )
    finally:
        shutil.rmtree(calibration_workspace, ignore_errors=True)

    summary_path = metric3d_dir / 'summary.json'
    if not summary_path.exists():
        raise RuntimeError('Metric3D prior worker did not produce summary.json')

    summary = read_json(summary_path)
    processed_by_name = {
        entry.get('image'): entry
        for entry in summary.get('processedImages', [])
        if entry.get('image')
    }

    depth_maps_dir = output_dir / 'stereo' / 'depth_maps'
    normal_maps_dir = output_dir / 'stereo' / 'normal_maps'
    depth_maps_dir.mkdir(parents=True, exist_ok=True)
    normal_maps_dir.mkdir(parents=True, exist_ok=True)

    results = {
        'source': 'metric3d',
        'num_images': len(image_files),
        'generatedImageCount': 0,
        'modelSize': model_size,
        'devicesUsed': summary.get('devicesUsed', []),
        'shardCount': int(summary.get('shardCount', 1) or 1),
        'metric3dSummaryPath': str(summary_path),
        'metric3dDir': str(metric3d_dir),
        'depth_maps': [],
        'normal_maps': [],
        'images': [],
    }

    for image_path in image_files:
        image_name = image_path.name
        image_entry = images_meta.get(image_name)
        if image_entry is None:
            continue

        camera = cameras.get(image_entry['cam_id'])
        processed = processed_by_name.get(image_name)
        if camera is None or processed is None:
            results['images'].append({
                'image': image_name,
                'generated': False,
                'reason': 'missing_metric3d_output',
            })
            continue

        depth_path = Path(processed['depthPath'])
        confidence_path = Path(processed['confidencePath'])
        if not depth_path.exists() or not confidence_path.exists():
            results['images'].append({
                'image': image_name,
                'generated': False,
                'reason': 'missing_metric3d_arrays',
            })
            continue

        raw_depth = np.load(depth_path).astype(np.float32)
        confidence = np.load(confidence_path).astype(np.float32)
        confidence = np.where(np.isfinite(confidence) & (confidence >= MIN_METRIC3D_CONFIDENCE), confidence, 0.0).astype(np.float32)

        calibrated_depth, calibration = calibrate_metric3d_depth_map(
            raw_depth,
            confidence,
            image_entry,
            camera,
            points_by_id,
        )
        calibrated_depth = np.asarray(calibrated_depth, dtype=np.float32)
        calibrated_depth = np.where(np.isfinite(calibrated_depth), calibrated_depth, 0.0)
        if not METRIC3D_PRIOR_FILL_MISSING:
            calibrated_depth = np.where(confidence > 0.0, calibrated_depth, 0.0)

        valid_depth = calibrated_depth[calibrated_depth > 0.05]
        if not calibration.get('applied') or valid_depth.size == 0:
            results['images'].append({
                'image': image_name,
                'generated': False,
                'reason': 'calibration_failed',
                'calibration': calibration,
            })
            continue

        normals = compute_normals_from_depth(calibrated_depth)
        depth_output_path = depth_maps_dir / f'{image_path.stem}.photometric.bin'
        normal_output_path = normal_maps_dir / f'{image_path.stem}.photometric.bin'
        save_colmap_depth_map(calibrated_depth, depth_output_path)
        save_colmap_normal_map(normals, normal_output_path)

        image_summary = {
            'image': image_name,
            'generated': True,
            'coverageRatio': float((calibrated_depth > 0.05).mean()),
            'depthRange': [float(valid_depth.min()), float(valid_depth.max())],
            'calibration': calibration,
            'depthFile': str(depth_output_path),
            'normalFile': str(normal_output_path),
        }
        results['generatedImageCount'] += 1
        results['depth_maps'].append({
            'image': image_name,
            'depth_file': str(depth_output_path),
            'depth_range': image_summary['depthRange'],
        })
        results['normal_maps'].append({
            'image': image_name,
            'normal_file': str(normal_output_path),
        })
        results['images'].append(image_summary)

    manifest_path = output_dir / 'metric3d_depth_priors_manifest.json'
    manifest_path.write_text(json.dumps(results, indent=2), encoding='utf-8')
    return results