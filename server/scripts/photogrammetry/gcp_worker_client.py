#!/usr/bin/env python3
"""
GCP GPU Worker Client (Python)

This module calls the Node.js GCP GPU Worker service to run
CUDA-accelerated dense reconstruction on Google Cloud.

The Node.js service handles:
- VM startup/shutdown
- SSH communication
- File transfer (SCP)
- Remote execution

This Python wrapper just needs to call the Node.js API.
"""

import os
import sys
import json
import re
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, List


def extract_json_from_output(output: str) -> dict:
    """Extract JSON object from mixed output (may contain progress messages)"""
    output = output.strip()
    
    if not output:
        raise ValueError("Empty output")
    
    # Try direct parse first
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass
    
    # Look for JSON object at the end of output (most common case)
    # Find last complete JSON object
    match = re.search(r'(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*$', output)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    
    # Try to find any JSON object in the output
    for match in re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', output):
        try:
            data = json.loads(match.group())
            # Look for expected keys
            if 'success' in data or 'num_points' in data or 'error' in data:
                return data
        except json.JSONDecodeError:
            continue
    
    raise ValueError(f"No valid JSON found in output: {output[:200]}...")


class GcpWorkerClient:
    """Client to interface with Node.js GCP GPU Worker"""
    
    def __init__(self):
        # Check if GCP worker is enabled
        self.enabled = os.environ.get('GCP_GPU_WORKER_ENABLE', 'false').lower() == 'true'
        
        if not self.enabled:
            print("[GcpWorkerClient] GCP GPU worker is disabled")
            return
        
        # Verify Node.js gcpGpuWorker service exists
        self.service_path = Path(__file__).parent.parent.parent / 'services' / 'gcpGpuWorker.js'
        if not self.service_path.exists():
            raise FileNotFoundError(f"GCP GPU Worker service not found: {self.service_path}")
        
        print("[GcpWorkerClient] Initialized (enabled={})".format(self.enabled))
    
    def is_available(self) -> bool:
        """Check if GCP worker is available"""
        return self.enabled
    
    def process_full_pipeline(
        self,
        local_images_dir: Path,
        local_output_dir: Path,
        quality: str = 'high',
    ) -> Dict[str, Any]:
        """
        Process full COLMAP pipeline on GCP GPU VM.
        Runs: feature extraction → matching → SfM → dense reconstruction
        
        Args:
            local_images_dir: Directory with raw images only
            local_output_dir: Directory for output
            quality: 'high', 'medium', or 'low'
        
        Returns:
            Dict with num_sparse_points, num_dense_points, sparse_path, dense_path, sparse_model_dir, method
        """
        if not self.enabled:
            raise RuntimeError("GCP GPU worker is not enabled. Set GCP_GPU_WORKER_ENABLE=true")
        
        print(f"[GcpWorkerClient] Sending full pipeline to GPU VM (quality: {quality})...", flush=True)
        print(f"  Images: {local_images_dir}", flush=True)
        print(f"  Output: {local_output_dir}", flush=True)
        
        # Call the Node.js worker via a helper script
        helper_script = Path(__file__).parent / '_call_gcp_worker_full.js'
        
        if not helper_script.exists():
            self._create_full_pipeline_helper(helper_script)
        
        # Execute the Node.js helper with environment variables
        env = os.environ.copy()
        try:
            result = subprocess.run(
                ['node', str(helper_script), str(local_images_dir), str(local_output_dir), quality],
                capture_output=True,
                text=True,
                check=True,
                env=env,
            )
            
            # Parse JSON result (may have progress messages mixed in)
            result_data = extract_json_from_output(result.stdout)
            
            if not result_data.get('success'):
                raise RuntimeError(f"GCP processing failed: {result_data.get('error')}")
            
            print(f"[GcpWorkerClient] ✅ Full pipeline complete:")
            print(f"  Sparse: {result_data['num_sparse_points']:,} points")
            print(f"  Dense: {result_data['num_dense_points']:,} points")
            if result_data.get('textured_mesh_path'):
                print(f"  Textured mesh: {result_data['textured_mesh_path']}")
            
            return {
                'num_sparse_points': result_data['num_sparse_points'],
                'num_dense_points': result_data['num_dense_points'],
                'sparse_path': result_data['sparse_path'],
                'dense_path': result_data['dense_path'],
                'sparse_model_dir': result_data['sparse_model_dir'],
                'textured_mesh_path': result_data.get('textured_mesh_path'),
                'method': result_data.get('method', 'colmap_full_gpu'),
            }
            
        except subprocess.CalledProcessError as e:
            print(f"[GcpWorkerClient] Error calling Node.js worker:", file=sys.stderr)
            print(f"  stdout: {e.stdout}", file=sys.stderr)
            print(f"  stderr: {e.stderr}", file=sys.stderr)
            # Try to extract error from stdout
            try:
                error_data = extract_json_from_output(e.stdout or e.stderr or '')
                raise RuntimeError(f"GCP worker failed: {error_data.get('error', 'Unknown error')}")
            except ValueError:
                raise RuntimeError(f"GCP worker execution failed: {e.stderr}")
    
    def process_dense_reconstruction(
        self,
        local_input_dir: Path,
        local_output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Process dense reconstruction on GCP GPU VM.
        
        Args:
            local_input_dir: Directory with sparse reconstruction + images
                Should contain:
                - sparse/0/ (COLMAP sparse model)
                - images/ (undistorted images)
            local_output_dir: Directory for output
        
        Returns:
            Dict with num_points, points_path, method
        """
        if not self.enabled:
            raise RuntimeError("GCP GPU worker is not enabled. Set GCP_GPU_WORKER_ENABLE=true")
        
        print(f"[GcpWorkerClient] Sending reconstruction to GPU VM...")
        print(f"  Input: {local_input_dir}")
        print(f"  Output: {local_output_dir}")
        
        # Call the Node.js worker via a helper script
        # We'll create a simple Node.js script that imports and calls the service
        helper_script = Path(__file__).parent / '_call_gcp_worker.js'
        
        if not helper_script.exists():
            # Create the helper script
            self._create_helper_script(helper_script)
        
        # Execute the Node.js helper with environment variables
        env = os.environ.copy()
        try:
            result = subprocess.run(
                ['node', str(helper_script), str(local_input_dir), str(local_output_dir)],
                capture_output=True,
                text=True,
                check=True,
                env=env,
            )
            
            # Parse JSON result (may have progress messages mixed in)
            result_data = extract_json_from_output(result.stdout)
            
            if not result_data.get('success'):
                raise RuntimeError(f"GCP processing failed: {result_data.get('error')}")
            
            print(f"[GcpWorkerClient] ✅ Dense reconstruction complete: {result_data['num_points']:,} points")
            
            return {
                'num_points': result_data['num_points'],
                'points_path': result_data['points_path'],
                'method': result_data.get('method', 'colmap_cuda_gcp'),
            }
            
        except subprocess.CalledProcessError as e:
            print(f"[GcpWorkerClient] Error calling Node.js worker:", file=sys.stderr)
            print(f"  stdout: {e.stdout}", file=sys.stderr)
            print(f"  stderr: {e.stderr}", file=sys.stderr)
            # Try to extract error from stdout
            try:
                error_data = extract_json_from_output(e.stdout or e.stderr or '')
                raise RuntimeError(f"GCP worker failed: {error_data.get('error', 'Unknown error')}")
            except ValueError:
                raise RuntimeError(f"GCP worker execution failed: {e.stderr}")
    
    def process_full_mesh_pipeline(
        self,
        local_input_dir: Path,
        local_output_dir: Path,
    ) -> Dict[str, Any]:
        """
        Process complete pipeline on GCP GPU: Dense → Mesh → Texture
        
        Args:
            local_input_dir: Directory with sparse reconstruction + images
            local_output_dir: Directory for output
        
        Returns:
            Dict with points, mesh, and texture info
        """
        if not self.enabled:
            raise RuntimeError("GCP GPU worker is not enabled. Set GCP_GPU_WORKER_ENABLE=true")
        
        print(f"[GcpWorkerClient] Running full mesh pipeline on GPU VM...")
        print(f"  Input: {local_input_dir}")
        print(f"  Output: {local_output_dir}")
        
        helper_script = Path(__file__).parent / '_call_gcp_worker_mesh.js'
        
        if not helper_script.exists():
            self._create_mesh_pipeline_helper(helper_script)
        
        env = os.environ.copy()
        try:
            result = subprocess.run(
                ['node', str(helper_script), str(local_input_dir), str(local_output_dir)],
                capture_output=True,
                text=True,
                check=True,
                env=env,
            )
            
            # Parse JSON result (may have progress messages mixed in)
            result_data = extract_json_from_output(result.stdout)
            
            if not result_data.get('success'):
                raise RuntimeError(f"GCP processing failed: {result_data.get('error')}")
            
            print(f"[GcpWorkerClient] ✅ Full mesh pipeline complete:")
            print(f"  Points: {result_data.get('num_points', 0):,}")
            print(f"  Vertices: {result_data.get('num_vertices', 0):,}")
            print(f"  Triangles: {result_data.get('num_triangles', 0):,}")
            
            return {
                'num_points': result_data.get('num_points', 0),
                'points_path': result_data.get('points_path', ''),
                'num_vertices': result_data.get('num_vertices', 0),
                'num_triangles': result_data.get('num_triangles', 0),
                'mesh_path': result_data.get('mesh_path', ''),
                'textured_mesh_path': result_data.get('textured_mesh_path', ''),
                'texture_path': result_data.get('texture_path', ''),
                'method': result_data.get('method', 'colmap_cuda_full_gcp'),
            }
            
        except subprocess.CalledProcessError as e:
            print(f"[GcpWorkerClient] Error:", file=sys.stderr)
            print(f"  stdout: {e.stdout}", file=sys.stderr)
            print(f"  stderr: {e.stderr}", file=sys.stderr)
            # Try to extract error from stdout
            try:
                error_data = extract_json_from_output(e.stdout or e.stderr or '')
                raise RuntimeError(f"GCP worker failed: {error_data.get('error', 'Unknown error')}")
            except ValueError:
                raise RuntimeError(f"GCP worker execution failed: {e.stderr}")
    
    def _create_mesh_pipeline_helper(self, path: Path):
        """Create the Node.js helper script for full mesh pipeline"""
        
        script_content = '''#!/usr/bin/env node
/**
 * Helper script to call GCP GPU Worker (full mesh pipeline) from Python
 */

import { getGcpGpuWorker } from '../../services/gcpGpuWorker.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node _call_gcp_worker_mesh.js <input_dir> <output_dir>');
    process.exit(1);
  }
  
  const [inputDir, outputDir] = args;
  
  try {
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    // Process full mesh pipeline
    const result = await worker.processFullMeshPipeline(
      inputDir,
      outputDir,
      (message) => {
        console.error(`[Progress] ${message}`);
      }
    );
    
    // Output result as JSON
    console.log(JSON.stringify({
      success: true,
      num_points: result.num_points,
      points_path: result.points_path,
      num_vertices: result.num_vertices,
      num_triangles: result.num_triangles,
      mesh_path: result.mesh_path,
      textured_mesh_path: result.textured_mesh_path,
      texture_path: result.texture_path,
      method: result.method,
    }));
    
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

main();
'''
        
        with open(path, 'w') as f:
            f.write(script_content)
        
        os.chmod(path, 0o755)
        print(f"[GcpWorkerClient] Created mesh pipeline helper: {path}")
    
    def _create_helper_script(self, path: Path):
        """Create the Node.js helper script that calls gcpGpuWorker"""
        
        script_content = '''#!/usr/bin/env node
/**
 * Helper script to call GCP GPU Worker from Python
 */

import path from 'path';
import { getGcpGpuWorker } from '../../services/gcpGpuWorker.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node _call_gcp_worker.js <input_dir> <output_dir>');
    process.exit(1);
  }
  
  const [inputDir, outputDir] = args;
  
  try {
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    // Process dense reconstruction
    const result = await worker.processDenseReconstruction(
      inputDir,
      outputDir,
      (message) => {
        // Progress callback
        console.error(`[Progress] ${message}`);
      }
    );
    
    // Output result as JSON
    console.log(JSON.stringify({
      success: true,
      num_points: result.num_points,
      points_path: result.points_path,
      method: result.method,
    }));
    
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

main();
'''
        
        with open(path, 'w') as f:
            f.write(script_content)
        
        # Make executable
        os.chmod(path, 0o755)
        
        print(f"[GcpWorkerClient] Created helper script: {path}")
    
    def _create_full_pipeline_helper(self, path: Path):
        """Create the Node.js helper script for full pipeline"""
        
        script_content = '''#!/usr/bin/env node
/**
 * Helper script to call GCP GPU Worker (full pipeline) from Python
 */

import path from 'path';
import { getGcpGpuWorker } from '../../services/gcpGpuWorker.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 3) {
    console.error('Usage: node _call_gcp_worker_full.js <images_dir> <output_dir> <quality>');
    process.exit(1);
  }
  
  const [imagesDir, outputDir, quality] = args;
  
  try {
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    // Process full pipeline
    const result = await worker.processFullPipeline(
      imagesDir,
      outputDir,
      quality,
      (message) => {
        // Progress callback
        console.error(`[Progress] ${message}`);
      }
    );
    
    // Output result as JSON
    console.log(JSON.stringify({
      success: true,
      num_sparse_points: result.num_sparse_points,
      num_dense_points: result.num_dense_points,
      sparse_path: result.sparse_path,
      dense_path: result.dense_path,
      sparse_model_dir: result.sparse_model_dir,
      method: result.method,
    }));
    
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

main();
'''
        
        with open(path, 'w') as f:
            f.write(script_content)
        
        # Make executable
        os.chmod(path, 0o755)
        
        print(f"[GcpWorkerClient] Created full pipeline helper script: {path}")
    
    def process_v2_pipeline(
        self,
        local_images_dir: Path,
        local_output_dir: Path,
        ar_poses: Optional[Dict] = None,
        metric3d_model: str = 'vit-large',
        voxel_size: float = 0.005,
        skip_segmentation: bool = False,
    ) -> Dict[str, Any]:
        """
        Process complete V2 pipeline on GCP GPU VM:
        GLOMAP/HLOC SfM → COLMAP MVS → Metric3D → TSDF → Mesh → Segmentation
        
        This runs the ENTIRE V2 pipeline on GPU, including:
        1. Feature extraction (SuperPoint via HLOC)
        2. Feature matching (LightGlue via HLOC)
        3. Sparse reconstruction (GLOMAP)
        4. Dense MVS (COLMAP PatchMatch)
        5. Metric3D depth estimation
        6. Depth fusion (MVS + Metric3D)
        7. TSDF volumetric reconstruction
        8. Mesh cleaning and texturing
        9. SAM2 segmentation + measurements
        
        Args:
            local_images_dir: Directory with raw images
            local_output_dir: Directory for output
            ar_poses: Optional AR pose data for scale
            metric3d_model: Model size ('vit-small', 'vit-large', 'vit-giant')
            voxel_size: TSDF voxel size in meters (default 5mm)
            skip_segmentation: Skip SAM2 segmentation stage
        
        Returns:
            Dict with mesh_path, measurements_path, stats_path, method
        """
        if not self.enabled:
            raise RuntimeError("GCP GPU worker is not enabled. Set GCP_GPU_WORKER_ENABLE=true")
        
        print(f"[GcpWorkerClient] Starting V2 pipeline on GPU VM (Metric3D + TSDF)...")
        print(f"  Images: {local_images_dir}")
        print(f"  Output: {local_output_dir}")
        print(f"  Model: {metric3d_model}, Voxel: {voxel_size}m")
        
        # Create helper script if needed
        helper_script = Path(__file__).parent / '_call_gcp_worker_v2.js'
        
        if not helper_script.exists():
            self._create_v2_pipeline_helper(helper_script)
        
        # Build options JSON
        options = {
            'metric3dModel': metric3d_model,
            'voxelSize': voxel_size,
            'skipSegmentation': skip_segmentation,
        }
        if ar_poses:
            options['arPoses'] = ar_poses
        
        # Execute the Node.js helper
        env = os.environ.copy()
        try:
            result = subprocess.run(
                [
                    'node', str(helper_script),
                    str(local_images_dir),
                    str(local_output_dir),
                    json.dumps(options),
                ],
                capture_output=True,
                text=True,
                check=True,
                env=env,
            )
            
            # Parse JSON result
            result_data = extract_json_from_output(result.stdout)
            
            if not result_data.get('success'):
                raise RuntimeError(f"V2 pipeline failed: {result_data.get('error')}")
            
            print(f"[GcpWorkerClient] ✅ V2 pipeline complete")
            if result_data.get('mesh_path'):
                print(f"  Mesh: {result_data['mesh_path']}")
            if result_data.get('measurements_path'):
                print(f"  Measurements: {result_data['measurements_path']}")
            
            return {
                'success': True,
                'mesh_path': result_data.get('mesh_path'),
                'measurements_path': result_data.get('measurements_path'),
                'stats_path': result_data.get('stats_path'),
                'sparse_model_dir': result_data.get('sparse_model_dir'),
                'method': result_data.get('method', 'v2_metric3d_tsdf'),
            }
            
        except subprocess.CalledProcessError as e:
            print(f"[GcpWorkerClient] V2 pipeline error:", file=sys.stderr)
            print(f"  stdout: {e.stdout}", file=sys.stderr)
            print(f"  stderr: {e.stderr}", file=sys.stderr)
            try:
                error_data = extract_json_from_output(e.stdout or e.stderr or '')
                raise RuntimeError(f"V2 pipeline failed: {error_data.get('error', 'Unknown error')}")
            except ValueError:
                raise RuntimeError(f"V2 pipeline execution failed: {e.stderr}")
    
    def _create_v2_pipeline_helper(self, path: Path):
        """Create Node.js helper script for V2 pipeline"""
        
        script_content = '''#!/usr/bin/env node
/**
 * Helper script to run V2 pipeline on GCP GPU
 */

import { getGcpGpuWorker } from '../../services/gcpGpuWorker.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node _call_gcp_worker_v2.js <images_dir> <output_dir> [options_json]');
    process.exit(1);
  }
  
  const [imagesDir, outputDir, optionsJson] = args;
  const options = optionsJson ? JSON.parse(optionsJson) : {};
  
  try {
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }
    
    // Run V2 pipeline
    const result = await worker.processV2Pipeline(
      imagesDir,
      outputDir,
      options,
      (message) => {
        console.error(`[Progress] ${message}`);
      }
    );
    
    // Output result as JSON
    console.log(JSON.stringify({
      success: true,
      mesh_path: result.mesh_path,
      measurements_path: result.measurements_path,
      stats_path: result.stats_path,
      sparse_model_dir: result.sparse_model_dir,
      method: result.method,
    }));
    
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

main();
'''
        
        with open(path, 'w') as f:
            f.write(script_content)
        
        os.chmod(path, 0o755)
        print(f"[GcpWorkerClient] Created V2 pipeline helper: {path}")


if __name__ == "__main__":
    # Test the client
    client = GcpWorkerClient()
    print(f"GCP Worker available: {client.is_available()}")
