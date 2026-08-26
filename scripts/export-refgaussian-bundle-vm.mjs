#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

function usage() {
  return [
    'Usage: node scripts/export-refgaussian-bundle-vm.mjs --job-id <master_job_id> [options]',
    '',
    'Options:',
    '  --project <id>              GCP project (default: silken-slice-480417-e0)',
    '  --zone <zone>               GCP zone (default: us-central1-f)',
    '  --vm <name>                 VM name (default: houseyield-gaussian)',
    '  --remote-root <path>        Remote jobs root (default: /opt/master-v1-data/jobs)',
    '  --remote-python <path>      Remote Python (default: /opt/ref-gaussian-venv/bin/python3)',
    '  --iterations <n>            Checkpoint iteration (default: latest from model dir)',
    '  --no-deploy-helper          Use helper already present on VM',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    jobId: '',
    project: 'silken-slice-480417-e0',
    zone: 'us-central1-f',
    vm: 'houseyield-gaussian',
    remoteRoot: '/opt/master-v1-data/jobs',
    remotePython: '/opt/ref-gaussian-venv/bin/python3',
    iterations: '',
    deployHelper: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--job-id') args.jobId = argv[++index] || '';
    else if (arg === '--project') args.project = argv[++index] || args.project;
    else if (arg === '--zone') args.zone = argv[++index] || args.zone;
    else if (arg === '--vm') args.vm = argv[++index] || args.vm;
    else if (arg === '--remote-root') args.remoteRoot = argv[++index] || args.remoteRoot;
    else if (arg === '--remote-python') args.remotePython = argv[++index] || args.remotePython;
    else if (arg === '--iterations') args.iterations = argv[++index] || '';
    else if (arg === '--no-deploy-helper') args.deployHelper = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.jobId) {
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function gcloudBase(args) {
  return ['compute'];
}

function sshArgs(args, remoteCommand) {
  return [
    ...gcloudBase(args),
    'ssh',
    args.vm,
    '--zone',
    args.zone,
    '--project',
    args.project,
    '--quiet',
    '--command',
    remoteCommand,
  ];
}

function scpArgs(args, localPath, remotePath) {
  return [
    ...gcloudBase(args),
    'scp',
    localPath,
    `${args.vm}:${remotePath}`,
    '--zone',
    args.zone,
    '--project',
    args.project,
    '--quiet',
  ];
}

const args = parseArgs(process.argv);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const helperPath = path.join(repoRoot, 'server/scripts/master_pipeline/refgaussian_bundle.py');
const remoteHelperPath = args.deployHelper
  ? '/tmp/houseyield-refgaussian-bundle.py'
  : '/opt/master-v1-service/server/scripts/master_pipeline/refgaussian_bundle.py';
const jobRoot = `${args.remoteRoot.replace(/\/$/, '')}/${args.jobId}`;
const refGaussianRoot = `${jobRoot}/gaussian/splatting/ref-gaussian`;
const outputRoot = `${refGaussianRoot}/output`;
const modelDir = `${outputRoot}/refgaussian-model`;
const finalDir = `${outputRoot}/final`;
const manifestPath = `${refGaussianRoot}/manifest.json`;
const sourcePlyPath = args.iterations
  ? `${modelDir}/point_cloud/iteration_${String(args.iterations).padStart(5, '0')}/point_cloud.ply`
  : '';

if (args.deployHelper) {
  run('gcloud', scpArgs(args, helperPath, remoteHelperPath));
}

const exportPieces = [
  'set -euo pipefail',
  `HELPER=${shellQuote(remoteHelperPath)}`,
  `PYTHON=${shellQuote(args.remotePython)}`,
  `MODEL_DIR=${shellQuote(modelDir)}`,
  `FINAL_DIR=${shellQuote(finalDir)}`,
  `MANIFEST=${shellQuote(manifestPath)}`,
  'test -f "$HELPER"',
  'test -d "$MODEL_DIR"',
  'test -d "$FINAL_DIR"',
  'test -f "$MANIFEST"',
  '"$PYTHON" "$HELPER" export --model-dir "$MODEL_DIR" --final-dir "$FINAL_DIR" --manifest "$MANIFEST"' +
    (args.iterations ? ` --iterations ${Number(args.iterations)}` : '') +
    (sourcePlyPath ? ' --source-ply ' + shellQuote(sourcePlyPath) : ''),
  '"$PYTHON" "$HELPER" validate --bundle-json "$FINAL_DIR/scene.refgaussian.json" --sample-count 64',
  'ls -lh "$FINAL_DIR"/scene.refgaussian.*',
];

run('gcloud', sshArgs(args, exportPieces.join('; ')));
