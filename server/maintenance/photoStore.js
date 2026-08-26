/**
 * Maintenance photo storage.
 *
 * Uploads to Firebase Storage when a bucket is configured. When it is not (common
 * in local dev), photos fall back to inline data URLs so the intake and service
 * record flows still work end to end — the server body limit is already 150mb.
 */

import crypto from 'crypto';
import { getStorage } from '../firebase-admin.js';

const MAX_PHOTOS_PER_REQUEST = 10;
const MAX_BYTES_PER_PHOTO = 8 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

/** Photo groups a ticket can carry. `issue` is intake; the rest are service records. */
export const PHOTO_KINDS = ['issue', 'before', 'after', 'parts', 'receipt'];

function normalizeKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  return PHOTO_KINDS.includes(value) ? value : 'issue';
}

function sanitizeFileName(name) {
  const base = String(name || 'photo')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-80);
  return base || 'photo';
}

/** Accepts either a full data URL or a bare base64 string plus contentType. */
function decodePhotoPayload(photo) {
  const raw = String(photo?.data || photo?.dataUrl || photo?.base64 || '');
  if (!raw) {
    return { error: 'Photo payload is empty' };
  }

  let contentType = String(photo?.contentType || photo?.type || '').trim().toLowerCase();
  let base64 = raw;

  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.*)$/s);
  if (dataUrlMatch) {
    contentType = contentType || dataUrlMatch[1].toLowerCase();
    base64 = dataUrlMatch[2];
  }

  if (!contentType) {
    contentType = 'image/jpeg';
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return { error: `Unsupported image type: ${contentType}` };
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { error: 'Photo payload is not valid base64' };
  }

  if (!buffer.length) {
    return { error: 'Photo payload decoded to zero bytes' };
  }
  if (buffer.length > MAX_BYTES_PER_PHOTO) {
    return { error: `Photo exceeds the ${Math.round(MAX_BYTES_PER_PHOTO / 1024 / 1024)}MB limit` };
  }

  return { buffer, contentType, base64 };
}

function resolveBucket() {
  try {
    const bucket = getStorage().bucket();
    return bucket?.name ? bucket : null;
  } catch (error) {
    console.warn('[MaintenancePhotos] Storage unavailable, falling back to inline photos:', error.message);
    return null;
  }
}

function buildInlinePhoto({ contentType, base64, buffer, name, kind }) {
  return {
    url: `data:${contentType};base64,${base64}`,
    name,
    contentType,
    size: buffer.length,
    kind,
    storagePath: '',
    inline: true,
    uploadedAt: new Date().toISOString(),
  };
}

/**
 * Persist a batch of photos for a maintenance request.
 * @param {Object} options
 * @param {string} options.requestId
 * @param {string} options.ownerId
 * @param {string} options.kind - one of PHOTO_KINDS
 * @param {Array} options.photos - [{ name, contentType, data }]
 * @returns {Promise<{ok: boolean, photos?: Array, errors?: Array, storage?: string, error?: string}>}
 */
export async function uploadMaintenancePhotos({
  requestId = '',
  ownerId = '',
  kind = 'issue',
  photos = [],
} = {}) {
  if (!Array.isArray(photos) || !photos.length) {
    return { ok: false, error: 'No photos supplied' };
  }
  if (photos.length > MAX_PHOTOS_PER_REQUEST) {
    return { ok: false, error: `At most ${MAX_PHOTOS_PER_REQUEST} photos per upload` };
  }

  const normalizedKind = normalizeKind(kind);
  const bucket = resolveBucket();
  const scope = requestId || `draft_${new Date().toISOString().slice(0, 10)}`;
  const uploaded = [];
  const errors = [];

  for (const [index, photo] of photos.entries()) {
    const decoded = decodePhotoPayload(photo);
    if (decoded.error) {
      errors.push({ index, error: decoded.error });
      continue;
    }

    const { buffer, contentType, base64 } = decoded;
    const name = sanitizeFileName(photo?.name || `photo-${index + 1}`);

    if (!bucket) {
      uploaded.push(buildInlinePhoto({ contentType, base64, buffer, name, kind: normalizedKind }));
      continue;
    }

    const storagePath = [
      'maintenance',
      ownerId || 'unassigned',
      scope,
      normalizedKind,
      `${crypto.randomUUID()}-${name}`,
    ].join('/');

    try {
      const file = bucket.file(storagePath);
      await file.save(buffer, {
        contentType,
        resumable: false,
        metadata: {
          cacheControl: 'private, max-age=31536000',
          metadata: { requestId: scope, ownerId, kind: normalizedKind },
        },
      });

      // Signed URLs work with uniform bucket-level access, unlike makePublic().
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2100-01-01' });

      uploaded.push({
        url,
        name,
        contentType,
        size: buffer.length,
        kind: normalizedKind,
        storagePath,
        inline: false,
        uploadedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[MaintenancePhotos] Upload failed, storing inline instead:', error.message);
      uploaded.push(buildInlinePhoto({ contentType, base64, buffer, name, kind: normalizedKind }));
    }
  }

  if (!uploaded.length) {
    return { ok: false, error: errors[0]?.error || 'All photo uploads failed', errors };
  }

  return {
    ok: true,
    photos: uploaded,
    errors,
    storage: uploaded.every((photo) => photo.inline) ? 'inline' : 'firebase-storage',
  };
}

export const maintenancePhotoLimits = {
  maxPhotos: MAX_PHOTOS_PER_REQUEST,
  maxBytes: MAX_BYTES_PER_PHOTO,
  allowedContentTypes: [...ALLOWED_CONTENT_TYPES],
};
