// Quick test to see what Polymarket API actually returns
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function test() {
  const response = await fetch(`${GAMMA_API}/markets?active=true&closed=false&query=fed&limit=5`);
  const data = await response.json();
  
  console.log('Total markets:', data.length);
  
  for (let i = 0; i < Math.min(3, data.length); i++) {
    const m = data[i];
    console.log(`\nMarket ${i+1}:`);
    console.log('  Question:', m.question);
    console.log('  outcomePrices type:', typeof m.outcomePrices);
    console.log('  outcomePrices value:', m.outcomePrices);
    console.log('  Is Array?:', Array.isArray(m.outcomePrices));
    
    if (typeof m.outcomePrices === 'string') {
      try {
        const parsed = JSON.parse(m.outcomePrices);
        console.log('  Parsed:', parsed);
        console.log('  First element:', parsed[0]);
      } catch (e) {
        console.log('  Parse error:', e.message);
      }
    } else if (Array.isArray(m.outcomePrices)) {
      console.log('  First element:', m.outcomePrices[0]);
    }
  }
}

test().catch(console.error);
