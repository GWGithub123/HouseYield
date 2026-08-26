/**
 * Tax1099.com API Service
 * =======================
 * Integration with Tax1099.com for electronic 1099-NEC filing,
 * TIN validation, W-9 collection, and form PDF generation.
 * 
 * API Documentation: https://developer.tax1099.com
 * 
 * Features:
 * - Create Payer (your business) and Recipients (contractors)
 * - File 1099-NEC forms with the IRS electronically
 * - Real-time TIN/SSN/EIN verification
 * - Request W-9 forms from recipients via email
 * - Download filed form PDFs
 * - Get real-time filing status updates
 * 
 * Pricing: As low as $0.68 - $1.63 per form
 */

const TAX1099_BASE_URL = process.env.TAX1099_API_URL || 'https://api.tax1099.com/v2';
const TAX1099_API_KEY = process.env.TAX1099_API_KEY;
const TAX1099_PAYER_TIN = process.env.TAX1099_PAYER_TIN;

/**
 * Base API request helper
 */
async function tax1099Request(method, endpoint, body = null) {
  if (!TAX1099_API_KEY) {
    throw new Error('TAX1099_API_KEY is not configured. Set it in your .env file.');
  }

  const url = `${TAX1099_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${TAX1099_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Tax1099 API error (${response.status}): ${data.message || JSON.stringify(data)}`);
  }

  return data;
}

// ─── Payer Management ────────────────────────────────────────────────────────

/**
 * Create or update payer (your business entity that issues 1099s)
 */
export async function createPayer(payerData) {
  const {
    name,
    tin,
    address,
    city,
    state,
    zip,
    phone,
    email
  } = payerData;

  return tax1099Request('POST', '/payers', {
    PayerName: name,
    PayerTIN: tin || TAX1099_PAYER_TIN,
    PayerAddress: address,
    PayerCity: city,
    PayerState: state,
    PayerZip: zip,
    PayerPhone: phone,
    PayerEmail: email,
    TINType: tin?.length === 9 && !tin.includes('-') ? 'EIN' : 'SSN'
  });
}

/**
 * Get payer details
 */
export async function getPayer(payerId) {
  return tax1099Request('GET', `/payers/${payerId}`);
}

// ─── Recipient Management ────────────────────────────────────────────────────

/**
 * Create a recipient (contractor/vendor who receives a 1099)
 */
export async function createRecipient(recipientData) {
  const {
    payerId,
    name,
    tin,
    tinType, // SSN, EIN
    address,
    city,
    state,
    zip,
    email
  } = recipientData;

  return tax1099Request('POST', '/recipients', {
    PayerID: payerId,
    RecipientName: name,
    RecipientTIN: tin,
    TINType: tinType || (tin?.length === 9 ? 'SSN' : 'EIN'),
    RecipientAddress: address,
    RecipientCity: city,
    RecipientState: state,
    RecipientZip: zip,
    RecipientEmail: email
  });
}

/**
 * Get all recipients for a payer
 */
export async function getRecipients(payerId) {
  return tax1099Request('GET', `/payers/${payerId}/recipients`);
}

// ─── 1099-NEC Form Filing ────────────────────────────────────────────────────

/**
 * Create a 1099-NEC form
 */
export async function create1099NEC(formData) {
  const {
    payerId,
    recipientId,
    taxYear,
    nonemployeeCompensation, // Box 1
    federalTaxWithheld,      // Box 4
    stateTaxWithheld,        // Box 5
    statePayerNumber,        // Box 6
    stateIncome              // Box 7
  } = formData;

  return tax1099Request('POST', '/forms/1099-nec', {
    PayerID: payerId,
    RecipientID: recipientId,
    TaxYear: taxYear,
    Box1_NonemployeeCompensation: nonemployeeCompensation,
    Box4_FederalTaxWithheld: federalTaxWithheld || 0,
    Box5_StateTaxWithheld: stateTaxWithheld || 0,
    Box6_StatePayerNumber: statePayerNumber || '',
    Box7_StateIncome: stateIncome || nonemployeeCompensation
  });
}

/**
 * Submit forms for IRS e-filing
 */
export async function submitForFiling(formIds) {
  return tax1099Request('POST', '/filing/submit', {
    FormIDs: Array.isArray(formIds) ? formIds : [formIds]
  });
}

/**
 * Get filing status for a form or batch
 */
export async function getFilingStatus(filingId) {
  return tax1099Request('GET', `/filing/${filingId}/status`);
}

/**
 * Get all filings for a tax year
 */
export async function getFilingsByYear(taxYear) {
  return tax1099Request('GET', `/filing?taxYear=${taxYear}`);
}

// ─── Form PDF Generation ────────────────────────────────────────────────────

/**
 * Get PDF of a filed 1099 form
 */
export async function getFormPDF(formId) {
  if (!TAX1099_API_KEY) {
    throw new Error('TAX1099_API_KEY is not configured');
  }

  const url = `${TAX1099_BASE_URL}/forms/${formId}/pdf`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${TAX1099_API_KEY}`,
      'Accept': 'application/pdf'
    }
  });

  if (!response.ok) {
    throw new Error(`Tax1099 PDF error (${response.status})`);
  }

  return response.arrayBuffer();
}

// ─── TIN Validation ─────────────────────────────────────────────────────────

/**
 * Real-time TIN (SSN/EIN) validation against IRS database
 * Returns match/mismatch status
 */
export async function validateTIN(name, tin, tinType = 'SSN') {
  return tax1099Request('POST', '/tin-check', {
    Name: name,
    TIN: tin,
    TINType: tinType
  });
}

/**
 * Batch TIN validation for multiple vendors
 */
export async function validateTINBatch(vendors) {
  const results = [];
  for (const vendor of vendors) {
    try {
      const result = await validateTIN(vendor.name, vendor.tin, vendor.tinType);
      results.push({
        vendorName: vendor.name,
        vendorId: vendor.id,
        status: result.Status || result.status,
        valid: result.Status === 'Match' || result.status === 'Match',
        details: result
      });
    } catch (error) {
      results.push({
        vendorName: vendor.name,
        vendorId: vendor.id,
        status: 'error',
        valid: false,
        error: error.message
      });
    }
  }
  return results;
}

// ─── W-9 Collection ─────────────────────────────────────────────────────────

/**
 * Send W-9 request to a vendor via email
 */
export async function requestW9(recipientData) {
  const {
    recipientName,
    recipientEmail,
    payerName,
    message
  } = recipientData;

  return tax1099Request('POST', '/w9/request', {
    RecipientName: recipientName,
    RecipientEmail: recipientEmail,
    PayerName: payerName || 'Renaissance Realty',
    CustomMessage: message || `Hi ${recipientName}, we need your W-9 on file for ${new Date().getFullYear()} tax reporting. Please complete the secure form at the link below.`
  });
}

/**
 * Get W-9 request status
 */
export async function getW9Status(requestId) {
  return tax1099Request('GET', `/w9/${requestId}/status`);
}

// ─── Tax-Exempt Check ────────────────────────────────────────────────────────

/**
 * Check if a vendor is tax-exempt
 */
export async function checkTaxExempt(ein) {
  return tax1099Request('GET', `/tax-exempt/${ein}`);
}

// ─── Complete Filing Workflow ────────────────────────────────────────────────

/**
 * End-to-end filing workflow for a set of vendors
 * 1. Create payer (if needed)
 * 2. Create recipients
 * 3. Create 1099-NEC forms
 * 4. Submit for filing
 * 
 * @param {Object} payerInfo - Payer (landlord) info
 * @param {Array} vendors - Array of vendor objects with payment amounts
 * @param {number} taxYear - Tax year
 */
export async function executeFilingWorkflow(payerInfo, vendors, taxYear) {
  const results = {
    payerId: null,
    recipients: [],
    forms: [],
    filingId: null,
    errors: [],
    summary: { created: 0, filed: 0, failed: 0 }
  };

  try {
    // Step 1: Create/get payer
    const payerResult = await createPayer(payerInfo);
    results.payerId = payerResult.PayerID || payerResult.payerId;

    // Step 2: Create recipients and forms
    for (const vendor of vendors) {
      try {
        // Create recipient
        const recipient = await createRecipient({
          payerId: results.payerId,
          name: vendor.name,
          tin: vendor.tin || vendor.ein,
          tinType: vendor.tinType || (vendor.ein ? 'EIN' : 'SSN'),
          address: vendor.address,
          city: vendor.city,
          state: vendor.state,
          zip: vendor.zip,
          email: vendor.email
        });
        
        const recipientId = recipient.RecipientID || recipient.recipientId;
        results.recipients.push({ vendorName: vendor.name, recipientId });

        // Create 1099-NEC form
        const form = await create1099NEC({
          payerId: results.payerId,
          recipientId,
          taxYear,
          nonemployeeCompensation: vendor.totalPaid,
          stateIncome: vendor.totalPaid
        });

        results.forms.push({
          vendorName: vendor.name,
          formId: form.FormID || form.formId,
          amount: vendor.totalPaid
        });
        results.summary.created++;

      } catch (vendorError) {
        results.errors.push({
          vendor: vendor.name,
          error: vendorError.message
        });
        results.summary.failed++;
      }
    }

    // Step 3: Submit all forms for filing
    if (results.forms.length > 0) {
      const formIds = results.forms.map(f => f.formId);
      const filing = await submitForFiling(formIds);
      results.filingId = filing.FilingID || filing.filingId;
      results.summary.filed = results.forms.length;
    }

  } catch (error) {
    results.errors.push({ step: 'workflow', error: error.message });
  }

  return results;
}

/**
 * Check if Tax1099 API is configured
 */
export function isTax1099Configured() {
  return !!(TAX1099_API_KEY && TAX1099_API_KEY !== 'your_tax1099_api_key_here');
}

export default {
  createPayer,
  getPayer,
  createRecipient,
  getRecipients,
  create1099NEC,
  submitForFiling,
  getFilingStatus,
  getFilingsByYear,
  getFormPDF,
  validateTIN,
  validateTINBatch,
  requestW9,
  getW9Status,
  checkTaxExempt,
  executeFilingWorkflow,
  isTax1099Configured
};
