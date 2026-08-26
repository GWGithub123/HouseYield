/**
 * GROQ + ElevenLabs Phone Call System
 * 
 * This module provides phone call automation specifically for maintenance scheduling
 * using the proven echo cancellation and conversation feedback system.
 * 
 * ARCHITECTURE:
 *   1. Twilio audio → GROQ Whisper STT (ultra-fast transcription via LPU)
 *   2. Transcribed text → GROQ LLM (ultra-fast inference via LPU)  
 *   3. LLM response → ElevenLabs V3 Alpha TTS (best-quality voice: Liam)
 *   4. Audio → Twilio (streamed back to caller)
 * 
 * Echo Cancellation Features:
 *   - isSpeaking flag prevents processing during AI speech
 *   - Audio buffer cleared when AI speaks to prevent echo
 *   - 600ms silence detection after speech for natural pauses
 *   - Keep-alive silence stream prevents connection drops
 * 
 * ElevenLabs Voice: Liam (v3-alpha) - most natural-sounding voice
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import Groq from 'groq-sdk';
import {
  rememberRecentCallContextByPhone,
  lookupRecentCallContextByPhone
} from './voice-call-context-store.js';

// ===================================================================
// CONFIGURATION
// ===================================================================

const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_Key;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// Audio settings
const TWILIO_SAMPLE_RATE = 8000;

// GROQ Models - Speed optimized
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_LLM_MODEL = 'openai/gpt-oss-120b'; // Fast on GROQ LPU

// ElevenLabs Settings - Use Flash model for lowest latency
const ELEVENLABS_MODEL = 'eleven_flash_v2_5'; // Fastest model for real-time
const ELEVENLABS_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ'; // Liam voice
const ELEVENLABS_OUTPUT_FORMAT = 'ulaw_8000'; // Direct μ-law for Twilio

// Ultra-low latency settings
const LLM_MAX_TOKENS = 50; // Short responses for faster TTS
const AUDIO_CHUNK_SIZE = 640; // 80ms chunks
const MIN_AUDIO_BYTES = 1600; // Minimum audio before processing

// Track active connections
const activePhoneSockets = new Set();

// Store conversation context
const callContextStore = new Map();
const conversationHistoryStore = new Map();
const callAnsweredByStore = new Map();
const callModeStore = new Map();

function isVoicemailAnsweredBy(answeredBy = '') {
  const normalized = String(answeredBy).toLowerCase();
  return normalized.includes('machine') || normalized === 'fax';
}

export function setGroqElevenLabsPhoneCallAnsweredBy(callSid, answeredBy) {
  if (!callSid) {
    return;
  }
  callAnsweredByStore.set(callSid, answeredBy);
  if (isVoicemailAnsweredBy(answeredBy)) {
    callModeStore.set(callSid, 'voicemail');
  }
}

// Initialize GROQ client
let groqClient = null;
if (GROQ_API_KEY) {
  groqClient = new Groq({ apiKey: GROQ_API_KEY });
  console.log('✅ [GROQ-Phone] GROQ client initialized');
} else {
  console.warn('⚠️  [GROQ-Phone] GROQ_API_KEY not configured');
}

// Validate ElevenLabs API key
if (!ELEVENLABS_API_KEY) {
  console.warn('⚠️  [GROQ-Phone] ELEVENLABS_API_KEY not configured');
}

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [GROQ-Phone] Twilio client initialized with API Key');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [GROQ-Phone] Twilio client initialized');
} else {
  console.warn('⚠️  [GROQ-Phone] Twilio not configured');
}

async function hangUpCall(callSid, reason = 'call complete') {
  if (!callSid || !twilioClient) {
    return false;
  }

  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[GROQ-Phone] 📴 Hung up call ${callSid}: ${reason}`);
    return true;
  } catch (error) {
    console.warn(`[GROQ-Phone] Failed to hang up ${callSid}:`, error.message);
    return false;
  }
}

function estimateMulawPlaybackMs(byteCount, bufferMs = 1500) {
  const safeBytes = Math.max(0, Number(byteCount) || 0);
  return Math.ceil(safeBytes / 8) + bufferMs;
}

// ===================================================================
// AUDIO FORMAT CONVERSION
// ===================================================================

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const SILENCE_CHUNK = Buffer.alloc(640, 0x7F);

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

function mulawToWav(mulawBuffer) {
  const numSamples = mulawBuffer.length;
  const pcmData = Buffer.alloc(numSamples * 2);
  
  for (let i = 0; i < numSamples; i++) {
    const linear = mulawToLinear(mulawBuffer[i]);
    pcmData.writeInt16LE(linear, i * 2);
  }
  
  const wavHeader = Buffer.alloc(44);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;
  
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(fileSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(TWILIO_SAMPLE_RATE, 24);
  wavHeader.writeUInt32LE(TWILIO_SAMPLE_RATE * 2, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);
  
  return Buffer.concat([wavHeader, pcmData]);
}

// ===================================================================
// GROQ - SPEECH-TO-TEXT
// ===================================================================

async function transcribeAudio(audioBuffer) {
  if (!groqClient) throw new Error('GROQ client not initialized');
  
  const startTime = Date.now();
  const wavBuffer = mulawToWav(audioBuffer);
  const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
  
  const transcription = await groqClient.audio.transcriptions.create({
    file: audioFile,
    model: GROQ_STT_MODEL,
    language: 'en',
    response_format: 'json',
    temperature: 0.0
  });
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Phone] 🎤 STT in ${latency}ms: "${transcription.text}"`);
  
  return transcription.text;
}

// ===================================================================
// GROQ - LLM RESPONSE (Streaming)
// ===================================================================

async function* generateResponseStreaming(userMessage, conversationHistory, context, options = {}) {
  if (!groqClient) throw new Error('GROQ client not initialized');
  
  const startTime = Date.now();
  const systemPrompt = buildSystemPrompt(context, options);
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-4),
    { role: 'user', content: userMessage }
  ];
  
  console.log(`[GROQ-Phone] 🚀 LLM request starting...`);
  
  const stream = await groqClient.chat.completions.create({
    model: GROQ_LLM_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: LLM_MAX_TOKENS,
    stream: true
  });
  
  let buffer = '';
  let fullResponse = '';
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    buffer += content;
    fullResponse += content;
    
    // Yield after 4-5 words or sentence enders for streaming TTS
    const words = buffer.split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 5 || /[.!?,]/.test(buffer)) {
      const textToSpeak = buffer.trim();
      if (textToSpeak.length > 0) {
        console.log(`[GROQ-Phone] 📝 Yielding phrase: "${textToSpeak}"`);
        yield { type: 'phrase', text: textToSpeak };
        buffer = '';
      }
    }
  }
  
  if (buffer.trim().length > 0) {
    yield { type: 'phrase', text: buffer.trim() };
  }
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Phone] 🤖 LLM completed in ${latency}ms: "${fullResponse}"`);
  
  // Fallback if LLM returns empty response - never leave silence
  if (fullResponse.trim().length === 0) {
    const fallback = "I'm calling about scheduling a maintenance service. When would be a good time?";
    console.log(`[GROQ-Phone] ⚠️ Empty LLM response, using fallback`);
    yield { type: 'phrase', text: fallback };
    yield { type: 'complete', text: fallback };
    return;
  }
  yield { type: 'complete', text: fullResponse };
}

function buildSystemPrompt(context = null, options = {}) {
  const mode = options.mode || 'live';
  const turnPhase = options.turnPhase || 'conversation';
  const userGreeting = options.userGreeting || '';

  if (mode === 'inbound') {
    let prompt = `You are Ava from HouseYield property management answering an INCOMING phone call.

INBOUND CALL RULES:
- You answer calls for the property management company
- Be warm, professional, and helpful
- Keep responses short (1-2 sentences)
- If they mention scheduling, maintenance, or a callback, help coordinate
- If you recognize context from a recent maintenance request, confirm you're discussing that issue`;

    if (context?.issue) {
      prompt += `\n\nLikely reason for their call: ${context.issue}`;
    }
    if (context?.propertyAddress) {
      prompt += `\nProperty: ${context.propertyAddress}`;
    }
    if (context?.tenantAvailability) {
      prompt += `\nTenant availability: ${context.tenantAvailability}`;
    }
    if (context?.serviceCategory) {
      prompt += `\nService type: ${context.serviceCategory}`;
    }

    return prompt;
  }

  if (mode === 'voicemail') {
    const { issue, propertyAddress, tenantAvailability, serviceCategory } = context || {};
    return `You are Ava from HouseYield property management leaving a voicemail for a maintenance company.

Write ONE continuous voicemail script (3-5 sentences, no questions, no pauses for replies):
1. Introduce yourself as Ava from HouseYield
2. Explain the repair issue${issue ? `: ${issue}` : ''}${serviceCategory ? ` (${serviceCategory})` : ''}
3. Give the property address${propertyAddress ? `: ${propertyAddress}` : ''}
4. Mention tenant availability${tenantAvailability ? `: ${tenantAvailability}` : ' if known'}
5. Ask them to call back to schedule

Output ONLY the words Ava should speak — no stage directions.`;
  }

  if (turnPhase === 'initial') {
    return `You are Ava from HouseYield on a LIVE phone call. The person just answered and said: "${userGreeting}".

THIS IS YOUR FIRST RESPONSE — follow these rules strictly:
- Respond to THEIR greeting first (match their tone — "Hi", "Hello", "ABC Plumbing", etc.)
- Briefly introduce yourself: "Hi, this is Ava — I work with HouseYield property management."
- Say you're calling about coordinating a repair${context?.propertyAddress ? ` at ${context.propertyAddress}` : ''}
- Ask if now is a good time to talk
- Keep it to 1-2 short sentences
- Do NOT explain the full repair issue yet
- Do NOT mention tenant availability yet

Issue details (save for AFTER they confirm they have time): ${context?.issue || 'maintenance repair'}`;
  }

  let prompt = `You are Ava from HouseYield on a live phone call scheduling a maintenance repair.

RULES:
- Sound natural and conversational — not scripted
- Keep responses SHORT (1-2 sentences)
- They already know who you are — do not re-introduce yourself
- Now you CAN explain the issue and discuss scheduling
- If they give times, confirm or ask for alternatives
- Be warm and professional`;

  if (context) {
    const { issue, urgency, propertyAddress, tenantAvailability, serviceCategory } = context;
    if (issue) prompt += `\nIssue: ${issue}`;
    if (serviceCategory) prompt += `\nService type: ${serviceCategory}`;
    if (propertyAddress) prompt += `\nAddress: ${propertyAddress}`;
    if (tenantAvailability) prompt += `\nTenant availability: ${tenantAvailability}`;
    if (urgency === 'emergency' || urgency === 'high') prompt += `\nThis is URGENT.`;
  }

  return prompt;
}

function buildVoicemailScript(context = {}) {
  const parts = [
    'Hi, this is Ava calling from HouseYield property management.',
    context.issue
      ? `I'm calling about a ${context.serviceCategory || 'maintenance'} issue: ${context.issue}.`
      : "I'm calling to coordinate a maintenance repair.",
    context.propertyAddress ? `The property is at ${context.propertyAddress}.` : '',
    context.tenantAvailability ? `The tenant is available ${context.tenantAvailability}.` : '',
    'Please call us back to schedule a service visit. Thank you.'
  ].filter(Boolean);

  return parts.join(' ');
}

// ===================================================================
// ELEVENLABS - TEXT-TO-SPEECH
// ===================================================================

/**
 * ElevenLabs TTS with streaming support
 * Uses Liam v3-alpha voice - natural conversational tone
 * Returns μ-law 8kHz audio ready for Twilio
 */
async function textToSpeechElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key not configured');
  }
  
  const startTime = Date.now();
  
  console.log(`[GROQ-Phone] 🎙️ ElevenLabs TTS: "${text.substring(0, 50)}..."`);
  
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/basic',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: text,
      model_id: ELEVENLABS_MODEL,
      apply_text_normalization: 'on',
      should_enhance: true,
      voice_settings: {
        stability: 1.0,
        similarity_boost: 0.85,
        style: 0.0,
        use_speaker_boost: true
      }
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[GROQ-Phone] TTS error: ${response.status} ${errorText}`);
    throw new Error(`ElevenLabs TTS failed: ${response.status}`);
  }
  
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Phone] 🔊 TTS completed in ${latency}ms (${audioBuffer.length} bytes)`);
  
  return audioBuffer;
}

/**
 * ElevenLabs streaming TTS for lowest latency
 */
async function* textToSpeechElevenLabsStreaming(text) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key not configured');
  }
  
  const startTime = Date.now();
  console.log(`[GROQ-Phone] 🎙️ Streaming TTS: "${text.substring(0, 50)}..."`);
  
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/basic',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: text,
      model_id: ELEVENLABS_MODEL,
      apply_text_normalization: 'on',
      should_enhance: true,
      voice_settings: {
        stability: 1.0,
        similarity_boost: 0.85,
        style: 0.0,
        use_speaker_boost: true
      }
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Streaming TTS failed: ${response.status} - ${errorText}`);
  }
  
  let totalBytes = 0;
  const reader = response.body.getReader();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    totalBytes += value.length;
    yield Buffer.from(value);
  }
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Phone] 🔊 Streaming TTS done in ${latency}ms (${totalBytes} bytes)`);
}

// ===================================================================
// WEBSOCKET MEDIA STREAMING WITH ECHO CANCELLATION
// ===================================================================

function setupGroqElevenLabsPhoneWebSocketServer(httpServer, publicUrl) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/groq-elevenlabs-phone-media') {
      console.log('[GROQ-Phone-WS] 🔄 Handling WebSocket upgrade');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('error', (error) => {
    console.error('[GROQ-Phone-WS] WebSocket error:', error);
  });

  // μ-law to linear PCM conversion for energy calculation
  const ulawToLinear = (ulaw) => {
    ulaw = ~ulaw;
    const sign = (ulaw & 0x80) ? -1 : 1;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0F;
    const magnitude = ((mantissa << 3) + 0x84) << exponent;
    return sign * (magnitude - 0x84);
  };

  // Calculate RMS energy of μ-law audio chunk
  const calculateEnergy = (buffer) => {
    if (buffer.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const linear = ulawToLinear(buffer[i]);
      sum += linear * linear;
    }
    return Math.sqrt(sum / buffer.length);
  };

  wss.on('connection', async (ws, req) => {
    console.log('[GROQ-Phone-WS] ========== NEW PHONE CALL CONNECTION ==========');
    
    if (activePhoneSockets.size >= 10) {
      console.warn('[GROQ-Phone-WS] Too many active connections');
      ws.close(1008, 'Too many connections');
      return;
    }
    
    activePhoneSockets.add(ws);
    
    let streamSid = null;
    let callSid = null;
    let audioBuffer = Buffer.alloc(0);
    let isProcessing = false;
    let silenceTimeout = null;
    let keepAliveInterval = null;
    let hasSpeechStarted = false;
    let greetingSent = false;
    let isSpeaking = false; // CRITICAL: Echo cancellation flag
    let speechDetected = false; // VAD: Has user started speaking?
    let voicemailDelivered = false;
    let inboundGreetingSent = false;
    let isInboundCall = false;
    
    // VAD thresholds (calibrated for μ-law 8kHz phone audio)
    const SPEECH_THRESHOLD = 500;    // Energy level to detect speech start
    const SILENCE_THRESHOLD = 200;   // Energy level to detect silence
    const SILENCE_DURATION_MS = 300; // How long silence before processing (faster response)
    
    const connectionTimeout = setTimeout(() => {
      console.warn('[GROQ-Phone-WS] Connection timeout');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Timeout');
      }
    }, 15 * 60 * 1000);

    // Keep-alive to prevent connection drops
    const startKeepAlive = () => {
      if (keepAliveInterval) return;
      keepAliveInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && streamSid) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: SILENCE_CHUNK.toString('base64') }
          }));
        }
      }, 50);
    };

    const stopKeepAlive = () => {
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
    };

    // Stream audio to Twilio with echo prevention
    const streamAudioToTwilio = async (audioData) => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      
      stopKeepAlive();
      
      // ECHO PREVENTION: Set flag and clear buffer
      isSpeaking = true;
      audioBuffer = Buffer.alloc(0); // Clear to prevent echo
      hasSpeechStarted = false;
      
      console.log(`[GROQ-Phone-WS] 📤 Sending ${audioData.length} bytes to Twilio`);
      
      // Send audio fast - Twilio has its own playback buffer
      const chunkSize = 640;
      for (let i = 0; i < audioData.length; i += chunkSize) {
        if (ws.readyState !== WebSocket.OPEN) break;
        
        const chunk = audioData.slice(i, Math.min(i + chunkSize, audioData.length));
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        
        // Minimal pacing - Twilio buffers and plays at correct rate
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      
      // Re-enable listening immediately after sending - the pacing above IS the audio duration
      isSpeaking = false;
      hasSpeechStarted = false;
      speechDetected = false; // Reset VAD for next utterance
      audioBuffer = Buffer.alloc(0); // Clear any echo that leaked through
      startKeepAlive();
      console.log(`[GROQ-Phone-WS] 👂 Listening for user speech...`);
    };

    // Stream ElevenLabs audio directly to Twilio
    const streamElevenLabsToTwilio = async (text, options = {}) => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return 0;
      
      stopKeepAlive();
      
      // ECHO PREVENTION
      isSpeaking = true;
      audioBuffer = Buffer.alloc(0);
      hasSpeechStarted = false;
      let totalBytes = 0;
      
      try {
        for await (const audioChunk of textToSpeechElevenLabsStreaming(text)) {
          if (ws.readyState !== WebSocket.OPEN) break;
          
          const chunkSize = 640;
          for (let i = 0; i < audioChunk.length; i += chunkSize) {
            const chunk = audioChunk.slice(i, Math.min(i + chunkSize, audioChunk.length));
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: chunk.toString('base64') }
            }));
            totalBytes += chunk.length;
            // Pace at real-time (80ms per 640-byte chunk)
            await new Promise(resolve => setTimeout(resolve, 80));
          }
        }
      } catch (error) {
        console.error('[GROQ-Phone-WS] Streaming TTS error:', error.message);
      }
      
      isSpeaking = false;
      hasSpeechStarted = false;
      speechDetected = false;
      audioBuffer = Buffer.alloc(0);

      if (options.skipReListen) {
        stopKeepAlive();
        console.log(`[GROQ-Phone-WS] 📼 Voicemail audio sent (${totalBytes} bytes)`);
      } else {
        startKeepAlive();
        console.log(`[GROQ-Phone-WS] 👂 Ready for next input...`);
      }

      return totalBytes;
    };

    const scheduleCallHangUp = (delayMs, reason) => {
      setTimeout(async () => {
        stopKeepAlive();
        await hangUpCall(callSid, reason);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, reason);
        }
      }, delayMs);
    };

    const deliverInboundGreeting = async () => {
      if (inboundGreetingSent || isProcessing) {
        return;
      }

      inboundGreetingSent = true;
      greetingSent = true;
      isProcessing = true;
      const context = callContextStore.get(callSid) || {};

      const greeting = context.issue
        ? `Thanks for calling HouseYield, this is Ava. Are you calling back about the ${context.serviceCategory || 'maintenance'} request${context.propertyAddress ? ` at ${context.propertyAddress}` : ''}?`
        : 'Thanks for calling HouseYield property management, this is Ava. How can I help you today?';

      try {
        console.log('[GROQ-Phone-WS] 📞 Inbound greeting:', greeting);
        await streamElevenLabsToTwilio(greeting);

        const history = conversationHistoryStore.get(callSid) || [];
        history.push({ role: 'assistant', content: greeting });
        conversationHistoryStore.set(callSid, history.slice(-10));
      } catch (error) {
        console.error('[GROQ-Phone-WS] Inbound greeting failed:', error.message);
      } finally {
        isProcessing = false;
      }
    };

    // Process user speech and generate AI response
    const deliverVoicemailMonologue = async () => {
      if (voicemailDelivered || isProcessing) {
        return;
      }

      voicemailDelivered = true;
      greetingSent = true;
      isProcessing = true;
      const context = callContextStore.get(callSid) || {};

      try {
        let script = buildVoicemailScript(context);
        for await (const chunk of generateResponseStreaming(
          'Leave the voicemail now.',
          [],
          context,
          { mode: 'voicemail' }
        )) {
          if (chunk.type === 'complete' && chunk.text?.trim()) {
            script = chunk.text.trim();
          }
        }

        console.log('[GROQ-Phone-WS] 📼 Voicemail script:', script.substring(0, 120));
        const bytesSent = await streamElevenLabsToTwilio(script, { skipReListen: true });
        const hangUpDelayMs = estimateMulawPlaybackMs(bytesSent, 1200);
        scheduleCallHangUp(hangUpDelayMs, 'voicemail delivered');

        const history = conversationHistoryStore.get(callSid) || [];
        history.push({ role: 'assistant', content: script });
        conversationHistoryStore.set(callSid, history.slice(-10));
      } catch (error) {
        console.error('[GROQ-Phone-WS] Voicemail delivery failed:', error.message);
      } finally {
        isProcessing = false;
      }
    };

    const processAudioAndRespond = async () => {
      if (voicemailDelivered || audioBuffer.length < MIN_AUDIO_BYTES || isProcessing) return;
      
      isProcessing = true;
      const audioToProcess = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      
      console.log(`[GROQ-Phone-WS] Processing ${audioToProcess.length} bytes`);
      
      try {
        // 1. GROQ STT
        const transcription = await transcribeAudio(audioToProcess);
        
        if (!transcription || transcription.trim().length < 2) {
          console.log('[GROQ-Phone-WS] Empty transcription, skipping');
          isProcessing = false;
          return;
        }
        
        console.log(`[GROQ-Phone-WS] 👤 User: "${transcription}"`);
        
        // Get conversation history
        let history = conversationHistoryStore.get(callSid) || [];
        history.push({ role: 'user', content: transcription });
        
        // 2. GROQ LLM - collect FULL response first (no chunked TTS)
        let fullResponse = '';
        const context = callContextStore.get(callSid) || {};
        const callMode = callModeStore.get(callSid) || (isInboundCall ? 'inbound' : 'live');
        const turnPhase = history.filter((entry) => entry.role === 'user').length <= 1 ? 'initial' : 'conversation';
        
        for await (const chunk of generateResponseStreaming(transcription, history, context, {
          mode: callMode,
          turnPhase,
          userGreeting: transcription
        })) {
          if (chunk.type === 'complete') {
            fullResponse = chunk.text;
          }
        }
        
        // 3. STREAMING TTS - start playing as soon as first bytes arrive
        if (fullResponse.trim().length > 0) {
          greetingSent = true;
          console.log(`[GROQ-Phone-WS] 🎙️ Streaming TTS: "${fullResponse.substring(0, 50)}..."`);
          
          // Set speaking flag and stop listening
          stopKeepAlive();
          isSpeaking = true;
          audioBuffer = Buffer.alloc(0);
          hasSpeechStarted = false;
          speechDetected = false;
          
          const startTime = Date.now();
          let totalBytes = 0;
          
          // Stream from ElevenLabs directly to Twilio
          for await (const audioChunk of textToSpeechElevenLabsStreaming(fullResponse)) {
            if (ws.readyState !== WebSocket.OPEN) break;
            
            totalBytes += audioChunk.length;
            
            // Send immediately in small chunks for real-time playback
            const chunkSize = 640;
            for (let i = 0; i < audioChunk.length; i += chunkSize) {
              const chunk = audioChunk.slice(i, Math.min(i + chunkSize, audioChunk.length));
              ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: chunk.toString('base64') }
              }));
            }
          }
          
          console.log(`[GROQ-Phone-WS] 🔊 Streamed ${totalBytes} bytes in ${Date.now() - startTime}ms`);
          
          // Re-enable listening
          isSpeaking = false;
          hasSpeechStarted = false;
          speechDetected = false;
          audioBuffer = Buffer.alloc(0);
          startKeepAlive();
          console.log(`[GROQ-Phone-WS] 👂 Listening for user speech...`);
        }
        // Update history
        history.push({ role: 'assistant', content: fullResponse.trim() });
        conversationHistoryStore.set(callSid, history.slice(-10));
        
      } catch (error) {
        console.error('[GROQ-Phone-WS] Processing error:', error.message);
        
        // Send error message
        try {
          const errorAudio = await textToSpeechElevenLabs("I'm sorry, I didn't catch that. Could you repeat?");
          await streamAudioToTwilio(errorAudio);
        } catch (e) {
          console.error('[GROQ-Phone-WS] Error response TTS failed:', e.message);
        }
      }
      
      isProcessing = false;
    };

    // Handle WebSocket messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.event) {
          case 'connected':
            console.log('[GROQ-Phone-WS] 🔗 Twilio connected');
            break;
            
          case 'start':
            streamSid = message.start.streamSid;
            callSid = message.start.callSid;
            console.log(`[GROQ-Phone-WS] 📞 Call started: ${callSid}`);

            const customParams = message.start?.customParameters || {};
            isInboundCall = customParams.callDirection === 'inbound';
            
            // Initialize conversation
            conversationHistoryStore.set(callSid, []);

            if (isInboundCall) {
              console.log('[GROQ-Phone-WS] 📞 Inbound call from', customParams.callerPhone || 'unknown');
              await deliverInboundGreeting();
              break;
            }

            const answeredBy = callAnsweredByStore.get(callSid);
            if (isVoicemailAnsweredBy(answeredBy)) {
              callModeStore.set(callSid, 'voicemail');
              console.log('[GROQ-Phone-WS] 📼 Voicemail detected, delivering monologue');
              await deliverVoicemailMonologue();
            } else {
              console.log('[GROQ-Phone-WS] 👂 Live call — waiting for callee to greet first');
              setTimeout(async () => {
                if (!voicemailDelivered && !greetingSent && isVoicemailAnsweredBy(callAnsweredByStore.get(callSid))) {
                  callModeStore.set(callSid, 'voicemail');
                  console.log('[GROQ-Phone-WS] 📼 Late voicemail detection, delivering monologue');
                  await deliverVoicemailMonologue();
                }
              }, 3000);
            }
            break;
            
          case 'media':
            if (voicemailDelivered) {
              break;
            }

            // ECHO PREVENTION: Ignore audio while AI is speaking
            if (isSpeaking) {
              // Log occasionally to debug
              if (audioBuffer.length % 50000 < 200) {
                console.log(`[GROQ-Phone-WS] 🔇 Ignoring audio (AI speaking), buffer: ${audioBuffer.length}`);
              }
              break;
            }
            
            const audioChunk = Buffer.from(message.media.payload, 'base64');
            
            // Calculate audio energy for Voice Activity Detection
            const energy = calculateEnergy(audioChunk);
            
            // Detect speech start (high energy)
            if (energy > SPEECH_THRESHOLD && !speechDetected) {
              speechDetected = true;
              console.log(`[GROQ-Phone-WS] 🎙️ Speech detected! Energy: ${energy.toFixed(0)}`);
            }
            
            // Only buffer audio once speech is detected
            if (speechDetected) {
              audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
              
              // Log first audio and periodically
              if (audioBuffer.length === audioChunk.length) {
                console.log(`[GROQ-Phone-WS] 🎤 First audio chunk buffered: ${audioChunk.length} bytes`);
              } else if (audioBuffer.length % 20000 < 200) {
                console.log(`[GROQ-Phone-WS] 🎤 Audio buffer: ${audioBuffer.length} bytes, energy: ${energy.toFixed(0)}`);
              }
              
              // VAD: Start/reset silence timer only when energy drops (speech ends)
              if (energy < SILENCE_THRESHOLD) {
                // Low energy = silence, start countdown
                if (!silenceTimeout) {
                  silenceTimeout = setTimeout(() => {
                    console.log(`[GROQ-Phone-WS] ⏱️ Silence timeout! Buffer: ${audioBuffer.length} bytes`);
                    silenceTimeout = null;
                    if (audioBuffer.length > MIN_AUDIO_BYTES && !isProcessing && speechDetected) {
                      hasSpeechStarted = true;
                      speechDetected = false; // Reset for next utterance
                      processAudioAndRespond();
                    }
                  }, SILENCE_DURATION_MS);
                }
              } else {
                // High energy = speech continuing, cancel silence timer
                if (silenceTimeout) {
                  clearTimeout(silenceTimeout);
                  silenceTimeout = null;
                }
              }
            }
            
            // Limit buffer size
            if (audioBuffer.length > 320000) {
              audioBuffer = audioBuffer.slice(-160000);
            }
            break;
            
          case 'stop':
            console.log(`[GROQ-Phone-WS] 📴 Call ended: ${callSid}`);
            break;
        }
      } catch (error) {
        console.error('[GROQ-Phone-WS] Message error:', error.message);
      }
    });

    ws.on('close', () => {
      console.log('[GROQ-Phone-WS] Connection closed');
      activePhoneSockets.delete(ws);
      stopKeepAlive();
      clearTimeout(connectionTimeout);
      if (silenceTimeout) clearTimeout(silenceTimeout);
      
      // Cleanup
      if (callSid) {
        callContextStore.delete(callSid);
        conversationHistoryStore.delete(callSid);
        callAnsweredByStore.delete(callSid);
        callModeStore.delete(callSid);
      }
    });

    ws.on('error', (error) => {
      console.error('[GROQ-Phone-WS] Error:', error.message);
    });
  });

  return wss;
}

// ===================================================================
// API FUNCTIONS
// ===================================================================

/**
 * Make an outbound phone call
 */
async function makeGroqElevenLabsPhoneCall(to, options = {}) {
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }
  
  if (!groqClient) {
    throw new Error('GROQ not configured');
  }
  
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs not configured');
  }

  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(to)) {
    throw new Error('Invalid phone number format');
  }

  const { publicUrl, maintenanceContext = null } = options;

  if (!publicUrl) {
    throw new Error('Public URL required');
  }

  const twimlUrl = `${publicUrl}/twiml/groq-elevenlabs-phone`;

  console.log(`[GROQ-Phone] 📞 Initiating call to ${to}`);

  const call = await twilioClient.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    url: twimlUrl,
    statusCallback: `${publicUrl}/twilio/groq-elevenlabs-phone-status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    machineDetection: 'Enable',
    machineDetectionTimeout: 5,
    timeout: 60,
    timeLimit: 600 // 10 minutes max
  });

  // Store context for this call
  if (maintenanceContext) {
    callContextStore.set(call.sid, maintenanceContext);
    rememberRecentCallContextByPhone(to, maintenanceContext);
    console.log('[GROQ-Phone] ✅ Stored context for call:', call.sid);
    console.log('[GROQ-Phone] Issue:', maintenanceContext.issue || 'Not specified');
    console.log('[GROQ-Phone] Tenant Availability:', maintenanceContext.tenantAvailability || 'Not specified');
    
    // Auto-cleanup after 15 minutes
    setTimeout(() => {
      if (callContextStore.has(call.sid)) {
        callContextStore.delete(call.sid);
        conversationHistoryStore.delete(call.sid);
      }
    }, 15 * 60 * 1000);
  }

  return {
    callSid: call.sid,
    to: call.to,
    from: call.from,
    status: call.status,
    provider: 'groq-elevenlabs',
    twimlUrl,
    voice: 'ElevenLabs Liam (v3-alpha)'
  };
}

/**
 * Generate TwiML for phone call
 */
function generateGroqElevenLabsPhoneTwiML(req, publicUrl, options = {}) {
  let wsUrl;
  let statusCallbackUrl;
  const direction = String(options.direction || req.body?.Direction || req.query?.Direction || 'outbound').toLowerCase();
  const callerPhone = options.from || req.body?.From || req.query?.From || '';
  const callSid = options.callSid || req.body?.CallSid || req.query?.CallSid || '';
  const escapeXml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  
  if (publicUrl) {
    const protocol = publicUrl.startsWith('https') ? 'wss' : 'ws';
    const urlWithoutProtocol = publicUrl.replace(/^https?:\/\//, '');
    wsUrl = `${protocol}://${urlWithoutProtocol}/groq-elevenlabs-phone-media`;
    statusCallbackUrl = `${publicUrl}/twilio/groq-elevenlabs-phone-stream-status`;
  } else {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/groq-elevenlabs-phone-media`;
    statusCallbackUrl = `${protocol}://${host}/twilio/groq-elevenlabs-phone-stream-status`;
  }

  if (direction === 'inbound' && callSid) {
    const priorContext = lookupRecentCallContextByPhone(callerPhone);
    callContextStore.set(callSid, {
      ...(priorContext || {}),
      inbound: true,
      callerPhone,
      callDirection: 'inbound'
    });
    console.log('[GROQ-Phone] Inbound call context prepared for', callerPhone, priorContext ? '(matched recent maintenance call)' : '(generic)');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" statusCallback="${escapeXml(statusCallbackUrl)}" track="inbound_track">
      <Parameter name="provider" value="groq-elevenlabs-phone" />
      <Parameter name="callDirection" value="${escapeXml(direction)}" />
      <Parameter name="callerPhone" value="${escapeXml(callerPhone)}" />
    </Stream>
  </Connect>
  <Pause length="30"/>
</Response>`;
}

function getInboundVoiceWebhookPath() {
  return '/twiml/inbound-voice';
}

/**
 * Get system status
 */
function getGroqElevenLabsPhoneStatus() {
  return {
    configured: !!groqClient && !!twilioClient && !!ELEVENLABS_API_KEY,
    groqReady: !!groqClient,
    twilioReady: !!twilioClient,
    elevenLabsReady: !!ELEVENLABS_API_KEY,
    activeCalls: activePhoneSockets.size,
    inboundWebhookPath: getInboundVoiceWebhookPath(),
    voice: 'ElevenLabs Liam (v3-alpha)',
    models: {
      stt: GROQ_STT_MODEL,
      llm: GROQ_LLM_MODEL,
      tts: 'ElevenLabs V3 Alpha'
    }
  };
}

// ===================================================================
// EXPORTS
// ===================================================================

export {
  setupGroqElevenLabsPhoneWebSocketServer,
  makeGroqElevenLabsPhoneCall,
  generateGroqElevenLabsPhoneTwiML,
  getGroqElevenLabsPhoneStatus,
  getInboundVoiceWebhookPath,
  groqClient,
  twilioClient,
  activePhoneSockets,
  callContextStore
};
