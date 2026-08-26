#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { mirrorMasterJobToRoomScanner } from '../server/services/masterPipelineRoomScanMirror.js';

function usage() {
  return [
    'Usage: node scripts/publish-scaffoldgs-scan.mjs --source-job-id <master_job_id> --scaffold-job-id <rerun_job_id> [options]',
    '',
    'Options:',
    '  --job-name <label>          Override saved-scan label',
    '  --wait                      Wait for remote Scaffold-GS result.json before publishing',
    '  --poll-seconds <n>          Poll interval while waiting (default: 20)',
    '  --project <id>              GCP project (default: silken-slice-480417-e0)',
    '  --zone <zone>               GCP zone (default: us-central1-f)',
    '  --vm <name>                 VM name (default: houseyield-gaussian)',
    '  --remote-root <path>        Remote jobs root (default: /opt/master-v1-data/jobs)',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    sourceJobId: '',
    scaffoldJobId: '',
    jobName: '',
    wait: false,
    pollSeconds: 20,
    project: 'silken-slice-480417-e0',
    zone: 'us-central1-f',
    vm: 'houseyield-gaussian',
    remoteRoot: '/opt/master-v1-data/jobs',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-job-id') args.sourceJobId = argv[++index] || '';
    else if (arg === '--scaffold-job-id') args.scaffoldJobId = argv[++index] || '';
    else if (arg === '--job-name') args.jobName = argv[++index] || '';
    else if (arg === '--wait') args.wait = true;
    else if (arg === '--poll-seconds') args.pollSeconds = Number(argv[++index] || args.pollSeconds);
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

  if (!args.sourceJobId || !args.scaffoldJobId) {
    throw new Error(usage());
  }

  if (!Number.isFinite(args.pollSeconds) || args.pollSeconds < 1) {
    throw new Error('poll_seconds_invalid');
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

function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDSDK_CONFIG: process.env.CLOUDSDK_CONFIG || path.join(process.env.HOME || '', '.config', 'gcloud'),
    },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit ${result.status}`);
  }
  return (result.stdout || '').trim();
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function rewriteRemotePaths(value, remoteRoot, localRoot) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteRemotePaths(entry, remoteRoot, localRoot));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteRemotePaths(entry, remoteRoot, localRoot)]),
    );
  }

  if (typeof value === 'string' && value.startsWith(remoteRoot)) {
    return path.join(localRoot, path.relative(remoteRoot, value));
  }

  return value;
}

async function rewriteJsonFilesRecursively(rootDir, remoteRoot, localRoot) {
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
        continue;
      }

      try {
        const raw = await fs.readFile(entryPath, 'utf8');
        const parsed = JSON.parse(raw);
        const rewritten = rewriteRemotePaths(parsed, remoteRoot, localRoot);
        await fs.writeFile(entryPath, `${JSON.stringify(rewritten, null, 2)}\n`);
      } catch {
        // Leave malformed JSON files untouched.
      }
    }
  }
}

function gcloudSshCommand(args, remoteCommand) {
  return [
    'compute',
    'ssh',
    args.vm,
    '--zone',
    args.zone,
    '--project',
    args.project,
    '--quiet',
    '--tunnel-through-iap',
    '--command',
    remoteCommand,
  ];
}

async function waitForRemoteResult(args) {
  if (!args.wait) {
    return;
  }

  const remoteResultPath = `${args.remoteRoot.replace(/\/$/, '')}/${args.scaffoldJobId}/gaussian/splatting/scaffold-gs/result.json`;
  const remoteSummaryPath = `${args.remoteRoot.replace(/\/$/, '')}/${args.scaffoldJobId}/gaussian/splatting/summary.json`;

  while (true) {
    const state = runCapture(
      'gcloud',
      gcloudSshCommand(
        args,
        `if [ -f "${remoteResultPath}" ] && [ -f "${remoteSummaryPath}" ]; then echo ready; else echo waiting; fi`,
      ),
    );
    if (state.includes('ready')) {
      console.log(`[publish-scaffoldgs] remote artifacts ready for ${args.scaffoldJobId}`);
      return;
    }
    console.log(`[publish-scaffoldgs] waiting for ${args.scaffoldJobId} completion...`);
    await sleep(args.pollSeconds * 1000);
  }
}

async function downloadRemoteFile(args, remotePath, localPath) {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  run('gcloud', [
    'compute',
    'scp',
    `${args.vm}:${remotePath}`,
    localPath,
    '--zone',
    args.zone,
    '--project',
    args.project,
    '--quiet',
    '--tunnel-through-iap',
  ]);
}

async function downloadRemoteArtifacts(args, localJobDir) {
  const remoteJobDir = `${args.remoteRoot.replace(/\/$/, '')}/${args.scaffoldJobId}`;
  await fs.rm(localJobDir, { recursive: true, force: true });
  await fs.mkdir(localJobDir, { recursive: true });

  const essentialFiles = [
    ['gaussian/splatting/summary.json', 'gaussian/splatting/summary.json'],
    ['gaussian/splatting/scaffold-gs/result.json', 'gaussian/splatting/scaffold-gs/result.json'],
    ['gaussian/splatting/scaffold-gs/manifest.json', 'gaussian/splatting/scaffold-gs/manifest.json'],
    ['gaussian/splatting/scaffold-gs/output/final/scene.splat', 'gaussian/splatting/scaffold-gs/output/final/scene.splat'],
    ['gaussian/splatting/scaffold-gs/output/final/scene.ply', 'gaussian/splatting/scaffold-gs/output/final/scene.ply'],
    ['gaussian/splatting/scaffold-gs/output/source/sparse/0/points3D.txt', 'gaussian/splatting/scaffold-gs/output/source/sparse/0/points3D.txt'],
    ['gaussian/splatting/scaffold-gs/output/init_preflight_summary.json', 'gaussian/splatting/scaffold-gs/output/init_preflight_summary.json'],
    ['logs/scaffold_gs_only.log', 'logs/scaffold_gs_only.log'],
  ];

  for (const [remoteRelativePath, localRelativePath] of essentialFiles) {
    const remotePath = `${remoteJobDir}/${remoteRelativePath}`;
    const localPath = path.join(localJobDir, localRelativePath);
    console.log(`[publish-scaffoldgs] downloading ${remoteRelativePath}`);
    try {
      await downloadRemoteFile(args, remotePath, localPath);
    } catch (error) {
      if (remoteRelativePath.includes('init_preflight_summary') || remoteRelativePath.includes('manifest.json') || remoteRelativePath.endsWith('.log')) {
        console.warn(`[publish-scaffoldgs] optional artifact missing: ${remoteRelativePath}`);
        continue;
      }
      throw error;
    }
  }

  await rewriteJsonFilesRecursively(localJobDir, remoteJobDir, localJobDir);
}

async function bakeColoredFallbackPly(repoRoot, localJobDir) {
  const resultPath = path.join(localJobDir, 'gaussian', 'splatting', 'scaffold-gs', 'result.json');
  const result = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
  if (!result || result.renderMode !== 'converted_splat_fallback') {
    return;
  }

  const anchorPlyPath = path.join(localJobDir, 'gaussian', 'splatting', 'scaffold-gs', 'output', 'final', 'scene.ply');
  const sourcePointsPath = path.join(localJobDir, 'gaussian', 'splatting', 'scaffold-gs', 'output', 'source', 'sparse', '0', 'points3D.txt');
  const bakeScriptPath = path.join(repoRoot, 'scripts', 'bake-scaffoldgs-fallback-ply.py');
  if (!await fileExists(anchorPlyPath) || !await fileExists(sourcePointsPath) || !await fileExists(bakeScriptPath)) {
    return;
  }

  const coloredPlyPath = path.join(localJobDir, 'gaussian', 'splatting', 'scaffold-gs', 'output', 'final', 'scene.colored.ply');
  run('python3', [
    bakeScriptPath,
    '--anchor-ply',
    anchorPlyPath,
    '--source-points',
    sourcePointsPath,
    '--output-ply',
    coloredPlyPath,
  ]);
  await fs.copyFile(coloredPlyPath, anchorPlyPath);
}

function buildSyntheticJob(sourceJob, args) {
  const now = new Date().toISOString();
  const label = args.jobName || `${sourceJob.jobName} (Scaffold-GS)`;
  const inputOptions = {
    ...(sourceJob.requestedProcessing?.inputOptions || {}),
    gaussianOnly: true,
    requireGaussianSplatting: true,
    requireRefGaussian: false,
    refGaussianOnly: false,
    preferredGaussianBackend: 'scaffold_gs',
    scaffoldGsOnly: true,
    scaffoldGsRequired: true,
  };

  return {
    ...sourceJob,
    id: args.scaffoldJobId,
    status: 'completed',
    updatedAt: now,
    jobName: label,
    primaryOutput: 'scaffold_gs_splats',
    metadata: {
      ...(sourceJob.metadata || {}),
      roomName: label,
      completedAt: now,
      sourceMasterJobId: sourceJob.id,
      recoveryPublishedAt: now,
      scaffoldGsPublishedAt: now,
      roomScanModelViewerUrl: null,
      roomScanPrimaryOutput: null,
      roomScanMirroredAt: null,
    },
    requestedProcessing: {
      ...(sourceJob.requestedProcessing || {}),
      inputOptions,
      executionPlan: {
        ...(sourceJob.requestedProcessing?.executionPlan || {}),
        gaussianOnly: true,
        primaryOutputIntent: 'gaussian_splats',
        finalAsset: 'gaussian_splats',
        gaussianBranch: 'scaffold_gs_only',
      },
    },
    outputs: {
      ...(sourceJob.outputs || {}),
      gaussianSummaryPath: `/api/master-reconstruction/jobs/${args.scaffoldJobId}/artifacts/gaussian/splatting/summary.json`,
      gaussianScenePath: null,
      gaussianPlyPath: null,
      gaussianViewerPath: null,
      refGaussianSummaryPath: null,
      refGaussianScenePath: null,
      refGaussianPlyPath: null,
      refGaussianViewerPath: null,
      refGaussianNativeRenderContractPath: null,
      refGaussianNativeRenderContractManifestPath: null,
    },
  };
}

function buildSyntheticStatus(sourceStatus, syntheticJob) {
  return {
    ...(sourceStatus || {}),
    jobId: syntheticJob.id,
    status: 'completed',
    updatedAt: syntheticJob.updatedAt,
    capture: syntheticJob.capture,
    outputs: syntheticJob.outputs,
    requestedProcessing: syntheticJob.requestedProcessing,
  };
}

async function writeSyntheticJobArtifacts(localJobDir, syntheticJob, syntheticStatus) {
  await fs.writeFile(path.join(localJobDir, 'job.json'), `${JSON.stringify(syntheticJob, null, 2)}\n`);
  await fs.writeFile(path.join(localJobDir, 'status.json'), `${JSON.stringify(syntheticStatus, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const sourceJobDir = path.join(repoRoot, 'server', 'data', 'master-jobs', args.sourceJobId);
  const localJobDir = path.join(repoRoot, 'server', 'data', 'master-jobs', args.scaffoldJobId);

  if (!await fileExists(path.join(sourceJobDir, 'job.json'))) {
    throw new Error(`source_job_missing:${sourceJobDir}`);
  }

  await waitForRemoteResult(args);
  await downloadRemoteArtifacts(args, localJobDir);
  await bakeColoredFallbackPly(repoRoot, localJobDir);

  const sourceJob = JSON.parse(await fs.readFile(path.join(sourceJobDir, 'job.json'), 'utf8'));
  const sourceStatus = await fs.readFile(path.join(sourceJobDir, 'status.json'), 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const syntheticJob = buildSyntheticJob(sourceJob, args);
  const syntheticStatus = buildSyntheticStatus(sourceStatus, syntheticJob);

  await writeSyntheticJobArtifacts(localJobDir, syntheticJob, syntheticStatus);

  const { roomScanId, roomScanData } = await mirrorMasterJobToRoomScanner(syntheticJob);
  syntheticJob.metadata = {
    ...syntheticJob.metadata,
    roomScanId,
    roomScanModelViewerUrl: roomScanData?.metadata?.modelViewerUrl || null,
    roomScanPrimaryOutput: roomScanData?.metadata?.primaryOutput || null,
    roomScanMirrorStatus: 'completed',
    roomScanMirroredAt: new Date().toISOString(),
  };
  syntheticStatus.updatedAt = syntheticJob.metadata.roomScanMirroredAt;
  await writeSyntheticJobArtifacts(localJobDir, syntheticJob, syntheticStatus);

  console.log(JSON.stringify({
    sourceJobId: args.sourceJobId,
    scaffoldJobId: args.scaffoldJobId,
    roomScanId,
    roomName: syntheticJob.jobName,
    modelViewerUrl: roomScanData?.metadata?.modelViewerUrl || null,
    primaryOutput: roomScanData?.metadata?.primaryOutput || null,
  }, null, 2));
}

main().catch((error) => {
  console.error('[publish-scaffoldgs] failed:', error);
  process.exit(1);
});
