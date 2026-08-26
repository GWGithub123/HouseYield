/**
 * Base URL for API calls from the browser.
 *
 * On Vite ports (5173 full app, 5174 ops, 5175 maintenance) return '' so
 * requests stay same-origin and hit the Vite /api proxy — avoids CORS to :3001.
 */

const VITE_DEV_PORTS = new Set(['5173', '5174', '5175']);

export function getDevApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:3001';
  }

  const { hostname, port, protocol } = window.location;
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLoopback && VITE_DEV_PORTS.has(port || '80')) {
    return '';
  }

  // Tunnel / production: same origin (or reverse-proxied API).
  if (!isLoopback) {
    return '';
  }

  // Loopback but not a known Vite port — fall back to local backend.
  return `${protocol}//${hostname}:3001`;
}
