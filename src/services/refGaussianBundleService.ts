export interface RefGaussianBundleArray {
  name: string;
  kind: 'array' | 'raw_file';
  source?: string;
  properties?: string[];
  dtype?: string;
  shape?: number[];
  offset: number;
  byteLength: number;
  description?: string;
}

export interface RefGaussianBundleRawFile {
  name: string;
  kind: 'raw_file';
  source?: string;
  path: string;
  format?: string;
  offset: number;
  byteLength: number;
  sha256?: string;
}

export type RefGaussianBundleEntry = RefGaussianBundleArray | RefGaussianBundleRawFile;

export interface RefGaussianRuntimeAssetUrls {
  bundleJsonUrl: string | null;
  bundleBinUrl: string | null;
  nativeRenderContractManifestUrl: string | null;
  nativeBsdfLutUrl: string | null;
  sourcePlyUrl: string | null;
  visibilityGeometryUrl: string | null;
  environmentSidecarUrls: string[];
}

export interface RefGaussianBundleMetadata {
  schemaVersion: number;
  format: string;
  binary: {
    path: string;
    fileName?: string;
    byteLength: number;
    sha256?: string;
  };
  source?: {
    actualIteration?: number;
    requestedIterations?: number;
    sourcePlyPath?: string;
  };
  pointCount: number;
  arrays: RefGaussianBundleArray[];
  cameraCalibration?: {
    available?: boolean;
    cameraCount?: number;
    imageCount?: number;
    cameras?: unknown[];
    images?: unknown[];
    reason?: string | null;
  };
  environmentLighting?: {
    available?: boolean;
    files?: string[];
    sidecarMaps?: RefGaussianBundleRawFile[];
    exportedArrays?: string[];
    omitted?: unknown[];
  };
  nativeRendererState?: unknown;
  nativeRendererContract?: unknown;
  omittedFields?: Array<{ name?: string; reason?: string; [key: string]: unknown }>;
  referenceRenderer?: {
    status?: string;
    reason?: string;
    nativeRenderDependencies?: string[];
  };
}

export interface RefGaussianArtifacts {
  applied?: boolean;
  pointCount?: number;
  method?: string | null;
  renderMode?: string;
  trainingMaskMode?: string;
  summaryUrl?: string;
  splatUrl?: string;
  plyUrl?: string;
  viewerUrl?: string;
  bundleJsonUrl?: string;
  bundleBinUrl?: string;
  nativeRenderContractUrl?: string;
  nativeRenderContractManifestUrl?: string;
  visibilityGeometryUrl?: string;
  visibilityGeometryPath?: string;
  nativeRender?: unknown;
  cleanupSummary?: unknown;
  bundle?: unknown;
}

export interface RefGaussianMeshHybridArtifacts {
  summaryUrl?: string;
  texturedObjUrl?: string;
  mtlUrl?: string;
  textureUrl?: string;
  numVertices?: number;
  numFaces?: number;
  pointCount?: number;
  method?: string;
}

export interface RefGaussianArraySlice {
  descriptor: RefGaussianBundleArray;
  data: Float32Array;
  rowCount: number;
  componentCount: number;
}

export interface RefGaussianFloat32Array {
  descriptor: RefGaussianBundleArray;
  data: Float32Array;
}

export async function fetchRefGaussianBundleMetadata(
  bundleJsonUrl: string,
): Promise<RefGaussianBundleMetadata> {
  const response = await fetch(bundleJsonUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load Ref-Gaussian bundle metadata (${response.status})`);
  }
  return response.json() as Promise<RefGaussianBundleMetadata>;
}

export function resolveRefGaussianBundleBinUrl(
  bundleJsonUrl: string,
  metadata: RefGaussianBundleMetadata,
  explicitBundleBinUrl?: string,
): string {
  if (explicitBundleBinUrl) {
    return explicitBundleBinUrl;
  }

  const binaryPath = metadata.binary?.path || metadata.binary?.fileName;
  if (!binaryPath) {
    throw new Error('Ref-Gaussian bundle metadata is missing binary.path');
  }

  return new URL(binaryPath, new URL(bundleJsonUrl, window.location.href)).toString();
}

export function getRefGaussianArray(
  metadata: RefGaussianBundleMetadata,
  arrayName: string,
): RefGaussianBundleArray | null {
  return metadata.arrays.find((array) => array.kind === 'array' && array.name === arrayName) || null;
}

export function getRefGaussianRawFile(
  metadata: RefGaussianBundleMetadata,
  fileName: string,
): RefGaussianBundleRawFile | null {
  return (
    metadata.arrays.find((entry) => entry.kind === 'raw_file' && entry.name === fileName && 'path' in entry)
      || null
  ) as RefGaussianBundleRawFile | null;
}

export function resolveRefGaussianRelativeUrl(
  baseUrl: string,
  relativePath: string,
): string {
  return new URL(relativePath, new URL(baseUrl, window.location.href)).toString();
}

export function resolveRefGaussianRawFileUrl(
  bundleJsonUrl: string,
  metadata: RefGaussianBundleMetadata,
  fileName: string,
): string | null {
  const entry = getRefGaussianRawFile(metadata, fileName);
  if (!entry?.path) {
    return null;
  }
  return resolveRefGaussianRelativeUrl(bundleJsonUrl, entry.path);
}

export function listRefGaussianRuntimeAssets(
  artifacts: RefGaussianArtifacts,
  metadata: RefGaussianBundleMetadata | null,
): RefGaussianRuntimeAssetUrls {
  const bundleJsonUrl = artifacts.bundleJsonUrl || null;
  const nativeRenderContractManifestUrl = artifacts.nativeRenderContractManifestUrl || artifacts.nativeRenderContractUrl || null;
  const nativeBsdfLutUrl = nativeRenderContractManifestUrl
    ? resolveRefGaussianRelativeUrl(nativeRenderContractManifestUrl, 'assets/bsdf_256_256.bin')
    : null;
  const environmentSidecarUrls = bundleJsonUrl && metadata
    ? (metadata.environmentLighting?.sidecarMaps || [])
      .map((entry) => resolveRefGaussianRelativeUrl(bundleJsonUrl, entry.path))
    : [];

  return {
    bundleJsonUrl,
    bundleBinUrl: bundleJsonUrl && metadata
      ? resolveRefGaussianBundleBinUrl(bundleJsonUrl, metadata, artifacts.bundleBinUrl)
      : (artifacts.bundleBinUrl || null),
    nativeRenderContractManifestUrl,
    nativeBsdfLutUrl,
    sourcePlyUrl: artifacts.plyUrl || null,
    visibilityGeometryUrl: artifacts.visibilityGeometryUrl || artifacts.plyUrl || null,
    environmentSidecarUrls,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Best effort: the important part is that callers do not read a full binary body.
  }
}

export async function fetchRefGaussianFloat32ArraySlice({
  bundleJsonUrl,
  bundleBinUrl,
  metadata,
  arrayName,
  maxRows,
}: {
  bundleJsonUrl: string;
  bundleBinUrl?: string;
  metadata: RefGaussianBundleMetadata;
  arrayName: string;
  maxRows: number;
}): Promise<RefGaussianArraySlice> {
  const descriptor = getRefGaussianArray(metadata, arrayName);
  if (!descriptor || !descriptor.shape || descriptor.shape.length < 2) {
    throw new Error(`Ref-Gaussian array not available: ${arrayName}`);
  }
  if (descriptor.dtype && descriptor.dtype !== 'float32') {
    throw new Error(`Unsupported Ref-Gaussian array dtype for ${arrayName}: ${descriptor.dtype}`);
  }

  const rowCount = Math.min(Math.max(1, maxRows), descriptor.shape[0] || 0);
  const componentCount = descriptor.shape[1] || 1;
  const byteLength = rowCount * componentCount * Float32Array.BYTES_PER_ELEMENT;
  const start = descriptor.offset;
  const end = start + byteLength - 1;
  const resolvedBundleBinUrl = resolveRefGaussianBundleBinUrl(bundleJsonUrl, metadata, bundleBinUrl);

  const headResponse = await fetch(resolvedBundleBinUrl, {
    method: 'HEAD',
    cache: 'no-store',
  });
  if (headResponse.ok) {
    const acceptRanges = headResponse.headers.get('Accept-Ranges') || '';
    if (!acceptRanges.toLowerCase().includes('bytes')) {
      console.warn(
        'The Ref-Gaussian binary artifact endpoint did not advertise byte-range support on HEAD; ' +
        'continuing with a GET Range probe.'
      );
    }
  }

  const response = await fetch(resolvedBundleBinUrl, {
    headers: {
      Range: `bytes=${start}-${end}`,
    },
    cache: 'no-store',
  });

  if (response.status !== 206) {
    await cancelResponseBody(response);
    throw new Error(
      `Failed to load ${arrayName} as a byte-range slice (${response.status}). ` +
      'The endpoint must return 206 Partial Content for .refgaussian.bin previews.'
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength !== byteLength) {
    throw new Error(
      `Unexpected ${arrayName} byte length: expected ${byteLength}, received ${arrayBuffer.byteLength}. ` +
      'The artifact route may not support byte ranges for .refgaussian.bin yet.'
    );
  }

  return {
    descriptor,
    data: new Float32Array(arrayBuffer),
    rowCount,
    componentCount,
  };
}

export async function fetchRefGaussianFloat32Array({
  bundleJsonUrl,
  bundleBinUrl,
  metadata,
  arrayName,
}: {
  bundleJsonUrl: string;
  bundleBinUrl?: string;
  metadata: RefGaussianBundleMetadata;
  arrayName: string;
}): Promise<RefGaussianFloat32Array> {
  const descriptor = getRefGaussianArray(metadata, arrayName);
  if (!descriptor || descriptor.kind !== 'array') {
    throw new Error(`Ref-Gaussian array not available: ${arrayName}`);
  }
  if (descriptor.dtype && descriptor.dtype !== 'float32') {
    throw new Error(`Unsupported Ref-Gaussian array dtype for ${arrayName}: ${descriptor.dtype}`);
  }

  const resolvedBundleBinUrl = resolveRefGaussianBundleBinUrl(bundleJsonUrl, metadata, bundleBinUrl);
  const start = descriptor.offset;
  const end = descriptor.offset + descriptor.byteLength - 1;
  const response = await fetch(resolvedBundleBinUrl, {
    headers: {
      Range: `bytes=${start}-${end}`,
    },
    cache: 'no-store',
  });
  if (response.status !== 206) {
    await cancelResponseBody(response);
    throw new Error(`Failed to load ${arrayName} as a byte-range array (${response.status}).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength !== descriptor.byteLength) {
    throw new Error(`Unexpected ${arrayName} byte length: expected ${descriptor.byteLength}, received ${arrayBuffer.byteLength}.`);
  }
  return {
    descriptor,
    data: new Float32Array(arrayBuffer),
  };
}

export function hasRefGaussianArray(metadata: RefGaussianBundleMetadata | null, arrayName: string): boolean {
  return Boolean(metadata && getRefGaussianArray(metadata, arrayName));
}
