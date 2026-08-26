#!/usr/bin/env python3
"""
Mesh Preprocessing Service for Meshy AI Retexturing

Prepares photogrammetry scans for AI retexturing by fixing common issues:
1. Normal Unification - Forces all triangles to face outward (camera-facing)
2. Hole Filling - Creates continuous surfaces to prevent texture leaking
3. Decimation - Reduces triangle count for better Meshy performance
4. Degenerate Removal - Deletes zero-area triangles that cause math errors

This is CRITICAL for photogrammetry scans which are typically:
- Hollow (not watertight)
- Jagged/noisy
- Inside-out in places (inverted normals)
- Over-detailed (millions of triangles)

Usage:
  python preprocess_mesh.py <input_path> <output_path> [options]

Options:
  --target-faces N     Target face count after decimation (default: 100000)
  --decimation-ratio R Decimation ratio 0.0-1.0 (default: 0.1 = 10% of original)
  --skip-decimation    Skip decimation step
  --skip-hole-fill     Skip hole filling step
  --aggressive         More aggressive repairs for badly broken meshes
  --json-output        Output status as JSON for parsing by Node.js

Example:
  python preprocess_mesh.py scan.glb cleaned.glb --target-faces 50000 --json-output
"""

import argparse
import json
import sys
import os
import time
from pathlib import Path

# Check for required libraries
try:
    import trimesh
    import numpy as np
    HAVE_TRIMESH = True
except ImportError:
    HAVE_TRIMESH = False
    print(json.dumps({
        "success": False,
        "error": "Trimesh library not installed. Run: pip install trimesh[all]"
    }))
    sys.exit(1)


def log(message: str, json_output: bool = False):
    """Log message to stderr (so stdout stays clean for JSON output)"""
    if not json_output:
        print(f"[MeshPreprocess] {message}", file=sys.stderr)


def analyze_mesh(mesh: trimesh.Trimesh) -> dict:
    """
    Analyze mesh health and return diagnostic info.
    
    Returns dict with:
    - is_watertight: bool - No holes in mesh
    - is_winding_consistent: bool - All normals face same direction
    - face_count: int
    - vertex_count: int
    - has_degenerate_faces: bool
    - degenerate_count: int
    - bounding_box: dict
    - estimated_scale: str (meters, feet, etc.)
    """
    # Get degenerate face count (zero or near-zero area)
    areas = mesh.area_faces
    degenerate_mask = areas < 1e-10  # Very small area threshold
    degenerate_count = int(np.sum(degenerate_mask))
    
    # Get bounding box
    bounds = mesh.bounds
    dimensions = bounds[1] - bounds[0]
    
    # Estimate scale based on typical room dimensions
    # Most rooms are 3-10 meters in their largest dimension
    max_dim = float(np.max(dimensions))
    if max_dim < 0.1:
        scale_estimate = "millimeters"
    elif max_dim < 1:
        scale_estimate = "centimeters"
    elif max_dim < 50:
        scale_estimate = "meters (typical room scale)"
    elif max_dim < 150:
        scale_estimate = "feet (typical room scale)"
    else:
        scale_estimate = "unknown (very large model)"
    
    return {
        "is_watertight": mesh.is_watertight,
        "is_winding_consistent": mesh.is_winding_consistent,
        "face_count": len(mesh.faces),
        "vertex_count": len(mesh.vertices),
        "has_degenerate_faces": degenerate_count > 0,
        "degenerate_count": degenerate_count,
        "bounding_box": {
            "min": bounds[0].tolist(),
            "max": bounds[1].tolist(),
            "dimensions": dimensions.tolist(),
        },
        "estimated_scale": scale_estimate,
        "max_dimension": float(max_dim),
    }


def load_mesh(input_path: str, json_output: bool = False) -> tuple:
    """
    Load mesh from file, handling Scene objects (common with GLB/GLTF).
    
    Photogrammetry exports often come as Scenes with multiple geometries.
    We concatenate them into a single mesh for processing.
    
    Returns (mesh, original_scene) tuple. original_scene is preserved for 
    texture data when exporting.
    """
    log(f"Loading mesh from: {input_path}", json_output)
    
    # Load with force='scene' to handle both single meshes and scenes
    loaded = trimesh.load(input_path, force=None)
    original_scene = loaded if isinstance(loaded, trimesh.Scene) else None
    
    if isinstance(loaded, trimesh.Scene):
        log(f"Loaded as Scene with {len(loaded.geometry)} geometries", json_output)
        
        # Get all Trimesh objects from scene
        meshes = [
            g for g in loaded.geometry.values() 
            if isinstance(g, trimesh.Trimesh)
        ]
        
        if not meshes:
            raise ValueError("No valid mesh geometries found in scene")
        
        if len(meshes) == 1:
            mesh = meshes[0]
        else:
            # Concatenate all meshes into one
            log(f"Concatenating {len(meshes)} mesh parts...", json_output)
            mesh = trimesh.util.concatenate(meshes)
            
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise ValueError(f"Unexpected mesh type: {type(loaded)}")
    
    # Try to preserve vertex colors if present
    if hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
        log(f"Mesh has vertex colors - will preserve", json_output)
    
    log(f"Loaded: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces", json_output)
    return mesh, original_scene


def fix_normals(mesh: trimesh.Trimesh, aggressive: bool = False, json_output: bool = False) -> bool:
    """
    Fix mesh normals to face outward (camera-facing).
    
    This is THE MOST IMPORTANT step for Meshy. Inverted normals cause:
    - "Blue model" error (AI sees inside-out surface)
    - Failed texture application
    - Missing surfaces in render
    
    Returns True if any repairs were made.
    """
    log("Fixing normals (Red-to-Blue conversion)...", json_output)
    
    original_winding = mesh.is_winding_consistent
    repairs_made = False
    
    # Step 1: Fix winding order (make all triangles consistent)
    if not mesh.is_winding_consistent:
        log("  Fixing winding order...", json_output)
        trimesh.repair.fix_winding(mesh)
        repairs_made = True
    
    # Step 2: Fix normals (make them face outward)
    log("  Unifying normal directions...", json_output)
    trimesh.repair.fix_normals(mesh)
    repairs_made = True
    
    # Step 3: Fix inversion if mesh is inside-out
    # This happens when the camera was inside the room during scan
    log("  Checking for inversion...", json_output)
    trimesh.repair.fix_inversion(mesh)
    
    if aggressive:
        # Additional check: ensure normals point toward camera/outside
        # For room scans, we assume the camera was INSIDE the room
        # So surfaces should face INWARD toward the center
        centroid = mesh.centroid
        vertex_normals = mesh.vertex_normals
        vertices = mesh.vertices
        
        # Check if normals generally point toward or away from center
        to_center = centroid - vertices
        to_center_normalized = to_center / (np.linalg.norm(to_center, axis=1, keepdims=True) + 1e-8)
        
        # Dot product: positive = pointing toward center, negative = away
        dots = np.sum(vertex_normals * to_center_normalized, axis=1)
        avg_dot = np.mean(dots)
        
        log(f"  Average normal-to-center dot: {avg_dot:.3f}", json_output)
        
        # For interior room scans, normals should point toward center (positive dot)
        # If mostly negative, the mesh might be inverted
        if avg_dot < -0.3:
            log("  Mesh appears inverted (normals pointing outward). Flipping...", json_output)
            mesh.invert()
            repairs_made = True
    
    new_winding = mesh.is_winding_consistent
    log(f"  Winding consistent: {original_winding} -> {new_winding}", json_output)
    
    return repairs_made


def remove_degenerates(mesh: trimesh.Trimesh, json_output: bool = False) -> int:
    """
    Remove degenerate geometry that causes math errors.
    
    Includes:
    - Zero-area triangles (collapsed faces)
    - Duplicate faces
    - Infinite/NaN values
    - Unreferenced vertices
    
    Returns count of removed faces.
    """
    log("Removing degenerate geometry...", json_output)
    
    original_faces = len(mesh.faces)
    
    # Remove duplicate faces using unique_faces
    # Trimesh doesn't have remove_duplicate_faces(), so we use update_faces with unique indices
    try:
        unique_face_indices = mesh.unique_faces()
        if len(unique_face_indices) < len(mesh.faces):
            mesh.update_faces(unique_face_indices)
            after_dupes = len(mesh.faces)
            log(f"  Removed {original_faces - after_dupes} duplicate faces", json_output)
        else:
            after_dupes = original_faces
    except AttributeError:
        # Fallback: skip duplicate removal if method not available
        log("  Skipping duplicate face removal (method not available)", json_output)
        after_dupes = original_faces
    
    # Remove infinite values
    try:
        mesh.remove_infinite_values()
    except AttributeError:
        pass
    
    # Remove unreferenced vertices (cleanup)
    try:
        mesh.remove_unreferenced_vertices()
    except AttributeError:
        pass
    
    # Remove degenerate faces (zero or near-zero area)
    # Trimesh doesn't have a direct method, so we do it manually
    areas = mesh.area_faces
    valid_mask = areas > 1e-10
    
    if not np.all(valid_mask):
        invalid_count = np.sum(~valid_mask)
        log(f"  Removing {invalid_count} zero-area faces...", json_output)
        mesh.update_faces(valid_mask)
        mesh.remove_unreferenced_vertices()
    
    final_faces = len(mesh.faces)
    removed = original_faces - final_faces
    
    log(f"  Removed {removed} total degenerate faces", json_output)
    return removed


def decimate_mesh(
    mesh: trimesh.Trimesh, 
    target_faces: int = 100000,
    ratio: float = 0.1,
    json_output: bool = False
) -> tuple:
    """
    Reduce mesh complexity for better Meshy AI performance.
    
    High-poly scans (1M+ triangles) cause:
    - Longer processing times
    - Higher API costs
    - Potential timeouts
    
    Target: 50k-100k faces is optimal for Meshy retexturing.
    
    Args:
        target_faces: Maximum faces to keep (e.g., 100000)
        ratio: Decimation ratio (0.1 = keep 10% of faces)
    
    Returns: (new_mesh, reduction_info_dict)
    """
    original_count = len(mesh.faces)
    
    # Calculate actual target based on both constraints
    ratio_target = int(original_count * ratio)
    final_target = min(target_faces, ratio_target)
    
    if original_count <= final_target:
        log(f"Mesh already under target ({original_count} <= {final_target} faces). Skipping decimation.", json_output)
        return mesh, {
            "original_faces": original_count,
            "final_faces": original_count,
            "reduction_percent": 0,
            "skipped": True,
        }
    
    log(f"Decimating mesh: {original_count} -> {final_target} faces...", json_output)
    
    # Use quadric decimation for best quality reduction
    try:
        decimated = mesh.simplify_quadric_decimation(final_target)
        final_count = len(decimated.faces)
        
        reduction = (1 - final_count / original_count) * 100
        log(f"  Reduced by {reduction:.1f}%: {original_count} -> {final_count} faces", json_output)
        
        return decimated, {
            "original_faces": original_count,
            "final_faces": final_count,
            "reduction_percent": round(reduction, 1),
            "skipped": False,
        }
    except Exception as e:
        log(f"  Decimation failed: {e}. Keeping original mesh.", json_output)
        return mesh, {
            "original_faces": original_count,
            "final_faces": original_count,
            "reduction_percent": 0,
            "error": str(e),
            "skipped": True,
        }


def fill_holes(mesh: trimesh.Trimesh, json_output: bool = False) -> bool:
    """
    Attempt to close gaps in the mesh surface.
    
    Photogrammetry scans often have holes from:
    - Missed areas during capture
    - Reflective surfaces (mirrors, windows)
    - Occluded regions
    
    Hole filling creates a continuous surface so the AI doesn't
    "leak" texture paint into the void.
    
    Note: This is conservative - large holes may not be filled.
    """
    log("Attempting to fill holes...", json_output)
    
    original_watertight = mesh.is_watertight
    
    if original_watertight:
        log("  Mesh is already watertight. No holes to fill.", json_output)
        return False
    
    try:
        # Trimesh's fill_holes modifies mesh in place
        trimesh.repair.fill_holes(mesh)
        
        new_watertight = mesh.is_watertight
        
        if new_watertight:
            log("  Successfully filled all holes - mesh is now watertight!", json_output)
        else:
            log("  Filled some holes (mesh still has openings - normal for room scans)", json_output)
        
        return True
    except Exception as e:
        log(f"  Hole filling failed: {e}", json_output)
        return False


def remove_disconnected_junk(mesh: trimesh.Trimesh, json_output: bool = False) -> tuple:
    """
    Remove disconnected 'junk' components floating in the scan.
    
    Photogrammetry often produces floating fragments that confuse the AI.
    We keep only the largest connected component (the main room).
    
    Returns (cleaned_mesh, num_removed_components)
    """
    log("Removing disconnected junk components...", json_output)
    
    try:
        # Split into connected components
        components = mesh.split(only_watertight=False)
        
        if len(components) <= 1:
            log("  No disconnected components found", json_output)
            return mesh, 0
        
        # Find the largest component by face count
        face_counts = [len(c.faces) for c in components]
        largest_idx = np.argmax(face_counts)
        largest_mesh = components[largest_idx]
        
        removed_count = len(components) - 1
        removed_faces = sum(face_counts) - face_counts[largest_idx]
        
        log(f"  Removed {removed_count} disconnected components ({removed_faces} faces)", json_output)
        log(f"  Kept largest component: {face_counts[largest_idx]} faces", json_output)
        
        return largest_mesh, removed_count
        
    except Exception as e:
        log(f"  Component removal failed: {e}", json_output)
        return mesh, 0


def align_floor_level(mesh: trimesh.Trimesh, json_output: bool = False) -> tuple:
    """
    Level the floor by finding the dominant plane and rotating to make it flat.
    
    This ensures the AI projects textures straight down, keeping patterns
    like hardwood planks perfectly rectangular.
    
    Returns (aligned_mesh, rotation_applied)
    """
    log("Aligning floor to level...", json_output)
    
    try:
        # Find the dominant plane (floor) using plane fitting
        plane_origin, plane_normal = trimesh.points.plane_fit(mesh.vertices)
        
        # Ensure the normal is pointing 'Up' (+Y in Three.js/GLB convention)
        # Note: Some systems use +Z as up, but Three.js uses +Y
        if plane_normal[1] < 0:
            plane_normal = -plane_normal
        
        # Calculate rotation to align floor normal with Y-up
        target_up = np.array([0, 1, 0])
        
        # Check if already aligned (within tolerance)
        dot_product = np.dot(plane_normal, target_up)
        if abs(dot_product) > 0.99:
            log("  Floor already level (within 8 degrees)", json_output)
            return mesh, False
        
        # Create rotation matrix to align plane normal with Y-up
        rotation_matrix = trimesh.geometry.align_vectors(plane_normal, target_up)
        
        # Apply the transformation
        mesh.apply_transform(rotation_matrix)
        
        # Calculate the angle that was corrected
        angle_degrees = np.degrees(np.arccos(np.clip(dot_product, -1, 1)))
        log(f"  Rotated mesh {angle_degrees:.1f}° to level the floor", json_output)
        
        return mesh, True
        
    except Exception as e:
        log(f"  Floor alignment failed: {e}", json_output)
        return mesh, False


def clip_floor_skirt(mesh: trimesh.Trimesh, clip_margin: float = 0.02, json_output: bool = False) -> tuple:
    """
    Clip off the 'skirt' below the floor level.
    
    Photogrammetry scans often have downward-facing junk geometry that
    wraps around the floor edges. This confuses texture mapping.
    
    We slice the mesh at the floor level to remove this.
    
    Args:
        mesh: The mesh to clip
        clip_margin: How far below the lowest interior point to clip (meters)
    
    Returns (clipped_mesh, faces_removed)
    """
    log("Clipping floor skirt...", json_output)
    
    try:
        original_faces = len(mesh.faces)
        
        # Find the floor level (minimum Y after alignment)
        # We use a percentile to avoid outliers pulling the floor down
        y_coords = mesh.vertices[:, 1]
        floor_level = np.percentile(y_coords, 5)  # 5th percentile = robust floor estimate
        
        # Clip slightly below the floor to keep the actual floor surface
        clip_height = floor_level - clip_margin
        
        log(f"  Floor level detected at Y={floor_level:.3f}", json_output)
        log(f"  Clipping below Y={clip_height:.3f}", json_output)
        
        # Slice the mesh - remove everything below the clip plane
        # plane_normal points in direction to KEEP, so [0, 1, 0] keeps stuff above
        clipped = trimesh.intersections.slice_mesh_plane(
            mesh, 
            plane_normal=[0, 1, 0],  # Keep stuff in +Y direction (above)
            plane_origin=[0, clip_height, 0],
            cap=False  # Don't cap the hole - Meshy doesn't need it
        )
        
        if clipped is None or len(clipped.faces) == 0:
            log("  Warning: Clipping removed entire mesh! Skipping.", json_output)
            return mesh, 0
        
        faces_removed = original_faces - len(clipped.faces)
        
        if faces_removed > 0:
            log(f"  Removed {faces_removed} skirt faces ({100*faces_removed/original_faces:.1f}%)", json_output)
        else:
            log("  No skirt detected below floor level", json_output)
        
        return clipped, faces_removed
        
    except Exception as e:
        log(f"  Skirt clipping failed: {e}", json_output)
        return mesh, 0


# =============================================================================
# FLOOR SEGMENTATION PIPELINE
# =============================================================================

def segment_floor(
    mesh: trimesh.Trimesh,
    angle_tolerance: float = 15.0,
    height_percentile: float = 10.0,
    height_tolerance: float = 0.1,
    expand_floor: float = 0.0,
    json_output: bool = False
) -> tuple:
    """
    Segment the floor from the room mesh using heuristic planar extraction.
    
    Strategy:
    1. Find faces with normals pointing UP (within angle_tolerance degrees of Y+)
    2. Filter to the lowest horizontal surfaces (the actual floor)
    3. Return (floor_mesh, shell_mesh) as separate Trimesh objects
    
    Args:
        mesh: Input room mesh (should be preprocessed first)
        angle_tolerance: Max degrees from vertical for "floor" faces (default 15°)
        height_percentile: Target the bottom X% of flat surfaces (default 10%)
        height_tolerance: Height range in meters around floor level (default 0.1m)
        expand_floor: Optionally expand floor slightly to tuck under walls (default 0)
    
    Returns:
        (floor_mesh, shell_mesh, floor_info) tuple
    """
    log("Segmenting floor from room mesh...", json_output)
    
    try:
        original_faces = len(mesh.faces)
        
        # Step 1: Find faces pointing UP (normals near [0, 1, 0])
        up_vector = np.array([0, 1, 0])
        
        # Calculate angle between each face normal and up vector
        dot_products = np.dot(mesh.face_normals, up_vector)
        # Clamp to valid range for arccos
        dot_products = np.clip(dot_products, -1.0, 1.0)
        angles = np.degrees(np.arccos(dot_products))
        
        # Faces within tolerance of pointing straight up
        is_flat = angles < angle_tolerance
        flat_count = np.sum(is_flat)
        
        log(f"  Found {flat_count} upward-facing faces (within {angle_tolerance}°)", json_output)
        
        if flat_count == 0:
            log("  ERROR: No upward-facing surfaces found!", json_output)
            return None, mesh, {"error": "No floor detected"}
        
        # Step 2: Filter by height - floor is the LOWEST major flat surface
        # Get Y coordinates (height) of flat face centers
        flat_face_indices = np.where(is_flat)[0]
        flat_face_heights = mesh.triangles_center[is_flat][:, 1]
        
        # Find the floor level (bottom percentile of flat surfaces)
        floor_level = np.percentile(flat_face_heights, height_percentile)
        log(f"  Floor level detected at Y={floor_level:.3f}m", json_output)
        
        # Step 3: Create floor mask - flat faces at floor level
        all_face_heights = mesh.triangles_center[:, 1]
        is_at_floor_level = np.abs(all_face_heights - floor_level) < height_tolerance
        
        floor_mask = is_flat & is_at_floor_level
        floor_count = np.sum(floor_mask)
        
        log(f"  Floor segment: {floor_count} faces ({100*floor_count/original_faces:.1f}%)", json_output)
        
        if floor_count < 10:
            log("  ERROR: Floor segment too small!", json_output)
            return None, mesh, {"error": "Floor segment too small"}
        
        # Step 4: Extract floor and shell as separate meshes
        floor_face_indices = np.where(floor_mask)[0]
        shell_face_indices = np.where(~floor_mask)[0]
        
        # Use submesh to extract
        floor_mesh = mesh.submesh([floor_face_indices], append=True)
        shell_mesh = mesh.submesh([shell_face_indices], append=True)
        
        # Step 5: Optionally expand floor to tuck under walls
        if expand_floor > 0:
            try:
                # Move floor vertices slightly outward from center
                floor_center = floor_mesh.centroid
                directions = floor_mesh.vertices - floor_center
                directions[:, 1] = 0  # Don't expand vertically
                norms = np.linalg.norm(directions, axis=1, keepdims=True)
                norms[norms < 0.001] = 1  # Avoid division by zero
                directions = directions / norms
                floor_mesh.vertices += directions * expand_floor
                log(f"  Expanded floor by {expand_floor}m", json_output)
            except Exception as e:
                log(f"  Floor expansion failed: {e}", json_output)
        
        # Fix normals on both segments
        trimesh.repair.fix_normals(floor_mesh)
        trimesh.repair.fix_normals(shell_mesh)
        
        floor_info = {
            "floor_faces": int(floor_count),
            "shell_faces": int(len(shell_face_indices)),
            "floor_level": float(floor_level),
            "floor_percent": float(100 * floor_count / original_faces),
            "floor_bounds": {
                "min": floor_mesh.bounds[0].tolist(),
                "max": floor_mesh.bounds[1].tolist(),
            }
        }
        
        log(f"  ✅ Floor segmentation complete", json_output)
        log(f"  Floor: {floor_info['floor_faces']} faces, Shell: {floor_info['shell_faces']} faces", json_output)
        
        return floor_mesh, shell_mesh, floor_info
        
    except Exception as e:
        log(f"  Floor segmentation failed: {e}", json_output)
        import traceback
        traceback.print_exc()
        return None, mesh, {"error": str(e)}


def segment_and_export_floor(
    input_path: str,
    floor_output_path: str,
    shell_output_path: str,
    preprocess_first: bool = True,
    angle_tolerance: float = 15.0,
    json_output: bool = False
) -> dict:
    """
    Full pipeline: Load mesh, preprocess, segment floor, and export both parts.
    
    This is the main entry point for the floor segmentation workflow.
    
    Args:
        input_path: Path to input mesh (GLB/GLTF/OBJ)
        floor_output_path: Where to save the floor segment (for Meshy)
        shell_output_path: Where to save the room shell (walls/ceiling)
        preprocess_first: Whether to run full preprocessing before segmentation
        angle_tolerance: Max degrees from vertical for floor detection
    
    Returns:
        Dict with floor_path, shell_path, floor_info, and success status
    """
    start_time = time.time()
    
    try:
        log(f"=== Floor Segmentation Pipeline ===", json_output)
        log(f"Input: {input_path}", json_output)
        
        # Step 1: Load mesh
        mesh, _ = load_mesh(input_path, json_output)
        original_faces = len(mesh.faces)
        
        # Step 2: Preprocess if requested
        if preprocess_first:
            log("Running preprocessing before segmentation...", json_output)
            
            # Remove junk
            mesh, junk_removed = remove_disconnected_junk(mesh, json_output)
            
            # Align floor
            mesh, _ = align_floor_level(mesh, json_output)
            
            # Clip skirt
            mesh, _ = clip_floor_skirt(mesh, json_output=json_output)
            
            # Fix normals
            trimesh.repair.fix_normals(mesh)
            
            log(f"Preprocessed: {original_faces} -> {len(mesh.faces)} faces", json_output)
        
        # Step 3: Segment floor
        floor_mesh, shell_mesh, floor_info = segment_floor(
            mesh,
            angle_tolerance=angle_tolerance,
            expand_floor=0.005,  # 5mm expansion to tuck under walls
            json_output=json_output
        )
        
        if floor_mesh is None:
            return {
                "success": False,
                "error": floor_info.get("error", "Floor segmentation failed"),
            }
        
        # Step 4: Export both segments
        os.makedirs(os.path.dirname(floor_output_path) or ".", exist_ok=True)
        os.makedirs(os.path.dirname(shell_output_path) or ".", exist_ok=True)
        
        floor_mesh.export(floor_output_path, file_type='glb')
        shell_mesh.export(shell_output_path, file_type='glb')
        
        log(f"Exported floor: {floor_output_path}", json_output)
        log(f"Exported shell: {shell_output_path}", json_output)
        
        processing_time = (time.time() - start_time) * 1000
        
        result = {
            "success": True,
            "floor_path": floor_output_path,
            "shell_path": shell_output_path,
            "floor_info": floor_info,
            "original_faces": original_faces,
            "processing_time_ms": round(processing_time, 1),
        }
        
        log(f"✅ Floor segmentation complete in {processing_time:.0f}ms", json_output)
        return result
        
    except Exception as e:
        log(f"Floor segmentation pipeline failed: {e}", json_output)
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
        }


def stitch_floor_back(
    shell_path: str,
    textured_floor_path: str,
    output_path: str,
    json_output: bool = False
) -> dict:
    """
    Combine the original room shell with the new AI-textured floor.
    
    Both meshes share the same coordinate system from the original scan,
    so they will align perfectly without manual adjustment.
    
    Args:
        shell_path: Path to room shell (walls/ceiling)
        textured_floor_path: Path to AI-textured floor from Meshy
        output_path: Where to save the combined result
    
    Returns:
        Dict with success status and output path
    """
    start_time = time.time()
    
    try:
        log(f"=== Stitching Floor Back ===", json_output)
        
        # Load both meshes
        shell = trimesh.load(shell_path, force='mesh')
        floor = trimesh.load(textured_floor_path, force='mesh')
        
        if isinstance(shell, trimesh.Scene):
            shell = shell.dump(concatenate=True)
        if isinstance(floor, trimesh.Scene):
            floor = floor.dump(concatenate=True)
        
        log(f"Shell: {len(shell.faces)} faces", json_output)
        log(f"Floor: {len(floor.faces)} faces", json_output)
        
        # Create a scene containing both
        combined_scene = trimesh.Scene([shell, floor])
        
        # Export
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        combined_scene.export(output_path, file_type='glb')
        
        processing_time = (time.time() - start_time) * 1000
        
        log(f"✅ Stitched and saved: {output_path}", json_output)
        log(f"  Total faces: {len(shell.faces) + len(floor.faces)}", json_output)
        
        return {
            "success": True,
            "output_path": output_path,
            "shell_faces": len(shell.faces),
            "floor_faces": len(floor.faces),
            "total_faces": len(shell.faces) + len(floor.faces),
            "processing_time_ms": round(processing_time, 1),
        }
        
    except Exception as e:
        log(f"Stitching failed: {e}", json_output)
        return {
            "success": False,
            "error": str(e),
        }


def prep_model_for_meshy(
    input_path: str,
    output_path: str,
    target_faces: int = 100000,
    decimation_ratio: float = 0.1,
    skip_decimation: bool = False,
    skip_hole_fill: bool = False,
    skip_cleanup: bool = False,
    skip_alignment: bool = False,
    skip_clipping: bool = False,
    aggressive: bool = False,
    json_output: bool = False,
) -> dict:
    """
    Full preprocessing pipeline to prepare photogrammetry scan for Meshy AI.
    
    Steps:
    1. Load mesh (handling Scene objects)
    2. Remove disconnected junk components (NEW)
    3. Align floor to level (NEW)
    4. Clip floor skirt (NEW)
    5. Analyze original mesh health
    6. Fix normals (the "Red Face" problem)
    7. Remove degenerate geometry
    8. Decimate to target face count
    9. Fill holes (optional)
    10. Final normal fix after all operations
    11. Export clean GLB
    
    Returns dict with:
    - success: bool
    - original_analysis: mesh health before fixes
    - final_analysis: mesh health after fixes
    - repairs: what was fixed
    - processing_time_ms: time taken
    - output_path: path to cleaned mesh
    """
    start_time = time.time()
    repairs = {}
    
    try:
        # Step 1: Load (preserve original scene for texture data)
        mesh, original_scene = load_mesh(input_path, json_output)
        
        # Preserve vertex colors if present
        original_visual = None
        if hasattr(mesh, 'visual') and mesh.visual is not None:
            try:
                if hasattr(mesh.visual, 'vertex_colors'):
                    original_visual = mesh.visual.vertex_colors.copy() if mesh.visual.vertex_colors is not None else None
            except:
                pass
        
        # Step 2: Remove disconnected junk (floating fragments)
        if not skip_cleanup:
            mesh, junk_removed = remove_disconnected_junk(mesh, json_output)
            repairs["disconnected_components_removed"] = junk_removed
        else:
            repairs["disconnected_components_removed"] = 0
        
        # Step 3: Align floor to level
        if not skip_alignment:
            mesh, was_aligned = align_floor_level(mesh, json_output)
            repairs["floor_aligned"] = was_aligned
        else:
            repairs["floor_aligned"] = False
        
        # Step 4: Clip floor skirt (remove downward-facing junk)
        if not skip_clipping:
            mesh, skirt_faces_removed = clip_floor_skirt(mesh, json_output=json_output)
            repairs["skirt_faces_clipped"] = skirt_faces_removed
        else:
            repairs["skirt_faces_clipped"] = 0
        
        # Step 5: Analyze after cleanup
        original_analysis = analyze_mesh(mesh)
        log(f"After cleanup: {original_analysis['face_count']} faces, "
            f"watertight={original_analysis['is_watertight']}, "
            f"winding_ok={original_analysis['is_winding_consistent']}", json_output)
        
        # Step 6: Fix normals (CRITICAL for Meshy)
        normals_fixed = fix_normals(mesh, aggressive=aggressive, json_output=json_output)
        repairs["normals_fixed"] = normals_fixed
        
        # Step 7: Remove degenerates
        degens_removed = remove_degenerates(mesh, json_output)
        repairs["degenerate_faces_removed"] = degens_removed
        
        # Step 8: Decimate
        if not skip_decimation:
            mesh, decimation_info = decimate_mesh(
                mesh, 
                target_faces=target_faces,
                ratio=decimation_ratio,
                json_output=json_output
            )
            repairs["decimation"] = decimation_info
        else:
            repairs["decimation"] = {"skipped": True}
        
        # Step 9: Fill holes
        if not skip_hole_fill:
            holes_filled = fill_holes(mesh, json_output)
            repairs["holes_filled"] = holes_filled
        else:
            repairs["holes_filled"] = False
        
        # Step 10: Final normals fix after all geometry operations
        log("Final normals pass after all operations...", json_output)
        trimesh.repair.fix_normals(mesh)
        
        # Step 11: Final analysis
        final_analysis = analyze_mesh(mesh)
        log(f"Final mesh: {final_analysis['face_count']} faces, "
            f"watertight={final_analysis['is_watertight']}, "
            f"winding_ok={final_analysis['is_winding_consistent']}", json_output)
        
        # Step 12: Export
        log(f"Exporting to: {output_path}", json_output)
        
        # Ensure output directory exists
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        
        # Restore vertex colors if we saved them
        if original_visual is not None:
            try:
                # Vertex count may have changed due to decimation
                if len(original_visual) == len(mesh.vertices):
                    mesh.visual.vertex_colors = original_visual
                    log("Restored original vertex colors", json_output)
                else:
                    log(f"Vertex count changed ({len(original_visual)} -> {len(mesh.vertices)}), assigning default color", json_output)
                    # Apply a neutral gray so it's visible
                    mesh.visual.vertex_colors = np.full((len(mesh.vertices), 4), [180, 180, 180, 255], dtype=np.uint8)
            except Exception as e:
                log(f"Could not restore colors: {e}", json_output)
        
        # Export as GLB (binary GLTF) for best compatibility
        mesh.export(output_path, file_type='glb')
        
        processing_time = (time.time() - start_time) * 1000
        
        result = {
            "success": True,
            "input_path": input_path,
            "output_path": output_path,
            "original_analysis": original_analysis,
            "final_analysis": final_analysis,
            "repairs": repairs,
            "processing_time_ms": round(processing_time, 1),
        }
        
        log(f"✅ Preprocessing complete in {processing_time:.0f}ms", json_output)
        return result
        
    except Exception as e:
        processing_time = (time.time() - start_time) * 1000
        error_result = {
            "success": False,
            "error": str(e),
            "input_path": input_path,
            "processing_time_ms": round(processing_time, 1),
        }
        log(f"❌ Preprocessing failed: {e}", json_output)
        return error_result


def main():
    parser = argparse.ArgumentParser(
        description="Prepare photogrammetry mesh for Meshy AI retexturing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument("input_path", help="Path to input mesh file (.glb, .obj, .ply)")
    parser.add_argument("output_path", help="Path for output cleaned mesh (.glb)")
    
    parser.add_argument(
        "--target-faces", 
        type=int, 
        default=100000,
        help="Target face count after decimation (default: 100000)"
    )
    parser.add_argument(
        "--decimation-ratio",
        type=float,
        default=0.1,
        help="Decimation ratio 0.0-1.0 (default: 0.1 = keep 10%%)"
    )
    parser.add_argument(
        "--skip-decimation",
        action="store_true",
        help="Skip decimation step (keep all faces)"
    )
    parser.add_argument(
        "--skip-hole-fill",
        action="store_true",
        help="Skip hole filling step"
    )
    parser.add_argument(
        "--aggressive",
        action="store_true",
        help="Aggressive repairs for badly broken meshes"
    )
    parser.add_argument(
        "--json-output",
        action="store_true",
        help="Output result as JSON to stdout"
    )
    parser.add_argument(
        "--analyze-only",
        action="store_true",
        help="Only analyze mesh health, don't modify"
    )
    parser.add_argument(
        "--segment-floor",
        action="store_true",
        help="Segment floor from room and export as separate files"
    )
    parser.add_argument(
        "--floor-output",
        type=str,
        default=None,
        help="Output path for floor segment (used with --segment-floor)"
    )
    parser.add_argument(
        "--shell-output",
        type=str,
        default=None,
        help="Output path for room shell (used with --segment-floor)"
    )
    parser.add_argument(
        "--stitch",
        action="store_true",
        help="Stitch textured floor back into room shell"
    )
    parser.add_argument(
        "--shell-path",
        type=str,
        default=None,
        help="Path to room shell (used with --stitch)"
    )
    parser.add_argument(
        "--textured-floor-path",
        type=str,
        default=None,
        help="Path to textured floor from Meshy (used with --stitch)"
    )
    
    args = parser.parse_args()
    
    # Validate input
    if not args.stitch and not os.path.exists(args.input_path):
        if args.json_output:
            print(json.dumps({"success": False, "error": f"Input file not found: {args.input_path}"}))
        else:
            print(f"Error: Input file not found: {args.input_path}", file=sys.stderr)
        sys.exit(1)
    
    # Stitch mode - combine shell and textured floor
    if args.stitch:
        if not args.shell_path or not args.textured_floor_path:
            error = "Stitch mode requires --shell-path and --textured-floor-path"
            if args.json_output:
                print(json.dumps({"success": False, "error": error}))
            else:
                print(f"Error: {error}", file=sys.stderr)
            sys.exit(1)
        
        result = stitch_floor_back(
            shell_path=args.shell_path,
            textured_floor_path=args.textured_floor_path,
            output_path=args.output_path,
            json_output=args.json_output,
        )
        
        if args.json_output:
            print(json.dumps(result, indent=2))
        sys.exit(0 if result["success"] else 1)
    
    # Floor segmentation mode
    if args.segment_floor:
        # Generate default output paths if not provided
        base_name = os.path.splitext(args.input_path)[0]
        floor_output = args.floor_output or f"{base_name}_floor.glb"
        shell_output = args.shell_output or f"{base_name}_shell.glb"
        
        result = segment_and_export_floor(
            input_path=args.input_path,
            floor_output_path=floor_output,
            shell_output_path=shell_output,
            preprocess_first=True,
            json_output=args.json_output,
        )
        
        if args.json_output:
            print(json.dumps(result, indent=2))
        else:
            if result["success"]:
                print(f"\n✅ Floor segmentation complete!")
                print(f"  Floor: {result['floor_path']} ({result['floor_info']['floor_faces']} faces)")
                print(f"  Shell: {result['shell_path']} ({result['floor_info']['shell_faces']} faces)")
            else:
                print(f"\n❌ Floor segmentation failed: {result.get('error', 'Unknown error')}")
        
        sys.exit(0 if result["success"] else 1)
    
    # Analyze-only mode
    if args.analyze_only:
        mesh, _ = load_mesh(args.input_path, args.json_output)
        analysis = analyze_mesh(mesh)
        
        if args.json_output:
            print(json.dumps({"success": True, "analysis": analysis}, indent=2))
        else:
            print("\n=== Mesh Analysis ===")
            print(f"Vertices: {analysis['vertex_count']}")
            print(f"Faces: {analysis['face_count']}")
            print(f"Watertight: {analysis['is_watertight']}")
            print(f"Winding Consistent: {analysis['is_winding_consistent']}")
            print(f"Degenerate Faces: {analysis['degenerate_count']}")
            print(f"Estimated Scale: {analysis['estimated_scale']}")
            print(f"Dimensions: {analysis['bounding_box']['dimensions']}")
        
        sys.exit(0)
    
    # Run full preprocessing
    result = prep_model_for_meshy(
        input_path=args.input_path,
        output_path=args.output_path,
        target_faces=args.target_faces,
        decimation_ratio=args.decimation_ratio,
        skip_decimation=args.skip_decimation,
        skip_hole_fill=args.skip_hole_fill,
        aggressive=args.aggressive,
        json_output=args.json_output,
    )
    
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"\n✅ Mesh preprocessing complete!")
            print(f"   Output: {result['output_path']}")
            print(f"   Faces: {result['original_analysis']['face_count']} -> {result['final_analysis']['face_count']}")
        else:
            print(f"\n❌ Preprocessing failed: {result['error']}")
    
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
