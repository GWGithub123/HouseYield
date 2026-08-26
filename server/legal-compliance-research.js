/**
 * Legal Compliance Research Service
 * 
 * Combines three data sources for maximum accuracy:
 * 1. Static curated database (legal-compliance-data.js) — reliable baseline
 * 2. Google Custom Search API — searches for recent law changes and local ordinances
 * 3. Gemini Search Grounding — real-time web search during AI generation
 * 
 * This service runs BEFORE document generation to gather jurisdiction-specific
 * legal requirements, then feeds that context into the AI document generator.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  getStateLaws,
  extractStateFromAddress,
  getLocalJurisdictionRules,
  buildComplianceContext,
  getRequiredDisclosures,
  FEDERAL_REQUIREMENTS
} from './legal-compliance-data.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_SEARCH_ENGINE_ID || '';
const GEMINI_API_KEY = process.env.Gemini_API_Key || '';

// Initialize Gemini with search grounding capability
let geminiWithSearch = null;
try {
  if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiWithSearch = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{
        google_search: {}
      }]
    });
    console.log('[ComplianceResearch] ✅ Gemini search grounding initialized');
  }
} catch (error) {
  console.warn('[ComplianceResearch] ⚠️ Gemini search grounding unavailable:', error.message);
}

// ============================================================================
// GOOGLE CUSTOM SEARCH
// ============================================================================

/**
 * Search for recent legal changes using Google Custom Search API
 * @param {string} query — Search query
 * @param {number} numResults — Number of results (max 10)
 * @returns {Promise<Array>} Search results
 */
async function googleLegalSearch(query, numResults = 5) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_CSE_CX) {
    console.warn('[ComplianceResearch] Google Search API not configured');
    return [];
  }

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(query)}&num=${numResults}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.error('[ComplianceResearch] Google Search error:', response.status);
      return [];
    }

    const data = await response.json();
    return (data.items || []).map(item => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link,
      source: item.displayLink
    }));
  } catch (error) {
    console.error('[ComplianceResearch] Google Search error:', error.message);
    return [];
  }
}

// ============================================================================
// GEMINI SEARCH GROUNDING
// ============================================================================

/**
 * Use Gemini with search grounding to research current legal requirements
 * @param {string} query — Research question
 * @returns {Promise<{content: string, sources: Array}>}
 */
async function geminiSearchGrounded(query) {
  if (!geminiWithSearch) {
    return { content: '', sources: [] };
  }

  try {
    const result = await geminiWithSearch.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: query }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096
      }
    });

    const response = await result.response;
    const text = response.text();
    
    // Extract grounding metadata (search sources) if available
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const sources = groundingMetadata?.groundingChunks?.map(chunk => ({
      title: chunk.web?.title || '',
      url: chunk.web?.uri || '',
    })) || [];

    return {
      content: text,
      sources
    };
  } catch (error) {
    console.error('[ComplianceResearch] Gemini grounded search error:', error.message);
    return { content: '', sources: [] };
  }
}

// ============================================================================
// MAIN COMPLIANCE RESEARCH FUNCTIONS
// ============================================================================

/**
 * Research comprehensive legal compliance requirements for a jurisdiction.
 * Combines static database + Google Search + Gemini grounding.
 * 
 * @param {Object} params
 * @param {string} params.propertyAddress — Full property address
 * @param {string} params.stateCode — 2-letter state code (optional, will extract from address)
 * @param {string} params.documentType — Type of document being generated
 * @param {number} params.propertyYearBuilt — Year built (for lead paint)
 * @param {number} params.monthlyRent — Monthly rent amount
 * @param {number} params.securityDeposit — Security deposit amount
 * @returns {Promise<Object>} Comprehensive compliance data
 */
export async function researchCompliance(params) {
  const {
    propertyAddress,
    stateCode: providedStateCode,
    documentType = 'lease_agreement',
    propertyYearBuilt,
    monthlyRent,
    securityDeposit
  } = params;

  const stateCode = providedStateCode || extractStateFromAddress(propertyAddress);
  
  if (!stateCode) {
    console.warn('[ComplianceResearch] Could not determine state from address:', propertyAddress);
    return {
      success: false,
      stateCode: null,
      staticCompliance: null,
      recentChanges: [],
      geminiResearch: null,
      complianceContext: 'State could not be determined from the address. Document generated with general best practices — consult a local attorney.',
      warnings: ['Could not determine jurisdiction — legal compliance not verified']
    };
  }

  console.log(`[ComplianceResearch] Researching compliance for ${stateCode} — ${documentType}`);

  // 1. Get static compliance data (instant, always available)
  const stateLaws = getStateLaws(stateCode);
  const staticContext = buildComplianceContext(stateCode, propertyAddress, {
    propertyYearBuilt,
    monthlyRent
  });
  const localRules = getLocalJurisdictionRules(propertyAddress, stateCode);
  const disclosures = getRequiredDisclosures(stateCode, propertyYearBuilt);

  // 2. Run Google Search + Gemini search in parallel for recent changes
  const searchQueries = buildSearchQueries(stateCode, documentType, propertyAddress);
  
  const [googleResults, geminiResult] = await Promise.all([
    // Google Custom Search for recent law changes
    Promise.all(searchQueries.google.map(q => googleLegalSearch(q, 3)))
      .then(results => results.flat())
      .catch(() => []),
    
    // Gemini with search grounding for comprehensive research
    geminiSearchGrounded(searchQueries.gemini)
      .catch(() => ({ content: '', sources: [] }))
  ]);

  // 3. Validate security deposit compliance
  const depositWarnings = [];
  if (monthlyRent && securityDeposit && stateLaws?.securityDeposit?.maxAmountFormula) {
    const maxDeposit = stateLaws.securityDeposit.maxAmountFormula(monthlyRent);
    if (maxDeposit && securityDeposit > maxDeposit) {
      depositWarnings.push(
        `⚠️ Security deposit of $${securityDeposit.toLocaleString()} exceeds the ${stateLaws.stateName} maximum of $${maxDeposit.toLocaleString()} (${stateLaws.securityDeposit.maxAmount}). This must be corrected to comply with ${stateLaws.securityDeposit.statuteReference}.`
      );
    }
  }

  // 4. Build the enhanced compliance context for AI prompts
  const enhancedContext = buildEnhancedComplianceContext({
    staticContext,
    googleResults,
    geminiResearch: geminiResult,
    documentType,
    stateCode,
    stateLaws,
    localRules,
    disclosures,
    depositWarnings,
    propertyYearBuilt,
    monthlyRent,
    securityDeposit
  });

  return {
    success: true,
    stateCode,
    stateName: stateLaws?.stateName || stateCode,
    staticCompliance: stateLaws,
    localJurisdiction: localRules,
    requiredDisclosures: disclosures,
    recentChanges: googleResults,
    geminiResearch: geminiResult,
    complianceContext: enhancedContext,
    warnings: depositWarnings,
    sources: [
      ...(geminiResult.sources || []),
      ...googleResults.map(r => ({ title: r.title, url: r.link }))
    ]
  };
}

/**
 * Build search queries based on document type and jurisdiction
 */
function buildSearchQueries(stateCode, documentType, propertyAddress) {
  const stateLaws = getStateLaws(stateCode);
  const stateName = stateLaws?.stateName || stateCode;
  const currentYear = new Date().getFullYear();

  // Document-type-specific search queries for Google Custom Search
  const googleQueries = {
    lease_agreement: [
      `${stateName} residential lease agreement requirements ${currentYear} landlord tenant law changes`,
      `${stateName} rental property required disclosures ${currentYear} new laws`
    ],
    lease_amendment: [
      `${stateName} lease amendment requirements ${currentYear}`,
    ],
    notice_to_vacate: [
      `${stateName} notice to vacate requirements ${currentYear} tenant rights`,
    ],
    notice_to_quit: [
      `${stateName} eviction notice requirements ${currentYear} landlord procedure`,
    ],
    rent_increase_notice: [
      `${stateName} rent increase notice requirements ${currentYear}`,
      `${stateName} rent control ${currentYear} new regulations`
    ],
    pet_addendum: [
      `${stateName} pet addendum requirements rental ${currentYear}`,
    ],
    move_in_checklist: [
      `${stateName} move-in inspection requirements rental property ${currentYear}`,
    ],
    move_out_checklist: [
      `${stateName} move-out inspection security deposit deductions ${currentYear}`,
    ],
    maintenance_authorization: [
      `${stateName} maintenance authorization rental property requirements ${currentYear}`,
    ]
  };

  // Gemini search-grounded research prompt
  const geminiQuery = `You are a legal compliance researcher specializing in residential landlord-tenant law.

Research the CURRENT (${currentYear}) landlord-tenant laws for ${stateName} that affect ${formatDocumentType(documentType)} documents.

Focus on:
1. Any NEW laws or amendments effective in ${currentYear - 1} or ${currentYear} that change requirements for ${formatDocumentType(documentType)} documents
2. Current statutory requirements specific to ${formatDocumentType(documentType)} documents in ${stateName}
3. Any pending legislation that may soon take effect
4. Local ordinances in the area of ${propertyAddress || stateName} that add additional requirements
5. Any court decisions from the past 2 years that changed how ${formatDocumentType(documentType)} law is interpreted in ${stateName}

Provide specific statute citations and effective dates for any changes found. Format as a structured list of requirements and changes.`;

  return {
    google: googleQueries[documentType] || [`${stateName} ${formatDocumentType(documentType)} requirements ${currentYear}`],
    gemini: geminiQuery
  };
}

/**
 * Build the enhanced compliance context that gets injected into AI document generation prompts
 */
function buildEnhancedComplianceContext(data) {
  const {
    staticContext,
    googleResults,
    geminiResearch,
    documentType,
    stateCode,
    stateLaws,
    localRules,
    disclosures,
    depositWarnings,
    propertyYearBuilt,
    monthlyRent,
    securityDeposit
  } = data;

  let context = staticContext;

  // Add deposit compliance warnings
  if (depositWarnings.length > 0) {
    context += `\n--- COMPLIANCE WARNINGS ---\n${depositWarnings.join('\n')}\n`;
  }

  // Add real-time research findings
  if (geminiResearch?.content) {
    context += `
--- REAL-TIME LEGAL RESEARCH (${new Date().toLocaleDateString()}) ---
The following information was gathered from real-time web research and should be
cross-referenced with the static requirements above. If there are conflicts, 
the more recent/protective requirement should apply.

${geminiResearch.content}
`;

    if (geminiResearch.sources?.length > 0) {
      context += `\nSources:\n${geminiResearch.sources.map(s => `- ${s.title}: ${s.url}`).join('\n')}\n`;
    }
  }

  // Add Google Search findings
  if (googleResults?.length > 0) {
    context += `
--- RECENT LEGAL DEVELOPMENTS (Google Search) ---
${googleResults.map(r => `• ${r.title}\n  ${r.snippet}\n  Source: ${r.link}`).join('\n\n')}
`;
  }

  // Add document-type-specific compliance instructions
  context += buildDocumentTypeComplianceInstructions(documentType, stateCode, stateLaws, {
    monthlyRent,
    securityDeposit,
    propertyYearBuilt,
    localRules,
    disclosures
  });

  return context;
}

/**
 * Document-type-specific compliance instructions
 */
function buildDocumentTypeComplianceInstructions(documentType, stateCode, stateLaws, options = {}) {
  if (!stateLaws) return '';

  const { monthlyRent, securityDeposit, propertyYearBuilt, localRules, disclosures } = options;
  
  const instructions = {
    lease_agreement: () => {
      let text = `
--- DOCUMENT-SPECIFIC COMPLIANCE: LEASE AGREEMENT ---
CRITICAL: This lease MUST include ALL of the following to comply with ${stateLaws.stateName} law:

MANDATORY SECTIONS (omitting any of these may make the lease unenforceable or expose
the landlord to liability):
${stateLaws.requiredLeaseProvisions.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}

SECURITY DEPOSIT CLAUSE MUST STATE:
- Maximum deposit: ${stateLaws.securityDeposit.maxAmount}
- Holding requirements: ${stateLaws.securityDeposit.holdingRequirements}
- Return deadline: ${stateLaws.securityDeposit.returnDeadline}
- Itemized statement requirement: ${stateLaws.securityDeposit.itemizedStatementDeadline}
${stateLaws.securityDeposit.interestRequired ? `- Interest: ${stateLaws.securityDeposit.interestDetails}` : ''}

LATE FEE CLAUSE MUST COMPLY WITH:
- ${stateLaws.rentRules.lateFeeMax}
${stateLaws.rentRules.gracePeriod !== 'No statutory grace period' && stateLaws.rentRules.gracePeriod !== 'No statutory grace period statewide' ? `- Grace period: ${stateLaws.rentRules.gracePeriod}` : ''}

ENTRY/ACCESS CLAUSE:
- Minimum notice: ${stateLaws.landlordEntry.noticeRequired}

TERMINATION PROVISIONS:
- Month-to-month notice (landlord): ${stateLaws.leaseTermination.monthToMonthNotice.landlord}
- Month-to-month notice (tenant): ${stateLaws.leaseTermination.monthToMonthNotice.tenant}

REQUIRED DISCLOSURES TO INCLUDE OR ATTACH:
${disclosures?.map((d, i) => `  ${i + 1}. ${d.name}: ${d.description}`).join('\n') || 'See state law for required disclosures.'}
`;
      if (localRules) {
        text += `
LOCAL REQUIREMENTS (${localRules.name}):
${localRules.additionalRules.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}
`;
      }
      return text;
    },

    rent_increase_notice: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: RENT INCREASE NOTICE ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Notice period: ${stateLaws.rentRules.rentIncreaseNotice}
- Rent control: ${stateLaws.rentRules.rentControlAreas}
- Must be in writing
- Must clearly state current rent, new rent, and effective date
- Must specify the date by which tenant must respond or when the increase takes effect
${stateLaws.leaseTermination.monthToMonthNotice.landlord.includes('just cause') || stateLaws.leaseTermination.monthToMonthNotice.landlord.includes('JUST CAUSE') ? '- WARNING: This jurisdiction may limit rent increases. Verify compliance with local rent stabilization ordinances.' : ''}
`,

    notice_to_vacate: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: NOTICE TO VACATE ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Tenant notice period: ${stateLaws.leaseTermination.monthToMonthNotice.tenant}
- Must be in writing
- Must specify the date tenant intends to vacate
- Should include forwarding address for security deposit return
- Reference security deposit return deadline: ${stateLaws.securityDeposit.returnDeadline}
`,

    notice_to_quit: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: NOTICE TO QUIT ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Non-payment process: ${stateLaws.eviction.nonpaymentProcess}
- Breach of lease process: ${stateLaws.eviction.breachOfLeaseProcess}
- Holdover process: ${stateLaws.eviction.holdoverProcess}
- Anti-retaliation: ${stateLaws.eviction.retaliationProtection}
WARNING: Improper notice may void the eviction proceeding. Follow statutory requirements exactly.
`,

    move_in_checklist: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: MOVE-IN CHECKLIST ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
${stateLaws.requiredDisclosures.find(d => d.name.includes('Move-In') || d.name.includes('Damage Disclosure')) 
  ? `- ${stateLaws.requiredDisclosures.find(d => d.name.includes('Move-In') || d.name.includes('Damage Disclosure')).description}`
  : '- Document property condition thoroughly at move-in. Both parties should sign.'}
- Include date, property address, and parties
- Cover all rooms, appliances, fixtures, flooring, walls, windows, doors
- Note any pre-existing damage with photos if possible
- Both landlord and tenant must sign and receive copies
`,

    move_out_checklist: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: MOVE-OUT CHECKLIST ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Compare condition against move-in checklist
- Distinguish normal wear and tear from tenant damage
- Document any security deposit deductions with itemized costs
- Security deposit return deadline: ${stateLaws.securityDeposit.returnDeadline}
- Itemized statement requirement: ${stateLaws.securityDeposit.itemizedStatementDeadline}
- Non-compliance penalty: ${stateLaws.securityDeposit.penaltyForNonCompliance}
`,

    pet_addendum: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: PET ADDENDUM ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Must comply with Fair Housing Act regarding service animals and emotional support animals
- Pet deposits may count toward the total security deposit cap (${stateLaws.securityDeposit.maxAmount})
- Service animals and emotional support animals: NO pet deposit or pet rent may be charged
- Must clearly define pet type, breed, weight restrictions
- Include liability provisions, damage responsibility, and removal conditions
`,

    lease_amendment: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: LEASE AMENDMENT ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Must reference the original lease date and parties
- Must clearly state which provisions are being modified
- Must state that all other terms remain in force
- Must be signed by all parties to the original lease
- Effective date must be clearly stated
- Any changes to security deposit, rent, or term must comply with the same state law requirements as the original lease
`,

    maintenance_authorization: () => `
--- DOCUMENT-SPECIFIC COMPLIANCE: MAINTENANCE AUTHORIZATION ---
REQUIREMENTS FOR ${stateLaws.stateName.toUpperCase()}:
- Landlord right of entry: ${stateLaws.landlordEntry.noticeRequired}
- Emergency exception: ${stateLaws.landlordEntry.emergencyException ? 'Yes' : 'No'}
- Must clearly describe the work to be performed
- Include authorization for property access
- Specify the time window for work
- Include tenant contact information and emergency contact
`
  };

  const fn = instructions[documentType];
  return fn ? fn() : '';
}

/**
 * Format document type ID to human-readable name
 */
function formatDocumentType(documentType) {
  const names = {
    lease_agreement: 'Residential Lease Agreement',
    lease_amendment: 'Lease Amendment',
    move_in_checklist: 'Move-In Inspection Checklist',
    move_out_checklist: 'Move-Out Inspection Checklist',
    notice_to_vacate: 'Notice to Vacate',
    notice_to_quit: 'Notice to Quit / Eviction Notice',
    rent_increase_notice: 'Rent Increase Notice',
    pet_addendum: 'Pet Addendum',
    maintenance_authorization: 'Maintenance Authorization',
    security_deposit_receipt: 'Security Deposit Receipt',
    rent_receipt: 'Rent Receipt'
  };
  return names[documentType] || documentType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Quick compliance check — validates specific document parameters against state law
 * Use this for real-time validation in the UI before generating documents
 * 
 * @param {Object} params
 * @returns {Object} Validation results with warnings
 */
export async function quickComplianceCheck(params) {
  const { propertyAddress, stateCode: provided, monthlyRent, securityDeposit, lateFee, noticeHours } = params;
  
  const stateCode = provided || extractStateFromAddress(propertyAddress);
  const stateLaws = getStateLaws(stateCode);
  
  if (!stateLaws) {
    return { valid: true, warnings: [], stateCode: null, message: 'State not in database — cannot validate' };
  }

  const warnings = [];

  // Check security deposit
  if (monthlyRent && securityDeposit && stateLaws.securityDeposit.maxAmountFormula) {
    const max = stateLaws.securityDeposit.maxAmountFormula(monthlyRent);
    if (max && securityDeposit > max) {
      warnings.push({
        field: 'securityDeposit',
        severity: 'error',
        message: `Security deposit ($${securityDeposit.toLocaleString()}) exceeds ${stateLaws.stateName} maximum of ${stateLaws.securityDeposit.maxAmount} ($${max.toLocaleString()})`,
        statute: stateLaws.securityDeposit.statuteReference
      });
    }
  }

  // Check late fee
  if (monthlyRent && lateFee && stateLaws.rentRules.lateFeeMaxFormula) {
    const maxLateFee = stateLaws.rentRules.lateFeeMaxFormula(monthlyRent);
    if (maxLateFee && lateFee > maxLateFee) {
      warnings.push({
        field: 'lateFee',
        severity: 'error',
        message: `Late fee ($${lateFee}) exceeds ${stateLaws.stateName} maximum of ${stateLaws.rentRules.lateFeeMax} ($${maxLateFee.toLocaleString()})`,
        statute: stateLaws.rentRules.statuteReference
      });
    }
  }

  // Check entry notice
  if (noticeHours) {
    const minNotice = stateLaws.landlordEntry.noticeRequired;
    const minHoursMatch = minNotice.match(/(\d+)\s*hours?/i);
    if (minHoursMatch && noticeHours < parseInt(minHoursMatch[1])) {
      warnings.push({
        field: 'noticeHours',
        severity: 'error',
        message: `Entry notice of ${noticeHours} hours is below the ${stateLaws.stateName} minimum of ${minNotice}`,
        statute: stateLaws.landlordEntry.statuteReference
      });
    }
  }

  return {
    valid: warnings.filter(w => w.severity === 'error').length === 0,
    warnings,
    stateCode,
    stateName: stateLaws.stateName
  };
}

export default {
  researchCompliance,
  quickComplianceCheck,
  googleLegalSearch,
  geminiSearchGrounded
};
