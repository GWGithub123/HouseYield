/**
 * Live Renovation AI Service
 * 
 * Real-time AI copilot that watches the camera feed and:
 * - Identifies renovation opportunities as user scans
 * - Requests specific focus shots ("show me the bathtub closer")
 * - Triggers smart captures when it sees something interesting
 * - Provides voice guidance during scanning
 * 
 * Uses GPT-4 Vision with throttled frame analysis (~every 2-3 seconds)
 */

import {
  LiveAnalysisRequest,
  LiveAnalysisResponse,
  AIGuidanceMessage,
  AIGuidanceType,
  FocusRequest,
  CaptureTag,
  generateFocusRequestId,
} from '../types/liveRenovation';

// =============================================================================
// CONFIGURATION
// =============================================================================

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Throttle settings
const MIN_ANALYSIS_INTERVAL_MS = 2500; // Minimum 2.5 seconds between analyses
const MAX_PENDING_FOCUS_REQUESTS = 3;  // Don't overwhelm user with requests

// Voice synthesis settings
const VOICE_RATE = 1.1;
const VOICE_PITCH = 1.0;

// =============================================================================
// SERVICE STATE
// =============================================================================

interface ServiceState {
  isAnalyzing: boolean;
  lastAnalysisTime: number;
  analysisCount: number;
  detectedRoomType: string | null;
  pendingFocusRequests: FocusRequest[];
  recentTags: CaptureTag[];
  preliminarySuggestions: string[];
  
  // Callbacks
  onGuidance: ((msg: AIGuidanceMessage) => void) | null;
  onCaptureTriggered: ((tag: CaptureTag, reason: string) => void) | null;
  onFocusRequest: ((req: FocusRequest) => void) | null;
}

let state: ServiceState = {
  isAnalyzing: false,
  lastAnalysisTime: 0,
  analysisCount: 0,
  detectedRoomType: null,
  pendingFocusRequests: [],
  recentTags: [],
  preliminarySuggestions: [],
  onGuidance: null,
  onCaptureTriggered: null,
  onFocusRequest: null,
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize the live renovation AI service
 */
export function initLiveRenovationAI(callbacks: {
  onGuidance?: (msg: AIGuidanceMessage) => void;
  onCaptureTriggered?: (tag: CaptureTag, reason: string) => void;
  onFocusRequest?: (req: FocusRequest) => void;
}): void {
  state = {
    isAnalyzing: false,
    lastAnalysisTime: 0,
    analysisCount: 0,
    detectedRoomType: null,
    pendingFocusRequests: [],
    recentTags: [],
    preliminarySuggestions: [],
    onGuidance: callbacks.onGuidance || null,
    onCaptureTriggered: callbacks.onCaptureTriggered || null,
    onFocusRequest: callbacks.onFocusRequest || null,
  };
  
  console.log('[LiveRenovationAI] Initialized');
  
  // Send initial greeting
  sendGuidance({
    type: 'greeting',
    message: "I'm ready to help identify renovation opportunities. Start scanning the room slowly.",
    speak: true,
    priority: 'normal',
  });
}

/**
 * Reset the service state
 */
export function resetLiveRenovationAI(): void {
  state = {
    ...state,
    isAnalyzing: false,
    lastAnalysisTime: 0,
    analysisCount: 0,
    detectedRoomType: null,
    pendingFocusRequests: [],
    recentTags: [],
    preliminarySuggestions: [],
  };
  console.log('[LiveRenovationAI] Reset');
}

/**
 * Analyze a frame from the camera feed
 * Throttled to prevent API overuse
 */
export async function analyzeFrame(
  frameData: string,
  captureCount: number,
  coveragePercent: number
): Promise<LiveAnalysisResponse | null> {
  // Throttle check
  const now = Date.now();
  if (now - state.lastAnalysisTime < MIN_ANALYSIS_INTERVAL_MS) {
    console.log('[LiveRenovationAI] Skipping analysis - throttled');
    return null; // Too soon
  }
  
  if (state.isAnalyzing) {
    console.log('[LiveRenovationAI] Skipping analysis - already analyzing');
    return null; // Already analyzing
  }
  
  state.isAnalyzing = true;
  state.lastAnalysisTime = now;
  console.log('[LiveRenovationAI] 🔍 Starting frame analysis...');
  
  try {
    const request: LiveAnalysisRequest = {
      frameData,
      sessionContext: {
        captureCount,
        coveragePercent,
        recentTags: state.recentTags.slice(-5),
        pendingFocusRequests: state.pendingFocusRequests.filter(r => r.status === 'pending'),
        roomType: state.detectedRoomType || undefined,
      },
    };
    
    console.log('[LiveRenovationAI] Sending request to backend...');
    const response = await fetch(`${API_BASE}/api/renovation/live-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const result: LiveAnalysisResponse = await response.json();
    console.log('[LiveRenovationAI] ✅ Got response:', result.success ? 'success' : 'failed');
    
    // Update state based on response
    if (result.success) {
      state.analysisCount++;
      console.log('[LiveRenovationAI] Analysis count:', state.analysisCount);
      
      // Update detected room type
      if (result.detectedRoomType) {
        state.detectedRoomType = result.detectedRoomType;
      }
      
      // Handle guidance
      if (result.guidance) {
        console.log('[LiveRenovationAI] 💡 Guidance:', result.guidance.message);
        handleGuidance(result.guidance);
      }
      
      // Log observations
      if (result.observations && result.observations.length > 0) {
        console.log('[LiveRenovationAI] 👀 Detected:', result.observations.join(', '));
      }
      
      // Handle new focus requests
      if (result.newFocusRequests?.length) {
        for (const req of result.newFocusRequests) {
          if (state.pendingFocusRequests.length < MAX_PENDING_FOCUS_REQUESTS) {
            state.pendingFocusRequests.push(req);
            state.onFocusRequest?.(req);
          }
        }
      }
      
      // Handle capture trigger
      if (result.triggerCapture && result.captureTag) {
        state.recentTags.push(result.captureTag);
        state.onCaptureTriggered?.(result.captureTag, result.captureReason || 'AI identified renovation opportunity');
      }
      
      // Store preliminary suggestions
      if (result.preliminarySuggestions?.length) {
        state.preliminarySuggestions = [
          ...state.preliminarySuggestions,
          ...result.preliminarySuggestions,
        ];
      }
    }
    
    return result;
    
  } catch (error) {
    console.error('[LiveRenovationAI] Analysis error:', error);
    return {
      success: false,
      observations: [],
      processingTimeMs: Date.now() - now,
    };
  } finally {
    state.isAnalyzing = false;
  }
}

/**
 * Mark a focus request as completed
 */
export function completeFocusRequest(requestId: string, captureId: string): void {
  const request = state.pendingFocusRequests.find(r => r.id === requestId);
  if (request) {
    request.status = 'completed';
    request.completedCaptures.push(captureId);
    
    sendGuidance({
      type: 'observation',
      message: `Got it! Nice shot of the ${request.target}.`,
      speak: true,
      priority: 'low',
    });
  }
}

/**
 * Skip a focus request (user doesn't want to capture it)
 */
export function skipFocusRequest(requestId: string): void {
  const request = state.pendingFocusRequests.find(r => r.id === requestId);
  if (request) {
    request.status = 'skipped';
  }
}

/**
 * Get current pending focus requests
 */
export function getPendingFocusRequests(): FocusRequest[] {
  return state.pendingFocusRequests.filter(r => r.status === 'pending');
}

/**
 * Get preliminary suggestions collected during scanning
 */
export function getPreliminarySuggestions(): string[] {
  return [...new Set(state.preliminarySuggestions)]; // Dedupe
}

/**
 * Get current state for debugging
 */
export function getServiceState(): Readonly<ServiceState> {
  return { ...state };
}

/**
 * Record that a capture was made (updates recent tags)
 */
export function recordCapture(tag: CaptureTag): void {
  state.recentTags.push(tag);
  if (state.recentTags.length > 20) {
    state.recentTags = state.recentTags.slice(-20);
  }
}

// =============================================================================
// VOICE GUIDANCE
// =============================================================================

/**
 * Speak a message using text-to-speech
 */
export function speakGuidance(message: string, priority: 'low' | 'normal' | 'high' = 'normal'): void {
  if (!('speechSynthesis' in window)) {
    console.warn('[LiveRenovationAI] Speech synthesis not supported');
    return;
  }
  
  // Cancel current speech for high priority
  if (priority === 'high') {
    window.speechSynthesis.cancel();
  }
  
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = VOICE_RATE;
  utterance.pitch = VOICE_PITCH;
  
  // Try to find a good voice
  const voices = window.speechSynthesis.getVoices();
  const preferredVoice = voices.find(v => 
    v.name.includes('Samantha') || 
    v.name.includes('Google') ||
    v.lang === 'en-US'
  );
  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }
  
  window.speechSynthesis.speak(utterance);
}

/**
 * Stop all speech
 */
export function stopSpeaking(): void {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function handleGuidance(guidance: AIGuidanceMessage): void {
  // Speak if requested
  if (guidance.speak) {
    speakGuidance(guidance.message, guidance.priority);
  }
  
  // Notify callback
  state.onGuidance?.(guidance);
}

function sendGuidance(partial: {
  type: AIGuidanceType;
  message: string;
  speak?: boolean;
  priority: 'low' | 'normal' | 'high';
  focusRequest?: FocusRequest;
  triggerCapture?: boolean;
}): void {
  const guidance: AIGuidanceMessage = {
    id: `guidance_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: Date.now(),
    ...partial,
  };
  
  handleGuidance(guidance);
}

// =============================================================================
// LOCAL GUIDANCE (for when API is slow/unavailable)
// =============================================================================

const SCAN_TIPS: string[] = [
  "Move slowly for sharper images.",
  "Try to capture all walls and corners.",
  "Get closer to any worn or damaged areas.",
  "Don't forget to look up at the ceiling.",
  "Floor areas near walls often show wear.",
];

let tipIndex = 0;

/**
 * Generate local guidance when API is unavailable
 */
export function getLocalGuidance(captureCount: number, coveragePercent: number): AIGuidanceMessage | null {
  // Only provide tips periodically
  if (captureCount > 0 && captureCount % 8 === 0) {
    const tip = SCAN_TIPS[tipIndex % SCAN_TIPS.length];
    tipIndex++;
    
    return {
      id: `local_${Date.now()}`,
      timestamp: Date.now(),
      type: 'instruction',
      message: tip,
      speak: false,
      priority: 'low',
    };
  }
  
  // Coverage hints
  if (coveragePercent > 0 && coveragePercent < 50 && captureCount > 15) {
    return {
      id: `coverage_${Date.now()}`,
      timestamp: Date.now(),
      type: 'coverage_hint',
      message: `Coverage is ${coveragePercent.toFixed(0)}%. Try to scan more of the room.`,
      speak: true,
      priority: 'normal',
    };
  }
  
  // Progress updates
  if (coveragePercent >= 80 && captureCount >= 25) {
    return {
      id: `progress_${Date.now()}`,
      timestamp: Date.now(),
      type: 'progress',
      message: "Good coverage! You can finish the scan now or continue for more detail.",
      speak: true,
      priority: 'normal',
    };
  }
  
  return null;
}

// =============================================================================
// FOCUS REQUEST GENERATION (client-side fallback)
// =============================================================================

const COMMON_FOCUS_TARGETS: Array<{ target: string; tag: CaptureTag; reason: string }> = [
  { target: 'floor', tag: 'floor', reason: 'Check flooring condition' },
  { target: 'kitchen cabinets', tag: 'cabinets', reason: 'Assess cabinet condition' },
  { target: 'bathroom vanity', tag: 'vanity', reason: 'Check vanity for replacement' },
  { target: 'countertops', tag: 'countertop', reason: 'Inspect countertop surfaces' },
  { target: 'bathtub or shower', tag: 'bathtub', reason: 'Check tub/shower condition' },
  { target: 'windows', tag: 'window', reason: 'Assess window condition' },
];

/**
 * Generate a focus request based on what hasn't been captured yet
 */
export function generateFocusRequest(recentTags: CaptureTag[]): FocusRequest | null {
  // Find a target that hasn't been captured
  for (const item of COMMON_FOCUS_TARGETS) {
    if (!recentTags.includes(item.tag)) {
      return {
        id: generateFocusRequestId(),
        target: item.target,
        reason: item.reason,
        suggestedTag: item.tag,
        status: 'pending',
        completedCaptures: [],
      };
    }
  }
  return null;
}
