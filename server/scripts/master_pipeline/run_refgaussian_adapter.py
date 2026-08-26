#!/usr/bin/env python3
"""RefGaussian adapter for the master_v1 gaussian fork.

This adapter is intentionally separate from the vanilla gsplat output path. It
prepares the same image + COLMAP text-model inputs for a RefGaussian-style
trainer, keeps semantic mirror masks as evaluation metadata only, and writes a
``result.json`` that the master_v1 gaussian stage can publish as
``master_ref_gaussian`` artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


MASTER_PIPELINE_DIR = Path(__file__).resolve().parent
if str(MASTER_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(MASTER_PIPELINE_DIR))

RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR: Exception | None = None
RUN_GAUSSIAN_SPLATTING = None
try:
    import run_gaussian_splatting as RUN_GAUSSIAN_SPLATTING  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR = exc

RUN_GLOBAL_SFM_IMPORT_ERROR: Exception | None = None
RUN_GLOBAL_SFM = None
try:
    import run_global_sfm as RUN_GLOBAL_SFM  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional helper import
    RUN_GLOBAL_SFM_IMPORT_ERROR = exc

REFGAUSSIAN_BUNDLE_IMPORT_ERROR: Exception | None = None
export_refgaussian_bundle = None
try:
    from refgaussian_bundle import export_refgaussian_bundle  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - optional browser bundle helper
    REFGAUSSIAN_BUNDLE_IMPORT_ERROR = exc


C0 = 0.28209479177387814
VALID_DEPTH_PRIOR_MODES = {"disabled", "light", "full"}
VALID_REFGAUSSIAN_PROFILE_MODES = {
    "adaptive",
    "canonical_bathroom_light",
    "sfm_only_marginal_indoor",
}
DEFAULT_REFGAUSSIAN_PROFILE_MODE = os.environ.get(
    "MASTER_PIPELINE_REFGAUSSIAN_PROFILE_MODE",
    "adaptive",
).strip().lower()
DEFAULT_REFGAUSSIAN_DEPTH_PRIORS_MODE = os.environ.get(
    "MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE",
    "light",
).strip().lower()
DEFAULT_REFGAUSSIAN_METRIC3D_INIT_MODE = os.environ.get(
    "MASTER_PIPELINE_REFGAUSSIAN_METRIC3D_INIT_MODE",
    "fused_hole_fill",
).strip().lower()
DEFAULT_REFGAUSSIAN_LARGE_SCENE_IMAGE_COUNT = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_IMAGE_COUNT", "60")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_SPARSE_POINT_COUNT = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_SPARSE_POINT_COUNT", "25000")),
)
DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE = max(
    256,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE", "6000")),
)
DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS = max(
    1024,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS", "100000")),
)
DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS_CEILING = max(
    DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS_CEILING", "120000")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_POINTS_PER_IMAGE = max(
    256,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_POINTS_PER_IMAGE", "1500")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_POINTS = max(
    1024,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_POINTS", "30000")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_RATIO = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_RATIO", "0.75")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS = max(
    0,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS", "3000")),
)
# Paper-style staged schedule for marginal indoor captures: first ~half builds
# geometry (densify until 37.5%), second half runs deferred PBR + indirect
# reflection + normal propagation. At the 40k default this reproduces the
# upstream repo stage markers exactly (15k/18k/20k/25k).
DEFAULT_REFGAUSSIAN_STAGED_INDOOR_ITERATIONS = max(
    20000,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_STAGED_INDOOR_ITERATIONS", "40000")),
)
DEFAULT_REFGAUSSIAN_LAMBDA_NORMAL_SMOOTH = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_NORMAL_SMOOTH", "0.45")),
)
# Metric3D training-time supervision: calibrated depth-prior maps are exported
# into the dataset and Ref-Gaussian is patched to apply a masked depth (and
# depth-derived normal) loss so seeded geometry (blank walls, ceilings) is held
# in place during training instead of drifting once photometric loss takes over.
DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_LOSS_ENABLED = (
    os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_LOSS", "true").strip().lower()
    not in {"0", "false", "no", "off"}
)
DEFAULT_REFGAUSSIAN_LAMBDA_DEPTH_PRIOR = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_DEPTH_PRIOR", "0.15")),
)
DEFAULT_REFGAUSSIAN_LAMBDA_NORMAL_PRIOR = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_NORMAL_PRIOR", "0.10")),
)
# Free-space carving: alpha-coverage loss pulls opacity toward 1 wherever
# Metric3D says a surface exists (fills wall holes), and the asymmetric front
# weight punishes geometry rendered in front of the prior surface (floaters).
DEFAULT_REFGAUSSIAN_LAMBDA_ALPHA_PRIOR = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_ALPHA_PRIOR", "0.05")),
)
DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_FRONT_WEIGHT = max(
    1.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_FRONT_WEIGHT", "1.50")),
)
# Scale regularization: penalize gaussians growing beyond a fraction of the
# scene diagonal so needle/smear artifacts never form.
DEFAULT_REFGAUSSIAN_LAMBDA_SCALE_REG = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LAMBDA_SCALE_REG", "0.0025")),
)
DEFAULT_REFGAUSSIAN_MAX_SCALE_FRACTION = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_MAX_SCALE_FRACTION", "0.02")),
)
DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_EXCLUSION_BAND_PX = max(
    0,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_EXCLUSION_BAND_PX", "12")),
)
DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_MAX_SIDE = max(
    256,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_MAX_SIDE", "1024")),
)
DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_MIN_CONFIDENCE = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIOR_MIN_CONFIDENCE", "0.2")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_DENSIFY_UNTIL_FRACTION = min(
    max(float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_DENSIFY_UNTIL_FRACTION", "0.5")), 0.2),
    0.8,
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_INDIRECT_FROM_ITER = max(
    0,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_INDIRECT_FROM_ITER", "10000")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_DENSIFY_GRAD_THRESHOLD = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_DENSIFY_GRAD_THRESHOLD", "0.0002")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_PRUNE_OPACITY_THRESHOLD = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_PRUNE_OPACITY_THRESHOLD", "0.05")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_PERCENT_DENSE = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_PERCENT_DENSE", "0.01")),
)
DEFAULT_REFGAUSSIAN_LARGE_SCENE_OPACITY_RESET_INTERVAL = max(
    250,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_LARGE_SCENE_OPACITY_RESET_INTERVAL", "3000")),
)
DEFAULT_REFGAUSSIAN_SCALING_BASELINE_IMAGE_COUNT = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_SCALING_BASELINE_IMAGE_COUNT", "12")),
)
DEFAULT_REFGAUSSIAN_SCALING_IMAGE_RANGE = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_SCALING_IMAGE_RANGE", "60")),
)
DEFAULT_REFGAUSSIAN_SCALING_BASELINE_SPARSE_POINTS = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_SCALING_BASELINE_SPARSE_POINTS", "9000")),
)
DEFAULT_REFGAUSSIAN_SCALING_SPARSE_RANGE = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_SCALING_SPARSE_RANGE", "26000")),
)
BASELINE_REFGAUSSIAN_HEALTHY_IMAGE_COUNT = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_BASELINE_IMAGE_COUNT", "6")),
)
BASELINE_REFGAUSSIAN_HEALTHY_SPARSE_POINTS = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_BASELINE_SPARSE_POINTS", "6706")),
)
BASELINE_REFGAUSSIAN_HEALTHY_INIT_POINTS = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_BASELINE_INIT_POINTS", "42739")),
)
BASELINE_REFGAUSSIAN_HEALTHY_FINAL_POINTS = max(
    1,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_BASELINE_FINAL_POINTS", "318764")),
)
BASELINE_REFGAUSSIAN_HEALTHY_ITERATIONS = max(
    1000,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_BASELINE_ITERATIONS", "20000")),
)
DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX = max(
    0,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX", "12")),
)
DEFAULT_REFGAUSSIAN_MAX_MIRROR_EXCLUSION_BAND_PX = max(
    DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_MAX_MIRROR_EXCLUSION_BAND_PX", "36")),
)
DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_COVERAGE_SCALE_PX = max(
    0.0,
    float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_COVERAGE_SCALE_PX", "72")),
)
DEFAULT_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD = min(
    max(float(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD", "0.18")), 0.0),
    0.95,
)
DEFAULT_NATIVE_RENDER_CONTRACT_MAX_COPY_BYTES = max(
    1024 * 1024,
    int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_NATIVE_CONTRACT_MAX_COPY_BYTES", str(128 * 1024 * 1024))),
)
NATIVE_RENDER_CONTRACT_STRICT = (
    os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_NATIVE_CONTRACT_STRICT", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)
NATIVE_RENDERER_SOURCE_PATHS = [
    ("eval.py", "required_renderer_entrypoint"),
    ("gaussian_renderer", "required_renderer_package"),
    ("scene/gaussian_model.py", "required_model_source"),
    ("scene/light.py", "required_lighting_source"),
    ("utils/refl_utils.py", "required_reflection_source"),
    ("utils/graphics_utils.py", "camera_math_dependency"),
    ("utils/sh_utils.py", "spherical_harmonics_dependency"),
    ("utils/general_utils.py", "renderer_utility_dependency"),
    ("utils/system_utils.py", "renderer_utility_dependency"),
    ("arguments/__init__.py", "renderer_args_dependency"),
    ("scene/__init__.py", "scene_loader_dependency"),
    ("scene/cameras.py", "camera_model_dependency"),
    ("scene/dataset_readers.py", "camera_split_dependency"),
    ("scene/renderutils", "nvdiffrast_renderutils_dependency"),
]
NATIVE_RENDERER_ASSET_PATHS = [
    ("assets/bsdf_256_256.bin", "required_bsdf_lut"),
]
NATIVE_MODULE_CANDIDATES = [
    {
        "name": "diff_surfel_rasterization",
        "required": True,
        "pythonModule": "diff_surfel_rasterization",
        "paths": [
            "diff_surfel_rasterization",
            "submodules/diff-surfel-rasterization",
            "submodules/diff_surfel_rasterization",
        ],
    },
    {
        "name": "raytracing",
        "required": True,
        "pythonModule": "raytracing",
        "paths": [
            "raytracing",
            "submodules/raytracing",
        ],
    },
    {
        "name": "nvdiffrast",
        "required": True,
        "pythonModule": "nvdiffrast",
        "paths": [
            "nvdiffrast",
            "scene/renderutils",
        ],
    },
]


def log(message: str) -> None:
    print(f"[RefGaussianAdapter] {message}", flush=True)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def clamp_unit_interval(value: float) -> float:
    return min(max(float(value), 0.0), 1.0)


def lerp(start: float, end: float, t: float) -> float:
    return float(start) + (float(end) - float(start)) * clamp_unit_interval(t)


def round_to_step(value: float, step: int) -> int:
    step = max(1, int(step))
    return int(round(float(value) / float(step))) * step


def resolve_refgaussian_profile_mode() -> str:
    mode = str(DEFAULT_REFGAUSSIAN_PROFILE_MODE or "adaptive").strip().lower()
    return mode if mode in VALID_REFGAUSSIAN_PROFILE_MODES else "adaptive"


def compute_capture_scene_scales(*, image_count: int, sparse_point_count: int) -> dict[str, float]:
    image_scale = clamp_unit_interval(
        (float(image_count) - float(DEFAULT_REFGAUSSIAN_SCALING_BASELINE_IMAGE_COUNT))
        / float(DEFAULT_REFGAUSSIAN_SCALING_IMAGE_RANGE)
    )
    sparse_scale = clamp_unit_interval(
        (float(sparse_point_count) - float(DEFAULT_REFGAUSSIAN_SCALING_BASELINE_SPARSE_POINTS))
        / float(DEFAULT_REFGAUSSIAN_SCALING_SPARSE_RANGE)
    )
    scene_scale = max(image_scale, sparse_scale)
    return {
        "imageScale": float(image_scale),
        "sparseScale": float(sparse_scale),
        "sceneScale": float(scene_scale),
    }


def is_large_refgaussian_scene(*, image_count: int, sparse_point_count: int, scene_scale: float) -> bool:
    return (
        int(image_count) >= DEFAULT_REFGAUSSIAN_LARGE_SCENE_IMAGE_COUNT
        or int(sparse_point_count) >= DEFAULT_REFGAUSSIAN_LARGE_SCENE_SPARSE_POINT_COUNT
        or float(scene_scale) >= 0.7
    )


def is_marginal_indoor_scene(*, image_count: int, sparse_point_count: int) -> bool:
    """Detect weak SfM substrate before RefGaussian's early prune/reset window."""
    image_count = max(int(image_count), 1)
    sparse_point_count = max(int(sparse_point_count), 0)
    sparse_per_image = float(sparse_point_count) / float(image_count)
    healthy_sparse_per_image = (
        float(BASELINE_REFGAUSSIAN_HEALTHY_SPARSE_POINTS)
        / float(BASELINE_REFGAUSSIAN_HEALTHY_IMAGE_COUNT)
    )
    expected_sparse = healthy_sparse_per_image * float(image_count)
    return (
        sparse_per_image < healthy_sparse_per_image * 0.8
        or float(sparse_point_count) < expected_sparse * 0.65
    )


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


def write_colmap_points3d_text(points_by_id: dict[int, dict], points_path: Path) -> None:
    lines = [
        "# 3D point list\n",
        "# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n",
    ]
    for point_id in sorted(points_by_id):
        point = points_by_id[point_id]
        xyz = np.asarray(point["xyz"], dtype=np.float64).reshape(3)
        rgb = [int(value) for value in point.get("rgb", [255, 255, 255])]
        track = " ".join(
            f"{int(image_id)} {int(point2d_idx)}"
            for image_id, point2d_idx in point.get("track", [])
        )
        line = (
            f"{int(point_id)} {float(xyz[0])} {float(xyz[1])} {float(xyz[2])} "
            f"{rgb[0]} {rgb[1]} {rgb[2]} {float(point.get('error', 0.0))}"
        )
        if track:
            line += f" {track}"
        lines.append(f"{line}\n")
    points_path.write_text("".join(lines), encoding="utf-8")


def resolve_depth_priors_mode(manifest: dict) -> str:
    depth_priors = manifest.get("depthPriors") or {}
    mode = str(
        os.environ.get(
            "MASTER_PIPELINE_REFGAUSSIAN_DEPTH_PRIORS_MODE",
            depth_priors.get("defaultMode") or DEFAULT_REFGAUSSIAN_DEPTH_PRIORS_MODE,
        )
    ).strip().lower()
    return mode if mode in VALID_DEPTH_PRIOR_MODES else DEFAULT_REFGAUSSIAN_DEPTH_PRIORS_MODE


def resolve_depth_priors_config(manifest: dict, sparse_point_count: int, image_count: int) -> dict:
    depth_priors = manifest.get("depthPriors") or {}
    mode = resolve_depth_priors_mode(manifest)
    profile_mode = resolve_refgaussian_profile_mode()
    metric3d_init_mode = str(
        os.environ.get(
            "MASTER_PIPELINE_REFGAUSSIAN_METRIC3D_INIT_MODE",
            depth_priors.get("initMode") or DEFAULT_REFGAUSSIAN_METRIC3D_INIT_MODE,
        )
    ).strip().lower()
    if metric3d_init_mode not in {"raw", "fused_hole_fill"}:
        metric3d_init_mode = DEFAULT_REFGAUSSIAN_METRIC3D_INIT_MODE
    metric3d_dir = Path(depth_priors["dir"]) if depth_priors.get("dir") else None
    max_init_points = int(depth_priors.get("maxInitPoints", sparse_point_count) or sparse_point_count)
    point_budget_per_image = int(depth_priors.get("pointBudgetPerImage", 0) or 0)
    remaining_budget = max(0, max_init_points - int(sparse_point_count))
    scene_scales = compute_capture_scene_scales(
        image_count=int(image_count),
        sparse_point_count=int(sparse_point_count),
    )
    large_scene_sparse_first = is_large_refgaussian_scene(
        image_count=int(image_count),
        sparse_point_count=int(sparse_point_count),
        scene_scale=float(scene_scales["sceneScale"]),
    )
    scaled_light_max_added_points = int(round(lerp(
        DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS,
        DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS_CEILING,
        scene_scales["sceneScale"],
    )))
    init_policy = "sparse_plus_depth_priors"

    if mode == "disabled":
        selected_point_budget_per_image = 0
        max_added_points = 0
        init_policy = "colmap_sparse_only"
    elif mode == "full":
        fallback_budget = (
            int(getattr(RUN_GAUSSIAN_SPLATTING, "DEFAULT_DEPTH_PRIORS_MAX_POINTS_PER_IMAGE", 12000))
            if RUN_GAUSSIAN_SPLATTING is not None
            else 12000
        )
        selected_point_budget_per_image = max(1, point_budget_per_image or fallback_budget)
        max_added_points = remaining_budget
        init_policy = "dense_metric3d_full_fusion"
    else:
        if profile_mode in {"canonical_bathroom_light", "sfm_only_marginal_indoor"}:
            selected_point_budget_per_image = max(
                1,
                min(
                    point_budget_per_image or DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE,
                    DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE,
                ),
            )
            max_added_points = min(
                remaining_budget,
                DEFAULT_REFGAUSSIAN_LIGHT_MAX_ADDED_POINTS,
            )
            init_policy = (
                "canonical_bathroom_light_priors"
                if profile_mode == "canonical_bathroom_light"
                else "sfm_first_light_priors"
            )
            large_scene_sparse_first = False
        elif large_scene_sparse_first:
            selected_point_budget_per_image = max(
                1,
                min(
                    point_budget_per_image or DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE,
                    DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_POINTS_PER_IMAGE,
                ),
            )
            sparse_scaled_added_budget = max(
                4096,
                int(round(float(max(sparse_point_count, 1)) * DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_RATIO)),
            )
            max_added_points = min(
                remaining_budget,
                DEFAULT_REFGAUSSIAN_LARGE_SCENE_LIGHT_MAX_ADDED_POINTS,
                sparse_scaled_added_budget,
            )
            init_policy = "large_scene_sparse_first_light_priors"
        else:
            selected_point_budget_per_image = max(
                1,
                min(
                    point_budget_per_image or DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE,
                    DEFAULT_REFGAUSSIAN_LIGHT_POINTS_PER_IMAGE,
                ),
            )
            max_added_points = min(
                remaining_budget,
                max(scaled_light_max_added_points, int(sparse_point_count)),
            )

    return {
        "requested": bool(depth_priors.get("requested", False)),
        "profileMode": profile_mode,
        "mode": mode,
        "dir": metric3d_dir,
        "maxInitPoints": max_init_points,
        "remainingBudget": remaining_budget,
        "pointBudgetPerImage": selected_point_budget_per_image,
        "maxAddedPoints": max_added_points,
        "basePointBudgetPerImage": point_budget_per_image,
        "imageScale": float(scene_scales["imageScale"]),
        "sparseScale": float(scene_scales["sparseScale"]),
        "sceneScale": float(scene_scales["sceneScale"]),
        "largeSceneSparseFirst": bool(large_scene_sparse_first),
        "initPolicy": init_policy,
        "metric3dInitMode": metric3d_init_mode,
        "scaledLightMaxAddedPoints": int(scaled_light_max_added_points),
    }


def build_empty_depth_priors_summary(config: dict, reason: str | None = None) -> dict:
    return {
        "requested": bool(config.get("requested", False)),
        "used": False,
        "mode": config.get("mode", "disabled"),
        "reason": reason,
        "candidatePointCount": 0,
        "selectedPointCount": 0,
        "calibratedImageCount": 0,
        "calibrationAnchorCount": 0,
        "pointBudgetPerImage": int(config.get("pointBudgetPerImage", 0) or 0),
        "maxAddedPoints": int(config.get("maxAddedPoints", 0) or 0),
        "imageScale": float(config.get("imageScale", 0.0) or 0.0),
        "sparseScale": float(config.get("sparseScale", 0.0) or 0.0),
        "sceneScale": float(config.get("sceneScale", 0.0) or 0.0),
        "largeSceneSparseFirst": bool(config.get("largeSceneSparseFirst", False)),
        "initPolicy": str(config.get("initPolicy", "unknown")),
        "metric3dInitMode": str(config.get("metric3dInitMode", "unknown")),
        "scaledLightMaxAddedPoints": int(config.get("scaledLightMaxAddedPoints", 0) or 0),
        "maskExcludedPixelCount": 0,
        "mirrorExclusionBandPx": int(DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX),
        "maxMirrorExclusionBandPx": int(DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX),
        "reflectiveSkipCoverageThreshold": float(DEFAULT_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD),
        "skippedReflectiveFrameCount": 0,
        "maxReflectiveCoverage": 0.0,
        "downsampled": False,
    }


def append_metric3d_points_to_sparse_model(
    *,
    manifest: dict,
    config: dict,
    points_by_id: dict[int, dict],
) -> tuple[dict[int, dict], dict]:
    if config["mode"] == "disabled":
        return points_by_id, build_empty_depth_priors_summary(config, reason="depth_priors_disabled")
    if RUN_GAUSSIAN_SPLATTING is None:
        return points_by_id, build_empty_depth_priors_summary(
            config,
            reason=f"depth_priors_helper_import_failed:{RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR}",
        )
    if config["dir"] is None:
        return points_by_id, build_empty_depth_priors_summary(config, reason="depth_priors_dir_unset")
    if config["maxAddedPoints"] <= 0:
        return points_by_id, build_empty_depth_priors_summary(config, reason="depth_priors_init_budget_exhausted")

    metric3d_init_mode = str(config.get("metric3dInitMode", "raw")).strip().lower()
    fused_loader = getattr(RUN_GAUSSIAN_SPLATTING, "_load_metric3d_fused_hole_fill_init_points", None)
    if metric3d_init_mode == "fused_hole_fill" and callable(fused_loader):
        depth_priors_init = fused_loader(
            images_dir=Path(manifest["imagesDir"]),
            sfm_text_model_dir=Path(manifest["sfmTextModelDir"]),
            metric3d_dir=config["dir"],
            max_points=int(config["maxAddedPoints"]),
            point_budget_per_image=int(config["pointBudgetPerImage"]),
            masks_dir=Path(manifest["masksDir"]) if manifest.get("masksDir") else None,
            mirror_exclusion_band_px=DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX,
            max_mirror_exclusion_band_px=DEFAULT_REFGAUSSIAN_MAX_MIRROR_EXCLUSION_BAND_PX,
            mirror_exclusion_band_coverage_scale_px=DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_COVERAGE_SCALE_PX,
            reflective_skip_coverage_threshold=DEFAULT_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD,
        )
    else:
        depth_priors_init = RUN_GAUSSIAN_SPLATTING._load_metric3d_init_points(
            images_dir=Path(manifest["imagesDir"]),
            sfm_text_model_dir=Path(manifest["sfmTextModelDir"]),
            metric3d_dir=config["dir"],
            max_points=int(config["maxAddedPoints"]),
            point_budget_per_image=int(config["pointBudgetPerImage"]),
            masks_dir=Path(manifest["masksDir"]) if manifest.get("masksDir") else None,
            mirror_exclusion_band_px=DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_PX,
            max_mirror_exclusion_band_px=DEFAULT_REFGAUSSIAN_MAX_MIRROR_EXCLUSION_BAND_PX,
            mirror_exclusion_band_coverage_scale_px=DEFAULT_REFGAUSSIAN_MIRROR_EXCLUSION_BAND_COVERAGE_SCALE_PX,
            reflective_skip_coverage_threshold=DEFAULT_REFGAUSSIAN_REFLECTIVE_SKIP_COVERAGE_THRESHOLD,
        )
    selected_points = np.asarray(depth_priors_init.get("points"), dtype=np.float32).reshape(-1, 3)
    selected_colors = np.asarray(depth_priors_init.get("colors"), dtype=np.float32).reshape(-1, 3)
    if selected_points.shape[0] > 0:
        next_point_id = (max(points_by_id.keys()) + 1) if points_by_id else 1
        for offset, (xyz, color) in enumerate(zip(selected_points, selected_colors, strict=False)):
            rgb = np.clip(np.rint(np.asarray(color, dtype=np.float32) * 255.0), 0, 255).astype(np.int32)
            points_by_id[next_point_id + offset] = {
                "pointId": next_point_id + offset,
                "xyz": np.asarray(xyz, dtype=np.float64),
                "rgb": [int(rgb[0]), int(rgb[1]), int(rgb[2])],
                "error": 0.0,
                "track": [],
            }

    summary = {
        "requested": bool(depth_priors_init.get("requested", False)),
        "used": bool(int(depth_priors_init.get("selectedPointCount", 0) or 0) > 0),
        "mode": config["mode"],
        "reason": depth_priors_init.get("reason"),
        "candidatePointCount": int(depth_priors_init.get("candidatePointCount", 0) or 0),
        "selectedPointCount": int(depth_priors_init.get("selectedPointCount", 0) or 0),
        "calibratedImageCount": int(depth_priors_init.get("calibratedImageCount", 0) or 0),
        "calibrationAnchorCount": int(depth_priors_init.get("calibrationAnchorCount", 0) or 0),
        "pointBudgetPerImage": int(depth_priors_init.get("pointBudgetPerImage", 0) or 0),
        "maxAddedPoints": int(config.get("maxAddedPoints", 0) or 0),
        "imageScale": float(config.get("imageScale", 0.0) or 0.0),
        "sparseScale": float(config.get("sparseScale", 0.0) or 0.0),
        "sceneScale": float(config.get("sceneScale", 0.0) or 0.0),
        "largeSceneSparseFirst": bool(config.get("largeSceneSparseFirst", False)),
        "initPolicy": str(config.get("initPolicy", "unknown")),
        "metric3dInitMode": str(depth_priors_init.get("initMode", metric3d_init_mode)),
        "scaledLightMaxAddedPoints": int(config.get("scaledLightMaxAddedPoints", 0) or 0),
        "maskExcludedPixelCount": int(depth_priors_init.get("maskExcludedPixelCount", 0) or 0),
        "sfmCoveredPixelCount": int(depth_priors_init.get("sfmCoveredPixelCount", 0) or 0),
        "supportRejectedPointCount": int(depth_priors_init.get("supportRejectedPointCount", 0) or 0),
        "multiviewAcceptedPointCount": int(depth_priors_init.get("multiviewAcceptedPointCount", 0) or 0),
        "fusedPointCount": int(depth_priors_init.get("fusedPointCount", 0) or 0),
        "minSupportViews": int(depth_priors_init.get("minSupportViews", 0) or 0),
        "depthAgreementTolerance": float(depth_priors_init.get("depthAgreementTolerance", 0.0) or 0.0),
        "sfmCoverageRadiusPx": int(depth_priors_init.get("sfmCoverageRadiusPx", 0) or 0),
        "voxelSize": float(depth_priors_init.get("voxelSize", 0.0) or 0.0),
        "mirrorExclusionBandPx": int(depth_priors_init.get("mirrorExclusionBandPx", 0) or 0),
        "maxMirrorExclusionBandPx": int(depth_priors_init.get("maxMirrorExclusionBandPx", 0) or 0),
        "reflectiveSkipCoverageThreshold": float(depth_priors_init.get("reflectiveSkipCoverageThreshold", 0.0) or 0.0),
        "skippedReflectiveFrameCount": int(depth_priors_init.get("skippedReflectiveFrameCount", 0) or 0),
        "maxReflectiveCoverage": float(depth_priors_init.get("maxReflectiveCoverage", 0.0) or 0.0),
        "downsampled": bool(depth_priors_init.get("downsampled", False)),
    }
    return points_by_id, summary


def export_depth_prior_training_maps(
    *,
    manifest: dict,
    config: dict,
    dataset_dir: Path,
) -> dict:
    """Export per-image calibrated Metric3D depth maps (SfM scale) plus validity
    masks into the Ref-Gaussian dataset so the patched trainer can apply a
    depth/normal prior loss. Reflective classes (mirror/window/glass) are
    excluded with a dilation band so reflections never supervise depth."""
    summary = {
        "enabled": bool(DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_LOSS_ENABLED),
        "mapCount": 0,
        "dir": None,
        "reason": None,
    }
    if not DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_LOSS_ENABLED:
        summary["reason"] = "depth_prior_loss_disabled"
        return summary
    if config.get("mode") == "disabled" or config.get("dir") is None:
        summary["reason"] = "depth_priors_disabled_or_dir_unset"
        return summary
    if RUN_GAUSSIAN_SPLATTING is None:
        summary["reason"] = f"depth_priors_helper_import_failed:{RUN_GAUSSIAN_SPLATTING_IMPORT_ERROR}"
        return summary

    try:
        supervision = RUN_GAUSSIAN_SPLATTING._build_depth_supervision(
            images_dir=Path(manifest["imagesDir"]),
            sfm_text_model_dir=Path(manifest["sfmTextModelDir"]),
            metric3d_dir=config["dir"],
            masks_dir=Path(manifest["masksDir"]) if manifest.get("masksDir") else None,
        )
    except Exception as exc:
        summary["reason"] = f"depth_supervision_build_failed:{exc}"
        return summary
    if not supervision:
        summary["reason"] = "no_calibrated_depth_maps"
        return summary

    import cv2

    out_dir = ensure_dir(dataset_dir / "depth_priors")
    band_px = int(DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_EXCLUSION_BAND_PX)
    kernel = (
        np.ones(((band_px * 2) + 1, (band_px * 2) + 1), dtype=np.uint8)
        if band_px > 0
        else None
    )
    max_side = int(DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_MAX_SIDE)
    min_confidence = float(DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_MIN_CONFIDENCE)

    written = 0
    for image_name, entry in sorted(supervision.items()):
        depth = np.asarray(entry["depth"], dtype=np.float32)
        confidence = np.asarray(entry["confidence"], dtype=np.float32)
        exclude = np.asarray(entry["exclude"], dtype=bool)
        if kernel is not None and np.any(exclude):
            exclude = cv2.dilate(exclude.astype(np.uint8), kernel, iterations=1).astype(bool)

        valid = (
            np.isfinite(depth)
            & np.isfinite(confidence)
            & (depth > 0.05)
            & (depth < 50.0)
            & (confidence > min_confidence)
            & ~exclude
        )
        if not np.any(valid):
            continue

        height, width = depth.shape[:2]
        longest = max(height, width)
        if longest > max_side:
            scale = float(max_side) / float(longest)
            new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
            depth = cv2.resize(depth, new_size, interpolation=cv2.INTER_AREA)
            valid = cv2.resize(valid.astype(np.uint8), new_size, interpolation=cv2.INTER_NEAREST).astype(bool)

        depth = np.where(valid, depth, 0.0).astype(np.float32)
        np.savez_compressed(out_dir / f"{Path(image_name).stem}.npz", depth=depth, valid=valid)
        written += 1

    summary["mapCount"] = int(written)
    summary["dir"] = str(out_dir) if written else None
    if written == 0:
        summary["reason"] = "no_valid_depth_pixels"
    return summary


def prepare_refgaussian_dataset(manifest: dict, dataset_dir: Path) -> dict:
    """Create a vanilla 3DGS/COLMAP dataset layout.

    Mirror masks are deliberately not copied into the training image path. The
    RefGaussian fork should see original reflective pixels from the first
    training iteration.
    """
    images_dir = Path(manifest["imagesDir"])
    sfm_text_model_dir = Path(manifest["sfmTextModelDir"])
    masks_dir = manifest.get("masksDir")

    out_images_dir = ensure_dir(dataset_dir / "images")
    out_sparse_dir = ensure_dir(dataset_dir / "sparse" / "0")
    points3d_ply_path = out_sparse_dir / "points3D.ply"
    if points3d_ply_path.exists():
        points3d_ply_path.unlink()

    for filename in ("cameras.txt", "images.txt"):
        source = sfm_text_model_dir / filename
        if not source.exists():
            raise FileNotFoundError(f"missing_colmap_text_model_file:{source}")
        shutil.copy2(source, out_sparse_dir / filename)

    source_points_path = sfm_text_model_dir / "points3D.txt"
    if not source_points_path.exists():
        raise FileNotFoundError(f"missing_colmap_text_model_file:{source_points_path}")

    registered_image_names: set[str] | None = None
    if RUN_GLOBAL_SFM is not None:
        registered_image_names = set(
            RUN_GLOBAL_SFM.parse_colmap_images_text(sfm_text_model_dir / "images.txt").keys()
        )

    image_count = 0
    for image_path in list_images(images_dir):
        if registered_image_names is not None and image_path.name not in registered_image_names:
            continue
        copy_or_link(image_path, out_images_dir / image_path.name)
        image_count += 1

    sparse_point_count = count_colmap_points(source_points_path)
    depth_priors_config = resolve_depth_priors_config(manifest, sparse_point_count, image_count)
    depth_priors_summary = build_empty_depth_priors_summary(depth_priors_config, reason="depth_priors_not_requested")
    init_bounds_filter = {"applied": False, "reason": "not_run"}
    init_point_source = "colmap_sparse_only"
    init_point_count = sparse_point_count

    if RUN_GLOBAL_SFM is None:
        shutil.copy2(source_points_path, out_sparse_dir / "points3D.txt")
        if depth_priors_config["mode"] != "disabled":
            depth_priors_summary = build_empty_depth_priors_summary(
                depth_priors_config,
                reason=f"colmap_text_model_helper_import_failed:{RUN_GLOBAL_SFM_IMPORT_ERROR}",
            )
    else:
        points_by_id = RUN_GLOBAL_SFM.parse_colmap_points3d_text(source_points_path)
        points_by_id, depth_priors_summary = append_metric3d_points_to_sparse_model(
            manifest=manifest,
            config=depth_priors_config,
            points_by_id=points_by_id,
        )
        points_by_id, init_bounds_filter = filter_init_points_to_scene_bounds(points_by_id)
        write_colmap_points3d_text(points_by_id, out_sparse_dir / "points3D.txt")
        init_point_count = len(points_by_id)
        if depth_priors_summary["used"]:
            init_point_source = "colmap_sparse_plus_depth_priors_world"

    depth_prior_training_summary = export_depth_prior_training_maps(
        manifest=manifest,
        config=depth_priors_config,
        dataset_dir=dataset_dir,
    )

    return {
        "datasetDir": str(dataset_dir),
        "imageCount": image_count,
        "sparsePointCount": int(sparse_point_count),
        "initPointCount": int(init_point_count),
        "initPointSource": init_point_source,
        "initBoundsFilterApplied": bool(init_bounds_filter.get("applied")),
        "initBoundsFilterRemovedPointCount": int(init_bounds_filter.get("removedPointCount", 0) or 0),
        "initBoundsFilterKeptPointCount": int(init_bounds_filter.get("keptPointCount", init_point_count) or init_point_count),
        "initBoundsFilterMargin": float(init_bounds_filter.get("margin", 0.0) or 0.0),
        "trainingMaskMode": "metadata_only",
        "masksDir": masks_dir,
        "depthPriorsMode": depth_priors_summary["mode"],
        "depthPriorsRequested": bool(depth_priors_summary["requested"]),
        "depthPriorsUsed": bool(depth_priors_summary["used"]),
        "depthPriorsCandidatePointCount": int(depth_priors_summary["candidatePointCount"]),
        "depthPriorsInitPointCount": int(depth_priors_summary["selectedPointCount"]),
        "depthPriorsAlignedImageCount": int(depth_priors_summary["calibratedImageCount"]),
        "depthPriorsCalibrationAnchorCount": int(depth_priors_summary["calibrationAnchorCount"]),
        "depthPriorsPointBudgetPerImage": int(depth_priors_summary["pointBudgetPerImage"]),
        "depthPriorsMaxAddedPoints": int(depth_priors_summary["maxAddedPoints"]),
        "depthPriorsImageScale": float(depth_priors_summary["imageScale"]),
        "depthPriorsSparseScale": float(depth_priors_summary["sparseScale"]),
        "depthPriorsSceneScale": float(depth_priors_summary["sceneScale"]),
        "depthPriorsLargeSceneSparseFirst": bool(depth_priors_summary["largeSceneSparseFirst"]),
        "depthPriorsInitPolicy": str(depth_priors_summary["initPolicy"]),
        "depthPriorsScaledLightMaxAddedPoints": int(depth_priors_summary["scaledLightMaxAddedPoints"]),
        "depthPriorsMaskExcludedPixelCount": int(depth_priors_summary["maskExcludedPixelCount"]),
        "depthPriorsMirrorExclusionBandPx": int(depth_priors_summary["mirrorExclusionBandPx"]),
        "depthPriorsMaxMirrorExclusionBandPx": int(depth_priors_summary["maxMirrorExclusionBandPx"]),
        "depthPriorsReflectiveSkipCoverageThreshold": float(depth_priors_summary["reflectiveSkipCoverageThreshold"]),
        "depthPriorsSkippedReflectiveFrameCount": int(depth_priors_summary["skippedReflectiveFrameCount"]),
        "depthPriorsMaxReflectiveCoverage": float(depth_priors_summary["maxReflectiveCoverage"]),
        "depthPriorsDownsampled": bool(depth_priors_summary["downsampled"]),
        "depthPriorsReason": depth_priors_summary["reason"],
        "depthPriorTrainingLossEnabled": bool(depth_prior_training_summary["enabled"]),
        "depthPriorTrainingMapCount": int(depth_prior_training_summary["mapCount"]),
        "depthPriorTrainingMapsDir": depth_prior_training_summary["dir"],
        "depthPriorTrainingReason": depth_prior_training_summary["reason"],
    }


def count_colmap_points(points_path: Path) -> int:
    if not points_path.exists():
        return 0
    count = 0
    with points_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            count += 1
    return count


def filter_init_points_to_scene_bounds(
    points_by_id: dict[int, dict],
    *,
    margin_factor: float = 2.5,
) -> tuple[dict[int, dict], dict]:
    sfm_points = [
        np.asarray(point["xyz"], dtype=np.float64)
        for point in points_by_id.values()
        if point.get("track")
    ]
    if not sfm_points:
        return points_by_id, {"applied": False, "reason": "no_sfm_anchor_points"}

    anchor = np.stack(sfm_points, axis=0)
    finite = anchor[np.isfinite(anchor).all(axis=1)]
    if finite.shape[0] == 0:
        return points_by_id, {"applied": False, "reason": "no_finite_sfm_anchor_points"}

    bbox_min = finite.min(axis=0)
    bbox_max = finite.max(axis=0)
    diagonal = float(np.linalg.norm(bbox_max - bbox_min))
    margin = max(0.5, diagonal * margin_factor)
    lower_bound = bbox_min - margin
    upper_bound = bbox_max + margin

    kept: dict[int, dict] = {}
    removed = 0
    for point_id, point in points_by_id.items():
        xyz = np.asarray(point["xyz"], dtype=np.float64)
        if not np.all(np.isfinite(xyz)):
            removed += 1
            continue
        if np.all(xyz >= lower_bound) and np.all(xyz <= upper_bound):
            kept[point_id] = point
        else:
            removed += 1

    return kept, {
        "applied": removed > 0,
        "removedPointCount": int(removed),
        "keptPointCount": int(len(kept)),
        "bboxDiagonal": diagonal,
        "margin": float(margin),
    }


def build_adaptive_training_profile(
    *,
    manifest: dict,
    dataset_summary: dict,
    requested_iterations: int,
) -> dict:
    image_count = int(dataset_summary.get("imageCount", 0) or 0)
    sparse_point_count = int(dataset_summary.get("sparsePointCount", 0) or 0)
    init_point_count = int(dataset_summary.get("initPointCount", sparse_point_count) or sparse_point_count)
    profile_mode = resolve_refgaussian_profile_mode()
    if sparse_point_count <= 0:
        sfm_text_model_dir = Path(manifest["sfmTextModelDir"])
        sparse_point_count = count_colmap_points(sfm_text_model_dir / "points3D.txt")
    # Tier selection follows capture/SfM scale only. Fused Metric3D init can be
    # much denser without implying a larger room or longer training schedule.
    profile_point_count = sparse_point_count

    requested_iterations = max(1000, int(requested_iterations))
    if profile_mode in {"sfm_only_marginal_indoor", "canonical_bathroom_light"}:
        if profile_mode == "sfm_only_marginal_indoor":
            # Staged Ref-Gaussian schedule (paper/repo structure): keep the
            # upstream init/volume/indirect rhythm. Dense Metric3D is now a
            # fused hole-fill initializer, so keep densification at the 3DGS
            # default 15k/40k cadence instead of letting raw depth shells clone.
            effective_iterations = max(requested_iterations, DEFAULT_REFGAUSSIAN_STAGED_INDOOR_ITERATIONS)
            profile_overrides = {
                "initial": "1",
                "init_until_iter": "3000",
                "densify_until_iter": str(int(round(effective_iterations * 0.375))),
                "volume_render_until_iter": str(int(round(effective_iterations * 0.45))),
                "indirect_from_iter": str(int(round(effective_iterations * 0.50))),
                "normal_prop_until_iter": str(int(round(effective_iterations * 0.625))),
                "lambda_normal_smooth": f"{DEFAULT_REFGAUSSIAN_LAMBDA_NORMAL_SMOOTH:.2f}",
                "prune_opacity_threshold": "0.0500",
                "position_lr_max_steps": str(int(effective_iterations)),
            }
            if DEFAULT_REFGAUSSIAN_LAMBDA_SCALE_REG > 0.0 and DEFAULT_REFGAUSSIAN_MAX_SCALE_FRACTION > 0.0:
                profile_overrides.update({
                    "lambda_scale_reg": f"{DEFAULT_REFGAUSSIAN_LAMBDA_SCALE_REG:.4f}",
                    "max_gaussian_scale_fraction": f"{DEFAULT_REFGAUSSIAN_MAX_SCALE_FRACTION:.4f}",
                })
            depth_prior_maps_dir = dataset_summary.get("depthPriorTrainingMapsDir")
            depth_prior_map_count = int(dataset_summary.get("depthPriorTrainingMapCount", 0) or 0)
            if (
                depth_prior_maps_dir
                and depth_prior_map_count > 0
                and (DEFAULT_REFGAUSSIAN_LAMBDA_DEPTH_PRIOR > 0.0 or DEFAULT_REFGAUSSIAN_LAMBDA_NORMAL_PRIOR > 0.0)
            ):
                # Hold Metric3D-seeded geometry in place for the entire run:
                # the prior maps exclude reflective regions, so the PBR stages
                # never fight the prior where it matters, while walls/floaters
                # stay constrained through the final refinement stretch.
                profile_overrides.update({
                    "lambda_depth_prior": f"{DEFAULT_REFGAUSSIAN_LAMBDA_DEPTH_PRIOR:.3f}",
                    "lambda_normal_prior": f"{DEFAULT_REFGAUSSIAN_LAMBDA_NORMAL_PRIOR:.3f}",
                    "lambda_alpha_prior": f"{DEFAULT_REFGAUSSIAN_LAMBDA_ALPHA_PRIOR:.3f}",
                    "depth_prior_front_weight": f"{DEFAULT_REFGAUSSIAN_DEPTH_PRIOR_FRONT_WEIGHT:.2f}",
                    "depth_prior_dir": str(depth_prior_maps_dir),
                    "depth_prior_from_iter": "1000",
                    "depth_prior_until_iter": str(int(effective_iterations)),
                })
        else:
            effective_iterations = max(requested_iterations, BASELINE_REFGAUSSIAN_HEALTHY_ITERATIONS)
            profile_overrides = {}
        return {
            "profile": profile_mode,
            "profileMode": profile_mode,
            "imageCount": image_count,
            "sparsePointCount": sparse_point_count,
            "initPointCount": init_point_count,
            "profilePointCount": profile_point_count,
            "imageScale": 0.0,
            "sparseScale": 0.0,
            "sceneScale": 0.0,
            "baselineSparseScale": max(1.0, float(profile_point_count) / float(BASELINE_REFGAUSSIAN_HEALTHY_SPARSE_POINTS)),
            "baselineInitScale": max(1.0, float(init_point_count) / float(BASELINE_REFGAUSSIAN_HEALTHY_INIT_POINTS)),
            "baselineImageScale": max(1.0, float(max(image_count, 1)) / float(BASELINE_REFGAUSSIAN_HEALTHY_IMAGE_COUNT)),
            "densificationScale": 1.0,
            "expectedFinalPointCount": int(BASELINE_REFGAUSSIAN_HEALTHY_FINAL_POINTS),
            "smoothSceneScale": 0.0,
            "requestedIterations": int(requested_iterations),
            "effectiveIterations": int(effective_iterations),
            "overrides": profile_overrides,
        }
    scene_scales = compute_capture_scene_scales(
        image_count=int(image_count),
        sparse_point_count=int(profile_point_count),
    )
    image_scale = float(scene_scales["imageScale"])
    sparse_scale = float(scene_scales["sparseScale"])
    scene_scale = float(scene_scales["sceneScale"])
    smooth_scene_scale = math.sqrt(scene_scale)
    baseline_sparse_scale = max(1.0, float(profile_point_count) / float(BASELINE_REFGAUSSIAN_HEALTHY_SPARSE_POINTS))
    baseline_init_scale = max(1.0, float(init_point_count) / float(BASELINE_REFGAUSSIAN_HEALTHY_INIT_POINTS))
    baseline_image_scale = max(1.0, float(max(image_count, 1)) / float(BASELINE_REFGAUSSIAN_HEALTHY_IMAGE_COUNT))
    # Large captures should train more like standard 3DGS: modestly longer
    # schedules keyed off geometry complexity, not inflated by view count alone.
    densification_scale = math.sqrt(baseline_sparse_scale)
    extra_iterations = int(round((float(BASELINE_REFGAUSSIAN_HEALTHY_ITERATIONS) * densification_scale) - float(requested_iterations)))

    profile_name = "small_room_default"
    if scene_scale >= 0.7:
        profile_name = "large_room_refgaussian_staged_sparse_first"
    elif scene_scale >= 0.2:
        profile_name = "medium_room_baseline_scaled_density"

    effective_iterations = max(
        requested_iterations,
        min(30000, round_to_step(requested_iterations + max(0, extra_iterations), 1000)),
    )
    overrides: dict[str, str] = {}

    if scene_scale >= 0.7:
        effective_iterations = max(effective_iterations, 30000)
        densify_until_iter = max(
            DEFAULT_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS + 1000,
            int(round(effective_iterations * DEFAULT_REFGAUSSIAN_LARGE_SCENE_DENSIFY_UNTIL_FRACTION)),
        )
        densify_until_iter = min(densify_until_iter, max(effective_iterations - 1000, 1000))
        normal_prop_until_iter = min(
            25000,
            max(densify_until_iter, effective_iterations - 1000),
        )
        overrides = {
            # Large indoor captures do best when we preserve sparse-first init,
            # but return to a traditional RefGaussian schedule: short bootstrap,
            # early densification, then a long deferred/polish tail.
            "initial": "1" if DEFAULT_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS > 0 else "0",
            "init_until_iter": str(DEFAULT_REFGAUSSIAN_LARGE_SCENE_INITIAL_STAGE_ITERATIONS),
            "densify_grad_threshold": f"{DEFAULT_REFGAUSSIAN_LARGE_SCENE_DENSIFY_GRAD_THRESHOLD:.5f}",
            "prune_opacity_threshold": f"{DEFAULT_REFGAUSSIAN_LARGE_SCENE_PRUNE_OPACITY_THRESHOLD:.4f}",
            "percent_dense": f"{DEFAULT_REFGAUSSIAN_LARGE_SCENE_PERCENT_DENSE:.4f}",
            "opacity_reset_interval": str(DEFAULT_REFGAUSSIAN_LARGE_SCENE_OPACITY_RESET_INTERVAL),
            "densify_until_iter": str(densify_until_iter),
            "volume_render_until_iter": "0",
            "indirect_from_iter": str(min(DEFAULT_REFGAUSSIAN_LARGE_SCENE_INDIRECT_FROM_ITER, max(effective_iterations - 2000, 0))),
            "normal_prop_until_iter": str(normal_prop_until_iter),
            "position_lr_max_steps": str(effective_iterations),
        }
    elif smooth_scene_scale >= 0.08:
        overrides = {
            "opacity_reset_interval": str(round_to_step(lerp(3000.0, 4500.0, smooth_scene_scale), 250)),
            "densify_until_iter": str(int(round(effective_iterations * lerp(0.9, 1.0, smooth_scene_scale)))),
            "volume_render_until_iter": str(int(round(effective_iterations * lerp(0.82, 0.9, smooth_scene_scale)))),
            "position_lr_max_steps": str(max(effective_iterations, requested_iterations)),
        }

    return {
        "profile": profile_name,
        "profileMode": profile_mode,
        "imageCount": image_count,
        "sparsePointCount": sparse_point_count,
        "initPointCount": init_point_count,
        "profilePointCount": profile_point_count,
        "imageScale": float(image_scale),
        "sparseScale": float(sparse_scale),
        "sceneScale": float(scene_scale),
        "baselineSparseScale": float(baseline_sparse_scale),
        "baselineInitScale": float(baseline_init_scale),
        "baselineImageScale": float(baseline_image_scale),
        "densificationScale": float(densification_scale),
        "expectedFinalPointCount": int(round(BASELINE_REFGAUSSIAN_HEALTHY_FINAL_POINTS * densification_scale)),
        "smoothSceneScale": float(smooth_scene_scale),
        "requestedIterations": int(requested_iterations),
        "effectiveIterations": int(effective_iterations),
        "overrides": overrides,
    }


def build_training_stages(adaptive_training: dict) -> list[dict]:
    effective_iterations = int(adaptive_training.get("effectiveIterations", 0) or 0)
    base_overrides = dict(adaptive_training.get("overrides") or {})
    image_count = int(adaptive_training.get("imageCount", 0) or 0)
    sparse_point_count = int(adaptive_training.get("sparsePointCount", 0) or 0)
    init_point_count = int(adaptive_training.get("initPointCount", 0) or 0)
    scene_scale = float(adaptive_training.get("sceneScale", 0.0) or 0.0)
    profile_mode = str(adaptive_training.get("profileMode", "") or "")
    init_inflation_ratio = float(init_point_count) / float(max(sparse_point_count, 1))

    default_save_iterations = sorted(
        {
            2500,
            5000,
            *range(7500, effective_iterations + 1, 2500),
            effective_iterations,
        }
    )

    # The staged indoor profiles define their own complete schedule
    # (densify/volume/indirect/normal-prop markers + depth-prior loss). The
    # legacy stabilization stage replaces that with extreme densification
    # settings (percent_dense 0.06, near-zero pruning) and balloons the model
    # 5-7x; it must never fire for these profiles. It previously keyed off
    # init/sparse ratio >= 1.75, which run-to-run SfM variance could flip.
    profile_owns_schedule = profile_mode in {"sfm_only_marginal_indoor", "canonical_bathroom_light"}

    needs_stabilization_stage = (
        not profile_owns_schedule
        and effective_iterations >= 20000
        and (scene_scale >= 0.7 or image_count >= DEFAULT_REFGAUSSIAN_LARGE_SCENE_IMAGE_COUNT)
        and init_point_count >= 150000
        and init_inflation_ratio >= 1.75
    )
    if not needs_stabilization_stage:
        return [
            {
                "name": "single_phase",
                "iterations": effective_iterations,
                "saveIterations": default_save_iterations,
                "checkpointIterations": [],
                "startCheckpoint": None,
                "overrides": base_overrides,
            }
        ]

    stabilization_iterations = min(
        effective_iterations - 2500,
        max(5000, round_to_step(effective_iterations * 0.3, 500)),
    )
    stabilization_overrides = dict(base_overrides)
    stabilization_prune = float(stabilization_overrides.get("prune_opacity_threshold", "0.05"))
    stabilization_percent_dense = float(stabilization_overrides.get("percent_dense", "0.01"))
    stabilization_grad = float(stabilization_overrides.get("densify_grad_threshold", "0.0002"))
    stabilization_overrides.update(
        {
            # Stage 1 is about keeping a strong, high-image-count init cloud
            # intact long enough for multi-view support to accumulate.
            "prune_opacity_threshold": f"{min(stabilization_prune, 0.0025):.4f}",
            "percent_dense": f"{max(stabilization_percent_dense, 0.0600):.4f}",
            "densify_grad_threshold": f"{min(stabilization_grad, 0.00003):.5f}",
            "densify_until_iter": str(int(stabilization_iterations)),
            "volume_render_until_iter": str(int(stabilization_iterations)),
            "position_lr_max_steps": str(effective_iterations),
        }
    )
    checkpoint_name = f"chkpnt{stabilization_iterations}.pth"

    return [
        {
            "name": "stabilize_init_cloud",
            "iterations": stabilization_iterations,
            "saveIterations": [iteration for iteration in default_save_iterations if iteration <= stabilization_iterations],
            "checkpointIterations": [stabilization_iterations],
            "startCheckpoint": None,
            "overrides": stabilization_overrides,
        },
        {
            "name": "densify_and_refine",
            "iterations": effective_iterations,
            "saveIterations": [iteration for iteration in default_save_iterations if iteration > stabilization_iterations],
            "checkpointIterations": [],
            "startCheckpoint": checkpoint_name,
            "overrides": base_overrides,
        },
    ]


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def normalize_quaternion(q: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    return q / np.maximum(norm, 1e-8)


def clamp_anisotropy_for_indices(
    scales: np.ndarray,
    indices: np.ndarray,
    max_ratio: float,
) -> int:
    if indices.size == 0 or max_ratio <= 1.0:
        return 0
    selected = scales[indices]
    largest = np.max(selected, axis=1)
    smallest = np.maximum(np.min(selected, axis=1), 1e-8)
    ratios = largest / smallest
    over_mask = ratios > max_ratio
    if not np.any(over_mask):
        return 0
    over_indices = indices[over_mask]
    largest_values = largest[over_mask]
    min_allowed = largest_values / max_ratio
    current = scales[over_indices]
    scales[over_indices] = np.maximum(current, min_allowed[:, None])
    return int(over_indices.shape[0])


def conservative_cleanup_refgaussian_ply(
    ply_path: Path,
    *,
    opacity_threshold: float = 0.04,
    outer_shell_quantile: float = 0.985,
    low_density_quantile: float = 0.15,
    voxel_size_fraction: float = 0.022,
    outer_shell_opacity_scale: float = 0.78,
    boundary_max_anisotropy_ratio: float = 8.0,
    needle_anisotropy_ratio: float = 20.0,
    needle_opacity_threshold: float = 0.35,
    global_scale_cap_fraction: float = 0.025,
) -> dict:
    from plyfile import PlyData, PlyElement

    ply = PlyData.read(str(ply_path))
    vertex = ply["vertex"]
    names = vertex.data.dtype.names or ()
    xyz = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in ("x", "y", "z")], axis=1)
    if xyz.shape[0] == 0:
        return {
            "applied": False,
            "reason": "empty_point_cloud",
            "originalPointCount": 0,
            "finalPointCount": 0,
            "removedLowOpacity": 0,
            "adjustedOuterShellOpacity": 0,
            "anisotropyClamped": 0,
        }

    log_scales = []
    for axis in ("scale_0", "scale_1", "scale_2"):
        if axis in names:
            log_scales.append(np.asarray(vertex[axis], dtype=np.float32))
    if len(log_scales) < 2:
        return {
            "applied": False,
            "reason": "missing_scale_channels",
            "originalPointCount": int(xyz.shape[0]),
            "finalPointCount": int(xyz.shape[0]),
            "removedLowOpacity": 0,
            "adjustedOuterShellOpacity": 0,
            "anisotropyClamped": 0,
        }
    if len(log_scales) == 2:
        log_scales.append(np.minimum(log_scales[0], log_scales[1]) + math.log(0.05))
    log_scales_arr = np.stack(log_scales[:3], axis=1)
    scales = np.exp(np.clip(log_scales_arr, -20.0, 20.0)).astype(np.float32)
    opacity_logits = np.asarray(vertex["opacity"], dtype=np.float32) if "opacity" in names else np.zeros((xyz.shape[0],), dtype=np.float32)
    opacity = sigmoid(opacity_logits).astype(np.float32)

    original_count = int(xyz.shape[0])
    keep_mask = opacity >= opacity_threshold
    removed_low_opacity = int(np.count_nonzero(~keep_mask))

    # Needle/spike pruning: extreme-anisotropy gaussians with weak opacity are
    # almost always free-space artifacts (the "sparkle" smears), never real
    # surface texture.
    removed_needles = 0
    if needle_anisotropy_ratio > 1.0:
        largest_all = np.max(scales, axis=1)
        smallest_all = np.maximum(np.min(scales, axis=1), 1e-8)
        needle_mask = (
            (largest_all / smallest_all > needle_anisotropy_ratio)
            & (opacity < needle_opacity_threshold)
            & keep_mask
        )
        removed_needles = int(np.count_nonzero(needle_mask))
        keep_mask &= ~needle_mask

    if not np.any(keep_mask):
        return {
            "applied": False,
            "reason": "all_points_below_opacity_threshold",
            "originalPointCount": original_count,
            "finalPointCount": 0,
            "removedLowOpacity": removed_low_opacity,
            "adjustedOuterShellOpacity": 0,
            "anisotropyClamped": 0,
        }

    kept_xyz = xyz[keep_mask]
    bbox_min = kept_xyz.min(axis=0)
    bbox_max = kept_xyz.max(axis=0)
    extent = np.maximum(bbox_max - bbox_min, 1e-4)
    voxel_size = float(max(np.max(extent) * voxel_size_fraction, 0.01))
    voxel_coords = np.floor((kept_xyz - bbox_min) / voxel_size).astype(np.int32)
    _, inverse = np.unique(voxel_coords, axis=0, return_inverse=True)
    voxel_counts = np.bincount(inverse)
    local_density = voxel_counts[inverse].astype(np.float32)
    density_threshold = float(np.quantile(local_density, low_density_quantile))

    center = kept_xyz.mean(axis=0)
    radial_distance = np.linalg.norm(kept_xyz - center[None, :], axis=1)
    radial_threshold = float(np.quantile(radial_distance, outer_shell_quantile))
    shell_mask = radial_distance >= radial_threshold
    low_density_mask = local_density <= max(density_threshold, 1.0)
    shard_candidate_mask = shell_mask & low_density_mask

    kept_indices = np.flatnonzero(keep_mask)
    shard_indices = kept_indices[shard_candidate_mask]
    adjusted_outer_shell_opacity = 0
    if shard_indices.size > 0:
        scaled_opacity = np.clip(opacity[shard_indices] * outer_shell_opacity_scale, 0.0, 0.999999)
        opacity_logits[shard_indices] = np.log(np.maximum(scaled_opacity, 1e-6) / np.maximum(1.0 - scaled_opacity, 1e-6))
        adjusted_outer_shell_opacity = int(shard_indices.shape[0])

    anisotropy_clamped = clamp_anisotropy_for_indices(scales, shard_indices, boundary_max_anisotropy_ratio)

    # Global scale cap: no gaussian may exceed a fraction of the scene diagonal.
    # Directly removes the giant smear/blur artifacts without touching surface
    # detail (real surface gaussians are orders of magnitude smaller).
    global_scale_capped = 0
    if global_scale_cap_fraction > 0.0:
        scene_diagonal = float(np.linalg.norm(bbox_max - bbox_min))
        scale_cap = max(scene_diagonal * global_scale_cap_fraction, 1e-6)
        over_cap_mask = np.any(scales > scale_cap, axis=1) & keep_mask
        global_scale_capped = int(np.count_nonzero(over_cap_mask))
        if global_scale_capped > 0:
            scales[over_cap_mask] = np.minimum(scales[over_cap_mask], scale_cap)

    final_keep_mask = keep_mask
    final_count = int(np.count_nonzero(final_keep_mask))
    filtered = vertex.data[final_keep_mask].copy()
    final_scales = np.log(np.maximum(scales[final_keep_mask], 1e-8))
    for idx, axis in enumerate(("scale_0", "scale_1", "scale_2")):
        if axis in filtered.dtype.names:
            filtered[axis] = final_scales[:, idx].astype(filtered[axis].dtype)
    if "opacity" in filtered.dtype.names:
        filtered["opacity"] = opacity_logits[final_keep_mask].astype(filtered["opacity"].dtype)

    new_elements = []
    replaced_vertex = False
    for element in ply.elements:
        if element.name == "vertex":
            new_elements.append(PlyElement.describe(filtered, "vertex"))
            replaced_vertex = True
        else:
            new_elements.append(element)
    if not replaced_vertex:
        new_elements.append(PlyElement.describe(filtered, "vertex"))
    cleaned_ply = PlyData(new_elements, text=ply.text, byte_order=ply.byte_order, comments=ply.comments)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".ply", dir=str(ply_path.parent)) as tmp:
        tmp_path = Path(tmp.name)
    try:
        cleaned_ply.write(str(tmp_path))
        tmp_path.replace(ply_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

    return {
        "applied": True,
        "reason": None,
        "originalPointCount": original_count,
        "finalPointCount": final_count,
        "removedLowOpacity": removed_low_opacity,
        "removedNeedles": removed_needles,
        "globalScaleCapped": global_scale_capped,
        "adjustedOuterShellOpacity": adjusted_outer_shell_opacity,
        "anisotropyClamped": anisotropy_clamped,
        "opacityThreshold": float(opacity_threshold),
        "outerShellQuantile": float(outer_shell_quantile),
        "lowDensityQuantile": float(low_density_quantile),
        "boundaryMaxAnisotropyRatio": float(boundary_max_anisotropy_ratio),
        "needleAnisotropyRatio": float(needle_anisotropy_ratio),
        "globalScaleCapFraction": float(global_scale_cap_fraction),
    }


def convert_gaussian_ply_to_splat(ply_path: Path, splat_path: Path) -> int:
    """Convert a 3DGS/2DGS-style PLY into HouseYield's 32-byte .splat format."""
    from plyfile import PlyData

    ply = PlyData.read(str(ply_path))
    vertex = ply["vertex"]
    names = {prop.name for prop in vertex.properties}
    required = {"x", "y", "z", "scale_0", "scale_1", "rot_0", "rot_1", "rot_2", "rot_3", "opacity"}
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"refgaussian_ply_missing_properties:{missing}")

    xyz = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in ("x", "y", "z")], axis=1)
    log_scale_0 = np.asarray(vertex["scale_0"], dtype=np.float32)
    log_scale_1 = np.asarray(vertex["scale_1"], dtype=np.float32)
    if "scale_2" in names:
        log_scale_2 = np.asarray(vertex["scale_2"], dtype=np.float32)
    else:
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


def resolve_refgaussian_root(cli_value: str | None) -> Path:
    raw = cli_value or os.environ.get("REFGAUSSIAN_ROOT") or os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_ROOT") or "/opt/ref-gaussian"
    root = Path(raw)
    if not (root / "train.py").exists():
        raise FileNotFoundError(f"refgaussian_train_py_missing:{root / 'train.py'}")
    return root


def ensure_refgaussian_checkpoint_resume_compatibility(refgaussian_root: Path) -> None:
    train_py = refgaussian_root / "train.py"
    old = "torch.load(checkpoint)"
    new = "torch.load(checkpoint, weights_only=False)"

    text = train_py.read_text(encoding="utf-8")
    if new in text:
        return
    if old not in text:
        log("Checkpoint resume patch skipped: resume load pattern not found")
        return

    patched_text = text.replace(old, new, 1)
    try:
        train_py.write_text(patched_text, encoding="utf-8")
        log("Patched RefGaussian resume loader for PyTorch 2.6 compatibility")
        return
    except PermissionError:
        patch_script = (
            "from pathlib import Path\n"
            f"p = Path({str(train_py)!r})\n"
            f"old = {old!r}\n"
            f"new = {new!r}\n"
            "text = p.read_text(encoding='utf-8')\n"
            "if new in text:\n"
            "    raise SystemExit(0)\n"
            "if old not in text:\n"
            "    raise SystemExit(2)\n"
            "p.write_text(text.replace(old, new, 1), encoding='utf-8')\n"
        )
        result = subprocess.run(
            ["sudo", "-n", sys.executable, "-c", patch_script],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            log("Patched RefGaussian resume loader via sudo for PyTorch 2.6 compatibility")
            return
        if result.returncode == 2:
            log("Checkpoint resume patch skipped after sudo: resume load pattern not found")
            return
        raise PermissionError(
            "refgaussian_resume_patch_failed:"
            f"{result.stderr.strip() or result.stdout.strip() or result.returncode}"
        )


def _write_text_with_sudo_fallback(path: Path, text: str, description: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        log(f"Wrote {description}: {path}")
        return
    except PermissionError:
        writer_script = (
            "import sys\n"
            "from pathlib import Path\n"
            f"p = Path({str(path)!r})\n"
            "p.parent.mkdir(parents=True, exist_ok=True)\n"
            "p.write_text(sys.stdin.read(), encoding='utf-8')\n"
        )
        result = subprocess.run(
            ["sudo", "-n", sys.executable, "-c", writer_script],
            input=text,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            log(f"Wrote {description} via sudo: {path}")
            return
        raise PermissionError(
            f"refgaussian_patch_write_failed:{description}:"
            f"{result.stderr.strip() or result.stdout.strip() or result.returncode}"
        )


REFGAUSSIAN_DEPTH_PRIOR_LOSS_VERSION = 3
REFGAUSSIAN_DEPTH_PRIOR_LOSS_MODULE = '''\
"""Metric3D depth/normal prior loss for Ref-Gaussian training.

Injected by HouseYield run_refgaussian_adapter.py (version marker below).
Loads per-image calibrated depth-prior maps (already at SfM/world scale) from
``opt.depth_prior_dir`` and applies:

- masked, front-weighted gradient-aware LogL1 depth loss (free-space carving:
  geometry rendered in front of the prior surface is penalized harder than
  geometry behind it). The LogL1 form compresses large far-surface errors so
  distant geometry does not dominate optimization, and a DN-Splatter style
  RGB-gradient weight down-weights supervision at image edges (where Metric3D
  depth is least reliable) while keeping it strong on flat textureless walls
- alpha coverage loss pulling opacity toward 1 wherever the prior reports a
  surface, so under-densified wall regions fill instead of staying as holes
- optional normal-consistency loss against depth-derived prior normals
- optional world-scale regularization on gaussian scales to suppress
  needle/smear artifacts

Reflective regions (mirror/window/glass + dilation band) are pre-masked at
export time, so none of these terms ever supervise reflections.
"""

from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

DEPTH_PRIOR_LOSS_VERSION = __VERSION__

_PRIOR_CACHE = {}
_WARNED_KEYS = set()
_SCALE_CAP_CACHE = {}


def _warn_once(key, message):
    if key in _WARNED_KEYS:
        return
    _WARNED_KEYS.add(key)
    print(f"[depth_prior_loss] {message}")


def _load_prior(depth_prior_dir, image_name):
    if image_name in _PRIOR_CACHE:
        return _PRIOR_CACHE[image_name]
    prior = None
    path = Path(depth_prior_dir) / (Path(image_name).stem + ".npz")
    if path.exists():
        try:
            with np.load(path) as data:
                depth = torch.from_numpy(np.asarray(data["depth"], dtype=np.float32))
                valid = torch.from_numpy(np.asarray(data["valid"], dtype=bool))
            prior = (depth, valid)
        except Exception as exc:
            _warn_once(f"load:{image_name}", f"failed to load prior {path}: {exc}")
    _PRIOR_CACHE[image_name] = prior
    return prior


def _resolve_scale_cap(gaussians, fraction):
    key = id(gaussians)
    cached = _SCALE_CAP_CACHE.get(key)
    if cached is not None:
        return cached
    with torch.no_grad():
        xyz = gaussians.get_xyz
        if xyz.shape[0] < 100:
            return None
        lo = torch.quantile(xyz, 0.02, dim=0)
        hi = torch.quantile(xyz, 0.98, dim=0)
        diagonal = torch.linalg.norm(hi - lo).item()
    if not np.isfinite(diagonal) or diagonal <= 0.0:
        return None
    cap = float(diagonal) * float(fraction)
    _SCALE_CAP_CACHE[key] = cap
    print(f"[depth_prior_loss] scale regularization cap={cap:.4f} (scene diag={diagonal:.2f})")
    return cap


def compute_scale_regularization(gaussians, opt):
    """World-scale penalty on oversized gaussians. Returns tensor or None."""
    try:
        lambda_scale = float(getattr(opt, "lambda_scale_reg", 0.0) or 0.0)
        fraction = float(getattr(opt, "max_gaussian_scale_fraction", 0.0) or 0.0)
        if lambda_scale <= 0.0 or fraction <= 0.0 or gaussians is None:
            return None
        cap = _resolve_scale_cap(gaussians, fraction)
        if cap is None:
            return None
        scales = gaussians.get_scaling
        excess = F.relu(scales - cap)
        over = excess > 0
        if not bool(over.any()):
            return None
        return lambda_scale * (excess[over] / cap).mean()
    except Exception as exc:
        _warn_once("scale_reg", f"scale regularization disabled after error: {exc}")
        return None


def compute_depth_prior_losses(viewpoint_cam, render_pkg, opt, iteration, gaussians=None):
    """Returns a scalar loss tensor or None when inactive/unavailable."""
    try:
        total = compute_scale_regularization(gaussians, opt)

        lambda_depth = float(getattr(opt, "lambda_depth_prior", 0.0) or 0.0)
        lambda_normal = float(getattr(opt, "lambda_normal_prior", 0.0) or 0.0)
        lambda_alpha = float(getattr(opt, "lambda_alpha_prior", 0.0) or 0.0)
        if lambda_depth <= 0.0 and lambda_normal <= 0.0 and lambda_alpha <= 0.0:
            return total
        depth_prior_dir = str(getattr(opt, "depth_prior_dir", "") or "")
        if not depth_prior_dir:
            return total
        from_iter = int(getattr(opt, "depth_prior_from_iter", 0) or 0)
        until_iter = int(getattr(opt, "depth_prior_until_iter", 0) or 0)
        if until_iter <= 0:
            until_iter = 1 << 30
        if iteration < from_iter or iteration > until_iter:
            return total

        rendered_depth = render_pkg.get("surf_depth")
        if rendered_depth is None:
            return total
        image_name = getattr(viewpoint_cam, "image_name", "")
        prior = _load_prior(depth_prior_dir, image_name)
        if prior is None:
            return total

        prior_depth, prior_valid = prior
        device = rendered_depth.device
        target_h = int(rendered_depth.shape[-2])
        target_w = int(rendered_depth.shape[-1])
        prior_depth_t = prior_depth.to(device=device, non_blocking=True)[None, None]
        prior_valid_t = prior_valid.to(device=device, non_blocking=True)[None, None].float()
        if prior_depth_t.shape[-2:] != (target_h, target_w):
            prior_depth_t = F.interpolate(prior_depth_t, size=(target_h, target_w), mode="nearest")
            prior_valid_t = F.interpolate(prior_valid_t, size=(target_h, target_w), mode="nearest")
        prior_depth_t = prior_depth_t[0]
        prior_ok = (prior_valid_t[0] > 0.5) & (prior_depth_t > 0.0)
        if int(prior_ok.sum().item()) < 128:
            return total

        rend_alpha = render_pkg.get("rend_alpha")

        def add(term):
            nonlocal total
            total = term if total is None else total + term

        # Alpha coverage: wherever the prior reports a surface, accumulated
        # opacity should approach 1. Fills wall holes without needing any
        # photometric gradient there.
        if lambda_alpha > 0.0 and rend_alpha is not None:
            add(lambda_alpha * (1.0 - rend_alpha)[prior_ok].mean())

        # Depth term only where enough surface already renders for surf_depth
        # to be meaningful (alpha gate relaxed from 0.5 -> 0.3 so partially
        # formed walls still receive supervision).
        valid = prior_ok
        if rend_alpha is not None:
            valid = valid & (rend_alpha.detach() > 0.3)

        if lambda_depth > 0.0 and int(valid.sum().item()) >= 128:
            scale = torch.clamp(prior_depth_t[valid].median().detach(), min=1e-3)
            diff = rendered_depth - prior_depth_t
            front_weight = float(getattr(opt, "depth_prior_front_weight", 1.0) or 1.0)
            weights = torch.where(
                diff.detach() < 0.0,
                torch.full_like(diff, front_weight),
                torch.ones_like(diff),
            )

            # DN-Splatter style edge-aware weight: trust the depth prior on flat
            # textureless regions (fills wall holes) but down-weight it where the
            # RGB image has strong gradients (edges), since Metric3D depth is
            # least reliable there and uniform supervision smears detail.
            try:
                gt_image = getattr(viewpoint_cam, "original_image", None)
                if gt_image is not None:
                    gt = gt_image.to(device=device, non_blocking=True)
                    if gt.dim() == 3:
                        gt = gt[None]
                    if gt.shape[-2:] != (target_h, target_w):
                        gt = F.interpolate(gt, size=(target_h, target_w), mode="bilinear", align_corners=False)
                    gray = gt.mean(dim=1, keepdim=True)
                    grad = torch.zeros_like(gray)
                    grad[..., :, 1:] += (gray[..., :, 1:] - gray[..., :, :-1]).abs()
                    grad[..., 1:, :] += (gray[..., 1:, :] - gray[..., :-1, :]).abs()
                    edge_scale = float(getattr(opt, "depth_prior_edge_weight_scale", 10.0) or 0.0)
                    edge_weight = torch.exp(-edge_scale * grad)[0]
                    weights = weights * edge_weight
            except Exception as exc:
                _warn_once("edge_weight", f"edge-aware depth weight disabled: {exc}")

            # LogL1: log(1 + |diff|/scale) compresses large far-surface errors so
            # distant geometry does not dominate the optimizer (vs. raw L1).
            per_pixel = torch.log1p(diff.abs() / scale)
            add(lambda_depth * (weights * per_pixel)[valid].mean())

        if lambda_normal > 0.0 and int(valid.sum().item()) >= 128:
            try:
                from utils.point_utils import depth_to_normal

                prior_normal = depth_to_normal(viewpoint_cam, prior_depth_t).permute(2, 0, 1)
                rend_normal = render_pkg.get("rend_normal")
                if rend_normal is not None:
                    valid_f = valid.float().reshape(1, 1, target_h, target_w)
                    valid_eroded = (-F.max_pool2d(-valid_f, kernel_size=5, stride=1, padding=2))[0, 0] > 0.5
                    if int(valid_eroded.sum().item()) >= 128:
                        normal_term = (1.0 - (rend_normal * prior_normal).sum(dim=0))[valid_eroded].mean()
                        add(lambda_normal * normal_term)
            except Exception as exc:
                _warn_once("normal_prior", f"normal prior loss disabled after error: {exc}")

        return total
    except Exception as exc:
        _warn_once("compute", f"depth prior loss disabled after error: {exc}")
        return None
'''.replace("__VERSION__", str(REFGAUSSIAN_DEPTH_PRIOR_LOSS_VERSION))

REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_V1_BLOCK = (
    "        self.lambda_depth_smooth = 0.0\n"
    "\n"
    "        # HouseYield Metric3D depth-prior supervision (injected by adapter)\n"
    "        self.lambda_depth_prior = 0.0\n"
    "        self.lambda_normal_prior = 0.0\n"
    "        self.depth_prior_dir = \"\"\n"
    "        self.depth_prior_from_iter = 1000\n"
    "        self.depth_prior_until_iter = 0\n"
)

REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_BLOCK = (
    "        self.lambda_depth_smooth = 0.0\n"
    "\n"
    "        # HouseYield Metric3D depth-prior supervision (injected by adapter)\n"
    "        self.lambda_depth_prior = 0.0\n"
    "        self.lambda_normal_prior = 0.0\n"
    "        self.lambda_alpha_prior = 0.0\n"
    "        self.depth_prior_front_weight = 1.0\n"
    "        self.lambda_scale_reg = 0.0\n"
    "        self.max_gaussian_scale_fraction = 0.0\n"
    "        self.depth_prior_dir = \"\"\n"
    "        self.depth_prior_from_iter = 1000\n"
    "        self.depth_prior_until_iter = 0\n"
)

REFGAUSSIAN_TRAIN_LOSS_ANCHOR = (
    "        total_loss, tb_dict = calculate_loss(viewpoint_cam, gaussians, render_pkg, opt, iteration)\n"
)

REFGAUSSIAN_TRAIN_LOSS_HOOK_V1_CALL = (
    "compute_depth_prior_losses(viewpoint_cam, render_pkg, opt, iteration)"
)

REFGAUSSIAN_TRAIN_LOSS_HOOK_CALL = (
    "compute_depth_prior_losses(viewpoint_cam, render_pkg, opt, iteration, gaussians=gaussians)"
)

REFGAUSSIAN_TRAIN_LOSS_HOOK = (
    "        total_loss, tb_dict = calculate_loss(viewpoint_cam, gaussians, render_pkg, opt, iteration)\n"
    f"        depth_prior_loss_value = {REFGAUSSIAN_TRAIN_LOSS_HOOK_CALL}\n"
    "        if depth_prior_loss_value is not None:\n"
    "            total_loss = total_loss + depth_prior_loss_value\n"
)


def ensure_refgaussian_depth_prior_training_support(refgaussian_root: Path) -> None:
    """Idempotently patch the upstream Ref-Gaussian checkout so training accepts
    Metric3D depth-prior supervision flags. Mirrors the resume-compat patch
    pattern: harmless when already applied, sudo fallback for read-only repos."""
    loss_module_path = refgaussian_root / "utils" / "depth_prior_loss.py"
    version_marker = f"DEPTH_PRIOR_LOSS_VERSION = {REFGAUSSIAN_DEPTH_PRIOR_LOSS_VERSION}"
    existing = loss_module_path.read_text(encoding="utf-8") if loss_module_path.exists() else ""
    if version_marker not in existing:
        _write_text_with_sudo_fallback(
            loss_module_path,
            REFGAUSSIAN_DEPTH_PRIOR_LOSS_MODULE,
            "depth prior loss module",
        )

    arguments_path = refgaussian_root / "arguments" / "__init__.py"
    arguments_text = arguments_path.read_text(encoding="utf-8")
    if "lambda_alpha_prior" not in arguments_text:
        if REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_V1_BLOCK in arguments_text:
            # Migrate a v1-patched checkout to the v2 parameter block.
            _write_text_with_sudo_fallback(
                arguments_path,
                arguments_text.replace(
                    REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_V1_BLOCK,
                    REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_BLOCK,
                    1,
                ),
                "depth prior optimization params (v1->v2 migration)",
            )
        else:
            anchor = "        self.lambda_depth_smooth = 0.0\n"
            if anchor not in arguments_text:
                raise RuntimeError("refgaussian_arguments_patch_anchor_missing")
            _write_text_with_sudo_fallback(
                arguments_path,
                arguments_text.replace(anchor, REFGAUSSIAN_ARGUMENTS_DEPTH_PRIOR_BLOCK, 1),
                "depth prior optimization params",
            )

    train_py = refgaussian_root / "train.py"
    train_text = train_py.read_text(encoding="utf-8")
    changed = False
    if "from utils.depth_prior_loss import compute_depth_prior_losses" not in train_text:
        import_anchor = "from utils.loss_utils import calculate_loss, l1_loss\n"
        if import_anchor not in train_text:
            raise RuntimeError("refgaussian_train_import_anchor_missing")
        train_text = train_text.replace(
            import_anchor,
            import_anchor + "from utils.depth_prior_loss import compute_depth_prior_losses\n",
            1,
        )
        changed = True
    if REFGAUSSIAN_TRAIN_LOSS_HOOK_CALL not in train_text:
        if REFGAUSSIAN_TRAIN_LOSS_HOOK_V1_CALL in train_text:
            train_text = train_text.replace(
                REFGAUSSIAN_TRAIN_LOSS_HOOK_V1_CALL,
                REFGAUSSIAN_TRAIN_LOSS_HOOK_CALL,
                1,
            )
            changed = True
        else:
            if REFGAUSSIAN_TRAIN_LOSS_ANCHOR not in train_text:
                raise RuntimeError("refgaussian_train_loss_anchor_missing")
            train_text = train_text.replace(REFGAUSSIAN_TRAIN_LOSS_ANCHOR, REFGAUSSIAN_TRAIN_LOSS_HOOK, 1)
            changed = True
    if changed:
        _write_text_with_sudo_fallback(train_py, train_text, "depth prior train hook")


def run_command(command: list[str], *, cwd: Path, env: dict | None = None) -> None:
    log("$ " + " ".join(shlex.quote(part) for part in command))
    subprocess.run(command, cwd=str(cwd), env=env, check=True)


def find_trained_ply(model_dir: Path, iterations: int) -> Path:
    preferred = model_dir / "point_cloud" / f"iteration_{iterations}" / "point_cloud.ply"
    if preferred.exists():
        return preferred

    candidates = list(model_dir.glob("point_cloud/iteration_*/point_cloud.ply"))
    if candidates:
        def candidate_iteration(path: Path) -> int:
            match = re.search(r"iteration_(\d+)", str(path))
            return int(match.group(1)) if match else -1

        eligible = [path for path in candidates if candidate_iteration(path) <= int(iterations)]
        if eligible:
            return max(eligible, key=candidate_iteration)
        return max(candidates, key=candidate_iteration)
    raise FileNotFoundError(f"refgaussian_output_ply_missing:{preferred}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative_path(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except Exception:
        return str(path)


def file_manifest_entry(path: Path, *, role: str | None = None, copied_to: Path | None = None, root: Path | None = None) -> dict:
    stat = path.stat()
    entry = {
        "path": str(path),
        "relativePath": safe_relative_path(path, root) if root else path.name,
        "size": int(stat.st_size),
        "sha256": sha256_file(path),
        "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if role:
        entry["role"] = role
    if copied_to:
        entry["copiedTo"] = str(copied_to)
    return entry


def directory_manifest_entries(path: Path, *, root: Path | None = None) -> tuple[list[dict], int]:
    entries: list[dict] = []
    total_size = 0
    excluded_dirs = {".git", "__pycache__", ".pytest_cache", "build", "dist", "outputs", "output"}
    for current_root, dirnames, filenames in os.walk(path):
        dirnames[:] = [dirname for dirname in dirnames if dirname not in excluded_dirs]
        current_path = Path(current_root)
        for filename in sorted(filenames):
            source = current_path / filename
            if source.is_symlink() or not source.is_file():
                continue
            try:
                stat = source.stat()
            except OSError:
                continue
            total_size += int(stat.st_size)
            entries.append(file_manifest_entry(source, root=root or path))
    return entries, total_size


def copy_file_for_contract(source: Path, destination: Path, *, role: str, root: Path | None = None) -> dict:
    ensure_dir(destination.parent)
    shutil.copy2(source, destination)
    return file_manifest_entry(source, role=role, copied_to=destination, root=root)


def copy_directory_for_contract(
    source: Path,
    destination: Path,
    *,
    role: str,
    root: Path | None = None,
    max_bytes: int = DEFAULT_NATIVE_RENDER_CONTRACT_MAX_COPY_BYTES,
) -> dict:
    entries, total_size = directory_manifest_entries(source, root=root or source)
    manifest = {
        "path": str(source),
        "relativePath": safe_relative_path(source, root) if root else source.name,
        "role": role,
        "fileCount": len(entries),
        "byteLength": int(total_size),
        "files": entries,
    }
    if total_size > max_bytes:
        manifest.update({
            "copied": False,
            "reason": "directory_exceeds_contract_copy_limit",
            "maxCopyBytes": int(max_bytes),
        })
        return manifest

    if destination.exists():
        shutil.rmtree(destination)
    ensure_dir(destination.parent)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "build", "dist"))
    manifest.update({
        "copied": True,
        "copiedTo": str(destination),
    })
    return manifest


def git_commit_for_path(path: Path) -> str | None:
    if not path.exists():
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return None
    commit = result.stdout.strip()
    return commit if result.returncode == 0 and commit else None


def python_module_spec(python_bin: str, module_name: str) -> dict:
    script = (
        "import importlib.util, json\n"
        f"spec = importlib.util.find_spec({module_name!r})\n"
        "print(json.dumps({"
        "'found': spec is not None, "
        "'origin': getattr(spec, 'origin', None) if spec else None, "
        "'submoduleSearchLocations': list(getattr(spec, 'submodule_search_locations', []) or []) if spec else []"
        "}))\n"
    )
    try:
        result = subprocess.run(
            [python_bin, "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception as exc:
        return {"found": False, "error": str(exc)}
    return {"found": False}


def parse_ply_schema_for_contract(ply_path: Path) -> dict | None:
    if not ply_path.exists():
        return None
    header_lines: list[str] = []
    header_size = 0
    with ply_path.open("rb") as handle:
        while True:
            line = handle.readline()
            if not line:
                return {"path": str(ply_path), "available": False, "reason": "ply_header_incomplete"}
            header_size += len(line)
            text = line.decode("ascii", errors="replace").strip()
            header_lines.append(text)
            if text == "end_header":
                break
    fmt = None
    vertex_count = None
    vertex_properties = []
    current_element = None
    for line in header_lines:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format" and len(parts) >= 2:
            fmt = parts[1]
        elif parts[0] == "element" and len(parts) >= 3:
            current_element = parts[1]
            if current_element == "vertex":
                try:
                    vertex_count = int(parts[2])
                except ValueError:
                    vertex_count = None
        elif parts[0] == "property" and current_element == "vertex" and len(parts) >= 3 and parts[1] != "list":
            vertex_properties.append({"name": parts[2], "type": parts[1]})
    return {
        "path": str(ply_path),
        "available": True,
        "format": fmt,
        "headerSize": int(header_size),
        "vertexCount": vertex_count,
        "vertexPropertyCount": len(vertex_properties),
        "vertexProperties": vertex_properties,
    }


def collect_contract_environment_assets(model_dir: Path) -> list[Path]:
    assets = []
    for pattern in ("**/*env*", "**/*environment*", "**/*cubemap*", "**/*light*"):
        assets.extend(path for path in model_dir.glob(pattern) if path.is_file())
    return sorted(set(assets))


def build_native_render_command(
    *,
    refgaussian_root: Path,
    python_bin: str,
    dataset_dir: Path,
    native_model_dir: Path,
    iterations: int,
) -> list[str]:
    return [
        python_bin,
        str(refgaussian_root / "eval.py"),
        "--model_path", str(native_model_dir),
        "--source_path", str(dataset_dir),
        "--images", "images",
        "--eval",
        "--save_images",
        "--iteration", str(iterations),
    ]


def discover_native_modules(refgaussian_root: Path, python_bin: str, contract_dir: Path) -> dict:
    modules_dir = ensure_dir(contract_dir / "native-modules")
    missing = []
    modules = []
    for module in NATIVE_MODULE_CANDIDATES:
        name = str(module["name"])
        candidate_paths = [refgaussian_root / candidate for candidate in module.get("paths", [])]
        existing_paths = [candidate for candidate in candidate_paths if candidate.exists()]
        spec = python_module_spec(python_bin, str(module.get("pythonModule") or name))
        entry = {
            "name": name,
            "required": bool(module.get("required")),
            "present": bool(existing_paths) or bool(spec.get("found")),
            "candidatePaths": [str(path) for path in candidate_paths],
            "existingPaths": [str(path) for path in existing_paths],
            "pythonModule": spec,
            "gitCommit": git_commit_for_path(existing_paths[0]) if existing_paths else None,
            "copied": False,
        }
        if existing_paths:
            source = existing_paths[0]
            destination = modules_dir / name / source.name
            if source.is_dir():
                copied_manifest = copy_directory_for_contract(
                    source,
                    destination,
                    role=f"{name}_native_module",
                    root=refgaussian_root,
                )
                entry["copyManifest"] = copied_manifest
                entry["copied"] = bool(copied_manifest.get("copied"))
                entry["copiedTo"] = copied_manifest.get("copiedTo")
            elif source.is_file():
                copied = copy_file_for_contract(
                    source,
                    modules_dir / name / source.name,
                    role=f"{name}_native_module",
                    root=refgaussian_root,
                )
                entry["copyManifest"] = copied
                entry["copied"] = True
                entry["copiedTo"] = copied.get("copiedTo")
        elif module.get("required"):
            missing.append({
                "name": name,
                "kind": "native_module",
                "reason": "module_source_not_found",
                "candidatePaths": entry["candidatePaths"],
                "pythonModuleFound": bool(spec.get("found")),
            })
        modules.append(entry)

    manifest = {
        "schemaVersion": 1,
        "modules": modules,
        "missing": missing,
    }
    write_json(modules_dir / "manifest.json", manifest)
    return manifest


def load_refgaussian_bundle_metadata(refgaussian_bundle: dict | None) -> dict | None:
    json_path = refgaussian_bundle.get("jsonPath") if refgaussian_bundle else None
    if not json_path:
        return None
    path = Path(json_path)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def export_refgaussian_native_render_contract(
    *,
    refgaussian_root: Path,
    python_bin: str,
    dataset_dir: Path,
    model_dir: Path,
    output_dir: Path,
    final_dir: Path,
    manifest_path: Path,
    manifest: dict,
    iterations: int,
    source_ply_path: Path,
    splat_ply_path: Path,
    refgaussian_bundle: dict | None,
    native_render_summary: dict | None,
    native_render_error: str | None,
) -> dict:
    contract_dir = output_dir / "native-render-contract"
    if contract_dir.exists():
        shutil.rmtree(contract_dir)
    renderer_files_dir = ensure_dir(contract_dir / "renderer-files")
    assets_dir = ensure_dir(contract_dir / "assets")

    missing_files = []
    copied_sources = []
    for relative_path, role in NATIVE_RENDERER_SOURCE_PATHS:
        source = refgaussian_root / relative_path
        destination = renderer_files_dir / relative_path
        if not source.exists():
            missing_files.append({
                "path": relative_path,
                "kind": "renderer_source",
                "role": role,
                "reason": "missing",
                "expectedPath": str(source),
            })
            continue
        if source.is_dir():
            copied_sources.append(copy_directory_for_contract(source, destination, role=role, root=refgaussian_root))
        else:
            copied_sources.append(copy_file_for_contract(source, destination, role=role, root=refgaussian_root))

    copied_assets = []
    for relative_path, role in NATIVE_RENDERER_ASSET_PATHS:
        source = refgaussian_root / relative_path
        destination = assets_dir / Path(relative_path).name
        if not source.exists():
            missing_files.append({
                "path": relative_path,
                "kind": "renderer_asset",
                "role": role,
                "reason": "missing",
                "expectedPath": str(source),
            })
            continue
        copied_assets.append(copy_file_for_contract(source, destination, role=role, root=refgaussian_root))

    environment_assets = []
    environment_assets_dir = ensure_dir(assets_dir / "model-environment")
    for asset_path in collect_contract_environment_assets(model_dir):
        try:
            relative = safe_relative_path(asset_path, model_dir)
            environment_assets.append(copy_file_for_contract(
                asset_path,
                environment_assets_dir / relative,
                role="model_environment_or_lighting_state",
                root=model_dir,
            ))
        except Exception as exc:
            missing_files.append({
                "path": str(asset_path),
                "kind": "model_environment_asset",
                "reason": f"copy_failed:{exc}",
            })

    native_modules = discover_native_modules(refgaussian_root, python_bin, contract_dir)
    missing_files.extend(native_modules.get("missing", []))

    bundle_metadata = load_refgaussian_bundle_metadata(refgaussian_bundle)
    bundle_arrays = bundle_metadata.get("arrays", []) if bundle_metadata else []
    bundle_array_names = [array.get("name") for array in bundle_arrays]
    expected_render_tensors = [
        "positions",
        "normals",
        "secondaryNormals",
        "shDc",
        "shRest",
        "indirectDc",
        "indirectRest",
        "indirectAsg",
        "opacityLogit",
        "reflectionStrength",
        "metalness",
        "roughness",
        "originalColor",
        "diffuseColor",
        "logScale",
        "rotation",
        "envMap1Base",
        "envMap2Base",
    ]
    point_cloud_files = []
    point_cloud_root = model_dir / "point_cloud"
    if point_cloud_root.exists():
        for point_cloud_path in sorted(point_cloud_root.glob("iteration_*/*")):
            if point_cloud_path.is_file() and point_cloud_path.suffix in {".ply", ".map"}:
                point_cloud_files.append(file_manifest_entry(point_cloud_path, role="refgaussian_checkpoint_state", root=model_dir))
    checkpoint_files = []
    for candidate, role in [
        (model_dir / "cfg_args", "training_and_render_args"),
        (model_dir / "cameras.json", "native_camera_serialization"),
        (model_dir / "input.ply", "initial_point_cloud"),
        (source_ply_path, "native_checkpoint_ply"),
        (splat_ply_path, "published_final_ply"),
        (model_dir / f"test_{int(iterations):06d}.ply", "raytracing_scene_mesh"),
    ]:
        if candidate.exists() and candidate.is_file():
            checkpoint_files.append(file_manifest_entry(candidate, role=role, root=model_dir if str(candidate).startswith(str(model_dir)) else None))
        else:
            missing_files.append({
                "path": str(candidate),
                "kind": "checkpoint_state",
                "role": role,
                "reason": "missing",
            })

    checkpoint_contract = {
        "schemaVersion": 1,
        "modelDir": str(model_dir),
        "sourcePlyPath": str(source_ply_path),
        "publishedPlyPath": str(splat_ply_path),
        "requestedIterations": int(iterations),
        "plySchema": parse_ply_schema_for_contract(source_ply_path),
        "checkpointFiles": checkpoint_files,
        "pointCloudFiles": point_cloud_files,
        "bundle": {
            "available": bool(bundle_metadata),
            "summary": refgaussian_bundle,
            "jsonPath": refgaussian_bundle.get("jsonPath") if refgaussian_bundle else None,
            "binPath": refgaussian_bundle.get("binPath") if refgaussian_bundle else None,
            "arrayNames": bundle_array_names,
            "omittedFields": bundle_metadata.get("omittedFields", []) if bundle_metadata else [],
        },
        "availableRenderTensors": [name for name in expected_render_tensors if name in bundle_array_names],
        "missingRenderTensors": [name for name in expected_render_tensors if name not in bundle_array_names],
    }
    write_json(contract_dir / "checkpoint-contract.json", checkpoint_contract)

    native_model_dir = output_dir / "native-render" / "model"
    render_command = build_native_render_command(
        refgaussian_root=refgaussian_root,
        python_bin=python_bin,
        dataset_dir=dataset_dir,
        native_model_dir=native_model_dir,
        iterations=iterations,
    )
    render_args = {
        "schemaVersion": 1,
        "command": render_command,
        "cwd": str(refgaussian_root),
        "pythonBin": python_bin,
        "pythonPath": [str(refgaussian_root), str(refgaussian_root / "scene" / "renderutils")],
        "datasetDir": str(dataset_dir),
        "modelDir": str(native_model_dir),
        "iterations": int(iterations),
        "nativeRender": native_render_summary,
        "nativeRenderError": native_render_error,
        "cfgArgs": checkpoint_contract["bundle"].get("summary", {}),
    }
    cfg_args_path = model_dir / "cfg_args"
    if cfg_args_path.exists():
        render_args["cfgArgsText"] = cfg_args_path.read_text(encoding="utf-8", errors="replace")
    write_json(contract_dir / "render-args.json", render_args)

    native_render_frames = []
    render_dir = Path(native_render_summary.get("renderDir")) if native_render_summary and native_render_summary.get("renderDir") else None
    if render_dir and render_dir.exists():
        native_render_frames = [
            file_manifest_entry(path, role="native_gallery_rgb_frame", root=render_dir)
            for path in sorted(render_dir.glob("*.png"))
        ]
    camera_payload = {
        "schemaVersion": 1,
        "source": "refgaussian_bundle_metadata" if bundle_metadata else "manifest_and_native_gallery_only",
        "manifestPath": str(manifest_path),
        "sfmTextModelDir": manifest.get("sfmTextModelDir"),
        "datasetDir": str(dataset_dir),
        "nativeGalleryFrames": native_render_frames,
        "cameraCalibration": bundle_metadata.get("cameraCalibration") if bundle_metadata else None,
        "nativeRender": native_render_summary,
    }
    write_json(contract_dir / "cameras.json", camera_payload)

    source_manifest = {
        "schemaVersion": 1,
        "rendererRoot": str(refgaussian_root),
        "rendererGitCommit": git_commit_for_path(refgaussian_root),
        "sources": copied_sources,
        "assets": copied_assets,
        "environmentAssets": environment_assets,
        "missing": missing_files,
    }
    write_json(renderer_files_dir / "source-manifest.json", source_manifest)

    manifest_payload = {
        "schemaVersion": 1,
        "format": "houseyield_refgaussian_native_render_contract",
        "generatedAt": now_iso(),
        "strict": bool(NATIVE_RENDER_CONTRACT_STRICT),
        "contractDir": str(contract_dir),
        "renderer": {
            "root": str(refgaussian_root),
            "gitCommit": git_commit_for_path(refgaussian_root),
            "sourceManifestPath": str(renderer_files_dir / "source-manifest.json"),
            "copiedSourceCount": len(copied_sources),
            "copiedAssetCount": len(copied_assets),
        },
        "renderCommand": render_command,
        "checkpointUsed": str(source_ply_path),
        "nativeGallery": {
            "viewerHtmlPath": native_render_summary.get("viewerHtmlPath") if native_render_summary else None,
            "renderDir": native_render_summary.get("renderDir") if native_render_summary else None,
            "frameCount": native_render_summary.get("frameCount") if native_render_summary else 0,
            "frames": native_render_frames,
        },
        "paths": {
            "manifest": str(contract_dir / "manifest.json"),
            "rendererFiles": str(renderer_files_dir),
            "assets": str(assets_dir),
            "nativeModulesManifest": str(contract_dir / "native-modules" / "manifest.json"),
            "checkpointContract": str(contract_dir / "checkpoint-contract.json"),
            "cameras": str(contract_dir / "cameras.json"),
            "renderArgs": str(contract_dir / "render-args.json"),
        },
        "dependencyChecks": {
            "rendererRootExists": refgaussian_root.exists(),
            "evalPyExists": (refgaussian_root / "eval.py").exists(),
            "bsdfLutExists": (refgaussian_root / "assets" / "bsdf_256_256.bin").exists(),
            "nativeModules": native_modules.get("modules", []),
        },
        "missingFiles": missing_files,
    }
    write_json(contract_dir / "manifest.json", manifest_payload)

    if NATIVE_RENDER_CONTRACT_STRICT and missing_files:
        raise FileNotFoundError(f"refgaussian_native_render_contract_missing:{missing_files}")

    return {
        "applied": True,
        "path": str(contract_dir),
        "manifestPath": str(contract_dir / "manifest.json"),
        "rendererFilesPath": str(renderer_files_dir),
        "assetsPath": str(assets_dir),
        "nativeModulesManifestPath": str(contract_dir / "native-modules" / "manifest.json"),
        "checkpointContractPath": str(contract_dir / "checkpoint-contract.json"),
        "camerasPath": str(contract_dir / "cameras.json"),
        "renderArgsPath": str(contract_dir / "render-args.json"),
        "missingCount": len(missing_files),
        "copiedSourceCount": len(copied_sources),
        "copiedAssetCount": len(copied_assets),
    }


def render_refgaussian_native_views(
    *,
    refgaussian_root: Path,
    python_bin: str,
    dataset_dir: Path,
    model_dir: Path,
    output_dir: Path,
    iterations: int,
) -> dict | None:
    eval_script = refgaussian_root / "eval.py"
    if not eval_script.exists():
        return None

    render_output_dir = ensure_dir(output_dir / "native-render")
    native_model_dir = render_output_dir / "model"
    if native_model_dir.exists():
        shutil.rmtree(native_model_dir)
    ensure_dir(native_model_dir)

    for filename in ("cameras.json", "cfg_args", "input.ply"):
        source = model_dir / filename
        if source.exists():
            shutil.copy2(source, native_model_dir / filename)
    point_cloud_dir = model_dir / "point_cloud"
    if point_cloud_dir.exists():
        shutil.copytree(point_cloud_dir, native_model_dir / "point_cloud", dirs_exist_ok=True)

    # eval.py ray-traces indirect reflections against the extracted scene mesh
    # (test_<iteration>.ply); without it the BVH build fails.
    expected_mesh = model_dir / f"test_{iterations:06d}.ply"
    mesh_candidates = sorted(model_dir.glob("test_*.ply"))
    if expected_mesh.exists():
        shutil.copy2(expected_mesh, native_model_dir / expected_mesh.name)
    elif mesh_candidates:
        latest_mesh = mesh_candidates[-1]
        shutil.copy2(latest_mesh, native_model_dir / f"test_{iterations:06d}.ply")

    env = dict(os.environ)
    renderutils_dir = refgaussian_root / "scene" / "renderutils"
    python_paths = [str(refgaussian_root), str(renderutils_dir)]
    if env.get("PYTHONPATH"):
        python_paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(python_paths)

    command = build_native_render_command(
        refgaussian_root=refgaussian_root,
        python_bin=python_bin,
        dataset_dir=dataset_dir,
        native_model_dir=native_model_dir,
        iterations=iterations,
    )
    run_command(command, cwd=refgaussian_root, env=env)

    rgb_dir = native_model_dir / "test" / "renders" / "rgb"
    normal_dir = native_model_dir / "test" / "renders" / "normal"
    if not rgb_dir.exists():
        return None

    viewer_dir = ensure_dir(render_output_dir / "viewer")
    gallery_dir = ensure_dir(viewer_dir / "renders")
    copied_frames = []
    for image_path in sorted(rgb_dir.glob("*.png")):
        destination = gallery_dir / image_path.name
        shutil.copy2(image_path, destination)
        copied_frames.append(destination.name)

    if normal_dir.exists():
        normal_gallery_dir = ensure_dir(viewer_dir / "normals")
        for image_path in sorted(normal_dir.glob("*.png")):
            shutil.copy2(image_path, normal_gallery_dir / image_path.name)

    html_path = viewer_dir / "index.html"
    html_path.write_text(
        "\n".join([
            "<!doctype html>",
            "<html lang='en'>",
            "<head>",
            "  <meta charset='utf-8'/>",
            "  <meta name='viewport' content='width=device-width, initial-scale=1'/>",
            "  <title>RefGaussian Native Render</title>",
            "  <style>",
            "    body{margin:0;background:#030712;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;}",
            "    header{padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.08);}",
            "    h1{margin:0;font-size:20px;}",
            "    p{margin:6px 0 0;color:rgba(255,255,255,.72);}",
            "    main{padding:16px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));}",
            "    figure{margin:0;background:#0f172a;border:1px solid rgba(255,255,255,.06);border-radius:12px;overflow:hidden;}",
            "    img{display:block;width:100%;height:auto;background:#020617;}",
            "    figcaption{padding:10px 12px;color:rgba(255,255,255,.75);font-size:13px;}",
            "  </style>",
            "</head>",
            "<body>",
            "  <header>",
            "    <h1>RefGaussian Native Render Gallery</h1>",
            "    <p>Official RefGaussian RGB renders for the solved scene cameras. Use this to judge true model fidelity; use the .splat fallback for interactive orbiting.</p>",
            "  </header>",
            "  <main>",
            *[
                f"    <figure><img src='renders/{name}' alt='{name}'/><figcaption>{name}</figcaption></figure>"
                for name in copied_frames
            ],
            "  </main>",
            "</body>",
            "</html>",
        ]),
        encoding="utf-8",
    )

    return {
        "viewerHtmlPath": str(html_path),
        "renderDir": str(gallery_dir),
        "frameCount": len(copied_frames),
        "mode": "native_render_gallery",
        "command": command,
        "nativeModelDir": str(native_model_dir),
        "sourceRgbDir": str(rgb_dir),
        "sourceNormalDir": str(normal_dir) if normal_dir.exists() else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run RefGaussian behind the master_v1 gaussian fork")
    parser.add_argument("--manifest", "--manifest-path", dest="manifest_path", required=True)
    parser.add_argument("--result", "--result-path", dest="result_path", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--refgaussian-root", default="")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--iterations", type=int, default=int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_ITERATIONS", "20000")))
    parser.add_argument("--resolution", type=int, default=int(os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_RESOLUTION", "-1")))
    parser.add_argument("--extra-args", default=os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_EXTRA_ARGS", ""))
    parser.add_argument("--skip-training", action="store_true", default=os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_SKIP_TRAINING", "false").lower() == "true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest_path)
    result_path = Path(args.result_path)
    output_dir = ensure_dir(Path(args.output_dir))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    refgaussian_root = resolve_refgaussian_root(args.refgaussian_root)
    ensure_refgaussian_checkpoint_resume_compatibility(refgaussian_root)
    ensure_refgaussian_depth_prior_training_support(refgaussian_root)

    dataset_dir = output_dir / "refgaussian-dataset"
    model_dir = output_dir / "refgaussian-model"
    dataset_summary = prepare_refgaussian_dataset(manifest, dataset_dir)
    adaptive_training = build_adaptive_training_profile(
        manifest=manifest,
        dataset_summary=dataset_summary,
        requested_iterations=args.iterations,
    )
    if model_dir.exists():
        shutil.rmtree(model_dir)
    ensure_dir(model_dir)

    training_stages = build_training_stages(adaptive_training)
    if not args.skip_training:
        env = dict(os.environ)
        renderutils_dir = refgaussian_root / "scene" / "renderutils"
        python_paths = [str(refgaussian_root), str(renderutils_dir)]
        if env.get("PYTHONPATH"):
            python_paths.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(python_paths)

        for stage in training_stages:
            train_command = [
                args.python,
                str(refgaussian_root / "train.py"),
                "-s", str(dataset_dir),
                "-m", str(model_dir),
                "--iterations", str(int(stage["iterations"])),
                "--save_iterations", *[str(iteration) for iteration in stage["saveIterations"]],
            ]
            checkpoint_iterations = [int(iteration) for iteration in stage.get("checkpointIterations") or []]
            if checkpoint_iterations:
                train_command.extend(["--checkpoint_iterations", *[str(iteration) for iteration in checkpoint_iterations]])
            start_checkpoint = stage.get("startCheckpoint")
            if start_checkpoint:
                checkpoint_path = model_dir / str(start_checkpoint)
                if not checkpoint_path.exists():
                    raise FileNotFoundError(f"refgaussian_checkpoint_missing:{checkpoint_path}")
                train_command.extend(["--start_checkpoint", str(checkpoint_path)])
            if args.resolution != 0:
                train_command.extend(["-r", str(args.resolution)])
            for key, value in dict(stage.get("overrides") or {}).items():
                train_command.extend([f"--{key}", str(value)])
            if args.extra_args.strip():
                train_command.extend(shlex.split(args.extra_args))

            log(
                f"Starting training stage {stage['name']} "
                f"({stage['iterations']} iterations)"
            )
            run_command(train_command, cwd=refgaussian_root, env=env)

    trained_ply = find_trained_ply(model_dir, int(adaptive_training["effectiveIterations"]))
    final_dir = ensure_dir(output_dir / "final")
    splat_ply_path = final_dir / "scene.ply"
    splat_scene_path = final_dir / "scene.splat"
    shutil.copy2(trained_ply, splat_ply_path)
    cleanup_default = (
        "false"
        if str(adaptive_training.get("profileMode", "") or "") == "sfm_only_marginal_indoor"
        else "true"
    )
    cleanup_enabled = (
        os.environ.get("MASTER_PIPELINE_REFGAUSSIAN_CLEANUP", cleanup_default).strip().lower()
        not in {"0", "false", "no", "off"}
    )
    if cleanup_enabled:
        try:
            cleanup_summary = conservative_cleanup_refgaussian_ply(splat_ply_path)
            log(
                "Cleanup: "
                f"{cleanup_summary.get('originalPointCount', 0):,} -> {cleanup_summary.get('finalPointCount', 0):,} "
                f"(lowOpacity={cleanup_summary.get('removedLowOpacity', 0):,}, "
                f"needles={cleanup_summary.get('removedNeedles', 0):,}, "
                f"scaleCapped={cleanup_summary.get('globalScaleCapped', 0):,})"
            )
        except Exception as exc:
            cleanup_summary = {"applied": False, "reason": f"cleanup_failed:{exc}"}
            log(f"Cleanup skipped after failure: {exc}")
    else:
        cleanup_summary = {"applied": False, "reason": "disabled_by_profile_default_or_env"}
    point_count = convert_gaussian_ply_to_splat(splat_ply_path, splat_scene_path)
    refgaussian_bundle = None
    refgaussian_bundle_error = None
    if export_refgaussian_bundle is not None:
        try:
            refgaussian_bundle = export_refgaussian_bundle(
                model_dir=model_dir,
                final_dir=final_dir,
                source_ply_path=trained_ply,
                manifest_path=manifest_path,
                manifest=manifest,
                iterations=int(adaptive_training["effectiveIterations"]),
            )
            log(
                "Exported RefGaussian browser bundle: "
                f"{refgaussian_bundle.get('pointCount', 0):,} gaussians -> "
                f"{refgaussian_bundle.get('jsonPath')}"
            )
        except Exception as exc:
            refgaussian_bundle_error = str(exc)
            log(f"RefGaussian browser bundle export skipped after failure: {exc}")
    elif REFGAUSSIAN_BUNDLE_IMPORT_ERROR is not None:
        refgaussian_bundle_error = f"bundle_helper_import_failed:{REFGAUSSIAN_BUNDLE_IMPORT_ERROR}"

    native_render_summary = None
    native_render_error = None
    try:
        native_render_summary = render_refgaussian_native_views(
            refgaussian_root=refgaussian_root,
            python_bin=args.python,
            dataset_dir=dataset_dir,
            model_dir=model_dir,
            output_dir=output_dir,
            iterations=int(adaptive_training["effectiveIterations"]),
        )
    except Exception as exc:
        native_render_error = str(exc)
        log(f"Native render skipped after failure: {exc}")

    native_render_contract = None
    native_render_contract_error = None
    try:
        native_render_contract = export_refgaussian_native_render_contract(
            refgaussian_root=refgaussian_root,
            python_bin=args.python,
            dataset_dir=dataset_dir,
            model_dir=model_dir,
            output_dir=output_dir,
            final_dir=final_dir,
            manifest_path=manifest_path,
            manifest=manifest,
            iterations=int(adaptive_training["effectiveIterations"]),
            source_ply_path=trained_ply,
            splat_ply_path=splat_ply_path,
            refgaussian_bundle=refgaussian_bundle,
            native_render_summary=native_render_summary,
            native_render_error=native_render_error,
        )
        log(
            "Exported native render contract: "
            f"{native_render_contract.get('copiedSourceCount', 0)} source entries, "
            f"{native_render_contract.get('missingCount', 0)} missing -> "
            f"{native_render_contract.get('manifestPath')}"
        )
    except Exception as exc:
        native_render_contract_error = str(exc)
        log(f"Native render contract export skipped after failure: {exc}")

    result = {
        "success": True,
        "method": "refgaussian_adapter",
        "renderMode": "native_render_gallery" if native_render_summary else "converted_splat_fallback",
        "trainingMaskMode": "metadata_only",
        "adaptiveTraining": adaptive_training,
        "trainingStages": training_stages,
        "dataset": dataset_summary,
        "modelDir": str(model_dir),
        "splatScenePath": str(splat_scene_path),
        "splatPlyPath": str(splat_ply_path),
        "pointCount": point_count,
        "cleanupSummary": cleanup_summary,
        **({"refGaussianBundle": refgaussian_bundle} if refgaussian_bundle else {}),
        **({"refGaussianBundleJsonPath": refgaussian_bundle["jsonPath"]} if refgaussian_bundle else {}),
        **({"refGaussianBundleBinPath": refgaussian_bundle["binPath"]} if refgaussian_bundle else {}),
        **({"refGaussianBundleError": refgaussian_bundle_error} if refgaussian_bundle_error else {}),
        **({"viewerHtmlPath": native_render_summary["viewerHtmlPath"]} if native_render_summary else {}),
        **({"nativeRender": native_render_summary} if native_render_summary else {}),
        **({"nativeRenderError": native_render_error} if native_render_error else {}),
        **({"nativeRenderContract": native_render_contract} if native_render_contract else {}),
        **({"nativeRenderContractPath": native_render_contract["path"]} if native_render_contract else {}),
        **({"nativeRenderContractManifestPath": native_render_contract["manifestPath"]} if native_render_contract else {}),
        **({"nativeRenderContractError": native_render_contract_error} if native_render_contract_error else {}),
    }
    write_json(result_path, result)
    log(f"RefGaussian complete: {point_count:,} gaussians -> {splat_scene_path}")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
