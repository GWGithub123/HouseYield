#!/usr/bin/env python3
"""Run post-SfM Depth Anything priors for master_v1 selected frames.

This stage executes after global SfM so the depth output can be aligned against
registered sparse geometry before the gaussian and dense-evidence branches
consume it.

Outputs:

  priors/depth/
    depth/
    normals/
    confidence/
    previews/
    summary.json

The on-disk artifact shape intentionally mirrors the old Metric3D prior contract
so downstream stages can migrate with minimal churn.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

MASTER_PIPELINE_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = MASTER_PIPELINE_DIR.parent
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR / 'photogrammetry'
if str(MASTER_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(MASTER_PIPELINE_DIR))
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

DENSE_EVIDENCE_IMPORT_ERROR: Exception | None = None
DENSE_EVIDENCE = None
try:
    import run_dense_evidence as DENSE_EVIDENCE  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    DENSE_EVIDENCE_IMPORT_ERROR = exc

SEMANTIC_MASKS_IMPORT_ERROR: Exception | None = None
SEMANTIC_MASKS = None
try:
    import run_semantic_masks as SEMANTIC_MASKS  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    SEMANTIC_MASKS_IMPORT_ERROR = exc

DEPTH_ANYTHING_IMPORT_ERROR: Exception | None = None
DepthAnythingV2 = None
try:
    from generate_depth_priors import DepthAnythingV2  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    DEPTH_ANYTHING_IMPORT_ERROR = exc


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def parse_gpu_indices(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []

    indices: list[str] = []
    for token in str(raw_value).split(','):
        token = token.strip()
        if not token:
            continue
        index = int(token)
        if index < 0:
            raise ValueError(f'invalid_gpu_index:{token}')
        indices.append(str(index))
    return indices


def resolve_model_device(gpu_indices: list[str]) -> str:
    try:
        import torch
    except Exception:
        return 'cpu'

    if torch.cuda.is_available():
        return f'cuda:{gpu_indices[0]}' if gpu_indices else 'cuda'
    return 'cpu'


def ensure_output_dirs(output_dir: Path) -> dict[str, Path]:
    return {
        'depth': ensure_dir(output_dir / 'depth'),
        'normals': ensure_dir(output_dir / 'normals'),
        'confidence': ensure_dir(output_dir / 'confidence'),
        'previews': ensure_dir(output_dir / 'previews'),
    }


def save_preview(depth, confidence, depth_preview_path: Path, confidence_preview_path: Path) -> None:
    import cv2

    finite = depth[np.isfinite(depth)]
    if finite.size == 0:
        finite = np.array([0.0, 1.0], dtype=np.float32)

    depth_min = float(np.percentile(finite, 5))
    depth_max = float(np.percentile(finite, 95))
    if depth_max <= depth_min:
        depth_max = depth_min + 1.0

    depth_scaled = ((depth - depth_min) / (depth_max - depth_min)).clip(0.0, 1.0)
    depth_uint8 = (depth_scaled * 255).astype(np.uint8)
    depth_colored = cv2.applyColorMap(depth_uint8, cv2.COLORMAP_INFERNO)
    cv2.imwrite(str(depth_preview_path), depth_colored)

    confidence_scaled = confidence.clip(0.0, 1.0)
    confidence_uint8 = (confidence_scaled * 255).astype(np.uint8)
    cv2.imwrite(str(confidence_preview_path), confidence_uint8)


def derive_normals_from_depth(depth, fx: float, fy: float):
    dz_dy, dz_dx = np.gradient(depth)
    nx = -dz_dx * fx
    ny = -dz_dy * fy
    nz = np.ones_like(depth)
    normals = np.stack([nx, ny, nz], axis=-1)
    norm = np.linalg.norm(normals, axis=-1, keepdims=True)
    norm[norm == 0] = 1.0
    return (normals / norm).astype(np.float32)


def load_masks_manifest(masks_dir: Path | None):
    if masks_dir is None or SEMANTIC_MASKS is None:
        return None
    try:
        manifest = SEMANTIC_MASKS.load_manifest(masks_dir)
    except Exception:
        return None
    if not manifest or manifest.get('status') not in {'ok', 'no_detections'}:
        return None
    return manifest


def build_no_trust_mask(*, image_name: str, masks_dir: Path | None, masks_manifest, target_shape: tuple[int, int]):
    import cv2

    if masks_dir is None or masks_manifest is None or SEMANTIC_MASKS is None:
        return None
    try:
        frame_masks = SEMANTIC_MASKS.load_frame_masks(masks_dir, image_name, masks_manifest)
    except Exception:
        return None

    height, width = target_shape
    no_trust = None
    for class_name in ('mirror', 'window', 'glass'):
        class_mask = frame_masks.get(class_name)
        if class_mask is None:
            continue
        class_mask = np.asarray(class_mask)
        if class_mask.shape[:2] != (height, width):
            class_mask = cv2.resize(class_mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST)
        class_bool = class_mask.astype(bool)
        no_trust = class_bool if no_trust is None else (no_trust | class_bool)
    return no_trust


def write_depth_outputs(
    *,
    image_path: Path,
    output_dirs: dict[str, Path],
    depth: np.ndarray,
    confidence: np.ndarray,
    intrinsics: dict,
    calibration: dict,
    mask_excluded_pixel_count: int,
) -> dict:
    depth_path = output_dirs['depth'] / f'{image_path.stem}_depth.npy'
    confidence_path = output_dirs['confidence'] / f'{image_path.stem}_confidence.npy'
    normals_path = output_dirs['normals'] / f'{image_path.stem}_normals.npy'

    normals = derive_normals_from_depth(depth, float(intrinsics['fx']), float(intrinsics['fy']))
    np.save(depth_path, np.asarray(depth, dtype=np.float32))
    np.save(confidence_path, np.asarray(confidence, dtype=np.float32))
    np.save(normals_path, np.asarray(normals, dtype=np.float32))

    save_preview(
        depth,
        confidence,
        output_dirs['previews'] / f'{image_path.stem}_depth_preview.png',
        output_dirs['previews'] / f'{image_path.stem}_confidence_preview.png',
    )

    return {
        'image': image_path.name,
        'width': int(depth.shape[1]),
        'height': int(depth.shape[0]),
        'depthPath': str(depth_path),
        'confidencePath': str(confidence_path),
        'normalsPath': str(normals_path),
        'calibration': calibration,
        'maskExcludedPixelCount': int(mask_excluded_pixel_count),
    }


def build_worker_manifest(job_id: str, dry_run: bool, device: str, gpu_indices: list[str], shard_index: int, shard_count: int, processed: list[dict]) -> dict:
    return {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'device': device,
        'gpuIndices': gpu_indices,
        'shardIndex': shard_index,
        'shardCount': shard_count,
        'processedImages': processed,
    }


def run_dry_run_subset(
    *,
    images: list[Path],
    output_dir: Path,
    intrinsics: dict,
) -> tuple[list[dict], str]:
    from PIL import Image

    output_dirs = ensure_output_dirs(output_dir)
    processed: list[dict] = []
    for image_path in images:
        with Image.open(image_path) as image:
            width, height = image.size
        depth = np.ones((height, width), dtype=np.float32)
        confidence = np.full((height, width), 0.5, dtype=np.float32)
        processed.append(
            write_depth_outputs(
                image_path=image_path,
                output_dirs=output_dirs,
                depth=depth,
                confidence=confidence,
                intrinsics=intrinsics,
                calibration={'applied': False, 'anchorCount': 0, 'scale': None, 'bias': None, 'medianResidual': None, 'method': 'dry_run'},
                mask_excluded_pixel_count=0,
            )
        )
    return processed, 'cpu'


def run_depth_priors_subset(
    *,
    images: list[Path],
    images_dir: Path,
    sfm_text_model_dir: Path,
    output_dir: Path,
    masks_dir: Path | None,
    model_size: str,
    gpu_indices: list[str],
) -> tuple[list[dict], str]:
    import cv2

    if DepthAnythingV2 is None:
        raise RuntimeError(f'depth_anything_import_failed:{DEPTH_ANYTHING_IMPORT_ERROR}')
    if DENSE_EVIDENCE is None:
        raise RuntimeError(f'dense_evidence_import_failed:{DENSE_EVIDENCE_IMPORT_ERROR}')

    cameras_path = sfm_text_model_dir / 'cameras.txt'
    images_path = sfm_text_model_dir / 'images.txt'
    points_path = sfm_text_model_dir / 'points3D.txt'
    if not cameras_path.exists() or not images_path.exists() or not points_path.exists():
        raise RuntimeError('depth_prior_alignment_inputs_missing')

    cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(cameras_path)
    images_meta = DENSE_EVIDENCE.parse_colmap_images_txt(images_path)
    points_by_id = DENSE_EVIDENCE.parse_colmap_points_lookup(points_path)
    if not cameras or not images_meta or not points_by_id:
        raise RuntimeError('depth_prior_alignment_inputs_missing')

    output_dirs = ensure_output_dirs(output_dir)
    masks_manifest = load_masks_manifest(masks_dir)
    device = resolve_model_device(gpu_indices)
    model = DepthAnythingV2(model_size=model_size, device=device)
    processed: list[dict] = []

    for image_path in images:
        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f'Unable to load image: {image_path}')
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        raw_depth = np.asarray(model.estimate_depth(image_rgb), dtype=np.float32)
        confidence = np.ones(raw_depth.shape[:2], dtype=np.float32)
        no_trust_mask = build_no_trust_mask(
            image_name=image_path.name,
            masks_dir=masks_dir,
            masks_manifest=masks_manifest,
            target_shape=raw_depth.shape[:2],
        )
        mask_excluded_pixel_count = 0
        if no_trust_mask is not None and np.any(no_trust_mask):
            mask_excluded_pixel_count = int(no_trust_mask.sum())
            confidence[no_trust_mask] = 0.0

        image_data = images_meta.get(image_path.name)
        if image_data is None:
            raise RuntimeError(f'global_sfm_image_missing:{image_path.name}')
        camera = cameras.get(image_data['cam_id'])
        if camera is None:
            raise RuntimeError(f'global_sfm_camera_missing:{image_path.name}')

        calibrated_depth, calibration = DENSE_EVIDENCE.calibrate_metric3d_depth_map(
            raw_depth,
            confidence,
            image_data,
            camera,
            points_by_id,
        )
        if not calibration.get('applied'):
            confidence = np.zeros_like(confidence, dtype=np.float32)
            calibrated_depth = np.where(np.isfinite(raw_depth), raw_depth, 0.0).astype(np.float32)

        if no_trust_mask is not None and np.any(no_trust_mask):
            calibrated_depth = np.asarray(calibrated_depth, dtype=np.float32)
            calibrated_depth[no_trust_mask] = 0.0
            confidence = np.asarray(confidence, dtype=np.float32)
            confidence[no_trust_mask] = 0.0

        intrinsics = {
            'fx': float(DENSE_EVIDENCE.get_intrinsics_matrix(camera)[0, 0]),
            'fy': float(DENSE_EVIDENCE.get_intrinsics_matrix(camera)[1, 1]),
            'cx': float(DENSE_EVIDENCE.get_intrinsics_matrix(camera)[0, 2]),
            'cy': float(DENSE_EVIDENCE.get_intrinsics_matrix(camera)[1, 2]),
        }
        processed.append(
            write_depth_outputs(
                image_path=image_path,
                output_dirs=output_dirs,
                depth=calibrated_depth.astype(np.float32),
                confidence=confidence.astype(np.float32),
                intrinsics=intrinsics,
                calibration=calibration,
                mask_excluded_pixel_count=mask_excluded_pixel_count,
            )
        )

    return processed, str(device)


def run_worker(
    *,
    job_id: str,
    images: list[Path],
    images_dir: Path,
    sfm_text_model_dir: Path,
    output_dir: Path,
    masks_dir: Path | None,
    model_size: str,
    dry_run: bool,
    gpu_indices: list[str],
    shard_index: int,
    shard_count: int,
) -> dict:
    assigned_images = [image for index, image in enumerate(images) if index % max(shard_count, 1) == shard_index]
    cameras = DENSE_EVIDENCE.parse_colmap_cameras_txt(sfm_text_model_dir / 'cameras.txt') if DENSE_EVIDENCE is not None and (sfm_text_model_dir / 'cameras.txt').exists() else {}
    first_camera = next(iter(cameras.values()), None)
    intrinsics = {
        'fx': float(DENSE_EVIDENCE.get_intrinsics_matrix(first_camera)[0, 0]) if first_camera and DENSE_EVIDENCE is not None else 1.0,
        'fy': float(DENSE_EVIDENCE.get_intrinsics_matrix(first_camera)[1, 1]) if first_camera and DENSE_EVIDENCE is not None else 1.0,
    }
    if dry_run:
        processed, device = run_dry_run_subset(images=assigned_images, output_dir=output_dir, intrinsics=intrinsics)
    else:
        processed, device = run_depth_priors_subset(
            images=assigned_images,
            images_dir=images_dir,
            sfm_text_model_dir=sfm_text_model_dir,
            output_dir=output_dir,
            masks_dir=masks_dir,
            model_size=model_size,
            gpu_indices=gpu_indices,
        )
    return build_worker_manifest(job_id, dry_run, device, gpu_indices, shard_index, shard_count, processed)


def finalize_summary(job_id: str, images: list[Path], output_dir: Path, model_size: str, manifests: list[dict]) -> dict:
    processed_images = sorted(
        [image for manifest in manifests for image in manifest.get('processedImages', [])],
        key=lambda item: item['image'],
    )
    dry_run = any(bool(manifest.get('dryRun')) for manifest in manifests)
    devices_used = sorted({manifest['device'] for manifest in manifests})
    aligned_count = sum(1 for image in processed_images if bool((image.get('calibration') or {}).get('applied')))
    anchor_count = sum(int((image.get('calibration') or {}).get('anchorCount', 0) or 0) for image in processed_images)
    mask_excluded_pixel_count = sum(int(image.get('maskExcludedPixelCount', 0) or 0) for image in processed_images)
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'method': 'depth_anything_v2_post_sfm_aligned',
        'provider': 'depth_anything_v2',
        'dryRun': dry_run,
        'device': devices_used[0] if len(devices_used) == 1 else 'multi_gpu',
        'devicesUsed': devices_used,
        'modelSize': model_size,
        'normalSource': 'derived_from_depth_gradient',
        'imageCount': len(processed_images),
        'coverageRatio': float(len(processed_images)) / float(len(images)) if images else 0.0,
        'alignedImageCount': int(aligned_count),
        'calibrationAnchorCount': int(anchor_count),
        'maskExcludedPixelCount': int(mask_excluded_pixel_count),
        'processedImages': processed_images,
        'shardCount': len(manifests),
    }
    if dry_run:
        summary['note'] = 'Dry-run output for post-SfM depth prior wiring validation only.'

    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_sharded(args, images: list[Path], output_dir: Path, gpu_indices: list[str]) -> dict:
    shard_dir = ensure_dir(output_dir / '.shards')
    processes = []

    for shard_index, gpu_index in enumerate(gpu_indices):
        manifest_path = shard_dir / f'shard_{shard_index:02d}.json'
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            '--job-id', args.job_id,
            '--images-dir', args.images_dir,
            '--sfm-text-model-dir', args.sfm_text_model_dir,
            '--output-dir', args.output_dir,
            *( ['--masks-dir', args.masks_dir] if args.masks_dir else [] ),
            '--model-size', args.model_size,
            '--gpu-indices', gpu_index,
            '--shard-index', str(shard_index),
            '--shard-count', str(len(gpu_indices)),
            '--manifest-path', str(manifest_path),
        ]
        if args.dry_run:
            command.append('--dry-run')
        processes.append({
            'gpuIndex': gpu_index,
            'manifestPath': manifest_path,
            'process': subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(Path(__file__).resolve().parents[3]),
                env=os.environ.copy(),
            ),
        })

    manifests = []
    errors = []
    for shard in processes:
        stdout, stderr = shard['process'].communicate()
        if shard['process'].returncode != 0:
            errors.append(
                f"gpu={shard['gpuIndex']} exit={shard['process'].returncode}\n{stdout.strip()}\n{stderr.strip()}".strip()
            )
            continue
        manifests.append(json.loads(Path(shard['manifestPath']).read_text(encoding='utf-8')))

    if errors:
        raise RuntimeError('depth_priors_sharded_failed\n' + '\n\n'.join(error for error in errors if error))

    return finalize_summary(args.job_id, images, output_dir, args.model_size, manifests)


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 post-SfM Depth Anything priors')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--sfm-text-model-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--masks-dir', default='')
    parser.add_argument('--model-size', default='large')
    parser.add_argument('--gpu-indices', default=os.environ.get('MASTER_PIPELINE_DEPTH_PRIORS_GPU_INDICES', ''))
    parser.add_argument('--shard-index', type=int, default=0)
    parser.add_argument('--shard-count', type=int, default=1)
    parser.add_argument('--manifest-path')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    sfm_text_model_dir = Path(args.sfm_text_model_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    images = list_images(images_dir)

    if not images:
        raise RuntimeError(f'No images found in {images_dir}')
    if not sfm_text_model_dir.exists():
        raise RuntimeError(f'Missing SfM text model directory at {sfm_text_model_dir}')

    gpu_indices = parse_gpu_indices(args.gpu_indices)
    masks_dir = Path(args.masks_dir) if args.masks_dir else None

    if args.manifest_path:
        manifest = run_worker(
            job_id=args.job_id,
            images=images,
            images_dir=images_dir,
            sfm_text_model_dir=sfm_text_model_dir,
            output_dir=output_dir,
            masks_dir=masks_dir,
            model_size=args.model_size,
            dry_run=args.dry_run,
            gpu_indices=gpu_indices,
            shard_index=int(args.shard_index),
            shard_count=max(int(args.shard_count), 1),
        )
        Path(args.manifest_path).write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(json.dumps({
            'jobId': args.job_id,
            'device': manifest['device'],
            'processedImageCount': len(manifest['processedImages']),
            'shardIndex': manifest['shardIndex'],
            'shardCount': manifest['shardCount'],
        }), flush=True)
        return

    if len(gpu_indices) > 1 and not args.dry_run:
        summary = run_sharded(args, images, output_dir, gpu_indices)
    else:
        manifest = run_worker(
            job_id=args.job_id,
            images=images,
            images_dir=images_dir,
            sfm_text_model_dir=sfm_text_model_dir,
            output_dir=output_dir,
            masks_dir=masks_dir,
            model_size=args.model_size,
            dry_run=args.dry_run,
            gpu_indices=gpu_indices,
            shard_index=0,
            shard_count=1,
        )
        summary = finalize_summary(args.job_id, images, output_dir, args.model_size, [manifest])

    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
