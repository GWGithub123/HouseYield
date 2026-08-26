export const ACCOUNTING_DOMAIN_VERSION = '2026.1';

export const ACCOUNTING_ENTITY_TYPES = {
  SOURCE_EVENT: 'source_event',
  FINANCE_EVENT: 'finance_event',
  JOURNAL_ENTRY: 'journal_entry',
  JOURNAL_LINE: 'journal_line',
  SUBLEDGER: 'subledger',
  EVIDENCE_RECORD: 'evidence_record',
  WORKPAPER_SNAPSHOT: 'workpaper_snapshot',
  REVIEW_ISSUE: 'review_issue',
  CLOSE_PERIOD: 'close_period'
};

export const ACCOUNTING_CLOSE_PERIOD_STATUSES = {
  OPEN: 'open',
  CLOSED: 'closed',
  REOPENED: 'reopened'
};

export const ACCOUNTING_REVIEW_STATES = {
  READY_FOR_REVIEW: 'ready_for_review',
  MISSING_SUPPORTING_DOCUMENTS: 'missing_supporting_documents',
  LOW_CONFIDENCE_EXTRACTION: 'low_confidence_extraction',
  RULES_PENDING_APPROVAL: 'rules_pending_approval',
  EXCEPTION_REQUIRES_REVIEW: 'exception_requires_review'
};

export const ACCOUNTING_PACKET_READINESS = {
  DRAFT: 'draft',
  READY_FOR_CPA_REVIEW: 'ready_for_cpa_review',
  BLOCKED_MISSING_DATA: 'blocked_missing_data',
  RELEASED: 'released'
};

export const ACCOUNTING_USER_ROLES = {
  OWNER: 'owner',
  BOOKKEEPER: 'bookkeeper',
  PROPERTY_MANAGER: 'property_manager',
  TAX_PREPARER: 'tax_preparer',
  ADMIN: 'admin'
};

export const ACCOUNTING_PRODUCT_COPY = {
  taxWorkpapersTitle: 'HouseYield Tax Workpapers',
  taxWorkpapersDescription: 'HouseYield organizes your bookkeeping records and source documents into draft tax workpapers for review by your CPA or tax preparer.',
  draftDisclaimer: 'Draft workpapers only. HouseYield does not provide tax or legal advice and does not prepare or sign your income tax return.',
  cpaPacketLabel: 'CPA Packet',
  cpaPacketDownloadLabel: 'Download CPA Packet',
  scheduleEDraftLabel: 'Generate Draft Schedule E',
  filingLabel: '1099 Filing',
  filingNotice: '1099 workflows are processed through an integrated information-return filing provider. This is separate from your income tax return.'
};

export function normalizeAccountingDate(dateValue) {
  if (!dateValue) {
    return null;
  }

  if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return dateValue;
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

export function getAccountingPeriodKey(dateValue) {
  const normalizedDate = normalizeAccountingDate(dateValue);
  if (!normalizedDate) {
    return null;
  }

  return normalizedDate.slice(0, 7);
}

export function getAccountingMonthBounds(periodKey) {
  if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) {
    return null;
  }

  const [yearString, monthString] = String(periodKey).split('-');
  const year = Number(yearString);
  const monthIndex = Number(monthString) - 1;
  const startDate = new Date(Date.UTC(year, monthIndex, 1));
  const endDate = new Date(Date.UTC(year, monthIndex + 1, 0));

  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10)
  };
}

export function formatAccountingPeriodLabel(periodKey) {
  if (!/^\d{4}-\d{2}$/.test(String(periodKey || ''))) {
    return String(periodKey || 'Unknown Period');
  }

  const [yearString, monthString] = String(periodKey).split('-');
  const date = new Date(Date.UTC(Number(yearString), Number(monthString) - 1, 1));
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}