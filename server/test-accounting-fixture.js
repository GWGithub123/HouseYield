import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateDepreciation, calculateQuarterlyEstimate, generateScheduleE } from './tax-engine-firestore.js';
import { getTax1099ThresholdForTaxYear, getTaxRulesetPackage } from '../src/shared/taxRules.js';
import { loadAccountingFixtureDefinition, resolveAccountingFixturePaths } from './accounting-fixtures/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, 'accounting-fixtures');

function calculateLineBalanceChange(accountType, line) {
  if (['LIABILITY', 'EQUITY', 'REVENUE'].includes(accountType)) {
    return line.dc === 'C' ? line.amount : -line.amount;
  }

  return line.dc === 'D' ? line.amount : -line.amount;
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

function computeBalances(fixture) {
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

function buildTrialBalance(fixture, balances) {
  let totalDebits = 0;
  let totalCredits = 0;

  const accounts = Object.entries(fixture.accounts)
    .map(([code, account]) => {
      const balance = Math.round((balances.get(code) || 0) * 100) / 100;
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
        debits: Math.round(debits * 100) / 100,
        credits: Math.round(credits * 100) / 100
      };
    })
    .filter((account) => account.balance !== 0)
    .sort((left, right) => left.code.localeCompare(right.code));

  return {
    totalDebits: Math.round(totalDebits * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
    accounts
  };
}

function buildProfitLoss(fixture, balances) {
  const revenues = [];
  const expenses = [];
  let totalRevenue = 0;
  let totalExpenses = 0;

  Object.entries(fixture.accounts).forEach(([code, account]) => {
    const balance = Math.round((balances.get(code) || 0) * 100) / 100;

    if (account.type === 'REVENUE' && balance !== 0) {
      revenues.push({ code, name: account.name, amount: balance });
      totalRevenue += balance;
    }

    if (account.type === 'EXPENSE' && balance !== 0) {
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
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      netIncome: Math.round((totalRevenue - totalExpenses) * 100) / 100
    }
  };
}

function build1099Summary(fixture) {
  const threshold1099 = getTax1099ThresholdForTaxYear(fixture.taxYear);
  const paymentsByVendor = new Map();
  const vendorInfoByName = new Map((fixture.vendors || []).map((vendor) => [vendor.name, vendor]));

  fixture.entries
    .filter((entry) => entry.type === 'expense' && entry.vendor)
    .forEach((entry) => {
      paymentsByVendor.set(entry.vendor, (paymentsByVendor.get(entry.vendor) || 0) + Math.abs(Number(entry.amount) || 0));
    });

  const vendors = Array.from(paymentsByVendor.entries())
    .map(([name, totalPaid]) => {
      const vendor = vendorInfoByName.get(name) || {};
      const requires1099 = totalPaid >= threshold1099 && vendor.vendorType !== 'ccorp' && vendor.vendorType !== 'corporation';
      const hasTIN = !!(vendor.ein || vendor.ssnLast4);
      const hasAddress = !!vendor.address;
      const hasW9 = !!vendor.w9OnFile;

      return {
        name,
        totalPaid: Math.round(totalPaid * 100) / 100,
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

  const reportableVendors = vendors.filter((vendor) => vendor.requires1099);

  return {
    threshold1099,
    totalForms: reportableVendors.length,
    totalAmount: Math.round(reportableVendors.reduce((sum, vendor) => sum + vendor.totalPaid, 0) * 100) / 100,
    formsReady: reportableVendors.filter((vendor) => vendor.ready).length,
    formsWithMissingInfo: reportableVendors.filter((vendor) => vendor.missingInfo.length > 0).length,
    vendors
  };
}

function buildScheduleE(fixture) {
  const normalizedEntries = fixture.entries.map((entry) => ({
    date: entry.date,
    category: entry.category || '',
    amount: Number(entry.amount) || 0,
    description: entry.memo || '',
    vendor: entry.vendor || '',
    propertyId: entry.propertyId || null
  }));
  const scheduleE = generateScheduleE(normalizedEntries, fixture.taxYear, null, fixture.properties || []);

  return {
    summary: scheduleE.summary,
    entryCount: scheduleE.entryCount,
    lineAmounts: Object.entries(scheduleE.scheduleELines)
      .filter(([, line]) => line.amount !== 0)
      .reduce((accumulator, [key, line]) => {
        accumulator[key] = Math.round(line.amount * 100) / 100;
        return accumulator;
      }, {})
  };
}

function buildDepreciation(fixture) {
  const depreciation = calculateDepreciation(fixture.properties || [], fixture.taxYear);
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

function buildCashflowTrend(fixture) {
  const monthly = new Map();

  (fixture.entries || []).forEach((entry) => {
    if (!['income', 'expense'].includes(entry.type)) {
      return;
    }

    const monthKey = String(entry.date || '').slice(0, 7);
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

    const amount = Math.round((Number(entry.amount || 0) + Number.EPSILON) * 100) / 100;
    if (entry.type === 'income') {
      current.revenue += amount;
    }
    if (entry.type === 'expense') {
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
      revenue: Math.round(row.revenue * 100) / 100,
      income: Math.round(row.revenue * 100) / 100,
      expenses: Math.round(row.expenses * 100) / 100,
      net: Math.round((row.revenue - row.expenses) * 100) / 100,
      net_income: Math.round((row.revenue - row.expenses) * 100) / 100,
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

function buildEstimatedTaxes(fixture) {
  if (!fixture.taxProjection?.assumptions) {
    return null;
  }

  const asOfDate = fixture.taxProjection.asOfDate || `${fixture.taxYear}-12-31`;
  const projectionQuarter = Math.min(4, Math.max(1, Math.ceil((new Date(`${asOfDate}T12:00:00Z`).getUTCMonth() + 1) / 3)));
  const payments = (fixture.estimatedTaxPayments || []).map((payment) => ({
    taxYear: Number(payment.taxYear || fixture.taxYear),
    quarter: Number(payment.quarter),
    amount: Math.round((Number(payment.amount || 0) + Number.EPSILON) * 100) / 100,
    datePaid: payment.datePaid,
    paymentMethod: payment.paymentMethod || 'unknown',
  }));
  const normalizedEntries = (fixture.entries || []).map((entry) => ({
    date: entry.date,
    amount: Number(entry.amount) || 0,
    type: entry.type || '',
    category: entry.category || '',
    description: entry.memo || '',
    vendor: entry.vendor || '',
    propertyId: entry.propertyId || null,
  }));
  const depreciation = calculateDepreciation(fixture.properties || [], fixture.taxYear);
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
    );
    const paid = Math.round(payments
      .filter((payment) => payment.taxYear === fixture.taxYear && payment.quarter === quarter)
      .reduce((sum, payment) => sum + payment.amount, 0) * 100) / 100;
    const due = Math.round((estimate.estimatedTax.total + Number.EPSILON) * 100) / 100;

    return {
      quarter,
      estimatedDue: due,
      paid,
      remaining: Math.round(Math.max(0, due - paid) * 100) / 100,
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
    payments,
    quarters,
    summary: {
      totalEstimatedDue: Math.round(quarters.reduce((sum, quarter) => sum + quarter.estimatedDue, 0) * 100) / 100,
      totalPaid: Math.round(quarters.reduce((sum, quarter) => sum + quarter.paid, 0) * 100) / 100,
      totalRemaining: Math.round(quarters.reduce((sum, quarter) => sum + quarter.remaining, 0) * 100) / 100,
    },
  };
}

function buildExpectedOutputs(fixture) {
  const ruleset = getTaxRulesetPackage(fixture.taxYear);
  assertRulesVersionMatchesTaxYear(fixture.taxYear, ruleset.rulesVersion, 'Accounting fixture harness');
  const balances = computeBalances(fixture);
  const trialBalance = buildTrialBalance(fixture, balances);
  const profitLoss = buildProfitLoss(fixture, balances);
  const scheduleE = buildScheduleE(fixture);
  const depreciation = buildDepreciation(fixture);
  const vendors1099 = build1099Summary(fixture);
  const cashflowTrend = buildCashflowTrend(fixture);
  const estimatedTaxes = buildEstimatedTaxes(fixture);

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
    scheduleE,
    depreciation,
    vendors1099,
    cashflowTrend,
    estimatedTaxes,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureName = args.find((arg) => !arg.startsWith('--')) || 'baseline-rental-ledger';
  const shouldWriteExpected = args.includes('--write-expected');
  const { fixtureJsPath, fixtureJsonPath, expectedPath, actualPath } = resolveAccountingFixturePaths(fixtureName);
  const fixturePath = fs.existsSync(fixtureJsPath) ? fixtureJsPath : fixtureJsonPath;

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }

  const fixture = await loadAccountingFixtureDefinition(fixtureName);
  const actual = buildExpectedOutputs(fixture);

  if (shouldWriteExpected) {
    fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Wrote expected snapshot: ${expectedPath}`);
    return;
  }

  if (!fs.existsSync(expectedPath)) {
    throw new Error(`Expected snapshot not found: ${expectedPath}. Run with --write-expected first.`);
  }

  const expected = sortObject(JSON.parse(fs.readFileSync(expectedPath, 'utf8')));
  const difference = findFirstDifference(expected, actual);

  if (difference) {
    fs.writeFileSync(actualPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.error(`Accounting fixture mismatch: ${difference}`);
    console.error(`Wrote actual snapshot: ${actualPath}`);
    process.exit(1);
  }

  console.log(`Accounting fixture passed: ${fixtureName}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}