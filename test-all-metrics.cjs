/**
 * Fetch ALL expanded metrics sequentially.
 * Results saved to /tmp/metric-results.json
 * Run: node test-all-metrics.cjs
 */
const http = require('http');
const fs = require('fs');

const METRICS = ['income', 'permits', 'wages', 'daysOnMarket', 'newListings', 'listingPrice', 'priceReduced', 'rentPrice'];
const resultsFile = '/tmp/metric-results.json';

let results = {};
try { results = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch(e) {}

function fetchMetric(metric) {
  return new Promise((resolve) => {
    const url = `http://localhost:3001/api/fred/heat-map?metric=${metric}&refresh=true`;
    const start = Date.now();
    const logLine = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync('/tmp/metric-fetch-progress.log', line);
      process.stdout.write(msg + '\n');
    };
    logLine(`⏳ Fetching ${metric}...`);

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
              cached: !!d.cached,
              elapsed: elapsed + 's',
              ts: new Date().toISOString()
            };
            logLine(`✅ ${metric}: ${d.data.stats.count} metros (${elapsed}s)${d.cached ? ' [CACHED]' : ' [FRESH]'}`);
          } else {
            results[metric] = { error: 'no data', elapsed: elapsed + 's' };
            logLine(`⚠️  ${metric}: no data (${elapsed}s)`);
          }
        } catch(e) {
          results[metric] = { error: e.message, elapsed: elapsed + 's' };
          logLine(`❌ ${metric}: parse error (${elapsed}s)`);
        }
        fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        resolve();
      });
    });
    req.on('error', (e) => {
      results[metric] = { error: e.message };
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      results[metric] = { error: 'timeout' };
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
      resolve();
    });
  });
}

async function main() {
  const logLine = (msg) => {
    fs.appendFileSync('/tmp/metric-fetch-progress.log', `[${new Date().toISOString()}] ${msg}\n`);
    console.log(msg);
  };

  logLine('=== Starting sequential metric fetch ===');
  logLine(`Metrics: ${METRICS.join(', ')}`);

  for (const m of METRICS) {
    await fetchMetric(m);
    // 3 second pause between metrics
    await new Promise(r => setTimeout(r, 3000));
  }

  logLine('\n=== ALL DONE ===');
  logLine(JSON.stringify(results, null, 2));
}

main().catch(console.error);
