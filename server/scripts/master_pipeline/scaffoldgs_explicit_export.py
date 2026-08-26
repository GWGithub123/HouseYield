#!/usr/bin/env python3
"""Materialize Scaffold-GS checkpoints into explicit browser-viewable gaussians.

This is a compatibility bridge for web viewers that expect explicit gaussians
rather than Scaffold-GS anchor grids plus per-view MLPs. We evaluate the saved
MLPs over a representative subset of solved camera directions, then average the
resulting per-offset color/opacity/covariance into a stable explicit cloud.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

try:
    import torch
except Exception as exc:  # pragma: no cover - exporter only runs where torch exists
    raise RuntimeError("scaffoldgs_explicit_export_requires_torch") from exc

from plyfile import PlyData, PlyElement


def _sorted_property_names(vertex: np.ndarray, prefix: str) -> list[str]:
    return sorted(
        [name for name in (vertex.dtype.names or ()) if name.startswith(prefix)],
        key=lambda value: int(value.split("_")[-1]),
    )


def _load_anchor_state(ply_path: Path) -> dict[str, np.ndarray]:
    ply = PlyData.read(str(ply_path))
    vertex = ply["vertex"]

    xyz = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in ("x", "y", "z")], axis=1)
    feat_names = _sorted_property_names(vertex.data, "f_anchor_feat_")
    offset_names = _sorted_property_names(vertex.data, "f_offset_")
    scale_names = _sorted_property_names(vertex.data, "scale_")
    rot_names = _sorted_property_names(vertex.data, "rot_")

    if not feat_names:
        raise RuntimeError(f"scaffoldgs_anchor_features_missing:{ply_path}")
    if not offset_names:
        raise RuntimeError(f"scaffoldgs_offsets_missing:{ply_path}")
    if len(scale_names) < 6:
        raise RuntimeError(f"scaffoldgs_scale_fields_missing:{ply_path}")
    if len(rot_names) < 4:
        raise RuntimeError(f"scaffoldgs_rotation_fields_missing:{ply_path}")

    anchor_features = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in feat_names], axis=1)
    offsets_raw = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in offset_names], axis=1)
    offsets = offsets_raw.reshape(xyz.shape[0], 3, -1).transpose(0, 2, 1).astype(np.float32)
    log_scaling = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in scale_names[:6]], axis=1)
    base_scaling = np.exp(np.clip(log_scaling, -20.0, 20.0)).astype(np.float32)
    base_rotation = np.stack([np.asarray(vertex[name], dtype=np.float32) for name in rot_names[:4]], axis=1)
    opacity_logit = np.asarray(vertex["opacity"], dtype=np.float32).reshape(-1, 1) if "opacity" in (vertex.data.dtype.names or ()) else np.zeros((xyz.shape[0], 1), dtype=np.float32)

    return {
        "xyz": xyz,
        "anchor_features": anchor_features,
        "offsets": offsets,
        "base_scaling": base_scaling,
        "base_rotation": base_rotation.astype(np.float32),
        "opacity_logit": opacity_logit,
    }


def _load_torchscript_state(module_path: Path) -> dict[str, np.ndarray]:
    module = torch.jit.load(str(module_path), map_location="cpu")
    state = module.state_dict()
    return {
        key: value.detach().cpu().numpy().astype(np.float32)
        for key, value in state.items()
    }


def _load_camera_centers(cameras_json_path: Path, sample_count: int) -> np.ndarray:
    payload = json.loads(cameras_json_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError(f"scaffoldgs_cameras_json_invalid:{cameras_json_path}")
    positions = []
    for camera in payload:
        position = camera.get("position") if isinstance(camera, dict) else None
        if not isinstance(position, list) or len(position) < 3:
            continue
        positions.append([float(position[0]), float(position[1]), float(position[2])])
    if not positions:
        raise RuntimeError(f"scaffoldgs_camera_positions_missing:{cameras_json_path}")
    all_positions = np.asarray(positions, dtype=np.float32)
    if sample_count <= 0 or sample_count >= all_positions.shape[0]:
        return all_positions
    indices = np.linspace(0, all_positions.shape[0] - 1, num=sample_count, dtype=np.int32)
    return all_positions[indices]


def _relu(value: torch.Tensor) -> torch.Tensor:
    return torch.clamp_min(value, 0.0)


def _linear(input_tensor: torch.Tensor, weight: torch.Tensor, bias: torch.Tensor) -> torch.Tensor:
    return input_tensor @ weight.t() + bias


def _run_two_layer_mlp(
    input_tensor: torch.Tensor,
    layer0_weight: torch.Tensor,
    layer0_bias: torch.Tensor,
    layer2_weight: torch.Tensor,
    layer2_bias: torch.Tensor,
    final_activation: str,
) -> torch.Tensor:
    hidden = _relu(_linear(input_tensor, layer0_weight, layer0_bias))
    output = _linear(hidden, layer2_weight, layer2_bias)
    if final_activation == "sigmoid":
        return torch.sigmoid(output)
    if final_activation == "tanh":
        return torch.tanh(output)
    if final_activation == "none":
        return output
    raise RuntimeError(f"unsupported_mlp_activation:{final_activation}")


def _inverse_sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, 1e-5, 1.0 - 1e-5)
    return np.log(clipped / (1.0 - clipped)).astype(np.float32)


def _normalize_quaternion_array(values: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    norms = np.where(norms > 1e-8, norms, 1.0)
    normalized = values / norms
    normalized[normalized[:, 0] < 0.0] *= -1.0
    return normalized.astype(np.float32)


def _camera_cluster_stats(camera_centers: np.ndarray) -> tuple[np.ndarray, float]:
    center = np.mean(camera_centers, axis=0).astype(np.float32)
    radius = float(np.linalg.norm(camera_centers - center[None, :], axis=1).max(initial=0.0))
    return center, radius


def _write_explicit_gaussian_ply(
    output_path: Path,
    *,
    xyz: np.ndarray,
    rgb: np.ndarray,
    opacity_logit: np.ndarray,
    log_scale: np.ndarray,
    rotation: np.ndarray,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    dtype = np.dtype([
        ("x", "f4"),
        ("y", "f4"),
        ("z", "f4"),
        ("red", "u1"),
        ("green", "u1"),
        ("blue", "u1"),
        ("opacity", "f4"),
        ("scale_0", "f4"),
        ("scale_1", "f4"),
        ("scale_2", "f4"),
        ("rot_0", "f4"),
        ("rot_1", "f4"),
        ("rot_2", "f4"),
        ("rot_3", "f4"),
    ])
    payload = np.empty(xyz.shape[0], dtype=dtype)
    payload["x"] = xyz[:, 0]
    payload["y"] = xyz[:, 1]
    payload["z"] = xyz[:, 2]
    payload["red"] = np.clip(np.round(rgb[:, 0] * 255.0), 0, 255).astype(np.uint8)
    payload["green"] = np.clip(np.round(rgb[:, 1] * 255.0), 0, 255).astype(np.uint8)
    payload["blue"] = np.clip(np.round(rgb[:, 2] * 255.0), 0, 255).astype(np.uint8)
    payload["opacity"] = opacity_logit.reshape(-1)
    payload["scale_0"] = log_scale[:, 0]
    payload["scale_1"] = log_scale[:, 1]
    payload["scale_2"] = log_scale[:, 2]
    payload["rot_0"] = rotation[:, 0]
    payload["rot_1"] = rotation[:, 1]
    payload["rot_2"] = rotation[:, 2]
    payload["rot_3"] = rotation[:, 3]
    PlyData([PlyElement.describe(payload, "vertex")], text=False).write(str(output_path))


def export_scaffoldgs_explicit_gaussians(
    *,
    model_dir: Path,
    output_ply_path: Path,
    cameras_json_path: Path,
    sample_cameras: int = 18,
    batch_size: int = 2048,
    opacity_threshold: float = 0.045,
) -> dict:
    point_cloud_dir = model_dir / "point_cloud"
    candidates = sorted(point_cloud_dir.glob("iteration_*/point_cloud.ply"))
    if not candidates:
        raise FileNotFoundError(f"scaffoldgs_point_cloud_missing:{point_cloud_dir}")
    source_ply_path = candidates[-1]

    anchor_state = _load_anchor_state(source_ply_path)
    camera_centers = _load_camera_centers(cameras_json_path, sample_cameras)

    opacity_state = _load_torchscript_state(source_ply_path.parent / "opacity_mlp.pt")
    cov_state = _load_torchscript_state(source_ply_path.parent / "cov_mlp.pt")
    color_state = _load_torchscript_state(source_ply_path.parent / "color_mlp.pt")

    feat_dim = int(anchor_state["anchor_features"].shape[1])
    n_offsets = int(anchor_state["offsets"].shape[1])
    opacity_input_dim = int(opacity_state["0.weight"].shape[1])
    if opacity_input_dim != feat_dim + 3:
        raise RuntimeError(
            f"unsupported_scaffoldgs_export_input_dim:{opacity_input_dim}:expected:{feat_dim + 3}"
        )
    if int(opacity_state["2.weight"].shape[0]) != n_offsets:
        raise RuntimeError(f"scaffoldgs_offset_count_mismatch:{opacity_state['2.weight'].shape[0]}!={n_offsets}")
    if int(cov_state["2.weight"].shape[0]) != n_offsets * 7:
        raise RuntimeError(f"scaffoldgs_cov_output_mismatch:{cov_state['2.weight'].shape[0]}!={n_offsets * 7}")
    if int(color_state["2.weight"].shape[0]) != n_offsets * 3:
        raise RuntimeError(f"scaffoldgs_color_output_mismatch:{color_state['2.weight'].shape[0]}!={n_offsets * 3}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    anchors = torch.from_numpy(anchor_state["xyz"]).to(device=device, dtype=torch.float32)
    features = torch.from_numpy(anchor_state["anchor_features"]).to(device=device, dtype=torch.float32)
    offsets = torch.from_numpy(anchor_state["offsets"]).to(device=device, dtype=torch.float32)
    base_scaling = torch.from_numpy(anchor_state["base_scaling"]).to(device=device, dtype=torch.float32)
    camera_tensor = torch.from_numpy(camera_centers).to(device=device, dtype=torch.float32)

    opacity_w0 = torch.from_numpy(opacity_state["0.weight"]).to(device=device)
    opacity_b0 = torch.from_numpy(opacity_state["0.bias"]).to(device=device)
    opacity_w2 = torch.from_numpy(opacity_state["2.weight"]).to(device=device)
    opacity_b2 = torch.from_numpy(opacity_state["2.bias"]).to(device=device)

    cov_w0 = torch.from_numpy(cov_state["0.weight"]).to(device=device)
    cov_b0 = torch.from_numpy(cov_state["0.bias"]).to(device=device)
    cov_w2 = torch.from_numpy(cov_state["2.weight"]).to(device=device)
    cov_b2 = torch.from_numpy(cov_state["2.bias"]).to(device=device)

    color_w0 = torch.from_numpy(color_state["0.weight"]).to(device=device)
    color_b0 = torch.from_numpy(color_state["0.bias"]).to(device=device)
    color_w2 = torch.from_numpy(color_state["2.weight"]).to(device=device)
    color_b2 = torch.from_numpy(color_state["2.bias"]).to(device=device)

    explicit_xyz_parts: list[np.ndarray] = []
    explicit_rgb_parts: list[np.ndarray] = []
    explicit_opacity_parts: list[np.ndarray] = []
    explicit_scale_parts: list[np.ndarray] = []
    explicit_rotation_parts: list[np.ndarray] = []

    with torch.no_grad():
        total = anchors.shape[0]
        for start in range(0, total, batch_size):
            end = min(total, start + batch_size)
            anchor_batch = anchors[start:end]
            feature_batch = features[start:end]
            offset_batch = offsets[start:end]
            scaling_batch = base_scaling[start:end]

            weighted_opacity = torch.zeros((end - start, n_offsets), dtype=torch.float32, device=device)
            weighted_color = torch.zeros((end - start, n_offsets, 3), dtype=torch.float32, device=device)
            weighted_scale = torch.zeros((end - start, n_offsets, 3), dtype=torch.float32, device=device)
            weighted_rotation = torch.zeros((end - start, n_offsets, 4), dtype=torch.float32, device=device)

            for camera_center in camera_tensor:
                ob_view = anchor_batch - camera_center.unsqueeze(0)
                ob_view = ob_view / torch.clamp(ob_view.norm(dim=1, keepdim=True), min=1e-6)
                mlp_input = torch.cat([feature_batch, ob_view], dim=1)

                opacity = _run_two_layer_mlp(
                    mlp_input,
                    opacity_w0,
                    opacity_b0,
                    opacity_w2,
                    opacity_b2,
                    "tanh",
                ).reshape(-1, n_offsets)
                positive = torch.clamp_min(opacity, 0.0)
                if torch.count_nonzero(positive) == 0:
                    continue

                color = _run_two_layer_mlp(
                    mlp_input,
                    color_w0,
                    color_b0,
                    color_w2,
                    color_b2,
                    "sigmoid",
                ).reshape(-1, n_offsets, 3)
                cov = _run_two_layer_mlp(
                    mlp_input,
                    cov_w0,
                    cov_b0,
                    cov_w2,
                    cov_b2,
                    "none",
                ).reshape(-1, n_offsets, 7)
                scale = scaling_batch[:, None, 3:6] * torch.sigmoid(cov[:, :, :3])
                rotation = torch.nn.functional.normalize(cov[:, :, 3:7], dim=2)
                rotation = torch.where(rotation[:, :, :1] < 0.0, -rotation, rotation)

                weight = positive.unsqueeze(-1)
                weighted_opacity += positive
                weighted_color += color * weight
                weighted_scale += scale * weight
                weighted_rotation += rotation * weight

            mean_opacity = weighted_opacity / float(camera_tensor.shape[0])
            keep_mask = mean_opacity > float(opacity_threshold)
            if torch.count_nonzero(keep_mask) == 0:
                continue

            safe_weight = torch.clamp_min(weighted_opacity.unsqueeze(-1), 1e-6)
            mean_color = weighted_color / safe_weight
            mean_scale = weighted_scale / safe_weight
            mean_rotation = torch.nn.functional.normalize(weighted_rotation / safe_weight, dim=2)
            mean_rotation = torch.where(mean_rotation[:, :, :1] < 0.0, -mean_rotation, mean_rotation)
            xyz = anchor_batch[:, None, :] + (offset_batch * scaling_batch[:, None, :3])

            explicit_xyz_parts.append(xyz[keep_mask].detach().cpu().numpy().astype(np.float32))
            explicit_rgb_parts.append(mean_color[keep_mask].detach().cpu().numpy().astype(np.float32))
            explicit_opacity_parts.append(mean_opacity[keep_mask].detach().cpu().numpy().astype(np.float32))
            explicit_scale_parts.append(mean_scale[keep_mask].detach().cpu().numpy().astype(np.float32))
            explicit_rotation_parts.append(mean_rotation[keep_mask].detach().cpu().numpy().astype(np.float32))

    if not explicit_xyz_parts:
        raise RuntimeError("scaffoldgs_explicit_export_empty")

    explicit_xyz = np.concatenate(explicit_xyz_parts, axis=0)
    explicit_rgb = np.clip(np.concatenate(explicit_rgb_parts, axis=0), 0.0, 1.0)
    explicit_opacity = np.clip(np.concatenate(explicit_opacity_parts, axis=0).reshape(-1, 1), 1e-5, 0.99999)
    explicit_scale = np.clip(np.concatenate(explicit_scale_parts, axis=0), 1e-6, None)
    explicit_rotation = _normalize_quaternion_array(np.concatenate(explicit_rotation_parts, axis=0))

    camera_center, camera_radius = _camera_cluster_stats(camera_centers)
    point_distance = np.linalg.norm(explicit_xyz - camera_center[None, :], axis=1)
    max_distance = max(camera_radius * 3.0, 12.0)
    inlier_mask = point_distance <= max_distance
    removed_outliers = int(np.count_nonzero(~inlier_mask))
    if np.count_nonzero(inlier_mask) > 0:
        explicit_xyz = explicit_xyz[inlier_mask]
        explicit_rgb = explicit_rgb[inlier_mask]
        explicit_opacity = explicit_opacity[inlier_mask]
        explicit_scale = explicit_scale[inlier_mask]
        explicit_rotation = explicit_rotation[inlier_mask]

    robust_min = np.quantile(explicit_xyz, 0.01, axis=0)
    robust_max = np.quantile(explicit_xyz, 0.99, axis=0)
    robust_diag = float(np.linalg.norm(robust_max - robust_min))
    max_reasonable_scale = max(robust_diag * 0.02, 0.12)
    clamped_scale = np.minimum(explicit_scale, max_reasonable_scale)
    scale_clamp_count = int(np.count_nonzero(np.any(clamped_scale < explicit_scale, axis=1)))
    explicit_scale = clamped_scale

    explicit_log_scale = np.log(explicit_scale).astype(np.float32)
    explicit_opacity_logit = _inverse_sigmoid(explicit_opacity)
    _write_explicit_gaussian_ply(
        output_ply_path,
        xyz=explicit_xyz,
        rgb=explicit_rgb,
        opacity_logit=explicit_opacity_logit,
        log_scale=explicit_log_scale,
        rotation=explicit_rotation,
    )

    return {
        "applied": True,
        "sourcePlyPath": str(source_ply_path),
        "outputPlyPath": str(output_ply_path),
        "anchorCount": int(anchor_state["xyz"].shape[0]),
        "explicitPointCount": int(explicit_xyz.shape[0]),
        "sampleCameraCount": int(camera_tensor.shape[0]),
        "sampleOpacityThreshold": float(opacity_threshold),
        "nOffsets": int(n_offsets),
        "featDim": int(feat_dim),
        "device": str(device),
        "cameraClusterCenter": camera_center.astype(float).tolist(),
        "cameraClusterRadius": float(camera_radius),
        "maxRetainedDistance": float(max_distance),
        "removedDistanceOutliers": int(removed_outliers),
        "robustBounds": {
            "q01": robust_min.astype(float).tolist(),
            "q99": robust_max.astype(float).tolist(),
            "diag": float(robust_diag),
        },
        "maxReasonableScale": float(max_reasonable_scale),
        "clampedScaleCount": int(scale_clamp_count),
        "colorRange": {
            "min": explicit_rgb.min(axis=0).astype(float).tolist(),
            "max": explicit_rgb.max(axis=0).astype(float).tolist(),
        },
        "opacityRange": {
            "min": float(explicit_opacity.min()),
            "max": float(explicit_opacity.max()),
            "mean": float(explicit_opacity.mean()),
        },
    }
