import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import roomScannerRouter from './room-scanner.js';
import imageStitchingRouter from './image-stitching.js';
import photogrammetryRouter from './routes/photogrammetry.js';
import masterReconstructionRouter from './routes/master-reconstruction.js';
import roomToursRouter from './routes/room-tours.js';
import { validateMobileScanToken } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '8080', 10);
const DIST_DIR = path.join(process.cwd(), 'dist-scanner');
const SCANNER_HTML = path.join(DIST_DIR, 'scanner.html');
const SESSION_COOKIE_NAME = 'scanner_session';
const SESSION_MAX_AGE_SECONDS = 15 * 60;

const ALLOWED_SPA_PREFIXES = [
  '/room-scanner',
  '/photogrammetry-scan',
  '/photogrammetry-view/',
  '/renovation-results',
  '/room-tour-view/',
];

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};

  return cookieHeader.split(';').reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
    return cookies;
  }, {});
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const mobileTokenHeader = req.headers['x-mobile-token'];
  if (typeof mobileTokenHeader === 'string' && mobileTokenHeader) {
    return mobileTokenHeader;
  }

  if (typeof req.query.token === 'string' && req.query.token) {
    return req.query.token;
  }

  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }

  return null;
}

function setScannerSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  res.setHeader('Set-Cookie', attributes.join('; '));
}

function isAllowedSpaPath(pathname) {
  return ALLOWED_SPA_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function htmlResponse(res, statusCode, title, message) {
  res.status(statusCode).type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { max-width: 28rem; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 20px; padding: 32px; text-align: center; }
      h1 { margin: 0 0 12px; font-size: 1.5rem; }
      p { margin: 0; line-height: 1.5; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`);
}

function requireMobileScanToken(req, res, next) {
  const token = extractToken(req);
  const user = validateMobileScanToken(token);

  if (!user) {
    res.status(401).json({ ok: false, error: 'Invalid or expired mobile scan token' });
    return;
  }

  req.mobileScanUser = user;
  req.headers['x-mobile-scan-user-id'] = user.id;
  req.headers['x-mobile-scan-user-email'] = user.email;
  next();
}

function requireScannerPageAccess(req, res, next) {
  const token = extractToken(req);
  const user = validateMobileScanToken(token);

  if (!user) {
    htmlResponse(
      res,
      401,
      'Authentication Required',
      'Scan a fresh QR code from the desktop renovations page to open the hosted room scanner.'
    );
    return;
  }

  setScannerSessionCookie(res, token);
  next();
}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'scanner-host',
    distDir: path.relative(process.cwd(), DIST_DIR),
  });
});

app.post('/api/auth/validate-mobile-token', (req, res) => {
  const { token } = req.body || {};
  const user = validateMobileScanToken(token);

  if (!user) {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    return;
  }

  setScannerSessionCookie(res, token);
  res.json({ ok: true, user });
});

app.use('/api/room-scanner', requireMobileScanToken, roomScannerRouter);
app.use('/api/image-stitching', requireMobileScanToken, imageStitchingRouter);
app.use('/api/photogrammetry', requireMobileScanToken, photogrammetryRouter);
app.use('/api/master-reconstruction', requireMobileScanToken, masterReconstructionRouter);
app.use('/api/room-tours', requireMobileScanToken, roomToursRouter);

app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), {
  immutable: true,
  maxAge: '1h',
}));

app.get('/', (req, res) => {
  res.redirect('/room-scanner');
});

app.get('*', (req, res, next) => {
  if (!isAllowedSpaPath(req.path)) {
    next();
    return;
  }

  requireScannerPageAccess(req, res, () => {
    res.sendFile(SCANNER_HTML);
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`🔒 [Scanner Host] Listening on port ${PORT}`);
  console.log(`   Frontend routes: ${ALLOWED_SPA_PREFIXES.join(', ')}`);
  console.log('   API routes require a valid mobile scan token');
});