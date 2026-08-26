/**
 * Equifax SmartScreen Advanced Tenant Check API Integration
 * 
 * Provides comprehensive background screening including:
 * - Criminal records check
 * - Eviction history
 * - Identity verification
 * - Public records
 * 
 * @see https://api.equifax.com/business/government-reports/smartscreen/advanced/tenant-check/v1
 */

import 'dotenv/config';

// Determine if using sandbox or production
const EQUIFAX_ENVIRONMENT = process.env.EQUIFAX_ENVIRONMENT || 'sandbox';
const EQUIFAX_BACKGROUND_CHECK_BASE = EQUIFAX_ENVIRONMENT === 'sandbox' 
  ? 'https://api.sandbox.equifax.com/business/government-reports/smartscreen/advanced/tenant-check/v1'
  : 'https://api.equifax.com/business/government-reports/smartscreen/advanced/tenant-check/v1';

const EQUIFAX_ACCESS_TOKEN = process.env.EQUIFAX_ACCESS_TOKEN || '';

/**
 * Run comprehensive background check on tenant applicant
 * 
 * @param {Object} applicantData - Applicant information
 * @param {string} applicantData.firstName - First name
 * @param {string} applicantData.lastName - Last name
 * @param {string} applicantData.ssn - Social Security Number
 * @param {string} applicantData.dateOfBirth - Date of birth (YYYY-MM-DD)
 * @param {Object} applicantData.address - Current address
 * @param {string} applicantData.address.street - Street address
 * @param {string} applicantData.address.city - City
 * @param {string} applicantData.address.state - State (2-letter code)
 * @param {string} applicantData.address.zipCode - ZIP code
 * @returns {Promise<Object>} Background check results
 */
export async function runBackgroundCheck(applicantData) {
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

    // Construct the API request payload for SmartScreen Tenant Check
    const requestPayload = {
      consumer: {
        firstName: applicantData.firstName,
        lastName: applicantData.lastName,
        middleName: applicantData.middleName || '',
        ssn: applicantData.ssn.replace(/\D/g, ''), // Remove dashes from SSN
        dateOfBirth: applicantData.dateOfBirth,
        currentAddress: {
          streetAddress: applicantData.address.street,
          city: applicantData.address.city,
          state: applicantData.address.state,
          zipCode: applicantData.address.zipCode
        }
      },
      searchCriteria: {
        includeCriminalRecords: true,
        includeEvictionRecords: true,
        includeSexOffenderRegistry: true,
        includeGlobalWatchlist: true,
        searchRadius: 'national' // national, state, or county
      }
    };

    console.log('[Equifax Background] Requesting tenant check for:', {
      name: `${applicantData.firstName} ${applicantData.lastName}`,
      city: applicantData.address.city,
      state: applicantData.address.state,
      environment: EQUIFAX_ENVIRONMENT
    });

    // Make API request to Equifax SmartScreen
    const response = await fetch(EQUIFAX_BACKGROUND_CHECK_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EQUIFAX_ACCESS_TOKEN}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Equifax Background] API error:', response.status, errorText);
      
      // Provide helpful error messages
      let userMessage = `Equifax Background Check API returned ${response.status}`;
      if (response.status === 401) {
        userMessage = 'Invalid Equifax API credentials. Please check your access token.';
      } else if (response.status === 403) {
        userMessage = 'Access denied. Your Equifax subscription may not include background checks.';
      } else if (response.status === 429) {
        userMessage = 'Rate limit exceeded. Please wait before making more requests.';
      } else if (response.status === 501) {
        userMessage = 'Endpoint not implemented. The background check API may not be available in your environment.';
      }
      
      return {
        ok: false,
        error: 'equifax_background_check_error',
        statusCode: response.status,
        message: userMessage,
        details: errorText
      };
    }

    const data = await response.json();
    
    // Parse and structure the response
    const backgroundReport = parseBackgroundCheck(data);
    
    console.log('[Equifax Background] Check complete:', {
      status: backgroundReport.status,
      criminalRecords: backgroundReport.criminalRecords?.count || 0,
      evictions: backgroundReport.evictions?.count || 0
    });

    return {
      ok: true,
      report: backgroundReport,
      rawData: data // Include raw data for debugging
    };

  } catch (error) {
    console.error('[Equifax Background] Error running check:', error);
    return {
      ok: false,
      error: 'request_failed',
      message: error.message
    };
  }
}

/**
 * Parse Equifax background check response into simplified format
 * 
 * @param {Object} rawData - Raw Equifax API response
 * @returns {Object} Parsed background check report
 */
function parseBackgroundCheck(rawData) {
  try {
    // Extract key information
    const criminalRecords = extractCriminalRecords(rawData);
    const evictions = extractEvictions(rawData);
    const sexOffenderStatus = extractSexOffenderStatus(rawData);
    const identityVerification = extractIdentityVerification(rawData);
    
    // Determine overall status
    const hasCriminalRecords = criminalRecords.count > 0;
    const hasEvictions = evictions.count > 0;
    const isSexOffender = sexOffenderStatus.registered;
    
    let status = 'clear';
    let risk = 'low';
    
    if (hasCriminalRecords || hasEvictions || isSexOffender) {
      status = 'flagged';
      risk = isSexOffender || criminalRecords.count > 2 ? 'high' : 'medium';
    }
    
    const report = {
      status, // 'clear', 'flagged', 'pending'
      risk, // 'low', 'medium', 'high'
      reportDate: new Date().toISOString(),
      criminalRecords,
      evictions,
      sexOffenderStatus,
      identityVerification,
      summary: generateBackgroundSummary(status, criminalRecords, evictions, sexOffenderStatus)
    };

    return report;
  } catch (error) {
    console.error('[Equifax Background] Error parsing report:', error);
    return {
      status: 'error',
      risk: 'unknown',
      reportDate: new Date().toISOString(),
      summary: 'Error parsing background check report',
      error: error.message
    };
  }
}

/**
 * Extract criminal records from response
 */
function extractCriminalRecords(data) {
  try {
    const records = data.criminalRecords || data.consumer?.criminalRecords || [];
    return {
      count: records.length,
      records: records.map(record => ({
        type: record.offenseType || record.charge,
        date: record.offenseDate || record.filingDate,
        jurisdiction: record.jurisdiction || record.court,
        disposition: record.disposition || record.status,
        severity: record.severity || (record.felony ? 'felony' : 'misdemeanor')
      }))
    };
  } catch {
    return { count: 0, records: [] };
  }
}

/**
 * Extract eviction records from response
 */
function extractEvictions(data) {
  try {
    const records = data.evictionRecords || data.consumer?.evictionRecords || [];
    return {
      count: records.length,
      records: records.map(record => ({
        date: record.filingDate || record.date,
        court: record.court || record.jurisdiction,
        plaintiff: record.plaintiff,
        amount: record.amount || record.judgmentAmount,
        status: record.status || record.disposition
      }))
    };
  } catch {
    return { count: 0, records: [] };
  }
}

/**
 * Extract sex offender registry status
 */
function extractSexOffenderStatus(data) {
  try {
    const registry = data.sexOffenderRegistry || data.consumer?.sexOffenderRegistry;
    return {
      registered: registry?.registered || false,
      state: registry?.state,
      registrationDate: registry?.registrationDate
    };
  } catch {
    return { registered: false };
  }
}

/**
 * Extract identity verification results
 */
function extractIdentityVerification(data) {
  try {
    const verification = data.identityVerification || data.consumer?.identityVerification;
    return {
      verified: verification?.verified !== false,
      ssnValid: verification?.ssnValidation === 'valid',
      addressValid: verification?.addressValidation === 'valid',
      score: verification?.score || 100
    };
  } catch {
    return { verified: true, ssnValid: true, addressValid: true, score: 100 };
  }
}

/**
 * Generate human-readable summary
 */
function generateBackgroundSummary(status, criminalRecords, evictions, sexOffender) {
  if (status === 'error') return 'Error processing background check';
  
  let summary = [];
  
  if (status === 'clear') {
    summary.push('Background check clear.');
    summary.push('No criminal records found.');
    summary.push('No eviction history found.');
    summary.push('Not registered on sex offender registry.');
  } else {
    if (criminalRecords.count > 0) {
      summary.push(`${criminalRecords.count} criminal record${criminalRecords.count > 1 ? 's' : ''} found.`);
    }
    if (evictions.count > 0) {
      summary.push(`${evictions.count} eviction${evictions.count > 1 ? 's' : ''} on record.`);
    }
    if (sexOffender.registered) {
      summary.push('Registered sex offender.');
    }
  }
  
  return summary.join(' ');
}

/**
 * Validate Equifax API credentials
 */
export async function validateBackgroundCheckCredentials() {
  try {
    if (!EQUIFAX_ACCESS_TOKEN) {
      return {
        ok: false,
        error: 'missing_credentials',
        message: 'Equifax access token not configured'
      };
    }

    return {
      ok: true,
      message: 'Credentials configured',
      endpoint: EQUIFAX_BACKGROUND_CHECK_BASE
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
export const isConfigured = () => !!EQUIFAX_ACCESS_TOKEN;

console.log('[Equifax Background] Module loaded:', {
  configured: isConfigured(),
  accessToken: EQUIFAX_ACCESS_TOKEN ? '***' : 'not set',
  environment: EQUIFAX_ENVIRONMENT,
  endpoint: EQUIFAX_BACKGROUND_CHECK_BASE
});
