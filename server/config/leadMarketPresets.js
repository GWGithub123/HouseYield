/**
 * Geographic presets for internal lead search campaigns.
 */

export const LEAD_MARKET_PRESETS = {
  umd_college_park: {
    id: 'umd_college_park',
    label: 'UMD / College Park',
    description: 'Mom-and-pop absentee SFR owners near College Park (excludes corporate apartments/condos)',
    lat: 38.9869,
    lng: -76.9426,
    radiusMiles: 2.5,
    // ZIP list covers campus + surrounding SFR neighborhoods (University Park,
    // Berwyn Heights, Riverdale, Hyattsville, Greenbelt). Radius mode only returns
    // the densest parcels nearest campus, which are mostly condo/apt buildings.
    // Prefer surrounding SFR neighborhoods over campus-core ZIPs (20741/20742 are
    // PO-box / campus parcels dominated by corporate apartments and condos).
    zips: ['20740', '20737', '20770', '20781', '20782', '20783'],
    countyFips: '24033',
    preferredSearchMode: 'zips',
    defaultFilters: {
      propertyType: 'SFR',
      individualsOnly: true,
      corporateOnly: false,
      outOfStateOnly: false,
      minYearsOwned: 0,
    },
  },
};

export function getLeadMarketPreset(presetId) {
  return LEAD_MARKET_PRESETS[presetId] || null;
}

export function listLeadMarketPresets() {
  return Object.values(LEAD_MARKET_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    zips: preset.zips,
    lat: preset.lat,
    lng: preset.lng,
    radiusMiles: preset.radiusMiles,
    countyFips: preset.countyFips,
    preferredSearchMode: preset.preferredSearchMode || 'zips',
    defaultFilters: preset.defaultFilters,
  }));
}

export function resolvePresetSearchPlans(presetId, searchMode = 'zips') {
  const preset = getLeadMarketPreset(presetId);
  if (!preset) return null;

  const mode = searchMode || preset.preferredSearchMode || 'zips';

  if (mode === 'county' && preset.countyFips) {
    return [{ county: preset.countyFips }];
  }

  if (mode === 'radius' && preset.lat && preset.lng) {
    return [{
      latitude: preset.lat,
      longitude: preset.lng,
      radius: preset.radiusMiles || 2.5,
    }];
  }

  if (preset.zips?.length) {
    return preset.zips.map((zipCode) => ({ zipCode }));
  }

  if (preset.lat && preset.lng) {
    return [{
      latitude: preset.lat,
      longitude: preset.lng,
      radius: preset.radiusMiles || 2.5,
    }];
  }

  return [];
}
