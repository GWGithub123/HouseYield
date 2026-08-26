import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

import {
  MASTER_PIPELINE_SPEC,
  attachImagesToJob,
  attachMetadataToJob,
  attachVideoToJob,
  createMasterJob,
  getJobDir,
  listJobs,
  loadJob,
  queueMasterProcessing,
  resolveArtifactPath,
} from '../services/masterPipeline.js';

const router = express.Router();

const imageStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadDir = path.join(getJobDir(req.params.jobId), 'input', 'raw_images');
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname) || '.jpg';
    const stem = path.basename(file.originalname, extension).replace(/[^a-zA-Z0-9_-]+/g, '_');
    cb(null, `${stem}_${Date.now()}${extension.toLowerCase()}`);
  },
});

const videoStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadDir = path.join(getJobDir(req.params.jobId), 'input', 'raw_video');
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

const uploadImages = multer({
  storage: imageStorage,
  limits: { fileSize: 50 * 1024 * 1024, files: 500 },
  fileFilter: (req, file, cb) => {
    const acceptedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/heif',
      'application/octet-stream',
    ]);

    if (acceptedMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(new Error(`Unsupported image type: ${file.mimetype}`));
  },
});

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
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

router.get('/systems', (req, res) => {
  res.json({
    success: true,
    pipeline: MASTER_PIPELINE_SPEC,
    architectureDoc: '/MASTER_V1_PIPELINE_PLAN.md',
  });
});

router.get('/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();
    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs', express.json(), async (req, res) => {
  try {
    const job = await createMasterJob(req.body || {});
    res.json({
      success: true,
      job,
      imagesUploadUrl: `/api/master-reconstruction/jobs/${job.id}/images`,
      videoUploadUrl: `/api/master-reconstruction/jobs/${job.id}/video`,
      metadataUrl: `/api/master-reconstruction/jobs/${job.id}/metadata`,
      processUrl: `/api/master-reconstruction/jobs/${job.id}/process`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    const job = await loadJob(req.params.jobId);
    res.json({ success: true, job });
  } catch {
    res.status(404).json({ success: false, error: 'job_not_found' });
  }
});

router.get('/jobs/:jobId/artifacts/*', async (req, res) => {
  try {
    const artifactPath = await resolveArtifactPath(req.params.jobId, req.params[0] || '');
    res.sendFile(artifactPath);
  } catch (error) {
    const status = error.message === 'invalid_artifact_path' ? 400 : 404;
    res.status(status).json({ success: false, error: error.message || 'artifact_not_found' });
  }
});

router.post('/jobs/:jobId/images', uploadImages.array('images', 500), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'images_required' });
    }

    const job = await attachImagesToJob(req.params.jobId, req.files);
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/jobs/:jobId/video', uploadVideo.single('video'), async (req, res) => {
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
    const job = await queueMasterProcessing(req.params.jobId, req.body || {});
    res.json({
      success: true,
      job,
      pipeline: MASTER_PIPELINE_SPEC,
    });
  } catch (error) {
    const status = error.message === 'input_not_uploaded' ? 400 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

export default router;