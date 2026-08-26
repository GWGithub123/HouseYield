import {
  DX,
  DY,
  FLOOR_BANDS,
  FLOOD_THRESHOLDS,
  INTERIOR_LEFT,
  METER,
  SHELL,
  VALVE_CENTER,
  fixtureAnchor,
  waterLevelToY,
  type FixtureKind,
  type RoomDef,
} from './houseModel';
import {
  PROPERTY_HEALTH_CATEGORY_META,
  resolveAssetAgeYears,
  resolveLifeUsedRatio,
  resolveUsefulLifeYears,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../../types/propertyHealth';

/**
 * Where each kind of tracked component stands in the cutaway, and what the
 * flood model implies about it.
 *
 * Properties and Predictive Maintenance have been describing the same house
 * from two directions: one as an inventory of components with ages, the other
 * as a drawing with a waterline through it. Neither knew about the other, so
 * "the water heater is 14 years old" and "one foot of water reaches the water
 * heater pilot" could both be on screen without ever being put together. This
 * module is the join: it gives every health category a position in the drawing
 * and reads the flood thresholds against the component's remaining life.
 */

/* ── placement ─────────────────────────────────────────────────────── */

/** Health pins sit slightly above their fixture so the glyph is not buried. */
const PIN_LIFT = 34;

/**
 * The fixture a category is drawn on, when the room set contains one.
 *
 * Only the mechanicals map cleanly onto a drawn object. Everything else falls
 * back to a fixed point below, because a pin on a plausible spot reads better
 * than no pin at all — the drawing is a way to find the component, not a
 * survey of where it really is.
 */
const CATEGORY_FIXTURE: Partial<Record<PropertyHealthCategory, FixtureKind>> = {
  water_heater: 'water_heater',
  hvac: 'furnace',
  electrical: 'panel',
  air_filter: 'furnace',
};

export interface HealthAnchor {
  x: number;
  y: number;
  /** Where the label should sit relative to the pin, to stay inside the shell. */
  side: 'left' | 'right';
  /**
   * The room the component stands in, when it stands in one.
   *
   * Absent for the roof and the exterior, which are parts of the shell rather
   * than contents of a room. The camera uses this to frame the component against
   * its room, so an absent value means "frame the point on its own" rather than
   * "unknown".
   */
  roomId?: string;
  /** The archetypal cutaway has no matching fixture, so this is an area estimate. */
  approximate?: boolean;
}

/**
 * Fixed points for the categories that are not a drawn fixture.
 *
 * The roof rides the ridge, the exterior sits by the meter, and plumbing sits
 * on the shutoff valve — the one place the water service is unambiguous.
 */
function fallbackAnchor(category: PropertyHealthCategory, rooms: RoomDef[]): HealthAnchor {
  const hasBasement = rooms.some((room) => room.floor === 'basement');
  const mainMid = (FLOOR_BANDS.main.top + FLOOR_BANDS.main.bottom) / 2;

  switch (category) {
    case 'roof':
      return { x: SHELL.roofPeak.x, y: SHELL.roofPeak.y + 62, side: 'right' };
    case 'windows':
      return { x: INTERIOR_LEFT + 30, y: FLOOR_BANDS.upper.top + 74, side: 'right' };
    case 'plumbing':
      return hasBasement
        ? { x: VALVE_CENTER.x, y: VALVE_CENTER.y - 46, side: 'right' }
        : { x: SHELL.wallLeft + 96, y: mainMid, side: 'right' };
    case 'exterior':
      // Outside the right wall, labelled outward — pointing the text back
      // inward runs it over the siding it is describing.
      return { x: METER.x + 8, y: METER.y - 66, side: 'right' };
    case 'water_filter':
      return hasBasement
        ? { x: VALVE_CENTER.x - 96, y: VALVE_CENTER.y - 40, side: 'left' }
        : { x: SHELL.wallLeft + 150, y: mainMid, side: 'right' };
    case 'appliance':
      return { x: INTERIOR_LEFT + 96, y: mainMid - 10, side: 'right' };
    case 'water_heater':
      return hasBasement
        ? { x: INTERIOR_LEFT + 82, y: FLOOR_BANDS.basement.bottom - 82, side: 'right', approximate: true }
        : { x: INTERIOR_LEFT + 82, y: mainMid + 48, side: 'right', approximate: true };
    case 'hvac':
      return hasBasement
        ? { x: INTERIOR_LEFT + 158, y: FLOOR_BANDS.basement.bottom - 84, side: 'right', approximate: true }
        : { x: INTERIOR_LEFT + 158, y: mainMid + 48, side: 'right', approximate: true };
    case 'air_filter':
      return hasBasement
        ? { x: INTERIOR_LEFT + 158, y: FLOOR_BANDS.basement.bottom - 150, side: 'right', approximate: true }
        : { x: INTERIOR_LEFT + 158, y: mainMid - 18, side: 'right', approximate: true };
    case 'electrical':
      return hasBasement
        ? { x: INTERIOR_LEFT + 260, y: FLOOR_BANDS.basement.top + 62, side: 'right', approximate: true }
        : { x: SHELL.wallLeft + 72, y: mainMid, side: 'right', approximate: true };
    case 'smart_home':
      return { x: SHELL.roofPeak.x + 60, y: mainMid - 40, side: 'right' };
    default:
      return { x: SHELL.roofPeak.x, y: mainMid, side: 'right' };
  }
}

/**
 * The point in the 1320×920 cutaway space where a category's pin belongs.
 *
 * A missing fixture falls back to an explicitly approximate area. The cutaway is
 * archetypal rather than a surveyed floor plan, and hiding a tracked component is
 * worse than showing its likely area with that limitation made clear.
 */
export function healthAnchorFor(
  category: PropertyHealthCategory,
  rooms: RoomDef[],
): HealthAnchor | null {
  const wantedFixture = CATEGORY_FIXTURE[category];

  if (wantedFixture) {
    for (const room of rooms) {
      const fixture = room.fixtures.find((f) => f.kind === wantedFixture);
      if (!fixture) continue;
      const at = fixtureAnchor(fixture);
      return {
        x: at.x,
        // The air filter lives on the furnace, so it is nudged clear of it.
        y: at.y - PIN_LIFT - (category === 'air_filter' ? 46 : 0),
        side: at.x > SHELL.roofPeak.x ? 'left' : 'right',
        roomId: room.id,
      };
    }
  }

  return fallbackAnchor(category, rooms);
}

/* ── condition colour ──────────────────────────────────────────────── */

/**
 * Pin tint by remaining life, not by status label.
 *
 * A ratio reads continuously — a component at 0.7 of its life looks different
 * from one at 0.95 — where the three status buckets would draw them the same
 * and hide the thing worth seeing, which is what is about to come due.
 */
export function healthTint(lifeUsedRatio: number | null): string {
  if (lifeUsedRatio == null) return '#94a3b8';
  if (lifeUsedRatio >= 1) return '#e11d48';
  if (lifeUsedRatio >= 0.85) return '#f97316';
  if (lifeUsedRatio >= 0.65) return '#f59e0b';
  return '#10b981';
}

export interface HealthPin {
  asset: PropertyHealthAsset;
  anchor: HealthAnchor;
  lifeUsedRatio: number | null;
  ageYears: number | null;
  usefulLifeYears: number;
  tint: string;
  label: string;
}

/**
 * One pin per tracked asset.
 *
 * The old implementation collapsed each category to its worst item, which made
 * three appliances look like one and could hide a newly-added filter completely.
 * Repeated categories now fan around their shared anchor, then pass through the
 * global collision resolver with every other component.
 */
export function buildHealthPins(
  assets: PropertyHealthAsset[],
  rooms: RoomDef[],
  now = new Date(),
): HealthPin[] {
  const visible = assets.filter((asset) => !asset.notApplicable);
  const categoryCounts = new Map<PropertyHealthCategory, number>();
  for (const asset of visible) {
    categoryCounts.set(asset.category, (categoryCounts.get(asset.category) ?? 0) + 1);
  }
  const categoryIndex = new Map<PropertyHealthCategory, number>();
  const pins: HealthPin[] = [];
  for (const asset of visible) {
    const category = asset.category;
    const ratio = resolveLifeUsedRatio(asset, now);
    const baseAnchor = healthAnchorFor(category, rooms);
    const index = categoryIndex.get(category) ?? 0;
    categoryIndex.set(category, index + 1);
    const direction = index % 2 === 0 ? 1 : -1;
    const ring = Math.ceil(index / 2);
    const anchor = baseAnchor
      ? {
          ...baseAnchor,
          x: baseAnchor.x + direction * ring * 62,
          y: baseAnchor.y + ring * 18,
        }
      : null;
    if (!anchor) continue;
    pins.push({
      asset,
      anchor,
      lifeUsedRatio: ratio,
      ageYears: resolveAssetAgeYears(asset, now),
      usefulLifeYears: resolveUsefulLifeYears(asset),
      tint: healthTint(ratio),
      label: (categoryCounts.get(category) ?? 0) > 1
        ? asset.name
        : PROPERTY_HEALTH_CATEGORY_META[category].label,
    });
  }

  // Draw top-down so a lower pin's label never covers the pin above it.
  pins.sort((a, b) => a.anchor.y - b.anchor.y);
  return spreadCollisions(pins);
}

/** Roughly the pin diameter plus its label, in cutaway units. */
const PIN_CLEAR_X = 108;
const PIN_CLEAR_Y = 40;
const PIN_STEP_Y = 46;

/**
 * Lifts pins that would sit on top of each other.
 *
 * The water heater and the furnace stand about fifty units apart on the same
 * basement wall, which is close enough that their rings touched and their
 * labels ran through one another. Rather than hand-placing every pair that
 * could ever collide, each pin is pushed up until it is clear of the ones
 * already placed — a component that has moved is still next to its fixture,
 * where an unreadable one is worse than slightly misplaced.
 */
function spreadCollisions(pins: HealthPin[]): HealthPin[] {
  const placed: HealthAnchor[] = [];

  return pins.map((pin) => {
    let { x, y, side } = pin.anchor;
    let guard = 0;

    while (
      guard < 6
      && placed.some((p) => Math.abs(p.x - x) < PIN_CLEAR_X && Math.abs(p.y - y) < PIN_CLEAR_Y)
    ) {
      y -= PIN_STEP_Y;
      guard += 1;
    }

    // Still crowded after lifting: send the label the other way so at least the
    // two texts do not overlap.
    const crowdedSameSide = placed.some(
      (p) => p.side === side && Math.abs(p.x - x) < PIN_CLEAR_X && Math.abs(p.y - y) < PIN_CLEAR_Y * 2,
    );
    if (crowdedSameSide) side = side === 'left' ? 'right' : 'left';

    // Spread only moves the pin; which room the component is in is unchanged.
    const anchor: HealthAnchor = { ...pin.anchor, x, y, side };
    placed.push(anchor);
    return { ...pin, anchor };
  });
}

/* ── flood crossover ───────────────────────────────────────────────── */

export interface HazardCrossover {
  assetId: string;
  category: PropertyHealthCategory;
  /** The flood threshold this component sits at or below. */
  thresholdId: string;
  thresholdLabel: string;
  levelFt: number;
  severity: 'info' | 'warn' | 'critical';
  headline: string;
  detail: string;
}

/**
 * Where a component's age and its exposure to flooding compound each other.
 *
 * Either fact alone is ordinary: plenty of water heaters are old, and plenty
 * of basements take a foot of water. Together they change the recommendation —
 * a heater with two years left that sits under the pilot-submersion line is
 * worth replacing on a schedule and raising onto a stand, rather than waiting
 * for it to fail on its own terms. That is the advice neither page could give
 * by itself, so it is computed here from both.
 */
export function buildHazardCrossovers(
  assets: PropertyHealthAsset[],
  rooms: RoomDef[],
  scenarioDepthFt: number | null,
  now = new Date(),
): HazardCrossover[] {
  if (scenarioDepthFt == null || scenarioDepthFt <= 0) return [];

  const waterY = waterLevelToY(scenarioDepthFt);
  const out: HazardCrossover[] = [];

  for (const asset of assets) {
    if (asset.notApplicable) continue;

    const anchor = healthAnchorFor(asset.category, rooms);
    if (!anchor) continue;

    // The anchor is lifted above the fixture for legibility, so the exposure
    // test uses the fixture's own base rather than where its pin is drawn.
    const baseY = anchor.y + PIN_LIFT;
    if (baseY < waterY) continue;

    const threshold =
      [...FLOOD_THRESHOLDS]
        .filter((t) => t.levelFt <= scenarioDepthFt)
        .sort((a, b) => b.levelFt - a.levelFt)[0] ?? FLOOD_THRESHOLDS[0];

    const ratio = resolveLifeUsedRatio(asset, now);
    const life = resolveUsefulLifeYears(asset);
    const age = resolveAssetAgeYears(asset, now);
    const yearsLeft = age == null ? null : Math.max(0, Math.round(life - age));

    const aging = ratio != null && ratio >= 0.65;
    const severity: HazardCrossover['severity'] = aging
      ? threshold.severity === 'info' ? 'warn' : 'critical'
      : threshold.severity;

    const meta = PROPERTY_HEALTH_CATEGORY_META[asset.category];
    const headline = aging
      ? `${meta.label} is aging and sits in the flood path`
      : `${meta.label} sits in the flood path`;

    const detail = aging
      ? `${asset.name} has about ${yearsLeft ?? 0} year${yearsLeft === 1 ? '' : 's'} of life left and stands below the `
        + `${scenarioDepthFt.toFixed(1)} ft line, where ${threshold.label.toLowerCase()} is reached. `
        + `Replacing it early on a raised stand costs about $${meta.typicalReplacementUsd.toLocaleString()} `
        + 'and avoids paying for the same unit twice.'
      : `${asset.name} stands below the ${scenarioDepthFt.toFixed(1)} ft line, where `
        + `${threshold.label.toLowerCase()} is reached. Raising it or fitting a flood cut-off protects `
        + `about $${meta.typicalReplacementUsd.toLocaleString()} of equipment.`;

    out.push({
      assetId: asset.id,
      category: asset.category,
      thresholdId: threshold.id,
      thresholdLabel: threshold.label,
      levelFt: threshold.levelFt,
      severity,
      headline,
      detail,
    });
  }

  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Kept next to the anchors so the pin and its shadow agree on the offset. */
export const HEALTH_PIN_DEPTH = { dx: DX, dy: DY };
