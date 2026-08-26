/**
 * Panorama Room Scanner
 * 
 * Captures 26 photos in spherical pattern for complete room coverage.
 * Pattern: 1 zenith + 6@+60° + 8@+30° + 12@0° + 8@-30° + 6@-60° + 1 nadir
 * Photos are stitched into seamless equirectangular panorama with depth.
 * 
 * Enhanced with iPhone sensor data capture for accurate photogrammetry.
 * Uses ANCHOR-BASED orientation tracking - first photo sets the reference point,
 * and all subsequent targets are relative to where the user started.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { requestCameraPermission, captureFrameFromVideo } from '../services/roomScannerService';
import {
  PanoramaPhoto,
  iPhoneSensorData,
  CameraIntrinsics,
  CAPTURE_PATTERN_26,
  generateCaptureSequence
} from '../types/panoramaScanner';
import {
  requestMotionPermission,
  requestOrientationPermission,
  captureSensorSnapshot
} from '../services/sensorFusionService';
import { getGyroTracker } from '../services/gyroRotationTracker';

interface PanoramaScannerProps {
  roomName?: string;
  onComplete: (photos: PanoramaPhoto[], roomName: string) => void;
  onCancel: () => void;
}

const PanoramaScanner: React.FC<PanoramaScannerProps> = ({
  roomName = 'Room',
  onComplete,
  onCancel
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Gyro-based rotation tracker (replaces compass-based anchor)
  const gyroTracker = useRef(getGyroTracker());
  
  const [isInitialized, setIsInitialized] = useState(false);
  const [photos, setPhotos] = useState<PanoramaPhoto[]>([]);
  const [currentInstructionIndex, setCurrentInstructionIndex] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sensorsAvailable, setSensorsAvailable] = useState(false);
  const [sensorPermissionRequested, setSensorPermissionRequested] = useState(false);
  
  // Gyro tracker state for UI updates
  const [gyroTrackerActive, setGyroTrackerActive] = useState(false);
  
  // Live rotation state from gyro tracker
  const [currentRotation, setCurrentRotation] = useState({ yaw: 0, pitch: 0, roll: 0 });

  // Generate capture sequence from 26-photo pattern
  const captureSequence = generateCaptureSequence(CAPTURE_PATTERN_26);
  const currentInstruction = captureSequence[currentInstructionIndex];
  const totalPhotos = CAPTURE_PATTERN_26.totalPhotos;
  const progress = (photos.length / totalPhotos) * 100;
  
  /**
   * Check if current orientation is close enough to target for auto-capture
   * @param targetAzimuth - the target azimuth from the capture instruction
   * @param tolerance - degrees of tolerance (default 15°)
   */
  const isOrientationAligned = useCallback((targetAzimuth: number, tolerance: number = 15): boolean => {
    return gyroTracker.current.isAtTarget(targetAzimuth, tolerance);
  }, []);

  // Initialize camera
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      try {
        // On iOS, we need user interaction for sensor permissions
        // Check if sensors are available without requesting permission yet
        // This will return true on Android/desktop where permission isn't needed
        const needsPermissionRequest = 
          // @ts-expect-error - DeviceMotionEvent.requestPermission only exists on iOS
          typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission;
        
        if (!needsPermissionRequest) {
          // Non-iOS: sensors available without explicit permission
          setSensorsAvailable(true);
          setSensorPermissionRequested(true);
          console.log('[PanoramaScanner] Sensors available (non-iOS)');
        } else {
          console.log('[PanoramaScanner] iOS detected - sensor permission requires user tap');
        }
        
        const stream = await requestCameraPermission();
        if (!mounted) {
          stream?.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (stream && videoRef.current) {
          streamRef.current = stream;
          videoRef.current.srcObject = stream;
          
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().then(() => {
              if (mounted) {
                setIsInitialized(true);
              }
            });
          };
        }
      } catch (err) {
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
      gyroTracker.current.stop();
    };
  }, []);
  
  // Request sensor permissions - MUST be called from user interaction (tap/click)
  const handleRequestSensorPermission = async () => {
    console.log('[PanoramaScanner] User tapped - requesting sensor permissions...');
    try {
      const motionPermission = await requestMotionPermission();
      const orientationPermission = await requestOrientationPermission();
      
      setSensorPermissionRequested(true);
      setSensorsAvailable(motionPermission && orientationPermission);
      
      if (motionPermission && orientationPermission) {
        console.log('[PanoramaScanner] ✅ iPhone sensors enabled!');
        // Start gyro tracker
        gyroTracker.current.start();
        setGyroTrackerActive(true);
      } else {
        console.warn('[PanoramaScanner] ❌ Sensor permission denied');
      }
    } catch (err) {
      console.error('[PanoramaScanner] Sensor permission error:', err);
      setSensorPermissionRequested(true);
      setSensorsAvailable(false);
    }
  };
  
  // Poll gyro tracker state for UI updates
  useEffect(() => {
    if (!gyroTrackerActive) return;
    
    const interval = setInterval(() => {
      const state = gyroTracker.current.getState();
      setCurrentRotation({
        yaw: state.yaw,
        pitch: state.pitch,
        roll: state.roll
      });
      // Debug log (remove after testing)
      if (state.isCalibrated) {
        console.log(`[GyroTracker UI] yaw=${state.yaw.toFixed(1)}° pitch=${state.pitch.toFixed(1)}° total=${state.totalRotation.toFixed(1)}°`);
      }
    }, 50); // Update 20 times per second
    
    return () => {
      clearInterval(interval);
    };
  }, [gyroTrackerActive]);

  // Auto-capture state
  const [autoCapture, setAutoCapture] = useState(true);
  const autoCaptureTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastAutoCaptureRef = useRef<number>(0);

  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || isCapturing || !currentInstruction) return;
    
    setIsCapturing(true);
    
    try {
      // Capture sensor data first (before any delay)
      let sensorData: iPhoneSensorData | null = null;
      if (sensorsAvailable) {
        sensorData = await captureSensorSnapshot();
        if (sensorData) {
          console.log('[PanoramaScanner] Captured sensor data:', {
            heading: sensorData.heading.magneticHeading.toFixed(1),
            pitch: (sensorData.attitude.pitch * 180 / Math.PI).toFixed(1),
            roll: (sensorData.attitude.roll * 180 / Math.PI).toFixed(1)
          });
        }
      }
      
      // SET ANCHOR ORIENTATION on first photo
      // This establishes the reference point for all subsequent rotation tracking
      if (!gyroTracker.current.getState().isCalibrated) {
        gyroTracker.current.setAnchor();
        setGyroTrackerActive(true);
        console.log('[PanoramaScanner] 📍 ANCHOR SET via gyro tracker');
        console.log('[PanoramaScanner] All subsequent targets are now relative to this position');
      }
      
      // Capture the image
      const imageData = captureFrameFromVideo(videoRef.current);
      
      // Estimate camera intrinsics from video dimensions
      const videoWidth = videoRef.current.videoWidth || 1920;
      const videoHeight = videoRef.current.videoHeight || 1080;
      const fov = 75; // Typical iPhone main camera FOV
      const focalLength = videoWidth / (2 * Math.tan((fov / 2) * Math.PI / 180));
      
      const cameraIntrinsics: CameraIntrinsics = {
        focalLengthX: focalLength,
        focalLengthY: focalLength,
        principalPointX: videoWidth / 2,
        principalPointY: videoHeight / 2,
        imageWidth: videoWidth,
        imageHeight: videoHeight
      };
      
      // Build camera pose from sensor data or from instruction
      let cameraPose = undefined;
      if (sensorData) {
        cameraPose = {
          position: { x: 0, y: 0, z: 0 },
          rotation: sensorData.attitude.quaternion,
          rotationMatrix: [], // Will be computed by backend
          confidence: 0.9,
          source: 'imu' as const
        };
      }
      
      // Store both the instruction azimuth and the actual captured azimuth
      // The instruction azimuth is the pattern target (0, 60, 120, etc.)
      // The actual azimuth is where the user really pointed (from gyro tracker)
      const gyroState = gyroTracker.current.getState();
      const actualRelativeAzimuth = gyroState.isCalibrated ? gyroState.yaw : currentInstruction.azimuth;
      
      const photo: PanoramaPhoto = {
        azimuth: currentInstruction.azimuth, // Pattern target
        elevation: currentInstruction.elevation,
        ringIndex: currentInstruction.ringIndex,
        photoIndex: currentInstruction.photoIndex,
        imageData: `data:image/jpeg;base64,${imageData}`,
        timestamp: Date.now(),
        type: currentInstruction.type,
        // Enhanced data for photogrammetry
        sensorData: sensorData || undefined,
        cameraIntrinsics,
        cameraPose,
        // Store the actual relative azimuth for accurate stitching
        actualAzimuth: actualRelativeAzimuth,
        anchorAlpha: 0 // Not needed with gyro tracker (always 0)
      };
      
      console.log(`[PanoramaScanner] Photo ${photos.length + 1} captured - Target: ${currentInstruction.azimuth}°, Actual relative: ${actualRelativeAzimuth.toFixed(1)}°`);
      
      setPhotos(prev => [...prev, photo]);
      setPreviewImage(photo.imageData);
      setShowPreview(true);
      
    } catch (err) {
      setError('Failed to capture photo. Please try again.');
    } finally {
      setIsCapturing(false);
    }
  }, [currentInstruction, isCapturing, sensorsAvailable, photos.length]);

  // Auto-capture effect - captures when orientation aligns with target
  // MUST be placed after capturePhoto is defined
  useEffect(() => {
    // Only auto-capture if:
    // - Auto-capture is enabled
    // - We have gyro tracker calibrated (not the first photo)
    // - We're not currently capturing or showing preview
    // - Sensors are available
    // - Current instruction is a ring (not zenith/nadir)
    const gyroState = gyroTracker.current.getState();
    if (!autoCapture || !gyroState.isCalibrated || isCapturing || showPreview || !sensorsAvailable || !currentInstruction) {
      return;
    }
    
    if (currentInstruction.type !== 'ring') {
      return; // Don't auto-capture zenith/nadir - user needs to position carefully
    }
    
    // Check if orientation is aligned with target
    const isAligned = isOrientationAligned(currentInstruction.azimuth, 15);
    
    // Also check elevation for non-zero elevation rings
    let elevationAligned = true;
    if (currentInstruction.elevation !== 0) {
      const elevationDiff = Math.abs(gyroState.pitch - currentInstruction.elevation);
      elevationAligned = elevationDiff <= 20;
    }
    
    if (isAligned && elevationAligned) {
      // Prevent rapid auto-captures - require at least 1.5 seconds between captures
      const now = Date.now();
      if (now - lastAutoCaptureRef.current < 1500) {
        return;
      }
      
      // Delay auto-capture slightly to ensure stable alignment
      if (!autoCaptureTimeoutRef.current) {
        autoCaptureTimeoutRef.current = setTimeout(() => {
          // Re-check alignment before capturing
          if (isOrientationAligned(currentInstruction.azimuth, 15)) {
            console.log('[PanoramaScanner] 🎯 Auto-capturing - orientation aligned!');
            lastAutoCaptureRef.current = Date.now();
            capturePhoto();
          }
          autoCaptureTimeoutRef.current = null;
        }, 500); // Half second delay for stable alignment
      }
    } else {
      // Clear pending auto-capture if user moves away from target
      if (autoCaptureTimeoutRef.current) {
        clearTimeout(autoCaptureTimeoutRef.current);
        autoCaptureTimeoutRef.current = null;
      }
    }
    
    return () => {
      if (autoCaptureTimeoutRef.current) {
        clearTimeout(autoCaptureTimeoutRef.current);
        autoCaptureTimeoutRef.current = null;
      }
    };
  }, [autoCapture, gyroTrackerActive, isCapturing, showPreview, sensorsAvailable, currentInstruction, isOrientationAligned, capturePhoto]);

  const retakePhoto = useCallback(() => {
    setPhotos(prev => prev.slice(0, -1));
    setShowPreview(false);
    setPreviewImage(null);
  }, []);

  const acceptPhoto = useCallback(() => {
    setShowPreview(false);
    setPreviewImage(null);
    
    // Check if we're done
    if (photos.length >= totalPhotos - 1) {
      // All photos captured!
      const allPhotos = [...photos];
      // Stop gyro tracker
      gyroTracker.current.stop();
      console.log('[PanoramaScanner] Scan complete - gyro tracker stopped');
      onComplete(allPhotos, roomName);
    } else {
      // Move to next instruction
      setCurrentInstructionIndex(prev => prev + 1);
    }
  }, [photos, totalPhotos, onComplete, roomName]);

  const handleCancel = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    // Stop gyro tracker
    gyroTracker.current.stop();
    console.log('[PanoramaScanner] Scan cancelled - gyro tracker stopped');
    onCancel();
  }, [onCancel]);

  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-center max-w-md mx-auto p-6">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h3 className="text-xl font-bold text-white mb-2">Camera Error</h3>
          <p className="text-white/70 mb-6">{error}</p>
          <button
            onClick={handleCancel}
            className="px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Camera feed */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 w-full h-full object-cover"
      />
      
      {/* Progress bar */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent">
        <div className="p-4">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={handleCancel}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="text-white font-medium">
              {photos.length} / {totalPhotos} photos
            </div>
          </div>
          <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          
          {/* Ring progress indicator */}
          <div className="mt-3 text-center">
            <div className="text-sm text-white/60">
              Ring {currentInstruction?.ringIndex + 1} of {CAPTURE_PATTERN_26.rings.length}
            </div>
            <div className="text-xs text-white/40 mt-1">
              {currentInstruction?.elevation === 90 ? 'Zenith' : 
               currentInstruction?.elevation === -90 ? 'Nadir' :
               `${currentInstruction?.elevation > 0 ? '+' : ''}${currentInstruction?.elevation}° elevation`}
            </div>
            {/* Sensor and auto-capture status */}
            <div className="text-xs mt-2 flex items-center justify-center gap-3">
              {!sensorPermissionRequested ? (
                <button
                  onClick={handleRequestSensorPermission}
                  className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1 animate-pulse"
                >
                  <span>📱</span>
                  <span>Tap to Enable Sensors</span>
                </button>
              ) : (
                <>
                  <div className={sensorsAvailable ? 'text-green-400' : 'text-yellow-400'}>
                    <span className={`inline-block w-2 h-2 rounded-full mr-1 ${sensorsAvailable ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
                    {sensorsAvailable ? 'Sensors' : 'No Sensors'}
                  </div>
                  {sensorsAvailable && (
                    <button
                      onClick={() => setAutoCapture(!autoCapture)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                        autoCapture 
                          ? 'bg-green-500/20 text-green-400 border border-green-500/50' 
                          : 'bg-white/10 text-white/60 border border-white/20'
                      }`}
                    >
                      {autoCapture ? '🎯 Auto-Capture ON' : '📸 Manual'}
                    </button>
                  )}
                </>
              )}
            </div>
            {/* Gyro tracker status */}
            {gyroTrackerActive && gyroTracker.current.getState().isCalibrated && (
              <div className="text-xs mt-1 text-green-400/70">
                📍 Gyro tracking active - {Math.round(currentRotation.yaw)}° from start
              </div>
            )}
            {/* Debug: Show gyro state even before calibration */}
            {sensorsAvailable && !gyroTracker.current.getState().isCalibrated && (
              <div className="text-xs mt-1 text-yellow-400/70">
                🔄 Gyro ready - Take first photo to set anchor
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Instructions overlay */}
      {!showPreview && currentInstruction && (
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/90 to-transparent p-6">
          {/* Debug: Gyro tracker status (top of instructions) */}
          {gyroTrackerActive && (
            <div className="text-center mb-3">
              <div className="inline-block bg-black/60 px-4 py-2 rounded-lg border border-green-400/30">
                <div className="text-xs text-green-400">
                  {gyroTracker.current.getState().isCalibrated ? (
                    <>
                      <span className="font-bold">📍 Gyro Active</span>
                      <span className="mx-2">|</span>
                      <span>Yaw: {Math.round(currentRotation.yaw)}°</span>
                      <span className="mx-2">|</span>
                      <span>Pitch: {Math.round(currentRotation.pitch)}°</span>
                      <span className="mx-2">|</span>
                      <span>Total: {Math.round(gyroTracker.current.getState().totalRotation)}°</span>
                    </>
                  ) : (
                    <span className="text-yellow-400">🔄 Waiting for first photo to set anchor...</span>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="max-w-2xl mx-auto">
            {/* Current instruction */}
            <div className="text-center mb-6">
              {/* Elevation indicator */}
              <div className="text-6xl mb-4">
                {currentInstruction.elevation === 90 ? '⬆️' :
                 currentInstruction.elevation === -90 ? '⬇️' :
                 currentInstruction.elevation > 0 ? '⤴️' :
                 currentInstruction.elevation < 0 ? '⤵️' :
                 '↻'}
              </div>
              
              {/* Azimuth/direction - Using ANCHOR-RELATIVE tracking */}
              {currentInstruction.type === 'ring' && (
                <div className="mb-4">
                  <div className="inline-block relative w-24 h-24">
                    {/* Compass background */}
                    <div className="absolute inset-0 border-4 border-white/30 rounded-full"></div>
                    {/* Start position indicator (where anchor was set) */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 text-green-400 text-xs font-bold">
                      {gyroTrackerActive && gyroTracker.current.getState().isCalibrated ? '📍' : 'N'}
                    </div>
                    {/* Target direction arrow (blue) - RELATIVE to anchor */}
                    <div 
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ transform: `rotate(${currentInstruction.azimuth}deg)` }}
                    >
                      <div className="w-1 h-10 bg-blue-500 rounded-full opacity-70">
                        {/* Arrow head */}
                        <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-b-[6px] border-b-blue-500"></div>
                      </div>
                    </div>
                    {/* Current phone direction (white - from gyro tracker) */}
                    {gyroTrackerActive && (
                      <div 
                        className="absolute inset-0 flex items-center justify-center transition-transform duration-100"
                        style={{ transform: `rotate(${currentRotation.yaw}deg)` }}
                      >
                        <div className={`w-1.5 h-10 rounded-full shadow-lg ${
                          isOrientationAligned(currentInstruction.azimuth, 20) 
                            ? 'bg-green-400 animate-pulse' 
                            : 'bg-white'
                        }`}></div>
                      </div>
                    )}
                    {/* Center dot */}
                    <div className="absolute top-1/2 left-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full"></div>
                    {/* Alignment indicator ring */}
                    {gyroTrackerActive && isOrientationAligned(currentInstruction.azimuth, 20) && (
                      <div className="absolute inset-0 border-4 border-green-400 rounded-full animate-pulse"></div>
                    )}
                  </div>
                  <div className="text-white/70 text-sm mt-2">
                    {!gyroTracker.current.getState().isCalibrated ? (
                      <span className="text-yellow-400">📍 First photo sets your starting point</span>
                    ) : gyroTrackerActive ? (
                      <>
                        <span className={isOrientationAligned(currentInstruction.azimuth, 20) ? 'text-green-400 font-bold' : 'text-white'}>
                          {Math.round(currentRotation.yaw)}°
                        </span>
                        <span className="text-white/50"> → </span>
                        <span className="text-blue-400">{currentInstruction.azimuth}°</span>
                        {isOrientationAligned(currentInstruction.azimuth, 20) && (
                          <span className="text-green-400 ml-2">✓ Aligned!</span>
                        )}
                      </>
                    ) : (
                      `Rotate ${currentInstruction.azimuth}° from start`
                    )}
                  </div>
                  {/* Tilt indicator for elevation */}
                  {gyroTrackerActive && currentInstruction.elevation !== 0 && (
                    <div className="text-white/50 text-xs mt-1">
                      Tilt: {Math.round(currentRotation.pitch)}° 
                      <span className="text-white/30"> (target: {currentInstruction.elevation}°)</span>
                    </div>
                  )}
                  {/* Rotation guidance */}
                  {gyroTrackerActive && gyroTracker.current.getState().isCalibrated && !isOrientationAligned(currentInstruction.azimuth, 20) && (
                    <div className="text-xs mt-2">
                      {(() => {
                        const guidance = gyroTracker.current.getRotationToTarget(currentInstruction.azimuth);
                        if (guidance.direction === 'aligned') return null;
                        return (
                          <span className="text-blue-400">
                            {guidance.direction === 'right' ? '↻' : '↺'} Rotate {guidance.direction} {Math.round(guidance.degrees)}°
                          </span>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              
              <h2 className="text-2xl font-bold text-white mb-2">
                {currentInstruction.instruction}
              </h2>
              <p className="text-white/70 text-lg">
                Photo {photos.length + 1} of {totalPhotos}
              </p>
            </div>

            {/* Capture button */}
            <button
              onClick={capturePhoto}
              disabled={!isInitialized || isCapturing}
              className="w-20 h-20 mx-auto block rounded-full bg-white border-4 border-blue-500 hover:scale-110 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>
        </div>
      )}

      {/* Preview overlay */}
      {showPreview && previewImage && (
        <div className="absolute inset-0 bg-black/95 z-20 flex items-center justify-center p-4">
          <div className="max-w-4xl w-full">
            <img 
              src={previewImage} 
              alt="Preview"
              className="w-full h-auto rounded-lg mb-6"
            />
            <div className="flex gap-4 justify-center">
              <button
                onClick={retakePhoto}
                className="px-8 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
              >
                Retake
              </button>
              <button
                onClick={acceptPhoto}
                className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition-colors"
              >
                {photos.length >= totalPhotos - 1 ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PanoramaScanner;
