#!/usr/bin/env python3
"""
Test depth map to point cloud conversion with real scan data
"""

import json
import numpy as np
import base64
import cv2
import math
from pathlib import Path

def decode_depth_map(depth_data):
    """Decode depth map to numpy array"""
    if isinstance(depth_data, dict):
        # New format: {depthImage: "data:image/png;base64,...", minDepth, maxDepth}
        depth_img_data = depth_data['depthImage']
        min_depth = depth_data.get('minDepth', 0.1)
        max_depth = depth_data.get('maxDepth', 10.0)
        
        # Remove data URL prefix
        if depth_img_data.startswith('data:image/png;base64,'):
            depth_img_data = depth_img_data.replace('data:image/png;base64,', '')
        
        # Decode PNG
        img_bytes = base64.b64decode(depth_img_data)
        img_array = np.frombuffer(img_bytes, dtype=np.uint8)
        depth_img = cv2.imdecode(img_array, cv2.IMREAD_UNCHANGED)
        
        # Handle multi-channel images (take first channel only)
        if len(depth_img.shape) == 3:
            depth_img = depth_img[:, :, 0]
        
        # Convert from uint16 to actual depth values
        if depth_img.dtype == np.uint16:
            # Normalize from [0, 65535] to [minDepth, maxDepth]
            depth_map = (depth_img.astype(np.float32) / 65535.0) * (max_depth - min_depth) + min_depth
        else:
            # 8-bit depth
            depth_map = (depth_img.astype(np.float32) / 255.0) * (max_depth - min_depth) + min_depth
        
        return depth_map
    else:
        # Old format: raw base64 float32 array
        depth_bytes = base64.b64decode(depth_data)
        depth_array = np.frombuffer(depth_bytes, dtype=np.float32)
        return depth_array.reshape(1280, 720)

def depth_to_pointcloud(depth_map, azimuth_deg, elevation_deg, fov_h=60, fov_v=90):
    """
    Convert a depth map to 3D point cloud using sensor orientation
    
    Args:
        depth_map: HxW depth values in meters
        azimuth_deg: Camera azimuth (yaw) in degrees
        elevation_deg: Camera elevation (pitch) in degrees
        fov_h: Horizontal FOV in degrees
        fov_v: Vertical FOV in degrees
    
    Returns:
        points: Nx3 array of (x, y, z) coordinates
        colors: Nx3 array of RGB values (placeholder - gray based on depth)
    """
    # Ensure depth_map is 2D
    if len(depth_map.shape) == 3:
        depth_map = depth_map[:, :, 0]
    
    h, w = depth_map.shape
    
    # Convert to radians
    az_rad = math.radians(azimuth_deg)
    el_rad = math.radians(elevation_deg)
    fov_h_rad = math.radians(fov_h)
    fov_v_rad = math.radians(fov_v)
    
    # Create pixel coordinate grids
    u_coords = np.arange(w)
    v_coords = np.arange(h)
    u_grid, v_grid = np.meshgrid(u_coords, v_coords)
    
    # Normalize to [-1, 1] range (center of image = 0)
    u_norm = (u_grid - w/2) / (w/2)
    v_norm = (v_grid - h/2) / (h/2)
    
    # Convert to angular offsets from camera center
    theta = u_norm * (fov_h_rad / 2)  # Horizontal angle offset
    phi = -v_norm * (fov_v_rad / 2)    # Vertical angle offset (negative because y increases downward)
    
    # Get depth values
    depth = depth_map.flatten()
    theta = theta.flatten()
    phi = phi.flatten()
    
    # Filter out invalid depths
    valid_mask = (depth > 0.1) & (depth < 10.0)  # Keep depths between 10cm and 10m
    depth = depth[valid_mask]
    theta = theta[valid_mask]
    phi = phi[valid_mask]
    
    # Convert spherical to Cartesian in camera frame
    # Camera frame: z = forward, x = right, y = down
    x_cam = depth * np.sin(theta)
    y_cam = depth * np.sin(phi)
    z_cam = depth * np.cos(theta) * np.cos(phi)
    
    # Rotate to world frame using camera orientation
    # Rotation order: pitch (elevation) then yaw (azimuth)
    cos_az, sin_az = np.cos(az_rad), np.sin(az_rad)
    cos_el, sin_el = np.cos(el_rad), np.sin(el_rad)
    
    # Apply pitch rotation (around x-axis)
    x_temp = x_cam
    y_temp = y_cam * cos_el - z_cam * sin_el
    z_temp = y_cam * sin_el + z_cam * cos_el
    
    # Apply yaw rotation (around y-axis)
    x_world = x_temp * cos_az + z_temp * sin_az
    y_world = y_temp
    z_world = -x_temp * sin_az + z_temp * cos_az
    
    # Stack into Nx3 array
    points = np.column_stack([x_world, y_world, z_world])
    
    # Create colors based on depth (grayscale gradient)
    depth_normalized = (depth - depth.min()) / (depth.max() - depth.min() + 1e-6)
    colors = np.column_stack([depth_normalized, depth_normalized, depth_normalized])
    
    return points, colors

def test_depth_maps(input_json_path):
    """Test depth map to point cloud conversion"""
    print(f"[Test] Loading {input_json_path}...")
    
    with open(input_json_path, 'r') as f:
        data = json.load(f)
    
    photos = data.get('photos', [])
    print(f"[Test] Found {len(photos)} photos")
    
    # Collect all points from all depth maps
    all_points = []
    all_colors = []
    
    photos_with_depth = 0
    
    for i, photo in enumerate(photos, 1):
        depth_base64 = photo.get('depthMap') or photo.get('depth')
        if not depth_base64:
            continue
        
        photos_with_depth += 1
        
        # Get sensor data
        azimuth = photo.get('azimuth', 0)
        elevation = photo.get('elevation', 0)
        
        print(f"\n[Test] Photo {i}: az={azimuth:.1f}°, el={elevation:.1f}°")
        
        # Decode depth map
        depth_map = decode_depth_map(depth_base64)
        print(f"  Depth map shape: {depth_map.shape}")
        print(f"  Depth range: {depth_map.min():.2f}m - {depth_map.max():.2f}m")
        print(f"  Valid pixels: {np.sum((depth_map > 0.1) & (depth_map < 10.0))}")
        
        # Convert to point cloud
        points, colors = depth_to_pointcloud(depth_map, azimuth, elevation)
        print(f"  Generated {len(points)} 3D points")
        
        all_points.append(points)
        all_colors.append(colors)
        
        # Show sample points
        if len(points) > 0:
            print(f"  Sample points (first 3):")
            for j in range(min(3, len(points))):
                x, y, z = points[j]
                print(f"    Point {j+1}: x={x:.2f}, y={y:.2f}, z={z:.2f}")
    
    # Combine all point clouds
    if all_points:
        combined_points = np.vstack(all_points)
        combined_colors = np.vstack(all_colors)
        
        print(f"\n[Test] Combined Point Cloud:")
        print(f"  Total points: {len(combined_points)}")
        print(f"  X range: {combined_points[:, 0].min():.2f}m to {combined_points[:, 0].max():.2f}m")
        print(f"  Y range: {combined_points[:, 1].min():.2f}m to {combined_points[:, 1].max():.2f}m")
        print(f"  Z range: {combined_points[:, 2].min():.2f}m to {combined_points[:, 2].max():.2f}m")
        
        # Save as PLY file for visualization
        output_path = Path(input_json_path).parent / "test_pointcloud.ply"
        save_ply(output_path, combined_points, combined_colors)
        print(f"\n[Test] ✅ Saved point cloud to: {output_path}")
        print(f"[Test] You can visualize this with MeshLab, CloudCompare, or online PLY viewers")
        
        return True
    else:
        print("\n[Test] ❌ No depth maps found")
        return False

def save_ply(filepath, points, colors):
    """Save point cloud as PLY file"""
    with open(filepath, 'w') as f:
        # Header
        f.write("ply\n")
        f.write("format ascii 1.0\n")
        f.write(f"element vertex {len(points)}\n")
        f.write("property float x\n")
        f.write("property float y\n")
        f.write("property float z\n")
        f.write("property uchar red\n")
        f.write("property uchar green\n")
        f.write("property uchar blue\n")
        f.write("end_header\n")
        
        # Data
        for i in range(len(points)):
            x, y, z = points[i]
            r, g, b = (colors[i] * 255).astype(np.uint8)
            f.write(f"{x} {y} {z} {r} {g} {b}\n")

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        # Use most recent input file
        temp_dir = Path(__file__).parent.parent / "data" / "temp-stitching"
        input_files = sorted(temp_dir.glob("input_*.json"))
        if not input_files:
            print("❌ No input files found in temp-stitching directory")
            sys.exit(1)
        input_path = input_files[-1]
    
    print(f"[Test] Testing depth map → point cloud conversion")
    print(f"[Test] Input: {input_path}")
    print("=" * 60)
    
    success = test_depth_maps(input_path)
    
    if success:
        print("\n" + "=" * 60)
        print("✅ Depth to point cloud conversion SUCCESSFUL")
        print("The depth data is valid and can generate a 3D point cloud!")
    else:
        print("\n" + "=" * 60)
        print("❌ Test FAILED - check depth data")
