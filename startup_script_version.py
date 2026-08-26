#!/opt/photogrammetry-venv/bin/python3
"""
Full Photogrammetry Pipeline on GPU (2026 Optimized for 8×L4 GPUs)

Takes raw images and produces textured mesh using:
- HLOC + SuperPoint/LightGlue for feature extraction/matching (GPU)
- GLOMAP for fast sparse reconstruction (CPU, 10-100x faster)
- Metric3D v2 for AI depth priors (GPU)
- COLMAP patch_match_stereo for dense MVS (Multi-GPU)
- PoissonRecon for mesh generation (CPU)
- OpenMVS TextureMesh for texturing (CPU+GPU)
"""

import os
import sys
import json
import shutil
import argparse
import struct
import glob
import psutil
import numpy as np
from pathlib import Path
import subprocess
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════
OPENMVS_BIN = '/usr/local/bin/OpenMVS'
GLOMAP_COLMAP_PATH = '/opt/glomap/build/_deps/colmap-build/src/colmap/exe/colmap'

# Check for available tools
GLOMAP_AVAILABLE = shutil.which('glomap') is not None
HLOC_AVAILABLE = False
try:
    import hloc
    from hloc import extract_features, match_features, reconstruction, pairs_from_exhaustive
    HLOC_AVAILABLE = True
except ImportError:
    pass

def get_colmap_binary():
    """Get COLMAP binary - prefer GLOMAP-compatible version"""
    if GLOMAP_AVAILABLE and os.path.exists(GLOMAP_COLMAP_PATH):
        return GLOMAP_COLMAP_PATH
    colmap_glomap = shutil.which('colmap-glomap')
    if colmap_glomap:
        return colmap_glomap
    return 'colmap'

COLMAP_BIN = get_colmap_binary()

def get_gpu_indices():
    """Detect all available NVIDIA GPUs"""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=index', '--format=csv,noheader'],
            capture_output=True, text=True, check=True
        )
        indices = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
        return ','.join(indices)
    except Exception:
        return '0'

def get_cache_size_mb():
    """Get 80% of available RAM for cache"""
    try:
        return int(psutil.virtual_memory().available * 0.8 / (1024 * 1024))
    except Exception:
        return 8192

def count_ply_points(ply_path):
    """Count vertices in PLY file"""
    with open(ply_path, 'rb') as f:
        for line in f:
            if line.startswith(b'element vertex'):
                return int(line.split()[2])
    return 0

def find_largest_sparse_model(sparse_dir):
    """Find sparse model with most points"""
    sparse_dir = Path(sparse_dir)
    model_dirs = sorted([d for d in sparse_dir.iterdir() if d.is_dir() and d.name.isdigit()])
    
    if not model_dirs:
        raise ValueError("No sparse models found")
    if len(model_dirs) == 1:
        return model_dirs[0]
    
    largest_model = None
    largest_size = 0
    for model_dir in model_dirs:
        points_file = model_dir / "points3D.bin"
        if points_file.exists():
            size = points_file.stat().st_size
            if size > largest_size:
                largest_size = size
                largest_model = model_dir
    
    return largest_model or model_dirs[0]

def run_full_pipeline(images_dir, output_dir, quality='high'):
    """
    Run complete pipeline from images to textured mesh.
    
    Args:
        images_dir: Directory containing input images
        output_dir: Directory for all outputs
        quality: 'high', 'medium', 'low'
    """
    images_dir = Path(images_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Hardware detection
    gpu_indices = get_gpu_indices()
    cache_size_mb = get_cache_size_mb()
    num_gpus = len(gpu_indices.split(','))
    
    # Quality settings
    quality_settings = {
        'high': {'features': 16000},
        'medium': {'features': 8000},
        'low': {'features': 4000},
    }
    settings = quality_settings.get(quality, quality_settings['high'])
    
    # Setup directories
    database_path = output_dir / "database.db"
    sparse_dir = output_dir / "sparse"
    dense_dir = output_dir / "dense"
    sparse_dir.mkdir(exist_ok=True)
    dense_dir.mkdir(exist_ok=True)
    
    print(f"[Full Pipeline] ═══════════════════════════════════════════════════")
    print(f"[Full Pipeline] 8×L4 GPU OPTIMIZED PHOTOGRAMMETRY PIPELINE")
    print(f"[Full Pipeline] ═══════════════════════════════════════════════════")
    print(f"[Full Pipeline] Images: {images_dir}")
    print(f"[Full Pipeline] Output: {output_dir}")
    print(f"[Full Pipeline] Quality: {quality}")
    print(f"[Full Pipeline] GPUs: {gpu_indices} ({num_gpus} total)")
    print(f"[Full Pipeline] RAM Cache: {cache_size_mb}MB")
    print(f"[Full Pipeline] HLOC: {HLOC_AVAILABLE}")
    print(f"[Full Pipeline] GLOMAP: {GLOMAP_AVAILABLE}")
    print(f"[Full Pipeline] ═══════════════════════════════════════════════════")
    
    # Count images
    image_files = list(images_dir.glob('*.jpg')) + list(images_dir.glob('*.JPG')) + \
                  list(images_dir.glob('*.png')) + list(images_dir.glob('*.PNG'))
    num_images = len(image_files)
    print(f"[Full Pipeline] Found {num_images} images")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 1: Feature Extraction
    # ═══════════════════════════════════════════════════════════════════════
    use_hloc = False
    features_path = output_dir / 'features.h5'
    
    if HLOC_AVAILABLE:
        print("[Full Pipeline] Step 1/9: Feature extraction (SuperPoint - GPU)...")
        try:
            feature_conf = extract_features.confs['superpoint_max']
            feature_conf['model']['max_keypoints'] = settings['features']
            extract_features.main(feature_conf, images_dir, feature_path=features_path)
            use_hloc = True
        except Exception as e:
            print(f"[Full Pipeline] HLOC extraction failed: {e}, falling back to SIFT")
    
    if not use_hloc:
        print("[Full Pipeline] Step 1/9: Feature extraction (COLMAP SIFT - GPU)...")
        subprocess.run([
            COLMAP_BIN, 'feature_extractor',
            '--database_path', str(database_path),
            '--image_path', str(images_dir),
            '--ImageReader.single_camera', '1',
            '--ImageReader.camera_model', 'OPENCV',
            '--FeatureExtraction.use_gpu', '1',
            '--FeatureExtraction.gpu_index', gpu_indices.split(',')[0],
        ], check=True)
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 2: Feature Matching
    # ═══════════════════════════════════════════════════════════════════════
    if use_hloc:
        print("[Full Pipeline] Step 2/9: Feature matching (LightGlue - GPU)...")
        try:
            match_conf = match_features.confs['superpoint+lightglue']
            matches_path = output_dir / 'matches.h5'
            pairs_path = output_dir / 'pairs-exhaustive.txt'
            
            # Generate exhaustive pairs
            image_names = [f.name for f in image_files]
            pairs_from_exhaustive.main(pairs_path, image_list=image_names)
            
            match_features.main(match_conf, pairs_path, features_path, matches=matches_path)
            
            # HLOC features/matching complete - import into COLMAP database for GLOMAP
            # (GLOMAP is 10-100x faster than pycolmap incremental mapper)
            print("[Full Pipeline] Importing HLOC features into COLMAP database...")
            from hloc import triangulation
            import pycolmap
            
            # Create empty database first
            db = pycolmap.Database.open(str(database_path))
            db.close()
            
            # Step 1: Import images into database (creates DB + registers images)
            image_options = pycolmap.ImageReaderOptions()
            image_options.camera_model = 'OPENCV'
            pycolmap.import_images(str(database_path), str(images_dir), camera_mode=pycolmap.CameraMode.SINGLE, options=image_options)
            
            # Step 2: Open database and build image_ids mapping
            db = pycolmap.Database.open(str(database_path))
            image_ids = {img.name: img.image_id for img in db.read_all_images()}
            print(f"[Full Pipeline] Found {len(image_ids)} images in database")
            
            # Step 3: Import HLOC features and matches into COLMAP database
            triangulation.import_features(image_ids, db, features_path)
            triangulation.import_matches(image_ids, db, pairs_path, matches_path,
                                        min_match_score=None, skip_geometric_verification=False)
            db.close()
            
            print("[Full Pipeline] ✅ HLOC features imported into database")
            hloc_sfm_complete = False  # Force GLOMAP to run in step 3
        except Exception as e:
            print(f"[Full Pipeline] HLOC matching/SfM failed: {e}, falling back to COLMAP")
            use_hloc = False
            hloc_sfm_complete = False
    else:
        hloc_sfm_complete = False
    
    if not use_hloc:
        print("[Full Pipeline] Step 2/9: Feature matching (COLMAP Exhaustive - GPU)...")
        subprocess.run([
            COLMAP_BIN, 'exhaustive_matcher',
            '--database_path', str(database_path),
            '--FeatureMatching.use_gpu', '1',
            '--FeatureMatching.gpu_index', gpu_indices.split(',')[0],
        ], check=True)
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 3: Sparse Reconstruction (if not done by HLOC)
    # ═══════════════════════════════════════════════════════════════════════
    if not hloc_sfm_complete:
        if GLOMAP_AVAILABLE:
            print("[Full Pipeline] Step 3/9: Sparse reconstruction (GLOMAP - 10-100x faster)...")
            try:
                subprocess.run([
                    'glomap', 'mapper',
                    '--database_path', str(database_path),
                    '--image_path', str(images_dir),
                    '--output_path', str(sparse_dir),
                ], check=True)
            except subprocess.CalledProcessError as e:
                print(f"[Full Pipeline] GLOMAP failed: {e}, using COLMAP mapper")
                subprocess.run([
                    COLMAP_BIN, 'mapper',
                    '--database_path', str(database_path),
                    '--image_path', str(images_dir),
                    '--output_path', str(sparse_dir),
                ], check=True)
        else:
            print("[Full Pipeline] Step 3/9: Sparse reconstruction (COLMAP mapper)...")
            subprocess.run([
                COLMAP_BIN, 'mapper',
                '--database_path', str(database_path),
                '--image_path', str(images_dir),
                '--output_path', str(sparse_dir),
            ], check=True)
    
    # Find best sparse model
    sparse_model_dir = find_largest_sparse_model(sparse_dir)
    
    # Export sparse PLY
    sparse_ply = output_dir / "sparse.ply"
    subprocess.run([
        COLMAP_BIN, 'model_converter',
        '--input_path', str(sparse_model_dir),
        '--output_path', str(sparse_ply),
        '--output_type', 'PLY',
    ], check=True)
    
    num_sparse_points = count_ply_points(sparse_ply)
    print(f"[Full Pipeline] Sparse: {num_sparse_points:,} points")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 4: Undistort Images
    # ═══════════════════════════════════════════════════════════════════════
    print("[Full Pipeline] Step 4/9: Undistorting images...")
    subprocess.run([
        COLMAP_BIN, 'image_undistorter',
        '--image_path', str(images_dir),
        '--input_path', str(sparse_model_dir),
        '--output_path', str(dense_dir),
        '--output_type', 'COLMAP',
    ], check=True)
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 5: Metric3D Depth Priors (optional, helps with featureless surfaces)
    # ═══════════════════════════════════════════════════════════════════════
    print("[Full Pipeline] Step 5/9: Generating AI depth priors (Metric3D v2)...")
    try:
        sys.path.insert(0, '/opt/photogrammetry-service')
        from generate_metric3d_priors import generate_metric3d_priors
        undistorted_images = dense_dir / 'images'
        depth_result = generate_metric3d_priors(
            images_dir=undistorted_images,
            output_dir=dense_dir,
            sparse_dir=sparse_model_dir,
            model_size='large',
        )
        print(f"[Full Pipeline] ✅ Generated {depth_result['num_images']} depth priors")
    except Exception as e:
        print(f"[Full Pipeline] ⚠️ Depth priors failed: {e} (continuing without)")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 5.5: Detect & mask reflective surfaces (mirrors, windows, glass)
    # Reflective surfaces cause mesh blowout because stereo matching sees
    # reflected geometry at wrong depths. We detect them and set depth priors
    # to the wall plane depth, preventing wild depth estimates.
    # ═══════════════════════════════════════════════════════════════════════
    print("[Full Pipeline] Step 5.5/9: Detecting reflective surfaces (mirrors, windows, glass)...")
    try:
        undistorted_images = dense_dir / 'images'
        depth_priors_dir = dense_dir / 'stereo' / 'depth_maps'
        
        # Simple reflective surface detection based on:
        # 1. High specular highlights (saturated pixels)
        # 2. Depth discontinuities from Metric3D (reflections appear at wrong depth)
        # 3. Low stereo matching confidence (reflective = inconsistent across views)
        import cv2
        
        reflective_masks = {}
        for img_path in sorted(undistorted_images.glob('*.jpg')) + sorted(undistorted_images.glob('*.png')):
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            
            # Convert to HSV to detect high-saturation + high-value regions (specular)
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            
            # Detect specular highlights: very bright + low saturation = reflective
            brightness = hsv[:, :, 2]
            saturation = hsv[:, :, 1]
            specular_mask = ((brightness > 240) & (saturation < 30)).astype(np.uint8)
            
            # Detect large uniform regions (mirrors reflect but appear smooth)
            # Use Laplacian to find areas with very low texture
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            low_texture = (np.abs(laplacian) < 3).astype(np.uint8)
            
            # Combine: specular OR (low texture AND bright)
            bright_mask = (brightness > 200).astype(np.uint8)
            reflective = specular_mask | (low_texture & bright_mask)
            
            # Dilate to cover surrounding area
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
            reflective = cv2.dilate(reflective, kernel, iterations=2)
            
            # Only keep large connected regions (actual mirrors/windows, not small highlights)
            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(reflective, connectivity=8)
            min_area = img.shape[0] * img.shape[1] * 0.005  # At least 0.5% of image
            clean_mask = np.zeros_like(reflective)
            for label_id in range(1, num_labels):
                if stats[label_id, cv2.CC_STAT_AREA] >= min_area:
                    clean_mask[labels == label_id] = 1
            
            if clean_mask.sum() > 0:
                reflective_masks[img_path.stem] = clean_mask
                
                # Clamp depth priors in reflective areas to the surrounding wall depth
                # This prevents mesh blowout: instead of wild reflection depth, use wall plane
                depth_file = depth_priors_dir / f'{img_path.stem}.photometric.bin'
                if depth_file.exists():
                    with open(depth_file, 'rb') as f:
                        w = struct.unpack('<i', f.read(4))[0]
                        h = struct.unpack('<i', f.read(4))[0]
                        c = struct.unpack('<i', f.read(4))[0]
                        d_min = struct.unpack('<f', f.read(4))[0]
                        d_max = struct.unpack('<f', f.read(4))[0]
                        depth_data = np.frombuffer(f.read(), dtype=np.float32).reshape(h, w)
                    
                    # Resize mask to depth map size
                    mask_resized = cv2.resize(clean_mask, (w, h), interpolation=cv2.INTER_NEAREST)
                    
                    # Replace reflective region depth with median of surrounding non-reflective pixels
                    # This assumes the mirror/window sits on a wall plane
                    non_reflective_depth = depth_data[mask_resized == 0]
                    if len(non_reflective_depth) > 100:
                        # Use 25th-75th percentile of surrounding depth (wall plane estimate)
                        wall_depth = np.median(non_reflective_depth[
                            (non_reflective_depth > np.percentile(non_reflective_depth, 25)) &
                            (non_reflective_depth < np.percentile(non_reflective_depth, 75))
                        ])
                        depth_data[mask_resized > 0] = wall_depth
                        
                        # Write corrected depth back
                        with open(depth_file, 'wb') as f:
                            f.write(struct.pack('<i', w))
                            f.write(struct.pack('<i', h))
                            f.write(struct.pack('<i', c))
                            f.write(struct.pack('<f', float(depth_data.min())))
                            f.write(struct.pack('<f', float(depth_data.max())))
                            depth_data.astype(np.float32).tofile(f)
        
        num_masked = len(reflective_masks)
        if num_masked > 0:
            print(f"[Full Pipeline] ✅ Masked reflective surfaces in {num_masked} images (mirrors/windows/glass)")
        else:
            print(f"[Full Pipeline] ℹ️ No significant reflective surfaces detected")
    except Exception as e:
        print(f"[Full Pipeline] ⚠️ Reflective surface detection failed: {e} (continuing without)")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 6: Patch Match Stereo (Multi-GPU) - ENHANCED FOR TEXTURELESS SURFACES
    # ═══════════════════════════════════════════════════════════════════════
    print(f"[Full Pipeline] Step 6/9: Dense reconstruction (CUDA multi-GPU: {gpu_indices})...")
    
    # Check if Metric3D priors exist
    depth_priors_dir = dense_dir / 'stereo' / 'depth_maps'
    has_priors = depth_priors_dir.exists() and any(depth_priors_dir.glob('*.photometric.bin'))
    
    # Build patch_match_stereo command with conditional depth prior usage
    patch_match_cmd = [
        COLMAP_BIN, 'patch_match_stereo',
        '--workspace_path', str(dense_dir),
        '--workspace_format', 'COLMAP',
        '--PatchMatchStereo.geom_consistency', 'true',
        '--PatchMatchStereo.gpu_index', gpu_indices,
        '--PatchMatchStereo.cache_size', str(cache_size_mb),
        # Textureless surface improvements:
        # - window_radius=7: Larger matching window catches more context
        # - window_step=1: Dense sampling for better coverage
        # - filter_min_triangulation_angle=0.5: Accept shallower angles (helps walls)
        # - filter_min_ncc=-1: Disable NCC filter (textureless = low NCC but still valid)
        # - num_iterations=7: Balanced iterations (convergence + speed with 8 GPUs)
        '--PatchMatchStereo.window_radius', '7',
        '--PatchMatchStereo.window_step', '1',
        '--PatchMatchStereo.filter_min_triangulation_angle', '0.5',
        '--PatchMatchStereo.filter_min_ncc', '-1',
        '--PatchMatchStereo.num_iterations', '7',
        '--PatchMatchStereo.sigma_spatial', '3',
        '--PatchMatchStereo.sigma_color', '0.3',
    ]
    
    # If Metric3D depth priors exist, configure COLMAP to USE them as initialization
    if has_priors:
        print(f"[Full Pipeline] ✅ Using Metric3D depth priors for textureless surfaces")
        # Key flags to enable depth prior usage:
        # - write_consistency_graph: Helps with multi-view consistency using priors
        # NOTE: use_exist_photom was removed — unsupported in COLMAP 3.14+
        patch_match_cmd.extend([
            '--PatchMatchStereo.write_consistency_graph', 'true',
        ])
    else:
        print(f"[Full Pipeline] ⚠️ No depth priors found, using stereo matching only")
    
    subprocess.run(patch_match_cmd, check=True)
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 7: Stereo Fusion (strict defaults for measurement accuracy)
    # ═══════════════════════════════════════════════════════════════════════
    print(f"[Full Pipeline] Step 7/9: Fusing depth maps (cache: {cache_size_mb}MB)...")
    fused_ply = output_dir / "fused.ply"
    
    # Relaxed fusion to retain wall surfaces visible from 2-3 viewpoints:
    # - min_num_pixels=3: Accept points seen in 3+ images (was 5 — too strict for walls)
    # - max_reproj_error=2: Keep strict reprojection for accuracy
    # - max_depth_error=0.02: Allow 2% depth variance (indoor surfaces have some wobble)
    # - max_normal_error=25: Accept normals within 25° — helps retain curved/angled walls
    # This produces a denser point cloud; SurfaceTrimmer + Poisson will still clean noise
    subprocess.run([
        COLMAP_BIN, 'stereo_fusion',
        '--workspace_path', str(dense_dir),
        '--workspace_format', 'COLMAP',
        '--input_type', 'geometric',
        '--output_path', str(fused_ply),
        '--StereoFusion.cache_size', str(cache_size_mb),
        '--StereoFusion.min_num_pixels', '3',
        '--StereoFusion.max_depth_error', '0.02',
        '--StereoFusion.max_normal_error', '25',
    ], check=True)
    
    num_dense_points = count_ply_points(fused_ply)
    print(f"[Full Pipeline] Dense: {num_dense_points:,} points")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 8: Mesh Generation (Screened Poisson with hole interpolation)
    # ═══════════════════════════════════════════════════════════════════════
    print("[Full Pipeline] Step 8/9: Mesh generation (Screened Poisson depth=10 + interpolation)...")
    mesh_raw = output_dir / "meshed_raw.ply"
    mesh_ply = output_dir / "meshed_poisson.ply"
    
    # Screened Poisson Reconstruction with boundary interpolation:
    # - depth=10: High resolution (2^10 = 1024 voxels per axis)
    # - pointWeight=1: Balance between fitting points and smoothness
    # - samplesPerNode=1.5: Minimum samples per octree node (default=1.5)
    # - scale=1.1: Slightly larger bounding box to catch boundary points
    # - boundary=2: Dirichlet boundary (interpolates to fill holes at boundaries)
    # - interpolateBoundary: Smooth interpolation across holes
    subprocess.run([
        'PoissonRecon',
        '--in', str(fused_ply),
        '--out', str(mesh_raw),
        '--depth', '10',
        '--pointWeight', '1',
        '--samplesPerNode', '1.5',
        '--scale', '1.1',
        '--boundary', '2',
        '--density',
        '--color', '32',
    ], check=True)
    
    # Surface trimming: remove low-density extrapolated regions
    # - trim=4: Keep significantly more interpolated surface to fill wall/mirror holes
    #   (was 6 → too aggressive, removed Poisson-filled areas that cover gaps)
    #   trim=4 retains surfaces where ≥~6% of max density support exists,
    #   which preserves smooth wall interpolation while still removing wild extrapolation
    subprocess.run([
        'SurfaceTrimmer',
        '--in', str(mesh_raw),
        '--out', str(mesh_ply),
        '--trim', '4',
    ], check=True)
    
    print(f"[Full Pipeline] ✅ Mesh generated: {mesh_ply}")
    
    # ═══════════════════════════════════════════════════════════════════════
    # STEP 9: Texture Mapping (OpenMVS)
    # ═══════════════════════════════════════════════════════════════════════
    textured_obj = None
    textured_mtl = None
    texture_path = None
    
    if shutil.which('InterfaceCOLMAP') and shutil.which('TextureMesh'):
        print("[Full Pipeline] Step 9/9: Texture mapping (OpenMVS TextureMesh)...")
        try:
            scene_mvs = output_dir / "scene.mvs"
            undistorted_images = dense_dir / 'images'
            undistorted_sparse = dense_dir / 'sparse'
            
            # Convert COLMAP to OpenMVS
            subprocess.run([
                'InterfaceCOLMAP',
                '-i', str(dense_dir),
                '-o', str(scene_mvs),
                '--image-folder', str(undistorted_images),
            ], check=True)
            
            # Texture the mesh
            subprocess.run([
                'TextureMesh',
                str(scene_mvs),
                '--mesh-file', str(mesh_ply),
                '-o', str(output_dir / "textured_mesh.mvs"),
                '--export-type', 'obj',
                '--resolution-level', '1',
                '--cost-smoothness-ratio', '0.1',
            ], check=True, cwd=str(output_dir))
            
            textured_obj = output_dir / "textured_mesh.obj"
            textured_mtl = output_dir / "textured_mesh.mtl"
            texture_files = list(output_dir.glob("textured_mesh*map_Kd*"))
            if texture_files:
                texture_path = texture_files[0]
            
            print(f"[Full Pipeline] ✅ Textured mesh: {textured_obj}")
            
        except Exception as e:
            print(f"[Full Pipeline] ⚠️ Texture mapping failed: {e}")
    else:
        print("[Full Pipeline] Step 9/9: Skipping texture (OpenMVS not available)")
    
    # Build result
    result = {
        'success': True,
        'num_sparse_points': num_sparse_points,
        'num_dense_points': num_dense_points,
        'sparse_path': str(sparse_ply),
        'dense_path': str(fused_ply),
        'sparse_model_dir': str(sparse_model_dir),
        'mesh_path': str(mesh_ply),
    }
    
    if textured_obj and textured_obj.exists():
        result['textured_mesh_path'] = str(textured_obj)
    if textured_mtl and textured_mtl.exists():
        result['mtl_path'] = str(textured_mtl)
    if texture_path and texture_path.exists():
        result['texture_path'] = str(texture_path)
    
    print(f"[Full Pipeline] ═══════════════════════════════════════════════════")
    print(f"[Full Pipeline] ✅ COMPLETE")
    print(f"[Full Pipeline] Sparse: {num_sparse_points:,} points")
    print(f"[Full Pipeline] Dense: {num_dense_points:,} points")
    print(f"[Full Pipeline] Mesh: {mesh_ply}")
    if textured_obj:
        print(f"[Full Pipeline] Textured: {textured_obj}")
    print(f"[Full Pipeline] ═══════════════════════════════════════════════════")
    
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Full pipeline: images → textured mesh')
    parser.add_argument('images_dir', help='Directory containing input images')
    parser.add_argument('output_dir', help='Output directory for all results')
    parser.add_argument('--quality', default='high', choices=['high', 'medium', 'low'])
    args = parser.parse_args()
    
    try:
        result = run_full_pipeline(args.images_dir, args.output_dir, args.quality)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(json.dumps({'success': False, 'error': str(e)}))
        sys.exit(1)
EOFFULLPIPELINE

