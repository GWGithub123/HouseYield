#!/usr/bin/env node
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
