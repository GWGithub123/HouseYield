#!/usr/bin/env python3
"""
Mesh Editor Service
Professional mesh editing using Open3D and Trimesh for:
- Furniture detection and removal
- Room reshaping (Boolean CSG operations)
- Mesh smoothing and hole filling
- Surface segmentation

Usage:
  python mesh_editor.py <command> <input_mesh> <output_mesh> [options]

Commands:
  remove_furniture   - Detect and remove furniture from room scan
  csg_subtract       - Subtract a shape from mesh (e.g., cut doorway)
  csg_union          - Combine two meshes
  smooth             - Apply Laplacian smoothing
  fill_holes         - Fill holes in mesh
  segment            - Segment mesh into surfaces
"""

import argparse
import json
import sys
import os
import numpy as np

# Check for required libraries
try:
    import open3d as o3d
    HAVE_OPEN3D = True
except ImportError:
    HAVE_OPEN3D = False
    print("[MeshEditor] Warning: Open3D not available", file=sys.stderr)

try:
    import trimesh
    HAVE_TRIMESH = True
except ImportError:
    HAVE_TRIMESH = False
    print("[MeshEditor] Warning: Trimesh not available", file=sys.stderr)


# ============================================================================
# Mesh Loading/Saving
# ============================================================================

def load_mesh(path):
    """Load mesh from OBJ/PLY/GLB file"""
    print(f"[MeshEditor] Loading mesh from: {path}")
    
    if HAVE_TRIMESH:
        mesh = trimesh.load(path, force='mesh')
        if isinstance(mesh, trimesh.Scene):
            # Combine all geometries in scene
            meshes = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
            if meshes:
                mesh = trimesh.util.concatenate(meshes)
            else:
                raise ValueError("No valid meshes in scene")
        print(f"[MeshEditor] Loaded: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")
        return mesh
    elif HAVE_OPEN3D:
        mesh = o3d.io.read_triangle_mesh(path)
        print(f"[MeshEditor] Loaded: {len(mesh.vertices)} vertices, {len(mesh.triangles)} triangles")
        return mesh
    else:
        raise ImportError("Neither Open3D nor Trimesh available")


def save_mesh(mesh, path, preserve_texture=True):
    """Save mesh to file"""
    print(f"[MeshEditor] Saving mesh to: {path}")
    
    if isinstance(mesh, trimesh.Trimesh):
        mesh.export(path)
    elif HAVE_OPEN3D and isinstance(mesh, o3d.geometry.TriangleMesh):
        o3d.io.write_triangle_mesh(path, mesh)
    else:
        raise ValueError(f"Unknown mesh type: {type(mesh)}")
    
    print(f"[MeshEditor] Saved successfully")


# ============================================================================
# Furniture Detection & Removal
# ============================================================================

def detect_furniture(mesh, floor_height=None, floor_tolerance=0.1, min_height=0.1, max_height=2.5):
    """
    Detect furniture as objects that:
    - Sit above the floor (not part of floor/walls/ceiling)
    - Are isolated clusters of faces
    - Have reasonable furniture dimensions
    
    Now auto-detects floor height if not provided!
    
    Returns: list of face indices belonging to furniture
    """
    print(f"[MeshEditor] Detecting furniture...")
    
    if isinstance(mesh, trimesh.Trimesh):
        vertices = mesh.vertices
        faces = mesh.faces
        face_normals = mesh.face_normals
    else:
        # Open3D mesh
        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        mesh.compute_triangle_normals()
        face_normals = np.asarray(mesh.triangle_normals)
    
    # Calculate face centers
    face_centers = vertices[faces].mean(axis=1)
    
    # Step 0: Auto-detect floor height if not provided
    # Find lowest horizontal surfaces (faces pointing up near the bottom of the mesh)
    up = np.array([0, 1, 0])
    down = np.array([0, -1, 0])
    
    if floor_height is None:
        # Find faces that point upward (potential floor candidates)
        upward_facing = np.dot(face_normals, up) > 0.7
        
        if np.any(upward_facing):
            # Get the heights of upward-facing faces
            upward_heights = face_centers[upward_facing, 1]
            
            # Floor is likely the cluster of lowest upward-facing faces
            # Use 10th percentile to avoid outliers
            floor_height = np.percentile(upward_heights, 10)
            print(f"[MeshEditor] Auto-detected floor height: {floor_height:.3f}")
        else:
            # No upward-facing surfaces - check if mesh might be rotated
            # Try to detect which axis is "up" based on bounding box
            bbox_min = vertices.min(axis=0)
            bbox_max = vertices.max(axis=0)
            bbox_size = bbox_max - bbox_min
            
            # Assume the smallest dimension is height if Z-up, otherwise Y-up
            if bbox_size[2] > bbox_size[1]:
                # Might be Z-up orientation
                print(f"[MeshEditor] Warning: Mesh may be Z-up oriented. Using lowest Z as floor.")
                up = np.array([0, 0, 1])
                down = np.array([0, 0, -1])
                floor_height = bbox_min[2]
            else:
                floor_height = bbox_min[1]
            print(f"[MeshEditor] Fallback floor height (bbox min): {floor_height:.3f}")
    
    print(f"[MeshEditor] Floor height: {floor_height:.3f}, tolerance: {floor_tolerance}")
    
    # Step 1: Identify floor/wall/ceiling faces by normal direction
    # Floor: faces pointing up, near floor level
    floor_facing = np.abs(np.dot(face_normals, up)) > 0.7
    near_floor = np.abs(face_centers[:, 1] - floor_height) < floor_tolerance
    floor_faces = floor_facing & near_floor
    
    # Get ceiling height (top of room)
    ceiling_height = np.percentile(face_centers[:, 1], 95)
    
    # Ceiling: faces pointing down, high up
    ceiling_facing = np.dot(face_normals, down) > 0.7
    high_up = face_centers[:, 1] > (ceiling_height - 0.5)
    ceiling_faces = ceiling_facing & high_up
    
    # Walls: faces pointing horizontally (normal has small Y component)
    horizontal_normal = np.sqrt(face_normals[:, 0]**2 + face_normals[:, 2]**2)
    vertical_normal = np.abs(face_normals[:, 1])
    wall_faces = horizontal_normal > 0.7  # Normal is mostly horizontal = vertical wall
    
    # Everything else is potentially furniture
    structural_faces = floor_faces | ceiling_faces | wall_faces
    furniture_candidates = ~structural_faces
    
    # Step 2: Cluster connected faces to find distinct objects
    furniture_face_indices = np.where(furniture_candidates)[0]
    
    print(f"[MeshEditor] Found {len(furniture_face_indices)} potential furniture faces")
    print(f"[MeshEditor] Floor faces: {np.sum(floor_faces)}")
    print(f"[MeshEditor] Wall faces: {np.sum(wall_faces)}")
    print(f"[MeshEditor] Ceiling faces: {np.sum(ceiling_faces)}")
    
    # Additional filtering: remove faces that are too low (floor fragments)
    # or too high (ceiling fragments)
    face_heights = face_centers[furniture_candidates, 1]
    valid_height = (face_heights > floor_height + min_height) & \
                   (face_heights < ceiling_height - 0.1)
    
    final_furniture = furniture_face_indices[valid_height]
    
    print(f"[MeshEditor] Final furniture faces after height filter: {len(final_furniture)}")
    print(f"[MeshEditor] Height range for furniture: {floor_height + min_height:.2f} to {ceiling_height - 0.1:.2f}")
    
    return final_furniture.tolist(), floor_height, ceiling_height


def remove_faces(mesh, face_indices):
    """Remove specified faces from mesh while preserving UVs and vertex data"""
    print(f"[MeshEditor] Removing {len(face_indices)} faces...")
    
    if isinstance(mesh, trimesh.Trimesh):
        # Create mask for faces to keep
        keep_mask = np.ones(len(mesh.faces), dtype=bool)
        keep_mask[face_indices] = False
        faces_to_keep = np.where(keep_mask)[0]
        
        # Get the faces we're keeping
        new_faces = mesh.faces[faces_to_keep].copy()
        
        # Find which vertices are actually used by the remaining faces
        used_vertices = np.unique(new_faces.flatten())
        
        # Create a mapping from old vertex indices to new ones
        vertex_map = np.full(len(mesh.vertices), -1, dtype=np.int64)
        vertex_map[used_vertices] = np.arange(len(used_vertices))
        
        # Get the vertices we're keeping
        new_vertices = mesh.vertices[used_vertices].copy()
        
        # Remap face vertex indices
        new_faces = vertex_map[new_faces]
        
        # Handle visual attributes (UVs, vertex colors, etc.)
        visual = None
        if hasattr(mesh, 'visual') and mesh.visual is not None:
            try:
                if hasattr(mesh.visual, 'uv') and mesh.visual.uv is not None:
                    # For TextureVisuals with per-vertex UVs
                    new_uv = mesh.visual.uv[used_vertices].copy()
                    if hasattr(mesh.visual, 'material'):
                        visual = trimesh.visual.TextureVisuals(
                            uv=new_uv,
                            material=mesh.visual.material
                        )
                    else:
                        visual = trimesh.visual.TextureVisuals(uv=new_uv)
                elif hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
                    # For ColorVisuals
                    new_colors = mesh.visual.vertex_colors[used_vertices].copy()
                    visual = trimesh.visual.ColorVisuals(vertex_colors=new_colors)
            except Exception as e:
                print(f"[MeshEditor] Warning: Could not preserve visual attributes: {e}")
        
        # Create new mesh with preserved data
        new_mesh = trimesh.Trimesh(
            vertices=new_vertices,
            faces=new_faces,
            visual=visual,
            process=False  # Don't process - keeps original topology
        )
        
        # Minimal cleanup - only remove truly degenerate faces
        if hasattr(new_mesh, 'remove_degenerate_faces'):
            new_mesh.remove_degenerate_faces()
        
        print(f"[MeshEditor] Result: {len(new_mesh.vertices)} vertices, {len(new_mesh.faces)} faces")
        return new_mesh
    else:
        # Open3D
        triangles = np.asarray(mesh.triangles)
        keep_mask = np.ones(len(triangles), dtype=bool)
        keep_mask[face_indices] = False
        
        mesh.triangles = o3d.utility.Vector3iVector(triangles[keep_mask])
        mesh.remove_unreferenced_vertices()
        
        return mesh


def remove_furniture(input_path, output_path, floor_height=None, aggressive=False):
    """
    Main function: detect and remove furniture from a room scan
    
    Args:
        input_path: Path to input mesh (OBJ/PLY)
        output_path: Path to save result
        floor_height: Y coordinate of floor (None = auto-detect)
        aggressive: If True, remove more aggressively
    
    Returns:
        dict with stats about removed furniture
    """
    mesh = load_mesh(input_path)
    
    # Detect furniture faces (now auto-detects floor height if None)
    min_height = 0.05 if aggressive else 0.15
    furniture_faces, detected_floor, detected_ceiling = detect_furniture(
        mesh, 
        floor_height=floor_height,  # None means auto-detect
        floor_tolerance=0.2 if aggressive else 0.3,
        min_height=min_height
    )
    
    if not furniture_faces:
        print("[MeshEditor] No furniture detected")
        save_mesh(mesh, output_path)
        return {
            "removed_faces": 0, 
            "success": True,
            "floor_height": detected_floor,
            "ceiling_height": detected_ceiling,
        }
    
    # Remove furniture
    clean_mesh = remove_faces(mesh, furniture_faces)
    
    # Optionally fill holes left by furniture
    if HAVE_TRIMESH and isinstance(clean_mesh, trimesh.Trimesh):
        # Try to fill small holes
        try:
            trimesh.repair.fill_holes(clean_mesh)
            print("[MeshEditor] Filled holes after furniture removal")
        except:
            pass
    
    save_mesh(clean_mesh, output_path)
    
    return {
        "removed_faces": len(furniture_faces),
        "original_faces": len(mesh.faces) if hasattr(mesh, 'faces') else len(mesh.triangles),
        "remaining_faces": len(clean_mesh.faces) if hasattr(clean_mesh, 'faces') else len(clean_mesh.triangles),
        "floor_height": detected_floor,
        "ceiling_height": detected_ceiling,
        "success": True
    }


# ============================================================================
# Boolean CSG Operations (Room Reshaping)
# ============================================================================

def create_box(center, size):
    """Create a box mesh for CSG operations"""
    if HAVE_TRIMESH:
        box = trimesh.primitives.Box(extents=size)
        box.apply_translation(center)
        return box
    elif HAVE_OPEN3D:
        box = o3d.geometry.TriangleMesh.create_box(
            width=size[0], height=size[1], depth=size[2]
        )
        box.translate(np.array(center) - np.array(size) / 2)
        return box


def create_cylinder(center, radius, height, axis='y'):
    """Create a cylinder mesh (e.g., for columns, pipes)"""
    if HAVE_TRIMESH:
        cylinder = trimesh.primitives.Cylinder(radius=radius, height=height)
        if axis == 'x':
            cylinder.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [0, 0, 1]))
        elif axis == 'z':
            cylinder.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [1, 0, 0]))
        cylinder.apply_translation(center)
        return cylinder
    else:
        raise NotImplementedError("Cylinder not implemented for Open3D")


def csg_subtract(mesh, tool_mesh):
    """Subtract tool_mesh from mesh (e.g., cut a doorway)"""
    print("[MeshEditor] Performing CSG subtraction...")
    
    if HAVE_TRIMESH:
        if isinstance(mesh, str):
            mesh = load_mesh(mesh)
        if isinstance(tool_mesh, str):
            tool_mesh = load_mesh(tool_mesh)
        
        result = mesh.difference(tool_mesh, engine='blender')
        print(f"[MeshEditor] CSG result: {len(result.vertices)} vertices, {len(result.faces)} faces")
        return result
    else:
        raise NotImplementedError("CSG requires Trimesh with Blender backend")


def csg_union(mesh1, mesh2):
    """Combine two meshes"""
    print("[MeshEditor] Performing CSG union...")
    
    if HAVE_TRIMESH:
        if isinstance(mesh1, str):
            mesh1 = load_mesh(mesh1)
        if isinstance(mesh2, str):
            mesh2 = load_mesh(mesh2)
        
        result = mesh1.union(mesh2, engine='blender')
        return result
    else:
        raise NotImplementedError("CSG requires Trimesh")


def cut_opening(input_path, output_path, opening_type, position, size, normalize_coords=True):
    """
    Cut an opening in a wall (doorway, window, etc.)
    
    Instead of CSG (which requires Blender), we simply remove all faces
    whose centers fall within the bounding box of the opening.
    This works well for photogrammetry meshes.
    
    Args:
        input_path: Path to room mesh
        output_path: Path to save result
        opening_type: 'door', 'window', 'arch'
        position: [x, y, z] center of opening (in viewer space if normalize_coords=True)
        size: [width, height, depth] of opening (in viewer space if normalize_coords=True)
        normalize_coords: If True, transform viewer coordinates to mesh coordinates
    """
    mesh = load_mesh(input_path)
    
    if isinstance(mesh, trimesh.Trimesh):
        vertices = mesh.vertices
        faces = mesh.faces
    else:
        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
    
    # Get mesh bounding box
    mesh_min = vertices.min(axis=0)
    mesh_max = vertices.max(axis=0)
    mesh_center = (mesh_min + mesh_max) / 2
    mesh_size = mesh_max - mesh_min
    
    print(f"[MeshEditor] Mesh bounds:")
    print(f"[MeshEditor]   Min: {mesh_min}")
    print(f"[MeshEditor]   Max: {mesh_max}")
    print(f"[MeshEditor]   Center: {mesh_center}")
    print(f"[MeshEditor]   Size: {mesh_size}")
    print(f"[MeshEditor] Input position (viewer coords): {position}")
    print(f"[MeshEditor] Input size (viewer coords): {size}")
    
    # Transform viewer coordinates to mesh coordinates
    # The viewer applies these transforms in order:
    # 1. Center geometry at origin: translate by -original_center
    # 2. Flip upside down: rotate 180° around X (negates Y and Z)
    # 3. Re-center X/Z and put floor at Y=0
    # 4. Scale to fit within 20 units
    #
    # To reverse (viewer coords -> mesh coords):
    # 1. Unscale: multiply by (max_dim / 20)
    # 2. The rotation + translation is complex, so we use a heuristic:
    #    Map viewer Y (0 to ~height) to mesh's vertical range
    
    if normalize_coords:
        # Estimate the scale factor the viewer used
        max_dim = max(mesh_size)
        viewer_scale = 20.0 / max_dim if max_dim > 20 else 1.0
        
        print(f"[MeshEditor] Estimated viewer scale: {viewer_scale}")
        
        # Unscale the position and size
        pos = np.array(position) / viewer_scale
        sz = np.array(size) / viewer_scale
        
        # The viewer flips the mesh (rotates 180° around X axis)
        # This negates both Y and Z components
        # After flip, floor is at Y=0 in viewer space, which maps to mesh's max Y
        # So: viewer_y=0 -> mesh_y=mesh_max_y, viewer_y=h -> mesh_y=mesh_max_y-h
        pos[1] = mesh_max[1] - pos[1]  # Flip Y
        pos[2] = -pos[2]  # Flip Z (rotation around X negates Z too)
        
        # Add mesh center offset for X (viewer centers mesh at X=0)
        pos[0] = pos[0] + mesh_center[0]
        pos[2] = pos[2] + mesh_center[2]
        
        print(f"[MeshEditor] Transformed position (mesh coords): {pos}")
        print(f"[MeshEditor] Transformed size (mesh coords): {sz}")
        
        position = pos.tolist()
        size = sz.tolist()
    
    # Calculate face centers
    face_centers = vertices[faces].mean(axis=1)
    
    # Define bounding box for the opening
    if opening_type == 'door':
        # Door extends from position up by height
        box_min = np.array([
            position[0] - size[0]/2,
            position[1],  # Start from floor at position
            position[2] - size[2]/2
        ])
        box_max = np.array([
            position[0] + size[0]/2,
            position[1] + size[1],  # Up to door height
            position[2] + size[2]/2
        ])
    else:
        # Window/other: centered at position
        box_min = np.array([
            position[0] - size[0]/2,
            position[1] - size[1]/2,
            position[2] - size[2]/2
        ])
        box_max = np.array([
            position[0] + size[0]/2,
            position[1] + size[1]/2,
            position[2] + size[2]/2
        ])
    
    print(f"[MeshEditor] Cutting {opening_type} opening:")
    print(f"[MeshEditor]   Box min: {box_min}")
    print(f"[MeshEditor]   Box max: {box_max}")
    
    # Find faces inside the box
    inside_box = np.all(
        (face_centers >= box_min) & (face_centers <= box_max),
        axis=1
    )
    
    faces_to_remove = np.where(inside_box)[0]
    print(f"[MeshEditor] Found {len(faces_to_remove)} faces inside opening region")
    
    if len(faces_to_remove) == 0:
        print("[MeshEditor] Warning: No faces found in opening region. Check position/size.")
        # Save unchanged mesh
        save_mesh(mesh, output_path)
        return {
            "opening_type": opening_type,
            "position": list(position),
            "size": list(size),
            "removed_faces": 0,
            "warning": "No faces found in opening region",
            "success": True
        }
    
    # Remove the faces
    result = remove_faces(mesh, faces_to_remove.tolist())
    save_mesh(result, output_path)
    
    return {
        "opening_type": opening_type,
        "position": list(position),
        "size": list(size),
        "removed_faces": len(faces_to_remove),
        "success": True
    }


# ============================================================================
# Polygon Hole Cutting (Precision Measured Cuts)
# ============================================================================

def cut_polygon_hole(input_path, output_path, points_file):
    """
    Cut a polygon-shaped hole in a mesh using precisely measured points.
    
    This function takes a set of 3D points that define a polygon on a wall surface,
    then removes all mesh faces that fall within the extruded polygon volume.
    
    IMPORTANT: The viewer applies transformations to the mesh (centering, rotation, 
    floor alignment). The polygon points are in this transformed space. We must
    apply the same transformations to the mesh before cutting, then inverse after.
    
    Args:
        input_path: Path to input mesh
        output_path: Path to save result
        points_file: JSON file containing polygon points and settings
        
    The JSON file format:
    {
        "points": [
            { "position": [x, y, z], "normal": [nx, ny, nz] or null },
            ...
        ],
        "extrudeDepth": 0.5,  // How deep to extrude the cut
        "smoothEdges": true   // Whether to smooth edges after cutting
    }
    """
    import json
    from scipy.spatial.transform import Rotation
    
    # Load the points file
    with open(points_file, 'r') as f:
        data = json.load(f)
    
    points = data.get('points', [])
    extrude_depth = data.get('extrudeDepth', 0.5)
    smooth_edges = data.get('smoothEdges', True)
    viewer_scale = data.get('viewerScale', 1.0)  # Scale applied by viewer
    
    if len(points) < 3:
        raise ValueError(f"Need at least 3 points for polygon, got {len(points)}")
    
    print(f"[MeshEditor] Cutting polygon hole with {len(points)} points")
    print(f"[MeshEditor] Extrude depth: {extrude_depth}")
    print(f"[MeshEditor] Viewer scale: {viewer_scale}")
    
    mesh = load_mesh(input_path)
    
    if isinstance(mesh, trimesh.Trimesh):
        vertices = mesh.vertices.copy()
        faces = mesh.faces
    else:
        vertices = np.asarray(mesh.vertices).copy()
        faces = np.asarray(mesh.triangles)
    
    # =========================================================================
    # STEP 1: Apply the same transformations as PhotogrammetryViewer
    # This matches the OBJMesh loading transforms in PhotogrammetryViewer.tsx
    # CRITICAL: Use bounding box center (like Three.js), not center of mass!
    # =========================================================================
    
    # Calculate original bounding box (Three.js uses bbox center, not centroid)
    original_min = np.min(vertices, axis=0)
    original_max = np.max(vertices, axis=0)
    original_center = (original_min + original_max) / 2.0  # Bbox center, not centroid!
    original_size = original_max - original_min
    original_max_dim = np.max(original_size)
    print(f"[MeshEditor] Original bbox center: {original_center}")
    print(f"[MeshEditor] Original bounds: min={original_min}, max={original_max}")
    print(f"[MeshEditor] Original max dimension: {original_max_dim}")
    
    # Step 1a: Center at origin (translate by -center)
    vertices_transformed = vertices - original_center
    
    # Step 1b: Rotate 180° around X axis (same as mesh.geometry.rotateX(Math.PI))
    rotation_matrix = np.array([
        [1,  0,  0],
        [0, -1,  0],
        [0,  0, -1]
    ])
    vertices_transformed = vertices_transformed @ rotation_matrix.T
    
    # Step 1c: Re-center X/Z after rotation (recalculate bbox center)
    new_min = np.min(vertices_transformed, axis=0)
    new_max = np.max(vertices_transformed, axis=0)
    new_center = (new_min + new_max) / 2.0
    vertices_transformed[:, 0] -= new_center[0]  # Center X
    vertices_transformed[:, 2] -= new_center[2]  # Center Z
    # Keep Y as is
    
    # Step 1d: Put floor at Y=0
    floor_y = np.min(vertices_transformed[:, 1])
    vertices_transformed[:, 1] -= floor_y
    
    # Step 1e: Apply scale if the original mesh was scaled down
    # The viewer scales meshes where maxDim > 20 by factor: 20/maxDim
    # But the click coordinates are in the SCALED space, so we need to scale our vertices too
    
    # Calculate what scale the viewer SHOULD apply based on mesh dimensions
    # IMPORTANT: Use our own calculated scale, NOT the frontend value which may be stale
    calculated_viewer_scale = 1.0
    if original_max_dim > 20:
        calculated_viewer_scale = 20.0 / original_max_dim
    print(f"[MeshEditor] Calculated viewer scale (20/maxDim): {calculated_viewer_scale}")
    print(f"[MeshEditor] Passed viewer scale from frontend: {viewer_scale}")
    
    # Use calculated scale instead of passed scale (frontend may have stale ref)
    actual_scale = calculated_viewer_scale
    if actual_scale != 1.0 and actual_scale > 0:
        vertices_transformed = vertices_transformed * actual_scale
        print(f"[MeshEditor] Applied calculated viewer scale {actual_scale} to vertices")
    
    # Debug: Show transformed mesh bounds after scaling
    print(f"[MeshEditor] After viewer transforms - bbox center: {(np.min(vertices_transformed, axis=0) + np.max(vertices_transformed, axis=0)) / 2}")
    print(f"[MeshEditor] After viewer transforms - bounds: min={np.min(vertices_transformed, axis=0)}, max={np.max(vertices_transformed, axis=0)}")
    
    # =========================================================================
    # STEP 2: Perform the polygon hole cut on transformed vertices
    # =========================================================================
    
    # Extract polygon vertices (these are in the transformed coordinate space)
    polygon_points = np.array([p['position'] for p in points])
    print(f"[MeshEditor] Polygon points (in viewer space): {polygon_points}")
    
    # Calculate the average normal from provided normals, or compute from points
    normals = [p.get('normal') for p in points if p.get('normal')]
    if normals:
        avg_normal = np.mean(normals, axis=0)
        avg_normal = avg_normal / np.linalg.norm(avg_normal)
    else:
        # Compute normal from polygon plane using first 3 points
        v1 = polygon_points[1] - polygon_points[0]
        v2 = polygon_points[2] - polygon_points[0]
        avg_normal = np.cross(v1, v2)
        avg_normal = avg_normal / np.linalg.norm(avg_normal)
    
    print(f"[MeshEditor] Average surface normal: {avg_normal}")
    
    # Calculate polygon center
    polygon_center = np.mean(polygon_points, axis=0)
    print(f"[MeshEditor] Polygon center: {polygon_center}")
    
    # Transform polygon to 2D for point-in-polygon testing
    # Create a local coordinate system on the polygon plane
    # Use the first edge as the X axis
    local_x = polygon_points[1] - polygon_points[0]
    local_x = local_x / np.linalg.norm(local_x)
    local_y = np.cross(avg_normal, local_x)
    local_y = local_y / np.linalg.norm(local_y)
    
    # Project polygon points to 2D
    polygon_2d = []
    for pt in polygon_points:
        rel = pt - polygon_center
        x = np.dot(rel, local_x)
        y = np.dot(rel, local_y)
        polygon_2d.append([x, y])
    polygon_2d = np.array(polygon_2d)
    
    print(f"[MeshEditor] Polygon 2D coords: {polygon_2d}")
    
    # Calculate face centers using TRANSFORMED vertices
    face_centers = vertices_transformed[faces].mean(axis=1)
    
    # Debug: Find faces near the polygon region
    # First, let's check how many faces are near the polygon center at all
    polygon_bbox_min = np.min(polygon_points, axis=0)
    polygon_bbox_max = np.max(polygon_points, axis=0)
    print(f"[MeshEditor] Polygon bounding box: min={polygon_bbox_min}, max={polygon_bbox_max}")
    
    # Also show transformed mesh bounds to check overlap
    transformed_min = np.min(vertices_transformed, axis=0)
    transformed_max = np.max(vertices_transformed, axis=0)
    print(f"[MeshEditor] Transformed mesh bounds: min={transformed_min}, max={transformed_max}")
    
    # Check if polygon is even within mesh bounds
    overlap = True
    for axis in range(3):
        if polygon_bbox_max[axis] < transformed_min[axis] or polygon_bbox_min[axis] > transformed_max[axis]:
            overlap = False
            print(f"[MeshEditor] WARNING: No overlap on axis {['X', 'Y', 'Z'][axis]}!")
    
    if not overlap:
        print("[MeshEditor] ERROR: Polygon is completely outside mesh bounds!")
        print("[MeshEditor] This suggests coordinate transform mismatch between viewer and Python")
    
    # Use a moderate bounding box margin - enough to find nearby faces but not too large
    # to catch unrelated surfaces. 0.5 units in scaled space is about 1.8m in real space
    bbox_margin = 0.5
    print(f"[MeshEditor] Using bbox margin: {bbox_margin}")
    
    nearby_faces = []
    for i, center in enumerate(face_centers):
        if (center[0] >= polygon_bbox_min[0] - bbox_margin and 
            center[0] <= polygon_bbox_max[0] + bbox_margin and
            center[1] >= polygon_bbox_min[1] - bbox_margin and 
            center[1] <= polygon_bbox_max[1] + bbox_margin and
            center[2] >= polygon_bbox_min[2] - bbox_margin and 
            center[2] <= polygon_bbox_max[2] + bbox_margin):
            nearby_faces.append(i)
    
    print(f"[MeshEditor] Faces within bbox margin of polygon bbox: {len(nearby_faces)}")
    
    if len(nearby_faces) > 0 and len(nearby_faces) <= 10:
        print(f"[MeshEditor] Nearby face centers: {[face_centers[i].tolist() for i in nearby_faces[:5]]}")
    
    # For each face, check if its center is:
    # 1. Within the extrusion depth of the polygon plane (both directions)
    # 2. Inside the 2D polygon when projected
    
    # Use a small extrude depth - we only want to remove faces ON the surface
    # 0.3 units in scaled space is about 1m in real space for walls
    effective_extrude_depth = 0.3
    print(f"[MeshEditor] Using effective extrude depth: {effective_extrude_depth}")
    
    faces_to_remove = []
    faces_near_plane = 0
    faces_inside_polygon = 0
    
    # Debug: Sample some face projections
    debug_projections = []
    nearby_faces_near_plane = 0
    
    # Debug: Show plane distances for all nearby faces
    if len(nearby_faces) > 0:
        print(f"[MeshEditor] Checking plane distance for {len(nearby_faces)} nearby faces:")
        nearby_plane_dists = []
        for i in nearby_faces[:20]:  # Check first 20
            center = face_centers[i]
            vec_to_plane = center - polygon_center
            dist = abs(np.dot(vec_to_plane, avg_normal))
            nearby_plane_dists.append((i, dist, center.tolist()))
        nearby_plane_dists.sort(key=lambda x: x[1])  # Sort by distance
        for idx, dist, center in nearby_plane_dists[:10]:
            print(f"  Face {idx}: dist={dist:.3f}, 3D={[f'{c:.2f}' for c in center]}")
    
    # OPTIMIZATION: Only check faces within the polygon's 3D bounding box
    # This dramatically reduces computation and avoids false positives from
    # faces that happen to be at the right distance on the infinite plane
    
    # Get face normals and TRANSFORM them to match the vertex transformation
    # The viewer rotates 180° around X, which also rotates the normals
    if isinstance(mesh, trimesh.Trimesh):
        original_face_normals = mesh.face_normals.copy()
    else:
        # For Open3D, compute face normals manually
        triangles = np.asarray(mesh.triangles)
        vertices_arr = np.asarray(mesh.vertices)
        v0 = vertices_arr[triangles[:, 0]]
        v1 = vertices_arr[triangles[:, 1]]
        v2 = vertices_arr[triangles[:, 2]]
        original_face_normals = np.cross(v1 - v0, v2 - v0)
        original_face_normals = original_face_normals / (np.linalg.norm(original_face_normals, axis=1, keepdims=True) + 1e-10)
    
    # Apply the same 180° X-axis rotation to normals as we did to vertices
    # rotation_matrix was defined earlier as [[1,0,0], [0,-1,0], [0,0,-1]]
    face_normals = original_face_normals @ rotation_matrix.T
    print(f"[MeshEditor] Transformed face normals to match viewer rotation")
    
    # Minimum dot product for face normal to be "similar" to polygon normal
    # cos(60°) = 0.5, so faces within 60° of the polygon plane are included
    NORMAL_SIMILARITY_THRESHOLD = 0.5
    
    # Debug: Show the polygon normal we're comparing against
    print(f"[MeshEditor] Polygon plane normal (viewer space): {avg_normal}")
    
    # Track rejection reasons for debugging
    faces_rejected_by_normal = 0
    faces_rejected_by_vertex_spread = 0
    
    # Calculate polygon 2D bounding box with small margin for vertex check
    poly_2d_min = np.min(polygon_2d, axis=0) - 0.1
    poly_2d_max = np.max(polygon_2d, axis=0) + 0.1
    
    for i in nearby_faces:
        center = face_centers[i]
        
        # Distance from face center to polygon plane (signed distance)
        vec_to_plane = center - polygon_center
        signed_dist = np.dot(vec_to_plane, avg_normal)
        dist_to_plane = abs(signed_dist)
        
        # Check if within extrusion depth (either side of the plane)
        if dist_to_plane > effective_extrude_depth:
            continue
        
        # Check if face normal is similar to polygon normal (same surface)
        # This prevents removing faces from other surfaces that happen to be nearby
        face_normal = face_normals[i]
        normal_similarity = abs(np.dot(face_normal, avg_normal))
        if normal_similarity < NORMAL_SIMILARITY_THRESHOLD:
            faces_rejected_by_normal += 1
            continue
        
        # NEW CHECK: Verify ALL 3 vertices of the face are within a reasonable
        # distance of the polygon region. This prevents thin "spider web" triangles
        # that stretch across the mesh but happen to have their center in the polygon.
        face_vertex_indices = faces[i]
        face_vertices = vertices_transformed[face_vertex_indices]  # 3x3 array
        
        # Check that all vertices are close to the polygon plane
        all_vertices_near_plane = True
        max_vertex_plane_dist = 0
        for v in face_vertices:
            v_dist = abs(np.dot(v - polygon_center, avg_normal))
            max_vertex_plane_dist = max(max_vertex_plane_dist, v_dist)
            if v_dist > effective_extrude_depth * 2:  # Allow slightly more tolerance for vertices
                all_vertices_near_plane = False
                break
        
        if not all_vertices_near_plane:
            faces_rejected_by_vertex_spread += 1
            continue
        
        # Check that all vertices project to within or near the polygon 2D bounds
        all_vertices_near_polygon = True
        for v in face_vertices:
            rel = v - polygon_center
            vx = np.dot(rel, local_x)
            vy = np.dot(rel, local_y)
            # Allow margin of 0.5 units beyond polygon bounds
            margin = 0.5
            if vx < poly_2d_min[0] - margin or vx > poly_2d_max[0] + margin:
                all_vertices_near_polygon = False
                break
            if vy < poly_2d_min[1] - margin or vy > poly_2d_max[1] + margin:
                all_vertices_near_polygon = False
                break
        
        if not all_vertices_near_polygon:
            faces_rejected_by_vertex_spread += 1
            continue
        
        nearby_faces_near_plane += 1
        
        # Project face center to polygon plane for 2D test
        rel = center - polygon_center
        x = np.dot(rel, local_x)
        y = np.dot(rel, local_y)
        
        # Debug: capture first few projections
        if len(debug_projections) < 10:
            debug_projections.append({
                'face_idx': i,
                'center_3d': center.tolist(),
                'projected_2d': [x, y],
                'dist_to_plane': dist_to_plane
            })
        
        # Point-in-polygon test (ray casting algorithm)
        if point_in_polygon(x, y, polygon_2d):
            faces_inside_polygon += 1
            faces_to_remove.append(i)
    
    print(f"[MeshEditor] Nearby faces within extrude depth: {nearby_faces_near_plane}")
    print(f"[MeshEditor] Faces rejected by normal check: {faces_rejected_by_normal}")
    print(f"[MeshEditor] Faces rejected by vertex spread: {faces_rejected_by_vertex_spread}")
    print(f"[MeshEditor] Faces inside 2D polygon: {faces_inside_polygon}")
    print(f"[MeshEditor] Found {len(faces_to_remove)} faces to remove")
    
    # Debug output
    if nearby_faces_near_plane > 0 and faces_inside_polygon == 0:
        print(f"[MeshEditor] DEBUG: Sample projected face centers:")
        for proj in debug_projections[:5]:
            print(f"  Face {proj['face_idx']}: 3D={proj['center_3d']}, 2D={proj['projected_2d']}, dist={proj['dist_to_plane']:.3f}")
        
        # Calculate the bounding box of projected nearby faces
        all_projected = []
        for i in nearby_faces:
            center = face_centers[i]
            vec_to_plane = center - polygon_center
            dist_to_plane = abs(np.dot(vec_to_plane, avg_normal))
            if dist_to_plane <= effective_extrude_depth:
                rel = center - polygon_center
                x = np.dot(rel, local_x)
                y = np.dot(rel, local_y)
                all_projected.append([x, y])
        
        if all_projected:
            all_projected = np.array(all_projected)
            print(f"[MeshEditor] DEBUG: Projected nearby faces bbox: min={np.min(all_projected, axis=0)}, max={np.max(all_projected, axis=0)}")
            print(f"[MeshEditor] DEBUG: Polygon 2D bbox: min={np.min(polygon_2d, axis=0)}, max={np.max(polygon_2d, axis=0)}")
    
    if len(faces_to_remove) == 0:
        print("[MeshEditor] Warning: No faces found in polygon region")
        save_mesh(mesh, output_path)
        return {
            "success": True,
            "removed_faces": 0,
            "original_faces": len(faces),
            "remaining_faces": len(faces),
            "polygon_points": len(points),
            "warning": "No faces found in polygon region"
        }
    
    original_faces = len(faces)
    
    # Remove the faces
    result = remove_faces(mesh, faces_to_remove)
    
    # NOTE: Laplacian smoothing was causing mesh distortion (changing vertex positions)
    # which led to spider web artifacts when the viewer re-loaded the mesh.
    # Disabled for now - the face removal should be clean on its own.
    # if smooth_edges and HAVE_TRIMESH and isinstance(result, trimesh.Trimesh):
    #     try:
    #         trimesh.smoothing.filter_laplacian(result, iterations=1)
    #     except Exception as e:
    #         print(f"[MeshEditor] Edge smoothing failed: {e}")
    
    save_mesh(result, output_path)
    
    remaining_faces = len(result.faces) if isinstance(result, trimesh.Trimesh) else len(np.asarray(result.triangles))
    
    return {
        "success": True,
        "removed_faces": len(faces_to_remove),
        "original_faces": original_faces,
        "remaining_faces": remaining_faces,
        "polygon_points": len(points),
        "extrude_depth": extrude_depth
    }


def point_in_polygon(x, y, polygon):
    """
    Ray casting algorithm for point-in-polygon test.
    Returns True if point (x, y) is inside the polygon.
    """
    n = len(polygon)
    inside = False
    
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        
        j = i
    
    return inside


# ============================================================================
# Mesh Repair & Smoothing
# ============================================================================

def smooth_mesh(mesh, iterations=3, lambda_factor=0.5):
    """Apply Laplacian smoothing to reduce noise/artifacts"""
    print(f"[MeshEditor] Smoothing mesh ({iterations} iterations)...")
    
    if HAVE_OPEN3D:
        if isinstance(mesh, trimesh.Trimesh):
            # Convert trimesh to Open3D
            o3d_mesh = o3d.geometry.TriangleMesh()
            o3d_mesh.vertices = o3d.utility.Vector3dVector(mesh.vertices)
            o3d_mesh.triangles = o3d.utility.Vector3iVector(mesh.faces)
            mesh = o3d_mesh
        
        smoothed = mesh.filter_smooth_laplacian(
            number_of_iterations=iterations,
            lambda_filter=lambda_factor
        )
        return smoothed
    
    elif HAVE_TRIMESH:
        # Trimesh smoothing
        trimesh.smoothing.filter_laplacian(mesh, iterations=iterations)
        return mesh


def fill_holes(mesh, max_hole_size=100):
    """Fill holes in mesh"""
    print(f"[MeshEditor] Filling holes (max size: {max_hole_size})...")
    
    if HAVE_TRIMESH and isinstance(mesh, trimesh.Trimesh):
        trimesh.repair.fill_holes(mesh)
        return mesh
    
    elif HAVE_OPEN3D:
        # Open3D hole filling is more complex
        # For now, just return as-is
        return mesh


# ============================================================================
# Surface Segmentation
# ============================================================================

def segment_surfaces(input_path, output_path=None):
    """
    Segment mesh into distinct surfaces (floor, walls, ceiling, furniture)
    
    Returns JSON with segmentation data
    """
    mesh = load_mesh(input_path)
    
    if isinstance(mesh, trimesh.Trimesh):
        vertices = mesh.vertices
        faces = mesh.faces
        face_normals = mesh.face_normals
    else:
        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        mesh.compute_triangle_normals()
        face_normals = np.asarray(mesh.triangle_normals)
    
    # Calculate face centers
    face_centers = vertices[faces].mean(axis=1)
    
    # Classify by normal direction
    up = np.array([0, 1, 0])
    
    segments = {
        'floors': [],
        'ceilings': [],
        'walls': [],
        'other': []
    }
    
    for i, (normal, center) in enumerate(zip(face_normals, face_centers)):
        dot_up = np.dot(normal, up)
        horizontal = np.sqrt(normal[0]**2 + normal[2]**2)
        
        if dot_up > 0.7 and center[1] < 0.5:  # Facing up, low
            segments['floors'].append(i)
        elif dot_up < -0.7 and center[1] > 2.0:  # Facing down, high
            segments['ceilings'].append(i)
        elif horizontal > 0.7:  # Mostly horizontal normal = vertical wall
            segments['walls'].append(i)
        else:
            segments['other'].append(i)
    
    result = {
        'floor_faces': len(segments['floors']),
        'ceiling_faces': len(segments['ceilings']),
        'wall_faces': len(segments['walls']),
        'other_faces': len(segments['other']),
        'total_faces': len(faces),
        'segments': segments
    }
    
    if output_path:
        with open(output_path, 'w') as f:
            # Don't save full face lists, just counts
            json.dump({k: v for k, v in result.items() if k != 'segments'}, f, indent=2)
    
    print(f"[MeshEditor] Segmentation complete:")
    print(f"  - Floors: {len(segments['floors'])} faces")
    print(f"  - Walls: {len(segments['walls'])} faces")
    print(f"  - Ceilings: {len(segments['ceilings'])} faces")
    print(f"  - Other: {len(segments['other'])} faces")
    
    return result


# ============================================================================
# CLI Interface
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description='Mesh Editor for Room Scans')
    subparsers = parser.add_subparsers(dest='command', help='Command to run')
    
    # Remove furniture command
    p_furniture = subparsers.add_parser('remove_furniture', help='Remove furniture from room scan')
    p_furniture.add_argument('input', help='Input mesh file')
    p_furniture.add_argument('output', help='Output mesh file')
    p_furniture.add_argument('--floor-height', type=float, default=0.0, help='Floor Y coordinate')
    p_furniture.add_argument('--aggressive', action='store_true', help='Remove more aggressively')
    
    # CSG subtract command
    p_csg = subparsers.add_parser('csg_subtract', help='Subtract shape from mesh')
    p_csg.add_argument('input', help='Input mesh file')
    p_csg.add_argument('output', help='Output mesh file')
    p_csg.add_argument('--tool', help='Tool mesh file to subtract')
    p_csg.add_argument('--box', nargs=6, type=float, metavar=('X', 'Y', 'Z', 'W', 'H', 'D'),
                       help='Create box tool: center X,Y,Z and size W,H,D')
    
    # Cut opening command
    p_opening = subparsers.add_parser('cut_opening', help='Cut doorway/window in wall')
    p_opening.add_argument('input', help='Input mesh file')
    p_opening.add_argument('output', help='Output mesh file')
    p_opening.add_argument('--type', choices=['door', 'window', 'arch', 'box'], default='door')
    p_opening.add_argument('--position', nargs=3, type=float, required=True, metavar=('X', 'Y', 'Z'))
    p_opening.add_argument('--size', nargs=3, type=float, required=True, metavar=('W', 'H', 'D'))
    
    # Smooth command
    p_smooth = subparsers.add_parser('smooth', help='Smooth mesh')
    p_smooth.add_argument('input', help='Input mesh file')
    p_smooth.add_argument('output', help='Output mesh file')
    p_smooth.add_argument('--iterations', type=int, default=3)
    
    # Fill holes command
    p_holes = subparsers.add_parser('fill_holes', help='Fill holes in mesh')
    p_holes.add_argument('input', help='Input mesh file')
    p_holes.add_argument('output', help='Output mesh file')
    
    # Segment command
    p_segment = subparsers.add_parser('segment', help='Segment mesh into surfaces')
    p_segment.add_argument('input', help='Input mesh file')
    p_segment.add_argument('--output', help='Output JSON file')
    
    # Cut polygon command - precision hole cutting with measured points
    p_polygon = subparsers.add_parser('cut_polygon', help='Cut polygon-shaped hole using measured points')
    p_polygon.add_argument('input', help='Input mesh file')
    p_polygon.add_argument('output', help='Output mesh file')
    p_polygon.add_argument('--points-file', required=True, help='JSON file with polygon points')
    
    args = parser.parse_args()
    
    if args.command == 'remove_furniture':
        result = remove_furniture(
            args.input, args.output,
            floor_height=args.floor_height,
            aggressive=args.aggressive
        )
        print(json.dumps(result, indent=2))
    
    elif args.command == 'csg_subtract':
        mesh = load_mesh(args.input)
        if args.tool:
            tool = load_mesh(args.tool)
        elif args.box:
            center = args.box[:3]
            size = args.box[3:]
            tool = create_box(center, size)
        else:
            print("Error: Need --tool or --box")
            sys.exit(1)
        
        result = csg_subtract(mesh, tool)
        save_mesh(result, args.output)
    
    elif args.command == 'cut_opening':
        result = cut_opening(
            args.input, args.output,
            args.type,
            args.position,
            args.size
        )
        print(json.dumps(result, indent=2))
    
    elif args.command == 'smooth':
        mesh = load_mesh(args.input)
        smoothed = smooth_mesh(mesh, iterations=args.iterations)
        save_mesh(smoothed, args.output)
    
    elif args.command == 'fill_holes':
        mesh = load_mesh(args.input)
        fixed = fill_holes(mesh)
        save_mesh(fixed, args.output)
    
    elif args.command == 'segment':
        result = segment_surfaces(args.input, args.output)
        print(json.dumps({k: v for k, v in result.items() if k != 'segments'}, indent=2))
    
    elif args.command == 'cut_polygon':
        result = cut_polygon_hole(
            args.input, args.output,
            args.points_file
        )
        print(json.dumps(result, indent=2))
    
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
