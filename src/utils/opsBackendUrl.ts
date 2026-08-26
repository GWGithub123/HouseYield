/**
 * Resolve backend URL for HouseYield Ops (internal console).
 * On localhost:5174 we use relative /api paths so Vite proxies to the local backend.
 * Production ops builds can set VITE_PUSH_SERVER_URL to the deployed API host.
 */
export function getOpsBackendUrl(): string {
  if (typeof window !== 'undefined') {
    const { hostname, port } = window.location;
    const isLocalOpsConsole = (hostname === 'localhost' || hostname === '127.0.0.1') && port === '5174';
    if (isLocalOpsConsole) {
      return '';
    }
  }

  return import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
}
