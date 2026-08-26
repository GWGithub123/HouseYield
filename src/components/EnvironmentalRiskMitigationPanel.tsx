/**
 * EnvironmentalRiskMitigationPanel
 * AI-powered environmental risk analysis using heat map data, risk levels,
 * and seasonal fluctuations to create an improvement plan.
 * No image generation — purely data-driven analysis.
 */
import React, { useState, useCallback } from 'react';

interface SeasonalData {
  monthly: number[];       // 12 monthly values from the fluctuation graph
  peakMonth: number;       // index 0-11
  peakValue: number;
  currentMonth: number;
  currentValue: number;
}

interface EnvironmentalRiskMitigationPanelProps {
  address: string;
  latitude: number;
  longitude: number;
  zipCode: string;
  propertyDetails: {
    bedrooms: number;
    sqft: number;
    stories: number;
    yearBuilt?: number;
  };
  environmentalData?: any;
  /** Seasonal fluctuation data from each RiskFluctuationGraph */
  seasonalData?: {
    airQuality?: SeasonalData;
    flood?: SeasonalData;
    wildfire?: SeasonalData;
  };
}

interface Mitigation {
  category: string;
  riskAddressed: string;
  title: string;
  description: string;
  estimatedCost: { low: number; high: number };
  riskReductionPct: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  timeToComplete: string;
  insuranceImpact: string;
  seasonalNote?: string;
}

interface AnalysisResult {
  propertyAssessment: string;
  overallRiskLevel: string;
  mitigations: Mitigation[];
  estimatedInsuranceSavings: { annualLow: number; annualHigh: number };
  totalInvestmentRange: { low: number; high: number };
  seasonalInsights?: string;
}

const PRIORITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  high: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  medium: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
  low: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
};

const RISK_ICONS: Record<string, string> = {
  flood: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z',
  wildfire: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
  airQuality: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z',
  storm: 'M13 10V3L4 14h7v7l9-11h-7z',
  heat: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707',
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EnvironmentalRiskMitigationPanel: React.FC<EnvironmentalRiskMitigationPanelProps> = ({
  address,
  latitude,
  longitude,
  zipCode,
  propertyDetails,
  environmentalData,
  seasonalData,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    try {
      // Build risk data from environmentalData
      const risks: any = {};
      if (environmentalData?.air) {
        risks.airQuality = {
          aqi: environmentalData.air.aqi || environmentalData.air.airQualityIndex,
          season: new Date().getMonth() >= 2 && new Date().getMonth() <= 4 ? 'spring'
            : new Date().getMonth() >= 5 && new Date().getMonth() <= 7 ? 'summer'
            : new Date().getMonth() >= 8 && new Date().getMonth() <= 10 ? 'fall' : 'winter',
          ozoneRisk: environmentalData.air.ozoneRisk || 'Unknown'
        };
      }
      if (environmentalData?.flood) {
        risks.flood = {
          riskLevel: environmentalData.flood.riskLevel || environmentalData.flood.floodZone || 'Unknown',
          femaZone: environmentalData.flood.femaZone || environmentalData.flood.floodZone || 'Unknown',
          elevation: environmentalData.flood.elevation
        };
      }
      if (environmentalData?.fire) {
        risks.wildfire = {
          riskScore: environmentalData.fire.riskScore || environmentalData.fire.fireRisk || 5,
          vegetationDryness: environmentalData.fire.vegetationDryness || 50
        };
      }

      // Defaults if no specific data
      if (Object.keys(risks).length === 0) {
        risks.flood = { riskLevel: 'Moderate', femaZone: 'X', elevation: 0 };
        risks.wildfire = { riskScore: 3, vegetationDryness: 40 };
        risks.airQuality = { aqi: 55, season: 'summer', ozoneRisk: 'Moderate' };
      }

      // Build seasonal fluctuation summary for the AI
      const seasonalFluctuations: any = {};
      if (seasonalData?.airQuality) {
        const s = seasonalData.airQuality;
        seasonalFluctuations.airQuality = {
          monthlyValues: s.monthly,
          peakMonth: MONTH_LABELS[s.peakMonth],
          peakValue: s.peakValue,
          currentValue: s.currentValue,
          currentMonth: MONTH_LABELS[s.currentMonth],
          yearRoundAvg: Math.round(s.monthly.reduce((a, b) => a + b, 0) / 12),
          monthsAboveModerate: s.monthly.filter(v => v > 100).length,
        };
      }
      if (seasonalData?.flood) {
        const s = seasonalData.flood;
        seasonalFluctuations.flood = {
          monthlyValues: s.monthly,
          peakMonth: MONTH_LABELS[s.peakMonth],
          peakValue: s.peakValue,
          currentValue: s.currentValue,
          currentMonth: MONTH_LABELS[s.currentMonth],
          yearRoundAvg: Math.round((s.monthly.reduce((a, b) => a + b, 0) / 12) * 10) / 10,
          monthsAboveModerate: s.monthly.filter(v => v > 5).length,
        };
      }
      if (seasonalData?.wildfire) {
        const s = seasonalData.wildfire;
        seasonalFluctuations.wildfire = {
          monthlyValues: s.monthly,
          peakMonth: MONTH_LABELS[s.peakMonth],
          peakValue: s.peakValue,
          currentValue: s.currentValue,
          currentMonth: MONTH_LABELS[s.currentMonth],
          yearRoundAvg: Math.round((s.monthly.reduce((a, b) => a + b, 0) / 12) * 10) / 10,
          monthsAboveModerate: s.monthly.filter(v => v > 5).length,
        };
      }

      const response = await fetch(`${baseUrl}/api/environmental-risk/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          latitude,
          longitude,
          zipCode,
          risks,
          propertyDetails,
          seasonalFluctuations,
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.analysis) {
          setAnalysis(data.analysis);
        }
      }
    } catch (err) {
      console.error('[EnvRiskMitigation] Analysis failed:', err);
    } finally {
      setAnalyzing(false);
    }
  }, [address, latitude, longitude, zipCode, propertyDetails, environmentalData, seasonalData, baseUrl]);

  const formatCost = (cost: { low: number; high: number }) =>
    `$${cost.low.toLocaleString()} - $${cost.high.toLocaleString()}`;

  return (
    <div className="mt-6 rounded-xl border bg-white overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-lg">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div className="text-left">
            <h5 className="font-semibold text-gray-900">AI Environmental Risk Mitigation</h5>
            <p className="text-xs text-gray-500">Analyzes heat maps, risk data & seasonal patterns to build an improvement plan</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {analysis && (
            <span className={`text-xs font-medium px-2 py-1 rounded ${
              analysis.overallRiskLevel === 'severe' ? 'bg-red-100 text-red-700' :
              analysis.overallRiskLevel === 'high' ? 'bg-orange-100 text-orange-700' :
              analysis.overallRiskLevel === 'moderate' ? 'bg-yellow-100 text-yellow-700' :
              'bg-green-100 text-green-700'
            }`}>
              {analysis.mitigations.length} improvements
            </span>
          )}
          <svg className={`w-5 h-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t">
          {/* Analyze Controls */}
          {!analysis && (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-600 mb-4">
                The AI will analyze all environmental risk data — heat maps, FEMA zones, AQI levels, wildfire
                scores, and seasonal fluctuation patterns — to create a prioritized improvement plan.
              </p>

              {/* Show what data is available */}
              <div className="flex flex-wrap justify-center gap-2 mb-4">
                {(environmentalData?.air || seasonalData?.airQuality) && (
                  <span className="text-[11px] px-2 py-1 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
                    Air Quality Data
                  </span>
                )}
                {(environmentalData?.flood || seasonalData?.flood) && (
                  <span className="text-[11px] px-2 py-1 bg-cyan-50 text-cyan-700 rounded-full border border-cyan-200">
                    Flood Risk Data
                  </span>
                )}
                {(environmentalData?.fire || seasonalData?.wildfire) && (
                  <span className="text-[11px] px-2 py-1 bg-orange-50 text-orange-700 rounded-full border border-orange-200">
                    Wildfire Risk Data
                  </span>
                )}
                {seasonalData && Object.keys(seasonalData).length > 0 && (
                  <span className="text-[11px] px-2 py-1 bg-purple-50 text-purple-700 rounded-full border border-purple-200">
                    Seasonal Patterns
                  </span>
                )}
              </div>

              <button
                onClick={runAnalysis}
                disabled={analyzing}
                className="flex items-center gap-2 mx-auto px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 text-white rounded-lg hover:from-emerald-600 hover:to-teal-700 disabled:opacity-50 font-medium transition-colors"
              >
                {analyzing ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Analyzing risk data & seasonal patterns...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Run AI Risk Analysis
                  </>
                )}
              </button>
            </div>
          )}

          {/* Analysis Results */}
          {analysis && (
            <div className="pt-4 space-y-4">
              {/* Property Assessment */}
              <div className={`p-4 rounded-lg border ${
                analysis.overallRiskLevel === 'severe' ? 'bg-red-50 border-red-200' :
                analysis.overallRiskLevel === 'high' ? 'bg-orange-50 border-orange-200' :
                analysis.overallRiskLevel === 'moderate' ? 'bg-yellow-50 border-yellow-200' :
                'bg-green-50 border-green-200'
              }`}>
                <div className="flex items-start gap-3">
                  <span className="text-2xl">
                    {analysis.overallRiskLevel === 'severe' ? '🔴' :
                     analysis.overallRiskLevel === 'high' ? '🟠' :
                     analysis.overallRiskLevel === 'moderate' ? '🟡' : '🟢'}
                  </span>
                  <div>
                    <h6 className="font-semibold text-gray-900 mb-1">Property Assessment</h6>
                    <p className="text-sm text-gray-700">{analysis.propertyAssessment}</p>
                  </div>
                </div>
              </div>

              {/* Seasonal Insights */}
              {analysis.seasonalInsights && (
                <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200">
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <h6 className="text-xs font-semibold text-indigo-800 mb-0.5">Seasonal Risk Insights</h6>
                      <p className="text-xs text-indigo-700">{analysis.seasonalInsights}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Summary Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-center">
                  <div className="text-lg font-bold text-blue-700">{analysis.mitigations.length}</div>
                  <div className="text-xs text-blue-600">Recommended Improvements</div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
                  <div className="text-lg font-bold text-emerald-700">
                    ${analysis.estimatedInsuranceSavings.annualLow.toLocaleString()}-${analysis.estimatedInsuranceSavings.annualHigh.toLocaleString()}
                  </div>
                  <div className="text-xs text-emerald-600">Est. Annual Insurance Savings</div>
                </div>
                <div className="p-3 rounded-lg bg-purple-50 border border-purple-200 text-center">
                  <div className="text-lg font-bold text-purple-700">{formatCost(analysis.totalInvestmentRange)}</div>
                  <div className="text-xs text-purple-600">Total Investment Range</div>
                </div>
              </div>

              {/* Mitigation Cards */}
              <div className="space-y-3">
                <h6 className="text-sm font-semibold text-gray-700">Improvement Plan</h6>
                {analysis.mitigations.map((mitigation, idx) => {
                  const colors = PRIORITY_COLORS[mitigation.priority] || PRIORITY_COLORS.medium;

                  return (
                    <div key={idx} className={`p-4 rounded-lg border ${colors.border} ${colors.bg}`}>
                      <div className="flex items-start gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <svg className={`w-4 h-4 ${colors.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={RISK_ICONS[mitigation.riskAddressed] || RISK_ICONS.storm} />
                            </svg>
                            <span className="font-semibold text-gray-900 text-sm">{mitigation.title}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${colors.text} ${colors.bg} border ${colors.border}`}>
                              {mitigation.priority}
                            </span>
                          </div>
                          <p className="text-xs text-gray-600 mb-2">{mitigation.description}</p>

                          {/* Seasonal note if present */}
                          {mitigation.seasonalNote && (
                            <p className="text-[11px] text-indigo-600 mb-2 italic">
                              Seasonal: {mitigation.seasonalNote}
                            </p>
                          )}

                          <div className="flex flex-wrap gap-3 text-[11px]">
                            <span className="text-gray-700">
                              <strong>Cost:</strong> {formatCost(mitigation.estimatedCost)}
                            </span>
                            <span className="text-emerald-700">
                              <strong>Risk Reduction:</strong> {mitigation.riskReductionPct}%
                            </span>
                            <span className="text-gray-600">
                              <strong>Timeline:</strong> {mitigation.timeToComplete}
                            </span>
                            <span className="text-blue-700">
                              <strong>Insurance:</strong> {mitigation.insuranceImpact}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Re-analyze button */}
              <div className="flex justify-end">
                <button
                  onClick={() => setAnalysis(null)}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Reset & Re-analyze
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EnvironmentalRiskMitigationPanel;
