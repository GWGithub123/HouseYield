import 'dotenv/config';
const KEY = process.env.Rapid_API_Key;
const HOST = 'private-zillow.p.rapidapi.com';
const H = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
const zpid = '51738660';

async function go() {
  // Check nearby structure
  const nearby = await fetch(`https://${HOST}/nearby?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const np = nearby.nearby_properties || [];
  console.log('Nearby contains subject zpid?', np.some(p => String(p.zpid) === zpid));
  if (np[0]) {
    console.log('First nearby ALL keys:', Object.keys(np[0]).sort().join(', '));
    console.log('miniCardPhotos:', JSON.stringify(np[0].miniCardPhotos));
    console.log('hdpUrl:', np[0].hdpUrl);
  }

  // Check nearby for subject's neighbor — does it include subject in ITS nearby?
  const neighbor = np[0];
  if (neighbor) {
    const n2 = await fetch(`https://${HOST}/nearby?byzpid=${neighbor.zpid}`, { headers: H }).then(r => r.json());
    const np2 = n2.nearby_properties || [];
    const subject = np2.find(p => String(p.zpid) === zpid);
    if (subject) {
      console.log('\nFOUND SUBJECT in neighbor nearby!');
      console.log('Subject keys:', Object.keys(subject).sort().join(', '));
      console.log('Subject miniCardPhotos:', JSON.stringify(subject.miniCardPhotos));
      console.log('Subject price:', subject.price);
      console.log('Subject hdpUrl:', subject.hdpUrl);
    } else {
      console.log('\nSubject NOT in neighbor nearby');
    }
  }

  // Use nearby zpids for renovation pair discovery test
  console.log('\n=== Testing pair discovery via nearby+similar ===');
  const similar = await fetch(`https://${HOST}/similar?byzpid=${zpid}`, { headers: H }).then(r => r.json());
  const simProps = similar.similar_properties?.propertyDetails || [];
  console.log(`Similar properties: ${simProps.length}`);

  // Collect all zpids from nearby + similar
  const allZpids = new Set();
  for (const p of np) if (p.zpid) allZpids.add(p.zpid);
  for (const p of simProps) if (p.zpid) allZpids.add(p.zpid);
  console.log(`Total unique zpids from nearby+similar: ${allZpids.size}`);

  // Test price history on a few to see if any have multi-sale
  let pairCount = 0;
  const zpidsToTest = [...allZpids].slice(0, 10);
  for (const z of zpidsToTest) {
    const ph = await fetch(`https://${HOST}/pricehistory?byzpid=${z}`, { headers: H }).then(r => r.json());
    const sold = (ph.priceHistory || []).filter(e => e.event === 'Sold' && e.price > 50000);
    if (sold.length >= 2) {
      pairCount++;
      console.log(`  PAIR: zpid=${z}, sales=${sold.length}, prices=[${sold.map(s => '$'+s.price).join(', ')}]`);
    }
  }
  console.log(`Found ${pairCount} renovation pairs from ${zpidsToTest.length} tested`);
}
go().catch(console.error);
