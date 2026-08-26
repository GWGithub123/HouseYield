#!/usr/bin/env python3
"""
Feature Matching Module

Legacy photogrammetry now uses HLOC LightGlue matching managed inside
StructureFromMotion. This module remains only for data containers and older
offline utilities; the standalone matching CLI is intentionally disabled.
"""

import cv2
import numpy as np
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Set
from dataclasses import dataclass
from itertools import combinations
import json

from .feature_extraction import ImageFeatures


@dataclass
class ImageMatch:
    """Matches between two images"""
    image_id1: str
    image_id2: str
    matches: np.ndarray  # Nx2 array of (idx1, idx2) pairs
    scores: np.ndarray  # N array of match scores (lower = better)
    inlier_mask: Optional[np.ndarray] = None  # Boolean mask after geometric verification
    
    @property
    def num_matches(self) -> int:
        return len(self.matches)
    
    @property
    def num_inliers(self) -> int:
        if self.inlier_mask is None:
            return self.num_matches
        return int(self.inlier_mask.sum())
    
    def to_dict(self) -> Dict:
        return {
            'image_id1': self.image_id1,
            'image_id2': self.image_id2,
            'num_matches': self.num_matches,
            'num_inliers': self.num_inliers,
        }


class FeatureMatcher:
    """Match features between images"""
    
    def __init__(
        self,
        ratio_threshold: float = 0.75,
        min_matches: int = 15,
        geometric_verification: bool = True,
        ransac_threshold: float = 4.0,
    ):
        """
        Args:
            ratio_threshold: Lowe's ratio test threshold (0.7-0.8 typical)
            min_matches: Minimum matches to consider a valid pair
            geometric_verification: Apply RANSAC for geometric consistency
            ransac_threshold: Reprojection threshold for RANSAC (pixels)
        """
        self.ratio_threshold = ratio_threshold
        self.min_matches = min_matches
        self.geometric_verification = geometric_verification
        self.ransac_threshold = ransac_threshold
        
        # Initialize FLANN matcher
        # For SIFT (128-dim float descriptors)
        FLANN_INDEX_KDTREE = 1
        index_params = dict(algorithm=FLANN_INDEX_KDTREE, trees=5)
        search_params = dict(checks=50)
        self.flann = cv2.FlannBasedMatcher(index_params, search_params)
        
        print(f"[FeatureMatcher] Initialized with ratio={ratio_threshold}, "
              f"min_matches={min_matches}, geometric_verify={geometric_verification}")
    
    def match_pair(
        self,
        features1: ImageFeatures,
        features2: ImageFeatures,
    ) -> Optional[ImageMatch]:
        """Match features between two images"""
        
        if len(features1.descriptors) < self.min_matches or \
           len(features2.descriptors) < self.min_matches:
            return None
        
        # KNN matching with k=2 for ratio test
        try:
            knn_matches = self.flann.knnMatch(
                features1.descriptors.astype(np.float32),
                features2.descriptors.astype(np.float32),
                k=2
            )
        except cv2.error as e:
            print(f"[FeatureMatcher] Warning: Matching failed: {e}")
            return None
        
        # Apply Lowe's ratio test
        good_matches = []
        match_scores = []
        
        for match_pair in knn_matches:
            if len(match_pair) < 2:
                continue
            m, n = match_pair
            if m.distance < self.ratio_threshold * n.distance:
                good_matches.append((m.queryIdx, m.trainIdx))
                match_scores.append(m.distance)
        
        if len(good_matches) < self.min_matches:
            return None
        
        matches = np.array(good_matches, dtype=np.int32)
        scores = np.array(match_scores, dtype=np.float32)
        
        # Geometric verification with fundamental matrix
        inlier_mask = None
        if self.geometric_verification:
            pts1 = features1.keypoints[matches[:, 0]]
            pts2 = features2.keypoints[matches[:, 1]]
            
            F, mask = cv2.findFundamentalMat(
                pts1, pts2,
                cv2.FM_RANSAC,
                self.ransac_threshold,
                0.999
            )
            
            if mask is not None:
                inlier_mask = mask.ravel().astype(bool)
                num_inliers = inlier_mask.sum()
                
                if num_inliers < self.min_matches:
                    return None
        
        return ImageMatch(
            image_id1=features1.image_id,
            image_id2=features2.image_id,
            matches=matches,
            scores=scores,
            inlier_mask=inlier_mask,
        )
    
    def match_all(
        self,
        features: Dict[str, ImageFeatures],
        strategy: str = "exhaustive",
        imu_data: Dict = None,
        max_temporal_gap: int = 10,
    ) -> Dict[Tuple[str, str], ImageMatch]:
        """
        Match all image pairs according to strategy.
        
        Args:
            features: Dict of image_id -> ImageFeatures
            strategy: "exhaustive", "sequential", or "spatial"
            imu_data: IMU data for spatial matching strategy
            max_temporal_gap: For sequential, max frames apart to match
        
        Returns:
            Dict of (image_id1, image_id2) -> ImageMatch
        """
        image_ids = sorted(features.keys())
        n_images = len(image_ids)
        
        if n_images < 2:
            return {}
        
        # Generate candidate pairs based on strategy
        if strategy == "exhaustive":
            pairs = list(combinations(image_ids, 2))
        elif strategy == "sequential":
            pairs = self._get_sequential_pairs(image_ids, max_temporal_gap)
        elif strategy == "spatial":
            pairs = self._get_spatial_pairs(image_ids, imu_data)
        else:
            raise ValueError(f"Unknown matching strategy: {strategy}")
        
        print(f"[FeatureMatcher] Matching {len(pairs)} pairs ({strategy} strategy)...")
        
        matches = {}
        successful = 0
        
        for i, (id1, id2) in enumerate(pairs):
            match = self.match_pair(features[id1], features[id2])
            
            if match is not None:
                matches[(id1, id2)] = match
                successful += 1
            
            if (i + 1) % 100 == 0 or i == len(pairs) - 1:
                print(f"[FeatureMatcher] Progress: {i + 1}/{len(pairs)} pairs, "
                      f"{successful} successful")
        
        # Calculate statistics
        if matches:
            avg_matches = np.mean([m.num_matches for m in matches.values()])
            avg_inliers = np.mean([m.num_inliers for m in matches.values()])
            print(f"[FeatureMatcher] Found {len(matches)} valid pairs "
                  f"(avg {avg_matches:.0f} matches, {avg_inliers:.0f} inliers)")
        
        return matches
    
    def _get_sequential_pairs(
        self, 
        image_ids: List[str], 
        max_gap: int
    ) -> List[Tuple[str, str]]:
        """Generate pairs for sequential/video data"""
        pairs = []
        n = len(image_ids)
        
        for i in range(n):
            for j in range(i + 1, min(i + max_gap + 1, n)):
                pairs.append((image_ids[i], image_ids[j]))
        
        return pairs
    
    def _get_spatial_pairs(
        self,
        image_ids: List[str],
        imu_data: Dict,
        max_distance: float = 3.0,
        max_angle: float = 120.0,
    ) -> List[Tuple[str, str]]:
        """
        Generate pairs based on spatial proximity from IMU data.
        Only match images that are close in position AND have overlapping views.
        """
        if not imu_data:
            # Fall back to exhaustive if no IMU data
            return list(combinations(image_ids, 2))
        
        pairs = []
        
        # Extract positions and orientations
        positions = {}
        orientations = {}
        
        for image_id in image_ids:
            if image_id in imu_data:
                positions[image_id] = np.array(imu_data[image_id].get('position', [0, 0, 0]))
                orientations[image_id] = np.array(imu_data[image_id].get('orientation', [0, 0, 0, 1]))
            else:
                # If no IMU data for this image, include it in all pairs
                positions[image_id] = None
                orientations[image_id] = None
        
        for i, id1 in enumerate(image_ids):
            for id2 in image_ids[i + 1:]:
                # If either has no position, include the pair
                if positions[id1] is None or positions[id2] is None:
                    pairs.append((id1, id2))
                    continue
                
                # Check distance
                dist = np.linalg.norm(positions[id1] - positions[id2])
                if dist > max_distance:
                    continue
                
                # Check viewing angle overlap (simplified)
                # In practice, use quaternion to compute view direction dot product
                pairs.append((id1, id2))
        
        return pairs
    
    def build_visibility_graph(
        self,
        matches: Dict[Tuple[str, str], ImageMatch],
    ) -> Dict[str, Set[str]]:
        """
        Build a graph of image visibility for connected component analysis.
        """
        graph = {}
        
        for (id1, id2), match in matches.items():
            if id1 not in graph:
                graph[id1] = set()
            if id2 not in graph:
                graph[id2] = set()
            
            graph[id1].add(id2)
            graph[id2].add(id1)
        
        return graph
    
    def find_connected_components(
        self,
        matches: Dict[Tuple[str, str], ImageMatch],
    ) -> List[Set[str]]:
        """Find connected components in the match graph"""
        graph = self.build_visibility_graph(matches)
        
        if not graph:
            return []
        
        visited = set()
        components = []
        
        def dfs(node: str, component: Set[str]):
            visited.add(node)
            component.add(node)
            for neighbor in graph.get(node, []):
                if neighbor not in visited:
                    dfs(neighbor, component)
        
        for node in graph:
            if node not in visited:
                component = set()
                dfs(node, component)
                components.append(component)
        
        components.sort(key=len, reverse=True)
        return components


def save_matches(
    matches: Dict[Tuple[str, str], ImageMatch],
    output_path: Path,
):
    """Save matches to JSON file"""
    output = {
        'num_pairs': len(matches),
        'pairs': [],
    }
    
    for (id1, id2), match in matches.items():
        output['pairs'].append({
            'image1': id1,
            'image2': id2,
            'num_matches': match.num_matches,
            'num_inliers': match.num_inliers,
        })
    
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Legacy standalone matching is disabled; use pipeline.py or StructureFromMotion')
    parser.add_argument('images_dir', help='Directory containing images')
    parser.add_argument('--strategy', default='exhaustive', 
                       choices=['exhaustive', 'sequential', 'spatial'])
    parser.add_argument('--ratio', type=float, default=0.75)
    parser.add_argument('--min-matches', type=int, default=15)
    parser.add_argument('--output', '-o', help='Output matches file')
    
    args = parser.parse_args()

    raise RuntimeError(
        'legacy_photogrammetry_lightglue_matching_is_managed_by_hloc '
        '(use pipeline.py or StructureFromMotion instead of feature_matching.py)'
    )
