import { describe, it, expect } from 'vitest';
import {
  buildAssetsFromPermits,
  classifyPermit,
  mergePermitAssets,
} from '../propertyHealthPermits';
import { buildPropertyHealthPriors } from '../propertyHealthPriors';
import { createEmptyHealthAsset } from '../../types/propertyHealth';
import type { BuildingPermit } from '../../types/attom';

const permit = (extra: Partial<BuildingPermit>): BuildingPermit => ({
  source: 'test',
  ...extra,
});

describe('permit classification', () => {
  it('routes a reroof permit to roof, not exterior', () => {
    const rule = classifyPermit(permit({ work_description: 'Tear off and reroof with architectural shingle' }));
    expect(rule?.category).toBe('roof');
  });

  it('prefers the specific water heater rule over generic plumbing', () => {
    const rule = classifyPermit(permit({ work_description: 'Plumbing permit for water heater replacement' }));
    expect(rule?.category).toBe('water_heater');
  });

  it('does not treat a window well permit as window replacement', () => {
    expect(classifyPermit(permit({ work_description: 'Egress window well installation' }))).toBeNull();
  });

  it('ignores a permit it cannot categorize', () => {
    expect(classifyPermit(permit({ work_description: 'Fence installation, 6ft privacy' }))).toBeNull();
    expect(classifyPermit(permit({}))).toBeNull();
  });
});

describe('building assets from permits', () => {
  it('skips permits without a usable date rather than inventing one', () => {
    const assets = buildAssetsFromPermits([
      permit({ work_description: 'Reroof' }),
      permit({ work_description: 'Reroof', issue_date: 'not a date' }),
      permit({ work_description: 'Reroof', issue_date: '1823-01-01' }),
    ]);
    expect(assets).toHaveLength(0);
  });

  it('keeps only the most recent permit per system', () => {
    const assets = buildAssetsFromPermits([
      permit({ work_description: 'Reroof', issue_date: '2004-06-01', permit_number: 'OLD' }),
      permit({ work_description: 'Reroof', issue_date: '2019-08-14', permit_number: 'NEW' }),
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0].installedAt).toBe('2019-08-14');
    expect(assets[0].provenance?.installedAt?.sourceRef).toBe('NEW');
  });

  it('records the permit as the evidence and cites the number', () => {
    const [asset] = buildAssetsFromPermits([
      permit({ work_description: 'Water heater replacement', issue_date: '2021-03-02', permit_number: 'P-991' }),
    ]);

    expect(asset.evidence).toBe('permit');
    expect(asset.provenance?.installedAt?.rationale).toContain('P-991');
  });
});

describe('merging permits into the inventory', () => {
  it('overrides a vintage guess with the dated permit', () => {
    const { assets: priors } = buildPropertyHealthPriors({ yearBuilt: 1968 }, new Date('2026-07-26'));
    const permitAssets = buildAssetsFromPermits([
      permit({ work_description: 'Reroof', issue_date: '2019-08-14' }),
    ]);

    const merged = mergePermitAssets(priors, permitAssets);
    const roof = merged.filter((asset) => asset.category === 'roof');

    expect(roof).toHaveLength(1);
    expect(roof[0].evidence).toBe('permit');
    expect(roof[0].installedAt).toBe('2019-08-14');
  });

  it('leaves an owner-confirmed record alone', () => {
    const owned = [
      createEmptyHealthAsset({
        category: 'roof',
        name: 'Roof',
        installedAt: '2022-05-01',
        evidence: 'owner',
      }),
    ];
    const permitAssets = buildAssetsFromPermits([
      permit({ work_description: 'Reroof', issue_date: '2019-08-14' }),
    ]);

    const merged = mergePermitAssets(owned, permitAssets);
    expect(merged).toHaveLength(1);
    expect(merged[0].evidence).toBe('owner');
    expect(merged[0].installedAt).toBe('2022-05-01');
  });

  it('preserves the record id when a permit upgrades it, so linked spend survives', () => {
    const priors = [
      createEmptyHealthAsset({
        id: 'existing-roof-id',
        category: 'roof',
        name: 'Roof',
        evidence: 'inferred',
      }),
    ];
    const permitAssets = buildAssetsFromPermits([
      permit({ work_description: 'Reroof', issue_date: '2019-08-14' }),
    ]);

    const merged = mergePermitAssets(priors, permitAssets);
    expect(merged[0].id).toBe('existing-roof-id');
    expect(merged[0].evidence).toBe('permit');
  });

  it('adds a category the inventory did not have at all', () => {
    const permitAssets = buildAssetsFromPermits([
      permit({ work_description: 'Panel upgrade to 200 amp service', issue_date: '2020-01-15' }),
    ]);

    const merged = mergePermitAssets([], permitAssets);
    expect(merged.map((asset) => asset.category)).toContain('electrical');
  });
});
