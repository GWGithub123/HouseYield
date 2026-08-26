import 'dotenv/config';
const KEY = process.env.Rapid_API_Key;
const HOST = 'private-zillow.p.rapidapi.com';
const H = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
const zpid = '51738660'; // 11308 Geddys Ct, Reston

async function go() {
  // 1. Test comparable_homes — does it have photos?
  console.log('=== comparable_homes ===');
  const comps = await fetch(`https://${HOST}/comparable_homes?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const ch = comps.comparable_homes || [];
  console.log(`  Count: ${ch.length}`);
  for (const c of ch.slice(0, 3)) {
    const p = c.property || c;
    const photos = p.miniCardPhotos || [];
    console.log(`  zpid=${p.zpid}, addr=${p.address?.streetAddress}, photos=${photos.length}, url=${photos[0]?.url?.slice(0,60)}...`);
  }

  // 2. Test nearby — does it have photos or more property data?
  console.log('\n=== nearby ===');
  const nearby = await fetch(`https://${HOST}/nearby?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const np = nearby.nearby_properties || [];
  console.log(`  Count: ${np.length}`);
  for (const p of np.slice(0, 3)) {
    const photos = p.miniCardPhotos || p.photos || [];
    console.log(`  zpid=${p.zpid}, addr=${p.address?.streetAddress}, homeType=${p.homeType}, photos=${photos.length}, price=${p.price}`);
  }

  // 3. Test similar — check full structure
  console.log('\n=== similar ===');
  const sim = await fetch(`https://${HOST}/similar?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const sp = sim.similar_properties;
  console.log(`  Type: ${typeof sp}, isArray: ${Array.isArray(sp)}`);
  if (sp && typeof sp === 'object' && !Array.isArray(sp)) {
    console.log(`  Keys: ${Object.keys(sp).join(', ')}`);
    if (sp.propertyDetails) {
      console.log(`  propertyDetails count: ${sp.propertyDetails.length}`);
      for (const p of sp.propertyDetails.slice(0, 2)) {
        const photos = p.originalPhotos || p.photos || p.miniCardPhotos || [];
        console.log(`    zpid=${p.zpid}, beds=${p.bedrooms}, photos=${photos.length}`);
        if (photos.length > 0) console.log(`    First photo keys: ${Object.keys(photos[0]).join(', ')}`);
      }
    }
  }
  
  // 4. Test pricehistory — check for MLS source info
  console.log('\n=== pricehistory ===');
  const ph = await fetch(`https://${HOST}/pricehistory?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const events = ph.priceHistory || [];
  console.log(`  Events: ${events.length}`);
  for (const e of events.slice(0, 5)) {
    console.log(`  ${e.date} ${e.event} $${e.price} src=${e.source} PSF=${e.pricePerSquareFoot} mlsId=${e.attributeSource?.infoString1}`);
  }

  // 5. Test search/byaddress with city name
  console.log('\n=== search/byaddress with "Reston, VA" ===');
  const search = await fetch(`https://${HOST}/search/byaddress?address=${encodeURIComponent('Reston, VA')}`, { headers: H }).then(r => r.json());
  const sr = search.searchResults || [];
  console.log(`  Total: ${search.resultsCount?.totalMatchingCount || 0}, Page results: ${sr.length}`);
  for (const r of sr.slice(0, 5)) {
    const p = r.property || {};
    const photos = p.media?.allPropertyPhotos?.medium || [];
    console.log(`  zpid=${p.zpid}, addr=${p.address?.streetAddress}, photos=${photos.length}, img=${p.media?.propertyPhotoLinks?.highResolutionLink?.slice(0,50) || 'none'}`);
  }

  // 6. Try endpoint "property_photos" or "listing" that might exist
  console.log('\n=== testing additional endpoints ===');
  for (const ep of ['property_photos', 'listing', 'property/photos', 'listingPhotos', 'hdp']) {
    try {
      const r = await fetch(`https://${HOST}/${ep}?byzpid=${zpid}`, { headers: H });
      const t = await r.text();
      console.log(`  ${ep}: ${r.status} ${t.slice(0, 80)}`);
    } catch (e) {
      console.log(`  ${ep}: ERROR ${e.message}`);
    }
  }
}
go().catch(console.error);
