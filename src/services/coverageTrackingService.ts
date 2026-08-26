/**
 * Coverage Tracking Service
 * 
 * Tracks what areas of the room have been photographed during capture.
 * Provides real-time feedback on coverage gaps and triangulation quality.
 * 
 * Coverage is tracked in multiple layers:
 * 1. Spherical grid - which directions have been photographed
 * 2. Floor grid - which positions the user has stood at
 * 3. Object coverage - which objects have been captured from enough angles
 */

import {
  Vector3,
  CoverageCell,
  CoverageGrid,
  FloorGrid,
  DetectedObject,
  MissingRegion,
  CoverageReport,
  CaptureRecommendation,
  PhotogrammetryPhoto,
  PositionCluster,
  createCoverageGrid,
  createFloorGrid,
  Vec3,
  normalizeAngle,
  angularDistance,
  generateId,
} from '../types/photogrammetry';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface CoverageConfig {
  // Grid settings
  sphericalCellSize: number;    // Degrees per cell (default: 10)
  floorCellSize: number;        // Meters per cell (default: 0.5)
  
  // Camera FOV for coverage calculation
  horizontalFov: number;        // Horizontal field of view in degrees
  verticalFov: number;          // Vertical field of view in degrees
  
  // Triangulation requirements
  minViewsForTriangulation: number;  // Minimum photos from different positions
  minBaselineMeters: number;         // Minimum distance between positions
  minBaselineDegrees: number;        // Minimum angle between viewing directions
  
  // Coverage thresholds
  coverageThreshold: number;         // 0-1, target overall coverage
  triangulationThreshold: number;    // 0-1, target triangulatable coverage
  maxGapDegrees: number;             // Maximum allowed gap in coverage
  
  // Object coverage
  minObjectViews: number;            // Minimum views per detected object
  objectViewAngleSpread: number;     // Minimum angle spread for object views
}

const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  sphericalCellSize: 10,
  floorCellSize: 0.5,
  horizontalFov: 75,
  verticalFov: 55,
  minViewsForTriangulation: 2,
  minBaselineMeters: 0.3,
  minBaselineDegrees: 15,
  coverageThreshold: 0.85,
  triangulationThreshold: 0.75,
  maxGapDegrees: 20,
  minObjectViews: 3,
  objectViewAngleSpread: 60,
};

// =============================================================================
// COVERAGE TRACKING SERVICE
// =============================================================================

class CoverageTrackingService {
  private config: CoverageConfig;
  private sphericalGrid: CoverageGrid;
  private floorGrid: FloorGrid;
  private detectedObjects: DetectedObject[] = [];
  private positionClusters: PositionCluster[] = [];
  
  // Photo tracking
  private photos: Map<string, PhotogrammetryPhoto> = new Map();
  private photosByCluster: Map<string, string[]> = new Map();
  
  // Callbacks
  private onCoverageUpdate: ((report: CoverageReport) => void) | null = null;
  
  constructor(config: Partial<CoverageConfig> = {}) {
    this.config = { ...DEFAULT_COVERAGE_CONFIG, ...config };
    this.sphericalGrid = createCoverageGrid(this.config.sphericalCellSize);
    this.floorGrid = createFloorGrid(this.config.floorCellSize);
  }
  
  /**
   * Reset all coverage tracking
   */
  public reset(): void {
    this.sphericalGrid = createCoverageGrid(this.config.sphericalCellSize);
    this.floorGrid = createFloorGrid(this.config.floorCellSize);
    this.detectedObjects = [];
    this.positionClusters = [];
    this.photos.clear();
    this.photosByCluster.clear();
  }
  
  /**
   * Set callback for coverage updates
   */
  public setOnCoverageUpdate(callback: ((report: CoverageReport) => void) | null): void {
    this.onCoverageUpdate = callback;
  }
  
  /**
   * Add a photo and update coverage
   */
  public addPhoto(photo: PhotogrammetryPhoto): void {
    this.photos.set(photo.id, photo);
    
    // Update spherical coverage
    this.updateSphericalCoverage(photo);
    
    // Update floor coverage
    this.updateFloorCoverage(photo);
    
    // Assign to or create position cluster
    this.assignToCluster(photo);
    
    // Update triangulation status
    this.updateTriangulation();
    
    // Notify listeners
    this.notifyCoverageUpdate();
  }
  
  /**
   * Add a detected object for coverage tracking
   */
  public addDetectedObject(object: DetectedObject): void {
    // Check if we already have this object (by bounding box overlap)
    const existing = this.detectedObjects.find(o => 
      this.boundingBoxesOverlap(o.boundingBox, object.boundingBox)
    );
    
    if (existing) {
      // Merge with existing
      existing.viewAngles = [...new Set([...existing.viewAngles, ...object.viewAngles])];
      existing.viewPositions = [...new Set([...existing.viewPositions, ...object.viewPositions])];
      existing.actualViews = existing.viewAngles.length;
      existing.coverage = this.calculateObjectCoverage(existing);
    } else {
      object.coverage = this.calculateObjectCoverage(object);
      this.detectedObjects.push(object);
    }
    
    this.notifyCoverageUpdate();
  }
  
  /**
   * Get current coverage report
   */
  public getCoverageReport(): CoverageReport {
    const missingRegions = this.findMissingRegions();
    const recommendations = this.generateRecommendations(missingRegions);
    
    const overallCoverage = this.calculateOverallCoverage();
    const triangulatableCoverage = this.calculateTriangulatableCoverage();
    
    return {
      timestamp: Date.now(),
      overallCoverage,
      triangulatableCoverage,
      positionsCovered: this.positionClusters.length,
      grid: this.sphericalGrid,
      floorGrid: this.floorGrid,
      objects: this.detectedObjects,
      missingRegions,
      recommendations,
      readyForProcessing: this.isReadyForProcessing(),
      readinessScore: this.calculateReadinessScore(),
    };
  }
  
  /**
   * Check if ready for processing
   */
  public isReadyForProcessing(): boolean {
    const coverage = this.calculateOverallCoverage();
    const triangulation = this.calculateTriangulatableCoverage();
    const largestGap = this.findLargestGap();
    const objectsCovered = this.detectedObjects.every(
      o => o.coverage >= 70
    );
    
    return (
      coverage >= this.config.coverageThreshold * 100 &&
      triangulation >= this.config.triangulationThreshold * 100 &&
      largestGap <= this.config.maxGapDegrees &&
      objectsCovered &&
      this.positionClusters.length >= 2
    );
  }
  
  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================
  
  /**
   * Update spherical coverage grid with a new photo
   */
  private updateSphericalCoverage(photo: PhotogrammetryPhoto): void {
    const { horizontalFov, verticalFov, sphericalCellSize: _sphericalCellSize } = this.config;
    
    // Calculate which cells this photo covers
    const halfFovH = horizontalFov / 2;
    const halfFovV = verticalFov / 2;
    
    const minAz = normalizeAngle(photo.azimuth - halfFovH);
    const maxAz = normalizeAngle(photo.azimuth + halfFovH);
    const minEl = Math.max(-90, photo.elevation - halfFovV);
    const maxEl = Math.min(90, photo.elevation + halfFovV);
    
    // Iterate through grid cells
    const numAzCells = this.sphericalGrid.cells.length;
    const numElCells = this.sphericalGrid.cells[0]?.length || 0;
    
    for (let a = 0; a < numAzCells; a++) {
      for (let e = 0; e < numElCells; e++) {
        const cell = this.sphericalGrid.cells[a][e];
        
        // Check if cell is within photo's FOV
        if (this.isCellCovered(cell, minAz, maxAz, minEl, maxEl)) {
          cell.viewCount++;
          cell.photoIds.push(photo.id);
          
          // Track which position clusters see this cell
          const clusterId = this.getClusterIdForPhoto(photo.id);
          if (clusterId && !cell.positionIds.includes(clusterId)) {
            cell.positionIds.push(clusterId);
          }
        }
      }
    }
    
    // Update coverage statistics
    this.updateCoverageStatistics();
  }
  
  /**
   * Check if a coverage cell is within a photo's field of view
   */
  private isCellCovered(
    cell: CoverageCell,
    minAz: number,
    maxAz: number,
    minEl: number,
    maxEl: number
  ): boolean {
    // Handle azimuth wrap-around (e.g., 350° to 10°)
    let azimuthCovered = false;
    if (minAz > maxAz) {
      // Wraps around 0°
      azimuthCovered = cell.azimuth >= minAz || cell.azimuth <= maxAz;
    } else {
      azimuthCovered = cell.azimuth >= minAz && cell.azimuth <= maxAz;
    }
    
    const elevationCovered = cell.elevation >= minEl && cell.elevation <= maxEl;
    
    return azimuthCovered && elevationCovered;
  }
  
  /**
   * Update floor coverage grid
   */
  private updateFloorCoverage(photo: PhotogrammetryPhoto): void {
    const pos = photo.estimatedPosition;
    const cellSize = this.config.floorCellSize;
    
    // Get grid cell coordinates
    const cellX = Math.floor(pos.x / cellSize);
    const cellY = Math.floor(pos.y / cellSize);
    const cellKey = `${cellX},${cellY}`;
    
    // Get or create cell
    let cell = this.floorGrid.cells.get(cellKey);
    if (!cell) {
      cell = {
        x: cellX,
        y: cellY,
        worldX: cellX * cellSize + cellSize / 2,
        worldY: cellY * cellSize + cellSize / 2,
        visitCount: 0,
        photosTaken: 0,
        photoIds: [],
      };
      this.floorGrid.cells.set(cellKey, cell);
    }
    
    cell.visitCount++;
    cell.photosTaken++;
    cell.photoIds.push(photo.id);
    
    // Update bounds
    this.updateFloorBounds(pos);
  }
  
  /**
   * Update floor grid bounds
   */
  private updateFloorBounds(pos: Vector3): void {
    const bounds = this.floorGrid.bounds;
    
    bounds.min.x = Math.min(bounds.min.x, pos.x);
    bounds.min.y = Math.min(bounds.min.y, pos.y);
    bounds.min.z = Math.min(bounds.min.z, pos.z);
    
    bounds.max.x = Math.max(bounds.max.x, pos.x);
    bounds.max.y = Math.max(bounds.max.y, pos.y);
    bounds.max.z = Math.max(bounds.max.z, pos.z);
    
    bounds.center = {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    };
    
    bounds.size = {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    };
  }
  
  /**
   * Assign photo to a position cluster or create new cluster
   */
  private assignToCluster(photo: PhotogrammetryPhoto): void {
    const pos = photo.estimatedPosition;
    const clusterRadius = this.config.minBaselineMeters;
    
    // Find existing cluster within radius
    let targetCluster = this.positionClusters.find(cluster => 
      Vec3.distance(cluster.centerPosition, pos) < clusterRadius
    );
    
    if (!targetCluster) {
      // Create new cluster
      targetCluster = {
        id: generateId(),
        centerPosition: { ...pos },
        radius: 0,
        photoIds: [],
        primaryPhotoId: photo.id,
        captureStartTime: photo.timestamp,
        captureEndTime: photo.timestamp,
      };
      this.positionClusters.push(targetCluster);
      this.photosByCluster.set(targetCluster.id, []);
    }
    
    // Add photo to cluster
    targetCluster.photoIds.push(photo.id);
    this.photosByCluster.get(targetCluster.id)?.push(photo.id);
    
    // Update cluster properties
    targetCluster.captureEndTime = photo.timestamp;
    targetCluster.radius = Math.max(
      targetCluster.radius,
      Vec3.distance(targetCluster.centerPosition, pos)
    );
    
    // Recalculate center
    this.recalculateClusterCenter(targetCluster);
  }
  
  /**
   * Recalculate cluster center position
   */
  private recalculateClusterCenter(cluster: PositionCluster): void {
    const positions = cluster.photoIds
      .map(id => this.photos.get(id)?.estimatedPosition)
      .filter((p): p is Vector3 => p !== undefined);
    
    if (positions.length === 0) return;
    
    cluster.centerPosition = {
      x: positions.reduce((sum, p) => sum + p.x, 0) / positions.length,
      y: positions.reduce((sum, p) => sum + p.y, 0) / positions.length,
      z: positions.reduce((sum, p) => sum + p.z, 0) / positions.length,
    };
  }
  
  /**
   * Get cluster ID for a photo
   */
  private getClusterIdForPhoto(photoId: string): string | undefined {
    for (const [clusterId, photoIds] of this.photosByCluster.entries()) {
      if (photoIds.includes(photoId)) {
        return clusterId;
      }
    }
    return undefined;
  }
  
  /**
   * Update triangulation status for all cells
   */
  private updateTriangulation(): void {
    for (const azCells of this.sphericalGrid.cells) {
      for (const cell of azCells) {
        cell.triangulatable = this.isCellTriangulatable(cell);
      }
    }
  }
  
  /**
   * Check if a cell can be triangulated
   */
  private isCellTriangulatable(cell: CoverageCell): boolean {
    // Need at least 2 different position clusters
    if (cell.positionIds.length < this.config.minViewsForTriangulation) {
      return false;
    }
    
    // Check baseline between positions
    const clusterPositions = cell.positionIds
      .map(id => this.positionClusters.find(c => c.id === id)?.centerPosition)
      .filter((p): p is Vector3 => p !== undefined);
    
    // Check if any pair has sufficient baseline
    for (let i = 0; i < clusterPositions.length; i++) {
      for (let j = i + 1; j < clusterPositions.length; j++) {
        const distance = Vec3.distance(clusterPositions[i], clusterPositions[j]);
        if (distance >= this.config.minBaselineMeters) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Update coverage statistics
   */
  private updateCoverageStatistics(): void {
    let coveredCells = 0;
    let triangulatableCells = 0;
    let totalCells = 0;
    
    for (const azCells of this.sphericalGrid.cells) {
      for (const cell of azCells) {
        totalCells++;
        if (cell.viewCount > 0) coveredCells++;
        if (cell.triangulatable) triangulatableCells++;
      }
    }
    
    this.sphericalGrid.overallCoverage = (coveredCells / totalCells) * 100;
    this.sphericalGrid.triangulatableCoverage = (triangulatableCells / totalCells) * 100;
    this.sphericalGrid.largestGap = this.findLargestGap();
    this.sphericalGrid.gapLocations = this.findGapLocations();
  }
  
  /**
   * Calculate overall coverage percentage
   */
  private calculateOverallCoverage(): number {
    return this.sphericalGrid.overallCoverage;
  }
  
  /**
   * Calculate triangulatable coverage percentage
   */
  private calculateTriangulatableCoverage(): number {
    return this.sphericalGrid.triangulatableCoverage;
  }
  
  /**
   * Find the largest gap in coverage
   */
  private findLargestGap(): number {
    // Find largest uncovered region in azimuth at horizon level (elevation 0)
    const horizonCells = this.sphericalGrid.cells.map(azCells => {
      // Find cell closest to horizon
      const horizonCell = azCells.find(c => Math.abs(c.elevation) < this.config.sphericalCellSize);
      return horizonCell || azCells[Math.floor(azCells.length / 2)];
    });
    
    let maxGap = 0;
    let currentGap = 0;
    
    // Wrap around for continuous check
    const allCells = [...horizonCells, ...horizonCells];
    
    for (const cell of allCells) {
      if (cell.viewCount === 0) {
        currentGap += this.config.sphericalCellSize;
      } else {
        maxGap = Math.max(maxGap, currentGap);
        currentGap = 0;
      }
    }
    
    return Math.min(maxGap, 360);
  }
  
  /**
   * Find locations of coverage gaps
   */
  private findGapLocations(): Array<{ azimuth: number; elevation: number }> {
    const gaps: Array<{ azimuth: number; elevation: number }> = [];
    
    for (const azCells of this.sphericalGrid.cells) {
      for (const cell of azCells) {
        if (cell.viewCount === 0) {
          gaps.push({ azimuth: cell.azimuth, elevation: cell.elevation });
        }
      }
    }
    
    return gaps;
  }
  
  /**
   * Find missing regions that need more coverage
   */
  private findMissingRegions(): MissingRegion[] {
    const regions: MissingRegion[] = [];
    
    // Find large uncovered areas
    const gaps = this.sphericalGrid.gapLocations;
    
    // Cluster nearby gaps into regions
    const clusteredGaps = this.clusterGaps(gaps);
    
    for (const cluster of clusteredGaps) {
      if (cluster.length === 0) continue;
      
      // Calculate cluster center
      const centerAz = cluster.reduce((sum, g) => sum + g.azimuth, 0) / cluster.length;
      const centerEl = cluster.reduce((sum, g) => sum + g.elevation, 0) / cluster.length;
      const size = cluster.length * this.config.sphericalCellSize;
      
      // Determine severity
      let severity: 'critical' | 'warning' | 'minor';
      if (size > 40 || Math.abs(centerEl) < 20) {
        severity = 'critical'; // Large gap or at eye level
      } else if (size > 20) {
        severity = 'warning';
      } else {
        severity = 'minor';
      }
      
      regions.push({
        id: generateId(),
        azimuth: centerAz,
        elevation: centerEl,
        size,
        severity,
        reason: `Uncovered area (${size.toFixed(0)}° gap)`,
        suggestedDirection: centerAz,
      });
    }
    
    // Add missing regions for objects without enough views
    for (const obj of this.detectedObjects) {
      if (obj.coverage < 70) {
        const missingAngle = this.findMissingObjectAngle(obj);
        regions.push({
          id: generateId(),
          azimuth: missingAngle,
          elevation: 0,
          size: 30,
          severity: 'warning',
          reason: `${obj.label || 'Object'} needs more angles (${obj.coverage.toFixed(0)}% covered)`,
          suggestedDirection: missingAngle,
        });
      }
    }
    
    // Sort by severity
    const severityOrder = { critical: 0, warning: 1, minor: 2 };
    regions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    
    return regions;
  }
  
  /**
   * Cluster nearby gap cells together
   */
  private clusterGaps(
    gaps: Array<{ azimuth: number; elevation: number }>
  ): Array<Array<{ azimuth: number; elevation: number }>> {
    if (gaps.length === 0) return [];
    
    const clusters: Array<Array<{ azimuth: number; elevation: number }>> = [];
    const visited = new Set<number>();
    const clusterRadius = this.config.sphericalCellSize * 2;
    
    for (let i = 0; i < gaps.length; i++) {
      if (visited.has(i)) continue;
      
      const cluster = [gaps[i]];
      visited.add(i);
      
      // Find all connected gaps
      for (let j = i + 1; j < gaps.length; j++) {
        if (visited.has(j)) continue;
        
        const dist = Math.sqrt(
          Math.pow(angularDistance(gaps[i].azimuth, gaps[j].azimuth), 2) +
          Math.pow(gaps[i].elevation - gaps[j].elevation, 2)
        );
        
        if (dist < clusterRadius) {
          cluster.push(gaps[j]);
          visited.add(j);
        }
      }
      
      clusters.push(cluster);
    }
    
    return clusters;
  }
  
  /**
   * Find which angle is missing for object coverage
   */
  private findMissingObjectAngle(obj: DetectedObject): number {
    const viewAngles = obj.viewAngles;
    if (viewAngles.length === 0) return 0;
    
    // Find largest gap between view angles
    const sorted = [...viewAngles].sort((a, b) => a - b);
    let maxGap = 0;
    let gapCenter = 0;
    
    for (let i = 0; i < sorted.length; i++) {
      const next = (i + 1) % sorted.length;
      let gap = sorted[next] - sorted[i];
      if (next === 0) gap = 360 - sorted[i] + sorted[0];
      
      if (gap > maxGap) {
        maxGap = gap;
        gapCenter = normalizeAngle(sorted[i] + gap / 2);
      }
    }
    
    return gapCenter;
  }
  
  /**
   * Calculate object coverage percentage
   */
  private calculateObjectCoverage(obj: DetectedObject): number {
    const angleSpread = this.calculateAngleSpread(obj.viewAngles);
    const viewRatio = Math.min(1, obj.actualViews / obj.requiredViews);
    const spreadRatio = Math.min(1, angleSpread / this.config.objectViewAngleSpread);
    
    return ((viewRatio + spreadRatio) / 2) * 100;
  }
  
  /**
   * Calculate the angular spread of view angles
   */
  private calculateAngleSpread(angles: number[]): number {
    if (angles.length < 2) return 0;
    
    const sorted = [...angles].sort((a, b) => a - b);
    let maxSpread = 0;
    
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const diff = Math.abs(sorted[j] - sorted[i]);
        const spread = Math.min(diff, 360 - diff);
        maxSpread = Math.max(maxSpread, spread);
      }
    }
    
    return maxSpread;
  }
  
  /**
   * Check if two bounding boxes overlap
   */
  private boundingBoxesOverlap(a: DetectedObject['boundingBox'], b: DetectedObject['boundingBox']): boolean {
    const overlap = 
      a.min.x <= b.max.x && a.max.x >= b.min.x &&
      a.min.y <= b.max.y && a.max.y >= b.min.y &&
      a.min.z <= b.max.z && a.max.z >= b.min.z;
    
    if (!overlap) return false;
    
    // Calculate overlap volume ratio
    const overlapMin = {
      x: Math.max(a.min.x, b.min.x),
      y: Math.max(a.min.y, b.min.y),
      z: Math.max(a.min.z, b.min.z),
    };
    const overlapMax = {
      x: Math.min(a.max.x, b.max.x),
      y: Math.min(a.max.y, b.max.y),
      z: Math.min(a.max.z, b.max.z),
    };
    
    const overlapVolume = 
      (overlapMax.x - overlapMin.x) *
      (overlapMax.y - overlapMin.y) *
      (overlapMax.z - overlapMin.z);
    
    const aVolume = a.size.x * a.size.y * a.size.z;
    const bVolume = b.size.x * b.size.y * b.size.z;
    const smallerVolume = Math.min(aVolume, bVolume);
    
    return overlapVolume / smallerVolume > 0.5;
  }
  
  /**
   * Generate recommendations for improving coverage
   */
  private generateRecommendations(missingRegions: MissingRegion[]): CaptureRecommendation[] {
    const recommendations: CaptureRecommendation[] = [];
    
    // Add recommendations from missing regions
    for (const region of missingRegions.slice(0, 3)) { // Top 3 issues
      recommendations.push({
        type: 'rotate',
        priority: region.severity === 'critical' ? 'high' : 
                  region.severity === 'warning' ? 'medium' : 'low',
        message: region.reason,
        targetAzimuth: region.suggestedDirection,
      });
    }
    
    // Check if need more positions
    if (this.positionClusters.length < 2) {
      recommendations.unshift({
        type: 'move',
        priority: 'high',
        message: 'Move to a new position (2-3 feet away) for better triangulation',
      });
    } else if (this.sphericalGrid.triangulatableCoverage < 50) {
      recommendations.unshift({
        type: 'move',
        priority: 'medium',
        message: 'Move to capture areas from different angles',
      });
    }
    
    // Check if ready
    if (this.isReadyForProcessing()) {
      recommendations.push({
        type: 'complete',
        priority: 'low',
        message: 'Coverage is good! You can finish or add more detail.',
      });
    }
    
    return recommendations;
  }
  
  /**
   * Calculate overall readiness score
   */
  private calculateReadinessScore(): number {
    const coverageScore = Math.min(100, this.sphericalGrid.overallCoverage) / 100;
    const triangulationScore = Math.min(100, this.sphericalGrid.triangulatableCoverage) / 100;
    const positionScore = Math.min(1, this.positionClusters.length / 3);
    const gapScore = 1 - Math.min(1, this.sphericalGrid.largestGap / 40);
    
    const objectScore = this.detectedObjects.length > 0
      ? this.detectedObjects.reduce((sum, o) => sum + o.coverage, 0) / (this.detectedObjects.length * 100)
      : 1;
    
    // Weighted average
    return Math.round(
      (coverageScore * 0.25 +
       triangulationScore * 0.30 +
       positionScore * 0.20 +
       gapScore * 0.15 +
       objectScore * 0.10) * 100
    );
  }
  
  /**
   * Notify listeners of coverage update
   */
  private notifyCoverageUpdate(): void {
    if (this.onCoverageUpdate) {
      this.onCoverageUpdate(this.getCoverageReport());
    }
  }
  
  /**
   * Get position clusters
   */
  public getPositionClusters(): PositionCluster[] {
    return [...this.positionClusters];
  }
  
  /**
   * Get coverage cell for a specific direction
   */
  public getCoverageAt(azimuth: number, elevation: number): CoverageCell | null {
    const cellSize = this.config.sphericalCellSize;
    const azIndex = Math.floor(normalizeAngle(azimuth) / cellSize);
    const elIndex = Math.floor((elevation + 90) / cellSize);
    
    if (
      azIndex >= 0 && azIndex < this.sphericalGrid.cells.length &&
      elIndex >= 0 && elIndex < (this.sphericalGrid.cells[0]?.length || 0)
    ) {
      return this.sphericalGrid.cells[azIndex][elIndex];
    }
    
    return null;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let coverageTrackerInstance: CoverageTrackingService | null = null;

export function getCoverageTracker(config?: Partial<CoverageConfig>): CoverageTrackingService {
  if (!coverageTrackerInstance) {
    coverageTrackerInstance = new CoverageTrackingService(config);
  }
  return coverageTrackerInstance;
}

export function resetCoverageTracker(): void {
  if (coverageTrackerInstance) {
    coverageTrackerInstance.reset();
    coverageTrackerInstance = null;
  }
}

export { CoverageTrackingService };
