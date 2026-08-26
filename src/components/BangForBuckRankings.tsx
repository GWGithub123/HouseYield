/**
 * BangForBuckRankings.tsx
 * 
 * Shows renovations ranked by "bang for buck" score.
 * Displays cost, value add, and ROI for each renovation type.
 */

import React, { useState, useEffect } from 'react';

interface BangForBuckRankingsProps {
  zipCode: string;
}

interface RenovationRanking {
  type: string;
  avgCost: number;
  avgValueAdd: number;
  roi: number;
  sampleSize: number;
  trend: string;
  bangForBuckScore: number;
}

const BangForBuckRankings: React.FC<BangForBuckRankingsProps> = ({ zipCode }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rankings, setRankings] = useState<RenovationRanking[]>([]);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [sortBy, setSortBy] = useState<'bangForBuckScore' | 'roi' | 'avgCost'>('bangForBuckScore');

  useEffect(() => {
    const fetchData = async () => {
      if (!zipCode) return;
      setLoading(true);
      setError(null);
      
      try {
        const res = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
        const data = await res.json();
        
        if (data.ok && data.summary?.renovationsByType) {
          // Transform and calculate bang for buck score
          const transformed: RenovationRanking[] = Object.entries(data.summary.renovationsByType)
            .map(([type, info]: [string, any]) => ({
              type,
              avgCost: info.averageCost || 0,
              avgValueAdd: info.averageValueAdd || 0,
              roi: info.averageROI || 0,
              sampleSize: info.sampleSize || 0,
              trend: info.trend || 'stable',
              bangForBuckScore: info.averageCost > 0 
                ? (info.averageValueAdd / info.averageCost) * (info.sampleSize >= 5 ? 1 : 0.7)
                : 0,
            }))
            .filter(r => r.sampleSize >= 3);
          
          setRankings(transformed);
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

  const sortedRankings = [...rankings].sort((a, b) => {
    switch (sortBy) {
      case 'bangForBuckScore': return b.bangForBuckScore - a.bangForBuckScore;
      case 'roi': return b.roi - a.roi;
      case 'avgCost': return a.avgCost - b.avgCost;
      default: return 0;
    }
  });

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'rising': return '📈';
      case 'falling': return '📉';
      default: return '➡️';
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 2) return 'text-green-600 bg-green-50 border-green-200';
    if (score >= 1.5) return 'text-yellow-600 bg-yellow-50 border-yellow-200';
    if (score >= 1) return 'text-orange-600 bg-orange-50 border-orange-200';
    return 'text-red-600 bg-red-50 border-red-200';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="w-8 h-8 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="ml-2 text-gray-600">Loading rankings...</span>
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

  if (rankings.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No ranking data available for ZIP {zipCode}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-bold">🏆 Bang for Buck Rankings: {zipCode}</h3>
        
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="px-2 py-1 text-sm border rounded-md"
          >
            <option value="bangForBuckScore">Best Value</option>
            <option value="roi">Highest ROI</option>
            <option value="avgCost">Lowest Cost</option>
          </select>
          
          <div className="flex border rounded-md overflow-hidden">
            <button
              onClick={() => setViewMode('cards')}
              className={`px-3 py-1 text-sm ${viewMode === 'cards' ? 'bg-amber-500 text-white' : 'bg-white text-gray-600'}`}
            >
              Cards
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-1 text-sm ${viewMode === 'table' ? 'bg-amber-500 text-white' : 'bg-white text-gray-600'}`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Recommendation Box */}
      {sortedRankings[0] && (
        <div className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700 font-medium">
            💡 <strong>Top Pick:</strong> {sortedRankings[0].type.replace(/_/g, ' ')} renovations 
            show the best bang for buck in this area with {(sortedRankings[0].roi * 100).toFixed(0)}% ROI
            and ${sortedRankings[0].avgValueAdd.toLocaleString()} average value add.
          </p>
        </div>
      )}

      {/* Cards View */}
      {viewMode === 'cards' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedRankings.map((item, idx) => (
            <div key={item.type} className={`p-4 border rounded-lg ${idx === 0 ? 'ring-2 ring-green-500' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-xs text-gray-500">#{idx + 1}</p>
                  <p className="font-medium capitalize">{item.type.replace(/_/g, ' ')}</p>
                </div>
                <span className={`px-2 py-1 rounded text-sm font-bold border ${getScoreColor(item.bangForBuckScore)}`}>
                  {item.bangForBuckScore.toFixed(1)}x
                </span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Avg Cost</p>
                  <p className="font-medium">${item.avgCost.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Value Add</p>
                  <p className="font-medium text-green-600">+${item.avgValueAdd.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">ROI</p>
                  <p className="font-medium text-green-600">{(item.roi * 100).toFixed(0)}%</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Trend</p>
                  <p className="font-medium">{getTrendIcon(item.trend)} {item.trend}</p>
                </div>
              </div>
              
              <p className="text-xs text-gray-400 mt-2">{item.sampleSize} comparables</p>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 border-b">
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">Renovation Type</th>
                <th className="text-right px-3 py-2">Score</th>
                <th className="text-right px-3 py-2">Avg Cost</th>
                <th className="text-right px-3 py-2">Value Add</th>
                <th className="text-right px-3 py-2">ROI</th>
                <th className="text-center px-3 py-2">Trend</th>
                <th className="text-center px-3 py-2">Samples</th>
              </tr>
            </thead>
            <tbody>
              {sortedRankings.map((item, idx) => (
                <tr key={item.type} className={`border-b hover:bg-gray-50 ${idx === 0 ? 'bg-green-50' : ''}`}>
                  <td className="px-3 py-2 font-bold text-amber-500">{idx + 1}</td>
                  <td className="px-3 py-2 font-medium capitalize">{item.type.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${getScoreColor(item.bangForBuckScore)}`}>
                      {item.bangForBuckScore.toFixed(1)}x
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">${item.avgCost.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-green-600">+${item.avgValueAdd.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-green-600 font-medium">{(item.roi * 100).toFixed(0)}%</td>
                  <td className="px-3 py-2 text-center">{getTrendIcon(item.trend)}</td>
                  <td className="px-3 py-2 text-center text-gray-500">{item.sampleSize}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default BangForBuckRankings;
