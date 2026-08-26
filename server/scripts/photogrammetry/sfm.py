#!/usr/bin/env python3
"""
Structure from Motion Module (2026 Optimized)

Performs sparse 3D reconstruction using COLMAP/GLOMAP.
This module wraps COLMAP's SfM pipeline with 2026 optimizations:
1. GLOMAP global mapper (10-100x faster than incremental)
2. Smart matching (sequential/vocab tree auto-detection)
3. Multi-GPU feature extraction and matching
4. Maximum RAM cache utilization

Optimizations:
- GLOMAP replaces incremental mapper when available
- Auto-detects sequential vs random captures for optimal matching
- Uses all available GPUs for CUDA operations
- Maintains OPENCV camera model for accuracy
"""

import os
import sys
import json
import shutil
import subprocess
import tempfile
import glob
import re
import traceback
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import numpy as np

from .feature_extraction import ImageFeatures
from .feature_matching import ImageMatch

HLOC_AVAILABLE = False
LIGHTGLUE_AVAILABLE = False
LIGHTGLUE_MATCHER_KEY = None
try:
    import hloc  # noqa: F401
    from hloc import extract_features, match_features

    HLOC_AVAILABLE = True
except ImportError:
    extract_features = None
    match_features = None


def resolve_lightglue_matcher_key() -> Optional[str]:
    confs = getattr(match_features, 'confs', {}) if match_features is not None else {}
    preferred_keys = ('superpoint+lightglue', 'lightglue')
    for key in preferred_keys:
        if key in confs:
            return key
    for key in confs:
        if 'lightglue' in key and 'superpoint' in key:
            return key
    for key in confs:
        if 'lightglue' in key:
            return key
    return None


LIGHTGLUE_MATCHER_KEY = resolve_lightglue_matcher_key()
LIGHTGLUE_AVAILABLE = LIGHTGLUE_MATCHER_KEY is not None

H5PY_AVAILABLE = False
try:
    import h5py

    H5PY_AVAILABLE = True
except ImportError:
    h5py = None

PYCOLMAP_AVAILABLE = False
try:
    import pycolmap

    PYCOLMAP_AVAILABLE = True
except ImportError:
    pycolmap = None

# Check for GLOMAP availability and compatible COLMAP path
# GLOMAP builds its own COLMAP via FetchContent - we need to use that version
# for database compatibility
GLOMAP_AVAILABLE = shutil.which('glomap') is not None
GLOMAP_COLMAP_PATH = '/opt/glomap/build/_deps/colmap-build/src/colmap/exe/colmap'


def learned_sparse_stack_available() -> bool:
    """Return True when the HLOC + LightGlue sparse stack is importable."""
    return HLOC_AVAILABLE and LIGHTGLUE_AVAILABLE and H5PY_AVAILABLE and PYCOLMAP_AVAILABLE


def open_pycolmap_database(database_path: Path):
    """Open a COLMAP database across pycolmap API versions."""
    open_database = getattr(pycolmap.Database, 'open', None)
    if callable(open_database):
        return open_database(str(database_path))

    database = pycolmap.Database(str(database_path))
    create_tables = getattr(database, 'create_tables', None)
    if callable(create_tables):
        create_tables()
    return database


def write_camera_to_database(database, camera) -> int:
    """Write a camera using whichever pycolmap API is available."""
    write_camera = getattr(database, 'write_camera', None)
    if callable(write_camera):
        return write_camera(camera)
    return database.add_camera(camera)


def write_image_to_database(database, image) -> int:
    """Write an image using whichever pycolmap API is available."""
    write_image = getattr(database, 'write_image', None)
    if callable(write_image):
        return write_image(image)
    return database.add_image(image)


def write_keypoints_to_database(database, image_id: int, keypoints: np.ndarray) -> None:
    """Write keypoints using whichever pycolmap API is available."""
    write_keypoints = getattr(database, 'write_keypoints', None)
    if callable(write_keypoints):
        write_keypoints(image_id, keypoints)
        return
    database.add_keypoints(image_id, keypoints)


def write_matches_to_database(database, image_id0: int, image_id1: int, matches: np.ndarray) -> None:
    """Write matches using whichever pycolmap API is available."""
    write_matches = getattr(database, 'write_matches', None)
    if callable(write_matches):
        write_matches(image_id0, image_id1, matches)
        return
    database.add_matches(image_id0, image_id1, matches)


def list_image_files(images_dir: Path) -> List[Path]:
    """Return image files supported by the sparse pipeline in a stable order."""
    patterns = ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG')
    image_files: List[Path] = []
    for pattern in patterns:
        image_files.extend(images_dir.glob(pattern))
    return sorted({path.resolve(): path for path in image_files}.values(), key=lambda path: path.name)


def write_sequential_pairs(image_files: List[Path], output_path: Path, overlap: int = 10) -> Path:
    """Write sequential image pairs for video-style captures."""
    with open(output_path, 'w') as handle:
        for index, image_path in enumerate(image_files):
            for offset in range(index + 1, min(index + overlap + 1, len(image_files))):
                handle.write(f"{image_path.name} {image_files[offset].name}\n")
    return output_path


def write_exhaustive_pairs(image_files: List[Path], output_path: Path) -> Path:
    """Write exhaustive image pairs for unordered captures."""
    with open(output_path, 'w') as handle:
        for index, image_path in enumerate(image_files):
            for other_path in image_files[index + 1:]:
                handle.write(f"{image_path.name} {other_path.name}\n")
    return output_path


def import_hloc_features_to_colmap(
    database_path: Path,
    image_files: List[Path],
    features_path: Path,
    camera_model: str = 'OPENCV',
) -> bool:
    """Import HLOC SuperPoint features into a COLMAP database via pycolmap."""
    if not PYCOLMAP_AVAILABLE or not H5PY_AVAILABLE:
        return False

    try:
        if database_path.exists():
            database_path.unlink()

        db = open_pycolmap_database(database_path)

        first_image = cv2.imread(str(image_files[0]))
        if first_image is None:
            raise ValueError(f'Could not load image: {image_files[0]}')
        height, width = first_image.shape[:2]

        focal = max(width, height) * 1.2
        camera = pycolmap.Camera(
            model=camera_model,
            width=width,
            height=height,
            params=[focal, focal, width / 2, height / 2, 0, 0, 0, 0],
        )
        camera_id = write_camera_to_database(db, camera)

        imported_images = 0
        with h5py.File(features_path, 'r') as feature_file:
            for image_path in image_files:
                image_name = image_path.name
                if image_name not in feature_file:
                    continue

                image = pycolmap.Image(name=image_name, camera_id=camera_id)
                image_id = write_image_to_database(db, image)

                keypoints = feature_file[image_name]['keypoints'][:]

                colmap_keypoints = np.zeros((keypoints.shape[0], 6), dtype=np.float32)
                colmap_keypoints[:, :2] = keypoints
                colmap_keypoints[:, 2] = 1.0
                colmap_keypoints[:, 3] = 0.0

                write_keypoints_to_database(db, image_id, colmap_keypoints)
                imported_images += 1

        db.close()
        return imported_images >= 2
    except Exception as exc:
        print(f"[SfM] Learned feature import failed: {exc}")
        traceback.print_exc()
        return False


def import_hloc_matches_to_colmap(
    database_path: Path,
    matches_path: Path,
    pairs_path: Path,
) -> bool:
    """Import HLOC LightGlue matches into a COLMAP database via pycolmap."""
    if not PYCOLMAP_AVAILABLE or not H5PY_AVAILABLE:
        return False

    try:
        db = open_pycolmap_database(database_path)
        images = db.read_all_images()
        name_to_id = {image.name: image.image_id for image in images}

        imported_pairs = 0
        with open(pairs_path, 'r') as handle:
            pairs = [tuple(line.strip().split()) for line in handle if line.strip()]

        with h5py.File(matches_path, 'r') as match_file:
            for name0, name1 in pairs:
                pair_key = f"{name0}_{name1}" if name0 < name1 else f"{name1}_{name0}"
                if pair_key not in match_file:
                    pair_key = f"{name0}/{name1}" if name0 < name1 else f"{name1}/{name0}"
                if pair_key not in match_file:
                    continue

                matches0 = match_file[pair_key]['matches0'][:]
                valid_mask = matches0 >= 0
                if not valid_mask.any():
                    continue

                idx0 = np.where(valid_mask)[0]
                idx1 = matches0[valid_mask]
                match_pairs = np.stack([idx0, idx1], axis=1).astype(np.uint32)

                id0 = name_to_id.get(name0)
                id1 = name_to_id.get(name1)
                if id0 is None or id1 is None:
                    continue

                if id0 > id1:
                    id0, id1 = id1, id0
                    match_pairs = match_pairs[:, ::-1]

                write_matches_to_database(db, id0, id1, match_pairs)
                imported_pairs += 1

        db.close()
        return imported_pairs > 0
    except Exception as exc:
        print(f"[SfM] Learned match import failed: {exc}")
        traceback.print_exc()
        return False


def get_standard_colmap() -> Optional[str]:
    """Get the standard COLMAP binary for legacy SfM commands."""
    candidates = [
        shutil.which('colmap'),
        '/usr/local/bin/colmap',
        '/usr/bin/colmap',
        '/opt/homebrew/bin/colmap',
        os.path.expanduser('~/colmap/build/src/exe/colmap'),
    ]

    for path in candidates:
        if not path:
            continue
        try:
            result = subprocess.run(
                [path, '-h'],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                return path
        except (subprocess.SubprocessError, FileNotFoundError):
            continue

    return None

def get_glomap_compatible_colmap() -> Optional[str]:
    """
    Get path to COLMAP binary that's compatible with GLOMAP.
    GLOMAP uses FetchContent to build its own COLMAP, which may have
    a different database schema than the system COLMAP.
    """
    # First check for GLOMAP's bundled COLMAP
    if os.path.exists(GLOMAP_COLMAP_PATH):
        return GLOMAP_COLMAP_PATH
    
    # Check for symlink we create during setup
    colmap_glomap = shutil.which('colmap-glomap')
    if colmap_glomap:
        return colmap_glomap
    
    # Fall back to system COLMAP
    return shutil.which('colmap')


def get_gpu_indices() -> Optional[str]:
    """Detect all available NVIDIA GPUs and return comma-separated indices, or None if no GPU."""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=index', '--format=csv,noheader'],
            capture_output=True, text=True, check=True, timeout=10
        )
        indices = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
        return ','.join(indices) if indices else None
    except Exception:
        # No NVIDIA GPU available (e.g., macOS, CPU-only systems)
        return None


def get_primary_gpu_index(gpu_indices: Optional[str]) -> Optional[str]:
    """COLMAP SfM commands on this VM expect a single GPU index."""
    if not gpu_indices:
        return None
    return gpu_indices.split(',')[0].strip() or None


def detect_capture_type(images_dir: Path) -> str:
    """
    Auto-detect if images are sequential (video frames, walking path) or random.
    Sequential captures benefit from sequential_matcher (linear vs quadratic complexity).
    
    Returns: 'sequential', 'vocab_tree', or 'exhaustive'
    """
    image_files = sorted(
        glob.glob(str(images_dir / '*.jpg')) + 
        glob.glob(str(images_dir / '*.jpeg')) +
        glob.glob(str(images_dir / '*.png')) +
        glob.glob(str(images_dir / '*.JPG')) +
        glob.glob(str(images_dir / '*.JPEG')) +
        glob.glob(str(images_dir / '*.PNG'))
    )
    
    if len(image_files) < 10:
        return 'exhaustive'  # Small dataset, exhaustive is fine
    
    # Check if filenames are numbered sequentially
    try:
        numbers = []
        for f in image_files[:20]:  # Check first 20
            match = re.search(r'(\d+)', Path(f).stem)
            if match:
                numbers.append(int(match.group(1)))
        
        if len(numbers) >= 10:
            # Check if mostly sequential (gaps < 5)
            diffs = [numbers[i+1] - numbers[i] for i in range(len(numbers)-1)]
            avg_diff = sum(diffs) / len(diffs) if diffs else 999
            if 0.5 < avg_diff < 5:
                print(f"[SfM] Detected SEQUENTIAL capture (avg frame gap: {avg_diff:.1f})")
                return 'sequential'
    except Exception:
        pass
    
    if len(image_files) > 50:
        print("[SfM] Large non-sequential dataset, using vocabulary tree matching")
        return 'vocab_tree'
    
    return 'exhaustive'


@dataclass
class Camera:
    """Camera parameters and pose"""
    image_id: str
    image_path: str
    
    # Intrinsics (PINHOLE model)
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    
    # Extrinsics (world-to-camera)
    rotation: np.ndarray  # 3x3 rotation matrix
    translation: np.ndarray  # 3 translation vector
    
    # Quaternion representation (for convenience)
    quaternion: np.ndarray  # wxyz format
    
    @property
    def intrinsic_matrix(self) -> np.ndarray:
        """Get 3x3 intrinsic matrix K"""
        return np.array([
            [self.fx, 0, self.cx],
            [0, self.fy, self.cy],
            [0, 0, 1]
        ])
    
    @property
    def extrinsic_matrix(self) -> np.ndarray:
        """Get 4x4 extrinsic matrix [R|t]"""
        mat = np.eye(4)
        mat[:3, :3] = self.rotation
        mat[:3, 3] = self.translation
        return mat
    
    @property
    def projection_matrix(self) -> np.ndarray:
        """Get 3x4 projection matrix P = K[R|t]"""
        return self.intrinsic_matrix @ self.extrinsic_matrix[:3]
    
    @property
    def position(self) -> np.ndarray:
        """Get camera position in world coordinates"""
        return -self.rotation.T @ self.translation
    
    def to_dict(self) -> Dict:
        return {
            'image_id': self.image_id,
            'image_path': self.image_path,
            'width': self.width,
            'height': self.height,
            'fx': self.fx,
            'fy': self.fy,
            'cx': self.cx,
            'cy': self.cy,
            'position': self.position.tolist(),
            'quaternion': self.quaternion.tolist(),
        }


@dataclass 
class SfMResult:
    """Result from Structure from Motion"""
    num_registered: int
    num_points: int
    cameras: Dict[str, Camera]
    points_path: Path
    colmap_dir: Path
    scale: float = 1.0
    
    def to_dict(self) -> Dict:
        return {
            'num_registered': self.num_registered,
            'num_points': self.num_points,
            'cameras': {k: v.to_dict() for k, v in self.cameras.items()},
            'points_path': str(self.points_path),
            'scale': self.scale,
        }


class StructureFromMotion:
    """Structure from Motion using COLMAP"""
    
    def __init__(
        self,
        images_dir: Path,
        output_dir: Path,
        camera_params: Dict = None,
        feature_type: str = 'superpoint',
        max_features: int = 16000,
        colmap_path: str = None,
    ):
        self.images_dir = Path(images_dir)
        self.output_dir = Path(output_dir)
        self.camera_params = camera_params or {}
        self.feature_type = str(feature_type or 'superpoint').strip().lower()
        self.max_features = max(1024, int(max_features))
        if self.feature_type != 'superpoint':
            raise RuntimeError(
                f"legacy_photogrammetry_requires_superpoint_feature_type: received '{self.feature_type}'"
            )

        self.learned_sparse_requested = True
        self.learned_sparse_available = learned_sparse_stack_available()
        self.use_learned_sparse = self.learned_sparse_requested and self.learned_sparse_available

        if not self.learned_sparse_available:
            raise RuntimeError(
                'legacy_photogrammetry_requires_hloc_superpoint_lightglue_stack '
                '(hloc, LightGlue matcher config, h5py, and pycolmap must all be available)'
            )
        if not GLOMAP_AVAILABLE:
            raise RuntimeError('legacy_photogrammetry_requires_glomap_mapper')
        
        # Find COLMAP binary
        self.colmap_path = colmap_path or self._find_colmap()
        self.capture_type = detect_capture_type(self.images_dir)
        
        # Working directories
        self.database_path = self.output_dir / "database.db"
        self.sparse_dir = self.output_dir / "sparse"
        
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"[SfM] Initialized with COLMAP at: {self.colmap_path}")
        if self.colmap_path:
            print("[SfM] Sparse frontend: SuperPoint + LightGlue + GLOMAP")

    def manages_sparse_pipeline(self) -> bool:
        """Return True when sparse extraction/matching is handled inside SfM."""
        return self.colmap_path is not None
    
    def _find_colmap(self) -> str:
        """Find the COLMAP binary compatible with the required GLOMAP sparse stack."""
        glomap_colmap = get_glomap_compatible_colmap()
        if glomap_colmap:
            print(f"[SfM] Using GLOMAP-compatible COLMAP for learned sparse SfM: {glomap_colmap}")
            return glomap_colmap

        raise RuntimeError('legacy_photogrammetry_requires_glomap_compatible_colmap')
    
    def run(
        self,
        features: Dict[str, ImageFeatures],
        matches: Dict[Tuple[str, str], ImageMatch],
        imu_data: Dict = None,
    ) -> Dict[str, Any]:
        """
        Run Structure from Motion pipeline.
        
        Returns dict with:
            - num_registered: Number of registered images
            - num_points: Number of 3D points
            - cameras: Dict of camera poses
            - points_path: Path to point cloud file
        """
        
        return self._run_colmap(features, matches, imu_data)
    
    def _run_colmap(
        self,
        features: Dict[str, ImageFeatures],
        matches: Dict[Tuple[str, str], ImageMatch],
        imu_data: Dict = None,
    ) -> Dict[str, Any]:
        """Run COLMAP SfM pipeline"""

        used_learned_sparse = self._prepare_learned_sparse_database()
        if not used_learned_sparse:
            raise RuntimeError('legacy_photogrammetry_sparse_frontend_failed_before_glomap')

        # Step 2: Run mapper
        print("[SfM] Running GLOMAP sparse mapper...")
        self._run_mapper(prefer_glomap=True)
        
        # Step 3: Read results
        print("[SfM] Reading reconstruction...")
        cameras, points = self._read_reconstruction()
        
        # Step 4: Apply scale from IMU if available
        scale = 1.0
        if imu_data:
            scale = self._compute_scale(cameras, imu_data)
            points = self._apply_scale(points, scale)
            cameras = self._apply_scale_to_cameras(cameras, scale)
        
        # Step 5: Export point cloud
        points_path = self.output_dir / "sparse.ply"
        self._export_points_ply(points, points_path)
        
        return {
            'num_registered': len(cameras),
            'num_points': len(points),
            'cameras': cameras,
            'points_path': points_path,
            'colmap_dir': self.sparse_dir,
            'scale': scale,
        }

    def _prepare_learned_sparse_database(self) -> bool:
        """Populate the COLMAP database using HLOC SuperPoint + LightGlue when available."""
        if not self.use_learned_sparse:
            return False

        image_files = list_image_files(self.images_dir)
        if len(image_files) < 2:
            print("[SfM] Learned sparse frontend skipped: need at least 2 images")
            return False

        hloc_dir = self.output_dir / 'hloc'
        hloc_dir.mkdir(parents=True, exist_ok=True)
        features_path = hloc_dir / 'features.h5'
        matches_path = hloc_dir / 'matches.h5'
        pairs_path = hloc_dir / 'pairs.txt'

        try:
            print("[SfM] Extracting SuperPoint features for sparse reconstruction...")
            feature_conf = extract_features.confs['superpoint_max'].copy()
            feature_conf['model'] = dict(feature_conf.get('model', {}))
            feature_conf['model']['max_keypoints'] = self.max_features
            extract_features.main(feature_conf, self.images_dir, feature_path=features_path)

            if self.capture_type == 'sequential':
                write_sequential_pairs(image_files, pairs_path, overlap=10)
            else:
                write_exhaustive_pairs(image_files, pairs_path)

            print("[SfM] Matching SuperPoint features with LightGlue...")
            match_conf = match_features.confs[LIGHTGLUE_MATCHER_KEY].copy()
            match_features.main(match_conf, pairs_path, features_path, matches=matches_path)

            if not import_hloc_features_to_colmap(self.database_path, image_files, features_path):
                raise RuntimeError('hloc_superpoint_feature_import_failed')
            if not import_hloc_matches_to_colmap(self.database_path, matches_path, pairs_path):
                raise RuntimeError('hloc_lightglue_match_import_failed')

            subprocess.run([
                self.colmap_path, 'geometric_verifier',
                '--database_path', str(self.database_path),
            ], check=True)

            print("[SfM] Learned sparse database ready for GLOMAP")
            return True
        except Exception as exc:
            raise RuntimeError(f'hloc_superpoint_lightglue_frontend_failed: {exc}') from exc
    
    def _run_python_sfm(
        self,
        features: Dict[str, ImageFeatures],
        matches: Dict[Tuple[str, str], ImageMatch],
        imu_data: Dict = None,
    ) -> Dict[str, Any]:
        """
        Fallback Python-based SfM using OpenCV.
        Simpler than COLMAP but works without external dependencies.
        """
        print("[SfM] Running Python-based SfM fallback...")
        
        # Initialize
        cameras = {}
        points_3d = []
        
        # Get sorted image list
        image_ids = sorted(features.keys())
        n_images = len(image_ids)
        
        if n_images < 2:
            raise ValueError("Need at least 2 images for SfM")
        
        # Get camera intrinsics (assume same for all images)
        first_feat = features[image_ids[0]]
        w, h = first_feat.image_size
        
        # Use provided camera params or estimate
        fx = self.camera_params.get('fx', w * 1.2)  # Rough estimate
        fy = self.camera_params.get('fy', fx)
        cx = self.camera_params.get('cx', w / 2)
        cy = self.camera_params.get('cy', h / 2)
        
        K = np.array([
            [fx, 0, cx],
            [0, fy, cy],
            [0, 0, 1]
        ])
        
        # Initialize first camera at origin
        R0 = np.eye(3)
        t0 = np.zeros(3)
        
        cameras[image_ids[0]] = Camera(
            image_id=image_ids[0],
            image_path=str(self.images_dir / f"{image_ids[0]}.jpg"),
            width=w, height=h,
            fx=fx, fy=fy, cx=cx, cy=cy,
            rotation=R0,
            translation=t0,
            quaternion=rotation_matrix_to_quaternion(R0),
        )
        
        # Process pairs incrementally
        registered = {image_ids[0]}
        
        for i in range(1, min(n_images, 50)):  # Limit for fallback
            img_id = image_ids[i]
            
            # Find best match with registered images
            best_match = None
            best_ref = None
            best_inliers = 0
            
            for ref_id in registered:
                key = (min(ref_id, img_id), max(ref_id, img_id))
                if key in matches:
                    match = matches[key]
                    if match.num_inliers > best_inliers:
                        best_match = match
                        best_ref = ref_id
                        best_inliers = match.num_inliers
            
            if best_match is None or best_inliers < 20:
                print(f"[SfM] Warning: Could not register {img_id}")
                continue
            
            # Recover pose from essential matrix
            ref_cam = cameras[best_ref]
            ref_feat = features[best_ref]
            curr_feat = features[img_id]
            
            # Get matched points (respecting order)
            if best_match.image_id1 == best_ref:
                pts1 = ref_feat.keypoints[best_match.matches[:, 0]]
                pts2 = curr_feat.keypoints[best_match.matches[:, 1]]
            else:
                pts1 = ref_feat.keypoints[best_match.matches[:, 1]]
                pts2 = curr_feat.keypoints[best_match.matches[:, 0]]
            
            # Apply inlier mask if available
            if best_match.inlier_mask is not None:
                pts1 = pts1[best_match.inlier_mask]
                pts2 = pts2[best_match.inlier_mask]
            
            # Compute essential matrix
            E, mask = cv2.findEssentialMat(pts1, pts2, K, cv2.RANSAC, 0.999, 1.0)
            
            if E is None:
                continue
            
            # Recover pose
            _, R, t, mask = cv2.recoverPose(E, pts1, pts2, K)
            
            # Compose with reference camera
            R_world = R @ ref_cam.rotation
            t_world = R @ ref_cam.translation + t.flatten()
            
            cameras[img_id] = Camera(
                image_id=img_id,
                image_path=str(self.images_dir / f"{img_id}.jpg"),
                width=w, height=h,
                fx=fx, fy=fy, cx=cx, cy=cy,
                rotation=R_world,
                translation=t_world,
                quaternion=rotation_matrix_to_quaternion(R_world),
            )
            
            registered.add(img_id)
            
            if (i + 1) % 10 == 0:
                print(f"[SfM] Registered {len(registered)}/{i + 1} images")
        
        # Triangulate points from matched features
        print(f"[SfM] Triangulating points from {len(registered)} cameras...")
        points_3d = self._triangulate_points(cameras, features, matches)
        
        # Apply IMU scale
        scale = 1.0
        if imu_data and len(cameras) >= 2:
            scale = self._compute_scale(cameras, imu_data)
            cameras = self._apply_scale_to_cameras(cameras, scale)
            points_3d = [(p[0] * scale, p[1] * scale, p[2] * scale, *p[3:]) for p in points_3d]
        
        # Export to PLY
        points_path = self.output_dir / "sparse.ply"
        self._write_ply(points_3d, points_path)
        
        print(f"[SfM] Registered {len(cameras)} cameras, {len(points_3d)} points")
        
        return {
            'num_registered': len(cameras),
            'num_points': len(points_3d),
            'cameras': cameras,
            'points_path': points_path,
            'colmap_dir': self.output_dir,
            'scale': scale,
        }
    
    def _triangulate_points(
        self,
        cameras: Dict[str, Camera],
        features: Dict[str, ImageFeatures],
        matches: Dict[Tuple[str, str], ImageMatch],
    ) -> List[Tuple[float, float, float, int, int, int]]:
        """Triangulate 3D points from matched features"""
        points = []
        
        for (id1, id2), match in matches.items():
            if id1 not in cameras or id2 not in cameras:
                continue
            
            cam1 = cameras[id1]
            cam2 = cameras[id2]
            feat1 = features[id1]
            feat2 = features[id2]
            
            P1 = cam1.projection_matrix
            P2 = cam2.projection_matrix
            
            # Get matched points
            pts1 = feat1.keypoints[match.matches[:, 0]]
            pts2 = feat2.keypoints[match.matches[:, 1]]
            
            if match.inlier_mask is not None:
                pts1 = pts1[match.inlier_mask]
                pts2 = pts2[match.inlier_mask]
            
            # Triangulate
            for p1, p2 in zip(pts1[:100], pts2[:100]):  # Limit points per pair
                pt_4d = cv2.triangulatePoints(
                    P1, P2,
                    p1.reshape(2, 1),
                    p2.reshape(2, 1)
                )
                
                pt_3d = pt_4d[:3, 0] / pt_4d[3, 0]
                
                # Filter bad points
                if np.any(np.isnan(pt_3d)) or np.any(np.isinf(pt_3d)):
                    continue
                if np.linalg.norm(pt_3d) > 100:  # Too far
                    continue
                
                # Get color (placeholder - gray)
                points.append((pt_3d[0], pt_3d[1], pt_3d[2], 128, 128, 128))
        
        return points
    
    def _compute_scale(
        self,
        cameras: Dict[str, Camera],
        imu_data: Dict,
    ) -> float:
        """
        Compute scale factor to align SfM trajectory with IMU trajectory.
        Uses Procrustes analysis to find the best scale.
        """
        sfm_positions = []
        imu_positions = []
        
        for image_id, camera in cameras.items():
            if image_id in imu_data:
                imu_pos = imu_data[image_id].get('position')
                if imu_pos:
                    sfm_positions.append(camera.position)
                    imu_positions.append(np.array(imu_pos))
        
        if len(sfm_positions) < 3:
            print("[SfM] Warning: Not enough IMU data points for scale estimation")
            return 1.0
        
        sfm_positions = np.array(sfm_positions)
        imu_positions = np.array(imu_positions)
        
        # Center both point sets
        sfm_centered = sfm_positions - sfm_positions.mean(axis=0)
        imu_centered = imu_positions - imu_positions.mean(axis=0)
        
        # Compute scale as ratio of RMS distances from centroid
        sfm_rms = np.sqrt((sfm_centered ** 2).sum() / len(sfm_centered))
        imu_rms = np.sqrt((imu_centered ** 2).sum() / len(imu_centered))
        
        if sfm_rms < 1e-6:
            return 1.0
        
        scale = imu_rms / sfm_rms
        
        print(f"[SfM] Computed scale factor: {scale:.4f}")
        return scale
    
    def _apply_scale_to_cameras(
        self,
        cameras: Dict[str, Camera],
        scale: float,
    ) -> Dict[str, Camera]:
        """Apply scale factor to camera translations"""
        for image_id, camera in cameras.items():
            camera.translation = camera.translation * scale
        return cameras
    
    def _write_ply(
        self,
        points: List[Tuple[float, float, float, int, int, int]],
        path: Path,
    ):
        """Write points to PLY file"""
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
            
            for x, y, z, r, g, b in points:
                f.write(f"{x:.6f} {y:.6f} {z:.6f} {r} {g} {b}\n")
    
    # COLMAP-specific methods
    def _create_database(self):
        """Create COLMAP database"""
        if self.database_path.exists():
            self.database_path.unlink()
        
        subprocess.run([
            self.colmap_path, 'database_creator',
            '--database_path', str(self.database_path),
        ], check=True)
    
    def _import_features(self, features: Dict[str, ImageFeatures]):
        raise RuntimeError('legacy_photogrammetry_requires_hloc_superpoint_lightglue_stack')
    
    def _import_matches(self, matches: Dict[Tuple[str, str], ImageMatch]):
        raise RuntimeError('legacy_photogrammetry_requires_hloc_superpoint_lightglue_stack')
    
    def _run_mapper(self, prefer_glomap: bool = False):
        """Run the required GLOMAP global mapper for legacy photogrammetry."""
        self.sparse_dir.mkdir(parents=True, exist_ok=True)

        if not prefer_glomap or not GLOMAP_AVAILABLE:
            raise RuntimeError('legacy_photogrammetry_requires_glomap_mapper')

        print("[SfM] Running GLOMAP global mapper...")

        try:
            subprocess.run([
                'glomap', 'mapper',
                '--database_path', str(self.database_path),
                '--image_path', str(self.images_dir),
                '--output_path', str(self.sparse_dir),
            ], check=True, capture_output=True, text=True, timeout=600)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"glomap_mapper_failed: {e.stderr[:500] if e.stderr else str(e)}"
            ) from e

        recon_dirs = list(self.sparse_dir.glob('[0-9]*'))
        if not recon_dirs:
            raise RuntimeError('glomap_mapper_produced_no_output')

        print(f"[SfM] GLOMAP created {len(recon_dirs)} model(s)")

        if len(recon_dirs) > 1:
            print(f"[SfM] Found {len(recon_dirs)} separate GLOMAP models, attempting to merge...")
            self._try_merge_models(recon_dirs)
    
    def _try_merge_models(self, model_dirs):
        """Try to merge multiple COLMAP models into one"""
        # Sort by size (largest first)
        def get_model_size(d):
            images_bin = d / 'images.bin'
            return images_bin.stat().st_size if images_bin.exists() else 0
        
        model_dirs = sorted(model_dirs, key=get_model_size, reverse=True)
        
        merged_dir = self.sparse_dir / 'merged'
        merged_dir.mkdir(exist_ok=True)
        
        # Start with the largest model
        import shutil
        for f in model_dirs[0].glob('*'):
            shutil.copy(f, merged_dir / f.name)
        
        # Try to merge each additional model
        for i, model_dir in enumerate(model_dirs[1:], 1):
            print(f"[SfM] Merging model {i+1}/{len(model_dirs)}...")
            try:
                # Use model_merger to combine models
                result = subprocess.run([
                    self.colmap_path, 'model_merger',
                    '--input_path1', str(merged_dir),
                    '--input_path2', str(model_dir),
                    '--output_path', str(merged_dir),
                ], capture_output=True, text=True)
                
                if result.returncode != 0:
                    print(f"[SfM] Could not merge model {model_dir.name}: {result.stderr[:200]}")
            except Exception as e:
                print(f"[SfM] Error merging model {model_dir.name}: {e}")
        
        # Check if merged model is larger than original
        merged_size = get_model_size(merged_dir)
        original_size = get_model_size(model_dirs[0])
        
        if merged_size > original_size:
            print(f"[SfM] Merged model is larger ({merged_size} > {original_size}), using merged")
            # Move merged to be the '0' model
            import shutil
            backup = self.sparse_dir / '0_backup'
            shutil.move(str(model_dirs[0]), str(backup))
            shutil.move(str(merged_dir), str(model_dirs[0]))
        else:
            print(f"[SfM] Merged model not larger, keeping original")
    
    def _read_reconstruction(self) -> Tuple[Dict[str, Camera], List]:
        """Read COLMAP reconstruction"""
        # Find the reconstruction directory (usually 0/)
        recon_dirs = list(self.sparse_dir.glob('*'))
        if not recon_dirs:
            raise ValueError("No reconstruction found")
        
        # Pick the largest reconstruction (most images registered)
        # Check images.bin size as proxy for number of registered images
        def get_model_size(d):
            images_bin = d / 'images.bin'
            if images_bin.exists():
                return images_bin.stat().st_size
            images_txt = d / 'images.txt'
            if images_txt.exists():
                return images_txt.stat().st_size
            return 0
        
        recon_dir = max(recon_dirs, key=get_model_size)
        print(f"[SfM] Selected model {recon_dir.name} (largest of {len(recon_dirs)} models)")
        
        # Read cameras and points using model_converter
        # Export to text format for parsing
        text_dir = self.output_dir / "sparse_text"
        text_dir.mkdir(exist_ok=True)
        
        subprocess.run([
            self.colmap_path, 'model_converter',
            '--input_path', str(recon_dir),
            '--output_path', str(text_dir),
            '--output_type', 'TXT',
        ], check=True)
        
        cameras = self._parse_images_txt(text_dir / "images.txt")
        points = self._parse_points_txt(text_dir / "points3D.txt")
        
        return cameras, points
    
    def _parse_images_txt(self, path: Path) -> Dict[str, Camera]:
        """Parse COLMAP images.txt file"""
        cameras = {}
        
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith('#')]
        
        i = 0
        while i < len(lines):
            parts = lines[i].split()
            if len(parts) < 10:
                i += 1
                continue
            
            image_id = parts[9]  # Image name without extension
            image_id = Path(image_id).stem
            
            qw, qx, qy, qz = map(float, parts[1:5])
            tx, ty, tz = map(float, parts[5:8])
            
            quaternion = np.array([qw, qx, qy, qz])
            rotation = quaternion_to_rotation_matrix(quaternion)
            translation = np.array([tx, ty, tz])
            
            cameras[image_id] = Camera(
                image_id=image_id,
                image_path=str(self.images_dir / parts[9]),
                width=0, height=0,  # Will be filled from camera model
                fx=0, fy=0, cx=0, cy=0,
                rotation=rotation,
                translation=translation,
                quaternion=quaternion,
            )
            
            i += 2  # Skip points line
        
        return cameras
    
    def _parse_points_txt(self, path: Path) -> List:
        """Parse COLMAP points3D.txt file"""
        points = []
        
        with open(path) as f:
            for line in f:
                if line.startswith('#') or not line.strip():
                    continue
                
                parts = line.split()
                x, y, z = map(float, parts[1:4])
                r, g, b = map(int, parts[4:7])
                points.append((x, y, z, r, g, b))
        
        return points
    
    def _export_points_ply(self, points: List, path: Path):
        """Export points to PLY format"""
        self._write_ply(points, path)
        
        # Also export via COLMAP for consistency
        if self.colmap_path:
            try:
                recon_dir = list(self.sparse_dir.glob('*'))[0]
                subprocess.run([
                    self.colmap_path, 'model_converter',
                    '--input_path', str(recon_dir),
                    '--output_path', str(path),
                    '--output_type', 'PLY',
                ], check=True)
            except Exception:
                pass  # Use manual export


def quaternion_to_rotation_matrix(q: np.ndarray) -> np.ndarray:
    """Convert quaternion (wxyz) to 3x3 rotation matrix"""
    w, x, y, z = q
    
    return np.array([
        [1 - 2*y*y - 2*z*z, 2*x*y - 2*w*z, 2*x*z + 2*w*y],
        [2*x*y + 2*w*z, 1 - 2*x*x - 2*z*z, 2*y*z - 2*w*x],
        [2*x*z - 2*w*y, 2*y*z + 2*w*x, 1 - 2*x*x - 2*y*y]
    ])


def rotation_matrix_to_quaternion(R: np.ndarray) -> np.ndarray:
    """Convert 3x3 rotation matrix to quaternion (wxyz)"""
    trace = R[0, 0] + R[1, 1] + R[2, 2]
    
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w = 0.25 / s
        x = (R[2, 1] - R[1, 2]) * s
        y = (R[0, 2] - R[2, 0]) * s
        z = (R[1, 0] - R[0, 1]) * s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2])
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2])
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1])
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    
    return np.array([w, x, y, z])


import cv2  # Import at module level for triangulation

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Run Structure from Motion')
    parser.add_argument('images_dir', help='Directory containing images')
    parser.add_argument('--output', '-o', default='./sfm_output')
    
    args = parser.parse_args()

    # Run SfM
    sfm = StructureFromMotion(
        images_dir=Path(args.images_dir),
        output_dir=Path(args.output),
    )
    result = sfm.run({}, {})
    
    print(f"\nSfM Results:")
    print(f"  Registered images: {result['num_registered']}")
    print(f"  3D points: {result['num_points']}")
    print(f"  Output: {result['points_path']}")
