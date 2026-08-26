/**
 * Gyroscope-Based Rotation Tracker
 * 
 * Uses gyroscope angular velocity integration to track cumulative rotation
 * instead of relying on compass readings that drift due to magnetic interference.
 * 
 * Key advantages:
 * - No compass drift from metal/electronics
 * - Accurate relative rotation tracking
 * - Works in any magnetic environment
 * 
 * Limitations:
 * - Small gyro bias accumulates over time (corrected by periodic compass updates)
 * - Requires continuous sensor stream
 */

export interface RotationState {
  // Cumulative rotation since anchor (degrees)
  yaw: number;    // Horizontal rotation (0-360°)
  pitch: number;  // Vertical tilt (-90 to 90°)
  roll: number;   // Camera roll (-180 to 180°)
  
  // Tracking metadata
  lastUpdateTime: number;      // Timestamp of last update
  totalRotation: number;       // Total yaw rotation (can exceed 360°)
  compassCorrections: number;  // Number of compass-based corrections
  isCalibrated: boolean;       // Whether anchor has been set
}

export class GyroRotationTracker {
  private state: RotationState;
  private motionHandler: ((event: DeviceMotionEvent) => void) | null = null;
  private orientationHandler: ((event: DeviceOrientationEvent) => void) | null = null;
  private anchorCompassHeading: number = 0; // Compass heading at anchor point
  private lastCompassHeading: number | null = null; // For tracking rotation delta
  
  // Filter for compass readings to reject sudden interference jumps
  private smoothedCompassHeading: number | null = null;
  
  // Gyro-based yaw tracking for cross-validation
  private gyroPredictedYaw: number = 0; // Gyro-integrated yaw (relative to anchor)
  private lastGyroTime: number = 0;
  private readonly GYRO_COMPASS_MAX_DIFF = 45; // Max allowed difference between gyro prediction and compass (increased from 20)
  
  // Track how long compass has been rejected to prevent indefinite freezing
  private lastCompassAcceptedTime: number = Date.now();
  private readonly MAX_COMPASS_REJECT_TIME = 2000; // Force accept compass after 2s of rejections
  
  // NEW: Sensor smoothing - rolling average of last N readings
  private yawHistory: number[] = [];
  private pitchHistory: number[] = [];
  private readonly SMOOTHING_WINDOW = 5; // Average last 5 readings
  
  // NEW: Jump detection - track rate of change
  private lastYaw: number = 0;
  // lastPitch used for pitch jump detection (future enhancement)
  private readonly MAX_ANGULAR_VELOCITY = 360; // Max degrees per second (allow fast user rotation)
  
  constructor() {
    this.state = {
      yaw: 0,
      pitch: 0,
      roll: 0,
      lastUpdateTime: Date.now(),
      totalRotation: 0,
      compassCorrections: 0,
      isCalibrated: false
    };
  }
  
  /**
   * Start tracking rotation from current position (anchor point)
   */
  public start(): void {
    console.log('[GyroTracker] Starting HYBRID rotation tracking (gyro + compass)...');
    
    // Use gyroscope for angular velocity to validate compass readings
    this.motionHandler = (event: DeviceMotionEvent) => {
      this.handleMotion(event);
    };
    
    // Listen to orientation for both pitch (accelerometer) and yaw (compass)
    this.orientationHandler = (event: DeviceOrientationEvent) => {
      this.handleOrientation(event);
    };
    
    window.addEventListener('devicemotion', this.motionHandler);
    window.addEventListener('deviceorientation', this.orientationHandler);
    
    console.log('[GyroTracker] Gyro + Compass listeners attached for hybrid tracking');
    
    // Reset state
    this.state = {
      yaw: 0,
      pitch: 0,
      roll: 0,
      lastUpdateTime: Date.now(),
      totalRotation: 0,
      compassCorrections: 0,
      isCalibrated: false
    };
  }
  
  /**
   * Set anchor point (first photo) - resets cumulative tracking
   * The next orientation event will capture the compass heading
   */
  public setAnchor(): void {
    console.log('[GyroTracker] 📍 Anchor set - Starting from 0°');
    this.state.yaw = 0;
    this.state.pitch = 0;
    this.state.roll = 0;
    this.state.totalRotation = 0;
    this.state.lastUpdateTime = Date.now();
    this.state.isCalibrated = true;
    this.lastCompassHeading = null; // Reset for fresh tracking
    this.smoothedCompassHeading = null; // Reset smoothing filter
    this.gyroPredictedYaw = 0; // Reset gyro prediction
    this.lastGyroTime = Date.now();
    this.lastCompassAcceptedTime = Date.now(); // Reset compass rejection timer
    
    // NEW: Reset smoothing history for fresh start
    this.yawHistory = [];
    this.pitchHistory = [];
    this.lastYaw = 0;
    
    // anchorCompassHeading will be set on next orientation event
  }
  
  /**
   * Stop tracking
   */
  public stop(): void {
    if (this.motionHandler) {
      window.removeEventListener('devicemotion', this.motionHandler);
      this.motionHandler = null;
    }
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = null;
    }
    console.log('[GyroTracker] Stopped tracking');
  }
  
  /**
   * Get current rotation state
   */
  public getState(): Readonly<RotationState> {
    return { ...this.state };
  }
  
  /**
   * Get smoothed position (average of last N readings)
   * Better for photo captures - reduces noise
   */
  public getSmoothedState(): { yaw: number; pitch: number; confidence: number } {
    if (this.yawHistory.length === 0) {
      return { yaw: this.state.yaw, pitch: this.state.pitch, confidence: 0.5 };
    }
    
    // Calculate smoothed values (circular mean for yaw)
    const smoothedYaw = this.circularMean(this.yawHistory);
    const smoothedPitch = this.yawHistory.length > 0 
      ? this.pitchHistory.reduce((a, b) => a + b, 0) / this.pitchHistory.length
      : this.state.pitch;
    
    // Confidence based on how many readings we have and their consistency
    const variance = this.calculateVariance(this.yawHistory);
    const confidence = Math.min(1.0, (this.yawHistory.length / this.SMOOTHING_WINDOW) * (1 - Math.min(variance / 100, 0.5)));
    
    return { yaw: smoothedYaw, pitch: smoothedPitch, confidence };
  }
  
  /**
   * Calculate circular mean for angles (handles wraparound at 0/360)
   */
  private circularMean(angles: number[]): number {
    if (angles.length === 0) return 0;
    
    let sinSum = 0, cosSum = 0;
    for (const angle of angles) {
      const rad = angle * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
    }
    
    const meanRad = Math.atan2(sinSum / angles.length, cosSum / angles.length);
    let meanDeg = meanRad * 180 / Math.PI;
    if (meanDeg < 0) meanDeg += 360;
    return meanDeg;
  }
  
  /**
   * Calculate variance of angle readings
   */
  private calculateVariance(angles: number[]): number {
    if (angles.length < 2) return 0;
    const mean = this.circularMean(angles);
    let sumSq = 0;
    for (const angle of angles) {
      let diff = Math.abs(angle - mean);
      if (diff > 180) diff = 360 - diff;
      sumSq += diff * diff;
    }
    return sumSq / angles.length;
  }
  
  /**
   * Check if user has rotated to target angle (within tolerance)
   */
  public isAtTarget(targetYaw: number, tolerance: number = 15): boolean {
    if (!this.state.isCalibrated) return false;
    
    // Normalize both to 0-360
    const normalizedTarget = this.normalizeAngle(targetYaw);
    const normalizedCurrent = this.normalizeAngle(this.state.yaw);
    
    // Calculate shortest angular distance
    let diff = Math.abs(normalizedCurrent - normalizedTarget);
    if (diff > 180) diff = 360 - diff;
    
    return diff <= tolerance;
  }
  
  /**
   * Get how much the user needs to rotate to reach target
   * Returns: { direction: 'left' | 'right' | 'aligned', degrees: number }
   */
  public getRotationToTarget(targetYaw: number): { direction: 'left' | 'right' | 'aligned'; degrees: number } {
    const normalizedTarget = this.normalizeAngle(targetYaw);
    const normalizedCurrent = this.normalizeAngle(this.state.yaw);
    
    // Calculate signed difference (-180 to 180)
    let diff = normalizedTarget - normalizedCurrent;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    
    if (Math.abs(diff) < 15) {
      return { direction: 'aligned', degrees: 0 };
    }
    
    return {
      direction: diff > 0 ? 'right' : 'left',
      degrees: Math.abs(diff)
    };
  }
  
  /**
   * Handle gyroscope data - integrate angular velocity to predict yaw
   * This is used to cross-validate compass readings
   */
  private handleMotion(event: DeviceMotionEvent): void {
    if (!event.rotationRate) {
      return;
    }
    
    // Only integrate when calibrated
    if (!this.state.isCalibrated) {
      this.lastGyroTime = Date.now();
      return;
    }
    
    const now = Date.now();
    const dt = (now - this.lastGyroTime) / 1000; // Convert to seconds
    this.lastGyroTime = now;
    
    if (dt > 0.2 || dt <= 0) {
      // Too long since last update or invalid, skip
      return;
    }
    
    // Get rotation rates (degrees per second)
    const alphaRate = event.rotationRate.alpha || 0; // z-axis (perpendicular to screen)
    const betaRate = event.rotationRate.beta || 0;   // x-axis (left-right through phone)
    const gammaRate = event.rotationRate.gamma || 0; // y-axis (top-bottom through phone)
    
    // Calculate yaw rate based on phone orientation
    const currentPitch = this.state.pitch;
    const currentRoll = this.state.roll;
    
    let yawRate = 0;
    
    // When phone is upright (normal usage), alpha gives yaw rotation
    // When phone is tilted, we need to project the rotation vectors
    const pitchRad = (currentPitch * Math.PI) / 180;
    const rollRad = (currentRoll * Math.PI) / 180;
    
    // Project gyro readings to get horizontal rotation component
    // This handles any phone orientation correctly using all three axes
    if (Math.abs(currentPitch) < 60) {
      // Phone roughly upright - primarily use alpha with corrections for tilt
      // Also incorporate gamma for better accuracy during slight tilts
      yawRate = alphaRate * Math.cos(pitchRad) + gammaRate * Math.sin(rollRad);
    } else {
      // Phone heavily tilted - need more complex projection
      // Use all three axes to compute horizontal rotation
      yawRate = alphaRate * Math.cos(pitchRad) + betaRate * Math.sin(rollRad) * Math.sin(pitchRad) + gammaRate * Math.cos(rollRad) * Math.sin(pitchRad);
    }
    
    // Integrate to update predicted yaw
    const yawDelta = yawRate * dt;
    this.gyroPredictedYaw += yawDelta;
    
    // Normalize to 0-360
    while (this.gyroPredictedYaw < 0) this.gyroPredictedYaw += 360;
    while (this.gyroPredictedYaw >= 360) this.gyroPredictedYaw -= 360;
  }
  
  /**
   * Handle device orientation - get absolute pitch (elevation) and yaw (compass)
   * We use orientation for both pitch and yaw since they're absolute, not cumulative
   */
  private handleOrientation(event: DeviceOrientationEvent): void {
    if (event.beta === null || event.alpha === null) return;
    
    // Get absolute pitch from device orientation (works great for elevation)
    // beta: -180 to 180, where:
    //   0 = phone flat on table
    //   90 = phone upright, pointing at horizon
    //   180/-180 = phone upside down
    // Convert to elevation: 0° = horizon, 90° = straight up, -90° = straight down
    let elevation = 0;
    if (event.beta >= 0 && event.beta <= 180) {
      // Phone tilting from flat towards pointing up
      elevation = 90 - event.beta;
    } else {
      // Phone tilting backwards (beta < 0)
      elevation = 90 - event.beta;
      if (elevation > 90) elevation = 180 - elevation;
      if (elevation < -90) elevation = -180 - elevation;
    }
    
    // Clamp elevation
    elevation = Math.max(-90, Math.min(90, elevation));
    
    this.state.pitch = elevation;
    this.state.roll = event.gamma || 0;
    
    // Use compass alpha for yaw (horizontal rotation)
    // This gives absolute heading like the accelerometer gives absolute tilt
    const rawCompassAlpha = event.alpha;
    
    // If calibrated (anchor set), calculate relative to anchor
    if (this.state.isCalibrated) {
      // Set anchor compass heading on first orientation event after calibration
      if (this.lastCompassHeading === null) {
        this.anchorCompassHeading = rawCompassAlpha;
        this.lastCompassHeading = rawCompassAlpha;
        this.smoothedCompassHeading = rawCompassAlpha;
        console.log('[GyroTracker] Compass anchor set at', rawCompassAlpha.toFixed(1), '°');
        return;
      }
      
      // Apply filter to compass readings to reject sudden interference jumps
      // Cross-validate compass against gyroscope prediction
      let compassAlpha = rawCompassAlpha;
      
      // Calculate compass-derived relative yaw
      let compassRelativeYaw = rawCompassAlpha - this.anchorCompassHeading;
      while (compassRelativeYaw < 0) compassRelativeYaw += 360;
      while (compassRelativeYaw >= 360) compassRelativeYaw -= 360;
      
      // Compare compass yaw to gyro-predicted yaw
      let diffFromGyro = compassRelativeYaw - this.gyroPredictedYaw;
      if (diffFromGyro > 180) diffFromGyro -= 360;
      if (diffFromGyro < -180) diffFromGyro += 360;
      
      const now = Date.now();
      const timeSinceLastAccept = now - this.lastCompassAcceptedTime;
      
      // If compass differs significantly from gyro prediction, it might be interference
      // BUT: if we've been rejecting for too long, trust the compass to prevent lockup
      const shouldForceAccept = timeSinceLastAccept > this.MAX_COMPASS_REJECT_TIME;
      
      if (Math.abs(diffFromGyro) > this.GYRO_COMPASS_MAX_DIFF && 
          this.smoothedCompassHeading !== null && 
          !shouldForceAccept) {
        console.log(`[GyroTracker] Using gyro prediction: compass=${compassRelativeYaw.toFixed(1)}° vs gyro=${this.gyroPredictedYaw.toFixed(1)}° (diff=${diffFromGyro.toFixed(1)}°)`);
        
        // Use gyro prediction for continuous tracking during compass interference
        // This prevents freezing - we ALWAYS update the yaw based on gyro
        compassRelativeYaw = this.gyroPredictedYaw;
        compassAlpha = this.anchorCompassHeading + this.gyroPredictedYaw;
        while (compassAlpha < 0) compassAlpha += 360;
        while (compassAlpha >= 360) compassAlpha -= 360;
      } else {
        // Valid reading OR forced accept - use it and also gently correct the gyro prediction
        // (gyro drifts over time, so we align it with validated compass readings)
        compassAlpha = rawCompassAlpha;
        
        if (shouldForceAccept && Math.abs(diffFromGyro) > this.GYRO_COMPASS_MAX_DIFF) {
          console.log(`[GyroTracker] Force-accepting compass after ${timeSinceLastAccept}ms: resync gyro from ${this.gyroPredictedYaw.toFixed(1)}° to ${compassRelativeYaw.toFixed(1)}°`);
          // Hard reset gyro prediction to match compass
          this.gyroPredictedYaw = compassRelativeYaw;
        } else {
          // Slowly align gyro prediction with compass (corrects gyro drift)
          this.gyroPredictedYaw += diffFromGyro * 0.1;
        }
        
        while (this.gyroPredictedYaw < 0) this.gyroPredictedYaw += 360;
        while (this.gyroPredictedYaw >= 360) this.gyroPredictedYaw -= 360;
        
        this.lastCompassAcceptedTime = now;
      }
      
      this.smoothedCompassHeading = compassAlpha;
      
      // Calculate relative angle from anchor using smoothed compass
      let relativeYaw = compassAlpha - this.anchorCompassHeading;
      
      // Normalize to 0-360
      while (relativeYaw < 0) relativeYaw += 360;
      while (relativeYaw >= 360) relativeYaw -= 360;
      
      // NEW: Jump detection - check if this is a physically impossible movement
      const timeDelta = (now - this.state.lastUpdateTime) / 1000; // seconds
      if (timeDelta > 0 && this.state.lastUpdateTime > 0 && this.yawHistory.length > 0) {
        let yawChange = Math.abs(relativeYaw - this.lastYaw);
        if (yawChange > 180) yawChange = 360 - yawChange;
        const yawVelocity = yawChange / timeDelta;
        
        // If moving faster than humanly possible, likely a sensor glitch
        // Apply smoothing instead of completely rejecting to prevent freezing
        if (yawVelocity > this.MAX_ANGULAR_VELOCITY) {
          console.log(`[GyroTracker] Smoothing fast movement: ${yawChange.toFixed(1)}° in ${(timeDelta*1000).toFixed(0)}ms (${yawVelocity.toFixed(0)}°/s)`);
          // Blend with last known value (70% new, 30% old) instead of completely rejecting
          relativeYaw = relativeYaw * 0.7 + this.lastYaw * 0.3;
        }
      }
      
      this.state.yaw = relativeYaw;
      this.state.lastUpdateTime = now;
      
      // NEW: Update smoothing history
      this.yawHistory.push(relativeYaw);
      this.pitchHistory.push(this.state.pitch);
      
      // Keep only last N readings
      while (this.yawHistory.length > this.SMOOTHING_WINDOW) {
        this.yawHistory.shift();
      }
      while (this.pitchHistory.length > this.SMOOTHING_WINDOW) {
        this.pitchHistory.shift();
      }
      
      // Update last known yaw for jump detection
      this.lastYaw = relativeYaw;
      
      // Update total rotation by tracking how much we've moved since last update
      let delta = compassAlpha - this.lastCompassHeading;
      // Handle wraparound
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      this.state.totalRotation += Math.abs(delta);
      
      this.lastCompassHeading = compassAlpha;
    }
  }
  
  /**
   * Normalize angle to 0-360
   */
  private normalizeAngle(angle: number): number {
    let normalized = angle % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }
  
  /**
   * Reset to specific orientation (for testing or manual correction)
   */
  public reset(yaw: number = 0, pitch: number = 0, roll: number = 0): void {
    console.log(`[GyroTracker] Manual reset to yaw=${yaw}°, pitch=${pitch}°, roll=${roll}°`);
    this.state.yaw = this.normalizeAngle(yaw);
    this.state.pitch = pitch;
    this.state.roll = roll;
    this.state.totalRotation = yaw;
    this.state.lastUpdateTime = Date.now();
    this.state.isCalibrated = true;
  }
  
  /**
   * Get debug info for troubleshooting
   */
  public getDebugInfo(): string {
    return `GyroTracker: yaw=${this.state.yaw.toFixed(1)}° pitch=${this.state.pitch.toFixed(1)}° ` +
           `total=${this.state.totalRotation.toFixed(1)}° corrections=${this.state.compassCorrections} ` +
           `calibrated=${this.state.isCalibrated}`;
  }
}

// Singleton instance
let globalTracker: GyroRotationTracker | null = null;

/**
 * Get the global gyro rotation tracker instance
 */
export function getGyroTracker(): GyroRotationTracker {
  if (!globalTracker) {
    globalTracker = new GyroRotationTracker();
  }
  return globalTracker;
}

/**
 * Reset the global tracker (for cleanup between scans)
 */
export function resetGyroTracker(): void {
  if (globalTracker) {
    globalTracker.stop();
    globalTracker = null;
  }
}
