import { OFFICIAL_STATUTE_URLS } from '../src/shared/complianceStatuteUrls.js';

/**
 * BRIGHT MLS Region — State & Jurisdiction Landlord-Tenant Law Database
 * 
 * Covers: Maryland, Virginia, Washington D.C., Delaware, Pennsylvania, 
 *         New Jersey, West Virginia
 * 
 * This is a curated baseline of core statutory requirements. The compliance
 * research service supplements this with real-time Google Search + Gemini
 * grounding to catch recent amendments and local ordinances.
 * 
 * IMPORTANT: These values reflect statutes as of early 2026. The real-time
 * search layer validates them against current law during document generation.
 */

// ============================================================================
// MASTER STATE LAW DATABASE
// ============================================================================

export const STATE_LANDLORD_TENANT_LAWS = {
  // =========================================================================
  // MARYLAND
  // =========================================================================
  MD: {
    stateName: 'Maryland',
    governingStatute: 'Maryland Real Property Code, Title 8 — Landlord and Tenant',
    statuteUrl: OFFICIAL_STATUTE_URLS.MD,
    
    securityDeposit: {
      maxAmount: '2 months\' rent',
      maxAmountFormula: (monthlyRent) => monthlyRent * 2,
      holdingRequirements: 'Must be held in a Maryland financial institution in an escrow account. Landlord must provide tenant with a receipt showing the institution name and account type.',
      interestRequired: true,
      interestDetails: 'Deposits held for 6+ months accrue simple interest at the daily U.S. Treasury yield curve rate for 1-year Treasury securities, adjusted January 1 each year. Interest must be paid by crediting toward rent or by direct payment at lease end.',
      returnDeadline: '45 days after termination of tenancy and delivery of possession',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '45 days — must include itemized list of damages with costs',
      penaltyForNonCompliance: 'Landlord forfeits the right to withhold any portion of the deposit and may be liable for up to 3x the withheld amount plus reasonable attorney fees',
      statuteReference: 'Md. Code, Real Prop. §8-203, §8-203.1'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '60 days written notice (for tenancies of at least 1 year that have become month-to-month); 30 days for tenancies under 1 year',
        tenant: '1 month (30 days) written notice'
      },
      fixedTermNotice: 'Unless lease specifies otherwise, no notice required — lease ends on its own terms',
      earlyTerminationRights: 'Active military (SCRA), domestic violence victims with protective order, and certain senior citizens moving to assisted living may terminate early with 30 days notice',
      statuteReference: 'Md. Code, Real Prop. §8-402'
    },

    rentRules: {
      gracePeriod: 'No statutory grace period, but late fees cannot be charged until rent is more than 5 days late (varies by local jurisdiction — Baltimore City and Montgomery County have additional protections)',
      lateFeeMax: '5% of monthly rent (Md. Code, Real Prop. §8-208(d)(3))',
      lateFeeMaxFormula: (monthlyRent) => monthlyRent * 0.05,
      rentControlAreas: 'Montgomery County has voluntary rent guidelines; some municipalities may have rent stabilization — check local ordinances',
      rentIncreaseNotice: 'No statewide requirement for amount or notice period for rent increases on fixed-term renewals, but landlord cannot increase during an active fixed-term lease. For month-to-month, reasonable notice required.',
      statuteReference: 'Md. Code, Real Prop. §8-208'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'For properties built before 1978, landlord must provide EPA lead paint pamphlet, disclose known lead paint/hazards, include lead paint addendum in lease. Maryland has additional registration requirements for pre-1978 rentals.',
        required: true,
        federalRequirement: true,
        statuteReference: 'Md. Code, Envir. §6-801 et seq.; 42 U.S.C. §4852d'
      },
      {
        name: 'Habitability Disclosure / Move-In Inspection',
        description: 'Landlord must provide a written list of existing damages at move-in. Tenant has 15 days to add to the list.',
        required: true,
        statuteReference: 'Md. Code, Real Prop. §8-203.1'
      },
      {
        name: 'Security Deposit Receipt',
        description: 'Must inform tenant of the right to receive a receipt for the security deposit, including the name and address of the financial institution holding it.',
        required: true,
        statuteReference: 'Md. Code, Real Prop. §8-203.1(e)'
      },
      {
        name: 'Landlord Identity Disclosure',
        description: 'Each lease must identify the landlord or the landlord\'s authorized agent and provide an address for receiving notices.',
        required: true,
        statuteReference: 'Md. Code, Real Prop. §8-210'
      },
      {
        name: 'Mold Disclosure',
        description: 'If landlord is aware of mold in the property, must disclose. Montgomery County requires proactive mold disclosure.',
        required: true,
        statuteReference: 'Md. Code, Envir. §6-1001 et seq.'
      },
      {
        name: 'Flood Risk Disclosure',
        description: 'Landlord must disclose if the property is located in a flood zone or has flooded in the past.',
        required: true,
        statuteReference: 'Md. Code, Real Prop. §8-223'
      },
      {
        name: 'Fire Safety / Smoke Detector Disclosure',
        description: 'Landlord must install and maintain smoke detectors and carbon monoxide detectors. Written acknowledgment of working detectors recommended.',
        required: true,
        statuteReference: 'Md. Code, Pub. Safety §9-102'
      },
      {
        name: 'Notice of Tenant Rights',
        description: 'Montgomery County: must provide "Tenants Rights" pamphlet. Other jurisdictions may have similar requirements.',
        required: false,
        localRequirement: true,
        statuteReference: 'Montgomery County Code §29-27'
      }
    ],

    landlordEntry: {
      noticeRequired: '24 hours reasonable notice',
      emergencyException: true,
      permittedPurposes: 'Inspections, repairs, showing to prospective tenants/purchasers, and emergencies',
      statuteReference: 'Md. Code, Real Prop. §8-216.1 (effective 2025)'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Landlord must maintain premises in a habitable condition, including working plumbing, heating, electrical, structural integrity, weather-tight roof/walls, and compliance with housing codes.',
      tenantRemedies: ['Rent escrow (tenant deposits rent with court)', 'Repair and deduct (limited circumstances)', 'Lease termination if conditions are severe'],
      statuteReference: 'Md. Code, Real Prop. §8-211'
    },

    eviction: {
      nonpaymentProcess: 'File Failure to Pay Rent complaint in District Court. Tenant has 4 days after judgment to pay and avoid eviction. If tenant pays in full, case is dismissed.',
      holdoverProcess: 'File Tenant Holding Over complaint after lease expires. Must give proper notice first.',
      breachOfLeaseProcess: 'File Breach of Lease complaint. Must give 30 days notice to cure for curable violations (14 days in certain cases).',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Landlord may not retaliate against tenant for exercising legal rights, filing complaints, or joining tenant organizations for 6 months after protected activity',
      statuteReference: 'Md. Code, Real Prop. §8-401 et seq.'
    },

    localJurisdictions: {
      'Montgomery County': {
        additionalRules: [
          'Rent stabilization guidelines (voluntary)',
          'Just-cause eviction protections',
          'Mandatory tenants\' rights pamphlet',
          'Additional mold disclosure requirements',
          'TOPA (Tenant Opportunity to Purchase Act) — tenants have right of first refusal when property is sold'
        ],
        statuteReference: 'Montgomery County Code, Chapter 29'
      },
      'Prince George\'s County': {
        additionalRules: [
          'Rental licensing required',
          'Additional tenant protections for certain rent increases',
          'Right of first refusal (TOPA) for tenant purchase'
        ],
        statuteReference: 'Prince George\'s County Code, Subtitle 13'
      },
      'Baltimore City': {
        additionalRules: [
          'Rental registration and licensing required',
          'Lead paint compliance certificates required',
          'Good cause eviction protections',
          'Right to counsel for tenants in eviction proceedings',
          'Additional fair housing protections'
        ],
        statuteReference: 'Baltimore City Code, Art. 13'
      }
    },

    requiredLeaseProvisions: [
      'Names of all parties (landlord, tenant, authorized agents)',
      'Property address and description',
      'Lease term (start and end dates)',
      'Rent amount, due date, payment methods',
      'Security deposit amount, holding institution, return conditions',
      'Late fee terms (cannot exceed 5% of monthly rent)',
      'Landlord\'s obligation to maintain habitability',
      'Tenant\'s obligation to maintain premises and report repairs',
      'Right of entry provisions (24-hour notice)',
      'Termination and renewal provisions',
      'Lead paint disclosure (pre-1978 properties)',
      'Mold disclosure if known',
      'Flood zone disclosure',
      'Smoke/CO detector disclosure',
      'Tenant\'s right to escrow rent for habitability issues',
      'Anti-retaliation notice',
      'Governing law clause (State of Maryland)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // VIRGINIA
  // =========================================================================
  VA: {
    stateName: 'Virginia',
    governingStatute: 'Virginia Residential Landlord and Tenant Act (VRLTA), Va. Code §55.1-1200 et seq.',
    statuteUrl: OFFICIAL_STATUTE_URLS.VA,

    securityDeposit: {
      maxAmount: '2 months\' rent',
      maxAmountFormula: (monthlyRent) => monthlyRent * 2,
      holdingRequirements: 'No specific escrow requirement, but must be held in a separate interest-bearing or non-interest-bearing account in a Virginia bank or savings institution',
      interestRequired: false,
      interestDetails: 'Not required unless local ordinance mandates it',
      returnDeadline: '45 days after termination of tenancy (or move-out)',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '45 days — itemized list of deductions with remaining balance',
      penaltyForNonCompliance: 'Landlord may be liable for the full deposit amount plus interest and reasonable attorney fees if deposit not returned or itemized within deadline',
      statuteReference: 'Va. Code §55.1-1226'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '30 days written notice',
        tenant: '30 days written notice'
      },
      fixedTermNotice: 'Lease ends on its own terms unless auto-renewal provision requires notice to terminate',
      earlyTerminationRights: 'Active duty military (SCRA), victims of family abuse with protective order, and certain cases involving uninhabitable conditions',
      statuteReference: 'Va. Code §55.1-1253'
    },

    rentRules: {
      gracePeriod: '5 days — landlord may not impose a late fee until rent is 5 or more days late',
      lateFeeMax: 'The lesser of 10% of monthly rent or 10% of the balance due (for periodic rent). Cannot charge a late fee if rent is less than 5 days late.',
      lateFeeMaxFormula: (monthlyRent) => monthlyRent * 0.10,
      rentControlAreas: 'Virginia has statewide preemption of rent control — no locality may impose rent control',
      rentIncreaseNotice: 'For month-to-month tenancies, landlord must provide 30 days written notice of rent increase',
      statuteReference: 'Va. Code §55.1-1204'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'For properties built before 1978 (federal requirement)',
        required: true,
        federalRequirement: true,
        statuteReference: '42 U.S.C. §4852d; Va. Code §55.1-1218'
      },
      {
        name: 'Move-In Inspection Report',
        description: 'Landlord must make a written report of the move-in condition within 5 days of move-in and provide it to the tenant. Tenant must sign within 5 days of receipt or it is deemed accepted.',
        required: true,
        statuteReference: 'Va. Code §55.1-1214'
      },
      {
        name: 'Landlord/Agent Disclosure',
        description: 'Must disclose the name and address of the property manager and the owner or person authorized to act on owner\'s behalf in the lease or a written notice prior to occupancy.',
        required: true,
        statuteReference: 'Va. Code §55.1-1216'
      },
      {
        name: 'Mold Disclosure',
        description: 'Landlord must disclose any visible mold in the dwelling unit. Lease must include notice that tenant may terminate if mold poses a health threat and landlord does not remediate.',
        required: true,
        statuteReference: 'Va. Code §55.1-1215'
      },
      {
        name: 'Military Air Installation Zone',
        description: 'Must disclose if property is in a noise zone or accident potential zone near a military installation',
        required: true,
        statuteReference: 'Va. Code §55.1-1217'
      },
      {
        name: 'Defective Drywall Disclosure',
        description: 'Must disclose presence of defective drywall if known',
        required: true,
        statuteReference: 'Va. Code §55.1-1218'
      },
      {
        name: 'Ratio Utility Billing (RUBS) Disclosure',
        description: 'If landlord uses ratio utility billing, must disclose the formula and calculation method',
        required: true,
        statuteReference: 'Va. Code §55.1-1212'
      },
      {
        name: 'Notice of Rights and Remedies',
        description: 'Landlord must provide tenant with a statement of tenant rights and responsibilities as established by VRLTA',
        required: true,
        statuteReference: 'Va. Code §55.1-1204(C)'
      }
    ],

    landlordEntry: {
      noticeRequired: '24 hours reasonable notice; 72 hours for non-emergency entry in certain jurisdictions',
      emergencyException: true,
      permittedPurposes: 'Inspections, necessary or agreed repairs, decorations, alterations, improvements, supplying services, exhibiting the dwelling to purchasers/tenants/workers/contractors',
      statuteReference: 'Va. Code §55.1-1229'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Landlord must comply with building and housing codes materially affecting health and safety, make all repairs necessary to keep premises in fit and habitable condition, maintain all electrical, plumbing, sanitary, heating, ventilating, AC, and other facilities/appliances in good working order.',
      tenantRemedies: ['Written notice to landlord with reasonable time to repair', 'Rent escrow with the court if landlord fails to correct', 'Terminate lease after proper notice if conditions are severe'],
      statuteReference: 'Va. Code §55.1-1220'
    },

    eviction: {
      nonpaymentProcess: '5 days past due, serve 5-day Pay or Quit notice. If unpaid, file Unlawful Detainer in General District Court.',
      holdoverProcess: 'Serve written notice to vacate, then file Unlawful Detainer action.',
      breachOfLeaseProcess: '21-day notice to cure for remediable violations; 30-day notice for non-remediable violations.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Landlord may not retaliate within 12 months for tenant exercising legal rights, complaining to government agencies, or organizing.',
      statuteReference: 'Va. Code §55.1-1243 et seq.'
    },

    localJurisdictions: {},

    requiredLeaseProvisions: [
      'Names and addresses of landlord, managing agent, and authorized persons',
      'Property address and unit description',
      'Lease term (start, end, renewal terms)',
      'Rent amount, due date, acceptable payment methods, and location for payment',
      'Security deposit amount and terms per §55.1-1226',
      'Late fee terms (cannot exceed VRLTA limits)',
      'Landlord maintenance obligations under VRLTA',
      'Tenant maintenance obligations',
      'Right of entry terms (24-hour notice minimum)',
      'Move-in inspection procedure',
      'Mold disclosure and remediation rights',
      'Lead paint disclosure (pre-1978)',
      'Military installation noise zone disclosure (if applicable)',
      'Statement of tenant rights under VRLTA',
      'Termination provisions consistent with VRLTA',
      'Anti-retaliation clause',
      'Governing law (Commonwealth of Virginia)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // WASHINGTON, D.C.
  // =========================================================================
  DC: {
    stateName: 'District of Columbia',
    governingStatute: 'D.C. Code, Title 42, Chapter 32 — Landlord-Tenant; D.C. Rental Housing Act of 1985',
    statuteUrl: OFFICIAL_STATUTE_URLS.DC,

    securityDeposit: {
      maxAmount: '1 month\'s rent',
      maxAmountFormula: (monthlyRent) => monthlyRent * 1,
      holdingRequirements: 'Must be deposited in an interest-bearing escrow account in a D.C. financial institution within 30 business days of receipt',
      interestRequired: true,
      interestDetails: 'Interest accrues from date of deposit. Landlord must pay accrued interest to tenant annually or apply it as credit toward rent.',
      returnDeadline: '45 days after termination of tenancy',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '45 days — must include itemized statement of deductions',
      penaltyForNonCompliance: 'Treble (3x) the deposit amount if landlord acts in bad faith',
      statuteReference: 'D.C. Code §42-3502.17'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '30 days written notice (but D.C. has strong just-cause eviction protections — landlord must have a qualifying reason to terminate)',
        tenant: '30 days written notice'
      },
      fixedTermNotice: 'Lease ends on its terms, but D.C. has automatic month-to-month conversion — tenant cannot be forced out merely because the lease expired without just cause',
      earlyTerminationRights: 'Active military (SCRA), domestic violence/stalking with court order, uninhabitable conditions after notice',
      statuteReference: 'D.C. Code §42-3505.01'
    },

    rentRules: {
      gracePeriod: '5 days — late fees cannot be assessed until rent is more than 5 days late (D.C. Code §42-3505.31)',
      lateFeeMax: '5% of monthly rent',
      lateFeeMaxFormula: (monthlyRent) => monthlyRent * 0.05,
      rentControlAreas: 'D.C. has RENT CONTROL. Most rental units built before 1976 and not owned by a small landlord (4 or fewer units) are covered. Rent increases limited to CPI + 2% for standard adjustments, CPI + 5% for elderly/disabled tenants. Voluntary agreements and hardship petitions allow higher increases.',
      rentIncreaseNotice: '30 days written notice required; rent-controlled units must file with DHCD Rental Accommodations Division',
      statuteReference: 'D.C. Code §42-3502.06 et seq.'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'Federal requirement for pre-1978 properties. D.C. has additional lead-safe requirements and mandatory testing.',
        required: true,
        federalRequirement: true,
        statuteReference: 'D.C. Code §8-231.01 et seq.'
      },
      {
        name: 'Rental Accommodation Registration',
        description: 'Landlord must register rental property with the D.C. Rental Accommodations Division and provide tenant with the registration number.',
        required: true,
        statuteReference: 'D.C. Code §42-3502.05'
      },
      {
        name: 'Rent Control Status',
        description: 'Must disclose whether the unit is subject to rent control and, if exempt, the basis for exemption.',
        required: true,
        statuteReference: 'D.C. Code §42-3502.05(f)'
      },
      {
        name: 'Housing Code Violations',
        description: 'Must disclose any outstanding housing code violations',
        required: true,
        statuteReference: 'D.C. Code §42-3502.05(f)'
      },
      {
        name: 'Tenant Bill of Rights',
        description: 'D.C. landlords must provide tenants with the OTA Tenant Bill of Rights handbook at or before lease signing.',
        required: true,
        statuteReference: 'D.C. Code §42-3502.22'
      },
      {
        name: 'Flood Risk Disclosure',
        description: 'Must disclose if the property has experienced flooding or is in a flood zone',
        required: true,
        statuteReference: 'D.C. Act 24-454'
      }
    ],

    landlordEntry: {
      noticeRequired: '48 hours advance written notice',
      emergencyException: true,
      permittedPurposes: 'Inspections, repairs, showing to prospective tenants/purchasers. Must be during reasonable hours.',
      statuteReference: 'D.C. Code §42-3505.51'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Strong implied warranty of habitability. D.C. housing code is comprehensive. Landlord must maintain all systems, provide adequate heat (68°F Oct 1–May 1), hot water, and comply with all housing regulations.',
      tenantRemedies: ['Report to DCRA for inspection and enforcement', 'Rent withholding after proper notice', 'Repair and deduct for minor repairs', 'Lease termination for severe conditions', 'Tenant right to organize'],
      statuteReference: 'D.C. Code §42-3251 et seq.'
    },

    eviction: {
      nonpaymentProcess: 'Serve 30-day notice to pay or quit. File in D.C. Superior Court, Landlord-Tenant Branch. Tenant has robust defenses including housing code violations.',
      holdoverProcess: 'D.C. requires JUST CAUSE for eviction even after lease expiration. Qualifying reasons include: personal use by owner, major renovation, discontinuance of housing, court-ordered sale.',
      breachOfLeaseProcess: '30-day notice to cure. For drug-related activity, 3-day notice.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Strong anti-retaliation protections. Landlord may not retaliate for 12 months for exercising rights, reporting violations, or organizing.',
      statuteReference: 'D.C. Code §42-3505.01 et seq.'
    },

    localJurisdictions: {},

    requiredLeaseProvisions: [
      'Names and addresses of landlord and authorized agents',
      'Property address and unit number',
      'Lease term with clear start and end dates',
      'Rent amount, due date, payment methods',
      'Security deposit terms (max 1 month, escrow account details)',
      'Rent control status disclosure',
      'DHCD registration number',
      'Late fee terms (max 5%, no fee for first 5 days)',
      'Landlord maintenance obligations per D.C. Housing Code',
      'Right of entry terms (48-hour minimum notice)',
      'Lead paint disclosure (pre-1978)',
      'Flood risk disclosure',
      'Housing code violation disclosure',
      'Tenant Bill of Rights acknowledgment',
      'Anti-retaliation clause',
      'Just-cause eviction requirements notice',
      'Tenant right to organize',
      'Governing law (District of Columbia)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // DELAWARE
  // =========================================================================
  DE: {
    stateName: 'Delaware',
    governingStatute: 'Delaware Landlord-Tenant Code, Del. Code Title 25, Chapter 55',
    statuteUrl: OFFICIAL_STATUTE_URLS.DE,

    securityDeposit: {
      maxAmount: '1 month\'s rent (no pet deposit may exceed 1 month\'s rent; total deposit capped at 1 month for leases of 1+ year, or total of first and last month for month-to-month)',
      maxAmountFormula: (monthlyRent) => monthlyRent * 1,
      holdingRequirements: 'Must be held in an escrow account in a federally insured financial institution in Delaware. Landlord must provide tenant with the account location.',
      interestRequired: false,
      interestDetails: 'Not required, but if landlord holds deposit in interest-bearing account, interest belongs to the tenant',
      returnDeadline: '20 days after termination of tenancy',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '20 days — itemized list of deductions required',
      penaltyForNonCompliance: 'Double (2x) the amount wrongfully withheld plus court costs',
      statuteReference: 'Del. Code Title 25, §5514'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '60 days written notice',
        tenant: '60 days written notice'
      },
      fixedTermNotice: 'No notice required — lease ends on its own terms',
      earlyTerminationRights: 'Active military (SCRA), victims of domestic violence with protective order, premises destroyed or condemned',
      statuteReference: 'Del. Code Title 25, §5106'
    },

    rentRules: {
      gracePeriod: '5 days — late fee cannot be charged until rent is more than 5 days late',
      lateFeeMax: '5% of monthly rent (after 5-day grace period)',
      lateFeeMaxFormula: (monthlyRent) => monthlyRent * 0.05,
      rentControlAreas: 'Delaware has no rent control',
      rentIncreaseNotice: '60 days written notice for month-to-month tenancies',
      statuteReference: 'Del. Code Title 25, §5501'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'Federal requirement for pre-1978 properties',
        required: true,
        federalRequirement: true,
        statuteReference: '42 U.S.C. §4852d'
      },
      {
        name: 'Owner/Agent Disclosure',
        description: 'Must disclose the name(s) and address(es) of landlord and any agent authorized to manage the property',
        required: true,
        statuteReference: 'Del. Code Title 25, §5105'
      },
      {
        name: 'Damage Disclosure at Move-In',
        description: 'Landlord must inform tenant of their right to inspect the premises and prepare a list of pre-existing damages within 15 days of move-in',
        required: true,
        statuteReference: 'Del. Code Title 25, §5502(c)'
      },
      {
        name: 'Summary of Landlord-Tenant Code',
        description: 'Landlord must provide tenant with a summary of the Delaware Landlord-Tenant Code or a copy of the code itself',
        required: true,
        statuteReference: 'Del. Code Title 25, §5118'
      }
    ],

    landlordEntry: {
      noticeRequired: '48 hours advance notice (2 days)',
      emergencyException: true,
      permittedPurposes: 'Inspections, repairs, alterations, improvements, supplying agreed services, exhibiting the unit. Must be at reasonable times.',
      statuteReference: 'Del. Code Title 25, §5509(b)'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Landlord must maintain premises in compliance with building and housing codes, keep common areas clean and safe, maintain plumbing, heating, electricity, hot water, and all provided appliances.',
      tenantRemedies: ['Written notice with reasonable time to repair', 'Rent escrow through the court', 'Terminate lease after proper notice for severe conditions', 'Report to local housing inspector'],
      statuteReference: 'Del. Code Title 25, §5305'
    },

    eviction: {
      nonpaymentProcess: '5-day notice to pay or quit. File Summary Possession action in Justice of the Peace Court.',
      holdoverProcess: '60-day notice for month-to-month; file in JP Court.',
      breachOfLeaseProcess: '7-day notice to cure for remediable violations.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Landlord may not retaliate for filing complaints, organizing tenants, or exercising legal rights.',
      statuteReference: 'Del. Code Title 25, §5516'
    },

    localJurisdictions: {},

    requiredLeaseProvisions: [
      'Names and addresses of landlord and authorized agents',
      'Property address and description',
      'Lease term (start and end dates)',
      'Rent amount, due date, and acceptable payment methods',
      'Security deposit amount and escrow account information',
      'Late fee terms (max 5%, 5-day grace period)',
      'Landlord maintenance obligations under Landlord-Tenant Code',
      'Tenant maintenance and repair notification obligations',
      'Right of entry terms (48-hour advance notice)',
      'Lead paint disclosure (pre-1978)',
      'Summary of Delaware Landlord-Tenant Code or statement of availability',
      'Termination provisions',
      'Governing law (State of Delaware)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // PENNSYLVANIA
  // =========================================================================
  PA: {
    stateName: 'Pennsylvania',
    governingStatute: 'Pennsylvania Landlord and Tenant Act of 1951, 68 P.S. §250.101 et seq.',
    statuteUrl: OFFICIAL_STATUTE_URLS.PA,

    securityDeposit: {
      maxAmount: '2 months\' rent for the first year; 1 month\'s rent for subsequent years',
      maxAmountFormula: (monthlyRent, isFirstYear = true) => isFirstYear ? monthlyRent * 2 : monthlyRent * 1,
      holdingRequirements: 'Deposits over $100 held for 2+ years must be placed in an escrow account at a federally or state-regulated financial institution. Landlord must provide the account name, address, and amount deposited.',
      interestRequired: true,
      interestDetails: 'After 2 years, tenant is entitled to accrued interest minus 1% administrative fee retained by landlord.',
      returnDeadline: '30 days after termination of the lease or surrender of the premises',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '30 days — must provide written list of damages with costs. If not provided, landlord forfeits right to withhold.',
      penaltyForNonCompliance: 'Double (2x) the amount improperly withheld if landlord fails to provide itemized list within 30 days',
      statuteReference: '68 P.S. §250.511a, §250.512'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '15 days written notice (for tenancy of 1 year or less); 30 days for tenancy over 1 year',
        tenant: '15 days notice (tenancy of 1 year or less); 30 days for over 1 year'
      },
      fixedTermNotice: 'No notice required unless lease specifies',
      earlyTerminationRights: 'Active military (SCRA), domestic violence victims (Act 200 of 2019 — allows termination with 30 days notice and documentation)',
      statuteReference: '68 P.S. §250.501'
    },

    rentRules: {
      gracePeriod: 'No statutory grace period statewide (Philadelphia has a 10-day grace period)',
      lateFeeMax: 'No statutory cap statewide, but late fees must be reasonable. Philadelphia limits late fees to $25 or 5% of monthly rent, whichever is less.',
      lateFeeMaxFormula: null,
      rentControlAreas: 'Pennsylvania generally preempts local rent control (except Philadelphia retains some authority via home rule)',
      rentIncreaseNotice: 'No statutory notice requirement for rent increases at lease renewal. For month-to-month, reasonable notice expected.',
      statuteReference: '68 P.S. §250.501 et seq.'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'Federal requirement for pre-1978 properties',
        required: true,
        federalRequirement: true,
        statuteReference: '42 U.S.C. §4852d'
      },
      {
        name: 'Agent/Manager Identity',
        description: 'Must disclose the name and address of the owner and any person authorized to manage the premises and accept service of process',
        required: true,
        statuteReference: '68 P.S. §250.512.1'
      },
      {
        name: 'Security Deposit Escrow Information',
        description: 'Must provide tenant with a receipt and written notice of the financial institution where deposit is held (for deposits over $100 held 2+ years)',
        required: true,
        statuteReference: '68 P.S. §250.511a'
      }
    ],

    landlordEntry: {
      noticeRequired: 'Reasonable notice (no specific statutory time period, but 24 hours is the accepted standard)',
      emergencyException: true,
      permittedPurposes: 'Inspections, repairs, and emergencies. Pennsylvania does not have a detailed entry statute — governed by lease terms and common law.',
      statuteReference: 'Common law; lease terms control'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Implied warranty of habitability applies. Landlord must maintain the premises in a safe, sanitary, and habitable condition per local housing codes and common law.',
      tenantRemedies: ['Repair and deduct (with proper notice)', 'Rent withholding/escrow in certain municipalities', 'Lease termination for severe habitability failures', 'Report to local code enforcement'],
      statuteReference: 'Pugh v. Holmes, 486 Pa. 272 (1979)'
    },

    eviction: {
      nonpaymentProcess: '10-day notice to quit (for leases of 1 year or less). File complaint in Magisterial District Court.',
      holdoverProcess: '15 or 30-day notice depending on lease length. File Landlord-Tenant complaint.',
      breachOfLeaseProcess: '15 or 30-day notice to quit depending on lease length. Specific cure periods depend on lease terms.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Landlord may not retaliate against tenant for reporting code violations, joining tenant organization, or exercising legal rights.',
      statuteReference: '68 P.S. §250.205-A'
    },

    localJurisdictions: {
      'Philadelphia': {
        additionalRules: [
          'Good cause eviction required (Fair Practices Ordinance)',
          'Rental licensing required',
          '10-day grace period before late fees',
          'Late fees limited to $25 or 5% of rent (whichever is less)',
          'Partners for Good Housing pamphlet must be provided',
          'Lead certification and disclosure required',
          'Right to counsel in eviction proceedings (if funded)',
          'City business income and receipts tax on rental income'
        ],
        statuteReference: 'Philadelphia Code, Title 9'
      },
      'Pittsburgh': {
        additionalRules: [
          'Rental registration required',
          'Lead-safe certification for pre-1978 properties',
          'Additional tenant protections in city code'
        ],
        statuteReference: 'Pittsburgh Code, Chapter 907'
      }
    },

    requiredLeaseProvisions: [
      'Names and addresses of landlord and authorized agents',
      'Property address and description',
      'Lease term (start and end dates)',
      'Rent amount, due date, and acceptable payment methods',
      'Security deposit terms (max 2 months first year, 1 month thereafter)',
      'Security deposit escrow information (required for deposits over $100 after 2 years)',
      'Late fee terms',
      'Landlord maintenance obligations',
      'Tenant maintenance obligations',
      'Right of entry provisions',
      'Lead paint disclosure (pre-1978)',
      'Termination provisions consistent with PA law',
      'Governing law (Commonwealth of Pennsylvania)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // NEW JERSEY
  // =========================================================================
  NJ: {
    stateName: 'New Jersey',
    governingStatute: 'New Jersey Anti-Eviction Act, N.J.S.A. 2A:18-61.1 et seq.; Security Deposit Act, N.J.S.A. 46:8-19 et seq.',
    statuteUrl: OFFICIAL_STATUTE_URLS.NJ,

    securityDeposit: {
      maxAmount: '1.5 months\' rent',
      maxAmountFormula: (monthlyRent) => monthlyRent * 1.5,
      holdingRequirements: 'Must be deposited in an interest-bearing escrow account in a New Jersey bank, savings bank, or savings and loan association. OR invested in a State-approved money market fund. Landlord must notify tenant in writing within 30 days of receiving the deposit of the account name, address, and amount deposited.',
      interestRequired: true,
      interestDetails: 'Interest accrues from date of deposit. Landlord must pay accrued interest to tenant annually, either as cash or as a credit toward rent. Alternatively, may invest in a money market fund.',
      returnDeadline: '30 days after termination of the lease or tenant vacating',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '30 days — must provide itemized list of damages with costs. Tenant may also request a copy of the move-out inspection.',
      penaltyForNonCompliance: 'Tenant may sue for double (2x) the amount wrongfully withheld plus attorney fees and court costs',
      statuteReference: 'N.J.S.A. 46:8-19 et seq.'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: 'New Jersey is a JUST CAUSE state — landlord cannot terminate without one of the statutory good causes (non-payment, disorderly conduct, lease violation, etc.). Notice periods vary by cause.',
        tenant: '1 full calendar month notice (given before the start of the month)'
      },
      fixedTermNotice: 'Lease auto-converts to month-to-month at expiration. Landlord cannot refuse to renew without just cause.',
      earlyTerminationRights: 'Active military (SCRA), domestic violence victims (Safe Housing Act), senior citizens moving to nursing care, certain disabled persons',
      statuteReference: 'N.J.S.A. 2A:18-61.1 et seq.'
    },

    rentRules: {
      gracePeriod: '5 days — the Truth in Renting Act requires a 5-business-day grace period before late fees can be assessed',
      lateFeeMax: 'No statutory maximum, but must be reasonable. Generally accepted standard is 5-10% of monthly rent. The Department of Community Affairs may set limits.',
      lateFeeMaxFormula: null,
      rentControlAreas: 'Many NJ municipalities have rent control ordinances (including Newark, Jersey City, Hoboken, Elizabeth, etc.). No statewide rent control, but no statewide preemption either — each municipality can adopt its own.',
      rentIncreaseNotice: '30 days written notice for month-to-month tenancies. Rent-controlled municipalities have their own limits and procedures.',
      statuteReference: 'N.J.S.A. 46:8-4 (Truth in Renting Act)'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'Federal requirement for pre-1978 properties. New Jersey has enhanced lead paint requirements including lead-safe certificates.',
        required: true,
        federalRequirement: true,
        statuteReference: 'N.J.S.A. 52:27D-437.1 et seq.'
      },
      {
        name: 'Truth in Renting Statement',
        description: 'Landlord must provide tenant with a copy of the DCA Truth in Renting guide at lease signing or within 30 days of move-in',
        required: true,
        statuteReference: 'N.J.S.A. 46:8-44'
      },
      {
        name: 'Window Guard Notice',
        description: 'Must provide written notice about the availability of window guards for tenants with children under 10 (multi-family buildings)',
        required: true,
        statuteReference: 'N.J.A.C. 5:10-27.1'
      },
      {
        name: 'Flood Zone Disclosure',
        description: 'Must disclose if property is in a flood zone',
        required: true,
        statuteReference: 'N.J.S.A. 46:8-50'
      },
      {
        name: 'Security Deposit Account Notice',
        description: 'Must provide written notice within 30 days of deposit receipt identifying the bank name, address, type of account, and current interest rate',
        required: true,
        statuteReference: 'N.J.S.A. 46:8-19'
      },
      {
        name: 'Fire Safety Information',
        description: 'Multi-family dwellings must provide fire safety information',
        required: true,
        statuteReference: 'N.J.A.C. 5:70-2.3'
      }
    ],

    landlordEntry: {
      noticeRequired: 'Reasonable notice (no specific statutory time, but 24 hours is the accepted standard in case law)',
      emergencyException: true,
      permittedPurposes: 'Inspections, repairs, showing to prospective tenants at end of lease term, emergencies',
      statuteReference: 'Case law; lease terms control'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Strong implied warranty of habitability. Landlord must maintain premises in compliance with local building and housing codes and provide essential services (heat, hot water, plumbing, electricity).',
      tenantRemedies: ['Rent withholding after code enforcement complaint', 'Repair and deduct for minor issues', 'Lease termination for severe uninhabitable conditions', 'DCA complaint', 'Organizing tenant association'],
      statuteReference: 'Marini v. Ireland (1970); N.J.S.A. 2A:42-85 et seq.'
    },

    eviction: {
      nonpaymentProcess: 'Serve 30-day notice to quit for nonpayment (or 3 days after judgment). File Summary Dispossess action in Special Civil Part.',
      holdoverProcess: 'NJ does NOT allow no-cause eviction. Landlord must have one of the 18 statutory just-cause grounds under the Anti-Eviction Act.',
      breachOfLeaseProcess: 'Notice to cease the objectionable conduct. If repeated, give notice to quit and file for eviction.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Strong anti-retaliation provisions. Landlord may not retaliate for tenant exercising rights, filing DCA complaints, or organizing.',
      statuteReference: 'N.J.S.A. 2A:18-61.1 et seq.'
    },

    localJurisdictions: {
      'Newark': {
        additionalRules: [
          'Rent control in effect',
          'Additional tenant protections',
          'Rental registration required'
        ]
      },
      'Jersey City': {
        additionalRules: [
          'Rent control ordinance',
          'Fair Chance Housing (ban inquiring about criminal history)',
          'Additional tenant protections'
        ]
      }
    },

    requiredLeaseProvisions: [
      'Names and addresses of landlord and authorized agents',
      'Property address and unit description',
      'Lease term (start and end dates)',
      'Rent amount, due date, payment methods',
      'Security deposit amount and escrow account details (max 1.5 months)',
      'Late fee terms (must be reasonable, 5 business-day grace period)',
      'Truth in Renting acknowledgment',
      'Landlord maintenance obligations',
      'Tenant maintenance obligations',
      'Right of entry provisions',
      'Lead paint disclosure (pre-1978)',
      'Flood zone disclosure',
      'Window guard notice (multi-family)',
      'Anti-retaliation clause',
      'Just-cause eviction provisions notice',
      'Governing law (State of New Jersey)',
      'Signature blocks with dates'
    ]
  },

  // =========================================================================
  // WEST VIRGINIA
  // =========================================================================
  WV: {
    stateName: 'West Virginia',
    governingStatute: 'West Virginia Residential Landlord-Tenant Act, W. Va. Code §37-6A-1 et seq. (applies to certain municipalities that have adopted it); Common law and W. Va. Code §37-6-5 for areas that have not adopted it.',
    statuteUrl: OFFICIAL_STATUTE_URLS.WV,

    securityDeposit: {
      maxAmount: 'No statutory maximum (WVRLTA areas may follow different rules)',
      maxAmountFormula: null,
      holdingRequirements: 'No specific escrow requirements under state law, but deposits should be held separately from landlord\'s personal funds. WVRLTA jurisdictions may have additional requirements.',
      interestRequired: false,
      interestDetails: 'Not required under state law',
      returnDeadline: '60 days after termination of tenancy or tenant vacating (whichever is later)',
      itemizedStatementRequired: true,
      itemizedStatementDeadline: '60 days — must provide itemized statement of deductions',
      penaltyForNonCompliance: 'Landlord may be liable for the full deposit amount plus reasonable attorney fees if improperly withheld',
      statuteReference: 'W. Va. Code §37-6A-2 (WVRLTA jurisdictions)'
    },

    leaseTermination: {
      monthToMonthNotice: {
        landlord: '1 month (30 days) notice in WVRLTA jurisdictions; otherwise by terms of tenancy',
        tenant: '1 month (30 days) notice'
      },
      fixedTermNotice: 'Lease ends on its own terms',
      earlyTerminationRights: 'Active military (SCRA), victim of domestic violence',
      statuteReference: 'W. Va. Code §37-6-5'
    },

    rentRules: {
      gracePeriod: 'No statutory grace period',
      lateFeeMax: 'No statutory cap. Must be reasonable and specified in the lease.',
      lateFeeMaxFormula: null,
      rentControlAreas: 'No rent control in West Virginia',
      rentIncreaseNotice: 'No specific statutory notice requirement. Landlord must wait until lease renewal or give reasonable notice for month-to-month.',
      statuteReference: 'Common law; W. Va. Code §37-6-5'
    },

    requiredDisclosures: [
      {
        name: 'Lead Paint Disclosure',
        description: 'Federal requirement for pre-1978 properties',
        required: true,
        federalRequirement: true,
        statuteReference: '42 U.S.C. §4852d'
      },
      {
        name: 'Landlord/Agent Identity',
        description: 'Must disclose the name and address of the person authorized to manage the property and receive notices',
        required: true,
        statuteReference: 'W. Va. Code §37-6A-2(d)'
      }
    ],

    landlordEntry: {
      noticeRequired: 'Reasonable notice (no specific statutory time period — 24 hours is the recommended standard)',
      emergencyException: true,
      permittedPurposes: 'Reasonable access for repairs, inspections, and emergencies',
      statuteReference: 'Common law; lease terms typically control'
    },

    habitabilityStandards: {
      impliedWarranty: true,
      description: 'Implied warranty of habitability applies under West Virginia common law and WVRLTA. Landlord must maintain premises in safe and habitable condition, comply with housing codes, and maintain essential services.',
      tenantRemedies: ['Notice to landlord with reasonable time to repair', 'Report to local code enforcement', 'Potential lease termination for severe conditions'],
      statuteReference: 'Teller v. McCoy, 162 W.Va. 367 (1978)'
    },

    eviction: {
      nonpaymentProcess: 'Serve notice as specified in lease (no statutory minimum period — but reasonable notice required). File in Magistrate Court.',
      holdoverProcess: 'File wrongful occupation action in Magistrate Court after lease expires and tenant refuses to leave.',
      breachOfLeaseProcess: 'Serve notice per lease terms. File in Magistrate Court.',
      prohibitedRetaliatory: true,
      retaliationProtection: 'Retaliatory eviction prohibited in WVRLTA jurisdictions.',
      statuteReference: 'W. Va. Code §37-6-5; §55-3A-1 et seq.'
    },

    localJurisdictions: {},

    requiredLeaseProvisions: [
      'Names and addresses of landlord and authorized agents',
      'Property address and description',
      'Lease term (start and end dates)',
      'Rent amount, due date, and payment methods',
      'Security deposit amount and return conditions',
      'Late fee terms (if applicable)',
      'Landlord maintenance obligations',
      'Tenant maintenance obligations',
      'Right of entry provisions',
      'Lead paint disclosure (pre-1978)',
      'Termination provisions',
      'Governing law (State of West Virginia)',
      'Signature blocks with dates'
    ]
  }
};

// ============================================================================
// FEDERAL REQUIREMENTS (apply to all states)
// ============================================================================

export const FEDERAL_REQUIREMENTS = {
  leadPaintDisclosure: {
    name: 'Lead-Based Paint Disclosure (42 U.S.C. §4852d)',
    applies: 'All residential properties built before 1978',
    requirements: [
      'Provide EPA-approved pamphlet "Protect Your Family From Lead in Your Home"',
      'Disclose any known lead-based paint or lead-based paint hazards',
      'Provide any available reports or records relating to lead-based paint',
      'Include a Lead Warning Statement in the lease with tenant signature/initials',
      'Allow 10-day opportunity for tenant to conduct lead paint inspection before becoming obligated under the lease'
    ],
    penaltyForNonCompliance: 'Up to $19,507 per violation (adjusted for inflation); treble damages in private lawsuits; criminal penalties for willful violations',
    statuteReference: '42 U.S.C. §4852d; 24 CFR Part 35; 40 CFR Part 745'
  },

  fairHousing: {
    name: 'Fair Housing Act (42 U.S.C. §3601–3619)',
    protectedClasses: ['Race', 'Color', 'National Origin', 'Religion', 'Sex (including sexual orientation and gender identity)', 'Familial Status', 'Disability'],
    requirements: [
      'No discrimination in rental advertising, application, terms, or conditions',
      'Reasonable accommodations for disabled tenants',
      'No steering or discriminatory pricing',
      'No retaliation against fair housing complainants'
    ]
  },

  scra: {
    name: 'Servicemembers Civil Relief Act (50 U.S.C. §3901 et seq.)',
    applies: 'Active duty military tenants',
    requirements: [
      'Active duty servicemembers may terminate a residential lease with 30 days written notice after receiving deployment or PCS orders',
      'Apply to leases executed before entering active duty or executed during military service',
      'No early termination fees or penalties may be imposed',
      'Security deposit must be returned per normal state law timelines'
    ]
  },

  violenceAgainstWomenAct: {
    name: 'Violence Against Women Act (VAWA) (34 U.S.C. §12491)',
    applies: 'Federally assisted housing (Section 8, public housing, etc.)',
    requirements: [
      'Tenants who are victims of domestic violence, dating violence, sexual assault, or stalking cannot be denied housing or evicted based on the violence',
      'Tenant may terminate lease early with proper documentation',
      'Lease bifurcation allowed to remove abuser while victim retains tenancy'
    ]
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the state law data for a given state code
 * @param {string} stateCode — 2-letter state code (e.g., 'MD', 'VA', 'DC')
 * @returns {Object|null} State law data or null
 */
export function getStateLaws(stateCode) {
  const code = stateCode?.toUpperCase()?.trim();
  return STATE_LANDLORD_TENANT_LAWS[code] || null;
}

/**
 * Look up state code from an address string
 * @param {string} address — Full property address
 * @returns {string|null} 2-letter state code or null
 */
export function extractStateFromAddress(address) {
  if (!address) return null;
  
  const addr = address.toUpperCase().trim();
  
  // Check for DC explicitly
  if ((addr.includes('WASHINGTON') && (addr.includes('D.C.') || addr.includes('DC'))) ||
      /[,\s]DC\s*\d{5}/.test(addr) || addr.endsWith(', DC') || addr.endsWith(' DC') ||
      addr.includes(', D.C.') || addr.includes('DISTRICT OF COLUMBIA')) {
    return 'DC';
  }
  
  // Standard state abbreviation patterns:
  // ", ST 12345" (with comma)
  const stateZipComma = addr.match(/,\s*([A-Z]{2})\s*\d{5}/);
  if (stateZipComma && isValidStateCode(stateZipComma[1])) return stateZipComma[1];
  
  // ", ST," or ", ST, 12345" (state between commas)
  const stateBetweenCommas = addr.match(/,\s*([A-Z]{2})\s*,/);
  if (stateBetweenCommas && isValidStateCode(stateBetweenCommas[1])) return stateBetweenCommas[1];
  
  // ", ST" at end (with comma)
  const stateEndComma = addr.match(/,\s*([A-Z]{2})\s*$/);
  if (stateEndComma && isValidStateCode(stateEndComma[1])) return stateEndComma[1];
  
  // "City ST 12345" (no comma — common format)
  const stateZipNoComma = addr.match(/\s([A-Z]{2})\s+\d{5}/);
  if (stateZipNoComma && isValidStateCode(stateZipNoComma[1])) return stateZipNoComma[1];
  
  // "City ST" at end (no comma)
  const stateEndNoComma = addr.match(/\s([A-Z]{2})\s*$/);
  if (stateEndNoComma && isValidStateCode(stateEndNoComma[1])) return stateEndNoComma[1];
  
  // Check full state names
  const stateNames = {
    'MARYLAND': 'MD',
    'VIRGINIA': 'VA',
    'DELAWARE': 'DE',
    'PENNSYLVANIA': 'PA',
    'NEW JERSEY': 'NJ',
    'WEST VIRGINIA': 'WV',
    'DISTRICT OF COLUMBIA': 'DC'
  };
  
  for (const [name, code] of Object.entries(stateNames)) {
    if (addr.includes(name)) return code;
  }
  
  return null;
}

/** Check if a 2-letter code is a valid US state abbreviation */
function isValidStateCode(code) {
  const VALID_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
    'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
    'VT','VA','WA','WV','WI','WY'
  ]);
  return VALID_STATES.has(code);
}

/**
 * Get the local jurisdiction additional rules (if any) for a given address
 * @param {string} address — Property address
 * @param {string} stateCode — State code
 * @returns {Object|null} Local jurisdiction rules
 */
export function getLocalJurisdictionRules(address, stateCode) {
  const stateLaws = getStateLaws(stateCode);
  if (!stateLaws?.localJurisdictions) return null;
  
  const addr = address?.toUpperCase() || '';
  
  for (const [jurisdictionName, rules] of Object.entries(stateLaws.localJurisdictions)) {
    if (addr.includes(jurisdictionName.toUpperCase())) {
      return { name: jurisdictionName, ...rules };
    }
  }
  
  return null;
}

/**
 * Get the security deposit maximum for a state
 * @param {string} stateCode 
 * @param {number} monthlyRent 
 * @returns {number|null} Max deposit amount or null if no statutory cap
 */
export function getMaxSecurityDeposit(stateCode, monthlyRent) {
  const stateLaws = getStateLaws(stateCode);
  if (!stateLaws?.securityDeposit?.maxAmountFormula) return null;
  return stateLaws.securityDeposit.maxAmountFormula(monthlyRent);
}

/**
 * Get the security deposit return deadline for a state
 * @param {string} stateCode 
 * @returns {string|null}
 */
export function getDepositReturnDeadline(stateCode) {
  const stateLaws = getStateLaws(stateCode);
  return stateLaws?.securityDeposit?.returnDeadline || null;
}

/**
 * Get all required disclosures for a state (including federal ones)
 * @param {string} stateCode 
 * @param {number} propertyYearBuilt — Year the property was built (for lead paint)
 * @returns {Array} Required disclosures
 */
export function getRequiredDisclosures(stateCode, propertyYearBuilt) {
  const stateLaws = getStateLaws(stateCode);
  if (!stateLaws) return [];
  
  const disclosures = [...stateLaws.requiredDisclosures];
  
  // Add lead paint as federal requirement if pre-1978 and not already in state list
  if (propertyYearBuilt && propertyYearBuilt < 1978) {
    const hasLeadPaint = disclosures.some(d => d.name.toLowerCase().includes('lead'));
    if (!hasLeadPaint) {
      disclosures.unshift({
        name: 'Lead Paint Disclosure',
        description: FEDERAL_REQUIREMENTS.leadPaintDisclosure.requirements.join('; '),
        required: true,
        federalRequirement: true,
        statuteReference: '42 U.S.C. §4852d'
      });
    }
  }
  
  return disclosures;
}

/**
 * Get all required lease provisions for a state
 * @param {string} stateCode 
 * @returns {Array<string>}
 */
export function getRequiredLeaseProvisions(stateCode) {
  const stateLaws = getStateLaws(stateCode);
  return stateLaws?.requiredLeaseProvisions || [];
}

/**
 * Build a comprehensive compliance context string for AI document generation
 * @param {string} stateCode — State code
 * @param {string} propertyAddress — Full property address (for local jurisdiction lookup)
 * @param {Object} options — Additional options (propertyYearBuilt, monthlyRent, etc.)
 * @returns {string} Formatted compliance context for AI prompts
 */
export function buildComplianceContext(stateCode, propertyAddress, options = {}) {
  const stateLaws = getStateLaws(stateCode);
  if (!stateLaws) {
    return `WARNING: No state-specific compliance data available for state code "${stateCode}". Generating document using general best practices. Document should be reviewed by a local attorney.`;
  }

  const localRules = getLocalJurisdictionRules(propertyAddress, stateCode);
  const disclosures = getRequiredDisclosures(stateCode, options.propertyYearBuilt);
  
  let context = `
=============================================================
LEGAL COMPLIANCE REQUIREMENTS — ${stateLaws.stateName}
=============================================================
Governing Statute: ${stateLaws.governingStatute}

--- SECURITY DEPOSIT ---
Maximum: ${stateLaws.securityDeposit.maxAmount}
Holding: ${stateLaws.securityDeposit.holdingRequirements}
Interest: ${stateLaws.securityDeposit.interestRequired ? stateLaws.securityDeposit.interestDetails : 'Not required'}
Return Deadline: ${stateLaws.securityDeposit.returnDeadline}
Itemized Statement: ${stateLaws.securityDeposit.itemizedStatementDeadline}
Non-Compliance Penalty: ${stateLaws.securityDeposit.penaltyForNonCompliance}
Statute: ${stateLaws.securityDeposit.statuteReference}

--- RENT RULES ---
Grace Period: ${stateLaws.rentRules.gracePeriod}
Late Fee Maximum: ${stateLaws.rentRules.lateFeeMax}
Rent Control: ${stateLaws.rentRules.rentControlAreas}
Increase Notice: ${stateLaws.rentRules.rentIncreaseNotice}
Statute: ${stateLaws.rentRules.statuteReference}

--- LEASE TERMINATION ---
Month-to-Month (Landlord): ${stateLaws.leaseTermination.monthToMonthNotice.landlord}
Month-to-Month (Tenant): ${stateLaws.leaseTermination.monthToMonthNotice.tenant}
Fixed Term: ${stateLaws.leaseTermination.fixedTermNotice}
Early Termination: ${stateLaws.leaseTermination.earlyTerminationRights}
Statute: ${stateLaws.leaseTermination.statuteReference}

--- LANDLORD ENTRY ---
Notice Required: ${stateLaws.landlordEntry.noticeRequired}
Emergency Exception: ${stateLaws.landlordEntry.emergencyException ? 'Yes — immediate entry permitted in emergencies' : 'No'}
Permitted Purposes: ${stateLaws.landlordEntry.permittedPurposes}
Statute: ${stateLaws.landlordEntry.statuteReference}

--- HABITABILITY ---
${stateLaws.habitabilityStandards.description}
Tenant Remedies: ${stateLaws.habitabilityStandards.tenantRemedies.join('; ')}
Statute: ${stateLaws.habitabilityStandards.statuteReference}

--- EVICTION PROCESS ---
Non-Payment: ${stateLaws.eviction.nonpaymentProcess}
Holdover: ${stateLaws.eviction.holdoverProcess}
Breach of Lease: ${stateLaws.eviction.breachOfLeaseProcess}
Anti-Retaliation: ${stateLaws.eviction.retaliationProtection}
Statute: ${stateLaws.eviction.statuteReference}

--- REQUIRED DISCLOSURES ---
${disclosures.map((d, i) => `${i + 1}. ${d.name}${d.federalRequirement ? ' [FEDERAL]' : ''}: ${d.description} (${d.statuteReference})`).join('\n')}

--- REQUIRED LEASE PROVISIONS ---
${stateLaws.requiredLeaseProvisions.map((p, i) => `${i + 1}. ${p}`).join('\n')}
`;

  // Add local jurisdiction rules if applicable
  if (localRules) {
    context += `
--- LOCAL JURISDICTION: ${localRules.name.toUpperCase()} ---
Additional requirements for ${localRules.name}:
${localRules.additionalRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${localRules.statuteReference ? `Statute: ${localRules.statuteReference}` : ''}
`;
  }

  // Add federal requirements summary
  context += `
--- FEDERAL REQUIREMENTS ---
1. Fair Housing Act: No discrimination based on ${FEDERAL_REQUIREMENTS.fairHousing.protectedClasses.join(', ')}
2. SCRA: Active military may terminate lease with 30 days notice upon deployment/PCS
3. VAWA: Victims of domestic violence in federally-assisted housing have additional protections
${options.propertyYearBuilt && options.propertyYearBuilt < 1978 ? `4. Lead Paint (pre-1978 property): ${FEDERAL_REQUIREMENTS.leadPaintDisclosure.requirements.join('; ')}` : ''}
`;

  return context;
}

/**
 * Get the list of all supported states
 * @returns {Array<{code: string, name: string}>}
 */
export function getSupportedStates() {
  return Object.entries(STATE_LANDLORD_TENANT_LAWS).map(([code, data]) => ({
    code,
    name: data.stateName
  }));
}

export default {
  STATE_LANDLORD_TENANT_LAWS,
  FEDERAL_REQUIREMENTS,
  getStateLaws,
  extractStateFromAddress,
  getLocalJurisdictionRules,
  getMaxSecurityDeposit,
  getDepositReturnDeadline,
  getRequiredDisclosures,
  getRequiredLeaseProvisions,
  buildComplianceContext,
  getSupportedStates
};
