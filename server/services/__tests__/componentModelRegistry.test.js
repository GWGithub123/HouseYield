import { describe, expect, it } from 'vitest';

import {
  componentModelKey,
  normalizeComponentModelResearch,
} from '../componentModelRegistry.js';

describe('component model registry normalization', () => {
  it('uses a stable key despite model punctuation and case', () => {
    expect(componentModelKey('water_heater', 'Rheem', 'XE50-T10'))
      .toBe(componentModelKey('water heater', 'RHEEM', 'xe50 t10'));
  });

  it('keeps supported reliability facts and their source links', () => {
    const profile = normalizeComponentModelResearch({
      reliabilityScore: 78,
      observedMedianLifeYears: 9.5,
      observedSampleSize: 240,
      recallCount: 1,
      reviewSummary: 'Generally reliable, with recurring valve complaints.',
      failureModes: ['Valve seepage', 'Valve seepage', 'Anode depletion'],
      installationPitfalls: ['Insufficient expansion control'],
      maintenanceRecommendations: ['Inspect the anode rod'],
      recallNotes: ['Verify serial range before claiming applicability.'],
      confidence: 0.72,
    }, {
      id: 'waterheater_rheem_xe50t10',
      category: 'water_heater',
      make: 'Rheem',
      model: 'XE50T10',
      sources: [
        { title: 'Recall notice', link: 'https://example.com/recall' },
        { title: 'Duplicate', link: 'https://example.com/recall' },
      ],
      researchedAt: '2026-07-27T12:00:00.000Z',
    });

    expect(profile.observedMedianLifeYears).toBe(9.5);
    expect(profile.observedSampleSize).toBe(240);
    expect(profile.failureModes).toEqual(['Valve seepage', 'Anode depletion']);
    expect(profile.sourceUrls).toEqual(['https://example.com/recall']);
    expect(profile.confidence).toBe(0.72);
  });

  it('rejects impossible facts while clamping bounded scores', () => {
    const profile = normalizeComponentModelResearch({
      reliabilityScore: 900,
      observedMedianLifeYears: -5,
      observedSampleSize: -2,
      recallCount: 5000,
      confidence: -1,
    }, {
      id: 'x',
      category: 'unknown',
      make: 'Make',
      model: 'Model',
    });

    expect(profile.category).toBe('other');
    expect(profile.reliabilityScore).toBe(100);
    expect(profile.observedMedianLifeYears).toBeNull();
    expect(profile.observedSampleSize).toBeNull();
    expect(profile.recallCount).toBeNull();
    expect(profile.confidence).toBe(0);
  });

  it('limits arrays so model output cannot bloat Firestore documents', () => {
    const profile = normalizeComponentModelResearch({
      failureModes: Array.from({ length: 30 }, (_, index) => `Failure ${index}`),
    }, {
      id: 'x',
      category: 'hvac',
      make: 'Make',
      model: 'Model',
      sources: Array.from({ length: 40 }, (_, index) => ({
        title: `Source ${index}`,
        link: `https://example.com/${index}`,
      })),
    });
    expect(profile.failureModes).toHaveLength(8);
    expect(profile.sourceUrls).toHaveLength(20);
  });

  it('keeps explicit null research facts unknown rather than turning them into zero', () => {
    const profile = normalizeComponentModelResearch({
      reliabilityScore: null,
      observedMedianLifeYears: null,
      observedSampleSize: null,
      recallCount: null,
    }, {
      id: 'x',
      category: 'hvac',
      make: 'Make',
      model: 'Model',
    });
    expect(profile.reliabilityScore).toBeNull();
    expect(profile.observedMedianLifeYears).toBeNull();
    expect(profile.observedSampleSize).toBeNull();
    expect(profile.recallCount).toBeNull();
  });
});
