#!/usr/bin/env python3
"""
Hybrid GCP pipeline wrapper.

Geometry stays authoritative via the existing V2 photogrammetry pipeline.
If the room-tour splat runtime is available on the VM, the same photo set is
also packaged through the room-tour gsplat worker to attach gaussian viewer
artifacts to the final deliverable.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


def log(message: str) -> None:
    print(f"[HybridPipeline] {message}", flush=True)


def ensure_dir(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def list_images(images_dir: Path) -> list[Path]:
    images: list[Path] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        images.extend(images_dir.glob(pattern))
    return sorted(images)


def run_command(command: list[str], env: Optional[Dict[str, str]] = None) -> None:
    log(f"$ {' '.join(command)}")
    subprocess.run(command, check=True, env=env)


def copy_if_exists(source: Path, destination: Path) -> Optional[Path]:
    if not source.exists():
        return None
    ensure_dir(destination.parent)
    shutil.copy2(source, destination)
    return destination


def copy_tree_if_exists(source: Path, destination: Path) -> bool:
    if not source.exists():
        return False
    shutil.copytree(source, destination, dirs_exist_ok=True)
    return True


def first_existing(paths: Iterable[Path]) -> Optional[Path]:
    for path in paths:
        if path.exists():
            return path
    return None


def read_json_if_exists(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2))


def build_room_tour_input(images_dir: Path, destination: Path, room_name: str, job_id: str) -> Path:
    keyframes_dir = ensure_dir(destination / "keyframes")
    for image_path in list_images(images_dir):
        target = keyframes_dir / image_path.name
        if target.exists():
            continue
        try:
            os.link(image_path, target)
        except OSError:
            shutil.copy2(image_path, target)

    write_json(destination / "package-manifest.json", {
        "jobId": job_id,
        "roomName": room_name,
    })
    return keyframes_dir


def package_geometry_outputs(geometry_output_dir: Path, output_dir: Path) -> Dict[str, Optional[str]]:
    mesh_output_dir = ensure_dir(output_dir / "mesh")
    packaged: Dict[str, Optional[str]] = {
        "meshPath": None,
        "measurementsPath": None,
        "statsPath": None,
        "sparsePath": None,
    }

    mesh_dir = geometry_output_dir / "mesh"
    for filename in ("scaled.ply", "cleaned.ply", "raw.ply", "textured.obj", "textured.mtl"):
        copied = copy_if_exists(mesh_dir / filename, mesh_output_dir / filename)
        if copied and packaged["meshPath"] is None and copied.suffix in {".obj", ".ply"}:
            packaged["meshPath"] = str(copied)

    for texture in list(mesh_dir.glob("*.jpg")) + list(mesh_dir.glob("*.jpeg")) + list(mesh_dir.glob("*.png")):
        copy_if_exists(texture, mesh_output_dir / texture.name)

    measurements = copy_if_exists(geometry_output_dir / "measurements.json", output_dir / "measurements.json")
    stats = copy_if_exists(geometry_output_dir / "pipeline_stats.json", output_dir / "pipeline_stats.json")

    if (geometry_output_dir / "sparse").exists():
        copy_tree_if_exists(geometry_output_dir / "sparse", output_dir / "sparse")
        packaged["sparsePath"] = str(output_dir / "sparse")

    packaged["measurementsPath"] = str(measurements) if measurements else None
    packaged["statsPath"] = str(stats) if stats else None
    return packaged


def maybe_run_room_tour_splat(
    images_dir: Path,
    output_dir: Path,
    job_id: str,
    room_name: str,
    gsplat_iterations: int,
    cuda_visible_devices: str,
) -> Dict[str, Any]:
    room_tour_python = first_existing([
        Path("/opt/room-tour-venv/bin/python3"),
        Path(sys.executable),
    ])
    room_tour_script = first_existing([
        Path("/opt/room-tour-service/process_room_tour.py"),
        Path(__file__).with_name("process_room_tour.py"),
    ])

    if room_tour_python is None or room_tour_script is None:
        return {
            "used_room_tour_splat": False,
            "fallback_reason": "room-tour runtime unavailable",
            "artifacts": {},
        }

    room_tour_input = ensure_dir(output_dir / "room-tour-input")
    build_room_tour_input(images_dir, room_tour_input, room_name, job_id)

    room_tour_output = ensure_dir(output_dir / "room-tour-output")
    room_tour_env = dict(os.environ)
    room_tour_env["CUDA_VISIBLE_DEVICES"] = cuda_visible_devices

    command = [
        str(room_tour_python),
        str(room_tour_script),
        "--input-dir", str(room_tour_input),
        "--output-dir", str(room_tour_output),
        "--job-id", job_id,
        "--gsplat-iterations", str(gsplat_iterations),
    ]

    if not Path("/opt/Metric3D").exists():
        command.append("--skip-metric3d")

    try:
        run_command(command, env=room_tour_env)
    except Exception as exc:
        log(f"Room-tour splat packaging failed, continuing with geometry-only output: {exc}")
        return {
            "used_room_tour_splat": False,
            "fallback_reason": str(exc),
            "artifacts": {},
        }

    native_output_dir = room_tour_output / "native-output"
    hybrid_output_dir = ensure_dir(output_dir / "hybrid")
    artifacts: Dict[str, Optional[str]] = {}

    for filename in ("scene.splat", "scene.ksplat", "scene.ply", "fused_scene.ply", "mesh.glb"):
        copied = copy_if_exists(native_output_dir / filename, hybrid_output_dir / filename)
        if copied:
            artifacts[filename] = str(copied)

    viewer_source = native_output_dir / "viewer"
    viewer_target = hybrid_output_dir / "viewer"
    if copy_tree_if_exists(viewer_source, viewer_target):
        artifacts["viewerHtmlPath"] = str(viewer_target / "index.html")

    return {
        "used_room_tour_splat": True,
        "fallback_reason": None,
        "artifacts": artifacts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Hybrid mesh + gaussian wrapper for GCP photogrammetry")
    parser.add_argument("images_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--job-id", default="hybrid-job")
    parser.add_argument("--room-name", default="Hybrid Room Scan")
    parser.add_argument("--metric3d-model", default="vit-large")
    parser.add_argument("--voxel-size", type=float, default=0.005)
    parser.add_argument("--gpu-count", type=int, default=2)
    parser.add_argument("--gsplat-iterations", type=int, default=7000)
    parser.add_argument("--skip-room-tour-splat", action="store_true")
    parser.add_argument("--no-gpu", action="store_true")
    parser.add_argument("--ar-poses", type=Path)
    args = parser.parse_args()

    images_dir = args.images_dir
    output_dir = ensure_dir(args.output_dir)
    geometry_output_dir = ensure_dir(output_dir / "geometry")
    start_time = time.time()

    if len(list_images(images_dir)) < 6:
        raise RuntimeError("Need at least 6 photos for hybrid reconstruction")

    v2_script = Path(__file__).with_name("gcp_v2_pipeline.py")
    if not v2_script.exists():
        raise RuntimeError(f"V2 pipeline script missing at {v2_script}")

    cuda_visible_devices = os.environ.get("CUDA_VISIBLE_DEVICES", "0,1")

    geometry_command = [
        sys.executable,
        str(v2_script),
        str(images_dir),
        str(geometry_output_dir),
        "--metric3d-model", args.metric3d_model,
        "--voxel-size", str(args.voxel_size),
    ]
    if args.no_gpu:
        geometry_command.append("--no-gpu")
    if args.ar_poses:
        geometry_command.extend(["--ar-poses", str(args.ar_poses)])

    run_command(geometry_command)
    packaged_geometry = package_geometry_outputs(geometry_output_dir, output_dir)

    room_tour_result: Dict[str, Any] = {
        "used_room_tour_splat": False,
        "fallback_reason": "room-tour splat stage skipped",
        "artifacts": {},
    }
    if not args.skip_room_tour_splat:
        room_tour_result = maybe_run_room_tour_splat(
            images_dir=images_dir,
            output_dir=output_dir,
            job_id=args.job_id,
            room_name=args.room_name,
            gsplat_iterations=args.gsplat_iterations,
            cuda_visible_devices=cuda_visible_devices,
        )

    stats = read_json_if_exists(output_dir / "pipeline_stats.json") or {}
    measurements = read_json_if_exists(output_dir / "measurements.json") or {}

    hybrid_manifest: Dict[str, Any] = {
        "success": True,
        "pipelineVersion": "hybrid_v1",
        "method": "hybrid_mesh_gaussian_v1",
        "jobId": args.job_id,
        "gpuCountRequested": args.gpu_count,
        "cudaVisibleDevices": cuda_visible_devices,
        "geometry": packaged_geometry,
        "usedRoomTourSplat": room_tour_result["used_room_tour_splat"],
        "fallbackReason": room_tour_result["fallback_reason"],
        "artifacts": room_tour_result["artifacts"],
        "stats": stats,
        "measurements": measurements.get("room_dimensions") or measurements.get("roomDimensions") or {},
        "totalTimeSeconds": round(time.time() - start_time),
    }

    write_json(output_dir / "hybrid_manifest.json", hybrid_manifest)
    write_json(output_dir / "hybrid" / "hybrid_manifest.json", hybrid_manifest)

    result: Dict[str, Any] = {
        "success": True,
        "pipeline_version": "hybrid_v1",
        "method": "hybrid_mesh_gaussian_v1",
        "mesh_path": packaged_geometry["meshPath"],
        "measurements_path": packaged_geometry["measurementsPath"],
        "stats_path": packaged_geometry["statsPath"],
        "sparse_model_dir": str(output_dir / "sparse" / "0") if (output_dir / "sparse" / "0").exists() else None,
        "hybrid_manifest_path": str(output_dir / "hybrid_manifest.json"),
        "viewer_path": room_tour_result["artifacts"].get("viewerHtmlPath"),
        "splat_scene_path": room_tour_result["artifacts"].get("scene.splat") or room_tour_result["artifacts"].get("scene.ksplat"),
        "used_room_tour_splat": room_tour_result["used_room_tour_splat"],
        "fallback_reason": room_tour_result["fallback_reason"],
        "stats": stats,
        "measurements": measurements,
    }

    write_json(output_dir / "remote-processing.json", result)
    log("Hybrid pipeline complete")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()