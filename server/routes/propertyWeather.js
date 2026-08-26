import express from 'express';
import { requireAuth } from '../firebase-admin.js';
import { buildExtremeWeatherAssessment } from '../services/extremeWeatherService.js';

const router = express.Router();

/**
 * GET /api/property-weather/assessment?propertyId=...
 * Optional: latitude, longitude, address, refresh=1
 */
router.get('/assessment', requireAuth, async (req, res) => {
  try {
    const propertyId = String(req.query.propertyId || '').trim();
    if (!propertyId) {
      return res.status(400).json({ success: false, error: 'propertyId is required' });
    }

    const latitude = req.query.latitude != null && req.query.latitude !== ''
      ? Number(req.query.latitude)
      : null;
    const longitude = req.query.longitude != null && req.query.longitude !== ''
      ? Number(req.query.longitude)
      : null;
    const address = typeof req.query.address === 'string' ? req.query.address : '';
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

    const assessment = await buildExtremeWeatherAssessment({
      ownerId: req.user?.uid,
      propertyId,
      latitude,
      longitude,
      address,
      forceRefresh,
    });

    res.json({ success: true, assessment });
  } catch (error) {
    const status = error.status || 500;
    console.error('[PropertyWeather] Assessment failed:', error.message);
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to build weather assessment',
      code: error.code || undefined,
    });
  }
});

export default router;
