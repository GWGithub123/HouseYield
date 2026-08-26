/**
 * Photogrammetry API Routes
 * 
 * REST API for photogrammetry scanning pipeline:
 * - Upload photos and metadata
 * - Start/monitor processing jobs
 * - Download results (mesh, GLB, navigation)
 * - Stream progress updates via SSE
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Configuration
const DATA_DIR = process.env.PHOTOGRAMMETRY_DATA_DIR || path.join(__dirname, '../../data');
const SCRIPTS_DIR = path.join(__dirname, '../scripts/photogrammetry');
const SCRIPTS_DIR_V2 = path.join(__dirname, '../scripts/photogrammetry_v2');
const ROOM_SCANS_DIR = path.join(__dirname, '../data/room-scans');
const LOCAL_PYTHON_PATH = path.join(SCRIPTS_DIR, 'venv/bin/python');
const CONTAINER_PYTHON_PATH = '/opt/venv/bin/python3';
const PYTHON_PATH = process.env.PYTHON_PATH || (fsSync.existsSync(LOCAL_PYTHON_PATH)
  ? LOCAL_PYTHON_PATH
  : CONTAINER_PYTHON_PATH);
// Default to v1 pipeline (uses GCP GPU when available, incremental improvements)
const DEFAULT_PIPELINE_VERSION = process.env.PIPELINE_VERSION || 'v1';

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const scanId = req.params.scanId || req.body.scanId || uuidv4();
    const uploadDir = path.join(DATA_DIR, 'photogrammetry', scanId, 'raw', 'images');

    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos') {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/heic'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Invalid file type: ${file.mimetype}`));
      }
    } else {
      cb(null, true);
    }
  }
});

// Track active processing jobs
const activeJobs = new Map();

/**
 * Convert OBJ mesh to GLB format using Python trimesh.
 */
async function convertObjToGlb(objPath, glbPath) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  await fs.mkdir(path.dirname(glbPath), { recursive: true });

  const pythonScript = `
import trimesh
import sys

obj_path = "${objPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
glb_path = "${glbPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"

try:
    mesh = trimesh.load(obj_path)
    mesh.export(glb_path, file_type='glb')
    print(f"Exported GLB: {glb_path}")
    sys.exit(0)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

  try {
    await execAsync(`python3 -c "${pythonScript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    console.log(`[Photogrammetry] ✅ Converted OBJ to GLB: ${glbPath}`);
    return true;
  } catch (error) {
    console.error('[Photogrammetry] GLB conversion failed:', error.message);
    return false;
  }
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(targetPath) {
  if (!await fileExists(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(await fs.readFile(targetPath, 'utf-8'));
  } catch {
    return null;
  }
}

function pickDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return undefined;
}

function extractWorkerResult(outputChunks) {
  const lines = (Array.isArray(outputChunks) ? outputChunks.join('') : String(outputChunks || ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'success')) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return null;
}

async function persistFailedWorkerState({ scanDir, pipelineVersion = 'v1', job, fallbackError = 'Processing failed' }) {
  const workerResult = extractWorkerResult(job?.output);
  const lastError = Array.isArray(job?.errors) && job.errors.length > 0
    ? String(job.errors[job.errors.length - 1] || '').trim()
    : '';
  const errorMessage = workerResult?.error || lastError || fallbackError;
  const failureResult = await enrichResultForStorage(scanDir, {
    ...(workerResult && typeof workerResult === 'object' ? workerResult : {}),
    success: false,
    error: errorMessage,
    pipelineVersion,
  }, pipelineVersion);

  await fs.writeFile(
    path.join(scanDir, 'result.json'),
    JSON.stringify(failureResult, null, 2)
  );

  await fs.writeFile(
    path.join(scanDir, 'progress.json'),
    JSON.stringify({
      phase: 'failed',
      percent: 0,
      message: errorMessage,
    }, null, 2)
  );

  return failureResult;
}

async function copyFirstExisting(sources, destinationPath) {
  for (const sourcePath of sources.filter(Boolean)) {
    if (!await fileExists(sourcePath)) {
      continue;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    return sourcePath;
  }

  return null;
}

async function objHasTextureCoordinates(objPath) {
  if (!objPath || !await fileExists(objPath)) {
    return false;
  }

  try {
    const objContent = await fs.readFile(objPath, 'utf8');
    return /^vt\s+/m.test(objContent);
  } catch {
    return false;
  }
}

async function copyDirectoryIfExists(sourceDir, destinationDir) {
  if (!sourceDir || !await fileExists(sourceDir)) {
    return false;
  }

  await fs.mkdir(path.dirname(destinationDir), { recursive: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
  return true;
}

async function enrichResultForStorage(scanDir, result = {}, pipelineVersion = 'v1') {
  const outputDir = pipelineVersion === 'hybrid_v1'
    ? path.join(scanDir, 'hybrid_output')
    : pipelineVersion === 'v2'
      ? path.join(scanDir, 'v2_output')
      : scanDir;

  const stats = await readJsonIfExists(path.join(outputDir, 'pipeline_stats.json'));
  const measurements = await readJsonIfExists(path.join(outputDir, 'measurements.json'));
  const hybridManifest = pipelineVersion === 'hybrid_v1'
    ? (await readJsonIfExists(path.join(outputDir, 'hybrid_manifest.json'))) ||
      (await readJsonIfExists(path.join(outputDir, 'hybrid', 'hybrid_manifest.json')))
    : null;

  return {
    ...result,
    pipelineVersion,
    stats: result.stats || stats || null,
    measurements: result.measurements || measurements || null,
    hybridManifest: result.hybridManifest || hybridManifest || null,
    total_time: pickNumber(result.total_time, stats?.total_time, stats?.totalTime, stats?.totalTimeSeconds),
    num_images_registered: pickNumber(
      result.num_images_registered,
      stats?.registered_images,
      stats?.registeredImages,
      stats?.total_images,
      stats?.imageCount,
    ),
    num_dense_points: pickNumber(result.num_dense_points, stats?.dense_points, stats?.densePoints),
    num_mesh_vertices: pickNumber(result.num_mesh_vertices, stats?.mesh_vertices, stats?.meshVertices),
    num_mesh_faces: pickNumber(result.num_mesh_faces, stats?.mesh_faces, stats?.meshFaces),
    num_viewpoints: pickNumber(
      result.num_viewpoints,
      stats?.registered_images,
      stats?.registeredImages,
      stats?.total_images,
      stats?.imageCount,
    ),
    room_dimensions: pickDefined(
      result.room_dimensions,
      measurements?.room_dimensions,
      measurements?.roomDimensions,
    ),
  };
}

async function savePhotogrammetryScanToRoomScanner({ scanId, scanDir, metadata, results, pipelineVersion }) {
  const normalizedResults = await enrichResultForStorage(scanDir, results, pipelineVersion);
  const roomScanId = `photogrammetry_${scanId}`;
  const roomScanDir = path.join(ROOM_SCANS_DIR, roomScanId);
  const modelDir = path.join(roomScanDir, 'model');
  const artifactsDir = path.join(roomScanDir, 'artifacts');

  const exportDir = path.join(scanDir, 'exports');
  const meshDir = path.join(scanDir, 'mesh');
  const denseDir = path.join(scanDir, 'dense');
  const v2OutputDir = path.join(scanDir, 'v2_output');
  const hybridOutputDir = path.join(scanDir, 'hybrid_output');
  const hybridBundleDir = path.join(hybridOutputDir, 'hybrid');

  await fs.mkdir(modelDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(exportDir, { recursive: true });

  const glbExportPath = path.join(exportDir, 'model.glb');
  if (!await fileExists(glbExportPath)) {
    const glbSourceCandidates = [
      path.join(hybridBundleDir, 'mesh.glb'),
      path.join(hybridOutputDir, 'mesh.glb'),
    ];
    const glbSource = await (async () => {
      for (const candidate of glbSourceCandidates) {
        if (await fileExists(candidate)) {
          return candidate;
        }
      }
      return null;
    })();

    if (glbSource) {
      await fs.copyFile(glbSource, glbExportPath);
    } else {
      const objSources = [
        path.join(denseDir, 'textured_mesh.obj'),
        path.join(meshDir, 'textured_mesh.obj'),
        path.join(meshDir, 'model.obj'),
        path.join(v2OutputDir, 'textured.obj'),
        path.join(v2OutputDir, 'mesh', 'textured.obj'),
        path.join(hybridOutputDir, 'textured.obj'),
        path.join(hybridOutputDir, 'mesh', 'textured.obj'),
      ];

      for (const objPath of objSources) {
        if (!await fileExists(objPath)) {
          continue;
        }

        const generated = await convertObjToGlb(objPath, glbExportPath);
        if (generated) {
          break;
        }
      }
    }
  }

  const modelFiles = {};
  const copiedGlb = await copyFirstExisting([
    glbExportPath,
    path.join(hybridBundleDir, 'mesh.glb'),
    path.join(hybridOutputDir, 'mesh.glb'),
  ], path.join(modelDir, 'model.glb'));
  if (copiedGlb) modelFiles.glb = 'model/model.glb';

  const copiedPly = await copyFirstExisting([
    path.join(exportDir, 'model.ply'),
    path.join(meshDir, 'mesh.ply'),
    path.join(denseDir, 'mesh.ply'),
    path.join(v2OutputDir, 'scaled.ply'),
    path.join(v2OutputDir, 'cleaned.ply'),
    path.join(v2OutputDir, 'raw.ply'),
    path.join(hybridOutputDir, 'scaled.ply'),
    path.join(hybridOutputDir, 'cleaned.ply'),
    path.join(hybridOutputDir, 'raw.ply'),
  ], path.join(modelDir, 'model.ply'));
  if (copiedPly) modelFiles.ply = 'model/model.ply';

  const copiedObj = await copyFirstExisting([
    path.join(meshDir, 'textured_mesh.obj'),
    path.join(meshDir, 'model.obj'),
    path.join(exportDir, 'model.obj'),
    path.join(denseDir, 'textured_mesh.obj'),
    path.join(v2OutputDir, 'textured.obj'),
    path.join(v2OutputDir, 'mesh', 'textured.obj'),
    path.join(hybridOutputDir, 'textured.obj'),
    path.join(hybridOutputDir, 'mesh', 'textured.obj'),
  ], path.join(modelDir, 'model.obj'));
  const mirroredObjPath = path.join(modelDir, 'model.obj');
  const mirroredObjHasUvs = copiedObj ? await objHasTextureCoordinates(mirroredObjPath) : false;
  if (copiedObj) {
    modelFiles.obj = 'model/model.obj';
    if (!mirroredObjHasUvs) {
      console.log(`[Photogrammetry] OBJ ${mirroredObjPath} has no UVs; skipping mirrored MTL/texture sidecars`);
    }
  }

  if (mirroredObjHasUvs) {
    const copiedMtl = await copyFirstExisting([
      path.join(meshDir, 'textured_mesh.mtl'),
      path.join(meshDir, 'model.mtl'),
      path.join(exportDir, 'model.mtl'),
      path.join(denseDir, 'textured_mesh.mtl'),
      path.join(v2OutputDir, 'textured.mtl'),
      path.join(v2OutputDir, 'mesh', 'textured.mtl'),
      path.join(hybridOutputDir, 'textured.mtl'),
      path.join(hybridOutputDir, 'mesh', 'textured.mtl'),
    ], path.join(modelDir, 'model.mtl'));
    if (copiedMtl) modelFiles.mtl = 'model/model.mtl';

    const textureDirs = [meshDir, denseDir, v2OutputDir, path.join(v2OutputDir, 'mesh'), hybridOutputDir, path.join(hybridOutputDir, 'mesh')];
    const textureFileNames = new Set();
    for (const textureDir of textureDirs) {
      const textureFiles = await fs.readdir(textureDir).catch(() => []);
      for (const file of textureFiles) {
        if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) {
          continue;
        }

        try {
          await fs.copyFile(path.join(textureDir, file), path.join(modelDir, file));
          textureFileNames.add(file);
        } catch {
          // Ignore duplicate or missing texture files.
        }
      }
    }

    if (textureFileNames.size > 0) {
      const [firstTextureName] = Array.from(textureFileNames);
      modelFiles.texture = `model/${firstTextureName}`;

      try {
        const mtlPath = path.join(modelDir, 'model.mtl');
        let mtlContent = await fs.readFile(mtlPath, 'utf8');
        if (!mtlContent.includes('map_Kd')) {
          mtlContent = `${mtlContent.trimEnd()}\nmap_Kd ${firstTextureName}\n`;
          await fs.writeFile(mtlPath, mtlContent);
        }
      } catch {
        // MTL is optional.
      }
    }
  }

  const hybridArtifacts = {};
  if (pipelineVersion === 'hybrid_v1') {
    const copiedManifest = await copyFirstExisting([
      path.join(hybridOutputDir, 'hybrid_manifest.json'),
      path.join(hybridBundleDir, 'hybrid_manifest.json'),
    ], path.join(artifactsDir, 'hybrid', 'hybrid_manifest.json'));
    if (copiedManifest) {
      hybridArtifacts.manifestPath = 'artifacts/hybrid/hybrid_manifest.json';
      hybridArtifacts.manifestUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/hybrid/hybrid_manifest.json`;
    }

    const copiedSplat = await copyFirstExisting([
      path.join(hybridBundleDir, 'scene.splat'),
      path.join(hybridOutputDir, 'scene.splat'),
    ], path.join(artifactsDir, 'hybrid', 'scene.splat'));
    if (copiedSplat) {
      hybridArtifacts.splatPath = 'artifacts/hybrid/scene.splat';
      hybridArtifacts.splatUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/hybrid/scene.splat`;
    }

    const copiedKsplat = await copyFirstExisting([
      path.join(hybridBundleDir, 'scene.ksplat'),
      path.join(hybridOutputDir, 'scene.ksplat'),
    ], path.join(artifactsDir, 'hybrid', 'scene.ksplat'));
    if (copiedKsplat) {
      hybridArtifacts.ksplatPath = 'artifacts/hybrid/scene.ksplat';
      hybridArtifacts.ksplatUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/hybrid/scene.ksplat`;
    }

    const viewerCopied = await copyDirectoryIfExists(
      path.join(hybridBundleDir, 'viewer'),
      path.join(artifactsDir, 'hybrid', 'viewer'),
    );
    if (viewerCopied && (hybridArtifacts.splatUrl || hybridArtifacts.ksplatUrl)) {
      hybridArtifacts.viewerPath = 'artifacts/hybrid/viewer/index.html';
      hybridArtifacts.viewerUrl = `/api/room-scanner/scans/${roomScanId}/artifacts/hybrid/viewer/index.html`;
    }
  }

  let thumbnailData = null;
  const imagesDir = path.join(scanDir, 'raw', 'images');
  const images = await fs.readdir(imagesDir).catch(() => []);
  if (images.length > 0) {
    const firstImage = path.join(imagesDir, images[0]);
    const imageBuffer = await fs.readFile(firstImage);
    thumbnailData = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  }

  const roomScanData = {
    id: roomScanId,
    roomName: metadata.roomName || 'Photogrammetry Scan',
    propertyId: metadata.propertyId || null,
    userId: metadata.userId || null,
    createdAt: metadata.createdAt,
    frameCount: pickNumber(normalizedResults.num_images_registered, metadata.totalPhotos) || 0,
    frames: [],
    thumbnailData,
    type: 'photogrammetry',
    scanType: 'photogrammetry',
    metadata: {
      scanType: 'photogrammetry',
      photogrammetryScanId: scanId,
      pipelineVersion,
      modelViewerUrl: hybridArtifacts.viewerUrl || null,
      processingResult: {
        numPoints: pickNumber(normalizedResults.num_dense_points, normalizedResults.stats?.dense_points, normalizedResults.stats?.densePoints),
        numVertices: pickNumber(normalizedResults.num_mesh_vertices, normalizedResults.stats?.mesh_vertices, normalizedResults.stats?.meshVertices),
        numFaces: pickNumber(normalizedResults.num_mesh_faces, normalizedResults.stats?.mesh_faces, normalizedResults.stats?.meshFaces),
        numViewpoints: pickNumber(normalizedResults.num_viewpoints, normalizedResults.num_images_registered, metadata.totalPhotos),
        dimensions: normalizedResults.room_dimensions || {},
        totalTime: pickNumber(normalizedResults.total_time, normalizedResults.stats?.total_time, normalizedResults.stats?.totalTimeSeconds),
      },
      modelFiles,
      hybridArtifacts: Object.keys(hybridArtifacts).length > 0 ? hybridArtifacts : undefined,
    },
  };

  await fs.writeFile(path.join(roomScanDir, 'metadata.json'), JSON.stringify(roomScanData, null, 2));
  return { roomScanId, roomScanData, normalizedResults };
}

/**
 * POST /api/photogrammetry/scans
 * Create a new scan and get scan ID
 */
router.post('/scans', async (req, res) => {
  try {
    const scanId = uuidv4();
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    
    // Create directories
    await fs.mkdir(path.join(scanDir, 'raw', 'images'), { recursive: true });
    
    // Save initial metadata
    const metadata = {
      id: scanId,
      createdAt: new Date().toISOString(),
      status: 'created',
      roomName: req.body.roomName || 'Untitled Room',
      propertyId: req.body.propertyId,
      ...req.body.metadata
    };
    
    await fs.writeFile(
      path.join(scanDir, 'raw', 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    res.json({
      success: true,
      scanId,
      uploadUrl: `/api/photogrammetry/scans/${scanId}/photos`,
    });
  } catch (error) {
    console.error('Error creating scan:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/scans/:scanId/photos
 * Upload photos for a scan
 */
router.post('/scans/:scanId/photos', upload.fields([
  { name: 'photos', maxCount: 200 },
  { name: 'imuData', maxCount: 1 }
]), async (req, res) => {
  try {
    const { scanId } = req.params;
    const files = req.files?.photos || [];
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    console.log(`[Photogrammetry] Received ${files.length} photos for scan ${scanId}`);
    
    // Parse IMU data if provided
    let imuData = {};
    if (req.body.imuData) {
      try {
        imuData = JSON.parse(req.body.imuData);
      } catch (e) {
        console.warn('Failed to parse IMU data:', e);
      }
    }
    
    // Update metadata
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const metadataPath = path.join(scanDir, 'raw', 'metadata.json');
    
    let metadata = {};
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    } catch (e) {
      metadata = { id: scanId, createdAt: new Date().toISOString() };
    }
    
    metadata.photos = (metadata.photos || []).concat(files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      size: f.size,
      uploadedAt: new Date().toISOString(),
    })));
    metadata.imuData = { ...metadata.imuData, ...imuData };
    metadata.totalPhotos = metadata.photos.length;
    metadata.status = 'uploaded';
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    
    res.json({
      success: true,
      uploaded: files.length,
      totalPhotos: metadata.totalPhotos,
    });
  } catch (error) {
    console.error('Error uploading photos:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/scans/:scanId/metadata
 * Update scan metadata (IMU data, camera params, etc.)
 */
router.post('/scans/:scanId/metadata', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const metadataPath = path.join(scanDir, 'raw', 'metadata.json');
    
    let metadata = {};
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    } catch (e) {
      metadata = { id: scanId };
    }
    
    // Extract AR poses for v2 pipeline (save to separate file)
    const { arPoses, arTracking, pipelineVersion, ...otherData } = req.body;
    
    if (arPoses && arPoses.length > 0) {
      const arPosesPath = path.join(scanDir, 'raw', 'ar_poses.json');
      await fs.writeFile(arPosesPath, JSON.stringify({
        poses: arPoses,
        tracking: arTracking,
        pipelineVersion: pipelineVersion || 'v2',
        scale: 1.0, // AR provides metric scale
      }, null, 2));
      console.log(`[Photogrammetry] Saved ${arPoses.length} AR poses for scan ${scanId}`);
    }
    
    // Merge with new data
    metadata = { 
      ...metadata, 
      ...otherData, 
      pipelineVersion: pipelineVersion || metadata.pipelineVersion || 'v1',
      arTracking,
      updatedAt: new Date().toISOString() 
    };
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating metadata:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/scans/:scanId/process
 * Start processing pipeline
 */
router.post('/scans/:scanId/process', express.json(), async (req, res) => {
  try {
    const { scanId } = req.params;
    const options = req.body.options || {};
    
    // Check if already processing
    if (activeJobs.has(scanId)) {
      return res.status(409).json({ error: 'Scan is already being processed' });
    }
    
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const metadataPath = path.join(scanDir, 'raw', 'metadata.json');
    
    // Verify scan exists and read metadata
    let scanMetadata = {};
    try {
      scanMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
    } catch (e) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    
    // Determine pipeline version: option > metadata > default
    const pipelineVersion = options.pipelineVersion || 
                           scanMetadata.pipelineVersion || 
                           DEFAULT_PIPELINE_VERSION;
    const useMasterV1LegacyWorker = pipelineVersion === 'v1' && process.env.MASTER_V1_GCP_WORKER_ENABLE === 'true';
    let args;
    let cwd;
    let spawnCommand = PYTHON_PATH;
    
    if (pipelineVersion === 'v2' || pipelineVersion === 'hybrid_v1') {
      const isHybrid = pipelineVersion === 'hybrid_v1';
      const imagesDir = path.join(scanDir, 'raw', 'images');
      const outputDir = path.join(scanDir, isHybrid ? 'hybrid_output' : 'v2_output');

      args = [
        path.join(SCRIPTS_DIR, isHybrid ? '_call_gcp_worker_hybrid.js' : '_call_gcp_worker_v2.js'),
        imagesDir,
        outputDir,
      ];

      const workerOptions = {
        gpuCount: isHybrid ? (options.gpuCount || 2) : (options.gpuCount || 1),
        cudaVisibleDevices: options.cudaVisibleDevices || (isHybrid ? '0,1' : '0'),
        jobId: scanId,
      };

      const arPosesPath = path.join(scanDir, 'raw', 'ar_poses.json');
      if (await fileExists(arPosesPath)) {
        workerOptions.arPosesPath = arPosesPath;
      }

      if (options.metric3dModel) workerOptions.metric3dModel = options.metric3dModel;
      if (options.voxelSize) workerOptions.voxelSize = options.voxelSize;
      if (options.noGpu) workerOptions.noGpu = options.noGpu;
      if (options.gsplatIterations) workerOptions.gsplatIterations = options.gsplatIterations;
      if (options.skipRoomTourSplat) workerOptions.skipRoomTourSplat = options.skipRoomTourSplat;

      args.push(JSON.stringify(workerOptions));

      cwd = SCRIPTS_DIR;
      console.log(`[Photogrammetry] Starting ${pipelineVersion} pipeline on GCP for ${scanId}`);

      const proc = spawn('node', args, {
        cwd,
        env: { ...process.env },
      });

      const job = {
        scanId,
        process: proc,
        startTime: Date.now(),
        status: 'running',
        output: [],
        errors: [],
        pipelineVersion,
      };

      activeJobs.set(scanId, job);

      proc.stdout.on('data', (data) => {
        job.output.push(data.toString());
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString();
        job.errors.push(msg);
        console.log(`[Pipeline ${pipelineVersion} ${scanId}] ${msg}`);
      });

      proc.on('close', async (code) => {
        job.status = code === 0 ? 'completed' : 'failed';
        job.exitCode = code;
        job.endTime = Date.now();
        setTimeout(() => activeJobs.delete(scanId), 3600000);

        try {
          const latestMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
          latestMetadata.processingStatus = job.status;
          latestMetadata.processedAt = new Date().toISOString();
          latestMetadata.pipelineVersion = pipelineVersion;
          await fs.writeFile(metadataPath, JSON.stringify(latestMetadata, null, 2));

          if (code === 0) {
            const parsedResult = extractWorkerResult(job.output) || { success: true, method: pipelineVersion };
            const enrichedResult = await enrichResultForStorage(scanDir, parsedResult, pipelineVersion);
            await fs.writeFile(
              path.join(scanDir, 'result.json'),
              JSON.stringify(enrichedResult, null, 2)
            );

            await savePhotogrammetryScanToRoomScanner({
              scanId,
              scanDir,
              metadata: latestMetadata,
              results: enrichedResult,
              pipelineVersion,
            });

            console.log(`[Photogrammetry] ${pipelineVersion} processing completed successfully for ${scanId}`);
          } else {
            const failureResult = await persistFailedWorkerState({
              scanDir,
              pipelineVersion,
              job,
              fallbackError: `${pipelineVersion} processing failed`,
            });
            console.error(`[Photogrammetry] ${pipelineVersion} processing failed for ${scanId}: ${failureResult.error}`);
          }
        } catch (error) {
          console.error(`[Photogrammetry] Error finalizing ${pipelineVersion} result: ${error.message}`);
        }
      });

      return res.json({
        success: true,
        message: 'Processing started',
        statusUrl: `/api/photogrammetry/scans/${scanId}/status`,
        progressUrl: `/api/photogrammetry/scans/${scanId}/progress`,
        pipelineVersion,
      });
    } else {
      if (useMasterV1LegacyWorker) {
        const workerOptions = {
          scanId,
          denseMethod: options.denseMethod || 'colmap',
          depthPriorSource: options.depthPriorSource || 'auto',
          meshMethod: options.meshMethod || 'poisson',
          meshDepth: options.meshDepth || 10,
          targetTriangles: options.targetTriangles || 500000,
          textureResolution: options.textureResolution || 4096,
          exportFormats: options.exportFormats || ['glb'],
          clusterRadius: options.clusterRadius || 0.5,
          timeoutMs: options.timeoutMs,
        };

        args = [
          path.join(SCRIPTS_DIR, '_call_master_v1_legacy.js'),
          scanDir,
          JSON.stringify(workerOptions),
        ];
        cwd = SCRIPTS_DIR;
        spawnCommand = 'node';
        console.log(`[Photogrammetry] Starting v1 pipeline on master-v1 VM for ${scanId}`);
      } else {
        // V1 Pipeline: Original COLMAP-based
        args = [
          path.join(SCRIPTS_DIR, 'pipeline.py'),
          scanId,
          '--data-dir', DATA_DIR,
        ];

        if (options.featureType) args.push('--feature-type', options.featureType);
        if (options.denseMethod) args.push('--dense-method', options.denseMethod);
        if (options.depthPriorSource) args.push('--depth-prior-source', options.depthPriorSource);
        if (options.meshMethod) args.push('--mesh-method', options.meshMethod);
        if (options.meshDepth) args.push('--mesh-depth', String(options.meshDepth));
        if (options.targetTriangles) args.push('--target-triangles', String(options.targetTriangles));
        if (options.textureResolution) args.push('--texture-resolution', String(options.textureResolution));
        if (options.exportFormats) args.push('--export-formats', ...options.exportFormats);
        if (options.clusterRadius) args.push('--cluster-radius', String(options.clusterRadius));
        if (options.noNavigation) args.push('--no-navigation');

        cwd = SCRIPTS_DIR;
        console.log(`[Photogrammetry] Starting v1 pipeline for ${scanId}`);
      }
    }
    
    // Start processing
    const proc = spawn(spawnCommand, args, {
      cwd: cwd,
      env: { ...process.env },
    });
    
    const job = {
      scanId,
      process: proc,
      startTime: Date.now(),
      status: 'running',
      output: [],
      errors: [],
    };
    
    activeJobs.set(scanId, job);
    
    proc.stdout.on('data', (data) => {
      job.output.push(data.toString());
    });
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      job.errors.push(msg);
      console.log(`[Pipeline ${scanId}] ${msg}`);
    });
    
    proc.on('close', async (code) => {
      job.status = code === 0 ? 'completed' : 'failed';
      job.exitCode = code;
      job.endTime = Date.now();
      
      // Clean up job after 1 hour
      setTimeout(() => activeJobs.delete(scanId), 3600000);
      
      // Update metadata
      try {
        const metadataPath = path.join(scanDir, 'raw', 'metadata.json');
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        metadata.processingStatus = job.status;
        metadata.processedAt = new Date().toISOString();
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        
        // If successful, automatically save to room scanner
        if (code === 0) {
          console.log(`[Photogrammetry] Processing completed successfully for ${scanId}, saving to room scanner...`);
          try {
            // Call our own save endpoint internally
            const roomScanId = `photogrammetry_${scanId}`;
            const roomScanDir = path.join(__dirname, '../data/room-scans', roomScanId);
            const modelDir = path.join(roomScanDir, 'model');
            await fs.mkdir(modelDir, { recursive: true });
            
            // Read processing results
            const resultsPath = path.join(scanDir, 'result.json');
            const results = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
            
            // Copy mesh files from various possible locations (exports, mesh, dense dirs)
            const exportDir = path.join(scanDir, 'exports');
            const meshDir = path.join(scanDir, 'mesh');
            const denseDir = path.join(scanDir, 'dense');
            
            // Ensure exports directory exists
            await fs.mkdir(exportDir, { recursive: true });
            
            // First, check if we need to generate GLB from OBJ
            // GCP pipeline outputs OBJ+texture to dense/, but we need GLB for the viewer
            let glbGenerated = false;
            const glbExportPath = path.join(exportDir, 'model.glb');
            try {
              await fs.access(glbExportPath);
              console.log(`[Photogrammetry] GLB already exists: ${glbExportPath}`);
            } catch {
              // No GLB exists, try to generate from OBJ
              const objSources = [
                path.join(denseDir, 'textured_mesh.obj'),
                path.join(meshDir, 'textured_mesh.obj'),
                path.join(meshDir, 'model.obj'),
              ];
              
              for (const objPath of objSources) {
                try {
                  await fs.access(objPath);
                  console.log(`[Photogrammetry] Found OBJ, converting to GLB: ${objPath}`);
                  glbGenerated = await convertObjToGlb(objPath, glbExportPath);
                  if (glbGenerated) break;
                } catch {
                  // Try next source
                }
              }
            }
            
            // Files to look for in order of preference
            const filesToCopy = [
              // Standard export files - GLB first (now potentially generated)
              { sources: [`${exportDir}/model.glb`], dest: 'model.glb' },
              { sources: [`${exportDir}/model.ply`, `${meshDir}/mesh.ply`, `${denseDir}/mesh.ply`], dest: 'model.ply' },
              // OBJ files - check mesh dir first (textured_mesh.obj is the actual output), then exports, then dense
              { sources: [`${meshDir}/textured_mesh.obj`, `${meshDir}/model.obj`, `${exportDir}/model.obj`, `${denseDir}/textured_mesh.obj`], dest: 'model.obj' },
              { sources: [`${meshDir}/textured_mesh.mtl`, `${meshDir}/model.mtl`, `${exportDir}/model.mtl`, `${denseDir}/textured_mesh.mtl`], dest: 'model.mtl' },
            ];
            
            for (const file of filesToCopy) {
              const destPath = path.join(modelDir, file.dest);
              for (const srcPath of file.sources) {
                try {
                  await fs.copyFile(srcPath, destPath);
                  console.log(`[Photogrammetry] Copied ${srcPath} -> ${file.dest}`);
                  break; // Found and copied, move to next file
                } catch (e) {
                  // Try next source
                }
              }
            }
            
            // Copy texture files from mesh directory AND dense directory (GCP output)
            // Keep original filenames so MTL references still work
            const textureDirs = [meshDir, denseDir];
            for (const dir of textureDirs) {
              const textureFiles = await fs.readdir(dir).catch(() => []);
              for (const file of textureFiles) {
                if (file.endsWith('.jpg') || file.endsWith('.png')) {
                  try {
                    await fs.copyFile(
                      path.join(dir, file),
                      path.join(modelDir, file)  // Keep original name for MTL compatibility
                    );
                    console.log(`[Photogrammetry] Copied texture ${file}`);
                  } catch (e) {
                    // Ignore copy errors
                  }
                }
              }
            }
            
            // Fix MTL file to include texture reference if missing
            const mtlPath = path.join(modelDir, 'model.mtl');
            try {
              let mtlContent = await fs.readFile(mtlPath, 'utf8');
              if (!mtlContent.includes('map_Kd')) {
                // Find the texture file that was copied
                const modelFiles = await fs.readdir(modelDir);
                const textureFile = modelFiles.find(f => f.endsWith('.jpg') || f.endsWith('.png'));
                if (textureFile) {
                  mtlContent = mtlContent.trimEnd() + `\nmap_Kd ${textureFile}\n`;
                  await fs.writeFile(mtlPath, mtlContent);
                  console.log(`[Photogrammetry] Added texture reference to MTL: ${textureFile}`);
                }
              }
            } catch (e) {
              console.log(`[Photogrammetry] Could not fix MTL: ${e.message}`);
            }
            
            // Find texture file in model directory
            let textureFileName = null;
            try {
              const modelDirFiles = await fs.readdir(modelDir);
              const textureFile = modelDirFiles.find(f => 
                (f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.jpeg')) &&
                !f.includes('thumbnail')
              );
              if (textureFile) {
                textureFileName = textureFile;
                console.log(`[Photogrammetry] Found texture file: ${textureFile}`);
              }
            } catch (e) {
              console.log(`[Photogrammetry] Could not scan for texture files: ${e.message}`);
            }
            
            // Create thumbnail from first photo
            let thumbnailData = null;
            const imagesDir = path.join(scanDir, 'raw', 'images');
            const images = await fs.readdir(imagesDir).catch(() => []);
            if (images.length > 0) {
              const firstImage = path.join(imagesDir, images[0]);
              const imageBuffer = await fs.readFile(firstImage);
              thumbnailData = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
            }
            
            // Build model files object
            const modelFilesObj = {
              glb: 'model/model.glb',
              obj: 'model/model.obj',
              ply: 'model/model.ply',
              mtl: 'model/model.mtl'
            };
            if (textureFileName) {
              modelFilesObj.texture = `model/${textureFileName}`;
            }
            
            // Save to room scanner format
            const roomScanData = {
              id: roomScanId,
              roomName: metadata.roomName || 'Photogrammetry Scan',
              propertyId: metadata.propertyId || null,
              userId: metadata.userId || null,
              createdAt: metadata.createdAt,
              frameCount: results.num_images_registered || metadata.totalPhotos || 0,
              frames: [],
              thumbnailData,
              type: 'photogrammetry',
              scanType: 'photogrammetry',
              metadata: {
                scanType: 'photogrammetry',
                photogrammetryScanId: scanId,
                processingResult: {
                  numPoints: results.num_dense_points,
                  numVertices: results.num_mesh_vertices,
                  numFaces: results.num_mesh_faces,
                  numViewpoints: results.num_viewpoints,
                  dimensions: results.room_dimensions,
                  totalTime: results.total_time
                },
                modelFiles: modelFilesObj
              }
            };
            
            // Save metadata
            await fs.writeFile(
              path.join(roomScanDir, 'metadata.json'),
              JSON.stringify(roomScanData, null, 2)
            );
            
            console.log(`[Photogrammetry] Successfully saved to room scanner as ${roomScanId}`);
          } catch (saveErr) {
            console.error('[Photogrammetry] Failed to save to room scanner:', saveErr);
          }
        } else {
          const failureResult = await persistFailedWorkerState({
            scanDir,
            pipelineVersion,
            job,
            fallbackError: 'Photogrammetry processing failed',
          });
          console.error(`[Photogrammetry] Processing failed for ${scanId}: ${failureResult.error}`);
        }
      } catch (e) {
        console.error('Error updating metadata after processing:', e);
      }
    });
    
    res.json({
      success: true,
      message: 'Processing started',
      statusUrl: `/api/photogrammetry/scans/${scanId}/status`,
      progressUrl: `/api/photogrammetry/scans/${scanId}/progress`,
    });
  } catch (error) {
    console.error('Error starting processing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/photogrammetry/scans/:scanId/status
 * Get processing status
 */
router.get('/scans/:scanId/status', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    
    // Check active job
    const job = activeJobs.get(scanId);
    
    // Read progress file
    let progress = null;
    try {
      const progressPath = path.join(scanDir, 'progress.json');
      progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
    } catch (e) {
      // No progress file yet
    }
    
    // Read result file if exists
    let result = null;
    try {
      const resultPath = path.join(scanDir, 'result.json');
      result = JSON.parse(await fs.readFile(resultPath, 'utf-8'));
    } catch (e) {
      // No result yet
    }

    if (!result && job?.status === 'failed') {
      result = extractWorkerResult(job.output) || {
        success: false,
        error: job?.errors?.length ? String(job.errors[job.errors.length - 1] || '').trim() : 'Processing failed',
      };
    }
    
    res.json({
      scanId,
      processing: job?.status === 'running',
      status: result?.success ? 'completed' : (job?.status || progress?.phase || 'unknown'),
      progress,
      result: result ? {
        success: result.success,
        totalTime: result.total_time,
        numRegistered: result.num_images_registered,
        numPoints: result.num_dense_points,
        numVertices: result.num_mesh_vertices,
        numFaces: result.num_mesh_faces,
        numViewpoints: result.num_viewpoints,
        dimensions: result.room_dimensions,
        error: result.error,
      } : null,
    });
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/photogrammetry/scans/:scanId/progress
 * Server-Sent Events for progress updates
 */
router.get('/scans/:scanId/progress', async (req, res) => {
  const { scanId } = req.params;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
  const progressPath = path.join(scanDir, 'progress.json');
  
  let lastProgress = null;
  
  const checkProgress = async () => {
    try {
      const progress = JSON.parse(await fs.readFile(progressPath, 'utf-8'));
      const progressStr = JSON.stringify(progress);
      
      if (progressStr !== lastProgress) {
        lastProgress = progressStr;
        res.write(`data: ${progressStr}\n\n`);
        
        // End stream if complete or failed
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          clearInterval(interval);
          clearInterval(keepAliveInterval);
          res.end();
          return;
        }
      }
    } catch (e) {
      // Progress file doesn't exist yet
    }
  };
  
  // Send keep-alive comments every 15 seconds to prevent connection timeout
  // This is critical for Cloudflare tunnel which may close idle connections
  const keepAliveInterval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);
  
  const interval = setInterval(checkProgress, 1000);
  checkProgress();
  
  req.on('close', () => {
    clearInterval(interval);
    clearInterval(keepAliveInterval);
  });
});

/**
 * GET /api/photogrammetry/scans/:scanId/mesh
 * Get processed mesh (GLB)
 */
router.get('/scans/:scanId/mesh', async (req, res) => {
  try {
    const { scanId } = req.params;
    const format = req.query.format || 'glb';
    
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const meshPath = path.join(scanDir, 'exports', `model.${format}`);
    
    try {
      await fs.access(meshPath);
    } catch (e) {
      return res.status(404).json({ error: 'Mesh not found. Has processing completed?' });
    }
    
    const mimeTypes = {
      'glb': 'model/gltf-binary',
      'gltf': 'model/gltf+json',
      'obj': 'text/plain',
      'ply': 'application/octet-stream',
    };
    
    res.setHeader('Content-Type', mimeTypes[format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="room_scan.${format}"`);
    
    const stream = fsSync.createReadStream(meshPath);
    stream.pipe(res);
  } catch (error) {
    console.error('Error serving mesh:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/photogrammetry/scans/:scanId/navigation
 * Get navigation graph
 */
router.get('/scans/:scanId/navigation', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const navPath = path.join(scanDir, 'navigation', 'navigation.json');
    
    try {
      const navigation = JSON.parse(await fs.readFile(navPath, 'utf-8'));
      res.json(navigation);
    } catch (e) {
      return res.status(404).json({ error: 'Navigation not found' });
    }
  } catch (error) {
    console.error('Error serving navigation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/photogrammetry/scans/:scanId/texture
 * Get texture atlas
 */
router.get('/scans/:scanId/texture', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    
    // Try different texture paths
    const candidates = [
      path.join(scanDir, 'mesh', 'texture.jpg'),
      path.join(scanDir, 'mesh', 'texture.png'),
      path.join(scanDir, 'exports', 'texture.jpg'),
    ];
    
    for (const texPath of candidates) {
      try {
        await fs.access(texPath);
        const ext = path.extname(texPath);
        res.setHeader('Content-Type', ext === '.png' ? 'image/png' : 'image/jpeg');
        fsSync.createReadStream(texPath).pipe(res);
        return;
      } catch (e) {
        continue;
      }
    }
    
    res.status(404).json({ error: 'Texture not found' });
  } catch (error) {
    console.error('Error serving texture:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/scans/:scanId/save-to-room-scanner
 * Save completed photogrammetry scan to room scanner saved scans
 */
router.post('/scans/:scanId/save-to-room-scanner', express.json(), async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    
    // Read metadata and results
    const metadataPath = path.join(scanDir, 'raw', 'metadata.json');
    const resultsPath = path.join(scanDir, 'result.json');
    
    let metadata, results;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      results = JSON.parse(await fs.readFile(resultsPath, 'utf-8'));
    } catch (e) {
      return res.status(404).json({ 
        success: false, 
        error: 'Scan not found or not processed yet' 
      });
    }
    
    if (!results.success) {
      return res.status(400).json({ 
        success: false, 
        error: 'Processing failed, cannot save incomplete scan' 
      });
    }
    
    const { roomScanId } = await savePhotogrammetryScanToRoomScanner({
      scanId,
      scanDir,
      metadata,
      results,
      pipelineVersion: metadata.pipelineVersion || results.pipelineVersion || 'v1',
    });
    
    res.json({
      success: true,
      scanId: roomScanId,
      message: 'Photogrammetry scan saved to room scanner'
    });
  } catch (error) {
    console.error('[Photogrammetry] Error saving to room scanner:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/photogrammetry/scans
 * List all scans
 */
router.get('/scans', async (req, res) => {
  try {
    const photogrammetryDir = path.join(DATA_DIR, 'photogrammetry');
    
    try {
      await fs.access(photogrammetryDir);
    } catch (e) {
      return res.json({ success: true, scans: [] });
    }
    
    const entries = await fs.readdir(photogrammetryDir, { withFileTypes: true });
    const scans = [];
    
    // Support filtering by propertyId and userId
    const { propertyId, userId } = req.query;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      try {
        const metadataPath = path.join(photogrammetryDir, entry.name, 'raw', 'metadata.json');
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        
        // Apply filters
        if (propertyId && metadata.propertyId !== propertyId) continue;
        if (userId && metadata.userId !== userId) continue;
        
        const roomScanMirrorId = `photogrammetry_${entry.name}`;
        const hasResult = await fileExists(path.join(ROOM_SCANS_DIR, roomScanMirrorId, 'metadata.json')) ||
          await fileExists(path.join(photogrammetryDir, entry.name, 'exports', 'model.glb')) ||
          await fileExists(path.join(photogrammetryDir, entry.name, 'result.json')) ||
          await fileExists(path.join(photogrammetryDir, entry.name, 'v2_output', 'pipeline_stats.json')) ||
          await fileExists(path.join(photogrammetryDir, entry.name, 'hybrid_output', 'pipeline_stats.json')) ||
          await fileExists(path.join(photogrammetryDir, entry.name, 'hybrid_output', 'hybrid_manifest.json'));
        
        scans.push({
          id: entry.name,
          roomName: metadata.roomName || 'Untitled',
          createdAt: metadata.createdAt,
          totalPhotos: metadata.totalPhotos || 0,
          frameCount: metadata.totalPhotos || 0, // Alias for compatibility with room scanner
          status: hasResult ? 'completed' : (metadata.processingStatus || metadata.status),
          propertyId: metadata.propertyId,
          type: 'photogrammetry',
          metadata: {
            scanType: 'photogrammetry',
            photogrammetryScanId: entry.name,
            pipelineVersion: metadata.pipelineVersion || DEFAULT_PIPELINE_VERSION,
            roomScanId: await fileExists(path.join(ROOM_SCANS_DIR, roomScanMirrorId, 'metadata.json')) ? roomScanMirrorId : null,
          },
          hasThumbnail: false, // TODO: Generate thumbnails
        });
      } catch (e) {
        // Skip invalid scans
      }
    }
    
    // Sort by creation date
    scans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, scans });
  } catch (error) {
    console.error('Error listing scans:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/photogrammetry/scans/:scanId
 * Delete a scan
 */
router.delete('/scans/:scanId', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    
    // Check if processing
    if (activeJobs.has(scanId)) {
      const job = activeJobs.get(scanId);
      if (job.status === 'running') {
        job.process.kill();
      }
      activeJobs.delete(scanId);
    }
    
    // Delete directory
    await fs.rm(scanDir, { recursive: true, force: true });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting scan:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/scans/:scanId/cancel
 * Cancel processing
 */
router.post('/scans/:scanId/cancel', async (req, res) => {
  try {
    const { scanId } = req.params;
    
    const job = activeJobs.get(scanId);
    if (!job) {
      return res.status(404).json({ error: 'No active job found' });
    }
    
    if (job.status === 'running') {
      job.process.kill('SIGTERM');
      job.status = 'cancelled';
    }
    
    // Remove from active jobs to allow reprocessing
    activeJobs.delete(scanId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/photogrammetry/gcp/pending-jobs
 * List jobs on GCP VM that completed but weren't downloaded
 */
router.get('/gcp/pending-jobs', async (req, res) => {
  try {
    const { getGcpGpuWorker } = await import('../services/gcpGpuWorker.js');
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      return res.json({ jobs: [], message: 'GCP GPU Worker not enabled' });
    }
    
    const jobs = await worker.listCompletedJobs();
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Error listing GCP jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/photogrammetry/gcp/recover/:jobId
 * Recover a completed job from GCP VM that wasn't downloaded
 */
router.post('/gcp/recover/:jobId', express.json(), async (req, res) => {
  try {
    const { jobId } = req.params;
    const { outputDir } = req.body; // Remote output directory from listCompletedJobs
    
    if (!outputDir) {
      return res.status(400).json({ error: 'outputDir is required' });
    }
    
    const { getGcpGpuWorker } = await import('../services/gcpGpuWorker.js');
    const worker = getGcpGpuWorker();
    
    if (!worker.enabled) {
      return res.status(400).json({ error: 'GCP GPU Worker not enabled' });
    }
    
    // Create a local scan directory for the recovered job
    const scanId = `recovered_${jobId}`;
    const localScanDir = path.join(DATA_DIR, 'photogrammetry', scanId);
    const localDenseDir = path.join(localScanDir, 'dense');
    
    await fs.mkdir(localDenseDir, { recursive: true });
    
    // Recover the job
    const result = await worker.recoverJob(outputDir, localDenseDir);
    
    // Create a room scanner entry
    const roomScanId = `photogrammetry_${scanId}`;
    const roomScanDir = path.join(__dirname, '../data/room-scans', roomScanId);
    const modelDir = path.join(roomScanDir, 'model');
    await fs.mkdir(modelDir, { recursive: true });
    
    // Copy mesh files to room-scanner
    const filesToCopy = [
      { src: 'textured_mesh.obj', dest: 'model.obj' },
      { src: 'textured_mesh.mtl', dest: 'model.mtl' },
      { src: 'fused.ply', dest: 'model.ply' },
    ];
    
    for (const file of filesToCopy) {
      try {
        await fs.copyFile(
          path.join(localDenseDir, file.src),
          path.join(modelDir, file.dest)
        );
        console.log(`[Recovery] Copied ${file.src} -> ${file.dest}`);
      } catch (e) {
        console.warn(`[Recovery] Could not copy ${file.src}: ${e.message}`);
      }
    }
    
    // Copy textures
    const denseFiles = await fs.readdir(localDenseDir);
    let textureFileName = null;
    for (const file of denseFiles) {
      if (file.endsWith('.jpg') || file.endsWith('.png')) {
        await fs.copyFile(
          path.join(localDenseDir, file),
          path.join(modelDir, file)
        );
        textureFileName = file;
        console.log(`[Recovery] Copied texture: ${file}`);
      }
    }
    
    // Create metadata
    const modelFilesObj = {
      obj: 'model/model.obj',
      ply: 'model/model.ply',
      mtl: 'model/model.mtl'
    };
    if (textureFileName) {
      modelFilesObj.texture = `model/${textureFileName}`;
    }
    
    const roomScanData = {
      id: roomScanId,
      roomName: `Recovered Scan ${jobId}`,
      createdAt: new Date().toISOString(),
      frameCount: 0,
      frames: [],
      type: 'photogrammetry',
      scanType: 'photogrammetry',
      metadata: {
        scanType: 'photogrammetry',
        recovered: true,
        recoveredJobId: jobId,
        processingResult: {
          numPoints: result.num_dense_points,
          numSparsePoints: result.num_sparse_points,
        },
        modelFiles: modelFilesObj
      }
    };
    
    await fs.writeFile(
      path.join(roomScanDir, 'metadata.json'),
      JSON.stringify(roomScanData, null, 2)
    );
    
    console.log(`[Recovery] Successfully recovered job ${jobId} as ${roomScanId}`);
    
    res.json({
      success: true,
      scanId,
      roomScanId,
      result
    });
  } catch (error) {
    console.error('Error recovering GCP job:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
