import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateDepreciation, calculateQuarterlyEstimate, generateScheduleE } from './tax-engine-firestore.js';
import { getTax1099ThresholdForTaxYear, getTaxRulesetPackage } from '../src/shared/taxRules.js';
import {
  buildProfitLossFromEntries,
  buildTrialBalanceFromAccounts,
  listLedgerAccountsFromAzure,
  listLedgerEntriesFromAzure
} from './accounting-core/ledgerReadModel.js';
import {
  ensureBookkeepingInitializedInAzure,
  listBookkeepingPropertiesFromAzure,
  listBookkeepingVendorsFromAzure,
  upsertBookkeepingAccountInAzure,
  upsertBookkeepingPropertyInAzure,
  upsertBookkeepingVendorInAzure
} from './accounting-core/bookkeepingMetadataStore.js';
import { listEstimatedTaxPaymentsFromAzure, recordEstimatedTaxPaymentToAzure } from './accounting-core/estimatedTaxPaymentStore.js';
import { postCanonicalManualJournalEntry } from './accounting-core/manualJournalBridge.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './accounting-core/azureSqlClient.js';
import { loadTaxRulesetForRuntime } from './accounting-core/taxRulesetStore.js';
import { loadAccountingFixtureDefinition, resolveAccountingFixturePaths } from './accounting-fixtures/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, 'accounting-fixtures');

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function getExpectedRulesVersionForTaxYear(taxYear) {
  const ruleset = getTaxRulesetPackage(taxYear);
  if (!ruleset?.rulesVersion) {
    throw new Error(`No approved rulesVersion is available for tax year ${taxYear}`);
  }
  return ruleset.rulesVersion;
}

function assertRulesVersionMatchesTaxYear(taxYear, rulesVersion, context) {
  const expectedRulesVersion = getExpectedRulesVersionForTaxYear(taxYear);
  if (rulesVersion !== expectedRulesVersion) {
    throw new Error(`${context}: expected rulesVersion ${expectedRulesVersion} for tax year ${taxYear}, received ${rulesVersion}`);
  }
}

function dedupeEstimatedPayments(payments = []) {
  const seen = new Set();
  return (payments || []).filter((payment) => {
    const key = [
      Number(payment.taxYear || 0),
      Number(payment.quarter || 0),
      roundCurrency(payment.amount),
      String(payment.datePaid || ''),
      String(payment.paymentMethod || 'unknown'),
    ].join('::');

    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortObject(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function findFirstDifference(expected, actual, currentPath = 'root') {
  if (typeof expected !== typeof actual) {
    return `${currentPath}: expected ${typeof expected}, received ${typeof actual}`;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${currentPath}: expected array length ${expected.length}, received ${actual.length}`;
    }

    for (let index = 0; index < expected.length; index += 1) {
      const difference = findFirstDifference(expected[index], actual[index], `${currentPath}[${index}]`);
      if (difference) {
        return difference;
      }
    }

    return null;
  }

  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();

    if (expectedKeys.join('|') !== actualKeys.join('|')) {
      return `${currentPath}: expected keys ${expectedKeys.join(', ')}, received ${actualKeys.join(', ')}`;
    }

    for (const key of expectedKeys) {
      const difference = findFirstDifference(expected[key], actual[key], `${currentPath}.${key}`);
      if (difference) {
        return difference;
      }
    }

    return null;
  }

  return expected === actual ? null : `${currentPath}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

function calculateLineBalanceChange(accountType, line) {
  if (['LIABILITY', 'EQUITY', 'REVENUE'].includes(accountType)) {
    return line.dc === 'C' ? line.amount : -line.amount;
  }

  return line.dc === 'D' ? line.amount : -line.amount;
}

function computeFixtureBalances(fixture) {
  const balances = new Map();

  Object.keys(fixture.accounts).forEach((accountCode) => {
    balances.set(accountCode, 0);
  });

  fixture.entries.forEach((entry) => {
    (entry.lines || []).forEach((line) => {
      const account = fixture.accounts[line.accountCode];
      if (!account) {
        throw new Error(`Fixture account metadata missing for ${line.accountCode}`);
      }

      const runningBalance = balances.get(line.accountCode) || 0;
      balances.set(line.accountCode, runningBalance + calculateLineBalanceChange(account.type, line));
    });
  });

  return balances;
}

function buildLegacyTrialBalance(fixture, balances) {
  let totalDebits = 0;
  let totalCredits = 0;

  const accounts = Object.entries(fixture.accounts)
    .map(([code, account]) => {
      const balance = roundCurrency(balances.get(code) || 0);
      const isDebitNormal = ['ASSET', 'EXPENSE'].includes(account.type);
      const debits = isDebitNormal ? Math.max(0, balance) : Math.max(0, -balance);
      const credits = isDebitNormal ? Math.max(0, -balance) : Math.max(0, balance);
      totalDebits += debits;
      totalCredits += credits;

      return {
        code,
        name: account.name,
        type: account.type,
        balance,
        debits: roundCurrency(debits),
        credits: roundCurrency(credits)
      };
    })
    .filter((account) => Math.abs(account.balance) > 0.004)
    .sort((left, right) => left.code.localeCompare(right.code));

  return {
    totalDebits: roundCurrency(totalDebits),
    totalCredits: roundCurrency(totalCredits),
    isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
    accounts
  };
}

function buildLegacyProfitLoss(fixture, balances) {
  const revenues = [];
  const expenses = [];
  let totalRevenue = 0;
  let totalExpenses = 0;

  Object.entries(fixture.accounts).forEach(([code, account]) => {
    const balance = roundCurrency(balances.get(code) || 0);

    if (account.type === 'REVENUE' && Math.abs(balance) > 0.004) {
      revenues.push({ code, name: account.name, amount: balance });
      totalRevenue += balance;
    }

    if (account.type === 'EXPENSE' && Math.abs(balance) > 0.004) {
      expenses.push({ code, name: account.name, amount: balance });
      totalExpenses += balance;
    }
  });

  revenues.sort((left, right) => right.amount - left.amount);
  expenses.sort((left, right) => right.amount - left.amount);

  return {
    revenues,
    expenses,
    summary: {
      totalRevenue: roundCurrency(totalRevenue),
      totalExpenses: roundCurrency(totalExpenses),
      netIncome: roundCurrency(totalRevenue - totalExpenses)
    }
  };
}

function buildScheduleESnapshot(scheduleE) {
  return {
    summary: scheduleE.summary,
    entryCount: scheduleE.entryCount,
    lineAmounts: Object.entries(scheduleE.scheduleELines)
      .filter(([, line]) => line.amount !== 0)
      .reduce((accumulator, [key, line]) => {
        accumulator[key] = roundCurrency(line.amount);
        return accumulator;
      }, {})
  };
}

function buildDepreciationSnapshot(depreciation) {
  return {
    summary: depreciation.summary,
    assets: depreciation.assets.map((asset) => ({
      propertyId: asset.propertyId,
      propertyName: asset.propertyName,
      depreciableBasis: asset.depreciableBasis,
      currentYearDepreciation: asset.currentYearDepreciation,
      accumulatedDepreciation: asset.accumulatedDepreciation,
      remainingBasis: asset.remainingBasis
    }))
  };
}

function build1099Summary({ entries = [], vendors = [], taxYear }) {
  const threshold1099 = getTax1099ThresholdForTaxYear(taxYear);
  const paymentsByVendor = new Map();
  const vendorInfoByName = new Map((vendors || []).map((vendor) => [vendor.name, vendor]));

  entries
    .filter((entry) => (entry.transactionType || entry.type) === 'expense' && (entry.payee || entry.vendor))
    .forEach((entry) => {
      const payee = entry.payee || entry.vendor;
      const amount = Math.abs(Number(entry.amount) || 0);
      paymentsByVendor.set(payee, roundCurrency((paymentsByVendor.get(payee) || 0) + amount));
    });

  const summaryVendors = Array.from(paymentsByVendor.entries())
    .map(([name, totalPaid]) => {
      const vendor = vendorInfoByName.get(name) || {};
      const requires1099 = totalPaid >= threshold1099 && vendor.vendorType !== 'ccorp' && vendor.vendorType !== 'corporation';
      const hasTIN = !!(vendor.ein || vendor.ssnLast4);
      const hasAddress = !!vendor.address;
      const hasW9 = !!vendor.w9OnFile;

      return {
        name,
        totalPaid: roundCurrency(totalPaid),
        requires1099,
        ready: requires1099 && hasTIN && hasAddress && hasW9,
        missingInfo: requires1099 ? [
          !hasTIN ? 'TIN' : null,
          !hasAddress ? 'Address' : null,
          !hasW9 ? 'W-9' : null
        ].filter(Boolean) : []
      };
    })
    .sort((left, right) => right.totalPaid - left.totalPaid);

  const reportableVendors = summaryVendors.filter((vendor) => vendor.requires1099);

  return {
    threshold1099,
    totalForms: reportableVendors.length,
    totalAmount: roundCurrency(reportableVendors.reduce((sum, vendor) => sum + vendor.totalPaid, 0)),
    formsReady: reportableVendors.filter((vendor) => vendor.ready).length,
    formsWithMissingInfo: reportableVendors.filter((vendor) => vendor.missingInfo.length > 0).length,
    vendors: summaryVendors
  };
}

function buildCashflowTrendSnapshot(entries = []) {
  const monthly = new Map();

  (entries || []).forEach((entry) => {
    const type = entry.transactionType || entry.type;
    if (!['income', 'expense'].includes(type)) {
      return;
    }

    const dateValue = entry.entryDate || entry.date || '';
    const monthKey = String(dateValue).slice(0, 7);
    if (!monthKey) {
      return;
    }

    const current = monthly.get(monthKey) || {
      month: new Date(`${monthKey}-01T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
      year: Number(monthKey.slice(0, 4)),
      revenue: 0,
      expenses: 0,
      entryCount: 0,
    };

    const amount = roundCurrency(Number(entry.amount) || 0);
    if (type === 'income') {
      current.revenue += amount;
    }
    if (type === 'expense') {
      current.expenses += amount;
    }
    current.entryCount += 1;
    monthly.set(monthKey, current);
  });

  return Array.from(monthly.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => ({
      month: row.month,
      year: row.year,
      revenue: roundCurrency(row.revenue),
      income: roundCurrency(row.revenue),
      expenses: roundCurrency(row.expenses),
      net: roundCurrency(row.revenue - row.expenses),
      net_income: roundCurrency(row.revenue - row.expenses),
      entryCount: row.entryCount,
    }));
}

function determineEstimatedPaymentStatus({ asOfDate, taxYear, quarter, due, paid, dueDate }) {
  const asOf = new Date(`${asOfDate}T23:59:59Z`);
  const dueAt = new Date(`${dueDate}T23:59:59Z`);
  const quarterEndDate = {
    1: `${taxYear}-03-31`,
    2: `${taxYear}-06-30`,
    3: `${taxYear}-09-30`,
    4: `${taxYear}-12-31`,
  }[quarter];
  const quarterEnd = new Date(`${quarterEndDate}T23:59:59Z`);

  if (paid > 0 && paid >= due) {
    return 'paid';
  }
  if (paid > 0) {
    return 'partial';
  }
  if (due === 0 && asOf <= quarterEnd) {
    return 'upcoming';
  }
  if (due === 0 && asOf > quarterEnd) {
    return 'no_tax_due';
  }
  if (asOf > dueAt) {
    return 'overdue';
  }
  return 'unpaid';
}

function buildEstimatedTaxesSnapshot({ fixture, entries = [], payments = [], ruleset = null }) {
  if (!fixture.taxProjection?.assumptions) {
    return null;
  }

  const asOfDate = fixture.taxProjection.asOfDate || `${fixture.taxYear}-12-31`;
  const projectionQuarter = Math.min(4, Math.max(1, Math.ceil((new Date(`${asOfDate}T12:00:00Z`).getUTCMonth() + 1) / 3)));
  const normalizedEntries = (entries || []).map((entry) => ({
    date: entry.entryDate || entry.date,
    amount: Number(entry.amount) || 0,
    type: entry.transactionType || entry.type || '',
    category: entry.category || '',
    description: entry.description || entry.memo || '',
    vendor: entry.payee || entry.vendor || '',
    propertyId: entry.propertyId || null,
  }));
  const normalizedPayments = dedupeEstimatedPayments(payments).map((payment) => ({
    taxYear: Number(payment.taxYear || fixture.taxYear),
    quarter: Number(payment.quarter),
    amount: roundCurrency(payment.amount),
    datePaid: payment.datePaid,
    paymentMethod: payment.paymentMethod || 'unknown',
  }));
  const depreciation = calculateDepreciation(fixture.properties || [], fixture.taxYear, ruleset || null);
  const rentalStates = Array.from(new Set((fixture.properties || []).map((property) => String(property.state || property.attomState || '').trim().toUpperCase()).filter(Boolean)));

  const quarters = [1, 2, 3, 4].map((quarter) => {
    const estimate = calculateQuarterlyEstimate(
      normalizedEntries,
      fixture.taxYear,
      quarter,
      {
        ...fixture.taxProjection.assumptions,
        annualDepreciation: depreciation?.summary?.totalCurrentYearDepreciation || 0,
        rentalStates,
        projectionQuarter,
        properties: fixture.properties || [],
      },
      ruleset || null,
    );
    const paid = roundCurrency(
      normalizedPayments
        .filter((payment) => payment.taxYear === fixture.taxYear && payment.quarter === quarter)
        .reduce((sum, payment) => sum + payment.amount, 0),
    );
    const due = roundCurrency(estimate.estimatedTax.total);

    return {
      quarter,
      estimatedDue: due,
      paid,
      remaining: roundCurrency(Math.max(0, due - paid)),
      dueDate: estimate.dueDate,
      status: determineEstimatedPaymentStatus({
        asOfDate,
        taxYear: fixture.taxYear,
        quarter,
        due,
        paid,
        dueDate: estimate.dueDate,
      }),
      breakdown: {
        income: estimate.income,
        expenses: estimate.expenses,
        netIncome: estimate.netIncome,
        federal: estimate.estimatedTax.federal,
        state: estimate.estimatedTax.state,
        annualizedIncome: estimate.annualized.income,
        annualizedTaxableIncome: estimate.annualized.taxableIncome,
      },
    };
  });

  return {
    asOfDate,
    assumptions: fixture.taxProjection.assumptions,
    payments: normalizedPayments,
    quarters,
    summary: {
      totalEstimatedDue: roundCurrency(quarters.reduce((sum, quarter) => sum + quarter.estimatedDue, 0)),
      totalPaid: roundCurrency(quarters.reduce((sum, quarter) => sum + quarter.paid, 0)),
      totalRemaining: roundCurrency(quarters.reduce((sum, quarter) => sum + quarter.remaining, 0)),
    },
  };
}

function buildLegacySnapshot(fixture) {
  const ruleset = getTaxRulesetPackage(fixture.taxYear);
  assertRulesVersionMatchesTaxYear(fixture.taxYear, ruleset.rulesVersion, 'Legacy cutover snapshot');
  const balances = computeFixtureBalances(fixture);
  const trialBalance = buildLegacyTrialBalance(fixture, balances);
  const profitLoss = buildLegacyProfitLoss(fixture, balances);
  const scheduleE = generateScheduleE(
    fixture.entries.map((entry) => ({
      date: entry.date,
      category: entry.category || '',
      amount: Number(entry.amount) || 0,
      description: entry.memo || '',
      vendor: entry.vendor || '',
      propertyId: entry.propertyId || null
    })),
    fixture.taxYear,
    null,
    fixture.properties || []
  );
  const depreciation = calculateDepreciation(fixture.properties || [], fixture.taxYear);
  const vendors1099 = build1099Summary({
    entries: fixture.entries.map((entry) => ({
      type: entry.type,
      amount: entry.amount,
      vendor: entry.vendor || ''
    })),
    vendors: fixture.vendors || [],
    taxYear: fixture.taxYear
  });
  const cashflowTrend = buildCashflowTrendSnapshot(fixture.entries || []);
  const estimatedTaxes = buildEstimatedTaxesSnapshot({
    fixture,
    entries: fixture.entries || [],
    payments: fixture.estimatedTaxPayments || [],
  });

  return sortObject({
    fixtureName: fixture.fixtureName,
    taxYear: fixture.taxYear,
    rulesVersion: ruleset.rulesVersion,
    summary: {
      entryCount: fixture.entries.length,
      propertyCount: (fixture.properties || []).length,
      vendorCount: (fixture.vendors || []).length
    },
    trialBalance,
    profitLoss,
    scheduleE: buildScheduleESnapshot(scheduleE),
    depreciation: buildDepreciationSnapshot(depreciation),
    vendors1099,
    cashflowTrend,
    estimatedTaxes,
  });
}

function buildCanonicalSnapshot({ fixture, entries, accounts, properties, vendors, estimatedPayments, ruleset, rulesVersion }) {
  const populatedAccounts = (accounts || [])
    .filter((account) => Math.abs(Number(account.balance) || 0) > 0.004)
    .sort((left, right) => left.code.localeCompare(right.code));
  const trialBalance = buildTrialBalanceFromAccounts(populatedAccounts);
  const profitLoss = buildProfitLossFromEntries(entries || []);
  const scheduleE = generateScheduleE(
    (entries || []).map((entry) => ({
      id: entry.id,
      date: entry.entryDate,
      category: entry.category || '',
      amount: Number(entry.amount) || 0,
      description: entry.description || entry.memo || '',
      vendor: entry.payee || entry.vendor || '',
      propertyId: entry.propertyId || null
    })),
    fixture.taxYear,
    null,
    properties || [],
    ruleset || null
  );
  const depreciation = calculateDepreciation(properties || [], fixture.taxYear, ruleset || null);
  const vendors1099 = build1099Summary({
    entries: (entries || []).map((entry) => ({
      transactionType: entry.transactionType || entry.type,
      amount: entry.amount,
      payee: entry.payee || entry.vendor || ''
    })),
    vendors: vendors || [],
    taxYear: fixture.taxYear
  });
  const cashflowTrend = buildCashflowTrendSnapshot(entries || []);
  const estimatedTaxes = buildEstimatedTaxesSnapshot({
    fixture,
    entries: entries || [],
    payments: estimatedPayments || [],
    ruleset: ruleset || null,
  });

  return sortObject({
    fixtureName: fixture.fixtureName,
    taxYear: fixture.taxYear,
    rulesVersion,
    summary: {
      entryCount: (entries || []).length,
      propertyCount: (properties || []).length,
      vendorCount: (vendors || []).length
    },
    trialBalance: {
      totalDebits: trialBalance.totalDebits,
      totalCredits: trialBalance.totalCredits,
      isBalanced: trialBalance.isBalanced,
      accounts: trialBalance.accounts.map((account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        balance: account.balance,
        debits: account.debits,
        credits: account.credits
      }))
    },
    profitLoss: {
      revenues: profitLoss.revenues.map((row) => ({
        code: row.code,
        name: row.name,
        amount: row.amount
      })),
      expenses: profitLoss.expenses.map((row) => ({
        code: row.code,
        name: row.name,
        amount: row.amount
      })),
      summary: {
        totalRevenue: profitLoss.totalRevenue,
        totalExpenses: profitLoss.totalExpenses,
        netIncome: profitLoss.netIncome
      }
    },
    scheduleE: buildScheduleESnapshot(scheduleE),
    depreciation: buildDepreciationSnapshot(depreciation),
    vendors1099,
    cashflowTrend,
    estimatedTaxes,
  });
}

function parseArgs(args) {
  const options = {
    fixtureName: 'baseline-rental-ledger',
    userId: 'fixture-user'
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      options.fixtureName = arg;
      continue;
    }

    if (arg === '--user-id' && args[index + 1]) {
      options.userId = args[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--user-id=')) {
      options.userId = arg.slice('--user-id='.length);
    }
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildFixtureReportPath(fixtureName) {
  return path.join(fixtureDir, `${fixtureName}.cutover-report.json`);
}

async function executeUserScopedDelete(transaction, sql, label, query, userId) {
  const request = transaction.request();
  request.input('userId', sql.NVarChar(128), userId);
  const result = await request.query(query);
  return {
    label,
    affectedRows: (result.rowsAffected || []).reduce((sum, count) => sum + count, 0)
  };
}

async function cleanupFixtureUserFromAzure(userId) {
  if (!isAzureSqlConfigured()) {
    return {
      ok: false,
      status: 'not_configured',
      steps: []
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const transaction = new sql.Transaction(pool);
  const steps = [];
  await transaction.begin();

  try {
    steps.push(await executeUserScopedDelete(transaction, sql, 'evidence_links', `
      DELETE evidence_link
      FROM accounting.evidence_links AS evidence_link
      INNER JOIN accounting.finance_evidence AS evidence
        ON evidence.evidence_id = evidence_link.evidence_id
      WHERE evidence.user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'finance_evidence', `
      DELETE FROM accounting.finance_evidence
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'workpaper_snapshots', `
      DELETE FROM accounting.workpaper_snapshots
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'close_periods', `
      DELETE FROM accounting.close_periods
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'estimated_tax_payments', `
      DELETE FROM accounting.estimated_tax_payments
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'reconciliation_items', `
      DELETE reconciliation_item
      FROM accounting.reconciliation_items AS reconciliation_item
      INNER JOIN accounting.reconciliation_sessions AS reconciliation_session
        ON reconciliation_session.reconciliation_session_id = reconciliation_item.reconciliation_session_id
      WHERE reconciliation_session.user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'reconciliation_sessions', `
      DELETE FROM accounting.reconciliation_sessions
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'subledger_tenant', `
      DELETE FROM accounting.subledger_tenant
      WHERE journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'subledger_vendor', `
      DELETE FROM accounting.subledger_vendor
      WHERE journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'subledger_security_deposit', `
      DELETE FROM accounting.subledger_security_deposit
      WHERE journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'subledger_owner_equity', `
      DELETE FROM accounting.subledger_owner_equity
      WHERE journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'journal_lines', `
      DELETE FROM accounting.journal_lines
      WHERE journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'idempotency_keys', `
      DELETE FROM accounting.idempotency_keys
      WHERE posted_journal_entry_id IN (
        SELECT journal_entry_id
        FROM accounting.journal_entries
        WHERE user_id = @userId
      )
      OR source_event_id IN (
        SELECT source_event_id
        FROM accounting.source_events
        WHERE user_id = @userId
      );
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'journal_entries', `
      DELETE FROM accounting.journal_entries
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'finance_events', `
      DELETE FROM accounting.finance_events
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'source_events', `
      DELETE FROM accounting.source_events
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'bookkeeping_vendors', `
      DELETE FROM accounting.bookkeeping_vendors
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'bookkeeping_properties', `
      DELETE FROM accounting.bookkeeping_properties
      WHERE user_id = @userId;
    `, userId));
    steps.push(await executeUserScopedDelete(transaction, sql, 'bookkeeping_accounts', `
      DELETE FROM accounting.bookkeeping_accounts
      WHERE user_id = @userId;
    `, userId));
    await transaction.commit();

    return {
      ok: true,
      status: 'cleaned',
      steps
    };
  } catch (error) {
    await transaction.rollback().catch(() => {});
    throw error;
  }
}

async function seedFixtureMetadata(userId, fixture) {
  await ensureBookkeepingInitializedInAzure({ userId });

  for (const [code, account] of Object.entries(fixture.accounts || {})) {
    await upsertBookkeepingAccountInAzure({
      userId,
      code,
      name: account.name,
      type: account.type,
      subtype: account.subtype || null,
      isActive: true
    });
  }

  for (const property of fixture.properties || []) {
    await upsertBookkeepingPropertyInAzure({
      userId,
      id: property.id,
      name: property.name || property.propertyName || property.address,
      address: property.address || '',
      state: property.state || null,
      purchaseDate: property.purchaseDate || null,
      purchasePrice: property.purchasePrice || 0,
      landValue: property.landValue || 0,
      improvementValue: property.improvementValue || 0,
      description: property.description || 'Residential Rental Property',
      usefulLifeMonths: property.usefulLifeMonths || 330,
      fairRentalDays: property.fairRentalDays || 365,
      personalUseDays: property.personalUseDays || 0,
      metadata: {
        fixtureName: fixture.fixtureName,
        legacyId: property.id,
        purchaseDate: property.purchaseDate || null,
        purchasePrice: property.purchasePrice || 0,
        landValue: property.landValue || 0,
        improvementValue: property.improvementValue || 0
      }
    });
  }

  for (const vendor of fixture.vendors || []) {
    await upsertBookkeepingVendorInAzure({
      userId,
      id: vendor.id || null,
      name: vendor.name,
      vendorType: vendor.vendorType || 'unknown',
      ein: vendor.ein || null,
      ssnLast4: vendor.ssnLast4 || null,
      address: vendor.address || null,
      city: vendor.city || null,
      state: vendor.state || null,
      zip: vendor.zip || null,
      email: vendor.email || null,
      phone: vendor.phone || null,
      w9OnFile: Boolean(vendor.w9OnFile),
      w9Date: vendor.w9Date || null,
      notes: vendor.notes || '',
      metadata: {
        fixtureName: fixture.fixtureName,
        legacyId: vendor.id || vendor.name
      }
    });
  }

  return {
    accountCount: Object.keys(fixture.accounts || {}).length,
    propertyCount: (fixture.properties || []).length,
    vendorCount: (fixture.vendors || []).length
  };
}

async function seedFixtureEntries(userId, fixture) {
  const results = [];

  for (const entry of fixture.entries || []) {
    const journalEntryId = `${userId}:${fixture.fixtureName}:${entry.id}`;
    const result = await postCanonicalManualJournalEntry({
      userId,
      journalEntryId,
      entry: {
        entryDate: entry.date,
        memo: entry.memo || entry.id,
        source: 'FIXTURE',
        sourceRef: `fixture:${fixture.fixtureName}:${entry.id}`,
        propertyId: entry.propertyId || null,
        category: entry.category || null,
        vendor: entry.vendor || null,
        hasReceipt: false,
        metadata: {
          fixtureName: fixture.fixtureName,
          legacyId: entry.id,
          legacyType: entry.type || null
        },
        lines: (entry.lines || []).map((line) => ({
          accountCode: line.accountCode,
          accountName: line.accountName,
          amount: line.amount,
          dc: line.dc,
          memo: line.memo || entry.memo || '',
          propertyId: line.propertyId || entry.propertyId || null
        }))
      },
      postedBy: 'accounting-cutover-fixture',
      idempotencyScope: 'accounting-cutover-fixture',
      sourceSystem: 'HOUSEYIELD_FIXTURE',
      sourceEventType: 'accounting.fixture.manual_journal'
    });

    results.push({
      legacyId: entry.id,
      status: result.status,
      journalEntryId: result.journalEntryId || null,
      financeEventId: result.financeEventId || null
    });
  }

  return {
    entryCount: results.length,
    postedCount: results.filter((result) => result.status === 'posted').length,
    duplicateCount: results.filter((result) => result.status === 'duplicate').length,
    statuses: results
  };
}

async function seedFixtureEstimatedPayments(userId, fixture) {
  const results = [];

  for (const payment of fixture.estimatedTaxPayments || []) {
    const result = await recordEstimatedTaxPaymentToAzure({
      userId,
      taxYear: payment.taxYear || fixture.taxYear,
      quarter: payment.quarter,
      amount: payment.amount,
      datePaid: payment.datePaid || null,
      paymentMethod: payment.paymentMethod || 'fixture-eftps'
    });

    results.push({
      quarter: Number(payment.quarter),
      amount: roundCurrency(payment.amount),
      paymentId: result.payment?.id || null,
      status: result.status || 'unknown'
    });
  }

  return {
    paymentCount: results.length,
    readyCount: results.filter((result) => result.status === 'ready').length,
    payments: results
  };
}

async function buildCanonicalState(userId, fixture) {
  const rulesRuntime = await loadTaxRulesetForRuntime({ taxYear: fixture.taxYear, requireApproved: true });
  const ruleset = rulesRuntime.ruleset || null;
  const rulesVersion = ruleset?.rulesVersion || ruleset?.version || null;
  assertRulesVersionMatchesTaxYear(fixture.taxYear, rulesVersion, 'Canonical cutover snapshot');
  const startDate = `${fixture.taxYear}-01-01`;
  const endDate = `${fixture.taxYear}-12-31`;

  const [entriesResult, accountsResult, propertiesResult, vendorsResult, estimatedPaymentsResult] = await Promise.all([
    listLedgerEntriesFromAzure({ userId, startDate, endDate, limit: 10000 }),
    listLedgerAccountsFromAzure({ userId, includeInactive: true }),
    listBookkeepingPropertiesFromAzure({ userId }),
    listBookkeepingVendorsFromAzure({ userId }),
    listEstimatedTaxPaymentsFromAzure({ userId, taxYear: fixture.taxYear }),
  ]);

  return {
    rulesRuntime: {
      ok: rulesRuntime.ok,
      status: rulesRuntime.status,
      source: rulesRuntime.source,
      bootstrapStatus: rulesRuntime.bootstrapStatus || null,
      approvedBy: rulesRuntime.approvedBy || null,
      approvalStatus: rulesRuntime.approvalStatus || null,
      rulesVersion
    },
    snapshot: buildCanonicalSnapshot({
      fixture,
      entries: entriesResult.entries || [],
      accounts: accountsResult.accounts || [],
      properties: propertiesResult.properties || [],
      vendors: vendorsResult.vendors || [],
      estimatedPayments: estimatedPaymentsResult.payments || [],
      ruleset,
      rulesVersion
    })
  };
}

async function main() {
  const { fixtureName, userId } = parseArgs(process.argv.slice(2));
  const { fixtureJsPath, fixtureJsonPath, expectedPath } = resolveAccountingFixturePaths(fixtureName);
  const fixturePath = fs.existsSync(fixtureJsPath) ? fixtureJsPath : fixtureJsonPath;
  const reportPath = buildFixtureReportPath(fixtureName);

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }

  if (!isAzureSqlConfigured()) {
    throw new Error('Azure SQL is not configured. Set AZURE_SQL_SERVER, AZURE_SQL_DATABASE, AZURE_SQL_USER, and AZURE_SQL_PASSWORD before running the cutover fixture harness.');
  }

  const fixture = await loadAccountingFixtureDefinition(fixtureName);
  const legacySnapshot = buildLegacySnapshot(fixture);
  const storedExpectedSnapshot = fs.existsSync(expectedPath) ? sortObject(readJson(expectedPath)) : null;
  const storedExpectedDifference = storedExpectedSnapshot ? findFirstDifference(storedExpectedSnapshot, legacySnapshot) : null;
  const cleanup = await cleanupFixtureUserFromAzure(userId);
  const metadataSeed = await seedFixtureMetadata(userId, fixture);
  const entrySeed = await seedFixtureEntries(userId, fixture);
  const estimatedTaxPaymentSeed = await seedFixtureEstimatedPayments(userId, fixture);
  const canonicalState = await buildCanonicalState(userId, fixture);
  const cutoverDifference = findFirstDifference(legacySnapshot, canonicalState.snapshot);
  const report = {
    fixtureName,
    userId,
    generatedAt: new Date().toISOString(),
    cleanup,
    metadataSeed,
    entrySeed,
    estimatedTaxPaymentSeed,
    runtimeRules: canonicalState.rulesRuntime,
    storedExpectedSnapshotMatched: !storedExpectedDifference,
    storedExpectedDifference,
    cutoverPassed: !cutoverDifference && !storedExpectedDifference,
    cutoverDifference,
    legacySnapshot,
    canonicalSnapshot: canonicalState.snapshot
  };

  writeJson(reportPath, report);

  if (storedExpectedDifference) {
    throw new Error(`Stored expected snapshot drifted from the fixture definition: ${storedExpectedDifference}. See ${reportPath}`);
  }

  if (cutoverDifference) {
    throw new Error(`Canonical cutover fixture mismatch: ${cutoverDifference}. See ${reportPath}`);
  }

  console.log(`Accounting cutover fixture passed: ${fixtureName}`);
  console.log(`Canonical dataset loaded for user: ${userId}`);
  console.log(`Wrote cutover report: ${reportPath}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}