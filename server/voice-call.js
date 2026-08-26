/**
 * Voice Call Module - Twilio + OpenAI Realtime Integration
 * 
 * This module provides voice call automation for maintenance scheduling.
 * Can be safely imported into the main server without causing crashes.
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import {
  saveVoiceCallContext,
  saveVoiceCallContextByPhone,
  loadVoiceCallContext,
  deleteVoiceCallContext,
  appendVoiceCallTranscriptLine,
  rememberRecentCallContextByPhone,
  lookupRecentCallContextByPhone,
  resolveMaintenanceContextForInbound
} from './voice-call-context-store.js';
import { processCompletedMaintenanceCall } from './maintenance-visit-scheduler.js';
import {
  isPracticeModeEnabled,
  resolvePracticeCallPhone,
  resolvePracticeSmsPhone,
} from './utils/practiceTestPhone.js';

const execAsync = promisify(exec);

// ===================================================================
// CONFIGURATION
// ===================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// OpenAI Realtime API uses 24kHz PCM16 (checked in API docs)
const OPENAI_SAMPLE_RATE = 24000;
const TWILIO_SAMPLE_RATE = 8000;

// Output path: 'pcmu' = OpenAI native g711 μ-law → Twilio (best for phone, lowest artifacts).
// 'pcm' = PCM @ 24kHz + in-process downsample (can sound muffled/underwater on some paths).
const VOICE_PHONE_OUTPUT_MODE = (process.env.VOICE_PHONE_OUTPUT_MODE || 'pcmu').toLowerCase() === 'pcm'
  ? 'pcm'
  : 'pcmu';

// Telephony pre-emphasis (0 = off). Only helps lightly on pcmu; high values sound harsh/underwater.
const TELEPHONY_PREEMPHASIS_DEFAULT = VOICE_PHONE_OUTPUT_MODE === 'pcm' ? 0.45 : 0;
const TELEPHONY_PREEMPHASIS = Math.max(
  0,
  Math.min(0.97, Number(process.env.VOICE_PHONE_TELEPHONY_PREEMPHASIS ?? TELEPHONY_PREEMPHASIS_DEFAULT))
);

// Gentle output gain after pre-emphasis to avoid clipping.
const AUDIO_BOOST = Math.max(0.5, Math.min(1.5, Number(process.env.VOICE_PHONE_AUDIO_BOOST ?? 1.0)));

// Server VAD tuning for phone calls — shorter silence = snappier replies.
const VAD_SILENCE_DURATION_MS = Math.max(
  200,
  Math.min(900, Number(process.env.VOICE_PHONE_VAD_SILENCE_MS ?? 350))
);
const VAD_PREFIX_PADDING_MS = Math.max(
  100,
  Math.min(500, Number(process.env.VOICE_PHONE_VAD_PREFIX_MS ?? 300))
);

function buildTurnDetectionConfig(createResponse) {
  return {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: VAD_PREFIX_PADDING_MS,
    silence_duration_ms: VAD_SILENCE_DURATION_MS,
    create_response: createResponse,
    interrupt_response: true
  };
}

// Track active WebSocket connections
const activeSockets = new Set();

// Store maintenance context for active calls (keyed by callSid)
const callContextStore = new Map();
const callAnsweredByStore = new Map();

function isVoicemailAnsweredBy(answeredBy = '') {
  const normalized = String(answeredBy).toLowerCase();
  return normalized.includes('machine') || normalized === 'fax';
}

export function setCallAnsweredBy(callSid, answeredBy) {
  if (!callSid) {
    return;
  }
  callAnsweredByStore.set(callSid, answeredBy);
}

// Supported OpenAI Realtime voices
const OPENAI_REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

function sanitizeRealtimeVoice(voice, fallback = 'marin') {
  const safeVoice = String(voice || '').replace(/[^a-zA-Z0-9-_]/g, '');
  return OPENAI_REALTIME_VOICES.includes(safeVoice) ? safeVoice : fallback;
}

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [Voice] Twilio client initialized with API Key');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [Voice] Twilio client initialized with Auth Token');
} else {
  console.warn('⚠️  [Voice] Twilio not configured - voice calls disabled');
}

async function hangUpCall(callSid, reason = 'call complete') {
  if (!callSid || !twilioClient) {
    return false;
  }

  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[Voice] 📴 Hung up call ${callSid}: ${reason}`);
    return true;
  } catch (error) {
    console.warn(`[Voice] Failed to hang up ${callSid}:`, error.message);
    return false;
  }
}

function estimateSpeechPlaybackMs(text, bufferMs = 1500) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const estimatedMs = words > 0 ? Math.ceil((words / 2.6) * 1000) : 4000;
  return estimatedMs + bufferMs;
}

console.log('[Voice] Phone audio output:', {
  mode: VOICE_PHONE_OUTPUT_MODE,
  preEmphasis: TELEPHONY_PREEMPHASIS,
  gain: AUDIO_BOOST
});

// ===================================================================
// AUDIO FORMAT CONVERSION - USING FFMPEG FOR PROFESSIONAL QUALITY
// ===================================================================
// OpenAI: PCM16 @ 24kHz
// Twilio: μ-law @ 8kHz
// Using FFmpeg for broadcast-quality resampling and conversion (legacy fallback only)

// Check if FFmpeg is available
let ffmpegAvailable = false;
exec('ffmpeg -version', (err) => {
  ffmpegAvailable = !err;
  if (ffmpegAvailable) {
    console.log('✅ [Voice] FFmpeg available for high-quality audio processing');
  } else {
    console.log('⚠️  [Voice] FFmpeg not found, using fallback audio processing');
  }
});

// μ-law encoding constants
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulaw(sample) {
  let sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  
  sample += MULAW_BIAS;
  
  let exponent = 7;
  for (let mask = 0x4000; mask !== 0x40; mask >>= 1) {
    if (sample >= mask) break;
    exponent--;
  }
  
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulaw = ~(sign | (exponent << 4) | mantissa);
  
  return mulaw & 0xFF;
}

function mulawToLinear(mulaw) {
  mulaw = ~mulaw;
  let sign = (mulaw & 0x80) !== 0;
  let exponent = (mulaw >> 4) & 0x07;
  let mantissa = mulaw & 0x0F;
  
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  
  return sign ? -sample : sample;
}

// Convert Twilio μ-law buffer to PCM16
function mulawToPcm16(mulawBuffer) {
  const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const linear = mulawToLinear(mulawBuffer[i]);
    pcm16Buffer.writeInt16LE(linear, i * 2);
  }
  return pcm16Buffer;
}

// Convert PCM16 to Twilio μ-law with optional gain.
function pcm16ToMulaw(pcm16Buffer, gain = 1.0) {
  const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
  for (let i = 0; i < pcm16Buffer.length; i += 2) {
    const sample = pcm16Buffer.readInt16LE(i);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    mulawBuffer[i / 2] = linearToMulaw(scaled);
  }
  return mulawBuffer;
}

// First-order telephony pre-emphasis: y[n] = x[n] - α·x[n-1]
function applyTelephonyPreEmphasis(pcm16Buffer, alpha, state = { prevSample: 0 }) {
  if (alpha <= 0) {
    return state;
  }

  let prev = state.prevSample;
  for (let i = 0; i < pcm16Buffer.length; i += 2) {
    const sample = pcm16Buffer.readInt16LE(i);
    const emphasized = sample - alpha * prev;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(emphasized)));
    pcm16Buffer.writeInt16LE(clamped, i);
    prev = sample;
  }

  state.prevSample = prev;
  return state;
}

const DOWNSAMPLE_FILTER_TAPS = [
  0.01, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.13, 0.14, 0.15, 0.15,
  0.15, 0.14, 0.13, 0.12, 0.10, 0.08, 0.06, 0.04, 0.02, 0.01
];
const DOWNSAMPLE_FILTER_CENTER = 10;
const DOWNSAMPLE_PREFIX_SAMPLES = DOWNSAMPLE_FILTER_CENTER;

// Stateful 24 kHz → 8 kHz downsample for streaming audio chunks.
function downsample24kTo8kStreaming(pcm16_24k, state = { prefixSamples: [] }) {
  const inputSamples = [];
  for (const sample of state.prefixSamples) {
    inputSamples.push(sample);
  }
  for (let i = 0; i < pcm16_24k.length; i += 2) {
    inputSamples.push(pcm16_24k.readInt16LE(i));
  }

  const newSampleCount = pcm16_24k.length / 2;
  const samplesOut = Math.floor(newSampleCount / 3);
  const pcm16_8k = Buffer.alloc(samplesOut * 2);
  const startInputIdx = state.prefixSamples.length;

  for (let i = 0; i < samplesOut; i++) {
    const centerIdx = startInputIdx + i * 3;
    let sum = 0;
    let weightSum = 0;

    for (let j = 0; j < DOWNSAMPLE_FILTER_TAPS.length; j++) {
      const sampleIdx = centerIdx + j - DOWNSAMPLE_FILTER_CENTER;
      if (sampleIdx >= 0 && sampleIdx < inputSamples.length) {
        sum += inputSamples[sampleIdx] * DOWNSAMPLE_FILTER_TAPS[j];
        weightSum += DOWNSAMPLE_FILTER_TAPS[j];
      }
    }

    const filtered = weightSum > 0 ? sum / weightSum : 0;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(filtered)));
    pcm16_8k.writeInt16LE(clamped, i * 2);
  }

  const carryStart = Math.max(0, inputSamples.length - DOWNSAMPLE_PREFIX_SAMPLES);
  state.prefixSamples = inputSamples.slice(carryStart);

  return { pcm16_8k, state };
}

function createPhoneAudioOutputProcessor() {
  return {
    downsampleState: { prefixSamples: [] },
    preEmphasisState: { prevSample: 0 }
  };
}

// In-process PCM @ 24 kHz → μ-law @ 8 kHz (no FFmpeg spawn per chunk).
function convertOpenAIPcm24kToTwilioMulaw(pcm16_24k, processor) {
  const { pcm16_8k, state: downsampleState } = downsample24kTo8kStreaming(
    pcm16_24k,
    processor.downsampleState
  );
  processor.downsampleState = downsampleState;

  applyTelephonyPreEmphasis(pcm16_8k, TELEPHONY_PREEMPHASIS, processor.preEmphasisState);

  return pcm16ToMulaw(pcm16_8k, AUDIO_BOOST);
}

// Optional pre-emphasis on native μ-law passthrough path.
function applyTelephonyPreEmphasisToMulaw(mulawBuffer, processor) {
  if (TELEPHONY_PREEMPHASIS <= 0) {
    return mulawBuffer;
  }

  const pcm8k = mulawToPcm16(mulawBuffer);
  applyTelephonyPreEmphasis(pcm8k, TELEPHONY_PREEMPHASIS, processor.preEmphasisState);
  return pcm16ToMulaw(pcm8k, AUDIO_BOOST);
}

// ===================================================================
// FFMPEG-BASED HIGH-QUALITY AUDIO CONVERSION
// ===================================================================

// Convert OpenAI PCM16 24kHz to Twilio μ-law 8kHz using FFmpeg
async function convertOpenAIToTwilioFFmpeg(pcm16_24k) {
  if (!ffmpegAvailable) {
    // Fallback to JS implementation
    const pcm8k = downsample24kTo8k(pcm16_24k);
    return pcm16ToMulaw(pcm8k);
  }

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le',           // Input format: signed 16-bit little-endian
      '-ar', '24000',          // Input sample rate: 24kHz
      '-ac', '1',              // Input channels: mono
      '-i', 'pipe:0',          // Read from stdin
      '-ar', '8000',           // Output sample rate: 8kHz  
      '-ac', '1',              // Output channels: mono
      '-acodec', 'pcm_mulaw',  // Output codec: μ-law
      '-f', 'mulaw',           // Output format
      'pipe:1'                 // Write to stdout
    ]);

    const chunks = [];
    
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        // Fallback on error
        const pcm8k = downsample24kTo8k(pcm16_24k);
        resolve(pcm16ToMulaw(pcm8k));
      }
    });

    ffmpeg.on('error', () => {
      const pcm8k = downsample24kTo8k(pcm16_24k);
      resolve(pcm16ToMulaw(pcm8k));
    });

    ffmpeg.stdin.write(pcm16_24k);
    ffmpeg.stdin.end();
  });
}

// Convert Twilio μ-law 8kHz to OpenAI PCM16 24kHz using FFmpeg
async function convertTwilioToOpenAIFFmpeg(mulawBuffer) {
  if (!ffmpegAvailable) {
    // Fallback to JS implementation
    const pcm8k = mulawToPcm16(mulawBuffer);
    return upsample8kTo24k(pcm8k);
  }

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mulaw',           // Input format: μ-law
      '-ar', '8000',           // Input sample rate: 8kHz
      '-ac', '1',              // Input channels: mono
      '-i', 'pipe:0',          // Read from stdin
      '-ar', '24000',          // Output sample rate: 24kHz
      '-ac', '1',              // Output channels: mono
      '-acodec', 'pcm_s16le',  // Output codec: signed 16-bit LE
      '-f', 's16le',           // Output format
      'pipe:1'                 // Write to stdout
    ]);

    const chunks = [];
    
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        // Fallback
        const pcm8k = mulawToPcm16(mulawBuffer);
        resolve(upsample8kTo24k(pcm8k));
      }
    });

    ffmpeg.on('error', () => {
      const pcm8k = mulawToPcm16(mulawBuffer);
      resolve(upsample8kTo24k(pcm8k));
    });

    ffmpeg.stdin.write(mulawBuffer);
    ffmpeg.stdin.end();
  });
}

// Resample 8kHz → 24kHz (3x upsampling with cubic interpolation)
function upsample8kTo24k(pcm16_8k) {
  const samplesIn = pcm16_8k.length / 2;
  const samplesOut = samplesIn * 3;
  const pcm16_24k = Buffer.alloc(samplesOut * 2);
  
  for (let i = 0; i < samplesIn; i++) {
    const sm1 = i > 0 ? pcm16_8k.readInt16LE((i - 1) * 2) : pcm16_8k.readInt16LE(i * 2);
    const s0 = pcm16_8k.readInt16LE(i * 2);
    const s1 = i < samplesIn - 1 ? pcm16_8k.readInt16LE((i + 1) * 2) : s0;
    const s2 = i < samplesIn - 2 ? pcm16_8k.readInt16LE((i + 2) * 2) : s1;
    
    pcm16_24k.writeInt16LE(s0, i * 6);
    
    for (let j = 1; j < 3; j++) {
      const t = j / 3;
      const t2 = t * t;
      const t3 = t2 * t;
      
      const c0 = -0.5 * sm1 + 1.5 * s0 - 1.5 * s1 + 0.5 * s2;
      const c1 = sm1 - 2.5 * s0 + 2 * s1 - 0.5 * s2;
      const c2 = -0.5 * sm1 + 0.5 * s1;
      const c3 = s0;
      
      const interpolated = c0 * t3 + c1 * t2 + c2 * t + c3;
      const clamped = Math.max(-32768, Math.min(32767, Math.round(interpolated)));
      pcm16_24k.writeInt16LE(clamped, i * 6 + j * 2);
    }
  }
  
  return pcm16_24k;
}

// Resample 24kHz → 8kHz with better filter
function downsample24kTo8k(pcm16_24k) {
  const samplesIn = pcm16_24k.length / 2;
  const samplesOut = Math.floor(samplesIn / 3);
  const pcm16_8k = Buffer.alloc(samplesOut * 2);
  
  // 21-tap low-pass filter for better quality
  const filterTaps = [
    0.01, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.13, 0.14, 0.15, 0.15,
    0.15, 0.14, 0.13, 0.12, 0.10, 0.08, 0.06, 0.04, 0.02, 0.01
  ];
  const filterCenter = 10;
  
  for (let i = 0; i < samplesOut; i++) {
    let sum = 0;
    let weightSum = 0;
    
    for (let j = 0; j < filterTaps.length; j++) {
      const sampleIdx = i * 3 + j - filterCenter;
      if (sampleIdx >= 0 && sampleIdx < samplesIn) {
        const sample = pcm16_24k.readInt16LE(sampleIdx * 2);
        sum += sample * filterTaps[j];
        weightSum += filterTaps[j];
      }
    }
    
    const filtered = weightSum > 0 ? sum / weightSum : 0;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(filtered)));
    pcm16_8k.writeInt16LE(clamped, i * 2);
  }
  
  return pcm16_8k;
}

// ===================================================================
// WEBSOCKET MEDIA STREAMING
// ===================================================================

function setupWebSocketServer(httpServer, publicUrl) {
  // Use noServer mode so we can share the http server with other WebSocket servers
  const wss = new WebSocketServer({
    noServer: true
    // Removed handleProtocols - Twilio may not send protocol headers
  });

  // Register upgrade handler on the http server
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/twilio-media') {
      console.log('[Voice-WS] 🔄 Handling WebSocket upgrade for /twilio-media');
      console.log('[Voice-WS] Upgrade headers:', JSON.stringify({
        'sec-websocket-key': request.headers['sec-websocket-key'],
        'sec-websocket-version': request.headers['sec-websocket-version'],
        'sec-websocket-protocol': request.headers['sec-websocket-protocol'],
        'sec-websocket-extensions': request.headers['sec-websocket-extensions']
      }));
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Other paths will be handled by other WebSocket servers
  });

  wss.on('connection', async (ws, req) => {
    console.log('[Voice-WS] ========== NEW TWILIO MEDIA CONNECTION ==========');
    console.log('[Voice-WS] Connection timestamp:', new Date().toISOString());
    console.log('[Voice-WS] Headers:', JSON.stringify({
      host: req.headers.host,
      origin: req.headers.origin,
      'user-agent': req.headers['user-agent'],
      upgrade: req.headers.upgrade,
      connection: req.headers.connection
    }, null, 2));
    console.log('[Voice-WS] WebSocket readyState:', ws.readyState);
    
    // Add error handler immediately to catch any errors
    ws.on('error', (error) => {
      console.error('[Voice-WS] WebSocket error IMMEDIATELY after connect:', error);
    });
    
    // Add pong handler to confirm connection is alive
    ws.on('pong', () => {
      console.log('[Voice-WS] Received pong - connection confirmed alive');
    });
    
    // Send a ping to keep the connection alive
    try {
      ws.ping();
      console.log('[Voice-WS] Ping sent successfully');
    } catch (pingError) {
      console.error('[Voice-WS] Failed to send ping:', pingError.message);
    }
    
    // Log when we receive the first message
    let messageCount = 0;
    const originalOnMessage = ws.onmessage;
    
    // SECURITY: Limit active connections to prevent DoS
    if (activeSockets.size >= 10) {
      console.warn('[Voice-WS] SECURITY: Too many active connections, rejecting new connection');
      ws.close(1008, 'Too many active connections');
      return;
    }
    
    activeSockets.add(ws);
    console.log('[Voice-WS] Added to active sockets. Total active:', activeSockets.size);
    
    let openaiWs = null;
    let streamSid = null;
    let callSid = null;
    let audioPacketCount = 0;
    let vadTimer = null;
    const audioOutputProcessor = createPhoneAudioOutputProcessor();

    // SECURITY: Set connection timeout to prevent zombie connections
    const connectionTimeout = setTimeout(() => {
      console.warn('[Voice-WS] SECURITY: Connection timeout, closing');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Connection timeout');
      }
    }, 15 * 60 * 1000); // 15 minutes max connection time

    // Build AI instructions based on context
    const getAIInstructions = (maintenanceContext = null, callMode = 'live') => {
      let baseInstructions = callMode === 'voicemail'
        ? `You're Ava, a friendly property manager at HouseYield leaving a voicemail for a maintenance provider.

VOICEMAIL MODE:
- Deliver ONE continuous message without pausing for responses
- Introduce yourself briefly as Ava from HouseYield
- Clearly explain the repair issue, property address, and tenant availability
- Ask them to call back to schedule the visit
- Keep it concise but complete — this is a voicemail, not a live conversation`
        : `You're Ava, a friendly property manager at HouseYield calling to schedule a repair. You sound like a real person having a normal phone conversation.

LIVE CALL ETIQUETTE — VERY IMPORTANT:
- WAIT for the person to greet you first (e.g. "Hello?", "ABC Plumbing", "This is Mike")
- Match their greeting naturally before explaining why you're calling
- Your first response should be SHORT: introduce yourself and ask if now is a good time
- Do NOT explain the full repair issue until they confirm they have a moment to talk
- After they say yes or engage, THEN explain the issue one piece at a time

YOUR INTRODUCTION (only after they speak first):
- "Hi, this is Ava — I work with HouseYield property management."
- Then ask if now is a good time before going into details

BE GENERALLY NATURAL:
- Sound warm, calm, and conversational
- Use contractions and everyday language when it fits
- Keep the flow smooth and easy, like a normal work call
- React naturally to what they say without sounding scripted
- Stay professional, but not stiff or overly formal

CONVERSATION STYLE:
- Keep responses short and conversational - don't monologue
- Ask one thing at a time
- Listen and respond naturally to what they say
- Don't sound like you're reading from a script
- Be warm but professional
- Match their energy level

AVOID:
- Jumping straight into the issue before they greet you
- Formal or stiff language ("I am calling to inquire...")
- Robotic or rehearsed tone
- Long explanations on your first turn

GOAL: Schedule the repair naturally, like you've made hundreds of these calls before.`;

      if (callMode === 'inbound') {
        baseInstructions = `You're Ava, a friendly property manager at HouseYield answering an inbound phone call.

FIRST TURN — STRICT (most important):
- Your opening must be ONE short sentence, then stop and wait
- Example: "Hi, this is Ava with HouseYield — how can I help?"
- Do NOT mention repairs, properties, callbacks, or maintenance on your first turn
- Do NOT ask multiple questions in your opening
- Maximum ~12 words for your hello unless the caller speaks first

AFTER THEY RESPOND:
- Keep replies short — 1-2 sentences
- Ask one thing at a time
- If they are calling back about your earlier outbound call, confirm the repair and address — you already have the full request on file
- Do not make them repeat details you already know from the prior call

STYLE: Warm, calm, conversational. Sound like a real person, not a script.`;
      }

      if (callMode === 'inbound' && maintenanceContext?.priorCallSummary) {
        baseInstructions += `\n\nPRIOR OUTBOUND CALL WITH THIS PROVIDER (they may be calling back about this):
${maintenanceContext.priorCallSummary}

When they confirm they are returning your call, use the details above immediately. You placed the original call — act like you remember the full maintenance request.`;
      }

      // Add maintenance-specific context if provided
      if (maintenanceContext) {
        const { issue, urgency, location, serviceCategory, tenantAvailability, tenantName, tenantEmail, propertyAddress } = maintenanceContext;
        
        baseInstructions += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL MAINTENANCE INFORMATION - USE THIS IN YOUR CALL:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        if (issue) {
          baseInstructions += `\n\n🔧 THE PROBLEM THAT NEEDS TO BE FIXED:
"${issue}"
→ ${callMode === 'live'
  ? 'ONLY explain this after they greet you and confirm they have time to talk'
  : callMode === 'inbound'
    ? 'Do NOT mention this on your opening hello — only after they confirm they are calling back about the repair'
    : 'Explain this clearly in your voicemail message'}`;
        }
        
        if (urgency) {
          const urgencyLevel = urgency.toLowerCase();
          if (urgencyLevel === 'emergency' || urgencyLevel === 'high') {
            baseInstructions += `\n\n⚠️ URGENCY LEVEL: ${urgencyLevel.toUpperCase()}
This is ${urgencyLevel === 'emergency' ? 'an EMERGENCY' : 'HIGH PRIORITY'} - emphasize that it needs immediate attention!`;
          } else {
            baseInstructions += `\n\n📋 URGENCY: ${urgency} priority - can be scheduled normally`;
          }
        }
        
        if (propertyAddress) {
          baseInstructions += `\n\n📍 SERVICE ADDRESS:
${propertyAddress}`;
          if (location) {
            baseInstructions += `
Location within property: ${location}`;
          }
        } else if (location) {
          baseInstructions += `\n\n📍 LOCATION: ${location}`;
        }
        
        if (serviceCategory) {
          baseInstructions += `\n\n🔨 TYPE OF SERVICE NEEDED: ${serviceCategory}`;
        }
        
        if (tenantAvailability) {
          baseInstructions += `\n\n🗓️ TENANT AVAILABILITY - VERY IMPORTANT:
${tenantAvailability}

→ Make sure the maintenance company schedules within these times!
→ Clearly communicate these availability windows to them
→ Ask them what works best within this schedule`;
        } else {
          baseInstructions += `\n\n🗓️ TENANT AVAILABILITY: Not specified
→ Ask the maintenance company for their available times and you'll coordinate with the tenant`;
        }
        
        if (tenantName || tenantEmail) {
          baseInstructions += `\n\n👤 TENANT CONTACT INFO:`;
          if (tenantName) {
            baseInstructions += `\nTenant: ${tenantName}`;
          }
          if (tenantEmail) {
            baseInstructions += `\nEmail: ${tenantEmail}`;
          }
        }

        baseInstructions += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${callMode === 'live'
  ? 'REMEMBER: Wait for their greeting first. Do NOT use the details above until they confirm they have time.'
  : callMode === 'inbound'
    ? 'REMEMBER: Opening hello only — name + HouseYield + one short question. Save ALL details above for later in the call.'
    : 'REMEMBER: Deliver all relevant details above in one continuous voicemail message.'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      }

      return baseInstructions;
    };

    let openingGreetingSent = false;
    let voicemailMode = false;
    let liveConversationStarted = false;
    let voicemailHangUpScheduled = false;
    let voicemailPlaybackEstimateMs = 4000;
    let isInboundCall = false;
    let turnTakingEnabled = false;
    let assistantSpeaking = false;
    let activeResponseId = null;
    let lastAssistantTranscript = '';
    let enableTurnTakingTimer = null;
    let maintenanceContextRef = null;
    let inboundGreetingFallbackTimer = null;

    const clearInboundGreetingFallback = () => {
      if (inboundGreetingFallbackTimer) {
        clearTimeout(inboundGreetingFallbackTimer);
        inboundGreetingFallbackTimer = null;
      }
    };

    const scheduleInitialGreetingFallback = (maintenanceContext = null) => {
      if (openingGreetingSent || voicemailMode) {
        return;
      }

      clearInboundGreetingFallback();
      const delayMs = isInboundCall ? 1800 : 400;
      inboundGreetingFallbackTimer = setTimeout(() => {
        inboundGreetingFallbackTimer = null;
        maybeStartInitialGreeting(maintenanceContext);
      }, delayMs);
    };

    const clearTwilioAudioBuffer = () => {
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
      }
    };

    const disableTurnTaking = () => {
      turnTakingEnabled = false;
      if (enableTurnTakingTimer) {
        clearTimeout(enableTurnTakingTimer);
        enableTurnTakingTimer = null;
      }
    };

    const enableNaturalTurnTaking = () => {
      if (voicemailMode || turnTakingEnabled || openaiWs?.readyState !== WebSocket.OPEN) {
        return;
      }

      turnTakingEnabled = true;
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          audio: {
            input: {
              turn_detection: buildTurnDetectionConfig(true)
            }
          }
        }
      }));
      console.log('[Voice-AI] Enabled natural turn-taking after assistant playback');
    };

    const scheduleEnableTurnTaking = (transcriptText = '') => {
      if (voicemailMode) {
        return;
      }

      disableTurnTaking();
      const delayMs = Math.min(estimateSpeechPlaybackMs(transcriptText, 400), 800);
      enableTurnTakingTimer = setTimeout(() => {
        enableTurnTakingTimer = null;
        assistantSpeaking = false;
        enableNaturalTurnTaking();
      }, delayMs);
    };

    const maybeStartInitialGreeting = (maintenanceContext = null) => {
      maybeStartVoicemailMode(maintenanceContext);
      if (openingGreetingSent || voicemailMode) {
        return;
      }
      if (isInboundCall) {
        triggerInboundGreeting(maintenanceContext);
        return;
      }
      triggerOutboundGreeting(maintenanceContext);
    };

    const buildIssueDetails = (maintenanceContext) => {
      const issueLine = maintenanceContext?.issue
        ? ` The repair issue is: ${maintenanceContext.issue}.`
        : '';
      const propertyLine = maintenanceContext?.propertyAddress
        ? ` The property address is ${maintenanceContext.propertyAddress}.`
        : '';
      const availabilityLine = maintenanceContext?.tenantAvailability
        ? ` Tenant availability: ${maintenanceContext.tenantAvailability}.`
        : '';
      return { issueLine, propertyLine, availabilityLine };
    };

    const triggerVoicemailMessage = (maintenanceContext = null) => {
      if (openingGreetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      clearInboundGreetingFallback();

      const { issueLine, propertyLine, availabilityLine } = buildIssueDetails(maintenanceContext);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[System: You reached voicemail. Leave one continuous voicemail message. Introduce yourself as Ava from HouseYield, explain you're calling to coordinate a repair,${issueLine}${propertyLine}${availabilityLine} Ask them to call back to schedule. Do not ask questions or wait for a response.]`
          }]
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
      openingGreetingSent = true;
      console.log('[Voice-AI] Triggered voicemail message');
    };

    const triggerOutboundGreeting = (maintenanceContext = null) => {
      if (openingGreetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      clearInboundGreetingFallback();
      liveConversationStarted = true;

      const addressHint = maintenanceContext?.propertyAddress
        ? ` at ${maintenanceContext.propertyAddress}`
        : '';
      const outboundIntro = maintenanceContext?.propertyAddress
        ? ` and say you are calling about coordinating a repair${addressHint}`
        : ' and say you are calling about coordinating a maintenance repair';

      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[System: Outbound call — the person just answered. Immediately introduce yourself as Ava from HouseYield${outboundIntro}. Ask if now is a good time to talk. Use exactly 1-2 short sentences. Do NOT explain the full issue yet.]`,
          }],
        },
      }));
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions: 'Speak first in 1-2 short, natural sentences. Introduce yourself, mention HouseYield and the repair, ask if it is a good time. Then stop and listen.',
          max_output_tokens: 120,
        },
      }));
      openingGreetingSent = true;
      console.log('[Voice-AI] Triggered outbound greeting (Ava speaks first)');
    };

    const triggerLiveGreeting = (maintenanceContext = null, userGreeting = '') => {
      if (openingGreetingSent || liveConversationStarted || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      clearInboundGreetingFallback();

      liveConversationStarted = true;
      const { issueLine, propertyLine } = buildIssueDetails(maintenanceContext);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[System: The person just answered and said "${userGreeting}". Respond naturally to their greeting first. Briefly introduce yourself as Ava from HouseYield and mention you're calling about coordinating a repair${propertyLine ? ` at ${maintenanceContext.propertyAddress}` : ''}. Ask if now is a good time to talk. Do NOT explain the full issue yet.${issueLine ? ` Only mention the issue after they confirm they have a moment.` : ''}]`
          }]
        }
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
      openingGreetingSent = true;
      console.log('[Voice-AI] Triggered live greeting after callee spoke');
    };

    const triggerInboundGreeting = (maintenanceContext = null) => {
      if (openingGreetingSent || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      clearInboundGreetingFallback();

      liveConversationStarted = true;

      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[System: Inbound call — say ONLY a brief hello in one short sentence. Example: "Hi, this is Ava with HouseYield — how can I help?" Do not mention repairs, properties, callbacks, or any other details. Stop after that one sentence.]`
          }]
        }
      }));
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions: 'Say exactly one brief greeting sentence, then stop. Under 15 words total.',
          max_output_tokens: 50
        }
      }));
      openingGreetingSent = true;
      console.log('[Voice-AI] Triggered inbound greeting');
    };

    const scheduleVoicemailHangUp = () => {
      if (voicemailHangUpScheduled || !callSid) {
        return;
      }

      voicemailHangUpScheduled = true;
      const delayMs = voicemailPlaybackEstimateMs;
      console.log(`[Voice-AI] Scheduling voicemail hang-up in ${delayMs}ms`);

      setTimeout(async () => {
        await hangUpCall(callSid, 'voicemail delivered');
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'voicemail delivered');
        }
      }, delayMs);
    };
    const maybeStartVoicemailMode = (maintenanceContext = null) => {
      if (openingGreetingSent || voicemailMode) {
        return;
      }

      const answeredBy = callAnsweredByStore.get(callSid);
      if (isVoicemailAnsweredBy(answeredBy)) {
        voicemailMode = true;
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: getAIInstructions(maintenanceContext, 'voicemail')
            }
          }));
        }
        triggerVoicemailMessage(maintenanceContext);
      }
    };

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log('[Voice-WS] Stream started:', { streamSid, callSid });

          const customParams = msg.start?.customParameters || {};
          isInboundCall = customParams.callDirection === 'inbound';
          const callerPhone = customParams.callerPhone || '';
          const requestedModel = String(customParams.model || 'gpt-realtime-2').replace(/[^a-zA-Z0-9-_.]/g, '');
          const selectedVoice = sanitizeRealtimeVoice(customParams.voice, 'marin');
          console.log('[Voice-WS] Stream custom parameters:', customParams);
          console.log('[Voice-WS] Using realtime config:', {
            model: requestedModel,
            voice: selectedVoice,
            outputMode: VOICE_PHONE_OUTPUT_MODE,
            preEmphasis: TELEPHONY_PREEMPHASIS
          });

          // Retrieve maintenance context for this call (memory, phone-indexed Firestore, or callSid doc)
          if (isInboundCall) {
            const resolvedContext = await resolveMaintenanceContextForInbound(callerPhone, callSid);
            callContextStore.set(callSid, resolvedContext);
            console.log(
              '[Voice-WS] Inbound call context prepared for',
              callerPhone || 'unknown',
              resolvedContext?.issue || resolvedContext?.priorCallSummary ? '(matched prior maintenance call)' : '(generic)'
            );
          }

          let maintenanceContext = callContextStore.get(callSid);
          maintenanceContextRef = maintenanceContext || null;
          if (!maintenanceContext && !isInboundCall) {
            maintenanceContext = await loadVoiceCallContext(callSid);
            if (maintenanceContext) {
              callContextStore.set(callSid, maintenanceContext);
              maintenanceContextRef = maintenanceContext;
            }
          }

          if (maintenanceContext) {
            console.log('[Voice-WS] ✅ Retrieved maintenance context for call:', callSid);
            console.log('[Voice-WS] Issue:', maintenanceContext.issue);
            console.log('[Voice-WS] Urgency:', maintenanceContext.urgency);
            console.log('[Voice-WS] Tenant Availability:', maintenanceContext.tenantAvailability);
            console.log('[Voice-WS] Property Address:', maintenanceContext.propertyAddress);
          } else {
            console.log('[Voice-WS] ⚠️  No maintenance context found for call:', callSid);
          }

          // Connect to OpenAI Realtime API
          // Use GPT-Realtime-2 for low-latency phone conversations.
          const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(requestedModel)}`;
          openaiWs = new WebSocket(openaiUrl, {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`
            }
          });

          openaiWs.on('open', () => {
            console.log('[Voice-WS] ✅ Connected to OpenAI Realtime API');
            scheduleInitialGreetingFallback(maintenanceContextRef || maintenanceContext);
            openaiWs.send(JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                output_modalities: ['audio'],
                audio: {
                  input: {
                    format: { type: 'audio/pcmu' },
                    transcription: { model: 'whisper-1' },
                    turn_detection: buildTurnDetectionConfig(false)
                  },
                  output: {
                    format: VOICE_PHONE_OUTPUT_MODE === 'pcm'
                      ? { type: 'audio/pcm', rate: 24000 }
                      : { type: 'audio/pcmu' },
                    voice: selectedVoice
                  }
                },
                instructions: getAIInstructions(maintenanceContext, voicemailMode ? 'voicemail' : (isInboundCall ? 'inbound' : 'live'))
              }
            }));
          });

          openaiWs.on('message', (aiData) => {
            try {
              const aiMsg = JSON.parse(aiData.toString());

              // Log all OpenAI message types for debugging
              if (aiMsg.type && !aiMsg.type.includes('audio.delta')) {
                console.log('[Voice-AI] OpenAI event:', aiMsg.type);
              }

              if (aiMsg.type === 'session.updated' || aiMsg.type === 'session.created') {
                maybeStartInitialGreeting(maintenanceContextRef || maintenanceContext);
              }

              if (aiMsg.type === 'response.created') {
                activeResponseId = aiMsg.response?.id || null;
              }

              if (aiMsg.type === 'response.cancelled') {
                activeResponseId = null;
                assistantSpeaking = false;
                clearTwilioAudioBuffer();
              }

              if (aiMsg.type === 'input_audio_buffer.speech_started') {
                if (assistantSpeaking) {
                  clearTwilioAudioBuffer();
                  assistantSpeaking = false;
                  disableTurnTaking();
                }
              }

              if ((aiMsg.type === 'response.audio.delta' || aiMsg.type === 'response.output_audio.delta') && aiMsg.delta) {
                if (activeResponseId && aiMsg.response_id && aiMsg.response_id !== activeResponseId) {
                  return;
                }

                assistantSpeaking = true;
                disableTurnTaking();
                let payload = aiMsg.delta;

                if (VOICE_PHONE_OUTPUT_MODE === 'pcm') {
                  const pcm16_24k = Buffer.from(payload, 'base64');
                  const mulawBuffer = convertOpenAIPcm24kToTwilioMulaw(pcm16_24k, audioOutputProcessor);
                  payload = mulawBuffer.toString('base64');
                } else if (TELEPHONY_PREEMPHASIS > 0) {
                  const mulawBuffer = applyTelephonyPreEmphasisToMulaw(
                    Buffer.from(payload, 'base64'),
                    audioOutputProcessor
                  );
                  payload = mulawBuffer.toString('base64');
                }

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload }
                  }));
                }

                if (audioPacketCount === 0) {
                  console.log('[Voice-AI] 🔊 Sending audio to caller (', VOICE_PHONE_OUTPUT_MODE === 'pcm'
                    ? 'PCM 24k → 8k downsample + pre-emphasis'
                    : 'μ-law passthrough', ')');
                }
                audioPacketCount++;
              }

              if (aiMsg.type === 'conversation.item.input_audio_transcription.completed') {
                console.log('[Voice-AI] 🎤 User said:', aiMsg.transcript);
                if (callSid && aiMsg.transcript) {
                  appendVoiceCallTranscriptLine(callSid, { role: 'user', text: aiMsg.transcript }).catch(() => {});
                }

                if (!openingGreetingSent && !voicemailMode && aiMsg.transcript?.trim()) {
                  triggerLiveGreeting(maintenanceContext, aiMsg.transcript.trim());
                  return;
                }

                if (
                  openingGreetingSent
                  && liveConversationStarted
                  && !voicemailMode
                  && !turnTakingEnabled
                  && aiMsg.transcript?.trim()
                  && openaiWs?.readyState === WebSocket.OPEN
                  && !assistantSpeaking
                ) {
                  openaiWs.send(JSON.stringify({ type: 'response.create' }));
                  console.log('[Voice-AI] Triggered follow-up response after user spoke');
                }
              }

              if (aiMsg.type === 'response.done') {
                console.log('[Voice-AI] ✅ Response completed');
                activeResponseId = null;

                if (voicemailMode) {
                  scheduleVoicemailHangUp();
                } else if (liveConversationStarted) {
                  scheduleEnableTurnTaking(lastAssistantTranscript);
                }
              }

              if (aiMsg.type === 'response.audio.done' || aiMsg.type === 'response.output_audio.done') {
                assistantSpeaking = false;
              }

              if (aiMsg.type === 'response.audio_transcript.done' || aiMsg.type === 'response.output_audio_transcript.done') {
                console.log('[Voice-AI] 💬 AI said:', aiMsg.transcript);
                lastAssistantTranscript = aiMsg.transcript || '';
                if (callSid && aiMsg.transcript) {
                  appendVoiceCallTranscriptLine(callSid, { role: 'assistant', text: aiMsg.transcript }).catch(() => {});
                }
                if (voicemailMode && aiMsg.transcript) {
                  voicemailPlaybackEstimateMs = estimateSpeechPlaybackMs(aiMsg.transcript);
                }
              }

              if (aiMsg.type === 'error') {
                console.error('[Voice-AI] ❌ Error:', JSON.stringify(aiMsg.error));
              }
            } catch (e) {
              console.error('[Voice-AI] Parse error:', e.message);
            }
          });

          openaiWs.on('error', (error) => {
            console.error('[Voice-AI] WebSocket error:', error.message);
          });

          openaiWs.on('close', () => {
            console.log('[Voice-AI] Disconnected from OpenAI');
          });
        }

        if (msg.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) {
          // Twilio sends μ-law @ 8kHz → Send directly to OpenAI - NO CONVERSION!
          // OpenAI now accepts g711_ulaw format natively
          const base64Audio = msg.media.payload; // Already in the right format!

          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: base64Audio
            }));
          }

          audioPacketCount++;
          if (audioPacketCount % 100 === 0) {
            console.log(`[Voice-WS] 🎵 Receiving audio (low-latency JS conversion)... ${audioPacketCount} packets`);
          }

          // Server VAD is enabled, so OpenAI will automatically detect when user stops speaking
        }

        if (msg.event === 'stop') {
          console.log('[Voice-WS] Stream stopped');
          if (openaiWs) {
            openaiWs.close();
            openaiWs = null;
          }
        }
      } catch (e) {
        console.error('[Voice-WS] Message parse error:', e.message);
      }
    });

    ws.on('close', (code, reason) => {
      const closeTime = new Date().toISOString();
      console.log('[Voice-WS] ========== CONNECTION CLOSED ==========');
      console.log('[Voice-WS] Close timestamp:', closeTime);
      console.log('[Voice-WS] Close code:', code);
      console.log('[Voice-WS] Close reason:', reason?.toString() || 'none');
      console.log('[Voice-WS] Stream SID was:', streamSid || 'never received');
      console.log('[Voice-WS] Call SID was:', callSid || 'never received');
      console.log('[Voice-WS] OpenAI WS connected:', openaiWs ? 'yes' : 'no');
      clearTimeout(connectionTimeout);
      activeSockets.delete(ws);
      
      if (callSid) {
        callContextStore.delete(callSid);
        console.log('[Voice-WS] Cleared in-memory context for call:', callSid);
        // Fallback: process visit scheduling if Twilio status callback is delayed
        setTimeout(() => {
          processCompletedMaintenanceCall({
            callSid,
            callStatus: 'completed',
            durationSeconds: 0
          }).catch((error) => {
            console.warn('[Voice-WS] Post-call scheduling fallback failed:', error.message);
          });
        }, 8000);
      }
      
      if (openaiWs) {
        openaiWs.close();
        openaiWs = null;
      }
      if (vadTimer) clearTimeout(vadTimer);
      if (enableTurnTakingTimer) clearTimeout(enableTurnTakingTimer);
      clearInboundGreetingFallback();
      if (callSid) {
        callAnsweredByStore.delete(callSid);
      }
    });

    ws.on('error', (error) => {
      console.error('[Voice-WS] Error:', error.message, error.stack);
    });
  });

  console.log('✅ [Voice] WebSocket server ready on /twilio-media');
  return wss;
}

// ===================================================================
// API ENDPOINTS
// ===================================================================

/**
 * Make an outbound call to a maintenance provider
 * SECURITY: This function should only be called from authenticated endpoints
 */
async function makeOutboundCall(to, options = {}) {
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }

  // Validate phone number format (E.164)
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(to)) {
    throw new Error('Invalid phone number format. Must be E.164 format.');
  }

  const { 
    model = 'gpt-realtime-2',
    voice = 'marin',  // Default to marin - natural-sounding conversational voice
    publicUrl,
    maintenanceContext = null  // New parameter for maintenance details
  } = options;

  if (!publicUrl) {
    throw new Error('Public URL required for TwiML webhook');
  }

  // Sanitize model and voice parameters to prevent injection
  const safeModel = model.replace(/[^a-zA-Z0-9-_.]/g, '');
  const safeVoice = voice.replace(/[^a-zA-Z0-9-_]/g, '');

  const twimlUrl = `${publicUrl}/twiml/voice?model=${encodeURIComponent(safeModel)}&voice=${encodeURIComponent(safeVoice)}`;

  const practiceMode = isPracticeModeEnabled();

  const callParams = {
    to,
    from: TWILIO_FROM_NUMBER,
    url: twimlUrl,
    statusCallback: `${publicUrl}/twilio/call-status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: practiceMode ? 45 : 60,
    timeLimit: 600,
  };

  if (practiceMode) {
    // Let the phone ring for a human pickup during practice tests.
    callParams.machineDetection = 'Disable';
  } else {
    callParams.machineDetection = 'Enable';
    callParams.machineDetectionTimeout = 5;
  }

  const call = await twilioClient.calls.create(callParams);

  // Store maintenance context for this call (local memory + Firestore for webhook host split)
  if (maintenanceContext) {
    callContextStore.set(call.sid, maintenanceContext);
    await saveVoiceCallContext(call.sid, maintenanceContext);
    await saveVoiceCallContextByPhone(to, maintenanceContext, { outboundCallSid: call.sid });
    rememberRecentCallContextByPhone(to, maintenanceContext);
    console.log('[Voice] ✅ Stored maintenance context for call:', call.sid);
    console.log('[Voice] Context details:');
    console.log('  - Issue:', maintenanceContext.issue || 'Not specified');
    console.log('  - Urgency:', maintenanceContext.urgency || 'Not specified');
    console.log('  - Tenant Availability:', maintenanceContext.tenantAvailability || 'Not specified');
    console.log('  - Property Address:', maintenanceContext.propertyAddress || 'Not specified');
    
    // Auto-cleanup context after post-call processing window
    setTimeout(() => {
      if (callContextStore.has(call.sid)) {
        callContextStore.delete(call.sid);
      }
      deleteVoiceCallContext(call.sid).catch(() => {});
      console.log('[Voice] Auto-cleaned context for call:', call.sid);
    }, 45 * 60 * 1000);
  } else {
    console.log('[Voice] ⚠️  No maintenance context provided for call:', call.sid);
  }

  return {
    callSid: call.sid,
    to: call.to,
    from: call.from,
    status: call.status,
    twimlUrl
  };
}

/**
 * Generate TwiML for voice call
 * SECURITY: Validates and sanitizes all query parameters
 */
function generateTwiML(req, publicUrl) {
  // Sanitize model and voice parameters to prevent XSS/injection
  const model = (req.query.model || 'gpt-realtime-2').replace(/[^a-zA-Z0-9-_.]/g, '');
  const safeVoice = sanitizeRealtimeVoice(req.query.voice, 'marin');
  const direction = String(req.body?.Direction || req.query?.Direction || 'outbound').toLowerCase();
  const callerPhone = req.body?.From || req.query?.From || '';
  const callSid = req.body?.CallSid || req.query?.CallSid || '';

  // Use PUBLIC_URL if provided, otherwise fall back to request headers
  let wsUrl;
  if (publicUrl) {
    const protocol = publicUrl.startsWith('https') ? 'wss' : 'ws';
    const urlWithoutProtocol = publicUrl.replace(/^https?:\/\//, '');
    wsUrl = `${protocol}://${urlWithoutProtocol}/twilio-media`;
  } else {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/twilio-media`;
  }

  // Use XML encoding for safety (escapeXml helper)
  const escapeXml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  if (direction === 'inbound' && callSid) {
    resolveMaintenanceContextForInbound(callerPhone, callSid)
      .then((resolvedContext) => {
        callContextStore.set(callSid, resolvedContext);
        console.log(
          '[Voice] Inbound call context prepared for',
          callerPhone || 'unknown',
          resolvedContext?.issue || resolvedContext?.priorCallSummary ? '(matched prior maintenance call)' : '(generic)'
        );
      })
      .catch((error) => {
        console.warn('[Voice] Failed to preload inbound call context:', error.message);
        const priorContext = lookupRecentCallContextByPhone(callerPhone);
        callContextStore.set(callSid, {
          ...(priorContext || {}),
          inbound: true,
          callerPhone,
          callDirection: 'inbound'
        });
      });
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="model" value="${escapeXml(model)}" />
      <Parameter name="voice" value="${escapeXml(safeVoice)}" />
      <Parameter name="callDirection" value="${escapeXml(direction)}" />
      <Parameter name="callerPhone" value="${escapeXml(callerPhone)}" />
    </Stream>
  </Connect>
</Response>`;

  console.log('[Voice] Generated TwiML with WebSocket URL:', wsUrl);
  console.log('[Voice] Using voice:', safeVoice, 'model:', model);
  return twiml;
}

// ===================================================================
// SMART PROVIDER SELECTION + VOICE CALL AUTOMATION
// ===================================================================

/**
 * Find the best provider and initiate an automated voice call
 * This is the main integration function for AI-powered maintenance scheduling
 * 
 * @param {object} options - Call options
 * @param {string} options.repairType - Description of the repair needed
 * @param {string} options.serviceCategory - Category (plumbing, electrical, etc.)
 * @param {string} options.location - Property address
 * @param {string} options.urgency - Urgency level (emergency, high, medium, low)
 * @param {object} options.maintenanceContext - Full context for the call
 * @param {string} options.publicUrl - Public URL for webhooks
 * @param {boolean} options.skipProviderSearch - Skip provider search and use preSelectedProvider
 * @param {object} options.preSelectedProvider - Pre-selected provider to call directly
 * @returns {Promise<object>} Result with provider selection and call details
 */
async function findProviderAndCall(options = {}) {
  const {
    repairType,
    serviceCategory = 'general',
    location,
    urgency = 'medium',
    maintenanceContext = null,
    publicUrl,
    skipProviderSearch = false,
    preSelectedProvider = null
  } = options;

  if (!publicUrl) {
    throw new Error('Public URL required for voice call');
  }

  console.log('[Voice] ========================================');
  console.log('[Voice] Smart Provider Selection + Voice Call');
  console.log('[Voice] ========================================');
  console.log('[Voice] Repair Type:', repairType);
  console.log('[Voice] Category:', serviceCategory);
  console.log('[Voice] Location:', location);
  console.log('[Voice] Urgency:', urgency);
  console.log('[Voice] Skip Provider Search:', skipProviderSearch);

  try {
    let selectedProvider;
    let providerResult;

    // If we have a pre-selected provider, use it directly
    if (skipProviderSearch && preSelectedProvider) {
      console.log('[Voice] Using pre-selected provider:', preSelectedProvider.name);
      selectedProvider = preSelectedProvider;
      providerResult = {
        ok: true,
        selected: preSelectedProvider,
        allCandidates: [preSelectedProvider]
      };
    } else {
      // Step 1: Find the best provider using AI analysis
      if (!location) {
        throw new Error('Location is required to find providers');
      }
      
      console.log('[Voice] Step 1: Finding best repair service provider...');
      
      const aiProviderSelector = await import('./ai-provider-selector.js');
      
      if (!aiProviderSelector?.findBestRepairService) {
        throw new Error('AI Provider Selector not available');
      }

      providerResult = await aiProviderSelector.findBestRepairService({
        repairType: repairType || `${serviceCategory} repair`,
        serviceCategory,
        location,
        urgency,
        maxCandidates: 5,
        includeDetailedReviews: true
      });

      if (!providerResult.ok || !providerResult.selected) {
        return {
          ok: false,
          step: 'provider_selection',
          error: providerResult.error || 'No suitable providers found',
          searchCriteria: { repairType, serviceCategory, location, urgency }
        };
      }

      selectedProvider = providerResult.selected;
    }
    console.log('[Voice] ✅ Best provider found:', selectedProvider.name);
    console.log('[Voice]   Rating:', selectedProvider.rating, '/ 5 stars');
    console.log('[Voice]   Reviews:', selectedProvider.reviewCount);
    console.log('[Voice]   Confidence:', selectedProvider.selectionConfidence, '%');

    // Check if provider has a phone number
    if (!selectedProvider.phone) {
      console.warn('[Voice] ⚠️ Selected provider has no phone number');
      
      // Try alternative provider
      if (providerResult.alternative?.phone) {
        console.log('[Voice] Using alternative provider:', providerResult.alternative.name);
        return await initiateProviderCall(
          providerResult.alternative.phone,
          providerResult.alternative,
          maintenanceContext,
          publicUrl,
          providerResult
        );
      }
      
      return {
        ok: false,
        step: 'phone_validation',
        error: 'Selected provider has no phone number available',
        selectedProvider: {
          name: selectedProvider.name,
          address: selectedProvider.address,
          website: selectedProvider.website,
          rating: selectedProvider.rating
        },
        alternative: providerResult.alternative,
        suggestion: 'Visit provider website or try alternative provider'
      };
    }

    // Step 2: Initiate the voice call
    return await initiateProviderCall(
      selectedProvider.phone,
      selectedProvider,
      maintenanceContext,
      publicUrl,
      providerResult
    );

  } catch (error) {
    console.error('[Voice] Smart provider search error:', error);
    return {
      ok: false,
      step: 'provider_selection',
      error: error.message
    };
  }
}

/**
 * Helper function to initiate call to a selected provider
 */
async function initiateProviderCall(phone, provider, maintenanceContext, publicUrl, providerResult) {
  console.log('[Voice] Step 2: Initiating voice call to', provider.name);
  console.log('[Voice] Phone:', phone);

  try {
    // Enhance context with provider info and call script
    const enhancedContext = {
      ...maintenanceContext,
      providerName: provider.name,
      providerAddress: provider.address,
      providerRating: provider.rating,
      providerReviewCount: provider.reviewCount,
      selectionReasoning: provider.selectionReasoning,
      reviewSummary: provider.reviewAnalysis?.summary,
      suggestedQuestions: providerResult.callScript?.keyQuestions || []
    };

    // Practice mode: route booking calls to the selected test number instead of the real provider.
    const practiceCallPhoneOverride = maintenanceContext?.practiceCallPhone || null;
    const testPhoneOverride = resolvePracticeCallPhone(practiceCallPhoneOverride);
    const practiceMode = isPracticeModeEnabled();
    const actualPhone = practiceMode ? testPhoneOverride : phone;
    if (practiceMode) {
      console.log('[Voice] 🧪 Practice mode: calling', actualPhone, 'instead of provider phone', phone);
    }

    const callResult = await makeOutboundCall(actualPhone, {
      publicUrl,
      maintenanceContext: enhancedContext
    });

    console.log('[Voice] ✅ Call initiated successfully');
    console.log('[Voice] Call SID:', callResult.callSid);

    return {
      ok: true,
      call: callResult,
      selectedProvider: {
        name: provider.name,
        phone: provider.phone,
        address: provider.address,
        website: provider.website,
        rating: provider.rating,
        reviewCount: provider.reviewCount,
        selectionConfidence: provider.selectionConfidence,
        selectionReasoning: provider.selectionReasoning,
        reviewAnalysis: provider.reviewAnalysis
      },
      alternativeProvider: providerResult.alternative ? {
        name: providerResult.alternative.name,
        phone: providerResult.alternative.phone,
        reason: providerResult.alternative.reason
      } : null,
      callScript: providerResult.callScript,
      comparison: providerResult.comparison,
      allCandidates: providerResult.allCandidates?.length || 0
    };

  } catch (callError) {
    console.error('[Voice] Call initiation error:', callError);
    return {
      ok: false,
      step: 'call_initiation',
      error: callError.message,
      selectedProvider: {
        name: provider.name,
        phone: provider.phone,
        rating: provider.rating
      }
    };
  }
}

// ===================================================================
// EXPORTS
// ===================================================================

export {
  setupWebSocketServer,
  makeOutboundCall,
  findProviderAndCall,
  initiateProviderCall,
  generateTwiML,
  twilioClient,
  activeSockets
};

