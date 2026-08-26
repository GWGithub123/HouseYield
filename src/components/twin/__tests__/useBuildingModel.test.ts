/**
 * Save must change the drawing even when the write fails.
 *
 * The stacking-plan form used to wait for Firestore, then stay open with no
 * message if the PUT 404'd or the property had no id. From the manager's seat
 * that is "I clicked Save and nothing happened."
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBuildingModel } from '../useBuildingModel';
import type { BuildingSpec } from '../buildingModel';

const plan = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  floors: 4,
  unitsPerFloor: 16,
  corridor: 'double_loaded',
  sharedRisers: true,
  hasBasement: false,
  archetype: 'garden_walkup',
  confidence: 'low',
  needsConfirmation: true,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useBuildingModel.save', () => {
  it('applies the plan locally before the write returns', async () => {
    let finishPut!: (value: Response) => void;
    const put = new Promise<Response>((resolve) => {
      finishPut = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return put;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, model: null }), { status: 200 }));
    }));

    const { result } = renderHook(() => useBuildingModel({
      propertyId: 'prop-1',
      apiBase: '',
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    let savePromise: Promise<boolean>;
    act(() => {
      savePromise = result.current.save(plan(), { confirmedBy: 'owner' });
    });

    expect(result.current.spec.floors).toBe(4);
    expect(result.current.spec.unitsPerFloor).toBe(16);
    expect(result.current.spec.corridor).toBe('double_loaded');
    expect(result.current.confirmed).toBe(true);

    await act(async () => {
      finishPut(new Response(JSON.stringify({
        ok: true,
        model: { spec: plan({ confidence: 'high', needsConfirmation: false }), confirmedBy: 'owner' },
      }), { status: 200 }));
      await savePromise;
    });
  });

  it('keeps the local plan when the write fails, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Firestore unavailable' }), { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, model: null }), { status: 200 }));
    }));

    const { result } = renderHook(() => useBuildingModel({
      propertyId: 'prop-1',
      apiBase: '',
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      const ok = await result.current.save(plan(), { confirmedBy: 'owner' });
      expect(ok).toBe(true);
    });

    expect(result.current.spec.floors).toBe(4);
    expect(result.current.spec.unitsPerFloor).toBe(16);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.error).toMatch(/Firestore unavailable/);
    expect(result.current.error).toMatch(/still using what you entered/);
  });

  it('applies the plan even when the property has no id', async () => {
    const { result } = renderHook(() => useBuildingModel({
      propertyId: null,
      apiBase: '',
    }));

    await act(async () => {
      const ok = await result.current.save(plan(), { confirmedBy: 'owner' });
      expect(ok).toBe(true);
    });

    expect(result.current.spec.floors).toBe(4);
    expect(result.current.confirmed).toBe(true);
    expect(result.current.error).toMatch(/no id/);
  });
});
