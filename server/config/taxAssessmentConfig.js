/**
 * Per-county property tax assessment norms for over-assessment screening.
 * Seeded with Maryland first. Keep editable — ratios and deadlines change.
 *
 * Important: "over-assessed" ≠ assessed above market. Many MD counties assess
 * near full market value but phase triennial increases over 3 years and apply
 * Homestead Tax Credit caps on owner-occupied homes.
 */

export const TAX_ASSESSMENT_CONFIG = {
  default: {
    state: null,
    assessmentLevel: 1.0, // assessed ≈ market when 1.0
    assessesNearMarket: true,
    phaseInYears: null,
    homesteadCap: null,
    appealWindow: {
      label: 'Verify local appeal deadline with the assessor',
      typicalMonths: null,
      instructions: 'Confirm filing window and forms with the county assessor before mailing any claim.',
    },
    strongEquityExcessPct: 15,
    moderateEquityExcessPct: 8,
    minCompsStrong: 7,
    minCompsAny: 5,
  },

  // Maryland — statewide SDAT framework; county nuances below.
  MD: {
    state: 'MD',
    assessmentLevel: 1.0,
    assessesNearMarket: true,
    phaseInYears: 3, // triennial reassessment phased in over 3 years
    homesteadCap: {
      name: 'Maryland Homestead Tax Credit',
      appliesTo: 'owner_occupied',
      note: 'Caps taxable assessment growth for primary residences. Absentee/investment properties typically do not receive Homestead — do not suppress on Homestead for absentee leads unless confirmed.',
    },
    appealWindow: {
      label: 'SDAT appeal window (typically shortly after notice)',
      typicalMonths: 'Jan–Feb after notice (verify annually)',
      instructions: 'Maryland property owners generally appeal to SDAT after receiving the assessment notice. Deadlines are printed on the notice — verify at sdat.maryland.gov before advising an owner.',
      url: 'https://dat.maryland.gov/realproperty/Pages/Assessment-Appeal-Process.aspx',
    },
    strongEquityExcessPct: 15,
    moderateEquityExcessPct: 8,
    minCompsStrong: 7,
    minCompsAny: 5,
  },

  // Prince George's County (UMD / College Park wedge)
  'MD-24033': {
    state: 'MD',
    county: "Prince George's",
    fips: '24033',
    assessmentLevel: 1.0,
    assessesNearMarket: true,
    phaseInYears: 3,
    homesteadCap: {
      name: 'Maryland Homestead Tax Credit',
      appliesTo: 'owner_occupied',
      note: 'Investment / absentee rentals usually ineligible.',
    },
    appealWindow: {
      label: "Prince George's County / SDAT appeal window",
      typicalMonths: 'Verify on assessment notice',
      instructions: 'Use SDAT appeal process. Confirm deadline on the owner notice. Packet is for owner review only — not tax advice.',
      url: 'https://dat.maryland.gov/realproperty/Pages/Assessment-Appeal-Process.aspx',
    },
    strongEquityExcessPct: 15,
    moderateEquityExcessPct: 8,
    minCompsStrong: 7,
    minCompsAny: 5,
  },

  // Montgomery County
  'MD-24031': {
    state: 'MD',
    county: 'Montgomery',
    fips: '24031',
    assessmentLevel: 1.0,
    assessesNearMarket: true,
    phaseInYears: 3,
    homesteadCap: {
      name: 'Maryland Homestead Tax Credit',
      appliesTo: 'owner_occupied',
    },
    appealWindow: {
      label: 'Montgomery County / SDAT appeal window',
      typicalMonths: 'Verify on assessment notice',
      instructions: 'Confirm SDAT filing deadline on the assessment notice before any outreach.',
      url: 'https://dat.maryland.gov/realproperty/Pages/Assessment-Appeal-Process.aspx',
    },
    strongEquityExcessPct: 15,
    moderateEquityExcessPct: 8,
    minCompsStrong: 7,
    minCompsAny: 5,
  },
};

/**
 * Resolve config for a property. Prefers county FIPS key, then state, then default.
 */
export function getTaxAssessmentConfig({ state, fips, countyFips } = {}) {
  const normalizedState = String(state || '').trim().toUpperCase();
  const normalizedFips = String(fips || countyFips || '').replace(/\D/g, '');
  const countyKey = normalizedState && normalizedFips
    ? `${normalizedState}-${normalizedFips.slice(-5).padStart(5, '0')}`
    : null;

  // Most specific wins: default → state → county
  const layers = [
    TAX_ASSESSMENT_CONFIG.default,
    normalizedState ? TAX_ASSESSMENT_CONFIG[normalizedState] : null,
    countyKey ? TAX_ASSESSMENT_CONFIG[countyKey] : null,
  ].filter(Boolean);

  return Object.assign({}, ...layers);
}
