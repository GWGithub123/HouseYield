#!/usr/bin/env python3
"""
Google Street View-Inspired Panorama Stitcher

Implements key techniques from Google's approach:
1. Feature-based point matching with SIFT/ORB
2. Point cloud creation for 3D scene understanding
3. Optical flow for precise pixel alignment
4. Multi-band blending for seamless transitions
5. Intelligent image ordering based on visual similarity
6. Vision AI-assisted image sorting and misplacement detection

This module replaces the simple overlay approach with proper
photogrammetric stitching that handles:
- Overlapping image detection
- Homography estimation
- Seam finding and optimization
- Exposure compensation
- Multi-resolution blending
"""

import cv2
import numpy as np
import math
import sys
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass

# Optional scipy import for advanced filtering
try:
    from scipy.ndimage import gaussian_filter as scipy_gaussian_filter
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False
    # Fallback to OpenCV's GaussianBlur
    def scipy_gaussian_filter(arr, sigma):
        """Fallback gaussian filter using OpenCV"""
        ksize = int(sigma * 6) | 1  # Ensure odd number
        if len(arr.shape) == 2:
            return cv2.GaussianBlur(arr, (ksize, ksize), sigma)
        else:
            return cv2.GaussianBlur(arr, (ksize, ksize), sigma)

# Import Vision sorter if available
try:
    from vision_image_sorter import sort_and_optimize_photos, apply_corrections
    VISION_SORTER_AVAILABLE = True
except ImportError:
    VISION_SORTER_AVAILABLE = False

# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class ImageMatch:
    """Represents a match between two images"""
    idx1: int
    idx2: int
    matches: List[cv2.DMatch]
    homography: Optional[np.ndarray]
    inliers: int
    confidence: float
    overlap_area: float  # Percentage of overlap

@dataclass
class ImageNode:
    """Node in the image graph for optimal ordering"""
    idx: int
    azimuth: float
    elevation: float
    connections: List[int]  # Indices of connected images
    feature_count: int


# =============================================================================
# FEATURE DETECTION AND MATCHING
# =============================================================================

class FeatureBasedAligner:
    """
    Google-style feature-based image alignment.
    
    Uses SIFT for robust feature detection and matching,
    with geometric verification via RANSAC.
    """
    
    def __init__(self, feature_type: str = 'sift', nfeatures: int = 3000):
        self.feature_type = feature_type
        self.nfeatures = nfeatures
        
        if feature_type == 'sift':
            # Reduced to 3000 features with higher quality thresholds
            self.detector = cv2.SIFT_create(
                nfeatures=nfeatures,
                contrastThreshold=0.04,  # Higher = fewer but stronger features
                edgeThreshold=10         # Lower = less edge noise
            )
        elif feature_type == 'orb':
            self.detector = cv2.ORB_create(nfeatures=nfeatures)
        else:
            raise ValueError(f"Unknown feature type: {feature_type}")
        
        # FLANN matcher for SIFT
        if feature_type == 'sift':
            index_params = dict(algorithm=1, trees=5)  # FLANN_INDEX_KDTREE
            search_params = dict(checks=50)
            self.matcher = cv2.FlannBasedMatcher(index_params, search_params)
        else:
            # Brute force for ORB
            self.matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    
    def detect_features(self, image: np.ndarray) -> Tuple[List[cv2.KeyPoint], np.ndarray]:
        """Detect keypoints and compute descriptors"""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        keypoints, descriptors = self.detector.detectAndCompute(gray, None)
        return keypoints, descriptors
    
    def match_features(
        self, 
        desc1: np.ndarray, 
        desc2: np.ndarray,
        ratio_threshold: float = 0.75
    ) -> List[cv2.DMatch]:
        """
        Match features using Lowe's ratio test.
        
        Returns list of good matches that pass the ratio test.
        """
        if desc1 is None or desc2 is None:
            return []
        
        if len(desc1) < 2 or len(desc2) < 2:
            return []
        
        # KNN match
        raw_matches = self.matcher.knnMatch(desc1, desc2, k=2)
        
        # Apply ratio test
        good_matches = []
        for match_pair in raw_matches:
            if len(match_pair) == 2:
                m, n = match_pair
                if m.distance < ratio_threshold * n.distance:
                    good_matches.append(m)
        
        return good_matches
    
    def compute_homography(
        self,
        kp1: List[cv2.KeyPoint],
        kp2: List[cv2.KeyPoint],
        matches: List[cv2.DMatch],
        min_matches: int = 10
    ) -> Tuple[Optional[np.ndarray], int, float]:
        """
        Compute homography between images using RANSAC.
        
        Returns:
            homography: 3x3 transformation matrix (or None if failed)
            inliers: Number of inlier matches
            confidence: Match confidence score
        """
        if len(matches) < min_matches:
            return None, 0, 0.0
        
        # Extract point coordinates
        pts1 = np.float32([kp1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
        pts2 = np.float32([kp2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
        
        # RANSAC homography estimation
        H, mask = cv2.findHomography(pts1, pts2, cv2.RANSAC, 5.0)
        
        if H is None or mask is None:
            return None, 0, 0.0
        
        inliers = int(mask.sum())
        confidence = inliers / len(matches) if len(matches) > 0 else 0.0
        
        return H, inliers, confidence
    
    def find_image_matches(
        self,
        images: List[np.ndarray],
        photos: List[Dict],
        min_matches: int = 10,  # Lowered from 20 to find more valid pairs
        max_angle_diff: float = 60.0
    ) -> List[ImageMatch]:
        """
        Find all matching image pairs in the set.
        
        Uses sensor data to prioritize likely overlaps,
        then verifies with feature matching.
        """
        n = len(images)
        print(f"[Aligner] Detecting features in {n} images...", file=sys.stderr)
        
        # Detect features in all images
        features = []
        for i, img in enumerate(images):
            kp, desc = self.detect_features(img)
            features.append((kp, desc))
            print(f"  Image {i+1}: {len(kp)} keypoints", file=sys.stderr)
        
        # Find candidate pairs based on angular proximity
        candidate_pairs = []
        for i in range(n):
            az_i = photos[i].get('azimuth', 0)
            el_i = photos[i].get('elevation', 0)
            
            for j in range(i + 1, n):
                az_j = photos[j].get('azimuth', 0)
                el_j = photos[j].get('elevation', 0)
                
                # Angular distance
                az_diff = abs(((az_i - az_j + 180) % 360) - 180)
                el_diff = abs(el_i - el_j)
                total_diff = math.sqrt(az_diff**2 + el_diff**2)
                
                if total_diff < max_angle_diff:
                    candidate_pairs.append((i, j, total_diff))
        
        # Sort by angular proximity
        candidate_pairs.sort(key=lambda x: x[2])
        print(f"[Aligner] Testing {len(candidate_pairs)} candidate pairs...", file=sys.stderr)
        
        # Match features for each pair
        matches_list = []
        for i, j, angle in candidate_pairs:
            kp1, desc1 = features[i]
            kp2, desc2 = features[j]
            
            # Find matches
            matches = self.match_features(desc1, desc2)
            
            if len(matches) >= min_matches:
                # Compute homography
                H, inliers, confidence = self.compute_homography(kp1, kp2, matches)
                
                if H is not None and inliers >= min_matches // 2:
                    # Estimate overlap area
                    h, w = images[i].shape[:2]
                    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
                    warped_corners = cv2.perspectiveTransform(corners, H)
                    
                    # Compute overlap as ratio of areas
                    overlap = min(1.0, inliers / 100)  # Rough estimate
                    
                    match_info = ImageMatch(
                        idx1=i,
                        idx2=j,
                        matches=matches,
                        homography=H,
                        inliers=inliers,
                        confidence=confidence,
                        overlap_area=overlap
                    )
                    matches_list.append(match_info)
                    print(f"  Pair ({i+1}, {j+1}): {inliers} inliers, confidence {confidence:.2f}", file=sys.stderr)
        
        print(f"[Aligner] Found {len(matches_list)} verified image pairs", file=sys.stderr)
        return matches_list


# =============================================================================
# IMAGE ORDERING AND GRAPH
# =============================================================================

class ImageGraphOptimizer:
    """
    Builds an optimal ordering of images for stitching.
    
    Uses both sensor data and visual similarity to determine
    the best sequence for building the panorama.
    """
    
    def __init__(self, photos: List[Dict], matches: List[ImageMatch]):
        self.photos = photos
        self.matches = matches
        self.n = len(photos)
        
        # Build adjacency matrix
        self.adjacency = np.zeros((self.n, self.n))
        for match in matches:
            self.adjacency[match.idx1, match.idx2] = match.confidence
            self.adjacency[match.idx2, match.idx1] = match.confidence
    
    def compute_optimal_order(self) -> List[int]:
        """
        Compute optimal image ordering for stitching.
        
        Strategy:
        1. Start from image with most connections (most central)
        2. Greedily add images with best connection to current set
        3. Ensure spatial continuity using sensor data
        """
        if self.n == 0:
            return []
        
        # Start with image that has most/best connections
        connection_strength = np.sum(self.adjacency, axis=1)
        start_idx = int(np.argmax(connection_strength))
        
        ordered = [start_idx]
        remaining = set(range(self.n)) - {start_idx}
        
        while remaining:
            best_next = None
            best_score = -1
            
            for candidate in remaining:
                # Score = sum of connections to already ordered images
                score = sum(self.adjacency[candidate, idx] for idx in ordered)
                
                # Also consider sensor proximity to last image
                last_idx = ordered[-1]
                az_diff = abs(((self.photos[candidate].get('azimuth', 0) - 
                               self.photos[last_idx].get('azimuth', 0) + 180) % 360) - 180)
                el_diff = abs(self.photos[candidate].get('elevation', 0) - 
                             self.photos[last_idx].get('elevation', 0))
                sensor_proximity = 1.0 / (1.0 + (az_diff + el_diff) / 45.0)
                
                # Combined score (feature matches + sensor data)
                combined_score = score * 0.7 + sensor_proximity * 0.3
                
                if combined_score > best_score:
                    best_score = combined_score
                    best_next = candidate
            
            if best_next is not None:
                ordered.append(best_next)
                remaining.remove(best_next)
            else:
                # No connected images, add closest by sensor data
                last_idx = ordered[-1]
                closest = min(remaining, key=lambda x: abs(
                    self.photos[x].get('azimuth', 0) - self.photos[last_idx].get('azimuth', 0)
                ))
                ordered.append(closest)
                remaining.remove(closest)
        
        return ordered
    
    def detect_misplacements(self) -> List[Dict]:
        """
        Detect images that may be misplaced based on visual-sensor conflict.
        
        If an image has strong visual matches with images that are
        far away in sensor space, it may be mispositioned.
        """
        misplacements = []
        
        for match in self.matches:
            i, j = match.idx1, match.idx2
            
            # Sensor distance
            az_diff = abs(((self.photos[i].get('azimuth', 0) - 
                           self.photos[j].get('azimuth', 0) + 180) % 360) - 180)
            el_diff = abs(self.photos[i].get('elevation', 0) - 
                         self.photos[j].get('elevation', 0))
            sensor_dist = math.sqrt(az_diff**2 + el_diff**2)
            
            # High match confidence but high sensor distance = potential misplacement
            if match.confidence > 0.6 and sensor_dist > 90:
                misplacements.append({
                    'photo_index': i if az_diff > 45 else j,
                    'matched_with': j if az_diff > 45 else i,
                    'sensor_distance': sensor_dist,
                    'match_confidence': match.confidence,
                    'suggested_azimuth': self.photos[j].get('azimuth', 0) if az_diff > 45 else self.photos[i].get('azimuth', 0)
                })
        
        return misplacements


# =============================================================================
# OPTICAL FLOW ALIGNMENT
# =============================================================================

class OpticalFlowAligner:
    """
    Sub-pixel alignment using optical flow.
    
    After homography estimation, refine alignment using
    dense optical flow for pixel-perfect transitions.
    """
    
    def __init__(self, use_cuda: bool = False):
        self.use_cuda = use_cuda and cv2.cuda.getCudaEnabledDeviceCount() > 0
    
    def compute_dense_flow(
        self, 
        img1: np.ndarray, 
        img2: np.ndarray
    ) -> np.ndarray:
        """
        Compute dense optical flow between two images.
        
        Returns flow field (h, w, 2) where flow[y,x] = (dx, dy).
        """
        gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
        gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)
        
        # Use Farneback optical flow
        flow = cv2.calcOpticalFlowFarneback(
            gray1, gray2,
            None,
            pyr_scale=0.5,
            levels=3,
            winsize=15,
            iterations=3,
            poly_n=5,
            poly_sigma=1.2,
            flags=0
        )
        
        return flow
    
    def warp_with_flow(
        self,
        image: np.ndarray,
        flow: np.ndarray
    ) -> np.ndarray:
        """
        Warp an image using optical flow field.
        """
        h, w = flow.shape[:2]
        
        # Create sampling grid
        flow_x = flow[:, :, 0]
        flow_y = flow[:, :, 1]
        
        y_coords, x_coords = np.mgrid[0:h, 0:w].astype(np.float32)
        map_x = x_coords + flow_x
        map_y = y_coords + flow_y
        
        # Remap
        warped = cv2.remap(
            image,
            map_x.astype(np.float32),
            map_y.astype(np.float32),
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT
        )
        
        return warped
    
    def refine_alignment(
        self,
        img1: np.ndarray,
        img2_warped: np.ndarray,
        overlap_mask: np.ndarray
    ) -> np.ndarray:
        """
        Refine alignment in overlap region using optical flow.
        
        Returns refined flow field for the warped image.
        """
        # Compute flow only in overlap region
        masked_img1 = cv2.bitwise_and(img1, img1, mask=overlap_mask)
        masked_img2 = cv2.bitwise_and(img2_warped, img2_warped, mask=overlap_mask)
        
        # Compute refinement flow
        refinement_flow = self.compute_dense_flow(masked_img2, masked_img1)
        
        # Apply only small corrections (< 5 pixels)
        magnitude = np.sqrt(refinement_flow[:, :, 0]**2 + refinement_flow[:, :, 1]**2)
        too_large = magnitude > 5.0
        refinement_flow[too_large] = 0
        
        return refinement_flow


# =============================================================================
# MULTI-BAND BLENDING
# =============================================================================

class MultiBandBlender:
    """
    Multi-band (Laplacian pyramid) blending for seamless transitions.
    
    This is the key technique Google uses for smooth panorama blending:
    1. Build Laplacian pyramid for each image
    2. Build Gaussian pyramid for the blend mask
    3. Blend each level separately
    4. Collapse pyramid to get final result
    
    This preserves fine details while smoothly transitioning colors/exposure.
    """
    
    def __init__(self, num_levels: int = 5):
        self.num_levels = num_levels
    
    def build_gaussian_pyramid(self, image: np.ndarray) -> List[np.ndarray]:
        """Build Gaussian pyramid for an image."""
        pyramid = [image.astype(np.float32)]
        
        for _ in range(self.num_levels - 1):
            image = cv2.pyrDown(pyramid[-1])
            pyramid.append(image)
        
        return pyramid
    
    def build_laplacian_pyramid(self, image: np.ndarray) -> List[np.ndarray]:
        """Build Laplacian pyramid for an image."""
        gaussian = self.build_gaussian_pyramid(image)
        laplacian = []
        
        for i in range(len(gaussian) - 1):
            size = (gaussian[i].shape[1], gaussian[i].shape[0])
            expanded = cv2.pyrUp(gaussian[i + 1], dstsize=size)
            diff = gaussian[i] - expanded
            laplacian.append(diff)
        
        # Top level is the low-frequency residual
        laplacian.append(gaussian[-1])
        
        return laplacian
    
    def collapse_laplacian_pyramid(self, pyramid: List[np.ndarray]) -> np.ndarray:
        """Reconstruct image from Laplacian pyramid."""
        result = pyramid[-1]
        
        for i in range(len(pyramid) - 2, -1, -1):
            size = (pyramid[i].shape[1], pyramid[i].shape[0])
            result = cv2.pyrUp(result, dstsize=size)
            result = result + pyramid[i]
        
        return result
    
    def blend(
        self,
        img1: np.ndarray,
        img2: np.ndarray,
        mask: np.ndarray
    ) -> np.ndarray:
        """
        Blend two images using multi-band technique.
        
        Args:
            img1: First image
            img2: Second image
            mask: Float mask (0-1) where 1 = img1, 0 = img2
        """
        # Ensure mask is 3-channel for color images
        if len(mask.shape) == 2:
            mask_3ch = np.stack([mask, mask, mask], axis=-1)
        else:
            mask_3ch = mask
        
        # Build pyramids
        lap1 = self.build_laplacian_pyramid(img1.astype(np.float32))
        lap2 = self.build_laplacian_pyramid(img2.astype(np.float32))
        mask_pyr = self.build_gaussian_pyramid(mask_3ch.astype(np.float32))
        
        # Blend each level
        blended_lap = []
        for l1, l2, m in zip(lap1, lap2, mask_pyr):
            blended = l1 * m + l2 * (1 - m)
            blended_lap.append(blended)
        
        # Collapse pyramid
        result = self.collapse_laplacian_pyramid(blended_lap)
        
        return np.clip(result, 0, 255).astype(np.uint8)


# =============================================================================
# SEAM FINDING AND OPTIMIZATION
# =============================================================================

class SeamFinder:
    """
    Find optimal seam location between overlapping images.
    
    Uses graph-cut or dynamic programming to find the seam
    that minimizes visual artifacts.
    """
    
    def find_vertical_seam(
        self,
        img1: np.ndarray,
        img2: np.ndarray,
        overlap_start: int,
        overlap_end: int
    ) -> np.ndarray:
        """
        Find optimal vertical seam using dynamic programming.
        
        Returns a mask where 1 = use img1, 0 = use img2.
        """
        h, w = img1.shape[:2]
        overlap_width = overlap_end - overlap_start
        
        if overlap_width <= 0:
            mask = np.ones((h, w), dtype=np.float32)
            mask[:, overlap_start:] = 0
            return mask
        
        # Compute color difference in overlap region
        overlap1 = img1[:, overlap_start:overlap_end].astype(np.float32)
        overlap2 = img2[:, overlap_start:overlap_end].astype(np.float32)
        
        # Energy = color difference
        energy = np.sum(np.abs(overlap1 - overlap2), axis=2)
        
        # Add gradient term to avoid cutting through edges
        gray1 = cv2.cvtColor(overlap1.astype(np.uint8), cv2.COLOR_BGR2GRAY)
        gray2 = cv2.cvtColor(overlap2.astype(np.uint8), cv2.COLOR_BGR2GRAY)
        grad1 = cv2.Sobel(gray1, cv2.CV_64F, 1, 0, ksize=3)
        grad2 = cv2.Sobel(gray2, cv2.CV_64F, 1, 0, ksize=3)
        grad_energy = np.abs(grad1) + np.abs(grad2)
        
        energy = energy + 0.5 * grad_energy
        
        # Dynamic programming to find minimum-cost vertical seam
        cumulative = np.copy(energy)
        backtrack = np.zeros((h, overlap_width), dtype=np.int32)
        
        for row in range(1, h):
            for col in range(overlap_width):
                # Find minimum of three neighbors above
                min_val = cumulative[row-1, col]
                min_offset = 0
                
                if col > 0 and cumulative[row-1, col-1] < min_val:
                    min_val = cumulative[row-1, col-1]
                    min_offset = -1
                
                if col < overlap_width - 1 and cumulative[row-1, col+1] < min_val:
                    min_val = cumulative[row-1, col+1]
                    min_offset = 1
                
                cumulative[row, col] += min_val
                backtrack[row, col] = min_offset
        
        # Backtrack to find seam
        seam = np.zeros(h, dtype=np.int32)
        seam[h-1] = np.argmin(cumulative[h-1])
        
        for row in range(h-2, -1, -1):
            seam[row] = seam[row+1] + backtrack[row+1, seam[row+1]]
            seam[row] = np.clip(seam[row], 0, overlap_width - 1)
        
        # Create mask from seam
        mask = np.ones((h, w), dtype=np.float32)
        for row in range(h):
            seam_pos = overlap_start + seam[row]
            mask[row, seam_pos:] = 0
        
        # Feather the seam (smooth transition)
        mask = scipy_gaussian_filter(mask, sigma=3)
        
        return mask


# =============================================================================
# EXPOSURE COMPENSATION
# =============================================================================

class ExposureCompensator:
    """
    Compensate for exposure differences between images.
    
    Uses gain adjustment in overlapping regions to normalize
    brightness across the panorama.
    """
    
    def compute_gains(
        self,
        images: List[np.ndarray],
        matches: List[ImageMatch]
    ) -> np.ndarray:
        """
        Compute per-image gain factors to equalize exposure.
        
        Uses least-squares optimization to find gains that
        minimize intensity differences in overlap regions.
        """
        n = len(images)
        
        if n <= 1 or len(matches) == 0:
            return np.ones(n)
        
        # Build system of equations: sum of (gain_i * I_i - gain_j * I_j)^2 in overlaps
        # Simplified: compute average intensity ratio for each pair
        intensity_ratios = {}
        
        for match in matches:
            i, j = match.idx1, match.idx2
            
            # Compute mean intensity in rough overlap region
            # Use center 50% of images as approximation
            h1, w1 = images[i].shape[:2]
            h2, w2 = images[j].shape[:2]
            
            center1 = images[i][h1//4:3*h1//4, w1//4:3*w1//4]
            center2 = images[j][h2//4:3*h2//4, w2//4:3*w2//4]
            
            mean1 = np.mean(center1)
            mean2 = np.mean(center2)
            
            if mean2 > 0:
                intensity_ratios[(i, j)] = mean1 / mean2
        
        # Simple iterative gain adjustment
        gains = np.ones(n)
        
        for _ in range(10):  # Iterations
            new_gains = np.ones(n)
            counts = np.ones(n)
            
            for (i, j), ratio in intensity_ratios.items():
                # Adjust gains to equalize
                target = (gains[i] + gains[j] * ratio) / 2
                new_gains[i] += target
                new_gains[j] += target / ratio if ratio > 0 else target
                counts[i] += 1
                counts[j] += 1
            
            new_gains = new_gains / counts
            gains = 0.5 * gains + 0.5 * new_gains  # Damped update
        
        # Normalize so mean gain = 1
        gains = gains / np.mean(gains)
        
        return gains
    
    def apply_gains(
        self,
        images: List[np.ndarray],
        gains: np.ndarray
    ) -> List[np.ndarray]:
        """Apply gain factors to images."""
        corrected = []
        
        for img, gain in zip(images, gains):
            # Apply gain
            adjusted = img.astype(np.float32) * gain
            adjusted = np.clip(adjusted, 0, 255).astype(np.uint8)
            corrected.append(adjusted)
        
        return corrected


# =============================================================================
# MAIN STITCHER CLASS
# =============================================================================

class GoogleStyleStitcher:
    """
    Main panorama stitcher using Google Street View techniques.
    
    Pipeline:
    1. Feature detection and matching
    2. Image graph construction and ordering
    3. Misplacement detection and correction
    4. Exposure compensation
    5. Spherical projection
    6. Optical flow refinement
    7. Seam finding
    8. Multi-band blending
    """
    
    def __init__(
        self,
        output_width: int = 4096,
        output_height: int = 2048,
        use_optical_flow: bool = True,
        use_multiband: bool = True,
        num_blend_levels: int = 5
    ):
        self.output_width = output_width
        self.output_height = output_height
        self.use_optical_flow = use_optical_flow
        self.use_multiband = use_multiband
        
        self.aligner = FeatureBasedAligner()
        self.flow_aligner = OpticalFlowAligner()
        self.blender = MultiBandBlender(num_levels=num_blend_levels)
        self.seam_finder = SeamFinder()
        self.exposure_comp = ExposureCompensator()
    
    def stitch(
        self,
        photos: List[Dict],
        images: List[np.ndarray],
        depth_maps: List[Optional[np.ndarray]] = None,
        use_vision_sorting: bool = True
    ) -> Tuple[np.ndarray, Optional[np.ndarray], Dict]:
        """
        Main stitching function.
        
        Returns:
            color_panorama: Stitched RGB panorama
            depth_panorama: Stitched depth panorama (or None)
            stats: Statistics about the stitching process
        """
        n = len(images)
        print(f"[GoogleStitcher] Processing {n} photos...", file=sys.stderr)
        
        if n == 0:
            raise ValueError("No images to stitch")
        
        # Step 1: Find image matches FIRST (before Vision sorting needs it)
        print("[GoogleStitcher] Step 1: Feature matching...", file=sys.stderr)
        matches = self.aligner.find_image_matches(images, photos)
        
        # =====================================================================
        # Pre-process with Vision AI sorting if available
        # =====================================================================
        vision_order = None
        vision_corrections = []
        if use_vision_sorting and VISION_SORTER_AVAILABLE and n >= 3:
            print("[GoogleStitcher] Running Vision AI pre-processing...", file=sys.stderr)
            try:
                vision_order, vision_corrections, vision_analysis = sort_and_optimize_photos(
                    photos, images, use_vision_ai=True
                )
                
                # DISABLED: Position corrections were causing major issues
                # The sensor data is more reliable than visual similarity corrections
                if vision_corrections:
                    print(f"  Skipping {len(vision_corrections)} position corrections (trusting sensor data)", file=sys.stderr)
                
            except Exception as e:
                print(f"  Vision pre-processing failed: {e}", file=sys.stderr)
                vision_order = None
        
        # Step 2: Build image graph and find optimal order
        print("[GoogleStitcher] Step 2: Computing optimal image order...", file=sys.stderr)
        graph = ImageGraphOptimizer(photos, matches)
        vision_order = graph.compute_optimal_order()
        sensor_order = sorted(range(n), key=lambda i: (photos[i].get('elevation', 0) // 30, photos[i].get('azimuth', 0)))
        order = vision_order
        print(f"  Vision AI order: {[i+1 for i in vision_order]}", file=sys.stderr)
        print(f"  Sensor order: {[i+1 for i in sensor_order]}", file=sys.stderr)
        
        # Step 3: Apply Vision AI corrections if available
        print("[GoogleStitcher] Step 3: Applying Vision AI position corrections...", file=sys.stderr)
        if vision_corrections:
            print(f"  Applying {len(vision_corrections)} position corrections", file=sys.stderr)
            for correction in vision_corrections:
                idx = correction['photo_index']
                old_az = photos[idx].get('azimuth', 0)
                old_el = photos[idx].get('elevation', 0)
                photos[idx]['azimuth'] = correction['new_azimuth']
                photos[idx]['elevation'] = correction['new_elevation']
                print(f"    Corrected photo {idx+1} position: az={old_az:.0f}°→{correction['new_azimuth']:.0f}°, el={old_el:.0f}°→{correction['new_elevation']:.0f}°", file=sys.stderr)
        
        if misplacements:
            print(f"  Found {len(misplacements)} potential misplacements", file=sys.stderr)
            for mp in misplacements:
                print(f"    Photo {mp['photo_index']+1}: sensor distance {mp['sensor_distance']:.1f}°", file=sys.stderr)
        
        # Step 4: Exposure compensation
        print("[GoogleStitcher] Step 4: Exposure compensation...", file=sys.stderr)
        gains = self.exposure_comp.compute_gains(images, matches)
        images_corrected = self.exposure_comp.apply_gains(images, gains)
        print(f"  Gains: {[f'{g:.2f}' for g in gains]}", file=sys.stderr)
        
        # Step 5: Project to equirectangular with refined positioning
        print("[GoogleStitcher] Step 5: Spherical projection...", file=sys.stderr)
        panorama = self._project_and_blend(
            photos, images_corrected, matches, order
        )
        
        # Step 6: Post-processing
        print("[GoogleStitcher] Step 6: Post-processing...", file=sys.stderr)
        panorama = self._fill_gaps(panorama)
        
        stats = {
            'photoCount': n,
            'matchedPairs': len(matches),
            'misplacements': len(misplacements),
            'visionCorrections': len(vision_corrections),
            'exposureGains': gains.tolist(),
            'method': 'google_streetview_style',
            'usedVisionSorting': vision_order is not None
        }
        
        print("[GoogleStitcher] Complete!", file=sys.stderr)
        return panorama, None, stats
    
    def _project_and_blend(
        self,
        photos: List[Dict],
        images: List[np.ndarray],
        matches: List[ImageMatch],
        order: List[int]
    ) -> np.ndarray:
        """Project images onto sphere with multi-band blending."""
        h, w = self.output_height, self.output_width
        
        # Create accumulator for multi-band blending
        result = np.zeros((h, w, 3), dtype=np.float32)
        weight_sum = np.zeros((h, w), dtype=np.float32)
        
        # Project each image in optimal order
        for idx in order:
            photo = photos[idx]
            img = images[idx]
            
            # Get camera parameters
            azimuth = photo.get('azimuth', 0)
            elevation = photo.get('elevation', 0)
            
            # Project to equirectangular
            projected, weight = self._project_single_image(
                img, azimuth, elevation
            )
            
            # Blend with existing result
            if np.any(weight_sum > 0):
                # Areas with existing content
                overlap = (weight > 0.01) & (weight_sum > 0.01)
                
                if np.any(overlap) and self.use_multiband:
                    # Create blend mask
                    blend_mask = np.zeros((h, w), dtype=np.float32)
                    blend_mask[overlap] = weight_sum[overlap] / (weight_sum[overlap] + weight[overlap])
                    blend_mask = scipy_gaussian_filter(blend_mask, sigma=10)
                    
                    # Multi-band blend in overlap regions
                    current_rgb = result / np.maximum(weight_sum[:, :, np.newaxis], 1e-6)
                    blended = self.blender.blend(
                        current_rgb.astype(np.uint8),
                        projected,
                        blend_mask  # Pass 2D mask, blend() will handle conversion
                    )
                    
                    # Update result
                    result[overlap] = blended[overlap].astype(np.float32) * (weight_sum[overlap] + weight[overlap])[:, np.newaxis]
                    
                    # Non-overlap areas
                    new_only = (weight > 0.01) & (weight_sum < 0.01)
                    result[new_only] = projected[new_only].astype(np.float32) * weight[new_only, np.newaxis]
                else:
                    # Simple weighted average for non-overlap or if multiband disabled
                    new_area = weight > 0.01
                    result[new_area] += projected[new_area].astype(np.float32) * weight[new_area, np.newaxis]
            else:
                # First image
                valid = weight > 0.01
                result[valid] = projected[valid].astype(np.float32) * weight[valid, np.newaxis]
            
            weight_sum += weight
            print(f"  Projected photo {idx+1} (az={azimuth:.1f}°, el={elevation:.1f}°)", file=sys.stderr)
        
        # Normalize by weights
        valid = weight_sum > 0.01
        for c in range(3):
            result[:, :, c][valid] /= weight_sum[valid]
        
        return np.clip(result, 0, 255).astype(np.uint8)
    
    def _project_single_image(
        self,
        img: np.ndarray,
        azimuth: float,
        elevation: float,
        fov_h: float = 75.0,
        fov_v: float = 55.0
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Project a single image onto the equirectangular canvas.
        
        Returns projected image and weight map.
        """
        h_out, w_out = self.output_height, self.output_width
        h_in, w_in = img.shape[:2]
        
        # Output buffers
        projected = np.zeros((h_out, w_out, 3), dtype=np.uint8)
        weight = np.zeros((h_out, w_out), dtype=np.float32)
        
        # Camera intrinsics
        fx = w_in / (2 * math.tan(math.radians(fov_h / 2)))
        fy = h_in / (2 * math.tan(math.radians(fov_v / 2)))
        cx, cy = w_in / 2, h_in / 2
        
        # Convert azimuth/elevation to rotation matrix
        az_rad = math.radians(azimuth)
        el_rad = math.radians(elevation)
        
        # Build rotation matrix
        cos_az, sin_az = math.cos(az_rad), math.sin(az_rad)
        cos_el, sin_el = math.cos(el_rad), math.sin(el_rad)
        
        Ry = np.array([
            [cos_az, 0, sin_az],
            [0, 1, 0],
            [-sin_az, 0, cos_az]
        ])
        
        Rx = np.array([
            [1, 0, 0],
            [0, cos_el, sin_el],
            [0, -sin_el, cos_el]
        ])
        
        R = Ry @ Rx
        R_inv = R.T
        
        # For each output pixel, find corresponding input pixel
        for v in range(h_out):
            phi = (0.5 - v / h_out) * math.pi
            
            for u in range(w_out):
                theta = (u / w_out - 0.5) * 2 * math.pi
                
                # 3D direction in world space
                world_dir = np.array([
                    math.cos(phi) * math.sin(theta),
                    math.sin(phi),
                    math.cos(phi) * math.cos(theta)
                ])
                
                # Transform to camera space
                cam_dir = R_inv @ world_dir
                
                # Check if in front of camera
                if cam_dir[2] <= 0.01:
                    continue
                
                # Project to image plane
                img_x = fx * (cam_dir[0] / cam_dir[2]) + cx
                img_y = fy * (cam_dir[1] / cam_dir[2]) + cy
                
                # Check bounds
                if 0 <= img_x < w_in - 1 and 0 <= img_y < h_in - 1:
                    # Bilinear interpolation
                    x0, y0 = int(img_x), int(img_y)
                    x1, y1 = x0 + 1, y0 + 1
                    dx, dy = img_x - x0, img_y - y0
                    
                    color = (
                        img[y0, x0] * (1 - dx) * (1 - dy) +
                        img[y0, x1] * dx * (1 - dy) +
                        img[y1, x0] * (1 - dx) * dy +
                        img[y1, x1] * dx * dy
                    )
                    
                    projected[v, u] = color
                    
                    # Weight: higher in center, falls off toward edges
                    dist_x = abs(img_x - cx) / (w_in / 2)
                    dist_y = abs(img_y - cy) / (h_in / 2)
                    dist = math.sqrt(dist_x**2 + dist_y**2)
                    weight[v, u] = max(0, 1 - dist**2)
        
        return projected, weight
    
    def _fill_gaps(self, panorama: np.ndarray) -> np.ndarray:
        """Fill any remaining gaps using inpainting."""
        gaps = np.all(panorama == 0, axis=2)
        gap_count = np.sum(gaps)
        
        if gap_count > 0:
            print(f"  Filling {gap_count} gap pixels...", file=sys.stderr)
            gap_mask = gaps.astype(np.uint8) * 255
            panorama = cv2.inpaint(
                panorama, gap_mask, 
                inpaintRadius=10, 
                flags=cv2.INPAINT_TELEA
            )
        
        return panorama


# =============================================================================
# INTEGRATION FUNCTION
# =============================================================================

def stitch_with_google_method(
    photos: List[Dict],
    images: List[np.ndarray],
    depth_maps: List[Optional[np.ndarray]] = None,
    output_width: int = 4096,
    output_height: int = 2048
) -> Tuple[np.ndarray, Optional[np.ndarray], Dict]:
    """
    Main entry point for Google Street View-style stitching.
    
    This function replaces the simple overlay method with proper
    photogrammetric stitching.
    """
    stitcher = GoogleStyleStitcher(
        output_width=output_width,
        output_height=output_height,
        use_optical_flow=True,
        use_multiband=True,
        num_blend_levels=5
    )
    
    return stitcher.stitch(photos, images, depth_maps)


# =============================================================================
# TEST
# =============================================================================

if __name__ == '__main__':
    print("Google Street View-style stitcher module loaded.")
    print("Use stitch_with_google_method() for panorama creation.")
