/**
 * Tax Export Module
 * ================
 * TXF Export: TurboTax-compatible .txf file format for direct import
 * PDF Generation: Official IRS Schedule E, 1040-ES, and 1099-NEC template overlays using pdf-lib,
 * with legacy drawn fallbacks when a template fill fails.
 * CSV Export: Standard CSV for Excel/Google Sheets
 */

import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function cloneLine(line = {}) {
  return {
    ...line,
    entries: Array.isArray(line.entries) ? [...line.entries] : [],
  };
}

function normalizeIdentityValue(value) {
  return String(value || '').trim().toLowerCase();
}

function buildPropertyExpenseFingerprint(expenses = {}) {
  return Object.entries(expenses)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, amount]) => `${category}:${roundCurrency(amount)}`)
    .join('|');
}

function looksLikeOpaquePropertyIdentifier(value) {
  return /^[A-Za-z0-9_-]{12,}$/.test(String(value || '').trim());
}

function dedupeDepreciationAssets(assets = []) {
  const seen = new Set();
  const deduped = [];

  for (const asset of assets) {
    const key = [
      normalizeIdentityValue(asset.propertyId),
      normalizeIdentityValue(asset.propertyAddress),
      normalizeIdentityValue(asset.propertyName),
      asset.dateAcquired || '',
      roundCurrency(asset.cost),
      roundCurrency(asset.depreciableBasis),
      roundCurrency(asset.currentYearDepreciation),
      roundCurrency(asset.remainingBasis),
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(asset);
  }

  return deduped;
}

function dedupePropertySummaries(propertySummaries = []) {
  const fingerprints = propertySummaries.map((property) => ({
    property,
    financialFingerprint: [
      roundCurrency(property.income),
      roundCurrency(property.totalExpenses),
      buildPropertyExpenseFingerprint(property.expenses || {}),
      Number(property.fairRentalDays || 0),
      Number(property.personalUseDays || 0),
      normalizeIdentityValue(property.propertyType),
    ].join('|'),
  }));

  const seen = new Set();
  const deduped = [];

  for (const { property, financialFingerprint } of fingerprints) {
    const normalizedAddress = normalizeIdentityValue(property.address);
    const normalizedName = normalizeIdentityValue(property.name);
    const opaqueName = looksLikeOpaquePropertyIdentifier(property.name);
    const hasDescriptiveDuplicate = opaqueName && !normalizedAddress && fingerprints.some(({ property: candidate, financialFingerprint: candidateFingerprint }) => {
      if (candidate === property || candidateFingerprint !== financialFingerprint) {
        return false;
      }

      return Boolean(normalizeIdentityValue(candidate.address) || (normalizeIdentityValue(candidate.name) && !looksLikeOpaquePropertyIdentifier(candidate.name)));
    });

    if (hasDescriptiveDuplicate) {
      continue;
    }

    const dedupeKey = [
      normalizeIdentityValue(property.id),
      normalizedAddress,
      normalizedName,
      financialFingerprint,
    ].join('|');

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    deduped.push({
      ...property,
      expenses: { ...(property.expenses || {}) },
    });
  }

  return deduped;
}

function buildPropertyDepreciationLookup(assets = []) {
  const lookup = new Map();

  for (const asset of assets) {
    const amount = roundCurrency(asset.currentYearDepreciation);
    if (amount <= 0) {
      continue;
    }

    const keys = [
      ['id', asset.propertyId],
      ['address', asset.propertyAddress],
      ['name', asset.propertyName],
    ];

    for (const [kind, value] of keys) {
      const normalized = normalizeIdentityValue(value);
      if (!normalized) {
        continue;
      }

      const key = `${kind}:${normalized}`;
      lookup.set(key, roundCurrency((lookup.get(key) || 0) + amount));
    }
  }

  return lookup;
}

export function buildScheduleEExportModel(scheduleE, depreciation = null) {
  const scheduleELines = Object.fromEntries(
    Object.entries(scheduleE?.scheduleELines || {}).map(([key, line]) => [key, cloneLine(line)]),
  );
  const summary = { ...(scheduleE?.summary || {}) };
  const dedupedAssets = dedupeDepreciationAssets(depreciation?.assets || []);
  const syntheticDepreciation = roundCurrency(
    (scheduleELines.DEPRECIATION?.amount || 0) > 0
      ? 0
      : dedupedAssets.reduce((sum, asset) => sum + roundCurrency(asset.currentYearDepreciation), 0),
  );

  if (!scheduleELines.DEPRECIATION) {
    scheduleELines.DEPRECIATION = {
      line: 18,
      name: 'Depreciation',
      amount: 0,
      entries: [],
    };
  }

  if (syntheticDepreciation > 0) {
    scheduleELines.DEPRECIATION.amount = roundCurrency((scheduleELines.DEPRECIATION.amount || 0) + syntheticDepreciation);
    scheduleELines.DEPRECIATION.entries = [
      ...(scheduleELines.DEPRECIATION.entries || []),
      {
        entryId: null,
        date: null,
        description: 'Computed depreciation from Form 4562 schedule',
        amount: syntheticDepreciation,
        vendor: null,
        propertyId: null,
        source: 'computed_depreciation',
        sourceRef: null,
        financeEventType: 'depreciation_schedule',
      },
    ];
  }

  const totalIncome = roundCurrency(
    (scheduleELines.RENTS_RECEIVED?.amount || 0) + (scheduleELines.OTHER_INCOME?.amount || 0),
  );
  const totalExpenses = roundCurrency(
    Object.entries(scheduleELines)
      .filter(([key]) => !['RENTS_RECEIVED', 'OTHER_INCOME'].includes(key))
      .reduce((sum, [, line]) => sum + roundCurrency(line.amount), 0),
  );

  summary.totalIncome = totalIncome;
  summary.totalExpenses = totalExpenses;
  summary.line20Total = totalExpenses;
  summary.netIncomeOrLoss = roundCurrency(totalIncome - totalExpenses);
  summary.line21Income = summary.netIncomeOrLoss;

  const propertyDepreciationLookup = buildPropertyDepreciationLookup(dedupedAssets);
  const propertySummaries = dedupePropertySummaries(scheduleE?.propertySummaries || []).map((property) => {
    const propertyDepreciation = syntheticDepreciation > 0
      ? roundCurrency(
          propertyDepreciationLookup.get(`id:${normalizeIdentityValue(property.id)}`)
          || propertyDepreciationLookup.get(`address:${normalizeIdentityValue(property.address)}`)
          || propertyDepreciationLookup.get(`name:${normalizeIdentityValue(property.name)}`)
          || 0,
        )
      : 0;

    const expenses = { ...(property.expenses || {}) };
    if (propertyDepreciation > 0) {
      expenses.Depreciation = roundCurrency((expenses.Depreciation || 0) + propertyDepreciation);
    }

    const totalPropertyExpenses = roundCurrency(
      propertyDepreciation > 0
        ? roundCurrency(property.totalExpenses || 0) + propertyDepreciation
        : property.totalExpenses || 0,
    );

    return {
      ...property,
      expenses,
      totalExpenses: totalPropertyExpenses,
      netIncomeOrLoss: roundCurrency(roundCurrency(property.income || 0) - totalPropertyExpenses),
    };
  });

  return {
    ...(scheduleE || {}),
    scheduleELines,
    summary,
    propertySummaries,
    exportMetadata: {
      syntheticDepreciationIncluded: syntheticDepreciation > 0,
      syntheticDepreciationAmount: syntheticDepreciation,
      propertyCount: propertySummaries.length,
    },
  };
}

export const TXF_CODES = {
  RENTS_RECEIVED: { code: 'N521', desc: 'Rents Received (Line 3)' },
  ADVERTISING: { code: 'N523', desc: 'Advertising (Line 5)' },
  AUTO_TRAVEL: { code: 'N524', desc: 'Auto and Travel (Line 6)' },
  CLEANING_MAINTENANCE: { code: 'N525', desc: 'Cleaning and Maintenance (Line 7)' },
  COMMISSIONS: { code: 'N526', desc: 'Commissions (Line 8)' },
  INSURANCE: { code: 'N527', desc: 'Insurance (Line 9)' },
  LEGAL_PROFESSIONAL: { code: 'N528', desc: 'Legal and Professional (Line 10)' },
  MANAGEMENT_FEES: { code: 'N529', desc: 'Management Fees (Line 11)' },
  MORTGAGE_INTEREST: { code: 'N530', desc: 'Mortgage Interest (Line 12)' },
  OTHER_INTEREST: { code: 'N531', desc: 'Other Interest (Line 13)' },
  REPAIRS: { code: 'N532', desc: 'Repairs (Line 14)' },
  SUPPLIES: { code: 'N533', desc: 'Supplies (Line 15)' },
  TAXES: { code: 'N534', desc: 'Taxes (Line 16)' },
  UTILITIES: { code: 'N535', desc: 'Utilities (Line 17)' },
  DEPRECIATION: { code: 'N536', desc: 'Depreciation (Line 18)' },
  OTHER: { code: 'N537', desc: 'Other Expenses (Line 19)' },
  OTHER_INCOME: { code: 'N522', desc: 'Other Income (Line 4)' },
};

const SCHEDULE_E_TEMPLATE_URL = new URL('./assets/irs-forms/f1040se-2025.pdf', import.meta.url);
const IRS_FORMS_DIR_URL = new URL('./assets/irs-forms/', import.meta.url);

const FORM_1099_NEC_COPY_NAMES = ['CopyA', 'Copy1', 'Copy2', 'CopyB'];

function resolveIrsFormTemplateUrl(formKind, taxYear) {
  const normalizedYear = Number.isFinite(Number(taxYear)) ? Number(taxYear) : new Date().getFullYear();

  switch (String(formKind || '').toLowerCase()) {
    case '1040es':
      return new URL(`f1040es-${normalizedYear}.pdf`, IRS_FORMS_DIR_URL);
    case '1099nec':
      return new URL(`f1099nec-${normalizedYear}.pdf`, IRS_FORMS_DIR_URL);
    case '4562':
      return new URL(`f4562-${normalizedYear}.pdf`, IRS_FORMS_DIR_URL);
    case '1098':
      return new URL(`f1098-${normalizedYear}.pdf`, IRS_FORMS_DIR_URL);
    case 'schedulee':
      return new URL(`f1040se-${normalizedYear}.pdf`, IRS_FORMS_DIR_URL);
    default:
      throw new Error(`Unsupported IRS form template kind: ${formKind}`);
  }
}

const FORM_4562_HEADER_FIELDS = {
  name: 'topmostSubform[0].Page1[0].f1_1[0]',
  business: 'topmostSubform[0].Page1[0].f1_2[0]',
  identifyingNumber: 'topmostSubform[0].Page1[0].f1_3[0]',
};

const FORM_4562_MACRS_ROW_FIELDS = [
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_29[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_30[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_31[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_32[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_33[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19a[0].f1_34[0]',
  },
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_35[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_36[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_37[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_38[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_39[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19b[0].f1_40[0]',
  },
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_41[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_42[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_43[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_44[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_45[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19c[0].f1_46[0]',
  },
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_47[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_48[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_49[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_50[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_51[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19d[0].f1_52[0]',
  },
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_53[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_54[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_55[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_56[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_57[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19e[0].f1_58[0]',
  },
  {
    classification: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_59[0]',
    placedInService: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_60[0]',
    basis: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_61[0]',
    recoveryPeriod: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_62[0]',
    convention: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_63[0]',
    method: 'topmostSubform[0].Page1[0].SectionBTable[0].Line19f[0].f1_64[0]',
  },
];

const FORM_4562_TOTAL_FIELDS = {
  line21: 'topmostSubform[0].Page2[0].f2_57[0]',
  line22: 'topmostSubform[0].Page2[0].f2_58[0]',
};

const FORM_1098_COPY_NAMES = ['CopyA', 'CopyB'];

function formatIrsMonthYear(dateStr) {
  if (!dateStr) return '';
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${parsed.getFullYear()}`;
}

function formatIrsShortDate(dateStr) {
  if (!dateStr) return '';
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(parsed.getDate()).padStart(2, '0')}/${parsed.getFullYear()}`;
}

function buildForm1098CopyFieldNames(copyName = 'CopyB') {
  const fieldPrefix = copyName === 'CopyA' ? 'f1' : 'f2';
  const copyBase = `topmostSubform[0].${copyName}[0]`;
  const leftCol = `${copyBase}.LeftCol[0]`;
  const rightCol = `${copyBase}.RightCol[0]`;

  return {
    calendarYear: `${copyBase}.CopyHeader[0].CalendarYear[0].${fieldPrefix}_1[0]`,
    lenderName: `${leftCol}.${fieldPrefix}_2[0]`,
    lenderStreet: `${leftCol}.${fieldPrefix}_3[0]`,
    lenderCity: `${leftCol}.${fieldPrefix}_4[0]`,
    lenderState: `${leftCol}.${fieldPrefix}_5[0]`,
    lenderZip: `${leftCol}.${fieldPrefix}_6[0]`,
    borrowerTin: `${leftCol}.${fieldPrefix}_11[0]`,
    borrowerName: `${leftCol}.${fieldPrefix}_12[0]`,
    borrowerStreet: `${leftCol}.${fieldPrefix}_13[0]`,
    borrowerCity: `${leftCol}.${fieldPrefix}_14[0]`,
    borrowerState: `${leftCol}.${fieldPrefix}_15[0]`,
    box1MortgageInterest: `${rightCol}.${fieldPrefix}_20[0]`,
    box2OutstandingPrincipal: `${rightCol}.Box2_ReadOrder[0].${fieldPrefix}_21[0]`,
    box3OriginationDate: `${rightCol}.${fieldPrefix}_22[0]`,
  };
}

function resolve1098ReportableInterest(profile, mortgage1098 = {}) {
  const ledgerTotal = mortgage1098.ledgerInterest || 0;
  const attomTotal = mortgage1098.attomEstimatedTotal || 0;
  const profiles = mortgage1098.properties || [];

  if (profiles.length <= 1) {
    return ledgerTotal > 0 ? ledgerTotal : (profile.attomEstimatedInterest || profile.reportableInterest || 0);
  }

  if (ledgerTotal > 0 && attomTotal > 0 && profile.attomEstimatedInterest) {
    return roundCurrency(ledgerTotal * (profile.attomEstimatedInterest / attomTotal));
  }

  return profile.attomEstimatedInterest || profile.reportableInterest || 0;
}

function fillForm4562OfficialForm(form, depreciation = {}, taxpayerInfo = {}) {
  const assets = dedupeDepreciationAssets(depreciation?.assets || []);
  const taxpayerName = buildDraftTaxpayerName(taxpayerInfo);
  const tinLabel = buildDraftTinLabel(taxpayerInfo);
  const totalDepreciation = roundCurrency(depreciation?.summary?.totalCurrentYearDepreciation || 0);

  setTextFieldValue(form, FORM_4562_HEADER_FIELDS.name, taxpayerName);
  setTextFieldValue(form, FORM_4562_HEADER_FIELDS.business, truncateAscii(taxpayerInfo.propertyScope || 'Rental real estate', 64));
  setTextFieldValue(form, FORM_4562_HEADER_FIELDS.identifyingNumber, tinLabel);

  assets.slice(0, FORM_4562_MACRS_ROW_FIELDS.length).forEach((asset, index) => {
    const fields = FORM_4562_MACRS_ROW_FIELDS[index];
    const description = truncateAscii(
      asset.propertyAddress || asset.propertyName || asset.description || 'Residential rental property',
      40,
    );
    setTextFieldValue(form, fields.classification, description);
    setTextFieldValue(form, fields.placedInService, formatIrsMonthYear(asset.dateAcquired));
    setTextFieldValue(form, fields.basis, formatIrsWholeDollars(asset.depreciableBasis, { blankZero: false }));
    setTextFieldValue(form, fields.recoveryPeriod, String(asset.usefulLifeYears || 27.5));
    setTextFieldValue(form, fields.convention, truncateAscii(asset.convention || 'MM', 8));
    setTextFieldValue(form, fields.method, truncateAscii(asset.method || 'S/L', 8));
  });

  setTextFieldValue(form, FORM_4562_TOTAL_FIELDS.line21, formatIrsWholeDollars(totalDepreciation, { blankZero: false }));
  setTextFieldValue(form, FORM_4562_TOTAL_FIELDS.line22, formatIrsWholeDollars(totalDepreciation, { blankZero: false }));
}

function fillForm1098Copy(form, copyName, { lender, borrower, taxYear, mortgageInterest, outstandingPrincipal, originationDate }) {
  const fields = buildForm1098CopyFieldNames(copyName);
  setTextFieldValue(form, fields.calendarYear, String(taxYear));
  setTextFieldValue(form, fields.lenderName, truncateAscii(lender.name, 64));
  setTextFieldValue(form, fields.lenderStreet, truncateAscii(lender.street, 64));
  setTextFieldValue(form, fields.lenderCity, truncateAscii(lender.city, 40));
  setTextFieldValue(form, fields.lenderState, lender.state);
  setTextFieldValue(form, fields.lenderZip, lender.zip);
  setTextFieldValue(form, fields.borrowerTin, truncateAscii(borrower.tin, 11));
  setTextFieldValue(form, fields.borrowerName, truncateAscii(borrower.name, 64));
  setTextFieldValue(form, fields.borrowerStreet, truncateAscii(borrower.street, 64));
  setTextFieldValue(form, fields.borrowerCity, truncateAscii(borrower.city, 40));
  setTextFieldValue(form, fields.borrowerState, truncateAscii(borrower.stateZip, 40));
  setTextFieldValue(form, fields.box1MortgageInterest, formatIrsPaymentAmount(mortgageInterest));
  setTextFieldValue(form, fields.box2OutstandingPrincipal, formatIrsPaymentAmount(outstandingPrincipal));
  setTextFieldValue(form, fields.box3OriginationDate, formatIrsShortDate(originationDate));
}

function fillForm1098OfficialForm(form, profile, taxpayerInfo = {}, taxYear, mortgage1098 = {}) {
  const normalizedYear = Number.isFinite(Number(taxYear)) ? Number(taxYear) : new Date().getFullYear();
  const payload = {
    lender: {
      name: profile.lender || 'Mortgage lender (ATTOM)',
      street: '',
      city: '',
      state: '',
      zip: '',
    },
    borrower: {
      name: buildDraftTaxpayerName(taxpayerInfo),
      tin: buildDraftTinLabel(taxpayerInfo),
      street: taxpayerInfo.mailingStreet || taxpayerInfo.address || '',
      city: taxpayerInfo.mailingCity || '',
      stateZip: buildDraftCityStateZip(taxpayerInfo),
    },
    taxYear: normalizedYear,
    mortgageInterest: resolve1098ReportableInterest(profile, mortgage1098),
    outstandingPrincipal: profile.outstandingPrincipal || profile.loanAmount || 0,
    originationDate: profile.originationDate || null,
  };

  for (const copyName of FORM_1098_COPY_NAMES) {
    fillForm1098Copy(form, copyName, payload);
  }
}

async function copyPdfPagesIntoDocument(targetDoc, sourceBytes) {
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const pageIndexes = Array.from({ length: sourceDoc.getPageCount() }, (_, index) => index);
  const copiedPages = await targetDoc.copyPages(sourceDoc, pageIndexes);
  copiedPages.forEach((page) => targetDoc.addPage(page));
}

export async function generateOfficialForm4562PDF(depreciation = null, taxpayerInfo = {}, taxYear) {
  const templateUrl = resolveIrsFormTemplateUrl('4562', taxYear);
  const doc = await loadPdfTemplate(templateUrl);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  fillForm4562OfficialForm(form, depreciation, taxpayerInfo);
  form.updateFieldAppearances(font);
  form.flatten();
  return await doc.save();
}

export async function generateOfficialForm1098PDF(mortgage1098 = {}, taxpayerInfo = {}, taxYear) {
  const profiles = (mortgage1098?.properties || []).filter((profile) => (
    profile.hasAttomData || profile.lender || profile.attomEstimatedInterest || profile.reportableInterest
  ));

  if (profiles.length === 0) {
    throw new Error('No ATTOM mortgage profiles are available for Form 1098 export.');
  }

  const output = await PDFDocument.create();
  const templateUrl = resolveIrsFormTemplateUrl('1098', taxYear);

  for (const profile of profiles) {
    const doc = await loadPdfTemplate(templateUrl);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();
    fillForm1098OfficialForm(form, profile, taxpayerInfo, taxYear, mortgage1098);
    form.updateFieldAppearances(font);
    form.flatten();
    await copyPdfPagesIntoDocument(output, await doc.save());
  }

  return await output.save();
}

async function appendOfficialTaxFormAttachments(targetDoc, {
  depreciation = null,
  taxpayerInfo = {},
  taxYear,
  mortgage1098 = null,
} = {}) {
  const assets = dedupeDepreciationAssets(depreciation?.assets || []);
  if (assets.length > 0) {
    const form4562Bytes = await generateOfficialForm4562PDF(depreciation, taxpayerInfo, taxYear);
    await copyPdfPagesIntoDocument(targetDoc, form4562Bytes);
  }

  const mortgageProfiles = (mortgage1098?.properties || []).filter((profile) => (
    profile.hasAttomData || profile.lender || profile.attomEstimatedInterest
  ));
  if (mortgageProfiles.length > 0) {
    const form1098Bytes = await generateOfficialForm1098PDF(mortgage1098, taxpayerInfo, taxYear);
    await copyPdfPagesIntoDocument(targetDoc, form1098Bytes);
  }
}

const SCHEDULE_E_PROPERTY_FIELD_NAMES = [
  {
    address: 'topmostSubform[0].Page1[0].Table_Line1a[0].RowA[0].f1_3[0]',
    propertyType: 'topmostSubform[0].Page1[0].Table_Line1b[0].RowA[0].f1_6[0]',
    fairRentalDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowA[0].f1_9[0]',
    personalUseDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowA[0].f1_10[0]',
    qjv: 'topmostSubform[0].Page1[0].Table_Line2[0].RowA[0].c1_3[0]',
    lines: {
      3: 'topmostSubform[0].Page1[0].Table_Income[0].Line3[0].f1_16[0]',
      4: 'topmostSubform[0].Page1[0].Table_Income[0].Line4[0].f1_19[0]',
      5: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line5[0].f1_22[0]',
      6: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line6[0].f1_25[0]',
      7: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line7[0].f1_28[0]',
      8: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line8[0].f1_31[0]',
      9: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line9[0].f1_34[0]',
      10: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line10[0].f1_37[0]',
      11: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line11[0].f1_40[0]',
      12: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line12[0].f1_43[0]',
      13: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line13[0].f1_46[0]',
      14: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line14[0].f1_49[0]',
      15: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line15[0].f1_52[0]',
      16: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line16[0].f1_55[0]',
      17: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line17[0].f1_58[0]',
      18: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line18[0].f1_61[0]',
      19: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line19[0].f1_65[0]',
      20: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line20[0].f1_68[0]',
      21: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line21[0].f1_71[0]',
      22: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line22[0].f1_74[0]',
    },
  },
  {
    address: 'topmostSubform[0].Page1[0].Table_Line1a[0].RowB[0].f1_4[0]',
    propertyType: 'topmostSubform[0].Page1[0].Table_Line1b[0].RowB[0].f1_7[0]',
    fairRentalDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowB[0].f1_11[0]',
    personalUseDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowB[0].f1_12[0]',
    qjv: 'topmostSubform[0].Page1[0].Table_Line2[0].RowB[0].c1_4[0]',
    lines: {
      3: 'topmostSubform[0].Page1[0].Table_Income[0].Line3[0].f1_17[0]',
      4: 'topmostSubform[0].Page1[0].Table_Income[0].Line4[0].f1_20[0]',
      5: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line5[0].f1_23[0]',
      6: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line6[0].f1_26[0]',
      7: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line7[0].f1_29[0]',
      8: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line8[0].f1_32[0]',
      9: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line9[0].f1_35[0]',
      10: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line10[0].f1_38[0]',
      11: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line11[0].f1_41[0]',
      12: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line12[0].f1_44[0]',
      13: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line13[0].f1_47[0]',
      14: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line14[0].f1_50[0]',
      15: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line15[0].f1_53[0]',
      16: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line16[0].f1_56[0]',
      17: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line17[0].f1_59[0]',
      18: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line18[0].f1_62[0]',
      19: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line19[0].f1_66[0]',
      20: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line20[0].f1_69[0]',
      21: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line21[0].f1_72[0]',
      22: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line22[0].f1_75[0]',
    },
  },
  {
    address: 'topmostSubform[0].Page1[0].Table_Line1a[0].RowC[0].f1_5[0]',
    propertyType: 'topmostSubform[0].Page1[0].Table_Line1b[0].RowC[0].f1_8[0]',
    fairRentalDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowC[0].f1_13[0]',
    personalUseDays: 'topmostSubform[0].Page1[0].Table_Line2[0].RowC[0].f1_14[0]',
    qjv: 'topmostSubform[0].Page1[0].Table_Line2[0].RowC[0].c1_5[0]',
    lines: {
      3: 'topmostSubform[0].Page1[0].Table_Income[0].Line3[0].f1_18[0]',
      4: 'topmostSubform[0].Page1[0].Table_Income[0].Line4[0].f1_21[0]',
      5: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line5[0].f1_24[0]',
      6: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line6[0].f1_27[0]',
      7: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line7[0].f1_30[0]',
      8: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line8[0].f1_33[0]',
      9: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line9[0].f1_36[0]',
      10: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line10[0].f1_39[0]',
      11: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line11[0].f1_42[0]',
      12: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line12[0].f1_45[0]',
      13: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line13[0].f1_48[0]',
      14: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line14[0].f1_51[0]',
      15: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line15[0].f1_54[0]',
      16: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line16[0].f1_57[0]',
      17: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line17[0].f1_60[0]',
      18: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line18[0].f1_63[0]',
      19: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line19[0].f1_67[0]',
      20: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line20[0].f1_70[0]',
      21: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line21[0].f1_73[0]',
      22: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line22[0].f1_76[0]',
    },
  },
];

const SCHEDULE_E_TOTAL_FIELD_NAMES = {
  name: 'topmostSubform[0].Page1[0].f1_1[0]',
  ssn: 'topmostSubform[0].Page1[0].f1_2[0]',
  otherDescription: 'topmostSubform[0].Page1[0].Table_Expenses[0].Line19[0].f1_64[0]',
  otherPropertyDescription: 'topmostSubform[0].Page1[0].f1_15[0]',
  line23a: 'topmostSubform[0].Page1[0].f1_77[0]',
  line23b: 'topmostSubform[0].Page1[0].f1_78[0]',
  line23c: 'topmostSubform[0].Page1[0].f1_79[0]',
  line23d: 'topmostSubform[0].Page1[0].f1_80[0]',
  line23e: 'topmostSubform[0].Page1[0].f1_81[0]',
  line24: 'topmostSubform[0].Page1[0].f1_82[0]',
  line25: 'topmostSubform[0].Page1[0].f1_83[0]',
  line26: 'topmostSubform[0].Page1[0].f1_84[0]',
};

const SCHEDULE_E_PAGE2_FIELD_NAMES = {
  name: 'topmostSubform[0].Page2[0].f2_1[0]',
  ssn: 'topmostSubform[0].Page2[0].f2_2[0]',
  line40: 'topmostSubform[0].Page2[0].f2_77[0]',
  line41: 'topmostSubform[0].Page2[0].f2_78[0]',
  line42: 'topmostSubform[0].Page2[0].Line42_ReadOrder[0].f2_79[0]',
  line43: 'topmostSubform[0].Page2[0].f2_80[0]',
};

const FORM_1040_ES_RECORD_FIELD_NAMES = [
  {
    dueDate: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].Date1[0]',
    amountDue: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_1[0]',
    datePaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_2[0]',
    confirmation: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_3[0]',
    amountPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_4[0]',
    overpaymentCredit: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_5[0]',
    totalPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line1[0].f13_6[0]',
  },
  {
    dueDate: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].Date2[0]',
    amountDue: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_7[0]',
    datePaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_8[0]',
    confirmation: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_9[0]',
    amountPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_10[0]',
    overpaymentCredit: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_11[0]',
    totalPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line2[0].f13_12[0]',
  },
  {
    dueDate: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].Date3[0]',
    amountDue: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_13[0]',
    datePaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_14[0]',
    confirmation: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_15[0]',
    amountPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_16[0]',
    overpaymentCredit: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_17[0]',
    totalPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line3[0].f13_18[0]',
  },
  {
    dueDate: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].Date4[0]',
    amountDue: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_19[0]',
    datePaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_20[0]',
    confirmation: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_21[0]',
    amountPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_22[0]',
    overpaymentCredit: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_23[0]',
    totalPaid: 'topmostSubform[0].Page13[0].Pg13Table[0].Line4[0].f13_24[0]',
  },
];

const FORM_1040_ES_RECORD_TOTAL_FIELDS = {
  amountPaid: 'topmostSubform[0].Page13[0].Total[0].f13_25[0]',
  overpaymentCredit: 'topmostSubform[0].Page13[0].Total[0].f13_26[0]',
  totalPaid: 'topmostSubform[0].Page13[0].Total[0].f13_27[0]',
};

const FORM_1040_ES_VOUCHER_FIELD_NAMES = {
  1: {
    amount: 'topmostSubform[0].Page15[0].f15_29[0]',
    firstAndMiddle: 'topmostSubform[0].Page15[0].f15_30[0]',
    lastName: 'topmostSubform[0].Page15[0].f15_31[0]',
    ssn: 'topmostSubform[0].Page15[0].f15_32[0]',
    spouseFirstAndMiddle: 'topmostSubform[0].Page15[0].f15_33[0]',
    spouseLastName: 'topmostSubform[0].Page15[0].f15_34[0]',
    spouseSsn: 'topmostSubform[0].Page15[0].f15_35[0]',
    address: 'topmostSubform[0].Page15[0].f15_36[0]',
    city: 'topmostSubform[0].Page15[0].f15_37[0]',
    state: 'topmostSubform[0].Page15[0].f15_38[0]',
    zip: 'topmostSubform[0].Page15[0].f15_39[0]',
    foreignCountry: 'topmostSubform[0].Page15[0].f15_40[0]',
    foreignProvince: 'topmostSubform[0].Page15[0].f15_41[0]',
    foreignPostal: 'topmostSubform[0].Page15[0].f15_42[0]',
  },
  2: {
    amount: 'topmostSubform[0].Page15[0].f15_15[0]',
    firstAndMiddle: 'topmostSubform[0].Page15[0].f15_16[0]',
    lastName: 'topmostSubform[0].Page15[0].f15_17[0]',
    ssn: 'topmostSubform[0].Page15[0].f15_18[0]',
    spouseFirstAndMiddle: 'topmostSubform[0].Page15[0].f15_19[0]',
    spouseLastName: 'topmostSubform[0].Page15[0].f15_20[0]',
    spouseSsn: 'topmostSubform[0].Page15[0].f15_21[0]',
    address: 'topmostSubform[0].Page15[0].f15_22[0]',
    city: 'topmostSubform[0].Page15[0].f15_23[0]',
    state: 'topmostSubform[0].Page15[0].f15_24[0]',
    zip: 'topmostSubform[0].Page15[0].f15_25[0]',
    foreignCountry: 'topmostSubform[0].Page15[0].f15_26[0]',
    foreignProvince: 'topmostSubform[0].Page15[0].f15_27[0]',
    foreignPostal: 'topmostSubform[0].Page15[0].f15_28[0]',
  },
  3: {
    amount: 'topmostSubform[0].Page15[0].f15_1[0]',
    firstAndMiddle: 'topmostSubform[0].Page15[0].f15_2[0]',
    lastName: 'topmostSubform[0].Page15[0].f15_3[0]',
    ssn: 'topmostSubform[0].Page15[0].f15_4[0]',
    spouseFirstAndMiddle: 'topmostSubform[0].Page15[0].f15_5[0]',
    spouseLastName: 'topmostSubform[0].Page15[0].f15_6[0]',
    spouseSsn: 'topmostSubform[0].Page15[0].f15_7[0]',
    address: 'topmostSubform[0].Page15[0].f15_8[0]',
    city: 'topmostSubform[0].Page15[0].f15_9[0]',
    state: 'topmostSubform[0].Page15[0].f15_10[0]',
    zip: 'topmostSubform[0].Page15[0].f15_11[0]',
    foreignCountry: 'topmostSubform[0].Page15[0].f15_12[0]',
    foreignProvince: 'topmostSubform[0].Page15[0].f15_13[0]',
    foreignPostal: 'topmostSubform[0].Page15[0].f15_14[0]',
  },
  4: {
    amount: 'topmostSubform[0].Page14[0].f14_1[0]',
    firstAndMiddle: 'topmostSubform[0].Page14[0].f14_2[0]',
    lastName: 'topmostSubform[0].Page14[0].f14_3[0]',
    ssn: 'topmostSubform[0].Page14[0].f14_4[0]',
    spouseFirstAndMiddle: 'topmostSubform[0].Page14[0].f14_5[0]',
    spouseLastName: 'topmostSubform[0].Page14[0].f14_6[0]',
    spouseSsn: 'topmostSubform[0].Page14[0].f14_7[0]',
    address: 'topmostSubform[0].Page14[0].f14_8[0]',
    city: 'topmostSubform[0].Page14[0].f14_9[0]',
    state: 'topmostSubform[0].Page14[0].f14_10[0]',
    zip: 'topmostSubform[0].Page14[0].f14_11[0]',
    foreignCountry: 'topmostSubform[0].Page14[0].f14_12[0]',
    foreignProvince: 'topmostSubform[0].Page14[0].f14_13[0]',
    foreignPostal: 'topmostSubform[0].Page14[0].f14_14[0]',
  },
};

const PROPERTY_EXPENSE_LINE_ALIASES = {
  5: ['advertising'],
  6: ['autotravel', 'autoandtravel'],
  7: ['cleaningandmaintenance', 'cleaningmaintenance'],
  8: ['commissions'],
  9: ['insurance'],
  10: ['legalandprofessional', 'legalprofessional', 'professionalfees', 'legalfees'],
  11: ['managementfees', 'propertymanagement'],
  12: ['mortgageinterest'],
  13: ['otherinterest', 'interestother'],
  14: ['repairs'],
  15: ['supplies'],
  16: ['taxes'],
  17: ['utilities'],
  18: ['depreciation', 'depreciationexpense'],
};

function truncateAscii(value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeExpenseLabel(label = '') {
  return normalizeIdentityValue(label).replace(/[^a-z0-9]/g, '');
}

function formatIrsWholeDollars(value, { absolute = false, blankZero = true } = {}) {
  const roundedValue = Math.round(roundCurrency(value));
  if (roundedValue === 0 && blankZero) {
    return '';
  }

  const displayValue = absolute ? Math.abs(roundedValue) : roundedValue;
  const formatted = Math.abs(displayValue).toLocaleString('en-US');
  return displayValue < 0 ? `-${formatted}` : formatted;
}

function formatIrsPaymentAmount(value, { blankZero = true } = {}) {
  const amount = roundCurrency(value);
  if (amount === 0 && blankZero) {
    return '';
  }

  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUsDate(value = '') {
  const parts = String(value || '').split('-');
  if (parts.length !== 3) {
    return String(value || '').trim();
  }

  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

function splitFullName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstAndMiddle: '', lastName: '' };
  }

  if (parts.length === 1) {
    return { firstAndMiddle: parts[0], lastName: '' };
  }

  return {
    firstAndMiddle: parts.slice(0, -1).join(' '),
    lastName: parts.at(-1) || '',
  };
}

function buildVoucherIdentity(taxpayerInfo = {}) {
  const primary = splitFullName(taxpayerInfo.primaryName || taxpayerInfo.name || '');
  const spouse = splitFullName(taxpayerInfo.spouseName || '');

  return {
    primary,
    spouse,
    ssn: buildDraftTinLabel(taxpayerInfo),
    spouseSsn: '',
    address: taxpayerInfo.mailingStreet || taxpayerInfo.address || '',
    city: taxpayerInfo.mailingCity || '',
    state: String(taxpayerInfo.mailingState || taxpayerInfo.homeState || '').trim().toUpperCase(),
    zip: taxpayerInfo.mailingZip || '',
  };
}

function buildScheduleEPropertyTypeCode(propertyType = '') {
  const normalized = normalizeExpenseLabel(propertyType);
  if (!normalized) {
    return '';
  }

  if (normalized.includes('multifamily') || normalized.includes('duplex') || normalized.includes('triplex') || normalized.includes('quadplex')) {
    return '2';
  }
  if (normalized.includes('vacation') || normalized.includes('shortterm')) {
    return '3';
  }
  if (normalized.includes('commercial') || normalized.includes('office') || normalized.includes('retail')) {
    return '4';
  }
  if (normalized.includes('land') || normalized.includes('lot')) {
    return '5';
  }
  if (normalized.includes('royalt')) {
    return '6';
  }
  if (normalized.includes('selfrental')) {
    return '7';
  }
  if (normalized.includes('singlefamily') || normalized.includes('residential') || normalized.includes('condo') || normalized.includes('townhome') || normalized.includes('townhouse')) {
    return '1';
  }

  return '8';
}

function buildScheduleEPropertyExpenseLines(expenses = {}) {
  const normalizedExpenseAmounts = new Map();

  for (const [label, rawAmount] of Object.entries(expenses || {})) {
    const normalized = normalizeExpenseLabel(label);
    if (!normalized) {
      continue;
    }

    normalizedExpenseAmounts.set(
      normalized,
      roundCurrency((normalizedExpenseAmounts.get(normalized) || 0) + rawAmount),
    );
  }

  const consumed = new Set();
  const lineValues = {};

  for (const [line, aliases] of Object.entries(PROPERTY_EXPENSE_LINE_ALIASES)) {
    const total = aliases.reduce((sum, alias) => {
      if (!normalizedExpenseAmounts.has(alias)) {
        return sum;
      }

      consumed.add(alias);
      return sum + roundCurrency(normalizedExpenseAmounts.get(alias));
    }, 0);

    lineValues[Number(line)] = roundCurrency(total);
  }

  const otherLabels = [];
  let otherTotal = 0;

  for (const [label, rawAmount] of Object.entries(expenses || {})) {
    const normalized = normalizeExpenseLabel(label);
    const amount = roundCurrency(rawAmount);
    if (!normalized || consumed.has(normalized) || amount === 0) {
      continue;
    }

    otherLabels.push(String(label || '').trim());
    otherTotal += amount;
  }

  lineValues[19] = roundCurrency(otherTotal);

  return {
    lineValues,
    otherDescription: truncateAscii(Array.from(new Set(otherLabels)).join(', '), 32),
  };
}

function buildScheduleEPropertyFormRows(exportScheduleE) {
  const propertyRows = (exportScheduleE.propertySummaries || []).map((property) => {
    const expenseData = buildScheduleEPropertyExpenseLines(property.expenses || {});
    const income = roundCurrency(property.income || 0);
    const totalExpenses = roundCurrency(property.totalExpenses || 0);
    const netIncomeOrLoss = roundCurrency(property.netIncomeOrLoss != null ? property.netIncomeOrLoss : income - totalExpenses);

    return {
      address: truncateAscii(property.address || property.name || '', 96),
      propertyTypeCode: buildScheduleEPropertyTypeCode(property.propertyType),
      propertyTypeDescription: property.propertyType || '',
      fairRentalDays: Number(property.fairRentalDays || 365),
      personalUseDays: Number(property.personalUseDays || 0),
      qjv: Boolean(property.qjv || property.qualifiesJointVenture),
      otherDescription: expenseData.otherDescription,
      lines: {
        3: income,
        4: 0,
        5: expenseData.lineValues[5] || 0,
        6: expenseData.lineValues[6] || 0,
        7: expenseData.lineValues[7] || 0,
        8: expenseData.lineValues[8] || 0,
        9: expenseData.lineValues[9] || 0,
        10: expenseData.lineValues[10] || 0,
        11: expenseData.lineValues[11] || 0,
        12: expenseData.lineValues[12] || 0,
        13: expenseData.lineValues[13] || 0,
        14: expenseData.lineValues[14] || 0,
        15: expenseData.lineValues[15] || 0,
        16: expenseData.lineValues[16] || 0,
        17: expenseData.lineValues[17] || 0,
        18: expenseData.lineValues[18] || 0,
        19: expenseData.lineValues[19] || 0,
        20: totalExpenses,
        21: netIncomeOrLoss,
        22: netIncomeOrLoss < 0 ? Math.abs(netIncomeOrLoss) : 0,
      },
    };
  });

  return {
    propertyRows,
    otherDescription: truncateAscii(
      Array.from(new Set(propertyRows.map((property) => property.otherDescription).filter(Boolean))).join(', '),
      32,
    ),
    otherPropertyDescription: truncateAscii(
      propertyRows
        .map((property) => property.propertyTypeCode === '8' ? property.propertyTypeDescription : '')
        .filter(Boolean)
        .join(', '),
      24,
    ),
  };
}

async function loadPdfTemplate(templateUrl) {
  return PDFDocument.load(await readFile(templateUrl));
}

function setTextFieldValue(form, fieldName, value) {
  try {
    form.getTextField(fieldName).setText(String(value || ''));
  } catch {
    // Ignore missing or non-text fields so template changes degrade gracefully.
  }
}

function setCheckboxFieldValue(form, fieldName, checked) {
  try {
    const field = form.getCheckBox(fieldName);
    if (checked) {
      field.check();
    } else {
      field.uncheck();
    }
  } catch {
    // Ignore missing or non-checkbox fields so template changes degrade gracefully.
  }
}

function fillScheduleETwitterTemplate(form, exportScheduleE, taxpayerInfo = {}) {
  const taxpayerName = truncateAscii(buildDraftTaxpayerName(taxpayerInfo), 64);
  const tinLabel = buildDraftTinLabel(taxpayerInfo);
  const { propertyRows, otherDescription, otherPropertyDescription } = buildScheduleEPropertyFormRows(exportScheduleE);

  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.name, taxpayerName);
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.ssn, tinLabel);
  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.name, taxpayerName);
  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.ssn, tinLabel);
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.otherDescription, otherDescription);
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.otherPropertyDescription, otherPropertyDescription);

  SCHEDULE_E_PROPERTY_FIELD_NAMES.forEach((fieldSet, index) => {
    const property = propertyRows[index];
    if (!property) {
      return;
    }

    setTextFieldValue(form, fieldSet.address, property.address);
    setTextFieldValue(form, fieldSet.propertyType, property.propertyTypeCode);
    setTextFieldValue(form, fieldSet.fairRentalDays, String(property.fairRentalDays || ''));
    setTextFieldValue(form, fieldSet.personalUseDays, property.personalUseDays > 0 ? String(property.personalUseDays) : '0');
    setCheckboxFieldValue(form, fieldSet.qjv, property.qjv);

    for (const [line, fieldName] of Object.entries(fieldSet.lines)) {
      const lineNumber = Number(line);
      const value = property.lines[lineNumber] || 0;
      setTextFieldValue(
        form,
        fieldName,
        formatIrsWholeDollars(value, {
          absolute: lineNumber === 22,
          blankZero: true,
        }),
      );
    }
  });

  const positiveLine21Total = propertyRows.reduce((sum, property) => sum + Math.max(0, roundCurrency(property.lines[21])), 0);
  const deductibleLossTotal = propertyRows.reduce((sum, property) => sum + roundCurrency(property.lines[22]), 0);

  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line23a, formatIrsWholeDollars(exportScheduleE.scheduleELines.RENTS_RECEIVED?.amount));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line23b, formatIrsWholeDollars(exportScheduleE.scheduleELines.OTHER_INCOME?.amount));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line23c, formatIrsWholeDollars(exportScheduleE.scheduleELines.MORTGAGE_INTEREST?.amount));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line23d, formatIrsWholeDollars(exportScheduleE.scheduleELines.DEPRECIATION?.amount));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line23e, formatIrsWholeDollars(exportScheduleE.summary.totalExpenses));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line24, formatIrsWholeDollars(positiveLine21Total));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line25, formatIrsWholeDollars(deductibleLossTotal, { absolute: true }));
  setTextFieldValue(form, SCHEDULE_E_TOTAL_FIELD_NAMES.line26, formatIrsWholeDollars(exportScheduleE.summary.netIncomeOrLoss, { blankZero: false }));

  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.line40, '');
  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.line41, formatIrsWholeDollars(exportScheduleE.summary.netIncomeOrLoss, { blankZero: false }));
  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.line42, '');
  setTextFieldValue(form, SCHEDULE_E_PAGE2_FIELD_NAMES.line43, '');
}

function fill1040ESRecordPage(form, quarterData = []) {
  const totals = {
    amountPaid: 0,
    overpaymentCredit: 0,
    totalPaid: 0,
  };

  FORM_1040_ES_RECORD_FIELD_NAMES.forEach((fieldSet, index) => {
    const quarter = quarterData.find((item) => Number(item.quarter) === index + 1);
    if (!quarter) {
      return;
    }

    const amountPaid = roundCurrency(quarter.paid || 0);
    setTextFieldValue(form, fieldSet.dueDate, formatUsDate(quarter.dueDate));
    setTextFieldValue(form, fieldSet.amountDue, formatIrsPaymentAmount(quarter.estimatedDue));
    setTextFieldValue(form, fieldSet.datePaid, '');
    setTextFieldValue(form, fieldSet.confirmation, '');
    setTextFieldValue(form, fieldSet.amountPaid, formatIrsPaymentAmount(amountPaid));
    setTextFieldValue(form, fieldSet.overpaymentCredit, '');
    setTextFieldValue(form, fieldSet.totalPaid, formatIrsPaymentAmount(amountPaid));

    totals.amountPaid += amountPaid;
    totals.totalPaid += amountPaid;
  });

  setTextFieldValue(form, FORM_1040_ES_RECORD_TOTAL_FIELDS.amountPaid, formatIrsPaymentAmount(totals.amountPaid));
  setTextFieldValue(form, FORM_1040_ES_RECORD_TOTAL_FIELDS.overpaymentCredit, '');
  setTextFieldValue(form, FORM_1040_ES_RECORD_TOTAL_FIELDS.totalPaid, formatIrsPaymentAmount(totals.totalPaid));
}

function fill1040ESVoucherPages(form, quarterData = [], taxpayerInfo = {}) {
  const voucherIdentity = buildVoucherIdentity(taxpayerInfo);

  for (const quarterNumber of [1, 2, 3, 4]) {
    const fieldSet = FORM_1040_ES_VOUCHER_FIELD_NAMES[quarterNumber];
    const quarter = quarterData.find((item) => Number(item.quarter) === quarterNumber);
    if (!fieldSet || !quarter) {
      continue;
    }

    const paymentAmount = roundCurrency(
      (quarter.remaining || 0) > 0 ? quarter.remaining : quarter.estimatedDue || 0,
    );
    setTextFieldValue(form, fieldSet.amount, formatIrsPaymentAmount(paymentAmount));
    setTextFieldValue(form, fieldSet.firstAndMiddle, truncateAscii(voucherIdentity.primary.firstAndMiddle, 34));
    setTextFieldValue(form, fieldSet.lastName, truncateAscii(voucherIdentity.primary.lastName, 24));
    setTextFieldValue(form, fieldSet.ssn, voucherIdentity.ssn);
    setTextFieldValue(form, fieldSet.spouseFirstAndMiddle, truncateAscii(voucherIdentity.spouse.firstAndMiddle, 34));
    setTextFieldValue(form, fieldSet.spouseLastName, truncateAscii(voucherIdentity.spouse.lastName, 24));
    setTextFieldValue(form, fieldSet.spouseSsn, voucherIdentity.spouseSsn);
    setTextFieldValue(form, fieldSet.address, truncateAscii(voucherIdentity.address, 80));
    setTextFieldValue(form, fieldSet.city, truncateAscii(voucherIdentity.city, 40));
    setTextFieldValue(form, fieldSet.state, voucherIdentity.state);
    setTextFieldValue(form, fieldSet.zip, voucherIdentity.zip);
    setTextFieldValue(form, fieldSet.foreignCountry, '');
    setTextFieldValue(form, fieldSet.foreignProvince, '');
    setTextFieldValue(form, fieldSet.foreignPostal, '');
  }
}

async function appendLegacyScheduleEAttachments(doc, scheduleE, depreciation = null, taxpayerInfo = {}, vendors1099 = null, options = {}) {
  const legacyBytes = await generateLegacyScheduleEPDF(scheduleE, depreciation, taxpayerInfo, vendors1099, options);
  const legacyDoc = await PDFDocument.load(legacyBytes);
  if (legacyDoc.getPageCount() <= 1) {
    return;
  }

  const attachmentIndexes = Array.from({ length: legacyDoc.getPageCount() - 1 }, (_, index) => index + 1);
  const copiedPages = await doc.copyPages(legacyDoc, attachmentIndexes);
  copiedPages.forEach((page) => doc.addPage(page));
}

export function generateTXF(scheduleE, depreciation = null) {
  const exportScheduleE = buildScheduleEExportModel(scheduleE, depreciation);
  const lines = [];

  lines.push('V042');
  lines.push('AHouseYield Tax Export');
  lines.push(`D${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}`);
  lines.push('^');

  for (const [key, data] of Object.entries(exportScheduleE.scheduleELines)) {
    if (data.amount === 0) continue;

    const txfCode = TXF_CODES[key];
    if (!txfCode) continue;

    lines.push('TD');
    lines.push(txfCode.code);
    lines.push('C1');
    lines.push('L1');
    lines.push(`$${data.amount.toFixed(2)}`);
    lines.push('^');
  }

  if (depreciation && depreciation.summary.totalCurrentYearDepreciation > 0) {
    const depLine = exportScheduleE.scheduleELines?.DEPRECIATION;
    if (!depLine || depLine.amount === 0) {
      lines.push('TD');
      lines.push('N536');
      lines.push('C1');
      lines.push('L1');
      lines.push(`$${depreciation.summary.totalCurrentYearDepreciation.toFixed(2)}`);
      lines.push('^');
    }
  }

  return lines.join('\r\n');
}

function formatFormCurrency(value) {
  const amount = roundCurrency(value);
  const absolute = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return amount < 0 ? `(${absolute})` : absolute;
}

function buildDraftTaxpayerName(taxpayerInfo = {}) {
  const primary = String(taxpayerInfo.primaryName || taxpayerInfo.name || '').trim();
  const spouse = String(taxpayerInfo.spouseName || '').trim();
  if (spouse) {
    return `${primary || 'Primary taxpayer'} & ${spouse}`;
  }
  return primary || '[Taxpayer name]';
}

function buildDraftTinLabel(taxpayerInfo = {}) {
  const tinLast4 = String(taxpayerInfo.tinLast4 || taxpayerInfo.ssnLast4 || '').replace(/\D/g, '').slice(-4);
  return tinLast4 ? `***-**-${tinLast4}` : '___-__-____';
}

function parseUsMailingAddress(addressLine = '') {
  const trimmed = String(addressLine || '').trim();
  if (!trimmed || trimmed === 'MISSING') {
    return { street: '', city: '', state: '', zip: '' };
  }

  const trailingMatch = trimmed.match(/^(.+?),\s*(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (trailingMatch) {
    return {
      street: trailingMatch[1].trim(),
      city: trailingMatch[2].trim(),
      state: trailingMatch[3].toUpperCase(),
      zip: trailingMatch[4],
    };
  }

  return { street: trimmed, city: '', state: '', zip: '' };
}

function splitTinForIrsBoxes(tin = '') {
  const raw = String(tin || '').trim();
  if (!raw || raw === 'MISSING') {
    return { part1: '', part2: '', part3: '', formatted: '' };
  }

  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly.length === 9 && !raw.includes('*')) {
    return {
      part1: digitsOnly.slice(0, 2),
      part2: digitsOnly.slice(2, 4),
      part3: digitsOnly.slice(4),
      formatted: raw.includes('-') ? raw : `${digitsOnly.slice(0, 2)}-${digitsOnly.slice(2)}`,
    };
  }

  return { part1: '', part2: '', part3: '', formatted: raw };
}

function build1099NecCopyFieldNames(copyName = 'CopyB') {
  const fieldPrefix = copyName === 'CopyA' ? 'f1' : 'f2';
  const copyBase = `topmostSubform[0].${copyName}[0]`;
  const leftCol = `${copyBase}.LeftCol[0]`;
  const rightCol = `${copyBase}.RightCol[0]`;

  return {
    calendarYear: `${copyBase}.PgHeader[0].CalendarYear[0].${fieldPrefix}_1[0]`,
    payerName: `${leftCol}.${fieldPrefix}_2[0]`,
    payerStreet: `${leftCol}.${fieldPrefix}_3[0]`,
    payerCity: `${leftCol}.${fieldPrefix}_4[0]`,
    payerState: `${leftCol}.${fieldPrefix}_5[0]`,
    payerZip: `${leftCol}.${fieldPrefix}_6[0]`,
    payerTinPart1: `${leftCol}.${fieldPrefix}_7[0]`,
    payerTinPart2: `${leftCol}.${fieldPrefix}_8[0]`,
    payerTinPart3: `${leftCol}.${fieldPrefix}_9[0]`,
    payerTin: `${leftCol}.${fieldPrefix}_10[0]`,
    recipientTin: `${leftCol}.${fieldPrefix}_11[0]`,
    recipientName: `${leftCol}.${fieldPrefix}_12[0]`,
    recipientStreet: `${leftCol}.${fieldPrefix}_13[0]`,
    recipientCity: `${leftCol}.${fieldPrefix}_14[0]`,
    recipientState: `${leftCol}.${fieldPrefix}_15[0]`,
    recipientTinPart1: `${leftCol}.${fieldPrefix}_16[0]`,
    recipientTinPart2: `${leftCol}.${fieldPrefix}_17[0]`,
    box1NonemployeeCompensation: `${rightCol}.${fieldPrefix}_20[0]`,
  };
}

function build1099NecExportPayload(form1099 = {}, payerInfo = {}) {
  return {
    payer: {
      name: buildDraftTaxpayerName(payerInfo),
      tin: payerInfo.ein || buildDraftTinLabel(payerInfo),
      street: payerInfo.mailingStreet || payerInfo.address || '',
      city: payerInfo.mailingCity || '',
      state: String(payerInfo.mailingState || payerInfo.homeState || '').trim().toUpperCase(),
      zip: payerInfo.mailingZip || '',
    },
    recipient: {
      name: String(form1099.recipientName || '').trim(),
      tin: String(form1099.recipientTIN || '').trim(),
      addressLine: String(form1099.recipientAddress || '').trim(),
    },
    amount: roundCurrency(form1099.amount || 0),
  };
}

function fill1099NecCopy(form, copyName, { payer, recipient, taxYear, amount }) {
  const fields = build1099NecCopyFieldNames(copyName);
  const payerTin = splitTinForIrsBoxes(payer.tin);
  const recipientTin = splitTinForIrsBoxes(recipient.tin);
  const recipientAddress = parseUsMailingAddress(recipient.addressLine);
  const recipientCityStateZip = [recipientAddress.city, recipientAddress.state, recipientAddress.zip]
    .filter(Boolean)
    .join(' ')
    .trim();

  setTextFieldValue(form, fields.calendarYear, String(taxYear));
  setTextFieldValue(form, fields.payerName, truncateAscii(payer.name, 64));
  setTextFieldValue(form, fields.payerStreet, truncateAscii(payer.street, 64));
  setTextFieldValue(form, fields.payerCity, truncateAscii(payer.city, 40));
  setTextFieldValue(form, fields.payerState, payer.state);
  setTextFieldValue(form, fields.payerZip, payer.zip);
  setTextFieldValue(form, fields.payerTinPart1, payerTin.part1);
  setTextFieldValue(form, fields.payerTinPart2, payerTin.part2);
  setTextFieldValue(form, fields.payerTinPart3, payerTin.part3);
  setTextFieldValue(form, fields.payerTin, truncateAscii(payerTin.formatted, 11));
  setTextFieldValue(form, fields.recipientTin, truncateAscii(recipientTin.formatted, 11));
  setTextFieldValue(form, fields.recipientName, truncateAscii(recipient.name, 64));
  setTextFieldValue(form, fields.recipientStreet, truncateAscii(recipientAddress.street, 64));
  setTextFieldValue(form, fields.recipientCity, truncateAscii(recipientAddress.city || recipientCityStateZip, 40));
  setTextFieldValue(form, fields.recipientState, truncateAscii(recipientCityStateZip, 40));
  setTextFieldValue(form, fields.recipientTinPart1, recipientTin.part1);
  setTextFieldValue(form, fields.recipientTinPart2, recipientTin.part2);
  setTextFieldValue(form, fields.box1NonemployeeCompensation, formatIrsPaymentAmount(amount));
}

function fill1099NecOfficialForm(form, form1099, payerInfo, taxYear) {
  const payload = build1099NecExportPayload(form1099, payerInfo);
  const normalizedYear = Number.isFinite(Number(taxYear)) ? Number(taxYear) : new Date().getFullYear();

  for (const copyName of FORM_1099_NEC_COPY_NAMES) {
    fill1099NecCopy(form, copyName, { ...payload, taxYear: normalizedYear });
  }
}

function buildDraftCityStateZip(taxpayerInfo = {}) {
  const city = String(taxpayerInfo.mailingCity || '').trim();
  const state = String(taxpayerInfo.mailingState || taxpayerInfo.homeState || '').trim().toUpperCase();
  const zip = String(taxpayerInfo.mailingZip || '').trim();
  const parts = [];

  if (city) parts.push(city);
  if (state || zip) {
    parts.push([state, zip].filter(Boolean).join(' '));
  }

  return parts.join(', ') || '[City, State ZIP]';
}

function humanizeFilingStatus(status = 'single') {
  switch (String(status || '').toLowerCase()) {
    case 'mfj':
    case 'married_filing_jointly':
      return 'Married filing jointly';
    case 'mfs':
    case 'married_filing_separately':
      return 'Married filing separately';
    case 'hoh':
    case 'head_of_household':
      return 'Head of household';
    default:
      return 'Single';
  }
}

function drawFormField(page, {
  x,
  y,
  width,
  height = 32,
  label,
  value,
  font,
  fontBold,
  labelSize = 7,
  valueSize = 10,
}) {
  const border = rgb(0, 0, 0);
  const labelColor = rgb(0.35, 0.35, 0.35);
  const safeValue = String(value || '').trim() || ' ';

  page.drawRectangle({
    x,
    y: y - height,
    width,
    height,
    borderColor: border,
    borderWidth: 1,
  });
  page.drawText(label, {
    x: x + 4,
    y: y - 10,
    size: labelSize,
    font,
    color: labelColor,
  });
  page.drawText(safeValue, {
    x: x + 4,
    y: y - height + 8,
    size: valueSize,
    font: fontBold,
    color: border,
  });
}

function drawFormTableHeader(page, y, fontBold) {
  page.drawRectangle({ x: 50, y: y - 18, width: 512, height: 18, color: rgb(0, 0, 0) });
  page.drawText('Line', { x: 58, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
  page.drawText('Description', { x: 102, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
  page.drawText('Amount', { x: 486, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
  return y - 24;
}

async function generateLegacyScheduleEPDF(scheduleE, depreciation = null, taxpayerInfo = {}, vendors1099 = null, options = {}) {
  const exportScheduleE = buildScheduleEExportModel(scheduleE, depreciation);
  const exportDepreciation = {
    ...(depreciation || {}),
    assets: dedupeDepreciationAssets(depreciation?.assets || []),
  };
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const textBlack = rgb(0, 0, 0);
  const textGray = rgb(0.35, 0.35, 0.35);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const white = rgb(1, 1, 1);
  const taxpayerName = buildDraftTaxpayerName(taxpayerInfo);
  const tinLabel = buildDraftTinLabel(taxpayerInfo);
  const propertyScope = taxpayerInfo.propertyScope
    || (exportScheduleE.propertySummaries?.length === 1
      ? exportScheduleE.propertySummaries[0].address || exportScheduleE.propertySummaries[0].name || 'Rental property'
      : `${exportScheduleE.propertySummaries?.length || 0} rental properties`);
  const lineItems = Object.values(exportScheduleE.scheduleELines || {})
    .filter((line) => Number(line.amount || 0) !== 0)
    .sort((left, right) => Number(left.line || 999) - Number(right.line || 999));
  const scheduleRows = [
    ...lineItems,
    { line: 20, name: 'Total expenses', amount: exportScheduleE.summary.totalExpenses, entries: [] },
    { line: 21, name: 'Income or (loss)', amount: exportScheduleE.summary.netIncomeOrLoss, entries: [] },
  ];

  let page = doc.addPage([612, 792]);
  let y = 760;

  page.drawText('Department of the Treasury  Internal Revenue Service', { x: 50, y, size: 8, font, color: textGray });
  page.drawText('Schedule E (Form 1040)', { x: 50, y: y - 22, size: 18, font: fontBold, color: textBlack });
  page.drawText(String(exportScheduleE.taxYear || new Date().getFullYear()), { x: 520, y: y - 18, size: 16, font: fontBold, color: textBlack });
  page.drawText('Supplemental Income and Loss  Draft filing layout generated from the canonical rental ledger', { x: 50, y: y - 38, size: 9, font, color: textGray });

  y = 690;
  drawFormField(page, { x: 50, y, width: 300, label: 'Name(s) shown on return', value: taxpayerName, font, fontBold });
  drawFormField(page, { x: 362, y, width: 200, label: 'Identifying number', value: tinLabel, font, fontBold });
  y -= 42;
  drawFormField(page, { x: 50, y, width: 340, label: 'Rental real estate / royalty property scope', value: propertyScope, font, fontBold });
  drawFormField(page, { x: 402, y, width: 160, label: 'Filing status', value: humanizeFilingStatus(taxpayerInfo.filingStatus), font, fontBold });
  y -= 42;
  drawFormField(page, { x: 50, y, width: 250, label: 'Mailing street', value: taxpayerInfo.mailingStreet || '[Mailing street]', font, fontBold });
  drawFormField(page, { x: 312, y, width: 250, label: 'City, state, ZIP', value: buildDraftCityStateZip(taxpayerInfo), font, fontBold });
  y -= 54;

  page.drawText('Part I  Income or Loss From Rental Real Estate and Royalties', { x: 50, y, size: 10, font: fontBold, color: textBlack });
  y = drawFormTableHeader(page, y - 10, fontBold);

  for (const row of scheduleRows) {
    if (y < 100) {
      page = doc.addPage([612, 792]);
      y = 740;
      page.drawText(`Schedule E (Form 1040)  ${exportScheduleE.taxYear}`, { x: 50, y: 760, size: 10, font: fontBold, color: textBlack });
      y = drawFormTableHeader(page, y, fontBold);
    }

    if (row.line === 20 || row.line === 21) {
      page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 18, color: lightGray });
    }

    page.drawText(String(row.line ?? '—'), { x: 60, y, size: 9, font: row.line === 20 || row.line === 21 ? fontBold : font, color: textBlack });
    page.drawText(String(row.name || ''), { x: 102, y, size: 9, font: row.line === 20 || row.line === 21 ? fontBold : font, color: textBlack });
    page.drawText(formatFormCurrency(row.amount), { x: 474, y, size: 9, font: fontBold, color: textBlack });
    y -= 18;
  }

  page.drawRectangle({ x: 50, y: y - 6, width: 512, height: 34, borderColor: textBlack, borderWidth: 1 });
  page.drawText('Return support summary', { x: 58, y: y + 12, size: 8, font: fontBold, color: textBlack });
  page.drawText(`Properties in scope: ${exportScheduleE.propertySummaries?.length || 0}`, { x: 58, y: y + 2, size: 8, font, color: textGray });
  page.drawText(`Depreciation assets: ${exportDepreciation.assets?.length || 0}`, { x: 220, y: y + 2, size: 8, font, color: textGray });
  page.drawText(`Generated ${new Date().toLocaleDateString()}`, { x: 430, y: y + 2, size: 8, font, color: textGray });

  if (exportScheduleE.propertySummaries && exportScheduleE.propertySummaries.length > 0) {
    page = doc.addPage([612, 792]);
    y = 758;
    page.drawText('Schedule E (Form 1040)  Supporting property detail', { x: 50, y, size: 13, font: fontBold, color: textBlack });
    y -= 18;
    page.drawText('Separate property detail is shown here to support the line totals reported on the Schedule E draft form.', { x: 50, y, size: 8, font, color: textGray });
    y -= 28;

    const colLabels = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let index = 0; index < exportScheduleE.propertySummaries.length; index++) {
      const property = exportScheduleE.propertySummaries[index];
      if (y < 170) {
        page = doc.addPage([612, 792]);
        y = 748;
      }

      page.drawRectangle({ x: 50, y: y - 6, width: 512, height: 20, color: rgb(0, 0, 0) });
      page.drawText(`Property ${colLabels[index] || index + 1}`, { x: 58, y, size: 9, font: fontBold, color: white });
      page.drawText(property.name || property.address || 'Rental property', { x: 140, y, size: 9, font: fontBold, color: white });
      y -= 28;

      drawFormField(page, { x: 50, y, width: 360, label: 'Address', value: property.address || property.name || 'Rental property', font, fontBold, height: 28, valueSize: 9 });
      drawFormField(page, { x: 422, y, width: 140, label: 'Fair rental / personal use days', value: `${property.fairRentalDays || 365} / ${property.personalUseDays || 0}`, font, fontBold, height: 28, valueSize: 9 });
      y -= 38;

      const propertyRows = [
        ['Income', property.income || 0],
        ['Total expenses', property.totalExpenses || 0],
        ['Net income or (loss)', property.netIncomeOrLoss != null ? property.netIncomeOrLoss : roundCurrency((property.income || 0) - (property.totalExpenses || 0))],
      ];
      for (const [label, amount] of propertyRows) {
        page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 18, borderColor: textBlack, borderWidth: 0.5, color: label === 'Net income or (loss)' ? lightGray : white });
        page.drawText(label, { x: 58, y, size: 8, font: label === 'Net income or (loss)' ? fontBold : font, color: textBlack });
        page.drawText(formatFormCurrency(amount), { x: 478, y, size: 8, font: fontBold, color: textBlack });
        y -= 18;
      }
      y -= 14;
    }
  }

  if (exportDepreciation && exportDepreciation.assets && exportDepreciation.assets.length > 0 && !options?.skipForm4562) {
    page = doc.addPage([612, 792]);
    y = 758;
    page.drawText('Form 4562 support  Depreciation attached to Schedule E line 18', { x: 50, y, size: 13, font: fontBold, color: textBlack });
    y -= 24;

    for (const asset of exportDepreciation.assets) {
      if (y < 130) {
        page = doc.addPage([612, 792]);
        y = 748;
      }
      page.drawRectangle({ x: 50, y: y - 6, width: 512, height: 48, borderColor: textBlack, borderWidth: 1 });
      page.drawText(asset.propertyName || asset.propertyAddress || 'Depreciation asset', { x: 58, y: y + 24, size: 9, font: fontBold, color: textBlack });
      page.drawText(`Placed in service: ${asset.dateAcquired || 'N/A'}  Method: ${asset.method || '—'}`, { x: 58, y: y + 12, size: 8, font, color: textGray });
      page.drawText(`Cost ${formatFormCurrency(asset.cost)}  Basis ${formatFormCurrency(asset.depreciableBasis)}  Current-year depreciation ${formatFormCurrency(asset.currentYearDepreciation)}`, { x: 58, y, size: 8, font, color: textBlack });
      y -= 60;
    }
  }

  // ── 1099-NEC Vendor Summary ───────────────────────────────────────────────
  const vendors = vendors1099?.vendors || vendors1099?.vendorSummaries || [];
  const totalForms = vendors1099?.totalForms || vendors.length;
  if (totalForms > 0 || (vendors1099?.totalAmount || 0) > 0) {
    page = doc.addPage([612, 792]);
    y = 758;
    page.drawText('1099-NEC  Nonemployee Compensation Summary', { x: 50, y, size: 13, font: fontBold, color: textBlack });
    y -= 16;
    page.drawText(`Tax year ${scheduleE.taxYear || new Date().getFullYear()}  ·  Filer copy for Schedule E attachment`, { x: 50, y, size: 8, font, color: textGray });
    y -= 28;

    // Summary row
    page.drawRectangle({ x: 50, y: y - 6, width: 512, height: 22, color: lightGray });
    page.drawText(`Total reportable payments: ${formatFormCurrency(vendors1099?.totalAmount || 0)}`, { x: 58, y: y + 4, size: 9, font: fontBold, color: textBlack });
    page.drawText(`Forms required: ${totalForms}  ·  Forms ready: ${vendors1099?.formsReady || 0}  ·  Missing info: ${vendors1099?.formsWithMissingInfo || 0}`, { x: 310, y: y + 4, size: 8, font, color: textGray });
    y -= 30;

    // Column headers
    page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 16, color: rgb(0, 0, 0) });
    page.drawText('Vendor / Contractor', { x: 58, y, size: 8, font: fontBold, color: white });
    page.drawText('Amount Paid', { x: 400, y, size: 8, font: fontBold, color: white });
    page.drawText('Status', { x: 470, y, size: 8, font: fontBold, color: white });
    y -= 22;

    const reportableVendors = vendors.filter((v) => v.requires1099);
    for (const vendor of reportableVendors) {
      if (y < 80) {
        page = doc.addPage([612, 792]);
        y = 748;
        page.drawText('1099-NEC Vendor Summary (continued)', { x: 50, y, size: 10, font: fontBold, color: textBlack });
        y -= 24;
      }
      const missingList = Array.isArray(vendor.missingInfo) && vendor.missingInfo.length > 0
        ? vendor.missingInfo.join(', ')
        : null;
      const statusText = vendor.ready ? 'READY' : `MISSING: ${missingList || 'info'}`;
      const statusColor = vendor.ready ? rgb(0.06, 0.48, 0.23) : rgb(0.72, 0.12, 0.12);
      const vendorName = String(vendor.name || 'Unknown vendor').slice(0, 42);

      page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 16, borderColor: rgb(0.88, 0.88, 0.88), borderWidth: 0.5 });
      page.drawText(vendorName, { x: 58, y, size: 8, font, color: textBlack });
      page.drawText(formatFormCurrency(vendor.totalPaid || 0), { x: 400, y, size: 8, font: fontBold, color: textBlack });
      page.drawText(statusText, { x: 470, y, size: 8, font: fontBold, color: statusColor });
      y -= 18;
    }

    y -= 10;
    page.drawText('Note: File Form 1099-NEC by Jan 31 for each contractor paid $2,000+ (2026 threshold). Retain W-9 for each vendor.', { x: 50, y, size: 7, font, color: textGray });
  }

  const pages = doc.getPages();
  for (const pg of pages) {
    pg.drawLine({ start: { x: 45, y: 40 }, end: { x: 565, y: 40 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    pg.drawText('Draft IRS-style form layout generated from canonical bookkeeping data. Review before filing.', { x: 50, y: 28, size: 7, font, color: rgb(0.6, 0.6, 0.6) });
    pg.drawText('Generated by Renaissance Realty — HouseYield', { x: 50, y: 18, size: 7, font, color: rgb(0.6, 0.6, 0.6) });
  }

  return await doc.save();
}

async function generateOfficialScheduleEPDF(scheduleE, depreciation = null, taxpayerInfo = {}, vendors1099 = null, attachmentContext = {}) {
  const exportScheduleE = buildScheduleEExportModel(scheduleE, depreciation);
  const exportDepreciation = {
    ...(depreciation || {}),
    assets: dedupeDepreciationAssets(depreciation?.assets || []),
  };
  const doc = await loadPdfTemplate(SCHEDULE_E_TEMPLATE_URL);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  fillScheduleETwitterTemplate(form, exportScheduleE, taxpayerInfo);
  form.updateFieldAppearances(font);
  form.flatten();

  if ((exportScheduleE.propertySummaries?.length || 0) > 0 || (exportDepreciation.assets?.length || 0) > 0) {
    await appendLegacyScheduleEAttachments(doc, scheduleE, depreciation, taxpayerInfo, vendors1099, { skipForm4562: true });
  }

  await appendOfficialTaxFormAttachments(doc, {
    depreciation,
    taxpayerInfo,
    taxYear: scheduleE.taxYear,
    mortgage1098: attachmentContext.mortgage1098 || null,
  });

  return await doc.save();
}

export async function generateOfficialScheduleEOnlyPDF(scheduleE, depreciation = null, taxpayerInfo = {}) {
  const exportScheduleE = buildScheduleEExportModel(scheduleE, depreciation);
  const doc = await loadPdfTemplate(SCHEDULE_E_TEMPLATE_URL);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  fillScheduleETwitterTemplate(form, exportScheduleE, taxpayerInfo);
  form.updateFieldAppearances(font);
  form.flatten();
  return await doc.save();
}

export async function generateScheduleEPDF(scheduleE, depreciation = null, taxpayerInfo = {}, vendors1099 = null, attachmentContext = {}) {
  try {
    return await generateOfficialScheduleEPDF(scheduleE, depreciation, taxpayerInfo, vendors1099, attachmentContext);
  } catch (error) {
    console.warn('Schedule E template overlay failed, falling back to legacy draft renderer.', error);
    return generateLegacyScheduleEPDF(scheduleE, depreciation, taxpayerInfo, vendors1099);
  }
}

function findScheduleLineForSupport(scheduleE, lineNumber, keyIncludes = []) {
  const lines = Object.entries(scheduleE?.scheduleELines || {});
  return lines.find(([key, line]) => Number(line?.line || 0) === lineNumber || keyIncludes.some((token) => key.toUpperCase().includes(token)));
}

export async function generateTaxSupportDocumentPDF(
  scheduleE,
  depreciation = null,
  taxpayerInfo = {},
  vendors1099 = null,
  docType = 'schedule-e',
  metadata = {},
) {
  if (docType === 'schedule-e') {
    return generateOfficialScheduleEOnlyPDF(scheduleE, depreciation, taxpayerInfo);
  }
  if (docType === '1099-nec') {
    return generate1099NecFormsPDF(vendors1099?.forms || vendors1099?.formSummaries || [], taxpayerInfo, scheduleE?.taxYear);
  }
  if (docType === 'form-4562') {
    try {
      return await generateOfficialForm4562PDF(depreciation, taxpayerInfo, scheduleE?.taxYear);
    } catch (error) {
      console.warn('Form 4562 official IRS template fill failed; falling back to support PDF.', error);
    }
  }
  if (docType === 'form-1098') {
    try {
      return await generateOfficialForm1098PDF(metadata?.mortgage1098 || {}, taxpayerInfo, scheduleE?.taxYear);
    } catch (error) {
      console.warn('Form 1098 official IRS template fill failed; falling back to support PDF.', error);
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const textBlack = rgb(0, 0, 0);
  const textGray = rgb(0.35, 0.35, 0.35);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const white = rgb(1, 1, 1);
  let y = 748;

  const titleByType = {
    'form-4562': 'Form 4562 support',
    'form-1098': 'Form 1098 support',
    'property-tax': 'Property tax support',
    'insurance': 'Insurance premium support',
  };
  const subtitleByType = {
    'form-4562': 'Depreciation attached to Schedule E line 18',
    'form-1098': 'Mortgage interest tied to Schedule E line 12',
    'property-tax': 'Property taxes tied to Schedule E line 16',
    'insurance': 'Insurance tied to Schedule E line 9',
  };

  page.drawText(String(titleByType[docType] || 'Tax support document'), { x: 50, y, size: 16, font: fontBold, color: textBlack });
  y -= 18;
  page.drawText(String(subtitleByType[docType] || `Tax year ${scheduleE?.taxYear || new Date().getFullYear()}`), { x: 50, y, size: 9, font, color: textGray });
  y -= 26;

  page.drawRectangle({ x: 50, y: y - 10, width: 512, height: 56, borderColor: textBlack, borderWidth: 1 });
  page.drawText('Taxpayer', { x: 58, y: y + 28, size: 8, font, color: textGray });
  page.drawText(buildDraftTaxpayerName(taxpayerInfo), { x: 58, y: y + 12, size: 10, font: fontBold, color: textBlack });
  page.drawText(`Tax year ${scheduleE?.taxYear || new Date().getFullYear()}`, { x: 58, y: y - 2, size: 9, font, color: textBlack });
  if (metadata?.propertyScope || taxpayerInfo.propertyScope) {
    page.drawText(String(metadata.propertyScope || taxpayerInfo.propertyScope), { x: 300, y: y + 12, size: 9, font, color: textBlack });
  }
  y -= 78;

  if (docType === 'form-4562') {
    const assets = dedupeDepreciationAssets(depreciation?.assets || []);
    page.drawRectangle({ x: 50, y: y - 8, width: 512, height: 22, color: lightGray });
    page.drawText(`Current-year depreciation: ${formatFormCurrency(depreciation?.summary?.totalCurrentYearDepreciation || 0)}`, { x: 58, y: y + 4, size: 10, font: fontBold, color: textBlack });
    page.drawText(`Assets: ${assets.length}`, { x: 430, y: y + 4, size: 9, font, color: textGray });
    y -= 34;
    for (const asset of assets) {
      if (y < 110) break;
      page.drawRectangle({ x: 50, y: y - 6, width: 512, height: 48, borderColor: textBlack, borderWidth: 1 });
      page.drawText(asset.propertyName || asset.propertyAddress || 'Depreciation asset', { x: 58, y: y + 24, size: 9, font: fontBold, color: textBlack });
      page.drawText(`Placed in service: ${asset.dateAcquired || 'N/A'} · Method: ${asset.method || '—'}`, { x: 58, y: y + 12, size: 8, font, color: textGray });
      page.drawText(`Cost ${formatFormCurrency(asset.cost)} · Basis ${formatFormCurrency(asset.depreciableBasis)} · Current-year depreciation ${formatFormCurrency(asset.currentYearDepreciation)}`, { x: 58, y, size: 8, font, color: textBlack });
      y -= 60;
    }
  } else {
    const lineConfig = docType === 'form-1098'
      ? { lineNumber: 12, keys: ['MORTGAGE'], title: metadata?.lenderLabel ? `Lender: ${metadata.lenderLabel}` : 'Mortgage interest from the bookkeeping ledger' }
      : docType === 'property-tax'
        ? { lineNumber: 16, keys: ['TAX'], title: 'Property tax payments from the bookkeeping ledger' }
        : { lineNumber: 9, keys: ['INSUR'], title: 'Insurance premiums from the bookkeeping ledger' };
    const match = findScheduleLineForSupport(scheduleE, lineConfig.lineNumber, lineConfig.keys);
    const line = match?.[1] || { name: 'Not available', amount: 0, entries: [] };
    page.drawRectangle({ x: 50, y: y - 8, width: 512, height: 22, color: lightGray });
    page.drawText(`${line.name} · Schedule E line ${line.line || lineConfig.lineNumber}`, { x: 58, y: y + 4, size: 10, font: fontBold, color: textBlack });
    page.drawText(formatFormCurrency(line.amount || 0), { x: 455, y: y + 4, size: 10, font: fontBold, color: textBlack });
    y -= 28;
    page.drawText(lineConfig.title, { x: 50, y, size: 9, font, color: textGray });
    y -= 18;
    page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 16, color: textBlack });
    page.drawText('Date', { x: 58, y, size: 8, font: fontBold, color: white });
    page.drawText('Description', { x: 140, y, size: 8, font: fontBold, color: white });
    page.drawText('Amount', { x: 490, y, size: 8, font: fontBold, color: white });
    y -= 22;
    for (const entry of (line.entries || []).slice(0, 12)) {
      if (y < 90) break;
      page.drawRectangle({ x: 50, y: y - 4, width: 512, height: 16, borderColor: rgb(0.88, 0.88, 0.88), borderWidth: 0.5 });
      page.drawText(String(entry.date || '—').slice(0, 10), { x: 58, y, size: 8, font, color: textGray });
      page.drawText(String(entry.description || entry.memo || '—').slice(0, 48), { x: 140, y, size: 8, font, color: textBlack });
      page.drawText(formatFormCurrency(entry.amount || 0), { x: 470, y, size: 8, font: fontBold, color: textBlack });
      y -= 18;
    }
  }

  page.drawLine({ start: { x: 45, y: 40 }, end: { x: 565, y: 40 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  page.drawText('Support schedule generated from HouseYield bookkeeping data. Review against the official IRS or payer-issued form before filing.', { x: 50, y: 28, size: 7, font, color: textGray });
  page.drawText('Generated by Renaissance Realty — HouseYield', { x: 50, y: 18, size: 7, font, color: textGray });
  return await doc.save();
}

export function generateDetailedCSV(entries, taxYear) {
  const header = 'Date,Description,Category,Vendor,Amount,Type,Property,Schedule E Line';
  const rows = entries
    .filter((entry) => {
      const year = entry.date ? parseInt(entry.date.substring(0, 4)) : null;
      return year === taxYear;
    })
    .sort((left, right) => (left.date || '').localeCompare(right.date || ''))
    .map((entry) => {
      const line = entry.scheduleELine || '';
      return [
        entry.date || '',
        `"${(entry.description || '').replace(/"/g, '""')}"`,
        `"${entry.category || ''}"`,
        `"${entry.vendor || ''}"`,
        (parseFloat(entry.amount) || 0).toFixed(2),
        entry.type || '',
        `"${entry.propertyId || ''}"`,
        line,
      ].join(',');
    });

  return [header, ...rows].join('\n');
}

export function generateScheduleESummaryCSV(scheduleE) {
  const lines = ['Category,Schedule E Line,Amount'];

  for (const [, data] of Object.entries(scheduleE?.scheduleELines || {})) {
    lines.push(`"${data.name}",Line ${data.line},$${Number(data.amount || 0).toFixed(2)}`);
  }

  lines.push('');
  lines.push(`Total Income,,$${Number(scheduleE?.summary?.totalIncome || 0).toFixed(2)}`);
  lines.push(`Total Expenses,,$${Number(scheduleE?.summary?.totalExpenses || 0).toFixed(2)}`);
  lines.push(`Net Income/Loss,,$${Number(scheduleE?.summary?.netIncomeOrLoss || 0).toFixed(2)}`);

  return lines.join('\n');
}

async function generateLegacy1040ESVouchers(quarterData, taxpayerInfo = {}, taxYear) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const darkText = rgb(0, 0, 0);
  const grayText = rgb(0.35, 0.35, 0.35);
  const lightBg = rgb(0.95, 0.95, 0.95);
  const white = rgb(1, 1, 1);

  const name = buildDraftTaxpayerName(taxpayerInfo);
  const ssn = buildDraftTinLabel(taxpayerInfo);
  const address = taxpayerInfo.mailingStreet || taxpayerInfo.address || '[Mailing street]';
  const cityStateZip = buildDraftCityStateZip(taxpayerInfo);

  for (const quarter of quarterData) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    const paymentAmount = roundCurrency((quarter.remaining || 0) > 0 ? quarter.remaining : quarter.estimatedDue || 0);

    page.drawText('Department of the Treasury  Internal Revenue Service', { x: 50, y, size: 8, font, color: grayText });
    page.drawText('Form 1040-ES', { x: 50, y: y - 22, size: 18, font: fontBold, color: darkText });
    page.drawText(String(taxYear), { x: 525, y: y - 18, size: 16, font: fontBold, color: darkText });
    page.drawText(`Estimated Tax Payment Voucher  Quarter ${quarter.quarter}`, { x: 50, y: y - 40, size: 9, font, color: grayText });

    y = 675;
    page.drawRectangle({ x: 50, y: y - 10, width: 512, height: 270, borderColor: darkText, borderWidth: 1.25 });
    page.drawRectangle({ x: 50, y: y - 10, width: 512, height: 18, color: darkText });
    page.drawText(`Calendar year ${taxYear}  File by ${quarter.dueDate || 'see instructions'}`, { x: 58, y: y - 5, size: 8, font: fontBold, color: white });
    page.drawText(`Voucher ${quarter.quarter}`, { x: 500, y: y - 5, size: 8, font: fontBold, color: white });

    y -= 32;
    drawFormField(page, { x: 60, y, width: 300, label: 'Name(s) shown on return', value: name, font, fontBold });
    drawFormField(page, { x: 372, y, width: 180, label: 'Identifying number', value: ssn, font, fontBold });
    y -= 42;
    drawFormField(page, { x: 60, y, width: 492, label: 'Address', value: address, font, fontBold });
    y -= 42;
    drawFormField(page, { x: 60, y, width: 492, label: 'City, state, ZIP code', value: cityStateZip, font, fontBold });
    y -= 48;

    page.drawRectangle({ x: 60, y: y - 10, width: 492, height: 38, color: lightBg, borderColor: darkText, borderWidth: 1 });
    page.drawText('Amount of estimated tax you are paying by check or money order', { x: 68, y: y + 8, size: 9, font, color: darkText });
    page.drawText(`$${formatFormCurrency(paymentAmount)}`, { x: 450, y: y + 6, size: 14, font: fontBold, color: darkText });
    y -= 62;

    page.drawText('For your records', { x: 60, y, size: 9, font: fontBold, color: darkText });
    y -= 18;

    const breakdown = quarter.breakdown || {};
    const items = [
      ['Quarter period', `${breakdown.period?.start || ''} to ${breakdown.period?.end || ''}`],
      ['Estimated due', `$${formatFormCurrency(quarter.estimatedDue || 0)}`],
      ['Paid to date', `$${formatFormCurrency(quarter.paid || 0)}`],
      ['Remaining to pay', `$${formatFormCurrency(paymentAmount)}`],
      ['Rental income (quarter)', `$${formatFormCurrency(breakdown.income || 0)}`],
      ['Rental expenses (quarter)', `$${formatFormCurrency(breakdown.expenses || 0)}`],
      ['Net rental income', `$${formatFormCurrency(breakdown.netIncome || 0)}`],
      ['Annualized income', `$${formatFormCurrency(breakdown.annualizedIncome || 0)}`],
      ['Annualized taxable income', `$${formatFormCurrency(breakdown.annualizedTaxable || 0)}`],
      ['Federal / state tax', `$${formatFormCurrency(breakdown.federal || 0)} / $${formatFormCurrency(breakdown.state || 0)}`],
    ];

    for (const [label, value] of items) {
      const shaded = label === 'Remaining to pay';
      page.drawRectangle({ x: 60, y: y - 4, width: 492, height: 16, borderColor: darkText, borderWidth: 0.5, color: shaded ? lightBg : white });
      page.drawText(label, { x: 68, y, size: 8, font: shaded ? fontBold : font, color: darkText });
      page.drawText(value, { x: 400, y, size: 8, font: fontBold, color: darkText });
      y -= 16;
    }

    page.drawLine({ start: { x: 45, y: 40 }, end: { x: 565, y: 40 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    page.drawText('Draft IRS-style 1040-ES voucher generated from current assumptions. Verify mailing address and payment before filing.', { x: 50, y: 28, size: 7, font, color: grayText });
    page.drawText(`Generated by HouseYield — ${new Date().toLocaleDateString()}`, { x: 50, y: 18, size: 7, font, color: grayText });
  }

  return await doc.save();
}

async function generateOfficial1040ESVouchers(quarterData, taxpayerInfo = {}, taxYear) {
  const doc = await loadPdfTemplate(resolveIrsFormTemplateUrl('1040es', taxYear));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  fill1040ESRecordPage(form, quarterData);
  fill1040ESVoucherPages(form, quarterData, taxpayerInfo);
  form.updateFieldAppearances(font);
  form.flatten();

  for (let pageIndex = doc.getPageCount() - 1; pageIndex >= 0; pageIndex -= 1) {
    const keepPage = pageIndex >= 12 && pageIndex <= 14;
    if (!keepPage) {
      doc.removePage(pageIndex);
    }
  }

  return await doc.save();
}

export async function detect1040EsPdfRenderer(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes);
  const pageCount = doc.getPageCount();
  if (pageCount === 3) {
    return 'official-irs-template';
  }
  if (pageCount === 4) {
    return 'legacy-draft';
  }
  return 'unknown';
}

export async function detect1099NecPdfRenderer(pdfBytes, formCount = 0) {
  const doc = await PDFDocument.load(pdfBytes);
  const pageCount = doc.getPageCount();
  if (formCount > 0 && pageCount === formCount * 6) {
    return 'official-irs-template';
  }
  if (formCount > 0 && pageCount === formCount) {
    return 'legacy-draft';
  }
  return 'unknown';
}

export async function generate1040ESVouchers(quarterData, taxpayerInfo = {}, taxYear) {
  try {
    return await generateOfficial1040ESVouchers(quarterData, taxpayerInfo, taxYear);
  } catch (error) {
    console.error('1040-ES official IRS template fill failed; falling back to legacy draft renderer.', error);
    return generateLegacy1040ESVouchers(quarterData, taxpayerInfo, taxYear);
  }
}

async function generateOfficial1099NecFormsPDF(forms1099 = [], payerInfo = {}, taxYear) {
  if (!Array.isArray(forms1099) || forms1099.length === 0) {
    throw new Error('No 1099-NEC forms were provided for export.');
  }

  const output = await PDFDocument.create();
  const templateUrl = resolveIrsFormTemplateUrl('1099nec', taxYear);

  for (const form1099 of forms1099) {
    const doc = await loadPdfTemplate(templateUrl);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();

    fill1099NecOfficialForm(form, form1099, payerInfo, taxYear);
    form.updateFieldAppearances(font);
    form.flatten();

    const pageIndexes = Array.from({ length: doc.getPageCount() }, (_, index) => index);
    const copiedPages = await output.copyPages(doc, pageIndexes);
    copiedPages.forEach((page) => output.addPage(page));
  }

  return await output.save();
}

export async function generate1099NecFormsPDF(forms1099 = [], payerInfo = {}, taxYear) {
  try {
    return await generateOfficial1099NecFormsPDF(forms1099, payerInfo, taxYear);
  } catch (error) {
    console.error('1099-NEC official IRS template fill failed; falling back to legacy draft renderer.', error);
    return generateDraft1099FormsPDF(forms1099, payerInfo, taxYear);
  }
}

export async function generateDraft1099FormsPDF(forms1099 = [], payerInfo = {}, taxYear) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.35, 0.35, 0.35);
  const lightGray = rgb(0.95, 0.95, 0.95);
  const white = rgb(1, 1, 1);

  const payerName = buildDraftTaxpayerName(payerInfo);
  const payerTin = buildDraftTinLabel(payerInfo);
  const payerStreet = payerInfo.mailingStreet || payerInfo.address || '[Payer street]';
  const payerCityStateZip = buildDraftCityStateZip(payerInfo);
  const normalizedYear = Number.isFinite(Number(taxYear)) ? Number(taxYear) : new Date().getFullYear();

  for (const form of forms1099) {
    const page = doc.addPage([612, 792]);
    let y = 752;
    const recipientName = String(form.recipientName || '').trim() || '[Recipient name]';
    const recipientTin = String(form.recipientTIN || '').trim() || '___-__-____';
    const recipientAddress = String(form.recipientAddress || '').trim() || '[Recipient address]';
    const amount = roundCurrency(form.amount || 0);
    const missingInfo = Array.isArray(form.missingInfo) ? form.missingInfo : [];

    page.drawText('Department of the Treasury  Internal Revenue Service', { x: 50, y, size: 8, font, color: gray });
    page.drawText(String(form.formType || '1099-NEC'), { x: 50, y: y - 22, size: 22, font: fontBold, color: black });
    page.drawText(String(normalizedYear), { x: 520, y: y - 18, size: 16, font: fontBold, color: black });
    page.drawText('Draft contractor information return prepared from the HouseYield ledger', { x: 50, y: y - 40, size: 9, font, color: gray });

    y = 672;
    page.drawRectangle({ x: 50, y: y - 10, width: 512, height: 20, color: black });
    page.drawText('PAYER', { x: 58, y: y - 4, size: 8, font: fontBold, color: white });
    drawFormField(page, { x: 50, y: y - 22, width: 330, label: 'Payer name', value: payerName, font, fontBold });
    drawFormField(page, { x: 392, y: y - 22, width: 170, label: 'Payer TIN', value: payerTin, font, fontBold });
    drawFormField(page, { x: 50, y: y - 64, width: 512, label: 'Payer address', value: payerStreet, font, fontBold });
    drawFormField(page, { x: 50, y: y - 106, width: 512, label: 'Payer city, state, ZIP', value: payerCityStateZip, font, fontBold });

    y = 500;
    page.drawRectangle({ x: 50, y: y - 10, width: 512, height: 20, color: black });
    page.drawText('RECIPIENT', { x: 58, y: y - 4, size: 8, font: fontBold, color: white });
    drawFormField(page, { x: 50, y: y - 22, width: 330, label: 'Recipient name', value: recipientName, font, fontBold });
    drawFormField(page, { x: 392, y: y - 22, width: 170, label: 'Recipient TIN', value: recipientTin, font, fontBold });
    drawFormField(page, { x: 50, y: y - 64, width: 512, label: 'Recipient address', value: recipientAddress, font, fontBold });

    y = 350;
    page.drawRectangle({ x: 50, y: y - 12, width: 512, height: 88, borderColor: black, borderWidth: 1.25 });
    page.drawText('BOX AMOUNTS', { x: 58, y: y + 56, size: 8, font: fontBold, color: gray });
    page.drawRectangle({ x: 60, y: y + 2, width: 220, height: 42, color: lightGray, borderColor: black, borderWidth: 1 });
    page.drawText(`Box ${form.box || 1} - Nonemployee compensation`, { x: 70, y: y + 28, size: 8, font, color: black });
    page.drawText(`$${formatFormCurrency(amount)}`, { x: 70, y: y + 10, size: 18, font: fontBold, color: black });

    page.drawRectangle({ x: 300, y: y + 2, width: 252, height: 42, color: white, borderColor: black, borderWidth: 1 });
    page.drawText('Readiness', { x: 310, y: y + 28, size: 8, font, color: gray });
    page.drawText(
      missingInfo.length === 0
        ? `Ready to file · W-9 ${form.w9OnFile ? 'on file' : 'not confirmed'}`
        : `Missing: ${missingInfo.join(', ')}`,
      { x: 310, y: y + 10, size: 10, font: fontBold, color: black },
    );

    y = 238;
    page.drawText('Preparation notes', { x: 50, y, size: 9, font: fontBold, color: black });
    const notes = [
      'This is a draft 1099 prepared from contractor payments classified in the rental ledger.',
      'Review payee classification, TIN, address, threshold applicability, and state filing requirements before furnishing or e-filing.',
      missingInfo.length > 0 ? `Current blockers: ${missingInfo.join(', ')}.` : 'No current filing blockers were flagged for this draft form.',
    ];
    notes.forEach((line, index) => {
      page.drawText(line, { x: 58, y: y - 18 - (index * 16), size: 8, font, color: gray });
    });

    page.drawLine({ start: { x: 45, y: 40 }, end: { x: 565, y: 40 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    page.drawText('Draft IRS-style 1099 prepared by HouseYield for review before furnishing to the contractor or filing with the IRS.', { x: 50, y: 28, size: 7, font, color: gray });
    page.drawText(`Generated ${new Date().toLocaleDateString()} · ${recipientName}`, { x: 50, y: 18, size: 7, font, color: gray });
  }

  return await doc.save();
}

export default {
  generateTXF,
  generateScheduleEPDF,
  generateDetailedCSV,
  generateScheduleESummaryCSV,
  generate1040ESVouchers,
  generate1099NecFormsPDF,
  generateDraft1099FormsPDF,
  TXF_CODES,
};