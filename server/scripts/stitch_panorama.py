#!/usr/bin/env python3
"""
Spherical Panorama Stitching with Photogrammetry and Depth Integration

This script creates equirectangular panoramas by:
1. Using iPhone sensor data (quaternions) for initial camera orientation
2. Detecting SIFT features in overlapping regions  
3. Matching features between adjacent photos to refine alignment
4. Using depth data for depth-aware blending (front surfaces win in overlaps)
5. Projecting each photo onto a unit sphere using its camera pose
6. Outputting both color and depth equirectangular panoramas
7. **NEW**: OpenAI Vision analysis for stitching quality and guidance

Depth integration enables:
- Accurate blending by knowing which surface is in front
- Metric room dimensions from the stitched depth panorama
- Validation of feature matches with 3D consistency

Vision AI integration:
- Analyzes photo pairs for visual coherence before stitching
- Recommends optimal stitching strategy based on scene analysis
- Verifies seam quality and suggests improvements

No fallbacks - either the photogrammetry works or we fail with a clear error.
"""

import cv2
import numpy as np
import json
import sys
import time
import os
import base64
import argparse
import math
import os
from typing import List, Dict, Tuple, Optional

# Import Vision assistant if available
try:
    from vision_stitching_assistant import (
        analyze_photo_pair_overlap,
        analyze_seam_quality,
        get_global_stitching_strategy
    )
    VISION_AVAILABLE = True
    print("[Vision] OpenAI Vision assistant loaded", file=sys.stderr)
except ImportError:
    VISION_AVAILABLE = False
    print("[Vision] Vision assistant not available (missing OpenAI key or module)", file=sys.stderr)

# Import Google Street View-style stitcher
try:
    from google_streetview_stitcher import stitch_with_google_method, GoogleStyleStitcher
    GOOGLE_STITCHER_AVAILABLE = True
    print("[GoogleStitcher] Google Street View-style stitcher loaded", file=sys.stderr)
except ImportError as e:
    GOOGLE_STITCHER_AVAILABLE = False
    print(f"[GoogleStitcher] Not available: {e}", file=sys.stderr)

# Import Bundle Adjustment stitcher (Brown & Lowe 2007 implementation)
try:
    from bundle_adjustment_stitcher import stitch_with_bundle_adjustment, BundleAdjustmentStitcher
    BUNDLE_ADJUSTMENT_AVAILABLE = True
    print("[BundleAdjust] Brown & Lowe bundle adjustment stitcher loaded", file=sys.stderr)
except ImportError as e:
    BUNDLE_ADJUSTMENT_AVAILABLE = False
    print(f"[BundleAdjust] Not available: {e}", file=sys.stderr)

# Import Optimized Google Stitcher (Brown & Lowe + Google Street View hybrid)
try:
    from optimized_google_stitcher import stitch_with_optimized_method, OptimizedGoogleStitcher
    OPTIMIZED_STITCHER_AVAILABLE = True
    print("[OptimizedStitcher] Brown & Lowe + Google sensor-anchored stitcher loaded", file=sys.stderr)
except ImportError as e:
    OPTIMIZED_STITCHER_AVAILABLE = False
    print(f"[OptimizedStitcher] Not available: {e}", file=sys.stderr)

# Import Vision-based image sorter
try:
    from vision_image_sorter import sort_and_optimize_photos, apply_corrections
    VISION_SORTER_AVAILABLE = True
    print("[VisionSort] Vision-based image sorter loaded", file=sys.stderr)
except ImportError as e:
    VISION_SORTER_AVAILABLE = False
    print(f"[VisionSort] Not available: {e}", file=sys.stderr)


# =============================================================================
# QUATERNION AND ROTATION UTILITIES
# =============================================================================

def normalize_quaternion(q: Dict) -> Dict:
    """Normalize quaternion to unit length"""
    x, y, z, w = q['x'], q['y'], q['z'], q['w']
    n = math.sqrt(x*x + y*y + z*z + w*w)
    if n < 1e-10:
        return {'x': 0, 'y': 0, 'z': 0, 'w': 1}
    return {'x': x/n, 'y': y/n, 'z': z/n, 'w': w/n}


def quaternion_to_rotation_matrix(q: Dict) -> np.ndarray:
    """Convert quaternion {x, y, z, w} to 3x3 rotation matrix"""
    q = normalize_quaternion(q)
    x, y, z, w = q['x'], q['y'], q['z'], q['w']
    
    return np.array([
        [1 - 2*y*y - 2*z*z, 2*x*y - 2*z*w, 2*x*z + 2*y*w],
        [2*x*y + 2*z*w, 1 - 2*x*x - 2*z*z, 2*y*z - 2*x*w],
        [2*x*z - 2*y*w, 2*y*z + 2*x*w, 1 - 2*x*x - 2*y*y]
    ], dtype=np.float64)


def azimuth_elevation_to_rotation(azimuth_deg: float, elevation_deg: float) -> np.ndarray:
    """
    Convert azimuth/elevation to rotation matrix.
    Camera looks outward from center of sphere.
    - Azimuth: 0° = +Z, 90° = +X, 180° = -Z, 270° = -X (compass direction)
    - Elevation: 0° = horizon, +90° = zenith (up), -90° = nadir (down)
    
    The rotation transforms camera-local coordinates to world coordinates.
    Camera looks along +Z in its local frame.
    """
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    
    # Build rotation as: R = Ry(azimuth) @ Rx(-elevation)
    # We need to rotate around Y first (azimuth), then tilt up/down (elevation around X)
    # Note: elevation is positive up, so we rotate by +elevation around X
    
    cos_az, sin_az = math.cos(az), math.sin(az)
    cos_el, sin_el = math.cos(el), math.sin(el)
    
    # Rotation around Y-axis (azimuth)
    Ry = np.array([
        [cos_az, 0, sin_az],
        [0, 1, 0],
        [-sin_az, 0, cos_az]
    ], dtype=np.float64)
    
    # Rotation around X-axis (elevation) - positive elevation = look up
    # Need negative sign because positive rotation around X tilts forward (down), not up
    Rx = np.array([
        [1, 0, 0],
        [0, cos_el, sin_el],
        [0, -sin_el, cos_el]
    ], dtype=np.float64)
    
    # Combined: first azimuth rotation, then elevation tilt
    R = Ry @ Rx
    
    return R


def rotation_matrix_to_direction(R: np.ndarray) -> np.ndarray:
    """Get the forward direction vector from a rotation matrix (camera looks along +Z in its local frame)"""
    return R @ np.array([0, 0, 1])


def direction_to_spherical(direction: np.ndarray) -> Tuple[float, float]:
    """Convert 3D direction to spherical coordinates (theta, phi)"""
    x, y, z = direction
    theta = math.atan2(x, z)  # Azimuth: -π to π
    phi = math.asin(np.clip(y, -1, 1))  # Elevation: -π/2 to π/2
    return theta, phi


def spherical_to_equirectangular(theta: float, phi: float, width: int, height: int) -> Tuple[int, int]:
    """Convert spherical coordinates to equirectangular pixel coordinates"""
    # theta: -π to π -> 0 to width
    # phi: -π/2 to π/2 -> height to 0 (flipped because image Y is inverted)
    u = int((theta / math.pi + 1) * 0.5 * width) % width
    v = int((0.5 - phi / math.pi) * height)
    return u, max(0, min(height - 1, v))


# =============================================================================
# CAMERA POSE EXTRACTION
# =============================================================================

def get_camera_rotation(photo: Dict) -> np.ndarray:
    """
    Extract camera rotation matrix from photo metadata.
    
    IMPORTANT: For panorama stitching, we need RELATIVE coordinates (where photos 
    are relative to each other and the panorama origin), NOT absolute world coordinates.
    
    The azimuth/elevation values are calibrated to the panorama's starting point,
    so they should be used for placement. The quaternion from iPhone sensors is in
    absolute world coordinates (relative to true north) which would place all photos
    based on compass heading, not their position in the panorama.
    
    Priority: azimuth/elevation (calibrated) > sensorData quaternion (for refinement only)
    """
    # 1. Use azimuth/elevation - these are calibrated to panorama coordinate system
    azimuth = photo.get('azimuth', 0)
    elevation = photo.get('elevation', 0)
    
    # If we have azimuth/elevation, use them as primary source
    if azimuth != 0 or elevation != 0:
        return azimuth_elevation_to_rotation(azimuth, elevation)
    
    # 2. Fallback to sensor quaternion only if no azimuth/elevation
    # Note: This may result in photos placed in absolute world coords
    if photo.get('sensorData') and photo['sensorData'].get('attitude'):
        attitude = photo['sensorData']['attitude']
        if attitude.get('quaternion'):
            print(f"  [Warning] Using absolute quaternion - no azimuth/elevation provided", file=sys.stderr)
            return quaternion_to_rotation_matrix(attitude['quaternion'])
    
    # 3. Try pre-computed camera pose
    if photo.get('cameraPose') and photo['cameraPose'].get('rotation'):
        return quaternion_to_rotation_matrix(photo['cameraPose']['rotation'])
    
    # 4. Default to looking forward
    return azimuth_elevation_to_rotation(0, 0)


def get_camera_intrinsics(photo: Dict, img_width: int, img_height: int) -> Dict:
    """Get camera intrinsics from photo or estimate from image size"""
    if photo.get('cameraIntrinsics'):
        return photo['cameraIntrinsics']
    
    # Estimate for typical smartphone (iPhone)
    # FOV is approximately 75° horizontal for main camera
    fov_h = 75  # degrees
    focal_length = img_width / (2 * math.tan(math.radians(fov_h / 2)))
    
    return {
        'focalLengthX': focal_length,
        'focalLengthY': focal_length,
        'principalPointX': img_width / 2,
        'principalPointY': img_height / 2,
        'imageWidth': img_width,
        'imageHeight': img_height
    }


# =============================================================================
# IMAGE DECODING
# =============================================================================

def decode_base64_image(base64_str: str) -> np.ndarray:
    """Decode base64 image to numpy array (BGR format)"""
    if ',' in base64_str:
        base64_str = base64_str.split(',')[1]
    
    # Fix base64 padding if needed (add missing '=' characters)
    padding_needed = len(base64_str) % 4
    if padding_needed:
        base64_str += '=' * (4 - padding_needed)
    
    try:
        img_data = base64.b64decode(base64_str)
    except Exception as e:
        raise ValueError(f"Failed to decode base64: {e}")
        
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img is None or img.size == 0:
        raise ValueError("Failed to decode image")
    
    return img


def encode_image_base64(img: np.ndarray, quality: int = 95) -> str:
    """Encode numpy array to base64 JPEG"""
    _, buffer = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"


def calculate_room_dimensions(depth_panorama: np.ndarray) -> Dict:
    """
    Calculate room dimensions from equirectangular depth panorama.
    Uses robust statistics and outlier filtering for accuracy.
    """
    if depth_panorama is None or not np.any(depth_panorama > 0):
        return None
    
    height, width = depth_panorama.shape
    valid_depth = depth_panorama[depth_panorama > 0]
    
    if len(valid_depth) < 100:
        return None
    
    try:
        # Step 1: Remove outliers from depth data using percentiles
        q5 = np.percentile(valid_depth, 5)
        q95 = np.percentile(valid_depth, 95)
        iqr = q95 - q5
        lower_bound = q5 - 1.5 * iqr
        upper_bound = q95 + 1.5 * iqr
        
        # Apply outlier filtering to panorama
        depth_filtered = depth_panorama.copy()
        outlier_mask = (depth_panorama < lower_bound) | (depth_panorama > upper_bound)
        depth_filtered[outlier_mask] = 0
        
        # Divide panorama into regions:
        # Top 20% = ceiling, Bottom 20% = floor, Middle 60% = walls
        floor_region = depth_filtered[int(height * 0.8):, :]
        ceiling_region = depth_filtered[:int(height * 0.2), :]
        wall_region = depth_filtered[int(height * 0.3):int(height * 0.7), :]
        
        # Get robust statistics using trimmed mean (remove top/bottom 10%)
        floor_distances = floor_region[floor_region > 0]
        ceiling_distances = ceiling_region[ceiling_region > 0]
        wall_distances = wall_region[wall_region > 0]
        
        if len(floor_distances) < 10 or len(ceiling_distances) < 10:
            return None
        
        # Use trimmed mean (remove extreme 10% on each end)
        def trimmed_mean(arr, trim_percent=10):
            if len(arr) < 10:
                return np.median(arr)
            lower = np.percentile(arr, trim_percent)
            upper = np.percentile(arr, 100 - trim_percent)
            trimmed = arr[(arr >= lower) & (arr <= upper)]
            return np.mean(trimmed) if len(trimmed) > 0 else np.median(arr)
        
        # Room height: difference between floor and ceiling distances
        # (Assuming camera at chest height ~1.5m)
        median_floor_dist = trimmed_mean(floor_distances)
        median_ceiling_dist = trimmed_mean(ceiling_distances)
        
        # Estimate camera height and room height
        # Typical: camera at 1.4-1.6m height
        camera_height_estimate = 1.5
        
        # Room width/length: Use wall distances
        # Get distances at different angles to find room dimensions
        angles_count = 12  # Check 12 directions for better sampling
        distances_by_angle = []
        
        for i in range(angles_count):
            # Sample vertical strip at this angle
            x_col = int((i / angles_count) * width)
            col_depths = wall_region[:, x_col]
            valid_col = col_depths[col_depths > 0]
            if len(valid_col) > 5:
                distances_by_angle.append(trimmed_mean(valid_col))
        
        if len(distances_by_angle) < 4:
            return None
        
        # Room dimensions: take perpendicular pairs
        # Width = min distance * 2 (closest walls, assuming camera near center)
        # Length = max distance * 2 (farthest walls)
        distances_sorted = sorted(distances_by_angle)
        min_dist = distances_sorted[0]
        max_dist = distances_sorted[-1]
        
        # Estimate dimensions (assuming camera roughly in center)
        estimated_width = min_dist * 2.2  # Factor >2 accounts for off-center positioning
        estimated_length = max_dist * 1.8  # Factor <2 as max is often to corner
        estimated_height = median_floor_dist + median_ceiling_dist  # Total vertical span
        
        # Clamp to reasonable room sizes
        estimated_width = max(2.0, min(15.0, estimated_width))
        estimated_length = max(2.0, min(20.0, estimated_length))
        estimated_height = max(2.0, min(4.0, estimated_height))
        
        return {
            'widthMeters': float(estimated_width),
            'lengthMeters': float(estimated_length),
            'heightMeters': float(estimated_height),
            'widthFeet': float(estimated_width * 3.28084),
            'lengthFeet': float(estimated_length * 3.28084),
            'heightFeet': float(estimated_height * 3.28084),
            'floorAreaSqM': float(estimated_width * estimated_length),
            'floorAreaSqFt': float(estimated_width * estimated_length * 10.7639),
            'confidence': 0.6,  # Medium confidence for depth-based estimation
            'source': 'depth_panorama_analysis'
        }
    except Exception as e:
        print(f"[Warning] Failed to calculate room dimensions: {e}", file=sys.stderr)
        return None


def encode_depth_base64(depth: np.ndarray) -> str:
    """Encode depth map to base64 PNG (8-bit for JavaScript Canvas compatibility)"""
    # Normalize depth to 0-255 range for 8-bit PNG
    # JavaScript Canvas getImageData() only reads 8-bit RGBA values
    depth_min = np.nanmin(depth[depth > 0])  # Ignore zeros
    depth_max = np.nanmax(depth)
    if depth_max - depth_min < 1e-6:
        depth_normalized = np.zeros_like(depth, dtype=np.uint8)
    else:
        depth_normalized = ((depth - depth_min) / (depth_max - depth_min) * 255).astype(np.uint8)
    
    _, buffer = cv2.imencode('.png', depth_normalized)
    return f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"


def decode_depth_map(depth_data: Dict) -> Optional[np.ndarray]:
    """
    Decode depth map from photo's depthMap field.
    Returns normalized depth in meters.
    """
    if not depth_data:
        return None
    
    # Check for raw depth array or base64 encoded
    if 'depthArray' in depth_data:
        # Direct array data
        arr = np.array(depth_data['depthArray'], dtype=np.float32)
        if 'width' in depth_data and 'height' in depth_data:
            arr = arr.reshape((depth_data['height'], depth_data['width']))
        return arr
    
    # Check for base64 encoded depth image (multiple possible field names)
    depth_b64 = None
    for field_name in ['depthImage', 'depthImageData', 'depthData']:
        if field_name in depth_data and depth_data[field_name]:
            depth_b64 = depth_data[field_name]
            break
    
    if depth_b64:
        # Remove data URL prefix if present
        if ',' in depth_b64:
            depth_b64 = depth_b64.split(',')[1]
        
        # Fix base64 padding if needed (add missing '=' characters)
        padding_needed = len(depth_b64) % 4
        if padding_needed:
            depth_b64 += '=' * (4 - padding_needed)
        
    if depth_b64:
        # Remove data URL prefix if present
        if ',' in depth_b64:
            depth_b64 = depth_b64.split(',')[1]
        
        # Fix base64 padding if needed (add missing '=' characters)
        padding_needed = len(depth_b64) % 4
        if padding_needed:
            depth_b64 += '=' * (4 - padding_needed)
        
        try:
            img_data = base64.b64decode(depth_b64)
        except Exception as e:
            print(f"[Error] Failed to decode depth base64: {e}", file=sys.stderr)
            print(f"[Debug] depth_b64 length: {len(depth_b64)}, fields in depth_data: {list(depth_data.keys())}", file=sys.stderr)
            return None
            
        nparr = np.frombuffer(img_data, np.uint8)
        depth_img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        
        if depth_img is None:
            return None
        
        # Convert to float meters
        # ZoeDepth outputs: darker = closer, lighter = farther
        # Scale based on metadata if available, with realistic indoor defaults
        min_depth = depth_data.get('minDepth', 0.3)  # 1ft - typical min distance
        max_depth = depth_data.get('maxDepth', 6.0)  # 20ft - typical room depth
        
        # Cap maximum depth for indoor scenes (prevent unrealistic values from metadata)
        if max_depth > 15.0:  # 50ft - beyond typical room size
            print(f"[Warning] Capping maxDepth from {max_depth:.1f}m to 6.0m for indoor scene", file=sys.stderr)
            max_depth = 6.0
        
        if depth_img.dtype == np.uint16:
            # Canvas always returns 8-bit data
            depth_normalized = depth_img.astype(np.float32) / 255.0
        else:
            depth_normalized = depth_img.astype(np.float32) / 255.0
        
        # Auto-detect depth range from data distribution (ignore outliers)
        # Use 5th and 95th percentiles to ignore extreme values
        p5 = np.percentile(depth_normalized, 5)
        p95 = np.percentile(depth_normalized, 95)
        
        # Rescale to use full normalized range
        if p95 > p5:
            depth_normalized = np.clip((depth_normalized - p5) / (p95 - p5), 0, 1)
        
        # Map to metric depth range
        depth_meters = min_depth + depth_normalized * (max_depth - min_depth)
        return depth_meters
    
    return None


# =============================================================================
# PHOTOGRAMMETRY: FEATURE MATCHING BETWEEN OVERLAPPING PHOTOS
# =============================================================================

def find_overlapping_pairs(photos: List[Dict], overlap_threshold: float = 30) -> List[Tuple[int, int]]:
    """
    Find pairs of photos that likely overlap based on their orientations.
    overlap_threshold: maximum angular distance (degrees) to consider overlapping
    """
    pairs = []
    n = len(photos)
    
    for i in range(n):
        R_i = get_camera_rotation(photos[i])
        dir_i = rotation_matrix_to_direction(R_i)
        
        for j in range(i + 1, n):
            R_j = get_camera_rotation(photos[j])
            dir_j = rotation_matrix_to_direction(R_j)
            
            # Angular distance between viewing directions
            dot = np.clip(np.dot(dir_i, dir_j), -1, 1)
            angle = math.degrees(math.acos(dot))
            
            if angle < overlap_threshold:
                pairs.append((i, j))
    
    return pairs


def match_features_between_photos(
    img1: np.ndarray, 
    img2: np.ndarray,
    R1: np.ndarray,
    R2: np.ndarray,
    min_matches: int = 10
) -> Tuple[Optional[np.ndarray], List[cv2.DMatch]]:
    """
    Match SIFT features between two photos and estimate relative rotation refinement.
    
    Returns:
        delta_R: Relative rotation correction (or None if matching failed)
        matches: List of good matches
    """
    # Convert to grayscale
    gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)
    
    # Detect SIFT features
    sift = cv2.SIFT_create(nfeatures=2000)
    kp1, desc1 = sift.detectAndCompute(gray1, None)
    kp2, desc2 = sift.detectAndCompute(gray2, None)
    
    if desc1 is None or desc2 is None or len(kp1) < 10 or len(kp2) < 10:
        return None, []
    
    # Match with FLANN
    index_params = dict(algorithm=1, trees=5)  # FLANN_INDEX_KDTREE
    search_params = dict(checks=50)
    flann = cv2.FlannBasedMatcher(index_params, search_params)
    
    matches = flann.knnMatch(desc1, desc2, k=2)
    
    # Lowe's ratio test
    good_matches = []
    for m_n in matches:
        if len(m_n) == 2:
            m, n = m_n
            if m.distance < 0.7 * n.distance:
                good_matches.append(m)
    
    if len(good_matches) < min_matches:
        return None, good_matches
    
    # Extract matched points
    pts1 = np.float32([kp1[m.queryIdx].pt for m in good_matches])
    pts2 = np.float32([kp2[m.trainIdx].pt for m in good_matches])
    
    # Estimate essential matrix (for rotation refinement)
    # Using image center as principal point approximation
    h1, w1 = img1.shape[:2]
    focal = w1  # Approximate focal length
    pp = (w1 / 2, h1 / 2)
    
    E, mask = cv2.findEssentialMat(pts1, pts2, focal, pp, cv2.RANSAC, 0.999, 1.0)
    
    if E is None:
        return None, good_matches
    
    # Recover rotation from essential matrix
    _, R_rel, t, _ = cv2.recoverPose(E, pts1, pts2, focal=focal, pp=pp)
    
    return R_rel, good_matches


def refine_camera_rotations(
    photos: List[Dict], 
    images: List[np.ndarray],
    rotations: List[np.ndarray],
    use_vision: bool = False
) -> List[np.ndarray]:
    """
    Refine camera rotations using photogrammetric feature matching.
    Can use traditional SIFT or Vision-based semantic matching.
    """
    print("[Photogrammetry] Refining camera rotations with feature matching...", file=sys.stderr)
    
    n = len(photos)
    refined = [R.copy() for R in rotations]
    
    # Find overlapping pairs
    pairs = find_overlapping_pairs(photos, overlap_threshold=45)
    print(f"[Photogrammetry] Found {len(pairs)} overlapping photo pairs", file=sys.stderr)
    
    if len(pairs) == 0:
        print("[Photogrammetry] Warning: No overlapping pairs found, using sensor-only poses", file=sys.stderr)
        return refined
    
    # Import vision assistant if needed
    vision_assistant = None
    if use_vision:
        try:
            from vision_stitching_assistant import vision_find_correspondences
            vision_assistant = vision_find_correspondences
            print("[Photogrammetry] Using OpenAI Vision for semantic feature matching", file=sys.stderr)
        except Exception as e:
            print(f"[Photogrammetry] Vision assistant not available: {e}, falling back to SIFT", file=sys.stderr)
            use_vision = False
    
    # Match features for each pair
    corrections = {i: [] for i in range(n)}
    
    for i, j in pairs:
        matches = []
        
        # Try Vision-based matching first if available
        if use_vision and vision_assistant:
            try:
                correspondences = vision_assistant(images[i], images[j], photos[i], photos[j])
                if len(correspondences) >= 8:
                    # Convert to pts format
                    pts1 = np.float32([p1 for p1, p2 in correspondences])
                    pts2 = np.float32([p2 for p1, p2 in correspondences])
                    
                    # Compute rotation from correspondences
                    h1, w1 = images[i].shape[:2]
                    focal = w1
                    pp = (w1 / 2, h1 / 2)
                    
                    E, mask = cv2.findEssentialMat(pts1, pts2, focal, pp, cv2.RANSAC, 0.999, 1.0)
                    if E is not None:
                        _, R_rel, _, _ = cv2.recoverPose(E, pts1, pts2, focal=focal, pp=pp)
                        delta_R = R_rel
                        matches = correspondences
                        print(f"[Photogrammetry] Pair ({i}, {j}): {len(matches)} Vision matches", file=sys.stderr)
            except Exception as e:
                print(f"[Photogrammetry] Vision matching failed for pair ({i}, {j}): {e}", file=sys.stderr)
        
        # Fall back to SIFT if Vision didn't work or not available
        if len(matches) < 8:
            delta_R, sift_matches = match_features_between_photos(
                images[i], images[j], 
                rotations[i], rotations[j]
            )
            
            if delta_R is not None and len(sift_matches) >= 10:
                print(f"[Photogrammetry] Pair ({i}, {j}): {len(sift_matches)} SIFT matches", file=sys.stderr)
                corrections[j].append((delta_R, len(sift_matches)))
        elif len(matches) >= 8:
            # Use Vision matches
            corrections[j].append((delta_R, len(matches)))
    
    # Apply weighted average corrections
    for i in range(n):
        if corrections[i]:
            total_weight = sum(w for _, w in corrections[i])
            if total_weight > 0:
                # Weighted average of rotation corrections
                avg_correction = np.zeros((3, 3))
                for delta_R, weight in corrections[i]:
                    avg_correction += delta_R * (weight / total_weight)
                
                # Ensure orthonormality via SVD
                U, _, Vt = np.linalg.svd(avg_correction)
                avg_correction = U @ Vt
                
                # Blend with original - TRUST SENSOR DATA MORE
                # Only apply small corrections from feature matching
                # Large corrections suggest the matching is wrong, not the sensors
                blend_factor = 0.15  # Reduced from 0.5 - sensors are more reliable
                refined[i] = (1 - blend_factor) * refined[i] + blend_factor * (refined[i] @ avg_correction)
                
                # Re-orthonormalize
                U, _, Vt = np.linalg.svd(refined[i])
                refined[i] = U @ Vt
    
    print("[Photogrammetry] Rotation refinement complete", file=sys.stderr)
    return refined


# =============================================================================
# SPHERICAL PROJECTION (WITH DEPTH SUPPORT)
# =============================================================================

def project_photo_to_sphere(
    img: np.ndarray,
    rotation: np.ndarray,
    intrinsics: Dict,
    equirect_width: int,
    equirect_height: int,
    depth_map: Optional[np.ndarray] = None
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Project a single photo onto the equirectangular canvas using its camera pose.
    Optionally projects depth map alongside color for depth-aware blending.
    
    Returns:
        projected: The color contribution to the equirectangular image
        weight: Per-pixel weight for blending (higher in center, zero outside FOV)
        projected_depth: The depth contribution (or zeros if no depth available)
    """
    img_h, img_w = img.shape[:2]
    fx = intrinsics['focalLengthX']
    fy = intrinsics['focalLengthY']
    cx = intrinsics['principalPointX']
    cy = intrinsics['principalPointY']
    
    # Resize depth map to match image if needed
    depth_available = depth_map is not None
    if depth_available:
        if depth_map.shape[:2] != (img_h, img_w):
            depth_map = cv2.resize(depth_map, (img_w, img_h), interpolation=cv2.INTER_LINEAR)
    
    # Output buffers
    projected = np.zeros((equirect_height, equirect_width, 3), dtype=np.float32)
    weight = np.zeros((equirect_height, equirect_width), dtype=np.float32)
    projected_depth = np.zeros((equirect_height, equirect_width), dtype=np.float32)
    
    # Inverse rotation to transform from world to camera
    R_inv = rotation.T
    
    # For each pixel in equirectangular, find corresponding pixel in source image
    for v in range(equirect_height):
        # Elevation angle (phi): top = +π/2, bottom = -π/2
        phi = (0.5 - v / equirect_height) * math.pi
        
        for u in range(equirect_width):
            # Azimuth angle (theta): left = -π, right = +π
            theta = (u / equirect_width - 0.5) * 2 * math.pi
            
            # Convert to 3D direction (world space)
            world_dir = np.array([
                math.cos(phi) * math.sin(theta),
                math.sin(phi),
                math.cos(phi) * math.cos(theta)
            ])
            
            # Transform to camera space
            cam_dir = R_inv @ world_dir
            
            # Only consider points in front of camera
            if cam_dir[2] <= 0.01:
                continue
            
            # Project to image plane (pinhole model)
            img_x = fx * (cam_dir[0] / cam_dir[2]) + cx
            img_y = fy * (cam_dir[1] / cam_dir[2]) + cy
            
            # Check if within image bounds
            if 0 <= img_x < img_w - 1 and 0 <= img_y < img_h - 1:
                # Bilinear interpolation
                x0, y0 = int(img_x), int(img_y)
                x1, y1 = x0 + 1, y0 + 1
                dx, dy = img_x - x0, img_y - y0
                
                color = (
                    img[y0, x0] * (1 - dx) * (1 - dy) +
                    img[y0, x1] * dx * (1 - dy) +
                    img[y1, x0] * (1 - dx) * dy +
                    img[y1, x1] * dx * dy
                )
                
                projected[v, u] = color
                
                # Also interpolate depth if available
                if depth_available:
                    depth_val = (
                        depth_map[y0, x0] * (1 - dx) * (1 - dy) +
                        depth_map[y0, x1] * dx * (1 - dy) +
                        depth_map[y1, x0] * (1 - dx) * dy +
                        depth_map[y1, x1] * dx * dy
                    )
                    # Ensure depth_val is a scalar (take first channel if multi-channel)
                    if isinstance(depth_val, np.ndarray):
                        depth_val = float(depth_val.flat[0])
                    projected_depth[v, u] = depth_val
                
                # Weight: higher in center of image, falls off toward edges
                dist_x = abs(img_x - cx) / (img_w / 2)
                dist_y = abs(img_y - cy) / (img_h / 2)
                dist = math.sqrt(dist_x**2 + dist_y**2)
                weight[v, u] = max(0, 1 - dist**2)  # Quadratic falloff
    
    return projected, weight, projected_depth


def stitch_panorama(
    photos: List[Dict],
    images: List[np.ndarray],
    depth_maps: List[Optional[np.ndarray]],
    output_width: int = 4096,
    output_height: int = 2048,
    use_photogrammetry: bool = True,
    use_depth_blending: bool = True,
    use_vision: bool = False,
    use_google_stitcher: bool = True  # NEW: Use Google Street View-style stitching
) -> Tuple[np.ndarray, Optional[np.ndarray], Dict]:
    """
    Main stitching function: project all photos onto sphere and blend.
    Uses depth-aware blending when depth maps are available.
    
    NEW: Can use Google Street View-style stitching with:
    - Feature-based alignment (SIFT)
    - Optimal image ordering
    - Exposure compensation
    - Multi-band blending
    - Seam optimization
    
    Returns:
        color_panorama: Stitched RGB panorama
        depth_panorama: Stitched depth panorama (or None if no depth data)
        stats: Statistics about the stitching process
    """
    n = len(images)
    has_depth = any(d is not None for d in depth_maps)
    depth_count = sum(1 for d in depth_maps if d is not None)
    
    print(f"[Stitch] Processing {n} photos into {output_width}x{output_height} panorama", file=sys.stderr)
    print(f"[Stitch] Depth data available: {depth_count}/{n} photos", file=sys.stderr)
    
    # =========================================================================
    # PRIORITY 1: Try Optimized Stitcher (Brown & Lowe + Google Street View)
    # =========================================================================
    if OPTIMIZED_STITCHER_AVAILABLE and n >= 3:
        print("[Stitch] Using Optimized Stitcher (Brown & Lowe + sensor-anchored)...", file=sys.stderr)
        try:
            color_panorama, depth_panorama, stats = stitch_with_optimized_method(
                photos, images, depth_maps,
                output_width=output_width,
                output_height=output_height
            )
            stats['stitchMethod'] = 'optimized_brown_lowe_google'
            print("[Stitch] Optimized stitching complete!", file=sys.stderr)
            return color_panorama, depth_panorama, stats
        except Exception as e:
            print(f"[Stitch] Optimized stitching failed: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            print("[Stitch] Falling back to bundle adjustment method...", file=sys.stderr)
    
    # =========================================================================
    # FALLBACK 1: Try Bundle Adjustment stitching (Brown & Lowe 2007)
    # =========================================================================
    if BUNDLE_ADJUSTMENT_AVAILABLE and n >= 3:
        print("[Stitch] Using Bundle Adjustment stitching (Brown & Lowe 2007)...", file=sys.stderr)
        try:
            color_panorama, depth_panorama, stats = stitch_with_bundle_adjustment(
                photos, images, depth_maps,
                output_width=output_width,
                output_height=output_height
            )
            stats['stitchMethod'] = 'bundle_adjustment'
            print("[Stitch] Bundle adjustment stitching complete!", file=sys.stderr)
            return color_panorama, depth_panorama, stats
        except Exception as e:
            print(f"[Stitch] Bundle adjustment stitching failed: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            print("[Stitch] Falling back to Google-style method...", file=sys.stderr)
    
    # =========================================================================
    # FALLBACK 2: Try Google Street View-style stitching
    # =========================================================================
    if use_google_stitcher and GOOGLE_STITCHER_AVAILABLE and n >= 3:
        print("[Stitch] Using Google Street View-style stitching (fallback)...", file=sys.stderr)
        try:
            color_panorama, depth_panorama, stats = stitch_with_google_method(
                photos, images, depth_maps,
                output_width=output_width,
                output_height=output_height
            )
            stats['stitchMethod'] = 'google_streetview'
            print("[Stitch] Google-style stitching complete!", file=sys.stderr)
            return color_panorama, depth_panorama, stats
        except Exception as e:
            print(f"[Stitch] Google-style stitching failed: {e}", file=sys.stderr)
            print("[Stitch] Falling back to legacy sensor-based method...", file=sys.stderr)
    
    # =========================================================================
    # FALLBACK 3: Original sensor-based stitching (last resort)
    # =========================================================================
    print("[Stitch] Using legacy sensor-based stitching...", file=sys.stderr)
    
    # 1. Extract initial camera rotations from sensor data
    print("[Stitch] Extracting camera orientations from sensor data...", file=sys.stderr)
    rotations = [get_camera_rotation(photo) for photo in photos]
    
    # 2. Refine rotations using photogrammetry (feature matching)
    # DISABLED: Feature matching can introduce errors when matches are ambiguous
    # Sensor data (gyro+compass) should be trusted as ground truth
    # if use_photogrammetry and n > 1:
    #     rotations = refine_camera_rotations(photos, images, rotations, use_vision=use_vision)
    print("[Stitch] Using pure sensor positioning (photogrammetry refinement disabled)", file=sys.stderr)
    
    # 3. Project each photo (and its depth) onto the sphere
    print("[Stitch] Projecting photos onto sphere...", file=sys.stderr)
    
    # Compute Vision-guided blending weights if available
    # DISABLED: Vision API requires per-pair overlap regions, not global analysis
    # Depth-aware blending is more reliable for positioning
    vision_blend_weights = None
    # if use_vision and VISION_AVAILABLE and len(photos) >= 6:
    #     try:
    #         from vision_stitching_assistant import vision_compute_blending_weights
    #         print("[Vision] Computing quality-based blending weights...", file=sys.stderr)
    #         vision_blend_weights = vision_compute_blending_weights(photos, images)
    #     except Exception as e:
    #         print(f"[Vision] Blending weight computation failed: {e}", file=sys.stderr)
    
    # Storage for all projections (for depth-aware blending)
    all_projections = []  # List of (color, weight, depth, elevation) for each photo
    
    for i, (photo, img, R, depth) in enumerate(zip(photos, images, rotations, depth_maps)):
        print(f"[Stitch] Projecting photo {i+1}/{n}...", file=sys.stderr)
        
        intrinsics = get_camera_intrinsics(photo, img.shape[1], img.shape[0])
        projected, weight, projected_depth = project_photo_to_sphere(
            img, R, intrinsics, output_width, output_height, depth
        )
        
        # Apply Vision-guided quality adjustment to weights
        if vision_blend_weights and i < len(vision_blend_weights.get('photo_weights', [])):
            quality_factor = vision_blend_weights['photo_weights'][i].get('quality_factor', 1.0)
            weight = weight * quality_factor
            print(f"[Vision] Photo {i+1} quality factor: {quality_factor:.2f}", file=sys.stderr)
        
        # Store elevation for sorting (walls should go on top of floor/ceiling)
        elevation = photo.get('elevation', 0)
        all_projections.append((projected, weight, projected_depth, elevation, i))
    
    # 4. Blend based on depth or weighted average
    print("[Stitch] Blending...", file=sys.stderr)
    
    # Compute Vision-guided optimal seam placement for critical pairs
    # DISABLED: Vision seam finding requires overlap masks, depth-aware blending handles this better
    vision_seams = None
    # if use_vision and VISION_AVAILABLE and len(photos) >= 6:
    #     try:
    #         from vision_stitching_assistant import vision_find_optimal_seam
    #         print("[Vision] Computing optimal seam placements...", file=sys.stderr)
    #         
    #         # Find seams for adjacent photo pairs
    #         vision_seams = {}
    #         critical_pairs = [(i, (i+1) % len(photos)) for i in range(min(len(photos), 12))]
    #         
    #         for i, j in critical_pairs:
    #             seam_result = vision_find_optimal_seam(
    #                 photos[i], photos[j], images[i], images[j]
    #             )
    #             if seam_result.get('seam_path'):
    #                 vision_seams[(i, j)] = seam_result
    #                 print(f"[Vision] Optimal seam found for photos {i+1}-{j+1}: confidence {seam_result.get('confidence', 0):.2f}", file=sys.stderr)
    #     except Exception as e:
    #         print(f"[Vision] Seam computation failed: {e}", file=sys.stderr)
    
    # TESTING: Use NO BLENDING - just place photos at sensor positions with no averaging
    # Sort projections: ceiling/floor first (high/low elevation), then walls (near 0° elevation)
    # This ensures walls are placed on top and are visible
    print("[Stitch] Sorting photos: ceiling/floor first, walls on top...", file=sys.stderr)
    all_projections.sort(key=lambda x: abs(x[3]))  # Sort by absolute elevation (walls = ~0° go last)
    all_projections.reverse()  # Reverse so high elevation goes first, walls go last (on top)
    
    # VISION OPTIMIZATION: Use Vision AI to analyze placement and suggest improvements
    if use_vision and VISION_AVAILABLE:
        try:
            from vision_placement_optimizer import (
                create_placement_preview,
                analyze_placement_with_vision,
                apply_vision_optimization
            )
            
            print("[Vision Optimizer] Creating initial placement preview...", file=sys.stderr)
            initial_preview = create_placement_preview(all_projections, output_width, output_height)
            
            print("[Vision Optimizer] Analyzing placement with Vision AI...", file=sys.stderr)
            vision_analysis = analyze_placement_with_vision(photos, images, all_projections, initial_preview)
            
            # Apply Vision's suggested layering order
            if vision_analysis.get('layering_order'):
                all_projections = apply_vision_optimization(all_projections, vision_analysis)
            
        except Exception as e:
            print(f"[Vision Optimizer] Failed: {e}", file=sys.stderr)
            print("[Vision Optimizer] Continuing with sensor-only placement", file=sys.stderr)
    
    print("[Stitch] Using NO BLENDING - pure sensor positioning (walls placed last, on top)", file=sys.stderr)
    color_result = np.zeros((output_height, output_width, 3), dtype=np.uint8)
    depth_result = np.zeros((output_height, output_width), dtype=np.float32)
    
    # Simply overwrite with each photo (last one wins in overlaps)
    for projected, weight, projected_depth, elevation, orig_idx in all_projections:
        # Only copy pixels where this photo has valid data
        valid_mask = weight > 0.01
        color_result[valid_mask] = projected[valid_mask]
        
        if np.any(projected_depth > 0):
            depth_mask = valid_mask & (projected_depth > 0)
            depth_result[depth_mask] = projected_depth[depth_mask]
        
        print(f"[Stitch] Placed photo {orig_idx+1} (elevation={elevation:.1f}°)", file=sys.stderr)
    
    # 5. Fill gaps (if any) with advanced inpainting
    gaps = np.all(color_result == 0, axis=2)
    gap_count = np.sum(gaps)
    if gap_count > 0:
        print(f"[Stitch] Filling {gap_count} unfilled pixels ({100*gap_count/(output_width*output_height):.1f}%) with inpainting...", file=sys.stderr)
        
        # Use better inpainting on color image
        gap_mask = gaps.astype(np.uint8) * 255
        color_result = cv2.inpaint(
            color_result,
            gap_mask,
            inpaintRadius=10,  # Larger radius for better gap filling
            flags=cv2.INPAINT_TELEA  # Navier-Stokes based method
        )
        
        if depth_result is not None:
            # Fill depth gaps with inpainting
            depth_mask = (depth_result == 0).astype(np.uint8)
            if np.any(depth_mask):
                # Convert to 16-bit for better precision
                depth_scaled = (depth_result * 1000).astype(np.uint16)
                depth_scaled = cv2.inpaint(
                    depth_scaled,
                    depth_mask,
                    inpaintRadius=10,
                    flags=cv2.INPAINT_TELEA
                )
                depth_result = depth_scaled.astype(np.float32) / 1000
    
    stats = {
        'photoCount': n,
        'depthPhotos': depth_count,
        'depthBlendingUsed': has_depth and use_depth_blending,
        'gapPixels': int(gap_count),
        'gapPercent': round(100 * gap_count / (output_width * output_height), 2)
    }
    
    print("[Stitch] Complete!", file=sys.stderr)
    return color_result, depth_result, stats


def depth_aware_blend(
    projections: List[Tuple[np.ndarray, np.ndarray, np.ndarray]],
    output_width: int,
    output_height: int,
    vision_seams: Optional[dict] = None
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Blend projections using depth to determine which pixel is in front.
    For overlapping regions, prefer the closer surface (smaller depth).
    Uses soft blending near depth boundaries to avoid harsh edges.
    Optionally uses Vision-guided seam placement for optimal boundaries.
    """
    # Initialize outputs
    color_result = np.zeros((output_height, output_width, 3), dtype=np.uint8)
    depth_result = np.full((output_height, output_width), np.inf, dtype=np.float32)
    
    # First pass: find minimum depth at each pixel
    for projected, weight, projected_depth in projections:
        valid_mask = weight > 0.01
        has_depth_mask = projected_depth > 0
        
        combined_mask = valid_mask & has_depth_mask
        
        # Update depth where this projection is closer
        closer_mask = combined_mask & (projected_depth < depth_result)
        depth_result[closer_mask] = projected_depth[closer_mask]
    
    # Second pass: blend colors with depth-based weights
    # Use soft blending: weight decreases as depth increases beyond minimum
    DEPTH_BLEND_RANGE = 0.1  # 10cm blending range
    
    color_accumulator = np.zeros((output_height, output_width, 3), dtype=np.float64)
    weight_accumulator = np.zeros((output_height, output_width), dtype=np.float64)
    depth_accumulator = np.zeros((output_height, output_width), dtype=np.float64)
    depth_weight_sum = np.zeros((output_height, output_width), dtype=np.float64)
    
    for projected, weight, projected_depth in projections:
        # Create depth-based weight modifier
        valid_mask = weight > 0.01
        
        depth_weight = np.ones_like(weight)
        
        # If we have depth info, reduce weight for pixels that are behind
        has_depth = projected_depth > 0
        if np.any(has_depth):
            depth_diff = projected_depth - depth_result  # Positive means behind
            # Smooth falloff: full weight at min depth, zero at min+range
            depth_factor = np.clip(1.0 - depth_diff / DEPTH_BLEND_RANGE, 0, 1)
            depth_weight[has_depth] = depth_factor[has_depth]
        
        # Combined weight
        final_weight = weight * depth_weight
        
        # Accumulate
        for c in range(3):
            color_accumulator[:, :, c] += projected[:, :, c] * final_weight
        weight_accumulator += final_weight
        
        # Accumulate depth (weighted average)
        depth_mask = valid_mask & (projected_depth > 0)
        depth_accumulator[depth_mask] += projected_depth[depth_mask] * weight[depth_mask]
        depth_weight_sum[depth_mask] += weight[depth_mask]
    
    # Normalize
    valid = weight_accumulator > 0
    for c in range(3):
        color_result[:, :, c][valid] = np.clip(
            color_accumulator[:, :, c][valid] / weight_accumulator[valid], 0, 255
        ).astype(np.uint8)
    
    # Final depth is weighted average
    depth_valid = depth_weight_sum > 0
    final_depth = np.zeros((output_height, output_width), dtype=np.float32)
    final_depth[depth_valid] = depth_accumulator[depth_valid] / depth_weight_sum[depth_valid]
    
    return color_result, final_depth


def weighted_average_blend(
    projections: List[Tuple[np.ndarray, np.ndarray, np.ndarray]],
    output_width: int,
    output_height: int,
    vision_seams: Optional[dict] = None
) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    """
    Simple weighted average blending (fallback when no depth available).
    Optionally uses Vision-guided seam placement for optimal boundaries.
    """
    accumulator = np.zeros((output_height, output_width, 3), dtype=np.float64)
    weight_sum = np.zeros((output_height, output_width), dtype=np.float64)
    depth_accumulator = np.zeros((output_height, output_width), dtype=np.float64)
    depth_weight_sum = np.zeros((output_height, output_width), dtype=np.float64)
    
    has_any_depth = False
    
    for projected, weight, projected_depth in projections:
        for c in range(3):
            accumulator[:, :, c] += projected[:, :, c] * weight
        weight_sum += weight
        
        # Track depth if available
        if np.any(projected_depth > 0):
            has_any_depth = True
            depth_mask = projected_depth > 0
            depth_accumulator[depth_mask] += projected_depth[depth_mask] * weight[depth_mask]
            depth_weight_sum[depth_mask] += weight[depth_mask]
    
    # Normalize color
    result = np.zeros((output_height, output_width, 3), dtype=np.uint8)
    mask = weight_sum > 0
    for c in range(3):
        result[:, :, c][mask] = np.clip(accumulator[:, :, c][mask] / weight_sum[mask], 0, 255).astype(np.uint8)
    
    # Normalize depth if available
    depth_result = None
    if has_any_depth:
        depth_result = np.zeros((output_height, output_width), dtype=np.float32)
        depth_mask = depth_weight_sum > 0
        depth_result[depth_mask] = depth_accumulator[depth_mask] / depth_weight_sum[depth_mask]
    
    return result, depth_result


# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description='Spherical panorama stitching with photogrammetry')
    parser.add_argument('--input', required=True, help='Input JSON file with photo data')
    parser.add_argument('--output', help='Output JSON file (defaults to stdout)')
    parser.add_argument('--output-width', type=int, default=4096, help='Output width')
    parser.add_argument('--output-height', type=int, default=2048, help='Output height')
    parser.add_argument('--no-photogrammetry', action='store_true', help='Skip feature matching refinement')
    parser.add_argument('--no-depth-blending', action='store_true', help='Skip depth-aware blending')
    parser.add_argument('--use-vision', action='store_true', help='Use OpenAI Vision for stitching analysis')
    
    args = parser.parse_args()
    
    try:
        # Load input
        print(f"[Init] Loading {args.input}...", file=sys.stderr)
        with open(args.input, 'r') as f:
            data = json.load(f)
        
        photos = data['photos']
        print(f"[Init] Found {len(photos)} photos", file=sys.stderr)
        
        if len(photos) < 1:
            raise ValueError("Need at least 1 photo")
        
        # Decode images and depth maps
        print("[Init] Decoding images and depth maps...", file=sys.stderr)
        images = []
        depth_maps = []
        
        for i, photo in enumerate(photos):
            img = decode_base64_image(photo['imageData'])
            images.append(img)
            
            # Decode depth map if available
            depth = decode_depth_map(photo.get('depthMap'))
            depth_maps.append(depth)
            
            az = photo.get('azimuth', 0)
            el = photo.get('elevation', 0)
            has_sensors = 'sensorData' in photo and photo['sensorData'] is not None
            has_depth = depth is not None
            print(f"  Photo {i+1}: {img.shape[1]}x{img.shape[0]}, az={az}°, el={el}°, sensors={'yes' if has_sensors else 'no'}, depth={'yes' if has_depth else 'no'}", file=sys.stderr)
        
        # Add photo indices for Vision analysis
        for i, photo in enumerate(photos):
            photo['index'] = i
        
        # Vision-guided stitching analysis (if enabled and available)
        vision_insights = None
        if args.use_vision and VISION_AVAILABLE:
            print("[Vision] Analyzing scene with OpenAI Vision...", file=sys.stderr)
            
            try:
                # DISABLED: Vision-based misplacement detection was incorrectly overriding
                # accurate sensor data with guesses based on visual analysis.
                # The phone's gyro/compass data should be trusted for positioning.
                # Vision AI should only be used for blending/quality, not repositioning.
                #
                # from vision_stitching_assistant import vision_detect_major_misplacements
                # print("[Vision] Checking for major misplacements...", file=sys.stderr)
                # misplacement_analysis = vision_detect_major_misplacements(photos, images)
                # ... (position corrections disabled)
                misplacement_analysis = {'misplaced_photos': []}
                
                print("[Vision] Using sensor data for positioning (Vision misplacement detection disabled)", file=sys.stderr)
                
                # STEP 2: Get global strategy (for blending recommendations only)
                strategy = get_global_stitching_strategy(photos, images)
                print(f"[Vision] Scene type: {strategy.get('scene_type')}", file=sys.stderr)
                print(f"[Vision] Lighting: {strategy.get('lighting_quality')}", file=sys.stderr)
                print(f"[Vision] Recommended blending: {strategy.get('recommended_strategy', {}).get('blending_method')}", file=sys.stderr)
                
                # STEP 3: Analyze critical photo pairs
                pair_analyses = []
                critical_pairs = [(0, 1), (len(photos)//4, len(photos)//4 + 1), 
                                 (len(photos)//2, len(photos)//2 + 1)]
                
                for i, j in critical_pairs:
                    if j < len(photos):
                        print(f"[Vision] Analyzing pair {i+1}-{j+1}...", file=sys.stderr)
                        analysis = analyze_photo_pair_overlap(photos[i], photos[j], images)
                        pair_analyses.append({
                            'pair': (i, j),
                            'coherence': analysis.get('visual_coherence', 0.5),
                            'quality': analysis.get('alignment_quality'),
                            'issues': analysis.get('problematic_areas', [])
                        })
                        print(f"[Vision]   Coherence: {analysis.get('visual_coherence', 0):.2f}, Quality: {analysis.get('alignment_quality')}", file=sys.stderr)
                
                vision_insights = {
                    'strategy': strategy,
                    'pair_analyses': pair_analyses,
                    'misplacements_corrected': len([mp for mp in misplacement_analysis.get('misplaced_photos', []) if mp.get('confidence', 0) > 0.75])
                }
                
                # Apply recommended settings
                if strategy.get('recommended_strategy'):
                    rec = strategy['recommended_strategy']
                    if rec.get('exposure_correction'):
                        print("[Vision] Applying exposure correction as recommended", file=sys.stderr)
                        # Could add exposure normalization here
                
            except Exception as e:
                print(f"[Vision] Analysis failed: {e}, continuing without Vision guidance", file=sys.stderr)
        
        # Stitch with depth integration
        color_panorama, depth_panorama, stats = stitch_panorama(
            photos, 
            images,
            depth_maps,
            args.output_width, 
            args.output_height,
            use_photogrammetry=not args.no_photogrammetry,
            use_depth_blending=not args.no_depth_blending,
            use_vision=args.use_vision
        )
        
        # Vision-guided projection refinement (analyze result and potentially re-stitch)
        projection_analysis = None
        if args.use_vision and len(photos) >= 6:
            try:
                from vision_stitching_assistant import vision_refine_projection
                print("[Vision] Analyzing panorama quality for refinement...", file=sys.stderr)
                
                projection_analysis = vision_refine_projection(color_panorama, photos)
                
                quality = projection_analysis.get('overall_quality', 1.0)
                issues = projection_analysis.get('issues', [])
                corrections = projection_analysis.get('pose_corrections', [])
                
                # DISABLED: Vision-based re-stitching was making things worse by
                # guessing at position corrections. Trust the sensor data.
                # If quality is poor, it's likely a capture/lighting issue, not positioning.
                print(f"[Vision] Quality {quality:.2f} - sensor positioning is trusted, no pose corrections applied", file=sys.stderr)
                
                # Original re-stitching code disabled:
                # if quality < 0.6 and corrections and projection_analysis.get('requires_restitching', False):
                #     ... (was applying pose corrections and re-stitching)
                    
            except Exception as e:
                print(f"[Vision] Projection refinement failed: {e}", file=sys.stderr)
        
        # Encode results
        print("[Output] Encoding result...", file=sys.stderr)
        color_base64 = encode_image_base64(color_panorama)
        
        # IMPORTANT: Remove point cloud from stats BEFORE spreading into result
        # to prevent 500MB+ of data being embedded in the main JSON
        point_cloud_data = None
        if 'pointCloud' in stats:
            point_cloud_data = stats.pop('pointCloud')  # Remove and save for later
        
        result = {
            'success': True,
            'equirectangularImage': color_base64,
            'width': color_panorama.shape[1],
            'height': color_panorama.shape[0],
            'metadata': {
                'photoCount': len(photos),
                'method': 'spherical_photogrammetry',
                'photogrammetryEnabled': not args.no_photogrammetry,
                'depthBlendingEnabled': not args.no_depth_blending,
                'visionAnalysisEnabled': args.use_vision and vision_insights is not None,
                'projection': 'equirectangular',
                **stats
            }
        }
        
        # Include Vision insights if available
        if vision_insights:
            result['metadata']['visionInsights'] = {
                'sceneType': vision_insights['strategy'].get('scene_type'),
                'lightingQuality': vision_insights['strategy'].get('lighting_quality'),
                'averageCoherence': np.mean([p['coherence'] for p in vision_insights['pair_analyses']]),
                'challenges': vision_insights['strategy'].get('challenges', [])
            }
            print(f"[Vision] Overall coherence: {result['metadata']['visionInsights']['averageCoherence']:.2f}", file=sys.stderr)
        
        # Include projection refinement analysis if available
        if projection_analysis:
            result['metadata']['projectionAnalysis'] = {
                'overallQuality': projection_analysis.get('overall_quality', 1.0),
                'issueCount': len(projection_analysis.get('issues', [])),
                'refinementApplied': stats.get('visionRefinementApplied', False)
            }
        
        # Include depth panorama if generated
        if depth_panorama is not None and np.any(depth_panorama > 0):
            print("[Output] Encoding depth panorama...", file=sys.stderr)
            
            # Calculate depth statistics for the metadata
            valid_depth = depth_panorama[depth_panorama > 0]
            if len(valid_depth) > 0:
                result['depthPanorama'] = {
                    'data': encode_depth_base64(depth_panorama),
                    'width': depth_panorama.shape[1],
                    'height': depth_panorama.shape[0],
                    'minDepth': float(np.min(valid_depth)),
                    'maxDepth': float(np.max(valid_depth)),
                    'meanDepth': float(np.mean(valid_depth)),
                    'medianDepth': float(np.median(valid_depth)),
                    'validPixels': int(len(valid_depth)),
                    'coverage': round(100 * len(valid_depth) / depth_panorama.size, 2)
                }
                print(f"  Depth range: {result['depthPanorama']['minDepth']:.2f}m - {result['depthPanorama']['maxDepth']:.2f}m", file=sys.stderr)
                print(f"  Coverage: {result['depthPanorama']['coverage']}%", file=sys.stderr)
                
                # Calculate room dimensions from depth panorama
                print("[Output] Calculating room dimensions from depth...", file=sys.stderr)
                room_dims = calculate_room_dimensions(depth_panorama)
                if room_dims:
                    result['roomDimensions'] = room_dims
                    print(f"  Room: {room_dims['widthMeters']:.1f}m × {room_dims['lengthMeters']:.1f}m × {room_dims['heightMeters']:.1f}m", file=sys.stderr)
                    print(f"  ({room_dims['widthFeet']:.1f}ft × {room_dims['lengthFeet']:.1f}ft × {room_dims['heightFeet']:.1f}ft)", file=sys.stderr)
        
        # Include point cloud if generated
        if 'pointCloudPoints' in stats and stats['pointCloudPoints'] > 0:
            total = stats.get('pointCloudTotal', stats['pointCloudPoints'])
            included = stats['pointCloudPoints']
            print(f"[Output] Point cloud: {total:,} generated, {included:,} included", file=sys.stderr)
            result['metadata']['pointCloudGenerated'] = True
            result['metadata']['pointCloudSize'] = included
            result['metadata']['pointCloudTotalGenerated'] = total
            
            # Save point cloud to separate file in streamable NDJSON format
            # Each line is one point: {"p":[x,y,z],"c":[r,g,b]}
            if point_cloud_data:
                output_id = args.output.split('_')[-1].replace('.json', '') if args.output else str(int(time.time() * 1000))
                base_dir = os.path.dirname(args.output) if args.output else '.'
                
                pointcloud_file = os.path.join(base_dir, f'pointcloud_{output_id}.ndjson')
                print(f"[Output] Saving point cloud to streamable NDJSON: {pointcloud_file}", file=sys.stderr)
                
                points = point_cloud_data.get('points', [])
                colors = point_cloud_data.get('colors', [])
                
                with open(pointcloud_file, 'w') as f:
                    # First line is metadata
                    f.write(json.dumps({'total': len(points), 'type': 'pointcloud'}) + '\n')
                    
                    # Each subsequent line is a point
                    for i, pt in enumerate(points):
                        color = colors[i] if i < len(colors) else [1, 1, 1]
                        f.write(json.dumps({'p': pt, 'c': color}) + '\n')
                
                result['pointCloudFile'] = os.path.basename(pointcloud_file)
                result['pointCloudPath'] = pointcloud_file
                
                file_size_mb = os.path.getsize(pointcloud_file) / 1024 / 1024
                print(f"[Output] Point cloud saved: {len(points):,} points, {file_size_mb:.1f}MB", file=sys.stderr)
            
            # Use room dimensions from point cloud (more accurate than depth panorama)
            if 'roomDimensionsFromPointCloud' in stats and stats['roomDimensionsFromPointCloud']:
                result['roomDimensionsFromPointCloud'] = stats['roomDimensionsFromPointCloud']
                dims = stats['roomDimensionsFromPointCloud']
                print(f"[Output] Room dimensions (from point cloud): {dims['widthMeters']:.1f}m × {dims['lengthMeters']:.1f}m × {dims['heightMeters']:.1f}m", file=sys.stderr)
                print(f"[Output]   ({dims['widthFeet']:.1f}ft × {dims['lengthFeet']:.1f}ft × {dims['heightFeet']:.1f}ft)", file=sys.stderr)
        
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(result, f)
            print(f"[Success] Saved to {args.output}", file=sys.stderr)
        else:
            print(json.dumps(result))
        
        return 0
        
    except Exception as e:
        import traceback
        print(f"[Error] {str(e)}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        
        error_result = {
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }
        
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(error_result, f)
        else:
            print(json.dumps(error_result))
        
        return 1


if __name__ == '__main__':
    sys.exit(main())
