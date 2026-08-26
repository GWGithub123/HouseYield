/**
 * Canonical vacancy-at-asking-rent model shared by the API, UI, and assistant.
 *
 * DOM bins represent relative marketing friction, not observed physical vacancy.
 * The model interpolates continuously between support points and approaches
 * full rejection smoothly instead of using threshold jumps.
 */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function interpolate(x, x0, y0, x1, y1) {
  if (x1 <= x0) return y1;
  const progress = clamp((x - x0) / (x1 - x0), 0, 1);
  return y0 + (y1 - y0) * progress;
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

export function estimateVacancyForRentModel(candidateRent, vacancyModel, fallbacks = {}) {
  const rent = Number(candidateRent);
  if (!Number.isFinite(rent) || rent <= 0) return null;

  const model = vacancyModel || null;
  if (!model?.anchorRent) {
    const base = Number(fallbacks.baseVacancyRate);
    return Number.isFinite(base) ? round1(base) : null;
  }

  const minVacancy = Number(model.minVacancyRate ?? 1.5);
  const maxVacancy = Number(model.maxVacancyRate ?? 100);
  const compP25Rent = Number(model.compP25Rent ?? Math.max(model.anchorRent * 0.94, 500));
  const compMedianRent = Number(model.compMedianRent ?? model.anchorRent);
  const compP75Rent = Number(model.compP75Rent ?? Math.max(compMedianRent, model.anchorRent * 1.04));
  const compP90Rent = Number(model.compP90Rent ?? Math.max(compP75Rent, model.anchorRent * 1.08));
  const supportedCeilingRent = Number(model.supportedCeilingRent ?? Math.max(model.anchorRent * 1.16));
  const fullVacancyRent = Number(model.rentAtFullVacancy ?? Math.max(supportedCeilingRent * 1.1));

  if (rent >= fullVacancyRent) return 100;

  const rawMacroAdjustment = Number(model.demandAdjustment || 0)
    + Number(model.domAdjustment || 0)
    + Number(model.listingsAdjustment || 0)
    + Number(model.mortgageAdjustment || 0)
    + Number(model.sentimentAdjustment || 0)
    + Number(model.employmentAdjustment || 0);
  const macroAdjustment = clamp(rawMacroAdjustment, -2.5, 2.5);
  const bins = Array.isArray(model.domBins?.bins)
    ? [...model.domBins.bins]
      .filter((bin) => Number.isFinite(Number(bin.avgRent)) && Number.isFinite(Number(bin.avgVacancy)))
      .sort((left, right) => Number(left.avgRent) - Number(right.avgRent))
    : [];

  let rate;
  if (bins.length >= 2) {
    const first = bins[0];
    const last = bins[bins.length - 1];

    if (rent <= first.avgRent) {
      const discount = clamp((first.avgRent - rent) / Math.max(first.avgRent, 1), 0, 0.3);
      rate = Number(first.avgVacancy) - discount * 2;
    } else if (rent < last.avgRent) {
      rate = Number(first.avgVacancy);
      for (let index = 0; index < bins.length - 1; index += 1) {
        const left = bins[index];
        const right = bins[index + 1];
        if (rent >= left.avgRent && rent <= right.avgRent) {
          rate = interpolate(
            rent,
            Number(left.avgRent),
            Number(left.avgVacancy),
            Number(right.avgRent),
            Number(right.avgVacancy),
          );
          break;
        }
      }
    } else {
      const previous = bins[bins.length - 2];
      const observedSlope = last.avgRent !== previous.avgRent
        ? (Number(last.avgVacancy) - Number(previous.avgVacancy))
          / (Number(last.avgRent) - Number(previous.avgRent))
        : 0;
      const boundedSlope = clamp(observedSlope, 0, 0.01);
      const ceilingTarget = Math.max(
        Number(last.avgVacancy),
        Math.min(24, Number(model.baseVacancyRate || 5) + 12.5),
      );
      if (rent <= supportedCeilingRent) {
        const slopeProjection = Number(last.avgVacancy) + boundedSlope * (rent - Number(last.avgRent));
        const smoothProjection = interpolate(
          rent,
          Number(last.avgRent),
          Number(last.avgVacancy),
          supportedCeilingRent,
          ceilingTarget,
        );
        rate = Math.max(slopeProjection, smoothProjection);
      } else {
        rate = ceilingTarget;
      }
    }
  } else {
    const base = Number(model.baseVacancyRate || 5);
    const anchors = [
      { rent: compP25Rent, rate: Math.max(minVacancy, base - 1) },
      { rent: compMedianRent, rate: base },
      { rent: compP75Rent, rate: base + 1.5 },
      { rent: compP90Rent, rate: base + 5.5 },
      { rent: supportedCeilingRent, rate: Math.min(24, base + 12.5) },
    ].sort((left, right) => left.rent - right.rent);

    if (rent <= anchors[0].rent) {
      const discount = clamp((anchors[0].rent - rent) / Math.max(anchors[0].rent, 1), 0, 0.3);
      rate = anchors[0].rate - discount * 2;
    } else {
      rate = anchors[anchors.length - 1].rate;
      for (let index = 0; index < anchors.length - 1; index += 1) {
        const left = anchors[index];
        const right = anchors[index + 1];
        if (rent >= left.rent && rent <= right.rent) {
          rate = interpolate(rent, left.rent, left.rate, right.rent, right.rate);
          break;
        }
      }
    }
  }

  rate += macroAdjustment;

  if (rent > supportedCeilingRent) {
    const ceilingProgress = (rent - supportedCeilingRent)
      / Math.max(fullVacancyRent - supportedCeilingRent, 1);
    const ceilingRate = Math.max(rate, Math.min(24, Number(model.baseVacancyRate || 5) + 12.5));
    rate = ceilingRate + smoothstep(ceilingProgress) * (98 - ceilingRate);
  }

  return round1(clamp(rate, minVacancy, maxVacancy));
}

/**
 * Estimate a stale listing's lease-up timing separately from stabilized
 * structural vacancy. Subject DOM is censored evidence (the home has not leased
 * yet), so it only supplies a bounded multiplier; comparable DOM and price
 * position remain the dominant inputs.
 */
export function estimateLeaseUpRecoveryForRent(candidateRent, vacancyModel, fallbacks = {}) {
  const rent = Number(candidateRent);
  const model = vacancyModel || {};
  const stabilizedVacancyRate = estimateVacancyForRentModel(rent, model, fallbacks);
  if (!Number.isFinite(rent) || rent <= 0 || stabilizedVacancyRate == null) return null;

  const subjectDaysOnMarket = Number(model.subjectDaysOnMarket);
  const subjectIsStale = Boolean(model.subjectListingIsStale)
    && Number.isFinite(subjectDaysOnMarket)
    && subjectDaysOnMarket > 0;
  if (!subjectIsStale) {
    return {
      stabilizedVacancyRate,
      realizedVacancyPct: 0,
      expectedAdditionalLeaseUpDays: 0,
      projectedCampaignVacancyPct: stabilizedVacancyRate,
    };
  }

  const currentRent = Number(model.subjectCurrentRent) || rent;
  const benchmarkRent = Number(model.anchorRent) || currentRent;
  const marketLeaseUpDays = clamp(Number(model.marketLeaseUpDays) || 30, 7, 75);
  const priceElasticity = clamp(Number(model.leaseUpPriceElasticity) || 8, 4, 12);
  const staleRatio = clamp(subjectDaysOnMarket / marketLeaseUpDays - 1, 0, 2);
  const evidenceWeight = clamp(Number(model.subjectDomEvidenceWeight) || 0.35, 0.15, 0.5);

  // Price position drives expected remaining time. A meaningful reset below
  // the failed ask also reduces the bounded stale-campaign penalty.
  const priceFactor = Math.exp(clamp((rent / Math.max(benchmarkRent, 1) - 1) * priceElasticity, -1.4, 1.6));
  const resetFactor = rent >= currentRent
    ? 1
    : clamp((rent / Math.max(currentRent, 1) - 0.9) / 0.1, 0, 1);
  const staleMultiplier = 1 + staleRatio * evidenceWeight * resetFactor;
  const expectedAdditionalLeaseUpDays = round1(clamp(
    marketLeaseUpDays * priceFactor * staleMultiplier,
    4,
    180,
  ));
  const realizedVacancyPct = round1(clamp(subjectDaysOnMarket / 365 * 100, 0, 100));
  const projectedCampaignVacancyPct = round1(clamp(
    (subjectDaysOnMarket + expectedAdditionalLeaseUpDays) / 365 * 100,
    realizedVacancyPct,
    100,
  ));

  return {
    stabilizedVacancyRate,
    realizedVacancyPct,
    expectedAdditionalLeaseUpDays,
    projectedCampaignVacancyPct,
    marketLeaseUpDays: round1(marketLeaseUpDays),
    subjectDomEvidenceWeight: round1(evidenceWeight),
  };
}
