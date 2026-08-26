#!/usr/bin/env python3
"""
Semantic Segmentation Module (Pipeline v2)

Uses SAM2 (Segment Anything Model 2) to segment input images,
then projects 2D labels onto the 3D mesh using multi-view voting.

Features:
- SAM2 auto-segmentation of all objects
- Category classification using CLIP
- Multi-view label projection to 3D mesh
- Majority voting for robust labeling
- Per-triangle confidence scores

Usage:
    python semantic_segmentation.py <images_dir> <mesh_path> <colmap_dir> <output_path>

Output:
    - Labeled mesh with per-vertex/face semantic labels
    - segmentation_stats.json with category counts and confidences
"""

import os
import sys
import json
import argparse
import time
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, field
from collections import defaultdict
import numpy as np

try:
    import open3d as o3d
    HAS_OPEN3D = True
except ImportError:
    HAS_OPEN3D = False
    print("[Segment] Warning: Open3D not available")

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    print("[Segment] Warning: PyTorch not available")


# =============================================================================
# CATEGORY DEFINITIONS
# =============================================================================

# Categories we care about for property measurement
PROPERTY_CATEGORIES = [
    'cabinet',
    'counter',
    'countertop', 
    'door',
    'window',
    'wall',
    'floor',
    'ceiling',
    'appliance',
    'refrigerator',
    'stove',
    'oven',
    'dishwasher',
    'sink',
    'toilet',
    'bathtub',
    'shower',
    'closet',
    'shelf',
    'stairs',
]

# Merge similar categories
CATEGORY_MERGE = {
    'countertop': 'counter',
    'kitchen counter': 'counter',
    'bathroom counter': 'counter',
    'kitchen cabinet': 'cabinet',
    'bathroom cabinet': 'cabinet',
    'base cabinet': 'cabinet',
    'upper cabinet': 'cabinet',
    'wall cabinet': 'cabinet',
    'refrigerator': 'appliance',
    'stove': 'appliance',
    'oven': 'appliance',
    'dishwasher': 'appliance',
    'microwave': 'appliance',
}


# =============================================================================
# COLMAP DATA LOADING
# =============================================================================

@dataclass
class Camera:
    """Camera intrinsics."""
    id: int
    model: str
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    params: List[float] = field(default_factory=list)


@dataclass 
class Image:
    """Image with pose."""
    id: int
    name: str
    camera_id: int
    rotation: np.ndarray  # 3x3 rotation matrix
    translation: np.ndarray  # 3x1 translation vector
    
    @property
    def projection_matrix(self) -> np.ndarray:
        """Get 3x4 projection matrix [R|t]."""
        return np.hstack([self.rotation, self.translation.reshape(3, 1)])


def load_colmap_cameras(cameras_path: Path) -> Dict[int, Camera]:
    """Load cameras from COLMAP cameras.txt or cameras.bin."""
    cameras = {}
    
    if cameras_path.suffix == '.bin':
        return load_colmap_cameras_bin(cameras_path)
    
    with open(cameras_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            
            parts = line.split()
            cam_id = int(parts[0])
            model = parts[1]
            width = int(parts[2])
            height = int(parts[3])
            params = [float(p) for p in parts[4:]]
            
            if model == 'PINHOLE':
                fx, fy, cx, cy = params[:4]
            elif model == 'SIMPLE_PINHOLE':
                fx = fy = params[0]
                cx, cy = params[1], params[2]
            elif model in ['RADIAL', 'SIMPLE_RADIAL']:
                fx = fy = params[0]
                cx, cy = params[1], params[2]
            else:
                fx = fy = params[0] if params else width
                cx, cy = width / 2, height / 2
            
            cameras[cam_id] = Camera(
                id=cam_id, model=model, width=width, height=height,
                fx=fx, fy=fy, cx=cx, cy=cy, params=params
            )
    
    return cameras


def load_colmap_cameras_bin(cameras_path: Path) -> Dict[int, Camera]:
    """Load cameras from binary format."""
    import struct
    
    cameras = {}
    
    with open(cameras_path, 'rb') as f:
        num_cameras = struct.unpack('<Q', f.read(8))[0]
        
        for _ in range(num_cameras):
            cam_id = struct.unpack('<I', f.read(4))[0]
            model_id = struct.unpack('<I', f.read(4))[0]
            width = struct.unpack('<Q', f.read(8))[0]
            height = struct.unpack('<Q', f.read(8))[0]
            
            # Model params count
            model_params = {0: 3, 1: 4, 2: 4, 3: 5, 4: 4, 5: 5, 6: 12}
            num_params = model_params.get(model_id, 4)
            params = struct.unpack(f'<{num_params}d', f.read(8 * num_params))
            
            model_names = {0: 'SIMPLE_PINHOLE', 1: 'PINHOLE', 2: 'SIMPLE_RADIAL'}
            model = model_names.get(model_id, 'UNKNOWN')
            
            if model == 'PINHOLE':
                fx, fy, cx, cy = params[:4]
            else:
                fx = fy = params[0]
                cx, cy = params[1], params[2]
            
            cameras[cam_id] = Camera(
                id=cam_id, model=model, width=int(width), height=int(height),
                fx=fx, fy=fy, cx=cx, cy=cy, params=list(params)
            )
    
    return cameras


def load_colmap_images(images_path: Path) -> Dict[int, Image]:
    """Load images from COLMAP images.txt or images.bin."""
    images = {}
    
    if images_path.suffix == '.bin':
        return load_colmap_images_bin(images_path)
    
    with open(images_path, 'r') as f:
        lines = [l.strip() for l in f if l.strip() and not l.startswith('#')]
    
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        img_id = int(parts[0])
        qw, qx, qy, qz = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
        tx, ty, tz = float(parts[5]), float(parts[6]), float(parts[7])
        cam_id = int(parts[8])
        name = parts[9]
        
        # Convert quaternion to rotation matrix
        rotation = quaternion_to_rotation_matrix(qw, qx, qy, qz)
        translation = np.array([tx, ty, tz])
        
        images[img_id] = Image(
            id=img_id, name=name, camera_id=cam_id,
            rotation=rotation, translation=translation
        )
        
        i += 2  # Skip points2D line
    
    return images


def load_colmap_images_bin(images_path: Path) -> Dict[int, Image]:
    """Load images from binary format."""
    import struct
    
    images = {}
    
    with open(images_path, 'rb') as f:
        num_images = struct.unpack('<Q', f.read(8))[0]
        
        for _ in range(num_images):
            img_id = struct.unpack('<I', f.read(4))[0]
            qw, qx, qy, qz = struct.unpack('<4d', f.read(32))
            tx, ty, tz = struct.unpack('<3d', f.read(24))
            cam_id = struct.unpack('<I', f.read(4))[0]
            
            # Read name
            name_bytes = []
            while True:
                c = f.read(1)
                if c == b'\x00':
                    break
                name_bytes.append(c)
            name = b''.join(name_bytes).decode('utf-8')
            
            # Skip points2D
            num_points = struct.unpack('<Q', f.read(8))[0]
            f.read(num_points * 24)  # x, y, point3D_id
            
            rotation = quaternion_to_rotation_matrix(qw, qx, qy, qz)
            translation = np.array([tx, ty, tz])
            
            images[img_id] = Image(
                id=img_id, name=name, camera_id=cam_id,
                rotation=rotation, translation=translation
            )
    
    return images


def quaternion_to_rotation_matrix(qw: float, qx: float, qy: float, qz: float) -> np.ndarray:
    """Convert quaternion to 3x3 rotation matrix."""
    R = np.array([
        [1 - 2*qy*qy - 2*qz*qz, 2*qx*qy - 2*qz*qw, 2*qx*qz + 2*qy*qw],
        [2*qx*qy + 2*qz*qw, 1 - 2*qx*qx - 2*qz*qz, 2*qy*qz - 2*qx*qw],
        [2*qx*qz - 2*qy*qw, 2*qy*qz + 2*qx*qw, 1 - 2*qx*qx - 2*qy*qy]
    ])
    return R


# =============================================================================
# SAM2 SEGMENTATION
# =============================================================================

class SAM2Segmenter:
    """SAM2 auto-segmentation with CLIP classification."""
    
    def __init__(self, sam2_checkpoint: str = "facebook/sam2-hiera-large", device: str = None):
        self.device = device or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.sam2_predictor = None
        self.clip_model = None
        self.clip_processor = None
        self._load_models(sam2_checkpoint)
    
    def _load_models(self, sam2_checkpoint: str):
        """Load SAM2 and CLIP models."""
        print(f"[Segment] Loading SAM2 from {sam2_checkpoint}...")
        
        try:
            from sam2.sam2_image_predictor import SAM2ImagePredictor
            self.sam2_predictor = SAM2ImagePredictor.from_pretrained(sam2_checkpoint)
            self.sam2_predictor.model.to(self.device)
            print(f"[Segment] SAM2 loaded on {self.device}")
        except ImportError:
            print("[Segment] SAM2 not installed, using fallback segmentation")
            self.sam2_predictor = None
        except Exception as e:
            print(f"[Segment] SAM2 load failed: {e}, using fallback")
            self.sam2_predictor = None
        
        # Load CLIP for category classification
        try:
            from transformers import CLIPProcessor, CLIPModel
            self.clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
            self.clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
            self.clip_model.to(self.device)
            print("[Segment] CLIP loaded for classification")
        except ImportError:
            print("[Segment] CLIP not available, using geometric classification")
            self.clip_model = None
    
    def segment_image(self, image: np.ndarray) -> List[Dict]:
        """
        Segment an image and classify each segment.
        
        Returns list of segments with:
        - mask: binary mask
        - category: predicted category
        - confidence: classification confidence
        - bbox: bounding box [x1, y1, x2, y2]
        """
        if self.sam2_predictor is not None:
            return self._segment_with_sam2(image)
        else:
            return self._segment_fallback(image)
    
    def _segment_with_sam2(self, image: np.ndarray) -> List[Dict]:
        """Segment using SAM2."""
        # Auto-generate masks
        self.sam2_predictor.set_image(image)
        
        # Generate masks for entire image
        masks = self.sam2_predictor.generate(image)
        
        segments = []
        for mask_data in masks:
            mask = mask_data['segmentation']
            bbox = mask_data['bbox']  # x, y, w, h
            
            # Extract crop for classification
            x, y, w, h = [int(v) for v in bbox]
            crop = image[y:y+h, x:x+w]
            
            if crop.size == 0:
                continue
            
            # Classify with CLIP
            category, confidence = self._classify_crop(crop)
            
            segments.append({
                'mask': mask,
                'category': category,
                'confidence': confidence,
                'bbox': [x, y, x+w, y+h],
                'area': int(np.sum(mask)),
            })
        
        return segments
    
    def _segment_fallback(self, image: np.ndarray) -> List[Dict]:
        """
        Fallback segmentation without SAM2.
        Uses color-based superpixels + edge detection.
        """
        if not HAS_CV2:
            return []
        
        # Convert to LAB for better color segmentation
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        
        # Use SLIC superpixels if available, else use simple thresholding
        try:
            from skimage.segmentation import slic
            from skimage.measure import regionprops
            
            segments_slic = slic(image, n_segments=100, compactness=10)
            
            segments = []
            for region in regionprops(segments_slic + 1):
                mask = segments_slic == (region.label - 1)
                bbox = region.bbox  # (min_row, min_col, max_row, max_col)
                
                y1, x1, y2, x2 = bbox
                crop = image[y1:y2, x1:x2]
                
                if crop.size == 0:
                    continue
                
                category, confidence = self._classify_crop(crop)
                
                segments.append({
                    'mask': mask,
                    'category': category,
                    'confidence': confidence,
                    'bbox': [x1, y1, x2, y2],
                    'area': int(np.sum(mask)),
                })
            
            return segments
            
        except ImportError:
            # Very basic fallback - just detect large regions
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray, 50, 150)
            
            # Find contours
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            segments = []
            for contour in contours:
                if cv2.contourArea(contour) < 1000:
                    continue
                
                mask = np.zeros(gray.shape, dtype=np.uint8)
                cv2.drawContours(mask, [contour], -1, 255, -1)
                
                x, y, w, h = cv2.boundingRect(contour)
                crop = image[y:y+h, x:x+w]
                
                category, confidence = self._classify_crop(crop)
                
                segments.append({
                    'mask': mask > 0,
                    'category': category,
                    'confidence': confidence,
                    'bbox': [x, y, x+w, y+h],
                    'area': int(cv2.contourArea(contour)),
                })
            
            return segments
    
    def _classify_crop(self, crop: np.ndarray) -> Tuple[str, float]:
        """Classify a crop using CLIP."""
        if self.clip_model is None or crop.size == 0:
            return 'unknown', 0.0
        
        try:
            # Prepare text prompts
            text_prompts = [f"a photo of a {cat}" for cat in PROPERTY_CATEGORIES]
            
            # Process image
            inputs = self.clip_processor(
                text=text_prompts,
                images=crop,
                return_tensors="pt",
                padding=True
            )
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            
            # Get predictions
            with torch.no_grad():
                outputs = self.clip_model(**inputs)
                logits = outputs.logits_per_image[0]
                probs = torch.softmax(logits, dim=0)
            
            # Get top prediction
            idx = probs.argmax().item()
            category = PROPERTY_CATEGORIES[idx]
            confidence = probs[idx].item()
            
            # Apply category merging
            category = CATEGORY_MERGE.get(category, category)
            
            return category, confidence
            
        except Exception as e:
            print(f"[Segment] Classification error: {e}")
            return 'unknown', 0.0


# =============================================================================
# 2D → 3D LABEL PROJECTION
# =============================================================================

class MeshLabeler:
    """Projects 2D segmentation labels onto 3D mesh."""
    
    def __init__(self, mesh: o3d.geometry.TriangleMesh):
        self.mesh = mesh
        self.vertices = np.asarray(mesh.vertices)
        self.triangles = np.asarray(mesh.triangles)
        self.n_triangles = len(self.triangles)
        
        # Compute triangle centers
        self.triangle_centers = self._compute_triangle_centers()
        
        # Vote storage: triangle_id -> {category: vote_count}
        self.votes = [defaultdict(float) for _ in range(self.n_triangles)]
        self.vote_counts = np.zeros(self.n_triangles)
    
    def _compute_triangle_centers(self) -> np.ndarray:
        """Compute center point of each triangle."""
        v0 = self.vertices[self.triangles[:, 0]]
        v1 = self.vertices[self.triangles[:, 1]]
        v2 = self.vertices[self.triangles[:, 2]]
        return (v0 + v1 + v2) / 3
    
    def project_labels(
        self,
        segments: List[Dict],
        camera: Camera,
        image: Image,
        min_confidence: float = 0.3
    ):
        """
        Project 2D segment labels onto mesh triangles.
        
        Args:
            segments: List of segment dicts with mask and category
            camera: Camera intrinsics
            image: Image with pose
            min_confidence: Minimum confidence to vote
        """
        # Build combined category mask
        h, w = segments[0]['mask'].shape if segments else (camera.height, camera.width)
        category_map = np.full((h, w), -1, dtype=np.int32)
        confidence_map = np.zeros((h, w), dtype=np.float32)
        
        # Create category index
        category_to_idx = {cat: i for i, cat in enumerate(PROPERTY_CATEGORIES)}
        category_to_idx['unknown'] = -1
        
        # Fill maps (later segments override earlier)
        for seg in sorted(segments, key=lambda s: s['area'], reverse=True):
            if seg['confidence'] < min_confidence:
                continue
            
            mask = seg['mask']
            cat_idx = category_to_idx.get(seg['category'], -1)
            
            if cat_idx >= 0:
                category_map[mask] = cat_idx
                confidence_map[mask] = seg['confidence']
        
        # Project each triangle center
        camera_matrix = np.array([
            [camera.fx, 0, camera.cx],
            [0, camera.fy, camera.cy],
            [0, 0, 1]
        ])
        
        # Transform points to camera frame
        R = image.rotation
        t = image.translation
        
        points_cam = (R @ self.triangle_centers.T).T + t
        
        # Filter points behind camera
        valid = points_cam[:, 2] > 0.1
        
        # Project to 2D
        points_2d = np.zeros((self.n_triangles, 2))
        points_2d[valid, 0] = camera.fx * points_cam[valid, 0] / points_cam[valid, 2] + camera.cx
        points_2d[valid, 1] = camera.fy * points_cam[valid, 1] / points_cam[valid, 2] + camera.cy
        
        # Check bounds and vote
        for i in range(self.n_triangles):
            if not valid[i]:
                continue
            
            x, y = int(points_2d[i, 0]), int(points_2d[i, 1])
            
            if 0 <= x < w and 0 <= y < h:
                cat_idx = category_map[y, x]
                conf = confidence_map[y, x]
                
                if cat_idx >= 0 and conf > 0:
                    category = PROPERTY_CATEGORIES[cat_idx]
                    self.votes[i][category] += conf
                    self.vote_counts[i] += 1
    
    def finalize_labels(self, min_votes: int = 2) -> Tuple[List[str], List[float]]:
        """
        Finalize labels using majority voting.
        
        Returns:
            labels: Per-triangle category labels
            confidences: Per-triangle confidence scores
        """
        labels = []
        confidences = []
        
        for i in range(self.n_triangles):
            if self.vote_counts[i] < min_votes or not self.votes[i]:
                labels.append('unknown')
                confidences.append(0.0)
            else:
                # Get winning category
                best_cat = max(self.votes[i], key=self.votes[i].get)
                total_votes = sum(self.votes[i].values())
                confidence = self.votes[i][best_cat] / total_votes
                
                labels.append(best_cat)
                confidences.append(confidence)
        
        return labels, confidences
    
    def get_labeled_mesh(
        self,
        labels: List[str],
        confidences: List[float]
    ) -> o3d.geometry.TriangleMesh:
        """
        Create mesh with vertex colors based on labels.
        """
        # Color map for categories
        category_colors = {
            'cabinet': [0.6, 0.4, 0.2],      # Brown
            'counter': [0.8, 0.7, 0.5],       # Tan
            'door': [0.4, 0.3, 0.2],          # Dark brown
            'window': [0.7, 0.9, 1.0],        # Light blue
            'wall': [0.9, 0.9, 0.9],          # Light gray
            'floor': [0.5, 0.5, 0.5],         # Gray
            'ceiling': [1.0, 1.0, 1.0],       # White
            'appliance': [0.7, 0.7, 0.7],     # Silver
            'sink': [0.6, 0.8, 0.9],          # Light blue
            'toilet': [1.0, 1.0, 0.95],       # Off-white
            'bathtub': [0.9, 0.95, 1.0],      # Very light blue
            'shower': [0.8, 0.9, 0.95],       # Light blue-gray
            'closet': [0.7, 0.5, 0.3],        # Medium brown
            'shelf': [0.65, 0.45, 0.25],      # Wood brown
            'stairs': [0.55, 0.45, 0.35],     # Dark tan
            'unknown': [0.3, 0.3, 0.3],       # Dark gray
        }
        
        # Compute per-vertex colors from triangle labels
        vertex_colors = np.zeros((len(self.vertices), 3))
        vertex_counts = np.zeros(len(self.vertices))
        
        for i, (label, conf) in enumerate(zip(labels, confidences)):
            color = np.array(category_colors.get(label, [0.3, 0.3, 0.3]))
            
            for v_idx in self.triangles[i]:
                vertex_colors[v_idx] += color * conf
                vertex_counts[v_idx] += conf if conf > 0 else 0.001
        
        # Normalize
        vertex_counts[vertex_counts == 0] = 1
        vertex_colors = vertex_colors / vertex_counts[:, np.newaxis]
        
        # Create colored mesh
        mesh_colored = o3d.geometry.TriangleMesh(self.mesh)
        mesh_colored.vertex_colors = o3d.utility.Vector3dVector(vertex_colors)
        
        return mesh_colored


# =============================================================================
# MAIN SEGMENTATION PIPELINE
# =============================================================================

def run_semantic_segmentation(
    images_dir: Path,
    mesh_path: Path,
    colmap_dir: Path,
    output_path: Path,
    sam2_checkpoint: str = "facebook/sam2-hiera-large",
    min_confidence: float = 0.3,
    min_votes: int = 2
) -> Dict[str, Any]:
    """
    Run full semantic segmentation pipeline.
    
    Args:
        images_dir: Directory with input images
        mesh_path: Path to input mesh
        colmap_dir: COLMAP sparse reconstruction directory
        output_path: Output labeled mesh path
        sam2_checkpoint: SAM2 model checkpoint
        min_confidence: Minimum confidence for voting
        min_votes: Minimum votes to assign label
    
    Returns:
        Statistics dict
    """
    images_dir = Path(images_dir)
    mesh_path = Path(mesh_path)
    colmap_dir = Path(colmap_dir)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    stats = {
        'images_processed': 0,
        'segments_detected': 0,
        'category_counts': defaultdict(int),
        'processing_time': 0,
    }
    
    start_time = time.time()
    
    # Load mesh
    print(f"[Segment] Loading mesh: {mesh_path}")
    mesh = o3d.io.read_triangle_mesh(str(mesh_path))
    print(f"[Segment] Mesh: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} triangles")
    
    # Load COLMAP data
    print(f"[Segment] Loading COLMAP data: {colmap_dir}")
    
    cameras_path = colmap_dir / 'cameras.bin'
    if not cameras_path.exists():
        cameras_path = colmap_dir / 'cameras.txt'
    cameras = load_colmap_cameras(cameras_path)
    
    images_path = colmap_dir / 'images.bin'
    if not images_path.exists():
        images_path = colmap_dir / 'images.txt'
    images = load_colmap_images(images_path)
    
    print(f"[Segment] Loaded {len(cameras)} cameras, {len(images)} images")
    
    # Initialize segmenter and labeler
    segmenter = SAM2Segmenter(sam2_checkpoint)
    labeler = MeshLabeler(mesh)
    
    # Process each image
    for img_id, img in images.items():
        img_path = images_dir / img.name
        
        if not img_path.exists():
            # Try common image extensions
            for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']:
                alt_path = images_dir / (img_path.stem + ext)
                if alt_path.exists():
                    img_path = alt_path
                    break
        
        if not img_path.exists():
            print(f"[Segment] Warning: Image not found: {img_path}")
            continue
        
        print(f"[Segment] Processing {img.name}...")
        
        # Load image
        image_data = cv2.imread(str(img_path))
        if image_data is None:
            continue
        
        # Segment image
        segments = segmenter.segment_image(image_data)
        stats['segments_detected'] += len(segments)
        
        # Project labels
        camera = cameras[img.camera_id]
        labeler.project_labels(segments, camera, img, min_confidence)
        
        stats['images_processed'] += 1
    
    # Finalize labels
    print("[Segment] Finalizing labels...")
    labels, confidences = labeler.finalize_labels(min_votes)
    
    # Count categories
    for label in labels:
        stats['category_counts'][label] += 1
    stats['category_counts'] = dict(stats['category_counts'])
    
    # Create labeled mesh
    mesh_labeled = labeler.get_labeled_mesh(labels, confidences)
    
    # Save outputs
    o3d.io.write_triangle_mesh(str(output_path), mesh_labeled)
    print(f"[Segment] Saved labeled mesh: {output_path}")
    
    # Save labels as JSON
    labels_path = output_path.parent / 'triangle_labels.json'
    with open(labels_path, 'w') as f:
        json.dump({
            'labels': labels,
            'confidences': confidences,
            'categories': PROPERTY_CATEGORIES,
        }, f)
    
    stats['processing_time'] = time.time() - start_time
    
    # Save stats
    stats_path = output_path.parent / 'segmentation_stats.json'
    with open(stats_path, 'w') as f:
        json.dump(stats, f, indent=2)
    
    print(f"[Segment] ✅ Complete in {stats['processing_time']:.1f}s")
    print(f"[Segment]   Images processed: {stats['images_processed']}")
    print(f"[Segment]   Segments detected: {stats['segments_detected']}")
    print(f"[Segment]   Category breakdown:")
    for cat, count in sorted(stats['category_counts'].items(), key=lambda x: -x[1])[:10]:
        pct = 100 * count / len(labels)
        print(f"[Segment]     {cat}: {count:,} ({pct:.1f}%)")
    
    return stats


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Semantic segmentation for 3D mesh (Pipeline v2)'
    )
    parser.add_argument('images_dir', type=Path, help='Directory with input images')
    parser.add_argument('mesh_path', type=Path, help='Input mesh file')
    parser.add_argument('colmap_dir', type=Path, help='COLMAP sparse directory')
    parser.add_argument('output_path', type=Path, help='Output labeled mesh path')
    parser.add_argument('--sam2-checkpoint', type=str, default='facebook/sam2-hiera-large',
                        help='SAM2 model checkpoint')
    parser.add_argument('--min-confidence', type=float, default=0.3,
                        help='Minimum confidence for voting')
    parser.add_argument('--min-votes', type=int, default=2,
                        help='Minimum votes to assign label')
    
    args = parser.parse_args()
    
    run_semantic_segmentation(
        args.images_dir,
        args.mesh_path,
        args.colmap_dir,
        args.output_path,
        args.sam2_checkpoint,
        args.min_confidence,
        args.min_votes
    )


if __name__ == '__main__':
    main()
