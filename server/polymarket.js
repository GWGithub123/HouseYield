/**
 * Polymarket API Integration (Secure Version)
 * 
 * This module handles authentication and data fetching from Polymarket's CLOB API.
 * Polymarket uses L1 (Layer 1) signature-based authentication.
 * 
 * SECURITY NOTES:
 * - Private key is read from environment variables ONLY
 * - API keys are cached securely in memory with expiration
 * - All errors sanitized to prevent information leakage
 * - Input validation on all parameters
 * - Rate limiting compatible
 * 
 * Documentation: https://docs.polymarket.com
 */

import { ethers } from 'ethers';
import crypto from 'crypto';

const CLOB_ENDPOINT = process.env.POLYMARKET_CLOB_ENDPOINT || 'https://clob.polymarket.com';

// SECURITY: Private key should ONLY come from environment, never from user input
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;

// In-memory cache for API credentials with expiration
let cachedCredentials = null;
let credentialsExpiry = null;
const CREDENTIALS_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Validate Ethereum private key format
 * @param {string} key - Private key to validate
 * @returns {boolean} True if valid
 */
function isValidPrivateKey(key) {
  if (!key || typeof key !== 'string') return false;
  
  // Remove 0x prefix if present
  const cleanKey = key.startsWith('0x') ? key.slice(2) : key;
  
  // Should be 64 hex characters
  return /^[0-9a-fA-F]{64}$/.test(cleanKey);
}

/**
 * Sanitize error messages to prevent information leakage
 * @param {Error} error - Original error
 * @returns {string} Safe error message
 */
function sanitizeError(error) {
  // Don't expose internal details to clients
  const safeMessages = {
    'invalid private key': 'Authentication configuration error',
    'network error': 'Unable to connect to Polymarket',
    'rate limit': 'Too many requests, please try again later'
  };

  const message = error.message?.toLowerCase() || '';
  
  for (const [key, safeMsg] of Object.entries(safeMessages)) {
    if (message.includes(key)) return safeMsg;
  }
  
  return 'An error occurred while connecting to Polymarket';
}

/**
 * Create L1 authentication headers (INTERNAL USE ONLY)
 * Signs a message with the wallet's private key to prove ownership
 * 
 * @param {string} timestamp - Unix timestamp in seconds
 * @returns {Object} Headers including L1 signature
 */
async function createL1Headers(timestamp = null) {
  try {
    // SECURITY: Only use private key from environment
    if (!PRIVATE_KEY) {
      throw new Error('POLYMARKET_PRIVATE_KEY not configured in environment');
    }

    if (!isValidPrivateKey(PRIVATE_KEY)) {
      throw new Error('Invalid private key format in environment');
    }

    // Add 0x prefix if not present
    const formattedKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
    
    // Create wallet instance
    const wallet = new ethers.Wallet(formattedKey);
    const address = wallet.address;

    // Use provided timestamp or generate new one
    const ts = timestamp || Math.floor(Date.now() / 1000).toString();
    
    // Validate timestamp is reasonable (within 5 minutes of current time)
    const currentTime = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(currentTime - parseInt(ts));
    if (timeDiff > 300) { // 5 minutes
      throw new Error('Timestamp validation failed');
    }
    
    // Create the message to sign (format required by Polymarket)
    const message = `This message attests that I control the given wallet\nTimestamp: ${ts}`;
    
    // Sign the message
    const signature = await wallet.signMessage(message);

    return {
      'POLY-ADDRESS': address,
      'POLY-SIGNATURE': signature,
      'POLY-TIMESTAMP': ts
    };
  } catch (error) {
    console.error('[Polymarket] L1 header creation failed:', sanitizeError(error));
    throw new Error('Authentication failed');
  }
}

/**
 * Derive API key from Polymarket with caching
 * This creates or retrieves your API credentials
 * Uses cached credentials if still valid to reduce API calls
 * 
 * @param {string} nonce - Optional nonce for key derivation (advanced use)
 * @returns {Promise<Object>} API key credentials
 */
export async function deriveApiKey(nonce = null) {
  try {
    // SECURITY: Check if we have valid cached credentials
    if (cachedCredentials && credentialsExpiry && Date.now() < credentialsExpiry) {
      console.log('[Polymarket] Using cached credentials');
      return {
        ok: true,
        ...cachedCredentials,
        cached: true
      };
    }

    // Validate nonce if provided
    if (nonce !== null && (typeof nonce !== 'string' || nonce.length > 100)) {
      return {
        ok: false,
        error: 'Invalid nonce parameter'
      };
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers = await createL1Headers(timestamp);

    // Build query parameters
    const params = new URLSearchParams();
    if (nonce) {
      params.append('nonce', nonce);
    }

    const url = `${CLOB_ENDPOINT}/auth/derive-api-key${nonce ? '?' + params.toString() : ''}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      // Security: Add timeout to prevent hanging requests
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Polymarket] API key derivation failed:', response.status);
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    
    // Validate response structure
    if (!data.apiKey || !data.apiSecret) {
      throw new Error('Invalid API response structure');
    }

    // Cache credentials
    cachedCredentials = {
      apiKey: data.apiKey,
      apiSecret: data.apiSecret,
      apiPassphrase: data.apiPassphrase
    };
    credentialsExpiry = Date.now() + CREDENTIALS_TTL;

    return {
      ok: true,
      ...cachedCredentials
    };
  } catch (error) {
    console.error('[Polymarket] Derive API key error:', error.name);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}

/**
 * Create new API key credentials
 * NOTE: This creates NEW credentials. Use deriveApiKey for existing ones.
 * 
 * @returns {Promise<Object>} New API key credentials
 */
export async function createApiKey() {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers = await createL1Headers(timestamp);

    const response = await fetch(`${CLOB_ENDPOINT}/auth/api-key`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Polymarket] API key creation failed:', response.status);
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    
    // Validate response
    if (!data.apiKey || !data.apiSecret) {
      throw new Error('Invalid API response structure');
    }

    // Update cache with new credentials
    cachedCredentials = {
      apiKey: data.apiKey,
      apiSecret: data.apiSecret,
      apiPassphrase: data.apiPassphrase
    };
    credentialsExpiry = Date.now() + CREDENTIALS_TTL;

    return {
      ok: true,
      ...cachedCredentials
    };
  } catch (error) {
    console.error('[Polymarket] Create API key error:', error.name);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}

/**
 * Get housing-related prediction markets
 * Searches for markets related to real estate, housing prices, mortgage rates, etc.
 * Note: Most Polymarket endpoints are public and don't require authentication
 * 
 * @returns {Promise<Object>} Market data
 */
export async function getHousingMarkets() {
  try {
    // Common housing-related search terms
    const housingTerms = [
      'fed rate',
      'federal reserve',
      'interest rate',
      'mortgage',
      'housing',
      'real estate',
      'home prices',
      'inflation'
    ];

    const markets = [];
    const errors = [];
    
    // Search for each term with rate limiting
    for (const term of housingTerms) {
      try {
        // Input validation
        const safeTerm = encodeURIComponent(term);
        
        const response = await fetch(`${CLOB_ENDPOINT}/markets?search=${safeTerm}`, {
          headers: {
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(5000) // 5 second timeout per request
        });

        if (response.ok) {
          const data = await response.json();
          if (data && Array.isArray(data)) {
            markets.push(...data);
          }
        } else if (response.status === 429) {
          errors.push('Rate limit exceeded');
          break; // Stop making requests if rate limited
        }
        
        // Small delay between requests to be respectful
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error(`[Polymarket] Search error for "${term}":`, err.name);
      }
    }

    // Remove duplicates by market ID
    const uniqueMarkets = Array.from(
      new Map(markets.map(m => [m.condition_id || m.id, m])).values()
    );

    // Sanitize and filter relevant markets
    const sanitizedMarkets = uniqueMarkets
      .filter(m => {
        const question = (m.question || m.title || '').toLowerCase();
        return question.includes('fed') || 
               question.includes('mortgage') || 
               question.includes('interest rate') ||
               question.includes('housing') ||
               question.includes('real estate');
      })
      .map(m => ({
        id: m.condition_id || m.id,
        question: m.question || m.title,
        description: m.description,
        endDate: m.end_date_iso || m.end_date || m.endDate,
        volume: m.volume,
        liquidity: m.liquidity,
        outcomes: m.outcomes,
        outcomeTokens: m.tokens,
        active: m.active,
        closed: m.closed
      }))
      .slice(0, 20); // Limit to top 20 markets

    return {
      ok: true,
      markets: sanitizedMarkets,
      count: sanitizedMarkets.length,
      hasErrors: errors.length > 0,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('[Polymarket] Housing markets fetch error:', error.name);
    return {
      ok: false,
      error: sanitizeError(error),
      markets: []
    };
  }
}

/**
 * Get specific market details by ID
 * 
 * @param {string} marketId - The market ID (condition ID)
 * @returns {Promise<Object>} Market details
 */
export async function getMarketDetails(marketId) {
  try {
    // Input validation
    if (!marketId || typeof marketId !== 'string' || marketId.length > 200) {
      return {
        ok: false,
        error: 'Invalid market ID'
      };
    }

    // Sanitize market ID (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(marketId)) {
      return {
        ok: false,
        error: 'Invalid market ID format'
      };
    }

    const creds = await deriveApiKey();
    
    const response = await fetch(`${CLOB_ENDPOINT}/markets/${marketId}`, {
      headers: creds.ok ? {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json'
      } : {
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Market fetch failed with status ${response.status}`);
    }

    const data = await response.json();
    
    // Sanitize response
    const sanitizedMarket = {
      id: data.id || data.market_id,
      question: data.question || data.title,
      description: data.description,
      endDate: data.end_date || data.endDate,
      volume: data.volume,
      liquidity: data.liquidity,
      outcomes: data.outcomes,
      active: data.active
    };

    return {
      ok: true,
      market: sanitizedMarket
    };
  } catch (error) {
    console.error('[Polymarket] Market details error:', error.name);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}

/**
 * Get current market prices/odds
 * 
 * @param {string} marketId - The market ID
 * @returns {Promise<Object>} Current market prices
 */
export async function getMarketPrices(marketId) {
  try {
    // Input validation
    if (!marketId || typeof marketId !== 'string' || marketId.length > 200) {
      return {
        ok: false,
        error: 'Invalid market ID'
      };
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(marketId)) {
      return {
        ok: false,
        error: 'Invalid market ID format'
      };
    }

    const response = await fetch(`${CLOB_ENDPOINT}/prices?market=${marketId}`, {
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      throw new Error(`Price fetch failed with status ${response.status}`);
    }

    const data = await response.json();
    return {
      ok: true,
      prices: data
    };
  } catch (error) {
    console.error('[Polymarket] Market prices error:', error.name);
    return {
      ok: false,
      error: sanitizeError(error)
    };
  }
}

/**
 * Clear cached credentials (useful for testing or key rotation)
 */
export function clearCredentialsCache() {
  cachedCredentials = null;
  credentialsExpiry = null;
  console.log('[Polymarket] Credentials cache cleared');
}
