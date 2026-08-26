#!/usr/bin/env node
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
      textured_mesh_path: result.textured_mesh_path,
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
