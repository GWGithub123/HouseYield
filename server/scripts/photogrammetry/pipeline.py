#!/usr/bin/env python3
"""
Photogrammetry Pipeline Orchestrator

Main entry point for the photogrammetry processing pipeline.
Coordinates all processing steps:
1. Feature extraction (SuperPoint)
2. Feature matching
3. Structure from Motion (COLMAP)
4. Dense reconstruction
5. Mesh generation (Poisson)
6. Texture mapping
7. Viewpoint clustering
8. Export (GLB, PLY, OBJ)

Usage:
    python pipeline.py <scan_id> [--options]
"""

import os
import sys
import json
import time
import argparse
import traceback
import numpy as np
from pathlib import Path
from typing import Dict, Any, Optional, List
from dataclasses import dataclass, asdict
from enum import Enum

# Load .env file for GCP_GPU_WORKER_ENABLE and other settings
try:
    from dotenv import load_dotenv
    # pipeline.py is in server/scripts/photogrammetry/, need to go up 4 levels to reach workspace root
    env_path = Path(__file__).parent.parent.parent.parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
        print(f"[Pipeline] Loaded .env: GCP_GPU_WORKER_ENABLE={os.environ.get('GCP_GPU_WORKER_ENABLE', 'not set')}", file=sys.stderr)
    else:
        print(f"[Pipeline] ERROR: .env file not found at {env_path}", file=sys.stderr)
except ImportError as e:
    print(f"[Pipeline] Warning: python-dotenv not installed: {e}", file=sys.stderr)
except Exception as e:
    print(f"[Pipeline] ERROR loading .env: {e}", file=sys.stderr)

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Import pipeline modules
from photogrammetry.sfm import StructureFromMotion, Camera, quaternion_to_rotation_matrix
from photogrammetry.dense_reconstruction import DenseReconstructor
from photogrammetry.mesh_generation import MeshGenerator
from photogrammetry.texture_mapping import TextureMapper
from photogrammetry.viewpoint_clustering import ViewpointClusterer
from photogrammetry.export import MeshExporter


class ProcessingPhase(Enum):
    """Processing phases for status reporting"""
    INITIALIZING = "initializing"
    EXTRACTING_FEATURES = "extracting_features"
    MATCHING_FEATURES = "matching_features"
    SPARSE_RECONSTRUCTION = "sparse_reconstruction"
    DENSE_RECONSTRUCTION = "dense_reconstruction"
    GENERATING_MESH = "generating_mesh"
    TEXTURING = "texturing"
    GENERATING_NAVIGATION = "generating_navigation"
    EXPORTING = "exporting"
    COMPLETE = "complete"
    FAILED = "failed"


@dataclass
class ProcessingOptions:
    """Options for the processing pipeline"""
    # Feature extraction
    feature_type: str = "superpoint"
    max_features: int = 8000  # Increased from 3000 for better matching
    
    # Matching
    matching_strategy: str = "exhaustive"
    ratio_threshold: float = 0.8  # More lenient matching
    
    # Dense reconstruction - COLMAP with GCP GPU for best quality
    dense_method: str = "colmap"  # colmap (CUDA on GCP GPU - best quality), hybrid, depth_ai
    depth_model: str = "depth_anything_v2"  # Neural depth model for AI methods
    depth_prior_source: str = "auto"  # auto prefers Fast3R priors, then falls back to Depth Anything v2
    
    # Mesh generation
    mesh_method: str = "poisson"
    mesh_depth: int = 10
    target_triangles: int = 500000
    
    # Texture
    texture_resolution: int = 4096
    texture_format: str = "jpg"
    
    # Export
    export_formats: List[str] = None
    
    # Navigation
    generate_navigation: bool = True
    cluster_radius: float = 0.5
    
    def __post_init__(self):
        if self.export_formats is None:
            self.export_formats = ["glb"]


@dataclass
class ProcessingProgress:
    """Progress reporting structure"""
    phase: str
    percent: int
    message: str
    start_time: float = 0
    estimated_time_remaining: float = 0


@dataclass
class ProcessingResult:
    """Result of the processing pipeline"""
    success: bool
    scan_id: str
    
    # Timing
    total_time: float = 0
    phase_times: Dict[str, float] = None
    
    # Results
    num_images_registered: int = 0
    num_sparse_points: int = 0
    num_dense_points: int = 0
    num_mesh_vertices: int = 0
    num_mesh_faces: int = 0
    num_viewpoints: int = 0
    
    # Output files
    sparse_cloud_path: str = ""
    dense_cloud_path: str = ""
    mesh_path: str = ""
    texture_path: str = ""
    glb_path: str = ""
    navigation_path: str = ""
    
    # Room dimensions
    room_dimensions: Dict[str, float] = None
    
    # Errors
    error: str = ""
    
    def __post_init__(self):
        if self.phase_times is None:
            self.phase_times = {}
        if self.room_dimensions is None:
            self.room_dimensions = {}


class PhotogrammetryPipeline:
    """Main pipeline orchestrator"""
    
    def __init__(self, data_dir: str, scan_id: str, options: ProcessingOptions = None):
        self.data_dir = Path(data_dir)
        self.scan_id = scan_id
        self.options = options or ProcessingOptions()
        
        # Set up directories
        self.scan_dir = self.data_dir / "photogrammetry" / scan_id
        self.raw_dir = self.scan_dir / "raw"
        self.images_dir = self.raw_dir / "images"
        self.sfm_dir = self.scan_dir / "sfm"
        self.dense_dir = self.scan_dir / "dense"
        self.mesh_dir = self.scan_dir / "mesh"
        self.navigation_dir = self.scan_dir / "navigation"
        self.export_dir = self.scan_dir / "exports"
        
        # Create directories
        for d in [self.sfm_dir, self.dense_dir, self.mesh_dir, 
                  self.navigation_dir, self.export_dir]:
            d.mkdir(parents=True, exist_ok=True)
        
        # Progress tracking
        self.progress = ProcessingProgress(
            phase=ProcessingPhase.INITIALIZING.value,
            percent=0,
            message="Initializing pipeline..."
        )
        self.progress_file = self.scan_dir / "progress.json"
        
        # Result
        self.result = ProcessingResult(success=False, scan_id=scan_id)
        
    def update_progress(self, phase: ProcessingPhase, percent: int, message: str):
        """Update and save progress"""
        self.progress.phase = phase.value
        self.progress.percent = percent
        self.progress.message = message
        
        # Write to file for status polling
        with open(self.progress_file, 'w') as f:
            json.dump(asdict(self.progress), f)
        
        print(f"[Pipeline] [{phase.value}] {percent}% - {message}", file=sys.stderr)
    
    def run(self) -> ProcessingResult:
        """Run the complete pipeline"""
        start_time = time.time()
        
        # Log environment at the very start
        debug_log = self.scan_dir / 'gpu_decision.log'
        with open(debug_log, 'w') as f:
            f.write("=== PIPELINE START ===\n")
            f.write(f"dense_method (from options): {self.options.dense_method}\n")
            f.write(f"GCP_GPU_WORKER_ENABLE (from env): {os.environ.get('GCP_GPU_WORKER_ENABLE', 'NOT SET')}\n")
            f.write(f"Python sys.executable: {sys.executable}\n")
            f.write(f"CWD: {os.getcwd()}\n")
        
        try:
            # Load metadata
            self.update_progress(ProcessingPhase.INITIALIZING, 5, "Loading scan metadata...")
            metadata = self._load_metadata()
            
            if not metadata:
                raise ValueError("No metadata found for scan")
            
            image_files = (
                list(self.images_dir.glob("*.jpg")) +
                list(self.images_dir.glob("*.jpeg")) +
                list(self.images_dir.glob("*.png")) +
                list(self.images_dir.glob("*.JPG")) +
                list(self.images_dir.glob("*.JPEG")) +
                list(self.images_dir.glob("*.PNG"))
            )
            if len(image_files) < 10:
                raise ValueError(f"Insufficient images: {len(image_files)} (minimum 10 required)")
            
            print(f"[Pipeline] Processing {len(image_files)} images", file=sys.stderr)
            
            # Check if we should use full GPU pipeline (COLMAP method + GCP enabled)
            use_full_gpu = (self.options.dense_method == "colmap" and 
                           os.environ.get('GCP_GPU_WORKER_ENABLE', 'false').lower() == 'true')
            
            # Log GPU decision to file for debugging
            debug_log = self.scan_dir / 'gpu_decision.log'
            with open(debug_log, 'w') as f:
                f.write(f"dense_method: {self.options.dense_method}\n")
                f.write(f"GCP_GPU_WORKER_ENABLE: {os.environ.get('GCP_GPU_WORKER_ENABLE', 'NOT SET')}\n")
                f.write(f"use_full_gpu: {use_full_gpu}\n")
            
            if use_full_gpu:
                print("[Pipeline] Using FULL GPU PIPELINE on GCP", file=sys.stderr)
                gpu_start = time.time()
                
                # Run entire COLMAP pipeline on GPU
                self.update_progress(ProcessingPhase.EXTRACTING_FEATURES, 10, "Running full pipeline on GPU...")
                
                try:
                    print("[Pipeline] DEBUG: Importing GcpWorkerClient...", file=sys.stderr, flush=True)
                    with open(debug_log, 'a') as f:
                        f.write("Attempting GCP worker import...\n")
                    
                    from photogrammetry.gcp_worker_client import GcpWorkerClient
                    print("[Pipeline] DEBUG: Creating GcpWorkerClient instance...", file=sys.stderr, flush=True)
                    with open(debug_log, 'a') as f:
                        f.write("Import successful, creating client...\n")
                    
                    gcp_client = GcpWorkerClient()
                    print(f"[Pipeline] DEBUG: Client created, is_available={gcp_client.is_available()}", file=sys.stderr, flush=True)
                    with open(debug_log, 'a') as f:
                        f.write(f"Client created, is_available={gcp_client.is_available()}\n")
                    
                    if gcp_client.is_available():
                        print("[Pipeline] DEBUG: Starting GPU processing...", file=sys.stderr, flush=True)
                        # Full pipeline on GPU
                        gpu_result = gcp_client.process_full_pipeline(
                            self.images_dir,
                            self.dense_dir,
                            quality='high'  # Can make this configurable
                        )
                        
                        # Store results
                        self.result.num_images_registered = len(image_files)  # All images processed
                        self.result.num_sparse_points = gpu_result['num_sparse_points']
                        self.result.sparse_cloud_path = gpu_result['sparse_path']
                        self.result.num_dense_points = gpu_result['num_dense_points']
                        self.result.dense_cloud_path = gpu_result['dense_path']
                        
                        # Check if GPU also produced a textured mesh
                        gpu_textured_mesh_path = gpu_result.get('textured_mesh_path')
                        if gpu_textured_mesh_path:
                            print(f"[Pipeline] GPU produced textured mesh: {gpu_textured_mesh_path}", file=sys.stderr)
                            self.result.mesh_path = gpu_textured_mesh_path
                            # Find texture file next to the OBJ
                            import glob
                            texture_files = glob.glob(str(Path(gpu_textured_mesh_path).parent / '*.png')) + \
                                          glob.glob(str(Path(gpu_textured_mesh_path).parent / '*.jpg'))
                            if texture_files:
                                self.result.texture_path = texture_files[0]
                                print(f"[Pipeline] GPU texture: {self.result.texture_path}", file=sys.stderr)
                        
                        # Time tracking (grouped since it all happens on GPU)
                        gpu_total_time = time.time() - gpu_start
                        self.result.phase_times['gpu_pipeline'] = gpu_total_time
                        self.result.phase_times['feature_extraction'] = gpu_total_time * 0.15
                        self.result.phase_times['feature_matching'] = gpu_total_time * 0.15  
                        self.result.phase_times['sfm'] = gpu_total_time * 0.20
                        self.result.phase_times['dense_reconstruction'] = gpu_total_time * 0.50
                        
                        print(f"[Pipeline] GPU pipeline complete in {gpu_total_time:.1f}s", file=sys.stderr)
                        
                        # Parse camera poses from COLMAP sparse model
                        print("[Pipeline] Parsing camera poses from sparse model...", file=sys.stderr)
                        cameras = self._parse_colmap_cameras(Path(gpu_result['sparse_model_dir']))
                        print(f"[Pipeline] Parsed {len(cameras)} camera poses", file=sys.stderr)
                        
                        # Set sfm_result and dense_result for downstream phases
                        sfm_result = {
                            'cameras': cameras,
                            'num_points': gpu_result['num_sparse_points'],
                            'colmap_dir': Path(gpu_result['sparse_model_dir']).parent.parent
                        }
                        dense_result = {'points_path': gpu_result['dense_path']}
                        
                    else:
                        print("[Pipeline] GCP not available, falling back to local processing", file=sys.stderr)
                        with open(debug_log, 'a') as f:
                            f.write("Client.is_available() returned False\n")
                        use_full_gpu = False
                        
                except Exception as e:
                    print(f"[Pipeline] GPU pipeline failed: {e}, falling back to local", file=sys.stderr)
                    with open(debug_log, 'a') as f:
                        f.write(f"EXCEPTION: {e}\n")
                        f.write(f"Traceback:\n{traceback.format_exc()}\n")
                    use_full_gpu = False
            
            if not use_full_gpu:
                # Original local pipeline
                sfm = StructureFromMotion(
                    images_dir=self.images_dir,
                    output_dir=self.sfm_dir,
                    camera_params=metadata.get('camera_intrinsics'),
                    feature_type=self.options.feature_type,
                    max_features=self.options.max_features,
                )

                if not sfm.manages_sparse_pipeline():
                    raise RuntimeError('legacy_photogrammetry_requires_hloc_superpoint_lightglue_stack')

                phase_start = time.time()
                self.update_progress(ProcessingPhase.EXTRACTING_FEATURES, 10, "Delegating sparse feature extraction to HLOC SuperPoint...")
                features = {}
                self.result.phase_times['feature_extraction'] = time.time() - phase_start

                phase_start = time.time()
                self.update_progress(ProcessingPhase.MATCHING_FEATURES, 20, "Delegating sparse feature matching to LightGlue...")
                matches = {}
                self.result.phase_times['feature_matching'] = time.time() - phase_start

                # Phase 3: Structure from Motion
                phase_start = time.time()
                self.update_progress(ProcessingPhase.SPARSE_RECONSTRUCTION, 35, "Running Structure from Motion...")

                sfm_result = sfm.run(features, matches, metadata.get('imu_data', {}))
                
                self.result.num_images_registered = sfm_result['num_registered']
                self.result.num_sparse_points = sfm_result['num_points']
                self.result.sparse_cloud_path = str(sfm_result['points_path'])
                
                self.result.phase_times['sfm'] = time.time() - phase_start
                
                # Phase 4: Dense reconstruction
                phase_start = time.time()
                self.update_progress(ProcessingPhase.DENSE_RECONSTRUCTION, 50, "Generating dense point cloud...")
                
                dense = DenseReconstructor(
                    method=self.options.dense_method,
                    depth_model=self.options.depth_model,
                    depth_prior_source=self.options.depth_prior_source,
                    colmap_path='colmap'  # Use system COLMAP
                )
                dense_result = dense.run(
                    images_dir=self.images_dir,
                    sfm_result=sfm_result,
                    output_dir=self.dense_dir
                )
                
                self.result.num_dense_points = dense_result['num_points']
                self.result.dense_cloud_path = str(dense_result['points_path'])
                
                self.result.phase_times['dense_reconstruction'] = time.time() - phase_start
                
                # Phase 5: Mesh generation
                phase_start = time.time()
                self.update_progress(ProcessingPhase.GENERATING_MESH, 65, "Generating mesh surface...")
                
                mesh_gen = MeshGenerator(
                    method=self.options.mesh_method,
                    depth=self.options.mesh_depth,
                    target_triangles=self.options.target_triangles
                )
                mesh_result = mesh_gen.run(
                    point_cloud_path=dense_result['points_path'],
                    output_dir=self.mesh_dir
                )
            
            # --- Continue with mesh generation for GPU path or proceed from local ---
            # At this point, both paths have: sfm_result, dense_result
            # Check if GPU already produced a textured mesh
            gpu_has_textured_mesh = (use_full_gpu and 
                                     self.result.mesh_path and 
                                     self.result.texture_path)
            
            if gpu_has_textured_mesh:
                print("[Pipeline] Using textured mesh from GPU pipeline", file=sys.stderr)
                # Set mesh_result for downstream phases
                mesh_result = {
                    'mesh_path': Path(self.result.mesh_path),
                    'num_vertices': 0,  # Not available from GPU result
                    'num_faces': 0,
                    'dimensions': {}
                }
                texture_result = {'texture_path': Path(self.result.texture_path)}
                self.result.phase_times['mesh_generation'] = 0
                self.result.phase_times['texturing'] = 0
            else:
                # GPU path needs local mesh generation
                if use_full_gpu:
                    phase_start = time.time()
                    self.update_progress(ProcessingPhase.GENERATING_MESH, 65, "Generating mesh surface...")
                    
                    mesh_gen = MeshGenerator(
                        method=self.options.mesh_method,
                        depth=self.options.mesh_depth,
                        target_triangles=self.options.target_triangles
                    )
                    mesh_result = mesh_gen.run(
                        point_cloud_path=dense_result['points_path'],
                        output_dir=self.mesh_dir
                    )
                
                self.result.num_mesh_vertices = mesh_result['num_vertices']
                self.result.num_mesh_faces = mesh_result['num_faces']
                self.result.mesh_path = str(mesh_result['mesh_path'])
                self.result.room_dimensions = mesh_result.get('dimensions', {})
                
                self.result.phase_times['mesh_generation'] = time.time() - phase_start
                
                # Phase 6: Texture mapping
                phase_start = time.time()
                self.update_progress(ProcessingPhase.TEXTURING, 75, "Mapping textures...")
                
                texture_mapper = TextureMapper(
                    resolution=self.options.texture_resolution,
                    format=self.options.texture_format
                )
                
                # OpenMVS needs the image_undistorter workspace root with
                # sibling images/ and sparse/ directories, not only sfm/sparse/0.
                cameras_for_texture = sfm_result['cameras'].copy() if isinstance(sfm_result['cameras'], dict) else {}
                dense_workspace_dir = dense_result.get('workspace_path') if isinstance(dense_result, dict) else None
                if dense_workspace_dir:
                    cameras_for_texture['colmap_workspace_dir'] = str(dense_workspace_dir)
                cameras_for_texture['colmap_dir'] = str(sfm_result.get('colmap_dir', ''))
                
                texture_result = texture_mapper.run(
                    mesh_path=mesh_result['mesh_path'],
                    images_dir=self.images_dir,
                    cameras=cameras_for_texture,
                    output_dir=self.mesh_dir
                )
                
                self.result.texture_path = str(texture_result['texture_path'])
                
                self.result.phase_times['texturing'] = time.time() - phase_start
            
            # Phase 7: Viewpoint clustering
            if self.options.generate_navigation:
                phase_start = time.time()
                self.update_progress(ProcessingPhase.GENERATING_NAVIGATION, 85, "Generating navigation...")
                
                clusterer = ViewpointClusterer(
                    cluster_radius=self.options.cluster_radius
                )
                nav_result = clusterer.run(
                    cameras=sfm_result['cameras'],
                    mesh_path=mesh_result['mesh_path'],
                    output_dir=self.navigation_dir
                )
                
                self.result.num_viewpoints = nav_result['num_viewpoints']
                self.result.navigation_path = str(nav_result['navigation_path'])
                
                self.result.phase_times['navigation'] = time.time() - phase_start
            
            # Phase 8: Export
            phase_start = time.time()
            self.update_progress(ProcessingPhase.EXPORTING, 92, "Exporting formats...")
            
            exporter = MeshExporter()
            export_result = exporter.export_all(
                mesh_path=mesh_result['mesh_path'],
                texture_path=texture_result['texture_path'],
                formats=self.options.export_formats,
                output_dir=self.export_dir
            )
            
            if 'glb' in export_result:
                self.result.glb_path = str(export_result['glb'])
            
            self.result.phase_times['export'] = time.time() - phase_start
            
            # Complete
            self.result.success = True
            self.result.total_time = time.time() - start_time
            
            self.update_progress(ProcessingPhase.COMPLETE, 100, "Processing complete!")
            
            # Save final result
            self._save_result()
            
            return self.result
            
        except Exception as e:
            self.result.success = False
            self.result.error = str(e)
            self.result.total_time = time.time() - start_time
            
            self.update_progress(ProcessingPhase.FAILED, 0, f"Error: {str(e)}")
            
            print(f"[Pipeline] ERROR: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            
            self._save_result()
            
            return self.result
    
    def _load_metadata(self) -> Optional[Dict[str, Any]]:
        """Load scan metadata"""
        metadata_path = self.raw_dir / "metadata.json"
        
        if not metadata_path.exists():
            print(f"[Pipeline] Warning: No metadata.json found", file=sys.stderr)
            return {}
        
        with open(metadata_path, 'r') as f:
            return json.load(f)
    
    def _save_result(self):
        """Save processing result"""
        result_path = self.scan_dir / "result.json"
        
        with open(result_path, 'w') as f:
            json.dump(asdict(self.result), f, indent=2)
    
    def _parse_colmap_cameras(self, sparse_model_dir: Path) -> Dict[str, Any]:
        """
        Parse camera poses from COLMAP sparse model directory.
        
        Args:
            sparse_model_dir: Path to COLMAP sparse model (e.g., sparse/0/)
        
        Returns:
            Dict mapping image names to camera objects with rotation/translation
        """
        import subprocess
        
        sparse_model_dir = Path(sparse_model_dir)
        cameras = {}
        
        # Convert binary COLMAP model to text format for parsing
        text_dir = self.sfm_dir / "sparse_text"
        text_dir.mkdir(exist_ok=True)
        
        try:
            subprocess.run([
                'colmap', 'model_converter',
                '--input_path', str(sparse_model_dir),
                '--output_path', str(text_dir),
                '--output_type', 'TXT',
            ], check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            print(f"[Pipeline] Warning: Could not convert COLMAP model: {e}", file=sys.stderr)
            return {}
        
        # Parse images.txt for camera poses
        images_txt = text_dir / "images.txt"
        if not images_txt.exists():
            print(f"[Pipeline] Warning: images.txt not found", file=sys.stderr)
            return {}
        
        with open(images_txt) as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith('#')]
        
        i = 0
        while i < len(lines):
            parts = lines[i].split()
            if len(parts) < 10:
                i += 1
                continue
            
            image_name = parts[9]  # Image filename
            image_id = Path(image_name).stem
            
            qw, qx, qy, qz = map(float, parts[1:5])
            tx, ty, tz = map(float, parts[5:8])
            
            quaternion = np.array([qw, qx, qy, qz])
            rotation = quaternion_to_rotation_matrix(quaternion)
            translation = np.array([tx, ty, tz])
            
            cameras[image_id] = Camera(
                image_id=image_id,
                image_path=str(self.images_dir / image_name),
                width=0, height=0,  # Filled from camera model if needed
                fx=0, fy=0, cx=0, cy=0,
                rotation=rotation,
                translation=translation,
                quaternion=quaternion,
            )
            
            i += 2  # Skip the points line
        
        return cameras


def main():
    parser = argparse.ArgumentParser(description='Photogrammetry Processing Pipeline')
    parser.add_argument('scan_id', help='Scan ID to process')
    parser.add_argument('--data-dir', default='./data', help='Data directory')
    parser.add_argument('--feature-type', default='superpoint', choices=['superpoint'])
    parser.add_argument('--max-features', type=int, default=3000)
    parser.add_argument('--dense-method', default='colmap', choices=['colmap', 'depth_ai', 'hybrid'])
    parser.add_argument('--depth-prior-source', default='auto', choices=['auto', 'fast3r', 'metric3d', 'depth_anything_v2', 'none'])
    parser.add_argument('--mesh-method', default='poisson', choices=['poisson', 'ball_pivoting'])
    parser.add_argument('--mesh-depth', type=int, default=10)
    parser.add_argument('--target-triangles', type=int, default=500000)
    parser.add_argument('--texture-resolution', type=int, default=4096)
    parser.add_argument('--export-formats', nargs='+', default=['glb'])
    parser.add_argument('--cluster-radius', type=float, default=0.5)
    parser.add_argument('--no-navigation', action='store_true')
    
    args = parser.parse_args()
    
    options = ProcessingOptions(
        feature_type=args.feature_type,
        max_features=args.max_features,
        dense_method=args.dense_method,
        depth_prior_source=args.depth_prior_source,
        mesh_method=args.mesh_method,
        mesh_depth=args.mesh_depth,
        target_triangles=args.target_triangles,
        texture_resolution=args.texture_resolution,
        export_formats=args.export_formats,
        generate_navigation=not args.no_navigation,
        cluster_radius=args.cluster_radius,
    )
    
    pipeline = PhotogrammetryPipeline(
        data_dir=args.data_dir,
        scan_id=args.scan_id,
        options=options
    )
    
    result = pipeline.run()
    
    # Output result as JSON
    print(json.dumps(asdict(result), indent=2))
    
    sys.exit(0 if result.success else 1)


if __name__ == "__main__":
    main()
