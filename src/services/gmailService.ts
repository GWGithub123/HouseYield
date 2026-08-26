// Gmail API Service with Google Identity Services (GIS)
const API_KEY = (import.meta as any).env?.VITE_GMAIL_API_KEY || '';
const CLIENT_ID = (import.meta as any).env?.VITE_GMAIL_CLIENT_ID || '';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest';
// Updated scopes for Gmail API
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

// Debug logging
console.log('Gmail Service Configuration:');
console.log('API Key present:', !!API_KEY);
console.log('Client ID present:', !!CLIENT_ID);
console.log('API Key (partial):', API_KEY ? `${API_KEY.substring(0, 10)}...` : 'Missing');
console.log('Client ID (partial):', CLIENT_ID ? `${CLIENT_ID.substring(0, 20)}...` : 'Missing');
console.log('Client ID format valid:', CLIENT_ID.includes('.apps.googleusercontent.com'));

// Extend Window interface for Google APIs
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ body?: { data?: string } }>;
  };
  internalDate: string;
}

export interface MessageThread {
  id: string;
  snippet: string;
  historyId: string;
  messages: GmailMessage[];
}

class GmailService {
  private gapi: any = null;
  private tokenClient: any = null;
  private isInitialized = false;
  private accessToken: string | null = null;

  async initialize(): Promise<boolean> {
    try {
      console.log('🔧 Gmail Service: Starting Google Identity Services initialization...');
      
      // Check if required credentials are available
      if (!API_KEY || !CLIENT_ID) {
        console.warn('❌ Gmail API credentials not configured. Please check your .env.local file.');
        return false;
      }

      // Validate credential format
      if (!CLIENT_ID.includes('.apps.googleusercontent.com')) {
        console.warn('❌ Gmail Client ID appears to be invalid format.');
        return false;
      }

      // Load Google APIs
      await this.loadGoogleAPIs();
      
      console.log('📚 Gmail Service: Loading client library...');
      
      // Initialize both gapi client and Google Identity Services
      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          console.error('❌ Gmail API initialization timeout (15s)');
          resolve(false);
        }, 15000); // 15 second timeout

        // Load gapi client
        this.gapi.load('client', async () => {
          try {
            // Initialize gapi client
            await this.gapi.client.init({
              apiKey: API_KEY,
              discoveryDocs: [DISCOVERY_DOC],
            });

            // Initialize Google Identity Services token client
            this.tokenClient = window.google.accounts.oauth2.initTokenClient({
              client_id: CLIENT_ID,
              scope: SCOPES,
              callback: (response: any) => {
                if (response.error) {
                  console.error('❌ OAuth error:', response);
                } else {
                  console.log('✅ OAuth token received');
                  this.accessToken = response.access_token;
                }
              },
            });

            this.isInitialized = true;
            clearTimeout(timeoutId);
            
            console.log('✅ Gmail Service: Google Identity Services initialization successful');
            resolve(true);
          } catch (error) {
            clearTimeout(timeoutId);
            console.error('❌ Gmail Service: Failed to initialize client:', error);
            resolve(false);
          }
        });
      });
    } catch (error) {
      console.error('❌ Gmail Service: Failed to load Gmail API:', error);
      return false;
    }
  }

  private loadGoogleAPIs(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Load both gapi and Google Identity Services
      const promises: Promise<void>[] = [];

      // Load gapi
      if (!window.gapi) {
        promises.push(this.loadScript('https://apis.google.com/js/api.js').then(() => {
          this.gapi = window.gapi;
        }));
      } else {
        this.gapi = window.gapi;
      }

      // Load Google Identity Services
      if (!window.google?.accounts) {
        promises.push(this.loadScript('https://accounts.google.com/gsi/client'));
      }

      Promise.all(promises)
        .then(() => resolve())
        .catch(reject);
    });
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[src="${src}"]`);
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve());
        existingScript.addEventListener('error', reject);
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      
      document.head.appendChild(script);
      
      // Timeout after 15 seconds
      setTimeout(() => {
        reject(new Error(`Script loading timeout: ${src}`));
      }, 15000);
    });
  }

  async signIn(): Promise<boolean> {
    console.log('🔐 Gmail Service: Starting OAuth sign-in flow...');
    
    if (!this.isInitialized) {
      console.log('📡 Gmail Service: Not initialized, initializing first...');
      const initialized = await this.initialize();
      if (!initialized) {
        console.error('❌ Gmail Service: Initialization failed, cannot sign in');
        return false;
      }
    }

    try {
      if (!this.tokenClient) {
        console.error('❌ Gmail Service: Token client not available');
        return false;
      }

      // Check if we already have a valid token
      if (this.accessToken) {
        console.log('✅ Gmail Service: Already have valid token');
        return true;
      }

      console.log('🔓 Gmail Service: Requesting user authorization...');
      
      // Request access token
      return new Promise((resolve) => {
        // Set up callback for this specific request
        const originalCallback = this.tokenClient.callback;
        this.tokenClient.callback = async (response: any) => {
          // Restore original callback
          this.tokenClient.callback = originalCallback;
          
          if (response.error) {
            console.error('❌ Gmail Service: OAuth error:', response);
            resolve(false);
          } else {
            console.log('✅ Gmail Service: OAuth sign-in successful');
            this.accessToken = response.access_token;
            
            // Set the access token for gapi client
            this.gapi.client.setToken({
              access_token: response.access_token
            });
            
            // Fetch user's email
            const userEmail = await this.fetchUserEmail();
            
            // Sync token to server for automated alerts (sensor notifications, etc.)
            try {
              const userId = localStorage.getItem('houseyield_user_id') || 'default';
              await fetch('http://localhost:3001/api/gmail/sync-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  accessToken: response.access_token,
                  email: userEmail,
                  userId
                })
              });
              console.log('✅ Gmail Service: Token synced to server for automated alerts');
            } catch (syncError) {
              console.warn('⚠️ Gmail Service: Failed to sync token to server:', syncError);
              // Don't fail sign-in if sync fails
            }
            
            resolve(true);
          }
        };
        
        // Request the token
        this.tokenClient.requestAccessToken();
      });
    } catch (error) {
      console.error('❌ Gmail Service: Sign-in failed:', error);
      return false;
    }
  }

  async signOut(): Promise<void> {
    if (this.accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(this.accessToken);
    }
    this.accessToken = null;
    this.cachedUserEmail = '';
    if (this.gapi?.client) {
      this.gapi.client.setToken(null);
    }
  }

  isUserSignedIn(): boolean {
    return !!this.accessToken;
  }

  async sendMessage(to: string, subject: string, body: string, from?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isUserSignedIn()) {
      return { success: false, error: 'User not authenticated' };
    }

    try {
      // Create RFC 2822 compliant message
      const message = this.createMimeMessage(to, subject, body, from);
      
      // Send the message
      const response = await this.gapi.client.gmail.users.messages.send({
        userId: 'me',
        resource: {
          raw: message
        }
      });

      return {
        success: true,
        messageId: response.result.id
      };
    } catch (error) {
      console.error('Failed to send message:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private createMimeMessage(to: string, subject: string, body: string, from?: string): string {
    const userEmail = this.getCurrentUserEmail();
    const fromAddress = from || userEmail;
    
    // Create RFC 2822 compliant message
    const messageParts = [
      `From: ${fromAddress}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      body
    ];

    const message = messageParts.join('\r\n');
    
    // Encode in base64url format as required by Gmail API
    return btoa(unescape(encodeURIComponent(message)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private cachedUserEmail: string = '';

  private getCurrentUserEmail(): string {
    return this.cachedUserEmail;
  }

  async fetchUserEmail(): Promise<string> {
    if (this.cachedUserEmail) {
      return this.cachedUserEmail;
    }
    
    if (!this.isUserSignedIn()) {
      return '';
    }
    
    try {
      const response = await this.gapi.client.gmail.users.getProfile({
        userId: 'me'
      });
      this.cachedUserEmail = response.result.emailAddress || '';
      console.log('📧 Gmail Service: User email:', this.cachedUserEmail);
      return this.cachedUserEmail;
    } catch (error) {
      console.error('Failed to fetch user email:', error);
      return '';
    }
  }

  async getMessages(query?: string): Promise<GmailMessage[]> {
    if (!this.isUserSignedIn()) {
      throw new Error('User not authenticated');
    }

    try {
      const response = await this.gapi.client.gmail.users.messages.list({
        userId: 'me',
        q: query || '',
        maxResults: 10
      });

      const messages = response.result.messages || [];
      const fullMessages: GmailMessage[] = [];

      // Get full message details with full format to get message body
      for (const message of messages) {
        const fullMessage = await this.gapi.client.gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full' // Request full message format including body
        });
        fullMessages.push(fullMessage.result);
      }

      return fullMessages;
    } catch (error) {
      console.error('Failed to get messages:', error);
      throw error;
    }
  }

  async sendReply(originalMessage: GmailMessage, replyBody: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isUserSignedIn()) {
      return { success: false, error: 'User not authenticated' };
    }

    try {
      // Extract original details
      const headers = originalMessage.payload.headers;
      const originalFrom = headers.find(h => h.name === 'From')?.value || '';
      const originalSubject = headers.find(h => h.name === 'Subject')?.value || '';
      const originalMessageId = headers.find(h => h.name === 'Message-ID')?.value || '';

      // Create reply subject
      const replySubject = originalSubject.startsWith('Re: ') ? originalSubject : `Re: ${originalSubject}`;

      // Create reply message with threading headers
      const userEmail = this.getCurrentUserEmail();
      const messageParts = [
        `From: ${userEmail}`,
        `To: ${originalFrom}`,
        `Subject: ${replySubject}`,
        `In-Reply-To: ${originalMessageId}`,
        `References: ${originalMessageId}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        replyBody
      ];

      const message = messageParts.join('\r\n');
      const encodedMessage = btoa(unescape(encodeURIComponent(message)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      // Send the reply
      const response = await this.gapi.client.gmail.users.messages.send({
        userId: 'me',
        resource: {
          raw: encodedMessage,
          threadId: originalMessage.threadId
        }
      });

      return {
        success: true,
        messageId: response.result.id
      };
    } catch (error) {
      console.error('Failed to send reply:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Helper method to get message headers
  getMessageHeader(message: GmailMessage, headerName: string): string {
    const header = message.payload.headers.find(h => 
      h.name.toLowerCase() === headerName.toLowerCase()
    );
    return header?.value || '';
  }

  // Helper method to decode message body
  decodeMessageBody(message: GmailMessage): string {
    try {
      // Try to get body from main payload
      if (message.payload.body?.data) {
        return this.decodeBase64Url(message.payload.body.data);
      }

      // Try to get body from parts (multipart messages)
      if (message.payload.parts) {
        for (const part of message.payload.parts) {
          if (part.body?.data) {
            return this.decodeBase64Url(part.body.data);
          }
        }
      }

      // Fallback to snippet
      return message.snippet || 'No content available';
    } catch (error) {
      console.error('Failed to decode message body:', error);
      return message.snippet || 'Error decoding message';
    }
  }

  // Helper method to decode base64url encoded strings
  private decodeBase64Url(data: string): string {
    try {
      // Convert base64url to base64
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      // Pad with = if needed
      const padded = base64 + '==='.slice(0, (4 - base64.length % 4) % 4);
      // Decode and convert to UTF-8
      return decodeURIComponent(escape(atob(padded)));
    } catch (error) {
      console.error('Failed to decode base64url:', error);
      return 'Error decoding content';
    }
  }
}

// Export singleton instance
const gmailService = new GmailService();
export default gmailService;
