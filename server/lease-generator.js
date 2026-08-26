import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Baseline lease agreement template structure
export const LEASE_TEMPLATE_SECTIONS = {
  parties: {
    title: "Parties to the Agreement",
    baseline: "This Residential Lease Agreement ('Agreement') is entered into on [DATE] between [LANDLORD_NAME] ('Landlord') and [TENANT_NAME] ('Tenant') for the property located at [PROPERTY_ADDRESS] ('Premises').",
    customizable: true
  },
  term: {
    title: "Lease Term",
    baseline: "The lease term shall commence on [START_DATE] and continue for a period of [DURATION] months, ending on [END_DATE], unless terminated earlier in accordance with the terms of this Agreement.",
    customizable: true
  },
  rent: {
    title: "Rent and Payment Terms",
    baseline: "Tenant agrees to pay rent in the amount of $[RENT_AMOUNT] per month, due on the [DUE_DATE] day of each month. Payment shall be made to Landlord via [PAYMENT_METHOD]. A late fee of $[LATE_FEE] will be charged for payments received after [GRACE_PERIOD] days past the due date.",
    customizable: true
  },
  security_deposit: {
    title: "Security Deposit",
    baseline: "Tenant shall pay a security deposit of $[DEPOSIT_AMOUNT] upon execution of this Agreement. The deposit will be held in accordance with state law and returned within [RETURN_DAYS] days after the end of the tenancy, less any lawful deductions for damages beyond normal wear and tear.",
    customizable: true
  },
  utilities: {
    title: "Utilities and Services",
    baseline: "Tenant shall be responsible for the following utilities: [TENANT_UTILITIES]. Landlord shall be responsible for: [LANDLORD_UTILITIES]. All utilities must be maintained in Tenant's name and kept current throughout the lease term.",
    customizable: true
  },
  maintenance: {
    title: "Maintenance and Repairs",
    baseline: "Landlord shall maintain the Premises in habitable condition and make all necessary repairs to structural elements, major systems (plumbing, heating, electrical), and appliances provided. Tenant shall maintain the Premises in clean condition and promptly report any needed repairs. Tenant is responsible for minor repairs under $[MINOR_REPAIR_LIMIT].",
    customizable: true
  },
  use_of_premises: {
    title: "Use of Premises",
    baseline: "The Premises shall be used exclusively as a private residence for Tenant and [NUMBER_OCCUPANTS] additional occupants. No commercial activities shall be conducted on the Premises without prior written consent from Landlord.",
    customizable: true
  },
  pets: {
    title: "Pet Policy",
    baseline: "No pets are permitted on the Premises without prior written consent from Landlord. If approved, a pet deposit of $[PET_DEPOSIT] and monthly pet rent of $[PET_RENT] shall apply.",
    customizable: true
  },
  smoking: {
    title: "Smoking Policy",
    baseline: "Smoking is prohibited in all indoor areas of the Premises. Violation of this policy may result in additional cleaning fees and lease termination.",
    customizable: true
  },
  modifications: {
    title: "Alterations and Improvements",
    baseline: "Tenant shall not make any alterations, additions, or improvements to the Premises without prior written consent from Landlord. Any approved modifications shall become the property of Landlord unless otherwise agreed in writing.",
    customizable: true
  },
  entry: {
    title: "Landlord's Right of Entry",
    baseline: "Landlord may enter the Premises with [NOTICE_HOURS] hours advance notice for inspections, repairs, or showings. In case of emergency, Landlord may enter without notice.",
    customizable: true
  },
  assignment: {
    title: "Assignment and Subletting",
    baseline: "Tenant shall not assign this Agreement or sublet the Premises without prior written consent from Landlord. Any unauthorized assignment or subletting shall be grounds for immediate termination.",
    customizable: true
  },
  termination: {
    title: "Termination and Renewal",
    baseline: "Either party may terminate this Agreement by providing [TERMINATION_NOTICE] days written notice. Tenant must vacate the Premises by the end date and leave it in clean, undamaged condition. Early termination by Tenant without cause may result in forfeiture of security deposit and liability for rent through the notice period.",
    customizable: true
  },
  rules: {
    title: "Additional Rules and Regulations",
    baseline: "Tenant agrees to comply with all applicable laws, ordinances, and homeowner association rules. Tenant shall not disturb neighbors or create excessive noise, particularly during quiet hours (10 PM - 8 AM).",
    customizable: true
  },
  default: {
    title: "Default and Remedies",
    baseline: "If Tenant fails to pay rent or violates any terms of this Agreement, Landlord may provide written notice and pursue legal remedies including eviction. Tenant shall be responsible for Landlord's attorney fees and court costs in enforcing this Agreement.",
    customizable: true
  },
  liability: {
    title: "Liability and Insurance",
    baseline: "Landlord is not liable for any damage or loss to Tenant's personal property. Tenant is strongly encouraged to obtain renter's insurance. Tenant shall indemnify Landlord against claims arising from Tenant's use of the Premises.",
    customizable: true
  },
  renters_insurance: {
    title: "Renter's Insurance Requirement",
    baseline: "Tenant is required to maintain renter's insurance throughout the lease term with minimum coverage of $100,000 liability and $25,000 personal property. [INSURANCE_INFO]",
    customizable: true
  },
  disclosures: {
    title: "Disclosures",
    baseline: "Landlord discloses the following known conditions: [DISCLOSURES]. Tenant acknowledges receipt of all required disclosures including lead paint disclosures (if applicable) and community rules.",
    customizable: true
  },
  entire_agreement: {
    title: "Entire Agreement",
    baseline: "This Agreement constitutes the entire agreement between the parties and supersedes all prior negotiations and agreements. Any modifications must be made in writing and signed by both parties. If any provision is found invalid, the remaining provisions shall continue in full effect.",
    customizable: false
  },
  signatures: {
    title: "Signatures",
    baseline: "By signing below, both parties acknowledge they have read, understand, and agree to all terms of this Agreement.\n\nLandlord: _________________ Date: _______\n\nTenant: _________________ Date: _______",
    customizable: false
  }
};

/**
 * Generate a customized lease agreement section using AI
 * @param {string} sectionKey - The section identifier
 * @param {string} baselineText - The baseline template text
 * @param {string} customRequirements - User's custom requirements for this section
 * @param {Object} variables - Variable values to populate (property address, names, etc.)
 * @returns {Promise<string>} The customized section text
 */
export async function generateCustomSection(sectionKey, baselineText, customRequirements, variables = {}) {
  try {
    const prompt = `You are a professional legal document writer specializing in residential lease agreements. 

Your task is to create a customized lease agreement section based on:

1. BASELINE TEMPLATE:
${baselineText}

2. CUSTOM REQUIREMENTS FROM LANDLORD:
${customRequirements || 'No custom requirements - use baseline as-is'}

3. VARIABLES TO POPULATE:
${JSON.stringify(variables, null, 2)}

INSTRUCTIONS:
- Start with the baseline template as your foundation
- Incorporate the landlord's custom requirements naturally into the text
- Replace any [PLACEHOLDER] variables with actual values from the variables object
- Maintain professional legal language appropriate for a residential lease
- Be clear, specific, and unambiguous
- If custom requirements conflict with the baseline, prioritize the custom requirements but note any legal considerations
- Keep the tone formal but readable
- Do not add extra disclaimers or explanations outside the lease text itself

Return ONLY the final lease section text, no preamble or explanation.`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional legal document writer specializing in residential lease agreements. You write clear, enforceable lease clauses that protect both landlord and tenant rights.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3, // Lower temperature for more consistent, professional output
      max_tokens: 1000
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating custom section:', error);
    // Fallback to baseline with simple variable replacement
    return replaceVariables(baselineText, variables);
  }
}

/**
 * Generate a complete customized lease agreement
 * @param {Object} config - Configuration object with property details and customizations
 * @returns {Promise<Object>} Complete lease agreement with all sections
 */
export async function generateCompleteLease(config) {
  try {
    const {
      propertyAddress,
      landlordName,
      tenantName,
      startDate,
      duration,
      rentAmount,
      securityDeposit,
      customSections = {}
    } = config;

    // Common variables used across sections
    const commonVariables = {
      PROPERTY_ADDRESS: propertyAddress,
      LANDLORD_NAME: landlordName,
      TENANT_NAME: tenantName,
      START_DATE: startDate,
      DURATION: duration,
      RENT_AMOUNT: rentAmount,
      DEPOSIT_AMOUNT: securityDeposit,
      DATE: new Date().toLocaleDateString(),
      END_DATE: calculateEndDate(startDate, duration),
      // Map camelCase config keys to UPPER_SNAKE_CASE placeholders
      DUE_DATE: config.dueDate,
      PAYMENT_METHOD: config.paymentMethod,
      LATE_FEE: config.lateFee,
      GRACE_PERIOD: config.gracePeriod,
      RETURN_DAYS: config.returnDays,
      TENANT_UTILITIES: config.tenantUtilities,
      LANDLORD_UTILITIES: config.landlordUtilities,
      MINOR_REPAIR_LIMIT: config.minorRepairLimit,
      NUMBER_OCCUPANTS: config.numberOccupants,
      PET_DEPOSIT: config.petDeposit,
      PET_RENT: config.petRent,
      NOTICE_HOURS: config.noticeHours,
      TERMINATION_NOTICE: config.terminationNotice,
      DISCLOSURES: config.disclosures,
      INSURANCE_INFO: config.rentersInsurance 
        ? `Tenant has provided proof of insurance: ${config.rentersInsurance.insuranceCompany} (Policy #${config.rentersInsurance.policyNumber}), with $${config.rentersInsurance.coverageAmount.liability?.toLocaleString() || 'N/A'} liability coverage, expiring ${new Date(config.rentersInsurance.expirationDate).toLocaleDateString()}. ${config.rentersInsurance.landlordListedAsInterested ? 'Landlord is listed as an additional interested party.' : 'Landlord must be added as an additional interested party.'}`
        : 'Tenant must provide proof of insurance within 14 days of lease signing and maintain coverage throughout the lease term.'
    };

    const generatedSections = {};

    console.log('[Lease] Common variables:', JSON.stringify(commonVariables, null, 2));

    // Generate each section
    for (const [sectionKey, sectionData] of Object.entries(LEASE_TEMPLATE_SECTIONS)) {
      const customRequirements = customSections[sectionKey] || '';
      
      if (sectionData.customizable && customRequirements) {
        // Use AI to generate customized section
        console.log(`[Lease] Generating AI section for ${sectionKey} with custom requirements`);
        generatedSections[sectionKey] = {
          title: sectionData.title,
          content: await generateCustomSection(
            sectionKey,
            sectionData.baseline,
            customRequirements,
            commonVariables
          )
        };
      } else {
        // Use baseline with variable replacement
        console.log(`[Lease] Using baseline template for ${sectionKey}`);
        const replaced = replaceVariables(sectionData.baseline, commonVariables);
        console.log(`[Lease] ${sectionKey} before replacement:`, sectionData.baseline.substring(0, 200));
        console.log(`[Lease] ${sectionKey} after replacement:`, replaced.substring(0, 200));
        generatedSections[sectionKey] = {
          title: sectionData.title,
          content: replaceVariables(sectionData.baseline, commonVariables)
        };
      }
    }

    return {
      success: true,
      lease: {
        metadata: {
          generatedDate: new Date().toISOString(),
          propertyAddress,
          landlordName,
          tenantName,
          startDate,
          duration,
          rentAmount,
          securityDeposit
        },
        sections: generatedSections
      }
    };
  } catch (error) {
    console.error('Error generating complete lease:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Simple variable replacement helper
 */
function replaceVariables(text, variables) {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `[${key}]`;
    const replacement = value == null ? placeholder : String(value);
    // Escape regex special characters in the placeholder so we match the
    // literal string (placeholders include square brackets which form
    // character classes in regex and caused accidental wide matches).
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, 'g'), replacement);
  }
  return result;
}

/**
 * Calculate lease end date
 */
function calculateEndDate(startDate, durationMonths) {
  try {
    const date = new Date(startDate);
    date.setMonth(date.getMonth() + parseInt(durationMonths));
    return date.toLocaleDateString();
  } catch {
    return '[END_DATE]';
  }
}

/**
 * Generate a legal review/summary of the lease
 */
export async function generateLeaseSummary(leaseContent) {
  try {
    const prompt = `Please provide a brief, bullet-point summary of the key terms in this lease agreement:

${JSON.stringify(leaseContent, null, 2)}

Focus on:
- Lease term and dates
- Rent amount and payment terms
- Security deposit details
- Key responsibilities for landlord and tenant
- Important restrictions or special terms
- Termination/renewal terms

Keep it concise and in plain English for easy understanding.`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes legal documents in plain English.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.5,
      max_tokens: 800
    });

    return {
      success: true,
      summary: completion.choices[0].message.content.trim()
    };
  } catch (error) {
    console.error('Error generating lease summary:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Validate custom requirements for legal compliance (basic checks)
 */
export async function validateCustomRequirements(sectionKey, customText) {
  try {
    const prompt = `As a legal compliance checker for residential leases, review this custom requirement for the "${sectionKey}" section:

"${customText}"

Check for potential issues:
- Fair housing law violations (discrimination)
- Unreasonable or potentially unenforceable terms
- Safety or habitability concerns
- Missing important protections

Provide a brief assessment: "APPROVED" if it seems reasonable, or "REVIEW NEEDED: [reason]" if there are concerns.`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a legal compliance assistant. Provide brief, practical assessments of lease terms.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 300
    });

    const response = completion.choices[0].message.content.trim();
    const approved = response.toUpperCase().startsWith('APPROVED');

    return {
      success: true,
      approved,
      message: response
    };
  } catch (error) {
    console.error('Error validating requirements:', error);
    return {
      success: false,
      approved: true, // Default to approved if validation fails
      message: 'Validation unavailable - proceeding with caution'
    };
  }
}
