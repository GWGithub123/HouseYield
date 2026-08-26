/**
 * Twilio Phone Call System - GROQ Voice Integration (Fresh Implementation)
 * 
 * Clean implementation of phone call system using:
 *   - GROQ Whisper for Speech-to-Text (ultra-fast)
 *   - GROQ LLaMA for AI conversation  
 *   - GROQ PlayAI TTS for Text-to-Speech (Orpheus voice)
 *   - Twilio for phone call handling
 * 
 * Architecture:
 *   Caller speaks → Twilio captures audio → WebSocket → GROQ STT → LLM → TTS → Twilio plays
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import Groq from 'groq-sdk';

// ===================================================================
// CONFIGURATION
// ===================================================================

const CONFIG = {
  // GROQ API
  groqApiKey: process.env.GROQ_API_KEY || process.env.GROQ_API_Key,
  
  // Twilio credentials
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioApiKeySid: process.env.TWILIO_API_KEY_SID,
  twilioApiKeySecret: process.env.TWILIO_API_KEY_SECRET,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
  
  // Audio settings
  sampleRate: 8000, // Twilio uses 8kHz μ-law
  
  // GROQ Models - Same as browser voice assistant
  sttModel: 'whisper-large-v3-turbo',
  llmModel: 'llama-3.3-70b-versatile',
  ttsModel: 'playai-tts', // Orpheus English TTS (same as browser)
  ttsVoice: 'Fritz-PlayAI',
  
  // Latency tuning
  silenceDetectionMs: 200,    // Wait for pause before processing
  minAudioBytes: 2500,        // Minimum audio before processing
  maxLlmTokens: 100,          // Keep responses short
  minWordsForTts: 2,          // Start TTS after N words
  chunkSize: 640,             // Audio chunk size (80ms)
  
  // Connection limits
  maxConnections: 20,
  connectionTimeoutMs: 20 * 60 * 1000, // 20 minutes
};

// ===================================================================
// CLIENTS INITIALIZATION
// ===================================================================

let groq = null;
let twilioClient = null;

// Active calls tracking
const activeCalls = new Map();
const callHistory = new Map();
const callContext = new Map();

// Initialize GROQ
if (CONFIG.groqApiKey) {
  groq = new Groq({ apiKey: CONFIG.groqApiKey });
  console.log('✅ [Phone] GROQ client initialized');
} else {
  console.warn('⚠️  [Phone] GROQ_API_KEY not set - phone calls disabled');
}

// Initialize Twilio
if (CONFIG.twilioApiKeySid && CONFIG.twilioApiKeySecret && CONFIG.twilioAccountSid) {
  twilioClient = twilio(CONFIG.twilioApiKeySid, CONFIG.twilioApiKeySecret, {
    accountSid: CONFIG.twilioAccountSid
  });
  console.log('✅ [Phone] Twilio initialized with API Key');
} else if (CONFIG.twilioAccountSid && CONFIG.twilioAuthToken) {
  twilioClient = twilio(CONFIG.twilioAccountSid, CONFIG.twilioAuthToken);
  console.log('✅ [Phone] Twilio initialized with Auth Token');
} else {
  console.warn('⚠️  [Phone] Twilio not configured');
}

// ===================================================================
// AUDIO CONVERSION (μ-law <-> Linear PCM)
// ===================================================================

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
  
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function mulawToLinear(mulaw) {
  mulaw = ~mulaw;
  const sign = (mulaw & 0x80) !== 0;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// Convert μ-law to WAV for Whisper
function mulawToWav(mulawBuffer) {
  const numSamples = mulawBuffer.length;
  const pcmData = Buffer.alloc(numSamples * 2);
  
  for (let i = 0; i < numSamples; i++) {
    const linear = mulawToLinear(mulawBuffer[i]);
    pcmData.writeInt16LE(linear, i * 2);
  }
  
  // WAV header
  const header = Buffer.alloc(44);
  const dataSize = pcmData.length;
  
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(CONFIG.sampleRate, 24);
  header.writeUInt32LE(CONFIG.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  
  return Buffer.concat([header, pcmData]);
}

// ===================================================================
// GROQ API FUNCTIONS
// ===================================================================

/**
 * Speech-to-Text using GROQ Whisper
 */
async function transcribe(audioBuffer) {
  if (!groq) throw new Error('GROQ not initialized');
  
  const start = Date.now();
  const wavBuffer = mulawToWav(audioBuffer);
  const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
  
  const result = await groq.audio.transcriptions.create({
    file: audioFile,
    model: CONFIG.sttModel,
    language: 'en',
    response_format: 'json',
    temperature: 0.0
  });
  
  console.log(`[Phone] 🎤 STT (${Date.now() - start}ms): "${result.text}"`);
  return result.text || '';
}

/**
 * Generate AI response with streaming
 */
async function* generateResponse(userMessage, history, context) {
  if (!groq) throw new Error('GROQ not initialized');
  
  const start = Date.now();
  
  // Build system prompt
  let systemPrompt = `You are an AI assistant on a phone call. Keep responses brief (1-2 sentences). Be natural and conversational.`;
  
  if (context) {
    systemPrompt = `You are an AI assistant helping with property maintenance. 
Issue: ${context.issue || context.serviceCategory || 'general maintenance'}
${context.propertyAddress ? `Property: ${context.propertyAddress}` : ''}
${context.urgency === 'emergency' ? 'This is URGENT!' : ''}
${context.tenantAvailability ? `Tenant availability: ${context.tenantAvailability}` : ''}

Keep responses brief (1-2 sentences). Be professional and helpful.`;
  }
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    { role: 'user', content: userMessage }
  ];
  
  const stream = await groq.chat.completions.create({
    model: CONFIG.llmModel,
    messages,
    temperature: 0.5,
    max_tokens: CONFIG.maxLlmTokens,
    stream: true
  });
  
  let buffer = '';
  let fullResponse = '';
  let wordCount = 0;
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    buffer += content;
    fullResponse += content;
    
    // Count words in buffer
    wordCount = buffer.trim().split(/\s+/).filter(w => w.length > 0).length;
    
    // Yield phrases on punctuation
    const match = buffer.match(/[.!?,;:]/);
    if (match) {
      const endIndex = match.index + 1;
      const phrase = buffer.slice(0, endIndex).trim();
      buffer = buffer.slice(endIndex).trim();
      wordCount = 0;
      
      if (phrase.length > 0) {
        yield { type: 'phrase', text: phrase };
      }
    }
    
    // Or yield after enough words
    if (wordCount >= CONFIG.minWordsForTts && buffer.includes(' ')) {
      const lastSpace = buffer.lastIndexOf(' ');
      if (lastSpace > 3) {
        const phrase = buffer.slice(0, lastSpace).trim();
        buffer = buffer.slice(lastSpace).trim();
        wordCount = 0;
        
        if (phrase.length > 0) {
          yield { type: 'phrase', text: phrase };
        }
      }
    }
  }
  
  // Yield remaining
  if (buffer.trim().length > 0) {
    yield { type: 'phrase', text: buffer.trim() };
  }
  
  console.log(`[Phone] 🤖 LLM (${Date.now() - start}ms): "${fullResponse}"`);
  yield { type: 'done', text: fullResponse };
}

/**
 * Text-to-Speech using GROQ PlayAI
 */
async function speak(text) {
  if (!groq) throw new Error('GROQ not initialized');
  
  const start = Date.now();
  
  const response = await groq.audio.speech.create({
    model: CONFIG.ttsModel,
    voice: CONFIG.ttsVoice,
    input: text,
    response_format: 'mulaw',
    sample_rate: CONFIG.sampleRate
  });
  
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  
  // Strip WAV header if present
  if (audioBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
    console.log(`[Phone] 🔊 TTS (${Date.now() - start}ms): ${audioBuffer.length - 44} bytes`);
    return audioBuffer.slice(44);
  }
  
  console.log(`[Phone] 🔊 TTS (${Date.now() - start}ms): ${audioBuffer.length} bytes`);
  return audioBuffer;
}

// ===================================================================
// WEBSOCKET HANDLER
// ===================================================================

function setupPhoneWebSocket(httpServer, publicUrl) {
  // Use noServer mode so we can share the http server with other WebSocket servers
  const wss = new WebSocketServer({
    noServer: true
  });
  
  // Register upgrade handler on the http server
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/phone-media') {
      console.log('[Phone] 🔄 Handling WebSocket upgrade for /phone-media');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Other paths will be handled by other WebSocket servers
  });
  
  wss.on('error', (error) => {
    console.error('[Phone] WebSocket server error:', error);
  });
  
  wss.on('connection', (ws, req) => {
    console.log('[Phone] ═══════════════════════════════════════════');
    console.log('[Phone] 📞 NEW PHONE CALL CONNECTION');
    console.log('[Phone] ═══════════════════════════════════════════');
    
    // Limit connections
    if (activeCalls.size >= CONFIG.maxConnections) {
      console.warn('[Phone] Too many active calls, rejecting');
      ws.close(1013, 'Too many connections');
      return;
    }
    
    // Call state
    let streamSid = null;
    let callSid = null;
    let audioBuffer = Buffer.alloc(0);
    let isProcessing = false;
    let silenceTimer = null;
    
    // Connection timeout
    const timeout = setTimeout(() => {
      console.log('[Phone] Connection timeout');
      ws.close(1000, 'Timeout');
    }, CONFIG.connectionTimeoutMs);
    
    // Send audio to Twilio
    const sendAudio = async (audioData) => {
      if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
      
      for (let i = 0; i < audioData.length; i += CONFIG.chunkSize) {
        const chunk = audioData.slice(i, i + CONFIG.chunkSize);
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') }
        }));
        // Small delay for smooth playback
        await new Promise(r => setTimeout(r, 2));
      }
    };
    
    // Process user speech
    const processSpeech = async () => {
      if (isProcessing || audioBuffer.length < CONFIG.minAudioBytes) return;
      
      isProcessing = true;
      const currentAudio = audioBuffer;
      audioBuffer = Buffer.alloc(0);
      
      const pipelineStart = Date.now();
      
      try {
        console.log(`[Phone] ⚡ Processing ${currentAudio.length} bytes...`);
        
        // 1. Transcribe
        const text = await transcribe(currentAudio);
        
        if (!text || text.trim().length === 0) {
          console.log('[Phone] Empty transcription, skipping');
          isProcessing = false;
          return;
        }
        
        // Get call history
        const history = callHistory.get(callSid) || [];
        const context = callContext.get(callSid);
        
        // Add user message
        history.push({ role: 'user', content: text });
        
        // 2. Generate response with streaming TTS
        let fullResponse = '';
        let firstAudio = false;
        let audioQueue = Promise.resolve();
        
        for await (const item of generateResponse(text, history, context)) {
          if (item.type === 'phrase') {
            // Queue TTS to play sequentially
            audioQueue = audioQueue.then(async () => {
              try {
                const audio = await speak(item.text);
                
                if (!firstAudio) {
                  console.log(`[Phone] ⚡ Time to first audio: ${Date.now() - pipelineStart}ms`);
                  firstAudio = true;
                }
                
                await sendAudio(audio);
              } catch (e) {
                console.error('[Phone] TTS error:', e.message);
              }
            });
          } else if (item.type === 'done') {
            fullResponse = item.text;
          }
        }
        
        // Wait for all audio
        await audioQueue;
        
        // Save response to history
        history.push({ role: 'assistant', content: fullResponse });
        callHistory.set(callSid, history);
        
        console.log(`[Phone] ✅ Pipeline complete: ${Date.now() - pipelineStart}ms`);
        
      } catch (error) {
        console.error('[Phone] Pipeline error:', error.message);
      }
      
      isProcessing = false;
    };
    
    // Handle messages
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event === 'start') {
          streamSid = msg.start?.streamSid;
          callSid = msg.start?.callSid;
          
          console.log(`[Phone] 📞 Call started: ${callSid}`);
          
          activeCalls.set(callSid, { ws, streamSid, startTime: Date.now() });
          callHistory.set(callSid, []);
          
          // Get context if available
          const context = callContext.get(callSid);
          
          // Send greeting
          let greeting = "Hi! This is calling about a property I manage. How can I help you today?";
          
          if (context?.issue) {
            greeting = `Hi there! I'm calling about a ${context.serviceCategory || 'maintenance'} issue at one of my properties. Do you have a moment to discuss?`;
          }
          
          try {
            console.log('[Phone] Sending greeting...');
            const greetingAudio = await speak(greeting);
            
            // Add to history
            const history = callHistory.get(callSid) || [];
            history.push({ role: 'assistant', content: greeting });
            callHistory.set(callSid, history);
            
            await sendAudio(greetingAudio);
            console.log('[Phone] ✅ Greeting sent');
          } catch (err) {
            console.error('[Phone] Greeting error:', err.message);
          }
        }
        
        if (msg.event === 'media') {
          // Accumulate audio
          const payload = Buffer.from(msg.media.payload, 'base64');
          audioBuffer = Buffer.concat([audioBuffer, payload]);
          
          // Reset silence timer
          if (silenceTimer) clearTimeout(silenceTimer);
          
          // Process after silence
          silenceTimer = setTimeout(() => {
            if (audioBuffer.length > CONFIG.minAudioBytes && !isProcessing) {
              processSpeech();
            }
          }, CONFIG.silenceDetectionMs);
        }
        
        if (msg.event === 'stop') {
          console.log('[Phone] 📵 Stream stopped');
        }
        
      } catch (e) {
        console.error('[Phone] Message error:', e.message);
      }
    });
    
    ws.on('close', () => {
      console.log('[Phone] Connection closed');
      clearTimeout(timeout);
      if (silenceTimer) clearTimeout(silenceTimer);
      
      if (callSid) {
        activeCalls.delete(callSid);
        // Keep history for a bit for debugging
        setTimeout(() => {
          callHistory.delete(callSid);
          callContext.delete(callSid);
        }, 5 * 60 * 1000);
      }
    });
    
    ws.on('error', (error) => {
      console.error('[Phone] WebSocket error:', error.message);
    });
  });
  
  console.log('✅ [Phone] WebSocket server ready on /phone-media');
  return wss;
}

// ===================================================================
// API FUNCTIONS
// ===================================================================

/**
 * Make an outbound call
 */
async function makeCall(to, options = {}) {
  if (!twilioClient) throw new Error('Twilio not configured');
  if (!groq) throw new Error('GROQ not configured');
  
  const { publicUrl, context = null } = options;
  
  if (!publicUrl) {
    throw new Error('Public URL required');
  }
  
  // Validate phone
  const phone = to.replace(/[^\d+]/g, '');
  if (!/^\+?[1-9]\d{1,14}$/.test(phone)) {
    throw new Error('Invalid phone number format');
  }
  
  const twimlUrl = `${publicUrl}/twiml/phone-call`;
  const statusUrl = `${publicUrl}/phone/call-status`;
  
  console.log(`[Phone] Making call to ${phone}`);
  console.log(`[Phone] TwiML URL: ${twimlUrl}`);
  
  const call = await twilioClient.calls.create({
    to: phone,
    from: CONFIG.twilioFromNumber,
    url: twimlUrl,
    statusCallback: statusUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    timeout: 60,
    timeLimit: 600
  });
  
  // Store context
  if (context) {
    callContext.set(call.sid, context);
    console.log(`[Phone] Stored context for call ${call.sid}`);
    
    // Auto-cleanup
    setTimeout(() => callContext.delete(call.sid), 20 * 60 * 1000);
  }
  
  return {
    callSid: call.sid,
    to: call.to,
    from: call.from,
    status: call.status
  };
}

/**
 * Generate TwiML for incoming/outgoing call
 */
function generateTwiML(req, publicUrl) {
  let wsUrl;
  let statusUrl;
  
  if (publicUrl) {
    const protocol = publicUrl.startsWith('https') ? 'wss' : 'ws';
    const urlWithoutProtocol = publicUrl.replace(/^https?:\/\//, '');
    wsUrl = `${protocol}://${urlWithoutProtocol}/phone-media`;
    statusUrl = `${publicUrl}/phone/stream-status`;
  } else {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/phone-media`;
    statusUrl = `${protocol}://${host}/phone/stream-status`;
  }
  
  console.log(`[Phone] TwiML WebSocket URL: ${wsUrl}`);
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" statusCallback="${statusUrl}">
      <Parameter name="provider" value="groq-phone" />
    </Stream>
  </Connect>
  <Pause length="3600"/>
</Response>`;
}

/**
 * Get system status
 */
function getStatus() {
  return {
    configured: !!(groq && twilioClient),
    groqReady: !!groq,
    twilioReady: !!twilioClient,
    activeCalls: activeCalls.size,
    fromNumber: CONFIG.twilioFromNumber || 'Not configured',
    models: {
      stt: CONFIG.sttModel,
      llm: CONFIG.llmModel,
      tts: CONFIG.ttsModel,
      voice: CONFIG.ttsVoice
    }
  };
}

// ===================================================================
// EXPORTS
// ===================================================================

export {
  setupPhoneWebSocket,
  makeCall,
  generateTwiML,
  getStatus,
  callContext,
  callHistory,
  activeCalls,
  CONFIG
};
