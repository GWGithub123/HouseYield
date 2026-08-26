import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { InsurancePropertySummary } from '../../types/iot';
import { getSelectedInsuranceProperty, insurancePacketClient, setSelectedInsuranceProperty } from '../../services/insurancePacketClient';

const InsuranceDiscountExplainer: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [properties, setProperties] = useState<InsurancePropertySummary[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setLoading(false);
      return;
    }

    const loadProperties = async () => {
      try {
        const nextProperties = await insurancePacketClient.listProperties(user.id);
        setProperties(nextProperties);

        const storedSelection = getSelectedInsuranceProperty();
        const defaultPropertyId =
          storedSelection?.propertyId && nextProperties.some((property) => property.propertyId === storedSelection.propertyId)
            ? storedSelection.propertyId
            : nextProperties[0]?.propertyId || '';
        setSelectedPropertyId(defaultPropertyId);
      } catch (loadError) {
        console.error('Failed to load insurance properties:', loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load properties');
      } finally {
        setLoading(false);
      }
    };

    void loadProperties();
  }, [user?.id]);

  const selectedProperty = properties.find((property) => property.propertyId === selectedPropertyId) || null;

  const handleContinue = () => {
    if (!selectedProperty) {
      return;
    }
    setSelectedInsuranceProperty({
      propertyId: selectedProperty.propertyId,
      address: selectedProperty.address,
    });
    navigate('/insurance-discount/checklist', {
      state: {
        propertyId: selectedProperty.propertyId,
        propertyAddress: selectedProperty.address,
      },
    });
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {/* Header */}
        <div className="bg-slate-950 px-8 py-10 text-white">
          <div className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-cyan-300">HouseYield Risk Engineering</div>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight">
            Build a water-loss mitigation evidence packet
          </h1>
          <p className="mt-4 max-w-3xl text-lg text-slate-300">
            Assemble property-specific installation, functional-test, monitoring, equipment, and installer-attestation evidence for carrier review.
          </p>
        </div>
        <div className="p-8">

        {loading && (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading your monitored properties...</p>
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && !user?.id && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-8 text-sm text-yellow-800">
            Sign in as an owner to generate HouseYield insurance packets.
          </div>
        )}

        {!loading && !error && user?.id && properties.length === 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-8 text-sm text-yellow-800">
            No saved properties were found for this account yet. Add a property and assign Shelly devices before generating an insurer packet.
          </div>
        )}

        {!loading && !error && properties.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 mb-8">
            <h3 className="text-lg font-semibold text-gray-800 mb-1">Choose a property</h3>
            <p className="mb-4 text-sm text-slate-600">Readiness is based on evidence completeness, not a promised insurance discount.</p>
            <div className="space-y-3">
              {properties.map((property) => {
                const isSelected = property.propertyId === selectedPropertyId;
                return (
                  <button
                    key={property.propertyId}
                    type="button"
                    onClick={() => setSelectedPropertyId(property.propertyId)}
                    className={`w-full rounded-lg border-2 p-4 text-left transition ${
                      isSelected ? 'border-blue-500 bg-white shadow-sm' : 'border-transparent bg-white/70 hover:border-blue-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-semibold text-gray-900">{property.address}</div>
                        <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-gray-600 md:grid-cols-4">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500">Sensors</div>
                            <div className="font-semibold text-gray-900">{property.totalSensors}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500">Leak Sensors</div>
                            <div className="font-semibold text-gray-900">{property.leakSensorCount}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500">Online</div>
                            <div className="font-semibold text-gray-900">{property.onlineSensors}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-gray-500">Packet Readiness</div>
                            <div className={`font-semibold ${property.commissioningCompleted ? 'text-green-700' : 'text-amber-700'}`}>
                              {property.commissioningCompleted ? 'Ready' : `${property.commissioningPercent}%`}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className={`rounded-full px-3 py-1 text-xs font-semibold ${property.activeAlerts > 0 ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                        {property.activeAlerts > 0 ? `${property.activeAlerts} open alert${property.activeAlerts === 1 ? '' : 's'}` : 'No open alerts'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedProperty && (
          <div className="bg-slate-50 rounded-lg p-6 mb-8 border border-slate-200">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">Selected Property Snapshot</h3>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <div className="text-gray-500">Draft Reference</div>
                <div className="font-semibold text-gray-900">{selectedProperty.verificationCode}</div>
              </div>
              <div>
                <div className="text-gray-500">Leak Sensors</div>
                <div className="font-semibold text-gray-900">{selectedProperty.leakSensorCount}</div>
              </div>
              <div>
                <div className="text-gray-500">Online Devices</div>
                <div className="font-semibold text-gray-900">{selectedProperty.onlineSensors}</div>
              </div>
              <div>
                <div className="text-gray-500">Commissioning Record</div>
                <div className={`font-semibold ${selectedProperty.commissioningCompleted ? 'text-green-700' : 'text-amber-700'}`}>
                  {selectedProperty.commissioningCompleted ? 'Complete' : 'Needs review'}
                </div>
              </div>
            </div>
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <span className="font-semibold">Next:</span> Open the packet checklist to automatically collect verified device evidence, then complete the field evidence and signed test steps required for submission.
            </div>
          </div>
        )}

        {/* Benefits Section */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-800 mb-4">
            The packet will be assembled from live HouseYield data.
          </h2>
          
          <div className="space-y-4">
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                <span className="text-green-600 font-bold">✓</span>
              </div>
              <div>
                <h3 className="font-semibold text-gray-800">Program packet for carriers and brokers</h3>
                <p className="text-gray-600">HouseYield overview, fail-safes, commissioning standard, and monitoring SOP</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                <span className="text-green-600 font-bold">✓</span>
              </div>
              <div>
                <h3 className="font-semibold text-gray-800">Property-specific certificate packet</h3>
                <p className="text-gray-600">Live device counts, valve commissioning evidence, and current monitoring status</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                <span className="text-green-600 font-bold">✓</span>
              </div>
              <div>
                <h3 className="font-semibold text-gray-800">Carrier-ready email draft</h3>
                <p className="text-gray-600">A cautious prewritten request that references the selected property and avoids promising eligibility</p>
              </div>
            </div>
          </div>
        </div>

        {/* How It Works */}
        <div className="bg-blue-50 rounded-lg p-6 mb-8">
          <h3 className="text-xl font-semibold text-gray-800 mb-4">How It Works</h3>
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold">
                1
              </div>
              <p className="text-gray-700">Choose the property and open the checklist. HouseYield first collects verified system evidence automatically.</p>
            </div>
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold">
                2
              </div>
              <p className="text-gray-700">Review the commissioning record and fill any missing valve-install evidence</p>
            </div>
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold">
                3
              </div>
              <p className="text-gray-700">Upload evidence, request the installer e-signature, and resolve readiness gaps</p>
            </div>
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center font-bold">
                4
              </div>
              <p className="text-gray-700">Download one sealed evidence PDF, then send it to the agent or underwriting team</p>
            </div>
          </div>
        </div>

        {/* CTA Buttons */}
        <div className="flex justify-center space-x-4">
          <button
            onClick={() => navigate('/sensors')}
            className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition"
          >
            Back to Dashboard
          </button>
          <button
            onClick={handleContinue}
            disabled={!selectedProperty}
            className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-semibold shadow-lg"
          >
            Open Packet Checklist →
          </button>
        </div>
        </div>
      </div>
    </div>
  );
};

export default InsuranceDiscountExplainer;
