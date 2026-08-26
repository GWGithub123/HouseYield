#!/usr/bin/env node
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
