/**
 * ElevenLabs + GROQ LPU Hybrid Voice Module
 * 
 * ARCHITECTURE:
 *   1. Twilio audio → GROQ Whisper STT (ultra-fast transcription via LPU)
 *   2. Transcribed text → GROQ LLM (ultra-fast inference via LPU)  
 *   3. LLM response → ElevenLabs V3 Alpha TTS (best-quality voice: Liam)
 *   4. Audio → Twilio (streamed back to caller)
 * 
 * This hybrid approach gives you:
 *   - GROQ's 10x faster LLM inference via LPU chips
 *   - ElevenLabs' industry-leading V3 Alpha voice quality
 *   - Streaming TTS for lowest perceived latency
 * 
 * ElevenLabs Voice: v3-alpha-liam (best natural-sounding voice as of 2025)
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import Groq from 'groq-sdk';

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

// GROQ Models - Speed optimized LPU inference
const GROQ_STT_MODEL = 'whisper-large-v3-turbo'; // Fastest quality STT
const GROQ_LLM_MODEL = 'openai/gpt-oss-120b';    // OpenAI's 120B model on GROQ - fast + smart

// ElevenLabs V3 Alpha - Best voice quality
// Available v3-alpha voices: liam, jessica, charlie, matilda, etc.
const ELEVENLABS_MODEL = 'eleven_v3';  // ElevenLabs V3 Alpha - most human-like and expressive
const ELEVENLABS_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ';  // Liam v3-alpha voice ID
const ELEVENLABS_OUTPUT_FORMAT = 'ulaw_8000';     // Direct μ-law for Twilio - no conversion needed!

// Ultra-low latency settings
const LLM_MAX_TOKENS = 80;
const AUDIO_CHUNK_SIZE = 640; // 80ms of 8kHz μ-law

// Track active connections
const activeElevenlabsSockets = new Set();

// Store conversation history and context
const callContextStore = new Map();
const conversationHistoryStore = new Map();

// Pre-warm flag
let groqConnectionWarmed = false;

// Initialize GROQ client
let groqClient = null;
if (GROQ_API_KEY) {
  groqClient = new Groq({ apiKey: GROQ_API_KEY });
  console.log('✅ [ElevenLabs-GROQ] GROQ client initialized');
  
  // Pre-warm GROQ connection
  setTimeout(async () => {
    try {
      console.log('[ElevenLabs-GROQ] 🔥 Pre-warming GROQ LPU connection...');
      await groqClient.chat.completions.create({
        model: GROQ_LLM_MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream: false
      });
      groqConnectionWarmed = true;
      console.log('[ElevenLabs-GROQ] ✅ GROQ LPU connection pre-warmed');
    } catch (e) {
      console.log('[ElevenLabs-GROQ] Pre-warm failed (non-critical):', e.message);
    }
  }, 2000);
} else {
  console.warn('⚠️  [ElevenLabs-GROQ] GROQ_API_KEY not configured');
}

// Validate ElevenLabs API key
if (!ELEVENLABS_API_KEY) {
  console.warn('⚠️  [ElevenLabs-GROQ] ELEVENLABS_API_KEY not configured - voice calls will use fallback');
}

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [ElevenLabs-GROQ] Twilio client initialized with API Key');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [ElevenLabs-GROQ] Twilio client initialized');
} else {
  console.warn('⚠️  [ElevenLabs-GROQ] Twilio not configured');
}

// ===================================================================
// AUDIO FORMAT CONVERSION (μ-law for Twilio)
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
// GROQ LPU - SPEECH-TO-TEXT (Ultra-fast)
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
  console.log(`[ElevenLabs-GROQ] 🎤 STT (GROQ LPU) in ${latency}ms: "${transcription.text}"`);
  
  return transcription.text;
}

// ===================================================================
// GROQ LPU - LLM RESPONSE (Ultra-fast streaming)
// ===================================================================

async function* generateResponseStreaming(userMessage, conversationHistory, context) {
  if (!groqClient) throw new Error('GROQ client not initialized');
  
  const startTime = Date.now();
  const systemPrompt = buildSystemPrompt(context);
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-4),
    { role: 'user', content: userMessage }
  ];
  
  console.log(`[ElevenLabs-GROQ] 🚀 LLM (GROQ LPU) request starting...`);
  
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
        console.log(`[ElevenLabs-GROQ] 📝 Yielding phrase: "${textToSpeak}"`);
        yield { type: 'phrase', text: textToSpeak };
        buffer = '';
      }
    }
  }
  
  if (buffer.trim().length > 0) {
    yield { type: 'phrase', text: buffer.trim() };
  }
  
  const latency = Date.now() - startTime;
  console.log(`[ElevenLabs-GROQ] 🤖 LLM completed in ${latency}ms: "${fullResponse}"`);
  
  yield { type: 'complete', text: fullResponse };
}

function buildSystemPrompt(context = null) {
  let prompt = `You're a helpful phone assistant. Keep responses brief (1-2 sentences). Use natural, casual speech.`;
  
  if (context) {
    const { issue, urgency, propertyAddress, purpose } = context;
    if (purpose) prompt += ` Purpose: ${purpose}.`;
    if (issue) prompt += ` Issue: ${issue}.`;
    if (propertyAddress) prompt += ` Property: ${propertyAddress}.`;
    if (urgency === 'emergency' || urgency === 'high') prompt += ` This is URGENT.`;
  }
  
  return prompt;
}

// ===================================================================
// ELEVENLABS V3 ALPHA - TEXT-TO-SPEECH (Best quality voice)
// ===================================================================

/**
 * ElevenLabs TTS with streaming support
 * Uses the V3 Alpha Liam voice - best natural-sounding AI voice
 * 
 * Returns μ-law 8kHz audio ready for Twilio (no conversion needed!)
 */
async function textToSpeechElevenLabs(text, voiceId = ELEVENLABS_VOICE_ID) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key not configured');
  }
  
  const startTime = Date.now();
  
  console.log(`[ElevenLabs-GROQ] 🎙️ ElevenLabs TTS request: "${text.substring(0, 50)}..." (voice: ${voiceId})`);
  
  // ElevenLabs TTS API - request μ-law 8kHz directly for Twilio
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/basic', // μ-law audio
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
    console.error(`[ElevenLabs-GROQ] TTS error: ${response.status} ${errorText}`);
    throw new Error(`ElevenLabs TTS failed: ${response.status}`);
  }
  
  // Audio is already in μ-law 8kHz format - ready for Twilio!
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  
  const latency = Date.now() - startTime;
  console.log(`[ElevenLabs-GROQ] 🔊 ElevenLabs TTS completed in ${latency}ms (${audioBuffer.length} bytes μ-law)`);
  
  return audioBuffer;
}

/**
 * ElevenLabs streaming TTS for lowest latency
 * Streams audio chunks as they're generated
 */
async function* textToSpeechElevenLabsStreaming(text, voiceId = ELEVENLABS_VOICE_ID) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key not configured');
  }
  
  const startTime = Date.now();
  console.log(`[ElevenLabs-GROQ] 🎙️ ElevenLabs Streaming TTS: "${text.substring(0, 50)}..."`);
  
  // Use streaming endpoint
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
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
    throw new Error(`ElevenLabs streaming TTS failed: ${response.status} - ${errorText}`);
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
  console.log(`[ElevenLabs-GROQ] 🔊 Streaming TTS completed in ${latency}ms (${totalBytes} bytes total)`);
}

// ===================================================================
// VOICE LIST & CONFIGURATION HELPERS
// ===================================================================

/**
 * Get list of available ElevenLabs voices
 * Useful for voice selection UI
 */
async function getElevenLabsVoices() {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ElevenLabs API key not configured');
  }
  
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get voices: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Return formatted voice list
  return data.voices.map(voice => ({
    voice_id: voice.voice_id,
    name: voice.name,
    category: voice.category,
    labels: voice.labels,
    preview_url: voice.preview_url
  }));
}

/**
 * Recommended V3 Alpha voices for phone calls
 */
const RECOMMENDED_VOICES = {
  // V3 Alpha voices - best quality
  'liam': { id: 'TX3LPaxmHKxFdv7VOQHJ', description: 'Young American male, natural & conversational' },
  'jessica': { id: 'cgSgspJ2msm6clMCkdW9', description: 'Young American female, warm & friendly' },
  'charlie': { id: 'IKne3meq5aSn9XLyUdCD', description: 'Australian male, casual & engaging' },
  'matilda': { id: 'XrExE9yKIg1WjnnlVkGX', description: 'Middle-aged female, professional' },
  'brian': { id: 'nPczCjzI2devNBz1zQrb', description: 'Middle-aged American male, authoritative' },
  
  // Turbo voices - faster, slightly less quality
  'sarah': { id: 'EXAVITQu4vr4xnSDxMaL', description: 'Female, neutral American accent' },
  'roger': { id: 'CwhRBWXzGAHq8TQ4Fs17', description: 'Male, neutral American accent' }
};

// ===================================================================
// WEBSOCKET MEDIA STREAMING
// ===================================================================

function setupElevenLabsGroqWebSocketServer(httpServer, publicUrl) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/elevenlabs-groq-media') {
      console.log('[ElevenLabs-GROQ-WS] 🔄 Handling WebSocket upgrade');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('error', (error) => {
    console.error('[ElevenLabs-GROQ-WS] WebSocket error:', error);
  });

  wss.on('connection', async (ws, req) => {
    console.log('[ElevenLabs-GROQ-WS] ========== NEW ELEVENLABS+GROQ MEDIA CONNECTION ==========');
    
    if (activeElevenlabsSockets.size >= 10) {
      console.warn('[ElevenLabs-GROQ-WS] Too many active connections');
      ws.close(1008, 'Too many connections');
      return;
    }
    
    activeElevenlabsSockets.add(ws);
    
    let streamSid = null;
    let callSid = null;
    let audioBuffer = Buffer.alloc(0);
    let isProcessing = false;
    let silenceTimeout = null;
    let lastAudioTime = Date.now();
    let keepAliveInterval = null;
    let hasSpeechStarted = false;
    let greetingSent = false;
    let isSpeaking = false;
    let connectionClosed = false;
    
    const connectionTimeout = setTimeout(() => {
      console.warn('[ElevenLabs-GROQ-WS] Connection timeout');
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Timeout');
      }
    }, 15 * 60 * 1000);

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

    // Stream audio to Twilio
    const streamAudioToTwilio = async (audioData) => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      
      stopKeepAlive();
      isSpeaking = true;
      
      const chunkSize = 640;
      for (let i = 0; i < audioData.length; i += chunkSize) {
        if (ws.readyState !== WebSocket.OPEN) break;
        
        const chunk = audioData.slice(i, Math.min(i + chunkSize, audioData.length));
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        
        // Pace the audio - 80ms per chunk
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      
      isSpeaking = false;
      startKeepAlive();
    };

    // Stream ElevenLabs audio directly to Twilio as it generates
    const streamElevenLabsToTwilio = async (text) => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      
      stopKeepAlive();
      isSpeaking = true;
      
      try {
        for await (const audioChunk of textToSpeechElevenLabsStreaming(text)) {
          if (ws.readyState !== WebSocket.OPEN) break;
          
          // Send chunk to Twilio
          const chunkSize = 640;
          for (let i = 0; i < audioChunk.length; i += chunkSize) {
            const chunk = audioChunk.slice(i, Math.min(i + chunkSize, audioChunk.length));
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: chunk.toString('base64') }
            }));
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
      } catch (error) {
        console.error('[ElevenLabs-GROQ-WS] Streaming TTS error:', error.message);
      }
      
      isSpeaking = false;
      startKeepAlive();
    };

    // Process user speech and generate AI response
    const processAudioAndRespond = async () => {
      if (audioBuffer.length < 1600 || isProcessing) return;
      
      isProcessing = true;
      const audioToProcess = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      
      console.log(`[ElevenLabs-GROQ-WS] Processing ${audioToProcess.length} bytes of audio`);
      
      try {
        // 1. GROQ STT - Ultra-fast via LPU
        const transcription = await transcribeAudio(audioToProcess);
        
        if (!transcription || transcription.trim().length < 2) {
          console.log('[ElevenLabs-GROQ-WS] Empty transcription, skipping');
          isProcessing = false;
          return;
        }
        
        console.log(`[ElevenLabs-GROQ-WS] 👤 User said: "${transcription}"`);
        
        // Get conversation history
        let history = conversationHistoryStore.get(callSid) || [];
        history.push({ role: 'user', content: transcription });
        
        // 2. GROQ LLM - Ultra-fast via LPU (streaming)
        let fullResponse = '';
        const context = callContextStore.get(callSid) || {};
        
        for await (const chunk of generateResponseStreaming(transcription, history, context)) {
          if (chunk.type === 'phrase') {
            // 3. ElevenLabs TTS - Stream each phrase immediately
            await streamElevenLabsToTwilio(chunk.text);
            fullResponse += chunk.text + ' ';
          } else if (chunk.type === 'complete') {
            fullResponse = chunk.text;
          }
        }
        
        // Update history
        history.push({ role: 'assistant', content: fullResponse.trim() });
        conversationHistoryStore.set(callSid, history.slice(-10));
        
      } catch (error) {
        console.error('[ElevenLabs-GROQ-WS] Processing error:', error.message);
        
        // Fallback error message
        try {
          const errorAudio = await textToSpeechElevenLabs("I'm sorry, I didn't catch that. Could you repeat?");
          await streamAudioToTwilio(errorAudio);
        } catch (e) {
          console.error('[ElevenLabs-GROQ-WS] Error response TTS failed:', e.message);
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
            console.log('[ElevenLabs-GROQ-WS] 🔗 Twilio media stream connected');
            break;
            
          case 'start':
            streamSid = message.start.streamSid;
            callSid = message.start.callSid;
            console.log(`[ElevenLabs-GROQ-WS] 📞 Call started: ${callSid}`);
            
            // Initialize conversation
            conversationHistoryStore.set(callSid, []);
            
            // Send greeting
            if (!greetingSent) {
              greetingSent = true;
              const context = callContextStore.get(callSid) || {};
              const greeting = context.greeting || "Hello! How can I help you today?";
              
              try {
                const greetingAudio = await textToSpeechElevenLabs(greeting);
                await streamAudioToTwilio(greetingAudio);
              } catch (e) {
                console.error('[ElevenLabs-GROQ-WS] Greeting TTS failed:', e.message);
              }
            }
            break;
            
          case 'media':
            if (isSpeaking) break; // Ignore audio while speaking
            
            lastAudioTime = Date.now();
            const audioChunk = Buffer.from(message.media.payload, 'base64');
            audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
            
            // Detect end of speech (silence)
            if (silenceTimeout) clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
              if (audioBuffer.length > 1600 && !isProcessing) {
                hasSpeechStarted = true;
                processAudioAndRespond();
              }
            }, 600); // 600ms silence = end of speech
            
            // Limit buffer size
            if (audioBuffer.length > 320000) {
              audioBuffer = audioBuffer.slice(-160000);
            }
            break;
            
          case 'stop':
            console.log(`[ElevenLabs-GROQ-WS] 📴 Call ended: ${callSid}`);
            connectionClosed = true;
            break;
        }
      } catch (error) {
        console.error('[ElevenLabs-GROQ-WS] Message error:', error.message);
      }
    });

    ws.on('close', () => {
      console.log('[ElevenLabs-GROQ-WS] WebSocket closed');
      connectionClosed = true;
      activeElevenlabsSockets.delete(ws);
      stopKeepAlive();
      clearTimeout(connectionTimeout);
      if (silenceTimeout) clearTimeout(silenceTimeout);
      
      // Cleanup
      if (callSid) {
        callContextStore.delete(callSid);
        conversationHistoryStore.delete(callSid);
      }
    });

    ws.on('error', (error) => {
      console.error('[ElevenLabs-GROQ-WS] Error:', error.message);
    });
  });

  return wss;
}

// ===================================================================
// EXPRESS ROUTES FOR TWILIO
// ===================================================================

function setupElevenLabsGroqRoutes(app, publicUrl) {
  // TwiML endpoint for incoming/outgoing calls
  app.post('/elevenlabs-groq-voice', (req, res) => {
    console.log('[ElevenLabs-GROQ] 📞 Voice webhook called');
    
    const wsUrl = publicUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/elevenlabs-groq-media">
      <Parameter name="track" value="inbound" />
    </Stream>
  </Connect>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  });

  // API to initiate outbound call
  app.post('/api/elevenlabs-groq/call', async (req, res) => {
    try {
      const { to, context = {} } = req.body;
      
      if (!to) {
        return res.status(400).json({ error: 'Phone number required' });
      }
      
      if (!twilioClient) {
        return res.status(500).json({ error: 'Twilio not configured' });
      }
      
      console.log(`[ElevenLabs-GROQ] 📞 Initiating call to ${to}`);
      
      const call = await twilioClient.calls.create({
        to,
        from: TWILIO_FROM_NUMBER,
        url: `${publicUrl}/elevenlabs-groq-voice`,
        statusCallback: `${publicUrl}/api/elevenlabs-groq/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
      });
      
      // Store context for this call
      callContextStore.set(call.sid, context);
      
      res.json({
        success: true,
        callSid: call.sid,
        status: call.status,
        message: 'Call initiated with ElevenLabs V3 Alpha voice'
      });
      
    } catch (error) {
      console.error('[ElevenLabs-GROQ] Call error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Call status webhook
  app.post('/api/elevenlabs-groq/status', (req, res) => {
    const { CallSid, CallStatus } = req.body;
    console.log(`[ElevenLabs-GROQ] 📊 Call ${CallSid} status: ${CallStatus}`);
    res.sendStatus(200);
  });

  // Get available voices
  app.get('/api/elevenlabs-groq/voices', async (req, res) => {
    try {
      const voices = await getElevenLabsVoices();
      res.json({ 
        voices,
        recommended: RECOMMENDED_VOICES,
        current: {
          voice_id: ELEVENLABS_VOICE_ID,
          model: ELEVENLABS_MODEL
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Test TTS endpoint
  app.post('/api/elevenlabs-groq/test-tts', async (req, res) => {
    try {
      const { text = "Hello! This is a test of the ElevenLabs V3 Alpha Liam voice.", voice_id } = req.body;
      
      const startTime = Date.now();
      const audio = await textToSpeechElevenLabs(text, voice_id || ELEVENLABS_VOICE_ID);
      const latency = Date.now() - startTime;
      
      res.json({
        success: true,
        latency_ms: latency,
        audio_bytes: audio.length,
        voice_id: voice_id || ELEVENLABS_VOICE_ID,
        format: 'ulaw_8000'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  console.log('✅ [ElevenLabs-GROQ] Routes configured');
}

// ===================================================================
// EXPORTS
// ===================================================================

export {
  setupElevenLabsGroqWebSocketServer,
  setupElevenLabsGroqRoutes,
  textToSpeechElevenLabs,
  textToSpeechElevenLabsStreaming,
  getElevenLabsVoices,
  RECOMMENDED_VOICES,
  transcribeAudio,
  generateResponseStreaming
};

export default {
  setupWebSocketServer: setupElevenLabsGroqWebSocketServer,
  setupRoutes: setupElevenLabsGroqRoutes
};
