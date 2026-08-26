/**
 * How many places in a property could leak — the denominator the packet needs.
 *
 * `monitoredLocationCount` in `insurancePacketService.js` counts the places a
 * sensor sits. An underwriter cannot do anything with that number on its own,
 * because four monitored locations is thorough in a one-bath bungalow and thin
 * in a five-bath house. This module supplies the other half of the fraction.
 *
 * ## Why this is derived from property records, not from the twin drawing
 *
 * The twin's cutaway is an archetype: it draws one bathroom whatever the bath
 * count says, because a schematic that tried to draw four bathrooms would be a
 * worse picture, not a better one. That is fine for placing sensors and reading
 * a leak path, but it is the wrong basis for a number in an insurance document.
 * Bathroom count from ATTOM is a fact about the address, so that is what the
 * packet counts.
 *
 * The consequence is that `coverageModel.ts` on the client and this module can
 * report different denominators for the same property, and that is intended
 * rather than a bug to be papered over: the twin is answering "which fixtures
 * that I can see have no sensor", which is a question about the drawing, and the
 * packet is answering "how much of this property's plumbing is monitored", which
 * is a question about the address. Each states its own basis in its own copy.
 * Forcing one number would mean either the drawing claiming knowledge of rooms
 * it does not draw, or the packet under-reporting a five-bath house as having
 * one bathroom.
 *
 * This module makes **zero** API calls: everything comes from property facts
 * already assembled from the cached ATTOM dashboard.
 *
 * ## Every component is labelled with its basis
 *
 * Some of this is read from records (bath count) and some is an assumption every
 * dwelling shares (there is a kitchen; there is a water heater). The two are
 * kept apart in the output so the packet can state which is which, rather than
 * presenting an assumed laundry room as a documented one.
 */

/** Basis for a component of the count. */
export const WET_LOCATION_BASIS = {
  /** Read from property records. */
  recorded: 'recorded',
  /** Present in essentially every dwelling of this type. */
  standard: 'standard',
  /** Inferred from another recorded fact, e.g. a basement foundation. */
  inferred: 'inferred',
};

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Whether the recorded foundation implies a basement.
 *
 * ATTOM's `bsmttype` is free-ish text, and crucially "slab" and "crawl space"
 * are common values that mean *no* basement. Matching on the word "basement"
 * and on the finished/unfinished codes avoids counting a sump in a slab-on-grade
 * house, which would put a permanent uncloseable gap in the coverage ratio.
 */
export function hasBasement(foundationType) {
  const text = safeString(foundationType).toLowerCase();
  if (!text) return false;
  if (/slab|crawl|pier|none/.test(text)) return false;
  return /basement|cellar|bsmt|below\s*grade|walk\s*out|garden\s*level/.test(text);
}

/**
 * Bathrooms as a count of rooms rather than ATTOM's fractional figure.
 *
 * ATTOM reports `bathstotal` as 2.5 for two full baths and a powder room. A half
 * bath is still a room with a toilet and a supply line, so it is a wet location
 * and rounding up is the correct move — rounding down would silently drop it
 * from the denominator and flatter the ratio.
 */
export function bathroomLocationCount(bathrooms) {
  const value = safeNumber(bathrooms);
  if (value === null || value <= 0) return null;
  return Math.ceil(value);
}

/**
 * Expected wet locations for a property, with the reasoning attached.
 *
 * `propertyFacts` is the object `buildPropertyFacts` produces, so this needs no
 * knowledge of ATTOM's payload shape.
 *
 * Returns `count: null` rather than a guess when there is nothing to go on. A
 * fabricated denominator is worse than an absent one: the packet can say "not
 * established" honestly, but it cannot un-say a wrong number.
 */
export function deriveWetLocations(propertyFacts = {}) {
  const components = [];

  const baths = bathroomLocationCount(propertyFacts.bathrooms);
  if (baths !== null) {
    components.push({
      id: 'bathrooms',
      label: baths === 1 ? '1 bathroom' : `${baths} bathrooms`,
      count: baths,
      basis: WET_LOCATION_BASIS.recorded,
      detail: 'Bathroom count from property records, rounded up so half baths are included.',
    });
  }

  /*
   * A kitchen and a water heater are not assumptions in any meaningful sense —
   * a dwelling without either is not a dwelling — and both are places a
   * mitigation sensor is normally installed, so leaving them out would make the
   * denominator smaller than the set of locations the numerator draws from.
   */
  components.push({
    id: 'kitchen',
    label: 'Kitchen',
    count: 1,
    basis: WET_LOCATION_BASIS.standard,
    detail: 'Supply and drain at the kitchen sink.',
  });
  components.push({
    id: 'water_heater',
    label: 'Water heater',
    count: 1,
    basis: WET_LOCATION_BASIS.standard,
    detail: 'Tank or tankless unit with a supply connection.',
  });

  /*
   * Laundry is a real location in a single-family home and frequently absent
   * from a condo unit, so it is only counted where it is more likely than not.
   */
  const propertyType = safeString(propertyFacts.propertyType).toLowerCase();
  const isUnit = /condo|apartment|co-?op/.test(propertyType);
  if (!isUnit) {
    components.push({
      id: 'laundry',
      label: 'Laundry connection',
      count: 1,
      basis: WET_LOCATION_BASIS.standard,
      detail: 'Washer supply hoses, the single most common high-volume failure point.',
    });
  }

  if (hasBasement(propertyFacts.foundationType)) {
    components.push({
      id: 'basement',
      label: 'Basement floor',
      count: 1,
      basis: WET_LOCATION_BASIS.inferred,
      detail: `Foundation recorded as "${safeString(propertyFacts.foundationType)}", which is below grade and is where water collects.`,
    });
  }

  const count = components.reduce((total, component) => total + component.count, 0);
  const recordedCount = components
    .filter((component) => component.basis === WET_LOCATION_BASIS.recorded)
    .reduce((total, component) => total + component.count, 0);

  return {
    count,
    components,
    /*
     * Without a bath count the figure rests entirely on what every dwelling has,
     * which is a floor, not an estimate of this address.
     */
    confidence: baths === null ? 'low' : 'moderate',
    recordedCount,
    basis: baths === null
      ? 'Bathroom count is not present in the property records, so this is a minimum based on fixtures every dwelling has.'
      : 'Derived from recorded bathroom count plus the fixtures every dwelling has. Not a plumbing survey.',
  };
}

/**
 * Turn monitored and expected counts into a coverage figure for the packet.
 *
 * Capped at 100%. A property can legitimately have more monitored locations than
 * this model expects — someone who puts a puck under every sink in a house whose
 * bath count ATTOM under-reports — and reporting 120% coverage would read as a
 * bug and discredit the number next to it.
 */
export function buildCoverageSummary(monitoredWetLocationCount, expected) {
  const monitored = Math.max(0, safeNumber(monitoredWetLocationCount) ?? 0);
  const expectedCount = safeNumber(expected?.count);

  if (!expectedCount || expectedCount <= 0) {
    return {
      monitoredWetLocationCount: monitored,
      expectedWetLocationCount: null,
      coveragePercent: null,
      unmonitoredWetLocationCount: null,
      components: expected?.components || [],
      confidence: 'unavailable',
      basis: 'Expected wet-location count could not be established from the property records, so no coverage ratio is stated.',
    };
  }

  const ratio = Math.min(1, monitored / expectedCount);

  return {
    monitoredWetLocationCount: monitored,
    expectedWetLocationCount: expectedCount,
    coveragePercent: Math.round(ratio * 100),
    unmonitoredWetLocationCount: Math.max(0, expectedCount - monitored),
    components: expected.components,
    confidence: expected.confidence,
    basis: expected.basis,
  };
}
