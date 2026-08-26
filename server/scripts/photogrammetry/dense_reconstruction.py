#!/usr/bin/env python3
"""
Dense Reconstruction Module (2026 Optimized)

Creates a dense point cloud from sparse SfM results.
Supports multiple approaches:
1. COLMAP MVS: Traditional multi-view stereo (accurate but slow)
2. Depth AI: Neural network depth estimation (fast, works on single images)
3. Hybrid: Combine sparse SfM with AI depth for best of both worlds

2026 Optimizations:
- Multi-GPU: Uses all available GPUs for CUDA operations
- Max cache: Uses 80% of available RAM to avoid disk swapping
- OPENCV camera model maintained for accuracy
- Depth Priors: Fast3R-assisted priors initialize PatchMatch on low-texture
    walls and ceilings, with Depth Anything v2 available as a fallback

The hybrid approach uses:
- SfM-derived camera poses (accurate extrinsics)
- AI depth maps (dense depth per pixel)
- Depth fusion across multiple views

Depth Prior Integration:
- Before PatchMatchStereo, we generate .photometric.bin depth priors
- Fast3R priors are aligned to the solved SfM world frame and projected back
    into each undistorted view so COLMAP still validates the final geometry
- Depth Anything v2 remains available when Fast3R cannot run locally
"""

import os
import subprocess
import json
import numpy as np
import cv2
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import tempfile
import requests

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False
    print("[DenseReconstruction] Warning: Open3D not available, some features disabled")

# Import depth prior generation
HAS_DEPTH_PRIORS = False
try:
    # Only import if dependencies are available (won't work on macOS without PyTorch)
    import torch
    from photogrammetry.generate_depth_priors import generate_depth_priors
    HAS_DEPTH_PRIORS = True
except ImportError:
    # This is expected on macOS - depth priors will run on GCP VM instead
    HAS_DEPTH_PRIORS = False

HAS_FAST3R_DEPTH_PRIORS = False
try:
    from photogrammetry.generate_fast3r_depth_priors import generate_fast3r_depth_priors
    HAS_FAST3R_DEPTH_PRIORS = True
except ImportError:
    HAS_FAST3R_DEPTH_PRIORS = False

HAS_METRIC3D_DEPTH_PRIORS = False
try:
    from photogrammetry.generate_metric3d_depth_priors import generate_metric3d_depth_priors
    HAS_METRIC3D_DEPTH_PRIORS = True
except ImportError:
    HAS_METRIC3D_DEPTH_PRIORS = False

# Import GCP GPU Worker client
try:
    from photogrammetry.gcp_worker_client import GcpWorkerClient
    HAS_GCP_WORKER = True
except ImportError:
    HAS_GCP_WORKER = False
    print("[DenseReconstruction] Warning: GCP Worker client not available")


def get_gpu_indices() -> str:
    """Detect all available NVIDIA GPUs and return comma-separated indices."""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=index', '--format=csv,noheader'],
            capture_output=True, text=True, check=True, timeout=10
        )
        indices = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
        return ','.join(indices) if indices else '0'
    except Exception:
        return '0'


def get_max_cache_size_mb() -> int:
    """Get maximum cache size based on available system RAM (use 80% of available)."""
    if HAS_PSUTIL:
        try:
            available_mb = psutil.virtual_memory().available // (1024 * 1024)
            return max(int(available_mb * 0.8), 2048)  # Minimum 2GB
        except Exception:
            pass
    return 8192  # Default 8GB


@dataclass
class DenseResult:
    """Result from dense reconstruction"""
    num_points: int
    points_path: Path
    method: str
    
    def to_dict(self) -> Dict:
        return {
            'num_points': self.num_points,
            'points_path': str(self.points_path),
            'method': self.method,
        }


class DenseReconstructor:
    """Dense point cloud reconstruction"""
    
    # Replicate API models
    DEPTH_MODELS = {
        'depth_anything_v2': 'cjwbw/depth-anything:d582c7a0e5389ae5831ef2adb2f5f98e33a9cc24d4e22ef9a7e7a2daad5c1e3f',
        'zoedepth': 'cjwbw/zoedepth:4c41ac1c8267e5e52c2f1ea0abadd62d0ba7f3bb32f6a3e4affd9b40cfe72d1c',
    }
    
    def __init__(
        self,
        method: str = "colmap",
        depth_model: str = "depth_anything_v2",
        depth_prior_source: str = "auto",
        replicate_api_key: str = None,
        colmap_path: str = None,
    ):
        """
        Args:
            method: 'colmap', 'depth_ai', or 'hybrid'
            depth_model: Neural depth model to use
            depth_prior_source: 'auto', 'fast3r', 'metric3d', 'depth_anything_v2', or 'none'
            replicate_api_key: API key for Replicate (for AI depth)
            colmap_path: Path to COLMAP binary (for MVS)
        """
        self.method = method
        self.depth_model = depth_model
        self.depth_prior_source = depth_prior_source
        self.replicate_api_key = replicate_api_key or os.environ.get('REPLICATE_API_KEY')
        self.colmap_path = colmap_path
        
        print(
            f"[DenseReconstruction] Initialized with method={method}, model={depth_model}, "
            f"depth_prior_source={depth_prior_source}"
        )

    def _generate_colmap_depth_priors(
        self,
        images_dir: Path,
        dense_dir: Path,
        sparse_model_dir: Path,
        gpu_indices: str,
    ) -> Dict[str, Any] | None:
        requested_source = (self.depth_prior_source or 'auto').strip().lower()
        if requested_source == 'none':
            print("[DenseReconstruction] Depth priors disabled (--depth-prior-source none)")
            return None

        if requested_source == 'auto':
            providers = ['fast3r', 'metric3d', 'depth_anything_v2']
        elif requested_source in {'fast3r', 'metric3d', 'depth_anything_v2'}:
            providers = [requested_source]
        else:
            raise ValueError(f"Unknown depth prior source: {self.depth_prior_source}")

        failures = []
        for provider in providers:
            if provider == 'fast3r':
                if not HAS_FAST3R_DEPTH_PRIORS:
                    failures.append('Fast3R prior generator import unavailable')
                    continue

                print("[DenseReconstruction] Generating Fast3R-aligned depth priors for COLMAP...")
                print("[DenseReconstruction] Fast3R stays a prior; PatchMatch still validates final geometry")
                try:
                    return generate_fast3r_depth_priors(
                        images_dir=images_dir,
                        output_dir=dense_dir,
                        sparse_model_dir=sparse_model_dir,
                        colmap_path=self.colmap_path,
                        gpu_indices=gpu_indices,
                    )
                except Exception as e:
                    failures.append(f'Fast3R priors failed: {e}')
                    continue

            if provider == 'depth_anything_v2':
                if not HAS_DEPTH_PRIORS:
                    failures.append('Depth Anything v2 priors unavailable (install torch transformers)')
                    continue

                print("[DenseReconstruction] Generating Depth Anything v2 depth priors...")
                print("[DenseReconstruction] This helps fill in featureless areas when Fast3R is unavailable")
                try:
                    return generate_depth_priors(
                        images_dir=images_dir,
                        output_dir=dense_dir,
                        model_size='large',
                        depth_scale=1.0,
                    )
                except Exception as e:
                    failures.append(f'Depth Anything priors failed: {e}')
                    continue

            if provider == 'metric3d':
                if not HAS_METRIC3D_DEPTH_PRIORS:
                    failures.append('Metric3D prior generator import unavailable')
                    continue

                print("[DenseReconstruction] Generating Metric3D-calibrated depth priors for COLMAP...")
                print("[DenseReconstruction] Metric3D is used as a secondary fallback after Fast3R")
                try:
                    return generate_metric3d_depth_priors(
                        images_dir=images_dir,
                        output_dir=dense_dir,
                        sparse_model_dir=sparse_model_dir,
                        colmap_path=self.colmap_path,
                        gpu_indices=gpu_indices,
                    )
                except Exception as e:
                    failures.append(f'Metric3D priors failed: {e}')
                    continue

        for failure in failures:
            print(f"[DenseReconstruction] ⚠️  {failure}")
        print("[DenseReconstruction] Continuing without depth priors")
        return None
    
    def run(
        self,
        images_dir: Path,
        sfm_result: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Run dense reconstruction.
        
        Args:
            images_dir: Directory containing images
            sfm_result: Output from SfM (cameras, sparse points)
            output_dir: Directory for output files
        
        Returns:
            Dict with num_points, points_path
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        if self.method == "colmap":
            return self._run_colmap_mvs(images_dir, sfm_result, output_dir)
        elif self.method == "depth_ai":
            return self._run_depth_ai(images_dir, sfm_result, output_dir)
        elif self.method == "hybrid":
            return self._run_hybrid(images_dir, sfm_result, output_dir)
        else:
            raise ValueError(f"Unknown method: {self.method}")
    
    def _run_colmap_mvs(
        self,
        images_dir: Path,
        sfm_result: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Run COLMAP Multi-View Stereo (with GCP GPU support)"""
        
        if not self.colmap_path:
            raise ValueError("COLMAP not available for MVS")
        
        sparse_dir = sfm_result.get('colmap_dir')
        if not sparse_dir:
            raise ValueError("Need COLMAP sparse reconstruction for MVS")
        
        # Check if GCP GPU Worker is available
        gcp_client = None
        if HAS_GCP_WORKER:
            try:
                gcp_client = GcpWorkerClient()
                if gcp_client.is_available():
                    print("[DenseReconstruction] GCP GPU Worker is available - will use for CUDA processing")
                else:
                    gcp_client = None
            except Exception as e:
                print(f"[DenseReconstruction] Warning: Could not initialize GCP worker: {e}")
                gcp_client = None
        
        # If GCP is available, prepare data and send to GPU
        if gcp_client:
            return self._run_colmap_mvs_on_gcp(
                gcp_client, images_dir, sparse_dir, output_dir
            )
        
        # Otherwise, try local COLMAP (will fail if no CUDA)
        print("[DenseReconstruction] Running COLMAP MVS locally (requires CUDA)")
        return self._run_colmap_mvs_local(images_dir, sparse_dir, output_dir)
    
    def _run_colmap_mvs_on_gcp(
        self,
        gcp_client,
        images_dir: Path,
        sparse_dir: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Run COLMAP MVS on GCP GPU VM"""
        
        print("[DenseReconstruction] Preparing data for GCP GPU processing...")
        
        # Create temporary directory with sparse reconstruction + images
        import tempfile
        import shutil
        
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            
            # Copy sparse reconstruction
            sparse_dest = temp_path / "sparse" / "0"
            sparse_dest.mkdir(parents=True)
            shutil.copytree(sparse_dir / '0', sparse_dest, dirs_exist_ok=True)
            
            # Copy images
            images_dest = temp_path / "images"
            images_dest.mkdir()
            
            # Copy all images
            for img in images_dir.glob('*'):
                if img.suffix.lower() in ['.jpg', '.jpeg', '.png']:
                    shutil.copy2(img, images_dest / img.name)
            
            print(f"[DenseReconstruction] Data prepared in {temp_path}")
            
            # Call GCP worker
            result = gcp_client.process_dense_reconstruction(
                temp_path,
                output_dir,
            )
            
            return result
    
    def _run_colmap_mvs_local(
        self,
        images_dir: Path,
        sparse_dir: Path,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """Run COLMAP MVS locally (2026 optimized - multi-GPU + max cache)"""
        
        dense_dir = output_dir / "dense"
        dense_dir.mkdir(exist_ok=True)
        
        # Detect hardware
        gpu_indices = get_gpu_indices()
        cache_size_mb = get_max_cache_size_mb()
        print(f"[DenseReconstruction] Using GPU(s): {gpu_indices}, Cache: {cache_size_mb}MB")
        
        # Step 1: Undistort images
        print("[DenseReconstruction] Undistorting images...")
        subprocess.run([
            self.colmap_path, 'image_undistorter',
            '--image_path', str(images_dir),
            '--input_path', str(sparse_dir / '0'),
            '--output_path', str(dense_dir),
            '--output_type', 'COLMAP',
        ], check=True)
        
        # Step 1.5: Generate depth priors as PatchMatch initialization.
        # Fast3R priors are preferred because they are aligned to the solved SfM
        # frame, while Depth Anything remains the fallback when Fast3R is not
        # available in the local environment.
        undistorted_images_dir = dense_dir / 'images'
        undistorted_sparse_model_dir = dense_dir / 'sparse'
        depth_prior_result = self._generate_colmap_depth_priors(
            images_dir=undistorted_images_dir,
            dense_dir=dense_dir,
            sparse_model_dir=undistorted_sparse_model_dir,
            gpu_indices=gpu_indices,
        )
        if depth_prior_result:
            generated_count = int(
                depth_prior_result.get('generatedImageCount', depth_prior_result.get('num_images', 0))
            )
            source_name = depth_prior_result.get('source', 'unknown')
            print(
                f"[DenseReconstruction] ✅ Generated {generated_count} {source_name} depth priors (.photometric.bin)"
            )
            print("[DenseReconstruction] COLMAP will use these as starting point for geometric refinement")
        
        # Step 2: Patch match stereo (multi-GPU with max cache)
        # With depth priors present, COLMAP will:
        # - Read .photometric.bin files as initialization
        # - Refine with multi-view geometric consistency
        # - Output .geometric.bin files
        print(f"[DenseReconstruction] Running patch match stereo (GPU: {gpu_indices})...")
        print("[DenseReconstruction] Note: This requires CUDA GPU. Consider enabling GCP GPU worker if on macOS.")
        try:
            subprocess.run([
                self.colmap_path, 'patch_match_stereo',
                '--workspace_path', str(dense_dir),
                '--workspace_format', 'COLMAP',
                '--PatchMatchStereo.geom_consistency', 'true',
                '--PatchMatchStereo.gpu_index', gpu_indices,
                '--PatchMatchStereo.cache_size', str(cache_size_mb),
            ], check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            stderr_text = self._decode_process_output(e.stderr)
            if 'CUDA' in stderr_text or 'cuda' in stderr_text:
                print("[DenseReconstruction] ⚠️  CUDA not available. Options:")
                print("  1. Enable GCP GPU Worker (set GCP_GPU_WORKER_ENABLE=true)")
                print("  2. Use --dense-method hybrid or depth_ai")
                print("  3. Falling back to sparse points for mesh generation")
                
                # Return sparse points instead
                sparse_ply = sparse_dir / '0' / 'points3D.ply'
                if not sparse_ply.exists():
                    # Export sparse points to PLY
                    subprocess.run([
                        self.colmap_path, 'model_converter',
                        '--input_path', str(sparse_dir / '0'),
                        '--output_path', str(sparse_ply),
                        '--output_type', 'PLY',
                    ], check=True)
                
                # Count points (estimate if not in result)
                num_points = self._count_ply_points(sparse_ply) if sparse_ply.exists() else 0
                return {
                    'num_points': num_points,
                    'points_path': str(sparse_ply),
                    'method': 'sparse_only',
                    'workspace_path': dense_dir,
                }
            else:
                # Some other error, re-raise
                raise
        
        # Step 3: Stereo fusion (with max cache to avoid disk swapping)
        print(f"[DenseReconstruction] Fusing depth maps (cache: {cache_size_mb}MB)...")
        fused_path = output_dir / "fused.ply"
        subprocess.run([
            self.colmap_path, 'stereo_fusion',
            '--workspace_path', str(dense_dir),
            '--workspace_format', 'COLMAP',
            '--input_type', 'geometric',
            '--output_path', str(fused_path),
            '--StereoFusion.cache_size', str(cache_size_mb),
        ], check=True)
        
        # Count points
        num_points = self._count_ply_points(fused_path)
        
        return {
            'num_points': num_points,
            'points_path': fused_path,
            'method': 'colmap_mvs',
            'workspace_path': dense_dir,
        }
    
    def _run_depth_ai(
        self,
        images_dir: Path,
        sfm_result: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Use AI depth estimation for each image.
        Fast but may have scale inconsistencies.
        """
        
        cameras = sfm_result.get('cameras', {})
        scale = sfm_result.get('scale', 1.0)
        
        all_points = []
        all_colors = []
        
        # Process each registered image
        for image_id, camera in cameras.items():
            image_path = Path(camera.image_path if hasattr(camera, 'image_path') 
                             else camera.get('image_path', ''))
            
            if not image_path.exists():
                # Try to find in images_dir
                for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.PNG']:
                    candidate = images_dir / f"{image_id}{ext}"
                    if candidate.exists():
                        image_path = candidate
                        break
            
            if not image_path.exists():
                print(f"[DenseReconstruction] Warning: Image not found: {image_id}")
                continue
            
            # Get depth map
            try:
                depth = self._estimate_depth(str(image_path))
            except Exception as e:
                print(f"[DenseReconstruction] Warning: Depth estimation failed for {image_id}: {e}")
                continue
            
            # Unproject to 3D
            points, colors = self._unproject_depth(
                depth,
                camera,
                image_path,
                scale,
            )
            
            all_points.append(points)
            all_colors.append(colors)
            
            print(f"[DenseReconstruction] Processed {image_id}: {len(points)} points")
        
        if not all_points:
            raise ValueError("No depth maps generated")
        
        # Merge all points
        merged_points = np.vstack(all_points)
        merged_colors = np.vstack(all_colors)
        
        # Save to PLY
        output_path = output_dir / "dense.ply"
        self._save_ply(merged_points, merged_colors, output_path)
        
        return {
            'num_points': len(merged_points),
            'points_path': output_path,
            'method': 'depth_ai',
        }
    
    def _run_hybrid(
        self,
        images_dir: Path,
        sfm_result: Dict,
        output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Hybrid approach:
        1. Use SfM for accurate camera poses
        2. Use AI for dense depth
        3. Apply TSDF fusion for consistency
        
        Falls back to pure COLMAP MVS if AI depth fails
        """
        
        # First, try to get AI depth for all images
        try:
            depth_result = self._run_depth_ai(images_dir, sfm_result, output_dir)
        except (ValueError, RuntimeError) as e:
            print(f"[DenseReconstruction] AI depth failed: {e}")
            print("[DenseReconstruction] Falling back to COLMAP MVS...")
            return self._run_colmap_mvs(images_dir, sfm_result, output_dir)
        
        if not HAS_OPEN3D:
            # Can't do TSDF fusion, return as-is
            return depth_result
        
        # Apply TSDF fusion for consistency
        print("[DenseReconstruction] Applying TSDF fusion for consistency...")
        
        cameras = sfm_result.get('cameras', {})
        scale = sfm_result.get('scale', 1.0)
        
        # Create TSDF volume
        voxel_length = 0.01  # 1cm voxels
        sdf_trunc = 0.04  # 4cm truncation
        
        volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=voxel_length,
            sdf_trunc=sdf_trunc,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )
        
        # Integrate each depth map
        for image_id, camera in cameras.items():
            image_path = self._find_image(images_dir, image_id)
            if not image_path:
                continue
            
            try:
                depth = self._estimate_depth(str(image_path))
                color = cv2.imread(str(image_path))
                color = cv2.cvtColor(color, cv2.COLOR_BGR2RGB)
            except Exception:
                continue
            
            # Create Open3D RGBD image
            color_o3d = o3d.geometry.Image(color.astype(np.uint8))
            depth_o3d = o3d.geometry.Image((depth * 1000).astype(np.uint16))  # mm
            
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                color_o3d, depth_o3d,
                depth_scale=1000.0,
                depth_trunc=5.0,
                convert_rgb_to_intensity=False,
            )
            
            # Get camera parameters
            if hasattr(camera, 'fx'):
                fx, fy = camera.fx, camera.fy
                cx, cy = camera.cx, camera.cy
                w, h = camera.width, camera.height
            else:
                fx = camera.get('fx', depth.shape[1] * 1.2)
                fy = camera.get('fy', fx)
                cx = camera.get('cx', depth.shape[1] / 2)
                cy = camera.get('cy', depth.shape[0] / 2)
                w = camera.get('width', depth.shape[1])
                h = camera.get('height', depth.shape[0])
            
            intrinsic = o3d.camera.PinholeCameraIntrinsic(
                width=w, height=h,
                fx=fx, fy=fy, cx=cx, cy=cy,
            )
            
            # Get extrinsic matrix
            if hasattr(camera, 'extrinsic_matrix'):
                extrinsic = camera.extrinsic_matrix
            else:
                extrinsic = np.eye(4)
            
            # Integrate
            volume.integrate(rgbd, intrinsic, extrinsic)
        
        # Extract point cloud
        pcd = volume.extract_point_cloud()
        
        # Save
        output_path = output_dir / "dense_fused.ply"
        o3d.io.write_point_cloud(str(output_path), pcd)
        
        return {
            'num_points': len(pcd.points),
            'points_path': output_path,
            'method': 'hybrid_tsdf',
        }

    @staticmethod
    def _decode_process_output(output: Any) -> str:
            if output is None:
                return ""
            if isinstance(output, bytes):
                return output.decode('utf-8', errors='replace')
            return str(output)
    
    def _estimate_depth(self, image_path: str) -> np.ndarray:
        """Estimate depth using neural network"""
        
        if not self.replicate_api_key:
            # Fallback to placeholder depth
            return self._fallback_depth(image_path)
        
        import replicate
        
        model = self.DEPTH_MODELS.get(self.depth_model)
        if not model:
            raise ValueError(f"Unknown depth model: {self.depth_model}")
        
        # Run prediction
        output = replicate.run(
            model,
            input={"image": open(image_path, 'rb')}
        )
        
        # Download depth map
        if isinstance(output, str):
            response = requests.get(output)
            depth_img = cv2.imdecode(
                np.frombuffer(response.content, np.uint8),
                cv2.IMREAD_UNCHANGED
            )
        else:
            depth_img = np.array(output)
        
        # Normalize depth (assume 16-bit or 8-bit output)
        if depth_img.dtype == np.uint16:
            depth = depth_img.astype(np.float32) / 65535.0 * 10.0  # 0-10m range
        else:
            depth = depth_img.astype(np.float32) / 255.0 * 10.0
        
        return depth
    
    def _fallback_depth(self, image_path: str) -> np.ndarray:
        """
        Generate placeholder depth when API is not available.
        Uses basic monocular cues (not accurate, for testing only).
        """
        image = cv2.imread(image_path)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Simple depth from image gradient (very rough)
        sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
        sobely = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        gradient = np.sqrt(sobelx**2 + sobely**2)
        
        # Assume edges are closer
        depth = 1.0 / (gradient + 0.1)
        depth = depth / depth.max() * 5.0  # 0-5m range
        
        # Smooth
        depth = cv2.GaussianBlur(depth.astype(np.float32), (21, 21), 0)
        
        return depth
    
    def _unproject_depth(
        self,
        depth: np.ndarray,
        camera: Any,
        image_path: Path,
        scale: float,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Unproject depth map to 3D points"""
        
        h, w = depth.shape
        
        # Get camera intrinsics
        if hasattr(camera, 'fx'):
            fx, fy = camera.fx, camera.fy
            cx, cy = camera.cx, camera.cy
        else:
            fx = camera.get('fx', w * 1.2)
            fy = camera.get('fy', fx)
            cx = camera.get('cx', w / 2)
            cy = camera.get('cy', h / 2)
        
        # Create pixel grid
        u = np.arange(w)
        v = np.arange(h)
        u, v = np.meshgrid(u, v)
        
        # Unproject to camera coordinates
        z = depth * scale
        x = (u - cx) * z / fx
        y = (v - cy) * z / fy
        
        # Stack and reshape
        points_cam = np.stack([x, y, z], axis=-1).reshape(-1, 3)
        
        # Filter invalid points
        valid = (z.flatten() > 0.1) & (z.flatten() < 10.0)
        points_cam = points_cam[valid]
        
        # Transform to world coordinates
        if hasattr(camera, 'rotation'):
            R = camera.rotation
            t = camera.translation
        else:
            R = np.eye(3)
            t = np.zeros(3)
        
        # Camera to world: p_world = R^T @ (p_cam - t)
        points_world = (R.T @ (points_cam.T - t.reshape(3, 1))).T
        
        # Get colors
        image = cv2.imread(str(image_path))
        colors = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).reshape(-1, 3)
        colors = colors[valid]
        
        # Subsample for efficiency
        if len(points_world) > 50000:
            indices = np.random.choice(len(points_world), 50000, replace=False)
            points_world = points_world[indices]
            colors = colors[indices]
        
        return points_world, colors
    
    def _find_image(self, images_dir: Path, image_id: str) -> Optional[Path]:
        """Find image file by ID"""
        for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']:
            path = images_dir / f"{image_id}{ext}"
            if path.exists():
                return path
        return None
    
    def _count_ply_points(self, path: Path) -> int:
        """Count points in PLY file"""
        with open(path, 'rb') as f:
            for raw_line in f:
                line = raw_line.decode('ascii', errors='ignore').strip()
                if line.startswith('element vertex'):
                    try:
                        return int(line.split()[-1])
                    except (IndexError, ValueError):
                        return 0
                if line == 'end_header':
                    break
        return 0
    
    def _save_ply(
        self,
        points: np.ndarray,
        colors: np.ndarray,
        path: Path,
    ):
        """Save points to PLY file"""
        with open(path, 'w') as f:
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
            
            for (x, y, z), (r, g, b) in zip(points, colors):
                f.write(f"{x:.6f} {y:.6f} {z:.6f} {int(r)} {int(g)} {int(b)}\n")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Dense reconstruction')
    parser.add_argument('images_dir', help='Directory containing images')
    parser.add_argument('sfm_result', help='JSON file with SfM result')
    parser.add_argument('--output', '-o', default='./dense_output')
    parser.add_argument('--method', default='hybrid', choices=['colmap', 'depth_ai', 'hybrid'])
    parser.add_argument('--depth-model', default='depth_anything_v2')
    parser.add_argument('--depth-prior-source', default='auto', choices=['auto', 'fast3r', 'metric3d', 'depth_anything_v2', 'none'])
    
    args = parser.parse_args()
    
    with open(args.sfm_result) as f:
        sfm_result = json.load(f)
    
    reconstructor = DenseReconstructor(
        method=args.method,
        depth_model=args.depth_model,
        depth_prior_source=args.depth_prior_source,
    )
    
    result = reconstructor.run(
        Path(args.images_dir),
        sfm_result,
        Path(args.output),
    )
    
    print(f"\nDense Reconstruction Results:")
    print(f"  Points: {result['num_points']}")
    print(f"  Method: {result['method']}")
    print(f"  Output: {result['points_path']}")
