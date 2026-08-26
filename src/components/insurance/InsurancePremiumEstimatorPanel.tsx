import React, { useEffect, useMemo, useState } from 'react';
import type { InsurancePremiumEstimate } from '../../types/iot';
import { authenticatedFetch } from '../../utils/authenticatedFetch';
import InsurancePremiumEstimatorCard from './InsurancePremiumEstimatorCard';

const BACKEND_URL = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';

const INSURERS = [
  { id: '', label: 'No carrier selected' },
  { id: 'state-farm', label: 'State Farm' },
  { id: 'usaa', label: 'USAA' },
  { id: 'travelers', label: 'Travelers' },
  { id: 'nationwide', label: 'Nationwide' },
  { id: 'american-family', label: 'American Family' },
  { id: 'chubb', label: 'Chubb' },
  { id: 'hippo', label: 'Hippo' },
];

interface InsurancePremiumEstimatorPanelProps {
  defaultPropertyValue?: number;
  defaultState?: string;
  defaultOccupancyType?: 'absentee_rental' | 'second_home' | 'owner_occupied';
  defaultPropertyType?: string;
  title?: string;
}

export default function InsurancePremiumEstimatorPanel({
  defaultPropertyValue = 350000,
  defaultState = '',
  defaultOccupancyType = 'absentee_rental',
  defaultPropertyType = 'SFR',
  title = 'Premium savings estimator',
}: InsurancePremiumEstimatorPanelProps) {
  const [propertyValue, setPropertyValue] = useState(String(defaultPropertyValue || ''));
  const [state, setState] = useState(defaultState);
  const [occupancyType, setOccupancyType] = useState(defaultOccupancyType);
  const [propertyType, setPropertyType] = useState(defaultPropertyType);
  const [insurerId, setInsurerId] = useState('');
  const [actualAnnualPremium, setActualAnnualPremium] = useState('');
  const [estimate, setEstimate] = useState<InsurancePremiumEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultPropertyValue) {
      setPropertyValue(String(defaultPropertyValue));
    }
  }, [defaultPropertyValue]);

  useEffect(() => {
    if (defaultState) {
      setState(defaultState);
    }
  }, [defaultState]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('propertyValue', propertyValue || '350000');
    if (state) params.set('state', state);
    params.set('occupancyType', occupancyType);
    params.set('propertyType', propertyType);
    if (insurerId) params.set('insurerId', insurerId);
    if (actualAnnualPremium) params.set('actualAnnualPremium', actualAnnualPremium);
    return params.toString();
  }, [propertyValue, state, occupancyType, propertyType, insurerId, actualAnnualPremium]);

  useEffect(() => {
    if (!propertyValue) return;

    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await authenticatedFetch(`${BACKEND_URL}/api/insurance/premium-estimate?${queryString}`);
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || 'Failed to estimate premium');
        }
        setEstimate(data.estimate);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to estimate premium');
        setEstimate(null);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [queryString, propertyValue]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold text-gray-800">{title}</h3>
        <p className="mt-1 text-sm text-gray-600">
          Estimate current property insurance premiums and the dollar savings HouseYield mitigation may unlock.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-gray-700">Property value</span>
          <input
            type="number"
            value={propertyValue}
            onChange={(event) => setPropertyValue(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">State</span>
          <input
            type="text"
            maxLength={2}
            value={state}
            onChange={(event) => setState(event.target.value.toUpperCase())}
            placeholder="TX"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 uppercase"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Known annual premium (optional)</span>
          <input
            type="number"
            value={actualAnnualPremium}
            onChange={(event) => setActualAnnualPremium(event.target.value)}
            placeholder="Overrides model"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Occupancy</span>
          <select
            value={occupancyType}
            onChange={(event) => setOccupancyType(event.target.value as typeof occupancyType)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          >
            <option value="absentee_rental">Absentee rental</option>
            <option value="second_home">Second / vacation home</option>
            <option value="owner_occupied">Owner occupied</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Property type</span>
          <select
            value={propertyType}
            onChange={(event) => setPropertyType(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          >
            <option value="SFR">Single family</option>
            <option value="CONDO">Condo / townhouse</option>
            <option value="MFR">Multi-family (2-4)</option>
            <option value="APARTMENT">Apartment (5+)</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-gray-700">Insurer (optional)</span>
          <select
            value={insurerId}
            onChange={(event) => setInsurerId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
          >
            {INSURERS.map((insurer) => (
              <option key={insurer.id || 'default'} value={insurer.id}>{insurer.label}</option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="text-sm text-gray-500">Calculating estimate...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {estimate && <InsurancePremiumEstimatorCard estimate={estimate} />}
    </div>
  );
}
