/**
 * Derives coarse building geometry — floor count, unit count, and an archetype —
 * from data we already hold, so the digital twin can pick a sensible default
 * shape for a property without spending ATTOM calls.
 *
 * This module makes **zero** API calls. Everything is read out of a cached ATTOM
 * dashboard payload (`attom_property_cache.data`, including the raw
 * `attom_source` component blobs) plus whatever the owner typed during
 * onboarding, which is usually more reliable than ATTOM for unit counts.
 *
 * The output is explicitly a *guess*. Every result carries `confidence` and
 * `needsConfirmation` so the UI can present it as something to confirm and
 * correct rather than as fact — the same discipline the twin already uses for
 * guessed device placement.
 */

/** Archetypes that matter because they select a different twin view. */
export const BUILDING_ARCHETYPES = [
  'single_family',
  'condo_unit',
  'duplex',
  'garden_walkup',
  'midrise_corridor',
  'unknown',
];

/** Raw ATTOM component blobs most likely to carry building attributes. */
const ATTOM_SOURCE_KEYS = ['expandedprofile', 'detail', 'basicprofile', 'detailwithschools'];

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getPath(root, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, root);
}

/**
 * First finite number found across a list of dotted paths.
 * Returns the value *and* the path it came from so callers can report a source.
 */
function firstNumberAt(roots, paths) {
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    for (const path of paths) {
      const num = safeNumber(getPath(root, path));
      if (num !== null) return { value: num, path };
    }
  }
  return { value: null, path: null };
}

function firstStringAt(roots, paths) {
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    for (const path of paths) {
      const str = safeString(getPath(root, path));
      if (str) return { value: str, path };
    }
  }
  return { value: '', path: null };
}

/**
 * Every object worth searching for building attributes, in preference order:
 * the normalized dashboard first, then the raw ATTOM property records.
 */
function collectRoots(dashboard) {
  if (!dashboard || typeof dashboard !== 'object') return [];

  const roots = [dashboard];
  const source = dashboard.attom_source;

  if (source && typeof source === 'object') {
    for (const key of ATTOM_SOURCE_KEYS) {
      const blob = source[key];
      if (!blob || typeof blob !== 'object') continue;
      const properties = Array.isArray(blob.property) ? blob.property : [];
      for (const property of properties) {
        if (property && typeof property === 'object') roots.push(property);
      }
      roots.push(blob);
    }
  }

  return roots;
}

const FLOOR_PATHS = [
  'building.summary.levels',
  'building.summary.stories',
  'building.summary.storyDesc',
  'building.construction.levels',
  'summary.levels',
  'summary.stories',
  'propertyFacts.stories',
];

const UNIT_PATHS = [
  'building.summary.unitsCount',
  'building.summary.unitscount',
  'building.summary.noOfUnits',
  'building.summary.unitCount',
  'summary.unitsCount',
  'summary.unitscount',
  'summary.noOfUnits',
  'lot.unitsCount',
  'building.rooms.unitsCount',
];

const TYPE_PATHS = [
  'summary.propsubtype',
  'summary.propclass',
  'summary.proptype',
  'summary.propertyType',
  'summary.property_type',
  'building.summary.bldgType',
  'building.summary.propType',
  'propertyType',
];

/** Unit counts implied by a property-class label, when ATTOM gives no number. */
const CLASS_UNIT_HINTS = [
  { pattern: /\bDUPLEX\b|\bTWO\s*FAMILY\b|\b2\s*FAMILY\b/i, units: 2 },
  { pattern: /\bTRIPLEX\b|\bTHREE\s*FAMILY\b|\b3\s*FAMILY\b/i, units: 3 },
  { pattern: /\bQUAD(RUPLEX|PLEX)?\b|\bFOURPLEX\b|\bFOUR\s*FAMILY\b|\b4\s*FAMILY\b/i, units: 4 },
];

const MULTIFAMILY_RE = /APARTMENT|APARTMENTS|\bAPT\.?\b|MULTI[\s-]?FAMILY|MULTI[\s-]?UNIT|\bMFR\b|DUPLEX|TRIPLEX|QUAD|FOURPLEX|\d\s*FAMILY|HIGH[\s-]?RISE|MID[\s-]?RISE|MIXED[\s-]?USE|RESIDENTIAL[\s-]?INCOME|STUDENT\s*HOUS|GARDEN\s*APT|WALK[\s-]?UP|\bFLATS\b/i;
const CONDO_RE = /CONDOMINIUM|\bCONDO\b|CO-?OP|COOPERATIVE|TOWN\s?HOUSE|TOWNHOME/i;

/**
 * Pull the owner-entered unit count off a property record, wherever it landed.
 * Onboarding posts `unitCount` at the top level; later edits and the ATTOM
 * hydration path can leave it nested under the property data summary.
 */
function ownerUnitCount(property) {
  if (!property || typeof property !== 'object') return null;
  const candidates = [
    'unitCount',
    'unit_count',
    'units',
    'propertyData.summary.unitCount',
    'property_data.summary.unitCount',
    'propertyData.summary.units',
    'property_data.summary.units',
  ];
  for (const path of candidates) {
    const num = safeNumber(getPath(property, path));
    if (num !== null && num >= 1) return num;
  }
  return null;
}

/**
 * Classify the building. The archetype exists to choose a view, so the
 * distinctions it draws are the ones that change how the twin should be drawn:
 * whether there are stacked units at all, and whether there is an interior
 * corridor with units on both sides.
 */
function classifyArchetype({ typeLabel, unitsTotal, floors }) {
  const label = typeLabel.toUpperCase();

  if (CONDO_RE.test(label) && (unitsTotal === null || unitsTotal <= 1)) {
    return 'condo_unit';
  }

  if (unitsTotal !== null && unitsTotal <= 1) {
    return MULTIFAMILY_RE.test(label) ? 'garden_walkup' : 'single_family';
  }

  if (unitsTotal !== null && unitsTotal <= 4) {
    return unitsTotal === 2 ? 'duplex' : 'garden_walkup';
  }

  if (unitsTotal !== null && unitsTotal > 4) {
    // Interior double-loaded corridors are the norm once a building gets tall
    // or wide; walk-ups with exterior breezeways stay short and shallow.
    const unitsPerFloor = floors > 0 ? unitsTotal / floors : unitsTotal;
    if (floors >= 4 || unitsPerFloor >= 6) return 'midrise_corridor';
    return 'garden_walkup';
  }

  if (MULTIFAMILY_RE.test(label)) return floors >= 4 ? 'midrise_corridor' : 'garden_walkup';
  if (label) return 'single_family';
  return 'unknown';
}

/**
 * Derive twin building geometry from a cached ATTOM dashboard.
 *
 * @param {object|null} dashboard - Cached ATTOM dashboard payload.
 * @param {object|null} [property] - Saved property record, for owner-entered
 *   values that beat ATTOM (notably `unitCount` from onboarding).
 * @returns {object|null} Geometry guess, or null when there is nothing to go on.
 */
export function deriveBuildingGeometry(dashboard, property = null) {
  const roots = collectRoots(dashboard);
  if (roots.length === 0 && !property) return null;

  const typeMatch = firstStringAt(roots, TYPE_PATHS);
  const floorMatch = firstNumberAt(roots, FLOOR_PATHS);
  const attomUnitMatch = firstNumberAt(roots, UNIT_PATHS);
  const ownerUnits = ownerUnitCount(property);

  const sources = {};

  let unitsTotal = null;
  if (ownerUnits !== null) {
    unitsTotal = ownerUnits;
    sources.unitsTotal = 'owner_entered';
  } else if (attomUnitMatch.value !== null && attomUnitMatch.value >= 1) {
    unitsTotal = Math.round(attomUnitMatch.value);
    sources.unitsTotal = `attom:${attomUnitMatch.path}`;
  } else {
    const hint = CLASS_UNIT_HINTS.find(({ pattern }) => pattern.test(typeMatch.value));
    if (hint) {
      unitsTotal = hint.units;
      sources.unitsTotal = 'inferred_from_property_class';
    }
  }

  let floors = null;
  if (floorMatch.value !== null && floorMatch.value >= 1) {
    floors = Math.round(floorMatch.value);
    sources.floors = `attom:${floorMatch.path}`;
  }

  const archetype = classifyArchetype({
    typeLabel: typeMatch.value,
    unitsTotal,
    floors: floors ?? 0,
  });
  sources.archetype = typeMatch.path ? `attom:${typeMatch.path}` : 'default';

  // Fall back to a plausible floor count only after we know the archetype, so
  // the guess at least matches the building kind.
  if (floors === null) {
    if (archetype === 'midrise_corridor') floors = 4;
    else if (archetype === 'garden_walkup') floors = unitsTotal !== null && unitsTotal > 6 ? 3 : 2;
    else if (archetype === 'condo_unit') floors = 1;
    else floors = 2;
    sources.floors = 'inferred_from_archetype';
  }

  if (unitsTotal === null) {
    unitsTotal = archetype === 'single_family' || archetype === 'condo_unit' ? 1 : floors * 2;
    sources.unitsTotal = sources.unitsTotal || 'inferred_from_archetype';
  }

  const unitsPerFloor = Math.max(1, Math.ceil(unitsTotal / Math.max(1, floors)));

  // A double-loaded corridor is the thing that makes one section insufficient,
  // which is exactly when the twin needs an A/B side flip.
  const corridor = archetype === 'midrise_corridor' ? 'double_loaded' : 'none';

  const floorsMeasured = sources.floors?.startsWith('attom:');
  const unitsMeasured = sources.unitsTotal === 'owner_entered' || sources.unitsTotal?.startsWith('attom:');

  let confidence = 'low';
  if (floorsMeasured && unitsMeasured) confidence = 'high';
  else if (floorsMeasured || unitsMeasured) confidence = 'medium';

  return {
    archetype,
    floors,
    unitsTotal,
    unitsPerFloor,
    corridor,
    propertyTypeLabel: typeMatch.value || null,
    confidence,
    // Anything short of two measured inputs gets confirmed by a human before we
    // let it drive leak-exposure claims about specific units.
    needsConfirmation: confidence !== 'high',
    sources,
  };
}

export default { deriveBuildingGeometry, BUILDING_ARCHETYPES };
