/**
 * Voice Pipeline Latency Benchmark
 * Tests each component of the GROQ voice pipeline
 */

import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function benchmarkSTT() {
  console.log('\n=== STT Benchmark ===');
  
  // Create a test WAV file (1 second of silence)
  const sampleRate = 8000;
  const duration = 1; // 1 second
  const numSamples = sampleRate * duration;
  const wavHeader = Buffer.alloc(44);
  const pcmData = Buffer.alloc(numSamples * 2);
  
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmData.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * 2, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmData.length, 40);
  
  const wavBuffer = Buffer.concat([wavHeader, pcmData]);
  const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
  
  // Test distil-whisper (fastest)
  const models = [
    'distil-whisper-large-v3-en',
    'whisper-large-v3-turbo',
  ];
  
  for (const model of models) {
    try {
      const start = Date.now();
      await groq.audio.transcriptions.create({
        file: audioFile,
        model: model,
        language: 'en',
      });
      console.log(`${model}: ${Date.now() - start}ms`);
    } catch (e) {
      console.log(`${model}: ERROR - ${e.message}`);
    }
  }
}

async function benchmarkLLM() {
  console.log('\n=== LLM Benchmark ===');
  
  const models = [
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile',
  ];
  
  const prompt = 'Respond in one short sentence: How can I help you today?';
  
  for (const model of models) {
    try {
      const start = Date.now();
      const response = await groq.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.7,
      });
      const latency = Date.now() - start;
      console.log(`${model}: ${latency}ms - "${response.choices[0]?.message?.content?.slice(0, 50)}..."`);
    } catch (e) {
      console.log(`${model}: ERROR - ${e.message}`);
    }
  }
}

async function benchmarkTTS() {
  console.log('\n=== TTS Benchmark ===');
  
  const texts = [
    'Hello!',
    'How can I help you today?',
    'I understand you have a plumbing issue. Let me help schedule that for you.',
  ];
  
  // Test Orpheus
  console.log('\n-- Orpheus TTS --');
  for (const text of texts) {
    try {
      const start = Date.now();
      const response = await groq.audio.speech.create({
        model: 'playai-tts',
        voice: 'Celeste-PlayAI',
        input: text,
        response_format: 'wav',
      });
      const buffer = await response.arrayBuffer();
      const latency = Date.now() - start;
      console.log(`"${text.slice(0, 30).padEnd(32)}" : ${latency}ms (${buffer.byteLength} bytes)`);
    } catch (e) {
      console.log(`TTS ERROR: ${e.message}`);
    }
  }
}

async function benchmarkFullPipeline() {
  console.log('\n=== FULL PIPELINE SIMULATION ===');
  console.log('Simulating: User speech → STT → LLM → TTS');
  
  const pipelineStart = Date.now();
  
  // 1. STT
  const sttStart = Date.now();
  const wavHeader = Buffer.alloc(44);
  const pcmData = Buffer.alloc(8000); // 0.5s audio
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmData.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(8000, 24);
  wavHeader.writeUInt32LE(16000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmData.length, 40);
  
  const wavBuffer = Buffer.concat([wavHeader, pcmData]);
  const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
  
  const transcription = await groq.audio.transcriptions.create({
    file: audioFile,
    model: 'distil-whisper-large-v3-en',
    language: 'en',
  });
  const sttLatency = Date.now() - sttStart;
  console.log(`1. STT: ${sttLatency}ms`);
  
  // 2. LLM
  const llmStart = Date.now();
  const llmResponse = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant', // Fastest model
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Keep responses very short.' },
      { role: 'user', content: 'Hello, I need help with plumbing.' }
    ],
    max_tokens: 50,
    temperature: 0.7,
  });
  const llmLatency = Date.now() - llmStart;
  const llmText = llmResponse.choices[0]?.message?.content || 'Hello!';
  console.log(`2. LLM: ${llmLatency}ms - "${llmText.slice(0, 50)}..."`);
  
  // 3. TTS (first sentence only for streaming)
  const ttsStart = Date.now();
  const firstSentence = llmText.split(/[.!?]/)[0] + '.';
  const ttsResponse = await groq.audio.speech.create({
    model: 'playai-tts',
    voice: 'Celeste-PlayAI',
    input: firstSentence.slice(0, 200),
    response_format: 'wav',
  });
  await ttsResponse.arrayBuffer();
  const ttsLatency = Date.now() - ttsStart;
  console.log(`3. TTS: ${ttsLatency}ms`);
  
  const totalLatency = Date.now() - pipelineStart;
  console.log(`\n📊 TOTAL PIPELINE: ${totalLatency}ms`);
  console.log(`   (+ 300ms silence detection = ${totalLatency + 300}ms perceived)`);
}

async function main() {
  console.log('🎤 GROQ Voice Pipeline Benchmark');
  console.log('================================\n');
  
  await benchmarkSTT();
  await benchmarkLLM();
  await benchmarkTTS();
  await benchmarkFullPipeline();
  
  console.log('\n✅ Benchmark complete!');
}

main().catch(console.error);
