/**
 * Persistence for a property's confirmed twin building model.
 *
 * The stacking plan — how many floors, how many units per floor, whether there is
 * a corridor with units on both sides, whether the risers are shared — is seeded
 * from cached ATTOM data by `buildingGeometryDerivation.js`, but ATTOM is
 * frequently wrong or silent about all four. So the twin shows its guess and a
 * manager corrects it, and *that* is what has to survive a page reload.
 *
 * ## Why this is not part of the ATTOM cache
 *
 * `attom_property_cache` is subject to ATTOM's 90-day retention limit and is
 * purged on that schedule. A confirmed stacking plan is the owner's own data
 * about their own building, it did not come from ATTOM, and losing it every 90
 * days would mean asking the manager the same four questions every quarter.
 * Different provenance, different lifetime, different collection.
 *
 * Collection: twin_building_model_cache
 *   Document ID = property id
 *   Fields:
 *     propertyId    — property this plan belongs to
 *     spec          — the confirmable facts (floors, unitsPerFloor, corridor, ...)
 *     confirmedBy   — uid of whoever confirmed it, when confirmed
 *     confirmedAt   — ISO timestamp of confirmation
 *     derivedFrom   — the derivation that seeded it, for provenance
 *     updatedAt     — ISO timestamp of last write
 */

import { initializeFirebaseAdmin } from '../firebase-admin.js';

const COLLECTION = 'twin_building_model_cache';

let db = null;

function getDb() {
  if (db) return db;
  try {
    const admin = initializeFirebaseAdmin();
    db = admin.firestore();
  } catch (error) {
    console.warn('[Twin building model] Firestore unavailable:', error.message);
    return null;
  }
  return db;
}

const CORRIDORS = ['none', 'double_loaded'];
const ARCHETYPES = [
  'single_family',
  'condo_unit',
  'duplex',
  'garden_walkup',
  'midrise_corridor',
  'unknown',
];
const CONFIDENCES = ['low', 'medium', 'high'];

/**
 * Upper bounds on the plan.
 *
 * These are not guesses at what buildings exist, they are limits on what the twin
 * can usefully draw and what a request is allowed to make it allocate: units are
 * generated as `floors × unitsPerFloor × sides`, so an unvalidated pair of large
 * numbers is a way to make the client build a million SVG rectangles.
 */
const MAX_FLOORS = 60;
const MAX_UNITS_PER_FLOOR = 40;

function clampInt(value, min, max, fallback) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

/**
 * Coerce anything into a spec that is safe to store and to draw.
 *
 * Written defensively because this is on the far side of an HTTP boundary. It
 * never throws: a malformed field falls back to the default rather than
 * rejecting the whole plan, since the alternative is a manager losing four
 * correct answers because a fifth arrived as a string.
 */
export function normalizeBuildingSpec(input = {}) {
  const spec = input && typeof input === 'object' ? input : {};

  return {
    floors: clampInt(spec.floors, 1, MAX_FLOORS, 3),
    unitsPerFloor: clampInt(spec.unitsPerFloor, 1, MAX_UNITS_PER_FLOOR, 4),
    corridor: CORRIDORS.includes(spec.corridor) ? spec.corridor : 'none',
    sharedRisers: spec.sharedRisers === true,
    hasBasement: spec.hasBasement === true,
    archetype: ARCHETYPES.includes(spec.archetype) ? spec.archetype : 'unknown',
    confidence: CONFIDENCES.includes(spec.confidence) ? spec.confidence : 'low',
    needsConfirmation: spec.needsConfirmation !== false,
  };
}

/**
 * Read a property's saved plan, or null when nobody has confirmed one.
 *
 * Null is meaningful: it tells the caller to fall back to the ATTOM-seeded guess
 * and keep showing the confirm prompt.
 */
export async function getBuildingModel(propertyId) {
  if (!propertyId) return null;
  const firestore = getDb();
  if (!firestore) return null;

  try {
    const snap = await firestore.collection(COLLECTION).doc(String(propertyId)).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    return {
      propertyId: String(propertyId),
      spec: normalizeBuildingSpec(data.spec),
      confirmedBy: data.confirmedBy || null,
      confirmedAt: data.confirmedAt || null,
      derivedFrom: data.derivedFrom || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (error) {
    console.warn('[Twin building model] read failed:', error.message);
    return null;
  }
}

/**
 * Save a plan.
 *
 * `confirmedBy` is what turns a guess into a confirmed plan, and
 * `needsConfirmation` is forced to false when it is present — the flag exists to
 * drive the "is this right?" prompt, and a plan a human has just answered should
 * not keep asking. Without a `confirmedBy` the write is treated as a revised
 * guess and the prompt stays up.
 */
export async function saveBuildingModel(propertyId, spec, { confirmedBy = null, derivedFrom = null } = {}) {
  if (!propertyId) throw new Error('propertyId is required');
  const firestore = getDb();
  if (!firestore) throw new Error('Firestore unavailable');

  const normalized = normalizeBuildingSpec(spec);
  const now = new Date().toISOString();
  const record = {
    propertyId: String(propertyId),
    spec: {
      ...normalized,
      needsConfirmation: confirmedBy ? false : normalized.needsConfirmation,
      confidence: confirmedBy ? 'high' : normalized.confidence,
    },
    confirmedBy: confirmedBy || null,
    confirmedAt: confirmedBy ? now : null,
    derivedFrom: derivedFrom || null,
    updatedAt: now,
  };

  await firestore.collection(COLLECTION).doc(String(propertyId)).set(record, { merge: true });
  return record;
}

export default { getBuildingModel, saveBuildingModel, normalizeBuildingSpec };
