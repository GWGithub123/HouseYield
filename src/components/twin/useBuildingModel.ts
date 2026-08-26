/**
 * Loads a property's stacking plan: how many floors, how many units per floor,
 * whether there is a corridor with units on both sides, whether the risers are
 * shared, and whether there is a basement.
 *
 * ## Two sources, in a deliberate order
 *
 * The guess comes from cached ATTOM stories and unit counts, which are frequently
 * wrong and often silent. A confirmed plan comes from whoever manages the
 * building. The confirmed one always wins, and it is the only one that persists —
 * a manager should not be asked the same four questions every time the ATTOM
 * cache turns over.
 *
 * ## Why the guess is shown at all
 *
 * Because a building on screen that is slightly wrong gets corrected, and an
 * empty state does not. `needsConfirmation` is what keeps that honest: until
 * someone confirms, the twin says so, and we do not use the plan to make
 * confident claims about which specific apartment is exposed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  specFromDerivation,
  type BuildingSpec,
  type DerivedBuildingGeometry,
} from './buildingModel';

export interface BuildingModelState {
  spec: BuildingSpec;
  /** True once a person has confirmed the plan, not merely edited it. */
  confirmed: boolean;
  /** True when ATTOM (passed in or fetched from cache) produced a stacking guess. */
  hasSeed: boolean;
  loading: boolean;
  /** Non-fatal: a failed load leaves the ATTOM-seeded guess in place. */
  error: string | null;
  save: (spec: BuildingSpec, options?: { confirmedBy?: string | null }) => Promise<boolean>;
}

interface Options {
  propertyId?: string | null;
  /** `building_geometry` from the dashboard payload. */
  derived?: DerivedBuildingGeometry | null;
  /** Used to seed from the cache-first parcel-geometry route when `derived` is missing. */
  address?: string | null;
  attomId?: string | null;
  apiBase?: string;
}

export function useBuildingModel({
  propertyId,
  derived,
  address,
  attomId,
  apiBase = '',
}: Options): BuildingModelState {
  const [saved, setSaved] = useState<BuildingSpec | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [fetchedDerived, setFetchedDerived] = useState<DerivedBuildingGeometry | null>(null);
  const [loading, setLoading] = useState(Boolean(propertyId));
  const [error, setError] = useState<string | null>(null);
  /*
   * A plan confirmed in this session must survive a GET miss.
   *
   * Save used to wait for Firestore before updating the drawing. When the write
   * failed — or a later load effect (address / ATTOM seed changing) came back
   * empty — the editor looked like it had done nothing. Apply locally first,
   * and do not let a miss wipe that confirmation.
   */
  const appliedLocally = useRef(false);
  const propertyIdRef = useRef(propertyId);
  if (propertyIdRef.current !== propertyId) {
    propertyIdRef.current = propertyId;
    appliedLocally.current = false;
  }

  const seed = derived ?? fetchedDerived;
  const seeded = useMemo(() => specFromDerivation(seed), [seed]);

  useEffect(() => {
    if (!propertyId) {
      if (!appliedLocally.current) {
        setSaved(null);
        setConfirmed(false);
      }
      setFetchedDerived(null);
      setLoading(false);
      return undefined;
    }

    let live = true;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const response = await fetch(`${apiBase}/api/twin/building-model/${encodeURIComponent(propertyId)}`);
        if (!response.ok) throw new Error('load_failed');
        const body = await response.json();
        if (!live) return;
        if (body?.model?.spec) {
          setSaved(body.model.spec as BuildingSpec);
          setConfirmed(Boolean(body.model.confirmedBy));
        } else if (!appliedLocally.current) {
          setSaved(null);
          setConfirmed(false);
        }
      } catch {
        if (!live) return;
        setError('Could not load the saved stacking plan');
      }

      /*
       * Seed from the ATTOM cache when the parent did not already pass one.
       *
       * `/api/attom/parcel-geometry` is cache-first, so this does not spend a
       * live ATTOM call on a property we have already looked up. Without it a
       * multifamily building with no saved plan would keep drawing as a house.
       */
      if (!derived && (address || attomId)) {
        try {
          const params = new URLSearchParams();
          if (attomId) params.set('attomId', attomId);
          else if (address) params.set('address', address);
          const geo = await fetch(`${apiBase}/api/attom/parcel-geometry?${params.toString()}`);
          if (!live) return;
          if (geo.ok) {
            const body = await geo.json();
            setFetchedDerived(body?.building_geometry ?? null);
          }
        } catch {
          if (live) setFetchedDerived(null);
        }
      } else if (!derived) {
        setFetchedDerived(null);
      }

      if (live) setLoading(false);
    };

    void load();

    return () => {
      live = false;
    };
  }, [propertyId, apiBase, derived, address, attomId]);

  const save = useCallback(async (
    spec: BuildingSpec,
    { confirmedBy = null }: { confirmedBy?: string | null } = {},
  ) => {
    const local: BuildingSpec = {
      ...spec,
      needsConfirmation: confirmedBy ? false : spec.needsConfirmation,
      confidence: confirmedBy ? 'high' : spec.confidence,
    };
    setSaved(local);
    setConfirmed(true);
    appliedLocally.current = true;

    if (!propertyId) {
      setError('Could not save — this property has no id yet. The building view is still using what you entered.');
      return true;
    }

    try {
      const response = await fetch(
        `${apiBase}/api/twin/building-model/${encodeURIComponent(propertyId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spec: local, confirmedBy }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `save_failed_${response.status}`);
      }
      const body = await response.json();
      if (body?.model?.spec) {
        setSaved(body.model.spec as BuildingSpec);
        setConfirmed(true);
      }
      setError(null);
      return true;
    } catch (err) {
      const detail = err instanceof Error && err.message ? err.message : 'save_failed';
      setError(`Could not save the stacking plan (${detail}). The building view is still using what you entered.`);
      return true;
    }
  }, [propertyId, apiBase]);

  return {
    spec: saved ?? seeded,
    confirmed,
    hasSeed: Boolean(seed),
    loading,
    error,
    save,
  };
}

export default useBuildingModel;
