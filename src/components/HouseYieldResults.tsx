/**
 * HouseYield Analysis Results Component
 * Displays comprehensive AI-powered investment analysis from HouseYield-2 model
 */

import React from 'react';

interface HouseYieldResultsProps {
  analysisData: {
    analysis: string | any;
    analysisText?: string;
    roomScores: {
      kitchen: number;
      bath: number;
      flooring: number;
      curb_appeal: number;
      overall: number;
      notes?: string;
    };
    assumability?: {
      assumable: string;
      confidence: string;
      reason: string;
      loanType?: string;
      estimatedRate?: number;
      attractiveness?: string;
      assumptions?: string[];
      redFlags?: string[];
    };
    marketData: {
      address: string;
      listPrice: number;
      fv50: number;
      fv10: number;
      fv90: number;
      beds: number;
      baths: number;
      sqft: number;
      yearBuilt: number;
      propertyType: string;
      estimatedRent: number;
      propertyTax: number;
      assumableMortgage?: boolean;
    };
    model: string;
    imagesAnalyzed: number;
  };
  onClose: () => void;
}

export const HouseYieldResults: React.FC<HouseYieldResultsProps> = ({
  analysisData,
  onClose
}) => {
  const { analysis, analysisText, roomScores, marketData, assumability } = analysisData;

  // Parse the analysis - try to extract JSON from the text response
  let parsedAnalysis: any = {};
  try {
    if (typeof analysis === 'object' && analysis !== null) {
      parsedAnalysis = analysis;
    } else if (analysisText) {
      // Try to find JSON in the text
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedAnalysis = JSON.parse(jsonMatch[0]);
      }
    }
  } catch (e) {
    console.error('[HouseYieldResults] Failed to parse analysis:', e);
  }

  // Extract key metrics from the parsed analysis
  const fv50 = parsedAnalysis.FV50 || parsedAnalysis.fv50 || marketData.fv50;
  const fv10 = parsedAnalysis.FV10 || parsedAnalysis.fv10 || marketData.fv10;
  const fv90 = parsedAnalysis.FV90 || parsedAnalysis.fv90 || marketData.fv90;
  const valueGapPct = parsedAnalysis.value_gap_pct || parsedAnalysis.edge || 
                      ((fv50 - marketData.listPrice) / marketData.listPrice);
  const valueGapUsd = parsedAnalysis.value_gap_usd || (fv50 - marketData.listPrice);
  const decision = parsedAnalysis.decision || parsedAnalysis.overall_recommendation || '';
  const rentalViable = parsedAnalysis.rental?.rental_viable ?? parsedAnalysis.rental_viable;
  const dscr = parsedAnalysis.rental?.DSCR || parsedAnalysis.rental?.dscr;
  const monthlyFcf = parsedAnalysis.rental?.Monthly_FCF || parsedAnalysis.rental?.monthly_fcf;
  const rentEstimate = parsedAnalysis.rental?.rent_est || parsedAnalysis.rental?.rent_estimate || marketData.estimatedRent;
  const renovationOpportunities = parsedAnalysis.renovation_opportunities || parsedAnalysis.what_if || [];

  // Calculate edge (pricing vs fair value)
  const edge = valueGapPct * 100;
  const isUnderpriced = edge > 0;
  const isOverpriced = edge < -3;

  // Color code based on edge
  const getEdgeColor = () => {
    if (edge > 8) return 'text-green-600 bg-green-50';
    if (edge > 3) return 'text-emerald-600 bg-emerald-50';
    if (edge < -8) return 'text-red-600 bg-red-50';
    if (edge < -3) return 'text-orange-600 bg-orange-50';
    return 'text-blue-600 bg-blue-50';
  };

  // Get room condition badge color
  const getConditionColor = (score: number) => {
    if (score >= 0.80) return 'bg-green-100 text-green-800';
    if (score >= 0.60) return 'bg-yellow-100 text-yellow-800';
    return 'bg-red-100 text-red-800';
  };

  const getConditionLabel = (score: number) => {
    if (score >= 0.80) return 'Excellent';
    if (score >= 0.70) return 'Good';
    if (score >= 0.60) return 'Fair';
    if (score >= 0.40) return 'Dated';
    return 'Poor';
  };

  return (
    <div className="bg-white rounded-xl border shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-600 to-blue-600 text-white px-6 py-5">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className="text-2xl font-bold">Investment Analysis Complete</h2>
            </div>
            <p className="text-emerald-100">{marketData.address}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/20 rounded-lg transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Key Metrics Bar */}
      <div className="grid grid-cols-5 gap-4 px-6 py-4 bg-gray-50 border-b">
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            ${(marketData.listPrice / 1000).toFixed(0)}K
          </div>
          <div className="text-xs text-gray-600">List Price</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            ${(marketData.fv50 / 1000).toFixed(0)}K
          </div>
          <div className="text-xs text-gray-600">Fair Value</div>
        </div>
        <div className="text-center">
          <div className={`text-2xl font-bold ${edge > 0 ? 'text-green-600' : edge < -3 ? 'text-red-600' : 'text-gray-900'}`}>
            {edge > 0 ? '+' : ''}{edge.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-600">Edge</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            {marketData.beds}/{marketData.baths}
          </div>
          <div className="text-xs text-gray-600">Beds/Baths</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-900">
            {(marketData.sqft / 1000).toFixed(1)}K
          </div>
          <div className="text-xs text-gray-600">Sq Ft</div>
        </div>
      </div>

      {/* Content Sections */}
      <div className="p-6 space-y-6">
        {/* Pricing Verdict */}
        <div className={`rounded-lg p-5 ${getEdgeColor()} border`}>
          <div className="flex items-center gap-3 mb-2">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <h3 className="text-lg font-bold">
              {isUnderpriced && edge > 8 && '🎯 STRONG UNDERPRICED - High-Confidence Opportunity'}
              {isUnderpriced && edge <= 8 && '✅ UNDERPRICED - Potential Opportunity'}
              {!isUnderpriced && !isOverpriced && '⚖️ FAIRLY PRICED'}
              {isOverpriced && '⚠️ OVERPRICED'}
            </h3>
          </div>
          <p className="text-sm font-medium">
            Listed at ${marketData.listPrice.toLocaleString()} vs Fair Value of ${fv50.toLocaleString()}
            {isUnderpriced && ` - ${Math.abs(edge).toFixed(1)}% below market ($${Math.abs(valueGapUsd).toLocaleString()} value gap)`}
            {isOverpriced && ` - ${Math.abs(edge).toFixed(1)}% above market ($${Math.abs(valueGapUsd).toLocaleString()} overpriced)`}
          </p>
          <div className="text-xs mt-2 opacity-80">
            Fair Value Range: ${fv10.toLocaleString()} - ${fv90.toLocaleString()}
          </div>
          {decision && (
            <div className="mt-3 pt-3 border-t border-current/20">
              <div className="text-sm font-semibold">🎲 Investment Decision: {decision}</div>
            </div>
          )}
        </div>

        {/* Mortgage Assumability - CRITICAL FACTOR */}
        {assumability && assumability.assumable !== 'unknown' && (
          <div className={`rounded-lg border p-5 ${
            assumability.assumable === 'likely' && assumability.attractiveness === 'very_attractive' 
              ? 'bg-green-50 border-green-300' 
              : assumability.assumable === 'likely' 
              ? 'bg-blue-50 border-blue-200' 
              : 'bg-gray-50 border-gray-200'
          }`}>
            <h3 className="text-lg font-bold text-gray-900 mb-3 flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Mortgage Assumability
            </h3>
            <div className="mb-3">
              <div className="text-2xl font-bold mb-1">
                {assumability.assumable === 'likely' && '✅ LIKELY ASSUMABLE'}
                {assumability.assumable === 'possible' && '🟡 POSSIBLY ASSUMABLE'}
                {assumability.assumable === 'unlikely' && '❌ UNLIKELY ASSUMABLE'}
              </div>
              <p className="text-sm text-gray-700">{assumability.reason}</p>
            </div>
            
            {assumability.estimatedRate && (
              <div className="grid grid-cols-3 gap-4 mb-3 p-3 bg-white rounded border">
                <div>
                  <div className="text-xl font-bold text-blue-600">
                    {assumability.estimatedRate.toFixed(2)}%
                  </div>
                  <div className="text-xs text-gray-600">Loan Rate</div>
                </div>
                <div>
                  <div className="text-xl font-bold text-gray-600">
                    6.75%
                  </div>
                  <div className="text-xs text-gray-600">Current Market</div>
                </div>
                <div>
                  <div className={`text-xl font-bold ${
                    (6.75 - assumability.estimatedRate) >= 1.5 ? 'text-green-600' :
                    (6.75 - assumability.estimatedRate) >= 0.75 ? 'text-emerald-600' :
                    'text-gray-600'
                  }`}>
                    {(6.75 - assumability.estimatedRate).toFixed(2)}%
                  </div>
                  <div className="text-xs text-gray-600">Rate Advantage</div>
                </div>
              </div>
            )}

            {assumability.assumptions && assumability.assumptions.length > 0 && (
              <div className="mb-2">
                <div className="text-xs font-semibold text-gray-700 mb-1">Key Considerations:</div>
                <ul className="text-xs text-gray-600 space-y-1">
                  {assumability.assumptions.slice(0, 4).map((assumption, idx) => (
                    <li key={idx}>• {assumption}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {assumability.redFlags && assumability.redFlags.length > 0 && (
              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                <div className="text-xs font-semibold text-red-700 mb-1">⚠️ Red Flags:</div>
                <ul className="text-xs text-red-600 space-y-1">
                  {assumability.redFlags.map((flag, idx) => (
                    <li key={idx}>• {flag}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Rental Viability */}
        {(rentalViable !== undefined || rentEstimate > 0 || dscr) && (
          <div className={`rounded-lg border p-5 ${
            rentalViable === true ? 'bg-emerald-50 border-emerald-200' : 
            rentalViable === false ? 'bg-red-50 border-red-200' : 
            'bg-blue-50 border-blue-200'
          }`}>
            <h3 className="text-lg font-bold text-gray-900 mb-3 flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              Rental Viability Analysis
            </h3>
            <div className="mb-4">
              <div className="text-2xl font-bold mb-1">
                {rentalViable === true && '✅ VIABLE AS RENTAL'}
                {rentalViable === false && '❌ NOT VIABLE AS RENTAL'}
                {rentalViable === undefined && '📊 RENTAL POTENTIAL'}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {rentEstimate > 0 && (
                <div>
                  <div className="text-2xl font-bold text-emerald-700">
                    ${rentEstimate.toLocaleString()}/mo
                  </div>
                  <div className="text-sm text-gray-600">Est. Monthly Rent</div>
                </div>
              )}
              {dscr && (
                <div>
                  <div className={`text-2xl font-bold ${
                    dscr >= 1.25 ? 'text-green-600' : dscr >= 1.0 ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {dscr.toFixed(2)}
                  </div>
                  <div className="text-sm text-gray-600">DSCR</div>
                </div>
              )}
              {monthlyFcf !== undefined && (
                <div>
                  <div className={`text-2xl font-bold ${
                    monthlyFcf > 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    ${monthlyFcf > 0 ? '+' : ''}${monthlyFcf.toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-600">Monthly Cash Flow</div>
                </div>
              )}
              {rentEstimate > 0 && (
                <div>
                  <div className="text-2xl font-bold text-gray-900">
                    {((rentEstimate * 12 / marketData.listPrice) * 100).toFixed(2)}%
                  </div>
                  <div className="text-sm text-gray-600">Gross Yield</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Renovation Opportunities */}
        {renovationOpportunities && renovationOpportunities.length > 0 && (
          <div className="bg-purple-50 rounded-lg border border-purple-200 p-5">
            <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
              </svg>
              Renovation Opportunities & Wedge Deals
            </h3>
            <div className="space-y-4">
              {renovationOpportunities.map((reno: any, idx: number) => (
                <div key={idx} className="bg-white rounded-lg p-4 border border-purple-200">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-gray-900">
                        {reno.name || reno.type || `Renovation ${idx + 1}`}
                      </h4>
                      {reno.category && (
                        <span className="inline-block px-2 py-1 text-xs font-semibold bg-purple-100 text-purple-800 rounded mt-1">
                          {reno.category}
                        </span>
                      )}
                    </div>
                    {reno.cost && (
                      <div className="text-right">
                        <div className="text-lg font-bold text-gray-900">
                          ${typeof reno.cost === 'number' ? reno.cost.toLocaleString() : reno.cost}
                        </div>
                        <div className="text-xs text-gray-600">Cost</div>
                      </div>
                    )}
                  </div>
                  {reno.summary && (
                    <p className="text-sm text-gray-700 mb-2">{reno.summary}</p>
                  )}
                  {reno.details && (
                    <p className="text-xs text-gray-600 mb-2">{reno.details}</p>
                  )}
                  <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t">
                    {reno.ROI !== undefined && (
                      <div>
                        <div className="text-sm font-bold text-emerald-600">
                          {(reno.ROI * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-gray-600">ROI</div>
                      </div>
                    )}
                    {reno.uplift !== undefined && (
                      <div>
                        <div className="text-sm font-bold text-blue-600">
                          +${reno.uplift.toLocaleString()}
                        </div>
                        <div className="text-xs text-gray-600">Value Lift</div>
                      </div>
                    )}
                    {reno.rent_est_after !== undefined && (
                      <div>
                        <div className="text-sm font-bold text-purple-600">
                          +${(reno.rent_est_after - (rentEstimate || 0)).toLocaleString()}/mo
                        </div>
                        <div className="text-xs text-gray-600">Rent Impact</div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Room Condition Scores */}
        <div className="bg-white rounded-lg border p-5">
          <h3 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            Property Condition Assessment
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Object.entries({
              'Kitchen': roomScores.kitchen,
              'Bathrooms': roomScores.bath,
              'Flooring': roomScores.flooring,
              'Curb Appeal': roomScores.curb_appeal,
              'Overall': roomScores.overall
            }).map(([room, score]) => (
              <div key={room} className="text-center">
                <div className="text-3xl font-bold text-gray-900 mb-1">
                  {(score * 100).toFixed(0)}
                </div>
                <div className={`inline-block px-2 py-1 rounded-full text-xs font-semibold mb-2 ${getConditionColor(score)}`}>
                  {getConditionLabel(score)}
                </div>
                <div className="text-sm text-gray-600">{room}</div>
              </div>
            ))}
          </div>
          {roomScores.notes && (
            <div className="mt-4 pt-4 border-t text-sm text-gray-600 italic">
              {roomScores.notes}
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="flex items-center justify-between text-xs text-gray-500 pt-4 border-t">
          <div className="flex items-center gap-4">
            <span>Model: {analysisData.model}</span>
            <span>•</span>
            <span>{analysisData.imagesAnalyzed} images analyzed</span>
            <span>•</span>
            <span>Data: ATTOM API + Vision AI</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors text-sm font-medium"
          >
            Close Analysis
          </button>
        </div>
      </div>
    </div>
  );
};
