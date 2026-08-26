/**
 * Assistant reusable output lookup.
 * Prefer existing cached/saved analyses and drafts before spending fresh compute.
 */

import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';

initializeFirebaseAdmin();

const db = getFirestore();

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function toMillis(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function ageLabel(generatedAtMs) {
  if (!generatedAtMs) return null;
  const ageMs = Date.now() - generatedAtMs;
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Look up a previously saved assistant artifact for this user/action.
 */
export async function findReusableAssistantOutput({
  userId,
  actionId,
  fingerprint = null,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!userId || !actionId) {
    return { reused: false };
  }

  try {
    let query = db
      .collection('users')
      .doc(userId)
      .collection('assistantArtifacts')
      .where('actionId', '==', actionId)
      .orderBy('generatedAt', 'desc')
      .limit(8);

    const snapshot = await query.get();
    if (snapshot.empty) {
      return { reused: false };
    }

    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      if (fingerprint && data.fingerprint && data.fingerprint !== fingerprint) {
        continue;
      }

      const generatedAtMs = toMillis(data.generatedAt) || toMillis(data.createdAt);
      if (generatedAtMs && Date.now() - generatedAtMs > maxAgeMs) {
        continue;
      }

      return {
        reused: true,
        artifactId: doc.id,
        source: data.source || 'assistantArtifacts',
        generatedAt: generatedAtMs ? new Date(generatedAtMs).toISOString() : null,
        ageLabel: ageLabel(generatedAtMs),
        payload: data.payload || null,
        result: data.result || null,
        actions: data.actions || [],
        artifacts: data.artifacts || [],
        title: data.title || null,
        summary: data.summary || null,
      };
    }

    return { reused: false };
  } catch (error) {
    console.warn('[AssistantReuse] lookup failed:', error.message);
    return { reused: false, error: error.message };
  }
}

/**
 * Persist an assistant artifact for later reuse.
 */
export async function saveAssistantArtifact({
  userId,
  actionId,
  title,
  summary,
  result,
  actions = [],
  artifacts = [],
  payload = null,
  fingerprint = null,
  source = 'assistant_action',
} = {}) {
  if (!userId || !actionId) {
    return null;
  }

  try {
    const ref = db.collection('users').doc(userId).collection('assistantArtifacts').doc();
    const generatedAt = new Date().toISOString();
    await ref.set({
      actionId,
      title: title || actionId,
      summary: summary || '',
      result: result || null,
      actions,
      artifacts,
      payload,
      fingerprint,
      source,
      generatedAt,
      createdAt: generatedAt,
    });
    return { id: ref.id, generatedAt };
  } catch (error) {
    console.warn('[AssistantReuse] save failed:', error.message);
    return null;
  }
}

export function buildReuseMeta(lookup) {
  if (!lookup?.reused) {
    return { reused: false };
  }

  return {
    reused: true,
    source: lookup.source || 'assistantArtifacts',
    ageLabel: lookup.ageLabel || null,
    generatedAt: lookup.generatedAt || null,
  };
}
