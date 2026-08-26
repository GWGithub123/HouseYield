#!/usr/bin/env python3
"""
Extract panorama and metadata from massive JSON without point cloud
"""

import json
import sys

input_file = sys.argv[1] if len(sys.argv) > 1 else 'output_1765849872589.json'
output_file = input_file.replace('.json', '_no_pointcloud.json')

print(f"Reading {input_file}...")
print("This will take a few minutes due to 6.1GB file size...")

# Read the massive file
with open(input_file, 'r') as f:
    data = json.load(f)

print("File loaded!")
print(f"Original keys: {list(data.keys())}")

# Remove point cloud
if 'pointCloud' in data:
    print(f"Removing point cloud ({len(data['pointCloud'].get('points', []))} points)...")
    del data['pointCloud']

# Save without point cloud
print(f"Saving to {output_file}...")
with open(output_file, 'w') as f:
    json.dump(data, f)

import os
original_size = os.path.getsize(input_file) / (1024**3)
new_size = os.path.getsize(output_file) / (1024**3)

print(f"\n✅ Done!")
print(f"Original size: {original_size:.2f} GB")
print(f"New size: {new_size:.2f} GB")
print(f"Saved: {output_file}")
