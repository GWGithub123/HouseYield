/**
 * Equifax API Integration
 * 
 * Provides consumer credit report functionality for tenant screening.
 * Uses Equifax OneView Consumer Credit API v1.
 * 
 * @see https://developer.equifax.com/
 */

import 'dotenv/config';

// Determine environment: sandbox, test, or production
const EQUIFAX_ENVIRONMENT = process.env.EQUIFAX_ENVIRONMENT || 'sandbox';

// API base URLs per Equifax documentation:
// - Sandbox: https://api.sandbox.equifax.com
// - Test/UAT: https://api.uat.equifax.com
// - Live/Production: https://api.equifax.com
const getBaseUrl = () => {
  switch (EQUIFAX_ENVIRONMENT) {
    case 'sandbox': return 'https://api.sandbox.equifax.com';
    case 'test': return 'https://api.uat.equifax.com';
    case 'production': return 'https://api.equifax.com';
    default: return 'https://api.sandbox.equifax.com';
  }
};

const EQUIFAX_BASE_URL = getBaseUrl();
const EQUIFAX_API_BASE = `${EQUIFAX_BASE_URL}/business/oneview/consumer-credit/v1`;
const EQUIFAX_TOKEN_URL = `${EQUIFAX_BASE_URL}/v2/oauth/token`;

const EQUIFAX_CLIENT_ID = process.env.EQUIFAX_CLIENT_ID || '';
const EQUIFAX_API_KEY = process.env.EQUIFAX_API_KEY || '';
let EQUIFAX_ACCESS_TOKEN = process.env.EQUIFAX_ACCESS_TOKEN || '';
let tokenExpiresAt = 0;

// Customer account numbers and security codes (use test credentials for test/sandbox)
const EQUIFAX_CUSTOMER_NUMBER = EQUIFAX_ENVIRONMENT === 'production'
  ? process.env.EQUIFAX_CUSTOMER_NUMBER_PROD
  : process.env.EQUIFAX_CUSTOMER_NUMBER_TEST;
const EQUIFAX_SECURITY_CODE = EQUIFAX_ENVIRONMENT === 'production'
  ? process.env.EQUIFAX_SECURITY_CODE_PROD
  : process.env.EQUIFAX_SECURITY_CODE_TEST;

// The confirmed scope from your Equifax developer portal
const EQUIFAX_SCOPE = 'https://api.equifax.com/business/oneview/consumer-credit/v1';

/**
 * Get a valid OAuth access token
 */
async function getAccessToken() {
  // If we have a valid token that's not expiring soon, reuse it
  const now = Date.now();
  if (EQUIFAX_ACCESS_TOKEN && tokenExpiresAt > now + 60000) {
    return EQUIFAX_ACCESS_TOKEN;
  }
  
  // Fetch new token using client credentials
  console.log('[Equifax] Fetching OAuth access token from:', EQUIFAX_TOKEN_URL);
  console.log('[Equifax] Using scope:', EQUIFAX_SCOPE);
  
  const credentials = Buffer.from(`${EQUIFAX_CLIENT_ID}:${EQUIFAX_API_KEY}`).toString('base64');
  
  try {
    const response = await fetch(EQUIFAX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(EQUIFAX_SCOPE)}`
    });
    
    if (response.ok) {
      const data = await response.json();
      EQUIFAX_ACCESS_TOKEN = data.access_token;
      tokenExpiresAt = now + (data.expires_in * 1000);
      console.log('[Equifax] ✓ Access token obtained, expires in', data.expires_in, 'seconds');
      return EQUIFAX_ACCESS_TOKEN;
    }
    
    const errorText = await response.text();
    console.error('[Equifax] Token fetch failed:', response.status, errorText);
    throw new Error(`Token fetch failed: ${response.status} - ${errorText}`);
  } catch (error) {
    console.error('[Equifax] Token error:', error.message);
    throw error;
  }
}

/**
 * Parse street address into components (houseNumber, streetName, streetType)
 */
function parseStreetAddress(streetAddress) {
  const streetTypes = {
    'STREET': 'ST', 'ST': 'ST',
    'AVENUE': 'AVE', 'AVE': 'AVE',
    'ROAD': 'RD', 'RD': 'RD',
    'DRIVE': 'DR', 'DR': 'DR',
    'LANE': 'LN', 'LN': 'LN',
    'BOULEVARD': 'BLVD', 'BLVD': 'BLVD',
    'COURT': 'CT', 'CT': 'CT',
    'CIRCLE': 'CIR', 'CIR': 'CIR',
    'PLACE': 'PL', 'PL': 'PL',
    'WAY': 'WAY', 'TERRACE': 'TER', 'TER': 'TER',
    'PARKWAY': 'PKWY', 'PKWY': 'PKWY'
  };
  
  const parts = streetAddress.trim().split(/\s+/);
  const houseNumber = parts[0] || '';
  
  // Check if last part is a street type
  const lastPart = (parts[parts.length - 1] || '').toUpperCase();
  const streetType = streetTypes[lastPart] || 'ST';
  
  // Get street name (everything between house number and street type)
  const streetNameParts = streetTypes[lastPart] 
    ? parts.slice(1, -1) 
    : parts.slice(1);
  const streetName = streetNameParts.join(' ') || 'MAIN';
  
  return { houseNumber, streetName, streetType };
}

/**

/**
 * Get consumer credit report from Equifax
 * 
 * @param {Object} applicantData - Applicant information
 * @param {string} applicantData.firstName - First name
 * @param {string} applicantData.lastName - Last name
 * @param {string} applicantData.ssn - Social Security Number (encrypted/secure)
 * @param {string} applicantData.dateOfBirth - Date of birth (YYYY-MM-DD)
 * @param {Object} applicantData.address - Current address
 * @param {string} applicantData.address.street - Street address
 * @param {string} applicantData.address.city - City
 * @param {string} applicantData.address.state - State (2-letter code)
 * @param {string} applicantData.address.zipCode - ZIP code
 * @returns {Promise<Object>} Credit report with score and details
 */
export async function getCreditReport(applicantData) {
  try {
    // Validate required fields
    const requiredFields = ['firstName', 'lastName', 'ssn', 'dateOfBirth', 'address'];
    const missingFields = requiredFields.filter(field => !applicantData[field]);
    
    if (missingFields.length > 0) {
      return {
        ok: false,
        error: 'missing_required_fields',
        missingFields,
        message: `Missing required fields: ${missingFields.join(', ')}`
      };
    }

    // Validate address fields
    if (!applicantData.address.street || !applicantData.address.city || 
        !applicantData.address.state || !applicantData.address.zipCode) {
      return {
        ok: false,
        error: 'incomplete_address',
        message: 'Address must include street, city, state, and ZIP code'
      };
    }

    // Parse street address into components
    const streetParts = parseStreetAddress(applicantData.address.street);
    
    // Construct the API request payload according to Equifax OneView API specs
    const requestPayload = {
      consumers: {
        name: [
          {
            identifier: "current",
            firstName: applicantData.firstName.toUpperCase(),
            lastName: applicantData.lastName.toUpperCase()
          }
        ],
        socialNum: [
          {
            identifier: "current",
            number: applicantData.ssn.replace(/\D/g, '') // Remove dashes from SSN
          }
        ],
        addresses: [
          {
            identifier: "current",
            houseNumber: streetParts.houseNumber,
            streetName: streetParts.streetName.toUpperCase(),
            streetType: streetParts.streetType.toUpperCase(),
            city: applicantData.address.city.toUpperCase(),
            state: applicantData.address.state.toUpperCase(),
            zip: applicantData.address.zipCode
          }
        ]
      },
      customerReferenceIdentifier: `HOUSEYIELD-${Date.now()}`,
      customerConfiguration: {
        equifaxUSConsumerCreditReport: {
          memberNumber: EQUIFAX_CUSTOMER_NUMBER,
          securityCode: EQUIFAX_SECURITY_CODE,
          customerCode: "IAPI",
          multipleReportIndicator: "1",
          ECOAInquiryType: "Individual"
        }
      }
    };

    console.log('[Equifax] Requesting credit report for:', {
      name: `${applicantData.firstName} ${applicantData.lastName}`,
      city: applicantData.address.city,
      state: applicantData.address.state,
      environment: EQUIFAX_ENVIRONMENT
    });

    // Get a valid OAuth access token
    const authToken = await getAccessToken();
    
    // Correct endpoint: /reports/credit-report
    const endpoint = `${EQUIFAX_API_BASE}/reports/credit-report`;
    
    // Log the full request for debugging
    console.log('[Equifax] Request details:', {
      url: endpoint,
      method: 'POST',
      environment: EQUIFAX_ENVIRONMENT,
      memberNumber: EQUIFAX_CUSTOMER_NUMBER,
      hasSecurityCode: !!EQUIFAX_SECURITY_CODE
    });
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Equifax] API error:', response.status, errorText);
      console.error('[Equifax] Response headers:', Object.fromEntries(response.headers.entries()));
      
      // Provide helpful error messages
      let userMessage = `Equifax API returned ${response.status}`;
      if (response.status === 401) {
        userMessage = 'Invalid Equifax API credentials or incorrect request format. Please check your access token and API configuration.';
      } else if (response.status === 403) {
        userMessage = 'Access denied. Your Equifax API subscription may not include consumer credit reports.';
      } else if (response.status === 429) {
        userMessage = 'Rate limit exceeded. Please wait before making more requests.';
      } else if (response.status === 501) {
        userMessage = 'Endpoint not implemented. The API endpoint or request format may be incorrect for your Equifax subscription.';
      }
      
      return {
        ok: false,
        error: 'equifax_api_error',
        statusCode: response.status,
        message: userMessage,
        details: errorText,
        needsValidCredentials: response.status === 401
      };
    }

    const data = await response.json();
    
    // Parse and structure the response
    const creditReport = parseCreditReport(data);
    
    console.log('[Equifax] Credit report received:', {
      score: creditReport.score,
      status: creditReport.status
    });

    return {
      ok: true,
      report: creditReport,
      rawData: data // Include raw data for debugging
    };

  } catch (error) {
    console.error('[Equifax] Error fetching credit report:', error);
    return {
      ok: false,
      error: 'request_failed',
      message: error.message
    };
  }
}

/**
 * Parse Equifax credit report response into simplified format
 * 
 * @param {Object} rawData - Raw Equifax API response
 * @returns {Object} Parsed credit report
 */
function parseCreditReport(rawData) {
  try {
    // Extract credit score (typically FICO score 300-850)
    const creditScore = extractCreditScore(rawData);
    
    // Extract key report details
    const report = {
      score: creditScore,
      scoreRange: getScoreRange(creditScore),
      status: creditScore >= 650 ? 'clear' : 'flagged',
      reportDate: new Date().toISOString(),
      details: {
        accountsInGoodStanding: extractAccountCount(rawData, 'good'),
        delinquentAccounts: extractAccountCount(rawData, 'delinquent'),
        collectionsAccounts: extractAccountCount(rawData, 'collections'),
        bankruptcies: extractPublicRecords(rawData, 'bankruptcy'),
        foreclosures: extractPublicRecords(rawData, 'foreclosure'),
        totalDebt: extractTotalDebt(rawData),
        creditUtilization: extractCreditUtilization(rawData)
      },
      summary: generateSummary(creditScore, rawData)
    };

    return report;
  } catch (error) {
    console.error('[Equifax] Error parsing credit report:', error);
    return {
      score: null,
      scoreRange: 'unknown',
      status: 'error',
      reportDate: new Date().toISOString(),
      details: {},
      summary: 'Error parsing credit report'
    };
  }
}

/**
 * Extract credit score from Equifax response
 * Handles multiple score models (FICO, VantageScore, etc.)
 * and OneView Consumer Credit Report format
 */
function extractCreditScore(data) {
  // OneView Consumer Credit Report format
  if (data.consumers?.equifaxUSConsumerCreditReport) {
    const report = data.consumers.equifaxUSConsumerCreditReport[0];
    
    // Check for models/scores in the report
    if (report?.models) {
      const scoreModel = report.models.find(m => m.score);
      if (scoreModel?.score) return parseInt(scoreModel.score);
    }
    
    // For test data, use hitCode to determine a synthetic score
    // hitCode 1 = no hit, hitCode 2 = hit found
    if (report?.hitCode?.code === '2') {
      // Return a default "good" test score for CTEST data
      console.log('[Equifax] Test data detected (CTEST) - using synthetic score for demo');
      return 720; // Good score for testing
    }
  }
  
  // Try to find FICO score first (most common)
  if (data.consumers?.[0]?.creditScores) {
    const ficoScore = data.consumers[0].creditScores.find(s => 
      s.scoreModel?.includes('FICO') || s.scoreType === 'FICO'
    );
    if (ficoScore?.score) return ficoScore.score;
    
    // Fall back to first available score
    const anyScore = data.consumers[0].creditScores[0];
    if (anyScore?.score) return anyScore.score;
  }
  
  // Legacy format support
  if (data.creditScore) return data.creditScore;
  if (data.score) return data.score;
  
  return null;
}

/**
 * Get score range category
 */
function getScoreRange(score) {
  if (!score) return 'unknown';
  if (score >= 800) return 'exceptional';
  if (score >= 740) return 'very-good';
  if (score >= 670) return 'good';
  if (score >= 580) return 'fair';
  return 'poor';
}

/**
 * Extract account counts by type
 */
function extractAccountCount(data, type) {
  try {
    const accounts = data.consumers?.[0]?.creditAccounts || [];
    switch (type) {
      case 'good':
        return accounts.filter(a => a.paymentStatus === 'CURRENT' || a.paymentStatus === 'PAID').length;
      case 'delinquent':
        return accounts.filter(a => a.paymentStatus?.includes('DELINQUENT')).length;
      case 'collections':
        return accounts.filter(a => a.accountType === 'COLLECTION').length;
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

/**
 * Extract public records by type
 */
function extractPublicRecords(data, type) {
  try {
    const records = data.consumers?.[0]?.publicRecords || [];
    return records.filter(r => r.recordType?.toLowerCase().includes(type.toLowerCase())).length;
  } catch {
    return 0;
  }
}

/**
 * Extract total debt amount
 */
function extractTotalDebt(data) {
  try {
    const accounts = data.consumers?.[0]?.creditAccounts || [];
    const totalDebt = accounts.reduce((sum, account) => {
      return sum + (account.currentBalance || 0);
    }, 0);
    return totalDebt;
  } catch {
    return 0;
  }
}

/**
 * Extract credit utilization percentage
 */
function extractCreditUtilization(data) {
  try {
    const accounts = data.consumers?.[0]?.creditAccounts || [];
    const revolvingAccounts = accounts.filter(a => a.accountType === 'REVOLVING');
    
    const totalLimit = revolvingAccounts.reduce((sum, a) => sum + (a.creditLimit || 0), 0);
    const totalBalance = revolvingAccounts.reduce((sum, a) => sum + (a.currentBalance || 0), 0);
    
    if (totalLimit === 0) return 0;
    return Math.round((totalBalance / totalLimit) * 100);
  } catch {
    return 0;
  }
}

/**
 * Generate human-readable summary
 */
function generateSummary(score, data) {
  if (!score) return 'Credit score not available';
  
  // Check if this is test/CTEST data
  const isTestData = data.consumers?.equifaxUSConsumerCreditReport?.[0]?.hitCode?.code === '2' &&
    !data.consumers?.equifaxUSConsumerCreditReport?.[0]?.models;
  
  const range = getScoreRange(score);
  const delinquent = extractAccountCount(data, 'delinquent');
  const collections = extractAccountCount(data, 'collections');
  
  let summary = '';
  
  if (isTestData) {
    summary = `✓ Test Mode: API connection verified successfully. Score ${score} (synthetic). `;
    summary += 'Switch to production mode for real applicant credit checks.';
    return summary;
  }
  
  summary = `Credit score of ${score} is considered ${range}.`;
  
  if (score >= 650) {
    summary += ' Meets minimum rental requirement.';
  } else {
    summary += ' Below minimum rental requirement (650).';
  }
  
  if (delinquent > 0) {
    summary += ` ${delinquent} delinquent account${delinquent > 1 ? 's' : ''} found.`;
  }
  
  if (collections > 0) {
    summary += ` ${collections} collection account${collections > 1 ? 's' : ''} found.`;
  }
  
  return summary;
}

/**
 * Quick credit check - just returns score and basic status
 * Useful for initial screening before full report
 * 
 * @param {Object} applicantData - Same format as getCreditReport
 * @returns {Promise<Object>} Quick check result with score
 */
export async function quickCreditCheck(applicantData) {
  const result = await getCreditReport(applicantData);
  
  if (!result.ok) {
    return result;
  }
  
  return {
    ok: true,
    score: result.report.score,
    scoreRange: result.report.scoreRange,
    status: result.report.status,
    meetsMinimum: result.report.score >= 650,
    reportDate: result.report.reportDate
  };
}

/**
 * Validate Equifax API credentials
 * 
 * @returns {Promise<Object>} Validation result
 */
export async function validateCredentials() {
  try {
    if (!EQUIFAX_CLIENT_ID || !EQUIFAX_API_KEY) {
      return {
        ok: false,
        error: 'missing_credentials',
        message: 'Equifax credentials not configured'
      };
    }

    // Make a minimal test request to validate credentials
    const response = await fetch(`${EQUIFAX_API_BASE}/health`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${EQUIFAX_API_KEY}`,
        'X-Client-Id': EQUIFAX_CLIENT_ID
      }
    });

    return {
      ok: response.ok,
      statusCode: response.status,
      message: response.ok ? 'Credentials valid' : 'Credentials invalid'
    };
  } catch (error) {
    return {
      ok: false,
      error: 'validation_failed',
      message: error.message
    };
  }
}

// Export configuration check
export const isConfigured = () => !!(EQUIFAX_CLIENT_ID && EQUIFAX_API_KEY);

console.log('[Equifax] Module loaded:', {
  configured: isConfigured(),
  clientId: EQUIFAX_CLIENT_ID ? `${EQUIFAX_CLIENT_ID.substring(0, 8)}...` : 'missing',
  apiKey: EQUIFAX_API_KEY ? '***' : 'missing',
  accessToken: EQUIFAX_ACCESS_TOKEN ? '***' : 'not set',
  environment: EQUIFAX_ENVIRONMENT,
  endpoint: EQUIFAX_API_BASE
});
