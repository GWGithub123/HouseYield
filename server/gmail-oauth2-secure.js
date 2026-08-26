// Secure Gmail OAuth2 Implementation with Refresh Tokens
// Replaces the insecure static access token approach

import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';

/**
 * SECURITY WARNING: 
 * The current implementation stores GMAIL_ACCESS_TOKEN as a static value in .env
 * This is insecure because:
 * 1. Access tokens expire (typically after 1 hour)
 * 2. If exposed, anyone can send emails as you
 * 3. No automatic refresh mechanism
 * 
 * This file provides a SECURE alternative using OAuth2 refresh tokens
 */

// OAuth2 Configuration
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const TOKEN_PATH = path.join(process.cwd(), 'server', '.gmail-token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'server', '.gmail-credentials.json');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function encodeMimeHeader(value) {
  const sanitized = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return /[^\x20-\x7E]/.test(sanitized)
    ? `=?UTF-8?B?${Buffer.from(sanitized, 'utf8').toString('base64')}?=`
    : sanitized;
}

function encodeMimeBody(content) {
  return Buffer.from(String(content || ''), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trim();
}

function resolveRedirectUri(credentials) {
  if (process.env.GMAIL_OAUTH_REDIRECT_URI) {
    return process.env.GMAIL_OAUTH_REDIRECT_URI;
  }

  if (credentials.installed) {
    const port = process.env.PORT || 3001;
    return `http://127.0.0.1:${port}/auth/gmail/callback`;
  }

  const redirectUris = credentials.web?.redirect_uris || credentials.installed?.redirect_uris || [];
  if (redirectUris.length > 0) {
    return redirectUris[0];
  }

  throw new Error('No OAuth redirect URI configured');
}

/**
 * Step 1: Setup OAuth2 credentials
 * 
 * 1. Go to Google Cloud Console: https://console.cloud.google.com/
 * 2. Create a new project or select existing
 * 3. Enable Gmail API
 * 4. Create OAuth 2.0 credentials (Desktop app type)
 * 5. Download credentials JSON
 * 6. Save as server/.gmail-credentials.json
 * 7. Add to .gitignore (already done)
 */

class SecureGmailClient {
  constructor() {
    this.oauth2Client = null;
    this.gmail = null;
    this.redirectUri = null;
  }

  /**
   * Initialize OAuth2 client from credentials file
   */
  async initialize() {
    try {
      const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));

      const { client_id, client_secret } = credentials.installed || credentials.web;
      this.redirectUri = resolveRedirectUri(credentials);

      this.oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        this.redirectUri
      );

      this.oauth2Client.on('tokens', async (tokens) => {
        if (tokens.refresh_token) {
          await this.saveToken({
            ...(await this.readStoredToken()),
            ...tokens,
          });
        }
      });

      // Try to load existing token
      try {
        const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
        this.oauth2Client.setCredentials(token);

        this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
        return true;
      } catch (err) {
        this.gmail = null;
        console.log('No saved token found. Need to authorize.');
        return false;
      }
    } catch (error) {
      this.oauth2Client = null;
      this.gmail = null;
      this.redirectUri = null;
      console.error('Failed to initialize Gmail client:', error.message);
      return false;
    }
  }

  async readStoredToken() {
    try {
      return JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
    } catch {
      return {};
    }
  }

  async hasCredentials() {
    return fileExists(CREDENTIALS_PATH);
  }

  async hasToken() {
    return fileExists(TOKEN_PATH);
  }

  needsAuthorization() {
    return this.oauth2Client !== null && this.gmail === null;
  }

  getRedirectUri() {
    return this.redirectUri;
  }

  /**
   * Generate authorization URL for first-time setup
   */
  getAuthUrl() {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized');
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline', // Request refresh token
      scope: SCOPES,
      prompt: 'consent', // Force consent screen to get refresh token
    });
  }

  getSafeAuthUrl() {
    if (!this.oauth2Client) {
      return null;
    }

    return this.getAuthUrl();
  }

  /**
   * Exchange authorization code for tokens
   * Call this after user authorizes and you get the code
   */
  async authorize(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    await this.saveToken(tokens);
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    return tokens;
  }

  /**
   * Save tokens securely (encrypt in production!)
   */
  async saveToken(tokens) {
    // TODO: Encrypt tokens before saving in production
    // Consider using node-keytar or encrypted storage
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    await fs.chmod(TOKEN_PATH, 0o600); // Restrict file permissions
  }

  /**
   * Send email using Gmail API with automatic token refresh
   */
  async sendEmail({ to, subject, html, from }) {
    if (!this.gmail) {
      throw new Error('Gmail client not initialized');
    }

    const senderEmail = from || process.env.GMAIL_SENDER_EMAIL;
    if (!senderEmail) {
      throw new Error('Sender email not configured');
    }

    const encodedSubject = encodeMimeHeader(subject);
    const encodedHtml = encodeMimeBody(html);

    const message = [
      `From: ${senderEmail}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodedHtml,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
        },
      });

      return { ok: true, id: response.data.id, messageId: response.data.id };
    } catch (error) {
      console.error('Gmail send error:', error);
      
      // Check if token expired and refresh
      if (error.code === 401) {
        try {
          await this.oauth2Client.refreshAccessToken();
          // Retry sending
          return this.sendEmail({ to, subject, html, from });
        } catch (refreshError) {
          return { 
            ok: false, 
            error: 'Authentication failed. Please re-authorize.',
            needsReauth: true 
          };
        }
      }

      return { ok: false, error: error.message };
    }
  }

  /**
   * Send email with optional calendar ICS attachment
   */
  async sendEmailWithAttachments({ to, subject, html, from, attachments = [] }) {
    if (!this.gmail) {
      throw new Error('Gmail client not initialized');
    }

    const senderEmail = from || process.env.GMAIL_SENDER_EMAIL;
    if (!senderEmail) {
      throw new Error('Sender email not configured');
    }

    const boundary = `houseyield_${Date.now()}`;
    const encodedSubject = encodeMimeHeader(subject);
    const encodedHtml = encodeMimeBody(html);

    const parts = [
      `From: ${senderEmail}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodedHtml
    ];

    for (const attachment of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        '',
        Buffer.from(attachment.content, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim()
      );
    }

    parts.push(`--${boundary}--`, '');

    const encodedMessage = Buffer.from(parts.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });
      return { ok: true, id: response.data.id, messageId: response.data.id };
    } catch (error) {
      console.error('Gmail send with attachments error:', error);
      if (error.code === 401) {
        try {
          await this.oauth2Client.refreshAccessToken();
          return this.sendEmailWithAttachments({ to, subject, html, from, attachments });
        } catch (refreshError) {
          return { ok: false, error: 'Authentication failed. Please re-authorize.', needsReauth: true };
        }
      }
      return { ok: false, error: error.message };
    }
  }

  /**
   * Create a Google Calendar event and optionally invite attendees
   */
  async createCalendarEvent({ summary, description, location, startAt, endAt, timezone = 'America/New_York', attendees = [] }) {
    if (!this.oauth2Client) {
      return { ok: false, error: 'OAuth client not initialized' };
    }

    try {
      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const response = await calendar.events.insert({
        calendarId: 'primary',
        sendUpdates: attendees.length > 0 ? 'all' : 'none',
        requestBody: {
          summary,
          description,
          location,
          start: { dateTime: startAt, timeZone: timezone },
          end: { dateTime: endAt, timeZone: timezone },
          attendees: attendees.filter(Boolean).map((email) => ({ email }))
        }
      });

      return {
        ok: true,
        id: response.data.id,
        htmlLink: response.data.htmlLink,
        invitesSent: attendees.length > 0
      };
    } catch (error) {
      console.warn('[Gmail/Calendar] Event creation failed:', error.message);
      return { ok: false, error: error.message };
    }
  }

  isReady() {
    return this.gmail !== null;
  }
}

// Singleton instance
let gmailClient = null;

/**
 * Get or create Gmail client instance
 */
export async function getGmailClient() {
  if (!gmailClient) {
    gmailClient = new SecureGmailClient();
  }

  if (!gmailClient.isReady()) {
    await gmailClient.initialize();
  }

  return gmailClient;
}

export async function getGmailAuthStatus() {
  const client = await getGmailClient();
  const hasCredentials = await client.hasCredentials();
  const hasToken = await client.hasToken();

  return {
    hasCredentials,
    hasToken,
    ready: client.isReady(),
    needsAuthorization: client.needsAuthorization(),
    redirectUri: client.getRedirectUri(),
    authUrl: client.getSafeAuthUrl(),
  };
}

/**
 * Send email with automatic initialization and token refresh
 */
export async function sendSecureGmail({ to, subject, html, from }) {
  const client = await getGmailClient();
  const hasCredentials = await client.hasCredentials();
  
  if (!client.isReady()) {
    return { 
      ok: false, 
      error: hasCredentials
        ? 'Gmail authorization required. Visit /auth/gmail to complete setup.'
        : `Gmail OAuth credentials not found at ${CREDENTIALS_PATH}.`,
      authUrl: client.getSafeAuthUrl(),
      needsAuthorization: client.needsAuthorization(),
      redirectUri: client.getRedirectUri(),
    };
  }

  return await client.sendEmail({ to, subject, html, from });
}

export async function sendSecureGmailWithAttachments({ to, subject, html, from, attachments = [] }) {
  const client = await getGmailClient();
  if (!client.isReady()) {
    return {
      ok: false,
      error: 'Gmail authorization required. Visit /auth/gmail to complete setup.',
      needsAuthorization: client.needsAuthorization()
    };
  }

  return client.sendEmailWithAttachments({ to, subject, html, from, attachments });
}

export async function createHouseYieldCalendarEvent(options) {
  const client = await getGmailClient();
  if (!client.isReady()) {
    return { ok: false, error: 'calendar_not_authorized' };
  }
  return client.createCalendarEvent(options);
}

/**
 * One-time authorization endpoint (add to your server)
 * 
 * Example usage:
 * 
 * app.get('/auth/gmail', (req, res) => {
 *   const client = await getGmailClient();
 *   const authUrl = client.getAuthUrl();
 *   res.redirect(authUrl);
 * });
 * 
 * app.get('/auth/gmail/callback', async (req, res) => {
 *   const { code } = req.query;
 *   const client = await getGmailClient();
 *   try {
 *     await client.authorize(code);
 *     res.send('Gmail authorized successfully!');
 *   } catch (error) {
 *     res.status(500).send('Authorization failed: ' + error.message);
 *   }
 * });
 */

// Export the class for advanced usage
export { SecureGmailClient };

/**
 * Migration guide from old implementation:
 * 
 * 1. Install googleapis: npm install googleapis
 * 
 * 2. Replace in server/appointments/gmailSend.js:
 *    - Remove static GMAIL_ACCESS_TOKEN usage
 *    - Import: import { sendSecureGmail } from '../gmail-oauth2-secure.js';
 *    - Replace sendGmailHtml with sendSecureGmail
 * 
 * 3. Set up OAuth2 credentials (see Step 1 above)
 * 
 * 4. Run authorization flow once:
 *    - Visit http://localhost:3001/auth/gmail
 *    - Grant permissions
 *    - Tokens will be saved automatically
 * 
 * 5. Remove GMAIL_ACCESS_TOKEN from .env
 * 
 * 6. Add to .gitignore:
 *    server/.gmail-token.json
 *    server/.gmail-credentials.json
 */
