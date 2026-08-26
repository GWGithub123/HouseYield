export async function enhanceRenovationSuggestion({
  suggestion,
  propertyData,
  marketData,
  marketDataModule,
  rentcastData,
  macroData,
  canonicalPropertyProfile,
  canonicalEvidence,
  photoMeasurements,
  effectiveRent,
  effectivePropertyValue,
  rentcastMarketRent,
  rentcastMarketSale,
  regionalAreaSummary,
  buildCanonicalEnrichmentContext,
  buildCanonicalSuggestionArtifacts,
  getMeasurementsForSuggestion,
  findRegionalMatchForSuggestion,
  getRegionalRentMetrics,
  extractZipCode,
  improvedEstimator,
  zipCostEstimator,
  productSearch,
}) {
  const s = suggestion;
  const zipCode = extractZipCode(propertyData?.address || '');
  let suggestionMeasurements = null;
  let canonicalEnrichment = buildCanonicalEnrichmentContext(s, null, canonicalEvidence);

  try {
    suggestionMeasurements = getMeasurementsForSuggestion(s);
    if (suggestionMeasurements) {
      console.log(`[AI Renovation] ✓ Matched "${s.name}" to measured ${suggestionMeasurements.roomType} (${suggestionMeasurements.roomDimensions.floorAreaSqFt} sq ft)`);
    }

    const measurementTrustedForPricing = Boolean(
      suggestionMeasurements && ['high', 'medium'].includes(String(suggestionMeasurements.confidence || '').toLowerCase())
    );

    canonicalEnrichment = buildCanonicalEnrichmentContext(
      s,
      suggestionMeasurements,
      canonicalEvidence,
      { measurementTrustedForPricing }
    );

    const pricingMeasurements = measurementTrustedForPricing ? suggestionMeasurements : null;
    if (suggestionMeasurements && !measurementTrustedForPricing) {
      console.warn(`[AI Renovation] Low-confidence measurements for "${s.name}" kept for explainability but excluded from pricing.`);
    }

    console.log(`[AI Renovation] Getting IMPROVED costs for: ${canonicalEnrichment.projectName} [${canonicalEnrichment.primaryKey}] in ${zipCode || 'default'}`);

    const improvedCosts = await improvedEstimator.getComprehensiveCostEstimate({
      projectType: canonicalEnrichment.projectType,
      projectName: canonicalEnrichment.projectName,
      zipCode: zipCode || '20001',
      locationContext: marketData.ok
        ? (marketData.locationContext || {
            address: propertyData?.address || '',
            zipCode: zipCode || '',
            city: marketData.city || '',
            state: marketData.state || '',
            county: marketData.county || '',
            metro: marketData.metro || '',
          })
        : {
            address: propertyData?.address || '',
            zipCode: zipCode || '',
            city: '',
            state: '',
            county: '',
            metro: '',
          },
      scope: canonicalEnrichment.estimatorScope,
      qualityLevel: canonicalEnrichment.estimatorQualityLevel,
      validateWithWeb: true,
      measurements: pricingMeasurements
        ? {
            ...pricingMeasurements,
            canonicalContext: canonicalEnrichment.metricsContext,
          }
        : null,
    });

    if (improvedCosts.ok) {
      console.log(`[AI Renovation] ✓ IMPROVED estimate: $${improvedCosts.summary.totalCost} (${improvedCosts.summary.confidence.level} confidence)`);
    } else {
      console.log(`[AI Renovation] ⚠ IMPROVED estimate failed: ${improvedCosts.error}`);
    }

    let detailedCosts = null;
    if (!improvedCosts?.ok) {
      console.log(`[AI Renovation] Falling back to zip-cost-estimator for: ${canonicalEnrichment.projectName}`);

      if (zipCode && s.details && s.details.length > 50) {
        const specifications = {
          projectDescription: s.details,
          estimatedScope: canonicalEnrichment.projectName,
          aiEstimate: s.estimatedCost,
          materialQuality: canonicalEnrichment.metricsQualityLevel,
          canonicalContext: canonicalEnrichment.metricsContext,
        };

        detailedCosts = await zipCostEstimator.getDetailedCostEstimate({
          projectType: canonicalEnrichment.projectType || 'general renovation',
          zipCode,
          specifications,
        });
      }

      if (!detailedCosts?.ok) {
        const quickEstimate = await zipCostEstimator.getZipCodeCostEstimate(
          canonicalEnrichment.projectName,
          zipCode || '20001',
          {
            projectSize: 'medium',
            canonicalContext: canonicalEnrichment.metricsContext,
          }
        );

        if (quickEstimate.ok) {
          detailedCosts = {
            ok: true,
            summary: {
              grandTotal: quickEstimate.costRange.average,
              lowEstimate: quickEstimate.costRange.low,
              highEstimate: quickEstimate.costRange.high,
            },
            confidence: quickEstimate.confidence,
            materials: [],
            labor: [],
          };
        }
      }
    }

    const contractorCosts = await marketDataModule.searchContractorCosts(
      canonicalEnrichment.projectName,
      propertyData?.location || marketData.location || 'United States'
    );

    const primaryCostSummary = improvedCosts?.ok
      ? {
          totalCost: improvedCosts.summary.totalCost,
          costRange: improvedCosts.summary.costRange,
          confidence: improvedCosts.summary.confidence?.level || 'medium',
          source: improvedCosts.primaryEstimate?.method || 'IMPROVED_ESTIMATOR',
        }
      : detailedCosts?.ok
        ? {
            totalCost: detailedCosts.summary.grandTotal,
            costRange: {
              low: detailedCosts.summary.lowEstimate,
              high: detailedCosts.summary.highEstimate,
            },
            confidence: detailedCosts.confidence || 'medium',
            source: 'ZIP_COST_ESTIMATOR',
          }
        : null;

    const finalCost = primaryCostSummary?.totalCost
      || (contractorCosts.ok ? contractorCosts.costData?.avgEstimate : s.estimatedCost || 0);

    const costRange = primaryCostSummary?.costRange
      || {
          low: Math.round(finalCost * 0.85),
          high: Math.round(finalCost * 1.15),
        };

    const marketCostValidation = improvedCosts?.ok
      ? {
          ok: true,
          costData: {
            avgEstimate: improvedCosts.summary.totalCost,
            confidence: improvedCosts.summary.confidence?.level || 'medium',
            lowEstimate: improvedCosts.summary.costRange?.low || null,
            highEstimate: improvedCosts.summary.costRange?.high || null,
            source: improvedCosts.primaryEstimate?.method || 'IMPROVED_ESTIMATOR',
          },
          sources: contractorCosts.ok ? (contractorCosts.sources || []) : [],
        }
      : contractorCosts.ok
        ? contractorCosts
        : {
            costData: { avgEstimate: finalCost, confidence: primaryCostSummary?.confidence || 'medium' },
            sources: [],
          };

    const metrics = await marketDataModule.calculateRenovationMetrics(
      {
        type: canonicalEnrichment.projectType,
        estimatedCost: finalCost,
        details: s.details || '',
        materialQuality: canonicalEnrichment.metricsQualityLevel,
        qualityLevel: canonicalEnrichment.metricsQualityLevel,
        preRenovationCondition: canonicalEnrichment.preRenovationCondition,
        scope: canonicalEnrichment.metricsScope,
        marketFit: canonicalEnrichment.marketFit,
        canonicalContext: canonicalEnrichment.metricsContext,
      },
      marketData.ok ? marketData : {
        propertyValue: effectivePropertyValue,
        estimatedRent: effectiveRent,
        yearBuilt: propertyData?.yearBuilt || 2000,
        propertyType: 'single_family',
        marketAppreciationRate: 0.03,
        locationContext: {
          address: propertyData?.address || '',
          zipCode: zipCode || '',
          city: '',
          state: '',
          county: '',
          metro: '',
        },
        canonicalPropertyProfile,
      },
      marketCostValidation,
      {
        rentcastData,
        macroData,
        canonicalPropertyProfile,
        canonicalContext: canonicalEnrichment.metricsContext,
      }
    );

    const regionalMatch = findRegionalMatchForSuggestion({
      ...s,
      type: canonicalEnrichment.projectType,
      name: canonicalEnrichment.projectName,
    });
    const regionalRentMetrics = regionalMatch ? getRegionalRentMetrics(regionalMatch.renovationType) : null;

    const blendedValueIncrease = regionalMatch?.sampleSize >= 3
      ? Math.round(((regionalMatch.avgValueUplift || regionalMatch.medianValueUplift || 0) * 0.75) + ((metrics?.valueIncrease || 0) * 0.25))
      : (metrics?.valueIncrease || 0);
    const blendedRentIncrease = regionalMatch?.sampleSize >= 3
      ? Math.round(((regionalMatch.avgRentIncrease || regionalRentMetrics?.avgMonthlyRentIncrease || 0) * 0.70) + ((metrics?.rentIncreaseDollar || 0) * 0.30))
      : (metrics?.rentIncreaseDollar || 0);
    const finalTotalCost = improvedCosts?.ok ? improvedCosts.summary.totalCost : (metrics?.cost || Math.round(finalCost));
    const blendedRoi = finalTotalCost > 0
      ? (((blendedValueIncrease || 0) + ((blendedRentIncrease || 0) * 12 * 5)) / finalTotalCost) * 100
      : 0;
    const blendedPaybackMonths = blendedRentIncrease > 0
      ? Math.ceil(finalTotalCost / blendedRentIncrease)
      : (metrics?.paybackMonths || null);
    const finalConfidence = improvedCosts?.ok
      ? improvedCosts.summary.confidence?.level
      : (detailedCosts?.confidence || metrics?.confidence || 'medium');
    const finalTimeframe = improvedCosts?.ok
      ? (improvedCosts.primaryEstimate?.timeline || 'TBD')
      : (detailedCosts?.timeline || s.timeframe || 'TBD');

    const canonicalArtifacts = buildCanonicalSuggestionArtifacts({
      canonicalEnrichment,
      totalCost: finalTotalCost,
      costRange: improvedCosts?.ok ? improvedCosts.summary.costRange : costRange,
      valueIncrease: blendedValueIncrease,
      afterRepairValue: Math.round(effectivePropertyValue + blendedValueIncrease),
      rentIncreaseDollar: blendedRentIncrease,
      rentIncreasePercent: effectiveRent > 0 ? Number(((blendedRentIncrease / effectiveRent) * 100).toFixed(1)) : (metrics?.rentIncreasePercent || 0),
      currentRent: metrics?.currentRent || effectiveRent,
      maxPostRenovationRent: metrics?.maxPostRenovationRent || effectiveRent,
      marketRentBenchmark: metrics?.marketRentBenchmark || rentcastMarketRent || effectiveRent,
      marketSaleBenchmark: metrics?.marketSaleBenchmark || rentcastMarketSale || effectivePropertyValue,
      roi: Number(blendedRoi.toFixed(1)),
      paybackMonths: blendedPaybackMonths,
      confidence: finalConfidence,
      timeframe: finalTimeframe,
    });

    let shoppableProducts = null;
    try {
      const productProjectMap = {
        bathroom: 'bathroom_full_remodel',
        bathroom_update: 'bathroom_refresh',
        bathroom_vanity: 'bathroom_vanity_replace',
        vanity: 'bathroom_vanity_replace',
        toilet: 'bathroom_toilet_replace',
        mirror: 'bathroom_mirror_replace',
        faucet: 'bathroom_faucet_replace',
        sink: 'bathroom_vanity_replace',
        shower: 'bathroom_shower_update',
        bathtub: 'bathroom_tub_replace',
        bathroom_exhaust: 'bathroom_exhaust_update',
        kitchen: 'kitchen_full_remodel',
        kitchen_update: 'kitchen_full_remodel',
        countertop: 'kitchen_countertop_replace',
        cabinet: 'kitchen_cabinet_replace',
        kitchen_faucet: 'kitchen_faucet_replace',
        kitchen_sink: 'kitchen_sink_replace',
        flooring: 'flooring_lvp',
        hardwood: 'flooring_hardwood',
        tile: 'flooring_tile',
        hvac: 'hvac_update',
        windows: 'window_replace',
        lighting: 'lighting_update',
      };

      const searchType = String(canonicalEnrichment.projectType || s.type || '').toLowerCase();
      const roomType = suggestionMeasurements?.roomType || '';
      let projectType = null;

      if (searchType === 'faucet' && roomType.includes('kitchen')) {
        projectType = 'kitchen_faucet_replace';
      } else if (searchType === 'sink' && roomType.includes('kitchen')) {
        projectType = 'kitchen_sink_replace';
      } else if (searchType === 'countertop' && roomType.includes('bathroom')) {
        projectType = 'bathroom_countertop_replace';
      } else if (searchType === 'lighting' && roomType.includes('bathroom')) {
        projectType = 'bathroom_lighting_update';
      } else {
        projectType = productProjectMap[searchType]
          || Object.keys(productProjectMap).find((key) => s.name?.toLowerCase().includes(key));
      }

      if (projectType) {
        console.log(`[AI Renovation] Getting shoppable products for: ${projectType}`);
        const productRecs = await productSearch.getProductRecommendations({
          projectType,
          qualityLevel: 'midRange',
          zipCode,
          room: suggestionMeasurements?.roomType || null,
          measurements: suggestionMeasurements,
          materialBreakdown: improvedCosts?.ok
            ? (improvedCosts.primaryEstimate?.materials || [])
            : (detailedCosts?.materials || []),
          suggestionName: s.name,
          projectName: canonicalEnrichment.projectName,
        });

        if (productRecs.ok) {
          shoppableProducts = {
            totalMaterialEstimate: productRecs.totalMaterialEstimate,
            recommendations: productRecs.recommendations,
            localStoreLinks: productRecs.localStoreLinks,
            note: productRecs.scopeNote || 'Live pricing from Home Depot, Lowe\'s, Amazon, Wayfair',
          };
          console.log(`[AI Renovation] ✓ Found ${Object.keys(productRecs.recommendations).length} product categories`);
        }
      }
    } catch (productError) {
      console.warn('[AI Renovation] Product search failed (non-critical):', productError.message);
    }

    const materialCostTotal = improvedCosts?.ok
      ? Number(improvedCosts.summary.materialCost || 0)
      : (detailedCosts?.materials || []).reduce((sum, material) => sum + Number(material?.totalCost || 0), 0);
    const laborCostTotal = improvedCosts?.ok
      ? Number(improvedCosts.summary.laborCost || 0)
      : (detailedCosts?.labor || []).reduce((sum, labor) => sum + Number(labor?.totalCost || 0), 0);
    const costComposition = {
      pricingSource: primaryCostSummary?.source || (contractorCosts.ok ? 'CONTRACTOR_SEARCH' : 'AI_ESTIMATE'),
      pricingMethod: improvedCosts?.primaryEstimate?.method || primaryCostSummary?.source || 'FALLBACK',
      pricingConfidence: primaryCostSummary?.confidence || metrics?.confidence || 'medium',
      breakdownSource: improvedCosts?.primaryEstimate?.breakdownSource || (detailedCosts?.ok ? 'zip_cost_estimator' : 'fallback'),
      measurementDriven: improvedCosts?.primaryEstimate?.breakdownSource === 'photo_measured',
      materialCost: Math.round(materialCostTotal),
      laborCost: Math.round(laborCostTotal),
      materialShare: finalTotalCost > 0 ? Math.round((materialCostTotal / finalTotalCost) * 100) : null,
      laborShare: finalTotalCost > 0 ? Math.round((laborCostTotal / finalTotalCost) * 100) : null,
    };

    return {
      id: canonicalArtifacts.suggestionId,
      name: s.name || 'Unnamed Renovation',
      type: s.type || 'general',
      summary: s.summary || '',
      details: s.details || '',
      canonicalContext: canonicalEnrichment.metricsContext,
      canonicalResult: canonicalArtifacts.canonicalResult,
      cost: finalTotalCost,
      costRange: improvedCosts?.ok ? improvedCosts.summary.costRange : costRange,
      costComposition,
      materialBreakdown: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.materials || null) : (detailedCosts?.ok ? detailedCosts.materials : null),
      laborBreakdown: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.labor || null) : (detailedCosts?.ok ? detailedCosts.labor : null),
      shoppableProducts,
      measurements: suggestionMeasurements
        ? {
            roomDimensions: suggestionMeasurements.roomDimensions,
            roomType: suggestionMeasurements.roomType,
            materialQuantities: suggestionMeasurements.materialQuantities,
            uncertainty: suggestionMeasurements.uncertainty || null,
            captureProtocol: suggestionMeasurements.captureProtocol || null,
            objectMeasurements: suggestionMeasurements.objectMeasurements?.map((o) => ({
              type: o.type,
              description: o.description,
              dimensions: o.dimensions,
              applianceFit: o.applianceFit,
              confidence: o.confidence,
              sanityClamped: o.sanityClamped || false,
            })),
            sourcePhotoIndexes: suggestionMeasurements.sourcePhotoIndexes || [],
            confidence: suggestionMeasurements.confidence,
            trustedForPricing: canonicalEnrichment.metricsContext.measurementTrustedForPricing,
            note: canonicalEnrichment.metricsContext.measurementTrustedForPricing
              ? undefined
              : 'Low-confidence measurements were retained for explainability only and did not drive pricing directly.',
            measured: true,
          }
        : {
            measured: false,
            note: 'No matching room measurements — costs estimated from project type',
          },
      valueIncrease: blendedValueIncrease,
      afterRepairValue: Math.round(effectivePropertyValue + blendedValueIncrease),
      rentIncreaseDollar: blendedRentIncrease,
      rentIncreasePercent: effectiveRent > 0 ? Number(((blendedRentIncrease / effectiveRent) * 100).toFixed(1)) : (metrics?.rentIncreasePercent || 0),
      marketRentBenchmark: metrics?.marketRentBenchmark || rentcastMarketRent || effectiveRent,
      marketSaleBenchmark: metrics?.marketSaleBenchmark || rentcastMarketSale || effectivePropertyValue,
      roi: Number(blendedRoi.toFixed(1)),
      paybackMonths: blendedPaybackMonths,
      currentRent: metrics?.currentRent || effectiveRent,
      maxPostRenovationRent: metrics?.maxPostRenovationRent || effectiveRent,
      priority: s.priority || 'medium',
      timeframe: finalTimeframe,
      confidence: finalConfidence,
      valuationModel: metrics?.valueModel || null,
      rentModel: metrics?.rentModel || null,
      rentcastModel: metrics?.rentcastModel || null,
      macroModel: metrics?.macroModel || null,
      regionalModel: regionalMatch
        ? {
            renovationType: regionalMatch.renovationType,
            avgValueUplift: regionalMatch.avgValueUplift || null,
            avgRentIncrease: regionalMatch.avgRentIncrease || regionalRentMetrics?.avgMonthlyRentIncrease || null,
            sampleSize: regionalMatch.sampleSize || 0,
            confidenceLevel: regionalMatch.confidenceLevel || 'medium',
            source: regionalAreaSummary?.zipCode ? 'regional_uplift_analysis' : 'unavailable',
          }
        : null,
      dataSource: {
        detailedBreakdown: improvedCosts?.ok || detailedCosts?.ok || false,
        breakdownSource: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.breakdownSource || 'database') : 'fallback',
        materialItems: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.materials?.length || 0) : (detailedCosts?.materials?.length || 0),
        laborItems: improvedCosts?.ok ? (improvedCosts.primaryEstimate?.labor?.length || 0) : (detailedCosts?.labor?.length || 0),
        contractorCosts: contractorCosts.ok ? contractorCosts.sources?.length || 0 : 0,
        liveProductPricing: !!shoppableProducts,
        photoMeasurements: !!suggestionMeasurements,
        measurementConfidence: suggestionMeasurements?.confidence || null,
        measurementTrustedForPricing: canonicalEnrichment.metricsContext.measurementTrustedForPricing,
        measurementUncertainty: suggestionMeasurements?.uncertainty?.percent || null,
        requiresHumanVerification: canonicalEnrichment.metricsContext.requiresHumanVerification,
        uncertaintyReasons: canonicalEnrichment.metricsContext.uncertaintyReasons,
        regionalCostFactors: improvedCosts?.summary?.regionalPricing || improvedCosts?.regionalPricing || null,
        regionalUplift: !!regionalMatch,
        regionalComparableCount: regionalMatch?.sampleSize || 0,
        rentcast: !!rentcastData,
        macro: !!macroData,
        marketData: marketData.ok ? 'ATTOM' : 'user-provided',
        pricingSource: costComposition.pricingSource,
        pricingMethod: costComposition.pricingMethod,
        pricingConfidence: costComposition.pricingConfidence,
        measurementDrivenPricing: costComposition.measurementDriven,
        productSearchScope: shoppableProducts?.note || null,
        canonicalPropertyProfileAvailable: !!canonicalPropertyProfile,
        aiAnalysis: 'GPT-4o',
        depthModel: photoMeasurements?.depthModel || 'depth_anything_v3_metric + gpt_4o_vision',
        zipCode: zipCode || 'unknown',
        suggestionSource: canonicalEnrichment.source,
        primaryKey: canonicalEnrichment.primaryKey,
        canonicalOpportunityId: canonicalEnrichment.metricsContext.canonicalOpportunityId,
        canonicalRoomType: canonicalEnrichment.metricsContext.canonicalRoomType,
        canonicalCategory: canonicalEnrichment.metricsContext.canonicalCategory,
        canonicalScopeType: canonicalEnrichment.metricsContext.canonicalScopeType,
        canonicalTriggerFindingCount: canonicalEnrichment.metricsContext.triggerFindingCount,
        canonicalMeasured: canonicalEnrichment.metricsContext.measurementMatched,
      },
    };
  } catch (error) {
    console.error('[AI Renovation] Error enhancing suggestion:', s.name, error);

    const fallbackCostRange = {
      low: Math.round((s.estimatedCost || 0) * 0.85),
      high: Math.round((s.estimatedCost || 0) * 1.15),
    };
    const canonicalArtifacts = buildCanonicalSuggestionArtifacts({
      canonicalEnrichment,
      totalCost: Math.round(s.estimatedCost || 0),
      costRange: fallbackCostRange,
      valueIncrease: 0,
      afterRepairValue: null,
      rentIncreaseDollar: 0,
      rentIncreasePercent: 0,
      currentRent: effectiveRent || 0,
      maxPostRenovationRent: effectiveRent || 0,
      marketRentBenchmark: effectiveRent || 0,
      marketSaleBenchmark: effectivePropertyValue || 0,
      roi: 0,
      paybackMonths: null,
      confidence: 'low',
      timeframe: s.timeframe || 'TBD',
    });

    return {
      id: canonicalArtifacts.suggestionId,
      name: s.name || 'Unnamed Renovation',
      type: s.type || 'general',
      summary: s.summary || '',
      details: s.details || '',
      canonicalContext: canonicalEnrichment.metricsContext,
      canonicalResult: canonicalArtifacts.canonicalResult,
      cost: Math.round(s.estimatedCost || 0),
      costRange: fallbackCostRange,
      measurements: suggestionMeasurements
        ? {
            roomDimensions: suggestionMeasurements.roomDimensions,
            roomType: suggestionMeasurements.roomType,
            materialQuantities: suggestionMeasurements.materialQuantities,
            uncertainty: suggestionMeasurements.uncertainty || null,
            captureProtocol: suggestionMeasurements.captureProtocol || null,
            objectMeasurements: suggestionMeasurements.objectMeasurements?.map((o) => ({
              type: o.type,
              description: o.description,
              dimensions: o.dimensions,
              applianceFit: o.applianceFit,
              confidence: o.confidence,
              sanityClamped: o.sanityClamped || false,
            })),
            sourcePhotoIndexes: suggestionMeasurements.sourcePhotoIndexes || [],
            confidence: suggestionMeasurements.confidence,
            trustedForPricing: canonicalEnrichment.metricsContext.measurementTrustedForPricing,
            note: canonicalEnrichment.metricsContext.measurementTrustedForPricing
              ? undefined
              : 'Low-confidence measurements were retained for explainability only and did not drive pricing directly.',
            measured: true,
          }
        : {
            measured: false,
            note: 'No matching room measurements — fallback estimates use canonical or AI suggestion scaffolding only.',
          },
      valueIncrease: 0,
      rentIncreaseDollar: 0,
      rentIncreasePercent: 0,
      roi: 0,
      currentRent: effectiveRent || 0,
      maxPostRenovationRent: effectiveRent || 0,
      priority: s.priority || 'medium',
      timeframe: s.timeframe || 'TBD',
      confidence: 'low',
      rentModel: null,
      dataSource: {
        contractorCosts: 0,
        marketData: 'unavailable',
        canonicalPropertyProfileAvailable: !!canonicalPropertyProfile,
        aiAnalysis: 'GPT-4o',
        zipCode: zipCode || 'unknown',
        measurementTrustedForPricing: canonicalEnrichment.metricsContext.measurementTrustedForPricing,
        requiresHumanVerification: canonicalEnrichment.metricsContext.requiresHumanVerification,
        uncertaintyReasons: canonicalEnrichment.metricsContext.uncertaintyReasons,
        suggestionSource: canonicalEnrichment.source,
        primaryKey: canonicalEnrichment.primaryKey,
        canonicalOpportunityId: canonicalEnrichment.metricsContext.canonicalOpportunityId,
        canonicalRoomType: canonicalEnrichment.metricsContext.canonicalRoomType,
        canonicalCategory: canonicalEnrichment.metricsContext.canonicalCategory,
        canonicalScopeType: canonicalEnrichment.metricsContext.canonicalScopeType,
        canonicalTriggerFindingCount: canonicalEnrichment.metricsContext.triggerFindingCount,
        canonicalMeasured: canonicalEnrichment.metricsContext.measurementMatched,
      },
    };
  }
}