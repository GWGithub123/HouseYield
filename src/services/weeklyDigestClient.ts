import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from './ownerFinanceApi';

export type WeeklyDigestSchedule = {
  weekday: string;
  localHour: number;
  localMinute: number;
  timeZone: string;
};

export type WeeklyDigestPreferences = {
  enabled: boolean;
  recipientEmail: string;
  includeFinancialDetails: boolean;
  includeGlobalContext: boolean;
  includeWebSearch: boolean;
  includeAiNarrative: boolean;
  includeManagementActivity: boolean;
  includeTaxUpdates: boolean;
  includeListingsWatch: boolean;
  watchedZipCodes: string[];
  schedule: WeeklyDigestSchedule;
  lastSentAt: string | null;
  lastSentLocalDate: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type WeeklyDigestFinancialWeek = {
  ok: boolean;
  available: boolean;
  rentCollected: number;
  expectedMonthlyRent: number | null;
  otherIncome: number;
  totalExpenses: number;
  topExpenseCategories: Array<{ category: string; amount: number }>;
  netCashFlow: number;
};

export type WeeklyDigestNarrative = {
  subject: string | null;
  executiveSummary: string;
  sectionInsights: Record<string, string>;
  personalNote: string | null;
  actionItems: string[];
};

export type WeeklyDigest = {
  generatedAt: string;
  window: { startDate: string; endDate: string; label: string };
  financialWeek?: WeeklyDigestFinancialWeek | null;
  propertyValue?: {
    available: boolean;
    propertyValue: number | null;
    weekChange: number | null;
    weekChangePercent: number | null;
  } | null;
  leases?: {
    ok: boolean;
    tenantCount: number;
    expectedMonthlyRent: number;
    expiringLeases: Array<{ tenantName: string; address: string | null; leaseEnd: string; daysUntil: number; monthlyRent: number | null }>;
    newLeases: Array<{ tenantName: string; address: string | null; leaseStart: string; monthlyRent: number | null }>;
    hasUpdates: boolean;
  } | null;
  managementActivity?: {
    ok: boolean;
    openMaintenanceCount: number;
    unreadMessageCount: number;
    collectedThisWeek: number;
    newMaintenanceRequests: Array<{ title: string; status: string; tenantName: string | null }>;
  } | null;
  pricingPower?: {
    properties: Array<{
      address: string | null;
      currentRent: number | null;
      marketMedianRent: number | null;
      pricingPowerDollar: number;
      pricingPowerPercent: number;
      position: string;
    }>;
  } | null;
  narrative?: WeeklyDigestNarrative | null;
  draft?: { subject: string; preview?: string };
};

export async function getWeeklyDigestPreferences(): Promise<WeeklyDigestPreferences> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/weekly-digest-preferences'),
  );
  if (!response?._httpOk || response?.ok !== true) {
    throw new Error(response?.error || 'Unable to load weekly recap settings');
  }
  return response.preferences as WeeklyDigestPreferences;
}

export async function updateWeeklyDigestPreferences(
  updates: Partial<WeeklyDigestPreferences> & { weekday?: string; localHour?: number; localMinute?: number; timeZone?: string },
): Promise<WeeklyDigestPreferences> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/weekly-digest-preferences'),
    { method: 'POST', body: JSON.stringify(updates) },
    { 'Content-Type': 'application/json' },
  );
  if (!response?._httpOk || response?.ok !== true) {
    throw new Error(response?.error || 'Unable to save weekly recap settings');
  }
  return response.preferences as WeeklyDigestPreferences;
}

export async function previewWeeklyDigest(): Promise<WeeklyDigest> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/weekly-digest-preview'),
    { method: 'POST', body: JSON.stringify({}) },
    { 'Content-Type': 'application/json' },
  );
  if (!response?._httpOk || response?.ok !== true) {
    throw new Error(response?.error || 'Unable to build weekly recap');
  }
  return response.digest as WeeklyDigest;
}

export async function sendWeeklyDigestNow(to?: string): Promise<{ ok: boolean; error?: string }> {
  const response = await requestOwnerFinanceJson(
    buildOwnerFinanceUrl('/api/assistant/weekly-digest-send'),
    { method: 'POST', body: JSON.stringify({ to: to || '' }) },
    { 'Content-Type': 'application/json' },
  );
  if (!response?._httpOk || response?.ok !== true) {
    return { ok: false, error: response?.error || 'Weekly recap send failed' };
  }
  return { ok: true };
}
