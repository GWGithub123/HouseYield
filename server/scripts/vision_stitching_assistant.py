#!/usr/bin/env python3
"""
OpenAI Vision-Guided Stitching Assistant

Uses GPT-4 Vision to analyze photo pairs and provide stitching guidance:
- Analyzes overlapping regions for visual coherence
- Verifies feature matches make semantic sense
- Suggests alignment corrections based on visual context
- Uses orientation + depth metadata for context
"""

import cv2
import numpy as np
import json
import base64
import os
import sys
from typing import Dict, List, Tuple, Optional
from openai import OpenAI

# Initialize OpenAI client
try:
    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        client = OpenAI(api_key=api_key)
    else:
        client = None
        print("[Vision] Warning: OPENAI_API_KEY not set, Vision features disabled", file=sys.stderr)
except Exception as e:
    client = None
    print(f"[Vision] Warning: Could not initialize OpenAI client: {e}", file=sys.stderr)


def encode_image_for_vision(image: np.ndarray, max_size: int = 1024) -> str:
    """
    Encode image to base64 for Vision API with size reduction.
    Reduces resolution to save tokens while maintaining detail.
    """
    # Resize if needed
    h, w = image.shape[:2]
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    
    # Encode as JPEG
    _, buffer = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buffer).decode('utf-8')


def create_overlap_visualization(img1: np.ndarray, img2: np.ndarray, 
                                 overlap_mask: Optional[np.ndarray] = None) -> np.ndarray:
    """
    Create a side-by-side visualization showing potential overlap regions.
    """
    h1, w1 = img1.shape[:2]
    h2, w2 = img2.shape[:2]
    
    # Resize to same height
    target_h = min(h1, h2, 800)
    scale1 = target_h / h1
    scale2 = target_h / h2
    
    img1_resized = cv2.resize(img1, None, fx=scale1, fy=scale1)
    img2_resized = cv2.resize(img2, None, fx=scale2, fy=scale2)
    
    # Highlight overlap regions if mask provided
    if overlap_mask is not None:
        # Simple highlight - mark edges
        img1_resized = cv2.addWeighted(img1_resized, 0.7, 
                                        cv2.cvtColor(overlap_mask * 255, cv2.COLOR_GRAY2BGR), 0.3, 0)
    
    # Stack horizontally
    combined = np.hstack([img1_resized, img2_resized])
    
    # Add separator line
    mid = img1_resized.shape[1]
    cv2.line(combined, (mid, 0), (mid, combined.shape[0]), (0, 255, 0), 3)
    
    return combined


def vision_find_correspondences(img1: np.ndarray, img2: np.ndarray,
                                photo1: Dict, photo2: Dict) -> List[Tuple[Tuple[int, int], Tuple[int, int]]]:
    """
    Use OpenAI Vision to identify corresponding feature points between two images.
    
    Instead of SIFT, this uses semantic understanding to find matching features.
    Returns list of (point_in_img1, point_in_img2) tuples in pixel coordinates.
    """
    try:
        # Create side-by-side visualization
        viz = create_overlap_visualization(img1, img2)
        viz_base64 = encode_image_for_vision(viz, max_size=1536)
        
        h1, w1 = img1.shape[:2]
        h2, w2 = img2.shape[:2]
        
        prompt = f"""You are analyzing two overlapping photos from a 360° room scan for feature matching.

IMAGES: Left = Photo 1, Right = Photo 2 (side by side)
Photo 1: {w1}x{h1} at azimuth {photo1.get('azimuth', 0):.1f}°, elevation {photo1.get('elevation', 0):.1f}°
Photo 2: {w2}x{h2} at azimuth {photo2.get('azimuth', 0):.1f}°, elevation {photo2.get('elevation', 0):.1f}°

TASK: Identify 8-12 corresponding feature points that appear in BOTH images.

Look for distinctive features:
- Corners of objects (furniture, doors, windows)
- Wall intersections, ceiling lines, floor edges
- Light fixtures, outlets, decorative elements
- Texture patterns (tiles, wood grain, carpet patterns)
- Color transitions and shadows

For each correspondence, provide:
- Pixel coordinates in left image (x1, y1)
- Pixel coordinates in right image (x2, y2) 
- Description of the feature
- Confidence (0-1)

CRITICAL: Coordinates must be PRECISE. The left image occupies x: 0-{viz.shape[1]//2}, right image: x: {viz.shape[1]//2}-{viz.shape[1]}

Respond in JSON:
{{
  "correspondences": [
    {{
      "left_point": [x1, y1],
      "right_point": [x2, y2],
      "description": "top-left corner of door frame",
      "confidence": 0.95
    }},
    ...
  ],
  "overlap_quality": "excellent",  // "excellent", "good", "poor"
  "notes": "Clear overlap in central region"
}}"""

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
                                "url": f"data:image/jpeg;base64,{viz_base64}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=1000,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        
        # Convert to standard format and adjust coordinates
        correspondences = []
        viz_mid = viz.shape[1] // 2
        
        # Scale factors (viz might be downscaled)
        scale_h = h1 / (viz.shape[0])
        scale_w1 = w1 / (viz_mid)
        scale_w2 = w2 / (viz_mid)
        
        for match in result.get('correspondences', []):
            if match['confidence'] < 0.7:  # Filter low confidence
                continue
                
            x1_viz, y1_viz = match['left_point']
            x2_viz, y2_viz = match['right_point']
            
            # Adjust right image x-coordinate (subtract offset)
            x2_viz = x2_viz - viz_mid
            
            # Scale back to original image coordinates
            x1 = int(x1_viz * scale_w1)
            y1 = int(y1_viz * scale_h)
            x2 = int(x2_viz * scale_w2)
            y2 = int(y2_viz * scale_h)
            
            # Validate bounds
            if 0 <= x1 < w1 and 0 <= y1 < h1 and 0 <= x2 < w2 and 0 <= y2 < h2:
                correspondences.append(((x1, y1), (x2, y2)))
        
        print(f"[Vision] Found {len(correspondences)} semantic correspondences", file=sys.stderr)
        return correspondences
        
    except Exception as e:
        print(f"[Vision] Error finding correspondences: {e}", file=sys.stderr)
        return []


def analyze_photo_pair_overlap(photo1: Dict, photo2: Dict, 
                                images: List[np.ndarray]) -> Dict:
    """
    Use OpenAI Vision to analyze overlap between two adjacent photos.
    
    Returns:
        - visual_coherence: 0-1 score of how well images should stitch
        - alignment_suggestions: List of suggested corrections
        - problematic_areas: Areas where stitching may fail
        - confidence: Model's confidence in assessment
    """
    img1 = images[photo1['index']]
    img2 = images[photo2['index']]
    
    # Create visualization
    viz = create_overlap_visualization(img1, img2)
    viz_base64 = encode_image_for_vision(viz)
    
    # Build context from sensor data
    orientation_context = f"""
Photo 1: Rotation {photo1.get('rotation', {})}
Photo 2: Rotation {photo2.get('rotation', {})}
Expected angular separation: {photo1.get('azimuth', 0) - photo2.get('azimuth', 0)}°
"""
    
    depth_context = ""
    if photo1.get('depthMap') and photo2.get('depthMap'):
        depth_context = f"""
Photo 1 depth: {photo1['depthMap'].get('minDepth', 'N/A')}m - {photo1['depthMap'].get('maxDepth', 'N/A')}m
Photo 2 depth: {photo2['depthMap'].get('minDepth', 'N/A')}m - {photo2['depthMap'].get('maxDepth', 'N/A')}m
"""
    
    prompt = f"""You are analyzing two photos that will be stitched into a 360° panorama.

CONTEXT:
{orientation_context}
{depth_context}

TASK:
1. Analyze the visual overlap between these adjacent photos (separated by the green line)
2. Identify common features/objects that should align
3. Assess if the lighting, perspective, and content are consistent for seamless stitching
4. Note any problematic areas (motion blur, different exposures, moving objects)

Respond in JSON format:
{{
  "visual_coherence": 0.85,  // 0-1 score of stitchability
  "common_features": ["doorframe", "wall edge", "floor pattern"],
  "alignment_quality": "good",  // "excellent", "good", "poor"
  "problematic_areas": ["slight exposure difference in upper right"],
  "suggestions": ["Consider applying exposure correction before blending"],
  "confidence": 0.9
}}
"""
    
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
                                "url": f"data:image/jpeg;base64,{viz_base64}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=500,
            response_format={"type": "json_object"}
        )
        
        analysis = json.loads(response.choices[0].message.content)
        return analysis
        
    except Exception as e:
        print(f"[Vision] Error analyzing pair: {e}", file=sys.stderr)
        return {
            "visual_coherence": 0.5,
            "alignment_quality": "unknown",
            "problematic_areas": [f"Analysis failed: {str(e)}"],
            "suggestions": [],
            "confidence": 0.0
        }


def analyze_seam_quality(stitched_region: np.ndarray, 
                         seam_mask: np.ndarray) -> Dict:
    """
    Analyze a stitched region for visible seams and artifacts.
    
    Args:
        stitched_region: Section of panorama around a seam
        seam_mask: Binary mask highlighting the seam location
    """
    # Encode for Vision API
    img_base64 = encode_image_for_vision(stitched_region, max_size=512)
    
    prompt = """Analyze this panorama section for stitching artifacts.

The image shows a region where two photos were blended together.

Look for:
1. Visible seam lines or discontinuities
2. Double images or ghosting
3. Color/exposure mismatches
4. Warping or distortion artifacts
5. Misaligned features (edges, patterns, objects)

Rate the stitching quality and identify specific issues.

Respond in JSON:
{
  "quality_score": 0.75,  // 0-1, where 1 is perfect
  "has_visible_seam": false,
  "has_ghosting": true,
  "issues": ["slight ghosting on the chair leg", "minor color shift"],
  "severity": "minor"  // "none", "minor", "moderate", "severe"
}
"""
    
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
                                "url": f"data:image/jpeg;base64,{img_base64}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=300,
            response_format={"type": "json_object"}
        )
        
        analysis = json.loads(response.choices[0].message.content)
        return analysis
        
    except Exception as e:
        print(f"[Vision] Error analyzing seam: {e}", file=sys.stderr)
        return {
            "quality_score": 0.5,
            "has_visible_seam": False,
            "issues": [f"Analysis failed: {str(e)}"],
            "severity": "unknown"
        }


def get_global_stitching_strategy(photos: List[Dict], sample_images: List[np.ndarray]) -> Dict:
    """
    Analyze the full photo set and recommend an overall stitching strategy.
    
    Takes a few representative image pairs to understand the scene.
    """
    # Sample 3 photo pairs evenly distributed
    n = len(photos)
    sample_indices = [0, n//2, n-1] if n > 3 else list(range(n))
    
    # Create a grid visualization
    sample_imgs = [sample_images[i] for i in sample_indices[:4]]  # Max 4 for token economy
    
    # Resize and arrange in grid
    grid_imgs = []
    for img in sample_imgs:
        h, w = img.shape[:2]
        scale = 400 / max(h, w)
        resized = cv2.resize(img, None, fx=scale, fy=scale)
        grid_imgs.append(resized)
    
    # Create 2x2 grid
    if len(grid_imgs) >= 4:
        top = np.hstack(grid_imgs[:2])
        bottom = np.hstack(grid_imgs[2:4])
        grid = np.vstack([top, bottom])
    else:
        grid = np.hstack(grid_imgs)
    
    grid_base64 = encode_image_for_vision(grid)
    
    prompt = f"""You are analyzing {len(photos)} photos for 360° panorama stitching.

SCENE INFO:
- Total photos: {len(photos)}
- Arranged in a spherical sequence
- Captured with sensor orientation data and depth maps

TASK: Recommend the best stitching strategy based on visual analysis.

Consider:
1. Scene complexity (indoor/outdoor, number of objects)
2. Lighting conditions (uniform, varying exposure, shadows)
3. Movement or blur
4. Optimal blending method (multi-band vs simple)
5. Need for exposure correction

Respond in JSON:
{{
  "scene_type": "indoor_room",  // "indoor_room", "outdoor", "complex_indoor"
  "lighting_quality": "good",  // "excellent", "good", "challenging"
  "motion_detected": false,
  "recommended_strategy": {{
    "blending_method": "multiband",  // "multiband", "linear", "feather"
    "exposure_correction": true,
    "feature_matching_strictness": "medium",  // "strict", "medium", "loose"
    "seam_optimization": true
  }},
  "challenges": ["some lighting variation near windows"],
  "confidence": 0.85
}}
"""
    
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
            max_tokens=500,
            response_format={"type": "json_object"}
        )
        
        strategy = json.loads(response.choices[0].message.content)
        return strategy
        
    except Exception as e:
        print(f"[Vision] Error getting strategy: {e}", file=sys.stderr)
        return {
            "scene_type": "unknown",
            "lighting_quality": "unknown",
            "recommended_strategy": {
                "blending_method": "multiband",
                "exposure_correction": False,
                "feature_matching_strictness": "medium"
            },
            "challenges": [f"Analysis failed: {str(e)}"],
            "confidence": 0.0
        }


def vision_compute_blending_weights(
    img1: np.ndarray, 
    img2: np.ndarray,
    overlap_region: np.ndarray,
    photo1: Dict,
    photo2: Dict
) -> Dict:
    """
    Use Vision to analyze overlap region and compute optimal blending weights.
    
    Returns weight recommendations for each photo based on:
    - Image quality (sharpness, exposure)
    - Content coherence
    - Edge alignment
    """
    try:
        # Encode overlap region
        overlap_base64 = encode_image_for_vision(overlap_region, max_size=512)
        
        # Create side-by-side of the full images for context
        viz = create_overlap_visualization(img1, img2)
        viz_base64 = encode_image_for_vision(viz, max_size=768)
        
        prompt = f"""Analyze this overlap region between two panorama photos to determine optimal blending weights.

CONTEXT:
- Photo 1: azimuth {photo1.get('azimuth', 0):.1f}°, elevation {photo1.get('elevation', 0):.1f}°
- Photo 2: azimuth {photo2.get('azimuth', 0):.1f}°, elevation {photo2.get('elevation', 0):.1f}°

First image shows the overlap region. Second image shows both full photos side-by-side.

Analyze:
1. Which photo has better quality in the overlap? (sharper, better exposed)
2. Are there any ghosting/motion artifacts?
3. Where should the blend transition occur?
4. Any areas to avoid (moving objects, reflections)?

Respond in JSON:
{{
  "photo1_weight": 0.6,  // 0-1, higher = prefer photo 1
  "photo2_weight": 0.4,  // 0-1, should sum to 1
  "quality_assessment": {{
    "photo1_sharpness": 0.85,
    "photo2_sharpness": 0.75,
    "photo1_exposure": 0.9,
    "photo2_exposure": 0.8
  }},
  "blend_recommendation": "gradient",  // "gradient", "hard_cut", "feather"
  "transition_position": 0.5,  // 0-1, where in overlap to center the transition
  "avoid_regions": [],  // Areas with artifacts to weight down
  "confidence": 0.85
}}"""

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{overlap_base64}"}
                        },
                        {
                            "type": "image_url", 
                            "image_url": {"url": f"data:image/jpeg;base64,{viz_base64}"}
                        }
                    ]
                }
            ],
            max_tokens=500,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        print(f"[Vision] Blending weights: photo1={result.get('photo1_weight', 0.5):.2f}, photo2={result.get('photo2_weight', 0.5):.2f}", file=sys.stderr)
        return result
        
    except Exception as e:
        print(f"[Vision] Error computing blending weights: {e}", file=sys.stderr)
        return {
            "photo1_weight": 0.5,
            "photo2_weight": 0.5,
            "blend_recommendation": "gradient",
            "transition_position": 0.5,
            "confidence": 0.0
        }


def vision_find_optimal_seam(
    img1: np.ndarray,
    img2: np.ndarray,
    overlap_mask: np.ndarray,
    photo1: Dict,
    photo2: Dict
) -> List[Tuple[int, int]]:
    """
    Use Vision to identify the optimal seam line through the overlap region.
    
    The seam should follow natural boundaries (edges of objects, color transitions)
    to minimize visible artifacts.
    
    Returns: List of (x, y) points defining the seam path
    """
    try:
        # Create a blended preview showing the overlap
        h, w = img1.shape[:2]
        blend = cv2.addWeighted(img1, 0.5, img2, 0.5, 0)
        
        # Highlight overlap region
        overlay = blend.copy()
        overlay[overlap_mask > 0] = overlay[overlap_mask > 0] * 0.7 + np.array([0, 255, 0]) * 0.3
        
        overlay_base64 = encode_image_for_vision(overlay.astype(np.uint8), max_size=1024)
        
        prompt = f"""Analyze this blended overlap region between two panorama photos.
The green-tinted area shows where both photos overlap.

TASK: Identify the optimal seam path through this overlap region.

The seam should:
1. Follow natural edges (wall corners, door frames, furniture edges)
2. Avoid cutting through faces, text, or important objects
3. Follow color/texture boundaries where possible
4. Be as straight as possible while following natural breaks

Image dimensions: {w} x {h}

Provide 10-20 control points along the optimal seam path, from top to bottom or left to right.

Respond in JSON:
{{
  "seam_direction": "vertical",  // "vertical" or "horizontal"
  "seam_points": [
    [x1, y1],
    [x2, y2],
    ...
  ],
  "follows_edges": true,
  "edge_descriptions": ["wall corner at top", "door frame in middle"],
  "confidence": 0.85
}}"""

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{overlay_base64}"}
                        }
                    ]
                }
            ],
            max_tokens=600,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        seam_points = [tuple(p) for p in result.get('seam_points', [])]
        
        print(f"[Vision] Found seam with {len(seam_points)} control points, direction: {result.get('seam_direction')}", file=sys.stderr)
        return seam_points
        
    except Exception as e:
        print(f"[Vision] Error finding optimal seam: {e}", file=sys.stderr)
        return []


def vision_refine_projection(
    projected_panorama: np.ndarray,
    photos: List[Dict],
    sample_indices: List[int] = None
) -> Dict:
    """
    Use Vision to analyze the projected panorama and suggest refinements.
    
    Looks for:
    - Misaligned features (doubled edges, ghosting)
    - Distortion artifacts
    - Incorrect projections that need adjustment
    
    Returns correction suggestions for camera poses.
    """
    try:
        # Encode the panorama
        pano_base64 = encode_image_for_vision(projected_panorama, max_size=1536)
        
        prompt = f"""Analyze this 360° equirectangular panorama for projection quality issues.

This panorama was created from {len(photos)} photos stitched together.

Look for:
1. GHOSTING: Doubled/blurred edges where photos didn't align properly
2. SEAMS: Visible lines where photos meet
3. DISTORTION: Stretched or compressed areas
4. COLOR DISCONTINUITIES: Sudden color/brightness changes
5. MISSING AREAS: Black or incomplete regions

For each issue found, describe:
- Location (describe position: "upper left", "center", "bottom right corner")
- Approximate position as percentage (x%, y%) from top-left
- Severity (minor, moderate, severe)
- Suggested fix

Respond in JSON:
{{
  "overall_quality": 0.75,  // 0-1
  "issues": [
    {{
      "type": "ghosting",
      "location": "center-left",
      "position_pct": [25, 50],
      "severity": "moderate",
      "suggested_fix": "Increase rotation for photo 3 by ~2 degrees"
    }}
  ],
  "pose_corrections": [
    {{
      "photo_index": 3,
      "azimuth_adjust": 2.0,
      "elevation_adjust": 0.0,
      "confidence": 0.7
    }}
  ],
  "requires_restitching": false,
  "notes": "Generally good alignment with minor issues"
}}"""

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{pano_base64}"}
                        }
                    ]
                }
            ],
            max_tokens=800,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        
        print(f"[Vision] Panorama quality: {result.get('overall_quality', 0):.2f}", file=sys.stderr)
        print(f"[Vision] Found {len(result.get('issues', []))} issues", file=sys.stderr)
        
        if result.get('pose_corrections'):
            print(f"[Vision] Suggested {len(result['pose_corrections'])} pose corrections", file=sys.stderr)
        
        return result
        
    except Exception as e:
        print(f"[Vision] Error analyzing projection: {e}", file=sys.stderr)
        return {
            "overall_quality": 0.5,
            "issues": [],
            "pose_corrections": [],
            "requires_restitching": False,
            "notes": f"Analysis failed: {str(e)}"
        }


def vision_detect_major_misplacements(
    photos: List[Dict],
    images: List[np.ndarray]
) -> Dict:
    """
    Use Vision to detect images that are drastically out of position.
    
    Analyzes visual context and content flow to identify:
    - Images placed 90°+ away from correct position
    - Reversed sequences (image order wrong)
    - Duplicate coverage (same area captured twice)
    
    This is useful when sensor data (compass/gyro) is unreliable.
    """
    try:
        # Create a grid visualization showing all photos with their current positions
        n = len(photos)
        grid_cols = min(6, n)
        grid_rows = (n + grid_cols - 1) // grid_cols
        
        # Resize images to thumbnails
        thumb_size = 200
        thumbnails = []
        for img in images:
            h, w = img.shape[:2]
            scale = thumb_size / max(h, w)
            thumb = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            # Add border with azimuth label
            thumb_with_label = np.zeros((thumb_size + 30, thumb_size, 3), dtype=np.uint8)
            thumb_with_label[:thumb.shape[0], :thumb.shape[1]] = thumb
            thumbnails.append(thumb_with_label)
        
        # Arrange in grid
        grid_img = np.zeros((grid_rows * (thumb_size + 30), grid_cols * thumb_size, 3), dtype=np.uint8)
        for idx, thumb in enumerate(thumbnails):
            row = idx // grid_cols
            col = idx % grid_cols
            y = row * (thumb_size + 30)
            x = col * thumb_size
            grid_img[y:y+thumb.shape[0], x:x+thumb.shape[1]] = thumb
            
            # Add photo number and azimuth
            photo = photos[idx]
            text = f"#{idx} {photo.get('azimuth', 0):.0f}°"
            cv2.putText(grid_img, text, (x + 5, y + thumb_size + 20), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        grid_base64 = encode_image_for_vision(grid_img, max_size=1536)
        
        # Build context about current positions
        positions_text = "Current photo positions (azimuth, elevation):\n"
        for i, photo in enumerate(photos):
            az = photo.get('azimuth', 0)
            el = photo.get('elevation', 0)
            positions_text += f"Photo #{i}: {az:.1f}° az, {el:.1f}° el\n"
        
        prompt = f"""Analyze these {n} photos from a 360° room scan to detect MAJOR misplacements.

{positions_text}

The photos are arranged in a grid, labeled with their current positions based on phone sensors.

TASK: Identify any photos that are clearly in the WRONG position (90°+ off).

Look for:
1. VISUAL SEQUENCE - Do adjacent photos show continuous space, or jumps?
2. CONTENT CONTEXT - If photo shows a window, does azimuth make sense?
3. LIGHTING - Sun direction should match azimuth
4. OBJECTS - Furniture/features should appear in logical sequence
5. PERSPECTIVE - Camera angle should match elevation value

Common issues:
- Phone compass was wrong (magnetic interference)
- Photo order shuffled
- 180° flip (pointing wrong direction)
- Vertical misalignment (ceiling shot marked as floor)

For each misplaced photo, provide:
- Current position (from sensors)
- Suggested correct position (from visual analysis)
- Confidence (0-1)
- Reasoning

Respond in JSON:
{{
  "misplacements_detected": true,
  "misplaced_photos": [
    {{
      "photo_index": 5,
      "current_azimuth": 45.0,
      "current_elevation": 10.0,
      "suggested_azimuth": 225.0,
      "suggested_elevation": 15.0,
      "rotation_error_degrees": 180,
      "confidence": 0.9,
      "reasoning": "Shows window that should be on opposite wall based on room layout",
      "severity": "major"
    }}
  ],
  "sequence_issues": [],
  "overall_confidence": 0.85,
  "sensor_reliability": "poor"
}}"""

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{grid_base64}"}
                        }
                    ]
                }
            ],
            max_tokens=1200,
            response_format={"type": "json_object"}
        )
        
        result = json.loads(response.choices[0].message.content)
        
        if result.get('misplacements_detected'):
            misplaced = result.get('misplaced_photos', [])
            print(f"[Vision] 🚨 Detected {len(misplaced)} major misplacements", file=sys.stderr)
            for mp in misplaced:
                idx = mp.get('photo_index', -1)
                error = mp.get('rotation_error_degrees', 0)
                print(f"[Vision]   Photo {idx}: {error:.0f}° error - {mp.get('reasoning', '')}", file=sys.stderr)
        else:
            print("[Vision] ✓ No major misplacements detected", file=sys.stderr)
        
        return result
        
    except Exception as e:
        print(f"[Vision] Error detecting misplacements: {e}", file=sys.stderr)
        return {
            "misplacements_detected": False,
            "misplaced_photos": [],
            "sensor_reliability": "unknown",
            "overall_confidence": 0.0
        }


if __name__ == "__main__":
    # Test with sample data
    print("OpenAI Vision Stitching Assistant initialized")
    print("Available functions:")
    print("  - vision_find_correspondences()")
    print("  - analyze_photo_pair_overlap()")
    print("  - analyze_seam_quality()")
    print("  - get_global_stitching_strategy()")
    print("  - vision_compute_blending_weights()")
    print("  - vision_find_optimal_seam()")
    print("  - vision_refine_projection()")
