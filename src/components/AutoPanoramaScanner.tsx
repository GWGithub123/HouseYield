/**
 * Auto Panorama Scanner
 * 
 * Intelligent room scanner that:
 * - Continuously tracks phone orientation via sensors
 * - Auto-captures when user points at uncovered areas
 * - Shows spherical coverage map with gaps highlighted
 * - Guides user to missing areas until 100% coverage
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { requestCameraPermission, captureFrameFromVideo } from '../services/roomScannerService';
import { PanoramaPhoto, CameraIntrinsics } from '../types/panoramaScanner';
import {
  requestMotionPermission,
  requestOrientationPermission,
  captureSensorSnapshot
} from '../services/sensorFusionService';
import { getGyroTracker } from '../services/gyroRotationTracker';
import {
  CoverageState,
  createInitialCoverageState,
  updateCoverage,
  getCoverageStats,
  shouldCaptureHere,
  getGuidanceToGap,
  estimateFrameQuality,
  COVERAGE_CONFIG
} from '../services/sphericalCoverageService';

interface AutoPanoramaScannerProps {
  roomName?: string;
  onComplete: (photos: PanoramaPhoto[], roomName: string) => void;
  onCancel: () => void;
  targetCoverage?: number;  // 0-100, default 95%
}

interface OrientationState {
  azimuth: number;      // 0-360° (compass heading)
  elevation: number;    // -90 to +90° (tilt)
  roll: number;         // Device roll
  timestamp: number;
}

interface StabilityState {
  isStable: boolean;
  stableSince: number | null;
  lastPosition: OrientationState | null;
}

const AutoPanoramaScanner: React.FC<AutoPanoramaScannerProps> = ({
  roomName = 'Room',
  onComplete,
  onCancel,
  targetCoverage = 95
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gyroTracker = useRef(getGyroTracker());
  
  // Core state
  const [isInitialized, setIsInitialized] = useState(false);
  const [sensorsAvailable, setSensorsAvailable] = useState(false);
  const [sensorPermissionRequested, setSensorPermissionRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gyroTrackerActive, setGyroTrackerActive] = useState(false);
  const [currentRotation, setCurrentRotation] = useState({ yaw: 0, pitch: 0, totalRotation: 0 });
  
  // Scanning state
  const [isScanning, setIsScanning] = useState(false);
  const [photos, setPhotos] = useState<PanoramaPhoto[]>([]);
  const [coverage, setCoverage] = useState<CoverageState>(createInitialCoverageState);
  const [orientation, setOrientation] = useState<OrientationState | null>(null);
  const [stability, setStability] = useState<StabilityState>({
    isStable: false,
    stableSince: null,
    lastPosition: null
  });
  
  // Auto-capture state
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCaptureTime, setLastCaptureTime] = useState(0);
  const [guidance, setGuidance] = useState<ReturnType<typeof getGuidanceToGap> | null>(null);
  
  // Capture cooldown to prevent rapid captures
  // REDUCED for more photos with better overlap
  const CAPTURE_COOLDOWN = 600; // ms between captures (was 800)
  
  // Initialize camera and sensors
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      console.log('[AutoScanner] Initializing...');
      
      try {
        // Check if iOS (needs user gesture for sensors)
        // @ts-expect-error
        const needsPermissionRequest = typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission;
        
        if (!needsPermissionRequest) {
          setSensorsAvailable(true);
          setSensorPermissionRequested(true);
          console.log('[AutoScanner] Sensors available (non-iOS)');
        } else {
          console.log('[AutoScanner] iOS detected - sensor permission required');
        }
        
        console.log('[AutoScanner] Requesting camera permission...');
        const stream = await requestCameraPermission();
        
        if (!mounted) {
          console.log('[AutoScanner] Component unmounted during init');
          stream?.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (!stream) {
          console.error('[AutoScanner] No camera stream returned');
          setError('Could not access camera. Please check permissions.');
          return;
        }
        
        console.log('[AutoScanner] Got camera stream:', stream.getTracks().map(t => t.label).join(', '));
        
        if (videoRef.current) {
          streamRef.current = stream;
          videoRef.current.srcObject = stream;
          
          // Add timeout for metadata loading
          const metadataTimeout = setTimeout(() => {
            if (mounted && !videoRef.current?.videoWidth) {
              console.error('[AutoScanner] Video metadata timeout');
              setError('Camera failed to start. Please reload and try again.');
            }
          }, 5000);
          
          videoRef.current.onloadedmetadata = () => {
            console.log('[AutoScanner] Video metadata loaded:', videoRef.current?.videoWidth, 'x', videoRef.current?.videoHeight);
            clearTimeout(metadataTimeout);
            
            videoRef.current?.play().then(() => {
              console.log('[AutoScanner] Video playing');
              if (mounted) {
                setIsInitialized(true);
              }
            }).catch(err => {
              console.error('[AutoScanner] Video play failed:', err);
              if (mounted) {
                setError('Camera failed to start. Please reload.');
              }
            });
          };
          
          videoRef.current.onerror = (e) => {
            console.error('[AutoScanner] Video error:', e);
            clearTimeout(metadataTimeout);
            if (mounted) {
              setError('Camera error. Please reload.');
            }
          };
        } else {
          console.error('[AutoScanner] No video element ref');
          setError('Camera initialization failed.');
        }
      } catch (err) {
        console.error('[AutoScanner] Init error:', err);
        if (mounted) {
          setError('Camera access denied. Please enable camera permissions.');
        }
      }
    };
    
    init();
    
    return () => {
      mounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      // Stop gyro tracker on unmount
      try {
        gyroTracker.current.stop();
        console.log('[AutoScanner] Gyro tracker stopped');
      } catch (err) {
        console.warn('[AutoScanner] Error stopping gyro tracker:', err);
      }
    };
  }, []);
  
  // Request sensor permissions (must be from user gesture on iOS)
  const handleRequestSensorPermission = async () => {
    console.log('[AutoScanner] Requesting sensor permissions...');
    try {
      const motionPermission = await requestMotionPermission();
      const orientationPermission = await requestOrientationPermission();
      
      setSensorPermissionRequested(true);
      setSensorsAvailable(motionPermission && orientationPermission);
      
      if (motionPermission && orientationPermission) {
        console.log('[AutoScanner] ✅ Sensors enabled!');
        
        // Start gyro tracker
        try {
          await gyroTracker.current.start();
          setGyroTrackerActive(true);
          console.log('[AutoScanner] Gyro tracker started');
        } catch (err) {
          console.error('[AutoScanner] Gyro tracker failed to start:', err);
        }
      }
    } catch (err) {
      console.error('[AutoScanner] Sensor permission error:', err);
      setSensorPermissionRequested(true);
    }
  };
  
  // Continuous gyro-based orientation tracking (replaces deviceorientation)
  useEffect(() => {
    if (!sensorsAvailable || !isScanning || !gyroTrackerActive) return;
    
    // Poll gyro state at 20Hz for smooth UI updates
    const interval = setInterval(() => {
      const state = gyroTracker.current.getState();
      
      // Only update if calibrated (anchor set)
      if (!state.isCalibrated) {
        return;
      }
      
      setCurrentRotation({
        yaw: state.yaw,
        pitch: state.pitch,
        totalRotation: state.totalRotation
      });
      
      // Use gyro yaw directly since it's already relative to anchor (0-360°)
      const newOrientation: OrientationState = {
        azimuth: state.yaw,
        elevation: state.pitch,
        roll: 0,
        timestamp: Date.now()
      };
      
      setOrientation(newOrientation);
      
      // Check stability based on gyro state
      setStability(prev => {
        if (!prev.lastPosition) {
          return {
            isStable: false,
            stableSince: null,
            lastPosition: newOrientation
          };
        }
        
        const azDiff = Math.abs(((newOrientation.azimuth - prev.lastPosition.azimuth + 180) % 360) - 180);
        const elDiff = Math.abs(newOrientation.elevation - prev.lastPosition.elevation);
        const isMoving = azDiff > COVERAGE_CONFIG.stabilityThreshold || 
                         elDiff > COVERAGE_CONFIG.stabilityThreshold;
        
        if (isMoving) {
          return {
            isStable: false,
            stableSince: null,
            lastPosition: newOrientation
          };
        }
        
        // Phone is stable
        const stableSince = prev.stableSince || Date.now();
        const stableDuration = Date.now() - stableSince;
        const isStable = stableDuration >= COVERAGE_CONFIG.stabilityDuration;
        
        return {
          isStable,
          stableSince,
          lastPosition: newOrientation
        };
      });
    }, 50); // 20Hz
    
    return () => clearInterval(interval);
  }, [sensorsAvailable, isScanning, gyroTrackerActive]);
  
  // Update guidance based on current orientation
  useEffect(() => {
    if (!orientation || !isScanning) return;
    
    const newGuidance = getGuidanceToGap(
      coverage.cells,
      orientation.azimuth,
      orientation.elevation
    );
    setGuidance(newGuidance);
  }, [orientation, coverage, isScanning]);
  
  // Auto-capture logic
  useEffect(() => {
    if (!isScanning || !orientation || !stability.isStable || isCapturing) return;
    if (Date.now() - lastCaptureTime < CAPTURE_COOLDOWN) return;
    
    const captureCheck = shouldCaptureHere(
      coverage.cells,
      orientation.azimuth,
      orientation.elevation,
      stability.isStable
    );
    
    if (captureCheck.shouldCapture) {
      performCapture();
    }
  }, [orientation, stability, isScanning, isCapturing, lastCaptureTime, coverage]);
  
  // Perform auto-capture
  const performCapture = useCallback(async () => {
    if (!videoRef.current || !orientation || isCapturing) return;
    
    setIsCapturing(true);
    setLastCaptureTime(Date.now());
    
    try {
      // NOTE: Anchor is set in handleStart() when user presses Start button.
      // We do NOT reset the anchor here on first photo capture, as that would
      // shift the reference point from where the user started to where the
      // first photo was taken, causing the coverage map to appear to "reset".
      
      // Capture sensor data
      const sensorData = sensorsAvailable ? await captureSensorSnapshot() : null;
      
      // Capture frame
      const imageData = captureFrameFromVideo(videoRef.current);
      if (!imageData) throw new Error('Failed to capture frame');
      
      // Estimate quality
      const quality = estimateFrameQuality(imageData);
      
      // Get camera intrinsics
      const videoWidth = videoRef.current.videoWidth || 1920;
      const videoHeight = videoRef.current.videoHeight || 1080;
      const fov = COVERAGE_CONFIG.horizontalFOV;
      const focalLength = videoWidth / (2 * Math.tan((fov * Math.PI / 180) / 2));
      
      const cameraIntrinsics: CameraIntrinsics = {
        focalLengthX: focalLength,
        focalLengthY: focalLength,
        principalPointX: videoWidth / 2,
        principalPointY: videoHeight / 2,
        imageWidth: videoWidth,
        imageHeight: videoHeight
      };
      
      // Use smoothed sensor values for more accurate positioning
      const smoothedState = gyroTracker.current.getSmoothedState();
      const captureAzimuth = smoothedState.confidence > 0.3 ? smoothedState.yaw : orientation.azimuth;
      const captureElevation = smoothedState.confidence > 0.3 ? smoothedState.pitch : orientation.elevation;
      
      // Create photo
      const photo: PanoramaPhoto = {
        azimuth: captureAzimuth,
        elevation: captureElevation,
        ringIndex: 0,  // Not using ring system
        photoIndex: photos.length,
        imageData,
        timestamp: Date.now(),
        type: captureElevation > 45 ? 'zenith' : 
              captureElevation < -45 ? 'nadir' : 'ring',
        sensorData: sensorData || undefined,
        cameraIntrinsics
      };
      
      // Update photos
      setPhotos(prev => [...prev, photo]);
      
      // Update coverage
      setCoverage(prev => {
        const newCells = updateCoverage(
          prev.cells,
          orientation.azimuth,
          orientation.elevation,
          photos.length,
          quality
        );
        return getCoverageStats(newCells);
      });
      
      // Log capture with gyro state for debugging - now showing smoothed values
      const gyroState = gyroTracker.current.getState();
      console.log(`[AutoScanner] 📸 Captured photo ${photos.length + 1} at az=${captureAzimuth.toFixed(0)}° el=${captureElevation.toFixed(0)}° (smoothed, conf=${smoothedState.confidence.toFixed(2)}) | Raw gyro yaw=${gyroState.yaw.toFixed(0)}° pitch=${gyroState.pitch.toFixed(0)}°`);
      
      // Flash effect
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          setTimeout(() => {
            ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
          }, 100);
        }
      }
      
    } catch (err) {
      console.error('[AutoScanner] Capture failed:', err);
    }
    
    setIsCapturing(false);
  }, [orientation, isCapturing, photos, sensorsAvailable]);
  
  // Check for completion
  // IMPROVED: Require more photos for better stitching quality
  useEffect(() => {
    // Minimum 16 photos for good overlap and feature matching
    // (Google Street View uses 7+ cameras with massive overlap)
    const minPhotosForQuality = 16;
    
    if (isScanning && coverage.coveragePercent >= targetCoverage && photos.length >= minPhotosForQuality) {
      console.log(`[AutoScanner] ✅ Target coverage reached: ${coverage.coveragePercent}% with ${photos.length} photos`);
      handleComplete();
    }
  }, [coverage, targetCoverage, isScanning, photos]);
  
  // Start scanning
  const handleStart = () => {
    if (!sensorsAvailable) {
      setError('Sensors required for auto-scanning');
      return;
    }
    
    // Set gyro anchor point FIRST before any orientation updates use it
    if (gyroTrackerActive) {
      gyroTracker.current.setAnchor();
      console.log('[AutoScanner] Gyro anchor set - starting from 0°');
    }
    
    setIsScanning(true);
    console.log('[AutoScanner] Started scanning');
  };
  
  // Complete and submit
  const handleComplete = () => {
    setIsScanning(false);
    if (photos.length > 0) {
      onComplete(photos, roomName);
    }
  };
  
  // Manual complete (if user is satisfied before target)
  // IMPROVED: Require minimum 12 photos for decent quality
  const handleManualComplete = () => {
    if (photos.length >= 12) {
      handleComplete();
    }
  };
  
  // Cancel with cleanup
  const handleCancel = () => {
    if (gyroTrackerActive) {
      gyroTracker.current.stop();
      console.log('[AutoScanner] Stopped gyro tracker');
    }
    onCancel();
  };
  
  // Render coverage map (mini-map)
  const renderCoverageMap = () => {
    const mapWidth = 120;
    const mapHeight = 60;
    
    return (
      <div className="relative" style={{ width: mapWidth, height: mapHeight }}>
        {/* Background */}
        <div className="absolute inset-0 bg-gray-900/80 rounded-lg overflow-hidden">
          {/* Grid cells */}
          {coverage.cells.map(cell => {
            // Map azimuth (0-360) to x (0-width)
            const x = (cell.azimuth / 360) * mapWidth;
            // Map elevation (-90 to 90) to y (height to 0)
            const y = ((90 - cell.elevation) / 180) * mapHeight;
            
            const size = 4;
            
            return (
              <div
                key={cell.id}
                className={`absolute rounded-sm ${cell.covered ? 'bg-green-500' : 'bg-red-500/50'}`}
                style={{
                  left: x - size/2,
                  top: y - size/2,
                  width: size,
                  height: size
                }}
              />
            );
          })}
          
          {/* Current position indicator */}
          {orientation && (
            <div
              className="absolute w-3 h-3 bg-white rounded-full border-2 border-blue-500 transform -translate-x-1/2 -translate-y-1/2 z-10"
              style={{
                left: (orientation.azimuth / 360) * mapWidth,
                top: ((90 - orientation.elevation) / 180) * mapHeight
              }}
            />
          )}
        </div>
      </div>
    );
  };
  
  // Error state - show before main UI
  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-white text-center max-w-sm mx-4">
          <div className="text-5xl mb-4">📷</div>
          <p className="text-red-400 font-medium mb-2">Camera Error</p>
          <p className="text-white/70 mb-6">{error}</p>
          <button
            onClick={handleCancel}
            className="px-6 py-3 bg-blue-500 hover:bg-blue-600 rounded-lg font-medium"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="fixed inset-0 bg-black z-50">
      {/* Camera feed - always render so ref is available */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      
      {/* Loading overlay - shown while initializing */}
      {!isInitialized && (
        <div className="absolute inset-0 bg-black flex items-center justify-center z-30">
          <div className="text-white text-center">
            <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="mb-4">Initializing camera...</p>
            <p className="text-white/50 text-sm mb-6">If this takes too long, check camera permissions</p>
            <button
              onClick={handleCancel}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {/* Flash canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        width={window.innerWidth}
        height={window.innerHeight}
      />
      
      {/* Top bar - coverage stats */}
      <div className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/80 to-transparent p-4">
        {/* Gyro Tracker Debug Bar */}
        {gyroTrackerActive && (
          <div className="mb-2 bg-blue-600/90 text-white text-xs px-3 py-2 rounded-lg font-mono">
            🧭 Compass Mode | Yaw: {currentRotation.yaw.toFixed(1)}° | Pitch: {currentRotation.pitch.toFixed(1)}° | Total: {currentRotation.totalRotation.toFixed(0)}° ({(currentRotation.totalRotation / 360).toFixed(2)} turns)
          </div>
        )}
        
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={handleCancel}
            className="text-white/80 hover:text-white"
          >
            ✕ Cancel
          </button>
          
          <div className="text-white font-medium">
            {photos.length} photos
          </div>
          
          {/* Coverage percentage */}
          <div className="text-white font-bold text-lg">
            {coverage.coveragePercent}%
          </div>
        </div>
        
        {/* Progress bar */}
        <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-300 ${
              coverage.coveragePercent >= targetCoverage ? 'bg-green-500' : 'bg-blue-500'
            }`}
            style={{ width: `${coverage.coveragePercent}%` }}
          />
        </div>
        
        {/* Sensor status & mini-map */}
        <div className="flex items-center justify-between mt-3">
          {/* Sensor button or status */}
          {!sensorPermissionRequested ? (
            <button
              onClick={handleRequestSensorPermission}
              className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-full text-sm font-medium animate-pulse"
            >
              📱 Enable Sensors
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className={`text-sm ${sensorsAvailable ? 'text-green-400' : 'text-yellow-400'}`}>
                {sensorsAvailable ? '✓ Sensors Active' : '⚠ No Sensors'}
              </div>
              {/* Gyro tracking indicator */}
              {gyroTrackerActive && gyroTracker.current.getState().isCalibrated && (
                <div className="text-xs bg-blue-500/30 backdrop-blur-sm px-2 py-1 rounded-full text-blue-200">
                  📱 {currentRotation.yaw.toFixed(0)}° | ↕ {currentRotation.pitch.toFixed(0)}°
                </div>
              )}
            </div>
          )}
          
          {/* Mini coverage map */}
          {isScanning && renderCoverageMap()}
        </div>
      </div>
      
      {/* Center guidance */}
      {isScanning && guidance && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {/* Crosshair */}
          <div className="relative">
            {/* Capture indicator */}
            {isCapturing && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-24 h-24 border-4 border-white rounded-full animate-ping" />
              </div>
            )}
            
            {/* Stability indicator */}
            <div className={`w-20 h-20 border-4 rounded-full ${
              stability.isStable ? 'border-green-400' : 'border-white/50'
            } flex items-center justify-center`}>
              {stability.isStable ? (
                <span className="text-green-400 text-2xl">●</span>
              ) : (
                <span className="text-white/50 text-2xl">○</span>
              )}
            </div>
          </div>
        </div>
      )}
      
      {/* Bottom guidance */}
      <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent p-6">
        {!isScanning ? (
          /* Start button */
          <div className="text-center">
            <p className="text-white/70 mb-4">
              Hold your phone upright and slowly pan around the room.
              Photos will be captured automatically.
            </p>
            <button
              onClick={handleStart}
              disabled={!sensorsAvailable}
              className={`px-8 py-4 rounded-full text-lg font-bold ${
                sensorsAvailable 
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-600 text-gray-400 cursor-not-allowed'
              }`}
            >
              🎬 Start Scanning
            </button>
          </div>
        ) : (
          /* Scanning guidance */
          <div className="text-center">
            {/* Direction guidance */}
            {guidance && guidance.direction !== 'none' && (
              <div className="mb-4">
                <div className="text-4xl mb-2">
                  {guidance.direction === 'left' && '👈'}
                  {guidance.direction === 'right' && '👉'}
                  {guidance.direction === 'up' && '👆'}
                  {guidance.direction === 'down' && '👇'}
                </div>
                <p className="text-white text-lg">{guidance.instruction}</p>
              </div>
            )}
            
            {/* Completion status */}
            {coverage.coveragePercent >= targetCoverage ? (
              <div className="text-green-400 text-lg mb-4">
                ✅ Coverage complete!
              </div>
            ) : (
              <p className="text-white/60 text-sm mb-4">
                {coverage.gaps.length} areas remaining
              </p>
            )}
            
            {/* Manual complete button */}
            {photos.length >= 12 && (
              <button
                onClick={handleManualComplete}
                className="px-6 py-3 rounded-full bg-green-500 hover:bg-green-600 text-white font-medium"
              >
                ✓ Done ({photos.length} photos)
              </button>
            )}
            
            {/* Show encouragement message if not enough photos yet */}
            {photos.length > 0 && photos.length < 12 && (
              <div className="text-yellow-400 text-sm">
                Keep scanning! {12 - photos.length} more photos needed for good quality.
              </div>
            )}
            
            {/* Orientation debug */}
            {orientation && (
              <div className="text-white/40 text-xs mt-4">
                Az: {orientation.azimuth.toFixed(0)}° El: {orientation.elevation.toFixed(0)}°
                {stability.isStable && ' 📍 Stable'}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Error display */}
      {error && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white px-6 py-4 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
};

export default AutoPanoramaScanner;
