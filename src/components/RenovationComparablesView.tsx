/**
 * RenovationComparablesView.tsx
 * 
 * Displays area renovation data with tabs for:
 * - Best ROI renovations
 * - All renovation types
 * - Recent comparables
 * - Market timing info
 */

import React, { useState, useEffect } from 'react';

interface RenovationComparablesViewProps {
  zipCode: string;
}

interface AreaSummary {
  areaId: string;
  renovationsByType: Record<string, {
    averageROI: number;
    medianROI: number;
    sampleSize: number;
    averageCost: number;
    averageValueAdd: number;
    trend: string;
    confidence: string;
  }>;
  topPerformers: Array<{
    type: string;
    roi: number;
    sampleSize: number;
  }>;
  marketConditions: {
    saturation: string;
    timing: string;
    recommendation: string;
  };
  lastUpdated: string;
}

const RenovationComparablesView: React.FC<RenovationComparablesViewProps> = ({ zipCode }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AreaSummary | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  const tabs = ['🏆 Best ROI', '📊 All Types', '🏠 Recent', '⏰ Market'];

  useEffect(() => {
    const fetchData = async () => {
      if (!zipCode) return;
      setLoading(true);
      setError(null);
      
      try {
        const res = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
        const data = await res.json();
        if (data.ok && data.summary) {
          setSummary(data.summary);
        } else {
          setError(data.error || 'No data available');
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [zipCode]);

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case 'rising': return 'text-green-600';
      case 'falling': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'rising': return '📈';
      case 'falling': return '📉';
      default: return '➡️';
    }
  };

  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'high': return 'bg-green-100 text-green-700';
      case 'medium': return 'bg-yellow-100 text-yellow-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="w-8 h-8 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="ml-2 text-gray-600">Loading renovation data...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-red-700">Error: {error}</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="text-center py-8 text-gray-500">
        No renovation data available for ZIP {zipCode}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold">🏠 Renovation Comparables: {zipCode}</h3>
        <span className="text-xs text-gray-500">
          Updated: {new Date(summary.lastUpdated).toLocaleDateString()}
        </span>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1">
          {tabs.map((tab, idx) => (
            <button
              key={idx}
              onClick={() => setActiveTab(idx)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                activeTab === idx
                  ? 'border-amber-500 text-amber-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 0: Best ROI */}
      {activeTab === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Top performing renovations in this area:</p>
          {summary.topPerformers.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold text-amber-500">#{idx + 1}</span>
                <div>
                  <p className="font-medium capitalize">{item.type.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-gray-500">{item.sampleSize} comparables</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-green-600">{(item.roi * 100).toFixed(0)}%</p>
                <p className="text-xs text-gray-500">avg ROI</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tab 1: All Types */}
      {activeTab === 1 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 border-b">
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-right px-3 py-2">Avg ROI</th>
                <th className="text-right px-3 py-2">Med ROI</th>
                <th className="text-right px-3 py-2">Avg Cost</th>
                <th className="text-right px-3 py-2">Value Add</th>
                <th className="text-center px-3 py-2">Trend</th>
                <th className="text-center px-3 py-2">Confidence</th>
                <th className="text-center px-3 py-2">Samples</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.renovationsByType).map(([type, data]) => (
                <tr key={type} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium capitalize">{type.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-2 text-right text-green-600 font-medium">
                    {(data.averageROI * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(data.medianROI * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-2 text-right">
                    ${data.averageCost.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-green-600">
                    +${data.averageValueAdd.toLocaleString()}
                  </td>
                  <td className={`px-3 py-2 text-center ${getTrendColor(data.trend)}`}>
                    {getTrendIcon(data.trend)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${getConfidenceColor(data.confidence)}`}>
                      {data.confidence}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-gray-500">
                    {data.sampleSize}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 2: Recent Comparables */}
      {activeTab === 2 && (
        <div className="text-center py-8 text-gray-500">
          <p>Recent comparables view coming soon.</p>
          <p className="text-xs mt-2">This will show individual properties that were renovated and resold.</p>
        </div>
      )}

      {/* Tab 3: Market Conditions */}
      {activeTab === 3 && summary.marketConditions && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-gray-50 rounded-lg border">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Market Saturation</p>
            <p className="text-xl font-bold mt-1 capitalize">{summary.marketConditions.saturation}</p>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg border">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Timing</p>
            <p className="text-xl font-bold mt-1 capitalize">{summary.marketConditions.timing}</p>
          </div>
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 md:col-span-1">
            <p className="text-xs text-blue-600 uppercase tracking-wide">Recommendation</p>
            <p className="text-sm font-medium mt-1">{summary.marketConditions.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default RenovationComparablesView;
