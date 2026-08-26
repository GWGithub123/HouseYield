/**
 * GROQ Voice Call Module - Twilio + GROQ LPU Integration
 * 
 * This module provides ultra-low-latency voice call automation using GROQ's LPU chips.
 * Architecture:
 *   1. Twilio audio → GROQ Whisper STT (speech-to-text)
 *   2. Transcribed text → GROQ LLM (llama-3.3-70b-versatile)
 *   3. LLM response → GROQ PlayAI TTS (text-to-speech)
 *   4. Audio → Twilio (streamed back to caller)
 * 
 * Key advantages over OpenAI Realtime:
 *   - GROQ LPU chips provide 10x faster inference
 *   - Lower latency for more natural conversations
 *   - Cost-effective for high-volume calls
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import Groq from 'groq-sdk';

// ===================================================================
// CONFIGURATION
// ===================================================================

const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_Key;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// Audio settings
const TWILIO_SAMPLE_RATE = 8000;
const GROQ_TTS_SAMPLE_RATE = 8000; // Request 8kHz directly for Twilio

// GROQ Models - SPEED OPTIMIZED
const GROQ_STT_MODEL = 'whisper-large-v3-turbo'; // Fastest quality STT
const GROQ_LLM_MODEL = 'openai/gpt-oss-120b'; // OpenAI's 120B model on GROQ - fast + smart
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_TTS_VOICE = 'autumn';

// ULTRA-LOW LATENCY settings - process audio IMMEDIATELY
const LLM_MAX_TOKENS = 60; // Short responses = faster
const AUDIO_CHUNK_SIZE = 640; // 80ms of 8kHz μ-law audio

// Track active connections
const activeGroqSockets = new Set();

// Store conversation history and context for active calls
const groqCallContextStore = new Map();
const conversationHistoryStore = new Map();

// Connection keep-alive for faster subsequent requests
let groqConnectionWarmed = false;

// Initialize GROQ client
let groqClient = null;
if (GROQ_API_KEY) {
  groqClient = new Groq({ apiKey: GROQ_API_KEY });
  console.log('✅ [GROQ-Voice] GROQ client initialized');
  
  // Pre-warm the connection on startup (reduces first-call latency)
  setTimeout(async () => {
    try {
      console.log('[GROQ-Voice] 🔥 Pre-warming GROQ connections...');
      // Warm up LLM connection
      await groqClient.chat.completions.create({
        model: GROQ_LLM_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream: false
      });
      groqConnectionWarmed = true;
      console.log('[GROQ-Voice] ✅ GROQ connections pre-warmed');
    } catch (e) {
      console.log('[GROQ-Voice] Pre-warm failed (non-critical):', e.message);
    }
  }, 2000); // Warm up 2 seconds after startup
  
} else {
  console.warn('⚠️  [GROQ-Voice] GROQ_API_KEY not configured - GROQ voice calls disabled');
}

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [GROQ-Voice] Twilio client initialized with API Key');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [GROQ-Voice] Twilio client initialized with Auth Token');
} else {
  console.warn('⚠️  [GROQ-Voice] Twilio not configured');
}

// ===================================================================
// AUDIO FORMAT CONVERSION (μ-law for Twilio)
// ===================================================================

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Pre-generate silence audio (μ-law encoded silence = 0x7F or 0xFF, using 0x7F for true silence)
// 640 bytes = 80ms of audio at 8kHz
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

// Convert μ-law buffer to PCM16 WAV format for Whisper
function mulawToWav(mulawBuffer) {
  const numSamples = mulawBuffer.length;
  const pcmData = Buffer.alloc(numSamples * 2);
  
  // Convert μ-law to PCM16
  for (let i = 0; i < numSamples; i++) {
    const linear = mulawToLinear(mulawBuffer[i]);
    pcmData.writeInt16LE(linear, i * 2);
  }
  
  // Create WAV header
  const wavHeader = Buffer.alloc(44);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;
  
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(fileSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // fmt chunk size
  wavHeader.writeUInt16LE(1, 20); // PCM format
  wavHeader.writeUInt16LE(1, 22); // mono
  wavHeader.writeUInt32LE(TWILIO_SAMPLE_RATE, 24); // sample rate
  wavHeader.writeUInt32LE(TWILIO_SAMPLE_RATE * 2, 28); // byte rate
  wavHeader.writeUInt16LE(2, 32); // block align
  wavHeader.writeUInt16LE(16, 34); // bits per sample
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);
  
  return Buffer.concat([wavHeader, pcmData]);
}

// ===================================================================
// GROQ API INTEGRATION
// ===================================================================

/**
 * Transcribe audio using GROQ Whisper
 */
async function transcribeAudio(audioBuffer) {
  if (!groqClient) {
    throw new Error('GROQ client not initialized');
  }
  
  const startTime = Date.now();
  
  // Convert μ-law to WAV format
  const wavBuffer = mulawToWav(audioBuffer);
  
  // Create a File-like object for the API
  const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
  
  const transcription = await groqClient.audio.transcriptions.create({
    file: audioFile,
    model: GROQ_STT_MODEL,
    language: 'en',
    response_format: 'json',
    temperature: 0.0
  });
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Voice] 🎤 STT completed in ${latency}ms: "${transcription.text}"`);
  
  return transcription.text;
}

/**
 * Generate AI response using GROQ LLM
 */
async function generateResponse(userMessage, conversationHistory, maintenanceContext, options = {}) {
  if (!groqClient) {
    throw new Error('GROQ client not initialized');
  }
  
  const startTime = Date.now();
  
  const systemPrompt = buildSystemPrompt(maintenanceContext, options);
  
  // Build messages array with history - REDUCED to last 4 for speed
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-4),
    { role: 'user', content: userMessage }
  ];
  
  // Stream the response for low latency
  const stream = await groqClient.chat.completions.create({
    model: GROQ_LLM_MODEL,
    messages: messages,
    temperature: 0.3,
    max_tokens: LLM_MAX_TOKENS,
    stream: true
  });
  
  let fullResponse = '';
  const chunks = [];
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    fullResponse += content;
    chunks.push(content);
  }
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Voice] 🤖 LLM response in ${latency}ms: "${fullResponse}"`);
  
  return { text: fullResponse, chunks };
}

/**
 * STREAMING VERSION: Generate AI response - YIELD AS FAST AS POSSIBLE
 */
async function* generateResponseStreaming(userMessage, conversationHistory, maintenanceContext, options = {}) {
  if (!groqClient) {
    throw new Error('GROQ client not initialized');
  }
  
  const startTime = Date.now();
  
  const systemPrompt = buildSystemPrompt(maintenanceContext, options);
  
  // MINIMAL history for speed - just last 2 exchanges
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-2),
    { role: 'user', content: userMessage }
  ];
  
  console.log(`[GROQ-Voice] 🚀 LLM request starting...`);
  
  // Stream the response for low latency
  const stream = await groqClient.chat.completions.create({
    model: GROQ_LLM_MODEL,
    messages: messages,
    temperature: 0.7,
    max_tokens: LLM_MAX_TOKENS,
    stream: true
  });
  
  let buffer = '';
  let fullResponse = '';
  let wordCount = 0;
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    buffer += content;
    fullResponse += content;
    
    // Count words
    const words = buffer.split(/\s+/).filter(w => w.length > 0);
    wordCount = words.length;
    
    // Yield after just 3-4 words OR any sentence ender - super fast!
    if (wordCount >= 4 || /[.!?,]/.test(buffer)) {
      const textToSpeak = buffer.trim();
      if (textToSpeak.length > 0) {
        console.log(`[GROQ-Voice] 📝 Yielding: "${textToSpeak}" (${wordCount} words)`);
        yield { type: 'phrase', text: textToSpeak };
        buffer = '';
        wordCount = 0;
      }
    }
  }
  
  // Yield any remaining text
  if (buffer.trim().length > 0) {
    yield { type: 'phrase', text: buffer.trim() };
  }
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Voice] 🤖 LLM completed in ${latency}ms: "${fullResponse}"`);
  
  yield { type: 'complete', text: fullResponse };
}

/**
 * Convert text to speech using GROQ TTS (PlayAI model)
 * Returns μ-law 8kHz audio for Twilio
 */
async function textToSpeech(text) {
  if (!groqClient) {
    throw new Error('GROQ client not initialized');
  }
  
  const startTime = Date.now();
  
  // Use the REST API directly for more control (same as browser voice assistant)
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  
  // Valid Orpheus voices (same as browser voice assistant)
  const validVoices = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];
  const selectedVoice = validVoices.includes(GROQ_TTS_VOICE) ? GROQ_TTS_VOICE : 'autumn';
  
  console.log(`[GROQ-Voice] 🎤 Calling TTS API with voice: ${selectedVoice}, text length: ${text.length}`);
  
  const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'canopylabs/orpheus-v1-english',
      input: text.slice(0, 180), // Orpheus has 200 char limit, leave margin
      voice: selectedVoice,
      response_format: 'wav' // Get WAV, then convert to mulaw
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[GROQ-Voice] TTS error: ${response.status} ${errorText}`);
    throw new Error(`TTS failed: ${response.status}`);
  }
  
  // Get the audio buffer (WAV format)
  let audioBuffer = Buffer.from(await response.arrayBuffer());
  
  const latency = Date.now() - startTime;
  console.log(`[GROQ-Voice] 🔊 TTS completed in ${latency}ms (${audioBuffer.length} bytes raw WAV)`);
  
  // Strip WAV header and convert to 8kHz μ-law for Twilio
  const riffHeader = audioBuffer.slice(0, 4).toString('ascii');
  if (riffHeader === 'RIFF') {
    // Read actual sample rate from WAV header (bytes 24-27)
    const actualSampleRate = audioBuffer.readUInt32LE(24);
    console.log(`[GROQ-Voice] Processing WAV: actual sample rate = ${actualSampleRate}Hz, converting to 8kHz μ-law...`);
    
    // Skip 44-byte WAV header to get raw PCM
    const pcmSource = audioBuffer.slice(44);
    console.log(`[GROQ-Voice] PCM data: ${pcmSource.length} bytes at ${actualSampleRate}Hz`);
    
    // Downsample to 8kHz based on actual sample rate
    let pcm8k;
    if (actualSampleRate === 24000) {
      // Orpheus default: 24kHz → 8kHz (3:1 ratio)
      pcm8k = downsamplePCM(pcmSource, 24000, 8000);
    } else if (actualSampleRate === 22050) {
      // Some TTS models output 22.05kHz
      pcm8k = downsamplePCM(pcmSource, 22050, 8000);
    } else if (actualSampleRate === 16000) {
      // 16kHz → 8kHz (2:1)
      pcm8k = downsamplePCM(pcmSource, 16000, 8000);
    } else if (actualSampleRate === 8000) {
      // Already at target rate
      pcm8k = pcmSource;
    } else {
      // Generic downsampling for any rate
      pcm8k = downsamplePCM(pcmSource, actualSampleRate, 8000);
    }
    console.log(`[GROQ-Voice] Downsampled to 8kHz: ${pcm8k.length} bytes`);
    
    // Convert 8kHz PCM to μ-law for Twilio
    audioBuffer = pcmToMulaw(pcm8k);
    console.log(`[GROQ-Voice] Final μ-law audio: ${audioBuffer.length} bytes`);
  }
  
  return audioBuffer;
}

// Convert PCM audio to μ-law for Twilio
function pcmToMulaw(pcmBuffer) {
  const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
  
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    mulawBuffer[i / 2] = linearToMulaw(sample);
  }
  
  return mulawBuffer;
}

// Generic PCM downsampler for any source rate to target rate
function downsamplePCM(pcmSource, sourceRate, targetRate) {
  const ratio = sourceRate / targetRate;
  const samplesIn = pcmSource.length / 2;
  const samplesOut = Math.floor(samplesIn / ratio);
  const pcmOut = Buffer.alloc(samplesOut * 2);
  
  // Linear interpolation with anti-aliasing averaging
  for (let i = 0; i < samplesOut; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    
    // Average samples in the source window for anti-aliasing
    const windowSize = Math.ceil(ratio);
    let sum = 0;
    let count = 0;
    for (let j = 0; j < windowSize && (srcIdx + j) * 2 + 1 < pcmSource.length; j++) {
      sum += pcmSource.readInt16LE((srcIdx + j) * 2);
      count++;
    }
    const avg = count > 0 ? Math.round(sum / count) : 0;
    pcmOut.writeInt16LE(Math.max(-32768, Math.min(32767, avg)), i * 2);
  }
  
  return pcmOut;
}

// Convert PCM16 to μ-law
function pcm16ToMulaw(pcm16Buffer) {
  const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
  for (let i = 0; i < pcm16Buffer.length; i += 2) {
    const sample = pcm16Buffer.readInt16LE(i);
    mulawBuffer[i / 2] = linearToMulaw(sample);
  }
  return mulawBuffer;
}

/**
 * Build system prompt - SHORTENED for faster LLM response
 */
function buildSystemPrompt(maintenanceContext = null, options = {}) {
  const mode = options.mode || 'live';
  const turnPhase = options.turnPhase || 'conversation';
  const userGreeting = options.userGreeting || '';

  if (mode === 'voicemail') {
    let prompt = `You are Ava from HouseYield leaving a voicemail. Write ONE continuous message (3-5 sentences, no questions).`;
    if (maintenanceContext?.issue) prompt += ` Issue: ${maintenanceContext.issue}.`;
    if (maintenanceContext?.propertyAddress) prompt += ` Address: ${maintenanceContext.propertyAddress}.`;
    if (maintenanceContext?.tenantAvailability) prompt += ` Tenant availability: ${maintenanceContext.tenantAvailability}.`;
    prompt += ' Ask them to call back to schedule.';
    return prompt;
  }

  if (turnPhase === 'initial') {
    let prompt = `You are Ava from HouseYield. The person just said: "${userGreeting}".

FIRST RESPONSE ONLY:
- Match their greeting naturally
- Introduce yourself briefly as Ava from HouseYield
- Say you're calling about coordinating a repair
- Ask if now is a good time
- 1-2 short sentences max
- Do NOT explain the full issue yet`;

    if (maintenanceContext?.propertyAddress) {
      prompt += `\nProperty: ${maintenanceContext.propertyAddress}`;
    }
    if (maintenanceContext?.issue) {
      prompt += `\nIssue (save for later): ${maintenanceContext.issue}`;
    }
    return prompt;
  }

  let prompt = `You are Ava from HouseYield scheduling a repair on a live call. Be brief (1-2 sentences). Sound natural. Do not re-introduce yourself.`;

  if (maintenanceContext) {
    const { issue, urgency, propertyAddress, tenantAvailability } = maintenanceContext;
    if (issue) prompt += ` Issue: ${issue}.`;
    if (propertyAddress) prompt += ` Address: ${propertyAddress}.`;
    if (tenantAvailability) prompt += ` Tenant availability: ${tenantAvailability}.`;
    if (urgency === 'emergency' || urgency === 'high') prompt += ` URGENT.`;
  }
  
  return prompt;
}

// ===================================================================
// WEBSOCKET MEDIA STREAMING WITH GROQ
// ===================================================================

function setupGroqWebSocketServer(httpServer, publicUrl) {
  // Use noServer mode so we can share the http server with other WebSocket servers
  const wss = new WebSocketServer({
    noServer: true
  });

  // Register upgrade handler on the http server
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/groq-twilio-media') {
      console.log('[GROQ-Voice-WS] 🔄 Handling WebSocket upgrade for /groq-twilio-media');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Other paths will be handled by other WebSocket servers
  });

  wss.on('error', (error) => {
    console.error('[GROQ-Voice-WS] WebSocket server error:', error);
  });

  wss.on('connection', async (ws, req) => {
    console.log('[GROQ-Voice-WS] ========== NEW GROQ MEDIA CONNECTION ==========');
    
    // Security: Limit connections
    if (activeGroqSockets.size >= 10) {
      console.warn('[GROQ-Voice-WS] SECURITY: Too many active connections');
      ws.close(1008, 'Too many active connections');
      return;
    }
    
    activeGroqSockets.add(ws);
    
    let streamSid = null;
    let callSid = null;
    let audioBuffer = Buffer.alloc(0);
    let isProcessing = false;
    let silenceTimeout = null;
    let lastAudioTime = Date.now();
    let keepAliveInterval = null;
    let silentPacketCount = 0;  // Track consecutive silent packets
    let hasSpeechStarted = false;  // Only detect silence after speech has started
    let greetingSent = false;  // Track if greeting has been sent
    let isSpeaking = false;  // Track if AI is currently speaking (to prevent echo)
    let connectionClosed = false;  // Track if connection has been closed
    
    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      console.warn('[GROQ-Voice-WS] Connection timeout, closing');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Connection timeout');
      }
    }, 15 * 60 * 1000); // 15 minutes max

    // Send silence audio to keep the stream alive
    const startKeepAlive = () => {
      if (keepAliveInterval) return; // Already running
      
      console.log('[GROQ-Voice-WS] 🔄 Starting keep-alive silence stream');
      
      // Send one immediately before interval starts
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: SILENCE_CHUNK.toString('base64') }
        }));
      }
      
      keepAliveInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && streamSid) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: SILENCE_CHUNK.toString('base64') }
          }));
        }
      }, 50); // Send every 50ms to be more aggressive
    };

    const stopKeepAlive = () => {
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
    };

    // Generate a quick "hmm" thinking sound to fill the gap
    const sendThinkingAudio = async () => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      
      try {
        // Generate a quick filler phrase to let caller know we're processing
        const fillers = [
          "Let me check on that...",
          "One moment please...",
          "Just a second...",
          "Let me look into that..."
        ];
        const filler = fillers[Math.floor(Math.random() * fillers.length)];
        console.log(`[GROQ-Voice-WS] Sending filler: "${filler}"`);
        
        const fillerAudio = await textToSpeech(filler);
        
        if (ws.readyState === WebSocket.OPEN) {
          const chunkSize = 640;
          for (let i = 0; i < fillerAudio.length; i += chunkSize) {
            const chunk = fillerAudio.slice(i, i + chunkSize);
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: chunk.toString('base64') }
            }));
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
      } catch (err) {
        console.log('[GROQ-Voice-WS] Filler audio failed:', err.message);
      }
    };

    // Helper to stream audio chunk to Twilio - OPTIMIZED
    const streamAudioToTwilio = async (audioData) => {
      console.log(`[GROQ-Voice-WS] 📤 streamAudioToTwilio called, ws.readyState=${ws.readyState}, streamSid=${streamSid ? 'set' : 'null'}`);
      
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`[GROQ-Voice-WS] ⚠️ Cannot send audio - WebSocket state: ${ws.readyState} (OPEN=1)`);
        return;
      }
      if (!streamSid) {
        console.log('[GROQ-Voice-WS] ⚠️ Cannot send audio - no streamSid');
        return;
      }
      
      // Stop keep-alive during audio sending to avoid conflicts
      stopKeepAlive();
      
      // PREVENT ECHO: Set speaking flag and clear any buffered audio
      isSpeaking = true;
      audioBuffer = Buffer.alloc(0);  // Clear buffer - anything here is likely our own voice
      hasSpeechStarted = false;  // Reset speech detection
      silentPacketCount = 0;
      
      console.log(`[GROQ-Voice-WS] 📤 Sending ${audioData.length} bytes to Twilio (streamSid: ${streamSid})...`);
      
      // Calculate how long this audio will play: 8kHz μ-law = 8 bytes per ms
      const audioDurationMs = Math.ceil(audioData.length / 8);
      
      // Send all audio chunks at once (like greeting) - Twilio buffers them
      let chunksSent = 0;
      for (let i = 0; i < audioData.length; i += AUDIO_CHUNK_SIZE) {
        const chunk = audioData.slice(i, i + AUDIO_CHUNK_SIZE);
        if (ws.readyState !== WebSocket.OPEN) {
          console.log(`[GROQ-Voice-WS] ⚠️ WebSocket closed during audio send at chunk ${chunksSent}`);
          break;
        }
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        chunksSent++;
      }
      
      // Send a mark event to track when audio finishes playing
      if (ws.readyState === WebSocket.OPEN) {
        const markName = `audio_${Date.now()}`;
        ws.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark: { name: markName }
        }));
        console.log(`[GROQ-Voice-WS] 📤 Sent ${chunksSent} chunks (${audioDurationMs}ms audio) + mark: ${markName}`);
      } else {
        console.log(`[GROQ-Voice-WS] ⚠️ WebSocket closed before mark could be sent`);
      }
      
      // NON-BLOCKING: Set a timer to re-enable listening after audio plays
      setTimeout(() => {
        // DON'T clear audioBuffer here - user might have started speaking!
        // Just reset the detection state and start analyzing
        hasSpeechStarted = false;
        silentPacketCount = 0;
        isSpeaking = false;
        // Restart keep-alive after audio finishes
        startKeepAlive();
        console.log(`[GROQ-Voice-WS] 👂 Now listening for user speech... (buffer: ${audioBuffer.length} bytes)`);
      }, audioDurationMs + 200);
    };

    // ULTRA LOW LATENCY: Process audio with sentence-level streaming TTS
    const processAudioPipelineStreaming = async () => {
      if (isProcessing || audioBuffer.length < MIN_AUDIO_BYTES) return;
      
      isProcessing = true;
      const currentBuffer = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      
      try {
        const pipelineStart = Date.now();
        console.log(`[GROQ-Voice-WS] ⚡ PIPELINE START: ${currentBuffer.length} bytes`);
        
        // PARALLEL OPTIMIZATION: Start STT and prepare LLM context simultaneously
        const sttStart = Date.now();
        
        // Get conversation history BEFORE STT completes (parallel prep)
        const history = conversationHistoryStore.get(callSid) || [];
        const context = groqCallContextStore.get(callSid);
        
        // Run STT
        const transcription = await transcribeAudio(currentBuffer);
        console.log(`[GROQ-Voice-WS] 🎤 STT: ${Date.now() - sttStart}ms - "${transcription}"`);
        
        if (!transcription || transcription.trim().length === 0) {
          console.log('[GROQ-Voice-WS] Empty transcription, skipping');
          isProcessing = false;
          return;
        }
        
        // Add user message to history
        history.push({ role: 'user', content: transcription });
        const turnPhase = history.filter((entry) => entry.role === 'user').length <= 1 ? 'initial' : 'conversation';
        
        // Step 2 & 3: WORD-LEVEL STREAMING - Start TTS after just a few words
        let fullResponse = '';
        let firstAudioSent = false;
        let audioQueue = Promise.resolve(); // Sequential audio queue for smooth playback
        
        for await (const item of generateResponseStreaming(transcription, history, context, {
          turnPhase,
          userGreeting: transcription,
          mode: 'live'
        })) {
          if (item.type === 'phrase' || item.type === 'sentence') {
            const phrase = item.text;
            console.log(`[GROQ-Voice-WS] 📝 Phrase: "${phrase}"`);
            
            // Queue TTS sequentially for smooth audio (no overlapping)
            audioQueue = audioQueue.then(async () => {
              try {
                const ttsStart = Date.now();
                const audioData = await textToSpeech(phrase);
                
                if (!firstAudioSent) {
                  console.log(`[GROQ-Voice-WS] ⚡ TTFA: ${Date.now() - pipelineStart}ms`);
                  firstAudioSent = true;
                }
                
                await streamAudioToTwilio(audioData);
                console.log(`[GROQ-Voice-WS] 🔊 TTS: ${Date.now() - ttsStart}ms`);
              } catch (e) {
                console.error('[GROQ-Voice-WS] TTS error:', e.message);
              }
            });
          } else if (item.type === 'complete') {
            fullResponse = item.text;
          }
        }
        
        // Wait for all queued audio to finish playing
        await audioQueue;
        
        // Add assistant response to history
        history.push({ role: 'assistant', content: fullResponse });
        conversationHistoryStore.set(callSid, history);
        
        const totalLatency = Date.now() - pipelineStart;
        console.log(`[GROQ-Voice-WS] ✅ Pipeline complete: ${totalLatency}ms total`);
        
      } catch (error) {
        console.error('[GROQ-Voice-WS] Pipeline error:', error.message);
      }
      
      isProcessing = false;
    };

    // Legacy non-streaming pipeline (fallback)
    const processAudioPipeline = async () => {
      if (isProcessing || audioBuffer.length < MIN_AUDIO_BYTES) return;
      
      isProcessing = true;
      const currentBuffer = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      
      try {
        console.log(`[GROQ-Voice-WS] Processing ${currentBuffer.length} bytes of audio...`);
        
        // Step 1: Transcribe with GROQ Whisper
        const transcription = await transcribeAudio(currentBuffer);
        
        if (!transcription || transcription.trim().length === 0) {
          console.log('[GROQ-Voice-WS] Empty transcription, skipping');
          isProcessing = false;
          return;
        }
        
        // Get conversation history
        const history = conversationHistoryStore.get(callSid) || [];
        const context = groqCallContextStore.get(callSid);
        
        // Add user message to history
        history.push({ role: 'user', content: transcription });
        
        // Step 2: Generate response with GROQ LLM
        const response = await generateResponse(transcription, history, context);
        
        // Add assistant response to history
        history.push({ role: 'assistant', content: response.text });
        conversationHistoryStore.set(callSid, history);
        
        // Step 3: Convert to speech with GROQ TTS
        const audioData = await textToSpeech(response.text);
        
        // Step 4: Stream audio back to Twilio
        await streamAudioToTwilio(audioData);
        console.log('[GROQ-Voice-WS] 🔊 Audio streamed to caller');
        
      } catch (error) {
        console.error('[GROQ-Voice-WS] Pipeline error:', error.message);
      }
      
      isProcessing = false;
    };

    ws.on('message', async (data) => {
      // Skip if connection is already closed
      if (connectionClosed) return;
      
      try {
        const msg = JSON.parse(data.toString());
        
        // Handle connected event (first message from Twilio)
        if (msg.event === 'connected') {
          console.log('[GROQ-Voice-WS] ✅ Connected to Twilio:', { protocol: msg.protocol, version: msg.version });
          return;
        }

        if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log('[GROQ-Voice-WS] Stream started:', { streamSid, callSid });
          
          // Start keep-alive to prevent stream from closing
          startKeepAlive();
          
          // Initialize conversation history — wait for callee to speak first
          conversationHistoryStore.set(callSid, []);
          greetingSent = true;
          
          const context = groqCallContextStore.get(callSid);
          if (context) {
            console.log('[GROQ-Voice-WS] ✅ Retrieved context for call:', callSid);
          }
          console.log('[GROQ-Voice-WS] 👂 Live call — waiting for callee to greet first');
        }

        if (msg.event === 'media') {
          // Always accumulate audio from the caller
          const payload = Buffer.from(msg.media.payload, 'base64');
          audioBuffer = Buffer.concat([audioBuffer, payload]);
          lastAudioTime = Date.now();
          
          // Log every 10KB of audio received
          if (audioBuffer.length % 10000 < payload.length) {
            console.log(`[GROQ-Voice-WS] 📥 Audio buffer: ${audioBuffer.length} bytes`);
          }
          
          // ECHO PREVENTION: Don't process audio while AI is speaking
          // We still accumulate it, but don't analyze for silence/speech detection
          if (isSpeaking) {
            return;
          }
          
          // Detect silence by analyzing audio energy in this packet
          // μ-law audio: 0xFF (255) and 0x7F (127) represent silence
          // Calculate RMS energy of the packet
          let energy = 0;
          for (let i = 0; i < payload.length; i++) {
            // Convert μ-law to linear approximation for energy calculation
            const mulaw = payload[i];
            // μ-law silence is around 0xFF (255) or 0x7F (127)
            const deviation = Math.abs(mulaw - 0xFF);
            const deviation2 = Math.abs(mulaw - 0x7F);
            const minDeviation = Math.min(deviation, deviation2);
            energy += minDeviation * minDeviation;
          }
          const rmsEnergy = Math.sqrt(energy / payload.length);
          
          // Threshold for silence (adjust as needed)
          const SILENCE_THRESHOLD = 5; // Low energy = silence
          const isSilent = rmsEnergy < SILENCE_THRESHOLD;
          
          if (isSilent) {
            silentPacketCount++;
          } else {
            silentPacketCount = 0;
            hasSpeechStarted = true;
          }
          
          // After greeting is sent, speech has started, and we detect silence
          // ULTRA-AGGRESSIVE: Process as fast as possible
          const SILENCE_PACKETS_THRESHOLD = 5; // ~100ms of silence (5 packets @ 20ms) - INSTANT!
          const MIN_SPEECH_BYTES = 800; // Just 50ms of speech - super responsive
          const MAX_BUFFER_BYTES = 48000; // ~3 seconds max
          const FORCE_PROCESS_BYTES = 16000; // ~1 second - process quickly
          
          // Normal silence-based processing
          const shouldProcessSilence = greetingSent && hasSpeechStarted && silentPacketCount >= SILENCE_PACKETS_THRESHOLD && audioBuffer.length > MIN_SPEECH_BYTES && !isProcessing;
          
          // Force processing if buffer is getting too large (user is speaking a lot)
          const shouldForceProcess = greetingSent && hasSpeechStarted && audioBuffer.length > FORCE_PROCESS_BYTES && silentPacketCount >= 3 && !isProcessing;
          
          // Emergency processing if buffer is huge (prevents infinite growth)
          const shouldEmergencyProcess = greetingSent && audioBuffer.length > MAX_BUFFER_BYTES && !isProcessing;
          
          if (shouldProcessSilence || shouldForceProcess || shouldEmergencyProcess) {
            const reason = shouldEmergencyProcess ? 'EMERGENCY (max buffer)' : shouldForceProcess ? 'FORCE (large buffer + brief pause)' : 'silence';
            console.log(`[GROQ-Voice-WS] ⚡ Processing (${reason}): ${silentPacketCount} silent packets, ${audioBuffer.length} bytes, energy: ${rmsEnergy.toFixed(2)}`);
            silentPacketCount = 0;
            hasSpeechStarted = false;
            processAudioPipelineStreaming();
          }
        }

        if (msg.event === 'stop') {
          console.log('[GROQ-Voice-WS] ⛔ Stream stopped by Twilio:', JSON.stringify(msg.stop || msg, null, 2));
        }
        
        // Handle mark events - Twilio confirms when our audio finished playing
        if (msg.event === 'mark') {
          console.log(`[GROQ-Voice-WS] 🎯 Mark received: ${msg.mark?.name || 'unknown'} - audio playback confirmed`);
        }
        
        // Log any other events we might be missing
        if (!['start', 'media', 'stop', 'mark', 'connected'].includes(msg.event)) {
          console.log(`[GROQ-Voice-WS] 📨 Unknown event: ${msg.event}`, JSON.stringify(msg).slice(0, 200));
        }
      } catch (e) {
        console.error('[GROQ-Voice-WS] Message error:', e.message);
      }
    });

    ws.on('close', (code, reason) => {
      connectionClosed = true;  // Set flag to stop processing
      console.log(`[GROQ-Voice-WS] Connection closed - code: ${code}, reason: ${reason?.toString() || 'none'}`);
      clearTimeout(connectionTimeout);
      stopKeepAlive();
      if (silenceTimeout) clearTimeout(silenceTimeout);
      activeGroqSockets.delete(ws);
      
      // Clean up
      if (callSid) {
        groqCallContextStore.delete(callSid);
        conversationHistoryStore.delete(callSid);
      }
    });

    ws.on('error', (error) => {
      console.error('[GROQ-Voice-WS] Error:', error.message);
    });
  });

  console.log('✅ [GROQ-Voice] WebSocket server ready on /groq-twilio-media');
  return wss;
}

// ===================================================================
// API ENDPOINTS
// ===================================================================

/**
 * Make an outbound call using GROQ voice
 */
async function makeGroqOutboundCall(to, options = {}) {
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }
  
  if (!groqClient) {
    throw new Error('GROQ not configured');
  }

  // Validate phone number
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(to)) {
    throw new Error('Invalid phone number format. Must be E.164 format.');
  }

  const { publicUrl, maintenanceContext = null } = options;

  if (!publicUrl) {
    throw new Error('Public URL required for TwiML webhook');
  }

  const twimlUrl = `${publicUrl}/twiml/groq-voice`;

  const call = await twilioClient.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    url: twimlUrl,
    statusCallback: `${publicUrl}/twilio/groq-call-status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 60,
    timeLimit: 600 // 10 minutes max
  });

  // Store context for this call
  if (maintenanceContext) {
    groqCallContextStore.set(call.sid, maintenanceContext);
    console.log('[GROQ-Voice] ✅ Stored context for call:', call.sid);
    console.log('[GROQ-Voice] Issue:', maintenanceContext.issue || 'Not specified');
    console.log('[GROQ-Voice] Tenant Availability:', maintenanceContext.tenantAvailability || 'Not specified');
    
    // Auto-cleanup after 15 minutes
    setTimeout(() => {
      if (groqCallContextStore.has(call.sid)) {
        groqCallContextStore.delete(call.sid);
        conversationHistoryStore.delete(call.sid);
      }
    }, 15 * 60 * 1000);
  }

  return {
    callSid: call.sid,
    to: call.to,
    from: call.from,
    status: call.status,
    provider: 'groq',
    twimlUrl
  };
}

/**
 * Generate TwiML for GROQ voice call
 */
function generateGroqTwiML(req, publicUrl) {
  let wsUrl;
  let statusCallbackUrl;
  
  if (publicUrl) {
    const protocol = publicUrl.startsWith('https') ? 'wss' : 'ws';
    const urlWithoutProtocol = publicUrl.replace(/^https?:\/\//, '');
    wsUrl = `${protocol}://${urlWithoutProtocol}/groq-twilio-media`;
    statusCallbackUrl = `${publicUrl}/twilio/groq-stream-status`;
  } else {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/groq-twilio-media`;
    statusCallbackUrl = `${protocol}://${host}/twilio/groq-stream-status`;
  }

  // Add statusCallback to Stream to capture any errors
  // CRITICAL: mode="bidirectional" is required to send audio back to the caller
  // Without it, we can only receive audio, not send
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" statusCallback="${statusCallbackUrl}" mode="bidirectional">
      <Parameter name="provider" value="groq" />
    </Stream>
  </Connect>
</Response>`;

  console.log('[GROQ-Voice] Generated TwiML with WebSocket URL:', wsUrl);
  console.log('[GROQ-Voice] Stream status callback:', statusCallbackUrl);
  console.log('[GROQ-Voice] TwiML:', twiml);
  return twiml;
}

/**
 * Check GROQ voice status
 */
function getGroqVoiceStatus() {
  return {
    configured: !!groqClient && !!twilioClient,
    groqReady: !!groqClient,
    twilioReady: !!twilioClient,
    activeCalls: activeGroqSockets.size,
    models: {
      stt: GROQ_STT_MODEL,
      llm: GROQ_LLM_MODEL,
      tts: GROQ_TTS_MODEL,
      voice: GROQ_TTS_VOICE
    }
  };
}

// ===================================================================
// EXPORTS
// ===================================================================

export {
  setupGroqWebSocketServer,
  makeGroqOutboundCall,
  generateGroqTwiML,
  getGroqVoiceStatus,
  groqClient,
  twilioClient,
  activeGroqSockets,
  groqCallContextStore
};
