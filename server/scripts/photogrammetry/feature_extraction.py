#!/usr/bin/env python3
"""
Feature Extraction Module

Legacy photogrammetry now requires the HLOC SuperPoint frontend managed inside
StructureFromMotion. Standalone local feature extraction is intentionally
disabled so the pipeline cannot fall back to SIFT.
"""

import os
import cv2
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import json


@dataclass
class ImageFeatures:
    """Container for extracted features"""
    image_id: str
    image_path: str
    keypoints: np.ndarray  # Nx2 array of (x, y) positions
    descriptors: np.ndarray  # NxD array of descriptors
    scales: np.ndarray  # N array of keypoint scales
    orientations: np.ndarray  # N array of keypoint orientations
    scores: np.ndarray  # N array of keypoint scores/responses
    image_size: Tuple[int, int]  # (width, height)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to serializable dict"""
        return {
            'image_id': self.image_id,
            'image_path': self.image_path,
            'num_keypoints': len(self.keypoints),
            'image_size': self.image_size,
        }
    
    def save(self, output_path: Path):
        """Save features to npz file"""
        np.savez_compressed(
            output_path,
            keypoints=self.keypoints,
            descriptors=self.descriptors,
            scales=self.scales,
            orientations=self.orientations,
            scores=self.scores,
            image_size=np.array(self.image_size),
        )
    
    @classmethod
    def load(cls, npz_path: Path, image_id: str, image_path: str) -> 'ImageFeatures':
        """Load features from npz file"""
        data = np.load(npz_path)
        return cls(
            image_id=image_id,
            image_path=image_path,
            keypoints=data['keypoints'],
            descriptors=data['descriptors'],
            scales=data['scales'],
            orientations=data['orientations'],
            scores=data['scores'],
            image_size=tuple(data['image_size']),
        )


class FeatureExtractor:
    """Extract visual features from images"""
    
    def __init__(
        self,
        feature_type: str = "superpoint",
        max_features: int = 3000,
        use_gpu: bool = False,
    ):
        self.feature_type = feature_type.lower()
        self.max_features = max_features
        self.use_gpu = use_gpu
        self.disabled_reason = (
            'legacy_photogrammetry_superpoint_extraction_is_managed_by_hloc '
            '(use StructureFromMotion or pipeline.py instead of FeatureExtractor)'
        )

        if self.feature_type != "superpoint":
            raise RuntimeError(
                f"legacy_photogrammetry_requires_superpoint_feature_type: received '{self.feature_type}'"
            )

        self._init_superpoint()
    
    def _init_sift(self):
        """Initialize SIFT detector"""
        # Use nOctaveLayers=3 for good scale coverage
        # contrastThreshold=0.04 filters weak features
        # edgeThreshold=10 filters edge-like features
        self.detector = cv2.SIFT_create(
            nfeatures=self.max_features,
            nOctaveLayers=3,
            contrastThreshold=0.04,
            edgeThreshold=10,
            sigma=1.6,
        )
        print(f"[FeatureExtractor] Initialized SIFT with max {self.max_features} features")
    
    def _init_superpoint(self):
        """Initialize SuperPoint detector (requires torch)"""
        try:
            import torch
            self.device = torch.device('cuda' if torch.cuda.is_available() and self.use_gpu else 'cpu')
            print("[FeatureExtractor] Standalone SuperPoint extraction is disabled; HLOC manages sparse features")

        except ImportError as exc:
            raise RuntimeError('legacy_photogrammetry_requires_hloc_superpoint_lightglue_stack') from exc

    def _raise_managed_by_hloc(self):
        raise RuntimeError(self.disabled_reason)
    
    def extract(self, image_path: str, image_id: str = None) -> ImageFeatures:
        """Extract features from a single image"""
        self._raise_managed_by_hloc()

        image_path = Path(image_path)
        
        if image_id is None:
            image_id = image_path.stem
        
        # Load image
        image = cv2.imread(str(image_path))
        if image is None:
            raise ValueError(f"Could not load image: {image_path}")
        
        height, width = image.shape[:2]
        
        # Convert to grayscale for feature detection
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Optional: Apply CLAHE for better contrast in low-light areas
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray = clahe.apply(gray)
        
        # Extract features
        if self.feature_type == "sift":
            features = self._extract_sift(gray, image_id, str(image_path), (width, height))
        else:
            features = self._extract_sift(gray, image_id, str(image_path), (width, height))
        
        return features
    
    def _extract_sift(
        self, 
        gray: np.ndarray, 
        image_id: str, 
        image_path: str, 
        image_size: Tuple[int, int]
    ) -> ImageFeatures:
        """Extract SIFT features"""
        keypoints, descriptors = self.detector.detectAndCompute(gray, None)
        
        if descriptors is None:
            descriptors = np.zeros((0, 128), dtype=np.float32)
            keypoints = []
        
        # Convert keypoints to arrays
        num_kps = len(keypoints)
        
        kp_array = np.zeros((num_kps, 2), dtype=np.float32)
        scales = np.zeros(num_kps, dtype=np.float32)
        orientations = np.zeros(num_kps, dtype=np.float32)
        scores = np.zeros(num_kps, dtype=np.float32)
        
        for i, kp in enumerate(keypoints):
            kp_array[i] = [kp.pt[0], kp.pt[1]]
            scales[i] = kp.size
            orientations[i] = kp.angle
            scores[i] = kp.response
        
        return ImageFeatures(
            image_id=image_id,
            image_path=image_path,
            keypoints=kp_array,
            descriptors=descriptors,
            scales=scales,
            orientations=orientations,
            scores=scores,
            image_size=image_size,
        )
    
    def extract_all(
        self, 
        images_dir: Path,
        output_dir: Path = None,
        extensions: List[str] = None,
    ) -> Dict[str, ImageFeatures]:
        """Extract features from all images in a directory"""
        self._raise_managed_by_hloc()

        if extensions is None:
            extensions = ['.jpg', '.jpeg', '.png']
        
        images_dir = Path(images_dir)
        
        # Find all images
        image_files = []
        for ext in extensions:
            image_files.extend(images_dir.glob(f"*{ext}"))
            image_files.extend(images_dir.glob(f"*{ext.upper()}"))
        
        image_files = sorted(set(image_files))
        
        if not image_files:
            raise ValueError(f"No images found in {images_dir}")
        
        print(f"[FeatureExtractor] Extracting features from {len(image_files)} images...")
        
        # Create output directory if saving
        if output_dir:
            output_dir = Path(output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
        
        features = {}
        total_keypoints = 0
        
        for i, image_path in enumerate(image_files):
            image_id = image_path.stem
            
            try:
                feat = self.extract(str(image_path), image_id)
                features[image_id] = feat
                total_keypoints += len(feat.keypoints)
                
                # Save if output directory specified
                if output_dir:
                    feat.save(output_dir / f"{image_id}.npz")
                
                if (i + 1) % 10 == 0 or i == len(image_files) - 1:
                    print(f"[FeatureExtractor] Progress: {i + 1}/{len(image_files)} images")
                    
            except Exception as e:
                print(f"[FeatureExtractor] Warning: Failed to extract features from {image_path}: {e}")
                continue
        
        avg_keypoints = total_keypoints / len(features) if features else 0
        print(f"[FeatureExtractor] Extracted {total_keypoints} keypoints "
              f"(avg {avg_keypoints:.0f}/image) from {len(features)} images")
        
        return features


def detect_blur(image: np.ndarray) -> float:
    """
    Detect blur level in image using Laplacian variance.
    Lower values indicate more blur.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    variance = laplacian.var()
    return float(variance)


def preprocess_image(
    image: np.ndarray,
    target_size: int = 2048,
    apply_clahe: bool = True,
) -> Tuple[np.ndarray, float]:
    """
    Preprocess image for feature extraction.
    Returns preprocessed image and scale factor.
    """
    height, width = image.shape[:2]
    
    # Calculate scale to fit within target_size
    max_dim = max(width, height)
    if max_dim > target_size:
        scale = target_size / max_dim
        new_width = int(width * scale)
        new_height = int(height * scale)
        image = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_AREA)
    else:
        scale = 1.0
    
    # Apply CLAHE if requested
    if apply_clahe:
        if len(image.shape) == 3:
            # Apply to L channel in LAB space
            lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            lab[:, :, 0] = clahe.apply(lab[:, :, 0])
            image = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        else:
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            image = clahe.apply(image)
    
    return image, scale


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Legacy standalone feature extraction is disabled; use pipeline.py or StructureFromMotion')
    parser.add_argument('images_dir', help='Directory containing images')
    parser.add_argument('--output', '-o', help='Output directory for features')
    parser.add_argument('--type', default='superpoint', choices=['superpoint'])
    parser.add_argument('--max-features', type=int, default=3000)
    
    args = parser.parse_args()
    
    extractor = FeatureExtractor(
        feature_type=args.type,
        max_features=args.max_features,
    )
    
    features = extractor.extract_all(
        Path(args.images_dir),
        output_dir=Path(args.output) if args.output else None,
    )
    
    print(f"\nExtracted features from {len(features)} images")
    for image_id, feat in list(features.items())[:5]:
        print(f"  {image_id}: {len(feat.keypoints)} keypoints")
