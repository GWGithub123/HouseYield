#!/usr/bin/env node
/**
 * Helper script to run the hybrid pipeline on the GCP GPU worker.
 */

import { getGcpGpuWorker } from '../../services/gcpGpuWorker.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node _call_gcp_worker_hybrid.js <images_dir> <output_dir> [options_json]');
    process.exit(1);
  }

  const [imagesDir, outputDir, optionsJson] = args;
  const options = optionsJson ? JSON.parse(optionsJson) : {};

  try {
    const worker = getGcpGpuWorker();

    if (!worker.enabled) {
      throw new Error('GCP GPU Worker is not enabled');
    }

    const result = await worker.processHybridPipeline(
      imagesDir,
      outputDir,
      options,
      (message) => {
        console.error(`[Progress] ${message}`);
      }
    );

    console.log(JSON.stringify({
      success: true,
      mesh_path: result.mesh_path,
      measurements_path: result.measurements_path,
      stats_path: result.stats_path,
      sparse_model_dir: result.sparse_model_dir,
      hybrid_manifest_path: result.hybrid_manifest_path,
      viewer_path: result.viewer_path,
      splat_scene_path: result.splat_scene_path,
      used_room_tour_splat: result.used_room_tour_splat,
      fallback_reason: result.fallback_reason,
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