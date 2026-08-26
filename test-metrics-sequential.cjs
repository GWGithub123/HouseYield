/**
 * Sequential metric tester — fetches metrics one at a time
 * with proper timeouts, avoiding rate-limit conflicts.
 * Usage: node test-metrics-sequential.cjs [metric1 metric2 ...]
 * Default: tests all expanded metrics with refresh=true
 */
const http = require('http');

const args = process.argv.slice(2);
const METRICS = args.length > 0 ? args :
  ['gdp', 'income', 'permits', 'wages', 'daysOnMarket', 'newListings', 'listingPrice', 'priceReduced', 'rentPrice'];

function fetchMetric(metric, refresh = true) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:3001/api/fred/heat-map?metric=${metric}${refresh ? '&refresh=true' : ''}`;
    console.log(`\n⏳ Fetching ${metric}${refresh ? ' (refresh)' : ''}...`);
    const startTime = Date.now();

    const req = http.get(url, { timeout: 600000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        try {
          const d = JSON.parse(body);
          if (d.data) {
            const s = d.data.stats;
            console.log(`✅ ${metric}: ${s.count} metros (${elapsed}s)${d.cached ? ' [CACHED]' : ' [FRESH]'}`);
            console.log(`   Range: ${s.valueRange.min} – ${s.valueRange.max} | YoY: ${s.avgGrowth}%`);
            resolve({ metric, count: s.count, elapsed, cached: d.cached });
          } else {
            console.log(`⚠️  ${metric}: No data field (${elapsed}s)`);
            resolve({ metric, count: 0, elapsed, error: 'no data' });
          }
        } catch (e) {
          console.log(`❌ ${metric}: Parse error (${elapsed}s) — ${body.slice(0, 200)}`);
          resolve({ metric, count: 0, elapsed, error: e.message });
        }
      });
    });
    req.on('error', (e) => {
      console.log(`❌ ${metric}: ${e.message}`);
      resolve({ metric, count: 0, error: e.message });
    });
    req.on('timeout', () => {
      req.destroy();
      console.log(`❌ ${metric}: Timeout (10min)`);
      resolve({ metric, count: 0, error: 'timeout' });
    });
  });
}

async function main() {
  console.log('=== Sequential Metric Test ===');
  console.log(`Metrics to test: ${METRICS.join(', ')}\n`);

  // First, test already-cached metrics without refresh
  console.log('--- Quick check: existing cached data ---');
  const cachedMetrics = ['listings', 'housing', 'unemployment'];
  for (const m of cachedMetrics) {
    await fetchMetric(m, false);
  }

  // Now fetch expanded metrics with refresh
  console.log('\n--- Fetching expanded metrics (with refresh) ---');
  const results = [];
  for (const m of METRICS) {
    const r = await fetchMetric(m, true);
    results.push(r);
    // Small pause between metric fetches to let rate limits breathe
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('Metric'.padEnd(18), 'Count'.padStart(6), 'Time'.padStart(8), 'Status');
  console.log('-'.repeat(50));
  
  // Include cached results
  for (const m of cachedMetrics) {
    // These were already printed, just for the summary
  }
  
  for (const r of results) {
    const status = r.error ? `❌ ${r.error}` : (r.cached ? '📦 cached' : '🔄 fresh');
    console.log(r.metric.padEnd(18), String(r.count).padStart(6), `${r.elapsed || '?'}s`.padStart(8), status);
  }
}

main().catch(console.error);
