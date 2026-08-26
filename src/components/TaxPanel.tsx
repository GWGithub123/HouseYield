/**
 * TaxPanel
 *
 * Plain, accounting-first tax surface for the Property Management page.
 * Backed by the canonical tax and bookkeeping clients so compatibility-route details stay out of the UI layer.
 *
 * Goals:
 *  - Schedule E summary in plain accounting language
 *  - Quarterly planning estimates (paid / remaining / due dates)
 *  - Tax deadlines list
 *  - 1099 vendor lane (status-by-vendor)
 *  - Workpaper packet snapshot + release controls (rules version, immutability)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ChevronDown, FileSpreadsheet, FolderCheck, Info, LayoutDashboard, Sparkles, X } from 'lucide-react';
import { auth } from '../config/firebase';
import { bookkeepingClient } from '../services/canonicalBookkeepingClient';
import { taxClient } from '../services/canonicalTaxClient';
import { type TaxpayerDraftProfile } from './tax/IrsDraftFormWorkspace';
import {
  buildFinanceSourceBreakdown,
  buildFinanceSourceFilename,
  FinanceSourceTruthBanner,
  SourceBadge,
  buildFinanceSourceMix,
} from './finance/FinanceSourceTruth';
import FinanceAuditRail, { type FinanceAuditSection } from './finance/FinanceAuditRail';
import MetricExplainButton from './finance/MetricExplainButton';
import FinanceSearchWorkspace from './finance/FinanceSearchWorkspace';
import {
  getFinanceAuditRulesSources,
  type FinanceAuditRulesSources,
} from '../services/financeAuditClient';
import { getTaxRulesetPackage } from '../shared/taxRules.js';
import FinanceAssistantHeader from './finance/FinanceAssistantHeader';
import {
  GlossaryTip,
  SectionGroupHeader,
  SectionHost,
  useWorkspaceNav,
  WorkspaceSubTabs,
  type WorkspaceSectionDef,
  type WorkspaceTabDef,
} from './finance/financeWorkspaceNav';

const TAX_TABS: WorkspaceTabDef[] = [
  {
    id: 'overview',
    label: 'My Taxes',
    icon: LayoutDashboard,
    accent: 'emerald',
    description: 'Your rental income, expenses, and what you may owe — at a glance.',
  },
  {
    id: 'filings',
    label: 'CPA Documents',
    icon: FolderCheck,
    accent: 'violet',
    description: 'Download your tax packet, check off required documents, and see contractor 1099 status.',
  },
];

const TAX_SECTIONS: WorkspaceSectionDef[] = [
  {
    id: 'filing-cockpit',
    tabId: 'overview',
    title: 'Your tax summary',
    description: 'Rental income, expenses, and where your filing stands — the whole picture at a glance.',
    keywords: ['packet readiness', 'filing', 'blockers', 'handoff', 'net due', 'liability', 'income', 'expenses'],
  },
  {
    id: 'schedule-e-summary',
    tabId: 'overview',
    title: 'Income & expenses detail',
    description: 'Rental income, expenses, and net result for your tax return.',
    keywords: ['schedule e', 'rental income', 'net income', 'expenses'],
  },
  {
    id: 'tax-analytics',
    tabId: 'overview',
    title: 'Charts',
    description: 'Visual breakdown of your rental income and expenses.',
    keywords: ['chart', 'analytics', 'graph'],
  },
  {
    id: 'checklist-outlook',
    tabId: 'filings',
    title: 'Document checklist',
    description: 'What your CPA needs and what\'s already ready.',
    keywords: ['checklist', 'required documents', 'blockers'],
  },
  {
    id: 'vendors-1099',
    tabId: 'filings',
    title: 'Contractor tax forms (1099s)',
    description: 'Contractors you paid over $2,000 — forms required by the IRS.',
    keywords: ['1099', 'vendor', 'contractor', 'w-9', 'nec'],
  },
  {
    id: 'cpa-exports',
    tabId: 'filings',
    title: 'Download tax documents',
    description: 'Download your tax packet to share with your CPA.',
    keywords: ['export', 'download', 'cpa'],
  },
];

interface TaxPanelProps {
  propertyId?: string;
  propertyAddress?: string;
}

interface YearSummary {
  taxYear: number;
  scheduleE: {
    totalIncome?: number;
    totalExpenses?: number;
    netIncomeOrLoss?: number;
    depreciation?: number;
    [k: string]: any;
  };
  depreciation: { totalCurrentYearDepreciation?: number; assetCount?: number; [k: string]: any };
  entryCount: number;
  propertyCount: number;
}

interface WorkpaperSnapshot {
  rulesVersion?: string;
  packetReadiness?: string;
  generatedAt?: string;
  summary?: any;
  entryCount?: number;
  propertyCount?: number;
  vendorCount?: number;
  documentChecklist?: { items?: any[] } | any;
  draftFormProfile?: TaxpayerDraftProfile;
  draftFormProfileUpdatedAt?: string;
  draftFormProfileUpdatedBy?: string;
  [k: string]: any;
}

interface TaxRuleSourceDocument {
  id: string;
  authority: string;
  title: string;
  url?: string | null;
  category?: string | null;
  applicableYear?: number | null;
  publishedLabel?: string | null;
  pageUpdatedAt?: string | null;
  lastReviewedAt?: string | null;
  scope?: string | null;
}

interface TaxRulesPackage {
  taxYear?: number;
  referenceTaxYear?: number;
  rulesVersion?: string;
  approvalStatus?: string;
  sourceCitations?: string[];
  sourceDocuments?: TaxRuleSourceDocument[];
  sourceRuleAudits?: SourceRuleAuditRecord[];
  lastReviewedAt?: string | null;
  governance?: {
    requestedTaxYear?: number;
    supportedTaxYear?: number;
    coverageStatus?: string;
    freshnessStatus?: string;
    warnings?: string[];
    isRequestedTaxYearFullySupported?: boolean;
  } | null;
  scopeSummary?: string | null;
  estimatedTaxMethodology?: string | null;
  stateTaxMethodology?: string | null;
  [k: string]: any;
}

interface SourceRuleAuditRecord {
  id?: string;
  label?: string;
  status?: string;
  sourceDocumentId?: string | null;
  sourceTitle?: string | null;
  evidence?: string | null;
  mismatch?: boolean;
  extractedThreshold?: number | null;
  candidateThreshold?: number | null;
  auditType?: string;
  requiredForActivation?: boolean;
  activationBlockers?: string[];
  matchedAmountCount?: number;
  expectedAmountCount?: number;
  warnings?: string[];
  blockers?: string[];
}

interface AppliedTaxRuleGroup {
  id: string;
  label: string;
  status: 'applied' | 'missing' | string;
  sourceDocumentIds?: string[];
  summary?: string;
  details?: Array<{
    label?: string;
    value?: string | number | null;
  }>;
}

interface TaxRulesValidationSummary {
  status?: string;
  sourceDocumentCount?: number;
  sourceRuleAuditCount?: number;
  requiredSourceRuleAuditCount?: number;
  passedSourceRuleAuditCount?: number;
  blockedSourceRuleAuditCount?: number;
  sourceRuleAudits?: SourceRuleAuditRecord[];
  appliedRuleGroupCount?: number;
  warningCount?: number;
  warnings?: string[];
  blockers?: string[];
  activationAllowed?: boolean;
  sourceCoverage?: {
    documentCount?: number;
    irsDocumentCount?: number;
    houseYieldDocumentCount?: number;
    missingUrlCount?: number;
    missingReviewDateCount?: number;
  };
  groupResults?: Array<{
    id?: string;
    label?: string;
    status?: string;
  }>;
}

interface TaxRulesRuntimeSummary {
  status?: string;
  source?: string;
  error?: string | null;
  rulesVersion?: string | null;
  approvalStatus?: string | null;
  lastReviewedAt?: string | null;
  governance?: TaxRulesPackage['governance'] | null;
}

interface TaxRulesMetadata {
  taxYear?: number;
  generatedAt?: string;
  rulesRuntime?: TaxRulesRuntimeSummary | null;
  validation?: TaxRulesValidationSummary | null;
  activationValidation?: TaxRulesValidationSummary | null;
  appliedRuleGroups?: AppliedTaxRuleGroup[];
  sourceDocuments?: TaxRuleSourceDocument[];
}

function buildFallbackTaxRulesMetadata(year: number, fallbackRuleset: TaxRulesPackage): TaxRulesMetadata {
  return {
    taxYear: year,
    generatedAt: undefined,
    rulesRuntime: {
      status: 'loading',
      source: 'static_shared_rules',
      rulesVersion: fallbackRuleset.rulesVersion || null,
      approvalStatus: fallbackRuleset.approvalStatus || null,
      lastReviewedAt: fallbackRuleset.lastReviewedAt || null,
    },
    validation: {
      status: fallbackRuleset.governance?.warnings?.length ? 'attention_needed' : 'loading',
      sourceDocumentCount: fallbackRuleset.sourceDocuments?.length || 0,
      appliedRuleGroupCount: 0,
      warningCount: fallbackRuleset.governance?.warnings?.length || 0,
      warnings: fallbackRuleset.governance?.warnings || [],
    },
    activationValidation: null,
    sourceDocuments: fallbackRuleset.sourceDocuments || [],
    appliedRuleGroups: [],
  };
}

interface TaxRulesetHistoryRecord {
  taxRulesetId?: string | null;
  taxYear?: number;
  rulesVersion?: string;
  approvalStatus?: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt?: string | null;
  ruleset?: TaxRulesPackage | null;
}

interface TaxRulesIngestionResult {
  ok?: boolean;
  status?: string;
  taxYear?: number;
  rulesVersion?: string;
  extraction?: {
    provider?: string;
    confidence?: number;
    warningCount?: number;
    blockerCount?: number;
    ruleDiffCount?: number;
  };
  fixtureGate?: {
    status?: string;
    error?: string;
  };
  extractionGate?: {
    status?: string;
    reason?: string;
    confidence?: number;
  };
  validation?: TaxRulesValidationSummary | null;
  activation?: {
    ok?: boolean;
    approvalStatus?: string;
    rulesVersion?: string;
  } | null;
  generatedAt?: string;
}

interface TaxEdgeCaseReview {
  provider?: string;
  status?: string;
  summary?: string;
  blockers?: string[];
  warnings?: string[];
  missingInfoQuestions?: string[];
  citations?: string[];
  claudeAvailable?: boolean;
}

type StateWithholdingSource = 'manual_input' | 'draft_profile' | 'confirmed_w2_documents';

interface StateWithholdingDerivation {
  total?: number | null;
  byState?: Record<string, number>;
  documents?: Array<{
    documentId?: string;
    employerOrPayorName?: string | null;
    states?: string[];
    stateWithholding?: number;
  }>;
  reason?: string | null;
}

interface StateWithholdingInfo {
  provided?: boolean;
  input?: number | null;
  ytdInput?: number | null;
  applied?: number;
  source?: StateWithholdingSource | null;
  appliedAgainst?: string;
  stateNetDue?: number;
  stateOverpayment?: number;
  note?: string;
  derivation?: StateWithholdingDerivation | null;
}

interface PersonalUseAdjustmentLine {
  line?: number | null;
  name?: string;
  before?: number;
  after?: number;
  disallowed?: number;
}

interface ScheduleEPersonalUseAdjustment {
  applied?: boolean;
  lowConfidence?: boolean;
  properties?: Array<{
    propertyId: string;
    propertyName?: string;
    personalUseDays?: number;
    fairRentalDays?: number;
    rentalUsePct?: number;
    lowConfidence?: boolean;
  }>;
  byLine?: Record<string, PersonalUseAdjustmentLine>;
  totalExpensesBefore?: number;
  totalExpensesAfter?: number;
  totalDisallowedExpenses?: number;
  notes?: string[];
}

interface TaxLiabilityStateDetail {
  state?: string | null;
  stateName?: string | null;
  tax?: number;
  effectiveRate?: number;
  type?: string | null;
  note?: string | null;
  incomeFromState?: number;
  propertyCount?: number;
  isHomeState?: boolean;
}

interface TaxLiabilityResult {
  generatedAt?: string;
  income?: {
    rental?: number;
    rentalBeforeDepreciation?: number;
    depreciation?: number;
    rentalAllowable?: number;
    carryforwardLoss?: number;
    other?: number;
    gross?: number;
  };
  deductions?: {
    method?: string;
    standardDeduction?: number;
    itemizedDeductions?: number;
    totalDeductions?: number;
    qbiDeduction?: number;
  };
  taxableIncome?: number;
  taxableIncomeBeforeQbi?: number;
  stateTaxableIncome?: number;
  taxes?: {
    federal?: number;
    state?: number;
    stateDetails?: TaxLiabilityStateDetail[];
    niit?: number;
    total?: number;
    creditsApplied?: number;
    withholdingApplied?: number;
    stateWithholdingApplied?: number;
    stateNetDue?: number;
    stateOverpayment?: number;
    afterCredits?: number;
    netDue?: number;
    overpayment?: number;
  };
  stateWithholding?: StateWithholdingInfo | null;
  personalUseAdjustment?: {
    applies?: boolean;
    scheduleE?: ScheduleEPersonalUseAdjustment | null;
    depreciation?: { before?: number; after?: number; disallowed?: number } | null;
    notes?: string[];
  } | null;
  rates?: {
    effectiveFederal?: number;
    marginalFederal?: number;
    effectiveState?: number;
    effectiveTotal?: number;
  };
  modelingReadiness?: {
    status?: string;
    blockers?: string[];
    warnings?: string[];
  } | null;
  priorYearContext?: {
    priorYearTotalTax?: number | null;
    priorYearAdjustedGrossIncome?: number | null;
    priorYearSafeHarborPercent?: number | null;
  } | null;
  passiveLoss?: {
    hasLoss?: boolean;
    totalLoss?: number;
    allowableLoss?: number;
    disallowedLoss?: number;
    carryforwardLoss?: number;
    activeParticipationAllowance?: number;
    magiLimit?: boolean;
    reason?: string;
  } | null;
  qbi?: {
    eligible?: boolean;
    applied?: boolean;
    deduction?: number;
    safeHarborMet?: boolean;
    reason?: string;
    details?: {
      rentalHoursPerYear?: number;
      hoursNeeded?: number;
      limitation?: string;
      taxableIncomeBeforeQbi?: number;
      taxableIncomeAfterQbi?: number;
      ubiaQualifiedProperty?: number;
    } | null;
  } | null;
  federalBreakdown?: Array<{
    bracket: string;
    range: string;
    taxableAmount: number;
    tax: number;
  }>;
}

interface VendorRow {
  id?: string;
  name: string;
  vendorType?: string;
  ein?: string;
  ssnLast4?: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  email?: string | null;
  phone?: string | null;
  w9OnFile?: boolean;
  ytdAmount?: number;
  ytdPaid?: number;
  transactionCount?: number;
  requires1099?: boolean;
  threshold1099?: number;
  needsSetup?: boolean;
}

interface Form1099 {
  recipientName: string;
  recipientTIN: string;
  recipientAddress?: string;
  amount: number;
  formType: string;
  w9OnFile: boolean;
  missingInfo?: string[];
}

interface ScheduleELineEntry {
  entryId?: string | null;
  date: string;
  description: string;
  amount: number;
  vendor?: string | null;
  propertyId?: string | null;
  source?: string | null;
  sourceRef?: string | null;
  financeEventType?: string | null;
}

interface ScheduleELineDetail {
  line: number | null;
  name: string;
  amount: number;
  entries: ScheduleELineEntry[];
  mortgageSplitApplied?: boolean;
  principalExcluded?: number;
  personalUseProrated?: boolean;
  personalUseDisallowed?: number;
}

interface ScheduleEPropertySummary {
  id: string;
  name: string;
  address?: string;
  income: number;
  totalExpenses: number;
}

interface ScheduleEDetail {
  taxYear: number;
  propertyId?: string | null;
  scheduleELines: Record<string, ScheduleELineDetail>;
  propertySummaries?: ScheduleEPropertySummary[];
  personalUseAdjustment?: ScheduleEPersonalUseAdjustment | null;
  summary: {
    totalIncome?: number;
    totalExpenses?: number;
    netIncomeOrLoss?: number;
  };
  entryCount: number;
  generatedAt?: string;
}

interface ChecklistDocument {
  name: string;
  required: boolean;
  status: string;
  dueDate?: string;
  icon?: string;
  dataSource?: 'ledger' | 'generated' | string;
  preview?: Record<string, unknown>;
}

interface DocumentChecklist {
  taxYear?: number;
  rulesVersion?: string;
  packetReadiness?: string;
  generatedAt?: string;
  summary?: {
    total?: number;
    required?: number;
    ready?: number;
    actionRequired?: number;
    nextDeadline?: string;
  };
  documents?: ChecklistDocument[];
}

interface PacketReleaseIntelligence {
  readinessStatus: string;
  regime: string;
  score: number;
  summary: string;
  blockers: string[];
  warnings: string[];
  strengths: string[];
  recommendedActions: string[];
  sourceMetrics: {
    packetReadiness: string;
    blockingDocumentCount: number;
    reportable1099Forms: number;
    formsWithMissingInfo: number;
    totalEvidence: number;
    processedEvidenceCount: number;
    packetReleaseCount: number;
  };
  canonicalStatus: {
    evidence: string;
    releases: string;
  };
}

interface FinanceEvidenceRecord {
  evidenceId: string;
  evidenceType: string;
  title: string;
  vendorName?: string | null;
  amount?: number | null;
  documentDate?: string | null;
  digitizationStatus?: string | null;
  externalUrl?: string | null;
  storagePath?: string | null;
}

interface PersonalTaxDocumentRecord {
  id: string;
  title: string;
  documentType?: string | null;
  vendorName?: string | null;
  documentDate?: string | null;
  amount?: number | null;
  notes?: string | null;
  originalFileName?: string | null;
  contentPreview?: string | null;
  extractedFields?: Record<string, unknown> | null;
  createdAt: string;
  digitization?: {
    status?: string | null;
    summary?: string | null;
    personalTaxExtraction?: {
      provider?: string | null;
      model?: string | null;
      status?: string | null;
      documentSubtype?: string | null;
      confidence?: string | null;
      reviewNotes?: string[] | null;
    } | null;
  } | null;
  evidenceShadow?: {
    status?: string | null;
    evidenceType?: string | null;
    error?: string | null;
  } | null;
  isMockData?: boolean;
  mockDataTag?: string | null;
  sampleBacktest?: {
    fixtureName?: string | null;
    role?: string | null;
    employeeName?: string | null;
  } | null;
}

interface ScheduleLineEvidenceState {
  status: 'idle' | 'loading' | 'loaded' | 'error' | 'not_configured';
  evidence: FinanceEvidenceRecord[];
  error?: string | null;
}

interface FilingCockpitItem {
  id: string;
  lane: 'packet' | 'estimate' | '1099' | 'checklist' | 'release';
  title: string;
  detail: string;
  meta?: string;
  priority: number;
}

interface VendorDraft {
  name: string;
  vendorType: string;
  tin: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  phone: string;
  w9OnFile: boolean;
  notes: string;
}

const EMPTY_TAXPAYER_DRAFT_PROFILE: TaxpayerDraftProfile = {
  primaryName: '',
  spouseName: '',
  tinLast4: '',
  mailingStreet: '',
  mailingCity: '',
  mailingState: '',
  mailingZip: '',
};

const SAMPLE_TAX_BACKTEST = {
  fixtureName: 'Prestwick 2025 practice taxpayer',
  taxYear: 2025,
  taxpayer: 'Alex Practice & Jordan Practice',
  source: 'Simulated contractor W-9s + Prestwick rental ledger',
  profile: {
    homeState: 'MD',
    draftFormProfile: {
      primaryName: 'Alex Practice',
      spouseName: 'Jordan Practice',
      tinLast4: '1234',
      mailingStreet: '123 Ledger Lane',
      mailingCity: 'Baltimore',
      mailingState: 'MD',
      mailingZip: '21201',
    } satisfies TaxpayerDraftProfile,
  },
  scheduleE: [
    { id: 'line3RentsReceived', label: 'Line 3 rents received', expected: 62200 },
    { id: 'line4RoyaltiesReceived', label: 'Line 4 royalties received', expected: 0 },
    { id: 'line18Depreciation', label: 'Line 18 depreciation', expected: 16981.82 },
    { id: 'line20TotalExpenses', label: 'Line 20 total expenses', expected: 60153.30 },
    { id: 'line21IncomeOrLoss', label: 'Line 21 income or loss', expected: 2046.70 },
    { id: 'line26TotalIncomeOrLoss', label: 'Line 26 total income or loss', expected: 2046.70 },
  ],
  forms1099Nec: [
    {
      recipientName: 'Potomac Home Services',
      recipientTIN: '12-3456789',
      recipientAddress: '77 Tradesman Lane, Rockville MD 20852',
      box1NonemployeeCompensation: 2585,
      readiness: 'ready',
    },
    {
      recipientName: 'Potomac Green Landscaping LLC',
      recipientTIN: '52-7654321',
      recipientAddress: '42 Garden Road, Potomac MD 20854',
      box1NonemployeeCompensation: 760,
      readiness: 'ready',
    },
  ],
};

function roundForCompare(value: unknown) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function valuesMatch(expected: unknown, generated: unknown) {
  if (typeof expected === 'number' || typeof generated === 'number') {
    return Math.abs(roundForCompare(expected) - roundForCompare(generated)) < 0.01;
  }
  return String(expected || '').trim() === String(generated || '').trim();
}

function backtestStatusClass(matches: boolean) {
  return matches
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
    : 'border-rose-300 bg-rose-50 text-rose-700';
}

function normalizeCurrencyField(value: unknown) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return '';
  return cleaned;
}

function parseCurrencyNumber(value: unknown) {
  const cleaned = normalizeCurrencyField(value);
  if (!cleaned) return 0;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : 0;
}

function describeStateWithholdingSource(source?: StateWithholdingSource | null) {
  switch (source) {
    case 'manual_input':
      return 'manual input';
    case 'draft_profile':
      return 'saved draft profile';
    case 'confirmed_w2_documents':
      return 'from confirmed W-2s';
    default:
      return 'not provided';
  }
}

function stateWithholdingSourceBadgeClass(source?: StateWithholdingSource | null) {
  switch (source) {
    case 'confirmed_w2_documents':
      return 'border-emerald-300 bg-emerald-50 text-emerald-700';
    case 'draft_profile':
      return 'border-sky-300 bg-sky-50 text-sky-700';
    case 'manual_input':
      return 'border-slate-300 bg-slate-50 text-slate-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-500';
  }
}

function toTaxApiFilingStatus(status: string) {
  switch (String(status || '').toLowerCase()) {
    case 'mfj':
      return 'married_filing_jointly';
    case 'mfs':
      return 'married_filing_separately';
    case 'hoh':
      return 'head_of_household';
    default:
      return 'single';
  }
}

function normalizeDraftFormProfile(profile?: Partial<TaxpayerDraftProfile> | null, fallbackState = ''): TaxpayerDraftProfile {
  return {
    primaryName: String(profile?.primaryName || '').trim(),
    spouseName: String(profile?.spouseName || '').trim(),
    tinLast4: String(profile?.tinLast4 || '').replace(/\D/g, '').slice(0, 4),
    mailingStreet: String(profile?.mailingStreet || '').trim(),
    mailingCity: String(profile?.mailingCity || '').trim(),
    mailingState: String(profile?.mailingState || fallbackState || '').trim().toUpperCase().slice(0, 2),
    mailingZip: String(profile?.mailingZip || '').trim(),
  };
}

function fmtMoney(value: number | string | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function fmtDate(input: string | null | undefined) {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function flattenObjectEntries(
  value: unknown,
  prefix = '',
  results: Array<{ key: string; value: unknown }> = [],
) {
  if (value === null || value === undefined) {
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenObjectEntries(item, `${prefix}[${index}]`, results));
    return results;
  }

  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, nestedValue]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenObjectEntries(nestedValue, nextPrefix, results);
    });
    return results;
  }

  results.push({ key: prefix, value });
  return results;
}

function findStringFieldValue(record: Record<string, unknown> | null | undefined, candidateKeys: string[]) {
  const normalizedCandidateKeys = candidateKeys.map((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase());
  const flattened = flattenObjectEntries(record);

  for (const entry of flattened) {
    const normalizedKey = entry.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!normalizedCandidateKeys.some((candidate) => normalizedKey.includes(candidate))) {
      continue;
    }
    const stringValue = String(entry.value ?? '').trim();
    if (stringValue) {
      return stringValue;
    }
  }

  return null;
}

function findNumericFieldValue(record: Record<string, unknown> | null | undefined, candidateKeys: string[]) {
  const normalizedCandidateKeys = candidateKeys.map((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase());
  const flattened = flattenObjectEntries(record);

  for (const candidate of normalizedCandidateKeys) {
    for (const entry of flattened) {
      const normalizedKey = entry.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalizedKey !== candidate) {
        continue;
      }
      const numericValue = Number(String(entry.value ?? '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(numericValue)) {
        return numericValue;
      }
    }
  }

  for (const candidate of normalizedCandidateKeys) {
    for (const entry of flattened) {
      const normalizedKey = entry.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (!normalizedKey.endsWith(candidate) && !normalizedKey.startsWith(candidate)) {
        continue;
      }
      const numericValue = Number(String(entry.value ?? '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(numericValue)) {
        return numericValue;
      }
    }
  }

  for (const entry of flattened) {
    const normalizedKey = entry.key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!normalizedCandidateKeys.some((candidate) => normalizedKey.includes(candidate))) {
      continue;
    }
    const numericValue = Number(String(entry.value ?? '').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return null;
}

const MAX_REASONABLE_W2_WAGES = 5_000_000;

function sanitizeParsedW2Amount(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (!Number.isFinite(numeric) || numeric > MAX_REASONABLE_W2_WAGES) {
    return null;
  }
  return numeric;
}

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

function parseMoneyCandidate(value: string | null | undefined) {
  const cleaned = String(value || '').replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickLikelyMoneyMatch(matches: string[]) {
  const parsed = matches
    .map((match) => ({
      raw: match,
      value: parseMoneyCandidate(match),
    }))
    .filter((entry) => entry.value !== null) as Array<{ raw: string; value: number }>;

  const filtered = parsed.filter((entry) => {
    const raw = entry.raw.replace(/[$,\s-]/g, '');
    return !(raw.length === 4 && !entry.raw.includes('.') && entry.value >= 1900 && entry.value <= 2100);
  });

  const candidates = filtered.length > 0 ? filtered : parsed;
  return candidates.length > 0 ? candidates[candidates.length - 1].value : null;
}

function extractMoneyForLabels(text: string, labels: string[]) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabels = labels.map((label) => label.replace(/[^a-z0-9]/gi, '').toLowerCase());
  const lineMatchesLabel = (line: string) => {
    const normalizedLine = line.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalizedLabels.some((label) => label && normalizedLine.includes(label));
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!lineMatchesLabel(line)) {
      continue;
    }

    const nearbyCandidates = [
      line,
      `${line} ${lines[index + 1] || ''}`.trim(),
      `${lines[index - 1] || ''} ${line}`.trim(),
    ];

    for (const candidate of nearbyCandidates) {
      const matches = candidate.match(/-?\$?\d[\d,]*(?:\.\d{2})?/g) || [];
      const picked = pickLikelyMoneyMatch(matches);
      if (picked !== null) {
        return picked;
      }
    }
  }

  const compactText = text.replace(/\s+/g, ' ');
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = compactText.match(new RegExp(`${escapedLabel}[\\s:.-]{0,12}([^]{0,72}?)`, 'i'));
    const candidates = match?.[1]?.match(/-?\$?\d[\d,]*(?:\.\d{2})?/g) || [];
    const picked = pickLikelyMoneyMatch(candidates);
    if (picked !== null) {
      return picked;
    }
  }

  return null;
}

function extractTextForLabels(text: string, labels: string[]) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLabels = labels.map((label) => label.replace(/[^a-z0-9]/gi, '').toLowerCase());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = line.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const matchedLabel = normalizedLabels.find((label) => label && normalizedLine.includes(label));
    if (!matchedLabel) continue;

    const originalLabel = labels[normalizedLabels.indexOf(matchedLabel)] || '';
    const escaped = originalLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sameLine = line.replace(new RegExp(`^\\s*(?:box\\s*)?\\d{0,2}\\s*${escaped}\\s*[:.-]?\\s*`, 'i'), '').trim();
    const candidate = sameLine && sameLine !== line ? sameLine : lines[index + 1] || '';
    const cleaned = candidate
      .replace(/\b(box\s*)?\d{1,2}\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned && !/^\$?\d[\d,]*(?:\.\d{2})?$/.test(cleaned)) {
      return cleaned.slice(0, 160);
    }
  }

  return null;
}

function inferTaxYearFromDocument(document: PersonalTaxDocumentRecord) {
  const candidates = [
    document.documentDate,
    document.title,
    document.originalFileName,
    document.contentPreview,
  ]
    .filter(Boolean)
    .join(' ');

  const explicitMatch = candidates.match(/\b(20[1-4]\d)\b/);
  if (explicitMatch) {
    const year = Number(explicitMatch[1]);
    if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
      return year;
    }
  }

  const documentDate = String(document.documentDate || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) {
    const year = Number(documentDate.slice(0, 4));
    return Number.isInteger(year) ? year : null;
  }

  return null;
}

function inferLikelyW2FromDocument(document: PersonalTaxDocumentRecord) {
  const searchable = [
    document.title,
    document.originalFileName,
    document.contentPreview,
    document.vendorName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return searchable.includes('w-2')
    || searchable.includes('w2')
    || searchable.includes('wage and tax statement')
    || searchable.includes('federal income tax withheld')
    || searchable.includes('wages, tips, other compensation');
}

function inferStateEntriesFromContentPreview(contentPreview?: string | null) {
  const text = String(contentPreview || '');
  if (!text.trim()) {
    return [] as Array<{ state: string | null; stateId: string | null; wages: number | null; withholding: number | null }>;
  }

  const stateWages = extractMoneyForLabels(text, ['state wages, tips, etc', 'state wages']);
  const stateWithholding = extractMoneyForLabels(text, ['state income tax', 'state income tax withheld', 'state withholding']);
  const stateMatch = text.match(/\b([A-Z]{2})\b/);
  const state = stateMatch && US_STATE_CODES.has(stateMatch[1]) ? stateMatch[1] : null;

  if (stateWages == null && stateWithholding == null && !state) {
    return [];
  }

  return [{
    state,
    stateId: null,
    wages: stateWages,
    withholding: stateWithholding,
  }];
}

function buildHeuristicW2Extraction(document: PersonalTaxDocumentRecord) {
  const text = String(document.contentPreview || '');
  const looksLikeW2 = inferLikelyW2FromDocument(document);
  if (!looksLikeW2) {
    return null;
  }

  const wages = extractMoneyForLabels(text, ['wages, tips, other compensation', 'box 1 wages', 'box1 wages']);
  const federalWithholding = extractMoneyForLabels(text, ['federal income tax withheld', 'federal income tax', 'box 2 federal income tax withheld', 'box2']);
  const socialSecurityWages = extractMoneyForLabels(text, ['social security wages', 'box 3']);
  const socialSecurityTax = extractMoneyForLabels(text, ['social security tax withheld', 'box 4']);
  const medicareWages = extractMoneyForLabels(text, ['medicare wages and tips', 'medicare wages', 'box 5']);
  const medicareTax = extractMoneyForLabels(text, ['medicare tax withheld', 'box 6']);
  const stateEntries = inferStateEntriesFromContentPreview(document.contentPreview);
  const taxYear = inferTaxYearFromDocument(document);

  const hasPrimaryAmounts = wages !== null || federalWithholding !== null || stateEntries.some((entry) => entry.withholding != null || entry.wages != null);
  const extractionStatus = hasPrimaryAmounts ? 'parsed' : 'partial';

  return {
    documentSubtype: 'w2',
    extractionStatus,
    confidence: hasPrimaryAmounts ? 'medium' : 'low',
    taxYear,
    employerName: extractTextForLabels(text, ['employer name', 'employer']),
    employeeName: extractTextForLabels(text, ['employee name', 'employee']),
    wages,
    federalWithholding,
    socialSecurityWages,
    socialSecurityTax,
    medicareWages,
    medicareTax,
    stateEntries,
    reviewNotes: hasPrimaryAmounts
      ? ['Heuristic W-2 fallback filled fields from OCR text because structured extraction was incomplete.']
      : ['Likely W-2 detected, but OCR text did not expose enough box-level values to extract totals automatically.'],
  };
}

function extractStructuredStateEntries(record: Record<string, unknown> | null | undefined) {
  if (!record || typeof record !== 'object') {
    return [] as Array<{ state: string | null; stateId: string | null; wages: number | null; withholding: number | null }>;
  }

  const personalTax = record.personalTax && typeof record.personalTax === 'object' && !Array.isArray(record.personalTax)
    ? record.personalTax as Record<string, unknown>
    : null;
  const rawStateEntries = Array.isArray(personalTax?.stateEntries)
    ? personalTax.stateEntries
    : Array.isArray(record.stateEntries)
      ? record.stateEntries
      : [];

  return rawStateEntries
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }

      const wages = Number(String((entry as Record<string, unknown>).wages ?? '').replace(/[^0-9.-]/g, ''));
      const withholding = Number(String((entry as Record<string, unknown>).withholding ?? '').replace(/[^0-9.-]/g, ''));
      const state = String((entry as Record<string, unknown>).state ?? '').trim().toUpperCase();
      const stateId = String((entry as Record<string, unknown>).stateId ?? '').trim();

      return {
        state: state || null,
        stateId: stateId || null,
        wages: Number.isFinite(wages) ? wages : null,
        withholding: Number.isFinite(withholding) ? withholding : null,
      };
    })
    .filter((entry): entry is { state: string | null; stateId: string | null; wages: number | null; withholding: number | null } => (
      Boolean(entry && (entry.state || entry.stateId || entry.wages != null || entry.withholding != null))
    ));
}

function extractStructuredReviewNotes(record: Record<string, unknown> | null | undefined) {
  if (!record || typeof record !== 'object') {
    return [] as string[];
  }

  const personalTax = record.personalTax && typeof record.personalTax === 'object' && !Array.isArray(record.personalTax)
    ? record.personalTax as Record<string, unknown>
    : null;
  const rawReviewNotes = Array.isArray(personalTax?.reviewNotes)
    ? personalTax.reviewNotes
    : Array.isArray(record.reviewNotes)
      ? record.reviewNotes
      : [];

  return rawReviewNotes
    .map((note) => String(note ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function buildParsedPersonalTaxDocument(document: PersonalTaxDocumentRecord) {
  const extractedFields = document.extractedFields || {};
  const heuristic = buildHeuristicW2Extraction(document);
  const documentSubtype = String(
    findStringFieldValue(extractedFields, ['documentsubtype'])
    || document.digitization?.personalTaxExtraction?.documentSubtype
    || heuristic?.documentSubtype
    || '',
  ).toLowerCase() || null;
  const taxYearValue = findNumericFieldValue(extractedFields, ['taxyear']) ?? heuristic?.taxYear ?? null;
  const stateEntries = extractStructuredStateEntries(extractedFields);
  const resolvedStateEntries = stateEntries.length > 0 ? stateEntries : (heuristic?.stateEntries || []);
  const firstStateEntry = resolvedStateEntries[0] || null;

  return {
    ...document,
    documentSubtype,
    extractionStatus: findStringFieldValue(extractedFields, ['extractionstatus'])
      || document.digitization?.personalTaxExtraction?.status
      || heuristic?.extractionStatus
      || null,
    confidence: findStringFieldValue(extractedFields, ['confidence'])
      || document.digitization?.personalTaxExtraction?.confidence
      || heuristic?.confidence
      || null,
    employerName: findStringFieldValue(extractedFields, ['employerorpayorname', 'employername']) || heuristic?.employerName || document.vendorName || null,
    employeeName: findStringFieldValue(extractedFields, ['employeename']) || heuristic?.employeeName || null,
    taxYear: taxYearValue != null ? Math.round(taxYearValue) : null,
    wages: sanitizeParsedW2Amount(
      findNumericFieldValue(extractedFields, ['box1wages', 'box1', 'federalwages', 'wages']) ?? heuristic?.wages ?? null,
    ),
    federalWithholding: sanitizeParsedW2Amount(
      findNumericFieldValue(extractedFields, ['federalwithholding', 'box2federalincometaxwithheld', 'box2']) ?? heuristic?.federalWithholding ?? null,
    ),
    socialSecurityWages: findNumericFieldValue(extractedFields, ['socialsecuritywages', 'box3']) ?? heuristic?.socialSecurityWages ?? null,
    socialSecurityTax: findNumericFieldValue(extractedFields, ['socialsecuritytax', 'box4']) ?? heuristic?.socialSecurityTax ?? null,
    medicareWages: findNumericFieldValue(extractedFields, ['medicarewages', 'box5']) ?? heuristic?.medicareWages ?? null,
    medicareTax: findNumericFieldValue(extractedFields, ['medicaretax', 'box6']) ?? heuristic?.medicareTax ?? null,
    stateWages: firstStateEntry?.wages ?? findNumericFieldValue(extractedFields, ['statewages', 'box16']),
    stateWithholding: firstStateEntry?.withholding ?? findNumericFieldValue(extractedFields, ['statewithholding', 'box17']),
    stateEntries: resolvedStateEntries,
    reviewNotes: (() => {
      const explicitNotes = extractStructuredReviewNotes(extractedFields);
      if (explicitNotes.length > 0) {
        return explicitNotes;
      }
      return heuristic?.reviewNotes || [];
    })(),
  };
}

function buildW2DeduplicationKey(document: ReturnType<typeof buildParsedPersonalTaxDocument>) {
  if (document.sampleBacktest?.fixtureName && document.sampleBacktest?.role && document.sampleBacktest?.employeeName) {
    return [
      'sample-backtest',
      document.sampleBacktest.fixtureName,
      document.sampleBacktest.role,
      document.sampleBacktest.employeeName,
      document.taxYear || '',
    ].map((part) => String(part || '').trim().toLowerCase()).join('|');
  }

  return [
    document.taxYear || '',
    String(document.originalFileName || document.title || '').trim().toLowerCase(),
    String(document.employerName || document.vendorName || '').trim().toLowerCase(),
    String(document.employeeName || '').trim().toLowerCase(),
  ].join('|');
}

function dedupePersonalTaxDocuments(documents: PersonalTaxDocumentRecord[]) {
  const seen = new Set<string>();
  const deduped: PersonalTaxDocumentRecord[] = [];

  for (const document of documents) {
    const parsed = buildParsedPersonalTaxDocument(document);
    if (!isLikelyW2Document(document)) {
      deduped.push(document);
      continue;
    }

    const key = buildW2DeduplicationKey(parsed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(document);
  }

  return deduped;
}

function collapseIncludedW2DocumentIds(
  documents: PersonalTaxDocumentRecord[],
  includedDocumentIds: string[],
) {
  const seen = new Set<string>();
  const collapsed: string[] = [];

  for (const documentId of includedDocumentIds) {
    const document = documents.find((entry) => entry.id === documentId);
    if (!document) {
      if (!collapsed.includes(documentId)) {
        collapsed.push(documentId);
      }
      continue;
    }

    const key = buildW2DeduplicationKey(buildParsedPersonalTaxDocument(document));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    collapsed.push(documentId);
  }

  return collapsed;
}

function isResolvedWorkflowStatus(status?: string | null) {
  return ['stored', 'updated', 'persisted', 'completed', 'processed'].includes(String(status || '').toLowerCase());
}

function isPendingWorkflowStatus(status?: string | null) {
  return ['pending', 'processing', 'queued', 'running', 'in_progress'].includes(String(status || '').toLowerCase());
}

function isFailedWorkflowStatus(status?: string | null) {
  const normalized = String(status || '').toLowerCase();
  return Boolean(normalized) && !isResolvedWorkflowStatus(normalized) && !isPendingWorkflowStatus(normalized);
}

function isLikelyW2Document(document: PersonalTaxDocumentRecord) {
  const extractedSubtype = String(findStringFieldValue(document.extractedFields, ['documentsubtype']) || '').toLowerCase();
  if (extractedSubtype === 'w2') {
    return true;
  }

  return inferLikelyW2FromDocument(document);
}

function hasScheduleESummaryValues(summary?: {
  totalIncome?: number;
  totalExpenses?: number;
  netIncomeOrLoss?: number;
} | null) {
  return ['totalIncome', 'totalExpenses', 'netIncomeOrLoss'].some((key) => Math.abs(Number(summary?.[key as keyof typeof summary] || 0)) > 0);
}

function hasScheduleELineAmounts(detail?: ScheduleEDetail | null) {
  return Object.values(detail?.scheduleELines || {}).some((line) => Math.abs(Number(line.amount || 0)) > 0);
}

function hasRenderableScheduleE(detail?: ScheduleEDetail | null) {
  return hasScheduleELineAmounts(detail) || hasScheduleESummaryValues(detail?.summary);
}

function hasRenderableYearSummary(summary?: YearSummary | null) {
  return hasScheduleESummaryValues(summary?.scheduleE);
}

function hasRenderableTaxDataset(summary?: YearSummary | null, detail?: ScheduleEDetail | null) {
  return hasRenderableScheduleE(detail) || hasRenderableYearSummary(summary);
}

function buildScheduleLineExplanation(
  line: ScheduleELineDetail,
  evidenceState?: ScheduleLineEvidenceState,
) {
  const entryCount = line.entries.length;
  const sourceRefs = Array.from(new Set(line.entries.map((entry) => entry.sourceRef).filter(Boolean) as string[]));
  const sourceLabels = Array.from(new Set(line.entries.map((entry) => entry.source).filter(Boolean) as string[]));
  const evidenceCount = evidenceState?.evidence.length || 0;
  const largestEntries = [...line.entries]
    .sort((left, right) => Math.abs(Number(right.amount || 0)) - Math.abs(Number(left.amount || 0)))
    .slice(0, 3);
  const citations = [
    ...sourceRefs.map((sourceRef) => ({ label: `Entry source ${sourceRef}`, detail: 'journal source reference' })),
    ...(evidenceState?.evidence || []).slice(0, 3).map((item) => ({
      label: item.title,
      detail: [item.evidenceType.replace(/_/g, ' '), item.documentDate ? fmtDate(item.documentDate) : null]
        .filter(Boolean)
        .join(' · '),
    })),
  ].slice(0, 6);

  const checkpoints = [
    `${fmtMoney(line.amount)} mapped into ${line.name}${line.line ? ` on Schedule E line ${line.line}` : ''}.`,
    entryCount > 0
      ? `${entryCount} posted journal ${entryCount === 1 ? 'entry contributes' : 'entries contribute'} to this total.`
      : 'This line is not driven by direct posted journal entries in the current detail view.',
    sourceLabels.length > 0
      ? `Source mix in this line: ${sourceLabels.join(', ')}.`
      : 'No source classification was attached to the contributing entries.',
    evidenceState?.status === 'loaded'
      ? evidenceCount > 0
        ? `${evidenceCount} linked evidence ${evidenceCount === 1 ? 'record supports' : 'records support'} the displayed entries.`
        : 'No linked evidence records were found for the displayed entries.'
      : evidenceState?.status === 'not_configured'
        ? 'Evidence search is not configured in this environment, so document citations are unavailable here.'
        : evidenceState?.status === 'error'
          ? 'Evidence lookup failed for this line, so only ledger citations are shown.'
          : 'Evidence citations will populate after the supporting-evidence lookup finishes.',
    ...(largestEntries.length > 0
      ? [`Largest contributing entries: ${largestEntries.map((entry) => `${entry.description || 'Untitled entry'} ${fmtMoney(entry.amount)}`).join(' · ')}.`]
      : []),
    ...(line.mortgageSplitApplied || line.principalExcluded
      ? [`Mortgage split logic affected this line${line.principalExcluded ? ` and excluded ${fmtMoney(line.principalExcluded)} of principal` : ''}.`]
      : []),
  ];

  return { checkpoints, citations };
}

function createVendorDraft(vendor?: VendorRow | null): VendorDraft {
  return {
    name: String(vendor?.name || '').trim(),
    vendorType: String(vendor?.vendorType || 'individual').trim() || 'individual',
    tin: String(vendor?.ein || vendor?.ssnLast4 || '').trim(),
    address: String(vendor?.address || '').trim(),
    city: String(vendor?.city || '').trim(),
    state: String(vendor?.state || '').trim().toUpperCase().slice(0, 2),
    zip: String(vendor?.zip || '').trim(),
    email: String(vendor?.email || '').trim(),
    phone: String(vendor?.phone || '').trim(),
    w9OnFile: Boolean(vendor?.w9OnFile),
    notes: '',
  };
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] ${className}`}>{children}</div>;
}

function CardHeader({ title, subtitle, right, info }: { title: string; subtitle?: string; right?: React.ReactNode; info?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div>
        <h3 className="inline-flex items-center gap-1.5 text-base font-semibold tracking-tight text-slate-900">
          {title}
          {info && <GlossaryTip term={title} explanation={info} />}
        </h3>
        {subtitle && <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  onClick,
  active = false,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const classes = `rounded-xl border bg-white p-4 text-left transition ${
    active ? 'border-slate-900 shadow-sm ring-2 ring-slate-900/10' : 'border-slate-200/80'
  } ${onClick ? 'hover:-translate-y-px hover:border-slate-300 hover:shadow-sm' : ''}`;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
        <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
        <div className={`mt-2 text-[10px] font-semibold uppercase tracking-wider ${active ? 'text-slate-900' : 'text-sky-600'}`}>
          {active ? 'Explaining' : 'Explain'}
        </div>
      </button>
    );
  }

  return (
    <div className={classes}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function readinessBadge(readiness?: string) {
  const v = String(readiness || '').toLowerCase();
  if (v.includes('ready')) return { label: 'Ready for CPA review', cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' };
  if (v.includes('block')) return { label: 'Blocked', cls: 'bg-rose-100 text-rose-900 border-rose-300' };
  if (v.includes('draft')) return { label: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-300' };
  if (v) return { label: readiness as string, cls: 'bg-amber-100 text-amber-900 border-amber-300' };
  return { label: 'Unknown', cls: 'bg-slate-100 text-slate-700 border-slate-300' };
}

function checklistStatusBadge(status?: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'data_ready') return 'bg-emerald-100 text-emerald-900 border-emerald-300';
  if (value === 'action_required') return 'bg-rose-100 text-rose-900 border-rose-300';
  if (value === 'awaiting_lender') return 'bg-amber-100 text-amber-900 border-amber-300';
  if (value === 'not_applicable') return 'bg-slate-100 text-slate-600 border-slate-300';
  return 'bg-slate-100 text-slate-700 border-slate-300';
}

function intelligenceBadge(status?: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'blocked') return 'bg-rose-100 text-rose-900 border-rose-300';
  if (value === 'attention_needed') return 'bg-amber-100 text-amber-900 border-amber-300';
  if (value === 'ready') return 'bg-emerald-100 text-emerald-900 border-emerald-300';
  return 'bg-slate-100 text-slate-700 border-slate-300';
}

function humanizeStatus(status?: string) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function filingLaneClass(lane: FilingCockpitItem['lane']) {
  switch (lane) {
    case 'packet':
      return 'border-amber-300 bg-amber-50 text-amber-900';
    case 'estimate':
      return 'border-sky-300 bg-sky-50 text-sky-900';
    case '1099':
      return 'border-rose-300 bg-rose-50 text-rose-900';
    case 'checklist':
      return 'border-indigo-300 bg-indigo-50 text-indigo-900';
    default:
      return 'border-slate-300 bg-slate-50 text-slate-700';
  }
}

function AnalyticsPanelShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div>
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function AnalyticsEmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-44 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-4 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function ScheduleELineCompositionChart({
  rows,
}: {
  rows: Array<[string, ScheduleELineDetail]>;
}) {
  const bars = [...rows]
    .sort((left, right) => Number(right[1].amount || 0) - Number(left[1].amount || 0))
    .slice(0, 7)
    .map(([key, line]) => {
      const lineNumber = Number(line.line || 0);
      const isIncome = lineNumber > 0 && lineNumber <= 4;
      const isDepreciation = key === 'DEPRECIATION' || lineNumber === 18;
      return {
        key,
        label: line.line ? `Line ${line.line} · ${line.name}` : line.name,
        amount: Number(line.amount || 0),
        color: isIncome ? '#10b981' : isDepreciation ? '#f59e0b' : '#fb7185',
        entryCount: line.entries.length,
      };
    });
  const maxAmount = Math.max(...bars.map((bar) => bar.amount), 1);

  return (
    <AnalyticsPanelShell
      title="Schedule E line composition"
      subtitle="Largest mapped Schedule E lines for this tax year; green is rental income, amber is depreciation, red is operating expense."
    >
      {bars.length === 0 ? (
        <AnalyticsEmptyState text="Schedule E line bars will populate once ledger activity is mapped for this tax year." />
      ) : (
        <div className="space-y-3 rounded-2xl border border-white bg-white p-4">
          {bars.map((bar) => (
            <div key={`sched-bar-${bar.key}`}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate font-medium text-slate-700">{bar.label}</span>
                <span className="shrink-0 font-semibold tabular-nums text-slate-900">{fmtMoney(bar.amount)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max((bar.amount / maxAmount) * 100, 4)}%`, backgroundColor: bar.color }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {bar.entryCount > 0 ? `${bar.entryCount} entr${bar.entryCount === 1 ? 'y' : 'ies'}` : 'schedule'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </AnalyticsPanelShell>
  );
}

function LiabilityBridgeChart({ taxLiability }: { taxLiability: TaxLiabilityResult | null }) {
  const taxes = taxLiability?.taxes;
  const stateWithholding = taxLiability?.stateWithholding;
  const netDue = Number(taxes?.netDue || 0);
  const overpayment = Number(taxes?.overpayment || 0);
  const stateWithholdingApplied = Number(taxes?.stateWithholdingApplied || 0);
  const steps = taxes
    ? [
        { id: 'federal', label: 'Federal tax', amount: Number(taxes.federal || 0), color: '#fb7185' },
        { id: 'state', label: 'State tax', amount: Number(taxes.state || 0), color: '#f59e0b' },
        ...(Number(taxes.niit || 0) > 0 ? [{ id: 'niit', label: 'NIIT', amount: Number(taxes.niit || 0), color: '#fda4af' }] : []),
        { id: 'gross', label: 'Gross tax', amount: Number(taxes.total || 0), color: '#0f172a' },
        { id: 'credits', label: 'Credits applied', amount: -Number(taxes.creditsApplied || 0), color: '#10b981' },
        { id: 'withholding', label: 'Federal withholding applied', amount: -Number(taxes.withholdingApplied || 0), color: '#0ea5e9' },
        ...(stateWithholdingApplied > 0
          ? [{ id: 'state-withholding', label: 'State withholding applied', amount: -stateWithholdingApplied, color: '#38bdf8' }]
          : []),
        netDue > 0
          ? { id: 'net', label: 'Net due', amount: netDue, color: '#e11d48' }
          : { id: 'net', label: overpayment > 0 ? 'Overpayment' : 'Net due', amount: overpayment > 0 ? -overpayment : 0, color: '#059669' },
      ]
    : [];
  const scale = Math.max(...steps.map((step) => Math.abs(step.amount)), 1);
  const stateNetDue = Number(stateWithholding?.stateNetDue ?? taxes?.stateNetDue ?? 0);
  const stateOverpayment = Number(stateWithholding?.stateOverpayment ?? taxes?.stateOverpayment ?? 0);

  return (
    <AnalyticsPanelShell
      title="Liability bridge"
      subtitle="How the modeled gross tax stack is reduced by credits and withholding into the current net due or refund signal."
    >
      {steps.length === 0 ? (
        <AnalyticsEmptyState text="The liability bridge will populate once the modeled tax liability preview is loaded for this scenario." />
      ) : (
        <div className="space-y-3 rounded-2xl border border-white bg-white p-4">
          {steps.map((step) => (
            <div key={`bridge-${step.id}`}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-slate-700">{step.label}</span>
                <span className={`shrink-0 font-semibold tabular-nums ${step.amount < 0 ? 'text-emerald-700' : 'text-slate-900'}`}>
                  {step.amount < 0 ? `-${fmtMoney(Math.abs(step.amount))}` : fmtMoney(step.amount)}
                </span>
              </div>
              <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max((Math.abs(step.amount) / scale) * 100, step.amount === 0 ? 2 : 4)}%`, backgroundColor: step.color }}
                />
              </div>
            </div>
          ))}
          {stateWithholding?.provided && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">State withholding layer</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${stateWithholdingSourceBadgeClass(stateWithholding.source)}`}>
                  {describeStateWithholdingSource(stateWithholding.source)}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-700 sm:grid-cols-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Applied</div>
                  <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(stateWithholding.applied || 0)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">State net due</div>
                  <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(stateNetDue)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">State overpayment</div>
                  <div className={`font-semibold tabular-nums ${stateOverpayment > 0 ? 'text-emerald-700' : 'text-slate-900'}`}>{fmtMoney(stateOverpayment)}</div>
                </div>
              </div>
              {stateWithholding.note && (
                <div className="mt-2 text-[11px] text-slate-500">{stateWithholding.note}</div>
              )}
            </div>
          )}
          <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            Modeled scenario preview only — the state layer is a planning baseline, not filing-grade state output. Confirm against official filings before relying on the net result.
          </div>
        </div>
      )}
    </AnalyticsPanelShell>
  );
}

function EffectiveRatePanel({ taxLiability }: { taxLiability: TaxLiabilityResult | null }) {
  const rates = taxLiability?.rates;
  const metrics = [
    { label: 'Effective federal', value: rates?.effectiveFederal, hint: 'Federal tax over taxable income' },
    { label: 'Marginal federal', value: rates?.marginalFederal, hint: 'Top federal bracket reached' },
    { label: 'Effective state', value: rates?.effectiveState, hint: 'Baseline state methodology' },
    { label: 'Effective total', value: rates?.effectiveTotal, hint: 'Combined modeled burden' },
  ];
  const breakdown = (taxLiability?.federalBreakdown || []).filter((bracket) => Number(bracket.tax || 0) > 0);
  const maxBracketTax = Math.max(...breakdown.map((bracket) => Number(bracket.tax || 0)), 1);

  return (
    <AnalyticsPanelShell
      title="Effective rates and bracket usage"
      subtitle="Modeled effective and marginal rates with the federal tax contributed by each bracket in this scenario."
    >
      {!taxLiability ? (
        <AnalyticsEmptyState text="Rate metrics will populate once the modeled tax liability preview is loaded for this scenario." />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {metrics.map((metric, index) => (
              <div key={`metric-${String(metric.label)}-${index}`} className="rounded-xl border border-white bg-white px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{metric.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                  {metric.value != null ? `${Number(metric.value).toFixed(1)}%` : '—'}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">{metric.hint}</div>
              </div>
            ))}
          </div>
          {breakdown.length > 0 && (
            <div className="space-y-2 rounded-2xl border border-white bg-white p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Federal tax by bracket</div>
              {breakdown.map((bracket) => (
                <div key={`bracket-${bracket.bracket}-${bracket.range}`}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-slate-700">{bracket.bracket} · {bracket.range}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900">{fmtMoney(bracket.tax)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-800"
                      style={{ width: `${Math.max((Number(bracket.tax || 0) / maxBracketTax) * 100, 4)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </AnalyticsPanelShell>
  );
}

export default function TaxPanel({ propertyId, propertyAddress }: TaxPanelProps) {
  const currentYear = new Date().getFullYear();
  const defaultTaxYear = currentYear;
  const yearOptions = useMemo(() => [currentYear, currentYear - 1, currentYear - 2, currentYear - 3], [currentYear]);
  const [year, setYear] = useState(defaultTaxYear);
  const [isYearAutoSelected, setIsYearAutoSelected] = useState(true);
  const [filingStatus, setFilingStatus] = useState<'single' | 'mfj' | 'mfs' | 'hoh'>('single');
  const [otherIncome, setOtherIncome] = useState('');
  const [homeState, setHomeState] = useState('');
  const [draftFormProfile, setDraftFormProfile] = useState<TaxpayerDraftProfile>(EMPTY_TAXPAYER_DRAFT_PROFILE);
  const [draftFormProfileUpdatedAt, setDraftFormProfileUpdatedAt] = useState<string | null>(null);

  const [yearSummary, setYearSummary] = useState<YearSummary | null>(null);
  const [scheduleEDetail, setScheduleEDetail] = useState<ScheduleEDetail | null>(null);
  const [snapshot, setSnapshot] = useState<WorkpaperSnapshot | null>(null);
  const [checklist, setChecklist] = useState<DocumentChecklist | null>(null);
  const [packetIntelligence, setPacketIntelligence] = useState<PacketReleaseIntelligence | null>(null);
  const [releases, setReleases] = useState<any[]>([]);
  const [releaseHistoryStatus, setReleaseHistoryStatus] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [forms1099, setForms1099] = useState<Form1099[]>([]);
  const [report1099Total, setReport1099Total] = useState<number>(0);
  const [filingHistory, setFilingHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [isAuditRailOpen, setIsAuditRailOpen] = useState(false);
  const [isTaxRulesOpen, setIsTaxRulesOpen] = useState(false);
  const [isPersonalUseDetailOpen, setIsPersonalUseDetailOpen] = useState(false);
  const [openFilingExplanationId, setOpenFilingExplanationId] = useState<string>('packet-readiness');
  const [openScheduleLine, setOpenScheduleLine] = useState<string | null>(null);
  const [openChecklistRow, setOpenChecklistRow] = useState<string | null>(null);
  const [checklistInfoKey, setChecklistInfoKey] = useState<string | null>(null);
  const [lineEvidence, setLineEvidence] = useState<Record<string, ScheduleLineEvidenceState>>({});
  const [showVendorForm, setShowVendorForm] = useState(false);
  const [editingVendorId, setEditingVendorId] = useState<string | null>(null);
  const [vendorDraft, setVendorDraft] = useState<VendorDraft>(createVendorDraft());
  const [savingVendor, setSavingVendor] = useState(false);
  const [deletingVendorId, setDeletingVendorId] = useState<string | null>(null);
  const [taxLiability, setTaxLiability] = useState<TaxLiabilityResult | null>(null);
  const [taxRulesPackage, setTaxRulesPackage] = useState<TaxRulesPackage | null>(null);
  const [taxRulesMetadata, setTaxRulesMetadata] = useState<TaxRulesMetadata | null>(null);
  const [taxEdgeCaseReview, setTaxEdgeCaseReview] = useState<TaxEdgeCaseReview | null>(null);
  const [taxRulesetHistory, setTaxRulesetHistory] = useState<TaxRulesetHistoryRecord[]>([]);
  const [taxRulesIngestion, setTaxRulesIngestion] = useState<TaxRulesIngestionResult | null>(null);
  const [taxRulesIngesting, setTaxRulesIngesting] = useState(false);
  const loadAllRequestIdRef = useRef(0);
  const [auditRulesSources, setAuditRulesSources] = useState<FinanceAuditRulesSources | null>(null);
  const [auditRulesLoading, setAuditRulesLoading] = useState(false);
  const [applyingSampleBacktest, setApplyingSampleBacktest] = useState(false);
  const [sampleBacktestActive, setSampleBacktestActive] = useState(false);
  const [schedulePreviewScope, setSchedulePreviewScope] = useState<'property' | 'portfolio'>(propertyId ? 'property' : 'portfolio');
  const [scheduleScopeNote, setScheduleScopeNote] = useState<string | null>(null);

  // Release controls
  const [releaseNotes, setReleaseNotes] = useState('');
  const [releaseChecks, setReleaseChecks] = useState({
    workpapers_reviewed: false,
    rules_version_reviewed: false,
    evidence_reviewed: false,
    packet_readiness_confirmed: false,
    reviewer_attested: false,
  });
  const [releasing, setReleasing] = useState(false);
  const [persistingDraft, setPersistingDraft] = useState(false);

  // Structured IRS rules sources for the audit rail. The client falls back to
  // the static shared rules package when the endpoint is unreachable, so the
  // audit can always show which rules it abides by.
  useEffect(() => {
    let cancelled = false;
    setAuditRulesLoading(true);
    getFinanceAuditRulesSources(year)
      .then((sources) => {
        if (!cancelled) setAuditRulesSources(sources);
      })
      .finally(() => {
        if (!cancelled) setAuditRulesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  useEffect(() => {
    const normalizedHomeState = String(homeState || '').trim().toUpperCase().slice(0, 2);
    if (!normalizedHomeState) return;
    setDraftFormProfile((current) => (
      current.mailingState ? current : { ...current, mailingState: normalizedHomeState }
    ));
  }, [homeState]);

  const personalTaxDocuments: any[] = [];
  const likelyW2Documents: any[] = [];
  const matchingYearW2Documents: any[] = [];
  const missingYearW2Documents: any[] = [];
  const outOfScopeW2Documents: any[] = [];
  const reviewedW2Scenario = { confirmedAt: null };
  const confirmedW2ScenarioApplies = false;
  const selectedW2DocumentIds: string[] = [];
  const selectedW2Totals = {
    wages: 0,
    federalWithholding: 0,
    stateWithholding: 0,
    homeStateWithholding: 0,
    partialDocumentCount: 0,
  };
  const effectiveScenarioInputs = {
    otherIncome: parseCurrencyNumber(otherIncome),
    withholdingYtd: 0,
  };
  const effectiveScenarioSourceSummary = {
    otherIncomeLabel: 'Manual non-rental income only',
    withholdingLabel: 'Federal withholding is not collected in this workflow',
  };

  const estimateParams = useMemo(() => ({
    year,
    propertyId: propertyId || undefined,
    homeState: homeState || undefined,
  }), [homeState, propertyId, year]);

  async function loadAll() {
    if (!auth.currentUser) return;
    const requestId = loadAllRequestIdRef.current + 1;
    loadAllRequestIdRef.current = requestId;
    const requestedYear = year;
    const fallbackRuleset = getTaxRulesetPackage(requestedYear) as unknown as TaxRulesPackage;
    setLoading(true);
    setNote(null);
    setYearSummary(null);
    setScheduleEDetail(null);
    setTaxEdgeCaseReview(null);
    setTaxLiability(null);
    setSnapshot(null);
    setPacketIntelligence(null);
    setChecklist(null);
    setForms1099([]);
    setReport1099Total(0);
    setReleases([]);
    setReleaseHistoryStatus(null);
    setTaxRulesPackage(fallbackRuleset);
    setTaxRulesMetadata(buildFallbackTaxRulesMetadata(requestedYear, fallbackRuleset));
    setTaxRulesetHistory([]);
    setSchedulePreviewScope(propertyId ? 'property' : 'portfolio');
    setScheduleScopeNote(null);
    try {
      const scopedYearParams = {
        year: requestedYear,
        propertyId,
      };

      const portfolioYearParams = { year: requestedYear };

      const [
        ysum,
        schedDetail,
        portfolioYearSummary,
        portfolioScheduleDetail,
        rulesPkg,
        snap,
        docs,
        intel,
        rel,
        vend,
        rep,
        hist,
        draftProfile,
        rulesHistory,
      ] = await Promise.all([
        taxClient.getYearSummary(scopedYearParams).catch(() => null),
        taxClient.getScheduleE(scopedYearParams).catch(() => null),
        propertyId ? taxClient.getYearSummary(portfolioYearParams).catch(() => null) : Promise.resolve(null),
        propertyId ? taxClient.getScheduleE(portfolioYearParams).catch(() => null) : Promise.resolve(null),
        taxClient.getRulesPackage(requestedYear).catch(() => null),
        taxClient.getWorkpaperSnapshot(requestedYear).catch(() => null),
        taxClient.getDocumentChecklist(requestedYear).catch(() => null),
        taxClient.getPacketReleaseIntelligence(requestedYear).catch(() => null),
        taxClient.listPacketReleases(requestedYear).catch(() => null),
        bookkeepingClient.listVendors().catch(() => null),
        bookkeepingClient.get1099Report({ year: requestedYear }).catch(() => null),
        taxClient.get1099EfileStatus(requestedYear).catch(() => null),
        taxClient.getDraftFormProfile({ year: requestedYear, homeState: homeState || undefined }).catch(() => null),
        taxClient.getRulesPackageHistory(requestedYear).catch(() => null),
      ]);
      if (requestId !== loadAllRequestIdRef.current || requestedYear !== year) {
        return;
      }

      const loadedSnapshot = snap?.snapshot || intel?.snapshot || null;

      const usePortfolioScheduleFallback = Boolean(propertyId)
        && !hasRenderableScheduleE(schedDetail)
        && !hasRenderableYearSummary(ysum)
        && (hasRenderableScheduleE(portfolioScheduleDetail) || hasRenderableYearSummary(portfolioYearSummary));

      const effectiveYearSummary = usePortfolioScheduleFallback && portfolioYearSummary?.ok
        ? portfolioYearSummary
        : ysum;
      const effectiveScheduleDetail = usePortfolioScheduleFallback && portfolioScheduleDetail?.ok
        ? portfolioScheduleDetail
        : schedDetail;

      const hasRenderableSelectedYear = hasRenderableTaxDataset(effectiveYearSummary, effectiveScheduleDetail);
      const shouldInspectAlternateYears = !hasRenderableSelectedYear
        && (isYearAutoSelected || requestedYear === currentYear - 1);

      if (shouldInspectAlternateYears) {
        const alternateYears = yearOptions.filter((candidateYear) => candidateYear !== requestedYear);
        const alternateYearData = await Promise.all(alternateYears.map(async (candidateYear) => {
          const candidateScopedParams = { year: candidateYear, propertyId };
          const candidatePortfolioParams = { year: candidateYear };
          const [candidateYearSummary, candidateScheduleDetail, candidatePortfolioYearSummary, candidatePortfolioScheduleDetail] = await Promise.all([
            taxClient.getYearSummary(candidateScopedParams).catch(() => null),
            taxClient.getScheduleE(candidateScopedParams).catch(() => null),
            propertyId ? taxClient.getYearSummary(candidatePortfolioParams).catch(() => null) : Promise.resolve(null),
            propertyId ? taxClient.getScheduleE(candidatePortfolioParams).catch(() => null) : Promise.resolve(null),
          ]);

          const useCandidatePortfolioFallback = Boolean(propertyId)
            && !hasRenderableTaxDataset(candidateYearSummary, candidateScheduleDetail)
            && hasRenderableTaxDataset(candidatePortfolioYearSummary, candidatePortfolioScheduleDetail);

          const effectiveCandidateYearSummary = useCandidatePortfolioFallback && candidatePortfolioYearSummary?.ok
            ? candidatePortfolioYearSummary
            : candidateYearSummary;
          const effectiveCandidateScheduleDetail = useCandidatePortfolioFallback && candidatePortfolioScheduleDetail?.ok
            ? candidatePortfolioScheduleDetail
            : candidateScheduleDetail;

          return {
            candidateYear,
            hasData: hasRenderableTaxDataset(effectiveCandidateYearSummary, effectiveCandidateScheduleDetail),
          };
        }));
        if (requestId !== loadAllRequestIdRef.current || requestedYear !== year) {
          return;
        }

        const fallbackYear = alternateYearData.find((candidate) => candidate.hasData)?.candidateYear;
        if (fallbackYear && fallbackYear !== requestedYear) {
          setNote(`Switched Tax Center to ${fallbackYear}, the latest year with Schedule E data in scope.`);
          setIsYearAutoSelected(true);
          setYear(fallbackYear);
          return;
        }
      }

      if (!hasRenderableSelectedYear && !isYearAutoSelected) {
        setNote(`No posted Schedule E data was found for ${requestedYear} in the current scope.`);
      }

      if (effectiveYearSummary?.ok) setYearSummary(effectiveYearSummary);
      if (effectiveScheduleDetail?.ok) setScheduleEDetail(effectiveScheduleDetail);
      // Runtime rules package can come back ok:true with a null ruleset when
      // the published Firestore ruleset is unavailable. Fall back to the
      // static shared package so rule sources and governance always render
      // (this is what previously produced "rules not loaded" / 0 rule sources).
      const rulesPackageYear = Number(rulesPkg?.taxYear || rulesPkg?.ruleset?.taxYear || rulesPkg?.ruleset?.governance?.requestedTaxYear || 0);
      if (rulesPkg?.ok && rulesPkg.ruleset && rulesPackageYear === requestedYear) {
        setTaxRulesPackage(rulesPkg.ruleset);
        setTaxRulesMetadata({
          taxYear: rulesPkg.taxYear,
          generatedAt: rulesPkg.generatedAt,
          rulesRuntime: rulesPkg.rulesRuntime || null,
          validation: rulesPkg.validation || null,
          activationValidation: rulesPkg.activationValidation || null,
          appliedRuleGroups: rulesPkg.appliedRuleGroups || [],
          sourceDocuments: rulesPkg.sourceDocuments || rulesPkg.ruleset?.sourceDocuments || [],
        });
      } else {
        setTaxRulesPackage(fallbackRuleset);
        setTaxRulesMetadata({
          taxYear: requestedYear,
          generatedAt: new Date().toISOString(),
          rulesRuntime: {
            status: 'fallback',
            source: 'static_shared_rules',
            rulesVersion: fallbackRuleset.rulesVersion || null,
            approvalStatus: fallbackRuleset.approvalStatus || null,
            lastReviewedAt: fallbackRuleset.lastReviewedAt || null,
          },
          validation: {
            status: fallbackRuleset.governance?.warnings?.length ? 'attention_needed' : 'passed',
            sourceDocumentCount: fallbackRuleset.sourceDocuments?.length || 0,
            appliedRuleGroupCount: 0,
            warningCount: fallbackRuleset.governance?.warnings?.length || 0,
            warnings: fallbackRuleset.governance?.warnings || [],
          },
          activationValidation: null,
          sourceDocuments: fallbackRuleset.sourceDocuments || [],
          appliedRuleGroups: [],
        });
      }
      if (snap?.ok || intel?.ok) setSnapshot(loadedSnapshot);
      if (docs?.ok) setChecklist(docs);
      if (intel?.ok) {
        setPacketIntelligence(intel.intelligence || null);
        setReleaseHistoryStatus(intel.releaseStatus || null);
      }
      if (rel?.ok) setReleases(rel.releases || []);
      if (rel?.status) setReleaseHistoryStatus((current) => current || rel.status);
      if (rulesHistory?.ok) setTaxRulesetHistory(rulesHistory.rulesets || []);
      if (vend?.ok) setVendors(vend.vendors || []);
      if (rep?.ok) {
        setForms1099(rep.forms || rep.forms1099 || []);
        setReport1099Total(rep.totalAmount || rep.summary?.totalAmount || 0);
      }
      if (hist?.ok) setFilingHistory(hist.filings || []);

      const nextDraftProfile = draftProfile?.ok
        ? normalizeDraftFormProfile(draftProfile.profile, homeState)
        : normalizeDraftFormProfile(loadedSnapshot?.draftFormProfile, homeState);
      setDraftFormProfile(nextDraftProfile);
      setDraftFormProfileUpdatedAt(draftProfile?.updatedAt || loadedSnapshot?.draftFormProfileUpdatedAt || null);
      setSchedulePreviewScope(usePortfolioScheduleFallback || !propertyId ? 'portfolio' : 'property');
      setScheduleScopeNote(
        usePortfolioScheduleFallback
          ? `Property-scoped Schedule E lines are empty for ${propertyAddress || 'this property'} in ${requestedYear}, so the draft preview is showing portfolio tax data until ledger entries are tagged to that property.`
          : null,
      );
    } catch (err: any) {
      setNote(err?.message || 'Failed to load tax data.');
    } finally {
      setLoading(false);
    }
  }

  async function runYearlyRulesIngestion() {
    setTaxRulesIngesting(true);
    setTaxRulesIngestion(null);
    try {
      const result = await taxClient.ingestRulesPackage({
        year,
        activateIfValid: true,
        runFixtureGate: true,
      });

      if (result?.ok) {
        setTaxRulesIngestion(result as TaxRulesIngestionResult);
        const history = await taxClient.getRulesPackageHistory(year).catch(() => null);
        if (history?.ok) setTaxRulesetHistory(history.rulesets || []);
        await loadAll();
      } else {
        setTaxRulesIngestion({
          ok: false,
          status: result?.error || 'ingestion_failed',
          taxYear: year,
          generatedAt: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      setTaxRulesIngestion({
        ok: false,
        status: error?.message || 'ingestion_failed',
        taxYear: year,
        generatedAt: new Date().toISOString(),
      });
    } finally {
      setTaxRulesIngesting(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyAddress, propertyId, year]);

  // Sync cached ATTOM mortgage lender into the bookkeeping property record so
  // the tax checklist and CPA packet can show the lender without manual upload.
  useEffect(() => {
    if (!propertyId || !propertyAddress) return;

    let cancelled = false;

    const enrichMortgageFromAttom = async () => {
      try {
        const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
        const url = baseEnv
          ? `${baseEnv}/api/attom/dashboard?address=${encodeURIComponent(propertyAddress)}`
          : `http://localhost:3001/api/attom/dashboard?address=${encodeURIComponent(propertyAddress)}`;
        const response = await fetch(url);
        if (!response.ok || cancelled) return;

        const result = await response.json();
        if (!result?.ok || cancelled) return;

        const mortgage = result.data?.summary?.mortgage;
        const lenderName = mortgage?.lender_name;
        if (!lenderName) return;

        await taxClient.enrichPropertyMortgage(propertyId, {
          mortgageLender: lenderName,
          mortgageAmount: mortgage.amount ?? undefined,
          mortgageRate: mortgage.estimated_interest_rate ?? undefined,
          mortgageDate: mortgage.date ?? undefined,
        });
        if (cancelled) return;

        const [docs, snap] = await Promise.all([
          taxClient.getDocumentChecklist(year).catch(() => null),
          taxClient.getWorkpaperSnapshot(year).catch(() => null),
        ]);
        if (cancelled) return;
        if (docs?.ok) setChecklist(docs);
        if (snap?.ok) setSnapshot(snap);
      } catch {
        // Non-critical enrichment path
      }
    };

    void enrichMortgageFromAttom();

    return () => {
      cancelled = true;
    };
  }, [propertyId, propertyAddress, year]);

  async function fetchDownload(
    downloadFile: () => Promise<Blob>,
    filename: string,
    key: string,
    sourceMix = taxSourceMix,
    beforeDownload?: () => Promise<unknown>,
  ) {
    setDownloadBusy(key);
    setNote(null);
    try {
      if (beforeDownload) {
        await beforeDownload();
      }
      const blob = await downloadFile();
      const exportFilename = buildFinanceSourceFilename(filename, sourceMix);
      const exportBreakdown = buildFinanceSourceBreakdown(sourceMix);
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = exportFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setNote(
        `Downloaded ${exportFilename}. ${sourceMix.headline}${exportBreakdown ? ` · ${exportBreakdown}` : ''}.`,
      );
    } catch (err: any) {
      setNote(err?.message || `Failed to download ${filename}.`);
    } finally {
      setDownloadBusy(null);
    }
  }

  async function saveVendor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!vendorDraft.name.trim()) {
      setNote('Vendor name is required before saving 1099 details.');
      return;
    }

    setSavingVendor(true);
    setNote(null);
    try {
      const tinDigits = vendorDraft.tin.replace(/\D/g, '');
      const payload: Record<string, unknown> = {
        name: vendorDraft.name.trim(),
        vendorType: vendorDraft.vendorType,
        address: vendorDraft.address.trim() || null,
        city: vendorDraft.city.trim() || null,
        state: vendorDraft.state.trim() || null,
        zip: vendorDraft.zip.trim() || null,
        email: vendorDraft.email.trim() || null,
        phone: vendorDraft.phone.trim() || null,
        w9OnFile: vendorDraft.w9OnFile,
        notes: vendorDraft.notes.trim() || null,
      };

      if (tinDigits) {
        if (vendorDraft.vendorType === 'individual') {
          payload.ssn = tinDigits;
        } else {
          payload.ein = vendorDraft.tin.trim();
        }
      }

      const data = await bookkeepingClient.upsertVendor(payload);
      if (data.ok) {
        setNote(`${vendorDraft.name.trim()} saved for 1099 readiness.`);
        setShowVendorForm(false);
        setEditingVendorId(null);
        setVendorDraft(createVendorDraft());
        await loadAll();
      } else {
        setNote(data.error || 'Failed to save vendor details.');
      }
    } catch (err: any) {
      setNote(err?.message || 'Failed to save vendor details.');
    } finally {
      setSavingVendor(false);
    }
  }

  function startVendorEdit(vendor?: VendorRow | null) {
    setEditingVendorId(vendor?.id || null);
    setVendorDraft(createVendorDraft(vendor));
    setShowVendorForm(true);
    setNote(null);
  }

  async function removeVendor(vendor: VendorRow) {
    if (!vendor.id) {
      setNote('This vendor only exists in transaction history so there is no saved metadata record to delete.');
      return;
    }
    if (!window.confirm(`Delete saved vendor metadata for ${vendor.name}?`)) {
      return;
    }

    setDeletingVendorId(vendor.id);
    setNote(null);
    try {
      const data = await bookkeepingClient.deleteVendor(vendor.id);
      if (data.ok) {
        setNote(`${vendor.name} deleted from saved vendor metadata.`);
        if (editingVendorId === vendor.id) {
          setShowVendorForm(false);
          setEditingVendorId(null);
          setVendorDraft(createVendorDraft());
        }
        await loadAll();
      } else {
        setNote(data.error || 'Failed to delete vendor metadata.');
      }
    } catch (err: any) {
      setNote(err?.message || 'Failed to delete vendor metadata.');
    } finally {
      setDeletingVendorId(null);
    }
  }

  async function loadScheduleLineEvidence(lineKey: string, entries: ScheduleELineEntry[]) {
    if (!auth.currentUser) {
      return;
    }

    const sourceRefs = Array.from(new Set(entries.map((entry) => entry.sourceRef).filter(Boolean) as string[])).slice(0, 8);
    const entryIds = Array.from(new Set(entries.map((entry) => entry.entryId).filter(Boolean) as string[])).slice(0, 8);

    if (sourceRefs.length === 0 && entryIds.length === 0) {
      setLineEvidence((current) => ({
        ...current,
        [lineKey]: { status: 'loaded', evidence: [] },
      }));
      return;
    }

    setLineEvidence((current) => ({
      ...current,
      [lineKey]: { status: 'loading', evidence: [] },
    }));

    try {
      const queries: Array<Promise<any>> = [];

      for (const sourceRef of sourceRefs) {
        const params = new URLSearchParams({ q: sourceRef, limit: '10' });
        if (propertyId) params.set('propertyId', propertyId);
        queries.push(
          bookkeepingClient.searchEvidence(Object.fromEntries(params.entries())).catch(() => null),
        );
      }

      for (const entryId of entryIds) {
        for (const entityType of ['journal_entry', 'firestore_journal_entry']) {
          const params = new URLSearchParams({ entityType, entityId: entryId, limit: '10' });
          if (propertyId) params.set('propertyId', propertyId);
          queries.push(
            bookkeepingClient.searchEvidence(Object.fromEntries(params.entries())).catch(() => null),
          );
        }
      }

      const results = await Promise.all(queries);
      const seen = new Set<string>();
      const evidence: FinanceEvidenceRecord[] = [];
      let sawNotConfigured = false;

      for (const result of results) {
        if (result?.status === 'not_configured') {
          sawNotConfigured = true;
        }

        for (const item of result?.evidence || []) {
          const key = String(item.evidenceId || `${item.title}:${item.documentDate || ''}:${item.amount || ''}`);
          if (seen.has(key)) continue;
          seen.add(key);
          evidence.push(item);
        }
      }

      setLineEvidence((current) => ({
        ...current,
        [lineKey]: {
          status: sawNotConfigured && evidence.length === 0 ? 'not_configured' : 'loaded',
          evidence,
          error: null,
        },
      }));
    } catch (err: any) {
      setLineEvidence((current) => ({
        ...current,
        [lineKey]: {
          status: 'error',
          evidence: [],
          error: err?.message || 'Failed to load supporting evidence.',
        },
      }));
    }
  }

  function toggleScheduleLine(lineKey: string, entries: ScheduleELineEntry[]) {
    const shouldOpen = openScheduleLine !== lineKey;
    setOpenScheduleLine(shouldOpen ? lineKey : null);

    if (!shouldOpen) {
      return;
    }

    const evidenceState = lineEvidence[lineKey];
    if (!evidenceState || evidenceState.status === 'idle' || evidenceState.status === 'error') {
      void loadScheduleLineEvidence(lineKey, entries);
    }
  }

  async function persistDraftSnapshot() {
    if (!auth.currentUser) {
      return;
    }

    setPersistingDraft(true);
    setNote(null);
    try {
      const data = await taxClient.persistWorkpaperSnapshot({
        year,
        packetType: 'cpa_packet_draft',
        homeState: homeState || undefined,
        draftFormProfile,
      });

      if (data.ok) {
        if (data.snapshot) {
          setSnapshot(data.snapshot);
          setDraftFormProfileUpdatedAt(data.snapshot.draftFormProfileUpdatedAt || null);
        }
        if (data.draftFormProfile) {
          setDraftFormProfile(normalizeDraftFormProfile(data.draftFormProfile, homeState));
        }
        setNote('Draft workpaper snapshot persisted with the current filing profile.');
      } else {
        setNote(data.error || 'Failed to persist the draft workpaper snapshot.');
      }
    } catch (err: any) {
      setNote(err?.message || 'Failed to persist the draft workpaper snapshot.');
    } finally {
      setPersistingDraft(false);
    }
  }

  async function applySampleTaxpayerBacktest() {
    if (!auth.currentUser) {
      setNote('Sign in before loading the sample taxpayer backtest profile.');
      return;
    }

    const targetYear = SAMPLE_TAX_BACKTEST.taxYear;
    const targetHomeState = SAMPLE_TAX_BACKTEST.profile.homeState;

    setApplyingSampleBacktest(true);
    setNote(null);

    try {
      await bookkeepingClient.loadMockData(targetYear);
      const nextProfile = normalizeDraftFormProfile(SAMPLE_TAX_BACKTEST.profile.draftFormProfile, targetHomeState);

      setIsYearAutoSelected(false);
      setYear(targetYear);
      setHomeState(targetHomeState);
      setDraftFormProfile(nextProfile);
      setSampleBacktestActive(true);

      const data = await taxClient.saveDraftFormProfile({
        year: targetYear,
        homeState: targetHomeState,
        profile: nextProfile,
      });

      if (data?.ok) {
        setDraftFormProfile(normalizeDraftFormProfile(data.profile, targetHomeState));
        setDraftFormProfileUpdatedAt(data.updatedAt || null);
      }

      if (year === targetYear) {
        await loadAll();
      }

      setNote('Reloaded the canonical fixture ledger and switched the Tax Center into sample backtest mode.');
    } catch (err: any) {
      setNote(err?.message || 'Failed to load the sample taxpayer backtest profile.');
    } finally {
      setApplyingSampleBacktest(false);
    }
  }

  async function releasePacket() {
    if (!auth.currentUser) {
      return;
    }
    if (!Object.values(releaseChecks).every(Boolean)) {
      setNote('All approval checks must be confirmed before release.');
      return;
    }

    setReleasing(true);
    setNote(null);
    try {
      const data = await taxClient.createPacketRelease({
        year,
        releaseType: 'cpa_packet',
        notes: releaseNotes || null,
        homeState: homeState || undefined,
        draftFormProfile,
        approval: { checklist: releaseChecks },
      });
      if (data.ok) {
        await loadAll();
        setNote('Immutable packet release recorded with the current filing profile.');
      } else {
        setNote(data.error || 'Release blocked by snapshot readiness.');
      }
    } catch (err: any) {
      setNote(err?.message || 'Release blocked by snapshot readiness.');
    } finally {
      setReleasing(false);
    }
  }

  const sched = yearSummary?.scheduleE || {};
  const depr = yearSummary?.depreciation || {};
  const readiness = readinessBadge(snapshot?.packetReadiness);
  const checklistSummary = checklist?.summary || snapshot?.documentChecklist?.summary || null;
  const checklistDocuments = ((checklist?.documents || snapshot?.documentChecklist?.documents || []) as ChecklistDocument[])
    .filter((document) => document.required);
  const packetReleaseReady = Object.values(releaseChecks).every(Boolean);
  const scheduleSummary = scheduleEDetail?.summary || sched;
  const scheduleELineRows = useMemo(
    () => Object.entries(scheduleEDetail?.scheduleELines || {})
      .filter(([, line]) => Number(line.amount || 0) > 0)
      .sort((left, right) => Number(left[1].line || 999) - Number(right[1].line || 999)),
    [scheduleEDetail],
  );
  const schedulePersonalUseAdjustment = scheduleEDetail?.personalUseAdjustment
    || taxLiability?.personalUseAdjustment?.scheduleE
    || null;
  const liabilityPersonalUse = taxLiability?.personalUseAdjustment || null;
  const personalUseApplied = Boolean(schedulePersonalUseAdjustment?.applied || liabilityPersonalUse?.applies);
  const personalUseLowConfidence = Boolean(
    schedulePersonalUseAdjustment?.lowConfidence || liabilityPersonalUse?.scheduleE?.lowConfidence,
  );
  const personalUseNotes = useMemo(() => {
    const notes = (liabilityPersonalUse?.notes?.length ? liabilityPersonalUse.notes : schedulePersonalUseAdjustment?.notes) || [];
    return notes.filter(Boolean);
  }, [liabilityPersonalUse?.notes, schedulePersonalUseAdjustment?.notes]);
  const personalUseByLineRows = useMemo(
    () => Object.entries(schedulePersonalUseAdjustment?.byLine || {})
      .sort((left, right) => Number(left[1]?.line || 999) - Number(right[1]?.line || 999)),
    [schedulePersonalUseAdjustment?.byLine],
  );
  const personalUseDepreciation = liabilityPersonalUse?.depreciation || null;
  const personalUseBlockerText = useMemo(() => {
    const blockers = taxLiability?.modelingReadiness?.blockers || [];
    return blockers.find((blocker) => /280a/i.test(blocker)) || null;
  }, [taxLiability?.modelingReadiness?.blockers]);
  const multiStateBlockerText = useMemo(() => {
    const blockers = taxLiability?.modelingReadiness?.blockers || [];
    return blockers.find((blocker) => /multi-state filing footprint|resident credits|apportionment/i.test(blocker)) || null;
  }, [taxLiability?.modelingReadiness?.blockers]);
  const multiStatePacketBlockerText = useMemo(() => {
    const blockers = snapshot?.packetGates?.blockers || [];
    return blockers.find((blocker: string) => /multiple states|resident credits|apportionment/i.test(String(blocker || ''))) || null;
  }, [snapshot?.packetGates?.blockers]);
  const modelingReadinessIsEstimateOnly = taxLiability?.modelingReadiness?.status === 'estimate_only';
  const scheduleDepreciationAmount = useMemo(() => {
    const depreciationLine = scheduleELineRows.find(([key, line]) => key === 'DEPRECIATION' || Number(line.line || 0) === 18);
    return Number(depr.totalCurrentYearDepreciation || depreciationLine?.[1].amount || 0);
  }, [depr.totalCurrentYearDepreciation, scheduleELineRows]);
  const scheduleExpenseLineTotal = useMemo(
    () => scheduleELineRows.reduce((sum, [, line]) => {
      const lineNumber = Number(line.line || 0);
      return lineNumber >= 5 && lineNumber <= 19 ? sum + Number(line.amount || 0) : sum;
    }, 0),
    [scheduleELineRows],
  );
  const scheduleOperatingExpenseTotal = useMemo(
    () => scheduleExpenseLineTotal > 0
      ? Math.max(0, scheduleExpenseLineTotal - scheduleDepreciationAmount)
      : Math.max(0, Number(scheduleSummary.totalExpenses || 0) - scheduleDepreciationAmount),
    [scheduleDepreciationAmount, scheduleExpenseLineTotal, scheduleSummary.totalExpenses],
  );
  const scheduleNetBeforeDepreciation = useMemo(
    () => Number(scheduleSummary.totalIncome || 0) - scheduleOperatingExpenseTotal,
    [scheduleOperatingExpenseTotal, scheduleSummary.totalIncome],
  );
  const scheduleStatExplanations = useMemo(() => {
    const totalIncome = Number(scheduleSummary.totalIncome || 0);
    const totalExpenses = Number(scheduleSummary.totalExpenses || 0);
    const depreciationAmount = Number(depr.totalCurrentYearDepreciation || 0);
    const netIncomeOrLoss = Number(scheduleSummary.netIncomeOrLoss || 0);
    return {
      'rental-income': {
        metricId: 'rental-income',
        detail: `${fmtMoney(totalIncome)} of rents received is reported on Schedule E line 3 for tax year ${year}.`,
        citations: [
          `${fmtMoney(totalIncome)} total rental income posted for tax year ${year}.`,
          `Operating expenses before depreciation are ${fmtMoney(scheduleOperatingExpenseTotal)}.`,
        ],
      },
      'total-expenses': {
        metricId: 'total-expenses',
        detail: `${fmtMoney(totalExpenses)} of operating expenses (Schedule E lines 5-19) are deducted against rental income.`,
        citations: [
          `${fmtMoney(scheduleOperatingExpenseTotal)} of operating expenses excluding depreciation.`,
          `${fmtMoney(depreciationAmount)} of depreciation is reported separately on line 18.`,
        ],
      },
      depreciation: {
        metricId: 'depreciation',
        detail: `${fmtMoney(depreciationAmount)} of current-year depreciation is reported on Schedule E line 18 across ${depr.assetCount || 0} asset(s).`,
        citations: [
          `${depr.assetCount || 0} depreciable asset(s) are currently tracked for this property.`,
          `Net rental result before depreciation is ${fmtMoney(scheduleNetBeforeDepreciation)}.`,
        ],
      },
      'net-income': {
        metricId: 'net-income',
        detail: `${fmtMoney(netIncomeOrLoss)} is the net rental result on Schedule E line 26 for tax year ${year}.`,
        citations: [
          `${fmtMoney(totalIncome)} income minus ${fmtMoney(scheduleOperatingExpenseTotal)} operating expenses minus ${fmtMoney(depreciationAmount)} depreciation.`,
          netIncomeOrLoss >= 0 ? 'This is a net rental gain.' : 'This is a net rental loss; passive activity loss limitation rules may apply.',
        ],
      },
    };
  }, [depr.assetCount, depr.totalCurrentYearDepreciation, scheduleNetBeforeDepreciation, scheduleOperatingExpenseTotal, scheduleSummary.netIncomeOrLoss, scheduleSummary.totalExpenses, scheduleSummary.totalIncome, year]);
  const scheduleEWaterfallSteps = useMemo(
    () => [
      {
        id: 'income',
        label: 'Rents received',
        hint: 'Schedule E line 3',
        amount: Number(scheduleSummary.totalIncome || 0),
        tone: 'bg-emerald-500',
      },
      {
        id: 'operating-expenses',
        label: 'Operating expenses',
        hint: 'Schedule E lines 5-17 and 19',
        amount: -scheduleOperatingExpenseTotal,
        tone: 'bg-rose-400',
      },
      {
        id: 'depreciation',
        label: 'Depreciation',
        hint: 'Schedule E line 18',
        amount: -scheduleDepreciationAmount,
        tone: 'bg-amber-400',
      },
      {
        id: 'net-rental-result',
        label: 'Net rental result',
        hint: 'Schedule E line 26',
        amount: Number(scheduleSummary.netIncomeOrLoss || 0),
        tone: Number(scheduleSummary.netIncomeOrLoss || 0) >= 0 ? 'bg-slate-900' : 'bg-rose-600',
      },
    ],
    [scheduleDepreciationAmount, scheduleOperatingExpenseTotal, scheduleSummary.netIncomeOrLoss, scheduleSummary.totalIncome],
  );
  const scheduleEWaterfallScale = useMemo(
    () => Math.max(...scheduleEWaterfallSteps.map((step) => Math.abs(Number(step.amount || 0))), 1),
    [scheduleEWaterfallSteps],
  );
  const taxSourceEntries = useMemo(() => {
    const seen = new Set<string>();
    const entries: ScheduleELineEntry[] = [];

    for (const [, line] of scheduleELineRows) {
      for (const entry of line.entries || []) {
        const key = [
          entry.entryId || '',
          entry.sourceRef || '',
          entry.date || '',
          entry.description || '',
          entry.amount || '',
        ].join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }

    return entries;
  }, [scheduleELineRows]);
  const taxSourceMix = useMemo(() => buildFinanceSourceMix(taxSourceEntries), [taxSourceEntries]);
  const exportSourceNote = schedulePreviewScope === 'portfolio' && propertyId && scheduleScopeNote
    ? `${scheduleScopeNote} Packet exports already run at the portfolio level.`
    : taxSourceMix.total === 0
    ? 'Downloads from this view will reflect an empty tax scope until ledger activity is posted or imported.'
    : taxSourceMix.hasSample
    ? 'Downloads from this view still include sample-backed journal entries until sample data is cleared from bookkeeping.'
    : 'Downloads from this view are backed only by live/manual canonical ledger sources in the current tax scope.';

  const next1099 = useMemo(() => {
    if (!forms1099.length) return null;
    return {
      total: forms1099.length,
      ready: forms1099.filter((f) => f.w9OnFile && f.recipientTIN && !f.recipientTIN.includes('MISSING')).length,
      missing: forms1099.filter((f) => !f.w9OnFile || !f.recipientTIN || f.recipientTIN.includes('MISSING')).length,
    };
  }, [forms1099]);
  const latestFiled1099 = useMemo(
    () => filingHistory.find((filing) => Boolean(filing?.formId)) || null,
    [filingHistory],
  );
  const checklistBlockers = useMemo(
    () => checklistDocuments.filter((document) => !['data_ready', 'not_applicable'].includes(String(document.status || '').toLowerCase())),
    [checklistDocuments],
  );
  const sampleBacktest = useMemo(() => {
    const getScheduleLineAmount = (key: string, lineNumber: number) => {
      const direct = scheduleEDetail?.scheduleELines?.[key]?.amount;
      if (direct !== undefined && direct !== null) return Number(direct || 0);
      const [, line] = scheduleELineRows.find(([candidateKey, candidateLine]) => (
        candidateKey === key || Number(candidateLine.line || 0) === lineNumber
      )) || [];
      return Number(line?.amount || 0);
    };

    const line3 = getScheduleLineAmount('RENTS_RECEIVED', 3) || Number(scheduleSummary.totalIncome || 0);
    const line4 = getScheduleLineAmount('OTHER_INCOME', 4);
    const explicitLine18 = getScheduleLineAmount('DEPRECIATION', 18);
    const syntheticLine18 = explicitLine18 > 0 ? 0 : scheduleDepreciationAmount;
    const line18 = explicitLine18 > 0 ? explicitLine18 : syntheticLine18;
    const line20 = roundForCompare(
      scheduleELineRows.reduce((sum, [, line]) => {
        const lineNumber = Number(line.line || 0);
        if (lineNumber <= 0 || lineNumber === 3 || lineNumber === 4) {
          return sum;
        }
        return sum + Number(line.amount || 0);
      }, 0) + syntheticLine18,
    );
    const line21 = line3 + line4 - line20;
    const generatedScheduleValues: Record<string, number> = {
      line3RentsReceived: line3,
      line4RoyaltiesReceived: line4,
      line18Depreciation: roundForCompare(line18),
      line20TotalExpenses: line20,
      line21IncomeOrLoss: roundForCompare(line21),
      line26TotalIncomeOrLoss: roundForCompare(line21),
    };

    const scheduleRows = SAMPLE_TAX_BACKTEST.scheduleE.map((row) => {
      const generated = roundForCompare(generatedScheduleValues[row.id]);
      const matches = valuesMatch(row.expected, generated);
      return { ...row, generated, matches };
    });

    const form1099Rows = SAMPLE_TAX_BACKTEST.forms1099Nec.map((expected) => {
      const generatedForm = forms1099.find((form) => form.recipientName === expected.recipientName);
      const generated = {
        recipientTIN: generatedForm?.recipientTIN || '',
        recipientAddress: generatedForm?.recipientAddress || '',
        box1NonemployeeCompensation: roundForCompare(generatedForm?.amount),
        readiness: generatedForm
          ? (generatedForm.w9OnFile && generatedForm.recipientTIN && !/missing/i.test(generatedForm.recipientTIN) && !(generatedForm.missingInfo || []).length ? 'ready' : 'action_required')
          : 'missing',
      };
      const matches = valuesMatch(expected.recipientTIN, generated.recipientTIN)
        && valuesMatch(expected.recipientAddress, generated.recipientAddress)
        && valuesMatch(expected.box1NonemployeeCompensation, generated.box1NonemployeeCompensation)
        && valuesMatch(expected.readiness, generated.readiness);
      return { ...expected, generated, matches };
    });

    const allRows = [...scheduleRows, ...form1099Rows];
    const passed = allRows.filter((row) => row.matches).length;

    return {
      scheduleRows,
      form1099Rows,
      passed,
      total: allRows.length,
      allPassed: passed === allRows.length,
    };
  }, [
    forms1099,
    scheduleDepreciationAmount,
    scheduleEDetail?.scheduleELines,
    scheduleELineRows,
    scheduleOperatingExpenseTotal,
    scheduleSummary.totalIncome,
  ]);
  const rulesGovernanceWarnings = useMemo(
    () => (Number(taxRulesPackage?.taxYear) === year
      ? ((taxRulesPackage?.governance?.warnings || []) as string[]).filter(Boolean)
      : []),
    [taxRulesPackage, year],
  );
  const effectiveRulesVersion = snapshot?.rulesVersion
    || (Number(taxRulesPackage?.taxYear) === year ? taxRulesPackage?.rulesVersion : null)
    || auditRulesSources?.rulesVersion
    || null;
  const latestRelease = releases.length > 0 ? releases[0] : null;
  const packetReadyForRelease = String(snapshot?.packetReadiness || '').toLowerCase().includes('ready');
  const filingCockpitItems = useMemo<FilingCockpitItem[]>(() => {
    const items: FilingCockpitItem[] = [];

    if (!packetReadyForRelease) {
      items.push({
        id: 'packet-readiness',
        lane: 'packet',
        title: readiness.label,
        detail: 'Packet readiness is still below CPA handoff level. Resolve blockers before immutable release.',
        meta: snapshot?.generatedAt ? `Last snapshot ${fmtDate(snapshot.generatedAt)}` : 'Persist a fresh draft snapshot after changes.',
        priority: 100,
      });
    }

    if (checklistBlockers.length > 0) {
      items.push({
        id: 'checklist-blockers',
        lane: 'checklist',
        title: `${checklistBlockers.length} checklist items still need action`,
        detail: checklistBlockers.slice(0, 2).map((document) => document.name).join(' · '),
        meta: checklistSummary?.nextDeadline ? `Next deadline ${fmtDate(checklistSummary.nextDeadline)}` : 'Checklist blockers must clear before handoff is complete.',
        priority: 95,
      });
    }

    if ((next1099?.missing || 0) > 0) {
      items.push({
        id: '1099-missing-info',
        lane: '1099',
        title: `${next1099?.missing || 0} reportable vendors are missing 1099 info`,
        detail: 'W-9 or TIN gaps will block contractor filing readiness and weaken the CPA packet.',
        meta: `${next1099?.ready || 0} ready of ${next1099?.total || 0} reportable vendors`,
        priority: 92,
      });
    }

    if (packetIntelligence?.blockers.length) {
      items.push({
        id: 'release-intelligence',
        lane: 'packet',
        title: `Release intelligence flagged ${packetIntelligence.blockers.length} blocker(s)`,
        detail: packetIntelligence.blockers.slice(0, 2).join(' · '),
        meta: `Score ${packetIntelligence.score} · ${humanizeStatus(packetIntelligence.readinessStatus)}`,
        priority: 85,
      });
    }

    if (!latestRelease) {
      items.push({
        id: 'release-history',
        lane: 'release',
        title: 'No immutable CPA packet has been released yet',
        detail: 'Persist a draft snapshot, complete reviewer attestation, and record the first immutable release when ready.',
        meta: releaseHistoryStatus === 'not_configured' ? 'Immutable release history is not fully configured in this environment.' : 'Release history will appear here once a packet is attested and released.',
        priority: 70,
      });
    }

    return items.sort((left, right) => right.priority - left.priority);
  }, [checklistBlockers, checklistSummary?.nextDeadline, latestRelease, next1099, packetIntelligence, packetReadyForRelease, readiness.label, releaseHistoryStatus, snapshot?.generatedAt]);
  const releaseBlockerReasons = useMemo(() => {
    const reasons: Array<{ label: string; detail: string }> = [];

    if (!packetReadyForRelease) {
      reasons.push({
        label: 'Snapshot readiness',
        detail: `Current packet readiness is ${readiness.label.toLowerCase()}.`,
      });
    }

    if (checklistBlockers.length > 0) {
      reasons.push({
        label: 'Required documents',
        detail: checklistBlockers.slice(0, 2).map((document) => document.name).join(' · '),
      });
    }

    if ((next1099?.missing || 0) > 0) {
      reasons.push({
        label: '1099 readiness gaps',
        detail: `${next1099?.missing || 0} reportable vendors still need W-9 or TIN details.`,
      });
    }

    for (const blocker of packetIntelligence?.blockers || []) {
      reasons.push({
        label: 'Release intelligence blocker',
        detail: blocker,
      });
    }

    return reasons.slice(0, 5);
  }, [checklistBlockers, next1099, packetIntelligence?.blockers, packetReadyForRelease, readiness.label]);
  const filingSnapshotExplanations = useMemo(() => {
    return [
      {
        id: 'packet-readiness',
        title: 'Why packet readiness is at this status',
        detail: `${readiness.label}. ${packetIntelligence?.summary || 'Packet intelligence has not added more reviewer context yet.'}`,
        citations: [
          snapshot?.rulesVersion ? `Rules version ${snapshot.rulesVersion} is loaded for this filing view.` : 'No rules version is attached to the current snapshot yet.',
          snapshot?.generatedAt ? `Current snapshot generated ${fmtDate(snapshot.generatedAt)}.` : 'No persisted snapshot timestamp is attached yet.',
          packetIntelligence?.blockers?.[0] || 'No explicit packet-intelligence blocker is currently attached.',
        ],
      },
      {
        id: '1099-readiness',
        title: 'Why 1099 readiness looks like this',
        detail: next1099
          ? `${next1099.ready} vendors are ready and ${next1099.missing} still need filing data.`
          : 'No reportable 1099 vendors are currently loaded into the readiness lane.',
        citations: [
          `${fmtMoney(report1099Total)} contractor payment volume is currently in 1099 scope.`,
          next1099 ? `${next1099.total} reportable form candidate(s) were returned from the canonical 1099 report.` : 'No canonical 1099 candidate set is currently loaded.',
          next1099?.missing ? 'Missing W-9 or TIN details still block some contractor forms.' : 'No current 1099 information blockers are flagged.',
        ],
      },
      {
        id: 'checklist-blockers',
        title: 'Why checklist blockers look like this',
        detail: `${checklistBlockers.length} required document blocker(s) are currently visible in this workspace.`,
        citations: [
          checklistSummary?.nextDeadline ? `Next checklist deadline is ${fmtDate(checklistSummary.nextDeadline)}.` : 'No next checklist deadline is currently attached.',
          checklistBlockers.length > 0 ? checklistBlockers.slice(0, 2).map((document) => document.name).join(' · ') : 'No required document blockers are currently attached.',
          packetIntelligence?.blockers?.[0] || 'No packet-intelligence blocker is currently attached to the checklist lane.',
        ],
      },
      {
        id: 'immutable-releases',
        title: 'Why immutable release history looks like this',
        detail: `${releases.length} immutable release record(s) are currently visible in this workspace.`,
        citations: [
          latestRelease ? `Latest immutable release recorded ${fmtDate(latestRelease.createdAt || latestRelease.releasedAt)}.` : 'No immutable release has been recorded yet.',
          releaseHistoryStatus === 'not_configured' ? 'Release history storage is not fully configured in this environment.' : 'Release history is available from the canonical packet-release store.',
          packetReadyForRelease ? 'The current snapshot is reading as ready for release.' : 'The current snapshot is not yet reading as release-ready.',
        ],
      },
    ];
  }, [checklistBlockers, checklistSummary?.nextDeadline, latestRelease, next1099, packetIntelligence?.blockers, packetIntelligence?.summary, packetReadyForRelease, readiness.label, releaseHistoryStatus, releases.length, report1099Total, snapshot?.generatedAt, snapshot?.rulesVersion]);
  const taxpayerContextWarnings = useMemo(() => {
    const warnings: string[] = [];

    if (!draftFormProfile.primaryName) {
      warnings.push('Primary taxpayer name is missing from the taxpayer planning profile.');
    }
    if (!draftFormProfile.tinLast4) {
      warnings.push('TIN last four is missing, so reviewer identity tie-out is incomplete.');
    }
    if (!draftFormProfile.mailingStreet || !draftFormProfile.mailingCity || !(draftFormProfile.mailingState || homeState) || !draftFormProfile.mailingZip) {
      warnings.push('Mailing address is incomplete, so planning outputs may omit taxpayer mailing context.');
    }
    if (!homeState) {
      warnings.push('Home state is blank, so state tax assumptions remain limited.');
    }
    return warnings;
  }, [draftFormProfile.mailingCity, draftFormProfile.mailingState, draftFormProfile.mailingStreet, draftFormProfile.mailingZip, draftFormProfile.primaryName, draftFormProfile.priorYearTotalTax, draftFormProfile.tinLast4, homeState]);
  const canonicalRulesPackageForYear = useMemo(
    () => getTaxRulesetPackage(year) as unknown as TaxRulesPackage,
    [year],
  );
  const runtimeRulesPackageIsExactForYear = taxRulesPackage?.governance?.coverageStatus === 'supported'
    && Number(taxRulesPackage?.taxYear) === year;
  const rulesMetadataIsExactForYear = Number(taxRulesMetadata?.taxYear) === year;
  const ruleSourceDocuments = useMemo(
    () => {
      const metadataSources = taxRulesMetadata?.sourceDocuments || [];
      if (runtimeRulesPackageIsExactForYear && rulesMetadataIsExactForYear && metadataSources.length > 0) return metadataSources as TaxRuleSourceDocument[];
      const packageSources = taxRulesPackage?.sourceDocuments || [];
      if (runtimeRulesPackageIsExactForYear && packageSources.length > 0) return packageSources as TaxRuleSourceDocument[];
      return (canonicalRulesPackageForYear.sourceDocuments || []) as TaxRuleSourceDocument[];
    },
    [taxRulesMetadata, taxRulesPackage, canonicalRulesPackageForYear, runtimeRulesPackageIsExactForYear, rulesMetadataIsExactForYear],
  );
  const ruleSourceDocumentById = useMemo(
    () => Object.fromEntries(ruleSourceDocuments.map((document) => [document.id, document])),
    [ruleSourceDocuments],
  );
  const sourceRuleAudits = useMemo<SourceRuleAuditRecord[]>(() => {
    if (runtimeRulesPackageIsExactForYear && Array.isArray(taxRulesPackage?.sourceRuleAudits)) {
      return taxRulesPackage.sourceRuleAudits;
    }
    if (rulesMetadataIsExactForYear && Array.isArray(taxRulesMetadata?.validation?.sourceRuleAudits)) {
      return taxRulesMetadata.validation.sourceRuleAudits;
    }
    return [];
  }, [runtimeRulesPackageIsExactForYear, rulesMetadataIsExactForYear, taxRulesPackage, taxRulesMetadata]);
  const appliedTaxRuleGroups = useMemo<AppliedTaxRuleGroup[]>(() => {
    const hasExactSupportedRuntime = runtimeRulesPackageIsExactForYear;
    const ruleset = hasExactSupportedRuntime ? taxRulesPackage : canonicalRulesPackageForYear;
    const fallbackGroups: AppliedTaxRuleGroup[] = [
      {
        id: 'schedule-e-line-map',
        label: 'Schedule E line mappings',
        status: ruleset.scheduleELineMap ? 'applied' : 'missing',
        sourceDocumentIds: ['irs-schedule-e-instructions'],
        summary: `${Object.keys(ruleset.scheduleELineMap || {}).length} Schedule E line mappings are active for rental income, expenses, depreciation, and other rental lines.`,
        details: [
          { label: 'Mapped lines', value: Object.keys(ruleset.scheduleELineMap || {}).length },
          { label: 'Tenant charges', value: 'Rent income line 3 unless explicitly royalty income' },
        ],
      },
      {
        id: 'federal-brackets',
        label: 'Federal income tax brackets',
        status: ruleset.federalTaxBrackets ? 'applied' : 'missing',
        sourceDocumentIds: ['irs-federal-tax-rates'],
        summary: `${Object.keys(ruleset.federalTaxBrackets || {}).length} filing-status bracket tables are loaded for the selected tax year.`,
        details: [
          { label: 'Filing statuses', value: Object.keys(ruleset.federalTaxBrackets || {}).length },
          { label: 'Engine role', value: 'Used by deterministic liability and tax modeling math' },
        ],
      },
      {
        id: 'standard-deduction',
        label: 'Standard deduction',
        status: ruleset.standardDeduction ? 'applied' : 'missing',
        sourceDocumentIds: ['irs-federal-tax-rates'],
        summary: 'Standard deduction values are loaded by filing status and applied before taxable income is computed.',
        details: [
          { label: 'Single', value: ruleset.standardDeduction?.single ?? null },
          { label: 'MFJ', value: ruleset.standardDeduction?.married_filing_jointly ?? null },
        ],
      },
      {
        id: 'depreciation',
        label: 'Rental property depreciation assumptions',
        status: ruleset.depreciation ? 'applied' : 'missing',
        sourceDocumentIds: ['irs-publication-527'],
        summary: ruleset.depreciation
          ? `${ruleset.depreciation.method || 'GDS'} depreciation using ${ruleset.depreciation.convention || 'mid-month'} convention.`
          : 'Depreciation metadata is missing from the active package.',
        details: [
          { label: 'Useful life months', value: ruleset.depreciation?.residentialRentalUsefulLifeMonths ?? null },
          { label: 'Default land %', value: ruleset.depreciation?.defaultLandValuePercent ?? null },
        ],
      },
      {
        id: '1099-nec',
        label: '1099-NEC contractor threshold',
        status: ruleset.tax1099 ? 'applied' : 'missing',
        sourceDocumentIds: ['irs-publication-1099'],
        summary: ruleset.tax1099?.activeThreshold
          ? `Active contractor threshold is $${Number(ruleset.tax1099.activeThreshold).toLocaleString('en-US')}.`
          : '1099 threshold metadata is missing from the active package.',
        details: [
          { label: 'Active threshold', value: ruleset.tax1099?.activeThreshold ?? null },
          { label: 'Threshold source', value: ruleset.tax1099?.activeThresholdSummary || null },
          { label: 'Source audit', value: ruleset.tax1099?.sourceRuleAudit?.status || null },
        ],
      },
      {
        id: 'state-planning',
        label: 'State tax planning lookup',
        status: ruleset.stateTaxRates || ruleset.stateRateSummary ? 'applied' : 'missing',
        sourceDocumentIds: ['houseyield-state-rate-table'],
        summary: ruleset.stateTaxMethodology || 'State planning rates are a planning layer and do not replace state return-specific rules.',
        details: [
          { label: 'State rates', value: Object.keys(ruleset.stateTaxRates || {}).length },
          { label: 'No-tax states', value: Array.isArray(ruleset.noIncomeTaxStates) ? ruleset.noIncomeTaxStates.length : null },
        ],
      },
    ];
    const fallbackById = Object.fromEntries(fallbackGroups.map((group) => [group.id, group]));

    if (hasExactSupportedRuntime && rulesMetadataIsExactForYear && taxRulesMetadata?.appliedRuleGroups?.length) {
      return taxRulesMetadata.appliedRuleGroups.map((group) => ({
        ...(fallbackById[group.id] || {}),
        ...group,
        summary: group.summary || fallbackById[group.id]?.summary,
        details: group.details?.length ? group.details : fallbackById[group.id]?.details,
        sourceDocumentIds: group.sourceDocumentIds?.length ? group.sourceDocumentIds : fallbackById[group.id]?.sourceDocumentIds,
      }));
    }

    return fallbackGroups;
  }, [taxRulesMetadata, taxRulesPackage, canonicalRulesPackageForYear, runtimeRulesPackageIsExactForYear, rulesMetadataIsExactForYear]);
  const appliedTaxRuleCount = appliedTaxRuleGroups.filter((group) => group.status === 'applied').length;
  const sourceRuleAuditByGroupId = useMemo(() => {
    const aliases: Record<string, string[]> = {
      '1099-nec': ['1099-nec-threshold'],
      'federal-brackets': ['federal-brackets'],
      'standard-deduction': ['standard-deduction'],
      'schedule-e-line-map': ['schedule-e-line-map'],
      depreciation: ['depreciation'],
    };

    return Object.fromEntries(appliedTaxRuleGroups.map((group) => {
      const audit = sourceRuleAudits.find((candidate) => (
        candidate.id === group.id || (aliases[group.id] || []).includes(String(candidate.id || ''))
      ));
      return [group.id, audit || null];
    }));
  }, [appliedTaxRuleGroups, sourceRuleAudits]);
  const ruleUsageByGroupId: Record<string, string> = {
    'schedule-e-line-map': 'Schedule E lines 3-22, rental income/expense tie-out',
    'federal-brackets': 'Federal taxable-income projection and estimated liability',
    'standard-deduction': 'Federal taxable-income projection before credits and withholding',
    depreciation: 'Schedule E depreciation and rental basis workpapers',
    '1099-nec': '1099-NEC/1099-MISC vendor readiness and reporting threshold checks',
    'state-planning': 'State withholding and planning estimate layer only',
  };
  const appliedRulesValidationStatus = (rulesMetadataIsExactForYear ? taxRulesMetadata?.validation?.status : null)
    || (rulesGovernanceWarnings.length > 0 ? 'attention_needed' : 'passed');
  const appliedRulesRuntimeSource = (rulesMetadataIsExactForYear ? taxRulesMetadata?.rulesRuntime?.source : null)
    || auditRulesSources?.sources?.[0]?.authority
    || 'static_shared_rules';
  const rulesGovernance = (runtimeRulesPackageIsExactForYear ? taxRulesPackage?.governance : null)
    || (rulesMetadataIsExactForYear ? taxRulesMetadata?.rulesRuntime?.governance : null)
    || canonicalRulesPackageForYear.governance
    || null;
  const requestedRulesYear = rulesGovernance?.requestedTaxYear
    || (rulesMetadataIsExactForYear ? taxRulesMetadata?.taxYear : null)
    || (runtimeRulesPackageIsExactForYear ? taxRulesPackage?.taxYear : null)
    || year;
  const activeRulesYear = rulesGovernance?.supportedTaxYear
    || (runtimeRulesPackageIsExactForYear ? taxRulesPackage?.referenceTaxYear : null)
    || canonicalRulesPackageForYear.referenceTaxYear
    || null;
  const rulesCoverageStatus = String(rulesGovernance?.coverageStatus || 'unknown').replace(/_/g, ' ');
  const rulesYearIsFullySupported = requestedRulesYear === activeRulesYear
    && rulesGovernance?.coverageStatus === 'supported';
  const activationValidation = rulesMetadataIsExactForYear ? taxRulesMetadata?.activationValidation || null : null;
  const activationWarnings = [
    ...((rulesMetadataIsExactForYear ? taxRulesMetadata?.validation?.warnings || [] : []) as string[]),
    ...((activationValidation?.warnings || []) as string[]),
  ].filter(Boolean);
  const activationBlockers = ((activationValidation?.blockers || []) as string[]).filter(Boolean);
  const edgeCaseBlockers = ((taxEdgeCaseReview?.blockers || []) as string[]).filter(Boolean);
  const edgeCaseQuestions = ((taxEdgeCaseReview?.missingInfoQuestions || []) as string[]).filter(Boolean);
  const personalTaxUploadSummary = useMemo(() => ({
    totalDocs: 0,
    likelyW2Count: 0,
    digitizedCount: 0,
    digitizedW2Count: 0,
    parsedW2Count: 0,
    heuristicallyParsedW2Count: 0,
    extractionFailedW2Count: 0,
    employerCount: 0,
    parsedTaxYearCount: 0,
    totalParsedWages: 0,
    totalParsedFederalWithholding: 0,
    totalParsedStateWithholding: 0,
  }), []);
  const taxScenarioAssumptions = useMemo(() => ([
    {
      title: `Filing status is ${filingStatus.toUpperCase()}`,
      detail: 'The current marginal brackets, standard deduction, and liability preview all follow this filing-status selector.',
      meta: `tax year ${year}`,
    },
    {
      title: `${fmtMoney(effectiveScenarioInputs.otherIncome)} of non-rental income is modeled`,
      detail: 'This remains a simple manual scenario input only. No uploaded W-2, payroll, or brokerage data is feeding the model anymore.',
      meta: 'manual scenario input',
    },
    {
      title: `${fmtMoney(effectiveScenarioInputs.withholdingYtd)} withholding and ${fmtMoney(draftFormProfile.taxCredits)} credits are applied after modeled tax`,
      detail: 'Withholding stays manual in this workflow. The Schedule E and 1099 packet does not depend on uploaded personal tax documents.',
      meta: 'post-tax adjustments',
    },
    {
      title: taxLiability?.stateWithholding?.provided
        ? `${fmtMoney(taxLiability.stateWithholding.applied || 0)} of state withholding is applied against the state-tax layer (${describeStateWithholdingSource(taxLiability.stateWithholding.source)})`
        : 'No state withholding is currently provided or derived',
      detail: taxLiability?.stateWithholding?.provided
        ? `State withholding offsets only the modeled state-tax portion and never federal liability. State net due ${fmtMoney(taxLiability.stateWithholding.stateNetDue || 0)} · state overpayment ${fmtMoney(taxLiability.stateWithholding.stateOverpayment || 0)}. The state layer remains a planning baseline, not filing-grade output.`
        : 'No state withholding has been entered for the optional planning preview.',
      meta: 'state withholding (planning baseline)',
    },
    {
      title: `${fmtMoney(draftFormProfile.otherDeductions)} of non-rental deductions are modeled`,
      detail: 'The engine compares this amount against the standard deduction and uses whichever is larger for the current scenario.',
      meta: 'deduction method selection',
    },
    {
      title: draftFormProfile.rentalServiceHours
        ? `${draftFormProfile.rentalServiceHours} rental service hour${draftFormProfile.rentalServiceHours === '1' ? '' : 's'} are on file for QBI review`
        : 'Rental service hours are still missing for QBI review',
      detail: draftFormProfile.rentalServiceHours
        ? 'The current tax preview can use these hours to decide whether the rental activity clears the present QBI safe-harbor gate.'
        : 'Until rental service hours are entered, the main liability preview conservatively leaves QBI at zero even when the rental activity is profitable.',
      meta: 'QBI evidence',
    },
  ]), [
    draftFormProfile.otherDeductions,
    draftFormProfile.rentalServiceHours,
    draftFormProfile.taxCredits,
    effectiveScenarioInputs.otherIncome,
    effectiveScenarioInputs.withholdingYtd,
    filingStatus,
    taxLiability?.stateWithholding,
    year,
  ]);
  const taxEngineGapFindings = useMemo<Array<{ title: string; detail: string; meta: string; tone: 'emerald' | 'amber' | 'rose' }>>(() => ([
    {
      title: 'Personal-tax ingestion is intentionally out of scope',
      detail: 'This workspace now focuses on Schedule E, depreciation, 1099 readiness, and packet handoff. Personal-return inputs are no longer collected from uploaded W-2 documents here.',
      meta: 'product scope',
      tone: 'emerald',
    },
    {
      title: 'Passive loss logic is simplified relative to Form 8582',
      detail: 'Current PAL handling uses other income as a MAGI proxy and applies the $25K active-participation allowance, but it does not model prior-year unallowed PAL schedules, activity-level allocations, or Form 8582 carryforward worksheets.',
      meta: 'PAL / MAGI limitation',
      tone: 'amber',
    },
    {
      title: taxLiability?.qbi?.applied
        ? `QBI is reducing federal taxable income by ${fmtMoney(taxLiability.qbi.deduction || 0)}`
        : 'QBI now depends on entered rental service hours',
      detail: taxLiability?.qbi?.applied
        ? `${taxLiability.qbi.reason || 'The current preview is applying a QBI deduction in the federal liability path.'} State tax remains a baseline layer and is not automatically conformed to federal QBI treatment.`
        : draftFormProfile.rentalServiceHours
          ? 'The engine now evaluates QBI / Form 8995 in the main liability preview, but the current scenario is not applying a deduction because the hours or income facts do not clear the present safe-harbor path.'
          : 'The engine now supports QBI / Form 8995 in the main liability preview, but this workspace has no rental service hours entered yet, so QBI remains conservatively excluded until that evidence is supplied.',
      meta: 'QBI / Form 8995',
      tone: taxLiability?.qbi?.applied ? 'emerald' : 'amber',
    },
    {
      title: 'Depreciation is portfolio-level straight-line, not a full asset ledger',
      detail: 'The current schedule handles land/building split and annual depreciation, but it does not yet maintain improvement-level placed-in-service schedules, partial dispositions, basis adjustments, or recapture planning inside this workflow.',
      meta: 'Form 4562 depth',
      tone: 'amber',
    },
    {
      title: 'State layering is only a planning baseline today',
      detail: 'Baseline state-rate lookups exist, but resident-state credits, source-state apportionment, conformity differences, local taxes, composite returns, and state-specific depreciation adjustments are not modeled in this preview.',
      meta: 'multi-state and conformity gap',
      tone: 'rose',
    },
    {
      title: 'Short-term-rental self-employment tax is not determined here',
      detail: 'The current preview does not decide whether a short-term rental rises to the level that triggers SE tax, nor does it evaluate hotel-like services, material participation, or Schedule C treatment.',
      meta: 'STR / SE tax gap',
      tone: 'amber',
    },
  ]), [
    confirmedW2ScenarioApplies,
    draftFormProfile.priorYearTotalTax,
    draftFormProfile.rentalServiceHours,
    personalTaxUploadSummary.likelyW2Count,
    selectedW2DocumentIds.length,
    selectedW2Totals.federalWithholding,
    selectedW2Totals.wages,
    taxLiability?.qbi?.applied,
    taxLiability?.qbi?.deduction,
    taxLiability?.qbi?.reason,
  ]);
  const stateTaxLayerNotes = useMemo(() => {
    const stateDetails = taxLiability?.taxes?.stateDetails || [];
    if (stateDetails.length === 0) {
      return [{
        title: homeState
          ? `Home-state estimate is anchored to ${homeState}`
          : 'No state tax layer is currently attached',
        detail: homeState
          ? 'The preview can calculate a baseline state estimate, but resident credits and sourcing adjustments still need manual review.'
          : 'Enter a home state to attach a baseline state-income-tax estimate to the current scenario.',
        meta: 'state layer',
      }];
    }

    return stateDetails.map((stateDetail) => ({
      title: `${stateDetail.stateName || stateDetail.state || 'State'} estimated tax ${fmtMoney(stateDetail.tax)}`,
      detail: stateDetail.note || `Effective modeled rate ${Number(stateDetail.effectiveRate || 0).toFixed(2)}% on ${fmtMoney(stateDetail.incomeFromState || taxLiability?.stateTaxableIncome || taxLiability?.taxableIncome || 0)} of modeled taxable income.`,
      meta: stateDetail.isHomeState ? 'home state layer' : 'source-state layer',
    }));
  }, [homeState, taxLiability]);
  const taxAuditStatus = useMemo(() => {
    const blockerCount = checklistBlockers.length
      + (next1099?.missing || 0)
      + (packetIntelligence?.blockers?.length ?? 0)
      + taxpayerContextWarnings.length
      + (snapshot?.rulesVersion ? 0 : 1)
      + (ruleSourceDocuments.length > 0 ? 0 : 1);

    if (!hasRenderableTaxDataset(yearSummary, scheduleEDetail) && !snapshot && forms1099.length === 0) {
      return {
        label: 'No tax audit snapshot yet',
        tone: 'slate' as const,
        detail: 'Load a tax year or generate a packet snapshot to populate Schedule E and filing audit context.',
      };
    }

    if (blockerCount > 0 || !packetReadyForRelease) {
      return {
        label: 'Attention needed before filing handoff',
        tone: 'amber' as const,
        detail: `${blockerCount + (!packetReadyForRelease ? 1 : 0)} visible tax audit signal(s) are limiting filing readiness in this view.`,
      };
    }

    return {
      label: 'Tax handoff snapshot looks aligned',
      tone: taxSourceMix.hasSample ? 'amber' as const : 'emerald' as const,
      detail: taxSourceMix.hasSample
        ? 'Tax controls are populated, but Schedule E is still mixing in sample-backed bookkeeping sources.'
        : 'Rules, tie-out, estimate, and packet signals are aligned for the active tax-year view.',
    };
  }, [checklistBlockers.length, forms1099.length, next1099?.missing, packetIntelligence?.blockers?.length, packetReadyForRelease, ruleSourceDocuments.length, scheduleEDetail, snapshot, taxpayerContextWarnings.length, taxSourceMix.hasSample, yearSummary]);
  const taxAuditFlags = useMemo(() => {
    const flags: Array<{ title: string; detail: string; tone?: 'amber' | 'rose' | 'slate' | 'emerald' }> = [];

    if (taxSourceMix.hasSample) {
      flags.push({
        title: 'Sample-backed tax inputs',
        detail: `${taxSourceMix.samplePct}% of the current Schedule E source mix is sample-backed, so this audit rail is not yet fully live-data only.`,
        tone: 'amber',
      });
    }
    if (schedulePreviewScope === 'portfolio' && propertyId) {
      flags.push({
        title: 'Portfolio fallback in use',
        detail: scheduleScopeNote || 'Property-scoped Schedule E detail is unavailable, so this view is temporarily using portfolio tax data.',
        tone: 'amber',
      });
    }
    if (!snapshot?.rulesVersion && !taxRulesPackage?.rulesVersion) {
      flags.push({
        title: 'Rules version missing',
        detail: 'The current tax workspace does not have a visible rules version attached, so reviewer version tie-out is incomplete.',
        tone: 'rose',
      });
    } else if (!snapshot?.rulesVersion) {
      flags.push({
        title: 'Snapshot not pinned to rules version',
        detail: `Rules ${taxRulesPackage?.rulesVersion} are loaded for this workspace, but no persisted packet snapshot is pinned to them yet.`,
        tone: 'amber',
      });
    }
    if (ruleSourceDocuments.length === 0) {
      flags.push({
        title: 'Rule-source package unavailable',
        detail: 'No rule-source metadata is attached to this runtime package, so source/date traceability is incomplete.',
        tone: 'rose',
      });
    }
    if (rulesGovernanceWarnings.length > 0) {
      flags.push({
        title: 'Rules governance needs review',
        detail: rulesGovernanceWarnings[0],
        tone: taxRulesPackage?.governance?.freshnessStatus === 'current' ? 'amber' : 'rose',
      });
    }
    if (checklistBlockers.length > 0) {
      flags.push({
        title: 'Checklist blockers open',
        detail: `${checklistBlockers.length} required document blocker(s) are still visible for this tax year.`,
        tone: 'rose',
      });
    }
    if ((next1099?.missing || 0) > 0) {
      flags.push({
        title: '1099 filing info missing',
        detail: `${next1099?.missing || 0} reportable vendor(s) still need W-9 or TIN information.`,
        tone: 'rose',
      });
    }
    if (taxpayerContextWarnings.length > 0) {
      flags.push({
        title: 'Taxpayer context incomplete',
        detail: taxpayerContextWarnings[0],
        tone: 'amber',
      });
    }
    if (personalUseLowConfidence) {
      flags.unshift({
        title: '§280A allocation is low confidence',
        detail: personalUseBlockerText
          || 'Section 280A applies but fair-rental days were never explicitly entered, so the rental-use allocation is a 365-day-default guess. Enter explicit fair-rental days to clear this blocker.',
        tone: 'rose',
      });
    } else if (modelingReadinessIsEstimateOnly) {
      flags.unshift({
        title: 'Liability preview gated to estimate-only',
        detail: taxLiability?.modelingReadiness?.blockers?.[0] || 'The modeled liability is gated to estimate-only until its blockers are resolved.',
        tone: 'rose',
      });
    } else if (personalUseApplied) {
      flags.push({
        title: '§280A mixed-use proration applied',
        detail: `${fmtMoney(schedulePersonalUseAdjustment?.totalDisallowedExpenses)} of Schedule E expenses were excluded as the personal-use share for mixed-use properties.`,
        tone: 'amber',
      });
    }

    return flags.slice(0, 6);
  }, [checklistBlockers.length, likelyW2Documents.length, modelingReadinessIsEstimateOnly, next1099?.missing, personalUseApplied, personalUseBlockerText, personalUseLowConfidence, propertyId, ruleSourceDocuments.length, rulesGovernanceWarnings, schedulePersonalUseAdjustment?.totalDisallowedExpenses, schedulePreviewScope, scheduleScopeNote, snapshot?.rulesVersion, taxLiability?.modelingReadiness?.blockers, taxpayerContextWarnings, taxEngineGapFindings, taxRulesPackage?.governance?.freshnessStatus, taxRulesPackage?.rulesVersion, taxSourceMix.hasSample, taxSourceMix.samplePct]);
  const taxAuditMetrics = useMemo(() => ([
    {
      label: 'Rule sources',
      value: String(ruleSourceDocuments.length),
      hint: taxRulesPackage?.governance?.coverageStatus === 'supported'
        ? (taxRulesPackage?.lastReviewedAt ? `reviewed ${fmtDate(taxRulesPackage.lastReviewedAt)}` : 'source metadata missing')
        : `coverage ${String(taxRulesPackage?.governance?.coverageStatus || 'unknown').replace(/_/g, ' ')}`,
    },
    {
      label: 'Taxable income',
      value: fmtMoney(taxLiability?.taxableIncome || 0),
      hint: taxLiability?.deductions?.method ? `${taxLiability.deductions.method} deduction` : 'scenario preview pending',
    },
    {
      label: taxLiability?.taxes?.overpayment ? 'Estimated refund' : 'Net due',
      value: fmtMoney((taxLiability?.taxes?.overpayment || 0) > 0 ? taxLiability?.taxes?.overpayment : taxLiability?.taxes?.netDue),
      hint: `${fmtMoney(taxLiability?.taxes?.afterCredits || 0)} after credits`,
    },
    {
      label: 'Context gaps',
      value: String(taxEngineGapFindings.length),
      hint: 'scope and modeling caveats',
    },
  ]), [ruleSourceDocuments.length, taxEngineGapFindings.length, taxLiability, taxRulesPackage?.governance?.coverageStatus, taxRulesPackage?.lastReviewedAt]);
  const taxAuditSections = useMemo<FinanceAuditSection[]>(() => {
    const topScheduleLines = [...scheduleELineRows]
      .sort((left, right) => Math.abs(Number(right[1].amount || 0)) - Math.abs(Number(left[1].amount || 0)))
      .slice(0, 3)
      .map(([, line]) => ({
        title: `${line.name}${line.line ? ` (line ${line.line})` : ''}`,
        detail: `${fmtMoney(line.amount)} from ${line.entries.length} mapped journal entr${line.entries.length === 1 ? 'y' : 'ies'}.`,
        meta: 'largest mapped line',
      }));
    const mortgageAdjustedLines = scheduleELineRows.filter(([, line]) => line.mortgageSplitApplied || Number(line.principalExcluded || 0) > 0).length;

    return [
      {
        label: 'Rules package in effect',
        summary: 'Which rule package is currently driving this workspace and what year it applies to. Official source links live in the IRS rules package card above.',
        tone: snapshot?.rulesVersion || ruleSourceDocuments.length > 0 ? 'emerald' : 'amber',
        items: [
          {
            title: `Tax year ${year} · filing status ${filingStatus.toUpperCase()}${homeState ? ` · home state ${homeState}` : ''}`,
            detail: taxRulesPackage?.scopeSummary || 'Federal rental rules and baseline state-rate lookups are in scope for this audit.',
            meta: taxRulesPackage?.approvalStatus || 'rules approval status unavailable',
          },
          {
            title: snapshot?.rulesVersion
              ? `Rules version ${snapshot.rulesVersion} is attached`
              : 'Rules version is not attached yet',
            detail: snapshot?.generatedAt
              ? `Current packet snapshot was generated ${fmtDate(snapshot.generatedAt)}.`
              : 'No persisted packet snapshot timestamp is currently attached to this workspace.',
            meta: taxRulesPackage?.lastReviewedAt ? `last reviewed ${fmtDate(taxRulesPackage.lastReviewedAt)}` : 'review date unavailable',
          },
          {
            title: schedulePreviewScope === 'portfolio' && propertyId
              ? 'Portfolio fallback is driving the current property view'
              : (propertyAddress ? `Schedule E detail is scoped to ${propertyAddress}` : 'Schedule E detail is running at the portfolio scope'),
            detail: schedulePreviewScope === 'portfolio' && propertyId
              ? (scheduleScopeNote || 'Property-scoped Schedule E detail is unavailable, so this view is using portfolio tax data.')
              : 'The displayed tax preview is using the same source mix as the linked Schedule E detail.',
            meta: taxSourceMix.headline,
          },
        ],
      },
      {
        label: 'Why the current output looks like this',
        summary: 'A liability-first explanation of how rents, deductions, credits, and withholding are turning into the current net due or refund signal.',
        tone: taxSourceMix.hasSample ? 'amber' : 'slate',
        items: [
          {
            title: `${fmtMoney(taxLiability?.income?.gross || 0)} of gross modeled income is in play`,
            detail: `${fmtMoney(taxLiability?.income?.other || 0)} comes from manual non-rental income inputs and ${fmtMoney(taxLiability?.income?.rentalAllowable || 0)} comes from allowable rental activity after passive-loss treatment.`,
            meta: 'income stack',
          },
          {
            title: `${fmtMoney(taxLiability?.deductions?.totalDeductions || 0)} of deductions are reducing taxable income`,
            detail: taxLiability?.deductions?.method
              ? `${String(taxLiability.deductions.method).replace(/^\w/, (char) => char.toUpperCase())} deduction was selected over the alternative for this scenario.`
              : 'Deductions will populate after the scenario preview finishes loading.',
            meta: taxLiability?.deductions?.method ? `${taxLiability.deductions.method} deduction` : 'deduction method pending',
          },
          {
            title: taxLiability?.qbi?.applied
              ? `${fmtMoney(taxLiability?.deductions?.qbiDeduction || 0)} of QBI is reducing federal taxable income`
              : 'QBI is not reducing the current federal preview',
            detail: taxLiability?.qbi?.applied
              ? `${fmtMoney(taxLiability?.taxableIncomeBeforeQbi || 0)} before QBI becomes ${fmtMoney(taxLiability?.taxableIncome || 0)} after the current Form 8995-style deduction.`
              : taxLiability?.qbi?.reason || 'Enter rental service hours if the activity may qualify for the current safe-harbor-based QBI path.',
            meta: 'federal-only QBI layer',
          },
          {
            title: `${fmtMoney(taxLiability?.taxes?.total || 0)} of gross tax becomes ${fmtMoney((taxLiability?.taxes?.overpayment || 0) > 0 ? taxLiability?.taxes?.overpayment : taxLiability?.taxes?.netDue)} ${taxLiability?.taxes?.overpayment ? 'estimated refund' : 'estimated net due'}`,
            detail: `${fmtMoney(taxLiability?.taxes?.creditsApplied || 0)} of credits, ${fmtMoney(taxLiability?.taxes?.withholdingApplied || 0)} of federal withholding, and ${fmtMoney(taxLiability?.taxes?.stateWithholdingApplied || 0)} of state withholding (${describeStateWithholdingSource(taxLiability?.stateWithholding?.source)}; applied against the state layer only) are applied after federal, state, and NIIT layers.`,
            meta: 'liability after offsets',
          },
          {
            title: `${scheduleELineRows.length} non-zero Schedule E line(s) tie to ${scheduleEDetail?.entryCount ?? yearSummary?.entryCount ?? 0} journal references`,
            detail: `Income ${fmtMoney(scheduleSummary.totalIncome)} · expenses ${fmtMoney(scheduleSummary.totalExpenses)} · depreciation ${fmtMoney(depr.totalCurrentYearDepreciation)} · Schedule E net ${fmtMoney(scheduleSummary.netIncomeOrLoss)}.`,
            meta: mortgageAdjustedLines > 0
              ? `${mortgageAdjustedLines} line(s) include mortgage split adjustments`
              : 'no mortgage split adjustment currently visible',
          },
          ...(topScheduleLines.length > 0 ? topScheduleLines : [{
            title: 'No non-zero Schedule E lines are currently available',
            detail: 'Load a tax year with posted activity to see the mapped tax-line drivers behind the liability preview.',
            meta: 'tie-out pending',
          }]),
        ],
      },
      {
        label: 'Deductions, write-offs, and limits',
        summary: 'Separates write-offs that reduce taxable income from taxes that are still actually owed after credits and withholding.',
        tone: 'slate',
        items: [
          {
            title: `${fmtMoney(scheduleSummary.totalExpenses)} of Schedule E expenses and ${fmtMoney(depr.totalCurrentYearDepreciation)} of depreciation reduce rental income`,
            detail: 'These are write-offs inside the rental activity and are distinct from credits or withholding that reduce tax after it is computed.',
            meta: 'rental deductions',
          },
          {
            title: taxLiability?.passiveLoss?.hasLoss
              ? `${fmtMoney(taxLiability.passiveLoss.allowableLoss || 0)} of rental loss is currently allowed`
              : 'No passive-loss limitation is changing the current scenario',
            detail: taxLiability?.passiveLoss?.hasLoss
              ? `${fmtMoney(taxLiability.passiveLoss.disallowedLoss || 0)} is currently disallowed and carried forward under the simplified PAL logic.`
              : 'The current scenario is not showing a disallowed passive-loss carryforward.',
            meta: 'Form 8582-style limit',
          },
          {
            title: taxLiability?.qbi?.applied
              ? `${fmtMoney(taxLiability?.deductions?.qbiDeduction || 0)} of QBI is applied in the federal layer`
              : 'No QBI deduction is currently applied',
            detail: taxLiability?.qbi?.applied
              ? `${taxLiability.qbi.reason || 'The current federal preview includes a QBI deduction.'} State tax remains on the baseline state methodology.`
              : taxLiability?.qbi?.reason || 'The current QBI path stays at zero until profitable rental income and enough rental service hours are evidenced.',
            meta: 'Form 8995-style limit',
          },
          ...(personalUseApplied || personalUseLowConfidence
            ? [{
                title: personalUseLowConfidence
                  ? '§280A proration is active but low confidence'
                  : `§280A proration excluded ${fmtMoney(schedulePersonalUseAdjustment?.totalDisallowedExpenses)} of expenses as the personal-use share`,
                detail: personalUseLowConfidence
                  ? (personalUseBlockerText || 'Mixed rental/personal use triggered §280A, but explicit fair-rental days are missing, so the rental-use allocation is a guess and the output is gated to estimate-only. Enter explicit fair-rental days to confirm the allocation.')
                  : `Schedule E expenses went from ${fmtMoney(schedulePersonalUseAdjustment?.totalExpensesBefore)} to ${fmtMoney(schedulePersonalUseAdjustment?.totalExpensesAfter)}${Number(personalUseDepreciation?.disallowed || 0) > 0 ? `, and ${fmtMoney(personalUseDepreciation?.disallowed)} of depreciation was prorated out` : ''}. The personal share of mortgage interest and property taxes may still be deductible on Schedule A.`,
                meta: '§280A mixed-use limit',
                tone: (personalUseLowConfidence ? 'rose' : 'amber') as 'rose' | 'amber',
              }]
            : []),
          {
            title: `${fmtMoney(taxLiability?.taxes?.federal || 0)} federal · ${fmtMoney(taxLiability?.taxes?.state || 0)} state · ${fmtMoney(taxLiability?.taxes?.niit || 0)} NIIT`,
            detail: 'This is the gross liability stack before credits and withholding are netted against it.',
            meta: 'tax layers',
          },
          ...stateTaxLayerNotes,
        ],
      },
      {
        label: 'Personal context and engine gaps',
        summary: 'What taxpayer-specific context is missing today, plus the biggest reasons this is still a planning engine rather than a full tax-prep system.',
        tone: taxpayerContextWarnings.length > 0 ? 'amber' : 'rose',
        items: [
          {
            title: draftFormProfile.primaryName
              ? `Primary taxpayer is ${draftFormProfile.primaryName}${draftFormProfile.spouseName ? ` with spouse ${draftFormProfile.spouseName}` : ''}`
              : 'Primary taxpayer name is not populated',
            detail: draftFormProfile.mailingStreet || draftFormProfile.mailingCity || draftFormProfile.mailingZip
              ? `Mailing address snapshot: ${[draftFormProfile.mailingStreet, draftFormProfile.mailingCity, draftFormProfile.mailingState || homeState, draftFormProfile.mailingZip].filter(Boolean).join(', ')}.`
              : 'No mailing address is attached to the taxpayer planning profile yet.',
            meta: draftFormProfile.tinLast4 ? `TIN last four ${draftFormProfile.tinLast4}` : 'TIN tie-out incomplete',
          },
          {
            title: 'Personal-tax uploads are no longer part of this workflow',
            detail: 'This workspace now centers on taxpayer identity, Schedule E support, depreciation, 1099 readiness, and CPA packet handoff.',
            meta: 'schedule-e-first scope',
          },
          ...taxEngineGapFindings.slice(0, 5),
        ],
      },
      {
        label: 'Readiness and blockers',
        summary: 'Tax packet release blockers still visible outside the raw liability math.',
        tone: checklistBlockers.length > 0 || (next1099?.missing || 0) > 0 ? 'rose' : 'slate',
        items: [
          {
            title: `${readiness.label}${packetIntelligence?.summary ? ` · ${packetIntelligence.summary}` : ''}`,
            detail: latestRelease
              ? `Latest immutable release recorded ${fmtDate(latestRelease.createdAt || latestRelease.releasedAt)}.`
              : 'No immutable CPA packet release is recorded yet.',
            meta: snapshot?.generatedAt ? `snapshot ${fmtDate(snapshot.generatedAt)}` : 'snapshot not persisted',
          },
          {
            title: checklistBlockers.length > 0
              ? `Checklist blockers: ${checklistBlockers.slice(0, 3).map((document) => document.name).join(' · ')}`
              : 'No required-document blockers are currently visible',
            detail: checklistSummary?.nextDeadline ? `Next checklist deadline ${fmtDate(checklistSummary.nextDeadline)}.` : 'No checklist due date is currently attached.',
            meta: `${checklistBlockers.length} blocker(s)`,
          },
          {
            title: next1099
              ? `${next1099.ready} reportable vendors are ready and ${next1099.missing} still need filing info`
              : 'No reportable 1099 vendor set is currently loaded',
            detail: '1099 readiness is separate from owner personal-income context and still affects packet completeness.',
            meta: `${report1099Total ? fmtMoney(report1099Total) : fmtMoney(0)} reportable spend`,
          },
          ...(packetIntelligence?.warnings?.slice(0, 2).map((warning) => ({
            title: warning,
            detail: 'Release intelligence surfaced this as a reviewer warning in the current packet workspace.',
            meta: 'packet intelligence',
          })) || []),
        ],
      },
    ];
  }, [checklistBlockers, checklistSummary?.nextDeadline, depr.totalCurrentYearDepreciation, draftFormProfile.mailingCity, draftFormProfile.mailingState, draftFormProfile.mailingStreet, draftFormProfile.mailingZip, draftFormProfile.primaryName, draftFormProfile.spouseName, draftFormProfile.tinLast4, filingStatus, homeState, latestRelease, likelyW2Documents.length, next1099, packetIntelligence?.summary, packetIntelligence?.warnings, personalTaxUploadSummary, personalUseApplied, personalUseBlockerText, personalUseDepreciation, personalUseLowConfidence, propertyAddress, propertyId, readiness.label, report1099Total, ruleSourceDocuments, scheduleEDetail?.entryCount, scheduleELineRows, schedulePersonalUseAdjustment, schedulePreviewScope, scheduleScopeNote, scheduleSummary.totalExpenses, scheduleSummary.totalIncome, snapshot?.generatedAt, snapshot?.rulesVersion, stateTaxLayerNotes, taxEngineGapFindings, taxLiability, taxRulesPackage?.approvalStatus, taxRulesPackage?.lastReviewedAt, taxRulesPackage?.scopeSummary, taxSourceMix.hasSample, taxSourceMix.headline, taxScenarioAssumptions, year, yearSummary?.entryCount]);
  const selectedFilingExplanation = filingSnapshotExplanations.find((item) => item.id === openFilingExplanationId) || filingSnapshotExplanations[0] || null;
  const taxAuditAskContext = useMemo(() => ({
    taxYear: year,
    propertyId: propertyId || null,
    filingStatus,
    homeState: homeState || null,
    scope: propertyAddress || 'All properties',
    rulesVersion: effectiveRulesVersion,
    rulesGovernanceWarnings,
    scheduleE: {
      totalIncome: scheduleSummary.totalIncome,
      totalExpenses: scheduleSummary.totalExpenses,
      netIncomeOrLoss: scheduleSummary.netIncomeOrLoss,
      depreciation: depr.totalCurrentYearDepreciation,
      entryCount: scheduleEDetail?.entryCount ?? yearSummary?.entryCount ?? 0,
    },
    liability: taxLiability ? {
      taxableIncome: taxLiability.taxableIncome,
      deductions: taxLiability.deductions,
      taxes: taxLiability.taxes,
      rates: taxLiability.rates,
      qbi: taxLiability.qbi,
      passiveLoss: taxLiability.passiveLoss,
    } : null,
    packet: {
      readiness: snapshot?.packetReadiness || null,
      snapshotGeneratedAt: snapshot?.generatedAt || null,
      checklistBlockerCount: checklistBlockers.length,
      checklistBlockers: checklistBlockers.map((b) => ({ name: b.name, status: b.status })),
      checklistItems: checklistDocuments.map((d) => ({
        name: d.name,
        status: d.status,
        required: d.required,
        dataSource: d.dataSource,
        lenderOnFile: (d.preview as { lenderOnFile?: string } | undefined)?.lenderOnFile ?? null,
      })),
      releaseCount: releases.length,
    },
    forms1099: next1099 ? { ready: next1099.ready, missing: next1099.missing, total: next1099.total } : null,
    scenarioInputs: {
      otherIncome: effectiveScenarioInputs.otherIncome,
      withholdingYtd: effectiveScenarioInputs.withholdingYtd,
      stateWithholdingYtd: draftFormProfile.stateWithholdingYtd || null,
      otherDeductions: draftFormProfile.otherDeductions,
      taxCredits: draftFormProfile.taxCredits,
    },
    stateWithholding: taxLiability?.stateWithholding || null,
    personalUseAdjustment: taxLiability?.personalUseAdjustment || scheduleEDetail?.personalUseAdjustment || null,
  }), [checklistBlockers, checklistDocuments, depr.totalCurrentYearDepreciation, draftFormProfile.otherDeductions, draftFormProfile.stateWithholdingYtd, draftFormProfile.taxCredits, effectiveRulesVersion, effectiveScenarioInputs.otherIncome, effectiveScenarioInputs.withholdingYtd, filingStatus, homeState, next1099, propertyAddress, propertyId, releases.length, rulesGovernanceWarnings, scheduleEDetail?.entryCount, scheduleEDetail?.personalUseAdjustment, scheduleSummary.netIncomeOrLoss, scheduleSummary.totalExpenses, scheduleSummary.totalIncome, snapshot?.generatedAt, snapshot?.packetReadiness, taxLiability, year, yearSummary?.entryCount]);

  // Sub-tab navigation + AI assistant section registry
  const workspaceNav = useWorkspaceNav('tax-center', TAX_TABS, TAX_SECTIONS);
  const activeWorkspaceTab = workspaceNav.activeTab;

  const assistantLocalSummary = useMemo(() => {
    const parts: string[] = [
      `Schedule E net ${fmtMoney(scheduleSummary.netIncomeOrLoss)} for tax year ${year}`,
      `packet ${readiness.label.toLowerCase()}`,
    ];
    if (checklistBlockers.length > 0) {
      const blockerNames = checklistBlockers.map((b) => b.name).join(', ');
      parts.push(`${checklistBlockers.length} checklist blocker${checklistBlockers.length === 1 ? '' : 's'}: ${blockerNames}`);
    }
    if (next1099 && next1099.missing > 0) parts.push(`${next1099.missing} 1099 vendor${next1099.missing === 1 ? '' : 's'} missing info`);
    return `${parts.join(' · ')}.`;
  }, [checklistBlockers, next1099, readiness.label, scheduleSummary.netIncomeOrLoss, year]);

  const SCHEDULE_E_IRS_AUTHORITY: Record<string, string[]> = {
    RENT: ['IRC §61 — Gross income includes rents and royalties', 'Schedule E Part I, Line 3'],
    RENT_INCOME: ['IRC §61 — Gross income includes rents and royalties', 'Schedule E Part I, Line 3'],
    ADVERTISING: ['IRC §162 — Ordinary and necessary business expenses', 'Reg. §1.162-1(a) — Advertising', 'Schedule E Line 5'],
    AUTO_TRAVEL: ['IRC §162 — Trade or business travel expenses', 'IRC §274 — Disallowance of certain entertainment expenses', 'Schedule E Line 6'],
    CLEANING: ['IRC §162 — Repairs, maintenance and cleaning', 'Schedule E Line 7'],
    COMMISSIONS: ['IRC §162 — Commissions and fees', 'Schedule E Line 8'],
    INSURANCE: ['IRC §162(a) — Insurance premiums as ordinary business expense', 'Schedule E Line 9'],
    LEGAL_PROFESSIONAL: ['IRC §162 — Legal, professional and accounting fees', 'IRC §212 — Expenses for production of income', 'Schedule E Line 10'],
    MANAGEMENT_FEES: ['IRC §162 — Management fees and administrative costs', 'Schedule E Line 11'],
    MORTGAGE_INTEREST: ['IRC §163(h) — Qualified mortgage interest', 'Schedule E Line 12'],
    OTHER_INTEREST: ['IRC §163 — Interest deduction for business debt', 'Schedule E Line 13'],
    REPAIRS: ['IRC §162 — Repairs and maintenance (not improvements)', 'Rev. Rul. 2001-4 — Distinguishing repairs from capital improvements', 'Schedule E Line 14'],
    SUPPLIES: ['IRC §162 — Business supplies and materials', 'Schedule E Line 15'],
    TAXES: ['IRC §164 — State and local real property taxes', 'Schedule E Line 16'],
    UTILITIES: ['IRC §162 — Utility expenses', 'Schedule E Line 17'],
    DEPRECIATION: ['IRC §167 — Depreciation and cost recovery', 'IRC §168 — MACRS accelerated cost recovery', 'IRC §280A — Personal use property proration limits', 'Schedule E Line 18'],
    OTHER: ['IRC §162 — Other ordinary and necessary rental expenses', 'Schedule E Line 19'],
  };

  function getScheduleEIrsAuthority(key: string, lineName: string): string[] {
    const upper = key.toUpperCase().replace(/[^A-Z_]/g, '_');
    if (SCHEDULE_E_IRS_AUTHORITY[upper]) return SCHEDULE_E_IRS_AUTHORITY[upper];
    for (const [k, v] of Object.entries(SCHEDULE_E_IRS_AUTHORITY)) {
      if (upper.includes(k) || lineName.toUpperCase().includes(k.replace(/_/g, ' '))) return v;
    }
    return ['IRC §162 — Ordinary and necessary rental business expenses', 'Schedule E Part I'];
  }

  function getChecklistDownloadConfig(document: ChecklistDocument) {
    const docNameUpper = String(document.name || '').toUpperCase();
    if (docNameUpper.includes('SCHEDULE E')) {
      return { docType: 'schedule-e', label: 'IRS PDF', fileName: `schedule-e-${year}.pdf` };
    }
    if (docNameUpper.includes('4562') || docNameUpper.includes('DEPRECIATION')) {
      return { docType: 'form-4562', label: 'IRS PDF', fileName: `form-4562-${year}.pdf` };
    }
    if (docNameUpper.includes('1099')) {
      return { docType: '1099-nec', label: 'IRS PDF', fileName: `1099-nec-${year}.pdf` };
    }
    if (docNameUpper.includes('1098') || docNameUpper.includes('MORTGAGE')) {
      return { docType: 'form-1098', label: 'IRS PDF (draft)', fileName: `form-1098-${year}.pdf` };
    }
    if (docNameUpper.includes('PROPERTY TAX')) {
      return { docType: 'property-tax', label: 'Support PDF', fileName: `property-tax-support-${year}.pdf` };
    }
    if (docNameUpper.includes('INSURANCE')) {
      return { docType: 'insurance', label: 'Support PDF', fileName: `insurance-support-${year}.pdf` };
    }
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {propertyAddress ? `${propertyAddress} — Taxes` : 'My Taxes'}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {propertyAddress && schedulePreviewScope === 'portfolio'
                ? `Showing portfolio totals for ${year} — no entries tagged to this property yet`
                : `Tax year ${year}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={year}
              onChange={(e) => { setIsYearAutoSelected(false); setYear(parseInt(e.target.value, 10)); }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
              aria-label="Tax year"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <input
              type="text"
              value={homeState}
              onChange={(e) => setHomeState(e.target.value.toUpperCase())}
              placeholder="State (MD)"
              maxLength={2}
              className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              aria-label="Home state"
            />
            <button
              onClick={loadAll}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0 flex-1">
              <WorkspaceSubTabs nav={workspaceNav} embedded />
            </div>
            <button
              type="button"
              onClick={() => setIsTaxRulesOpen((v) => !v)}
              className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left hover:bg-slate-100"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">IRS tax rules · {year}</span>
                  {effectiveRulesVersion && (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[11px] text-emerald-700">
                      v{effectiveRulesVersion}
                    </span>
                  )}
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                    appliedRulesValidationStatus === 'passed'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
                  }`}>
                    {String(appliedRulesValidationStatus).replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {isTaxRulesOpen ? 'Tax rules and IRS sources are shown below.' : 'Open the rules used for this return.'}
                </p>
              </div>
              <span className="shrink-0 text-slate-400">{isTaxRulesOpen ? '▲' : '▼'}</span>
            </button>
          </div>
        </div>

        <div className="border-b border-slate-100">
          <FinanceAssistantHeader
            surface="tax"
            localSummary={assistantLocalSummary}
            getContext={() => taxAuditAskContext}
            nav={workspaceNav}
            embedded
            suggestions={[
              'Give me a beginner-friendly overview of this page',
              'Why is my net due this amount?',
              'What is still blocking my CPA packet?',
            ]}
            summaryRefreshKey={snapshot || taxLiability ? `${year}:${propertyId || 'all'}` : undefined}
          />
        </div>

        {isTaxRulesOpen && (
        <>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={runYearlyRulesIngestion}
            disabled={taxRulesIngesting}
            className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {taxRulesIngesting ? 'Updating rules…' : 'Refresh rules from IRS'}
          </button>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs text-slate-600">
            {String(appliedRulesRuntimeSource).replace(/_/g, ' ')}
          </span>
        </div>
        <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {appliedTaxRuleGroups.map((group) => {
              const groupSources = (group.sourceDocumentIds || [])
                .map((sourceId) => ruleSourceDocumentById[sourceId])
                .filter(Boolean);
              const groupAudit = sourceRuleAuditByGroupId[group.id] as SourceRuleAuditRecord | null;
              const usage = ruleUsageByGroupId[group.id];
              const auditPassed = groupAudit && ['passed', 'corrected'].includes(String(groupAudit.status));

              return (
                <div key={group.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium text-slate-900">{group.label}</div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      group.status === 'applied'
                        ? 'border-emerald-200 bg-white text-emerald-700'
                        : 'border-amber-200 bg-white text-amber-800'
                    }`}>
                      {String(group.status).replace(/_/g, ' ')}
                    </span>
                  </div>
                  {group.summary && (
                    <div className="mt-1 text-xs leading-relaxed text-slate-600">{group.summary}</div>
                  )}
                  {group.details && group.details.length > 0 && (
                    <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                      {group.details
                        .filter((detail) => detail.value !== null && detail.value !== undefined && detail.value !== '')
                        .map((detail) => (
                          <div key={`${group.id}-${detail.label}`} className="flex justify-between gap-2">
                            <span>{detail.label}</span>
                            <span className="text-right font-medium text-slate-700">{String(detail.value)}</span>
                          </div>
                        ))}
                    </div>
                  )}
                  {usage && (
                    <div className="mt-2 rounded-lg border border-slate-100 bg-white px-2 py-1.5 text-[11px] leading-relaxed text-slate-600">
                      <span className="font-semibold text-slate-700">Used by:</span> {usage}
                    </div>
                  )}
                  {groupAudit && (
                    <div className={`mt-2 rounded-lg border px-2 py-1.5 text-[11px] leading-relaxed ${
                      auditPassed
                        ? 'border-emerald-100 bg-emerald-50 text-emerald-800'
                        : 'border-amber-100 bg-amber-50 text-amber-800'
                    }`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">Source audit</span>
                        <span className="font-semibold uppercase tracking-wider">{String(groupAudit.status || 'unknown').replace(/_/g, ' ')}</span>
                      </div>
                      {groupAudit.sourceTitle && (
                        <div className="mt-1 text-slate-600">
                          Source: {groupAudit.sourceTitle}
                        </div>
                      )}
                      {typeof groupAudit.expectedAmountCount === 'number' && (
                        <div className="mt-1 text-slate-600">
                          Matched amounts: {groupAudit.matchedAmountCount || 0}/{groupAudit.expectedAmountCount}
                        </div>
                      )}
                      {typeof groupAudit.extractedThreshold === 'number' && (
                        <div className="mt-1 text-slate-600">
                          Source value: ${groupAudit.extractedThreshold.toLocaleString('en-US')}
                          {typeof groupAudit.candidateThreshold === 'number' ? ` · candidate $${groupAudit.candidateThreshold.toLocaleString('en-US')}` : ''}
                        </div>
                      )}
                      {groupAudit.evidence && (
                        <div className="mt-1 line-clamp-3 text-slate-600">
                          Evidence: {groupAudit.evidence}
                        </div>
                      )}
                    </div>
                  )}
                  {groupSources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {groupSources.map((source) => (
                        source.url ? (
                          <a
                            key={`${group.id}-${source.id}`}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:border-emerald-300 hover:text-emerald-700"
                          >
                            {source.authority} source
                          </a>
                        ) : (
                          <span
                            key={`${group.id}-${source.id}`}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600"
                          >
                            {source.authority} source
                          </span>
                        )
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
            <div className="font-semibold text-slate-900">Ruleset transparency</div>
            <div className="mt-2 space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between gap-3">
                <span>Selected tax year</span>
                <span className="font-semibold text-slate-900">{requestedRulesYear}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Active rules year</span>
                <span className={`font-semibold ${rulesYearIsFullySupported ? 'text-emerald-700' : 'text-rose-700'}`}>{activeRulesYear || 'none'}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Coverage</span>
                <span className={`text-right font-semibold ${rulesYearIsFullySupported ? 'text-emerald-700' : 'text-amber-700'}`}>{rulesCoverageStatus}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Applied groups</span>
                <span className="font-semibold text-slate-900">{appliedTaxRuleCount}/{appliedTaxRuleGroups.length}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>IRS/source docs</span>
                <span className="font-semibold text-slate-900">{ruleSourceDocuments.length}</span>
              </div>
              {rulesMetadataIsExactForYear && typeof taxRulesMetadata?.validation?.requiredSourceRuleAuditCount === 'number' && (
                <div className="flex justify-between gap-3">
                  <span>Required source audits</span>
                  <span className={`font-semibold ${
                    (taxRulesMetadata.validation.blockedSourceRuleAuditCount || 0) > 0
                      ? 'text-rose-700'
                      : 'text-emerald-700'
                  }`}>
                    {taxRulesMetadata.validation.passedSourceRuleAuditCount || 0}/{taxRulesMetadata.validation.requiredSourceRuleAuditCount || 0}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span>Last reviewed</span>
                <span className="font-semibold text-slate-900">{fmtDate((runtimeRulesPackageIsExactForYear ? taxRulesPackage?.lastReviewedAt : null) || (rulesMetadataIsExactForYear ? taxRulesMetadata?.rulesRuntime?.lastReviewedAt : null) || null)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Loaded</span>
                <span className="font-semibold text-slate-900">{fmtDate(rulesMetadataIsExactForYear ? taxRulesMetadata?.generatedAt : null)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Activation check</span>
                <span className={`font-semibold ${activationValidation?.status === 'passed' ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {activationValidation?.status ? String(activationValidation.status).replace(/_/g, ' ') : 'not run'}
                </span>
              </div>
              {activationValidation?.sourceCoverage && (
                <div className="flex justify-between gap-3">
                  <span>IRS docs validated</span>
                  <span className="font-semibold text-slate-900">{activationValidation.sourceCoverage.irsDocumentCount ?? 0}</span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span>Edge-case review</span>
                <span className={`font-semibold ${
                  taxEdgeCaseReview?.status === 'clear'
                    ? 'text-emerald-700'
                    : taxEdgeCaseReview?.status
                      ? 'text-amber-700'
                      : 'text-slate-500'
                }`}>
                  {taxEdgeCaseReview?.status ? String(taxEdgeCaseReview.status).replace(/_/g, ' ') : 'pending'}
                </span>
              </div>
              {taxEdgeCaseReview?.provider && (
                <div className="flex justify-between gap-3">
                  <span>Reviewer</span>
                  <span className="font-semibold text-slate-900">{String(taxEdgeCaseReview.provider).replace(/_/g, ' ')}</span>
                </div>
              )}
            </div>
            {(edgeCaseBlockers.length > 0 || edgeCaseQuestions.length > 0 || activationBlockers.length > 0 || activationWarnings.length > 0 || rulesGovernanceWarnings.length > 0) && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {edgeCaseBlockers[0] || edgeCaseQuestions[0] || activationBlockers[0] || activationWarnings[0] || rulesGovernanceWarnings[0]}
              </div>
            )}
            {taxEdgeCaseReview?.summary && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                {taxEdgeCaseReview.summary}
              </div>
            )}
            {taxRulesIngestion && (
              <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                taxRulesIngestion.ok === false
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : taxRulesIngestion.status === 'activated'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}>
                Rules ingestion {String(taxRulesIngestion.status || 'completed').replace(/_/g, ' ')}
                {taxRulesIngestion.extraction?.provider ? ` via ${String(taxRulesIngestion.extraction.provider).replace(/_/g, ' ')}` : ''}
                {taxRulesIngestion.fixtureGate?.status ? ` · fixture gate ${String(taxRulesIngestion.fixtureGate.status).replace(/_/g, ' ')}` : ''}
                {taxRulesIngestion.extractionGate?.reason ? ` · ${taxRulesIngestion.extractionGate.reason}` : ''}
              </div>
            )}
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Source documents</div>
              <div className="mt-2 space-y-2">
                {ruleSourceDocuments.slice(0, 7).map((source) => (
                  <div key={source.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      {source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-semibold text-slate-800 hover:text-emerald-700"
                        >
                          {source.title}
                        </a>
                      ) : (
                        <span className="text-xs font-semibold text-slate-800">{source.title}</span>
                      )}
                      <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500">
                        {source.authority}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Reviewed {fmtDate(source.lastReviewedAt)}{source.pageUpdatedAt ? ` · page updated ${fmtDate(source.pageUpdatedAt)}` : ''}
                    </div>
                  </div>
                ))}
                {ruleSourceDocuments.length === 0 && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    No source documents are attached to the active runtime package.
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ruleset history</div>
                <span className="text-[11px] text-slate-500">{taxRulesetHistory.length} version(s)</span>
              </div>
              <div className="mt-2 space-y-2">
                {taxRulesetHistory.slice(0, 5).map((record, index) => (
                  <div key={`${record.taxRulesetId || record.rulesVersion || 'rules'}-${index}`} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-800">{record.rulesVersion || 'unknown'}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        record.approvalStatus === 'approved'
                          ? 'bg-emerald-100 text-emerald-700'
                          : record.approvalStatus === 'validation_failed'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}>
                        {String(record.approvalStatus || 'unknown').replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {record.approvedAt ? `Activated ${fmtDate(record.approvedAt)}` : record.createdAt ? `Created ${fmtDate(record.createdAt)}` : 'No timestamp'}
                    </div>
                  </div>
                ))}
                {taxRulesetHistory.length === 0 && (
                  <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    No persisted ruleset history loaded yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        </>
        )}
      </Card>

      <div className={isAuditRailOpen ? 'grid grid-cols-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)] xl:items-start' : ''}>
        {isAuditRailOpen && (
          <FinanceAuditRail
            title="Tax audit snapshot"
            subtitle="Reviewer-facing audit view across rule sources, modeled liability, deduction layers, estimate assumptions, and missing personal-tax context."
            disclaimer="AI-assisted audit guidance only. Confirm taxpayer context, Schedule E support, uploaded personal tax forms, and official filings before relying on this for filing or legal decisions."
            statusLabel={taxAuditStatus.label}
            statusTone={taxAuditStatus.tone}
            statusDetail={taxAuditStatus.detail}
            statusMeta={[
              propertyAddress ? propertyAddress : 'All properties',
              `Tax year ${year}`,
              effectiveRulesVersion ? `rules ${effectiveRulesVersion}` : 'rules not loaded',
            ]}
            metrics={taxAuditMetrics}
            flags={taxAuditFlags}
            sections={taxAuditSections}
            rules={auditRulesSources}
            rulesLoading={auditRulesLoading}
            attachedRulesVersion={effectiveRulesVersion}
            ask={{
              surface: 'tax',
              getContext: () => taxAuditAskContext,
              suggestions: [
                'Why is my net due this amount?',
                `Are these rules current for ${year}?`,
                'What is still blocking my CPA packet?',
              ],
            }}
          />
        )}
        <div className="flex flex-col gap-4">

      {/* ----- Finance search — expert/admin only, hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionHost sectionId="finance-search" nav={workspaceNav}>
      <FinanceSearchWorkspace
        title="Global finance search"
        subtitle="Search supporting receipts, OCR text, packet evidence, and linked finance documents with the same property and tax-year scope as this tax workspace."
        propertyId={propertyId}
        year={year}
        indexedCount={packetIntelligence?.sourceMetrics.totalEvidence ?? 0}
        pendingCount={Math.max(0, (packetIntelligence?.sourceMetrics.totalEvidence ?? 0) - (packetIntelligence?.sourceMetrics.processedEvidenceCount ?? 0))}
        presetQueries={['schedule e support', '1099 w-9', 'packet release', 'estimated tax']}
        placeholder="Search Schedule E support, packet evidence, 1099 docs, or OCR text"
      />
      </SectionHost>
      </div>

      {/* ----- Filing cockpit — expert/admin only, hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionHost sectionId="filing-cockpit" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="A quick summary of where your taxes stand: rental income, estimated taxes, and what still needs attention before you hand off to your CPA."
          title="Your tax summary"
          subtitle="One CPA handoff view for packet readiness, 1099 completion, checklist blockers, and immutable release state."
          right={<span className="text-xs text-slate-500">{filingCockpitItems.length} active handoff items</span>}
        />
        <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-4">
          <Stat
            label="Packet readiness"
            value={readiness.label}
            hint={snapshot?.rulesVersion ? `rules ${snapshot.rulesVersion}` : 'No rules version loaded'}
            active={openFilingExplanationId === 'packet-readiness'}
            onClick={() => setOpenFilingExplanationId((current) => current === 'packet-readiness' ? '' : 'packet-readiness')}
          />
          <Stat
            label="1099 readiness"
            value={next1099 ? `${next1099.ready}/${next1099.total}` : '0/0'}
            hint={next1099 ? `${next1099.missing} missing info` : 'No reportable 1099 vendors'}
            active={openFilingExplanationId === '1099-readiness'}
            onClick={() => setOpenFilingExplanationId((current) => current === '1099-readiness' ? '' : '1099-readiness')}
          />
          <Stat
            label="Checklist blockers"
            value={String(checklistBlockers.length)}
            hint={checklistSummary?.nextDeadline ? `Next deadline ${fmtDate(checklistSummary.nextDeadline)}` : 'No required-document deadline loaded'}
            active={openFilingExplanationId === 'checklist-blockers'}
            onClick={() => setOpenFilingExplanationId((current) => current === 'checklist-blockers' ? '' : 'checklist-blockers')}
          />
          <Stat
            label="Immutable releases"
            value={String(releases.length)}
            hint={latestRelease ? `Latest ${fmtDate(latestRelease.createdAt || latestRelease.releasedAt)}` : 'No packet release yet'}
            active={openFilingExplanationId === 'immutable-releases'}
            onClick={() => setOpenFilingExplanationId((current) => current === 'immutable-releases' ? '' : 'immutable-releases')}
          />
        </div>
        {selectedFilingExplanation && openFilingExplanationId && (
          <div className="border-t border-slate-100 px-5 py-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="font-medium text-slate-900">{selectedFilingExplanation.title}</div>
              <div className="mt-1 text-sm text-slate-600">{selectedFilingExplanation.detail}</div>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
              <ul className="mt-2 space-y-2 text-xs text-slate-600">
                {selectedFilingExplanation.citations.map((citation, index) => (
                  <li key={`selected-filing-citation-${index}`} className="rounded-lg border border-white bg-white px-3 py-2">
                    {citation}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Current handoff queue</div>
            <ul className="space-y-3">
              {filingCockpitItems.length === 0 && (
                <li className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  Tax packet controls are currently reading as ready for handoff from this cockpit.
                </li>
              )}
              {filingCockpitItems.map((item) => (
                <li key={item.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${filingLaneClass(item.lane)}`}>
                      {item.lane}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-900">{item.title}</div>
                      <div className="mt-1 text-sm text-slate-600">{item.detail}</div>
                      {item.meta && <div className="mt-1 text-[11px] text-slate-400">{item.meta}</div>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">CPA handoff status</div>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <div className="flex items-center justify-between gap-3">
                  <span>Snapshot</span>
                  <span className="font-medium text-slate-900">{snapshot?.generatedAt ? fmtDate(snapshot.generatedAt) : 'Not generated yet'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Release history</span>
                  <span className="font-medium text-slate-900">{latestRelease ? fmtDate(latestRelease.createdAt || latestRelease.releasedAt) : 'No release'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Packet intelligence</span>
                  <span className="font-medium text-slate-900">{packetIntelligence ? humanizeStatus(packetIntelligence.readinessStatus) : 'Not loaded'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Next tax deadline</span>
                  <span className="font-medium text-slate-900">{fmtDate(checklistSummary?.nextDeadline)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Readiness signals</div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-white bg-white px-3 py-3 text-xs">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Checklist</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{checklistSummary?.ready || 0}</div>
                  <div className="mt-1 text-slate-500">ready of {checklistSummary?.required || 0} required</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3 text-xs">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">1099 total</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(report1099Total)}</div>
                  <div className="mt-1 text-slate-500">contractor payments in scope</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3 text-xs">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Evidence</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{packetIntelligence?.sourceMetrics.processedEvidenceCount ?? 0}</div>
                  <div className="mt-1 text-slate-500">digitized of {packetIntelligence?.sourceMetrics.totalEvidence ?? 0}</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Why release is blocked</div>
              <div className="mt-1 text-xs text-slate-500">
                Citation-first explanation from packet readiness, checklist blockers, 1099 gaps, and release intelligence.
              </div>
              <div className="mt-3 space-y-2">
                {releaseBlockerReasons.length === 0 ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
                    No active blocker explanation is currently in force from the loaded packet controls.
                  </div>
                ) : (
                  releaseBlockerReasons.map((reason) => (
                    <div key={`${reason.label}-${reason.detail}`} className="rounded-lg border border-white bg-white px-3 py-3 text-sm">
                      <div className="font-medium text-slate-900">{reason.label}</div>
                      <div className="mt-1 text-slate-600">{reason.detail}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </Card>
      </SectionHost>

      </div>

      {/* ----- My Taxes tab: 2-column layout ----- */}
      <div className={activeWorkspaceTab === 'overview' ? 'grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start' : 'hidden'}>

        {/* LEFT: income/expense table */}
        <div className="space-y-5">
          {/* Summary stats strip */}
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Schedule E — {year}</div>
              <h3 className="mt-1 text-lg font-semibold text-slate-900">Income &amp; expenses</h3>
              <p className="mt-0.5 text-sm text-slate-500">From transactions recorded in your ledger. Share with your CPA to prepare your return.</p>
            </div>
            <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
              {[
                { label: 'Rental income', value: fmtMoney(scheduleSummary.totalIncome), sub: 'Line 3', explain: scheduleStatExplanations['rental-income'] },
                { label: 'Total expenses', value: fmtMoney(scheduleSummary.totalExpenses), sub: 'Lines 5–19', explain: scheduleStatExplanations['total-expenses'] },
                { label: 'Depreciation', value: fmtMoney(depr.totalCurrentYearDepreciation), sub: `${depr.assetCount || 0} assets`, explain: scheduleStatExplanations.depreciation },
                {
                  label: 'Net income / loss',
                  value: fmtMoney(scheduleSummary.netIncomeOrLoss),
                  sub: (scheduleSummary.netIncomeOrLoss || 0) >= 0 ? 'Schedule E line 26' : 'Passive loss rules apply',
                  highlight: true,
                  explain: scheduleStatExplanations['net-income'],
                },
              ].map((s) => (
                <div key={s.label} className={`relative bg-white px-5 py-4 ${s.highlight ? 'xl:col-span-1' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{s.label}</div>
                    <MetricExplainButton
                      surface="tax"
                      metricId={s.explain.metricId}
                      label={s.label}
                      value={s.value}
                      detail={s.explain.detail}
                      citations={s.explain.citations}
                    />
                  </div>
                  <div className={`mt-1 text-2xl font-bold tabular-nums ${s.highlight && (scheduleSummary.netIncomeOrLoss || 0) < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{s.value}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{s.sub}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Line-by-line expense table */}
          <SectionHost sectionId="schedule-e-summary" nav={workspaceNav}>
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Expense breakdown</div>
              <h3 className="mt-1 text-base font-semibold text-slate-900">Every line item — click to see transactions</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-2.5">Category</th>
                    <th className="px-5 py-2.5 text-right">Amount</th>
                    <th className="px-5 py-2.5 text-right">Transactions</th>
                    <th className="px-5 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {scheduleELineRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-400">
                        No expense lines recorded yet for {year}.
                      </td>
                    </tr>
                  )}
                  {scheduleELineRows.map(([key, line]) => {
                    const open = openScheduleLine === key;
                    const evidenceState = lineEvidence[key];
                    const lineExplanation = buildScheduleLineExplanation(line, evidenceState);
                    return (
                      <React.Fragment key={key}>
                        <tr className="border-t border-slate-100 hover:bg-slate-50/50">
                          <td className="px-5 py-3 font-medium text-slate-900">
                            {line.name}
                            {line.line && <span className="ml-2 text-[11px] font-normal text-slate-400">Line {line.line}</span>}
                          </td>
                          <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-900">{fmtMoney(line.amount)}</td>
                          <td className="px-5 py-3 text-right text-slate-500">{line.entries.length}</td>
                          <td className="px-5 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => toggleScheduleLine(key, line.entries)}
                              className="text-xs font-medium text-sky-600 hover:text-sky-800"
                            >
                              {open ? 'Hide' : 'View'}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-t border-slate-100 bg-slate-50">
                            <td colSpan={4} className="px-5 py-3">
                              {lineExplanation.checkpoints.length > 0 && (
                                <div className="mb-2 space-y-1.5">
                                  {lineExplanation.checkpoints.slice(0, 2).map((checkpoint, index) => (
                                    <p key={`${key}-checkpoint-${index}`} className="text-xs text-slate-600">{checkpoint}</p>
                                  ))}
                                </div>
                              )}
                              {line.entries.length > 0 ? (
                                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                                  <table className="w-full text-xs">
                                    <thead className="bg-slate-50 text-left uppercase tracking-wider text-slate-500">
                                      <tr>
                                        <th className="px-3 py-2">Date</th>
                                        <th className="px-3 py-2">Description</th>
                                        <th className="px-3 py-2 text-right">Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {line.entries.slice(0, 10).map((entry, idx) => (
                                        <tr key={`${key}-entry-${idx}`} className="border-t border-slate-100">
                                          <td className="px-3 py-1.5 text-slate-500">{entry.date || '—'}</td>
                                          <td className="px-3 py-1.5 text-slate-700">{entry.description || entry.memo || '—'}</td>
                                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-900">{fmtMoney(entry.amount)}</td>
                                        </tr>
                                      ))}
                                      {line.entries.length > 10 && (
                                        <tr className="border-t border-slate-100">
                                          <td colSpan={3} className="px-3 py-1.5 text-center text-slate-400">
                                            +{line.entries.length - 10} more transactions
                                          </td>
                                        </tr>
                                      )}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <p className="text-xs text-slate-400">No individual entries available for this line.</p>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                  <tr>
                    <td className="px-5 py-3 font-semibold text-slate-700">Net income / loss</td>
                    <td className={`px-5 py-3 text-right text-base font-bold tabular-nums ${(scheduleSummary.netIncomeOrLoss || 0) < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                      {fmtMoney(scheduleSummary.netIncomeOrLoss)}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
          </SectionHost>
        </div>

        {/* RIGHT: chart + document checklist preview */}
        <div className="space-y-5">
          <SectionHost sectionId="tax-analytics" nav={workspaceNav}>
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Breakdown</div>
              <h3 className="mt-1 text-base font-semibold text-slate-900">Where the money went</h3>
            </div>
            <div className="p-5">
              <ScheduleELineCompositionChart rows={scheduleELineRows} />
            </div>
          </Card>
          </SectionHost>
        </div>

      </div>

      {/* Hidden: modeled-liability charts — require personal tax data we no longer collect */}
      <div className="hidden">
        <LiabilityBridgeChart taxLiability={taxLiability} />
        <EffectiveRatePanel taxLiability={taxLiability} />
        {/* Schedule E waterfall — expert view */}
        <SectionHost sectionId="schedule-e-waterfall" nav={workspaceNav}><Card><ScheduleELineCompositionChart rows={scheduleELineRows} /></Card></SectionHost>
      </div>

      {/* ----- Schedule E tie-out — expert view, hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionHost sectionId="schedule-e-tieout" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="A tie-out confirms two reports of the same money agree line by line — here, each Schedule E line is proven against the posted ledger and its evidence."
          title="Schedule E tie-out"
          subtitle="Every line below is computed from posted journal entries. Expand a line to inspect the source entries behind the tax output."
          right={
            <span className="text-xs text-slate-500">
              {scheduleEDetail?.entryCount ?? yearSummary?.entryCount ?? 0} journal entries
            </span>
          }
        />
        {(personalUseApplied || personalUseLowConfidence) && (
          <div className="border-b border-slate-100 px-5 py-4">
            {personalUseLowConfidence && (
              <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-rose-300 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700">
                    §280A · low confidence
                  </span>
                  {modelingReadinessIsEstimateOnly && (
                    <span className="rounded-full border border-rose-300 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700">
                      estimate only
                    </span>
                  )}
                </div>
                <div className="mt-2">
                  {personalUseBlockerText
                    || 'The §280A rental-use allocation is low confidence because explicit fair-rental days are missing or expense entries could not be attributed to a property.'}
                </div>
                <div className="mt-1 text-xs text-rose-700">
                  Enter explicit fair-rental days (and personal-use days) on each mixed-use property record to upgrade this allocation from a 365-day default guess to a confirmed day count.
                </div>
              </div>
            )}
            {personalUseApplied && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-amber-900">Section 280A mixed-use proration applied</div>
                    <div className="mt-0.5 text-xs text-amber-800">
                      Schedule E expense deductions were reduced to the rental-use share for mixed-use properties. Rental income was not reduced.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsPersonalUseDetailOpen((value) => !value)}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-800 hover:bg-amber-100"
                    aria-expanded={isPersonalUseDetailOpen}
                  >
                    {isPersonalUseDetailOpen ? 'Hide line detail' : 'Show line detail'}
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs">
                    <div className="font-semibold uppercase tracking-wider text-amber-700">Expenses before</div>
                    <div className="mt-1 text-base font-semibold tabular-nums text-slate-900">{fmtMoney(schedulePersonalUseAdjustment?.totalExpensesBefore)}</div>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs">
                    <div className="font-semibold uppercase tracking-wider text-amber-700">Expenses after</div>
                    <div className="mt-1 text-base font-semibold tabular-nums text-slate-900">{fmtMoney(schedulePersonalUseAdjustment?.totalExpensesAfter)}</div>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs">
                    <div className="font-semibold uppercase tracking-wider text-amber-700">Disallowed (personal share)</div>
                    <div className="mt-1 text-base font-semibold tabular-nums text-rose-700">{fmtMoney(schedulePersonalUseAdjustment?.totalDisallowedExpenses)}</div>
                  </div>
                </div>
                {(schedulePersonalUseAdjustment?.properties || []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(schedulePersonalUseAdjustment?.properties || []).map((property, index) => (
                      <span
                        key={`personal-use-property-${String(property.propertyId ?? 'unknown')}-${index}`}
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          property.lowConfidence
                            ? 'border-rose-300 bg-rose-50 text-rose-800'
                            : 'border-amber-300 bg-white text-amber-900'
                        }`}
                      >
                        {property.propertyName || property.propertyId} · {Number(property.rentalUsePct || 0)}% rental use
                        {property.lowConfidence ? ' · low confidence' : ''}
                      </span>
                    ))}
                  </div>
                )}
                {isPersonalUseDetailOpen && (
                  <div className="mt-3 overflow-hidden rounded-lg border border-amber-200 bg-white">
                    <table className="w-full text-xs">
                      <thead className="bg-amber-50/60 text-left uppercase tracking-wider text-amber-700">
                        <tr>
                          <th className="px-3 py-2">Line</th>
                          <th className="px-3 py-2">Category</th>
                          <th className="px-3 py-2 text-right">Before</th>
                          <th className="px-3 py-2 text-right">After</th>
                          <th className="px-3 py-2 text-right">Disallowed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {personalUseByLineRows.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-3 py-3 text-slate-500">No per-line proration detail is attached to this Schedule E payload.</td>
                          </tr>
                        )}
                        {personalUseByLineRows.map(([key, row]) => (
                          <tr key={`pua-${key}`} className="border-t border-amber-100">
                            <td className="px-3 py-2 font-mono text-slate-600">{row.line ?? '—'}</td>
                            <td className="px-3 py-2 text-slate-900">{row.name || key}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtMoney(row.before)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-900">{fmtMoney(row.after)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-rose-700">{fmtMoney(row.disallowed)}</td>
                          </tr>
                        ))}
                        {personalUseDepreciation && Number(personalUseDepreciation.disallowed || 0) > 0 && (
                          <tr className="border-t border-amber-200 bg-amber-50/40">
                            <td className="px-3 py-2 font-mono text-slate-600">18</td>
                            <td className="px-3 py-2 text-slate-900">Depreciation (modeled liability layer)</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtMoney(personalUseDepreciation.before)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-900">{fmtMoney(personalUseDepreciation.after)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-rose-700">{fmtMoney(personalUseDepreciation.disallowed)}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {personalUseNotes.length > 0 && (
                  <ul className="mt-3 space-y-1.5 text-xs text-amber-900">
                    {personalUseNotes.map((noteText, index) => (
                      <li key={`personal-use-note-${index}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2">{noteText}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              <tr>
                <th className="px-4 py-2">Line</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Entries</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {scheduleELineRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-xs text-slate-500">
                    No non-zero Schedule E lines are currently mapped for this tax year.
                  </td>
                </tr>
              )}
              {scheduleELineRows.map(([key, line]) => {
                const open = openScheduleLine === key;
                const evidenceState = lineEvidence[key];
                const lineExplanation = buildScheduleLineExplanation(line, evidenceState);
                return (
                  <React.Fragment key={key}>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">{line.line ?? '—'}</td>
                      <td className="px-4 py-2 text-slate-900">{line.name}</td>
                      <td className="px-4 py-2 font-semibold tabular-nums text-slate-900">{fmtMoney(line.amount)}</td>
                      <td className="px-4 py-2 text-slate-600">{line.entries.length}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => toggleScheduleLine(key, line.entries)}
                          className="text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-900"
                        >
                          {open ? 'Hide entries' : 'Inspect entries'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-slate-100 bg-slate-50/80">
                        <td colSpan={5} className="px-4 py-3">
                          {lineExplanation.checkpoints.length > 0 && (
                            <div className="mb-3 space-y-1.5">
                              {lineExplanation.checkpoints.slice(0, 2).map((checkpoint, index) => (
                                <p key={`${key}-audit-checkpoint-${index}`} className="text-xs text-slate-600">{checkpoint}</p>
                              ))}
                            </div>
                          )}
                          {line.entries.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                              <table className="w-full text-xs">
                                <thead className="bg-slate-50 text-left uppercase tracking-wider text-slate-500">
                                  <tr>
                                    <th className="px-3 py-2">Date</th>
                                    <th className="px-3 py-2">Description</th>
                                    <th className="px-3 py-2">Vendor</th>
                                    <th className="px-3 py-2">Source</th>
                                    <th className="px-3 py-2 text-right">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {line.entries.slice(0, 8).map((entry, index) => (
                                    <tr key={`${key}-${entry.date}-${entry.description}-${index}`} className="border-t border-slate-100">
                                      <td className="px-3 py-2 text-slate-600">{fmtDate(entry.date)}</td>
                                      <td className="px-3 py-2 text-slate-900">{entry.description || '—'}</td>
                                      <td className="px-3 py-2 text-slate-600">{entry.vendor || '—'}</td>
                                      <td className="px-3 py-2 text-slate-600">
                                        <div>
                                          <SourceBadge source={entry.source} />
                                        </div>
                                        {entry.sourceRef && <div className="text-[10px] text-slate-400">{entry.sourceRef}</div>}
                                        {entry.financeEventType && <div className="text-[10px] text-slate-400">{entry.financeEventType}</div>}
                                      </td>
                                      <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-900">{fmtMoney(entry.amount)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {line.entries.length > 8 && (
                                <div className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                                  Showing 8 of {line.entries.length} entries contributing to this tax line.
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
                              {key === 'DEPRECIATION'
                                ? 'This line is driven by the depreciation schedule rather than direct expense transactions.'
                                : 'No direct journal entries are attached to this line.'}
                            </div>
                          )}

                          <div className="mt-3 rounded-xl border border-slate-200 bg-white">
                            <div className="border-b border-slate-100 px-4 py-3">
                              <div className="text-sm font-semibold text-slate-900">Explain this number</div>
                              <div className="mt-0.5 text-xs text-slate-500">
                                Citation-first explanation built from mapped ledger entries and linked evidence already in scope.
                              </div>
                            </div>
                            <div className="space-y-3 px-4 py-3">
                              <ul className="space-y-2 text-sm text-slate-700">
                                {lineExplanation.checkpoints.map((checkpoint, index) => (
                                  <li key={`checkpoint-${index}`}>{checkpoint}</li>
                                ))}
                              </ul>
                              <div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
                                {lineExplanation.citations.length > 0 ? (
                                  <ul className="mt-2 space-y-2 text-xs text-slate-600">
                                    {lineExplanation.citations.map((citation) => (
                                      <li key={`${citation.label}-${citation.detail}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                        <div className="font-medium text-slate-900">{citation.label}</div>
                                        <div className="mt-0.5 text-slate-500">{citation.detail}</div>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <div className="mt-2 text-xs text-slate-500">
                                    No source references or evidence citations are currently available for this line.
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 rounded-xl border border-slate-200 bg-white">
                            <div className="border-b border-slate-100 px-4 py-3">
                              <div className="text-sm font-semibold text-slate-900">Supporting evidence</div>
                              <div className="mt-0.5 text-xs text-slate-500">
                                Linked documents found from the source references or backing journal entry ids for this tax line.
                              </div>
                            </div>

                            {evidenceState?.status === 'loading' && (
                              <div className="px-4 py-3 text-sm text-slate-600">Loading supporting evidence…</div>
                            )}

                            {evidenceState?.status === 'error' && (
                              <div className="px-4 py-3 text-sm text-rose-700">{evidenceState.error || 'Evidence lookup failed.'}</div>
                            )}

                            {evidenceState?.status === 'not_configured' && (
                              <div className="px-4 py-3 text-sm text-slate-600">
                                Evidence search is not configured in this environment yet.
                              </div>
                            )}

                            {evidenceState?.status === 'loaded' && evidenceState.evidence.length === 0 && (
                              <div className="px-4 py-3 text-sm text-slate-600">
                                No linked evidence was found for the currently displayed entries.
                              </div>
                            )}

                            {evidenceState?.status === 'loaded' && evidenceState.evidence.length > 0 && (
                              <div className="divide-y divide-slate-100">
                                {evidenceState.evidence.slice(0, 6).map((item) => (
                                  <div key={item.evidenceId} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                                    <div>
                                      <div className="font-medium text-slate-900">{item.title}</div>
                                      <div className="mt-1 text-xs text-slate-500">
                                        {[item.evidenceType, item.vendorName, item.documentDate ? fmtDate(item.documentDate) : null]
                                          .filter(Boolean)
                                          .join(' · ') || 'Document metadata unavailable'}
                                      </div>
                                      {(item.externalUrl || item.storagePath) && (
                                        <div className="mt-1 text-xs text-slate-500">
                                          {item.externalUrl ? (
                                            <a href={item.externalUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-700 underline hover:text-slate-900">
                                              Open document
                                            </a>
                                          ) : null}
                                          {item.externalUrl && item.storagePath ? ' · ' : ''}
                                          {item.storagePath ? <span>Stored at {item.storagePath}</span> : null}
                                        </div>
                                      )}
                                    </div>
                                    <div className="text-right text-xs">
                                      <div className="font-medium tabular-nums text-slate-900">{fmtMoney(item.amount)}</div>
                                      <div className="mt-1 text-slate-500">{item.digitizationStatus || 'pending'}</div>
                                    </div>
                                  </div>
                                ))}
                                {evidenceState.evidence.length > 6 && (
                                  <div className="px-4 py-2 text-[11px] text-slate-500">
                                    Showing 6 of {evidenceState.evidence.length} linked evidence records.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {(line.mortgageSplitApplied || line.principalExcluded) && (
                            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                              Mortgage split logic was applied to this line.{line.principalExcluded ? ` Principal excluded: ${fmtMoney(line.principalExcluded)}.` : ''}
                            </div>
                          )}

                          {line.personalUseProrated && (
                            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                              Section 280A personal-use proration was applied to this line.
                              {Number(line.personalUseDisallowed || 0) > 0 ? ` Personal-use share excluded: ${fmtMoney(line.personalUseDisallowed)}.` : ''}
                              {' '}The excluded portion of mortgage interest and property taxes may still be deductible on Schedule A.
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Filings & Packet tab: CPA exports — moved to checklist card header ----- */}
      <div className="hidden">
      <SectionHost sectionId="cpa-exports" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Download tax documents"
          subtitle="Download your Schedule E report and CPA packet to share with your accountant."
          right={
            snapshot?.rulesVersion ? (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-700">
                rules {snapshot.rulesVersion}
              </span>
            ) : undefined
          }
        />
        <div className="px-5 pt-5">
          <FinanceSourceTruthBanner
            sourceMix={taxSourceMix}
            scopeLabel={schedulePreviewScope === 'portfolio' && propertyId ? `Export scope · ${year} · portfolio fallback` : `Export scope · ${year}`}
            note={exportSourceNote}
            compact
          />
          {multiStatePacketBlockerText && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
              <div className="font-semibold">Multi-state packet review required</div>
              <div className="mt-1 text-xs text-rose-800">
                {multiStatePacketBlockerText}
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 p-5 pt-3 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Tax software import</div>
            <div className="mt-1 text-sm text-slate-800">TXF export for TurboTax, H&R Block, and other tax software.</div>
            <button
              onClick={() => fetchDownload(() => taxClient.downloadTxf(year), `schedule-e-${year}.txf`, 'export-txf')}
              disabled={downloadBusy !== null}
              className="mt-4 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
            >
              {downloadBusy === 'export-txf' ? 'Downloading…' : 'Download TXF'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">CPA review packet</div>
            <div className="mt-1 text-sm text-slate-800">Schedule E workpaper PDF with depreciation schedule and 1099 vendor summary.</div>
            <button
              onClick={() => fetchDownload(
                () => taxClient.downloadCpaReviewPacket({
                  ...estimateParams,
                }),
                `schedule-e-report-${year}.pdf`,
                'export-pdf',
                taxSourceMix,
                () => taxClient.saveDraftFormProfile({
                  year,
                  homeState: homeState || undefined,
                  profile: draftFormProfile,
                }),
              )}
              disabled={downloadBusy !== null}
              className="mt-4 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {downloadBusy === 'export-pdf' ? 'Downloading…' : 'Download CPA PDF'}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Workpaper spreadsheets</div>
            <div className="mt-1 text-sm text-slate-800">CSV outputs for CPA review and line-item investigation.</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => fetchDownload(() => taxClient.downloadSummaryCsv(year), `schedule-e-${year}.csv`, 'export-csv')}
                disabled={downloadBusy !== null}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
              >
                {downloadBusy === 'export-csv' ? 'Downloading…' : 'Summary CSV'}
              </button>
              <button
                onClick={() => fetchDownload(() => taxClient.downloadDetailedCsv(year), `tax-entries-${year}.csv`, 'export-csv-detailed')}
                disabled={downloadBusy !== null}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {downloadBusy === 'export-csv-detailed' ? 'Downloading…' : 'Detailed CSV'}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">1099 contractor forms</div>
            <div className="mt-1 text-sm text-slate-800">
              {next1099
                ? 'Draft contractor 1099 PDFs prepared from the current ledger totals, plus access to filed copies once the e-file workflow runs.'
                : latestFiled1099?.formId
                  ? 'Filed contractor 1099 PDFs from the e-file workflow.'
                  : 'No reportable 1099 vendors are currently in scope for this tax year.'}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {next1099 ? (
                <button
                  onClick={() => fetchDownload(
                    () => taxClient.downloadDraft1099Packet(year, homeState || undefined),
                    `draft-1099-forms-${year}.pdf`,
                    'export-1099-draft',
                  )}
                  disabled={downloadBusy !== null}
                  className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-semibold text-violet-900 hover:bg-violet-100 disabled:opacity-50"
                >
                  {downloadBusy === 'export-1099-draft' ? 'Downloading…' : '1099-NEC PDF'}
                </button>
              ) : null}
              {latestFiled1099?.formId ? (
                <button
                  onClick={() => fetchDownload(
                    () => taxClient.download1099FormPdf(latestFiled1099.formId),
                    `1099-NEC-${latestFiled1099.formId}.pdf`,
                    'export-1099-latest',
                  )}
                  disabled={downloadBusy !== null}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {downloadBusy === 'export-1099-latest' ? 'Downloading…' : 'Filed 1099 PDF'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => workspaceNav.navigateToSection('vendors-1099')}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Open 1099 lane
              </button>
            </div>
            {next1099 ? (
              <div className="mt-3 text-xs text-slate-500">
                {next1099.ready} ready · {next1099.missing} missing info · {fmtMoney(report1099Total)} reportable spend
              </div>
            ) : null}
          </div>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Filings & Packet tab: 1099 vendors — shown in right column of checklist grid ----- */}
      <div className="hidden">
      {/* 1099 lane */}
      <SectionHost sectionId="vendors-1099" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="If you paid a contractor more than $2,000 during the year, you may need to send them a 1099-NEC form. We track this automatically from your ledger."
          title="Contractor payments (1099s)"
          subtitle="Contractors you paid this year. Anyone over the threshold needs a 1099-NEC sent by January 31."
          right={
            <div className="flex flex-wrap items-center gap-2">
              {next1099 && (
                <span className="text-xs text-slate-500">
                  {next1099.ready} ready · {next1099.missing} missing info · {fmtMoney(report1099Total)}
                </span>
              )}
              <button
                type="button"
                onClick={() => startVendorEdit(null)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Add vendor
              </button>
            </div>
          }
        />
        {showVendorForm && (
          <form onSubmit={saveVendor} className="grid grid-cols-1 gap-3 border-b border-slate-100 px-5 py-4 md:grid-cols-6">
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Vendor name</div>
              <input
                type="text"
                value={vendorDraft.name}
                onChange={(e) => setVendorDraft({ ...vendorDraft, name: e.target.value })}
                placeholder="Vendor or contractor name"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Type</div>
              <select
                value={vendorDraft.vendorType}
                onChange={(e) => setVendorDraft({ ...vendorDraft, vendorType: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="individual">Individual</option>
                <option value="llc">LLC</option>
                <option value="partnership">Partnership</option>
                <option value="scorp">S-Corp</option>
                <option value="ccorp">C-Corp</option>
                <option value="corporation">Corporation</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">TIN / EIN</div>
              <input
                type="text"
                value={vendorDraft.tin}
                onChange={(e) => setVendorDraft({ ...vendorDraft, tin: e.target.value })}
                placeholder={vendorDraft.vendorType === 'individual' ? 'SSN last 4 or full TIN' : 'EIN'}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex items-end gap-2 text-xs text-slate-600 md:col-span-1">
              <input
                type="checkbox"
                checked={vendorDraft.w9OnFile}
                onChange={(e) => setVendorDraft({ ...vendorDraft, w9OnFile: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="pb-1">W-9 on file</span>
            </label>
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Street address</div>
              <input
                type="text"
                value={vendorDraft.address}
                onChange={(e) => setVendorDraft({ ...vendorDraft, address: e.target.value })}
                placeholder="Mailing address"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">City</div>
              <input
                type="text"
                value={vendorDraft.city}
                onChange={(e) => setVendorDraft({ ...vendorDraft, city: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">State</div>
              <input
                type="text"
                value={vendorDraft.state}
                onChange={(e) => setVendorDraft({ ...vendorDraft, state: e.target.value.toUpperCase().slice(0, 2) })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">ZIP</div>
              <input
                type="text"
                value={vendorDraft.zip}
                onChange={(e) => setVendorDraft({ ...vendorDraft, zip: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Email</div>
              <input
                type="email"
                value={vendorDraft.email}
                onChange={(e) => setVendorDraft({ ...vendorDraft, email: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Phone</div>
              <input
                type="text"
                value={vendorDraft.phone}
                onChange={(e) => setVendorDraft({ ...vendorDraft, phone: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-6">
              <div className="mb-1 font-medium">Notes</div>
              <textarea
                value={vendorDraft.notes}
                onChange={(e) => setVendorDraft({ ...vendorDraft, notes: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2 md:col-span-6">
              <button
                type="button"
                onClick={() => {
                  setShowVendorForm(false);
                  setEditingVendorId(null);
                  setVendorDraft(createVendorDraft());
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingVendor}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {savingVendor ? 'Saving…' : editingVendorId ? 'Save vendor' : 'Create vendor'}
              </button>
            </div>
          </form>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              <tr>
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">YTD paid</th>
                <th className="px-4 py-2">W-9</th>
                <th className="px-4 py-2">TIN</th>
                <th className="px-4 py-2">1099 status</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {vendors.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-xs text-slate-500">
                    No vendors loaded.
                  </td>
                </tr>
              )}
              {vendors.map((v) => {
                const form = forms1099.find((f) => f.recipientName === v.name);
                const tin = form?.recipientTIN || (v.ein || (v.ssnLast4 ? `***-**-${v.ssnLast4}` : ''));
                const status = !form
                  ? 'below threshold'
                  : !v.w9OnFile || !tin || /missing/i.test(tin)
                  ? 'missing info'
                  : 'ready';
                const cls = status === 'ready' ? 'text-emerald-700'
                  : status === 'missing info' ? 'text-rose-700'
                  : 'text-slate-500';
                return (
                  <tr key={`vendor-${String(v.id || v.name || tin || 'unknown')}`} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-900">
                      <div>{v.name}</div>
                      {v.needsSetup && <div className="text-[11px] text-amber-700">Needs saved vendor setup</div>}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{v.vendorType || '—'}</td>
                    <td className="px-4 py-2 text-slate-900 tabular-nums">{fmtMoney(v.ytdPaid || v.ytdAmount || form?.amount || 0)}</td>
                    <td className="px-4 py-2 text-slate-700">{v.w9OnFile ? 'Yes' : 'No'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">{tin || '—'}</td>
                    <td className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider ${cls}`}>{status}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => startVendorEdit(v)}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {status === 'missing info' || v.needsSetup ? 'Fix' : 'Edit'}
                        </button>
                        {v.id && (
                          <button
                            type="button"
                            onClick={() => removeVendor(v)}
                            disabled={deletingVendorId === v.id}
                            className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                          >
                            {deletingVendorId === v.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filingHistory.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
            <div className="mb-1 font-semibold text-slate-700">Filing history</div>
            <ul className="space-y-1">
              {filingHistory.slice(0, 5).map((h, i) => (
                <li key={i} className="flex justify-between">
                  <span>{h.formType || '1099'} · {h.recipientName || h.recipientCount + ' recipients'}</span>
                  <span className="text-slate-500">{fmtDate(h.filedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      </SectionHost>
      </div>

      {/* ----- CPA Documents tab: checklist + info panel ----- */}
      <div className={activeWorkspaceTab === 'filings' ? 'grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start' : 'hidden'}>
      <SectionHost sectionId="checklist-outlook" nav={workspaceNav}>
      <Card>
        {/* Header with download buttons */}
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Document checklist</div>
              <h3 className="mt-1 text-base font-semibold text-slate-900">What your CPA needs</h3>
              {checklistSummary && (
                <p className="mt-0.5 text-sm text-slate-500">{checklistSummary.ready || 0} of {(checklistSummary.ready || 0) + (checklistSummary.actionRequired || 0)} documents ready</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                onClick={() => fetchDownload(
                  () => taxClient.downloadTxf(year),
                  `schedule-e-${year}.txf`,
                  'export-txf',
                )}
                disabled={downloadBusy !== null}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {downloadBusy === 'export-txf' ? 'Downloading…' : 'TXF'}
              </button>
              <button
                onClick={() => fetchDownload(
                  () => taxClient.downloadCpaReviewPacket({ ...estimateParams }),
                  `schedule-e-report-${year}.pdf`,
                  'export-pdf',
                  taxSourceMix,
                  () => taxClient.saveDraftFormProfile({ year, homeState: homeState || undefined, profile: draftFormProfile }),
                )}
                disabled={downloadBusy !== null}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {downloadBusy === 'export-pdf' ? 'Downloading…' : 'Download CPA PDF'}
              </button>
            </div>
          </div>
          {taxSourceMix.hasSample && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {taxSourceMix.headline} — downloads include sample-backed data until bookkeeping is fully live.
            </div>
          )}
          {multiStatePacketBlockerText && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
              <span className="font-semibold">Multi-state review required:</span> {multiStatePacketBlockerText}
            </div>
          )}
        </div>

        {/* Expandable checklist rows */}
        <ul className="divide-y divide-slate-100">
          {checklistDocuments.length === 0 && (
            <li className="px-5 py-4 text-xs text-slate-500">No required documents are flagged yet for {year}.</li>
          )}
          {checklistDocuments.map((document, index) => {
            const rowKey = `doc-${index}`;
            const isRowOpen = openChecklistRow === rowKey;
            const downloadConfig = getChecklistDownloadConfig(document);

            /* Build preview rows based on document type */
            const docNameUpper = document.name.toUpperCase();
            let previewRows: Array<{key: string; label: string; irsLine?: number | null; amount: number; entryCount?: number; entries?: ScheduleELineEntry[]; irsAuthority?: string[]}> = [];
            if (docNameUpper.includes('SCHEDULE E')) {
              previewRows = scheduleELineRows.map(([key, line]) => ({
                key,
                label: line.name,
                irsLine: line.line,
                amount: line.amount,
                entryCount: line.entries.length,
                entries: line.entries,
                irsAuthority: getScheduleEIrsAuthority(key, line.name),
              }));
            } else if (docNameUpper.includes('1099')) {
              previewRows = forms1099.map((f) => ({
                key: f.recipientName,
                label: f.recipientName,
                amount: f.amount,
                entryCount: undefined,
                irsAuthority: ['IRC §6041A — Information returns for services', '1099-NEC filing threshold: $2,000 for 2026', 'Due to contractor by January 31'],
              }));
            } else if (docNameUpper.includes('4562') || docNameUpper.includes('DEPRECIATION')) {
              previewRows = depr.assetCount ? [{
                key: 'depr-total',
                label: 'Total current-year depreciation',
                irsLine: 22,
                amount: Number(depr.totalCurrentYearDepreciation || 0),
                entryCount: Number(depr.assetCount || 0),
                irsAuthority: ['IRC §167 — Depreciation and cost recovery', 'IRC §168 — Modified Accelerated Cost Recovery System (MACRS)', 'IRC §179 — Expensing election for qualifying property', 'Form 4562 Line 22'],
              }] : [];
            } else if (docNameUpper.includes('1098') || docNameUpper.includes('MORTGAGE')) {
              const mortgagePreview = document.preview as {
                interestReported?: number;
                attomEstimatedInterest?: number;
                mortgageProperties?: Array<{
                  propertyName?: string;
                  lender?: string | null;
                  reportableInterest?: number;
                  attomEstimatedInterest?: number;
                  loanAmount?: number | null;
                  rate?: number | null;
                }>;
              } | undefined;
              const mortgageProperties = mortgagePreview?.mortgageProperties || [];
              if (mortgageProperties.length > 0) {
                previewRows = mortgageProperties.map((profile, profileIndex) => ({
                  key: `mortgage-${profileIndex}`,
                  label: profile.lender
                    ? `${profile.propertyName || 'Property'} · ${profile.lender}`
                    : (profile.propertyName || 'Property'),
                  irsLine: 12,
                  amount: Number(profile.reportableInterest || profile.attomEstimatedInterest || 0),
                  entryCount: profile.loanAmount ? 1 : undefined,
                  irsAuthority: [
                    'IRC §163(h) — Qualified residential mortgage interest',
                    'Schedule E Line 12',
                    profile.rate ? `ATTOM loan estimate at ${profile.rate}%` : 'ATTOM mortgage enrichment',
                    'Official Form 1098 is issued by the lender in January',
                  ],
                }));
              } else {
                const mortgageLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('MORTGAGE'));
                if (mortgageLine) {
                  previewRows = [{
                    key: 'mortgage-interest',
                    label: 'Mortgage interest paid (ledger)',
                    irsLine: 12,
                    amount: mortgageLine[1].amount,
                    entryCount: mortgageLine[1].entries.length,
                    entries: mortgageLine[1].entries,
                    irsAuthority: ['IRC §163(h) — Qualified residential mortgage interest', 'Schedule E Line 12', 'Form 1098 — reported by lender, deducted on Schedule E'],
                  }];
                }
              }
              if (mortgagePreview?.attomEstimatedInterest && mortgagePreview?.interestReported) {
                previewRows.push({
                  key: 'mortgage-ledger-total',
                  label: 'Ledger total (Schedule E line 12)',
                  irsLine: 12,
                  amount: Number(mortgagePreview.interestReported || 0),
                  irsAuthority: ['Bookkeeping ledger total used on Schedule E'],
                });
              }
            } else if (docNameUpper.includes('PROPERTY TAX')) {
              const taxLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('TAX'));
              if (taxLine) {
                previewRows = [{
                  key: 'property-tax',
                  label: 'Property taxes paid',
                  irsLine: 16,
                  amount: taxLine[1].amount,
                  entryCount: taxLine[1].entries.length,
                  entries: taxLine[1].entries,
                  irsAuthority: ['IRC §164 — Deduction for state and local taxes', 'Schedule E Line 16', 'Deductible in full for rental property (no SALT cap applies to Schedule E)'],
                }];
              }
            } else if (docNameUpper.includes('INSURANCE')) {
              const insLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('INSUR'));
              if (insLine) {
                previewRows = [{
                  key: 'insurance',
                  label: 'Insurance premiums',
                  irsLine: 9,
                  amount: insLine[1].amount,
                  entryCount: insLine[1].entries.length,
                  entries: insLine[1].entries,
                  irsAuthority: ['IRC §162(a) — Insurance as ordinary and necessary business expense', 'Schedule E Line 9', 'Includes landlord hazard, liability, and flood insurance'],
                }];
              }
            }

            return (
              <li key={rowKey}>
                {/* Row header — click to expand */}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50/60 transition-colors"
                  onClick={() => {
                    setOpenChecklistRow(isRowOpen ? null : rowKey);
                    if (isRowOpen) setChecklistInfoKey(null);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">{document.icon ? `${document.icon} ` : ''}{document.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>Due {fmtDate(document.dueDate)}</span>
                      {document.dataSource === 'ledger' && (
                        <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700">
                          Ledger data
                        </span>
                      )}
                      {document.dataSource === 'attom' && (
                        <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
                          ATTOM mortgage
                        </span>
                      )}
                      {(document.preview as { lenderOnFile?: string } | undefined)?.lenderOnFile && (
                        <span className="text-slate-400">· {(document.preview as { lenderOnFile?: string }).lenderOnFile}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {downloadConfig && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          fetchDownload(
                            () => taxClient.downloadTaxDocumentPdf(year, downloadConfig.docType, homeState || undefined),
                            downloadConfig.fileName,
                            `checklist-${downloadConfig.docType}`,
                          );
                        }}
                        disabled={downloadBusy !== null}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {downloadBusy === `checklist-${downloadConfig.docType}` ? 'Downloading…' : downloadConfig.label}
                      </button>
                    )}
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${checklistStatusBadge(document.status)}`}>
                      {humanizeStatus(document.status)}
                    </span>
                  </div>
                  {previewRows.length > 0 && (
                    <ChevronDown
                      size={15}
                      className={`shrink-0 text-slate-400 transition-transform duration-200 ${isRowOpen ? 'rotate-180' : ''}`}
                    />
                  )}
                </button>

                {/* Expanded preview */}
                {isRowOpen && previewRows.length > 0 && (
                  <div className="border-t border-slate-100 bg-slate-50/40 px-5 pb-4 pt-3">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      Estimated tax data — click ⓘ to see how each number was calculated
                    </div>
                    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          <tr>
                            <th className="px-4 py-2">Line item</th>
                            <th className="px-4 py-2 text-right">Amount</th>
                            {previewRows.some((r) => r.entryCount !== undefined) && (
                              <th className="px-4 py-2 text-right">Entries</th>
                            )}
                            <th className="px-4 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row) => {
                            const infoKey = `${rowKey}|${row.key}`;
                            const isInfoActive = checklistInfoKey === infoKey;
                            return (
                              <tr key={row.key} className={`border-t border-slate-100 ${isInfoActive ? 'bg-indigo-50/60' : 'hover:bg-slate-50/60'}`}>
                                <td className="px-4 py-2.5 font-medium text-slate-900">
                                  {row.label}
                                  {row.irsLine && (
                                    <span className="ml-1.5 text-[10px] font-normal text-slate-400">Line {row.irsLine}</span>
                                  )}
                                </td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtMoney(row.amount)}</td>
                                {previewRows.some((r) => r.entryCount !== undefined) && (
                                  <td className="px-4 py-2.5 text-right text-slate-500">
                                    {row.entryCount !== undefined ? row.entryCount : '—'}
                                  </td>
                                )}
                                <td className="px-4 py-2.5 text-right">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setChecklistInfoKey(isInfoActive ? null : infoKey);
                                    }}
                                    title="See how this number was calculated"
                                    className={`inline-flex items-center justify-center rounded-full w-6 h-6 transition-colors ${
                                      isInfoActive
                                        ? 'bg-indigo-600 text-white'
                                        : 'border border-slate-200 bg-white text-slate-400 hover:border-indigo-300 hover:text-indigo-600'
                                    }`}
                                  >
                                    <Info size={12} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      </SectionHost>

      {/* RIGHT COLUMN: Tax Rule Info Panel or 1099 summary */}
      <div className="space-y-4">
        {checklistInfoKey ? (() => {
          /* Parse the info key: "{rowKey}|{lineKey}" */
          const [, lineKey] = checklistInfoKey.split('|');
          const schedRow = scheduleELineRows.find(([k]) => k === lineKey);
          const contractor = forms1099.find((f) => f.recipientName === lineKey);
          const isDepr = lineKey === 'depr-total';
          const isMortgage = lineKey === 'mortgage-interest';
          const isPropertyTax = lineKey === 'property-tax';
          const isInsurance = lineKey === 'insurance';

          let panelTitle = lineKey;
          let panelAmount = 0;
          let panelIrsLine: number | null = null;
          let panelEntries: ScheduleELineEntry[] = [];
          let panelAuthority: string[] = [];
          let panelExplanation = '';
          let panelCitations: Array<{ label: string; detail: string }> = [];
          let panelEntryCount = 0;

          if (schedRow) {
            const [key, line] = schedRow;
            panelTitle = line.name;
            panelAmount = line.amount;
            panelIrsLine = line.line;
            panelEntries = line.entries;
            panelAuthority = getScheduleEIrsAuthority(key, line.name);
            panelEntryCount = line.entries.length;
            const explanation = buildScheduleLineExplanation(line, lineEvidence[key]);
            panelExplanation = explanation.checkpoints[0] || '';
            panelCitations = explanation.citations;
          } else if (contractor) {
            panelTitle = contractor.recipientName;
            panelAmount = contractor.amount;
            panelAuthority = ['IRC §6041A — Information returns for services rendered', `1099-NEC threshold: $2,000 for ${year} (raised from $600)`, 'Due to contractor by January 31 of following year', 'IRC §3406 — Backup withholding if TIN missing'];
            panelExplanation = `${fmtMoney(contractor.amount)} paid to ${contractor.recipientName}. ${contractor.w9OnFile ? 'W-9 is on file.' : 'W-9 is missing — collect before filing.'} TIN: ${contractor.recipientTIN || 'not provided'}.`;
            panelEntryCount = 1;
          } else if (isDepr) {
            panelTitle = 'Depreciation and Amortization';
            panelAmount = Number(depr.totalCurrentYearDepreciation || 0);
            panelIrsLine = 22;
            panelAuthority = SCHEDULE_E_IRS_AUTHORITY.DEPRECIATION;
            panelExplanation = `${depr.assetCount || 0} depreciable asset(s) generating ${fmtMoney(panelAmount)} of current-year depreciation using MACRS. Straight-line over useful life applies to residential structures (27.5 years).`;
            panelEntryCount = Number(depr.assetCount || 0);
          } else if (isMortgage) {
            const mLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('MORTGAGE'));
            if (mLine) {
              panelTitle = mLine[1].name;
              panelAmount = mLine[1].amount;
              panelIrsLine = 12;
              panelEntries = mLine[1].entries;
              panelEntryCount = mLine[1].entries.length;
              panelAuthority = SCHEDULE_E_IRS_AUTHORITY.MORTGAGE_INTEREST;
              const explanation = buildScheduleLineExplanation(mLine[1], lineEvidence[mLine[0]]);
              panelExplanation = explanation.checkpoints[0] || '';
              panelCitations = explanation.citations;
            }
          } else if (isPropertyTax) {
            const tLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('TAX'));
            if (tLine) {
              panelTitle = tLine[1].name;
              panelAmount = tLine[1].amount;
              panelIrsLine = 16;
              panelEntries = tLine[1].entries;
              panelEntryCount = tLine[1].entries.length;
              panelAuthority = SCHEDULE_E_IRS_AUTHORITY.TAXES;
              const explanation = buildScheduleLineExplanation(tLine[1], lineEvidence[tLine[0]]);
              panelExplanation = explanation.checkpoints[0] || '';
              panelCitations = explanation.citations;
            }
          } else if (isInsurance) {
            const iLine = scheduleELineRows.find(([key]) => key.toUpperCase().includes('INSUR'));
            if (iLine) {
              panelTitle = iLine[1].name;
              panelAmount = iLine[1].amount;
              panelIrsLine = 9;
              panelEntries = iLine[1].entries;
              panelEntryCount = iLine[1].entries.length;
              panelAuthority = SCHEDULE_E_IRS_AUTHORITY.INSURANCE;
              const explanation = buildScheduleLineExplanation(iLine[1], lineEvidence[iLine[0]]);
              panelExplanation = explanation.checkpoints[0] || '';
              panelCitations = explanation.citations;
            }
          }

          const topEntries = [...panelEntries].sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount))).slice(0, 6);

          return (
            <aside
              className="overflow-hidden rounded-2xl border border-slate-200"
              style={{background: 'radial-gradient(circle at top, rgba(99,102,241,0.12) 0%, transparent 45%), linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)'}}
            >
              <div className="flex flex-col gap-4 p-5">
                {/* Badge + close */}
                <div className="flex items-center justify-between">
                  <div className="inline-flex items-center gap-2 rounded-full border border-indigo-300/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-bold text-indigo-700">
                    <Sparkles size={13} />
                    <span>IRS Rule</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChecklistInfoKey(null)}
                    className="rounded-full p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Title + disclaimer */}
                <div>
                  <h3 className="text-base font-semibold leading-snug text-slate-900">{panelTitle}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    Tax calculation breakdown. AI-assisted — confirm with a qualified tax professional before filing.
                  </p>
                </div>

                {/* Amount card */}
                <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-lg font-bold tabular-nums text-slate-900">{fmtMoney(panelAmount)}</span>
                    {panelIrsLine && (
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-500">
                        Line {panelIrsLine}
                      </span>
                    )}
                  </div>
                  {panelExplanation && (
                    <p className="mt-2 text-xs leading-relaxed text-slate-600">{panelExplanation}</p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    {panelEntryCount > 0 && <span>{panelEntryCount} {panelEntryCount === 1 ? 'entry' : contractor ? 'vendor' : 'entries'}</span>}
                    {panelIrsLine && <span>Sch E Line {panelIrsLine}</span>}
                  </div>
                </div>

                {panelCitations.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
                    <div className="mb-2.5 text-[11px] font-extrabold uppercase tracking-widest text-slate-500">Supporting Citations</div>
                    <div className="space-y-2">
                      {panelCitations.map((citation, index) => (
                        <div key={`${citation.label}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                          <div className="text-xs font-semibold text-slate-800">{citation.label}</div>
                          <div className="mt-0.5 text-[11px] text-slate-500">{citation.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* IRS Authority */}
                <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
                  <div className="mb-2.5 text-[11px] font-extrabold uppercase tracking-widest text-slate-500">IRS Authority</div>
                  <ul className="space-y-1.5">
                    {panelAuthority.map((rule, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-slate-700">
                        <span className="mt-0.5 shrink-0 text-indigo-400">›</span>
                        <span>{rule}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Top transactions */}
                {topEntries.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
                    <div className="mb-2.5 text-[11px] font-extrabold uppercase tracking-widest text-slate-500">
                      Largest Transactions
                    </div>
                    <div className="space-y-2">
                      {topEntries.map((entry, i) => (
                        <div key={`tx-${i}`} className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-slate-800">{entry.description || 'Transaction'}</div>
                            <div className="text-[11px] text-slate-400">{entry.date || '—'}</div>
                          </div>
                          <div className="shrink-0 text-xs font-semibold tabular-nums text-slate-900">{fmtMoney(entry.amount)}</div>
                        </div>
                      ))}
                    </div>
                    {panelEntries.length > 6 && (
                      <div className="mt-2 text-[11px] text-slate-400">+{panelEntries.length - 6} more transactions in this category</div>
                    )}
                  </div>
                )}

                {/* Rules applied (from taxRulesPackage) */}
                {taxRulesPackage?.rules && (() => {
                  const searchTerms = panelTitle.toLowerCase().split(' ').filter((w) => w.length > 4);
                  const matchingRules = taxRulesPackage.rules.filter((rule: any) =>
                    searchTerms.some((term) =>
                      String(rule.name || rule.title || rule.description || '').toLowerCase().includes(term) ||
                      String(rule.category || '').toLowerCase().includes(term),
                    ),
                  ).slice(0, 3);
                  if (!matchingRules.length) return null;
                  return (
                    <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
                      <div className="mb-2.5 text-[11px] font-extrabold uppercase tracking-widest text-slate-500">Rules Applied</div>
                      <div className="space-y-2">
                        {matchingRules.map((rule: any, i: number) => (
                          <div key={i} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                            <div className="text-xs font-semibold text-slate-800">{rule.name || rule.title}</div>
                            {rule.description && <div className="mt-0.5 text-[11px] leading-relaxed text-slate-600">{String(rule.description).slice(0, 120)}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <button
                  type="button"
                  onClick={() => setChecklistInfoKey(null)}
                  className="text-center text-xs font-medium text-slate-400 hover:text-slate-700"
                >
                  ← Back to summary
                </button>
              </div>
            </aside>
          );
        })() : (
          /* Default right column: 1099 summary + download links */
          <div className="space-y-4">
            {/* 1099 mini-card */}
            {(next1099 || forms1099.length > 0) && (
              <Card>
                <div className="border-b border-slate-100 px-5 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Contractor payments</div>
                  <h3 className="mt-1 text-base font-semibold text-slate-900">1099-NEC summary</h3>
                  {next1099 && (
                    <p className="mt-0.5 text-sm text-slate-500">
                      {next1099.ready} ready · {next1099.missing} missing info · {fmtMoney(report1099Total)} total
                    </p>
                  )}
                </div>
                <ul className="divide-y divide-slate-100">
                  {forms1099.slice(0, 8).map((f) => {
                    const v = vendors.find((vd) => vd.name === f.recipientName);
                    const status = !v?.w9OnFile || !f.recipientTIN || /missing/i.test(f.recipientTIN || '') ? 'missing info' : 'ready';
                    return (
                      <li key={f.recipientName} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-slate-900">{f.recipientName}</div>
                          <div className="text-xs text-slate-500">{fmtMoney(f.amount)}</div>
                        </div>
                        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider ${status === 'ready' ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {status}
                        </span>
                      </li>
                    );
                  })}
                  {forms1099.length === 0 && (
                    <li className="px-5 py-3 text-xs text-slate-500">No reportable contractors for {year}.</li>
                  )}
                </ul>
                {forms1099.length > 8 && (
                  <div className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">
                    +{forms1099.length - 8} more contractors
                  </div>
                )}
              </Card>
            )}

            {/* Export links */}
            <Card>
              <div className="px-5 py-4">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Other exports</div>
                <div className="mt-3 space-y-2">
                  <button
                    onClick={() => fetchDownload(() => taxClient.downloadSummaryCsv(year), `schedule-e-${year}.csv`, 'export-csv')}
                    disabled={downloadBusy !== null}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span>Summary CSV</span>
                    <span className="text-xs text-slate-400">Schedule E categories</span>
                  </button>
                  <button
                    onClick={() => fetchDownload(() => taxClient.downloadDetailedCsv(year), `tax-entries-${year}.csv`, 'export-csv-detailed')}
                    disabled={downloadBusy !== null}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span>Detailed CSV</span>
                    <span className="text-xs text-slate-400">Every transaction</span>
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
      </div>

      {/* ----- Workpaper packet release — expert/admin only, hidden from landlord UI ----- */}
      <div className="hidden">
      {/* Workpaper packet release */}
      <SectionHost sectionId="workpaper-packet" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="Workpapers are the supporting schedules and evidence behind each tax-return number. Releasing the packet freezes it immutably for CPA review."
          title="Workpaper packet"
          subtitle="Drafts can be persisted any time. Releases are immutable, attested, and recorded against the active rule version."
          right={
            <span className="text-xs text-slate-500">
              {snapshot?.entryCount ?? 0} entries · {snapshot?.propertyCount ?? 0} properties · {snapshot?.vendorCount ?? 0} vendors
            </span>
          }
        />
        <div className="grid grid-cols-1 gap-5 px-5 py-4 lg:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-600">Reviewer attestation</div>
            <div className="mt-2 space-y-1.5 text-sm">
              {([
                ['workpapers_reviewed', 'Workpapers reviewed'],
                ['rules_version_reviewed', 'Rules version reviewed'],
                ['evidence_reviewed', 'Evidence reviewed'],
                ['packet_readiness_confirmed', 'Packet readiness confirmed'],
                ['reviewer_attested', 'Reviewer attested to release'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-slate-700">
                  <input
                    type="checkbox"
                    checked={(releaseChecks as any)[key]}
                    onChange={(e) => setReleaseChecks({ ...releaseChecks, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              placeholder="Optional release notes…"
              className="mt-3 h-20 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={persistDraftSnapshot}
                disabled={persistingDraft}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                {persistingDraft ? 'Saving…' : 'Persist draft + profile'}
              </button>
              <button
                onClick={releasePacket}
                disabled={releasing || readiness.label !== 'Ready for CPA review' || !packetReleaseReady}
                title={readiness.label !== 'Ready for CPA review' ? 'Snapshot must be Ready for CPA review.' : (!packetReleaseReady ? 'All reviewer attestations are required.' : '')}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {releasing ? 'Releasing…' : 'Release CPA packet'}
              </button>
            </div>
            <div className="mt-3 text-xs text-slate-500">
              Draft filing profile: {draftFormProfileUpdatedAt ? `stored ${fmtDate(draftFormProfileUpdatedAt)}` : 'not persisted yet'}.
              {' '}The current taxpayer preview inputs are saved with the draft snapshot and included in the immutable packet release.
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-600">Release history</div>
            <ul className="mt-2 space-y-2 text-sm">
              {releases.length === 0 && (
                <li className="text-xs text-slate-500">No packet releases yet for {year}.</li>
              )}
              {releases.slice(0, 6).map((rel: any, i: number) => (
                <li key={`packet-release-${String(rel.workpaperSnapshotId || rel.releaseId || rel.artifactPath || i)}`} className="rounded-md border border-slate-200 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800">{rel.packetType || rel.releaseType || 'cpa_packet'}</span>
                    <span className="text-slate-500">{fmtDate(rel.createdAt || rel.releasedAt)}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">rules {rel.rulesVersion || '—'}</div>
                  {rel.artifactPath && <div className="mt-1 break-all text-[11px] text-slate-500">artifact {rel.artifactPath}</div>}
                  {rel.notes && <div className="mt-1 text-slate-600">{rel.notes}</div>}
                </li>
              ))}
            </ul>
            {releaseHistoryStatus === 'not_configured' && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                Immutable release history is not fully configured in this local environment yet.
              </div>
            )}
          </div>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Sample tax backtest — QA/admin only, hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionHost sectionId="sample-tax-backtest" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Sample Tax Backtest"
          subtitle="Practice taxpayer source-of-truth checks for the generated Schedule E and 1099 PDFs."
          right={
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${backtestStatusClass(sampleBacktest.allPassed)}`}>
              {sampleBacktest.passed}/{sampleBacktest.total} checks passing
            </span>
          }
        />
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <div className="font-medium text-slate-900">{SAMPLE_TAX_BACKTEST.fixtureName}</div>
            <div className="mt-1 text-xs text-slate-600">
              Source of truth: {SAMPLE_TAX_BACKTEST.source}. Expected values come from the fixture-authored `taxFormTruth` block; generated values come from the current Tax Center state and export inputs.
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 text-xs text-slate-600 md:grid-cols-2">
              <div className="rounded-lg border border-white bg-white px-3 py-2">
                <div className="font-semibold uppercase tracking-wider text-slate-500">Practice filer</div>
                <div className="mt-1">{SAMPLE_TAX_BACKTEST.taxpayer}</div>
                <div>{SAMPLE_TAX_BACKTEST.profile.homeState} · {SAMPLE_TAX_BACKTEST.taxYear}</div>
              </div>
              <div className="rounded-lg border border-white bg-white px-3 py-2">
                <div className="font-semibold uppercase tracking-wider text-slate-500">Fixture source</div>
                <div className="mt-1">{SAMPLE_TAX_BACKTEST.source}</div>
                <div className="text-slate-400">Schedule E + 1099 expected values verified against ledger</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void applySampleTaxpayerBacktest()}
                disabled={applyingSampleBacktest}
                className="rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {applyingSampleBacktest ? 'Loading fixture + running backtest…' : 'Load fixture + run source-of-truth backtest'}
              </button>
              <span className="self-center text-xs text-slate-500">
                Loads the Prestwick canonical fixture ledger and compares the generated Schedule E and 1099 output against the verified fixture truth values.
              </span>
            </div>
            {year !== SAMPLE_TAX_BACKTEST.taxYear && (
              <div className="mt-2 text-xs text-amber-800">
                This fixture is for tax year {SAMPLE_TAX_BACKTEST.taxYear}. Switch the Tax Center year to {SAMPLE_TAX_BACKTEST.taxYear} before treating this as a meaningful pass/fail backtest.
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => fetchDownload(
              () => taxClient.downloadCpaReviewPacket({ ...estimateParams }),
              `schedule-e-report-${year}.pdf`,
              'backtest-schedule-e-pdf',
              taxSourceMix,
              () => taxClient.saveDraftFormProfile({
                year,
                homeState: homeState || undefined,
                profile: draftFormProfile,
              }),
            )}
            disabled={downloadBusy !== null}
            className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            {downloadBusy === 'backtest-schedule-e-pdf' ? 'Downloading…' : 'Download generated Schedule E packet'}
            <div className="mt-1 text-xs font-normal text-slate-500">Compare against Schedule E source-of-truth lines below.</div>
          </button>
          <button
            type="button"
            onClick={() => fetchDownload(
              () => taxClient.downloadDraft1099Packet(year, homeState || undefined),
              `draft-1099-forms-${year}.pdf`,
              'backtest-1099-pdf',
            )}
            disabled={downloadBusy !== null || !next1099}
            className="rounded-xl border border-violet-300 bg-violet-50 px-4 py-3 text-left text-sm font-semibold text-violet-900 hover:bg-violet-100 disabled:opacity-50"
          >
            {downloadBusy === 'backtest-1099-pdf' ? 'Downloading…' : 'Download generated 1099 packet'}
            <div className="mt-1 text-xs font-normal text-violet-800">Uses current reportable contractor rows and W-9 readiness.</div>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-900">Schedule E source of truth</div>
              <div className="mt-0.5 text-xs text-slate-500">Expected vs generated form-line values, depreciation included.</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2 text-right">Expected</th>
                    <th className="px-3 py-2 text-right">Generated</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleBacktest.scheduleRows.map((row) => (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700">{row.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(row.expected)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(row.generated)}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${backtestStatusClass(row.matches)}`}>
                          {row.matches ? 'Pass' : 'Mismatch'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-900">1099-NEC source of truth</div>
              <div className="mt-0.5 text-xs text-slate-500">Expected W-9-backed contractor forms and Box 1 amounts.</div>
            </div>
            <div className="divide-y divide-slate-100">
              {sampleBacktest.form1099Rows.map((row) => (
                <div key={row.recipientName} className="px-4 py-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{row.recipientName}</div>
                      <div className="mt-1 text-slate-500">TIN {row.generated.recipientTIN || '—'} · Box 1 {fmtMoney(row.generated.box1NonemployeeCompensation)}</div>
                      <div className="mt-1 text-slate-500">Expected Box 1 {fmtMoney(row.box1NonemployeeCompensation)} · {row.readiness}</div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${backtestStatusClass(row.matches)}`}>
                      {row.matches ? 'Pass' : 'Mismatch'}
                    </span>
                  </div>
                  {!row.matches && (
                    <div className="mt-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-rose-800">
                      Expected TIN {row.recipientTIN}, address {row.recipientAddress}, readiness {row.readiness}; generated address {row.generated.recipientAddress || 'missing'} and readiness {row.generated.readiness}.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Filings & Packet tab: filed 1099 PDFs ----- */}
      <div className={activeWorkspaceTab === 'filings' && filingHistory.length > 0 ? 'order-6 space-y-4' : 'hidden'}>
      <SectionHost sectionId="filed-1099" nav={workspaceNav}>
      {filingHistory.length > 0 && (
        <Card>
          <CardHeader
            title="Filed 1099 PDFs"
            subtitle="Download filed contractor forms directly from the tax filing workflow when a form ID is available."
          />
          <ul className="divide-y divide-slate-100">
            {filingHistory.slice(0, 8).map((filing, index) => (
              <li key={filing.formId || filing.id || index} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <div>
                  <div className="font-medium text-slate-900">{filing.recipientName || filing.formType || '1099 filing'}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{fmtDate(filing.filedAt)}{filing.confirmationNumber ? ` · confirmation ${filing.confirmationNumber}` : ''}</div>
                </div>
                {filing.formId ? (
                  <button
                    onClick={() => fetchDownload(() => taxClient.download1099FormPdf(filing.formId), `1099-NEC-${filing.formId}.pdf`, `1099-pdf-${filing.formId}`)}
                    disabled={downloadBusy !== null}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                  >
                    {downloadBusy === `1099-pdf-${filing.formId}` ? 'Downloading…' : 'Download PDF'}
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">No form PDF</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      </SectionHost>
      </div>

      {note && (
        <div className="order-last rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-700">{note}</div>
      )}
        </div>
      </div>
    </div>
  );
}
