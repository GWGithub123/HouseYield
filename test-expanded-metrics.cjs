const http = require('http');

function fetchMetric(metric) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:3001/api/fred/heat-map?metric=${metric}&refresh=true`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error for ${metric}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  // Test each formerly-legacy metric + GDP
  const metrics = ['unemployment'];
  
  for (const metric of metrics) {
    console.log(`\n=== Testing ${metric} ===`);
    const start = Date.now();
    try {
      const result = await fetchMetric(metric);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  Count: ${result.stats?.count || 0} metros`);
      console.log(`  Range: ${result.stats?.valueRange?.min?.toFixed(1)} – ${result.stats?.valueRange?.max?.toFixed(1)}`);
      console.log(`  Avg YoY: ${result.stats?.avgGrowth}`);
      console.log(`  Time: ${elapsed}s`);
      // Show a few sample points
      if (result.points?.length) {
        const samples = result.points.slice(0, 3);
        for (const p of samples) {
          console.log(`  → ${p.name}: ${p.value} (${p.date})`);
        }
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }
  
  console.log('\n=== DONE ===');
})();
