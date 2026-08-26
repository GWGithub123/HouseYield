const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function calculateObservedRentalVacancy({
  renterOccupied,
  vacantForRent,
  rentedNotOccupied,
  occupiedMoe = 0,
  vacantMoe = 0,
  rentedNotOccupiedMoe = 0,
}) {
  const rentalInventory = renterOccupied + vacantForRent + rentedNotOccupied;
  if (![renterOccupied, vacantForRent, rentedNotOccupied].every(Number.isFinite) || rentalInventory <= 0) {
    return null;
  }
  const vacancyRate = (vacantForRent / rentalInventory) * 100;
  const inventoryMoe = Math.sqrt(
    occupiedMoe ** 2 + vacantMoe ** 2 + rentedNotOccupiedMoe ** 2,
  );
  const vacancyRateMoe = Math.min(
    100,
    100 * Math.sqrt(
      (vacantMoe / rentalInventory) ** 2
      + ((vacantForRent * inventoryMoe) / rentalInventory ** 2) ** 2,
    ),
  );
  return {
    rentalInventory,
    vacancyRate: round(vacancyRate),
    vacancyRateMoe: round(vacancyRateMoe),
  };
}

/**
 * ACS rental vacancy is structurally observed, not real-time:
 * vacant-for-rent / (renter occupied + vacant-for-rent + rented-not-occupied).
 * ZCTA is used because the pricing endpoint already has ZIP and it avoids
 * pretending that a broad national FRED series is local evidence.
 */
export async function getLocalRentalVacancy(zipCode, { skipCache = false } = {}) {
  const zip = String(zipCode || '').replace(/\D/g, '').slice(0, 5);
  if (zip.length !== 5) return { ok: false, error: 'invalid_zip_code' };

  const key = `latest:${zip}`;
  const cached = cache.get(key);
  if (!skipCache && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { ...cached.value, fromCache: true };
  }

  const geoId = `86000US${zip}`;
  // Census Reporter exposes the official latest ACS tables without requiring
  // an application API key. The source tables and release are returned intact.
  const url = new URL('https://api.censusreporter.org/1.0/data/show/latest');
  url.searchParams.set('table_ids', 'B25003,B25004');
  url.searchParams.set('geo_ids', geoId);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return { ok: false, error: `census_http_${response.status}` };
    }
    const payload = await response.json();
    const geographyData = payload?.data?.[geoId];
    if (!geographyData) {
      return { ok: false, error: 'census_no_data' };
    }

    const renterOccupied = number(geographyData.B25003?.estimate?.B25003003);
    const vacantForRent = number(geographyData.B25004?.estimate?.B25004002);
    const rentedNotOccupied = number(geographyData.B25004?.estimate?.B25004003);
    if (renterOccupied == null || vacantForRent == null || rentedNotOccupied == null) {
      return { ok: false, error: 'census_incomplete_data' };
    }

    const vacantMoe = number(geographyData.B25004?.error?.B25004002) || 0;
    const occupiedMoe = number(geographyData.B25003?.error?.B25003003) || 0;
    const rentedNotOccupiedMoe = number(geographyData.B25004?.error?.B25004003) || 0;
    const calculated = calculateObservedRentalVacancy({
      renterOccupied,
      vacantForRent,
      rentedNotOccupied,
      occupiedMoe,
      vacantMoe,
      rentedNotOccupiedMoe,
    });
    if (!calculated) return { ok: false, error: 'census_zero_inventory' };

    const value = {
      ok: true,
      geography: 'ZCTA',
      zipCode: zip,
      geographyName: payload?.geography?.[geoId]?.name || `ZCTA ${zip}`,
      survey: payload?.release?.name || 'Latest ACS 5-year',
      vintageYear: Number(String(payload?.release?.id || '').match(/acs(\d{4})/)?.[1]) || null,
      vacancyRate: calculated.vacancyRate,
      vacancyRateMoe: calculated.vacancyRateMoe,
      renterOccupied,
      vacantForRent,
      rentedNotOccupied,
      rentalInventory: calculated.rentalInventory,
      definition: 'Vacant for rent divided by renter-occupied, vacant-for-rent, and rented-not-occupied units.',
      limitation: 'Observed structural vacancy from a lagged five-year survey; RentCast listing signals provide the current-market adjustment.',
      sourceUrl: url.toString(),
      sourceApi: 'Census Reporter (official ACS tables B25003 and B25004)',
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
    cache.set(key, { cachedAt: Date.now(), value });
    return value;
  } catch (error) {
    return { ok: false, error: error.message || 'census_fetch_failed' };
  }
}

