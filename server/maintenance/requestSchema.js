/**
 * Pure shape helpers for maintenance request documents.
 *
 * Kept free of Firestore imports so route handlers and the persistence layer can
 * both normalize payloads without booting firebase-admin.
 */

/** How a provider gets into the property when nobody is required to be home. */
export const MAINTENANCE_ACCESS_METHODS = [
  'unspecified',
  'owner_present',
  'tenant_present',
  'lockbox',
  'hidden_key',
  'smart_lock',
  'concierge',
];

export const AVAILABILITY_WINDOWS = ['morning', 'afternoon', 'evening'];

export const SUBMITTER_ROLES = ['owner', 'tenant', 'operator', 'system'];

/** Dispatch is held at this status until an operator picks the ticket up. */
export const AWAITING_OPERATOR_DISPATCH = 'awaiting_operator_dispatch';

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function buildDefaultPropertyAccess() {
  return {
    method: 'unspecified',
    instructions: '',
    code: '',
    smartLockProvider: '',
    contactName: '',
    contactPhone: '',
  };
}

export function mergePropertyAccess(existing = null, updates = null) {
  const merged = {
    ...buildDefaultPropertyAccess(),
    ...((existing && typeof existing === 'object') ? existing : {}),
    ...((updates && typeof updates === 'object') ? updates : {}),
  };

  const method = String(merged.method || '').trim();
  merged.method = MAINTENANCE_ACCESS_METHODS.includes(method) ? method : 'unspecified';

  for (const key of ['instructions', 'code', 'smartLockProvider', 'contactName', 'contactPhone']) {
    merged[key] = typeof merged[key] === 'string' ? merged[key] : '';
  }

  return merged;
}

export function describeAccessMethod(method) {
  switch (method) {
    case 'owner_present': return 'Owner will be on site';
    case 'tenant_present': return 'Tenant will be on site';
    case 'lockbox': return 'Lockbox on site';
    case 'hidden_key': return 'Hidden key on site';
    case 'smart_lock': return 'Smart lock code';
    case 'concierge': return 'Building concierge or front desk';
    default: return 'Access not specified';
  }
}

export function buildDefaultIntake() {
  return {
    mode: 'form',
    transcript: [],
    extracted: null,
    completedAt: null,
  };
}

export function mergeIntake(existing = null, updates = null) {
  const merged = {
    ...buildDefaultIntake(),
    ...((existing && typeof existing === 'object') ? existing : {}),
    ...((updates && typeof updates === 'object') ? updates : {}),
  };

  merged.mode = merged.mode === 'ai_chat' ? 'ai_chat' : 'form';
  merged.transcript = Array.isArray(merged.transcript)
    ? merged.transcript
      .filter((line) => line && typeof line === 'object')
      .map((line) => ({
        role: line.role === 'assistant' ? 'assistant' : 'user',
        content: String(line.content ?? line.text ?? ''),
        at: line.at || null,
      }))
      .filter((line) => line.content)
    : [];
  merged.extracted = merged.extracted && typeof merged.extracted === 'object' ? merged.extracted : null;

  return merged;
}

/**
 * Availability arrives as [{ date: 'YYYY-MM-DD', windows: ['morning'] }]. Anything
 * malformed is dropped rather than persisted, since dispatch reads this directly.
 */
export function normalizeAvailabilityWindows(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const date = String(entry.date || entry.dateStr || '').trim();
      const windows = Array.isArray(entry.windows)
        ? entry.windows
          .map((w) => String(w || '').trim().toLowerCase())
          .filter((w) => AVAILABILITY_WINDOWS.includes(w))
        : [];
      return { date, windows: [...new Set(windows)] };
    })
    .filter((entry) => entry.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Human-readable fallback so existing `tenantAvailability` consumers keep working. */
export function formatAvailabilityWindows(windows) {
  const normalized = normalizeAvailabilityWindows(windows);
  if (!normalized.length) return '';

  return normalized
    .map((entry) => {
      const date = new Date(`${entry.date}T12:00:00`);
      const dateLabel = Number.isNaN(date.getTime())
        ? entry.date
        : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return entry.windows.length ? `${dateLabel} (${entry.windows.join(', ')})` : dateLabel;
    })
    .join('; ');
}

export function normalizeSubmittedBy(value) {
  const source = value && typeof value === 'object' ? value : {};
  const role = String(source.role || '').trim().toLowerCase();

  return {
    role: SUBMITTER_ROLES.includes(role) ? role : 'tenant',
    userId: String(source.userId || ''),
    name: String(source.name || ''),
    email: normalizeEmail(source.email),
  };
}

export function normalizeOperatorLog(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      at: entry.at || new Date().toISOString(),
      actorEmail: normalizeEmail(entry.actorEmail),
      actorName: String(entry.actorName || ''),
      event: String(entry.event || ''),
      step: String(entry.step || ''),
      note: String(entry.note || ''),
    }))
    .filter((entry) => entry.event);
}
