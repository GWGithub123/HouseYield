#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


def read_binary_ply_xyz(path: Path) -> np.ndarray:
    with path.open("rb") as handle:
        header_lines: list[bytes] = []
        while True:
            line = handle.readline()
            if not line:
                raise RuntimeError(f"ply_header_missing:{path}")
            header_lines.append(line)
            if line.strip() == b"end_header":
                break

        vertex_count = 0
        property_names: list[str] = []
        in_vertex = False
        for raw_line in header_lines:
            line = raw_line.decode("ascii", errors="ignore").strip()
            if line.startswith("element vertex "):
                vertex_count = int(line.split()[-1])
                in_vertex = True
                continue
            if line.startswith("element ") and not line.startswith("element vertex "):
                in_vertex = False
                continue
            if in_vertex and line.startswith("property "):
                property_names.append(line.split()[-1])

        if vertex_count <= 0 or len(property_names) < 3:
            raise RuntimeError(f"ply_vertex_schema_invalid:{path}")

        raw = np.fromfile(handle, dtype="<f4", count=vertex_count * len(property_names))
        if raw.size != vertex_count * len(property_names):
            raise RuntimeError(f"ply_vertex_data_truncated:{path}")

    data = raw.reshape(vertex_count, len(property_names))
    xyz_indices = [property_names.index(name) for name in ("x", "y", "z")]
    return data[:, xyz_indices].astype(np.float32, copy=False)


def read_colmap_points_xyz_rgb(path: Path) -> tuple[np.ndarray, np.ndarray]:
    xyz_rows: list[list[float]] = []
    rgb_rows: list[list[int]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            xyz_rows.append([float(parts[1]), float(parts[2]), float(parts[3])])
            rgb_rows.append([int(parts[4]), int(parts[5]), int(parts[6])])

    if not xyz_rows:
        raise RuntimeError(f"colmap_points_empty:{path}")

    return np.asarray(xyz_rows, dtype=np.float32), np.asarray(rgb_rows, dtype=np.uint8)


def write_binary_ply_xyz_rgb(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    if xyz.shape[0] != rgb.shape[0]:
        raise RuntimeError("xyz_rgb_count_mismatch")

    header = "\n".join([
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {xyz.shape[0]}",
        "property float x",
        "property float y",
        "property float z",
        "property uchar red",
        "property uchar green",
        "property uchar blue",
        "end_header",
        "",
    ]).encode("ascii")

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(header)
        vertex_dtype = np.dtype([
            ("x", "<f4"),
            ("y", "<f4"),
            ("z", "<f4"),
            ("red", "u1"),
            ("green", "u1"),
            ("blue", "u1"),
        ])
        packed = np.empty(xyz.shape[0], dtype=vertex_dtype)
        packed["x"] = xyz[:, 0]
        packed["y"] = xyz[:, 1]
        packed["z"] = xyz[:, 2]
        packed["red"] = rgb[:, 0]
        packed["green"] = rgb[:, 1]
        packed["blue"] = rgb[:, 2]
        packed.tofile(handle)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bake RGB colors onto Scaffold-GS fallback anchors.")
    parser.add_argument("--anchor-ply", required=True)
    parser.add_argument("--source-points", required=True)
    parser.add_argument("--output-ply", required=True)
    args = parser.parse_args()

    anchor_xyz = read_binary_ply_xyz(Path(args.anchor_ply))
    source_xyz, source_rgb = read_colmap_points_xyz_rgb(Path(args.source_points))

    tree = cKDTree(source_xyz)
    _, indices = tree.query(anchor_xyz, k=1, workers=-1)
    baked_rgb = source_rgb[np.asarray(indices, dtype=np.int64)]

    write_binary_ply_xyz_rgb(Path(args.output_ply), anchor_xyz, baked_rgb)
    print(
        {
            "anchorCount": int(anchor_xyz.shape[0]),
            "sourceCount": int(source_xyz.shape[0]),
            "outputPly": str(Path(args.output_ply)),
        }
    )


if __name__ == "__main__":
    main()
