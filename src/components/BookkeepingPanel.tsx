/**
 * BookkeepingPanel
 *
 * Plain, accounting-first bookkeeping surface for the Property Management page.
 * Backed by the canonical bookkeeping client so compatibility-route details stay out of the UI layer.
 *
 * Goals:
 *  - Normal ledger table view (date / description / category / amount / source).
 *  - Always show whether a row came from the SAMPLE feed or a real STRIPE / BANK feed.
 *  - Surface canonical pipeline state (close period, reconciliation exceptions,
 *    evidence coverage) without making the page feel abstract.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ClipboardCheck, LayoutDashboard, Repeat, Sparkles, Table2 } from 'lucide-react';
import { auth } from '../config/firebase';
import {
  getDefaultBookkeepingDateRange,
  useFirestoreBookkeeping,
  type Account,
  type Transaction,
} from '../hooks/useFirestoreBookkeeping';
import { bookkeepingClient } from '../services/canonicalBookkeepingClient';
import { taxClient } from '../services/canonicalTaxClient';
import {
  buildFinanceSourceMix,
  classifyFinanceSource,
  FinanceSourceTruthBanner,
  SourceBadge,
  type SourceKind,
} from './finance/FinanceSourceTruth';
import FinanceAuditRail, { type FinanceAuditSection } from './finance/FinanceAuditRail';
import BookkeepingAnalyticsWorkspace from './finance/BookkeepingAnalyticsWorkspace';
import MetricExplainButton from './finance/MetricExplainButton';
import FinanceSearchWorkspace from './finance/FinanceSearchWorkspace';
import BookkeepingFinanceDocuments from './BookkeepingFinanceDocuments';
import StripeBookkeepingIntegration from './StripeBookkeepingIntegration';
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

const BOOKKEEPING_TABS: WorkspaceTabDef[] = [
  {
    id: 'overview',
    label: 'Summary',
    icon: LayoutDashboard,
    accent: 'emerald',
    description: 'Income, expenses, and charts — your property finances at a glance.',
  },
  {
    id: 'ledger',
    label: 'Transactions',
    icon: Table2,
    accent: 'sky',
    description: 'Browse and add transactions to your rental property ledger.',
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: BarChart3,
    accent: 'violet',
    description: 'Download income statements, expense reports, and tax-ready summaries.',
  },
];

const BOOKKEEPING_SECTIONS: WorkspaceSectionDef[] = [
  {
    id: 'executive-overview',
    tabId: 'overview',
    title: 'Summary',
    description: 'Income, expenses, and net income for the selected period.',
    keywords: ['cash balance', 'noi', 'income', 'expenses', 'overview', 'summary'],
  },
  {
    id: 'income-expense-snapshot',
    tabId: 'overview',
    title: 'Income & expenses',
    description: 'Rental income and expenses for the selected date window.',
    keywords: ['income', 'expenses', 'net income'],
  },
  {
    id: 'analytics',
    tabId: 'overview',
    title: 'Charts',
    description: 'Visual breakdown of income and expenses over time.',
    keywords: ['chart', 'trend', 'cash flow', 'analytics', 'graph'],
  },
  {
    id: 'quick-entry',
    tabId: 'ledger',
    title: 'Add a transaction',
    description: 'Add an income or expense entry to your ledger.',
    keywords: ['manual entry', 'add transaction', 'post'],
  },
  {
    id: 'ledger-table',
    tabId: 'ledger',
    title: 'All transactions',
    description: 'Every transaction with date, description, category, and amount.',
    keywords: ['ledger', 'transactions', 'journal', 'search transactions'],
  },
  {
    id: 'report-center',
    tabId: 'reports',
    title: 'Download reports',
    description: 'Download income statements, expense summaries, and tax-ready exports.',
    keywords: ['profit and loss', 'p&l', 'balance sheet', 'report', 'download', 'export'],
  },
];

interface BookkeepingPanelProps {
  userId?: string;
  userEmail?: string;
  propertyId?: string;
  propertyAddress?: string;
  onFinanceRefresh?: () => void | Promise<void>;
  onTransactionsChange?: (transactions: Transaction[]) => void;
}

interface ClosePeriodSummary {
  periodKey: string;
  status: string;
  closedAt?: string | null;
  reopenedAt?: string | null;
}

interface ReconciliationException {
  id: string;
  reconciliationItemId?: string;
  status: string;
  matchStatus?: string | null;
  sourceSystem?: string | null;
  reason?: string | null;
  amount?: number | null;
  description?: string | null;
  occurredAt?: string | null;
  createdAt?: string | null;
  effectiveDate?: string | null;
  periodKey?: string | null;
  sourceRef?: string | null;
  notes?: string | null;
  suggestedMatch?: {
    journalEntryId?: string | null;
    sourceRef?: string | null;
    accountCode?: string | null;
    memo?: string | null;
    expectedFromAccountCode?: string | null;
    expectedToAccountCode?: string | null;
  } | null;
  matchCandidates?: Array<{
    journalEntryId: string;
    entryDate: string;
    sourceRef: string;
    memo?: string | null;
    financeEventType?: string | null;
    amount: number;
    counterpartyName?: string | null;
    dateDistanceDays?: number | null;
  }>;
  matchResolution?: {
    matchedSourceRef?: string | null;
    matchReason?: string | null;
    adjustmentEntry?: {
      debitAccountCode?: string | null;
      creditAccountCode?: string | null;
      amount?: number | null;
      entryDate?: string | null;
    } | null;
  } | null;
}

interface CloseApprovalDraft {
  approvedBy: string;
  reconciliationReviewed: boolean;
  openExceptionsResolved: boolean;
  closeAttested: boolean;
  reopenReasonApproved: boolean;
  reopenAttested: boolean;
}

interface AdjustingEntryDraft {
  entryDate: string;
  amount: string;
  debitAccountCode: string;
  creditAccountCode: string;
  memo: string;
  open: boolean;
}

interface ReconciliationEvidenceState {
  open: boolean;
  loading: boolean;
  status: string;
  error: string | null;
  evidence: FinanceEvidenceRecord[];
}

interface ClosePeriodIntelligence {
  readinessStatus: string;
  summary: string;
  blockers?: string[];
  warnings?: string[];
  recommendedActions?: string[];
  sourceMetrics?: {
    openExceptionCount?: number;
    totalExceptionCount?: number;
    totalEvidence?: number;
    processedEvidenceCount?: number;
    recentClosePeriods?: number;
    recentReopenedPeriods?: number;
  };
  canonicalStatus?: {
    closePeriods?: string;
    evidence?: string;
  };
}

interface TaxPacketReadinessSummary {
  readinessStatus?: string | null;
  score?: number | null;
  summary?: string | null;
}

interface EvidenceSummary {
  totalEvidence: number;
  evidenceTypeCounts?: Record<string, number>;
  digitizationStatusCounts?: Record<string, number>;
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
  createdAt?: string | null;
  links?: Array<{
    entityType: string;
    entityId: string;
    linkRole?: string;
  }>;
}

interface FinanceDocumentRecord {
  id: string;
  title: string;
  documentType: string;
  vendorName?: string | null;
  documentDate?: string | null;
  amount?: number | null;
  originalFileName?: string | null;
  createdAt?: string | null;
  downloadPath?: string | null;
  digitization?: {
    status?: string | null;
    summary?: string | null;
  } | null;
  evidenceShadow?: {
    status?: string | null;
    evidenceType?: string | null;
  } | null;
}

interface RecurringInvoiceTemplate {
  id: string;
  propertyId?: string | null;
  propertyAddress: string;
  tenantId?: string | null;
  tenantName: string;
  tenantEmail: string;
  amount: number;
  dueDayOfMonth: number;
  description: string;
  active: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface RentInvoiceRecord {
  id: string;
  invoiceNumber: string;
  propertyAddress: string;
  tenantName: string;
  tenantEmail: string;
  amount: number;
  dueDate: string;
  status: 'pending' | 'paid' | 'overdue';
  paidAt?: string | null;
  createdAt?: string | null;
  bookkeepingJournalEntryId?: string | null;
}

interface RentInvoiceSummary {
  total: number;
  totalAmount: number;
  paid: number;
  pending: number;
  overdue: number;
  paidAmount: number;
  pendingAmount: number;
}

interface AccountsReceivableInvoiceRecord {
  id: string;
  invoiceNumber: string;
  tenantName: string;
  propertyAddress: string;
  amount: number;
  dueDate: string;
  daysOverdue: number;
}

interface AccountsReceivableBucket {
  count: number;
  amount: number;
  invoices: AccountsReceivableInvoiceRecord[];
}

interface AccountsReceivableState {
  aging: Record<string, AccountsReceivableBucket>;
  summary: {
    totalOutstanding: number;
    totalCount: number;
    averageDaysOutstanding: number;
  };
}

interface AICategorizationSuggestion {
  index: number;
  category: string;
  confidence: number;
  reason?: string;
  accountCode?: string;
  scheduleELine?: number | null;
  type?: string;
  isDeductible?: boolean;
}

type CategorizationRuleMatchType = 'PAYEE' | 'DESCRIPTION' | 'AMOUNT' | 'CATEGORY';
type RecurringJournalFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annually';

interface CategorizationRuleRecord {
  id: string;
  ruleName: string;
  matchType: CategorizationRuleMatchType;
  matchPattern: string;
  accountCode: string;
  accountName?: string | null;
  priority?: number | null;
  propertyId?: string | null;
  isActive?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface CategorizationRuleStats {
  totalActiveRules: number;
  rulesByType: Array<{
    matchType: string;
    count: number;
  }>;
  topMatchingRules: Array<{
    ruleId: string;
    ruleName: string;
    matchType: string;
    matchCount: number;
  }>;
  totalCandidates: number;
  reviewCandidates: number;
}

interface RecurringJournalTemplateRecord {
  id: string;
  name: string;
  frequency: RecurringJournalFrequency;
  amount: number;
  accountCode: string;
  accountName?: string | null;
  offsetAccountCode: string;
  offsetAccountName?: string | null;
  memo?: string | null;
  dayOfMonth?: number | null;
  startDate: string;
  endDate?: string | null;
  nextDue?: string | null;
  lastGenerated?: string | null;
  propertyId?: string | null;
  tenantId?: string | null;
  isActive?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface RecurringJournalTemplatePreset {
  name: string;
  frequency: RecurringJournalFrequency;
  accountCode: string;
  offsetAccountCode: string;
  dayOfMonth?: number;
}

interface CloseCockpitTask {
  id: string;
  lane: 'close' | 'recon' | 'document' | 'evidence';
  title: string;
  detail: string;
  meta?: string;
  amount?: number | null;
  priority: number;
}

interface TransactionTraceState {
  status: 'idle' | 'loading' | 'loaded' | 'error' | 'not_configured';
  evidence: FinanceEvidenceRecord[];
  mode?: 'source_ref' | 'journal_entry' | 'firestore_journal_entry' | null;
  error?: string | null;
}

interface ExplanationItem {
  id: string;
  title: string;
  detail: string;
  citations: string[];
}

interface BudgetRecord {
  category?: string;
  monthlyBudget?: number;
  annualBudget?: number;
}

interface BudgetComparisonRow {
  category: string;
  monthlyBudget: number;
  annualBudget: number;
  expectedBudget: number;
  actual: number;
  variance: number;
  variancePercent: number;
  status: string;
  utilizationPercent: number;
}

interface BudgetComparisonState {
  year: number;
  month?: number | null;
  monthsElapsed?: number;
  comparison?: Record<string, BudgetComparisonRow>;
  summary?: {
    totalBudgeted: number;
    totalActual: number;
    totalVariance: number;
    overBudgetCategories: number;
    utilizationPercent: number;
  };
}

interface TrialBalanceAccountRow {
  code: string;
  name: string;
  type?: string;
  normal_side?: string;
  debits: number;
  credits: number;
  balance: number;
}

interface TrialBalanceReport {
  as_of_date: string;
  accounts: TrialBalanceAccountRow[];
  total_debits: number;
  total_credits: number;
  is_balanced: boolean;
}

interface ProfitLossLineRow {
  code: string;
  name: string;
  amount: number;
  tax_map?: string | null;
}

interface ProfitLossReport {
  period?: {
    start?: string | null;
    end?: string | null;
  };
  revenues: ProfitLossLineRow[];
  expenses: ProfitLossLineRow[];
  summary?: {
    total_revenue: number;
    total_expenses: number;
    net_income: number;
  };
}

interface BalanceSheetLineRow {
  code: string;
  name: string;
  balance: number;
}

interface BalanceSheetReport {
  as_of_date: string;
  assets: BalanceSheetLineRow[];
  liabilities: BalanceSheetLineRow[];
  equity: BalanceSheetLineRow[];
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  is_balanced: boolean;
}

const CATEGORIZATION_RULE_MATCH_TYPES: CategorizationRuleMatchType[] = ['PAYEE', 'DESCRIPTION', 'AMOUNT', 'CATEGORY'];
const RECURRING_JOURNAL_FREQUENCIES: RecurringJournalFrequency[] = ['weekly', 'monthly', 'quarterly', 'annually'];

function fmtMoney(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function fmtDate(input: string | null | undefined) {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtOrdinalDay(day: number | null | undefined) {
  const value = Number(day || 0);
  if (!value) return '—';
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
}

function getDefaultInvoiceDueDate() {
  return new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().slice(0, 10);
}

function transactionNeedsCategorizationReview(transaction: Transaction) {
  const category = String(transaction.category || 'Uncategorized');
  return !transaction.scheduleELine
    || !transaction.accountCode
    || category === 'Other Expenses'
    || category === 'Other Income'
    || category === 'Uncategorized';
}

function getMonthlyRecurringAmount(template: RecurringJournalTemplateRecord) {
  const amount = Number(template.amount || 0);
  if (template.frequency === 'weekly') return (amount * 52) / 12;
  if (template.frequency === 'quarterly') return amount / 3;
  if (template.frequency === 'annually') return amount / 12;
  return amount;
}

function formatRecurringFrequency(frequency: RecurringJournalFrequency, dayOfMonth?: number | null) {
  if (frequency === 'weekly') return 'Weekly';
  if (frequency === 'quarterly') return `Quarterly${dayOfMonth ? ` · ${fmtOrdinalDay(dayOfMonth)}` : ''}`;
  if (frequency === 'annually') return `Annually${dayOfMonth ? ` · ${fmtOrdinalDay(dayOfMonth)}` : ''}`;
  return `Monthly${dayOfMonth ? ` · ${fmtOrdinalDay(dayOfMonth)}` : ''}`;
}

function formatTaxMap(transaction: Transaction) {
  const parts = [];
  if (transaction.accountCode) parts.push(`acct ${transaction.accountCode}`);
  if (transaction.scheduleELine) parts.push(`Schedule E ${transaction.scheduleELine}`);
  return parts.join(' · ') || transaction.taxMap || null;
}

function traceStatusPillClass(status?: string | null) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed' || value === 'processed') return 'bg-emerald-100 text-emerald-900 border-emerald-300';
  if (value === 'pending') return 'bg-amber-100 text-amber-900 border-amber-300';
  return 'bg-slate-100 text-slate-700 border-slate-300';
}

function isResolvedWorkflowStatus(status?: string | null) {
  const value = String(status || '').toLowerCase();
  return value === 'stored' || value === 'updated' || value === 'persisted' || value === 'completed' || value === 'processed';
}

function formatWorkflowStatus(status?: string | null) {
  return String(status || 'pending').replace(/_/g, ' ');
}

function toComparableDate(input?: string | null) {
  if (!input) return null;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getTransactionDate(transaction: Transaction) {
  return toComparableDate(String((transaction as any).date || (transaction as any).entryDate || (transaction as any).createdAt || ''));
}

function getClosePeriodCutoff(periodKey?: string | null, closedAt?: string | null) {
  if (periodKey && /^\d{4}-\d{2}$/.test(periodKey)) {
    const [yearValue, monthValue] = periodKey.split('-').map((value) => parseInt(value, 10));
    const periodEnd = new Date(yearValue, monthValue, 0, 23, 59, 59, 999);
    if (!Number.isNaN(periodEnd.getTime())) return periodEnd;
  }
  return toComparableDate(closedAt || null);
}

function reportStatusPillClass(ok: boolean) {
  return ok
    ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
    : 'border-amber-300 bg-amber-50 text-amber-900';
}

function budgetVariancePillClass(status?: string | null) {
  return String(status || '').toLowerCase() === 'over_budget'
    ? 'border-rose-300 bg-rose-50 text-rose-900'
    : 'border-emerald-300 bg-emerald-50 text-emerald-900';
}

function financeDocumentNeedsAttention(document: FinanceDocumentRecord) {
  return !isResolvedWorkflowStatus(document.digitization?.status) || !isResolvedWorkflowStatus(document.evidenceShadow?.status);
}

function cockpitLaneClass(lane: CloseCockpitTask['lane']) {
  switch (lane) {
    case 'close':
      return 'border-amber-300 bg-amber-50 text-amber-900';
    case 'recon':
      return 'border-rose-300 bg-rose-50 text-rose-900';
    case 'document':
      return 'border-sky-300 bg-sky-50 text-sky-900';
    default:
      return 'border-indigo-300 bg-indigo-50 text-indigo-900';
  }
}

function closePeriodStatusPillClass(status?: string | null) {
  const value = String(status || '').toLowerCase();
  if (value === 'closed') return 'border-emerald-300 bg-emerald-50 text-emerald-800';
  if (value === 'reopened') return 'border-amber-300 bg-amber-50 text-amber-800';
  return 'border-slate-300 bg-slate-50 text-slate-700';
}

function closeIntelligencePillClass(status?: string | null) {
  const value = String(status || '').toLowerCase();
  if (value === 'ready') return 'border-emerald-300 bg-emerald-50 text-emerald-800';
  if (value === 'blocked') return 'border-rose-300 bg-rose-50 text-rose-800';
  if (value) return 'border-amber-300 bg-amber-50 text-amber-800';
  return 'border-slate-300 bg-slate-50 text-slate-700';
}

function createEmptyReconciliationEvidenceState(): ReconciliationEvidenceState {
  return {
    open: false,
    loading: false,
    status: 'idle',
    error: null,
    evidence: [],
  };
}

function getReconciliationExceptionId(exception: ReconciliationException) {
  return String(exception.reconciliationItemId || exception.id || '');
}

function getReconciliationExceptionStatus(exception: ReconciliationException) {
  return String(exception.matchStatus || exception.status || 'pending_review');
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] ${className}`}>{children}</div>
  );
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
  explain,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
  /** When provided, renders a small "Explain" trigger grounded in these citations. */
  explain?: { metricId: string; detail: string; citations: string[] };
}) {
  const classes = `relative rounded-xl border bg-white p-4 text-left transition ${
    active ? 'border-slate-900 shadow-sm ring-2 ring-slate-900/10' : 'border-slate-200/80'
  } ${onClick ? 'hover:-translate-y-px hover:border-slate-300 hover:shadow-sm' : ''}`;

  const explainTrigger = explain && (
    <div className="absolute right-2 top-2" onClick={(event) => event.stopPropagation()}>
      <MetricExplainButton
        surface="bookkeeping"
        metricId={explain.metricId}
        label={label}
        value={value}
        detail={explain.detail}
        citations={explain.citations}
      />
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
        <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
        {explainTrigger}
      </button>
    );
  }

  return (
    <div className={classes}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
      {explainTrigger}
    </div>
  );
}

export default function BookkeepingPanel({
  userId,
  userEmail,
  propertyId,
  propertyAddress,
  onFinanceRefresh,
  onTransactionsChange,
}: BookkeepingPanelProps) {
  const bookkeeping = useFirestoreBookkeeping();
  const defaultRange = useMemo(() => getDefaultBookkeepingDateRange(), []);
  const [range, setRange] = useState(defaultRange);
  const dashboardScope = useMemo(
    () => ({ ...range, ...(propertyId ? { propertyId } : {}) }),
    [propertyId, range],
  );

  // Canonical-pipeline data
  const [closePeriods, setClosePeriods] = useState<ClosePeriodSummary[]>([]);
  const [reconExceptions, setReconExceptions] = useState<ReconciliationException[]>([]);
  const [evidenceSummary, setEvidenceSummary] = useState<EvidenceSummary | null>(null);
  const [financeDocuments, setFinanceDocuments] = useState<FinanceDocumentRecord[]>([]);
  const [recurringTemplates, setRecurringTemplates] = useState<RecurringInvoiceTemplate[]>([]);
  const [rentInvoices, setRentInvoices] = useState<RentInvoiceRecord[]>([]);
  const [rentInvoiceSummary, setRentInvoiceSummary] = useState<RentInvoiceSummary | null>(null);
  const [accountsReceivable, setAccountsReceivable] = useState<AccountsReceivableState | null>(null);
  const [categorizationRules, setCategorizationRules] = useState<CategorizationRuleRecord[]>([]);
  const [categorizationRuleStats, setCategorizationRuleStats] = useState<CategorizationRuleStats | null>(null);
  const [recurringJournalTemplates, setRecurringJournalTemplates] = useState<RecurringJournalTemplateRecord[]>([]);
  const [recurringJournalUpcoming, setRecurringJournalUpcoming] = useState<RecurringJournalTemplateRecord[]>([]);
  const [recurringJournalPresets, setRecurringJournalPresets] = useState<Record<string, RecurringJournalTemplatePreset>>({});
  const [budgets, setBudgets] = useState<Record<string, BudgetRecord>>({});
  const [budgetComparison, setBudgetComparison] = useState<BudgetComparisonState | null>(null);
  const [trialBalanceReport, setTrialBalanceReport] = useState<TrialBalanceReport | null>(null);
  const [profitLossReport, setProfitLossReport] = useState<ProfitLossReport | null>(null);
  const [balanceSheetReport, setBalanceSheetReport] = useState<BalanceSheetReport | null>(null);
  const [taxPacketReadiness, setTaxPacketReadiness] = useState<TaxPacketReadinessSummary | null>(null);
  const [budgetEditDraft, setBudgetEditDraft] = useState<{ accountCode: string; category: string; monthlyBudget: string } | null>(null);
  const [reportCenterBusy, setReportCenterBusy] = useState(false);
  const [reportCenterNote, setReportCenterNote] = useState<string | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineNote, setPipelineNote] = useState<string | null>(null);
  const [propertyCashBalances, setPropertyCashBalances] = useState<Record<string, number>>({});
  const [recurringNote, setRecurringNote] = useState<string | null>(null);
  const [categorizationRuleNote, setCategorizationRuleNote] = useState<string | null>(null);
  const [recurringJournalNote, setRecurringJournalNote] = useState<string | null>(null);
  const [documentDownloadId, setDocumentDownloadId] = useState<string | null>(null);
  const [openTraceId, setOpenTraceId] = useState<string | null>(null);
  const [transactionTrace, setTransactionTrace] = useState<Record<string, TransactionTraceState>>({});
  const [closePeriodTarget, setClosePeriodTarget] = useState(defaultRange.endDate.slice(0, 7));
  const [closePeriodReason, setClosePeriodReason] = useState('Month-end close');
  const [closePeriodNotes, setClosePeriodNotes] = useState('');
  const [closePeriodBusy, setClosePeriodBusy] = useState(false);
  const [closeApproval, setCloseApproval] = useState<CloseApprovalDraft>({
    approvedBy: userEmail || '',
    reconciliationReviewed: false,
    openExceptionsResolved: false,
    closeAttested: false,
    reopenReasonApproved: false,
    reopenAttested: false,
  });
  const [closePeriodIntelligence, setClosePeriodIntelligence] = useState<ClosePeriodIntelligence | null>(null);
  const [closePeriodIntelligenceStatus, setClosePeriodIntelligenceStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [closePeriodIntelligenceError, setClosePeriodIntelligenceError] = useState<string | null>(null);
  const [exceptionNotes, setExceptionNotes] = useState<Record<string, string>>({});
  const [exceptionActionBusy, setExceptionActionBusy] = useState<string | null>(null);
  const [adjustingEntryDrafts, setAdjustingEntryDrafts] = useState<Record<string, AdjustingEntryDraft>>({});
  const [reconciliationEvidence, setReconciliationEvidence] = useState<Record<string, ReconciliationEvidenceState>>({});
  const [showRecurringTemplateForm, setShowRecurringTemplateForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [showCategorizationRuleForm, setShowCategorizationRuleForm] = useState(false);
  const [showRecurringJournalForm, setShowRecurringJournalForm] = useState(false);
  const [recurringTemplateBusy, setRecurringTemplateBusy] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [categorizationRuleBusy, setCategorizationRuleBusy] = useState(false);
  const [categorizationRuleApplyBusy, setCategorizationRuleApplyBusy] = useState(false);
  const [recurringJournalBusy, setRecurringJournalBusy] = useState(false);
  const [aiCategorizationBusy, setAiCategorizationBusy] = useState<'idle' | 'running'>('idle');
  const [aiCategorizationNote, setAiCategorizationNote] = useState<string | null>(null);
  const [aiCategorizationSuggestions, setAiCategorizationSuggestions] = useState<AICategorizationSuggestion[]>([]);
  const [aiCategorizationTargets, setAiCategorizationTargets] = useState<Transaction[]>([]);
  const [openExecutiveExplanationId, setOpenExecutiveExplanationId] = useState<string>('cash-balance');
  const [isAuditRailOpen, setIsAuditRailOpen] = useState(false);
  const [recurringTemplateActionId, setRecurringTemplateActionId] = useState<string | null>(null);
  const [categorizationRuleActionId, setCategorizationRuleActionId] = useState<string | null>(null);
  const [recurringJournalActionId, setRecurringJournalActionId] = useState<string | null>(null);
  const [generatingRecurringInvoices, setGeneratingRecurringInvoices] = useState(false);
  const [generatingRecurringJournalEntries, setGeneratingRecurringJournalEntries] = useState(false);
  const [invoiceActionId, setInvoiceActionId] = useState<string | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState({
    propertyAddress: propertyAddress || '',
    tenantName: '',
    tenantEmail: '',
    amount: '',
    dueDate: getDefaultInvoiceDueDate(),
    description: '',
  });
  const [recurringTemplateDraft, setRecurringTemplateDraft] = useState({
    propertyAddress: propertyAddress || '',
    tenantName: '',
    tenantEmail: '',
    amount: '',
    dueDayOfMonth: '1',
    description: 'Monthly Rent',
  });
  const [categorizationRuleDraft, setCategorizationRuleDraft] = useState({
    ruleName: '',
    matchType: 'DESCRIPTION' as CategorizationRuleMatchType,
    matchPattern: '',
    accountCode: '5000',
    priority: '100',
  });
  const [recurringJournalDraft, setRecurringJournalDraft] = useState({
    presetKey: '',
    name: '',
    frequency: 'monthly' as RecurringJournalFrequency,
    amount: '',
    accountCode: '5500',
    offsetAccountCode: '1000',
    memo: '',
    dayOfMonth: '1',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
  });

  // Quick entry
  const [entry, setEntry] = useState({
    date: new Date().toISOString().slice(0, 10),
    description: '',
    amount: '',
    type: 'expense' as 'expense' | 'income',
    categoryCode: '',
  });
  const [postingEntry, setPostingEntry] = useState(false);
  const [entryNote, setEntryNote] = useState<string | null>(null);

  // Sample data
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleNote, setSampleNote] = useState<string | null>(null);
  const [clearingSample, setClearingSample] = useState(false);
  const [clearingLive, setClearingLive] = useState(false);

  // Filters
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | SourceKind>('all');
  const [searchText, setSearchText] = useState('');
  const [sortOrder, setSortOrder] = useState<'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'>('date-desc');
  const [accountFilter, setAccountFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [vendorFilter, setVendorFilter] = useState('all');
  const [propertyFilter, setPropertyFilter] = useState<string>(propertyId || 'all');

  useEffect(() => {
    if (propertyId) {
      setPropertyFilter(propertyId);
    }
  }, [propertyId]);

  useEffect(() => {
    if (userEmail) {
      setCloseApproval((current) => (current.approvedBy ? current : { ...current, approvedBy: userEmail }));
    }
  }, [userEmail]);

  useEffect(() => {
    if (propertyAddress) {
      setInvoiceDraft((current) => (
        current.propertyAddress ? current : { ...current, propertyAddress }
      ));
      setRecurringTemplateDraft((current) => (
        current.propertyAddress ? current : { ...current, propertyAddress }
      ));
    }
  }, [propertyAddress]);

  useEffect(() => {
    if (!bookkeeping.user || bookkeeping.isInitialized) {
      return;
    }

    void bookkeeping.initialize();
  }, [bookkeeping, bookkeeping.isInitialized, bookkeeping.user]);

  // Initial fetch when initialized
  useEffect(() => {
    let cancelled = false;

    async function loadInitialWorkspace() {
      if (!bookkeeping.isInitialized || !bookkeeping.user) {
        return;
      }

      await bookkeeping.fetchData(dashboardScope);
      if (!cancelled) {
        await loadPipeline();
      }
    }

    void loadInitialWorkspace();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookkeeping.isInitialized, bookkeeping.user, propertyId, range.endDate, range.startDate]);

  useEffect(() => {
    onTransactionsChange?.(bookkeeping.transactions);
  }, [bookkeeping.transactions, onTransactionsChange]);

  useEffect(() => {
    if (!bookkeeping.user || !closePeriodTarget) {
      setClosePeriodIntelligence(null);
      setClosePeriodIntelligenceStatus('idle');
      setClosePeriodIntelligenceError(null);
      return;
    }

    loadClosePeriodIntelligence(closePeriodTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookkeeping.user, closePeriodTarget]);

  const propertyIdsInScope = useMemo(() => {
    const ids = new Set<string>();
    if (propertyId) {
      ids.add(propertyId);
    }
    for (const transaction of bookkeeping.transactions) {
      const scopedPropertyId = String(transaction.propertyId || '').trim();
      if (scopedPropertyId) {
        ids.add(scopedPropertyId);
      }
    }
    return Array.from(ids).sort();
  }, [bookkeeping.transactions, propertyId]);

  useEffect(() => {
    let cancelled = false;

    async function loadPropertyCashBalances() {
      if (!bookkeeping.user || propertyIdsInScope.length === 0) {
        if (!cancelled) {
          setPropertyCashBalances({});
        }
        return;
      }

      const balances = await Promise.all(propertyIdsInScope.map(async (scopedPropertyId) => {
        const data = await bookkeepingClient.getBalanceSheet({ as_of: range.endDate, propertyId: scopedPropertyId }).catch(() => null);
        const cashAsset = (data?.assets || []).find((asset: any) => asset.code === '1000');
        return [scopedPropertyId, Number(cashAsset?.balance || 0)] as const;
      }));

      if (!cancelled) {
        setPropertyCashBalances(Object.fromEntries(balances));
      }
    }

    void loadPropertyCashBalances();

    return () => {
      cancelled = true;
    };
  }, [bookkeeping.user, propertyIdsInScope, range.endDate]);

  async function loadPipeline() {
    if (!auth.currentUser) return;
    setPipelineLoading(true);
    try {
      const scopedParams = propertyId ? { propertyId } : {};
      const statsYear = Number(range.endDate.slice(0, 4));
      const [cpRes, exRes, evRes, docRes, recurringRes, invoiceRes, arRes, ruleRes, ruleStatsRes, recurringJournalRes, recurringUpcomingRes, recurringPresetRes, budgetsRes, budgetComparisonRes, trialBalanceRes, profitLossRes, balanceSheetRes, taxPacketRes] = await Promise.all([
        bookkeepingClient.listClosePeriods({ limit: 12 }).catch(() => null),
        bookkeepingClient.listReconciliationExceptions({ status: 'open', limit: 20 }).catch(() => null),
        bookkeepingClient.searchEvidence({ limit: 1 }).catch(() => null),
        bookkeepingClient.listFinanceDocuments({ limit: 12 }).catch(() => null),
        bookkeepingClient.listRecurringInvoiceTemplates().catch(() => null),
        bookkeepingClient.listInvoices().catch(() => null),
        bookkeepingClient.getAccountsReceivable().catch(() => null),
        bookkeepingClient.listCategorizationRules(scopedParams).catch(() => null),
        bookkeepingClient.getCategorizationRuleStats({ year: statsYear, ...scopedParams }).catch(() => null),
        bookkeepingClient.listRecurringJournalTemplates({ isActive: 'all', ...scopedParams }).catch(() => null),
        bookkeepingClient.listUpcomingRecurringJournalTemplates({ days: 45, ...scopedParams }).catch(() => null),
        bookkeepingClient.listRecurringJournalPresets().catch(() => null),
        bookkeepingClient.getBudgets().catch(() => null),
        bookkeepingClient.getBudgetVsActual({ year: statsYear }).catch(() => null),
        bookkeepingClient.getTrialBalance({ as_of: range.endDate, ...scopedParams }).catch(() => null),
        bookkeepingClient.getProfitLoss({ start: range.startDate, end: range.endDate, ...scopedParams }).catch(() => null),
        bookkeepingClient.getBalanceSheet({ as_of: range.endDate, ...scopedParams }).catch(() => null),
        taxClient.getPacketReleaseIntelligence(statsYear).catch(() => null),
      ]);
      if (cpRes?.ok || cpRes?.periods) setClosePeriods(cpRes.periods || cpRes.closePeriods || []);
      if (exRes?.ok || exRes?.exceptions) setReconExceptions(exRes.exceptions || []);
      if (evRes?.summary) setEvidenceSummary(evRes.summary);
      if (docRes?.ok || docRes?.documents) setFinanceDocuments(docRes.documents || []);
      if (recurringRes?.ok || recurringRes?.templates) setRecurringTemplates(recurringRes.templates || []);
      if (invoiceRes?.ok || invoiceRes?.invoices) setRentInvoices(invoiceRes.invoices || []);
      if (invoiceRes?.summary) setRentInvoiceSummary(invoiceRes.summary);
      if (arRes?.aging || arRes?.summary) setAccountsReceivable({
        aging: arRes.aging || {},
        summary: arRes.summary || {
          totalOutstanding: 0,
          totalCount: 0,
          averageDaysOutstanding: 0,
        },
      });
      if (ruleRes?.ok || ruleRes?.rules) setCategorizationRules(ruleRes.rules || []);
      if (ruleStatsRes?.ok || ruleStatsRes?.totalActiveRules != null) setCategorizationRuleStats(ruleStatsRes || null);
      if (recurringJournalRes?.ok || recurringJournalRes?.transactions) setRecurringJournalTemplates(recurringJournalRes.transactions || []);
      if (recurringUpcomingRes?.ok || recurringUpcomingRes?.transactions) setRecurringJournalUpcoming(recurringUpcomingRes.transactions || []);
      if (recurringPresetRes?.ok || recurringPresetRes?.templates) setRecurringJournalPresets(recurringPresetRes.templates || {});
      if (budgetsRes?.ok || budgetsRes?.budgets) setBudgets(budgetsRes.budgets || {});
      if (budgetComparisonRes?.ok || budgetComparisonRes?.comparison) setBudgetComparison(budgetComparisonRes || null);
      if (trialBalanceRes?.ok || trialBalanceRes?.accounts) setTrialBalanceReport(trialBalanceRes || null);
      if (profitLossRes?.ok || profitLossRes?.summary) setProfitLossReport(profitLossRes || null);
      if (balanceSheetRes?.ok || balanceSheetRes?.assets) setBalanceSheetReport(balanceSheetRes || null);
      if (taxPacketRes?.ok || taxPacketRes?.intelligence) setTaxPacketReadiness(taxPacketRes?.intelligence || null);
    } finally {
      setPipelineLoading(false);
    }
  }

  async function loadClosePeriodIntelligence(periodKey: string) {
    if (!auth.currentUser || !periodKey) return;

    setClosePeriodIntelligenceStatus('loading');
    setClosePeriodIntelligenceError(null);
    try {
      const data = await bookkeepingClient.getClosePeriodIntelligence(periodKey);
      if (data.ok) {
        setClosePeriodIntelligence(data.intelligence || null);
        setClosePeriodIntelligenceStatus('loaded');
      } else {
        setClosePeriodIntelligence(null);
        setClosePeriodIntelligenceStatus('error');
        setClosePeriodIntelligenceError(data.error || 'Failed to load close period intelligence.');
      }
    } catch (err: any) {
      setClosePeriodIntelligence(null);
      setClosePeriodIntelligenceStatus('error');
      setClosePeriodIntelligenceError(err?.message || 'Failed to load close period intelligence.');
    }
  }

  async function refreshOperationalWorkspace(periodKey = closePeriodTarget) {
    await bookkeeping.fetchData(dashboardScope);
    await onFinanceRefresh?.();
    await loadPipeline();
    if (periodKey) {
      await loadClosePeriodIntelligence(periodKey);
    }
  }

  async function saveBudgetDraft() {
    if (!budgetEditDraft) return;

    const monthlyBudget = Number(budgetEditDraft.monthlyBudget);
    if (!Number.isFinite(monthlyBudget) || monthlyBudget < 0) {
      setReportCenterNote('Enter a valid non-negative monthly budget.');
      return;
    }

    setReportCenterBusy(true);
    setReportCenterNote(null);
    try {
      const data = await bookkeepingClient.saveBudget({
        accountCode: budgetEditDraft.accountCode,
        category: budgetEditDraft.category,
        monthlyBudget,
        annualBudget: monthlyBudget * 12,
      });

      if (data.ok) {
        setBudgetEditDraft(null);
        setReportCenterNote(`Saved ${budgetEditDraft.category} budget at ${fmtMoney(monthlyBudget)} per month.`);
        await loadPipeline();
      } else {
        setReportCenterNote(data.error || 'Failed to save budget.');
      }
    } catch (err: any) {
      setReportCenterNote(err?.message || 'Failed to save budget.');
    } finally {
      setReportCenterBusy(false);
    }
  }

  async function initializeDefaultBudgets() {
    setReportCenterBusy(true);
    setReportCenterNote(null);
    try {
      const data = await bookkeepingClient.initializeBudgets();
      if (data.ok) {
        setReportCenterNote('Initialized default category budgets for the canonical report center.');
        await loadPipeline();
      } else {
        setReportCenterNote(data.error || 'Failed to initialize default budgets.');
      }
    } catch (err: any) {
      setReportCenterNote(err?.message || 'Failed to initialize default budgets.');
    } finally {
      setReportCenterBusy(false);
    }
  }

  async function downloadFinanceDocument(document: FinanceDocumentRecord) {
    if (!document.downloadPath) {
      setPipelineNote('This finance document does not have a downloadable file yet.');
      return;
    }

    setDocumentDownloadId(document.id);
    setPipelineNote(null);
    try {
      const blob = await bookkeepingClient.downloadOwnerFile(document.downloadPath);
      const objectUrl = window.URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = objectUrl;
      link.download = document.originalFileName || document.title;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      setPipelineNote(`Downloaded ${document.originalFileName || document.title}.`);
    } catch (err: any) {
      setPipelineNote(err?.message || 'Failed to download finance document.');
    } finally {
      setDocumentDownloadId(null);
    }
  }

  async function createRecurringTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = Number(recurringTemplateDraft.amount);
    const dueDayOfMonth = Number(recurringTemplateDraft.dueDayOfMonth);

    if (!Number.isFinite(amount) || amount <= 0) {
      setRecurringNote('Enter a valid recurring rent amount before creating a template.');
      return;
    }

    setRecurringTemplateBusy(true);
    setRecurringNote(null);
    try {
      const data = await bookkeepingClient.createRecurringInvoiceTemplate({
        propertyId: propertyId || null,
        propertyAddress: recurringTemplateDraft.propertyAddress || propertyAddress || '',
        tenantName: recurringTemplateDraft.tenantName,
        tenantEmail: recurringTemplateDraft.tenantEmail,
        amount,
        dueDayOfMonth,
        description: recurringTemplateDraft.description || 'Monthly Rent',
      });

      if (data.ok) {
        setRecurringNote(`Created recurring rent template for ${recurringTemplateDraft.tenantName || 'the selected unit'}.`);
        setShowRecurringTemplateForm(false);
        setRecurringTemplateDraft({
          propertyAddress: propertyAddress || '',
          tenantName: '',
          tenantEmail: '',
          amount: '',
          dueDayOfMonth: '1',
          description: 'Monthly Rent',
        });
        await loadPipeline();
      } else {
        setRecurringNote(data.error || 'Failed to create the recurring rent template.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to create the recurring rent template.');
    } finally {
      setRecurringTemplateBusy(false);
    }
  }

  async function runAICategorizationReview() {
    const candidates = aiCategorizationCandidates.slice(0, 25);
    if (candidates.length === 0) {
      setAiCategorizationNote('No ledger rows are available for AI categorization in the current filter window.');
      return;
    }

    setAiCategorizationBusy('running');
    setAiCategorizationNote(null);
    try {
      const data = await bookkeepingClient.categorizeTransactionsAI({
        transactions: candidates.map((transaction) => ({
          id: transaction.id,
          description: transaction.description || transaction.category || 'Unknown transaction',
          amount: transaction.amount,
          date: transaction.date,
        })),
      });

      if (data.ok && Array.isArray(data.categorizations)) {
        setAiCategorizationTargets(candidates);
        setAiCategorizationSuggestions(data.categorizations);
        setAiCategorizationNote(`Generated ${data.categorizations.length} AI categorization suggestion(s) from the current ledger window.`);
      } else {
        setAiCategorizationNote(data.error || 'Failed to run AI categorization.');
      }
    } catch (err: any) {
      setAiCategorizationNote(err?.message || 'Failed to run AI categorization.');
    } finally {
      setAiCategorizationBusy('idle');
    }
  }

  async function createCategorizationRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!categorizationRuleDraft.ruleName.trim() || !categorizationRuleDraft.matchPattern.trim() || !categorizationRuleDraft.accountCode) {
      setCategorizationRuleNote('Enter a rule name, match pattern, and target account before saving the rule.');
      return;
    }

    setCategorizationRuleBusy(true);
    setCategorizationRuleNote(null);
    try {
      const data = await bookkeepingClient.createCategorizationRule({
        ruleName: categorizationRuleDraft.ruleName.trim(),
        matchType: categorizationRuleDraft.matchType,
        matchPattern: categorizationRuleDraft.matchPattern.trim(),
        accountCode: categorizationRuleDraft.accountCode,
        priority: Number(categorizationRuleDraft.priority || 100),
        propertyId: propertyId || null,
      });

      if (data.ok) {
        const defaultAccountCode = bookkeeping.accounts.find((account) => account.type === 'EXPENSE')?.code
          || bookkeeping.accounts.find((account) => account.type === 'REVENUE')?.code
          || '5000';
        setCategorizationRuleDraft({
          ruleName: '',
          matchType: 'DESCRIPTION',
          matchPattern: '',
          accountCode: defaultAccountCode,
          priority: '100',
        });
        setShowCategorizationRuleForm(false);
        setCategorizationRuleNote(`Saved rule ${data.rule?.ruleName || categorizationRuleDraft.ruleName}.`);
        await loadPipeline();
      } else {
        setCategorizationRuleNote(data.error || 'Failed to create the categorization rule.');
      }
    } catch (err: any) {
      setCategorizationRuleNote(err?.message || 'Failed to create the categorization rule.');
    } finally {
      setCategorizationRuleBusy(false);
    }
  }

  async function applyCategorizationRules() {
    setCategorizationRuleApplyBusy(true);
    setCategorizationRuleNote(null);
    try {
      const data = await bookkeepingClient.bulkCategorizeTransactions({
        year: Number(range.endDate.slice(0, 4)),
        propertyId: propertyId || null,
        limit: 100,
      });

      const updatedCount = Number(data.updated || 0);
      const unchangedCount = Number(data.unchanged || 0);
      const skippedCount = Number(data.skipped || 0);
      if (data.ok || updatedCount > 0 || unchangedCount > 0) {
        const messageParts = [];
        if (updatedCount > 0) messageParts.push(`Updated ${updatedCount}`);
        if (unchangedCount > 0) messageParts.push(`${unchangedCount} already matched`);
        if (skippedCount > 0) messageParts.push(`${skippedCount} skipped`);
        setCategorizationRuleNote(messageParts.join(' • ') || 'Rule-driven categorization completed.');
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setCategorizationRuleNote(data.error || 'Failed to apply categorization rules.');
      }
    } catch (err: any) {
      setCategorizationRuleNote(err?.message || 'Failed to apply categorization rules.');
    } finally {
      setCategorizationRuleApplyBusy(false);
    }
  }

  async function removeCategorizationRule(rule: CategorizationRuleRecord) {
    if (!window.confirm(`Deactivate categorization rule ${rule.ruleName}?`)) {
      return;
    }

    setCategorizationRuleActionId(rule.id);
    setCategorizationRuleNote(null);
    try {
      const data = await bookkeepingClient.deleteCategorizationRule(rule.id);
      if (data.ok) {
        setCategorizationRuleNote(`Deactivated rule ${rule.ruleName}.`);
        await loadPipeline();
      } else {
        setCategorizationRuleNote(data.error || 'Failed to deactivate the categorization rule.');
      }
    } catch (err: any) {
      setCategorizationRuleNote(err?.message || 'Failed to deactivate the categorization rule.');
    } finally {
      setCategorizationRuleActionId(null);
    }
  }

  function applyRecurringJournalPreset(presetKey: string) {
    const preset = recurringJournalPresets[presetKey];
    if (!preset) {
      setRecurringJournalDraft((current) => ({ ...current, presetKey: '' }));
      return;
    }

    setRecurringJournalDraft((current) => ({
      ...current,
      presetKey,
      name: preset.name,
      frequency: preset.frequency,
      accountCode: preset.accountCode,
      offsetAccountCode: preset.offsetAccountCode,
      memo: current.memo || preset.name,
      dayOfMonth: String(preset.dayOfMonth || current.dayOfMonth || '1'),
    }));
  }

  async function createRecurringJournalTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = Number(recurringJournalDraft.amount);
    if (!recurringJournalDraft.name.trim() || !recurringJournalDraft.accountCode || !recurringJournalDraft.offsetAccountCode || !recurringJournalDraft.startDate) {
      setRecurringJournalNote('Enter a template name, accounts, and start date before saving the recurring journal template.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setRecurringJournalNote('Enter a valid recurring journal amount before saving the template.');
      return;
    }

    setRecurringJournalBusy(true);
    setRecurringJournalNote(null);
    try {
      const data = await bookkeepingClient.createRecurringJournalTemplate({
        name: recurringJournalDraft.name.trim(),
        frequency: recurringJournalDraft.frequency,
        amount,
        accountCode: recurringJournalDraft.accountCode,
        offsetAccountCode: recurringJournalDraft.offsetAccountCode,
        memo: recurringJournalDraft.memo.trim() || recurringJournalDraft.name.trim(),
        dayOfMonth: Number(recurringJournalDraft.dayOfMonth || 1),
        startDate: recurringJournalDraft.startDate,
        endDate: recurringJournalDraft.endDate || null,
        propertyId: propertyId || null,
      });

      if (data.ok) {
        setRecurringJournalDraft({
          presetKey: '',
          name: '',
          frequency: 'monthly',
          amount: '',
          accountCode: recurringJournalDraft.accountCode,
          offsetAccountCode: recurringJournalDraft.offsetAccountCode,
          memo: '',
          dayOfMonth: '1',
          startDate: new Date().toISOString().slice(0, 10),
          endDate: '',
        });
        setShowRecurringJournalForm(false);
        setRecurringJournalNote(`Saved recurring journal template ${data.transaction?.name || recurringJournalDraft.name}.`);
        await loadPipeline();
      } else {
        setRecurringJournalNote(data.error || 'Failed to create the recurring journal template.');
      }
    } catch (err: any) {
      setRecurringJournalNote(err?.message || 'Failed to create the recurring journal template.');
    } finally {
      setRecurringJournalBusy(false);
    }
  }

  async function toggleRecurringJournalTemplate(template: RecurringJournalTemplateRecord) {
    setRecurringJournalActionId(template.id);
    setRecurringJournalNote(null);
    try {
      const data = await bookkeepingClient.updateRecurringJournalTemplate(template.id, {
        isActive: template.isActive === false,
      });
      if (data.ok) {
        setRecurringJournalNote(`${template.name} ${template.isActive === false ? 'reactivated' : 'paused'}.`);
        await loadPipeline();
      } else {
        setRecurringJournalNote(data.error || 'Failed to update the recurring journal template.');
      }
    } catch (err: any) {
      setRecurringJournalNote(err?.message || 'Failed to update the recurring journal template.');
    } finally {
      setRecurringJournalActionId(null);
    }
  }

  async function deleteRecurringJournalTemplate(template: RecurringJournalTemplateRecord) {
    if (!window.confirm(`Delete recurring journal template ${template.name}?`)) {
      return;
    }

    setRecurringJournalActionId(template.id);
    setRecurringJournalNote(null);
    try {
      const data = await bookkeepingClient.deleteRecurringJournalTemplate(template.id);
      if (data.ok) {
        setRecurringJournalNote(`Deleted recurring journal template ${template.name}.`);
        await loadPipeline();
      } else {
        setRecurringJournalNote(data.error || 'Failed to delete the recurring journal template.');
      }
    } catch (err: any) {
      setRecurringJournalNote(err?.message || 'Failed to delete the recurring journal template.');
    } finally {
      setRecurringJournalActionId(null);
    }
  }

  async function generateRecurringJournalBatch() {
    setGeneratingRecurringJournalEntries(true);
    setRecurringJournalNote(null);
    try {
      const data = await bookkeepingClient.generateRecurringJournalEntries({
        asOfDate: range.endDate,
        propertyId: propertyId || null,
      });

      const generatedCount = Number(data.generated || 0);
      const duplicateCount = Number(data.duplicates || 0);
      const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
      if (data.ok || generatedCount > 0 || duplicateCount > 0) {
        const messageParts = [];
        if (generatedCount > 0) messageParts.push(`Posted ${generatedCount}`);
        if (duplicateCount > 0) messageParts.push(`${duplicateCount} already posted`);
        if (errorCount > 0) messageParts.push(`${errorCount} errors`);
        setRecurringJournalNote(messageParts.join(' • ') || 'Recurring journal generation completed.');
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setRecurringJournalNote(data.error || 'Failed to generate recurring journal entries.');
      }
    } catch (err: any) {
      setRecurringJournalNote(err?.message || 'Failed to generate recurring journal entries.');
    } finally {
      setGeneratingRecurringJournalEntries(false);
    }
  }

  async function createOneOffInvoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const amount = Number(invoiceDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setRecurringNote('Enter a valid invoice amount before creating the invoice.');
      return;
    }

    if (!invoiceDraft.dueDate) {
      setRecurringNote('Choose a due date before creating the invoice.');
      return;
    }

    setInvoiceBusy(true);
    setRecurringNote(null);
    try {
      const data = await bookkeepingClient.createInvoice({
        propertyId: propertyId || null,
        propertyAddress: invoiceDraft.propertyAddress || propertyAddress || '',
        tenantName: invoiceDraft.tenantName,
        tenantEmail: invoiceDraft.tenantEmail,
        amount,
        dueDate: invoiceDraft.dueDate,
        description: invoiceDraft.description || `Rent Payment - ${new Date(invoiceDraft.dueDate).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
      });

      if (data.ok) {
        setRecurringNote(`Created invoice ${data.invoice?.invoiceNumber || ''}`.trim());
        setShowInvoiceForm(false);
        setInvoiceDraft({
          propertyAddress: propertyAddress || '',
          tenantName: '',
          tenantEmail: '',
          amount: '',
          dueDate: getDefaultInvoiceDueDate(),
          description: '',
        });
        await loadPipeline();
      } else {
        setRecurringNote(data.error || 'Failed to create the invoice.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to create the invoice.');
    } finally {
      setInvoiceBusy(false);
    }
  }

  async function toggleRecurringTemplate(template: RecurringInvoiceTemplate) {
    setRecurringTemplateActionId(template.id);
    setRecurringNote(null);
    try {
      const data = await bookkeepingClient.updateRecurringInvoiceTemplate(template.id, {
        active: !template.active,
      });
      if (data.ok) {
        setRecurringNote(`${template.tenantName || template.propertyAddress || 'Template'} ${template.active ? 'paused' : 'reactivated'}.`);
        await loadPipeline();
      } else {
        setRecurringNote(data.error || 'Failed to update the recurring rent template.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to update the recurring rent template.');
    } finally {
      setRecurringTemplateActionId(null);
    }
  }

  async function deleteRecurringTemplate(template: RecurringInvoiceTemplate) {
    if (!window.confirm(`Delete recurring template for ${template.tenantName || template.propertyAddress || 'this rent schedule'}?`)) {
      return;
    }

    setRecurringTemplateActionId(template.id);
    setRecurringNote(null);
    try {
      const data = await bookkeepingClient.deleteRecurringInvoiceTemplate(template.id);
      if (data.ok) {
        setRecurringNote(`Deleted recurring rent template for ${template.tenantName || template.propertyAddress || 'the selected unit'}.`);
        await loadPipeline();
      } else {
        setRecurringNote(data.error || 'Failed to delete the recurring rent template.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to delete the recurring rent template.');
    } finally {
      setRecurringTemplateActionId(null);
    }
  }

  async function generateRecurringRentInvoices() {
    setGeneratingRecurringInvoices(true);
    setRecurringNote(null);
    try {
      const targetMonth = closePeriodTarget || range.endDate.slice(0, 7);
      const data = await bookkeepingClient.generateRecurringInvoices({ targetMonth });
      if (data.ok) {
        setRecurringNote(`Generated ${data.generated || 0} recurring invoice(s) for ${targetMonth}.`);
        await loadPipeline();
      } else {
        setRecurringNote(data.error || 'Failed to generate recurring invoices.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to generate recurring invoices.');
    } finally {
      setGeneratingRecurringInvoices(false);
    }
  }

  async function markRentInvoicePaid(invoice: RentInvoiceRecord) {
    setInvoiceActionId(invoice.id);
    setRecurringNote(null);
    try {
      const data = await bookkeepingClient.markInvoicePaid(invoice.id, {
        paymentMethod: 'manual',
      });

      if (data.ok) {
        setRecurringNote(`Marked ${invoice.invoiceNumber} paid and posted the rent journal entry to the canonical ledger.`);
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setRecurringNote(data.error || 'Failed to mark the invoice paid.');
      }
    } catch (err: any) {
      setRecurringNote(err?.message || 'Failed to mark the invoice paid.');
    } finally {
      setInvoiceActionId(null);
    }
  }

  function buildAdjustingEntryDraft(exception: ReconciliationException): AdjustingEntryDraft {
    return {
      entryDate: String(exception.effectiveDate || exception.createdAt || new Date().toISOString()).slice(0, 10),
      amount: exception.amount != null ? String(Math.abs(Number(exception.amount || 0))) : '',
      debitAccountCode: exception.suggestedMatch?.expectedToAccountCode || '5999',
      creditAccountCode: exception.suggestedMatch?.expectedFromAccountCode || '1000',
      memo: `Adjustment for ${exception.sourceRef || getReconciliationExceptionId(exception)}`,
      open: true,
    };
  }

  function toggleAdjustingEntryDraft(exception: ReconciliationException) {
    const reconciliationItemId = getReconciliationExceptionId(exception);
    setAdjustingEntryDrafts((current) => {
      const existing = current[reconciliationItemId];
      return {
        ...current,
        [reconciliationItemId]: existing
          ? { ...existing, open: !existing.open }
          : buildAdjustingEntryDraft(exception),
      };
    });
  }

  function updateAdjustingEntryDraft(reconciliationItemId: string, field: keyof AdjustingEntryDraft, value: string | boolean) {
    setAdjustingEntryDrafts((current) => ({
      ...current,
      [reconciliationItemId]: {
        ...(current[reconciliationItemId] || {
          entryDate: new Date().toISOString().slice(0, 10),
          amount: '',
          debitAccountCode: '5999',
          creditAccountCode: '1000',
          memo: '',
          open: true,
        }),
        [field]: value,
      },
    }));
  }

  async function createAdjustingEntry(exception: ReconciliationException) {
    const reconciliationItemId = getReconciliationExceptionId(exception);
    const draft = adjustingEntryDrafts[reconciliationItemId] || buildAdjustingEntryDraft(exception);

    setExceptionActionBusy(`${reconciliationItemId}:adjusting-entry`);
    setPipelineNote(null);
    try {
      const data = await bookkeepingClient.createReconciliationAdjustingEntry(reconciliationItemId, {
        entryDate: draft.entryDate,
        amount: draft.amount ? parseFloat(draft.amount) : null,
        debitAccountCode: draft.debitAccountCode,
        creditAccountCode: draft.creditAccountCode,
        memo: draft.memo,
      });

      if (data.ok) {
        setPipelineNote(`Created adjusting entry for ${exception.sourceRef || reconciliationItemId}.`);
        setAdjustingEntryDrafts((current) => ({
          ...current,
          [reconciliationItemId]: {
            ...draft,
            open: false,
          },
        }));
        await refreshOperationalWorkspace(exception.periodKey || closePeriodTarget);
      } else {
        setPipelineNote(data.error || 'Failed to create adjusting entry.');
      }
    } catch (err: any) {
      setPipelineNote(err?.message || 'Failed to create adjusting entry.');
    } finally {
      setExceptionActionBusy(null);
    }
  }

  async function reviewExceptionItem(
    exception: ReconciliationException,
    matchStatus: string,
    options: {
      journalEntryId?: string | null;
      matchResolution?: Record<string, unknown> | null;
    } = {},
  ) {
    const reconciliationItemId = getReconciliationExceptionId(exception);
    setExceptionActionBusy(`${reconciliationItemId}:${matchStatus}`);
    setPipelineNote(null);
    try {
      const note = exceptionNotes[reconciliationItemId]?.trim();
      const data = await bookkeepingClient.reviewReconciliationException(reconciliationItemId, {
        matchStatus,
        ...(options.journalEntryId !== undefined ? { journalEntryId: options.journalEntryId } : {}),
        ...(options.matchResolution ? { matchResolution: options.matchResolution } : {}),
        ...(note ? { notes: note } : {}),
      });

      if (data.ok) {
        setPipelineNote(`Updated ${exception.sourceRef || reconciliationItemId} to ${matchStatus.replace(/_/g, ' ')}.`);
        setExceptionNotes((current) => ({ ...current, [reconciliationItemId]: '' }));
        await refreshOperationalWorkspace(exception.periodKey || closePeriodTarget);
      } else {
        setPipelineNote(data.error || 'Failed to update reconciliation item.');
      }
    } catch (err: any) {
      setPipelineNote(err?.message || 'Failed to update reconciliation item.');
    } finally {
      setExceptionActionBusy(null);
    }
  }

  async function loadReconciliationEvidence(exception: ReconciliationException) {
    const reconciliationItemId = getReconciliationExceptionId(exception);
    setReconciliationEvidence((current) => ({
      ...current,
      [reconciliationItemId]: {
        ...(current[reconciliationItemId] || createEmptyReconciliationEvidenceState()),
        open: true,
        loading: true,
        error: null,
      },
    }));

    try {
      const data = await bookkeepingClient.getReconciliationEvidence(reconciliationItemId);
      if (data.ok) {
        setReconciliationEvidence((current) => ({
          ...current,
          [reconciliationItemId]: {
            ...(current[reconciliationItemId] || createEmptyReconciliationEvidenceState()),
            open: true,
            loading: false,
            status: data.status || 'loaded',
            error: null,
            evidence: data.evidence || [],
          },
        }));
      } else {
        setReconciliationEvidence((current) => ({
          ...current,
          [reconciliationItemId]: {
            ...(current[reconciliationItemId] || createEmptyReconciliationEvidenceState()),
            open: true,
            loading: false,
            status: 'error',
            error: data.error || 'Failed to load reconciliation evidence.',
            evidence: [],
          },
        }));
      }
    } catch (err: any) {
      setReconciliationEvidence((current) => ({
        ...current,
        [reconciliationItemId]: {
          ...(current[reconciliationItemId] || createEmptyReconciliationEvidenceState()),
          open: true,
          loading: false,
          status: 'error',
          error: err?.message || 'Failed to load reconciliation evidence.',
          evidence: [],
        },
      }));
    }
  }

  async function toggleReconciliationEvidence(exception: ReconciliationException) {
    const reconciliationItemId = getReconciliationExceptionId(exception);
    const current = reconciliationEvidence[reconciliationItemId];
    if (current?.open) {
      setReconciliationEvidence((previous) => ({
        ...previous,
        [reconciliationItemId]: {
          ...(previous[reconciliationItemId] || createEmptyReconciliationEvidenceState()),
          open: false,
        },
      }));
      return;
    }

    if (current && (current.status !== 'idle' || current.error || current.evidence.length > 0)) {
      setReconciliationEvidence((previous) => ({
        ...previous,
        [reconciliationItemId]: {
          ...previous[reconciliationItemId],
          open: true,
        },
      }));
      return;
    }

    await loadReconciliationEvidence(exception);
  }

  async function closeSelectedPeriod() {
    if (!closeApproval.closeAttested) {
      setPipelineNote('Attest the close review before closing the period.');
      return;
    }

    setClosePeriodBusy(true);
    setPipelineNote(null);
    try {
      const data = await bookkeepingClient.closePeriod({
        periodKey: closePeriodTarget,
        reason: closePeriodReason.trim(),
        notes: closePeriodNotes.trim() || null,
        approval: {
          attested: closeApproval.closeAttested,
          approvedBy: closeApproval.approvedBy.trim() || undefined,
          notes: closePeriodNotes.trim() || null,
          checklist: {
            reconciliationReviewed: closeApproval.reconciliationReviewed,
            openExceptionsResolved: closeApproval.openExceptionsResolved,
          },
        },
      });

      if (data.ok) {
        setPipelineNote(`Closed accounting period ${closePeriodTarget}.`);
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setPipelineNote(data.error || 'Failed to close accounting period.');
      }
    } catch (err: any) {
      setPipelineNote(err?.message || 'Failed to close accounting period.');
    } finally {
      setClosePeriodBusy(false);
    }
  }

  async function reopenSelectedPeriod(periodKey: string) {
    if (!closeApproval.reopenAttested || !closeApproval.reopenReasonApproved) {
      setPipelineNote('Review and attest the reopen approval before reopening a period.');
      return;
    }

    setClosePeriodBusy(true);
    setPipelineNote(null);
    try {
      const data = await bookkeepingClient.reopenClosePeriod(periodKey, {
        reason: closePeriodReason.trim() || 'Reopened from close cockpit',
        notes: closePeriodNotes.trim() || null,
        approval: {
          attested: closeApproval.reopenAttested,
          approvedBy: closeApproval.approvedBy.trim() || undefined,
          notes: closePeriodNotes.trim() || null,
          checklist: {
            reopenReasonApproved: closeApproval.reopenReasonApproved,
          },
        },
      });

      if (data.ok) {
        setPipelineNote(`Reopened accounting period ${periodKey}.`);
        setClosePeriodTarget(periodKey);
        await refreshOperationalWorkspace(periodKey);
      } else {
        setPipelineNote(data.error || 'Failed to reopen accounting period.');
      }
    } catch (err: any) {
      setPipelineNote(err?.message || 'Failed to reopen accounting period.');
    } finally {
      setClosePeriodBusy(false);
    }
  }

  async function loadTransactionTrace(transaction: Transaction) {
    if (!auth.currentUser) return;

    setTransactionTrace((current) => ({
      ...current,
      [transaction.id]: { status: 'loading', evidence: [] },
    }));

    const year = Number.isNaN(new Date(transaction.date).getTime()) ? null : new Date(transaction.date).getFullYear();
    const common = new URLSearchParams();
    common.set('limit', '8');
    if (transaction.propertyId || propertyId) common.set('propertyId', String(transaction.propertyId || propertyId));
    if (year) common.set('year', String(year));

    const candidates: Array<{ mode: TransactionTraceState['mode']; params: URLSearchParams }> = [];
    if (transaction.sourceRef) {
      const params = new URLSearchParams(common);
      params.set('q', transaction.sourceRef);
      candidates.push({ mode: 'source_ref', params });
    }
    if (transaction.id) {
      const journalParams = new URLSearchParams(common);
      journalParams.set('entityType', 'journal_entry');
      journalParams.set('entityId', transaction.id);
      candidates.push({ mode: 'journal_entry', params: journalParams });

      const firestoreParams = new URLSearchParams(common);
      firestoreParams.set('entityType', 'firestore_journal_entry');
      firestoreParams.set('entityId', transaction.id);
      candidates.push({ mode: 'firestore_journal_entry', params: firestoreParams });
    }

    try {
      let lastState: TransactionTraceState = { status: 'loaded', evidence: [], mode: null };

      for (const candidate of candidates) {
        const data = await bookkeepingClient.searchEvidence(Object.fromEntries(candidate.params.entries()));

        if (data.status === 'not_configured') {
          lastState = { status: 'not_configured', evidence: [], mode: candidate.mode, error: null };
          break;
        }

        if (data._httpOk === false || data.ok === false) {
          lastState = {
            status: 'error',
            evidence: [],
            mode: candidate.mode,
            error: data.error || `Trace lookup failed (${data._httpStatus || 'unknown'})`,
          };
          continue;
        }

        if ((data.evidence || []).length > 0) {
          lastState = {
            status: 'loaded',
            evidence: data.evidence || [],
            mode: candidate.mode,
          };
          break;
        }

        lastState = {
          status: 'loaded',
          evidence: [],
          mode: candidate.mode,
          error: null,
        };
      }

      setTransactionTrace((current) => ({
        ...current,
        [transaction.id]: lastState,
      }));
    } catch (err: any) {
      setTransactionTrace((current) => ({
        ...current,
        [transaction.id]: {
          status: 'error',
          evidence: [],
          mode: null,
          error: err?.message || 'Failed to load transaction trace.',
        },
      }));
    }
  }

  async function toggleTransactionTrace(transaction: Transaction) {
    if (openTraceId === transaction.id) {
      setOpenTraceId(null);
      return;
    }

    setOpenTraceId(transaction.id);
    const existing = transactionTrace[transaction.id];
    if (!existing || existing.status === 'idle' || existing.status === 'error') {
      await loadTransactionTrace(transaction);
    }
  }

  function applyRange() {
    const nextPeriodKey = range.endDate.slice(0, 7);
    setClosePeriodTarget(nextPeriodKey);
    void refreshOperationalWorkspace(nextPeriodKey);
  }

  async function postQuickEntry(e: React.FormEvent) {
    e.preventDefault();
    setEntryNote(null);
    const amt = parseFloat(entry.amount);
    if (!entry.description.trim() || !Number.isFinite(amt) || amt <= 0) {
      setEntryNote('Enter a description and a positive amount.');
      return;
    }
    setPostingEntry(true);
    try {
      const ok = await bookkeeping.addTransaction({
        date: entry.date,
        description: entry.description.trim(),
        amount: amt,
        type: entry.type,
        categoryCode: entry.categoryCode || undefined,
        propertyId,
      });
      if (ok) {
        setEntry({ ...entry, description: '', amount: '' });
        setEntryNote('Posted to canonical ledger.');
        await bookkeeping.fetchData(dashboardScope);
        loadPipeline();
      } else {
        setEntryNote('Could not post entry.');
      }
    } finally {
      setPostingEntry(false);
    }
  }

  async function loadSampleData() {
    setLoadingSample(true);
    setSampleNote(null);
    try {
      const data = await bookkeepingClient.loadMockData(2025, {
        propertyId,
        propertyAddress,
      });
      if (data.ok) {
        const propertyName = data.property?.name || data.property?.propertyName || null;
        setSampleNote(
          propertyName
            ? `Loaded ${data.entriesCreated || data.transactionsCreated || 'sample'} canonical fixture entries into ${propertyName}.`
            : `Loaded ${data.entriesCreated || data.transactionsCreated || 'sample'} canonical fixture entries.`,
        );
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setSampleNote(data.error || 'Failed to load sample data.');
      }
    } catch (err: any) {
      setSampleNote(err?.message || 'Failed to load sample data.');
    } finally {
      setLoadingSample(false);
    }
  }

  async function clearSampleData() {
    if (!confirm('Remove all sample/mock entries from the ledger? Real Stripe/bank data will be kept.')) return;
    setClearingSample(true);
    setSampleNote(null);
    try {
      const data = await bookkeepingClient.clearMockData();
      if (data.ok) {
        setSampleNote(`Cleared ${data.deleted || 0} canonical fixture records.`);
        bookkeeping.fetchData(dashboardScope);
        loadPipeline();
      } else {
        setSampleNote(data.error || 'Failed to clear sample data.');
      }
    } finally {
      setClearingSample(false);
    }
  }

  async function clearLiveTransactionsInWindow() {
    const scopedPropertyLabel = propertyAddress ? ` for ${propertyAddress}` : '';
    const windowLabel = `${range.startDate} to ${range.endDate}`;
    if (!confirm(`Remove live Stripe Financial Connections activity${scopedPropertyLabel} between ${windowLabel}? Sample data will be kept.`)) {
      return;
    }

    setClearingLive(true);
    setSampleNote(null);

    try {
      const data = await bookkeepingClient.clearLiveTransactions({
        startDate: range.startDate,
        endDate: range.endDate,
        ...(propertyId ? { propertyId } : {}),
      });

      if (data.ok) {
        const postedCount = Number(data.matchedCounts?.journalEntries || 0);
        const stagedCount = Number(data.matchedCounts?.reconciliationItems || 0);
        const detailParts = [];
        if (postedCount > 0) {
          detailParts.push(`${postedCount} posted`);
        }
        if (stagedCount > 0) {
          detailParts.push(`${stagedCount} staged`);
        }
        const detailSuffix = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';

        setSampleNote(`Cleared ${data.deleted || 0} live transaction${Number(data.deleted || 0) === 1 ? '' : 's'} in the current ledger window${detailSuffix}.`);
        await refreshOperationalWorkspace(closePeriodTarget);
      } else {
        setSampleNote(data.error || 'Failed to clear live transactions.');
      }
    } catch (err: any) {
      setSampleNote(err?.message || 'Failed to clear live transactions.');
    } finally {
      setClearingLive(false);
    }
  }

  // Filtered ledger
  const propertyOptions = useMemo(
    () => Array.from(new Set(bookkeeping.transactions.map((t) => t.propertyId).filter(Boolean) as string[])).sort(),
    [bookkeeping.transactions],
  );
  const vendorOptions = useMemo(
    () => Array.from(new Set(bookkeeping.transactions.map((t) => String(t.vendor || '').trim()).filter(Boolean))).sort(),
    [bookkeeping.transactions],
  );
  const ledgerAccountOptions = useMemo(
    () => bookkeeping.accounts
      .filter((account) => bookkeeping.transactions.some((transaction) => transaction.accountCode === account.code))
      .sort((a, b) => a.code.localeCompare(b.code)),
    [bookkeeping.accounts, bookkeeping.transactions],
  );

  const filtered = useMemo<Transaction[]>(() => {
    let rows = bookkeeping.transactions;
    // When propertyId is already passed to the dashboard fetch, trust backend scoping.
    // Re-filtering here drops rows when the UI property alias differs from the stored
    // ledger property id even though the totals/summary endpoints already mapped them.
    if (!propertyId && propertyFilter !== 'all') {
      rows = rows.filter((t) => t.propertyId === propertyFilter);
    }
    if (typeFilter !== 'all') {
      rows = rows.filter((t) => t.type === typeFilter);
    }
    if (categoryFilter !== 'all') {
      rows = rows.filter((t) => String(t.category || 'Uncategorized') === categoryFilter);
    }
    if (accountFilter !== 'all') {
      rows = rows.filter((t) => t.accountCode === accountFilter);
    }
    if (vendorFilter !== 'all') {
      rows = rows.filter((t) => String(t.vendor || '').trim() === vendorFilter);
    }
    if (sourceFilter !== 'all') {
      rows = rows.filter((t) => classifyFinanceSource(t.source).kind === sourceFilter);
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      rows = rows.filter((t) =>
        [t.description, t.category, t.vendor || '', t.source || '', t.accountCode || '', t.propertyId || '']
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    const sortedRows = [...rows];
    sortedRows.sort((left, right) => {
      if (sortOrder === 'amount-desc') return Math.abs(Number(right.amount || 0)) - Math.abs(Number(left.amount || 0));
      if (sortOrder === 'amount-asc') return Math.abs(Number(left.amount || 0)) - Math.abs(Number(right.amount || 0));
      const leftDate = new Date(left.date || 0).getTime();
      const rightDate = new Date(right.date || 0).getTime();
      return sortOrder === 'date-asc' ? leftDate - rightDate : rightDate - leftDate;
    });
    return sortedRows;
  }, [accountFilter, bookkeeping.transactions, categoryFilter, propertyFilter, propertyId, searchText, sortOrder, sourceFilter, typeFilter, vendorFilter]);

  // Source mix counts (across the unfiltered scoped set)
  const sourceMix = useMemo(
    () => buildFinanceSourceMix(bookkeeping.transactions),
    [bookkeeping.transactions],
  );

  const summary = bookkeeping.summary;
  const revenueExpenseAccounts = useMemo(
    () => bookkeeping.accounts.filter((account): account is Account => account.type === 'EXPENSE' || account.type === 'REVENUE'),
    [bookkeeping.accounts],
  );
  const cashAccount = bookkeeping.accounts.find((a) => a.code === '1000');
  const visibleCashBalance = propertyId
    ? propertyCashBalances[propertyId]
    : cashAccount?.balance;
  const averageMonthlyExpenses = useMemo(
    () => bookkeeping.cashflowTrend.length > 0
      ? bookkeeping.cashflowTrend.reduce((sum, point) => sum + Number(point.expenses || 0), 0) / bookkeeping.cashflowTrend.length
      : 0,
    [bookkeeping.cashflowTrend],
  );
  const reserveRunwayMonths = useMemo(
    () => visibleCashBalance != null && averageMonthlyExpenses > 0
      ? Number(visibleCashBalance || 0) / averageMonthlyExpenses
      : null,
    [averageMonthlyExpenses, visibleCashBalance],
  );
  const operatingMarginPct = useMemo(
    () => (summary?.totalIncome || 0) > 0
      ? (((summary?.netIncome || 0) / (summary?.totalIncome || 1)) * 100)
      : null,
    [summary?.netIncome, summary?.totalIncome],
  );
  const activeRecurringTemplates = recurringTemplates.filter((template) => template.active);
  const recurringTemplateMonthlyAmount = activeRecurringTemplates.reduce((total, template) => total + Number(template.amount || 0), 0);
  const activeRecurringJournalTemplates = useMemo(
    () => recurringJournalTemplates.filter((template) => template.isActive !== false),
    [recurringJournalTemplates],
  );
  const recurringJournalMonthlyAmount = useMemo(
    () => activeRecurringJournalTemplates.reduce((total, template) => total + getMonthlyRecurringAmount(template), 0),
    [activeRecurringJournalTemplates],
  );
  const recurringJournalPresetEntries = useMemo(
    () => Object.entries(recurringJournalPresets),
    [recurringJournalPresets],
  );
  const recentRentInvoices = useMemo(
    () => [...rentInvoices].sort((left, right) => (
      new Date(right.dueDate || right.createdAt || 0).getTime() - new Date(left.dueDate || left.createdAt || 0).getTime()
    )).slice(0, 6),
    [rentInvoices],
  );
  const receivablesBuckets = useMemo(
    () => [
      { key: 'current', label: 'Current', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
      { key: '1-30', label: '1-30 Days', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
      { key: '31-60', label: '31-60 Days', tone: 'text-orange-700 bg-orange-50 border-orange-200' },
      { key: '61-90', label: '61-90 Days', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
      { key: '90+', label: '90+ Days', tone: 'text-rose-800 bg-rose-100 border-rose-300' },
    ],
    [],
  );
  const overdue30PlusAmount = useMemo(
    () => ['31-60', '61-90', '90+'].reduce((sum, key) => sum + Number(accountsReceivable?.aging?.[key]?.amount || 0), 0),
    [accountsReceivable],
  );
  const aiCategorizationCandidates = useMemo(
    () => {
      const reviewCandidates = filtered.filter(transactionNeedsCategorizationReview);
      const base = reviewCandidates.length > 0 ? reviewCandidates : filtered;
      return base.slice(0, 25);
    },
    [filtered],
  );
  const activeAccount = accountFilter === 'all'
    ? null
    : bookkeeping.accounts.find((account) => account.code === accountFilter) || null;
  const incomeBuckets = (summary?.incomeByCategory || []).filter((bucket) => Number(bucket.amount || 0) !== 0);
  const expenseBuckets = (summary?.expensesByCategory || []).filter((bucket) => Number(bucket.amount || 0) !== 0);
  const accountBalanceRows = useMemo(
    () => (propertyId && trialBalanceReport
      ? trialBalanceReport.accounts
      : bookkeeping.accounts),
    [bookkeeping.accounts, propertyId, trialBalanceReport],
  );
  const sortedAccounts = useMemo(
    () => [...accountBalanceRows].sort((a, b) => Math.abs(Number(b.balance || 0)) - Math.abs(Number(a.balance || 0))),
    [accountBalanceRows],
  );
  const openClosePeriods = useMemo(
    () => closePeriods.filter((period) => String(period.status || '').toLowerCase() !== 'closed'),
    [closePeriods],
  );
  const pendingFinanceDocuments = useMemo(
    () => financeDocuments.filter(financeDocumentNeedsAttention),
    [financeDocuments],
  );
  const evidencePendingCount = useMemo(() => {
    const counts = evidenceSummary?.digitizationStatusCounts || {};
    return Object.entries(counts).reduce((sum, [status, count]) => {
      return sum + (isResolvedWorkflowStatus(status) ? 0 : Number(count || 0));
    }, 0);
  }, [evidenceSummary]);
  const reconciliationSummary = useMemo(() => {
    return reconExceptions.reduce(
      (summaryAcc, exception) => {
        const matchStatus = getReconciliationExceptionStatus(exception);
        summaryAcc.totalItems += 1;
        summaryAcc.matchStatusCounts[matchStatus] = (summaryAcc.matchStatusCounts[matchStatus] || 0) + 1;
        return summaryAcc;
      },
      {
        totalItems: 0,
        matchStatusCounts: {} as Record<string, number>,
      },
    );
  }, [reconExceptions]);
  const latestClosedPeriod = useMemo(() => {
    return closePeriods
      .filter((period) => String(period.status || '').toLowerCase() === 'closed')
      .map((period) => ({
        period,
        cutoff: getClosePeriodCutoff(period.periodKey, period.closedAt),
      }))
      .filter((item): item is { period: ClosePeriodSummary; cutoff: Date } => Boolean(item.cutoff))
      .sort((left, right) => right.cutoff.getTime() - left.cutoff.getTime())[0]?.period || null;
  }, [closePeriods]);
  const closeDelta = useMemo(() => {
    const cutoff = latestClosedPeriod ? getClosePeriodCutoff(latestClosedPeriod.periodKey, latestClosedPeriod.closedAt) : null;
    if (!cutoff) {
      return {
        cutoff: null as Date | null,
        transactions: [] as Transaction[],
        topTransactions: [] as Transaction[],
        income: 0,
        expenses: 0,
        uncategorizedCount: 0,
        reconCount: 0,
        documentCount: 0,
        sourceHeadline: 'No previously closed period is available yet in this owner scope.',
      };
    }

    const transactions = filtered.filter((transaction) => {
      const transactionDate = getTransactionDate(transaction);
      return transactionDate ? transactionDate.getTime() > cutoff.getTime() : false;
    });
    const topTransactions = [...transactions]
      .sort((left, right) => Math.abs(Number(right.amount || 0)) - Math.abs(Number(left.amount || 0)))
      .slice(0, 5);
    const reconCount = reconExceptions.filter((exception) => {
      const exceptionDate = toComparableDate(exception.occurredAt || exception.createdAt || exception.effectiveDate || null);
      return exceptionDate ? exceptionDate.getTime() > cutoff.getTime() : false;
    }).length;
    const documentCount = pendingFinanceDocuments.filter((document) => {
      const documentDate = toComparableDate(document.documentDate || document.createdAt || null);
      return documentDate ? documentDate.getTime() > cutoff.getTime() : false;
    }).length;

    return {
      cutoff,
      transactions,
      topTransactions,
      income: transactions
        .filter((transaction) => transaction.type === 'income')
        .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0),
      expenses: transactions
        .filter((transaction) => transaction.type === 'expense')
        .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0),
      uncategorizedCount: transactions.filter(transactionNeedsCategorizationReview).length,
      reconCount,
      documentCount,
      sourceHeadline: transactions.length > 0
        ? buildFinanceSourceMix(transactions).headline
        : 'No new ledger lines are posted after the most recent closed period in the current scope.',
    };
  }, [filtered, latestClosedPeriod, pendingFinanceDocuments, reconExceptions]);
  const budgetRowsForDisplay = useMemo(() => {
    const comparison = budgetComparison?.comparison || {};
    const accountCodes = Array.from(new Set([...Object.keys(budgets), ...Object.keys(comparison)]));
    return accountCodes
      .map((accountCode) => {
        const budget = budgets[accountCode] || {};
        const row = comparison[accountCode] || {
          category: budget.category || accountCode,
          monthlyBudget: Number(budget.monthlyBudget || 0),
          annualBudget: Number(budget.annualBudget || 0),
          expectedBudget: Number(budget.monthlyBudget || 0) * Number(budgetComparison?.monthsElapsed || 1),
          actual: 0,
          variance: Number(budget.monthlyBudget || 0) * Number(budgetComparison?.monthsElapsed || 1),
          variancePercent: 0,
          status: 'under_budget',
          utilizationPercent: 0,
        };
        return {
          accountCode,
          ...row,
          category: row.category || budget.category || accountCode,
        };
      })
      .sort((left, right) => Math.abs(Number(right.variance || 0)) - Math.abs(Number(left.variance || 0)) || left.category.localeCompare(right.category));
  }, [budgetComparison?.comparison, budgetComparison?.monthsElapsed, budgets]);
  const reportCenterExplanations = useMemo<ExplanationItem[]>(() => {
    const explanations: ExplanationItem[] = [];

    if (budgetComparison?.summary) {
      explanations.push({
        id: 'budget-posture',
        title: 'Why budget posture looks like this',
        detail: `${fmtMoney(budgetComparison.summary.totalActual)} actual spending is being compared against ${fmtMoney(budgetComparison.summary.totalBudgeted)} budgeted in the current report-center year scope.`,
        citations: [
          `${budgetComparison.summary.overBudgetCategories} categories are currently over budget.`,
          `${budgetComparison.summary.utilizationPercent}% budget utilization so far.`,
          ...(budgetRowsForDisplay.filter((row) => row.status === 'over_budget').slice(0, 3).map((row) => `${row.category} · ${fmtMoney(row.actual)} actual vs ${fmtMoney(row.expectedBudget)} budgeted.`)),
        ].filter(Boolean),
      });
    }

    if (trialBalanceReport || profitLossReport || balanceSheetReport) {
      explanations.push({
        id: 'report-center',
        title: 'What the report center is confirming',
        detail: `The canonical report set is ${trialBalanceReport?.is_balanced ? 'balanced' : 'not fully balanced'} with current net income at ${fmtMoney(profitLossReport?.summary?.net_income)} for the visible range.`,
        citations: [
          trialBalanceReport ? `Trial balance debits ${fmtMoney(trialBalanceReport.total_debits)} and credits ${fmtMoney(trialBalanceReport.total_credits)}.` : 'Trial balance is not loaded yet.',
          profitLossReport ? `P&L revenue ${fmtMoney(profitLossReport.summary?.total_revenue)} against expenses ${fmtMoney(profitLossReport.summary?.total_expenses)}.` : 'Profit and loss is not loaded yet.',
          balanceSheetReport ? `Balance sheet assets ${fmtMoney(balanceSheetReport.total_assets)}, liabilities ${fmtMoney(balanceSheetReport.total_liabilities)}, equity ${fmtMoney(balanceSheetReport.total_equity)}.` : 'Balance sheet is not loaded yet.',
        ],
      });
    }

    return explanations;
  }, [balanceSheetReport, budgetComparison, budgetRowsForDisplay, profitLossReport, trialBalanceReport]);
  const reportCenterExplainFor = useCallback((id: string) => {
    const item = reportCenterExplanations.find((entry) => entry.id === id);
    return item ? { metricId: item.id, detail: item.detail, citations: item.citations } : undefined;
  }, [reportCenterExplanations]);
  const closeCockpitTasks = useMemo<CloseCockpitTask[]>(() => {
    const tasks: CloseCockpitTask[] = [];

    for (const period of openClosePeriods.slice(0, 4)) {
      const status = String(period.status || 'open').toLowerCase();
      tasks.push({
        id: `close-${period.periodKey}`,
        lane: 'close',
        title: `${period.periodKey} is ${status}`,
        detail: status === 'reopened'
          ? 'This period was reopened and should be re-closed after reconciliation and evidence review.'
          : 'This period still needs close review before month-end is complete.',
        meta: period.reopenedAt
          ? `Reopened ${fmtDate(period.reopenedAt)}`
          : period.closedAt
            ? `Last closed ${fmtDate(period.closedAt)}`
            : 'No close timestamp yet',
        priority: status === 'reopened' ? 100 : 90,
      });
    }

    for (const exception of reconExceptions.slice(0, 6)) {
      tasks.push({
        id: `recon-${exception.id}`,
        lane: 'recon',
        title: exception.reason || exception.status || 'Open reconciliation exception',
        detail: exception.description || 'Investigate and clear this unmatched or flagged item from the reconciliation engine.',
        meta: exception.occurredAt ? fmtDate(exception.occurredAt) : 'No exception timestamp',
        amount: exception.amount,
        priority: 80,
      });
    }

    if (evidencePendingCount > 0) {
      tasks.push({
        id: 'evidence-pending',
        lane: 'evidence',
        title: `${evidencePendingCount} evidence items still need follow-up`,
        detail: 'Resolve OCR or digitization backlog so every month-end blocker has supporting evidence coverage.',
        meta: `${evidenceSummary?.totalEvidence ?? 0} evidence records currently indexed`,
        priority: 75,
      });
    } else if ((evidenceSummary?.totalEvidence ?? 0) === 0) {
      tasks.push({
        id: 'evidence-empty',
        lane: 'evidence',
        title: 'No finance evidence is indexed yet',
        detail: 'Upload or sync supporting documents before closing the period so the ledger has reviewable backup.',
        meta: 'Search evidence to confirm coverage after upload.',
        priority: 72,
      });
    }

    for (const document of pendingFinanceDocuments.slice(0, 4)) {
      tasks.push({
        id: `document-${document.id}`,
        lane: 'document',
        title: document.title || document.originalFileName || 'Finance document follow-up',
        detail: `OCR ${formatWorkflowStatus(document.digitization?.status)} · Evidence ${formatWorkflowStatus(document.evidenceShadow?.status)}`,
        meta: [document.vendorName, document.documentDate ? fmtDate(document.documentDate) : null]
          .filter(Boolean)
          .join(' · ') || 'Use the finance documents workspace below to resolve this item.',
        amount: document.amount,
        priority: 70,
      });
    }

    return tasks.sort((left, right) => right.priority - left.priority);
  }, [evidencePendingCount, evidenceSummary, openClosePeriods, pendingFinanceDocuments, reconExceptions]);
  const bookkeepingSummaryExplanations = useMemo<ExplanationItem[]>(() => {
    const topIncomeBuckets = incomeBuckets.slice(0, 3).map((bucket) => `${bucket.category} ${fmtMoney(bucket.amount)}`);
    const topExpenseBuckets = expenseBuckets.slice(0, 3).map((bucket) => `${bucket.category} ${fmtMoney(bucket.amount)}`);
    const margin = (summary?.totalIncome || 0) > 0
      ? `${(((summary?.netIncome || 0) / (summary?.totalIncome || 1)) * 100).toFixed(1)}% margin`
      : 'No margin yet because there is no posted income in this window.';

    return [
      {
        id: 'income',
        title: 'Why income is this number',
        detail: `${fmtMoney(summary?.totalIncome)} is the total posted income in the current ledger window.`,
        citations: [
          `${incomeBuckets.length} income bucket(s) are in scope.`,
          topIncomeBuckets.length > 0 ? `Top income buckets: ${topIncomeBuckets.join(' · ')}.` : 'No posted income buckets are in scope.',
          sourceMix.headline,
        ],
      },
      {
        id: 'expenses',
        title: 'Why expenses are this number',
        detail: `${fmtMoney(summary?.totalExpenses)} is the total posted expense activity in the current ledger window.`,
        citations: [
          `${expenseBuckets.length} expense bucket(s) are in scope.`,
          topExpenseBuckets.length > 0 ? `Top expense buckets: ${topExpenseBuckets.join(' · ')}.` : 'No posted expense buckets are in scope.',
          `Range ${range.startDate} to ${range.endDate}.`,
        ],
      },
      {
        id: 'net',
        title: 'Why net is this number',
        detail: `${fmtMoney(summary?.netIncome)} is computed as income minus expenses for the same window.`,
        citations: [
          `${fmtMoney(summary?.totalIncome)} income minus ${fmtMoney(summary?.totalExpenses)} expenses.`,
          margin,
          propertyAddress ? `Scoped to ${propertyAddress}.` : 'Showing all properties in the ledger scope.',
        ],
      },
      {
        id: 'cash',
        title: 'Why operating cash is this number',
        detail: `${fmtMoney(cashAccount?.balance)} is the current balance of the canonical operating-cash account.`,
        citations: [
          cashAccount ? `Account ${cashAccount.code} · ${cashAccount.name}.` : 'No operating-cash account is currently loaded.',
          'This number comes from the live account balance, not from a derived income-expense calculation.',
          sourceMix.total > 0 ? buildFinanceSourceMix(bookkeeping.transactions).headline : 'No source-mixed transactions are currently in scope.',
        ],
      },
    ];
  }, [bookkeeping.transactions, cashAccount, expenseBuckets, incomeBuckets, propertyAddress, range.endDate, range.startDate, sourceMix.headline, sourceMix.total, summary?.netIncome, summary?.totalExpenses, summary?.totalIncome]);
  const executiveOverviewExplanations = useMemo<ExplanationItem[]>(() => {
    const openExceptionReasons = reconExceptions.slice(0, 3).map((exception) => exception.reason || exception.status || 'Open exception');
    return [
      {
        id: 'cash-balance',
        title: 'Why cash balance is this number',
        detail: `${fmtMoney(visibleCashBalance)} is the canonical operating-cash balance currently loaded into the owner shell.`,
        citations: [
          propertyId
            ? `Property-scoped cash is pulled from the canonical balance-sheet seam for ${propertyAddress || propertyId}.`
            : cashAccount ? `Account ${cashAccount.code} · ${cashAccount.name}.` : 'No operating cash account is currently loaded.',
          `${fmtMoney(summary?.totalIncome)} income and ${fmtMoney(summary?.totalExpenses)} expenses are in the same ledger window.`,
          'This metric is ledger-derived and does not depend on a separate tax rules package.',
        ],
      },
      {
        id: 'noi',
        title: 'Why NOI is this number',
        detail: `${fmtMoney(summary?.netIncome)} reflects the current ledger-window net operating result.`,
        citations: [
          `${fmtMoney(summary?.totalIncome)} income minus ${fmtMoney(summary?.totalExpenses)} expenses.`,
          propertyAddress ? `Current property context ${propertyAddress}.` : 'This view is currently showing portfolio-level owner scope.',
          'The contributing journal lines are the same posted ledger rows shown below in the normal list workspace.',
        ],
      },
      {
        id: 'margin',
        title: 'Why margin is this percentage',
        detail: operatingMarginPct != null
          ? `${operatingMarginPct.toFixed(1)}% is computed from ${fmtMoney(summary?.netIncome)} net divided by ${fmtMoney(summary?.totalIncome)} income.`
          : 'Margin is unavailable because there is no posted income in the current ledger window.',
        citations: [
          `${fmtMoney(summary?.netIncome)} current net income.`,
          `${fmtMoney(summary?.totalIncome)} current income denominator.`,
          'This percentage is a ledger ratio and does not use tax estimation rules.',
        ],
      },
      {
        id: 'reserve-runway',
        title: 'Why reserve runway looks like this',
        detail: reserveRunwayMonths != null
          ? `${reserveRunwayMonths.toFixed(1)} months is derived from ${fmtMoney(visibleCashBalance)} cash over ${fmtMoney(averageMonthlyExpenses)} average monthly expenses.`
          : 'Reserve runway is unavailable because the current scope does not have enough expense history to derive a monthly burn pace.',
        citations: [
          `${fmtMoney(averageMonthlyExpenses)} average monthly expense pace in the current trend scope.`,
          visibleCashBalance != null ? `${fmtMoney(visibleCashBalance)} operating cash on hand.` : 'No operating cash account is currently loaded.',
          'The linked property reserve coverage panel below now uses the same balance-sheet seam on a property-by-property basis.',
        ],
      },
      {
        id: 'open-exceptions',
        title: 'Why open exceptions are at this count',
        detail: `${reconciliationSummary.totalItems} reconciliation items are still open in the close workspace.`,
        citations: [
          openExceptionReasons.length > 0 ? `Top open reasons: ${openExceptionReasons.join(' · ')}.` : 'No open reconciliation exception reasons are currently loaded.',
          `${evidencePendingCount} evidence items still need follow-up.`,
          'Use the close cockpit and evidence queue below to inspect the linked supporting items behind these blockers.',
        ],
      },
      {
        id: 'packet-readiness',
        title: 'Why packet readiness looks like this',
        detail: `${String(taxPacketReadiness?.readinessStatus || 'not_loaded').replace(/_/g, ' ')} is the current tax handoff state surfaced into the bookkeeping shell.`,
        citations: [
          taxPacketReadiness?.summary || 'Tax packet readiness has not returned a summary yet.',
          taxPacketReadiness?.score != null ? `Current tax packet score ${taxPacketReadiness.score}.` : 'No tax packet score is currently loaded.',
          'Open the tax workspace for the full filing-cockpit breakdown, document blockers, and rules-version context.',
        ],
      },
    ];
  }, [averageMonthlyExpenses, cashAccount, evidencePendingCount, operatingMarginPct, propertyAddress, reconExceptions, reconciliationSummary.totalItems, reserveRunwayMonths, summary?.netIncome, summary?.totalExpenses, summary?.totalIncome, taxPacketReadiness]);
  const selectedExecutiveExplanation = executiveOverviewExplanations.find((item) => item.id === openExecutiveExplanationId) || executiveOverviewExplanations[0] || null;
  const closeCockpitExplanations = useMemo<ExplanationItem[]>(() => {
    const explanations: ExplanationItem[] = [];

    if (openClosePeriods.length > 0) {
      explanations.push({
        id: 'close-periods',
        title: 'Why close periods are blocking',
        detail: `${openClosePeriods.length} close period(s) are still open or reopened.`,
        citations: openClosePeriods.slice(0, 3).map((period) => `${period.periodKey} · ${period.status}`),
      });
    }

    if (reconciliationSummary.totalItems > 0) {
      explanations.push({
        id: 'reconciliation',
        title: 'Why reconciliation is blocking',
        detail: `${reconciliationSummary.totalItems} reconciliation exception(s) still need review.`,
        citations: [
          `${reconciliationSummary.matchStatusCounts.pending_match || 0} pending match.`,
          `${reconciliationSummary.matchStatusCounts.pending_review || 0} pending review.`,
          `${reconExceptions.slice(0, 2).map((exception) => exception.reason || exception.status || 'open exception').join(' · ') || 'No exception labels available.'}`,
        ],
      });
    }

    if (evidencePendingCount > 0 || (evidenceSummary?.totalEvidence ?? 0) === 0) {
      explanations.push({
        id: 'evidence',
        title: 'Why evidence follow-up is blocking',
        detail: evidencePendingCount > 0
          ? `${evidencePendingCount} evidence item(s) still need OCR or digitization follow-up.`
          : 'No finance evidence is indexed yet for this close workspace.',
        citations: [
          `${evidenceSummary?.totalEvidence ?? 0} evidence record(s) currently indexed.`,
          evidencePendingCount > 0 ? 'Open evidence backlog is still unresolved.' : 'Upload or sync supporting documents to start evidence coverage.',
        ],
      });
    }

    if (pendingFinanceDocuments.length > 0) {
      explanations.push({
        id: 'documents',
        title: 'Why finance documents are blocking',
        detail: `${pendingFinanceDocuments.length} finance document(s) still need OCR or evidence shadowing.`,
        citations: pendingFinanceDocuments.slice(0, 3).map((document) => (
          `${document.title || document.originalFileName || 'Finance document'} · OCR ${formatWorkflowStatus(document.digitization?.status)} · Evidence ${formatWorkflowStatus(document.evidenceShadow?.status)}`
        )),
      });
    }

    if (closePeriodIntelligence?.blockers?.length) {
      explanations.push({
        id: 'intelligence',
        title: 'What close intelligence is flagging',
        detail: closePeriodIntelligence.summary,
        citations: closePeriodIntelligence.blockers.slice(0, 3),
      });
    }

    return explanations;
  }, [closePeriodIntelligence?.blockers, closePeriodIntelligence?.summary, evidencePendingCount, evidenceSummary?.totalEvidence, openClosePeriods, pendingFinanceDocuments, reconExceptions, reconciliationSummary]);
  const evidenceResolvedCount = Math.max(0, (evidenceSummary?.totalEvidence ?? 0) - evidencePendingCount);
  const bookkeepingAuditStatus = useMemo(() => {
    if (filtered.length === 0) {
      return {
        label: 'No bookkeeping rows in scope',
        tone: 'slate' as const,
        detail: 'Change the ledger window or load bookkeeping activity to populate a first audit snapshot.',
      };
    }

    const blockerCount = openClosePeriods.length
      + reconciliationSummary.totalItems
      + pendingFinanceDocuments.length
      + evidencePendingCount
      + (closePeriodIntelligence?.blockers?.length ?? 0);

    if (blockerCount > 0) {
      return {
        label: 'Attention needed before close',
        tone: 'amber' as const,
        detail: `${blockerCount} visible bookkeeping blocker${blockerCount === 1 ? '' : 's'} are still affecting close and review readiness in this window.`,
      };
    }

    return {
      label: 'Ledger tie-out snapshot looks clean',
      tone: sourceMix.hasSample ? 'amber' as const : 'emerald' as const,
      detail: sourceMix.hasSample
        ? 'Core bookkeeping controls are loaded, but sample-backed rows are still mixed into this audit snapshot.'
        : 'Current source, reconciliation, and evidence signals are aligned for the visible bookkeeping window.',
    };
  }, [closePeriodIntelligence?.blockers?.length, evidencePendingCount, filtered.length, openClosePeriods.length, pendingFinanceDocuments.length, reconciliationSummary.totalItems, sourceMix.hasSample]);
  const bookkeepingAuditFlags = useMemo(() => {
    const flags: Array<{ title: string; detail: string; tone?: 'amber' | 'rose' | 'slate' | 'emerald' }> = [];

    if (sourceMix.hasSample) {
      flags.push({
        title: 'Sample data in scope',
        detail: `${sourceMix.samplePct}% of visible bookkeeping rows are sample-backed, so this audit rail should be treated as directional until live-only data is in scope.`,
        tone: 'amber',
      });
    }
    if (!latestClosedPeriod) {
      flags.push({
        title: 'No prior close baseline',
        detail: 'Delta tracking and post-close audit comparisons stay limited until the first close period is recorded in this owner scope.',
        tone: 'amber',
      });
    }
    if (reconciliationSummary.totalItems > 0) {
      flags.push({
        title: 'Reconciliation exceptions open',
        detail: `${reconciliationSummary.totalItems} exception(s) remain open across pending match and pending review states.`,
        tone: 'rose',
      });
    }
    if (evidencePendingCount > 0 || (evidenceSummary?.totalEvidence ?? 0) === 0) {
      flags.push({
        title: 'Evidence coverage incomplete',
        detail: evidencePendingCount > 0
          ? `${evidencePendingCount} evidence item(s) still need OCR or digitization follow-up.`
          : 'No finance evidence is indexed yet for this bookkeeping scope.',
        tone: evidencePendingCount > 0 ? 'amber' : 'rose',
      });
    }
    if (pendingFinanceDocuments.length > 0) {
      flags.push({
        title: 'Document follow-up pending',
        detail: `${pendingFinanceDocuments.length} finance document(s) still need OCR or evidence shadowing before they are fully review-ready.`,
        tone: 'amber',
      });
    }
    if (!trialBalanceReport) {
      flags.push({
        title: 'Trial balance unavailable',
        detail: 'The report-center tie-out has not loaded a trial balance yet, so the rail cannot confirm ledger balance from this view alone.',
        tone: 'amber',
      });
    }

    return flags.slice(0, 6);
  }, [evidencePendingCount, evidenceSummary?.totalEvidence, latestClosedPeriod, pendingFinanceDocuments.length, reconciliationSummary.totalItems, sourceMix.hasSample, sourceMix.samplePct, trialBalanceReport]);
  const bookkeepingAuditMetrics = useMemo(() => ([
    {
      label: 'Rows in scope',
      value: String(filtered.length),
      hint: `${range.startDate} to ${range.endDate}`,
    },
    {
      label: 'Open recon',
      value: String(reconciliationSummary.totalItems),
      hint: `${reconciliationSummary.matchStatusCounts.pending_match || 0} pending match`,
    },
    {
      label: 'Evidence ready',
      value: `${evidenceResolvedCount}/${evidenceSummary?.totalEvidence ?? 0}`,
      hint: 'digitized or resolved',
    },
    {
      label: 'Post-close delta',
      value: String(closeDelta.transactions.length),
      hint: latestClosedPeriod ? `since ${latestClosedPeriod.periodKey}` : 'no close baseline',
    },
  ]), [closeDelta.transactions.length, evidenceResolvedCount, evidenceSummary?.totalEvidence, filtered.length, latestClosedPeriod, range.endDate, range.startDate, reconciliationSummary.matchStatusCounts.pending_match, reconciliationSummary.totalItems]);
  const bookkeepingAuditSections = useMemo<FinanceAuditSection[]>(() => {
    const topExceptionReasons = reconExceptions
      .slice(0, 3)
      .map((exception) => exception.reason || exception.status || 'Open reconciliation exception');
    const topDriverBuckets = Array.from(
      filtered.reduce((acc, transaction) => {
        const key = String(transaction.category || transaction.accountCode || 'Uncategorized');
        const current = acc.get(key) || 0;
        acc.set(key, current + Math.abs(Number(transaction.amount || 0)));
        return acc;
      }, new Map<string, number>()),
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3);
    const topDeltaItems = closeDelta.topTransactions
      .slice(0, 2)
      .map((transaction) => ({
        title: transaction.description || transaction.category || 'Post-close ledger line',
        detail: `${fmtMoney(transaction.amount)} from ${classifyFinanceSource(transaction.source).label}.`,
        meta: transaction.date ? `posted ${fmtDate(transaction.date)}` : 'post-close activity',
      }));

    return [
      {
        label: 'Tie-outs',
        summary: 'Checks whether the visible ledger still lines up with the reports and close baseline that downstream surfaces depend on.',
        tone: sourceMix.hasSample ? 'amber' : 'emerald',
        items: [
          {
            title: trialBalanceReport
              ? `Trial balance ${trialBalanceReport.is_balanced ? 'balances' : 'does not balance'}`
              : 'Trial balance tie-out unavailable',
            detail: trialBalanceReport
              ? `As of ${fmtDate(trialBalanceReport.as_of_date)}, the report-center tie-out ${trialBalanceReport.is_balanced ? 'is aligned' : 'still needs reviewer attention'}.`
              : 'The bookkeeping rail cannot independently confirm ledger balance from this view until a trial balance is loaded.',
            meta: trialBalanceReport?.as_of_date ? `as of ${fmtDate(trialBalanceReport.as_of_date)}` : 'report-center dependency',
          },
          {
            title: cashAccount
              ? `Operating cash anchor is account ${cashAccount.code} (${cashAccount.name})`
              : 'Operating cash anchor is missing',
            detail: cashAccount
              ? `Current visible balance is ${fmtMoney(cashAccount.balance)} and is the cash reference point behind the overview cards.`
              : 'Account 1000 is not loaded in this owner scope, so cash tie-out confidence is limited.',
            meta: propertyAddress ? propertyAddress : 'portfolio scope',
          },
          {
            title: profitLossReport
              ? `P&L currently reads ${fmtMoney(profitLossReport.summary?.total_revenue)} of revenue against ${fmtMoney(profitLossReport.summary?.total_expenses)} of expenses`
              : 'P&L tie-out is unavailable',
            detail: profitLossReport
              ? `This matches the operating result the downstream tax and reporting surfaces inherit from the current ledger scope.`
              : 'No profit-and-loss report is loaded yet for this scope.',
            meta: `${filtered.length} ledger row${filtered.length === 1 ? '' : 's'} in view`,
          },
          {
            title: latestClosedPeriod
              ? `${closeDelta.transactions.length} entries were posted after close ${latestClosedPeriod.periodKey}`
              : 'No closed-period baseline exists yet',
            detail: latestClosedPeriod
              ? `${fmtMoney(closeDelta.income)} of income-side activity and ${fmtMoney(closeDelta.expenses)} of expense-side activity landed after the most recent close.`
              : 'Delta tracking will become more meaningful after the first close period is recorded.',
            meta: latestClosedPeriod ? 'post-close change control' : 'close baseline missing',
          },
        ],
      },
      {
        label: 'What is driving the numbers',
        summary: 'Largest drivers in the currently filtered ledger window, rather than a restatement of the top-level summary cards.',
        tone: topDriverBuckets.length > 0 ? 'slate' : 'amber',
        items: [
          {
            title: sourceMix.headline,
            detail: `${filtered.length} visible ledger row(s) are driving the bookkeeping overview, trace views, and close checks in this window.`,
            meta: sourceMix.hasSample ? 'mixed live and sample provenance' : 'live/manual provenance only',
          },
          ...(topDriverBuckets.length > 0
            ? topDriverBuckets.map(([label, amount], index) => ({
                title: `${label} is a top driver`,
                detail: `${fmtMoney(amount)} of absolute activity sits in this bucket within the current filters.`,
                meta: `driver ${index + 1}`,
              }))
            : [
                {
                  title: 'No driver breakout available',
                  detail: 'Load ledger activity or widen the filters to see which categories are materially driving the current window.',
                  meta: 'waiting on scoped transactions',
                },
              ]),
        ],
      },
      {
        label: 'Exceptions and evidence gaps',
        summary: 'Open exceptions, evidence gaps, and categorization holes that can still change the final accounting story.',
        tone: reconciliationSummary.totalItems > 0 || openClosePeriods.length > 0 ? 'rose' : 'slate',
        items: [
          {
            title: reconciliationSummary.totalItems > 0
              ? `${reconciliationSummary.totalItems} reconciliation exception(s) remain open`
              : 'No reconciliation exceptions are open',
            detail: reconciliationSummary.totalItems > 0
              ? `${reconciliationSummary.matchStatusCounts.pending_match || 0} pending match and ${reconciliationSummary.matchStatusCounts.pending_review || 0} pending review item(s) are still unresolved.`
              : 'The visible ledger window is currently clear of pending match/review exceptions.',
            meta: topExceptionReasons.length > 0 ? topExceptionReasons.join(' · ') : 'no dominant exception reason',
          },
          {
            title: evidenceSummary
              ? `${evidenceResolvedCount} of ${evidenceSummary.totalEvidence} evidence records are reviewer-ready`
              : 'Evidence coverage has not loaded',
            detail: evidenceSummary
              ? evidencePendingCount > 0
                ? `${evidencePendingCount} evidence item(s) still need OCR or digitization follow-up before the ledger story is fully supportable.`
                : 'Visible indexed evidence is digitized or otherwise resolved.'
              : 'This workspace has not loaded indexed finance evidence yet.',
            meta: evidencePendingCount > 0 ? 'OCR or digitization still pending' : 'traceability looks complete',
          },
          {
            title: pendingFinanceDocuments.length > 0
              ? `${pendingFinanceDocuments.length} uploaded finance document(s) still need follow-up`
              : 'No finance documents are waiting on follow-up',
            detail: pendingFinanceDocuments.length > 0
              ? 'These documents are still waiting on OCR, evidence shadowing, or metadata completion.'
              : 'Uploaded bookkeeping support documents are not currently blocking review from this queue.',
            meta: closeDelta.uncategorizedCount > 0 ? `${closeDelta.uncategorizedCount} post-close lines also need categorization review` : 'no visible categorization gap after close',
          },
          ...topDeltaItems,
        ],
      },
      {
        label: 'Review next',
        summary: 'Highest-signal follow-ups for a reviewer to resolve before trusting the numbers for close, reporting, or tax handoff.',
        tone: taxPacketReadiness?.readinessStatus === 'ready' ? 'emerald' : 'amber',
        items: [
          {
            title: reconciliationSummary.totalItems > 0
              ? 'Clear the reconciliation queue first'
              : 'Reconciliation queue is not the current blocker',
            detail: reconciliationSummary.totalItems > 0
              ? 'Unmatched or pending-review items are the most direct reason final balances could still move.'
              : 'Shift reviewer time toward evidence and close-baseline completeness.',
            meta: `${reconciliationSummary.totalItems} open recon item(s)`,
          },
          {
            title: evidencePendingCount > 0 || pendingFinanceDocuments.length > 0
              ? 'Finish OCR and evidence capture on outstanding support'
              : 'Evidence support is materially in place',
            detail: evidencePendingCount > 0 || pendingFinanceDocuments.length > 0
              ? 'Resolve document ingestion before treating the close as fully supportable.'
              : 'Current evidence gaps are not the main blocker in this scope.',
            meta: `${evidencePendingCount} evidence gap(s) · ${pendingFinanceDocuments.length} pending document(s)`,
          },
          {
            title: taxPacketReadiness?.readinessStatus
              ? `Downstream tax readiness is ${String(taxPacketReadiness.readinessStatus).replace(/_/g, ' ')}`
              : 'Downstream tax readiness is not loaded',
            detail: taxPacketReadiness?.readinessStatus
              ? `Current score ${taxPacketReadiness.score != null ? taxPacketReadiness.score : 'n/a'} reflects how cleanly this ledger can roll into the tax packet.`
              : 'No downstream tax-packet readiness signal is currently loaded from finance services.',
            meta: budgetComparison?.summary
              ? `${budgetComparison.summary.overBudgetCategories} category${budgetComparison.summary.overBudgetCategories === 1 ? '' : 'ies'} over budget`
              : 'budget variance not loaded',
          },
        ],
      },
    ];
  }, [budgetComparison?.summary, cashAccount, closeDelta.expenses, closeDelta.income, closeDelta.topTransactions, closeDelta.transactions.length, closeDelta.uncategorizedCount, evidencePendingCount, evidenceResolvedCount, evidenceSummary, filtered, latestClosedPeriod, openClosePeriods.length, pendingFinanceDocuments.length, profitLossReport, propertyAddress, reconExceptions, reconciliationSummary.matchStatusCounts.pending_match, reconciliationSummary.matchStatusCounts.pending_review, reconciliationSummary.totalItems, sourceMix.hasSample, sourceMix.headline, taxPacketReadiness, trialBalanceReport]);
  const bookkeepingAuditAskContext = useMemo(() => ({
    scope: propertyAddress || 'All properties',
    propertyId: propertyId || null,
    ledgerWindow: { startDate: range.startDate, endDate: range.endDate },
    rowsInScope: filtered.length,
    sourceMix: {
      headline: sourceMix.headline,
      hasSample: sourceMix.hasSample,
      samplePct: sourceMix.samplePct,
    },
    summary: {
      netIncome: summary?.netIncome ?? null,
      totalIncome: summary?.totalIncome ?? null,
      totalExpenses: summary?.totalExpenses ?? null,
      cashBalance: visibleCashBalance,
    },
    reconciliation: {
      openItems: reconciliationSummary.totalItems,
      pendingMatch: reconciliationSummary.matchStatusCounts.pending_match || 0,
      pendingReview: reconciliationSummary.matchStatusCounts.pending_review || 0,
    },
    evidence: {
      total: evidenceSummary?.totalEvidence ?? 0,
      resolved: evidenceResolvedCount,
      pending: evidencePendingCount,
    },
    close: {
      openPeriods: openClosePeriods.length,
      latestClosedPeriod: latestClosedPeriod?.periodKey || null,
      postCloseEntries: closeDelta.transactions.length,
    },
    documentsPendingFollowUp: pendingFinanceDocuments.length,
    trialBalance: trialBalanceReport
      ? { isBalanced: Boolean(trialBalanceReport.is_balanced), asOfDate: trialBalanceReport.as_of_date || null }
      : null,
    taxPacketReadiness: taxPacketReadiness
      ? { status: taxPacketReadiness.readinessStatus || null, score: taxPacketReadiness.score ?? null }
      : null,
  }), [closeDelta.transactions.length, evidencePendingCount, evidenceResolvedCount, evidenceSummary?.totalEvidence, filtered.length, latestClosedPeriod?.periodKey, openClosePeriods.length, pendingFinanceDocuments.length, propertyAddress, propertyId, range.endDate, range.startDate, reconciliationSummary.matchStatusCounts.pending_match, reconciliationSummary.matchStatusCounts.pending_review, reconciliationSummary.totalItems, sourceMix.hasSample, sourceMix.headline, sourceMix.samplePct, summary?.netIncome, summary?.totalExpenses, summary?.totalIncome, taxPacketReadiness, trialBalanceReport, visibleCashBalance]);

  // Sub-tab navigation + AI assistant section registry
  const workspaceNav = useWorkspaceNav('bookkeeping', BOOKKEEPING_TABS, BOOKKEEPING_SECTIONS);
  const activeWorkspaceTab = workspaceNav.activeTab;

  const assistantLocalSummary = useMemo(() => {
    if (!summary) return 'Bookkeeping workspace is loading your ledger window…';
    const parts: string[] = [
      `Net ${fmtMoney(summary.netIncome)} on ${fmtMoney(summary.totalIncome)} income across ${filtered.length} transaction${filtered.length === 1 ? '' : 's'}`,
    ];
    if (reconciliationSummary.totalItems > 0) {
      parts.push(`${reconciliationSummary.totalItems} reconciliation exception${reconciliationSummary.totalItems === 1 ? '' : 's'} need review`);
    }
    if (pendingFinanceDocuments.length > 0) {
      parts.push(`${pendingFinanceDocuments.length} document${pendingFinanceDocuments.length === 1 ? '' : 's'} awaiting follow-up`);
    }
    if (taxPacketReadiness?.readinessStatus) {
      parts.push(`tax packet ${String(taxPacketReadiness.readinessStatus).replace(/_/g, ' ')}`);
    }
    return `${parts.join(' · ')}.`;
  }, [filtered.length, pendingFinanceDocuments.length, reconciliationSummary.totalItems, summary, taxPacketReadiness?.readinessStatus]);

  function drillIntoLedger(next: {
    type?: 'all' | 'income' | 'expense';
    category?: string;
    account?: string;
  }) {
    setTypeFilter(next.type ?? 'all');
    setCategoryFilter(next.category ?? 'all');
    setAccountFilter(next.account ?? 'all');
  }

  // Not-initialized gate
  if (!bookkeeping.user) {
    return (
      <Card className="p-6 text-sm text-slate-600">
        Sign in to view bookkeeping.
      </Card>
    );
  }
  if (!bookkeeping.isInitialized) {
    return (
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Initialize Bookkeeping</h3>
            <p className="mt-1 text-sm text-slate-600">
              Sets up your chart of accounts and connects this user to the canonical Azure ledger.
              No real money or data is moved.
            </p>
          </div>
          <button
            onClick={() => bookkeeping.initialize()}
            disabled={bookkeeping.isLoading}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {bookkeeping.isLoading ? 'Initializing…' : 'Initialize'}
          </button>
        </div>
        {bookkeeping.error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {bookkeeping.error}
          </div>
        )}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header / scope */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {propertyAddress ? propertyAddress : 'All properties'}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">Rental income & expenses</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-600">
              <div className="mb-1 font-medium">From</div>
              <input
                type="date"
                value={range.startDate}
                onChange={(e) => setRange({ ...range, startDate: e.target.value })}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              <div className="mb-1 font-medium">To</div>
              <input
                type="date"
                value={range.endDate}
                onChange={(e) => setRange({ ...range, endDate: e.target.value })}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button
              onClick={applyRange}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              Apply
            </button>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3">
          <WorkspaceSubTabs nav={workspaceNav} embedded />
        </div>
        <FinanceAssistantHeader
          surface="bookkeeping"
          localSummary={assistantLocalSummary}
          getContext={() => bookkeepingAuditAskContext}
          nav={workspaceNav}
          embedded
          suggestions={[
            'Give me a beginner-friendly overview of this page',
            'What should I review before closing this period?',
            'Why are there open reconciliation exceptions?',
            'Where do I see profit and loss?',
          ]}
          summaryRefreshKey={summary ? `${range.startDate}:${range.endDate}` : undefined}
        />
      </Card>

      {/* Data source banner — admin only */}
      <div className="hidden"><FinanceSourceTruthBanner
        sourceMix={sourceMix}
        scopeLabel="Canonical ledger window"
        note={`${sampleNote ? `${sampleNote} ` : ''}This same source mix drives the bookkeeping summary cards, trace drilldowns, and downstream tax/export surfaces.`}
        actions={(
          <>
            <button
              onClick={loadSampleData}
              disabled={loadingSample}
              className="rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {loadingSample ? 'Loading…' : 'Load sample feed'}
            </button>
            {sourceMix.hasSample && (
              <button
                onClick={clearSampleData}
                disabled={clearingSample}
                className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50"
              >
                {clearingSample ? 'Clearing…' : 'Clear sample data'}
              </button>
            )}
            {sourceMix.hasLive && (
              <button
                onClick={clearLiveTransactionsInWindow}
                disabled={clearingLive}
                className="rounded-md border border-rose-300 bg-white px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                {clearingLive ? 'Clearing…' : 'Clear live data in window'}
              </button>
            )}
          </>
        )}
      /></div>

      {bookkeeping.error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {bookkeeping.error}
        </div>
      )}

      <div className={isAuditRailOpen ? 'grid grid-cols-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)] xl:items-start' : ''}>
        {isAuditRailOpen && (
          <FinanceAuditRail
            title="Bookkeeping audit snapshot"
            subtitle="Owner-facing control view across ledger provenance, tie-outs, exceptions, evidence support, and next review actions."
            disclaimer="AI-assisted audit guidance only. Review the posted ledger, reconciliation queue, and supporting evidence before relying on this for accounting or filing decisions."
            statusLabel={bookkeepingAuditStatus.label}
            statusTone={bookkeepingAuditStatus.tone}
            statusDetail={bookkeepingAuditStatus.detail}
            statusMeta={[
              propertyAddress ? propertyAddress : 'All properties',
              `${range.startDate} to ${range.endDate}`,
              sourceMix.headline,
            ]}
            metrics={bookkeepingAuditMetrics}
            flags={bookkeepingAuditFlags}
            sections={bookkeepingAuditSections}
            ask={{
              surface: 'bookkeeping',
              getContext: () => bookkeepingAuditAskContext,
              suggestions: [
                'Why are there open reconciliation exceptions?',
                'What should I review before closing this period?',
                'Is my evidence coverage good enough for a CPA?',
              ],
            }}
          />
        )}
        <div className="flex flex-col gap-4">
      {/* ----- Summary tab ----- */}
      <div className={activeWorkspaceTab === 'overview' ? 'order-1 space-y-4' : 'hidden'}>
      <SectionHost sectionId="executive-overview" nav={workspaceNav}>
      <Card>
        <div className="grid grid-cols-3 gap-px bg-slate-100">
          {[
            { label: 'Rental income', value: fmtMoney(summary?.totalIncome), sub: `${range.startDate} – ${range.endDate}` },
            { label: 'Total expenses', value: fmtMoney(summary?.totalExpenses), sub: 'Operating costs' },
            { label: 'Net income', value: fmtMoney(summary?.netIncome), sub: (summary?.netIncome ?? 0) >= 0 ? 'Profitable period' : 'Net loss', negative: (summary?.netIncome ?? 0) < 0 },
          ].map((s) => (
            <div key={s.label} className="bg-white px-5 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">{s.label}</div>
              <div className={`mt-1 text-2xl font-bold tabular-nums ${(s as any).negative ? 'text-rose-600' : 'text-slate-900'}`}>{s.value}</div>
              <div className="mt-0.5 text-xs text-slate-500">{s.sub}</div>
            </div>
          ))}
        </div>
        {/* hidden expert content below */}
        <div className="hidden"><CardHeader
          title="Executive overview"
          subtitle="Cash, operating performance, close pressure, and current tax-packet readiness on one owner screen."
          right={taxPacketReadiness?.score != null ? <span className="text-xs text-slate-500">Tax score {taxPacketReadiness.score}</span> : undefined}
        />
        <div className="grid grid-cols-2 gap-3 p-5 xl:grid-cols-6">
          <Stat
            label="Cash balance"
            value={fmtMoney(visibleCashBalance)}
            hint="Canonical operating cash"
            active={openExecutiveExplanationId === 'cash-balance'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'cash-balance' ? '' : 'cash-balance')}
          />
          <Stat
            label="NOI"
            value={fmtMoney(summary?.netIncome)}
            hint="Current ledger-window operating result"
            active={openExecutiveExplanationId === 'noi'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'noi' ? '' : 'noi')}
          />
          <Stat
            label="Margin"
            value={operatingMarginPct != null ? `${operatingMarginPct.toFixed(1)}%` : '—'}
            hint="Net divided by posted income"
            active={openExecutiveExplanationId === 'margin'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'margin' ? '' : 'margin')}
          />
          <Stat
            label="Reserve runway"
            value={reserveRunwayMonths != null ? `${reserveRunwayMonths.toFixed(1)} mo` : '—'}
            hint={reserveRunwayMonths != null ? `${fmtMoney(averageMonthlyExpenses)} monthly burn baseline` : 'Need expense trend history'}
            active={openExecutiveExplanationId === 'reserve-runway'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'reserve-runway' ? '' : 'reserve-runway')}
          />
          <Stat
            label="Open exceptions"
            value={String(reconciliationSummary.totalItems)}
            hint="Reconciliation items still in review"
            active={openExecutiveExplanationId === 'open-exceptions'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'open-exceptions' ? '' : 'open-exceptions')}
          />
          <Stat
            label="Packet readiness"
            value={String(taxPacketReadiness?.readinessStatus || 'not_loaded').replace(/_/g, ' ')}
            hint="Portfolio-level tax handoff status"
            active={openExecutiveExplanationId === 'packet-readiness'}
            onClick={() => setOpenExecutiveExplanationId((current) => current === 'packet-readiness' ? '' : 'packet-readiness')}
          />
        </div>
        {selectedExecutiveExplanation && openExecutiveExplanationId && (
          <div className="border-t border-slate-100 px-5 py-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="font-medium text-slate-900">{selectedExecutiveExplanation.title}</div>
              <div className="mt-1 text-sm text-slate-600">{selectedExecutiveExplanation.detail}</div>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
              <ul className="mt-2 space-y-2 text-xs text-slate-600">
                {selectedExecutiveExplanation.citations.map((citation) => (
                  <li key={citation} className="rounded-lg border border-white bg-white px-3 py-2">
                    {citation}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {taxPacketReadiness?.summary && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{taxPacketReadiness.summary}</div>
        )}
      </div>
      </Card>
      </SectionHost>

      {/* Summary cards — now hidden, stats moved into header strip above */}
      <div className="hidden"><SectionHost sectionId="income-expense-snapshot" nav={workspaceNav}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Income"
          value={fmtMoney(summary?.totalIncome)}
          hint="Posted income, current window"
          active={typeFilter === 'income' && categoryFilter === 'all'}
          onClick={() => drillIntoLedger({ type: typeFilter === 'income' && categoryFilter === 'all' ? 'all' : 'income' })}
        />
        <Stat
          label="Expenses"
          value={fmtMoney(summary?.totalExpenses)}
          hint="Posted expenses, current window"
          active={typeFilter === 'expense' && categoryFilter === 'all'}
          onClick={() => drillIntoLedger({ type: typeFilter === 'expense' && categoryFilter === 'all' ? 'all' : 'expense' })}
        />
        <Stat
          label="Net"
          value={fmtMoney(summary?.netIncome)}
          hint={
            (summary?.totalIncome || 0) > 0
              ? `${(((summary?.netIncome || 0) / (summary?.totalIncome || 1)) * 100).toFixed(1)}% margin`
              : '—'
          }
        />
        <Stat
          label="Operating Cash"
          value={fmtMoney(cashAccount?.balance)}
          hint="Account 1000 balance"
        />
      </div>
      </SectionHost></div>

      {/* explain-totals — expert/admin only */}
      <div className="hidden"><SectionHost sectionId="explain-totals" nav={workspaceNav}>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
      <Card>
        <CardHeader
          title="Explain these totals"
          subtitle="Citation-first explanations for the live bookkeeping totals using posted buckets, ledger scope, and account balances already in view."
        />
        <div className="grid grid-cols-1 gap-4 px-5 py-4 xl:grid-cols-1 lg:grid-cols-2">
          {bookkeepingSummaryExplanations.map((item) => (
            <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="font-medium text-slate-900">{item.title}</div>
              <div className="mt-1 text-sm text-slate-600">{item.detail}</div>
              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
              <ul className="mt-2 space-y-2 text-xs text-slate-600">
                {item.citations.map((citation) => (
                  <li key={citation} className="rounded-lg border border-white bg-white px-3 py-2">
                    {citation}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <div className="hidden"><Card>
        <CardHeader
          title="Summary trace"
          subtitle="Click a bucket to filter the ledger down to the journal lines behind that total."
          right={
            (typeFilter !== 'all' || categoryFilter !== 'all' || accountFilter !== 'all') ? (
              <button
                type="button"
                onClick={() => drillIntoLedger({ type: 'all', category: 'all', account: 'all' })}
                className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear trace drilldown
              </button>
            ) : null
          }
        />
        <div className="grid grid-cols-1 gap-4 px-5 py-4 xl:grid-cols-1 lg:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Income buckets</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {incomeBuckets.length > 0 ? incomeBuckets.map((bucket) => {
                const isActive = typeFilter === 'income' && categoryFilter === bucket.category;
                return (
                  <button
                    key={`income-${bucket.category}`}
                    type="button"
                    onClick={() => drillIntoLedger({ type: isActive ? 'all' : 'income', category: isActive ? 'all' : bucket.category, account: 'all' })}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                      isActive
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {bucket.category} · {fmtMoney(bucket.amount)}
                  </button>
                );
              }) : (
                <div className="text-xs text-slate-500">No posted income buckets in this window.</div>
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Expense buckets</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {expenseBuckets.length > 0 ? expenseBuckets.map((bucket) => {
                const isActive = typeFilter === 'expense' && categoryFilter === bucket.category;
                return (
                  <button
                    key={`expense-${bucket.category}`}
                    type="button"
                    onClick={() => drillIntoLedger({ type: isActive ? 'all' : 'expense', category: isActive ? 'all' : bucket.category, account: 'all' })}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                      isActive
                        ? 'border-rose-300 bg-rose-50 text-rose-900'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {bucket.category} · {fmtMoney(bucket.amount)}
                  </button>
                );
              }) : (
                <div className="text-xs text-slate-500">No posted expense buckets in this window.</div>
              )}
            </div>
          </div>
        </div>
      </Card>
      </div>
      </div>
      </SectionHost></div>

      <SectionHost sectionId="analytics" nav={workspaceNav}>
      <BookkeepingAnalyticsWorkspace
        summary={summary}
        cashflowTrend={bookkeeping.cashflowTrend}
        transactions={bookkeeping.transactions}
        cashBalance={visibleCashBalance}
        propertyCashBalances={propertyCashBalances}
        reconExceptions={reconExceptions}
        evidenceTotalCount={evidenceSummary?.totalEvidence ?? 0}
        evidencePendingCount={evidencePendingCount}
        pendingFinanceDocumentsCount={pendingFinanceDocuments.length}
        onSelectCategory={(type, category) => drillIntoLedger({ type, category, account: 'all' })}
        onSelectVendor={(vendor) => setVendorFilter(vendor)}
      />
      </SectionHost>
      </div>

      {/* ----- Reports & Budget tab ----- */}
      <div className={activeWorkspaceTab === 'reports' ? 'order-1 space-y-4' : 'hidden'}>
      <SectionHost sectionId="report-center" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="Download income statements, expense summaries, and other reports for your records or to share with your accountant."
          title="Reports & downloads"
          subtitle={`${range.startDate} to ${range.endDate}`}
        />
        <div className="grid grid-cols-2 gap-3 p-5 xl:grid-cols-4">
          <Stat
            label="Budgeted"
            value={fmtMoney(budgetComparison?.summary?.totalBudgeted)}
            hint={budgetComparison ? `${budgetComparison.year} report-center scope` : 'No budget comparison loaded'}
            explain={reportCenterExplainFor('budget-posture')}
          />
          <Stat
            label="Actual"
            value={fmtMoney(budgetComparison?.summary?.totalActual)}
            hint={budgetComparison ? `${budgetComparison.summary?.utilizationPercent || 0}% utilized` : 'No actual budget comparison yet'}
            explain={reportCenterExplainFor('budget-posture')}
          />
          <Stat
            label="Variance"
            value={fmtMoney(budgetComparison?.summary?.totalVariance)}
            hint={budgetComparison ? `${budgetComparison.summary?.overBudgetCategories || 0} categories over budget` : 'Budget variance not loaded'}
            explain={reportCenterExplainFor('budget-posture')}
          />
          <Stat
            label="Trial balance"
            value={trialBalanceReport?.is_balanced ? 'Balanced' : 'Check'}
            hint={trialBalanceReport ? `Debits ${fmtMoney(trialBalanceReport.total_debits)} · Credits ${fmtMoney(trialBalanceReport.total_credits)}` : 'No trial balance loaded'}
            explain={reportCenterExplainFor('report-center')}
          />
        </div>

        {reportCenterNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-700">{reportCenterNote}</div>
        )}

        <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)]">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Budget vs actual</div>
                <div className="mt-1 text-xs text-slate-500">Edit monthly category budgets and drill back into the ledger rows behind overspend.</div>
              </div>
              <button
                type="button"
                onClick={initializeDefaultBudgets}
                disabled={reportCenterBusy}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {reportCenterBusy ? 'Working…' : 'Initialize default budgets'}
              </button>
            </div>

            {budgetRowsForDisplay.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-4 text-sm text-slate-500">
                No budget rows are available yet for this owner scope.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {budgetRowsForDisplay.slice(0, 10).map((row) => {
                  const editing = budgetEditDraft?.accountCode === row.accountCode;
                  return (
                    <div key={row.accountCode} className="rounded-xl border border-white bg-white px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium text-slate-900">{row.category}</div>
                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                              acct {row.accountCode}
                            </span>
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${budgetVariancePillClass(row.status)}`}>
                              {row.status === 'over_budget' ? 'Over budget' : 'Within budget'}
                            </span>
                          </div>
                          <div className="mt-1 text-sm text-slate-600">
                            {fmtMoney(row.actual)} actual vs {fmtMoney(row.expectedBudget)} budgeted · {row.utilizationPercent}% utilized
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            Monthly {fmtMoney(row.monthlyBudget)} · Annual {fmtMoney(row.annualBudget)} · Variance {fmtMoney(row.variance)} ({row.variancePercent.toFixed(1)}%)
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => drillIntoLedger({ type: 'expense', category: 'all', account: row.accountCode })}
                            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Inspect ledger
                          </button>
                          {!editing ? (
                            <button
                              type="button"
                              onClick={() => setBudgetEditDraft({
                                accountCode: row.accountCode,
                                category: row.category,
                                monthlyBudget: String(row.monthlyBudget || 0),
                              })}
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Edit budget
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {editing && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                          <label className="text-xs text-slate-600">
                            <div className="mb-1 font-medium">Monthly budget</div>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={budgetEditDraft.monthlyBudget}
                              onChange={(event) => setBudgetEditDraft({ ...budgetEditDraft, monthlyBudget: event.target.value })}
                              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={saveBudgetDraft}
                            disabled={reportCenterBusy}
                            className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setBudgetEditDraft(null)}
                            disabled={reportCenterBusy}
                            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900">Trial balance</div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${reportStatusPillClass(Boolean(trialBalanceReport?.is_balanced))}`}>
                  {trialBalanceReport?.is_balanced ? 'Balanced' : 'Needs review'}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500">As of {trialBalanceReport?.as_of_date || range.endDate}</div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Debits</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(trialBalanceReport?.total_debits)}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Credits</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(trialBalanceReport?.total_credits)}</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Profit & loss</div>
              <div className="mt-2 text-xs text-slate-500">{profitLossReport?.period?.start || range.startDate} to {profitLossReport?.period?.end || range.endDate}</div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Revenue</div>
                  <div className="mt-1 text-lg font-semibold text-emerald-700">{fmtMoney(profitLossReport?.summary?.total_revenue)}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Expenses</div>
                  <div className="mt-1 text-lg font-semibold text-rose-700">{fmtMoney(profitLossReport?.summary?.total_expenses)}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Net</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(profitLossReport?.summary?.net_income)}</div>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {profitLossReport?.expenses?.slice(0, 4).map((row) => (
                  <button
                    key={`expense-${row.code}`}
                    type="button"
                    onClick={() => drillIntoLedger({ type: 'expense', category: 'all', account: row.code })}
                    className="flex w-full items-center justify-between rounded-lg border border-white bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="text-slate-700">{row.name}</span>
                    <span className="font-semibold text-slate-900">{fmtMoney(row.amount)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-sm font-semibold text-slate-900">Balance sheet</div>
              <div className="mt-2 text-xs text-slate-500">As of {balanceSheetReport?.as_of_date || range.endDate}</div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Assets</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(balanceSheetReport?.total_assets)}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Liabilities</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(balanceSheetReport?.total_liabilities)}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-3">
                  <div className="font-semibold uppercase tracking-wider text-slate-500">Equity</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{fmtMoney(balanceSheetReport?.total_equity)}</div>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-slate-500">
                {balanceSheetReport?.is_balanced ? 'Assets equal liabilities plus equity in the current balance sheet snapshot.' : 'Balance sheet does not currently tie out and should be reviewed.'}
              </div>
            </div>
          </div>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Bank/Stripe feeds — hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionGroupHeader title="Live data feeds" accent="indigo" hint="Connected bank and Stripe activity flows into the ledger automatically." />
      <SectionHost sectionId="bank-sync" nav={workspaceNav}>
      {/* Stripe / bank sync */}
      <Card>
        <CardHeader
          title="Bank & Stripe sync"
          subtitle="Real feeds post into the canonical ledger via idempotent finance-event ingestion."
        />
        <div className="px-5 py-4">
          <StripeBookkeepingIntegration
            userId={userId || 'demo-user'}
            userEmail={userEmail || 'demo@example.com'}
            propertyId={propertyId}
            onTransactionsSynced={() => {
              bookkeeping.fetchData(dashboardScope);
              loadPipeline();
            }}
          />
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Categorization cleanup — expert only, hidden ----- */}
      <div className="hidden">
      <SectionGroupHeader title="Categorization cleanup" accent="sky" hint="Keep every transaction filed under the right account so reports and tax mapping stay accurate." />
      <SectionHost sectionId="ai-categorization" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="AI categorization review"
          subtitle="Read-only Gemini suggestions on the current ledger window. The first release stages citations and rationale only; any posting or reclassification still requires explicit manual action elsewhere in the shell."
          right={
            <div className="flex flex-wrap gap-2">
              {aiCategorizationSuggestions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setAiCategorizationSuggestions([]);
                    setAiCategorizationTargets([]);
                    setAiCategorizationNote(null);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Reset review
                </button>
              )}
              <button
                type="button"
                onClick={runAICategorizationReview}
                disabled={aiCategorizationBusy !== 'idle' || aiCategorizationCandidates.length === 0}
                className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100 disabled:opacity-50"
              >
                {aiCategorizationBusy === 'running' ? 'Running AI…' : `Run AI on ${aiCategorizationCandidates.length}`}
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-3">
          <Stat
            label="Review candidates"
            value={String(aiCategorizationCandidates.length)}
            hint="Based on the current ledger filters"
          />
          <Stat
            label="Needs review"
            value={String(filtered.filter(transactionNeedsCategorizationReview).length)}
            hint="Missing tax map, account code, or using a generic category"
          />
          <Stat
            label="Staged suggestions"
            value={String(aiCategorizationSuggestions.length)}
            hint="Read-only suggestions for manual follow-up"
          />
        </div>
        {aiCategorizationNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{aiCategorizationNote}</div>
        )}
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          This review surface does not post, recategorize, or file anything automatically. Use the suggestions as citation-heavy guidance, then make explicit human-approved changes through the normal bookkeeping controls.
        </div>
        <div className="border-t border-slate-100 px-5 py-4">
          {aiCategorizationSuggestions.length > 0 ? (
            <div className="space-y-3">
              {aiCategorizationSuggestions.map((suggestion) => {
                const transaction = aiCategorizationTargets[suggestion.index - 1];
                if (!transaction) return null;
                return (
                  <div key={`${transaction.id}-${suggestion.index}`} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="font-medium text-slate-900">{transaction.description || transaction.category || 'Transaction'}</div>
                        <div className="mt-1 text-sm text-slate-600">{fmtMoney(transaction.amount)} · {fmtDate(transaction.date)} · {transaction.vendor || transaction.source || 'No vendor/source recorded'}</div>
                        <div className="mt-1 text-xs text-slate-500">Current: {transaction.category || 'Uncategorized'}{transaction.accountCode ? ` · account ${transaction.accountCode}` : ''}{transaction.scheduleELine ? ` · Schedule E ${transaction.scheduleELine}` : ''}</div>
                      </div>
                      <div className="rounded-xl border border-white bg-white px-4 py-3 text-sm text-slate-700 xl:min-w-[280px]">
                        <div className="font-semibold text-slate-900">Suggested: {suggestion.category}</div>
                        <div className="mt-1">Account {suggestion.accountCode || '—'}{suggestion.scheduleELine ? ` · Schedule E ${suggestion.scheduleELine}` : ''}</div>
                        <div className="mt-1">Confidence {(Number(suggestion.confidence || 0) * 100).toFixed(0)}%</div>
                        <div className="mt-2 text-xs text-slate-500">{suggestion.reason || 'No rationale returned from the AI categorizer.'}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : aiCategorizationCandidates.length > 0 ? (
            <div className="space-y-3">
              {aiCategorizationCandidates.slice(0, 8).map((transaction) => (
                <div key={transaction.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <div className="font-medium text-slate-900">{transaction.description || transaction.category || 'Transaction'}</div>
                      <div className="mt-1 text-xs text-slate-500">{fmtMoney(transaction.amount)} · {fmtDate(transaction.date)} · {transaction.category || 'Uncategorized'}{transaction.accountCode ? ` · account ${transaction.accountCode}` : ''}</div>
                    </div>
                    {transactionNeedsCategorizationReview(transaction) && (
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-800">
                        Needs review
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {aiCategorizationCandidates.length > 8 && (
                <div className="text-xs text-slate-500">Showing 8 of {aiCategorizationCandidates.length} candidate rows from the current ledger window.</div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
              No transactions in the current ledger window are available for AI categorization review.
            </div>
          )}
        </div>
      </Card>
      </SectionHost>

      <SectionHost sectionId="categorization-rules" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Canonical categorization rules"
          subtitle="Owner-scoped fallback rules for repeatable ledger cleanup. Applying them reclassifies the existing journal entries through the same canonical backend flow as manual review."
          right={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={applyCategorizationRules}
                disabled={categorizationRuleApplyBusy || categorizationRules.length === 0}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
              >
                {categorizationRuleApplyBusy ? 'Applying…' : 'Apply rules'}
              </button>
              <button
                type="button"
                onClick={() => setShowCategorizationRuleForm((current) => !current)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {showCategorizationRuleForm ? 'Hide form' : 'New rule'}
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-3">
          <Stat
            label="Active rules"
            value={String(categorizationRuleStats?.totalActiveRules ?? categorizationRules.length)}
            hint="Saved on the owner-scoped bookkeeping backend"
          />
          <Stat
            label="Review candidates"
            value={String(categorizationRuleStats?.reviewCandidates ?? aiCategorizationCandidates.length)}
            hint="Simple cash entries needing a stronger account map"
          />
          <Stat
            label="Top rule hits"
            value={String(categorizationRuleStats?.topMatchingRules?.[0]?.matchCount || 0)}
            hint={categorizationRuleStats?.topMatchingRules?.[0]?.ruleName || 'No matching rules yet'}
          />
        </div>
        {categorizationRuleNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{categorizationRuleNote}</div>
        )}
        {showCategorizationRuleForm && (
          <form onSubmit={createCategorizationRule} className="grid grid-cols-1 gap-3 border-t border-slate-100 px-5 py-4 md:grid-cols-6">
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Rule name</div>
              <input
                type="text"
                value={categorizationRuleDraft.ruleName}
                onChange={(e) => setCategorizationRuleDraft({ ...categorizationRuleDraft, ruleName: e.target.value })}
                placeholder="Monthly utility vendors"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Match field</div>
              <select
                value={categorizationRuleDraft.matchType}
                onChange={(e) => setCategorizationRuleDraft({ ...categorizationRuleDraft, matchType: e.target.value as CategorizationRuleMatchType })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {CATEGORIZATION_RULE_MATCH_TYPES.map((matchType) => (
                  <option key={matchType} value={matchType}>{matchType}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Pattern</div>
              <input
                type="text"
                value={categorizationRuleDraft.matchPattern}
                onChange={(e) => setCategorizationRuleDraft({ ...categorizationRuleDraft, matchPattern: e.target.value })}
                placeholder={categorizationRuleDraft.matchType === 'AMOUNT' ? '>=250 or 100-200' : 'duke energy'}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Priority</div>
              <input
                type="number"
                min="1"
                value={categorizationRuleDraft.priority}
                onChange={(e) => setCategorizationRuleDraft({ ...categorizationRuleDraft, priority: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-4">
              <div className="mb-1 font-medium">Target account</div>
              <select
                value={categorizationRuleDraft.accountCode}
                onChange={(e) => setCategorizationRuleDraft({ ...categorizationRuleDraft, accountCode: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {revenueExpenseAccounts.map((account) => (
                  <option key={account.code} value={account.code}>{account.code} · {account.name}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end justify-end md:col-span-2">
              <button
                type="submit"
                disabled={categorizationRuleBusy}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {categorizationRuleBusy ? 'Saving…' : 'Save rule'}
              </button>
            </div>
          </form>
        )}
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="space-y-3 xl:col-span-2">
              {categorizationRules.length > 0 ? categorizationRules.map((rule) => {
                const actionBusy = categorizationRuleActionId === rule.id;
                return (
                  <div key={rule.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">{rule.ruleName}</span>
                          <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-sky-800">
                            {rule.matchType}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-600">Pattern: {rule.matchPattern}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {(rule.accountName || rule.accountCode) ? `${rule.accountCode} · ${rule.accountName || 'Canonical account'}` : 'No target account'}
                          {rule.propertyId ? ' · Property scoped' : ' · Applies across properties'}
                          {rule.priority != null ? ` · Priority ${rule.priority}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeCategorizationRule(rule)}
                        disabled={actionBusy}
                        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      >
                        {actionBusy ? 'Saving…' : 'Deactivate'}
                      </button>
                    </div>
                  </div>
                );
              }) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                  No canonical categorization rules are configured yet. Add one here for repeat vendors, memo patterns, or amount ranges that should resolve through the owner-scoped backend.
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Rule mix</div>
                <div className="mt-3 space-y-2 text-sm text-slate-700">
                  {(categorizationRuleStats?.rulesByType || []).length > 0 ? (categorizationRuleStats?.rulesByType || []).map((item) => (
                    <div key={item.matchType} className="flex items-center justify-between">
                      <span>{item.matchType}</span>
                      <span className="font-semibold text-slate-900">{item.count}</span>
                    </div>
                  )) : (
                    <div className="text-slate-500">Save rules to see the backend rule mix.</div>
                  )}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Top matches</div>
                <div className="mt-3 space-y-3 text-sm text-slate-700">
                  {(categorizationRuleStats?.topMatchingRules || []).length > 0 ? (categorizationRuleStats?.topMatchingRules || []).map((item) => (
                    <div key={item.ruleId} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-3">
                      <div className="font-medium text-slate-900">{item.ruleName}</div>
                      <div className="mt-1 text-xs text-slate-500">{item.matchType} · {item.matchCount} candidate row(s)</div>
                    </div>
                  )) : (
                    <div className="text-slate-500">Run with a few rules saved to see which entries they currently match.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Recurring templates — hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionGroupHeader title="Recurring schedules" accent="indigo" hint="Set-and-forget postings and billing so repeat activity books itself." />
      <SectionHost sectionId="recurring-journals" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Recurring journal templates"
          subtitle="Owner-scoped recurring income and expense schedules that post directly into the canonical ledger. This is separate from rent invoicing so billing and direct journal automation stay explicit."
          right={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={generateRecurringJournalBatch}
                disabled={generatingRecurringJournalEntries || activeRecurringJournalTemplates.length === 0}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
              >
                {generatingRecurringJournalEntries ? 'Posting…' : 'Generate due entries'}
              </button>
              <button
                type="button"
                onClick={() => setShowRecurringJournalForm((current) => !current)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {showRecurringJournalForm ? 'Hide form' : 'New journal template'}
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-3">
          <Stat
            label="Templates"
            value={String(recurringJournalTemplates.length)}
            hint="Recurring journal schedules loaded from the canonical backend"
          />
          <Stat
            label="Due soon"
            value={String(recurringJournalUpcoming.length)}
            hint="Scheduled within the next 45 days"
          />
          <Stat
            label="Monthly equivalent"
            value={fmtMoney(recurringJournalMonthlyAmount)}
            hint="Normalized across weekly, monthly, quarterly, and annual schedules"
          />
        </div>
        {recurringJournalNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{recurringJournalNote}</div>
        )}
        {showRecurringJournalForm && (
          <form onSubmit={createRecurringJournalTemplate} className="grid grid-cols-1 gap-3 border-t border-slate-100 px-5 py-4 md:grid-cols-6">
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Preset</div>
              <select
                value={recurringJournalDraft.presetKey}
                onChange={(e) => applyRecurringJournalPreset(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="">Custom template</option>
                {recurringJournalPresetEntries.map(([presetKey, preset]) => (
                  <option key={presetKey} value={presetKey}>{preset.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Template name</div>
              <input
                type="text"
                value={recurringJournalDraft.name}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, name: e.target.value })}
                placeholder="Mortgage interest payment"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Frequency</div>
              <select
                value={recurringJournalDraft.frequency}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, frequency: e.target.value as RecurringJournalFrequency })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {RECURRING_JOURNAL_FREQUENCIES.map((frequency) => (
                  <option key={frequency} value={frequency}>{frequency}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Amount</div>
              <input
                type="number"
                step="0.01"
                value={recurringJournalDraft.amount}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, amount: e.target.value })}
                placeholder="850.00"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-3">
              <div className="mb-1 font-medium">P&amp;L account</div>
              <select
                value={recurringJournalDraft.accountCode}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, accountCode: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {revenueExpenseAccounts.map((account) => (
                  <option key={account.code} value={account.code}>{account.code} · {account.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-3">
              <div className="mb-1 font-medium">Offset account</div>
              <select
                value={recurringJournalDraft.offsetAccountCode}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, offsetAccountCode: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {bookkeeping.accounts.map((account) => (
                  <option key={account.code} value={account.code}>{account.code} · {account.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Cycle day</div>
              <input
                type="number"
                min="1"
                max="31"
                value={recurringJournalDraft.dayOfMonth}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, dayOfMonth: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Start date</div>
              <input
                type="date"
                value={recurringJournalDraft.startDate}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, startDate: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">End date</div>
              <input
                type="date"
                value={recurringJournalDraft.endDate}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, endDate: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-3">
              <div className="mb-1 font-medium">Memo</div>
              <input
                type="text"
                value={recurringJournalDraft.memo}
                onChange={(e) => setRecurringJournalDraft({ ...recurringJournalDraft, memo: e.target.value })}
                placeholder="Mortgage interest autopost"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="flex items-end justify-end md:col-span-6">
              <button
                type="submit"
                disabled={recurringJournalBusy}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {recurringJournalBusy ? 'Saving…' : 'Save journal template'}
              </button>
            </div>
          </form>
        )}
        <div className="border-t border-slate-100 px-5 py-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="space-y-3 xl:col-span-2">
              {recurringJournalTemplates.length > 0 ? recurringJournalTemplates.map((template) => {
                const actionBusy = recurringJournalActionId === template.id;
                const isActive = template.isActive !== false;
                return (
                  <div key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">{template.name}</span>
                          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
                            {isActive ? 'Active' : 'Paused'}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-600">{fmtMoney(template.amount)} · {formatRecurringFrequency(template.frequency, template.dayOfMonth)}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {template.accountCode} · {template.accountName || 'Primary account'} → {template.offsetAccountCode} · {template.offsetAccountName || 'Offset account'}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          Next due {fmtDate(template.nextDue)} · Last generated {fmtDate(template.lastGenerated)}
                          {template.endDate ? ` · Ends ${fmtDate(template.endDate)}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => toggleRecurringJournalTemplate(template)}
                          disabled={actionBusy}
                          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          {actionBusy ? 'Saving…' : isActive ? 'Pause' : 'Reactivate'}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRecurringJournalTemplate(template)}
                          disabled={actionBusy}
                          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                  No recurring journal templates are configured yet. Use these for fixed mortgage interest, tax, insurance, HOA, or utility postings that should land directly in the canonical ledger.
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Due soon</div>
                <div className="mt-3 space-y-3 text-sm text-slate-700">
                  {recurringJournalUpcoming.length > 0 ? recurringJournalUpcoming.slice(0, 5).map((template) => (
                    <div key={template.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-3">
                      <div className="font-medium text-slate-900">{template.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{fmtDate(template.nextDue)} · {fmtMoney(template.amount)}</div>
                    </div>
                  )) : (
                    <div className="text-slate-500">Nothing is scheduled in the next 45 days.</div>
                  )}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Template presets</div>
                <div className="mt-3 space-y-2 text-sm text-slate-700">
                  {recurringJournalPresetEntries.length > 0 ? recurringJournalPresetEntries.map(([presetKey, preset]) => (
                    <button
                      key={presetKey}
                      type="button"
                      onClick={() => {
                        setShowRecurringJournalForm(true);
                        applyRecurringJournalPreset(presetKey);
                      }}
                      className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
                    >
                      <span>{preset.name}</span>
                      <span className="text-xs text-slate-500">{preset.accountCode}</span>
                    </button>
                  )) : (
                    <div className="text-slate-500">No recurring presets are available from the backend yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>
      </SectionHost>

      <SectionHost sectionId="recurring-rent" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Recurring rent templates"
          subtitle="Live recurring billing templates on the Firestore-backed owner finance backend. Generated invoices land in the rent invoicing pipeline and later post into accounting when paid."
          right={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={generateRecurringRentInvoices}
                disabled={generatingRecurringInvoices}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
              >
                {generatingRecurringInvoices ? 'Generating…' : `Generate ${closePeriodTarget || range.endDate.slice(0, 7)}`}
              </button>
              <button
                type="button"
                onClick={() => setShowInvoiceForm((current) => !current)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {showInvoiceForm ? 'Hide invoice' : 'New invoice'}
              </button>
              <button
                type="button"
                onClick={() => setShowRecurringTemplateForm((current) => !current)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {showRecurringTemplateForm ? 'Hide form' : 'New template'}
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-3">
          <Stat
            label="Templates"
            value={String(recurringTemplates.length)}
            hint="Recurring invoice schedules loaded from the backend"
          />
          <Stat
            label="Active schedules"
            value={String(activeRecurringTemplates.length)}
            hint="Templates that will generate invoices for the selected month"
          />
          <Stat
            label="Monthly billed"
            value={fmtMoney(recurringTemplateMonthlyAmount)}
            hint="Total monthly amount across active recurring schedules"
          />
        </div>
        {recurringNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-sm text-slate-600">{recurringNote}</div>
        )}
        {showInvoiceForm && (
          <form onSubmit={createOneOffInvoice} className="grid grid-cols-1 gap-3 border-t border-slate-100 px-5 py-4 md:grid-cols-6">
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Property / unit</div>
              <input
                type="text"
                value={invoiceDraft.propertyAddress}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, propertyAddress: e.target.value })}
                placeholder="123 Main St Unit A"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Tenant</div>
              <input
                type="text"
                value={invoiceDraft.tenantName}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, tenantName: e.target.value })}
                placeholder="Jane Doe"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Tenant email</div>
              <input
                type="email"
                value={invoiceDraft.tenantEmail}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, tenantEmail: e.target.value })}
                placeholder="tenant@example.com"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Amount</div>
              <input
                type="number"
                step="0.01"
                value={invoiceDraft.amount}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, amount: e.target.value })}
                placeholder="1850.00"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Due date</div>
              <input
                type="date"
                value={invoiceDraft.dueDate}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, dueDate: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-4">
              <div className="mb-1 font-medium">Description</div>
              <input
                type="text"
                value={invoiceDraft.description}
                onChange={(e) => setInvoiceDraft({ ...invoiceDraft, description: e.target.value })}
                placeholder="Monthly Rent - May 2026"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="flex items-end justify-end md:col-span-2">
              <button
                type="submit"
                disabled={invoiceBusy}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {invoiceBusy ? 'Creating…' : 'Create invoice'}
              </button>
            </div>
          </form>
        )}
        {showRecurringTemplateForm && (
          <form onSubmit={createRecurringTemplate} className="grid grid-cols-1 gap-3 border-t border-slate-100 px-5 py-4 md:grid-cols-6">
            <label className="text-xs text-slate-600 md:col-span-2">
              <div className="mb-1 font-medium">Property / unit</div>
              <input
                type="text"
                value={recurringTemplateDraft.propertyAddress}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, propertyAddress: e.target.value })}
                placeholder="123 Main St Unit A"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Tenant</div>
              <input
                type="text"
                value={recurringTemplateDraft.tenantName}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, tenantName: e.target.value })}
                placeholder="Jane Doe"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Tenant email</div>
              <input
                type="email"
                value={recurringTemplateDraft.tenantEmail}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, tenantEmail: e.target.value })}
                placeholder="tenant@example.com"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Amount</div>
              <input
                type="number"
                step="0.01"
                value={recurringTemplateDraft.amount}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, amount: e.target.value })}
                placeholder="1850.00"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-1">
              <div className="mb-1 font-medium">Due day</div>
              <input
                type="number"
                min="1"
                max="31"
                value={recurringTemplateDraft.dueDayOfMonth}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, dueDayOfMonth: e.target.value })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600 md:col-span-4">
              <div className="mb-1 font-medium">Description</div>
              <input
                type="text"
                value={recurringTemplateDraft.description}
                onChange={(e) => setRecurringTemplateDraft({ ...recurringTemplateDraft, description: e.target.value })}
                placeholder="Monthly Rent"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="flex items-end justify-end md:col-span-2">
              <button
                type="submit"
                disabled={recurringTemplateBusy}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {recurringTemplateBusy ? 'Creating…' : 'Create template'}
              </button>
            </div>
          </form>
        )}
        <div className="border-t border-slate-100 px-5 py-4">
          {recurringTemplates.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {recurringTemplates.map((template) => {
                const actionBusy = recurringTemplateActionId === template.id;
                return (
                  <div key={template.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-slate-900">{template.tenantName || template.propertyAddress || 'Recurring rent template'}</div>
                        <div className="mt-1 text-sm text-slate-600">{template.description || 'Monthly Rent'} · {fmtMoney(template.amount)} due on the {fmtOrdinalDay(template.dueDayOfMonth)}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {[template.propertyAddress, template.tenantEmail].filter(Boolean).join(' · ') || 'No property or tenant contact recorded'}
                        </div>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${template.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
                        {template.active ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => toggleRecurringTemplate(template)}
                        disabled={actionBusy}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        {actionBusy ? 'Saving…' : template.active ? 'Pause template' : 'Reactivate template'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteRecurringTemplate(template)}
                        disabled={actionBusy}
                        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                    <div className="mt-3 text-[11px] text-slate-500">
                      Created {fmtDate(template.createdAt)} · Updated {fmtDate(template.updatedAt || template.createdAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
              No recurring rent templates are configured yet. Create one here to keep monthly billing aligned with the backend owner-finance workflow.
            </div>
          )}
        </div>
        <div className="border-t border-slate-100 px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Recent rent invoices</div>
              <div className="text-xs text-slate-500">Generated and manually created invoices from the same Firestore-backed billing pipeline. Marking one paid posts rent income into the ledger.</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-right text-xs text-slate-500">
              <div>
                <div className="font-semibold text-slate-900">{fmtMoney(rentInvoiceSummary?.totalAmount)}</div>
                <div>Billed</div>
              </div>
              <div>
                <div className="font-semibold text-amber-700">{fmtMoney(rentInvoiceSummary?.pendingAmount)}</div>
                <div>Outstanding</div>
              </div>
              <div>
                <div className="font-semibold text-emerald-700">{fmtMoney(rentInvoiceSummary?.paidAmount)}</div>
                <div>Paid</div>
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {recentRentInvoices.length > 0 ? recentRentInvoices.map((invoice) => {
              const actionBusy = invoiceActionId === invoice.id;
              return (
                <div key={invoice.id} className="rounded-xl border border-slate-200 bg-white px-4 py-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{invoice.invoiceNumber}</span>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${invoice.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : invoice.status === 'overdue' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}>
                          {invoice.status}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-slate-600">{invoice.tenantName || 'Tenant'} · {fmtMoney(invoice.amount)} due {fmtDate(invoice.dueDate)}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {[invoice.propertyAddress, invoice.tenantEmail].filter(Boolean).join(' · ') || 'No property or tenant contact recorded'}
                      </div>
                      {invoice.status === 'paid' && (
                        <div className="mt-1 text-[11px] text-emerald-700">
                          Paid {fmtDate(invoice.paidAt)}{invoice.bookkeepingJournalEntryId ? ` · Journal ${invoice.bookkeepingJournalEntryId}` : ''}
                        </div>
                      )}
                    </div>
                    {invoice.status !== 'paid' && (
                      <button
                        type="button"
                        onClick={() => markRentInvoicePaid(invoice)}
                        disabled={actionBusy}
                        className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        {actionBusy ? 'Posting…' : 'Mark paid + post entry'}
                      </button>
                    )}
                  </div>
                </div>
              );
            }) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600">
                No rent invoices are in the pipeline yet. Generate invoices from an active template to populate this ledger-adjacent billing view.
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-slate-100 px-5 py-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900">Accounts receivable aging</div>
              <div className="text-xs text-slate-500">Outstanding rent invoices from the same backend billing pipeline, bucketed by due date so close review can see what is still collectible.</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-right text-xs text-slate-500">
              <div>
                <div className="font-semibold text-slate-900">{fmtMoney(accountsReceivable?.summary.totalOutstanding)}</div>
                <div>Outstanding</div>
              </div>
              <div>
                <div className="font-semibold text-slate-900">{String(accountsReceivable?.summary.totalCount || 0)}</div>
                <div>Open invoices</div>
              </div>
              <div>
                <div className="font-semibold text-rose-700">{fmtMoney(overdue30PlusAmount)}</div>
                <div>30+ days</div>
              </div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-5">
            {receivablesBuckets.map((bucket) => {
              const data = accountsReceivable?.aging?.[bucket.key] || { count: 0, amount: 0, invoices: [] };
              return (
                <div key={bucket.key} className={`rounded-xl border px-4 py-4 ${bucket.tone}`}>
                  <div className="text-[11px] font-semibold uppercase tracking-wider">{bucket.label}</div>
                  <div className="mt-2 text-xl font-semibold">{fmtMoney(data.amount)}</div>
                  <div className="mt-1 text-xs">{data.count} invoice(s)</div>
                  <div className="mt-3 space-y-2 text-[11px] leading-5 text-slate-700">
                    {data.invoices.length > 0 ? data.invoices.slice(0, 2).map((invoice) => (
                      <div key={invoice.id} className="rounded-lg border border-white/70 bg-white/70 px-2 py-2">
                        <div className="font-semibold text-slate-900">{invoice.invoiceNumber}</div>
                        <div>{invoice.tenantName || 'Tenant'} · {fmtMoney(invoice.amount)}</div>
                        <div>{invoice.daysOverdue > 0 ? `${invoice.daysOverdue} day(s) overdue` : `Due ${fmtDate(invoice.dueDate)}`}</div>
                      </div>
                    )) : (
                      <div className="rounded-lg border border-white/70 bg-white/70 px-2 py-2">No invoices in this aging bucket.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-[11px] text-slate-500">
            Average days outstanding: {String(accountsReceivable?.summary.averageDaysOutstanding || 0)}.
          </div>
        </div>
      </Card>
      </SectionHost>
      </div>

      {/* ----- Transactions & Ledger tab: entries and ledger ----- */}
      <div className={activeWorkspaceTab === 'ledger' ? 'order-1 space-y-4' : 'hidden'}>
      <SectionGroupHeader title="Record & browse" accent="sky" hint="Add entries and inspect every posted transaction with its source feed and trace." />
      {/* Quick entry */}
      <SectionHost sectionId="quick-entry" nav={workspaceNav}>
      <Card>
        <CardHeader
          title="Add manual entry"
          subtitle="Manual entries flow through the same posting engine and are tagged as MANUAL in the ledger."
        />
        <form onSubmit={postQuickEntry} className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-6">
          <label className="text-xs text-slate-600 md:col-span-1">
            <div className="mb-1 font-medium">Date</div>
            <input
              type="date"
              value={entry.date}
              onChange={(e) => setEntry({ ...entry, date: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600 md:col-span-2">
            <div className="mb-1 font-medium">Description</div>
            <input
              type="text"
              value={entry.description}
              onChange={(e) => setEntry({ ...entry, description: e.target.value })}
              placeholder="e.g. Water heater repair"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600 md:col-span-1">
            <div className="mb-1 font-medium">Amount</div>
            <input
              type="number"
              step="0.01"
              value={entry.amount}
              onChange={(e) => setEntry({ ...entry, amount: e.target.value })}
              placeholder="0.00"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600 md:col-span-1">
            <div className="mb-1 font-medium">Type</div>
            <select
              value={entry.type}
              onChange={(e) => setEntry({ ...entry, type: e.target.value as 'expense' | 'income' })}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
          <label className="text-xs text-slate-600 md:col-span-1">
            <div className="mb-1 font-medium">Account</div>
            <select
              value={entry.categoryCode}
              onChange={(e) => setEntry({ ...entry, categoryCode: e.target.value })}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Auto</option>
              {bookkeeping.accounts
                .filter((a) =>
                  entry.type === 'income' ? a.type === 'REVENUE' : a.type === 'EXPENSE',
                )
                .map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex items-end md:col-span-6">
            <button
              type="submit"
              disabled={postingEntry}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {postingEntry ? 'Posting…' : 'Post entry'}
            </button>
            {entryNote && <div className="ml-3 text-xs text-slate-600">{entryNote}</div>}
          </div>
        </form>
      </Card>
      </SectionHost>

      {/* Ledger table */}
      <SectionHost sectionId="ledger-table" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="The ledger is the master record of every posted transaction — the single source of truth that all reports, tie-outs, and tax exports are built from."
          title="Ledger"
          subtitle="Journal entries from the canonical ledger, normalized for display."
          right={
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search description, category, vendor…"
                className="w-56 rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as any)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              >
                <option value="all">All sources</option>
                <option value="sample">Sample only</option>
                <option value="stripe">Stripe only</option>
                <option value="bank">Bank only</option>
                <option value="manual">Manual only</option>
                <option value="qbo">QuickBooks only</option>
                <option value="receipt">Receipts only</option>
              </select>
            </div>
          }
        />
        <div className="border-b border-slate-100 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {!propertyId && propertyOptions.length > 0 && (
              <select
                value={propertyFilter}
                onChange={(e) => setPropertyFilter(e.target.value)}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs"
              >
                <option value="all">All properties</option>
                {propertyOptions.map((option) => (
                  <option key={option} value={option}>
                    Property {option}
                  </option>
                ))}
              </select>
            )}
            <select
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="all">All vendors</option>
              {vendorOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => {
                const nextCategory = e.target.value;
                setCategoryFilter(nextCategory);
                if (nextCategory === 'all') {
                  setTypeFilter('all');
                }
              }}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="all">All categories</option>
              {Array.from(new Set(bookkeeping.transactions.map((transaction) => String(transaction.category || 'Uncategorized')))).sort().map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="all">All accounts</option>
              {ledgerAccountOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.code} · {option.name}
                </option>
              ))}
            </select>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="amount-desc">Largest amount first</option>
              <option value="amount-asc">Smallest amount first</option>
            </select>
            {(searchText.trim() || typeFilter !== 'all' || sourceFilter !== 'all' || vendorFilter !== 'all' || categoryFilter !== 'all' || accountFilter !== 'all' || sortOrder !== 'date-desc' || (!propertyId && propertyFilter !== 'all')) && (
              <button
                type="button"
                onClick={() => {
                  setSearchText('');
                  setTypeFilter('all');
                  setSourceFilter('all');
                  setVendorFilter('all');
                  setCategoryFilter('all');
                  setAccountFilter('all');
                  setSortOrder('date-desc');
                  if (!propertyId) setPropertyFilter('all');
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear filters
              </button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{filtered.length} ledger lines</span>
            {typeFilter !== 'all' && <span>Type: {typeFilter}</span>}
            {categoryFilter !== 'all' && <span>Category: {categoryFilter}</span>}
            {activeAccount && <span>Account drilldown: {activeAccount.code} · {activeAccount.name}</span>}
            {vendorFilter !== 'all' && <span>Vendor: {vendorFilter}</span>}
            {!propertyId && propertyFilter !== 'all' && <span>Property: {propertyFilter}</span>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">Category / tax map</th>
                <th className="px-4 py-2">Counterparty</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                    {bookkeeping.isLoading ? 'Loading…' : 'No transactions in this window.'}
                  </td>
                </tr>
              )}
              {filtered.slice(0, 200).map((t) => {
                const isIncome = t.type === 'income';
                const trace = transactionTrace[t.id];
                const isTraceOpen = openTraceId === t.id;
                return (
                  <React.Fragment key={t.id}>
                    <tr className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="whitespace-nowrap px-4 py-2 text-slate-700 tabular-nums">{fmtDate(t.date)}</td>
                      <td className="px-4 py-2 text-slate-900">
                        <div>{t.description || '—'}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {t.sourceRef && (
                            <div className="text-[10px] font-mono text-slate-400">ref: {t.sourceRef}</div>
                          )}
                          <button
                            type="button"
                            onClick={() => toggleTransactionTrace(t)}
                            className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-900"
                          >
                            {isTraceOpen ? 'Hide trace' : 'Show trace'}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        <div>{t.category || '—'}</div>
                        {formatTaxMap(t) && (
                          <div className="text-[10px] font-mono text-slate-400">{formatTaxMap(t)}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        <div>{t.vendor || 'No vendor'}</div>
                        <div className="text-[10px] font-mono text-slate-400">Property {t.propertyId || propertyId || 'unassigned'}</div>
                      </td>
                      <td className="px-4 py-2">
                        <SourceBadge source={t.source} />
                        {t.financeEventType && (
                          <div className="mt-1 text-[10px] font-mono text-slate-400">{t.financeEventType}</div>
                        )}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums ${
                          isIncome ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
                        {isIncome ? '+' : '−'}
                        {fmtMoney(Math.abs(Number(t.amount || 0)))}
                      </td>
                    </tr>
                    {isTraceOpen && (
                      <tr className="border-t border-slate-100 bg-slate-50/80">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Classification trace</div>
                              <div className="mt-2 space-y-2 text-sm text-slate-700">
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Ledger result</div>
                                  <div className="mt-1">{t.category || 'Uncategorized'} {formatTaxMap(t) ? `→ ${formatTaxMap(t)}` : ''}</div>
                                </div>
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Why it lands there</div>
                                  <div className="mt-1">
                                    {t.accountCode
                                      ? `The posted non-cash line is account ${t.accountCode}, which is what drives the category and tax mapping for this journal entry.`
                                      : 'This row does not expose a non-cash account code yet, so only the posted category is available.'}
                                  </div>
                                </div>
                                <div className="grid grid-cols-1 gap-2 text-xs text-slate-500 sm:grid-cols-2">
                                  <div>Vendor: <span className="font-mono text-slate-700">{t.vendor || 'not recorded'}</span></div>
                                  <div>Property: <span className="font-mono text-slate-700">{t.propertyId || propertyId || 'not recorded'}</span></div>
                                  <div>Source system: <span className="font-mono text-slate-700">{t.source || 'unknown'}</span></div>
                                  <div>Finance event: <span className="font-mono text-slate-700">{t.financeEventType || 'not recorded'}</span></div>
                                  <div>Journal ref: <span className="font-mono text-slate-700">{t.id}</span></div>
                                  <div>Source ref: <span className="font-mono text-slate-700">{t.sourceRef || 'not recorded'}</span></div>
                                </div>
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Supporting evidence</div>
                                {trace?.mode && (
                                  <div className="text-[10px] font-mono text-slate-400">lookup {trace.mode}</div>
                                )}
                              </div>

                              {(!trace || trace.status === 'loading') && (
                                <div className="mt-3 text-sm text-slate-500">Loading evidence trace…</div>
                              )}

                              {trace?.status === 'not_configured' && (
                                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                  Canonical finance evidence storage is not configured in this environment yet.
                                </div>
                              )}

                              {trace?.status === 'error' && (
                                <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                                  {trace.error || 'Failed to load supporting evidence.'}
                                </div>
                              )}

                              {trace?.status === 'loaded' && trace.evidence.length === 0 && (
                                <div className="mt-3 text-sm text-slate-500">
                                  No linked evidence was found for this row yet. The trace checked the source reference first, then canonical and legacy journal-entry links.
                                </div>
                              )}

                              {trace?.status === 'loaded' && trace.evidence.length > 0 && (
                                <div className="mt-3 space-y-2">
                                  {trace.evidence.map((evidenceItem) => (
                                    <div key={evidenceItem.evidenceId} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                        <div>
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium text-slate-900">{evidenceItem.title}</span>
                                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                                              {evidenceItem.evidenceType.replace(/_/g, ' ')}
                                            </span>
                                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${traceStatusPillClass(evidenceItem.digitizationStatus)}`}>
                                              {evidenceItem.digitizationStatus || 'pending'}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-xs text-slate-500">
                                            {evidenceItem.vendorName || 'No vendor'}
                                            {evidenceItem.amount !== null && evidenceItem.amount !== undefined ? ` · ${fmtMoney(evidenceItem.amount)}` : ''}
                                            {evidenceItem.documentDate ? ` · ${evidenceItem.documentDate}` : ''}
                                          </div>
                                          <div className="mt-1 text-[10px] text-slate-400">
                                            Linked to {evidenceItem.links?.map((link) => `${link.entityType}:${link.entityId}`).join(', ') || 'no accounting entity yet'}
                                          </div>
                                          {(evidenceItem.externalUrl || evidenceItem.storagePath) && (
                                            <div className="mt-2 text-xs">
                                              {evidenceItem.externalUrl ? (
                                                <a href={evidenceItem.externalUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-700 underline hover:text-slate-900">
                                                  Open source document
                                                </a>
                                              ) : (
                                                <span className="text-slate-500">Stored at {evidenceItem.storagePath}</span>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                        <div className="text-[10px] text-slate-400 md:text-right">
                                          {evidenceItem.createdAt ? new Date(evidenceItem.createdAt).toLocaleString() : 'No timestamp'}
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 200 && (
          <div className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500">
            Showing first 200 of {filtered.length} entries. Narrow the date range or filters to see more.
          </div>
        )}
      </Card>
      </SectionHost>

      {/* Account balances — expert/admin only, hidden from landlord UI */}
      <div className="hidden"><SectionHost sectionId="account-balances" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="The chart of accounts is the standardized list of buckets (cash, rent income, repairs…) every transaction is filed under."
          title="Account balances"
          subtitle="From the canonical chart of accounts. Click an account to drill the ledger to that posting line."
        />
        <div className="grid grid-cols-1 gap-px bg-slate-100 md:grid-cols-2">
          {sortedAccounts.map((a) => (
            <button
              key={a.code}
              type="button"
              onClick={() => setAccountFilter((current) => (current === a.code ? 'all' : a.code))}
              className={`flex items-center justify-between bg-white px-5 py-3 text-left text-sm hover:bg-slate-50 ${accountFilter === a.code ? 'ring-2 ring-inset ring-slate-900/10' : ''}`}
            >
              <div>
                <div className="font-medium text-slate-900">{a.name}</div>
                <div className="text-xs text-slate-500">
                  {a.code} · {a.type}
                </div>
              </div>
              <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(a.balance)}</div>
            </button>
          ))}
        </div>
      </Card>
      </SectionHost></div>
      </div>

      {/* ----- Reconciliation & Close — hidden from landlord UI ----- */}
      <div className="hidden">
      <SectionGroupHeader title="Month-end close & evidence" accent="amber" hint="Reconciliation means matching the bank's records against your books; closing locks a month so its numbers stop changing." />
      {/* Close cockpit */}
      <SectionHost sectionId="close-cockpit" nav={workspaceNav}>
      <Card>
        <CardHeader
          info="Closing a period locks it so numbers stop changing. Reconciliation exceptions are bank-vs-books mismatches that need an explanation before you close."
          title="Close cockpit"
          subtitle="Resolve month-end close blockers, reconciliation issues, evidence follow-up, and finance document gaps from one canonical workspace."
          right={<span className="text-xs text-slate-500">{closeCockpitTasks.length} blockers in queue</span>}
        />
        <div className="grid grid-cols-2 gap-3 p-5 xl:grid-cols-4">
          <Stat
            label="Open close periods"
            value={String(openClosePeriods.length)}
            hint="Periods still open or reopened"
          />
          <Stat
            label="Recon exceptions"
            value={String(reconExceptions.length)}
            hint="Exceptions from the reconciliation engine"
          />
          <Stat
            label="Evidence follow-up"
            value={String(evidencePendingCount)}
            hint={`${evidenceSummary?.totalEvidence ?? 0} evidence records indexed`}
          />
          <Stat
            label="Finance docs"
            value={String(pendingFinanceDocuments.length)}
            hint="Documents still waiting on OCR or evidence shadowing"
          />
        </div>

        <div className="border-t border-slate-100 px-5 py-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">Why these blockers are in queue</div>
            <div className="mt-1 text-xs text-slate-500">
              Citation-first explanations from open periods, reconciliation status, evidence coverage, finance documents, and close intelligence.
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {closeCockpitExplanations.length > 0 ? closeCockpitExplanations.map((item) => (
                <div key={item.id} className="rounded-xl border border-white bg-white px-4 py-4">
                  <div className="font-medium text-slate-900">{item.title}</div>
                  <div className="mt-1 text-sm text-slate-600">{item.detail}</div>
                  <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
                  <ul className="mt-2 space-y-2 text-xs text-slate-600">
                    {item.citations.map((citation) => (
                      <li key={citation} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        {citation}
                      </li>
                    ))}
                  </ul>
                </div>
              )) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 xl:col-span-2">
                  No blocker explanations are currently active because this close workspace is not surfacing unresolved queue items.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 px-5 py-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">What changed since last close</div>
                <div className="mt-1 text-xs text-slate-500">
                  Read-only delta from the most recent closed period to the currently visible ledger window, with underlying ledger citations.
                </div>
              </div>
              <div className="text-xs text-slate-500">
                {latestClosedPeriod ? `Since ${latestClosedPeriod.periodKey}` : 'No closed period yet'}
              </div>
            </div>

            {!latestClosedPeriod ? (
              <div className="mt-4 rounded-xl border border-white bg-white px-4 py-4 text-sm text-slate-500">
                Close the first period in this owner scope to unlock delta tracking from one close cycle to the next.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
                  <Stat label="New lines" value={String(closeDelta.transactions.length)} hint={closeDelta.cutoff ? `After ${fmtDate(closeDelta.cutoff.toISOString())}` : 'No cutoff'} />
                  <Stat label="New income" value={fmtMoney(closeDelta.income)} hint="Posted after close" />
                  <Stat label="New expenses" value={fmtMoney(closeDelta.expenses)} hint="Posted after close" />
                  <Stat label="New recon" value={String(closeDelta.reconCount)} hint="Exceptions created after close" />
                  <Stat label="Docs flagged" value={String(closeDelta.documentCount)} hint="Finance docs needing follow-up" />
                </div>

                <div className="rounded-xl border border-white bg-white px-4 py-4">
                  <div className="font-medium text-slate-900">Delta explanation</div>
                  <div className="mt-1 text-sm text-slate-600">
                    {closeDelta.transactions.length > 0
                      ? `${closeDelta.transactions.length} ledger line(s) were posted after the last closed period, including ${fmtMoney(closeDelta.income)} income and ${fmtMoney(closeDelta.expenses)} expense activity.`
                      : 'No additional ledger lines are currently posted after the most recent closed period in this scope.'}
                  </div>
                  <div className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Citations</div>
                  <ul className="mt-2 space-y-2 text-xs text-slate-600">
                    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">{closeDelta.sourceHeadline}</li>
                    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">{closeDelta.uncategorizedCount} of the new ledger lines still need categorization or tax-map review.</li>
                    <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">{closeDelta.reconCount} reconciliation exception(s) and {closeDelta.documentCount} finance document follow-up item(s) were created after the close cutoff.</li>
                  </ul>
                </div>

                <div className="rounded-xl border border-white bg-white px-4 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Largest post-close ledger lines</div>
                  {closeDelta.topTransactions.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {closeDelta.topTransactions.map((transaction, index) => (
                        <button
                          key={`${transaction.id || transaction.description || 'delta'}-${index}`}
                          type="button"
                          onClick={() => void toggleTransactionTrace(transaction)}
                          className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-left hover:bg-slate-100"
                        >
                          <div>
                            <div className="font-medium text-slate-900">{transaction.description || transaction.category || 'Ledger line'}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              {fmtDate(transaction.date)} · {transaction.vendor || 'No vendor'} · {transaction.accountCode || 'No account code'}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(transaction.amount)}</div>
                            <div className="mt-1 text-[10px] text-slate-400">{classifyFinanceSource(transaction.source).label}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-slate-500">No post-close ledger lines are currently in scope.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-4 border-t border-slate-100 px-5 py-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Operational queue</div>
                <div className="mt-1 text-sm text-slate-600">Prioritized blockers across close, reconciliation, supporting evidence, and finance documents.</div>
              </div>
              <div className="text-xs text-slate-500">Month-end first</div>
            </div>

            {pipelineLoading && closeCockpitTasks.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                Loading close cockpit…
              </div>
            )}

            {!pipelineLoading && closeCockpitTasks.length === 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                No open blockers are currently surfaced for this close workspace.
              </div>
            )}

            <ul className="space-y-3">
              {closeCockpitTasks.slice(0, 12).map((task) => (
                <li key={task.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cockpitLaneClass(task.lane)}`}>
                          {task.lane}
                        </span>
                        <span className="font-medium text-slate-900">{task.title}</span>
                      </div>
                      <div className="mt-1 text-sm text-slate-600">{task.detail}</div>
                      {task.meta && <div className="mt-1 text-[11px] text-slate-400">{task.meta}</div>}
                    </div>
                    {task.amount != null && (
                      <div className="text-sm font-semibold tabular-nums text-slate-900">{fmtMoney(task.amount)}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900">Close periods</div>
                <span className="text-xs text-slate-500">{openClosePeriods.length} active</span>
              </div>
              <ul className="mt-3 space-y-2">
                {closePeriods.slice(0, 6).map((period) => (
                  <li key={period.periodKey} className="flex items-center justify-between gap-3 rounded-lg border border-white bg-white px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{period.periodKey}</div>
                      <div className="text-[11px] text-slate-400">
                        {period.reopenedAt ? `Reopened ${fmtDate(period.reopenedAt)}` : period.closedAt ? `Closed ${fmtDate(period.closedAt)}` : 'No timestamp yet'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${closePeriodStatusPillClass(period.status)}`}>
                        {period.status || 'open'}
                      </span>
                      {String(period.status || '').toLowerCase() === 'closed' && (
                        <button
                          type="button"
                          onClick={() => reopenSelectedPeriod(period.periodKey)}
                          disabled={closePeriodBusy}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {closePeriodBusy && closePeriodTarget === period.periodKey ? 'Working…' : 'Reopen'}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
                {!pipelineLoading && closePeriods.length === 0 && (
                  <li className="text-xs text-slate-500">No close-period records yet.</li>
                )}
              </ul>

              <div className="mt-4 rounded-lg border border-white bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Close control</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="text-xs text-slate-600">
                    <div className="mb-1 font-medium">Period</div>
                    <input
                      type="month"
                      value={closePeriodTarget}
                      onChange={(e) => setClosePeriodTarget(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                  </label>
                  <label className="text-xs text-slate-600 sm:col-span-2">
                    <div className="mb-1 font-medium">Reason</div>
                    <input
                      type="text"
                      value={closePeriodReason}
                      onChange={(e) => setClosePeriodReason(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                  </label>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-slate-600">
                    <div className="mb-1 font-medium">Approved by</div>
                    <input
                      type="text"
                      value={closeApproval.approvedBy}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, approvedBy: e.target.value }))}
                      placeholder="Reviewer name or email"
                      className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                  </label>
                  <label className="text-xs text-slate-600">
                    <div className="mb-1 font-medium">Notes</div>
                    <input
                      type="text"
                      value={closePeriodNotes}
                      onChange={(e) => setClosePeriodNotes(e.target.value)}
                      placeholder="Optional reviewer notes"
                      className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                  </label>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-600">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={closeApproval.reconciliationReviewed}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, reconciliationReviewed: e.target.checked }))}
                    />
                    Reconciliation reviewed
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={closeApproval.openExceptionsResolved}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, openExceptionsResolved: e.target.checked }))}
                    />
                    Open exceptions resolved
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={closeApproval.closeAttested}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, closeAttested: e.target.checked }))}
                    />
                    Attest close approval
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={closeApproval.reopenReasonApproved}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, reopenReasonApproved: e.target.checked }))}
                    />
                    Reopen reason reviewed
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={closeApproval.reopenAttested}
                      onChange={(e) => setCloseApproval((current) => ({ ...current, reopenAttested: e.target.checked }))}
                    />
                    Attest reopen approval
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-[11px] text-slate-500">
                    Use the close action for the selected month. Reopen actions use the same reviewer inputs and reason.
                  </div>
                  <button
                    type="button"
                    onClick={closeSelectedPeriod}
                    disabled={closePeriodBusy}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {closePeriodBusy ? 'Closing…' : `Close ${closePeriodTarget}`}
                  </button>
                </div>

                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-slate-800">{closePeriodTarget} intelligence</div>
                    <span className={`rounded-full border px-2 py-0.5 font-semibold uppercase tracking-wider ${closeIntelligencePillClass(closePeriodIntelligence?.readinessStatus)}`}>
                      {closePeriodIntelligence?.readinessStatus || closePeriodIntelligenceStatus}
                    </span>
                  </div>
                  {closePeriodIntelligenceStatus === 'loading' && (
                    <div className="mt-2 text-slate-500">Loading close-period intelligence…</div>
                  )}
                  {closePeriodIntelligenceError && (
                    <div className="mt-2 text-rose-700">{closePeriodIntelligenceError}</div>
                  )}
                  {closePeriodIntelligence && (
                    <div className="mt-2 space-y-2">
                      <div className="text-slate-600">{closePeriodIntelligence.summary}</div>
                      {closePeriodIntelligence.sourceMetrics && (
                        <div className="grid gap-2 sm:grid-cols-3">
                          <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Open exceptions</div>
                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {closePeriodIntelligence.sourceMetrics.openExceptionCount ?? 0}
                            </div>
                          </div>
                          <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Evidence coverage</div>
                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {(closePeriodIntelligence.sourceMetrics.processedEvidenceCount ?? 0)} / {(closePeriodIntelligence.sourceMetrics.totalEvidence ?? 0)}
                            </div>
                          </div>
                          <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Recent reopenings</div>
                            <div className="mt-1 text-sm font-semibold text-slate-900">
                              {closePeriodIntelligence.sourceMetrics.recentReopenedPeriods ?? 0}
                            </div>
                          </div>
                        </div>
                      )}
                      {!!closePeriodIntelligence.blockers?.length && (
                        <div>
                          <div className="font-semibold text-rose-700">Blockers</div>
                          <ul className="mt-1 list-disc pl-4 text-slate-600">
                            {closePeriodIntelligence.blockers.slice(0, 3).map((blocker) => (
                              <li key={blocker}>{blocker}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!!closePeriodIntelligence.warnings?.length && (
                        <div>
                          <div className="font-semibold text-amber-700">Warnings</div>
                          <ul className="mt-1 list-disc pl-4 text-slate-600">
                            {closePeriodIntelligence.warnings.slice(0, 2).map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!!closePeriodIntelligence.recommendedActions?.length && (
                        <div>
                          <div className="font-semibold text-slate-700">Recommended actions</div>
                          <ul className="mt-1 list-disc pl-4 text-slate-600">
                            {closePeriodIntelligence.recommendedActions.slice(0, 3).map((action) => (
                              <li key={action}>{action}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {closePeriodIntelligence.canonicalStatus && (
                        <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          {closePeriodIntelligence.canonicalStatus.closePeriods && (
                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-700">
                              close periods {closePeriodIntelligence.canonicalStatus.closePeriods}
                            </span>
                          )}
                          {closePeriodIntelligence.canonicalStatus.evidence && (
                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-700">
                              evidence {closePeriodIntelligence.canonicalStatus.evidence}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900">Reconciliation exceptions</div>
                <span className="text-xs text-slate-500">{reconExceptions.length} open</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-white bg-white px-3 py-2 text-xs">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Open items</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{reconciliationSummary.totalItems}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-2 text-xs">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Pending match</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{reconciliationSummary.matchStatusCounts.pending_match || 0}</div>
                </div>
                <div className="rounded-lg border border-white bg-white px-3 py-2 text-xs">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Pending review</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">{reconciliationSummary.matchStatusCounts.pending_review || 0}</div>
                </div>
              </div>
              <ul className="mt-3 space-y-2">
                {reconExceptions.slice(0, 5).map((exception) => {
                  const reconciliationItemId = getReconciliationExceptionId(exception);
                  const currentMatchStatus = exception.matchStatus || getReconciliationExceptionStatus(exception);
                  const evidenceState = reconciliationEvidence[reconciliationItemId];
                  const draft = adjustingEntryDrafts[reconciliationItemId];
                  const hasSuggestedMatch = Boolean(exception.suggestedMatch?.journalEntryId);
                  return (
                  <li key={reconciliationItemId} className="rounded-lg border border-white bg-white px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-slate-800">{exception.reason || getReconciliationExceptionStatus(exception)}</span>
                      {exception.amount != null && <span className="tabular-nums text-slate-700">{fmtMoney(exception.amount)}</span>}
                    </div>
                    {exception.description && <div className="mt-1 text-slate-600">{exception.description}</div>}
                    {exception.notes && (
                      <div className="mt-1 text-slate-500">
                        {exception.notes}
                      </div>
                    )}
                    <div className="mt-1 text-slate-400">
                      {[exception.sourceRef, exception.occurredAt ? fmtDate(exception.occurredAt) : null]
                        .filter(Boolean)
                        .join(' · ') || 'No exception timestamp'}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800">
                        {getReconciliationExceptionStatus(exception).replace(/_/g, ' ')}
                      </span>
                      {exception.sourceSystem && (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                          {exception.sourceSystem}
                        </span>
                      )}
                      {exception.periodKey && (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                          {exception.periodKey}
                        </span>
                      )}
                    </div>
                    {exception.suggestedMatch && (
                      <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900">
                        Suggested match: {exception.suggestedMatch.sourceRef || exception.suggestedMatch.accountCode || exception.suggestedMatch.memo || 'candidate available'}
                      </div>
                    )}
                    {exception.matchResolution?.matchedSourceRef && (
                      <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-900">
                        Matched to {exception.matchResolution.matchedSourceRef}
                        {exception.matchResolution.matchReason ? ` · ${exception.matchResolution.matchReason}` : ''}
                      </div>
                    )}
                    {exception.matchResolution?.adjustmentEntry && (
                      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
                        Adjusting entry {exception.matchResolution.adjustmentEntry.debitAccountCode || 'debit'} / {exception.matchResolution.adjustmentEntry.creditAccountCode || 'credit'}
                        {exception.matchResolution.adjustmentEntry.amount != null ? ` · ${fmtMoney(exception.matchResolution.adjustmentEntry.amount)}` : ''}
                        {exception.matchResolution.adjustmentEntry.entryDate ? ` · ${exception.matchResolution.adjustmentEntry.entryDate}` : ''}
                      </div>
                    )}
                    <textarea
                      value={exceptionNotes[reconciliationItemId] || ''}
                      onChange={(e) => setExceptionNotes((current) => ({ ...current, [reconciliationItemId]: e.target.value }))}
                      placeholder="Reviewer note"
                      className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                      rows={2}
                    />
                    {!!exception.matchCandidates?.length && (
                      <div className="mt-3 space-y-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Match candidates</div>
                        {exception.matchCandidates.slice(0, 3).map((candidate) => (
                          <button
                            key={candidate.journalEntryId}
                            type="button"
                            onClick={() => reviewExceptionItem(exception, 'matched', {
                              journalEntryId: candidate.journalEntryId,
                              matchResolution: {
                                journalEntryId: candidate.journalEntryId,
                                matchedSourceRef: candidate.sourceRef,
                                matchedSourceSystem: exception.sourceSystem || null,
                                matchReason: `Matched to ${candidate.financeEventType || 'candidate'} ${candidate.sourceRef}`,
                              },
                            })}
                            disabled={exceptionActionBusy !== null}
                            className="block w-full rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-left hover:bg-emerald-100 disabled:opacity-50"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                              <span className="font-semibold text-emerald-900">{candidate.sourceRef}</span>
                              <span className="text-emerald-800">{fmtMoney(candidate.amount)} · {candidate.entryDate}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-slate-600">
                              {candidate.memo || candidate.counterpartyName || candidate.financeEventType || 'No memo'}
                              {candidate.dateDistanceDays ? ` · ${candidate.dateDistanceDays} day delta` : ' · same-day candidate'}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {currentMatchStatus !== 'pending_review' && (
                        <button
                          type="button"
                          onClick={() => reviewExceptionItem(exception, 'pending_review')}
                          disabled={exceptionActionBusy === `${reconciliationItemId}:pending_review`}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {exceptionActionBusy === `${reconciliationItemId}:pending_review` ? 'Saving…' : 'Needs review'}
                        </button>
                      )}
                      {(currentMatchStatus === 'pending_match' || hasSuggestedMatch) && (
                        <button
                          type="button"
                          onClick={() => reviewExceptionItem(exception, 'matched', {
                            journalEntryId: exception.suggestedMatch?.journalEntryId || null,
                            matchResolution: exception.suggestedMatch?.journalEntryId
                              ? {
                                  journalEntryId: exception.suggestedMatch.journalEntryId,
                                  matchReason: 'Marked matched from close cockpit suggestion',
                                }
                              : null,
                          })}
                          disabled={exceptionActionBusy === `${reconciliationItemId}:matched`}
                          className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          {exceptionActionBusy === `${reconciliationItemId}:matched` ? 'Saving…' : 'Match suggestion'}
                        </button>
                      )}
                      {currentMatchStatus !== 'resolved' && (
                        <button
                          type="button"
                          onClick={() => reviewExceptionItem(exception, 'resolved')}
                          disabled={exceptionActionBusy === `${reconciliationItemId}:resolved`}
                          className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                        >
                          {exceptionActionBusy === `${reconciliationItemId}:resolved` ? 'Saving…' : 'Resolve'}
                        </button>
                      )}
                      {currentMatchStatus !== 'ignored' && (
                        <button
                          type="button"
                          onClick={() => reviewExceptionItem(exception, 'ignored')}
                          disabled={exceptionActionBusy === `${reconciliationItemId}:ignored`}
                          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                        >
                          {exceptionActionBusy === `${reconciliationItemId}:ignored` ? 'Saving…' : 'Ignore'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleReconciliationEvidence(exception)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        {evidenceState?.open ? 'Hide evidence' : `Show evidence${evidenceState?.evidence.length ? ` (${evidenceState.evidence.length})` : ''}`}
                      </button>
                      {currentMatchStatus !== 'resolved' && currentMatchStatus !== 'ignored' && (
                        <button
                          type="button"
                          onClick={() => toggleAdjustingEntryDraft(exception)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {draft?.open ? 'Hide adjustment' : 'Adjust entry'}
                        </button>
                      )}
                    </div>

                    {draft?.open && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                        <label className="text-[11px] text-slate-600">
                          <div className="mb-1 font-medium">Entry date</div>
                          <input
                            type="date"
                            value={draft.entryDate}
                            onChange={(e) => updateAdjustingEntryDraft(reconciliationItemId, 'entryDate', e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                          />
                        </label>
                        <label className="text-[11px] text-slate-600">
                          <div className="mb-1 font-medium">Amount</div>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={draft.amount}
                            onChange={(e) => updateAdjustingEntryDraft(reconciliationItemId, 'amount', e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                          />
                        </label>
                        <label className="text-[11px] text-slate-600">
                          <div className="mb-1 font-medium">Debit account</div>
                          <select
                            value={draft.debitAccountCode}
                            onChange={(e) => updateAdjustingEntryDraft(reconciliationItemId, 'debitAccountCode', e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                          >
                            {bookkeeping.accounts.map((account) => (
                              <option key={`debit-${account.code}`} value={account.code}>{account.code} · {account.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-[11px] text-slate-600">
                          <div className="mb-1 font-medium">Credit account</div>
                          <select
                            value={draft.creditAccountCode}
                            onChange={(e) => updateAdjustingEntryDraft(reconciliationItemId, 'creditAccountCode', e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                          >
                            {bookkeeping.accounts.map((account) => (
                              <option key={`credit-${account.code}`} value={account.code}>{account.code} · {account.name}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-[11px] text-slate-600 sm:col-span-2">
                          <div className="mb-1 font-medium">Memo</div>
                          <input
                            type="text"
                            value={draft.memo}
                            onChange={(e) => updateAdjustingEntryDraft(reconciliationItemId, 'memo', e.target.value)}
                            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                          />
                        </label>
                        <div className="sm:col-span-2">
                          <button
                            type="button"
                            onClick={() => createAdjustingEntry(exception)}
                            disabled={exceptionActionBusy === `${reconciliationItemId}:adjusting-entry`}
                            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                          >
                            {exceptionActionBusy === `${reconciliationItemId}:adjusting-entry` ? 'Posting…' : 'Post adjusting entry'}
                          </button>
                        </div>
                      </div>
                    )}

                    {evidenceState?.open && (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Evidence trace</div>
                          <button
                            type="button"
                            onClick={() => loadReconciliationEvidence(exception)}
                            disabled={evidenceState.loading}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {evidenceState.loading ? 'Loading…' : 'Refresh'}
                          </button>
                        </div>
                        {evidenceState.loading && <div className="mt-2 text-slate-500">Loading reconciliation evidence…</div>}
                        {evidenceState.error && <div className="mt-2 text-rose-700">{evidenceState.error}</div>}
                        {evidenceState.status === 'not_configured' && !evidenceState.loading && !evidenceState.error && (
                          <div className="mt-2 text-slate-500">
                            Canonical finance evidence storage is not configured in this environment yet.
                          </div>
                        )}
                        {!evidenceState.loading && !evidenceState.error && evidenceState.status !== 'not_configured' && evidenceState.evidence.length === 0 && (
                          <div className="mt-2 text-slate-500">No linked evidence was found for this reconciliation item yet.</div>
                        )}
                        {!evidenceState.loading && evidenceState.evidence.length > 0 && (
                          <ul className="mt-2 space-y-2">
                            {evidenceState.evidence.slice(0, 4).map((evidenceItem) => (
                              <li key={evidenceItem.evidenceId} className="rounded-md border border-white bg-white px-3 py-2">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="font-semibold text-slate-800">{evidenceItem.title}</span>
                                  {evidenceItem.amount != null && <span className="tabular-nums text-slate-700">{fmtMoney(evidenceItem.amount)}</span>}
                                </div>
                                <div className="mt-1 text-slate-500">
                                  {[evidenceItem.vendorName, evidenceItem.documentDate ? fmtDate(evidenceItem.documentDate) : null]
                                    .filter(Boolean)
                                    .join(' · ') || evidenceItem.evidenceType.replace(/_/g, ' ')}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                  <span className={`rounded-full border px-2 py-0.5 ${traceStatusPillClass(evidenceItem.digitizationStatus)}`}>
                                    {evidenceItem.digitizationStatus || 'pending'}
                                  </span>
                                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                                    {evidenceItem.evidenceType.replace(/_/g, ' ')}
                                  </span>
                                </div>
                                {(evidenceItem.externalUrl || evidenceItem.storagePath) && (
                                  <div className="mt-1 text-[11px]">
                                    {evidenceItem.externalUrl ? (
                                      <a href={evidenceItem.externalUrl} target="_blank" rel="noreferrer" className="font-medium text-slate-700 underline hover:text-slate-900">
                                        Open source document
                                      </a>
                                    ) : (
                                      <span className="text-slate-500">Stored at {evidenceItem.storagePath}</span>
                                    )}
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                )})}
                {!pipelineLoading && reconExceptions.length === 0 && (
                  <li className="text-xs text-slate-500">No open reconciliation exceptions.</li>
                )}
              </ul>
            </div>

            <FinanceSearchWorkspace
              title="Evidence follow-up"
              subtitle="Search receipts, OCR text, supporting documents, and linked evidence without leaving the close workspace."
              propertyId={propertyId}
              year={Number(range.endDate.slice(0, 4))}
              indexedCount={evidenceSummary?.totalEvidence ?? 0}
              pendingCount={evidencePendingCount}
              presetQueries={['supporting receipt', 'repair invoice', 'bank statement', 'tenant payment']}
              placeholder="Search evidence, OCR text, vendor, amount, or source reference"
            />

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Finance documents follow-up</div>
                  <div className="mt-0.5 text-xs text-slate-500">Recent bookkeeping documents that still need OCR or evidence completion.</div>
                </div>
                <span className="text-xs text-slate-500">{pendingFinanceDocuments.length} needing follow-up</span>
              </div>
              <ul className="mt-3 space-y-2">
                {financeDocuments.slice(0, 4).map((document) => (
                  <li key={document.id} className="rounded-lg border border-white bg-white px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-800">{document.title}</div>
                        <div className="mt-1 text-slate-500">
                          {[document.vendorName, document.documentDate ? fmtDate(document.documentDate) : null]
                            .filter(Boolean)
                            .join(' · ') || 'No vendor or date recorded'}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${traceStatusPillClass(document.digitization?.status)}`}>
                            OCR {formatWorkflowStatus(document.digitization?.status)}
                          </span>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${traceStatusPillClass(document.evidenceShadow?.status)}`}>
                            Evidence {formatWorkflowStatus(document.evidenceShadow?.status)}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {document.amount != null && <div className="font-semibold tabular-nums text-slate-900">{fmtMoney(document.amount)}</div>}
                        <button
                          type="button"
                          onClick={() => downloadFinanceDocument(document)}
                          disabled={!document.downloadPath || documentDownloadId === document.id}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {documentDownloadId === document.id ? 'Downloading…' : 'Download'}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
                {!pipelineLoading && financeDocuments.length === 0 && (
                  <li className="text-xs text-slate-500">No bookkeeping finance documents uploaded yet.</li>
                )}
              </ul>
              <div className="mt-3 text-[11px] text-slate-500">
                Use the finance documents workspace below to upload new support, rerun search, and review OCR or evidence status in more detail.
              </div>
            </div>
          </div>
        </div>

        {pipelineNote && (
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-600">{pipelineNote}</div>
        )}
      </Card>
      </SectionHost>

      <SectionHost sectionId="finance-documents" nav={workspaceNav}>
      {bookkeeping.user ? (
        <BookkeepingFinanceDocuments />
      ) : (
        <Card>
          <CardHeader
            title="Finance documents"
            subtitle="Sign in as an owner to upload, search, and download bookkeeping support documents from this workspace."
          />
        </Card>
      )}
      </SectionHost>
      </div>

      {bookkeeping.error && (
        <div className="order-last rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          {bookkeeping.error}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}
