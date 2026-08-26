import express from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';

import {
  ROOM_TOUR_PIPELINE_SPEC,
  attachMetadataToJob,
  attachVideoToJob,
  createRoomTourJob,
  getJobDir,
  listJobs,
  loadJob,
  queueRoomTourProcessing,
  resolveArtifactPath,
} from '../services/roomTourPipeline.js';
import { generateMobileScanToken } from '../auth.js';

const router = express.Router();
const LOCAL_ROOM_TOUR_BRIDGE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REMOTE_SCANNER_BASE_URL = (process.env.SCANNER_PUBLIC_URL || '').trim().replace(/\/+$/g, '');
const REMOTE_ROOM_TOUR_BRIDGE_ENABLED = process.env.NODE_ENV !== 'production' && Boolean(REMOTE_SCANNER_BASE_URL);

function safeParseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shouldBridgeRemoteRoomTours(req) {
  if (!REMOTE_ROOM_TOUR_BRIDGE_ENABLED) {
    return false;
  }

  const hostname = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  return LOCAL_ROOM_TOUR_BRIDGE_HOSTS.has(hostname);
}

function buildRemoteRoomTourUrl(relativePath) {
  return `${REMOTE_SCANNER_BASE_URL}${relativePath}`;
}

function createRemoteRoomTourHeaders() {
  return {
    'X-Mobile-Token': generateMobileScanToken(
      'local-room-tour-bridge',
      'admin@myhouseyield.com',
      'Local Room Tour Bridge',
      'admin',
    ),
  };
}

async function fetchRemoteRoomTourJson(req, relativePath, options = {}) {
  if (!shouldBridgeRemoteRoomTours(req)) {
    return null;
  }

  try {
    const response = await fetch(buildRemoteRoomTourUrl(relativePath), {
      method: options.method || 'GET',
      headers: {
        ...createRemoteRoomTourHeaders(),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      data: safeParseJson(text),
    };
  } catch (error) {
    console.warn(`[Room Tours] Remote room-tour JSON bridge failed for ${relativePath}:`, error.message);
    return null;
  }
}

function encodeArtifactPathSegments(artifactPath) {
  return String(artifactPath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function proxyRemoteRoomTourArtifact(req, res, relativePath) {
  if (!shouldBridgeRemoteRoomTours(req)) {
    return false;
  }

  try {
    const response = await fetch(buildRemoteRoomTourUrl(relativePath), {
      headers: createRemoteRoomTourHeaders(),
    });
    if (!response.ok) {
      return false;
    }

    res.status(response.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    for (const headerName of ['content-type', 'cache-control', 'content-length']) {
      const value = response.headers.get(headerName);
      if (value) {
        res.setHeader(headerName, value);
      }
    }

    const payload = Buffer.from(await response.arrayBuffer());
    res.send(payload);
    return true;
  } catch (error) {
    console.warn(`[Room Tours] Remote room-tour artifact bridge failed for ${relativePath}:`, error.message);
    return false;
  }
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { jobId } = req.params;
      const uploadDir = path.join(getJobDir(jobId), 'raw', 'video');
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname) || '.mp4';
    cb(null, `capture_${Date.now()}${extension.toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const acceptedMimeTypes = new Set([
      'video/mp4',
      'video/quicktime',
      'video/x-m4v',
      'video/webm',
      'application/octet-stream',
    ]);

    if (acceptedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(new Error(`Unsupported video type: ${file.mimetype}`));
  },
});

// Multer for individual chunks (10MB limit each)
const chunkStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { jobId } = req.params;
      const chunkDir = path.join(getJobDir(jobId), 'raw', 'chunks');
      await fs.mkdir(chunkDir, { recursive: true });
      cb(null, chunkDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const tempId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    cb(null, `upload_${tempId}.part`);
  },
});

const uploadChunk = multer({
  storage: chunkStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per chunk
});

router.get('/systems', (req, res) => {
  res.json({
    success: true,
    pipeline: ROOM_TOUR_PIPELINE_SPEC,
  });
});

router.get('/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();

    const remoteResult = await fetchRemoteRoomTourJson(req, '/api/room-tours/jobs');
    if (remoteResult?.data?.success && Array.isArray(remoteResult.data.jobs)) {
      const knownJobIds = new Set(jobs.map((job) => job.id));
      for (const remoteJob of remoteResult.data.jobs) {
        if (!knownJobIds.has(remoteJob.id)) {
          jobs.push(remoteJob);
        }
      }
    }

    jobs.sort((left, right) => {
      const leftCreatedAt = Date.parse(left.createdAt || '') || 0;
      const rightCreatedAt = Date.parse(right.createdAt || '') || 0;
      return rightCreatedAt - leftCreatedAt;
    });

    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs', express.json(), async (req, res) => {
  try {
    const job = await createRoomTourJob(req.body || {});
    res.json({
      success: true,
      job,
      uploadUrl: `/api/room-tours/jobs/${job.id}/video`,
      metadataUrl: `/api/room-tours/jobs/${job.id}/metadata`,
      processUrl: `/api/room-tours/jobs/${job.id}/process`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    const job = await loadJob(req.params.jobId);
    res.json({ success: true, job });
  } catch (error) {
    const remoteResult = await fetchRemoteRoomTourJson(req, `/api/room-tours/jobs/${encodeURIComponent(req.params.jobId)}`);
    if (remoteResult?.data?.success && remoteResult.data.job) {
      return res.json(remoteResult.data);
    }

    res.status(404).json({ success: false, error: 'job_not_found' });
  }
});

router.get('/jobs/:jobId/artifacts/*', async (req, res) => {
  const rawArtifactPath = req.params[0] || '';

  try {
    const artifactPath = await resolveArtifactPath(req.params.jobId, rawArtifactPath);
    res.sendFile(artifactPath);
  } catch (error) {
    if (error.message !== 'invalid_artifact_path') {
      const encodedArtifactPath = encodeArtifactPathSegments(rawArtifactPath);
      const remoteArtifactPath = `/api/room-tours/jobs/${encodeURIComponent(req.params.jobId)}/artifacts/${encodedArtifactPath}`;
      if (await proxyRemoteRoomTourArtifact(req, res, remoteArtifactPath)) {
        return;
      }
    }

    const status = error.message === 'invalid_artifact_path' ? 400 : 404;
    res.status(status).json({ success: false, error: error.message || 'artifact_not_found' });
  }
});

router.post('/jobs/:jobId/video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'video_required' });
    }

    const job = await attachVideoToJob(req.params.jobId, req.file);
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Chunked upload: receive one chunk at a time
router.post('/jobs/:jobId/video/chunk', uploadChunk.single('chunk'), async (req, res) => {
  try {
    const { jobId } = req.params;
    const chunkIndex = parseInt(req.body?.chunkIndex ?? '0', 10);
    const totalChunks = parseInt(req.body?.totalChunks ?? '1', 10);
    const mimeType = req.body?.mimeType || 'video/mp4';
    const fileName = req.body?.fileName || `capture_${Date.now()}.mp4`;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'chunk_required' });
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(totalChunks) || totalChunks < 1) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      return res.status(400).json({ success: false, error: 'invalid_chunk_metadata' });
    }

    const existingJob = await loadJob(jobId).catch(() => null);
    if (existingJob?.capture?.videoUploaded) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      return res.json({ success: true, job: existingJob, alreadyUploaded: true });
    }

    const chunkDir = path.join(getJobDir(jobId), 'raw', 'chunks');
    const chunkPath = path.join(chunkDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
    await fs.rename(req.file.path, chunkPath);

    // If this is the last chunk, assemble all chunks into the final video file
    if (chunkIndex === totalChunks - 1) {
      const videoDir = path.join(getJobDir(jobId), 'raw', 'video');
      await fs.mkdir(videoDir, { recursive: true });

      const extension = path.extname(fileName) || (mimeType.includes('mp4') ? '.mp4' : '.webm');
      const finalPath = path.join(videoDir, `capture_${Date.now()}${extension}`);

      // Assemble ordered chunks into final file
      const writeStream = createWriteStream(finalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(6, '0')}`);
        const chunkData = await fs.readFile(chunkPath);
        await new Promise((resolve, reject) => {
          writeStream.write(chunkData, (err) => (err ? reject(err) : resolve()));
        });
      }
      await new Promise((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())));

      // Clean up chunk files
      await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});

      // Register the assembled file with the pipeline
      const fakeFile = {
        fieldname: 'video',
        originalname: fileName,
        filename: path.basename(finalPath),
        path: finalPath,
        destination: videoDir,
        mimetype: mimeType,
        size: (await fs.stat(finalPath)).size,
      };
      const job = await attachVideoToJob(jobId, fakeFile);
      return res.json({ success: true, job, assembled: true });
    }

    // Intermediate chunk — just acknowledge receipt
    res.json({ success: true, chunkIndex, received: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/metadata', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const job = await attachMetadataToJob(req.params.jobId, req.body || {});
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/process', express.json(), async (req, res) => {
  try {
    const job = await queueRoomTourProcessing(req.params.jobId, req.body || {});
    res.json({
      success: true,
      job,
      pipeline: ROOM_TOUR_PIPELINE_SPEC,
    });
  } catch (error) {
    const status = error.message === 'video_not_uploaded' ? 400 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

export default router;