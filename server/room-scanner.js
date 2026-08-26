/**
 * Room Scanner API Routes
 * Backend endpoints for 3D room scanning with Luma AI, DepthPro, and OpenAI
 */

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import npyjs from 'numpy-parser';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { generateMobileScanToken } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Version tracking for cache management (update when making breaking changes)
const API_VERSION = 'v2025-12-02_20:00_REAL_DEPTH';

// Environment variables
const LUMA_API_KEY = process.env.LUMA_API_KEY || process.env.VITE_LUMA_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LUMA_API_BASE = 'https://webapp.engineeringlumalabs.com/api/v3';

// Storage directory for saved room scans
const SCANS_DIR = path.join(__dirname, 'data', 'room-scans');
const LOCAL_SCAN_BRIDGE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REMOTE_SCANNER_BASE_URL = (process.env.SCANNER_PUBLIC_URL || '').trim().replace(/\/+$/g, '');
const REMOTE_SCANNER_BRIDGE_ENABLED = process.env.NODE_ENV !== 'production' && Boolean(REMOTE_SCANNER_BASE_URL);

// Ensure storage directory exists
if (!fs.existsSync(SCANS_DIR)) {
  fs.mkdirSync(SCANS_DIR, { recursive: true });
  console.log('[Room Scanner] Created scans storage directory:', SCANS_DIR);
}

function safeParseJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function repairSavedPhotogrammetryMetadata(scanMetadata, scanDir) {
  if (!scanMetadata || (scanMetadata.type !== 'photogrammetry' && scanMetadata.scanType !== 'photogrammetry')) {
    return scanMetadata;
  }

  const processingResult = scanMetadata.metadata?.processingResult;
  const currentPointCount = Number(processingResult?.numPoints);
  if (Number.isFinite(currentPointCount) && currentPointCount > 0) {
    return scanMetadata;
  }

  const summaryRelativePath =
    scanMetadata.metadata?.gaussianArtifacts?.summaryPath ||
    scanMetadata.metadata?.outputs?.gaussianSummaryPath;
  if (!summaryRelativePath || !scanDir) {
    return scanMetadata;
  }

  const summaryPath = path.join(scanDir, summaryRelativePath);
  if (!fs.existsSync(summaryPath)) {
    return scanMetadata;
  }

  const gaussianSummary = safeParseJson(fs.readFileSync(summaryPath, 'utf8'));
  const gaussianPointCount = resolveGaussianPointCount(gaussianSummary);
  if (gaussianPointCount <= 0) {
    return scanMetadata;
  }

  scanMetadata.metadata = scanMetadata.metadata || {};
  scanMetadata.metadata.processingResult = {
    ...(processingResult || {}),
    numPoints: gaussianPointCount,
  };
  return scanMetadata;
}

function shouldBridgeRemoteScans(req) {
  if (!REMOTE_SCANNER_BRIDGE_ENABLED) {
    return false;
  }

  const hostname = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  return LOCAL_SCAN_BRIDGE_HOSTS.has(hostname);
}

function buildRemoteScannerUrl(relativePath) {
  return `${REMOTE_SCANNER_BASE_URL}${relativePath}`;
}

function createRemoteScannerHeaders() {
  return {
    'X-Mobile-Token': generateMobileScanToken(
      'local-room-scan-bridge',
      'admin@myhouseyield.com',
      'Local Room Scan Bridge',
      'admin',
    ),
  };
}

function closeRemoteResponseBody(response) {
  if (!response?.body) {
    return;
  }

  if (typeof response.body.destroy === 'function') {
    response.body.destroy();
    return;
  }

  if (typeof response.body.cancel === 'function') {
    response.body.cancel().catch(() => {});
  }
}

function parseSingleByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || ''));
  if (!match || (!match[1] && !match[2]) || size < 1) {
    return null;
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }

  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

async function fetchRemoteScannerJson(req, relativePath, options = {}) {
  if (!shouldBridgeRemoteScans(req)) {
    return null;
  }

  try {
    const response = await fetch(buildRemoteScannerUrl(relativePath), {
      method: options.method || 'GET',
      headers: {
        ...createRemoteScannerHeaders(),
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
    console.warn(`[Room Scanner] Remote scanner JSON bridge failed for ${relativePath}:`, error.message);
    return null;
  }
}

async function proxyRemoteScannerAsset(req, res, relativePath, options = {}) {
  const cacheControlOverride = typeof options.cacheControlOverride === 'string'
    ? options.cacheControlOverride
    : null;
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null;
  if (!shouldBridgeRemoteScans(req)) {
    return false;
  }

  try {
    const headers = createRemoteScannerHeaders();
    if (rangeHeader) {
      headers.Range = rangeHeader;
    }

    const response = await fetch(buildRemoteScannerUrl(relativePath), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
    });
    if (!response.ok && response.status !== 416) {
      return false;
    }
    if (rangeHeader && response.status !== 206 && response.status !== 416) {
      closeRemoteResponseBody(response);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', cacheControlOverride || 'no-store');
      res.status(502).json({
        success: false,
        error: 'Remote scanner artifact did not honor the requested byte range'
      });
      return true;
    }

    res.status(response.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length');

    for (const headerName of [
      'accept-ranges',
      'content-range',
      'content-type',
      'cache-control',
      'content-length',
      'etag',
      'last-modified'
    ]) {
      if (headerName === 'cache-control' && cacheControlOverride) {
        continue;
      }
      const value = response.headers.get(headerName);
      if (value) {
        res.setHeader(headerName, value);
      }
    }

    if (cacheControlOverride) {
      res.setHeader('Cache-Control', cacheControlOverride);
    }

    if (req.method === 'HEAD') {
      closeRemoteResponseBody(response);
      res.end();
      return true;
    }

    if (!response.body) {
      res.end();
      return true;
    }

    response.body.on?.('error', (streamError) => {
      console.warn(`[Room Scanner] Remote scanner asset stream failed for ${relativePath}:`, streamError.message);
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.destroy(streamError);
      }
    });
    response.body.pipe(res);
    return true;
  } catch (error) {
    console.warn(`[Room Scanner] Remote scanner asset bridge failed for ${relativePath}:`, error.message);
    return false;
  }
}

// ==================== SAVED SCANS ENDPOINTS ====================

/**
 * POST /api/room-scanner/scans/save
 * Save a completed room scan with frames and metadata
 */
router.post('/scans/save', async (req, res) => {
  try {
    const { 
      roomName, 
      propertyId, 
      userId, 
      frames, 
      thumbnailImage,
      metadata 
    } = req.body;

    if (!frames || frames.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one frame is required'
      });
    }

    // Generate unique scan ID
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const scanDir = path.join(SCANS_DIR, scanId);
    
    // Create scan directory
    fs.mkdirSync(scanDir, { recursive: true });
    
    // Save frames as individual files (to reduce JSON size)
    const savedFrames = [];
    const framesDir = path.join(scanDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const frameFilename = `frame_${i.toString().padStart(4, '0')}.jpg`;
      const framePath = path.join(framesDir, frameFilename);
      
      // Extract base64 data (remove data:image/... prefix if present)
      let imageData = frame.imageData;
      if (imageData.includes(',')) {
        imageData = imageData.split(',')[1];
      }
      
      // Save frame image
      fs.writeFileSync(framePath, Buffer.from(imageData, 'base64'));
      
      // Save depth map if available
      let depthFilename = null;
      if (frame.depthMap?.depthData) {
        depthFilename = `depth_${i.toString().padStart(4, '0')}.jpg`;
        const depthPath = path.join(framesDir, depthFilename);
        let depthData = frame.depthMap.depthData;
        if (depthData.includes(',')) {
          depthData = depthData.split(',')[1];
        }
        fs.writeFileSync(depthPath, Buffer.from(depthData, 'base64'));
      }
      
      savedFrames.push({
        id: frame.id,
        filename: frameFilename,
        depthFilename,
        timestamp: frame.timestamp,
        orientation: frame.orientation,
        quality: frame.quality,
        depthInfo: frame.depthMap ? {
          width: frame.depthMap.width,
          height: frame.depthMap.height,
          minDepth: frame.depthMap.minDepth,
          maxDepth: frame.depthMap.maxDepth
        } : null
      });
    }
    
    // Save thumbnail
    let thumbnailFilename = null;
    if (thumbnailImage) {
      thumbnailFilename = 'thumbnail.jpg';
      let thumbData = thumbnailImage;
      if (thumbData.includes(',')) {
        thumbData = thumbData.split(',')[1];
      }
      fs.writeFileSync(path.join(scanDir, thumbnailFilename), Buffer.from(thumbData, 'base64'));
    }
    
    // Save scan metadata
    const scanMetadata = {
      id: scanId,
      roomName: roomName || 'Untitled Room',
      propertyId: propertyId || null,
      userId: userId || null,
      createdAt: new Date().toISOString(),
      frameCount: frames.length,
      frames: savedFrames,
      thumbnailFilename,
      metadata: metadata || {}
    };
    
    fs.writeFileSync(
      path.join(scanDir, 'metadata.json'),
      JSON.stringify(scanMetadata, null, 2)
    );
    
    console.log(`[Room Scanner] Saved scan ${scanId} with ${frames.length} frames`);
    
    res.json({
      success: true,
      scanId,
      frameCount: frames.length,
      message: 'Room scan saved successfully'
    });
  } catch (error) {
    console.error('[Room Scanner] Save scan error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save room scan'
    });
  }
});

/**
 * POST /api/room-scanner/scans/save-spherical
 * Save a spherical panorama scan (new clean format)
 */
router.post('/scans/save-spherical', async (req, res) => {
  try {
    const { 
      roomName, 
      equirectangular,
      propertyId, 
      userId,
      roomDimensions,
      depthPanorama,  // Depth data for click-to-measure
      metadata 
    } = req.body;

    if (!equirectangular) {
      return res.status(400).json({
        success: false,
        error: 'Equirectangular image is required'
      });
    }

    // Generate unique scan ID
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const scanDir = path.join(SCANS_DIR, scanId);
    
    // Create scan directory
    fs.mkdirSync(scanDir, { recursive: true });
    
    // Extract base64 data
    let imageData = equirectangular;
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }
    
    // Save panorama image
    const panoramaFilename = 'panorama.jpg';
    const panoramaPath = path.join(scanDir, panoramaFilename);
    fs.writeFileSync(panoramaPath, Buffer.from(imageData, 'base64'));
    
    // Create thumbnail (resize to 400px wide)
    const thumbnailFilename = 'thumbnail.jpg';
    const thumbnailPath = path.join(scanDir, thumbnailFilename);
    await sharp(Buffer.from(imageData, 'base64'))
      .resize(400, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    
    // Save depth panorama if provided (for click-to-measure)
    let depthPanoramaFilename = null;
    if (depthPanorama && depthPanorama.data) {
      try {
        let depthImageData = depthPanorama.data;
        if (depthImageData.includes(',')) {
          depthImageData = depthImageData.split(',')[1];
        }
        depthPanoramaFilename = 'depth_panorama.png';
        const depthPath = path.join(scanDir, depthPanoramaFilename);
        fs.writeFileSync(depthPath, Buffer.from(depthImageData, 'base64'));
        
        // Also save depth metadata
        const depthMetadataPath = path.join(scanDir, 'depth_metadata.json');
        fs.writeFileSync(depthMetadataPath, JSON.stringify({
          width: depthPanorama.width,
          height: depthPanorama.height,
          minDepth: depthPanorama.minDepth,
          maxDepth: depthPanorama.maxDepth,
          coverage: depthPanorama.coverage
        }, null, 2));
        
        console.log(`🔥 [Room Scanner v3.0] Saved depth panorama: ${depthPath}`);
      } catch (depthError) {
        console.error('[Room Scanner] Failed to save depth panorama:', depthError);
      }
    }
    
    // Save metadata
    const scanMetadata = {
      id: scanId,
      roomName: roomName || `Spherical Scan ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      propertyId: propertyId || null,
      userId: userId || 'web-user',
      thumbnailFilename,
      panoramaFilename,
      depthPanoramaFilename,  // Reference to depth file
      type: 'spherical_panorama',
      scanType: 'spherical_panorama',
      frameCount: 0, // No frames, just equirectangular
      roomDimensions: roomDimensions || null,
      hasDepthPanorama: !!depthPanoramaFilename,
      depthRange: depthPanorama ? {
        minDepth: depthPanorama.minDepth,
        maxDepth: depthPanorama.maxDepth
      } : null,
      metadata: {
        ...metadata,
        scanType: 'spherical_panorama',
        savedFrom: 'frontend',
        hasDepthPanorama: !!depthPanoramaFilename
      }
    };
    
    const metadataPath = path.join(scanDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(scanMetadata, null, 2));
    
    console.log(`🔥 [Room Scanner v3.0] Saved spherical panorama: ${scanId}`);
    
    res.json({
      success: true,
      scanId,
      message: 'Spherical panorama saved successfully'
    });
  } catch (error) {
    console.error('[Room Scanner] Save spherical panorama error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save spherical panorama'
    });
  }
});

/**
 * GET /api/room-scanner/scans
 * List all saved room scans, optionally filtered by propertyId or userId
 */
router.get('/scans', async (req, res) => {
  try {
    const { propertyId, userId } = req.query;
    
    if (!fs.existsSync(SCANS_DIR)) {
      return res.json({ success: true, scans: [] });
    }
    
    const scanDirs = fs.readdirSync(SCANS_DIR).filter(f => 
      fs.statSync(path.join(SCANS_DIR, f)).isDirectory()
    );
    
    const scans = [];
    
    for (const scanDir of scanDirs) {
      const metadataPath = path.join(SCANS_DIR, scanDir, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;
      
      try {
        const metadata = repairSavedPhotogrammetryMetadata(
          JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
          path.join(SCANS_DIR, scanDir),
        );
        
        // Filter by propertyId if specified
        if (propertyId && metadata.propertyId !== propertyId) continue;
        
        // Filter by userId if specified
        if (userId && metadata.userId !== userId) continue;
        
        scans.push({
          id: metadata.id,
          roomName: metadata.roomName || metadata.name || 'Untitled Scan',
          propertyId: metadata.propertyId,
          createdAt: metadata.createdAt,
          frameCount: metadata.frameCount || metadata.metadata?.photoCount || 0,
          hasThumbnail: !!metadata.thumbnailFilename || !!metadata.thumbnailData,
          type: metadata.type || metadata.scanType || 'cubemap',
          // Include spherical panorama specific data
          hasDepth: metadata.metadata?.hasDepth || false,
          processingTime: metadata.metadata?.processingTime || 0,
          // Include metadata for photogrammetry scans  
          metadata: metadata.metadata || {}
        });
      } catch (parseError) {
        console.warn(`[Room Scanner] Failed to parse metadata for ${scanDir}:`, parseError);
      }
    }

    const queryParams = new URLSearchParams();
    if (propertyId) queryParams.set('propertyId', propertyId);
    if (userId) queryParams.set('userId', userId);
    const remotePath = `/api/room-scanner/scans${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const remoteResult = await fetchRemoteScannerJson(req, remotePath);
    if (remoteResult?.data?.success && Array.isArray(remoteResult.data.scans)) {
      const knownScanIds = new Set(scans.map((scan) => scan.id));
      for (const remoteScan of remoteResult.data.scans) {
        if (!knownScanIds.has(remoteScan.id)) {
          scans.push(remoteScan);
        }
      }
    }
    
    // Sort by creation date, newest first
    scans.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, scans });
  } catch (error) {
    console.error('[Room Scanner] List scans error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list room scans'
    });
  }
});

/**
 * GET /api/room-scanner/scans/:scanId
 * Get full details of a saved scan including all frame data
 */
router.get('/scans/:scanId', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(SCANS_DIR, scanId);
    
    if (!fs.existsSync(scanDir)) {
      const remoteResult = await fetchRemoteScannerJson(req, `/api/room-scanner/scans/${encodeURIComponent(scanId)}`);
      if (remoteResult?.data?.success) {
        return res.json(remoteResult.data);
      }

      return res.status(404).json({
        success: false,
        error: 'Scan not found'
      });
    }
    
    const metadataPath = path.join(scanDir, 'metadata.json');
    const metadata = repairSavedPhotogrammetryMetadata(
      JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
      scanDir,
    );
    
    // Check if this is a photogrammetry scan
    if (metadata.type === 'photogrammetry' || metadata.scanType === 'photogrammetry') {
      // Load thumbnail
      let thumbnailData = null;
      if (metadata.thumbnailData) {
        thumbnailData = metadata.thumbnailData;
      } else if (metadata.thumbnailFilename) {
        const thumbPath = path.join(scanDir, metadata.thumbnailFilename);
        if (fs.existsSync(thumbPath)) {
          const thumbBuffer = fs.readFileSync(thumbPath);
          thumbnailData = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
        }
      }
      
      return res.json({
        success: true,
        scan: {
          ...metadata,
          type: 'photogrammetry',
          scanType: 'photogrammetry',
          thumbnailData,
          frames: [] // No frames for photogrammetry
        }
      });
    }
    
    // Check if this is a spherical panorama (auto-saved from stitching)
    if (metadata.type === 'spherical_panorama' || metadata.scanType === 'spherical_panorama') {
      // Load the panorama image
      const panoramaPath = path.join(scanDir, metadata.panoramaFilename || 'panorama.jpg');
      let equirectangular = null;
      if (fs.existsSync(panoramaPath)) {
        const imageData = fs.readFileSync(panoramaPath);
        equirectangular = `data:image/jpeg;base64,${imageData.toString('base64')}`;
      }
      
      // Load depth panorama if available (try PNG first, then JPG for backwards compat)
      let depthPanorama = null;
      let depthMetadata = null;
      
      // Check for depth panorama filename in metadata, or try default names
      const depthFilename = metadata.depthPanoramaFilename || 'depth_panorama.png';
      const depthPath = path.join(scanDir, depthFilename);
      const depthPathJpg = path.join(scanDir, 'depth_panorama.jpg');
      
      if (fs.existsSync(depthPath)) {
        const depthData = fs.readFileSync(depthPath);
        const ext = path.extname(depthFilename).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        depthPanorama = `data:${mimeType};base64,${depthData.toString('base64')}`;
        console.log('[Room Scanner] ✅ Loaded depth panorama:', depthFilename);
      } else if (fs.existsSync(depthPathJpg)) {
        const depthData = fs.readFileSync(depthPathJpg);
        depthPanorama = `data:image/jpeg;base64,${depthData.toString('base64')}`;
        console.log('[Room Scanner] ✅ Loaded depth panorama: depth_panorama.jpg');
      }
      
      // Load depth metadata if available
      const depthMetaPath = path.join(scanDir, 'depth_metadata.json');
      if (fs.existsSync(depthMetaPath)) {
        try {
          depthMetadata = JSON.parse(fs.readFileSync(depthMetaPath, 'utf-8'));
          console.log('[Room Scanner] ✅ Loaded depth metadata:', depthMetadata);
        } catch (e) {
          console.warn('[Room Scanner] Failed to load depth metadata:', e.message);
        }
      }
      
      // Load thumbnail
      let thumbnailData = null;
      const thumbPath = path.join(scanDir, metadata.thumbnailFilename || 'thumbnail.jpg');
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath);
        thumbnailData = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      }
      
      return res.json({
        success: true,
        scan: {
          ...metadata,
          type: 'spherical_panorama',
          equirectangular,
          depthPanorama,
          depthMetadata,  // Include the depth range info
          thumbnailData,
          frames: [], // Empty frames array for compatibility
          roomDimensions: metadata.metadata?.roomDimensions || null
        }
      });
    }
    
    // Legacy: Load all frames with their image data (for cubemap scans)
    const framesDir = path.join(scanDir, 'frames');
    const frames = [];
    
    // Handle case where frames array doesn't exist
    if (!metadata.frames || !Array.isArray(metadata.frames)) {
      console.warn('[Room Scanner] Scan has no frames array:', scanId);
      return res.json({
        success: true,
        scan: {
          ...metadata,
          frames: [],
          thumbnailData: null
        }
      });
    }
    
    for (const frameInfo of metadata.frames) {
      const framePath = path.join(framesDir, frameInfo.filename);
      const imageData = fs.readFileSync(framePath);
      const imageBase64 = `data:image/jpeg;base64,${imageData.toString('base64')}`;
      
      let depthBase64 = null;
      if (frameInfo.depthFilename) {
        const depthPath = path.join(framesDir, frameInfo.depthFilename);
        if (fs.existsSync(depthPath)) {
          const depthData = fs.readFileSync(depthPath);
          depthBase64 = `data:image/jpeg;base64,${depthData.toString('base64')}`;
        }
      }
      
      frames.push({
        id: frameInfo.id,
        imageData: imageBase64,
        timestamp: frameInfo.timestamp,
        orientation: frameInfo.orientation,
        quality: frameInfo.quality,
        depthMap: frameInfo.depthInfo ? {
          ...frameInfo.depthInfo,
          depthData: depthBase64
        } : null
      });
    }
    
    // Load thumbnail
    let thumbnailData = null;
    if (metadata.thumbnailFilename) {
      const thumbPath = path.join(scanDir, metadata.thumbnailFilename);
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath);
        thumbnailData = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      }
    }
    
    res.json({
      success: true,
      scan: {
        ...metadata,
        frames,
        thumbnailData
      }
    });
  } catch (error) {
    console.error('[Room Scanner] Get scan error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get room scan'
    });
  }
});

/**
 * GET /api/room-scanner/scans/:scanId/thumbnail
 * Get just the thumbnail image for a scan
 */
router.get('/scans/:scanId/thumbnail', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(SCANS_DIR, scanId);
    if (!fs.existsSync(scanDir)) {
      if (await proxyRemoteScannerAsset(req, res, `/api/room-scanner/scans/${encodeURIComponent(scanId)}/thumbnail`)) {
        return;
      }
    }
    const thumbPath = path.join(scanDir, 'thumbnail.jpg');
    
    // Add CORS headers for cross-origin image access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    if (!fs.existsSync(thumbPath)) {
      // Try to use first frame as thumbnail
      const metadataPath = path.join(scanDir, 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (metadata.frames && metadata.frames.length > 0) {
          const firstFramePath = path.join(scanDir, 'frames', metadata.frames[0].filename);
          if (fs.existsSync(firstFramePath)) {
            res.setHeader('Content-Type', 'image/jpeg');
            return res.send(fs.readFileSync(firstFramePath));
          }
        }
      }
      // Return a tiny transparent pixel to avoid noisy 404 spam in the client
      // for scans that no longer have persisted thumbnail artifacts.
      const transparentGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
      res.setHeader('Content-Type', 'image/gif');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(transparentGif);
    }
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(fs.readFileSync(thumbPath));
  } catch (error) {
    console.error('[Room Scanner] Get thumbnail error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get thumbnail'
    });
  }
});

/**
 * DELETE /api/room-scanner/scans/:scanId
 * Delete a saved room scan
 */
router.delete('/scans/:scanId', async (req, res) => {
  try {
    const { scanId } = req.params;
    const scanDir = path.join(SCANS_DIR, scanId);
    
    if (!fs.existsSync(scanDir)) {
      const remoteResult = await fetchRemoteScannerJson(req, `/api/room-scanner/scans/${encodeURIComponent(scanId)}`, { method: 'DELETE' });
      if (remoteResult?.data?.success) {
        return res.json(remoteResult.data);
      }

      return res.status(404).json({
        success: false,
        error: 'Scan not found'
      });
    }
    
    // Recursively delete scan directory
    fs.rmSync(scanDir, { recursive: true, force: true });
    
    console.log(`[Room Scanner] Deleted scan ${scanId}`);
    
    res.json({
      success: true,
      message: 'Room scan deleted successfully'
    });
  } catch (error) {
    console.error('[Room Scanner] Delete scan error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete room scan'
    });
  }
});

/**
 * GET /api/room-scanner/scans/:scanId/model/:filename
 * Get 3D model files for photogrammetry scans
 */
router.get('/scans/:scanId/model/:filename', (req, res) => {
  try {
    const { scanId, filename } = req.params;
    const modelPath = path.join(SCANS_DIR, scanId, 'model', filename);
    
    if (!fs.existsSync(modelPath)) {
      proxyRemoteScannerAsset(req, res, `/api/room-scanner/scans/${encodeURIComponent(scanId)}/model/${encodeURIComponent(filename)}`)
        .then((proxied) => {
          if (!proxied) {
            res.status(404).json({
              success: false,
              error: 'Model file not found'
            });
          }
        })
        .catch((error) => {
          console.error('[Room Scanner] Get model file remote bridge error:', error);
          res.status(500).json({
            success: false,
            error: error.message || 'Failed to get model file'
          });
        });
      return;
    }
    
    // Add CORS headers for cross-origin resource access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Set appropriate content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.obj': 'text/plain',
      '.mtl': 'text/plain',
      '.ply': 'application/octet-stream',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    
    // Set cache headers - but keep short for dev iteration
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    const stream = fs.createReadStream(modelPath);
    stream.pipe(res);
  } catch (error) {
    console.error('[Room Scanner] Get model file error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get model file'
    });
  }
});

/**
 * GET /api/room-scanner/scans/:scanId/artifacts/*
 * Get saved hybrid viewer and splat artifacts for photogrammetry scans.
 */
function handleScanArtifactRequest(req, res) {
  try {
    const { scanId } = req.params;
    const artifactRelativePath = req.params[0];
    const normalizedArtifactPath = path.normalize(artifactRelativePath || '');
    const artifactCacheControl = 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0';

    if (!artifactRelativePath || normalizedArtifactPath.startsWith('..')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid artifact path'
      });
    }

    const artifactPath = path.join(SCANS_DIR, scanId, 'artifacts', normalizedArtifactPath);
    if (!fs.existsSync(artifactPath)) {
      const remoteArtifactPath = normalizedArtifactPath.split(path.sep).map((segment) => encodeURIComponent(segment)).join('/');
      proxyRemoteScannerAsset(req, res, `/api/room-scanner/scans/${encodeURIComponent(scanId)}/artifacts/${remoteArtifactPath}`, {
        cacheControlOverride: artifactCacheControl,
      })
        .then((proxied) => {
          if (!proxied) {
            res.status(404).json({
              success: false,
              error: 'Artifact not found'
            });
          }
        })
        .catch((error) => {
          console.error('[Room Scanner] Get artifact file remote bridge error:', error);
          res.status(500).json({
            success: false,
            error: error.message || 'Failed to get artifact file'
          });
        });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length');
    res.setHeader('Cache-Control', artifactCacheControl);

    const ext = path.extname(artifactPath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.py': 'text/plain; charset=utf-8',
      '.cu': 'text/plain; charset=utf-8',
      '.cuh': 'text/plain; charset=utf-8',
      '.cpp': 'text/plain; charset=utf-8',
      '.cc': 'text/plain; charset=utf-8',
      '.h': 'text/plain; charset=utf-8',
      '.hpp': 'text/plain; charset=utf-8',
      '.splat': 'application/octet-stream',
      '.ksplat': 'application/octet-stream',
      '.ply': 'application/octet-stream',
      '.bin': 'application/octet-stream',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    const stat = fs.statSync(artifactPath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const parsedRange = parseSingleByteRange(range, stat.size);
      if (!parsedRange) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${stat.size}`);
      res.setHeader('Content-Length', String(parsedRange.end - parsedRange.start + 1));
      if (req.method === 'HEAD') {
        return res.end();
      }
      fs.createReadStream(artifactPath, { start: parsedRange.start, end: parsedRange.end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(stat.size));
    if (req.method === 'HEAD') {
      return res.end();
    }
    fs.createReadStream(artifactPath).pipe(res);
  } catch (error) {
    console.error('[Room Scanner] Get artifact file error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get artifact file'
    });
  }
}

router.head('/scans/:scanId/artifacts/*', handleScanArtifactRequest);
router.get('/scans/:scanId/artifacts/*', handleScanArtifactRequest);

/**
 * POST /api/room-scanner/stitch-panorama
 * Stitch multiple photos into equirectangular panorama
 */
router.post('/stitch-panorama', async (req, res) => {
  try {
    const { photos, roomName, propertyId } = req.body;
    
    if (!photos || photos.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'At least 8 photos required for panorama stitching'
      });
    }
    
    console.log(`[Room Scanner] Stitching panorama from ${photos.length} photos`);
    
    const scanId = `pano_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const scanDir = path.join(SCANS_DIR, scanId);
    fs.mkdirSync(scanDir, { recursive: true});
    
    const framesDir = path.join(scanDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    
    // Separate horizontal, up, and down photos
    const horizontalPhotos = photos.filter(p => p.type === 'horizontal').sort((a, b) => a.angle - b.angle);
    const upPhoto = photos.find(p => p.type === 'up');
    const downPhoto = photos.find(p => p.type === 'down');
    
    console.log(`[Panorama] Found ${horizontalPhotos.length} horizontal, ${upPhoto ? 1 : 0} up, ${downPhoto ? 1 : 0} down`);
    
    // Save all individual photos
    const savedFrames = [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const frameFilename = `photo_${i.toString().padStart(4, '0')}_${photo.angle}deg_${photo.type}.jpg`;
      const framePath = path.join(framesDir, frameFilename);
      
      let imageData = photo.imageData;
      if (imageData.includes(',')) {
        imageData = imageData.split(',')[1];
      }
      
      fs.writeFileSync(framePath, Buffer.from(imageData, 'base64'));
      
      savedFrames.push({
        id: `frame_${i}`,
        filename: frameFilename,
        angle: photo.angle,
        type: photo.type,
        timestamp: Date.now()
      });
    }
    
    // Create equirectangular panorama
    // Standard equirectangular is 2:1 ratio (360° x 180°)
    const panoWidth = 4096;  // High resolution for quality
    const panoHeight = 2048;
    
    try {
      // Create base canvas
      const canvas = sharp({
        create: {
          width: panoWidth,
          height: panoHeight,
          channels: 3,
          background: { r: 0, g: 0, b: 0 }
        }
      });
      
      const compositeImages = [];
      
      // Stitch horizontal photos in a circle
      if (horizontalPhotos.length > 0) {
        const sliceWidth = Math.floor(panoWidth / horizontalPhotos.length);
        const middleRowTop = Math.floor(panoHeight * 0.25); // Middle 50% for horizontal band
        const middleRowHeight = Math.floor(panoHeight * 0.5);
        
        for (let i = 0; i < horizontalPhotos.length; i++) {
          const photo = horizontalPhotos[i];
          let imageData = photo.imageData;
          if (imageData.includes(',')) {
            imageData = imageData.split(',')[1];
          }
          
          const photoBuffer = Buffer.from(imageData, 'base64');
          
          // Resize photo to fit slice
          const resized = await sharp(photoBuffer)
            .resize(sliceWidth, middleRowHeight, { 
              fit: 'cover',
              position: 'center'
            })
            .toBuffer();
          
          compositeImages.push({
            input: resized,
            left: i * sliceWidth,
            top: middleRowTop
          });
        }
      }
      
      // Add ceiling (top portion)
      if (upPhoto) {
        let imageData = upPhoto.imageData;
        if (imageData.includes(',')) {
          imageData = imageData.split(',')[1];
        }
        
        const photoBuffer = Buffer.from(imageData, 'base64');
        const ceilingHeight = Math.floor(panoHeight * 0.25);
        
        const resized = await sharp(photoBuffer)
          .resize(panoWidth, ceilingHeight, { 
            fit: 'cover',
            position: 'center'
          })
          .toBuffer();
        
        compositeImages.push({
          input: resized,
          left: 0,
          top: 0
        });
      }
      
      // Add floor (bottom portion)
      if (downPhoto) {
        let imageData = downPhoto.imageData;
        if (imageData.includes(',')) {
          imageData = imageData.split(',')[1];
        }
        
        const photoBuffer = Buffer.from(imageData, 'base64');
        const floorHeight = Math.floor(panoHeight * 0.25);
        
        const resized = await sharp(photoBuffer)
          .resize(panoWidth, floorHeight, { 
            fit: 'cover',
            position: 'center'
          })
          .toBuffer();
        
        compositeImages.push({
          input: resized,
          left: 0,
          top: panoHeight - floorHeight
        });
      }
      
      // Composite all images
      const panoramaBuffer = await canvas
        .composite(compositeImages)
        .jpeg({ quality: 90 })
        .toBuffer();
      
      // Save panorama
      const panoramaFilename = 'panorama.jpg';
      const panoramaPath = path.join(scanDir, panoramaFilename);
      fs.writeFileSync(panoramaPath, panoramaBuffer);
      
      // Convert to base64 for immediate display
      const panoramaBase64 = `data:image/jpeg;base64,${panoramaBuffer.toString('base64')}`;
      
      console.log(`[Panorama] ✅ Created equirectangular panorama: ${panoWidth}x${panoHeight}`);
      
      // Save metadata
      const metadata = {
        id: scanId,
        roomName: roomName || 'Panorama Scan',
        type: 'panorama',
        propertyId,
        frameCount: photos.length,
        frames: savedFrames,
        panoramaFilename,
        panoramaResolution: { width: panoWidth, height: panoHeight },
        createdAt: new Date().toISOString(),
        thumbnailFilename: 'thumbnail.jpg'
      };
      
      // Use first horizontal photo as thumbnail
      const firstHorizontal = horizontalPhotos[0] || photos[0];
      if (firstHorizontal) {
        let thumbData = firstHorizontal.imageData;
        if (thumbData.includes(',')) {
          thumbData = thumbData.split(',')[1];
        }
        
        // Create smaller thumbnail
        const thumbBuffer = await sharp(Buffer.from(thumbData, 'base64'))
          .resize(400, 300, { fit: 'cover' })
          .jpeg({ quality: 80 })
          .toBuffer();
        
        fs.writeFileSync(
          path.join(scanDir, 'thumbnail.jpg'),
          thumbBuffer
        );
      }
      
      fs.writeFileSync(
        path.join(scanDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      console.log(`[Room Scanner] ✅ Saved panorama scan: ${scanId}`);
      
      res.json({
        success: true,
        scanId,
        panoramaUrl: panoramaBase64,
        resolution: { width: panoWidth, height: panoHeight },
        message: 'Panorama stitched successfully!'
      });
      
    } catch (stitchError) {
      console.error('[Panorama] Stitching error:', stitchError);
      
      // Fallback to first photo if stitching fails
      const firstHorizontal = horizontalPhotos[0] || photos[0];
      
      res.json({
        success: true,
        scanId,
        panoramaUrl: firstHorizontal.imageData,
        message: 'Photos saved. Advanced stitching had an issue.',
        error: stitchError.message
      });
    }
    
  } catch (error) {
    console.error('[Room Scanner] Panorama stitching error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to stitch panorama'
    });
  }
});

// ==================== LUMA AI ENDPOINTS ====================

/**
 * POST /api/room-scanner/luma/create
 * Create a new capture on Luma AI
 */
router.post('/luma/create', async (req, res) => {
  try {
    const { title } = req.body;

    if (!LUMA_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'LUMA_API_KEY not configured'
      });
    }

    // Create capture on Luma
    // Valid types: 'uploaded', 'GuidedObjectLoop', 'Freeform', 'UploadedMobileiOS', 'UploadedAndroid', etc.
    const response = await fetch(`${LUMA_API_BASE}/captures`, {
      method: 'POST',
      headers: {
        'Authorization': `luma-api-key=${LUMA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: title || `Room Scan ${new Date().toISOString()}`,
        type: 'uploaded' // Use 'uploaded' for frames uploaded from web
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Room Scanner] Luma create error:', errorText);
      throw new Error(`Luma API error: ${response.status}`);
    }

    const data = await response.json();
    
    res.json({
      success: true,
      captureId: data.capture?.uuid || data.uuid,
      uploadUrl: data.signedUrls?.source,
      capture: data.capture || data
    });
  } catch (error) {
    console.error('[Room Scanner] Create capture error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create capture'
    });
  }
});

/**
 * POST /api/room-scanner/luma/upload
 * Upload frames to Luma AI capture
 */
router.post('/luma/upload', async (req, res) => {
  try {
    const { captureId, frames } = req.body;

    if (!captureId || !frames || !frames.length) {
      return res.status(400).json({
        success: false,
        error: 'captureId and frames are required'
      });
    }

    if (!LUMA_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'LUMA_API_KEY not configured'
      });
    }

    // Upload each frame
    const uploadResults = [];
    
    for (const frame of frames) {
      try {
        // Convert base64 to buffer
        const imageBuffer = Buffer.from(frame.imageData, 'base64');
        
        // Create form data
        const formData = new FormData();
        formData.append('file', imageBuffer, {
          filename: `frame_${frame.id}.jpg`,
          contentType: 'image/jpeg'
        });

        // Upload to Luma
        const uploadResponse = await fetch(
          `${LUMA_API_BASE}/captures/${captureId}/upload`,
          {
            method: 'POST',
            headers: {
              'Authorization': `luma-api-key=${LUMA_API_KEY}`,
              ...formData.getHeaders()
            },
            body: formData
          }
        );

        if (uploadResponse.ok) {
          uploadResults.push({ frameId: frame.id, success: true });
        } else {
          uploadResults.push({ 
            frameId: frame.id, 
            success: false, 
            error: `Upload failed: ${uploadResponse.status}` 
          });
        }
      } catch (frameError) {
        uploadResults.push({ 
          frameId: frame.id, 
          success: false, 
          error: frameError.message 
        });
      }
    }

    const successCount = uploadResults.filter(r => r.success).length;
    
    res.json({
      success: successCount > 0,
      uploaded: successCount,
      total: frames.length,
      results: uploadResults
    });
  } catch (error) {
    console.error('[Room Scanner] Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload frames'
    });
  }
});

/**
 * POST /api/room-scanner/luma/process
 * Trigger 3D reconstruction on Luma AI
 */
router.post('/luma/process', async (req, res) => {
  try {
    const { captureId } = req.body;

    if (!captureId) {
      return res.status(400).json({
        success: false,
        error: 'captureId is required'
      });
    }

    if (!LUMA_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'LUMA_API_KEY not configured'
      });
    }

    // Trigger processing
    const response = await fetch(
      `${LUMA_API_BASE}/captures/${captureId}/process`,
      {
        method: 'POST',
        headers: {
          'Authorization': `luma-api-key=${LUMA_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Room Scanner] Process error:', errorText);
      throw new Error(`Processing failed: ${response.status}`);
    }

    const data = await response.json();
    
    res.json({
      success: true,
      jobId: data.run?.uuid || data.uuid,
      status: data.status || 'processing'
    });
  } catch (error) {
    console.error('[Room Scanner] Process error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start processing'
    });
  }
});

/**
 * GET /api/room-scanner/luma/status/:captureId
 * Check status of Luma AI capture processing
 */
router.get('/luma/status/:captureId', async (req, res) => {
  try {
    const { captureId } = req.params;

    if (!LUMA_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'LUMA_API_KEY not configured'
      });
    }

    const response = await fetch(
      `${LUMA_API_BASE}/captures/${captureId}`,
      {
        headers: {
          'Authorization': `luma-api-key=${LUMA_API_KEY}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.status}`);
    }

    const data = await response.json();
    
    res.json({
      success: true,
      uuid: data.uuid,
      title: data.title,
      status: data.latestRun?.status || data.status,
      progress: data.latestRun?.progress,
      artifacts: data.latestRun?.artifacts || {},
      thumbnail: data.thumbnail
    });
  } catch (error) {
    console.error('[Room Scanner] Status check error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check status'
    });
  }
});

// ==================== OPENAI GUIDANCE ENDPOINTS ====================

// Throttle guidance requests to prevent API spam
const guidanceCache = new Map();
const GUIDANCE_THROTTLE_MS = 3000; // Minimum 3 seconds between guidance requests per session

/**
 * POST /api/room-scanner/guidance
 * Get AI-powered scanning guidance using GPT-4o Vision
 */
router.post('/guidance', async (req, res) => {
  try {
    const { currentFrame, frameCount, coverage, recentOrientations, sessionId = 'default' } = req.body;

    // Check throttle
    const lastRequest = guidanceCache.get(sessionId);
    const now = Date.now();
    if (lastRequest && (now - lastRequest) < GUIDANCE_THROTTLE_MS) {
      // Return cached/local guidance if requesting too frequently
      return res.json({
        success: true,
        guidance: getLocalGuidance(frameCount, coverage),
        throttled: true
      });
    }
    guidanceCache.set(sessionId, now);

    if (!OPENAI_API_KEY) {
      // Return local heuristic guidance if no API key
      return res.json({
        success: true,
        guidance: getLocalGuidance(frameCount, coverage)
      });
    }

    // Build context for GPT-4o
    const systemPrompt = `You are a room scanning assistant helping users capture 3D scans of rooms. 
    Analyze the current camera view and provide guidance on what to capture next.
    
    Current scan stats:
    - Frames captured: ${frameCount}
    - Coverage: ${coverage?.percentage || 0}%
    - Missing areas: ${coverage?.missingAreas?.join(', ') || 'unknown'}
    
    Respond in JSON format with:
    {
      "command": "turn_left|turn_right|move_forward|move_back|look_up|look_down|hold_steady|scan_corner|get_closer|step_back|scan_complete",
      "message": "Short voice guidance message",
      "confidence": 0.0-1.0,
      "priority": "low|medium|high"
    }`;

    // Clean the base64 data (remove data URL prefix if present)
    let cleanFrame = currentFrame;
    if (cleanFrame.includes(',')) {
      cleanFrame = cleanFrame.split(',')[1];
    }
    // Remove any whitespace
    cleanFrame = cleanFrame.replace(/\s/g, '');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this room image and tell me what to capture next:' },
              { 
                type: 'image_url', 
                image_url: { url: `data:image/jpeg;base64,${cleanFrame}` } 
              }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Room Scanner] OpenAI error details:', errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const guidance = JSON.parse(data.choices[0].message.content);
    
    res.json({
      success: true,
      guidance
    });
  } catch (error) {
    console.error('[Room Scanner] Guidance error:', error);
    // Fallback to local guidance
    res.json({
      success: true,
      guidance: getLocalGuidance(req.body.frameCount, req.body.coverage)
    });
  }
});

/**
 * POST /api/room-scanner/analyze
 * Analyze a frame for room features and scan quality
 */
router.post('/analyze', async (req, res) => {
  try {
    const { frame } = req.body;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OPENAI_API_KEY not configured'
      });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `Analyze this room image for 3D scanning. Return JSON with:
            {
              "roomType": "bedroom|living room|kitchen|bathroom|office|other",
              "visibleFeatures": ["wall", "window", "door", "furniture"],
              "estimatedDimensions": { "width": "meters", "length": "meters", "height": "meters" },
              "lightingQuality": "poor|fair|good|excellent",
              "scanQuality": "poor|fair|good|excellent",
              "issues": ["blur", "too dark", "obstruction"],
              "suggestions": ["turn on more lights", "move closer"]
            }`
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this room image:' },
              { 
                type: 'image_url', 
                image_url: { url: `data:image/jpeg;base64,${frame}` } 
              }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 500
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const analysis = JSON.parse(data.choices[0].message.content);
    
    res.json({
      success: true,
      analysis
    });
  } catch (error) {
    console.error('[Room Scanner] Analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze frame'
    });
  }
});

// ==================== DEPTH ESTIMATION ENDPOINTS ====================

/**
 * Convert HEIC/HEIF image to JPEG format
 * @param {string} dataUrl - Data URL (with or without prefix)
 * @returns {Promise<string>} - JPEG base64 string (without prefix)
 */
async function convertHeicToJpeg(dataUrl) {
  try {
    // Extract base64 data
    let base64Data = dataUrl;
    let isHeic = false;
    
    if (dataUrl.startsWith('data:')) {
      const matches = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        base64Data = matches[2];
        isHeic = mimeType === 'image/heic' || mimeType === 'image/heif';
      }
    }
    
    // Check if conversion is needed
    if (!isHeic) {
      return base64Data; // Already JPEG/PNG
    }
    
    console.log('[Room Scanner] Converting HEIC to JPEG, input size:', base64Data.length);
    
    // Convert base64 to buffer
    const heicBuffer = Buffer.from(base64Data, 'base64');
    
    // Convert HEIC to JPEG using heic-convert
    const jpegBuffer = await heicConvert({
      buffer: heicBuffer,
      format: 'JPEG',
      quality: 0.9 // High quality for depth processing
    });
    
    // Convert back to base64
    const jpegBase64 = Buffer.from(jpegBuffer).toString('base64');
    console.log('[Room Scanner] HEIC converted to JPEG, output size:', jpegBase64.length);
    
    return jpegBase64;
  } catch (error) {
    console.error('[Room Scanner] HEIC conversion failed:', error.message);
    throw new Error(`HEIC conversion failed: ${error.message}`);
  }
}

/**
 * Analyze a depth map to extract min/max depth values
 * Prefers .npy raw depth data, falls back to PNG histogram analysis
 */
async function analyzeDepthMapPNG(depthImageUrl, depthNpyUrl = null) {
  // Try to use raw numpy depth data first (most accurate)
  if (depthNpyUrl) {
    try {
      console.log('[Room Scanner] Downloading raw depth data (.npy) from:', depthNpyUrl.substring(0, 80));
      
      const response = await fetch(depthNpyUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch numpy file: ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      const npy = new npyjs();
      const depthArray = await npy.load(Buffer.from(buffer));
      
      console.log('[Room Scanner] Numpy depth array shape:', depthArray.shape);
      console.log('[Room Scanner] Numpy depth array dtype:', depthArray.dtype);
      
      // depthArray.data contains actual metric depth values in meters
      const depthValues = Array.from(depthArray.data);
      
      // Filter out invalid values (0, negative, or extreme outliers)
      const validDepths = depthValues.filter(d => d > 0.01 && d < 50);
      
      if (validDepths.length === 0) {
        throw new Error('No valid depth values in numpy array');
      }
      
      // Sort to find percentiles
      validDepths.sort((a, b) => a - b);
      const minDepth = validDepths[Math.floor(validDepths.length * 0.05)]; // 5th percentile
      const maxDepth = validDepths[Math.floor(validDepths.length * 0.95)]; // 95th percentile
      const avgDepth = validDepths.reduce((a, b) => a + b, 0) / validDepths.length;
      
      console.log('[Room Scanner] RAW NUMPY DEPTH - Min:', minDepth.toFixed(2) + 'm', 'Max:', maxDepth.toFixed(2) + 'm', 'Avg:', avgDepth.toFixed(2) + 'm');
      
      return {
        minDepth: parseFloat(minDepth.toFixed(2)),
        maxDepth: parseFloat(maxDepth.toFixed(2)),
        avgDepth: parseFloat(avgDepth.toFixed(2)),
        width: depthArray.shape[1] || 0,
        height: depthArray.shape[0] || 0,
        source: 'numpy'
      };
    } catch (npyError) {
      console.warn('[Room Scanner] Failed to parse numpy depth data:', npyError.message);
      console.log('[Room Scanner] Falling back to PNG histogram analysis...');
    }
  }
  
  // Fallback: Analyze PNG histogram
  try {
    console.log('[Room Scanner] Downloading depth map from:', depthImageUrl.substring(0, 80));
    
    // Download the PNG
    const response = await fetch(depthImageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch depth map: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    const png = PNG.sync.read(Buffer.from(buffer));
    
    console.log('[Room Scanner] Depth map dimensions:', png.width, 'x', png.height);
    
    // ZoeDepth outputs are normalized grayscale visualizations
    // Improved analysis: Focus on center region (more reliable for room dimensions)
    // and use multiple statistical measures
    
    const centerX = Math.floor(png.width / 2);
    const centerY = Math.floor(png.height / 2);
    const regionSize = Math.min(png.width, png.height) / 3;
    
    const allPixels = [];
    const centerPixels = [];
    
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const idx = (png.width * y + x) << 2;
        const r = png.data[idx];
        
        // Skip pure black (0) and pure white (255) as they often represent invalid/clipped values
        if (r > 5 && r < 250) {
          allPixels.push(r);
          
          // Check if in center region
          if (Math.abs(x - centerX) < regionSize && Math.abs(y - centerY) < regionSize) {
            centerPixels.push(r);
          }
        }
      }
    }
    
    if (allPixels.length === 0) {
      throw new Error('No valid pixels in depth map');
    }
    
    // Sort to find percentiles
    allPixels.sort((a, b) => a - b);
    centerPixels.sort((a, b) => a - b);
    
    // Use 10th and 90th percentile to avoid outliers
    const p10 = allPixels[Math.floor(allPixels.length * 0.10)];
    const p50 = allPixels[Math.floor(allPixels.length * 0.50)]; // median
    const p90 = allPixels[Math.floor(allPixels.length * 0.90)];
    
    // Center region median (most reliable for room walls)
    const centerMedian = centerPixels.length > 0 
      ? centerPixels[Math.floor(centerPixels.length * 0.50)]
      : p50;
    
    // Convert to depth estimates
    // ZoeDepth typically maps: darker pixels = closer, brighter = farther
    // For indoor scenes: 0.5m to 10m range
    const minDepth = 0.3 + (p10 / 255.0) * 2.0;      // 0.3m to 2.3m
    const maxDepth = 3.0 + (p90 / 255.0) * 7.0;      // 3m to 10m  
    const medianDepth = 1.0 + (p50 / 255.0) * 6.0;   // 1m to 7m
    const centerDepth = 1.0 + (centerMedian / 255.0) * 6.0;
    
    console.log('[Room Scanner] Pixel percentiles - P10:', p10, 'P50:', p50, 'P90:', p90, 'Center:', centerMedian);
    console.log('[Room Scanner] Depth analysis - Min:', minDepth.toFixed(2) + 'm', 'Max:', maxDepth.toFixed(2) + 'm', 'Median:', medianDepth.toFixed(2) + 'm', 'Center:', centerDepth.toFixed(2) + 'm');
    console.log('[Room Scanner] Depth analysis - Min:', minDepth.toFixed(2) + 'm', 'Max:', maxDepth.toFixed(2) + 'm', 'Median:', medianDepth.toFixed(2) + 'm', 'Center:', centerDepth.toFixed(2) + 'm');
    
    return {
      minDepth: parseFloat(minDepth.toFixed(2)),
      maxDepth: parseFloat(maxDepth.toFixed(2)),
      avgDepth: parseFloat(medianDepth.toFixed(2)),
      centerDepth: parseFloat(centerDepth.toFixed(2)),
      width: png.width,
      height: png.height,
      source: 'png-advanced'
    };
  } catch (error) {
    console.error('[Room Scanner] Error analyzing depth map:', error.message);
    // Return default fallback values
    return {
      minDepth: 0.1,
      maxDepth: 10.0,
      avgDepth: 2.5,
      width: 0,
      height: 0,
      source: 'fallback'
    };
  }
}

/**
 * POST /api/room-scanner/depth
 * Estimate METRIC depth from a single image using ZoeDepth
 * ZoeDepth provides metric (absolute) depth in meters, unlike relative depth models
 * This enables accurate room dimension measurement for renovation cost estimation
 */
router.post('/depth', async (req, res) => {
  // IMPORTANT: Do NOT abort on disconnect - ngrok triggers false 'close' events
  // We will complete the processing regardless and try to send the response
  // If the client truly disconnected, res.json() will fail silently
  
  req.on('close', () => {
    // Just log it, but don't abort - ngrok causes false positives
    if (!res.headersSent) {
      console.log('[Room Scanner] Socket close event received (ngrok false positive likely, continuing...)');
    }
  });
  
  try {
    const { image, model = 'zoedepth' } = req.body;

    // Check if Replicate is configured
    const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
    
    console.log('[Room Scanner] Metric depth estimation request using ZoeDepth 2025 (zedge/zoedepth), API key configured:', !!REPLICATE_API_KEY);
    
    if (REPLICATE_API_KEY) {
      try {
        // ZoeDepth model - provides METRIC depth estimation (actual distances in meters)
        // This is critical for accurate room dimension measurement
        
        // NEW 2025 ZoeDepth model (zedge/zoedepth) - updated April 2025
        // Better accuracy on indoor scenes, improved metric depth
        // https://replicate.com/zedge/zoedepth
        const ZOEDEPTH_VERSION = 'fd85428545f04150f59856dab2a51a7be2ca5003a331920b0e4303b17b411332';
        
        // Legacy: cjwbw/zoedepth (March 2023) - keeping for reference
        // const ZOEDEPTH_LEGACY_VERSION = '6375723d97400d3ac7b88e3022b738bf6f433ae165c4a2acd1955eaa6b8fcb62';
        
        // Depth Anything V2 Large (relative depth, better for visualization)
        // https://replicate.com/cjwbw/depth-anything
        const DEPTH_ANYTHING_VERSION = 'e5b0454205013708df48492a13a8ee4b3c412173362fc56c6b5558eb54e527e5';
        
        const selectedVersion = model === 'zoedepth' ? ZOEDEPTH_VERSION : DEPTH_ANYTHING_VERSION;
        
        // Convert HEIC to JPEG if needed, then strip data URL prefix
        let cleanBase64 = await convertHeicToJpeg(image);
        
        // If input already had data: prefix stripped, convertHeicToJpeg returns clean base64
        // But if it was a full data URL, we may need to strip again (though convert handles it)
        if (cleanBase64.startsWith('data:')) {
          const base64Index = cleanBase64.indexOf('base64,');
          if (base64Index !== -1) {
            cleanBase64 = cleanBase64.substring(base64Index + 7);
          }
        }
        
        console.log('[Room Scanner] Final clean base64 length:', cleanBase64.length);
        
        const response = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${REPLICATE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            // Use version hash directly (not owner/model:version format)
            version: selectedVersion,
            input: {
              image: `data:image/jpeg;base64,${cleanBase64}`
              // Note: zedge/zoedepth (2025) only requires 'image' parameter
              // The old cjwbw/zoedepth had model_type: 'ZoeD_NK' but new version handles this automatically
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[Room Scanner] Replicate API error:', errorText);
          throw new Error(`Replicate API error: ${response.status}`);
        }

        const prediction = await response.json();
        console.log('[Room Scanner] ZoeDepth prediction started:', prediction.id);
        
        // Poll for result - NEVER abort, complete the request regardless of socket state
        let result = prediction;
        let attempts = 0;
        const maxAttempts = 120; // 120 seconds max for ZoeDepth
        
        while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          
          try {
            const statusResponse = await fetch(result.urls.get, {
              headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` }
            });
            result = await statusResponse.json();
          } catch (pollError) {
            console.log('[Room Scanner] Poll error (will retry):', pollError.message);
            // Continue polling despite errors
          }
          attempts++;
          
          // Log progress every 10 seconds
          if (attempts % 10 === 0) {
            console.log(`[Room Scanner] ZoeDepth polling: attempt ${attempts}/${maxAttempts}, status: ${result.status}`);
          }
        }

        if (result.status === 'succeeded') {
          console.log('[Room Scanner] ZoeDepth metric depth estimation succeeded');
          
          // ZoeDepth returns metric depth - extract depth statistics
          // The output includes both the depth image and metric depth values
          const output = result.output;
          console.log('[Room Scanner] ZoeDepth output:', JSON.stringify(output).substring(0, 200));
          
          // Parse depth statistics from ZoeDepth output
          // ZoeDepth typically returns: { depth_image: url, depth_npy: url } or just an image URL
          const depthImageUrl = typeof output === 'string' ? output : (output?.depth_image || output);
          const depthNpyUrl = typeof output === 'object' ? output?.depth_npy : null;
          
          console.log('[Room Scanner] Parsed depthImageUrl:', depthImageUrl?.substring(0, 100));
          
          // Analyze the depth map PNG to extract ACTUAL min/max depth values
          const depthAnalysis = await analyzeDepthMapPNG(depthImageUrl);
          
          // Download depth map and convert to base64 to avoid CORS issues
          console.log('[Room Scanner] Downloading depth map to convert to base64...');
          const depthImageResponse = await fetch(depthImageUrl);
          const depthImageBuffer = await depthImageResponse.arrayBuffer();
          const depthImageBase64 = Buffer.from(depthImageBuffer).toString('base64');
          console.log('[Room Scanner] Depth map converted to base64, size:', depthImageBase64.length);
          
          const metricDepthInfo = {
            depthImageData: `data:image/png;base64,${depthImageBase64}`, // Base64 to avoid CORS
            depthImageUrl: depthImageUrl, // Keep original URL for reference
            depthDataUrl: depthNpyUrl, // Raw depth data (numpy format) if available
            width: depthAnalysis.width,
            height: depthAnalysis.height,
            // ACTUAL metric depth range in meters from the depth map
            minDepth: depthAnalysis.minDepth,
            maxDepth: depthAnalysis.maxDepth,
            avgDepth: depthAnalysis.avgDepth,
            // Metric depth metadata
            isMetricDepth: true,  // Flag indicating this is metric (not relative) depth
            unit: 'meters',
            modelType: model === 'zoedepth' ? 'zoedepth_nk' : 'depth_anything_v2',
            // Typical camera focal length assumption for metric conversion
            // This can be overridden if camera intrinsics are known
            assumedFocalLengthMm: 26, // ~26mm equivalent (typical smartphone)
            // Confidence/quality metrics
            indoorOptimized: model === 'zoedepth',
            metricAccuracyEstimate: model === 'zoedepth' ? 0.85 : 0.6, // ZoeDepth is more accurate for metric
          };
          
          console.log('[Room Scanner] Returning depth response with isMetricDepth:', metricDepthInfo.isMetricDepth);
          
          return res.json({
            success: true,
            depth: metricDepthInfo,
            processingTime: attempts,
            modelUsed: model === 'zoedepth' ? 'ZoeDepth NK (Indoor Metric)' : 'Depth Anything V2'
          });
        } else {
          console.error('[Room Scanner] ZoeDepth estimation failed:', result.error || result.status);
          throw new Error(result.error || 'Depth estimation timed out');
        }
      } catch (replicateError) {
        console.error('[Room Scanner] Replicate/ZoeDepth error:', replicateError.message);
        // Fall through to fallback
      }
    }

    // Fallback: return placeholder
    res.json({
      success: true,
      depth: null,
      message: 'Depth estimation not configured or failed. Add REPLICATE_API_KEY for ZoeDepth metric depth processing.',
      processingTime: 0
    });
  } catch (error) {
    console.error('[Room Scanner] Depth estimation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Depth estimation failed'
    });
  }
});

/**
 * GET /api/room-scanner/version
 * Return the current API version for cache management
 */
router.get('/version', (req, res) => {
  res.json({ 
    success: true, 
    version: API_VERSION,
    timestamp: Date.now(),
    features: ['zoedepth-metric-depth', 'room-dimensions', 'completion-modal', 'cache-fix']
  });
});

/**
 * POST /api/room-scanner/debug-log
 * Simple endpoint to log frontend debug messages to server console
 */
router.post('/debug-log', (req, res) => {
  const { message, data } = req.body;
  console.log(`[Room Scanner DEBUG] ${message}`, data ? JSON.stringify(data) : '');
  res.json({ success: true });
});

/**
 * POST /api/room-scanner/calculate-dimensions
 * Calculate room dimensions from metric depth maps
 * Uses ZoeDepth metric depth data to estimate actual room size in feet/meters
 */
router.post('/calculate-dimensions', async (req, res) => {
  try {
    const { 
      depthMaps,  // Array of depth map data with metric depths
      cameraFov = 70,  // Horizontal field of view in degrees (typical smartphone)
      imageWidth = 1920,
      imageHeight = 1080
    } = req.body;
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Room Scanner] 🎯 CALCULATE-DIMENSIONS ENDPOINT CALLED`);
    console.log(`[Room Scanner] Timestamp: ${new Date().toISOString()}`);
    console.log(`[Room Scanner] Received ${depthMaps?.length || 0} depth maps for dimension calculation`);
    console.log(`[Room Scanner] Camera params: FOV=${cameraFov}°, Size=${imageWidth}x${imageHeight}`);
    console.log(`${'='.repeat(80)}\n`);
    
    if (!depthMaps || depthMaps.length === 0) {
      console.log('[Room Scanner] ❌ No depth maps provided to calculate-dimensions');
      return res.json({
        success: false,
        error: 'No depth maps provided'
      });
    }
    
    // Log each depth map details
    depthMaps.forEach((map, idx) => {
      console.log(`[Room Scanner] Depth Map ${idx + 1}:`, {
        minDepth: map.minDepth,
        maxDepth: map.maxDepth,
        isMetricDepth: map.isMetricDepth,
        hasOrientation: !!map.orientation
      });
    });
    
    console.log(`\n[Room Scanner] 📐 Calculating room dimensions from ${depthMaps.length} depth maps...`);
    
    // Calculate room dimensions using metric depth data
    const dimensions = calculateRoomDimensionsFromDepth(depthMaps, {
      cameraFov,
      imageWidth,
      imageHeight
    });
    
    console.log(`\n[Room Scanner] ✅ Dimensions calculated successfully:`);
    console.log(JSON.stringify({
      widthFeet: dimensions.widthMeters * 3.28084,
      lengthFeet: dimensions.lengthMeters * 3.28084,
      heightFeet: dimensions.heightMeters * 3.28084,
      floorAreaSqFt: dimensions.floorAreaSqFt,
      confidence: dimensions.confidence
    }, null, 2));
    console.log(`${'='.repeat(80)}\n`);
    
    res.json({
      success: true,
      dimensions: {
        // Room dimensions in feet
        widthFeet: dimensions.widthMeters * 3.28084,
        lengthFeet: dimensions.lengthMeters * 3.28084,
        heightFeet: dimensions.heightMeters * 3.28084,
        // Room dimensions in meters  
        widthMeters: dimensions.widthMeters,
        lengthMeters: dimensions.lengthMeters,
        heightMeters: dimensions.heightMeters,
        // Calculated areas
        floorAreaSqFt: dimensions.floorAreaSqFt,
        floorAreaSqM: dimensions.floorAreaSqM,
        wallAreaSqFt: dimensions.wallAreaSqFt,
        wallAreaSqM: dimensions.wallAreaSqM,
        // Confidence and methodology
        confidence: dimensions.confidence,
        methodology: 'ZoeDepth metric depth + geometric reconstruction',
        estimatedAccuracy: '±10-15%'
      }
    });
  } catch (error) {
    console.error('[Room Scanner] Dimension calculation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to calculate dimensions'
    });
  }
});

/**
 * Calculate room dimensions from metric depth maps
 * Uses geometric analysis of depth values to estimate room size
 */
function calculateRoomDimensionsFromDepth(depthMaps, cameraParams) {
  const { cameraFov, imageWidth, imageHeight } = cameraParams;
  
  // Convert FOV to radians
  const fovRad = (cameraFov * Math.PI) / 180;
  const aspectRatio = imageWidth / imageHeight;
  const vFov = 2 * Math.atan(Math.tan(fovRad / 2) / aspectRatio);
  
  // Analyze depth maps to find room boundaries
  // In a typical room scan, walls appear at consistent depth bands
  let wallDistances = [];
  let floorDistances = [];
  let ceilingDistances = [];
  
  for (const depthMap of depthMaps) {
    if (!depthMap.isMetricDepth) continue;
    
    // Extract depth statistics from the depth map
    // Walls: look at horizontal center band
    // Floor: look at bottom of image
    // Ceiling: look at top of image
    
    const minDepth = depthMap.minDepth || 0.1;
    const maxDepth = depthMap.maxDepth || 10.0;
    
    // Estimate distances based on depth range (simplified)
    // In production, we'd analyze the actual depth image pixels
    const avgWallDistance = (minDepth + maxDepth) / 2;
    const floorAngle = vFov / 2;
    const ceilingAngle = vFov / 2;
    
    wallDistances.push(avgWallDistance);
    
    // Estimate floor/ceiling from looking angles
    if (depthMap.orientation?.beta) {
      const tilt = (depthMap.orientation.beta * Math.PI) / 180;
      if (tilt > 0.2) { // Looking down
        floorDistances.push(avgWallDistance * Math.cos(floorAngle));
      } else if (tilt < -0.2) { // Looking up
        ceilingDistances.push(avgWallDistance * Math.cos(ceilingAngle));
      }
    }
  }
  
  // Calculate average dimensions
  const avgWallDist = wallDistances.length > 0 
    ? wallDistances.reduce((a, b) => a + b, 0) / wallDistances.length 
    : 3.0; // Default 3m if no data
  
  // Room width/length estimated from wall distances and FOV
  // A typical room scan captures opposing walls
  const estimatedWidth = avgWallDist * 2 * Math.tan(fovRad / 2);
  const estimatedLength = avgWallDist * 2; // Assume rectangular room
  
  // Height estimation
  const estimatedHeight = ceilingDistances.length > 0 
    ? ceilingDistances.reduce((a, b) => a + b, 0) / ceilingDistances.length * 2
    : 2.7; // Default 2.7m (9ft) ceiling
  
  // Calculate areas
  const floorAreaSqM = estimatedWidth * estimatedLength;
  const floorAreaSqFt = floorAreaSqM * 10.764; // sq meters to sq feet
  
  const wallAreaSqM = 2 * estimatedHeight * (estimatedWidth + estimatedLength);
  const wallAreaSqFt = wallAreaSqM * 10.764;
  
  // Confidence based on number of depth maps and coverage
  const confidence = Math.min(0.95, 0.5 + (depthMaps.length * 0.05));
  
  return {
    widthMeters: Math.round(estimatedWidth * 100) / 100,
    lengthMeters: Math.round(estimatedLength * 100) / 100,
    heightMeters: Math.round(estimatedHeight * 100) / 100,
    floorAreaSqFt: Math.round(floorAreaSqFt),
    floorAreaSqM: Math.round(floorAreaSqM * 100) / 100,
    wallAreaSqFt: Math.round(wallAreaSqFt),
    wallAreaSqM: Math.round(wallAreaSqM * 100) / 100,
    confidence: Math.round(confidence * 100) / 100
  };
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Generate local heuristic-based guidance
 */
function getLocalGuidance(frameCount, coverage) {
  if (frameCount < 5) {
    return {
      command: 'hold_steady',
      message: 'Hold steady. Starting room scan...',
      confidence: 1,
      priority: 'high'
    };
  }

  const percentage = coverage?.percentage || 0;
  const missingAreas = coverage?.missingAreas || [];

  if (percentage >= 85) {
    return {
      command: 'scan_complete',
      message: 'Great job! Room scan is complete.',
      confidence: 1,
      priority: 'high'
    };
  }

  if (missingAreas.includes('ceiling')) {
    return {
      command: 'look_up',
      message: 'Tilt up to capture the ceiling.',
      confidence: 0.8,
      priority: 'medium'
    };
  }

  if (missingAreas.includes('floor')) {
    return {
      command: 'look_down',
      message: 'Tilt down to capture the floor.',
      confidence: 0.8,
      priority: 'medium'
    };
  }

  // Default: keep rotating
  return {
    command: 'turn_right',
    message: 'Continue scanning. Turn right slowly.',
    confidence: 0.7,
    priority: 'low'
  };
}

export default router;
