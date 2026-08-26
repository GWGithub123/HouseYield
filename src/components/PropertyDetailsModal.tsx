/**
 * PropertyDetailsModal Component
 * Displays detailed property information in a modal overlay on the map
 * 
 * Fetches and displays all ATTOM data including:
 * - Property summary (beds, baths, value, etc.)
 * - Tax history with trends
 * - Environmental risks
 * - Building permits
 * - Schools and district info
 * - Mortgage and assumability analysis
 */

import React, { useEffect, useState } from 'react';
import type { PropertyDashboard } from '../types/attom';
import { useAuth } from '../contexts/AuthContext';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { saveProperty, removeSavedProperty, isPropertySaved } from '../utils/savedProperties';
import { taxClient } from '../services/canonicalTaxClient';

interface PropertyDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  address?: string;
  embedded?: boolean;
  focusSection?: PropertyDetailsFocusSection;
  propertyData?: PropertyDashboard | null;
  hideFooter?: boolean;
  /** Bookkeeping property ID — when provided, ATTOM mortgage data is silently
   *  synced to the tax property record so the CPA packet can display the lender. */
  taxPropertyId?: string;
}

export type PropertyDetailsFocusSection =
  | 'overview'
  | 'tax-history'
  | 'mortgage'
  | 'owner'
  | 'environmental'
  | 'schools'
  | 'building-permits'
  | 'sale-history'
  | 'location';

export const PropertyDetailsModal: React.FC<PropertyDetailsModalProps> = ({
  isOpen,
  onClose,
  address,
  embedded = false,
  focusSection,
  propertyData = null,
  hideFooter = false,
  taxPropertyId,
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PropertyDashboard | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const showSection = (section: PropertyDetailsFocusSection) => !focusSection || focusSection === section;

  // Fetch property data when modal opens
  useEffect(() => {
    if ((isOpen || embedded) && propertyData) {
      setData(propertyData);
      setLoading(false);
      setError(null);
      setSaveError(null);
      return;
    }

    if ((!isOpen && !embedded) || !address) {
      setData(null);
      setError(null);
      setSaveError(null);
      return;
    }

    let cancelled = false;

    const fetchPropertyData = async () => {
      setLoading(true);
      setError(null);
      setSaveError(null);
      
      try {
        // In development, always use localhost:3001 directly
        // In production, use the configured server URL
        const baseEnv = (import.meta as any).env?.VITE_PUSH_SERVER_URL;
        const url = baseEnv 
          ? `${baseEnv}/api/attom/dashboard?address=${encodeURIComponent(address)}`
          : `http://localhost:3001/api/attom/dashboard?address=${encodeURIComponent(address)}`;
        
        console.log('[PropertyModal] Fetching data for:', address);
        console.log('[PropertyModal] URL:', url);
        
        const response = await fetch(url);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch property data: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('[PropertyModal] Data received:', result);
        
        if (!result.ok) {
          throw new Error(result.error || 'Failed to fetch property data');
        }
        
        if (cancelled) return;

        setData(result.data);
        
        // Check if property is already saved
        if (user?.id) {
          const savedProperty = await ownerPropertiesClient.findByAddress(user.id, address);
          if (!cancelled) {
            setIsSaved(Boolean(savedProperty));
          }
        } else {
          setIsSaved(isPropertySaved(address, result.data.summary.attom_id));
        }
      } catch (err: any) {
        console.error('[PropertyModal] Error:', err);
        if (!cancelled) {
          setError(err.message || 'Failed to load property data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchPropertyData();

    return () => {
      cancelled = true;
    };
  }, [address, embedded, isOpen, propertyData, user?.id]);

  // Silently enrich the bookkeeping property record with ATTOM mortgage data
  // so the tax checklist can display the lender name.
  useEffect(() => {
    if (!taxPropertyId || !data?.summary?.mortgage) return;
    const mortgage = data.summary.mortgage;
    const lenderName = mortgage.lender_name;
    if (!lenderName) return;

    taxClient.enrichPropertyMortgage(taxPropertyId, {
      mortgageLender: lenderName,
      mortgageAmount: mortgage.amount ?? undefined,
      mortgageRate: mortgage.estimated_interest_rate ?? undefined,
      mortgageDate: mortgage.date ?? undefined,
    }).catch(() => {
      // Non-critical — enrichment failure should not surface to user
    });
  }, [taxPropertyId, data]);

  // Handle save/unsave property
  const handleToggleSave = async () => {
    if (!data || !address || saveBusy) return;

    setSaveError(null);

    if (user?.id) {
      setSaveBusy(true);
      try {
        if (isSaved) {
          const savedProperty = await ownerPropertiesClient.findByAddress(user.id, address);
          if (savedProperty) {
            await ownerPropertiesClient.remove(user.id, savedProperty.id);
          }
          setIsSaved(false);
        } else {
          await ownerPropertiesClient.save({
            ownerId: user.id,
            address,
            propertyData: data,
          });
          setIsSaved(true);
        }
      } catch (err: any) {
        console.error('[PropertyModal] Save toggle failed:', err);
        setSaveError(err.message || 'Failed to update the saved property in Firestore');
      } finally {
        setSaveBusy(false);
      }
      return;
    }
    
    if (isSaved) {
      const id = data.summary.attom_id || btoa(address).substring(0, 20);
      removeSavedProperty(id);
      setIsSaved(false);
    } else {
      saveProperty(address, data);
      setIsSaved(true);
    }
  };

  if (!isOpen && !embedded) return null;

  const content = (
    <>
      {loading && (
        <div className="text-center text-gray-500 py-12">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-emerald-600 mx-auto mb-4"></div>
          <p className="text-lg font-medium">Loading property data...</p>
          <p className="text-sm mt-2">Fetching details from ATTOM Data API</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <svg className="w-12 h-12 mx-auto mb-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-lg font-medium text-red-900 mb-2">Error Loading Property</p>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          {showSection('overview') ? (
            <section className="bg-gradient-to-br from-emerald-50 to-blue-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                Property Overview
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {data.summary.beds !== undefined && (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <div className="text-sm text-gray-600">Bedrooms</div>
                    <div className="text-2xl font-bold text-gray-900">{data.summary.beds}</div>
                  </div>
                )}
                {data.summary.baths !== undefined && (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <div className="text-sm text-gray-600">Bathrooms</div>
                    <div className="text-2xl font-bold text-gray-900">{data.summary.baths}</div>
                  </div>
                )}
                {data.summary.living_sqft !== undefined && (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <div className="text-sm text-gray-600">Living Area</div>
                    <div className="text-2xl font-bold text-gray-900">{data.summary.living_sqft.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">sq ft</div>
                  </div>
                )}
                {data.summary.year_built !== undefined && (
                  <div className="bg-white rounded-lg p-3 shadow-sm">
                    <div className="text-sm text-gray-600">Year Built</div>
                    <div className="text-2xl font-bold text-gray-900">{data.summary.year_built}</div>
                    {data.summary.age !== undefined && (
                      <div className="text-xs text-gray-500">{data.summary.age} years old</div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                {data.summary.avm_value !== undefined && (
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-gray-600 mb-1">Estimated Value (AVM)</div>
                    <div className="text-2xl font-bold text-emerald-600">
                      ${data.summary.avm_value.toLocaleString()}
                    </div>
                    {(data.summary.avm_low || data.summary.avm_high) && (
                      <div className="text-xs text-gray-500 mt-1">
                        Range: ${data.summary.avm_low?.toLocaleString()} - ${data.summary.avm_high?.toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
                {data.summary.rental_avm !== undefined && (
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-gray-600 mb-1">Estimated Rent</div>
                    <div className="text-2xl font-bold text-blue-600">
                      ${data.summary.rental_avm.toLocaleString()}/mo
                    </div>
                    {(data.summary.rental_avm_low || data.summary.rental_avm_high) && (
                      <div className="text-xs text-gray-500 mt-1">
                        Range: ${data.summary.rental_avm_low?.toLocaleString()} - ${data.summary.rental_avm_high?.toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
                {data.summary.price_per_sqft !== undefined && (
                  <div className="bg-white rounded-lg p-4 shadow-sm">
                    <div className="text-sm text-gray-600 mb-1">Price per Sq Ft</div>
                    <div className="text-2xl font-bold text-purple-600">
                      ${Math.round(data.summary.price_per_sqft).toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {data.summary.property_type && (
                <div className="mt-4 flex gap-2 flex-wrap">
                  <span className="px-3 py-1 bg-white rounded-full text-sm font-medium text-gray-700 border">
                    {data.summary.property_type}
                  </span>
                  {data.summary.lot_acres && (
                    <span className="px-3 py-1 bg-white rounded-full text-sm font-medium text-gray-700 border">
                      {data.summary.lot_acres} acres
                    </span>
                  )}
                </div>
              )}
            </section>
          ) : null}

          {showSection('tax-history') && data.tax_history && data.tax_history.length > 0 ? (
            <section className="bg-white rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                Property Tax History
              </h3>

              {data.tax_meta && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Latest Tax</div>
                    <div className="text-2xl font-bold text-blue-900">
                      ${data.tax_history[0].tax_amount?.toLocaleString()}
                    </div>
                    <div className="text-xs text-gray-500">Year {data.tax_history[0].year}</div>
                  </div>
                  {data.tax_meta.cagr_full !== null && data.tax_meta.cagr_full !== undefined && (
                    <div className="bg-gradient-to-br from-orange-50 to-red-50 rounded-lg p-4">
                      <div className="text-sm text-gray-600 mb-1">Historical Growth (CAGR)</div>
                      <div className="text-2xl font-bold text-orange-900">
                        {(data.tax_meta.cagr_full * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-gray-500">All years</div>
                    </div>
                  )}
                  {data.tax_meta.cagr_5yr !== null && data.tax_meta.cagr_5yr !== undefined && (
                    <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-4">
                      <div className="text-sm text-gray-600 mb-1">5-Year Growth (CAGR)</div>
                      <div className="text-2xl font-bold text-purple-900">
                        {(data.tax_meta.cagr_5yr * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-gray-500">Last 5 years</div>
                    </div>
                  )}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b-2">
                    <tr>
                      <th className="text-left px-4 py-2 font-semibold text-gray-700">Year</th>
                      <th className="text-right px-4 py-2 font-semibold text-gray-700">Tax Amount</th>
                      <th className="text-right px-4 py-2 font-semibold text-gray-700">YoY Change</th>
                      <th className="text-right px-4 py-2 font-semibold text-gray-700">Assessed Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tax_history.slice(0, 10).map((tax, idx) => (
                      <tr key={tax.year} className={idx % 2 === 0 ? 'bg-gray-50' : 'bg-white'}>
                        <td className="px-4 py-2 font-medium">{tax.year}</td>
                        <td className="px-4 py-2 text-right">
                          {tax.tax_amount ? `$${tax.tax_amount.toLocaleString()}` : '-'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {tax.tax_amount_yoy_pct !== undefined ? (
                            <span className={tax.tax_amount_yoy_pct >= 0 ? 'text-red-600' : 'text-green-600'}>
                              {(tax.tax_amount_yoy_pct * 100).toFixed(1)}%
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {tax.assessed_total ? `$${tax.assessed_total.toLocaleString()}` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {showSection('mortgage') && data.summary.mortgage ? (
            <section className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Mortgage Information
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-gray-600">Lender</div>
                  <div className="font-semibold text-gray-900">{data.summary.mortgage.lender_name || 'Unknown'}</div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-gray-600">Loan Type</div>
                  <div className="font-semibold text-gray-900">{data.summary.mortgage.loan_type || 'Unknown'}</div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-gray-600">Original Amount</div>
                  <div className="font-semibold text-gray-900">
                    {data.summary.mortgage.amount ? `$${data.summary.mortgage.amount.toLocaleString()}` : 'Unknown'}
                  </div>
                </div>
                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-gray-600">Origination Date</div>
                  <div className="font-semibold text-gray-900">{data.summary.mortgage.date || 'Unknown'}</div>
                </div>
                {data.summary.mortgage.estimated_interest_rate && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600">Est. Interest Rate</div>
                    <div className="font-semibold text-blue-600">{data.summary.mortgage.estimated_interest_rate.toFixed(2)}%</div>
                  </div>
                )}
                {data.summary.mortgage.estimated_monthly_payment_pi && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600">Est. Monthly Payment (P&I)</div>
                    <div className="font-semibold text-green-600">
                      ${data.summary.mortgage.estimated_monthly_payment_pi.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {data.summary.mortgage.assumability && (
                <div className="mt-4 bg-white rounded-lg p-4 border-2 border-amber-200">
                  <div className="flex items-start gap-3">
                    <div className={`mt-1 px-3 py-1 rounded-full text-sm font-bold ${
                      data.summary.mortgage.assumability.assumable === 'likely' ? 'bg-green-100 text-green-800' :
                      data.summary.mortgage.assumability.assumable === 'possible' ? 'bg-yellow-100 text-yellow-800' :
                      data.summary.mortgage.assumability.assumable === 'unlikely' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {data.summary.mortgage.assumability.assumable.toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-gray-900 mb-1">Mortgage Assumability</div>
                      <div className="text-sm text-gray-700 mb-2">{data.summary.mortgage.assumability.reason}</div>
                      {data.summary.mortgage.assumability.attractiveness && (
                        <div className="text-sm">
                          <span className="font-medium">Financial Attractiveness: </span>
                          <span className={
                            data.summary.mortgage.assumability.attractiveness === 'very_attractive' ? 'text-green-600 font-semibold' :
                            data.summary.mortgage.assumability.attractiveness === 'attractive' ? 'text-blue-600 font-semibold' :
                            'text-gray-600'
                          }>
                            {data.summary.mortgage.assumability.attractiveness.replace('_', ' ')}
                          </span>
                        </div>
                      )}
                      {data.summary.mortgage.assumability.nextSteps && data.summary.mortgage.assumability.nextSteps.length > 0 && (
                        <div className="mt-2">
                          <div className="text-sm font-medium text-gray-700 mb-1">Next Steps:</div>
                          <ul className="text-xs text-gray-600 list-disc list-inside space-y-1">
                            {data.summary.mortgage.assumability.nextSteps.map((step, idx) => (
                              <li key={idx}>{step}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {showSection('owner') && data.summary.owner ? (
            <section className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Owner Information
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.summary.owner.owner1_name && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Owner</div>
                    <div className="font-semibold text-gray-900">{data.summary.owner.owner1_name}</div>
                    {data.summary.owner.owner2_name && (
                      <div className="font-semibold text-gray-900 mt-1">{data.summary.owner.owner2_name}</div>
                    )}
                    {data.summary.owner.owner3_name && (
                      <div className="font-semibold text-gray-900 mt-1">{data.summary.owner.owner3_name}</div>
                    )}
                  </div>
                )}

                <div className="bg-white rounded-lg p-4">
                  <div className="text-sm text-gray-600 mb-1">Ownership Type</div>
                  <div className="font-semibold text-gray-900">
                    {data.summary.owner.is_corporate ? 'Corporate' : 'Individual'}
                  </div>
                </div>

                {data.summary.owner.absentee_status && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Occupancy Status</div>
                    <div className="font-semibold text-gray-900">
                      {data.summary.owner.absentee_status === 'O' ? 'Owner Occupied' :
                       data.summary.owner.absentee_status === 'A' ? 'Absentee Owner' :
                       data.summary.owner.absentee_status}
                    </div>
                  </div>
                )}

                {data.summary.owner.relationship_type && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Relationship Type</div>
                    <div className="font-semibold text-gray-900">{data.summary.owner.relationship_type}</div>
                  </div>
                )}

                {data.summary.owner.mailing_address && (
                  <div className="bg-white rounded-lg p-4 md:col-span-2">
                    <div className="text-sm text-gray-600 mb-1">Mailing Address</div>
                    <div className="font-semibold text-gray-900 text-sm">{data.summary.owner.mailing_address}</div>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {showSection('environmental') && data.environmental ? (
            <section className="bg-white rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Environmental Risks
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(data.environmental).map(([risk, riskData]: [string, any]) => {
                  if (!riskData || typeof riskData !== 'object') return null;

                  const getRiskLevel = () => {
                    const score = riskData.riskScore || riskData.score || riskData.level;
                    if (typeof score === 'string') {
                      if (score.toLowerCase().includes('low') || score === '1') return 'low';
                      if (score.toLowerCase().includes('moderate') || score === '2') return 'moderate';
                      if (score.toLowerCase().includes('high') || score === '3') return 'high';
                    }
                    if (typeof score === 'number') {
                      if (score <= 3) return 'low';
                      if (score <= 6) return 'moderate';
                      return 'high';
                    }
                    return 'unknown';
                  };

                  const level = getRiskLevel();
                  const colorClass = level === 'low' ? 'bg-green-50 border-green-200 text-green-800' :
                    level === 'moderate' ? 'bg-yellow-50 border-yellow-200 text-yellow-800' :
                    level === 'high' ? 'bg-red-50 border-red-200 text-red-800' :
                    'bg-gray-50 border-gray-200 text-gray-800';

                  return (
                    <div key={risk} className={`rounded-lg p-3 border ${colorClass}`}>
                      <div className="text-xs font-semibold uppercase mb-1">
                        {risk === 'airQuality' ? 'Air Quality' : risk}
                      </div>
                      <div className="text-sm font-bold capitalize">{level}</div>
                      {riskData.nasa_enhancement && (
                        <div className="text-xs mt-1 opacity-75">
                          NASA Enhanced
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {showSection('schools') && data.schools && data.schools.length > 0 ? (
            <section className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14l9-5-9-5-9 5 9 5z" />
                  <path d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14zm-4 6v-7.5l4-2.222" />
                </svg>
                Nearby Schools ({data.schools.length})
              </h3>

              {data.school_district && (
                <div className="bg-white rounded-lg p-4 mb-4 border">
                  <div className="font-semibold text-lg text-gray-900 mb-2">
                    {data.school_district.name}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    {data.school_district.total_schools && (
                      <div>
                        <div className="text-gray-600">Total Schools</div>
                        <div className="font-semibold">{data.school_district.total_schools}</div>
                      </div>
                    )}
                    {data.school_district.enrollment && (
                      <div>
                        <div className="text-gray-600">Enrollment</div>
                        <div className="font-semibold">{data.school_district.enrollment.toLocaleString()}</div>
                      </div>
                    )}
                    {data.school_district.pupil_teacher_ratio && (
                      <div>
                        <div className="text-gray-600">Student:Teacher</div>
                        <div className="font-semibold">{data.school_district.pupil_teacher_ratio}:1</div>
                      </div>
                    )}
                    {data.school_district.rating && (
                      <div>
                        <div className="text-gray-600">District Rating</div>
                        <div className="font-semibold">{data.school_district.rating}/10</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {data.schools.slice(0, 6).map((school, idx) => (
                  <div key={idx} className="bg-white rounded-lg p-4 border hover:shadow-md transition-shadow">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1">
                        <div className="font-semibold text-gray-900">{school.name}</div>
                        <div className="text-sm text-gray-600">{school.level} • {school.grades}</div>
                      </div>
                      {school.rating && (
                        <div className="ml-2">
                          <div className={`px-3 py-1 rounded-full font-bold text-sm ${
                            school.rating >= 8 ? 'bg-green-100 text-green-800' :
                            school.rating >= 6 ? 'bg-blue-100 text-blue-800' :
                            school.rating >= 4 ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {school.rating}/10
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-4 text-xs text-gray-500">
                      {school.type && <span>{school.type}</span>}
                      {school.distance && <span>{school.distance.toFixed(1)} miles</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {showSection('building-permits') && data.building_permits && data.building_permits.length > 0 ? (
            <section className="bg-white rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Building Permits ({data.building_permits.length})
              </h3>

              <div className="space-y-3 max-h-96 overflow-y-auto">
                {data.building_permits.slice(0, 15).map((permit, idx) => (
                  <div key={idx} className="bg-gray-50 rounded-lg p-4 border hover:bg-gray-100 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex-1">
                        <div className="font-semibold text-gray-900">
                          {permit.permit_type_description || permit.work_description || permit.permit_type || 'Permit'}
                        </div>
                        <div className="text-sm text-gray-600 mt-1">
                          {permit.issue_date && <span>Issued: {permit.issue_date}</span>}
                          {permit.permit_number && <span className="ml-3">#{permit.permit_number}</span>}
                        </div>
                      </div>
                      {permit.estimated_cost && (
                        <div className="ml-2 text-right">
                          <div className="text-sm font-semibold text-green-700">
                            ${permit.estimated_cost.toLocaleString()}
                          </div>
                          <div className="text-xs text-gray-500">Est. Cost</div>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3 text-xs text-gray-500 flex-wrap">
                      {permit.contractor_name && <span>👷 {permit.contractor_name}</span>}
                      {permit.status && (
                        <span className={`px-2 py-0.5 rounded ${
                          permit.status.toLowerCase().includes('complete') ? 'bg-green-100 text-green-700' :
                          permit.status.toLowerCase().includes('issued') ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-200 text-gray-700'
                        }`}>
                          {permit.status}
                        </span>
                      )}
                      <span className="text-indigo-600 font-medium">📍 {permit.source}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {showSection('sale-history') && (data.summary.last_sale_date || data.summary.last_sale_price) ? (
            <section className="bg-gradient-to-br from-pink-50 to-rose-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
                </svg>
                Last Sale
              </h3>

              <div className="grid grid-cols-2 gap-4">
                {data.summary.last_sale_date && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Sale Date</div>
                    <div className="text-lg font-semibold text-gray-900">{data.summary.last_sale_date}</div>
                  </div>
                )}
                {data.summary.last_sale_price && (
                  <div className="bg-white rounded-lg p-4">
                    <div className="text-sm text-gray-600 mb-1">Sale Price</div>
                    <div className="text-lg font-semibold text-pink-600">
                      ${data.summary.last_sale_price.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {showSection('location') && data.summary.area_context && Object.keys(data.summary.area_context).length > 0 ? (
            <section className="bg-gray-50 rounded-xl p-6 border">
              <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Location Details
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                {data.summary.area_context.county && (
                  <div>
                    <div className="text-gray-600">County</div>
                    <div className="font-semibold">{data.summary.area_context.county}</div>
                  </div>
                )}
                {data.summary.area_context.municipality && (
                  <div>
                    <div className="text-gray-600">Municipality</div>
                    <div className="font-semibold">{data.summary.area_context.municipality}</div>
                  </div>
                )}
                {data.summary.area_context.zoning && (
                  <div>
                    <div className="text-gray-600">Zoning</div>
                    <div className="font-semibold">{data.summary.area_context.zoning}</div>
                  </div>
                )}
                {data.summary.area_context.census_tract && (
                  <div>
                    <div className="text-gray-600">Census Tract</div>
                    <div className="font-semibold text-xs">{data.summary.area_context.census_tract}</div>
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className="h-full overflow-y-auto">{content}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gradient-to-r from-emerald-50 to-blue-50">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Property Details</h2>
            {address && (
              <p className="text-sm text-gray-600 mt-1">{address}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/50 rounded-lg transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {content}
        </div>

        {/* Footer */}
        {!hideFooter ? (
          <div className="px-6 py-4 border-t bg-gray-50 flex justify-between items-center gap-3">
          <div className="flex flex-col gap-2">
            {!loading && !error && data && (
              <button
                onClick={handleToggleSave}
                disabled={saveBusy}
                className={`px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2 ${
                  isSaved 
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
                    : 'border border-gray-300 hover:bg-gray-100'
                } ${saveBusy ? 'cursor-not-allowed opacity-70' : ''}`}
              >
                {saveBusy ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Saving...
                  </>
                ) : isSaved ? (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"/>
                    </svg>
                    Saved
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
                    </svg>
                    Save Property
                  </>
                )}
              </button>
            )}
            {saveError && <div className="text-xs text-rose-600">{saveError}</div>}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-100 transition-colors"
            >
              Close
            </button>
          </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
