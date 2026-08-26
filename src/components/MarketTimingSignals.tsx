/**
 * MarketTimingSignals.tsx
 * 
 * Displays market timing signals and actionable insights for renovation timing.
 * Shows saturation, seasonality, and trend indicators.
 */

import React, { useState, useEffect } from 'react';

interface MarketTimingSignalsProps {
  zipCode: string;
}

interface MarketSignal {
  type: string;
  saturation: 'low' | 'medium' | 'high' | 'oversaturated';
  trend: 'rising' | 'stable' | 'falling';
  seasonality: string;
  recommendation: string;
  confidence: string;
}

interface MarketTiming {
  overall: {
    saturation: string;
    timing: string;
    recommendation: string;
  };
  signals: MarketSignal[];
  insights: string[];
}

const MarketTimingSignals: React.FC<MarketTimingSignalsProps> = ({ zipCode }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timing, setTiming] = useState<MarketTiming | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!zipCode) return;
      setLoading(true);
      setError(null);
      
      try {
        const res = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
        const data = await res.json();
        
        if (data.ok && data.summary) {
          // Build timing data from summary
          const summary = data.summary;
          const signals: MarketSignal[] = [];
          
          // Generate signals from renovation types
          Object.entries(summary.renovationsByType || {}).forEach(([type, info]: [string, any]) => {
            signals.push({
              type,
              saturation: info.sampleSize > 20 ? 'high' : info.sampleSize > 10 ? 'medium' : 'low',
              trend: info.trend || 'stable',
              seasonality: 'Year-round',
              recommendation: info.trend === 'rising' 
                ? 'Good time to invest' 
                : info.trend === 'falling' 
                ? 'Consider waiting' 
                : 'Stable market',
              confidence: info.confidence || 'medium',
            });
          });

          setTiming({
            overall: summary.marketConditions || {
              saturation: 'medium',
              timing: 'neutral',
              recommendation: 'Market conditions are stable',
            },
            signals: signals.slice(0, 8), // Top 8
            insights: [
              `${Object.keys(summary.renovationsByType || {}).length} renovation types tracked in this area`,
              summary.topPerformers?.[0] 
                ? `${summary.topPerformers[0].type.replace(/_/g, ' ')} shows strongest performance`
                : 'Collecting more data for insights',
            ],
          });
        } else {
          setError(data.error || 'No timing data available');
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [zipCode]);

  const getSaturationColor = (saturation: string) => {
    switch (saturation) {
      case 'low': return 'bg-green-500';
      case 'medium': return 'bg-yellow-500';
      case 'high': return 'bg-orange-500';
      case 'oversaturated': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getSaturationWidth = (saturation: string) => {
    switch (saturation) {
      case 'low': return '25%';
      case 'medium': return '50%';
      case 'high': return '75%';
      case 'oversaturated': return '100%';
      default: return '50%';
    }
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'rising': return '📈';
      case 'falling': return '📉';
      default: return '➡️';
    }
  };

  const getTrendColor = (trend: string) => {
    switch (trend) {
      case 'rising': return 'text-green-600';
      case 'falling': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getTimingBadge = (timing: string) => {
    switch (timing) {
      case 'good': 
      case 'excellent':
        return <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">🟢 Good Time</span>;
      case 'poor':
      case 'wait':
        return <span className="px-2 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">🔴 Wait</span>;
      default:
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded-full text-xs font-medium">🟡 Neutral</span>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="w-8 h-8 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="ml-2 text-gray-600">Loading market signals...</span>
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

  if (!timing) {
    return (
      <div className="text-center py-8 text-gray-500">
        No market timing data available for ZIP {zipCode}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold">⏰ Market Timing Signals: {zipCode}</h3>
        {getTimingBadge(timing.overall.timing)}
      </div>

      {/* Overall Market Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Saturation Gauge */}
        <div className="p-4 bg-gray-50 rounded-lg border">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Market Saturation</p>
          <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
            <div 
              className={`h-full ${getSaturationColor(timing.overall.saturation)} transition-all`}
              style={{ width: getSaturationWidth(timing.overall.saturation) }}
            />
          </div>
          <p className="mt-2 font-medium capitalize">{timing.overall.saturation}</p>
        </div>

        {/* Timing */}
        <div className="p-4 bg-gray-50 rounded-lg border">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Overall Timing</p>
          <p className="text-2xl font-bold capitalize">{timing.overall.timing}</p>
        </div>

        {/* Recommendation */}
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="text-xs text-blue-600 uppercase tracking-wide mb-2">Recommendation</p>
          <p className="text-sm font-medium">{timing.overall.recommendation}</p>
        </div>
      </div>

      {/* Renovation Type Signals */}
      <div>
        <h4 className="font-medium mb-3">By Renovation Type</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {timing.signals.map((signal) => (
            <div key={signal.type} className="p-3 bg-white border rounded-lg flex items-center justify-between">
              <div>
                <p className="font-medium capitalize">{signal.type.replace(/_/g, ' ')}</p>
                <p className="text-xs text-gray-500">{signal.recommendation}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-lg ${getTrendColor(signal.trend)}`}>
                  {getTrendIcon(signal.trend)}
                </span>
                <div className="text-right">
                  <p className={`text-xs font-medium ${getTrendColor(signal.trend)}`}>{signal.trend}</p>
                  <p className="text-xs text-gray-400">{signal.saturation}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Insights */}
      {timing.insights.length > 0 && (
        <div className="p-4 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg">
          <p className="text-sm font-medium text-purple-700 mb-2">💡 Insights</p>
          <ul className="space-y-1">
            {timing.insights.map((insight, idx) => (
              <li key={idx} className="text-sm text-gray-700 flex items-start gap-2">
                <span className="text-purple-500">•</span>
                {insight}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-xs text-gray-400 text-center">
        Signals based on {timing.signals.length} renovation types tracked in this market.
        Data updates as new transactions are processed.
      </p>
    </div>
  );
};

export default MarketTimingSignals;
