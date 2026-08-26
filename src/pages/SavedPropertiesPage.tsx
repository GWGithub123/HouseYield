/**
 * Saved Properties Page
 * Displays all properties saved by the user from property search
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getSavedProperties, removeSavedProperty, type SavedProperty } from '../utils/savedProperties';
import { PropertyDetailsModal } from '../components/PropertyDetailsModal';
import { StreetViewImage } from '../components/StreetViewImage';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { resolveBookkeepingPropertyId } from '../utils/propertyScope';

const TopHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <header className="w-full border-b bg-white px-6 py-3.5 shrink-0">
    {children}
  </header>
);

export const SavedPropertiesPage = () => {
  const { user } = useAuth();
  const [savedProperties, setSavedProperties] = useState<SavedProperty[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<{ address: string; isOpen: boolean }>({
    address: '',
    isOpen: false
  });
  const selectedPropertyTaxId = useMemo(
    () => resolveBookkeepingPropertyId(user?.id, selectedProperty.address, savedProperties),
    [selectedProperty.address, savedProperties, user?.id],
  );

  useEffect(() => {
    let cancelled = false;

    const loadSaved = async () => {
      if (user?.id) {
        try {
          const properties = await ownerPropertiesClient.list(user.id);
          if (!cancelled) {
            setSavedProperties(properties);
          }
          return;
        } catch (err) {
          console.error('[SavedPropertiesPage] Failed to load canonical owner properties:', err);
          if (!cancelled) {
            setSavedProperties([]);
          }
          return;
        }
      }

      if (!cancelled) {
        setSavedProperties(getSavedProperties());
      }
    };

    loadSaved();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleRemove = async (id: string) => {
    if (confirm('Are you sure you want to remove this property from your saved list?')) {
      if (user?.id) {
        try {
          await ownerPropertiesClient.remove(user.id, id);
          setSavedProperties((current) => current.filter((property) => property.id !== id));
        } catch (err) {
          console.error('[SavedPropertiesPage] Failed to remove canonical owner property:', err);
        }
        return;
      }

      removeSavedProperty(id);
      setSavedProperties(getSavedProperties());
    }
  };

  const handleViewProperty = (address: string) => {
    setSelectedProperty({ address, isOpen: true });
  };

  const formatCurrency = (value?: number) => {
    if (!value) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  };

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div className="flex flex-col w-full h-screen" data-voice-id="saved-properties-page">
      <TopHeader>
        <div className="flex items-center justify-between w-full">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Saved Properties</h1>
            <p className="text-sm text-gray-600 mt-1">
              {savedProperties.length} {savedProperties.length === 1 ? 'property' : 'properties'} saved
            </p>
          </div>
        </div>
      </TopHeader>

      <main className="flex-1 p-6 overflow-auto bg-gray-50" data-voice-id="saved-properties-content">
        <div className="max-w-7xl mx-auto" data-voice-id="saved-properties-grid">
          {savedProperties.length === 0 ? (
            <div className="text-center py-16">
              <svg className="w-20 h-20 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
              </svg>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">No Saved Properties</h2>
              <p className="text-gray-600 mb-6">
                Search for properties and click "Save Property" to add them here
              </p>
              <a
                href="/search"
                className="inline-block px-6 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors font-medium"
                data-voice-id="search-properties-link"
              >
                Search Properties
              </a>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {savedProperties.map((property) => (
                <div
                  key={property.id}
                  className="bg-white rounded-xl border shadow-sm hover:shadow-lg transition-all overflow-hidden group"
                  data-voice-id={`saved-property-card-${property.id}`}
                >
                  {/* Street View Image */}
                  <div className="w-full h-48 overflow-hidden">
                    <StreetViewImage
                      address={property.address}
                      className="w-full h-full object-cover"
                      width={600}
                      height={300}
                    />
                  </div>

                  {/* Property Header */}
                  <div className="bg-gradient-to-r from-emerald-50 to-blue-50 p-4 border-b">
                    <div className="flex justify-between items-start gap-2">
                      <h3 className="font-semibold text-gray-900 line-clamp-2 flex-1">
                        {property.address}
                      </h3>
                      <button
                        onClick={() => handleRemove(property.id)}
                        className="p-1.5 hover:bg-red-100 rounded-lg transition-colors text-gray-400 hover:text-red-600"
                        title="Remove from saved"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"/>
                        </svg>
                      </button>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Saved {formatDate(property.savedAt)}
                    </div>
                  </div>

                  {/* Property Details */}
                  <div className="p-4">
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      {property.data.summary.beds !== undefined && (
                        <div className="text-center">
                          <div className="text-2xl font-bold text-gray-900">{property.data.summary.beds}</div>
                          <div className="text-xs text-gray-600">Beds</div>
                        </div>
                      )}
                      {property.data.summary.baths !== undefined && (
                        <div className="text-center">
                          <div className="text-2xl font-bold text-gray-900">{property.data.summary.baths}</div>
                          <div className="text-xs text-gray-600">Baths</div>
                        </div>
                      )}
                      {property.data.summary.living_sqft !== undefined && (
                        <div className="text-center">
                          <div className="text-2xl font-bold text-gray-900">
                            {(property.data.summary.living_sqft / 1000).toFixed(1)}k
                          </div>
                          <div className="text-xs text-gray-600">Sq Ft</div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      {property.data.summary.avm_value && (
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-600">Est. Value</span>
                          <span className="font-semibold text-emerald-700">
                            {formatCurrency(property.data.summary.avm_value)}
                          </span>
                        </div>
                      )}
                      {property.data.summary.rental_avm && (
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-600">Est. Rent</span>
                          <span className="font-semibold text-blue-700">
                            {formatCurrency(property.data.summary.rental_avm)}/mo
                          </span>
                        </div>
                      )}
                      {property.data.summary.year_built && (
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-gray-600">Year Built</span>
                          <span className="font-medium text-gray-900">
                            {property.data.summary.year_built}
                          </span>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => handleViewProperty(property.address)}
                      className="w-full mt-4 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors font-medium"
                      data-voice-id={`view-property-${property.id}`}
                    >
                      View Full Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Property Details Modal */}
      <PropertyDetailsModal
        isOpen={selectedProperty.isOpen}
        onClose={() => setSelectedProperty({ address: '', isOpen: false })}
        address={selectedProperty.address}
        taxPropertyId={selectedPropertyTaxId}
      />
    </div>
  );
};
