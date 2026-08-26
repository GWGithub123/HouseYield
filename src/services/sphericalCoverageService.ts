/**
 * Spherical Coverage Service
 * 
 * Tracks which areas of the spherical view have been captured.
 * Uses a discretized sphere grid (like an icosahedron or lat/lon grid)
 * to track coverage and guide the user to uncaptured areas.
 */

export interface SphericalCell {
  id: number;
  azimuth: number;        // Center azimuth (0-360°)
  elevation: number;      // Center elevation (-90° to +90°)
  covered: boolean;       // Has this cell been captured?
  photoIndex?: number;    // Which photo covers this cell
  captureTime?: number;   // When was it captured
  quality?: number;       // 0-1, blur/exposure quality
}

export interface CoverageState {
  cells: SphericalCell[];
  totalCells: number;
  coveredCells: number;
  coveragePercent: number;
  gaps: SphericalCell[];        // Uncovered cells
  largestGap?: {
    azimuth: number;
    elevation: number;
    size: number;               // Number of contiguous uncovered cells
  };
}

export interface CaptureCandidate {
  shouldCapture: boolean;
  reason?: string;
  cellId?: number;
  isNewArea: boolean;
  overlapPercent: number;       // How much this view overlaps existing coverage
}

// Configuration for the spherical grid
// IMPROVED: Increased overlap and density based on Google Street View approach
const GRID_CONFIG = {
  // Number of elevation bands (from pole to pole)
  // Increased density for better coverage
  elevationBands: 11,        // More bands for smoother transitions
  
  // Photos per band varies by elevation (fewer at poles)
  // INCREASED: More photos per band for better overlap like Google's multi-camera rig
  photosPerBand: [1, 6, 8, 10, 14, 16, 14, 10, 8, 6, 1],  // Total = 94 cells (up from 50)
  
  // Camera field of view (typical smartphone)
  horizontalFOV: 75,        // degrees
  verticalFOV: 55,          // degrees (4:3 aspect)
  
  // INCREASED: Minimum overlap between photos for good stitching
  // Google Street View uses 25-30% overlap - we now use 35% for safety
  minOverlap: 0.35,         // 35% overlap required (was 25%)
  
  // Stability requirements for auto-capture
  // REDUCED: Faster capture once stable for more responsive scanning
  stabilityThreshold: 2.5,    // degrees - max movement to consider "stable" (reduced from 3)
  stabilityDuration: 300,   // ms - how long must be stable before capture (reduced from 400)
  
  // NEW: Maximum gap before we need more photos
  maxGapDegrees: 30,        // Try to keep gaps under 30 degrees
  
  // NEW: Feature matching requirements
  minFeaturesPerPhoto: 200,  // Minimum keypoints expected for good matching
};

/**
 * Generate the spherical coverage grid
 * 
 * IMPROVED: Denser grid for better coverage with more overlap
 * Based on Google Street View's multi-camera approach
 */
export function createCoverageGrid(): SphericalCell[] {
  const cells: SphericalCell[] = [];
  let id = 0;
  
  // Elevation values from -90 to +90
  // MORE BANDS for smoother coverage (11 bands vs 9)
  const elevations = [
    -90,    // Nadir (floor)
    -72,    // Lower ring
    -54,    // Lower-mid ring
    -36,    // Below horizon lower
    -18,    // Below horizon
    0,      // Horizon
    18,     // Above horizon
    36,     // Above horizon upper
    54,     // Upper-mid ring
    72,     // Upper ring
    90      // Zenith (ceiling)
  ];
  
  for (let i = 0; i < elevations.length; i++) {
    const elevation = elevations[i];
    const photosInBand = GRID_CONFIG.photosPerBand[i];
    const azimuthStep = 360 / photosInBand;
    
    for (let j = 0; j < photosInBand; j++) {
      const azimuth = j * azimuthStep;
      
      cells.push({
        id: id++,
        azimuth,
        elevation,
        covered: false
      });
    }
  }
  
  return cells;
}

/**
 * Calculate angular distance between two spherical coordinates
 */
export function angularDistance(
  az1: number, el1: number,
  az2: number, el2: number
): number {
  // Convert to radians
  const lat1 = el1 * Math.PI / 180;
  const lat2 = el2 * Math.PI / 180;
  const dLon = (az2 - az1) * Math.PI / 180;
  
  // Haversine formula
  const a = Math.sin((lat2 - lat1) / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return c * 180 / Math.PI;  // Return in degrees
}

/**
 * Determine which cells are covered by a photo at given orientation
 */
export function getCellsCoveredByPhoto(
  cells: SphericalCell[],
  azimuth: number,
  elevation: number
): number[] {
  const coveredIds: number[] = [];
  
  // Half FOV for coverage calculation
  const hFOV = GRID_CONFIG.horizontalFOV / 2;
  const vFOV = GRID_CONFIG.verticalFOV / 2;
  
  for (const cell of cells) {
    // Calculate angular distance from photo center to cell center
    const azDiff = Math.abs(((cell.azimuth - azimuth + 180) % 360) - 180);
    const elDiff = Math.abs(cell.elevation - elevation);
    
    // Adjust horizontal FOV coverage based on elevation (narrower at poles)
    const elevationFactor = Math.cos(elevation * Math.PI / 180);
    const effectiveHFOV = hFOV / Math.max(0.3, elevationFactor);
    
    // Check if cell center is within FOV
    if (azDiff <= effectiveHFOV && elDiff <= vFOV) {
      coveredIds.push(cell.id);
    }
  }
  
  return coveredIds;
}

/**
 * Update coverage state after capturing a photo
 */
export function updateCoverage(
  cells: SphericalCell[],
  azimuth: number,
  elevation: number,
  photoIndex: number,
  quality: number = 1.0
): SphericalCell[] {
  const coveredIds = getCellsCoveredByPhoto(cells, azimuth, elevation);
  const now = Date.now();
  
  return cells.map(cell => {
    if (coveredIds.includes(cell.id)) {
      // Only update if not already covered, or if new photo is higher quality
      if (!cell.covered || (cell.quality && quality > cell.quality)) {
        return {
          ...cell,
          covered: true,
          photoIndex,
          captureTime: now,
          quality
        };
      }
    }
    return cell;
  });
}

/**
 * Get current coverage statistics
 */
export function getCoverageStats(cells: SphericalCell[]): CoverageState {
  const coveredCells = cells.filter(c => c.covered).length;
  const gaps = cells.filter(c => !c.covered);
  
  // Find largest contiguous gap
  let largestGap = undefined;
  if (gaps.length > 0) {
    // For simplicity, just return the gap closest to horizon (most visible)
    const horizonGaps = gaps.filter(g => Math.abs(g.elevation) <= 45);
    if (horizonGaps.length > 0) {
      const centerGap = horizonGaps[Math.floor(horizonGaps.length / 2)];
      largestGap = {
        azimuth: centerGap.azimuth,
        elevation: centerGap.elevation,
        size: horizonGaps.length
      };
    }
  }
  
  return {
    cells,
    totalCells: cells.length,
    coveredCells,
    coveragePercent: Math.round((coveredCells / cells.length) * 100),
    gaps,
    largestGap
  };
}

/**
 * Determine if we should capture at the current orientation
 * 
 * IMPROVED: More aggressive capture for better overlap
 * - Captures even with some overlap to ensure feature matching
 * - Prefers 35% overlap between adjacent photos
 */
export function shouldCaptureHere(
  cells: SphericalCell[],
  azimuth: number,
  elevation: number,
  isStable: boolean
): CaptureCandidate {
  if (!isStable) {
    return {
      shouldCapture: false,
      reason: 'Phone not stable',
      isNewArea: false,
      overlapPercent: 0
    };
  }
  
  const coveredIds = getCellsCoveredByPhoto(cells, azimuth, elevation);
  
  if (coveredIds.length === 0) {
    return {
      shouldCapture: false,
      reason: 'No grid cells in view',
      isNewArea: false,
      overlapPercent: 0
    };
  }
  
  // Count how many of these cells are already covered
  const alreadyCovered = coveredIds.filter(id => 
    cells.find(c => c.id === id)?.covered
  ).length;
  
  const overlapPercent = alreadyCovered / coveredIds.length;
  const newCellsCount = coveredIds.length - alreadyCovered;
  
  // IMPROVED: More nuanced capture logic for better overlap
  // - Must have at least some new area OR be within overlap target range
  // - Target 35% overlap for good feature matching
  const minNewCells = 1;
  const maxOverlap = 0.85;  // Don't capture if >85% already covered
  
  // Capture if:
  // 1. This is a completely new area (no overlap)
  // 2. This has new cells AND overlap is reasonable (not too much)
  const hasNewArea = newCellsCount >= minNewCells;
  const isNewArea = hasNewArea && (overlapPercent < maxOverlap);
  
  return {
    shouldCapture: isNewArea,
    reason: isNewArea 
      ? (overlapPercent < 0.1 ? 'New area detected' : `Good overlap (${Math.round(overlapPercent * 100)}%)`)
      : 'Already covered',
    cellId: coveredIds[0],
    isNewArea,
    overlapPercent: Math.round(overlapPercent * 100)
  };
}

/**
 * Get guidance to nearest uncovered area
 */
export function getGuidanceToGap(
  cells: SphericalCell[],
  currentAzimuth: number,
  currentElevation: number
): { 
  direction: 'left' | 'right' | 'up' | 'down' | 'none';
  targetAzimuth: number;
  targetElevation: number;
  distance: number;
  instruction: string;
} {
  const gaps = cells.filter(c => !c.covered);
  
  if (gaps.length === 0) {
    return {
      direction: 'none',
      targetAzimuth: currentAzimuth,
      targetElevation: currentElevation,
      distance: 0,
      instruction: '✅ Complete! All areas captured.'
    };
  }
  
  // Find nearest gap
  let nearestGap = gaps[0];
  let minDistance = angularDistance(
    currentAzimuth, currentElevation,
    nearestGap.azimuth, nearestGap.elevation
  );
  
  for (const gap of gaps) {
    const dist = angularDistance(
      currentAzimuth, currentElevation,
      gap.azimuth, gap.elevation
    );
    if (dist < minDistance) {
      minDistance = dist;
      nearestGap = gap;
    }
  }
  
  // Determine primary direction
  const azDiff = ((nearestGap.azimuth - currentAzimuth + 180) % 360) - 180;
  const elDiff = nearestGap.elevation - currentElevation;
  
  let direction: 'left' | 'right' | 'up' | 'down';
  let instruction: string;
  
  if (Math.abs(azDiff) > Math.abs(elDiff)) {
    // Horizontal movement needed
    direction = azDiff > 0 ? 'right' : 'left';
    instruction = azDiff > 0 ? '👉 Turn right' : '👈 Turn left';
  } else {
    // Vertical movement needed
    direction = elDiff > 0 ? 'up' : 'down';
    instruction = elDiff > 0 ? '👆 Tilt up' : '👇 Tilt down';
  }
  
  // Add distance hint
  if (minDistance > 90) {
    instruction += ' (far)';
  } else if (minDistance > 45) {
    instruction += ' (medium)';
  }
  
  return {
    direction,
    targetAzimuth: nearestGap.azimuth,
    targetElevation: nearestGap.elevation,
    distance: minDistance,
    instruction
  };
}

/**
 * Estimate quality of a captured frame (blur, exposure)
 * Returns 0-1 where 1 is best quality
 * 
 * Now uses actual image analysis via imageQualityService.
 */
export async function estimateFrameQuality(imageData: string): Promise<number> {
  try {
    // Dynamically import to avoid circular dependencies
    const { analyzeImageDataUrl } = await import('./imageQualityService');
    const metrics = await analyzeImageDataUrl(imageData);
    
    // Convert overall score (0-100) to 0-1 range
    return metrics.overallScore / 100;
  } catch (error) {
    console.warn('[Coverage] Quality analysis failed, using default:', error);
    return 0.9; // Fallback to default good quality
  }
}

/**
 * Synchronous quality estimate for real-time use
 * Uses last cached analysis if available
 */
export function estimateFrameQualitySync(_imageData: string): number {
  try {
    // Try to get cached analysis from service
    const { getImageQualityService } = require('./imageQualityService');
    const service = getImageQualityService();
    const lastAnalysis = service.getLastAnalysis();
    
    if (lastAnalysis) {
      return lastAnalysis.overallScore / 100;
    }
  } catch {
    // Service not available
  }
  
  return 0.9; // Fallback
}

/**
 * Create initial empty coverage state
 */
export function createInitialCoverageState(): CoverageState {
  const cells = createCoverageGrid();
  return getCoverageStats(cells);
}

// Export config for UI use
export const COVERAGE_CONFIG = GRID_CONFIG;
