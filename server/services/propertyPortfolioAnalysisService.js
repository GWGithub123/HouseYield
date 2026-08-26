import { getHistoricalMortgageRate } from '../fred.js';
import { getOwnerProperties } from '../property-firestore-service.js';
import { listBookkeepingPropertiesFromAzure } from '../accounting-core/bookkeepingMetadataStore.js';
import { listLedgerEntriesFromAzure } from '../accounting-core/ledgerReadModel.js';
import { buildAssistantCanonicalContext } from './assistantCanonicalContextService.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_PROPERTY_PORTFOLIO_MODEL || 'gpt-4.1-mini';

function numberOrZero(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/[$,%\s,]/g, '').trim();
    if (!normalized) {
      return 0;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = numberOrZero(value);
    if (parsed !== 0) {
      return parsed;
    }
  }
  return 0;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAddress(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function inferUsage({ financials, summary, tenantCount, bookkeepingProperty }) {
  const candidates = [
    financials.portfolioType,
    financials.propertyUse,
    financials.useType,
    financials.occupancyStatus,
    financials.occupancyType,
    financials.classification,
    summary?.owner?.relationship_type,
    summary?.owner?.absentee_status,
    bookkeepingProperty?.description,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  if (financials.isPrimaryResidence === true || financials.ownerOccupied === true) {
    return 'personal';
  }

  if (numberOrZero(financials.personalUseDays) > 14 || numberOrZero(bookkeepingProperty?.personalUseDays) > 14) {
    return 'personal';
  }

  if (candidates.some((value) => value.includes('investment') || value.includes('rental') || value.includes('landlord') || value.includes('absentee'))) {
    return 'investment';
  }

  if (candidates.some((value) => value.includes('primary') || value.includes('personal') || value.includes('owner occupied') || value.includes('owner-occupied') || value.includes('homestead'))) {
    return 'personal';
  }

  if (tenantCount > 0 || pickNumber(financials.monthlyRent, summary.rental_avm, summary.market_rent) > 0) {
    return 'investment';
  }

  return 'personal';
}

function summarizeProperty(property, bookkeepingProperty) {
  const summary = property.propertyData || property.property_data || {};
  const facts = summary.summary || {};
  const financials = property.financials || {};
  const mortgage = facts.mortgage || {};
  const tenants = Array.isArray(property.tenants) ? property.tenants : property.tenant ? [property.tenant] : [];
  const tenantCount = Number(property.tenantCount || tenants.length || 0);
  const tenantMonthlyRent = tenants.reduce((sum, tenant) => sum + pickNumber(tenant?.monthlyRent, tenant?.rent), 0);
  const monthlyRent = tenantMonthlyRent > 0 ? tenantMonthlyRent : pickNumber(financials.monthlyRent, facts.rental_avm, facts.market_rent);
  const monthlyOtherIncome = pickNumber(financials.otherIncome);
  const monthlyIncome = monthlyRent + monthlyOtherIncome;
  const annualTaxes = pickNumber(financials.propertyTax, facts.tax_current, bookkeepingProperty?.propertyTax);
  const annualInsurance = pickNumber(financials.insurance, financials.annualInsurance);
  const annualHoa = pickNumber(financials.hoa, financials.annualHoa);
  const annualUtilities = pickNumber(financials.utilities, financials.annualUtilities);
  const annualRepairs = pickNumber(financials.repairsCapEx, financials.repairs, financials.annualRepairs, financials.capex);
  const managementPct = pickNumber(financials.managementPct);
  const vacancyRate = pickNumber(financials.vacancyRate);
  const monthlyManagement = monthlyIncome * (managementPct / 100);
  const monthlyVacancy = monthlyIncome * (vacancyRate / 100);
  const monthlyOtherExpenses = pickNumber(financials.otherMonthlyExpenses, financials.monthlyMaintenance, financials.capexReserveMonthly);
  const computedMonthlyExpenses = (
    (annualTaxes / 12)
    + (annualInsurance / 12)
    + (annualHoa / 12)
    + (annualUtilities / 12)
    + (annualRepairs / 12)
    + monthlyManagement
    + monthlyVacancy
    + monthlyOtherExpenses
  );
  const monthlyOperatingExpenses = pickNumber(financials.monthlyExpenses, computedMonthlyExpenses);
  const currentValue = pickNumber(financials.currentValue, financials.marketValue, facts.avm_value, facts.market_value, facts.value, financials.purchasePrice);
  const mortgageBalance = pickNumber(financials.currentLoanBalance, financials.mortgageBalance, financials.loanAmount, financials.originalLoanAmount, mortgage.amount);
  const monthlyDebtService = pickNumber(financials.monthlyDebtService, financials.monthlyMortgage, financials.monthlyPayment, mortgage.estimated_monthly_payment_pi);
  const purchasePrice = pickNumber(financials.purchasePrice, facts.last_sale_price, bookkeepingProperty?.purchasePrice, currentValue);
  const interestRate = pickNumber(financials.interestRate, mortgage.estimated_interest_rate);
  const equity = Math.max(currentValue - mortgageBalance, 0);
  const monthlyCashFlow = monthlyIncome - monthlyOperatingExpenses - monthlyDebtService;
  const annualGrossIncome = monthlyIncome * 12;
  const annualOperatingExpenses = monthlyOperatingExpenses * 12;
  const annualDebtService = monthlyDebtService * 12;
  const noi = annualGrossIncome - annualOperatingExpenses;
  const usage = inferUsage({ financials, summary: facts, tenantCount, bookkeepingProperty });
  const marketRent = pickNumber(facts.rental_avm, facts.market_rent);
  const ltv = currentValue > 0 ? (mortgageBalance / currentValue) * 100 : 0;
  const expenseRatio = annualGrossIncome > 0 ? annualOperatingExpenses / annualGrossIncome : 0;
  const dscr = annualDebtService > 0 ? noi / annualDebtService : null;
  const zipMatch = String(property.address || facts.address || '').match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = facts.zip || facts.zipcode || facts.postal_code || (zipMatch ? zipMatch[1] : null);
  const beds = pickNumber(facts.beds, facts.bedrooms, summary.beds, summary.bedrooms);
  const baths = pickNumber(facts.baths, facts.bathrooms, summary.baths, summary.bathrooms);
  const sqft = pickNumber(facts.living_sqft, facts.sqft, facts.building_sqft, summary.sqft);
  const yearBuilt = pickNumber(facts.year_built, summary.year_built);
  const latitude = pickNumber(facts.latitude, summary.latitude, property.latitude);
  const longitude = pickNumber(facts.longitude, summary.longitude, property.longitude);
  const environmental = summary.environmental || property.environmental || {};
  const floodZone = environmental?.flood?.femaZone
    || environmental?.flood?.floodZone
    || facts.flood_zone
    || null;
  const wildfireRisk = environmental?.fire?.riskScore
    || environmental?.fire?.risk_level
    || facts.wildfire_risk
    || null;

  return {
    id: property.id,
    address: property.address || facts.address || property.id,
    usage,
    tenantCount,
    currentValue,
    mortgageBalance,
    equity,
    monthlyRent,
    marketRent,
    monthlyOtherIncome,
    monthlyIncome,
    monthlyOperatingExpenses,
    monthlyDebtService,
    monthlyCashFlow,
    annualGrossIncome,
    annualOperatingExpenses,
    annualDebtService,
    annualNetCashFlow: monthlyCashFlow * 12,
    noi,
    ltv,
    grossYield: currentValue > 0 ? (monthlyRent * 12 / currentValue) * 100 : 0,
    capRate: currentValue > 0 ? (noi / currentValue) * 100 : 0,
    expenseRatio,
    cashFlowMargin: annualGrossIncome > 0 ? (monthlyCashFlow * 12) / annualGrossIncome : 0,
    interestRate,
    purchasePrice,
    beds,
    baths,
    sqft,
    yearBuilt,
    zip,
    latitude,
    longitude,
    floodZone,
    wildfireRisk,
    bookkeepingProperty,
  };
}

function aggregateLedgerByProperty(entries) {
  const perProperty = new Map();
  for (const entry of entries) {
    const key = entry.propertyId || 'unassigned';
    if (!perProperty.has(key)) {
      perProperty.set(key, {
        income: 0,
        expenses: 0,
        categories: {},
      });
    }
    const target = perProperty.get(key);
    const txnType = entry.transactionType || entry.type || null;
    const amount = Math.abs(numberOrZero(entry.signedAmount ?? entry.amount));
    if (!amount) continue;

    if (txnType === 'income') {
      target.income += amount;
      continue;
    }
    if (txnType === 'expense') {
      target.expenses += amount;
      const category = String(entry.category || 'Uncategorized');
      target.categories[category] = numberOrZero(target.categories[category]) + amount;
    }
  }
  return perProperty;
}

function buildRecommendations(properties, portfolioSummary, currentMarketMortgageRate, ledgerByProperty) {
  const recommendations = [];
  const totalValue = Math.max(portfolioSummary.totalValue, 1);
  const largestProperty = [...properties].sort((left, right) => right.currentValue - left.currentValue)[0] || null;

  properties.forEach((property) => {
    if (
      currentMarketMortgageRate != null
      && property.mortgageBalance > 0
      && property.interestRate > currentMarketMortgageRate + 0.65
      && property.ltv < 72
    ) {
      recommendations.push({
        id: `refi-${property.id}`,
        title: `Refinance review for ${property.address}`,
        summary: `${property.address} carries an estimated ${property.interestRate.toFixed(2)}% debt rate versus a current market reference near ${currentMarketMortgageRate.toFixed(2)}%.`,
        category: 'refinance',
        severity: property.interestRate - currentMarketMortgageRate > 1.25 ? 'high' : 'medium',
        impact: `Potential debt reset with ${property.ltv.toFixed(1)}% LTV and ${Math.round((property.currentValue * 0.75) - property.mortgageBalance).toLocaleString()} of 75% LTV room.`,
        confidence: 'Medium',
        affectedProperties: [property.address],
        evidence: [
          `Current value ${property.currentValue.toLocaleString()} with mortgage balance ${property.mortgageBalance.toLocaleString()}.`,
          `Estimated debt rate ${property.interestRate.toFixed(2)}% vs market ${currentMarketMortgageRate.toFixed(2)}%.`,
          `Debt service ${property.monthlyDebtService.toLocaleString()}/mo and annual NOI ${property.noi.toLocaleString()}.`,
        ],
        followUpPrompt: `Would refinancing ${property.address} improve monthly cash flow enough to justify closing costs?`,
      });
    }

    if (property.monthlyCashFlow < 0 || (property.dscr != null && property.dscr < 1.1)) {
      recommendations.push({
        id: `cashflow-${property.id}`,
        title: `Stabilize cash flow at ${property.address}`,
        summary: `${property.address} is currently producing ${property.monthlyCashFlow < 0 ? 'negative' : 'thin'} free cash flow after debt service.`,
        category: 'cash_flow',
        severity: property.monthlyCashFlow < 0 ? 'high' : 'medium',
        impact: `${property.monthlyCashFlow.toLocaleString()}/mo current cash flow with ${property.annualOperatingExpenses.toLocaleString()} annual operating costs.`,
        confidence: 'High',
        affectedProperties: [property.address],
        evidence: [
          `Gross income ${property.annualGrossIncome.toLocaleString()} vs operating expenses ${property.annualOperatingExpenses.toLocaleString()}.`,
          property.dscr != null ? `Estimated DSCR ${property.dscr.toFixed(2)}.` : 'Debt coverage not available because debt service is missing.',
          `Monthly debt service ${property.monthlyDebtService.toLocaleString()}.`,
        ],
        followUpPrompt: `What are the best levers to improve cash flow at ${property.address}?`,
      });
    }

    if (property.marketRent > 0 && property.monthlyRent > 0 && property.marketRent > property.monthlyRent * 1.08) {
      recommendations.push({
        id: `rent-${property.id}`,
        title: `Test a rent lift at ${property.address}`,
        summary: `${property.address} appears to be leasing below the current modeled market rent baseline.`,
        category: 'rent',
        severity: 'medium',
        impact: `Modeled market rent ${property.marketRent.toLocaleString()}/mo vs current ${property.monthlyRent.toLocaleString()}/mo.`,
        confidence: 'Medium',
        affectedProperties: [property.address],
        evidence: [
          `Market rent benchmark ${property.marketRent.toLocaleString()}/mo.`,
          `Current rent baseline ${property.monthlyRent.toLocaleString()}/mo.`,
          `Gross yield ${property.grossYield.toFixed(2)}%.`,
        ],
        followUpPrompt: `How much annual cash flow upside could a rent optimization plan unlock at ${property.address}?`,
      });
    }

    const ledger = ledgerByProperty.get(property.id);
    if ((property.expenseRatio > 0.45 && property.annualGrossIncome > 0) || (ledger && ledger.expenses > ledger.income * 0.5)) {
      const topLedgerCategory = ledger
        ? Object.entries(ledger.categories).sort((left, right) => right[1] - left[1])[0]
        : null;
      recommendations.push({
        id: `opex-${property.id}`,
        title: `Audit operating efficiency at ${property.address}`,
        summary: `${property.address} is running with an elevated operating cost load relative to revenue.`,
        category: 'operating_efficiency',
        severity: property.expenseRatio > 0.55 ? 'high' : 'medium',
        impact: `${(property.expenseRatio * 100).toFixed(1)}% operating expense ratio before debt service.`,
        confidence: ledger ? 'High' : 'Medium',
        affectedProperties: [property.address],
        evidence: [
          `Operating expenses ${property.annualOperatingExpenses.toLocaleString()} on gross income ${property.annualGrossIncome.toLocaleString()}.`,
          topLedgerCategory ? `Largest ledger category sampled: ${topLedgerCategory[0]} at ${Number(topLedgerCategory[1]).toLocaleString()}.` : 'No detailed ledger category sample available.',
          `Cap rate ${property.capRate.toFixed(2)}%.`,
        ],
        followUpPrompt: `Which expense categories at ${property.address} look most actionable over the next quarter?`,
      });
    }
  });

  if (largestProperty && largestProperty.currentValue / totalValue > 0.45) {
    recommendations.push({
      id: `concentration-${largestProperty.id}`,
      title: `Reduce concentration around ${largestProperty.address}`,
      summary: `${largestProperty.address} represents a large share of the portfolio's real estate value.`,
      category: 'concentration',
      severity: largestProperty.currentValue / totalValue > 0.6 ? 'high' : 'medium',
      impact: `${((largestProperty.currentValue / totalValue) * 100).toFixed(1)}% of total value is tied to one property.`,
      confidence: 'High',
      affectedProperties: [largestProperty.address],
      evidence: [
        `Largest property value ${largestProperty.currentValue.toLocaleString()}.`,
        `Portfolio total value ${portfolioSummary.totalValue.toLocaleString()}.`,
        `Portfolio net cash flow ${portfolioSummary.annualNetCashFlow.toLocaleString()} annually.`,
      ],
      followUpPrompt: `How concentrated is the portfolio around ${largestProperty.address}, and what should I do about it?`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: 'monitor-portfolio',
      title: 'Portfolio appears broadly stable',
      summary: 'No urgent refinance, rent, or operating red flags were detected from the currently synced property and bookkeeping data.',
      category: 'equity',
      severity: 'low',
      impact: 'Continue monitoring debt costs, rent growth, and expense trends as more ledger data flows in.',
      confidence: 'Medium',
      affectedProperties: properties.map((property) => property.address).slice(0, 3),
      evidence: [
        `${properties.length} properties are currently in scope.`,
        `Annual net cash flow is ${portfolioSummary.annualNetCashFlow.toLocaleString()}.`,
        `Average portfolio debt rate is ${portfolioSummary.averageMortgageRate.toFixed(2)}%.`,
      ],
      followUpPrompt: 'What should I monitor most closely across the portfolio over the next 90 days?',
    });
  }

  return recommendations
    .sort((left, right) => {
      const severityWeight = { high: 3, medium: 2, low: 1 };
      return severityWeight[right.severity] - severityWeight[left.severity];
    })
    .slice(0, 6);
}

async function buildNarrativeWithOpenAi({ summary, recommendations, currentMarketMortgageRate }) {
  if (!OPENAI_API_KEY) {
    return {
      narrative: `The portfolio currently spans ${summary.propertyCount} properties with ${summary.annualNetCashFlow.toLocaleString()} in annual net cash flow. The leading recommendations focus on the largest operating gaps, debt-cost opportunities, and concentration risks surfaced by the synced property and bookkeeping data.`,
      sourceStatus: { ok: false, warning: 'OPENAI_API_KEY missing' },
    };
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are a senior real-estate portfolio analyst. Write one concise paragraph that prioritizes the most actionable portfolio opportunities from the structured data provided. Stay grounded in the numbers and do not invent missing facts.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            summary,
            currentMarketMortgageRate,
            recommendations,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      narrative: `The portfolio currently spans ${summary.propertyCount} properties with ${summary.annualNetCashFlow.toLocaleString()} in annual net cash flow. The leading recommendations focus on the largest operating gaps, debt-cost opportunities, and concentration risks surfaced by the synced property and bookkeeping data.`,
      sourceStatus: { ok: false, warning: errorText || 'OpenAI narrative request failed' },
    };
  }

  const payload = await response.json();
  return {
    narrative: payload?.choices?.[0]?.message?.content?.trim()
      || `The portfolio currently spans ${summary.propertyCount} properties with ${summary.annualNetCashFlow.toLocaleString()} in annual net cash flow.`,
    sourceStatus: { ok: true, model: payload?.model || OPENAI_MODEL, warning: null },
  };
}

function buildPortfolioSummary(properties, scope) {
  const filtered = properties.filter((property) => {
    if (scope === 'overview' || scope === 'combined') {
      return true;
    }
    return property.usage === scope;
  });

  const totalValue = filtered.reduce((sum, property) => sum + property.currentValue, 0);
  const totalEquity = filtered.reduce((sum, property) => sum + property.equity, 0);
  const annualGrossIncome = filtered.reduce((sum, property) => sum + property.annualGrossIncome, 0);
  const annualNetCashFlow = filtered.reduce((sum, property) => sum + property.annualNetCashFlow, 0);
  const mortgageRateBase = filtered.reduce((sum, property) => sum + property.mortgageBalance, 0);
  const averageMortgageRate = mortgageRateBase > 0
    ? filtered.reduce((sum, property) => sum + (property.interestRate * property.mortgageBalance), 0) / mortgageRateBase
    : 0;

  return {
    properties: filtered,
    summary: {
      propertyCount: filtered.length,
      totalValue,
      totalEquity,
      annualGrossIncome,
      annualNetCashFlow,
      averageMortgageRate,
      totalMortgageBalance: filtered.reduce((sum, property) => sum + property.mortgageBalance, 0),
    },
  };
}

/**
 * Assemble the canonical per-property computation (values, income, expenses,
 * NOI, debt service, ledger aggregates) without running recommendations or the
 * AI narrative. Reused by the assistant computed-analytics tools so AI answers
 * and on-screen numbers always derive from the same math.
 */
function remapLedgerEntriesToOwnerPropertyIds(ledgerEntries, ownerProperties, bookkeepingProperties) {
  const azureIdToOwnerId = new Map();
  const addressToOwnerId = new Map();
  const ownerIds = new Set(ownerProperties.map((property) => String(property?.id || '').trim()).filter(Boolean));

  for (const property of ownerProperties) {
    const ownerId = String(property?.id || '').trim();
    if (!ownerId) continue;
    addressToOwnerId.set(normalizeAddress(property.address), ownerId);
  }

  for (const bkProperty of bookkeepingProperties) {
    const azureId = String(bkProperty?.id || '').trim();
    const fixtureId = String(bkProperty?.sourceFixturePropertyId || '').trim();
    const ownerByAddress = addressToOwnerId.get(normalizeAddress(bkProperty?.address));
    const ownerId = (fixtureId && ownerIds.has(fixtureId) ? fixtureId : null)
      || (azureId && ownerIds.has(azureId) ? azureId : null)
      || ownerByAddress
      || null;

    if (!ownerId) continue;
    if (azureId) azureIdToOwnerId.set(azureId, ownerId);
    if (fixtureId) azureIdToOwnerId.set(fixtureId, ownerId);
  }

  return ledgerEntries.map((entry) => {
    const mappedPropertyId = azureIdToOwnerId.get(String(entry?.propertyId || '').trim()) || entry?.propertyId || null;
    return {
      ...entry,
      propertyId: mappedPropertyId,
      lines: (entry.lines || []).map((line) => ({
        ...line,
        propertyId: azureIdToOwnerId.get(String(line?.propertyId || '').trim()) || line?.propertyId || mappedPropertyId,
      })),
    };
  });
}

export async function assemblePortfolioComputation({
  userId,
  year = null,
  startDate = null,
  endDate = null,
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const taxYear = Number(year) || null;
  const resolvedStartDate = taxYear ? `${taxYear}-01-01` : startDate;
  const resolvedEndDate = taxYear ? `${taxYear}-12-31` : endDate;

  const [ownerPropertiesResult, bookkeepingPropertiesResult, ledgerEntriesResult] = await Promise.all([
    getOwnerProperties(userId),
    listBookkeepingPropertiesFromAzure({ userId }).catch(() => ({ ok: false, properties: [] })),
    listLedgerEntriesFromAzure({
      userId,
      startDate: resolvedStartDate || null,
      endDate: resolvedEndDate || null,
      limit: 5000,
    }).catch(() => ({ ok: false, entries: [] })),
  ]);

  const ownerProperties = Array.isArray(ownerPropertiesResult?.properties) ? ownerPropertiesResult.properties : [];
  const bookkeepingProperties = Array.isArray(bookkeepingPropertiesResult?.properties) ? bookkeepingPropertiesResult.properties : [];
  const rawLedgerEntries = Array.isArray(ledgerEntriesResult?.entries) ? ledgerEntriesResult.entries : [];
  const ledgerEntries = remapLedgerEntriesToOwnerPropertyIds(rawLedgerEntries, ownerProperties, bookkeepingProperties);
  const bookkeepingLookup = new Map();
  bookkeepingProperties.forEach((property) => {
    bookkeepingLookup.set(property.id, property);
    bookkeepingLookup.set(normalizeAddress(property.address), property);
  });

  const summarizedProperties = ownerProperties.map((property) => summarizeProperty(
    property,
    bookkeepingLookup.get(property.id) || bookkeepingLookup.get(normalizeAddress(property.address)),
  ));

  const { properties, summary } = buildPortfolioSummary(summarizedProperties, 'overview');
  const ledgerByProperty = aggregateLedgerByProperty(ledgerEntries);

  return {
    properties,
    summary,
    ledgerByProperty,
    ledgerEntryCount: ledgerEntries.length,
    year: taxYear,
    startDate: resolvedStartDate || null,
    endDate: resolvedEndDate || null,
  };
}

export async function buildPropertyPortfolioAnalysis({ userId, scope = 'overview' } = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const [ownerPropertiesResult, bookkeepingPropertiesResult, ledgerEntriesResult, currentMarketMortgageRate] = await Promise.all([
    getOwnerProperties(userId),
    listBookkeepingPropertiesFromAzure({ userId }).catch(() => ({ ok: false, properties: [] })),
    listLedgerEntriesFromAzure({ userId, limit: 2000 }).catch(() => ({ ok: false, entries: [] })),
    getHistoricalMortgageRate(new Date().toISOString().slice(0, 10)).catch(() => null),
  ]);

  const ownerProperties = Array.isArray(ownerPropertiesResult?.properties) ? ownerPropertiesResult.properties : [];
  const bookkeepingProperties = Array.isArray(bookkeepingPropertiesResult?.properties) ? bookkeepingPropertiesResult.properties : [];
  const ledgerEntries = Array.isArray(ledgerEntriesResult?.entries) ? ledgerEntriesResult.entries : [];
  const bookkeepingLookup = new Map();
  bookkeepingProperties.forEach((property) => {
    bookkeepingLookup.set(property.id, property);
    bookkeepingLookup.set(normalizeAddress(property.address), property);
  });

  const summarizedProperties = ownerProperties.map((property) => summarizeProperty(
    property,
    bookkeepingLookup.get(property.id) || bookkeepingLookup.get(normalizeAddress(property.address)),
  ));

  const { properties, summary } = buildPortfolioSummary(summarizedProperties, scope);
  const ledgerByProperty = aggregateLedgerByProperty(ledgerEntries);
  const recommendations = buildRecommendations(properties, summary, currentMarketMortgageRate, ledgerByProperty);
  const narrative = await buildNarrativeWithOpenAi({ summary, recommendations, currentMarketMortgageRate });

  return {
    generatedAt: new Date().toISOString(),
    scope,
    summary: {
      ...summary,
      currentMarketMortgageRate,
    },
    narrative: narrative.narrative,
    recommendations,
    sourceStatus: {
      firestore: { ok: ownerPropertiesResult?.ok !== false, propertyCount: ownerProperties.length },
      azure: {
        ok: bookkeepingPropertiesResult?.ok !== false || ledgerEntriesResult?.ok !== false,
        propertyCount: bookkeepingProperties.length,
        ledgerEntries: ledgerEntries.length,
      },
      openai: narrative.sourceStatus,
    },
  };
}

export async function answerPropertyPortfolioFollowUp({
  userId,
  scope = 'overview',
  question,
  recommendationId = null,
  history = [],
} = {}) {
  if (!userId) {
    throw new Error('userId is required');
  }

  if (!String(question || '').trim()) {
    throw new Error('question is required');
  }

  const [analysis, canonicalContext] = await Promise.all([
    buildPropertyPortfolioAnalysis({ userId, scope }),
    buildAssistantCanonicalContext({
      userId,
      includeFinancialDetails: true,
      includeGlobalContext: true,
    }).catch(() => null),
  ]);

  if (!OPENAI_API_KEY) {
    const selectedRecommendation = analysis.recommendations.find((recommendation) => recommendation.id === recommendationId) || analysis.recommendations[0] || null;
    return {
      ok: true,
      answer: selectedRecommendation
        ? `${selectedRecommendation.title}: ${selectedRecommendation.summary} ${selectedRecommendation.evidence.join(' ')}`
        : analysis.narrative,
    };
  }

  const selectedRecommendation = analysis.recommendations.find((recommendation) => recommendation.id === recommendationId) || null;
  const conversation = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    {
      role: 'system',
      content: `You are HouseYield's cross-property portfolio analyst. Answer follow-up questions using only the structured portfolio analysis and canonical platform context below. If data is missing, say so plainly.\n\nPORTFOLIO_ANALYSIS:\n${JSON.stringify(analysis)}\n\nFOCUSED_RECOMMENDATION:\n${JSON.stringify(selectedRecommendation)}\n\nCANONICAL_CONTEXT:\n${canonicalContext?.promptContext?.slice(0, 16000) || 'Unavailable'}`,
    },
    ...conversation.map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content || ''),
    })),
    {
      role: 'user',
      content: String(question || ''),
    },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'property_portfolio_follow_up_failed');
  }

  const payload = await response.json();
  return {
    ok: true,
    answer: payload?.choices?.[0]?.message?.content?.trim() || analysis.narrative,
  };
}
