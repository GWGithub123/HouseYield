#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const jsonOutput = args.includes('--json');
const positional = args.filter((arg) => !arg.startsWith('--'));

if (positional.length < 1) {
  console.error('Usage: node scripts/validate-refgaussian-contract.mjs <native-render-contract-dir> [--strict] [--json]');
  process.exit(2);
}

const contractDir = path.resolve(positional[0]);

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, 'utf8'));
}

function normalizeContractPath(rawPath) {
  if (!rawPath) {
    return null;
  }
  return path.isAbsolute(rawPath) ? rawPath : path.join(contractDir, rawPath);
}

const requiredEntries = [
  ['manifest.json', 'contract_manifest'],
  ['renderer-files/eval.py', 'eval_py'],
  ['renderer-files/gaussian_renderer', 'gaussian_renderer'],
  ['renderer-files/scene/gaussian_model.py', 'gaussian_model'],
  ['renderer-files/scene/light.py', 'scene_light'],
  ['renderer-files/utils/refl_utils.py', 'reflection_utils'],
  ['assets/bsdf_256_256.bin', 'bsdf_lut'],
  ['native-modules/manifest.json', 'native_modules_manifest'],
  ['checkpoint-contract.json', 'checkpoint_contract'],
  ['cameras.json', 'cameras_contract'],
  ['render-args.json', 'render_args'],
];

const missing = [];
for (const [relativePath, name] of requiredEntries) {
  const targetPath = path.join(contractDir, relativePath);
  if (!await pathExists(targetPath)) {
    missing.push({
      name,
      path: relativePath,
      reason: 'required_contract_entry_missing',
    });
  }
}

let manifest = null;
let checkpointContract = null;
let nativeModulesManifest = null;

if (await pathExists(path.join(contractDir, 'manifest.json'))) {
  manifest = await readJson(path.join(contractDir, 'manifest.json'));
  for (const entry of manifest.missingFiles || []) {
    missing.push({
      name: entry.name || entry.path || entry.role || 'manifest_missing_file',
      path: entry.path || entry.expectedPath || null,
      kind: entry.kind || null,
      reason: entry.reason || 'reported_missing_in_manifest',
    });
  }
}

if (await pathExists(path.join(contractDir, 'checkpoint-contract.json'))) {
  checkpointContract = await readJson(path.join(contractDir, 'checkpoint-contract.json'));
  for (const tensor of checkpointContract.missingRenderTensors || []) {
    missing.push({
      name: tensor,
      kind: 'render_tensor',
      reason: 'render_tensor_missing_from_bundle',
    });
  }
}

if (await pathExists(path.join(contractDir, 'native-modules', 'manifest.json'))) {
  nativeModulesManifest = await readJson(path.join(contractDir, 'native-modules', 'manifest.json'));
  for (const moduleEntry of nativeModulesManifest.modules || []) {
    if (moduleEntry.required && !moduleEntry.present) {
      missing.push({
        name: moduleEntry.name,
        kind: 'native_module',
        reason: 'required_native_module_missing',
      });
    }
  }
}

const summary = {
  ok: missing.length === 0,
  strict,
  contractDir,
  generatedAt: manifest?.generatedAt || null,
  copiedSourceCount: manifest?.renderer?.copiedSourceCount || 0,
  copiedAssetCount: manifest?.renderer?.copiedAssetCount || 0,
  nativeFrameCount: manifest?.nativeGallery?.frameCount || 0,
  availableRenderTensors: checkpointContract?.availableRenderTensors || [],
  missingCount: missing.length,
  missing,
  manifestPath: normalizeContractPath(manifest?.paths?.manifest || 'manifest.json'),
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Ref-Gaussian native render contract: ${summary.ok ? 'OK' : 'missing blockers'}`);
  console.log(`Contract: ${summary.contractDir}`);
  console.log(`Sources copied: ${summary.copiedSourceCount}`);
  console.log(`Assets copied: ${summary.copiedAssetCount}`);
  console.log(`Native frames: ${summary.nativeFrameCount}`);
  console.log(`Available render tensors: ${summary.availableRenderTensors.length}`);
  if (missing.length > 0) {
    console.log(`Missing/blocking entries: ${missing.length}`);
    for (const entry of missing.slice(0, 80)) {
      const label = entry.path ? `${entry.name} (${entry.path})` : entry.name;
      console.log(`- ${label}: ${entry.reason}`);
    }
    if (missing.length > 80) {
      console.log(`- ... ${missing.length - 80} more`);
    }
  }
}

process.exit(strict && missing.length > 0 ? 1 : 0);
