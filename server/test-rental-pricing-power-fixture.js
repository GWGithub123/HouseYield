import assert from 'node:assert/strict';
import { buildRentalComparableSet } from './rentcast.js';
import { estimateVacancyForRentModel, estimateLeaseUpRecoveryForRent } from '../src/utils/rentalVacancyModel.js';
import { estimateVacancyForRent as estimateAssistantVacancy } from './services/assistantRentPotentialService.js';
import { calculateObservedRentalVacancy } from './services/censusRentalVacancyService.js';
import { normalizeRentalConditionAnalysis } from './services/rentalConditionAnalysisService.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const subject = {
  subjectAddress: '11402 Gainsborough Rd, Rockville, MD 20854',
  zipCode: '20854',
  latitude: 39.0463,
  longitude: -77.1696,
  bedrooms: 5,
  bathrooms: 2.5,
  squareFeet: 2271,
  yearBuilt: 1965,
  propertyType: 'Single Family Residence',
  radiusUsed: 3,
};

const baseListings = [
  ['A', '11402 Gainsborough Rd, Rockville, MD 20854', 4700, 2271, 5, 2.5, 'Single Family Residence', 'Active', 61, '2026-05-10'],
  ['B', '10001 Woodhill Rd, Bethesda, MD 20817', 4400, 2647, 5, 3, 'Single Family', 'Active', 24, '2026-06-15'],
  ['C', '9001 Seven Locks Rd, Bethesda, MD 20817', 4200, 2300, 4, 2.5, 'Single Family Residence', 'Active', 19, '2026-06-20'],
  ['D', '12000 Falls Rd, Potomac, MD 20854', 4800, 2450, 5, 3, 'Single Family Residence', 'Active', 33, '2026-06-05'],
  ['E', '10800 Bells Mill Rd, Potomac, MD 20854', 4600, 2150, 5, 2.5, 'Single Family Residence', 'Active', 28, '2026-06-09'],
  ['F', '9900 Democracy Blvd, Potomac, MD 20854', 4500, 2400, 5, 3, 'Single Family Residence', 'Active', 35, '2026-06-01'],
  ['G', '11100 South Glen Rd, Potomac, MD 20854', 4300, 2050, 4, 2, 'Single Family Residence', 'Active', 16, '2026-06-23'],
  ['H', '10200 River Rd, Potomac, MD 20854', 4900, 2550, 5, 3.5, 'Single Family Residence', 'Active', 42, '2026-05-25'],
  ['I', '11500 Brickyard Rd, Potomac, MD 20854', 4750, 2350, 6, 3, 'Single Family Residence', 'Active', 38, '2026-05-30'],
  ['J', '10900 Gainsborough Rd, Potomac, MD 20854', 4450, 2200, 5, 2.5, 'Single Family Residence', 'Active', 27, '2026-06-10'],
  ['J2', '10900 Gainsborough Road, Potomac, MD 20854', 4550, 2200, 5, 2.5, 'Single Family Residence', 'Active', 12, '2026-06-25'],
  ['K', '8800 Example Estate Dr, Potomac, MD 20854', 12000, 2800, 5, 3, 'Single Family Residence', 'Active', 90, '2026-04-01'],
  ['L', '7700 Oversize Manor Rd, Potomac, MD 20854', 9000, 4000, 5, 4, 'Single Family Residence', 'Active', 45, '2026-05-20'],
  ['M', '6600 Condo Way, Bethesda, MD 20817', 3900, 2200, 5, 2.5, 'Condo', 'Active', 20, '2026-06-19'],
  ['N', '5500 Old Listing Rd, Rockville, MD 20852', 3600, 2250, 5, 2.5, 'Single Family Residence', 'Inactive', 120, '2025-12-01'],
].map(([id, formattedAddress, price, squareFootage, bedrooms, bathrooms, propertyType, status, daysOnMarket, listedDate], index) => ({
  id,
  formattedAddress,
  price,
  squareFootage,
  bedrooms,
  bathrooms,
  propertyType,
  status,
  daysOnMarket,
  listedDate,
  yearBuilt: 1960 + (index % 15),
  latitude: subject.latitude + index * 0.001,
  longitude: subject.longitude + index * 0.001,
}));

const gainsboroughSet = buildRentalComparableSet(baseListings, subject);

test('subject listing is excluded', () => {
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'A'), false);
  assert.equal(gainsboroughSet.search.subjectExcluded, true);
  assert.equal(gainsboroughSet.subjectListing?.id, 'A');
  assert.equal(gainsboroughSet.subjectListing?.daysOnMarket, 61);
});

test('property type is normalized before filtering', () => {
  assert.ok(gainsboroughSet.comparables.some((comp) => comp.id === 'B'));
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'M'), false);
});

test('inactive and oversized listings are excluded', () => {
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'N'), false);
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'L'), false);
});

test('duplicate address keeps newest listing', () => {
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'J'), false);
  assert.ok(gainsboroughSet.comparables.some((comp) => comp.id === 'J2'));
});

test('price-per-square-foot outlier is removed', () => {
  assert.equal(gainsboroughSet.comparables.some((comp) => comp.id === 'K'), false);
  assert.ok(gainsboroughSet.outliersRemoved >= 1);
});

test('Gainsborough benchmark is size-adjusted and plausible', () => {
  assert.equal(gainsboroughSet.cleanSampleAdequate, true);
  assert.ok(gainsboroughSet.summary.weightedMedianRent >= 4200);
  assert.ok(gainsboroughSet.summary.weightedMedianRent <= 5000);
  assert.ok(gainsboroughSet.summary.weightedMedianRentPerSqFt > 1.5);
  assert.ok(gainsboroughSet.summary.weightedMedianRentPerSqFt < 2.5);
});

const vacancyModel = {
  anchorRent: 4500,
  baseVacancyRate: 6,
  compP25Rent: 4200,
  compMedianRent: 4500,
  compP75Rent: 4750,
  compP90Rent: 5000,
  supportedCeilingRent: 5400,
  rentAtFullVacancy: 6500,
  minVacancyRate: 2,
  maxVacancyRate: 100,
  domBins: {
    bins: [
      { avgRent: 4200, avgVacancy: 4.5, avgDom: 18, count: 3 },
      { avgRent: 4550, avgVacancy: 6, avgDom: 30, count: 3 },
      { avgRent: 4900, avgVacancy: 8, avgDom: 48, count: 3 },
    ],
  },
};

test('vacancy risk is monotonic above first support bin', () => {
  let previous = estimateVacancyForRentModel(4200, vacancyModel);
  for (let rent = 4250; rent <= 6500; rent += 25) {
    const current = estimateVacancyForRentModel(rent, vacancyModel);
    assert.ok(current >= previous - 0.11, `${rent}: ${current} < ${previous}`);
    previous = current;
  }
});

test('vacancy curve has no large threshold discontinuities', () => {
  let previous = estimateVacancyForRentModel(4000, vacancyModel);
  for (let rent = 4025; rent <= 6500; rent += 25) {
    const current = estimateVacancyForRentModel(rent, vacancyModel);
    assert.ok(Math.abs(current - previous) <= 6, `${rent}: jump ${previous} → ${current}`);
    previous = current;
  }
});

test('market rejection reaches full modeled vacancy', () => {
  assert.equal(estimateVacancyForRentModel(6500, vacancyModel), 100);
});

test('stale subject pressure favors a meaningful price reduction', () => {
  const staleModel = {
    ...vacancyModel,
    subjectCurrentRent: 4700,
    subjectDaysOnMarket: 62,
    subjectStaleThresholdDays: 45,
    subjectMarketingPressure: 4,
    subjectListingIsStale: true,
    marketLeaseUpDays: 30,
    leaseUpPriceElasticity: 8,
    subjectDomEvidenceWeight: 0.35,
  };
  const current = estimateLeaseUpRecoveryForRent(4700, staleModel);
  const reduced = estimateLeaseUpRecoveryForRent(4450, staleModel);
  assert.equal(current.realizedVacancyPct, 17);
  assert.ok(current.projectedCampaignVacancyPct >= 17);
  assert.ok(current.expectedAdditionalLeaseUpDays > reduced.expectedAdditionalLeaseUpDays);
  assert.ok(current.projectedCampaignVacancyPct > reduced.projectedCampaignVacancyPct);
});

test('assistant and canonical vacancy models are identical', () => {
  for (let rent = 3500; rent <= 6500; rent += 50) {
    assert.equal(
      estimateAssistantVacancy(rent, vacancyModel),
      estimateVacancyForRentModel(rent, vacancyModel),
    );
  }
});

test('ACS vacancy uses rental inventory rather than all housing units', () => {
  const evidence = calculateObservedRentalVacancy({
    renterOccupied: 1770,
    vacantForRent: 58,
    rentedNotOccupied: 0,
    occupiedMoe: 312,
    vacantMoe: 49,
    rentedNotOccupiedMoe: 32,
  });
  assert.equal(evidence.vacancyRate, 3.2);
  assert.equal(evidence.rentalInventory, 1828);
  assert.ok(evidence.vacancyRateMoe > 0);
});

test('photo condition adjustment is bounded and evidence weighted', () => {
  const strong = normalizeRentalConditionAnalysis({
    conditionScore: 100,
    conditionClass: 'excellent',
    confidence: 1,
    coverageScore: 1,
  }, 8);
  const weakEvidence = normalizeRentalConditionAnalysis({
    conditionScore: 100,
    conditionClass: 'excellent',
    confidence: 0.4,
    coverageScore: 0.25,
  }, 1);
  const poor = normalizeRentalConditionAnalysis({
    conditionScore: 0,
    conditionClass: 'poor',
    confidence: 1,
    coverageScore: 1,
  }, 8);
  assert.equal(strong.rentAdjustmentPct, 4);
  assert.ok(weakEvidence.rentAdjustmentPct < strong.rentAdjustmentPct);
  assert.equal(poor.rentAdjustmentPct, -5);
});

console.log(`\n${passed} rental pricing power tests passed.`);
