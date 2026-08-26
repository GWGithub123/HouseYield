/**
 * Shared rental pricing + vacancy helpers for the assistant.
 * Uses the same sources as Rental Pricing Power on the frontend:
 * - current rent from latest Azure bookkeeping rent-like income (fallback: tenant/financials)
 * - market/recommended/vacancy from POST /api/market-analysis/rent-potential
 */

import { estimateVacancyForRentModel } from '../../src/utils/rentalVacancyModel.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function money(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0';
  return `$${Math.round(num).toLocaleString()}`;
}

function pickNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function backendBaseUrl() {
  const port = process.env.PORT || 3001;
  return process.env.ASSISTANT_INTERNAL_BASE_URL
    || process.env.BACKEND_INTERNAL_URL
    || `http://127.0.0.1:${port}`;
}

/**
 * Vacancy-at-rent estimator — mirrors RentalPricingPowerGraph.estimateVacancyForRent
 * so the assistant can manipulate the same calculator the owner sees on screen.
 */
export function estimateVacancyForRent(candidateRent, vacancyModel, fallbacks = {}) {
  const rent = Number(candidateRent);
  if (!Number.isFinite(rent) || rent <= 0) return null;

  const model = vacancyModel || null;
  const canonicalEstimate = estimateVacancyForRentModel(rent, model, fallbacks);
  if (canonicalEstimate != null) return canonicalEstimate;

  if (model?.anchorRent) {
    if (model.rentAtFullVacancy && rent >= model.rentAtFullVacancy) {
      return 100;
    }

    const rawMacroAdj = (model.demandAdjustment || 0)
      + (model.domAdjustment || 0)
      + (model.listingsAdjustment || 0)
      + (model.mortgageAdjustment || 0)
      + (model.sentimentAdjustment || 0)
      + (model.employmentAdjustment || 0);

    const compP25Rent = model.compP25Rent ?? Math.max(model.anchorRent * 0.94, 500);
    const supportedCeilingRent = model.supportedCeilingRent ?? Math.max(model.anchorRent * 1.16);
    const rejectionRent = model.rentAtFullVacancy ?? Math.max(supportedCeilingRent * 1.06);

    if (model.domBins && Array.isArray(model.domBins.bins) && model.domBins.bins.length >= 2) {
      const bins = model.domBins.bins;
      const cappedMacroAdj = clamp(rawMacroAdj, -2.0, 2.0);
      const minVacBinIdx = bins.reduce(
        (minIdx, bin, i) => (bin.avgVacancy < bins[minIdx].avgVacancy ? i : minIdx),
        0,
      );
      const minVacBin = bins[minVacBinIdx];

      let empiricalRate;
      if (rent <= minVacBin.avgRent) {
        const discountRatio = minVacBin.avgRent > 0
          ? clamp((minVacBin.avgRent - rent) / minVacBin.avgRent, 0, 0.3)
          : 0;
        empiricalRate = minVacBin.avgVacancy - discountRatio * 8;
      } else if (rent >= bins[bins.length - 1].avgRent) {
        const lastBin = bins[bins.length - 1];
        const prevBin = bins[bins.length - 2];
        const binSlope = lastBin.avgRent !== prevBin.avgRent
          ? (lastBin.avgVacancy - prevBin.avgVacancy) / (lastBin.avgRent - prevBin.avgRent)
          : 0;
        const extrapolationSlope = Math.max(binSlope, 0.002);
        empiricalRate = lastBin.avgVacancy + extrapolationSlope * (rent - lastBin.avgRent);

        if (rent > supportedCeilingRent) {
          const ceilingRate = lastBin.avgVacancy + extrapolationSlope * (supportedCeilingRent - lastBin.avgRent);
          const progress = clamp(
            (rent - supportedCeilingRent) / Math.max(rejectionRent - supportedCeilingRent, 1),
            0,
            0.999,
          );
          empiricalRate = ceilingRate + progress * (80 - ceilingRate);
        }
      } else {
        empiricalRate = minVacBin.avgVacancy;
        for (let i = minVacBinIdx; i < bins.length - 1; i += 1) {
          if (rent >= bins[i].avgRent && rent <= bins[i + 1].avgRent) {
            const span = Math.max(bins[i + 1].avgRent - bins[i].avgRent, 1);
            const progress = (rent - bins[i].avgRent) / span;
            empiricalRate = bins[i].avgVacancy + progress * (bins[i + 1].avgVacancy - bins[i].avgVacancy);
            break;
          }
        }
      }

      empiricalRate += cappedMacroAdj;
      return round1(clamp(empiricalRate, model.minVacancyRate ?? 1.5, Math.max(model.maxVacancyRate ?? 100, 100)));
    }

    const cappedMacroAdj = clamp(rawMacroAdj, -3.5, 3.5);
    let rate = (model.baseVacancyRate || 5) + cappedMacroAdj;
    const compMedianRent = model.compMedianRent ?? model.anchorRent;
    const compP75Rent = model.compP75Rent ?? Math.max(compMedianRent, model.anchorRent * 1.04);
    const compP90Rent = model.compP90Rent ?? Math.max(compP75Rent, model.anchorRent * 1.08);

    if (rent <= compP25Rent) {
      const discountRatio = compP25Rent > 0 ? (compP25Rent - rent) / compP25Rent : 0;
      rate -= Math.min(3, discountRatio * 10);
    } else if (rent <= compMedianRent) {
      const span = Math.max(compMedianRent - compP25Rent, 1);
      const progress = (rent - compP25Rent) / span;
      rate -= 1.4 - progress * 1.4;
    } else if (rent <= compP75Rent) {
      const span = Math.max(compP75Rent - compMedianRent, 1);
      const progress = (rent - compMedianRent) / span;
      rate += progress * 1.5;
    } else if (rent <= compP90Rent) {
      const span = Math.max(compP90Rent - compP75Rent, 1);
      const progress = (rent - compP75Rent) / span;
      rate += 1.5 + progress * 4.0;
    } else if (rent <= supportedCeilingRent) {
      const span = Math.max(supportedCeilingRent - compP90Rent, 1);
      const progress = (rent - compP90Rent) / span;
      rate += 5.5 + progress * 7.0;
    } else {
      const progress = clamp(
        (rent - supportedCeilingRent) / Math.max(rejectionRent - supportedCeilingRent, 1),
        0,
        0.999,
      );
      if (progress >= 0.82) rate = Math.max(rate, 35);
      else if (progress >= 0.5) rate = Math.max(rate, 28);
      else if (progress >= 0.2) rate = Math.max(rate, 22);
      else rate = Math.max(rate, 16 + progress * 12);
    }

    return round1(clamp(rate, model.minVacancyRate ?? 1.5, Math.max(model.maxVacancyRate ?? 100, 100)));
  }

  const base = Number(fallbacks.baseVacancyRate);
  return Number.isFinite(base) ? round1(base) : null;
}

/**
 * Latest monthly rent from Azure ledger — same preference as the Pricing Power UI
 * ("Latest bookkeeping rent").
 */
export async function resolveBookkeepingCurrentRent({ userId, propertyId } = {}) {
  if (!userId) return null;

  try {
    const bookkeeping = await import('../bookkeeping-firestore.js');
    if (typeof bookkeeping.loadCanonicalLedgerEntriesForScope !== 'function') return null;

    const loaded = await bookkeeping.loadCanonicalLedgerEntriesForScope({
      userId,
      propertyId: propertyId || null,
      limit: 5000,
      errorLabel: 'assistant-rent-potential',
    });
    const entries = loaded?.entries || [];
    const deriveCanonicalTaxCategory = bookkeeping.deriveCanonicalTaxCategory;
    const rentLike = /\brent(?:al)?\b|\blease\b|\btenant\b/i;
    const byMonth = new Map();

    for (const entry of entries) {
      const isIncome = entry.transactionType === 'income' || entry.type === 'income';
      if (!isIncome) continue;
      const amount = Math.abs(Number(entry.signedAmount ?? entry.amount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const taxCategory = typeof deriveCanonicalTaxCategory === 'function'
        ? (deriveCanonicalTaxCategory(entry) || entry.category || '')
        : (entry.category || '');
      const lookup = `${taxCategory} ${entry.memo || ''} ${entry.description || ''} ${entry.payee || ''}`;
      // Prefer rent-tagged income; if none exist we'll fall back below.
      if (!rentLike.test(lookup)) continue;

      const dateKey = String(entry.entryDate || entry.date || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(dateKey)) continue;
      byMonth.set(dateKey, (byMonth.get(dateKey) || 0) + amount);
    }

    // If no rent-tagged income, use all income by month (same UI fallback).
    if (!byMonth.size) {
      for (const entry of entries) {
        const isIncome = entry.transactionType === 'income' || entry.type === 'income';
        if (!isIncome) continue;
        const amount = Math.abs(Number(entry.signedAmount ?? entry.amount ?? 0));
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const dateKey = String(entry.entryDate || entry.date || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(dateKey)) continue;
        byMonth.set(dateKey, (byMonth.get(dateKey) || 0) + amount);
      }
    }

    const latest = Array.from(byMonth.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .pop();
    if (!latest || !(latest[1] > 0)) return null;
    return {
      monthlyRent: Math.round(latest[1]),
      month: latest[0],
      source: 'bookkeeping',
    };
  } catch (error) {
    console.warn('[assistantRentPotential] bookkeeping rent resolve failed:', error?.message || error);
    return null;
  }
}

function extractPropertyFacts(property = {}, detail = {}) {
  const propertyData = property.propertyData || property.property_data || {};
  const summary = propertyData.summary || propertyData || {};
  const address = detail.address || property.address || summary.address || '';
  const zipMatch = String(address).match(/\b(\d{5})(?:-\d{4})?\b/);

  return {
    address,
    zipCode: detail.zip
      || summary.zip
      || summary.zipcode
      || summary.postal_code
      || (zipMatch ? zipMatch[1] : null),
    bedrooms: pickNumber(detail.beds, summary.beds, summary.bedrooms, propertyData.beds),
    bathrooms: pickNumber(detail.baths, summary.baths, summary.bathrooms, propertyData.baths),
    squareFeet: pickNumber(detail.sqft, summary.living_sqft, summary.sqft, propertyData.sqft),
    latitude: pickNumber(detail.latitude, summary.latitude, property.latitude),
    longitude: pickNumber(detail.longitude, summary.longitude, property.longitude),
    propertyType: summary.property_type || property.propertyType || null,
    yearBuilt: pickNumber(detail.yearBuilt, summary.year_built, propertyData.yearBuilt),
    schoolRating: pickNumber(summary.school_district?.rating, propertyData.schoolRating),
    attomRentAvm: pickNumber(summary.rental_avm, detail.marketRent),
    attomRentLow: pickNumber(summary.rental_avm_low),
    attomRentHigh: pickNumber(summary.rental_avm_high),
  };
}

export async function fetchRentPotentialPayload(body = {}) {
  const url = `${backendBaseUrl()}/api/market-analysis/rent-potential`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`rent_potential_http_${response.status}:${text.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Full rental pricing analysis aligned with the Properties → Rental Pricing Power UI.
 * Optional targetRent evaluates vacancy at a hypothetical asking rent.
 */
export async function buildAlignedRentalPricingAnalysis({
  userId,
  property,
  detail,
  targetRent = null,
} = {}) {
  const facts = extractPropertyFacts(property, detail);
  const bookkeepingRent = await resolveBookkeepingCurrentRent({
    userId,
    propertyId: property?.id || detail?.id || null,
  });

  const currentRent = Number(bookkeepingRent?.monthlyRent)
    || Number(detail?.monthlyRent)
    || Number(property?.financials?.monthlyRent)
    || 0;
  const currentRentSource = bookkeepingRent?.source === 'bookkeeping'
    ? `Latest bookkeeping rent (${bookkeepingRent.month})`
    : 'Tenant / modeled rent';

  if (!currentRent || !facts.zipCode) {
    return {
      ok: false,
      error: !currentRent ? 'missing_current_rent' : 'missing_zip',
      currentRent,
      facts,
    };
  }

  const payload = await fetchRentPotentialPayload({
    userId,
    cachePropertyId: property?.id || detail?.id || facts.address,
    propertyId: property?.id || facts.address,
    currentRent,
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    squareFeet: facts.squareFeet,
    zipCode: facts.zipCode,
    latitude: facts.latitude,
    longitude: facts.longitude,
    propertyType: facts.propertyType,
    yearBuilt: facts.yearBuilt,
    schoolRating: facts.schoolRating,
    attomRentAvm: facts.attomRentAvm,
    attomRentLow: facts.attomRentLow,
    attomRentHigh: facts.attomRentHigh,
  });

  const marketPotentialRent = Number(payload.marketPotentialRent) || null;
  const marketAverage = Number(payload.marketAverage) || null;
  const recommendedRent = Number(payload.scenario?.recommendedRent) || marketPotentialRent;
  const currentVacancyRate = Number(payload.scenario?.currentVacancyRate);
  const recommendedVacancyRate = Number(payload.scenario?.recommendedVacancyRate);
  const benchmarkVacancyRate = Number(payload.scenario?.benchmarkVacancyRate);
  const annualRevenueUpside = Number(payload.scenario?.annualRevenueUpside) || 0;
  const monthlyGap = marketPotentialRent != null ? (marketPotentialRent - currentRent) : null;
  const vacancyModel = payload.scenario?.vacancyModel || null;

  const vacancyAtCurrent = Number.isFinite(currentVacancyRate)
    ? round1(currentVacancyRate)
    : estimateVacancyForRent(currentRent, vacancyModel, { baseVacancyRate: 5 });
  const vacancyAtRecommended = Number.isFinite(recommendedVacancyRate)
    ? round1(recommendedVacancyRate)
    : (recommendedRent != null
      ? estimateVacancyForRent(recommendedRent, vacancyModel, { baseVacancyRate: vacancyAtCurrent })
      : null);

  const askedRent = Number(targetRent);
  const vacancyAtTarget = Number.isFinite(askedRent) && askedRent > 0
    ? estimateVacancyForRent(askedRent, vacancyModel, { baseVacancyRate: vacancyAtCurrent })
    : null;

  let verdict = payload.pricingPower?.explanation
    || 'Opened Rental Pricing Power with the live comps + vacancy model.';
  if (monthlyGap != null) {
    if (monthlyGap >= 100) {
      verdict = `Under market by about ${money(monthlyGap)}/mo vs the RentCast comps benchmark (${money(marketPotentialRent)}). Vacancy at current rent is about ${vacancyAtCurrent}%.`;
    } else if (monthlyGap <= -100) {
      verdict = `Current rent is about ${money(Math.abs(monthlyGap))}/mo above the RentCast comps benchmark (${money(marketPotentialRent)}). Vacancy risk at this asking rent is about ${vacancyAtCurrent}%.`;
    } else {
      verdict = `Current rent is roughly aligned with the comps benchmark (~${money(marketPotentialRent)}/mo) with about ${vacancyAtCurrent}% vacancy risk.`;
    }
  }
  if (vacancyAtTarget != null) {
    verdict += ` At ${money(askedRent)}/mo the vacancy model estimates about ${vacancyAtTarget}% vacancy.`;
  }

  const comparableLow = Array.isArray(payload.comparableRents) && payload.comparableRents.length
    ? Math.min(...payload.comparableRents.map(Number).filter(Number.isFinite))
    : null;
  const comparableHigh = Array.isArray(payload.comparableRents) && payload.comparableRents.length
    ? Math.max(...payload.comparableRents.map(Number).filter(Number.isFinite))
    : null;

  return {
    ok: true,
    currentRent,
    currentRentSource,
    marketPotentialRent,
    marketAverage,
    recommendedRent,
    monthlyGap,
    annualRevenueUpside,
    vacancyAtCurrent,
    vacancyAtRecommended,
    vacancyAtTarget,
    targetRent: Number.isFinite(askedRent) ? askedRent : null,
    benchmarkVacancyRate: Number.isFinite(benchmarkVacancyRate) ? round1(benchmarkVacancyRate) : null,
    pricingPower: payload.pricingPower || null,
    vacancyModel,
    comparableCount: Array.isArray(payload.comparableListings) ? payload.comparableListings.length : (payload.comparableRents?.length || 0),
    comparableLow,
    comparableHigh,
    dataSources: payload.dataSources || null,
    scenarioSummary: payload.scenario?.summary || null,
    verdict,
    speakableAnswer: [
      `${facts.address}: ${verdict}`,
      `Current rent ${money(currentRent)}/mo (${currentRentSource}).`,
      marketPotentialRent != null ? `Market benchmark ${money(marketPotentialRent)}/mo.` : null,
      recommendedRent != null ? `Recommended ${money(recommendedRent)}/mo at ~${vacancyAtRecommended}% vacancy.` : null,
      vacancyAtTarget != null ? `At ${money(askedRent)}/mo vacancy ≈ ${vacancyAtTarget}%.` : null,
    ].filter(Boolean).join(' '),
    metrics: [
      { label: 'Current rent', value: `${money(currentRent)}/mo`, hint: currentRentSource },
      { label: 'Market benchmark', value: marketPotentialRent != null ? `${money(marketPotentialRent)}/mo` : '—', hint: 'RentCast comps' },
      { label: 'Recommended rent', value: recommendedRent != null ? `${money(recommendedRent)}/mo` : '—', hint: 'Best return after vacancy' },
      { label: 'Vacancy @ current', value: vacancyAtCurrent != null ? `${vacancyAtCurrent}%` : '—', hint: 'Same calculator as the slider' },
      { label: 'Vacancy @ recommended', value: vacancyAtRecommended != null ? `${vacancyAtRecommended}%` : '—' },
      ...(vacancyAtTarget != null
        ? [{ label: `Vacancy @ ${money(askedRent)}`, value: `${vacancyAtTarget}%`, hint: 'What-if asking rent' }]
        : []),
      { label: 'Monthly gap', value: monthlyGap != null ? `${monthlyGap >= 0 ? '+' : ''}${money(monthlyGap)}` : '—' },
      { label: 'Annual upside', value: money(annualRevenueUpside), hint: 'After vacancy adjustment' },
    ],
    bullets: [
      `Current rent ${money(currentRent)}/mo from ${currentRentSource.toLowerCase()}.`,
      marketPotentialRent != null
        ? `Market benchmark ${money(marketPotentialRent)}/mo${comparableLow != null && comparableHigh != null ? ` (comp range ~${money(comparableLow)}–${money(comparableHigh)})` : ''} via RentCast comps.`
        : 'Market benchmark unavailable.',
      vacancyAtCurrent != null
        ? `Vacancy risk at current asking rent: ${vacancyAtCurrent}%.`
        : null,
      recommendedRent != null
        ? `Model recommends ${money(recommendedRent)}/mo at ~${vacancyAtRecommended}% vacancy${annualRevenueUpside ? ` (${annualRevenueUpside >= 0 ? '+' : ''}${money(annualRevenueUpside)}/yr effective revenue delta)` : ''}.`
        : null,
      vacancyAtTarget != null
        ? `At your asked rent of ${money(askedRent)}/mo, vacancy risk is about ${vacancyAtTarget}%.`
        : null,
    ].filter(Boolean),
    scenarios: [
      {
        label: `Hold ${money(currentRent)}/mo`,
        detail: `Vacancy ≈ ${vacancyAtCurrent ?? '—'}%. Effective revenue delta vs recommended is reflected in the annual upside figure.`,
      },
      {
        label: recommendedRent != null ? `Move to recommended ${money(recommendedRent)}` : 'Move to recommended',
        detail: recommendedRent != null
          ? `Vacancy ≈ ${vacancyAtRecommended ?? '—'}% with modeled annual effective revenue delta ${money(annualRevenueUpside)}.`
          : 'Recommended rent unavailable.',
      },
      {
        label: marketPotentialRent != null ? `Benchmark ${money(marketPotentialRent)}` : 'Market benchmark',
        detail: `RentCast comps benchmark${Number.isFinite(benchmarkVacancyRate) ? ` at ~${round1(benchmarkVacancyRate)}% vacancy` : ''}.`,
      },
    ],
    nextSteps: [
      'I opened Rental Pricing Power — the bars and vacancy slider use this same model.',
      vacancyAtCurrent != null && vacancyAtCurrent > 8
        ? 'If you want, I can draft a rent adjustment toward the recommended level or schedule a lease-renewal reminder.'
        : 'Ask me “what’s vacancy at $X?” and I’ll run the same vacancy calculator at that rent.',
    ],
    recommendedRent,
  };
}
