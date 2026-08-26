import { describe, expect, it } from 'vitest';

import { createEmptyHealthAsset, type PropertyHealthAttachment } from '../../types/propertyHealth';
import {
  applyHealthPhotoAnalysis,
  type HealthPhotoAnalysis,
} from '../propertyHealthPhotos';

const attachment: PropertyHealthAttachment = {
  id: 'photo-1',
  name: 'plate.jpg',
  url: 'https://example.com/plate.jpg',
  uploadedAt: '2026-07-27T12:00:00.000Z',
};

const analysis: HealthPhotoAnalysis = {
  componentPresent: true,
  category: 'water_heater',
  name: 'Water heater',
  make: 'Rheem',
  model: 'XE50T10',
  serialNumber: 'RH12345',
  manufactureDate: '2018-03-01',
  conditionScore: 42,
  urgency: 'soon',
  summary: 'Corrosion is visible around the lower seam.',
  observations: [{
    label: 'Lower seam corrosion',
    severity: 'warning',
    evidence: 'Orange oxidation is visible around the lower jacket seam.',
  }],
  wearSigns: ['Surface corrosion'],
  failureSigns: ['Possible lower-seam seepage'],
  recommendedActions: ['Have a plumber inspect the lower seam and drain pan.'],
  limitations: ['The rear connections are not visible.'],
  confidence: 0.82,
  modelIdentityReady: true,
};

describe('applyHealthPhotoAnalysis', () => {
  it('fills empty identity fields and stores dated visual evidence', () => {
    const asset = createEmptyHealthAsset({
      id: 'heater',
      category: 'water_heater',
      name: 'Water heater',
      evidence: 'inferred',
    });
    const result = applyHealthPhotoAnalysis(
      asset,
      analysis,
      attachment,
      new Date('2026-07-27T12:00:00.000Z'),
    );

    expect(result.make).toBe('Rheem');
    expect(result.model).toBe('XE50T10');
    expect(result.serialNumber).toBe('RH12345');
    expect(result.provenance?.model?.evidence).toBe('photo');
    expect(result.visualCondition?.score).toBe(42);
    expect(result.visualCondition?.attachmentId).toBe('photo-1');
    expect(result.attachments).toContainEqual(attachment);
  });

  it('does not overwrite stronger owner-confirmed identity', () => {
    const asset = createEmptyHealthAsset({
      id: 'heater',
      category: 'water_heater',
      name: 'Water heater',
      make: 'Bradford White',
      model: 'RE2H50',
      evidence: 'owner',
    });
    const result = applyHealthPhotoAnalysis(asset, analysis, attachment);
    expect(result.make).toBe('Bradford White');
    expect(result.model).toBe('RE2H50');
    expect(result.visualCondition?.score).toBe(42);
  });

  it('never converts manufacture date into installation date', () => {
    const asset = createEmptyHealthAsset({
      id: 'heater',
      category: 'water_heater',
      name: 'Water heater',
      installedAt: null,
    });
    const result = applyHealthPhotoAnalysis(asset, analysis, attachment);
    expect(result.installedAt).toBeNull();
    expect(analysis.manufactureDate).toBe('2018-03-01');
  });

  it('replaces a prior reading from the same attachment rather than duplicating it', () => {
    const asset = createEmptyHealthAsset({
      id: 'heater',
      category: 'water_heater',
      name: 'Water heater',
      attachments: [attachment],
    });
    const result = applyHealthPhotoAnalysis(asset, analysis, attachment);
    expect(result.attachments?.filter((item) => item.id === attachment.id)).toHaveLength(1);
  });
});
