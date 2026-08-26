#!/usr/bin/env python3
"""
Depth Fusion Module (Pipeline v2)

Fuses MVS depth (PatchMatchStereo) with Metric3D depth using
confidence-weighted blending.

Strategy:
- High MVS confidence → Use MVS (textured areas, geometric accuracy)
- Low MVS confidence → Use Metric3D (textureless areas, no holes)
- Medium confidence → Blend based on confidence ratio

This produces complete depth maps with no holes while preserving
MVS accuracy where photometric matching succeeds.

Key Features:
1. Confidence-weighted fusion
2. Scale alignment between MVS and Metric3D
3. Hole prevention on textureless surfaces
4. Edge-aware blending at boundaries
5. Statistical outlier rejection

Usage:
    python depth_fusion.py <colmap_workspace> <metric3d_dir> <output_dir> [--ar-scale SCALE]

Output:
    <output_dir>/
        <image_name>_depth.npy    # Fused depth in meters
        <image_name>_conf.npy     # Fused confidence
        fusion_stats.json         # Statistics
"""

import os
import sys
import json
import argparse
import struct
import time
from pathlib import Path
from typing import Dict, Tuple, List, Optional, Any
import numpy as np

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    print("[DepthFusion] Warning: OpenCV not available")


# =============================================================================
# COLMAP DEPTH LOADING
# =============================================================================

def load_colmap_depth_bin(depth_path: Path) -> Tuple[np.ndarray, np.ndarray]:
    """
    Load depth map from COLMAP's .geometric.bin or .photometric.bin format.
    
    Format:
    - 4 bytes: width (int32)
    - 4 bytes: height (int32)
    - 4 bytes: channels (int32) - usually 1
    - 4 bytes: depth_min (float32)
    - 4 bytes: depth_max (float32)
    - width * height * channels * 4 bytes: depth values (float32)
    
    Returns:
        depth: Depth values (H, W) - may be in COLMAP's internal units
        metadata: Dict with min/max/dimensions
    """
    file_size = depth_path.stat().st_size

    with open(depth_path, 'rb') as f:
        prefix = f.read(64)
        f.seek(0)

        # COLMAP dense depth maps use an ASCII header: width&height&channels&
        if b'&' in prefix:
            header = bytearray()
            while header.count(b'&') < 3:
                byte = f.read(1)
                if not byte:
                    raise ValueError(f"Incomplete COLMAP depth header in {depth_path}")
                header.extend(byte)

            width_str, height_str, channels_str, _ = header.decode('ascii').split('&', 3)
            width = int(width_str)
            height = int(height_str)
            channels = int(channels_str)
            depth = np.fromfile(f, dtype=np.float32)
        else:
            width = struct.unpack('<i', f.read(4))[0]
            height = struct.unpack('<i', f.read(4))[0]
            channels = 1

            # Older local scripts write width, height, depth_min, depth_max, then payload.
            # Support that legacy format as a fallback.
            expected_legacy_payload_bytes = width * height * 4
            if file_size >= 16 and (file_size - 16) == expected_legacy_payload_bytes:
                f.read(8)
                depth = np.fromfile(f, dtype=np.float32)
            else:
                maybe_channels = struct.unpack('<i', f.read(4))[0]
                channels = maybe_channels if maybe_channels > 0 else 1
                remaining_payload_bytes = file_size - f.tell()
                if channels > 0 and remaining_payload_bytes >= width * height * channels * 4:
                    depth = np.fromfile(f, dtype=np.float32)
                else:
                    raise ValueError(f"Unsupported COLMAP depth binary layout in {depth_path}")

    expected_values = width * height * channels
    if depth.size < expected_values:
        raise ValueError(
            f"Depth payload too short in {depth_path}: expected {expected_values} values, got {depth.size}"
        )
    if depth.size > expected_values:
        depth = depth[:expected_values]

    depth = depth.reshape((height, width, channels) if channels > 1 else (height, width))

    return depth, {'width': width, 'height': height, 'channels': channels}


def load_colmap_depth(depth_path: Path) -> np.ndarray:
    """Load COLMAP depth map, handling different formats."""
    if depth_path.suffix == '.bin':
        depth, _ = load_colmap_depth_bin(depth_path)
    elif depth_path.suffix == '.npy':
        depth = np.load(depth_path)
    else:
        raise ValueError(f"Unknown depth format: {depth_path.suffix}")
    
    return depth.astype(np.float32)


def find_colmap_depth_maps(colmap_workspace: Path) -> Dict[str, Path]:
    """
    Find all depth maps in COLMAP workspace.
    Returns dict mapping image stem to depth map path.
    """
    depth_maps = {}
    
    # Check common locations
    depth_dirs = [
        colmap_workspace / 'dense' / 'stereo' / 'depth_maps',
        colmap_workspace / 'stereo' / 'depth_maps',
        colmap_workspace / 'depth_maps',
    ]
    
    for depth_dir in depth_dirs:
        if depth_dir.exists():
            # Look for .geometric.bin (multi-view consistent)
            for f in depth_dir.glob('*.geometric.bin'):
                stem = f.stem.replace('.geometric', '')
                depth_maps[stem] = f
            
            # Fallback to .photometric.bin
            for f in depth_dir.glob('*.photometric.bin'):
                stem = f.stem.replace('.photometric', '')
                if stem not in depth_maps:
                    depth_maps[stem] = f
            
            if depth_maps:
                print(f"[DepthFusion] Found {len(depth_maps)} MVS depth maps in {depth_dir}")
                break
    
    return depth_maps


# =============================================================================
# MVS CONFIDENCE COMPUTATION
# =============================================================================

def compute_mvs_confidence(
    depth: np.ndarray,
    consistency_path: Optional[Path] = None,
    min_depth: float = 0.1,
    max_depth: float = 20.0
) -> np.ndarray:
    """
    Compute confidence for MVS depth.
    
    Confidence is based on:
    1. Multi-view consistency (if available)
    2. Depth validity (not zero, not extreme)
    3. Depth gradients (high gradients at edges = lower confidence)
    4. Local variance (smooth areas with low variance = possibly textureless)
    
    Args:
        depth: MVS depth map
        consistency_path: Path to COLMAP consistency data (if available)
        min_depth: Minimum valid depth
        max_depth: Maximum valid depth
    
    Returns:
        confidence: Confidence map 0-1
    """
    h, w = depth.shape
    confidence = np.ones((h, w), dtype=np.float32)
    
    # 1. Zero depth = no data = zero confidence
    zero_mask = depth <= 0
    confidence[zero_mask] = 0.0
    
    # 2. Out of range = low confidence
    too_close = (depth > 0) & (depth < min_depth)
    too_far = depth > max_depth
    confidence[too_close] *= 0.3
    confidence[too_far] *= 0.3
    
    # 3. Load multi-view consistency if available
    if consistency_path and consistency_path.exists():
        try:
            consistency, _ = load_colmap_depth_bin(consistency_path)
            # Normalize: 0 views = 0, 4+ views = 1
            view_conf = np.clip(consistency / 4.0, 0, 1)
            confidence *= view_conf
        except Exception as e:
            print(f"[DepthFusion] Could not load consistency: {e}")
    else:
        # Estimate from depth gradients
        # Low gradient in depth can mean either:
        # a) Correctly flat surface (good)
        # b) Textureless area where MVS failed to find details (bad)
        # We use local variance to distinguish
        
        # Compute local variance in 5x5 window
        depth_valid = np.where(zero_mask, np.nan, depth)
        kernel_size = 5
        
        # Pad for convolution
        pad = kernel_size // 2
        depth_padded = np.pad(depth_valid, pad, mode='reflect')
        
        # Compute variance using sliding window
        variance = np.zeros_like(depth)
        for i in range(h):
            for j in range(w):
                window = depth_padded[i:i+kernel_size, j:j+kernel_size]
                valid = ~np.isnan(window)
                if np.sum(valid) > kernel_size:
                    variance[i, j] = np.nanvar(window)
        
        # Very low variance in MVS = likely textureless = lower confidence
        # (Real geometric detail should have some depth variation)
        low_variance = variance < 0.001  # 1mm variance threshold
        confidence[low_variance] *= 0.5
    
    # 4. Gradient-based edge detection
    # Very high gradients = depth discontinuities = lower confidence
    grad_x = np.gradient(np.nan_to_num(depth), axis=1)
    grad_y = np.gradient(np.nan_to_num(depth), axis=0)
    gradient_mag = np.sqrt(grad_x**2 + grad_y**2)
    
    # Penalize very high gradients (depth jumps > 0.5m between pixels)
    high_gradient = gradient_mag > 0.5
    confidence[high_gradient] *= 0.7
    
    return confidence.astype(np.float32)


# =============================================================================
# METRIC3D LOADING
# =============================================================================

def load_metric3d_depth(depth_path: Path) -> np.ndarray:
    """Load Metric3D depth map (already in meters)."""
    depth = np.load(depth_path).astype(np.float32)
    return depth


def load_metric3d_confidence(conf_path: Path) -> np.ndarray:
    """Load Metric3D confidence map."""
    conf = np.load(conf_path).astype(np.float32)
    return conf


# =============================================================================
# SCALE ALIGNMENT
# =============================================================================

def compute_scale_alignment(
    mvs_depth: np.ndarray,
    metric_depth: np.ndarray,
    mvs_conf: np.ndarray,
    min_conf: float = 0.5,
    use_ransac: bool = True
) -> Tuple[float, float]:
    """
    Compute scale and shift to align MVS depth with Metric3D.
    
    MVS_aligned = MVS * scale + shift
    
    Uses high-confidence MVS regions where both are reliable.
    
    Args:
        mvs_depth: MVS depth map
        metric_depth: Metric3D depth map
        mvs_conf: MVS confidence map
        min_conf: Minimum confidence for alignment
        use_ransac: Use RANSAC for robust estimation
    
    Returns:
        scale: Scale factor
        shift: Shift value (usually small)
    """
    # Find high-confidence valid pixels
    valid = (mvs_conf >= min_conf) & (mvs_depth > 0.1) & (metric_depth > 0.1)
    
    n_valid = np.sum(valid)
    if n_valid < 100:
        print(f"[DepthFusion] Warning: Only {n_valid} high-confidence pixels for alignment")
        if n_valid < 10:
            return 1.0, 0.0
    
    mvs_valid = mvs_depth[valid].flatten()
    metric_valid = metric_depth[valid].flatten()
    
    if use_ransac and n_valid > 100:
        # RANSAC for robust estimation
        best_scale = 1.0
        best_shift = 0.0
        best_inliers = 0
        
        n_iterations = 100
        threshold = 0.1  # 10cm inlier threshold
        
        for _ in range(n_iterations):
            # Random sample
            idx = np.random.choice(len(mvs_valid), min(10, len(mvs_valid)), replace=False)
            
            # Fit scale (assume shift is small for indoor scenes)
            ratios = metric_valid[idx] / mvs_valid[idx]
            scale = np.median(ratios)
            shift = 0.0
            
            # Count inliers
            predicted = mvs_valid * scale + shift
            errors = np.abs(predicted - metric_valid)
            inliers = np.sum(errors < threshold)
            
            if inliers > best_inliers:
                best_inliers = inliers
                best_scale = scale
                best_shift = shift
        
        # Refine with all inliers
        predicted = mvs_valid * best_scale + best_shift
        errors = np.abs(predicted - metric_valid)
        inlier_mask = errors < threshold
        
        if np.sum(inlier_mask) > 10:
            final_ratios = metric_valid[inlier_mask] / mvs_valid[inlier_mask]
            best_scale = np.median(final_ratios)
        
        return float(best_scale), float(best_shift)
    else:
        # Simple median ratio
        ratios = metric_valid / mvs_valid
        scale = float(np.median(ratios))
        shift = 0.0
        
        return scale, shift


# =============================================================================
# DEPTH FUSION
# =============================================================================

def fuse_depths(
    mvs_depth: np.ndarray,
    mvs_conf: np.ndarray,
    metric_depth: np.ndarray,
    metric_conf: np.ndarray,
    mvs_scale: float = 1.0,
    mvs_shift: float = 0.0,
    high_conf_threshold: float = 0.7,
    low_conf_threshold: float = 0.2,
    edge_aware: bool = True
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Fuse MVS and Metric3D depth maps using confidence-weighted blending.
    
    Strategy:
    - MVS conf > high_threshold: Use MVS (trust geometric matching)
    - MVS conf < low_threshold: Use Metric3D (MVS failed)
    - In between: Weighted blend
    
    Args:
        mvs_depth: MVS depth (may need scaling)
        mvs_conf: MVS confidence 0-1
        metric_depth: Metric3D depth in meters
        metric_conf: Metric3D confidence 0-1
        mvs_scale: Scale factor to convert MVS to meters
        mvs_shift: Shift for alignment
        high_conf_threshold: Above this, trust MVS fully
        low_conf_threshold: Below this, trust Metric3D fully
        edge_aware: Use edge-aware blending at boundaries
    
    Returns:
        fused_depth: Combined depth map in meters
        fused_conf: Combined confidence map
    """
    h, w = mvs_depth.shape
    
    # Scale MVS depth to meters
    mvs_depth_scaled = mvs_depth * mvs_scale + mvs_shift
    
    # Initialize output
    fused_depth = np.zeros((h, w), dtype=np.float32)
    fused_conf = np.zeros((h, w), dtype=np.float32)
    
    # Region masks
    high_mvs = mvs_conf >= high_conf_threshold
    low_mvs = mvs_conf <= low_conf_threshold
    blend_region = ~high_mvs & ~low_mvs
    
    # 1. High MVS confidence: use MVS directly
    fused_depth[high_mvs] = mvs_depth_scaled[high_mvs]
    fused_conf[high_mvs] = mvs_conf[high_mvs]
    
    # 2. Low MVS confidence: use Metric3D
    fused_depth[low_mvs] = metric_depth[low_mvs]
    fused_conf[low_mvs] = metric_conf[low_mvs]
    
    # 3. Blend region: weighted combination
    if np.any(blend_region):
        # Avoid division by zero
        total_conf = mvs_conf[blend_region] + metric_conf[blend_region] + 1e-6
        mvs_weight = mvs_conf[blend_region] / total_conf
        metric_weight = metric_conf[blend_region] / total_conf
        
        fused_depth[blend_region] = (
            mvs_weight * mvs_depth_scaled[blend_region] +
            metric_weight * metric_depth[blend_region]
        )
        fused_conf[blend_region] = np.maximum(
            mvs_conf[blend_region], 
            metric_conf[blend_region]
        )
    
    # 4. Handle remaining zeros (fallback to Metric3D)
    no_data = (fused_depth <= 0) | np.isnan(fused_depth)
    fused_depth[no_data] = metric_depth[no_data]
    fused_conf[no_data] = metric_conf[no_data] * 0.5  # Lower confidence for fallback
    
    # 5. Edge-aware smoothing at blend boundaries
    if edge_aware and HAS_CV2:
        # Find blend boundary
        blend_boundary = cv2.dilate(
            blend_region.astype(np.uint8), 
            np.ones((5, 5), np.uint8)
        ) - blend_region.astype(np.uint8)
        
        # Apply guided filter for smooth transitions
        # (simplified: just median filter the boundary)
        if np.any(blend_boundary):
            boundary_mask = blend_boundary > 0
            # Smooth depth at boundaries
            fused_depth_smooth = cv2.medianBlur(
                fused_depth.astype(np.float32), 5
            )
            fused_depth[boundary_mask] = fused_depth_smooth[boundary_mask]
    
    # 6. Final validity check
    fused_depth = np.clip(fused_depth, 0.1, 20.0)
    fused_conf = np.clip(fused_conf, 0.0, 1.0)
    
    return fused_depth, fused_conf


# =============================================================================
# MAIN PROCESSING
# =============================================================================

def process_fusion(
    colmap_workspace: Path,
    metric3d_dir: Path,
    output_dir: Path,
    ar_scale: float = None,
    high_conf: float = 0.7,
    low_conf: float = 0.2
) -> Dict[str, Any]:
    """
    Fuse all depth maps in a scan.
    
    Args:
        colmap_workspace: COLMAP workspace with dense/stereo/depth_maps
        metric3d_dir: Directory with Metric3D outputs
        output_dir: Output directory for fused depths
        ar_scale: Scale from AR tracking (if available)
        high_conf: High confidence threshold
        low_conf: Low confidence threshold
    
    Returns:
        Statistics dict
    """
    colmap_workspace = Path(colmap_workspace)
    metric3d_dir = Path(metric3d_dir)
    output_dir = Path(output_dir)
    
    fused_dir = output_dir
    fused_dir.mkdir(parents=True, exist_ok=True)
    
    # Find MVS depth maps
    mvs_depth_maps = find_colmap_depth_maps(colmap_workspace)
    
    if not mvs_depth_maps:
        print("[DepthFusion] Error: No MVS depth maps found")
        return {}
    
    print(f"[DepthFusion] Found {len(mvs_depth_maps)} MVS depth maps")
    
    # Statistics
    stats = {
        'num_images': len(mvs_depth_maps),
        'ar_scale_provided': ar_scale is not None,
        'scale_used': ar_scale,
        'mvs_dominant_pixels': 0,
        'metric_dominant_pixels': 0,
        'blend_pixels': 0,
        'total_pixels': 0,
        'images': {}
    }
    
    # Compute global scale from first few images if AR not available
    if ar_scale is None:
        print("[DepthFusion] Computing scale alignment from depth maps...")
        scales = []
        
        for stem in list(mvs_depth_maps.keys())[:10]:
            mvs_path = mvs_depth_maps[stem]
            metric_path = metric3d_dir / f'{stem}_depth.npy'
            
            if not metric_path.exists():
                continue
            
            mvs_depth = load_colmap_depth(mvs_path)
            metric_depth = load_metric3d_depth(metric_path)
            
            # Resize if needed
            if mvs_depth.shape != metric_depth.shape:
                metric_depth = cv2.resize(
                    metric_depth, 
                    (mvs_depth.shape[1], mvs_depth.shape[0]),
                    interpolation=cv2.INTER_LINEAR
                )
            
            mvs_conf = compute_mvs_confidence(mvs_depth)
            scale, shift = compute_scale_alignment(mvs_depth, metric_depth, mvs_conf)
            
            if 0.1 < scale < 10.0:  # Sanity check
                scales.append(scale)
        
        if scales:
            ar_scale = float(np.median(scales))
            print(f"[DepthFusion] Computed scale: {ar_scale:.4f}")
        else:
            ar_scale = 1.0
            print("[DepthFusion] Warning: Could not compute scale, using 1.0")
        
        stats['scale_used'] = ar_scale
    
    # Process each image
    start_time = time.time()
    
    for i, (stem, mvs_path) in enumerate(mvs_depth_maps.items()):
        # Load MVS depth
        mvs_depth = load_colmap_depth(mvs_path)
        h, w = mvs_depth.shape
        
        # Try to load consistency
        consistency_path = mvs_path.parent / f'{stem}.consistency.bin'
        mvs_conf = compute_mvs_confidence(mvs_depth, consistency_path)
        
        # Load Metric3D
        metric_depth_path = metric3d_dir / f'{stem}_depth.npy'
        metric_conf_path = metric3d_dir / f'{stem}_conf.npy'
        
        if not metric_depth_path.exists():
            print(f"[DepthFusion] Warning: No Metric3D for {stem}, using MVS only")
            fused_depth = mvs_depth * ar_scale
            fused_conf = mvs_conf
        else:
            metric_depth = load_metric3d_depth(metric_depth_path)
            
            if metric_conf_path.exists():
                metric_conf = load_metric3d_confidence(metric_conf_path)
            else:
                metric_conf = np.ones_like(metric_depth) * 0.7
            
            # Resize Metric3D to match MVS if needed
            if mvs_depth.shape != metric_depth.shape:
                metric_depth = cv2.resize(
                    metric_depth, 
                    (w, h),
                    interpolation=cv2.INTER_LINEAR
                )
                metric_conf = cv2.resize(
                    metric_conf,
                    (w, h),
                    interpolation=cv2.INTER_LINEAR
                )
            
            # Fuse
            fused_depth, fused_conf = fuse_depths(
                mvs_depth, mvs_conf,
                metric_depth, metric_conf,
                mvs_scale=ar_scale,
                high_conf_threshold=high_conf,
                low_conf_threshold=low_conf
            )
            
            # Track statistics
            high_mvs = mvs_conf > high_conf
            low_mvs = mvs_conf < low_conf
            stats['mvs_dominant_pixels'] += int(np.sum(high_mvs))
            stats['metric_dominant_pixels'] += int(np.sum(low_mvs))
            stats['blend_pixels'] += int(np.sum(~high_mvs & ~low_mvs))
            stats['total_pixels'] += h * w
        
        # Save fused depth
        np.save(fused_dir / f'{stem}_depth.npy', fused_depth)
        np.save(fused_dir / f'{stem}_conf.npy', fused_conf)
        
        # Store image stats
        stats['images'][stem] = {
            'depth_range': [float(np.min(fused_depth)), float(np.max(fused_depth))],
            'depth_mean': float(np.mean(fused_depth)),
            'mean_conf': float(np.mean(fused_conf)),
            'mvs_coverage': float(np.mean(mvs_conf > 0.5)),
        }
        
        if (i + 1) % 20 == 0 or (i + 1) == len(mvs_depth_maps):
            print(f"[DepthFusion] Processed {i + 1}/{len(mvs_depth_maps)}")
    
    stats['processing_time'] = time.time() - start_time
    
    # Calculate percentages
    if stats['total_pixels'] > 0:
        stats['mvs_percent'] = stats['mvs_dominant_pixels'] / stats['total_pixels'] * 100
        stats['metric_percent'] = stats['metric_dominant_pixels'] / stats['total_pixels'] * 100
        stats['blend_percent'] = stats['blend_pixels'] / stats['total_pixels'] * 100
    
    # Save stats
    with open(fused_dir / 'fusion_stats.json', 'w') as f:
        json.dump(stats, f, indent=2)
    
    print(f"[DepthFusion] ✅ Complete in {stats['processing_time']:.1f}s")
    print(f"[DepthFusion]   MVS dominant:     {stats.get('mvs_percent', 0):.1f}%")
    print(f"[DepthFusion]   Metric3D dominant: {stats.get('metric_percent', 0):.1f}%")
    print(f"[DepthFusion]   Blended:          {stats.get('blend_percent', 0):.1f}%")
    
    return stats


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Fuse MVS and Metric3D depth maps (Pipeline v2)'
    )
    parser.add_argument('colmap_workspace', type=Path, 
                        help='COLMAP workspace with depth maps')
    parser.add_argument('metric3d_dir', type=Path, 
                        help='Metric3D output directory')
    parser.add_argument('output_dir', type=Path, 
                        help='Output directory')
    parser.add_argument('--ar-scale', type=float, default=None, 
                        help='Scale from AR tracking (meters)')
    parser.add_argument('--high-conf', type=float, default=0.7,
                        help='High confidence threshold (default: 0.7)')
    parser.add_argument('--low-conf', type=float, default=0.2,
                        help='Low confidence threshold (default: 0.2)')
    
    args = parser.parse_args()
    
    process_fusion(
        args.colmap_workspace,
        args.metric3d_dir,
        args.output_dir,
        args.ar_scale,
        args.high_conf,
        args.low_conf
    )


if __name__ == '__main__':
    main()
