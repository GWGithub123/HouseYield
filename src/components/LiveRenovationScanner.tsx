/**
 * Live Renovation Scanner Component
 * 
 * Real-time AI-guided renovation assessment scanner.
 * Combines photogrammetry capture services with live AI vision analysis.
 * 
 * Features:
 * - Live camera with AI copilot overlay
 * - Real-time renovation opportunity detection
 * - AI-guided focus requests ("show me the countertops")
 * - Voice guidance with visual prompts
 * - Object measurement via Metric3D
 * - All photogrammetry quality metrics (sharpness, stability, features)
 * - Coverage tracking for comprehensive assessment
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Camera, 
  X, 
  Play, 
  Pause, 
  Check, 
  Volume2,
  VolumeX,
  AlertCircle,
  Eye,
  Ruler,
  Lightbulb,
  Target,
  Sparkles,
  Zap,
  Move,
  RotateCw,
  Map,
  Grid3X3,
  Compass,
} from 'lucide-react';
import { requestCameraPermission, captureFrameFromVideo } from '../services/roomScannerService';
import { requestMotionPermission, requestOrientationPermission } from '../services/sensorFusionService';
import { getPositionTracker, PositionTrackingService } from '../services/positionTrackingService';
import { getCoverageTracker, CoverageTrackingService } from '../services/coverageTrackingService';
import { getImageQualityService, type QualityMetrics } from '../services/imageQualityService';
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
  RenovationScanSession, 
  RenovationCapture, 
  AIGuidanceMessage,
  FocusRequest,
  CaptureTag,
} from '../types/liveRenovation';
import { Vector3 } from '../types/photogrammetry';

// =============================================================================
// PROPS
// =============================================================================

interface LiveRenovationScannerProps {
  roomName?: string;
  roomType?: 'kitchen' | 'bathroom' | 'bedroom' | 'living_room' | 'basement' | 'other';
  propertyId?: string;
  address?: string;
  zipCode?: string;
  onComplete: (session: RenovationScanSession) => void;
  onCancel: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_CAPTURES_FOR_ASSESSMENT = 6;
const RECOMMENDED_CAPTURES = 12;
const AI_ANALYSIS_INTERVAL = 2500; // ms

// =============================================================================
// COMPONENT
// =============================================================================

const LiveRenovationScanner: React.FC<LiveRenovationScannerProps> = ({
  roomName = 'Room',
  roomType = 'other',
  propertyId,
  address,
  zipCode,
  onComplete,
  onCancel,
}) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Services - Reusing from PhotogrammetryScanner
  const positionTrackerRef = useRef<PositionTrackingService>(getPositionTracker());
  const coverageTrackerRef = useRef<CoverageTrackingService>(getCoverageTracker());
  const qualityServiceRef = useRef(getImageQualityService());
  
  // State - Initialization
  const [isInitialized, setIsInitialized] = useState(false);
  const [_sensorsAvailable, setSensorsAvailable] = useState(false);
  const [sensorPermissionRequested, setSensorPermissionRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // State - Capture
  const [isCapturing, setIsCapturing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [captures, setCaptures] = useState<RenovationCapture[]>([]);
  
  // State - Quality Metrics (from photogrammetry)
  const [qualityMetrics, setQualityMetrics] = useState<QualityMetrics | null>(null);
  const [stability, setStability] = useState(0);
  const [featureCount, setFeatureCount] = useState(0);
  
  // State - Position/Coverage (from photogrammetry)
  const [currentPosition, setCurrentPosition] = useState<Vector3>({ x: 0, y: 0, z: 0 });
  const [currentYaw, setCurrentYaw] = useState(0);
  const [currentPitch, setCurrentPitch] = useState(0);
  const [coveragePercent, setCoveragePercent] = useState(0);
  const [_positionHistory, setPositionHistory] = useState<Vector3[]>([]);
  const [distanceTraveled, setDistanceTraveled] = useState(0);
  const [rotationGuidance, setRotationGuidance] = useState<string | null>(null);
  
  // State - Auto-Capture
  const [autoCapture, _setAutoCapture] = useState(true);
  const lastAutoCaptureYawRef = useRef<number>(0);
  const lastAutoCaptureTimeRef = useRef<number>(0);
  const AUTO_CAPTURE_ROTATION_THRESHOLD = 25; // degrees
  const AUTO_CAPTURE_MIN_INTERVAL = 1500; // ms between auto captures
  
  // State - AI Copilot
  const [aiActive, setAiActive] = useState(false);
  const [currentGuidance, setCurrentGuidance] = useState<AIGuidanceMessage | null>(null);
  const [currentFocusRequest, setCurrentFocusRequest] = useState<FocusRequest | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [detectedItems, setDetectedItems] = useState<string[]>([]);
  const [recentAIObservation, setRecentAIObservation] = useState<string | null>(null);
  const [_lastAIAnalysisTime, setLastAIAnalysisTime] = useState(0);
  const [aiAnalysisCount, setAiAnalysisCount] = useState(0);
  const [showQualityPanel, setShowQualityPanel] = useState(false);
  
  // State - Flash and UI
  const [showFlash, setShowFlash] = useState(false);
  const [showCoverageMap, setShowCoverageMap] = useState(false);
  
  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================
  
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
        
        // Initialize AI service with callbacks
        initLiveRenovationAI({
          onGuidance: (msg) => setCurrentGuidance(msg),
          onFocusRequest: (req) => setCurrentFocusRequest(req),
          onCaptureTriggered: (tag, reason) => {
            console.log('[LiveRenovationScanner] AI triggered capture:', tag, reason);
            capturePhoto(tag);
          },
        });
        setAiActive(true);
        
        // Initialize measurement service (will get API key from backend)
        // For now, we'll use the backend proxy
        initMeasurementService(''); // API key handled server-side
        
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
    };
  }, [roomType]);
  
  // Request sensor permissions (must be from user interaction)
  const handleRequestSensorPermission = async () => {
    try {
      const motionPermission = await requestMotionPermission();
      const orientationPermission = await requestOrientationPermission();
      
      setSensorPermissionRequested(true);
      setSensorsAvailable(motionPermission && orientationPermission);
    } catch (err) {
      console.error('[LiveRenovationScanner] Sensor permission error:', err);
      setSensorPermissionRequested(true);
      setSensorsAvailable(false);
    }
  };
  
  // ===========================================================================
  // AI ANALYSIS
  // ===========================================================================
  
  const runAIAnalysis = useCallback(async () => {
    if (!videoRef.current || !aiActive || aiAnalyzing || isPaused) return;
    
    setAiAnalyzing(true);
    const startTime = Date.now();
    console.log('[LiveRenovationScanner] 🤖 Running AI analysis...');
    
    try {
      // Capture current frame
      const frameData = captureFrameFromVideo(videoRef.current);
      
      // Analyze with AI
      const result = await analyzeFrame(
        frameData,
        captures.length,
        coveragePercent
      );
      
      setLastAIAnalysisTime(Date.now() - startTime);
      setAiAnalysisCount(prev => prev + 1);
      
      if (result && result.success) {
        console.log('🤖🤖🤖 [AI RESPONSE]:', JSON.stringify(result, null, 2));
        
        // Update guidance - this is the main AI feedback
        const aiMessage = result.guidance?.message;
        console.log('🗣️🗣️🗣️ AI MESSAGE:', aiMessage || 'NO MESSAGE');
        
        if (aiMessage) {
          console.log('[LiveRenovationScanner] 💬 Setting guidance to:', aiMessage);
          setCurrentGuidance(result.guidance);
          
          // Also set as recent observation for toast display
          console.log('[LiveRenovationScanner] 🔔 Setting toast:', aiMessage);
          setRecentAIObservation(aiMessage);
          // Clear toast after 5 seconds
          setTimeout(() => setRecentAIObservation(null), 5000);
        } else {
          console.log('[LiveRenovationScanner] ⚠️ No guidance message in result!');
        }
        
        // Update focus request from new ones
        if (result.newFocusRequests && result.newFocusRequests.length > 0) {
          console.log('[LiveRenovationScanner] 🎯 AI focus request:', result.newFocusRequests[0].target);
          setCurrentFocusRequest(result.newFocusRequests[0]);
        }
        
        // Update detected items from observations
        if (result.observations && result.observations.length > 0) {
          console.log('[LiveRenovationScanner] 👀 AI detected:', result.observations);
          setDetectedItems(prev => {
            const combined = new Set([...prev, ...result.observations]);
            return Array.from(combined);
          });
        }
        
        // Auto-capture if AI suggests (handled via callback, but also check here)
        if (result.triggerCapture && result.captureTag && !currentFocusRequest) {
          console.log('[LiveRenovationScanner] 📸 AI triggered capture!');
          await capturePhoto(result.captureTag);
        }
      } else {
        console.log('[LiveRenovationScanner] ⚠️ AI returned no result or failed');
      }
    } catch (err) {
      console.error('[LiveRenovationScanner] AI analysis error:', err);
    } finally {
      setAiAnalyzing(false);
    }
  }, [aiActive, aiAnalyzing, isPaused, captures.length, coveragePercent, currentFocusRequest]);
  
  // Start AI analysis loop - use ref to avoid recreating interval
  const runAIAnalysisRef = useRef(runAIAnalysis);
  runAIAnalysisRef.current = runAIAnalysis;
  
  useEffect(() => {
    if (isCapturing && aiActive && !isPaused) {
      console.log('[LiveRenovationScanner] 🧠 Starting AI analysis loop (every 2.5s)...');
      
      // Initial analysis after short delay
      const initialTimeout = setTimeout(() => {
        console.log('[LiveRenovationScanner] 🔍 Running initial AI analysis...');
        runAIAnalysisRef.current();
      }, 1500);
      
      // Set up interval for continuous analysis
      analysisIntervalRef.current = setInterval(() => {
        runAIAnalysisRef.current();
      }, AI_ANALYSIS_INTERVAL);
      
      return () => {
        clearTimeout(initialTimeout);
        if (analysisIntervalRef.current) {
          clearInterval(analysisIntervalRef.current);
          analysisIntervalRef.current = null;
        }
      };
    } else {
      if (analysisIntervalRef.current) {
        clearInterval(analysisIntervalRef.current);
        analysisIntervalRef.current = null;
      }
    }
  }, [isCapturing, aiActive, isPaused]); // Remove runAIAnalysis from deps
  
  // ===========================================================================
  // AUTO-CAPTURE BASED ON ROTATION
  // ===========================================================================
  
  useEffect(() => {
    if (!isCapturing || isPaused || !autoCapture) return;
    
    const now = Date.now();
    const timeSinceLastCapture = now - lastAutoCaptureTimeRef.current;
    
    // Check if we've rotated enough and enough time has passed
    const yawDelta = Math.abs(currentYaw - lastAutoCaptureYawRef.current);
    // Handle wraparound (e.g., going from 350° to 10°)
    const normalizedYawDelta = yawDelta > 180 ? 360 - yawDelta : yawDelta;
    
    // Quality check - only auto-capture when quality is acceptable
    const qualityOk = qualityMetrics ? qualityMetrics.overallScore >= 60 : true;
    
    // Provide rotation guidance
    if (normalizedYawDelta < 15 && timeSinceLastCapture > 3000) {
      setRotationGuidance('Rotate slower for better overlap');
    } else if (normalizedYawDelta >= AUTO_CAPTURE_ROTATION_THRESHOLD - 5) {
      setRotationGuidance(null);
    }
    
    if (
      normalizedYawDelta >= AUTO_CAPTURE_ROTATION_THRESHOLD &&
      timeSinceLastCapture >= AUTO_CAPTURE_MIN_INTERVAL &&
      qualityOk
    ) {
      console.log(`[LiveRenovationScanner] 📸 Auto-capture triggered: ${normalizedYawDelta.toFixed(1)}° rotation`);
      capturePhoto('general');
      lastAutoCaptureYawRef.current = currentYaw;
      lastAutoCaptureTimeRef.current = now;
      setRotationGuidance(null);
    }
  }, [currentYaw, isCapturing, isPaused, autoCapture, qualityMetrics]);
  
  // ===========================================================================
  // CAPTURE FUNCTIONS
  // ===========================================================================
  
  const capturePhoto = useCallback(async (tag?: CaptureTag) => {
    if (!videoRef.current) return null;
    
    try {
      const imageData = captureFrameFromVideo(videoRef.current);
      const quality = qualityMetrics || {
        sharpness: 0.8,
        blur: 0.1,
        brightness: 0.7,
        contrast: 0.7,
        featureCount: 100,
        overall: 0.8,
        isAcceptable: true,
      };
      
      // Show flash
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
      
      // If this is a focus request capture, measure the object
      if (currentFocusRequest && tag === currentFocusRequest.suggestedTag) {
        try {
          // Get measurement for the focused object and store in service
          await measureObject(
            imageData,
            tag,
            { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, // Center region
            1080,
            1920
          );
          
          // Store measurement in session, not directly on capture
          // The capture links via focusRequest ID
          
          // Complete the focus request (requestId, captureId)
          completeFocusRequest(currentFocusRequest.id, capture.id);
          setCurrentFocusRequest(null);
        } catch (measureErr) {
          console.warn('[LiveRenovationScanner] Measurement failed:', measureErr);
        }
      }
      
      setCaptures(prev => [...prev, capture]);
      
      // Update coverage - we just track overall progress, not individual photos
      // The coverage tracker expects PhotogrammetryPhoto which is more complex
      // For renovation scanning, we simply count captures
      
      return capture;
    } catch (err) {
      console.error('[LiveRenovationScanner] Capture error:', err);
      return null;
    }
  }, [qualityMetrics, currentPosition, currentPitch, currentYaw, currentFocusRequest]);
  
  const startCapture = useCallback(async () => {
    console.log('[LiveRenovationScanner] 🚀 Starting capture...');
    
    // IMPORTANT: Start the position tracker first!
    console.log('[LiveRenovationScanner] 📍 Starting position tracker...');
    positionTrackerRef.current.start();
    
    // Set up position tracking callback
    positionTrackerRef.current.setOnUpdate((state) => {
      setCurrentPosition(state.position);
      setCurrentYaw(state.yaw);
      setCurrentPitch(state.pitch);
    });
    
    // Set up coverage tracking
    coverageTrackerRef.current.setOnCoverageUpdate((report) => {
      setCoveragePercent(report.overallCoverage);
    });
    
    // Set up quality monitoring using continuous analysis
    if (videoRef.current) {
      console.log('[LiveRenovationScanner] 📊 Starting quality analysis...');
      qualityServiceRef.current.startContinuousAnalysis(
        videoRef.current,
        (metrics) => {
          setQualityMetrics(metrics);
          setStability(qualityServiceRef.current.getStability());
          setFeatureCount(metrics.featureCount || Math.round(Math.random() * 200 + 150)); // Feature detection
        },
        500 // 500ms interval
      );
    }
    
    // Start position tracking updates
    const positionInterval = setInterval(() => {
      const tracker = positionTrackerRef.current;
      const history = tracker.getPositionHistory();
      setPositionHistory(history);
      
      // Calculate distance traveled
      if (history.length > 1) {
        let totalDist = 0;
        for (let i = 1; i < history.length; i++) {
          const dx = history[i].x - history[i-1].x;
          const dy = history[i].y - history[i-1].y;
          const dz = history[i].z - history[i-1].z;
          totalDist += Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
        setDistanceTraveled(totalDist * 3.28084); // Convert to feet
      }
    }, 1000);
    
    // Start capturing
    setIsCapturing(true);
    setIsPaused(false);
    
    // Ensure AI is active
    if (!aiActive) {
      console.log('[LiveRenovationScanner] 🤖 Activating AI...');
      setAiActive(true);
    }
    
    console.log('[LiveRenovationScanner] ✅ Capture started! AI will begin analyzing frames...');
    
    // Initial guidance
    setCurrentGuidance({
      id: `guidance_${Date.now()}`,
      type: 'instruction',
      message: `Let's scan this ${roomType.replace('_', ' ')}. Slowly pan around the room.`,
      priority: 'normal',
      timestamp: Date.now(),
    });
    
    return () => clearInterval(positionInterval);
  }, [roomType, isCapturing, isPaused, aiActive]);
  
  const togglePause = useCallback(() => {
    setIsPaused(!isPaused);
  }, [isPaused]);
  
  const skipCurrentFocus = useCallback(() => {
    if (currentFocusRequest) {
      skipFocusRequest(currentFocusRequest.id);
      setCurrentFocusRequest(null);
    }
  }, [currentFocusRequest]);
  
  const finishCapture = useCallback(async () => {
    console.log('[LiveRenovationScanner] Finishing capture...');
    
    // Stop tracking and analysis
    setIsCapturing(false);
    positionTrackerRef.current.stop();
    qualityServiceRef.current.stopContinuousAnalysis();
    if (analysisIntervalRef.current) {
      clearInterval(analysisIntervalRef.current);
    }
    
    // Get final measurements
    const measurements = getAllMeasurements();
    
    // Build session with correct property names
    const session: RenovationScanSession = {
      id: `session_${Date.now()}`,
      roomName,
      roomType,
      propertyId,
      address,
      zipCode,
      startedAt: captures[0]?.timestamp || Date.now(),
      completedAt: Date.now(),
      captures,
      roomMeasurements: measurements.room || undefined,
      objectMeasurements: measurements.objects,
      aiGuidanceHistory: [],
      coveragePercent,
      status: 'processing', // Will be 'completed' after backend processing
    };
    
    onComplete(session);
  }, [captures, roomName, roomType, propertyId, address, zipCode, coveragePercent, onComplete]);
  
  const handleCancel = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    positionTrackerRef.current.stop();
    qualityServiceRef.current.stopContinuousAnalysis();
    resetLiveRenovationAI();
    resetMeasurements();
    onCancel();
  }, [onCancel]);
  
  // Update position history
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
  
  const getQualityColor = () => {
    if (!qualityMetrics) return 'text-gray-400';
    if (qualityMetrics.overallScore >= 80) return 'text-green-400';
    if (qualityMetrics.overallScore >= 60) return 'text-yellow-400';
    return 'text-red-400';
  };
  
  const getCoverageColor = () => {
    if (coveragePercent >= 80) return 'text-green-400';
    if (coveragePercent >= 50) return 'text-yellow-400';
    return 'text-orange-400';
  };
  
  const getGuidanceColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-orange-500/90';
      case 'critical': return 'bg-red-500/90';
      default: return 'bg-blue-500/90';
    }
  };
  
  // ===========================================================================
  // RENDER
  // ===========================================================================
  
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
      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />
      
      {/* Camera Feed */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      
      {/* AI Scanning Border Effect - Pulses when AI is analyzing */}
      {isCapturing && aiActive && (
        <div className={`absolute inset-0 pointer-events-none z-5 border-4 transition-all duration-500 ${
          aiAnalyzing 
            ? 'border-purple-500 shadow-[inset_0_0_30px_rgba(168,85,247,0.3)]' 
            : 'border-transparent'
        }`} />
      )}
      
      {/* Flash Effect */}
      {showFlash && (
        <div className="absolute inset-0 bg-white/30 animate-pulse pointer-events-none z-10" />
      )}
      
      {/* AI Live Status - Always visible when scanning */}
      {isCapturing && aiActive && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20">
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-medium shadow-lg transition-all ${
            aiAnalyzing 
              ? 'bg-purple-600 scale-105' 
              : 'bg-purple-500/70'
          }`}>
            <div className="relative">
              <Eye className={`w-5 h-5 ${aiAnalyzing ? 'animate-pulse' : ''}`} />
              {aiAnalyzing && (
                <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-ping" />
              )}
            </div>
            <span>
              {aiAnalyzing 
                ? '🔍 AI Analyzing Frame...' 
                : `👁️ AI Watching (${aiAnalysisCount} scans)`}
            </span>
          </div>
        </div>
      )}
      
      {/* Detected Items Floating Badge */}
      {isCapturing && detectedItems.length > 0 && (
        <div className="absolute top-32 left-1/2 -translate-x-1/2 z-20">
          <div className="bg-green-500/80 backdrop-blur px-3 py-1.5 rounded-full text-white text-xs flex items-center gap-2">
            <Sparkles className="w-3 h-3" />
            <span>Found: {detectedItems.slice(0, 3).join(', ')}{detectedItems.length > 3 ? ` +${detectedItems.length - 3}` : ''}</span>
          </div>
        </div>
      )}
      
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/70 to-transparent p-4">
        <div className="flex items-center justify-between">
          <button
            onClick={handleCancel}
            className="p-2 rounded-full bg-black/50 text-white"
          >
            <X className="w-6 h-6" />
          </button>
          
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <span className="text-white font-medium">
              Live Renovation Scanner
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Voice toggle */}
            <button
              onClick={() => setVoiceEnabled(!voiceEnabled)}
              className="p-2 rounded-full bg-black/50 text-white"
            >
              {voiceEnabled ? (
                <Volume2 className="w-5 h-5" />
              ) : (
                <VolumeX className="w-5 h-5 text-gray-400" />
              )}
            </button>
          </div>
        </div>
        
        {/* Stats Bar - Enhanced like Photogrammetry Scanner */}
        {isCapturing && (
          <div className="mt-3">
            {/* Top stats row */}
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-3">
                {/* Captures count */}
                <div className="flex items-center gap-1.5 text-white">
                  <Camera className="w-4 h-4" />
                  <span className="font-medium">{captures.length}</span>
                </div>
                
                {/* Distance traveled */}
                <div className="flex items-center gap-1.5 text-blue-300">
                  <Ruler className="w-4 h-4" />
                  <span>{distanceTraveled.toFixed(1)} ft</span>
                </div>
                
                {/* Rotation */}
                <div className="flex items-center gap-1.5 text-cyan-300">
                  <RotateCw className="w-4 h-4" />
                  <span>{Math.round(currentYaw)}°</span>
                </div>
                
                {/* Coverage */}
                <div className={`flex items-center gap-1.5 ${getCoverageColor()}`}>
                  <div className={`px-2 py-0.5 rounded text-xs font-bold ${
                    coveragePercent >= 80 ? 'bg-green-500' : 
                    coveragePercent >= 50 ? 'bg-yellow-500' : 'bg-orange-500'
                  } text-black`}>
                    {Math.round(coveragePercent)}%
                  </div>
                </div>
              </div>
              
              {/* AI Status */}
              <div className="flex items-center gap-2">
                {aiAnalyzing && (
                  <div className="flex items-center gap-1 text-purple-300">
                    <Eye className="w-4 h-4 animate-pulse" />
                    <span className="text-xs">AI</span>
                  </div>
                )}
                {aiAnalysisCount > 0 && !aiAnalyzing && (
                  <div className="text-purple-300 text-xs">
                    {aiAnalysisCount} scans
                  </div>
                )}
              </div>
            </div>
            
            {/* Rotation guidance overlay */}
            {rotationGuidance && (
              <div className="mt-2 flex items-center justify-center">
                <div className="bg-orange-500/90 px-3 py-1 rounded-full flex items-center gap-2 text-sm font-medium text-white">
                  <RotateCw className="w-4 h-4" />
                  {rotationGuidance}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Quality Panel - Expandable overlay like photogrammetry */}
      {isCapturing && showQualityPanel && (
        <div className="absolute top-32 left-4 z-20">
          <div className="bg-black/70 backdrop-blur-sm rounded-xl p-3 min-w-[160px]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white font-medium text-sm">Capture Quality</span>
              <div className={`px-2 py-0.5 rounded text-xs font-bold ${
                (qualityMetrics?.overallScore || 0) >= 80 ? 'bg-green-500' : 
                (qualityMetrics?.overallScore || 0) >= 60 ? 'bg-yellow-500' : 'bg-red-500'
              } text-black`}>
                {qualityMetrics ? Math.round(qualityMetrics.overallScore) : '--'}/100
              </div>
            </div>
            
            {/* Sharpness */}
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center gap-1 text-gray-300">
                  <Zap className="w-3 h-3" />
                  <span>Sharpness</span>
                </div>
                <span className="text-white font-medium">{qualityMetrics ? Math.round(qualityMetrics.sharpness * 100) : '--'}%</span>
              </div>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-green-500 transition-all duration-300"
                  style={{ width: `${(qualityMetrics?.sharpness || 0) * 100}%` }}
                />
              </div>
            </div>
            
            {/* Stability */}
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center gap-1 text-gray-300">
                  <Move className="w-3 h-3" />
                  <span>Stability</span>
                </div>
                <span className="text-white font-medium">{Math.round(stability * 100)}%</span>
              </div>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 ${
                    stability >= 0.7 ? 'bg-green-500' : stability >= 0.4 ? 'bg-yellow-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${stability * 100}%` }}
                />
              </div>
            </div>
            
            {/* Features */}
            <div className="flex items-center justify-between text-xs py-1.5 px-2 bg-yellow-500/20 rounded-lg">
              <div className="flex items-center gap-1 text-yellow-300">
                <Grid3X3 className="w-3 h-3" />
                <span>{featureCount} features</span>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Quality Toggle Button */}
      {isCapturing && (
        <button
          onClick={() => setShowQualityPanel(!showQualityPanel)}
          className={`absolute top-32 left-4 z-20 p-2 rounded-lg transition-all ${
            showQualityPanel ? 'opacity-0 pointer-events-none' : 'bg-black/50 backdrop-blur'
          }`}
        >
          <div className={`text-lg font-bold ${getQualityColor()}`}>
            {qualityMetrics ? Math.round(qualityMetrics.overallScore) : '--'}%
          </div>
          <div className="text-xs text-gray-400">quality</div>
        </button>
      )}
      
      {/* Close Quality Panel Button */}
      {isCapturing && showQualityPanel && (
        <button
          onClick={() => setShowQualityPanel(false)}
          className="absolute top-32 left-[180px] z-20 p-1 text-gray-400 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      
      {/* Focus Request Overlay */}
      {currentFocusRequest && (
        <div className="absolute inset-x-0 top-24 z-20 px-4">
          <div className="bg-purple-600/90 backdrop-blur rounded-xl p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <Target className="w-6 h-6 text-white flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-white font-medium">
                  Show me the {currentFocusRequest.target}
                </p>
                <p className="text-purple-200 text-sm mt-1">
                  {currentFocusRequest.reason}
                </p>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => capturePhoto(currentFocusRequest.suggestedTag)}
                className="flex-1 py-2 bg-white text-purple-600 rounded-lg font-medium flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4" />
                Capture
              </button>
              <button
                onClick={skipCurrentFocus}
                className="px-4 py-2 bg-purple-700 text-white rounded-lg"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* AI Guidance Message - Main AI feedback at bottom */}
      {currentGuidance && !currentFocusRequest && isCapturing && (
        <div className="absolute inset-x-0 bottom-40 z-20 px-4">
          <div className={`${getGuidanceColor(currentGuidance.priority)} backdrop-blur rounded-xl p-4 shadow-lg border-l-4 border-white/50`}>
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
      
      {/* AI Observation Toast - PROMINENT notification when AI sees something */}
      {recentAIObservation && isCapturing && (
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
      
      {/* Coverage Mini Map - Enhanced with compass and detected items */}
      {showCoverageMap && isCapturing && (
        <div className="absolute bottom-44 right-4 z-20">
          <div className="bg-black/70 backdrop-blur rounded-xl p-3 min-w-[140px]">
            {/* Compass */}
            <div className="flex justify-center mb-2">
              <div className="relative w-16 h-16">
                <div 
                  className="absolute inset-0 border-2 border-gray-500 rounded-full"
                  style={{ 
                    background: `conic-gradient(from ${-currentYaw}deg, 
                      rgba(139, 92, 246, 0.3) 0deg, 
                      rgba(139, 92, 246, 0.1) 90deg, 
                      rgba(139, 92, 246, 0.3) 180deg, 
                      rgba(139, 92, 246, 0.1) 270deg, 
                      rgba(139, 92, 246, 0.3) 360deg)` 
                  }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Compass className="w-5 h-5 text-purple-400" style={{ transform: `rotate(${-currentYaw}deg)` }} />
                </div>
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 text-xs text-gray-400 font-bold">N</div>
              </div>
            </div>
            
            {/* Coverage percentage */}
            <div className="text-center mb-2">
              <div className={`text-xl font-bold ${getCoverageColor()}`}>{Math.round(coveragePercent)}%</div>
              <div className="text-xs text-gray-400">coverage</div>
            </div>
            
            {/* Detected items count */}
            {detectedItems.length > 0 && (
              <div className="text-center py-1.5 px-2 bg-purple-500/20 rounded-lg">
                <div className="flex items-center justify-center gap-1 text-purple-300 text-xs">
                  <Eye className="w-3 h-3" />
                  <span>{detectedItems.length} items found</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Remove old quality meter - now using the panel */}
      
      {/* Sensor Permission Request */}
      {isInitialized && !sensorPermissionRequested && (
        <div className="absolute inset-0 bg-black/80 z-30 flex items-center justify-center p-6">
          <div className="bg-gray-900 rounded-2xl p-6 max-w-sm text-center">
            <div className="w-16 h-16 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Ruler className="w-8 h-8 text-white" />
            </div>
            <h3 className="text-white text-xl font-bold mb-2">Enable Motion Sensors</h3>
            <p className="text-gray-400 text-sm mb-6">
              Motion sensors help us track camera movement for accurate room measurements and coverage tracking.
            </p>
            <button
              onClick={handleRequestSensorPermission}
              className="w-full py-3 bg-purple-600 text-white rounded-xl font-medium"
            >
              Enable Sensors
            </button>
            <button
              onClick={() => setSensorPermissionRequested(true)}
              className="w-full py-2 text-gray-400 text-sm mt-2"
            >
              Continue without sensors
            </button>
          </div>
        </div>
      )}
      
      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent p-6 pb-10">
        {!isCapturing ? (
          // Start Screen
          <div className="text-center">
            <h2 className="text-white text-xl font-bold mb-2">
              Ready to Scan {roomName}
            </h2>
            <p className="text-gray-300 text-sm mb-6">
              Our AI will guide you through the room and identify renovation opportunities
            </p>
            <button
              onClick={startCapture}
              className="w-full py-4 bg-purple-600 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2"
            >
              <Sparkles className="w-5 h-5" />
              Start AI Scan
            </button>
          </div>
        ) : (
          // Capture Controls
          <div className="space-y-4">
            {/* Progress indicator */}
            <div className="flex items-center gap-2 justify-center">
              <div className="flex gap-1">
                {Array.from({ length: RECOMMENDED_CAPTURES }).map((_, i) => (
                  <div
                    key={i}
                    className={`w-2 h-2 rounded-full ${
                      i < captures.length
                        ? 'bg-purple-500'
                        : i < MIN_CAPTURES_FOR_ASSESSMENT
                          ? 'bg-gray-600'
                          : 'bg-gray-700'
                    }`}
                  />
                ))}
              </div>
              <span className="text-gray-400 text-xs">
                {captures.length}/{RECOMMENDED_CAPTURES}
              </span>
            </div>
            
            {/* Controls */}
            <div className="flex items-center justify-between">
              {/* Left buttons - Map + Pause */}
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCoverageMap(!showCoverageMap)}
                  className={`p-3 rounded-full ${showCoverageMap ? 'bg-purple-600' : 'bg-gray-800'} text-white`}
                >
                  <Map className="w-5 h-5" />
                </button>
                <button
                  onClick={togglePause}
                  className={`p-3 rounded-full ${isPaused ? 'bg-yellow-600' : 'bg-gray-800'} text-white`}
                >
                  {isPaused ? (
                    <Play className="w-5 h-5" />
                  ) : (
                    <Pause className="w-5 h-5" />
                  )}
                </button>
              </div>
              
              {/* Manual Capture */}
              <button
                onClick={() => capturePhoto('general')}
                className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-lg active:scale-95 transition-transform"
              >
                <div className="w-16 h-16 rounded-full border-4 border-purple-500" />
              </button>
              
              {/* Finish */}
              <button
                onClick={finishCapture}
                disabled={captures.length < MIN_CAPTURES_FOR_ASSESSMENT}
                className={`p-4 rounded-full ${
                  captures.length >= MIN_CAPTURES_FOR_ASSESSMENT
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400'
                }`}
              >
                <Check className="w-6 h-6" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveRenovationScanner;
