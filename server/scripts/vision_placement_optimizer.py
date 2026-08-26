#!/usr/bin/env python3
"""
Vision-Based Placement Optimizer

Analyzes the initial sensor-based photo placement and uses Vision AI to:
1. Identify misplaced photos (duplications, wrong positions)
2. Determine optimal layering order (which photos should go on top)
3. Suggest placement corrections based on visual content
"""

import cv2
import numpy as np
import json
import base64
import os
import sys
from typing import Dict, List, Tuple, Optional
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))


def encode_image_base64(image: np.ndarray, max_size: int = 1024) -> str:
    """Encode image to base64 for Vision API"""
    h, w = image.shape[:2]
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    
    _, buffer = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buffer).decode('utf-8')


def create_placement_preview(
    projections: List[Tuple[np.ndarray, np.ndarray, np.ndarray, float, int]],
    output_width: int,
    output_height: int
) -> np.ndarray:
    """
    Create a preview of how photos are currently placed.
    Returns a low-res version for Vision analysis.
    """
    # Create at lower resolution for faster Vision processing
    preview_scale = 0.25
    preview_w = int(output_width * preview_scale)
    preview_h = int(output_height * preview_scale)
    
    preview = np.zeros((preview_h, preview_w, 3), dtype=np.uint8)
    
    for projected, weight, _, elevation, idx in projections:
        # Resize projection to preview size
        proj_resized = cv2.resize(projected, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
        weight_resized = cv2.resize(weight, (preview_w, preview_h), interpolation=cv2.INTER_AREA)
        
        valid_mask = weight_resized > 0.01
        preview[valid_mask] = proj_resized[valid_mask]
    
    return preview


def analyze_placement_with_vision(
    photos: List[Dict],
    images: List[np.ndarray],
    projections: List[Tuple[np.ndarray, np.ndarray, np.ndarray, float, int]],
    initial_preview: np.ndarray
) -> Dict:
    """
    Use Vision AI to analyze the initial sensor-based placement and suggest improvements.
    
    Returns:
        {
            'suggested_order': [photo_indices in optimal rendering order],
            'misplacements': [list of photos that appear misplaced],
            'layering_rules': {photo_idx: 'should_be_on_top'/'should_be_behind'},
            'corrections': [list of suggested position adjustments]
        }
    """
    print("[Vision Optimizer] Analyzing initial placement...", file=sys.stderr)
    
    # Encode initial preview
    preview_b64 = encode_image_base64(initial_preview, max_size=1024)
    
    # Create grid of individual photos with metadata
    # Using higher resolution (512px) for better Vision analysis
    photo_data = []
    for i, (photo, img) in enumerate(zip(photos, images)):
        img_b64 = encode_image_base64(img, max_size=512)  # Increased from 256px for better detail
        photo_data.append({
            'index': i,
            'azimuth': photo.get('azimuth', 0),
            'elevation': photo.get('elevation', 0),
            'image': f"data:image/jpeg;base64,{img_b64}"
        })
    
    # Build prompt for Vision AI
    prompt = f"""You are analyzing a 360° room panorama stitched from {len(photos)} photos using phone sensor data (gyroscope + compass).

CURRENT PLACEMENT PREVIEW:
I will show you the current panorama where photos are placed purely based on sensor readings (azimuth/elevation angles).

INDIVIDUAL PHOTOS WITH METADATA:
Each photo has been placed at its sensor-reported position:
{json.dumps([{'idx': p['index'], 'azimuth': f"{p['azimuth']:.1f}°", 'elevation': f"{p['elevation']:.1f}°"} for p in photo_data], indent=2)}

YOUR TASK:
1. **Identify Misplacements**: Look for photos that are clearly in the wrong position (e.g., a window appearing twice, furniture duplicated, perspective doesn't match neighbors)

2. **Determine Layering Order**: Some photos overlap. Decide which should be "on top" based on:
   - Which shows the most important content (walls > floor/ceiling in overlaps)
   - Which has better clarity/framing
   - Which creates the most coherent panorama

3. **Suggest Corrections**: For any obviously misplaced photos, estimate how far off they are (in degrees of azimuth/elevation)

Respond in JSON format:
{{
  "misplacements": [
    {{"photo_index": 5, "issue": "window appears twice", "confidence": 0.8}}
  ],
  "layering_order": [list of photo indices, first=behind, last=on top],
  "position_corrections": [
    {{"photo_index": 5, "azimuth_adjustment": -15, "elevation_adjustment": 0, "reason": "better aligns with adjacent wall"}}
  ],
  "overall_assessment": "brief summary of placement quality"
}}
"""

    try:
        # Build content array with preview + all individual photos
        content = [
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{preview_b64}",
                    "detail": "high"
                }
            }
        ]
        
        # Add each individual photo thumbnail
        for i, photo_info in enumerate(photo_data):
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": photo_info['image'],
                    "detail": "low"
                }
            })
        
        # Call Vision API with all images
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": content}],
            max_tokens=2000,
            temperature=0.1
        )
        
        content = response.choices[0].message.content
        
        # Extract JSON from response
        if "```json" in content:
            json_str = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            json_str = content.split("```")[1].split("```")[0].strip()
        else:
            json_str = content.strip()
        
        result = json.loads(json_str)
        
        print(f"[Vision Optimizer] Assessment: {result.get('overall_assessment', 'N/A')}", file=sys.stderr)
        print(f"[Vision Optimizer] Found {len(result.get('misplacements', []))} potential misplacements", file=sys.stderr)
        print(f"[Vision Optimizer] Suggested {len(result.get('position_corrections', []))} position corrections", file=sys.stderr)
        
        return result
        
    except Exception as e:
        print(f"[Vision Optimizer] Analysis failed: {e}", file=sys.stderr)
        # Return no changes if Vision fails
        return {
            'misplacements': [],
            'layering_order': [p[4] for p in projections],  # Original order
            'position_corrections': [],
            'overall_assessment': 'Vision analysis unavailable'
        }


def apply_vision_optimization(
    projections: List[Tuple[np.ndarray, np.ndarray, np.ndarray, float, int]],
    vision_result: Dict
) -> List[Tuple[np.ndarray, np.ndarray, np.ndarray, float, int]]:
    """
    Apply Vision AI's suggested layering order to projections.
    """
    if not vision_result.get('layering_order'):
        print("[Vision Optimizer] No layering changes suggested", file=sys.stderr)
        return projections
    
    # Re-order projections based on Vision's layering suggestion
    suggested_order = vision_result['layering_order']
    
    # Create lookup by original index (the 5th element is the original photo index)
    proj_dict = {proj[4]: proj for proj in projections}
    
    # Reorder based on suggested order
    reordered = []
    reordered_indices = set()
    
    for idx in suggested_order:
        if idx in proj_dict:
            reordered.append(proj_dict[idx])
            reordered_indices.add(idx)
    
    # Add any missing projections at the end (by checking indices, not numpy arrays)
    for proj in projections:
        proj_idx = proj[4]  # Original photo index
        if proj_idx not in reordered_indices:
            reordered.append(proj)
    
    print(f"[Vision Optimizer] Reordered {len(reordered)} projections based on Vision guidance", file=sys.stderr)
    return reordered
