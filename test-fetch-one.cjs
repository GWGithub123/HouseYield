/**
 * Fire-and-forget metric fetcher.
 * Writes results to /tmp/metric-results.json
 * Run: node test-fetch-one.cjs <metric> [refresh]
 */
const http = require('http');
const fs = require('fs');

const metric = process.argv[2] || 'gdp';
const refresh = process.argv[3] !== 'false';
const url = `http://localhost:3001/api/fred/heat-map?metric=${metric}${refresh ? '&refresh=true' : ''}`;
const resultsFile = '/tmp/metric-results.json';

// Load existing results
let results = {};
try { results = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch(e) {}

console.log(`Fetching ${metric}... (results go to ${resultsFile})`);
const start = Date.now();

const req = http.get(url, { timeout: 600000 }, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    try {
      const d = JSON.parse(body);
      if (d.data) {
        results[metric] = {
          count: d.data.stats.count,
          range: d.data.stats.valueRange,
          avgGrowth: d.data.stats.avgGrowth,
          cached: d.cached,
          elapsed: elapsed + 's',
          ts: new Date().toISOString()
        };
        console.log(`✅ ${metric}: ${d.data.stats.count} metros (${elapsed}s)`);
      } else {
        results[metric] = { error: 'no data', elapsed: elapsed + 's' };
        console.log(`⚠️ ${metric}: no data (${elapsed}s)`);
      }
    } catch(e) {
      results[metric] = { error: e.message, elapsed: elapsed + 's' };
      console.log(`❌ ${metric}: parse error (${elapsed}s)`);
    }
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log('Results saved.');
  });
});
req.on('error', (e) => {
  results[metric] = { error: e.message };
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`❌ ${metric}: ${e.message}`);
});
