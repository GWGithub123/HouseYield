import 'dotenv/config';

import express from 'express';
import { pathToFileURL } from 'url';

import { measureFromPhotos, normalizeVisionModelImages } from '../../services/photoMeasurementService.js';

const DEFAULT_BODY_LIMIT = process.env.RENOVATION_MEASUREMENT_API_BODY_LIMIT || '150mb';
const DEFAULT_MAX_IMAGES = Number(process.env.RENOVATION_MEASUREMENT_API_MAX_IMAGES || 24);

function createApiKeyMiddleware(apiKey = '') {
  const normalizedApiKey = String(apiKey || '').trim();
  return (req, res, next) => {
    if (!normalizedApiKey || req.path === '/healthz') {
      next();
      return;
    }

    const bearer = String(req.get('authorization') || '');
    const token = bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
    const xApiKey = String(req.get('x-api-key') || '').trim();
    if (token === normalizedApiKey || xApiKey === normalizedApiKey) {
      next();
      return;
    }

    res.status(401).json({ ok: false, error: 'Unauthorized' });
  };
}

function buildServiceStatus() {
  return {
    ok: true,
    service: 'renovation-measurement-api',
    detectorUrlConfigured: Boolean(process.env.MEASUREMENT_TARGET_DETECTOR_URL),
    segmenterUrlConfigured: Boolean(process.env.MEASUREMENT_TARGET_SEGMENTATION_URL),
    roomGeometryAssistUrlConfigured: Boolean(process.env.ROOM_GEOMETRY_ASSIST_URL),
    roomGeometryGcpAssistEnabled: process.env.ROOM_GEOMETRY_GCP_ASSIST_ENABLE === 'true',
  };
}

function validateImageArray(images) {
  return Array.isArray(images) && images.length > 0 && images.every(image => typeof image === 'string' && image.length > 0);
}

export function createRenovationMeasurementApi() {
  const app = express();
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(createApiKeyMiddleware(process.env.RENOVATION_MEASUREMENT_API_KEY || ''));

  app.use((error, _req, res, next) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ ok: false, error: 'Request body too large' });
      return;
    }
    next(error);
  });

  app.get('/healthz', (_req, res) => {
    res.json(buildServiceStatus());
  });

  app.post('/normalize-images', async (req, res) => {
    try {
      const images = Array.isArray(req.body?.images) ? req.body.images : [];
      if (!validateImageArray(images)) {
        res.status(400).json({ ok: false, error: 'images must be a non-empty array of base64 or URL strings' });
        return;
      }

      const imagesForProcessing = images.slice(0, DEFAULT_MAX_IMAGES);
      const normalizedImages = await normalizeVisionModelImages(imagesForProcessing);
      res.json({
        ok: true,
        images: normalizedImages,
        imageCount: normalizedImages.length,
        truncated: images.length > imagesForProcessing.length,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'normalize-images failed' });
    }
  });

  app.post('/measure-from-photos', async (req, res) => {
    try {
      const images = Array.isArray(req.body?.images) ? req.body.images : [];
      const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
      if (!validateImageArray(images)) {
        res.status(400).json({ ok: false, error: 'images must be a non-empty array of base64 or URL strings' });
        return;
      }

      const imagesForProcessing = images.slice(0, DEFAULT_MAX_IMAGES);
      const result = await measureFromPhotos(imagesForProcessing, options);
      res.json({
        ...result,
        imageCount: imagesForProcessing.length,
        truncated: images.length > imagesForProcessing.length,
        executedBy: 'renovation-measurement-api',
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'measure-from-photos failed' });
    }
  });

  return app;
}

export function startRenovationMeasurementApi() {
  const app = createRenovationMeasurementApi();
  const host = process.env.RENOVATION_MEASUREMENT_API_HOST || '0.0.0.0';
  const port = Number(process.env.RENOVATION_MEASUREMENT_API_PORT || process.env.PORT || 8090);
  app.listen(port, host, () => {
    console.log(`[RenovationMeasurementApi] listening on http://${host}:${port}`);
  });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  startRenovationMeasurementApi();
}