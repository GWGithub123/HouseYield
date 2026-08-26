#!/usr/bin/env python3
"""
Test which stitcher will be selected given specific conditions.
This simulates the exact conditions of a room scan to confirm
the optimized_google_stitcher will run.
"""

import sys
import json
from pathlib import Path

# Import the module loading logic
exec(open('stitch_panorama.py').read().split('def normalize_quaternion')[0])

def test_stitcher_selection(input_json_path):
    """Test which stitcher will be selected for a given input"""
    print("=" * 60)
    print("STITCHER SELECTION TEST")
    print("=" * 60)
    
    # Load input data
    with open(input_json_path, 'r') as f:
        data = json.load(f)
    
    photos = data.get('photos', [])
    n = len(photos)
    
    # Count depth maps
    depth_count = sum(1 for p in photos if p.get('depthMap'))
    
    print(f"\nInput Analysis:")
    print(f"  Photos: {n}")
    print(f"  Photos with depth: {depth_count}/{n}")
    print(f"  Depth coverage: {depth_count/n*100:.1f}%")
    
    print(f"\nStitcher Availability:")
    print(f"  OPTIMIZED_STITCHER_AVAILABLE: {OPTIMIZED_STITCHER_AVAILABLE}")
    print(f"  BUNDLE_ADJUSTMENT_AVAILABLE: {BUNDLE_ADJUSTMENT_AVAILABLE}")
    print(f"  GOOGLE_STITCHER_AVAILABLE: {GOOGLE_STITCHER_AVAILABLE}")
    
    print(f"\nCondition Checks:")
    
    # Check Optimized Stitcher conditions
    optimized_will_run = OPTIMIZED_STITCHER_AVAILABLE and n >= 3
    print(f"  Optimized Stitcher:")
    print(f"    - Module available: {OPTIMIZED_STITCHER_AVAILABLE}")
    print(f"    - Photo count >= 3: {n >= 3} ({n} photos)")
    print(f"    → WILL RUN: {'✅ YES' if optimized_will_run else '❌ NO'}")
    
    # Check Bundle Adjustment conditions (fallback)
    bundle_will_run = not optimized_will_run and BUNDLE_ADJUSTMENT_AVAILABLE and n >= 3
    print(f"  Bundle Adjustment (fallback):")
    print(f"    - Module available: {BUNDLE_ADJUSTMENT_AVAILABLE}")
    print(f"    - Optimized failed: {not optimized_will_run}")
    print(f"    - Photo count >= 3: {n >= 3}")
    print(f"    → WILL RUN: {'⚠️ YES (as fallback)' if bundle_will_run else '❌ NO'}")
    
    # Check Google Street View conditions (fallback 2)
    google_will_run = not optimized_will_run and not bundle_will_run and GOOGLE_STITCHER_AVAILABLE and n >= 3
    print(f"  Google Street View (fallback):")
    print(f"    - Module available: {GOOGLE_STITCHER_AVAILABLE}")
    print(f"    - Previous failed: {not optimized_will_run and not bundle_will_run}")
    print(f"    → WILL RUN: {'⚠️ YES (as fallback)' if google_will_run else '❌ NO'}")
    
    print(f"\n" + "=" * 60)
    print("RESULT:")
    print("=" * 60)
    
    if optimized_will_run:
        print("✅ Optimized Stitcher WILL RUN")
        print("\nWhat will happen:")
        print("  1. SIFT feature matching on all photos")
        print("  2. Sensor-anchored refinements (±5° max)")
        print("  3. Gain compensation for exposure")
        if depth_count > 0:
            print(f"  4. Depth-based blending ({depth_count} depth maps)")
            print("  5. Spherical projection with multi-band blending")
            print(f"  6. Generate 3D point cloud (~{depth_count * 900000:,} points)")
            print("\nOutput will include:")
            print("  - 4096×2048 panorama image")
            print("  - Depth panorama")
            print("  - 3D point cloud for click-to-measure")
            print("  - Room dimensions")
        else:
            print("  4. Spherical projection with multi-band blending")
            print("\nOutput will include:")
            print("  - 4096×2048 panorama image")
            print("  - No depth/point cloud (depth maps missing)")
    elif bundle_will_run:
        print("⚠️ Bundle Adjustment will run (Optimized unavailable)")
        print("   This may cause warping issues!")
    elif google_will_run:
        print("⚠️ Google Street View will run (fallback)")
    else:
        print("⚠️ Legacy sensor-based will run (last resort)")
    
    print("\n" + "=" * 60)
    
    return optimized_will_run

if __name__ == "__main__":
    # Use most recent input file
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        temp_dir = Path(__file__).parent.parent / "data" / "temp-stitching"
        input_files = sorted(temp_dir.glob("input_*.json"))
        if not input_files:
            print("❌ No input files found in temp-stitching directory")
            sys.exit(1)
        input_path = input_files[-1]
    
    print(f"Testing with: {input_path}\n")
    will_run = test_stitcher_selection(input_path)
    
    sys.exit(0 if will_run else 1)
