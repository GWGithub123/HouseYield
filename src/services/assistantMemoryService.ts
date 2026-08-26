import { doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import {
  updateUserProfileFields,
  type UserProfile,
} from './firebaseService';
import type {
  AssistantMemoryExchange,
  AssistantMemoryProfile,
  AssistantMemoryProfileArrayField,
  AssistantMemoryProfileItemCreatedAt,
  AssistantMemorySessionSummary,
  AssistantMemorySnapshot,
  AssistantMemoryTopic,
} from '../types/assistantMemory';

export type AssistantConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date | string;
};

export type AssistantMemoryUserData = {
  stocks?: Array<{ ticker?: string; name?: string; value?: number }>;
  properties?: Array<{ address?: string; value?: number }>;
};

export const ASSISTANT_MEMORY_FLUSH_MESSAGE_INTERVAL = 6;
export const ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES = 6;

const ASSISTANT_MEMORY_RETENTION_DAYS = 60;
const ASSISTANT_MEMORY_MAX_SESSION_SUMMARIES = 12;
const MAX_CONTENT_LENGTH = 160;
const MAX_LIST_ITEMS = 3;
const MONEY_VALUE_SOURCE = String.raw`\$[\d,.]+(?:\s?(?:k|m|b|million|billion))?`;

const PROFILE_ARRAY_FIELDS: AssistantMemoryProfileArrayField[] = [
  'userPreferences',
  'durableFacts',
  'realEstateSearchMemory',
  'recurringGoals',
  'favoriteWorkflows',
];

const PROFILE_ARRAY_LIMITS: Record<AssistantMemoryProfileArrayField, number> = {
  userPreferences: MAX_LIST_ITEMS,
  durableFacts: 4,
  realEstateSearchMemory: 5,
  recurringGoals: MAX_LIST_ITEMS,
  favoriteWorkflows: MAX_LIST_ITEMS,
};

const PROFILE_ARRAY_MAX_LENGTHS: Record<AssistantMemoryProfileArrayField, number> = {
  userPreferences: 90,
  durableFacts: 90,
  realEstateSearchMemory: 90,
  recurringGoals: 120,
  favoriteWorkflows: 90,
};

type AssistantMemoryFieldEntry = {
  field: AssistantMemoryProfileArrayField;
  text: string;
  key: string;
  locationGroupKey: string | null;
  createdAt: string;
  specificity: number;
  order: number;
};

const TOPIC_RULES: Array<{ topic: AssistantMemoryTopic; pattern: RegExp }> = [
  { topic: 'portfolio', pattern: /\b(stock|stocks|portfolio|holding|holdings|shares|equity|equities)\b/i },
  { topic: 'netWorth', pattern: /\b(net worth|allocation|assets|liabilities|balance sheet)\b/i },
  { topic: 'properties', pattern: /\b(property|properties|unit|tenant|rent|lease|real estate)\b/i },
  { topic: 'maintenance', pattern: /\b(maintenance|repair|contractor|renovation|service request)\b/i },
  { topic: 'sensors', pattern: /\b(sensor|sensors|alert|alerts|flood|temperature|humidity|shelly)\b/i },
  { topic: 'documents', pattern: /\b(document|documents|lease builder|signature|esign|pdf|form)\b/i },
  { topic: 'dashboard', pattern: /\b(dashboard|card|widget|layout|surface)\b/i },
  { topic: 'market', pattern: /\b(market|rentcast|pricing|comps|valuation|forecast)\b/i },
  { topic: 'navigation', pattern: /\b(go to|open|navigate|show me|take me)\b/i },
];

const TOPIC_SUMMARY_LABELS: Record<AssistantMemoryTopic, string> = {
  portfolio: 'portfolio',
  netWorth: 'net worth',
  properties: 'properties',
  maintenance: 'maintenance',
  sensors: 'sensors',
  documents: 'documents',
  dashboard: 'dashboard',
  market: 'market',
  navigation: 'navigation',
};

const LEGACY_RECURRING_GOAL_LABELS = [
  'Tracks portfolio performance and stock holdings',
  'Checks net worth and asset allocation',
  'Reviews property-level portfolio details',
  'Handles maintenance and repair coordination',
  'Monitors sensor alerts and property health',
  'Uses document and lease workflows',
  'Tailors the dashboard to current tasks',
  'Looks for pricing and market insight',
  'Uses the assistant for fast in-app navigation',
];

const LEGACY_FAVORITE_WORKFLOW_LABELS = [
  'Dashboard card changes',
  'Fast page navigation',
  'Sensor alert review',
  'Maintenance triage',
  'Document workflow help',
  'Portfolio question answering',
  'Property detail review',
];

const LEGACY_DURABLE_FACT_PATTERNS = [
  /^Often evaluates single-family homes$/i,
  /^Often evaluates condos or townhomes$/i,
  /^Interested in rental property opportunities$/i,
  /^Prioritizes cash flow$/i,
  /^Values appreciation potential$/i,
  /^Explores off-market and absentee-owner opportunities$/i,
];

const LEGACY_SEARCH_MEMORY_PATTERNS = [
  /^Searching for rental properties$/i,
  /^Searching for single-family homes$/i,
  /^Searching for condos or townhomes$/i,
  /^Searching for small multifamily properties$/i,
  /^Searches prioritize cash flow$/i,
  /^Searches consider appreciation potential$/i,
  /^Searches include off-market and absentee-owner opportunities$/i,
];

const PREFERENCE_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Prefers concise answers', pattern: /\b(short|brief|concise|keep it short)\b/i },
  { label: 'Prefers step-by-step guidance', pattern: /\b(step by step|walk me through|show me how)\b/i },
  { label: 'Prefers text responses for typed prompts', pattern: /\b(text only|typed prompts?|reply in text|text response only|no voice answer)\b/i },
  { label: 'Wants direct recommendations', pattern: /\b(best option|top choice|what should i do|just tell me)\b/i },
];

const LOW_SIGNAL_MESSAGE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|sounds good|ok|okay|great|perfect|awesome|cool|sure|yes|yeah|yep|got it|understood|all right|alright)[.!]*$/i,
  /^(that works|that helps|let'?s do that|let'?s do it|please do|go ahead|do that)[.!]*$/i,
  /^(thanks so much|thank you so much|appreciate it)[.!]*$/i,
];

const MEMORY_SIGNAL_PATTERN = /\b(property|properties|portfolio|stock|stocks|rent|tenant|lease|maintenance|repair|sensor|market|pricing|analysis|dashboard|workflow|budget|range|near|net worth|allocation|buy|search|invest)\b|[$0-9]/i;
const REAL_ESTATE_SEARCH_SIGNAL_PATTERN = /\b(search(?:ing|es)?|looking for|looking at|analyze|evaluate|buy|property|properties|market|rental|off-market|absentee|invest|home|house|townhome|townhouse|condo|multifamily|duplex|triplex)\b/i;
const PROPERTY_ADDRESS_PATTERN = /\b\d{2,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|terrace|ter)\b(?:,\s*[^.;!?]+)?/i;

function cleanText(value: string, maxLength = MAX_CONTENT_LENGTH) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function trimExtractedFact(value: string, maxLength = 90) {
  return cleanText(value, maxLength)
    .replace(/\b(?:with|that|which|where|priced|between|under|around)\b.*$/i, '')
    .replace(/[\s,;:-]+$/g, '')
    .trim();
}

function toSentenceCase(value: string) {
  if (!value) {
    return value;
  }

  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function normalizeMoneyPhrase(value: string) {
  return cleanText(value, 60)
    .replace(/\s*(?:through|and)\s*/gi, ' to ')
    .replace(/\s*-\s*/g, ' to ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBudgetPreference(content: string, label: 'Budget target' | 'Search budget') {
  const rangePattern = new RegExp(
    `\\b(?:my\\s+budget(?:\\s+range)?(?:\\s+is)?|budget(?:\\s+range)?(?:\\s+is|\\s+around)?|price\\s+range(?:\\s+is)?|within|between|from)\\s*(${MONEY_VALUE_SOURCE}\\s*(?:to|-|through|and)\\s*${MONEY_VALUE_SOURCE})`,
    'i',
  );
  const rangeMatch = content.match(rangePattern);
  if (rangeMatch) {
    return `${label} ${normalizeMoneyPhrase(rangeMatch[1])}`;
  }

  const limitPattern = new RegExp(
    `\\b(?:my\\s+budget(?:\\s+is)?|budget(?:\\s+is)?|up to|under|max(?:imum)?\\s+budget(?:\\s+of)?|no more than)\\s*(${MONEY_VALUE_SOURCE})`,
    'i',
  );
  const limitMatch = content.match(limitPattern);
  if (!limitMatch) {
    return null;
  }

  const qualifier = /\bunder|no more than\b/i.test(content) ? 'under' : 'up to';
  return `${label} ${qualifier} ${normalizeMoneyPhrase(limitMatch[1])}`;
}

function normalizeLocationCandidate(value: string) {
  return cleanText(value, 70)
    .replace(/^(?:the\s+)?/i, '')
    .replace(/^(?:properties?|homes?|houses?|condos?|condominiums?|townhomes?|townhouses?|units?|opportunities?|markets?)\s+(?:in|near|around)\s+/i, '')
    .replace(/[\s,;:-]+$/g, '')
    .trim();
}

function isConcreteLocationCandidate(value: string) {
  const normalized = cleanText(value, 70).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }

  if (normalized.split(/\s+/).length > 5 && !normalized.includes(',')) {
    return false;
  }

  if (/\b(my|our|your|their|this|that|these|those|any|some|specific|various|different|nearby)\b/i.test(normalized)) {
    return false;
  }

  if (/\b(states?|cities?|areas?|markets?|locations?|neighborhoods?|section|sections?|portfolio|bookkeeping|property|properties|opportunities|search(?:es)?|cash flow|cashflow)\b/i.test(normalized)) {
    return false;
  }

  return /[a-z]/i.test(normalized);
}

function extractConcreteLocation(content: string) {
  const patterns = [
    /\b(?:properties?|homes?|houses?|condos?|condominiums?|townhomes?|townhouses?|units?|opportunities?|markets?)\s+(?:in|near|around)\s+([^.;!?]+?)(?=\s+(?:with|under|between|budget|priced|for|that|which)\b|[.;!?]|$)/i,
    /\b(?:looking for|searching for|interested in|focused on|focus on|buying in|investing in|target(?:ing)?(?:\s+search(?:es)?)?\s+(?:in|near|around)?)\s+([^.;!?]+?)(?=\s+(?:with|under|between|budget|priced|for|that|which)\b|[.;!?]|$)/i,
    /\b(?:in|near|around)\s+([^.;!?]+?)(?=\s+(?:with|under|between|budget|priced|for|that|which)\b|[.;!?]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) {
      continue;
    }

    const candidate = normalizeLocationCandidate(match[1]);
    if (isConcreteLocationCandidate(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hasExplicitSearchIntent(content: string) {
  return /\b(?:i(?:'m| am)?(?:\s+very)?\s+interested in|interested in|looking for|searching for|want|prefer|focused on|need|must have|target(?:ing)?|prioriti(?:ze|zing|y))\b/i.test(content);
}

function extractPropertyTypePreference(content: string) {
  if (!hasExplicitSearchIntent(content)) {
    return null;
  }

  if (/\brental propert(?:y|ies)|rental homes?|rentals?\b/i.test(content)) {
    return 'rental properties';
  }

  if (/\bmultifamily|multi-family|duplex|triplex|fourplex|quadplex\b/i.test(content)) {
    return 'small multifamily properties';
  }

  if (/\bsingle[- ]family homes?|single family homes?\b/i.test(content)) {
    return 'single-family homes';
  }

  if (/\bcondos?|condominiums?|townhomes?|townhouses?\b/i.test(content)) {
    return 'condos or townhomes';
  }

  return null;
}

function extractCashFlowPreference(content: string) {
  if (!/\bcash\s?flow|cashflow\b/i.test(content)) {
    return null;
  }

  if (!hasExplicitSearchIntent(content) && !/\bwith\b/i.test(content)) {
    return null;
  }

  if (/\bpositive monthly cash\s?flow|positive monthly cashflow|positive cash\s?flow|positive cashflow|cash\s?flow positive\b/i.test(content)) {
    return 'positive monthly cash flow';
  }

  if (/\bstrong monthly cash\s?flow|strong monthly cashflow|high monthly cash\s?flow|high monthly cashflow\b/i.test(content)) {
    return 'strong monthly cash flow';
  }

  if (/\bmonthly cash\s?flow|monthly cashflow\b/i.test(content)) {
    return 'monthly cash flow';
  }

  return 'cash flow';
}

function buildSearchPreferenceSummary(content: string) {
  const propertyType = extractPropertyTypePreference(content);
  const location = extractConcreteLocation(content);
  const cashFlowPreference = extractCashFlowPreference(content);

  if (!propertyType && !location && !cashFlowPreference) {
    return null;
  }

  let summary = propertyType ? `Searching for ${propertyType}` : 'Searching for properties';

  if (location) {
    summary += ` in ${location}`;
  }

  if (cashFlowPreference) {
    summary += ` with ${cashFlowPreference}`;
  }

  return cleanText(summary, 90);
}

function isMeaningfulGoalText(value: string) {
  const cleaned = cleanText(value, 120);
  if (!cleaned || cleaned.split(/\s+/).length < 4) {
    return false;
  }

  if (!/\b(net worth|cash flow|cashflow|passive income|income|portfolio|properties?|doors?|units?|equity|assets?|retire(?:ment)?|financial independence)\b/i.test(cleaned)) {
    return false;
  }

  return /[$\d]/.test(cleaned) || /\b(by|within|before|over the next|in the next)\b/i.test(cleaned);
}

function extractPropertyManagementRecurringGoal(content: string) {
  const cleaned = cleanText(content, 220);
  const hasTenantContext = /\btenant|resident|leaseholder\b/i.test(cleaned);
  const hasRentPaymentProblem = /\brent\b/i.test(cleaned)
    && /\b(?:has(?:n't| not)?\s+paid|late|behind|missed|unpaid|overdue|delinquen(?:cy|t)|non[- ]payment|past due)\b/i.test(cleaned);

  if (!hasTenantContext || !hasRentPaymentProblem) {
    return null;
  }

  if (/\b(?:action plan|plan of action|next steps|strategy|help(?: me)?|guidance|create|creating|draft|put together|what should i do|how should i handle)\b/i.test(cleaned)) {
    return 'Needs help with a tenant rent delinquency action plan';
  }

  return 'Managing a tenant rent delinquency issue';
}

function isMeaningfulOperationalRecurringGoal(value: string) {
  const cleaned = cleanText(value, 120);
  return /\btenant rent delinquency\b/i.test(cleaned);
}

function matchesLegacyLabel(value: string, labels: string[]) {
  return labels.some((label) => label.toLowerCase() === value.toLowerCase());
}

function isMeaningfulDurableFact(value: string) {
  const cleaned = cleanText(value, 90);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  if (LEGACY_DURABLE_FACT_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return false;
  }

  if (/^Interested in opportunities near /i.test(cleaned)) {
    return isConcreteLocationCandidate(cleaned.replace(/^Interested in opportunities near /i, ''));
  }

  if (/^Target market /i.test(cleaned)) {
    return isConcreteLocationCandidate(cleaned.replace(/^Target market /i, ''));
  }

  if (/^Budget /i.test(cleaned)) {
    return /[$\d]/.test(cleaned);
  }

  return true;
}

function isMeaningfulSearchMemory(value: string) {
  const cleaned = cleanText(value, 90);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  if (LEGACY_SEARCH_MEMORY_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return false;
  }

  if (/^(?:Target search area near|Search area) /i.test(cleaned)) {
    return isConcreteLocationCandidate(cleaned.replace(/^(?:Target search area near|Search area) /i, ''));
  }

  if (/^Search budget /i.test(cleaned)) {
    return /[$\d]/.test(cleaned);
  }

  return true;
}

function isMeaningfulRecurringGoal(value: string) {
  const cleaned = cleanText(value, 120);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  if (matchesLegacyLabel(cleaned, LEGACY_RECURRING_GOAL_LABELS)) {
    return false;
  }

  return isMeaningfulGoalText(cleaned) || isMeaningfulOperationalRecurringGoal(cleaned);
}

function isMeaningfulFavoriteWorkflow(value: string) {
  const cleaned = cleanText(value, 90);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  return !matchesLegacyLabel(cleaned, LEGACY_FAVORITE_WORKFLOW_LABELS);
}

function isLowSignalMessage(content: string) {
  const normalized = cleanText(content, 220);
  if (!normalized) {
    return true;
  }

  if (LOW_SIGNAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount <= 3 && !/[?$0-9]/.test(normalized)) {
    return true;
  }

  return false;
}

function isMemoryWorthyMessage(message: AssistantConversationMessage) {
  const content = cleanText(message.content, 220);
  if (!content || isLowSignalMessage(content)) {
    return false;
  }

  if (message.role === 'assistant' && /\b(sorry|error|failed|could not connect)\b/i.test(content)) {
    return false;
  }

  return MEMORY_SIGNAL_PATTERN.test(content) || content.length >= 32 || /\?/.test(content);
}

function isRealEstateSearchMessage(message: AssistantConversationMessage) {
  const content = cleanText(message.content, 220);
  if (!content || message.role !== 'user' || isLowSignalMessage(content)) {
    return false;
  }

  return REAL_ESTATE_SEARCH_SIGNAL_PATTERN.test(content);
}

function normalizeTimestamp(value: Date | string | undefined, fallbackDate: Date) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallbackDate.toISOString();
}

function mergeUnique(existing: string[], incoming: string[], limit = MAX_LIST_ITEMS) {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const value of [...incoming, ...existing]) {
    const cleaned = cleanText(value, 90);
    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(cleaned);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function createEmptyProfileItemCreatedAt(): AssistantMemoryProfileItemCreatedAt {
  return {
    userPreferences: {},
    durableFacts: {},
    realEstateSearchMemory: {},
    recurringGoals: {},
    favoriteWorkflows: {},
  };
}

function getTimestampMillis(value?: string | null) {
  if (!value) {
    return Number.NaN;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? Number.NaN : timestamp;
}

function getEarlierTimestamp(
  fallbackIso: string,
  ...values: Array<string | null | undefined>
) {
  let earliestIso: string | null = null;
  let earliestMillis = Number.POSITIVE_INFINITY;

  values.forEach((value) => {
    const timestamp = getTimestampMillis(value);
    if (Number.isNaN(timestamp) || timestamp >= earliestMillis) {
      return;
    }

    earliestMillis = timestamp;
    earliestIso = value || null;
  });

  return earliestIso || fallbackIso;
}

function normalizeMemoryToken(value: string) {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractStoredLocationCandidate(
  field: AssistantMemoryProfileArrayField,
  value: string,
) {
  const cleaned = cleanText(value, PROFILE_ARRAY_MAX_LENGTHS[field]);

  if (field === 'durableFacts') {
    const match = cleaned.match(/^Target market (.+)$/i);
    if (!match) {
      return null;
    }

    const candidate = normalizeLocationCandidate(match[1]);
    return isConcreteLocationCandidate(candidate) ? candidate : null;
  }

  if (field !== 'realEstateSearchMemory') {
    return null;
  }

  const patterns = [
    /^Search area (.+)$/i,
    /^Searching for .+? in (.+?)(?: with .+)?$/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) {
      continue;
    }

    const candidate = normalizeLocationCandidate(match[1]);
    if (isConcreteLocationCandidate(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildAssistantMemoryLocationGroupKey(
  field: AssistantMemoryProfileArrayField,
  value: string,
) {
  const location = extractStoredLocationCandidate(field, value);
  if (!location) {
    return null;
  }

  const normalizedLocation = normalizeMemoryToken(location);
  return normalizedLocation ? `market:${normalizedLocation}` : null;
}

export function buildAssistantMemoryItemKey(
  field: AssistantMemoryProfileArrayField,
  value: string,
) {
  const cleaned = cleanText(value, PROFILE_ARRAY_MAX_LENGTHS[field]);
  if (!cleaned) {
    return '';
  }

  if (field === 'durableFacts') {
    const locationGroupKey = buildAssistantMemoryLocationGroupKey(field, cleaned);
    if (locationGroupKey) {
      return `${field}:${locationGroupKey}`;
    }

    if (/^Budget target /i.test(cleaned)) {
      return `${field}:budget:${normalizeMemoryToken(cleaned.replace(/^Budget target /i, ''))}`;
    }
  }

  if (field === 'realEstateSearchMemory') {
    if (/^Recently searched /i.test(cleaned)) {
      return `${field}:address:${normalizeMemoryToken(cleaned.replace(/^Recently searched /i, ''))}`;
    }

    if (/^Search budget /i.test(cleaned)) {
      return `${field}:budget:${normalizeMemoryToken(cleaned.replace(/^Search budget /i, ''))}`;
    }

    const locationGroupKey = buildAssistantMemoryLocationGroupKey(field, cleaned);
    if (locationGroupKey) {
      const qualifiers = [
        /\brental propert(?:y|ies)|rental homes?|rentals?\b/i.test(cleaned) ? 'rental' : '',
        /\bpositive monthly cash\s?flow|positive cash\s?flow|cash\s?flow positive\b/i.test(cleaned) ? 'positive-cash-flow' : '',
        /\bsingle[- ]family homes?\b/i.test(cleaned) ? 'single-family' : '',
        /\bcondos?|condominiums?|townhomes?|townhouses?\b/i.test(cleaned) ? 'condo-townhome' : '',
        /\bmultifamily|multi-family|duplex|triplex|fourplex|quadplex\b/i.test(cleaned) ? 'multifamily' : '',
      ].filter(Boolean);

      return `${field}:${locationGroupKey}${qualifiers.length ? `:${qualifiers.join(':')}` : ''}`;
    }
  }

  if (field === 'recurringGoals' && isMeaningfulOperationalRecurringGoal(cleaned)) {
    return `${field}:tenant-rent-delinquency`;
  }

  return `${field}:${normalizeMemoryToken(cleaned)}`;
}

function getAssistantMemorySpecificity(
  field: AssistantMemoryProfileArrayField,
  value: string,
) {
  const cleaned = cleanText(value, PROFILE_ARRAY_MAX_LENGTHS[field]);

  if (field === 'realEstateSearchMemory') {
    let score = /^Search area /i.test(cleaned) ? 10 : 24;

    if (/\brental propert(?:y|ies)|rental homes?|rentals?\b/i.test(cleaned)) {
      score += 18;
    }
    if (/\bpositive monthly cash\s?flow|positive cash\s?flow|cash\s?flow positive\b/i.test(cleaned)) {
      score += 24;
    }
    if (/\bsingle[- ]family homes?|condos?|condominiums?|townhomes?|townhouses?|multifamily|multi-family|duplex|triplex|fourplex|quadplex\b/i.test(cleaned)) {
      score += 12;
    }

    return score;
  }

  if (field === 'durableFacts' && /^Target market /i.test(cleaned)) {
    return 8;
  }

  if (field === 'recurringGoals' && isMeaningfulOperationalRecurringGoal(cleaned)) {
    return /\baction plan\b/i.test(cleaned) ? 42 : 34;
  }

  return 16;
}

function normalizeProfileFieldValues(
  field: AssistantMemoryProfileArrayField,
  rawValues: unknown,
) {
  if (!Array.isArray(rawValues)) {
    return [] as string[];
  }

  return rawValues
    .map((value: unknown) => cleanText(String(value || ''), PROFILE_ARRAY_MAX_LENGTHS[field]))
    .filter((value: string) => {
      if (!value) {
        return false;
      }

      if (field === 'durableFacts') {
        return isMeaningfulDurableFact(value);
      }
      if (field === 'realEstateSearchMemory') {
        return isMeaningfulSearchMemory(value);
      }
      if (field === 'recurringGoals') {
        return isMeaningfulRecurringGoal(value);
      }
      if (field === 'favoriteWorkflows') {
        return isMeaningfulFavoriteWorkflow(value);
      }

      return true;
    });
}

function buildFieldEntries(
  field: AssistantMemoryProfileArrayField,
  values: string[],
  rawItemCreatedAt: unknown,
  fallbackIso: string,
) {
  const fallbackDate = new Date(fallbackIso);
  const safeFallbackDate = Number.isNaN(fallbackDate.getTime()) ? new Date() : fallbackDate;
  const rawFieldTimestamps = rawItemCreatedAt && typeof rawItemCreatedAt === 'object'
    ? (rawItemCreatedAt as Partial<Record<AssistantMemoryProfileArrayField, Record<string, unknown>>>)[field]
    : undefined;

  return values.map((value, index) => {
    const key = buildAssistantMemoryItemKey(field, value) || `${field}:${index}`;
    const rawTimestamp = rawFieldTimestamps && typeof rawFieldTimestamps === 'object'
      ? rawFieldTimestamps[key]
      : undefined;

    return {
      field,
      text: value,
      key,
      locationGroupKey: buildAssistantMemoryLocationGroupKey(field, value),
      createdAt: normalizeTimestamp(typeof rawTimestamp === 'string' ? rawTimestamp : undefined, safeFallbackDate),
      specificity: getAssistantMemorySpecificity(field, value),
      order: index,
    } satisfies AssistantMemoryFieldEntry;
  });
}

function dedupeEntriesByKey(
  entries: AssistantMemoryFieldEntry[],
  fallbackIso: string,
) {
  const deduped = new Map<string, AssistantMemoryFieldEntry>();

  entries.forEach((entry) => {
    const existing = deduped.get(entry.key);
    if (!existing) {
      deduped.set(entry.key, { ...entry });
      return;
    }

    const createdAt = getEarlierTimestamp(fallbackIso, existing.createdAt, entry.createdAt);
    if (entry.specificity > existing.specificity) {
      deduped.set(entry.key, {
        ...entry,
        createdAt,
        order: Math.min(existing.order, entry.order),
      });
      return;
    }

    existing.createdAt = createdAt;
    existing.order = Math.min(existing.order, entry.order);
  });

  return Array.from(deduped.values());
}

function dedupeSearchEntriesByLocation(
  entries: AssistantMemoryFieldEntry[],
  fallbackIso: string,
) {
  const passthrough: AssistantMemoryFieldEntry[] = [];
  const grouped = new Map<string, AssistantMemoryFieldEntry>();

  entries.forEach((entry) => {
    if (!entry.locationGroupKey) {
      passthrough.push(entry);
      return;
    }

    const existing = grouped.get(entry.locationGroupKey);
    if (!existing) {
      grouped.set(entry.locationGroupKey, { ...entry });
      return;
    }

    const createdAt = getEarlierTimestamp(fallbackIso, existing.createdAt, entry.createdAt);
    if (entry.specificity > existing.specificity) {
      grouped.set(entry.locationGroupKey, {
        ...entry,
        createdAt,
        order: Math.min(existing.order, entry.order),
      });
      return;
    }

    existing.createdAt = createdAt;
    existing.order = Math.min(existing.order, entry.order);
  });

  return [...passthrough, ...Array.from(grouped.values())];
}

function reconcileLocationMemoryEntries(
  durableEntries: AssistantMemoryFieldEntry[],
  searchEntries: AssistantMemoryFieldEntry[],
  fallbackIso: string,
) {
  const searchByLocation = new Map<string, AssistantMemoryFieldEntry>();
  searchEntries.forEach((entry) => {
    if (entry.locationGroupKey) {
      searchByLocation.set(entry.locationGroupKey, entry);
    }
  });

  const nextDurableEntries: AssistantMemoryFieldEntry[] = [];

  durableEntries.forEach((entry) => {
    if (!entry.locationGroupKey) {
      nextDurableEntries.push(entry);
      return;
    }

    const matchingSearchEntry = searchByLocation.get(entry.locationGroupKey);
    if (!matchingSearchEntry) {
      nextDurableEntries.push(entry);
      return;
    }

    matchingSearchEntry.createdAt = getEarlierTimestamp(
      fallbackIso,
      matchingSearchEntry.createdAt,
      entry.createdAt,
    );
    matchingSearchEntry.order = Math.min(matchingSearchEntry.order, entry.order);
  });

  return {
    durableEntries: nextDurableEntries,
    searchEntries,
  };
}

function sortMemoryEntries(entries: AssistantMemoryFieldEntry[]) {
  return [...entries].sort((left, right) => {
    const timestampDelta = getTimestampMillis(right.createdAt) - getTimestampMillis(left.createdAt);
    if (!Number.isNaN(timestampDelta) && timestampDelta !== 0) {
      return timestampDelta;
    }

    if (right.specificity !== left.specificity) {
      return right.specificity - left.specificity;
    }

    return left.order - right.order;
  });
}

function buildItemCreatedAtFromEntries(
  entriesByField: Partial<Record<AssistantMemoryProfileArrayField, AssistantMemoryFieldEntry[]>>,
) {
  const itemCreatedAt = createEmptyProfileItemCreatedAt();

  PROFILE_ARRAY_FIELDS.forEach((field) => {
    (entriesByField[field] || []).forEach((entry) => {
      itemCreatedAt[field][entry.key] = entry.createdAt;
    });
  });

  return itemCreatedAt;
}

function buildNextProfileItemCreatedAt(
  existingItemCreatedAt: AssistantMemoryProfileItemCreatedAt | undefined,
  valuesByField: Record<AssistantMemoryProfileArrayField, string[]>,
  fallbackIso: string,
) {
  const nextItemCreatedAt = createEmptyProfileItemCreatedAt();

  PROFILE_ARRAY_FIELDS.forEach((field) => {
    const existingFieldTimestamps = existingItemCreatedAt?.[field] || {};

    valuesByField[field].forEach((value) => {
      const key = buildAssistantMemoryItemKey(field, value);
      if (!key || nextItemCreatedAt[field][key]) {
        return;
      }

      nextItemCreatedAt[field][key] = existingFieldTimestamps[key] || fallbackIso;
    });
  });

  return nextItemCreatedAt;
}

function buildSessionSummaryText(
  userRequests: string[],
  assistantOutcomes: string[],
  highlightedTopics: AssistantMemoryTopic[],
) {
  const parts: string[] = [];

  if (userRequests.length > 0) {
    parts.push(`User focused on ${userRequests.join('; ')}`);
  }
  if (assistantOutcomes.length > 0) {
    parts.push(`Assistant helped with ${assistantOutcomes.join('; ')}`);
  }
  if (highlightedTopics.length > 0) {
    parts.push(`Recurring themes: ${highlightedTopics.map((topic) => TOPIC_SUMMARY_LABELS[topic]).join(', ')}`);
  }

  return parts.length > 0 ? cleanText(parts.join('. '), 220) : 'Recent assistant session saved.';
}

function summarizeMessages(
  messages: AssistantConversationMessage[],
  role: 'user' | 'assistant',
  limit = MAX_LIST_ITEMS,
) {
  const snippets: string[] = [];
  const seen = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== role) {
      continue;
    }

    if (!isMemoryWorthyMessage(message)) {
      continue;
    }

    const snippet = cleanText(message.content);
    if (!snippet) {
      continue;
    }

    const key = snippet.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    snippets.push(snippet);

    if (snippets.length >= limit) {
      break;
    }
  }

  return snippets;
}

function buildTopicCounts(messages: AssistantConversationMessage[]) {
  const counts: Partial<Record<AssistantMemoryTopic, number>> = {};

  for (const message of messages) {
    if (message.role !== 'user' || isLowSignalMessage(message.content)) {
      continue;
    }

    for (const rule of TOPIC_RULES) {
      if (rule.pattern.test(message.content)) {
        counts[rule.topic] = (counts[rule.topic] || 0) + 1;
      }
    }
  }

  return counts;
}

function sortedTopics(topicCounts: Partial<Record<AssistantMemoryTopic, number>>) {
  return Object.entries(topicCounts)
    .filter((entry): entry is [AssistantMemoryTopic, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([topic]) => topic);
}

function buildPreferenceHints(messages: AssistantConversationMessage[]) {
  const userMessages = messages.filter((message) => message.role === 'user' && isMemoryWorthyMessage(message));

  return PREFERENCE_RULES
    .filter((rule) => userMessages.some((message) => rule.pattern.test(message.content)))
    .map((rule) => rule.label);
}

function extractRecurringGoals(messages: AssistantConversationMessage[]) {
  const goals: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || !isMemoryWorthyMessage(message)) {
      continue;
    }

    const content = cleanText(message.content, 220);
    const operationalGoal = extractPropertyManagementRecurringGoal(content);
    if (operationalGoal) {
      goals.push(operationalGoal);
      if (goals.length >= MAX_LIST_ITEMS) {
        break;
      }
      continue;
    }

    const goalMatch = content.match(/\b(?:my goal is to|goal is to|i want to|i'd like to|i would like to|i am looking to|i'm looking to|i plan to|i am trying to|i'm trying to|i hope to|i aim to|i'm aiming to|working toward)\s+([^.;!?]+?)(?=[.;!?]|$)/i);
    if (!goalMatch) {
      continue;
    }

    const goal = cleanText(goalMatch[1], 120)
      .replace(/^(?:be able to|eventually)\s+/i, '')
      .trim();
    if (!isMeaningfulGoalText(goal)) {
      continue;
    }

    goals.push(toSentenceCase(goal));
    if (goals.length >= MAX_LIST_ITEMS) {
      break;
    }
  }

  return mergeUnique([], goals, MAX_LIST_ITEMS);
}

function extractDurableFacts(messages: AssistantConversationMessage[]) {
  const facts: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || !isMemoryWorthyMessage(message)) {
      continue;
    }

    const content = cleanText(message.content, 220);
    const budgetFact = extractBudgetPreference(content, 'Budget target');
    if (budgetFact) {
      facts.push(budgetFact);
    }

    const location = extractConcreteLocation(content);
    if (location) {
      facts.push(`Target market ${location}`);
    }

    if (facts.length >= 6) {
      break;
    }
  }

  return mergeUnique([], facts.filter((value) => isMeaningfulDurableFact(value)), 4);
}

function extractRealEstateSearchMemory(messages: AssistantConversationMessage[]) {
  const searchFacts: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRealEstateSearchMessage(message)) {
      continue;
    }

    const content = cleanText(message.content, 220);
    const addressMatch = content.match(PROPERTY_ADDRESS_PATTERN);
    if (addressMatch) {
      searchFacts.push(`Recently searched ${trimExtractedFact(addressMatch[0], 90)}`);
    }

    const searchPreferenceSummary = buildSearchPreferenceSummary(content);
    if (searchPreferenceSummary) {
      searchFacts.push(searchPreferenceSummary);
    }

    const budgetFact = extractBudgetPreference(content, 'Search budget');
    if (budgetFact) {
      searchFacts.push(budgetFact);
    }

    const location = extractConcreteLocation(content);
    if (location && !searchPreferenceSummary) {
      searchFacts.push(`Search area ${location}`);
    }

    if (searchFacts.length >= 8) {
      break;
    }
  }

  return mergeUnique([], searchFacts.filter((value) => isMeaningfulSearchMemory(value)), 5);
}

export function hasImmediateAssistantMemorySignal(messages: AssistantConversationMessage[]) {
  const cleanedMessages = messages
    .map((message) => ({
      role: message.role,
      content: cleanText(message.content),
      timestamp: message.timestamp,
    }))
    .filter((message) => message.content);

  if (cleanedMessages.length === 0) {
    return false;
  }

  return buildPreferenceHints(cleanedMessages).length > 0
    || extractDurableFacts(cleanedMessages).length > 0
    || extractRealEstateSearchMemory(cleanedMessages).length > 0
    || extractRecurringGoals(cleanedMessages).length > 0;
}

function isRealEstateSearchSession(session: AssistantMemorySessionSummary) {
  const summaryText = [
    session.summary,
    ...session.userRequests,
    ...session.assistantOutcomes,
  ].join(' ');

  return session.topicTags.some((topic) => topic === 'properties' || topic === 'market' || topic === 'navigation')
    && REAL_ESTATE_SEARCH_SIGNAL_PATTERN.test(summaryText);
}

function findRelevantRealEstateSearchSession(recentSessions: AssistantMemorySessionSummary[]) {
  return recentSessions.find((session) => isRealEstateSearchSession(session)) || null;
}

function buildPersonalizationGuidance(profile: AssistantMemoryProfile) {
  const guidance: string[] = [];

  if (profile.recurringGoals.some((goal) => /portfolio|net worth/i.test(goal))) {
    guidance.push('Anchor broad financial questions to the user\'s actual portfolio and net worth before giving generic advice');
  }
  if (profile.realEstateSearchMemory.length > 0 || profile.durableFacts.some((fact) => /target market|budget target/i.test(fact))) {
    guidance.push('Ground property answers in the user\'s known properties or target markets and suggest the most relevant next property step');
  }
  if (profile.realEstateSearchMemory.length > 0) {
    guidance.push('If the user asks to resume, continue, or jump back into prior property searching, explicitly recall the saved search criteria first and offer to continue from it');
  }
  if ((profile.topicCounts.dashboard || 0) > 0 || profile.favoriteWorkflows.some((workflow) => /dashboard/i.test(workflow))) {
    guidance.push('If the user is comparing information or asking what to focus on, offer dashboard card changes proactively');
  }
  if ((profile.topicCounts.maintenance || 0) > 0 || (profile.topicCounts.sensors || 0) > 0) {
    guidance.push('For operational property issues, suggest the next step such as checking alerts, maintenance status, or the right page');
  }
  if (profile.userPreferences.some((preference) => /concise/i.test(preference))) {
    guidance.push('Lead with the answer first, then offer one concrete next action');
  }

  return mergeUnique([], guidance, 4);
}

function buildPortfolioContext(userData?: AssistantMemoryUserData | null) {
  const propertyLabels = (userData?.properties || [])
    .map((property) => cleanText(property.address || '', 60))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

  const stockLabels = (userData?.stocks || [])
    .map((stock) => {
      const ticker = cleanText(stock.ticker || '', 12).toUpperCase();
      const name = cleanText(stock.name || '', 60);
      if (name && ticker && name.toLowerCase() !== ticker.toLowerCase()) {
        return `${name} (${ticker})`;
      }

      return name || ticker;
    })
    .filter(Boolean)
    .slice(0, 5);

  return {
    commonProperties: propertyLabels,
    portfolioContext: stockLabels,
  };
}

function pruneSessions(
  sessions: AssistantMemorySessionSummary[],
  now: Date,
) {
  const cutoff = now.getTime() - (ASSISTANT_MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return sessions
    .filter((session) => {
      const updatedAt = new Date(session.updatedAt).getTime();
      return !Number.isNaN(updatedAt) && updatedAt >= cutoff;
    })
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, ASSISTANT_MEMORY_MAX_SESSION_SUMMARIES);
}

function normalizeExchange(raw: any): AssistantMemoryExchange | null {
  if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) {
    return null;
  }

  const content = cleanText(String(raw.content || ''));
  if (!content || !isMemoryWorthyMessage({
    role: raw.role,
    content,
    timestamp: raw.timestamp,
  })) {
    return null;
  }

  return {
    role: raw.role,
    content,
    timestamp: normalizeTimestamp(raw.timestamp, new Date()),
  };
}

function normalizeSession(raw: any): AssistantMemorySessionSummary | null {
  if (!raw || typeof raw.id !== 'string') {
    return null;
  }

  const startedAt = normalizeTimestamp(raw.startedAt, new Date());
  const endedAt = normalizeTimestamp(raw.endedAt, new Date());
  const updatedAt = normalizeTimestamp(raw.updatedAt || raw.endedAt, new Date());
  const userRequests = Array.isArray(raw.userRequests)
    ? raw.userRequests.map((value: unknown) => cleanText(String(value || ''))).filter((value: string) => value && !isLowSignalMessage(value)).slice(0, MAX_LIST_ITEMS)
    : [];
  const assistantOutcomes = Array.isArray(raw.assistantOutcomes)
    ? raw.assistantOutcomes.map((value: unknown) => cleanText(String(value || ''))).filter((value: string) => value && !isLowSignalMessage(value)).slice(0, MAX_LIST_ITEMS)
    : [];
  const topicTags = Array.isArray(raw.topicTags)
    ? raw.topicTags.filter((value: unknown): value is AssistantMemoryTopic => typeof value === 'string')
    : [];
  const summary = buildSessionSummaryText(userRequests, assistantOutcomes, topicTags);

  return {
    id: raw.id,
    startedAt,
    endedAt,
    updatedAt,
    summary,
    userRequests,
    assistantOutcomes,
    topicTags,
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
  };
}

function normalizeProfile(raw: any): AssistantMemoryProfile {
  const updatedAt = normalizeTimestamp(raw?.updatedAt, new Date());
  const userPreferenceEntries = sortMemoryEntries(
    dedupeEntriesByKey(
      buildFieldEntries('userPreferences', normalizeProfileFieldValues('userPreferences', raw?.userPreferences), raw?.itemCreatedAt, updatedAt),
      updatedAt,
    ),
  ).slice(0, PROFILE_ARRAY_LIMITS.userPreferences);
  let durableFactEntries = dedupeEntriesByKey(
    buildFieldEntries('durableFacts', normalizeProfileFieldValues('durableFacts', raw?.durableFacts), raw?.itemCreatedAt, updatedAt),
    updatedAt,
  );
  let realEstateSearchEntries = dedupeSearchEntriesByLocation(
    dedupeEntriesByKey(
      buildFieldEntries('realEstateSearchMemory', normalizeProfileFieldValues('realEstateSearchMemory', raw?.realEstateSearchMemory), raw?.itemCreatedAt, updatedAt),
      updatedAt,
    ),
    updatedAt,
  );
  ({
    durableEntries: durableFactEntries,
    searchEntries: realEstateSearchEntries,
  } = reconcileLocationMemoryEntries(durableFactEntries, realEstateSearchEntries, updatedAt));
  durableFactEntries = sortMemoryEntries(durableFactEntries).slice(0, PROFILE_ARRAY_LIMITS.durableFacts);
  realEstateSearchEntries = sortMemoryEntries(realEstateSearchEntries).slice(0, PROFILE_ARRAY_LIMITS.realEstateSearchMemory);
  const recurringGoalEntries = sortMemoryEntries(
    dedupeEntriesByKey(
      buildFieldEntries('recurringGoals', normalizeProfileFieldValues('recurringGoals', raw?.recurringGoals), raw?.itemCreatedAt, updatedAt),
      updatedAt,
    ),
  ).slice(0, PROFILE_ARRAY_LIMITS.recurringGoals);
  const favoriteWorkflowEntries = sortMemoryEntries(
    dedupeEntriesByKey(
      buildFieldEntries('favoriteWorkflows', normalizeProfileFieldValues('favoriteWorkflows', raw?.favoriteWorkflows), raw?.itemCreatedAt, updatedAt),
      updatedAt,
    ),
  ).slice(0, PROFILE_ARRAY_LIMITS.favoriteWorkflows);

  return {
    version: 1,
    updatedAt,
    preferredTone: typeof raw?.preferredTone === 'string' && raw.preferredTone.trim()
      ? raw.preferredTone.trim()
      : 'warm and concise',
    preferredResponseLength: 'short',
    userPreferences: userPreferenceEntries.map((entry) => entry.text),
    durableFacts: durableFactEntries.map((entry) => entry.text),
    realEstateSearchMemory: realEstateSearchEntries.map((entry) => entry.text),
    recurringGoals: recurringGoalEntries.map((entry) => entry.text),
    favoriteWorkflows: favoriteWorkflowEntries.map((entry) => entry.text),
    itemCreatedAt: buildItemCreatedAtFromEntries({
      userPreferences: userPreferenceEntries,
      durableFacts: durableFactEntries,
      realEstateSearchMemory: realEstateSearchEntries,
      recurringGoals: recurringGoalEntries,
      favoriteWorkflows: favoriteWorkflowEntries,
    }),
    commonProperties: [],
    portfolioContext: [],
    topicCounts: typeof raw?.topicCounts === 'object' && raw?.topicCounts
      ? Object.fromEntries(
        Object.entries(raw.topicCounts)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
          .slice(0, 9),
      ) as Partial<Record<AssistantMemoryTopic, number>>
      : {},
  };
}

export function buildAssistantMemorySnapshot(input: {
  existing?: AssistantMemorySnapshot | null;
  messages: AssistantConversationMessage[];
  sessionId: string;
  sessionStartedAt: string;
  userData?: AssistantMemoryUserData | null;
  now?: Date;
}): AssistantMemorySnapshot {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const cleanedMessages = input.messages
    .map((message) => ({
      role: message.role,
      content: cleanText(message.content),
      timestamp: normalizeTimestamp(message.timestamp, now),
    }))
    .filter((message) => message.content);
  const existing = input.existing || null;
  const topicCounts = buildTopicCounts(cleanedMessages);
  const topicOrder = sortedTopics(topicCounts);
  const preferenceHints = buildPreferenceHints(cleanedMessages);
  const durableFacts = extractDurableFacts(cleanedMessages);
  const realEstateSearchMemory = extractRealEstateSearchMemory(cleanedMessages);
  const recurringGoals = extractRecurringGoals(cleanedMessages);
  const userRequests = summarizeMessages(cleanedMessages, 'user');
  const assistantOutcomes = summarizeMessages(cleanedMessages, 'assistant');
  const highlightedTopics = topicOrder.slice(0, MAX_LIST_ITEMS);
  const existingProfile = existing?.profile;
  const mergedUserPreferences = mergeUnique(existingProfile?.userPreferences || [], preferenceHints);
  const mergedDurableFacts = mergeUnique(
    (existingProfile?.durableFacts || []).filter((value: string) => isMeaningfulDurableFact(value)),
    durableFacts,
    4,
  );
  const mergedRealEstateSearchMemory = mergeUnique(
    (existingProfile?.realEstateSearchMemory || []).filter((value: string) => isMeaningfulSearchMemory(value)),
    realEstateSearchMemory,
    5,
  );
  const mergedRecurringGoals = mergeUnique(
    (existingProfile?.recurringGoals || []).filter((value: string) => isMeaningfulRecurringGoal(value)),
    recurringGoals,
  );
  const mergedFavoriteWorkflows = mergeUnique(
    (existingProfile?.favoriteWorkflows || []).filter((value: string) => isMeaningfulFavoriteWorkflow(value)),
    [],
  );

  const sessionSummary: AssistantMemorySessionSummary = {
    id: input.sessionId,
    startedAt: normalizeTimestamp(input.sessionStartedAt, now),
    endedAt: nowIso,
    updatedAt: nowIso,
    summary: buildSessionSummaryText(userRequests, assistantOutcomes, highlightedTopics),
    userRequests,
    assistantOutcomes,
    topicTags: highlightedTopics,
    messageCount: cleanedMessages.length,
  };

  const profile = normalizeProfile({
    version: 1,
    updatedAt: nowIso,
    preferredTone: existingProfile?.preferredTone || 'warm and concise',
    preferredResponseLength: 'short',
    userPreferences: mergedUserPreferences,
    durableFacts: mergedDurableFacts,
    realEstateSearchMemory: mergedRealEstateSearchMemory,
    recurringGoals: mergedRecurringGoals,
    favoriteWorkflows: mergedFavoriteWorkflows,
    itemCreatedAt: buildNextProfileItemCreatedAt(existingProfile?.itemCreatedAt, {
      userPreferences: mergedUserPreferences,
      durableFacts: mergedDurableFacts,
      realEstateSearchMemory: mergedRealEstateSearchMemory,
      recurringGoals: mergedRecurringGoals,
      favoriteWorkflows: mergedFavoriteWorkflows,
    }, nowIso),
    commonProperties: [],
    portfolioContext: [],
    topicCounts: {
      ...(existingProfile?.topicCounts || {}),
      ...Object.fromEntries(
        Object.entries(topicCounts).map(([topic, count]) => [
          topic,
          (existingProfile?.topicCounts?.[topic as AssistantMemoryTopic] || 0) + (count || 0),
        ]),
      ),
    },
  });
  const recentExchanges = [
    ...(existing?.recentExchanges || []),
    ...cleanedMessages,
  ]
    .map(normalizeExchange)
    .filter((exchange): exchange is AssistantMemoryExchange => Boolean(exchange))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .slice(-ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES);
  const sessionsById = new Map<string, AssistantMemorySessionSummary>();
  [...(existing?.recentSessions || []), sessionSummary].forEach((session) => {
    const normalized = normalizeSession(session);
    if (normalized) sessionsById.set(normalized.id, normalized);
  });

  return {
    profile,
    recentExchanges,
    recentSessions: pruneSessions(Array.from(sessionsById.values()), now),
  };
}

export function formatAssistantMemoryForPrompt(snapshot: AssistantMemorySnapshot | null | undefined) {
  if (!snapshot) {
    return '';
  }

  const lines: string[] = [];
  const { profile } = snapshot;
  const personalizationGuidance = buildPersonalizationGuidance(profile);

  if (profile.userPreferences.length > 0) {
    lines.push(`- User preferences: ${profile.userPreferences.join('; ')}`);
  }
  if (profile.durableFacts.length > 0) {
    lines.push(`- Durable facts: ${profile.durableFacts.join('; ')}`);
  }
  if (profile.realEstateSearchMemory.length > 0) {
    lines.push(`- Latest real estate search memory: ${profile.realEstateSearchMemory.join('; ')}`);
  }
  if (profile.recurringGoals.length > 0) {
    lines.push(`- Recurring goals: ${profile.recurringGoals.join('; ')}`);
  }
  if (profile.favoriteWorkflows.length > 0) {
    lines.push(`- Favorite workflows: ${profile.favoriteWorkflows.join('; ')}`);
  }
  if (personalizationGuidance.length > 0) {
    lines.push(`- Personalization guidance: ${personalizationGuidance.join('; ')}`);
  }
  const recentSession = snapshot.recentSessions[0];
  if (recentSession?.summary) {
    lines.push(`- Most recent relevant session: ${cleanText(recentSession.summary, 240)}`);
  }

  if (lines.length === 0) {
    return '';
  }

  return `\n\nASSISTANT MEMORY:\n- Treat memory as guidance, not certainty. Follow the user\'s current request if it conflicts with older context.\n${lines.join('\n')}`;
}

export async function getAssistantMemory(userId: string): Promise<AssistantMemorySnapshot | null> {
  if (!userId) {
    return null;
  }

  try {
    const snapshot = await getDoc(doc(db, 'users', userId));
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    const recentExchanges = Array.isArray(data?.assistantMemoryRecentExchanges)
      ? data.assistantMemoryRecentExchanges
        .map(normalizeExchange)
        .filter((exchange: AssistantMemoryExchange | null): exchange is AssistantMemoryExchange => Boolean(exchange))
        .slice(-ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES)
      : [];
    const recentSessions = Array.isArray(data?.assistantMemoryRecentSessions)
      ? pruneSessions(
        data.assistantMemoryRecentSessions
          .map(normalizeSession)
          .filter((session: AssistantMemorySessionSummary | null): session is AssistantMemorySessionSummary => Boolean(session)),
        new Date(),
      )
      : [];

    return {
      profile: normalizeProfile(data?.assistantMemoryProfile),
      recentExchanges,
      recentSessions,
    };
  } catch (error) {
    console.error('[AssistantMemory] Failed to load assistant memory:', error);
    return null;
  }
}

export async function setAssistantMemory(
  userId: string,
  memorySnapshot: AssistantMemorySnapshot,
): Promise<{ success: boolean; error?: string }> {
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }

  const {
    lastSessionSummary: _ignoredLastSessionSummary,
    ...profileWithoutLastSessionSummary
  } = memorySnapshot.profile;

  const cleanedProfile: AssistantMemoryProfile = {
    ...normalizeProfile(profileWithoutLastSessionSummary),
    commonProperties: [],
    portfolioContext: [],
  };

  return updateUserProfileFields(userId, {
    assistantMemoryProfile: cleanedProfile,
    assistantMemoryRecentExchanges: memorySnapshot.recentExchanges
      .map(normalizeExchange)
      .filter((exchange): exchange is AssistantMemoryExchange => Boolean(exchange))
      .slice(-ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES),
    assistantMemoryRecentSessions: pruneSessions(
      memorySnapshot.recentSessions
        .map(normalizeSession)
        .filter((session): session is AssistantMemorySessionSummary => Boolean(session)),
      new Date(),
    ),
  } as Partial<UserProfile>);
}

export function createEmptyAssistantMemorySnapshot(now = new Date()): AssistantMemorySnapshot {
  const nowIso = now.toISOString();
  return {
    profile: {
      version: 1,
      updatedAt: nowIso,
      preferredTone: 'warm and concise',
      preferredResponseLength: 'short',
      userPreferences: [],
      durableFacts: [],
      realEstateSearchMemory: [],
      recurringGoals: [],
      favoriteWorkflows: [],
      itemCreatedAt: createEmptyProfileItemCreatedAt(),
      commonProperties: [],
      portfolioContext: [],
      topicCounts: {},
    },
    recentExchanges: [],
    recentSessions: [],
  };
}

export async function clearAssistantMemory(
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!userId) {
    return { success: false, error: 'User ID required' };
  }

  return setAssistantMemory(userId, createEmptyAssistantMemorySnapshot());
}