#!/usr/bin/env python3
"""Run Metric3D soft priors for master_v1 selected frames.

The worker writes depth, confidence, preview, and normal prior artifacts into:

  priors/metric3d/
    depth/
    normals/
    confidence/
    previews/
    summary.json

Normals are currently derived from the predicted depth maps to keep the stage
contract explicit until a direct normal-head integration is added.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


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


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Reflective / transmissive surface depth conditioning (Stage 0 mask consumer)
# ---------------------------------------------------------------------------

_REFLECTIVE_MASK_STATE: dict = {'masks_dir': None, 'manifest': None, 'loader': None}


def configure_reflective_masks(masks_dir: Path | None) -> None:
    """Load the semantic-mask manifest once so per-image flattening can route on it."""
    _REFLECTIVE_MASK_STATE['masks_dir'] = None
    _REFLECTIVE_MASK_STATE['manifest'] = None
    _REFLECTIVE_MASK_STATE['loader'] = None
    if masks_dir is None:
        return
    try:
        import run_semantic_masks as loader
    except Exception:
        script_dir = Path(__file__).resolve().parent
        if str(script_dir) not in sys.path:
            sys.path.insert(0, str(script_dir))
        try:
            import run_semantic_masks as loader  # type: ignore[no-redef]
        except Exception:
            return
    manifest = loader.load_manifest(masks_dir)
    if not manifest or manifest.get('status') not in {'ok', 'no_detections'}:
        return
    _REFLECTIVE_MASK_STATE['masks_dir'] = Path(masks_dir)
    _REFLECTIVE_MASK_STATE['manifest'] = manifest
    _REFLECTIVE_MASK_STATE['loader'] = loader


def _fit_plane_ransac(points, iterations: int = 200, threshold: float = 0.04):
    """Fit a plane n·X + d = 0 to 3D points; return (normal, d) or None."""
    import numpy as np

    if points.shape[0] < 16:
        return None

    rng = np.random.default_rng(12345)
    best_inliers = None
    best_count = 0
    for _ in range(iterations):
        sample = points[rng.choice(points.shape[0], size=3, replace=False)]
        v1 = sample[1] - sample[0]
        v2 = sample[2] - sample[0]
        normal = np.cross(v1, v2)
        norm = np.linalg.norm(normal)
        if norm < 1e-8:
            continue
        normal = normal / norm
        d = -float(normal @ sample[0])
        distances = np.abs(points @ normal + d)
        inliers = distances < threshold
        count = int(inliers.sum())
        if count > best_count:
            best_count = count
            best_inliers = inliers

    if best_inliers is None or best_count < 16:
        return None

    # Refit on inliers via least squares (centroid + SVD normal).
    inlier_points = points[best_inliers]
    centroid = inlier_points.mean(axis=0)
    _, _, vh = np.linalg.svd(inlier_points - centroid)
    normal = vh[-1]
    normal = normal / max(float(np.linalg.norm(normal)), 1e-8)
    d = -float(normal @ centroid)
    return normal, d


def apply_reflective_depth_flattening(image_name: str, depth, confidence, intrinsics: dict) -> dict | None:
    """Flatten mirror depth onto the surrounding wall plane and suppress
    through-glass transmission depth so downstream geometry is not biased by
    reflections / parallax. Mutates depth and confidence in place.
    """
    loader = _REFLECTIVE_MASK_STATE.get('loader')
    masks_dir = _REFLECTIVE_MASK_STATE.get('masks_dir')
    manifest = _REFLECTIVE_MASK_STATE.get('manifest')
    if loader is None or masks_dir is None:
        return None

    import cv2
    import numpy as np

    masks = loader.load_frame_masks(masks_dir, image_name, manifest)
    if not masks:
        return None

    height, width = depth.shape[:2]
    fx = float(intrinsics['fx'])
    fy = float(intrinsics['fy'])
    cx = float(intrinsics.get('cx', width / 2.0))
    cy = float(intrinsics.get('cy', height / 2.0))

    record: dict = {'image': image_name, 'planes': {}, 'suppressed': {}}

    def to_frame_res(mask):
        if mask.shape[:2] != (height, width):
            mask = cv2.resize(mask.astype(np.uint8), (width, height), interpolation=cv2.INTER_NEAREST)
        return mask > 0

    # Mirror: replace masked depth with the surrounding wall plane.
    mirror_mask = masks.get('mirror')
    if mirror_mask is not None:
        mirror_bool = to_frame_res(mirror_mask)
        if mirror_bool.any():
            dilated = cv2.dilate(mirror_bool.astype(np.uint8), np.ones((15, 15), np.uint8), iterations=1) > 0
            ring = dilated & ~mirror_bool & np.isfinite(depth) & (depth > 0.05)
            ys, xs = np.nonzero(ring)
            if ys.size >= 32:
                ring_depth = depth[ys, xs]
                ring_points = np.stack([
                    (xs - cx) / fx * ring_depth,
                    (ys - cy) / fy * ring_depth,
                    ring_depth,
                ], axis=-1)
                plane = _fit_plane_ransac(ring_points)
                if plane is not None:
                    normal, d = plane
                    mys, mxs = np.nonzero(mirror_bool)
                    rays = np.stack([(mxs - cx) / fx, (mys - cy) / fy, np.ones_like(mxs, dtype=np.float64)], axis=-1)
                    denom = rays @ normal
                    valid = np.abs(denom) > 1e-6
                    plane_depth = np.full(mxs.shape, np.nan, dtype=np.float32)
                    plane_depth[valid] = (-d / denom[valid]).astype(np.float32)
                    finite = valid & np.isfinite(plane_depth) & (plane_depth > 0.05) & (plane_depth < 50.0)
                    depth[mys[finite], mxs[finite]] = plane_depth[finite]
                    confidence[mys[finite], mxs[finite]] = np.maximum(
                        confidence[mys[finite], mxs[finite]], 0.5
                    )
                    record['planes']['mirror'] = {
                        'normal': [float(value) for value in normal],
                        'd': float(d),
                        'pixelCount': int(finite.sum()),
                    }

    # Window / glass: suppress transmission depth confidence so the SfM and
    # gaussian stages do not anchor geometry to the scene behind the glass.
    for transmissive in ('window', 'glass'):
        mask = masks.get(transmissive)
        if mask is None:
            continue
        mask_bool = to_frame_res(mask)
        if not mask_bool.any():
            continue
        confidence[mask_bool] = 0.0
        record['suppressed'][transmissive] = int(mask_bool.sum())

    if not record['planes'] and not record['suppressed']:
        return None
    return record


def read_json_safe(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}



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


def resolve_metric3d_repo_dir(cache_root: Path) -> Path:
    candidate_paths: list[Path] = []

    repo_dir_env = os.environ.get('MASTER_PIPELINE_METRIC3D_REPO_DIR')
    if repo_dir_env:
        candidate_paths.append(Path(repo_dir_env).expanduser())

    candidate_paths.extend([
        Path('/opt/Metric3D'),
        cache_root / 'repos' / 'Metric3D',
    ])

    for repo_dir in candidate_paths:
        if (repo_dir / 'hubconf.py').is_file() and (repo_dir / 'mono').is_dir():
            return repo_dir

    searched = ', '.join(str(path) for path in candidate_paths)
    raise RuntimeError(
        'metric3d_repo_missing: expected a local Metric3D checkout with hubconf.py and mono/ at '
        f'{searched}. Set MASTER_PIPELINE_METRIC3D_REPO_DIR or provision /opt/Metric3D.'
    )


def derive_normals_from_depth(depth, fx: float, fy: float):
    import numpy as np

    dz_dy, dz_dx = np.gradient(depth)
    nx = -dz_dx * fx
    ny = -dz_dy * fy
    nz = np.ones_like(depth)
    normals = np.stack([nx, ny, nz], axis=-1)
    norm = np.linalg.norm(normals, axis=-1, keepdims=True)
    norm[norm == 0] = 1.0
    normals = normals / norm
    return normals.astype(np.float32)


def save_preview(depth, confidence, depth_preview_path: Path, confidence_preview_path: Path):
    import cv2
    import numpy as np

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


def ensure_output_dirs(output_dir: Path) -> dict[str, Path]:
    return {
        'depth': ensure_dir(output_dir / 'depth'),
        'normals': ensure_dir(output_dir / 'normals'),
        'confidence': ensure_dir(output_dir / 'confidence'),
        'previews': ensure_dir(output_dir / 'previews'),
    }


def resolve_torch_device(gpu_indices: list[str]):
    import torch

    if torch.cuda.is_available():
        if gpu_indices:
            return torch.device(f'cuda:{gpu_indices[0]}')
        return torch.device('cuda:0')
    return torch.device('cpu')


def normalize_normal_map(normals):
    import numpy as np

    normals = np.asarray(normals, dtype=np.float32)
    norm = np.linalg.norm(normals, axis=-1, keepdims=True)
    return normals / np.maximum(norm, 1e-6)


def write_metric_outputs(image_path: Path, intrinsics: dict, output_dirs: dict[str, Path], depth, confidence, width: int, height: int, normal_map=None) -> dict:
    import numpy as np

    depth = np.asarray(depth, dtype=np.float32)
    confidence = np.asarray(confidence, dtype=np.float32)
    plane_record = apply_reflective_depth_flattening(image_path.name, depth, confidence, intrinsics)

    normal_source = 'metric3d_native'
    if normal_map is not None:
        normals = normalize_normal_map(normal_map)
    else:
        normals = derive_normals_from_depth(depth, float(intrinsics['fx']), float(intrinsics['fy']))
        normal_source = 'derived_from_depth_gradient'
    depth_path = output_dirs['depth'] / f'{image_path.stem}_depth.npy'
    confidence_path = output_dirs['confidence'] / f'{image_path.stem}_confidence.npy'
    normals_path = output_dirs['normals'] / f'{image_path.stem}_normals.npy'

    np.save(depth_path, np.asarray(depth, dtype=np.float32))
    np.save(confidence_path, np.asarray(confidence, dtype=np.float32))
    np.save(normals_path, normals)

    save_preview(
        depth,
        confidence,
        output_dirs['previews'] / f'{image_path.stem}_depth_preview.png',
        output_dirs['previews'] / f'{image_path.stem}_confidence_preview.png',
    )

    record = {
        'image': image_path.name,
        'width': width,
        'height': height,
        'depthPath': str(depth_path),
        'confidencePath': str(confidence_path),
        'normalsPath': str(normals_path),
        'normalSource': normal_source,
    }
    if plane_record is not None:
        record['reflectivePlanes'] = plane_record
    return record


def run_dry_run_subset(images: list[Path], intrinsics: dict, output_dir: Path) -> list[dict]:
    import numpy as np
    from PIL import Image

    output_dirs = ensure_output_dirs(output_dir)
    processed = []
    for image_path in images:
        with Image.open(image_path) as image:
            width, height = image.size

        depth = np.ones((height, width), dtype=np.float32)
        confidence = np.full((height, width), 0.5, dtype=np.float32)
        processed.append(write_metric_outputs(image_path, intrinsics, output_dirs, depth, confidence, width, height))
    return processed


def extract_metric3d_normal_map(output_dict):
    import numpy as np
    import torch

    if not isinstance(output_dict, dict):
        return None
    for key in (
        'normal',
        'normals',
        'pred_normal',
        'pred_normals',
        'prediction_normal',
        'prediction_normals',
        'normal_out',
    ):
        value = output_dict.get(key)
        if value is None:
            continue
        if isinstance(value, (list, tuple)) and value:
            value = value[0]
        if hasattr(value, 'detach'):
            value = value.detach()
        if isinstance(value, torch.Tensor):
            value = value.squeeze().cpu().numpy()
        else:
            value = np.asarray(value)
        if value.ndim == 3 and value.shape[0] == 3 and value.shape[-1] != 3:
            value = np.transpose(value, (1, 2, 0))
        if value.ndim == 3 and value.shape[-1] == 3:
            return value.astype(np.float32)
    return None


def run_metric3d_subset(images: list[Path], intrinsics: dict, output_dir: Path, model_size: str, gpu_indices: list[str]) -> tuple[list[dict], str]:
    import cv2
    import numpy as np
    import torch
    from PIL import Image as PILImage

    output_dirs = ensure_output_dirs(output_dir)
    device = resolve_torch_device(gpu_indices)
    if not images:
        return [], str(device)

    if device.type == 'cuda':
        torch.cuda.set_device(device)

    cache_root = Path(os.environ.get('MASTER_PIPELINE_MODEL_CACHE_DIR', Path.home() / '.cache' / 'houseyield' / 'master_pipeline'))
    hf_home = cache_root / 'huggingface'
    torch_home = cache_root / 'torch'
    hf_home.mkdir(parents=True, exist_ok=True)
    torch_home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('HF_HOME', str(hf_home))
    os.environ.setdefault('TORCH_HOME', str(torch_home))
    torch.hub.set_dir(str(torch_home))
    metric3d_repo_dir = resolve_metric3d_repo_dir(cache_root)

    model = torch.hub.load(
        str(metric3d_repo_dir),
        f'metric3d_vit_{model_size}',
        pretrain=True,
        source='local',
    )
    model = model.to(device).eval()

    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1).to(device)
    std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1).to(device)
    input_h, input_w = 616, 1064

    processed = []
    for image_path in images:
        raw_image = cv2.imread(str(image_path))
        if raw_image is None:
            raise RuntimeError(f'Unable to load image: {image_path}')
        image = cv2.cvtColor(raw_image, cv2.COLOR_BGR2RGB)

        orig_h, orig_w = image.shape[:2]
        image_resized = cv2.resize(image, (input_w, input_h))
        image_tensor = torch.from_numpy(image_resized).permute(2, 0, 1).float().unsqueeze(0).to(device) / 255.0
        image_tensor = (image_tensor - mean) / std

        with torch.no_grad():
            pred_depth, confidence, output_dict = model.inference({'input': image_tensor})

        depth = pred_depth.squeeze().cpu().numpy()
        confidence_map = confidence.squeeze().cpu().numpy() if hasattr(confidence, 'cpu') else confidence
        native_normals = extract_metric3d_normal_map(output_dict)

        depth_resized = np.array(PILImage.fromarray(depth).resize((orig_w, orig_h), PILImage.BILINEAR))
        confidence_resized = np.array(PILImage.fromarray(confidence_map).resize((orig_w, orig_h), PILImage.BILINEAR))
        normals_resized = None
        if native_normals is not None:
            normal_channels = [
                np.array(PILImage.fromarray(native_normals[..., channel]).resize((orig_w, orig_h), PILImage.BILINEAR))
                for channel in range(3)
            ]
            normals_resized = np.stack(normal_channels, axis=-1).astype(np.float32)
        processed.append(write_metric_outputs(
            image_path,
            intrinsics,
            output_dirs,
            depth_resized,
            confidence_resized,
            orig_w,
            orig_h,
            normal_map=normals_resized,
        ))

    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return processed, str(device)


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


def run_worker(job_id: str, images: list[Path], intrinsics: dict, output_dir: Path, model_size: str, dry_run: bool, gpu_indices: list[str], shard_index: int, shard_count: int) -> dict:
    assigned_images = [image for index, image in enumerate(images) if index % max(shard_count, 1) == shard_index]
    if dry_run:
        processed = run_dry_run_subset(assigned_images, intrinsics, output_dir)
        return build_worker_manifest(job_id, True, 'cpu', gpu_indices, shard_index, shard_count, processed)

    processed, device = run_metric3d_subset(assigned_images, intrinsics, output_dir, model_size, gpu_indices)
    return build_worker_manifest(job_id, False, device, gpu_indices, shard_index, shard_count, processed)


def finalize_summary(job_id: str, images: list[Path], intrinsics: dict, output_dir: Path, model_size: str, manifests: list[dict]) -> dict:
    processed_images = sorted(
        [image for manifest in manifests for image in manifest.get('processedImages', [])],
        key=lambda item: item['image'],
    )
    dry_run = any(bool(manifest.get('dryRun')) for manifest in manifests)
    devices_used = sorted({manifest['device'] for manifest in manifests})
    normal_sources = sorted({str(image.get('normalSource') or 'unknown') for image in processed_images})
    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'method': 'metric3d_v2',
        'dryRun': dry_run,
        'device': devices_used[0] if len(devices_used) == 1 else 'multi_gpu',
        'devicesUsed': devices_used,
        'modelSize': model_size,
        'normalSource': normal_sources[0] if len(normal_sources) == 1 else 'mixed',
        'normalSources': normal_sources,
        'imageCount': len(processed_images),
        'coverageRatio': float(len(processed_images)) / float(len(images)) if images else 0.0,
        'intrinsics': intrinsics,
        'processedImages': processed_images,
        'shardCount': len(manifests),
    }
    if dry_run:
        summary['note'] = 'Dry-run output for master_v1 wiring validation only.'

    plane_records = [
        image['reflectivePlanes']
        for image in processed_images
        if isinstance(image.get('reflectivePlanes'), dict)
    ]
    masks_dir = _REFLECTIVE_MASK_STATE.get('masks_dir')
    if masks_dir is not None and plane_records:
        planes_payload = {
            'createdAt': now_iso(),
            'intrinsics': intrinsics,
            'frames': plane_records,
        }
        (Path(masks_dir) / 'planes.json').write_text(json.dumps(planes_payload, indent=2), encoding='utf-8')
    summary['reflectiveFrameCount'] = len(plane_records)

    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return summary


def run_sharded(args, images: list[Path], intrinsics: dict, output_dir: Path, gpu_indices: list[str]) -> dict:
    shard_dir = ensure_dir(output_dir / '.shards')
    processes = []

    for shard_index, gpu_index in enumerate(gpu_indices):
        manifest_path = shard_dir / f'shard_{shard_index:02d}.json'
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            '--job-id', args.job_id,
            '--images-dir', args.images_dir,
            '--calibration-dir', args.calibration_dir,
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
        raise RuntimeError('metric3d_sharded_failed\n' + '\n\n'.join(error for error in errors if error))

    return finalize_summary(args.job_id, images, intrinsics, output_dir, args.model_size, manifests)


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 Metric3D soft priors')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--images-dir', required=True)
    parser.add_argument('--calibration-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--masks-dir', default='')
    parser.add_argument('--model-size', default='large')
    parser.add_argument('--gpu-indices', default=os.environ.get('MASTER_PIPELINE_METRIC3D_GPU_INDICES', ''))
    parser.add_argument('--shard-index', type=int, default=0)
    parser.add_argument('--shard-count', type=int, default=1)
    parser.add_argument('--manifest-path')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    images_dir = Path(args.images_dir)
    calibration_dir = Path(args.calibration_dir)
    output_dir = ensure_dir(Path(args.output_dir))
    images = list_images(images_dir)

    if not images:
        raise RuntimeError(f'No images found in {images_dir}')

    intrinsics_path = calibration_dir / 'intrinsics.json'
    if not intrinsics_path.exists():
        raise RuntimeError(f'Missing intrinsics at {intrinsics_path}')

    intrinsics = read_json(intrinsics_path)
    gpu_indices = parse_gpu_indices(args.gpu_indices)

    configure_reflective_masks(Path(args.masks_dir) if args.masks_dir else None)

    if args.manifest_path:
        manifest = run_worker(
            args.job_id,
            images,
            intrinsics,
            output_dir,
            args.model_size,
            args.dry_run,
            gpu_indices,
            int(args.shard_index),
            max(int(args.shard_count), 1),
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

    if len(gpu_indices) > 1:
        summary = run_sharded(args, images, intrinsics, output_dir, gpu_indices)
    else:
        manifest = run_worker(args.job_id, images, intrinsics, output_dir, args.model_size, args.dry_run, gpu_indices, 0, 1)
        summary = finalize_summary(args.job_id, images, intrinsics, output_dir, args.model_size, [manifest])

    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()