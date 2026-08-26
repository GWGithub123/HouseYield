#!/usr/bin/env python3
"""Author the canonical structural shell mesh for master_v1.

The canonical mesh is layout-driven: floor, ceiling, and wall planes are
triangulated directly from the solved room box, and conservative opening
rectangles are cut into wall faces. A Poisson detail mesh can be emitted as an
optional sidecar when the backend is available, but it is not the geometry
authority.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import trimesh

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
PHOTOGRAMMETRY_DIR = SCRIPTS_DIR / 'photogrammetry'
if str(PHOTOGRAMMETRY_DIR) not in sys.path:
    sys.path.insert(0, str(PHOTOGRAMMETRY_DIR))

try:
    from mesh_generation import MeshGenerator
except Exception:  # pragma: no cover - optional backend
    MeshGenerator = None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def normalize(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm < 1e-8:
        raise ValueError('zero_length_vector')
    return vector / norm


def wall_frame(wall: dict) -> dict:
    corners = np.asarray(wall['corners'], dtype=np.float32)
    return {
        'origin': corners[0],
        'horizontalAxis': normalize(corners[1] - corners[0]),
        'verticalAxis': normalize(corners[3] - corners[0]),
        'normal': normalize(np.asarray(wall['normal'], dtype=np.float32)),
        'width': float(np.linalg.norm(corners[1] - corners[0])),
        'height': float(np.linalg.norm(corners[3] - corners[0])),
    }


def append_quad(vertices: list[list[float]], faces: list[list[int]], quad: list[np.ndarray], expected_normal: np.ndarray) -> None:
    start_index = len(vertices)
    for point in quad:
        vertices.append(point.astype(np.float32).tolist())

    tri_normal = np.cross(quad[1] - quad[0], quad[2] - quad[0])
    if np.dot(tri_normal, expected_normal) >= 0:
        faces.append([start_index + 0, start_index + 1, start_index + 2])
        faces.append([start_index + 0, start_index + 2, start_index + 3])
    else:
        faces.append([start_index + 0, start_index + 3, start_index + 2])
        faces.append([start_index + 0, start_index + 2, start_index + 1])


def openings_for_wall(openings_payload: dict, wall_id: str) -> list[dict]:
    return [
        candidate for candidate in openings_payload.get('candidates', [])
        if candidate.get('wallId') == wall_id and float(candidate.get('confidence', 0.0)) >= 0.6
    ]


def point_on_wall(frame: dict, u_value: float, z_value: float) -> np.ndarray:
    return frame['origin'] + (frame['horizontalAxis'] * u_value) + (frame['verticalAxis'] * z_value)


def build_wall_quads(wall: dict, wall_openings: list[dict]) -> tuple[list[list[np.ndarray]], int]:
    frame = wall_frame(wall)
    breaks_u = {0.0, frame['width']}
    breaks_z = {0.0, frame['height']}
    rectangles = []

    for opening in wall_openings:
        bbox = opening['bboxMeters']
        u0 = max(0.0, min(frame['width'], float(bbox['uMin'])))
        u1 = max(0.0, min(frame['width'], float(bbox['uMax'])))
        z0 = max(0.0, min(frame['height'], float(bbox['zMin'])))
        z1 = max(0.0, min(frame['height'], float(bbox['zMax'])))
        if u1 - u0 < 0.05 or z1 - z0 < 0.05:
            continue
        breaks_u.update([u0, u1])
        breaks_z.update([z0, z1])
        rectangles.append((u0, u1, z0, z1))

    sorted_u = sorted(breaks_u)
    sorted_z = sorted(breaks_z)
    quads = []
    opening_cut_count = 0

    for u_index in range(len(sorted_u) - 1):
        for z_index in range(len(sorted_z) - 1):
            u0 = sorted_u[u_index]
            u1 = sorted_u[u_index + 1]
            z0 = sorted_z[z_index]
            z1 = sorted_z[z_index + 1]
            if (u1 - u0) < 1e-4 or (z1 - z0) < 1e-4:
                continue
            center_u = (u0 + u1) * 0.5
            center_z = (z0 + z1) * 0.5
            inside_opening = any((left <= center_u <= right and bottom <= center_z <= top) for left, right, bottom, top in rectangles)
            if inside_opening:
                opening_cut_count += 1
                continue

            quads.append([
                point_on_wall(frame, u0, z0),
                point_on_wall(frame, u1, z0),
                point_on_wall(frame, u1, z1),
                point_on_wall(frame, u0, z1),
            ])

    return quads, opening_cut_count


def build_shell_mesh(layout: dict, openings_payload: dict) -> tuple[trimesh.Trimesh, dict]:
    vertices: list[list[float]] = []
    faces: list[list[int]] = []
    plane_panels = []
    wall_panel_count = 0
    opening_cut_count = 0

    for plane in layout['layoutPlanes']:
        normal = np.asarray(plane['normal'], dtype=np.float32)
        if plane['type'] == 'wall':
            quads, wall_cuts = build_wall_quads(plane, openings_for_wall(openings_payload, plane['id']))
            opening_cut_count += wall_cuts
            for quad in quads:
                append_quad(vertices, faces, quad, normal)
                wall_panel_count += 1
            plane_panels.append({'planeId': plane['id'], 'panelCount': len(quads)})
            continue

        corners = [np.asarray(corner, dtype=np.float32) for corner in plane['corners']]
        append_quad(vertices, faces, corners, normal)
        plane_panels.append({'planeId': plane['id'], 'panelCount': 1})

    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=np.float32), faces=np.asarray(faces, dtype=np.int64), process=False)
    try:
        unique_face_indices = mesh.unique_faces()
        if len(unique_face_indices) < len(mesh.faces):
            mesh.update_faces(unique_face_indices)
    except AttributeError:
        pass
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    metadata = {
        'panelBreakdown': plane_panels,
        'wallPanelCount': wall_panel_count,
        'openingCutCount': opening_cut_count,
    }
    return mesh, metadata


def maybe_generate_detail_sidecar(dense_evidence_dir: Path, output_dir: Path, dry_run: bool) -> dict | None:
    if dry_run:
        return None
    if MeshGenerator is None or shutil.which('PoissonRecon') is None:
        raise RuntimeError('mesh_authoring_requires_poissonrecon_detail_meshing')

    point_cloud_path = dense_evidence_dir / 'fused_scene.ply'
    if not point_cloud_path.exists():
        raise RuntimeError('mesh_authoring_dense_evidence_point_cloud_missing')

    detail_dir = ensure_dir(output_dir / 'detail_mesh')
    generator = MeshGenerator(method='poisson', depth=10, target_triangles=300000, clean_mesh=True)
    result = generator.run(point_cloud_path, detail_dir)
    detail_summary = {
        'meshPath': str(result['mesh_path']),
        'numVertices': int(result['num_vertices']),
        'numFaces': int(result['num_faces']),
        'dimensions': result.get('dimensions', {}),
    }
    write_json(detail_dir / 'summary.json', detail_summary)
    return detail_summary


def run_mesh_authoring(job_id: str, layout_path: Path, openings_path: Path, dense_evidence_dir: Path, output_dir: Path, dry_run: bool) -> dict:
    # Gate: Fail if dense evidence is too sparse (indicates bad reconstruction that will produce blobs)
    # Typical room reconstructions should have 1000+ points; <500 indicates geometry failure
    if not dry_run:
        dense_summary_path = Path(dense_evidence_dir) / 'summary.json'
        if dense_summary_path.exists():
            dense_summary = read_json(dense_summary_path)
            point_count = dense_summary.get('pointCount', 0)
            if point_count < 500:
                raise RuntimeError(f'geometry_too_sparse: {point_count} points is insufficient for room reconstruction (need >= 500)')

    layout = read_json(layout_path)
    openings_payload = read_json(openings_path)
    mesh, shell_metadata = build_shell_mesh(layout, openings_payload)

    shell_obj_path = output_dir / 'shell_mesh.obj'
    shell_ply_path = output_dir / 'shell_mesh.ply'
    mesh.export(shell_obj_path)
    mesh.export(shell_ply_path)

    bounds = mesh.bounds
    
    # Gate: Fail if scene bounds are implausibly large (indicates inflation from poor geometry)
    # Typical room diagonal is 10-50m; >150m indicates reconstruction failure (like a blob inflating to infinity)
    MAX_ROOM_DIAGONAL_METERS = 150
    diagonal = float(np.linalg.norm(bounds[1] - bounds[0]))
    if diagonal > MAX_ROOM_DIAGONAL_METERS:
        raise RuntimeError(f'geometry_inflated: room diagonal {diagonal:.1f}m exceeds max {MAX_ROOM_DIAGONAL_METERS}m (indicates mesh generation failure)')
    
    detail_summary = maybe_generate_detail_sidecar(dense_evidence_dir, output_dir, dry_run=dry_run)

    summary = {
        'jobId': job_id,
        'createdAt': now_iso(),
        'dryRun': dry_run,
        'shellMeshPath': str(shell_obj_path),
        'shellMeshPlyPath': str(shell_ply_path),
        'numVertices': int(len(mesh.vertices)),
        'numFaces': int(len(mesh.faces)),
        'bounds': {
            'min': [round(float(value), 6) for value in bounds[0]],
            'max': [round(float(value), 6) for value in bounds[1]],
        },
        'wallPanelCount': shell_metadata['wallPanelCount'],
        'openingCutCount': shell_metadata['openingCutCount'],
        'detailMesh': detail_summary,
        'note': 'The canonical shell mesh is layout-driven and keeps planar walls editable. Optional detail meshing is emitted only as a sidecar.',
    }
    write_json(output_dir / 'summary.json', summary)
    write_json(output_dir / 'panel_breakdown.json', shell_metadata)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description='Run master_v1 mesh authoring')
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--layout-path', required=True)
    parser.add_argument('--openings-path', required=True)
    parser.add_argument('--dense-evidence-dir', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    summary = run_mesh_authoring(
        job_id=args.job_id,
        layout_path=Path(args.layout_path),
        openings_path=Path(args.openings_path),
        dense_evidence_dir=Path(args.dense_evidence_dir),
        output_dir=ensure_dir(Path(args.output_dir)),
        dry_run=args.dry_run,
    )
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()