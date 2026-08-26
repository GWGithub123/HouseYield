#!/usr/bin/env python3
"""
Vision-Based Image Sorter and Placement Optimizer

Uses OpenAI Vision to analyze photo content and determine optimal
positioning when sensor data alone may not be accurate enough.

Key Features:
1. Visual similarity analysis between adjacent photos
2. Detection of misplaced photos based on content mismatch
3. Optimal ordering based on visual continuity
4. Identification of duplicate/redundant photos
"""

import cv2
import numpy as np
import json
import base64
import os
import sys
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from openai import OpenAI

# Initialize OpenAI client
try:
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    OPENAI_AVAILABLE = True
except Exception:
    OPENAI_AVAILABLE = False
    client = None


@dataclass
class PhotoPlacement:
    """Represents the optimal placement for a photo"""
    index: int
    suggested_azimuth: float
    suggested_elevation: float
    confidence: float
    reason: str
    visual_neighbors: List[int]  # Indices of visually adjacent photos


def encode_image_for_vision(image: np.ndarray, max_size: int = 512) -> str:
    """Encode image to base64 for Vision API."""
    h, w = image.shape[:2]
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    
    _, buffer = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buffer).decode('utf-8')


def create_photo_grid(images: List[np.ndarray], max_cols: int = 4) -> Tuple[np.ndarray, List[Tuple[int, int, int, int]]]:
    """
    Create a grid of all photos for overview analysis.
    Returns the grid image and list of (x, y, w, h) for each photo.
    """
    n = len(images)
    if n == 0:
        return np.zeros((100, 100, 3), dtype=np.uint8), []
    
    # Calculate grid dimensions
    cols = min(n, max_cols)
    rows = (n + cols - 1) // cols
    
    # Target size per image
    cell_size = 200
    
    # Resize all images
    resized = []
    for img in images:
        h, w = img.shape[:2]
        scale = cell_size / max(h, w)
        resized_img = cv2.resize(img, None, fx=scale, fy=scale)
        
        # Pad to square
        pad_h = cell_size - resized_img.shape[0]
        pad_w = cell_size - resized_img.shape[1]
        padded = cv2.copyMakeBorder(
            resized_img,
            pad_h // 2, pad_h - pad_h // 2,
            pad_w // 2, pad_w - pad_w // 2,
            cv2.BORDER_CONSTANT, value=(50, 50, 50)
        )
        resized.append(padded)
    
    # Create grid
    grid_h = rows * cell_size
    grid_w = cols * cell_size
    grid = np.zeros((grid_h, grid_w, 3), dtype=np.uint8) + 30
    
    positions = []
    for i, img in enumerate(resized):
        row = i // cols
        col = i % cols
        y = row * cell_size
        x = col * cell_size
        grid[y:y+cell_size, x:x+cell_size] = img
        positions.append((x, y, cell_size, cell_size))
        
        # Add index label
        cv2.putText(grid, str(i+1), (x+5, y+25), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
    
    return grid, positions


def analyze_visual_adjacency(
    photos: List[Dict],
    images: List[np.ndarray]
) -> Dict:
    """
    Use OpenAI Vision to determine which photos are visually adjacent
    based on shared content, not just sensor data.
    
    This helps detect and fix misplacements.
    """
    if not OPENAI_AVAILABLE or len(images) < 2:
        return {'adjacency': [], 'confidence': 0}
    
    # Create overview grid
    grid, positions = create_photo_grid(images)
    grid_base64 = encode_image_for_vision(grid, max_size=1024)
    
    # Build context from sensor data
    sensor_info = []
    for i, photo in enumerate(photos):
        sensor_info.append(f"Photo {i+1}: az={photo.get('azimuth', 0):.0f}°, el={photo.get('elevation', 0):.0f}°")
    
    prompt = f"""Analyze these {len(images)} photos from a 360° room scan and determine which photos are VISUALLY adjacent (share overlapping content).

PHOTOS: Numbered 1-{len(images)} in the grid.

SENSOR DATA (camera orientation when each photo was taken):
{chr(10).join(sensor_info)}

TASK: Determine visual adjacency by looking for SHARED FEATURES between photos:
- Same wall sections, windows, doors visible in multiple photos
- Same furniture items appearing at edges of adjacent photos
- Continuous floor/ceiling patterns
- Light fixtures or decorations that span photos

For each photo, identify which other photos show OVERLAPPING content.
Also identify any photos that appear MISPLACED (sensor position doesn't match visual content).

Respond in JSON:
{{
  "visual_adjacency": [
    {{
      "photo": 1,
      "visually_adjacent_to": [2, 12],  // Photos that share visual content
      "overlap_description": "shares left wall with photo 2, shares right edge with photo 12"
    }},
    ...
  ],
  "misplaced_photos": [
    {{
      "photo": 5,
      "reason": "shows same wall as photo 2 but sensor says opposite side of room",
      "suggested_position_near": 2,
      "confidence": 0.85
    }}
  ],
  "duplicate_photos": [
    {{
      "photos": [3, 8],
      "reason": "nearly identical views, one can be removed"
    }}
  ],
  "suggested_order": [1, 2, 3, 4, 5, ...],  // Optimal order based on visual continuity
  "analysis_confidence": 0.8
}}"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{grid_base64}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=2000,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        print(f"[VisionSort] Visual adjacency analysis complete", file=sys.stderr)
        return result
        
    except Exception as e:
        print(f"[VisionSort] Error in adjacency analysis: {e}", file=sys.stderr)
        return {'adjacency': [], 'confidence': 0}


def compute_visual_similarity_matrix(
    images: List[np.ndarray]
) -> np.ndarray:
    """
    Compute pairwise visual similarity between all images using
    histogram comparison and feature matching.
    
    Returns NxN matrix of similarity scores (0-1).
    """
    n = len(images)
    similarity = np.zeros((n, n))
    
    # Compute color histograms
    histograms = []
    for img in images:
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [50, 60], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        histograms.append(hist)
    
    # Compare histograms
    for i in range(n):
        for j in range(i, n):
            if i == j:
                similarity[i, j] = 1.0
            else:
                score = cv2.compareHist(histograms[i], histograms[j], cv2.HISTCMP_CORREL)
                similarity[i, j] = max(0, score)
                similarity[j, i] = similarity[i, j]
    
    return similarity


def compute_optimal_visual_order(
    photos: List[Dict],
    images: List[np.ndarray],
    similarity_matrix: np.ndarray
) -> List[int]:
    """
    Compute optimal ordering that maximizes visual continuity.
    
    Uses a greedy approach starting from the photo with best
    overall connectivity, then adding photos that have the
    highest similarity to already-added photos.
    """
    n = len(photos)
    if n <= 1:
        return list(range(n))
    
    # Combine visual similarity with sensor proximity
    sensor_proximity = np.zeros((n, n))
    for i in range(n):
        az_i = photos[i].get('azimuth', 0)
        el_i = photos[i].get('elevation', 0)
        for j in range(n):
            az_j = photos[j].get('azimuth', 0)
            el_j = photos[j].get('elevation', 0)
            
            az_diff = abs(((az_i - az_j + 180) % 360) - 180)
            el_diff = abs(el_i - el_j)
            distance = (az_diff**2 + el_diff**2) ** 0.5
            
            # Convert to proximity (high = close)
            sensor_proximity[i, j] = 1.0 / (1.0 + distance / 45.0)
    
    # Combined score: 60% visual, 40% sensor
    combined = 0.6 * similarity_matrix + 0.4 * sensor_proximity
    
    # Greedy ordering
    connectivity = np.sum(combined, axis=1)
    start = int(np.argmax(connectivity))
    
    ordered = [start]
    remaining = set(range(n)) - {start}
    
    while remaining:
        last = ordered[-1]
        
        # Find most similar remaining photo
        best_score = -1
        best_next = None
        
        for candidate in remaining:
            score = combined[last, candidate]
            # Bonus for sensor continuity
            if len(ordered) >= 2:
                prev = ordered[-2]
                continuity = combined[prev, candidate]
                score = 0.7 * score + 0.3 * continuity
            
            if score > best_score:
                best_score = score
                best_next = candidate
        
        if best_next is not None:
            ordered.append(best_next)
            remaining.remove(best_next)
        else:
            # Fallback: add any remaining
            ordered.append(remaining.pop())
    
    return ordered


def detect_and_fix_misplacements(
    photos: List[Dict],
    images: List[np.ndarray],
    vision_analysis: Optional[Dict] = None
) -> List[Dict]:
    """
    Detect misplaced photos and suggest corrections.
    
    Combines:
    1. Visual similarity matrix
    2. Sensor data analysis
    3. Optional Vision AI analysis
    
    Returns list of correction suggestions.
    """
    n = len(photos)
    corrections = []
    
    # Compute visual similarity
    similarity = compute_visual_similarity_matrix(images)
    
    # For each photo, check if visually similar photos are also sensor-proximate
    for i in range(n):
        az_i = photos[i].get('azimuth', 0)
        el_i = photos[i].get('elevation', 0)
        
        # Find photos with high visual similarity
        visual_neighbors = []
        for j in range(n):
            if i != j and similarity[i, j] > 0.75:  # Higher similarity threshold to reduce false positives
                visual_neighbors.append((j, similarity[i, j]))
        
        # Sort by similarity
        visual_neighbors.sort(key=lambda x: -x[1])
        
        # Check if visual neighbors are also sensor neighbors
        for j, sim_score in visual_neighbors[:3]:  # Top 3 visual neighbors
            az_j = photos[j].get('azimuth', 0)
            el_j = photos[j].get('elevation', 0)
            
            az_diff = abs(((az_i - az_j + 180) % 360) - 180)
            el_diff = abs(el_i - el_j)
            sensor_dist = (az_diff**2 + el_diff**2) ** 0.5
            
            # Visual similarity high but sensor distance high = potential misplacement
            # MUCH STRICTER: 85% similarity, 90° distance minimum, max 150° correction
            if sim_score > 0.85 and sensor_dist > 90 and sensor_dist < 150:
                corrections.append({
                    'photo_index': i,
                    'issue': 'sensor_visual_mismatch',
                    'visually_similar_to': j,
                    'visual_similarity': float(sim_score),
                    'sensor_distance': float(sensor_dist),
                    'suggested_azimuth': az_j,
                    'suggested_elevation': el_j,
                    'confidence': min(0.9, sim_score)
                })
    
    # Add Vision AI analysis if available
    if vision_analysis and 'misplaced_photos' in vision_analysis:
        for mp in vision_analysis['misplaced_photos']:
            photo_idx = mp.get('photo', 1) - 1  # Convert to 0-indexed
            if 0 <= photo_idx < n:
                # Check if we already have a correction for this photo
                existing = [c for c in corrections if c['photo_index'] == photo_idx]
                if not existing:
                    near_idx = mp.get('suggested_position_near', 1) - 1
                    if 0 <= near_idx < n:
                        corrections.append({
                            'photo_index': photo_idx,
                            'issue': 'vision_detected_misplacement',
                            'reason': mp.get('reason', 'Vision AI detected misplacement'),
                            'suggested_azimuth': photos[near_idx].get('azimuth', 0),
                            'suggested_elevation': photos[near_idx].get('elevation', 0),
                            'confidence': mp.get('confidence', 0.7)
                        })
    
    return corrections


def sort_and_optimize_photos(
    photos: List[Dict],
    images: List[np.ndarray],
    use_vision_ai: bool = True
) -> Tuple[List[int], List[Dict], Dict]:
    """
    Main entry point for photo sorting and optimization.
    
    Returns:
        order: Optimal processing order (indices)
        corrections: List of position corrections to apply
        analysis: Full analysis results
    """
    print(f"[VisionSort] Analyzing {len(photos)} photos...", file=sys.stderr)
    
    # Compute visual similarity
    print("[VisionSort] Computing visual similarity matrix...", file=sys.stderr)
    similarity = compute_visual_similarity_matrix(images)
    
    # Vision AI analysis (optional)
    vision_analysis = None
    if use_vision_ai and OPENAI_AVAILABLE and len(images) <= 16:
        print("[VisionSort] Running Vision AI adjacency analysis...", file=sys.stderr)
        vision_analysis = analyze_visual_adjacency(photos, images)
    
    # Compute optimal order
    print("[VisionSort] Computing optimal order...", file=sys.stderr)
    if vision_analysis and 'suggested_order' in vision_analysis:
        # Use Vision AI suggested order
        order = [idx - 1 for idx in vision_analysis['suggested_order'] if 1 <= idx <= len(photos)]
        # Add any missing indices
        remaining = set(range(len(photos))) - set(order)
        order.extend(remaining)
    else:
        # Use visual similarity-based order
        order = compute_optimal_visual_order(photos, images, similarity)
    
    print(f"[VisionSort] Optimal order: {[i+1 for i in order]}", file=sys.stderr)
    
    # Detect misplacements
    print("[VisionSort] Detecting misplacements...", file=sys.stderr)
    corrections = detect_and_fix_misplacements(photos, images, vision_analysis)
    
    if corrections:
        print(f"[VisionSort] Found {len(corrections)} potential issues:", file=sys.stderr)
        for c in corrections:
            print(f"  Photo {c['photo_index']+1}: {c.get('issue', 'unknown')}", file=sys.stderr)
    
    analysis = {
        'optimal_order': order,
        'corrections': corrections,
        'similarity_matrix': similarity.tolist(),
        'vision_analysis': vision_analysis
    }
    
    return order, corrections, analysis


# =============================================================================
# INTEGRATION
# =============================================================================

def apply_corrections(
    photos: List[Dict],
    corrections: List[Dict],
    min_confidence: float = 0.7
) -> List[Dict]:
    """
    Apply position corrections to photos.
    
    Only applies corrections above the confidence threshold.
    """
    corrected = []
    
    for i, photo in enumerate(photos):
        new_photo = photo.copy()
        
        # Check for corrections
        photo_corrections = [c for c in corrections if c['photo_index'] == i and c.get('confidence', 0) >= min_confidence]
        
        if photo_corrections:
            best = max(photo_corrections, key=lambda x: x.get('confidence', 0))
            new_photo['azimuth'] = best.get('suggested_azimuth', photo.get('azimuth', 0))
            new_photo['elevation'] = best.get('suggested_elevation', photo.get('elevation', 0))
            new_photo['position_corrected'] = True
            new_photo['correction_confidence'] = best.get('confidence', 0)
            print(f"[VisionSort] Corrected photo {i+1} position to az={new_photo['azimuth']:.0f}° el={new_photo['elevation']:.0f}°", file=sys.stderr)
        
        corrected.append(new_photo)
    
    return corrected


if __name__ == '__main__':
    print("Vision-based image sorter module loaded.")
    print("Use sort_and_optimize_photos() for optimal ordering.")
