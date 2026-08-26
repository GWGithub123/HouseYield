import { getFirestore, initializeFirebaseAdmin } from '../firebase-admin.js';

initializeFirebaseAdmin();

const db = getFirestore();

export const ASSISTANT_USER_SCOPE_FIELDS = [
  { field: 'ownerId', operator: '==' },
  { field: 'userId', operator: '==' },
  { field: 'uid', operator: '==' },
  { field: 'accountId', operator: '==' },
  { field: 'ownerUid', operator: '==' },
  { field: 'createdBy', operator: '==' },
  { field: 'memberIds', operator: 'array-contains' },
  { field: 'userIds', operator: 'array-contains' },
];

export const ASSISTANT_EXPLICIT_USER_COLLECTIONS = [
  { id: 'properties', fields: ['ownerId'], sampleLimit: 8 },
  { id: 'tenants', fields: ['ownerId', 'userId'], sampleLimit: 8 },
  { id: 'leases', fields: ['ownerId', 'userId'], sampleLimit: 8 },
  { id: 'documents', fields: ['ownerId', 'userId'], sampleLimit: 8 },
  { id: 'maintenance_requests', fields: ['ownerId', 'userId'], sampleLimit: 8 },
  { id: 'tenant_messages', fields: ['ownerId', 'userId'], sampleLimit: 8 },
  { id: 'shelly_devices', fields: ['ownerId', 'userId'], sampleLimit: 40 },
  { id: 'sensor_readings', fields: ['ownerId', 'userId'], sampleLimit: 10 },
  { id: 'alerts', fields: ['ownerId', 'userId'], sampleLimit: 20 },
  { id: 'tax_summaries', fields: ['ownerId', 'userId'], sampleLimit: 6 },
  { id: 'market_ai_analyses', fields: ['ownerId', 'userId'], sampleLimit: 6 },
  { id: 'marketInsightCache', fields: ['ownerId', 'userId'], sampleLimit: 6 },
];

const DIRECT_USER_ROOTS = new Set(['users', 'portfolios']);
const DISCOVERY_EXCLUDED_COLLECTIONS = new Set(['users', 'portfolios']);
const DISCOVERY_EXCLUDED_COLLECTION_PATTERNS = [/^__/i, /^_/i];

export function splitFirestorePath(path) {
  return String(path || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function normalizeFirestorePath(path) {
  return splitFirestorePath(path).join('/');
}

export function isFirestoreDocumentPath(path) {
  const segments = splitFirestorePath(path);
  return segments.length > 0 && segments.length % 2 === 0;
}

export function isFirestoreCollectionPath(path) {
  const segments = splitFirestorePath(path);
  return segments.length > 0 && segments.length % 2 === 1;
}

export function getParentFirestoreDocumentPath(path) {
  const segments = splitFirestorePath(path);
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

export function isDirectUserScopedPath(path, userId) {
  const segments = splitFirestorePath(path);
  return DIRECT_USER_ROOTS.has(segments[0]) && segments[1] === userId;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function valueMatchesUserId(value, userId) {
  if (Array.isArray(value)) {
    return value.some((entry) => entry === userId);
  }
  return value === userId;
}

export function documentLinksToAssistantUser(data, userId) {
  if (!isPlainObject(data)) {
    return false;
  }

  return ASSISTANT_USER_SCOPE_FIELDS.some((scopeField) => {
    const nested = getNestedValue(data, scopeField.field);
    return nested.found && valueMatchesUserId(nested.value, userId);
  });
}

export function createAssistantAccessResolver(userId) {
  const accessCache = new Map();

  const resolveDocumentAccess = async (documentPath) => {
    const normalizedPath = normalizeFirestorePath(documentPath);
    if (!normalizedPath || !isFirestoreDocumentPath(normalizedPath)) {
      throw new Error('valid documentPath is required');
    }

    if (accessCache.has(normalizedPath)) {
      return accessCache.get(normalizedPath);
    }

    const pending = (async () => {
      if (isDirectUserScopedPath(normalizedPath, userId)) {
        return { allowed: true, reason: 'direct_user_scope', snapshot: null };
      }

      const snapshot = await db.doc(normalizedPath).get();
      if (snapshot.exists && (snapshot.id === userId || documentLinksToAssistantUser(snapshot.data(), userId))) {
        return { allowed: true, reason: 'document_link', snapshot };
      }

      const parentDocumentPath = getParentFirestoreDocumentPath(normalizedPath);
      if (parentDocumentPath) {
        const parentAccess = await resolveDocumentAccess(parentDocumentPath);
        if (parentAccess.allowed && isDirectUserScopedPath(parentDocumentPath, userId)) {
          return { allowed: true, reason: 'direct_parent_scope', snapshot };
        }
      }

      return { allowed: false, reason: 'no_matching_user_scope', snapshot };
    })();

    accessCache.set(normalizedPath, pending);
    return pending;
  };

  return { resolveDocumentAccess };
}

export async function assertAssistantDocumentAccess(userId, documentPath) {
  const resolver = createAssistantAccessResolver(userId);
  const normalizedPath = normalizeFirestorePath(documentPath);
  const access = await resolver.resolveDocumentAccess(normalizedPath);
  if (!access.allowed) {
    throw new Error(`document access denied for ${normalizedPath}`);
  }
  return access;
}

export function shouldSkipAssistantDiscoveryCollection(collectionId, explicitCollections = ASSISTANT_EXPLICIT_USER_COLLECTIONS) {
  if (!collectionId) {
    return true;
  }

  if (DISCOVERY_EXCLUDED_COLLECTIONS.has(collectionId)) {
    return true;
  }

  if (explicitCollections.some((spec) => spec.id === collectionId)) {
    return true;
  }

  return DISCOVERY_EXCLUDED_COLLECTION_PATTERNS.some((pattern) => pattern.test(collectionId));
}

export async function listAssistantAccessibleCollectionIds(userId, { limit = 24 } = {}) {
  const collectionRefs = await db.listCollections();
  const explicitIds = new Set(ASSISTANT_EXPLICIT_USER_COLLECTIONS.map((spec) => spec.id));
  const matched = new Set();

  for (const collectionRef of collectionRefs) {
    if (explicitIds.has(collectionRef.id)) {
      matched.add(collectionRef.id);
      continue;
    }

    if (shouldSkipAssistantDiscoveryCollection(collectionRef.id)) {
      continue;
    }

    for (const linkSpec of ASSISTANT_USER_SCOPE_FIELDS) {
      try {
        const snapshot = await collectionRef.where(linkSpec.field, linkSpec.operator, userId).limit(1).get();
        if (!snapshot.empty) {
          matched.add(collectionRef.id);
          break;
        }
      } catch {
        // Unsupported field/operator/index combinations are expected during safe discovery.
      }
    }
  }

  const collections = Array.from(matched).sort((left, right) => left.localeCompare(right));
  return {
    collections: collections.slice(0, limit),
    totalMatchedCollections: collections.length,
    truncated: collections.length > limit,
  };
}
