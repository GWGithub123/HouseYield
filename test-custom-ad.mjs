import 'dotenv/config';
const KEY = process.env.Rapid_API_Key;
const HOST = 'private-zillow.p.rapidapi.com';

async function go() {
  const r = await fetch(`https://${HOST}/custom_ad/byzpid?zpid=51738660`, {
    headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY }
  });
  const d = await r.json();
  const pd = d.propertyDetails || {};
  const photos = pd.originalPhotos || [];
  
  console.log(`Total listing photos: ${photos.length}`);
  console.log(`Zestimate: $${pd.zestimate}`);
  console.log(`List Price: $${pd.price}`);
  console.log(`Rent Zestimate: $${pd.rentZestimate}`);
  console.log(`Beds: ${pd.bedrooms}, Baths: ${pd.bathrooms}, Sqft: ${pd.livingArea}`);
  console.log(`Year Built: ${pd.yearBuilt}`);
  console.log(`Home Type: ${pd.homeType}`);
  console.log(`Description: ${(pd.description || '').slice(0, 100)}...`);
  console.log(`\nListing Photos:`);
  
  for (let i = 0; i < photos.length; i++) {
    const jpegs = photos[i]?.mixedSources?.jpeg || [];
    const biggest = jpegs[jpegs.length - 1];
    console.log(`  Photo ${i + 1}: ${biggest?.url?.slice(0, 90)}... (${biggest?.width}px)`);
  }
  
  console.log(`\nTop-level keys: ${Object.keys(d)}`);
  console.log(`PropertyDetails keys: ${Object.keys(pd)}`);
  
  const features = pd.features || {};
  console.log(`\nFeatures keys: ${Object.keys(features)}`);
  console.log(`Heating: ${features.heating}`);
  console.log(`Cooling: ${features.cooling}`);
  console.log(`Flooring: ${features.flooring}`);
  console.log(`Levels: ${features.levels}`);
  console.log(`Construction: ${features.constructionMaterials}`);
}

go().catch(console.error);
