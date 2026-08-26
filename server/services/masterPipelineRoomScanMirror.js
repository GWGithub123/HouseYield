import fsPromises from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const ROOM_SCANS_DIR = path.join(process.cwd(), 'server', 'data', 'room-scans');
const MASTER_PIPELINE_DATA_DIR = process.env.MASTER_PIPELINE_DATA_DIR || path.join(process.cwd(), 'server', 'data', 'master-jobs');
const IMAGE_FILE_PATTERN = /\.(jpe?g|png|webp|heic|heif)$/i;
const FEET_PER_METER = 3.28084;
const SQFT_PER_SQM = 10.7639;
const MASTER_JOB_ARTIFACT_DIRS = [
  'appearance',
  'calibration',
  'dense_evidence',
  'export',
  'frames',
  'gaussian',
  'input',
  'layout',
  'logs',
  'mesh',
  'outputs',
  'priors',
  'refgaussian_mesh_hybrid',
  'sfm',
  'texture',
];
const MASTER_JOB_ARTIFACT_FILES = [
  'job.json',
  'status.json',
  'error_report.json',
];

function formatIsoTimestampForId(value) {
  const candidate = new Date(value || Date.now());
  const safeDate = Number.isFinite(candidate.getTime()) ? candidate : new Date();
  return safeDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function resolveRoomScanTarget(job) {
  const priorRoomScanId = typeof job.metadata?.roomScanId === 'string'
    ? job.metadata.roomScanId.trim()
    : '';
  const publishTimestamp = job.metadata?.completedAt || new Date().toISOString();

  if (job.metadata?.roomScanMirrorStatus === 'completed' && priorRoomScanId) {
    return {
      roomScanId: `${job.id}_publish_${formatIsoTimestampForId(publishTimestamp)}`,
      createdAt: publishTimestamp,
      sourceRoomScanId: priorRoomScanId,
    };
  }

  return {
    roomScanId: priorRoomScanId || job.id,
    createdAt: job.createdAt || publishTimestamp,
    sourceRoomScanId: null,
  };
}

async function fileExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(targetPath) {
  if (!await fileExists(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(await fsPromises.readFile(targetPath, 'utf8'));
  } catch {
    return null;
  }
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!sourcePath || !await fileExists(sourcePath)) {
    return false;
  }

  await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fsPromises.copyFile(sourcePath, destinationPath);
  return true;
}

async function copyDirectoryIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !await fileExists(sourcePath)) {
    return false;
  }

  await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fsPromises.rm(destinationPath, { recursive: true, force: true });
  await fsPromises.cp(sourcePath, destinationPath, { recursive: true, force: true });
  return true;
}

async function mirrorFullArtifactBundle(jobDir, artifactsDir) {
  const artifactBundleDir = path.join(artifactsDir, 'master_job');
  await fsPromises.mkdir(artifactBundleDir, { recursive: true });

  for (const filename of MASTER_JOB_ARTIFACT_FILES) {
    await copyIfPresent(
      path.join(jobDir, filename),
      path.join(artifactBundleDir, filename),
    );
  }

  for (const directoryName of MASTER_JOB_ARTIFACT_DIRS) {
    await copyDirectoryIfExists(
      path.join(jobDir, directoryName),
      path.join(artifactBundleDir, directoryName),
    );
  }

  return {
    rootPath: 'artifacts/master_job',
    rootUrl: null,
  };
}

function toFiniteNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function resolveGaussianPointCount(gaussianSummary) {
  const candidates = [
    gaussianSummary?.pointCount,
    gaussianSummary?.gaussianPointCount,
    gaussianSummary?.scenePointCount,
    gaussianSummary?.initPointCount,
    gaussianSummary?.metric3dInitPointCount,
    gaussianSummary?.sparsePointCount,
    gaussianSummary?.selectedPointCount,
    gaussianSummary?.candidatePointCount,
    gaussianSummary?.metric3dCandidatePointCount,
  ];

  for (const value of candidates) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }

  return 0;
}

function buildRoomDimensions(bounds) {
  if (!bounds?.min || !bounds?.max || bounds.min.length < 3 || bounds.max.length < 3) {
    return {};
  }

  const width = Math.max(0, toFiniteNumber(bounds.max[0]) - toFiniteNumber(bounds.min[0]));
  const height = Math.max(0, toFiniteNumber(bounds.max[1]) - toFiniteNumber(bounds.min[1]));
  const length = Math.max(0, toFiniteNumber(bounds.max[2]) - toFiniteNumber(bounds.min[2]));
  const area = width * length;
  const volume = area * height;

  return {
    width,
    length,
    height,
    area,
    volume,
    widthFeet: width * FEET_PER_METER,
    lengthFeet: length * FEET_PER_METER,
    heightFeet: height * FEET_PER_METER,
    floorAreaSqM: area,
    floorAreaSqFt: area * SQFT_PER_SQM,
  };
}

async function findThumbnailSource(job) {
  const candidateDirectories = [
    job.capture?.selectedFramesDir,
    job.capture?.imagesDir,
  ].filter(Boolean);

  for (const directory of candidateDirectories) {
    const filenames = await fsPromises.readdir(directory).catch(() => []);
    const imageName = filenames.find((filename) => IMAGE_FILE_PATTERN.test(filename));
    if (imageName) {
      return path.join(directory, imageName);
    }
  }

  return null;
}

async function writeThumbnail(job, roomScanDir) {
  const thumbnailSource = await findThumbnailSource(job);
  if (!thumbnailSource) {
    return null;
  }

  const thumbnailPath = path.join(roomScanDir, 'thumbnail.jpg');

  try {
    await sharp(thumbnailSource)
      .resize(400, null, { withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(thumbnailPath);
    return 'thumbnail.jpg';
  } catch {
    try {
      await fsPromises.copyFile(thumbnailSource, thumbnailPath);
      return 'thumbnail.jpg';
    } catch {
      return null;
    }
  }
}

function calculateProcessingDurationSeconds(job) {
  const startedAt = Date.parse(job.createdAt || '');
  const completedAt = Date.parse(job.metadata?.completedAt || job.updatedAt || '');

  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return 0;
  }

  return Math.round((completedAt - startedAt) / 1000);
}

async function mirrorMasterJobToRoomScanner(job) {
  const roomScanTarget = resolveRoomScanTarget(job);
  const roomScanId = roomScanTarget.roomScanId;
  const roomScanDir = path.join(ROOM_SCANS_DIR, roomScanId);
  const modelDir = path.join(roomScanDir, 'model');
  const artifactsDir = path.join(roomScanDir, 'artifacts');
  const jobDir = path.join(MASTER_PIPELINE_DATA_DIR, job.id);

  await fsPromises.mkdir(modelDir, { recursive: true });
  await fsPromises.mkdir(artifactsDir, { recursive: true });

  const fullArtifactBundle = await mirrorFullArtifactBundle(jobDir, artifactsDir);
  fullArtifactBundle.rootUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_job/`;

  const exportSummary = await readJsonIfPresent(path.join(jobDir, 'export', 'qa', 'summary.json'));
  const qaReport = await readJsonIfPresent(path.join(jobDir, 'export', 'qa', 'qa_report.json'));
  const meshSummary = await readJsonIfPresent(path.join(jobDir, 'mesh', 'authoring', 'summary.json'));
  const detailMeshSummary = await readJsonIfPresent(path.join(jobDir, 'mesh', 'authoring', 'detail_mesh', 'summary.json'));
  const denseSummary = await readJsonIfPresent(path.join(jobDir, 'dense_evidence', 'summary.json'));
  const sfmSummary = await readJsonIfPresent(path.join(jobDir, 'sfm', 'global_sfm', 'summary.json'));
  const gaussianSummary = await readJsonIfPresent(path.join(jobDir, 'gaussian', 'splatting', 'summary.json'));
  const refGaussianMeshHybridSummary = await readJsonIfPresent(path.join(jobDir, 'refgaussian_mesh_hybrid', 'summary.json'));
  const gaussianOnlyPipeline = job.requestedProcessing?.inputOptions?.gaussianOnly === true
    || job.requestedProcessing?.inputOptions?.refGaussianOnly === true;
  const wantsGaussianViewer = job.metadata?.captureMode === 'room_tour'
    || job.requestedProcessing?.inputOptions?.captureMode === 'room_tour'
    || job.requestedProcessing?.inputOptions?.primaryOutputIntent === 'gaussian_splats'
    || job.requestedProcessing?.inputOptions?.requireGaussianSplatting === true;

  const finalMeshStats = qaReport?.sourceMeshStats || null;
  const finalBounds = finalMeshStats?.bounds || detailMeshSummary?.dimensions || meshSummary?.bounds;

  const copiedGlb = await copyIfPresent(
    path.join(jobDir, 'export', 'qa', 'model.optimized.glb'),
    path.join(modelDir, 'model.glb'),
  ) || await copyIfPresent(
    path.join(jobDir, 'export', 'qa', 'model.glb'),
    path.join(modelDir, 'model.glb'),
  );

  if (!copiedGlb && !(gaussianOnlyPipeline && wantsGaussianViewer && gaussianSummary)) {
    throw new Error('master_room_scan_glb_missing');
  }

  const copiedPly = await copyIfPresent(
    detailMeshSummary?.meshPath,
    path.join(modelDir, 'model.ply'),
  ) || await copyIfPresent(
    path.join(jobDir, 'mesh', 'authoring', 'shell_mesh.ply'),
    path.join(modelDir, 'model.ply'),
  ) || await copyIfPresent(
    path.join(jobDir, 'dense_evidence', 'fused_scene.ply'),
    path.join(modelDir, 'model.ply'),
  );

  const copiedQaReport = await copyIfPresent(
    path.join(jobDir, 'export', 'qa', 'qa_report.json'),
    path.join(artifactsDir, 'qa_report.json'),
  );

  const copiedExportSummary = await copyIfPresent(
    path.join(jobDir, 'export', 'qa', 'summary.json'),
    path.join(artifactsDir, 'master_export_summary.json'),
  );

  const gaussianArtifacts = {};
  const gaussianArtifactsDir = path.join(artifactsDir, 'master_gaussian');
  const refGaussianArtifacts = {};
  const refGaussianArtifactsDir = path.join(artifactsDir, 'master_ref_gaussian');
  const scaffoldGsArtifacts = {};
  const scaffoldGsArtifactsDir = path.join(artifactsDir, 'master_scaffold_gs');
  const meshBackendArtifacts = {};
  const meshBackendArtifactsDir = path.join(artifactsDir, 'master_metric3d_mesh');
  if (copiedGlb || meshSummary || denseSummary || exportSummary) {
    if (copiedGlb) {
      meshBackendArtifacts.glbPath = 'model/model.glb';
      meshBackendArtifacts.glbUrl = `/api/room-scanner/scans/${roomScanId}/model/model.glb`;
    }
    const copiedMeshBackendDenseSummary = await copyIfPresent(
      path.join(jobDir, 'dense_evidence', 'summary.json'),
      path.join(meshBackendArtifactsDir, 'dense_summary.json'),
    );
    if (copiedMeshBackendDenseSummary) {
      meshBackendArtifacts.denseSummaryPath = 'artifacts/master_metric3d_mesh/dense_summary.json';
      meshBackendArtifacts.denseSummaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_metric3d_mesh/dense_summary.json`;
    }
    const copiedMeshBackendMeshSummary = await copyIfPresent(
      path.join(jobDir, 'mesh', 'authoring', 'summary.json'),
      path.join(meshBackendArtifactsDir, 'mesh_summary.json'),
    );
    if (copiedMeshBackendMeshSummary) {
      meshBackendArtifacts.meshSummaryPath = 'artifacts/master_metric3d_mesh/mesh_summary.json';
      meshBackendArtifacts.meshSummaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_metric3d_mesh/mesh_summary.json`;
    }
    const copiedMeshBackendTextureSummary = await copyIfPresent(
      path.join(jobDir, 'texture', 'uv_initial_bake', 'summary.json'),
      path.join(meshBackendArtifactsDir, 'texture_summary.json'),
    );
    if (copiedMeshBackendTextureSummary) {
      meshBackendArtifacts.textureSummaryPath = 'artifacts/master_metric3d_mesh/texture_summary.json';
      meshBackendArtifacts.textureSummaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_metric3d_mesh/texture_summary.json`;
    }
    const copiedMeshBackendExportSummary = await copyIfPresent(
      path.join(jobDir, 'export', 'qa', 'summary.json'),
      path.join(meshBackendArtifactsDir, 'export_summary.json'),
    );
    if (copiedMeshBackendExportSummary) {
      meshBackendArtifacts.exportSummaryPath = 'artifacts/master_metric3d_mesh/export_summary.json';
      meshBackendArtifacts.exportSummaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_metric3d_mesh/export_summary.json`;
    }
    if (copiedPly) {
      meshBackendArtifacts.plyPath = 'model/model.ply';
      meshBackendArtifacts.plyUrl = `/api/room-scanner/scans/${roomScanId}/model/model.ply`;
    }
    meshBackendArtifacts.method = denseSummary?.patchMatchStereoSkipped
      ? 'roma_glomap_metric3d_fusion_poisson_openmvs_no_patchmatch'
      : 'master_v1_mesh_branch';
    meshBackendArtifacts.pointCount = toFiniteNumber(denseSummary?.pointCount, 0);
  }
  if (gaussianSummary) {
    const copiedGaussianSummary = await copyIfPresent(
      path.join(jobDir, 'gaussian', 'splatting', 'summary.json'),
      path.join(gaussianArtifactsDir, 'summary.json'),
    );
    if (copiedGaussianSummary) {
      gaussianArtifacts.summaryPath = 'artifacts/master_gaussian/summary.json';
      gaussianArtifacts.summaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_gaussian/summary.json`;
    }

    const copiedSceneSplat = await copyIfPresent(
      gaussianSummary.splatScenePath || path.join(jobDir, 'gaussian', 'splatting', 'native-output', 'scene.splat'),
      path.join(gaussianArtifactsDir, 'scene.splat'),
    );
    if (copiedSceneSplat) {
      gaussianArtifacts.splatPath = 'artifacts/master_gaussian/scene.splat';
      gaussianArtifacts.splatUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_gaussian/scene.splat`;
    }

    const copiedScenePly = await copyIfPresent(
      gaussianSummary.splatPlyPath || path.join(jobDir, 'gaussian', 'splatting', 'native-output', 'scene.ply'),
      path.join(gaussianArtifactsDir, 'scene.ply'),
    );
    if (copiedScenePly) {
      gaussianArtifacts.plyPath = 'artifacts/master_gaussian/scene.ply';
      gaussianArtifacts.plyUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_gaussian/scene.ply`;
    }

    const copiedViewer = await copyDirectoryIfExists(
      gaussianSummary.viewerHtmlPath ? path.dirname(gaussianSummary.viewerHtmlPath) : path.join(jobDir, 'gaussian', 'splatting', 'native-output', 'viewer'),
      path.join(gaussianArtifactsDir, 'viewer'),
    );
    if (copiedViewer) {
      gaussianArtifacts.viewerPath = 'artifacts/master_gaussian/viewer/index.html';
      gaussianArtifacts.viewerUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_gaussian/viewer/index.html`;
    }

    const mirrorGaussianSummary = gaussianSummary.mirrorGaussian || null;
    const copiedMirrorOverlaySplat = mirrorGaussianSummary?.overlaySplatScenePath
      ? await copyIfPresent(
        mirrorGaussianSummary.overlaySplatScenePath,
        path.join(gaussianArtifactsDir, 'mirror-overlay.splat'),
      )
      : null;
    if (copiedMirrorOverlaySplat) {
      gaussianArtifacts.mirrorOverlayPath = 'artifacts/master_gaussian/mirror-overlay.splat';
      gaussianArtifacts.mirrorOverlayUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_gaussian/mirror-overlay.splat`;
      gaussianArtifacts.mirrorGaussian = {
        applied: mirrorGaussianSummary.applied === true,
        pointCount: Number(mirrorGaussianSummary.overlayPointCount || 0),
        minOpacity: Number(mirrorGaussianSummary.overlayMinOpacity || 0),
        mirrorPlaneCount: Number(mirrorGaussianSummary.mirrorPlaneCount || 0),
        reason: mirrorGaussianSummary.reason || null,
        renderInViewer: false,
      };
    }

    const refGaussianSummary = gaussianSummary.refGaussian || null;
    const copiedRefGaussianSummary = refGaussianSummary?.applied
      ? await copyIfPresent(
        refGaussianSummary.resultPath || path.join(jobDir, 'gaussian', 'splatting', 'ref-gaussian', 'result.json'),
        path.join(refGaussianArtifactsDir, 'summary.json'),
      )
      : null;
    if (copiedRefGaussianSummary) {
      refGaussianArtifacts.summaryPath = 'artifacts/master_ref_gaussian/summary.json';
      refGaussianArtifacts.summaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/summary.json`;
    }

    const copiedRefGaussianSplat = refGaussianSummary?.splatScenePath
      ? await copyIfPresent(
        refGaussianSummary.splatScenePath,
        path.join(refGaussianArtifactsDir, 'scene.splat'),
      )
      : null;
    if (copiedRefGaussianSplat) {
      refGaussianArtifacts.splatPath = 'artifacts/master_ref_gaussian/scene.splat';
      refGaussianArtifacts.splatUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/scene.splat`;
    }

    const copiedRefGaussianPly = refGaussianSummary?.splatPlyPath
      ? await copyIfPresent(
        refGaussianSummary.splatPlyPath,
        path.join(refGaussianArtifactsDir, 'scene.ply'),
      )
      : null;
    if (copiedRefGaussianPly) {
      refGaussianArtifacts.plyPath = 'artifacts/master_ref_gaussian/scene.ply';
      refGaussianArtifacts.plyUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/scene.ply`;
    }

    const refGaussianBundle = refGaussianSummary?.refGaussianBundle || null;
    const refGaussianFinalDir = refGaussianSummary?.splatScenePath
      ? path.dirname(refGaussianSummary.splatScenePath)
      : null;
    const refGaussianOutputDir = refGaussianSummary?.outputDir
      || (refGaussianFinalDir ? path.dirname(refGaussianFinalDir) : null);
    const refGaussianBundleJsonPath = refGaussianBundle?.jsonPath
      || refGaussianSummary?.refGaussianBundleJsonPath
      || (refGaussianFinalDir ? path.join(refGaussianFinalDir, 'scene.refgaussian.json') : null);
    const copiedRefGaussianBundleJson = refGaussianBundleJsonPath
      ? await copyIfPresent(
        refGaussianBundleJsonPath,
        path.join(refGaussianArtifactsDir, 'scene.refgaussian.json'),
      )
      : null;
    if (copiedRefGaussianBundleJson) {
      refGaussianArtifacts.bundleJsonPath = 'artifacts/master_ref_gaussian/scene.refgaussian.json';
      refGaussianArtifacts.bundleJsonUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/scene.refgaussian.json`;
    }

    const refGaussianBundleBinPath = refGaussianBundle?.binPath
      || refGaussianSummary?.refGaussianBundleBinPath
      || (refGaussianFinalDir ? path.join(refGaussianFinalDir, 'scene.refgaussian.bin') : null);
    const copiedRefGaussianBundleBin = refGaussianBundleBinPath
      ? await copyIfPresent(
        refGaussianBundleBinPath,
        path.join(refGaussianArtifactsDir, 'scene.refgaussian.bin'),
      )
      : null;
    if (copiedRefGaussianBundleBin) {
      refGaussianArtifacts.bundleBinPath = 'artifacts/master_ref_gaussian/scene.refgaussian.bin';
      refGaussianArtifacts.bundleBinUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/scene.refgaussian.bin`;
    }

    const refGaussianBundleMetadata = refGaussianBundleJsonPath
      ? await readJsonIfPresent(refGaussianBundleJsonPath)
      : null;
    const refGaussianVisibilityGeometryPath = refGaussianBundleMetadata?.nativeRendererContract?.raytracingMeshPath
      || refGaussianSummary?.nativeRenderContract?.raytracingMeshPath
      || null;
    const copiedRefGaussianVisibilityGeometry = refGaussianVisibilityGeometryPath
      ? await copyIfPresent(
        refGaussianVisibilityGeometryPath,
        path.join(refGaussianArtifactsDir, 'visibility-geometry.ply'),
      )
      : null;
    if (copiedRefGaussianVisibilityGeometry) {
      refGaussianArtifacts.visibilityGeometryPath = 'artifacts/master_ref_gaussian/visibility-geometry.ply';
      refGaussianArtifacts.visibilityGeometryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/visibility-geometry.ply`;
    }

    const copiedRefGaussianViewer = refGaussianSummary?.viewerHtmlPath
      ? await copyDirectoryIfExists(
        path.dirname(refGaussianSummary.viewerHtmlPath),
        path.join(refGaussianArtifactsDir, 'viewer'),
      )
      : null;
    if (copiedRefGaussianViewer) {
      refGaussianArtifacts.viewerPath = 'artifacts/master_ref_gaussian/viewer/index.html';
      refGaussianArtifacts.viewerUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/viewer/index.html`;
    }

    const refGaussianNativeRenderContract = refGaussianSummary?.nativeRenderContract || null;
    const refGaussianNativeRenderContractPath = refGaussianNativeRenderContract?.path
      || refGaussianSummary?.nativeRenderContractPath
      || (refGaussianOutputDir ? path.join(refGaussianOutputDir, 'native-render-contract') : null);
    const copiedRefGaussianNativeRenderContract = refGaussianNativeRenderContractPath
      ? await copyDirectoryIfExists(
        refGaussianNativeRenderContractPath,
        path.join(refGaussianArtifactsDir, 'native-render-contract'),
      )
      : null;
    if (copiedRefGaussianNativeRenderContract) {
      refGaussianArtifacts.nativeRenderContractPath = 'artifacts/master_ref_gaussian/native-render-contract';
      refGaussianArtifacts.nativeRenderContractUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/native-render-contract/manifest.json`;
      refGaussianArtifacts.nativeRenderContractManifestPath = 'artifacts/master_ref_gaussian/native-render-contract/manifest.json';
      refGaussianArtifacts.nativeRenderContractManifestUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian/native-render-contract/manifest.json`;
    }

    if (Object.keys(refGaussianArtifacts).length > 0) {
      refGaussianArtifacts.applied = refGaussianSummary.applied === true;
      refGaussianArtifacts.pointCount = Number(refGaussianSummary.pointCount || 0);
      refGaussianArtifacts.method = refGaussianSummary.method || null;
      refGaussianArtifacts.renderMode = refGaussianSummary.renderMode || 'ref_gaussian_viewer';
      refGaussianArtifacts.trainingMaskMode = refGaussianSummary.trainingMaskMode || 'metadata_only';
      refGaussianArtifacts.nativeRender = refGaussianSummary.nativeRender || null;
      refGaussianArtifacts.nativeRenderContract = refGaussianNativeRenderContract || null;
      refGaussianArtifacts.cleanupSummary = refGaussianSummary.cleanupSummary || null;
      refGaussianArtifacts.bundle = refGaussianBundle || null;
      gaussianArtifacts.refGaussian = {
        applied: refGaussianArtifacts.applied,
        pointCount: refGaussianArtifacts.pointCount,
        viewerUrl: refGaussianArtifacts.viewerUrl || null,
        splatUrl: refGaussianArtifacts.splatUrl || null,
        bundleJsonUrl: refGaussianArtifacts.bundleJsonUrl || null,
        bundleBinUrl: refGaussianArtifacts.bundleBinUrl || null,
        nativeRenderContractUrl: refGaussianArtifacts.nativeRenderContractManifestUrl || null,
        visibilityGeometryUrl: refGaussianArtifacts.visibilityGeometryUrl || null,
        renderMode: refGaussianArtifacts.renderMode,
      };
    }

    const scaffoldGsSummary = gaussianSummary.scaffoldGs || null;
    const copiedScaffoldGsSummary = scaffoldGsSummary?.applied
      ? await copyIfPresent(
        scaffoldGsSummary.resultPath || path.join(jobDir, 'gaussian', 'splatting', 'scaffold-gs', 'result.json'),
        path.join(scaffoldGsArtifactsDir, 'summary.json'),
      )
      : null;
    if (copiedScaffoldGsSummary) {
      scaffoldGsArtifacts.summaryPath = 'artifacts/master_scaffold_gs/summary.json';
      scaffoldGsArtifacts.summaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_scaffold_gs/summary.json`;
    }

    const copiedScaffoldGsSplat = scaffoldGsSummary?.splatScenePath
      ? await copyIfPresent(
        scaffoldGsSummary.splatScenePath,
        path.join(scaffoldGsArtifactsDir, 'scene.splat'),
      )
      : null;
    if (copiedScaffoldGsSplat) {
      scaffoldGsArtifacts.splatPath = 'artifacts/master_scaffold_gs/scene.splat';
      scaffoldGsArtifacts.splatUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_scaffold_gs/scene.splat`;
    }

    const copiedScaffoldGsPly = scaffoldGsSummary?.splatPlyPath
      ? await copyIfPresent(
        scaffoldGsSummary.splatPlyPath,
        path.join(scaffoldGsArtifactsDir, 'scene.ply'),
      )
      : null;
    if (copiedScaffoldGsPly) {
      scaffoldGsArtifacts.plyPath = 'artifacts/master_scaffold_gs/scene.ply';
      scaffoldGsArtifacts.plyUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_scaffold_gs/scene.ply`;
    }

    const copiedScaffoldGsViewer = scaffoldGsSummary?.viewerHtmlPath
      ? await copyDirectoryIfExists(
        path.dirname(scaffoldGsSummary.viewerHtmlPath),
        path.join(scaffoldGsArtifactsDir, 'viewer'),
      )
      : null;
    if (copiedScaffoldGsViewer) {
      scaffoldGsArtifacts.viewerPath = 'artifacts/master_scaffold_gs/viewer/index.html';
      scaffoldGsArtifacts.viewerUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_scaffold_gs/viewer/index.html`;
    }

    if (Object.keys(scaffoldGsArtifacts).length > 0) {
      scaffoldGsArtifacts.applied = scaffoldGsSummary.applied === true;
      scaffoldGsArtifacts.pointCount = Number(scaffoldGsSummary.pointCount || 0);
      scaffoldGsArtifacts.method = scaffoldGsSummary.method || 'scaffold_gs_adapter';
      scaffoldGsArtifacts.renderMode = scaffoldGsSummary.renderMode || 'converted_splat_fallback';
      scaffoldGsArtifacts.trainingMaskMode = scaffoldGsSummary.trainingMaskMode || 'metadata_only';
      gaussianArtifacts.scaffoldGs = {
        applied: scaffoldGsArtifacts.applied,
        pointCount: scaffoldGsArtifacts.pointCount,
        viewerUrl: scaffoldGsArtifacts.viewerUrl || null,
        splatUrl: scaffoldGsArtifacts.splatUrl || null,
        plyUrl: scaffoldGsArtifacts.plyUrl || null,
        renderMode: scaffoldGsArtifacts.renderMode,
      };
    }
  }

  const refGaussianMeshHybridArtifacts = {};
  const refGaussianMeshHybridArtifactsDir = path.join(artifactsDir, 'master_ref_gaussian_mesh');
  let copiedRefGaussianMeshHybridObj = null;
  let copiedRefGaussianMeshHybridMtl = null;
  let copiedRefGaussianMeshHybridTexture = null;
  if (refGaussianMeshHybridSummary) {
    const copiedRefGaussianMeshHybridSummary = await copyIfPresent(
      path.join(jobDir, 'refgaussian_mesh_hybrid', 'summary.json'),
      path.join(refGaussianMeshHybridArtifactsDir, 'summary.json'),
    );
    if (copiedRefGaussianMeshHybridSummary) {
      refGaussianMeshHybridArtifacts.summaryPath = 'artifacts/master_ref_gaussian_mesh/summary.json';
      refGaussianMeshHybridArtifacts.summaryUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian_mesh/summary.json`;
    }

    const copiedRefGaussianMeshHybridSurface = await copyIfPresent(
      refGaussianMeshHybridSummary.normalizedSurfacePlyPath
        || path.join(jobDir, 'refgaussian_mesh_hybrid', 'surface', 'normalized_surface_points.ply'),
      path.join(refGaussianMeshHybridArtifactsDir, 'normalized_surface_points.ply'),
    );
    if (copiedRefGaussianMeshHybridSurface) {
      refGaussianMeshHybridArtifacts.surfacePath = 'artifacts/master_ref_gaussian_mesh/normalized_surface_points.ply';
      refGaussianMeshHybridArtifacts.surfaceUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian_mesh/normalized_surface_points.ply`;
    }

    const copiedRefGaussianMeshHybridMesh = await copyIfPresent(
      refGaussianMeshHybridSummary.meshPath
        || path.join(jobDir, 'refgaussian_mesh_hybrid', 'mesh', 'meshed_poisson.ply'),
      path.join(refGaussianMeshHybridArtifactsDir, 'meshed_poisson.ply'),
    );
    if (copiedRefGaussianMeshHybridMesh) {
      refGaussianMeshHybridArtifacts.meshPath = 'artifacts/master_ref_gaussian_mesh/meshed_poisson.ply';
      refGaussianMeshHybridArtifacts.meshUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/master_ref_gaussian_mesh/meshed_poisson.ply`;
    }

    copiedRefGaussianMeshHybridObj = await copyIfPresent(
      refGaussianMeshHybridSummary.texturedMeshPath
        || path.join(jobDir, 'refgaussian_mesh_hybrid', 'texture', 'detail_texture', 'model.obj'),
      path.join(modelDir, 'model.obj'),
    );
    if (copiedRefGaussianMeshHybridObj) {
      refGaussianMeshHybridArtifacts.texturedObjPath = 'model/model.obj';
      refGaussianMeshHybridArtifacts.texturedObjUrl = `/api/room-scanner/scans/${roomScanId}/model/model.obj`;
    }

    copiedRefGaussianMeshHybridMtl = await copyIfPresent(
      refGaussianMeshHybridSummary.mtlPath
        || path.join(jobDir, 'refgaussian_mesh_hybrid', 'texture', 'detail_texture', 'model.mtl'),
      path.join(modelDir, 'model.mtl'),
    );
    if (copiedRefGaussianMeshHybridMtl) {
      refGaussianMeshHybridArtifacts.mtlPath = 'model/model.mtl';
      refGaussianMeshHybridArtifacts.mtlUrl = `/api/room-scanner/scans/${roomScanId}/model/model.mtl`;
    }

    copiedRefGaussianMeshHybridTexture = await copyIfPresent(
      refGaussianMeshHybridSummary.texturePath
        || path.join(jobDir, 'refgaussian_mesh_hybrid', 'texture', 'detail_texture', 'texture.jpg'),
      path.join(modelDir, 'texture.jpg'),
    );
    if (copiedRefGaussianMeshHybridTexture) {
      refGaussianMeshHybridArtifacts.texturePath = 'model/texture.jpg';
      refGaussianMeshHybridArtifacts.textureUrl = `/api/room-scanner/scans/${roomScanId}/model/texture.jpg`;
    }

    refGaussianMeshHybridArtifacts.method = 'refgaussian_surface_poisson_openmvs';
    refGaussianMeshHybridArtifacts.numVertices = toFiniteNumber(refGaussianMeshHybridSummary.numVertices, 0);
    refGaussianMeshHybridArtifacts.numFaces = toFiniteNumber(refGaussianMeshHybridSummary.numFaces, 0);
    refGaussianMeshHybridArtifacts.pointCount = toFiniteNumber(
      refGaussianMeshHybridSummary.surfaceExtraction?.pointCount,
      0,
    );
  }

  const thumbnailFilename = await writeThumbnail(job, roomScanDir);
  const hybridMeshBounds = refGaussianMeshHybridSummary?.dimensions?.min && refGaussianMeshHybridSummary?.dimensions?.max
    ? {
      min: refGaussianMeshHybridSummary.dimensions.min,
      max: refGaussianMeshHybridSummary.dimensions.max,
    }
    : null;
  const roomDimensions = buildRoomDimensions(hybridMeshBounds || finalBounds);
  const frameCount = Math.max(
    toFiniteNumber(job.capture?.selectedFrameCount, 0),
    toFiniteNumber(job.capture?.imageCount, 0),
  );
  const densePointCount = toFiniteNumber(denseSummary?.pointCount, 0);
  const gaussianPointCount = resolveGaussianPointCount(gaussianSummary);
  const preferredGaussianBackend = String(
    job.requestedProcessing?.inputOptions?.preferredGaussianBackend
      || job.requestedProcessing?.inputOptions?.gaussianBackend
      || 'vanilla',
  ).trim().toLowerCase();
  const useRefGaussianAsPrimary = ['ref_gaussian', 'refgaussian'].includes(preferredGaussianBackend)
    && Object.keys(refGaussianArtifacts).length > 0;
  const useScaffoldGsAsPrimary = ['scaffold_gs', 'scaffold-gs', 'scaffoldgs'].includes(preferredGaussianBackend)
    && Object.keys(scaffoldGsArtifacts).length > 0;

  const refGaussianPointCount = toFiniteNumber(refGaussianArtifacts.pointCount, 0);
  const scaffoldGsPointCount = toFiniteNumber(scaffoldGsArtifacts.pointCount, 0);
  const processingResult = {
    numPoints: densePointCount > 0
      ? densePointCount
      : (
        useScaffoldGsAsPrimary && scaffoldGsPointCount > 0
          ? scaffoldGsPointCount
          : (useRefGaussianAsPrimary && refGaussianPointCount > 0 ? refGaussianPointCount : gaussianPointCount)
      ),
    numVertices: toFiniteNumber(
      refGaussianMeshHybridSummary?.numVertices,
      toFiniteNumber(finalMeshStats?.vertices, toFiniteNumber(detailMeshSummary?.numVertices, toFiniteNumber(meshSummary?.numVertices, 0))),
    ),
    numFaces: toFiniteNumber(
      refGaussianMeshHybridSummary?.numFaces,
      toFiniteNumber(finalMeshStats?.faces, toFiniteNumber(detailMeshSummary?.numFaces, toFiniteNumber(meshSummary?.numFaces, 0))),
    ),
    numViewpoints: Math.max(
      toFiniteNumber(sfmSummary?.registeredImageCount, 0),
      frameCount,
    ),
    dimensions: roomDimensions,
    totalTime: calculateProcessingDurationSeconds(job),
  };

  const modelFiles = {
    ...(copiedGlb ? { glb: 'model/model.glb' } : {}),
    ...(copiedPly ? { ply: 'model/model.ply' } : {}),
    ...(copiedRefGaussianMeshHybridObj ? { obj: 'model/model.obj' } : {}),
    ...(copiedRefGaussianMeshHybridMtl ? { mtl: 'model/model.mtl' } : {}),
    ...(copiedRefGaussianMeshHybridTexture ? { texture: 'model/texture.jpg' } : {}),
  };
  const scaffoldGsUsesConvertedFallback = scaffoldGsArtifacts.renderMode === 'converted_splat_fallback';
  const modelViewerUrl = wantsGaussianViewer
    ? (
      useScaffoldGsAsPrimary
        ? (
          scaffoldGsUsesConvertedFallback
            ? (scaffoldGsArtifacts.plyUrl || scaffoldGsArtifacts.splatUrl || scaffoldGsArtifacts.viewerUrl || null)
            : (scaffoldGsArtifacts.viewerUrl || scaffoldGsArtifacts.splatUrl || scaffoldGsArtifacts.plyUrl || null)
        )
        : (
          useRefGaussianAsPrimary
            ? (refGaussianArtifacts.splatUrl || refGaussianArtifacts.plyUrl || refGaussianArtifacts.viewerUrl || null)
            : (gaussianArtifacts.viewerUrl || null)
        )
    )
    : null;
  const primaryOutput = modelViewerUrl
    ? (useScaffoldGsAsPrimary ? 'scaffold_gs_splats' : (useRefGaussianAsPrimary ? 'ref_gaussian_splats' : 'gaussian_splats'))
    : 'textured_glb_mesh';

  const roomScanData = {
    id: roomScanId,
    roomName: job.jobName || 'Master Reconstruction',
    propertyId: job.propertyId || null,
    userId: job.userId || null,
    createdAt: roomScanTarget.createdAt,
    frameCount,
    frames: [],
    thumbnailFilename,
    type: 'photogrammetry',
    scanType: 'photogrammetry',
    metadata: {
      scanType: 'photogrammetry',
      pipelineVersion: 'master_v1',
      source: 'master_reconstruction',
      canonicalSystem: true,
      masterJobId: job.id,
      publishedAt: roomScanTarget.createdAt,
      ...(roomScanTarget.sourceRoomScanId ? { sourceRoomScanId: roomScanTarget.sourceRoomScanId } : {}),
      primaryOutput,
      preferredGaussianBackend,
      modelViewerUrl,
      processingResult,
      modelFiles,
      meshBackendArtifacts: Object.keys(meshBackendArtifacts).length > 0 ? meshBackendArtifacts : undefined,
      gaussianArtifacts: Object.keys(gaussianArtifacts).length > 0 ? gaussianArtifacts : undefined,
      refGaussianArtifacts: Object.keys(refGaussianArtifacts).length > 0 ? refGaussianArtifacts : undefined,
      scaffoldGsArtifacts: Object.keys(scaffoldGsArtifacts).length > 0 ? scaffoldGsArtifacts : undefined,
      refGaussianMeshHybridArtifacts: Object.keys(refGaussianMeshHybridArtifacts).length > 0 ? refGaussianMeshHybridArtifacts : undefined,
      roomDimensions,
      geometryAuthority: job.geometryAuthority,
      outputs: {
        finalGlbPath: job.outputs?.finalGlbPath || null,
        optimizedGlbPath: job.outputs?.optimizedGlbPath || null,
        exportSummaryPath: copiedExportSummary ? `artifacts/master_export_summary.json` : null,
        qaReportPath: copiedQaReport ? `artifacts/qa_report.json` : null,
        meshBackendSummaryPath: meshBackendArtifacts.exportSummaryPath || null,
        meshBackendGlbPath: meshBackendArtifacts.glbPath || null,
        gaussianSummaryPath: gaussianArtifacts.summaryPath || null,
        gaussianScenePath: gaussianArtifacts.splatPath || null,
        gaussianPlyPath: gaussianArtifacts.plyPath || null,
        gaussianViewerPath: gaussianArtifacts.viewerPath || null,
        refGaussianSummaryPath: refGaussianArtifacts.summaryPath || null,
        refGaussianScenePath: refGaussianArtifacts.splatPath || null,
        refGaussianPlyPath: refGaussianArtifacts.plyPath || null,
        refGaussianViewerPath: refGaussianArtifacts.viewerPath || null,
        refGaussianBundleJsonPath: refGaussianArtifacts.bundleJsonPath || null,
        refGaussianBundleBinPath: refGaussianArtifacts.bundleBinPath || null,
        refGaussianVisibilityGeometryPath: refGaussianArtifacts.visibilityGeometryPath || null,
        refGaussianNativeRenderContractPath: refGaussianArtifacts.nativeRenderContractPath || null,
        refGaussianNativeRenderContractManifestPath: refGaussianArtifacts.nativeRenderContractManifestPath || null,
        scaffoldGsSummaryPath: scaffoldGsArtifacts.summaryPath || null,
        scaffoldGsScenePath: scaffoldGsArtifacts.splatPath || null,
        scaffoldGsPlyPath: scaffoldGsArtifacts.plyPath || null,
        scaffoldGsViewerPath: scaffoldGsArtifacts.viewerPath || null,
        refGaussianMeshHybridSummaryPath: refGaussianMeshHybridArtifacts.summaryPath || null,
        refGaussianMeshHybridSurfacePath: refGaussianMeshHybridArtifacts.surfacePath || null,
        refGaussianMeshHybridMeshPath: refGaussianMeshHybridArtifacts.meshPath || null,
        refGaussianMeshHybridTexturedObjPath: refGaussianMeshHybridArtifacts.texturedObjPath || null,
        masterJobArtifactBundlePath: fullArtifactBundle.rootPath,
      },
      masterJobArtifactBundle: fullArtifactBundle,
      capture: {
        imageCount: toFiniteNumber(job.capture?.imageCount, 0),
        selectedFrameCount: toFiniteNumber(job.capture?.selectedFrameCount, 0),
        rawFrameCount: toFiniteNumber(job.capture?.rawFrameCount, 0),
        captureMode: job.metadata?.captureMode || null,
      },
    },
  };

  await fsPromises.writeFile(
    path.join(roomScanDir, 'metadata.json'),
    JSON.stringify(roomScanData, null, 2),
  );

  return { roomScanId, roomScanData };
}

export {
  mirrorMasterJobToRoomScanner,
};