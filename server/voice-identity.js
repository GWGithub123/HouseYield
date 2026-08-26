import { Router } from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { requireAuth } from './firebase-admin.js';

const router = Router();

const VOICE_IDENTITY_DATA_DIR = path.join(process.cwd(), 'server', 'data', 'voice-identity');
const VOICE_IDENTITY_SCRIPT = path.join(process.cwd(), 'server', 'scripts', 'voice_identity_service.py');
const VOICE_IDENTITY_LOCAL_PYTHON = path.join(process.cwd(), 'server', 'scripts', 'voice-identity-venv', 'bin', 'python');
const VOICE_IDENTITY_PYTHON = process.env.HOUSEYIELD_VOICE_ID_PYTHON
  || (fsSync.existsSync(VOICE_IDENTITY_LOCAL_PYTHON) ? VOICE_IDENTITY_LOCAL_PYTHON : 'python3');
const VOICE_IDENTITY_MATCH_THRESHOLD = Number(process.env.HOUSEYIELD_VOICE_ID_MATCH_THRESHOLD || '0.74');
const VOICE_IDENTITY_MIN_DURATION_SECONDS = Number(process.env.HOUSEYIELD_VOICE_ID_MIN_DURATION_SECONDS || '2.2');
const VOICE_IDENTITY_PASSIVE_MIN_DURATION_SECONDS = Number(process.env.HOUSEYIELD_VOICE_ID_PASSIVE_MIN_DURATION_SECONDS || '1.4');
const VOICE_IDENTITY_MAX_SAMPLES = Number(process.env.HOUSEYIELD_VOICE_ID_MAX_SAMPLES || '5');
const VOICE_IDENTITY_RECOMMENDED_SAMPLES = Number(process.env.HOUSEYIELD_VOICE_ID_RECOMMENDED_SAMPLES || '3');
const VOICE_IDENTITY_UNLOCK_WINDOW_MS = Number(process.env.HOUSEYIELD_VOICE_ID_UNLOCK_WINDOW_MS || `${5 * 60 * 1000}`);
const VOICE_IDENTITY_ADAPTIVE_UPDATE_THRESHOLD = Number(process.env.HOUSEYIELD_VOICE_ID_ADAPTIVE_UPDATE_THRESHOLD || '0.82');
const VOICE_IDENTITY_ENGINE = 'speechbrain/spkrec-ecapa-voxceleb';

function getProfilePath(userId) {
  const key = crypto.createHash('sha256').update(String(userId || '')).digest('hex');
  return path.join(VOICE_IDENTITY_DATA_DIR, `${key}.json`);
}

async function ensureVoiceIdentityDir() {
  await fs.mkdir(VOICE_IDENTITY_DATA_DIR, { recursive: true });
}

async function readVoiceProfile(userId) {
  const profilePath = getProfilePath(userId);
  try {
    const raw = await fs.readFile(profilePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeVoiceProfile(userId, profile) {
  await ensureVoiceIdentityDir();
  await fs.writeFile(getProfilePath(userId), JSON.stringify(profile, null, 2));
}

function buildVoiceProfile(userId, currentProfile, samples) {
  return {
    version: 1,
    userId,
    createdAt: currentProfile?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    threshold: currentProfile?.threshold || VOICE_IDENTITY_MATCH_THRESHOLD,
    engine: VOICE_IDENTITY_ENGINE,
    samples,
    centroidEmbedding: averageEmbeddings(samples),
  };
}

function appendVoiceSampleToProfile(userId, currentProfile, sample) {
  const nextSamples = [
    ...(Array.isArray(currentProfile?.samples) ? currentProfile.samples : []),
    sample,
  ].slice(-VOICE_IDENTITY_MAX_SAMPLES);

  return buildVoiceProfile(userId, currentProfile, nextSamples);
}

function normalizeVector(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + (Number(value) || 0) ** 2, 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return values.map(() => 0);
  }

  return values.map((value) => Number(((Number(value) || 0) / magnitude).toFixed(8)));
}

function averageEmbeddings(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return [];
  }

  const width = Array.isArray(samples[0]?.embedding) ? samples[0].embedding.length : 0;
  if (!width) {
    return [];
  }

  const totals = new Array(width).fill(0);
  samples.forEach((sample) => {
    const embedding = Array.isArray(sample.embedding) ? sample.embedding : [];
    for (let index = 0; index < width; index += 1) {
      totals[index] += Number(embedding[index]) || 0;
    }
  });

  return normalizeVector(totals.map((value) => value / samples.length));
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return 0;
  }

  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return Number((dot / denominator).toFixed(4));
}

function sanitizeAudioBase64(audioBase64) {
  if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
    return null;
  }

  return audioBase64.trim();
}

function formatDependencyError(error) {
  const message = error?.message || 'voice_identity_unavailable';
  if (
    message.includes('speechbrain')
    || message.includes('torchaudio')
    || message.includes('torch')
    || message.includes('No module named')
  ) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'voice_identity_dependencies_missing',
        message: 'Voice identity dependencies are missing. Install: pip3 install -r server/scripts/voice-identity-requirements.txt',
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: 'voice_identity_failed',
      message,
    },
  };
}

function runVoiceEmbedding(audioBase64) {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn(VOICE_IDENTITY_PYTHON, [VOICE_IDENTITY_SCRIPT], {
      env: {
        ...process.env,
        HOUSEYIELD_VOICE_ID_MODEL: VOICE_IDENTITY_ENGINE,
      },
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    pythonProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    pythonProcess.on('error', (error) => {
      reject(error);
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `voice_identity_process_failed:${code}`));
        return;
      }

      try {
        const payload = JSON.parse(stdout.trim());
        if (!payload?.ok || !Array.isArray(payload.embedding)) {
          reject(new Error(payload?.message || 'voice_identity_invalid_response'));
          return;
        }
        resolve(payload);
      } catch (error) {
        reject(new Error(stderr.trim() || error.message || 'voice_identity_invalid_json'));
      }
    });

    pythonProcess.stdin.write(JSON.stringify({
      action: 'embed',
      audioBase64,
    }));
    pythonProcess.stdin.end();
  });
}

router.get('/status', requireAuth, async (req, res) => {
  try {
    const profile = await readVoiceProfile(req.user.uid);
    res.json({
      ok: true,
      hasEnrollment: Boolean(profile),
      sampleCount: profile?.samples?.length || 0,
      recommendedSamples: VOICE_IDENTITY_RECOMMENDED_SAMPLES,
      threshold: profile?.threshold || VOICE_IDENTITY_MATCH_THRESHOLD,
      engine: VOICE_IDENTITY_ENGINE,
    });
  } catch (error) {
    console.error('[Voice Identity] Status error:', error);
    res.status(500).json({ ok: false, error: 'voice_identity_status_failed', message: error.message });
  }
});

router.post('/enroll', requireAuth, async (req, res) => {
  const audioBase64 = sanitizeAudioBase64(req.body?.audioBase64);
  if (!audioBase64) {
    return res.status(400).json({ ok: false, error: 'audio_required', message: 'audioBase64 is required.' });
  }

  try {
    const embeddingResult = await runVoiceEmbedding(audioBase64);
    if ((embeddingResult.durationSeconds || 0) < VOICE_IDENTITY_MIN_DURATION_SECONDS) {
      return res.status(400).json({
        ok: false,
        error: 'voice_sample_too_short',
        message: `Record at least ${VOICE_IDENTITY_MIN_DURATION_SECONDS.toFixed(1)} seconds of speech.`,
      });
    }

    const normalizedEmbedding = normalizeVector(embeddingResult.embedding);
    const currentProfile = await readVoiceProfile(req.user.uid);
    const nextProfile = appendVoiceSampleToProfile(req.user.uid, currentProfile, {
      recordedAt: new Date().toISOString(),
      durationSeconds: Number(embeddingResult.durationSeconds) || 0,
      embedding: normalizedEmbedding,
      source: 'enrollment',
    });

    await writeVoiceProfile(req.user.uid, nextProfile);

    res.json({
      ok: true,
      hasEnrollment: true,
      sampleCount: nextProfile.samples.length,
      recommendedSamples: VOICE_IDENTITY_RECOMMENDED_SAMPLES,
      threshold: nextProfile.threshold,
      engine: VOICE_IDENTITY_ENGINE,
      durationSeconds: Number(embeddingResult.durationSeconds) || 0,
    });
  } catch (error) {
    console.error('[Voice Identity] Enrollment error:', error);
    const formatted = formatDependencyError(error);
    res.status(formatted.status).json(formatted.body);
  }
});

router.post('/verify', requireAuth, async (req, res) => {
  const audioBase64 = sanitizeAudioBase64(req.body?.audioBase64);
  const verificationMode = req.body?.verificationMode === 'passive' ? 'passive' : 'manual';
  if (!audioBase64) {
    return res.status(400).json({ ok: false, error: 'audio_required', message: 'audioBase64 is required.' });
  }

  try {
    let profile = await readVoiceProfile(req.user.uid);
    if (!profile?.centroidEmbedding || !Array.isArray(profile.samples) || profile.samples.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'voice_identity_not_enrolled',
        message: 'Enroll a voice sample before verifying.',
      });
    }

    const embeddingResult = await runVoiceEmbedding(audioBase64);
    const minDurationSeconds = verificationMode === 'passive'
      ? VOICE_IDENTITY_PASSIVE_MIN_DURATION_SECONDS
      : VOICE_IDENTITY_MIN_DURATION_SECONDS;

    if ((embeddingResult.durationSeconds || 0) < minDurationSeconds) {
      return res.status(400).json({
        ok: false,
        error: 'voice_sample_too_short',
        message: `Record at least ${minDurationSeconds.toFixed(1)} seconds of speech.`,
      });
    }

    const normalizedEmbedding = normalizeVector(embeddingResult.embedding);
    const centroidScore = cosineSimilarity(normalizedEmbedding, profile.centroidEmbedding);
    const sampleScores = profile.samples.map((sample) => cosineSimilarity(normalizedEmbedding, sample.embedding));
    const bestSampleScore = sampleScores.length > 0 ? Math.max(...sampleScores) : centroidScore;
    const score = Number(((centroidScore * 0.65) + (bestSampleScore * 0.35)).toFixed(4));
    const threshold = Number(profile.threshold || VOICE_IDENTITY_MATCH_THRESHOLD);
    const matched = score >= threshold;
    const adaptiveProfileUpdated = matched && score >= VOICE_IDENTITY_ADAPTIVE_UPDATE_THRESHOLD;

    if (adaptiveProfileUpdated) {
      profile = appendVoiceSampleToProfile(req.user.uid, profile, {
        recordedAt: new Date().toISOString(),
        durationSeconds: Number(embeddingResult.durationSeconds) || 0,
        embedding: normalizedEmbedding,
        source: verificationMode === 'passive' ? 'passive-verification' : 'manual-verification',
        score,
      });
      await writeVoiceProfile(req.user.uid, profile);
    }

    res.json({
      ok: true,
      matched,
      score,
      centroidScore,
      bestSampleScore,
      threshold,
      sampleCount: profile.samples.length,
      recommendedSamples: VOICE_IDENTITY_RECOMMENDED_SAMPLES,
      unlockExpiresAt: matched ? new Date(Date.now() + VOICE_IDENTITY_UNLOCK_WINDOW_MS).toISOString() : null,
      adaptiveProfileUpdated,
      verificationMode,
      engine: VOICE_IDENTITY_ENGINE,
      durationSeconds: Number(embeddingResult.durationSeconds) || 0,
    });
  } catch (error) {
    console.error('[Voice Identity] Verification error:', error);
    const formatted = formatDependencyError(error);
    res.status(formatted.status).json(formatted.body);
  }
});

router.delete('/enrollment', requireAuth, async (req, res) => {
  try {
    await fs.unlink(getProfilePath(req.user.uid)).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });

    res.json({ ok: true, hasEnrollment: false, sampleCount: 0 });
  } catch (error) {
    console.error('[Voice Identity] Reset error:', error);
    res.status(500).json({ ok: false, error: 'voice_identity_reset_failed', message: error.message });
  }
});

export default router;