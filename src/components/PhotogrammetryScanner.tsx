/**
 * Photogrammetry Scanner Component
 * 
 * Unified capture UI for mobile room scanning with two scan purposes:
 * 
 * 1. FULL 3D MODEL (full-3d):
 *    - Walk-around photogrammetry capture for geometric 3D reconstruction
 *    - High photo count with smart auto-capture every ~10° rotation
 *    - AR tracking, coverage guidance, quality metrics
 *    - Outputs PhotogrammetryScan → backend pipeline → 3D mesh
 * 
 * 2. AI RENOVATION ANALYSIS (ai-renovation):
 *    - Quick capture (~6-12 photos) for AI-powered renovation assessment
 *    - Real-time GPT-4V frame analysis identifying renovation opportunities
 *    - AI focus requests, voice guidance, object measurement
 *    - Same sensor suite (gyro, position, quality) as full 3D mode
 *    - Outputs RenovationScanSession → cost estimates, ROI, preview rendering
 * 
 * Users toggle between modes before starting capture. Both modes share the
 * same camera, sensor, quality, and position tracking infrastructure.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Camera, 
  X, 
  Play, 
  Pause, 
  Check, 
  Move,
  Map as MapIcon,
  Settings,
  Zap,
  Clock,
  Ruler,
  RotateCw,
  AlertCircle,
  CheckCircle2,
  Smartphone,
  Sparkles,
  Eye,
  Target,
  Volume2,
  VolumeX,
  ToggleLeft,
  ToggleRight,
  Box,
  Paintbrush,
} from 'lucide-react';
import { requestCameraPermission, captureFrameFromVideo } from '../services/roomScannerService';
import { requestMotionPermission, requestOrientationPermission } from '../services/sensorFusionService';
import { getContinuousCapture, ContinuousCaptureService } from '../services/continuousCaptureService';
import { getPositionTracker, PositionTrackingService } from '../services/positionTrackingService';
import { getCoverageTracker, CoverageTrackingService } from '../services/coverageTrackingService';
import { getImageQualityService, type QualityMetrics } from '../services/imageQualityService';
import { getARTracking, ARTrackingService, type ARPose } from '../services/arTrackingService';
import {
  initLiveRenovationAI,
  analyzeFrame,
  completeFocusRequest,
  skipFocusRequest,
  resetLiveRenovationAI,
} from '../services/liveRenovationAIService';
import {
  initMeasurementService,
  measureObject,
  getAllMeasurements,
  resetMeasurements,
} from '../services/renovationMeasurementService';
import {
  PhotogrammetryPhoto,
  PhotogrammetryScan,
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
  CoverageReport,
  Vector3,
  generateId,
  ARTrackingMetadata,
} from '../types/photogrammetry';
import {
  RenovationScanSession,
  RenovationCapture,
  AIGuidanceMessage,
  FocusRequest,
  CaptureTag,
} from '../types/liveRenovation';
import { PathVisualization, CoverageMap, CaptureGuidance, QualityMeter } from './photogrammetry';

// =============================================================================
// SCAN PURPOSE - Toggle between full 3D model vs quick AI renovation analysis
// =============================================================================

export type ScanPurpose = 'full-3d' | 'ai-renovation';
export type Full3DPipelineVersion = 'v1' | 'hybrid_v1' | 'master_v1';
export type Full3DCaptureMode = 'image_sequence' | 'room_tour';

const AI_ANALYSIS_INTERVAL = 2500; // ms between AI frame analyses
const MIN_AI_CAPTURES = 6;
const RECOMMENDED_AI_CAPTURES = 12;
const AI_AUTO_CAPTURE_ROTATION = 25; // degrees

// =============================================================================
// PROPS
// =============================================================================

interface PhotogrammetryScannerProps {
  roomName?: string;
  propertyId?: string;
  onComplete: (scan: PhotogrammetryScan) => void;
  onCancel: () => void;
  // AI Renovation mode props
  initialPurpose?: ScanPurpose;
  initialPipelineVersion?: Full3DPipelineVersion;
  initialCaptureMode?: Full3DCaptureMode;
  roomType?: 'kitchen' | 'bathroom' | 'bedroom' | 'living_room' | 'basement' | 'other';
  address?: string;
  zipCode?: string;
  onRenovationComplete?: (session: RenovationScanSession) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

const PhotogrammetryScanner: React.FC<PhotogrammetryScannerProps> = ({
  roomName = 'Room',
  propertyId,
  onComplete,
  onCancel,
  initialPurpose = 'full-3d',
  initialPipelineVersion = 'master_v1',
  initialCaptureMode = 'room_tour',
  roomType = 'other',
  address,
  zipCode,
  onRenovationComplete,
}) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Services
  const continuousCaptureRef = useRef<ContinuousCaptureService>(getContinuousCapture());
  const positionTrackerRef = useRef<PositionTrackingService>(getPositionTracker());
  const coverageTrackerRef = useRef<CoverageTrackingService>(getCoverageTracker());
  const qualityServiceRef = useRef(getImageQualityService());
  const arTrackingRef = useRef<ARTrackingService>(getARTracking());
  
  // State - Initialization
  const [isInitialized, setIsInitialized] = useState(false);
  const [_sensorsAvailable, setSensorsAvailable] = useState(false);
  const [sensorPermissionRequested, setSensorPermissionRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // State - AR Tracking (Pipeline v2)
  const [arSupported, setArSupported] = useState(false);
  const [arActive, setArActive] = useState(false);
  const [arPhotosCount, setArPhotosCount] = useState(0);
  const [currentArPose, setCurrentArPose] = useState<ARPose | null>(null);
  
  // State - Capture
  const [isCapturing, setIsCapturing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [photos, setPhotos] = useState<PhotogrammetryPhoto[]>([]);
  const [_lastCaptureTime, setLastCaptureTime] = useState<number>(0);
  
  // State - Quality (2026 Smart Capture)
  const [qualityMetrics, setQualityMetrics] = useState<QualityMetrics | null>(null);
  const [stability, setStability] = useState(0);
  const [rejectedFrames, setRejectedFrames] = useState(0);
  
  // State - Tracking
  const [currentPosition, setCurrentPosition] = useState<Vector3>({ x: 0, y: 0, z: 0 });
  const [currentYaw, setCurrentYaw] = useState(0);
  const [currentPitch, setCurrentPitch] = useState(0);
  const [distanceTraveled, setDistanceTraveled] = useState(0);
  const [positionHistory, setPositionHistory] = useState<Vector3[]>([]);
  const [rotationSpeed, setRotationSpeed] = useState(0); // degrees per second
  const lastYawRef = useRef(0);
  const lastYawTimeRef = useRef(Date.now());
  
  // State - Coverage
  const [coverageReport, setCoverageReport] = useState<CoverageReport | null>(null);
  const [showCoverageMap, setShowCoverageMap] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  
  // State - Config
  const [captureConfig, setCaptureConfig] = useState<CaptureConfig>(DEFAULT_CAPTURE_CONFIG);
  const [showSettings, setShowSettings] = useState(false);
  
  // State - Flash effect
  const [showFlash, setShowFlash] = useState(false);
  
  // ==========================================================================
  // SCAN PURPOSE STATE - Toggle between full 3D and AI renovation analysis
  // ==========================================================================
  const [scanPurpose, setScanPurpose] = useState<ScanPurpose>(initialPurpose);
  const [full3DPipelineVersion, setFull3DPipelineVersion] = useState<Full3DPipelineVersion>(initialPipelineVersion);
  const [full3DCaptureMode, setFull3DCaptureMode] = useState<Full3DCaptureMode>(
    initialCaptureMode === 'image_sequence' ? 'image_sequence' : 'room_tour',
  );
  const [showLegacyPipelines, setShowLegacyPipelines] = useState(initialPipelineVersion !== 'master_v1');
  
  // AI Renovation state (only active when scanPurpose === 'ai-renovation')
  const [aiActive, setAiActive] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [aiAnalysisCount, setAiAnalysisCount] = useState(0);
  const [currentGuidance, setCurrentGuidance] = useState<AIGuidanceMessage | null>(null);
  const [currentFocusRequest, setCurrentFocusRequest] = useState<FocusRequest | null>(null);
  const [detectedItems, setDetectedItems] = useState<string[]>([]);
  const [recentAIObservation, setRecentAIObservation] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [renovationCaptures, setRenovationCaptures] = useState<RenovationCapture[]>([]);
  const analysisIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastAIAutoCaptureYawRef = useRef<number>(0);
  const lastAIAutoCaptureTimeRef = useRef<number>(0);
  
  const isAIMode = scanPurpose === 'ai-renovation';
  const isFullMode = scanPurpose === 'full-3d';
  
  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================
  
  // Initialize camera
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      try {
        // Check if we need permission for sensors (iOS)
        const needsPermissionRequest = 
          // @ts-expect-error - DeviceMotionEvent.requestPermission only exists on iOS
          typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission;
        
        if (!needsPermissionRequest) {
          setSensorsAvailable(true);
          setSensorPermissionRequested(true);
        }
        
        // Get camera stream
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
        
        // Initialize AR tracking (Pipeline v2)
        // This runs alongside camera, doesn't replace it
        const arService = arTrackingRef.current;
        const arIsSupported = await arService.checkSupport();
        if (mounted) {
          setArSupported(arIsSupported);
          console.log(`[PhotogrammetryScanner] AR supported: ${arIsSupported}`);
        }
        
        // Initialize AI Renovation services if in AI mode
        if (scanPurpose === 'ai-renovation') {
          initLiveRenovationAI({
            onGuidance: (msg) => setCurrentGuidance(msg),
            onFocusRequest: (req) => setCurrentFocusRequest(req),
            onCaptureTriggered: (tag, reason) => {
              console.log('[PhotogrammetryScanner/AI] AI triggered capture:', tag, reason);
              captureRenovationPhoto(tag);
            },
          });
          setAiActive(true);
          initMeasurementService('');
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
      if (analysisIntervalRef.current) {
        clearInterval(analysisIntervalRef.current);
      }
      resetLiveRenovationAI();
      resetMeasurements();
    };
  }, [scanPurpose]);
  
  // Request sensor permissions (must be from user interaction)
  const handleRequestSensorPermission = async () => {
    console.log('[PhotogrammetryScanner] Requesting sensor permissions...');
    try {
      const motionPermission = await requestMotionPermission();
      const orientationPermission = await requestOrientationPermission();
      
      setSensorPermissionRequested(true);
      setSensorsAvailable(motionPermission && orientationPermission);
      
      if (motionPermission && orientationPermission) {
        console.log('[PhotogrammetryScanner] ✅ Sensors enabled!');
      } else {
        console.warn('[PhotogrammetryScanner] ⚠️ Some sensors unavailable');
      }
    } catch (err) {
      console.error('[PhotogrammetryScanner] Sensor permission error:', err);
      setSensorPermissionRequested(true);
      setSensorsAvailable(false);
    }
  };
  
  // ===========================================================================
  // CAPTURE FUNCTIONS
  // ===========================================================================
  
  // Start capture session
  const startCapture = useCallback(async () => {
    console.log('[PhotogrammetryScanner] Starting capture...');
    
    // Start AR tracking if supported (Pipeline v2)
    if (arSupported) {
      const arService = arTrackingRef.current;
      const arStarted = await arService.start();
      setArActive(arStarted);
      
      if (arStarted) {
        console.log('[PhotogrammetryScanner] ✅ AR tracking started (metric poses enabled)');
        
        // Set up AR pose update callback
        arService.setOnPoseUpdate((pose) => {
          setCurrentArPose(pose);
        });
        
        arService.setOnTrackingLost(() => {
          console.warn('[PhotogrammetryScanner] ⚠️ AR tracking lost');
        });
        
        arService.setOnTrackingRestored(() => {
          console.log('[PhotogrammetryScanner] ✅ AR tracking restored');
        });
      } else {
        console.log('[PhotogrammetryScanner] AR start failed, using IMU only');
      }
    }
    
    // Set up capture function with AR pose capture
    continuousCaptureRef.current.setCaptureFunction(async () => {
      if (!videoRef.current) {
        throw new Error('Video not available');
      }
      
      const imageData = captureFrameFromVideo(videoRef.current);
      
      // Capture AR pose at this moment (Pipeline v2)
      const arPose = arTrackingRef.current.getCurrentPose();
      
      // Show flash effect
      setShowFlash(true);
      setTimeout(() => setShowFlash(false), 100);
      
      // Return extended data for photo creation
      return {
        imageData,
        arPose: arPose ? {
          position: arPose.position,
          rotation: arPose.rotation,
          confidence: arPose.confidence,
          timestamp: arPose.timestamp,
        } : undefined,
        hasARPose: arPose !== null,
      };
    });
    
    // Set up callbacks - now handles AR pose data
    continuousCaptureRef.current.setOnCapture((event) => {
      // Enrich photo with AR pose if available
      const photo: PhotogrammetryPhoto = {
        ...event.photo,
        arPose: event.arPose,
        hasARPose: event.hasARPose ?? false,
      };
      
      setPhotos(prev => [...prev, photo]);
      setLastCaptureTime(Date.now());
      
      // Track AR photo count
      if (event.hasARPose) {
        setArPhotosCount(prev => prev + 1);
      }
    });
    
    // Set up position tracking callbacks
    positionTrackerRef.current.setOnUpdate((state) => {
      setCurrentPosition(state.position);
      
      // Calculate rotation speed
      const now = Date.now();
      const timeDelta = (now - lastYawTimeRef.current) / 1000; // seconds
      const yawDelta = Math.abs(state.yaw - lastYawRef.current);
      const speed = timeDelta > 0 ? yawDelta / timeDelta : 0;
      
      setCurrentYaw(state.yaw);
      setCurrentPitch(state.pitch);
      setDistanceTraveled(state.distanceTraveled);
      setRotationSpeed(speed);
      
      lastYawRef.current = state.yaw;
      lastYawTimeRef.current = now;
    });
    
    // Set up coverage tracking callbacks
    coverageTrackerRef.current.setOnCoverageUpdate((report) => {
      setCoverageReport(report);
    });
    
    // Set up quality tracking callbacks (2026 Smart Capture)
    continuousCaptureRef.current.setOnQualityUpdate((metrics) => {
      setQualityMetrics(metrics);
      setStability(qualityServiceRef.current.getStability());
    });
    
    // Connect video element for quality analysis
    if (videoRef.current) {
      continuousCaptureRef.current.setVideoElement(videoRef.current);
    }
    
    // Start continuous capture with smart mode enabled by default
    const smartConfig = {
      ...captureConfig,
      mode: 'smart' as const,  // Enable quality-aware smart capture
    };
    continuousCaptureRef.current.setConfig(smartConfig);
    continuousCaptureRef.current.start();
    
    setIsCapturing(true);
    setIsPaused(false);
  }, [captureConfig]);
  
  // Pause/resume capture
  const togglePause = useCallback(() => {
    if (isPaused) {
      continuousCaptureRef.current.resumeAutoCapture();
      setIsPaused(false);
    } else {
      continuousCaptureRef.current.pauseAutoCapture();
      setIsPaused(true);
    }
  }, [isPaused]);
  
  // Manual capture
  const manualCapture = useCallback(async () => {
    const photo = await continuousCaptureRef.current.manualCapture();
    if (photo) {
      setPhotos(prev => [...prev, photo]);
      setLastCaptureTime(Date.now());
      
      // Flash effect
      setShowFlash(true);
      setTimeout(() => setShowFlash(false), 100);
    }
  }, []);
  
  // Complete capture and process
  const finishCapture = useCallback(async () => {
    console.log('[PhotogrammetryScanner] Finishing capture...');
    
    continuousCaptureRef.current.stop();
    
    // Stop AR tracking and get stats (Pipeline v2)
    const arService = arTrackingRef.current;
    const arStats = arService.getStats();
    const arState = arService.getState();
    await arService.stop();
    
    // Build AR tracking metadata
    const arTracking: ARTrackingMetadata = {
      wasAvailable: arSupported,
      wasActive: arActive,
      photosWithAR: arPhotosCount,
      totalPhotos: photos.length,
      trackingQuality: arState.trackingQuality === 'normal' ? 'high' :
                       arState.trackingQuality === 'limited' ? 'medium' : 
                       arPhotosCount > 0 ? 'low' : 'unavailable',
      planesDetected: arStats.planesDetected,
      sessionDuration: arStats.sessionDuration,
    };
    
    const scan: PhotogrammetryScan = {
      id: generateId(),
      name: roomName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      photos: photos,
      clusters: coverageTrackerRef.current.getPositionClusters(),
      pathLength: distanceTraveled,
      captureTime: photos.length > 0 
        ? (Date.now() - photos[0].timestamp) / 1000 
        : 0,
      status: 'uploading',
      processingProgress: {
        phase: 'uploading',
        percent: 0,
        message: 'Preparing upload...',
      },
      propertyId,
      roomName,
      arTracking,
      pipelineVersion: isFullMode ? full3DPipelineVersion : 'v1',
      captureMode: isFullMode ? full3DCaptureMode : undefined,
    };
    
    console.log(`[PhotogrammetryScanner] Scan complete:`, {
      photos: photos.length,
      photosWithAR: arPhotosCount,
      pipelineVersion: scan.pipelineVersion,
      captureMode: scan.captureMode,
    });
    
    onComplete(scan);
  }, [photos, distanceTraveled, roomName, propertyId, onComplete, arSupported, arActive, arPhotosCount, isFullMode, full3DPipelineVersion]);
  
  // Cancel capture
  const handleCancel = useCallback(async () => {
    continuousCaptureRef.current.stop();
    await arTrackingRef.current.stop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
    }
    resetLiveRenovationAI();
    resetMeasurements();
    onCancel();
  }, [onCancel]);
  
  // ===========================================================================
  // AI RENOVATION ANALYSIS FUNCTIONS (active when scanPurpose === 'ai-renovation')
  // ===========================================================================
  
  // Capture a photo specifically for AI renovation analysis
  const captureRenovationPhoto = useCallback(async (tag?: CaptureTag) => {
    if (!videoRef.current) return null;
    
    try {
      const imageData = captureFrameFromVideo(videoRef.current);
      const quality = qualityMetrics || {
        sharpness: 0.8, blur: 0.1, brightness: 0.7, contrast: 0.7,
        featureCount: 100, overall: 0.8, isAcceptable: true, overallScore: 80,
      };
      
      setShowFlash(true);
      setTimeout(() => setShowFlash(false), 100);
      
      const capture: RenovationCapture = {
        id: `capture_${Date.now()}`,
        imageData,
        timestamp: Date.now(),
        position: { ...currentPosition },
        orientation: { pitch: currentPitch, yaw: currentYaw, roll: 0 },
        qualityMetrics: quality,
        tag: tag || 'general',
        trigger: currentFocusRequest ? 'ai_request' : 'manual',
        focusRequest: currentFocusRequest || undefined,
      };
      
      // Handle focus request measurement
      if (currentFocusRequest && tag === currentFocusRequest.suggestedTag) {
        try {
          await measureObject(imageData, tag, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, 1080, 1920);
          completeFocusRequest(currentFocusRequest.id, capture.id);
          setCurrentFocusRequest(null);
        } catch (measureErr) {
          console.warn('[PhotogrammetryScanner/AI] Measurement failed:', measureErr);
        }
      }
      
      setRenovationCaptures(prev => [...prev, capture]);
      return capture;
    } catch (err) {
      console.error('[PhotogrammetryScanner/AI] Capture error:', err);
      return null;
    }
  }, [qualityMetrics, currentPosition, currentPitch, currentYaw, currentFocusRequest]);
  
  // Run AI frame analysis
  const runAIAnalysis = useCallback(async () => {
    if (!videoRef.current || !aiActive || aiAnalyzing || isPaused) return;
    
    setAiAnalyzing(true);
    
    try {
      const frameData = captureFrameFromVideo(videoRef.current);
      const result = await analyzeFrame(frameData, renovationCaptures.length, coverageReport?.overallCoverage || 0);
      
      setAiAnalysisCount(prev => prev + 1);
      
      if (result?.success) {
        if (result.guidance?.message) {
          setCurrentGuidance(result.guidance);
          setRecentAIObservation(result.guidance.message);
          setTimeout(() => setRecentAIObservation(null), 5000);
        }
        
        if (result.newFocusRequests?.length) {
          setCurrentFocusRequest(result.newFocusRequests[0]);
        }
        
        if (result.observations?.length) {
          setDetectedItems(prev => Array.from(new Set([...prev, ...result.observations])));
        }
        
        if (result.triggerCapture && result.captureTag && !currentFocusRequest) {
          await captureRenovationPhoto(result.captureTag);
        }
      }
    } catch (err) {
      console.error('[PhotogrammetryScanner/AI] Analysis error:', err);
    } finally {
      setAiAnalyzing(false);
    }
  }, [aiActive, aiAnalyzing, isPaused, renovationCaptures.length, coverageReport, currentFocusRequest, captureRenovationPhoto]);
  
  // AI analysis loop ref
  const runAIAnalysisRef = useRef(runAIAnalysis);
  runAIAnalysisRef.current = runAIAnalysis;
  
  // Start/stop AI analysis loop
  useEffect(() => {
    if (isCapturing && isAIMode && aiActive && !isPaused) {
      const initialTimeout = setTimeout(() => runAIAnalysisRef.current(), 1500);
      analysisIntervalRef.current = setInterval(() => runAIAnalysisRef.current(), AI_ANALYSIS_INTERVAL);
      
      return () => {
        clearTimeout(initialTimeout);
        if (analysisIntervalRef.current) {
          clearInterval(analysisIntervalRef.current);
          analysisIntervalRef.current = null;
        }
      };
    } else if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
      analysisIntervalRef.current = null;
    }
  }, [isCapturing, isAIMode, aiActive, isPaused]);
  
  // AI auto-capture based on rotation
  useEffect(() => {
    if (!isCapturing || isPaused || !isAIMode) return;
    
    const now = Date.now();
    const timeSinceLastCapture = now - lastAIAutoCaptureTimeRef.current;
    const yawDelta = Math.abs(currentYaw - lastAIAutoCaptureYawRef.current);
    const normalizedYawDelta = yawDelta > 180 ? 360 - yawDelta : yawDelta;
    const qualityOk = qualityMetrics ? qualityMetrics.overallScore >= 60 : true;
    
    if (normalizedYawDelta >= AI_AUTO_CAPTURE_ROTATION && timeSinceLastCapture >= 1500 && qualityOk) {
      captureRenovationPhoto('general');
      lastAIAutoCaptureYawRef.current = currentYaw;
      lastAIAutoCaptureTimeRef.current = now;
    }
  }, [currentYaw, isCapturing, isPaused, isAIMode, qualityMetrics, captureRenovationPhoto]);
  
  // Finish AI renovation scan
  const finishRenovationScan = useCallback(async () => {
    console.log('[PhotogrammetryScanner/AI] Finishing renovation scan...');
    
    continuousCaptureRef.current.stop();
    await arTrackingRef.current.stop();
    if (analysisIntervalRef.current) clearInterval(analysisIntervalRef.current);
    
    const measurements = getAllMeasurements();
    
    const session: RenovationScanSession = {
      id: `session_${Date.now()}`,
      roomName,
      roomType,
      propertyId,
      address,
      zipCode,
      startedAt: renovationCaptures[0]?.timestamp || Date.now(),
      completedAt: Date.now(),
      captures: renovationCaptures,
      roomMeasurements: measurements.room || undefined,
      objectMeasurements: measurements.objects,
      aiGuidanceHistory: [],
      coveragePercent: coverageReport?.overallCoverage || 0,
      status: 'processing',
    };
    
    if (onRenovationComplete) {
      onRenovationComplete(session);
    }
  }, [renovationCaptures, roomName, roomType, propertyId, address, zipCode, coverageReport, onRenovationComplete]);
  
  // Skip focus request
  const skipCurrentFocus = useCallback(() => {
    if (currentFocusRequest) {
      skipFocusRequest(currentFocusRequest.id);
      setCurrentFocusRequest(null);
    }
  }, [currentFocusRequest]);
  
  // Update position history periodically
  useEffect(() => {
    if (!isCapturing) return;
    
    const interval = setInterval(() => {
      const history = positionTrackerRef.current.getPositionHistory();
      setPositionHistory(history);
    }, 500);
    
    return () => clearInterval(interval);
  }, [isCapturing]);
  
  // ===========================================================================
  // RENDER HELPERS
  // ===========================================================================
  
  const getCaptureModeName = (mode: string) => {
    switch (mode) {
      case 'smart': return 'Smart';
      case 'time': return 'Timed';
      case 'distance': return 'Distance';
      case 'rotation': return 'Rotation';
      case 'manual': return 'Manual';
      default: return mode;
    }
  };
  
  const getCoverageBadgeColor = (coverage: number) => {
    if (coverage >= 85) return 'bg-green-500';
    if (coverage >= 70) return 'bg-yellow-500';
    if (coverage >= 50) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const selectedPipelineSummary = full3DPipelineVersion === 'master_v1'
    ? full3DCaptureMode === 'room_tour'
      ? {
          title: 'Master v1 Gaussian Splat',
          detail: 'Runs room-tour capture on the canonical master_v1 stack with Gaussian splat as the primary output and mesh as a sidecar.',
        }
      : {
          title: 'Master v1 Dense Mesh',
          detail: 'Runs image-sequence capture on master_v1 for a dense mesh-first output. Use this when you specifically need the dense reconstruction path.',
        }
    : full3DPipelineVersion === 'v1'
      ? {
          title: 'Standard Mesh',
          detail: 'Runs the updated legacy photogrammetry path on the master-v1 VM, with Fast3R priors first and Metric3D fallback for low-texture walls and ceilings.',
        }
      : {
          title: 'Legacy Hybrid Mesh + Splat',
          detail: 'Older comparison path that keeps gaussian sidecar artifacts. Use only if you specifically want the legacy hybrid output.',
        };
  
  // ===========================================================================
  // RENDER
  // ===========================================================================
  
  // Error state
  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="bg-red-900/50 text-red-200 p-6 rounded-lg max-w-sm text-center">
          <AlertCircle className="w-12 h-12 mx-auto mb-4" />
          <p>{error}</p>
          <button
            onClick={handleCancel}
            className="mt-4 px-4 py-2 bg-red-600 rounded-lg"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/70 to-transparent p-4">
        <div className="flex items-center justify-between">
          <button
            onClick={handleCancel}
            className="p-2 rounded-full bg-black/50 text-white"
          >
            <X className="w-6 h-6" />
          </button>
          
          <div className="text-center">
            <h2 className="text-white font-semibold">{roomName}</h2>
            <p className="text-white/70 text-sm flex items-center justify-center gap-1.5">
              {isAIMode ? (
                <><Sparkles className="w-3.5 h-3.5 text-purple-400" /> AI Renovation Analysis</>
              ) : (
                <><Box className="w-3.5 h-3.5 text-blue-400" /> 3D Photogrammetry Scan</>
              )}
            </p>
          </div>
          
          <div className="flex items-center gap-1">
            {isAIMode && (
              <button
                onClick={() => setVoiceEnabled(!voiceEnabled)}
                className="p-2 rounded-full bg-black/50 text-white"
              >
                {voiceEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5 text-gray-400" />}
              </button>
            )}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-full bg-black/50 text-white"
            >
              <Settings className="w-6 h-6" />
            </button>
          </div>
        </div>
        
        {/* Stats bar */}
        {isCapturing && (
          <div className="flex items-center justify-center gap-4 mt-3 text-white/80 text-sm">
            <div className="flex items-center gap-1">
              <Camera className="w-4 h-4" />
              <span>{isAIMode ? renovationCaptures.length : photos.length}</span>
            </div>
            <div className="flex items-center gap-1">
              <Ruler className="w-4 h-4" />
              <span>{(distanceTraveled * 3.28084).toFixed(1)} ft</span>
            </div>
            <div className="flex items-center gap-1">
              <RotateCw className="w-4 h-4" />
              <span>{currentYaw.toFixed(0)}°</span>
            </div>
            {/* AI Status when in renovation mode */}
            {isAIMode && aiActive && (
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${
                aiAnalyzing ? 'bg-purple-600' : 'bg-purple-500/70'
              }`}>
                <Eye className={`w-3 h-3 ${aiAnalyzing ? 'animate-pulse' : ''}`} />
                <span>AI</span>
              </div>
            )}
            {/* AR Status Indicator (Pipeline v2) */}
            {arActive && !isAIMode && (
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${
                currentArPose?.confidence === 'high' ? 'bg-green-500' :
                currentArPose?.confidence === 'medium' ? 'bg-yellow-500' : 'bg-orange-500'
              }`}>
                <Smartphone className="w-3 h-3" />
                <span>AR</span>
              </div>
            )}
            {coverageReport && (
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${getCoverageBadgeColor(coverageReport.overallCoverage)}`}>
                <span>{coverageReport.overallCoverage.toFixed(0)}%</span>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Camera View */}
      <div className="flex-1 relative overflow-hidden">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {/* Flash effect */}
        {showFlash && (
          <div className="absolute inset-0 bg-white/50 pointer-events-none" />
        )}
        
        {/* Coverage overlay */}
        {isCapturing && showCoverageMap && coverageReport && (
          <CoverageMap
            coverageReport={coverageReport}
            currentYaw={currentYaw}
            currentPitch={currentPitch}
          />
        )}
        
        {/* Quality Meter (2026 Smart Capture) */}
        {isCapturing && (
          <div className="absolute top-24 left-4 w-48">
            <QualityMeter
              metrics={qualityMetrics}
              stability={stability}
              compact={false}
            />
          </div>
        )}
        
        {/* Rotation speed warning */}
        {isCapturing && rotationSpeed > 30 && (
          <div className="absolute top-20 inset-x-0 flex justify-center pointer-events-none">
            <div className="flex items-center gap-2 px-4 py-3 bg-orange-600/90 border border-orange-400 rounded-xl shadow-lg">
              <RotateCw className="w-5 h-5 text-white animate-spin" />
              <span className="text-white text-sm font-semibold">Rotate slower for better overlap</span>
            </div>
          </div>
        )}
        
        {/* Capture guidance */}
        {isCapturing && coverageReport && (
          <CaptureGuidance
            recommendations={coverageReport.recommendations}
            currentYaw={currentYaw}
          />
        )}
        
        {/* Minimap */}
        {isCapturing && showMinimap && (
          <div className="absolute bottom-32 right-4 w-32 h-32">
            <PathVisualization
              positionHistory={positionHistory}
              currentPosition={currentPosition}
              currentYaw={currentYaw}
              photos={photos}
            />
          </div>
        )}
        
        {/* ============================================================== */}
        {/* AI RENOVATION OVERLAYS (only shown in ai-renovation mode)       */}
        {/* ============================================================== */}
        
        {/* AI Scanning Border Effect */}
        {isCapturing && isAIMode && aiActive && (
          <div className={`absolute inset-0 pointer-events-none z-5 border-4 transition-all duration-500 ${
            aiAnalyzing 
              ? 'border-purple-500 shadow-[inset_0_0_30px_rgba(168,85,247,0.3)]' 
              : 'border-transparent'
          }`} />
        )}
        
        {/* AI Live Status Indicator */}
        {isCapturing && isAIMode && aiActive && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-medium shadow-lg transition-all ${
              aiAnalyzing ? 'bg-purple-600 scale-105' : 'bg-purple-500/70'
            }`}>
              <div className="relative">
                <Eye className={`w-5 h-5 ${aiAnalyzing ? 'animate-pulse' : ''}`} />
                {aiAnalyzing && (
                  <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-ping" />
                )}
              </div>
              <span>
                {aiAnalyzing ? '🔍 AI Analyzing...' : `👁️ AI Watching (${aiAnalysisCount} scans)`}
              </span>
            </div>
          </div>
        )}
        
        {/* Detected Items Badge */}
        {isCapturing && isAIMode && detectedItems.length > 0 && (
          <div className="absolute top-32 left-1/2 -translate-x-1/2 z-20">
            <div className="bg-green-500/80 backdrop-blur px-3 py-1.5 rounded-full text-white text-xs flex items-center gap-2">
              <Sparkles className="w-3 h-3" />
              <span>Found: {detectedItems.slice(0, 3).join(', ')}{detectedItems.length > 3 ? ` +${detectedItems.length - 3}` : ''}</span>
            </div>
          </div>
        )}
        
        {/* Focus Request Overlay */}
        {isAIMode && currentFocusRequest && (
          <div className="absolute inset-x-0 top-24 z-20 px-4">
            <div className="bg-purple-600/90 backdrop-blur rounded-xl p-4 shadow-lg">
              <div className="flex items-start gap-3">
                <Target className="w-6 h-6 text-white flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-white font-medium">Show me the {currentFocusRequest.target}</p>
                  <p className="text-purple-200 text-sm mt-1">{currentFocusRequest.reason}</p>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => captureRenovationPhoto(currentFocusRequest.suggestedTag)}
                  className="flex-1 py-2 bg-white text-purple-600 rounded-lg font-medium flex items-center justify-center gap-2"
                >
                  <Camera className="w-4 h-4" /> Capture
                </button>
                <button onClick={skipCurrentFocus} className="px-4 py-2 bg-purple-700 text-white rounded-lg">
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* AI Guidance Message */}
        {isAIMode && currentGuidance && !currentFocusRequest && isCapturing && (
          <div className="absolute inset-x-0 bottom-40 z-20 px-4">
            <div className={`${
              currentGuidance.priority === 'high' ? 'bg-orange-500/90' :
              currentGuidance.priority === 'normal' ? 'bg-blue-500/90' : 'bg-slate-500/90'
            } backdrop-blur rounded-xl p-4 shadow-lg border-l-4 border-white/50`}>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                  <Eye className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1">
                  <p className="text-white font-medium text-sm leading-relaxed">{currentGuidance.message}</p>
                  <p className="text-white/60 text-xs mt-1">AI Assistant • {aiAnalysisCount} observations</p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* AI Observation Toast */}
        {isAIMode && recentAIObservation && isCapturing && (
          <div className="absolute top-24 left-2 right-2 z-50">
            <div className="bg-gradient-to-r from-green-500 to-emerald-600 backdrop-blur-sm rounded-2xl p-4 shadow-2xl border-2 border-white/30 animate-bounce">
              <div className="flex items-start gap-3">
                <div className="bg-white/20 rounded-full p-2 flex-shrink-0">
                  <Sparkles className="w-6 h-6 text-white" />
                </div>
                <div className="flex-1">
                  <p className="text-white text-xs font-bold uppercase tracking-wide mb-1">🤖 AI Assistant Says:</p>
                  <p className="text-white text-base font-semibold leading-snug">{recentAIObservation}</p>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Sensor permission prompt */}
        {isInitialized && !sensorPermissionRequested && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="bg-gray-800 p-6 rounded-2xl max-w-sm text-center">
              <Move className="w-12 h-12 text-blue-400 mx-auto mb-4" />
              <h3 className="text-white text-lg font-semibold mb-2">
                Enable Motion Sensors
              </h3>
              <p className="text-gray-300 text-sm mb-4">
                We need access to your device's motion sensors to track your position
                as you walk around the room.
              </p>
              <button
                onClick={handleRequestSensorPermission}
                className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold"
              >
                Enable Sensors
              </button>
            </div>
          </div>
        )}
        
        {/* Ready to start prompt */}
        {isInitialized && sensorPermissionRequested && !isCapturing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="bg-gray-800 p-6 rounded-2xl max-w-sm text-center max-h-[85vh] overflow-y-auto">
              <Camera className="w-12 h-12 text-green-400 mx-auto mb-4" />
              <h3 className="text-white text-lg font-semibold mb-2">
                Ready to Scan
              </h3>
              
              {/* ========== SCAN PURPOSE TOGGLE ========== */}
              <div className="mb-5 bg-gray-900/60 rounded-xl p-3">
                <label className="text-gray-400 text-xs block mb-3 uppercase tracking-wider font-medium">What do you want to do?</label>
                <p className="mb-3 text-xs leading-5 text-gray-400">
                  Need a real 3D model? <span className="font-semibold text-white">Choose Full 3D Model</span>. Use <span className="font-semibold text-purple-200">AI Renovation</span> only for fast renovation analysis and preview renders.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setScanPurpose('full-3d')}
                    className={`relative p-3 rounded-xl text-left transition-all ${
                      isFullMode
                        ? 'bg-blue-600 border-2 border-blue-400 shadow-lg shadow-blue-500/30'
                        : 'bg-gray-700/60 border-2 border-transparent hover:border-gray-500'
                    }`}
                  >
                    <Box className={`w-7 h-7 mb-2 ${isFullMode ? 'text-white' : 'text-gray-400'}`} />
                    <div className={`text-sm font-bold ${isFullMode ? 'text-white' : 'text-gray-300'}`}>Full 3D Model</div>
                    <p className={`text-xs mt-1 ${isFullMode ? 'text-blue-200' : 'text-gray-500'}`}>
                      Walk-around capture for detailed 3D reconstruction
                    </p>
                    {isFullMode && (
                      <div className="absolute top-2 right-2">
                        <CheckCircle2 className="w-4 h-4 text-blue-200" />
                      </div>
                    )}
                  </button>
                  <button
                    onClick={() => setScanPurpose('ai-renovation')}
                    className={`relative p-3 rounded-xl text-left transition-all ${
                      isAIMode
                        ? 'bg-purple-600 border-2 border-purple-400 shadow-lg shadow-purple-500/30'
                        : 'bg-gray-700/60 border-2 border-transparent hover:border-gray-500'
                    }`}
                  >
                    <Sparkles className={`w-7 h-7 mb-2 ${isAIMode ? 'text-white' : 'text-gray-400'}`} />
                    <div className={`text-sm font-bold ${isAIMode ? 'text-white' : 'text-gray-300'}`}>AI Renovation</div>
                    <p className={`text-xs mt-1 ${isAIMode ? 'text-purple-200' : 'text-gray-500'}`}>
                      Quick capture for ROI analysis & preview rendering
                    </p>
                    {isAIMode && (
                      <div className="absolute top-2 right-2">
                        <CheckCircle2 className="w-4 h-4 text-purple-200" />
                      </div>
                    )}
                  </button>
                </div>
              </div>
              
              {/* Mode-specific guidance */}
              {isFullMode ? (
                <>
                  <p className="text-gray-300 text-sm mb-4">
                    <strong className="text-white">Rotate SLOWLY</strong> - pause every 10-15°. Photos capture automatically with high overlap for best 3D reconstruction.
                  </p>
                  <div className="flex items-center justify-center gap-2 mb-4 text-xs text-gray-400">
                    <RotateCw className="w-4 h-4" />
                    <span>One photo every ~10° rotation</span>
                  </div>

                  <div className="mb-4 bg-gray-900/60 rounded-xl p-3">
                    <label className="text-gray-400 text-xs block mb-2 uppercase tracking-wider font-medium">
                      3D Reconstruction
                    </label>
                    <button
                      onClick={() => {
                        setFull3DPipelineVersion('master_v1');
                        setFull3DCaptureMode('room_tour');
                      }}
                      className={`w-full p-3 rounded-xl text-left transition-all ${
                        full3DPipelineVersion === 'master_v1'
                          ? 'bg-cyan-600 border-2 border-cyan-300 shadow-lg shadow-cyan-500/20'
                          : 'bg-gray-700/60 border-2 border-transparent hover:border-cyan-400/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          {full3DPipelineVersion === 'master_v1' ? (
                            <ToggleRight className="w-5 h-5 text-white" />
                          ) : (
                            <ToggleLeft className="w-5 h-5 text-gray-400" />
                          )}
                          <span className={`text-sm font-bold ${full3DPipelineVersion === 'master_v1' ? 'text-white' : 'text-gray-200'}`}>
                            Master v1
                          </span>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                          full3DPipelineVersion === 'master_v1'
                            ? 'bg-white/20 text-cyan-50'
                            : 'bg-cyan-500/15 text-cyan-200'
                        }`}>
                          Recommended
                        </span>
                      </div>
                      <p className={`text-xs leading-5 ${full3DPipelineVersion === 'master_v1' ? 'text-cyan-100' : 'text-gray-400'}`}>
                        Canonical master_v1 reconstruction on the dedicated VM, with selectable output profile below.
                      </p>
                    </button>

                    {full3DPipelineVersion === 'master_v1' && (
                      <div className="mt-3">
                        <label className="text-gray-400 text-[11px] block mb-2 uppercase tracking-[0.18em] font-medium">
                          Output Profile
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => setFull3DCaptureMode('room_tour')}
                            className={`p-3 rounded-xl text-left transition-all ${
                              full3DCaptureMode === 'room_tour'
                                ? 'bg-cyan-600 border-2 border-cyan-300 shadow-lg shadow-cyan-500/20'
                                : 'bg-gray-700/60 border-2 border-transparent hover:border-cyan-400/40'
                            }`}
                          >
                            <div className={`text-xs font-semibold uppercase tracking-[0.16em] ${full3DCaptureMode === 'room_tour' ? 'text-cyan-50' : 'text-gray-300'}`}>
                              Gaussian Splat
                            </div>
                            <p className={`mt-1 text-xs leading-5 ${full3DCaptureMode === 'room_tour' ? 'text-cyan-100' : 'text-gray-400'}`}>
                              Main path. Best in-app viewer output.
                            </p>
                          </button>
                          <button
                            onClick={() => setFull3DCaptureMode('image_sequence')}
                            className={`p-3 rounded-xl text-left transition-all ${
                              full3DCaptureMode === 'image_sequence'
                                ? 'bg-blue-600 border-2 border-blue-400 shadow-lg shadow-blue-500/20'
                                : 'bg-gray-700/60 border-2 border-transparent hover:border-blue-400/40'
                            }`}
                          >
                            <div className={`text-xs font-semibold uppercase tracking-[0.16em] ${full3DCaptureMode === 'image_sequence' ? 'text-blue-50' : 'text-gray-300'}`}>
                              Dense Mesh
                            </div>
                            <p className={`mt-1 text-xs leading-5 ${full3DCaptureMode === 'image_sequence' ? 'text-blue-100' : 'text-gray-400'}`}>
                              Alternate mesh-first reconstruction path.
                            </p>
                          </button>
                        </div>
                      </div>
                    )}

                    <p className="mt-2 text-[11px] leading-5 text-cyan-100/90">
                      For most scans, keep Gaussian Splat selected and tap Start Scanning.
                    </p>

                    {full3DPipelineVersion !== 'master_v1' && (
                      <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100">Current selection</div>
                        <div className="mt-1 text-sm font-semibold text-white">{selectedPipelineSummary.title}</div>
                        <p className="mt-1 text-xs leading-5 text-amber-100/85">{selectedPipelineSummary.detail}</p>
                        <button
                          onClick={() => {
                            setFull3DPipelineVersion('master_v1');
                            setFull3DCaptureMode('room_tour');
                          }}
                          className="mt-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20"
                        >
                          Switch back to Master v1
                        </button>
                      </div>
                    )}

                    <button
                      onClick={() => setShowLegacyPipelines((prev) => !prev)}
                      className="mt-3 w-full rounded-lg border border-white/10 bg-gray-800/70 px-3 py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-gray-800"
                    >
                      {showLegacyPipelines ? 'Hide legacy pipeline options' : 'Show legacy pipeline options'}
                    </button>

                    {showLegacyPipelines && (
                      <>
                        <p className="mt-2 text-[11px] leading-5 text-gray-400">
                          Dense Mesh now uses the legacy-compatible paths below. Hybrid Mesh + Splat remains comparison-only.
                        </p>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <button
                            onClick={() => {
                              setFull3DPipelineVersion('v1');
                              setFull3DCaptureMode('image_sequence');
                            }}
                            className={`p-3 rounded-xl text-left transition-all ${
                              full3DPipelineVersion === 'v1'
                                ? 'bg-blue-600 border-2 border-blue-400 shadow-lg shadow-blue-500/20'
                                : 'bg-gray-700/60 border-2 border-transparent hover:border-gray-500'
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              {full3DPipelineVersion === 'v1' ? (
                                <ToggleRight className="w-5 h-5 text-white" />
                              ) : (
                                <ToggleLeft className="w-5 h-5 text-gray-400" />
                              )}
                              <span className={`text-sm font-bold ${full3DPipelineVersion === 'v1' ? 'text-white' : 'text-gray-300'}`}>
                                Standard Mesh
                              </span>
                            </div>
                            <p className={`text-xs leading-5 ${full3DPipelineVersion === 'v1' ? 'text-blue-200' : 'text-gray-500'}`}>
                              Updated renovation-grade COLMAP path on the master-v1 VM.
                            </p>
                          </button>
                          <button
                            onClick={() => {
                              setFull3DPipelineVersion('hybrid_v1');
                              setFull3DCaptureMode('image_sequence');
                            }}
                            className={`p-3 rounded-xl text-left transition-all ${
                              full3DPipelineVersion === 'hybrid_v1'
                                ? 'bg-emerald-600 border-2 border-emerald-400 shadow-lg shadow-emerald-500/20'
                                : 'bg-gray-700/60 border-2 border-transparent hover:border-gray-500'
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              {full3DPipelineVersion === 'hybrid_v1' ? (
                                <ToggleRight className="w-5 h-5 text-white" />
                              ) : (
                                <ToggleLeft className="w-5 h-5 text-gray-400" />
                              )}
                              <span className={`text-sm font-bold ${full3DPipelineVersion === 'hybrid_v1' ? 'text-white' : 'text-gray-300'}`}>
                                Hybrid Mesh + Splat
                              </span>
                            </div>
                            <p className={`text-xs leading-5 ${full3DPipelineVersion === 'hybrid_v1' ? 'text-emerald-100' : 'text-gray-500'}`}>
                              Older hybrid comparison path.
                            </p>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  
                  {/* Capture mode selector (only for full 3D) */}
                  <div className="mb-4">
                    <label className="text-gray-400 text-xs block mb-2">Capture Mode</label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['smart', 'time', 'manual'] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setCaptureConfig(prev => ({ ...prev, mode }))}
                          className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                            captureConfig.mode === mode
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-300'
                          }`}
                        >
                          {mode === 'smart' && <Zap className="w-4 h-4 inline mr-1" />}
                          {mode === 'time' && <Clock className="w-4 h-4 inline mr-1" />}
                          {mode === 'manual' && <Camera className="w-4 h-4 inline mr-1" />}
                          {getCaptureModeName(mode)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-gray-300 text-sm mb-3">
                    <strong className="text-purple-300">AI will guide you</strong> — slowly pan around the room. Captures ~{RECOMMENDED_AI_CAPTURES} photos for renovation analysis.
                  </p>
                  <div className="bg-purple-900/30 border border-purple-500/30 rounded-lg p-3 mb-4 text-left">
                    <div className="text-xs text-purple-300 font-medium mb-2 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> What you'll get:
                    </div>
                    <ul className="text-xs text-gray-300 space-y-1">
                      <li className="flex items-center gap-1.5">
                        <Paintbrush className="w-3 h-3 text-purple-400" /> High ROI renovation recommendations
                      </li>
                      <li className="flex items-center gap-1.5">
                        <Eye className="w-3 h-3 text-purple-400" /> Post-renovation preview rendering
                      </li>
                      <li className="flex items-center gap-1.5">
                        <Ruler className="w-3 h-3 text-purple-400" /> Cost estimates & measurements
                      </li>
                    </ul>
                  </div>
                </>
              )}
              
              <button
                onClick={startCapture}
                className={`w-full py-3 text-white rounded-xl font-semibold flex items-center justify-center gap-2 ${
                  isAIMode ? 'bg-purple-600' : 'bg-green-600'
                }`}
              >
                {isAIMode ? <Sparkles className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                {isAIMode ? 'Start AI Scan' : 'Start Scanning'}
              </button>
            </div>
          </div>
        )}
      </div>
      
      {/* Bottom Controls */}
      {isCapturing && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent p-4 pb-8">
          
          {/* === AI RENOVATION MODE BOTTOM === */}
          {isAIMode ? (
            <div className="space-y-3">
              {/* AI Progress indicator */}
              <div className="flex items-center gap-2 justify-center">
                <div className="flex gap-1">
                  {Array.from({ length: RECOMMENDED_AI_CAPTURES }).map((_, i) => (
                    <div
                      key={i}
                      className={`w-2 h-2 rounded-full ${
                        i < renovationCaptures.length
                          ? 'bg-purple-500'
                          : i < MIN_AI_CAPTURES
                            ? 'bg-gray-600'
                            : 'bg-gray-700'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-gray-400 text-xs">
                  {renovationCaptures.length}/{RECOMMENDED_AI_CAPTURES}
                </span>
              </div>
              
              {/* AI Controls */}
              <div className="flex items-center justify-between">
                {/* Left: Map + Pause */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowMinimap(!showMinimap)}
                    className={`p-3 rounded-full ${showMinimap ? 'bg-purple-600' : 'bg-gray-800'} text-white`}
                  >
                    <MapIcon className="w-5 h-5" />
                  </button>
                  <button
                    onClick={togglePause}
                    className={`p-3 rounded-full ${isPaused ? 'bg-yellow-600' : 'bg-gray-800'} text-white`}
                  >
                    {isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                  </button>
                </div>
                
                {/* Center: Manual capture */}
                <button
                  onClick={() => captureRenovationPhoto('general')}
                  className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-lg active:scale-95 transition-transform"
                >
                  <div className="w-16 h-16 rounded-full border-4 border-purple-500" />
                </button>
                
                {/* Right: Finish */}
                <button
                  onClick={finishRenovationScan}
                  disabled={renovationCaptures.length < MIN_AI_CAPTURES}
                  className={`p-4 rounded-full ${
                    renovationCaptures.length >= MIN_AI_CAPTURES
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  <Check className="w-6 h-6" />
                </button>
              </div>
              
              {/* Status */}
              <div className="text-center text-white/60 text-xs">
                {renovationCaptures.length} captures • AI mode
                {renovationCaptures.length < MIN_AI_CAPTURES && ` • Min ${MIN_AI_CAPTURES} needed`}
              </div>
            </div>
          ) : (
            /* === FULL 3D MODE BOTTOM === */
            <>
              {/* Readiness indicator */}
              {coverageReport && (
                <div className="flex items-center justify-center mb-4">
                  {coverageReport.readyForProcessing ? (
                    <div className="flex items-center gap-2 px-4 py-2 bg-green-600/20 border border-green-500 rounded-full">
                      <CheckCircle2 className="w-5 h-5 text-green-400" />
                      <span className="text-green-300 text-sm font-medium">
                        Ready for 3D processing!
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 px-4 py-2 bg-gray-800/80 rounded-full">
                      <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-gray-300 text-sm">
                        {coverageReport.recommendations[0]?.message || 'Keep scanning...'}
                      </span>
                    </div>
                  )}
                </div>
              )}
              
              {/* Control buttons */}
              <div className="flex items-center justify-center gap-6">
                {/* Toggle minimap */}
                <button
                  onClick={() => setShowMinimap(!showMinimap)}
                  className={`p-3 rounded-full transition-colors ${
                    showMinimap ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  <MapIcon className="w-6 h-6 text-white" />
                </button>
                
                {/* Manual capture / Pause */}
                {captureConfig.mode === 'manual' ? (
                  <button
                    onClick={manualCapture}
                    className="p-5 rounded-full bg-white"
                  >
                    <Camera className="w-8 h-8 text-black" />
                  </button>
                ) : (
                  <button
                    onClick={togglePause}
                    className={`p-5 rounded-full ${isPaused ? 'bg-green-600' : 'bg-yellow-600'}`}
                  >
                    {isPaused ? (
                      <Play className="w-8 h-8 text-white" />
                    ) : (
                      <Pause className="w-8 h-8 text-white" />
                    )}
                  </button>
                )}
                
                {/* Finish button */}
                <button
                  onClick={finishCapture}
                  disabled={photos.length < 10}
                  className={`p-3 rounded-full transition-colors ${
                    photos.length >= 10 
                      ? coverageReport?.readyForProcessing 
                        ? 'bg-green-600' 
                        : 'bg-blue-600'
                      : 'bg-gray-700 opacity-50'
                  }`}
                >
                  <Check className="w-6 h-6 text-white" />
                </button>
              </div>
              
              {/* Photo count and mode */}
              <div className="text-center mt-3 text-white/60 text-sm">
                {photos.length} photos • {getCaptureModeName(captureConfig.mode)} mode
                {photos.length < 10 && ' • Min 10 photos required'}
              </div>
            </>
          )}
        </div>
      )}
      
      {/* Settings panel */}
      {showSettings && (
        <div className="absolute inset-0 z-30 bg-black/90 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-2xl p-6 max-w-sm w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white text-lg font-semibold">Capture Settings</h3>
              <button onClick={() => setShowSettings(false)}>
                <X className="w-6 h-6 text-gray-400" />
              </button>
            </div>
            
            {/* Time interval */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm mb-1 block">
                Time interval: {(captureConfig.timeInterval / 1000).toFixed(1)}s
              </label>
              <input
                type="range"
                min="500"
                max="5000"
                step="500"
                value={captureConfig.timeInterval}
                onChange={(e) => setCaptureConfig(prev => ({
                  ...prev,
                  timeInterval: parseInt(e.target.value)
                }))}
                className="w-full"
              />
            </div>
            
            {/* Distance threshold */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm mb-1 block">
                Distance threshold: {(captureConfig.distanceThreshold * 3.28084).toFixed(1)} ft
              </label>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.1"
                value={captureConfig.distanceThreshold}
                onChange={(e) => setCaptureConfig(prev => ({
                  ...prev,
                  distanceThreshold: parseFloat(e.target.value)
                }))}
                className="w-full"
              />
            </div>
            
            {/* Rotation threshold */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm mb-1 block">
                Rotation threshold: {captureConfig.rotationThreshold}°
              </label>
              <input
                type="range"
                min="10"
                max="45"
                step="5"
                value={captureConfig.rotationThreshold}
                onChange={(e) => setCaptureConfig(prev => ({
                  ...prev,
                  rotationThreshold: parseInt(e.target.value)
                }))}
                className="w-full"
              />
            </div>
            
            {/* Toggle overlays */}
            <div className="flex items-center justify-between py-2 border-t border-gray-700">
              <span className="text-gray-300">Show coverage overlay</span>
              <button
                onClick={() => setShowCoverageMap(!showCoverageMap)}
                className={`w-12 h-6 rounded-full transition-colors ${
                  showCoverageMap ? 'bg-blue-600' : 'bg-gray-600'
                }`}
              >
                <div className={`w-5 h-5 bg-white rounded-full transform transition-transform ${
                  showCoverageMap ? 'translate-x-6' : 'translate-x-0.5'
                }`} />
              </button>
            </div>
            
            <button
              onClick={() => setShowSettings(false)}
              className="w-full mt-4 py-3 bg-blue-600 text-white rounded-xl font-semibold"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PhotogrammetryScanner;
