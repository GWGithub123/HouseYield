/**
 * Tenant Email Monitor - Automated Maintenance Issue Detection
 * 
 * This module monitors Gmail inbox for tenant emails and automatically:
 * 1. Fetches new emails from specified tenant addresses
 * 2. Analyzes email content with AI to detect maintenance issues
 * 3. Extracts key information (issue type, urgency, location)
 * 4. Triggers automated provider search when maintenance issues detected
 * 
 * Usage:
 *   import { checkTenantEmails, analyzeTenantEmail } from './tenant-email-monitor.js';
 *   
 *   // Check for new emails and process them
 *   const results = await checkTenantEmails();
 *   
 *   // Manually analyze a specific email
 *   const analysis = await analyzeTenantEmail(emailContent);
 */

import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Storage for last processed email ID
const STATE_FILE = path.join(__dirname, 'data', 'email-monitor-state.json');
const PROCESSED_EMAILS_FILE = path.join(__dirname, 'data', 'processed-emails.json');

// Initialize Gmail client
let gmail = null;
let oauth2Client = null;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';

/**
 * Initialize Gmail API client
 * Uses the same OAuth2 flow as gmail-oauth2-secure.js
 */
async function initGmailClient() {
  if (gmail) return gmail;

  try {
    const TOKEN_PATH = path.join(__dirname, '.gmail-token.json');
    const CREDENTIALS_PATH = path.join(__dirname, '.gmail-credentials.json');

    // Load credentials
    const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

    oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Load tokens
    const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);

    // Auto-refresh tokens
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.refresh_token) {
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      }
    });

    gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    console.log('✅ [Email Monitor] Gmail client initialized');
    return gmail;
  } catch (error) {
    console.error('❌ [Email Monitor] Failed to initialize Gmail:', error.message);
    return null;
  }
}

/**
 * Load monitor state (last processed email ID)
 */
async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return state;
  } catch (error) {
    return { lastProcessedId: null, lastCheckTime: null };
  }
}

/**
 * Save monitor state
 */
async function saveState(state) {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[Email Monitor] Failed to save state:', error.message);
  }
}

/**
 * Load processed emails log
 */
async function loadProcessedEmails() {
  try {
    const data = JSON.parse(await fs.readFile(PROCESSED_EMAILS_FILE, 'utf8'));
    return data.emails || [];
  } catch (error) {
    return [];
  }
}

/**
 * Save processed email to log
 */
async function logProcessedEmail(emailData) {
  try {
    const processed = await loadProcessedEmails();
    processed.unshift(emailData);
    
    // Keep only last 100 emails
    const trimmed = processed.slice(0, 100);
    
    await fs.mkdir(path.dirname(PROCESSED_EMAILS_FILE), { recursive: true });
    await fs.writeFile(
      PROCESSED_EMAILS_FILE,
      JSON.stringify({ emails: trimmed, lastUpdated: new Date().toISOString() }, null, 2)
    );
  } catch (error) {
    console.error('[Email Monitor] Failed to log processed email:', error.message);
  }
}

/**
 * Analyze email content with AI to detect maintenance issues
 * 
 * @param {string} emailContent - The email body content
 * @param {string} subject - Email subject line
 * @param {string} from - Sender email address
 * @returns {Promise<object>} Analysis result with issue detection
 */
export async function analyzeTenantEmail(emailContent, subject = '', from = '') {
  if (!OPENAI_API_KEY) {
    return { 
      ok: false, 
      error: 'OpenAI API key not configured',
      isMaintenanceIssue: false 
    };
  }

  try {
    const systemPrompt = `You are a property management assistant analyzing tenant emails for maintenance issues.

Your task:
1. Determine if this email describes a MAINTENANCE or REPAIR issue
2. Extract the SPECIFIC, DETAILED description of what is broken or needs repair
3. Classify the urgency level
4. Identify the SPECIFIC service category needed
5. Extract tenant availability/preferred scheduling times if mentioned
6. Extract tenant contact information if provided

CRITICAL: The "issue" field must contain the EXACT maintenance problem described in the email.
- GOOD: "kitchen sink faucet is broken and leaking", "toilet won't flush", "AC not cooling", "broken window in bedroom"
- BAD: "maintenance request", "repair needed", "something is broken"

Maintenance issues include: plumbing problems, electrical issues, HVAC/heating/cooling, appliances, structural damage, pest control, locks/security, roof leaks, water damage, etc.

NON-maintenance emails: rent payments, lease questions, general inquiries, move-in/out coordination, noise complaints (unless requesting repair), parking issues, etc.

For tenant availability, look for phrases like:
- "I'm available weekdays after 5pm"
- "Can only do weekends"
- "I work from home Tuesdays and Thursdays"
- "Any time this week is fine"
- "Prefer morning appointments"
Extract the exact phrasing and convert to a clear, formatted string.

For the "searchQuery", create a highly specific query that MUST include BOTH the maintenance issue AND the property location:
- GOOD: "emergency plumber kitchen sink repair Potomac MD", "24hr AC repair not cooling Rockville Maryland", "residential electrician outlet not working near Bethesda MD"
- BAD: "general contractor", "maintenance service", "repair company", "plumber near me"
- CRITICAL: Always include the city/location in the search query to find LOCAL service providers

Return JSON with this structure:
{
  "isMaintenanceIssue": true/false,
  "confidence": 0-100 (how certain you are this is maintenance),
  "issue": "SPECIFIC and DETAILED description of the exact problem from the email",
  "serviceCategory": "plumbing|electrical|hvac|appliance|roofing|pest|locksmith|general|other",
  "urgency": "emergency|high|medium|low",
  "location": "property location city/state (e.g., Potomac MD, Rockville Maryland, Bethesda MD)",
  "keywords": ["specific", "problem", "terms"],
  "searchQuery": "MUST combine issue + location (e.g., 'emergency plumber kitchen sink repair Potomac MD')",
  "tenantAvailability": "formatted availability string or null if not mentioned",
  "tenantPhone": "phone number if provided, else null",
  "propertyAddress": "full property address if mentioned, else null",
  "unitNumber": "unit/apartment number if mentioned, else null",
  "reasoning": "brief explanation of why this is/isn't maintenance"
}`;

    const userPrompt = `Subject: ${subject}
From: ${from}

Email Content:
${emailContent}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Email Monitor] OpenAI API error:', errorText);
      return { ok: false, error: 'AI analysis failed', isMaintenanceIssue: false };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      return { ok: false, error: 'No response from AI', isMaintenanceIssue: false };
    }

    const analysis = JSON.parse(content);
    
    return {
      ok: true,
      ...analysis,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[Email Monitor] Analysis error:', error);
    return { 
      ok: false, 
      error: error.message,
      isMaintenanceIssue: false 
    };
  }
}

/**
 * Fetch messages from Gmail
 * 
 * @param {object} options - Query options
 * @param {string} options.query - Gmail search query (e.g., 'from:tenant@email.com')
 * @param {number} options.maxResults - Maximum number of emails to fetch
 * @param {string} options.afterMessageId - Only fetch emails after this ID
 * @returns {Promise<array>} Array of email messages
 */
async function fetchGmailMessages({ query = '', maxResults = 10, afterMessageId = null }) {
  const client = await initGmailClient();
  if (!client) {
    return { ok: false, error: 'Gmail not initialized', messages: [] };
  }

  try {
    // Build search query
    let searchQuery = query;
    if (!searchQuery) {
      // Default: fetch recent emails (last 7 days)
      searchQuery = 'newer_than:7d';
    }

    // List messages
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: searchQuery,
      maxResults: maxResults
    });

    const messages = listResponse.data.messages || [];
    
    if (messages.length === 0) {
      return { ok: true, messages: [], count: 0 };
    }

    // Fetch full message details
    const fullMessages = await Promise.all(
      messages.map(async (msg) => {
        try {
          const msgData = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'full'
          });
          return msgData.data;
        } catch (error) {
          console.error(`[Email Monitor] Failed to fetch message ${msg.id}:`, error.message);
          return null;
        }
      })
    );

    return {
      ok: true,
      messages: fullMessages.filter(m => m !== null),
      count: fullMessages.filter(m => m !== null).length
    };

  } catch (error) {
    console.error('[Email Monitor] Failed to fetch messages:', error);
    return { ok: false, error: error.message, messages: [] };
  }
}

/**
 * Extract email body from Gmail message
 */
function extractEmailBody(message) {
  let body = '';

  function getBodyFromPart(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.mimeType === 'text/html' && part.body?.data && !body) {
      // Use HTML as fallback, strip tags
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (part.parts) {
      for (const subPart of part.parts) {
        const text = getBodyFromPart(subPart);
        if (text) return text;
      }
    }
    return '';
  }

  if (message.payload) {
    if (message.payload.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload.parts) {
      for (const part of message.payload.parts) {
        body = getBodyFromPart(part);
        if (body) break;
      }
    }
  }

  return body;
}

/**
 * Extract header value from Gmail message
 */
function getHeader(message, headerName) {
  const headers = message.payload?.headers || [];
  const header = headers.find(h => h.name.toLowerCase() === headerName.toLowerCase());
  return header?.value || '';
}

/**
 * Check if a maintenance issue has been resolved based on follow-up emails
 * 
 * @param {string} threadId - Gmail thread ID to check for resolution
 * @param {string} issueCategory - Service category of the issue
 * @returns {Promise<object>} Resolution status
 */
async function checkIssueResolution(threadId, issueCategory) {
  try {
    // Get all messages in the thread
    const threadResult = await fetchGmailMessages({ 
      query: `rfc822msgid:${threadId}`,
      maxResults: 50 
    });

    if (!threadResult.ok || threadResult.messages.length <= 1) {
      return { resolved: false, confidence: 0, reason: 'No follow-up emails found' };
    }

    // Check recent messages (last 7 days) for resolution indicators
    const recentMessages = threadResult.messages.slice(0, 10);
    let resolutionIndicators = 0;
    let totalMessages = 0;

    for (const msg of recentMessages) {
      const body = extractEmailBody(msg);
      const subject = getHeader(msg, 'Subject');
      const content = `${subject} ${body}`.toLowerCase();

      totalMessages++;

      // Look for resolution keywords
      const resolved = /(fixed|repaired|resolved|completed|done|finished|working now|all set|taken care of|problem solved)/i.test(content);
      const thankYou = /(thank you|thanks|appreciate)/i.test(content);
      const confirmation = /(confirm|verified|checked|inspected)/i.test(content);

      if (resolved || (thankYou && confirmation)) {
        resolutionIndicators++;
      }
    }

    const confidence = totalMessages > 0 ? (resolutionIndicators / totalMessages) : 0;
    const resolved = confidence > 0.3; // 30% threshold

    return {
      resolved,
      confidence: Math.round(confidence * 100),
      reason: resolved 
        ? `Found ${resolutionIndicators} resolution indicators in ${totalMessages} recent messages`
        : 'No clear resolution indicators found'
    };

  } catch (error) {
    console.error('[Email Monitor] Resolution check error:', error);
    return { resolved: false, confidence: 0, reason: 'Check failed', error: error.message };
  }
}

/**
 * Check for new tenant emails and analyze them
 * 
 * @param {object} options - Configuration options
 * @param {string} options.tenantEmails - Comma-separated list of tenant email addresses
 * @param {string} options.searchQuery - Custom Gmail search query (overrides tenantEmails)
 * @param {number} options.maxEmails - Maximum number of emails to check
 * @param {boolean} options.autoTriggerSearch - Automatically trigger provider search for detected issues
 * @param {boolean} options.checkUnresolved - Check for unresolved issues from previous emails
 * @returns {Promise<object>} Results with analyzed emails
 */
export async function checkTenantEmails(options = {}) {
  const {
    tenantEmails = process.env.TENANT_EMAILS || '',
    searchQuery = null,
    maxEmails = 20,
    autoTriggerSearch = false,
    checkUnresolved = true
  } = options;

  console.log('[Email Monitor] Checking for new tenant emails...');

  const state = await loadState();
  
  // Build search query
  let query = searchQuery;
  if (!query && tenantEmails) {
    const emails = tenantEmails.split(',').map(e => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      query = emails.map(e => `from:${e}`).join(' OR ');
    }
  }
  if (!query) {
    query = 'newer_than:7d'; // Default: last 7 days
  }

  // Fetch messages
  const result = await fetchGmailMessages({ query, maxResults: maxEmails });

  if (!result.ok) {
    return { 
      ok: false, 
      error: result.error,
      checked: 0,
      maintenanceIssues: [],
      unresolvedIssues: []
    };
  }

  const messages = result.messages;
  console.log(`[Email Monitor] Found ${messages.length} email(s) to analyze`);

  const analyzed = [];
  const maintenanceIssues = [];
  const unresolvedIssues = [];

  for (const message of messages) {
    // Skip if already processed
    if (state.lastProcessedId && message.id === state.lastProcessedId) {
      console.log(`[Email Monitor] Reached last processed email (${message.id}), stopping`);
      break;
    }

    const subject = getHeader(message, 'Subject');
    const from = getHeader(message, 'From');
    const date = getHeader(message, 'Date');
    const body = extractEmailBody(message);

    console.log(`[Email Monitor] Analyzing: "${subject}" from ${from}`);

    const normalizedFrom = String(from || '').toLowerCase();
    const normalizedSubject = String(subject || '').toLowerCase();
    const isHouseYieldSystemEmail = normalizedFrom.includes('myhouseyield.com')
      || normalizedFrom.includes('admin@myhouseyield.com');
    const isAutomatedFloodNotification = normalizedSubject.includes('water/flood detected')
      || normalizedSubject.includes('flood detected')
      || normalizedSubject.includes('flood/leak detected');

    if (isHouseYieldSystemEmail && isAutomatedFloodNotification) {
      console.log('[Email Monitor] Skipping automated HouseYield flood notification email');
      analyzed.push({
        id: message.id,
        threadId: message.threadId,
        subject,
        from,
        date,
        skipped: true,
        reason: 'automated_flood_notification',
        processed: new Date().toISOString(),
      });
      continue;
    }

    // Analyze email
    const analysis = await analyzeTenantEmail(body, subject, from);

    const emailRecord = {
      id: message.id,
      threadId: message.threadId,
      subject,
      from,
      date,
      snippet: message.snippet,
      analysis,
      processed: new Date().toISOString()
    };

    analyzed.push(emailRecord);

    // If maintenance issue detected
    if (analysis.isMaintenanceIssue && analysis.confidence >= 60) {
      // Check if this is an unresolved issue
      let isUnresolved = false;
      let resolutionStatus = null;

      if (checkUnresolved) {
        console.log(`[Email Monitor] Checking resolution status for thread ${message.threadId}...`);
        resolutionStatus = await checkIssueResolution(message.threadId, analysis.serviceCategory);
        isUnresolved = !resolutionStatus.resolved;
        emailRecord.resolutionStatus = resolutionStatus;

        if (isUnresolved) {
          console.log(`⚠️  [Email Monitor] UNRESOLVED maintenance issue detected!`);
          unresolvedIssues.push(emailRecord);
        }
      }

      maintenanceIssues.push(emailRecord);
      
      // Log the detected issue
      await logProcessedEmail(emailRecord);
      
      console.log(`🔧 [Email Monitor] Maintenance issue detected!`);
      console.log(`   Issue: ${analysis.issue}`);
      console.log(`   Category: ${analysis.serviceCategory}`);
      console.log(`   Urgency: ${analysis.urgency}`);
      console.log(`   Confidence: ${analysis.confidence}%`);
      console.log(`   Status: ${isUnresolved ? 'UNRESOLVED' : 'Possibly resolved'}`);

      // Auto-trigger provider search if enabled and unresolved
      if (autoTriggerSearch && analysis.searchQuery && isUnresolved) {
        console.log(`🔍 [Email Monitor] Auto-triggering provider search for unresolved issue...`);
        // This will be implemented in the integration step
        emailRecord.autoSearchTriggered = true;
        emailRecord.searchQuery = analysis.searchQuery;
      }
    }
  }

  // Update state with the latest message ID
  if (messages.length > 0) {
    state.lastProcessedId = messages[0].id;
    state.lastCheckTime = new Date().toISOString();
    state.emailsChecked = (state.emailsChecked || 0) + messages.length;
    state.issuesDetected = (state.issuesDetected || 0) + maintenanceIssues.length;
    state.unresolvedIssues = (state.unresolvedIssues || 0) + unresolvedIssues.length;
    await saveState(state);
  }

  return {
    ok: true,
    checked: analyzed.length,
    maintenanceIssues: maintenanceIssues.length,
    unresolvedIssues: unresolvedIssues.length,
    results: analyzed,
    state
  };
}

/**
 * Get processed emails history
 */
export async function getProcessedEmailsHistory(limit = 20) {
  const emails = await loadProcessedEmails();
  return {
    ok: true,
    emails: emails.slice(0, limit),
    total: emails.length
  };
}

/**
 * Get current monitor state
 */
export async function getMonitorState() {
  const state = await loadState();
  return {
    ok: true,
    ...state
  };
}

/**
 * Format maintenance context for voice call AI
 * 
 * @param {object} emailAnalysis - The analysis result from analyzeTenantEmail
 * @param {string} tenantEmail - The tenant's email address
 * @param {string} tenantName - The tenant's name (optional)
 * @returns {object} Formatted context for voice call
 */
export function formatMaintenanceContextForCall(emailAnalysis, tenantEmail, tenantName = null) {
  if (!emailAnalysis || !emailAnalysis.isMaintenanceIssue) {
    return null;
  }

  const context = {
    issue: emailAnalysis.issue || 'General maintenance issue',
    urgency: emailAnalysis.urgency || 'medium',
    location: emailAnalysis.location || null,
    serviceCategory: emailAnalysis.serviceCategory || 'general',
    tenantEmail: tenantEmail,
    tenantName: tenantName,
    propertyAddress: emailAnalysis.propertyAddress || null,
    unitNumber: emailAnalysis.unitNumber || null,
    tenantPhone: emailAnalysis.tenantPhone || null
  };

  // Format tenant availability for clear communication
  if (emailAnalysis.tenantAvailability) {
    context.tenantAvailability = emailAnalysis.tenantAvailability;
  } else {
    // Provide default if not specified
    context.tenantAvailability = 'Tenant did not specify availability. Please ask the maintenance provider when they can schedule the service.';
  }

  return context;
}

/**
 * Reset monitor state (useful for testing)
 */
export async function resetMonitorState() {
  await saveState({ 
    lastProcessedId: null, 
    lastCheckTime: null,
    emailsChecked: 0,
    issuesDetected: 0
  });
  return { ok: true, message: 'Monitor state reset' };
}

/**
 * Find best repair service provider using AI analysis
 * Integrates with ai-provider-selector.js for intelligent provider selection
 * 
 * @param {object} emailAnalysis - The analysis result from analyzeTenantEmail
 * @param {string} propertyLocation - The property location/address
 * @returns {Promise<object>} Selected provider with review analysis
 */
export async function findBestProviderForIssue(emailAnalysis, propertyLocation) {
  if (!emailAnalysis || !emailAnalysis.isMaintenanceIssue) {
    return { ok: false, error: 'No maintenance issue to search for' };
  }

  try {
    // Dynamically import the AI provider selector
    const aiProviderSelector = await import('./ai-provider-selector.js');
    
    if (!aiProviderSelector?.findBestRepairService) {
      console.warn('[Email Monitor] AI Provider Selector not available, using fallback search');
      return { ok: false, error: 'AI Provider Selector not available' };
    }

    console.log('[Email Monitor] 🔍 Searching for best repair service...');
    console.log('[Email Monitor]   Issue:', emailAnalysis.issue);
    console.log('[Email Monitor]   Category:', emailAnalysis.serviceCategory);
    console.log('[Email Monitor]   Location:', propertyLocation || emailAnalysis.location);
    console.log('[Email Monitor]   Urgency:', emailAnalysis.urgency);

    // Use the AI provider selector to find the best service
    const result = await aiProviderSelector.findBestRepairService({
      repairType: emailAnalysis.issue,
      serviceCategory: emailAnalysis.serviceCategory || 'general',
      location: propertyLocation || emailAnalysis.location || emailAnalysis.propertyAddress,
      urgency: emailAnalysis.urgency || 'medium',
      maxCandidates: 5,
      includeDetailedReviews: true
    });

    if (!result.ok || !result.selected) {
      console.warn('[Email Monitor] Provider search returned no results');
      return { 
        ok: false, 
        error: result.error || 'No suitable providers found',
        searchCriteria: {
          repairType: emailAnalysis.issue,
          serviceCategory: emailAnalysis.serviceCategory,
          location: propertyLocation
        }
      };
    }

    console.log('[Email Monitor] ✅ Best provider found:', result.selected.name);
    console.log('[Email Monitor]   Rating:', result.selected.rating, '/ 5');
    console.log('[Email Monitor]   Reviews:', result.selected.reviewCount);
    console.log('[Email Monitor]   Phone:', result.selected.phone || 'Not available');
    console.log('[Email Monitor]   Confidence:', result.selected.selectionConfidence, '%');

    return {
      ok: true,
      provider: {
        name: result.selected.name,
        phone: result.selected.phone,
        address: result.selected.address,
        website: result.selected.website,
        rating: result.selected.rating,
        reviewCount: result.selected.reviewCount,
        googleMapsUrl: result.selected.googleMapsUrl,
        placeId: result.selected.placeId,
        selectionConfidence: result.selected.selectionConfidence,
        selectionReasoning: result.selected.selectionReasoning,
        reviewAnalysis: result.selected.reviewAnalysis
      },
      alternative: result.alternative ? {
        name: result.alternative.name,
        phone: result.alternative.phone,
        rating: result.alternative.rating,
        reason: result.alternative.reason
      } : null,
      callScript: result.callScript,
      comparison: result.comparison,
      searchCriteria: result.searchCriteria,
      allCandidates: result.allCandidates?.map(c => ({
        name: c.name,
        phone: c.phone,
        rating: c.rating,
        reviewCount: c.reviewCount
      }))
    };

  } catch (error) {
    console.error('[Email Monitor] Provider search error:', error);
    return { 
      ok: false, 
      error: error.message,
      searchCriteria: {
        repairType: emailAnalysis.issue,
        serviceCategory: emailAnalysis.serviceCategory,
        location: propertyLocation
      }
    };
  }
}

/**
 * Full automation: Analyze email, find provider, prepare for voice call
 * This is the main integration function for the AI-powered maintenance workflow
 * 
 * @param {string} emailContent - The email body content
 * @param {string} subject - Email subject line
 * @param {string} from - Sender email address
 * @param {string} propertyLocation - Property address (optional, extracted from email if not provided)
 * @param {string} tenantName - Tenant name (optional)
 * @returns {Promise<object>} Complete automation result with provider and call context
 */
export async function processMaintenanceEmailFull(emailContent, subject, from, propertyLocation = null, tenantName = null) {
  console.log('[Email Monitor] ========================================');
  console.log('[Email Monitor] Full Maintenance Email Processing');
  console.log('[Email Monitor] ========================================');

  // Step 1: Analyze the email
  console.log('[Email Monitor] Step 1: Analyzing email content...');
  const analysis = await analyzeTenantEmail(emailContent, subject, from);

  if (!analysis.ok) {
    return { 
      ok: false, 
      step: 'analysis',
      error: analysis.error 
    };
  }

  if (!analysis.isMaintenanceIssue) {
    return {
      ok: true,
      isMaintenanceIssue: false,
      analysis,
      message: 'Email does not appear to be a maintenance request'
    };
  }

  console.log('[Email Monitor] ✅ Maintenance issue detected:', analysis.issue);

  // Step 2: Find the best provider
  console.log('[Email Monitor] Step 2: Finding best repair service provider...');
  const location = propertyLocation || analysis.propertyAddress || analysis.location;
  
  if (!location) {
    return {
      ok: false,
      step: 'provider_search',
      error: 'No location found for provider search',
      analysis,
      suggestion: 'Please provide the property address manually'
    };
  }

  const providerResult = await findBestProviderForIssue(analysis, location);

  if (!providerResult.ok || !providerResult.provider) {
    return {
      ok: false,
      step: 'provider_search',
      error: providerResult.error || 'Could not find suitable provider',
      analysis,
      fallbackSearchQuery: analysis.searchQuery
    };
  }

  console.log('[Email Monitor] ✅ Provider selected:', providerResult.provider.name);

  // Step 3: Format context for voice call
  console.log('[Email Monitor] Step 3: Preparing voice call context...');
  const callContext = formatMaintenanceContextForCall(analysis, from, tenantName);

  // Combine everything for voice call automation
  const result = {
    ok: true,
    isMaintenanceIssue: true,
    analysis: {
      issue: analysis.issue,
      urgency: analysis.urgency,
      serviceCategory: analysis.serviceCategory,
      location: analysis.location,
      tenantAvailability: analysis.tenantAvailability,
      confidence: analysis.confidence
    },
    selectedProvider: providerResult.provider,
    alternativeProvider: providerResult.alternative,
    callContext: {
      ...callContext,
      providerName: providerResult.provider.name,
      providerPhone: providerResult.provider.phone,
      providerAddress: providerResult.provider.address
    },
    callScript: providerResult.callScript,
    voiceCallReady: providerResult.provider.phone ? true : false,
    reviewSummary: providerResult.provider.reviewAnalysis?.summary || providerResult.provider.selectionReasoning,
    nextSteps: providerResult.provider.phone ? [
      `Call ${providerResult.provider.name} at ${providerResult.provider.phone}`,
      'Use the AI voice call system for automated scheduling',
      'Confirm appointment details with tenant'
    ] : [
      'Provider phone not available - visit their website',
      providerResult.provider.website ? `Website: ${providerResult.provider.website}` : null,
      'Or try the alternative provider'
    ].filter(Boolean)
  };

  console.log('[Email Monitor] ========================================');
  console.log('[Email Monitor] Processing complete!');
  console.log('[Email Monitor] Voice call ready:', result.voiceCallReady);
  console.log('[Email Monitor] ========================================');

  return result;
}

