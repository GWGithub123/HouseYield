#!/usr/bin/env python3
"""Export and validate browser-facing Ref-Gaussian attribute bundles.

The bundle is intentionally conservative: it copies only fields that are present
in the saved Ref-Gaussian PLY and preserves sidecar renderer state with checksums.
Rendering-specific interpretation is documented as an explicit native renderer
contract so browser/reference renderers do not silently invent missing fields.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import tempfile
from pathlib import Path
from typing import BinaryIO

import numpy as np

try:
    import torch
except Exception:  # pragma: no cover - torch is optional for non-env validation
    torch = None


BUNDLE_MAGIC = b"HYRGREF1"
BUNDLE_VERSION = 1
BUNDLE_HEADER_STRUCT = struct.Struct("<8sII")
BUNDLE_HEADER_SIZE = BUNDLE_HEADER_STRUCT.size

PLY_NUMPY_TYPES = {
    "char": "i1",
    "int8": "i1",
    "uchar": "u1",
    "uint8": "u1",
    "short": "<i2",
    "int16": "<i2",
    "ushort": "<u2",
    "uint16": "<u2",
    "int": "<i4",
    "int32": "<i4",
    "uint": "<u4",
    "uint32": "<u4",
    "float": "<f4",
    "float32": "<f4",
    "double": "<f8",
    "float64": "<f8",
}

PLY_FIELD_GROUPS = [
    ("positions", ["x", "y", "z"], "float32", "World-space Gaussian centers from the checkpoint PLY."),
    ("normals", ["nx", "ny", "nz"], "float32", "Primary Ref-Gaussian normals."),
    ("secondaryNormals", ["nx2", "ny2", "nz2"], "float32", "Secondary Ref-Gaussian normals, if trained."),
    ("shDc", ["f_dc_0", "f_dc_1", "f_dc_2"], "float32", "Direct color spherical-harmonic DC terms."),
    ("shRest", [f"f_rest_{idx}" for idx in range(45)], "float32", "Direct color higher-order spherical-harmonic terms."),
    ("indirectDc", ["ind_dc_0", "ind_dc_1", "ind_dc_2"], "float32", "Indirect lighting spherical-harmonic DC terms."),
    ("indirectRest", [f"ind_rest_{idx}" for idx in range(45)], "float32", "Indirect lighting higher-order spherical-harmonic terms."),
    ("indirectAsg", [f"ind_asg_{idx}" for idx in range(160)], "float32", "Anisotropic spherical Gaussian indirect-lighting coefficients."),
    ("opacityLogit", ["opacity"], "float32", "Opacity logits exactly as saved by Ref-Gaussian."),
    ("reflectionStrength", ["refl_strength"], "float32", "Per-Gaussian reflection strength."),
    ("metalness", ["metalness"], "float32", "Per-Gaussian metalness."),
    ("roughness", ["roughness"], "float32", "Per-Gaussian roughness."),
    ("originalColor", ["ori_color_0", "ori_color_1", "ori_color_2"], "float32", "Original/albedo color fields from Ref-Gaussian."),
    ("diffuseColor", ["diffuse_color_0", "diffuse_color_1", "diffuse_color_2"], "float32", "Diffuse color fields from Ref-Gaussian."),
    ("logScale3D", ["scale_0", "scale_1", "scale_2"], "float32", "Full 3D log Gaussian scale fields when present in the checkpoint PLY."),
    ("logScale", ["scale_0", "scale_1"], "float32", "Log Gaussian scale fields present in the checkpoint PLY."),
    ("rotation", ["rot_0", "rot_1", "rot_2", "rot_3"], "float32", "Quaternion rotation fields."),
]

REFERENCE_RENDERER_TODO = {
    "status": "native_contract_exported_partial_webgpu_port",
    "reason": "The browser renderer can consume exported Gaussian geometry/material fields and native EnvLight.base tensors, but exact native Ref-Gaussian parity still needs the CUDA surfel rasterizer allmap outputs plus nvdiffrast BSDF LUT/mip filtering and raytraced indirect visibility equations.",
    "nativeRenderDependencies": [
        "eval.py render_sets -> render_set -> gaussian_renderer.render_surfel",
        "diff_surfel_rasterization GaussianRasterizer allmap depth/alpha/normal outputs",
        "utils.refl_utils.get_specular_color_surfel",
        "scene.light.EnvLight mipmapped cubemap sampling",
        "assets/bsdf_256_256.bin split-sum BRDF LUT",
        "raytracing against test_<iteration>.ply for indirect visibility",
        "camera split/eval ordering used by eval.py for native render gallery comparisons",
        "reference image selection and metric thresholds for native render comparisons",
    ],
}


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, payload: dict) -> None:
    ensure_dir(path.parent)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=str(path.parent), encoding="utf-8") as handle:
        tmp_path = Path(handle.name)
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    tmp_path.replace(path)
    path.chmod(0o644)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file_into_bundle(source_path: Path, bundle_handle: BinaryIO) -> tuple[int, int, str]:
    offset = bundle_handle.tell()
    digest = hashlib.sha256()
    size = 0
    with source_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            bundle_handle.write(chunk)
            digest.update(chunk)
            size += len(chunk)
    return offset, size, digest.hexdigest()


def write_float32_array(
    *,
    bundle_handle: BinaryIO,
    name: str,
    array: np.ndarray,
    source: str,
    description: str,
    properties: list[str] | None = None,
    extra: dict | None = None,
) -> dict:
    offset = bundle_handle.tell()
    array = np.ascontiguousarray(array, dtype="<f4")
    array.tofile(bundle_handle)
    payload = {
        "name": name,
        "kind": "array",
        "source": source,
        "description": description,
        "dtype": "float32",
        "endianness": "little",
        "shape": [int(dim) for dim in array.shape],
        "offset": int(offset),
        "byteLength": int(array.nbytes),
    }
    if properties:
        payload["properties"] = properties
    if extra:
        payload.update(extra)
    return payload


def parse_ply_header(ply_path: Path) -> dict:
    header_lines: list[str] = []
    header_size = 0
    with ply_path.open("rb") as handle:
        while True:
            line = handle.readline()
            if not line:
                raise ValueError(f"ply_header_incomplete:{ply_path}")
            header_size += len(line)
            text = line.decode("ascii", errors="replace").strip()
            header_lines.append(text)
            if text == "end_header":
                break

    if not header_lines or header_lines[0] != "ply":
        raise ValueError(f"ply_magic_missing:{ply_path}")

    fmt = None
    vertex_count = None
    vertex_properties: list[tuple[str, str]] = []
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
                vertex_count = int(parts[2])
        elif parts[0] == "property" and current_element == "vertex":
            if len(parts) >= 3 and parts[1] != "list":
                ply_type = parts[1]
                property_name = parts[2]
                if ply_type not in PLY_NUMPY_TYPES:
                    raise ValueError(f"unsupported_ply_property_type:{ply_type}:{property_name}")
                vertex_properties.append((property_name, PLY_NUMPY_TYPES[ply_type]))
            else:
                raise ValueError(f"unsupported_vertex_list_property:{line}")

    if fmt != "binary_little_endian":
        raise ValueError(f"unsupported_ply_format:{fmt}")
    if vertex_count is None:
        raise ValueError(f"ply_vertex_element_missing:{ply_path}")

    dtype = np.dtype(vertex_properties)
    return {
        "format": fmt,
        "headerSize": header_size,
        "headerLines": header_lines,
        "vertexCount": int(vertex_count),
        "vertexProperties": [{"name": name, "dtype": str(np.dtype(dtype_str))} for name, dtype_str in vertex_properties],
        "numpyDtype": dtype,
    }


def open_ply_vertices(ply_path: Path, ply_info: dict) -> np.memmap:
    return np.memmap(
        str(ply_path),
        dtype=ply_info["numpyDtype"],
        mode="r",
        offset=int(ply_info["headerSize"]),
        shape=(int(ply_info["vertexCount"]),),
    )


def parse_iteration_from_path(path: Path) -> int | None:
    match = re.search(r"iteration_(\d+)", str(path))
    return int(match.group(1)) if match else None


def find_refgaussian_point_cloud_ply(model_dir: Path, iterations: int | None = None) -> Path:
    if iterations is not None:
        preferred = model_dir / "point_cloud" / f"iteration_{iterations}" / "point_cloud.ply"
        if preferred.exists():
            return preferred

    candidates = list(model_dir.glob("point_cloud/iteration_*/point_cloud.ply"))
    if not candidates:
        raise FileNotFoundError(f"refgaussian_point_cloud_ply_missing:{model_dir}")
    if iterations is not None:
        eligible = [
            path for path in candidates
            if (parse_iteration_from_path(path) or -1) <= int(iterations)
        ]
        if eligible:
            return max(eligible, key=lambda path: parse_iteration_from_path(path) or -1)
    return max(candidates, key=lambda path: parse_iteration_from_path(path) or -1)


def parse_colmap_cameras(cameras_path: Path) -> list[dict]:
    cameras = []
    if not cameras_path.exists():
        return cameras
    with cameras_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            if len(parts) < 5:
                continue
            cameras.append({
                "cameraId": int(parts[0]),
                "model": parts[1],
                "width": int(parts[2]),
                "height": int(parts[3]),
                "params": [float(value) for value in parts[4:]],
            })
    return cameras


def parse_colmap_images(images_path: Path) -> list[dict]:
    images = []
    if not images_path.exists():
        return images
    with images_path.open("r", encoding="utf-8", errors="replace") as handle:
        while True:
            line = handle.readline()
            if not line:
                break
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            if len(parts) < 10:
                continue
            try:
                image_id = int(parts[0])
                qvec = [float(value) for value in parts[1:5]]
                tvec = [float(value) for value in parts[5:8]]
                camera_id = int(parts[8])
            except ValueError:
                continue
            images.append({
                "imageId": image_id,
                "qvec": qvec,
                "tvec": tvec,
                "cameraId": camera_id,
                "name": " ".join(parts[9:]),
            })
            # The next COLMAP line contains all 2D observations and can be very
            # large; calibration only needs the camera pose line.
            handle.readline()
    return images


def qvec_to_rotmat(qvec: list[float]) -> list[list[float]]:
    qw, qx, qy, qz = qvec
    return [
        [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
        [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
        [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy],
    ]


def mat3_transpose(matrix: list[list[float]]) -> list[list[float]]:
    return [[matrix[row][col] for row in range(3)] for col in range(3)]


def mat3_vec_mul(matrix: list[list[float]], vector: list[float]) -> list[float]:
    return [
        matrix[row][0] * vector[0] + matrix[row][1] * vector[1] + matrix[row][2] * vector[2]
        for row in range(3)
    ]


def augment_camera_image_metadata(images: list[dict]) -> list[dict]:
    augmented = []
    for image in images:
        qvec = image.get("qvec") or []
        tvec = image.get("tvec") or []
        if len(qvec) != 4 or len(tvec) != 3:
            augmented.append(image)
            continue

        rotation = qvec_to_rotmat([float(value) for value in qvec])
        rotation_t = mat3_transpose(rotation)
        camera_center = [-value for value in mat3_vec_mul(rotation_t, [float(value) for value in tvec])]
        world_to_camera = [
            [rotation[0][0], rotation[0][1], rotation[0][2], float(tvec[0])],
            [rotation[1][0], rotation[1][1], rotation[1][2], float(tvec[1])],
            [rotation[2][0], rotation[2][1], rotation[2][2], float(tvec[2])],
            [0.0, 0.0, 0.0, 1.0],
        ]
        camera_to_world = [
            [rotation_t[0][0], rotation_t[0][1], rotation_t[0][2], camera_center[0]],
            [rotation_t[1][0], rotation_t[1][1], rotation_t[1][2], camera_center[1]],
            [rotation_t[2][0], rotation_t[2][1], rotation_t[2][2], camera_center[2]],
            [0.0, 0.0, 0.0, 1.0],
        ]
        augmented.append({
            **image,
            "rotationMatrixWorldToCamera": rotation,
            "worldToCamera": world_to_camera,
            "cameraToWorld": camera_to_world,
            "cameraCenter": camera_center,
            "cameraForward": [rotation[2][0], rotation[2][1], rotation[2][2]],
        })
    return augmented


def load_manifest(manifest_path: Path | None) -> dict | None:
    if not manifest_path or not manifest_path.exists():
        return None
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def build_camera_metadata(manifest: dict | None, explicit_sfm_text_model_dir: Path | None = None) -> dict:
    sfm_text_model_dir = explicit_sfm_text_model_dir
    if sfm_text_model_dir is None and manifest:
        raw_dir = manifest.get("sfmTextModelDir")
        sfm_text_model_dir = Path(raw_dir) if raw_dir else None

    if not sfm_text_model_dir:
        return {
            "available": False,
            "reason": "sfm_text_model_dir_missing",
            "cameras": [],
            "images": [],
        }

    cameras_path = sfm_text_model_dir / "cameras.txt"
    images_path = sfm_text_model_dir / "images.txt"
    cameras = parse_colmap_cameras(cameras_path)
    images = augment_camera_image_metadata(parse_colmap_images(images_path))
    sorted_eval_images = sorted(images, key=lambda image: Path(str(image.get("name", ""))).stem)
    llffhold = 8
    native_test_images = [
        {**image, "nativeRenderFrame": f"{frame_index:05d}.png", "evalSortedIndex": int(eval_index)}
        for frame_index, (eval_index, image) in enumerate(
            (item for item in enumerate(sorted_eval_images) if item[0] % llffhold == 0)
        )
    ]
    native_train_images = [
        {**image, "evalSortedIndex": int(eval_index)}
        for eval_index, image in enumerate(sorted_eval_images)
        if eval_index % llffhold != 0
    ]
    return {
        "available": bool(cameras and images),
        "reason": None if cameras and images else "colmap_camera_or_image_file_missing_or_empty",
        "sourceDir": str(sfm_text_model_dir),
        "camerasPath": str(cameras_path) if cameras_path.exists() else None,
        "imagesPath": str(images_path) if images_path.exists() else None,
        "cameraCount": len(cameras),
        "imageCount": len(images),
        "cameras": cameras,
        "images": images,
        "nativeEvalSplit": {
            "source": "upstream dataset_readers.readColmapSceneInfo(eval=True, llffhold=8)",
            "sortKey": "image_name",
            "llffhold": llffhold,
            "testImageCount": len(native_test_images),
            "trainImageCount": len(native_train_images),
            "testImages": native_test_images,
        },
    }


def detect_sidecar_map_files(source_ply_path: Path) -> list[Path]:
    point_cloud_dir = source_ply_path.parent
    return [point_cloud_dir / name for name in ("point_cloud1.map", "point_cloud2.map") if (point_cloud_dir / name).exists()]


def detect_environment_files(model_dir: Path) -> list[Path]:
    env_files = []
    for pattern in ("**/*env*", "**/*environment*", "**/*cubemap*", "**/*light*"):
        env_files.extend(path for path in model_dir.glob(pattern) if path.is_file())
    return sorted(set(env_files))


def load_envlight_base_tensor(map_path: Path) -> np.ndarray | None:
    if torch is None or not map_path.exists():
        return None
    state = torch.load(map_path, map_location="cpu")
    base = state.get("base") if isinstance(state, dict) else None
    if base is None:
        return None
    return base.detach().cpu().numpy().astype("<f4", copy=False)


def summarize_ply_group(vertices: np.memmap, properties: list[str], sample_count: int = 2048) -> dict | None:
    names = set(vertices.dtype.names or ())
    if any(name not in names for name in properties):
        return None
    count = int(vertices.shape[0])
    if count == 0:
        return {
            "sampleCount": 0,
            "min": None,
            "max": None,
            "meanAbs": None,
            "allZero": True,
        }
    sample_indices = np.unique(np.linspace(0, count - 1, min(sample_count, count), dtype=np.int64))
    values = np.stack(
        [np.asarray(vertices[name][sample_indices], dtype="<f4") for name in properties],
        axis=1,
    )
    return {
        "sampleCount": int(sample_indices.shape[0]),
        "min": float(np.nanmin(values)),
        "max": float(np.nanmax(values)),
        "meanAbs": float(np.nanmean(np.abs(values))),
        "allZero": bool(np.allclose(values, 0.0)),
    }


def build_native_renderer_state_metadata(
    *,
    model_dir: Path,
    source_ply_path: Path,
    property_names: set[str],
    vertices: np.memmap,
    environment_files: list[Path],
    sidecar_maps: list[dict],
) -> dict:
    searched_paths = {
        "modelDir": str(model_dir),
        "pointCloudDir": str(source_ply_path.parent),
        "environmentPatterns": ["**/*env*", "**/*environment*", "**/*cubemap*", "**/*light*"],
        "sidecarMapNames": ["point_cloud1.map", "point_cloud2.map"],
        "checkpointPly": str(source_ply_path),
    }
    field_groups = {
        "scale3D": ["scale_0", "scale_1", "scale_2"],
        "scale2D": ["scale_0", "scale_1"],
        "rotation": ["rot_0", "rot_1", "rot_2", "rot_3"],
        "opacity": ["opacity"],
        "normals": ["nx", "ny", "nz"],
        "secondaryNormals": ["nx2", "ny2", "nz2"],
        "directSh": ["f_dc_0", "f_dc_1", "f_dc_2"],
        "directShRest": [f"f_rest_{idx}" for idx in range(45)],
        "indirectSh": ["ind_dc_0", "ind_dc_1", "ind_dc_2"],
        "indirectShRest": [f"ind_rest_{idx}" for idx in range(45)],
        "indirectAsg": [f"ind_asg_{idx}" for idx in range(160)],
        "reflectionStrength": ["refl_strength"],
        "roughness": ["roughness"],
        "metalness": ["metalness"],
        "diffuseColor": ["diffuse_color_0", "diffuse_color_1", "diffuse_color_2"],
        "originalColor": ["ori_color_0", "ori_color_1", "ori_color_2"],
    }
    fields = {}
    missing = []
    for name, properties in field_groups.items():
        missing_properties = [prop for prop in properties if prop not in property_names]
        stats = summarize_ply_group(vertices, properties) if not missing_properties else None
        fields[name] = {
            "available": not missing_properties,
            "properties": properties,
            "missingProperties": missing_properties,
            "stats": stats,
        }
        if missing_properties:
            missing.append({
                "name": name,
                "source": "checkpoint_ply",
                "missingProperties": missing_properties,
            })

    if not environment_files:
        missing.append({
            "name": "environmentLighting",
            "source": "model_dir_recursive_search",
            "searchedPatterns": searched_paths["environmentPatterns"],
            "reason": "no_environment_map_or_lighting_sidecar_found",
        })

    return {
        "searched": searched_paths,
        "fields": fields,
        "sidecarMaps": sidecar_maps,
        "environmentFiles": [str(path) for path in environment_files],
        "scaleMode": "3d" if fields["scale3D"]["available"] else "2d" if fields["scale2D"]["available"] else "missing",
        "normalStatus": (
            "available_nonzero"
            if fields["normals"]["available"] and not (fields["normals"]["stats"] or {}).get("allZero")
            else "available_all_zero"
            if fields["normals"]["available"]
            else "missing"
        ),
        "missing": missing,
    }


def build_native_renderer_contract_metadata(
    *,
    source_ply_path: Path,
    iterations: int | None,
    sidecar_maps: list[dict],
    arrays: list[dict],
    model_dir: Path,
) -> dict:
    array_names = {array.get("name") for array in arrays}
    actual_iteration = parse_iteration_from_path(source_ply_path)
    mesh_path = model_dir / f"test_{int(iterations or actual_iteration or 0):06d}.ply"
    if not mesh_path.exists() and actual_iteration is not None:
        mesh_path = model_dir / f"test_{actual_iteration:06d}.ply"
    return {
        "nativeGalleryEntryPoint": "eval.py:render_sets(..., indirect=True)",
        "nativeRenderFunction": "gaussian_renderer.render_surfel",
        "nativeRenderReason": "run_refgaussian_adapter.py invokes eval.py --save_images --iteration <iterations>; upstream eval.py imports render_surfel and enables indirect rendering.",
        "scaleRepresentation": {
            "mode": "refgaussian_2d_surfel",
            "learnedFields": ["scale_0", "scale_1"],
            "nativeEquation": "GaussianModel.get_covariance builds build_scaling_rotation([scale_0, scale_1, 1], rotation)",
            "scale2MissingIsBlocker": False,
        },
        "normalRepresentation": {
            "storedDeltaFields": ["nx", "ny", "nz", "nx2", "ny2", "nz2"],
            "runtimePrimaryNormal": "pc.get_normal derives normals from splat2world[:,2,:3] and flip_align_view; zero PLY normals do not mean runtime normals are unavailable.",
            "browserPortStatus": "uses rotation normal axis with view alignment; does not yet reproduce rasterizer allmap normal accumulation exactly",
        },
        "environmentRepresentation": {
            "nativeStateFiles": [entry.get("path") for entry in sidecar_maps if entry.get("kind") == "raw_file"],
            "exportedBaseTensors": [name for name in ("envMap1Base", "envMap2Base") if name in array_names],
            "nativeEquation": "EnvLight.__call__ applies sigmoid(base), specular/diffuse cubemap mip filters, and nvdiffrast cube texture sampling.",
            "browserPortStatus": "envMap1Base direct cube sampling is exported; specular mip filtering and diffuse convolution are not yet ported",
        },
        "nativeSurfaceInputs": [
            "positions",
            "shDc/shRest",
            "opacityLogit",
            "logScale",
            "rotation",
            "reflectionStrength",
            "roughness",
            "originalColor",
            "indirectDc/indirectRest or indirectAsg",
            "envMap1Base",
        ],
        "unportedNativeCodePaths": [
            "diff_surfel_rasterization CUDA tile rasterizer projection, conic/radii, and allmap outputs",
            "render_surfel per-pixel normal_map = rend_normal / alpha from CUDA allmap",
            "assets/bsdf_256_256.bin FG LUT lookup via nvdiffrast.texture",
            "EnvLight mipmapped specular_cubemap/diffuse_cubemap filtering",
            "raytracing.trace visibility against extracted mesh for indirect reflections",
        ],
        "raytracingMeshPath": str(mesh_path) if mesh_path.exists() else None,
    }


def write_ply_group_array(
    *,
    bundle_handle: BinaryIO,
    vertices: np.memmap,
    group_name: str,
    properties: list[str],
    dtype: str,
    description: str,
) -> dict:
    if len(properties) == 1:
        array = np.asarray(vertices[properties[0]], dtype="<f4").reshape(-1, 1)
    else:
        array = np.stack([np.asarray(vertices[name], dtype="<f4") for name in properties], axis=1)
    return write_float32_array(
        bundle_handle=bundle_handle,
        name=group_name,
        array=array,
        source="ply_properties",
        description=description,
        properties=properties,
    )


def export_refgaussian_bundle(
    *,
    model_dir: Path,
    final_dir: Path,
    source_ply_path: Path | None = None,
    manifest_path: Path | None = None,
    manifest: dict | None = None,
    iterations: int | None = None,
    output_bin_path: Path | None = None,
    output_json_path: Path | None = None,
    sfm_text_model_dir: Path | None = None,
) -> dict:
    model_dir = Path(model_dir)
    final_dir = ensure_dir(Path(final_dir))
    source_ply_path = Path(source_ply_path) if source_ply_path else find_refgaussian_point_cloud_ply(model_dir, iterations)
    output_bin_path = output_bin_path or final_dir / "scene.refgaussian.bin"
    output_json_path = output_json_path or final_dir / "scene.refgaussian.json"
    ensure_dir(output_bin_path.parent)
    ensure_dir(output_json_path.parent)
    manifest = manifest if manifest is not None else load_manifest(manifest_path)

    ply_info = parse_ply_header(source_ply_path)
    vertices = open_ply_vertices(source_ply_path, ply_info)
    property_names = set(vertices.dtype.names or ())
    arrays: list[dict] = []
    omitted_fields: list[dict] = []

    tmp_bin = tempfile.NamedTemporaryFile(delete=False, dir=str(output_bin_path.parent), suffix=".tmp")
    tmp_bin_path = Path(tmp_bin.name)
    try:
        with tmp_bin:
            tmp_bin.write(BUNDLE_HEADER_STRUCT.pack(BUNDLE_MAGIC, BUNDLE_VERSION, 0))
            for group_name, properties, dtype, description in PLY_FIELD_GROUPS:
                missing = [name for name in properties if name not in property_names]
                if missing:
                    omitted_fields.append({
                        "name": group_name,
                        "source": "ply_properties",
                        "missingProperties": missing,
                        "requestedProperties": properties,
                    })
                    continue
                arrays.append(write_ply_group_array(
                    bundle_handle=tmp_bin,
                    vertices=vertices,
                    group_name=group_name,
                    properties=properties,
                    dtype=dtype,
                    description=description,
                ))

            sidecar_maps = []
            for map_path in detect_sidecar_map_files(source_ply_path):
                offset, size, digest = copy_file_into_bundle(map_path, tmp_bin)
                sidecar_maps.append({
                    "name": map_path.name,
                    "kind": "raw_file",
                    "source": "refgaussian_sidecar_map",
                    "path": str(map_path),
                    "format": "torch_zip_archive",
                    "offset": int(offset),
                    "byteLength": int(size),
                    "sha256": digest,
                })
            arrays.extend(sidecar_maps)

            for env_index, map_path in enumerate(detect_sidecar_map_files(source_ply_path), start=1):
                base = load_envlight_base_tensor(map_path)
                if base is None:
                    omitted_fields.append({
                        "name": f"envMap{env_index}Base",
                        "source": "refgaussian_sidecar_map",
                        "path": str(map_path),
                        "reason": "torch_unavailable_or_base_tensor_missing",
                    })
                    continue
                arrays.append(write_float32_array(
                    bundle_handle=tmp_bin,
                    name=f"envMap{env_index}Base",
                    array=base,
                    source="refgaussian_envlight_state",
                    description="Native Ref-Gaussian EnvLight.base cubemap logits from point_cloud*.map; shader must apply sigmoid before sampling.",
                    properties=["cubeFace", "y", "x", "rgb"],
                    extra={
                        "path": str(map_path),
                        "activation": "sigmoid",
                        "layout": "cube_faces_6_positive_negative_order_from_torch_state",
                    },
                ))
        tmp_bin_path.replace(output_bin_path)
        output_bin_path.chmod(0o644)
    finally:
        if tmp_bin_path.exists():
            tmp_bin_path.unlink(missing_ok=True)

    environment_files = detect_environment_files(model_dir)
    env_map_arrays = [
        array for array in arrays
        if array.get("kind") == "array" and str(array.get("name", "")).startswith("envMap")
    ]
    if environment_files or sidecar_maps or env_map_arrays:
        omitted_environment = []
    else:
        omitted_environment = [{
            "name": "environmentLighting",
            "source": "model_dir",
            "searchedPaths": [str(model_dir)],
            "searchedPatterns": ["**/*env*", "**/*environment*", "**/*cubemap*", "**/*light*"],
            "reason": "no_environment_map_or_lighting_sidecar_found",
        }]
    native_renderer_state = build_native_renderer_state_metadata(
        model_dir=model_dir,
        source_ply_path=source_ply_path,
        property_names=property_names,
        vertices=vertices,
        environment_files=environment_files,
        sidecar_maps=sidecar_maps,
    )

    if "scale_2" not in property_names:
        # Most inspected Ref-Gaussian PLYs are 2DGS-style and omit scale_2.
        omitted_fields.append({
            "name": "scale_2",
            "source": "ply_properties",
            "reason": "not_present_in_checkpoint_ply",
        })

    camera_metadata = build_camera_metadata(manifest, sfm_text_model_dir)
    native_renderer_contract = build_native_renderer_contract_metadata(
        source_ply_path=source_ply_path,
        iterations=iterations,
        sidecar_maps=sidecar_maps,
        arrays=arrays,
        model_dir=model_dir,
    )
    cfg_args_path = model_dir / "cfg_args"
    cfg_args_text = cfg_args_path.read_text(encoding="utf-8", errors="replace") if cfg_args_path.exists() else None
    bin_size = output_bin_path.stat().st_size
    metadata = {
        "schemaVersion": 1,
        "format": "houseyield_refgaussian_bundle",
        "binary": {
            "path": output_bin_path.name,
            "fileName": output_bin_path.name,
            "magic": BUNDLE_MAGIC.decode("ascii"),
            "version": BUNDLE_VERSION,
            "headerSize": BUNDLE_HEADER_SIZE,
            "byteLength": int(bin_size),
            "sha256": sha256_file(output_bin_path),
        },
        "source": {
            "modelDir": str(model_dir),
            "sourcePlyPath": str(source_ply_path),
            "sourcePlySha256": sha256_file(source_ply_path),
            "sourcePlyRole": "native_refgaussian_checkpoint",
            "requestedIterations": iterations,
            "actualIteration": parse_iteration_from_path(source_ply_path),
            "manifestPath": str(manifest_path) if manifest_path else None,
            "cfgArgsPath": str(cfg_args_path) if cfg_args_path.exists() else None,
            "cfgArgs": cfg_args_text,
        },
        "pointCount": int(ply_info["vertexCount"]),
        "ply": {
            "format": ply_info["format"],
            "headerSize": int(ply_info["headerSize"]),
            "vertexProperties": ply_info["vertexProperties"],
        },
        "arrays": arrays,
        "cameraCalibration": camera_metadata,
        "environmentLighting": {
            "available": bool(environment_files or sidecar_maps or env_map_arrays),
            "files": [str(path) for path in environment_files],
            "sidecarMaps": sidecar_maps,
            "exportedArrays": [array.get("name") for array in env_map_arrays],
            "omitted": omitted_environment,
        },
        "nativeRendererState": native_renderer_state,
        "nativeRendererContract": native_renderer_contract,
        "omittedFields": omitted_fields + omitted_environment,
        "referenceRenderer": REFERENCE_RENDERER_TODO,
    }
    write_json(output_json_path, metadata)
    return {
        "applied": True,
        "jsonPath": str(output_json_path),
        "binPath": str(output_bin_path),
        "pointCount": int(ply_info["vertexCount"]),
        "actualIteration": parse_iteration_from_path(source_ply_path),
        "arrayCount": len(arrays),
        "arrayNames": [array["name"] for array in arrays],
        "byteLength": int(bin_size),
        "omittedFieldCount": len(metadata["omittedFields"]),
        "cameraCalibrationAvailable": bool(camera_metadata.get("available")),
        "referenceRenderer": REFERENCE_RENDERER_TODO,
    }


def load_bundle_metadata(bundle_json_path: Path) -> dict:
    return json.loads(Path(bundle_json_path).read_text(encoding="utf-8"))


def resolve_bundle_path(bundle_json_path: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute() or path.exists():
        return path
    return Path(bundle_json_path).parent / path


def open_bundle_array(bundle_json_path: Path, metadata: dict, array_name: str) -> np.memmap:
    arrays = {array["name"]: array for array in metadata.get("arrays", []) if array.get("kind") == "array"}
    if array_name not in arrays:
        raise KeyError(f"bundle_array_missing:{array_name}")
    array = arrays[array_name]
    bin_path = resolve_bundle_path(bundle_json_path, metadata["binary"]["path"])
    return np.memmap(
        str(bin_path),
        dtype=np.dtype("<f4"),
        mode="r",
        offset=int(array["offset"]),
        shape=tuple(int(dim) for dim in array["shape"]),
    )


def validate_refgaussian_bundle(
    *,
    bundle_json_path: Path,
    source_ply_path: Path | None = None,
    sample_count: int = 32,
) -> dict:
    metadata = load_bundle_metadata(bundle_json_path)
    bin_path = resolve_bundle_path(bundle_json_path, metadata["binary"]["path"])
    if not bin_path.exists():
        raise FileNotFoundError(f"bundle_bin_missing:{bin_path}")

    with bin_path.open("rb") as handle:
        magic, version, _reserved = BUNDLE_HEADER_STRUCT.unpack(handle.read(BUNDLE_HEADER_SIZE))
    if magic != BUNDLE_MAGIC or version != BUNDLE_VERSION:
        raise ValueError(f"bundle_header_mismatch:{magic!r}:{version}")

    source_ply_path = Path(source_ply_path) if source_ply_path else resolve_bundle_path(
        bundle_json_path,
        metadata["source"]["sourcePlyPath"],
    )
    ply_info = parse_ply_header(source_ply_path)
    vertices = open_ply_vertices(source_ply_path, ply_info)
    point_count = int(metadata["pointCount"])
    if point_count != int(ply_info["vertexCount"]):
        raise ValueError(f"point_count_mismatch:{point_count}:{ply_info['vertexCount']}")

    if point_count == 0:
        sample_indices = np.asarray([], dtype=np.int64)
    else:
        sample_count = min(max(int(sample_count), 1), point_count)
        sample_indices = np.unique(np.linspace(0, point_count - 1, sample_count, dtype=np.int64))

    validated_arrays = []
    for array in metadata.get("arrays", []):
        if array.get("kind") == "raw_file":
            path = resolve_bundle_path(bundle_json_path, array["path"])
            if not path.exists():
                raise FileNotFoundError(f"sidecar_map_missing:{path}")
            if path.stat().st_size != int(array["byteLength"]):
                raise ValueError(f"sidecar_size_mismatch:{path}")
            if sha256_file(path) != array["sha256"]:
                raise ValueError(f"sidecar_sha256_mismatch:{path}")
            validated_arrays.append(array["name"])
            continue

        if array.get("source") != "ply_properties":
            continue
        actual = open_bundle_array(bundle_json_path, metadata, array["name"])
        expected = np.stack(
            [np.asarray(vertices[name][sample_indices], dtype="<f4") for name in array["properties"]],
            axis=1,
        )
        np.testing.assert_array_equal(np.asarray(actual[sample_indices]), expected)
        validated_arrays.append(array["name"])

    return {
        "success": True,
        "bundleJsonPath": str(bundle_json_path),
        "bundleBinPath": str(bin_path),
        "sourcePlyPath": str(source_ply_path),
        "pointCount": point_count,
        "sampleCount": int(sample_indices.shape[0]),
        "validatedArrays": validated_arrays,
        "cameraCalibrationAvailable": bool(metadata.get("cameraCalibration", {}).get("available")),
        "omittedFields": metadata.get("omittedFields", []),
    }


def command_export(args: argparse.Namespace) -> None:
    summary = export_refgaussian_bundle(
        model_dir=Path(args.model_dir),
        final_dir=Path(args.final_dir),
        source_ply_path=Path(args.source_ply) if args.source_ply else None,
        manifest_path=Path(args.manifest) if args.manifest else None,
        iterations=args.iterations,
        output_bin_path=Path(args.output_bin) if args.output_bin else None,
        output_json_path=Path(args.output_json) if args.output_json else None,
        sfm_text_model_dir=Path(args.sfm_text_model_dir) if args.sfm_text_model_dir else None,
    )
    print(json.dumps(summary, indent=2))


def command_validate(args: argparse.Namespace) -> None:
    summary = validate_refgaussian_bundle(
        bundle_json_path=Path(args.bundle_json),
        source_ply_path=Path(args.source_ply) if args.source_ply else None,
        sample_count=args.sample_count,
    )
    print(json.dumps(summary, indent=2))


def inspect_native_render_dir(native_render_dir: Path | None) -> dict:
    if not native_render_dir:
        return {
            "available": False,
            "reason": "native_render_dir_not_provided",
            "frames": [],
        }

    candidate_dirs = [
        native_render_dir,
        native_render_dir / "renders",
        native_render_dir / "viewer" / "renders",
    ]
    render_dir = next(
        (
            path for path in candidate_dirs
            if path.exists() and path.is_dir() and any(path.glob("*.png"))
        ),
        None,
    )
    if not render_dir:
        return {
            "available": False,
            "reason": "native_render_dir_missing",
            "requestedDir": str(native_render_dir),
            "frames": [],
        }

    frames = sorted(path for path in render_dir.glob("*.png") if path.is_file())
    return {
        "available": bool(frames),
        "reason": None if frames else "native_render_frames_missing",
        "renderDir": str(render_dir),
        "frameCount": len(frames),
        "frames": [path.name for path in frames],
        "firstFrame": frames[0].name if frames else None,
    }


def inspect_reference_renderer_readiness(metadata: dict, native_render_dir: Path | None) -> dict:
    array_names = [
        array.get("name")
        for array in metadata.get("arrays", [])
        if array.get("kind") == "array"
    ]
    native_render = inspect_native_render_dir(native_render_dir)
    camera_calibration = metadata.get("cameraCalibration") or {}
    native_state = metadata.get("nativeRendererState") or {}
    native_fields = native_state.get("fields") or {}
    pbr_fields = [
        name for name in ("reflectionStrength", "metalness", "roughness", "diffuseColor", "normals")
        if name in array_names
    ]
    indirect_fields = [
        name for name in ("indirectDc", "indirectRest", "indirectAsg")
        if name in array_names
    ]
    missing_for_first_render = [
        "SH evaluation beyond DC color",
        "Ref-Gaussian deferred/PBR shader equations",
        "Ref-Gaussian ASG/interreflection equations in browser-ready form",
        "camera split/order mapping between COLMAP images and eval.py native gallery frames",
    ]
    if not (native_fields.get("scale2D") or {}).get("available"):
        missing_for_first_render.append("native 2D surfel scale fields scale_0/scale_1 are unavailable")
    if "envMap1Base" not in array_names:
        missing_for_first_render.append("native EnvLight.base tensor from point_cloud1.map is not exported")
    native_contract = metadata.get("nativeRendererContract") or {}
    for blocker in native_contract.get("unportedNativeCodePaths") or []:
        missing_for_first_render.append(blocker)
    if not native_render.get("available"):
        missing_for_first_render.append("native render gallery frame for pixel comparison")
    if not camera_calibration.get("available"):
        missing_for_first_render.append("camera calibration exported from COLMAP")

    return {
        "success": False,
        "mode": "reference_renderer_scaffold",
        "pointCount": metadata.get("pointCount"),
        "actualIteration": (metadata.get("source") or {}).get("actualIteration"),
        "availableArrays": array_names,
        "pbrFieldsAvailable": pbr_fields,
        "indirectLightingFieldsAvailable": indirect_fields,
        "cameraCalibration": {
            "available": bool(camera_calibration.get("available")),
            "cameraCount": camera_calibration.get("cameraCount"),
            "imageCount": camera_calibration.get("imageCount"),
            "firstImage": (camera_calibration.get("images") or [None])[0],
            "reason": camera_calibration.get("reason"),
        },
        "nativeRender": native_render,
        "nativeRendererState": native_state,
        "nativeRendererContract": native_contract,
        "canComparePixelsNow": False,
        "missingForPixelParity": missing_for_first_render,
        "todo": REFERENCE_RENDERER_TODO,
    }


def command_render_reference(args: argparse.Namespace) -> None:
    metadata = load_bundle_metadata(Path(args.bundle_json))
    payload = inspect_reference_renderer_readiness(
        metadata,
        Path(args.native_render_dir) if args.native_render_dir else None,
    )
    payload["bundleJsonPath"] = args.bundle_json
    print(json.dumps(payload, indent=2))
    raise SystemExit(2)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export or validate Ref-Gaussian browser bundles")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Export scene.refgaussian.bin/json from an existing checkpoint")
    export_parser.add_argument("--model-dir", required=True)
    export_parser.add_argument("--final-dir", required=True)
    export_parser.add_argument("--source-ply", default="")
    export_parser.add_argument("--manifest", default="")
    export_parser.add_argument("--iterations", type=int, default=None)
    export_parser.add_argument("--output-bin", default="")
    export_parser.add_argument("--output-json", default="")
    export_parser.add_argument("--sfm-text-model-dir", default="")
    export_parser.set_defaults(func=command_export)

    validate_parser = subparsers.add_parser("validate", help="Decode and compare a bundle against its source PLY")
    validate_parser.add_argument("--bundle-json", required=True)
    validate_parser.add_argument("--source-ply", default="")
    validate_parser.add_argument("--sample-count", type=int, default=32)
    validate_parser.set_defaults(func=command_validate)

    render_parser = subparsers.add_parser("render-reference", help="Phase 2 scaffold; reports missing renderer work")
    render_parser.add_argument("--bundle-json", required=True)
    render_parser.add_argument("--native-render-dir", default="")
    render_parser.set_defaults(func=command_render_reference)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
