import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getSelectedInsuranceProperty } from '../../services/insurancePacketClient';
import { Insurer } from '../../types/iot';
import { authenticatedFetch } from '../../utils/authenticatedFetch';

const InsurerSelection: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [insurers, setInsurers] = useState<Insurer[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedInsurer, setSelectedInsurer] = useState<Insurer | null>(null);
  const [customInsurerName, setCustomInsurerName] = useState('');
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const propertyState = (location.state as { propertyId?: string; propertyAddress?: string } | null) || null;
  const storedProperty = getSelectedInsuranceProperty();
  const propertyId = propertyState?.propertyId || storedProperty?.propertyId || '';
  const propertyAddress = propertyState?.propertyAddress || storedProperty?.address || '';

  useEffect(() => {
    if (!propertyId) {
      navigate('/insurance-discount');
      return;
    }
    loadInsurers();
  }, [propertyId]);

  const loadInsurers = async () => {
    try {
      const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
      const response = await authenticatedFetch(`${baseUrl}/api/insurance/insurers`);
      if (response.ok) {
        const data = await response.json();
        setInsurers(data);
      }
    } catch (error) {
      console.error('Failed to load insurers:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredInsurers = useMemo(
    () => insurers.filter((insurer) => insurer.name.toLowerCase().includes(searchTerm.toLowerCase())),
    [insurers, searchTerm],
  );

  const handleSelectInsurer = (insurer: Insurer) => {
    setSelectedInsurer(insurer);
    setShowCustomForm(false);
  };

  const handleContinue = () => {
    if (selectedInsurer) {
      navigate('/insurance-discount/generate-request', {
        state: {
          insurer: selectedInsurer,
          propertyId,
          propertyAddress,
        },
      });
    } else if (customInsurerName.trim()) {
      const customInsurer: Insurer = {
        id: 'custom',
        name: customInsurerName,
        requiresProof: true,
        acceptedProofTypes: ['property-certificate', 'program-overview', 'commissioning-evidence']
      };
      navigate('/insurance-discount/generate-request', {
        state: {
          insurer: customInsurer,
          propertyId,
          propertyAddress,
        },
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">
            Who's your insurance provider?
          </h1>
          <p className="text-gray-600">
            Select from our list or enter your provider manually for <span className="font-semibold text-gray-800">{propertyAddress}</span>
          </p>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Search for your insurance provider..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Insurers List */}
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading insurance providers...</p>
          </div>
        ) : (
          <div className="space-y-3 mb-6 max-h-96 overflow-y-auto">
            {filteredInsurers.map((insurer) => (
              <button
                key={insurer.id}
                onClick={() => handleSelectInsurer(insurer)}
                className={`w-full p-4 rounded-lg border-2 text-left transition ${
                  selectedInsurer?.id === insurer.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-800">{insurer.name}</h3>
                    {insurer.discountProgramName && (
                      <p className="text-sm text-gray-600 mt-1">
                        Program: {insurer.discountProgramName}
                      </p>
                    )}
                    {insurer.discountPercentage && (
                      <p className="text-sm text-slate-600 font-medium mt-1">
                        Eligibility: {insurer.discountPercentage}
                      </p>
                    )}
                    {insurer.programNotes && (
                      <p className="mt-2 text-xs leading-5 text-slate-500">{insurer.programNotes}</p>
                    )}
                  </div>
                  {selectedInsurer?.id === insurer.id && (
                    <div className="flex-shrink-0 ml-4">
                      <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                        <span className="text-white text-sm">✓</span>
                      </div>
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Custom Insurer Option */}
        <div className="border-t border-gray-200 pt-6 mb-6">
          <button
            onClick={() => {
              setShowCustomForm(!showCustomForm);
              setSelectedInsurer(null);
            }}
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            My insurer isn't listed →
          </button>

          {showCustomForm && (
            <div className="mt-4">
              <input
                type="text"
                placeholder="Enter your insurance provider name"
                value={customInsurerName}
                onChange={(e) => setCustomInsurerName(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-sm text-gray-500 mt-2">
                We'll generate a generic request that you can customize
              </p>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-between">
          <button
            onClick={() => navigate('/insurance-discount')}
            className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition"
          >
            ← Back
          </button>
          <button
            onClick={handleContinue}
            disabled={!selectedInsurer && !customInsurerName.trim()}
            className={`px-8 py-3 rounded-lg font-semibold transition ${
              selectedInsurer || customInsurerName.trim()
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            Generate My Request →
          </button>
        </div>
      </div>
    </div>
  );
};

export default InsurerSelection;
