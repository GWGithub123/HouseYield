/**
 * Infer HouseYield document type keys from assistant/user phrasing.
 * Pure helper — safe to unit test without Firebase.
 */

export const ASSISTANT_DOCUMENT_TYPE_KEYS = [
  'LEASE_AGREEMENT',
  'LEASE_AMENDMENT',
  'MOVE_IN_CHECKLIST',
  'MOVE_OUT_CHECKLIST',
  'NOTICE_TO_VACATE',
  'NOTICE_TO_QUIT',
  'RENT_INCREASE_NOTICE',
  'PET_ADDENDUM',
  'MAINTENANCE_AUTHORIZATION',
  'SECURITY_DEPOSIT_RECEIPT',
  'RENT_RECEIPT',
  'CUSTOM_DOCUMENT',
];

const RULES = [
  { key: 'PET_ADDENDUM', pattern: /\bpet\b.*\baddendum\b|\baddendum\b.*\bpet\b|\bpet\s+agreement\b|\bpet\s+policy\b/ },
  { key: 'LEASE_AMENDMENT', pattern: /\blease\s+amendment\b|\bamend(ment)?\s+(the\s+)?lease\b/ },
  { key: 'MOVE_IN_CHECKLIST', pattern: /\bmove[-\s]?in\s+checklist\b/ },
  { key: 'MOVE_OUT_CHECKLIST', pattern: /\bmove[-\s]?out\s+checklist\b/ },
  { key: 'NOTICE_TO_VACATE', pattern: /\bnotice\s+to\s+vacate\b|\bvacate\s+notice\b/ },
  { key: 'NOTICE_TO_QUIT', pattern: /\bnotice\s+to\s+quit\b|\beviction\s+notice\b/ },
  { key: 'RENT_INCREASE_NOTICE', pattern: /\brent\s+increase\b/ },
  { key: 'MAINTENANCE_AUTHORIZATION', pattern: /\bmaintenance\s+authorization\b|\bauthorize\s+maintenance\b/ },
  { key: 'SECURITY_DEPOSIT_RECEIPT', pattern: /\bsecurity\s+deposit\s+receipt\b/ },
  { key: 'RENT_RECEIPT', pattern: /\brent\s+receipt\b/ },
  { key: 'LEASE_AGREEMENT', pattern: /\blease\s+agreement\b|\bcreate\s+(a\s+)?lease\b|\bdraft\s+(a\s+)?lease\b/ },
];

export function normalizeDocumentTypeKey(explicit, knownTypes = null) {
  const value = String(explicit || '').trim();
  if (!value) return null;
  const upper = value.toUpperCase().replace(/[\s-]+/g, '_');
  if (knownTypes?.[upper]) return upper;
  if (ASSISTANT_DOCUMENT_TYPE_KEYS.includes(upper)) return upper;
  const lower = value.toLowerCase();
  const byId = ASSISTANT_DOCUMENT_TYPE_KEYS.find((key) => key.toLowerCase() === lower || key.toLowerCase().replace(/_/g, '') === lower.replace(/_/g, ''));
  if (byId) return byId;
  if (knownTypes) {
    const match = Object.entries(knownTypes).find(([, config]) => (
      config.id === value || config.id === lower
    ));
    if (match) return match[0];
  }
  return null;
}

export function inferDocumentTypeKey(params = {}, knownTypes = null) {
  const explicit = normalizeDocumentTypeKey(
    params.documentType || params.docType || params.type,
    knownTypes,
  );
  if (explicit) return explicit;

  const haystack = [
    params.requestSummary,
    params.title,
    params.customInstructions,
    params.instructions,
    params.notes,
    params.body,
    params.documentTitle,
  ].filter(Boolean).join(' ').toLowerCase();

  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.key;
  }

  return 'LEASE_AGREEMENT';
}

export function wantsEsignature(params = {}) {
  if (params.requestEsignature === true || params.sendForSignature === true || params.requestSignature === true) {
    return true;
  }
  const haystack = [
    params.requestSummary,
    params.customInstructions,
    params.instructions,
    params.notes,
    params.body,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\be-?sign(ature)?\b|\bsignature\b|\bsign\s+(it|this|the\s+document|the\s+addendum|the\s+lease)\b|\brequest\s+(an?\s+)?e-?sign/.test(haystack);
}
