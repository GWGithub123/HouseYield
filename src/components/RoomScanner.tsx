/**
 * Room Scanner Component
 * Full 3D room scanning interface with camera capture, AI guidance, and 3D reconstruction
 * Now uses ZoeDepth for metric depth estimation and room dimension calculation
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ScanSession,
  ScannerConfig,
  DeviceOrientation,
  ScannerState,
  Model3DResult,
  CapturedFrame,
  RoomDimensions
} from '../types/roomScanner';
import {
  createScanSession,
  createCapturedFrame,
  getScanningGuidance,
  calculateCoverage,
  speakGuidance,
  stopSpeaking,
  requestOrientationPermission,
  requestCameraPermission,
  captureFrameFromVideo,
  prepareFramesForViewer,
  saveRoomScan,
  DEFAULT_SCANNER_CONFIG,
  isIOS,
  isMobile,
  calculateRelativeAlpha,
  getSectorFromAngle,
  getSectorName,
  getNextRecommendedSector,
  calculateCoveredSectors
} from '../services/roomScannerService';
import { GyroRotationTracker } from '../services/gyroRotationTracker';

// Lazy load the viewers to reduce initial bundle size
const Model3DViewer = React.lazy(() => import('./Model3DViewer'));
const ImmersiveRoomViewer = React.lazy(() => import('./ImmersiveRoomViewer'));

// VERSION MARKER - visible on screen to confirm cache is cleared
// Update this timestamp when making changes to force cache refresh on mobile
const BUILD_VERSION = "v2025-12-02_20:00_REAL_DEPTH";

interface RoomScannerProps {
  propertyId?: string;
  roomName?: string;
  onComplete?: (model: Model3DResult) => void;
  onCancel?: () => void;
}

const RoomScanner: React.FC<RoomScannerProps> = ({
  propertyId,
  roomName = 'Room Scan',
  onComplete,
  onCancel
}) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const orientationRef = useRef<DeviceOrientation>({ alpha: 0, beta: 0, gamma: 0, absolute: false });
  const anchorOrientationRef = useRef<DeviceOrientation | null>(null); // First photo's orientation as anchor
  const gyroTrackerRef = useRef<GyroRotationTracker | null>(null);
  const anchorYawRef = useRef<number>(0); // Gyro yaw at anchor point
  const lastSpokenMessageRef = useRef<string>('');
  const lastGuidanceTimeRef = useRef<number>(0);

  // State
  const [config] = useState<ScannerConfig>(DEFAULT_SCANNER_CONFIG);
  const [session, setSession] = useState<ScanSession | null>(null);
  const [state, setState] = useState<ScannerState>({
    isInitialized: false,
    isScanning: false,
    isPaused: false,
    isProcessing: false,
    currentGuidance: null,
    frameCount: 0,
    coverage: 0,
    error: null,
    model: null
  });
  const [showPermissionPrompt, setShowPermissionPrompt] = useState(true);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [currentOrientation, setCurrentOrientation] = useState<DeviceOrientation>({ alpha: 0, beta: 0, gamma: 0, absolute: false });
  const [videoReady, setVideoReady] = useState(false);
  
  // Immersive viewer state
  const [showImmersiveViewer, setShowImmersiveViewer] = useState(false);
  const [viewerFrames, setViewerFrames] = useState<CapturedFrame[]>([]);
  const [processingProgress, setProcessingProgress] = useState({ percent: 0, message: '' });
  const [roomDimensions, setRoomDimensions] = useState<RoomDimensions | null>(null);
  const [debugInfo, setDebugInfo] = useState({ metricDepthCount: 0, dimensionsCalculated: false });

  // Version check on mount - force reload if cached version
  React.useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch('/api/room-scanner/version', {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        const data = await response.json();
        
        if (data.version !== BUILD_VERSION) {
          console.warn('[RoomScanner] Version mismatch detected!');
          console.warn(`  Loaded: ${BUILD_VERSION}`);
          console.warn(`  Server: ${data.version}`);
          console.warn('  Forcing reload to clear cache...');
          
          // Clear all caches and force reload
          if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
          }
          
          // Hard reload bypassing cache
          window.location.reload();
        } else {
          console.log('[RoomScanner] Version check passed:', BUILD_VERSION);
        }
      } catch (error) {
        console.warn('[RoomScanner] Version check failed:', error);
      }
    };
    
    checkVersion();
  }, []);

  // Initialize scanner
  const initialize = async () => {
    try {
      // Request orientation permission (iOS)
      const orientationGranted = await requestOrientationPermission();
      if (!orientationGranted) {
        throw new Error('Orientation permission denied');
      }

      // Request camera permission
      const stream = await requestCameraPermission();
      if (!stream) {
        throw new Error('Camera permission denied');
      }

      streamRef.current = stream;

      // Create scan session
      const newSession = createScanSession(roomName, propertyId);
      setSession(newSession);

      // Set up orientation listener
      window.addEventListener('deviceorientation', handleOrientation);

      // Initialize gyro rotation tracker for accurate horizontal tracking when phone is upright
      gyroTrackerRef.current = new GyroRotationTracker();
      gyroTrackerRef.current.start();
      console.log('[RoomScanner] Gyro tracker initialized for upright phone tracking');

      setState(prev => ({
        ...prev,
        isInitialized: true,
        error: null
      }));

      // Hide permission prompt - this will render the video element
      setShowPermissionPrompt(false);

      // Announce ready
      if (config.enableVoiceGuidance) {
        speakGuidance('Scanner ready. Tap Start to begin scanning the room.');
      }
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        error: error.message || 'Failed to initialize scanner'
      }));
    }
  };

  // Connect stream to video element when video ref becomes available
  useEffect(() => {
    if (streamRef.current && videoRef.current && !videoReady) {
      console.log('[RoomScanner] Connecting stream to video element');
      videoRef.current.srcObject = streamRef.current;
      
      // Wait for video to be ready
      videoRef.current.onloadedmetadata = () => {
        console.log('[RoomScanner] Video metadata loaded, playing...');
        videoRef.current?.play().then(() => {
          console.log('[RoomScanner] Video is now playing');
          setVideoReady(true);
        }).catch(err => {
          console.error('[RoomScanner] Video play error:', err);
        });
      };
      
      // Handle video playing event
      videoRef.current.onplaying = () => {
        console.log('[RoomScanner] Video onplaying event fired');
        setVideoReady(true);
      };
      
      // Also try to play immediately
      videoRef.current.play().then(() => {
        console.log('[RoomScanner] Video playing');
        setVideoReady(true);
      }).catch(playErr => {
        console.warn('[RoomScanner] Initial play failed, waiting for metadata:', playErr);
      });
    }
  }, [showPermissionPrompt, videoReady]); // Run when permission prompt hides (video renders)

  // Handle device orientation updates
  const handleOrientation = useCallback((event: DeviceOrientationEvent) => {
    // Get gyro-based yaw if available (works correctly when phone is upright)
    let effectiveAlpha = event.alpha || 0;
    if (gyroTrackerRef.current) {
      const gyroState = gyroTrackerRef.current.getState();
      if (gyroState.isCalibrated) {
        // Use gyro yaw + anchor for effective alpha
        effectiveAlpha = (anchorYawRef.current + gyroState.yaw) % 360;
      }
    }
    
    const newOrientation = {
      alpha: effectiveAlpha,
      beta: event.beta || 0,
      gamma: event.gamma || 0,
      absolute: event.absolute
    };
    orientationRef.current = newOrientation;
    setCurrentOrientation(newOrientation);
  }, []);

  // Start scanning
  const startScanning = () => {
    if (!state.isInitialized || !session) return;

    setState(prev => ({ ...prev, isScanning: true, isPaused: false }));

    if (config.enableVoiceGuidance) {
      speakGuidance('Scanning started. Slowly pan around the room.');
    }

    // Start auto-capture interval
    if (config.autoCapture) {
      captureIntervalRef.current = setInterval(() => {
        captureFrame();
      }, config.captureInterval);
    }

    // Update session status
    setSession(prev => prev ? { ...prev, status: 'scanning' } : null);
  };

  // Pause scanning
  const pauseScanning = () => {
    setState(prev => ({ ...prev, isPaused: true }));

    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }

    if (config.enableVoiceGuidance) {
      speakGuidance('Scanning paused.');
    }
  };

  // Resume scanning
  const resumeScanning = () => {
    setState(prev => ({ ...prev, isPaused: false }));

    if (config.autoCapture) {
      captureIntervalRef.current = setInterval(() => {
        captureFrame();
      }, config.captureInterval);
    }

    if (config.enableVoiceGuidance) {
      speakGuidance('Scanning resumed.');
    }
  };

  // Capture a single frame
  const captureFrame = async () => {
    if (!videoRef.current || !session || state.isPaused) return;

    try {
      // Capture image from video
      const imageData = captureFrameFromVideo(videoRef.current);
      const currentOrientation = { ...orientationRef.current };

      // Set anchor orientation on first frame capture
      // This becomes the reference point for all subsequent rotation tracking
      if (!anchorOrientationRef.current) {
        anchorOrientationRef.current = currentOrientation;
        
        // Set gyro tracker anchor for accurate upright phone tracking
        if (gyroTrackerRef.current) {
          gyroTrackerRef.current.setAnchor();
          anchorYawRef.current = currentOrientation.alpha;
          console.log('[RoomScanner] Anchor set - Gyro tracker calibrated at alpha:', currentOrientation.alpha);
        } else {
          console.log('[RoomScanner] Anchor orientation set (no gyro):', currentOrientation);
        }
        
        if (config.enableVoiceGuidance) {
          speakGuidance('Starting position recorded. Now slowly rotate around the room.');
        }
      }

      // Create frame object
      const frame = createCapturedFrame(imageData, currentOrientation);

      // Calculate relative rotation from anchor for debugging
      const relativeAlpha = calculateRelativeAlpha(
        currentOrientation.alpha,
        anchorOrientationRef.current.alpha
      );
      const currentSector = getSectorFromAngle(relativeAlpha);
      
      // Log gyro state for debugging upright tracking
      let gyroDebug = '';
      if (gyroTrackerRef.current) {
        const gyroState = gyroTrackerRef.current.getState();
        gyroDebug = ` | Gyro yaw: ${gyroState.yaw.toFixed(1)}°, pitch: ${gyroState.pitch.toFixed(1)}°`;
      }
      
      console.log(`[RoomScanner] Frame captured - Relative rotation: ${relativeAlpha.toFixed(1)}°, Sector: ${getSectorName(currentSector)}${gyroDebug}`);

      // Add to session with anchor-relative coverage calculation
      setSession(prev => {
        if (!prev) return null;
        const newFrames = [...prev.frames, frame];
        // Pass anchor orientation to calculateCoverage for relative tracking
        const newCoverage = calculateCoverage(newFrames, anchorOrientationRef.current || undefined);
        return { 
          ...prev, 
          frames: newFrames, 
          coverage: newCoverage,
          anchorOrientation: anchorOrientationRef.current || undefined
        };
      });

      // Update state
      setState(prev => ({
        ...prev,
        frameCount: prev.frameCount + 1,
        coverage: session.coverage.percentage
      }));

      // Get AI guidance (throttled)
      if (session.frames.length % 5 === 0) {
        const guidance = await getScanningGuidance(
          imageData,
          session.frames,
          session.coverage
        );

        setState(prev => ({ ...prev, currentGuidance: guidance }));

        // Speak guidance only if message changed and enough time passed (5 seconds min)
        const now = Date.now();
        const timeSinceLastGuidance = now - lastGuidanceTimeRef.current;
        const isDifferentMessage = guidance.message !== lastSpokenMessageRef.current;
        
        if (config.enableVoiceGuidance && guidance.priority !== 'low' && isDifferentMessage && timeSinceLastGuidance > 5000) {
          speakGuidance(guidance.message);
          lastSpokenMessageRef.current = guidance.message;
          lastGuidanceTimeRef.current = now;
        }

        // Check for completion
        if (guidance.command === 'scan_complete') {
          finishScanning();
        }
      }

      // Check max frames
      if (session.frames.length >= config.maxFrames) {
        finishScanning();
      }
    } catch (error) {
      console.error('Frame capture error:', error);
    }
  };

  // Finish scanning and process for immersive viewer
  const finishScanning = async () => {
    // IMMEDIATE alert to confirm function is called
    alert(`🎬 finishScanning() called! Frames: ${session?.frames.length || 0}, Min needed: ${config.minFrames}`);
    
    if (!session || session.frames.length < config.minFrames) {
      if (config.enableVoiceGuidance) {
        speakGuidance(`Need at least ${config.minFrames} frames. Keep scanning.`);
      }
      alert(`❌ Not enough frames: ${session?.frames.length || 0}/${config.minFrames}`);
      return;
    }

    // Stop capture
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }

    setState(prev => ({
      ...prev,
      isScanning: false,
      isProcessing: true
    }));

    setSession(prev => prev ? { ...prev, status: 'processing' } : null);

    // VERSION CHECK - This message proves you have the latest code
    console.log('[RoomScanner] ✅ VERSION 2025-12-02 11:30 - Metric depth + completion modal enabled');
    alert('Processing scan v2025-12-02 11:30 - If you see this, cache is cleared!');

    if (config.enableVoiceGuidance) {
      speakGuidance('Scan complete. Processing for immersive viewing. This may take a minute.');
    }

    try {
      console.log('[RoomScanner] 🚀 Starting frame processing with ZoeDepth...');
      console.log('[RoomScanner] Total frames to process:', session.frames.length);
      
      // Prepare frames for immersive viewer with ZoeDepth metric depth processing
      const result = await prepareFramesForViewer(
        session.frames,
        24, // Process up to 24 key frames with depth
        (progress, message) => {
          console.log(`[RoomScanner] Progress: ${progress}% - ${message}`);
          setProcessingProgress({ percent: progress, message });
        },
        true // Use ZoeDepth for metric depth
      );

      console.log('[RoomScanner] 🎉 prepareFramesForViewer completed!');
      console.log('[RoomScanner] Result object:', JSON.stringify({
        frameCount: result.frames.length,
        hasRoomDimensions: !!result.roomDimensions,
        metricDepthCount: result.metricDepthCount
      }, null, 2));

      const { frames: processedFrames, roomDimensions: calculatedDimensions, metricDepthCount } = result;
      
      // Update debug info
      setDebugInfo({ metricDepthCount, dimensionsCalculated: !!calculatedDimensions });
      
      console.log(`[RoomScanner] 📊 Processing complete: ${processedFrames.length} frames, ${metricDepthCount} with metric depth`);
      
      if (calculatedDimensions) {
        console.log('[RoomScanner] ✅ Room dimensions calculated:', {
          width: `${calculatedDimensions.widthFeet.toFixed(1)} ft`,
          length: `${calculatedDimensions.lengthFeet.toFixed(1)} ft`,
          height: `${calculatedDimensions.heightFeet.toFixed(1)} ft`,
          floorArea: `${calculatedDimensions.floorAreaSqFt} sq ft`,
          confidence: `${(calculatedDimensions.confidence * 100).toFixed(0)}%`
        });
        console.log('[RoomScanner] 🎯 About to call setRoomDimensions...');
        setRoomDimensions(calculatedDimensions);
        console.log('[RoomScanner] ✅ setRoomDimensions called successfully');
      } else {
        console.warn('[RoomScanner] ⚠️ NO room dimensions calculated! metricDepthCount:', metricDepthCount);
      }

      if (processedFrames.length > 0) {
        setViewerFrames(processedFrames);
        
        // AUTO-SAVE to backend so it appears on desktop
        setProcessingProgress({ percent: 95, message: 'Saving to cloud...' });
        
        const saveResult = await saveRoomScan(roomName, processedFrames, {
          propertyId,
          thumbnailImage: processedFrames[0]?.imageData,
          // Include room dimensions in metadata for renovation cost estimation
          metadata: calculatedDimensions ? {
            roomDimensions: calculatedDimensions,
            metricDepthFrameCount: metricDepthCount
          } : undefined
        });
        
        if (saveResult.success) {
          console.log('[RoomScanner] Scan auto-saved with ID:', saveResult.scanId);
          if (config.enableVoiceGuidance) {
            const dimensionMsg = calculatedDimensions 
              ? ` Room measures approximately ${Math.round(calculatedDimensions.floorAreaSqFt)} square feet.`
              : '';
            speakGuidance(`Room saved! You can view it on your computer now.${dimensionMsg}`);
          }
        } else {
          console.warn('[RoomScanner] Auto-save failed:', saveResult.error);
        }
        
        // CRITICAL: Set isProcessing to false FIRST, then show modal
        // The component checks isProcessing before rendering the modal
        console.log('[RoomScanner] 🎬 Setting isProcessing to false...');
        setState(prev => ({
          ...prev,
          isProcessing: false
        }));

        setSession(prev => prev ? {
          ...prev,
          status: 'complete',
          completedAt: new Date()
        } : null);

        console.log('[RoomScanner] 🎭 About to show completion modal...');
        console.log('[RoomScanner] Current roomDimensions state:', roomDimensions);
        console.log('[RoomScanner] Calculated dimensions:', calculatedDimensions);
        
        // CRITICAL DEBUG: Alert to confirm this code is reached
        alert(`DEBUG: Processing complete! isProcessing will be false. Modal will show in 100ms. Dimensions: ${calculatedDimensions ? 'YES' : 'NO'}`);
        
        // Use setTimeout to ensure state update completes before showing modal
        setTimeout(() => {
          console.log('[RoomScanner] 🎭 Showing completion modal NOW');
          alert('DEBUG: About to call setShowCompleteModal(true)');
          setShowCompleteModal(true);
          console.log('[RoomScanner] ✅ setShowCompleteModal(true) called');
          alert(`DEBUG: setShowCompleteModal called. Check if modal is visible now!`);
        }, 100);

        if (config.enableVoiceGuidance && !saveResult.success) {
          speakGuidance('Room ready! Drag to look around.');
        }
      } else {
        throw new Error('Failed to process frames for viewer');
      }
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        isProcessing: false,
        error: error.message || 'Processing failed'
      }));

      if (config.enableVoiceGuidance) {
        speakGuidance('Processing failed. Please try again.');
      }
    }
  };

  // Cancel and cleanup
  const cancel = () => {
    cleanup();
    onCancel?.();
  };

  // Cleanup resources
  const cleanup = () => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    // Stop gyro tracker
    if (gyroTrackerRef.current) {
      gyroTrackerRef.current.stop();
      gyroTrackerRef.current = null;
    }

    window.removeEventListener('deviceorientation', handleOrientation);
    stopSpeaking();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, []);

  // Render guidance arrow
  const renderGuidanceArrow = () => {
    const guidance = state.currentGuidance;
    if (!guidance?.visualGuide) return null;

    const { type, position, direction, color = 'white', size = 60 } = guidance.visualGuide;
    const left = `${position.x * 100}%`;
    const top = `${position.y * 100}%`;

    // Arrow type - directional guidance
    if (type === 'arrow') {
      const rotation = direction || 0;
      return (
        <div
          className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left, top }}
        >
          <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: `rotate(${rotation}deg)`, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
            className="animate-pulse"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </div>
      );
    }

    // Highlight type - area to focus on
    if (type === 'highlight') {
      return (
        <div
          className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left, top }}
        >
          <div 
            className="rounded-full border-4 border-yellow-400 animate-ping"
            style={{ 
              width: size, 
              height: size, 
              boxShadow: '0 0 20px rgba(250, 204, 21, 0.5)' 
            }}
          />
          <div 
            className="absolute inset-0 rounded-full border-2 border-yellow-400"
            style={{ width: size, height: size }}
          />
        </div>
      );
    }

    // Boundary type - edge of scan area
    if (type === 'boundary') {
      return (
        <div
          className="absolute pointer-events-none"
          style={{ left: 0, top: 0, right: 0, bottom: 0 }}
        >
          <div className="absolute inset-4 border-4 border-dashed border-orange-400/50 rounded-xl animate-pulse" />
          <div 
            className="absolute transform -translate-x-1/2 -translate-y-1/2"
            style={{ left, top }}
          >
            <div className="bg-orange-500 text-white text-xs px-2 py-1 rounded-full">
              Edge of scan area
            </div>
          </div>
        </div>
      );
    }

    // Target type - specific point to capture
    if (type === 'target') {
      return (
        <div
          className="absolute transform -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left, top }}
        >
          <div className="relative" style={{ width: size, height: size }}>
            {/* Outer ring */}
            <div className="absolute inset-0 rounded-full border-4 border-green-400 animate-pulse" />
            {/* Cross hairs */}
            <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-green-400 transform -translate-y-1/2" />
            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-green-400 transform -translate-x-1/2" />
            {/* Center dot */}
            <div className="absolute top-1/2 left-1/2 w-3 h-3 bg-green-400 rounded-full transform -translate-x-1/2 -translate-y-1/2" />
          </div>
        </div>
      );
    }

    return null;
  };

  // Render mini compass showing device orientation and scanned areas
  const renderMiniCompass = () => {
    if (!state.isScanning) return null;

    const compassRotation = -currentOrientation.alpha;
    const tiltIndicator = currentOrientation.beta;
    
    // Determine which sectors are scanned based on session coverage
    const scannedDirections = new Set(
      session?.coverage.scannedAreas.map(a => a.direction) || []
    );

    return (
      <div className="absolute top-20 right-4 w-16 h-16 pointer-events-none z-10">
        <div className="relative w-full h-full">
          {/* Compass background */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm rounded-full" />
          
          {/* Scanned sectors */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100">
            {/* North sector */}
            <path
              d="M 50 50 L 50 10 A 40 40 0 0 1 85 30 Z"
              fill={scannedDirections.has('north') ? 'rgba(74, 222, 128, 0.4)' : 'transparent'}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
            />
            {/* East sector */}
            <path
              d="M 50 50 L 85 30 A 40 40 0 0 1 85 70 Z"
              fill={scannedDirections.has('east') ? 'rgba(74, 222, 128, 0.4)' : 'transparent'}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
            />
            {/* South sector */}
            <path
              d="M 50 50 L 85 70 A 40 40 0 0 1 15 70 Z"
              fill={scannedDirections.has('south') ? 'rgba(74, 222, 128, 0.4)' : 'transparent'}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
            />
            {/* West sector */}
            <path
              d="M 50 50 L 15 70 A 40 40 0 0 1 50 10 Z"
              fill={scannedDirections.has('west') ? 'rgba(74, 222, 128, 0.4)' : 'transparent'}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
            />
            
            {/* Up indicator */}
            <circle 
              cx="50" cy="10" r="4"
              fill={scannedDirections.has('up') ? 'rgb(74, 222, 128)' : 'rgba(255,255,255,0.3)'}
            />
            {/* Down indicator */}
            <circle 
              cx="50" cy="90" r="4"
              fill={scannedDirections.has('down') ? 'rgb(74, 222, 128)' : 'rgba(255,255,255,0.3)'}
            />
          </svg>

          {/* Compass needle (points to current direction) */}
          <div 
            className="absolute inset-0 flex items-center justify-center"
            style={{ transform: `rotate(${compassRotation}deg)` }}
          >
            <div className="w-1 h-6 bg-red-500 rounded-full transform -translate-y-1" />
          </div>

          {/* Tilt indicator bar */}
          <div className="absolute -bottom-3 left-0 right-0 h-1 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-blue-400 transition-all duration-100"
              style={{ 
                width: '20%',
                marginLeft: `${Math.max(0, Math.min(80, 40 + tiltIndicator))}%`
              }}
            />
          </div>

          {/* Center dot */}
          <div className="absolute top-1/2 left-1/2 w-2 h-2 bg-white rounded-full transform -translate-x-1/2 -translate-y-1/2" />
        </div>
      </div>
    );
  };

  // Check if HTTPS is required but not available
  const needsHttps = isMobile && window.location.protocol !== 'https:' && 
    !window.location.hostname.includes('localhost') && 
    !window.location.hostname.includes('127.0.0.1');

  // Permission prompt screen
  if (showPermissionPrompt) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex flex-col items-center justify-center p-6 z-50">
        {/* VERSION v3 INDICATOR - HUGE RED BANNER */}
        <div className="absolute top-0 left-0 right-0 bg-red-600 text-white p-4 text-center z-[9999] border-b-4 border-yellow-400">
          <div className="text-3xl font-black">🔴 VERSION v3 LOADED! 🔴</div>
          <div className="text-sm mt-1">Permission Screen - Cache Cleared Successfully</div>
        </div>
        
        {/* VERSION BADGE - REMOVE AFTER TESTING */}
        <div className="absolute top-20 right-4 bg-red-600 text-white px-3 py-1 rounded-full text-xs font-bold">
          {BUILD_VERSION}
        </div>
        
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          
          <h2 className="text-2xl font-bold text-gray-900 mb-4">3D Room Scanner</h2>
          
          {/* Version Display - helps confirm cache is cleared */}
          <div className="mb-4 text-xs text-gray-400 font-mono">
            {BUILD_VERSION}
          </div>
          
          {/* HTTPS Warning for mobile */}
          {needsHttps && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-lg mb-6 text-left">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <p className="font-medium text-sm">HTTPS Required for Camera</p>
                  <p className="text-xs mt-1">Mobile devices require HTTPS to access camera. Please use the ngrok tunnel URL to scan rooms on your iPhone.</p>
                </div>
              </div>
            </div>
          )}

          {/* iOS-specific instructions */}
          {isIOS && (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 p-3 rounded-lg mb-6 text-left text-sm">
              <p className="font-medium">📱 iPhone Tips:</p>
              <ul className="text-xs mt-1 space-y-1 list-disc list-inside">
                <li>Hold phone in landscape for best results</li>
                <li>Move slowly to avoid blur</li>
                <li>Ensure good lighting</li>
              </ul>
            </div>
          )}

          <p className="text-gray-600 mb-6">
            Scan your room to create an interactive 3D model. We'll need access to your camera and motion sensors.
          </p>

          <div className="space-y-3 text-left mb-8">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-500 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-gray-700">Camera access for room capture</span>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-500 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-gray-700">Motion sensors for orientation tracking</span>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-500 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-gray-700">Voice guidance (optional)</span>
            </div>
          </div>

          {state.error && (
            <div className="bg-red-50 text-red-700 p-3 rounded-lg mb-4 text-sm">
              {state.error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={cancel}
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={initialize}
              className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              Enable Camera
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Processing screen
  if (state.isProcessing) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex flex-col items-center justify-center p-6 z-50">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 mx-auto mb-6 relative">
            <div className="absolute inset-0 border-4 border-blue-200 rounded-full"></div>
            <div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div>
          </div>
          
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Analyzing with ZoeDepth</h2>
          
          <p className="text-gray-600 mb-4">
            Processing {session?.frames.length || 0} frames with AI depth estimation...
          </p>

          {/* Progress bar */}
          {processingProgress.percent > 0 && (
            <div className="mb-4">
              <div className="bg-gray-200 rounded-full h-3 overflow-hidden mb-2">
                <div 
                  className="bg-blue-600 h-full transition-all duration-300"
                  style={{ width: `${processingProgress.percent}%` }}
                ></div>
              </div>
              <p className="text-sm text-gray-500">{processingProgress.message}</p>
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
            <p className="font-medium mb-1">🔬 Computing metric depth maps</p>
            <p className="text-xs">This calculates actual room dimensions in feet/meters</p>
          </div>
        </div>
      </div>
    );
  }

  // Completion modal with 3D viewer
  if (showCompleteModal && state.model) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50">
        <React.Suspense fallback={
          <div className="w-full h-full flex items-center justify-center text-white">
            <div className="text-center">
              <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p>Loading 3D Viewer...</p>
            </div>
          </div>
        }>
          <Model3DViewer
            modelUrl={state.model.modelUrl}
            onClose={() => {
              setShowCompleteModal(false);
              onComplete?.(state.model!);
            }}
          />
        </React.Suspense>
      </div>
    );
  }

  // Main scanning interface
  return (
    <div className="fixed inset-0 z-50 overflow-hidden" style={{ backgroundColor: '#000' }}>
      {/* Camera feed - positioned to fill container */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ 
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          zIndex: 1
        }}
      />
      
      {/* Debug: Show message if video not playing */}
      {!videoReady && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2,
          backgroundColor: 'rgba(17, 24, 39, 0.9)'
        }}>
          <div className="text-white text-center p-4">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-lg font-semibold">Starting camera...</p>
            <p className="text-sm opacity-70 mt-2">Please allow camera access if prompted</p>
          </div>
        </div>
      )}

      {/* Scanning overlay - above video */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}>
        {/* Corner guides */}
        <div className="absolute top-8 left-8 w-16 h-16 border-l-4 border-t-4 border-white opacity-50"></div>
        <div className="absolute top-8 right-8 w-16 h-16 border-r-4 border-t-4 border-white opacity-50"></div>
        <div className="absolute bottom-32 left-8 w-16 h-16 border-l-4 border-b-4 border-white opacity-50"></div>
        <div className="absolute bottom-32 right-8 w-16 h-16 border-r-4 border-b-4 border-white opacity-50"></div>

        {/* Guidance arrow/visual guide */}
        {renderGuidanceArrow()}
        
        {/* Mini compass showing orientation and scanned areas */}
        {renderMiniCompass()}
      </div>

      {/* DEBUG OVERLAY - Fixed at top - VERSION v3 RED */}
      <div className="absolute top-0 left-0 right-0 bg-red-600 text-white p-3 text-sm font-bold z-[9999] border-b-4 border-yellow-400" style={{ position: 'fixed' }}>
        <div className="text-center">
          <div className="text-2xl font-black mb-2">🔴 VERSION v3 LOADED! 🔴</div>
          <div className="text-lg">Modal: {showCompleteModal ? '✅ TRUE' : '❌ FALSE'} | Dims: {roomDimensions ? '✅ SET' : '❌ NULL'} | Frames: {session?.frames.length || 0}</div>
          <div className="text-sm">MetricDepth: {debugInfo.metricDepthCount} | DimCalc: {debugInfo.dimensionsCalculated ? '✅' : '❌'} | Status: {session?.status || 'none'}</div>
        </div>
      </div>

      {/* Top bar */}
      <div className="absolute top-16 left-0 right-0 p-4 bg-gradient-to-b from-black/70 to-transparent" style={{ zIndex: 20 }}>
        <div className="flex items-center justify-between">
          <button
            onClick={cancel}
            className="p-2 rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors pointer-events-auto"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="text-white text-center">
            <div className="text-sm opacity-80">Scanning</div>
            <div className="font-semibold">{roomName}</div>
          </div>

          <div className="w-10"></div>
        </div>
      </div>

      {/* Progress bar with detailed coverage */}
      <div className="absolute top-36 left-4 right-4" style={{ zIndex: 20 }}>
        {/* Main progress bar */}
        <div className="bg-white/20 rounded-full h-2 overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              (session?.coverage.percentage || 0) >= 85 ? 'bg-green-500' :
              (session?.coverage.percentage || 0) >= 50 ? 'bg-yellow-500' : 'bg-blue-500'
            }`}
            style={{ width: `${session?.coverage.percentage || 0}%` }}
          ></div>
        </div>
        
        {/* Stats row */}
        <div className="flex justify-between mt-2 text-white text-sm">
          <span>{Math.round(session?.coverage.percentage || 0)}% Complete</span>
          <span>{session?.frames.length || 0} frames</span>
        </div>

        {/* Detailed coverage info */}
        {state.isScanning && session?.coverage && (
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Gyro tracking status */}
            {gyroTrackerRef.current && (() => {
              const gyroState = gyroTrackerRef.current.getState();
              return gyroState.isCalibrated && (
                <div className="bg-blue-500/20 backdrop-blur-sm px-3 py-1 rounded-full text-xs text-blue-200">
                  📱 Gyro: {gyroState.yaw.toFixed(0)}° | Pitch: {gyroState.pitch.toFixed(0)}°
                </div>
              );
            })()}
            
            {/* Estimated time remaining */}
            {session.coverage.estimatedTimeRemaining > 0 && (
              <div className="bg-white/10 backdrop-blur-sm px-3 py-1 rounded-full text-xs text-white/80">
                ⏱️ ~{Math.ceil(session.coverage.estimatedTimeRemaining)}s remaining
              </div>
            )}
            
            {/* Missing areas indicator */}
            {session.coverage.missingAreas.length > 0 && (
              <div className="bg-orange-500/20 backdrop-blur-sm px-3 py-1 rounded-full text-xs text-orange-200">
                📍 Missing: {session.coverage.missingAreas.slice(0, 2).join(', ')}
                {session.coverage.missingAreas.length > 2 && ` +${session.coverage.missingAreas.length - 2}`}
              </div>
            )}

            {/* Scanned areas count */}
            {session.coverage.scannedAreas.length > 0 && (
              <div className="bg-green-500/20 backdrop-blur-sm px-3 py-1 rounded-full text-xs text-green-200">
                ✓ {session.coverage.scannedAreas.length} areas captured
              </div>
            )}
          </div>
        )}
      </div>

      {/* Guidance panel */}
      {state.currentGuidance && (
        <div className="absolute top-36 left-4 right-4">
          <div className="bg-black/60 backdrop-blur-sm rounded-xl p-4 text-white">
            <div className="flex items-center gap-3">
              {/* Command icon - handles all 16 ScanCommand types */}
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                state.currentGuidance.priority === 'high' ? 'bg-red-500/30' :
                state.currentGuidance.priority === 'medium' ? 'bg-yellow-500/30' : 'bg-white/20'
              }`}>
                {/* Direction commands */}
                {state.currentGuidance.command === 'turn_left' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                )}
                {state.currentGuidance.command === 'turn_right' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                )}
                {state.currentGuidance.command === 'look_up' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
                {state.currentGuidance.command === 'look_down' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                )}
                {/* Movement commands */}
                {state.currentGuidance.command === 'move_forward' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    <circle cx="12" cy="19" r="2" fill="currentColor" />
                  </svg>
                )}
                {state.currentGuidance.command === 'move_back' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    <circle cx="12" cy="5" r="2" fill="currentColor" />
                  </svg>
                )}
                {state.currentGuidance.command === 'get_closer' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
                  </svg>
                )}
                {state.currentGuidance.command === 'step_back' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
                  </svg>
                )}
                {/* State commands */}
                {state.currentGuidance.command === 'hold_steady' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    <circle cx="12" cy="12" r="3" fill="currentColor" />
                  </svg>
                )}
                {state.currentGuidance.command === 'scan_corner' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h6v6H4V4zM14 4h6v6h-6V4zM4 14h6v6H4v-6z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 14l6 6" />
                  </svg>
                )}
                {state.currentGuidance.command === 'capture_detail' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
                {/* Speed commands */}
                {state.currentGuidance.command === 'slow_down' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {state.currentGuidance.command === 'speed_up' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                {/* Environment commands */}
                {state.currentGuidance.command === 'improve_lighting' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                )}
                {state.currentGuidance.command === 'reduce_motion' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                )}
                {/* Completion */}
                {state.currentGuidance.command === 'scan_complete' && (
                  <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <p className="text-lg">{state.currentGuidance.message}</p>
                {state.currentGuidance.confidence < 0.7 && (
                  <p className="text-xs text-white/60 mt-1">Confidence: {Math.round(state.currentGuidance.confidence * 100)}%</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/70 to-transparent" style={{ zIndex: 20 }}>
        <div className="flex items-center justify-center gap-6">
          {!state.isScanning ? (
            <button
              onClick={startScanning}
              className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition-transform"
            >
              <svg className="w-10 h-10 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          ) : (
            <>
              <button
                onClick={state.isPaused ? resumeScanning : pauseScanning}
                className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center text-white hover:bg-white/30 transition-colors"
              >
                {state.isPaused ? (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => captureFrame()}
                className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-lg border-4 border-white hover:scale-105 transition-transform"
              >
                <div className="w-16 h-16 bg-red-500 rounded-full"></div>
              </button>

              <button
                onClick={() => {
                  alert(`Green button tapped! Frames: ${session?.frames.length}, Min: ${config.minFrames}`);
                  finishScanning();
                }}
                disabled={(session?.frames.length || 0) < config.minFrames}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
                  (session?.frames.length || 0) >= config.minFrames
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'bg-white/20 text-white/50 cursor-not-allowed'
                }`}
              >
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Instructions */}
        {!state.isScanning && (
          <p className="text-white text-center mt-4 opacity-80">
            Tap the play button to start scanning
          </p>
        )}
      </div>

      {/* Error toast */}
      {state.error && (
        <div className="absolute bottom-32 left-4 right-4 bg-red-500 text-white p-4 rounded-xl">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>{state.error}</p>
          </div>
        </div>
      )}

      {/* Processing overlay with progress */}
      {state.isProcessing && (
        <div className="absolute inset-0 bg-black/90 flex items-center justify-center" style={{ zIndex: 100 }}>
          <div className="text-center p-8 max-w-md">
            <div className="relative w-24 h-24 mx-auto mb-6">
              {/* Circular progress */}
              <svg className="w-24 h-24 transform -rotate-90">
                <circle
                  cx="48"
                  cy="48"
                  r="40"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  className="text-white/20"
                />
                <circle
                  cx="48"
                  cy="48"
                  r="40"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  className="text-blue-500"
                  strokeDasharray={251.2}
                  strokeDashoffset={251.2 - (251.2 * processingProgress.percent) / 100}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold text-white">{processingProgress.percent}%</span>
              </div>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Processing Room Scan</h3>
            <p className="text-white/70">{processingProgress.message || 'Analyzing depth and preparing immersive view...'}</p>
          </div>
        </div>
      )}

      {/* Immersive Room Viewer */}
      {showImmersiveViewer && viewerFrames.length > 0 && (
        <React.Suspense fallback={
          <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
            <div className="text-white text-center">
              <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p>Loading immersive viewer...</p>
            </div>
          </div>
        }>
          <ImmersiveRoomViewer
            frames={viewerFrames}
            roomName={roomName}
            onClose={() => {
              setShowImmersiveViewer(false);
              setShowCompleteModal(true);
            }}
            autoRotate={false}
            showMinimap={true}
            enableGyroscope={isMobile}
          />
        </React.Suspense>
      )}

      {/* Scan Complete Modal */}
      {showCompleteModal && !showImmersiveViewer && (
        <div className="absolute inset-0 bg-black/90 flex items-center justify-center" style={{ zIndex: 100 }}>
          <div className="bg-gray-900 rounded-2xl p-6 max-w-sm w-full mx-4">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-white mb-2">Scan Complete!</h3>
              <p className="text-white/70">{session?.frames.length || 0} frames captured</p>
            </div>
            
            {/* Debug Info Panel */}
            <div className="mb-4 p-3 bg-yellow-900/30 rounded-xl border border-yellow-500/30 text-xs">
              <div className="text-yellow-300 font-medium mb-2">🐛 Debug Info:</div>
              <div className="text-white/70 space-y-1">
                <div>showCompleteModal: {showCompleteModal ? '✅ TRUE' : '❌ FALSE'}</div>
                <div>roomDimensions: {roomDimensions ? '✅ SET' : '❌ NULL'}</div>
                <div>metricDepthCount: {debugInfo.metricDepthCount}</div>
                <div>dimensionsCalculated: {debugInfo.dimensionsCalculated ? '✅ TRUE' : '❌ FALSE'}</div>
              </div>
            </div>
            
            {/* Room Dimensions (from ZoeDepth metric depth) */}
            {roomDimensions && (
              <div className="mb-4 p-4 bg-blue-900/30 rounded-xl border border-blue-500/30">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                  <span className="text-sm font-medium text-blue-300">Room Dimensions (ZoeDepth)</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="text-white/70">
                    Size: <span className="text-white font-medium">
                      {roomDimensions.widthFeet.toFixed(1)}' × {roomDimensions.lengthFeet.toFixed(1)}'
                    </span>
                  </div>
                  <div className="text-white/70">
                    Height: <span className="text-white font-medium">{roomDimensions.heightFeet.toFixed(1)}'</span>
                  </div>
                  <div className="text-white/70">
                    Floor: <span className="text-white font-medium">{roomDimensions.floorAreaSqFt} sq ft</span>
                  </div>
                  <div className="text-white/70">
                    Walls: <span className="text-white font-medium">{roomDimensions.wallAreaSqFt} sq ft</span>
                  </div>
                </div>
                <div className="mt-2 text-xs text-white/50">
                  Confidence: {(roomDimensions.confidence * 100).toFixed(0)}% • {roomDimensions.estimatedAccuracy}
                </div>
              </div>
            )}
            
            <div className="space-y-3">
              <button
                onClick={() => {
                  setShowCompleteModal(false);
                  setShowImmersiveViewer(true);
                }}
                className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                View Immersive Room
              </button>
              
              <div className="flex items-center gap-2 py-2 px-3 bg-green-500/20 rounded-lg">
                <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-green-300">Automatically saved to your computer</span>
              </div>
              
              <button
                onClick={() => {
                  setShowCompleteModal(false);
                  onCancel?.();
                }}
                className="w-full py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RoomScanner;
