import { PDFDocument } from 'pdf-lib';
import { getTaxRulesetPackage } from '../src/shared/taxRules.js';
import { buildTaxWorkpaperSnapshot } from './accounting-core/workpaperSnapshotBuilder.js';
import { loadAccountingFixtureDefinition, loadAccountingFixtureExpected } from './accounting-fixtures/index.js';
import { buildEstimatedTaxQuarterData } from './tax-export-context.js';
import {
  TXF_CODES,
  buildScheduleEExportModel,
  generateDetailedCSV,
  generateScheduleEPDF,
  generateScheduleESummaryCSV,
  generateTXF,
  generate1040ESVouchers,
  generate1099NecFormsPDF,
} from './tax-export.js';
import { calculateTaxLiability } from './tax-engine.js';

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
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

function assertMatches(expected, actual, label) {
  const difference = findFirstDifference(sortObject(expected), sortObject(actual), label);
  if (difference) {
    throw new Error(`Tax export fixture mismatch: ${difference}`);
  }
}

function normalizeEntries(fixture) {
  return (fixture.entries || []).map((entry) => ({
    date: entry.date,
    amount: Number(entry.amount || 0),
    type: entry.type || '',
    category: entry.category || '',
    description: entry.memo || entry.description || '',
    vendor: entry.vendor || '',
    propertyId: entry.propertyId || null,
    scheduleELine: entry.scheduleELine || null,
  }));
}

function buildSnapshotLineAmounts(scheduleE) {
  return Object.entries(scheduleE.scheduleELines || {})
    .filter(([, line]) => Number(line.amount || 0) !== 0)
    .reduce((accumulator, [key, line]) => {
      accumulator[key] = roundCurrency(line.amount);
      return accumulator;
    }, {});
}

function parseTxfRecords(content) {
  const lines = String(content || '').split(/\r?\n/);
  const records = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== 'TD') {
      continue;
    }

    const code = lines[index + 1] || '';
    const amountLine = lines.slice(index + 1, index + 6).find((line) => line.startsWith('$'));
    if (!code || !amountLine) {
      continue;
    }

    records.push({
      code,
      amount: roundCurrency(Number(amountLine.slice(1))),
    });
  }

  return records.sort((left, right) => left.code.localeCompare(right.code) || left.amount - right.amount);
}

function buildExpectedTxfRecords(expected) {
  const records = Object.entries(expected.scheduleE?.lineAmounts || {})
    .filter(([key, amount]) => Number(amount || 0) !== 0 && TXF_CODES[key])
    .map(([key, amount]) => ({
      code: TXF_CODES[key].code,
      amount: roundCurrency(amount),
    }));

  if (!records.some((record) => record.code === TXF_CODES.DEPRECIATION.code) && Number(expected.depreciation?.summary?.totalCurrentYearDepreciation || 0) > 0) {
    records.push({
      code: TXF_CODES.DEPRECIATION.code,
      amount: roundCurrency(expected.depreciation.summary.totalCurrentYearDepreciation),
    });
  }

  return records.sort((left, right) => left.code.localeCompare(right.code) || left.amount - right.amount);
}

function buildNormalizedPayments(fixture) {
  return (fixture.estimatedTaxPayments || []).map((payment) => ({
    quarter: Number(payment.quarter),
    amount: roundCurrency(payment.amount),
    datePaid: payment.datePaid,
    taxYear: Number(payment.taxYear || fixture.taxYear),
  }));
}

function buildQuarterExpectation(expected) {
  return (expected.estimatedTaxes?.quarters || []).map((quarter) => ({
    quarter: Number(quarter.quarter),
    estimatedDue: roundCurrency(quarter.estimatedDue),
    paid: roundCurrency(quarter.paid),
    remaining: roundCurrency(quarter.remaining),
    dueDate: quarter.dueDate,
    status: quarter.status,
    breakdown: {
      income: roundCurrency(quarter.breakdown.income),
      expenses: roundCurrency(quarter.breakdown.expenses),
      netIncome: roundCurrency(quarter.breakdown.netIncome),
      federal: roundCurrency(quarter.breakdown.federal),
      state: roundCurrency(quarter.breakdown.state),
      annualizedIncome: roundCurrency(quarter.breakdown.annualizedIncome),
    },
  }));
}

function buildConfirmedW2Totals(fixture) {
  return (fixture.personalTaxDocuments || [])
    .filter((document) => document.documentSubtype === 'w2' && document.reviewerStatus === 'confirmed')
    .reduce((totals, document) => {
      totals.wages = roundCurrency(totals.wages + Math.max(0, Number(document.wages || 0)));
      totals.federalWithholding = roundCurrency(totals.federalWithholding + Math.max(0, Number(document.federalWithholding || 0)));
      totals.stateWithholding = roundCurrency(
        totals.stateWithholding + (document.stateEntries || []).reduce(
          (sum, entry) => sum + Math.max(0, Number(entry.withholding || 0)),
          0,
        ),
      );
      return totals;
    }, { wages: 0, federalWithholding: 0, stateWithholding: 0 });
}

function assertPracticeTaxpayerInputs(fixture) {
  if (!fixture.personalTaxProfile || !Array.isArray(fixture.personalTaxDocuments)) {
    return;
  }

  const w2Totals = buildConfirmedW2Totals(fixture);
  const assumptions = fixture.taxProjection?.assumptions || {};

  if (roundCurrency(assumptions.otherIncome) !== w2Totals.wages) {
    throw new Error(`Tax export fixture mismatch: simulated W-2 wages ${w2Totals.wages} do not match 1040-ES otherIncome assumption ${assumptions.otherIncome}`);
  }

  if (roundCurrency(assumptions.withholdingYtd) !== w2Totals.federalWithholding) {
    throw new Error(`Tax export fixture mismatch: simulated W-2 federal withholding ${w2Totals.federalWithholding} does not match 1040-ES withholding assumption ${assumptions.withholdingYtd}`);
  }
}

function assertTaxFormTruth(fixture, snapshot, quarterData) {
  const truth = fixture.taxFormTruth;
  if (!truth) {
    return;
  }

  const exportScheduleE = buildScheduleEExportModel(snapshot.scheduleE, snapshot.depreciation);
  assertMatches({
    line3RentsReceived: truth.scheduleE.line3RentsReceived,
    line4RoyaltiesReceived: truth.scheduleE.line4RoyaltiesReceived,
    line18Depreciation: truth.scheduleE.line18Depreciation,
    line20TotalExpenses: truth.scheduleE.line20TotalExpenses,
    line21IncomeOrLoss: truth.scheduleE.line21IncomeOrLoss,
    line23aTotalRents: truth.scheduleE.line23aTotalRents,
    line23bTotalRoyalties: truth.scheduleE.line23bTotalRoyalties,
    line23cTotalMortgageInterest: truth.scheduleE.line23cTotalMortgageInterest,
    line23dTotalDepreciation: truth.scheduleE.line23dTotalDepreciation,
    line23eTotalExpenses: truth.scheduleE.line23eTotalExpenses,
    line26TotalIncomeOrLoss: truth.scheduleE.line26TotalIncomeOrLoss,
  }, {
    line3RentsReceived: roundCurrency(exportScheduleE.scheduleELines.RENTS_RECEIVED?.amount),
    line4RoyaltiesReceived: roundCurrency(exportScheduleE.scheduleELines.OTHER_INCOME?.amount),
    line18Depreciation: roundCurrency(exportScheduleE.scheduleELines.DEPRECIATION?.amount),
    line20TotalExpenses: roundCurrency(exportScheduleE.summary.totalExpenses),
    line21IncomeOrLoss: roundCurrency(exportScheduleE.summary.netIncomeOrLoss),
    line23aTotalRents: roundCurrency(exportScheduleE.scheduleELines.RENTS_RECEIVED?.amount),
    line23bTotalRoyalties: roundCurrency(exportScheduleE.scheduleELines.OTHER_INCOME?.amount),
    line23cTotalMortgageInterest: roundCurrency(exportScheduleE.scheduleELines.MORTGAGE_INTEREST?.amount),
    line23dTotalDepreciation: roundCurrency(exportScheduleE.scheduleELines.DEPRECIATION?.amount),
    line23eTotalExpenses: roundCurrency(exportScheduleE.summary.totalExpenses),
    line26TotalIncomeOrLoss: roundCurrency(exportScheduleE.summary.netIncomeOrLoss),
  }, 'taxFormTruth.scheduleE');

  const reportableVendors = snapshot.vendors1099.vendors
    .filter((vendor) => vendor.requires1099)
    .map((vendor) => {
      const fixtureVendor = (fixture.vendors || []).find((candidate) => candidate.name === vendor.name) || {};
      return {
        recipientName: vendor.name,
        recipientTIN: fixtureVendor.ein || (fixtureVendor.ssnLast4 ? `***-**-${fixtureVendor.ssnLast4}` : 'MISSING'),
        recipientAddress: fixtureVendor.address ? `${fixtureVendor.address}, ${fixtureVendor.city || ''} ${fixtureVendor.state || ''} ${fixtureVendor.zip || ''}`.replace(/\s{2,}/g, ' ').trim() : 'MISSING',
        box1NonemployeeCompensation: roundCurrency(vendor.totalPaid),
        readiness: vendor.ready ? 'ready' : 'action_required',
      };
    });
  assertMatches(truth.forms1099Nec, reportableVendors, 'taxFormTruth.forms1099Nec');

  assertMatches(truth.form1040ES.quarters, quarterData.map((quarter) => ({
    quarter: Number(quarter.quarter),
    dueDate: quarter.dueDate,
    estimatedDue: roundCurrency(quarter.estimatedDue),
    paid: roundCurrency(quarter.paid),
    remaining: roundCurrency(quarter.remaining),
  })), 'taxFormTruth.form1040ES.quarters');
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureName = args.find((arg) => !arg.startsWith('--')) || 'prestwick-rental-2025';
  const fixture = await loadAccountingFixtureDefinition(fixtureName);
  const expected = loadAccountingFixtureExpected(fixtureName);

  if (!expected) {
    throw new Error(`Expected snapshot not found for ${fixtureName}`);
  }

  const ruleset = getTaxRulesetPackage(fixture.taxYear);
  const entries = normalizeEntries(fixture);
  const properties = fixture.properties || [];
  const vendors = fixture.vendors || [];
  const snapshot = buildTaxWorkpaperSnapshot({
    taxYear: fixture.taxYear,
    entries,
    properties,
    vendors,
    ruleset,
  });

  if (snapshot.sourceLedger !== 'azure-sql-canonical-ledger') {
    throw new Error(`Tax export fixture mismatch: expected canonical source ledger, received ${snapshot.sourceLedger}`);
  }

  assertMatches(expected.scheduleE.summary, snapshot.scheduleE.summary, 'scheduleE.summary');
  assertMatches(expected.scheduleE.lineAmounts, buildSnapshotLineAmounts(snapshot.scheduleE), 'scheduleE.lineAmounts');
  if (snapshot.scheduleE.lineAmounts?.OTHER_INCOME || snapshot.scheduleE.scheduleELines?.OTHER_INCOME?.amount) {
    throw new Error('Tax export fixture mismatch: late fees and other tenant charges should not populate Schedule E line 4 royalties');
  }
  if (roundCurrency(snapshot.scheduleE.scheduleELines?.RENTS_RECEIVED?.amount) !== 62200) {
    throw new Error('Tax export fixture mismatch: Schedule E line 3 should include rent plus the sample late fee');
  }
  assertMatches(expected.depreciation.summary, snapshot.depreciation.summary, 'depreciation.summary');
  assertMatches({
    threshold1099: expected.vendors1099.threshold1099,
    totalForms: expected.vendors1099.totalForms,
    totalAmount: expected.vendors1099.totalAmount,
    formsReady: expected.vendors1099.formsReady,
    formsWithMissingInfo: expected.vendors1099.formsWithMissingInfo,
  }, {
    threshold1099: snapshot.vendors1099.threshold1099,
    totalForms: snapshot.vendors1099.totalForms,
    totalAmount: snapshot.vendors1099.totalAmount,
    formsReady: snapshot.vendors1099.formsReady,
    formsWithMissingInfo: snapshot.vendors1099.formsWithMissingInfo,
  }, 'vendors1099.summary');
  const reportable1099Vendors = snapshot.vendors1099.vendors.filter((vendor) => vendor.requires1099);
  assertMatches([
    { name: 'Potomac Home Services', totalPaid: 2585, ready: true, missingInfo: [] },
    { name: 'Potomac Green Landscaping LLC', totalPaid: 760, ready: true, missingInfo: [] },
  ], reportable1099Vendors.map((vendor) => ({
    name: vendor.name,
    totalPaid: vendor.totalPaid,
    ready: vendor.ready,
    missingInfo: vendor.missingInfo,
  })), 'vendors1099.reportableVendors');
  assertPracticeTaxpayerInputs(fixture);

  const txfContent = generateTXF(snapshot.scheduleE, snapshot.depreciation);
  if (!txfContent.startsWith('V042')) {
    throw new Error('Tax export fixture mismatch: TXF output missing V042 header');
  }
  assertMatches(buildExpectedTxfRecords(expected), parseTxfRecords(txfContent), 'txf.records');

  const summaryCsv = generateScheduleESummaryCSV(snapshot.scheduleE);
  if (!summaryCsv.includes(`Total Income,,$${Number(expected.scheduleE.summary.totalIncome).toFixed(2)}`)) {
    throw new Error('Tax export fixture mismatch: summary CSV total income does not match canonical Schedule E');
  }
  if (!summaryCsv.includes(`Total Expenses,,$${Number(expected.scheduleE.summary.totalExpenses).toFixed(2)}`)) {
    throw new Error('Tax export fixture mismatch: summary CSV total expenses does not match canonical Schedule E');
  }
  if (!summaryCsv.includes(`Net Income/Loss,,$${Number(expected.scheduleE.summary.netIncomeOrLoss).toFixed(2)}`)) {
    throw new Error('Tax export fixture mismatch: summary CSV net income/loss does not match canonical Schedule E');
  }

  const detailedCsv = generateDetailedCSV(entries, fixture.taxYear);
  const detailedRows = detailedCsv.trim().split('\n');
  const expectedDetailedRowCount = entries.filter((entry) => String(entry.date || '').startsWith(String(fixture.taxYear))).length + 1;
  if (detailedRows.length !== expectedDetailedRowCount) {
    throw new Error(`Tax export fixture mismatch: expected detailed CSV row count ${expectedDetailedRowCount}, received ${detailedRows.length}`);
  }

  const qualifiedPropertyBasis = (snapshot.depreciation?.assets || [])
    .reduce((sum, asset) => sum + Math.max(0, Number(asset.depreciableBasis || 0)), 0);

  const quarterData = buildEstimatedTaxQuarterData({
    entries,
    payments: buildNormalizedPayments(fixture),
    taxYear: fixture.taxYear,
    taxParams: {
      ...(fixture.taxProjection?.assumptions || {}),
      annualDepreciation: snapshot.depreciation?.summary?.totalCurrentYearDepreciation || 0,
      qualifiedPropertyBasis,
      rentalStates: (fixture.properties || []).map((property) => String(property.state || property.attomState || '').trim().toUpperCase()).filter(Boolean),
      properties: fixture.properties || [],
    },
    ruleset,
    asOfDate: expected.estimatedTaxes?.asOfDate || fixture.taxProjection?.asOfDate || `${fixture.taxYear}-12-31`,
  });

  if (expected.estimatedTaxes) {
    assertMatches(
      buildQuarterExpectation(expected),
      quarterData.map((quarter) => ({
        quarter: quarter.quarter,
        estimatedDue: roundCurrency(quarter.estimatedDue),
        paid: roundCurrency(quarter.paid),
        remaining: roundCurrency(quarter.remaining),
        dueDate: quarter.dueDate,
        status: quarter.status,
        breakdown: {
          income: roundCurrency(quarter.breakdown.income),
          expenses: roundCurrency(quarter.breakdown.expenses),
          netIncome: roundCurrency(quarter.breakdown.netIncome),
          federal: roundCurrency(quarter.breakdown.federal),
          state: roundCurrency(quarter.breakdown.state),
          annualizedIncome: roundCurrency(quarter.breakdown.annualizedIncome),
        },
      })),
      'estimatedTaxes.quarters',
    );
  }
  assertTaxFormTruth(fixture, snapshot, quarterData);

  const taxpayerInfo = {
    primaryName: 'Fixture Taxpayer',
    tinLast4: '1234',
    mailingStreet: '123 Ledger Lane',
    mailingCity: 'Baltimore',
    mailingState: String(fixture.taxProjection?.assumptions?.homeState || 'MD').toUpperCase(),
    mailingZip: '21201',
    filingStatus: fixture.taxProjection?.assumptions?.filingStatus || 'single',
    homeState: fixture.taxProjection?.assumptions?.homeState || null,
    propertyScope: snapshot.scheduleE.propertySummaries?.length === 1
      ? snapshot.scheduleE.propertySummaries[0].address || snapshot.scheduleE.propertySummaries[0].name || 'Rental property'
      : `${snapshot.scheduleE.propertySummaries?.length || 0} rental properties`,
  };
  const taxLiability = fixture.taxProjection?.assumptions
    ? calculateTaxLiability({
        taxYear: fixture.taxYear,
        ...fixture.taxProjection.assumptions,
      }, snapshot.scheduleE, snapshot.depreciation, ruleset)
    : null;

  const scheduleEPdfBytes = await generateScheduleEPDF(snapshot.scheduleE, snapshot.depreciation, taxpayerInfo, snapshot.vendors1099);
  const scheduleEPdf = await PDFDocument.load(scheduleEPdfBytes);
  if (scheduleEPdf.getPageCount() < 1) {
    throw new Error('Tax export fixture mismatch: Schedule E PDF has no pages');
  }

  const vouchersPdfBytes = await generate1040ESVouchers(quarterData, taxpayerInfo, fixture.taxYear);
  const vouchersPdf = await PDFDocument.load(vouchersPdfBytes);
  if (vouchersPdf.getPageCount() !== 3) {
    throw new Error(`Tax export fixture mismatch: expected official 1040-ES PDF with 3 pages, received ${vouchersPdf.getPageCount()}`);
  }

  const forms1099 = (fixture.taxFormTruth?.forms1099Nec || []).map((form) => ({
    recipientName: form.recipientName,
    recipientTIN: form.recipientTIN,
    recipientAddress: form.recipientAddress,
    amount: roundCurrency(form.box1NonemployeeCompensation),
    formType: '1099-NEC',
    box: 1,
  }));
  if (forms1099.length > 0) {
    const payerInfo = {
      primaryName: taxpayerInfo.primaryName,
      tinLast4: fixture.personalTaxProfile?.tinLast4 || taxpayerInfo.tinLast4,
      mailingStreet: taxpayerInfo.mailingStreet,
      mailingCity: taxpayerInfo.mailingCity,
      mailingState: taxpayerInfo.mailingState,
      mailingZip: taxpayerInfo.mailingZip,
    };
    const forms1099PdfBytes = await generate1099NecFormsPDF(forms1099, payerInfo, fixture.taxYear);
    const forms1099Pdf = await PDFDocument.load(forms1099PdfBytes);
    const expected1099Pages = forms1099.length * 6;
    if (forms1099Pdf.getPageCount() !== expected1099Pages) {
      throw new Error(`Tax export fixture mismatch: expected official 1099-NEC PDF with ${expected1099Pages} pages, received ${forms1099Pdf.getPageCount()}`);
    }
  }

  console.log(`Tax export fixture passed: ${fixtureName}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}