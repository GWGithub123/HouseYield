#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const FEET_PER_METER = 3.28084;
const SQFT_PER_SQM = 10.7639;

function usage() {
  return [
    'Usage: node scripts/publish-refgaussian-mesh-hybrid-scan.mjs --scan-id <room_scan_id> [options]',
    '',
    'Options:',
    '  --hybrid-dir <path>         Local refgaussian_mesh_hybrid directory',
    '  --vm-job-id <id>            Remote master job id on houseyield-gaussian VM',
    '  --project <id>              GCP project (default: silken-slice-480417-e0)',
    '  --zone <zone>               GCP zone (default: us-central1-f)',
    '  --vm <name>                 VM name (default: houseyield-gaussian)',
    '  --remote-root <path>        Remote jobs root (default: /opt/master-v1-data/jobs)',
    '',
    'Provide either --hybrid-dir or --vm-job-id.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    scanId: '',
    hybridDir: '',
    vmJobId: '',
    project: 'silken-slice-480417-e0',
    zone: 'us-central1-f',
    vm: 'houseyield-gaussian',
    remoteRoot: '/opt/master-v1-data/jobs',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scan-id') args.scanId = argv[++index] || '';
    else if (arg === '--hybrid-dir') args.hybridDir = argv[++index] || '';
    else if (arg === '--vm-job-id') args.vmJobId = argv[++index] || '';
    else if (arg === '--project') args.project = argv[++index] || args.project;
    else if (arg === '--zone') args.zone = argv[++index] || args.zone;
    else if (arg === '--vm') args.vm = argv[++index] || args.vm;
    else if (arg === '--remote-root') args.remoteRoot = argv[++index] || args.remoteRoot;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.scanId || (!args.hybridDir && !args.vmJobId)) {
    throw new Error(usage());
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      CLOUDSDK_CONFIG: process.env.CLOUDSDK_CONFIG || path.join(process.env.HOME || '', '.config', 'gcloud'),
    },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit ${result.status}`);
  }
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!sourcePath || !await fileExists(sourcePath)) {
    return false;
  }
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

function buildRoomDimensions(bounds) {
  if (!bounds?.min || !bounds?.max || bounds.min.length < 3 || bounds.max.length < 3) {
    return {};
  }

  const width = Math.max(0, Number(bounds.max[0]) - Number(bounds.min[0]));
  const height = Math.max(0, Number(bounds.max[1]) - Number(bounds.min[1]));
  const length = Math.max(0, Number(bounds.max[2]) - Number(bounds.min[2]));
  const area = width * length;
  const volume = area * height;

  return {
    width,
    length,
    height,
    area,
    volume,
    widthFeet: width * FEET_PER_METER,
    lengthFeet: length * FEET_PER_METER,
    heightFeet: height * FEET_PER_METER,
    floorAreaSqM: area,
    floorAreaSqFt: area * SQFT_PER_SQM,
  };
}

async function resolveHybridDir(args, repoRoot) {
  if (args.hybridDir) {
    return path.resolve(args.hybridDir);
  }

  const stagingDir = path.join(repoRoot, '.tmp', `refgaussian-mesh-hybrid-pull-${args.vmJobId}`);
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  const remoteHybridDir = `${args.remoteRoot.replace(/\/$/, '')}/${args.vmJobId}/refgaussian_mesh_hybrid`;
  run('gcloud', [
    'compute',
    'scp',
    '--recurse',
    `${args.vm}:${remoteHybridDir}`,
    stagingDir,
    '--zone',
    args.zone,
    '--project',
    args.project,
    '--quiet',
    '--tunnel-through-iap',
  ]);

  const pulledDir = path.join(stagingDir, 'refgaussian_mesh_hybrid');
  if (!await fileExists(pulledDir)) {
    throw new Error(`remote_hybrid_dir_missing:${remoteHybridDir}`);
  }
  return pulledDir;
}

async function publishHybridToScan(scanId, hybridDir) {
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const roomScanDir = path.join(repoRoot, 'server', 'data', 'room-scans', scanId);
  const metadataPath = path.join(roomScanDir, 'metadata.json');
  const modelDir = path.join(roomScanDir, 'model');
  const artifactsDir = path.join(roomScanDir, 'artifacts', 'master_ref_gaussian_mesh');

  if (!await fileExists(metadataPath)) {
    throw new Error(`saved_scan_missing:${metadataPath}`);
  }

  const summary = JSON.parse(await fs.readFile(path.join(hybridDir, 'summary.json'), 'utf8'));
  await fs.mkdir(modelDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });

  const copiedSummary = await copyIfPresent(
    path.join(hybridDir, 'summary.json'),
    path.join(artifactsDir, 'summary.json'),
  );
  const copiedSurface = await copyIfPresent(
    path.join(hybridDir, 'surface', 'normalized_surface_points.ply'),
    path.join(artifactsDir, 'normalized_surface_points.ply'),
  );
  const copiedMesh = await copyIfPresent(
    path.join(hybridDir, 'mesh', 'meshed_poisson.ply'),
    path.join(artifactsDir, 'meshed_poisson.ply'),
  );
  const copiedObj = await copyIfPresent(
    path.join(hybridDir, 'texture', 'detail_texture', 'model.obj'),
    path.join(modelDir, 'model.obj'),
  );
  const copiedMtl = await copyIfPresent(
    path.join(hybridDir, 'texture', 'detail_texture', 'model.mtl'),
    path.join(modelDir, 'model.mtl'),
  );
  const copiedTexture = await copyIfPresent(
    path.join(hybridDir, 'texture', 'detail_texture', 'texture.jpg'),
    path.join(modelDir, 'texture.jpg'),
  );

  if (!copiedSummary || !copiedMesh || !copiedObj) {
    throw new Error('refgaussian_mesh_hybrid_publish_incomplete');
  }

  const roomScanData = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const roomDimensions = buildRoomDimensions(summary.dimensions);
  const refGaussianMeshHybridArtifacts = {
    summaryPath: 'artifacts/master_ref_gaussian_mesh/summary.json',
    summaryUrl: `/api/room-scanner/scans/${scanId}/artifacts/master_ref_gaussian_mesh/summary.json`,
    method: 'refgaussian_surface_poisson_openmvs',
    numVertices: Number(summary.numVertices || 0),
    numFaces: Number(summary.numFaces || 0),
    pointCount: Number(summary.surfaceExtraction?.pointCount || 0),
  };

  if (copiedSurface) {
    refGaussianMeshHybridArtifacts.surfacePath = 'artifacts/master_ref_gaussian_mesh/normalized_surface_points.ply';
    refGaussianMeshHybridArtifacts.surfaceUrl = `/api/room-scanner/scans/${scanId}/artifacts/master_ref_gaussian_mesh/normalized_surface_points.ply`;
  }
  if (copiedMesh) {
    refGaussianMeshHybridArtifacts.meshPath = 'artifacts/master_ref_gaussian_mesh/meshed_poisson.ply';
    refGaussianMeshHybridArtifacts.meshUrl = `/api/room-scanner/scans/${scanId}/artifacts/master_ref_gaussian_mesh/meshed_poisson.ply`;
  }
  if (copiedObj) {
    refGaussianMeshHybridArtifacts.texturedObjPath = 'model/model.obj';
    refGaussianMeshHybridArtifacts.texturedObjUrl = `/api/room-scanner/scans/${scanId}/model/model.obj`;
  }
  if (copiedMtl) {
    refGaussianMeshHybridArtifacts.mtlPath = 'model/model.mtl';
    refGaussianMeshHybridArtifacts.mtlUrl = `/api/room-scanner/scans/${scanId}/model/model.mtl`;
  }
  if (copiedTexture) {
    refGaussianMeshHybridArtifacts.texturePath = 'model/texture.jpg';
    refGaussianMeshHybridArtifacts.textureUrl = `/api/room-scanner/scans/${scanId}/model/texture.jpg`;
  }

  roomScanData.metadata = roomScanData.metadata || {};
  roomScanData.metadata.processingResult = {
    ...(roomScanData.metadata.processingResult || {}),
    numVertices: Number(summary.numVertices || 0),
    numFaces: Number(summary.numFaces || 0),
    dimensions: roomDimensions,
  };
  roomScanData.metadata.roomDimensions = roomDimensions;
  roomScanData.metadata.refGaussianMeshHybridArtifacts = refGaussianMeshHybridArtifacts;
  roomScanData.metadata.modelFiles = {
    ...(roomScanData.metadata.modelFiles || {}),
    ...(copiedObj ? { obj: 'model/model.obj' } : {}),
    ...(copiedMtl ? { mtl: 'model/model.mtl' } : {}),
    ...(copiedTexture ? { texture: 'model/texture.jpg' } : {}),
  };
  roomScanData.metadata.outputs = {
    ...(roomScanData.metadata.outputs || {}),
    refGaussianMeshHybridSummaryPath: refGaussianMeshHybridArtifacts.summaryPath,
    refGaussianMeshHybridSurfacePath: refGaussianMeshHybridArtifacts.surfacePath || null,
    refGaussianMeshHybridMeshPath: refGaussianMeshHybridArtifacts.meshPath || null,
    refGaussianMeshHybridTexturedObjPath: refGaussianMeshHybridArtifacts.texturedObjPath || null,
  };

  await fs.writeFile(metadataPath, `${JSON.stringify(roomScanData, null, 2)}\n`);

  console.log(JSON.stringify({
    scanId,
    numVertices: summary.numVertices,
    numFaces: summary.numFaces,
    modelObj: copiedObj,
    modelMtl: copiedMtl,
    textureJpg: copiedTexture,
    metadataPath,
  }, null, 2));
}

const args = parseArgs(process.argv);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const hybridDir = await resolveHybridDir(args, repoRoot);
await publishHybridToScan(args.scanId, hybridDir);
