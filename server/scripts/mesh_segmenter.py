#!/usr/bin/env python3
"""
Mesh Segmenter for AI Retexturing Pipeline

Extracts specific surface types (floor, walls, countertops) from a photogrammetry
mesh using geometric analysis. Preserves world coordinates for seamless reassembly.

Usage:
    python mesh_segmenter.py <mesh_path> <surface_type> <output_dir>
    
    surface_type: floor, walls, ceiling, countertops, all
    
Output:
    - {surface_type}_segment.obj  - The extracted surface
    - remainder.obj               - Everything else (for reassembly)
    - segmentation.json           - Metadata about the segmentation
"""

import sys
import json
import argparse
from pathlib import Path
import numpy as np

try:
    import trimesh
    HAS_TRIMESH = True
except ImportError:
    HAS_TRIMESH = False
    print("[MeshSegmenter] Warning: trimesh not installed", file=sys.stderr)


def analyze_face_normals(mesh: trimesh.Trimesh) -> dict:
    """
    Analyze mesh faces and classify by surface type based on normal direction.
    
    Returns dict with face indices for each surface type.
    """
    # Get face normals and centroids
    face_normals = mesh.face_normals
    face_centroids = mesh.triangles_center
    
    # Get mesh bounds for height-based classification
    bounds = mesh.bounds
    min_y, max_y = bounds[0][1], bounds[1][1]
    mesh_height = max_y - min_y
    
    # IMPROVED: More lenient floor detection
    # Floor can be anywhere in bottom 40% of mesh (photogrammetry often has artifacts at bottom)
    floor_threshold = min_y + mesh_height * 0.40
    ceiling_threshold = max_y - mesh_height * 0.15
    counter_min = min_y + mesh_height * 0.35  # ~35% up (counter height)
    counter_max = min_y + mesh_height * 0.50  # ~50% up
    
    # IMPROVED: More lenient angle thresholds (photogrammetry meshes are noisy)
    horizontal_threshold = np.radians(30)  # 30 degrees from horizontal (was 20)
    
    # Classification arrays
    floor_faces = []
    wall_faces = []
    ceiling_faces = []
    counter_faces = []
    
    up_vector = np.array([0, 1, 0])
    down_vector = np.array([0, -1, 0])
    
    # IMPROVED: First pass - find the most common Y value among up-facing faces
    # This is likely the actual floor level
    up_facing_y_values = []
    for i, (normal, centroid) in enumerate(zip(face_normals, face_centroids)):
        dot_up = np.dot(normal, up_vector)
        angle_from_up = np.arccos(np.clip(dot_up, -1, 1))
        if angle_from_up < horizontal_threshold:
            up_facing_y_values.append(centroid[1])
    
    # Find the most common floor level (mode of Y values, rounded to 0.1m)
    if up_facing_y_values:
        y_hist, y_bins = np.histogram(up_facing_y_values, bins=50)
        floor_level = y_bins[np.argmax(y_hist)]
        print(f"[MeshSegmenter] Detected floor level: {floor_level:.2f}", file=sys.stderr)
    else:
        floor_level = min_y
    
    for i, (normal, centroid) in enumerate(zip(face_normals, face_centroids)):
        # Calculate angles from up/down
        dot_up = np.dot(normal, up_vector)
        dot_down = np.dot(normal, down_vector)
        angle_from_up = np.arccos(np.clip(dot_up, -1, 1))
        angle_from_down = np.arccos(np.clip(dot_down, -1, 1))
        
        y = centroid[1]
        
        # FLOOR: Horizontal facing up, near detected floor level
        if angle_from_up < horizontal_threshold:
            # Within 20% of mesh height from detected floor level
            if abs(y - floor_level) < mesh_height * 0.20:
                floor_faces.append(i)
            elif counter_min <= y <= counter_max and y > floor_level:
                counter_faces.append(i)
            # Ignore other up-facing surfaces far from floor
        
        # CEILING: Horizontal facing down, near top
        elif angle_from_down < horizontal_threshold:
            if y >= ceiling_threshold:
                ceiling_faces.append(i)
        
        # WALLS: Mostly vertical
        elif abs(dot_up) < np.sin(horizontal_threshold):
            wall_faces.append(i)
    
    print(f"[MeshSegmenter] Classified {len(floor_faces)} floor, {len(wall_faces)} wall, {len(ceiling_faces)} ceiling faces", file=sys.stderr)
    
    return {
        'floor': floor_faces,
        'walls': wall_faces,
        'ceiling': ceiling_faces,
        'countertops': counter_faces,
        'bounds': {
            'min': bounds[0].tolist(),
            'max': bounds[1].tolist(),
            'height': mesh_height,
        },
        'thresholds': {
            'floor_y': floor_threshold,
            'ceiling_y': ceiling_threshold,
            'counter_min_y': counter_min,
            'counter_max_y': counter_max,
        }
    }


def extract_faces_as_mesh(mesh: trimesh.Trimesh, face_indices: list) -> trimesh.Trimesh:
    """
    Extract specific faces from a mesh as a new mesh.
    
    CRITICAL: Preserves world coordinates by NOT resetting the origin.
    This allows seamless reassembly with other parts.
    """
    if not face_indices:
        return None
    
    # Create a mask for the faces we want
    face_mask = np.zeros(len(mesh.faces), dtype=bool)
    face_mask[face_indices] = True
    
    # Get the faces and their vertices
    selected_faces = mesh.faces[face_mask]
    
    # Find unique vertex indices used by selected faces
    unique_vertex_indices = np.unique(selected_faces.flatten())
    
    # Create mapping from old to new vertex indices
    vertex_map = {old: new for new, old in enumerate(unique_vertex_indices)}
    
    # Get vertices (in original world coordinates!)
    new_vertices = mesh.vertices[unique_vertex_indices]
    
    # Remap face indices to new vertex array
    new_faces = np.array([[vertex_map[v] for v in face] for face in selected_faces])
    
    # Create new mesh
    new_mesh = trimesh.Trimesh(
        vertices=new_vertices,
        faces=new_faces,
        process=False  # Don't process - preserve exact geometry
    )
    
    # Copy vertex colors/UVs if they exist
    if mesh.visual is not None:
        if hasattr(mesh.visual, 'uv') and mesh.visual.uv is not None:
            try:
                new_uv = mesh.visual.uv[unique_vertex_indices]
                new_mesh.visual = trimesh.visual.TextureVisuals(uv=new_uv)
            except Exception as e:
                print(f"[MeshSegmenter] Could not copy UVs: {e}", file=sys.stderr)
        
        if hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
            try:
                new_colors = mesh.visual.vertex_colors[unique_vertex_indices]
                new_mesh.visual.vertex_colors = new_colors
            except Exception as e:
                print(f"[MeshSegmenter] Could not copy vertex colors: {e}", file=sys.stderr)
    
    return new_mesh


def find_largest_connected_component(mesh: trimesh.Trimesh, face_indices: list) -> list:
    """
    Find the largest connected component among the given face indices.
    This eliminates scattered fragments and returns only the main floor/surface.
    
    Uses SPATIAL PROXIMITY for photogrammetry meshes where triangles
    in the same area don't necessarily share vertices.
    """
    if not face_indices or len(face_indices) < 10:
        return face_indices
    
    try:
        from scipy.spatial import cKDTree
        has_scipy = True
    except ImportError:
        has_scipy = False
    
    face_set = set(face_indices)
    
    # First try vertex-based connectivity
    vertex_to_faces = {}
    for face_idx in face_indices:
        for vertex_idx in mesh.faces[face_idx]:
            if vertex_idx not in vertex_to_faces:
                vertex_to_faces[vertex_idx] = []
            vertex_to_faces[vertex_idx].append(face_idx)
    
    face_neighbors = {f: set() for f in face_indices}
    for face_idx in face_indices:
        for vertex_idx in mesh.faces[face_idx]:
            for neighbor_face in vertex_to_faces.get(vertex_idx, []):
                if neighbor_face != face_idx and neighbor_face in face_set:
                    face_neighbors[face_idx].add(neighbor_face)
    
    # Check if we have good connectivity
    connected_count = sum(1 for f in face_indices if len(face_neighbors[f]) > 0)
    connectivity_ratio = connected_count / len(face_indices) if face_indices else 0
    
    print(f"[MeshSegmenter] Vertex connectivity: {connected_count}/{len(face_indices)} faces connected ({connectivity_ratio:.1%})", file=sys.stderr)
    
    # If most faces are disconnected, use spatial proximity instead
    if has_scipy and connectivity_ratio < 0.5:
        print(f"[MeshSegmenter] Using spatial proximity for disconnected mesh...", file=sys.stderr)
        
        # Compute face centroids
        face_centroids = []
        for face_idx in face_indices:
            verts = mesh.vertices[mesh.faces[face_idx]]
            centroid = verts.mean(axis=0)
            face_centroids.append(centroid)
        
        face_centroids = np.array(face_centroids)
        
        # Compute average edge length for distance threshold
        avg_edge_length = 0
        sample_faces = face_indices[:min(100, len(face_indices))]
        for face_idx in sample_faces:
            verts = mesh.vertices[mesh.faces[face_idx]]
            edges = [
                np.linalg.norm(verts[0] - verts[1]),
                np.linalg.norm(verts[1] - verts[2]),
                np.linalg.norm(verts[2] - verts[0]),
            ]
            avg_edge_length += sum(edges) / 3
        avg_edge_length /= len(sample_faces)
        
        # Distance threshold: faces within 3x average edge length are neighbors
        distance_threshold = avg_edge_length * 3
        print(f"[MeshSegmenter] Using distance threshold: {distance_threshold:.4f} (3x avg edge {avg_edge_length:.4f})", file=sys.stderr)
        
        # Build spatial tree for fast neighbor queries
        tree = cKDTree(face_centroids)
        
        # Update adjacency with spatial neighbors
        for i, face_idx in enumerate(face_indices):
            neighbors = tree.query_ball_point(face_centroids[i], distance_threshold)
            for j in neighbors:
                if i != j:
                    neighbor_face = face_indices[j]
                    face_neighbors[face_idx].add(neighbor_face)
        
        connected_count = sum(1 for f in face_indices if len(face_neighbors[f]) > 0)
        print(f"[MeshSegmenter] After spatial: {connected_count}/{len(face_indices)} faces connected", file=sys.stderr)
    
    # Find connected components using BFS
    visited = set()
    components = []
    
    for start_face in face_indices:
        if start_face in visited:
            continue
        
        component = []
        queue = [start_face]
        visited.add(start_face)
        
        while queue:
            current = queue.pop(0)
            component.append(current)
            
            for neighbor in face_neighbors.get(current, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
        
        components.append(component)
    
    # Return the largest component
    if components:
        largest = max(components, key=len)
        print(f"[MeshSegmenter] Found {len(components)} components, largest has {len(largest)} faces (total was {len(face_indices)})", file=sys.stderr)
        return largest
    
    return face_indices


def get_remainder_faces(total_faces: int, extracted_faces: list) -> list:
    """Get all face indices NOT in the extracted set."""
    extracted_set = set(extracted_faces)
    return [i for i in range(total_faces) if i not in extracted_set]


def segment_mesh(mesh_path: str, surface_type: str, output_dir: str) -> dict:
    """
    Main segmentation function.
    
    Args:
        mesh_path: Path to input mesh (OBJ, GLB, PLY, etc.)
        surface_type: 'floor', 'walls', 'ceiling', 'countertops', or 'all'
        output_dir: Directory to save output files
        
    Returns:
        Dict with paths to generated files and metadata
    """
    if not HAS_TRIMESH:
        return {'error': 'trimesh not installed'}
    
    print(f"[MeshSegmenter] Loading mesh: {mesh_path}", file=sys.stderr)
    
    # Load mesh
    try:
        mesh = trimesh.load(mesh_path, process=False)
        
        # Handle scenes (GLB files often load as Scene)
        if isinstance(mesh, trimesh.Scene):
            # Combine all meshes in scene
            meshes = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
            if meshes:
                mesh = trimesh.util.concatenate(meshes)
            else:
                return {'error': 'No meshes found in scene'}
    except Exception as e:
        return {'error': f'Failed to load mesh: {str(e)}'}
    
    print(f"[MeshSegmenter] Mesh loaded: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces", file=sys.stderr)
    
    # Analyze faces
    classification = analyze_face_normals(mesh)
    
    print(f"[MeshSegmenter] Classification results:", file=sys.stderr)
    print(f"  - Floor faces: {len(classification['floor'])}", file=sys.stderr)
    print(f"  - Wall faces: {len(classification['walls'])}", file=sys.stderr)
    print(f"  - Ceiling faces: {len(classification['ceiling'])}", file=sys.stderr)
    print(f"  - Counter faces: {len(classification['countertops'])}", file=sys.stderr)
    
    # Create output directory
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    result = {
        'success': True,
        'input_mesh': mesh_path,
        'surface_type': surface_type,
        'total_faces': len(mesh.faces),
        'total_vertices': len(mesh.vertices),
        'segments': {},
        'bounds': classification['bounds'],
    }
    
    # Determine which surfaces to extract
    if surface_type == 'all':
        surfaces_to_extract = ['floor', 'walls', 'ceiling', 'countertops']
    else:
        surfaces_to_extract = [surface_type]
    
    # Extract requested surface(s)
    all_extracted_faces = []
    
    for surf in surfaces_to_extract:
        face_indices = classification.get(surf, [])
        
        if not face_indices:
            print(f"[MeshSegmenter] No faces found for surface type: {surf}", file=sys.stderr)
            continue
        
        # IMPORTANT: Find the largest connected component to eliminate shrapnel
        # This keeps only the main floor/surface, not scattered fragments
        if surf in ['floor', 'ceiling']:
            face_indices = find_largest_connected_component(mesh, face_indices)
        
        all_extracted_faces.extend(face_indices)
        
        # Extract segment mesh
        segment_mesh = extract_faces_as_mesh(mesh, face_indices)
        
        if segment_mesh is None:
            continue
        
        # Save segment
        segment_filename = f"{surf}_segment.obj"
        segment_path = output_path / segment_filename
        segment_mesh.export(str(segment_path), file_type='obj')
        
        result['segments'][surf] = {
            'path': str(segment_path),
            'filename': segment_filename,
            'face_count': len(face_indices),
            'vertex_count': len(segment_mesh.vertices),
            'bounds': {
                'min': segment_mesh.bounds[0].tolist(),
                'max': segment_mesh.bounds[1].tolist(),
            }
        }
        
        print(f"[MeshSegmenter] Saved {surf} segment: {segment_path}", file=sys.stderr)
    
    # Extract remainder (everything not in extracted surfaces)
    remainder_faces = get_remainder_faces(len(mesh.faces), all_extracted_faces)
    
    if remainder_faces:
        remainder_mesh = extract_faces_as_mesh(mesh, remainder_faces)
        
        if remainder_mesh is not None:
            remainder_path = output_path / "remainder.obj"
            remainder_mesh.export(str(remainder_path), file_type='obj')
            
            result['remainder'] = {
                'path': str(remainder_path),
                'filename': 'remainder.obj',
                'face_count': len(remainder_faces),
                'vertex_count': len(remainder_mesh.vertices),
            }
            
            print(f"[MeshSegmenter] Saved remainder: {remainder_path}", file=sys.stderr)
    
    # Save metadata
    metadata_path = output_path / "segmentation.json"
    with open(metadata_path, 'w') as f:
        json.dump(result, f, indent=2)
    
    result['metadata_path'] = str(metadata_path)
    
    return result


def main():
    parser = argparse.ArgumentParser(description='Segment a 3D mesh by surface type')
    parser.add_argument('mesh_path', help='Path to input mesh file')
    parser.add_argument('surface_type', choices=['floor', 'walls', 'ceiling', 'countertops', 'all'],
                        help='Surface type to extract')
    parser.add_argument('output_dir', help='Output directory for segmented meshes')
    
    args = parser.parse_args()
    
    result = segment_mesh(args.mesh_path, args.surface_type, args.output_dir)
    
    # Output JSON result to stdout for Node.js to parse
    print(json.dumps(result))
    
    return 0 if result.get('success') else 1


if __name__ == '__main__':
    sys.exit(main())
