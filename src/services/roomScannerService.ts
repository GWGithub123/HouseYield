/**
 * Room Scanner Service
 * Integrates OpenAI (guidance), ZoeDepth (metric depth estimation), and Luma AI (3D reconstruction)
 * 
 * ZoeDepth provides METRIC depth estimation for accurate room dimension measurement,
 * enabling precise renovation cost calculations based on actual square footage.
 */

import {
  ScanSession,
  CapturedFrame,
  ScanGuidance,
  ScanCoverage,
  ScannerConfig,
  DeviceOrientation,
  FrameQuality,
  Model3DResult,
  FrameAnalysis,
  ScanCommand,
  RoomDimensions
} from '../types/roomScanner';
import { requestAiChatCompletion } from './aiChatProxy';
import { getMobileScanAuthHeaders, getScannerApiBaseUrl, getScannerPublicBaseUrl } from './mobileScanConfig';

const BACKEND_URL = getScannerApiBaseUrl();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LUMA_API_KEY = import.meta.env.VITE_LUMA_API_KEY || '';

function getAuthHeaders(): Record<string, string> {
  return getMobileScanAuthHeaders();
}

function normalizeSavedScanViewerUrl(viewerUrl: unknown): string | null {
  if (typeof viewerUrl !== 'string') {
    return null;
  }

  const trimmedViewerUrl = viewerUrl.trim();
  if (!trimmedViewerUrl) {
    return null;
  }

  if (trimmedViewerUrl.startsWith('/room-tour-view/')) {
    return trimmedViewerUrl;
  }

  let parsedViewerUrl: URL;
  try {
    parsedViewerUrl = new URL(trimmedViewerUrl, window.location.origin);
  } catch {
    return trimmedViewerUrl;
  }

  if (!parsedViewerUrl.pathname.startsWith('/room-tour-view/')) {
    return trimmedViewerUrl;
  }

  let scannerOrigin = '';
  const scannerBaseUrl = getScannerPublicBaseUrl();
  if (scannerBaseUrl) {
    try {
      scannerOrigin = new URL(scannerBaseUrl).origin;
    } catch {
      scannerOrigin = '';
    }
  }

  if (parsedViewerUrl.origin === window.location.origin || (scannerOrigin && parsedViewerUrl.origin === scannerOrigin)) {
    return `${parsedViewerUrl.pathname}${parsedViewerUrl.search}${parsedViewerUrl.hash}`;
  }

  return trimmedViewerUrl;
}

function normalizeSavedScanMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) {
    return metadata;
  }

  const normalizedViewerUrl = normalizeSavedScanViewerUrl(metadata.modelViewerUrl);
  if (normalizedViewerUrl === metadata.modelViewerUrl || (!normalizedViewerUrl && !metadata.modelViewerUrl)) {
    return metadata;
  }

  return {
    ...metadata,
    modelViewerUrl: normalizedViewerUrl,
  };
}

function normalizeSavedScanSummary(scan: SavedScanSummary): SavedScanSummary {
  const normalizedMetadata = normalizeSavedScanMetadata(scan.metadata);
  if (normalizedMetadata === scan.metadata) {
    return scan;
  }

  return {
    ...scan,
    metadata: normalizedMetadata,
  };
}

function normalizeSavedScanFull(scan: SavedScanFull): SavedScanFull {
  const normalizedMetadata = normalizeSavedScanMetadata(scan.metadata);
  if (normalizedMetadata === scan.metadata) {
    return scan;
  }

  return {
    ...scan,
    metadata: normalizedMetadata || {},
  };
}

function safeParseJsonResponse(text: string) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Debug logging to server (so we can see it in terminal)
async function debugLog(message: string, data?: any) {
  try {
    await fetch(`${BACKEND_URL}/api/room-scanner/debug-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ message, data })
    });
  } catch (e) {
    // Ignore errors
  }
}

// Check if running on iOS device
export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
export const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

/**
 * =====================================================
 * ANCHOR-BASED ORIENTATION TRACKING
 * =====================================================
 * Uses the first photo's orientation as an anchor point to calculate
 * relative rotation. This provides consistent scan coverage tracking
 * regardless of which direction the user starts facing.
 */

/**
 * Normalize an angle to 0-360 range
 */
export function normalizeAngle(angle: number): number {
  let normalized = angle % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

/**
 * Calculate the relative angle from anchor to current orientation
 * Returns a value from 0-360 representing how far the user has rotated
 * from their starting position (clockwise = positive)
 */
export function calculateRelativeAlpha(
  currentAlpha: number,
  anchorAlpha: number
): number {
  // Calculate the difference and normalize to 0-360
  const diff = currentAlpha - anchorAlpha;
  return normalizeAngle(diff);
}

/**
 * Get the sector (0-7) for a given relative angle
 * Each sector is 45 degrees:
 * Sector 0: 0-45° (front-right)
 * Sector 1: 45-90° (right)
 * Sector 2: 90-135° (back-right)
 * Sector 3: 135-180° (back)
 * Sector 4: 180-225° (back-left)
 * Sector 5: 225-270° (left)
 * Sector 6: 270-315° (front-left)
 * Sector 7: 315-360° (front)
 */
export function getSectorFromAngle(relativeAlpha: number): number {
  const normalized = normalizeAngle(relativeAlpha);
  return Math.floor(normalized / 45);
}

/**
 * Get human-readable sector name based on relative position from anchor
 */
export function getSectorName(sector: number): string {
  const names = [
    'front-right',
    'right',
    'back-right',
    'back',
    'back-left',
    'left',
    'front-left',
    'front'
  ];
  return names[sector % 8];
}

/**
 * Calculate which sectors have been covered based on captured frames
 * relative to the anchor orientation
 */
export function calculateCoveredSectors(
  frames: CapturedFrame[],
  anchorOrientation: DeviceOrientation | undefined
): Set<number> {
  const covered = new Set<number>();
  
  if (!anchorOrientation || frames.length === 0) {
    return covered;
  }
  
  frames.forEach(frame => {
    const relativeAlpha = calculateRelativeAlpha(
      frame.orientation.alpha,
      anchorOrientation.alpha
    );
    const sector = getSectorFromAngle(relativeAlpha);
    covered.add(sector);
  });
  
  return covered;
}

/**
 * Get the next recommended sector to scan based on what's been covered
 * Prioritizes completing a full 360° rotation
 */
export function getNextRecommendedSector(
  coveredSectors: Set<number>,
  currentSector: number
): { sector: number; direction: 'left' | 'right'; angleDiff: number } | null {
  if (coveredSectors.size >= 8) {
    return null; // All sectors covered
  }
  
  // Find the nearest uncovered sector
  // Check clockwise first (right turn), then counter-clockwise (left turn)
  for (let offset = 1; offset <= 4; offset++) {
    const rightSector = (currentSector + offset) % 8;
    if (!coveredSectors.has(rightSector)) {
      return {
        sector: rightSector,
        direction: 'right',
        angleDiff: offset * 45
      };
    }
    
    const leftSector = (currentSector - offset + 8) % 8;
    if (!coveredSectors.has(leftSector)) {
      return {
        sector: leftSector,
        direction: 'left',
        angleDiff: offset * 45
      };
    }
  }
  
  return null;
}

/**
 * Clear all browser caches to ensure latest version is loaded
 * Call this when BUILD_VERSION changes
 */
export async function clearAllCaches(): Promise<void> {
  try {
    // Clear Cache API
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      console.log('[Room Scanner] Cleared Cache API:', cacheNames);
    }
    
    // Clear Service Worker cache and update
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.update();
        console.log('[Room Scanner] Updated service worker');
      }
    }
    
    console.log('[Room Scanner] All caches cleared successfully');
  } catch (error) {
    console.warn('[Room Scanner] Error clearing caches:', error);
  }
}

/**
 * Check if a new version is available and reload if needed
 */
export async function checkForUpdates(currentVersion: string): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/version`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...getAuthHeaders()
      }
    });
    
    if (response.ok) {
      const { version } = await response.json();
      if (version !== currentVersion) {
        console.log('[Room Scanner] New version available:', version, 'Current:', currentVersion);
        return true;
      }
    }
  } catch (error) {
    console.warn('[Room Scanner] Error checking for updates:', error);
  }
  
  return false;
}

// Default scanner configuration
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  captureInterval: 500,      // Capture every 500ms
  minFrames: 20,             // Minimum 20 frames
  maxFrames: 100,            // Maximum 100 frames
  autoCapture: true,
  enableVoiceGuidance: true,
  enableDepthPreview: true,
  targetCoverage: 85,
  resolution: 'high'
};

/**
 * Generate unique ID for scan sessions and frames
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a new scan session
 */
export function createScanSession(roomName: string, propertyId?: string): ScanSession {
  return {
    id: generateId(),
    propertyId,
    roomName,
    status: 'initializing',
    frames: [],
    coverage: {
      percentage: 0,
      scannedAreas: [],
      missingAreas: ['north wall', 'south wall', 'east wall', 'west wall', 'floor', 'ceiling'],
      estimatedTimeRemaining: 120
    },
    createdAt: new Date()
  };
}

/**
 * Assess frame quality using client-side analysis
 */
export function assessFrameQuality(_imageData: string): FrameQuality {
  // In a real implementation, this would analyze the image
  // For now, return a placeholder that assumes decent quality
  return {
    blur: 0.1,
    brightness: 0.5,
    contrast: 0.7,
    usable: true,
    issues: []
  };
}

/**
 * Create a captured frame object
 */
export function createCapturedFrame(
  imageData: string,
  orientation: DeviceOrientation
): CapturedFrame {
  return {
    id: generateId(),
    timestamp: Date.now(),
    imageData,
    orientation,
    quality: assessFrameQuality(imageData)
  };
}

/**
 * Get AI-powered scanning guidance using OpenAI GPT-4o Vision
 */
export async function getScanningGuidance(
  currentFrame: string,
  capturedFrames: CapturedFrame[],
  coverage: ScanCoverage
): Promise<ScanGuidance> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/guidance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        currentFrame,
        frameCount: capturedFrames.length,
        coverage,
        recentOrientations: capturedFrames.slice(-5).map(f => f.orientation)
      })
    });

    if (!response.ok) {
      throw new Error('Failed to get guidance');
    }

    const data = await response.json();
    return data.guidance;
  } catch (error) {
    console.warn('Falling back to local guidance:', error);
    return getLocalGuidance(capturedFrames, coverage);
  }
}

/**
 * Local heuristic-based guidance when API is unavailable
 * Uses anchor-relative orientation for accurate guidance based on what's been scanned
 */
function getLocalGuidance(
  frames: CapturedFrame[],
  coverage: ScanCoverage,
  anchorOrientation?: DeviceOrientation
): ScanGuidance {
  const frameCount = frames.length;
  
  // Initial scanning guidance - only for very first frames
  if (frameCount < 3) {
    return {
      command: 'hold_steady',
      message: 'Hold steady. Recording starting position...',
      confidence: 1,
      priority: 'high'
    };
  }
  
  // Use anchor-relative guidance if we have anchor
  const anchor = anchorOrientation || (frames.length > 0 ? frames[0].orientation : null);
  
  if (anchor && frameCount >= 3) {
    const coveredSectors = calculateCoveredSectors(frames, anchor);
    const currentFrame = frames[frames.length - 1];
    const currentRelativeAlpha = calculateRelativeAlpha(currentFrame.orientation.alpha, anchor.alpha);
    const currentSector = getSectorFromAngle(currentRelativeAlpha);
    
    // Check if all 8 horizontal sectors are covered
    if (coveredSectors.size >= 8) {
      // Check vertical coverage
      const hasCeiling = frames.some(f => f.orientation.beta < -20);
      const hasFloor = frames.some(f => f.orientation.beta > 20);
      
      if (!hasCeiling) {
        return {
          command: 'look_up',
          message: 'Great rotation coverage! Now tilt up to capture the ceiling',
          confidence: 0.9,
          priority: 'medium',
          visualGuide: { type: 'arrow', position: { x: 0.5, y: 0.2 }, direction: 0 }
        };
      }
      
      if (!hasFloor) {
        return {
          command: 'look_down',
          message: 'Almost done! Tilt down to capture the floor',
          confidence: 0.9,
          priority: 'medium',
          visualGuide: { type: 'arrow', position: { x: 0.5, y: 0.8 }, direction: 180 }
        };
      }
      
      // All coverage complete
      return {
        command: 'scan_complete',
        message: 'Excellent! Full 360° rotation captured. Processing...',
        confidence: 1,
        priority: 'high'
      };
    }
    
    // Find the next sector to capture
    const nextSector = getNextRecommendedSector(coveredSectors, currentSector);
    
    if (nextSector) {
      const sectorsScanned = coveredSectors.size;
      const progressMsg = `${sectorsScanned}/8 sections captured. `;
      
      if (nextSector.direction === 'right') {
        return {
          command: 'turn_right',
          message: progressMsg + `Turn right about ${nextSector.angleDiff}° to capture the ${getSectorName(nextSector.sector)} area`,
          confidence: 0.9,
          priority: 'medium',
          visualGuide: { type: 'arrow', position: { x: 0.8, y: 0.5 }, direction: 90 }
        };
      } else {
        return {
          command: 'turn_left',
          message: progressMsg + `Turn left about ${nextSector.angleDiff}° to capture the ${getSectorName(nextSector.sector)} area`,
          confidence: 0.9,
          priority: 'medium',
          visualGuide: { type: 'arrow', position: { x: 0.2, y: 0.5 }, direction: 270 }
        };
      }
    }
  }
  
  // Fallback to phase-based guidance if anchor-relative doesn't work
  const phase = Math.floor(frameCount / 15) % 6; // Cycle through 6 phases
  
  // Give directional guidance based on scan phase
  if (frameCount >= 3 && frameCount < 15) {
    return {
      command: 'turn_right',
      message: 'Slowly pan right to capture more of the room',
      confidence: 0.85,
      priority: 'medium'
    };
  }
  
  if (phase === 1) {
    return {
      command: 'look_up',
      message: 'Tilt up slightly to get the ceiling',
      confidence: 0.8,
      priority: 'medium'
    };
  }
  
  if (phase === 2) {
    return {
      command: 'turn_left',
      message: 'Now pan left to complete this section',
      confidence: 0.8,
      priority: 'medium'
    };
  }
  
  if (phase === 3) {
    return {
      command: 'look_down',
      message: 'Tilt down to capture the floor area',
      confidence: 0.8,
      priority: 'medium'
    };
  }
  
  if (phase === 4) {
    return {
      command: 'move_forward',
      message: 'Take a few steps forward for more detail',
      confidence: 0.75,
      priority: 'low'
    };
  }
  
  if (phase === 5) {
    return {
      command: 'scan_corner',
      message: 'Point at a corner to capture room edges',
      confidence: 0.75,
      priority: 'low'
    };
  }

  // Check coverage and suggest next direction
  const missingAreas = coverage.missingAreas;
  
  // Use anchor-relative sector names
  const missingSectorAreas = missingAreas.filter(area => 
    area.includes('front') || area.includes('back') || 
    area.includes('left') || area.includes('right')
  );
  
  if (missingSectorAreas.length > 0) {
    const firstMissing = missingSectorAreas[0];
    if (firstMissing.includes('left')) {
      return {
        command: 'turn_left',
        message: `Turn left to capture the ${firstMissing.replace(' area', '')} side`,
        confidence: 0.8,
        priority: 'medium',
        visualGuide: { type: 'arrow', position: { x: 0.2, y: 0.5 }, direction: 270 }
      };
    }
    if (firstMissing.includes('right')) {
      return {
        command: 'turn_right',
        message: `Turn right to capture the ${firstMissing.replace(' area', '')} side`,
        confidence: 0.8,
        priority: 'medium',
        visualGuide: { type: 'arrow', position: { x: 0.8, y: 0.5 }, direction: 90 }
      };
    }
    if (firstMissing.includes('back')) {
      return {
        command: 'turn_right',
        message: 'Continue rotating to capture behind you',
        confidence: 0.8,
        priority: 'medium',
        visualGuide: { type: 'arrow', position: { x: 0.8, y: 0.5 }, direction: 90 }
      };
    }
  }

  if (missingAreas.includes('ceiling')) {
    return {
      command: 'look_up',
      message: 'Tilt the camera up to capture the ceiling',
      confidence: 0.8,
      priority: 'medium',
      visualGuide: { type: 'arrow', position: { x: 0.5, y: 0.2 }, direction: 0 }
    };
  }

  if (missingAreas.includes('floor')) {
    return {
      command: 'look_down',
      message: 'Tilt the camera down to capture the floor',
      confidence: 0.8,
      priority: 'medium',
      visualGuide: { type: 'arrow', position: { x: 0.5, y: 0.8 }, direction: 180 }
    };
  }

  if (coverage.percentage >= 85) {
    return {
      command: 'scan_complete',
      message: 'Great job! Room scan is complete. Processing...',
      confidence: 1,
      priority: 'high'
    };
  }

  // Default: varied scanning guidance based on frame count
  const defaultMessages = [
    { command: 'turn_right', message: 'Turn right slowly to capture more', direction: 90, x: 0.8 },
    { command: 'turn_left', message: 'Now pan to the left', direction: 270, x: 0.2 },
    { command: 'move_forward', message: 'Move a step closer', direction: 0, x: 0.5 },
    { command: 'look_up', message: 'Capture the upper portion', direction: 0, x: 0.5 },
    { command: 'look_down', message: 'Get the floor and lower walls', direction: 180, x: 0.5 },
  ];
  
  const msgIndex = Math.floor(frameCount / 30) % defaultMessages.length;
  const selected = defaultMessages[msgIndex];
  
  return {
    command: selected.command as ScanCommand,
    message: selected.message,
    confidence: 0.7,
    priority: 'low',
    visualGuide: { type: 'arrow', position: { x: selected.x, y: 0.5 }, direction: selected.direction }
  };
}

/**
 * Analyze frame with OpenAI Vision API
 */
export async function analyzeFrame(imageBase64: string): Promise<FrameAnalysis> {
  try {
    const data = await requestAiChatCompletion({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a room scanning assistant. Analyze the image and provide guidance for 3D room capture. 
            Respond in JSON format with: roomType, visibleFeatures (array), missingAreas (array), 
            lightingQuality (poor/fair/good/excellent), suggestedAction (turn_left/turn_right/move_forward/move_back/look_up/look_down/hold_steady/scan_corner/get_closer/step_back), 
            and detailedFeedback (string).`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this room image for 3D scanning. What areas are visible? What should I capture next?' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500
    });

    return JSON.parse(data.choices[0].message.content);
  } catch (error) {
    console.error('Frame analysis error:', error);
    return {
      roomType: 'unknown',
      visibleFeatures: [],
      missingAreas: ['unable to analyze'],
      lightingQuality: 'fair',
      suggestedAction: 'hold_steady',
      detailedFeedback: 'Continue scanning the room.'
    };
  }
}

/**
 * Calculate scan coverage based on captured frames
 * Uses anchor-relative orientation for accurate tracking
 */
export function calculateCoverage(
  frames: CapturedFrame[],
  anchorOrientation?: DeviceOrientation
): ScanCoverage {
  if (frames.length === 0) {
    return {
      percentage: 0,
      scannedAreas: [],
      missingAreas: ['sector 0', 'sector 1', 'sector 2', 'sector 3', 'sector 4', 'sector 5', 'sector 6', 'sector 7', 'floor', 'ceiling'],
      estimatedTimeRemaining: 120
    };
  }

  // Use first frame as anchor if not provided
  const anchor = anchorOrientation || frames[0].orientation;
  
  // Track which sectors have been covered (8 sectors of 45° each)
  const coveredSectors = calculateCoveredSectors(frames, anchor);
  
  // Track vertical coverage
  let hasUp = false;
  let hasDown = false;
  let hasCenter = false;
  
  frames.forEach(frame => {
    const beta = frame.orientation.beta;
    if (beta < -20) hasUp = true;
    if (beta > 20) hasDown = true;
    if (Math.abs(beta) <= 20) hasCenter = true;
  });

  const scannedAreas: ScanCoverage['scannedAreas'] = [];
  const missingAreas: string[] = [];

  // Add horizontal sector coverage
  for (let sector = 0; sector < 8; sector++) {
    const sectorName = getSectorName(sector);
    if (coveredSectors.has(sector)) {
      scannedAreas.push({
        name: sectorName,
        direction: sectorName as any, // Use relative direction names
        coverage: 80 + Math.random() * 20,
        frameIds: frames.filter(f => {
          const relAlpha = calculateRelativeAlpha(f.orientation.alpha, anchor.alpha);
          return getSectorFromAngle(relAlpha) === sector;
        }).map(f => f.id)
      });
    } else {
      missingAreas.push(`${sectorName} area`);
    }
  }

  // Add vertical coverage
  if (hasUp) {
    scannedAreas.push({
      name: 'ceiling',
      direction: 'up',
      coverage: 85,
      frameIds: frames.filter(f => f.orientation.beta < -20).map(f => f.id)
    });
  } else {
    missingAreas.push('ceiling');
  }

  if (hasDown) {
    scannedAreas.push({
      name: 'floor',
      direction: 'down',
      coverage: 85,
      frameIds: frames.filter(f => f.orientation.beta > 20).map(f => f.id)
    });
  } else {
    missingAreas.push('floor');
  }

  if (hasCenter) {
    scannedAreas.push({
      name: 'center/eye level',
      direction: 'center',
      coverage: 90,
      frameIds: frames.filter(f => Math.abs(f.orientation.beta) <= 20).map(f => f.id)
    });
  }

  // Calculate percentage based on sectors covered (8 horizontal + 2 vertical = 10 areas)
  // Weight horizontal coverage more (70%) than vertical (30%)
  const horizontalCoverage = (coveredSectors.size / 8) * 70;
  const verticalCoverage = ((hasUp ? 1 : 0) + (hasDown ? 1 : 0)) / 2 * 30;
  const percentage = Math.min(100, horizontalCoverage + verticalCoverage);
  
  const estimatedTimeRemaining = Math.max(0, (100 - percentage) * 1.2);

  return {
    percentage,
    scannedAreas,
    missingAreas,
    estimatedTimeRemaining
  };
}

/**
 * Process METRIC depth estimation using ZoeDepth (via backend)
 * ZoeDepth provides absolute depth values in meters, enabling accurate room measurement
 * @param imageBase64 - Base64 encoded image data
 * @param useZoeDepth - Whether to use ZoeDepth (true) or Depth Anything (false)
 * @returns Depth estimation result with metric depth values
 */
export async function getDepthMap(
  imageBase64: string, 
  useZoeDepth: boolean = true
): Promise<{
  success: boolean;
  depth: {
    depthImageUrl: string;
    depthDataUrl?: string;
    width: number;
    height: number;
    minDepth: number;
    maxDepth: number;
    isMetricDepth: boolean;
    unit: string;
    modelType: string;
    metricAccuracyEstimate: number;
    indoorOptimized: boolean;
  } | null;
  processingTime: number;
  modelUsed?: string;
  message?: string;
} | null> {
  try {
    // Create AbortController with 90 second timeout for ZoeDepth processing
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 seconds
    
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/depth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ 
        image: imageBase64,
        model: useZoeDepth ? 'zoedepth' : 'depth_anything'
      }),
      signal: controller.signal
      // Note: keepalive removed - has 64KB body size limit which breaks large image uploads
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error('Depth estimation failed');
    }

    const result = await response.json();
    console.log(`[RoomScanner] ZoeDepth result:`, {
      success: result.success,
      modelUsed: result.modelUsed,
      isMetric: result.depth?.isMetricDepth,
      depthRange: result.depth ? `${result.depth.minDepth}m - ${result.depth.maxDepth}m` : 'N/A'
    });
    
    return result;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('Depth estimation timed out after 90 seconds');
    } else {
      console.error('Depth estimation error:', error);
    }
    return null;
  }
}

/**
 * Calculate room dimensions from multiple metric depth maps
 * Uses ZoeDepth metric depth data to estimate actual room size in feet/meters
 */
export async function calculateRoomDimensions(
  depthMaps: Array<{
    depthData?: string;
    minDepth: number;
    maxDepth: number;
    isMetricDepth?: boolean;
    orientation?: DeviceOrientation;
  }>,
  cameraFov: number = 70, // Typical smartphone horizontal FOV
  imageWidth: number = 1920,
  imageHeight: number = 1080
): Promise<{
  success: boolean;
  dimensions?: {
    widthFeet: number;
    lengthFeet: number;
    heightFeet: number;
    widthMeters: number;
    lengthMeters: number;
    heightMeters: number;
    floorAreaSqFt: number;
    floorAreaSqM: number;
    wallAreaSqFt: number;
    wallAreaSqM: number;
    confidence: number;
    methodology: string;
    estimatedAccuracy: string;
  };
  error?: string;
}> {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('[RoomScanner] 📐 calculateRoomDimensions called');
    console.log('[RoomScanner] Input depth maps:', depthMaps.length);
    console.log('='.repeat(80));
    
    // Filter to only metric depth maps
    const metricDepthMaps = depthMaps.filter(d => d.isMetricDepth !== false);
    
    console.log(`[RoomScanner] Filtered to ${metricDepthMaps.length} metric depth maps`);
    
    if (metricDepthMaps.length === 0) {
      console.error('[RoomScanner] ❌ No metric depth maps available!');
      return {
        success: false,
        error: 'No metric depth maps available. Use ZoeDepth for accurate room measurement.'
      };
    }
    
    console.log(`[RoomScanner] 🌐 Sending POST to ${BACKEND_URL}/api/room-scanner/calculate-dimensions`);
    console.log('[RoomScanner] Request payload:', {
      depthMapCount: metricDepthMaps.length,
      cameraFov,
      imageWidth,
      imageHeight
    });
    
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/calculate-dimensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        depthMaps: metricDepthMaps,
        cameraFov,
        imageWidth,
        imageHeight
      })
    });

    console.log('[RoomScanner] Response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[RoomScanner] ❌ Backend returned error:', errorText);
      throw new Error('Dimension calculation failed');
    }

    const result = await response.json();
    console.log('[RoomScanner] ✅ Backend response:', JSON.stringify(result, null, 2));
    console.log('='.repeat(80) + '\n');
    return result;
  } catch (error) {
    console.error('[RoomScanner] ❌ Room dimension calculation error:', error);
    console.error('[RoomScanner] Error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to calculate dimensions'
    };
  }
}

/**
 * Get renovation cost inputs from room dimensions
 * Converts room measurements to inputs for cost estimation
 */
export function getRenovationCostInputs(dimensions: {
  floorAreaSqFt: number;
  wallAreaSqFt: number;
  heightFeet: number;
}): {
  flooringSqFt: number;
  paintWallSqFt: number;
  ceilingSqFt: number;
  trimLinearFeet: number;
  tileSqFt: number;
} {
  const { floorAreaSqFt, wallAreaSqFt, heightFeet } = dimensions;
  
  // Ceiling area equals floor area
  const ceilingSqFt = floorAreaSqFt;
  
  // Estimate trim (baseboards) - perimeter of room
  // Perimeter ≈ 4 * sqrt(floorArea) for square rooms, adjust for rectangular
  const estimatedPerimeter = 4 * Math.sqrt(floorAreaSqFt);
  const trimLinearFeet = Math.round(estimatedPerimeter);
  
  // Tile estimate (bathroom/kitchen typically tile floor + part of walls)
  // Assume wainscot height of 4 feet for wet areas
  const wainscotHeight = 4;
  const wainscotWallArea = (wallAreaSqFt / heightFeet) * wainscotHeight;
  const tileSqFt = Math.round(floorAreaSqFt + wainscotWallArea);
  
  return {
    flooringSqFt: Math.round(floorAreaSqFt),
    paintWallSqFt: Math.round(wallAreaSqFt),
    ceilingSqFt: Math.round(ceilingSqFt),
    trimLinearFeet,
    tileSqFt
  };
}

/**
 * Calculate renovation costs using actual room dimensions from ZoeDepth
 * Provides more accurate cost estimates than generic estimates
 */
export function calculateRenovationCostsWithDimensions(
  dimensions: {
    floorAreaSqFt: number;
    wallAreaSqFt: number;
    heightFeet: number;
  },
  renovationTypes: Array<'flooring' | 'paint' | 'tile' | 'cabinets' | 'countertops'>,
  _qualityLevel: 'budget' | 'mid-range' | 'high-end' = 'mid-range'
): {
  estimates: Array<{
    type: string;
    sqFt: number;
    unit?: string;
    costPerSqFt: { low: number; mid: number; high: number };
    totalCost: { low: number; mid: number; high: number };
  }>;
  totalCost: { low: number; mid: number; high: number };
  confidence: string;
  basedOn: string;
} {
  const inputs = getRenovationCostInputs(dimensions);
  
  // Cost per square foot by renovation type and quality level
  // These are 2024 national averages - regional adjustments applied separately
  const costPerSqFt: Record<string, { budget: number; 'mid-range': number; 'high-end': number }> = {
    flooring: { budget: 3, 'mid-range': 8, 'high-end': 15 },
    paint: { budget: 1.5, 'mid-range': 3, 'high-end': 5 },
    tile: { budget: 8, 'mid-range': 15, 'high-end': 30 },
    cabinets: { budget: 75, 'mid-range': 150, 'high-end': 300 }, // per linear foot
    countertops: { budget: 25, 'mid-range': 60, 'high-end': 150 } // per linear foot
  };
  
  const estimates = renovationTypes.map(type => {
    let sqFt: number;
    let unit = 'sqFt';
    
    switch (type) {
      case 'flooring':
        sqFt = inputs.flooringSqFt;
        break;
      case 'paint':
        sqFt = inputs.paintWallSqFt + inputs.ceilingSqFt;
        break;
      case 'tile':
        sqFt = inputs.tileSqFt;
        break;
      case 'cabinets':
        // Estimate linear feet from perimeter (typically one wall of cabinets)
        sqFt = Math.round(inputs.trimLinearFeet / 4);
        unit = 'linear feet';
        break;
      case 'countertops':
        // Similar to cabinets
        sqFt = Math.round(inputs.trimLinearFeet / 4);
        unit = 'linear feet';
        break;
      default:
        sqFt = inputs.flooringSqFt;
    }
    
    const costs = costPerSqFt[type] || costPerSqFt.flooring;
    
    return {
      type,
      sqFt,
      unit,
      costPerSqFt: {
        low: costs.budget,
        mid: costs['mid-range'],
        high: costs['high-end']
      },
      totalCost: {
        low: Math.round(sqFt * costs.budget),
        mid: Math.round(sqFt * costs['mid-range']),
        high: Math.round(sqFt * costs['high-end'])
      }
    };
  });
  
  const totalCost = {
    low: estimates.reduce((sum, e) => sum + e.totalCost.low, 0),
    mid: estimates.reduce((sum, e) => sum + e.totalCost.mid, 0),
    high: estimates.reduce((sum, e) => sum + e.totalCost.high, 0)
  };
  
  return {
    estimates,
    totalCost,
    confidence: 'high', // Based on actual measurements
    basedOn: 'ZoeDepth metric room scan measurements'
  };
}

/**
 * Upload frames to create 3D model
 * Falls back to local frame export if API fails
 */
export async function create3DModel(
  frames: CapturedFrame[],
  title: string
): Promise<Model3DResult | null> {
  try {
    console.log(`[RoomScanner] Creating 3D model with ${frames.length} frames`);
    
    // Try Luma API first
    try {
      const createResponse = await fetch(`${BACKEND_URL}/api/room-scanner/luma/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ title })
      });

      if (createResponse.ok) {
        const createData = await createResponse.json();
        
        if (createData.success && createData.captureId) {
          console.log('[RoomScanner] Luma capture created:', createData);
          
          const { captureId } = createData;

          // Upload frames
          const uploadResponse = await fetch(`${BACKEND_URL}/api/room-scanner/luma/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
              captureId,
              frames: frames.map(f => ({
                id: f.id,
                imageData: f.imageData,
                timestamp: f.timestamp
              }))
            })
          });

          if (uploadResponse.ok) {
            // Trigger processing
            const processResponse = await fetch(`${BACKEND_URL}/api/room-scanner/luma/process`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
              body: JSON.stringify({ captureId })
            });

            if (processResponse.ok) {
              const { jobId } = await processResponse.json();
              return await pollForCompletion(captureId, jobId);
            }
          }
        }
      }
    } catch (lumaError) {
      console.log('[RoomScanner] Luma API unavailable, using local export fallback');
    }

    // Fallback: Create local frame gallery/export
    console.log('[RoomScanner] Using local frame export fallback');
    return createLocalFrameExport(frames, title);
    
  } catch (error) {
    console.error('3D model creation error:', error);
    // Still try to return something useful
    return createLocalFrameExport(frames, title);
  }
}

/**
 * Create a local frame export when cloud API is unavailable
 * This creates a viewable gallery and downloadable package
 */
async function createLocalFrameExport(
  frames: CapturedFrame[],
  title: string
): Promise<Model3DResult> {
  console.log(`[RoomScanner] Creating local export with ${frames.length} frames`);
  
  // Create a preview image from the middle frame
  const middleFrame = frames[Math.floor(frames.length / 2)];
  const thumbnailUrl = `data:image/jpeg;base64,${middleFrame.imageData}`;
  
  // Create metadata for desktop processing
  const metadata = {
    title,
    captureDate: new Date().toISOString(),
    frameCount: frames.length,
    frames: frames.map((f, i) => ({
      index: i,
      timestamp: f.timestamp,
      orientation: f.orientation,
      quality: f.quality || 0.8
    }))
  };
  
  // Store frames in session storage for viewing
  const frameDataUrl = createFrameDataUrl(frames, metadata);
  
  return {
    modelUrl: frameDataUrl, // This will be a data URL for the frame viewer
    thumbnailUrl,
    format: 'glb', // Using glb as default format for Model3DResult type
    fileSize: frames.reduce((acc, f) => acc + (f.imageData.length * 0.75), 0), // Approximate size
    dimensions: { width: 0, height: 0, depth: 0 },
    vertexCount: frames.length,
    textured: true,
    processingTime: 0
  };
}

/**
 * Create a data URL containing frame data for viewing/download
 */
function createFrameDataUrl(frames: CapturedFrame[], metadata: any): string {
  // Store in sessionStorage for the viewer to access
  const frameData = {
    metadata,
    frames: frames.map((f, i) => ({
      id: f.id,
      index: i,
      imageData: f.imageData,
      timestamp: f.timestamp,
      orientation: f.orientation
    }))
  };
  
  // Store for later retrieval by the viewer component
  try {
    sessionStorage.setItem('roomScanFrames', JSON.stringify(frameData));
  } catch (e) {
    console.warn('[RoomScanner] Could not store frames in session storage - too large');
    // Store just the count and first frame as preview
    sessionStorage.setItem('roomScanFrames', JSON.stringify({
      metadata,
      frames: [frameData.frames[0]],
      totalFrames: frames.length
    }));
  }
  
  // Return a special URL that the viewer will recognize
  return `local://room-scan-frames?count=${frames.length}&title=${encodeURIComponent(metadata.title)}`;
}

/**
 * Poll Luma API for processing completion
 */
async function pollForCompletion(
  captureId: string,
  _jobId: string,
  maxAttempts = 60,
  intervalMs = 5000
): Promise<Model3DResult | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/room-scanner/luma/status/${captureId}`,
        { headers: getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error('Status check failed');
      }

      const status = await response.json();

      if (status.status === 'ready') {
        return {
          modelUrl: status.artifacts?.splat || status.artifacts?.ply || '',
          thumbnailUrl: status.thumbnail || '',
          format: 'glb',
          fileSize: 0,
          dimensions: { width: 0, height: 0, depth: 0 },
          vertexCount: 0,
          textured: true,
          processingTime: i * intervalMs / 1000
        };
      }

      if (status.status === 'failed') {
        throw new Error('Processing failed');
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } catch (error) {
      console.error('Polling error:', error);
    }
  }

  return null;
}

/**
 * Text-to-speech for voice guidance
 */
export function speakGuidance(message: string, rate = 1.1): void {
  if ('speechSynthesis' in window) {
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = rate;
    utterance.pitch = 1;
    utterance.volume = 1;

    window.speechSynthesis.speak(utterance);
  }
}

/**
 * Stop voice guidance
 */
export function stopSpeaking(): void {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Request device orientation permission (iOS 13+)
 */
export async function requestOrientationPermission(): Promise<boolean> {
  if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
    try {
      const permission = await (DeviceOrientationEvent as any).requestPermission();
      return permission === 'granted';
    } catch (error) {
      console.error('Orientation permission error:', error);
      return false;
    }
  }
  return true; // Permission not required on this device
}

/**
 * Request camera permission with iPhone-optimized settings
 */
export async function requestCameraPermission(): Promise<MediaStream | null> {
  // Check if we're on HTTPS (required for camera on mobile)
  if (window.location.protocol !== 'https:' && !window.location.hostname.includes('localhost') && !window.location.hostname.includes('127.0.0.1')) {
    console.error('Camera requires HTTPS. Please use ngrok tunnel for mobile testing.');
    throw new Error('Camera access requires HTTPS. Please access via the ngrok URL.');
  }

  // Check if getUserMedia is available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('[RoomScanner] getUserMedia not supported');
    throw new Error('Camera API not available. Please use Safari or Chrome.');
  }

  console.log('[RoomScanner] Requesting camera permission...', { isIOS, isMobile });

  // Try with ideal constraints first, fall back to simpler constraints if that fails
  const constraintsList: MediaStreamConstraints[] = [
    // First attempt: iPhone/iOS optimized camera constraints
    {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: isIOS ? 1280 : 1920 },
        height: { ideal: isIOS ? 720 : 1080 },
        frameRate: { ideal: isIOS ? 24 : 30 }
      },
      audio: false
    },
    // Second attempt: Simpler constraints for Safari compatibility
    {
      video: {
        facingMode: 'environment'
      },
      audio: false
    },
    // Third attempt: Most basic - just request any video
    {
      video: true,
      audio: false
    }
  ];

  let lastError: any = null;

  for (let i = 0; i < constraintsList.length; i++) {
    const constraints = constraintsList[i];
    try {
      console.log(`[RoomScanner] Attempt ${i + 1}/${constraintsList.length} with constraints:`, JSON.stringify(constraints));
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Log camera info for debugging
      const track = stream.getVideoTracks()[0];
      console.log('[RoomScanner] Camera active:', track.label);
      console.log('[RoomScanner] Camera settings:', track.getSettings());
      
      return stream;
    } catch (error: any) {
      console.warn(`[RoomScanner] Attempt ${i + 1} failed:`, error.name, error.message);
      lastError = error;
      
      // Don't try simpler constraints if permission was explicitly denied
      if (error.name === 'NotAllowedError') {
        break;
      }
    }
  }

  // All attempts failed, throw appropriate error
  console.error('[RoomScanner] All camera attempts failed:', lastError);
  
  if (lastError?.name === 'NotAllowedError') {
    throw new Error('Camera permission denied. Please go to Settings > Safari > Camera and allow access, then refresh the page.');
  } else if (lastError?.name === 'NotFoundError') {
    throw new Error('No camera found. Please ensure your device has a camera.');
  } else if (lastError?.name === 'NotReadableError') {
    throw new Error('Camera is in use by another application. Please close other apps using the camera.');
  } else if (lastError?.name === 'OverconstrainedError') {
    throw new Error('Camera does not support requested settings. Please try again.');
  } else if (lastError?.name === 'SecurityError') {
    throw new Error('Camera access blocked. Make sure you\'re using HTTPS.');
  }
  
  throw new Error(lastError?.message || 'Could not access camera. Please check permissions and try again.');
}

/**
 * Capture frame from video stream
 */
export function captureFrameFromVideo(video: HTMLVideoElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get canvas context');
  }

  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]; // Return base64 without prefix
}

/**
 * Export scan session data
 */
export function exportScanSession(session: ScanSession): string {
  return JSON.stringify({
    ...session,
    frames: session.frames.map(f => ({
      ...f,
      imageData: '[base64 data omitted]'
    }))
  }, null, 2);
}

/**
 * Helper to add delay for rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get depth map with retry logic for rate limiting
 */
async function getDepthMapWithRetry(
  imageBase64: string, 
  useZoeDepth: boolean = true,
  maxRetries: number = 3,
  baseDelayMs: number = 10000 // Start with 10 second delay for 429s
): Promise<any> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await getDepthMap(imageBase64, useZoeDepth);
      if (result) return result;
    } catch (error: any) {
      // Check if it's a rate limit error
      const isRateLimited = error?.message?.includes('429') || 
                           error?.status === 429 ||
                           error?.detail?.includes('throttled');
      
      if (isRateLimited && attempt < maxRetries - 1) {
        // Exponential backoff: 10s, 20s, 40s
        const waitTime = baseDelayMs * Math.pow(2, attempt);
        console.log(`[RoomScanner] Rate limited, waiting ${waitTime/1000}s before retry ${attempt + 1}/${maxRetries}`);
        await delay(waitTime);
        continue;
      }
      throw error;
    }
  }
  return null;
}

/**
 * Prepare frames for immersive viewer with ZoeDepth metric depth processing
 * ZoeDepth provides metric depth for accurate room dimension measurement
 * With $10+ credit, Replicate allows higher rate limits (~30 req/min)
 */
export async function prepareFramesForViewer(
  frames: CapturedFrame[],
  maxDepthFrames: number = 48, // Process depth for up to 48 frames
  onProgress?: (progress: number, message: string) => void,
  useZoeDepth: boolean = true // Use ZoeDepth for metric depth by default
): Promise<{ 
  frames: CapturedFrame[]; 
  roomDimensions?: RoomDimensions;
  metricDepthCount: number;
}> {
  // VERSION CHECK - Log to server to confirm new code is running
  await debugLog('prepareFramesForViewer STARTED - VERSION 2025-12-02 12:10', { frameCount: frames.length, useZoeDepth });
  
  console.log(`[RoomScanner] Preparing ${frames.length} frames for immersive viewer using ${useZoeDepth ? 'ZoeDepth (metric)' : 'Depth Anything'}`);
  
  // Select which frames get depth processing (evenly distributed)
  const depthFrameIndices = new Set<number>();
  if (maxDepthFrames > 0 && maxDepthFrames < frames.length) {
    const step = Math.floor(frames.length / maxDepthFrames);
    for (let i = 0; i < frames.length && depthFrameIndices.size < maxDepthFrames; i += step) {
      depthFrameIndices.add(i);
    }
  } else if (maxDepthFrames >= frames.length) {
    // Process all frames
    for (let i = 0; i < frames.length; i++) {
      depthFrameIndices.add(i);
    }
  }
  
  console.log(`[RoomScanner] Will process depth for ${depthFrameIndices.size} of ${frames.length} frames`);
  
  const processedFrames: CapturedFrame[] = [];
  const metricDepthMaps: Array<{
    minDepth: number;
    maxDepth: number;
    isMetricDepth: boolean;
    orientation?: DeviceOrientation;
  }> = [];
  let depthSuccessCount = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;
  
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const shouldProcessDepth = depthFrameIndices.has(i);
    
    onProgress?.(
      Math.round((i / frames.length) * 100), 
      shouldProcessDepth 
        ? `Processing ZoeDepth ${i + 1}/${frames.length} (${depthSuccessCount} complete)`
        : `Loading frame ${i + 1}/${frames.length}`
    );
    
    if (shouldProcessDepth && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      try {
        // Rate limit: wait 1 second between depth requests (faster, but prevents rate limit)
        // Reduced from 2s to speed up processing and reduce timeout risk
        if (depthSuccessCount > 0) {
          await delay(1000);
        }
        
        // Send periodic progress update to keep connection alive
        if (i % 5 === 0) {
          console.log(`[RoomScanner] Progress: ${i}/${frames.length} frames, ${depthSuccessCount} depth maps complete`);
        }
        
        // Get metric depth map using ZoeDepth
        const depthResult = await getDepthMapWithRetry(frame.imageData, useZoeDepth);
        
        await debugLog(`Depth result for frame ${i}`, {
          hasDepth: !!depthResult?.depth,
          success: depthResult?.success,
          isMetricDepth: depthResult?.depth?.isMetricDepth
        });
        
        // Check if we got a valid depth result (even if image fetch might fail)
        if (depthResult?.success && depthResult?.depth) {
          const isMetric = depthResult.depth.isMetricDepth ?? useZoeDepth;
          
          await debugLog(`Frame ${i} - isMetric: ${isMetric}, adding to metricDepthMaps`);
          
          // ALWAYS collect metric depth data for room dimension calculation
          // This is independent of whether we can fetch the depth image
          if (isMetric) {
            metricDepthMaps.push({
              minDepth: depthResult.depth.minDepth || 0.1,
              maxDepth: depthResult.depth.maxDepth || 10,
              isMetricDepth: true,
              orientation: frame.orientation
            });
            console.log(`[RoomScanner] ✅ Added metric depth data. metricDepthMaps now has ${metricDepthMaps.length} entries`);
          }
          
          // Try to fetch the depth image for visualization (optional)
          let depthImageBase64 = '';
          if (depthResult.depth.depthImageUrl) {
            try {
              depthImageBase64 = await fetchImageAsBase64(depthResult.depth.depthImageUrl);
              console.log(`[RoomScanner] ✅ Fetched depth image for frame ${i}`);
            } catch (fetchError) {
              console.warn(`[RoomScanner] ⚠️ Could not fetch depth image for frame ${i}:`, fetchError);
              // Continue anyway - we have the metric data
            }
          }
          
          processedFrames.push({
            ...frame,
            depthMap: {
              depthData: depthImageBase64,
              depthDataUrl: depthResult.depth.depthDataUrl,
              width: depthResult.depth.width || 0,
              height: depthResult.depth.height || 0,
              minDepth: depthResult.depth.minDepth || 0.1,
              maxDepth: depthResult.depth.maxDepth || 10,
              focalLengthPx: 0,
              // Metric depth metadata
              isMetricDepth: isMetric,
              unit: 'meters',
              modelType: depthResult.modelUsed || (useZoeDepth ? 'zoedepth_nk' : 'depth_anything_v2'),
              metricAccuracyEstimate: depthResult.depth.metricAccuracyEstimate || (isMetric ? 0.85 : 0.6),
              indoorOptimized: depthResult.depth.indoorOptimized ?? useZoeDepth
            }
          });
          
          depthSuccessCount++;
          consecutiveFailures = 0; // Reset on success
          continue;
        } else {
          console.log(`[RoomScanner] Frame ${i}: No valid depth result, skipping`);
          consecutiveFailures++;
        }
      } catch (error) {
        console.error(`[RoomScanner] ZoeDepth processing failed for frame ${i}:`, error);
        consecutiveFailures++;
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(`[RoomScanner] Too many consecutive failures, skipping remaining depth processing`);
        }
      }
    }
    
    // Include frame without depth
    processedFrames.push(frame);
  }
  
  onProgress?.(95, 'Calculating room dimensions...');
  
  await debugLog(`Metric depth maps collected: ${metricDepthMaps.length}`);
  
  // Calculate room dimensions from metric depth maps
  let roomDimensions: RoomDimensions | undefined;
  
  if (metricDepthMaps.length >= 3) {
    try {
      await debugLog(`Calling calculateRoomDimensions with ${metricDepthMaps.length} maps`);
      const dimensionResult = await calculateRoomDimensions(metricDepthMaps);
      await debugLog('Dimension calculation result', dimensionResult);
      if (dimensionResult.success && dimensionResult.dimensions) {
        roomDimensions = dimensionResult.dimensions as RoomDimensions;
        await debugLog('Room dimensions calculated', roomDimensions);
      } else {
        await debugLog('Dimension calculation returned no dimensions', dimensionResult);
      }
    } catch (error) {
      await debugLog('Failed to calculate room dimensions', { error: String(error) });
    }
  } else {
    await debugLog(`Not enough metric depth maps (${metricDepthMaps.length}) for dimension calculation, need at least 3`);
  }
  
  onProgress?.(100, 'Processing complete');
  await debugLog(`Processing complete: ${processedFrames.length} frames, ${depthSuccessCount} with ZoeDepth, roomDimensions: ${!!roomDimensions}`);
  
  return {
    frames: processedFrames,
    roomDimensions,
    metricDepthCount: metricDepthMaps.length
  };
}

/**
 * Select evenly distributed key frames from a larger set
 * @deprecated - Now we use all frames in prepareFramesForViewer
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function selectKeyFrames(frames: CapturedFrame[], maxFrames: number): CapturedFrame[] {
  if (frames.length <= maxFrames) {
    return frames;
  }
  
  const keyFrames: CapturedFrame[] = [];
  const step = frames.length / maxFrames;
  
  for (let i = 0; i < maxFrames; i++) {
    const index = Math.min(Math.floor(i * step), frames.length - 1);
    keyFrames.push(frames[index]);
  }
  
  return keyFrames;
}

/**
 * Fetch an image URL and convert to base64
 */
async function fetchImageAsBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        // Remove the data URL prefix if present
        const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('[RoomScanner] Failed to fetch image:', error);
    return '';
  }
}

/**
 * Get frames suitable for immersive viewing from session storage
 */
export function getStoredFramesForViewer(): CapturedFrame[] | null {
  try {
    const stored = sessionStorage.getItem('roomScanFrames');
    if (!stored) return null;
    
    const data = JSON.parse(stored);
    return data.frames || null;
  } catch {
    return null;
  }
}

// ==================== SAVED SCANS API ====================

export interface SavedScanSummary {
  id: string;
  roomName: string;
  propertyId: string | null;
  createdAt: string;
  frameCount: number;
  hasThumbnail: boolean;
  type?: string;
  metadata?: Record<string, unknown>;
}

export interface SavedScanFull {
  id: string;
  roomName: string;
  propertyId: string | null;
  userId: string | null;
  createdAt: string;
  frameCount: number;
  frames: CapturedFrame[];
  thumbnailData: string | null;
  metadata: Record<string, unknown>;
  // Spherical panorama specific fields (for auto-saved stitched panoramas)
  type?: string;
  scanType?: string;
  equirectangular?: string;
  // Depth panorama for accurate click-to-measure
  depthPanorama?: string;
  depthMetadata?: {
    minDepth: number;
    maxDepth: number;
    width: number;
    height: number;
    timestamp?: string;
  };
  roomDimensions?: {
    widthFeet?: number;
    lengthFeet?: number;
    heightFeet?: number;
    floorAreaSqM?: number;
    floorAreaSqFt?: number;
    confidence?: number;
  };
}

/**
 * Save a completed room scan to the backend
 */
export async function saveRoomScan(
  roomName: string,
  frames: CapturedFrame[],
  options?: {
    propertyId?: string;
    userId?: string;
    thumbnailImage?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<{ success: boolean; scanId?: string; error?: string }> {
  try {
    console.log(`[RoomScanner] Saving scan "${roomName}" with ${frames.length} frames`);
    
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/scans/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        roomName,
        frames: frames.map(f => ({
          id: f.id,
          imageData: f.imageData,
          timestamp: f.timestamp,
          orientation: f.orientation,
          quality: f.quality,
          depthMap: f.depthMap
        })),
        propertyId: options?.propertyId,
        userId: options?.userId,
        thumbnailImage: options?.thumbnailImage || frames[0]?.imageData,
        metadata: options?.metadata
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`[RoomScanner] Scan saved successfully with ID: ${data.scanId}`);
      return { success: true, scanId: data.scanId };
    } else {
      console.error('[RoomScanner] Save failed:', data.error);
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('[RoomScanner] Save error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to save scan'
    };
  }
}

/**
 * Save a spherical panorama scan (matches backend auto-save format)
 * Now includes depth panorama for accurate click-to-measure functionality
 */
export async function saveSphericalPanorama(
  roomName: string,
  equirectangular: string,
  options?: {
    propertyId?: string;
    userId?: string;
    roomDimensions?: any;
    depthPanorama?: {
      data: string;  // Base64 depth map image
      width: number;
      height: number;
      minDepth: number;
      maxDepth: number;
      coverage?: number;
    };
    metadata?: Record<string, unknown>;
  }
): Promise<{ success: boolean; scanId?: string; error?: string }> {
  try {
    console.log(`🔥 [RoomScanner v3.0] Saving spherical panorama "${roomName}"`);
    console.log(`🔥 [RoomScanner v3.0] Has depth panorama: ${!!options?.depthPanorama}`);
    
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/scans/save-spherical`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        roomName,
        equirectangular,
        type: 'spherical_panorama',
        scanType: 'spherical_panorama',
        propertyId: options?.propertyId,
        userId: options?.userId,
        roomDimensions: options?.roomDimensions,
        depthPanorama: options?.depthPanorama,  // Include depth for click-to-measure
        metadata: {
          ...options?.metadata,
          scanType: 'spherical_panorama',
          hasDepthPanorama: !!options?.depthPanorama
        }
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`🔥 [RoomScanner v3.0] Spherical panorama saved: ${data.scanId}`);
      return { success: true, scanId: data.scanId };
    } else {
      console.error('[RoomScanner] Save failed:', data.error);
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('[RoomScanner] Save error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to save spherical panorama'
    };
  }
}

/**
 * List all saved room scans, optionally filtered
 * Includes both room scanner scans and photogrammetry scans
 */
export async function listSavedScans(
  filters?: { propertyId?: string; userId?: string }
): Promise<{ success: boolean; scans?: SavedScanSummary[]; error?: string }> {
  try {
    const params = new URLSearchParams();
    if (filters?.propertyId) params.set('propertyId', filters.propertyId);
    if (filters?.userId) params.set('userId', filters.userId);
    
    // Fetch room scanner scans
    const roomScanUrl = `${BACKEND_URL}/api/room-scanner/scans${params.toString() ? `?${params}` : ''}`;
    const roomScanResponse = await fetch(roomScanUrl, { headers: getAuthHeaders() });
    if (!roomScanResponse.ok) {
      throw new Error(`Room scanner scan list failed (${roomScanResponse.status})`);
    }

    const roomScanText = await roomScanResponse.text();
    const roomScanData = safeParseJsonResponse(roomScanText) || { success: false, scans: [] };
    
    let allScans: SavedScanSummary[] = [];
    
    if (roomScanData.success && roomScanData.scans) {
      allScans = roomScanData.scans;
    }

    const mirroredScanIds = new Set(
      allScans.map((scan) => scan.id)
    );
    
    // Also fetch photogrammetry scans
    try {
      const photoUrl = `${BACKEND_URL}/api/photogrammetry/scans${params.toString() ? `?${params}` : ''}`;
      const photoResponse = await fetch(photoUrl);
      
      if (photoResponse.ok) {
        const photoText = await photoResponse.text();
        const photoData = safeParseJsonResponse(photoText) || { success: false, scans: [] };
        if (photoData.success && photoData.scans) {
          // Add scanType metadata to distinguish photogrammetry scans
          const photoScans = photoData.scans
            .map((scan: any) => ({
              ...scan,
              type: 'photogrammetry',
              frameCount: scan.totalPhotos || scan.frameCount || 0,
              metadata: {
                ...scan.metadata,
                scanType: 'photogrammetry'
              }
            }))
            .filter((scan: any) => {
              const mirroredId = scan.metadata?.roomScanId || `photogrammetry_${scan.id}`;
              return !mirroredScanIds.has(mirroredId);
            });
          allScans = [...allScans, ...photoScans];
        }
      } else {
        console.warn(`[RoomScanner] Photogrammetry scan list unavailable (${photoResponse.status})`);
      }
    } catch (photoError) {
      console.warn('[RoomScanner] Could not fetch photogrammetry scans:', photoError);
      // Continue with just room scanner scans
    }
    
    // Sort by creation date (newest first)
    allScans.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    allScans = allScans.map(normalizeSavedScanSummary);
    
    return { success: true, scans: allScans };
  } catch (error) {
    console.error('[RoomScanner] List scans error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to list scans'
    };
  }
}

/**
 * Load a saved room scan with all frame data
 */
export async function loadSavedScan(
  scanId: string
): Promise<{ success: boolean; scan?: SavedScanFull; error?: string }> {
  try {
    console.log(`🔥 [RoomScanner v3.0] Loading scan ${scanId}`);
    
    const response = await fetch(`${BACKEND_URL}/api/room-scanner/scans/${scanId}`, { headers: getAuthHeaders() });
    const data = await response.json();
    
    if (data.success) {
      const normalizedScan = normalizeSavedScanFull(data.scan);
      console.log(`🔥 [RoomScanner v3.0] Loaded scan:`, {
        frames: normalizedScan.frames?.length || 0,
        type: normalizedScan.type,
        hasEquirectangular: !!normalizedScan.equirectangular
      });
      return { success: true, scan: normalizedScan };
    } else {
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('[RoomScanner] Load scan error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to load scan'
    };
  }
}

/**
 * Get thumbnail URL for a saved scan
 * Uses relative URL so it goes through Vite proxy to avoid CORS issues
 */
export function getScanThumbnailUrl(scanId: string): string {
  return `/api/room-scanner/scans/${scanId}/thumbnail`;
}

/**
 * Delete a saved room scan
 * Tries room-scanner endpoint first, then falls back to photogrammetry endpoint
 */
export async function deleteSavedScan(
  scanId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Try room-scanner endpoint first
    const roomScannerResponse = await fetch(`${BACKEND_URL}/api/room-scanner/scans/${scanId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    
    if (roomScannerResponse.ok) {
      const data = await roomScannerResponse.json();
      if (data.success) {
        console.log(`[RoomScanner] Deleted scan ${scanId} from room-scanner`);
        return { success: true };
      }
    }
    
    // If room-scanner returns 404, try photogrammetry endpoint
    if (roomScannerResponse.status === 404) {
      console.log(`[RoomScanner] Scan not found in room-scanner, trying photogrammetry...`);
      const photogrammetryResponse = await fetch(`${BACKEND_URL}/api/photogrammetry/scans/${scanId}`, {
        method: 'DELETE'
      });
      
      if (photogrammetryResponse.ok) {
        const data = await photogrammetryResponse.json();
        if (data.success) {
          console.log(`[RoomScanner] Deleted scan ${scanId} from photogrammetry`);
          return { success: true };
        }
      }
      
      // Both failed
      return { success: false, error: 'Scan not found in either room-scanner or photogrammetry storage' };
    }
    
    // Room-scanner returned error other than 404
    const errorData = await roomScannerResponse.json().catch(() => ({}));
    return { success: false, error: errorData.error || 'Failed to delete scan' };
  } catch (error) {
    console.error('[RoomScanner] Delete scan error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to delete scan'
    };
  }
}
