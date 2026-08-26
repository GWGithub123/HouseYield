import 'dotenv/config';
const KEY = process.env.Rapid_API_Key;
const HOST = 'private-zillow.p.rapidapi.com';
const H = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
const zpid = '51738660'; // 11308 Geddys Ct, Reston

async function test(ep, params = '') {
  try {
    const url = `https://${HOST}/${ep}${params ? '?' + params : ''}`;
    const r = await fetch(url, { headers: H });
    const t = await r.text();
    const exists = !t.includes('does not exist') && r.status !== 404;
    const status = r.status;
    if (exists) {
      console.log(`✅ ${ep} → ${status} (${t.length} bytes) ${t.slice(0, 120)}`);
    }
    return exists;
  } catch (e) {
    return false;
  }
}

async function go() {
  console.log('=== Scanning ALL possible endpoints ===\n');
  
  const endpoints = [
    // Property detail patterns
    ['property', `zpid=${zpid}`],
    ['propertyV2', `zpid=${zpid}`],
    ['property-details', `zpid=${zpid}`],
    ['propertyDetails', `zpid=${zpid}`],
    ['property_details', `zpid=${zpid}`],
    ['detail', `zpid=${zpid}`],
    ['details', `zpid=${zpid}`],
    ['home', `zpid=${zpid}`],
    ['homedetails', `zpid=${zpid}`],
    ['home_details', `zpid=${zpid}`],
    ['home-details', `zpid=${zpid}`],
    ['hdp', `zpid=${zpid}`],
    ['hdpdata', `zpid=${zpid}`],
    ['listing', `zpid=${zpid}`],
    ['getProperty', `zpid=${zpid}`],
    ['get_property', `zpid=${zpid}`],
    
    // Photo patterns
    ['photos', `zpid=${zpid}`],
    ['photo', `zpid=${zpid}`],
    ['images', `zpid=${zpid}`],
    ['image', `zpid=${zpid}`],
    ['media', `zpid=${zpid}`],
    ['gallery', `zpid=${zpid}`],
    ['property_photos', `zpid=${zpid}`],
    ['propertyPhotos', `zpid=${zpid}`],
    ['property-photos', `zpid=${zpid}`],
    ['listingPhotos', `zpid=${zpid}`],
    ['listing_photos', `zpid=${zpid}`],
    ['listing-photos', `zpid=${zpid}`],
    ['property/photos', `zpid=${zpid}`],
    ['property/images', `zpid=${zpid}`],
    ['property/media', `zpid=${zpid}`],
    ['originalPhotos', `zpid=${zpid}`],
    
    // byzpid patterns
    ['property', `byzpid=${zpid}`],
    ['propertyV2', `byzpid=${zpid}`],
    ['detail', `byzpid=${zpid}`],
    ['details', `byzpid=${zpid}`],
    ['photos', `byzpid=${zpid}`],
    ['images', `byzpid=${zpid}`],
    ['media', `byzpid=${zpid}`],
    ['gallery', `byzpid=${zpid}`],
    ['home', `byzpid=${zpid}`],
    ['homedetails', `byzpid=${zpid}`],
    ['hdp', `byzpid=${zpid}`],
    ['listing', `byzpid=${zpid}`],
    
    // Already known working (for reference)
    ['autocomplete', 'query=reston'],
    ['pricehistory', `byzpid=${zpid}`],
    ['comparable_homes', `byzpid=${zpid}`],
    ['nearby', `byzpid=${zpid}`],
    ['similar', `byzpid=${zpid}`],
    ['housing_market', 'search_query=Reston%2C+VA'],
    ['rental_market', 'search_query=20191'],
    ['search/byaddress', 'address=Reston+VA'],
    ['walk_transit_bike', `byzpid=${zpid}`],
    ['climate', `byzpid=${zpid}`],
    
    // Additional patterns to try
    ['zestimate', `zpid=${zpid}`],
    ['zestimate', `byzpid=${zpid}`],
    ['valuation', `byzpid=${zpid}`],
    ['tax', `byzpid=${zpid}`],
    ['facts', `byzpid=${zpid}`],
    ['resoFacts', `byzpid=${zpid}`],
    ['description', `byzpid=${zpid}`],
    ['overview', `byzpid=${zpid}`],
    ['summary', `byzpid=${zpid}`],
    ['floorplan', `byzpid=${zpid}`],
    ['mls', `byzpid=${zpid}`],
    ['custom_ad/byaddress', 'propertyaddress=11308+Geddys+Ct+Reston+VA'],
    ['custom_ad/byzpid', `zpid=${zpid}`],
    ['search/bycoordinates', 'latitude=38.944&longitude=-77.339&radius=1&page=1'],
    ['search/offmarket', 'zipCode=20191'],
    ['forSale', `byzpid=${zpid}`],
    ['forRent', `byzpid=${zpid}`],
    ['schools', `byzpid=${zpid}`],
    ['neighborhood', `byzpid=${zpid}`],
    ['comps', `byzpid=${zpid}`],
  ];

  let found = 0;
  for (const [ep, params] of endpoints) {
    const exists = await test(ep, params);
    if (exists) found++;
    // Small delay to not hit rate limit
    await new Promise(r => setTimeout(r, 150));
  }
  
  console.log(`\n=== Found ${found} working endpoints ===`);
}

go().catch(console.error);
