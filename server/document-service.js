import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import crypto from 'crypto';
import { initializeFirebaseAdmin } from './firebase-admin.js';
import { researchCompliance, quickComplianceCheck } from './legal-compliance-research.js';
import { extractStateFromAddress, getStateLaws, buildComplianceContext } from './legal-compliance-data.js';
import { repairComplianceMetadata, repairComplianceStatuteUrl } from '../src/shared/complianceStatuteUrls.js';

// Initialize Gemini 2.5 Pro (most powerful model for complex reasoning & legal documents)
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key);

// Safety settings — legal documents need relaxed filters to avoid RECITATION blocks
const LEGAL_SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const geminiModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-pro',
  safetySettings: LEGAL_SAFETY_SETTINGS
});

// Initialize Firebase using shared admin instance
let db;
let inMemoryDocuments = new Map(); // Fallback storage when Firebase unavailable
try {
  const admin = initializeFirebaseAdmin();
  db = admin.firestore();
  console.log('[DocumentService] ✅ Firestore connected');
} catch (error) {
  console.warn('[DocumentService] ⚠️ Firebase unavailable, using in-memory storage:', error.message);
}

// ============================================================================
// DOCUMENT TYPES & TEMPLATES
// ============================================================================
export const DOCUMENT_TYPES = {
  LEASE_AGREEMENT: {
    id: 'lease_agreement',
    name: 'Lease Agreement',
    icon: '📝',
    description: 'Standard residential lease agreement',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant'],
    template: 'lease'
  },
  LEASE_AMENDMENT: {
    id: 'lease_amendment',
    name: 'Lease Amendment',
    icon: '📋',
    description: 'Amendment to existing lease terms',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant'],
    template: 'amendment'
  },
  MOVE_IN_CHECKLIST: {
    id: 'move_in_checklist',
    name: 'Move-In Checklist',
    icon: '✅',
    description: 'Document property condition at move-in',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant'],
    template: 'checklist'
  },
  MOVE_OUT_CHECKLIST: {
    id: 'move_out_checklist',
    name: 'Move-Out Checklist',
    icon: '📤',
    description: 'Document property condition at move-out',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant'],
    template: 'checklist'
  },
  NOTICE_TO_VACATE: {
    id: 'notice_to_vacate',
    name: 'Notice to Vacate',
    icon: '📨',
    description: 'Formal notice of intent to vacate',
    requiresSignature: true,
    signerRoles: ['tenant'],
    template: 'notice'
  },
  NOTICE_TO_QUIT: {
    id: 'notice_to_quit',
    name: 'Notice to Quit',
    icon: '⚠️',
    description: 'Formal eviction notice',
    requiresSignature: true,
    signerRoles: ['landlord'],
    template: 'notice'
  },
  RENT_INCREASE_NOTICE: {
    id: 'rent_increase_notice',
    name: 'Rent Increase Notice',
    icon: '💰',
    description: 'Notice of rent increase',
    requiresSignature: true,
    signerRoles: ['landlord'],
    template: 'notice'
  },
  PET_ADDENDUM: {
    id: 'pet_addendum',
    name: 'Pet Addendum',
    icon: '🐕',
    description: 'Pet policy agreement addendum',
    requiresSignature: true,
    signerRoles: ['landlord', 'tenant'],
    template: 'addendum'
  },
  MAINTENANCE_AUTHORIZATION: {
    id: 'maintenance_authorization',
    name: 'Maintenance Authorization',
    icon: '🔧',
    description: 'Authorization for maintenance work',
    requiresSignature: true,
    signerRoles: ['tenant'],
    template: 'authorization'
  },
  WATER_MITIGATION_INSTALLER_ATTESTATION: {
    id: 'water_mitigation_installer_attestation',
    name: 'Water Mitigation Installer Attestation',
    icon: '✓',
    description: 'Installer attestation for water-loss mitigation equipment and functional commissioning',
    requiresSignature: true,
    signerRoles: ['installer'],
    template: 'attestation'
  },
  WATER_MITIGATION_ANNUAL_RECERTIFICATION: {
    id: 'water_mitigation_annual_recertification',
    name: 'Annual Water-Loss Protection Recertification',
    icon: '✓',
    description: 'Signed annual functional inspection of leak detection, alerting, and automatic water shutoff',
    requiresSignature: true,
    signerRoles: ['technician'],
    template: 'attestation'
  },
  SECURITY_DEPOSIT_RECEIPT: {
    id: 'security_deposit_receipt',
    name: 'Security Deposit Receipt',
    icon: '🧾',
    description: 'Receipt for security deposit',
    requiresSignature: false,
    signerRoles: [],
    template: 'receipt'
  },
  RENT_RECEIPT: {
    id: 'rent_receipt',
    name: 'Rent Receipt',
    icon: '💵',
    description: 'Monthly rent payment receipt',
    requiresSignature: false,
    signerRoles: [],
    template: 'receipt'
  },
  RENTERS_INSURANCE: {
    id: 'renters_insurance',
    name: "Renter's Insurance",
    icon: '🛡️',
    description: 'Renter\'s insurance certificate uploaded by tenant',
    requiresSignature: false,
    signerRoles: [],
    template: 'insurance'
  },
  UPLOADED_DOCUMENT: {
    id: 'uploaded_document',
    name: 'Uploaded Document',
    icon: '📁',
    description: 'Custom uploaded document file',
    requiresSignature: false,
    signerRoles: [],
    template: 'uploaded'
  },
  CUSTOM_DOCUMENT: {
    id: 'custom_document',
    name: 'Custom Document',
    icon: '📄',
    description: 'Custom uploaded document',
    requiresSignature: false,
    signerRoles: [],
    template: 'custom'
  }
};

// Document status enum
export const DOCUMENT_STATUS = {
  DRAFT: 'draft',
  PENDING_SIGNATURES: 'pending_signatures',
  PARTIALLY_SIGNED: 'partially_signed',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled'
};

function resolveDocumentTypeConfig(documentType) {
  if (documentType && DOCUMENT_TYPES[documentType]) {
    return DOCUMENT_TYPES[documentType];
  }

  if (documentType) {
    const byId = Object.values(DOCUMENT_TYPES).find((typeConfig) => typeConfig.id === documentType);
    if (byId) {
      return byId;
    }
  }

  return DOCUMENT_TYPES.CUSTOM_DOCUMENT;
}

function sanitizeFirestoreValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeFirestoreValue(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, nestedValue]) => [key, sanitizeFirestoreValue(nestedValue)])
        .filter(([, nestedValue]) => nestedValue !== undefined)
    );
  }

  return value;
}

const DOCUMENT_SEAL_ALGORITHM = {
  LEGACY_V1: 'legacy_signature_request_order_v1',
  CANONICAL_V2: 'canonical_signature_payload_v2'
};

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasOwnValue(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function appendOrderedSealField(target, source, key, options = {}) {
  const { fallback = null, always = false } = options;

  if (always || hasOwnValue(source, key)) {
    target[key] = source?.[key] ?? fallback;
  }
}

function buildLegacySignatureRequestSealSnapshot(signatureRequest) {
  const snapshot = {};

  appendOrderedSealField(snapshot, signatureRequest, 'signerId', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'signerFirebaseUid');
  appendOrderedSealField(snapshot, signatureRequest, 'signerEmail', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'signerName', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'signerRole', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'token', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'status', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'requestedAt', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'signedAt', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'signature', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'ipAddress', { always: true });
  appendOrderedSealField(snapshot, signatureRequest, 'userAgent');
  appendOrderedSealField(snapshot, signatureRequest, 'esignConsentGiven');
  appendOrderedSealField(snapshot, signatureRequest, 'esignDisclosureProvided');
  appendOrderedSealField(snapshot, signatureRequest, 'ersdConsentTimestamp');
  appendOrderedSealField(snapshot, signatureRequest, 'emailVerified');
  appendOrderedSealField(snapshot, signatureRequest, 'tokenInvalidated');

  return sanitizeFirestoreValue(snapshot);
}

function sortSealValueDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortSealValueDeep(item));
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value)
      .sort()
      .reduce((normalized, key) => {
        normalized[key] = sortSealValueDeep(value[key]);
        return normalized;
      }, {});
  }

  return value;
}

function computeDocumentContentHash(content) {
  return sha256Hex(content || '');
}

function computeLegacyDocumentSealHash(content, signatureRequests) {
  const legacyRequests = (signatureRequests || []).map((signatureRequest) =>
    buildLegacySignatureRequestSealSnapshot(signatureRequest)
  );

  return sha256Hex(`${content || ''}${JSON.stringify(legacyRequests)}`);
}

function computeCanonicalDocumentSealHash(content, signatureRequests) {
  const canonicalPayload = {
    content: content || '',
    signatureRequests: (signatureRequests || []).map((signatureRequest) =>
      sortSealValueDeep(buildLegacySignatureRequestSealSnapshot(signatureRequest))
    )
  };

  return sha256Hex(JSON.stringify(canonicalPayload));
}

function formatSealAlgorithmLabel(sealAlgorithm) {
  if (sealAlgorithm === DOCUMENT_SEAL_ALGORITHM.CANONICAL_V2) {
    return 'Canonical completion seal';
  }

  if (sealAlgorithm === DOCUMENT_SEAL_ALGORITHM.LEGACY_V1) {
    return 'Legacy completion seal';
  }

  return null;
}

export function evaluateDocumentIntegrity(document) {
  const verificationScope = 'HouseYield seals the final document content together with the captured signer metadata. The document content hash below is content-only and is expected to differ from the completion seal.';
  const contentHash = computeDocumentContentHash(document?.content || '');

  if (!(document?.sealedDocumentHash && document?.status === DOCUMENT_STATUS.COMPLETED)) {
    return {
      contentHash,
      currentHash: null,
      sealedHash: document?.sealedDocumentHash || null,
      sealedAt: document?.sealedAt || null,
      tamperDetected: false,
      status: 'NOT_SEALED',
      explanation: 'Document has not been fully signed and sealed yet.',
      verifiedWith: null,
      verifiedWithLabel: null,
      verificationScope
    };
  }

  const canonicalHash = computeCanonicalDocumentSealHash(document.content, document.signatureRequests);
  const legacyHash = computeLegacyDocumentSealHash(document.content, document.signatureRequests);

  let verifiedWith = null;
  let currentHash = canonicalHash;

  if (document.sealedDocumentHash === canonicalHash) {
    verifiedWith = DOCUMENT_SEAL_ALGORITHM.CANONICAL_V2;
    currentHash = canonicalHash;
  } else if (document.sealedDocumentHash === legacyHash) {
    verifiedWith = DOCUMENT_SEAL_ALGORITHM.LEGACY_V1;
    currentHash = legacyHash;
  }

  const tamperDetected = verifiedWith === null;

  let explanation = 'Verified using the canonical completion seal. The final document content and captured signer metadata still match the stored completion seal.';
  if (verifiedWith === DOCUMENT_SEAL_ALGORITHM.LEGACY_V1) {
    explanation = 'Verified using the legacy completion seal. Older receipts could show a false failure because the original seal depended on signature-request field order after a database round trip. This document still matches the originally sealed payload.';
  } else if (tamperDetected) {
    explanation = 'HouseYield checked both the current canonical seal and the legacy seal format used by older documents. Neither matches the stored completion seal, so the saved signed payload no longer matches what was sealed at completion.';
  }

  return {
    contentHash,
    currentHash,
    sealedHash: document.sealedDocumentHash,
    sealedAt: document.sealedAt || null,
    tamperDetected,
    status: tamperDetected ? 'INTEGRITY_FAILED' : 'INTEGRITY_VERIFIED',
    explanation,
    verifiedWith,
    verifiedWithLabel: formatSealAlgorithmLabel(verifiedWith),
    verificationScope
  };
}

const COMPLIANCE_SOURCE_LIMIT = 8;
const OFFICIAL_SOURCE_HOSTS = [
  'mgaleg.maryland.gov',
  'law.lis.virginia.gov',
  'code.dccouncil.gov',
  'delcode.delaware.gov',
  'palegis.us',
  'legis.state.pa.us',
  'lis.njleg.state.nj.us',
  'njleg.state.nj.us',
  'wvlegislature.gov',
  'hud.gov',
  'epa.gov',
  'justice.gov'
];

function normalizeComplianceUrl(url, stateCode = null) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return repairComplianceStatuteUrl(parsed.toString(), stateCode).replace(/\/$/, '');
  } catch {
    return repairComplianceStatuteUrl(trimmed.replace(/\/$/, ''), stateCode);
  }
}

function getComplianceSourceHostname(url) {
  const normalized = normalizeComplianceUrl(url);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.replace(/^www\./i, '');
  } catch {
    return normalized.replace(/^https?:\/\//i, '').split('/')[0] || null;
  }
}

function isOfficialComplianceHostname(hostname = '') {
  const host = hostname.toLowerCase();
  return host.endsWith('.gov') || OFFICIAL_SOURCE_HOSTS.some((officialHost) => host === officialHost || host.endsWith(`.${officialHost}`));
}

function isLegalAuthoritySource(hostname = '', title = '') {
  const haystack = `${hostname} ${title}`.toLowerCase();
  return /statute|code|ordinance|legislature|assembly|council|court|housing authority|department|division|chapter|title \d/.test(haystack);
}

function normalizeComplianceSource(source = {}, stateCode = null) {
  const url = normalizeComplianceUrl(source.url, stateCode);
  const hostname = source.hostname || getComplianceSourceHostname(url);
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const label = typeof source.label === 'string' && source.label.trim()
    ? source.label.trim()
    : title || hostname || 'Compliance source';
  const isOfficial = source.isOfficial === true || isOfficialComplianceHostname(hostname || '');
  const isLegalAuthority = isOfficial || isLegalAuthoritySource(hostname || '', `${title} ${source.citation || ''}`);
  const category = source.category || (isOfficial ? 'official' : isLegalAuthority ? 'legal' : 'secondary');
  const appliesTo = [
    source.appliesTo,
    source.scope,
    source.coverage
  ].find((value) => typeof value === 'string' && value.trim()) || null;
  const effectiveDate = [
    source.effectiveDate,
    source.effectiveOn,
    source.appliesFrom,
    source.validFrom
  ].find((value) => typeof value === 'string' && value.trim()) || null;
  const lastUpdated = [
    source.lastUpdated,
    source.updatedAt,
    source.publishedAt,
    source.date
  ].find((value) => typeof value === 'string' && value.trim()) || null;

  return sanitizeFirestoreValue({
    title: title || label,
    label,
    url,
    hostname,
    category,
    authorityLevel: source.authorityLevel || (isOfficial ? 'official' : isLegalAuthority ? 'legal' : 'research'),
    isOfficial,
    citation: source.citation || null,
    appliesTo,
    effectiveDate,
    lastUpdated
  });
}

function dedupeComplianceSources(sources, stateCode = null) {
  const seen = new Set();
  const unique = [];

  for (const rawSource of sources) {
    const source = normalizeComplianceSource(rawSource, stateCode);
    if (!source?.label) continue;
    const dedupeKey = (source.url || `${source.label}::${source.citation || ''}`).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(source);
  }

  return unique;
}

function rankComplianceSource(source) {
  if (source.isOfficial) return 0;
  if (source.category === 'legal') return 1;
  return 2;
}

function buildPrimaryAuthoritySources(stateLaws, localRules, options = {}) {
  const sources = [];

  if (stateLaws?.governingStatute) {
    sources.push({
      title: stateLaws.governingStatute,
      label: `${stateLaws.stateName} governing statute`,
      url: repairComplianceStatuteUrl(stateLaws.statuteUrl || null),
      authorityLevel: 'state',
      isOfficial: true,
      appliesTo: stateLaws.stateName || null
    });
  }

  if (localRules?.name || localRules?.statuteReference) {
    sources.push({
      title: localRules?.statuteReference || `${localRules?.name || 'Local'} housing code`,
      label: localRules?.name
        ? `${localRules.name} local code reference`
        : 'Local code reference',
      authorityLevel: 'local',
      isOfficial: true,
      citation: localRules?.statuteReference || null,
      appliesTo: localRules?.name || null
    });
  }

  sources.push({
    title: 'HUD Fair Housing Act Overview',
    label: 'HUD Fair Housing Act guidance',
    url: 'https://www.hud.gov/program_offices/fair_housing_equal_opp/fair_housing_act_overview',
    authorityLevel: 'federal',
    isOfficial: true,
    appliesTo: 'Federal fair housing'
  });

  if (options.propertyYearBuilt && Number(options.propertyYearBuilt) < 1978) {
    sources.push({
      title: 'EPA Lead-Based Paint Real Estate Disclosure Rule',
      label: 'EPA lead-based paint disclosure rule',
      url: 'https://www.epa.gov/lead/real-estate-disclosure',
      authorityLevel: 'federal',
      isOfficial: true,
      appliesTo: 'Pre-1978 properties'
    });
  }

  return sources;
}

function buildStandardizedComplianceSources(complianceData, options = {}) {
  const stateLaws = complianceData?.staticCompliance || null;
  const localRules = complianceData?.localJurisdiction || null;
  const primarySources = buildPrimaryAuthoritySources(stateLaws, localRules, options);
  const researchedSources = Array.isArray(complianceData?.sources)
    ? complianceData.sources
    : [];
  const recentSources = Array.isArray(complianceData?.recentChanges)
    ? complianceData.recentChanges.map((item) => ({
        title: item.title,
        url: item.link,
        hostname: item.source || null,
        appliesTo: localRules?.name || stateLaws?.stateName || null,
        effectiveDate: item.effectiveDate || item.effectiveOn || null,
        lastUpdated: item.lastUpdated || item.updatedAt || item.date || null
      }))
    : [];

  const combined = dedupeComplianceSources([
    ...primarySources,
    ...researchedSources,
    ...recentSources
  ], complianceData?.stateCode || null).sort((left, right) => {
    const rankDifference = rankComplianceSource(left) - rankComplianceSource(right);
    if (rankDifference !== 0) return rankDifference;
    return (left.label || '').localeCompare(right.label || '');
  });

  const officialOrLegal = combined.filter((source) => rankComplianceSource(source) < 2);
  const secondary = combined.filter((source) => rankComplianceSource(source) === 2);

  if (officialOrLegal.length >= 3) {
    return officialOrLegal.concat(secondary.slice(0, 2)).slice(0, COMPLIANCE_SOURCE_LIMIT);
  }

  return combined.slice(0, COMPLIANCE_SOURCE_LIMIT);
}

function buildStateRequirementDetails(stateLaws) {
  if (!stateLaws) return [];

  const items = [
    `Security deposit cap: ${stateLaws.securityDeposit.maxAmount}. Return deadline: ${stateLaws.securityDeposit.returnDeadline}. ${stateLaws.securityDeposit.holdingRequirements} (${stateLaws.securityDeposit.statuteReference})`,
    `Late fees and rent timing: ${stateLaws.rentRules.lateFeeMax}. Grace period: ${stateLaws.rentRules.gracePeriod}. Rent increase notice: ${stateLaws.rentRules.rentIncreaseNotice} (${stateLaws.rentRules.statuteReference})`,
    `Landlord entry: ${stateLaws.landlordEntry.noticeRequired}. Permitted purposes: ${stateLaws.landlordEntry.permittedPurposes} (${stateLaws.landlordEntry.statuteReference})`,
    `Termination baseline: landlord notice ${stateLaws.leaseTermination.monthToMonthNotice.landlord}; tenant notice ${stateLaws.leaseTermination.monthToMonthNotice.tenant}. Fixed term rule: ${stateLaws.leaseTermination.fixedTermNotice} (${stateLaws.leaseTermination.statuteReference})`,
    `Habitability: ${stateLaws.habitabilityStandards.description} (${stateLaws.habitabilityStandards.statuteReference})`,
    `Eviction and retaliation: ${stateLaws.eviction.nonpaymentProcess} Anti-retaliation: ${stateLaws.eviction.retaliationProtection} (${stateLaws.eviction.statuteReference})`
  ];

  return sanitizeFirestoreValue(items);
}

function buildLocalRequirementDetails(localRules) {
  if (!localRules?.additionalRules?.length) return [];
  return sanitizeFirestoreValue(localRules.additionalRules.map((rule) => (
    localRules.statuteReference
      ? `${rule} (${localRules.statuteReference})`
      : rule
  )));
}

function buildDisclosureRequirementDetails(disclosures = []) {
  return sanitizeFirestoreValue(disclosures.map((disclosure) => {
    const requirementLabel = disclosure.required === false ? 'Conditional / local overlay' : 'Required';
    const federalLabel = disclosure.federalRequirement ? ' [Federal]' : '';
    return `${disclosure.name}${federalLabel}: ${disclosure.description} (${requirementLabel}${disclosure.statuteReference ? `; ${disclosure.statuteReference}` : ''})`;
  }));
}

function buildDocumentRequirementDetails(documentType, stateLaws, disclosures = [], localRules = null) {
  if (!stateLaws) return [];

  const disclosureCount = disclosures.length;

  const detailsByType = {
    lease_agreement: [
      ...(stateLaws.requiredLeaseProvisions || []),
      disclosureCount > 0 ? `Attach or incorporate ${disclosureCount} disclosure requirement${disclosureCount === 1 ? '' : 's'} captured for this address.` : null,
      localRules?.name ? `Account for ${localRules.name} local overlay requirements where they are more protective than statewide rules.` : null
    ],
    rent_increase_notice: [
      `Written notice period must satisfy: ${stateLaws.rentRules.rentIncreaseNotice}`,
      `Rent-control overlay considered: ${stateLaws.rentRules.rentControlAreas}`,
      'Notice should clearly state the current rent, new rent, and effective date.'
    ],
    notice_to_vacate: [
      `Tenant notice period considered: ${stateLaws.leaseTermination.monthToMonthNotice.tenant}`,
      `Security deposit return deadline referenced: ${stateLaws.securityDeposit.returnDeadline}`,
      'Forwarding-address instructions should be included for deposit return logistics.'
    ],
    notice_to_quit: [
      `Nonpayment process considered: ${stateLaws.eviction.nonpaymentProcess}`,
      `Lease-breach process considered: ${stateLaws.eviction.breachOfLeaseProcess}`,
      `Holdover process considered: ${stateLaws.eviction.holdoverProcess}`
    ],
    move_in_checklist: [
      'Checklist should document room-by-room condition with signatures from both sides.',
      disclosures.find((item) => item.name?.includes('Move-In') || item.name?.includes('Damage'))
        ? disclosures.find((item) => item.name?.includes('Move-In') || item.name?.includes('Damage')).description
        : 'Move-in condition reporting requirements were considered from the governing jurisdiction.'
    ],
    move_out_checklist: [
      `Deposit deductions must be itemized by: ${stateLaws.securityDeposit.itemizedStatementDeadline}`,
      `Deposit return deadline considered: ${stateLaws.securityDeposit.returnDeadline}`,
      `Penalty for non-compliance considered: ${stateLaws.securityDeposit.penaltyForNonCompliance}`
    ],
    pet_addendum: [
      `Pet-related charges cannot circumvent the overall deposit cap of ${stateLaws.securityDeposit.maxAmount}.`,
      'Service animals and emotional support animals must be handled under fair housing rules, not pet restrictions.',
      'Pet type, limits, damage responsibility, and removal conditions should be expressly stated.'
    ],
    lease_amendment: [
      'Amendment should reference the original lease, clearly state modified provisions, and preserve unmodified terms.',
      'All original parties should sign the amendment with an effective date.',
      'Changes to rent, deposit, or term must still comply with the same jurisdictional limits as the original lease.'
    ],
    maintenance_authorization: [
      `Property-access notice considered: ${stateLaws.landlordEntry.noticeRequired}`,
      `Emergency exception considered: ${stateLaws.landlordEntry.emergencyException ? 'yes' : 'no'}`,
      'Authorization should describe the work scope, access window, and tenant contact information.'
    ]
  };

  return sanitizeFirestoreValue((detailsByType[documentType] || []).filter(Boolean));
}

function buildComplianceAuditMetadata(complianceData, additionalData = {}, docTypeConfig = null) {
  if (!complianceData) {
    return null;
  }

  const stateLaws = complianceData.staticCompliance || getStateLaws(complianceData.stateCode);
  const localRules = complianceData.localJurisdiction || null;
  const generatedAt = new Date().toISOString();
  const propertyCounty = additionalData.propertyCounty || additionalData.county || null;
  const propertyCity = additionalData.propertyCity || additionalData.city || null;

  return sanitizeFirestoreValue({
    stateCode: complianceData.stateCode || null,
    stateName: complianceData.stateName || stateLaws?.stateName || null,
    county: propertyCounty,
    countyName: propertyCounty,
    locality: propertyCity,
    city: propertyCity,
    localJurisdiction: localRules ? {
      name: localRules.name || null,
      additionalRules: localRules.additionalRules || [],
      statuteReference: localRules.statuteReference || null
    } : null,
    governingAuthority: stateLaws ? {
      title: stateLaws.governingStatute,
      citation: stateLaws.governingStatute,
      url: repairComplianceStatuteUrl(stateLaws.statuteUrl || null, complianceData.stateCode || null)
    } : null,
    stateRequirements: buildStateRequirementDetails(stateLaws),
    localRequirements: buildLocalRequirementDetails(localRules),
    requiredDisclosures: buildDisclosureRequirementDetails(complianceData.requiredDisclosures || []),
    documentRequirements: buildDocumentRequirementDetails(
      docTypeConfig?.id || null,
      stateLaws,
      complianceData.requiredDisclosures || [],
      localRules
    ),
    warnings: Array.isArray(complianceData.warnings) ? complianceData.warnings : [],
    sources: buildStandardizedComplianceSources(complianceData, {
      propertyYearBuilt: additionalData.propertyYearBuilt
    }),
    verification: {
      status: 'Captured at generation',
      summary: localRules?.name
        ? `State requirements, ${localRules.name} local overlays, and prioritized authority sources were captured when this document was generated. Review the saved document and cited authorities before relying on it.`
        : 'State requirements and prioritized authority sources were captured when this document was generated. Review the saved document and cited authorities before relying on it.',
      checkedAt: generatedAt,
      provider: 'HouseYield compliance research pipeline',
      scope: localRules?.name
        ? 'state statute + local overlay + authority-prioritized source review'
        : 'state statute + authority-prioritized source review'
    },
    generatedAt
  });
}

// ============================================================================
// DOCUMENT MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * Create a new document
 */
export async function createDocument(params) {
  const {
    ownerId,
    propertyId,
    tenantId,
    documentType,
    title,
    content,
    metadata = {}
  } = params;

  const documentId = `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const docTypeConfig = resolveDocumentTypeConfig(documentType);

  const document = {
    id: documentId,
    ownerId,
    documentType: docTypeConfig.id,
    title: title || docTypeConfig.name,
    content,
    status: docTypeConfig.requiresSignature ? DOCUMENT_STATUS.DRAFT : DOCUMENT_STATUS.COMPLETED,
    requiresSignature: docTypeConfig.requiresSignature,
    signerRoles: docTypeConfig.signerRoles,
    signatures: [],
    metadata: {
      ...metadata,
      icon: metadata.icon || docTypeConfig.icon,
      description: metadata.description || docTypeConfig.description
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null
  };

  // Add optional fields only if they're defined (Firestore doesn't allow undefined)
  if (propertyId !== undefined && propertyId !== null) {
    document.propertyId = propertyId;
  }
  if (tenantId !== undefined && tenantId !== null) {
    document.tenantId = tenantId;
  }

  const sanitizedDocument = sanitizeFirestoreValue(document);

  if (!db) {
    throw new Error('Database not available');
  }

  try {
    await db.collection('documents').doc(documentId).set(sanitizedDocument);
    console.log(`[DocumentService] ✅ Document ${documentId} saved to Firestore`);
  } catch (error) {
    console.error('[DocumentService] ❌ Firestore save failed:', error);
    throw new Error(error.message || 'Failed to save document to Firestore');
  }

  return sanitizedDocument;
}

function repairDocumentComplianceMetadata(document) {
  if (!document?.metadata?.compliance) {
    return document;
  }

  return {
    ...document,
    metadata: {
      ...document.metadata,
      compliance: repairComplianceMetadata(document.metadata.compliance)
    }
  };
}

/**
 * Get documents for a property or owner
 */
export async function getDocuments(params) {
  const { ownerId, propertyId, tenantId, status, documentType } = params;

  if (!db) {
    return { success: false, documents: [], error: 'Database not available' };
  }

  try {
    let query = db.collection('documents');

    if (ownerId) {
      query = query.where('ownerId', '==', ownerId);
    }
    if (propertyId) {
      query = query.where('propertyId', '==', propertyId);
    }
    if (tenantId) {
      // Query by tenantId OR tenantFirebaseUid to support both tenant ID formats
      // First try tenantId, then tenantFirebaseUid
      query = query.where('tenantId', '==', tenantId);
    }
    if (status) {
      query = query.where('status', '==', status);
    }
    if (documentType) {
      const resolved = resolveDocumentTypeConfig(documentType);
      query = query.where('documentType', '==', resolved?.id || documentType);
    }

    let snapshot;
    try {
      snapshot = await query.orderBy('createdAt', 'desc').get();
    } catch (indexError) {
      // If index error, try without ordering
      console.warn('[DocumentService] Index not available, querying without order');
      snapshot = await query.get();
    }
    
    let documents = snapshot.docs.map(doc => doc.data());
    
    // If querying by tenantId, ALSO search by tenantFirebaseUid and merge results
    // This is needed because some documents store the Firestore tenant doc ID as tenantId
    // while others store the Firebase UID, and the tenant dashboard always queries with Firebase UID
    if (tenantId) {
      try {
        let altQuery = db.collection('documents').where('tenantFirebaseUid', '==', tenantId);
        if (propertyId) {
          altQuery = altQuery.where('propertyId', '==', propertyId);
        }
        const altSnapshot = await altQuery.get();
        const altDocs = altSnapshot.docs.map(doc => doc.data());
        
        // Also search where the Firestore tenant doc ID's signatureRequests contain this Firebase UID
        // by querying tenantId field with the value that doesn't match Firebase UID
        // Merge without duplicates
        const existingIds = new Set(documents.map(d => d.id));
        for (const doc of altDocs) {
          if (!existingIds.has(doc.id)) {
            documents.push(doc);
            existingIds.add(doc.id);
          }
        }
        
        if (altDocs.length > 0) {
          console.log('[DocumentService] Found', altDocs.length, 'additional docs by tenantFirebaseUid');
        }
      } catch (e) {
        console.warn('[DocumentService] tenantFirebaseUid query failed:', e.message);
      }
    }
    
    // Sort client-side if we didn't use orderBy
    documents.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    return { success: true, documents: documents.map(repairDocumentComplianceMetadata) };
  } catch (error) {
    console.error('[DocumentService] Error fetching documents:', error);
    return { success: false, documents: [], error: error.message };
  }
}

/**
 * Get a single document by ID
 */
export async function getDocumentById(documentId) {
  if (!db) {
    return { success: false, document: null, error: 'Database not available' };
  }

  try {
    const doc = await db.collection('documents').doc(documentId).get();
    if (!doc.exists) {
      return { success: false, document: null, error: 'Document not found' };
    }
    return { success: true, document: repairDocumentComplianceMetadata(doc.data()) };
  } catch (error) {
    console.error('[DocumentService] Error fetching document:', error);
    return { success: false, document: null, error: error.message };
  }
}

/**
 * Update document status
 */
export async function updateDocumentStatus(documentId, status) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    await db.collection('documents').doc(documentId).update({
      status,
      updatedAt: new Date().toISOString()
    });
    return { success: true };
  } catch (error) {
    console.error('[DocumentService] Error updating status:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Rename a document (update its title)
 */
export async function renameDocument(documentId, newTitle) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    await db.collection('documents').doc(documentId).update({
      title: newTitle,
      updatedAt: new Date().toISOString()
    });
    return { success: true };
  } catch (error) {
    console.error('[DocumentService] Error renaming document:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update editable document text content
 */
export async function updateDocumentContent(documentId, content, options = {}) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  const nextContent = typeof content === 'string' ? content : '';
  if (!nextContent.trim()) {
    return { success: false, error: 'Document content is required' };
  }

  try {
    const docRef = db.collection('documents').doc(documentId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      return { success: false, error: 'Document not found' };
    }

    const document = snapshot.data() || {};
    if (Array.isArray(document.signatureRequests) && document.signatureRequests.length > 0) {
      return { success: false, error: 'Documents with signature requests can no longer be edited.' };
    }

    const now = new Date().toISOString();
    const updateData = {
      content: nextContent,
      updatedAt: now,
      'metadata.lastEditedAt': now
    };

    if (hasOwnValue(options, 'extractedText')) {
      const extractedText = typeof options.extractedText === 'string' ? options.extractedText : '';
      updateData['metadata.extractedText'] = extractedText || null;
      updateData['metadata.textLength'] = extractedText.length;
      if (document.metadata?.ocrProcessed || extractedText) {
        updateData['metadata.ocrProcessed'] = Boolean(extractedText);
      }
    }

    if (hasOwnValue(options, 'summary')) {
      updateData['metadata.summary'] = typeof options.summary === 'string' && options.summary.trim()
        ? options.summary.trim()
        : null;
    }

    await docRef.update(sanitizeFirestoreValue(updateData));

    return {
      success: true,
      document: sanitizeFirestoreValue({
        ...document,
        content: nextContent,
        updatedAt: now,
        metadata: {
          ...(document.metadata || {}),
          ...(hasOwnValue(options, 'extractedText')
            ? {
                extractedText: options.extractedText || null,
                textLength: typeof options.extractedText === 'string' ? options.extractedText.length : 0,
                ocrProcessed: document.metadata?.ocrProcessed || Boolean(options.extractedText)
              }
            : {}),
          ...(hasOwnValue(options, 'summary')
            ? {
                summary: typeof options.summary === 'string' && options.summary.trim()
                  ? options.summary.trim()
                  : null
              }
            : {}),
          lastEditedAt: now
        }
      })
    };
  } catch (error) {
    console.error('[DocumentService] Error updating content:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a document
 */
export async function deleteDocument(documentId) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    await db.collection('documents').doc(documentId).delete();
    return { success: true };
  } catch (error) {
    console.error('[DocumentService] Error deleting document:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// E-SIGNATURE FUNCTIONS
// ============================================================================

/**
 * Generate a cryptographically secure signing token
 * Uses crypto.randomBytes for proper entropy (not predictable inputs)
 */
export function generateSigningToken(documentId, signerId, signerRole) {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a signature request for a document
 */
export async function createSignatureRequest(params) {
  const {
    documentId,
    signers // Array of { id, email, name, role, firebaseUid? }
  } = params;

  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    const docRef = await db.collection('documents').doc(documentId).get();
    if (!docRef.exists) {
      return { success: false, error: 'Document not found' };
    }

    const document = docRef.data();
    
    // Compute document content hash at time of signature request for tamper detection
    const contentHashAtRequest = crypto.createHash('sha256')
      .update(document.content || '')
      .digest('hex');
    
    // Find tenant signer to get tenantId
    const tenantSigner = signers.find(s => s.role === 'tenant');
    
    // Generate signing tokens for each signer
    const signatureRequests = signers.map(signer => ({
      signerId: signer.id,
      signerFirebaseUid: signer.firebaseUid || null, // Store Firebase UID for tenant portal queries
      signerEmail: signer.email,
      signerName: signer.name,
      signerRole: signer.role,
      token: generateSigningToken(documentId, signer.id, signer.role),
      status: 'pending',
      requestedAt: new Date().toISOString(),
      signedAt: null,
      signature: null,
      ipAddress: null
    }));

    // Build update data - include tenantId if there's a tenant signer
    const updateData = {
      status: DOCUMENT_STATUS.PENDING_SIGNATURES,
      signatureRequests,
      contentHashAtRequest, // Store hash for tamper detection
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    };
    
    // Set tenantId on the document so tenants can query for it
    if (tenantSigner) {
      updateData.tenantId = tenantSigner.id;
      if (tenantSigner.firebaseUid) {
        updateData.tenantFirebaseUid = tenantSigner.firebaseUid;
      }
    }

    // Update document with signature requests
    await db.collection('documents').doc(documentId).update(updateData);

    // Return signing URLs
    const signingLinks = signatureRequests.map(req => ({
      signerId: req.signerId,
      signerEmail: req.signerEmail,
      signerName: req.signerName,
      signerRole: req.signerRole,
      signingUrl: `/documents/sign/${documentId}?token=${req.token}`
    }));

    return { success: true, signingLinks };
  } catch (error) {
    console.error('[DocumentService] Error creating signature request:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Verify a signing token
 */
export async function verifySigningToken(documentId, token) {
  if (!db) {
    return { valid: false, error: 'Database not available' };
  }

  try {
    const docRef = await db.collection('documents').doc(documentId).get();
    if (!docRef.exists) {
      return { valid: false, error: 'Document not found' };
    }

    const document = docRef.data();
    const signatureRequest = document.signatureRequests?.find(req => req.token === token);

    if (!signatureRequest) {
      return { valid: false, error: 'Invalid signing token' };
    }

    if (signatureRequest.status === 'signed') {
      return { valid: false, error: 'Document already signed by this party' };
    }

    if (document.expiresAt && new Date(document.expiresAt) < new Date()) {
      return { valid: false, error: 'Signing link has expired' };
    }

    return {
      valid: true,
      document,
      signer: {
        id: signatureRequest.signerId,
        firebaseUid: signatureRequest.signerFirebaseUid || null,
        email: signatureRequest.signerEmail,
        name: signatureRequest.signerName,
        role: signatureRequest.signerRole
      }
    };
  } catch (error) {
    console.error('[DocumentService] Error verifying token:', error);
    return { valid: false, error: error.message };
  }
}

/**
 * Apply a signature to a document
 */
export async function applySignature(params) {
  const {
    documentId,
    token,
    signatureData, // Base64 encoded signature image
    ipAddress,
    userAgent,
    ersdConsentTimestamp
  } = params;

  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    // Verify token first
    const verification = await verifySigningToken(documentId, token);
    if (!verification.valid) {
      return { success: false, error: verification.error };
    }

    const docRef = db.collection('documents').doc(documentId);
    const docSnap = await docRef.get();
    const document = docSnap.data();
    
    const signerRole = verification.signer.role;
    const signerName = verification.signer.name;
    const signedDate = new Date().toLocaleDateString('en-US', { 
      month: 'numeric', 
      day: 'numeric', 
      year: 'numeric' 
    });

    // Embed signature into document content
    let updatedContent = document.content || '';
    
    // Create the signature image HTML for embedding
    const signatureImg = `![Signature](${signatureData})`;
    const signedBlock = `[SIGNED ELECTRONICALLY]\n${signatureImg}\n**Signed:** ${signedDate}`;
    
    console.log(`[DocumentService] Embedding ${signerRole} signature for ${signerName}`);
    
    if (signerRole === 'tenant') {
      // Replace tenant signature placeholder - match various document formats
      // Format 1: **Tenant Signature:** _____ **Date:** mm/dd/yyyy (all on one line)
      updatedContent = updatedContent.replace(
        /\*\*Tenant Signature:\*\*\s*_{3,}\s*\*\*Date:\*\*\s*[\d\/]+/gi,
        `**Tenant Signature:**\n${signedBlock}`
      );
      // Format 2: **Tenant Signature:** _____ (no date on same line)
      updatedContent = updatedContent.replace(
        /\*\*Tenant Signature:\*\*\s*_{3,}/gi,
        `**Tenant Signature:**\n${signedBlock}`
      );
      // Format 3: Tenant Signature: _____ (no bold, with or without date)
      updatedContent = updatedContent.replace(
        /Tenant Signature:\s*_{3,}(?:\s*\*\*Date:\*\*\s*[\d\/]+)?/gi,
        `Tenant Signature:\n${signedBlock}`
      );
      // Format 4: Signature: _____ (generic, appears after **TENANT:** section)
      // Match lines starting with Signature: followed by underscores (tenant section)
      const tenantSectionMatch = updatedContent.match(/\*\*TENANT:\*\*[\s\S]*?Signature:\s*_{3,}/i);
      if (tenantSectionMatch) {
        updatedContent = updatedContent.replace(
          /(\*\*TENANT:\*\*[\s\S]*?)Signature:\s*_{3,}/i,
          `$1Signature:\n${signedBlock}`
        );
      }
      
      // Update tenant print name placeholders
      updatedContent = updatedContent.replace(
        /\*\*Print Name:\*\*\s*\[TENANT NAME\]/gi,
        `**Print Name:** ${signerName}`
      );
      updatedContent = updatedContent.replace(
        /Print Name:\s*\[TENANT NAME\]/gi,
        `Print Name: ${signerName}`
      );
    } else if (signerRole === 'landlord') {
      // Replace landlord signature placeholder - match various document formats
      // Format 1: **Landlord Signature:** _____ **Date:** mm/dd/yyyy
      updatedContent = updatedContent.replace(
        /\*\*Landlord Signature:\*\*\s*_{3,}\s*\*\*Date:\*\*\s*[\d\/]+/gi,
        `**Landlord Signature:**\n${signedBlock}`
      );
      // Format 2: **Landlord Signature:** _____
      updatedContent = updatedContent.replace(
        /\*\*Landlord Signature:\*\*\s*_{3,}/gi,
        `**Landlord Signature:**\n${signedBlock}`
      );
      // Format 3: Landlord Signature: _____
      updatedContent = updatedContent.replace(
        /Landlord Signature:\s*_{3,}(?:\s*\*\*Date:\*\*\s*[\d\/]+)?/gi,
        `Landlord Signature:\n${signedBlock}`
      );
      // Format 4: Signature: _____ (generic, appears after **LANDLORD:** section)
      const landlordSectionMatch = updatedContent.match(/\*\*LANDLORD:\*\*[\s\S]*?Signature:\s*_{3,}/i);
      if (landlordSectionMatch) {
        updatedContent = updatedContent.replace(
          /(\*\*LANDLORD:\*\*[\s\S]*?)Signature:\s*_{3,}/i,
          `$1Signature:\n${signedBlock}`
        );
      }
      
      // Update landlord print name
      updatedContent = updatedContent.replace(
        /\*\*Print Name:\*\*\s*Property Owner/gi,
        `**Print Name:** ${signerName}`
      );
      updatedContent = updatedContent.replace(
        /Print Name:\s*Property Owner/gi,
        `Print Name: ${signerName}`
      );
    }

    // Find and update the signature request - include ESIGN consent metadata
    const updatedRequests = document.signatureRequests.map(req => {
      if (req.token === token) {
        return {
          ...req,
          status: 'signed',
          signedAt: new Date().toISOString(),
          signature: signatureData,
          ipAddress,
          userAgent,
          // ESIGN compliance: record that consent and disclosure were provided
          esignConsentGiven: true,
          esignDisclosureProvided: true,
          ersdConsentTimestamp: ersdConsentTimestamp || null,
          emailVerified: true, // Email verification gate was passed on frontend
          tokenInvalidated: true // Token is now one-time use
        };
      }
      return req;
    });

    // Check if all signatures are complete
    const allSigned = updatedRequests.every(req => req.status === 'signed');
    const someSigned = updatedRequests.some(req => req.status === 'signed');

    let newStatus = document.status;
    if (allSigned) {
      newStatus = DOCUMENT_STATUS.COMPLETED;
    } else if (someSigned) {
      newStatus = DOCUMENT_STATUS.PARTIALLY_SIGNED;
    }

    // Record in signature audit log with ESIGN/UETA compliance data
    const preSignatureHash = crypto.createHash('sha256')
      .update(JSON.stringify(document.content))
      .digest('hex');
    const postSignatureHash = crypto.createHash('sha256')
      .update(updatedContent)
      .digest('hex');

    // Separate ERSD consent audit event (recorded before signing)
    const ersdAuditEntry = {
      action: 'ersd_consent_accepted',
      signerId: verification.signer.id,
      signerName: signerName,
      signerEmail: verification.signer.email,
      signerRole: verification.signer.role,
      timestamp: ersdConsentTimestamp || new Date().toISOString(),
      ipAddress,
      userAgent,
      disclosureType: 'ESIGN_Act_UETA_full_disclosure'
    };

    const auditEntry = {
      action: 'signature_applied',
      signerId: verification.signer.id,
      signerName: signerName,
      signerEmail: verification.signer.email,
      signerRole: verification.signer.role,
      timestamp: new Date().toISOString(),
      ipAddress,
      userAgent,
      // ESIGN Act compliance: explicit consent tracking
      esignConsent: {
        consentGiven: true,
        consentMethod: 'ersd_separate_step',
        disclosureProvided: true,
        disclosureType: 'ESIGN_Act_UETA_full_disclosure',
        consentTimestamp: ersdConsentTimestamp || new Date().toISOString()
      },
      // Tamper-evident: hash before and after signature embedding
      documentHashPreSignature: preSignatureHash,
      documentHashPostSignature: postSignatureHash,
      // Content hash from when signature was originally requested
      documentHashAtRequest: document.contentHashAtRequest || null
    };

    const auditLog = [...(document.auditLog || []), ersdAuditEntry, auditEntry];

    // Compute final sealed document hash when all parties have signed
    const sealedDocumentHash = allSigned
      ? computeCanonicalDocumentSealHash(updatedContent, updatedRequests)
      : null;

    await docRef.update({
      content: updatedContent,
      signatureRequests: updatedRequests,
      status: newStatus,
      auditLog,
      updatedAt: new Date().toISOString(),
      completedAt: allSigned ? new Date().toISOString() : null,
      // Tamper-evident seal: final hash of fully-signed document
      ...(allSigned && {
        sealedDocumentHash,
        sealedAt: new Date().toISOString(),
        sealAlgorithmVersion: DOCUMENT_SEAL_ALGORITHM.CANONICAL_V2
      })
    });

    if (
      allSigned
      && document.documentType === 'water_mitigation_annual_recertification'
      && document.metadata?.waterMitigationCertificationId
    ) {
      try {
        const { synchronizeWaterMitigationCertification } = await import('./services/waterMitigationCertificationService.js');
        await synchronizeWaterMitigationCertification(document.metadata.waterMitigationCertificationId);
      } catch (syncError) {
        console.warn('[DocumentService] Recertification signature sync deferred:', syncError.message);
      }
    }

    return {
      success: true,
      allSigned,
      newStatus,
      message: allSigned 
        ? 'Document fully executed!' 
        : 'Signature recorded. Waiting for remaining signatures.'
    };
  } catch (error) {
    console.error('[DocumentService] Error applying signature:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send signature reminder email
 */
export async function sendSignatureReminder(documentId, signerId) {
  // This would integrate with your email service
  console.log(`[DocumentService] Reminder sent for document ${documentId} to signer ${signerId}`);
  return { success: true, message: 'Reminder sent' };
}

// ============================================================================
// AI DOCUMENT GENERATION
// ============================================================================

/**
 * Generate document content using AI with full legal compliance
 */
export async function generateDocumentContent(params) {
  const {
    documentType,
    propertyAddress,
    landlordName,
    tenantName,
    customInstructions,
    additionalData = {}
  } = params;

  const docTypeConfig = resolveDocumentTypeConfig(documentType);
  if (!docTypeConfig || !docTypeConfig.id) {
    return { success: false, error: 'Invalid document type' };
  }

  // Prefer the canonical DOCUMENT_TYPES key for prompt builders that still key off it.
  const documentTypeKey = Object.keys(DOCUMENT_TYPES).find((key) => DOCUMENT_TYPES[key] === docTypeConfig)
    || String(documentType || 'CUSTOM_DOCUMENT').toUpperCase();
  void documentTypeKey;

  // Step 1: Research legal compliance for this jurisdiction + document type
  let complianceData = null;
  try {
    // Try to extract state from additionalData if address doesn't contain it
    let stateCodeHint = additionalData.stateCode || null;
    if (!stateCodeHint && additionalData.propertyState) {
      stateCodeHint = additionalData.propertyState.toUpperCase().trim();
      if (stateCodeHint.length > 2) stateCodeHint = null; // Only use 2-letter codes
    }
    // Last resort: try extracting from city + state + zip combined
    if (!stateCodeHint && !extractStateFromAddress(propertyAddress)) {
      const combinedAddr = [
        propertyAddress,
        additionalData.propertyCity,
        additionalData.propertyState,
        additionalData.propertyZip
      ].filter(Boolean).join(', ');
      const extracted = extractStateFromAddress(combinedAddr);
      if (extracted) stateCodeHint = extracted;
    }

    console.log(`[DocumentService] Researching legal compliance for ${documentType} at "${propertyAddress}" (stateHint: ${stateCodeHint || 'none'})`);
    complianceData = await researchCompliance({
      propertyAddress,
      stateCode: stateCodeHint,
      documentType: docTypeConfig.id,
      propertyYearBuilt: additionalData.propertyYearBuilt,
      monthlyRent: additionalData.monthlyRent ? parseFloat(additionalData.monthlyRent) : null,
      securityDeposit: additionalData.securityDeposit ? parseFloat(additionalData.securityDeposit) : null
    });
    console.log(`[DocumentService] Compliance research complete: ${complianceData.stateCode || 'unknown state'}`);
  } catch (err) {
    console.warn('[DocumentService] Compliance research failed, generating with baseline:', err.message);
  }

  // Step 2: Build the enhanced prompt with compliance context
  const prompt = buildDocumentPrompt(docTypeConfig, {
    propertyAddress,
    landlordName,
    tenantName,
    customInstructions,
    complianceData,
    ...additionalData
  });

  try {
    const systemPrompt = buildSystemPrompt(docTypeConfig, complianceData);
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;
    
    // Attempt generation with retry for RECITATION blocks
    let content = null;
    let lastError = null;
    
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tempAdjust = attempt * 0.3; // Increase temperature on retries
        const currentTemp = Math.min(0.2 + tempAdjust, 0.8);
        
        let promptText = fullPrompt;
        if (attempt > 0) {
          // Add anti-recitation instruction on retries
          promptText += `\n\nIMPORTANT: Use your own original phrasing for all clauses. Do NOT reproduce any copyrighted lease templates verbatim. Paraphrase all standard legal provisions in your own words while preserving legal accuracy and enforceability. This is attempt ${attempt + 1} — use creative, original language.`;
          console.log(`[DocumentService] Retry attempt ${attempt + 1} with temperature ${currentTemp}`);
        }
        
        const result = await geminiModel.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: promptText }]
          }],
          generationConfig: {
            temperature: currentTemp,
            maxOutputTokens: 16384
          }
        });

        const response = await result.response;
        content = response.text();
        break; // Success — exit retry loop
      } catch (retryError) {
        lastError = retryError;
        const msg = retryError.message || '';
        if (msg.includes('RECITATION') || msg.includes('blocked')) {
          console.warn(`[DocumentService] RECITATION block on attempt ${attempt + 1}, retrying...`);
          continue;
        }
        throw retryError; // Non-recitation error — don't retry
      }
    }
    
    if (!content) {
      console.error('[DocumentService] All attempts blocked by RECITATION filter');
      return { success: false, error: 'Document generation was blocked by content safety filters. Please try again or simplify the request.' };
    }

    return {
      success: true,
      content: content.trim(),
      compliance: buildComplianceAuditMetadata(complianceData, additionalData, docTypeConfig)
    };
  } catch (error) {
    console.error('[DocumentService] Gemini generation error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Build the system prompt based on document type and compliance context
 */
function buildSystemPrompt(docTypeConfig, complianceData) {
  const stateName = complianceData?.stateName || 'the applicable state';
  const stateCode = complianceData?.stateCode || '';
  
  return `You are a senior attorney-level legal document drafter with expertise in residential landlord-tenant law across Mid-Atlantic states (Maryland, Virginia, D.C., Delaware, Pennsylvania, New Jersey, West Virginia).

YOUR ROLE:
- You generate legally compliant, professionally structured documents that meet or exceed the standards used by licensed attorneys and professional property management companies in ${stateName}.
- Every document you produce must be fully enforceable under the current laws of the jurisdiction that governs the rental property.
- You structure documents using the recognized legal formatting conventions for ${stateName}, including proper section numbering, defined terms, and statutory citations where appropriate.

CRITICAL RULES:
1. NEVER use generic placeholder text like "[INSERT HERE]" or "[TENANT NAME]". Use the ACTUAL values provided.
2. ALWAYS include all sections and provisions required by ${stateName} law. Omitting a legally required provision is unacceptable.
3. Use precise legal language while remaining clear and understandable to lay parties.
4. Reference relevant statutes by name and section number when appropriate (e.g., "in accordance with Maryland Real Property §8-203").
5. Structure the document with proper legal formatting: numbered sections, defined terms in quotes on first use, consistent heading hierarchy.
6. Include all mandatory disclosures required by state and federal law.
7. Late fees, security deposits, notice periods, and other regulated terms MUST conform to the specific limits set by ${stateName} law.
8. Include a severability clause, entire agreement clause, and governing law clause in all binding documents.
9. Include professional signature blocks with printed name, date, and signature lines for all required signers.
10. WRITE ALL CLAUSES IN YOUR OWN ORIGINAL WORDS. Do not reproduce any copyrighted lease template verbatim. Paraphrase standard legal provisions while preserving their legal meaning and enforceability.

DOCUMENT FORMATTING:
- Use "# " for the document title
- Use "## " for major section headings (numbered: "## 1. PARTIES AND PROPERTY")
- Use "### " for subsections
- Use "**bold text**" for defined terms, important clauses, and labels
- Use "- " for bullet points where appropriate
- Use "---" for horizontal separators between major sections
- Do NOT use markdown tables — use structured text instead
- Write amounts in both numerals and words: "$4,300.00 (Four Thousand Three Hundred Dollars and Zero Cents)"`;
}

function buildDocumentPrompt(docTypeConfig, data) {
  // Format dates nicely if provided
  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };
  
  // Format currency
  const formatCurrency = (amount) => {
    if (!amount) return null;
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num)) return null;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
  };

  // Number to words for legal amounts
  const numberToWords = (num) => {
    if (!num) return null;
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return null;
    const ones = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const scales = ['', 'Thousand', 'Million'];
    
    if (n === 0) return 'Zero';
    const dollars = Math.floor(n);
    const cents = Math.round((n - dollars) * 100);
    
    function convertChunk(num) {
      if (num === 0) return '';
      if (num < 20) return ones[num];
      if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '');
      return ones[Math.floor(num / 100)] + ' Hundred' + (num % 100 ? ' ' + convertChunk(num % 100) : '');
    }
    
    let result = '';
    let remaining = dollars;
    let scaleIndex = 0;
    while (remaining > 0) {
      const chunk = remaining % 1000;
      if (chunk > 0) {
        const chunkStr = convertChunk(chunk) + (scales[scaleIndex] ? ' ' + scales[scaleIndex] : '');
        result = chunkStr + (result ? ' ' + result : '');
      }
      remaining = Math.floor(remaining / 1000);
      scaleIndex++;
    }
    
    result += ' Dollars';
    result += cents > 0 ? ' and ' + convertChunk(cents) + ' Cents' : ' and Zero Cents';
    return result;
  };

  const leaseStartFormatted = formatDate(data.leaseStartDate);
  const leaseEndFormatted = formatDate(data.leaseEndDate);
  const monthlyRentFormatted = formatCurrency(data.monthlyRent);
  const securityDepositFormatted = formatCurrency(data.securityDeposit);
  const monthlyRentWords = numberToWords(data.monthlyRent);
  const securityDepositWords = numberToWords(data.securityDeposit);

  // Determine state for compliance
  const stateCode = data.complianceData?.stateCode || extractStateFromAddress(data.propertyAddress);
  const stateLaws = data.complianceData?.staticCompliance || getStateLaws(stateCode);

  let basePrompt = `Generate a COMPLETE, PROFESSIONAL ${docTypeConfig.name} document for a residential rental property.

**IMPORTANT:** Use the ACTUAL values provided below. Do NOT use placeholders. Insert real values directly.

**Property & Parties Information:**
- Property Address: ${data.propertyAddress || 'Address not provided'}
- Landlord/Property Owner: ${data.landlordName || 'Owner name not provided'}
- Tenant Name: ${data.tenantName || 'Tenant name not provided'}
- Document Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
`;

  // Add lease/financial details if available
  if (leaseStartFormatted || leaseEndFormatted || monthlyRentFormatted) {
    basePrompt += `
**Lease & Financial Details:**`;
    if (leaseStartFormatted) basePrompt += `
- Lease Start Date: ${leaseStartFormatted}`;
    if (leaseEndFormatted) basePrompt += `
- Lease End Date: ${leaseEndFormatted}`;
    if (monthlyRentFormatted) basePrompt += `
- Monthly Rent: ${monthlyRentFormatted} (${monthlyRentWords})`;
    if (securityDepositFormatted) basePrompt += `
- Security Deposit: ${securityDepositFormatted} (${securityDepositWords})`;
    basePrompt += '\n';
  }

  // Add property details if available
  if (data.propertyBeds || data.propertyBaths || data.propertySqft) {
    basePrompt += `
**Property Details:**`;
    if (data.propertyBeds) basePrompt += `
- Bedrooms: ${data.propertyBeds}`;
    if (data.propertyBaths) basePrompt += `
- Bathrooms: ${data.propertyBaths}`;
    if (data.propertySqft) basePrompt += `
- Square Feet: ${data.propertySqft.toLocaleString()}`;
    basePrompt += '\n';
  }

  // Add the compliance context from the research service
  if (data.complianceData?.complianceContext) {
    basePrompt += `
=============================================================
LEGAL COMPLIANCE CONTEXT — YOU MUST FOLLOW THESE REQUIREMENTS
=============================================================
${data.complianceData.complianceContext}
=============================================================
`;
  } else if (stateCode && stateLaws) {
    // Fallback to static compliance if research service didn't run
    basePrompt += `
=============================================================
LEGAL COMPLIANCE CONTEXT (Static Database)
=============================================================
${buildComplianceContext(stateCode, data.propertyAddress, {
  propertyYearBuilt: data.propertyYearBuilt,
  monthlyRent: data.monthlyRent
})}
=============================================================
`;
  }

  basePrompt += '\n';

  // Document-type-specific instructions — now much more detailed and legally structured
  const typeSpecificInstructions = {
    lease_agreement: buildLeaseAgreementInstructions(data, stateLaws, stateCode),
    lease_amendment: buildLeaseAmendmentInstructions(data, stateLaws),
    move_in_checklist: buildMoveInChecklistInstructions(data, stateLaws),
    move_out_checklist: buildMoveOutChecklistInstructions(data, stateLaws),
    notice_to_vacate: buildNoticeToVacateInstructions(data, stateLaws),
    notice_to_quit: buildNoticeToQuitInstructions(data, stateLaws),
    rent_increase_notice: buildRentIncreaseInstructions(data, stateLaws, formatCurrency),
    pet_addendum: buildPetAddendumInstructions(data, stateLaws),
    maintenance_authorization: buildMaintenanceAuthInstructions(data, stateLaws)
  };

  let prompt = basePrompt;
  
  if (typeSpecificInstructions[docTypeConfig.id]) {
    prompt += typeSpecificInstructions[docTypeConfig.id];
  }

  if (data.customInstructions) {
    prompt += `\n\n**Additional Landlord Requirements:**\n${data.customInstructions}\n(Incorporate these requirements into the document while ensuring they comply with applicable state law. If any custom requirement conflicts with state law, include the legally compliant version instead and note the limitation.)`;
  }

  prompt += `

**FINAL INSTRUCTIONS:**
- Generate the COMPLETE document — do not summarize or abbreviate any sections.
- The document should be 5-15 pages when printed, depending on document type.
- For lease agreements, target 8-12 pages of substantive content.
- Include proper legal headers, section numbers, and defined terms.
- End with complete signature blocks for all required parties.
- Do NOT include any commentary, notes to the user, or explanations outside the document itself.
- Output ONLY the document content.`;

  return prompt;
}

// ============================================================================
// PROFESSIONAL DOCUMENT STRUCTURE BUILDERS
// ============================================================================

function buildLeaseAgreementInstructions(data, stateLaws, stateCode) {
  const state = stateLaws?.stateName || 'the applicable state';
  const depositReturn = stateLaws?.securityDeposit?.returnDeadline || '30 days';
  const depositMax = stateLaws?.securityDeposit?.maxAmount || '2 months\' rent';
  const lateFeeMax = stateLaws?.rentRules?.lateFeeMax || 'as allowed by law';
  const entryNotice = stateLaws?.landlordEntry?.noticeRequired || '24 hours';
  const gracePeriod = stateLaws?.rentRules?.gracePeriod || 'per state law';
  const governingStatute = stateLaws?.governingStatute || '';
  
  return `
**DOCUMENT STRUCTURE — RESIDENTIAL LEASE AGREEMENT**
Generate a complete, attorney-quality residential lease agreement with the following sections.
Number all major sections sequentially (1, 2, 3...). Use subsections (a, b, c) within each section.

REQUIRED SECTIONS (in this order):

## PREAMBLE
- Full title: "RESIDENTIAL LEASE AGREEMENT"
- Opening statement identifying this as a legally binding agreement
- Date of agreement, parties (full names), and "hereinafter" definitions for "Landlord", "Tenant", "Premises", "Agreement"
- Statement that the Landlord and Tenant may collectively be referred to as "the Parties"

## 1. PARTIES AND PROPERTY
- Full legal names of Landlord and Tenant
- Complete property address including unit number if applicable
- Property description (type, bedrooms, bathrooms, square footage)
- Define the property as the "Premises"

## 2. TERM OF LEASE
- Fixed term with exact start and end dates
- What happens at lease expiration (month-to-month conversion or vacate)
- Renewal terms and notice requirements
- Holdover tenancy provisions and any increased rent for holdover
${stateLaws?.leaseTermination ? `- MUST COMPLY: Month-to-month notice requirements: Landlord ${stateLaws.leaseTermination.monthToMonthNotice.landlord}, Tenant ${stateLaws.leaseTermination.monthToMonthNotice.tenant}` : ''}

## 3. RENT
- Monthly rent amount in numerals AND words
- Due date (typically the 1st of each month)
- Accepted payment methods
- Where/how to submit payment
- Prorated rent for partial months (if applicable)

## 4. LATE FEES AND RETURNED PAYMENTS
- Grace period: ${gracePeriod}
- Late fee amount (MUST NOT EXCEED: ${lateFeeMax})
- NSF/returned check fee (typically $25-50)
- How late fees accrue (one-time or daily — must be reasonable)

## 5. SECURITY DEPOSIT
- Deposit amount in numerals and words
- Maximum allowed: ${depositMax}
- Purpose of the deposit
${stateLaws?.securityDeposit?.holdingRequirements ? `- Holding requirements: ${stateLaws.securityDeposit.holdingRequirements}` : '- How deposit will be held (escrow account)'}
${stateLaws?.securityDeposit?.interestRequired ? `- Interest: ${stateLaws.securityDeposit.interestDetails}` : ''}
- Conditions for deductions (damage beyond normal wear and tear, unpaid rent, cleaning, etc.)
- Return deadline: ${depositReturn}
- Requirement for itemized statement of deductions
- Tenant's right to dispute deductions
${stateLaws?.securityDeposit?.penaltyForNonCompliance ? `- Landlord penalty for non-compliance: ${stateLaws.securityDeposit.penaltyForNonCompliance}` : ''}
${stateLaws?.securityDeposit?.statuteReference ? `- Statutory reference: ${stateLaws.securityDeposit.statuteReference}` : ''}

## 6. USE OF PREMISES
- Permitted use (private residential dwelling only)
- Maximum occupancy
- Prohibition on illegal activities
- Compliance with homeowner association rules (if applicable)
- Prohibition on disturbing neighbors

## 7. CONDITION OF PREMISES AND MOVE-IN INSPECTION
- Landlord represents the premises are in habitable condition
- Move-in inspection procedure (walk-through within 3-5 days)
- Written condition report signed by both parties
- Tenant right to document pre-existing conditions

## 8. MAINTENANCE AND REPAIRS
(a) **Landlord's Obligations:**
- Maintain the structural integrity (roof, foundation, exterior walls)
- Maintain major building systems (plumbing, HVAC, electrical, water heating)
- Maintain provided appliances in working order
- Comply with all applicable building and housing codes
- Make repairs within a reasonable time after written notice from Tenant
${stateLaws?.habitabilityStandards ? `- Comply with implied warranty of habitability per ${stateLaws.habitabilityStandards.statuteReference || 'state law'}` : ''}

(b) **Tenant's Obligations:**
- Keep the premises clean, sanitary, and in good condition
- Properly operate plumbing, electrical, and HVAC systems
- Promptly notify Landlord in writing of needed repairs
- Not cause or permit damage beyond normal wear and tear
- Responsible for damage caused by Tenant, household members, or guests
- Not alter, modify, or make improvements without written consent
- Maintain smoke/CO detectors (battery replacement)

## 9. UTILITIES AND SERVICES
- Which utilities Tenant is responsible for (electricity, gas, water, sewer, trash, internet, cable)
- Which utilities Landlord provides (if any)
- Requirement to keep utilities active throughout the lease
- Utility transfer responsibility at move-in and move-out

## 10. ALTERATIONS AND IMPROVEMENTS
- No alterations without prior written consent
- Approved alterations may become property of Landlord
- Tenant must restore premises to original condition (unless waived)
- Prohibition on painting, wallpaper, or permanent fixtures without consent

## 11. RIGHT OF ENTRY
- Minimum notice: ${entryNotice}
- Purposes: inspections, repairs, showings, emergencies
- Emergency entry without notice permitted
- Entry during reasonable hours only
- Tenant cooperation with showings during final 60 days
${stateLaws?.landlordEntry?.statuteReference ? `- Per ${stateLaws.landlordEntry.statuteReference}` : ''}

## 12. PETS
- Default: No pets without prior written Pet Addendum
- Service animals and emotional support animals exempt per Fair Housing Act
- Pet deposit and pet rent (if applicable) per separate addendum
- Unauthorized pet penalties

## 13. SMOKING POLICY
- Smoking prohibited in all interior spaces
- Smoking (if permitted outdoors) must be at specified distance from building
- Includes cigarettes, e-cigarettes, vaping, marijuana, etc.
- Violation may result in cleaning fees and/or lease termination

## 14. INSURANCE
(a) **Renter's Insurance Requirement:**
- Tenant must maintain renter's insurance throughout the lease term
- Minimum coverage: $100,000 liability, $25,000 personal property (or as specified)
- Landlord to be named as additional interested party
- Proof of insurance due within 14 days of lease signing
(b) **Landlord's Insurance:**
- Landlord maintains building/property insurance
- Landlord's insurance does NOT cover Tenant's personal property

## 15. ASSIGNMENT AND SUBLETTING
- No assignment or subletting without prior written consent
- Consent may be withheld at Landlord's sole discretion
- Unauthorized subletting is grounds for termination

## 16. DEFAULT AND REMEDIES
- Events of default (non-payment, lease violation, illegal activity, abandonment)
- Notice and cure periods per state law
- Landlord's remedies (eviction, damages, acceleration of rent if permitted)
- Tenant remains liable for rent through lease term or re-rental
- Attorney fees and court costs to prevailing party

## 17. TERMINATION AND SURRENDER
- Move-out procedures and requirements
- Cleaning requirements
- Key and access device return
- Final walk-through inspection
- Forwarding address for deposit return
${stateLaws?.leaseTermination?.earlyTerminationRights ? `- Early termination rights: ${stateLaws.leaseTermination.earlyTerminationRights}` : ''}

## 18. RULES AND REGULATIONS
- Compliance with all laws and ordinances
- Quiet enjoyment (no excessive noise, especially 10 PM–8 AM)
- Proper trash disposal and recycling
- Parking rules (if applicable)
- Common area use (if applicable)
- Guest policies

## 19. DISCLOSURES
${stateLaws?.requiredDisclosures ? stateLaws.requiredDisclosures.map((d, i) => `(${String.fromCharCode(97 + i)}) **${d.name}:** ${d.description} (${d.statuteReference})`).join('\n') : `- Lead paint disclosure (pre-1978 properties)
- Mold disclosure (if known)
- Flood zone disclosure
- Any known material defects`}

## 20. LEAD-BASED PAINT DISCLOSURE
(Include this section if property was built before 1978)
- Lead Warning Statement per 42 U.S.C. §4852d
- Landlord disclosure of known lead-based paint or hazards
- Tenant acknowledgment of receipt of EPA pamphlet
- Tenant's 10-day inspection opportunity

## 21. MOLD AND ENVIRONMENTAL
- Landlord disclosure of known mold or environmental hazards
- Tenant obligation to maintain proper ventilation and promptly report moisture/mold
- Remediation responsibilities

## 22. NOTICES
- How notices must be delivered (written, certified mail, hand delivery, email if agreed)
- Addresses for notices (Landlord and Tenant)
- When notices are deemed received

## 23. ANTI-RETALIATION
${stateLaws?.eviction?.retaliationProtection ? `- ${stateLaws.eviction.retaliationProtection}` : '- Landlord shall not retaliate against Tenant for exercising legal rights, filing complaints, or organizing'}

## 24. SEVERABILITY
- If any provision is found invalid or unenforceable, remaining provisions continue in full force

## 25. ENTIRE AGREEMENT
- This Agreement constitutes the entire agreement between the Parties
- Supersedes all prior negotiations, representations, and agreements
- May only be modified in writing signed by both Parties

## 26. GOVERNING LAW
- Governed by the laws of ${state}
${governingStatute ? `- Specifically, ${governingStatute}` : ''}
- Disputes resolved in the courts of the county/city where the property is located

## 27. ADDITIONAL TERMS
- Space for any additional negotiated terms
- "No additional terms" if none specified

## 28. SIGNATURES AND EXECUTION
- "IN WITNESS WHEREOF" execution statement
- Provide this exact format for signature blocks:

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________

## EXHIBITS AND ADDENDA
- List any attached exhibits (Move-In Inspection Report, Lead Paint Disclosure, Pet Addendum, etc.)
- Note: "The following exhibits, if attached, are incorporated by reference into this Agreement"
`;
}

function buildLeaseAmendmentInstructions(data, stateLaws) {
  const state = stateLaws?.stateName || 'the applicable state';
  return `
**DOCUMENT STRUCTURE — LEASE AMENDMENT**
Generate a professional lease amendment with the following sections:

## PREAMBLE
- Title: "AMENDMENT TO RESIDENTIAL LEASE AGREEMENT"
- "This Amendment ('Amendment') is entered into on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}"
- Between ${data.landlordName || 'Landlord'} ("Landlord") and ${data.tenantName || 'Tenant'} ("Tenant")
- Property address: ${data.propertyAddress || 'Property Address'}

## 1. RECITALS
- References the original lease agreement date
- States that the parties wish to amend certain terms

## 2. AMENDMENTS
- Clearly state each provision being modified
- Quote the original language, then state the new language
- "Section [X] is hereby deleted in its entirety and replaced with the following: ..."

## 3. EFFECTIVE DATE
- When the amendments take effect

## 4. RATIFICATION
- All other terms and conditions of the original lease remain in full force and effect
- In the event of conflict, this Amendment controls

## 5. GOVERNING LAW
- Governed by the laws of ${state}

## 6. SIGNATURES
**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________
`;
}

function buildMoveInChecklistInstructions(data, stateLaws) {
  const state = stateLaws?.stateName || 'the applicable state';
  const moveInReq = stateLaws?.requiredDisclosures?.find(d => 
    d.name.includes('Move-In') || d.name.includes('Damage Disclosure') || d.name.includes('Inspection'));
  
  return `
**DOCUMENT STRUCTURE — MOVE-IN CONDITION INSPECTION REPORT**
Generate a comprehensive professional move-in inspection report.

## HEADER
- Title: "MOVE-IN CONDITION INSPECTION REPORT"
- Property: ${data.propertyAddress || 'Property Address'}
- Landlord: ${data.landlordName || 'Property Owner'}
- Tenant: ${data.tenantName || 'Tenant'}
- Inspection Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Move-In Date: ________________________
${moveInReq ? `\n**Legal Note:** ${moveInReq.description} (${moveInReq.statuteReference})` : ''}

## INSTRUCTIONS
- Both parties should inspect each area together
- Rate condition as: Excellent / Good / Fair / Poor / N/A
- Note any damage, stains, scratches, or defects in the "Notes" column
- Take photographs of any existing damage
${stateLaws?.stateName === 'Maryland' ? '- Tenant has 15 days to add to this list per Md. Code, Real Prop. §8-203.1' : ''}
${stateLaws?.stateName === 'Virginia' ? '- Tenant must sign within 5 days of receipt per Va. Code §55.1-1214' : ''}

## INSPECTION AREAS
For EACH of the following areas, create a detailed checklist with Condition Rating and Notes fields:

### ENTRANCE/FOYER
- Front door (condition, locks, deadbolt, weather stripping)
- Doorbell/intercom
- Flooring
- Walls and paint
- Light fixtures
- Closet (if applicable)

### LIVING ROOM
- Flooring (type and condition)
- Walls and paint
- Ceiling
- Windows (operation, locks, screens, blinds/curtains)
- Light fixtures
- Electrical outlets (count and working)
- Fireplace (if applicable)

### KITCHEN
- Flooring
- Walls and paint
- Countertops
- Cabinets and drawers (condition, hardware)
- Sink and faucet
- Garbage disposal
- Dishwasher
- Refrigerator (including freezer, ice maker)
- Oven/range (stovetop and oven)
- Microwave (if built-in)
- Exhaust hood/fan
- Light fixtures
- Electrical outlets
- Pantry (if applicable)

### DINING ROOM (if separate)
- Flooring
- Walls and paint
- Windows
- Light fixtures
- Electrical outlets

### BEDROOM 1 (Master)
- Flooring
- Walls and paint
- Ceiling
- Windows
- Closet(s)
- Light fixtures
- Electrical outlets

### BEDROOM 2
(Same categories as Bedroom 1)

### BEDROOM 3 (if applicable based on ${data.propertyBeds || 'property details'} bedrooms)
(Same categories as Bedroom 1)

### BATHROOM 1 (Master/Primary)
- Flooring
- Walls and paint
- Bathtub/shower (condition, caulking)
- Toilet
- Sink and faucet
- Vanity/cabinets
- Mirror
- Towel bars/hooks
- Exhaust fan
- Light fixtures
- Electrical outlets (GFCI)

### BATHROOM 2
(Same categories as Bathroom 1)

### BATHROOM 3 (if applicable based on ${data.propertyBaths || 'property details'} bathrooms)
(Same categories as Bathroom 1)

### LAUNDRY AREA
- Washer connections
- Dryer connections/venting
- Flooring
- Shelving/storage

### HALLWAYS AND STAIRS
- Flooring
- Walls and paint
- Handrails
- Light fixtures

### GARAGE/CARPORT (if applicable)
- Door operation (manual/automatic)
- Remote control(s)
- Flooring
- Lighting
- Walls

### EXTERIOR/OUTDOOR (if applicable)
- Front yard/landscaping condition
- Back yard condition
- Patio/deck condition
- Fencing
- Exterior lighting
- Sprinkler system
- Mailbox

### GENERAL SYSTEMS
- HVAC / heating system (type: ________________)
- Air conditioning (type: ________________)
- Water heater
- Smoke detectors (locations and working: ________________)
- Carbon monoxide detectors (locations and working: ________________)
- Fire extinguisher (if provided)
- Security system (if applicable)

### KEYS AND ACCESS
- Front door key: _____ copies provided
- Back/side door key: _____ copies provided
- Mailbox key: _____ copies provided
- Garage remote: _____ provided
- Gate code/fob: _____ provided
- Other: ________________________

## GENERAL NOTES
(Space for additional observations)

## ACKNOWLEDGMENT AND SIGNATURES
- Statement that both parties have inspected the premises
- Tenant acknowledges receipt of this report
- Both parties agree this accurately reflects the condition at move-in

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________
`;
}

function buildMoveOutChecklistInstructions(data, stateLaws) {
  const depositReturn = stateLaws?.securityDeposit?.returnDeadline || '30 days';
  
  return `
**DOCUMENT STRUCTURE — MOVE-OUT CONDITION INSPECTION REPORT**
Generate a comprehensive professional move-out inspection report that mirrors the move-in format.

## HEADER
- Title: "MOVE-OUT CONDITION INSPECTION REPORT"
- Property: ${data.propertyAddress || 'Property Address'}
- Landlord: ${data.landlordName || 'Property Owner'} 
- Tenant: ${data.tenantName || 'Tenant'}
- Inspection Date: ________________________
- Move-Out Date: ________________________
- Move-In Date (reference): ________________________

## INSTRUCTIONS
- Compare each area against the Move-In Inspection Report
- Rate current condition: Excellent / Good / Fair / Poor / N/A
- Note any NEW damage not on the move-in report
- Distinguish "Normal Wear and Tear" from "Tenant Damage"
- Document estimated repair/replacement costs for tenant-caused damage

## INSPECTION AREAS
Use the exact same room-by-room format as the Move-In Checklist, but add columns for:
- Move-In Condition (reference)
- Move-Out Condition (current)
- Damage Type: Normal Wear & Tear / Tenant Damage / None
- Estimated Cost (if Tenant Damage)

Include ALL rooms and areas from the move-in checklist format.

## KEYS AND ACCESS RETURNED
- All keys returned: Yes / No (list missing)
- All garage remotes returned: Yes / No
- All access devices returned: Yes / No

## SECURITY DEPOSIT RECONCILIATION
- Original deposit amount: ________________________
- Total deductions for tenant damage: ________________________
- Total deductions for unpaid rent: ________________________
- Total deductions for cleaning: ________________________
- Other deductions: ________________________
- **Amount to be returned to Tenant: ________________________**
- Refund deadline: ${depositReturn}
${stateLaws?.securityDeposit?.itemizedStatementDeadline ? `- Itemized statement must be provided within: ${stateLaws.securityDeposit.itemizedStatementDeadline}` : ''}

## FORWARDING ADDRESS FOR DEPOSIT RETURN
- Tenant forwarding address: ________________________

## ACKNOWLEDGMENT AND SIGNATURES

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________
`;
}

function buildNoticeToVacateInstructions(data, stateLaws) {
  const noticeReq = stateLaws?.leaseTermination?.monthToMonthNotice?.tenant || '30 days written notice';
  const depositReturn = stateLaws?.securityDeposit?.returnDeadline || '30 days';
  
  return `
**DOCUMENT STRUCTURE — NOTICE OF INTENT TO VACATE**
Generate a formal, professional Notice to Vacate.

## HEADER
- Title: "NOTICE OF INTENT TO VACATE"
- Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- "To:" with Landlord name and address
- "From:" with Tenant name
- "RE: Property at ${data.propertyAddress || '[Property Address]'}"

## BODY
- Formal statement of Tenant's intention to vacate the premises
- Reference to the lease agreement and any termination provisions
- Specific date Tenant intends to vacate (the "Vacate Date")
- This notice satisfies the ${noticeReq} requirement
- Request for move-out inspection walk-through
- Request for return of security deposit within ${depositReturn}

## FORWARDING ADDRESS
- Tenant's forwarding address for security deposit return and correspondence

## KEY RETURN
- Tenant's intention to return all keys and access devices on or before the Vacate Date

## FINAL RENT
- Acknowledgment of final rent payment obligations

## SIGNATURE

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________
`;
}

function buildNoticeToQuitInstructions(data, stateLaws) {
  return `
**DOCUMENT STRUCTURE — NOTICE TO QUIT / NOTICE TO CURE OR VACATE**
Generate a formal, professionally structured notice to quit.

## HEADER
- Title: "NOTICE TO QUIT" or "NOTICE TO CURE OR VACATE" (as appropriate)
- Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Certified Mail / Hand Delivered
- "To:" with Tenant name and property address
- "From:" with Landlord name

## IDENTIFICATION
- Property address
- Lease agreement date reference
- Tenant name(s)

## NOTICE
- Specific reason for the notice (non-payment, lease violation, holdover, etc.)
- Exact cure period and deadline per state law
${stateLaws?.eviction?.nonpaymentProcess ? `- Non-payment process: ${stateLaws.eviction.nonpaymentProcess}` : ''}
${stateLaws?.eviction?.breachOfLeaseProcess ? `- Breach process: ${stateLaws.eviction.breachOfLeaseProcess}` : ''}

## REQUIRED ACTION
- What the Tenant must do to cure the default (pay rent, cease behavior, etc.)
- Deadline for cure
- Consequences if not cured

## LEGAL RIGHTS
- Statement that Tenant has the right to seek legal counsel
- Reference to applicable state statute
${stateLaws?.eviction?.retaliationProtection ? `- Note: This notice is not retaliatory — ${stateLaws.eviction.retaliationProtection}` : ''}

## SIGNATURE

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**CERTIFICATE OF SERVICE**
- Method of delivery
- Date delivered/mailed
- Address delivered/mailed to
`;
}

function buildRentIncreaseInstructions(data, stateLaws, formatCurrency) {
  const noticeReq = stateLaws?.rentRules?.rentIncreaseNotice || '30 days written notice';
  
  return `
**DOCUMENT STRUCTURE — NOTICE OF RENT INCREASE**
Generate a professional, respectful rent increase notice.

## HEADER
- Title: "NOTICE OF RENT INCREASE"
- Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- "To:" Tenant name(s)
- "RE: Property at ${data.propertyAddress || '[Property Address]'}"

## NOTICE
- Reference to existing lease agreement
- Current monthly rent amount${data.monthlyRent ? `: ${formatCurrency(data.monthlyRent)}` : ''}
- New monthly rent amount (leave blank if not specified: $______________)
- Effective date of increase (leave blank if not specified: ______________)
- This notice provides at least ${noticeReq} as required by law
${stateLaws?.rentRules?.rentControlAreas && !stateLaws.rentRules.rentControlAreas.includes('No rent control') && !stateLaws.rentRules.rentControlAreas.includes('no rent control') ? `\n**RENT CONTROL NOTE:** ${stateLaws.rentRules.rentControlAreas}` : ''}

## REASON (optional)
- Brief, professional explanation (increased property taxes, maintenance costs, market adjustment, etc.)

## TENANT OPTIONS
- Tenant may accept the new rent and continue tenancy
- Tenant may provide written notice to vacate per the lease terms

## GOVERNING LAW
- Reference to applicable statute
${stateLaws?.rentRules?.statuteReference ? `- ${stateLaws.rentRules.statuteReference}` : ''}

## SIGNATURE

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________
`;
}

function buildPetAddendumInstructions(data, stateLaws) {
  const depositMax = stateLaws?.securityDeposit?.maxAmount || '2 months\' rent';
  
  return `
**DOCUMENT STRUCTURE — PET ADDENDUM TO RESIDENTIAL LEASE AGREEMENT**
Generate a comprehensive pet addendum.

## PREAMBLE
- Title: "PET ADDENDUM TO RESIDENTIAL LEASE AGREEMENT"
- Date of addendum
- Reference to original lease agreement between ${data.landlordName || 'Landlord'} and ${data.tenantName || 'Tenant'}
- Property: ${data.propertyAddress || 'Property Address'}

## 1. AUTHORIZED PET
- Pet type: ________________________
- Breed: ________________________
- Name: ________________________
- Weight: ______ lbs (Maximum weight allowed: ______ lbs)
- Color/markings: ________________________
- Age: ________________________
- License/registration number: ________________________
- Vaccination records current: Yes / No
- Spayed/neutered: Yes / No

## 2. PET DEPOSIT AND FEES
- Additional pet deposit: $________________________
- Monthly pet rent: $________________________
- Note: Pet deposit may count toward total security deposit cap (${depositMax})
- Pet deposit is refundable subject to same terms as the security deposit

## 3. FAIR HOUSING NOTICE
- Service animals and emotional support animals are NOT pets
- No pet deposit or pet rent may be charged for service/ESA animals
- Reasonable accommodation requests should be directed to Landlord

## 4. PET RULES AND RESTRICTIONS
- Pet must be kept under Tenant's control at all times
- Pet must not disturb neighbors (excessive barking, noise, odors)
- Pet waste must be cleaned up immediately
- Pet must be leashed in common areas
- Pet must not damage the premises or common areas
- Tenant must comply with all local animal ordinances
- Pet must have current vaccinations and licenses

## 5. PROHIBITED ACTIVITIES
- Breeding of animals on premises
- Keeping more than the authorized number of pets
- Harboring stray or foster animals without written consent

## 6. LIABILITY AND INDEMNIFICATION
- Tenant assumes full responsibility for all damage caused by the pet
- Tenant indemnifies Landlord against claims from pet-related injuries
- Tenant must maintain adequate renter's insurance covering pet liability

## 7. REMOVAL OF PET
- Landlord may require removal of pet for repeated violations
- 10-day written notice to cure before removal is required
- Tenant must remove unauthorized pets within 48 hours of notice

## 8. TERMS
- This addendum is incorporated into and made part of the lease agreement
- All other lease terms remain in effect

## 9. SIGNATURES

**LANDLORD:**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________

**TENANT:**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________
`;
}

function buildMaintenanceAuthInstructions(data, stateLaws) {
  const entryNotice = stateLaws?.landlordEntry?.noticeRequired || '24 hours';
  
  return `
**DOCUMENT STRUCTURE — MAINTENANCE AND REPAIR AUTHORIZATION**
Generate a professional maintenance authorization form.

## HEADER
- Title: "MAINTENANCE AND REPAIR AUTHORIZATION"
- Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
- Property: ${data.propertyAddress || 'Property Address'}
- Tenant: ${data.tenantName || 'Tenant'}
- Landlord: ${data.landlordName || 'Property Owner'}

## 1. DESCRIPTION OF WORK
- Detailed description of maintenance/repair needed: ________________________
- Location within premises: ________________________
- Date issue reported: ________________________
- Priority: Emergency / Urgent / Routine

## 2. ACCESS AUTHORIZATION
- Tenant hereby authorizes Landlord and/or Landlord's agents/contractors to enter the premises
- Preferred date: ________________________
- Preferred time window: ________________________
- Is Tenant required to be present? Yes / No
- Special access instructions: ________________________
- Minimum notice: ${entryNotice}

## 3. SCOPE OF WORK
- Authorized work: ________________________
- Estimated duration: ________________________
- Any areas of the premises off-limits: ________________________

## 4. TENANT RESPONSIBILITIES
- Remove personal items from work area
- Secure pets during maintenance
- Provide access as authorized

## 5. EMERGENCY CONTACT
- Tenant emergency contact: ________________________
- Tenant phone: ________________________

## 6. LIABILITY
- Landlord/contractor will exercise reasonable care
- Landlord not liable for minor disruptions during authorized maintenance
- Any damage caused by contractor will be repaired at no cost to Tenant

## 7. SIGNATURES

**TENANT (Authorization):**
Signature: _________________________________________________
Print Name: ${data.tenantName || 'Tenant'}
Date: ________________________

**LANDLORD (Acknowledgment):**
Signature: _________________________________________________
Print Name: ${data.landlordName || 'Property Owner'}
Date: ________________________
`
}

// ============================================================================
// DOCUMENT TEMPLATES
// ============================================================================

export const DOCUMENT_TEMPLATES = {
  notice_to_vacate: {
    title: 'Notice to Vacate',
    fields: [
      { name: 'vacateDate', label: 'Move-out Date', type: 'date', required: true },
      { name: 'forwardingAddress', label: 'Forwarding Address', type: 'text', required: true },
      { name: 'reason', label: 'Reason (optional)', type: 'textarea', required: false }
    ]
  },
  rent_increase_notice: {
    title: 'Rent Increase Notice',
    fields: [
      { name: 'currentRent', label: 'Current Monthly Rent', type: 'number', required: true },
      { name: 'newRent', label: 'New Monthly Rent', type: 'number', required: true },
      { name: 'effectiveDate', label: 'Effective Date', type: 'date', required: true },
      { name: 'reason', label: 'Reason for Increase', type: 'textarea', required: false }
    ]
  },
  pet_addendum: {
    title: 'Pet Addendum',
    fields: [
      { name: 'petType', label: 'Pet Type', type: 'select', options: ['Dog', 'Cat', 'Bird', 'Fish', 'Other'], required: true },
      { name: 'petBreed', label: 'Breed', type: 'text', required: true },
      { name: 'petName', label: 'Pet Name', type: 'text', required: true },
      { name: 'petWeight', label: 'Weight (lbs)', type: 'number', required: true },
      { name: 'petDeposit', label: 'Pet Deposit ($)', type: 'number', required: true },
      { name: 'monthlyPetRent', label: 'Monthly Pet Rent ($)', type: 'number', required: false }
    ]
  },
  lease_amendment: {
    title: 'Lease Amendment',
    fields: [
      { name: 'originalLeaseDate', label: 'Original Lease Date', type: 'date', required: true },
      { name: 'amendmentDetails', label: 'Amendment Details', type: 'textarea', required: true },
      { name: 'effectiveDate', label: 'Effective Date', type: 'date', required: true }
    ]
  },
  maintenance_authorization: {
    title: 'Maintenance Authorization',
    fields: [
      { name: 'workDescription', label: 'Description of Work', type: 'textarea', required: true },
      { name: 'preferredDate', label: 'Preferred Date', type: 'date', required: false },
      { name: 'preferredTime', label: 'Preferred Time', type: 'select', options: ['Morning (8am-12pm)', 'Afternoon (12pm-5pm)', 'Evening (5pm-8pm)', 'Anytime'], required: false },
      { name: 'accessInstructions', label: 'Access Instructions', type: 'textarea', required: false },
      { name: 'emergencyContact', label: 'Emergency Contact', type: 'text', required: true }
    ]
  }
};

export default {
  DOCUMENT_TYPES,
  DOCUMENT_STATUS,
  DOCUMENT_TEMPLATES,
  createDocument,
  getDocuments,
  getDocumentById,
  updateDocumentStatus,
  renameDocument,
  updateDocumentContent,
  deleteDocument,
  createSignatureRequest,
  verifySigningToken,
  applySignature,
  sendSignatureReminder,
  generateDocumentContent,
  generateSigningToken,
  evaluateDocumentIntegrity,
  getSignedDocumentWithSignatures,
  generateSigningReceipt,
  getSigningReceipt,
  quickComplianceCheck
};

/**
 * Get a document with embedded signatures for viewing/download
 * This creates a complete record of the signed document
 */
export async function getSignedDocumentWithSignatures(documentId) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    const docRef = await db.collection('documents').doc(documentId).get();
    if (!docRef.exists) {
      return { success: false, error: 'Document not found' };
    }

    const document = docRef.data();
    
    // Build the signature block to append to document
    let signatureBlock = '\n\n---\n\n## SIGNATURES\n\n';
    signatureBlock += `**Document ID:** ${document.id}\n`;
    signatureBlock += `**Created:** ${new Date(document.createdAt).toLocaleString()}\n`;
    
    if (document.completedAt) {
      signatureBlock += `**Fully Executed:** ${new Date(document.completedAt).toLocaleString()}\n`;
    }
    
    signatureBlock += '\n';

    // Add each signature
    const signatures = [];
    if (document.signatureRequests) {
      for (const req of document.signatureRequests) {
        const sigData = {
          name: req.signerName,
          role: req.signerRole,
          email: req.signerEmail,
          status: req.status,
          signedAt: req.signedAt ? new Date(req.signedAt).toLocaleString() : null,
          signatureImage: req.signature || null,
          ipAddress: req.ipAddress || null
        };
        signatures.push(sigData);
        
        signatureBlock += `### ${req.signerName} (${req.signerRole.charAt(0).toUpperCase() + req.signerRole.slice(1)})\n`;
        if (req.status === 'signed') {
          signatureBlock += `**Status:** ✅ Signed\n`;
          signatureBlock += `**Signed At:** ${new Date(req.signedAt).toLocaleString()}\n`;
          signatureBlock += `**IP Address:** ${req.ipAddress || 'N/A'}\n`;
          if (req.signature) {
            signatureBlock += `\n![Signature](${req.signature})\n`;
          }
        } else {
          signatureBlock += `**Status:** ⏳ Pending\n`;
        }
        signatureBlock += '\n';
      }
    }

    // Add audit trail summary
    if (document.auditLog && document.auditLog.length > 0) {
      signatureBlock += '### Audit Trail\n';
      for (const entry of document.auditLog) {
        signatureBlock += `- ${new Date(entry.timestamp).toLocaleString()}: ${entry.action} by ${entry.signerName || entry.signerId} (${entry.signerRole})`;
        if (entry.ipAddress) signatureBlock += ` | IP: ${entry.ipAddress}`;
        signatureBlock += '\n';
      }
      signatureBlock += '\n';
    }

    const integrityVerification = evaluateDocumentIntegrity(document);

    // Tamper detection: verify sealed document integrity
    if (integrityVerification.status !== 'NOT_SEALED') {
      signatureBlock += '### Document Integrity Verification\n';
      if (integrityVerification.tamperDetected) {
        signatureBlock += `**⚠️ WARNING: Document integrity check FAILED.** ${integrityVerification.explanation}\n`;
        signatureBlock += `Stored completion seal: ${integrityVerification.sealedHash}\n`;
        signatureBlock += `Current recomputed seal: ${integrityVerification.currentHash}\n`;
      } else {
        signatureBlock += `**✅ Document integrity verified.** ${integrityVerification.explanation}\n`;
        signatureBlock += `Stored completion seal: ${integrityVerification.sealedHash}\n`;
        if (integrityVerification.verifiedWithLabel) {
          signatureBlock += `Verified using: ${integrityVerification.verifiedWithLabel}\n`;
        }
        signatureBlock += `Sealed at: ${integrityVerification.sealedAt ? new Date(integrityVerification.sealedAt).toLocaleString() : 'N/A'}\n`;
      }
      signatureBlock += `Verification scope: ${integrityVerification.verificationScope}\n`;
      signatureBlock += '\n';
    }

    // Add ESIGN compliance notice
    signatureBlock += '### Legal Compliance\n';
    signatureBlock += 'This document was electronically signed in accordance with the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN Act, 15 U.S.C. §7001 et seq.) and the Uniform Electronic Transactions Act (UETA). ';
    signatureBlock += 'All signers consented to electronic transaction and were provided the required ESIGN disclosure prior to signing. ';
    signatureBlock += 'Electronic signatures on this document are legally binding and enforceable.\n\n';

    // Add document hash for verification
    signatureBlock += `\n**Document Content Hash:** ${computeDocumentContentHash(document.content || '')}\n`;

    return {
      success: true,
      document: {
        ...document,
        contentWithSignatures: (document.content || '') + signatureBlock
      },
      signatures,
      integrityVerification
    };
  } catch (error) {
    console.error('[DocumentService] Error getting signed document:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// SIGNING RECEIPT / CERTIFICATE OF COMPLETION
// ============================================================================

/**
 * Generate a signing receipt (Certificate of Completion) after a document
 * has been signed. The receipt is saved to the `signing_receipts` Firestore
 * collection and linked to both the property owner and tenant accounts.
 *
 * Models the structure shown in a standard DocuSign Certificate of Completion:
 *  - Envelope / Document metadata
 *  - Record tracking (status, holder, location)
 *  - Signer events with signature images, timestamps, IP addresses
 *  - Delivery / copy events
 *  - Envelope summary events (sent → delivered → signed → completed)
 *  - Electronic Record and Signature Disclosure (ERSD)
 */
export async function generateSigningReceipt(documentId) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  try {
    const docRef = await db.collection('documents').doc(documentId).get();
    if (!docRef.exists) {
      return { success: false, error: 'Document not found' };
    }

    const document = docRef.data();

    // Only generate receipt for documents that have at least one signature
    const signedRequests = (document.signatureRequests || []).filter(r => r.status === 'signed');
    if (signedRequests.length === 0) {
      return { success: false, error: 'No signatures have been applied to this document yet' };
    }

    // Build envelope / certificate ID
    const receiptId = `receipt_${documentId}_${Date.now()}`;
    const envelopeId = crypto.randomUUID
      ? crypto.randomUUID().toUpperCase()
      : crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toUpperCase();

    const integrityVerification = evaluateDocumentIntegrity(document);

    // -- Signer events ---------------------------------------------------
    const signerEvents = (document.signatureRequests || []).map(req => {
      const auditEntry = (document.auditLog || []).find(
        a => a.action === 'signature_applied' && a.signerEmail === req.signerEmail
      );
      return {
        name: req.signerName,
        email: req.signerEmail,
        role: req.signerRole,
        securityLevel: 'Email, Account Authentication',
        authenticationMethod: auditEntry?.esignConsent?.consentMethod || 'checkbox_acknowledgment',
        signatureAdoption: 'Pre-selected Style',
        signatureImage: req.signature || null,
        ipAddress: req.ipAddress || auditEntry?.ipAddress || null,
        userAgent: req.userAgent || auditEntry?.userAgent || null,
        status: req.status,
        sentAt: req.requestedAt || null,
        viewedAt: req.viewedAt || req.requestedAt || null,
        signedAt: req.signedAt || null,
        esignConsent: {
          given: auditEntry?.esignConsent?.consentGiven ?? req.esignConsentGiven ?? false,
          disclosureProvided: auditEntry?.esignConsent?.disclosureProvided ?? req.esignDisclosureProvided ?? false,
          disclosureType: 'ESIGN_Act_UETA_full_disclosure',
          consentTimestamp: auditEntry?.esignConsent?.consentTimestamp || req.ersdConsentTimestamp || req.signedAt || null
        }
      };
    });

    // -- Envelope summary events ------------------------------------------
    const envelopeSummaryEvents = [];

    // 1. Sent
    const firstRequest = (document.signatureRequests || [])
      .filter(r => r.requestedAt)
      .sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt))[0];
    if (firstRequest) {
      envelopeSummaryEvents.push({
        event: 'Envelope Sent',
        status: 'Hashed/Encrypted',
        timestamp: firstRequest.requestedAt
      });
    }

    // 2. Delivered (first view)
    const firstSigned = signedRequests
      .filter(r => r.signedAt)
      .sort((a, b) => new Date(a.signedAt) - new Date(b.signedAt))[0];
    if (firstSigned) {
      envelopeSummaryEvents.push({
        event: 'Certified Delivered',
        status: 'Security Checked',
        timestamp: firstSigned.signedAt
      });
    }

    // 3. Signing complete (last signer)
    const lastSigned = signedRequests
      .filter(r => r.signedAt)
      .sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt))[0];
    if (lastSigned) {
      envelopeSummaryEvents.push({
        event: 'Signing Complete',
        status: 'Security Checked',
        timestamp: lastSigned.signedAt
      });
    }

    // 4. Completed
    if (document.completedAt) {
      envelopeSummaryEvents.push({
        event: 'Completed',
        status: 'Security Checked',
        timestamp: document.completedAt
      });
    }

    // -- Carbon copy events (owner always gets a copy) --------------------
    const carbonCopyEvents = [];
    if (document.ownerId) {
      carbonCopyEvents.push({
        name: 'Property Owner',
        email: document.ownerEmail || null,
        role: 'Owner',
        status: 'COPIED',
        sentAt: document.completedAt || lastSigned?.signedAt || null
      });
    }

    // -- Build the ERSD text ---------------------------------------------
    const ersdCreatedAt = new Date().toISOString();
    const partiesAgreed = signerEvents.map(s => s.name).join(', ');
    const platformName = 'HouseYield';
    const contactEmail = 'support@myhouseyield.com';

    const electronicRecordDisclosure = {
      createdAt: ersdCreatedAt,
      partiesAgreed,
      disclosureText: `Electronic Record and Signature Disclosure

Unless you tell us otherwise in accordance with the procedures described herein, we will provide electronically to you through the ${platformName} system all required notices, disclosures, authorizations, acknowledgements, and other documents that are required to be provided or made available to you during the course of our relationship with you. To reduce the chance of you inadvertently not receiving any notice or disclosure, we prefer to provide all of the required notices and disclosures to you by the same method and to the same address that you have given us. Thus, you can receive all the disclosures and notices electronically or in paper format through the paper mail delivery system. If you do not agree with this process, please let us know as described below.

How to contact ${platformName}:

You may contact us to let us know of your changes as to how we may contact you electronically, to request paper copies of certain information from us, and to withdraw your prior consent to receive notices and disclosures electronically as follows:

To contact us by email send messages to: ${contactEmail}

To advise ${platformName} of your new email address:

To let us know of a change in your email address where we should send notices and disclosures electronically to you, you must send an email message to us at ${contactEmail} and in the body of such request you must state: your previous email address, your new email address. We do not require any other information from you to change your email address. If you created a ${platformName} account, you may update it with your new email address through your account preferences.

To request paper copies from ${platformName}:

To request delivery from us of paper copies of the notices and disclosures previously provided by us to you electronically, you must send us an email to ${contactEmail} and in the body of such request you must state your email address, full name, mailing address, and telephone number. We will bill you for any fees at that time, if any.

To withdraw your consent with ${platformName}:

To inform us that you no longer wish to receive future notices and disclosures in electronic format you may:

i. decline to sign a document from within your signing session, and on the subsequent page, select the check-box indicating you wish to withdraw your consent, or you may;

ii. send us an email to ${contactEmail} and in the body of such request you must state your email, full name, mailing address, and telephone number. We do not need any other information from you to withdraw consent. The consequences of your withdrawing consent for online documents will be that transactions may take a longer time to process.

Required hardware and software:

The minimum system requirements for using the ${platformName} electronic signing system include: a device with internet access, a modern web browser (Chrome, Firefox, Safari, or Edge), and the ability to save or print documents for your records.

Acknowledging your access and consent to receive and sign documents electronically:

To confirm to us that you can access this information electronically, which will be similar to other electronic notices and disclosures that we will provide to you, please confirm that you have read this ERSD, and (i) that you are able to print on paper or electronically save this ERSD for your future reference and access; or (ii) that you are able to email this ERSD to an email address where you will be able to print on paper or save it for your future reference and access. Further, if you consent to receiving notices and disclosures exclusively in electronic format as described herein, then select the check-box next to 'I agree to use electronic records and signatures' before clicking 'CONTINUE' within the ${platformName} system.

By selecting the check-box next to 'I agree to use electronic records and signatures', you confirm that:

• You can access and read this Electronic Record and Signature Disclosure; and

• You can print on paper this Electronic Record and Signature Disclosure, or save or send this Electronic Record and Disclosure to a location where you can print it, for future reference and access; and

• Until or unless you notify ${platformName} as described above, you consent to receive exclusively through electronic means all notices, disclosures, authorizations, acknowledgements, and other documents that are required to be provided or made available to you by ${platformName} during the course of your relationship with ${platformName}.`
    };

    // -- Assemble the receipt object --------------------------------------
    const receipt = {
      id: receiptId,
      documentId: document.id || documentId,
      envelopeId,
      status: document.status === 'completed' ? 'Completed' : 'In Progress',

      // Document metadata
      documentTitle: document.title || 'Untitled Document',
      documentType: document.documentType || 'custom_document',
      documentPages: Math.max(1, Math.ceil((document.content || '').length / 3000)),
      certificatePages: 5,
      signaturesCount: signedRequests.length,
      initialsCount: 0,

      // Parties
      ownerId: document.ownerId || null,
      tenantId: document.tenantId || document.tenantFirebaseUid || null,
      propertyId: document.propertyId || null,

      // Envelope originator
      envelopeOriginator: {
        name: platformName,
        address: 'Electronic Document System',
        email: contactEmail
      },

      // Record tracking
      recordTracking: {
        status: 'Original',
        createdAt: document.createdAt || new Date().toISOString(),
        holder: platformName,
        holderEmail: contactEmail,
        location: 'HouseYield E-Sign Platform'
      },

      // Signer events
      signerEvents,

      // Delivery events (empty unless we add in-person, editor, agent etc.)
      inPersonSignerEvents: [],
      editorDeliveryEvents: [],
      agentDeliveryEvents: [],
      intermediaryDeliveryEvents: [],
      certifiedDeliveryEvents: [],
      carbonCopyEvents,

      // Envelope lifecycle
      envelopeSummaryEvents,

      // Integrity
      integrityVerification,

      // ERSD
      electronicRecordDisclosure,

      // Timestamps
      createdAt: new Date().toISOString(),
      completedAt: document.completedAt || null,

      // Auto-Nav / stamping settings (mirror DocuSign certificate metadata)
      autoNav: true,
      envelopeIdStamping: true,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
    };

    // -- Persist the receipt to Firestore ---------------------------------
    await db.collection('signing_receipts').doc(receiptId).set(receipt);

    // Also write a reference into the document record itself
    const existingReceipts = document.signingReceipts || [];
    existingReceipts.push({
      receiptId,
      generatedAt: receipt.createdAt,
      status: receipt.status
    });
    await db.collection('documents').doc(documentId).update({
      signingReceipts: existingReceipts,
      updatedAt: new Date().toISOString()
    });

    console.log(`[DocumentService] ✅ Signing receipt ${receiptId} generated for document ${documentId}`);

    return { success: true, receipt };
  } catch (error) {
    console.error('[DocumentService] Error generating signing receipt:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Retrieve a signing receipt by document ID.
 * Returns the most recent receipt for that document, or a specific one by receiptId.
 */
export async function getSigningReceipt(documentId, receiptId) {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }

  const hydrateReceipt = async (receipt) => {
    const docSnap = await db.collection('documents').doc(documentId).get();
    if (!docSnap.exists) {
      return receipt;
    }

    return {
      ...receipt,
      integrityVerification: evaluateDocumentIntegrity(docSnap.data())
    };
  };

  try {
    if (receiptId) {
      const snap = await db.collection('signing_receipts').doc(receiptId).get();
      if (!snap.exists) {
        return { success: false, error: 'Receipt not found' };
      }
      return { success: true, receipt: await hydrateReceipt(snap.data()) };
    }

    // Find most recent receipt for this document
    const snap = await db.collection('signing_receipts')
      .where('documentId', '==', documentId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      // Auto-generate if document qualifies
      const docSnap = await db.collection('documents').doc(documentId).get();
      if (!docSnap.exists) {
        return { success: false, error: 'Document not found' };
      }
      const doc = docSnap.data();
      const hasSigs = (doc.signatureRequests || []).some(r => r.status === 'signed');
      if (hasSigs) {
        return generateSigningReceipt(documentId);
      }
      return { success: false, error: 'No signing receipt available for this document' };
    }

    return { success: true, receipt: await hydrateReceipt(snap.docs[0].data()) };
  } catch (error) {
    // If index error, try without ordering
    if (error.code === 9 || error.message?.includes('index')) {
      try {
        const snap = await db.collection('signing_receipts')
          .where('documentId', '==', documentId)
          .get();
        if (snap.empty) {
          return generateSigningReceipt(documentId);
        }
        const receipts = snap.docs.map(d => d.data());
        receipts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return { success: true, receipt: await hydrateReceipt(receipts[0]) };
      } catch (fallbackError) {
        console.error('[DocumentService] Fallback receipt query failed:', fallbackError);
        return { success: false, error: fallbackError.message };
      }
    }
    console.error('[DocumentService] Error getting signing receipt:', error);
    return { success: false, error: error.message };
  }
}
