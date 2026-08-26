export const STATE_TAX_RATES = {
  AL: { name: 'Alabama', rate: 0.05, type: 'flat', note: '5% flat rate on taxable income' },
  AK: { name: 'Alaska', rate: 0, type: 'none', note: 'No state income tax' },
  AZ: { name: 'Arizona', rate: 0.025, type: 'flat', note: '2.5% flat rate (2024+)' },
  AR: { name: 'Arkansas', rate: 0.044, type: 'flat', note: '4.4% top rate (2024+)' },
  CA: {
    name: 'California', rate: 0.133, type: 'graduated',
    note: 'Top marginal rate 13.3%',
    brackets: {
      single: [
        { min: 0, max: 10412, rate: 0.01 },
        { min: 10412, max: 24684, rate: 0.02 },
        { min: 24684, max: 38959, rate: 0.04 },
        { min: 38959, max: 54081, rate: 0.06 },
        { min: 54081, max: 68350, rate: 0.08 },
        { min: 68350, max: 349137, rate: 0.093 },
        { min: 349137, max: 418961, rate: 0.103 },
        { min: 418961, max: 698271, rate: 0.113 },
        { min: 698271, max: 1000000, rate: 0.123 },
        { min: 1000000, max: Infinity, rate: 0.133 }
      ],
      married_filing_jointly: [
        { min: 0, max: 20824, rate: 0.01 },
        { min: 20824, max: 49368, rate: 0.02 },
        { min: 49368, max: 77918, rate: 0.04 },
        { min: 77918, max: 108162, rate: 0.06 },
        { min: 108162, max: 136700, rate: 0.08 },
        { min: 136700, max: 698274, rate: 0.093 },
        { min: 698274, max: 837922, rate: 0.103 },
        { min: 837922, max: 1396542, rate: 0.113 },
        { min: 1396542, max: 1000000, rate: 0.123 },
        { min: 1000000, max: Infinity, rate: 0.133 }
      ]
    }
  },
  CO: { name: 'Colorado', rate: 0.044, type: 'flat', note: '4.4% flat rate (2024+)' },
  CT: { name: 'Connecticut', rate: 0.0699, type: 'graduated', note: 'Top rate 6.99%' },
  DE: { name: 'Delaware', rate: 0.066, type: 'graduated', note: 'Top rate 6.6% over $60K' },
  FL: { name: 'Florida', rate: 0, type: 'none', note: 'No state income tax' },
  GA: { name: 'Georgia', rate: 0.0549, type: 'flat', note: '5.49% flat rate (2024+, transitioning)' },
  HI: { name: 'Hawaii', rate: 0.11, type: 'graduated', note: 'Top rate 11% over $200K' },
  ID: { name: 'Idaho', rate: 0.058, type: 'flat', note: '5.8% flat rate (2023+)' },
  IL: { name: 'Illinois', rate: 0.0495, type: 'flat', note: '4.95% flat rate' },
  IN: { name: 'Indiana', rate: 0.0305, type: 'flat', note: '3.05% flat rate (2024+)' },
  IA: { name: 'Iowa', rate: 0.038, type: 'flat', note: '3.8% flat rate (2026 target)' },
  KS: { name: 'Kansas', rate: 0.057, type: 'graduated', note: 'Top rate 5.7% over $30K' },
  KY: { name: 'Kentucky', rate: 0.04, type: 'flat', note: '4% flat rate (2024+)' },
  LA: { name: 'Louisiana', rate: 0.045, type: 'graduated', note: 'Top rate 4.25% (reformed 2025)' },
  ME: { name: 'Maine', rate: 0.0715, type: 'graduated', note: 'Top rate 7.15% over $58K' },
  MD: { name: 'Maryland', rate: 0.0575, type: 'graduated', note: 'Top rate 5.75% + county tax' },
  MA: { name: 'Massachusetts', rate: 0.05, type: 'flat', note: '5% flat rate (9% surtax on $1M+)' },
  MI: { name: 'Michigan', rate: 0.0425, type: 'flat', note: '4.25% flat rate' },
  MN: { name: 'Minnesota', rate: 0.0985, type: 'graduated', note: 'Top rate 9.85% over $193K' },
  MS: { name: 'Mississippi', rate: 0.047, type: 'flat', note: '4.7% flat rate (2024+, was graduated)' },
  MO: { name: 'Missouri', rate: 0.048, type: 'graduated', note: 'Top rate 4.8% (2024+)' },
  MT: { name: 'Montana', rate: 0.059, type: 'graduated', note: 'Top rate 5.9% (2024+)' },
  NE: { name: 'Nebraska', rate: 0.0584, type: 'graduated', note: 'Top rate 5.84% (decreasing)' },
  NV: { name: 'Nevada', rate: 0, type: 'none', note: 'No state income tax' },
  NH: { name: 'New Hampshire', rate: 0, type: 'none', note: 'No tax on earned/rental income (interest/dividends tax repealed 2025)' },
  NJ: {
    name: 'New Jersey', rate: 0.1075, type: 'graduated',
    note: 'Top rate 10.75% over $1M',
    brackets: {
      single: [
        { min: 0, max: 20000, rate: 0.014 },
        { min: 20000, max: 35000, rate: 0.0175 },
        { min: 35000, max: 40000, rate: 0.035 },
        { min: 40000, max: 75000, rate: 0.05525 },
        { min: 75000, max: 500000, rate: 0.0637 },
        { min: 500000, max: 1000000, rate: 0.0897 },
        { min: 1000000, max: Infinity, rate: 0.1075 }
      ]
    }
  },
  NM: { name: 'New Mexico', rate: 0.059, type: 'graduated', note: 'Top rate 5.9% over $210K' },
  NY: {
    name: 'New York', rate: 0.109, type: 'graduated',
    note: 'Top rate 10.9% over $25M (+ NYC 3.876%)',
    brackets: {
      single: [
        { min: 0, max: 8500, rate: 0.04 },
        { min: 8500, max: 11700, rate: 0.045 },
        { min: 11700, max: 13900, rate: 0.0525 },
        { min: 13900, max: 80650, rate: 0.0585 },
        { min: 80650, max: 215400, rate: 0.0625 },
        { min: 215400, max: 1077550, rate: 0.0685 },
        { min: 1077550, max: 5000000, rate: 0.0965 },
        { min: 5000000, max: 25000000, rate: 0.103 },
        { min: 25000000, max: Infinity, rate: 0.109 }
      ]
    }
  },
  NC: { name: 'North Carolina', rate: 0.045, type: 'flat', note: '4.5% flat rate (2024+)' },
  ND: { name: 'North Dakota', rate: 0.0195, type: 'graduated', note: 'Top rate 1.95% (effective 2025)' },
  OH: { name: 'Ohio', rate: 0.035, type: 'graduated', note: 'Top rate 3.5% over $100K (2024+)' },
  OK: { name: 'Oklahoma', rate: 0.0475, type: 'graduated', note: 'Top rate 4.75% over $7.2K' },
  OR: { name: 'Oregon', rate: 0.099, type: 'graduated', note: 'Top rate 9.9% over $125K' },
  PA: { name: 'Pennsylvania', rate: 0.0307, type: 'flat', note: '3.07% flat rate' },
  RI: { name: 'Rhode Island', rate: 0.0599, type: 'graduated', note: 'Top rate 5.99% over $166.9K' },
  SC: { name: 'South Carolina', rate: 0.064, type: 'graduated', note: 'Top rate 6.4% (decreasing)' },
  SD: { name: 'South Dakota', rate: 0, type: 'none', note: 'No state income tax' },
  TN: { name: 'Tennessee', rate: 0, type: 'none', note: 'No state income tax (Hall Tax repealed 2021)' },
  TX: { name: 'Texas', rate: 0, type: 'none', note: 'No state income tax' },
  UT: { name: 'Utah', rate: 0.0465, type: 'flat', note: '4.65% flat rate (2024+)' },
  VT: { name: 'Vermont', rate: 0.0875, type: 'graduated', note: 'Top rate 8.75% over $229K' },
  VA: { name: 'Virginia', rate: 0.0575, type: 'graduated', note: 'Top rate 5.75% over $17K' },
  WA: { name: 'Washington', rate: 0, type: 'none', note: 'No state income tax (7% capital gains tax exists)' },
  WV: { name: 'West Virginia', rate: 0.0512, type: 'graduated', note: 'Top rate 5.12% (2024+, decreasing)' },
  WI: { name: 'Wisconsin', rate: 0.0765, type: 'graduated', note: 'Top rate 7.65% over $315K' },
  WY: { name: 'Wyoming', rate: 0, type: 'none', note: 'No state income tax' },
  DC: { name: 'District of Columbia', rate: 0.1075, type: 'graduated', note: 'Top rate 10.75% over $1M' }
};

export function getNoTaxStates() {
  return Object.entries(STATE_TAX_RATES)
    .filter(([, info]) => info.rate === 0)
    .map(([code, info]) => ({ code, name: info.name, note: info.note }));
}

export function getStateRateSummary() {
  return Object.entries(STATE_TAX_RATES)
    .map(([code, info]) => ({
      code,
      name: info.name,
      topRate: info.rate,
      topRatePercent: `${(info.rate * 100).toFixed(2)}%`,
      type: info.type
    }))
    .sort((a, b) => b.topRate - a.topRate);
}