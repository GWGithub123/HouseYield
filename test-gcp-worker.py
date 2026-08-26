#!/usr/bin/env python3
"""Test if GCP worker would be used"""

import os
import sys
from pathlib import Path

# Set up environment
os.environ['GCP_GPU_WORKER_ENABLE'] = 'true'

# Add scripts to path
sys.path.insert(0, str(Path(__file__).parent / 'server' / 'scripts'))

# Import and test
from photogrammetry.gcp_worker_client import GcpWorkerClient

print("Testing GCP Worker availability...")
print(f"GCP_GPU_WORKER_ENABLE = {os.environ.get('GCP_GPU_WORKER_ENABLE')}")

client = GcpWorkerClient()
print(f"Client enabled: {client.enabled}")
print(f"Client is_available(): {client.is_available()}")

# Test the pipeline logic
dense_method = "colmap"
use_full_gpu = (dense_method == "colmap" and 
               os.environ.get('GCP_GPU_WORKER_ENABLE', 'false').lower() == 'true')

print(f"\nPipeline would use_full_gpu: {use_full_gpu}")

if use_full_gpu and client.is_available():
    print("✅ Pipeline SHOULD use GCP GPU worker")
else:
    print("❌ Pipeline would fall back to local processing")
    if not use_full_gpu:
        print("   Reason: use_full_gpu check failed")
    if not client.is_available():
        print("   Reason: client.is_available() returned False")
