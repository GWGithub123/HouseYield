/**
 * Test script to diagnose pipeline dropout for renovation comp processing.
 * Calls processAreaRenovations directly and logs detailed stats at each gate.
 */
import dotenv from 'dotenv';
dotenv.config();

// Patch console.log to capture processor gate messages
let gateCounts = {};
function resetGateCounts() {
  gateCounts = {
    totalCandidates: 0,
    noDescription: 0,
    lowScore: 0,
    noRenovations: 0,
    noUplift: 0,
    lowConfidence: 0,
    errors: 0,
    passed: 0,
    scoreDistribution: [],
    detailFetchFails: 0,
    descriptionAvailable: 0,
    descriptionMissing: 0,
    candidateDetails: [], // track each candidate's journey
  };
}
resetGateCounts();

const origLog = console.log;
const origWarn = console.warn;

// Buffer last address being processed
let lastProcessingAddress = '';

console.log = (...args) => {
  const msg = args.join(' ');
  
  // Track which address is being processed
  if (msg.includes('Classifying renovation for:')) {
    const m = msg.match(/for: (.+)$/);
    if (m) lastProcessingAddress = m[1];
  }
  
  if (msg.includes('Low renovation score')) {
    gateCounts.lowScore++;
    const m = msg.match(/score \(([0-9.]+)\)/);
    if (m) {
      const score = parseFloat(m[1]);
      gateCounts.scoreDistribution.push(score);
      gateCounts.candidateDetails.push({ address: lastProcessingAddress, gate: 'low_score', score });
    }
  } else if (msg.includes('No renovations detected')) {
    gateCounts.noRenovations++;
    gateCounts.candidateDetails.push({ address: lastProcessingAddress, gate: 'no_renovations' });
  } else if (msg.includes('Negative/zero uplift') || msg.includes('uplift <=')) {
    gateCounts.noUplift++;
    gateCounts.candidateDetails.push({ address: lastProcessingAddress, gate: 'no_uplift' });
  } else if (msg.includes('Low confidence')) {
    gateCounts.lowConfidence++;
    gateCounts.candidateDetails.push({ address: lastProcessingAddress, gate: 'low_confidence' });
  } else if (msg.includes('Detected') && msg.includes('renovations (score:')) {
    gateCounts.passed++;
    const m = msg.match(/score: ([0-9.]+)/);
    if (m) {
      const score = parseFloat(m[1]);
      gateCounts.scoreDistribution.push(score);
      gateCounts.candidateDetails.push({ address: lastProcessingAddress, gate: 'PASSED', score });
    }
  } else if (msg.includes('pairs found, processing')) {
    const m = msg.match(/(\d+) pairs found, processing (?:top )?(\d+)/);
    if (m) gateCounts.totalCandidates = parseInt(m[2]);
  }
  
  // Suppress noisy output — only show key messages
  if (msg.includes('[RenovationProcessor]') || msg.includes('[ATTOM') || msg.includes('MISS') || msg.includes('HIT') || msg.includes('[UpliftIsolation]') || msg.includes('[UpliftAlloc]')) {
    // Let important messages through but truncate
    if (msg.length > 200) {
      origLog(msg.substring(0, 200) + '...');
    } else {
      origLog.apply(console, args);
    }
  }
};

console.warn = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('Could not fetch property detail')) {
    gateCounts.detailFetchFails++;
  }
  origWarn.apply(console, args);
};

const { processAreaRenovations, CONFIG } = await import('./server/renovation/processor.js');

// Test addresses and their ZIP codes
const testCases = [
  { label: '1905 Bayside Dr, Chester, MD 21619', zip: '21619', state: 'MD' },
  { label: '4137 Barrett Pl, Indian Head, MD 20640', zip: '20640', state: 'MD' },
  { label: '7 Brighton Village Dr, Broomall, PA 19008', zip: '19008', state: 'PA' },
];

const allResults = [];

for (const tc of testCases) {
  origLog(`\n${'='.repeat(80)}`);
  origLog(`TESTING: ${tc.label} (ZIP: ${tc.zip})`);
  origLog(`${'='.repeat(80)}`);
  
  resetGateCounts();
  lastProcessingAddress = '';

  try {
    const startTime = Date.now();
    const result = await processAreaRenovations({
      zipCode: tc.zip,
      state: tc.state,
      limit: 20,
      forceReprocess: true,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    origLog(`\n${'─'.repeat(60)}`);
    origLog(`📊 RESULTS for ${tc.label} (${elapsed}s)`);
    origLog(`${'─'.repeat(60)}`);
    origLog(`Candidate pairs found: ${result.candidatePairsFound}`);
    origLog(`Processed: ${result.processed}`);
    origLog(`Successful: ${result.successful}`);
    origLog(`Skipped: ${result.skipped}`);
    origLog(`Failed: ${result.failed}`);
    origLog(`Renovation types found: ${result.areaSummary?.bestROIRenovations?.length || 0}`);
    origLog(`Total comparables: ${result.areaSummary?.totalComparables || 0}`);
    origLog(`Rental matches: ${result.rentalMatchesUsed || 0}`);
    
    origLog(`\n🔍 GATE DROPOUT ANALYSIS:`);
    origLog(`  Total candidates evaluated: ${gateCounts.totalCandidates}`);
    origLog(`  Property detail API failures: ${gateCounts.detailFetchFails}`);
    origLog(`  ❌ Low renovation score (<0.4): ${gateCounts.lowScore}`);
    origLog(`  ❌ No renovations detected: ${gateCounts.noRenovations}`);
    origLog(`  ❌ No/negative uplift: ${gateCounts.noUplift}`);
    origLog(`  ❌ Low confidence (<25): ${gateCounts.lowConfidence}`);
    origLog(`  ✅ Passed all gates: ${gateCounts.passed}`);
    
    if (gateCounts.scoreDistribution.length > 0) {
      const scores = gateCounts.scoreDistribution.sort((a, b) => a - b);
      origLog(`\n📈 Score Distribution (${scores.length} scores):`);
      origLog(`  Min: ${scores[0]}, Max: ${scores[scores.length - 1]}`);
      origLog(`  Median: ${scores[Math.floor(scores.length / 2)]}`);
      origLog(`  >= 0.4 (pass): ${scores.filter(s => s >= 0.4).length}`);
      origLog(`  0.3-0.39: ${scores.filter(s => s >= 0.3 && s < 0.4).length}`);
      origLog(`  0.2-0.29: ${scores.filter(s => s >= 0.2 && s < 0.3).length}`);
      origLog(`  < 0.2: ${scores.filter(s => s < 0.2).length}`);
    }

    // Show renovation types if found
    if (result.areaSummary?.bestROIRenovations?.length > 0) {
      origLog(`\n🏠 Renovation Types Found:`);
      for (const r of result.areaSummary.bestROIRenovations) {
        origLog(`  ${r.renovationType}: ${r.sampleSize} comps, median uplift $${r.medianValueUplift?.toFixed(0)}, avg $${r.avgValueUplift?.toFixed(0)}, ROI ${r.medianROI?.toFixed(1)}x`);
      }
    }

    // Show first few candidate details for debugging
    const passedCandidates = gateCounts.candidateDetails.filter(c => c.gate === 'PASSED');
    const failedCandidates = gateCounts.candidateDetails.filter(c => c.gate !== 'PASSED');
    
    if (passedCandidates.length > 0) {
      origLog(`\n✅ Passed Candidates (${passedCandidates.length}):`);
      for (const c of passedCandidates.slice(0, 5)) {
        origLog(`  ${c.address} — score: ${c.score}`);
      }
    }
    
    if (failedCandidates.length > 0) {
      origLog(`\n❌ Failed Candidates (first 10 of ${failedCandidates.length}):`);
      for (const c of failedCandidates.slice(0, 10)) {
        origLog(`  ${c.address} — ${c.gate}${c.score != null ? ` (score: ${c.score})` : ''}`);
      }
    }
    
    allResults.push({ address: tc.label, zip: tc.zip, result, gateCounts: { ...gateCounts } });

  } catch (err) {
    origLog(`❌ ERROR for ${tc.label}: ${err.message}`);
    origLog(err.stack?.split('\n').slice(0, 5).join('\n'));
    allResults.push({ address: tc.label, zip: tc.zip, error: err.message });
  }
}

// Final summary
origLog(`\n${'═'.repeat(80)}`);
origLog(`OVERALL SUMMARY`);
origLog(`${'═'.repeat(80)}`);
for (const r of allResults) {
  if (r.error) {
    origLog(`  ❌ ${r.address}: ERROR — ${r.error}`);
  } else {
    origLog(`  ${r.address}: ${r.result.candidatePairsFound} pairs → ${r.result.successful} comps, ${r.result.areaSummary?.bestROIRenovations?.length || 0} reno types`);
  }
}

origLog('\n✅ All tests complete');
process.exit(0);
