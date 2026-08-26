import { useEffect, useMemo, useState } from 'react';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import {
  buildPropertyHealthPriors,
  mergePriorsWithSaved,
} from '../services/propertyHealthPriors';
import {
  buildAssetsFromPermits,
  mergePermitAssets,
} from '../services/propertyHealthPermits';
import type { BuildingPermit } from '../types/attom';
import type { PropertyHealthAsset } from '../types/propertyHealth';

/**
 * The property's component inventory, as anyone outside the Health tab should
 * read it.
 *
 * The saved rows on their own are not the inventory — they are only what the
 * owner has got round to entering. What is actually known is those rows layered
 * with what can be worked out for them: permits override vintage guesses, and
 * both defer to anything the owner or a technician confirmed. That layering was
 * written inside `PropertyHealthTab`, so the twin on Predictive Maintenance
 * would have drawn a different, emptier house than the Health tab describes.
 * Both read it from here now.
 */

export interface PropertyHealthContext {
  ownerId?: string | null;
  propertyId?: string | null;
  propertyAddress?: string;
  yearBuilt?: number | null;
  buildingPermits?: BuildingPermit[];
  state?: string | null;
  county?: string | null;
}

export interface PropertyHealthAssetsResult {
  /** Saved rows plus inferred and permit-derived ones, tombstones removed. */
  assets: PropertyHealthAsset[];
  /** Only what is persisted, for callers that need to write it back. */
  savedAssets: PropertyHealthAsset[];
  loading: boolean;
  error: string | null;
}

export function usePropertyHealthAssets({
  ownerId,
  propertyId,
  propertyAddress,
  yearBuilt,
  buildingPermits,
  state,
  county,
}: PropertyHealthContext): PropertyHealthAssetsResult {
  const [savedAssets, setSavedAssets] = useState<PropertyHealthAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    async function load() {
      if (!ownerId || !propertyId) {
        setSavedAssets([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const next = await ownerPropertiesClient.getHealthAssets(ownerId, propertyId);
        if (!ignore) setSavedAssets(next);
      } catch (err) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Failed to load property health');
          setSavedAssets([]);
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void load();
    return () => {
      ignore = true;
    };
  }, [ownerId, propertyId]);

  // Identity-stable so a caller passing a fresh [] every render does not
  // rebuild the priors on every pass.
  const permitKey = JSON.stringify(buildingPermits ?? []);

  const assets = useMemo(() => {
    const permitAssets = buildAssetsFromPermits(buildingPermits ?? []);
    const { assets: priorAssets } = buildPropertyHealthPriors({
      yearBuilt,
      address: propertyAddress,
      state,
      county,
    });

    const withPriors = mergePriorsWithSaved(savedAssets, priorAssets);
    // Tombstones exist only to stop the priors engine re-suggesting something
    // the owner said the property does not have. Not part of the inventory.
    return mergePermitAssets(withPriors, permitAssets).filter((asset) => !asset.notApplicable);
  }, [savedAssets, permitKey, yearBuilt, propertyAddress, state, county]);

  return { assets, savedAssets, loading, error };
}

export default usePropertyHealthAssets;
