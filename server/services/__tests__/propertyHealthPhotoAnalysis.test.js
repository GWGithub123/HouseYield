import { describe, expect, it } from 'vitest';

import { normalizePropertyHealthPhotoAnalysis } from '../propertyHealthPhotoAnalysis.js';

describe('property health photo normalization', () => {
  it('preserves visible evidence and data-plate identity', () => {
    const result = normalizePropertyHealthPhotoAnalysis({
      componentPresent: true,
      category: 'water_heater',
      make: 'Rheem',
      model: 'XE50T10',
      serialNumber: 'RH12345',
      manufactureDate: '2018-03-01',
      conditionScore: 43,
      urgency: 'soon',
      observations: [{
        label: 'Lower seam corrosion',
        severity: 'warning',
        evidence: 'Orange oxidation is visible at the base.',
      }],
      wearSigns: ['Corrosion'],
      failureSigns: ['Possible seepage'],
      recommendedActions: ['Inspect the lower seam'],
      limitations: ['Rear connections not visible'],
      confidence: 0.83,
    }, { category: 'water_heater', name: 'Water heater' });

    expect(result.category).toBe('water_heater');
    expect(result.conditionScore).toBe(43);
    expect(result.manufactureDate).toBe('2018-03-01');
    expect(result.modelIdentityReady).toBe(true);
    expect(result.observations[0].severity).toBe('warning');
  });

  it('does not claim condition when no component is visible', () => {
    const result = normalizePropertyHealthPhotoAnalysis({
      componentPresent: false,
      conditionScore: 90,
      confidence: 0.7,
    }, { category: 'roof', name: 'Roof' });
    expect(result.componentPresent).toBe(false);
    expect(result.conditionScore).toBeNull();
  });

  it('rejects future manufacture dates and unknown enums', () => {
    const result = normalizePropertyHealthPhotoAnalysis({
      category: 'spaceship',
      manufactureDate: '2099-01-01',
      urgency: 'panic',
      confidence: 12,
      observations: [{
        label: 'Something',
        severity: 'catastrophic',
        evidence: 'Visible in frame',
      }],
    }, { category: 'hvac', name: 'HVAC' });
    expect(result.category).toBe('hvac');
    expect(result.manufactureDate).toBeNull();
    expect(result.urgency).toBe('monitor');
    expect(result.confidence).toBe(1);
    expect(result.observations[0].severity).toBe('info');
  });

  it('keeps a null visual score unknown instead of treating it as failed', () => {
    const result = normalizePropertyHealthPhotoAnalysis({
      componentPresent: true,
      conditionScore: null,
      confidence: 0.4,
    }, { category: 'roof', name: 'Roof' });
    expect(result.conditionScore).toBeNull();
  });
});
