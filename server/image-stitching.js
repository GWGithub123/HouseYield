/**
 * Image Stitching API Routes
 * Backend endpoints for high-quality panorama stitching using Python OpenCV
 * Uses spherical projection with photogrammetry for accurate alignment
 */

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Temporary storage for processing
const TEMP_DIR = path.join(__dirname, 'data', 'temp-stitching');
// Permanent storage for saved room scans
const SCANS_DIR = path.join(__dirname, 'data', 'room-scans');

// Ensure directories exist
[TEMP_DIR, SCANS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[Image Stitching] Created directory:', dir);
  }
});

// Path to Python stitching script (with photogrammetry)
const PYTHON_SCRIPT = path.join(__dirname, 'scripts', 'stitch_panorama.py');

/**
 * Auto-save panorama to room-scans so it's preserved even if client disconnects
 */
function autoSavePanorama(equirectangularImage, metadata, depthPanorama = null, roomDimensions = null, userId = 'mobile-scan') {
  try {
    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const scanDir = path.join(SCANS_DIR, scanId);
    fs.mkdirSync(scanDir, { recursive: true });
    
    // Save the equirectangular image
    const imageData = equirectangularImage.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(imageData, 'base64');
    const imagePath = path.join(scanDir, 'panorama.jpg');
    fs.writeFileSync(imagePath, imageBuffer);
    
    // Create a smaller thumbnail (just use original for now since we can't resize here)
    const thumbnailPath = path.join(scanDir, 'thumbnail.jpg');
    fs.writeFileSync(thumbnailPath, imageBuffer);
    
    // Save depth panorama if available
    let hasDepthSaved = false;
    
    if (depthPanorama && depthPanorama.data) {
      try {
        // Save the depth image (it's a base64 PNG)
        const depthImageData = depthPanorama.data.replace(/^data:image\/\w+;base64,/, '');
        const depthBuffer = Buffer.from(depthImageData, 'base64');
        const depthImagePath = path.join(scanDir, 'depth_panorama.png');
        fs.writeFileSync(depthImagePath, depthBuffer);
        
        // Also save the depth metadata separately for easy access
        const depthMetadata = {
          width: depthPanorama.width,
          height: depthPanorama.height,
          minDepth: depthPanorama.minDepth,
          maxDepth: depthPanorama.maxDepth,
          coverage: depthPanorama.coverage,
        };
        fs.writeFileSync(
          path.join(scanDir, 'depth_metadata.json'),
          JSON.stringify(depthMetadata, null, 2)
        );
        
        hasDepthSaved = true;
        console.log('[Image Stitching] ✅ Depth panorama saved:', {
          path: depthImagePath,
          range: `${depthPanorama.minDepth?.toFixed(2)}m - ${depthPanorama.maxDepth?.toFixed(2)}m`,
        });
      } catch (depthError) {
        console.error('[Image Stitching] ⚠️ Failed to save depth panorama:', depthError.message);
      }
    }
    
    // Use room dimensions from Python analysis if available, otherwise use crude estimate
    let finalRoomDimensions = roomDimensions;
    
    if (!finalRoomDimensions && depthPanorama) {
      // Fallback: crude estimate from depth range (Python should provide better analysis)
      const minD = depthPanorama.minDepth || 0.5;
      const maxD = depthPanorama.maxDepth || 5;
      
      const estimatedWidth = minD * 2.5;
      const estimatedLength = maxD * 1.5;
      const estimatedHeight = Math.min(3.0, maxD * 0.5);
      
      finalRoomDimensions = {
        widthMeters: estimatedWidth,
        lengthMeters: estimatedLength,
        heightMeters: estimatedHeight,
        widthFeet: estimatedWidth * 3.28084,
        lengthFeet: estimatedLength * 3.28084,
        heightFeet: estimatedHeight * 3.28084,
        floorAreaSqM: estimatedWidth * estimatedLength,
        floorAreaSqFt: estimatedWidth * estimatedLength * 10.7639,
        confidence: 0.2, // Very low confidence for crude estimate
        source: 'depth_estimate_fallback'
      };
    }
    
    // Save metadata in format expected by room-scanner.js GET /scans endpoint
    const scanMetadata = {
      id: scanId,
      roomName: `Mobile Scan ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      userId,
      thumbnailFilename: 'thumbnail.jpg',
      panoramaFilename: 'panorama.jpg',
      depthPanoramaFilename: hasDepthSaved ? 'depth_panorama.png' : null,
      frameCount: metadata?.photoCount || 0,
      type: 'spherical_panorama',
      scanType: 'spherical_panorama',
      // Include room dimensions from Python depth analysis
      roomDimensions: finalRoomDimensions,
      metadata: {
        scanType: 'spherical_panorama',
        photoCount: metadata?.photoCount || 0,
        processingTime: metadata?.processingTime || 0,
        width: metadata?.width || 4096,
        height: metadata?.height || 2048,
        hasDepth: hasDepthSaved,
        depthRange: hasDepthSaved && depthPanorama ? {
          min: depthPanorama.minDepth,
          max: depthPanorama.maxDepth,
        } : null,
        roomDimensions: finalRoomDimensions, // Also in nested metadata for compatibility
        autoSaved: true, // Mark as auto-saved
      }
    };
    
    fs.writeFileSync(
      path.join(scanDir, 'metadata.json'),
      JSON.stringify(scanMetadata, null, 2)
    );
    
    console.log('[Image Stitching] ✅ Auto-saved panorama:', scanId, hasDepthSaved ? '(with depth)' : '(no depth)');
    return scanId;
  } catch (error) {
    console.error('[Image Stitching] ❌ Failed to auto-save:', error);
    return null;
  }
}

/**
 * POST /api/image-stitching/stitch-panorama
 * Stitch photos into a seamless equirectangular panorama using spherical projection + photogrammetry
 * 
 * Body:
 * {
 *   photos: Array<{
 *     imageData: string (base64),
 *     azimuth: number (degrees),
 *     elevation: number (degrees),
 *     sensorData?: { attitude: { quaternion: {x,y,z,w} } },  // iPhone sensor data
 *     cameraPose?: { rotation: {x,y,z,w} },  // Pre-computed pose
 *     cameraIntrinsics?: { focalLengthX, focalLengthY, principalPointX, principalPointY }
 *   }>,
 *   outputWidth: number (default 4096),
 *   outputHeight: number (default 2048)
 * }
 */
router.post('/stitch-panorama', async (req, res) => {
  const startTime = Date.now();
  let tempInputFile = null;
  let tempOutputFile = null;

  try {
    const { photos, outputWidth = 4096, outputHeight = 2048 } = req.body;

    if (!photos || !Array.isArray(photos) || photos.length < 1) {
      return res.status(400).json({ 
        error: `Invalid photos array. Expected at least 1 photo, got ${photos?.length || 0}` 
      });
    }

    // Count photos with sensor data
    const withSensors = photos.filter(p => p.sensorData || p.cameraPose).length;
    
    console.log('[Image Stitching] Starting spherical panorama stitch:', {
      photoCount: photos.length,
      withSensorData: withSensors,
      targetResolution: `${outputWidth}x${outputHeight}`,
    });

    // Create temporary input file with full sensor and depth data
    tempInputFile = path.join(TEMP_DIR, `input_${Date.now()}.json`);
    const inputData = {
      photos: photos.map(p => ({
        imageData: p.imageData,
        azimuth: p.azimuth,
        elevation: p.elevation,
        ringIndex: p.ringIndex,
        photoIndex: p.photoIndex,
        // Include sensor data for accurate orientation
        sensorData: p.sensorData || null,
        cameraPose: p.cameraPose || null,
        cameraIntrinsics: p.cameraIntrinsics || null,
        // Include depth map for depth-aware blending
        depthMap: p.depthMap || null,
      })),
    };
    fs.writeFileSync(tempInputFile, JSON.stringify(inputData));

    // Count photos with depth data
    const withDepth = photos.filter(p => p.depthMap).length;
    console.log('[Image Stitching] Input saved to', tempInputFile);
    console.log('[Image Stitching] Depth data:', `${withDepth}/${photos.length} photos`);

    // Create temporary output file path
    tempOutputFile = path.join(TEMP_DIR, `output_${Date.now()}.json`);

    // Check if OpenAI API key is available for Vision analysis
    const useVision = !!process.env.OPENAI_API_KEY && photos.length >= 6;
    if (useVision) {
      console.log('[Image Stitching] OpenAI Vision analysis enabled');
    }

    // Call Python script with optional Vision flag
    const pythonArgs = [
      PYTHON_SCRIPT,
      '--input', tempInputFile,
      '--output-width', outputWidth.toString(),
      '--output-height', outputHeight.toString(),
      '--output', tempOutputFile
    ];
    
    if (useVision) {
      pythonArgs.push('--use-vision');
    }

    // Pass environment variables to Python, including OPENAI_API_KEY
    const pythonEnv = {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };

    const pythonProcess = spawn('python3', pythonArgs, { env: pythonEnv });

    let stderr = '';
    let stdout = '';
    
    // Capture and log stderr (Python progress logs)
    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      stderr += output + '\n';
      // Log Python progress to console in real-time
      output.split('\n').forEach(line => {
        if (line.trim()) console.log('[Python]', line);
      });
    });
    
    // Capture stdout as well
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      stdout += output + '\n';
      output.split('\n').forEach(line => {
        if (line.trim()) console.log('[Python Output]', line);
      });
    });

    // Wait for Python script to complete
    await new Promise((resolve, reject) => {
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Python script exited with code ${code}\n${stderr}`));
        }
      });

      pythonProcess.on('error', (err) => {
        reject(new Error(`Failed to start Python script: ${err.message}`));
      });
    });

    // Read result from output file
    // With 4GB Node.js memory limit, we can load ~1.5GB JSON files
    let resultData;
    try {
      const fileSize = fs.statSync(tempOutputFile).size;
      const sizeMB = fileSize / (1024 * 1024);
      
      console.log(`[Image Stitching] Reading result file (${sizeMB.toFixed(1)}MB)...`);
      
      if (sizeMB > 3000) {
        // If over 3GB, even with 4GB limit we might struggle
        throw new Error(`Result file too large (${sizeMB.toFixed(1)}MB). Point cloud needs more downsampling.`);
      }
      
      resultData = JSON.parse(fs.readFileSync(tempOutputFile, 'utf-8'));
      console.log(`[Image Stitching] Result loaded successfully`);
      
    } catch (error) {
      if (error.message.includes('out of memory') || error.message.includes('heap') || error.message.includes('allocation failed')) {
        throw new Error('Result file too large for memory. Node.js ran out of heap space. Point cloud may need further downsampling.');
      }
      throw error;
    }

    if (!resultData.success) {
      throw new Error(resultData.error || 'Python script failed');
    }

    const processingTime = Date.now() - startTime;
    console.log('[Image Stitching] Stitching complete:', {
      processingTime: `${processingTime}ms`,
      outputSize: `${resultData.width}x${resultData.height}`,
      hasDepthPanorama: !!resultData.depthPanorama,
    });

    // AUTO-SAVE: Save panorama to disk BEFORE sending response
    // This ensures the scan is preserved even if the client disconnects
    // Prefer point cloud dimensions (auto-calibrated) over depth panorama dimensions
    const savedScanId = autoSavePanorama(
      resultData.equirectangularImage, 
      {
        photoCount: photos.length,
        processingTime,
        width: resultData.width,
        height: resultData.height,
      },
      resultData.depthPanorama,  // Pass the depth panorama to save it too
      resultData.roomDimensionsFromPointCloud || resultData.roomDimensions  // Prefer point cloud dimensions
    );
    
    if (savedScanId) {
      console.log('[Image Stitching] 📁 Scan auto-saved as:', savedScanId, resultData.depthPanorama ? '(with depth data)' : '');
    }

    // Build response including depth panorama if available
    const response = {
      success: true,
      equirectangularImage: resultData.equirectangularImage,
      width: resultData.width,
      height: resultData.height,
      processingTime,
      metadata: resultData.metadata,
      savedScanId, // Include the auto-saved scan ID
    };
    
    // Include depth panorama for room measurements
    if (resultData.depthPanorama) {
      response.depthPanorama = resultData.depthPanorama;
      console.log('[Image Stitching] Depth panorama included:', {
        range: `${resultData.depthPanorama.minDepth.toFixed(2)}m - ${resultData.depthPanorama.maxDepth.toFixed(2)}m`,
        coverage: `${resultData.depthPanorama.coverage}%`,
      });
    }
    
    // Include room dimensions - prefer point cloud dimensions (more accurate) over depth panorama
    const finalRoomDimensions = resultData.roomDimensionsFromPointCloud || resultData.roomDimensions;
    if (finalRoomDimensions) {
      response.roomDimensions = finalRoomDimensions;
      const source = resultData.roomDimensionsFromPointCloud ? 'point cloud (auto-calibrated)' : 'depth panorama';
      console.log('[Image Stitching] Room dimensions from', source + ':', 
        `${finalRoomDimensions.widthFeet.toFixed(1)}ft × ${finalRoomDimensions.lengthFeet.toFixed(1)}ft × ${finalRoomDimensions.heightFeet.toFixed(1)}ft`);
    }
    
    // Include point cloud file reference for streaming
    if (resultData.pointCloudFile) {
      response.pointCloudFile = resultData.pointCloudFile;
      console.log('[Image Stitching] Point cloud file available for streaming:', resultData.pointCloudFile);
    }

    res.json(response);

  } catch (error) {
    console.error('[Image Stitching] Error:', error);
    res.status(500).json({
      error: 'Failed to stitch panorama',
      details: error.message,
    });
  } finally {
    // Cleanup temp files
    [tempInputFile, tempOutputFile].forEach(file => {
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (err) {
          console.warn('[Image Stitching] Failed to cleanup:', file, err.message);
        }
      }
    });
  }
});

/**
 * GET /api/image-stitching/health
 * Check if Python OpenCV is available
 */
router.get('/health', async (req, res) => {
  try {
    // Test Python availability
    const pythonTest = spawn('python3', ['--version']);
    
    let pythonVersion = '';
    pythonTest.stdout.on('data', (data) => {
      pythonVersion += data.toString();
    });

    await new Promise((resolve, reject) => {
      pythonTest.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Python3 not found'));
      });
    });

    // Test OpenCV availability
    const opencvTest = spawn('python3', ['-c', 'import cv2; print(cv2.__version__)']);
    
    let opencvVersion = '';
    opencvTest.stdout.on('data', (data) => {
      opencvVersion += data.toString();
    });

    await new Promise((resolve, reject) => {
      opencvTest.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('OpenCV not installed'));
      });
    });

    res.json({
      success: true,
      python: pythonVersion.trim(),
      opencv: opencvVersion.trim(),
      scriptPath: PYTHON_SCRIPT,
      scriptExists: fs.existsSync(PYTHON_SCRIPT),
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      suggestion: 'Install Python OpenCV: pip3 install opencv-python numpy'
    });
  }
});

// Endpoint to stream point cloud progressively
// Uses NDJSON format (one point per line) for true streaming
router.get('/point-cloud/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 100000;
    
    // Security: ensure filename is safe
    if (!/^pointcloud(_preview)?_\d+\.(json|ndjson)$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    const filePath = path.join(__dirname, 'data', 'temp-stitching', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Point cloud file not found' });
    }
    
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`[Point Cloud] Streaming ${filename} (${fileSizeMB.toFixed(1)}MB), offset=${offset}, limit=${limit}`);
    
    // NDJSON format - stream line by line
    if (filename.endsWith('.ndjson')) {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      
      const points = [];
      const colors = [];
      let lineNum = 0;
      let total = 0;
      
      for await (const line of rl) {
        if (lineNum === 0) {
          // First line is metadata
          const meta = JSON.parse(line);
          total = meta.total;
        } else {
          const pointIndex = lineNum - 1; // Account for metadata line
          if (pointIndex >= offset && pointIndex < offset + limit) {
            const data = JSON.parse(line);
            points.push(data.p);
            colors.push(data.c);
          }
          if (pointIndex >= offset + limit) {
            // Got enough points, stop reading
            break;
          }
        }
        lineNum++;
      }
      
      rl.close();
      fileStream.destroy();
      
      const hasMore = offset + limit < total;
      console.log(`[Point Cloud] Streamed ${points.length} points (${offset}-${offset + points.length} of ${total})`);
      
      return res.json({
        points,
        colors,
        offset,
        limit,
        total,
        hasMore
      });
    }
    
    // Legacy JSON format (for old files)
    if (fileSizeMB > 50) {
      return res.json({
        points: [],
        colors: [],
        total: 0,
        hasMore: false,
        error: 'File too large for legacy JSON format. Re-scan to generate streamable format.'
      });
    }
    
    const pointCloudData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const points = pointCloudData.points || [];
    const colorData = pointCloudData.colors || [];
    
    res.json({
      points: points.slice(offset, offset + limit),
      colors: colorData.slice(offset, offset + limit),
      offset,
      limit,
      total: points.length,
      hasMore: offset + limit < points.length
    });
    
  } catch (error) {
    console.error('[Point Cloud] Error serving chunk:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
