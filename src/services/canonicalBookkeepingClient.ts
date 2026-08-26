import {
  buildBookkeepingUrl,
  buildOwnerFinanceQuery,
  buildOwnerFinanceUrl,
  buildQuickBooksUrl,
  requestOwnerFinanceBlob,
  requestOwnerFinanceJson,
  type OwnerFinanceQueryValue,
} from './ownerFinanceApi';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type QueryParams = Record<string, OwnerFinanceQueryValue>;

export const bookkeepingClient = {
  getStatus() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/status'));
  },

  initialize() {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/initialize'),
      { method: 'POST' },
      JSON_HEADERS,
    );
  },

  listTransactions(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/transactions${buildOwnerFinanceQuery(params)}`),
    );
  },

  getSummary(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/summary${buildOwnerFinanceQuery(params)}`),
    );
  },

  listAccounts() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/accounts'));
  },

  getTrialBalance(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reports/trial-balance${buildOwnerFinanceQuery(params)}`),
    );
  },

  getProfitLoss(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reports/profit-loss${buildOwnerFinanceQuery(params)}`),
    );
  },

  getBalanceSheet(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reports/balance-sheet${buildOwnerFinanceQuery(params)}`),
    );
  },

  getBudgets() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/budgets'));
  },

  saveBudget(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/budgets'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  deleteBudget(accountCode: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/budgets/${encodeURIComponent(accountCode)}`),
      { method: 'DELETE' },
    );
  },

  initializeBudgets() {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/budgets/initialize'),
      { method: 'POST' },
    );
  },

  getBudgetVsActual(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/budget-vs-actual${buildOwnerFinanceQuery(params)}`),
    );
  },

  getCashflowTrend(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/cashflow-trend${buildOwnerFinanceQuery(params)}`),
    );
  },

  async getDashboard(params: QueryParams = {}) {
    // Load the owner bookkeeping dashboard in a gentler sequence. The
    // bookkeeping view often mounts alongside other finance/tax reads, so
    // avoiding a four-request burst here reduces Azure SQL timeout pressure.
    const transactions = await this.listTransactions(params);
    const summary = await this.getSummary(params);
    const accounts = await this.listAccounts();
    const trend = await this.getCashflowTrend(params);

    return { transactions, summary, accounts, trend };
  },

  createTransaction(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/transaction'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listClosePeriods(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/close-periods${buildOwnerFinanceQuery(params)}`),
    );
  },

  getClosePeriodIntelligence(periodKey: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/close-periods/${encodeURIComponent(periodKey)}/intelligence`),
    );
  },

  closePeriod(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/close-periods'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  reopenClosePeriod(periodKey: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/close-periods/${encodeURIComponent(periodKey)}/reopen`),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listReconciliationExceptions(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reconciliation-exceptions${buildOwnerFinanceQuery(params)}`),
    );
  },

  getReconciliationEvidence(reconciliationItemId: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reconciliation-exceptions/${encodeURIComponent(reconciliationItemId)}/evidence`),
    );
  },

  reviewReconciliationException(reconciliationItemId: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reconciliation-exceptions/${encodeURIComponent(reconciliationItemId)}/review`),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  createReconciliationAdjustingEntry(reconciliationItemId: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/reconciliation-exceptions/${encodeURIComponent(reconciliationItemId)}/adjusting-entry`),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  searchEvidence(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/evidence${buildOwnerFinanceQuery(params)}`),
    );
  },

  askFinanceQuestion(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/ai-query'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listFinanceDocuments(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/finance-documents${buildOwnerFinanceQuery(params)}`),
    );
  },

  uploadFinanceDocument(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/finance-documents'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listVendors(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/vendors${buildOwnerFinanceQuery(params)}`),
    );
  },

  upsertVendor(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/vendors'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  deleteVendor(vendorId: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/vendors/${encodeURIComponent(vendorId)}`),
      { method: 'DELETE' },
    );
  },

  listRecurringInvoiceTemplates() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/recurring-invoices'));
  },

  listInvoices() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/invoices'));
  },

  getAccountsReceivable() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/accounts-receivable'));
  },

  createInvoice(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/invoices'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  categorizeTransactionsAI(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/categorize-ai'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  applyAICategorizations(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/apply-categorizations'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listCategorizationRules(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/rules${buildOwnerFinanceQuery(params)}`),
    );
  },

  createCategorizationRule(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/rules'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  deleteCategorizationRule(ruleId: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/rules/${encodeURIComponent(ruleId)}`),
      { method: 'DELETE' },
    );
  },

  getCategorizationRuleStats(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/categorize/stats${buildOwnerFinanceQuery(params)}`),
    );
  },

  bulkCategorizeTransactions(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/categorize/bulk'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listRecurringJournalTemplates(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring${buildOwnerFinanceQuery(params)}`),
    );
  },

  createRecurringJournalTemplate(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/recurring'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  updateRecurringJournalTemplate(templateId: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring/${encodeURIComponent(templateId)}`),
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  deleteRecurringJournalTemplate(templateId: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring/${encodeURIComponent(templateId)}`),
      { method: 'DELETE' },
    );
  },

  generateRecurringJournalEntries(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/recurring/generate'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  listUpcomingRecurringJournalTemplates(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring/upcoming${buildOwnerFinanceQuery(params)}`),
    );
  },

  listRecurringJournalPresets() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/recurring/templates'));
  },

  createRecurringInvoiceTemplate(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/recurring-invoices'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  updateRecurringInvoiceTemplate(templateId: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring-invoices/${encodeURIComponent(templateId)}`),
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  deleteRecurringInvoiceTemplate(templateId: string) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/recurring-invoices/${encodeURIComponent(templateId)}`),
      { method: 'DELETE' },
    );
  },

  generateRecurringInvoices(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/invoices/generate-recurring'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  markInvoicePaid(invoiceId: string, payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/invoices/${encodeURIComponent(invoiceId)}/mark-paid`),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  get1099Report(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl(`/1099-report${buildOwnerFinanceQuery(params)}`),
    );
  },

  loadMockData(
    year: number = 2025,
    options: { propertyId?: string; propertyAddress?: string } = {},
  ) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/load-mock-data'),
      {
        method: 'POST',
        body: JSON.stringify({ year, ...options }),
      },
      JSON_HEADERS,
    );
  },

  clearMockData() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/clear-mock-data'), {
      method: 'DELETE',
    });
  },

  clearBankEntries() {
    return requestOwnerFinanceJson(buildBookkeepingUrl('/clear-bank-entries'), {
      method: 'DELETE',
    });
  },

  clearLiveTransactions(payload: { startDate?: string; endDate?: string; propertyId?: string } = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/clear-live-transactions'),
      {
        method: 'DELETE',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  syncSampleTransactions(payload: { transactions: unknown[]; propertyId?: string }) {
    return requestOwnerFinanceJson(
      buildBookkeepingUrl('/sync-sample-transactions'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  previewQuickBooksSync(month: string, propertyCode?: string) {
    return requestOwnerFinanceJson(
      buildQuickBooksUrl(`/sync/preview/${month}${buildOwnerFinanceQuery({ property_code: propertyCode })}`),
    );
  },

  pushQuickBooksSync(month: string, propertyCode?: string) {
    return requestOwnerFinanceJson(
      buildQuickBooksUrl(`/sync/push/${month}`),
      {
        method: 'POST',
        body: JSON.stringify({ property_code: propertyCode }),
      },
      JSON_HEADERS,
    );
  },

  importQuickBooksTransactions(transactions: unknown[]) {
    return requestOwnerFinanceJson(
      buildQuickBooksUrl('/import'),
      {
        method: 'POST',
        body: JSON.stringify({ transactions }),
      },
      JSON_HEADERS,
    );
  },

  downloadOwnerFile(downloadPath: string) {
    return requestOwnerFinanceBlob(buildOwnerFinanceUrl(downloadPath));
  },
};

export default bookkeepingClient;