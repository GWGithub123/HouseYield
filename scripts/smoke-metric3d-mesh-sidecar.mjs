#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metric3d-mesh-sidecar-'));
const outputPath = path.join(jobDir, 'outputs', 'plan.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const args = [
  'server/scripts/master_pipeline/orchestrator.py',
  '--job-dir', jobDir,
  '--output-path', outputPath,
  '--gaussian-only',
  '--ref-gaussian-only',
  '--metric3d-mesh-sidecar',
  '--gaussian-viewer-preset', 'legacy_metric3d_sharp_mirror',
  '--learned-matching-preset', 'roma_v2',
  '--dry-run',
];

const result = spawnSync('python3', args, {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  throw new Error(`orchestrator dry-run failed with exit ${result.status}`);
}

const plan = JSON.parse(await fs.readFile(outputPath, 'utf8'));
const meshBranch = plan.branchGraph?.post_global_sfm?.meshBranch || [];
const gaussianBranch = plan.branchGraph?.post_global_sfm?.gaussianBranch || [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(plan.metric3dMeshSidecar === true, 'plan did not enable metric3dMeshSidecar');
assert(plan.activeDepthPriorStage === 'metric3d_priors', 'sidecar did not force metric3d_priors');
assert(meshBranch.includes('dense_evidence'), 'mesh branch missing dense_evidence');
assert(meshBranch.includes('mesh_authoring'), 'mesh branch missing mesh_authoring');
assert(meshBranch.includes('uv_initial_bake'), 'mesh branch missing uv_initial_bake');
assert(meshBranch.includes('export_qa'), 'mesh branch missing export_qa');
assert(gaussianBranch.includes('gaussian_splatting'), 'gaussian branch missing gaussian_splatting');
assert(
  String(plan.note || '').includes('COLMAP dense PatchMatch is skipped'),
  'plan note does not document PatchMatch skip',
);

console.log(JSON.stringify({
  ok: true,
  jobDir,
  mode: plan.mode,
  activeDepthPriorStage: plan.activeDepthPriorStage,
  meshBranch,
  gaussianBranch,
}, null, 2));
