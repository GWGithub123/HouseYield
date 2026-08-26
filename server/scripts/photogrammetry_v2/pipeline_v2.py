#!/usr/bin/env python3
"""
Photogrammetry Pipeline v2 - Main Orchestrator

Complete pipeline for high-accuracy interior 3D reconstruction:
1. Structure from Motion (COLMAP)
2. AR Scale Integration (if available)
3. Metric3D v2 Depth Estimation
4. MVS + Metric3D Depth Fusion
5. TSDF Volumetric Reconstruction
6. Mesh Cleaning & Edge Preservation
7. Scale Refinement (reference objects)
8. Semantic Segmentation (SAM2)
9. Measurement Extraction
10. Export (mesh + measurements + textures)

Key improvements over v1:
- Metric3D replaces Depth Anything for true metric scale
- Depth fusion eliminates holes in textureless regions
- TSDF replaces Poisson for ±2-5mm accuracy vs ±10-15mm
- AR tracking provides initial metric scale
- Reference object detection refines scale to ±0.3%
- SAM2 segmentation enables automatic measurement extraction

Usage:
    python pipeline_v2.py <images_dir> <output_dir> [options]

Example:
    python pipeline_v2.py ./scans/kitchen ./output/kitchen --ar-poses ar_data.json

Output:
    output_dir/
    ├── sparse/           # COLMAP SfM output
    ├── dense/            # MVS output
    ├── depth/            # Depth maps (MVS + Metric3D)
    ├── fused_depth/      # Fused depth maps
    ├── mesh/             # Reconstructed meshes
    │   ├── raw.ply       # TSDF output
    │   ├── cleaned.ply   # After cleaning
    │   ├── scaled.ply    # After scale refinement
    │   └── labeled.ply   # With semantic labels
    ├── measurements.json # Extracted dimensions
    └── pipeline_stats.json
"""

import os
import sys
import json
import argparse
import time
import subprocess
import shutil
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field, asdict
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
import traceback

# Pipeline modules (import from same directory)
SCRIPT_DIR = Path(__file__).parent

# Add v1 photogrammetry scripts to path for GLOMAP/SuperPoint/LightGlue
V1_SCRIPTS_DIR = SCRIPT_DIR.parent / "photogrammetry"
if str(V1_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(V1_SCRIPTS_DIR))

# Try to import GCP Worker Client for GPU-accelerated processing
try:
    from gcp_worker_client import GcpWorkerClient
    HAS_GCP_WORKER = True
    print("[Pipeline v2] GCP GPU Worker client available")
except ImportError as e:
    HAS_GCP_WORKER = False
    print(f"[Pipeline v2] GCP Worker not available: {e}")

# Try to import optimized v1 modules (GLOMAP, SuperPoint, LightGlue)
try:
    from sfm import SfMReconstructor, GLOMAP_AVAILABLE
    from dense_reconstruction import DenseReconstructor
    HAS_V1_MODULES = True
    print(f"[Pipeline v2] Using optimized SfM (GLOMAP available: {GLOMAP_AVAILABLE})")
except ImportError as e:
    HAS_V1_MODULES = False
    GLOMAP_AVAILABLE = False
    print(f"[Pipeline v2] Warning: v1 modules not available ({e}), using basic COLMAP")

# =============================================================================
# CONFIGURATION
# =============================================================================

@dataclass
class PipelineConfig:
    """Pipeline configuration."""
    # Paths
    images_dir: Path = Path(".")
    output_dir: Path = Path("output")
    ar_poses_file: Optional[Path] = None
    
    # COLMAP/GLOMAP settings
    colmap_binary: str = "colmap"
    use_gpu: bool = True
    feature_type: str = "sift"  # 'sift' or 'superpoint'
    
    # Metric3D settings
    metric3d_model: str = "vit-large"  # vit-small, vit-large, vit-giant
    
    # Depth fusion settings
    fusion_mvs_high_threshold: float = 0.7
    fusion_mvs_low_threshold: float = 0.2
    
    # TSDF settings
    tsdf_voxel_size: float = 0.005  # 5mm voxels
    tsdf_sdf_trunc: float = 0.04    # 4cm truncation
    
    # Mesh cleaning
    min_component_ratio: float = 0.01
    smoothing_iterations: int = 2
    
    # Scale refinement
    scale_min_confidence: float = 0.5
    
    # Segmentation
    sam2_checkpoint: str = "facebook/sam2-hiera-large"
    segmentation_min_confidence: float = 0.3
    
    # Processing
    n_workers: int = 4
    skip_existing: bool = True
    verbose: bool = True


@dataclass
class PipelineStats:
    """Pipeline execution statistics."""
    total_images: int = 0
    registered_images: int = 0
    ar_poses_available: bool = False
    
    # Stage timings
    sfm_time: float = 0.0
    mvs_time: float = 0.0
    metric3d_time: float = 0.0
    fusion_time: float = 0.0
    tsdf_time: float = 0.0
    cleaning_time: float = 0.0
    scale_refinement_time: float = 0.0
    segmentation_time: float = 0.0
    measurement_time: float = 0.0
    total_time: float = 0.0
    
    # Quality metrics
    mesh_vertices: int = 0
    mesh_triangles: int = 0
    scale_correction: float = 1.0
    scale_confidence: float = 0.0
    
    # Measurements summary
    floor_area_sqm: float = 0.0
    ceiling_height_m: float = 0.0
    n_cabinets: int = 0
    n_doors: int = 0
    n_windows: int = 0
    
    # Status
    stages_completed: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


# =============================================================================
# STAGE RUNNERS
# =============================================================================

def run_colmap_sfm(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run Structure from Motion using GCP GPU Worker (preferred) or COLMAP."""
    print("\n" + "="*60)
    
    sparse_dir = config.output_dir / "sparse"
    dense_dir = config.output_dir / "dense"
    database_path = config.output_dir / "database.db"
    
    if config.skip_existing and (sparse_dir / "0" / "cameras.bin").exists():
        print("[SfM] Skipping - output exists")
        stats.stages_completed.append("sfm")
        return True
    
    sparse_dir.mkdir(parents=True, exist_ok=True)
    dense_dir.mkdir(parents=True, exist_ok=True)
    
    start_time = time.time()
    
    try:
        # PREFERRED: Use GCP GPU Worker for FULL V2 pipeline
        # This runs Metric3D + TSDF + everything on the remote GPU VM
        if HAS_GCP_WORKER:
            gcp_client = GcpWorkerClient()
            if gcp_client.is_available():
                # Check if GCP client has V2 method
                if hasattr(gcp_client, 'process_v2_pipeline'):
                    print("[Stage ALL] FULL V2 Pipeline on GCP GPU VM")
                    print("="*60)
                    print("[V2] Running ENTIRE pipeline on GCP: GLOMAP → MVS → Metric3D → TSDF...")
                    
                    # Load AR poses if available
                    ar_poses = None
                    if config.ar_poses_file and config.ar_poses_file.exists():
                        with open(config.ar_poses_file) as f:
                            ar_poses = json.load(f)
                    
                    # Run full V2 pipeline on GCP
                    gpu_result = gcp_client.process_v2_pipeline(
                        local_images_dir=config.images_dir,
                        local_output_dir=config.output_dir,
                        ar_poses=ar_poses,
                        metric3d_model=config.metric3d_model,
                        voxel_size=config.tsdf_voxel_size,
                        skip_segmentation=False,
                    )
                    
                    if gpu_result.get('success', False):
                        stats.sfm_time = time.time() - start_time
                        stats.total_time = stats.sfm_time
                        
                        # Mark ALL stages as completed (they ran on GCP)
                        stats.stages_completed.extend([
                            "sfm", "dense", "metric3d", "fusion", "tsdf",
                            "cleaning", "segmentation", "measurements"
                        ])
                        
                        print(f"[V2] ✅ Complete V2 pipeline finished on GCP GPU ({stats.sfm_time:.1f}s)")
                        
                        # Return True - no need to run any more stages locally
                        return "GCP_V2_COMPLETE"
                    else:
                        print(f"[V2] GCP V2 failed: {gpu_result.get('error', 'unknown')}, falling back to V1+local...")
                
                # Fallback: Run V1 (SfM+Dense) on GCP, V2 stages locally
                print("[Stage 1] Structure from Motion + Dense (GCP GPU V1)")
                print("="*60)
                print("[SfM] Using GCP GPU Worker with GLOMAP/SuperPoint/LightGlue...")
                
                # Run V1 full pipeline on GCP (features, matching, SfM, dense)
                gpu_result = gcp_client.process_full_pipeline(
                    local_images_dir=config.images_dir,
                    local_output_dir=config.output_dir,
                    quality='high',
                )
                
                if gpu_result.get('success', False) or gpu_result.get('num_dense_points', 0) > 0:
                    stats.registered_images = gpu_result.get('num_registered', 0)
                    stats.sfm_time = time.time() - start_time
                    stats.stages_completed.append("sfm")
                    stats.stages_completed.append("dense")  # GCP does both
                    
                    print(f"[SfM+Dense] ✅ GCP GPU complete ({stats.sfm_time:.1f}s)")
                    return True
                else:
                    print(f"[SfM] GCP GPU failed: {gpu_result.get('error', 'unknown')}, falling back...")
        
        # FALLBACK: Use optimized v1 SfM module if available (GLOMAP, SuperPoint, LightGlue)
        if HAS_V1_MODULES and GLOMAP_AVAILABLE:
            print("[Stage 1] Structure from Motion (GLOMAP - 10-100x faster)")
            print("="*60)
            print("[SfM] Using optimized SfM with GLOMAP/SuperPoint/LightGlue...")
            sfm = SfMReconstructor(
                images_dir=config.images_dir,
                output_dir=config.output_dir,
                feature_type=config.feature_type,  # 'sift' or 'superpoint'
                use_gpu=config.use_gpu,
            )
            result = sfm.run()
            stats.registered_images = result.get('num_registered', 0)
        elif HAS_V1_MODULES:
            print("[Stage 1] Structure from Motion (COLMAP via v1 modules)")
            print("="*60)
            print("[SfM] Using v1 SfM module...")
            sfm = SfMReconstructor(
                images_dir=config.images_dir,
                output_dir=config.output_dir,
                feature_type='sift',
                use_gpu=config.use_gpu,
            )
            result = sfm.run()
            stats.registered_images = result.get('num_registered', 0)
        else:
            # Last resort fallback to basic COLMAP
            print("[Stage 1] Structure from Motion (COLMAP basic)")
            print("="*60)
            print("[SfM] Using basic COLMAP (no v1 modules or GCP)...")
            
            # Feature extraction
            print("[SfM] Extracting features (SIFT)...")
            cmd = [
                config.colmap_binary, "feature_extractor",
                "--database_path", str(database_path),
                "--image_path", str(config.images_dir),
                "--ImageReader.single_camera", "1",
            ]
            # Note: Newer COLMAP/GLOMAP uses GPU by default, no need for explicit flag
            
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
            
            # Feature matching
            print("[SfM] Matching features...")
            cmd = [
                config.colmap_binary, "exhaustive_matcher",
                "--database_path", str(database_path),
            ]
            # Note: Newer COLMAP/GLOMAP uses GPU by default for matching
            
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
            
            # Sparse reconstruction
            print("[SfM] Running sparse reconstruction...")
            cmd = [
                config.colmap_binary, "mapper",
                "--database_path", str(database_path),
                "--image_path", str(config.images_dir),
                "--output_path", str(sparse_dir),
            ]
            
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
            
            # Count registered images
            images_bin = sparse_dir / "0" / "images.bin"
            if images_bin.exists():
                import struct
                with open(images_bin, 'rb') as f:
                    stats.registered_images = struct.unpack('<Q', f.read(8))[0]
        
        stats.sfm_time = time.time() - start_time
        stats.stages_completed.append("sfm")
        
        print(f"[SfM] ✅ Complete: {stats.registered_images} images registered "
              f"({stats.sfm_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"SfM failed: {e}")
        print(f"[SfM] ❌ Error: {e}")
        return False
    except Exception as e:
        stats.errors.append(f"SfM error: {e}")
        print(f"[SfM] ❌ Error: {e}")
        return False


def run_colmap_mvs(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run COLMAP Multi-View Stereo."""
    print("\n" + "="*60)
    print("[Stage 2] Multi-View Stereo (COLMAP)")
    print("="*60)
    
    sparse_dir = config.output_dir / "sparse" / "0"
    dense_dir = config.output_dir / "dense"
    
    if config.skip_existing and (dense_dir / "stereo" / "depth_maps").exists():
        print("[MVS] Skipping - output exists")
        stats.stages_completed.append("mvs")
        return True
    
    dense_dir.mkdir(parents=True, exist_ok=True)
    
    start_time = time.time()
    
    try:
        # Image undistortion
        print("[MVS] Undistorting images...")
        cmd = [
            config.colmap_binary, "image_undistorter",
            "--image_path", str(config.images_dir),
            "--input_path", str(sparse_dir),
            "--output_path", str(dense_dir),
            "--output_type", "COLMAP",
        ]
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Patch match stereo
        print("[MVS] Running patch match stereo...")
        cmd = [
            config.colmap_binary, "patch_match_stereo",
            "--workspace_path", str(dense_dir),
            "--workspace_format", "COLMAP",
            "--PatchMatchStereo.geom_consistency", "true",
        ]
        if config.use_gpu:
            cmd.extend(["--PatchMatchStereo.gpu_index", "0"])
        
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Stereo fusion (for point cloud, optional)
        print("[MVS] Fusing depth maps...")
        cmd = [
            config.colmap_binary, "stereo_fusion",
            "--workspace_path", str(dense_dir),
            "--workspace_format", "COLMAP",
            "--input_type", "geometric",
            "--output_path", str(dense_dir / "fused.ply"),
        ]
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        stats.mvs_time = time.time() - start_time
        stats.stages_completed.append("mvs")
        
        print(f"[MVS] ✅ Complete ({stats.mvs_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"MVS failed: {e}")
        print(f"[MVS] ❌ Error: {e}")
        return False


def run_metric3d(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run Metric3D v2 depth estimation."""
    print("\n" + "="*60)
    print("[Stage 3] Metric3D v2 Depth Estimation")
    print("="*60)
    
    depth_dir = config.output_dir / "metric3d_depth"
    colmap_dir = config.output_dir / "sparse" / "0"
    
    if config.skip_existing and depth_dir.exists() and len(list(depth_dir.glob("*.npy"))) > 0:
        print("[Metric3D] Skipping - output exists")
        stats.stages_completed.append("metric3d")
        return True
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "generate_metric_depth.py"
        cmd = [
            sys.executable, str(script),
            str(config.images_dir),
            str(colmap_dir),
            str(depth_dir),
            "--model-size", config.metric3d_model,
        ]
        
        subprocess.run(cmd, check=True)
        
        stats.metric3d_time = time.time() - start_time
        stats.stages_completed.append("metric3d")
        
        print(f"[Metric3D] ✅ Complete ({stats.metric3d_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"Metric3D failed: {e}")
        print(f"[Metric3D] ❌ Error: {e}")
        return False


def run_depth_fusion(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run depth map fusion (MVS + Metric3D)."""
    print("\n" + "="*60)
    print("[Stage 4] Depth Fusion (MVS + Metric3D)")
    print("="*60)
    
    fused_dir = config.output_dir / "fused_depth"
    metric3d_dir = config.output_dir / "metric3d_depth"
    
    if config.skip_existing and fused_dir.exists() and len(list(fused_dir.glob("*.npy"))) > 0:
        print("[Fusion] Skipping - output exists")
        stats.stages_completed.append("fusion")
        return True
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "depth_fusion.py"
        cmd = [
            sys.executable, str(script),
            str(config.output_dir),
            str(metric3d_dir),
            str(fused_dir),
            "--high-conf", str(config.fusion_mvs_high_threshold),
            "--low-conf", str(config.fusion_mvs_low_threshold),
        ]
        
        subprocess.run(cmd, check=True)
        
        stats.fusion_time = time.time() - start_time
        stats.stages_completed.append("fusion")
        
        print(f"[Fusion] ✅ Complete ({stats.fusion_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"Depth fusion failed: {e}")
        print(f"[Fusion] ❌ Error: {e}")
        return False


def run_tsdf_reconstruction(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run TSDF volumetric reconstruction."""
    print("\n" + "="*60)
    print("[Stage 5] TSDF Volumetric Reconstruction")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    raw_mesh = mesh_dir / "raw.ply"
    cleaned_mesh = mesh_dir / "cleaned.ply"
    fused_dir = config.output_dir / "fused_depth"
    colmap_workspace = config.output_dir
    
    if config.skip_existing and cleaned_mesh.exists():
        print("[TSDF] Skipping - output exists")
        stats.stages_completed.append("tsdf")
        return True
    
    mesh_dir.mkdir(parents=True, exist_ok=True)
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "tsdf_reconstruction.py"
        cmd = [
            sys.executable, str(script),
            str(fused_dir),
            str(config.images_dir),
            str(colmap_workspace),
            str(mesh_dir),
            "--voxel-size", str(config.tsdf_voxel_size),
            "--depth-trunc", str(config.tsdf_sdf_trunc),
        ]
        
        subprocess.run(cmd, check=True)
        
        stats.tsdf_time = time.time() - start_time
        stats.stages_completed.append("tsdf")
        
        # Get mesh stats
        try:
            import open3d as o3d
            mesh = o3d.io.read_triangle_mesh(str(cleaned_mesh))
            stats.mesh_vertices = len(mesh.vertices)
            stats.mesh_triangles = len(mesh.triangles)
        except:
            pass
        
        print(f"[TSDF] ✅ Complete: {stats.mesh_vertices:,} vertices, "
              f"{stats.mesh_triangles:,} triangles ({stats.tsdf_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"TSDF failed: {e}")
        print(f"[TSDF] ❌ Error: {e}")
        return False


def run_scale_refinement(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run scale refinement using reference objects."""
    print("\n" + "="*60)
    print("[Stage 6] Scale Refinement")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    input_mesh = mesh_dir / "cleaned.ply"
    scaled_mesh = mesh_dir / "scaled.ply"
    
    if config.skip_existing and scaled_mesh.exists():
        print("[Scale] Skipping - output exists")
        stats.stages_completed.append("scale")
        return True
    
    # Get AR scale if available
    ar_scale = 1.0
    if config.ar_poses_file and config.ar_poses_file.exists():
        try:
            with open(config.ar_poses_file, 'r') as f:
                ar_data = json.load(f)
            ar_scale = ar_data.get('scale', 1.0)
            stats.ar_poses_available = True
            print(f"[Scale] AR scale: {ar_scale:.4f}")
        except:
            pass
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "scale_refinement.py"
        cmd = [
            sys.executable, str(script),
            str(input_mesh),
            str(scaled_mesh),
            "--ar-scale", str(ar_scale),
            "--min-confidence", str(config.scale_min_confidence),
        ]
        
        subprocess.run(cmd, check=True)
        
        # Read refinement stats
        stats_file = mesh_dir / "scale_refinement.json"
        if stats_file.exists():
            with open(stats_file, 'r') as f:
                scale_stats = json.load(f)
            stats.scale_correction = scale_stats.get('scale_correction', 1.0)
            stats.scale_confidence = scale_stats.get('confidence', 0.0)
        
        stats.scale_refinement_time = time.time() - start_time
        stats.stages_completed.append("scale")
        
        print(f"[Scale] ✅ Complete: correction={stats.scale_correction:.4f}, "
              f"confidence={stats.scale_confidence:.2f} ({stats.scale_refinement_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"Scale refinement failed: {e}")
        print(f"[Scale] ❌ Error: {e}")
        # Copy cleaned mesh as scaled if refinement fails
        fallback_mesh = input_mesh if input_mesh.exists() else (mesh_dir / "raw.ply")
        if fallback_mesh.exists():
            shutil.copy(fallback_mesh, scaled_mesh)
        return True  # Non-fatal


def run_semantic_segmentation(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run SAM2 semantic segmentation."""
    print("\n" + "="*60)
    print("[Stage 7] Semantic Segmentation (SAM2)")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    input_mesh = mesh_dir / "scaled.ply"
    labeled_mesh = mesh_dir / "labeled.ply"
    colmap_dir = config.output_dir / "sparse" / "0"
    
    if config.skip_existing and labeled_mesh.exists():
        print("[Segment] Skipping - output exists")
        stats.stages_completed.append("segmentation")
        return True
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "semantic_segmentation.py"
        cmd = [
            sys.executable, str(script),
            str(config.images_dir),
            str(input_mesh),
            str(colmap_dir),
            str(labeled_mesh),
            "--sam2-checkpoint", config.sam2_checkpoint,
            "--min-confidence", str(config.segmentation_min_confidence),
        ]
        
        subprocess.run(cmd, check=True)
        
        stats.segmentation_time = time.time() - start_time
        stats.stages_completed.append("segmentation")
        
        print(f"[Segment] ✅ Complete ({stats.segmentation_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"Segmentation failed: {e}")
        print(f"[Segment] ❌ Error: {e}")
        # Copy scaled mesh as labeled if segmentation fails
        shutil.copy(input_mesh, labeled_mesh)
        return True  # Non-fatal


def run_measurement_export(config: PipelineConfig, stats: PipelineStats) -> bool:
    """Run measurement extraction."""
    print("\n" + "="*60)
    print("[Stage 8] Measurement Extraction")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    labeled_mesh = mesh_dir / "labeled.ply"
    labels_file = mesh_dir / "triangle_labels.json"
    measurements_file = config.output_dir / "measurements.json"
    
    if config.skip_existing and measurements_file.exists():
        print("[Measure] Skipping - output exists")
        stats.stages_completed.append("measurements")
        return True
    
    # Check if we have labels
    if not labels_file.exists():
        print("[Measure] Warning: No labels file, creating basic measurements")
        # Create dummy labels for unlabeled mesh
        try:
            import open3d as o3d
            mesh = o3d.io.read_triangle_mesh(str(labeled_mesh))
            n_triangles = len(mesh.triangles)
            with open(labels_file, 'w') as f:
                json.dump({
                    'labels': ['unknown'] * n_triangles,
                    'confidences': [0.0] * n_triangles,
                    'categories': [],
                }, f)
        except Exception as e:
            stats.errors.append(f"Could not create dummy labels: {e}")
            return False
    
    start_time = time.time()
    
    try:
        script = SCRIPT_DIR / "measurement_export.py"
        cmd = [
            sys.executable, str(script),
            str(labeled_mesh),
            str(labels_file),
            str(measurements_file),
        ]
        
        subprocess.run(cmd, check=True)
        
        # Read measurements for stats
        if measurements_file.exists():
            with open(measurements_file, 'r') as f:
                measurements = json.load(f)
            
            room = measurements.get('room', {})
            stats.floor_area_sqm = room.get('floor_area_sqm', 0)
            stats.ceiling_height_m = room.get('ceiling_height_m', 0)
            stats.n_cabinets = len(measurements.get('cabinets', []))
            stats.n_doors = len(measurements.get('doors', []))
            stats.n_windows = len(measurements.get('windows', []))
        
        stats.measurement_time = time.time() - start_time
        stats.stages_completed.append("measurements")
        
        print(f"[Measure] ✅ Complete ({stats.measurement_time:.1f}s)")
        return True
        
    except subprocess.CalledProcessError as e:
        stats.errors.append(f"Measurement export failed: {e}")
        print(f"[Measure] ❌ Error: {e}")
        return False


# =============================================================================
# MAIN PIPELINE
# =============================================================================

def run_pipeline_v2(config: PipelineConfig) -> PipelineStats:
    """
    Run the complete v2 photogrammetry pipeline.
    
    Args:
        config: Pipeline configuration
    
    Returns:
        Pipeline statistics
    """
    stats = PipelineStats()
    
    # Count input images
    image_extensions = {'.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'}
    stats.total_images = sum(
        1 for f in config.images_dir.iterdir()
        if f.suffix in image_extensions
    )
    
    print("\n" + "="*60)
    print("PHOTOGRAMMETRY PIPELINE v2")
    print("="*60)
    print(f"Images: {config.images_dir} ({stats.total_images} images)")
    print(f"Output: {config.output_dir}")
    if config.ar_poses_file:
        print(f"AR Poses: {config.ar_poses_file}")
    print("="*60)
    
    start_time = time.time()
    
    # Ensure output directory exists
    config.output_dir.mkdir(parents=True, exist_ok=True)
    
    # Stage 1: Structure from Motion
    sfm_result = run_colmap_sfm(config, stats)
    
    # Check if FULL V2 pipeline ran on GCP (all stages done)
    if sfm_result == "GCP_V2_COMPLETE":
        # Everything ran on GCP - just finalize stats and return
        stats.total_time = time.time() - start_time
        
        # Try to load stats from GCP output
        stats_file = config.output_dir / "pipeline_stats.json"
        if stats_file.exists():
            with open(stats_file) as f:
                gcp_stats = json.load(f)
                # Merge GCP stats
                for key in ['mesh_vertices', 'mesh_triangles', 'floor_area_sqm', 
                           'ceiling_height_m', 'n_cabinets', 'n_doors', 'n_windows']:
                    if key in gcp_stats:
                        setattr(stats, key, gcp_stats[key])
        
        print("\n" + "="*60)
        print("PIPELINE COMPLETE (V2 on GCP)")
        print("="*60)
        print(f"Total time: {stats.total_time:.1f}s ({stats.total_time/60:.1f} min)")
        print(f"Stages completed on GCP: {len(stats.stages_completed)}")
        print(f"Output: {config.output_dir}")
        print("="*60)
        
        return stats
    
    if not sfm_result:
        print("\n[Pipeline] ❌ Failed at SfM stage")
        stats.total_time = time.time() - start_time
        return stats
    
    # Stage 2: Multi-View Stereo
    if not run_colmap_mvs(config, stats):
        print("\n[Pipeline] ❌ Failed at MVS stage")
        stats.total_time = time.time() - start_time
        return stats
    
    # Stage 3: Metric3D Depth
    if not run_metric3d(config, stats):
        print("\n[Pipeline] Warning: Metric3D failed, using MVS depth only")
        # Continue with MVS-only depth
    
    # Stage 4: Depth Fusion
    if "metric3d" in stats.stages_completed:
        if not run_depth_fusion(config, stats):
            print("\n[Pipeline] Warning: Fusion failed, using MVS depth")
    
    # Stage 5: TSDF Reconstruction
    if not run_tsdf_reconstruction(config, stats):
        print("\n[Pipeline] ❌ Failed at TSDF stage")
        stats.total_time = time.time() - start_time
        return stats
    
    # Stage 6: Scale Refinement
    run_scale_refinement(config, stats)
    
    # Stage 7: Semantic Segmentation
    run_semantic_segmentation(config, stats)
    
    # Stage 8: Measurement Export
    run_measurement_export(config, stats)
    
    stats.total_time = time.time() - start_time
    
    # Save pipeline stats
    stats_file = config.output_dir / "pipeline_stats.json"
    with open(stats_file, 'w') as f:
        json.dump(asdict(stats), f, indent=2)
    
    # Print summary
    print("\n" + "="*60)
    print("PIPELINE COMPLETE")
    print("="*60)
    print(f"Total time: {stats.total_time:.1f}s ({stats.total_time/60:.1f} min)")
    print(f"Stages completed: {len(stats.stages_completed)}/8")
    print(f"Images: {stats.registered_images}/{stats.total_images} registered")
    print(f"Mesh: {stats.mesh_vertices:,} vertices, {stats.mesh_triangles:,} triangles")
    
    if stats.floor_area_sqm > 0:
        print(f"\nMeasurements:")
        print(f"  Floor area: {stats.floor_area_sqm:.2f} m² ({stats.floor_area_sqm * 10.764:.1f} ft²)")
        print(f"  Ceiling height: {stats.ceiling_height_m:.2f} m ({stats.ceiling_height_m * 3.281:.1f} ft)")
        print(f"  Cabinets: {stats.n_cabinets}")
        print(f"  Doors: {stats.n_doors}")
        print(f"  Windows: {stats.n_windows}")
    
    if stats.errors:
        print(f"\nWarnings/Errors: {len(stats.errors)}")
        for err in stats.errors:
            print(f"  - {err}")
    
    print(f"\nOutput: {config.output_dir}")
    print("="*60)
    
    return stats


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Photogrammetry Pipeline v2 - High-accuracy interior reconstruction'
    )
    parser.add_argument('images_dir', type=Path, help='Directory with input images')
    parser.add_argument('output_dir', type=Path, help='Output directory')
    parser.add_argument('--ar-poses', type=Path, help='AR poses JSON file')
    
    # COLMAP options
    parser.add_argument('--colmap', type=str, default='colmap', help='COLMAP binary path')
    parser.add_argument('--no-gpu', action='store_true', help='Disable GPU')
    
    # Model options
    parser.add_argument('--metric3d-model', type=str, default='vit-large',
                        choices=['vit-small', 'vit-large', 'vit-giant'])
    parser.add_argument('--sam2-checkpoint', type=str, default='facebook/sam2-hiera-large')
    
    # TSDF options
    parser.add_argument('--voxel-size', type=float, default=0.005, help='TSDF voxel size (m)')
    
    # Processing options
    parser.add_argument('--workers', type=int, default=4, help='Number of workers')
    parser.add_argument('--force', action='store_true', help='Reprocess all stages')
    parser.add_argument('--quiet', action='store_true', help='Reduce output')
    
    args = parser.parse_args()
    
    config = PipelineConfig(
        images_dir=args.images_dir,
        output_dir=args.output_dir,
        ar_poses_file=args.ar_poses,
        colmap_binary=args.colmap,
        use_gpu=not args.no_gpu,
        metric3d_model=args.metric3d_model,
        sam2_checkpoint=args.sam2_checkpoint,
        tsdf_voxel_size=args.voxel_size,
        n_workers=args.workers,
        skip_existing=not args.force,
        verbose=not args.quiet,
    )
    
    stats = run_pipeline_v2(config)
    
    # Exit with error if critical stages failed
    critical_stages = {'sfm', 'mvs', 'tsdf'}
    if not critical_stages.issubset(set(stats.stages_completed)):
        sys.exit(1)


if __name__ == '__main__':
    main()
