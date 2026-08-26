#!/opt/room-tour-venv/bin/python3
"""
Room-Tour Neural Processing Pipeline

Separate from the photogrammetry pipeline. Runs in /opt/room-tour-venv.

Processing stages:
  1. Pose bootstrap        — COLMAP feature extraction + matching + mapper
  2. MASt3R geometry       — Learned dense pointmaps from image pairs
  3. Metric3D depth priors — Monocular metric depth per keyframe
  4. Confidence fusion     — Merge MASt3R + Metric3D into global point cloud
  5. Gaussian splat train  — gsplat optimization from fused geometry + images
  6. Packaging             — Export splat scene + viewer bundle
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch

# ══════════════════════════════════════════════════════════════════════════════
# Paths and constants
# ══════════════════════════════════════════════════════════════════════════════

COLMAP_BIN = shutil.which('colmap-glomap') or shutil.which('colmap') or 'colmap'

MAST3R_CHECKPOINT = 'naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric'
MAST3R_DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

METRIC3D_REPO = '/opt/Metric3D'
METRIC3D_MODEL_SIZE = 'large'

GSPLAT_ITERATIONS = 20000
GSPLAT_LR_POSITION = 0.00016
GSPLAT_LR_OPACITY = 0.05
GSPLAT_LR_SCALE = 0.005
GSPLAT_LR_ROTATION = 0.001
GSPLAT_LR_SH = 0.0025
GSPLAT_DENSIFY_START = 500
GSPLAT_DENSIFY_STOP = 17000
GSPLAT_DENSIFY_INTERVAL = 100
GSPLAT_DENSIFY_GRAD_THRESH = 0.0002
GSPLAT_PRUNE_OPACITY = 0.005
GSPLAT_SH_DEGREE = 3
GSPLAT_DEFAULT_DENSIFY_STOP_FRAC = GSPLAT_DENSIFY_STOP / max(GSPLAT_ITERATIONS, 1)

# Blowout / spike prevention. Oversized or extremely anisotropic gaussians render
# as long needle / star-burst artifacts and white blowout. We clamp every
# gaussian's world-space scale (relative to the scene extent) and its anisotropy
# ratio each optimizer step, and prune the worst offenders from the final export.
GSPLAT_MAX_SCALE_SCENE_FRAC = 0.05    # per-axis world scale ceiling as fraction of scene diagonal
GSPLAT_MAX_ANISOTROPY = 8.0           # max ratio of largest to smallest scale axis
GSPLAT_PRUNE_SCALE_SCENE_FRAC = 0.08  # drop gaussians whose max axis exceeds this fraction
GSPLAT_FINAL_MIN_OPACITY = 0.02       # drop near-transparent gaussians from the export

# Depth-supervision (Metric3D) loss weighting. Confidence-weighted L1 between the
# rasterized expected depth and the calibrated Metric3D depth prior. Pixels flagged
# as window/glass (unreliable transmitted/refracted depth) are excluded.
GSPLAT_DEPTH_LOSS_WEIGHT = 0.2
GSPLAT_DEPTH_CONF_THRESH = 0.2
GSPLAT_DEPTH_MIN = 0.05
GSPLAT_DEPTH_MAX = 50.0

# Mirror reflection baking (Stage 8c). After training, the room-side gaussians are
# reflected across each detected mirror plane (Householder reflection) and appended
# behind the mirror surface so the static splat shows a geometrically-correct
# reflection from every viewpoint without per-frame virtual-camera rendering.
# Fraction of the scene bounding-box diagonal used as the on-plane surface band.
GSPLAT_MIRROR_SURFACE_BAND_FRAC = 0.012
# Minimum gaussians required on a mirror plane / in its reflection source set.
GSPLAT_MIRROR_MIN_SURFACE = 80
GSPLAT_MIRROR_MIN_SOURCE = 80
# Reflection depth budget as a multiple of the mirror's in-plane half-extent so the
# baked copy stays bounded to roughly the visible room rather than the whole scene.
GSPLAT_MIRROR_DEPTH_FACTOR = 6.0
# Lateral padding applied to the detected in-plane mirror extent.
GSPLAT_MIRROR_EXTENT_PAD = 1.05
# Stage 8c mirror-reflection baking. DISABLED by default: in practice the reflected
# copy renders as a full duplicated mirrored room inside the model rather than a
# surface tint, so we drop it unless explicitly re-enabled for tuning.
GSPLAT_MIRROR_BAKING_ENABLED = os.environ.get('ROOM_TOUR_GSPLAT_MIRROR_BAKING', 'false').lower() == 'true'


def log(msg: str) -> None:
    print(f'[RoomTourWorker] {msg}', flush=True)


def run_command(command: List[str], cwd: Optional[Path] = None) -> None:
    log(f'$ {" ".join(command)}')
    subprocess.run(command, cwd=str(cwd) if cwd else None, check=True)


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def list_images(images_dir: Path) -> List[Path]:
    paths: List[Path] = []
    for pat in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        paths.extend(images_dir.glob(pat))
    return sorted(paths)


# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 — COLMAP Pose Bootstrap
# ══════════════════════════════════════════════════════════════════════════════

def find_largest_sparse_model(sparse_root: Path) -> Path:
    candidates = [p for p in sparse_root.iterdir() if p.is_dir()]
    if not candidates:
        raise RuntimeError('No sparse model directories generated')

    def pts_size(d: Path) -> int:
        f = d / 'points3D.bin'
        return f.stat().st_size if f.exists() else 0

    return max(candidates, key=pts_size)


def run_pose_bootstrap(images_dir: Path, workspace: Path) -> Tuple[Path, Path]:
    """COLMAP sparse reconstruction to get camera poses."""
    log('=== Stage 1: Pose Bootstrap (COLMAP) ===')
    db = workspace / 'database.db'
    sparse_root = ensure_dir(workspace / 'sparse')
    text_root = ensure_dir(workspace / 'text-model')
    n_images = len(list_images(images_dir))

    run_command([
        COLMAP_BIN, 'feature_extractor',
        '--database_path', str(db),
        '--image_path', str(images_dir),
        '--ImageReader.single_camera', '1',
        '--ImageReader.camera_model', 'OPENCV',
        '--SiftExtraction.use_gpu', '1',
        '--SiftExtraction.max_image_size', '2000',
    ])

    overlap = '15' if n_images > 20 else '8'
    run_command([
        COLMAP_BIN, 'sequential_matcher',
        '--database_path', str(db),
        '--SiftMatching.use_gpu', '1',
        '--SequentialMatching.overlap', overlap,
        '--SequentialMatching.loop_detection', '1',
    ])

    run_command([
        COLMAP_BIN, 'mapper',
        '--database_path', str(db),
        '--image_path', str(images_dir),
        '--output_path', str(sparse_root),
        '--Mapper.ba_refine_principal_point', '0',
        '--Mapper.abs_pose_min_num_inliers', '24',
    ])

    model_dir = find_largest_sparse_model(sparse_root)
    run_command([
        COLMAP_BIN, 'model_converter',
        '--input_path', str(model_dir),
        '--output_path', str(text_root),
        '--output_type', 'TXT',
    ])
    log(f'Pose bootstrap complete — model in {model_dir}')
    return model_dir, text_root


# ══════════════════════════════════════════════════════════════════════════════
# COLMAP model parsing helpers
# ══════════════════════════════════════════════════════════════════════════════

def parse_colmap_cameras_txt(path: Path) -> Dict[int, Dict[str, Any]]:
    cameras: Dict[int, Dict[str, Any]] = {}
    with path.open() as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            cam_id = int(parts[0])
            cameras[cam_id] = {
                'model': parts[1],
                'width': int(parts[2]), 'height': int(parts[3]),
                'params': [float(x) for x in parts[4:]],
            }
    return cameras


def parse_colmap_images_txt(path: Path) -> Dict[str, Dict[str, Any]]:
    images: Dict[str, Dict[str, Any]] = {}
    with path.open() as f:
        lines = [l for l in f if not l.startswith('#') and l.strip()]
    for i in range(0, len(lines), 2):
        parts = lines[i].split()
        name = parts[9]
        images[name] = {
            'id': int(parts[0]), 'cam_id': int(parts[8]),
            'qw': float(parts[1]), 'qx': float(parts[2]),
            'qy': float(parts[3]), 'qz': float(parts[4]),
            'tx': float(parts[5]), 'ty': float(parts[6]), 'tz': float(parts[7]),
        }
    return images


def quat_to_rot(qw, qx, qy, qz):
    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),     2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw),     1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw),     2 * (qy * qz + qx * qw),     1 - 2 * (qx * qx + qy * qy)],
    ])


def get_intrinsics_matrix(cam):
    model, params = cam['model'], cam['params']
    if model in ('SIMPLE_PINHOLE', 'SIMPLE_RADIAL'):
        fx = fy = params[0]
        cx, cy = params[1], params[2]
    elif model in ('PINHOLE', 'OPENCV', 'RADIAL'):
        fx, fy = params[0], params[1]
        cx, cy = params[2], params[3]
    else:
        fx = fy = params[0] if params else cam['width']
        cx, cy = cam['width'] / 2, cam['height'] / 2
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])


def get_camera_extrinsics(img_data):
    R = quat_to_rot(img_data['qw'], img_data['qx'], img_data['qy'], img_data['qz'])
    t = np.array([img_data['tx'], img_data['ty'], img_data['tz']])
    return R, t


def attempt_mesh_export(point_cloud_path: Path, native_output_dir: Path) -> Optional[Path]:
    try:
        import open3d as o3d
        import trimesh
    except Exception as e:
        log(f'Mesh export unavailable: {e}')
        return None
    pcd = o3d.io.read_point_cloud(str(point_cloud_path))
    if len(pcd.points) < 500:
        return None
    pcd = pcd.voxel_down_sample(voxel_size=0.04)
    pcd.estimate_normals()
    try:
        pcd.orient_normals_consistent_tangent_plane(30)
    except Exception:
        pass
    mesh, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=9)
    if len(mesh.vertices) == 0:
        return None
    mesh = mesh.crop(pcd.get_axis_aligned_bounding_box())
    if len(mesh.triangles) > 250000:
        mesh = mesh.simplify_quadric_decimation(250000)
    mesh.compute_vertex_normals()
    mesh_ply = native_output_dir / 'mesh.ply'
    o3d.io.write_triangle_mesh(str(mesh_ply), mesh)
    glb = native_output_dir / 'model.glb'
    trimesh.load(mesh_ply, force='mesh').export(glb)
    return glb if glb.exists() else None


# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 — MASt3R Learned Geometry
# ══════════════════════════════════════════════════════════════════════════════

def select_mast3r_pairs(names):
    pairs = []
    for i in range(len(names) - 1):
        pairs.append((names[i], names[i + 1]))
    for i in range(len(names) - 2):
        pairs.append((names[i], names[i + 2]))
    for i in range(len(names) - 3):
        pairs.append((names[i], names[i + 3]))
    if len(names) > 6:
        pairs.append((names[-1], names[0]))
        pairs.append((names[-2], names[1]))
    return pairs


def run_mast3r_geometry(images_dir, text_model_dir, workspace):
    log('=== Stage 2: MASt3R Learned Geometry ===')

    from mast3r.model import AsymmetricMASt3R
    from dust3r.inference import inference
    from dust3r.utils.image import load_images

    log('Loading MASt3R model...')
    os.environ['HF_HOME'] = '/opt/models/huggingface'
    model = AsymmetricMASt3R.from_pretrained(MAST3R_CHECKPOINT).to(MAST3R_DEVICE)

    cameras = parse_colmap_cameras_txt(text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')
    registered_names = sorted(images_meta.keys())
    log(f'Registered images: {len(registered_names)}')

    if len(registered_names) < 3:
        raise RuntimeError(f'Only {len(registered_names)} images registered — need at least 3')

    pairs = select_mast3r_pairs(registered_names)
    log(f'Processing {len(pairs)} MASt3R pairs')

    all_points, all_colors, all_confidences = [], [], []
    mast3r_dir = ensure_dir(workspace / 'mast3r')

    for pair_idx, (name1, name2) in enumerate(pairs):
        path1, path2 = images_dir / name1, images_dir / name2
        if not path1.exists() or not path2.exists():
            continue
        try:
            imgs = load_images([str(path1), str(path2)], size=512)
            output = inference([tuple(imgs)], model, MAST3R_DEVICE, batch_size=1)

            pts3d_1 = output['pred1']['pts3d'].cpu().numpy()[0]
            pts3d_2 = output['pred2']['pts3d_in_other_view'].cpu().numpy()[0]
            conf_1 = output['pred1']['conf'].cpu().numpy()[0]
            conf_2 = output['pred2']['conf'].cpu().numpy()[0]

            img1_data = images_meta[name1]
            R1, t1 = get_camera_extrinsics(img1_data)
            R1_inv = R1.T

            h, w = pts3d_1.shape[:2]
            pts_flat_1 = pts3d_1.reshape(-1, 3)
            pts_flat_2 = pts3d_2.reshape(-1, 3)

            world_pts_1 = (R1_inv @ (pts_flat_1 - t1).T).T
            world_pts_2 = (R1_inv @ (pts_flat_2 - t1).T).T

            img1_np = cv2.cvtColor(cv2.imread(str(path1)), cv2.COLOR_BGR2RGB)
            colors_1 = cv2.resize(img1_np, (w, h)).reshape(-1, 3).astype(np.float32) / 255.0
            img2_np = cv2.cvtColor(cv2.imread(str(path2)), cv2.COLOR_BGR2RGB)
            colors_2 = cv2.resize(img2_np, (w, h)).reshape(-1, 3).astype(np.float32) / 255.0

            mask_1 = conf_1.reshape(-1) > 1.5
            mask_2 = conf_2.reshape(-1) > 1.5

            all_points.extend([world_pts_1[mask_1], world_pts_2[mask_2]])
            all_colors.extend([colors_1[mask_1], colors_2[mask_2]])
            all_confidences.extend([conf_1.reshape(-1)[mask_1], conf_2.reshape(-1)[mask_2]])

            if (pair_idx + 1) % 5 == 0:
                total = sum(p.shape[0] for p in all_points)
                log(f'  Pair {pair_idx + 1}/{len(pairs)}: {total:,} points')

        except Exception as e:
            log(f'  Pair {pair_idx} ({name1}, {name2}) failed: {e}')

    if not all_points:
        raise RuntimeError('MASt3R produced no points')

    merged_pts = np.concatenate(all_points, axis=0)
    merged_cols = np.concatenate(all_colors, axis=0)
    merged_conf = np.concatenate(all_confidences, axis=0)

    log(f'MASt3R total: {merged_pts.shape[0]:,} raw points from {len(pairs)} pairs')
    np.save(mast3r_dir / 'points.npy', merged_pts)
    np.save(mast3r_dir / 'colors.npy', merged_cols)
    np.save(mast3r_dir / 'confidences.npy', merged_conf)

    del model
    torch.cuda.empty_cache()

    return {'points': merged_pts, 'colors': merged_cols, 'confidences': merged_conf, 'n_pairs': len(pairs)}


# ══════════════════════════════════════════════════════════════════════════════
# Stage 3 — Metric3D Depth Priors
# ══════════════════════════════════════════════════════════════════════════════

def run_metric3d_priors(images_dir, text_model_dir, workspace):
    log('=== Stage 3: Metric3D v2 Depth Priors ===')

    sys.path.insert(0, METRIC3D_REPO)
    os.environ['HF_HOME'] = '/opt/models/huggingface'
    os.environ['TORCH_HOME'] = '/opt/models/torch'

    device = torch.device(MAST3R_DEVICE)
    log('Loading Metric3D v2 ViT-Large...')
    model = torch.hub.load('yvanyin/metric3d', f'metric3d_vit_{METRIC3D_MODEL_SIZE}', pretrain=True)
    model = model.to(device).eval()

    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')
    depth_dir = ensure_dir(workspace / 'metric3d_depths')
    depth_maps: Dict[str, np.ndarray] = {}
    registered_names = sorted(images_meta.keys())
    log(f'Running Metric3D on {len(registered_names)} images...')

    mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1).to(device)
    std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1).to(device)
    input_h, input_w = 616, 1064

    for idx, name in enumerate(registered_names):
        img_path = images_dir / name
        if not img_path.exists():
            continue
        try:
            img = cv2.cvtColor(cv2.imread(str(img_path)), cv2.COLOR_BGR2RGB)
            orig_h, orig_w = img.shape[:2]
            img_resized = cv2.resize(img, (input_w, input_h))
            img_tensor = torch.from_numpy(img_resized).permute(2, 0, 1).float().unsqueeze(0).to(device) / 255.0
            img_tensor = (img_tensor - mean) / std

            with torch.no_grad():
                pred_depth, confidence, output_dict = model.inference({'input': img_tensor})

            depth = pred_depth.squeeze().cpu().numpy()
            from PIL import Image as PILImage
            depth_resized = np.array(PILImage.fromarray(depth).resize((orig_w, orig_h), PILImage.BILINEAR))
            depth_maps[name] = depth_resized
            np.save(depth_dir / f'{Path(name).stem}_depth.npy', depth_resized)

            if (idx + 1) % 10 == 0:
                log(f'  Metric3D: {idx + 1}/{len(registered_names)}')
        except Exception as e:
            log(f'  Metric3D failed on {name}: {e}')

    log(f'Metric3D complete: {len(depth_maps)} depth maps')
    del model
    torch.cuda.empty_cache()
    return depth_maps


# ══════════════════════════════════════════════════════════════════════════════
# Stage 4 — Confidence-Weighted Depth Fusion
# ══════════════════════════════════════════════════════════════════════════════

def run_depth_fusion(images_dir, text_model_dir, mast3r_result, metric3d_depths, workspace, native_output_dir):
    log('=== Stage 4: Confidence-Weighted Depth Fusion ===')

    cameras = parse_colmap_cameras_txt(text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')

    fused_points = [mast3r_result['points']]
    fused_colors = [mast3r_result['colors']]
    metric3d_added = 0

    for name in sorted(images_meta.keys()):
        if name not in metric3d_depths:
            continue
        depth_map = metric3d_depths[name]
        img_data = images_meta[name]
        cam_data = cameras[img_data['cam_id']]
        K = get_intrinsics_matrix(cam_data)
        R, t = get_camera_extrinsics(img_data)

        img = cv2.imread(str(images_dir / name))
        if img is None:
            continue
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        h, w = depth_map.shape[:2]
        if img.shape[:2] != (h, w):
            img = cv2.resize(img, (w, h))

        fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
        u, v = np.meshgrid(np.arange(w), np.arange(h))
        z = depth_map
        valid = (z > 0.05) & (z < 50.0)

        x_cam = (u - cx) * z / fx
        y_cam = (v - cy) * z / fy
        pts_cam = np.stack([x_cam[valid], y_cam[valid], z[valid]], axis=-1)
        colors_img = img[valid].astype(np.float32) / 255.0

        pts_world = (R.T @ (pts_cam - t).T).T
        step = max(1, len(pts_world) // 50000)
        fused_points.append(pts_world[::step])
        fused_colors.append(colors_img[::step])
        metric3d_added += len(pts_world[::step])

    all_pts = np.concatenate(fused_points, axis=0) if len(fused_points) > 1 else fused_points[0]
    all_cols = np.concatenate(fused_colors, axis=0) if len(fused_colors) > 1 else fused_colors[0]

    log(f'Pre-filter: {all_pts.shape[0]:,} pts ({metric3d_added:,} from Metric3D)')

    try:
        import open3d as o3d
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(all_pts)
        pcd.colors = o3d.utility.Vector3dVector(np.clip(all_cols, 0, 1))
        pcd_clean, _ = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
        log(f'After outlier removal: {len(pcd_clean.points):,} pts')
        pcd_down = pcd_clean.voxel_down_sample(voxel_size=0.015)
        log(f'After voxel downsample: {len(pcd_down.points):,} pts')
        final_pts = np.asarray(pcd_down.points)
        final_cols = np.asarray(pcd_down.colors)
    except ImportError:
        log('Open3D unavailable — skipping outlier removal')
        final_pts, final_cols = all_pts, all_cols

    fused_ply = native_output_dir / 'fused_scene.ply'
    write_ply(final_pts, (final_cols * 255).astype(np.uint8), fused_ply)
    log(f'Fused cloud: {fused_ply} ({final_pts.shape[0]:,} pts)')
    return final_pts, final_cols


def write_ply(points, colors, path):
    n = points.shape[0]
    with path.open('w') as f:
        f.write('ply\nformat ascii 1.0\n')
        f.write(f'element vertex {n}\n')
        f.write('property float x\nproperty float y\nproperty float z\n')
        f.write('property uchar red\nproperty uchar green\nproperty uchar blue\n')
        f.write('end_header\n')
        for i in range(n):
            f.write(f'{points[i, 0]} {points[i, 1]} {points[i, 2]} {colors[i, 0]} {colors[i, 1]} {colors[i, 2]}\n')


# ══════════════════════════════════════════════════════════════════════════════
# Stage 8c — Mirror reflection baking (Householder)
# ══════════════════════════════════════════════════════════════════════════════

def _quats_to_rotmats(quats):
    """Convert (N,4) wxyz quaternions to (N,3,3) rotation matrices."""
    q = np.asarray(quats, dtype=np.float64)
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    q = q / np.maximum(norm, 1e-12)
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    n = q.shape[0]
    R = np.empty((n, 3, 3), dtype=np.float64)
    R[:, 0, 0] = 1 - 2 * (y * y + z * z)
    R[:, 0, 1] = 2 * (x * y - w * z)
    R[:, 0, 2] = 2 * (x * z + w * y)
    R[:, 1, 0] = 2 * (x * y + w * z)
    R[:, 1, 1] = 1 - 2 * (x * x + z * z)
    R[:, 1, 2] = 2 * (y * z - w * x)
    R[:, 2, 0] = 2 * (x * z - w * y)
    R[:, 2, 1] = 2 * (y * z + w * x)
    R[:, 2, 2] = 1 - 2 * (x * x + y * y)
    return R


def _rotmats_to_quats(mats):
    """Convert (N,3,3) proper rotation matrices to (N,4) wxyz quaternions."""
    R = np.asarray(mats, dtype=np.float64)
    n = R.shape[0]
    q = np.empty((n, 4), dtype=np.float64)
    trace = R[:, 0, 0] + R[:, 1, 1] + R[:, 2, 2]
    for i in range(n):
        m = R[i]
        tr = trace[i]
        if tr > 0:
            s = math.sqrt(tr + 1.0) * 2.0
            qw = 0.25 * s
            qx = (m[2, 1] - m[1, 2]) / s
            qy = (m[0, 2] - m[2, 0]) / s
            qz = (m[1, 0] - m[0, 1]) / s
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
            qw = (m[2, 1] - m[1, 2]) / s
            qx = 0.25 * s
            qy = (m[0, 1] + m[1, 0]) / s
            qz = (m[0, 2] + m[2, 0]) / s
        elif m[1, 1] > m[2, 2]:
            s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
            qw = (m[0, 2] - m[2, 0]) / s
            qx = (m[0, 1] + m[1, 0]) / s
            qy = 0.25 * s
            qz = (m[1, 2] + m[2, 1]) / s
        else:
            s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
            qw = (m[1, 0] - m[0, 1]) / s
            qx = (m[0, 2] + m[2, 0]) / s
            qy = (m[1, 2] + m[2, 1]) / s
            qz = 0.25 * s
        q[i] = (qw, qx, qy, qz)
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    return q / np.maximum(norm, 1e-12)


def bake_mirror_reflections(means, quats, scales, opacities, sh_coeffs, mirror_planes):
    """Reflect room-side gaussians across each detected mirror plane and append the
    reflected copy behind the mirror surface so the static splat shows a correct
    reflection from every viewpoint.

    `mirror_planes` is a list of world-space planes:
        {'normal': [nx, ny, nz], 'd': float, 'reflectivity': float}
    where the plane satisfies n·X + d = 0. Returns the (possibly extended) arrays.
    Graceful no-op (returns inputs unchanged) when no usable mirror planes exist.
    """
    if not mirror_planes:
        return means, quats, scales, opacities, sh_coeffs

    m = np.asarray(means, dtype=np.float64)
    if m.shape[0] < GSPLAT_MIRROR_MIN_SURFACE:
        return means, quats, scales, opacities, sh_coeffs

    bbox_diag = float(np.linalg.norm(m.max(axis=0) - m.min(axis=0)))
    band = max(0.03, GSPLAT_MIRROR_SURFACE_BAND_FRAC * bbox_diag)

    add_means: list = []
    add_quats: list = []
    add_scales: list = []
    add_opac: list = []
    add_sh: list = []
    baked_planes = 0

    for plane in mirror_planes:
        try:
            normal = np.asarray(plane['normal'], dtype=np.float64)
            d = float(plane['d'])
        except (KeyError, TypeError, ValueError):
            continue
        nrm = float(np.linalg.norm(normal))
        if nrm < 1e-8:
            continue
        n = normal / nrm
        d = d / nrm
        reflectivity = float(plane.get('reflectivity', 0.7))
        reflectivity = min(max(reflectivity, 0.05), 0.95)

        signed = m @ n + d
        surface = np.abs(signed) < band
        if int(surface.sum()) < GSPLAT_MIRROR_MIN_SURFACE:
            continue

        # In-plane orthonormal basis (u, v).
        helper = np.array([1.0, 0.0, 0.0]) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        u = np.cross(n, helper)
        u = u / max(float(np.linalg.norm(u)), 1e-12)
        v = np.cross(n, u)

        center = m[surface].mean(axis=0)
        rel_surface = m[surface] - center
        half_u = float(np.percentile(np.abs(rel_surface @ u), 95)) * GSPLAT_MIRROR_EXTENT_PAD
        half_v = float(np.percentile(np.abs(rel_surface @ v), 95)) * GSPLAT_MIRROR_EXTENT_PAD
        if half_u < 1e-4 or half_v < 1e-4:
            continue

        # Room side = the side holding the majority of off-plane gaussians.
        front_sign = 1.0 if int((signed > band).sum()) >= int((signed < -band).sum()) else -1.0
        depth_limit = GSPLAT_MIRROR_DEPTH_FACTOR * max(half_u, half_v)

        rel_all = m - center
        au = rel_all @ u
        av = rel_all @ v
        sd = signed * front_sign
        src = (sd > band) & (sd < depth_limit) & (np.abs(au) < half_u) & (np.abs(av) < half_v)
        if int(src.sum()) < GSPLAT_MIRROR_MIN_SOURCE:
            continue

        # Householder point reflection across the plane.
        m_ref = m[src] - 2.0 * signed[src, None] * n[None, :]
        H = np.eye(3) - 2.0 * np.outer(n, n)
        R_src = _quats_to_rotmats(np.asarray(quats)[src])
        R_ref = np.einsum('ij,njk->nik', H, R_src)
        # The reflection is improper (det = -1); flip one column to recover a proper
        # rotation. The gaussian ellipsoid is centrally symmetric, so the covariance
        # is preserved exactly.
        dets = np.linalg.det(R_ref)
        flip = dets < 0
        R_ref[flip, :, 2] *= -1.0
        q_ref = _rotmats_to_quats(R_ref)

        s_ref = np.asarray(scales, dtype=np.float32)[src].copy()
        o_ref = (np.asarray(opacities, dtype=np.float64)[src] * reflectivity).astype(np.float32)
        sh_ref = np.asarray(sh_coeffs, dtype=np.float32)[src].copy()
        if sh_ref.shape[1] > 1:
            sh_ref[:, 1:, :] = 0.0  # drop view-dependent SH on the mirrored copy

        # Dim the mirror-surface gaussians so the reflection shows through as a tint.
        np.asarray(opacities)[surface] = (
            np.asarray(opacities, dtype=np.float64)[surface] * (1.0 - 0.5 * reflectivity)
        ).astype(np.asarray(opacities).dtype)

        add_means.append(m_ref.astype(np.float32))
        add_quats.append(q_ref.astype(np.float32))
        add_scales.append(s_ref)
        add_opac.append(o_ref)
        add_sh.append(sh_ref)
        baked_planes += 1
        log(f'  Mirror baking: plane {baked_planes} reflected {int(src.sum()):,} gaussians '
            f'(extent {2*half_u:.2f}x{2*half_v:.2f}, reflectivity {reflectivity:.2f})')

    if not add_means:
        return means, quats, scales, opacities, sh_coeffs

    means = np.concatenate([np.asarray(means, dtype=np.float32)] + add_means, axis=0)
    quats = np.concatenate([np.asarray(quats, dtype=np.float32)] + add_quats, axis=0)
    scales = np.concatenate([np.asarray(scales, dtype=np.float32)] + add_scales, axis=0)
    opacities = np.concatenate([np.asarray(opacities, dtype=np.float32)] + add_opac, axis=0)
    sh_coeffs = np.concatenate([np.asarray(sh_coeffs, dtype=np.float32)] + add_sh, axis=0)
    log(f'Mirror baking: appended reflections across {baked_planes} plane(s); '
        f'total gaussians {means.shape[0]:,}')
    return means, quats, scales, opacities, sh_coeffs


# ══════════════════════════════════════════════════════════════════════════════
# Stage 5 — Gaussian Splat Training (gsplat)
# ══════════════════════════════════════════════════════════════════════════════

def _ssim_approx(img1, img2):
    mu1, mu2 = img1.mean(dim=(0, 1)), img2.mean(dim=(0, 1))
    s1 = ((img1 - mu1) ** 2).mean(dim=(0, 1))
    s2 = ((img2 - mu2) ** 2).mean(dim=(0, 1))
    s12 = ((img1 - mu1) * (img2 - mu2)).mean(dim=(0, 1))
    C1, C2 = 0.01 ** 2, 0.03 ** 2
    return (((2 * mu1 * mu2 + C1) * (2 * s12 + C2)) / ((mu1 ** 2 + mu2 ** 2 + C1) * (s1 + s2 + C2))).mean()


def run_gsplat_training(images_dir, text_model_dir, init_points, init_colors, workspace, native_output_dir, depth_supervision=None, mirror_planes=None):
    log('=== Stage 5: Gaussian Splat Training (gsplat) ===')

    from gsplat import rasterization

    device = torch.device('cuda')
    cameras = parse_colmap_cameras_txt(text_model_dir / 'cameras.txt')
    images_meta = parse_colmap_images_txt(text_model_dir / 'images.txt')

    depth_supervision = depth_supervision or {}
    depth_view_count = 0

    train_views = []
    for name in sorted(images_meta.keys()):
        img_path = images_dir / name
        if not img_path.exists():
            continue
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img_data = images_meta[name]
        cam_data = cameras[img_data['cam_id']]
        K = get_intrinsics_matrix(cam_data)
        R, t = get_camera_extrinsics(img_data)
        w2c = np.eye(4)
        w2c[:3, :3] = R
        w2c[:3, 3] = t
        H, W = img.shape[:2]
        view = {
            'image': torch.from_numpy(img).float().to(device) / 255.0,
            'K': torch.from_numpy(K).float().to(device),
            'w2c': torch.from_numpy(w2c).float().to(device),
            'H': H, 'W': W,
            'depth_gt': None,
            'depth_weight': None,
        }

        prior = depth_supervision.get(name)
        if prior is not None:
            try:
                gt_depth = np.asarray(prior['depth'], dtype=np.float32)
                conf = np.asarray(prior['confidence'], dtype=np.float32)
                exclude = np.asarray(prior.get('exclude'), dtype=bool) if prior.get('exclude') is not None else np.zeros_like(gt_depth, dtype=bool)
                if gt_depth.shape[:2] != (H, W):
                    gt_depth = cv2.resize(gt_depth, (W, H), interpolation=cv2.INTER_NEAREST)
                if conf.shape[:2] != (H, W):
                    conf = cv2.resize(conf, (W, H), interpolation=cv2.INTER_LINEAR)
                if exclude.shape[:2] != (H, W):
                    exclude = cv2.resize(exclude.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
                valid = (
                    np.isfinite(gt_depth)
                    & np.isfinite(conf)
                    & (gt_depth > GSPLAT_DEPTH_MIN)
                    & (gt_depth < GSPLAT_DEPTH_MAX)
                    & (conf > GSPLAT_DEPTH_CONF_THRESH)
                    & (~exclude)
                )
                if np.any(valid):
                    weight = np.where(valid, conf, 0.0).astype(np.float32)
                    view['depth_gt'] = torch.from_numpy(gt_depth).float().to(device)
                    view['depth_weight'] = torch.from_numpy(weight).float().to(device)
                    depth_view_count += 1
            except Exception as exc:
                log(f'  [depth] skipping prior for {name}: {exc}')

        train_views.append(view)

    n_views = len(train_views)
    log(f'Training views: {n_views}')
    if depth_view_count > 0:
        log(f'Depth supervision active on {depth_view_count}/{n_views} views (weight={GSPLAT_DEPTH_LOSS_WEIGHT})')
    if n_views < 3:
        raise RuntimeError(f'Need >= 3 views, got {n_views}')

    N = init_points.shape[0]
    log(f'Initializing {N:,} Gaussians')
    C0 = 0.28209479177387814
    sh_deg = GSPLAT_SH_DEGREE
    n_sh = (sh_deg + 1) ** 2

    means = torch.from_numpy(init_points).float().to(device).requires_grad_(True)
    sh_coeffs = torch.zeros(N, n_sh, 3, device=device)
    sh_coeffs[:, 0, :] = (torch.from_numpy(init_colors).float().to(device) - 0.5) / C0
    sh_coeffs = sh_coeffs.requires_grad_(True)
    log_scales = torch.full((N, 3), math.log(0.01), device=device).requires_grad_(True)
    quats = torch.zeros(N, 4, device=device)
    quats[:, 0] = 1.0
    quats = quats.requires_grad_(True)
    opacities = torch.full((N,), 1.386, device=device).requires_grad_(True)

    def make_optimizer():
        return torch.optim.Adam([
            {'params': [means], 'lr': GSPLAT_LR_POSITION},
            {'params': [sh_coeffs], 'lr': GSPLAT_LR_SH},
            {'params': [log_scales], 'lr': GSPLAT_LR_SCALE},
            {'params': [quats], 'lr': GSPLAT_LR_ROTATION},
            {'params': [opacities], 'lr': GSPLAT_LR_OPACITY},
        ])

    optimizer = make_optimizer()
    grad_accum = torch.zeros(N, device=device)
    grad_count = torch.zeros(N, device=device)

    # Scene-relative scale ceiling for blowout prevention. Computed from the init
    # point cloud extent; any per-axis scale above this fraction of the scene
    # diagonal is clamped each step so gaussians can't grow into needle spikes.
    with torch.no_grad():
        scene_diag = float(torch.linalg.norm(means.max(dim=0).values - means.min(dim=0).values).item()) or 1.0
    max_log_scale = math.log(max(GSPLAT_MAX_SCALE_SCENE_FRAC * scene_diag, 1e-6))
    max_log_aniso = math.log(GSPLAT_MAX_ANISOTROPY)

    log(f'Training for {GSPLAT_ITERATIONS} iterations...')
    t_start = time.time()
    sh_schedule_interval = max(1, GSPLAT_ITERATIONS // (sh_deg + 1))
    densify_start = min(GSPLAT_ITERATIONS, max(1, int(GSPLAT_DENSIFY_START)))
    densify_stop = min(GSPLAT_ITERATIONS, max(densify_start, int(round(GSPLAT_ITERATIONS * GSPLAT_DEFAULT_DENSIFY_STOP_FRAC))))
    log(f'Densification window: steps {densify_start}-{densify_stop} every {GSPLAT_DENSIFY_INTERVAL}')

    for step in range(1, GSPLAT_ITERATIONS + 1):
        view = train_views[step % n_views]
        gt = view['image']
        H, W = view['H'], view['W']

        scales = torch.exp(log_scales)
        opacs = torch.sigmoid(opacities)
        active_sh = min(sh_deg, step // sh_schedule_interval)
        n_active = (active_sh + 1) ** 2

        depth_gt = view.get('depth_gt')
        use_depth = depth_gt is not None
        render_mode = 'RGB+D' if use_depth else 'RGB'

        renders, alphas, info = rasterization(
            means=means,
            quats=quats / (quats.norm(dim=-1, keepdim=True) + 1e-8),
            scales=scales,
            opacities=opacs,
            colors=sh_coeffs[:, :n_active, :],
            viewmats=view['w2c'].unsqueeze(0),
            Ks=view['K'].unsqueeze(0),
            width=W,
            height=H,
            sh_degree=active_sh,
            near_plane=0.01,
            far_plane=100.0,
            render_mode=render_mode,
        )

        if use_depth:
            rendered = renders[0, ..., :3]
            rendered_depth = renders[0, ..., 3]
        else:
            rendered = renders[0]
            rendered_depth = None
        l1 = torch.abs(rendered - gt).mean()
        loss = 0.8 * l1 + 0.2 * (1.0 - _ssim_approx(rendered, gt))
        loss = loss + 0.01 * (opacs * (1 - opacs)).mean()

        depth_loss_value = 0.0
        if use_depth and rendered_depth is not None:
            weight = view['depth_weight']
            weight_sum = weight.sum()
            if weight_sum > 0:
                depth_l1 = (weight * torch.abs(rendered_depth - depth_gt)).sum() / (weight_sum + 1e-8)
                loss = loss + GSPLAT_DEPTH_LOSS_WEIGHT * depth_l1
                depth_loss_value = float(depth_l1.detach().item())

        optimizer.zero_grad()
        loss.backward()

        if densify_start <= step <= densify_stop and means.grad is not None:
            grad_accum += means.grad.norm(dim=-1)
            grad_count += 1

        optimizer.step()

        # Blowout prevention: clamp per-axis world scale and anisotropy so no
        # gaussian can optimize into a long needle / star-burst spike.
        with torch.no_grad():
            log_scales.clamp_(max=max_log_scale)
            axis_max = log_scales.max(dim=-1, keepdim=True).values
            log_scales.clamp_(min=axis_max - max_log_aniso)

        # Adaptive density control
        if densify_start <= step <= densify_stop and step % GSPLAT_DENSIFY_INTERVAL == 0:
            with torch.no_grad():
                avg_grad = grad_accum / (grad_count + 1e-8)
                high_grad = avg_grad > GSPLAT_DENSIFY_GRAD_THRESH
                big = high_grad & (scales.max(dim=-1).values > 0.01)
                n_split = big.sum().item()

                if 0 < n_split < 50000:
                    means = torch.cat([means, means[big].detach().clone()]).detach().requires_grad_(True)
                    sh_coeffs = torch.cat([sh_coeffs, sh_coeffs[big].detach().clone()]).detach().requires_grad_(True)
                    log_scales = torch.cat([log_scales, log_scales[big].detach().clone() - math.log(1.6)]).detach().requires_grad_(True)
                    quats = torch.cat([quats, quats[big].detach().clone()]).detach().requires_grad_(True)
                    opacities = torch.cat([opacities, opacities[big].detach().clone()]).detach().requires_grad_(True)
                    grad_accum = torch.cat([grad_accum, torch.zeros(n_split, device=device)])
                    grad_count = torch.cat([grad_count, torch.zeros(n_split, device=device)])

                prune = torch.sigmoid(opacities) < GSPLAT_PRUNE_OPACITY
                if prune.sum() > 0:
                    keep = ~prune
                    means = means[keep].detach().requires_grad_(True)
                    sh_coeffs = sh_coeffs[keep].detach().requires_grad_(True)
                    log_scales = log_scales[keep].detach().requires_grad_(True)
                    quats = quats[keep].detach().requires_grad_(True)
                    opacities = opacities[keep].detach().requires_grad_(True)
                    grad_accum = grad_accum[keep]
                    grad_count = grad_count[keep]

                n_total = means.shape[0]
                grad_accum = torch.zeros(n_total, device=device)
                grad_count = torch.zeros(n_total, device=device)
                optimizer = make_optimizer()

        if step % 500 == 0 or step == 1:
            depth_str = f' | depth={depth_loss_value:.4f}' if use_depth else ''
            log(f'  Step {step}/{GSPLAT_ITERATIONS} | loss={loss.item():.4f} | l1={l1.item():.4f}{depth_str} | n={means.shape[0]:,} | {time.time() - t_start:.0f}s')

    log(f'Training done: {means.shape[0]:,} Gaussians in {time.time() - t_start:.0f}s')

    m = means.detach().cpu().numpy()
    q = quats.detach().cpu().numpy()
    s = torch.exp(log_scales).detach().cpu().numpy()
    o = torch.sigmoid(opacities).detach().cpu().numpy()
    sh = sh_coeffs.detach().cpu().numpy()

    if GSPLAT_MIRROR_BAKING_ENABLED:
        m, q, s, o, sh = bake_mirror_reflections(m, q, s, o, sh, mirror_planes)
    elif mirror_planes:
        log(f'Mirror baking: skipped (disabled) for {len(mirror_planes)} detected plane(s); '
            'set ROOM_TOUR_GSPLAT_MIRROR_BAKING=true to enable')

    # Final blowout / floater prune: drop oversized "needle" gaussians and
    # near-transparent specks before export so the viewer never shows star-burst
    # spikes or white blowout.
    if m.shape[0] > 0:
        bbox_min = m.min(axis=0)
        bbox_max = m.max(axis=0)
        scene_diag = float(np.linalg.norm(bbox_max - bbox_min)) or 1.0
        max_axis = s.max(axis=1)
        oversized = max_axis > (GSPLAT_PRUNE_SCALE_SCENE_FRAC * scene_diag)
        transparent = o < GSPLAT_FINAL_MIN_OPACITY
        drop = oversized | transparent
        n_drop = int(drop.sum())
        if n_drop > 0 and n_drop < m.shape[0]:
            keep = ~drop
            m, q, s, o, sh = m[keep], q[keep], s[keep], o[keep], sh[keep]
            log(f'Final prune: dropped {n_drop:,} gaussians '
                f'({int(oversized.sum()):,} oversized, {int(transparent.sum()):,} transparent); '
                f'{m.shape[0]:,} remain')

    export_gaussians_to_ply(m, q, s, o, sh, native_output_dir / 'scene.ply')
    splat_path = native_output_dir / 'scene.splat'
    export_to_splat_format(m, q, s, o, sh, splat_path)
    log(f'Exported scene.ply + scene.splat ({splat_path.stat().st_size / 1024 / 1024:.1f} MB)')
    return splat_path


def export_gaussians_to_ply(means, quats, scales, opacities, sh_coeffs, path):
    n = means.shape[0]
    n_sh = sh_coeffs.shape[1]
    header = [
        'ply', 'format binary_little_endian 1.0', f'element vertex {n}',
        'property float x', 'property float y', 'property float z',
        'property float nx', 'property float ny', 'property float nz',
        'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2',
    ]
    for i in range(1, n_sh):
        for j in range(3):
            header.append(f'property float f_rest_{(i - 1) * 3 + j}')
    header += [
        'property float opacity',
        'property float scale_0', 'property float scale_1', 'property float scale_2',
        'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3',
        'end_header',
    ]
    with path.open('wb') as f:
        f.write(('\n'.join(header) + '\n').encode())
        for i in range(n):
            f.write(struct.pack('<fff', *means[i]))
            f.write(struct.pack('<fff', 0, 0, 0))
            f.write(struct.pack('<fff', *sh_coeffs[i, 0]))
            for j in range(1, n_sh):
                f.write(struct.pack('<fff', *sh_coeffs[i, j]))
            f.write(struct.pack('<f', math.log(opacities[i] / (1 - opacities[i] + 1e-8))))
            f.write(struct.pack('<fff', *(math.log(sv + 1e-8) for sv in scales[i])))
            f.write(struct.pack('<ffff', *quats[i]))


def export_to_splat_format(means, quats, scales, opacities, sh_coeffs, path):
    n = means.shape[0]
    C0 = 0.28209479177387814
    with path.open('wb') as f:
        for i in range(n):
            f.write(struct.pack('<fff', *means[i]))
            f.write(struct.pack('<fff', *scales[i]))
            r = min(255, max(0, int((0.5 + C0 * sh_coeffs[i, 0, 0]) * 255)))
            g = min(255, max(0, int((0.5 + C0 * sh_coeffs[i, 0, 1]) * 255)))
            b = min(255, max(0, int((0.5 + C0 * sh_coeffs[i, 0, 2]) * 255)))
            a = min(255, max(0, int(opacities[i] * 255)))
            f.write(struct.pack('<BBBB', r, g, b, a))
            qn = quats[i] / (np.linalg.norm(quats[i]) + 1e-8)
            f.write(struct.pack('<BBBB', *(min(255, max(0, int((v * 0.5 + 0.5) * 255))) for v in qn)))


# ══════════════════════════════════════════════════════════════════════════════
# Stage 6 — Tour Packaging (Splat Viewer)
# ══════════════════════════════════════════════════════════════════════════════

SPLAT_VIEWER_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ROOM_NAME_PLACEHOLDER - Room Tour</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    canvas{display:block;width:100%;height:100%}
    .hud{position:fixed;top:20px;left:20px;padding:16px 20px;border-radius:16px;background:rgba(0,0,0,.75);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);max-width:340px;z-index:10}
    .hud h1{font-size:18px;font-weight:600;margin-bottom:6px}
    .hud p{font-size:13px;color:rgba(255,255,255,.65);line-height:1.5}
    .hud .stats{margin-top:10px;font-size:11px;color:rgba(255,255,255,.4);font-family:monospace}
    .loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a;z-index:100}
    .loading.hidden{display:none}
    .spinner{width:48px;height:48px;border:3px solid rgba(255,255,255,.1);border-top-color:#4fc3f7;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="loading" id="loading"><div class="spinner"></div></div>
  <div class="hud">
    <h1>ROOM_NAME_PLACEHOLDER</h1>
    <p>Gaussian splat room tour. Drag to orbit, scroll to zoom, right-drag to pan.</p>
    <div class="stats" id="stats"></div>
  </div>
  <canvas id="canvas"></canvas>
  <script>
    const canvas = document.getElementById('canvas');
    const gl = canvas.getContext('webgl2', {antialias:false});
    const loading = document.getElementById('loading');
    const stats = document.getElementById('stats');
    if(!gl){document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#fff">WebGL2 required</div>';throw new Error('no webgl2')}

    let theta=0,phi=0.3,radius=3,tX=0,tY=0,tZ=0,cX=0,cY=0,cZ=5;
    function uc(){cX=tX+radius*Math.cos(phi)*Math.sin(theta);cY=tY+radius*Math.sin(phi);cZ=tZ+radius*Math.cos(phi)*Math.cos(theta)}

    let dr=false,rd=false,lx=0,ly=0;
    canvas.onmousedown=function(e){dr=true;rd=e.button===2;lx=e.clientX;ly=e.clientY};
    canvas.onmousemove=function(e){if(!dr)return;var dx=e.clientX-lx,dy=e.clientY-ly;lx=e.clientX;ly=e.clientY;if(rd){tX-=dx*.01;tY+=dy*.01}else{theta-=dx*.005;phi=Math.max(-1.5,Math.min(1.5,phi+dy*.005))}uc()};
    canvas.onmouseup=function(){dr=false};
    canvas.onwheel=function(e){radius=Math.max(.5,radius+e.deltaY*.01);uc();e.preventDefault()};
    canvas.oncontextmenu=function(e){e.preventDefault()};

    var ltd=0;
    canvas.ontouchstart=function(e){if(e.touches.length===1){dr=true;lx=e.touches[0].clientX;ly=e.touches[0].clientY}if(e.touches.length===2)ltd=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)};
    canvas.ontouchmove=function(e){if(e.touches.length===1&&dr){var dx=e.touches[0].clientX-lx,dy=e.touches[0].clientY-ly;lx=e.touches[0].clientX;ly=e.touches[0].clientY;theta-=dx*.005;phi=Math.max(-1.5,Math.min(1.5,phi+dy*.005));uc()}if(e.touches.length===2){var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);radius=Math.max(.5,radius-(d-ltd)*.02);ltd=d;uc()}e.preventDefault()};
    canvas.ontouchend=function(){dr=false};

    var vs='#version 300 es\\nprecision highp float;uniform mat4 uV,uP;uniform vec2 uVP;layout(location=0) in vec3 aP;layout(location=1) in vec3 aS;layout(location=2) in vec4 aC;layout(location=3) in vec2 aO;out vec4 vC;out vec2 vO;void main(){vec4 vp=uV*vec4(aP,1);float sz=max(aS.x,max(aS.y,aS.z))*4.;vec4 cp=uP*vp;cp.xy+=aO*sz*cp.w/uVP;gl_Position=cp;vC=aC;vO=aO;}';
    var fs='#version 300 es\\nprecision highp float;in vec4 vC;in vec2 vO;out vec4 fc;void main(){float d=dot(vO,vO);if(d>1.)discard;float a=vC.a*exp(-4.*d);if(a<.004)discard;fc=vec4(vC.rgb*a,a);}';

    function cs(s,t){var sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);return sh}
    var pg=gl.createProgram();gl.attachShader(pg,cs(vs,gl.VERTEX_SHADER));gl.attachShader(pg,cs(fs,gl.FRAGMENT_SHADER));gl.linkProgram(pg);
    var uV=gl.getUniformLocation(pg,'uV'),uP=gl.getUniformLocation(pg,'uP'),uVP=gl.getUniformLocation(pg,'uVP');

    function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]]}
    function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]}
    function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
    function norm(v){var l=Math.sqrt(dot(v,v))||1;return[v[0]/l,v[1]/l,v[2]/l]}
    function lookAt(e,t,u){var z=norm(sub(e,t)),x=norm(cross(u,z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,e),-dot(y,e),-dot(z,e),1])}
    function persp(f,a,n,r){var t=1/Math.tan(f/2),nr=1/(n-r);return new Float32Array([t/a,0,0,0,0,t,0,0,0,0,(r+n)*nr,-1,0,0,2*r*n*nr,0])}

    fetch('../scene.splat').then(function(r){return r.arrayBuffer()}).then(function(buf){
      loading.classList.add('hidden');
      var N=buf.byteLength/32,dv=new DataView(buf);
      stats.textContent=N.toLocaleString()+' gaussians';
      var pos=new Float32Array(N*3),sc=new Float32Array(N*3),col=new Float32Array(N*4);
      var cx=0,cy=0,cz=0,minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity,maxScale=0;
      for(var i=0;i<N;i++){var o=i*32;pos[i*3]=dv.getFloat32(o,true);pos[i*3+1]=dv.getFloat32(o+4,true);pos[i*3+2]=dv.getFloat32(o+8,true);sc[i*3]=dv.getFloat32(o+12,true);sc[i*3+1]=dv.getFloat32(o+16,true);sc[i*3+2]=dv.getFloat32(o+20,true);col[i*4]=dv.getUint8(o+24)/255;col[i*4+1]=dv.getUint8(o+25)/255;col[i*4+2]=dv.getUint8(o+26)/255;col[i*4+3]=dv.getUint8(o+27)/255;var px=pos[i*3],py=pos[i*3+1],pz=pos[i*3+2],sx=sc[i*3],sy=sc[i*3+1],sz=sc[i*3+2];cx+=px;cy+=py;cz+=pz;minX=Math.min(minX,px);minY=Math.min(minY,py);minZ=Math.min(minZ,pz);maxX=Math.max(maxX,px);maxY=Math.max(maxY,py);maxZ=Math.max(maxZ,pz);maxScale=Math.max(maxScale,sx,sy,sz)}
      tX=cx/N;tY=cy/N;tZ=cz/N;
      var dx=maxX-minX,dy=maxY-minY,dz=maxZ-minZ;
      var sceneRadius=Math.max(Math.sqrt(dx*dx+dy*dy+dz*dz)*0.5, maxScale*4, 1.5);
      radius=Math.min(Math.max(sceneRadius*2.2, 4), 80);
      uc();

      var corners=new Float32Array([-1,-1,1,-1,1,1,-1,1]);
      var cBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,cBuf);gl.bufferData(gl.ARRAY_BUFFER,corners,gl.STATIC_DRAW);
      var pBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,pBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.STATIC_DRAW);
      var sBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,sBuf);gl.bufferData(gl.ARRAY_BUFFER,sc,gl.STATIC_DRAW);
      var clBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,clBuf);gl.bufferData(gl.ARRAY_BUFFER,col,gl.STATIC_DRAW);
      var idx=new Uint16Array([0,1,2,0,2,3]);
      var iBuf=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,iBuf);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,idx,gl.STATIC_DRAW);
      var vao=gl.createVertexArray();gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER,cBuf);gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,2,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,pBuf);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.vertexAttribDivisor(0,1);
      gl.bindBuffer(gl.ARRAY_BUFFER,sBuf);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);gl.vertexAttribDivisor(1,1);
      gl.bindBuffer(gl.ARRAY_BUFFER,clBuf);gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,4,gl.FLOAT,false,0,0);gl.vertexAttribDivisor(2,1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,iBuf);

      function resize(){canvas.width=innerWidth;canvas.height=innerHeight;gl.viewport(0,0,canvas.width,canvas.height)}
      addEventListener('resize',resize);resize();
      function frame(){
        gl.clearColor(.04,.04,.04,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.DEPTH_TEST);
        gl.useProgram(pg);
        gl.uniformMatrix4fv(uV,false,lookAt([cX,cY,cZ],[tX,tY,tZ],[0,1,0]));
        gl.uniformMatrix4fv(uP,false,persp(1,canvas.width/canvas.height,.1,500));
        gl.uniform2f(uVP,canvas.width,canvas.height);
        gl.bindVertexArray(vao);gl.drawElementsInstanced(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0,N);
        requestAnimationFrame(frame)
      }
      frame()
    });
  </script>
</body>
</html>"""


def build_splat_viewer_html(viewer_dir, room_name):
    ensure_dir(viewer_dir)
    html = SPLAT_VIEWER_HTML.replace('ROOM_NAME_PLACEHOLDER', room_name)
    out = viewer_dir / 'index.html'
    out.write_text(html, encoding='utf-8')
    return out


def load_room_name(input_dir):
    manifest = input_dir / 'package-manifest.json'
    if manifest.exists():
        data = json.loads(manifest.read_text())
        return data.get('roomName') or data.get('jobId') or 'Room Tour'
    return 'Room Tour'


def _parse_colmap_points3d(path):
    pts, cols = [], []
    if not path.exists():
        return np.empty((0, 3)), np.empty((0, 3))
    with path.open() as f:
        for line in f:
            if line.startswith('#') or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
            cols.append([int(parts[4]) / 255, int(parts[5]) / 255, int(parts[6]) / 255])
    return (np.array(pts) if pts else np.empty((0, 3))), (np.array(cols) if cols else np.empty((0, 3)))


def main():
    global GSPLAT_ITERATIONS

    parser = argparse.ArgumentParser(description='Room-Tour Neural Processing Pipeline')
    parser.add_argument('--input-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--skip-mast3r', action='store_true', help='Skip MASt3R (use only COLMAP sparse)')
    parser.add_argument('--skip-metric3d', action='store_true', help='Skip Metric3D depth priors')
    parser.add_argument('--gsplat-iterations', type=int, default=GSPLAT_ITERATIONS)
    args = parser.parse_args()

    GSPLAT_ITERATIONS = args.gsplat_iterations

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    native_output_dir = ensure_dir(output_dir / 'native-output')
    outputs_dir = ensure_dir(output_dir / 'outputs')
    workspace_dir = ensure_dir(output_dir / 'workspace')
    images_dir = input_dir / 'keyframes'

    room_name = load_room_name(input_dir)
    image_files = list_images(images_dir)
    if len(image_files) < 6:
        raise RuntimeError(f'Need at least 6 keyframes, got {len(image_files)}')

    log(f'Job {args.job_id}: {len(image_files)} keyframes, room "{room_name}"')
    log(f'Pipeline: COLMAP -> {"MASt3R -> " if not args.skip_mast3r else ""}{"Metric3D -> " if not args.skip_metric3d else ""}Fusion -> gsplat')

    t0 = time.time()
    stage_summary = {}

    # Stage 1: COLMAP Pose Bootstrap
    sparse_model_dir, text_model_dir = run_pose_bootstrap(images_dir, workspace_dir)
    stage_summary['pose_bootstrap'] = {'status': 'completed', 'images': len(image_files)}

    # Stage 2: MASt3R Learned Geometry
    mast3r_result = None
    if not args.skip_mast3r:
        try:
            mast3r_result = run_mast3r_geometry(images_dir, text_model_dir, workspace_dir)
            stage_summary['learned_geometry'] = {
                'status': 'completed', 'method': 'mast3r',
                'n_pairs': mast3r_result['n_pairs'],
                'n_points': int(mast3r_result['points'].shape[0]),
            }
        except Exception as e:
            log(f'MASt3R failed, continuing without: {e}')
            stage_summary['learned_geometry'] = {'status': 'fallback', 'error': str(e)}

    if mast3r_result is None:
        log('Using COLMAP sparse points as geometry init')
        pts, cols = _parse_colmap_points3d(text_model_dir / 'points3D.txt')
        mast3r_result = {'points': pts, 'colors': cols, 'confidences': np.ones(len(pts)), 'n_pairs': 0}
        stage_summary.setdefault('learned_geometry', {'status': 'colmap_sparse_fallback'})

    # Stage 3: Metric3D Depth Priors
    metric3d_depths = {}
    if not args.skip_metric3d:
        try:
            metric3d_depths = run_metric3d_priors(images_dir, text_model_dir, workspace_dir)
            stage_summary['depth_regularization'] = {
                'status': 'completed', 'method': 'metric3d_v2',
                'n_depth_maps': len(metric3d_depths),
            }
        except Exception as e:
            log(f'Metric3D failed, continuing without: {e}')
            stage_summary['depth_regularization'] = {'status': 'skipped', 'error': str(e)}

    # Stage 4: Confidence-Weighted Fusion
    fused_pts, fused_cols = run_depth_fusion(
        images_dir, text_model_dir, mast3r_result, metric3d_depths, workspace_dir, native_output_dir,
    )
    stage_summary['global_fusion'] = {
        'status': 'completed', 'n_points': int(fused_pts.shape[0]),
        'has_mast3r': mast3r_result['n_pairs'] > 0,
        'has_metric3d': len(metric3d_depths) > 0,
    }

    # Stage 5: Gaussian Splat Training
    splat_path = run_gsplat_training(
        images_dir, text_model_dir, fused_pts, fused_cols, workspace_dir, native_output_dir,
    )
    stage_summary['splat_training'] = {
        'status': 'completed', 'iterations': GSPLAT_ITERATIONS,
        'output': str(splat_path), 'size_mb': round(splat_path.stat().st_size / 1024 / 1024, 1),
    }

    # Stage 6: Tour Packaging
    viewer_path = build_splat_viewer_html(native_output_dir / 'viewer', room_name)
    mesh_glb = None
    fused_ply = native_output_dir / 'fused_scene.ply'
    if fused_ply.exists():
        try:
            mesh_glb = attempt_mesh_export(fused_ply, native_output_dir)
        except Exception as e:
            log(f'Mesh export failed: {e}')
    stage_summary['tour_packaging'] = {
        'status': 'completed', 'viewer': str(viewer_path),
        'mesh': str(mesh_glb) if mesh_glb else None,
    }

    total = time.time() - t0
    result = {
        'success': True,
        'jobId': args.job_id,
        'roomName': room_name,
        'method': 'mast3r_metric3d_gsplat',
        'pipelineVersion': 'room-tour-neural-v1',
        'artifacts': {
            'splatScenePath': str(native_output_dir / 'scene.splat'),
            'splatPlyPath': str(native_output_dir / 'scene.ply'),
            'fusedPointCloudPath': str(fused_ply),
            'meshGlbPath': str(mesh_glb) if mesh_glb else None,
            'viewerHtmlPath': str(viewer_path),
        },
        'completedStages': list(stage_summary.keys()),
        'stageSummary': stage_summary,
        'stats': {
            'imageCount': len(image_files),
            'totalTimeSeconds': round(total),
            'gsplatIterations': GSPLAT_ITERATIONS,
        },
    }

    result_path = outputs_dir / 'remote-processing.json'
    result_path.write_text(json.dumps(result, indent=2))
    log(f'Pipeline complete in {total:.0f}s')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()