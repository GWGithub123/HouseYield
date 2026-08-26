import { getFirestore, initializeFirebaseAdmin } from './firebase-admin.js';

const ASSISTANT_MEMORY_RETENTION_DAYS = 60;
const ASSISTANT_MEMORY_MAX_SESSION_SUMMARIES = 12;
const ASSISTANT_MEMORY_MAX_RECENT_EXCHANGES = 6;
const MAX_CONTENT_LENGTH = 160;
const MAX_LIST_ITEMS = 3;
const ASSISTANT_MEMORY_TOPICS = [
  'portfolio',
  'netWorth',
  'properties',
  'maintenance',
  'sensors',
  'documents',
  'dashboard',
  'market',
  'navigation',
];

const TOPIC_SUMMARY_LABELS = {
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

const LOW_SIGNAL_MESSAGE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|sounds good|ok|okay|great|perfect|awesome|cool|sure|yes|yeah|yep|got it|understood|all right|alright)[.!]*$/i,
  /^(that works|that helps|let'?s do that|let'?s do it|please do|go ahead|do that)[.!]*$/i,
  /^(thanks so much|thank you so much|appreciate it)[.!]*$/i,
];

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

function parseArgs(argv) {
  const options = {
    userIds: [],
    allUsers: false,
    dryRun: false,
    limit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--user':
        if (argv[index + 1]) {
          options.userIds.push(argv[index + 1]);
          index += 1;
        }
        break;
      case '--all-users':
        options.allUsers = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--limit':
        if (argv[index + 1]) {
          options.limit = Math.max(1, parseInt(argv[index + 1], 10) || 1);
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return options;
}

async function resolveUserDocRefs(db, options) {
  if (options.allUsers) {
    const refs = await db.collection('users').listDocuments();
    return options.limit ? refs.slice(0, options.limit) : refs;
  }

  const uniqueUserIds = [...new Set(options.userIds.filter(Boolean))];
  const limitedUserIds = options.limit ? uniqueUserIds.slice(0, options.limit) : uniqueUserIds;
  return limitedUserIds.map((userId) => db.collection('users').doc(userId));
}

function cleanText(value, maxLength = MAX_CONTENT_LENGTH) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value?._seconds === 'number') {
    const milliseconds = (value._seconds * 1000) + Math.floor((value._nanoseconds || 0) / 1e6);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function normalizeTimestamp(value, fallbackDate) {
  const resolvedDate = toDate(value) || fallbackDate;
  return resolvedDate.toISOString();
}

function isLowSignalMessage(content) {
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

function matchesLegacyLabel(value, labels) {
  return labels.some((label) => label.toLowerCase() === value.toLowerCase());
}

function normalizeLocationCandidate(value) {
  return cleanText(value, 70)
    .replace(/^(?:the\s+)?/i, '')
    .replace(/[\s,;:-]+$/g, '')
    .trim();
}

function isConcreteLocationCandidate(value) {
  const normalized = normalizeLocationCandidate(value);
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

function isMeaningfulGoalText(value) {
  const cleaned = cleanText(value, 120);
  if (!cleaned || cleaned.split(/\s+/).length < 4) {
    return false;
  }

  if (!/\b(net worth|cash flow|cashflow|passive income|income|portfolio|properties?|doors?|units?|equity|assets?|retire(?:ment)?|financial independence)\b/i.test(cleaned)) {
    return false;
  }

  return /[$\d]/.test(cleaned) || /\b(by|within|before|over the next|in the next)\b/i.test(cleaned);
}

function isMeaningfulDurableFact(value) {
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

function isMeaningfulSearchMemory(value) {
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

function isMeaningfulRecurringGoal(value) {
  const cleaned = cleanText(value, 120);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  if (matchesLegacyLabel(cleaned, LEGACY_RECURRING_GOAL_LABELS)) {
    return false;
  }

  return isMeaningfulGoalText(cleaned);
}

function isMeaningfulFavoriteWorkflow(value) {
  const cleaned = cleanText(value, 90);
  if (!cleaned || isLowSignalMessage(cleaned)) {
    return false;
  }

  return !matchesLegacyLabel(cleaned, LEGACY_FAVORITE_WORKFLOW_LABELS);
}

function buildSessionSummaryText(userRequests, assistantOutcomes, highlightedTopics) {
  const parts = [];

  if (userRequests.length > 0) {
    parts.push(`User focused on ${userRequests.join('; ')}`);
  }
  if (assistantOutcomes.length > 0) {
    parts.push(`Assistant helped with ${assistantOutcomes.join('; ')}`);
  }
  if (highlightedTopics.length > 0) {
    parts.push(`Recurring themes: ${highlightedTopics.map((topic) => TOPIC_SUMMARY_LABELS[topic] || topic).join(', ')}`);
  }

  return parts.length > 0 ? cleanText(parts.join('. '), 220) : 'Recent assistant session saved.';
}

function pruneSessions(sessions, now) {
  const cutoff = now.getTime() - (ASSISTANT_MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return sessions
    .filter((session) => {
      const updatedAt = new Date(session.updatedAt).getTime();
      return !Number.isNaN(updatedAt) && updatedAt >= cutoff;
    })
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, ASSISTANT_MEMORY_MAX_SESSION_SUMMARIES);
}

function normalizeExchange(raw) {
  if (!raw || (raw.role !== 'user' && raw.role !== 'assistant')) {
    return null;
  }

  const content = cleanText(String(raw.content || ''));
  if (!content || isLowSignalMessage(content)) {
    return null;
  }

  if (raw.role === 'assistant' && /\b(sorry|error|failed|could not connect)\b/i.test(content)) {
    return null;
  }

  return {
    role: raw.role,
    content,
    timestamp: normalizeTimestamp(raw.timestamp, new Date()),
  };
}

function normalizeSession(raw) {
  if (!raw || typeof raw.id !== 'string') {
    return null;
  }

  const startedAt = normalizeTimestamp(raw.startedAt, new Date());
  const endedAt = normalizeTimestamp(raw.endedAt, new Date());
  const updatedAt = normalizeTimestamp(raw.updatedAt || raw.endedAt, new Date());
  const userRequests = Array.isArray(raw.userRequests)
    ? raw.userRequests
      .map((value) => cleanText(String(value || '')))
      .filter((value) => value && !isLowSignalMessage(value))
      .slice(0, MAX_LIST_ITEMS)
    : [];
  const assistantOutcomes = Array.isArray(raw.assistantOutcomes)
    ? raw.assistantOutcomes
      .map((value) => cleanText(String(value || '')))
      .filter((value) => value && !isLowSignalMessage(value))
      .slice(0, MAX_LIST_ITEMS)
    : [];
  const topicTags = Array.isArray(raw.topicTags)
    ? raw.topicTags.filter((value) => typeof value === 'string' && ASSISTANT_MEMORY_TOPICS.includes(value))
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

function normalizeProfile(raw, fallbackDate = new Date()) {
  return {
    version: 1,
    updatedAt: normalizeTimestamp(raw?.updatedAt, fallbackDate),
    preferredTone: typeof raw?.preferredTone === 'string' && raw.preferredTone.trim()
      ? raw.preferredTone.trim()
      : 'warm and concise',
    preferredResponseLength: 'short',
    userPreferences: Array.isArray(raw?.userPreferences)
      ? raw.userPreferences.map((value) => cleanText(String(value || ''), 90)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
      : [],
    durableFacts: Array.isArray(raw?.durableFacts)
      ? raw.durableFacts
        .map((value) => cleanText(String(value || ''), 90))
        .filter((value) => isMeaningfulDurableFact(value))
        .slice(0, 4)
      : [],
    realEstateSearchMemory: Array.isArray(raw?.realEstateSearchMemory)
      ? raw.realEstateSearchMemory
        .map((value) => cleanText(String(value || ''), 90))
        .filter((value) => isMeaningfulSearchMemory(value))
        .slice(0, 5)
      : [],
    recurringGoals: Array.isArray(raw?.recurringGoals)
      ? raw.recurringGoals
        .map((value) => cleanText(String(value || ''), 120))
        .filter((value) => isMeaningfulRecurringGoal(value))
        .slice(0, MAX_LIST_ITEMS)
      : [],
    favoriteWorkflows: Array.isArray(raw?.favoriteWorkflows)
      ? raw.favoriteWorkflows
        .map((value) => cleanText(String(value || ''), 90))
        .filter((value) => isMeaningfulFavoriteWorkflow(value))
        .slice(0, MAX_LIST_ITEMS)
      : [],
    commonProperties: Array.isArray(raw?.commonProperties)
      ? raw.commonProperties.map((value) => cleanText(String(value || ''), 90)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
      : [],
    portfolioContext: Array.isArray(raw?.portfolioContext)
      ? raw.portfolioContext.map((value) => cleanText(String(value || ''), 90)).filter(Boolean).slice(0, 5)
      : [],
    topicCounts: typeof raw?.topicCounts === 'object' && raw?.topicCounts
      ? Object.fromEntries(
        Object.entries(raw.topicCounts)
          .filter((entry) => typeof entry[1] === 'number' && entry[1] > 0 && ASSISTANT_MEMORY_TOPICS.includes(entry[0]))
          .slice(0, ASSISTANT_MEMORY_TOPICS.length),
      )
      : {},
    lastSessionSummary: typeof raw?.lastSessionSummary === 'string'
      ? cleanText(raw.lastSessionSummary, 220)
      : undefined,
  };
}

export function sanitizeAssistantMemoryFields(data, now = new Date()) {
  const profile = normalizeProfile(data?.assistantMemoryProfile, now);
  const recentExchanges = (Array.isArray(data?.assistantMemoryRecentExchanges)
    ? data.assistantMemoryRecentExchanges
    : [])
    .filter((exchange) => exchange?.role === 'user' || exchange?.role === 'assistant')
    .map((exchange) => ({
      role: exchange.role,
      content: cleanText(exchange.content, 160),
      timestamp: normalizeTimestamp(exchange.timestamp, now),
    }))
    .filter((exchange) => exchange.content)
    .slice(-6);
  const retentionCutoff = now.getTime() - (60 * 24 * 60 * 60 * 1000);
  const recentSessions = (Array.isArray(data?.assistantMemoryRecentSessions)
    ? data.assistantMemoryRecentSessions
    : [])
    .filter((session) => typeof session?.id === 'string')
    .map((session) => ({
      id: session.id,
      startedAt: normalizeTimestamp(session.startedAt, now),
      endedAt: normalizeTimestamp(session.endedAt, now),
      updatedAt: normalizeTimestamp(session.updatedAt || session.endedAt, now),
      summary: cleanText(session.summary, 240),
      userRequests: Array.isArray(session.userRequests)
        ? session.userRequests.map((value) => cleanText(value, 160)).filter(Boolean).slice(0, 3)
        : [],
      assistantOutcomes: Array.isArray(session.assistantOutcomes)
        ? session.assistantOutcomes.map((value) => cleanText(value, 160)).filter(Boolean).slice(0, 3)
        : [],
      topicTags: Array.isArray(session.topicTags)
        ? session.topicTags.filter((value) => typeof value === 'string').slice(0, 6)
        : [],
      messageCount: Number.isFinite(Number(session.messageCount)) ? Number(session.messageCount) : 0,
    }))
    .filter((session) => new Date(session.updatedAt).getTime() >= retentionCutoff)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 12);

  return {
    profile: {
      ...profile,
      updatedAt: now.toISOString(),
      commonProperties: [],
      portfolioContext: [],
      lastSessionSummary: undefined,
    },
    recentExchanges,
    recentSessions,
  };
}

function hasAssistantMemory(data) {
  return Boolean(
    data?.assistantMemoryProfile
      || (Array.isArray(data?.assistantMemoryRecentExchanges) && data.assistantMemoryRecentExchanges.length > 0)
      || (Array.isArray(data?.assistantMemoryRecentSessions) && data.assistantMemoryRecentSessions.length > 0),
  );
}

function countValues(value) {
  return Array.isArray(value) ? value.length : 0;
}

function createUserSummary(userId) {
  return {
    userId,
    hadMemory: false,
    rewritten: false,
    counts: {
      durableFacts: { before: 0, after: 0 },
      realEstateSearchMemory: { before: 0, after: 0 },
      recurringGoals: { before: 0, after: 0 },
      favoriteWorkflows: { before: 0, after: 0 },
      recentExchanges: { before: 0, after: 0 },
      recentSessions: { before: 0, after: 0 },
    },
    issues: [],
  };
}

function populateCountSummary(summary, rawData, sanitized) {
  const rawProfile = rawData?.assistantMemoryProfile || {};

  summary.counts.durableFacts.before = countValues(rawProfile.durableFacts);
  summary.counts.durableFacts.after = sanitized.profile.durableFacts.length;
  summary.counts.realEstateSearchMemory.before = countValues(rawProfile.realEstateSearchMemory);
  summary.counts.realEstateSearchMemory.after = sanitized.profile.realEstateSearchMemory.length;
  summary.counts.recurringGoals.before = countValues(rawProfile.recurringGoals);
  summary.counts.recurringGoals.after = sanitized.profile.recurringGoals.length;
  summary.counts.favoriteWorkflows.before = countValues(rawProfile.favoriteWorkflows);
  summary.counts.favoriteWorkflows.after = sanitized.profile.favoriteWorkflows.length;
  summary.counts.recentExchanges.before = countValues(rawData?.assistantMemoryRecentExchanges);
  summary.counts.recentExchanges.after = sanitized.recentExchanges.length;
  summary.counts.recentSessions.before = countValues(rawData?.assistantMemoryRecentSessions);
  summary.counts.recentSessions.after = sanitized.recentSessions.length;
}

async function rewriteUserMemory(docRef, options) {
  const summary = createUserSummary(docRef.id);
  const snapshot = await docRef.get();

  if (!snapshot.exists) {
    summary.issues.push({ error: 'User document not found' });
    return summary;
  }

  const data = snapshot.data() || {};
  summary.hadMemory = hasAssistantMemory(data);
  if (!summary.hadMemory) {
    return summary;
  }

  const sanitized = sanitizeAssistantMemoryFields(data, new Date());
  populateCountSummary(summary, data, sanitized);

  if (!options.dryRun) {
    await docRef.update({
      assistantMemoryProfile: sanitized.profile,
      assistantMemoryRecentExchanges: sanitized.recentExchanges,
      assistantMemoryRecentSessions: sanitized.recentSessions,
    });
  }

  summary.rewritten = true;
  return summary;
}

function buildTotals(summaries) {
  return summaries.reduce((totals, summary) => ({
    users: totals.users + 1,
    withMemory: totals.withMemory + (summary.hadMemory ? 1 : 0),
    rewritten: totals.rewritten + (summary.rewritten ? 1 : 0),
    skippedWithoutMemory: totals.skippedWithoutMemory + (summary.hadMemory ? 0 : 1),
    failed: totals.failed + (summary.issues.length > 0 ? 1 : 0),
  }), {
    users: 0,
    withMemory: 0,
    rewritten: 0,
    skippedWithoutMemory: 0,
    failed: 0,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  initializeFirebaseAdmin();
  const db = getFirestore();
  const docRefs = await resolveUserDocRefs(db, options);

  if (docRefs.length === 0) {
    throw new Error('Provide at least one --user <uid> or use --all-users');
  }

  const summaries = [];
  for (const docRef of docRefs) {
    try {
      summaries.push(await rewriteUserMemory(docRef, options));
    } catch (error) {
      summaries.push({
        ...createUserSummary(docRef.id),
        issues: [{ error: error.message }],
      });
    }
  }

  const totals = buildTotals(summaries);
  const result = {
    ok: totals.failed === 0,
    mode: options.dryRun ? 'dry-run' : 'write',
    totals,
    users: summaries,
  };

  console.log(JSON.stringify(result, null, 2));

  if (totals.failed > 0) {
    process.exitCode = 1;
  }

  return result;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch((error) => {
    console.error('[AssistantMemory] Firestore cleanup backfill failed:', error);
    process.exitCode = 1;
  });
}