/**
 * Assistant Computed Analytics
 *
 * Returns a financial metric together with its full derivation from the same
 * canonical calculation path the pages use (assemblePortfolioComputation), so
 * the assistant can answer "your NOI is $43k: $62.2k rent minus $12.4k taxes,
 * $4.1k insurance, $2.7k repairs…" instead of deflecting to a dashboard card.
 */

import { assemblePortfolioComputation } from './propertyPortfolioAnalysisService.js';

export const ASSISTANT_COMPUTED_METRICS = [
  'noi',
  'cash_flow',
  'cap_rate',
  'gross_rent',
  'operating_expenses',
  'expense_breakdown',
  'debt_service',
  'equity',
  'portfolio_summary',
];

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function normalizeAddress(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchProperty(properties, propertyIdOrAddress) {
  if (!propertyIdOrAddress) return null;
  const needle = normalizeAddress(propertyIdOrAddress);
  return properties.find((property) => property.id === propertyIdOrAddress)
    || properties.find((property) => normalizeAddress(property.address) === needle)
    || properties.find((property) => normalizeAddress(property.address).includes(needle))
    || null;
}

function describeProperty(property, ledgerByProperty) {
  const ledger = ledgerByProperty?.get?.(property.id) || null;
  const ledgerCategories = ledger
    ? Object.entries(ledger.categories || {})
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([category, amount]) => ({ category, amount: round(amount) }))
    : [];

  return {
    id: property.id,
    address: property.address,
    usage: property.usage,
    currentValue: round(property.currentValue),
    mortgageBalance: round(property.mortgageBalance),
    equity: round(property.equity),
    monthlyRent: round(property.monthlyRent),
    monthlyOtherIncome: round(property.monthlyOtherIncome),
    annualGrossIncome: round(property.annualGrossIncome),
    annualOperatingExpenses: round(property.annualOperatingExpenses),
    annualDebtService: round(property.annualDebtService),
    noi: round(property.noi),
    annualNetCashFlow: round(property.annualNetCashFlow),
    capRatePercent: Number.isFinite(property.capRate) ? Number(property.capRate.toFixed(2)) : null,
    ltvPercent: Number.isFinite(property.ltv) ? Number(property.ltv.toFixed(1)) : null,
    interestRate: Number.isFinite(property.interestRate) ? Number(property.interestRate) : null,
    marketRent: Number.isFinite(property.marketRent) ? round(property.marketRent) : null,
    beds: Number.isFinite(property.beds) ? property.beds : null,
    baths: Number.isFinite(property.baths) ? property.baths : null,
    sqft: Number.isFinite(property.sqft) ? property.sqft : null,
    yearBuilt: Number.isFinite(property.yearBuilt) ? property.yearBuilt : null,
    zip: property.zip || null,
    latitude: Number.isFinite(property.latitude) ? property.latitude : null,
    longitude: Number.isFinite(property.longitude) ? property.longitude : null,
    floodZone: property.floodZone || null,
    wildfireRisk: property.wildfireRisk || null,
    ledgerIncome: ledger ? round(ledger.income) : null,
    ledgerExpenses: ledger ? round(ledger.expenses) : null,
    ledgerExpenseCategories: ledgerCategories,
  };
}

function buildDerivationLines(metric, scopeProperties, ledgerByProperty) {
  const lines = [];
  for (const property of scopeProperties) {
    const detail = describeProperty(property, ledgerByProperty);
    switch (metric) {
      case 'noi':
        lines.push(
          `${detail.address}: NOI $${detail.noi.toLocaleString()} = gross income $${detail.annualGrossIncome.toLocaleString()} - operating expenses $${detail.annualOperatingExpenses.toLocaleString()}${detail.ledgerExpenseCategories.length > 0 ? ` (ledger top categories: ${detail.ledgerExpenseCategories.map((entry) => `${entry.category} $${entry.amount.toLocaleString()}`).join(', ')})` : ''}`,
        );
        break;
      case 'cash_flow':
        lines.push(
          `${detail.address}: net cash flow $${detail.annualNetCashFlow.toLocaleString()}/yr = gross income $${detail.annualGrossIncome.toLocaleString()} - operating expenses $${detail.annualOperatingExpenses.toLocaleString()} - debt service $${detail.annualDebtService.toLocaleString()}`,
        );
        break;
      case 'cap_rate':
        lines.push(
          `${detail.address}: cap rate ${detail.capRatePercent ?? '—'}% = NOI $${detail.noi.toLocaleString()} / value $${detail.currentValue.toLocaleString()}`,
        );
        break;
      case 'gross_rent':
        lines.push(
          `${detail.address}: rent $${detail.monthlyRent.toLocaleString()}/mo${detail.monthlyOtherIncome > 0 ? ` + other income $${detail.monthlyOtherIncome.toLocaleString()}/mo` : ''} = $${detail.annualGrossIncome.toLocaleString()}/yr gross`,
        );
        break;
      case 'operating_expenses':
      case 'expense_breakdown':
        lines.push(
          `${detail.address}: operating expenses $${detail.annualOperatingExpenses.toLocaleString()}/yr${detail.ledgerExpenseCategories.length > 0 ? ` — ledger categories: ${detail.ledgerExpenseCategories.map((entry) => `${entry.category} $${entry.amount.toLocaleString()}`).join(', ')}` : ''}`,
        );
        break;
      case 'debt_service':
        lines.push(
          `${detail.address}: debt service $${detail.annualDebtService.toLocaleString()}/yr against balance $${detail.mortgageBalance.toLocaleString()} (LTV ${detail.ltvPercent ?? '—'}%)`,
        );
        break;
      case 'equity':
        lines.push(
          `${detail.address}: equity $${detail.equity.toLocaleString()} = value $${detail.currentValue.toLocaleString()} - mortgage $${detail.mortgageBalance.toLocaleString()}`,
        );
        break;
      default:
        break;
    }
  }
  return lines;
}

export async function computeAssistantAnalytics({
  userId,
  metric = 'portfolio_summary',
  propertyId = null,
  year = null,
  startDate = null,
  endDate = null,
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const normalizedMetric = ASSISTANT_COMPUTED_METRICS.includes(metric) ? metric : 'portfolio_summary';
  const { properties, summary, ledgerByProperty, ledgerEntryCount } = await assemblePortfolioComputation({
    userId,
    year,
    startDate,
    endDate,
  });

  const matchedProperty = matchProperty(properties, propertyId);
  const scopeProperties = matchedProperty ? [matchedProperty] : properties;
  const scopeLabel = matchedProperty ? matchedProperty.address : 'portfolio';
  const taxYear = Number(year) || null;
  const hasYearScope = Number.isFinite(taxYear) || Boolean(startDate) || Boolean(endDate);

  const totals = {
    grossIncome: round(scopeProperties.reduce((sum, property) => sum + property.annualGrossIncome, 0)),
    operatingExpenses: round(scopeProperties.reduce((sum, property) => sum + property.annualOperatingExpenses, 0)),
    debtService: round(scopeProperties.reduce((sum, property) => sum + property.annualDebtService, 0)),
    noi: round(scopeProperties.reduce((sum, property) => sum + property.noi, 0)),
    netCashFlow: round(scopeProperties.reduce((sum, property) => sum + property.annualNetCashFlow, 0)),
    totalValue: round(scopeProperties.reduce((sum, property) => sum + property.currentValue, 0)),
    totalEquity: round(scopeProperties.reduce((sum, property) => sum + property.equity, 0)),
    totalMortgageBalance: round(scopeProperties.reduce((sum, property) => sum + property.mortgageBalance, 0)),
    ledgerIncome: round(scopeProperties.reduce((sum, property) => {
      const ledger = ledgerByProperty?.get?.(property.id);
      return sum + Number(ledger?.income || 0);
    }, 0)),
  };

  // Year-scoped gross_rent must use posted Azure ledger income, not modeled monthlyRent × 12.
  const grossRentValue = (normalizedMetric === 'gross_rent' && hasYearScope && totals.ledgerIncome > 0)
    ? totals.ledgerIncome
    : totals.grossIncome;

  const valueByMetric = {
    noi: totals.noi,
    cash_flow: totals.netCashFlow,
    cap_rate: totals.totalValue > 0 ? Number(((totals.noi / totals.totalValue) * 100).toFixed(2)) : null,
    gross_rent: grossRentValue,
    operating_expenses: totals.operatingExpenses,
    expense_breakdown: totals.operatingExpenses,
    debt_service: totals.debtService,
    equity: totals.totalEquity,
    portfolio_summary: totals.totalValue,
  };

  const derivation = buildDerivationLines(normalizedMetric, scopeProperties, ledgerByProperty);
  if (normalizedMetric === 'gross_rent' && hasYearScope && totals.ledgerIncome > 0) {
    derivation.unshift(
      `${scopeLabel}: ${taxYear || 'selected period'} posted rental/ledger income $${totals.ledgerIncome.toLocaleString()} (Azure bookkeeping — not modeled annualized rent)`,
    );
  }

  return {
    ok: true,
    metric: normalizedMetric,
    scope: scopeLabel,
    propertyMatched: matchedProperty ? matchedProperty.address : null,
    year: taxYear,
    value: valueByMetric[normalizedMetric] ?? null,
    totals: {
      ...totals,
      grossIncome: grossRentValue,
      modeledGrossIncome: totals.grossIncome,
    },
    derivation,
    perProperty: scopeProperties.map((property) => describeProperty(property, ledgerByProperty)),
    dataSources: {
      propertyCount: properties.length,
      ledgerEntryCount,
      portfolioSummary: summary,
      grossRentSource: (normalizedMetric === 'gross_rent' && hasYearScope && totals.ledgerIncome > 0)
        ? 'azure_ledger_posted_income'
        : 'modeled_monthly_rent_annualized',
      sources: [
        'Firestore owner properties scoped by authenticated userId',
        'Azure bookkeeping ledger scoped by authenticated userId',
        'Canonical portfolio computation shared with owner-facing pages',
      ],
    },
    generatedAt: new Date().toISOString(),
  };
}

export function getAssistantComputedAnalyticsToolDefinition() {
  return {
    type: 'function',
    name: 'compute_portfolio_metric',
    description: 'Compute a financial metric (NOI, cash flow, cap rate, gross rent, operating expenses, expense breakdown, debt service, equity, or a portfolio summary) with its full derivation from the canonical property and bookkeeping ledger data. Always use this instead of telling the user to check a card. Returns the metric value plus per-property component numbers so you can explain the "why" behind the number. For mortgage interest, management fees, or other ledger category totals by year/property, prefer execute_site_action show-bookkeeping-expenses with category + year.',
    parameters: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ASSISTANT_COMPUTED_METRICS,
        },
        propertyId: {
          type: 'string',
          description: 'Optional property id or address (full or partial) to scope the metric to one property. Omit for portfolio-wide.',
        },
        year: {
          type: 'number',
          description: 'Optional tax/calendar year to filter Azure ledger category totals (e.g. 2025).',
        },
      },
      required: ['metric'],
    },
  };
}
