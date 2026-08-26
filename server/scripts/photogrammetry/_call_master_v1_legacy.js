#!/usr/bin/env node
/**
 * Helper script to run the legacy photogrammetry v1 pipeline on the master-v1 VM.
 */

import { getMasterPipelineGcpWorker } from '../../services/masterPipelineGcpWorker.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node _call_master_v1_legacy.js <scan_dir> [options_json]');
    process.exit(1);
  }

  const [scanDir, optionsJson] = args;
  const options = optionsJson ? JSON.parse(optionsJson) : {};

  try {
    const worker = getMasterPipelineGcpWorker();
    if (!worker.enabled) {
      throw new Error('Master v1 GCP worker is not enabled');
    }

    const result = await worker.processLegacyPhotogrammetryScan(
      scanDir,
      options,
      (progress) => {
        const phase = progress?.phase || 'processing';
        const percent = Number.isFinite(progress?.percent) ? progress.percent : 0;
        const message = progress?.message || phase;
        console.error(`[Progress] ${phase} ${percent}% ${message}`);
      },
    );

    console.log(JSON.stringify({
      success: true,
      method: 'master_v1_legacy_photogrammetry',
      remoteGpuIndices: result.remoteGpuIndices || [],
      num_dense_points: result.num_dense_points,
      num_mesh_vertices: result.num_mesh_vertices,
      num_mesh_faces: result.num_mesh_faces,
      total_time: result.total_time,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
      remoteGpuIndices: error.remoteGpuIndices || [],
    }));
    process.exit(1);
  }
}

main();