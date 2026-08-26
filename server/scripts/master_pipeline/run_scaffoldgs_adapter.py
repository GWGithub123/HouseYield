#!/usr/bin/env python3
"""Scaffold-GS adapter for the master_v1 gaussian fork.

This prepares the same selected-image + COLMAP model inputs used by the
Ref-Gaussian branch, runs an upstream Scaffold-GS checkout, and emits a
``result.json`` with HouseYield-viewable splat artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

MASTER_PIPELINE_DIR = Path(__file__).resolve().parent
if str(MASTER_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(MASTER_PIPELINE_DIR))

from run_refgaussian_adapter import convert_gaussian_ply_to_splat  # type: ignore[import-not-found]
from scaffoldgs_explicit_export import export_scaffoldgs_explicit_gaussians  # type: ignore[import-not-found]

RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR: Exception | None = None
RUN_GAUSSIAN_SPLATTING = None
try:
    import run_gaussian_splatting as RUN_GAUSSIAN_SPLATTING  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR = exc


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def resolve_scaffoldgs_root(cli_value: str | None) -> Path:
    raw = (
        cli_value
        or os.environ.get("SCAFFOLD_GS_ROOT")
        or os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_ROOT")
        or "/opt/Scaffold-GS"
    )
    root = Path(raw)
    if not (root / "train.py").exists():
        raise FileNotFoundError(f"scaffold_gs_train_py_missing:{root / 'train.py'}")
    return root


def copy_or_link_file(source: Path, destination: Path) -> None:
    ensure_dir(destination.parent)
    if destination.exists() or destination.is_symlink():
        destination.unlink()
    try:
        destination.symlink_to(source)
    except OSError:
        shutil.copy2(source, destination)


def count_colmap_points(points_path: Path) -> int:
    if not points_path.exists():
        return 0
    count = 0
    with points_path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            count += 1
    return count


def write_untracked_colmap_points(points_path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    lines = [
        "# 3D point list\n",
        "# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n",
    ]
    for idx, point in enumerate(np.asarray(points, dtype=np.float32)):
        if idx < colors.shape[0]:
            rgb = np.clip(np.round(np.asarray(colors[idx], dtype=np.float32) * 255.0), 0, 255).astype(np.uint8)
        else:
            rgb = np.array([180, 180, 180], dtype=np.uint8)
        lines.append(
            f"{idx + 1} {float(point[0])} {float(point[1])} {float(point[2])} "
            f"{int(rgb[0])} {int(rgb[1])} {int(rgb[2])} 1.0\n"
        )
    points_path.write_text("".join(lines), encoding="utf-8")


def read_colmap_points_xyz_rgb(points_path: Path) -> tuple[np.ndarray, np.ndarray]:
    points: list[list[float]] = []
    colors: list[list[float]] = []
    if not points_path.exists():
        return np.empty((0, 3), dtype=np.float32), np.empty((0, 3), dtype=np.float32)
    with points_path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            points.append([float(parts[1]), float(parts[2]), float(parts[3])])
            colors.append([int(parts[4]) / 255.0, int(parts[5]) / 255.0, int(parts[6]) / 255.0])
    return np.asarray(points, dtype=np.float32), np.asarray(colors, dtype=np.float32)


def estimate_voxelized_anchor_count(points: np.ndarray, voxel_size: float) -> int:
    if points.shape[0] == 0:
        return 0
    if voxel_size <= 0:
        return int(points.shape[0])
    voxelized = np.unique(np.round(points / float(voxel_size)), axis=0)
    return int(voxelized.shape[0])


def qvec_to_rotmat(qvec: np.ndarray) -> np.ndarray:
    w, x, y, z = qvec.astype(float).tolist()
    return np.asarray(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
            [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
            [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=np.float64,
    )


def camera_extent_from_images(images_path: Path) -> tuple[np.ndarray, float] | None:
    centers: list[np.ndarray] = []
    if not images_path.exists():
        return None
    with images_path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 10 or not parts[0].isdigit():
                continue
            qvec = np.asarray([float(value) for value in parts[1:5]], dtype=np.float64)
            tvec = np.asarray([float(value) for value in parts[5:8]], dtype=np.float64)
            centers.append(-qvec_to_rotmat(qvec).T @ tvec)
    if not centers:
        return None
    stacked = np.vstack(centers)
    center = stacked.mean(axis=0)
    diagonal = float(np.linalg.norm(stacked - center, axis=1).max())
    if not np.isfinite(diagonal) or diagonal <= 0:
        return None
    return center.astype(np.float32), float(diagonal * 1.1)


def filter_points_to_camera_extent(
    points: np.ndarray,
    colors: np.ndarray,
    weights: np.ndarray,
    sparse_dir: Path,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, dict]:
    camera_extent = camera_extent_from_images(sparse_dir / "images.txt")
    if camera_extent is None or points.shape[0] == 0:
        return points, colors, weights, 0, {"applied": False, "reason": "camera_extent_unavailable"}

    center, radius = camera_extent
    radius_scale = float(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_SCENE_RADIUS_SCALE", "3.0"))
    max_distance = max(float(radius) * radius_scale, float(radius) + 1.0)
    distances = np.linalg.norm(points.astype(np.float32) - center.reshape(1, 3), axis=1)
    keep = np.isfinite(distances) & (distances <= max_distance)
    removed = int(points.shape[0] - int(keep.sum()))
    summary = {
        "applied": True,
        "cameraCenter": center.astype(float).tolist(),
        "cameraRadius": float(radius),
        "radiusScale": float(radius_scale),
        "maxDistance": float(max_distance),
        "removedPointCount": removed,
    }
    if removed <= 0:
        return points, colors, weights, 0, summary
    return points[keep], colors[keep], weights[keep], removed, summary


def select_sparse_points_for_budget(
    sparse_points_path: Path,
    max_points: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, bool, dict]:
    sparse_point_count = count_colmap_points(sparse_points_path)
    if RUN_GAUSSIAN_SPLATTING is not None:
        sparse_points, sparse_colors, sparse_weights = RUN_GAUSSIAN_SPLATTING._parse_colmap_points3d(sparse_points_path)  # noqa: SLF001
    else:
        sparse_points, sparse_colors = read_colmap_points_xyz_rgb(sparse_points_path)
        sparse_weights = np.ones((sparse_points.shape[0],), dtype=np.float32)

    sparse_points, sparse_colors, sparse_weights, _, outlier_summary = filter_points_to_camera_extent(
        sparse_points,
        sparse_colors,
        sparse_weights,
        sparse_points_path.parent,
    )

    if max_points > 0 and sparse_points.shape[0] > max_points:
        if RUN_GAUSSIAN_SPLATTING is not None:
            sparse_points, sparse_colors, sparse_weights, _ = RUN_GAUSSIAN_SPLATTING._subsample_points(  # noqa: SLF001
                sparse_points,
                sparse_colors,
                max_points,
                weights=sparse_weights,
            )
        else:
            rng = np.random.default_rng(1337)
            indices = np.sort(rng.choice(sparse_points.shape[0], size=max_points, replace=False))
            sparse_points = sparse_points[indices]
            sparse_colors = sparse_colors[indices]
            sparse_weights = sparse_weights[indices]
        return sparse_points, sparse_colors, sparse_weights, sparse_point_count, True, outlier_summary

    return sparse_points, sparse_colors, sparse_weights, sparse_point_count, False, outlier_summary


def append_metric3d_points_to_colmap_model(
    *,
    manifest: dict,
    images_dir: Path,
    sfm_text_model_dir: Path,
    sparse_text_dir: Path,
) -> dict:
    depth_priors = manifest.get("depthPriors") or {}
    metric3d_dir_value = depth_priors.get("dir")
    max_init_points = int(depth_priors.get("maxInitPoints") or 0)
    point_budget_per_image = int(depth_priors.get("pointBudgetPerImage") or 0)
    sparse_points_path = sparse_text_dir / "points3D.txt"
    sparse_points, sparse_colors, sparse_weights, sparse_point_count, sparse_capped, sparse_outlier_summary = select_sparse_points_for_budget(
        sparse_points_path,
        max_init_points,
    )

    if not metric3d_dir_value:
        if sparse_capped:
            write_untracked_colmap_points(sparse_points_path, sparse_points, sparse_colors)
        return {
            "requested": False,
            "applied": False,
            "reason": "metric3d_priors_not_requested",
            "sparsePointCount": sparse_point_count,
            "sparseOutlierFilter": sparse_outlier_summary,
            "selectedSparsePointCount": int(sparse_points.shape[0]),
            "addedPointCount": 0,
            "totalPointCount": int(sparse_points.shape[0]),
        }
    if RUN_GAUSSIAN_SPLATTING is None:
        if sparse_capped:
            write_untracked_colmap_points(sparse_points_path, sparse_points, sparse_colors)
        return {
            "requested": True,
            "applied": False,
            "reason": f"gaussian_init_helper_import_failed:{RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR}",
            "sparsePointCount": sparse_point_count,
            "sparseOutlierFilter": sparse_outlier_summary,
            "selectedSparsePointCount": int(sparse_points.shape[0]),
            "addedPointCount": 0,
            "totalPointCount": int(sparse_points.shape[0]),
        }

    metric3d_dir = Path(metric3d_dir_value)
    target_metric_points = min(
        max(0, point_budget_per_image * max(1, int(len(list((images_dir).iterdir()))))),
        max(0, int(round(max_init_points * 0.30))) if max_init_points > 0 else 0,
    )
    sparse_budget = max(0, max_init_points - target_metric_points) if max_init_points > 0 else sparse_point_count
    selected_sparse_points = sparse_points
    selected_sparse_colors = sparse_colors
    if sparse_points.shape[0] > sparse_budget > 0:
        selected_sparse_points, selected_sparse_colors, _, _ = RUN_GAUSSIAN_SPLATTING._subsample_points(  # noqa: SLF001
            sparse_points,
            sparse_colors,
            sparse_budget,
            weights=sparse_weights,
        )
    metric_budget = max(0, max_init_points - int(selected_sparse_points.shape[0]))
    metric3d_init = RUN_GAUSSIAN_SPLATTING._load_metric3d_init_points(  # noqa: SLF001
        images_dir=images_dir,
        sfm_text_model_dir=sfm_text_model_dir,
        metric3d_dir=metric3d_dir,
        max_points=metric_budget,
        point_budget_per_image=point_budget_per_image,
        masks_dir=Path(manifest["masksDir"]) if manifest.get("masksDir") else None,
    )

    points = np.asarray(metric3d_init.get("points", np.empty((0, 3), dtype=np.float32)), dtype=np.float32)
    colors = np.asarray(metric3d_init.get("colors", np.empty((0, 3), dtype=np.float32)), dtype=np.float32)
    if points.shape[0] > 0:
        metric_weights = np.ones((points.shape[0],), dtype=np.float32)
        points, colors, _, _, metric_outlier_summary = filter_points_to_camera_extent(
            points,
            colors,
            metric_weights,
            sparse_text_dir,
        )
    else:
        metric_outlier_summary = {"applied": False, "reason": "metric3d_selected_no_points"}
    if points.shape[0] <= 0:
        write_untracked_colmap_points(sparse_points_path, selected_sparse_points, selected_sparse_colors)
        return {
            **{key: value for key, value in metric3d_init.items() if key not in {"points", "colors", "weights"}},
            "requested": True,
            "applied": False,
            "reason": metric3d_init.get("reason") or "metric3d_selected_no_points",
            "sparsePointCount": sparse_point_count,
            "sparseOutlierFilter": sparse_outlier_summary,
            "metric3dOutlierFilter": metric_outlier_summary,
            "selectedSparsePointCount": int(selected_sparse_points.shape[0]),
            "addedPointCount": 0,
            "totalPointCount": int(selected_sparse_points.shape[0]),
        }

    combined_points = np.concatenate([selected_sparse_points, points], axis=0)
    combined_colors = np.concatenate([selected_sparse_colors, colors], axis=0)
    write_untracked_colmap_points(sparse_points_path, combined_points, combined_colors)

    return {
        **{key: value for key, value in metric3d_init.items() if key not in {"points", "colors", "weights"}},
        "requested": True,
        "applied": True,
        "sparsePointCount": sparse_point_count,
        "sparseOutlierFilter": sparse_outlier_summary,
        "metric3dOutlierFilter": metric_outlier_summary,
        "selectedSparsePointCount": int(selected_sparse_points.shape[0]),
        "addedPointCount": int(points.shape[0]),
        "totalPointCount": int(combined_points.shape[0]),
    }


def prepare_scaffoldgs_dataset(manifest: dict, source_dir: Path) -> dict:
    images_dir = Path(manifest["imagesDir"])
    sfm_text_model_dir = Path(manifest["sfmTextModelDir"])
    if not images_dir.exists():
        raise FileNotFoundError(f"scaffold_gs_images_missing:{images_dir}")
    if not sfm_text_model_dir.exists():
        raise FileNotFoundError(f"scaffold_gs_sfm_missing:{sfm_text_model_dir}")

    dataset_images_dir = ensure_dir(source_dir / "images")
    sparse_text_dir = ensure_dir(source_dir / "sparse" / "0")
    copied_images = 0
    for image_path in sorted(images_dir.iterdir()):
        if image_path.is_file() and image_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            copy_or_link_file(image_path, dataset_images_dir / image_path.name)
            copied_images += 1
    if copied_images <= 0:
        raise FileNotFoundError(f"scaffold_gs_no_images:{images_dir}")

    for filename in ("cameras.txt", "images.txt", "points3D.txt"):
        source = sfm_text_model_dir / filename
        if not source.exists():
            raise FileNotFoundError(f"scaffold_gs_colmap_text_missing:{source}")
        shutil.copy2(source, sparse_text_dir / filename)

    metric3d_init_summary = append_metric3d_points_to_colmap_model(
        manifest=manifest,
        images_dir=images_dir,
        sfm_text_model_dir=sfm_text_model_dir,
        sparse_text_dir=sparse_text_dir,
    )

    converter = shutil.which("colmap")
    converted_to_binary = False
    if converter:
        subprocess.run(
            [
                converter,
                "model_converter",
                "--input_path",
                str(sparse_text_dir),
                "--output_path",
                str(sparse_text_dir),
                "--output_type",
                "BIN",
            ],
            check=True,
        )
        converted_to_binary = all((sparse_text_dir / filename).exists() for filename in ("cameras.bin", "images.bin", "points3D.bin"))

    return {
        "sourceDir": str(source_dir),
        "imagesDir": str(dataset_images_dir),
        "sparseDir": str(sparse_text_dir),
        "imageCount": copied_images,
        "convertedColmapTextToBinary": converted_to_binary,
        "metric3dInit": metric3d_init_summary,
    }


def write_init_preflight_summary(source_dir: Path, output_dir: Path, voxel_size: float, max_anchors: int) -> dict:
    points_path = source_dir / "sparse" / "0" / "points3D.txt"
    points, _ = read_colmap_points_xyz_rgb(points_path)
    estimated_anchor_count = estimate_voxelized_anchor_count(points, voxel_size)
    summary = {
        "createdAt": now_iso(),
        "points3DPath": str(points_path),
        "inputPointCount": int(points.shape[0]),
        "voxelSize": float(voxel_size),
        "estimatedVoxelizedAnchorCount": int(estimated_anchor_count),
        "maxAllowedAnchors": int(max_anchors),
        "bounds": {
            "min": points.min(axis=0).astype(float).tolist() if points.shape[0] else None,
            "max": points.max(axis=0).astype(float).tolist() if points.shape[0] else None,
        },
    }
    write_json(output_dir / "init_preflight_summary.json", summary)
    if max_anchors > 0 and estimated_anchor_count > max_anchors:
        raise RuntimeError(
            f"scaffold_gs_anchor_preflight_too_large:{estimated_anchor_count}>{max_anchors}"
        )
    return summary


def find_latest_scaffoldgs_ply(model_dir: Path, iterations: int) -> Path:
    preferred = model_dir / "point_cloud" / f"iteration_{iterations}" / "point_cloud.ply"
    if preferred.exists():
        return preferred

    candidates = sorted(
        (model_dir / "point_cloud").glob("iteration_*/point_cloud.ply"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if candidates:
        return candidates[0]
    raise FileNotFoundError(f"scaffold_gs_point_cloud_missing:{model_dir / 'point_cloud'}")


def run_scaffoldgs(manifest_path: Path, result_path: Path, output_dir: Path, args: argparse.Namespace) -> dict:
    manifest = read_json(manifest_path)
    scaffoldgs_root = resolve_scaffoldgs_root(args.scaffoldgs_root)
    source_dir = ensure_dir(output_dir / "source")
    model_dir = ensure_dir(output_dir / "model")
    final_dir = ensure_dir(output_dir / "final")

    dataset_summary = prepare_scaffoldgs_dataset(manifest, source_dir)
    iterations = int(args.iterations)
    python = args.python or sys.executable
    init_preflight = write_init_preflight_summary(
        source_dir,
        output_dir,
        float(args.voxel_size),
        int(args.max_anchors),
    )

    command = [
        "env",
        "PYTHONUNBUFFERED=1",
        python,
        str(scaffoldgs_root / "train.py"),
        "--eval",
        "-s",
        str(source_dir),
        "-m",
        str(model_dir),
        "--lod",
        str(args.lod),
        "--gpu",
        str(args.gpu),
        "--voxel_size",
        str(args.voxel_size),
        "--update_init_factor",
        str(args.update_init_factor),
        "--appearance_dim",
        str(args.appearance_dim),
        "--ratio",
        str(args.ratio),
        "--iterations",
        str(iterations),
        "--save_iterations",
        str(iterations),
        "--quiet",
    ]
    if args.extra_args:
        command.extend(args.extra_args)

    subprocess.run(command, check=True, cwd=str(scaffoldgs_root))

    anchor_ply_path = find_latest_scaffoldgs_ply(model_dir, iterations)
    final_anchor_ply_path = final_dir / "scene.anchor.ply"
    shutil.copy2(anchor_ply_path, final_anchor_ply_path)

    final_ply_path = final_dir / "scene.ply"
    explicit_export = export_scaffoldgs_explicit_gaussians(
        model_dir=model_dir,
        output_ply_path=final_ply_path,
        cameras_json_path=model_dir / "cameras.json",
        sample_cameras=int(args.export_sample_cameras),
        batch_size=int(args.export_batch_size),
        opacity_threshold=float(args.export_opacity_threshold),
    )

    splat_scene_path = final_dir / "scene.splat"
    point_count = convert_gaussian_ply_to_splat(final_ply_path, splat_scene_path)

    result = {
        "schemaVersion": 1,
        "createdAt": now_iso(),
        "method": "scaffold_gs_adapter",
        "renderMode": "explicit_gaussian_export",
        "manifestPath": str(manifest_path),
        "outputDir": str(output_dir),
        "scaffoldGsRoot": str(scaffoldgs_root),
        "modelDir": str(model_dir),
        "dataset": dataset_summary,
        "initPreflight": init_preflight,
        "iterations": iterations,
        "command": command,
        "splatPlyPath": str(final_ply_path),
        "anchorPlyPath": str(final_anchor_ply_path),
        "splatScenePath": str(splat_scene_path),
        "pointCount": int(point_count),
        "explicitExport": explicit_export,
        "nativeSummary": {
            "sourcePointCloudPath": str(anchor_ply_path),
        },
    }
    write_json(result_path, result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Scaffold-GS for a master_v1 gaussian side branch")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--scaffoldgs-root", default="")
    parser.add_argument("--python", default="")
    parser.add_argument("--iterations", type=int, default=int(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_ITERATIONS", "30000")))
    parser.add_argument("--gpu", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_GPU", "-1"))
    parser.add_argument("--lod", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_LOD", "0"))
    parser.add_argument("--voxel-size", dest="voxel_size", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_VOXEL_SIZE", "0.001"))
    parser.add_argument("--update-init-factor", dest="update_init_factor", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_UPDATE_INIT_FACTOR", "16"))
    parser.add_argument("--appearance-dim", dest="appearance_dim", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_APPEARANCE_DIM", "0"))
    parser.add_argument("--ratio", default=os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_RATIO", "1"))
    parser.add_argument("--max-anchors", type=int, default=int(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_MAX_ANCHORS", "80000")))
    parser.add_argument("--export-sample-cameras", dest="export_sample_cameras", type=int, default=int(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_EXPORT_SAMPLE_CAMERAS", "18")))
    parser.add_argument("--export-batch-size", dest="export_batch_size", type=int, default=int(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_EXPORT_BATCH_SIZE", "2048")))
    parser.add_argument("--export-opacity-threshold", dest="export_opacity_threshold", type=float, default=float(os.environ.get("MASTER_PIPELINE_SCAFFOLD_GS_EXPORT_OPACITY_THRESHOLD", "0.045")))
    parser.add_argument("extra_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    result = run_scaffoldgs(
        Path(args.manifest),
        Path(args.result),
        ensure_dir(Path(args.output_dir)),
        args,
    )
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
