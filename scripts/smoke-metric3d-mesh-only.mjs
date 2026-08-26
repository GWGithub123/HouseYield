#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metric3d-mesh-only-'));
const outputPath = path.join(jobDir, 'outputs', 'plan.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const args = [
  'server/scripts/master_pipeline/orchestrator.py',
  '--job-dir', jobDir,
  '--output-path', outputPath,
  '--metric3d-mesh-only',
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

assert(plan.metric3dMeshOnly === true, 'plan did not enable metric3dMeshOnly');
assert(plan.mode === 'mesh_first_metric3d_primary', 'plan mode is not mesh-first primary');
assert(plan.activeDepthPriorStage === 'metric3d_priors', 'mesh-only did not force metric3d_priors');
assert(meshBranch.includes('dense_evidence'), 'mesh branch missing dense_evidence');
assert(meshBranch.includes('mesh_authoring'), 'mesh branch missing mesh_authoring');
assert(meshBranch.includes('uv_initial_bake'), 'mesh branch missing uv_initial_bake');
assert(meshBranch.includes('export_qa'), 'mesh branch missing export_qa');
assert(gaussianBranch.length === 0, 'gaussian branch should be empty for mesh-only');
assert(
  String(plan.note || '').includes('Ref-Gaussian and gaussian splatting are skipped'),
  'plan note does not document gaussian skip',
);
assert(
  !String(plan.note || '').includes('PatchMatch is skipped'),
  'plan note should not skip PatchMatch for mesh-only',
);

console.log(JSON.stringify({
  ok: true,
  jobDir,
  mode: plan.mode,
  activeDepthPriorStage: plan.activeDepthPriorStage,
  meshBranch,
  gaussianBranch,
}, null, 2));
