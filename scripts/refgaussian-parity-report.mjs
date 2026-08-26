#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

function parseArgs(argv) {
  const args = {
    bundleJson: '',
    nativeRenderDir: '',
    browserRenderDir: '',
    out: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bundle-json') args.bundleJson = argv[++index] || '';
    else if (arg === '--native-render-dir') args.nativeRenderDir = argv[++index] || '';
    else if (arg === '--browser-render-dir') args.browserRenderDir = argv[++index] || '';
    else if (arg === '--out') args.out = argv[++index] || '';
  }
  if (!args.bundleJson) {
    throw new Error('Usage: node scripts/refgaussian-parity-report.mjs --bundle-json <url-or-path> [--native-render-dir <dir>] [--browser-render-dir <dir>] [--out <path>]');
  }
  return args;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function loadJson(location) {
  if (isHttpUrl(location)) {
    const response = await fetch(location, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${location}: ${response.status}`);
    }
    return response.json();
  }
  const text = await fs.readFile(location, 'utf8');
  return JSON.parse(text);
}

function resolveRelativeUrl(base, relative) {
  if (isHttpUrl(base)) {
    return new URL(relative, base).toString();
  }
  return path.resolve(path.dirname(base), relative);
}

async function rangeProbe(bundleJson, metadata, arrayName) {
  const descriptor = metadata.arrays?.find((array) => array.kind === 'array' && array.name === arrayName);
  if (!descriptor) {
    return { arrayName, available: false, reason: 'array_missing' };
  }
  const binaryLocation = resolveRelativeUrl(bundleJson, metadata.binary?.path || metadata.binary?.fileName);
  const end = descriptor.offset + Math.min(descriptor.byteLength, 128) - 1;
  if (isHttpUrl(binaryLocation)) {
    const response = await fetch(binaryLocation, {
      headers: { Range: `bytes=${descriptor.offset}-${end}` },
      cache: 'no-store',
    });
    await response.body?.cancel();
    return {
      arrayName,
      available: true,
      status: response.status,
      contentRange: response.headers.get('content-range'),
      contentLength: response.headers.get('content-length'),
    };
  }
  const handle = await fs.open(binaryLocation, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(descriptor.byteLength, 128));
    const result = await handle.read(buffer, 0, buffer.length, descriptor.offset);
    return { arrayName, available: true, status: 'file', bytesRead: result.bytesRead };
  } finally {
    await handle.close();
  }
}

async function inspectNativeRenderDir(nativeRenderDir) {
  if (!nativeRenderDir) {
    return { available: false, reason: 'native_render_dir_not_provided', frames: [] };
  }
  try {
    const entries = await fs.readdir(nativeRenderDir, { withFileTypes: true });
    const frames = entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return {
      available: frames.length > 0,
      reason: frames.length > 0 ? null : 'native_render_frames_missing',
      renderDir: nativeRenderDir,
      frameCount: frames.length,
      firstFrame: frames[0] || null,
      frames: frames.slice(0, 12),
    };
  } catch (error) {
    return {
      available: false,
      reason: 'native_render_dir_unreadable',
      error: error.message,
      renderDir: nativeRenderDir,
      frames: [],
    };
  }
}

function srgbToLinear(value) {
  const normalized = value / 255;
  if (normalized <= 0.04045) return normalized / 12.92;
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

async function loadRgba(imagePath, resizeTo = null) {
  let pipeline = sharp(imagePath).ensureAlpha();
  if (resizeTo) {
    pipeline = pipeline.resize(resizeTo.width, resizeTo.height, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function compareFramePair(referencePath, candidatePath) {
  const reference = await loadRgba(referencePath);
  const candidate = await loadRgba(candidatePath, { width: reference.width, height: reference.height });
  const pixelCount = reference.width * reference.height;
  let sumAbs = 0;
  let sumSq = 0;
  let overTolerance = 0;
  const tolerance = 8 / 255;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    let pixelAbs = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const ref = srgbToLinear(reference.data[offset + channel]);
      const cand = srgbToLinear(candidate.data[offset + channel]);
      const delta = Math.abs(ref - cand);
      pixelAbs += delta;
      sumAbs += delta;
      sumSq += delta * delta;
    }
    if ((pixelAbs / 3) > tolerance) {
      overTolerance += 1;
    }
  }

  const sampleCount = pixelCount * 3;
  const mae = sumAbs / sampleCount;
  const rmse = Math.sqrt(sumSq / sampleCount);
  const psnr = rmse > 0 ? 20 * Math.log10(1 / rmse) : Number.POSITIVE_INFINITY;
  return {
    reference: referencePath,
    candidate: candidatePath,
    width: reference.width,
    height: reference.height,
    maeLinear: mae,
    rmseLinear: rmse,
    psnr,
    mismatchRatio: overTolerance / pixelCount,
  };
}

async function inspectBrowserRenderDir(browserRenderDir, nativeRenderDir) {
  if (!browserRenderDir) {
    return { available: false, reason: 'browser_render_dir_not_provided', comparisons: [] };
  }
  try {
    const entries = await fs.readdir(browserRenderDir, { withFileTypes: true });
    const frames = entries
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (!nativeRenderDir || frames.length === 0) {
      return {
        available: frames.length > 0,
        reason: frames.length > 0 ? 'native_render_dir_missing_for_compare' : 'browser_render_frames_missing',
        renderDir: browserRenderDir,
        frameCount: frames.length,
        comparisons: [],
      };
    }
    const nativeFrames = new Set(
      (await fs.readdir(nativeRenderDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
        .map((entry) => entry.name),
    );
    const sharedFrames = frames.filter((name) => nativeFrames.has(name));
    const comparisons = [];
    for (const name of sharedFrames.slice(0, 12)) {
      comparisons.push(await compareFramePair(
        path.join(nativeRenderDir, name),
        path.join(browserRenderDir, name),
      ));
    }
    const meanMae = comparisons.length
      ? comparisons.reduce((sum, item) => sum + item.maeLinear, 0) / comparisons.length
      : null;
    const meanMismatchRatio = comparisons.length
      ? comparisons.reduce((sum, item) => sum + item.mismatchRatio, 0) / comparisons.length
      : null;
    return {
      available: frames.length > 0,
      renderDir: browserRenderDir,
      frameCount: frames.length,
      sharedFrameCount: sharedFrames.length,
      meanMaeLinear: meanMae,
      meanMismatchRatio,
      comparisons,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'browser_render_dir_unreadable',
      error: error.message,
      renderDir: browserRenderDir,
      comparisons: [],
    };
  }
}

function buildRuntimeAssetSummary(args, metadata) {
  const sidecarMaps = metadata.environmentLighting?.sidecarMaps || [];
  const bundleBin = resolveRelativeUrl(args.bundleJson, metadata.binary?.path || metadata.binary?.fileName);
  const nativeContractManifest = metadata.nativeRendererContract?.manifestPath || null;
  return {
    bundleJson: args.bundleJson,
    bundleBin,
    exportedEnvBaseArrays: (metadata.environmentLighting?.exportedArrays || []).filter((name) => /^envMap\d+Base$/.test(name)),
    environmentSidecarMaps: sidecarMaps.map((entry) => ({
      name: entry.name,
      path: resolveRelativeUrl(args.bundleJson, entry.path),
      format: entry.format || null,
      byteLength: entry.byteLength,
    })),
    nativeBsdfLutDependency: nativeContractManifest
      ? resolveRelativeUrl(nativeContractManifest, 'assets/bsdf_256_256.bin')
      : null,
    visibilityGeometryCandidate: metadata.source?.sourcePlyPath || null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const metadata = await loadJson(args.bundleJson);
  const arrayNames = (metadata.arrays || [])
    .filter((array) => array.kind === 'array')
    .map((array) => array.name);
  const requiredRendererArrays = ['positions', 'logScale', 'rotation', 'opacityLogit', 'shDc'];
  const materialArrays = ['reflectionStrength', 'roughness', 'metalness', 'indirectDc', 'indirectRest', 'indirectAsg'];
  const rangeProbes = [];
  for (const arrayName of [...requiredRendererArrays, 'envMap1Base', 'envMap2Base', ...materialArrays]) {
    rangeProbes.push(await rangeProbe(args.bundleJson, metadata, arrayName));
  }

  const nativeRendererState = metadata.nativeRendererState || null;
  const nativeRendererContract = metadata.nativeRendererContract || null;
  const runtimeAssets = buildRuntimeAssetSummary(args, metadata);
  const missingForNativeParity = [];
  if (!arrayNames.includes('envMap1Base')) {
    missingForNativeParity.push('native EnvLight.base tensor from point_cloud1.map is not exported');
  }
  if (!nativeRendererState?.fields?.scale2D?.available) {
    missingForNativeParity.push('native Ref-Gaussian 2D surfel scale fields scale_0/scale_1 are unavailable');
  }
  for (const blocker of nativeRendererContract?.unportedNativeCodePaths || []) {
    missingForNativeParity.push(blocker);
  }
  missingForNativeParity.push('native gallery camera/frame mapping is not yet validated by pixel diff');
  const activeVisibilityStrategy = runtimeAssets.visibilityGeometryCandidate
    ? 'local_visibility_mesh_bvh_plus_gaussian_proxy_and_screen_space_fallback'
    : 'local_gaussian_proxy_plus_screen_space_fallback__no_geometry_sidecar';

  const report = {
    generatedAt: new Date().toISOString(),
    bundleJson: args.bundleJson,
    pointCount: metadata.pointCount,
    actualIteration: metadata.source?.actualIteration,
    arraysAvailable: arrayNames,
    requiredRendererArraysPresent: requiredRendererArrays.every((arrayName) => arrayNames.includes(arrayName)),
    materialArraysPresent: materialArrays.filter((arrayName) => arrayNames.includes(arrayName)),
    cameraCalibration: {
      available: Boolean(metadata.cameraCalibration?.available),
      cameraCount: metadata.cameraCalibration?.cameraCount || 0,
      imageCount: metadata.cameraCalibration?.imageCount || 0,
      firstImage: metadata.cameraCalibration?.images?.[0] || null,
    },
    environmentLighting: metadata.environmentLighting || null,
    localViewerRuntimeAssets: runtimeAssets,
    localViewerVisibilityStrategy: {
      active: activeVisibilityStrategy,
      requiresVmAtViewTime: false,
      currentImplementation: runtimeAssets.visibilityGeometryCandidate
        ? 'WebGPU reflected-ray tests against a local triangle BVH when visibility geometry is published, then Gaussian proxy and screen-space depth fallbacks'
        : 'WebGPU reflected-ray tests against a bounded local Gaussian visibility proxy, followed by screen-space depth visibility fallback',
      nextUpgrade: runtimeAssets.visibilityGeometryCandidate
        ? 'validate BVH hits against native raytracing.trace output and tune reflection hit lighting'
        : 'publish geometry/BVH asset for local reflected-ray visibility',
    },
    nativeRendererState,
    nativeRendererContract,
    rangeProbes,
    nativeRender: await inspectNativeRenderDir(args.nativeRenderDir),
    browserRender: await inspectBrowserRenderDir(args.browserRenderDir, args.nativeRenderDir),
    webgpuRendererReadiness: {
      status: 'local_render_surfel_port_in_progress',
      completeStages: [
        'range metadata loading',
        'dense Gaussian attribute loading',
        'scale/rotation/opacity splat geometry',
        'native runtime asset resolution',
        'material fields and native EnvLight.base texture sampling',
        'FG LUT asset loading',
        'deferred surfel G-buffer targets',
        'projected surfel footprint rasterization',
        'transmittance-composited feature/depth/normal resolve',
        runtimeAssets.visibilityGeometryCandidate ? 'local visibility mesh BVH tracing path' : null,
        'local Gaussian reflected-ray visibility proxy',
        'screen-space reflection visibility baseline',
        'walk/orbit/dolly/pan camera controls',
      ].filter(Boolean),
      remainingStages: [
        'surf_depth / surf_normal parity validation',
        'exact CUDA tile binning/radius parity validation',
        'native raytracing.trace parity validation for BVH hits',
        'native gallery camera parity by image diff',
      ],
    },
    nativeParity: {
      achieved: false,
      missingForNativeQualityParity: missingForNativeParity,
      nextEngineeringStep: 'Validate surf_depth/surf_normal and native gallery frames by image diff, then compare browser BVH visibility hits against native raytracing.trace behavior.',
    },
  };

  if (args.out) {
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
