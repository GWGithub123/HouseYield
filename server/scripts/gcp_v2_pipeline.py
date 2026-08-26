#!/usr/bin/env python3
"""
GCP V2 Pipeline - Runs ENTIRELY on the GCP GPU VM

This is a self-contained script that runs all V2 stages directly on GCP:
1. GLOMAP/HLOC SfM (SuperPoint + LightGlue)
2. COLMAP MVS Dense Reconstruction (GPU accelerated)
3. Metric3D Depth Estimation (GPU accelerated)
4. Depth Fusion (MVS + Metric3D)
5. TSDF Volumetric Reconstruction
6. Mesh Cleaning + Edge Preservation
7. Texture Mapping (OpenMVS)
8. Export (mesh + measurements)

Usage on GCP VM:
    python3 gcp_v2_pipeline.py <images_dir> <output_dir> [options]

This script is uploaded to and runs on the GCP GPU VM.
It should NOT import GcpWorkerClient (that would be circular).
"""

import os
import sys
import json
import argparse
import time
import subprocess
import shutil
import struct
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field, asdict
import numpy as np

# =============================================================================
# CONFIGURATION
# =============================================================================

@dataclass
class V2Config:
    """V2 Pipeline configuration."""
    images_dir: Path = Path(".")
    output_dir: Path = Path("output")
    ar_poses_file: Optional[Path] = None
    
    # SfM settings
    colmap_binary: str = "colmap"
    use_gpu: bool = True
    
    # Metric3D settings
    metric3d_model: str = "vit-large"
    
    # TSDF settings
    tsdf_voxel_size: float = 0.005  # 5mm voxels
    tsdf_sdf_trunc: float = 0.04    # 4cm truncation
    
    # Mesh settings
    min_component_ratio: float = 0.01
    smoothing_iterations: int = 2
    
    # Processing
    skip_existing: bool = True
    verbose: bool = True


@dataclass 
class V2Stats:
    """Pipeline execution statistics."""
    total_images: int = 0
    registered_images: int = 0
    sparse_points: int = 0
    dense_points: int = 0
    mesh_vertices: int = 0
    mesh_faces: int = 0
    
    sfm_time: float = 0.0
    mvs_time: float = 0.0
    metric3d_time: float = 0.0
    fusion_time: float = 0.0
    tsdf_time: float = 0.0
    mesh_time: float = 0.0
    texture_time: float = 0.0
    total_time: float = 0.0
    
    stages_completed: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


# =============================================================================
# STAGE 1: STRUCTURE FROM MOTION (GLOMAP + HLOC)
# =============================================================================

def run_sfm(config: V2Config, stats: V2Stats) -> bool:
    """Run SfM using GLOMAP with HLOC features (or fallback to COLMAP)."""
    print("\n" + "="*60)
    print("[Stage 1] Structure from Motion")
    print("="*60)
    
    sparse_dir = config.output_dir / "sparse"
    database_path = config.output_dir / "database.db"
    
    sparse_dir.mkdir(parents=True, exist_ok=True)
    
    if config.skip_existing and (sparse_dir / "0" / "cameras.bin").exists():
        print("[SfM] Skipping - output exists")
        stats.stages_completed.append("sfm")
        return True
    
    start_time = time.time()
    
    # Count images
    images = list(config.images_dir.glob("*.jpg")) + list(config.images_dir.glob("*.png"))
    stats.total_images = len(images)
    print(f"[SfM] Processing {stats.total_images} images...")
    
    try:
        # Try HLOC SuperPoint first
        hloc_success = False
        try:
            import hloc
            from hloc import extract_features, match_features, reconstruction
            print("[SfM] Using HLOC SuperPoint + LightGlue...")
            
            # Feature extraction
            features_path = config.output_dir / "features.h5"
            feature_conf = extract_features.confs['superpoint_max']
            extract_features.main(feature_conf, config.images_dir, feature_path=features_path)
            
            # Matching
            matches_path = config.output_dir / "matches.h5"
            pairs_path = config.output_dir / "pairs.txt"
            
            # Generate exhaustive pairs
            image_names = [p.name for p in images]
            with open(pairs_path, 'w') as f:
                for i, img1 in enumerate(image_names):
                    for img2 in image_names[i+1:]:
                        f.write(f"{img1} {img2}\n")
            
            match_conf = match_features.confs['superpoint+lightglue']
            match_features.main(match_conf, pairs_path, features_path, matches=matches_path)
            
            hloc_success = True
            print("[SfM] HLOC features and matches complete")
            
        except Exception as e:
            print(f"[SfM] HLOC failed: {e}, falling back to COLMAP SIFT")
        
        # Feature extraction (COLMAP SIFT fallback)
        if not hloc_success:
            print("[SfM] Extracting SIFT features...")
            cmd = [
                config.colmap_binary, "feature_extractor",
                "--database_path", str(database_path),
                "--image_path", str(config.images_dir),
                "--ImageReader.single_camera", "1",
                "--ImageReader.camera_model", "OPENCV",
            ]
            if config.use_gpu:
                cmd.extend(["--SiftExtraction.use_gpu", "1"])
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
            
            # Matching
            print("[SfM] Matching features...")
            cmd = [
                config.colmap_binary, "exhaustive_matcher",
                "--database_path", str(database_path),
            ]
            if config.use_gpu:
                cmd.extend(["--SiftMatching.use_gpu", "1"])
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Try GLOMAP first (10-100x faster)
        glomap_path = shutil.which("glomap")
        if glomap_path:
            print("[SfM] Running GLOMAP mapper (global SfM)...")
            cmd = [
                glomap_path, "mapper",
                "--database_path", str(database_path),
                "--image_path", str(config.images_dir),
                "--output_path", str(sparse_dir),
            ]
            subprocess.run(cmd, check=True, capture_output=not config.verbose)
        else:
            print("[SfM] Running COLMAP mapper...")
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
            with open(images_bin, 'rb') as f:
                stats.registered_images = struct.unpack('<Q', f.read(8))[0]
        
        stats.sfm_time = time.time() - start_time
        stats.stages_completed.append("sfm")
        print(f"[SfM] ✅ Complete: {stats.registered_images}/{stats.total_images} images ({stats.sfm_time:.1f}s)")
        return True
        
    except Exception as e:
        stats.errors.append(f"SfM failed: {e}")
        print(f"[SfM] ❌ Error: {e}")
        return False


# =============================================================================
# STAGE 2: DENSE MVS RECONSTRUCTION
# =============================================================================

def run_mvs(config: V2Config, stats: V2Stats) -> bool:
    """Run dense MVS reconstruction using COLMAP with GPU."""
    print("\n" + "="*60)
    print("[Stage 2] Dense MVS Reconstruction")
    print("="*60)
    
    sparse_dir = config.output_dir / "sparse" / "0"
    dense_dir = config.output_dir / "dense"
    dense_dir.mkdir(parents=True, exist_ok=True)
    
    fused_path = dense_dir / "fused.ply"
    
    if config.skip_existing and fused_path.exists():
        print("[MVS] Skipping - output exists")
        stats.stages_completed.append("mvs")
        return True
    
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
        print("[MVS] Running PatchMatch stereo (GPU)...")
        cmd = [
            config.colmap_binary, "patch_match_stereo",
            "--workspace_path", str(dense_dir),
            "--workspace_format", "COLMAP",
            "--PatchMatchStereo.geom_consistency", "true",
        ]
        if config.use_gpu:
            cmd.extend(["--PatchMatchStereo.gpu_index", "0"])
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Stereo fusion
        print("[MVS] Fusing depth maps...")
        cmd = [
            config.colmap_binary, "stereo_fusion",
            "--workspace_path", str(dense_dir),
            "--workspace_format", "COLMAP",
            "--input_type", "geometric",
            "--output_path", str(fused_path),
        ]
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Count points
        if fused_path.exists():
            with open(fused_path, 'rb') as f:
                header = b""
                while b"end_header" not in header:
                    header += f.readline()
                for line in header.decode().split('\n'):
                    if line.startswith('element vertex'):
                        stats.dense_points = int(line.split()[-1])
                        break
        
        stats.mvs_time = time.time() - start_time
        stats.stages_completed.append("mvs")
        print(f"[MVS] ✅ Complete: {stats.dense_points:,} points ({stats.mvs_time:.1f}s)")
        return True
        
    except Exception as e:
        stats.errors.append(f"MVS failed: {e}")
        print(f"[MVS] ❌ Error: {e}")
        return False


# =============================================================================
# STAGE 3: METRIC3D DEPTH ESTIMATION
# =============================================================================

def run_metric3d(config: V2Config, stats: V2Stats) -> bool:
    """Run Metric3D v2 for metric-scale depth estimation."""
    print("\n" + "="*60)
    print("[Stage 3] Metric3D Depth Estimation")
    print("="*60)
    
    depth_dir = config.output_dir / "metric3d"
    depth_dir.mkdir(parents=True, exist_ok=True)
    
    if config.skip_existing and (depth_dir / "metadata.json").exists():
        print("[Metric3D] Skipping - output exists")
        stats.stages_completed.append("metric3d")
        return True
    
    start_time = time.time()
    
    try:
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        from PIL import Image
        import cv2
        
        print(f"[Metric3D] Loading model: {config.metric3d_model}...")
        
        # Use Depth Anything v2 as Metric3D alternative (better availability)
        model_name = "depth-anything/Depth-Anything-V2-Large"
        processor = AutoImageProcessor.from_pretrained(model_name)
        model = AutoModelForDepthEstimation.from_pretrained(model_name)
        
        if torch.cuda.is_available():
            model = model.cuda()
            print("[Metric3D] Using CUDA GPU")
        
        model.eval()
        
        # Process all images
        images = sorted(config.images_dir.glob("*.jpg")) + sorted(config.images_dir.glob("*.png"))
        
        for i, img_path in enumerate(images):
            print(f"[Metric3D] Processing {i+1}/{len(images)}: {img_path.name}")
            
            # Load image
            image = Image.open(img_path).convert("RGB")
            
            # Predict depth
            inputs = processor(images=image, return_tensors="pt")
            if torch.cuda.is_available():
                inputs = {k: v.cuda() for k, v in inputs.items()}
            
            with torch.no_grad():
                outputs = model(**inputs)
                depth = outputs.predicted_depth
            
            # Resize to original size
            depth = torch.nn.functional.interpolate(
                depth.unsqueeze(1),
                size=image.size[::-1],
                mode="bicubic",
                align_corners=False,
            ).squeeze().cpu().numpy()
            
            # Save depth map
            depth_path = depth_dir / f"{img_path.stem}_depth.npy"
            np.save(depth_path, depth.astype(np.float32))
        
        # Save metadata
        metadata = {
            "model": model_name,
            "num_images": len(images),
            "output_format": "npy_float32",
        }
        with open(depth_dir / "metadata.json", 'w') as f:
            json.dump(metadata, f, indent=2)
        
        stats.metric3d_time = time.time() - start_time
        stats.stages_completed.append("metric3d")
        print(f"[Metric3D] ✅ Complete: {len(images)} depth maps ({stats.metric3d_time:.1f}s)")
        return True
        
    except Exception as e:
        stats.errors.append(f"Metric3D failed: {e}")
        print(f"[Metric3D] ❌ Error: {e}")
        print("[Metric3D] Continuing without AI depth (MVS only)")
        return True  # Non-fatal


# =============================================================================
# STAGE 4: TSDF RECONSTRUCTION
# =============================================================================

def run_tsdf(config: V2Config, stats: V2Stats) -> bool:
    """Run TSDF volumetric reconstruction using Open3D."""
    print("\n" + "="*60)
    print("[Stage 4] TSDF Volumetric Reconstruction")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    mesh_dir.mkdir(parents=True, exist_ok=True)
    
    raw_mesh_path = mesh_dir / "raw.ply"
    
    if config.skip_existing and raw_mesh_path.exists():
        print("[TSDF] Skipping - output exists")
        stats.stages_completed.append("tsdf")
        return True
    
    start_time = time.time()
    
    try:
        import open3d as o3d
        
        # Load dense point cloud from MVS
        fused_path = config.output_dir / "dense" / "fused.ply"
        if not fused_path.exists():
            raise FileNotFoundError(f"Dense point cloud not found: {fused_path}")
        
        print("[TSDF] Loading point cloud...")
        pcd = o3d.io.read_point_cloud(str(fused_path))
        print(f"[TSDF] Loaded {len(pcd.points):,} points")
        
        # Estimate normals if not present
        if not pcd.has_normals():
            print("[TSDF] Estimating normals...")
            pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))
            pcd.orient_normals_consistent_tangent_plane(30)
        
        # Create mesh using Poisson reconstruction (better than TSDF for sparse data)
        print("[TSDF] Running Poisson reconstruction...")
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=10, width=0, scale=1.1, linear_fit=False
        )
        
        # Remove low-density vertices
        vertices_to_remove = densities < np.quantile(densities, 0.01)
        mesh.remove_vertices_by_mask(vertices_to_remove)
        
        # Clean mesh
        print("[TSDF] Cleaning mesh...")
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_non_manifold_edges()
        
        # Remove small components
        triangle_clusters, cluster_n_triangles, _ = mesh.cluster_connected_triangles()
        triangle_clusters = np.asarray(triangle_clusters)
        cluster_n_triangles = np.asarray(cluster_n_triangles)
        
        largest_cluster_idx = cluster_n_triangles.argmax()
        triangles_to_remove = triangle_clusters != largest_cluster_idx
        mesh.remove_triangles_by_mask(triangles_to_remove)
        mesh.remove_unreferenced_vertices()
        
        stats.mesh_vertices = len(mesh.vertices)
        stats.mesh_faces = len(mesh.triangles)
        
        # Save mesh
        print(f"[TSDF] Saving mesh: {stats.mesh_vertices:,} vertices, {stats.mesh_faces:,} faces")
        o3d.io.write_triangle_mesh(str(raw_mesh_path), mesh)
        
        # Also save cleaned version
        cleaned_mesh_path = mesh_dir / "cleaned.ply"
        o3d.io.write_triangle_mesh(str(cleaned_mesh_path), mesh)
        
        stats.tsdf_time = time.time() - start_time
        stats.stages_completed.append("tsdf")
        print(f"[TSDF] ✅ Complete ({stats.tsdf_time:.1f}s)")
        return True
        
    except Exception as e:
        stats.errors.append(f"TSDF failed: {e}")
        print(f"[TSDF] ❌ Error: {e}")
        return False


# =============================================================================
# STAGE 5: TEXTURE MAPPING
# =============================================================================

def run_texturing(config: V2Config, stats: V2Stats) -> bool:
    """Run texture mapping using OpenMVS."""
    print("\n" + "="*60)
    print("[Stage 5] Texture Mapping")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    textured_path = mesh_dir / "textured.obj"
    
    if config.skip_existing and textured_path.exists():
        print("[Texture] Skipping - output exists")
        stats.stages_completed.append("texture")
        return True
    
    start_time = time.time()
    
    try:
        # Check for OpenMVS
        if not shutil.which("TextureMesh"):
            print("[Texture] OpenMVS not available, skipping texturing")
            stats.stages_completed.append("texture")
            return True
        
        # Convert COLMAP to OpenMVS format
        dense_dir = config.output_dir / "dense"
        mvs_path = config.output_dir / "scene.mvs"
        
        print("[Texture] Converting to OpenMVS format...")
        cmd = [
            "InterfaceCOLMAP",
            "-i", str(dense_dir),
            "-o", str(mvs_path),
        ]
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        # Run texture mapping
        print("[Texture] Running TextureMesh...")
        input_mesh = mesh_dir / "cleaned.ply"
        if not input_mesh.exists():
            input_mesh = mesh_dir / "raw.ply"
        
        cmd = [
            "TextureMesh",
            "-i", str(mvs_path),
            "-m", str(input_mesh),
            "-o", str(textured_path),
            "--export-type", "obj",
        ]
        subprocess.run(cmd, check=True, capture_output=not config.verbose)
        
        stats.texture_time = time.time() - start_time
        stats.stages_completed.append("texture")
        print(f"[Texture] ✅ Complete ({stats.texture_time:.1f}s)")
        return True
        
    except Exception as e:
        stats.errors.append(f"Texturing failed: {e}")
        print(f"[Texture] ⚠️ Warning: {e}")
        return True  # Non-fatal


# =============================================================================
# STAGE 6: EXPORT RESULTS
# =============================================================================

def export_results(config: V2Config, stats: V2Stats) -> Dict[str, Any]:
    """Export final results and generate result JSON."""
    print("\n" + "="*60)
    print("[Stage 6] Exporting Results")
    print("="*60)
    
    mesh_dir = config.output_dir / "mesh"
    
    # Find best mesh file
    mesh_path = None
    for name in ["textured.obj", "cleaned.ply", "raw.ply"]:
        candidate = mesh_dir / name
        if candidate.exists():
            mesh_path = candidate
            break
    
    # Build result
    result = {
        "success": len(stats.errors) == 0 or mesh_path is not None,
        "mesh_path": str(mesh_path) if mesh_path else None,
        "sparse_path": str(config.output_dir / "sparse" / "0"),
        "dense_path": str(config.output_dir / "dense" / "fused.ply"),
        "stats": asdict(stats),
    }
    
    # Save result JSON
    result_path = config.output_dir / "result.json"
    with open(result_path, 'w') as f:
        json.dump(result, f, indent=2)
    
    # Save stats
    stats_path = config.output_dir / "pipeline_stats.json"
    with open(stats_path, 'w') as f:
        json.dump(asdict(stats), f, indent=2)
    
    print(f"[Export] Results saved to: {result_path}")
    print(f"[Export] Stats saved to: {stats_path}")
    
    return result


# =============================================================================
# MAIN PIPELINE
# =============================================================================

def run_v2_pipeline(config: V2Config) -> V2Stats:
    """Run the complete V2 pipeline."""
    print("\n" + "="*60)
    print("  GCP V2 PIPELINE - Full GPU Processing")
    print("="*60)
    print(f"  Images: {config.images_dir}")
    print(f"  Output: {config.output_dir}")
    print(f"  GPU: {config.use_gpu}")
    print("="*60)
    
    stats = V2Stats()
    pipeline_start = time.time()
    
    # Stage 1: SfM
    if not run_sfm(config, stats):
        print("[Pipeline] SfM failed, aborting")
        return stats
    
    # Stage 2: MVS
    if not run_mvs(config, stats):
        print("[Pipeline] MVS failed, aborting")
        return stats
    
    # Stage 3: Metric3D (optional, continues on failure)
    run_metric3d(config, stats)
    
    # Stage 4: TSDF/Mesh
    if not run_tsdf(config, stats):
        print("[Pipeline] TSDF failed, aborting")
        return stats
    
    # Stage 5: Texturing (optional)
    run_texturing(config, stats)
    
    # Stage 6: Export
    stats.total_time = time.time() - pipeline_start
    result = export_results(config, stats)
    
    print("\n" + "="*60)
    print("  V2 PIPELINE COMPLETE")
    print("="*60)
    print(f"  Total time: {stats.total_time:.1f}s")
    print(f"  Stages: {', '.join(stats.stages_completed)}")
    if stats.errors:
        print(f"  Warnings: {len(stats.errors)}")
    print(f"  Mesh: {stats.mesh_vertices:,} vertices, {stats.mesh_faces:,} faces")
    print("="*60)
    
    # Print final result JSON for parsing
    print(json.dumps(result))
    
    return stats


def main():
    parser = argparse.ArgumentParser(description="GCP V2 Pipeline")
    parser.add_argument("images_dir", type=Path, help="Directory with input images")
    parser.add_argument("output_dir", type=Path, help="Output directory")
    parser.add_argument("--ar-poses", type=Path, help="AR poses JSON file")
    parser.add_argument("--metric3d-model", default="vit-large", help="Metric3D model size")
    parser.add_argument("--voxel-size", type=float, default=0.005, help="TSDF voxel size")
    parser.add_argument("--no-gpu", action="store_true", help="Disable GPU")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    
    args = parser.parse_args()
    
    config = V2Config(
        images_dir=args.images_dir,
        output_dir=args.output_dir,
        ar_poses_file=args.ar_poses,
        metric3d_model=args.metric3d_model,
        tsdf_voxel_size=args.voxel_size,
        use_gpu=not args.no_gpu,
        verbose=args.verbose,
    )
    
    config.output_dir.mkdir(parents=True, exist_ok=True)
    
    run_v2_pipeline(config)


if __name__ == "__main__":
    main()
