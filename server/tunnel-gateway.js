#!/usr/bin/env node
/**
 * Secure Tunnel Gateway
 * 
 * This sits between the Cloudflare tunnel and the local dev servers.
 * It ONLY proxies allowlisted paths and enforces mobile scan token auth
 * on API routes, preventing exposure of source code, .env, or unrelated endpoints.
 * 
 * Tunnel → this gateway (port 5173) → Vite (5175) for frontend assets
 *                                    → Express (3001) for /api/room-scanner/*
 */

import http from 'http';
import httpProxy from 'http-proxy';
import { validateMobileScanToken } from './auth.js';

const GATEWAY_PORT = parseInt(process.env.TUNNEL_GATEWAY_PORT || '5173', 10);
const VITE_PORT = parseInt(process.env.VITE_INTERNAL_PORT || '5175', 10);
const BACKEND_PORT = 3001;

// ── Allowed path prefixes ────────────────────────────────────────────
// Only these paths are accessible through the tunnel. Everything else → 403.
const ALLOWED_FRONTEND_PATHS = [
  '/room-scanner',         // The scanner page route
  '/src/',                 // Vite HMR serves component source (required for dev mode)
  '/node_modules/',        // Vite serves deps via pre-bundling
  '/@vite/',               // Vite client runtime
  '/@react-refresh',       // React fast refresh
  '/@id/',                 // Vite module resolution
  '/assets/',              // Built assets
  '/favicon',              // Favicon
];

// Block these paths unconditionally (even if they match a prefix above)
const BLOCKED_PATHS = [
  '/@fs/',                 // Vite arbitrary filesystem access
  '/.env',                 // Environment file
  '/.git',                 // Git directory
  '/server/',              // Server source code
  '/firestore',            // Firestore config
  '/firebase',             // Firebase config
];

const ALLOWED_API_PATHS = [
  '/api/room-scanner/',    // Room scanner endpoints
  '/api/auth/validate-mobile-token',  // Token validation (needed before auth)
  '/api/image-stitching/', // Panorama stitching (used by room scanner)
];

// ── Proxy setup ──────────────────────────────────────────────────────
const viteProxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${VITE_PORT}`,
  ws: true,
});

const backendProxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${BACKEND_PORT}`,
});

// Suppress proxy errors from crashing the gateway
viteProxy.on('error', (err, req, res) => {
  console.error('[Gateway] Vite proxy error:', err.message);
  if (res.writeHead) res.writeHead(502).end('Bad Gateway');
});

backendProxy.on('error', (err, req, res) => {
  console.error('[Gateway] Backend proxy error:', err.message);
  if (res.writeHead) res.writeHead(502).end('Bad Gateway');
});

// ── Path checking ────────────────────────────────────────────────────
function isBlocked(pathname) {
  return BLOCKED_PATHS.some(p => pathname.startsWith(p));
}

function isAllowedFrontend(pathname) {
  // Root path must be exactly /room-scanner or /room-scanner?...
  if (pathname === '/' || pathname === '/index.html') return false;
  return ALLOWED_FRONTEND_PATHS.some(p => pathname.startsWith(p));
}

function isAllowedApi(pathname) {
  return ALLOWED_API_PATHS.some(p => pathname.startsWith(p));
}

function isTokenValidationEndpoint(pathname) {
  return pathname === '/api/auth/validate-mobile-token';
}

// ── Token extraction ─────────────────────────────────────────────────
function extractToken(req) {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Check X-Mobile-Token header
  const mobileToken = req.headers['x-mobile-token'];
  if (mobileToken) return mobileToken;
  // Check query string ?token=...
  try {
    const url = new URL(req.url, `http://localhost`);
    const qToken = url.searchParams.get('token');
    if (qToken) return qToken;
  } catch { /* ignore parse errors */ }
  return null;
}

// ── Local vs tunnel detection ────────────────────────────────────────
function isLocalRequest(req) {
  const host = (req.headers.host || '').toLowerCase();
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
}

// ── Request handler ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${GATEWAY_PORT}`);
  const pathname = url.pathname;

  // LOCAL REQUESTS: bypass all tunnel restrictions — full dev access
  if (isLocalRequest(req)) {
    if (pathname.startsWith('/api/')) {
      backendProxy.web(req, res);
    } else {
      viteProxy.web(req, res);
    }
    return;
  }

  // ── TUNNEL REQUESTS BELOW — apply security restrictions ────────

  // Always block dangerous paths
  if (isBlocked(pathname)) {
    console.warn(`[Gateway] BLOCKED: ${req.method} ${pathname} from ${req.socket.remoteAddress}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
    return;
  }

  // API routes — require token (except token validation itself)
  if (pathname.startsWith('/api/')) {
    if (!isAllowedApi(pathname)) {
      console.warn(`[Gateway] API BLOCKED: ${req.method} ${pathname}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Endpoint not available through tunnel' }));
      return;
    }

    // Token validation endpoint must be open (it's how the client authenticates)
    if (!isTokenValidationEndpoint(pathname)) {
      const token = extractToken(req);
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Mobile scan token required' }));
        return;
      }
      const userData = validateMobileScanToken(token);
      if (!userData) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid or expired token' }));
        return;
      }
      // Attach user info as headers for the backend
      req.headers['x-tunnel-user-id'] = userData.id;
      req.headers['x-tunnel-user-email'] = userData.email;
    }

    backendProxy.web(req, res);
    return;
  }

  // Frontend routes — only allowlisted paths
  if (isAllowedFrontend(pathname)) {
    viteProxy.web(req, res);
    return;
  }

  // Special case: /room-scanner is an SPA route — serve the Vite index
  // Vite handles this via its built-in SPA fallback
  if (pathname === '/room-scanner' || pathname.startsWith('/room-scanner?')) {
    viteProxy.web(req, res);
    return;
  }

  // Everything else is blocked
  console.warn(`[Gateway] BLOCKED: ${req.method} ${pathname}`);
  res.writeHead(403, { 'Content-Type': 'text/html' });
  res.end('<h1>403 Forbidden</h1><p>This path is not available through the tunnel.</p>');
});

// Handle WebSocket upgrades (for Vite HMR)
server.on('upgrade', (req, socket, head) => {
  // Local requests: always allow WebSocket upgrades
  if (isLocalRequest(req)) {
    viteProxy.ws(req, socket, head);
    return;
  }
  // Tunnel requests: only allow Vite HMR websocket
  const url = new URL(req.url, `http://localhost:${GATEWAY_PORT}`);
  if (url.pathname === '/' || url.pathname.startsWith('/@vite/')) {
    viteProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(GATEWAY_PORT, () => {
  console.log(`\n🔒 [Gateway] Secure tunnel gateway listening on port ${GATEWAY_PORT}`);
  console.log(`   Only the room scanner flow is exposed through the tunnel`);
  console.log(`   Frontend: /room-scanner`);
  console.log(`   APIs: /api/room-scanner/*, /api/image-stitching/*, /api/auth/validate-mobile-token`);
  console.log(`   API routes require a valid mobile scan token\n`);
});

export default server;
export { GATEWAY_PORT };
