import { getCachedZipMarketData, setCachedZipMarketData } from './zip-market-cache.js';
import { getCachedDoc, setCachedDoc, hashCacheKey } from './firestore-doc-cache.js';
import { reserveRentcastCall } from './rentcast-usage-limiter.js';

const RENTCAST_API_BASE_URL = 'https://api.rentcast.io/v1';
const RENTCAST_CACHE_TTL_MS = 1000 * 60 * 30;

const SALE_LISTINGS_CACHE_COLLECTION = 'rentcast_sale_listings_cache';
const SALE_LISTINGS_TTL_HOURS = 6;
const AVM_CACHE_COLLECTION = 'rentcast_avm_cache';
const AVM_TTL_HOURS = 24 * 7;
const GEOCODE_CACHE_COLLECTION = 'maps_geocode_cache';
const GEOCODE_TTL_HOURS = 24 * 30;

const ZIP_MARKET_CACHE = new Map();

const METRO_ZIP_PROFILES = {
  austin: {
    cbsa: '12420',
    name: 'Austin, TX',
    zips: [
      { zipCode: '78701', label: 'Downtown', lat: 30.2714, lng: -97.742 },
      { zipCode: '78702', label: 'East Austin', lat: 30.2606, lng: -97.7142 },
      { zipCode: '78704', label: 'South Lamar', lat: 30.2442, lng: -97.7611 },
      { zipCode: '78745', label: 'South Austin', lat: 30.2095, lng: -97.7956 },
      { zipCode: '78758', label: 'North Burnet', lat: 30.3901, lng: -97.7062 }
    ]
  },
  'san-francisco': {
    cbsa: '41860',
    name: 'San Francisco, CA',
    zips: [
      { zipCode: '94103', label: 'SoMa', lat: 37.7739, lng: -122.4112 },
      { zipCode: '94107', label: 'Mission Bay', lat: 37.7677, lng: -122.3927 },
      { zipCode: '94110', label: 'Mission District', lat: 37.7487, lng: -122.4158 },
      { zipCode: '94607', label: 'Downtown Oakland', lat: 37.8047, lng: -122.2712 },
      { zipCode: '94704', label: 'UC Berkeley', lat: 37.8666, lng: -122.2576 }
    ]
  },
  'new-york': {
    cbsa: '35620',
    name: 'New York, NY',
    zips: [
      { zipCode: '10011', label: 'Chelsea', lat: 40.7424, lng: -74.0007 },
      { zipCode: '11101', label: 'Long Island City', lat: 40.7447, lng: -73.9495 },
      { zipCode: '11201', label: 'Downtown Brooklyn', lat: 40.6943, lng: -73.9918 },
      { zipCode: '07030', label: 'Hoboken', lat: 40.744, lng: -74.0324 },
      { zipCode: '07302', label: 'Jersey City Waterfront', lat: 40.7193, lng: -74.0462 }
    ]
  },
  'los-angeles': {
    cbsa: '31080',
    name: 'Los Angeles, CA',
    zips: [
      { zipCode: '90026', label: 'Echo Park', lat: 34.0795, lng: -118.2591 },
      { zipCode: '90066', label: 'Mar Vista', lat: 34.0026, lng: -118.4298 },
      { zipCode: '90291', label: 'Venice', lat: 33.9943, lng: -118.4635 },
      { zipCode: '90401', label: 'Santa Monica', lat: 34.0147, lng: -118.4924 },
      { zipCode: '91505', label: 'Burbank Media District', lat: 34.1678, lng: -118.3449 }
    ]
  },
  chicago: {
    cbsa: '16980',
    name: 'Chicago, IL',
    zips: [
      { zipCode: '60614', label: 'Lincoln Park', lat: 41.9227, lng: -87.6525 },
      { zipCode: '60622', label: 'Wicker Park', lat: 41.9026, lng: -87.6818 },
      { zipCode: '60647', label: 'Logan Square', lat: 41.9216, lng: -87.7017 },
      { zipCode: '60657', label: 'Lakeview', lat: 41.9407, lng: -87.6525 },
      { zipCode: '60201', label: 'Evanston', lat: 42.0563, lng: -87.6986 }
    ]
  },
  dc: {
    cbsa: '47900',
    name: 'Washington, DC',
    zips: [
      { zipCode: '20002', label: 'Capitol Hill East', lat: 38.9007, lng: -76.9909 },
      { zipCode: '20009', label: 'U Street / Adams Morgan', lat: 38.9191, lng: -77.036 },
      { zipCode: '20814', label: 'Bethesda', lat: 38.9862, lng: -77.0998 },
      { zipCode: '22201', label: 'Clarendon', lat: 38.8869, lng: -77.0947 },
      { zipCode: '22314', label: 'Old Town Alexandria', lat: 38.8048, lng: -77.0469 }
    ]
  },
  miami: {
    cbsa: '33100',
    name: 'Miami, FL',
    zips: [
      { zipCode: '33020', label: 'Hollywood', lat: 26.0112, lng: -80.1495 },
      { zipCode: '33131', label: 'Brickell', lat: 25.7669, lng: -80.1908 },
      { zipCode: '33133', label: 'Coconut Grove', lat: 25.7303, lng: -80.2459 },
      { zipCode: '33139', label: 'South Beach', lat: 25.7836, lng: -80.134 },
      { zipCode: '33301', label: 'Las Olas', lat: 26.119, lng: -80.1373 }
    ]
  },
  seattle: {
    cbsa: '42660',
    name: 'Seattle, WA',
    zips: [
      { zipCode: '98004', label: 'Downtown Bellevue', lat: 47.6163, lng: -122.2031 },
      { zipCode: '98052', label: 'Redmond', lat: 47.6762, lng: -122.1215 },
      { zipCode: '98103', label: 'Fremont / Wallingford', lat: 47.6721, lng: -122.342 },
      { zipCode: '98109', label: 'South Lake Union', lat: 47.6348, lng: -122.3476 },
      { zipCode: '98115', label: 'Roosevelt', lat: 47.6846, lng: -122.3047 }
    ]
  },
  denver: {
    cbsa: '19740',
    name: 'Denver, CO',
    zips: [
      { zipCode: '80014', label: 'Aurora City Center', lat: 39.6661, lng: -104.8356 },
      { zipCode: '80111', label: 'DTC', lat: 39.6106, lng: -104.8801 },
      { zipCode: '80205', label: 'RiNo / Five Points', lat: 39.7587, lng: -104.9672 },
      { zipCode: '80206', label: 'Cherry Creek', lat: 39.7312, lng: -104.9522 },
      { zipCode: '80218', label: 'Capitol Hill', lat: 39.7319, lng: -104.9719 }
    ]
  },
  boston: {
    cbsa: '14460',
    name: 'Boston, MA',
    zips: [
      { zipCode: '02116', label: 'Back Bay', lat: 42.3503, lng: -71.0772 },
      { zipCode: '02118', label: 'South End', lat: 42.3389, lng: -71.0768 },
      { zipCode: '02127', label: 'South Boston', lat: 42.3348, lng: -71.0416 },
      { zipCode: '02139', label: 'Central Square', lat: 42.3646, lng: -71.1037 },
      { zipCode: '02446', label: 'Brookline', lat: 42.3431, lng: -71.1234 }
    ]
  },
  phoenix: {
    cbsa: '38060',
    name: 'Phoenix, AZ',
    zips: [
      { zipCode: '85016', label: 'Biltmore', lat: 33.5096, lng: -112.0306 },
      { zipCode: '85018', label: 'Arcadia', lat: 33.5024, lng: -111.9866 },
      { zipCode: '85032', label: 'Paradise Valley Village', lat: 33.6239, lng: -112.0034 },
      { zipCode: '85251', label: 'Old Town Scottsdale', lat: 33.4942, lng: -111.9261 },
      { zipCode: '85260', label: 'North Scottsdale', lat: 33.6037, lng: -111.8896 }
    ]
  },
  dallas: {
    cbsa: '19100',
    name: 'Dallas, TX',
    zips: [
      { zipCode: '75024', label: 'Legacy West', lat: 33.0784, lng: -96.8266 },
      { zipCode: '75204', label: 'Uptown East', lat: 32.8049, lng: -96.7878 },
      { zipCode: '75206', label: 'Lower Greenville', lat: 32.8266, lng: -96.7711 },
      { zipCode: '75219', label: 'Oak Lawn', lat: 32.8164, lng: -96.8109 },
      { zipCode: '76006', label: 'North Arlington', lat: 32.7797, lng: -97.0904 }
    ]
  },
  atlanta: {
    cbsa: '12060',
    name: 'Atlanta, GA',
    zips: [
      { zipCode: '30080', label: 'Smyrna', lat: 33.8794, lng: -84.5021 },
      { zipCode: '30305', label: 'Buckhead', lat: 33.8315, lng: -84.3853 },
      { zipCode: '30309', label: 'Midtown', lat: 33.7986, lng: -84.3886 },
      { zipCode: '30318', label: 'West Midtown', lat: 33.7868, lng: -84.445 },
      { zipCode: '30324', label: 'Lindbergh', lat: 33.8202, lng: -84.3575 }
    ]
  },
  houston: {
    cbsa: '26420',
    name: 'Houston, TX',
    zips: [
      { zipCode: '77007', label: 'Washington Corridor', lat: 29.771, lng: -95.4115 },
      { zipCode: '77008', label: 'Heights', lat: 29.7998, lng: -95.4186 },
      { zipCode: '77019', label: 'River Oaks / Montrose', lat: 29.7521, lng: -95.4086 },
      { zipCode: '77024', label: 'Memorial', lat: 29.7705, lng: -95.5247 },
      { zipCode: '77494', label: 'Katy', lat: 29.7608, lng: -95.8118 }
    ]
  },
  'san-diego': {
    cbsa: '41740',
    name: 'San Diego, CA',
    zips: [
      { zipCode: '92101', label: 'Downtown San Diego', lat: 32.7157, lng: -117.1611 },
      { zipCode: '92103', label: 'Mission Hills / Hillcrest', lat: 32.7442, lng: -117.1749 },
      { zipCode: '92116', label: 'Normal Heights', lat: 32.7592, lng: -117.1296 },
      { zipCode: '92122', label: 'UTC / La Jolla', lat: 32.8636, lng: -117.2102 },
      { zipCode: '92130', label: 'Carmel Valley', lat: 32.9295, lng: -117.2296 }
    ]
  },
  minneapolis: {
    cbsa: '33460',
    name: 'Minneapolis, MN',
    zips: [
      { zipCode: '55401', label: 'Downtown Minneapolis', lat: 44.9793, lng: -93.2752 },
      { zipCode: '55403', label: 'Uptown / Lyn Lake', lat: 44.9579, lng: -93.2962 },
      { zipCode: '55406', label: 'Longfellow', lat: 44.9393, lng: -93.223 },
      { zipCode: '55414', label: 'Marcy Holmes / Dinkytown', lat: 44.985, lng: -93.2225 },
      { zipCode: '55416', label: 'St. Louis Park', lat: 44.9422, lng: -93.3744 }
    ]
  },
  tampa: {
    cbsa: '45300',
    name: 'Tampa, FL',
    zips: [
      { zipCode: '33602', label: 'Downtown Tampa / Channel District', lat: 27.945, lng: -82.4572 },
      { zipCode: '33606', label: 'Hyde Park / South Tampa', lat: 27.9278, lng: -82.4681 },
      { zipCode: '33609', label: 'South Tampa / Palma Ceia', lat: 27.9381, lng: -82.5157 },
      { zipCode: '33629', label: 'Bayshore / South Tampa', lat: 27.9219, lng: -82.5057 },
      { zipCode: '33647', label: 'New Tampa / K-Bar Ranch', lat: 28.1498, lng: -82.3423 }
    ]
  },
  portland: {
    cbsa: '38900',
    name: 'Portland, OR',
    zips: [
      { zipCode: '97201', label: 'South Park Blocks / PSU', lat: 45.5132, lng: -122.6857 },
      { zipCode: '97202', label: 'Sellwood / Moreland', lat: 45.4746, lng: -122.653 },
      { zipCode: '97209', label: 'Pearl District', lat: 45.529, lng: -122.682 },
      { zipCode: '97214', label: 'Hawthorne / Buckman', lat: 45.5168, lng: -122.6487 },
      { zipCode: '97217', label: 'St. Johns / North Portland', lat: 45.5829, lng: -122.6878 }
    ]
  },
  'st-louis': {
    cbsa: '41180',
    name: 'St. Louis, MO',
    zips: [
      { zipCode: '63103', label: 'Downtown West / Midtown', lat: 38.625, lng: -90.2249 },
      { zipCode: '63104', label: 'Soulard / Benton Park', lat: 38.6038, lng: -90.2135 },
      { zipCode: '63110', label: 'Forest Park / Cortex', lat: 38.6273, lng: -90.2628 },
      { zipCode: '63116', label: 'Holly Hills / Carondelet', lat: 38.5777, lng: -90.2614 },
      { zipCode: '63130', label: 'University City', lat: 38.6576, lng: -90.3235 }
    ]
  },
  detroit: {
    cbsa: '19820',
    name: 'Detroit, MI',
    zips: [
      { zipCode: '48201', label: 'Midtown / Wayne State', lat: 42.3558, lng: -83.0587 },
      { zipCode: '48202', label: 'New Center / North End', lat: 42.3745, lng: -83.0748 },
      { zipCode: '48207', label: 'Islandview / East Village', lat: 42.3558, lng: -83.0175 },
      { zipCode: '48226', label: 'Downtown Detroit', lat: 42.3314, lng: -83.0458 },
      { zipCode: '48220', label: 'Ferndale', lat: 42.4597, lng: -83.1344 }
    ]
  },
  nashville: {
    cbsa: '34980',
    name: 'Nashville, TN',
    zips: [
      { zipCode: '37203', label: 'The Gulch / SoBro', lat: 36.1491, lng: -86.7905 },
      { zipCode: '37206', label: 'East Nashville', lat: 36.1813, lng: -86.7517 },
      { zipCode: '37207', label: 'Bordeaux / North Nashville', lat: 36.2114, lng: -86.8003 },
      { zipCode: '37212', label: 'Belmont / Hillsboro Village', lat: 36.1363, lng: -86.8024 },
      { zipCode: '37215', label: 'Green Hills / Forest Hills', lat: 36.1023, lng: -86.8214 }
    ]
  },
  charlotte: {
    cbsa: '16740',
    name: 'Charlotte, NC',
    zips: [
      { zipCode: '28202', label: 'Uptown Charlotte', lat: 35.2244, lng: -80.8456 },
      { zipCode: '28204', label: 'Elizabeth / Midtown', lat: 35.2147, lng: -80.831 },
      { zipCode: '28205', label: 'Plaza Midwood / NoDa', lat: 35.2289, lng: -80.8124 },
      { zipCode: '28207', label: 'Dilworth / Myers Park', lat: 35.2042, lng: -80.8411 },
      { zipCode: '28262', label: 'University City', lat: 35.3138, lng: -80.7451 }
    ]
  },
  raleigh: {
    cbsa: '39580',
    name: 'Raleigh, NC',
    zips: [
      { zipCode: '27601', label: 'Downtown Raleigh', lat: 35.7796, lng: -78.6382 },
      { zipCode: '27605', label: 'Five Points / Glenwood South', lat: 35.8023, lng: -78.6546 },
      { zipCode: '27607', label: 'Cameron Village / Brentwood', lat: 35.7891, lng: -78.6892 },
      { zipCode: '27615', label: 'North Hills', lat: 35.8625, lng: -78.6441 },
      { zipCode: '27703', label: 'East Durham / Research Triangle', lat: 35.9671, lng: -78.8504 }
    ]
  },
  'las-vegas': {
    cbsa: '29820',
    name: 'Las Vegas, NV',
    zips: [
      { zipCode: '89101', label: 'Downtown Las Vegas', lat: 36.1699, lng: -115.1398 },
      { zipCode: '89117', label: 'Spring Valley', lat: 36.1369, lng: -115.2637 },
      { zipCode: '89119', label: 'Paradise / Strip Adjacent', lat: 36.103, lng: -115.1416 },
      { zipCode: '89128', label: 'Summerlin South / Desert Shores', lat: 36.1936, lng: -115.2694 },
      { zipCode: '89135', label: 'Summerlin Center', lat: 36.1589, lng: -115.3413 }
    ]
  },
  orlando: {
    cbsa: '36740',
    name: 'Orlando, FL',
    zips: [
      { zipCode: '32801', label: 'Downtown Orlando / Lake Eola', lat: 28.5421, lng: -81.379 },
      { zipCode: '32803', label: 'Thornton Park / Mills 50', lat: 28.5444, lng: -81.3545 },
      { zipCode: '32814', label: 'Baldwin Park', lat: 28.5663, lng: -81.3392 },
      { zipCode: '32819', label: 'Dr. Phillips / Sand Lake', lat: 28.4752, lng: -81.4755 },
      { zipCode: '32825', label: 'East Orlando / Waterford', lat: 28.5241, lng: -81.2682 }
    ]
  },
  'san-jose': {
    cbsa: '41940',
    name: 'San Jose, CA',
    zips: [
      { zipCode: '95110', label: 'Downtown San Jose', lat: 37.3382, lng: -121.8863 },
      { zipCode: '95112', label: 'East San Jose / Japantown', lat: 37.3491, lng: -121.8686 },
      { zipCode: '95126', label: 'Rose Garden / Willow Glen', lat: 37.3285, lng: -121.9189 },
      { zipCode: '95128', label: 'West San Jose / Burbank', lat: 37.3266, lng: -121.9438 },
      { zipCode: '95008', label: 'Campbell / Pruneyard', lat: 37.2814, lng: -121.9449 }
    ]
  },
  sacramento: {
    cbsa: '40900',
    name: 'Sacramento, CA',
    zips: [
      { zipCode: '95811', label: 'Midtown / R Street Corridor', lat: 38.5758, lng: -121.499 },
      { zipCode: '95816', label: 'Land Park / Curtis Park', lat: 38.5586, lng: -121.4949 },
      { zipCode: '95819', label: 'East Sacramento / Arden-Arcade', lat: 38.573, lng: -121.4609 },
      { zipCode: '95831', label: 'Pocket / Meadowview', lat: 38.4908, lng: -121.5162 },
      { zipCode: '95820', label: 'Oak Park / South Oak Park', lat: 38.5417, lng: -121.4721 }
    ]
  },
  'salt-lake-city': {
    cbsa: '41620',
    name: 'Salt Lake City, UT',
    zips: [
      { zipCode: '84101', label: 'Downtown SLC', lat: 40.7608, lng: -111.8910 },
      { zipCode: '84103', label: 'Avenues / Capitol Hill', lat: 40.7831, lng: -111.8894 },
      { zipCode: '84105', label: 'Sugar House / Millcreek', lat: 40.7265, lng: -111.8603 },
      { zipCode: '84106', label: 'Liberty Wells / Ballpark', lat: 40.7133, lng: -111.8867 },
      { zipCode: '84109', label: 'Millcreek / Holladay', lat: 40.6989, lng: -111.8388 }
    ]
  },
  'kansas-city': {
    cbsa: '28140',
    name: 'Kansas City, MO',
    zips: [
      { zipCode: '64108', label: 'Crossroads Arts District', lat: 39.0878, lng: -94.5826 },
      { zipCode: '64109', label: 'Westport / Hyde Park', lat: 39.0618, lng: -94.5794 },
      { zipCode: '64111', label: 'Country Club Plaza', lat: 39.0418, lng: -94.5975 },
      { zipCode: '64112', label: 'Mission Hills / Brookside', lat: 39.0252, lng: -94.5819 },
      { zipCode: '64130', label: 'Troost / Blue Hills', lat: 39.0316, lng: -94.5401 }
    ]
  }
};

function getRentcastApiKey() {
  return process.env.RENTCAST_API_KEY || process.env.Rentcast_API_Key || '';
}

function getGoogleMapsApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '';
}

function ensureZipCode(zipCode) {
  const normalized = String(zipCode || '').trim();
  if (!/^\d{5}$/.test(normalized)) {
    throw new Error('invalid_zip_code');
  }
  return normalized;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '' || value === '.') return null;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values, decimals = 2) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return round(valid.reduce((sum, value) => sum + value, 0) / valid.length, decimals);
}

function median(values, decimals = 2) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  const raw = valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  return round(raw, decimals);
}

export function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeListingPropertyType(value = '') {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('single') || normalized === 'sfr') return 'Single Family';
  if (normalized.includes('condo')) return 'Condo';
  if (normalized.includes('town')) return 'Townhouse';
  if (normalized.includes('apartment')) return 'Apartment';
  if (normalized.includes('multi')) return 'Multi Family';
  return value || null;
}

function weightedMedian(items, valueKey, weightKey, decimals = 0) {
  const valid = items
    .filter((item) => Number.isFinite(item?.[valueKey]) && Number.isFinite(item?.[weightKey]))
    .sort((left, right) => left[valueKey] - right[valueKey]);
  if (!valid.length) return null;
  const totalWeight = valid.reduce((sum, item) => sum + item[weightKey], 0);
  let running = 0;
  for (const item of valid) {
    running += item[weightKey];
    if (running >= totalWeight / 2) {
      return round(item[valueKey], decimals);
    }
  }
  return round(valid[valid.length - 1][valueKey], decimals);
}

function findMetroZipProfile(identifier) {
  const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
  if (!normalizedIdentifier) return null;

  const directMatch = METRO_ZIP_PROFILES[normalizedIdentifier];
  if (directMatch) {
    return { key: normalizedIdentifier, ...directMatch };
  }

  const profileEntry = Object.entries(METRO_ZIP_PROFILES).find(([, profile]) => {
    return profile.cbsa === identifier || profile.name.toLowerCase() === normalizedIdentifier;
  });

  return profileEntry ? { key: profileEntry[0], ...profileEntry[1] } : null;
}

export function getSupportedMetroZipProfilesSummary() {
  return Object.entries(METRO_ZIP_PROFILES).map(([key, profile]) => {
    const latitudes = profile.zips.map((zip) => zip.lat).filter((value) => Number.isFinite(value));
    const longitudes = profile.zips.map((zip) => zip.lng).filter((value) => Number.isFinite(value));
    const avgLat = latitudes.reduce((sum, value) => sum + value, 0) / Math.max(latitudes.length, 1);
    const avgLng = longitudes.reduce((sum, value) => sum + value, 0) / Math.max(longitudes.length, 1);

    return {
      key,
      code: profile.cbsa,
      name: profile.name,
      lat: round(avgLat, 4),
      lng: round(avgLng, 4),
      zipCount: profile.zips.length,
    };
  });
}

function normalizeBreakdown(items, type) {
  if (!Array.isArray(items)) return [];

  const isRental = type === 'rental';
  return items
    .map((item) => ({
      label: item.propertyType ?? (item.bedrooms === 0 ? 'Studio' : item.bedrooms === null || item.bedrooms === undefined ? 'Unknown' : `${item.bedrooms} BR`),
      bedrooms: item.bedrooms ?? null,
      propertyType: item.propertyType ?? null,
      average: toNumber(isRental ? item.averageRent : item.averagePrice),
      median: toNumber(isRental ? item.medianRent : item.medianPrice),
      min: toNumber(isRental ? item.minRent : item.minPrice),
      max: toNumber(isRental ? item.maxRent : item.maxPrice),
      averagePerSquareFoot: toNumber(isRental ? item.averageRentPerSquareFoot : item.averagePricePerSquareFoot),
      medianPerSquareFoot: toNumber(isRental ? item.medianRentPerSquareFoot : item.medianPricePerSquareFoot),
      averageSquareFootage: toInteger(item.averageSquareFootage),
      medianSquareFootage: toInteger(item.medianSquareFootage),
      averageDaysOnMarket: toNumber(item.averageDaysOnMarket),
      medianDaysOnMarket: toNumber(item.medianDaysOnMarket),
      newListings: toInteger(item.newListings),
      totalListings: toInteger(item.totalListings)
    }))
    .sort((left, right) => (right.totalListings || 0) - (left.totalListings || 0));
}

function normalizeMarketSide(raw, type) {
  if (!raw || typeof raw !== 'object') {
    return {
      lastUpdatedDate: null,
      average: null,
      median: null,
      min: null,
      max: null,
      averagePerSquareFoot: null,
      medianPerSquareFoot: null,
      averageSquareFootage: null,
      medianSquareFootage: null,
      averageDaysOnMarket: null,
      medianDaysOnMarket: null,
      newListings: null,
      totalListings: null,
      byPropertyType: [],
      byBedrooms: []
    };
  }

  const isRental = type === 'rental';
  return {
    lastUpdatedDate: raw.lastUpdatedDate || null,
    average: toNumber(isRental ? raw.averageRent : raw.averagePrice),
    median: toNumber(isRental ? raw.medianRent : raw.medianPrice),
    min: toNumber(isRental ? raw.minRent : raw.minPrice),
    max: toNumber(isRental ? raw.maxRent : raw.maxPrice),
    averagePerSquareFoot: toNumber(isRental ? raw.averageRentPerSquareFoot : raw.averagePricePerSquareFoot),
    medianPerSquareFoot: toNumber(isRental ? raw.medianRentPerSquareFoot : raw.medianPricePerSquareFoot),
    averageSquareFootage: toInteger(raw.averageSquareFootage),
    medianSquareFootage: toInteger(raw.medianSquareFootage),
    averageDaysOnMarket: toNumber(raw.averageDaysOnMarket),
    medianDaysOnMarket: toNumber(raw.medianDaysOnMarket),
    newListings: toInteger(raw.newListings),
    totalListings: toInteger(raw.totalListings),
    byPropertyType: normalizeBreakdown(raw.dataByPropertyType, type),
    byBedrooms: normalizeBreakdown(raw.dataByBedrooms, type)
  };
}

function deriveMarketMetrics(saleData, rentalData) {
  const medianSalePrice = saleData.median;
  const medianAskingRent = rentalData.median;
  const annualizedMedianRent = medianAskingRent ? medianAskingRent * 12 : null;

  const grossYieldPct = annualizedMedianRent && medianSalePrice
    ? round((annualizedMedianRent / medianSalePrice) * 100, 2)
    : null;

  const priceToRentRatio = annualizedMedianRent && medianSalePrice
    ? round(medianSalePrice / annualizedMedianRent, 2)
    : null;

  const saleVsRentDomSpread = saleData.medianDaysOnMarket !== null && rentalData.medianDaysOnMarket !== null
    ? round(saleData.medianDaysOnMarket - rentalData.medianDaysOnMarket, 1)
    : null;

  return {
    medianSalePrice,
    medianAskingRent,
    grossYieldPct,
    priceToRentRatio,
    saleVsRentDomSpread,
    rentalListings: rentalData.totalListings,
    saleListings: saleData.totalListings
  };
}

async function rentcastRequest(pathname, searchParams) {
  const apiKey = getRentcastApiKey();
  if (!apiKey) {
    throw new Error('rentcast_not_configured');
  }

  // Reserve a unit of the monthly RentCast budget (throws when exhausted).
  await reserveRentcastCall({ context: pathname });

  const url = new URL(`${RENTCAST_API_BASE_URL}${pathname}`);
  Object.entries(searchParams || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Api-Key': apiKey
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new Error('zip_market_not_found');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('rentcast_auth_failed');
      }
      throw new Error(`rentcast_request_failed:${response.status}:${text.slice(0, 160)}`);
    }

    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('rentcast_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function geocodeLocation(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    throw new Error('missing_geocode_query');
  }

  const cacheKey = hashCacheKey({ v: 1, query: normalizedQuery.toLowerCase() });
  const cached = await getCachedDoc(GEOCODE_CACHE_COLLECTION, cacheKey, GEOCODE_TTL_HOURS);
  if (cached?.data?.location) {
    return cached.data;
  }

  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    throw new Error('maps_key_missing');
  }

  const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  geocodeUrl.searchParams.set('address', normalizedQuery);
  geocodeUrl.searchParams.set('key', apiKey);

  const response = await fetch(geocodeUrl);
  if (!response.ok) {
    throw new Error(`maps_geocode_failed:${response.status}`);
  }

  const payload = await response.json();
  const firstResult = payload?.results?.[0];
  const location = firstResult?.geometry?.location;
  if (payload?.status !== 'OK' || !location) {
    throw new Error(`maps_geocode_failed:${payload?.status || 'unknown'}`);
  }

  const result = {
    query: normalizedQuery,
    formattedAddress: firstResult.formatted_address || normalizedQuery,
    location: {
      lat: toNumber(location.lat),
      lng: toNumber(location.lng),
    },
  };

  setCachedDoc(GEOCODE_CACHE_COLLECTION, cacheKey, result, { kind: 'google_geocode' }).catch(() => {});
  return result;
}

export async function getZipMarketData(zipCode) {
  const normalizedZipCode = ensureZipCode(zipCode);

  // Layer 1: in-memory cache (30-minute TTL)
  const cached = ZIP_MARKET_CACHE.get(normalizedZipCode);
  if (cached && Date.now() - cached.ts < RENTCAST_CACHE_TTL_MS) {
    return cached.data;
  }

  // Layer 2: Firestore cache (24-hour TTL)
  try {
    const firestoreCached = await getCachedZipMarketData(normalizedZipCode);
    if (firestoreCached?.data) {
      // Refresh in-memory cache with Firestore data
      ZIP_MARKET_CACHE.set(normalizedZipCode, { data: firestoreCached.data, ts: Date.now() });
      // If stale (>20h), trigger background refresh from API
      if (firestoreCached.isStale) {
        refreshZipMarketDataBackground(normalizedZipCode).catch(() => {});
      }
      return firestoreCached.data;
    }
  } catch (err) {
    console.warn('[RentCast] Firestore cache check failed, falling through to API:', err.message);
  }

  // Layer 3: fresh API fetch
  const payload = await rentcastRequest('/markets', { zipCode: normalizedZipCode });

  const saleData = normalizeMarketSide(payload.saleData, 'sale');
  const rentalData = normalizeMarketSide(payload.rentalData, 'rental');

  const data = {
    zipCode: normalizedZipCode,
    source: {
      provider: 'RentCast',
      dataset: 'ZIP market aggregates',
      fetchedAt: new Date().toISOString(),
      geography: 'zip'
    },
    derived: deriveMarketMetrics(saleData, rentalData),
    saleData,
    rentalData
  };

  ZIP_MARKET_CACHE.set(normalizedZipCode, { data, ts: Date.now() });
  // Write to Firestore in background (non-blocking)
  setCachedZipMarketData(normalizedZipCode, data).catch((err) => {
    console.warn('[RentCast] Firestore cache write failed:', err.message);
  });
  return data;
}

// Background refresh for stale Firestore cache entries
async function refreshZipMarketDataBackground(zipCode) {
  try {
    const payload = await rentcastRequest('/markets', { zipCode });
    const saleData = normalizeMarketSide(payload.saleData, 'sale');
    const rentalData = normalizeMarketSide(payload.rentalData, 'rental');
    const data = {
      zipCode,
      source: { provider: 'RentCast', dataset: 'ZIP market aggregates', fetchedAt: new Date().toISOString(), geography: 'zip' },
      derived: deriveMarketMetrics(saleData, rentalData),
      saleData,
      rentalData
    };
    ZIP_MARKET_CACHE.set(zipCode, { data, ts: Date.now() });
    await setCachedZipMarketData(zipCode, data);
    console.log(`[RentCast] Background refresh complete for ZIP ${zipCode}`);
  } catch (err) {
    console.warn(`[RentCast] Background refresh failed for ZIP ${zipCode}:`, err.message);
  }
}

function normalizeComparableAddress(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/[^a-z0-9]/g, '');
}

function percentileValue(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * Math.min(Math.max(ratio, 0), 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Pure comparable selection/aggregation used by live RentCast calls and fixtures.
 * Asking rents are normalized to subject size before aggregation.
 */
export function buildRentalComparableSet(listings = [], {
  zipCode,
  latitude,
  longitude,
  bedrooms,
  bathrooms,
  squareFeet,
  yearBuilt,
  propertyType,
  subjectAddress,
  radiusUsed = null,
  minSample = 8,
} = {}) {
  const subjectSquareFeet = Number(squareFeet) || null;
  const subjectBathrooms = Number(bathrooms) || null;
  const subjectBedrooms = Number(bedrooms) || null;
  const subjectYearBuilt = Number(yearBuilt) || null;
  const normalizedPropertyType = normalizeListingPropertyType(propertyType);
  const normalizedSubjectAddress = normalizeComparableAddress(subjectAddress);
  const sqftTolerance = 0.25;
  const rawSubjectListing = normalizedSubjectAddress
    ? listings
      .filter((listing) => normalizeComparableAddress(listing.formattedAddress) === normalizedSubjectAddress)
      .sort((left, right) => {
        const leftDate = left?.listedDate ? new Date(left.listedDate).getTime() : 0;
        const rightDate = right?.listedDate ? new Date(right.listedDate).getTime() : 0;
        return rightDate - leftDate;
      })[0] || null
    : null;

  const normalized = listings
    .map((listing) => {
      const compSquareFeet = toNumber(listing.squareFootage);
      const compBathrooms = toNumber(listing.bathrooms);
      const compBedrooms = toInteger(listing.bedrooms);
      const compYearBuilt = toInteger(listing.yearBuilt);
      const compLat = toNumber(listing.latitude);
      const compLng = toNumber(listing.longitude);
      const price = toNumber(listing.price);
      const normalizedCompType = normalizeListingPropertyType(listing.propertyType);
      const normalizedAddress = normalizeComparableAddress(listing.formattedAddress);
      const distanceMiles = latitude && longitude && compLat && compLng
        ? haversineMiles(Number(latitude), Number(longitude), compLat, compLng)
        : null;
      const sqftDeltaRatio = subjectSquareFeet && compSquareFeet
        ? Math.abs(compSquareFeet - subjectSquareFeet) / subjectSquareFeet
        : null;
      const bathroomDelta = subjectBathrooms && compBathrooms
        ? Math.abs(compBathrooms - subjectBathrooms)
        : null;
      const bedroomDelta = subjectBedrooms && compBedrooms
        ? Math.abs(compBedrooms - subjectBedrooms)
        : null;
      const yearDelta = subjectYearBuilt && compYearBuilt
        ? Math.abs(compYearBuilt - subjectYearBuilt)
        : null;
      const status = String(listing.status || '').toLowerCase();
      const isExplicitlyInactive = status.includes('inactive')
        || status.includes('removed')
        || status.includes('closed')
        || status.includes('leased');
      const pricePerSqFt = price && compSquareFeet ? price / compSquareFeet : null;
      const sizeAdjustedRent = pricePerSqFt && subjectSquareFeet
        ? pricePerSqFt * subjectSquareFeet
        : price;

      let score = 100;
      if (sqftDeltaRatio != null) score -= Math.min(sqftDeltaRatio * 150, 38);
      if (bathroomDelta != null) score -= Math.min(bathroomDelta * 10, 20);
      if (bedroomDelta != null) score -= Math.min(bedroomDelta * 12, 24);
      if (yearDelta != null) score -= Math.min(yearDelta / 2, 18);
      if (distanceMiles != null) score -= Math.min(distanceMiles * 7, 28);
      if (normalizedPropertyType && normalizedCompType !== normalizedPropertyType) score -= 30;

      return {
        id: listing.id,
        formattedAddress: listing.formattedAddress,
        normalizedAddress,
        zipCode: listing.zipCode,
        city: listing.city,
        state: listing.state,
        county: listing.county,
        latitude: compLat,
        longitude: compLng,
        propertyType: listing.propertyType || null,
        normalizedPropertyType: normalizedCompType,
        bedrooms: compBedrooms,
        bathrooms: compBathrooms,
        squareFootage: compSquareFeet,
        yearBuilt: compYearBuilt,
        price,
        pricePerSqFt: pricePerSqFt != null ? round(pricePerSqFt, 4) : null,
        sizeAdjustedRent: sizeAdjustedRent != null ? round(sizeAdjustedRent, 0) : null,
        status: listing.status || null,
        daysOnMarket: toInteger(listing.daysOnMarket),
        listedDate: listing.listedDate || null,
        distanceMiles: distanceMiles != null ? round(distanceMiles, 2) : null,
        compScore: round(score, 1),
        similarityWeight: Math.max(score, 1),
        isExplicitlyInactive,
      };
    })
    .filter((listing) => Number.isFinite(listing.price) && listing.price > 0)
    .filter((listing) => !listing.isExplicitlyInactive)
    .filter((listing) => !normalizedPropertyType || listing.normalizedPropertyType === normalizedPropertyType)
    .filter((listing) => !subjectBedrooms || listing.bedrooms == null || Math.abs(listing.bedrooms - subjectBedrooms) <= 1)
    .filter((listing) => !subjectBathrooms || listing.bathrooms == null || Math.abs(listing.bathrooms - subjectBathrooms) <= 1)
    .filter((listing) => !subjectSquareFeet
      || (listing.squareFootage != null
        && Math.abs(listing.squareFootage - subjectSquareFeet) / subjectSquareFeet <= sqftTolerance))
    .filter((listing) => !subjectYearBuilt || listing.yearBuilt == null || Math.abs(listing.yearBuilt - subjectYearBuilt) <= 25)
    .filter((listing) => !normalizedSubjectAddress || !listing.normalizedAddress || listing.normalizedAddress !== normalizedSubjectAddress)
    .sort((left, right) => right.compScore - left.compScore);

  const dedupedByAddress = new Map();
  for (const listing of normalized) {
    const key = listing.normalizedAddress || String(listing.id || '');
    if (!key) continue;
    const previous = dedupedByAddress.get(key);
    const previousDate = previous?.listedDate ? new Date(previous.listedDate).getTime() : 0;
    const currentDate = listing.listedDate ? new Date(listing.listedDate).getTime() : 0;
    if (!previous || currentDate >= previousDate) dedupedByAddress.set(key, listing);
  }
  const deduped = [...dedupedByAddress.values()];

  const ppsfValues = deduped.map((listing) => listing.pricePerSqFt).filter(Number.isFinite);
  const q1 = percentileValue(ppsfValues, 0.25);
  const q3 = percentileValue(ppsfValues, 0.75);
  const iqr = q1 != null && q3 != null ? q3 - q1 : null;
  const shouldTrim = ppsfValues.length >= 4 && iqr != null;
  const lowerPpsf = shouldTrim ? Math.max(0, q1 - 1.5 * iqr) : null;
  const upperPpsf = shouldTrim ? q3 + 1.5 * iqr : null;
  const trimmed = shouldTrim
    ? deduped.filter((listing) => listing.pricePerSqFt == null
      || (listing.pricePerSqFt >= lowerPpsf && listing.pricePerSqFt <= upperPpsf))
    : deduped;

  const topComparables = trimmed.slice(0, 24);
  const prices = topComparables.map((listing) => listing.price);
  const adjustedRents = topComparables.map((listing) => listing.sizeAdjustedRent).filter(Number.isFinite);
  const adjustedItems = topComparables.filter((listing) => Number.isFinite(listing.sizeAdjustedRent));
  const weightedSizeAdjustedRent = weightedMedian(adjustedItems, 'sizeAdjustedRent', 'similarityWeight');
  const cleanSampleAdequate = topComparables.length >= minSample;

  return {
    search: {
      queryMode: latitude && longitude ? 'adaptive-radius' : 'zip',
      radiusUsed,
      zipCode: zipCode || null,
      latitude: latitude || null,
      longitude: longitude || null,
      bedrooms: subjectBedrooms,
      bathrooms: subjectBathrooms,
      squareFeet: subjectSquareFeet,
      sqftTolerance,
      yearBuilt: subjectYearBuilt,
      propertyType: normalizedPropertyType,
      subjectExcluded: Boolean(normalizedSubjectAddress),
      status: 'Active',
    },
    totalFetched: listings.length,
    totalAfterDedupe: deduped.length,
    outliersRemoved: Math.max(0, deduped.length - trimmed.length),
    matchedCount: topComparables.length,
    cleanSampleAdequate,
    subjectListing: rawSubjectListing ? {
      id: rawSubjectListing.id || null,
      formattedAddress: rawSubjectListing.formattedAddress || subjectAddress || null,
      price: toNumber(rawSubjectListing.price),
      status: rawSubjectListing.status || null,
      daysOnMarket: toInteger(rawSubjectListing.daysOnMarket),
      listedDate: rawSubjectListing.listedDate || null,
    } : null,
    comparables: topComparables.map(({ normalizedAddress, normalizedPropertyType: _normalizedType, isExplicitlyInactive, ...listing }) => listing),
    summary: {
      weightedMedianRent: weightedSizeAdjustedRent
        || weightedMedian(topComparables, 'price', 'similarityWeight'),
      weightedMedianRawRent: weightedMedian(topComparables, 'price', 'similarityWeight'),
      weightedMedianRentPerSqFt: weightedMedian(
        topComparables.filter((listing) => Number.isFinite(listing.pricePerSqFt)),
        'pricePerSqFt',
        'similarityWeight',
        4,
      ),
      averageRent: average(adjustedRents.length ? adjustedRents : prices, 0),
      medianRent: median(adjustedRents.length ? adjustedRents : prices, 0),
      minRent: adjustedRents.length ? Math.min(...adjustedRents) : (prices.length ? Math.min(...prices) : null),
      maxRent: adjustedRents.length ? Math.max(...adjustedRents) : (prices.length ? Math.max(...prices) : null),
      averageDaysOnMarket: average(topComparables.map((listing) => listing.daysOnMarket), 1),
      averageDistanceMiles: average(topComparables.map((listing) => listing.distanceMiles), 2),
      ppsfQ1: q1 != null ? round(q1, 4) : null,
      ppsfQ3: q3 != null ? round(q3, 4) : null,
    }
  };
}

export async function getRentalListingComparables({
  zipCode,
  latitude,
  longitude,
  bedrooms,
  bathrooms,
  squareFeet,
  yearBuilt,
  propertyType,
  subjectAddress,
  limit = 80,
}) {
  const normalizedPropertyType = normalizeListingPropertyType(propertyType);
  const maxLimit = Math.min(Math.max(Number(limit) || 80, 10), 120);
  const radii = latitude && longitude ? [1.5, 3, 5] : [null];
  const collected = [];
  let packageResult = null;
  let radiusUsed = null;

  for (const radius of radii) {
    const params = {
      status: 'Active',
      daysOld: 180,
      limit: maxLimit,
    };
    if (latitude && longitude) {
      params.latitude = latitude;
      params.longitude = longitude;
      params.radius = radius;
      radiusUsed = radius;
    } else {
      params.zipCode = ensureZipCode(zipCode);
    }
    if (Number.isFinite(Number(bedrooms)) && Number(bedrooms) > 0) {
      params.bedrooms = Math.round(Number(bedrooms));
    }
    if (normalizedPropertyType) params.propertyType = normalizedPropertyType;

    const payload = await rentcastRequest('/listings/rental/long-term', params);
    if (Array.isArray(payload)) collected.push(...payload);

    packageResult = buildRentalComparableSet(collected, {
      zipCode,
      latitude,
      longitude,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      propertyType,
      subjectAddress,
      radiusUsed,
    });
    if (packageResult.cleanSampleAdequate || !latitude || !longitude) break;
  }

  // If exact-bedroom inventory remains thin, make one controlled expansion and
  // let the pure selector admit bedrooms ±1 with an explicit score penalty.
  if (!packageResult?.cleanSampleAdequate && Number.isFinite(Number(bedrooms))) {
    const expandedParams = {
      status: 'Active',
      daysOld: 180,
      limit: maxLimit,
    };
    if (latitude && longitude) {
      expandedParams.latitude = latitude;
      expandedParams.longitude = longitude;
      expandedParams.radius = radiusUsed || 5;
    } else {
      expandedParams.zipCode = ensureZipCode(zipCode);
    }
    if (normalizedPropertyType) expandedParams.propertyType = normalizedPropertyType;
    const expandedPayload = await rentcastRequest('/listings/rental/long-term', expandedParams);
    if (Array.isArray(expandedPayload)) collected.push(...expandedPayload);
    packageResult = buildRentalComparableSet(collected, {
      zipCode,
      latitude,
      longitude,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      propertyType,
      subjectAddress,
      radiusUsed,
    });
    packageResult.search.bedroomExpansionUsed = true;
  }

  return packageResult || buildRentalComparableSet([], {
    zipCode,
    latitude,
    longitude,
    bedrooms,
    bathrooms,
    squareFeet,
    yearBuilt,
    propertyType,
    subjectAddress,
    radiusUsed,
  });
}

export async function getMetroZipMarketData(identifier) {
  const profile = findMetroZipProfile(identifier);
  if (!profile) {
    throw new Error('metro_zip_market_not_supported');
  }

  const results = await Promise.allSettled(
    profile.zips.map(async (zip) => {
      const data = await getZipMarketData(zip.zipCode);
      return {
        ...data,
        label: zip.label,
        lat: zip.lat,
        lng: zip.lng
      };
    })
  );

  const markets = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .sort((left, right) => (right.derived?.grossYieldPct || 0) - (left.derived?.grossYieldPct || 0));

  if (!markets.length) {
    const firstError = results.find((result) => result.status === 'rejected');
    throw firstError?.reason || new Error('metro_zip_market_failed');
  }

  return {
    metro: {
      key: profile.key,
      cbsa: profile.cbsa,
      name: profile.name,
      availableZipCount: markets.length
    },
    source: {
      provider: 'RentCast',
      dataset: 'Metro focus ZIP market aggregates',
      fetchedAt: new Date().toISOString(),
      geography: 'zip'
    },
    summary: {
      avgGrossYieldPct: average(markets.map((market) => market.derived?.grossYieldPct)),
      avgMedianAskingRent: average(markets.map((market) => market.derived?.medianAskingRent)),
      avgMedianSalePrice: average(markets.map((market) => market.derived?.medianSalePrice)),
      totalRentalListings: markets.reduce((sum, market) => sum + (market.derived?.rentalListings || 0), 0),
      totalSaleListings: markets.reduce((sum, market) => sum + (market.derived?.saleListings || 0), 0)
    },
    markets
  };
}

/**
 * Find nearby ZIP codes from the METRO_ZIP_PROFILES using lat/lng + radius,
 * and fetch market data for each.
 */
export async function getZipRadiusMarkets(lat, lng, radiusMiles = 10) {
  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
    throw new Error('invalid_coordinates');
  }

  // Collect all ZIP entries from all metro profiles
  const allZips = [];
  for (const [metroKey, profile] of Object.entries(METRO_ZIP_PROFILES)) {
    for (const zip of profile.zips) {
      allZips.push({ ...zip, metroKey, metroName: profile.name, cbsa: profile.cbsa });
    }
  }

  // Filter by distance
  const nearbyZips = allZips
    .map((zip) => ({ ...zip, distanceMiles: round(haversineMiles(parsedLat, parsedLng, zip.lat, zip.lng), 1) }))
    .filter((zip) => zip.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 15);

  if (!nearbyZips.length) {
    return { ok: true, zips: [], count: 0, summary: null };
  }

  // Fetch market data for each nearby ZIP in parallel (cached)
  const results = await Promise.allSettled(nearbyZips.map((zip) => getZipMarketData(zip.zipCode)));

  const markets = nearbyZips
    .map((zip, i) => {
      const result = results[i];
      return {
        ...zip,
        market: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? result.reason?.message : null,
      };
    })
    .filter((z) => z.market);

  return {
    ok: true,
    zips: markets,
    count: markets.length,
    summary: markets.length
      ? {
          avgGrossYieldPct: average(markets.map((z) => z.market?.derived?.grossYieldPct)),
          avgMedianAskingRent: average(markets.map((z) => z.market?.derived?.medianAskingRent)),
          avgMedianSalePrice: average(markets.map((z) => z.market?.derived?.medianSalePrice)),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Sale listings (live for-sale inventory) — powers the regional deal screener
// ---------------------------------------------------------------------------

function normalizeSaleListing(listing) {
  return {
    id: listing.id || null,
    formattedAddress: listing.formattedAddress || null,
    addressLine1: listing.addressLine1 || null,
    city: listing.city || null,
    state: listing.state || null,
    zipCode: listing.zipCode || null,
    county: listing.county || null,
    latitude: toNumber(listing.latitude),
    longitude: toNumber(listing.longitude),
    propertyType: listing.propertyType || null,
    bedrooms: toInteger(listing.bedrooms),
    bathrooms: toNumber(listing.bathrooms),
    squareFootage: toNumber(listing.squareFootage),
    lotSize: toNumber(listing.lotSize),
    yearBuilt: toInteger(listing.yearBuilt),
    price: toNumber(listing.price),
    status: listing.status || null,
    listingType: listing.listingType || null,
    listedDate: listing.listedDate || null,
    removedDate: listing.removedDate || null,
    daysOnMarket: toInteger(listing.daysOnMarket),
    mlsName: listing.mlsName || null,
    mlsNumber: listing.mlsNumber || null,
    pricePerSqft: Number.isFinite(toNumber(listing.price)) && Number.isFinite(toNumber(listing.squareFootage)) && toNumber(listing.squareFootage) > 0
      ? round(toNumber(listing.price) / toNumber(listing.squareFootage), 0)
      : null,
  };
}

/**
 * Search active for-sale listings via RentCast /listings/sale.
 * Supports city/state, zipCode, or lat/lng+radius geography plus structural filters.
 * Results cached in Firestore for SALE_LISTINGS_TTL_HOURS keyed by the criteria hash.
 */
export async function searchSaleListings(criteria = {}) {
  const {
    city,
    state,
    zipCode,
    latitude,
    longitude,
    radiusMiles,
    minPrice,
    maxPrice,
    minBeds,
    maxBeds,
    minBaths,
    maxBaths,
    propertyType,
    limit = 200,
    daysOld,
    skipCache = false,
    preferRadiusForCity = true,
  } = criteria;

  const params = { status: 'Active' };
  let centerLabel = null;

  if (Number.isFinite(toNumber(latitude)) && Number.isFinite(toNumber(longitude))) {
    params.latitude = toNumber(latitude);
    params.longitude = toNumber(longitude);
    params.radius = Math.min(Math.max(toNumber(radiusMiles) || 5, 1), 50);
  } else if (city && state) {
    const cityQuery = `${String(city).trim()}, ${String(state).trim().toUpperCase().slice(0, 2)}`;
    if (preferRadiusForCity) {
      try {
        const geocoded = await geocodeLocation(cityQuery);
        params.latitude = geocoded.location?.lat;
        params.longitude = geocoded.location?.lng;
        params.radius = Math.min(Math.max(toNumber(radiusMiles) || 8, 2), 50);
        centerLabel = geocoded.formattedAddress || cityQuery;
      } catch (error) {
        console.warn('[RentCast] City geocode failed, falling back to direct city/state search:', error.message);
        params.city = String(city).trim();
        params.state = String(state).trim().toUpperCase().slice(0, 2);
      }
    } else {
      params.city = String(city).trim();
      params.state = String(state).trim().toUpperCase().slice(0, 2);
    }
  } else if (zipCode) {
    params.zipCode = ensureZipCode(zipCode);
  } else {
    throw new Error('missing_search_geography');
  }

  const normalizedPropertyType = normalizeListingPropertyType(propertyType);
  if (normalizedPropertyType) params.propertyType = normalizedPropertyType;
  if (Number.isFinite(toNumber(minBeds))) params.bedrooms = undefined; // RentCast uses exact bedrooms; we range-filter locally
  if (Number.isFinite(toNumber(daysOld)) && toNumber(daysOld) > 0) params.daysOld = Math.round(toNumber(daysOld));
  params.limit = Math.min(Math.max(Number(limit) || 200, 10), 500);

  const cacheKey = hashCacheKey({
    v: 2,
    ...params,
    centerLabel,
    minPrice: toNumber(minPrice),
    maxPrice: toNumber(maxPrice),
    minBeds: toNumber(minBeds),
    maxBeds: toNumber(maxBeds),
    minBaths: toNumber(minBaths),
    maxBaths: toNumber(maxBaths),
    propertyType: normalizedPropertyType,
    daysOld: toNumber(daysOld),
    preferRadiusForCity,
  });

  if (!skipCache) {
    const cached = await getCachedDoc(SALE_LISTINGS_CACHE_COLLECTION, cacheKey, SALE_LISTINGS_TTL_HOURS);
    if (cached?.data) {
      return { ...cached.data, fromCache: true, cacheAgeHours: round(cached.ageHours, 1) };
    }
  }

  const payload = await rentcastRequest('/listings/sale', params);
  const rawListings = Array.isArray(payload) ? payload : [];

  let listings = rawListings
    .map(normalizeSaleListing)
    .filter((l) => Number.isFinite(l.price) && l.price > 0);

  // Local range filters (RentCast sale listing search has limited range params)
  const numMinPrice = toNumber(minPrice);
  const numMaxPrice = toNumber(maxPrice);
  const numMinBeds = toNumber(minBeds);
  const numMaxBeds = toNumber(maxBeds);
  const numMinBaths = toNumber(minBaths);
  const numMaxBaths = toNumber(maxBaths);

  if (Number.isFinite(numMinPrice)) listings = listings.filter((l) => l.price >= numMinPrice);
  if (Number.isFinite(numMaxPrice)) listings = listings.filter((l) => l.price <= numMaxPrice);
  if (Number.isFinite(numMinBeds)) listings = listings.filter((l) => l.bedrooms == null || l.bedrooms >= numMinBeds);
  if (Number.isFinite(numMaxBeds)) listings = listings.filter((l) => l.bedrooms == null || l.bedrooms <= numMaxBeds);
  if (Number.isFinite(numMinBaths)) listings = listings.filter((l) => l.bathrooms == null || l.bathrooms >= numMinBaths);
  if (Number.isFinite(numMaxBaths)) listings = listings.filter((l) => l.bathrooms == null || l.bathrooms <= numMaxBaths);

  const result = {
    search: {
      geography: params.zipCode ? 'zip' : (params.latitude ? 'radius' : 'city'),
      city: city || params.city || null,
      state: state || params.state || null,
      zipCode: params.zipCode || null,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      radiusMiles: params.radius ?? null,
      centerLabel: centerLabel || null,
      propertyType: normalizedPropertyType,
      filters: { minPrice: numMinPrice ?? null, maxPrice: numMaxPrice ?? null, minBeds: numMinBeds ?? null, maxBeds: numMaxBeds ?? null, minBaths: numMinBaths ?? null, maxBaths: numMaxBaths ?? null },
    },
    fetchedAt: new Date().toISOString(),
    totalFetched: rawListings.length,
    matchedCount: listings.length,
    listings,
  };

  setCachedDoc(SALE_LISTINGS_CACHE_COLLECTION, cacheKey, result, { kind: 'sale_listings' }).catch(() => {});

  return { ...result, fromCache: false };
}

// ---------------------------------------------------------------------------
// AVM endpoints — value estimate (with sale comps) and long-term rent estimate
// ---------------------------------------------------------------------------

function normalizeAvmComparable(comp) {
  return {
    id: comp.id || null,
    formattedAddress: comp.formattedAddress || null,
    latitude: toNumber(comp.latitude),
    longitude: toNumber(comp.longitude),
    propertyType: comp.propertyType || null,
    bedrooms: toInteger(comp.bedrooms),
    bathrooms: toNumber(comp.bathrooms),
    squareFootage: toNumber(comp.squareFootage),
    yearBuilt: toInteger(comp.yearBuilt),
    price: toNumber(comp.price),
    listedDate: comp.listedDate || null,
    removedDate: comp.removedDate || null,
    daysOnMarket: toInteger(comp.daysOnMarket),
    distance: toNumber(comp.distance),
    correlation: toNumber(comp.correlation),
  };
}

async function fetchRentcastAvm(pathname, { address, propertyType, bedrooms, bathrooms, squareFootage, compCount = 12, skipCache = false }) {
  const normalizedAddress = String(address || '').trim();
  if (!normalizedAddress) throw new Error('missing_address');

  const params = { address: normalizedAddress, compCount: Math.min(Math.max(Number(compCount) || 12, 5), 25) };
  if (propertyType) params.propertyType = normalizeListingPropertyType(propertyType) || undefined;
  if (Number.isFinite(toNumber(bedrooms))) params.bedrooms = toNumber(bedrooms);
  if (Number.isFinite(toNumber(bathrooms))) params.bathrooms = toNumber(bathrooms);
  if (Number.isFinite(toNumber(squareFootage))) params.squareFootage = toNumber(squareFootage);

  const cacheKey = hashCacheKey({ v: 1, pathname, ...params });

  if (!skipCache) {
    const cached = await getCachedDoc(AVM_CACHE_COLLECTION, cacheKey, AVM_TTL_HOURS);
    if (cached?.data) {
      return { ...cached.data, fromCache: true, cacheAgeHours: round(cached.ageHours, 1) };
    }
  }

  const payload = await rentcastRequest(pathname, params);

  const result = {
    address: normalizedAddress,
    fetchedAt: new Date().toISOString(),
    estimate: toNumber(payload.price ?? payload.rent),
    estimateLow: toNumber(payload.priceRangeLow ?? payload.rentRangeLow),
    estimateHigh: toNumber(payload.priceRangeHigh ?? payload.rentRangeHigh),
    latitude: toNumber(payload.latitude),
    longitude: toNumber(payload.longitude),
    comparables: Array.isArray(payload.comparables) ? payload.comparables.map(normalizeAvmComparable) : [],
  };

  setCachedDoc(AVM_CACHE_COLLECTION, cacheKey, result, { kind: pathname }).catch(() => {});

  return { ...result, fromCache: false };
}

/** RentCast value AVM (/avm/value) — sale price estimate plus scored sale comps. */
export async function getValueEstimate(options) {
  return fetchRentcastAvm('/avm/value', options || {});
}

/** RentCast long-term rent AVM (/avm/rent/long-term) — rent estimate plus rental comps. */
export async function getRentEstimate(options) {
  return fetchRentcastAvm('/avm/rent/long-term', options || {});
}

const PROPERTY_RECORD_CACHE_COLLECTION = 'rentcast_property_record_cache';
const PROPERTY_RECORD_TTL_HOURS = 24 * 14;
const RENTAL_LISTING_ADDRESS_CACHE_COLLECTION = 'rentcast_rental_listing_address_cache';
const RENTAL_LISTING_ADDRESS_TTL_HOURS = 24 * 3;

function normalizeFullAddress(address) {
  return String(address || '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Address-level live rental listing lookup.
 * Strongest RentCast signal that a property is being marketed as a rental.
 * Note: listing agent/office contacts are NOT the property owner.
 */
export async function getRentalListingByAddress(address, { status = 'Active', skipCache = false } = {}) {
  const normalizedAddress = normalizeFullAddress(address);
  if (!normalizedAddress) {
    return { matched: false, reason: 'missing_address' };
  }

  const cacheKey = hashCacheKey({ v: 1, address: normalizedAddress.toLowerCase(), status });
  if (!skipCache) {
    const cached = await getCachedDoc(RENTAL_LISTING_ADDRESS_CACHE_COLLECTION, cacheKey, RENTAL_LISTING_ADDRESS_TTL_HOURS);
    if (cached?.data) {
      return { ...cached.data, fromCache: true, cacheAgeHours: round(cached.ageHours, 1) };
    }
  }

  try {
    const params = { address: normalizedAddress, limit: 5 };
    if (status) params.status = status;
    const payload = await rentcastRequest('/listings/rental/long-term', params);
    const listings = Array.isArray(payload) ? payload : [];

    const needle = normalizedAddress.toLowerCase().split(',')[0].trim();
    const exact = listings.find((listing) => {
      const formatted = String(listing.formattedAddress || '').toLowerCase();
      return formatted.includes(needle) || needle.includes(String(listing.addressLine1 || '').toLowerCase());
    }) || listings[0] || null;

    const result = exact
      ? {
          matched: true,
          status: exact.status || status || null,
          listedRent: toNumber(exact.price),
          listedDate: exact.listedDate || null,
          daysOnMarket: toInteger(exact.daysOnMarket),
          propertyType: exact.propertyType || null,
          bedrooms: toInteger(exact.bedrooms),
          bathrooms: toNumber(exact.bathrooms),
          squareFootage: toNumber(exact.squareFootage),
          formattedAddress: exact.formattedAddress || normalizedAddress,
          listingAgent: exact.listingAgent
            ? {
                name: exact.listingAgent.name || null,
                phone: exact.listingAgent.phone || null,
                email: exact.listingAgent.email || null,
              }
            : null,
          listingOffice: exact.listingOffice
            ? {
                name: exact.listingOffice.name || null,
                phone: exact.listingOffice.phone || null,
                email: exact.listingOffice.email || null,
              }
            : null,
          listingId: exact.id || null,
          reason: exact.status === 'Active' || !exact.status
            ? 'Active RentCast rental listing at this address'
            : `RentCast rental listing status: ${exact.status}`,
        }
      : {
          matched: false,
          reason: 'No RentCast rental listing found at this address',
        };

    setCachedDoc(RENTAL_LISTING_ADDRESS_CACHE_COLLECTION, cacheKey, result, {
      kind: 'rental_listing_address',
      address: normalizedAddress,
    }).catch(() => {});

    return { ...result, fromCache: false };
  } catch (error) {
    if (String(error.message || '').includes('404') || error.message === 'zip_market_not_found') {
      const empty = { matched: false, reason: 'No RentCast rental listing found at this address' };
      setCachedDoc(RENTAL_LISTING_ADDRESS_CACHE_COLLECTION, cacheKey, empty, {
        kind: 'rental_listing_address',
        address: normalizedAddress,
      }).catch(() => {});
      return empty;
    }
    throw error;
  }
}

const RENTAL_LISTING_HISTORY_CACHE_COLLECTION = 'rentcast_rental_listing_history_cache';
const RENTAL_LISTING_HISTORY_TTL_HOURS = 24 * 7;

function listingEventDate(listing) {
  const raw = listing?.listedDate || listing?.removedDate || listing?.lastSeenDate || listing?.createdDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Address-level rental listing history (active + inactive).
 * Used to confirm rentals that are not currently marketed, and recent turnover.
 */
export async function getRentalListingHistoryByAddress(address, {
  lookbackDays = 1825,
  skipCache = false,
} = {}) {
  const normalizedAddress = normalizeFullAddress(address);
  if (!normalizedAddress) {
    return {
      found: false,
      everListedForRent: false,
      listedInLast90Days: false,
      listedInLast5Years: false,
      lastListedDate: null,
      listings: [],
    };
  }

  const cacheKey = hashCacheKey({
    v: 1,
    address: normalizedAddress.toLowerCase(),
    lookbackDays,
  });
  if (!skipCache) {
    const cached = await getCachedDoc(
      RENTAL_LISTING_HISTORY_CACHE_COLLECTION,
      cacheKey,
      RENTAL_LISTING_HISTORY_TTL_HOURS,
    );
    if (cached?.data) {
      return { ...cached.data, fromCache: true, cacheAgeHours: round(cached.ageHours, 1) };
    }
  }

  const empty = {
    found: false,
    everListedForRent: false,
    listedInLast90Days: false,
    listedInLast5Years: false,
    lastListedDate: null,
    listings: [],
  };

  try {
    // Pull both statuses — Active is also useful for daysOnMarket / listedDate.
    const [activePayload, inactivePayload] = await Promise.all([
      rentcastRequest('/listings/rental/long-term', {
        address: normalizedAddress,
        status: 'Active',
        daysOld: lookbackDays,
        limit: 10,
      }).catch(() => []),
      rentcastRequest('/listings/rental/long-term', {
        address: normalizedAddress,
        status: 'Inactive',
        daysOld: lookbackDays,
        limit: 20,
      }).catch(() => []),
    ]);

    const needle = normalizedAddress.toLowerCase().split(',')[0].trim();
    const rawListings = [
      ...(Array.isArray(activePayload) ? activePayload : []),
      ...(Array.isArray(inactivePayload) ? inactivePayload : []),
    ];

    const listings = rawListings
      .filter((listing) => {
        const formatted = String(listing.formattedAddress || '').toLowerCase();
        const line1 = String(listing.addressLine1 || '').toLowerCase();
        return formatted.includes(needle) || needle.includes(line1) || line1.includes(needle.split(' ')[0]);
      })
      .map((listing) => ({
        status: listing.status || null,
        listedRent: toNumber(listing.price),
        listedDate: listing.listedDate || null,
        removedDate: listing.removedDate || null,
        daysOnMarket: toInteger(listing.daysOnMarket),
        formattedAddress: listing.formattedAddress || normalizedAddress,
        listingId: listing.id || null,
      }));

    // Dedupe by listingId / listedDate
    const seen = new Set();
    const unique = [];
    for (const listing of listings) {
      const key = listing.listingId || `${listing.listedDate}|${listing.status}|${listing.listedRent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(listing);
    }

    unique.sort((a, b) => {
      const aTime = listingEventDate(a)?.getTime() || 0;
      const bTime = listingEventDate(b)?.getTime() || 0;
      return bTime - aTime;
    });

    const now = Date.now();
    const ms90 = 90 * 24 * 60 * 60 * 1000;
    const ms5y = 5 * 365.25 * 24 * 60 * 60 * 1000;
    const newest = unique[0] || null;
    const newestDate = newest ? listingEventDate(newest) : null;
    const newestAgeMs = newestDate ? now - newestDate.getTime() : null;

    const result = {
      found: unique.length > 0,
      everListedForRent: unique.length > 0,
      listedInLast90Days: newestAgeMs != null && newestAgeMs <= ms90,
      listedInLast5Years: newestAgeMs != null && newestAgeMs <= ms5y,
      lastListedDate: newest?.listedDate || newest?.removedDate || null,
      lastListingStatus: newest?.status || null,
      lastListedRent: newest?.listedRent ?? null,
      listingCount: unique.length,
      listings: unique.slice(0, 10),
    };

    setCachedDoc(RENTAL_LISTING_HISTORY_CACHE_COLLECTION, cacheKey, result, {
      kind: 'rental_listing_history',
      address: normalizedAddress,
    }).catch(() => {});

    return { ...result, fromCache: false };
  } catch (error) {
    if (String(error.message || '').includes('404') || error.message === 'zip_market_not_found') {
      setCachedDoc(RENTAL_LISTING_HISTORY_CACHE_COLLECTION, cacheKey, empty, {
        kind: 'rental_listing_history',
        address: normalizedAddress,
      }).catch(() => {});
      return empty;
    }
    throw error;
  }
}

/**
 * RentCast property record for a specific address.
 * Includes ownerOccupied + owner name/mailing — not owner phone/email.
 */
export async function getPropertyRecordByAddress(address, { skipCache = false } = {}) {
  const normalizedAddress = normalizeFullAddress(address);
  if (!normalizedAddress) {
    return null;
  }

  const cacheKey = hashCacheKey({ v: 1, address: normalizedAddress.toLowerCase() });
  if (!skipCache) {
    const cached = await getCachedDoc(PROPERTY_RECORD_CACHE_COLLECTION, cacheKey, PROPERTY_RECORD_TTL_HOURS);
    if (cached?.data) {
      return { ...cached.data, fromCache: true, cacheAgeHours: round(cached.ageHours, 1) };
    }
  }

  const payload = await rentcastRequest('/properties', {
    address: normalizedAddress,
    limit: 1,
  });
  const records = Array.isArray(payload) ? payload : [];
  const record = records[0] || null;
  if (!record) {
    const empty = {
      found: false,
      address: normalizedAddress,
      ownerOccupied: null,
      ownerNames: [],
      ownerType: null,
      mailingAddress: null,
    };
    setCachedDoc(PROPERTY_RECORD_CACHE_COLLECTION, cacheKey, empty, {
      kind: 'property_record',
      address: normalizedAddress,
    }).catch(() => {});
    return empty;
  }

  const mailing = record.owner?.mailingAddress || null;
  const result = {
    found: true,
    address: record.formattedAddress || normalizedAddress,
    propertyType: record.propertyType || null,
    bedrooms: toInteger(record.bedrooms),
    bathrooms: toNumber(record.bathrooms),
    squareFootage: toNumber(record.squareFootage),
    yearBuilt: toInteger(record.yearBuilt),
    ownerOccupied: typeof record.ownerOccupied === 'boolean' ? record.ownerOccupied : null,
    ownerNames: Array.isArray(record.owner?.names) ? record.owner.names : [],
    ownerType: record.owner?.type || null,
    mailingAddress: mailing?.formattedAddress || null,
    latitude: toNumber(record.latitude),
    longitude: toNumber(record.longitude),
  };

  setCachedDoc(PROPERTY_RECORD_CACHE_COLLECTION, cacheKey, result, {
    kind: 'property_record',
    address: normalizedAddress,
  }).catch(() => {});

  return { ...result, fromCache: false };
}