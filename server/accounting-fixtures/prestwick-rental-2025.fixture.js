const FIXTURE_NAME = 'prestwick-rental-2025';
const TAX_YEAR = 2025;
const PROPERTY_ID = 'fixture-prestwick-rental-2025';

const accounts = {
  '1000': { name: 'Operating Cash', type: 'ASSET' },
  '2100': { name: 'Security Deposits Liability', type: 'LIABILITY' },
  '2500': { name: 'Mortgage Payable', type: 'LIABILITY' },
  '3000': { name: "Owner's Equity", type: 'EQUITY' },
  '4000': { name: 'Rent Income', type: 'REVENUE' },
  '4100': { name: 'Late Fees', type: 'REVENUE' },
  '5000': { name: 'Repairs', type: 'EXPENSE' },
  '5100': { name: 'Utilities', type: 'EXPENSE' },
  '5200': { name: 'Insurance', type: 'EXPENSE' },
  '5300': { name: 'Property Taxes', type: 'EXPENSE' },
  '5400': { name: 'Management Fees', type: 'EXPENSE' },
  '5500': { name: 'Mortgage Interest', type: 'EXPENSE' },
  '5600': { name: 'HOA Fees', type: 'EXPENSE' },
  '5700': { name: 'Landscaping', type: 'EXPENSE' },
  '5750': { name: 'Pest Control', type: 'EXPENSE' },
  '5800': { name: 'Cleaning & Maintenance', type: 'EXPENSE' },
  '5900': { name: 'Legal & Professional', type: 'EXPENSE' },
  '6000': { name: 'Advertising', type: 'EXPENSE' },
};

const vendors = [
  {
    id: 'vendor-prosperity-home-mortgage',
    name: 'Prosperity Home Mortgage LLC',
    vendorType: 'corporation',
    ein: '52-1000001',
    address: '200 Loan Plaza',
    city: 'Rockville',
    state: 'MD',
    zip: '20850',
    w9OnFile: true,
  },
  {
    id: 'vendor-travelers-insurance',
    name: 'Travelers Insurance',
    vendorType: 'corporation',
    ein: '06-0566090',
    address: '1 Tower Square',
    city: 'Hartford',
    state: 'CT',
    zip: '06183',
    w9OnFile: true,
  },
  {
    id: 'vendor-fallsreach-hoa',
    name: 'Fallsreach HOA',
    vendorType: 'corporation',
    ein: '52-1000002',
    address: '14 Community Circle',
    city: 'Potomac',
    state: 'MD',
    zip: '20854',
    w9OnFile: true,
  },
  {
    id: 'vendor-northwind-pm',
    name: 'Northwind Property Management',
    vendorType: 'corporation',
    ein: '11-1111111',
    address: '900 Main Street',
    city: 'Bethesda',
    state: 'MD',
    zip: '20814',
    w9OnFile: true,
  },
  {
    id: 'vendor-potomac-home-services',
    name: 'Potomac Home Services',
    vendorType: 'individual',
    ein: '12-3456789',
    address: '77 Tradesman Lane',
    city: 'Rockville',
    state: 'MD',
    zip: '20852',
    w9OnFile: true,
    w9: {
      taxpayerName: 'Potomac Home Services',
      federalTaxClassification: 'individual',
      tinType: 'EIN',
      tin: '12-3456789',
      address: '77 Tradesman Lane',
      city: 'Rockville',
      state: 'MD',
      zip: '20852',
      signedDate: '2025-01-15',
      source: 'fixture-simulated-w9',
    },
  },
  {
    id: 'vendor-potomac-green',
    name: 'Potomac Green Landscaping LLC',
    vendorType: 'llc',
    ein: '52-7654321',
    address: '42 Garden Road',
    city: 'Potomac',
    state: 'MD',
    zip: '20854',
    w9OnFile: true,
    w9: {
      taxpayerName: 'Potomac Green Landscaping LLC',
      federalTaxClassification: 'llc',
      llcTaxClassification: 'partnership',
      tinType: 'EIN',
      tin: '52-7654321',
      address: '42 Garden Road',
      city: 'Potomac',
      state: 'MD',
      zip: '20854',
      signedDate: '2025-01-16',
      source: 'fixture-simulated-w9',
    },
  },
  {
    id: 'vendor-senate-pest',
    name: 'Senate Pest Control',
    vendorType: 'corporation',
    ein: '52-1000003',
    address: '10 Service Park',
    city: 'Gaithersburg',
    state: 'MD',
    zip: '20878',
    w9OnFile: true,
  },
  {
    id: 'vendor-marketready-cleaning',
    name: 'MarketReady Cleaning Co',
    vendorType: 'llc',
    ein: '52-1000004',
    address: '88 Clean Sweep Way',
    city: 'Potomac',
    state: 'MD',
    zip: '20854',
    w9OnFile: true,
  },
  {
    id: 'vendor-hillcrest-cpa',
    name: 'Hillcrest CPA Group',
    vendorType: 'llc',
    ein: '52-1000005',
    address: '600 Ledger Ave',
    city: 'Bethesda',
    state: 'MD',
    zip: '20816',
    w9OnFile: true,
  },
  {
    id: 'vendor-montgomery-county-tax',
    name: 'Montgomery County Tax Office',
    vendorType: 'corporation',
    ein: '52-6000000',
    address: '255 Rockville Pike',
    city: 'Rockville',
    state: 'MD',
    zip: '20850',
    w9OnFile: true,
  },
  {
    id: 'vendor-wssc-water',
    name: 'WSSC Water',
    vendorType: 'corporation',
    ein: '52-1000006',
    address: '14501 Sweitzer Lane',
    city: 'Laurel',
    state: 'MD',
    zip: '20707',
    w9OnFile: true,
  },
  {
    id: 'vendor-pepco',
    name: 'Pepco',
    vendorType: 'corporation',
    ein: '52-0895600',
    address: '701 Ninth Street NW',
    city: 'Washington',
    state: 'DC',
    zip: '20068',
    w9OnFile: true,
  },
];

const property = {
  id: PROPERTY_ID,
  name: 'Prestwick Single-Family Rental',
  address: '11822 Prestwick Rd, Potomac, MD 20854',
  state: 'MD',
  purchaseDate: '2022-05-04',
  purchasePrice: 785000,
  landValue: 318000,
  improvementValue: 467000,
  description: 'Residential Rental Property',
  usefulLifeMonths: 330,
  fairRentalDays: 365,
  personalUseDays: 0,
  metadata: {
    propertyType: 'Single Family Rental',
    mortgageAmount: 595000,
    mortgageRate: 5.27,
    mortgageTermMonths: 360,
    mortgageDate: '2022-05-04',
    attomAVM: 1081222,
    attomTaxAmount: 8876.17,
  },
};

const sampleProfile = {
  property: {
    label: 'Prestwick Single-Family Rental',
    address: '11822 Prestwick Rd',
    location: 'Potomac, MD 20854',
    propertyType: 'Single Family Rental',
  },
  dashboard: {
    summary: {
      address: property.address,
      avm_value: 1081222,
      avm_low: 994724,
      avm_high: 1167719,
      rental_avm: 5250,
      rental_avm_low: 5000,
      rental_avm_high: 5450,
      assessed_value: 910400,
      last_sale_date: '2022-05-04',
      last_sale_price: 785000,
      price_per_sqft: 457,
      living_sqft: 2368,
      building_sqft: 2368,
      beds: null,
      baths: 3,
      year_built: 1968,
      age: 58,
      image: 'https://maps.googleapis.com/maps/api/streetview?size=800x450&location=11822+Prestwick+Rd+Potomac+MD+20854&fov=85&pitch=5',
    },
    tax_history: [
      { year: 2021, tax_amount: 7488 },
      { year: 2022, tax_amount: 7594 },
      { year: 2023, tax_amount: 7648 },
      { year: 2024, tax_amount: 7712 },
      { year: 2025, tax_amount: 8876.17 },
    ],
    avm_history: [
      { date: '2025-01-15', value: 981200 },
      { date: '2025-04-15', value: 1022400 },
      { date: '2025-07-15', value: 987900 },
      { date: '2025-10-15', value: 985400 },
      { date: '2026-01-15', value: 1081222 },
    ],
  },
  attomData: {
    address: {
      oneLine: property.address,
      line1: '11822 Prestwick Rd',
      line2: 'Potomac, MD 20854',
      locality: 'Potomac',
      countrySubd: 'MD',
      postal1: '20854',
      country: 'US',
    },
    summary: {
      propType: 'SFR',
      propSubType: 'Single Family Residence',
      yearBuilt: 1968,
      bedrooms: null,
      bathrooms: 3,
      livingSize: 2368,
      lotSize: 12632,
      stories: 2,
    },
    assessment: {
      assessed: {
        assdTtlValue: 910400,
        assdLandValue: 318000,
        assdImprValue: 592400,
      },
      market: {
        mktTtlValue: 1081222,
        mktLandValue: 356000,
        mktImprValue: 725222,
      },
      tax: {
        taxAmt: 8876.17,
        taxYear: 2025,
      },
    },
    avm: {
      amount: { value: 1081222, low: 994724, high: 1167719 },
      eventDate: '2026-01-15',
      confidence: 84,
      changeLastYear: 10.2,
      changeLastYearValue: 100022,
    },
    rentalAvm: {
      amount: { value: 5250, low: 5000, high: 5450 },
      eventDate: '2026-01-15',
      rentYield: 5.82,
    },
    saleHistory: [
      {
        saleDate: '2022-05-04',
        salePrice: 785000,
        saleType: 'Arms Length',
        deedType: 'Warranty Deed',
      },
    ],
    mortgage: {
      amount: 595000,
      lender: 'Prosperity Home Mortgage LLC',
      rate: 5.27,
      rateType: 'Fixed',
      term: 360,
      dueDate: '2052-06-01',
      loanType: 'Conventional',
      date: '2022-05-04',
    },
  },
  defaults: {
    isInterestOnly: false,
    extraPrincipal: 0,
    closingCosts: 19625,
    initialRehab: 12500,
    expenseInflation: 3,
    taxInflation: 3,
    appreciationRate: 4.2,
    rentGrowth: 3,
    vacancyRate: 3,
  },
};

const entries = [];
const analyticsTransactions = [];

function accountName(code) {
  return accounts[code].name;
}

function pushAnalyticsTransaction({ id, date, amount, memo, vendor, source }) {
  analyticsTransactions.push({
    id,
    date,
    amount,
    description: memo,
    vendor,
    source,
  });
}

function addOpeningBalance({ id, date, amount }) {
  entries.push({
    id,
    date,
    memo: 'Opening operating cash balance',
    type: 'equity',
    amount,
    propertyId: PROPERTY_ID,
    lines: [
      { accountCode: '1000', accountName: accountName('1000'), amount, dc: 'D', propertyId: PROPERTY_ID },
      { accountCode: '3000', accountName: accountName('3000'), amount, dc: 'C', propertyId: PROPERTY_ID },
    ],
  });
}

function addSecurityDeposit({ id, date, amount, vendor }) {
  entries.push({
    id,
    date,
    memo: 'Security deposit received for tenant move-in',
    type: 'liability',
    amount,
    vendor,
    propertyId: PROPERTY_ID,
    lines: [
      { accountCode: '1000', accountName: accountName('1000'), amount, dc: 'D', propertyId: PROPERTY_ID },
      { accountCode: '2100', accountName: accountName('2100'), amount, dc: 'C', propertyId: PROPERTY_ID },
    ],
  });
}

function addIncome({ id, date, memo, amount, vendor, accountCode = '4000', source = 'STRIPE' }) {
  entries.push({
    id,
    date,
    memo,
    type: 'income',
    category: accountName(accountCode),
    amount,
    vendor,
    propertyId: PROPERTY_ID,
    lines: [
      { accountCode: '1000', accountName: accountName('1000'), amount, dc: 'D', propertyId: PROPERTY_ID },
      { accountCode, accountName: accountName(accountCode), amount, dc: 'C', propertyId: PROPERTY_ID, memo },
    ],
  });

  pushAnalyticsTransaction({ id, date, amount, memo, vendor, source });
}

function addExpense({ id, date, memo, amount, vendor, accountCode, source = 'BANK' }) {
  entries.push({
    id,
    date,
    memo,
    type: 'expense',
    category: accountName(accountCode),
    amount,
    vendor,
    propertyId: PROPERTY_ID,
    lines: [
      { accountCode, accountName: accountName(accountCode), amount, dc: 'D', propertyId: PROPERTY_ID, memo },
      { accountCode: '1000', accountName: accountName('1000'), amount, dc: 'C', propertyId: PROPERTY_ID },
    ],
  });

  pushAnalyticsTransaction({ id, date, amount: -amount, memo, vendor, source });
}

addOpeningBalance({ id: 'opening-balance', date: '2025-01-01', amount: 30000 });
addSecurityDeposit({ id: 'security-deposit', date: '2025-01-02', amount: 5100, vendor: 'Prestwick Tenant' });

[
  ['2025-01-03', 5100, 'Stripe payout - Prestwick tenant January rent'],
  ['2025-02-03', 5100, 'Stripe payout - Prestwick tenant February rent'],
  ['2025-03-03', 5100, 'Stripe payout - Prestwick tenant March rent'],
  ['2025-04-03', 5100, 'Stripe payout - Prestwick tenant April rent'],
  ['2025-05-03', 5100, 'Stripe payout - Prestwick tenant May rent'],
  ['2025-06-03', 5100, 'Stripe payout - Prestwick tenant June rent'],
  ['2025-07-03', 5250, 'Stripe payout - Prestwick tenant July rent increase'],
  ['2025-08-03', 5250, 'Stripe payout - Prestwick tenant August rent'],
  ['2025-09-03', 5250, 'Stripe payout - Prestwick tenant September rent'],
  ['2025-10-03', 5250, 'Stripe payout - Prestwick tenant October rent'],
  ['2025-11-03', 5250, 'Stripe payout - Prestwick tenant November rent'],
  ['2025-12-03', 5250, 'Stripe payout - Prestwick tenant December rent'],
].forEach(([date, amount, memo], index) => {
  addIncome({
    id: `rent-${index + 1}`,
    date,
    memo,
    amount,
    vendor: 'Prestwick Tenant',
  });
});

addIncome({
  id: 'late-fee-november',
  date: '2025-11-06',
  memo: 'Late fee - Prestwick tenant November',
  amount: 100,
  vendor: 'Prestwick Tenant',
  accountCode: '4100',
});

[
  '2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01',
  '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01',
].forEach((date, index) => {
  addExpense({
    id: `mortgage-interest-${index + 1}`,
    date,
    memo: 'Monthly mortgage interest payment',
    amount: 1800,
    vendor: 'Prosperity Home Mortgage LLC',
    accountCode: '5500',
  });
  addExpense({
    id: `management-fee-${index + 1}`,
    date: date.replace(/-01$/, '-07'),
    memo: 'Northwind monthly property management fee',
    amount: 275,
    vendor: 'Northwind Property Management',
    accountCode: '5400',
  });
  addExpense({
    id: `insurance-${index + 1}`,
    date: date.replace(/-01$/, '-08'),
    memo: 'Travelers landlord insurance premium',
    amount: 190,
    vendor: 'Travelers Insurance',
    accountCode: '5200',
  });
  addExpense({
    id: `hoa-${index + 1}`,
    date: date.replace(/-01$/, '-05'),
    memo: 'Fallsreach HOA monthly dues',
    amount: 145,
    vendor: 'Fallsreach HOA',
    accountCode: '5600',
  });
});

[
  ['2025-01-16', 64.12, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-02-14', 72.84, 'Pepco exterior lighting service', 'Pepco'],
  ['2025-03-15', 64.77, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-04-15', 73.11, 'Pepco exterior lighting service', 'Pepco'],
  ['2025-05-15', 64.55, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-06-16', 75.36, 'Pepco exterior lighting service', 'Pepco'],
  ['2025-07-18', 64.88, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-08-15', 72.48, 'Pepco exterior lighting service', 'Pepco'],
  ['2025-09-17', 65.09, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-10-16', 73.66, 'Pepco exterior lighting service', 'Pepco'],
  ['2025-11-14', 65.42, 'WSSC Water - owner sewer share', 'WSSC Water'],
  ['2025-12-18', 74.03, 'Pepco exterior lighting service', 'Pepco'],
].forEach(([date, amount, memo, vendor], index) => {
  addExpense({
    id: `utilities-${index + 1}`,
    date,
    memo,
    amount,
    vendor,
    accountCode: '5100',
  });
});

[
  ['2025-04-10', 2219.04],
  ['2025-07-10', 2219.04],
  ['2025-10-10', 2219.04],
  ['2025-12-10', 2219.05],
].forEach(([date, amount], index) => {
  addExpense({
    id: `property-tax-${index + 1}`,
    date,
    memo: 'Montgomery County property tax installment',
    amount,
    vendor: 'Montgomery County Tax Office',
    accountCode: '5300',
  });
});

[
  '2025-03-20', '2025-04-21', '2025-05-22', '2025-06-24',
  '2025-07-22', '2025-08-23', '2025-09-21', '2025-10-24',
].forEach((date, index) => {
  addExpense({
    id: `landscaping-${index + 1}`,
    date,
    memo: 'Potomac Green seasonal landscaping service',
    amount: 95,
    vendor: 'Potomac Green Landscaping LLC',
    accountCode: '5700',
  });
});

['2025-03-28', '2025-06-27', '2025-09-28', '2025-12-27'].forEach((date, index) => {
  addExpense({
    id: `pest-control-${index + 1}`,
    date,
    memo: 'Senate Pest Control quarterly treatment',
    amount: 130,
    vendor: 'Senate Pest Control',
    accountCode: '5750',
  });
});

[
  ['2025-02-22', 325, 'Potomac Home Services garbage disposal repair'],
  ['2025-05-18', 480, 'Potomac Home Services HVAC spring service and refrigerant top-off'],
  ['2025-08-19', 650, 'Potomac Home Services gutter and roof clean-out'],
  ['2025-10-22', 410, 'Potomac Home Services appliance service call'],
  ['2025-12-22', 720, 'Potomac Home Services touch-up and drywall repair'],
].forEach(([date, amount, memo], index) => {
  addExpense({
    id: `repair-${index + 1}`,
    date,
    memo,
    amount,
    vendor: 'Potomac Home Services',
    accountCode: '5000',
  });
});

addExpense({
  id: 'cleaning-annual',
  date: '2025-01-06',
  memo: 'MarketReady annual deep clean before tenant move-in',
  amount: 210,
  vendor: 'MarketReady Cleaning Co',
  accountCode: '5800',
});

addExpense({
  id: 'legal-cpa-review',
  date: '2025-02-25',
  memo: 'Hillcrest CPA tax projection and compliance review',
  amount: 350,
  vendor: 'Hillcrest CPA Group',
  accountCode: '5900',
});

addExpense({
  id: 'advertising-renewal',
  date: '2025-01-10',
  memo: 'Listing photography and lease renewal advertising',
  amount: 120,
  vendor: 'Zillow Rentals',
  accountCode: '6000',
  source: 'CARD',
});

const ACCOUNTING_FIXTURE = {
  fixtureName: FIXTURE_NAME,
  taxYear: TAX_YEAR,
  accounts,
  properties: [property],
  vendors,
  entries,
  estimatedTaxPayments: [],
  taxProjection: {
    asOfDate: '2025-12-31',
    assumptions: {
      filingStatus: 'married_filing_jointly',
      otherIncome: 185000,
      otherDeductions: 0,
      taxCredits: 2000,
      withholdingYtd: 24000,
      homeState: 'MD',
      priorYearTotalTax: 36000,
      priorYearAdjustedGrossIncome: 192000,
      rentalServiceHours: 260,
    },
  },
  personalTaxProfile: {
    primaryName: 'Alex Practice',
    spouseName: 'Jordan Practice',
    filingStatus: 'married_filing_jointly',
    tinLast4: '1234',
    mailingStreet: '123 Ledger Lane',
    mailingCity: 'Baltimore',
    mailingState: 'MD',
    mailingZip: '21201',
    priorYearTotalTax: 36000,
    priorYearAdjustedGrossIncome: 192000,
    otherDeductions: 0,
    taxCredits: 2000,
    rentalServiceHours: 260,
  },
  personalTaxDocuments: [
    {
      id: 'fixture-w2-alex-practice-2025',
      documentType: 'tax_form',
      documentSubtype: 'w2',
      taxYear: TAX_YEAR,
      employerOrPayorName: 'Fixture Analytics Inc.',
      employeeName: 'Alex Practice',
      wages: 120000,
      federalWithholding: 16000,
      socialSecurityWages: 120000,
      medicareWages: 120000,
      stateEntries: [
        { state: 'MD', stateWages: 120000, withholding: 7200 },
      ],
      extractionStatus: 'parsed',
      reviewerStatus: 'confirmed',
      source: 'fixture-simulated-w2',
    },
    {
      id: 'fixture-w2-jordan-practice-2025',
      documentType: 'tax_form',
      documentSubtype: 'w2',
      taxYear: TAX_YEAR,
      employerOrPayorName: 'Fixture Design Studio LLC',
      employeeName: 'Jordan Practice',
      wages: 65000,
      federalWithholding: 8000,
      socialSecurityWages: 65000,
      medicareWages: 65000,
      stateEntries: [
        { state: 'MD', stateWages: 65000, withholding: 3900 },
      ],
      extractionStatus: 'parsed',
      reviewerStatus: 'confirmed',
      source: 'fixture-simulated-w2',
    },
  ],
  taxFormTruth: {
    scheduleE: {
      line3RentsReceived: 62200,
      line4RoyaltiesReceived: 0,
      line18Depreciation: 16981.82,
      line20TotalExpenses: 60153.30,
      line21IncomeOrLoss: 2046.70,
      line23aTotalRents: 62200,
      line23bTotalRoyalties: 0,
      line23cTotalMortgageInterest: 21600,
      line23dTotalDepreciation: 16981.82,
      line23eTotalExpenses: 60153.30,
      line26TotalIncomeOrLoss: 2046.70,
    },
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
    form1040ES: {
      scenarioSource: 'simulated confirmed W-2s plus Prestwick rental ledger',
      filingStatus: 'married_filing_jointly',
      otherIncome: 185000,
      federalWithholdingYtd: 24000,
      taxCredits: 2000,
      quarters: [
        { quarter: 1, dueDate: '2025-04-15', estimatedDue: 1348.31, paid: 0, remaining: 1348.31 },
        { quarter: 2, dueDate: '2025-06-16', estimatedDue: 1149.15, paid: 0, remaining: 1149.15 },
        { quarter: 3, dueDate: '2025-09-15', estimatedDue: 1103.13, paid: 0, remaining: 1103.13 },
        { quarter: 4, dueDate: '2026-01-15', estimatedDue: 952.98, paid: 0, remaining: 952.98 },
      ],
    },
  },
  sampleProfile,
  analyticsTransactions,
};

export { ACCOUNTING_FIXTURE };
export default ACCOUNTING_FIXTURE;