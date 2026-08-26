import type { BuildingPermit } from '../types/attom';
import {
  HEALTH_WORK_KIND_META,
  PROPERTY_HEALTH_CATEGORY_META,
  type HealthEvidence,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../types/propertyHealth';

/**
 * One chronology of everything that has happened to the building.
 *
 * The facts already exist, scattered across permits, the component inventory,
 * the spend recorded against each, and completed maintenance visits. What
 * they lack is a single ordering, which is the thing an owner actually reads and
 * the thing that makes the record compound: two roof repairs eighteen months
 * apart mean something the two rows on their own do not.
 *
 * Sources are merged rather than concatenated. A permit and an install date that
 * describe the same work would otherwise read as two separate events, and the
 * history would overstate how much has been done to the house.
 */

export type HistoryEventKind =
  | 'permit'
  | 'install'
  | 'repair'
  | 'service'
  | 'inspection'
  | 'document';

export const HISTORY_EVENT_META: Record<
  HistoryEventKind,
  { label: string; tone: 'positive' | 'info' | 'warn' | 'neutral' }
> = {
  permit: { label: 'Permit', tone: 'neutral' },
  install: { label: 'Installed', tone: 'positive' },
  repair: { label: 'Repair', tone: 'warn' },
  service: { label: 'Service', tone: 'info' },
  inspection: { label: 'Inspection', tone: 'info' },
  document: { label: 'Record', tone: 'neutral' },
};

export interface PropertyHistoryEvent {
  id: string;
  /** ISO date. Day precision: none of these sources record a time. */
  occurredAt: string;
  kind: HistoryEventKind;
  title: string;
  detail?: string;
  category?: PropertyHealthCategory;
  assetId?: string;
  amountUsd?: number | null;
  vendor?: string;
  evidence?: HealthEvidence;
  /** Set when a permit and a recorded install describe the same work. */
  corroboratedBy?: string;
}

/** A completed maintenance visit, as stored on `serviceRecords`. */
export interface TimelineServiceRecord {
  requestId?: string;
  completedAt?: string;
  category?: string;
  serviceType?: string;
  providerName?: string;
  diagnosis?: string;
  workPerformed?: string;
  totals?: { total?: number };
}

function toDay(value?: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/** Maps a maintenance category string onto our inventory categories, loosely. */
function categoryFromText(text?: string): PropertyHealthCategory | undefined {
  const value = (text || '').toLowerCase();
  if (!value) return undefined;
  if (/roof|shingle|gutter/.test(value)) return 'roof';
  if (/hvac|furnace|air.?condition|heat.?pump|ac\b/.test(value)) return 'hvac';
  if (/water.?heater|boiler/.test(value)) return 'water_heater';
  if (/window|glaz/.test(value)) return 'windows';
  if (/plumb|pipe|leak|drain|sewer/.test(value)) return 'plumbing';
  if (/electric|panel|wiring|breaker/.test(value)) return 'electrical';
  if (/appliance|dishwasher|refrigerat|washer|dryer|oven/.test(value)) return 'appliance';
  if (/filter/.test(value)) return 'air_filter';
  if (/siding|paint|deck|exterior|fence/.test(value)) return 'exterior';
  return undefined;
}

function eventsFromAssets(assets: PropertyHealthAsset[]): PropertyHistoryEvent[] {
  const events: PropertyHistoryEvent[] = [];

  for (const asset of assets) {
    if (asset.notApplicable) continue;
    const label = PROPERTY_HEALTH_CATEGORY_META[asset.category]?.label ?? asset.name;

    const installedAt = toDay(asset.installedAt);
    if (installedAt) {
      events.push({
        id: `install-${asset.id}`,
        occurredAt: installedAt,
        kind: 'install',
        title: `${asset.name || label} installed`,
        detail: [asset.make, asset.model].filter(Boolean).join(' ') || undefined,
        category: asset.category,
        assetId: asset.id,
        evidence: asset.provenance?.installedAt?.evidence ?? asset.evidence,
      });
    }

    for (const spend of asset.spend ?? []) {
      const occurredAt = toDay(spend.occurredAt);
      if (!occurredAt) continue;

      /*
       * A replacement recorded as spend is the same event as the install date it
       * produced, so it is emitted as cost on the install rather than as a second
       * entry. Without this every documented replacement would appear twice.
       */
      const datesComponent = HEALTH_WORK_KIND_META[spend.workKind].datesComponent;
      if (datesComponent && installedAt && daysApart(installedAt, occurredAt) <= 31) {
        const install = events.find((event) => event.id === `install-${asset.id}`);
        if (install) {
          install.amountUsd = (install.amountUsd ?? 0) + spend.amountUsd;
          install.vendor = install.vendor || spend.vendor;
          continue;
        }
      }

      events.push({
        id: `spend-${asset.id}-${spend.id}`,
        occurredAt,
        kind: spend.workKind === 'inspect'
          ? 'inspection'
          : spend.workKind === 'repair'
            ? 'repair'
            : datesComponent
              ? 'install'
              : 'service',
        title: `${asset.name || label} ${HEALTH_WORK_KIND_META[spend.workKind].label.toLowerCase()}`,
        detail: spend.description,
        category: asset.category,
        assetId: asset.id,
        amountUsd: spend.amountUsd,
        vendor: spend.vendor,
        evidence: 'document',
      });
    }
  }

  return events;
}

function eventsFromPermits(permits: BuildingPermit[]): PropertyHistoryEvent[] {
  return permits
    .map((permit, index): PropertyHistoryEvent | null => {
      const occurredAt = toDay(permit.issue_date);
      if (!occurredAt) return null;

      return {
        id: `permit-${permit.permit_number || index}`,
        occurredAt,
        kind: 'permit',
        title: permit.permit_type_description || permit.permit_type || 'Building permit',
        detail: permit.work_description,
        category: categoryFromText(
          `${permit.permit_type_description || ''} ${permit.permit_type || ''} ${permit.work_description || ''}`,
        ),
        amountUsd: typeof permit.estimated_cost === 'number' && permit.estimated_cost > 0
          ? permit.estimated_cost
          : null,
        vendor: permit.contractor_company || permit.contractor_name,
        evidence: 'permit',
      };
    })
    .filter((event): event is PropertyHistoryEvent => event !== null);
}

function eventsFromServiceRecords(records: TimelineServiceRecord[]): PropertyHistoryEvent[] {
  return records
    .map((record, index): PropertyHistoryEvent | null => {
      const occurredAt = toDay(record.completedAt);
      if (!occurredAt) return null;

      return {
        id: `visit-${record.requestId || index}`,
        occurredAt,
        kind: 'service',
        title: record.serviceType || record.category || 'Maintenance visit',
        detail: record.workPerformed || record.diagnosis,
        category: categoryFromText(`${record.category || ''} ${record.serviceType || ''}`),
        amountUsd: typeof record.totals?.total === 'number' ? record.totals.total : null,
        vendor: record.providerName,
        // A technician was physically on site, which is the strongest thing we have.
        evidence: 'service',
      };
    })
    .filter((event): event is PropertyHistoryEvent => event !== null);
}

/**
 * Folds a permit into an install event describing the same work.
 *
 * Permits are pulled from public records and installs come from receipts or the
 * owner, so the same roof replacement routinely arrives from both. Matching on
 * category within a window keeps one event carrying both citations instead of
 * two that look like two roofs.
 */
function corroborate(events: PropertyHistoryEvent[]): PropertyHistoryEvent[] {
  const kept: PropertyHistoryEvent[] = [];

  for (const event of events) {
    if (event.kind !== 'permit') {
      kept.push(event);
      continue;
    }

    const match = events.find(
      (other) =>
        other.kind === 'install'
        && other.category
        && other.category === event.category
        // Permits are pulled before work starts, so the install trails the permit.
        && daysApart(other.occurredAt, event.occurredAt) <= 365,
    );

    if (match) {
      match.corroboratedBy = event.title;
      match.vendor = match.vendor || event.vendor;
      continue;
    }

    kept.push(event);
  }

  return kept;
}

export interface TimelineInput {
  assets: PropertyHealthAsset[];
  permits?: BuildingPermit[];
  serviceRecords?: TimelineServiceRecord[];
}

export function buildPropertyHistoryTimeline({
  assets,
  permits = [],
  serviceRecords = [],
}: TimelineInput): PropertyHistoryEvent[] {
  const merged = corroborate([
    ...eventsFromAssets(assets),
    ...eventsFromPermits(permits),
    ...eventsFromServiceRecords(serviceRecords),
  ]);

  return merged.sort((a, b) => {
    if (a.occurredAt === b.occurredAt) return a.title.localeCompare(b.title);
    return a.occurredAt < b.occurredAt ? 1 : -1;
  });
}

export interface TimelineYearGroup {
  year: number;
  events: PropertyHistoryEvent[];
  spendUsd: number;
}

/** Groups newest-first by year, with each year's recorded spend. */
export function groupTimelineByYear(events: PropertyHistoryEvent[]): TimelineYearGroup[] {
  const byYear = new Map<number, PropertyHistoryEvent[]>();

  for (const event of events) {
    const year = Number(event.occurredAt.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const bucket = byYear.get(year);
    if (bucket) bucket.push(event);
    else byYear.set(year, [event]);
  }

  return [...byYear.entries()]
    .map(([year, yearEvents]) => ({
      year,
      events: yearEvents,
      spendUsd: yearEvents.reduce((sum, event) => sum + (event.amountUsd ?? 0), 0),
    }))
    .sort((a, b) => b.year - a.year);
}
