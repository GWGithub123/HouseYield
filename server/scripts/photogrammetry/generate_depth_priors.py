#!/usr/bin/env python3
"""
Depth Prior Generation using Depth Anything v2

Generates depth maps for all images in a scan to be used as priors
for COLMAP's patch match stereo. This significantly improves dense
reconstruction on featureless surfaces (walls, floors, ceilings).

The AI depth serves as a strong prior that prevents PatchMatch from 
wandering into nonsensical values where photometric matching fails
(e.g., white walls, uniform surfaces).

Usage:
    python generate_depth_priors.py <images_dir> <output_dir> [--model-size large]

Output:
    Creates depth maps in COLMAP's PHOTOMETRIC depth format at:
    <output_dir>/stereo/depth_maps/<image_name>.photometric.bin
    <output_dir>/stereo/normal_maps/<image_name>.photometric.bin
    
    IMPORTANT: We output .photometric.bin (not .geometric.bin) so that COLMAP's
    PatchMatchStereo uses our AI depth as the STARTING POINT for its geometric
    consistency refinement pass. If we output .geometric.bin, COLMAP skips
    processing entirely (thinks it's already done).
"""

import os
import sys
import json
import argparse
import struct
from pathlib import Path
from typing import List, Tuple, Optional
import numpy as np

# Attempt imports - will fail gracefully if not installed
try:
    import torch
    import torch.nn.functional as F
    from torchvision import transforms
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

if HAS_TORCH:
    torch_no_grad = torch.no_grad
else:
    def torch_no_grad():
        def decorator(func):
            return func
        return decorator

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# =============================================================================
# DEPTH ANYTHING V2 MODEL
# =============================================================================

class DepthAnythingV2:
    """
    Depth Anything v2 wrapper for depth estimation.
    
    Uses the ViT-L (large) model by default for best quality.
    Falls back to ViT-B (base) if memory is constrained.
    """
    
    MODEL_CONFIGS = {
        'small': {
            'repo': 'depth-anything/Depth-Anything-V2-Small-hf',
            'input_size': 518,
        },
        'base': {
            'repo': 'depth-anything/Depth-Anything-V2-Base-hf', 
            'input_size': 518,
        },
        'large': {
            'repo': 'depth-anything/Depth-Anything-V2-Large-hf',
            'input_size': 518,
        },
    }
    
    def __init__(self, model_size: str = 'large', device: str = None):
        """
        Initialize Depth Anything v2 model.
        
        Args:
            model_size: 'small', 'base', or 'large'
            device: 'cuda' or 'cpu' (auto-detected if None)
        """
        if not HAS_TORCH:
            raise ImportError("PyTorch is required. Install with: pip install torch torchvision")
        
        self.model_size = model_size
        self.config = self.MODEL_CONFIGS.get(model_size, self.MODEL_CONFIGS['large'])
        
        # Auto-detect device
        if device is None:
            self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        else:
            self.device = device
        
        print(f"[DepthAnythingV2] Loading {model_size} model on {self.device}...")
        
        # Load model from HuggingFace Hub
        try:
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation
            
            self.processor = AutoImageProcessor.from_pretrained(self.config['repo'])
            self.model = AutoModelForDepthEstimation.from_pretrained(self.config['repo'])
            self.model.to(self.device)
            self.model.eval()
            
            print(f"[DepthAnythingV2] Model loaded successfully")
            
        except Exception as e:
            print(f"[DepthAnythingV2] Failed to load from HuggingFace: {e}")
            print("[DepthAnythingV2] Trying alternative loading method...")
            self._load_from_checkpoint()
    
    def _load_from_checkpoint(self):
        """Load model from local checkpoint if HuggingFace fails."""
        # Check for local model cache
        cache_dir = Path('/opt/models/depth-anything-v2')
        checkpoint = cache_dir / f'depth_anything_v2_{self.model_size}.pth'
        
        if not checkpoint.exists():
            raise FileNotFoundError(
                f"Model not found at {checkpoint}. "
                "Run VM setup script to download models."
            )
        
        # Load using the original Depth Anything repo structure
        sys.path.insert(0, str(cache_dir / 'Depth-Anything-V2'))
        from depth_anything_v2.dpt import DepthAnythingV2 as DAv2
        
        model_configs = {
            'small': {'encoder': 'vits', 'features': 64, 'out_channels': [48, 96, 192, 384]},
            'base': {'encoder': 'vitb', 'features': 128, 'out_channels': [96, 192, 384, 768]},
            'large': {'encoder': 'vitl', 'features': 256, 'out_channels': [256, 512, 1024, 1024]},
        }
        
        self.model = DAv2(**model_configs[self.model_size])
        self.model.load_state_dict(torch.load(checkpoint, map_location=self.device))
        self.model.to(self.device)
        self.model.eval()
        
        self.processor = None  # Will use manual preprocessing
    
    @torch_no_grad()
    def estimate_depth(self, image: np.ndarray) -> np.ndarray:
        """
        Estimate depth for a single image.
        
        Args:
            image: RGB image as numpy array (H, W, 3), uint8
        
        Returns:
            Depth map as numpy array (H, W), float32, in relative depth units
        """
        original_h, original_w = image.shape[:2]
        
        if self.processor is not None:
            # Use HuggingFace processor
            inputs = self.processor(images=image, return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            
            outputs = self.model(**inputs)
            depth = outputs.predicted_depth
            
        else:
            # Manual preprocessing for checkpoint loading
            input_size = self.config['input_size']
            
            # Resize maintaining aspect ratio
            h, w = image.shape[:2]
            scale = input_size / max(h, w)
            new_h, new_w = int(h * scale), int(w * scale)
            
            # Pad to square
            image_resized = cv2.resize(image, (new_w, new_h))
            image_padded = np.zeros((input_size, input_size, 3), dtype=np.uint8)
            image_padded[:new_h, :new_w] = image_resized
            
            # Normalize
            image_tensor = torch.from_numpy(image_padded).permute(2, 0, 1).float() / 255.0
            image_tensor = image_tensor.unsqueeze(0).to(self.device)
            
            depth = self.model(image_tensor)
            
            # Crop to original aspect ratio
            depth = depth[:, :new_h, :new_w]
        
        # Resize depth to original resolution
        depth = F.interpolate(
            depth.unsqueeze(1),
            size=(original_h, original_w),
            mode='bilinear',
            align_corners=False
        ).squeeze()
        
        # Convert to numpy
        depth_np = depth.cpu().numpy().astype(np.float32)
        
        return depth_np
    
    def estimate_depth_batch(
        self, 
        images: List[np.ndarray], 
        batch_size: int = 4
    ) -> List[np.ndarray]:
        """
        Estimate depth for multiple images in batches.
        
        Args:
            images: List of RGB images
            batch_size: Number of images to process at once
        
        Returns:
            List of depth maps
        """
        depths = []
        
        for i in range(0, len(images), batch_size):
            batch = images[i:i + batch_size]
            for img in batch:
                depth = self.estimate_depth(img)
                depths.append(depth)
            
            print(f"[DepthAnythingV2] Processed {min(i + batch_size, len(images))}/{len(images)} images")
        
        return depths


# =============================================================================
# COLMAP DEPTH MAP FORMAT
# =============================================================================

def save_colmap_depth_map(depth: np.ndarray, output_path: Path):
    """
    Save depth map in COLMAP's photometric depth format (.photometric.bin).
    
    We save as .photometric.bin so COLMAP's PatchMatchStereo uses our AI depth
    as the starting point for its geometric consistency refinement pass.
    
    COLMAP uses a binary format:
    - 4 bytes: width (int32)
    - 4 bytes: height (int32)
    - 4 bytes: depth_min (float32)
    - 4 bytes: depth_max (float32)
    - width * height * 4 bytes: depth values (float32)
    
    Args:
        depth: Depth map as (H, W) float32 array
        output_path: Path to save the .photometric.bin file
    """
    height, width = depth.shape
    depth_min = float(np.min(depth[depth > 0])) if np.any(depth > 0) else 0.0
    depth_max = float(np.max(depth))
    
    with open(output_path, 'wb') as f:
        # Write header
        f.write(struct.pack('<i', width))
        f.write(struct.pack('<i', height))
        f.write(struct.pack('<f', depth_min))
        f.write(struct.pack('<f', depth_max))
        
        # Write depth values (row-major order)
        depth.astype(np.float32).tofile(f)
    
    print(f"[DepthPrior] Saved: {output_path.name} ({width}x{height}, range: {depth_min:.2f}-{depth_max:.2f})")


def compute_normals_from_depth(depth: np.ndarray) -> np.ndarray:
    """
    Compute surface normals from a depth map using central differences.
    
    COLMAP's geometric consistency pass uses normals for multi-view
    consistency checking. Providing AI-derived normals helps PatchMatch
    converge faster and avoid local minima on featureless surfaces.
    
    Args:
        depth: Depth map as (H, W) float32 array
    
    Returns:
        Normal map as (H, W, 3) float32 array (x, y, z components)
    """
    h, w = depth.shape
    
    # Compute gradients using central differences
    # dz/dx and dz/dy
    dz_dx = np.zeros_like(depth)
    dz_dy = np.zeros_like(depth)
    
    # Central differences for interior, forward/backward at edges
    dz_dx[:, 1:-1] = (depth[:, 2:] - depth[:, :-2]) / 2.0
    dz_dx[:, 0] = depth[:, 1] - depth[:, 0]
    dz_dx[:, -1] = depth[:, -1] - depth[:, -2]
    
    dz_dy[1:-1, :] = (depth[2:, :] - depth[:-2, :]) / 2.0
    dz_dy[0, :] = depth[1, :] - depth[0, :]
    dz_dy[-1, :] = depth[-1, :] - depth[-2, :]
    
    # Normal vector: (-dz/dx, -dz/dy, 1), then normalize
    normals = np.zeros((h, w, 3), dtype=np.float32)
    normals[:, :, 0] = -dz_dx
    normals[:, :, 1] = -dz_dy
    normals[:, :, 2] = 1.0
    
    # Normalize to unit length
    norm = np.sqrt(np.sum(normals ** 2, axis=2, keepdims=True))
    norm = np.maximum(norm, 1e-8)  # Avoid division by zero
    normals = normals / norm
    
    return normals


def save_colmap_normal_map(normals: np.ndarray, output_path: Path):
    """
    Save normal map in COLMAP's format (.photometric.bin for normals).
    
    COLMAP normal map format:
    - 4 bytes: width (int32)
    - 4 bytes: height (int32)
    - 4 bytes: channels (int32) = 3
    - width * height * 3 * 4 bytes: normal values (float32, xyz per pixel)
    
    Args:
        normals: Normal map as (H, W, 3) float32 array
        output_path: Path to save the normal map
    """
    height, width = normals.shape[:2]
    
    with open(output_path, 'wb') as f:
        # Write header
        f.write(struct.pack('<i', width))
        f.write(struct.pack('<i', height))
        f.write(struct.pack('<i', 3))  # channels
        
        # Write normal values (row-major order)
        normals.astype(np.float32).tofile(f)
    
    print(f"[DepthPrior] Saved normal map: {output_path.name} ({width}x{height})")


def normalize_depth_for_colmap(
    depth: np.ndarray, 
    depth_scale: float = 1.0,
    near: float = 0.1,
    far: float = 100.0
) -> np.ndarray:
    """
    Normalize relative depth to metric-like depth for COLMAP.
    
    Depth Anything outputs relative depth (higher = farther).
    COLMAP expects geometric depth in consistent units.
    
    Args:
        depth: Raw depth from Depth Anything (relative, higher = farther)
        depth_scale: Scale factor to convert to approximate meters
        near: Near clipping plane
        far: Far clipping plane
    
    Returns:
        Normalized depth map suitable for COLMAP
    """
    # Normalize to 0-1 range
    depth_min = depth.min()
    depth_max = depth.max()
    
    if depth_max - depth_min > 0:
        depth_normalized = (depth - depth_min) / (depth_max - depth_min)
    else:
        depth_normalized = np.zeros_like(depth)
    
    # Scale to approximate metric depth
    # Typical indoor room: 0.5m - 10m
    depth_metric = near + depth_normalized * (far - near) * depth_scale
    
    return depth_metric.astype(np.float32)


# =============================================================================
# MAIN PIPELINE
# =============================================================================

def generate_depth_priors(
    images_dir: Path,
    output_dir: Path,
    model_size: str = 'large',
    depth_scale: float = 1.0,
) -> dict:
    """
    Generate depth priors for all images in a directory.
    
    Outputs .photometric.bin files (NOT .geometric.bin) so that COLMAP's
    PatchMatchStereo uses our AI depth as the starting point for its
    geometric consistency refinement pass.
    
    Args:
        images_dir: Directory containing input images
        output_dir: Directory for COLMAP workspace (will create stereo/depth_maps/)
        model_size: 'small', 'base', or 'large'
        depth_scale: Scale factor for depth (1.0 = default indoor scale)
    
    Returns:
        Dict with statistics and file paths
    """
    images_dir = Path(images_dir)
    output_dir = Path(output_dir)
    
    # Find images
    image_extensions = {'.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'}
    image_files = sorted([
        f for f in images_dir.iterdir() 
        if f.suffix in image_extensions
    ])
    
    if not image_files:
        raise ValueError(f"No images found in {images_dir}")
    
    print(f"[DepthPrior] Found {len(image_files)} images")
    
    # Create output directories for both depth maps and normal maps
    depth_maps_dir = output_dir / 'stereo' / 'depth_maps'
    normal_maps_dir = output_dir / 'stereo' / 'normal_maps'
    depth_maps_dir.mkdir(parents=True, exist_ok=True)
    normal_maps_dir.mkdir(parents=True, exist_ok=True)
    
    # Initialize model
    model = DepthAnythingV2(model_size=model_size)
    
    # Process each image
    results = {
        'num_images': len(image_files),
        'depth_maps': [],
        'normal_maps': [],
        'model_size': model_size,
        'depth_scale': depth_scale,
        'output_format': 'photometric',  # Key: we output photometric, not geometric
    }
    
    for i, image_path in enumerate(image_files):
        print(f"[DepthPrior] Processing {i+1}/{len(image_files)}: {image_path.name}")
        
        # Load image
        if HAS_CV2:
            image = cv2.imread(str(image_path))
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        elif HAS_PIL:
            image = np.array(Image.open(image_path).convert('RGB'))
        else:
            raise ImportError("OpenCV or Pillow required for image loading")
        
        # Estimate depth
        depth_raw = model.estimate_depth(image)
        
        # Normalize for COLMAP
        depth_metric = normalize_depth_for_colmap(
            depth_raw, 
            depth_scale=depth_scale,
            near=0.1,
            far=20.0  # Typical indoor range
        )
        
        # Compute normals from depth
        normals = compute_normals_from_depth(depth_metric)
        
        # Save depth in COLMAP photometric format
        # CRITICAL: Output .photometric.bin so COLMAP uses this as the starting
        # point for geometric consistency refinement, NOT .geometric.bin which
        # would cause COLMAP to skip processing entirely
        depth_output_path = depth_maps_dir / f"{image_path.stem}.photometric.bin"
        save_colmap_depth_map(depth_metric, depth_output_path)
        
        # Save normal map (also as .photometric.bin in normal_maps directory)
        normal_output_path = normal_maps_dir / f"{image_path.stem}.photometric.bin"
        save_colmap_normal_map(normals, normal_output_path)
        
        results['depth_maps'].append({
            'image': image_path.name,
            'depth_file': str(depth_output_path),
            'depth_range': [float(depth_metric.min()), float(depth_metric.max())],
        })
        
        results['normal_maps'].append({
            'image': image_path.name,
            'normal_file': str(normal_output_path),
        })
    
    # Save manifest
    manifest_path = output_dir / 'depth_priors_manifest.json'
    with open(manifest_path, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\n[DepthPrior] ✅ Complete!")
    print(f"[DepthPrior] Generated {len(results['depth_maps'])} depth maps (.photometric.bin)")
    print(f"[DepthPrior] Generated {len(results['normal_maps'])} normal maps (.photometric.bin)")
    print(f"[DepthPrior] Output format: PHOTOMETRIC (COLMAP will use as prior for geometric pass)")
    print(f"[DepthPrior] Manifest saved to: {manifest_path}")
    
    return results


# =============================================================================
# CLI ENTRY POINT
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Generate depth priors using Depth Anything v2'
    )
    parser.add_argument('images_dir', type=str, help='Directory containing input images')
    parser.add_argument('output_dir', type=str, help='Output directory for depth maps')
    parser.add_argument(
        '--model-size', 
        type=str, 
        default='large',
        choices=['small', 'base', 'large'],
        help='Model size (default: large)'
    )
    parser.add_argument(
        '--depth-scale',
        type=float,
        default=1.0,
        help='Scale factor for depth (default: 1.0)'
    )
    
    args = parser.parse_args()
    
    try:
        result = generate_depth_priors(
            images_dir=Path(args.images_dir),
            output_dir=Path(args.output_dir),
            model_size=args.model_size,
            depth_scale=args.depth_scale,
        )
        print(json.dumps(result, indent=2))
        sys.exit(0)
        
    except Exception as e:
        print(f"[DepthPrior] ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
