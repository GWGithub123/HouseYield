/**
 * valuation.js — blended fair-value engine.
 *
 * Combines:
 *  - ATTOM AVM (subject dashboard)
 *  - RentCast value AVM (with correlation-scored sale comps)
 *  - Comp-implied value ($/sqft from the best RentCast sale comps)
 *  - Zip market $/sqft sanity band
 *
 * Produces a fair value, a confidence level, the comps table, and an
 * undervalued / fair / overvalued signal vs the list price.
 */

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

/**
 * Compute comp-implied value from RentCast sale comps using correlation-
 * weighted $/sqft applied to the subject's square footage.
 */
function compImpliedValue(subject, comparables) {
  const usable = (comparables || []).filter((comp) =>
    Number.isFinite(num(comp.price)) && num(comp.price) > 10000 &&
    Number.isFinite(num(comp.squareFootage)) && num(comp.squareFootage) > 200
  );

  if (!usable.length || !Number.isFinite(num(subject.sqft)) || num(subject.sqft) <= 0) {
    return { value: null, count: usable.length, medianPricePerSqft: null };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  const ppsfValues = [];

  usable.forEach((comp) => {
    const ppsf = num(comp.price) / num(comp.squareFootage);
    ppsfValues.push(ppsf);
    const weight = Math.max(num(comp.correlation) ?? 0.5, 0.1);
    weightedSum += ppsf * weight;
    weightTotal += weight;
  });

  const weightedPpsf = weightTotal > 0 ? weightedSum / weightTotal : median(ppsfValues);

  return {
    value: round(weightedPpsf * num(subject.sqft)),
    count: usable.length,
    medianPricePerSqft: round(median(ppsfValues), 0),
    weightedPricePerSqft: round(weightedPpsf, 0),
  };
}

/**
 * @param {object} bundle — output of aggregatePropertyData
 * @param {number|null} listPrice — asking price (null for off-market analysis)
 * @param {object} renovation — optional { arvUplift } applied for ARV calc
 */
export function computeValuation(bundle, listPrice = null) {
  const { subject, valueAvm, zipMarket } = bundle;

  const attomAvm = num(subject.avmValue);
  const rentcastAvm = num(valueAvm?.estimate);
  const comps = valueAvm?.comparables || [];
  const compResult = compImpliedValue(subject, comps);

  // Weighted blend; weights renormalize across available sources.
  const componentDefs = [
    { key: 'attomAvm', value: attomAvm, weight: 0.30, label: 'ATTOM AVM' },
    { key: 'rentcastAvm', value: rentcastAvm, weight: 0.30, label: 'RentCast AVM' },
    { key: 'compImplied', value: compResult.value, weight: 0.40, label: `Sale comps (${compResult.count})` },
  ].filter((c) => Number.isFinite(c.value) && c.value > 10000);

  let fairValue = null;
  if (componentDefs.length) {
    const totalWeight = componentDefs.reduce((sum, c) => sum + c.weight, 0);
    fairValue = round(componentDefs.reduce((sum, c) => sum + c.value * (c.weight / totalWeight), 0));
  }

  // Zip $/sqft sanity check
  const zipMedianPpsf = num(zipMarket?.saleData?.medianPerSquareFoot);
  const zipImpliedValue = zipMedianPpsf && num(subject.sqft)
    ? round(zipMedianPpsf * num(subject.sqft))
    : null;

  // Spread between sources drives confidence
  const sourceValues = componentDefs.map((c) => c.value);
  const spreadPct = sourceValues.length >= 2 && fairValue
    ? round(((Math.max(...sourceValues) - Math.min(...sourceValues)) / fairValue) * 100, 1)
    : null;

  let confidence = 'low';
  if (componentDefs.length >= 3 && spreadPct !== null && spreadPct < 15) confidence = 'high';
  else if (componentDefs.length >= 2 && (spreadPct === null || spreadPct < 25)) confidence = 'medium';

  // Signal vs list price
  let signal = null;
  let variance = null;
  let variancePct = null;
  const price = num(listPrice);
  if (price && fairValue) {
    variance = round(fairValue - price);
    variancePct = round((variance / price) * 100, 1);
    if (variancePct >= 5) signal = 'undervalued';
    else if (variancePct <= -5) signal = 'overvalued';
    else signal = 'fair';
  }

  return {
    fairValue,
    listPrice: price,
    variance,
    variancePct,
    signal,
    confidence,
    spreadPct,
    components: componentDefs.map((c) => ({ key: c.key, label: c.label, value: round(c.value) })),
    avm: {
      attom: { value: attomAvm, low: num(subject.avmLow), high: num(subject.avmHigh) },
      rentcast: { value: rentcastAvm, low: num(valueAvm?.estimateLow), high: num(valueAvm?.estimateHigh) },
    },
    comps: {
      count: compResult.count,
      impliedValue: compResult.value,
      medianPricePerSqft: compResult.medianPricePerSqft,
      weightedPricePerSqft: compResult.weightedPricePerSqft,
      zipMedianPricePerSqft: zipMedianPpsf,
      zipImpliedValue,
      items: comps.slice(0, 12).map((comp) => ({
        address: comp.formattedAddress,
        latitude: comp.latitude,
        longitude: comp.longitude,
        price: comp.price,
        bedrooms: comp.bedrooms,
        bathrooms: comp.bathrooms,
        squareFootage: comp.squareFootage,
        yearBuilt: comp.yearBuilt,
        distanceMiles: comp.distance != null ? round(comp.distance, 2) : null,
        correlation: comp.correlation != null ? round(comp.correlation, 2) : null,
        daysOnMarket: comp.daysOnMarket,
        pricePerSqft: Number.isFinite(num(comp.price)) && Number.isFinite(num(comp.squareFootage)) && num(comp.squareFootage) > 0
          ? round(num(comp.price) / num(comp.squareFootage))
          : null,
      })),
    },
  };
}
