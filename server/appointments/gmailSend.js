// Minimal Gmail send wrapper (expects OAuth2 access token present)
// Uses Gmail API: POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
// Environment requirements:
//   GMAIL_ACCESS_TOKEN  (short-lived) OR logic to refresh via existing token flow
//   GMAIL_SENDER_EMAIL  (visible From header)

// In-memory store for user Gmail tokens (synced from frontend)
const userGmailTokens = new Map();

/**
 * Store a user's Gmail access token (called when user connects Gmail in frontend)
 */
export function setUserGmailToken(userId, accessToken, email) {
  userGmailTokens.set(userId, { accessToken, email, updatedAt: Date.now() });
  console.log(`[Gmail] Stored token for user ${userId} (${email})`);
}

/**
 * Get a user's stored Gmail token
 */
export function getUserGmailToken(userId) {
  return userGmailTokens.get(userId);
}

/**
 * Check if any Gmail token is available
 */
export function hasGmailToken() {
  // Check env var first, then check stored tokens
  return !!process.env.GMAIL_ACCESS_TOKEN || userGmailTokens.size > 0;
}

/**
 * Get the first available Gmail token (for automated alerts)
 */
export function getFirstAvailableGmailToken() {
  // Prefer env var
  if (process.env.GMAIL_ACCESS_TOKEN && process.env.GMAIL_SENDER_EMAIL) {
    return { 
      accessToken: process.env.GMAIL_ACCESS_TOKEN, 
      email: process.env.GMAIL_SENDER_EMAIL 
    };
  }
  // Fall back to first stored token
  const first = userGmailTokens.values().next().value;
  return first || null;
}

export async function sendGmailHtml({ to, subject, html, fromOverride, userId }) {
  // Try multiple sources for the access token
  let accessToken = process.env.GMAIL_ACCESS_TOKEN;
  let from = fromOverride || process.env.GMAIL_SENDER_EMAIL;
  
  // If not in env, try user-specific token
  if (!accessToken && userId) {
    const userToken = userGmailTokens.get(userId);
    if (userToken) {
      accessToken = userToken.accessToken;
      from = from || userToken.email;
    }
  }
  
  // If still no token, try first available token (for automated alerts)
  if (!accessToken) {
    const firstToken = getFirstAvailableGmailToken();
    if (firstToken) {
      accessToken = firstToken.accessToken;
      from = from || firstToken.email;
    }
  }
  
  if (!accessToken || !from) {
    return { ok:false, error:'gmail_not_configured' };
  }
  
  // Check if token might be expired (tokens last ~1 hour)
  const tokenInfo = userGmailTokens.values().next().value;
  if (tokenInfo && Date.now() - tokenInfo.updatedAt > 55 * 60 * 1000) {
    console.warn('[Gmail] ⚠️ Token may be expired (older than 55 minutes)');
  }
  
  const mime = buildMime({ to, from, subject, html });
  const encoded = Buffer.from(mime).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:'POST',
    headers:{ 'Authorization': `Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[Gmail] ❌ Send failed (${resp.status}):`, text.slice(0, 300));
    
    // If 401, the token is expired - clear it so we don't keep using stale token
    if (resp.status === 401) {
      console.error('[Gmail] Token expired or invalid. User needs to reconnect Gmail.');
      userGmailTokens.clear();
    }
    
    return { ok:false, error:`gmail_send_failed:${resp.status}`, detail:text.slice(0,500) };
  }
  const json = await resp.json();
  console.log('[Gmail] ✅ Email sent successfully, ID:', json.id);
  return { ok:true, id: json.id };
}

function buildMime({ to, from, subject, html }) {
  const boundary = 'rr-boundary-'+Date.now();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    stripHtml(html).slice(0,1000) || subject,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    html,
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

function stripHtml(s=''){ return s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
