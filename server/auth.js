/**
 * Authentication & Security Middleware
 */

import crypto from 'crypto';

const MOBILE_SCAN_TOKEN_VERSION = 'v1';
const MOBILE_SCAN_TOKEN_TTL_MS = 15 * 60 * 1000;
const MOBILE_SCAN_TOKEN_TTL_SECONDS = Math.floor(MOBILE_SCAN_TOKEN_TTL_MS / 1000);

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function getMobileScanTokenSecret() {
  if (process.env.MOBILE_SCAN_TOKEN_SECRET) {
    return process.env.MOBILE_SCAN_TOKEN_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('MOBILE_SCAN_TOKEN_SECRET must be configured in production');
  }

  return 'houseyield-mobile-scan-dev-secret';
}

function signMobileScanPayload(payloadSegment) {
  return crypto
    .createHmac('sha256', getMobileScanTokenSecret())
    .update(payloadSegment)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeTimingEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Generate a temporary mobile scan token for QR code authentication
 * Token is tied to a specific user and expires in 15 minutes.
 */
export function generateMobileScanToken(userId, userEmail, userName, userRole) {
  const now = Date.now();
  const payload = {
    sub: userId,
    email: userEmail,
    name: userName,
    role: userRole,
    iat: now,
    exp: now + MOBILE_SCAN_TOKEN_TTL_MS,
    jti: crypto.randomBytes(12).toString('hex')
  };

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signatureSegment = signMobileScanPayload(payloadSegment);
  const token = `${MOBILE_SCAN_TOKEN_VERSION}.${payloadSegment}.${signatureSegment}`;

  console.log(`[AUTH] Generated mobile scan token for user ${userId}, expires in 15 minutes`);
  return token;
}

/**
 * Validate a mobile scan token and return user data if valid
 * Tokens are stateless so they can be validated by a hosted scanner service
 * as long as it shares the signing secret.
 */
export function validateMobileScanToken(token) {
  if (!token || typeof token !== 'string') {
    console.warn('[AUTH] Invalid mobile scan token attempted');
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    console.warn('[AUTH] Malformed mobile scan token attempted');
    return null;
  }

  const [version, payloadSegment, signatureSegment] = parts;
  if (version !== MOBILE_SCAN_TOKEN_VERSION) {
    console.warn('[AUTH] Unsupported mobile scan token version attempted');
    return null;
  }

  const expectedSignature = signMobileScanPayload(payloadSegment);
  if (!safeTimingEqual(signatureSegment, expectedSignature)) {
    console.warn('[AUTH] Invalid mobile scan token signature attempted');
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment));
  } catch (error) {
    console.warn('[AUTH] Failed to decode mobile scan token payload');
    return null;
  }

  if (!payload?.sub || !payload?.email || !payload?.name || !payload?.role || !payload?.exp) {
    console.warn('[AUTH] Incomplete mobile scan token payload attempted');
    return null;
  }

  if (Date.now() > payload.exp) {
    console.warn('[AUTH] Expired mobile scan token attempted');
    return null;
  }

  console.log(`[AUTH] Mobile scan token validated for user ${payload.sub}`);
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role
  };
}

/**
 * Simple API Key Authentication Middleware
 * Checks for X-API-Key header against environment variable
 */
export function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.VOICE_API_KEY;

  // If no API key configured, allow in development but warn
  if (!validApiKey) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[AUTH] CRITICAL: VOICE_API_KEY not set in production!');
      return res.status(500).json({ 
        ok: false, 
        error: 'Server configuration error' 
      });
    }
    console.warn('[AUTH] Warning: VOICE_API_KEY not configured, allowing request in dev mode');
    return next();
  }

  // Verify API key
  if (!apiKey || apiKey !== validApiKey) {
    console.warn('[AUTH] Unauthorized voice call attempt:', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString()
    });
    return res.status(401).json({ 
      ok: false, 
      error: 'Unauthorized - Invalid or missing API key' 
    });
  }

  // API key valid, proceed
  console.log('[AUTH] Authorized voice call from:', req.ip);
  next();
}

/**
 * Twilio Webhook Signature Verification
 * Validates that requests actually came from Twilio
 * 
 * @param {string} authToken - Your Twilio auth token
 */
export function createTwilioWebhookAuth(authToken) {
  return (req, res, next) => {
    const signature = req.headers['x-twilio-signature'];
    
    if (!signature) {
      console.warn('[TWILIO-AUTH] Missing X-Twilio-Signature header');
      return res.status(403).json({ 
        ok: false, 
        error: 'Forbidden - Missing signature' 
      });
    }

    // Prefer configured public URL so Cloud Run signature validation matches Twilio console webhook URL.
    const configuredBase = process.env.BACKEND_PUBLIC_URL || process.env.PUBLIC_URL || '';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const url = configuredBase
      ? `${configuredBase.replace(/\/$/, '')}${req.originalUrl}`
      : `${protocol}://${host}${req.originalUrl}`;

    // Get POST parameters
    const params = req.body || {};

    // Validate signature
    if (!validateTwilioSignature(authToken, signature, url, params)) {
      // Retry with request host URL in case Twilio uses a Cloud Run alias URL.
      const fallbackUrl = `${protocol}://${host}${req.originalUrl}`;
      if (fallbackUrl !== url && validateTwilioSignature(authToken, signature, fallbackUrl, params)) {
        console.log('[TWILIO-AUTH] Valid Twilio webhook signature verified (fallback URL)');
        return next();
      }

      console.error('[TWILIO-AUTH] Invalid signature detected!', {
        url,
        fallbackUrl,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
      return res.status(403).json({ 
        ok: false, 
        error: 'Forbidden - Invalid signature' 
      });
    }

    console.log('[TWILIO-AUTH] Valid Twilio webhook signature verified');
    next();
  };
}

/**
 * Validate Twilio request signature
 * Based on Twilio's signature validation algorithm
 * 
 * @param {string} authToken - Your Twilio auth token
 * @param {string} signature - The X-Twilio-Signature header
 * @param {string} url - The full URL of the request
 * @param {object} params - POST parameters
 * @returns {boolean} Whether signature is valid
 */
function validateTwilioSignature(authToken, signature, url, params) {
  // Sort parameters alphabetically and concatenate
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  // Compute HMAC SHA1
  const expectedSignature = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Security logging middleware for voice calls
 * Logs all voice call attempts for monitoring
 */
export function voiceCallLogger(req, res, next) {
  const logData = {
    timestamp: new Date().toISOString(),
    ip: req.ip,
    method: req.method,
    path: req.path,
    userAgent: req.headers['user-agent'],
    to: req.body?.to || 'unknown',
    issue: req.body?.issue?.substring(0, 50) || 'none'
  };

  console.log('[VOICE-SECURITY] Call attempt:', JSON.stringify(logData));
  
  // You could also write to a file or database here
  // appendFileSync('logs/voice-calls.log', JSON.stringify(logData) + '\n');
  
  next();
}

/**
 * Call monitoring - detect suspicious patterns
 */
export function callMonitor(req, res, next) {
  const to = req.body?.to;
  
  // Example: Block known spam numbers (you'd maintain a blacklist)
  const spamNumbers = process.env.BLOCKED_NUMBERS?.split(',') || [];
  if (spamNumbers.includes(to)) {
    console.warn('[MONITOR] Blocked call to spam number:', to);
    return res.status(403).json({ 
      ok: false, 
      error: 'This number is blocked' 
    });
  }

  // Example: Alert on high-cost international numbers
  if (to && !to.startsWith('+1')) {
    console.warn('[MONITOR] ALERT: Attempted international call to:', to);
    // Could send email/SMS alert here
  }

  next();
}

export default {
  apiKeyAuth,
  createTwilioWebhookAuth,
  voiceCallLogger,
  callMonitor
};

export { MOBILE_SCAN_TOKEN_TTL_MS, MOBILE_SCAN_TOKEN_TTL_SECONDS };
