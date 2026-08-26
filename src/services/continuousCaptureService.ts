/**
 * Continuous Capture Service
 * 
 * Handles auto-capture logic for photogrammetry scanning.
 * Triggers photo capture based on:
 * - Time elapsed since last capture
 * - Distance moved since last capture
 * - Rotation angle since last capture
 * - Smart mode (any of the above triggers)
 * - Quality-aware smart mode (2026): Only captures when quality is good
 */

import {
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
  PhotogrammetryPhoto,
  Vector3,
  Quaternion,
  Vec3,
  Quat,
  generateId,
} from '../types/photogrammetry';
import { getPositionTracker, PositionTrackingService } from './positionTrackingService';
import { getCoverageTracker, CoverageTrackingService } from './coverageTrackingService';
import { getImageQualityService, type QualityMetrics } from './imageQualityService';

// =============================================================================
// TYPES
// =============================================================================

export interface CaptureEvent {
  photo: PhotogrammetryPhoto;
  trigger: 'time' | 'distance' | 'rotation' | 'manual' | 'coverage' | 'smart_quality';
  triggerValue: number;  // Time in ms, distance in m, or rotation in degrees
  qualityMetrics?: QualityMetrics;  // Quality at time of capture
  // V2 Pipeline AR pose data
  arPose?: {
    position: Vector3;
    rotation: Quaternion;
    confidence: 'high' | 'medium' | 'low';
    timestamp: number;
  };
  hasARPose?: boolean;
}

export interface CaptureState {
  isCapturing: boolean;
  photoCount: number;
  lastCaptureTime: number;
  lastCapturePosition: Vector3;
  lastCaptureRotation: Quaternion;
  lastCaptureAzimuth: number;
  captureRate: number;  // Photos per minute
  autoCapturePaused: boolean;
  // Quality-aware capture state
  currentQuality: QualityMetrics | null;
  isQualityGood: boolean;
  rejectedFrames: number;  // Count of frames skipped due to quality
}

export type CaptureCallback = (event: CaptureEvent) => void;

// =============================================================================
// CONTINUOUS CAPTURE SERVICE
// =============================================================================

class ContinuousCaptureService {
  private config: CaptureConfig;
  private positionTracker: PositionTrackingService;
  private coverageTracker: CoverageTrackingService;
  
  private state: CaptureState;
  private photos: PhotogrammetryPhoto[] = [];
  
  // Timing
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 100;  // Check every 100ms
  
  // Callbacks
  private onCapture: CaptureCallback | null = null;
  private onStateChange: ((state: CaptureState) => void) | null = null;
  private onQualityUpdate: ((metrics: QualityMetrics) => void) | null = null;
  
  // Capture function (provided by scanner component)
  // V2 Pipeline: Returns object with imageData and optional AR pose
  private captureFunction: (() => Promise<string | {
    imageData: string;
    arPose?: {
      position: Vector3;
      rotation: Quaternion;
      confidence: 'high' | 'medium' | 'low';
      timestamp: number;
    };
    hasARPose?: boolean;
  }>) | null = null;
  
  // Video element for quality analysis
  private videoElement: HTMLVideoElement | null = null;
  
  constructor(config: Partial<CaptureConfig> = {}) {
    this.config = { ...DEFAULT_CAPTURE_CONFIG, ...config };
    this.positionTracker = getPositionTracker();
    this.coverageTracker = getCoverageTracker();
    
    this.state = this.createInitialState();
  }
  
  private createInitialState(): CaptureState {
    return {
      isCapturing: false,
      photoCount: 0,
      lastCaptureTime: 0,
      lastCapturePosition: { x: 0, y: 0, z: 0 },
      lastCaptureRotation: Quat.identity(),
      lastCaptureAzimuth: 0,
      captureRate: 0,
      autoCapturePaused: false,
      currentQuality: null,
      isQualityGood: false,
      rejectedFrames: 0,
    };
  }
  
  /**
   * Set the capture function (called to actually take a photo)
   * V2 Pipeline: Can return either string (legacy) or object with AR pose data
   */
  public setCaptureFunction(fn: (() => Promise<string | {
    imageData: string;
    arPose?: {
      position: Vector3;
      rotation: Quaternion;
      confidence: 'high' | 'medium' | 'low';
      timestamp: number;
    };
    hasARPose?: boolean;
  }>) | null): void {
    this.captureFunction = fn;
  }
  
  /**
   * Set callback for capture events
   */
  public setOnCapture(callback: CaptureCallback | null): void {
    this.onCapture = callback;
  }
  
  /**
   * Set callback for state changes
   */
  public setOnStateChange(callback: ((state: CaptureState) => void) | null): void {
    this.onStateChange = callback;
  }
  
  /**
   * Update configuration
   */
  public setConfig(config: Partial<CaptureConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Start continuous capture mode
   */
  public start(): void {
    if (this.state.isCapturing) {
      console.log('[ContinuousCapture] Already running');
      return;
    }
    
    console.log('[ContinuousCapture] Starting continuous capture...');
    
    // Reset state
    this.state = {
      ...this.createInitialState(),
      isCapturing: true,
      lastCaptureTime: Date.now(),
    };
    
    // Start position tracking
    this.positionTracker.start();
    this.positionTracker.setAnchor();
    
    // Reset coverage tracking
    this.coverageTracker.reset();
    
    // Start checking for capture triggers
    this.checkInterval = setInterval(() => {
      this.checkCaptureTriggers();
    }, this.CHECK_INTERVAL_MS);
    
    this.notifyStateChange();
  }
  
  /**
   * Stop continuous capture
   */
  public stop(): void {
    if (!this.state.isCapturing) return;
    
    console.log('[ContinuousCapture] Stopping continuous capture');
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.positionTracker.stop();
    
    this.state.isCapturing = false;
    this.notifyStateChange();
  }
  
  /**
   * Pause auto-capture (manual only)
   */
  public pauseAutoCapture(): void {
    this.state.autoCapturePaused = true;
    this.notifyStateChange();
  }
  
  /**
   * Resume auto-capture
   */
  public resumeAutoCapture(): void {
    this.state.autoCapturePaused = false;
    this.notifyStateChange();
  }
  
  /**
   * Trigger manual capture
   */
  public async manualCapture(): Promise<PhotogrammetryPhoto | null> {
    return this.triggerCapture('manual', 0);
  }
  
  /**
   * Get current state
   */
  public getState(): Readonly<CaptureState> {
    return { ...this.state };
  }
  
  /**
   * Get all captured photos
   */
  public getPhotos(): PhotogrammetryPhoto[] {
    return [...this.photos];
  }
  
  /**
   * Set video element for quality analysis
   */
  public setVideoElement(video: HTMLVideoElement | null): void {
    this.videoElement = video;
    
    console.log('[ContinuousCapture] setVideoElement called:', {
      hasVideo: !!video,
      videoWidth: video?.videoWidth,
      videoHeight: video?.videoHeight,
      hasOnQualityUpdate: !!this.onQualityUpdate
    });
    
    // Start quality analysis immediately if video is provided
    // (will be used when capture starts, or immediately if already capturing)
    if (video) {
      const qualityService = getImageQualityService();
      qualityService.startContinuousAnalysis(video, (metrics) => {
        this.state.currentQuality = metrics;
        this.state.isQualityGood = metrics.isUsable && qualityService.getStability() >= 0.7;
        
        console.log('[ContinuousCapture] Quality update received:', {
          sharpness: metrics.sharpness.toFixed(2),
          featureCount: metrics.featureCount,
          isUsable: metrics.isUsable,
          hasCallback: !!this.onQualityUpdate
        });
        
        if (this.onQualityUpdate) {
          this.onQualityUpdate(metrics);
        }
      });
    }
  }
  
  /**
   * Set callback for quality updates
   */
  public setOnQualityUpdate(callback: ((metrics: QualityMetrics) => void) | null): void {
    this.onQualityUpdate = callback;
  }
  
  /**
   * Check if any capture trigger conditions are met
   */
  private checkCaptureTriggers(): void {
    if (!this.state.isCapturing || this.state.autoCapturePaused) return;
    if (this.config.mode === 'manual') return;
    
    const now = Date.now();
    const posState = this.positionTracker.getState();
    
    // Check minimum time between captures
    const timeSinceLastCapture = now - this.state.lastCaptureTime;
    if (timeSinceLastCapture < this.config.minTimeBetweenCaptures) return;
    
    // Check triggers based on mode
    let shouldCapture = false;
    let trigger: 'time' | 'distance' | 'rotation' | 'coverage' | 'smart_quality' = 'time';
    let triggerValue = 0;
    
    // Get quality service for smart mode
    const qualityService = getImageQualityService();
    
    if (this.config.mode === 'smart') {
      // SMART MODE 2026: Quality-aware capture
      // Only captures when:
      // 1. Quality is good (sharp + enough features)
      // 2. Camera is stable (low motion)
      // 3. Sufficient movement from last capture (distance OR rotation)
      
      const quality = this.state.currentQuality;
      const stability = qualityService.getStability();
      // Lowered stability threshold from 0.7 to 0.4 for handheld scanning
      const isQualityGood = quality?.isUsable && stability >= 0.4;
      
      // Check movement thresholds
      const distance = Vec3.distance(posState.position, this.state.lastCapturePosition);
      const rotationDiff = Quat.angleBetween(posState.rotation, this.state.lastCaptureRotation);
      const rotationDegrees = rotationDiff * (180 / Math.PI);
      
      const hasMoved = distance >= this.config.distanceThreshold * 0.5;  // 50% of normal threshold
      const hasRotated = rotationDegrees >= this.config.rotationThreshold * 0.5;  // 50% of normal threshold
      const hasSignificantMovement = hasMoved || hasRotated;
      
      // Smart capture: Quality + Movement
      if (isQualityGood && hasSignificantMovement) {
        shouldCapture = true;
        trigger = 'smart_quality';
        triggerValue = quality?.overallScore || 0;
      } else if (!isQualityGood && hasSignificantMovement) {
        // Track rejected frames for UI feedback
        this.state.rejectedFrames++;
      }
      
      // Fallback: Force capture if we haven't captured in a while
      // (even if quality isn't perfect, to maintain coverage)
      if (!shouldCapture && timeSinceLastCapture >= this.config.timeInterval * 2) {
        // Only if quality is marginally acceptable
        if (quality && quality.overallScore >= 30) {
          shouldCapture = true;
          trigger = 'time';
          triggerValue = timeSinceLastCapture;
          console.log('[ContinuousCapture] Forced capture due to timeout (quality:', quality.overallScore, ')');
        }
      }
      
    } else if (this.config.mode === 'time') {
      if (timeSinceLastCapture >= this.config.timeInterval) {
        shouldCapture = true;
        trigger = 'time';
        triggerValue = timeSinceLastCapture;
      }
      
    } else if (this.config.mode === 'distance') {
      const distance = Vec3.distance(posState.position, this.state.lastCapturePosition);
      if (distance >= this.config.distanceThreshold) {
        shouldCapture = true;
        trigger = 'distance';
        triggerValue = distance;
      }
      
    } else if (this.config.mode === 'rotation') {
      const rotationDiff = Quat.angleBetween(posState.rotation, this.state.lastCaptureRotation);
      const rotationDegrees = rotationDiff * (180 / Math.PI);
      if (rotationDegrees >= this.config.rotationThreshold) {
        shouldCapture = true;
        trigger = 'rotation';
        triggerValue = rotationDegrees;
      }
    }
    
    if (shouldCapture) {
      this.triggerCapture(trigger, triggerValue);
    }
  }
  
  /**
   * Trigger a capture
   */
  private async triggerCapture(
    trigger: 'time' | 'distance' | 'rotation' | 'manual' | 'coverage' | 'smart_quality',
    triggerValue: number
  ): Promise<PhotogrammetryPhoto | null> {
    if (!this.captureFunction) {
      console.warn('[ContinuousCapture] No capture function set');
      return null;
    }
    
    try {
      // Capture image (V2 pipeline returns object with AR pose)
      const captureResult = await this.captureFunction();
      
      // Handle both legacy string format and new V2 object format
      let imageData: string;
      let arPose: any = undefined;
      let hasARPose = false;
      
      if (typeof captureResult === 'string') {
        // Legacy format: just the image data string
        imageData = captureResult;
      } else {
        // V2 format: object with imageData and AR pose
        imageData = captureResult.imageData;
        arPose = captureResult.arPose;
        hasARPose = captureResult.hasARPose ?? false;
      }
      
      // Get current position state
      const posState = this.positionTracker.getState();
      const sample = this.positionTracker.captureSample();
      
      // Create photo object
      const photo: PhotogrammetryPhoto = {
        id: generateId(),
        imageData,
        timestamp: Date.now(),
        sequenceIndex: this.photos.length,
        estimatedPosition: { ...posState.position },
        estimatedRotation: { ...posState.rotation },
        azimuth: posState.yaw,
        elevation: posState.pitch,
        imuData: sample.rawSensorData,
        arPose,
        hasARPose,
      };
      
      // Add to photos list
      this.photos.push(photo);
      
      // Update coverage tracking
      this.coverageTracker.addPhoto(photo);
      
      // Update state
      const now = Date.now();
      this.state.lastCaptureTime = now;
      this.state.lastCapturePosition = { ...posState.position };
      this.state.lastCaptureRotation = { ...posState.rotation };
      this.state.lastCaptureAzimuth = posState.yaw;
      this.state.photoCount = this.photos.length;
      
      // Calculate capture rate
      const duration = (now - (this.photos[0]?.timestamp || now)) / 1000 / 60; // minutes
      this.state.captureRate = duration > 0 ? this.photos.length / duration : 0;
      
      console.log(`[ContinuousCapture] Photo ${this.photos.length} captured (${trigger}: ${triggerValue.toFixed(2)})${hasARPose ? ' [AR]' : ''}`);
      
      // Notify listeners (include AR pose data for V2 pipeline)
      const event: CaptureEvent = { 
        photo, 
        trigger, 
        triggerValue,
        arPose,
        hasARPose 
      };
      if (this.onCapture) {
        this.onCapture(event);
      }
      
      this.notifyStateChange();
      
      return photo;
      
    } catch (error) {
      console.error('[ContinuousCapture] Capture failed:', error);
      return null;
    }
  }
  
  /**
   * Notify state change listeners
   */
  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.state);
    }
  }
  
  /**
   * Get suggestions for next capture
   */
  public getCaptureSuggestions(): {
    shouldMove: boolean;
    shouldRotate: boolean;
    moveDirection?: Vector3;
    rotateDirection?: number;
    message: string;
  } {
    const coverage = this.coverageTracker.getCoverageReport();
    const recommendations = coverage.recommendations;
    
    if (recommendations.length === 0) {
      return {
        shouldMove: false,
        shouldRotate: false,
        message: 'Coverage is complete!',
      };
    }
    
    const topRec = recommendations[0];
    
    if (topRec.type === 'move') {
      return {
        shouldMove: true,
        shouldRotate: false,
        moveDirection: topRec.targetPosition,
        message: topRec.message,
      };
    } else if (topRec.type === 'rotate') {
      return {
        shouldMove: false,
        shouldRotate: true,
        rotateDirection: topRec.targetAzimuth,
        message: topRec.message,
      };
    }
    
    return {
      shouldMove: false,
      shouldRotate: false,
      message: topRec.message,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let continuousCaptureInstance: ContinuousCaptureService | null = null;

export function getContinuousCapture(config?: Partial<CaptureConfig>): ContinuousCaptureService {
  if (!continuousCaptureInstance) {
    continuousCaptureInstance = new ContinuousCaptureService(config);
  }
  return continuousCaptureInstance;
}

export function resetContinuousCapture(): void {
  if (continuousCaptureInstance) {
    continuousCaptureInstance.stop();
    continuousCaptureInstance = null;
  }
}

export { ContinuousCaptureService };
