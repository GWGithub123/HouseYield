#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function quantileSorted(values, q) {
  if (!values.length) return 0;
  const index = Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)));
  return values[index];
}

function computeQuantiles(sortedValues, qs) {
  return Object.fromEntries(qs.map((q) => [q, quantileSorted(sortedValues, q)]));
}

async function main() {
  const [, , inputPathArg, outputPathArg] = process.argv;
  if (!inputPathArg || !outputPathArg) {
    throw new Error('Usage: node scripts/filter-scaffold-splat.mjs <input.splat> <output.splat>');
  }

  const inputPath = path.resolve(inputPathArg);
  const outputPath = path.resolve(outputPathArg);
  const buffer = await fs.readFile(inputPath);
  const stride = 32;
  if (buffer.length % stride !== 0) {
    throw new Error(`Unexpected splat byte length ${buffer.length}; not divisible by ${stride}`);
  }

  const count = buffer.length / stride;
  const xs = new Array(count);
  const ys = new Array(count);
  const zs = new Array(count);
  const maxScales = new Array(count);
  const alphas = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    xs[index] = buffer.readFloatLE(offset);
    ys[index] = buffer.readFloatLE(offset + 4);
    zs[index] = buffer.readFloatLE(offset + 8);
    const sx = buffer.readFloatLE(offset + 12);
    const sy = buffer.readFloatLE(offset + 16);
    const sz = buffer.readFloatLE(offset + 20);
    maxScales[index] = Math.max(sx, sy, sz);
    alphas[index] = buffer[offset + 27];
  }

  const sortedX = [...xs].sort((a, b) => a - b);
  const sortedY = [...ys].sort((a, b) => a - b);
  const sortedZ = [...zs].sort((a, b) => a - b);
  const sortedMaxScale = [...maxScales].sort((a, b) => a - b);

  const xq = computeQuantiles(sortedX, [0.01, 0.99]);
  const yq = computeQuantiles(sortedY, [0.01, 0.99]);
  const zq = computeQuantiles(sortedZ, [0.01, 0.99]);
  const scaleQ = computeQuantiles(sortedMaxScale, [0.95, 0.99]);

  const centerX = (xq[0.01] + xq[0.99]) * 0.5;
  const centerY = (yq[0.01] + yq[0.99]) * 0.5;
  const centerZ = (zq[0.01] + zq[0.99]) * 0.5;
  const sizeX = Math.max(xq[0.99] - xq[0.01], 0.001);
  const sizeY = Math.max(yq[0.99] - yq[0.01], 0.001);
  const sizeZ = Math.max(zq[0.99] - zq[0.01], 0.001);
  const robustDiag = Math.hypot(sizeX, sizeY, sizeZ);
  const maxDistance = Math.max(robustDiag * 0.85, 10);
  const maxAllowedScale = Math.max(
    0.12,
    Math.min(scaleQ[0.99] * 1.15, robustDiag * 0.012),
  );
  const minAlpha = 14;

  const keptRecords = [];
  let removedDistance = 0;
  let removedAlpha = 0;
  let clampedScaleCount = 0;

  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    const x = xs[index];
    const y = ys[index];
    const z = zs[index];
    const dx = x - centerX;
    const dy = y - centerY;
    const dz = z - centerZ;
    if (Math.hypot(dx, dy, dz) > maxDistance) {
      removedDistance += 1;
      continue;
    }
    if (alphas[index] < minAlpha) {
      removedAlpha += 1;
      continue;
    }

    const record = Buffer.from(buffer.subarray(offset, offset + stride));
    const sx = record.readFloatLE(12);
    const sy = record.readFloatLE(16);
    const sz = record.readFloatLE(20);
    const clampedSx = Math.min(sx, maxAllowedScale);
    const clampedSy = Math.min(sy, maxAllowedScale);
    const clampedSz = Math.min(sz, maxAllowedScale);
    if (clampedSx !== sx || clampedSy !== sy || clampedSz !== sz) {
      clampedScaleCount += 1;
      record.writeFloatLE(clampedSx, 12);
      record.writeFloatLE(clampedSy, 16);
      record.writeFloatLE(clampedSz, 20);
    }
    keptRecords.push(record);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, Buffer.concat(keptRecords));

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    inputCount: count,
    outputCount: keptRecords.length,
    removedDistance,
    removedAlpha,
    clampedScaleCount,
    robustBounds: {
      center: [centerX, centerY, centerZ],
      size: [sizeX, sizeY, sizeZ],
      diag: robustDiag,
    },
    thresholds: {
      maxDistance,
      maxAllowedScale,
      minAlpha,
      scaleP95: scaleQ[0.95],
      scaleP99: scaleQ[0.99],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
