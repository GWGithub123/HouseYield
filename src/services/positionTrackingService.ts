/**
 * Position Tracking Service
 * 
 * Tracks device position and orientation during photogrammetry capture.
 * Combines multiple sources:
 * - Gyroscope for rotation (via GyroRotationTracker)
 * - Accelerometer for movement estimation
 * - Visual odometry hints (from feature matching, post-processing)
 * 
 * Position is estimated relative to the starting point (0, 0, 0).
 * Accuracy depends on sensor quality and capture duration.
 */

import {
  Vector3,
  Quaternion,
  Vec3,
  Quat,
  generateId,
} from '../types/photogrammetry';
import { iPhoneSensorData } from '../types/panoramaScanner';
import { getGyroTracker, GyroRotationTracker } from './gyroRotationTracker';

// =============================================================================
// TYPES
// =============================================================================

export interface PositionState {
  // Current position relative to start (meters)
  position: Vector3;
  
  // Current orientation
  rotation: Quaternion;
  
  // Derived orientation in degrees
  yaw: number;      // 0-360° horizontal
  pitch: number;    // -90 to 90° vertical
  roll: number;     // Camera roll
  
  // Velocity estimate (m/s)
  velocity: Vector3;
  
  // Tracking quality
  isCalibrated: boolean;
  confidence: number;   // 0-1
  
  // Statistics
  distanceTraveled: number;  // Total path length in meters
  maxDistanceFromStart: number;
  trackingDuration: number;  // Seconds
  sampleCount: number;
}

export interface PositionSample {
  id: string;
  timestamp: number;
  position: Vector3;
  rotation: Quaternion;
  yaw: number;
  pitch: number;
  confidence: number;
  rawSensorData?: iPhoneSensorData;
}

export interface TrackingConfig {
  // Update rate
  sampleRateHz: number;
  
  // Position estimation
  useAccelerometer: boolean;
  accelerometerScale: number;  // Multiply accelerometer values (calibration)
  
  // Filtering
  positionSmoothingFactor: number;  // 0-1, higher = more smoothing
  velocityDecay: number;  // Velocity decays when no movement detected
  
  // Thresholds
  movementThreshold: number;  // Minimum acceleration to count as movement (m/s²)
  stationaryThreshold: number;  // Below this, assume stationary
}

const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  sampleRateHz: 60,
  useAccelerometer: true,
  accelerometerScale: 1.0,
  positionSmoothingFactor: 0.3,
  velocityDecay: 0.95,
  movementThreshold: 0.1,
  stationaryThreshold: 0.05,
};

// =============================================================================
// POSITION TRACKING SERVICE
// =============================================================================

class PositionTrackingService {
  private gyroTracker: GyroRotationTracker;
  private config: TrackingConfig;
  
  private state: PositionState;
  private samples: PositionSample[] = [];
  private isRunning: boolean = false;
  private startTime: number = 0;
  
  // Raw sensor handlers
  private motionHandler: ((event: DeviceMotionEvent) => void) | null = null;
  
  // Sensor data for temporal smoothing
  private lastAcceleration: Vector3 = { x: 0, y: 0, z: 0 };
  private lastGravity: Vector3 = { x: 0, y: 0, z: 1 };
  private lastTimestamp: number = 0;
  
  // Position history for path tracking
  private positionHistory: Vector3[] = [];
  private readonly MAX_HISTORY_LENGTH = 1000;
  
  // Callbacks
  private onUpdate: ((state: PositionState) => void) | null = null;
  
  constructor(config: Partial<TrackingConfig> = {}) {
    this.config = { ...DEFAULT_TRACKING_CONFIG, ...config };
    this.gyroTracker = getGyroTracker();
    
    this.state = this.createInitialState();
  }
  
  private createInitialState(): PositionState {
    return {
      position: { x: 0, y: 0, z: 0 },
      rotation: Quat.identity(),
      yaw: 0,
      pitch: 0,
      roll: 0,
      velocity: { x: 0, y: 0, z: 0 },
      isCalibrated: false,
      confidence: 0,
      distanceTraveled: 0,
      maxDistanceFromStart: 0,
      trackingDuration: 0,
      sampleCount: 0,
    };
  }
  
  /**
   * Start position tracking
   */
  public start(): void {
    if (this.isRunning) {
      console.log('[PositionTracker] Already running');
      return;
    }
    
    console.log('[PositionTracker] Starting position tracking...');
    
    // Start gyro tracker for rotation
    this.gyroTracker.start();
    
    // Reset state
    this.state = this.createInitialState();
    this.samples = [];
    this.positionHistory = [];
    this.startTime = Date.now();
    this.lastTimestamp = Date.now();
    
    // Listen to device motion for accelerometer
    if (this.config.useAccelerometer) {
      this.motionHandler = (event: DeviceMotionEvent) => {
        this.handleMotion(event);
      };
      window.addEventListener('devicemotion', this.motionHandler);
    }
    
    this.isRunning = true;
    console.log('[PositionTracker] Position tracking started');
  }
  
  /**
   * Set anchor point (origin) - call when user starts capture
   */
  public setAnchor(): void {
    console.log('[PositionTracker] Setting anchor point (0, 0, 0)');
    
    this.gyroTracker.setAnchor();
    
    this.state = {
      ...this.createInitialState(),
      isCalibrated: true,
      confidence: 1.0,
    };
    
    this.samples = [];
    this.positionHistory = [{ x: 0, y: 0, z: 0 }];
    this.startTime = Date.now();
    
    // Add initial sample
    this.addSample();
  }
  
  /**
   * Stop tracking
   */
  public stop(): void {
    if (!this.isRunning) return;
    
    console.log('[PositionTracker] Stopping position tracking');
    
    this.gyroTracker.stop();
    
    if (this.motionHandler) {
      window.removeEventListener('devicemotion', this.motionHandler);
      this.motionHandler = null;
    }
    
    this.isRunning = false;
  }
  
  /**
   * Get current position state
   */
  public getState(): Readonly<PositionState> {
    return { ...this.state };
  }
  
  /**
   * Get all position samples
   */
  public getSamples(): PositionSample[] {
    return [...this.samples];
  }
  
  /**
   * Get position history (for path visualization)
   */
  public getPositionHistory(): Vector3[] {
    return [...this.positionHistory];
  }
  
  /**
   * Set callback for state updates
   */
  public setOnUpdate(callback: ((state: PositionState) => void) | null): void {
    this.onUpdate = callback;
  }
  
  /**
   * Capture a position sample (call when taking a photo)
   */
  public captureSample(rawSensorData?: iPhoneSensorData): PositionSample {
    const sample = this.addSample(rawSensorData);
    console.log(`[PositionTracker] Captured sample at (${sample.position.x.toFixed(2)}, ${sample.position.y.toFixed(2)}, ${sample.position.z.toFixed(2)})`);
    return sample;
  }
  
  /**
   * Get estimated distance between two samples
   */
  public getDistanceBetweenSamples(sample1: PositionSample, sample2: PositionSample): number {
    return Vec3.distance(sample1.position, sample2.position);
  }
  
  /**
   * Handle device motion event
   */
  private handleMotion(event: DeviceMotionEvent): void {
    const now = Date.now();
    const dt = (now - this.lastTimestamp) / 1000; // Convert to seconds
    this.lastTimestamp = now;
    
    // Clamp dt to reasonable range
    if (dt <= 0 || dt > 0.5) return;
    
    // Get user acceleration (without gravity)
    const accel = event.accelerationIncludingGravity;
    const userAccel = event.acceleration;
    
    if (!userAccel || !accel) return;
    
    // Get gravity vector (normalized)
    const gravity: Vector3 = {
      x: (accel.x || 0) - (userAccel.x || 0),
      y: (accel.y || 0) - (userAccel.y || 0),
      z: (accel.z || 0) - (userAccel.z || 0),
    };
    const gravityMag = Vec3.length(gravity);
    if (gravityMag > 0) {
      // Smooth gravity with exponential moving average for stability
      const smoothingFactor = 0.1;
      const normalizedGravity = Vec3.scale(gravity, 1 / gravityMag);
      this.lastGravity = Vec3.add(
        Vec3.scale(this.lastGravity, 1 - smoothingFactor),
        Vec3.scale(normalizedGravity, smoothingFactor)
      );
    }
    
    // Get user acceleration in device frame
    const rawDeviceAccel: Vector3 = {
      x: (userAccel.x || 0) * this.config.accelerometerScale,
      y: (userAccel.y || 0) * this.config.accelerometerScale,
      z: (userAccel.z || 0) * this.config.accelerometerScale,
    };
    
    // Smooth acceleration with low-pass filter to reduce noise
    const accelSmoothingFactor = 0.3;
    this.lastAcceleration = Vec3.add(
      Vec3.scale(this.lastAcceleration, 1 - accelSmoothingFactor),
      Vec3.scale(rawDeviceAccel, accelSmoothingFactor)
    );
    const deviceAccel = this.lastAcceleration;
    
    // Filter out noise
    const accelMagnitude = Vec3.length(deviceAccel);
    
    if (accelMagnitude < this.config.stationaryThreshold) {
      // Stationary - decay velocity
      this.state.velocity = Vec3.scale(this.state.velocity, this.config.velocityDecay);
    } else if (accelMagnitude > this.config.movementThreshold) {
      // Moving - transform acceleration to world frame and integrate
      const worldAccel = this.deviceToWorldFrame(deviceAccel);
      
      // Update velocity (integrate acceleration)
      this.state.velocity = Vec3.add(
        Vec3.scale(this.state.velocity, this.config.velocityDecay),
        Vec3.scale(worldAccel, dt)
      );
    }
    
    // Update position (integrate velocity)
    const velocityMagnitude = Vec3.length(this.state.velocity);
    if (velocityMagnitude > 0.01) { // Only update if moving
      const previousPosition = { ...this.state.position };
      
      const positionDelta = Vec3.scale(this.state.velocity, dt);
      
      // Smooth position update
      const smoothedDelta = Vec3.scale(positionDelta, this.config.positionSmoothingFactor);
      this.state.position = Vec3.add(this.state.position, smoothedDelta);
      
      // Update statistics
      const stepDistance = Vec3.distance(previousPosition, this.state.position);
      this.state.distanceTraveled += stepDistance;
      
      const distanceFromStart = Vec3.length(this.state.position);
      this.state.maxDistanceFromStart = Math.max(this.state.maxDistanceFromStart, distanceFromStart);
      
      // Add to history
      this.addPositionToHistory(this.state.position);
    }
    
    // Update rotation from gyro tracker
    const gyroState = this.gyroTracker.getState();
    this.state.yaw = gyroState.yaw;
    this.state.pitch = gyroState.pitch;
    this.state.roll = gyroState.roll;
    this.state.rotation = Quat.fromEuler(
      gyroState.roll * (Math.PI / 180),
      gyroState.pitch * (Math.PI / 180),
      gyroState.yaw * (Math.PI / 180)
    );
    
    // Update tracking duration
    this.state.trackingDuration = (now - this.startTime) / 1000;
    
    // Update confidence based on tracking duration and calibration
    if (this.state.isCalibrated) {
      // Confidence decreases slowly over time due to IMU drift
      const driftFactor = Math.max(0.5, 1 - (this.state.trackingDuration / 300)); // 5 min max
      this.state.confidence = driftFactor;
    }
    
    // Notify callback
    if (this.onUpdate) {
      this.onUpdate(this.state);
    }
  }
  
  /**
   * Transform vector from device frame to world frame
   */
  private deviceToWorldFrame(deviceVector: Vector3): Vector3 {
    // Use current rotation to transform
    // This is a simplified transform - uses yaw only for horizontal movement
    const yawRad = this.state.yaw * (Math.PI / 180);
    const cosYaw = Math.cos(yawRad);
    const sinYaw = Math.sin(yawRad);
    
    // Rotate horizontal components by yaw
    // Device X = right, Device Y = forward, Device Z = up (typically)
    // World X = east, World Y = north (forward at yaw=0), World Z = up
    return {
      x: deviceVector.x * cosYaw - deviceVector.y * sinYaw,
      y: deviceVector.x * sinYaw + deviceVector.y * cosYaw,
      z: deviceVector.z, // Keep vertical component
    };
  }
  
  /**
   * Add current position to history
   */
  private addPositionToHistory(position: Vector3): void {
    // Only add if moved significantly from last point
    if (this.positionHistory.length > 0) {
      const lastPos = this.positionHistory[this.positionHistory.length - 1];
      if (Vec3.distance(lastPos, position) < 0.05) return; // Less than 5cm
    }
    
    this.positionHistory.push({ ...position });
    
    // Limit history length
    if (this.positionHistory.length > this.MAX_HISTORY_LENGTH) {
      this.positionHistory.shift();
    }
  }
  
  /**
   * Add a position sample
   */
  private addSample(rawSensorData?: iPhoneSensorData): PositionSample {
    const sample: PositionSample = {
      id: generateId(),
      timestamp: Date.now(),
      position: { ...this.state.position },
      rotation: { ...this.state.rotation },
      yaw: this.state.yaw,
      pitch: this.state.pitch,
      confidence: this.state.confidence,
      rawSensorData,
    };
    
    this.samples.push(sample);
    this.state.sampleCount = this.samples.length;
    
    return sample;
  }
  
  /**
   * Estimate camera intrinsics for current device
   * These are rough estimates - should be calibrated for accuracy
   */
  public estimateCameraIntrinsics(imageWidth: number, imageHeight: number) {
    // Estimate based on typical smartphone FOV (~70° horizontal)
    const horizontalFovDeg = 70;
    const horizontalFovRad = horizontalFovDeg * (Math.PI / 180);
    
    // Focal length in pixels: fx = width / (2 * tan(fov/2))
    const focalLengthX = imageWidth / (2 * Math.tan(horizontalFovRad / 2));
    const focalLengthY = focalLengthX; // Assume square pixels
    
    return {
      focalLengthX,
      focalLengthY,
      principalPointX: imageWidth / 2,
      principalPointY: imageHeight / 2,
      imageWidth,
      imageHeight,
    };
  }
  
  /**
   * Get path statistics
   */
  public getPathStatistics() {
    return {
      totalDistance: this.state.distanceTraveled,
      maxDistanceFromStart: this.state.maxDistanceFromStart,
      numSamples: this.samples.length,
      duration: this.state.trackingDuration,
      averageSpeed: this.state.distanceTraveled / Math.max(1, this.state.trackingDuration),
      pathPoints: this.positionHistory.length,
    };
  }
  
  /**
   * Check if position has changed significantly since last sample
   */
  public hasMovedSinceLastSample(threshold: number = 0.3): boolean {
    if (this.samples.length === 0) return true;
    
    const lastSample = this.samples[this.samples.length - 1];
    return Vec3.distance(lastSample.position, this.state.position) >= threshold;
  }
  
  /**
   * Check if rotation has changed significantly since last sample
   */
  public hasRotatedSinceLastSample(thresholdDegrees: number = 20): boolean {
    if (this.samples.length === 0) return true;
    
    const lastSample = this.samples[this.samples.length - 1];
    const angleDiff = Quat.angleBetween(lastSample.rotation, this.state.rotation);
    return (angleDiff * 180 / Math.PI) >= thresholdDegrees;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let positionTrackerInstance: PositionTrackingService | null = null;

export function getPositionTracker(config?: Partial<TrackingConfig>): PositionTrackingService {
  if (!positionTrackerInstance) {
    positionTrackerInstance = new PositionTrackingService(config);
  }
  return positionTrackerInstance;
}

export function resetPositionTracker(): void {
  if (positionTrackerInstance) {
    positionTrackerInstance.stop();
    positionTrackerInstance = null;
  }
}

export { PositionTrackingService };
