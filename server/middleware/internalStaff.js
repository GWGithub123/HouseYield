import { verifyIdToken } from '../firebase-admin.js';

function parseStaffEmailAllowlist(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function getInternalStaffEmails() {
  const sources = [
    process.env.HOUSEYIELD_INTERNAL_STAFF_EMAILS,
    process.env.INTERNAL_STAFF_EMAILS,
    process.env.VITE_INTERNAL_STAFF_EMAILS,
  ];

  const merged = new Set();
  sources.forEach((source) => {
    parseStaffEmailAllowlist(source).forEach((email) => merged.add(email));
  });

  return [...merged];
}

function isDevAuthFallbackEnabled() {
  return process.env.INTERNAL_STAFF_ALLOW_AUTH_IN_DEV === 'true'
    || (process.env.NODE_ENV !== 'production' && process.env.INTERNAL_STAFF_DEV_FALLBACK !== 'false');
}

export function isInternalStaffEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  const allowlist = getInternalStaffEmails();
  return allowlist.includes(normalized);
}

export async function requireInternalStaff(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      message: 'Internal staff authentication required',
    });
  }

  const allowlist = getInternalStaffEmails();
  if (!allowlist.length) {
    if (isDevAuthFallbackEnabled()) {
      try {
        const idToken = authHeader.slice('Bearer '.length);
        const decoded = await verifyIdToken(idToken);
        if (decoded?.email) {
          console.warn(`[InternalStaff] Dev fallback allowed ${decoded.email} — set HOUSEYIELD_INTERNAL_STAFF_EMAILS in production`);
          req.user = decoded;
          req.internalStaff = {
            uid: decoded.uid,
            email: decoded.email,
            devFallback: true,
          };
          return next();
        }
      } catch (error) {
        console.error('[InternalStaff] Dev fallback auth failed:', error.message);
      }
    }

    return res.status(503).json({
      ok: false,
      error: 'internal_staff_not_configured',
      message: 'Set HOUSEYIELD_INTERNAL_STAFF_EMAILS on the backend (Cloud Run env vars or local .env). Example: HOUSEYIELD_INTERNAL_STAFF_EMAILS=you@myhouseyield.com',
    });
  }

  try {
    const idToken = authHeader.slice('Bearer '.length);
    const decoded = await verifyIdToken(idToken);
    if (!decoded?.email || !isInternalStaffEmail(decoded.email)) {
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        message: 'This endpoint is restricted to HouseYield internal staff',
      });
    }

    req.user = decoded;
    req.internalStaff = {
      uid: decoded.uid,
      email: decoded.email,
    };
    return next();
  } catch (error) {
    console.error('[InternalStaff] Auth failed:', error.message);
    return res.status(401).json({
      ok: false,
      error: 'invalid_token',
      message: 'Invalid or expired staff session',
    });
  }
}
