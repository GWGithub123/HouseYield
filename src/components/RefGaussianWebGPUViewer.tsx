import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchRefGaussianBundleMetadata,
  fetchRefGaussianFloat32Array,
  fetchRefGaussianFloat32ArraySlice,
  hasRefGaussianArray,
  listRefGaussianRuntimeAssets,
  type RefGaussianArtifacts,
  type RefGaussianArraySlice,
  type RefGaussianBundleMetadata,
} from '../services/refGaussianBundleService';

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = [
  1.0925484305920792,
  1.0925484305920792,
  0.31539156525252005,
  1.0925484305920792,
  0.5462742152960396,
] as const;
const SH_C3 = [
  0.5900435899266435,
  2.890611442640554,
  0.4570457994644658,
  0.3731763325901154,
  0.4570457994644658,
  1.445305721320277,
  0.5900435899266435,
] as const;
const INSTANCE_STRIDE_FLOATS = 22;
const MAX_FULL_WEBGPU_GAUSSIANS = 420000;
const SORT_BUCKET_COUNT = 512;
const EXACT_SORT_LIMIT = 450000;
const GPU_BUFFER_VERTEX = 0x20;
const GPU_BUFFER_COPY_DST = 0x08;
const GPU_BUFFER_UNIFORM = 0x40;
const GPU_BUFFER_STORAGE = 0x80;
const GPU_TEXTURE_COPY_DST = 0x02;
const GPU_TEXTURE_BINDING = 0x04;
const GPU_TEXTURE_RENDER_ATTACHMENT = 0x10;
const NATIVE_ENV_MIN_ROUGHNESS = 0.08;
const NATIVE_ENV_MAX_ROUGHNESS = 0.5;
const GBUFFER_FORMAT = 'rgba16float';
const VISIBILITY_PROXY_STRIDE_FLOATS = 8;
const MAX_VISIBILITY_PROXIES = 8192;
const VISIBILITY_TRIANGLE_STRIDE_FLOATS = 12;
const VISIBILITY_BVH_NODE_STRIDE_FLOATS = 8;
const MAX_VISIBILITY_MESH_TRIANGLES = 8192;

type Vec3 = [number, number, number];
type RenderMode = 'material' | 'color' | 'reflection' | 'alpha' | 'scale';

interface RendererStats {
  renderedGaussians: number;
  totalGaussians: number;
  sortMode: string;
  pbrMode: string;
  reflectionMode: string;
  runtimeAssets: string;
  parityRisk: string;
}

type EnvTextureSource = {
  levels: Array<{
    data: Float32Array;
    width: number;
    height: number;
  }>;
  width: number;
  height: number;
  source: 'native-envlight-base' | 'fallback-neutral';
};

type BsdfLutTextureSource = {
  data: Float32Array;
  width: number;
  height: number;
  source: 'native-fg-lut' | 'fallback-fg-lut';
};

type VisibilityMeshData = {
  triangles: Float32Array;
  nodes: Float32Array;
  triangleCount: number;
  nodeCount: number;
  source: string;
};

interface CameraState {
  yaw: number;
  pitch: number;
  radius: number;
  target: Vec3;
  near: number;
  far: number;
}

type NativeCameraIntrinsics = {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
};

type NativeCameraView = {
  eye: Vec3;
  forward: Vec3;
  view: Float32Array;
  intrinsics: NativeCameraIntrinsics | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function sigmoid(value: number) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function shDcToColor(value: number) {
  return clamp01(0.5 + SH_C0 * value);
}

function normalizeVec3(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotVec3(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVec3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function quatRotateVec3(q: [number, number, number, number], value: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * value[2] - z * value[1]);
  const ty = 2 * (z * value[0] - x * value[2]);
  const tz = 2 * (x * value[1] - y * value[0]);
  return [
    value[0] + w * tx + (y * tz - z * ty),
    value[1] + w * ty + (z * tx - x * tz),
    value[2] + w * tz + (x * ty - y * tx),
  ];
}

function mat4Identity() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function mat4Perspective(fovyRadians: number, aspect: number, near: number, far: number) {
  const f = 1.0 / Math.tan(fovyRadians / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

function mat4PerspectiveFromIntrinsics(
  intrinsics: NativeCameraIntrinsics | null,
  viewportWidth: number,
  viewportHeight: number,
  near: number,
  far: number,
) {
  if (!intrinsics) {
    return mat4Perspective(Math.PI / 3, viewportWidth / viewportHeight, near, far);
  }

  const scaleX = viewportWidth / Math.max(intrinsics.width, 1);
  const scaleY = viewportHeight / Math.max(intrinsics.height, 1);
  const fx = intrinsics.fx * scaleX;
  const fy = intrinsics.fy * scaleY;
  const cx = intrinsics.cx * scaleX;
  const cy = intrinsics.cy * scaleY;
  const width = Math.max(viewportWidth, 1);
  const height = Math.max(viewportHeight, 1);

  // COLMAP camera coordinates look down +Z with image Y down. This projection
  // maps that convention into WebGPU clip space while preserving native
  // intrinsics, instead of pretending every native frame is a 60-degree camera.
  const out = new Float32Array(16);
  out[0] = (2 * fx) / width;
  out[5] = (-2 * fy) / height;
  out[8] = 1 - (2 * cx) / width;
  out[9] = (2 * cy) / height - 1;
  out[10] = far / (far - near);
  out[11] = 1;
  out[14] = (-far * near) / (far - near);
  return out;
}

function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3) {
  const z = normalizeVec3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalizeVec3(crossVec3(up, z));
  const y = crossVec3(z, x);
  const out = mat4Identity();
  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[12] = -dotVec3(x, eye);
  out[13] = -dotVec3(y, eye);
  out[14] = -dotVec3(z, eye);
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function mat4Invert(matrix: Float32Array) {
  const out = new Float32Array(16);
  const m = matrix;

  out[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  out[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  out[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  out[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  out[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  out[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  out[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  out[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  out[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  out[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  out[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  out[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  out[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  out[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  out[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  out[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

  const det = m[0] * out[0] + m[1] * out[4] + m[2] * out[8] + m[3] * out[12];
  if (Math.abs(det) < 1e-8) {
    return mat4Identity();
  }
  const invDet = 1 / det;
  for (let i = 0; i < 16; i += 1) {
    out[i] *= invDet;
  }
  return out;
}

function cameraAxes(eye: Vec3, target: Vec3) {
  const forward = normalizeVec3(subtractVec3(target, eye));
  const right = normalizeVec3(crossVec3(forward, [0, 1, 0]));
  const up = normalizeVec3(crossVec3(right, forward));
  return { forward, right, up };
}

function colmapQvecToRotation(qvec: unknown): number[][] | null {
  if (!Array.isArray(qvec) || qvec.length < 4) {
    return null;
  }
  const [qw, qx, qy, qz] = qvec.map((value) => Number(value));
  if (![qw, qx, qy, qz].every(Number.isFinite)) {
    return null;
  }
  return [
    [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
    [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
    [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy],
  ];
}

function colmapCameraCenter(image: any): Vec3 | null {
  const rotation = colmapQvecToRotation(image?.qvec);
  const tvec = Array.isArray(image?.tvec) ? image.tvec.map((value: unknown) => Number(value)) : null;
  if (!rotation || !tvec || tvec.length < 3 || !tvec.every(Number.isFinite)) {
    return null;
  }
  return [
    -(rotation[0][0] * tvec[0] + rotation[1][0] * tvec[1] + rotation[2][0] * tvec[2]),
    -(rotation[0][1] * tvec[0] + rotation[1][1] * tvec[1] + rotation[2][1] * tvec[2]),
    -(rotation[0][2] * tvec[0] + rotation[1][2] * tvec[1] + rotation[2][2] * tvec[2]),
  ];
}

function findColmapCamera(metadata: RefGaussianBundleMetadata, image: any) {
  const cameras = metadata.cameraCalibration?.cameras || [];
  return (cameras as any[]).find((camera) => Number(camera?.cameraId) === Number(image?.cameraId)) || null;
}

function colmapIntrinsics(camera: any): NativeCameraIntrinsics | null {
  if (!camera || !Array.isArray(camera.params)) {
    return null;
  }
  const width = Number(camera.width);
  const height = Number(camera.height);
  const params = camera.params.map((value: unknown) => Number(value));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const model = String(camera.model || '').toUpperCase();
  let fx = params[0];
  let fy = params[0];
  let cx = params[1];
  let cy = params[2];
  if (model === 'PINHOLE' || model === 'OPENCV' || model === 'FULL_OPENCV') {
    [fx, fy, cx, cy] = params;
  }
  if (![fx, fy, cx, cy].every(Number.isFinite)) {
    return null;
  }
  return { width, height, fx, fy, cx, cy };
}

function nativeViewMatrixForNormalizedScene(image: any, bounds: { center: Vec3; scale: number }) {
  const rotation = Array.isArray(image?.rotationMatrixWorldToCamera)
    ? image.rotationMatrixWorldToCamera
    : colmapQvecToRotation(image?.qvec);
  const tvec = Array.isArray(image?.tvec) ? image.tvec.map((value: unknown) => Number(value)) : null;
  if (!rotation || !tvec || tvec.length < 3 || !tvec.every(Number.isFinite)) {
    return null;
  }
  const out = mat4Identity();
  for (let row = 0; row < 3; row += 1) {
    const r0 = Number(rotation[row]?.[0]);
    const r1 = Number(rotation[row]?.[1]);
    const r2 = Number(rotation[row]?.[2]);
    if (![r0, r1, r2].every(Number.isFinite)) {
      return null;
    }
    out[row] = r0 * bounds.scale;
    out[4 + row] = r1 * bounds.scale;
    out[8 + row] = r2 * bounds.scale;
    out[12 + row] = r0 * bounds.center[0] + r1 * bounds.center[1] + r2 * bounds.center[2] + tvec[row];
  }
  return out;
}

function nativeCameraViewForImage(metadata: RefGaussianBundleMetadata, image: any, bounds: { center: Vec3; scale: number }): NativeCameraView | null {
  const eyeWorld = colmapCameraCenter(image);
  const view = nativeViewMatrixForNormalizedScene(image, bounds);
  const rotation = Array.isArray(image?.rotationMatrixWorldToCamera)
    ? image.rotationMatrixWorldToCamera
    : colmapQvecToRotation(image?.qvec);
  if (!eyeWorld || !view || !rotation) {
    return null;
  }
  return {
    eye: [
      (eyeWorld[0] - bounds.center[0]) / bounds.scale,
      (eyeWorld[1] - bounds.center[1]) / bounds.scale,
      (eyeWorld[2] - bounds.center[2]) / bounds.scale,
    ],
    forward: normalizeVec3([Number(rotation[2][0]), Number(rotation[2][1]), Number(rotation[2][2])]),
    view,
    intrinsics: colmapIntrinsics(findColmapCamera(metadata, image)),
  };
}

function metadataArrayNames(metadata: RefGaussianBundleMetadata | null) {
  return metadata?.arrays?.filter((array) => array.kind === 'array').map((array) => array.name) || [];
}

function hasBundleArray(metadata: RefGaussianBundleMetadata, name: string) {
  return metadata.arrays?.some((array) => array.kind === 'array' && array.name === name);
}

function arrayMemoryMb(slice: RefGaussianArraySlice | null | undefined) {
  return slice ? slice.data.byteLength / (1024 * 1024) : 0;
}

function getScalar(slice: RefGaussianArraySlice | null | undefined, index: number, fallback: number) {
  if (!slice) return fallback;
  return slice.data[index * slice.componentCount] ?? fallback;
}

function getVec3(slice: RefGaussianArraySlice | null | undefined, index: number, fallback: Vec3): Vec3 {
  if (!slice) return fallback;
  const offset = index * slice.componentCount;
  return [
    slice.data[offset] ?? fallback[0],
    slice.data[offset + 1] ?? fallback[1],
    slice.data[offset + 2] ?? fallback[2],
  ];
}

function getQuat(slice: RefGaussianArraySlice | null | undefined, index: number): [number, number, number, number] {
  if (!slice) return [1, 0, 0, 0];
  const offset = index * slice.componentCount;
  const w = slice.data[offset] ?? 1;
  const x = slice.data[offset + 1] ?? 0;
  const y = slice.data[offset + 2] ?? 0;
  const z = slice.data[offset + 3] ?? 0;
  const length = Math.hypot(w, x, y, z) || 1;
  return [w / length, x / length, y / length, z / length];
}

function evaluateShColor(
  shDc: RefGaussianArraySlice | null | undefined,
  shRest: RefGaussianArraySlice | null | undefined,
  index: number,
  viewDirection: Vec3,
  fallback: Vec3,
): Vec3 {
  if (!shDc) {
    return fallback;
  }
  const dc = getVec3(shDc, index, fallback);
  if (!shRest || shRest.componentCount < 45) {
    return dc.map(shDcToColor) as Vec3;
  }

  const [x, y, z] = normalizeVec3(viewDirection);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const yz = y * z;
  const xz = x * z;
  const basis = [
    -SH_C1 * y,
    SH_C1 * z,
    -SH_C1 * x,
    SH_C2[0] * xy,
    SH_C2[1] * yz,
    SH_C2[2] * (2.0 * zz - xx - yy),
    SH_C2[3] * xz,
    SH_C2[4] * (xx - yy),
    SH_C3[0] * y * (3.0 * xx - yy),
    SH_C3[1] * xy * z,
    SH_C3[2] * y * (4.0 * zz - xx - yy),
    SH_C3[3] * z * (2.0 * zz - 3.0 * xx - 3.0 * yy),
    SH_C3[4] * x * (4.0 * zz - xx - yy),
    SH_C3[5] * z * (xx - yy),
    SH_C3[6] * x * (xx - 3.0 * yy),
  ];
  const restOffset = index * shRest.componentCount;
  const coeffCount = Math.floor(shRest.componentCount / 3);
  const color: Vec3 = [
    0.5 + SH_C0 * dc[0],
    0.5 + SH_C0 * dc[1],
    0.5 + SH_C0 * dc[2],
  ];
  for (let coeffIndex = 0; coeffIndex < Math.min(basis.length, coeffCount); coeffIndex += 1) {
    // Ref-Gaussian inherits the 3DGS PLY layout: f_rest is channel-major
    // [R coeffs..., G coeffs..., B coeffs...], not RGB-interleaved.
    color[0] += basis[coeffIndex] * (shRest.data[restOffset + coeffIndex] ?? 0);
    color[1] += basis[coeffIndex] * (shRest.data[restOffset + coeffCount + coeffIndex] ?? 0);
    color[2] += basis[coeffIndex] * (shRest.data[restOffset + coeffCount * 2 + coeffIndex] ?? 0);
  }
  return [
    clamp01(color[0]),
    clamp01(color[1]),
    clamp01(color[2]),
  ];
}

function createNeutralEnvTextureSource(): EnvTextureSource {
  const data = new Float32Array(6 * 4);
  for (let face = 0; face < 6; face += 1) {
    const offset = face * 4;
    data[offset] = 0.08;
    data[offset + 1] = 0.08;
    data[offset + 2] = 0.08;
    data[offset + 3] = 1;
  }
  return {
    levels: [{ data, width: 1, height: 1 }],
    width: 1,
    height: 1,
    source: 'fallback-neutral',
  };
}

function buildEnvMipLevels(baseLevel: Float32Array, width: number, height: number) {
  const levels = [{ data: baseLevel, width, height }];
  let current = baseLevel;
  let currentWidth = width;
  let currentHeight = height;
  while (currentWidth > 1 || currentHeight > 1) {
    const nextWidth = Math.max(1, Math.floor(currentWidth / 2));
    const nextHeight = Math.max(1, Math.floor(currentHeight / 2));
    const next = new Float32Array(6 * nextWidth * nextHeight * 4);
    for (let face = 0; face < 6; face += 1) {
      for (let y = 0; y < nextHeight; y += 1) {
        for (let x = 0; x < nextWidth; x += 1) {
          const accum = [0, 0, 0, 0];
          let samples = 0;
          for (let oy = 0; oy < 2; oy += 1) {
            for (let ox = 0; ox < 2; ox += 1) {
              const srcX = Math.min(currentWidth - 1, x * 2 + ox);
              const srcY = Math.min(currentHeight - 1, y * 2 + oy);
              const srcOffset = ((face * currentHeight + srcY) * currentWidth + srcX) * 4;
              accum[0] += current[srcOffset];
              accum[1] += current[srcOffset + 1];
              accum[2] += current[srcOffset + 2];
              accum[3] += current[srcOffset + 3];
              samples += 1;
            }
          }
          const dstOffset = ((face * nextHeight + y) * nextWidth + x) * 4;
          next[dstOffset] = accum[0] / samples;
          next[dstOffset + 1] = accum[1] / samples;
          next[dstOffset + 2] = accum[2] / samples;
          next[dstOffset + 3] = accum[3] / samples;
        }
      }
    }
    levels.push({ data: next, width: nextWidth, height: nextHeight });
    current = next;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }
  return levels;
}

function createEnvTextureSource(baseTensor: Float32Array | null | undefined, shape: number[] | undefined): EnvTextureSource {
  if (!baseTensor || !shape || shape.length < 4 || shape[0] !== 6 || shape[3] < 3) {
    return createNeutralEnvTextureSource();
  }
  const [, height, width, components] = shape;
  const baseLevel = new Float32Array(6 * height * width * 4);
  for (let face = 0; face < 6; face += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceOffset = ((face * height + y) * width + x) * components;
        const targetOffset = ((face * height + y) * width + x) * 4;
        baseLevel[targetOffset] = sigmoid(baseTensor[sourceOffset]);
        baseLevel[targetOffset + 1] = sigmoid(baseTensor[sourceOffset + 1]);
        baseLevel[targetOffset + 2] = sigmoid(baseTensor[sourceOffset + 2]);
        baseLevel[targetOffset + 3] = 1;
      }
    }
  }
  return {
    levels: buildEnvMipLevels(baseLevel, width, height),
    width,
    height,
    source: 'native-envlight-base',
  };
}

function createFallbackBsdfLutTextureSource(): BsdfLutTextureSource {
  const width = 256;
  const height = 256;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ndotv = x / (width - 1);
      const roughness = y / (height - 1);
      const offset = (y * width + x) * 4;
      data[offset] = clamp(0.04 + ndotv * (1 - roughness * 0.75), 0, 1);
      data[offset + 1] = clamp((1 - ndotv) * (1 - roughness * 0.35), 0, 1);
      data[offset + 2] = 0;
      data[offset + 3] = 1;
    }
  }
  return { data, width, height, source: 'fallback-fg-lut' };
}

function createBsdfLutTextureSource(binary: ArrayBuffer | null | undefined): BsdfLutTextureSource {
  if (!binary) {
    return createFallbackBsdfLutTextureSource();
  }
  const source = new Float32Array(binary);
  const width = 256;
  const height = 256;
  if (source.length !== width * height * 2) {
    return createFallbackBsdfLutTextureSource();
  }
  const data = new Float32Array(width * height * 4);
  for (let idx = 0; idx < width * height; idx += 1) {
    const srcOffset = idx * 2;
    const dstOffset = idx * 4;
    data[dstOffset] = source[srcOffset];
    data[dstOffset + 1] = source[srcOffset + 1];
    data[dstOffset + 2] = 0;
    data[dstOffset + 3] = 1;
  }
  return { data, width, height, source: 'native-fg-lut' };
}

function computeBounds(positions: RefGaussianArraySlice) {
  const axisValues = [
    new Float32Array(positions.rowCount),
    new Float32Array(positions.rowCount),
    new Float32Array(positions.rowCount),
  ];

  for (let idx = 0; idx < positions.rowCount; idx += 1) {
    const offset = idx * positions.componentCount;
    axisValues[0][idx] = positions.data[offset];
    axisValues[1][idx] = positions.data[offset + 1];
    axisValues[2][idx] = positions.data[offset + 2];
  }

  const lower: Vec3 = [0, 0, 0];
  const upper: Vec3 = [0, 0, 0];
  const rawLower: Vec3 = [0, 0, 0];
  const rawUpper: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const sorted = Array.from(axisValues[axis]).sort((a, b) => a - b);
    rawLower[axis] = sorted[0];
    rawUpper[axis] = sorted[sorted.length - 1];
    lower[axis] = sorted[Math.floor(sorted.length * 0.01)];
    upper[axis] = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99))];
  }

  const center: Vec3 = [
    (lower[0] + upper[0]) * 0.5,
    (lower[1] + upper[1]) * 0.5,
    (lower[2] + upper[2]) * 0.5,
  ];
  const size: Vec3 = [upper[0] - lower[0], upper[1] - lower[1], upper[2] - lower[2]];
  const scale = Math.max(size[0], size[1], size[2], 1e-6);
  return { center, lower, upper, rawLower, rawUpper, size, scale };
}

function normalizePositions(positions: RefGaussianArraySlice, center: Vec3, sceneScale: number) {
  const normalized = new Float32Array(positions.rowCount * 3);
  for (let idx = 0; idx < positions.rowCount; idx += 1) {
    const src = idx * positions.componentCount;
    const dst = idx * 3;
    normalized[dst] = (positions.data[src] - center[0]) / sceneScale;
    normalized[dst + 1] = (positions.data[src + 1] - center[1]) / sceneScale;
    normalized[dst + 2] = (positions.data[src + 2] - center[2]) / sceneScale;
  }
  return normalized;
}

function bucketSortBackToFront(positions: Float32Array, eye: Vec3, forward: Vec3, count: number) {
  const depths = new Float32Array(count);
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = Number.NEGATIVE_INFINITY;

  for (let idx = 0; idx < count; idx += 1) {
    const offset = idx * 3;
    const depth =
      (positions[offset] - eye[0]) * forward[0] +
      (positions[offset + 1] - eye[1]) * forward[1] +
      (positions[offset + 2] - eye[2]) * forward[2];
    depths[idx] = depth;
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }

  const depthRange = Math.max(maxDepth - minDepth, 1e-6);
  const counts = new Int32Array(SORT_BUCKET_COUNT);
  for (let idx = 0; idx < count; idx += 1) {
    const bucket = clamp(Math.floor(((depths[idx] - minDepth) / depthRange) * (SORT_BUCKET_COUNT - 1)), 0, SORT_BUCKET_COUNT - 1);
    counts[bucket] += 1;
  }

  const offsets = new Int32Array(SORT_BUCKET_COUNT);
  let cursor = 0;
  for (let bucket = SORT_BUCKET_COUNT - 1; bucket >= 0; bucket -= 1) {
    offsets[bucket] = cursor;
    cursor += counts[bucket];
  }

  const writeOffsets = new Int32Array(offsets);
  const sorted = new Int32Array(count);
  for (let idx = 0; idx < count; idx += 1) {
    const bucket = clamp(Math.floor(((depths[idx] - minDepth) / depthRange) * (SORT_BUCKET_COUNT - 1)), 0, SORT_BUCKET_COUNT - 1);
    sorted[writeOffsets[bucket]] = idx;
    writeOffsets[bucket] += 1;
  }
  return sorted;
}

function exactSortBackToFront(positions: Float32Array, eye: Vec3, forward: Vec3, count: number) {
  const keyed = new Array<{ index: number; depth: number }>(count);
  for (let idx = 0; idx < count; idx += 1) {
    const offset = idx * 3;
    keyed[idx] = {
      index: idx,
      depth:
        (positions[offset] - eye[0]) * forward[0] +
        (positions[offset + 1] - eye[1]) * forward[1] +
        (positions[offset + 2] - eye[2]) * forward[2],
    };
  }
  keyed.sort((a, b) => b.depth - a.depth);
  const sorted = new Int32Array(count);
  for (let idx = 0; idx < count; idx += 1) {
    sorted[idx] = keyed[idx].index;
  }
  return sorted;
}

function sortBackToFront(positions: Float32Array, eye: Vec3, forward: Vec3, count: number) {
  return count <= EXACT_SORT_LIMIT
    ? exactSortBackToFront(positions, eye, forward, count)
    : bucketSortBackToFront(positions, eye, forward, count);
}

function findViewCenterTarget(positions: Float32Array, eye: Vec3, target: Vec3, count: number): Vec3 {
  const { forward, right, up } = cameraAxes(eye, target);
  let bestScore = Number.POSITIVE_INFINITY;
  let bestTarget: Vec3 | null = null;

  for (let idx = 0; idx < count; idx += 24) {
    const offset = idx * 3;
    const point: Vec3 = [positions[offset], positions[offset + 1], positions[offset + 2]];
    const toPoint = subtractVec3(point, eye);
    const depth = dotVec3(toPoint, forward);
    if (depth <= 0.01) {
      continue;
    }
    const screenX = dotVec3(toPoint, right) / depth;
    const screenY = dotVec3(toPoint, up) / depth;
    const score = screenX * screenX + screenY * screenY + depth * 0.0003;
    if (score < bestScore) {
      bestScore = score;
      bestTarget = point;
    }
  }

  return bestTarget || target;
}

function quantile(values: number[], percentile: number) {
  if (!values.length) {
    return 0;
  }
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * percentile)))];
}

function computeAdaptiveRenderSettings({
  logScale,
  opacityLogit,
  sceneScale,
  count,
}: {
  logScale: RefGaussianArraySlice | null;
  opacityLogit: RefGaussianArraySlice | null;
  sceneScale: number;
  count: number;
}) {
  const radii: number[] = [];
  const alphas: number[] = [];
  const sampleStride = Math.max(1, Math.floor(count / 12000));
  for (let index = 0; index < count; index += sampleStride) {
    const scaleOffset = index * (logScale?.componentCount || 1);
    const scale0 = logScale ? logScale.data[scaleOffset] : Math.log(sceneScale * 0.01);
    const scale1 = logScale ? logScale.data[scaleOffset + 1] ?? scale0 : scale0;
    radii.push(Math.exp(scale0) / sceneScale, Math.exp(scale1) / sceneScale);
    alphas.push(sigmoid(getScalar(opacityLogit, index, 2.2)));
  }

  const p90Radius = Math.max(quantile(radii, 0.9), 1e-5);
  const medianAlpha = Math.max(quantile(alphas, 0.5), 1e-5);
  return {
    exposure: 0.95,
    opacity: clamp(0.42 / medianAlpha, 0.28, 0.58),
    splatScale: clamp(0.015 / p90Radius, 0.32, 0.68),
    reflection: 0.0,
  };
}

function projectNativePixel(point: Vec3, image: any, intrinsics: NativeCameraIntrinsics) {
  const rotation = Array.isArray(image?.rotationMatrixWorldToCamera)
    ? image.rotationMatrixWorldToCamera
    : colmapQvecToRotation(image?.qvec);
  const tvec = Array.isArray(image?.tvec) ? image.tvec.map((value: unknown) => Number(value)) : null;
  if (!rotation || !tvec || tvec.length < 3) {
    return null;
  }
  const x = Number(rotation[0][0]) * point[0] + Number(rotation[0][1]) * point[1] + Number(rotation[0][2]) * point[2] + tvec[0];
  const y = Number(rotation[1][0]) * point[0] + Number(rotation[1][1]) * point[1] + Number(rotation[1][2]) * point[2] + tvec[1];
  const z = Number(rotation[2][0]) * point[0] + Number(rotation[2][1]) * point[1] + Number(rotation[2][2]) * point[2] + tvec[2];
  if (z <= 1e-6) {
    return null;
  }
  return [
    intrinsics.fx * (x / z) + intrinsics.cx,
    intrinsics.fy * (y / z) + intrinsics.cy,
    z,
  ] as Vec3;
}

function computeNativeCameraScaleSettings({
  metadata,
  image,
  positions,
  logScale,
  rotation,
  bounds,
}: {
  metadata: RefGaussianBundleMetadata;
  image: any;
  positions: RefGaussianArraySlice;
  logScale: RefGaussianArraySlice | null;
  rotation: RefGaussianArraySlice | null;
  bounds: { center: Vec3; scale: number };
}) {
  const intrinsics = colmapIntrinsics(findColmapCamera(metadata, image));
  if (!intrinsics) {
    return null;
  }

  const radii: number[] = [];
  const sampleStride = Math.max(1, Math.floor(positions.rowCount / 20000));
  for (let index = 0; index < positions.rowCount; index += sampleStride) {
    const center = getVec3(positions, index, [0, 0, 0]);
    const centerPx = projectNativePixel(center, image, intrinsics);
    if (!centerPx) {
      continue;
    }
    if (
      centerPx[0] < -64 || centerPx[0] > intrinsics.width + 64
      || centerPx[1] < -64 || centerPx[1] > intrinsics.height + 64
    ) {
      continue;
    }

    const scaleOffset = index * (logScale?.componentCount || 1);
    const scale0 = logScale ? Math.exp(logScale.data[scaleOffset] ?? Math.log(bounds.scale * 0.01)) : bounds.scale * 0.01;
    const scale1 = logScale ? Math.exp(logScale.data[scaleOffset + 1] ?? Math.log(scale0)) : scale0;
    const q = getQuat(rotation, index);
    const axis0 = quatRotateVec3(q, [scale0, 0, 0]);
    const axis1 = quatRotateVec3(q, [0, scale1, 0]);
    const p0 = projectNativePixel(addVec3(center, axis0), image, intrinsics);
    const p1 = projectNativePixel(addVec3(center, axis1), image, intrinsics);
    if (!p0 || !p1) {
      continue;
    }
    const axis0Px: Vec3 = [p0[0] - centerPx[0], p0[1] - centerPx[1], 0];
    const axis1Px: Vec3 = [p1[0] - centerPx[0], p1[1] - centerPx[1], 0];
    const cov00 = axis0Px[0] * axis0Px[0] + axis1Px[0] * axis1Px[0] + 0.25;
    const cov01 = axis0Px[0] * axis0Px[1] + axis1Px[0] * axis1Px[1];
    const cov11 = axis0Px[1] * axis0Px[1] + axis1Px[1] * axis1Px[1] + 0.25;
    const traceHalf = 0.5 * (cov00 + cov11);
    const diffHalf = 0.5 * (cov00 - cov11);
    const lambda = Math.max(traceHalf + Math.sqrt(Math.max(diffHalf * diffHalf + cov01 * cov01, 1e-8)), 1e-5);
    radii.push(3 * Math.sqrt(lambda));
  }

  if (!radii.length) {
    return null;
  }
  const p95Radius = Math.max(quantile(radii, 0.95), 1e-5);
  return {
    splatScale: clamp(24 / p95Radius, 0.08, 0.18),
    nativeRadiusP95: p95Radius,
  };
}

function colorFromLogitFields(value: Vec3): Vec3 {
  return [sigmoid(value[0]), sigmoid(value[1]), sigmoid(value[2])];
}

function evaluateStableSurfaceColor(
  shDc: RefGaussianArraySlice | null | undefined,
  shRest: RefGaussianArraySlice | null | undefined,
  originalColor: RefGaussianArraySlice | null | undefined,
  index: number,
  viewDirection: Vec3,
): Vec3 {
  if (shDc) {
    return evaluateShColor(shDc, shRest, index, viewDirection, colorFromLogitFields(getVec3(originalColor, index, [0.8, 0.82, 0.86])));
  }
  return colorFromLogitFields(getVec3(originalColor, index, [0.8, 0.82, 0.86]));
}

function albedoFromSmallLinearFields(value: Vec3): Vec3 {
  return [
    clamp01(0.5 + value[0] * 2.5),
    clamp01(0.5 + value[1] * 2.5),
    clamp01(0.5 + value[2] * 2.5),
  ];
}

function buildInstanceData({
  sortedIndices,
  normalizedPositions,
  sceneScale,
  arrays,
  eye,
}: {
  sortedIndices: Int32Array;
  normalizedPositions: Float32Array;
  sceneScale: number;
  arrays: {
    shDc: RefGaussianArraySlice | null;
    shRest: RefGaussianArraySlice | null;
    originalColor: RefGaussianArraySlice | null;
    diffuseColor: RefGaussianArraySlice | null;
    opacityLogit: RefGaussianArraySlice | null;
    logScale: RefGaussianArraySlice | null;
    rotation: RefGaussianArraySlice | null;
    normals: RefGaussianArraySlice | null;
    secondaryNormals: RefGaussianArraySlice | null;
    indirectDc: RefGaussianArraySlice | null;
    indirectRest: RefGaussianArraySlice | null;
    reflectionStrength: RefGaussianArraySlice | null;
    roughness: RefGaussianArraySlice | null;
    metalness: RefGaussianArraySlice | null;
  };
  eye: Vec3;
}) {
  const instanceData = new Float32Array(sortedIndices.length * INSTANCE_STRIDE_FLOATS);

  for (let outIndex = 0; outIndex < sortedIndices.length; outIndex += 1) {
    const srcIndex = sortedIndices[outIndex];
    const positionOffset = srcIndex * 3;
    const dst = outIndex * INSTANCE_STRIDE_FLOATS;
    instanceData[dst] = normalizedPositions[positionOffset];
    instanceData[dst + 1] = normalizedPositions[positionOffset + 1];
    instanceData[dst + 2] = normalizedPositions[positionOffset + 2];

    const point: Vec3 = [
      normalizedPositions[positionOffset],
      normalizedPositions[positionOffset + 1],
      normalizedPositions[positionOffset + 2],
    ];
    const color = evaluateStableSurfaceColor(arrays.shDc, arrays.shRest, arrays.originalColor, srcIndex, subtractVec3(point, eye));
    instanceData[dst + 3] = color[0];
    instanceData[dst + 4] = color[1];
    instanceData[dst + 5] = color[2];

    instanceData[dst + 6] = clamp(sigmoid(getScalar(arrays.opacityLogit, srcIndex, 2.2)), 0.015, 0.995);

    const scaleOffset = srcIndex * (arrays.logScale?.componentCount || 1);
    const scale0 = arrays.logScale ? arrays.logScale.data[scaleOffset] : Math.log(sceneScale * 0.01);
    const scale1 = arrays.logScale ? arrays.logScale.data[scaleOffset + 1] ?? scale0 : scale0;
    instanceData[dst + 7] = clamp(Math.exp(scale0) / sceneScale, 0.0007, 0.12);
    instanceData[dst + 8] = clamp(Math.exp(scale1) / sceneScale, 0.0007, 0.12);

    const quaternion = getQuat(arrays.rotation, srcIndex);
    instanceData[dst + 9] = quaternion[0];
    instanceData[dst + 10] = quaternion[1];
    instanceData[dst + 11] = quaternion[2];
    instanceData[dst + 12] = quaternion[3];

    const primaryNormal = getVec3(arrays.normals, srcIndex, [0, 0, 0]);
    const secondaryNormal = getVec3(arrays.secondaryNormals, srcIndex, [0, 0, 0]);
    const chosenNormal = Math.hypot(primaryNormal[0], primaryNormal[1], primaryNormal[2]) > 0.001
      ? primaryNormal
      : secondaryNormal;
    const normal = normalizeVec3(chosenNormal);
    instanceData[dst + 13] = normal[0];
    instanceData[dst + 14] = normal[1];
    instanceData[dst + 15] = normal[2];

    instanceData[dst + 16] = clamp01(sigmoid(getScalar(arrays.reflectionStrength, srcIndex, -4)));
    instanceData[dst + 17] = clamp(sigmoid(getScalar(arrays.roughness, srcIndex, 0)), 0.04, 1);
    instanceData[dst + 18] = clamp01(getScalar(arrays.metalness, srcIndex, 0));

    const indirect = evaluateShColor(arrays.indirectDc, arrays.indirectRest, srcIndex, normal, [0, 0, 0]);
    instanceData[dst + 19] = clamp01(indirect[0] * 0.45);
    instanceData[dst + 20] = clamp01(indirect[1] * 0.45);
    instanceData[dst + 21] = clamp01(indirect[2] * 0.45);
  }

  return instanceData;
}

function buildVisibilityProxyData({
  normalizedPositions,
  sceneScale,
  arrays,
  count,
}: {
  normalizedPositions: Float32Array;
  sceneScale: number;
  arrays: {
    shDc: RefGaussianArraySlice | null;
    shRest: RefGaussianArraySlice | null;
    originalColor: RefGaussianArraySlice | null;
    diffuseColor: RefGaussianArraySlice | null;
    opacityLogit: RefGaussianArraySlice | null;
    logScale: RefGaussianArraySlice | null;
    reflectionStrength: RefGaussianArraySlice | null;
  };
  count: number;
}) {
  const proxyCount = Math.max(1, Math.min(MAX_VISIBILITY_PROXIES, count));
  const stride = Math.max(1, Math.floor(count / proxyCount));
  const data = new Float32Array(proxyCount * VISIBILITY_PROXY_STRIDE_FLOATS);

  for (let proxyIndex = 0; proxyIndex < proxyCount; proxyIndex += 1) {
    const srcIndex = Math.min(proxyIndex * stride, count - 1);
    const positionOffset = srcIndex * 3;
    const dst = proxyIndex * VISIBILITY_PROXY_STRIDE_FLOATS;
    data[dst] = normalizedPositions[positionOffset];
    data[dst + 1] = normalizedPositions[positionOffset + 1];
    data[dst + 2] = normalizedPositions[positionOffset + 2];

    const scaleOffset = srcIndex * (arrays.logScale?.componentCount || 1);
    const scale0 = arrays.logScale ? arrays.logScale.data[scaleOffset] : Math.log(sceneScale * 0.01);
    const scale1 = arrays.logScale ? arrays.logScale.data[scaleOffset + 1] ?? scale0 : scale0;
    const scale2 = arrays.logScale ? arrays.logScale.data[scaleOffset + 2] ?? Math.max(scale0, scale1) : Math.max(scale0, scale1);
    data[dst + 3] = clamp(Math.max(Math.exp(scale0), Math.exp(scale1), Math.exp(scale2)) / sceneScale, 0.0015, 0.08);

    const color = evaluateStableSurfaceColor(arrays.shDc, null, arrays.originalColor, srcIndex, [0, 0, 1]);
    data[dst + 4] = color[0];
    data[dst + 5] = color[1];
    data[dst + 6] = color[2];

    const opacity = clamp(sigmoid(getScalar(arrays.opacityLogit, srcIndex, 2.2)), 0.015, 0.995);
    const reflectionStrength = clamp01(sigmoid(getScalar(arrays.reflectionStrength, srcIndex, -4)));
    data[dst + 7] = clamp(opacity * (0.75 + reflectionStrength * 0.5), 0.02, 1.0);
  }

  return { data, count: proxyCount };
}

type PlyProperty = {
  name: string;
  type: string;
  list?: boolean;
  countType?: string;
  itemType?: string;
};

type PlyElement = {
  name: string;
  count: number;
  properties: PlyProperty[];
};

function plyScalarSize(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === 'char' || normalized === 'int8' || normalized === 'uchar' || normalized === 'uint8') return 1;
  if (normalized === 'short' || normalized === 'int16' || normalized === 'ushort' || normalized === 'uint16') return 2;
  if (normalized === 'int' || normalized === 'int32' || normalized === 'uint' || normalized === 'uint32' || normalized === 'float' || normalized === 'float32') return 4;
  if (normalized === 'double' || normalized === 'float64') return 8;
  return 4;
}

function readPlyScalar(view: DataView, offset: number, type: string) {
  const normalized = type.toLowerCase();
  if (normalized === 'char' || normalized === 'int8') return view.getInt8(offset);
  if (normalized === 'uchar' || normalized === 'uint8') return view.getUint8(offset);
  if (normalized === 'short' || normalized === 'int16') return view.getInt16(offset, true);
  if (normalized === 'ushort' || normalized === 'uint16') return view.getUint16(offset, true);
  if (normalized === 'int' || normalized === 'int32') return view.getInt32(offset, true);
  if (normalized === 'uint' || normalized === 'uint32') return view.getUint32(offset, true);
  if (normalized === 'double' || normalized === 'float64') return view.getFloat64(offset, true);
  return view.getFloat32(offset, true);
}

function parsePlyHeader(bytes: Uint8Array) {
  const decoder = new TextDecoder('utf-8');
  const maxHeaderLength = Math.min(bytes.length, 256 * 1024);
  let headerEnd = -1;
  for (let index = 0; index < maxHeaderLength - 10; index += 1) {
    if (
      bytes[index] === 101
      && bytes[index + 1] === 110
      && bytes[index + 2] === 100
      && bytes[index + 3] === 95
      && bytes[index + 4] === 104
      && bytes[index + 5] === 101
      && bytes[index + 6] === 97
      && bytes[index + 7] === 100
      && bytes[index + 8] === 101
      && bytes[index + 9] === 114
    ) {
      headerEnd = index + 10;
      while (headerEnd < bytes.length && (bytes[headerEnd] === 10 || bytes[headerEnd] === 13)) {
        headerEnd += 1;
      }
      break;
    }
  }
  if (headerEnd < 0) {
    throw new Error('PLY header is missing end_header');
  }

  const headerText = decoder.decode(bytes.slice(0, headerEnd));
  const lines = headerText.split(/\r?\n/);
  let format = 'ascii';
  const elements: PlyElement[] = [];
  let currentElement: PlyElement | null = null;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1] || 'ascii';
    } else if (parts[0] === 'element') {
      currentElement = { name: parts[1], count: Number(parts[2] || 0), properties: [] };
      elements.push(currentElement);
    } else if (parts[0] === 'property' && currentElement) {
      if (parts[1] === 'list') {
        currentElement.properties.push({
          name: parts[4],
          type: parts[3],
          list: true,
          countType: parts[2],
          itemType: parts[3],
        });
      } else {
        currentElement.properties.push({ name: parts[2], type: parts[1] });
      }
    }
  }

  return { format, elements, headerEnd };
}

function triangulateFaces(vertices: Vec3[], faces: number[][]) {
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  for (const face of faces) {
    if (face.length < 3) continue;
    for (let index = 1; index < face.length - 1; index += 1) {
      const a = vertices[face[0]];
      const b = vertices[face[index]];
      const c = vertices[face[index + 1]];
      if (a && b && c) triangles.push([a, b, c]);
    }
  }
  return triangles;
}

function parseAsciiPly(text: string, elements: PlyElement[]) {
  const bodyLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  let lineIndex = 0;
  for (const element of elements) {
    if (element.name === 'vertex') {
      const xIndex = element.properties.findIndex((property) => property.name === 'x');
      const yIndex = element.properties.findIndex((property) => property.name === 'y');
      const zIndex = element.properties.findIndex((property) => property.name === 'z');
      for (let row = 0; row < element.count; row += 1) {
        const values = bodyLines[lineIndex++].trim().split(/\s+/).map(Number);
        vertices.push([values[xIndex], values[yIndex], values[zIndex]]);
      }
    } else if (element.name === 'face') {
      for (let row = 0; row < element.count; row += 1) {
        const values = bodyLines[lineIndex++].trim().split(/\s+/).map(Number);
        faces.push(values.slice(1, 1 + values[0]));
      }
    } else {
      lineIndex += element.count;
    }
  }
  return triangulateFaces(vertices, faces);
}

function parseBinaryLittleEndianPly(buffer: ArrayBuffer, elements: PlyElement[], headerEnd: number) {
  const view = new DataView(buffer);
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  let offset = headerEnd;
  for (const element of elements) {
    if (element.name === 'vertex') {
      for (let row = 0; row < element.count; row += 1) {
        let x = 0;
        let y = 0;
        let z = 0;
        for (const property of element.properties) {
          const value = readPlyScalar(view, offset, property.type);
          if (property.name === 'x') x = value;
          if (property.name === 'y') y = value;
          if (property.name === 'z') z = value;
          offset += plyScalarSize(property.type);
        }
        vertices.push([x, y, z]);
      }
    } else if (element.name === 'face') {
      for (let row = 0; row < element.count; row += 1) {
        const face: number[] = [];
        for (const property of element.properties) {
          if (property.list) {
            const count = readPlyScalar(view, offset, property.countType || 'uchar');
            offset += plyScalarSize(property.countType || 'uchar');
            for (let item = 0; item < count; item += 1) {
              face.push(readPlyScalar(view, offset, property.itemType || property.type));
              offset += plyScalarSize(property.itemType || property.type);
            }
          } else {
            offset += plyScalarSize(property.type);
          }
        }
        if (face.length) faces.push(face);
      }
    } else {
      for (let row = 0; row < element.count; row += 1) {
        for (const property of element.properties) {
          if (property.list) {
            const count = readPlyScalar(view, offset, property.countType || 'uchar');
            offset += plyScalarSize(property.countType || 'uchar') + count * plyScalarSize(property.itemType || property.type);
          } else {
            offset += plyScalarSize(property.type);
          }
        }
      }
    }
  }
  return triangulateFaces(vertices, faces);
}

function buildVisibilityBvh(sourceTriangles: Array<[Vec3, Vec3, Vec3]>, bounds: { center: Vec3; scale: number }): VisibilityMeshData | null {
  if (!sourceTriangles.length) {
    return null;
  }
  const triangleCount = Math.min(MAX_VISIBILITY_MESH_TRIANGLES, sourceTriangles.length);
  const stride = Math.max(1, Math.floor(sourceTriangles.length / triangleCount));
  const triangles = new Array(triangleCount).fill(null).map((_, index) => {
    const tri = sourceTriangles[Math.min(index * stride, sourceTriangles.length - 1)];
    const v0: Vec3 = [
      (tri[0][0] - bounds.center[0]) / bounds.scale,
      (tri[0][1] - bounds.center[1]) / bounds.scale,
      (tri[0][2] - bounds.center[2]) / bounds.scale,
    ];
    const v1: Vec3 = [
      (tri[1][0] - bounds.center[0]) / bounds.scale,
      (tri[1][1] - bounds.center[1]) / bounds.scale,
      (tri[1][2] - bounds.center[2]) / bounds.scale,
    ];
    const v2: Vec3 = [
      (tri[2][0] - bounds.center[0]) / bounds.scale,
      (tri[2][1] - bounds.center[1]) / bounds.scale,
      (tri[2][2] - bounds.center[2]) / bounds.scale,
    ];
    const min: Vec3 = [
      Math.min(v0[0], v1[0], v2[0]),
      Math.min(v0[1], v1[1], v2[1]),
      Math.min(v0[2], v1[2], v2[2]),
    ];
    const max: Vec3 = [
      Math.max(v0[0], v1[0], v2[0]),
      Math.max(v0[1], v1[1], v2[1]),
      Math.max(v0[2], v1[2], v2[2]),
    ];
    const centroid: Vec3 = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
    return { v0, v1, v2, min, max, centroid };
  });

  const nodes: Array<{ min: Vec3; max: Vec3; left: number; right: number; first: number; count: number }> = [];
  const buildNode = (start: number, end: number): number => {
    const nodeIndex = nodes.length;
    const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let index = start; index < end; index += 1) {
      const tri = triangles[index];
      min[0] = Math.min(min[0], tri.min[0]); min[1] = Math.min(min[1], tri.min[1]); min[2] = Math.min(min[2], tri.min[2]);
      max[0] = Math.max(max[0], tri.max[0]); max[1] = Math.max(max[1], tri.max[1]); max[2] = Math.max(max[2], tri.max[2]);
    }
    nodes.push({ min, max, left: -1, right: -1, first: start, count: end - start });
    if (end - start <= 4) {
      return nodeIndex;
    }
    const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : (extent[1] >= extent[2] ? 1 : 2);
    const sorted = triangles.slice(start, end).sort((a, b) => a.centroid[axis] - b.centroid[axis]);
    for (let index = 0; index < sorted.length; index += 1) {
      triangles[start + index] = sorted[index];
    }
    const mid = start + Math.max(1, Math.floor((end - start) / 2));
    nodes[nodeIndex].left = buildNode(start, mid);
    nodes[nodeIndex].right = buildNode(mid, end);
    nodes[nodeIndex].count = 0;
    return nodeIndex;
  };
  buildNode(0, triangles.length);

  const triangleData = new Float32Array(triangles.length * VISIBILITY_TRIANGLE_STRIDE_FLOATS);
  triangles.forEach((tri, index) => {
    const dst = index * VISIBILITY_TRIANGLE_STRIDE_FLOATS;
    const e1 = subtractVec3(tri.v1, tri.v0);
    const e2 = subtractVec3(tri.v2, tri.v0);
    triangleData.set([tri.v0[0], tri.v0[1], tri.v0[2], 0, e1[0], e1[1], e1[2], 0, e2[0], e2[1], e2[2], 0], dst);
  });

  const nodeData = new Float32Array(nodes.length * VISIBILITY_BVH_NODE_STRIDE_FLOATS);
  nodes.forEach((node, index) => {
    const dst = index * VISIBILITY_BVH_NODE_STRIDE_FLOATS;
    const isLeaf = node.count > 0;
    nodeData.set([
      node.min[0], node.min[1], node.min[2], isLeaf ? -(node.first + 1) : node.left,
      node.max[0], node.max[1], node.max[2], isLeaf ? node.count : node.right,
    ], dst);
  });

  return {
    triangles: triangleData,
    nodes: nodeData,
    triangleCount: triangles.length,
    nodeCount: nodes.length,
    source: 'visibility-geometry-bvh',
  };
}

async function loadVisibilityMeshData(url: string | null, bounds: { center: Vec3; scale: number }): Promise<VisibilityMeshData | null> {
  if (!url) {
    return null;
  }
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`visibility geometry fetch failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const { format, elements, headerEnd } = parsePlyHeader(bytes);
  let sourceTriangles: Array<[Vec3, Vec3, Vec3]> = [];
  if (format === 'ascii') {
    const text = new TextDecoder('utf-8').decode(bytes.slice(headerEnd));
    sourceTriangles = parseAsciiPly(text, elements);
  } else if (format === 'binary_little_endian') {
    sourceTriangles = parseBinaryLittleEndianPly(buffer, elements, headerEnd);
  } else {
    throw new Error(`unsupported PLY format for visibility geometry: ${format}`);
  }
  return buildVisibilityBvh(sourceTriangles, bounds);
}

const GBUFFER_SHADER = `
struct Uniforms {
  viewProj: mat4x4<f32>,
  view: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  renderParams: vec4<f32>,
  debugParams: vec4<f32>,
  viewportParams: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) deltaPixels: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) opacity: f32,
  @location(3) worldPosition: vec3<f32>,
  @location(4) normal: vec3<f32>,
  @location(5) material: vec3<f32>,
  @location(6) indirect: vec3<f32>,
  @location(7) conic: vec3<f32>,
};

struct GBufferOutput {
  @location(0) baseColor: vec4<f32>,
  @location(1) normal: vec4<f32>,
  @location(2) materialDepth: vec4<f32>,
  @location(3) indirect: vec4<f32>,
};

fn quat_rotate(q_in: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let q = normalize(q_in);
  let t = 2.0 * cross(q.yzw, v);
  return v + q.x * t + cross(q.yzw, t);
}

fn corner_for_vertex(vertex_index: u32) -> vec2<f32> {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );
  return corners[vertex_index];
}

fn covariance_radius_major_axis(cov: mat2x2<f32>) -> vec3<f32> {
  let trace_half = 0.5 * (cov[0][0] + cov[1][1]);
  let diff_half = 0.5 * (cov[0][0] - cov[1][1]);
  let root = sqrt(max(diff_half * diff_half + cov[0][1] * cov[0][1], 1e-8));
  let lambda = max(trace_half + root, 1e-5);
  var direction = vec2<f32>(cov[0][1], lambda - cov[0][0]);
  if (length(direction) <= 1e-5) {
    direction = vec2<f32>(1.0, 0.0);
  }
  return vec3<f32>(normalize(direction), sqrt(lambda));
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertex_index: u32,
  @location(0) center: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) opacityScale: vec3<f32>,
  @location(3) rotation: vec4<f32>,
  @location(4) normalIn: vec3<f32>,
  @location(5) material: vec3<f32>,
  @location(6) indirect: vec3<f32>,
) -> VertexOutput {
  let local = corner_for_vertex(vertex_index);
  let axis0 = quat_rotate(rotation, vec3<f32>(1.0, 0.0, 0.0));
  let axis1 = quat_rotate(rotation, vec3<f32>(0.0, 1.0, 0.0));
  let fallbackNormal = normalize(quat_rotate(rotation, vec3<f32>(0.0, 0.0, 1.0)));
  let normalLength = length(normalIn);
  var normal = fallbackNormal;
  if (normalLength > 0.001) {
    normal = normalize(normalIn);
  }
  let viewDirection = normalize(uniforms.cameraPosition.xyz - center);
  if (dot(normal, viewDirection) < 0.0) {
    normal = -normal;
  }

  let scaleMultiplier = uniforms.renderParams.y;
  let centerClip = uniforms.viewProj * vec4<f32>(center, 1.0);
  if (centerClip.w <= 1e-5) {
    var culled: VertexOutput;
    culled.position = vec4<f32>(2.0, 2.0, 1.0, 1.0);
    culled.deltaPixels = vec2<f32>(9999.0, 9999.0);
    culled.color = vec3<f32>(0.0);
    culled.opacity = 0.0;
    culled.worldPosition = center;
    culled.normal = normal;
    culled.material = material;
    culled.indirect = indirect;
    culled.conic = vec3<f32>(1.0, 0.0, 1.0);
    return culled;
  }
  let axis0Clip = uniforms.viewProj * vec4<f32>(center + axis0 * opacityScale.y * scaleMultiplier, 1.0);
  let axis1Clip = uniforms.viewProj * vec4<f32>(center + axis1 * opacityScale.z * scaleMultiplier, 1.0);
  let centerNdc = centerClip.xy / max(centerClip.w, 1e-6);
  let rawAxis0 = axis0Clip.xy / max(axis0Clip.w, 1e-6) - centerNdc;
  let rawAxis1 = axis1Clip.xy / max(axis1Clip.w, 1e-6) - centerNdc;

  let viewport = max(uniforms.viewportParams.xy, vec2<f32>(1.0));
  let axis0Px = rawAxis0 * viewport * 0.5;
  let axis1Px = rawAxis1 * viewport * 0.5;
  let cov00 = axis0Px.x * axis0Px.x + axis1Px.x * axis1Px.x + 0.25;
  let cov01 = axis0Px.x * axis0Px.y + axis1Px.x * axis1Px.y;
  let cov11 = axis0Px.y * axis0Px.y + axis1Px.y * axis1Px.y + 0.25;
  let cov = mat2x2<f32>(cov00, cov01, cov01, cov11);
  let major = covariance_radius_major_axis(cov);
  let radiusPixels = clamp(3.0 * major.z, 1.5, 48.0);
  let perpendicular = vec2<f32>(-major.y, major.x);
  let quadOffsetPixels = (major.xy * local.x + perpendicular * local.y) * radiusPixels;
  let projectedNdc = centerNdc + quadOffsetPixels / (viewport * 0.5);
  let det = max(cov00 * cov11 - cov01 * cov01, 1e-6);
  let conic = vec3<f32>(cov11 / det, -cov01 / det, cov00 / det);

  var output: VertexOutput;
  output.position = vec4<f32>(projectedNdc * centerClip.w, centerClip.z, centerClip.w);
  output.deltaPixels = quadOffsetPixels;
  output.color = color;
  output.opacity = opacityScale.x * uniforms.renderParams.z;
  output.worldPosition = center;
  output.normal = normal;
  output.material = material;
  output.indirect = indirect;
  output.conic = conic;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> GBufferOutput {
  let radius2 = dot(input.deltaPixels, input.deltaPixels);
  let power = -0.5 * (
    input.conic.x * input.deltaPixels.x * input.deltaPixels.x
    + 2.0 * input.conic.y * input.deltaPixels.x * input.deltaPixels.y
    + input.conic.z * input.deltaPixels.y * input.deltaPixels.y
  );
  if (power < -9.0 || radius2 > 2304.0) {
    discard;
  }

  let gaussian = exp(power);
  let alpha = clamp(input.opacity * gaussian, 0.0, 0.985);
  if (alpha < 0.003) {
    discard;
  }

  let premult = alpha;
  let normal = normalize(input.normal);
  var output: GBufferOutput;
  output.baseColor = vec4<f32>(input.color * premult, alpha);
  output.normal = vec4<f32>(normal * premult, alpha);
  output.materialDepth = vec4<f32>(
    clamp(input.material.x, 0.0, 1.0) * premult,
    clamp(input.material.y, 0.04, 1.0) * premult,
    input.position.z * premult,
    alpha,
  );
  output.indirect = vec4<f32>(input.indirect * premult, alpha);
  return output;
}
`;

const COMPOSITE_SHADER = `
struct Uniforms {
  viewProj: mat4x4<f32>,
  view: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  renderParams: vec4<f32>,
  debugParams: vec4<f32>,
  viewportParams: vec4<f32>,
};

struct VSOut {
  @builtin(position) position: vec4<f32>,
};

struct CubeCoord {
  uv: vec2<f32>,
  face: i32,
};

struct ReflectionTrace {
  visibility: f32,
  indirectLight: vec3<f32>,
};

struct VisibilityProxy {
  centerRadius: vec4<f32>,
  colorStrength: vec4<f32>,
};

struct VisibilityTriangle {
  v0: vec4<f32>,
  e1: vec4<f32>,
  e2: vec4<f32>,
};

struct VisibilityBvhNode {
  boundsMinLeft: vec4<f32>,
  boundsMaxRight: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var gBaseTexture: texture_2d<f32>;
@group(0) @binding(2) var gNormalTexture: texture_2d<f32>;
@group(0) @binding(3) var gMaterialTexture: texture_2d<f32>;
@group(0) @binding(4) var gIndirectTexture: texture_2d<f32>;
@group(0) @binding(5) var envTexture: texture_2d_array<f32>;
@group(0) @binding(6) var bsdfTexture: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> visibilityProxies: array<VisibilityProxy>;
@group(0) @binding(8) var<storage, read> visibilityTriangles: array<VisibilityTriangle>;
@group(0) @binding(9) var<storage, read> visibilityBvhNodes: array<VisibilityBvhNode>;

@vertex
fn vertexMain(@builtin(vertex_index) vertex_index: u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0),
  );
  var out: VSOut;
  out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
  return out;
}

fn cube_coord(direction: vec3<f32>) -> CubeCoord {
  let d = normalize(direction);
  let ad = abs(d);
  var coord: CubeCoord;
  if (ad.x >= ad.y && ad.x >= ad.z) {
    if (d.x >= 0.0) {
      coord.face = 0;
      coord.uv = vec2<f32>(-d.z, -d.y) / ad.x;
    } else {
      coord.face = 1;
      coord.uv = vec2<f32>(d.z, -d.y) / ad.x;
    }
  } else if (ad.y >= ad.x && ad.y >= ad.z) {
    if (d.y >= 0.0) {
      coord.face = 2;
      coord.uv = vec2<f32>(d.x, d.z) / ad.y;
    } else {
      coord.face = 3;
      coord.uv = vec2<f32>(d.x, -d.z) / ad.y;
    }
  } else {
    if (d.z >= 0.0) {
      coord.face = 4;
      coord.uv = vec2<f32>(d.x, -d.y) / ad.z;
    } else {
      coord.face = 5;
      coord.uv = vec2<f32>(-d.x, -d.y) / ad.z;
    }
  }
  coord.uv = coord.uv * 0.5 + vec2<f32>(0.5, 0.5);
  return coord;
}

fn sample_env_level(direction: vec3<f32>, mip_level: i32) -> vec3<f32> {
  let coord = cube_coord(direction);
  let dims = textureDimensions(envTexture, mip_level);
  let uv = clamp(coord.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let sample_pos = uv * vec2<f32>(f32(max(dims.x, 1u) - 1u), f32(max(dims.y, 1u) - 1u));
  let base = vec2<i32>(floor(sample_pos));
  let frac_part = fract(sample_pos);
  let max_x = i32(max(dims.x, 1u) - 1u);
  let max_y = i32(max(dims.y, 1u) - 1u);
  let x0 = clamp(base.x, 0, max_x);
  let y0 = clamp(base.y, 0, max_y);
  let x1 = clamp(base.x + 1, 0, max_x);
  let y1 = clamp(base.y + 1, 0, max_y);
  let c00 = textureLoad(envTexture, vec2<i32>(x0, y0), coord.face, mip_level).rgb;
  let c10 = textureLoad(envTexture, vec2<i32>(x1, y0), coord.face, mip_level).rgb;
  let c01 = textureLoad(envTexture, vec2<i32>(x0, y1), coord.face, mip_level).rgb;
  let c11 = textureLoad(envTexture, vec2<i32>(x1, y1), coord.face, mip_level).rgb;
  let cx0 = mix(c00, c10, frac_part.x);
  let cx1 = mix(c01, c11, frac_part.x);
  return mix(cx0, cx1, frac_part.y);
}

fn sample_bsdf_lut(uv_in: vec2<f32>) -> vec2<f32> {
  let dims = textureDimensions(bsdfTexture);
  let uv = clamp(uv_in, vec2<f32>(0.0), vec2<f32>(1.0));
  let sample_pos = uv * vec2<f32>(f32(max(dims.x, 1u) - 1u), f32(max(dims.y, 1u) - 1u));
  let base = vec2<i32>(floor(sample_pos));
  let frac_part = fract(sample_pos);
  let max_x = i32(max(dims.x, 1u) - 1u);
  let max_y = i32(max(dims.y, 1u) - 1u);
  let x0 = clamp(base.x, 0, max_x);
  let y0 = clamp(base.y, 0, max_y);
  let x1 = clamp(base.x + 1, 0, max_x);
  let y1 = clamp(base.y + 1, 0, max_y);
  let c00 = textureLoad(bsdfTexture, vec2<i32>(x0, y0), 0).rg;
  let c10 = textureLoad(bsdfTexture, vec2<i32>(x1, y0), 0).rg;
  let c01 = textureLoad(bsdfTexture, vec2<i32>(x0, y1), 0).rg;
  let c11 = textureLoad(bsdfTexture, vec2<i32>(x1, y1), 0).rg;
  let cx0 = mix(c00, c10, frac_part.x);
  let cx1 = mix(c01, c11, frac_part.x);
  return mix(cx0, cx1, frac_part.y);
}

fn env_specular_mip(roughness: f32) -> f32 {
  let mip_count = max(uniforms.debugParams.w, 1.0);
  let max_mip = max(mip_count - 1.0, 0.0);
  if (max_mip <= 0.0) {
    return 0.0;
  }
  if (roughness < ${NATIVE_ENV_MAX_ROUGHNESS.toFixed(2)}) {
    let scaled = (clamp(roughness, ${NATIVE_ENV_MIN_ROUGHNESS.toFixed(2)}, ${NATIVE_ENV_MAX_ROUGHNESS.toFixed(2)}) - ${NATIVE_ENV_MIN_ROUGHNESS.toFixed(2)})
      / (${(NATIVE_ENV_MAX_ROUGHNESS - NATIVE_ENV_MIN_ROUGHNESS).toFixed(2)});
    return clamp(scaled * max(max_mip - 1.0, 0.0), 0.0, max_mip);
  }
  let high = (clamp(roughness, ${NATIVE_ENV_MAX_ROUGHNESS.toFixed(2)}, 1.0) - ${NATIVE_ENV_MAX_ROUGHNESS.toFixed(2)})
    / ${(1 - NATIVE_ENV_MAX_ROUGHNESS).toFixed(2)};
  return clamp(high + max(max_mip - 1.0, 0.0), 0.0, max_mip);
}

fn sample_environment(direction: vec3<f32>, roughness: f32) -> vec3<f32> {
  let mip = i32(round(env_specular_mip(roughness)));
  return sample_env_level(direction, mip);
}

fn reconstruct_world(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let clip = vec4<f32>(uv * 2.0 - 1.0, depth, 1.0);
  let world = uniforms.invViewProj * clip;
  return world.xyz / max(world.w, 1e-6);
}

fn load_depth_at(coord: vec2<i32>) -> f32 {
  let dims = textureDimensions(gMaterialTexture);
  let clamped = clamp(coord, vec2<i32>(0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1));
  let materialSample = textureLoad(gMaterialTexture, clamped, 0);
  let alpha = max(materialSample.a, 1e-5);
  return clamp(materialSample.b / alpha, 0.0, 1.0);
}

fn compute_surf_normal(coord: vec2<i32>, uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let dims = textureDimensions(gMaterialTexture);
  let texel = vec2<f32>(1.0 / f32(max(dims.x, 1u)), 1.0 / f32(max(dims.y, 1u)));
  let center = reconstruct_world(uv, depth);
  let rightDepth = load_depth_at(coord + vec2<i32>(1, 0));
  let upDepth = load_depth_at(coord + vec2<i32>(0, 1));
  let rightWorld = reconstruct_world(uv + vec2<f32>(texel.x, 0.0), rightDepth);
  let upWorld = reconstruct_world(uv + vec2<f32>(0.0, texel.y), upDepth);
  let tangentX = rightWorld - center;
  let tangentY = upWorld - center;
  let candidate = cross(tangentX, tangentY);
  if (length(candidate) <= 1e-5) {
    return vec3<f32>(0.0, 0.0, 1.0);
  }
  return normalize(candidate);
}

fn intersect_aabb(origin: vec3<f32>, inv_direction: vec3<f32>, bounds_min: vec3<f32>, bounds_max: vec3<f32>, max_t: f32) -> bool {
  let t0 = (bounds_min - origin) * inv_direction;
  let t1 = (bounds_max - origin) * inv_direction;
  let tmin3 = min(t0, t1);
  let tmax3 = max(t0, t1);
  let tmin = max(max(tmin3.x, tmin3.y), max(tmin3.z, 0.0));
  let tmax = min(min(tmax3.x, tmax3.y), min(tmax3.z, max_t));
  return tmax >= tmin;
}

fn intersect_triangle(origin: vec3<f32>, direction: vec3<f32>, triangle: VisibilityTriangle, max_t: f32) -> f32 {
  let pvec = cross(direction, triangle.e2.xyz);
  let det = dot(triangle.e1.xyz, pvec);
  if (abs(det) < 1e-6) {
    return -1.0;
  }
  let inv_det = 1.0 / det;
  let tvec = origin - triangle.v0.xyz;
  let u = dot(tvec, pvec) * inv_det;
  if (u < 0.0 || u > 1.0) {
    return -1.0;
  }
  let qvec = cross(tvec, triangle.e1.xyz);
  let v = dot(direction, qvec) * inv_det;
  if (v < 0.0 || u + v > 1.0) {
    return -1.0;
  }
  let t = dot(triangle.e2.xyz, qvec) * inv_det;
  if (t > 0.015 && t < max_t) {
    return t;
  }
  return -1.0;
}

fn trace_visibility_mesh(origin: vec3<f32>, direction: vec3<f32>, roughness: f32) -> ReflectionTrace {
  let nodeCount = u32(max(uniforms.viewportParams.w, 0.0));
  var hit = ReflectionTrace(1.0, vec3<f32>(0.0));
  if (nodeCount == 0u) {
    return hit;
  }

  let invDirection = 1.0 / (sign(direction) * max(abs(direction), vec3<f32>(1e-5)));
  let maxDistance = mix(0.9, 1.8, roughness);
  var bestT = maxDistance;
  var stack: array<u32, 64>;
  var stackSize = 1u;
  stack[0] = 0u;

  for (var iter = 0u; iter < 256u; iter = iter + 1u) {
    if (stackSize == 0u) {
      break;
    }
    stackSize = stackSize - 1u;
    let nodeIndex = stack[stackSize];
    if (nodeIndex >= nodeCount) {
      continue;
    }
    let node = visibilityBvhNodes[nodeIndex];
    if (!intersect_aabb(origin, invDirection, node.boundsMinLeft.xyz, node.boundsMaxRight.xyz, bestT)) {
      continue;
    }
    if (node.boundsMinLeft.w < 0.0) {
      let first = u32(-node.boundsMinLeft.w - 1.0);
      let triCount = u32(max(node.boundsMaxRight.w, 0.0));
      for (var triOffset = 0u; triOffset < 8u; triOffset = triOffset + 1u) {
        if (triOffset >= triCount) {
          break;
        }
        let t = intersect_triangle(origin, direction, visibilityTriangles[first + triOffset], bestT);
        if (t > 0.0) {
          bestT = t;
          hit.visibility = 0.0;
          hit.indirectLight = vec3<f32>(0.42, 0.44, 0.46);
        }
      }
    } else {
      if (stackSize + 2u < 64u) {
        stack[stackSize] = u32(node.boundsMinLeft.w);
        stack[stackSize + 1u] = u32(node.boundsMaxRight.w);
        stackSize = stackSize + 2u;
      }
    }
  }

  return hit;
}

fn trace_visibility_proxy(origin: vec3<f32>, direction: vec3<f32>, roughness: f32) -> ReflectionTrace {
  let proxyCount = u32(max(uniforms.viewportParams.z, 0.0));
  var hit = ReflectionTrace(1.0, vec3<f32>(0.0));
  if (proxyCount == 0u) {
    return hit;
  }

  let maxTests = min(proxyCount, 384u);
  let stride = max(proxyCount / maxTests, 1u);
  var bestT = 1e9;
  for (var test = 0u; test < 384u; test = test + 1u) {
    if (test >= maxTests) {
      break;
    }
    let proxyIndex = min(test * stride, proxyCount - 1u);
    let proxy = visibilityProxies[proxyIndex];
    let center = proxy.centerRadius.xyz;
    let radius = proxy.centerRadius.w * mix(1.2, 2.2, roughness);
    let oc = origin - center;
    let b = dot(oc, direction);
    let c = dot(oc, oc) - radius * radius;
    let discriminant = b * b - c;
    if (discriminant <= 0.0) {
      continue;
    }
    let t = -b - sqrt(discriminant);
    if (t > 0.02 && t < bestT) {
      bestT = t;
      hit.visibility = 0.0;
      hit.indirectLight = max(proxy.colorStrength.rgb * proxy.colorStrength.a, vec3<f32>(0.0));
    }
  }

  return hit;
}

fn trace_reflection(origin: vec3<f32>, direction: vec3<f32>, roughness: f32) -> ReflectionTrace {
  let dims = textureDimensions(gBaseTexture);
  let bounds = vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1);
  var hit = ReflectionTrace(1.0, vec3<f32>(0.0));
  let start_distance = 0.025;
  let step_distance = mix(0.05, 0.12, roughness);
  let hit_thickness = 0.003 + roughness * 0.02;

  for (var step = 0; step < 28; step = step + 1) {
    let t = start_distance + f32(step) * step_distance;
    let sample_world = origin + direction * t;
    let clip = uniforms.viewProj * vec4<f32>(sample_world, 1.0);
    if (clip.w <= 0.0) {
      continue;
    }
    let uv = clip.xy / clip.w * 0.5 + vec2<f32>(0.5, 0.5);
    if (uv.x <= 0.001 || uv.x >= 0.999 || uv.y <= 0.001 || uv.y >= 0.999) {
      continue;
    }
    let coord = clamp(vec2<i32>(vec2<f32>(f32(dims.x), f32(dims.y)) * uv), vec2<i32>(0), bounds);
    let materialSample = textureLoad(gMaterialTexture, coord, 0);
    let alpha = materialSample.a;
    if (alpha < 0.02) {
      continue;
    }
    let sceneDepth = materialSample.b / alpha;
    let rayDepth = clip.z / clip.w;
    let depthDelta = rayDepth - sceneDepth;
    if (depthDelta >= 0.0 && depthDelta <= hit_thickness) {
      let indirectSample = textureLoad(gIndirectTexture, coord, 0);
      let baseSample = textureLoad(gBaseTexture, coord, 0);
      let hitAlpha = max(baseSample.a, 1e-5);
      let hitIndirectAlpha = max(indirectSample.a, 1e-5);
      let hitBase = baseSample.rgb / hitAlpha;
      let hitIndirect = indirectSample.rgb / hitIndirectAlpha;
      hit.visibility = 0.0;
      hit.indirectLight = mix(hitBase, hitIndirect, 0.7);
      return hit;
    }
  }

  return hit;
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dims = textureDimensions(gBaseTexture);
  let coord = clamp(vec2<i32>(position.xy), vec2<i32>(0), vec2<i32>(i32(dims.x) - 1, i32(dims.y) - 1));
  let uv = (vec2<f32>(f32(coord.x), f32(coord.y)) + vec2<f32>(0.5, 0.5)) / vec2<f32>(f32(dims.x), f32(dims.y));
  let bg = vec3<f32>(0.01, 0.015, 0.03);

  let baseSample = textureLoad(gBaseTexture, coord, 0);
  let coverage = clamp(baseSample.a, 0.0, 1.0);
  if (coverage < 0.001) {
    return vec4<f32>(bg, 1.0);
  }

  let surfaceColor = max(baseSample.rgb, vec3<f32>(0.0)) / max(coverage, 1e-5);
  let baseColor = max(baseSample.rgb, vec3<f32>(0.0));
  let normalSample = textureLoad(gNormalTexture, coord, 0);
  let materialSample = textureLoad(gMaterialTexture, coord, 0);
  let indirectSample = textureLoad(gIndirectTexture, coord, 0);

  let accumulatedNormal = normalize(normalSample.rgb / max(normalSample.a, 1e-5));
  let reflectionStrength = clamp((materialSample.r / max(materialSample.a, 1e-5)) * uniforms.renderParams.w, 0.0, 1.0);
  let roughness = clamp(materialSample.g / max(materialSample.a, 1e-5), 0.04, 1.0);
  let depth = clamp(materialSample.b / max(materialSample.a, 1e-5), 0.0, 1.0);
  let worldPosition = reconstruct_world(uv, depth);
  let surfNormal = compute_surf_normal(coord, uv, depth);
  let normal = normalize(mix(accumulatedNormal, surfNormal, 0.6));
  let viewDirection = normalize(uniforms.cameraPosition.xyz - worldPosition);
  let mode = i32(uniforms.debugParams.x + 0.5);
  var trace = ReflectionTrace(1.0, vec3<f32>(0.0));
  var specular = vec3<f32>(0.0);
  if (reflectionStrength > 0.001 || mode == 2 || mode == 4) {
    let reflected = normalize(reflect(-viewDirection, normal));
    let traceOrigin = worldPosition + normal * 0.01;
    trace = trace_visibility_mesh(traceOrigin, reflected, roughness);
    if (trace.visibility > 0.5) {
      trace = trace_visibility_proxy(traceOrigin, reflected, roughness);
    }
    if (trace.visibility > 0.5) {
      trace = trace_reflection(traceOrigin, reflected, roughness);
    }
    let env = sample_environment(reflected, roughness);
    let ndotv = clamp(dot(normal, viewDirection), 0.0, 1.0);
    let fg = sample_bsdf_lut(vec2<f32>(ndotv, roughness));
    let specularWeight =
      ((vec3<f32>(0.04 * (1.0 - reflectionStrength)) + surfaceColor * reflectionStrength) * fg.x)
      + vec3<f32>(fg.y);
    let specularLight = mix(trace.indirectLight, env, trace.visibility);
    specular = specularLight * coverage * specularWeight * max(reflectionStrength, select(0.0, 1.0, mode == 2 || mode == 4));
  }
  var color = (1.0 - reflectionStrength) * baseColor + specular;

  if (mode == 1) {
    color = baseColor;
  } else if (mode == 2) {
    color = specular;
  } else if (mode == 3) {
    color = vec3<f32>(coverage);
  } else if (mode == 4) {
    color = mix(vec3<f32>(trace.visibility), trace.indirectLight, 0.65);
  }

  color = color * uniforms.renderParams.x;
  // The base/SH color is already display-range; only soft-knee the HDR overshoot
  // from specular so highlights do not clip hard, instead of Reinhard-crushing
  // the whole image (which desaturated and muddied the room).
  let knee = vec3<f32>(1.0);
  let over = max(color - knee, vec3<f32>(0.0));
  color = min(color, knee) + over / (vec3<f32>(1.0) + over);
  color = color + bg * (1.0 - coverage);
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(color, 1.0);
}
`;

const RefGaussianWebGPUViewer: React.FC<{ artifacts: RefGaussianArtifacts }> = ({ artifacts }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraControllerRef = useRef<{
    setPreset: (preset: 'overview' | 'mirror' | 'interior' | 'native0' | 'recenter' | 'visible') => void;
    markSortDirty: () => void;
  } | null>(null);
  const renderSettingsRef = useRef({
    exposure: 0.95,
    opacity: 0.4,
    splatScale: 0.45,
    reflection: 0.0,
    mode: 'color' as RenderMode,
  });
  const [metadata, setMetadata] = useState<RefGaussianBundleMetadata | null>(null);
  const [status, setStatus] = useState('Loading Ref-Gaussian bundle metadata...');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RendererStats | null>(null);
  const [webgpuActive, setWebgpuActive] = useState(false);
  const [exposure, setExposure] = useState(0.95);
  const [opacity, setOpacity] = useState(0.4);
  const [splatScale, setSplatScale] = useState(0.45);
  const [reflection, setReflection] = useState(0.0);
  const [renderMode, setRenderMode] = useState<RenderMode>('color');

  useEffect(() => {
    renderSettingsRef.current = { exposure, opacity, splatScale, reflection, mode: renderMode };
  }, [exposure, opacity, splatScale, reflection, renderMode]);

  useEffect(() => {
    let disposed = false;
    let animationFrameId = 0;
    let device: any = null;
    let context: any = null;
    let needsSortUpload = true;
    let lastSortMs = 0;

    const cameraState: CameraState = {
      yaw: 0.8,
      pitch: 0.35,
      radius: 1.65,
      target: [0, 0, 0],
      near: 0.003,
      far: 80,
    };
    const dragState: { active: boolean; x: number; y: number; mode: 'orbit' | 'pan' } = {
      active: false,
      x: 0,
      y: 0,
      mode: 'orbit',
    };
    const cleanupHandlers: Array<() => void> = [];

    const loadArray = async (
      loadedMetadata: RefGaussianBundleMetadata,
      arrayName: string,
      maxRows: number,
      required = false,
    ): Promise<RefGaussianArraySlice | null> => {
      if (!hasRefGaussianArray(loadedMetadata, arrayName)) {
        if (required) {
          throw new Error(`Ref-Gaussian bundle is missing required array: ${arrayName}`);
        }
        return null;
      }

      const descriptor = loadedMetadata.arrays.find((array) => array.name === arrayName);
      const mb = descriptor ? (descriptor.byteLength / (1024 * 1024)).toFixed(1) : '?';
      setStatus(`Loading ${arrayName} (${mb} MB range)...`);
      return fetchRefGaussianFloat32ArraySlice({
        bundleJsonUrl: artifacts.bundleJsonUrl || '',
        bundleBinUrl: artifacts.bundleBinUrl,
        metadata: loadedMetadata,
        arrayName,
        maxRows,
      });
    };

    const run = async () => {
      try {
        if (!artifacts.bundleJsonUrl) {
          setError('No Ref-Gaussian bundle metadata URL is available for this scan.');
          setStatus('Bundle unavailable');
          return;
        }

        const loadedMetadata = await fetchRefGaussianBundleMetadata(artifacts.bundleJsonUrl);
        if (disposed) return;
        setMetadata(loadedMetadata);
        const runtimeAssets = listRefGaussianRuntimeAssets(artifacts, loadedMetadata);

        const gpu = (navigator as any).gpu;
        if (!gpu) {
          setStatus('WebGPU is not available in this browser. Use Native Renders or Fallback Splat.');
          return;
        }

        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          setStatus('WebGPU adapter unavailable. Use Native Renders or Fallback Splat.');
          return;
        }

        device = await adapter.requestDevice();
        const canvas = canvasRef.current;
        if (!canvas || disposed) return;
        context = (canvas.getContext as any)('webgpu');
        if (!context) {
          setStatus('WebGPU canvas context unavailable.');
          return;
        }
        setWebgpuActive(true);

        const renderRows = Math.min(
          loadedMetadata.pointCount || MAX_FULL_WEBGPU_GAUSSIANS,
          MAX_FULL_WEBGPU_GAUSSIANS,
        );
        const bounded = renderRows < loadedMetadata.pointCount;
        const positions = await loadArray(loadedMetadata, 'positions', renderRows, true);
        if (!positions) return;
        const arrays = {
          shDc: await loadArray(loadedMetadata, 'shDc', positions.rowCount),
          shRest: await loadArray(loadedMetadata, 'shRest', positions.rowCount),
          originalColor: await loadArray(loadedMetadata, 'originalColor', positions.rowCount),
          diffuseColor: await loadArray(loadedMetadata, 'diffuseColor', positions.rowCount),
          opacityLogit: await loadArray(loadedMetadata, 'opacityLogit', positions.rowCount),
          logScale: await loadArray(loadedMetadata, 'logScale', positions.rowCount),
          rotation: await loadArray(loadedMetadata, 'rotation', positions.rowCount),
          normals: await loadArray(loadedMetadata, 'normals', positions.rowCount),
          secondaryNormals: await loadArray(loadedMetadata, 'secondaryNormals', positions.rowCount),
          indirectDc: await loadArray(loadedMetadata, 'indirectDc', positions.rowCount),
          indirectRest: await loadArray(loadedMetadata, 'indirectRest', positions.rowCount),
          reflectionStrength: await loadArray(loadedMetadata, 'reflectionStrength', positions.rowCount),
          roughness: await loadArray(loadedMetadata, 'roughness', positions.rowCount),
          metalness: await loadArray(loadedMetadata, 'metalness', positions.rowCount),
        };
        let envTextureSource = createNeutralEnvTextureSource();
        if (hasBundleArray(loadedMetadata, 'envMap1Base')) {
          setStatus('Loading native Ref-Gaussian EnvLight cubemap...');
          const envMap = await fetchRefGaussianFloat32Array({
            bundleJsonUrl: artifacts.bundleJsonUrl || '',
            bundleBinUrl: artifacts.bundleBinUrl,
            metadata: loadedMetadata,
            arrayName: 'envMap1Base',
          });
          envTextureSource = createEnvTextureSource(envMap.data, envMap.descriptor.shape);
        }
        let bsdfTextureSource = createFallbackBsdfLutTextureSource();
        const bsdfLutUrl = runtimeAssets.nativeBsdfLutUrl;
        if (bsdfLutUrl) {
          setStatus('Loading native Ref-Gaussian BSDF LUT...');
          try {
            const response = await fetch(bsdfLutUrl, { cache: 'no-store' });
            if (response.ok) {
              bsdfTextureSource = createBsdfLutTextureSource(await response.arrayBuffer());
            }
          } catch (fetchError) {
            console.warn('Failed to load native Ref-Gaussian BSDF LUT, using fallback LUT:', fetchError);
          }
        }
        if (disposed) return;

        const loadedMb = [
          positions,
          arrays.shDc,
          arrays.shRest,
          arrays.originalColor,
          arrays.diffuseColor,
          arrays.opacityLogit,
          arrays.logScale,
          arrays.rotation,
          arrays.normals,
          arrays.secondaryNormals,
          arrays.indirectDc,
          arrays.indirectRest,
          arrays.reflectionStrength,
          arrays.roughness,
          arrays.metalness,
        ].reduce((sum, slice) => sum + arrayMemoryMb(slice), 0);

        setStatus(`Preparing ${positions.rowCount.toLocaleString()} splats (${loadedMb.toFixed(1)} MB of ranged attributes)...`);
        const bounds = computeBounds(positions);
        const normalizedPositions = normalizePositions(positions, bounds.center, bounds.scale);
        const adaptiveSettings = computeAdaptiveRenderSettings({
          logScale: arrays.logScale,
          opacityLogit: arrays.opacityLogit,
          sceneScale: bounds.scale,
          count: positions.rowCount,
        });
        const nativeScaleSettings = computeNativeCameraScaleSettings({
          metadata: loadedMetadata,
          image: ((loadedMetadata.cameraCalibration as any)?.nativeEvalSplit?.testImages || [])[0],
          positions,
          logScale: arrays.logScale,
          rotation: arrays.rotation,
          bounds,
        });
        const initialSettings = nativeScaleSettings
          ? {
              ...adaptiveSettings,
              splatScale: nativeScaleSettings.splatScale,
            }
          : adaptiveSettings;
        renderSettingsRef.current = {
          ...renderSettingsRef.current,
          ...initialSettings,
        };
        setExposure(initialSettings.exposure);
        setOpacity(initialSettings.opacity);
        setSplatScale(initialSettings.splatScale);
        setReflection(initialSettings.reflection);
        setRenderMode('color');
        if (nativeScaleSettings) {
          setStatus(`Preparing ${positions.rowCount.toLocaleString()} splats (${loadedMb.toFixed(1)} MB); native p95 radius ${nativeScaleSettings.nativeRadiusP95.toFixed(1)}px -> scale ${nativeScaleSettings.splatScale.toFixed(3)}.`);
        }
        const visibilityProxy = buildVisibilityProxyData({
          normalizedPositions,
          sceneScale: bounds.scale,
          arrays,
          count: positions.rowCount,
        });
        let visibilityMesh: VisibilityMeshData | null = null;
        if (runtimeAssets.visibilityGeometryUrl) {
          try {
            setStatus('Loading local Ref-Gaussian visibility geometry BVH...');
            visibilityMesh = await loadVisibilityMeshData(runtimeAssets.visibilityGeometryUrl, bounds);
          } catch (meshError) {
            console.warn('Failed to load Ref-Gaussian visibility geometry, using Gaussian proxy:', meshError);
          }
        }
        const normalizeWorldPoint = (point: Vec3): Vec3 => [
          (point[0] - bounds.center[0]) / bounds.scale,
          (point[1] - bounds.center[1]) / bounds.scale,
          (point[2] - bounds.center[2]) / bounds.scale,
        ];
        const normalizedLower = normalizeWorldPoint(bounds.lower);
        const normalizedUpper = normalizeWorldPoint(bounds.upper);
        const robustSize: Vec3 = [
          normalizedUpper[0] - normalizedLower[0],
          normalizedUpper[1] - normalizedLower[1],
          normalizedUpper[2] - normalizedLower[2],
        ];
        let activeNativeCameraView: NativeCameraView | null = null;
        const nativeTestImages = ((loadedMetadata.cameraCalibration as any)?.nativeEvalSplit?.testImages || []) as any[];
        const firstNativeImage = nativeTestImages[0] || loadedMetadata.cameraCalibration?.images?.[0];
        const applyLookAt = (eye: Vec3, target: Vec3) => {
          activeNativeCameraView = null;
          const offset = subtractVec3(eye, target);
          const radius = Math.max(Math.hypot(offset[0], offset[1], offset[2]), 0.008);
          cameraState.target = target;
          cameraState.radius = radius;
          cameraState.pitch = clamp(Math.asin(offset[1] / radius), -1.45, 1.45);
          cameraState.yaw = Math.atan2(offset[0], offset[2]);
          needsSortUpload = true;
        };
        const sceneCenter: Vec3 = [0, 0, 0];
        const frontZ = normalizedUpper[2] + robustSize[2] * 0.55;
        const backZ = normalizedLower[2] - robustSize[2] * 0.35;
        const midY = (normalizedLower[1] + normalizedUpper[1]) * 0.52;
        const applyPreset = (preset: 'overview' | 'mirror' | 'interior' | 'native0' | 'recenter' | 'visible') => {
          if (preset === 'recenter') {
            applyLookAt(
              [robustSize[0] * 0.85, robustSize[1] * 0.32, frontZ],
              sceneCenter,
            );
            return;
          }
          if (preset === 'visible') {
            const eye = computeEye();
            const visibleTarget = findViewCenterTarget(normalizedPositions, eye, cameraState.target, positions.rowCount);
            applyLookAt(eye, visibleTarget);
            return;
          }
          if (preset === 'overview') {
            applyLookAt(
              [robustSize[0] * 0.9, robustSize[1] * 0.35, frontZ],
              sceneCenter,
            );
            return;
          }
          if (preset === 'mirror') {
            const target: Vec3 = [normalizedUpper[0] * 0.18, midY * 0.2, normalizedUpper[2] * 0.12];
            applyLookAt(
              [target[0] + robustSize[0] * 0.28, target[1] + robustSize[1] * 0.05, target[2] + robustSize[2] * 0.42],
              target,
            );
            return;
          }
          if (preset === 'interior') {
            const eye: Vec3 = [sceneCenter[0], midY * 0.1, normalizedUpper[2] * 0.18];
            applyLookAt(eye, [sceneCenter[0], midY * 0.08, backZ]);
            return;
          }

          const nativeView = nativeCameraViewForImage(loadedMetadata, firstNativeImage, bounds);
          if (!nativeView) {
            applyLookAt([1.05, 0.42, 1.18], [0, 0, 0]);
            return;
          }
          activeNativeCameraView = nativeView;
          cameraState.target = addVec3(nativeView.eye, scaleVec3(nativeView.forward, Math.max(robustSize[2] * 0.35, 0.08)));
          cameraState.radius = Math.max(Math.hypot(
            cameraState.target[0] - nativeView.eye[0],
            cameraState.target[1] - nativeView.eye[1],
            cameraState.target[2] - nativeView.eye[2],
          ), 0.008);
          needsSortUpload = true;
        };
        applyPreset(
          (firstNativeImage ? 'native0' : 'visible'),
        );
        cameraControllerRef.current = {
          setPreset: applyPreset,
          markSortDirty: () => {
            needsSortUpload = true;
          },
        };

        const presentationFormat = typeof gpu.getPreferredCanvasFormat === 'function'
          ? gpu.getPreferredCanvasFormat()
          : 'bgra8unorm';

        let gBaseTexture: any = null;
        let gNormalTexture: any = null;
        let gMaterialTexture: any = null;
        let gIndirectTexture: any = null;
        let gbufferBindGroup: any = null;
        let compositeBindGroup: any = null;

        const configureCanvas = () => {
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(width * pixelRatio);
          canvas.height = Math.floor(height * pixelRatio);
          context.configure({
            device,
            format: presentationFormat,
            alphaMode: 'opaque',
          });
          needsSortUpload = true;
        };
        configureCanvas();

        const gbufferShaderModule = device.createShaderModule({ code: GBUFFER_SHADER });
        const assertShaderModule = async (shaderModule: any, label: string) => {
          if (typeof shaderModule.getCompilationInfo !== 'function') {
            return;
          }
          const info = await shaderModule.getCompilationInfo();
          const errors = (info.messages || []).filter((message: any) => message.type === 'error');
          if (errors.length > 0) {
            throw new Error(`${label} WGSL compile failed: ${errors.map((message: any) => message.message).join('; ')}`);
          }
        };
        await assertShaderModule(gbufferShaderModule, 'Ref-Gaussian allmap raster');
        const gbufferPipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: gbufferShaderModule,
            entryPoint: 'vertexMain',
            buffers: [{
              arrayStride: INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 3 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
                { shaderLocation: 2, offset: 6 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
                { shaderLocation: 3, offset: 9 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x4' },
                { shaderLocation: 4, offset: 13 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
                { shaderLocation: 5, offset: 16 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
                { shaderLocation: 6, offset: 19 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x3' },
              ],
            }],
          },
          fragment: {
            module: gbufferShaderModule,
            entryPoint: 'fragmentMain',
            targets: Array.from({ length: 4 }, () => ({
              format: GBUFFER_FORMAT,
              blend: {
                color: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
                alpha: {
                  srcFactor: 'one',
                  dstFactor: 'one-minus-src-alpha',
                  operation: 'add',
                },
              },
            })),
          },
          primitive: {
            topology: 'triangle-list',
            cullMode: 'none',
          },
        });
        const compositeShaderModule = device.createShaderModule({ code: COMPOSITE_SHADER });
        await assertShaderModule(compositeShaderModule, 'Ref-Gaussian surfel composite');
        const compositePipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: compositeShaderModule,
            entryPoint: 'vertexMain',
          },
          fragment: {
            module: compositeShaderModule,
            entryPoint: 'fragmentMain',
            targets: [{ format: presentationFormat }],
          },
          primitive: {
            topology: 'triangle-list',
            cullMode: 'none',
          },
        });

        const instanceBufferSize = positions.rowCount * INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
        const instanceBuffer = device.createBuffer({
          size: instanceBufferSize,
          usage: GPU_BUFFER_VERTEX | GPU_BUFFER_COPY_DST,
        });
        const uniformBuffer = device.createBuffer({
          size: 64 * Float32Array.BYTES_PER_ELEMENT,
          usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
        });
        const visibilityProxyBuffer = device.createBuffer({
          size: Math.max(visibilityProxy.data.byteLength, VISIBILITY_PROXY_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT),
          usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
        });
        device.queue.writeBuffer(visibilityProxyBuffer, 0, visibilityProxy.data);
        const visibilityTriangleBuffer = device.createBuffer({
          size: Math.max(visibilityMesh?.triangles.byteLength || 0, VISIBILITY_TRIANGLE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT),
          usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
        });
        if (visibilityMesh?.triangles.byteLength) {
          device.queue.writeBuffer(visibilityTriangleBuffer, 0, visibilityMesh.triangles);
        }
        const visibilityBvhNodeBuffer = device.createBuffer({
          size: Math.max(visibilityMesh?.nodes.byteLength || 0, VISIBILITY_BVH_NODE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT),
          usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
        });
        if (visibilityMesh?.nodes.byteLength) {
          device.queue.writeBuffer(visibilityBvhNodeBuffer, 0, visibilityMesh.nodes);
        }
        const envTexture = device.createTexture({
          size: {
            width: envTextureSource.width,
            height: envTextureSource.height,
            depthOrArrayLayers: 6,
          },
          dimension: '2d',
          mipLevelCount: envTextureSource.levels.length,
          format: 'rgba32float',
          usage: GPU_TEXTURE_COPY_DST | GPU_TEXTURE_BINDING,
        });
        envTextureSource.levels.forEach((level, mipLevel) => {
          device.queue.writeTexture(
            { texture: envTexture, mipLevel },
            level.data,
            {
              bytesPerRow: level.width * 4 * Float32Array.BYTES_PER_ELEMENT,
              rowsPerImage: level.height,
            },
            {
              width: level.width,
              height: level.height,
              depthOrArrayLayers: 6,
            },
          );
        });
        const bsdfTexture = device.createTexture({
          size: {
            width: bsdfTextureSource.width,
            height: bsdfTextureSource.height,
            depthOrArrayLayers: 1,
          },
          dimension: '2d',
          format: 'rgba32float',
          usage: GPU_TEXTURE_COPY_DST | GPU_TEXTURE_BINDING,
        });
        device.queue.writeTexture(
          { texture: bsdfTexture },
          bsdfTextureSource.data,
          {
            bytesPerRow: bsdfTextureSource.width * 4 * Float32Array.BYTES_PER_ELEMENT,
            rowsPerImage: bsdfTextureSource.height,
          },
          {
            width: bsdfTextureSource.width,
            height: bsdfTextureSource.height,
            depthOrArrayLayers: 1,
          },
        );
        gbufferBindGroup = device.createBindGroup({
          layout: gbufferPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
          ],
        });

        const rebuildRenderTargets = () => {
          gBaseTexture?.destroy?.();
          gNormalTexture?.destroy?.();
          gMaterialTexture?.destroy?.();
          gIndirectTexture?.destroy?.();
          const targetSize = {
            width: Math.max(canvas.width, 1),
            height: Math.max(canvas.height, 1),
            depthOrArrayLayers: 1,
          };
          const usage = GPU_TEXTURE_RENDER_ATTACHMENT | GPU_TEXTURE_BINDING;
          gBaseTexture = device.createTexture({ size: targetSize, format: GBUFFER_FORMAT, usage });
          gNormalTexture = device.createTexture({ size: targetSize, format: GBUFFER_FORMAT, usage });
          gMaterialTexture = device.createTexture({ size: targetSize, format: GBUFFER_FORMAT, usage });
          gIndirectTexture = device.createTexture({ size: targetSize, format: GBUFFER_FORMAT, usage });
          compositeBindGroup = device.createBindGroup({
            layout: compositePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: gBaseTexture.createView() },
              { binding: 2, resource: gNormalTexture.createView() },
              { binding: 3, resource: gMaterialTexture.createView() },
              { binding: 4, resource: gIndirectTexture.createView() },
              { binding: 5, resource: envTexture.createView({ dimension: '2d-array', arrayLayerCount: 6 }) },
              { binding: 6, resource: bsdfTexture.createView({ dimension: '2d' }) },
              { binding: 7, resource: { buffer: visibilityProxyBuffer } },
              { binding: 8, resource: { buffer: visibilityTriangleBuffer } },
              { binding: 9, resource: { buffer: visibilityBvhNodeBuffer } },
            ],
          });
        };
        rebuildRenderTargets();

        const computeEye = (): Vec3 => [
          cameraState.target[0] + Math.cos(cameraState.pitch) * Math.sin(cameraState.yaw) * cameraState.radius,
          cameraState.target[1] + Math.sin(cameraState.pitch) * cameraState.radius,
          cameraState.target[2] + Math.cos(cameraState.pitch) * Math.cos(cameraState.yaw) * cameraState.radius,
        ];
        const currentEye = () => activeNativeCameraView?.eye || computeEye();
        const currentForward = () => activeNativeCameraView?.forward || normalizeVec3(subtractVec3(cameraState.target, computeEye()));

        const updateUniforms = () => {
          const width = Math.max(canvas.width, 1);
          const height = Math.max(canvas.height, 1);
          const eye = currentEye();
          const view = activeNativeCameraView?.view || mat4LookAt(eye, cameraState.target, [0, 1, 0]);
          const projection = activeNativeCameraView
            ? mat4PerspectiveFromIntrinsics(activeNativeCameraView.intrinsics, width, height, cameraState.near, cameraState.far)
            : mat4Perspective(Math.PI / 3, width / height, cameraState.near, cameraState.far);
          const viewProj = mat4Multiply(projection, view);
          const invViewProj = mat4Invert(viewProj);
          const uniformData = new Float32Array(64);
          const settings = renderSettingsRef.current;
          const modeIndex = ['material', 'color', 'reflection', 'alpha', 'scale'].indexOf(settings.mode);
          uniformData.set(viewProj, 0);
          uniformData.set(view, 16);
          uniformData.set(invViewProj, 32);
          uniformData.set([eye[0], eye[1], eye[2], 1], 48);
          uniformData.set([settings.exposure, settings.splatScale, settings.opacity, settings.reflection], 52);
          uniformData.set([Math.max(modeIndex, 0), cameraState.near, cameraState.far, envTextureSource.levels.length], 56);
          uniformData.set([width, height, visibilityProxy.count, visibilityMesh?.nodeCount || 0], 60);
          device.queue.writeBuffer(uniformBuffer, 0, uniformData);
          return eye;
        };

        const uploadSortedInstances = () => {
          const eye = currentEye();
          const forward = currentForward();
          const sortedIndices = sortBackToFront(normalizedPositions, eye, forward, positions.rowCount);
          const instanceData = buildInstanceData({
            sortedIndices,
            normalizedPositions,
            sceneScale: bounds.scale,
            arrays,
            eye,
          });
          device.queue.writeBuffer(instanceBuffer, 0, instanceData);
          needsSortUpload = false;
          lastSortMs = performance.now();
          setStatus(`Rendering ${positions.rowCount.toLocaleString()} sorted Gaussian surfels with deferred allmap shading.`);
        };

        setStats({
          renderedGaussians: positions.rowCount,
          totalGaussians: loadedMetadata.pointCount,
          sortMode: positions.rowCount <= EXACT_SORT_LIMIT
            ? `exact CPU back-to-front alpha order${bounded ? ' (bounded subset)' : ''}`
            : `${SORT_BUCKET_COUNT}-bucket CPU back-to-front alpha order${bounded ? ' (bounded subset)' : ''}`,
          pbrMode: arrays.reflectionStrength && arrays.roughness
            ? `Deferred render_surfel-style allmap shading with corrected ${arrays.shRest ? 'degree-3 SH' : 'SH-DC'} surface color; native EnvLight mip + FG LUT available for reflection mode`
            : `Corrected ${arrays.shRest ? 'degree-3 SH' : 'SH-DC/original'} surface color with opacity splatting`,
          reflectionMode: envTextureSource.source === 'native-envlight-base'
            ? `${visibilityMesh ? `Local visibility mesh BVH (${visibilityMesh.triangleCount.toLocaleString()} triangles, ${visibilityMesh.nodeCount.toLocaleString()} nodes)` : `Local Gaussian visibility proxy (${visibilityProxy.count.toLocaleString()} surfels)`} with screen-space fallback, ${envTextureSource.levels.length} native cubemap mips${bsdfTextureSource.source === 'native-fg-lut' ? ' and native FG LUT' : ' and fallback FG LUT'}`
            : 'Neutral fallback EnvLight; native cubemap not exported in this bundle',
          runtimeAssets: [
            runtimeAssets.bundleBinUrl ? 'bundle bin' : null,
            runtimeAssets.nativeBsdfLutUrl ? 'FG LUT' : null,
            visibilityMesh ? 'visibility BVH' : (runtimeAssets.visibilityGeometryUrl ? 'visibility geometry unavailable/point-only' : (runtimeAssets.sourcePlyUrl ? 'PLY geometry' : null)),
            runtimeAssets.environmentSidecarUrls.length ? `${runtimeAssets.environmentSidecarUrls.length} sidecar map(s)` : null,
          ].filter(Boolean).join(', ') || 'bundle metadata only',
          parityRisk: loadedMetadata.omittedFields?.length
            ? `${loadedMetadata.omittedFields.length} omitted native field(s)/asset(s)`
            : 'no known omitted native fields in published bundle metadata',
        });

        uploadSortedInstances();

        const render = () => {
          if (disposed) return;
          updateUniforms();
          if (needsSortUpload && performance.now() - lastSortMs > 120) {
            uploadSortedInstances();
          }

          const commandEncoder = device.createCommandEncoder();
          const gbufferPass = commandEncoder.beginRenderPass({
            colorAttachments: [
              {
                view: gBaseTexture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
              {
                view: gNormalTexture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
              {
                view: gMaterialTexture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
              {
                view: gIndirectTexture.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          gbufferPass.setPipeline(gbufferPipeline);
          gbufferPass.setBindGroup(0, gbufferBindGroup);
          gbufferPass.setVertexBuffer(0, instanceBuffer);
          gbufferPass.draw(6, positions.rowCount);
          gbufferPass.end();

          const compositePass = commandEncoder.beginRenderPass({
            colorAttachments: [{
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0.01, g: 0.015, b: 0.03, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          compositePass.setPipeline(compositePipeline);
          compositePass.setBindGroup(0, compositeBindGroup);
          compositePass.draw(3, 1);
          compositePass.end();
          device.queue.submit([commandEncoder.finish()]);
          animationFrameId = window.requestAnimationFrame(render);
        };

        const handleResize = () => {
          configureCanvas();
          rebuildRenderTargets();
        };
        const handlePointerDown = (event: PointerEvent) => {
          activeNativeCameraView = null;
          dragState.active = true;
          dragState.x = event.clientX;
          dragState.y = event.clientY;
          dragState.mode = event.button === 1 || event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
          canvas.focus();
          canvas.setPointerCapture(event.pointerId);
        };
        const handlePointerMove = (event: PointerEvent) => {
          if (!dragState.active) return;
          const dx = event.clientX - dragState.x;
          const dy = event.clientY - dragState.y;
          dragState.x = event.clientX;
          dragState.y = event.clientY;
          if (dragState.mode === 'pan') {
            const eye = computeEye();
            const { right, up } = cameraAxes(eye, cameraState.target);
            const panScale = Math.max(cameraState.radius, 0.08) * 0.0016;
            cameraState.target = addVec3(
              addVec3(cameraState.target, scaleVec3(right, -dx * panScale)),
              scaleVec3(up, dy * panScale),
            );
          } else {
            cameraState.yaw -= dx * 0.006;
            cameraState.pitch = clamp(cameraState.pitch - dy * 0.006, -1.35, 1.35);
          }
          needsSortUpload = true;
        };
        const handlePointerUp = (event: PointerEvent) => {
          dragState.active = false;
          try {
            canvas.releasePointerCapture(event.pointerId);
          } catch {
            // Pointer capture may already be released by the browser.
          }
        };
        const handleWheel = (event: WheelEvent) => {
          event.preventDefault();
          activeNativeCameraView = null;
          const dollyFactor = Math.exp(event.deltaY * 0.0016);
          cameraState.radius = clamp(cameraState.radius * dollyFactor, 0.006, 18);
          needsSortUpload = true;
        };
        const handleDoubleClick = () => {
          applyPreset('visible');
        };
        const handleContextMenu = (event: MouseEvent) => event.preventDefault();
        const handleKeyDown = (event: KeyboardEvent) => {
          const key = event.key.toLowerCase();
          if (!['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
            return;
          }
          event.preventDefault();
          activeNativeCameraView = null;
          const eye = computeEye();
          const { forward, right, up } = cameraAxes(eye, cameraState.target);
          const flatForward = normalizeVec3([forward[0], 0, forward[2]]);
          const step = Math.max(cameraState.radius * 0.08, 0.012) * (event.shiftKey ? 3 : 1);
          let delta: Vec3 = [0, 0, 0];
          if (key === 'w' || key === 'arrowup') delta = flatForward;
          if (key === 's' || key === 'arrowdown') delta = scaleVec3(flatForward, -1);
          if (key === 'a' || key === 'arrowleft') delta = scaleVec3(right, -1);
          if (key === 'd' || key === 'arrowright') delta = right;
          if (key === 'q') delta = scaleVec3(up, -1);
          if (key === 'e') delta = up;
          cameraState.target = addVec3(cameraState.target, scaleVec3(delta, step));
          needsSortUpload = true;
        };

        window.addEventListener('resize', handleResize);
        canvas.addEventListener('pointerdown', handlePointerDown);
        canvas.addEventListener('pointermove', handlePointerMove);
        canvas.addEventListener('pointerup', handlePointerUp);
        canvas.addEventListener('pointercancel', handlePointerUp);
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        canvas.addEventListener('dblclick', handleDoubleClick);
        canvas.addEventListener('contextmenu', handleContextMenu);
        canvas.addEventListener('keydown', handleKeyDown);
        cleanupHandlers.push(() => window.removeEventListener('resize', handleResize));
        cleanupHandlers.push(() => canvas.removeEventListener('pointerdown', handlePointerDown));
        cleanupHandlers.push(() => canvas.removeEventListener('pointermove', handlePointerMove));
        cleanupHandlers.push(() => canvas.removeEventListener('pointerup', handlePointerUp));
        cleanupHandlers.push(() => canvas.removeEventListener('pointercancel', handlePointerUp));
        cleanupHandlers.push(() => canvas.removeEventListener('wheel', handleWheel));
        cleanupHandlers.push(() => canvas.removeEventListener('dblclick', handleDoubleClick));
        cleanupHandlers.push(() => canvas.removeEventListener('contextmenu', handleContextMenu));
        cleanupHandlers.push(() => canvas.removeEventListener('keydown', handleKeyDown));

        render();
      } catch (err) {
        console.error('Ref-Gaussian WebGPU renderer failed:', err);
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load Ref-Gaussian WebGPU renderer');
          setStatus('WebGPU renderer unavailable.');
        }
      }
    };

    run();

    return () => {
      disposed = true;
      cameraControllerRef.current = null;
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      cleanupHandlers.forEach((handler) => handler());
      device?.destroy?.();
    };
  }, [artifacts]);

  const capabilitySummary = useMemo(() => {
    const arrays = metadataArrayNames(metadata);
    const missing = [];
    if (!arrays.includes('logScale')) missing.push('scale');
    if (!arrays.includes('rotation')) missing.push('rotation');
    if (!arrays.includes('opacityLogit')) missing.push('opacity');
    const nativeState = (metadata as any)?.nativeRendererState;
    if (!arrays.includes('envMap1Base')) missing.push('EnvLight.base cubemap');
    if (nativeState?.normalStatus === 'available_all_zero') missing.push('nonzero normals');
    return {
      arrays,
      missing,
      hasPbrFields: ['reflectionStrength', 'roughness', 'metalness'].some((field) => arrays.includes(field)),
      hasIndirectFields: ['indirectDc', 'indirectRest', 'indirectAsg'].some((field) => arrays.includes(field)),
      environmentAvailable: Boolean(metadata?.environmentLighting?.available),
      envMapExported: arrays.includes('envMap1Base'),
      environmentFileCount: metadata?.environmentLighting?.files?.length || 0,
      scaleMode: nativeState?.scaleMode || 'unknown',
      normalStatus: nativeState?.normalStatus || 'unknown',
    };
  }, [metadata]);

  return (
    <div className="w-full h-full relative bg-slate-950 text-white">
      <canvas ref={canvasRef} tabIndex={0} className="w-full h-full block outline-none" />
      <div className="absolute left-4 top-4 max-w-lg rounded-xl border border-white/10 bg-slate-950/85 p-4 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold">WebGPU Ref-Gaussian Renderer</h3>
          <span className={`rounded-full px-2 py-0.5 text-xs ${webgpuActive ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200'}`}>
            {webgpuActive ? 'WebGPU active' : 'Detecting'}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-300">{status}</p>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        {metadata && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
            <span>Total Gaussians</span>
            <span className="text-right text-white">{metadata.pointCount.toLocaleString()}</span>
            <span>Rendered Splats</span>
            <span className="text-right text-white">{stats?.renderedGaussians.toLocaleString() || 'loading'}</span>
            <span>Checkpoint Iteration</span>
            <span className="text-right text-white">{metadata.source?.actualIteration ?? 'unknown'}</span>
            <span>Camera Calibration</span>
            <span className="text-right text-white">{metadata.cameraCalibration?.available ? 'available' : 'missing'}</span>
          </div>
        )}
        {stats && (
          <div className="mt-3 space-y-1 text-xs text-slate-300">
            <p>Geometry: instanced anisotropic Gaussian quads from positions, log scales, rotations, and opacity logits.</p>
            <p>Alpha: {stats.sortMode}.</p>
            <p>PBR: {stats.pbrMode}; indirect DC terms are included when present.</p>
            <p>Reflection: {stats.reflectionMode}.</p>
            <p>Runtime assets: {stats.runtimeAssets}.</p>
            <p>Parity risk: {stats.parityRisk}.</p>
            {artifacts.viewerUrl && (
              <p>
                <a className="text-cyan-200 underline-offset-2 hover:underline" href={artifacts.viewerUrl} target="_blank" rel="noreferrer">
                  Open Native Render Gallery
                </a>
              </p>
            )}
          </div>
        )}
        {metadata && (
          <div className="mt-3 space-y-3 border-t border-white/10 pt-3 text-xs">
            <div>
              <div className="mb-1 text-slate-400">Camera presets</div>
              <div className="flex flex-wrap gap-2">
                {[
                  ['recenter', 'Recenter'],
                  ['visible', 'Center Visible'],
                  ['overview', 'Overview'],
                  ['mirror', 'Vanity/Mirror'],
                  ['interior', 'Enter Room'],
                  ['native0', 'Native Camera 0'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className="rounded bg-cyan-500/15 px-2 py-1 text-cyan-100 hover:bg-cyan-500/25"
                    onClick={() => cameraControllerRef.current?.setPreset(id as 'overview' | 'mirror' | 'interior' | 'native0' | 'recenter' | 'visible')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-slate-500">Drag to orbit, Shift/right-drag to pan, wheel to dolly inside, double-click to center visible splats, WASD/QE to walk after clicking the canvas.</p>
            </div>
            <div>
              <div className="mb-1 text-slate-400">Render mode</div>
              <div className="flex flex-wrap gap-2">
                {[
                  ['material', 'Material Approx'],
                  ['color', 'Color Only'],
                  ['reflection', 'Reflection Approx'],
                  ['alpha', 'Alpha Debug'],
                  ['scale', 'Scale Debug'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`rounded px-2 py-1 ${renderMode === id ? 'bg-emerald-500/25 text-emerald-100' : 'bg-white/10 text-slate-200 hover:bg-white/15'}`}
                    onClick={() => setRenderMode(id as RenderMode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-[92px_1fr_42px] items-center gap-2 text-slate-300">
              <label htmlFor="refg-exposure">Exposure</label>
              <input id="refg-exposure" type="range" min="0.4" max="2.6" step="0.05" value={exposure} onChange={(event) => setExposure(Number(event.target.value))} />
              <span className="text-right text-white">{exposure.toFixed(2)}</span>
              <label htmlFor="refg-opacity">Opacity</label>
              <input id="refg-opacity" type="range" min="0.03" max="0.65" step="0.01" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
              <span className="text-right text-white">{opacity.toFixed(2)}</span>
              <label htmlFor="refg-scale">Splat scale</label>
              <input id="refg-scale" type="range" min="0.08" max="1.1" step="0.02" value={splatScale} onChange={(event) => setSplatScale(Number(event.target.value))} />
              <span className="text-right text-white">{splatScale.toFixed(2)}</span>
              <label htmlFor="refg-reflect">Reflection</label>
              <input id="refg-reflect" type="range" min="0" max="1.8" step="0.05" value={reflection} onChange={(event) => setReflection(Number(event.target.value))} />
              <span className="text-right text-white">{reflection.toFixed(2)}</span>
            </div>
          </div>
        )}
        {metadata && (
          <div className="mt-3 space-y-2 text-xs text-slate-400">
            <p>
              Native parity blockers: {capabilitySummary.missing.length ? capabilitySummary.missing.join(', ') : 'native shader equations only'}.
              Environment previews discovered: {capabilitySummary.environmentAvailable ? capabilitySummary.environmentFileCount : 0};
              EnvLight tensor exported: {capabilitySummary.envMapExported ? 'yes' : 'no'}.
              Native Ref-Gaussian scale mode: {capabilitySummary.scaleMode}; two learned surfel axes plus unit normal axis is expected upstream.
              Remaining fidelity gap is the CUDA surfel rasterizer allmap plus nvdiffrast FG LUT/mip/raytraced indirect equations.
            </p>
            <p>
              Fields: {capabilitySummary.arrays.join(', ')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RefGaussianWebGPUViewer;
