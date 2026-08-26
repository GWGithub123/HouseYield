#!/usr/bin/env python3
"""MirrorGS adapter for the master_v1 mirror-gaussian hook.

The master_v1 gaussian stage already exposes a generic
``MASTER_PIPELINE_MIRROR_GAUSSIAN_COMMAND`` contract.  This adapter implements
that contract for TingtingLiao/MirrorGS without making MirrorGS a hard dependency
of the normal in-house gsplat path.

Input:  a manifest written by ``run_gaussian_splatting.py`` containing images,
        COLMAP text model, semantic mirror masks, and the current source splat.
Output: ``result.json`` containing the full MirrorGS debug export plus a
        mirror-only sidecar ``overlaySplatScenePath`` that can be composited in
        the existing HouseYield splat viewer without replacing the base scan.
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
from pathlib import Path

import numpy as np


C0 = 0.28209479177387814


def log(message: str) -> None:
    print(f"[MirrorGSAdapter] {message}", flush=True)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def copy_or_link(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def load_mask_manifest(masks_dir: Path | None) -> dict:
    if masks_dir is None:
        return {}
    manifest_path = masks_dir / "manifest.json"
    if not manifest_path.exists():
        return {}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    frames = payload.get("frames") or []
    if not isinstance(frames, list):
        return {}
    return {str(frame.get("frame")): frame for frame in frames if isinstance(frame, dict) and frame.get("frame")}


def write_empty_mask_like(image_path: Path, destination: Path) -> None:
    from PIL import Image

    with Image.open(image_path) as image:
        width, height = image.size
    Image.new("L", (width, height), 0).save(destination)


def prepare_mirrorgs_dataset(manifest: dict, dataset_dir: Path) -> dict:
    """Create the dataset layout MirrorGS expects:

    dataset/
      images/<same image filenames>
      masks/<same image filenames>        # white=mirror, black=non-mirror
      sparse/0/{cameras,images,points3D}.txt
    """
    images_dir = Path(manifest["imagesDir"])
    sfm_text_model_dir = Path(manifest["sfmTextModelDir"])
    masks_dir = Path(manifest["masksDir"]) if manifest.get("masksDir") else None

    out_images_dir = ensure_dir(dataset_dir / "images")
    out_masks_dir = ensure_dir(dataset_dir / "masks")
    out_sparse_dir = ensure_dir(dataset_dir / "sparse" / "0")

    for filename in ("cameras.txt", "images.txt", "points3D.txt"):
        source = sfm_text_model_dir / filename
        if not source.exists():
            raise FileNotFoundError(f"missing_colmap_text_model_file:{source}")
        shutil.copy2(source, out_sparse_dir / filename)

    frame_manifest = load_mask_manifest(masks_dir)
    image_count = 0
    mirror_mask_count = 0

    for image_path in list_images(images_dir):
        copy_or_link(image_path, out_images_dir / image_path.name)
        mask_target = out_masks_dir / image_path.name

        mask_source = None
        frame_entry = frame_manifest.get(image_path.name) or frame_manifest.get(image_path.stem)
        if frame_entry and masks_dir is not None:
            mask_rel = (frame_entry.get("masks") or {}).get("mirror")
            if mask_rel:
                candidate = masks_dir / mask_rel
                if candidate.exists():
                    mask_source = candidate
        if mask_source is None and masks_dir is not None:
            for candidate in (
                masks_dir / "mirror" / f"{image_path.stem}.png",
                masks_dir / "mirror" / image_path.name,
            ):
                if candidate.exists():
                    mask_source = candidate
                    break

        if mask_source is not None:
            from PIL import Image

            with Image.open(mask_source) as mask_image:
                mask_image.convert("L").save(mask_target)
            mirror_mask_count += 1
        else:
            write_empty_mask_like(image_path, mask_target)
        image_count += 1

    return {
        "datasetDir": str(dataset_dir),
        "imageCount": image_count,
        "mirrorMaskCount": mirror_mask_count,
    }


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def normalize_quaternion(q: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    return q / np.maximum(norm, 1e-8)


def convert_mirrorgs_ply_to_splat(
    ply_path: Path,
    splat_path: Path,
    *,
    vertex_mask: np.ndarray | None = None,
) -> int:
    """Convert MirrorGS/3DGS PLY into HouseYield's 32-byte .splat format."""
    from plyfile import PlyData

    ply = PlyData.read(str(ply_path))
    vertex = ply["vertex"]
    names = {prop.name for prop in vertex.properties}
    required = {"x", "y", "z", "scale_0", "scale_1", "rot_0", "rot_1", "rot_2", "rot_3", "opacity"}
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"mirrorgs_ply_missing_properties:{missing}")

    xyz = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in ("x", "y", "z")], axis=1)
    log_scale_0 = np.asarray(vertex["scale_0"], dtype=np.float32)
    log_scale_1 = np.asarray(vertex["scale_1"], dtype=np.float32)
    if "scale_2" in names:
        log_scale_2 = np.asarray(vertex["scale_2"], dtype=np.float32)
    else:
        # MirrorGS stores mirror surfels as two-axis ellipses. The .splat viewer
        # expects a third covariance axis, so synthesize a thin depth axis.
        log_scale_2 = np.minimum(log_scale_0, log_scale_1) + math.log(0.05)
    log_scales = np.stack([log_scale_0, log_scale_1, log_scale_2], axis=1)
    scales = np.exp(np.clip(log_scales, -20.0, 20.0)).astype(np.float32)
    opacity = sigmoid(np.asarray(vertex["opacity"], dtype=np.float32)).astype(np.float32)
    quats = normalize_quaternion(
        np.stack([np.asarray(vertex[f"rot_{idx}"], dtype=np.float32) for idx in range(4)], axis=1)
    )

    if {"f_dc_0", "f_dc_1", "f_dc_2"}.issubset(names):
        colors = np.stack([np.asarray(vertex[f"f_dc_{idx}"], dtype=np.float32) for idx in range(3)], axis=1)
        colors = np.clip(0.5 + C0 * colors, 0.0, 1.0)
    elif {"red", "green", "blue"}.issubset(names):
        colors = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in ("red", "green", "blue")], axis=1) / 255.0
    else:
        colors = np.full((xyz.shape[0], 3), 0.7, dtype=np.float32)

    if vertex_mask is not None:
        mask = np.asarray(vertex_mask, dtype=bool).reshape(-1)
        if mask.shape[0] != xyz.shape[0]:
            raise RuntimeError("mirrorgs_vertex_mask_shape_mismatch")
        xyz = xyz[mask]
        scales = scales[mask]
        opacity = opacity[mask]
        quats = quats[mask]
        colors = colors[mask]

    ensure_dir(splat_path.parent)
    with splat_path.open("wb") as handle:
        for idx in range(xyz.shape[0]):
            handle.write(struct.pack("<fff", *xyz[idx]))
            handle.write(struct.pack("<fff", *scales[idx]))
            rgba = [
                int(np.clip(round(colors[idx, 0] * 255.0), 0, 255)),
                int(np.clip(round(colors[idx, 1] * 255.0), 0, 255)),
                int(np.clip(round(colors[idx, 2] * 255.0), 0, 255)),
                int(np.clip(round(opacity[idx] * 255.0), 0, 255)),
            ]
            handle.write(struct.pack("<BBBB", *rgba))
            quat_bytes = [int(np.clip(round((value * 0.5 + 0.5) * 255.0), 0, 255)) for value in quats[idx]]
            handle.write(struct.pack("<BBBB", *quat_bytes))
    return int(xyz.shape[0])


def build_mirror_overlay_mask(ply_path: Path, *, min_opacity: float) -> np.ndarray:
    from plyfile import PlyData

    ply = PlyData.read(str(ply_path))
    vertex = ply["vertex"]
    names = {prop.name for prop in vertex.properties}
    if "mirror_opacity" not in names:
        raise RuntimeError("mirrorgs_ply_missing_mirror_opacity")

    mirror_opacity = sigmoid(np.asarray(vertex["mirror_opacity"], dtype=np.float32))
    mask = mirror_opacity >= float(min_opacity)
    if not np.any(mask):
        raise RuntimeError(f"mirrorgs_overlay_empty_for_threshold:{min_opacity}")
    return mask


def resolve_mirrorgs_root(cli_value: str | None) -> Path:
    raw = cli_value or os.environ.get("MIRRORGS_ROOT") or os.environ.get("MASTER_PIPELINE_MIRRORGS_ROOT") or "/opt/MirrorGS"
    root = Path(raw)
    if not (root / "train.py").exists():
        raise FileNotFoundError(f"mirrorgs_train_py_missing:{root / 'train.py'}")
    return root


def run_command(command: list[str], *, cwd: Path, env: dict | None = None) -> None:
    log("$ " + " ".join(command))
    subprocess.run(command, cwd=str(cwd), env=env, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run MirrorGS behind the master_v1 mirror-gaussian hook")
    parser.add_argument("--manifest", "--manifest-path", dest="manifest_path", required=True)
    parser.add_argument("--result", "--result-path", dest="result_path", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--mirrorgs-root", default="")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--iterations", type=int, default=int(os.environ.get("MASTER_PIPELINE_MIRRORGS_ITERATIONS", "10000")))
    parser.add_argument("--overlay-min-opacity", type=float, default=float(os.environ.get("MASTER_PIPELINE_MIRRORGS_OVERLAY_MIN_OPACITY", "0.5")))
    parser.add_argument("--resolution", type=int, default=int(os.environ.get("MASTER_PIPELINE_MIRRORGS_RESOLUTION", "-1")))
    parser.add_argument("--quiet", action="store_true", default=os.environ.get("MASTER_PIPELINE_MIRRORGS_QUIET", "true").lower() == "true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest_path)
    result_path = Path(args.result_path)
    output_dir = ensure_dir(Path(args.output_dir))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mirrorgs_root = resolve_mirrorgs_root(args.mirrorgs_root)

    dataset_dir = output_dir / "mirrorgs-dataset"
    model_dir = output_dir / "mirrorgs-model"
    dataset_summary = prepare_mirrorgs_dataset(manifest, dataset_dir)
    ensure_dir(model_dir)

    train_command = [
        args.python,
        str(mirrorgs_root / "train.py"),
        "-s", str(dataset_dir),
        "-m", str(model_dir),
        "--iterations", str(args.iterations),
        "--save_iterations", str(args.iterations),
        "--test_iterations", str(args.iterations),
        "--checkpoint_iterations", str(args.iterations),
        "--resolution", str(args.resolution),
    ]
    if args.quiet:
        train_command.append("--quiet")

    env = dict(os.environ)
    env["PYTHONPATH"] = f"{mirrorgs_root}:{env.get('PYTHONPATH', '')}"
    run_command(train_command, cwd=mirrorgs_root, env=env)

    trained_ply = model_dir / "point_cloud" / f"iteration_{args.iterations}" / "point_cloud.ply"
    if not trained_ply.exists():
        raise FileNotFoundError(f"mirrorgs_output_ply_missing:{trained_ply}")

    final_dir = ensure_dir(output_dir / "final")
    splat_ply_path = final_dir / "scene.ply"
    splat_scene_path = final_dir / "scene.splat"
    shutil.copy2(trained_ply, splat_ply_path)
    point_count = convert_mirrorgs_ply_to_splat(splat_ply_path, splat_scene_path)

    overlay_dir = ensure_dir(output_dir / "overlay")
    overlay_splat_path = overlay_dir / "scene.splat"
    overlay_mask = build_mirror_overlay_mask(trained_ply, min_opacity=args.overlay_min_opacity)
    overlay_point_count = convert_mirrorgs_ply_to_splat(
        trained_ply,
        overlay_splat_path,
        vertex_mask=overlay_mask,
    )

    result = {
        "success": True,
        "method": "mirrorgs_adapter",
        "mirrorPlaneCount": len(manifest.get("mirrorPlanes") or []),
        "dataset": dataset_summary,
        "modelDir": str(model_dir),
        "splatScenePath": str(splat_scene_path),
        "splatPlyPath": str(splat_ply_path),
        "pointCount": point_count,
        "overlaySplatScenePath": str(overlay_splat_path),
        "overlayPointCount": overlay_point_count,
        "overlayMinOpacity": float(args.overlay_min_opacity),
    }
    write_json(result_path, result)
    log(f"MirrorGS complete: {point_count:,} gaussians -> {splat_scene_path}")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()