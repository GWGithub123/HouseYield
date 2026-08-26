import crypto from 'crypto';

const isProduction = process.env.NODE_ENV === 'production';
const SECRET = process.env.APPOINTMENT_TOKEN_SECRET || (isProduction ? '' : crypto.randomBytes(32).toString('hex'));

if (!SECRET) {
  throw new Error('CRITICAL: APPOINTMENT_TOKEN_SECRET must be set in production');
}

if (!process.env.APPOINTMENT_TOKEN_SECRET) {
  console.warn('⚠️  WARNING: APPOINTMENT_TOKEN_SECRET not set. Using an ephemeral in-memory secret for this process only.');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

export function signToken(payload) {
  const json = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(json).digest();
  return b64url(Buffer.from(json)) + '.' + b64url(sig);
}

export function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const json = Buffer.from(parts[0].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const expected = crypto.createHmac('sha256', SECRET).update(json).digest();
    const given = Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64');
    if (!crypto.timingSafeEqual(expected, given)) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newActionToken({ requestId, action, slotId = null, ttlMs = 1000*60*60*24*7 }) {
  return signToken({ requestId, action, slotId, exp: Date.now() + ttlMs });
}
