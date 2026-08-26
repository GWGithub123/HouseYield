#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { PNG } from 'pngjs';

function usage() {
  return [
    'Usage: node scripts/compare-refgaussian-frame.mjs --reference <png> --candidate <png> [options]',
    '',
    'Options:',
    '  --diff-out <path>          Write an RGBA diff heatmap PNG',
    '  --resize-candidate        Resize candidate to reference dimensions before compare',
    '  --json                    Emit JSON only',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    reference: '',
    candidate: '',
    diffOut: '',
    resizeCandidate: false,
    json: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reference') args.reference = argv[++index] || '';
    else if (arg === '--candidate') args.candidate = argv[++index] || '';
    else if (arg === '--diff-out') args.diffOut = argv[++index] || '';
    else if (arg === '--resize-candidate') args.resizeCandidate = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.reference || !args.candidate) {
    throw new Error(usage());
  }
  return args;
}

async function loadRgba(imagePath, resizeTo = null) {
  let pipeline = sharp(imagePath).ensureAlpha();
  const metadata = await pipeline.metadata();
  if (resizeTo) {
    pipeline = pipeline.resize(resizeTo.width, resizeTo.height, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    path: imagePath,
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
    sourceWidth: metadata.width || info.width,
    sourceHeight: metadata.height || info.height,
  };
}

function srgbToLinear(value) {
  const normalized = value / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const srgb = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

async function writeDiffPng(diffOut, width, height, diffValues) {
  const png = new PNG({ width, height });
  for (let index = 0; index < diffValues.length; index += 1) {
    const offset = index * 4;
    const value = diffValues[index];
    png.data[offset] = linearToSrgbByte(value);
    png.data[offset + 1] = linearToSrgbByte(value * 0.35);
    png.data[offset + 2] = linearToSrgbByte(1 - Math.min(1, value * 0.85));
    png.data[offset + 3] = 255;
  }
  await fs.mkdir(path.dirname(diffOut), { recursive: true });
  await fs.writeFile(diffOut, PNG.sync.write(png));
}

async function main() {
  const args = parseArgs(process.argv);
  const reference = await loadRgba(args.reference);
  const candidate = await loadRgba(
    args.candidate,
    args.resizeCandidate ? { width: reference.width, height: reference.height } : null,
  );

  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `Image dimensions differ: reference=${reference.width}x${reference.height} candidate=${candidate.width}x${candidate.height}. ` +
      'Use --resize-candidate if you want an automatic compare.',
    );
  }

  const pixelCount = reference.width * reference.height;
  let sumAbs = 0;
  let sumSq = 0;
  let maxAbs = 0;
  let overTolerance = 0;
  const diffValues = args.diffOut ? new Float32Array(pixelCount) : null;
  const tolerance = 8 / 255;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    let pixelAbs = 0;
    let pixelSq = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const ref = srgbToLinear(reference.data[offset + channel]);
      const cand = srgbToLinear(candidate.data[offset + channel]);
      const delta = Math.abs(ref - cand);
      pixelAbs += delta;
      pixelSq += delta * delta;
      sumAbs += delta;
      sumSq += delta * delta;
      maxAbs = Math.max(maxAbs, delta);
    }
    const meanPixelAbs = pixelAbs / 3;
    if (meanPixelAbs > tolerance) {
      overTolerance += 1;
    }
    if (diffValues) {
      diffValues[pixelIndex] = Math.min(1, Math.sqrt(pixelSq / 3) * 4.0);
    }
  }

  const sampleCount = pixelCount * 3;
  const mae = sumAbs / sampleCount;
  const rmse = Math.sqrt(sumSq / sampleCount);
  const psnr = rmse > 0 ? 20 * Math.log10(1 / rmse) : Number.POSITIVE_INFINITY;
  const mismatchRatio = overTolerance / pixelCount;

  if (args.diffOut && diffValues) {
    await writeDiffPng(args.diffOut, reference.width, reference.height, diffValues);
  }

  const summary = {
    reference: {
      path: path.resolve(args.reference),
      width: reference.width,
      height: reference.height,
    },
    candidate: {
      path: path.resolve(args.candidate),
      width: candidate.width,
      height: candidate.height,
      resized: args.resizeCandidate,
      sourceWidth: candidate.sourceWidth,
      sourceHeight: candidate.sourceHeight,
    },
    metrics: {
      maeLinear: mae,
      rmseLinear: rmse,
      psnr,
      maxAbsLinear: maxAbs,
      mismatchRatio,
      mismatchToleranceLinear: tolerance,
    },
    diffOut: args.diffOut ? path.resolve(args.diffOut) : null,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Reference: ${summary.reference.path}`);
  console.log(`Candidate: ${summary.candidate.path}${summary.candidate.resized ? ' (resized for compare)' : ''}`);
  console.log(`Dimensions: ${reference.width}x${reference.height}`);
  console.log(`MAE (linear): ${mae.toFixed(6)}`);
  console.log(`RMSE (linear): ${rmse.toFixed(6)}`);
  console.log(`PSNR: ${Number.isFinite(psnr) ? psnr.toFixed(2) : 'inf'} dB`);
  console.log(`Max abs delta: ${maxAbs.toFixed(6)}`);
  console.log(`Pixels over tolerance: ${(mismatchRatio * 100).toFixed(2)}%`);
  if (summary.diffOut) {
    console.log(`Diff heatmap: ${summary.diffOut}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
