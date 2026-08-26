/**
 * Image Quality Analysis Service
 * 
 * Real-time analysis of captured frames for:
 * - Blur detection (Laplacian variance)
 * - Feature density (FAST corner detection)
 * - Stability assessment
 * 
 * Used to determine if a frame is suitable for photogrammetry
 * and to provide real-time feedback to the user.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface QualityMetrics {
  /** Sharpness score 0-1, higher = sharper */
  sharpness: number;
  
  /** Number of detected corner features */
  featureCount: number;
  
  /** Feature density per megapixel */
  featureDensity: number;
  
  /** Whether this frame is usable for photogrammetry */
  isUsable: boolean;
  
  /** Warning message if quality is low */
  warning: string | null;
  
  /** Quality score 0-100 for UI display */
  overallScore: number;
  
  /** Analysis timestamp */
  timestamp: number;
  
  /** Processing time in ms */
  processingTime: number;
}

export interface QualityThresholds {
  /** Minimum sharpness to accept (0-1) */
  minSharpness: number;
  
  /** Minimum feature count to accept */
  minFeatures: number;
  
  /** Feature count for "good" quality */
  goodFeatures: number;
  
  /** FAST corner detection threshold (lower = more sensitive) */
  fastThreshold: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minSharpness: 0.20,      // Below this = definitely blurry (lowered slightly)
  minFeatures: 50,         // Very low threshold - Depth Anything handles featureless areas
  goodFeatures: 300,       // Target for "good" quality display
  fastThreshold: 20,       // FAST detector sensitivity
};

// =============================================================================
// LAPLACIAN VARIANCE (BLUR DETECTION)
// =============================================================================

/**
 * Compute Laplacian variance as a sharpness metric.
 * 
 * The Laplacian highlights edges. Blurry images have few strong edges,
 * resulting in low variance. Sharp images have many edges = high variance.
 * 
 * @param imageData - ImageData from canvas
 * @returns Normalized sharpness score 0-1
 */
export function computeLaplacianVariance(imageData: ImageData): number {
  const { data, width, height } = imageData;
  
  // Downsample for performance (analyze every 4th pixel)
  const step = 4;
  const values: number[] = [];
  
  // Laplacian kernel: [0, 1, 0], [1, -4, 1], [0, 1, 0]
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      // Get grayscale values in 3x3 neighborhood
      const getGray = (px: number, py: number): number => {
        const idx = (py * width + px) * 4;
        return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      };
      
      const center = getGray(x, y);
      const top = getGray(x, y - step);
      const bottom = getGray(x, y + step);
      const left = getGray(x - step, y);
      const right = getGray(x + step, y);
      
      // Laplacian = sum of neighbors - 4 * center
      const laplacian = top + bottom + left + right - 4 * center;
      values.push(laplacian);
    }
  }
  
  // Compute variance
  if (values.length === 0) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  
  // Normalize to 0-1 range
  // Typical variance range: 0 (very blurry) to 2000+ (very sharp)
  // Using sigmoid-like normalization
  const normalized = Math.min(1, variance / 1000);
  
  return normalized;
}

/**
 * Fast blur detection using gradient magnitude.
 * Faster than full Laplacian but less accurate.
 * 
 * @param imageData - ImageData from canvas
 * @returns Normalized sharpness score 0-1
 */
export function computeGradientMagnitude(imageData: ImageData): number {
  const { data, width, height } = imageData;
  
  let totalGradient = 0;
  let count = 0;
  const step = 4;
  
  for (let y = 0; y < height - step; y += step) {
    for (let x = 0; x < width - step; x += step) {
      const idx = (y * width + x) * 4;
      const idxRight = (y * width + x + step) * 4;
      const idxDown = ((y + step) * width + x) * 4;
      
      // Grayscale
      const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const grayRight = (data[idxRight] + data[idxRight + 1] + data[idxRight + 2]) / 3;
      const grayDown = (data[idxDown] + data[idxDown + 1] + data[idxDown + 2]) / 3;
      
      // Gradient magnitude (Sobel-like)
      const gx = grayRight - gray;
      const gy = grayDown - gray;
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      
      totalGradient += magnitude;
      count++;
    }
  }
  
  const avgGradient = count > 0 ? totalGradient / count : 0;
  
  // Normalize: typical range 0-50
  return Math.min(1, avgGradient / 30);
}


// =============================================================================
// FAST CORNER DETECTION
// =============================================================================

interface Point {
  x: number;
  y: number;
  score: number;
}

/**
 * FAST (Features from Accelerated Segment Test) corner detection.
 * 
 * Detects corners by checking if pixels on a circle around a candidate
 * are all brighter or all darker than the center pixel.
 * 
 * This is a simplified FAST-9 implementation optimized for speed.
 * 
 * @param imageData - ImageData from canvas
 * @param threshold - Intensity threshold (default 20)
 * @returns Array of corner points
 */
export function detectFASTCorners(
  imageData: ImageData,
  threshold: number = 20
): Point[] {
  const { data, width, height } = imageData;
  const corners: Point[] = [];
  
  // Circle of 16 pixels at radius 3 (FAST-9 uses 9 contiguous pixels)
  // We'll use a simplified version checking 8 cardinal + diagonal points
  const circle = [
    { dx: 0, dy: -3 },   // N
    { dx: 2, dy: -2 },   // NE
    { dx: 3, dy: 0 },    // E
    { dx: 2, dy: 2 },    // SE
    { dx: 0, dy: 3 },    // S
    { dx: -2, dy: 2 },   // SW
    { dx: -3, dy: 0 },   // W
    { dx: -2, dy: -2 },  // NW
  ];
  
  // Step for performance (analyze every 2nd pixel)
  const step = 2;
  const margin = 4;
  
  // Pre-compute grayscale image
  const grayscale = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    grayscale[i] = Math.round((data[idx] + data[idx + 1] + data[idx + 2]) / 3);
  }
  
  // Detect corners
  for (let y = margin; y < height - margin; y += step) {
    for (let x = margin; x < width - margin; x += step) {
      const centerIdx = y * width + x;
      const centerVal = grayscale[centerIdx];
      
      let brighter = 0;
      let darker = 0;
      let score = 0;
      
      // Check circle pixels
      for (const { dx, dy } of circle) {
        const circleIdx = (y + dy) * width + (x + dx);
        const circleVal = grayscale[circleIdx];
        const diff = circleVal - centerVal;
        
        if (diff > threshold) {
          brighter++;
          score += diff - threshold;
        } else if (diff < -threshold) {
          darker++;
          score += -diff - threshold;
        }
      }
      
      // FAST-9: Need 9 contiguous pixels (we use 5 out of 8 as approximation)
      if (brighter >= 5 || darker >= 5) {
        corners.push({ x, y, score });
      }
    }
  }
  
  // Non-maximum suppression (simple version)
  return nonMaxSuppression(corners, 8);
}

/**
 * Simple non-maximum suppression to remove duplicate corners.
 */
function nonMaxSuppression(corners: Point[], radius: number): Point[] {
  if (corners.length === 0) return [];
  
  // Sort by score descending
  corners.sort((a, b) => b.score - a.score);
  
  const kept: Point[] = [];
  const suppressed = new Set<number>();
  
  for (let i = 0; i < corners.length; i++) {
    if (suppressed.has(i)) continue;
    
    kept.push(corners[i]);
    
    // Suppress nearby corners
    for (let j = i + 1; j < corners.length; j++) {
      const dx = corners[i].x - corners[j].x;
      const dy = corners[i].y - corners[j].y;
      if (dx * dx + dy * dy < radius * radius) {
        suppressed.add(j);
      }
    }
  }
  
  return kept;
}


// =============================================================================
// COMBINED QUALITY ANALYSIS
// =============================================================================

/**
 * Analyze a frame for photogrammetry quality.
 * 
 * Combines blur detection and feature counting to determine
 * if a frame is suitable for 3D reconstruction.
 * 
 * @param imageData - ImageData from canvas getImageData()
 * @param thresholds - Quality thresholds (optional)
 * @returns Quality metrics
 */
export function analyzeFrame(
  imageData: ImageData,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS
): QualityMetrics {
  const startTime = performance.now();
  
  // Compute sharpness (Laplacian variance)
  const sharpness = computeLaplacianVariance(imageData);
  
  // Detect corners (FAST)
  const corners = detectFASTCorners(imageData, thresholds.fastThreshold);
  const featureCount = corners.length;
  
  // Feature density (per megapixel)
  const megapixels = (imageData.width * imageData.height) / 1_000_000;
  const featureDensity = featureCount / megapixels;
  
  // Determine if usable
  // CRITICAL: Sharpness is the primary filter. Low-feature photos (walls, ceilings)
  // are ACCEPTED because Depth Anything v2 will provide depth priors for them.
  // Only reject truly blurry photos that would be useless for any reconstruction.
  const isSharp = sharpness >= thresholds.minSharpness;
  const hasMinimalFeatures = featureCount >= thresholds.minFeatures;
  const hasGoodFeatures = featureCount >= thresholds.goodFeatures;
  
  // Accept if sharp, even with low features (Depth Anything handles those)
  // Only reject if both blurry AND low features
  const isUsable = isSharp;  // Sharpness is the key - features are optional with Depth Anything
  
  // Generate warning (informational, not blocking)
  let warning: string | null = null;
  if (!isSharp) {
    warning = 'Too blurry - hold camera steady';
  } else if (!hasMinimalFeatures) {
    // Informational only - still usable with Depth Anything
    warning = 'Low feature area (OK - depth AI will help)';
  } else if (!hasGoodFeatures) {
    warning = null; // Acceptable quality, no warning needed
  }
  
  // Compute overall score (0-100)
  const sharpnessScore = Math.min(100, sharpness * 100);
  const featureScore = Math.min(100, (featureCount / thresholds.goodFeatures) * 100);
  const overallScore = Math.round((sharpnessScore + featureScore) / 2);
  
  const processingTime = performance.now() - startTime;
  
  return {
    sharpness,
    featureCount,
    featureDensity,
    isUsable,
    warning,
    overallScore,
    timestamp: Date.now(),
    processingTime,
  };
}

/**
 * Analyze a frame from a video element.
 * 
 * Convenience function that extracts ImageData from a video element
 * and runs quality analysis.
 * 
 * @param video - HTMLVideoElement with active stream
 * @param thresholds - Quality thresholds (optional)
 * @returns Quality metrics or null if video not ready
 */
export function analyzeVideoFrame(
  video: HTMLVideoElement,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS
): QualityMetrics | null {
  if (!video.videoWidth || !video.videoHeight) {
    console.warn('[ImageQuality] Video not ready:', { 
      videoWidth: video.videoWidth, 
      videoHeight: video.videoHeight,
      readyState: video.readyState 
    });
    return null;
  }
  
  // Create off-screen canvas for analysis
  // Use reduced resolution for speed (720p equivalent)
  const scale = Math.min(1, 720 / video.videoHeight);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  
  ctx.drawImage(video, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  
  return analyzeFrame(imageData, thresholds);
}

/**
 * Analyze quality from a base64 image string.
 * 
 * @param imageDataUrl - Base64 image data URL
 * @param thresholds - Quality thresholds
 * @returns Promise resolving to quality metrics
 */
export async function analyzeImageDataUrl(
  imageDataUrl: string,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS
): Promise<QualityMetrics> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Analyze at reduced resolution for speed
      const scale = Math.min(1, 720 / img.height);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      resolve(analyzeFrame(imageData, thresholds));
    };
    
    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };
    
    img.src = imageDataUrl;
  });
}


// =============================================================================
// MOTION STABILITY ANALYSIS
// =============================================================================

interface MotionSample {
  timestamp: number;
  rotationRate: { alpha: number; beta: number; gamma: number };
}

/**
 * Motion stability analyzer using device gyroscope.
 * 
 * Tracks angular velocity over time to determine if the device
 * is stable enough for a sharp capture.
 */
export class MotionStabilityAnalyzer {
  private samples: MotionSample[] = [];
  private readonly maxSamples = 10; // ~100ms at 100Hz
  private readonly stableThreshold = 25; // degrees per second (relaxed for handheld scanning)
  
  /**
   * Add a motion sample from DeviceMotionEvent.
   */
  addSample(event: DeviceMotionEvent): void {
    const rotationRate = event.rotationRate;
    if (!rotationRate) return;
    
    this.samples.push({
      timestamp: Date.now(),
      rotationRate: {
        alpha: rotationRate.alpha || 0,
        beta: rotationRate.beta || 0,
        gamma: rotationRate.gamma || 0,
      },
    });
    
    // Keep only recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }
  
  /**
   * Get current stability score (0-1, higher = more stable).
   */
  getStability(): number {
    if (this.samples.length < 3) return 0.5; // Not enough data
    
    // Compute average angular velocity
    let totalRate = 0;
    for (const sample of this.samples) {
      const rate = Math.sqrt(
        sample.rotationRate.alpha ** 2 +
        sample.rotationRate.beta ** 2 +
        sample.rotationRate.gamma ** 2
      );
      totalRate += rate;
    }
    
    const avgRate = totalRate / this.samples.length;
    
    // Convert to stability score (inverse of motion)
    // 0 deg/s = 1.0 stability, stableThreshold deg/s = 0.5, 2x threshold = 0
    const stability = Math.max(0, 1 - avgRate / (this.stableThreshold * 2));
    
    return stability;
  }
  
  /**
   * Check if device is stable enough for capture.
   * Threshold lowered to 0.4 to allow normal handheld scanning.
   */
  isStable(): boolean {
    return this.getStability() >= 0.4;
  }
  
  /**
   * Reset samples.
   */
  reset(): void {
    this.samples = [];
  }
}


// =============================================================================
// QUALITY ANALYSIS SERVICE (SINGLETON)
// =============================================================================

class ImageQualityService {
  private motionAnalyzer = new MotionStabilityAnalyzer();
  private lastAnalysis: QualityMetrics | null = null;
  private analysisInterval: NodeJS.Timeout | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private onUpdate: ((metrics: QualityMetrics) => void) | null = null;
  
  /**
   * Start continuous quality analysis on a video element.
   */
  startContinuousAnalysis(
    video: HTMLVideoElement,
    onUpdate: (metrics: QualityMetrics) => void,
    intervalMs: number = 100
  ): void {
    this.stopContinuousAnalysis();
    
    this.videoElement = video;
    this.onUpdate = onUpdate;
    
    // Start motion listening
    if (typeof DeviceMotionEvent !== 'undefined') {
      window.addEventListener('devicemotion', this.handleMotion);
    }
    
    // Wait for video to be ready before starting analysis
    const startAnalysisLoop = () => {
      console.log('[ImageQuality] Video ready, starting analysis loop:', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState
      });
      
      // Start analysis loop
      this.analysisInterval = setInterval(() => {
        this.runAnalysis();
      }, intervalMs);
    };
    
    // Check if video is already ready
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      console.log('[ImageQuality] Video already ready');
      startAnalysisLoop();
    } else {
      console.log('[ImageQuality] Waiting for video to be ready...');
      // Wait for video to load
      const onReady = () => {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        startAnalysisLoop();
      };
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      
      // Also try after a short delay as fallback
      setTimeout(() => {
        if (!this.analysisInterval && video.videoWidth > 0) {
          console.log('[ImageQuality] Fallback: starting analysis after delay');
          startAnalysisLoop();
        }
      }, 500);
    }
  }
  
  /**
   * Stop continuous analysis.
   */
  stopContinuousAnalysis(): void {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    
    window.removeEventListener('devicemotion', this.handleMotion);
    
    this.videoElement = null;
    this.onUpdate = null;
    this.motionAnalyzer.reset();
    
    console.log('[ImageQuality] Stopped continuous analysis');
  }
  
  private handleMotion = (event: DeviceMotionEvent): void => {
    this.motionAnalyzer.addSample(event);
  };
  
  private runAnalysis(): void {
    if (!this.videoElement || !this.onUpdate) {
      console.warn('[ImageQuality] runAnalysis skipped:', { 
        hasVideo: !!this.videoElement, 
        hasCallback: !!this.onUpdate 
      });
      return;
    }
    
    const metrics = analyzeVideoFrame(this.videoElement);
    if (metrics) {
      this.lastAnalysis = metrics;
      this.onUpdate(metrics);
    }
  }
  
  /**
   * Get last analysis result.
   */
  getLastAnalysis(): QualityMetrics | null {
    return this.lastAnalysis;
  }
  
  /**
   * Get current motion stability.
   */
  getStability(): number {
    return this.motionAnalyzer.getStability();
  }
  
  /**
   * Check if conditions are good for capture.
   */
  isGoodForCapture(): boolean {
    if (!this.lastAnalysis) return false;
    
    return (
      this.lastAnalysis.isUsable &&
      this.motionAnalyzer.isStable()
    );
  }
}

// Singleton instance
let serviceInstance: ImageQualityService | null = null;

/**
 * Get the image quality service singleton.
 */
export function getImageQualityService(): ImageQualityService {
  if (!serviceInstance) {
    serviceInstance = new ImageQualityService();
  }
  return serviceInstance;
}

// Export types and defaults
export { ImageQualityService };
