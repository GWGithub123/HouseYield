/**
 * AR Tracking Service
 * 
 * Uses WebXR to capture metric-scale camera poses during photogrammetry scanning.
 * Runs alongside existing camera stream without changing UI.
 * 
 * Key features:
 * - ARKit/ARCore via WebXR (iOS Safari 15.4+, Chrome Android)
 * - Metric-scale positions (real meters)
 * - World tracking with plane detection
 * - Non-intrusive - fails gracefully if unsupported
 * 
 * This enables the v2 pipeline to produce measurements in real-world units.
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ARPose {
  position: { x: number; y: number; z: number };      // Meters from AR origin
  rotation: { x: number; y: number; z: number; w: number }; // Quaternion (xyzw)
  timestamp: number;                                   // DOMHighResTimeStamp
  confidence: 'high' | 'medium' | 'low';
}

export interface ARPlane {
  id: string;
  orientation: 'horizontal' | 'vertical';
  center: { x: number; y: number; z: number };
  extent: { width: number; height: number };
  polygon?: { x: number; y: number; z: number }[];
}

export interface ARTrackingState {
  isSupported: boolean;
  isActive: boolean;
  currentPose: ARPose | null;
  worldScale: number;  // Always 1.0 for AR (metric)
  trackingQuality: 'normal' | 'limited' | 'unavailable';
  planesDetected: ARPlane[];
  sessionStartTime: number | null;
  framesTracked: number;
}

export interface ARTrackingConfig {
  enablePlaneDetection: boolean;
  enableHitTest: boolean;
  referenceSpaceType: 'local' | 'local-floor' | 'bounded-floor';
}

const DEFAULT_CONFIG: ARTrackingConfig = {
  enablePlaneDetection: true,
  enableHitTest: false,
  referenceSpaceType: 'local-floor',
};

// =============================================================================
// AR TRACKING SERVICE
// =============================================================================

export class ARTrackingService {
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;
  private config: ARTrackingConfig;
  private state: ARTrackingState;
  
  // Callbacks
  private onPoseUpdate: ((pose: ARPose) => void) | null = null;
  private onPlaneDetected: ((plane: ARPlane) => void) | null = null;
  private onTrackingLost: (() => void) | null = null;
  private onTrackingRestored: (() => void) | null = null;
  
  // Pose history for smoothing/interpolation
  private poseHistory: ARPose[] = [];
  private readonly MAX_POSE_HISTORY = 30;
  
  constructor(config: Partial<ARTrackingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      isSupported: false,
      isActive: false,
      currentPose: null,
      worldScale: 1.0,
      trackingQuality: 'unavailable',
      planesDetected: [],
      sessionStartTime: null,
      framesTracked: 0,
    };
  }
  
  // ===========================================================================
  // PUBLIC API
  // ===========================================================================
  
  /**
   * Check if WebXR AR is supported on this device
   */
  async checkSupport(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.xr) {
      console.log('[ARTracking] ❌ WebXR API not available');
      console.log('[ARTracking] Browser:', navigator?.userAgent || 'unknown');
      console.log('[ARTracking] Protocol:', typeof window !== 'undefined' ? window.location.protocol : 'unknown');
      console.log('[ARTracking] Hint: AR requires iOS Safari 15.4+ or Android Chrome with ARCore');
      this.state.isSupported = false;
      return false;
    }
    
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      this.state.isSupported = supported;
      
      if (supported) {
        console.log('[ARTracking] ✅ AR supported - V2 pipeline available');
      } else {
        console.log('[ARTracking] ❌ AR not supported on this device/browser');
        console.log('[ARTracking] Browser:', navigator.userAgent);
        console.log('[ARTracking] Hint: Requires iOS Safari 15.4+ with HTTPS or Android Chrome with ARCore');
      }
      
      return supported;
    } catch (e) {
      console.log('[ARTracking] ❌ AR support check failed:', e);
      console.log('[ARTracking] Browser:', navigator.userAgent);
      this.state.isSupported = false;
      return false;
    }
  }
  
  /**
   * Start AR session alongside existing camera
   * Does NOT replace camera stream - runs in parallel for pose tracking only
   */
  async start(): Promise<boolean> {
    if (this.state.isActive) {
      console.log('[ARTracking] Already active');
      return true;
    }
    
    if (!this.state.isSupported) {
      const supported = await this.checkSupport();
      if (!supported) {
        console.log('[ARTracking] AR not supported, cannot start');
        return false;
      }
    }
    
    try {
      // Build feature lists
      const requiredFeatures: string[] = [this.config.referenceSpaceType];
      const optionalFeatures: string[] = [];
      
      if (this.config.enablePlaneDetection) {
        optionalFeatures.push('plane-detection');
      }
      if (this.config.enableHitTest) {
        optionalFeatures.push('hit-test');
      }
      
      // Request AR session
      console.log('[ARTracking] Requesting AR session...');
      this.session = await navigator.xr!.requestSession('immersive-ar', {
        requiredFeatures,
        optionalFeatures,
      });
      
      // Handle session end
      this.session.addEventListener('end', this.handleSessionEnd.bind(this));
      
      // Get reference space (floor-level origin for metric accuracy)
      try {
        this.referenceSpace = await this.session.requestReferenceSpace(
          this.config.referenceSpaceType
        );
      } catch {
        // Fallback to 'local' if floor detection unavailable
        console.log('[ARTracking] local-floor unavailable, falling back to local');
        this.referenceSpace = await this.session.requestReferenceSpace('local');
      }
      
      // Start frame loop
      this.session.requestAnimationFrame(this.onXRFrame.bind(this));
      
      this.state.isActive = true;
      this.state.sessionStartTime = performance.now();
      this.state.framesTracked = 0;
      
      console.log('[ARTracking] ✅ AR session started - V2 pipeline ACTIVE');
      console.log('[ARTracking] Photos will include metric-scale poses');
      return true;
      
    } catch (e) {
      console.error('[ARTracking] ❌ Failed to start AR session:', e);
      console.log('[ARTracking] V2 pipeline will NOT be used (falling back to V1)');
      console.log('[ARTracking] Common causes:');
      console.log('[ARTracking]   - Not using HTTPS (required on iOS)');
      console.log('[ARTracking]   - User denied AR permissions');
      console.log('[ARTracking]   - ARKit/ARCore unavailable');
      this.state.isActive = false;
      return false;
    }
  }
  
  /**
   * Stop AR session
   */
  async stop(): Promise<void> {
    if (this.session) {
      try {
        await this.session.end();
      } catch (e) {
        console.log('[ARTracking] Session already ended');
      }
      this.session = null;
      this.referenceSpace = null;
    }
    
    this.state.isActive = false;
    this.state.currentPose = null;
    this.state.trackingQuality = 'unavailable';
    this.poseHistory = [];
    
    console.log('[ARTracking] AR session stopped');
  }
  
  /**
   * Get current AR pose (call this when capturing a photo)
   */
  getCurrentPose(): ARPose | null {
    return this.state.currentPose;
  }
  
  /**
   * Get interpolated pose at a specific timestamp
   * Useful for syncing with camera frame timestamps
   */
  getPoseAtTimestamp(timestamp: number): ARPose | null {
    if (this.poseHistory.length === 0) return null;
    if (this.poseHistory.length === 1) return this.poseHistory[0];
    
    // Find surrounding poses
    let before: ARPose | null = null;
    let after: ARPose | null = null;
    
    for (let i = 0; i < this.poseHistory.length; i++) {
      if (this.poseHistory[i].timestamp <= timestamp) {
        before = this.poseHistory[i];
      } else {
        after = this.poseHistory[i];
        break;
      }
    }
    
    // Return closest or interpolate
    if (!before) return after;
    if (!after) return before;
    
    // Linear interpolation
    const t = (timestamp - before.timestamp) / (after.timestamp - before.timestamp);
    return this.interpolatePoses(before, after, t);
  }
  
  /**
   * Get all detected planes
   */
  getDetectedPlanes(): ARPlane[] {
    return [...this.state.planesDetected];
  }
  
  /**
   * Get current tracking state
   */
  getState(): ARTrackingState {
    return { ...this.state };
  }
  
  /**
   * Get tracking statistics
   */
  getStats(): {
    framesTracked: number;
    sessionDuration: number;
    averageFPS: number;
    planesDetected: number;
  } {
    const duration = this.state.sessionStartTime 
      ? (performance.now() - this.state.sessionStartTime) / 1000 
      : 0;
    
    return {
      framesTracked: this.state.framesTracked,
      sessionDuration: duration,
      averageFPS: duration > 0 ? this.state.framesTracked / duration : 0,
      planesDetected: this.state.planesDetected.length,
    };
  }
  
  // ===========================================================================
  // CALLBACKS
  // ===========================================================================
  
  setOnPoseUpdate(callback: (pose: ARPose) => void): void {
    this.onPoseUpdate = callback;
  }
  
  setOnPlaneDetected(callback: (plane: ARPlane) => void): void {
    this.onPlaneDetected = callback;
  }
  
  setOnTrackingLost(callback: () => void): void {
    this.onTrackingLost = callback;
  }
  
  setOnTrackingRestored(callback: () => void): void {
    this.onTrackingRestored = callback;
  }
  
  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================
  
  private onXRFrame(time: DOMHighResTimeStamp, frame: XRFrame): void {
    if (!this.session || !this.referenceSpace) return;
    
    // Schedule next frame
    this.session.requestAnimationFrame(this.onXRFrame.bind(this));
    
    // Get viewer pose (camera position/rotation)
    const viewerPose = frame.getViewerPose(this.referenceSpace);
    
    if (!viewerPose) {
      // Tracking lost
      if (this.state.trackingQuality !== 'unavailable') {
        this.state.trackingQuality = 'unavailable';
        this.onTrackingLost?.();
      }
      return;
    }
    
    // Tracking restored
    if (this.state.trackingQuality === 'unavailable') {
      this.onTrackingRestored?.();
    }
    
    // Extract pose from first view (monocular phone camera)
    const view = viewerPose.views[0];
    const transform = view.transform;
    
    const pose: ARPose = {
      position: {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
      },
      rotation: {
        x: transform.orientation.x,
        y: transform.orientation.y,
        z: transform.orientation.z,
        w: transform.orientation.w,
      },
      timestamp: time,
      confidence: this.estimateConfidence(viewerPose),
    };
    
    // Update state
    this.state.currentPose = pose;
    this.state.trackingQuality = pose.confidence === 'low' ? 'limited' : 'normal';
    this.state.framesTracked++;
    
    // Store in history
    this.poseHistory.push(pose);
    if (this.poseHistory.length > this.MAX_POSE_HISTORY) {
      this.poseHistory.shift();
    }
    
    // Notify listeners
    this.onPoseUpdate?.(pose);
    
    // Process planes if enabled
    if (this.config.enablePlaneDetection) {
      this.processPlanes(frame);
    }
  }
  
  private estimateConfidence(pose: XRViewerPose): 'high' | 'medium' | 'low' {
    // WebXR doesn't expose confidence directly
    // We use emulatedPosition flag as a proxy
    if (pose.emulatedPosition) {
      return 'low';
    }
    
    // Check pose stability (if we have history)
    if (this.poseHistory.length >= 5) {
      const recent = this.poseHistory.slice(-5);
      const velocities = [];
      
      for (let i = 1; i < recent.length; i++) {
        const dt = (recent[i].timestamp - recent[i-1].timestamp) / 1000;
        if (dt > 0) {
          const dx = recent[i].position.x - recent[i-1].position.x;
          const dy = recent[i].position.y - recent[i-1].position.y;
          const dz = recent[i].position.z - recent[i-1].position.z;
          const v = Math.sqrt(dx*dx + dy*dy + dz*dz) / dt;
          velocities.push(v);
        }
      }
      
      // Very high velocity suggests tracking instability
      const avgVelocity = velocities.reduce((a, b) => a + b, 0) / velocities.length;
      if (avgVelocity > 5) { // > 5 m/s is unrealistic for handheld
        return 'low';
      }
      if (avgVelocity > 2) {
        return 'medium';
      }
    }
    
    return 'high';
  }
  
  private processPlanes(frame: XRFrame): void {
    // Plane detection requires the 'plane-detection' feature
    // detectedPlanes may not be in all WebXR implementations
    const detectedPlanes = (frame as XRFrame & { detectedPlanes?: Set<XRPlane> }).detectedPlanes;
    
    if (!detectedPlanes) return;
    
    const newPlanes: ARPlane[] = [];
    
    detectedPlanes.forEach((xrPlane: XRPlane) => {
      const planePose = frame.getPose(xrPlane.planeSpace, this.referenceSpace!);
      if (!planePose) return;
      
      const plane: ARPlane = {
        id: `plane_${newPlanes.length}`,
        orientation: xrPlane.orientation as 'horizontal' | 'vertical',
        center: {
          x: planePose.transform.position.x,
          y: planePose.transform.position.y,
          z: planePose.transform.position.z,
        },
        extent: {
          // @ts-expect-error - extent might not be typed
          width: xrPlane.extent?.width ?? 1,
          // @ts-expect-error
          height: xrPlane.extent?.height ?? 1,
        },
      };
      
      // Check if this is a new plane
      const existingIdx = this.state.planesDetected.findIndex(
        p => Math.abs(p.center.x - plane.center.x) < 0.1 &&
             Math.abs(p.center.y - plane.center.y) < 0.1 &&
             Math.abs(p.center.z - plane.center.z) < 0.1
      );
      
      if (existingIdx === -1) {
        this.onPlaneDetected?.(plane);
      }
      
      newPlanes.push(plane);
    });
    
    this.state.planesDetected = newPlanes;
  }
  
  private interpolatePoses(a: ARPose, b: ARPose, t: number): ARPose {
    // Clamp t
    t = Math.max(0, Math.min(1, t));
    
    // Linear interpolation for position
    const position = {
      x: a.position.x + (b.position.x - a.position.x) * t,
      y: a.position.y + (b.position.y - a.position.y) * t,
      z: a.position.z + (b.position.z - a.position.z) * t,
    };
    
    // SLERP for rotation (simplified - use linear for small angles)
    const rotation = {
      x: a.rotation.x + (b.rotation.x - a.rotation.x) * t,
      y: a.rotation.y + (b.rotation.y - a.rotation.y) * t,
      z: a.rotation.z + (b.rotation.z - a.rotation.z) * t,
      w: a.rotation.w + (b.rotation.w - a.rotation.w) * t,
    };
    
    // Normalize quaternion
    const len = Math.sqrt(
      rotation.x * rotation.x + 
      rotation.y * rotation.y + 
      rotation.z * rotation.z + 
      rotation.w * rotation.w
    );
    rotation.x /= len;
    rotation.y /= len;
    rotation.z /= len;
    rotation.w /= len;
    
    return {
      position,
      rotation,
      timestamp: a.timestamp + (b.timestamp - a.timestamp) * t,
      confidence: t < 0.5 ? a.confidence : b.confidence,
    };
  }
  
  private handleSessionEnd(): void {
    console.log('[ARTracking] Session ended');
    this.state.isActive = false;
    this.session = null;
    this.referenceSpace = null;
  }
}

// =============================================================================
// XRPLANE TYPE (not always in @types/webxr)
// =============================================================================

interface XRPlane {
  planeSpace: XRSpace;
  orientation: string;
  polygon?: DOMPointReadOnly[];
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let arTrackingInstance: ARTrackingService | null = null;

export function getARTracking(config?: Partial<ARTrackingConfig>): ARTrackingService {
  if (!arTrackingInstance) {
    arTrackingInstance = new ARTrackingService(config);
  }
  return arTrackingInstance;
}

export function resetARTracking(): void {
  if (arTrackingInstance) {
    arTrackingInstance.stop();
    arTrackingInstance = null;
  }
}
