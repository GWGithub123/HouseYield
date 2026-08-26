import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Home } from 'lucide-react';
import BookkeepingPanel from '../components/BookkeepingPanel';
import { PageShell } from '../design-system';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceActionHandler } from '../contexts/VoiceCommandContext';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { getSavedProperties, type SavedProperty } from '../utils/savedProperties';
import { buildVoiceUiAttrs } from '../utils/voiceUi';

function buildPropertyScopeId(property: SavedProperty | undefined): string | undefined {
  return property?.id || undefined;
}

export default function BookkeepingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [savedProperties, setSavedProperties] = useState<SavedProperty[]>([]);

  const selectedPropertyId = searchParams.get('property') || '';
  const addressQuery = String(searchParams.get('address') || '').trim();

  const normalizePropertyAddress = useCallback((value: string) => (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  ), []);

  const scorePropertyAddressMatch = useCallback((candidate: string, needle: string) => {
    const left = normalizePropertyAddress(candidate);
    const right = normalizePropertyAddress(needle);
    if (!left || !right) return 0;
    if (left === right) return 100;
    if (left.includes(right) || right.includes(left)) return 80;
    const leftTokens = left.split(' ').filter(Boolean);
    const rightTokens = right.split(' ').filter(Boolean);
    const leftNumber = leftTokens.find((token) => /^\d+[a-z]?$/.test(token));
    const rightNumber = rightTokens.find((token) => /^\d+[a-z]?$/.test(token));
    if (leftNumber && rightNumber && leftNumber !== rightNumber) return 0;
    const overlap = rightTokens.filter((token) => leftTokens.includes(token)).length;
    if (overlap < Math.min(2, rightTokens.length)) return 0;
    return overlap * 10 + (leftNumber && rightNumber ? 20 : 0);
  }, [normalizePropertyAddress]);

  useEffect(() => {
    let cancelled = false;

    const loadProperties = async () => {
      if (!user?.id) {
        setSavedProperties(getSavedProperties());
        return;
      }

      try {
        const serverProps = await ownerPropertiesClient.list(user.id);
        if (!cancelled) {
          setSavedProperties(serverProps);
        }
      } catch (err) {
        console.error('[BookkeepingPage] Failed to load properties:', err);
        if (!cancelled) {
          setSavedProperties([]);
        }
      }
    };

    loadProperties();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (savedProperties.length === 0) return;

    if (addressQuery) {
      const ranked = savedProperties
        .map((property) => ({
          property,
          score: scorePropertyAddressMatch(property.address || '', addressQuery),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

      const best = ranked[0]?.property;
      if (best && best.id !== selectedPropertyId) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set('property', best.id);
        nextParams.delete('address');
        setSearchParams(nextParams, { replace: true });
        return;
      }
      if (best && searchParams.has('address')) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('address');
        setSearchParams(nextParams, { replace: true });
        return;
      }
    }

    const matchExists = savedProperties.some((p) => p.id === selectedPropertyId);
    if (matchExists || addressQuery) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('property', savedProperties[0].id);
    setSearchParams(nextParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedProperties, selectedPropertyId, addressQuery, scorePropertyAddressMatch, setSearchParams]);

  const selectedProperty = useMemo(
    () => savedProperties.find((property) => property.id === selectedPropertyId) || savedProperties[0],
    [savedProperties, selectedPropertyId],
  );

  const propertyScopeId = buildPropertyScopeId(selectedProperty);

  const updateProperty = useCallback((propertyId: string) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('property', propertyId);
    nextParams.delete('address');
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  useVoiceActionHandler('nav-bookkeeping', () => {
    navigate('/bookkeeping');
  }, [navigate]);

  const pinnedHeader = (
    <div className="border-b border-slate-200 bg-white/70 px-6 pb-4 pt-5 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div
          {...buildVoiceUiAttrs({
            id: 'bookkeeping-header',
            label: 'Bookkeeping header',
            type: 'section',
            description: 'Bookkeeping page title and property scope selector.',
            pageSection: 'bookkeeping-header',
          })}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-500">Finance</div>
          <div className="mt-2 text-[28px] font-semibold tracking-tight text-slate-900 sm:text-[34px]">Bookkeeping</div>
          <div className="mt-1 text-sm text-slate-600 sm:text-base">
            Recurring entries, rules, reconciliation, and reports.
          </div>
        </div>

        <div className="w-full max-w-sm sm:w-[340px]">
          <label className="block">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:justify-end">
              <Home size={12} className="text-slate-400" />
              Viewing property
            </div>
            <div className="relative">
              <select
                value={selectedProperty?.id || ''}
                onChange={(event) => updateProperty(event.target.value)}
                {...buildVoiceUiAttrs({
                  id: 'bookkeeping-property-select',
                  label: 'Property selector',
                  type: 'input',
                  description: 'Choose the property scope for bookkeeping.',
                  pageSection: 'bookkeeping-header',
                  interactive: true,
                })}
                className="ds-focus-ring w-full appearance-none rounded-2xl border-2 border-slate-300 bg-white px-4 py-3 pr-10 text-[15px] font-semibold text-slate-900 shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-500"
              >
                {savedProperties.length === 0 && <option value="">No saved properties yet</option>}
                {savedProperties.map((property) => (
                  <option key={property.id} value={property.id}>{property.address}</option>
                ))}
              </select>
              <ChevronDown size={18} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
          </label>
        </div>
      </div>
    </div>
  );

  return (
    <PageShell header={pinnedHeader} className="flex-1" contentClassName="space-y-6">
      <div
        {...buildVoiceUiAttrs({
          id: 'bookkeeping-page',
          label: 'Bookkeeping page',
          type: 'section',
          description: 'Bookkeeping workspace with ledger, reports, and reconciliation.',
          pageSection: 'bookkeeping-root',
        })}
      >
        <BookkeepingPanel
          userId={user?.id}
          userEmail={user?.email}
          propertyId={propertyScopeId}
          propertyAddress={selectedProperty?.address}
        />
      </div>
    </PageShell>
  );
}
