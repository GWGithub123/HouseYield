#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BUNDLE_JSON = 'server/data/room-scans/master_1781468871002_96121536/artifacts/master_ref_gaussian/scene.refgaussian.json';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveBinPath(jsonPath, metadata) {
  const binPath = metadata?.binary?.path;
  if (!binPath) throw new Error('bundle metadata is missing binary.path');
  return path.resolve(path.dirname(jsonPath), binPath);
}

function readArray(binBuffer, descriptor, maxRows = Infinity) {
  if (!descriptor) return null;
  if (descriptor.dtype !== 'float32') {
    throw new Error(`unsupported dtype for ${descriptor.name}: ${descriptor.dtype}`);
  }
  const componentCount = descriptor.shape?.length > 1 ? descriptor.shape[1] : (descriptor.properties?.length || 1);
  const rows = Math.min(descriptor.shape?.[0] || Math.floor(descriptor.byteLength / (componentCount * 4)), maxRows);
  const byteLength = rows * componentCount * 4;
  const slice = binBuffer.subarray(descriptor.offset, descriptor.offset + byteLength);
  return {
    name: descriptor.name,
    componentCount,
    rowCount: rows,
    data: new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4),
  };
}

function getVec3(slice, index, fallback = [0, 0, 0]) {
  if (!slice) return fallback;
  const offset = index * slice.componentCount;
  return [
    slice.data[offset] ?? fallback[0],
    slice.data[offset + 1] ?? fallback[1],
    slice.data[offset + 2] ?? fallback[2],
  ];
}

function getScalar(slice, index, fallback = 0) {
  if (!slice) return fallback;
  return slice.data[index * slice.componentCount] ?? fallback;
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function qvecToRotmat(qvec) {
  const [qw, qx, qy, qz] = qvec.map(Number);
  return [
    [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
    [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
    [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy],
  ];
}

function quatRotate(q, v) {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function getQuat(slice, index) {
  if (!slice) return [1, 0, 0, 0];
  const offset = index * slice.componentCount;
  const q = [
    slice.data[offset] ?? 1,
    slice.data[offset + 1] ?? 0,
    slice.data[offset + 2] ?? 0,
    slice.data[offset + 3] ?? 0,
  ];
  const len = Math.hypot(...q) || 1;
  return q.map((value) => value / len);
}

function computeBounds(positions) {
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.rowCount; i += 1) {
    const p = getVec3(positions, i);
    for (let axis = 0; axis < 3; axis += 1) {
      lower[axis] = Math.min(lower[axis], p[axis]);
      upper[axis] = Math.max(upper[axis], p[axis]);
    }
  }
  const center = lower.map((value, axis) => (value + upper[axis]) * 0.5);
  const scale = Math.max(upper[0] - lower[0], upper[1] - lower[1], upper[2] - lower[2], 1e-5);
  return { lower, upper, center, scale };
}

function normalizePoint(point, bounds) {
  return [
    (point[0] - bounds.center[0]) / bounds.scale,
    (point[1] - bounds.center[1]) / bounds.scale,
    (point[2] - bounds.center[2]) / bounds.scale,
  ];
}

function cameraCenter(image) {
  const R = image.rotationMatrixWorldToCamera || qvecToRotmat(image.qvec);
  const t = image.tvec.map(Number);
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ];
}

function getIntrinsics(metadata, image) {
  const camera = (metadata.cameraCalibration?.cameras || []).find((entry) => Number(entry.cameraId) === Number(image.cameraId));
  if (!camera) return null;
  const params = camera.params.map(Number);
  const model = String(camera.model || '').toUpperCase();
  let fx = params[0];
  let fy = params[0];
  let cx = params[1];
  let cy = params[2];
  if (model === 'PINHOLE' || model === 'OPENCV' || model === 'FULL_OPENCV') {
    [fx, fy, cx, cy] = params;
  }
  return { width: Number(camera.width), height: Number(camera.height), fx, fy, cx, cy, model };
}

function projectCameraPoint(cameraPoint, intrinsics) {
  const z = cameraPoint[2];
  if (z <= 1e-6) return null;
  return [
    intrinsics.fx * (cameraPoint[0] / z) + intrinsics.cx,
    intrinsics.fy * (cameraPoint[1] / z) + intrinsics.cy,
    z,
  ];
}

function worldToCamera(pointWorld, image) {
  const R = image.rotationMatrixWorldToCamera || qvecToRotmat(image.qvec);
  const t = image.tvec.map(Number);
  return [
    R[0][0] * pointWorld[0] + R[0][1] * pointWorld[1] + R[0][2] * pointWorld[2] + t[0],
    R[1][0] * pointWorld[0] + R[1][1] * pointWorld[1] + R[1][2] * pointWorld[2] + t[1],
    R[2][0] * pointWorld[0] + R[2][1] * pointWorld[1] + R[2][2] * pointWorld[2] + t[2],
  ];
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

function main() {
  const bundleJson = path.resolve(process.argv[2] || DEFAULT_BUNDLE_JSON);
  const metadata = readJson(bundleJson);
  const binPath = resolveBinPath(bundleJson, metadata);
  const bin = fs.readFileSync(binPath);
  const descriptor = (name) => metadata.arrays.find((entry) => entry.name === name);
  const positions = readArray(bin, descriptor('positions'));
  const logScale = readArray(bin, descriptor('logScale'));
  const rotation = readArray(bin, descriptor('rotation'));
  const opacityLogit = readArray(bin, descriptor('opacityLogit'));
  const image = metadata.cameraCalibration?.nativeEvalSplit?.testImages?.[0] || metadata.cameraCalibration?.images?.[0];
  const intrinsics = getIntrinsics(metadata, image);
  if (!positions || !image || !intrinsics) {
    throw new Error('missing positions, native image, or camera intrinsics');
  }

  const bounds = computeBounds(positions);
  const center = cameraCenter(image);
  const normalizedEye = normalizePoint(center, bounds);
  const radii = [];
  const alphas = [];
  let visible = 0;
  let behind = 0;
  let offscreen = 0;
  let huge = 0;
  let maxRadius = 0;
  let maxRadiusIndex = -1;

  for (let i = 0; i < positions.rowCount; i += 1) {
    const worldPoint = getVec3(positions, i);
    const centerCam = worldToCamera(worldPoint, image);
    const centerPx = projectCameraPoint(centerCam, intrinsics);
    if (!centerPx) {
      behind += 1;
      continue;
    }
    if (centerPx[0] < -64 || centerPx[0] > intrinsics.width + 64 || centerPx[1] < -64 || centerPx[1] > intrinsics.height + 64) {
      offscreen += 1;
      continue;
    }
    visible += 1;

    const normalizedPoint = normalizePoint(worldPoint, bounds);
    const q = getQuat(rotation, i);
    const scale0 = Math.exp(getScalar(logScale, i, Math.log(bounds.scale * 0.01)));
    const scale1 = Math.exp(logScale ? (logScale.data[i * logScale.componentCount + 1] ?? Math.log(scale0)) : Math.log(scale0));
    const axis0Normalized = quatRotate(q, [scale0 / bounds.scale, 0, 0]);
    const axis1Normalized = quatRotate(q, [0, scale1 / bounds.scale, 0]);
    const axis0World = axis0Normalized.map((value, axis) => value * bounds.scale);
    const axis1World = axis1Normalized.map((value, axis) => value * bounds.scale);
    const p0 = projectCameraPoint(worldToCamera([
      worldPoint[0] + axis0World[0],
      worldPoint[1] + axis0World[1],
      worldPoint[2] + axis0World[2],
    ], image), intrinsics);
    const p1 = projectCameraPoint(worldToCamera([
      worldPoint[0] + axis1World[0],
      worldPoint[1] + axis1World[1],
      worldPoint[2] + axis1World[2],
    ], image), intrinsics);
    if (!p0 || !p1) continue;
    const axis0Px = [p0[0] - centerPx[0], p0[1] - centerPx[1]];
    const axis1Px = [p1[0] - centerPx[0], p1[1] - centerPx[1]];
    const cov00 = axis0Px[0] ** 2 + axis1Px[0] ** 2 + 0.25;
    const cov01 = axis0Px[0] * axis0Px[1] + axis1Px[0] * axis1Px[1];
    const cov11 = axis0Px[1] ** 2 + axis1Px[1] ** 2 + 0.25;
    const traceHalf = 0.5 * (cov00 + cov11);
    const diffHalf = 0.5 * (cov00 - cov11);
    const lambda = Math.max(traceHalf + Math.sqrt(Math.max(diffHalf * diffHalf + cov01 * cov01, 1e-8)), 1e-5);
    const radius = 3 * Math.sqrt(lambda);
    radii.push(radius);
    alphas.push(sigmoid(getScalar(opacityLogit, i, 2.2)));
    if (radius > 40) huge += 1;
    if (radius > maxRadius) {
      maxRadius = radius;
      maxRadiusIndex = i;
    }
  }

  radii.sort((a, b) => a - b);
  alphas.sort((a, b) => a - b);
  const summary = {
    bundleJson: path.relative(process.cwd(), bundleJson),
    pointCount: positions.rowCount,
    nativeFrame: image.nativeRenderFrame || image.name,
    camera: intrinsics,
    normalizedEye,
    counts: { visible, behind, offscreen, hugeRadiusGt40: huge },
    radiusPx: {
      min: radii[0] || 0,
      p50: quantile(radii, 0.5),
      p90: quantile(radii, 0.9),
      p95: quantile(radii, 0.95),
      p99: quantile(radii, 0.99),
      max: maxRadius,
      maxIndex: maxRadiusIndex,
    },
    opacity: {
      p50: quantile(alphas, 0.5),
      p90: quantile(alphas, 0.9),
      p99: quantile(alphas, 0.99),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
