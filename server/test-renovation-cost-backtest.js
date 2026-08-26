#!/usr/bin/env node

import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = `${process.cwd()}/.env.renovation-cost-backtest-disabled`;
process.env.OPENAI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.GOOGLE_SEARCH_API_KEY = '';
process.env.GOOGLE_CSE_CX = '';
process.env.GOOGLE_SEARCH_CX = '';

const { getComprehensiveCostEstimate } = await import('./improved-cost-estimator.js');

const CASES = [
  {
    name: 'measured vanity template totals reconcile',
    input: {
      projectType: 'bathroom',
      projectName: 'Bathroom Vanity Replacement',
      zipCode: '20854',
      qualityLevel: 'midRange',
      validateWithWeb: false,
      measurements: {
        measuredMaterials: [
          { item: 'Vanity 36 inch', quantity: 1, unit: 'each', category: 'vanity', dbKey: 'vanity_36inch', room: 'bathroom' },
          { item: 'Quartz countertop', quantity: 10, unit: 'sq_ft', category: 'countertops', dbKey: 'quartz', room: 'bathroom' },
          { item: 'Interior paint', quantity: 2, unit: 'gallon', category: 'paint', dbKey: 'interior_paint_gallon', room: 'bathroom' },
        ],
        measuredLabor: [
          { task: 'Install vanity', tradeType: 'cabinet_installer', estimatedHours: 4, rateKey: 'cabinet_installer', room: 'bathroom' },
          { task: 'Reconnect plumbing', tradeType: 'plumber', estimatedHours: 3, rateKey: 'plumber', room: 'bathroom' },
          { task: 'Paint bathroom', tradeType: 'painter', estimatedHours: 2, rateKey: 'painter', room: 'bathroom' },
        ],
        roomDimensions: { floorAreaSqFt: 45, wallAreaSqFt: 180, perimeterFt: 28, heightFt: 8 },
        materialQuantities: {},
        uncertainty: { percent: 0.05 },
        confidence: 'high',
      },
    },
    validate(result) {
      const estimate = result.primaryEstimate;
      const materialLineTotal = sumLineCosts(estimate.materials);
      const laborLineTotal = sumLineCosts(estimate.labor);

      assert.equal(estimate.method, 'PROJECT_TEMPLATE');
      assert.equal(estimate.templateKey, 'bathroom_vanity_replace');
      assert.equal(estimate.breakdownSource, 'photo_measured');
      assert.equal(estimate.source, 'HouseYield Measured Breakdown');
      assert.equal(estimate.totalCost, 2511);
      assert.equal(estimate.materialCost, 1635);
      assert.equal(estimate.laborCost, 876);
      assert.deepEqual(estimate.costRange, { low: 1547, high: 4610 });
      assert.equal(materialLineTotal, estimate.materialCost);
      assert.equal(laborLineTotal, estimate.laborCost);
      assert.equal(materialLineTotal + laborLineTotal, estimate.totalCost);
      assert.deepEqual(
        estimate.materials.map((item) => ({ matchedTo: item.matchedTo, totalCost: item.totalCost })),
        [
          { matchedTo: 'vanity_36inch', totalCost: 610 },
          { matchedTo: 'quartz', totalCost: 915 },
          { matchedTo: 'interior_paint_gallon', totalCost: 110 },
        ],
      );
      assert.deepEqual(
        estimate.labor.map((item) => ({ tradeType: item.tradeType, totalCost: item.totalCost })),
        [
          { tradeType: 'cabinet_installer', totalCost: 340 },
          { tradeType: 'plumber', totalCost: 402 },
          { tradeType: 'painter', totalCost: 134 },
        ],
      );
      assert.deepEqual(estimate.templateBaseline, {
        totalCost: 3050,
        laborCost: 915,
        materialCost: 2135,
        costRange: { low: 2288, high: 3813 },
        timeline: '1 day',
        source: 'HouseYield Project Database 2025',
      });
    },
  },
  {
    name: 'fence linear footage scope is preserved',
    input: {
      projectType: 'landscaping',
      projectName: 'Wood Privacy Fence',
      zipCode: '20854',
      qualityLevel: 'midRange',
      validateWithWeb: false,
      scope: { linearFt: 200 },
    },
    validate(result) {
      const estimate = result.primaryEstimate;

      assert.equal(estimate.method, 'PROJECT_TEMPLATE');
      assert.equal(estimate.templateKey, 'fence_wood');
      assert.deepEqual(estimate.scope, { linearFt: 200 });
      assert.equal(estimate.totalCost, 9760);
      assert.equal(estimate.materialCost, 5368);
      assert.equal(estimate.laborCost, 4392);
      assert.deepEqual(estimate.costRange, { low: 7320, high: 12200 });
    },
  },
  {
    name: 'interior paint wall area scope is preserved',
    input: {
      projectType: 'paint',
      projectName: 'Whole House Interior Paint',
      zipCode: '20854',
      qualityLevel: 'midRange',
      validateWithWeb: false,
      scope: { wallSqft: 1600 },
    },
    validate(result) {
      const estimate = result.primaryEstimate;

      assert.equal(estimate.method, 'PROJECT_TEMPLATE');
      assert.equal(estimate.templateKey, 'paint_interior_whole_house');
      assert.deepEqual(estimate.scope, { wallSqft: 1600 });
      assert.equal(estimate.totalCost, 6832);
      assert.equal(estimate.materialCost, 1708);
      assert.equal(estimate.laborCost, 5124);
      assert.deepEqual(estimate.costRange, { low: 5124, high: 8540 });
    },
  },
];

function sumLineCosts(lines = []) {
  return (lines || []).reduce((sum, line) => sum + Number(line?.totalCost || 0), 0);
}

function summarizeResult(result) {
  const estimate = result.primaryEstimate || {};
  return {
    ok: result.ok,
    method: estimate.method,
    templateKey: estimate.templateKey,
    totalCost: estimate.totalCost,
    materialCost: estimate.materialCost,
    laborCost: estimate.laborCost,
    costRange: estimate.costRange,
    scope: estimate.scope,
    breakdownSource: estimate.breakdownSource,
    source: estimate.source,
    templateBaseline: estimate.templateBaseline,
    materialLineTotal: sumLineCosts(estimate.materials),
    laborLineTotal: sumLineCosts(estimate.labor),
  };
}

let failedCount = 0;

for (const testCase of CASES) {
  try {
    const result = await getComprehensiveCostEstimate(testCase.input);
    assert.equal(result.ok, true, 'estimator should return ok=true');
    testCase.validate(result);
    console.log(`PASS ${testCase.name}`);
    console.log(JSON.stringify(summarizeResult(result), null, 2));
  } catch (error) {
    failedCount += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failedCount > 0) {
  console.error(`\n${failedCount} deterministic renovation cost backtest(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${CASES.length} deterministic renovation cost backtests passed.`);