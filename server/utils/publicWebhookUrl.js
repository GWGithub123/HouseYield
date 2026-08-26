/**
 * Resolve a public webhook URL for Twilio voice/SMS callbacks.
 * Prefers tunnel env vars over loopback request hosts.
 */

function normalizePublicWebhookBaseUrl(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  try {
    const normalized = new URL(candidate.trim());
    if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') return null;
    normalized.pathname = normalized.pathname.replace(/\/$/, '');
    normalized.search = '';
    normalized.hash = '';
    return normalized.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function isLoopbackPublicWebhookUrl(candidate) {
  const normalized = normalizePublicWebhookBaseUrl(candidate);
  if (!normalized) return false;

  try {
    const { hostname } = new URL(normalized);
    const lower = hostname.toLowerCase();
    if (
      lower === 'localhost'
      || lower === '0.0.0.0'
      || lower === '::1'
      || lower.endsWith('.localhost')
      || lower.endsWith('.local')
      || /^127\./.test(lower)
      || /^10\./.test(lower)
      || /^192\.168\./.test(lower)
    ) {
      return true;
    }

    const private172 = lower.match(/^172\.(\d{1,3})\./);
    if (private172) {
      const secondOctet = Number(private172[1]);
      return secondOctet >= 16 && secondOctet <= 31;
    }

    return false;
  } catch {
    return false;
  }
}

export function resolvePublicWebhookUrl(req = null) {
  const candidates = [
    process.env.CLOUDFLARE_TUNNEL_URL,
    process.env.NGROK_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.HOUSEYIELD_BACKEND_URL,
    process.env.PUBLIC_BACKEND_URL,
    process.env.SHELLY_SERVER_PUBLIC_URL,
    process.env.PUBLIC_URL,
  ];

  if (req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
    if (forwardedHost) {
      const proto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : String(forwardedProto || req.protocol || 'https').split(',')[0].trim();
      const host = Array.isArray(forwardedHost)
        ? forwardedHost[0]
        : String(forwardedHost).split(',')[0].trim();
      candidates.unshift(`${proto}://${host}`);
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizePublicWebhookBaseUrl(candidate);
    if (normalized && !isLoopbackPublicWebhookUrl(normalized)) {
      return normalized;
    }
  }

  return null;
}

export function buildPublicWebhookUrlError(publicUrl) {
  const resolvedUrl = normalizePublicWebhookBaseUrl(publicUrl) || String(publicUrl || 'not set');
  return `Phone calls need a public webhook URL that Twilio can reach. Resolved ${resolvedUrl}. Start the app with a tunnel (for example npm run dev:tunnel) or set CLOUDFLARE_TUNNEL_URL, NGROK_URL, or PUBLIC_URL to a public HTTPS URL.`;
}
