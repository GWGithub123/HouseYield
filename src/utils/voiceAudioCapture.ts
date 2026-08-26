const DEFAULT_CAPTURE_DURATION_MS = 3500;
const DEFAULT_TARGET_SAMPLE_RATE = 16000;

export type MonoWavCaptureResult = {
  audioBase64: string;
  durationMs: number;
};

export type PersistentMonoWavCaptureSession = {
  beginSegment: () => void;
  endSegment: () => MonoWavCaptureResult | null;
  isSegmentActive: () => boolean;
  dispose: () => Promise<void>;
};

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });

  return result;
}

function downsampleBuffer(source: Float32Array, sourceSampleRate: number, targetSampleRate: number) {
  if (targetSampleRate >= sourceSampleRate) {
    return source;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const nextLength = Math.round(source.length / ratio);
  const result = new Float32Array(nextLength);
  let resultOffset = 0;
  let sourceOffset = 0;

  while (resultOffset < result.length) {
    const nextSourceOffset = Math.round((resultOffset + 1) * ratio);
    let sum = 0;
    let count = 0;

    for (let index = sourceOffset; index < nextSourceOffset && index < source.length; index += 1) {
      sum += source[index];
      count += 1;
    }

    result[resultOffset] = count > 0 ? sum / count : 0;
    resultOffset += 1;
    sourceOffset = nextSourceOffset;
  }

  return result;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function buildCaptureResult(
  chunks: Float32Array[],
  sourceSampleRate: number,
  targetSampleRate: number,
): MonoWavCaptureResult | null {
  if (chunks.length === 0) {
    return null;
  }

  const merged = mergeChunks(chunks);
  if (merged.length === 0) {
    return null;
  }

  const downsampled = downsampleBuffer(merged, sourceSampleRate, targetSampleRate);

  return {
    audioBase64: arrayBufferToBase64(encodeWav(downsampled, targetSampleRate)),
    durationMs: Math.round((merged.length / sourceSampleRate) * 1000),
  };
}

async function createAudioCaptureGraph(stream: MediaStream) {
  const audioContext = new AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  muteGain.gain.value = 0;

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  return {
    audioContext,
    source,
    processor,
    muteGain,
  };
}

export async function createPersistentMonoWavCapture(
  stream: MediaStream,
  options?: { targetSampleRate?: number },
): Promise<PersistentMonoWavCaptureSession> {
  const targetSampleRate = options?.targetSampleRate || DEFAULT_TARGET_SAMPLE_RATE;
  const { audioContext, source, processor, muteGain } = await createAudioCaptureGraph(stream);

  let segmentActive = false;
  let segmentChunks: Float32Array[] = [];

  processor.onaudioprocess = (event) => {
    if (!segmentActive) {
      return;
    }

    segmentChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };

  return {
    beginSegment() {
      segmentChunks = [];
      segmentActive = true;
    },
    endSegment() {
      const completedChunks = segmentChunks;
      segmentChunks = [];
      segmentActive = false;
      return buildCaptureResult(completedChunks, audioContext.sampleRate, targetSampleRate);
    },
    isSegmentActive() {
      return segmentActive;
    },
    async dispose() {
      processor.disconnect();
      source.disconnect();
      muteGain.disconnect();
      processor.onaudioprocess = null;
      await audioContext.close();
    },
  };
}

export async function captureMonoWavBase64(options?: {
  durationMs?: number;
  targetSampleRate?: number;
}) {
  const durationMs = options?.durationMs || DEFAULT_CAPTURE_DURATION_MS;
  const targetSampleRate = options?.targetSampleRate || DEFAULT_TARGET_SAMPLE_RATE;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const captureSession = await createPersistentMonoWavCapture(stream, { targetSampleRate });
  captureSession.beginSegment();

  try {
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
  } finally {
    const result = captureSession.endSegment();
    await captureSession.dispose();
    stream.getTracks().forEach((track) => track.stop());

    if (!result?.audioBase64) {
      throw new Error('No audio captured.');
    }

    return result.audioBase64;
  }
}