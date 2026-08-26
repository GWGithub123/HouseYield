import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';
import {
  ASSISTANT_USER_SCOPE_FIELDS,
  createAssistantAccessResolver,
  listAssistantAccessibleCollectionIds,
} from './assistantAccountScopeService.js';
import { computeAssistantAnalytics } from './assistantComputedAnalyticsService.js';

initializeFirebaseAdmin();

const db = getFirestore();

const ALLOWED_FILTER_OPERATORS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'array-contains',
  'array-contains-any',
  'in',
  'not-in',
]);

const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_LIMIT = 100;
const MAX_SCOPED_SCAN_LIMIT = 250;

function splitPath(path) {
  return String(path || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeFirestorePath(path) {
  return splitPath(path).join('/');
}

function isDocumentPath(path) {
  const segments = splitPath(path);
  return segments.length > 0 && segments.length % 2 === 0;
}

function isCollectionPath(path) {
  const segments = splitPath(path);
  return segments.length > 0 && segments.length % 2 === 1;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getParentDocumentPath(path) {
  const segments = splitPath(path);
  if (segments.length < 2) {
    return null;
  }

  if (segments.length % 2 === 0) {
    const parentSegments = segments.slice(0, -2);
    return parentSegments.length >= 2 ? parentSegments.join('/') : null;
  }

  const parentSegments = segments.slice(0, -1);
  return parentSegments.length >= 2 ? parentSegments.join('/') : null;
}

function isDirectlyScopedPath(path, userId) {
  const segments = splitPath(path);
  return (
    (segments[0] === 'users' && segments[1] === userId)
    || (segments[0] === 'portfolios' && segments[1] === userId)
  );
}

function getNestedValue(source, fieldPath) {
  if (!fieldPath) {
    return { found: true, value: source };
  }

  const segments = String(fieldPath)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  let current = source;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }

    if (!isPlainObject(current) || !(segment in current)) {
      return { found: false, value: undefined };
    }

    current = current[segment];
  }

  return { found: true, value: current };
}

function serializeExactValue(value) {
  if (value === null) {
    return { type: 'null', value: null };
  }

  if (value === undefined) {
    return { type: 'undefined', value: null };
  }

  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }

  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString() };
  }

  if (value instanceof Date) {
    return {
      type: 'date',
      value: Number.isNaN(value.getTime()) ? null : value.toISOString(),
    };
  }

  if (typeof value?.toDate === 'function' && typeof value?.seconds === 'number') {
    return {
      type: 'timestamp',
      value: value.toDate().toISOString(),
      seconds: value.seconds,
      nanoseconds: value.nanoseconds || 0,
    };
  }

  if (typeof value?.latitude === 'number' && typeof value?.longitude === 'number') {
    return {
      type: 'geopoint',
      value: {
        latitude: value.latitude,
        longitude: value.longitude,
      },
    };
  }

  if (typeof value?.path === 'string' && typeof value?.id === 'string' && value?.firestore) {
    return {
      type: 'document_reference',
      value: value.path,
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'bytes',
      encoding: 'base64',
      byteLength: value.length,
      value: value.toString('base64'),
    };
  }

  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      type: 'bytes',
      encoding: 'base64',
      byteLength: value.byteLength,
      value: bytes.toString('base64'),
    };
  }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      value: value.map((entry) => serializeExactValue(entry)),
    };
  }

  if (isPlainObject(value)) {
    return {
      type: 'object',
      value: Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => [key, serializeExactValue(entryValue)]),
      ),
    };
  }

  return {
    type: 'string',
    value: String(value),
  };
}

function serializeDocumentSnapshot(snapshot) {
  return {
    id: snapshot.id,
    documentPath: snapshot.ref.path,
    exists: snapshot.exists,
    createTime: snapshot.createTime?.toDate?.().toISOString?.() || null,
    updateTime: snapshot.updateTime?.toDate?.().toISOString?.() || null,
    readTime: snapshot.readTime?.toDate?.().toISOString?.() || null,
    data: snapshot.exists ? serializeExactValue(snapshot.data()) : null,
  };
}

function normalizeQueryLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? DEFAULT_QUERY_LIMIT), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function normalizeFilters(filters) {
  if (!Array.isArray(filters)) {
    return [];
  }

  return filters
    .map((filter) => ({
      field: typeof filter?.field === 'string' ? filter.field.trim() : '',
      op: typeof filter?.op === 'string' ? filter.op.trim() : '==',
      value: filter?.value,
    }))
    .filter((filter) => filter.field && ALLOWED_FILTER_OPERATORS.has(filter.op));
}

function normalizeOrderBy(orderBy) {
  if (!Array.isArray(orderBy)) {
    return [];
  }

  return orderBy
    .map((entry) => ({
      field: typeof entry?.field === 'string' ? entry.field.trim() : '',
      direction: entry?.direction === 'desc' ? 'desc' : 'asc',
    }))
    .filter((entry) => entry.field);
}

function applyQueryRef(queryRef, filters, orderBy, limit) {
  let nextQuery = queryRef;

  for (const filter of filters) {
    nextQuery = nextQuery.where(filter.field, filter.op, filter.value);
  }

  for (const ordering of orderBy) {
    nextQuery = nextQuery.orderBy(ordering.field, ordering.direction);
  }

  return nextQuery.limit(limit);
}

function toComparableValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value?.toDate === 'function' && typeof value?.seconds === 'number') {
    return value.toDate().getTime();
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return value;
}

function applyLocalFilter(value, filterValue, operator) {
  switch (operator) {
    case '==':
      return toComparableValue(value) === toComparableValue(filterValue);
    case '!=':
      return toComparableValue(value) !== toComparableValue(filterValue);
    case '<':
      return toComparableValue(value) < toComparableValue(filterValue);
    case '<=':
      return toComparableValue(value) <= toComparableValue(filterValue);
    case '>':
      return toComparableValue(value) > toComparableValue(filterValue);
    case '>=':
      return toComparableValue(value) >= toComparableValue(filterValue);
    case 'array-contains':
      return Array.isArray(value) && value.some((entry) => toComparableValue(entry) === toComparableValue(filterValue));
    case 'array-contains-any':
      return Array.isArray(value) && Array.isArray(filterValue)
        && filterValue.some((entry) => value.some((candidate) => toComparableValue(candidate) === toComparableValue(entry)));
    case 'in':
      return Array.isArray(filterValue)
        && filterValue.some((entry) => toComparableValue(value) === toComparableValue(entry));
    case 'not-in':
      return Array.isArray(filterValue)
        && !filterValue.some((entry) => toComparableValue(value) === toComparableValue(entry));
    default:
      return false;
  }
}

function applyLocalFiltersAndOrder(documents, filters, orderBy, limit) {
  const filtered = documents.filter((document) => {
    const data = document.data();
    return filters.every((filter) => {
      const nested = getNestedValue(data, filter.field);
      return nested.found && applyLocalFilter(nested.value, filter.value, filter.op);
    });
  });

  if (orderBy.length > 0) {
    filtered.sort((left, right) => {
      for (const ordering of orderBy) {
        const leftValue = getNestedValue(left.data(), ordering.field).value;
        const rightValue = getNestedValue(right.data(), ordering.field).value;
        const leftComparable = toComparableValue(leftValue);
        const rightComparable = toComparableValue(rightValue);

        if (leftComparable === rightComparable) {
          continue;
        }

        if (leftComparable === undefined || leftComparable === null) {
          return ordering.direction === 'desc' ? 1 : -1;
        }

        if (rightComparable === undefined || rightComparable === null) {
          return ordering.direction === 'desc' ? -1 : 1;
        }

        if (leftComparable < rightComparable) {
          return ordering.direction === 'desc' ? 1 : -1;
        }

        return ordering.direction === 'desc' ? -1 : 1;
      }

      return 0;
    });
  }

  return filtered.slice(0, limit);
}

async function executeScopedCollectionQuery(collectionRef, userId, filters, orderBy, limit) {
  const scopedLimit = Math.min(Math.max(limit * 5, limit), MAX_SCOPED_SCAN_LIMIT);
  const aggregated = [];
  const seenPaths = new Set();

  for (const scopeField of ASSISTANT_USER_SCOPE_FIELDS) {
    try {
      const snapshot = await collectionRef
        .where(scopeField.field, scopeField.operator, userId)
        .limit(scopedLimit)
        .get();

      for (const docSnapshot of snapshot.docs) {
        if (seenPaths.has(docSnapshot.ref.path)) {
          continue;
        }

        seenPaths.add(docSnapshot.ref.path);
        aggregated.push(docSnapshot);
      }
    } catch {
      // Ignore unsupported combinations and continue with other scope probes.
    }
  }

  return applyLocalFiltersAndOrder(aggregated, filters, orderBy, limit);
}

async function lookupDocument({ userId, documentPath, fieldPath }) {
  const normalizedPath = normalizeFirestorePath(documentPath);
  const { resolveDocumentAccess } = createAssistantAccessResolver(userId);
  const access = await resolveDocumentAccess(normalizedPath);

  if (!access.allowed) {
    throw new Error(`document access denied for ${normalizedPath}`);
  }

  const snapshot = access.snapshot || await db.doc(normalizedPath).get();
  if (!fieldPath) {
    return {
      ok: true,
      action: 'get_document',
      document: serializeDocumentSnapshot(snapshot),
    };
  }

  if (!snapshot.exists) {
    return {
      ok: true,
      action: 'get_field',
      documentPath: normalizedPath,
      fieldPath,
      exists: false,
      fieldExists: false,
      value: null,
    };
  }

  const nested = getNestedValue(snapshot.data(), fieldPath);
  return {
    ok: true,
    action: 'get_field',
    documentPath: normalizedPath,
    fieldPath,
    exists: true,
    fieldExists: nested.found,
    value: nested.found ? serializeExactValue(nested.value) : null,
  };
}

async function lookupSubcollections({ userId, documentPath }) {
  const normalizedPath = normalizeFirestorePath(documentPath);
  const { resolveDocumentAccess } = createAssistantAccessResolver(userId);
  const access = await resolveDocumentAccess(normalizedPath);
  if (!access.allowed) {
    throw new Error(`subcollection access denied for ${normalizedPath}`);
  }

  const collectionRefs = await db.doc(normalizedPath).listCollections();
  return {
    ok: true,
    action: 'list_subcollections',
    documentPath: normalizedPath,
    subcollections: collectionRefs.map((collectionRef) => collectionRef.id).sort((left, right) => left.localeCompare(right)),
  };
}

async function lookupCollection({ userId, collectionPath, collectionGroup, filters, orderBy, limit }) {
  const normalizedCollectionPath = normalizeFirestorePath(collectionPath);
  const normalizedFilters = normalizeFilters(filters);
  const normalizedOrderBy = normalizeOrderBy(orderBy);
  const normalizedLimit = normalizeQueryLimit(limit);
  const { resolveDocumentAccess } = createAssistantAccessResolver(userId);

  let documents = [];
  let queryMode = 'scoped_fallback';

  if (collectionGroup) {
    const queryRef = db.collectionGroup(String(collectionGroup).trim());
    documents = await executeScopedCollectionQuery(queryRef, userId, normalizedFilters, normalizedOrderBy, normalizedLimit);
    queryMode = 'collection_group_scoped';
  } else {
    if (!normalizedCollectionPath || !isCollectionPath(normalizedCollectionPath)) {
      throw new Error('valid collectionPath is required');
    }

    const collectionRef = db.collection(normalizedCollectionPath);

    if (isDirectlyScopedPath(normalizedCollectionPath, userId)) {
      const snapshot = await applyQueryRef(collectionRef, normalizedFilters, normalizedOrderBy, normalizedLimit).get();
      documents = snapshot.docs;
      queryMode = 'direct_path';
    } else {
      const parentDocumentPath = getParentDocumentPath(normalizedCollectionPath);

      if (parentDocumentPath) {
        const access = await resolveDocumentAccess(parentDocumentPath);
        if (!access.allowed) {
          throw new Error(`collection access denied for ${normalizedCollectionPath}`);
        }

        const snapshot = await applyQueryRef(collectionRef, normalizedFilters, normalizedOrderBy, normalizedLimit).get();
        documents = snapshot.docs;
        queryMode = 'authorized_parent';
      } else {
        documents = await executeScopedCollectionQuery(collectionRef, userId, normalizedFilters, normalizedOrderBy, normalizedLimit);
      }
    }
  }

  return {
    ok: true,
    action: collectionGroup ? 'query_collection_group' : 'query_collection',
    collectionPath: normalizedCollectionPath || null,
    collectionGroup: collectionGroup || null,
    queryMode,
    filters: normalizedFilters,
    orderBy: normalizedOrderBy,
    count: documents.length,
    documents: documents.map((snapshot) => serializeDocumentSnapshot(snapshot)),
  };
}

function normalizeCategoryNeedle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function queryAzureLedgerBundle({
  userId,
  propertyId = null,
  propertyAddress = null,
  year = null,
  startDate = null,
  endDate = null,
  category = null,
  limit = 25,
} = {}) {
  const taxYear = Number(year) || null;
  const resolvedStartDate = taxYear ? `${taxYear}-01-01` : startDate || null;
  const resolvedEndDate = taxYear ? `${taxYear}-12-31` : endDate || null;
  const categoryNeedle = normalizeCategoryNeedle(category);
  const resultLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);

  let resolvedPropertyId = propertyId || null;
  if (!resolvedPropertyId && propertyAddress) {
    try {
      const { getOwnerProperties } = await import('../property-firestore-service.js');
      const ownerResult = await getOwnerProperties(userId);
      const properties = Array.isArray(ownerResult?.properties) ? ownerResult.properties : [];
      const needle = normalizeCategoryNeedle(propertyAddress);
      const matched = properties.find((property) => {
        const address = normalizeCategoryNeedle(property.address);
        return address === needle || address.includes(needle) || needle.includes(address);
      });
      resolvedPropertyId = matched?.id || null;
    } catch {
      resolvedPropertyId = null;
    }
  }

  const bookkeeping = await import('../bookkeeping-firestore.js');
  const { entries } = await bookkeeping.loadCanonicalLedgerEntriesForScope({
    userId,
    propertyId: resolvedPropertyId,
    startDate: resolvedStartDate,
    endDate: resolvedEndDate,
    limit: 5000,
    errorLabel: 'assistant-azure-ledger',
  });

  const expenseByCategory = new Map();
  const incomeByCategory = new Map();
  const transactions = [];
  let totalExpenses = 0;
  let totalIncome = 0;

  for (const entry of entries || []) {
    const taxCategory = typeof bookkeeping.deriveCanonicalTaxCategory === 'function'
      ? (bookkeeping.deriveCanonicalTaxCategory(entry) || entry.category || 'Uncategorized')
      : (entry.category || 'Uncategorized');
    const haystack = normalizeCategoryNeedle([
      taxCategory,
      entry.category,
      entry.vendor,
      entry.payee,
      entry.memo,
      entry.description,
    ].filter(Boolean).join(' '));
    const matchesCategory = !categoryNeedle
      || haystack.includes(categoryNeedle)
      || categoryNeedle.includes(haystack)
      || (categoryNeedle.includes('mortgage') && haystack.includes('interest'))
      || (categoryNeedle.includes('management') && (haystack.includes('management') || haystack.includes('property management')));

    const amount = Math.round((Math.abs(Number(entry.signedAmount ?? entry.amount ?? 0)) + Number.EPSILON) * 100) / 100;
    if (!amount) continue;

    if (entry.transactionType === 'income' || entry.type === 'income') {
      totalIncome += amount;
      if (matchesCategory) {
        incomeByCategory.set(taxCategory, (incomeByCategory.get(taxCategory) || 0) + amount);
        transactions.push({
          id: entry.id,
          date: entry.entryDate || entry.date || null,
          category: taxCategory,
          amount,
          type: 'income',
          memo: entry.memo || entry.description || null,
          vendor: entry.vendor || entry.payee || null,
          propertyId: entry.propertyId || resolvedPropertyId || null,
        });
      }
      continue;
    }

    if (entry.transactionType === 'expense' || entry.type === 'expense' || entry.isExpense === true) {
      totalExpenses += amount;
      if (matchesCategory) {
        expenseByCategory.set(taxCategory, (expenseByCategory.get(taxCategory) || 0) + amount);
        transactions.push({
          id: entry.id,
          date: entry.entryDate || entry.date || null,
          category: taxCategory,
          amount,
          type: 'expense',
          memo: entry.memo || entry.description || null,
          vendor: entry.vendor || entry.payee || null,
          propertyId: entry.propertyId || resolvedPropertyId || null,
        });
      }
    }
  }

  const categoryTotals = Array.from(expenseByCategory.entries())
    .map(([name, amount]) => ({ category: name, amount: Math.round((amount + Number.EPSILON) * 100) / 100 }))
    .sort((left, right) => right.amount - left.amount);
  const incomeTotals = Array.from(incomeByCategory.entries())
    .map(([name, amount]) => ({ category: name, amount: Math.round((amount + Number.EPSILON) * 100) / 100 }))
    .sort((left, right) => right.amount - left.amount);

  transactions.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));

  return {
    ok: true,
    action: 'query_azure_ledger',
    scoped: true,
    accountScope: { userId },
    propertyId: resolvedPropertyId,
    propertyAddress: propertyAddress || null,
    year: taxYear,
    startDate: resolvedStartDate,
    endDate: resolvedEndDate,
    category: categoryNeedle || null,
    entryCount: (entries || []).length,
    matchedTransactionCount: transactions.length,
    totalExpenses: Math.round((totalExpenses + Number.EPSILON) * 100) / 100,
    totalIncome: Math.round((totalIncome + Number.EPSILON) * 100) / 100,
    categoryTotals,
    incomeTotals,
    transactions: transactions.slice(0, resultLimit),
    dataSource: 'azure_sql_ledger',
    generatedAt: new Date().toISOString(),
  };
}

async function summarizeAccountDataBundle({ userId }) {
  const [accessibleCollections, portfolioAnalytics, azureLedger] = await Promise.all([
    listAssistantAccessibleCollectionIds(userId, { limit: 100 }).catch((error) => ({
      collections: [],
      totalMatchedCollections: 0,
      truncated: false,
      error: error.message,
    })),
    computeAssistantAnalytics({ userId, metric: 'portfolio_summary' }).catch((error) => ({
      ok: false,
      error: error.message,
    })),
    queryAzureLedgerBundle({ userId, limit: 8 }).catch((error) => ({
      ok: false,
      error: error.message,
    })),
  ]);

  return {
    ok: true,
    action: 'summarize_account_data',
    scoped: true,
    accountScope: {
      userId,
      guardrails: [
        'All Firestore reads require a users/{uid}, portfolios/{uid}, or owner/user/account link match.',
        'Azure bookkeeping reads are called with the authenticated userId only.',
        'Global market data is non-account context and is never used as account ownership evidence.',
      ],
    },
    accessibleCollections,
    portfolioAnalytics,
    azureLedger: azureLedger?.ok === false
      ? azureLedger
      : {
          ok: true,
          entryCount: azureLedger?.entryCount || 0,
          totalExpenses: azureLedger?.totalExpenses || 0,
          totalIncome: azureLedger?.totalIncome || 0,
          topExpenseCategories: (azureLedger?.categoryTotals || []).slice(0, 8),
          topIncomeCategories: (azureLedger?.incomeTotals || []).slice(0, 5),
          note: 'Use action query_azure_ledger with year/propertyAddress/category for exact mortgage interest, management fees, and other ledger totals.',
        },
    sourceFamilies: [
      'Firebase account/user documents and linked collections',
      'Azure bookkeeping ledger via query_azure_ledger and canonical portfolio computation',
      'Cached/global market context exposed through canonical assistant context',
    ],
    generatedAt: new Date().toISOString(),
  };
}

export function getAssistantDataLookupToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'lookup_platform_data',
      description: 'Look up exact raw platform data for the authenticated user. Use summarize_account_data for coverage, get_field for one Firestore value, scoped collection queries for Firebase records, and query_azure_ledger for live Azure bookkeeping totals (mortgage interest, management fees, category breakdowns by year/property). Never request data outside this user account.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['summarize_account_data', 'list_accessible_collections', 'list_subcollections', 'get_document', 'get_field', 'query_collection', 'query_collection_group', 'query_azure_ledger'],
          },
          documentPath: {
            type: 'string',
            description: 'Firestore document path like users/{uid} or properties/{propertyId}/leases/{leaseId}. Required for get_document, get_field, and list_subcollections.',
          },
          fieldPath: {
            type: 'string',
            description: 'Dot-separated nested field path like financials.monthlyRent or units.0.status. Required for get_field.',
          },
          collectionPath: {
            type: 'string',
            description: 'Firestore collection path like properties or users/{uid}/documents. Required for query_collection. Do not use this for Azure ledger totals — use query_azure_ledger instead.',
          },
          propertyId: {
            type: 'string',
            description: 'Optional property id for query_azure_ledger.',
          },
          propertyAddress: {
            type: 'string',
            description: 'Optional property address (full or partial) for query_azure_ledger.',
          },
          year: {
            type: 'number',
            description: 'Optional tax/calendar year for query_azure_ledger (e.g. 2025).',
          },
          startDate: {
            type: 'string',
            description: 'Optional YYYY-MM-DD start date for query_azure_ledger.',
          },
          endDate: {
            type: 'string',
            description: 'Optional YYYY-MM-DD end date for query_azure_ledger.',
          },
          category: {
            type: 'string',
            description: 'Optional ledger category filter for query_azure_ledger, e.g. mortgage interest or management fees.',
          },
          address: {
            type: 'string',
            description: 'Alias for propertyAddress on query_azure_ledger.',
          },
          taxYear: {
            type: 'number',
            description: 'Alias for year on query_azure_ledger.',
          },
          collectionGroup: {
            type: 'string',
            description: 'Collection group id like transactions or entries. Required for query_collection_group.',
          },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                op: { type: 'string', enum: ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'array-contains-any', 'in', 'not-in'] },
                value: {},
              },
              required: ['field', 'op', 'value'],
            },
            description: 'Optional Firestore-style filters for query_collection or query_collection_group.',
          },
          orderBy: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                direction: { type: 'string', enum: ['asc', 'desc'] },
              },
              required: ['field'],
            },
            description: 'Optional sort directives for collection queries.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_QUERY_LIMIT,
            description: `Optional result limit. Maximum ${MAX_QUERY_LIMIT}.`,
          },
        },
        required: ['action'],
      },
    },
  };
}

export async function executeAssistantDataLookup({
  userId,
  action,
  documentPath,
  fieldPath,
  collectionPath,
  collectionGroup,
  filters,
  orderBy,
  limit,
  propertyId,
  propertyAddress,
  address,
  year,
  taxYear,
  startDate,
  endDate,
  category,
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  switch (action) {
    case 'summarize_account_data':
      return summarizeAccountDataBundle({ userId });
    case 'query_azure_ledger':
      return queryAzureLedgerBundle({
        userId,
        propertyId,
        propertyAddress: propertyAddress || address || null,
        year: year || taxYear || null,
        startDate,
        endDate,
        category,
        limit,
      });
    case 'list_top_level_collections':
    case 'list_accessible_collections':
      return {
        ok: true,
        action: 'list_accessible_collections',
        scoped: true,
        ...(await listAssistantAccessibleCollectionIds(userId, { limit: 50 })),
      };
    case 'list_subcollections':
      return lookupSubcollections({ userId, documentPath });
    case 'get_document':
      return lookupDocument({ userId, documentPath });
    case 'get_field':
      return lookupDocument({ userId, documentPath, fieldPath });
    case 'query_collection':
      return lookupCollection({ userId, collectionPath, filters, orderBy, limit });
    case 'query_collection_group':
      return lookupCollection({ userId, collectionGroup, filters, orderBy, limit });
    default:
      throw new Error(`unsupported lookup action: ${action}`);
  }
}